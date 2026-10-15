import * as THREE from "three";
import { Camera as SigmaCamera } from "sigma";
import { DEFAULT_SETTINGS } from "sigma/settings";
import { createNormalizationFunction, matrixFromCamera, multiplyVec2 } from "sigma/utils";
import type { CameraKind } from "#engine/camera-kind.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { VisualStateCamera } from "#engine/visual-state.ts";
import { SCENE_PERMILLE_SCALE, SCENE_PERMILLE_QUANTUM } from "#scene/contract.ts";
import type { SceneCameraRequest } from "#scene/contract.ts";
import {
  canonicalCameraFramingSubjects,
  quantizeCameraFramingUpperBound,
  quantizeCameraFramingValue,
  requiredPerspectiveFramingTangent,
} from "#render3f/camera-framing.ts";
import type {
  CameraFramingSubject,
  ProjectedCameraFramingSubject,
} from "#render3f/camera-framing.ts";

/** This is one explicit renderer framing box and does not change world anchors. */
export type Render3fFramingBox = {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
};

/** This reports projection factors consumed by material shaders and does not retain a material. */
export type CameraProjectionState = {
  readonly resolutionDevicePx: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly orthographicSizeScale: number;
  readonly filamentSizeScale: number;
  readonly perspective: boolean;
  readonly referenceViewDepth: number;
  readonly nodeReferenceViewDepth: number;
  readonly nodeScaleCap: number;
};

// The D-079 closest dolly (80 permille) is the last distance at which node sizing
// follows the original target-depth rule. Closer wheel views follow their world anchor.
const NODE_REFERENCE_FLOOR_RATIO = 0.08;
const CLOSE_NODE_SCALE_CAP = 6;

export type ReviewCameraState = VisualStateCamera & {
  readonly orbit?: readonly [number, number, number, number];
  readonly targetZ?: number;
  readonly closeSizeAnchor?: Coordinates;
  readonly closeSizeStartRatio?: number;
  readonly closeSizeStartScale?: number;
  /**
   * The framing half-angle tangent this view was deliberately framed at (first mount, a kind
   * switch's fresh construction, a fit or reset remount). It travels with saved camera states so
   * a restore — undo, redo, a disclosure remount — reproduces the same field of view instead of
   * re-deriving one from whatever the scene happens to contain now.
   */
  readonly framingTangent?: number;
  /** World Z of the camera rig that emitted this state; subset subjects cannot redefine it. */
  readonly framingCenterZ?: number;
};

type FramingBounds3d = Readonly<{
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
}>;

function framingBounds3d(subjects: readonly CameraFramingSubject[]): FramingBounds3d | null {
  if (subjects.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { position } of subjects) {
    minX = Math.min(minX, position.x); maxX = Math.max(maxX, position.x);
    minY = Math.min(minY, position.y); maxY = Math.max(maxY, position.y);
    minZ = Math.min(minZ, position.z); maxZ = Math.max(maxZ, position.z);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Compose screen-space trackball motion in world space, including travel over either pole. */
export function arcballDrag(orientation: THREE.Quaternion, deltaX: number, deltaY: number, height: number): THREE.Quaternion {
  const right = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const up = new THREE.Vector3(-1, 0, 1).normalize().applyQuaternion(orientation);
  const yaw = new THREE.Quaternion().setFromAxisAngle(up, -deltaX * Math.PI / height);
  const pitch = new THREE.Quaternion().setFromAxisAngle(right, -deltaY * Math.PI / height);
  return pitch.multiply(yaw).multiply(orientation).normalize();
}

export type ViewPreset = "fronte" | "retro" | "sinistra" | "destra" | "alto" | "basso" | "iso";
export const VIEW_DIRECTIONS: Readonly<Record<ViewPreset, readonly [number, number, number]>> = {
  fronte: [0, 0, 1], retro: [0, 0, -1], sinistra: [-1, 0, 0],
  destra: [1, 0, 0], alto: [0, 1, 0], basso: [0, -1, 0], iso: [1, 1, 1],
};
export const VIEW_UP: Readonly<Record<ViewPreset, readonly [number, number, number]>> = {
  fronte: [0, 1, 0], retro: [0, 1, 0], sinistra: [0, 1, 0],
  destra: [0, 1, 0], alto: [0, 0, -1], basso: [0, 0, 1],
  iso: [0, Math.SQRT1_2, -Math.SQRT1_2],
};

export function presetOrientation(name: ViewPreset): THREE.Quaternion {
  const direction = new THREE.Vector3(...VIEW_DIRECTIONS[name]).normalize();
  const up = new THREE.Vector3(...VIEW_UP[name]);
  const matrix = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up);
  const desired = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const initial = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(1, 0, 1), new THREE.Vector3(), new THREE.Vector3(0, 0, 1)),
  );
  return desired.multiply(initial.invert()).normalize();
}

function openingDirection(): THREE.Vector3 {
  const yaw = Math.PI / 6, elevation = Math.PI / 9;
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
}

/** Review opening: yaw 30° and elevation 20° around the volume's centre. */
export function defaultObliqueOrbit(): readonly [number, number, number, number] {
  const direction = openingDirection();
  const desired = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
  const initial = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(1, 0, 1), new THREE.Vector3(), new THREE.Vector3(0, 0, 1)));
  const orbit = desired.multiply(initial.invert()).normalize();
  return [orbit.x, orbit.y, orbit.z, orbit.w];
}

export function wheelZoomFactor(deltaYCssPx: number, heightCssPx: number, sensitivityPermille: number): number {
  return Math.exp((deltaYCssPx / heightCssPx) * sensitivityPermille / SCENE_PERMILLE_SCALE);
}

export function perspectivePanVector(orientation: THREE.Quaternion, deltaX: number, deltaY: number,
  width: number, height: number, distance: number, sensitivity: number): THREE.Vector3 {
  const right = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const up = new THREE.Vector3(-1, 0, 1).normalize().applyQuaternion(orientation);
  return right.multiplyScalar(-deltaX / width).addScaledVector(up, deltaY / height).multiplyScalar(distance * sensitivity);
}

/** This owns both cameras over one world coordinate system and does not retain graph semantics. */
export class CameraRig {
  private readonly orthographic = new THREE.OrthographicCamera();
  private readonly perspective = new THREE.PerspectiveCamera();
  private readonly wheelProjection = new THREE.Vector3();
  private kindValue: CameraKind;
  private stateValue: ReviewCameraState;
  private requestValue: SceneCameraRequest;
  private widthCssPx: number;
  private heightCssPx: number;
  private devicePixelRatio: number;
  private worldCenterZ: number;
  private worldFramingSubjects: readonly CameraFramingSubject[];
  private worldFramingBounds: FramingBounds3d | null;
  private framingTangentValue: number;
  private closeNodeReferenceDepthValue: number | undefined;

  /** This creates both projections over copied state and does not modify a world object. */
  constructor(
    kind: CameraKind,
    request: SceneCameraRequest,
    widthCssPx: number,
    heightCssPx: number,
    devicePixelRatio: number,
    worldFramingSubjects: readonly CameraFramingSubject[],
  ) {
    this.kindValue = kind;
    this.stateValue = copyCameraState(request);
    this.requestValue = request;
    this.widthCssPx = requiredDimension(widthCssPx, "camera viewport width");
    this.heightCssPx = requiredDimension(heightCssPx, "camera viewport height");
    this.devicePixelRatio = requiredDimension(devicePixelRatio, "camera device pixel ratio");
    this.worldFramingSubjects = canonicalCameraFramingSubjects(worldFramingSubjects);
    this.worldFramingBounds = framingBounds3d(this.worldFramingSubjects);
    this.worldCenterZ = this.stateValue.framingCenterZ ?? quantizeCameraFramingValue(resolvedWorldCenterZ(
      this.worldFramingSubjects.map((subject) => subject.position),
    ));
    this.stateValue = { ...this.stateValue, framingCenterZ: this.worldCenterZ };
    // D085-S5 BEGIN: sparse Indra disclosures can have a deep volume but narrow XY
    // bounds. Keep every node in front of the opening camera with room for its
    // perspective-scaled device extent; ordinary XY-dominant scenes retain ratio.
    if (kind !== ORTHOGRAPHIC && !validFramingTangent(this.stateValue.framingTangent)) {
      this.stateValue = { ...this.stateValue, ratio: perspectiveOpeningRatio(
        this.stateValue, this.worldCenterZ, this.worldFramingSubjects,
        this.widthCssPx, this.heightCssPx,
      ) };
    }
    // D085-S5 END
    this.framingTangentValue = this.deriveFramingTangent();
    this.updateCameras();
  }

  /** This reports the active Three camera and does not change projection kind. */
  get camera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return this.kindValue === ORTHOGRAPHIC ? this.orthographic : this.perspective;
  }

  /** This reports the active camera kind and does not switch it. */
  get kind(): CameraKind {
    return this.kindValue;
  }

  /** This copies the serialisable camera record, including the live framing tangent, and does
   * not expose mutable camera state. */
  readCameraState(): ReviewCameraState {
    return { ...copyCameraState(this.stateValue), framingTangent: this.framingTangentValue,
      framingCenterZ: this.worldCenterZ };
  }

  /** This restores serialisable camera state and does not move a world anchor. */
  restoreCameraState(state: VisualStateCamera): void {
    const next = copyCameraState(state);
    // A state that carries a framing tangent (every state this rig emitted) reproduces its own
    // field of view; a tangent-less state (a fresh mount, a legacy record) is a deliberate
    // reframe and derives the tangent from the restored bounds and the current subjects.
    this.framingTangentValue = validFramingTangent(next.framingTangent)
      ? next.framingTangent
      : this.deriveFramingTangent(next);
    this.stateValue = next;
    if (Number.isFinite(next.framingCenterZ)) this.worldCenterZ = next.framingCenterZ!;
    this.updateCameras();
  }

  readPose() {
    return { position: this.perspective.position.toArray(), target: perspectiveTarget(this.stateValue, this.worldCenterZ).toArray(),
      up: this.perspective.up.toArray(), fov: this.perspective.fov };
  }

  viewPreset(name: ViewPreset): void {
    const q = presetOrientation(name);
    this.stateValue = { ...this.stateValue, orbit: [q.x, q.y, q.z, q.w] };
    this.updateCameras();
  }

  /** This switches the active projection request and does not rebuild scene geometry. */
  setCameraKind(kind: CameraKind, request: SceneCameraRequest): void {
    this.kindValue = kind;
    this.requestValue = request;
    this.updateCameras();
  }

  /** This updates viewport projection dimensions and does not change camera state. */
  resize(widthCssPx: number, heightCssPx: number, devicePixelRatio: number): void {
    this.widthCssPx = requiredDimension(widthCssPx, "camera viewport width");
    this.heightCssPx = requiredDimension(heightCssPx, "camera viewport height");
    this.devicePixelRatio = requiredDimension(devicePixelRatio, "camera device pixel ratio");
    this.updateCameras();
  }

  /** This updates resolved framing geometry and does not infer it from semantics. */
  setWorldFramingSubjects(subjects: readonly CameraFramingSubject[]): void {
    this.worldFramingSubjects = canonicalCameraFramingSubjects(subjects);
    this.worldFramingBounds = framingBounds3d(this.worldFramingSubjects);
    this.worldCenterZ = this.stateValue.framingCenterZ ?? quantizeCameraFramingValue(resolvedWorldCenterZ(
      this.worldFramingSubjects.map((subject) => subject.position),
    ));
    // New subjects alone (a disclosure, a selection) must not move the field of view: the
    // framing tangent is rig state, recomputed only where the framing is deliberate.
    this.updateCameras();
  }

  /** This projects one world coordinate through the active live camera and does not alter it. */
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
    if (this.kindValue === ORTHOGRAPHIC) {
      const clip = orthographicClipPoint(orbitOrthographicPoint(point, this.stateValue, this.worldCenterZ),
        this.stateValue, this.widthCssPx, this.heightCssPx);
      return {
        x: (clip.x + scalarCount()) * this.widthCssPx / bisectionDivisor(),
        y: (scalarCount() - clip.y) * this.heightCssPx / bisectionDivisor(),
      };
    }
    const projected = new THREE.Vector3(point.x, point.y, point.z).project(this.perspective);
    return {
      x: (projected.x + scalarCount()) * this.widthCssPx / bisectionDivisor(),
      y: (scalarCount() - projected.y) * this.heightCssPx / bisectionDivisor(),
    };
  }

  /** Project through the live draw camera into caller-owned wheel-picking scratch. */
  projectToViewportInto(point: Coordinates, out: { x: number; y: number }): boolean {
    const clip = this.wheelProjection.set(point.x, point.y, point.z).project(this.camera);
    out.x = (clip.x + scalarCount()) * this.widthCssPx / bisectionDivisor();
    out.y = (scalarCount() - clip.y) * this.heightCssPx / bisectionDivisor();
    return this.kindValue === ORTHOGRAPHIC || (clip.z >= -scalarCount() && clip.z <= scalarCount());
  }

  /** This reports shader projection factors from the live cameras and does not update a material. */
  readProjectionState(): CameraProjectionState {
    const orthographicSizeScale = scalarCount() / DEFAULT_SETTINGS.zoomToSizeRatioFunction(this.stateValue.ratio);
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ);
    const targetView = target.clone().applyMatrix4(this.perspective.matrixWorldInverse);
    const targetDepth = Math.max(-targetView.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    const closeNodes = this.kindValue !== ORTHOGRAPHIC && this.stateValue.ratio < NODE_REFERENCE_FLOOR_RATIO;
    return {
      resolutionDevicePx: [
        this.widthCssPx * this.devicePixelRatio,
        this.heightCssPx * this.devicePixelRatio,
      ],
      devicePixelRatio: this.devicePixelRatio,
      orthographicSizeScale,
      filamentSizeScale: this.kindValue === ORTHOGRAPHIC ? orthographicSizeScale : scalarCount(),
      perspective: this.kindValue !== ORTHOGRAPHIC,
      referenceViewDepth: targetDepth,
      nodeReferenceViewDepth: closeNodes ? this.nodeReferenceDepth(targetDepth) : targetDepth,
      nodeScaleCap: closeNodes ? CLOSE_NODE_SCALE_CAP : SCENE_PERMILLE_SCALE,
    };
  }

  /** This reports the live screen-size scale at one world point and does not change camera projection. */
  sizeScaleAt(point: Coordinates): number {
    if (this.kindValue === ORTHOGRAPHIC) {
      return scalarCount() / DEFAULT_SETTINGS.zoomToSizeRatioFunction(this.stateValue.ratio);
    }
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ).applyMatrix4(this.perspective.matrixWorldInverse);
    const pointView = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(this.perspective.matrixWorldInverse);
    const targetDepth = Math.max(-target.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    // The shader divides by max(view depth, reference depth / 1000). Use that
    // same bound for CPU footprints and picking, including centres behind the eye.
    const pointDepth = Math.max(-pointView.z, targetDepth / SCENE_PERMILLE_SCALE);
    if (this.stateValue.ratio >= NODE_REFERENCE_FLOOR_RATIO) return targetDepth / pointDepth;
    const reference = this.nodeReferenceDepth(targetDepth);
    return Math.min(CLOSE_NODE_SCALE_CAP, reference / Math.max(-pointView.z,
      reference / SCENE_PERMILLE_SCALE));
  }

  /** Drawn node scale for wheel picking, without constructing a camera target or view point. */
  wheelNodeSizeScaleAt(point: Coordinates): number {
    if (this.kindValue === ORTHOGRAPHIC) {
      return scalarCount() / DEFAULT_SETTINGS.zoomToSizeRatioFunction(this.stateValue.ratio);
    }
    const view = this.perspective.matrixWorldInverse.elements;
    const target = this.perspective.position;
    const depth = -(view[2] * (point.x - target.x)
      + view[6] * (point.y - target.y) + view[10] * (point.z - target.z));
    const span = Math.max(this.stateValue.bounds.x[1] - this.stateValue.bounds.x[0],
      this.stateValue.bounds.y[1] - this.stateValue.bounds.y[0]);
    const reference = span * this.stateValue.ratio * Math.SQRT2;
    const targetDepth = Math.max(reference, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    const pointDepth = Math.max(depth, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    if (this.stateValue.ratio >= NODE_REFERENCE_FLOOR_RATIO) return targetDepth / pointDepth;
    const nodeReference = this.nodeReferenceDepth(targetDepth, span);
    return Math.min(CLOSE_NODE_SCALE_CAP, nodeReference / Math.max(depth,
      nodeReference / SCENE_PERMILLE_SCALE));
  }

  private nodeReferenceDepth(targetDepth: number, span = Math.max(
    this.stateValue.bounds.x[1] - this.stateValue.bounds.x[0],
    this.stateValue.bounds.y[1] - this.stateValue.bounds.y[0],
  )): number {
    if (this.closeNodeReferenceDepthValue !== undefined) return this.closeNodeReferenceDepthValue;
    return Math.max(targetDepth, span * NODE_REFERENCE_FLOOR_RATIO * Math.SQRT2);
  }

  private perspectiveViewDepth(point: Coordinates): number {
    const view = this.perspective.matrixWorldInverse.elements;
    const position = this.perspective.position;
    return -(view[2] * (point.x - position.x) + view[6] * (point.y - position.y)
      + view[10] * (point.z - position.z));
  }

  /** This projects resolved framing subjects with their live screen-space drawn extents. */
  projectFramingSubjects(
    subjects: readonly CameraFramingSubject[] = this.worldFramingSubjects,
  ): readonly ProjectedCameraFramingSubject[] {
    return canonicalCameraFramingSubjects(subjects).map((subject) => ({
      id: subject.id,
      viewportCenter: this.graphToViewport(subject.position),
      extentCssPx: subject.extentCssPx * this.framingExtentScale(subject),
    }));
  }

  /** This pans the active projection from device motion and does not change zoom or orbit. */
  panBy(deltaXCssPx: number, deltaYCssPx: number): void {
    const sensitivity = panSensitivity(this.requestValue) / SCENE_PERMILLE_SCALE;
    if (this.kindValue === ORTHOGRAPHIC) {
      const start = this.worldPointAtViewport(this.widthCssPx / 2, this.heightCssPx / 2);
      const end = this.worldPointAtViewport(this.widthCssPx / 2 + deltaXCssPx,
        this.heightCssPx / 2 + deltaYCssPx);
      this.translateTarget(start.sub(end).multiplyScalar(sensitivity));
    } else {
      const orbit = this.stateValue.orbit ?? [0, 0, 0, 1];
      const q = new THREE.Quaternion(...orbit);
      const span = Math.max(
        this.stateValue.bounds.x[1] - this.stateValue.bounds.x[0],
        this.stateValue.bounds.y[1] - this.stateValue.bounds.y[0],
      );
      const translation = perspectivePanVector(q, deltaXCssPx, deltaYCssPx,
        this.widthCssPx, this.heightCssPx, span * this.stateValue.ratio, sensitivity);
      const target = perspectiveTarget(this.stateValue, this.worldCenterZ).add(translation);
      const normalized = createNormalizationFunction(copyMutableBounds(this.stateValue.bounds))(target);
      this.stateValue = {
        ...this.stateValue,
        x: normalized.x, y: normalized.y, targetZ: target.z,
      };
    }
    this.updateCameras();
  }

  /** Free trackball rotation around the current target for either projection. */
  orbitBy(deltaXCssPx: number, deltaYCssPx = 0): void {
    const orbitSensitivity = this.requestValue.kind === "perspective"
      ? this.requestValue.navigation.orbitSensitivityPermille / SCENE_PERMILLE_SCALE
      : scalarCount();
    const orbit = this.stateValue.orbit ?? [0, 0, 0, 1];
    const nextOrbit = arcballDrag(new THREE.Quaternion(...orbit), deltaXCssPx * orbitSensitivity,
      deltaYCssPx * orbitSensitivity, this.heightCssPx);
    this.stateValue = { ...this.stateValue, orbit: [nextOrbit.x, nextOrbit.y, nextOrbit.z, nextOrbit.w] };
    this.updateCameras();
  }

  /** This applies calibrated zoom, holding the world point below an optional cursor in place. */
  zoomBy(deltaYCssPx: number, cursorXCssPx?: number, cursorYCssPx?: number,
    hoveredNode?: Coordinates, orthographicNodeDepth = false): void {
    const depthPoint = (this.kindValue !== ORTHOGRAPHIC || orthographicNodeDepth) && hoveredNode &&
      Number.isFinite(hoveredNode.x) && Number.isFinite(hoveredNode.y) && Number.isFinite(hoveredNode.z)
      ? new THREE.Vector3(hoveredNode.x, hoveredNode.y, hoveredNode.z) : undefined;
    const nodeScreen = depthPoint && hoveredNode ? this.graphToViewport(hoveredNode) : undefined;
    const anchorX = nodeScreen?.x ?? cursorXCssPx, anchorY = nodeScreen?.y ?? cursorYCssPx;
    const anchor = anchorX === undefined || anchorY === undefined
      ? undefined : this.worldPointAtViewport(anchorX, anchorY, depthPoint);
    const [sensitivityPermille, minimumPermille, maximumPermille] = this.requestValue.kind === "orthographic"
      ? [
          this.requestValue.navigation.zoomSensitivityPermille,
          this.requestValue.navigation.minimumZoomPermille,
          this.requestValue.navigation.maximumZoomPermille,
        ]
      : [
          this.requestValue.navigation.dollySensitivityPermille,
          this.requestValue.navigation.minimumDollyPermille,
          this.requestValue.navigation.maximumDollyPermille,
        ];
    const factor = wheelZoomFactor(deltaYCssPx, this.heightCssPx, sensitivityPermille);
    // A deliberate fit can sit outside the calibrated navigation range. Keep its first wheel
    // step proportional instead of snapping straight to the nearest configured limit.
    const minimum = Math.min(minimumPermille / SCENE_PERMILLE_SCALE, this.stateValue.ratio);
    const maximum = Math.max(maximumPermille / SCENE_PERMILLE_SCALE, this.stateValue.ratio);
    const previousRatio = this.stateValue.ratio;
    const nextRatio = Math.max(minimum, Math.min(maximum, previousRatio * factor));
    const sizeAnchor = this.kindValue !== ORTHOGRAPHIC ? depthPoint ?? anchor : undefined;
    if (sizeAnchor && nextRatio < NODE_REFERENCE_FLOOR_RATIO && nextRatio < previousRatio) {
      const previousAnchor = this.stateValue.closeSizeAnchor;
      const sameAnchor = previousAnchor && Math.hypot(previousAnchor.x - sizeAnchor.x,
        previousAnchor.y - sizeAnchor.y, previousAnchor.z - sizeAnchor.z) <
        Math.max(this.stateValue.bounds.x[1] - this.stateValue.bounds.x[0],
          this.stateValue.bounds.y[1] - this.stateValue.bounds.y[0]) * 1e-9;
      if (previousRatio >= NODE_REFERENCE_FLOOR_RATIO || !sameAnchor ||
        !this.stateValue.closeSizeStartRatio || !this.stateValue.closeSizeStartScale) {
        const targetDepth = Math.max(this.perspective.position.distanceTo(
          perspectiveTarget(this.stateValue, this.worldCenterZ)), SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
        const anchorDepth = this.perspectiveViewDepth(sizeAnchor);
        const startRatio = previousRatio >= NODE_REFERENCE_FLOOR_RATIO
          ? NODE_REFERENCE_FLOOR_RATIO : previousRatio;
        // Wheel translation stays parallel to the anchor's view plane. Project its current
        // depth to the 0.08 crossing without changing the wheel's one-step camera motion.
        const crossingDepth = Math.max(SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE,
          anchorDepth + targetDepth * (startRatio / previousRatio - 1));
        const startScale = previousRatio >= NODE_REFERENCE_FLOOR_RATIO
          ? targetDepth * startRatio / previousRatio / crossingDepth
          : this.sizeScaleAt(sizeAnchor);
        this.stateValue = { ...this.stateValue, closeSizeAnchor: { ...sizeAnchor },
          closeSizeStartRatio: startRatio, closeSizeStartScale: startScale };
      }
    }
    this.stateValue = {
      ...this.stateValue,
      ratio: nextRatio,
    };
    this.updateCameras();
    if (anchor !== undefined) {
      const shifted = this.worldPointAtViewport(anchorX!, anchorY!, depthPoint);
      this.translateTarget(anchor.sub(shifted));
      this.updateCameras();
    }
  }

  private worldPointAtViewport(xCssPx: number, yCssPx: number, depthPoint?: THREE.Vector3): THREE.Vector3 {
    const clipX = xCssPx * bisectionDivisor() / this.widthCssPx - scalarCount();
    const clipY = scalarCount() - yCssPx * bisectionDivisor() / this.heightCssPx;
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ);
    if (this.kindValue === ORTHOGRAPHIC) {
      const inverse = matrixFromCamera(this.stateValue,
        viewportDimensions(this.widthCssPx, this.heightCssPx),
        graphDimensions(this.stateValue.bounds), DEFAULT_SETTINGS.stagePadding, true);
      const normalized = multiplyVec2(inverse, { x: clipX, y: clipY });
      const position = createNormalizationFunction(copyMutableBounds(this.stateValue.bounds)).inverse(normalized);
      const orbit = cameraOrbit(this.stateValue);
      const point = new THREE.Vector3(position.x - target.x, position.y - target.y, 0)
        .applyQuaternion(orbit).add(target);
      if (depthPoint) {
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(orbit);
        point.addScaledVector(normal, depthPoint.clone().sub(target).dot(normal));
      }
      return point;
    }
    const rayPoint = new THREE.Vector3(clipX, clipY, 0.5).unproject(this.perspective);
    const direction = rayPoint.sub(this.perspective.position).normalize();
    const normal = target.clone().sub(this.perspective.position).normalize();
    const planePoint = depthPoint ?? target;
    return this.perspective.position.clone().addScaledVector(direction,
      planePoint.clone().sub(this.perspective.position).dot(normal) / direction.dot(normal));
  }

  /** Find a visible scene node beneath the cursor when the rig owns scene framing subjects. */
  nodeAnchorAtViewport(xCssPx: number, yCssPx: number): Coordinates | undefined {
    let nearest: CameraFramingSubject | undefined, best = Infinity;
    for (const subject of this.worldFramingSubjects) {
      if (!subject.id.startsWith("node:")) continue;
      const screen = this.graphToViewport(subject.position);
      const distance = Math.hypot(screen.x - xCssPx, screen.y - yCssPx);
      const radius = Math.max(12, subject.extentCssPx * this.sizeScaleAt(subject.position));
      if (distance <= radius && distance < best) { nearest = subject; best = distance; }
    }
    return nearest?.position;
  }

  private translateTarget(delta: THREE.Vector3): void {
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ).add(delta);
    const normalized = createNormalizationFunction(copyMutableBounds(this.stateValue.bounds))(target);
    this.stateValue = { ...this.stateValue, x: normalized.x, y: normalized.y, targetZ: target.z };
  }

  private updateCameras(): void {
    updateOrthographicCamera(this.orthographic, this.stateValue, this.widthCssPx, this.heightCssPx,
      this.worldCenterZ);
    updatePerspectiveCamera(
      this.perspective,
      this.stateValue,
      this.widthCssPx,
      this.heightCssPx,
      this.worldCenterZ,
      this.framingTangentValue,
      this.worldFramingBounds,
    );
    const { closeSizeAnchor, closeSizeStartRatio, closeSizeStartScale } = this.stateValue;
    this.closeNodeReferenceDepthValue = closeSizeAnchor && closeSizeStartRatio && closeSizeStartScale &&
      this.stateValue.ratio < NODE_REFERENCE_FLOOR_RATIO
      ? Math.max(this.perspectiveViewDepth(closeSizeAnchor),
          SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE) * Math.min(CLOSE_NODE_SCALE_CAP,
          closeSizeStartScale * closeSizeStartRatio / this.stateValue.ratio)
      : undefined;
  }

  /** This derives the framing tangent from bounds, subjects and viewport and does not store it. */
  private deriveFramingTangent(state: ReviewCameraState = this.stateValue): number {
    const aspect = this.widthCssPx / this.heightCssPx;
    const span = Math.max(
      state.bounds.x[1] - state.bounds.x[0],
      state.bounds.y[1] - state.bounds.y[0],
    );
    const verticalHalfSpan = Math.max(
      (state.bounds.y[1] - state.bounds.y[0]) / bisectionDivisor(),
      (state.bounds.x[1] - state.bounds.x[0]) / (bisectionDivisor() * aspect),
    );
    return perspectiveDefaultHalfAngleTangent(
      state,
      aspect,
      span,
      verticalHalfSpan,
      this.worldCenterZ,
      this.worldFramingSubjects,
      // D085-S5 BEGIN: only the depth-adjusted default opening moves the
      // framing reference; an explicitly supplied dolly keeps the old view.
      this.requestValue.ratio === 1 ? Math.max(1, state.ratio) : 1,
      // D085-S5 END
      this.widthCssPx,
      this.heightCssPx,
    );
  }

  private framingExtentScale(subject: CameraFramingSubject): number {
    if (subject.sizeMode === "node") {
      return this.sizeScaleAt(subject.position);
    }
    if (subject.sizeMode === "filament") {
      return this.readProjectionState().filamentSizeScale;
    }
    return scalarCount();
  }
}

/** This installs deterministic pointer and wheel navigation and does not schedule inertial motion. */
export function attachCameraInteractions(
  canvas: HTMLCanvasElement,
  rig: CameraRig,
  changed: () => void,
  resolveNodeAnchor?: (xCssPx: number, yCssPx: number) => Coordinates | undefined,
  // D081-P6 BEGIN: product review may replace the pointed mark after disclosure.
  resolveEachWheel = false,
  // D081-P6 END.
): (() => void) & { resetWheelAnchor(): void } {
  let pointerId: number | null = null;
  let wheelAnchor: Coordinates | undefined;
  let wheelX = NaN, wheelY = NaN;
  const resetWheelAnchor = (): void => { wheelAnchor = undefined; wheelX = NaN; wheelY = NaN; };
  let lastX = 0;
  let lastY = 0;
  let button = 0;
  let shift = false;
  const pointerDown = (event: PointerEvent): void => {
    resetWheelAnchor();
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    button = event.button;
    shift = event.shiftKey;
    canvas.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (Math.hypot(event.clientX - rect.left - wheelX, event.clientY - rect.top - wheelY) > 3) resetWheelAnchor();
    if (event.pointerId !== pointerId) {
      return;
    }
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (button !== 0 || shift || event.shiftKey) {
      rig.panBy(deltaX, deltaY);
    } else {
      rig.orbitBy(deltaX, deltaY);
    }
    changed();
  };
  const pointerUp = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      canvas.releasePointerCapture(event.pointerId);
      pointerId = null;
    }
  };
  const wheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const deltaY = event.deltaY * (event.deltaMode === 1 ? 16
      : event.deltaMode === 2 ? rect.height : 1);
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (Math.hypot(x - wheelX, y - wheelY) > 3) resetWheelAnchor();
    const hovered = resolveNodeAnchor ? undefined
      : (canvas as HTMLCanvasElement & { __reviewHoveredNode?: Coordinates }).__reviewHoveredNode;
    const screen = hovered && rig.graphToViewport(hovered);
    // D081-P6 BEGIN: the product's current mark supersedes the previous wheel world point.
    const anchor = resolveEachWheel && resolveNodeAnchor ? resolveNodeAnchor(x, y) : wheelAnchor ?? (resolveNodeAnchor ? resolveNodeAnchor(x, y)
      : screen && Math.hypot(screen.x - x, screen.y - y) <= 32
        ? hovered : rig.nodeAnchorAtViewport(x, y));
    // D081-P6 END.
    if (anchor !== undefined && wheelAnchor === undefined) {
      wheelAnchor = anchor;
      wheelX = x;
      wheelY = y;
    }
    rig.zoomBy(deltaY, x, y, anchor, resolveNodeAnchor !== undefined);
    changed();
  };
  const contextMenu = (event: MouseEvent): void => event.preventDefault();
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", contextMenu);
  return Object.assign((): void => {
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerUp);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("contextmenu", contextMenu);
  }, { resetWheelAnchor });
}

/** This creates Sigma-compatible default camera state for explicit bounds and does not inspect graph contents. */
export function cameraStateForBounds(bounds: Render3fFramingBox): VisualStateCamera {
  const state = new SigmaCamera().getState();
  return {
    ...state,
    bounds: copyBounds(bounds),
  };
}

/** This derives non-degenerate node bounds from resolved scene coordinates and does not add framing material. */
export function resolvedNodeBounds(points: readonly Coordinates[]): Render3fFramingBox {
  if (points.length === 0) {
    throw new TypeError("camera framing requires at least one resolved node");
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  return {
    x: nonDegenerateExtent(Math.min(...xValues), Math.max(...xValues)),
    y: nonDegenerateExtent(Math.min(...yValues), Math.max(...yValues)),
  };
}

/** This derives the layout-depth center from resolved coordinates and does not inspect governed channels. */
export function resolvedWorldCenterZ(points: readonly Coordinates[]): number {
  if (points.length === 0) {
    return 0;
  }
  const depths = points.map((point) => point.z);
  return (Math.min(...depths) + Math.max(...depths)) / bisectionDivisor();
}

function updateOrthographicCamera(
  camera: THREE.OrthographicCamera,
  state: VisualStateCamera,
  widthCssPx: number,
  heightCssPx: number,
  worldCenterZ: number,
): void {
  const project = (point: Coordinates) => orthographicClipPoint(
    orbitOrthographicPoint(point, state, worldCenterZ), state, widthCssPx, heightCssPx);
  const origin = project({ x: 0, y: 0, z: 0 });
  const xBasis = project({ x: scalarCount(), y: 0, z: 0 });
  const yBasis = project({ x: 0, y: scalarCount(), z: 0 });
  const zBasis = project({ x: 0, y: 0, z: scalarCount() });
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.projectionMatrix.set(
    xBasis.x - origin.x, yBasis.x - origin.x, zBasis.x - origin.x, origin.x,
    xBasis.y - origin.y, yBasis.y - origin.y, zBasis.y - origin.y, origin.y,
    0, 0, 0, 0,
    0, 0, 0, scalarCount(),
  );
  camera.projectionMatrixInverse.identity();
}

function cameraOrbit(state: VisualStateCamera): THREE.Quaternion {
  return new THREE.Quaternion(...((state as ReviewCameraState).orbit ?? [0, 0, 0, 1]));
}

function orbitOrthographicPoint(point: Coordinates, state: VisualStateCamera, worldCenterZ: number): Coordinates {
  const target = perspectiveTarget(state, worldCenterZ);
  const rotated = new THREE.Vector3(point.x, point.y, point.z).sub(target)
    .applyQuaternion(cameraOrbit(state).invert()).add(target);
  return { x: rotated.x, y: rotated.y, z: rotated.z };
}

function orthographicClipPoint(
  point: Coordinates,
  state: VisualStateCamera,
  widthCssPx: number,
  heightCssPx: number,
): { readonly x: number; readonly y: number } {
  const bounds = copyMutableBounds(state.bounds);
  const normalise = createNormalizationFunction(bounds);
  const matrix = matrixFromCamera(
    state,
    viewportDimensions(widthCssPx, heightCssPx),
    graphDimensions(state.bounds),
    DEFAULT_SETTINGS.stagePadding,
  );
  return multiplyVec2(matrix, normalise(point));
}

function updatePerspectiveCamera(
  camera: THREE.PerspectiveCamera,
  state: VisualStateCamera,
  widthCssPx: number,
  heightCssPx: number,
  worldCenterZ: number,
  framingTangent: number,
  framingBounds: FramingBounds3d | null,
): void {
  const target = perspectiveTarget(state, worldCenterZ);
  const span = Math.max(
    state.bounds.x[1] - state.bounds.x[0],
    state.bounds.y[1] - state.bounds.y[0],
  );
  const distance = span * state.ratio;
  const aspect = widthCssPx / heightCssPx;
  camera.aspect = aspect;
  // The perspective camera treats `ratio` as a pure dolly and the field of view as rig state:
  // `framingTangent` is the quantised half-angle tangent a deliberate framing moment computed
  // (construction, a tangent-less restore). Wheel, orbit, pan, disclosure subjects and viewport
  // resizes reuse the stored value, so the angle never moves under the reader — only the aspect
  // tracks the viewport — and on-screen size follows `1 / ratio`.
  camera.fov = (
    bisectionDivisor()
    * Math.atan(framingTangent)
    * halfTurnDegrees()
  ) / Math.PI;
  const review = state as ReviewCameraState;
  const orbit = new THREE.Quaternion(...(review.orbit ?? [0, 0, 0, 1]));
  camera.up.set(0, 0, scalarCount()).applyQuaternion(orbit);
  camera.position.copy(target).add(new THREE.Vector3(
    Math.cos(state.angle) * distance, Math.sin(state.angle) * distance, distance,
  ).applyQuaternion(orbit));
  // Fit the far plane to the actual scene volume, not to the dolly range. The subject bounds
  // are cached when the scene changes, so a wheel step only does constant-time arithmetic.
  const minX = Math.min(state.bounds.x[0], framingBounds?.minX ?? state.bounds.x[0]);
  const maxX = Math.max(state.bounds.x[1], framingBounds?.maxX ?? state.bounds.x[1]);
  const minY = Math.min(state.bounds.y[0], framingBounds?.minY ?? state.bounds.y[0]);
  const maxY = Math.max(state.bounds.y[1], framingBounds?.maxY ?? state.bounds.y[1]);
  const minZ = Math.min(worldCenterZ, framingBounds?.minZ ?? worldCenterZ);
  const maxZ = Math.max(worldCenterZ, framingBounds?.maxZ ?? worldCenterZ);
  const sceneCenterX = (minX + maxX) / 2;
  const sceneCenterY = (minY + maxY) / 2;
  const sceneCenterZ = (minZ + maxZ) / 2;
  const sceneRadius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  const targetDistance = camera.position.distanceTo(target);
  // A small near plane keeps the target, its screen-sized pearls and nearby shells in view.
  // Scaling it with distance retains depth precision even at the unchanged far dolly limit.
  camera.near = Math.max(span * 0.00001, targetDistance / 64);
  camera.far = Math.max(camera.near * 2,
    Math.hypot(camera.position.x - sceneCenterX, camera.position.y - sceneCenterY,
      camera.position.z - sceneCenterZ) + sceneRadius * 1.5 + span * 0.05);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

function perspectiveDefaultHalfAngleTangent(
  state: VisualStateCamera,
  aspect: number,
  span: number,
  verticalHalfSpan: number,
  worldCenterZ: number,
  worldFramingSubjects: readonly CameraFramingSubject[],
  // D085-S5 BEGIN
  referenceRatio: number,
  // D085-S5 END
  widthCssPx: number,
  heightCssPx: number,
): number {
  const target = perspectiveBoundsCenter(state, worldCenterZ);
  // D085-S5 BEGIN: measure the field of view at the actual opening dolly.
  const position = target.clone().addScaledVector(openingDirection(), span * referenceRatio * Math.SQRT2);
  // D085-S5 END
  const matrixWorld = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, scalarCount(), 0));
  matrixWorld.setPosition(position);
  const matrixWorldInverse = matrixWorld.invert();
  const targetDistance = position.distanceTo(target);
  const samples = worldFramingSubjects.map((subject) => {
    const point = subject.position;
    const view = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrixWorldInverse);
    const depth = Math.max(-view.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    const extentScale = subject.sizeMode === "node" ? targetDistance / depth : scalarCount();
    return {
      id: subject.id,
      horizontalTangent: view.x / (depth * aspect),
      verticalTangent: view.y / depth,
      extentCssPx: subject.extentCssPx * extentScale,
    };
  });
  const requiredTangent = requiredPerspectiveFramingTangent(samples, widthCssPx, heightCssPx);
  return quantizeCameraFramingUpperBound(Math.max(verticalHalfSpan / targetDistance, requiredTangent));
}

// D085-S5 BEGIN: only forward depth can put a node against the perspective
// camera. A lower bound on depth/eye distance also bounds screen-sized marks.
export function perspectiveOpeningRatio(
  state: VisualStateCamera, worldCenterZ: number,
  subjects: readonly CameraFramingSubject[], widthCssPx: number, heightCssPx: number,
): number {
  const span = Math.max(state.bounds.x[1] - state.bounds.x[0], state.bounds.y[1] - state.bounds.y[0]);
  // D085-S5 BEGIN: a caller-supplied dolly is a navigation intent, not a fresh fit.
  if (state.ratio !== 1 || !(span > 0) || !subjects.length) return state.ratio;
  // D085-S5 END
  const center = perspectiveBoundsCenter(state, worldCenterZ);
  const direction = openingDirection();
  let farthestForward = 0;
  let largestNodeExtent = 0;
  for (const subject of subjects) {
    const point = subject.position;
    farthestForward = Math.max(farthestForward,
      (point.x - center.x) * direction.x + (point.y - center.y) * direction.y
        + (point.z - center.z) * direction.z);
    if (subject.sizeMode === "node") largestNodeExtent = Math.max(largestNodeExtent, subject.extentCssPx);
  }
  const minimumViewport = Math.min(widthCssPx, heightCssPx);
  const reserve = Math.min(0.8, Math.max(0.1, 2 * largestNodeExtent / minimumViewport + 0.02));
  const required = farthestForward / ((1 - reserve) * span * Math.SQRT2);
  return Math.max(state.ratio, required * 1.001);
}
// D085-S5 END

function perspectiveTarget(state: VisualStateCamera, worldCenterZ: number): THREE.Vector3 {
  const normalise = createNormalizationFunction(copyMutableBounds(state.bounds));
  const target = normalise.inverse({ x: state.x, y: state.y });
  return new THREE.Vector3(target.x, target.y, (state as ReviewCameraState).targetZ ?? worldCenterZ);
}

function perspectiveBoundsCenter(state: VisualStateCamera, worldCenterZ: number): THREE.Vector3 {
  return new THREE.Vector3(
    (state.bounds.x[0] + state.bounds.x[1]) / bisectionDivisor(),
    (state.bounds.y[0] + state.bounds.y[1]) / bisectionDivisor(),
    worldCenterZ,
  );
}

function panSensitivity(request: SceneCameraRequest): number {
  return request.navigation.panSensitivityPermille;
}

function copyCameraState(state: VisualStateCamera | SceneCameraRequest): ReviewCameraState {
  const review = state as ReviewCameraState;
  return {
    x: state.x,
    y: state.y,
    angle: state.angle,
    ratio: state.ratio,
    bounds: copyBounds(state.bounds),
    ...(validOrbit(review.orbit) ? { orbit: normalisedOrbit(review.orbit) } : {}),
    ...(Number.isFinite(review.targetZ) ? { targetZ: review.targetZ } : {}),
    ...(review.closeSizeAnchor && [review.closeSizeAnchor.x, review.closeSizeAnchor.y,
      review.closeSizeAnchor.z].every(Number.isFinite) && Number.isFinite(review.closeSizeStartRatio) &&
      Number.isFinite(review.closeSizeStartScale) && (review.closeSizeStartRatio ?? 0) > 0 &&
      (review.closeSizeStartScale ?? 0) > 0
      ? { closeSizeAnchor: { ...review.closeSizeAnchor }, closeSizeStartRatio: review.closeSizeStartRatio,
          closeSizeStartScale: review.closeSizeStartScale } : {}),
    ...(validFramingTangent(review.framingTangent) ? { framingTangent: review.framingTangent } : {}),
    ...(Number.isFinite(review.framingCenterZ) ? { framingCenterZ: review.framingCenterZ } : {}),
  };
}

/** A restored orbit is kept only as four finite components of a non-zero quaternion; anything else is dropped. */
export function validOrbit(orbit: unknown): orbit is readonly [number, number, number, number] {
  return Array.isArray(orbit) && orbit.length === 4 && orbit.every(Number.isFinite)
    && Math.hypot(...(orbit as number[])) > Number.EPSILON;
}

/** A carried framing tangent is kept only as one finite positive number; anything else is dropped. */
export function validFramingTangent(tangent: unknown): tangent is number {
  return typeof tangent === "number" && Number.isFinite(tangent) && tangent > 0;
}

function normalisedOrbit(orbit: readonly [number, number, number, number]): [number, number, number, number] {
  const length = Math.hypot(...orbit);
  return [orbit[0] / length, orbit[1] / length, orbit[2] / length, orbit[3] / length];
}

function copyBounds(bounds: Render3fFramingBox): { readonly x: readonly [number, number]; readonly y: readonly [number, number] } {
  return {
    x: [bounds.x[0], bounds.x[1]],
    y: [bounds.y[0], bounds.y[1]],
  };
}

function copyMutableBounds(bounds: Render3fFramingBox): { readonly x: [number, number]; readonly y: [number, number] } {
  return {
    x: [bounds.x[0], bounds.x[1]],
    y: [bounds.y[0], bounds.y[1]],
  };
}

function graphDimensions(bounds: Render3fFramingBox): { readonly width: number; readonly height: number } {
  return {
    width: bounds.x[1] - bounds.x[0],
    height: bounds.y[1] - bounds.y[0],
  };
}

function viewportDimensions(width: number, height: number): { readonly width: number; readonly height: number } {
  return { width, height };
}

function nonDegenerateExtent(minimum: number, maximum: number): readonly [number, number] {
  return minimum === maximum
    ? [minimum - SCENE_PERMILLE_QUANTUM, maximum + SCENE_PERMILLE_QUANTUM]
    : [minimum, maximum];
}

function requiredDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be positive and finite`);
  }
  return value;
}

function scalarCount(): number {
  return ["value"].length;
}

function bisectionDivisor(): number {
  return ["left", "right"].length;
}

function halfTurnDegrees(): number {
  return 180;
}
