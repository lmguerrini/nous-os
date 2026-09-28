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
};

export type ReviewCameraState = VisualStateCamera & {
  readonly orbit?: readonly [number, number, number, number];
  readonly targetZ?: number;
  /**
   * The framing half-angle tangent this view was deliberately framed at (first mount, a kind
   * switch's fresh construction, a fit or reset remount). It travels with saved camera states so
   * a restore — undo, redo, a disclosure remount — reproduces the same field of view instead of
   * re-deriving one from whatever the scene happens to contain now.
   */
  readonly framingTangent?: number;
};

/** Compose screen-space trackball motion in world space, including travel over either pole. */
export function arcballDrag(orientation: THREE.Quaternion, deltaX: number, deltaY: number, height: number): THREE.Quaternion {
  const right = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const up = new THREE.Vector3(-1, 0, 1).normalize().applyQuaternion(orientation);
  const yaw = new THREE.Quaternion().setFromAxisAngle(up, -deltaX * Math.PI / height);
  const pitch = new THREE.Quaternion().setFromAxisAngle(right, -deltaY * Math.PI / height);
  return pitch.multiply(yaw).multiply(orientation).normalize();
}

export type ViewPreset = "fronte" | "retro" | "sinistra" | "destra" | "alto" | "basso";
export const VIEW_DIRECTIONS: Readonly<Record<ViewPreset, readonly [number, number, number]>> = {
  fronte: [0, 0, 1], retro: [0, 0, -1], sinistra: [-1, 0, 0],
  destra: [1, 0, 0], alto: [0, 1, 0], basso: [0, -1, 0],
};
export const VIEW_UP: Readonly<Record<ViewPreset, readonly [number, number, number]>> = {
  fronte: [0, 1, 0], retro: [0, 1, 0], sinistra: [0, 1, 0],
  destra: [0, 1, 0], alto: [0, 0, -1], basso: [0, 0, 1],
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
  private kindValue: CameraKind;
  private stateValue: ReviewCameraState;
  private requestValue: SceneCameraRequest;
  private widthCssPx: number;
  private heightCssPx: number;
  private devicePixelRatio: number;
  private worldCenterZ: number;
  private worldFramingSubjects: readonly CameraFramingSubject[];
  private framingTangentValue: number;

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
    this.worldCenterZ = quantizeCameraFramingValue(resolvedWorldCenterZ(
      this.worldFramingSubjects.map((subject) => subject.position),
    ));
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
    return { ...copyCameraState(this.stateValue), framingTangent: this.framingTangentValue };
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
    this.worldCenterZ = quantizeCameraFramingValue(resolvedWorldCenterZ(
      this.worldFramingSubjects.map((subject) => subject.position),
    ));
    // New subjects alone (a disclosure, a selection) must not move the field of view: the
    // framing tangent is rig state, recomputed only where the framing is deliberate.
    this.updateCameras();
  }

  /** This projects one world coordinate through the active live camera and does not alter it. */
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
    if (this.kindValue === ORTHOGRAPHIC) {
      const clip = orthographicClipPoint(point, this.stateValue, this.widthCssPx, this.heightCssPx);
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

  /** This reports shader projection factors from the live cameras and does not update a material. */
  readProjectionState(): CameraProjectionState {
    const orthographicSizeScale = scalarCount() / DEFAULT_SETTINGS.zoomToSizeRatioFunction(this.stateValue.ratio);
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ);
    const targetView = target.clone().applyMatrix4(this.perspective.matrixWorldInverse);
    return {
      resolutionDevicePx: [
        this.widthCssPx * this.devicePixelRatio,
        this.heightCssPx * this.devicePixelRatio,
      ],
      devicePixelRatio: this.devicePixelRatio,
      orthographicSizeScale,
      filamentSizeScale: this.kindValue === ORTHOGRAPHIC ? orthographicSizeScale : scalarCount(),
      perspective: this.kindValue !== ORTHOGRAPHIC,
      referenceViewDepth: Math.max(-targetView.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE),
    };
  }

  /** This reports the live screen-size scale at one world point and does not change camera projection. */
  sizeScaleAt(point: Coordinates): number {
    if (this.kindValue === ORTHOGRAPHIC) {
      return scalarCount() / DEFAULT_SETTINGS.zoomToSizeRatioFunction(this.stateValue.ratio);
    }
    const target = perspectiveTarget(this.stateValue, this.worldCenterZ).applyMatrix4(this.perspective.matrixWorldInverse);
    const pointView = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(this.perspective.matrixWorldInverse);
    return Math.max(-target.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE)
      / Math.max(-pointView.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
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
      const inverse = matrixFromCamera(
        this.stateValue,
        viewportDimensions(this.widthCssPx, this.heightCssPx),
        graphDimensions(this.stateValue.bounds),
        DEFAULT_SETTINGS.stagePadding,
        true,
      );
      const start = multiplyVec2(inverse, { x: 0, y: 0 });
      const end = multiplyVec2(inverse, {
        x: deltaXCssPx * bisectionDivisor() / this.widthCssPx,
        y: -deltaYCssPx * bisectionDivisor() / this.heightCssPx,
      });
      this.stateValue = {
        ...this.stateValue,
        x: this.stateValue.x + ((start.x - end.x) * sensitivity),
        y: this.stateValue.y + ((start.y - end.y) * sensitivity),
      };
    } else {
      const orbit = this.stateValue.orbit ?? [0, 0, 0, 1];
      const q = new THREE.Quaternion(...orbit);
      const translation = perspectivePanVector(q, deltaXCssPx, deltaYCssPx,
        this.widthCssPx, this.heightCssPx, this.stateValue.ratio, sensitivity);
      const target = perspectiveTarget(this.stateValue, this.worldCenterZ).add(translation);
      const normalized = createNormalizationFunction(copyMutableBounds(this.stateValue.bounds))(target);
      this.stateValue = {
        ...this.stateValue,
        x: normalized.x, y: normalized.y, targetZ: target.z,
      };
    }
    this.updateCameras();
  }

  /** Free trackball rotation around the current target. */
  orbitBy(deltaXCssPx: number, deltaYCssPx = 0): void {
    if (this.requestValue.kind !== "perspective") {
      return;
    }
    const sensitivity = this.requestValue.navigation.orbitSensitivityPermille / SCENE_PERMILLE_SCALE;
    const orbit = this.stateValue.orbit ?? [0, 0, 0, 1];
    const q = arcballDrag(new THREE.Quaternion(...orbit), deltaXCssPx * sensitivity, deltaYCssPx * sensitivity, this.heightCssPx);
    this.stateValue = { ...this.stateValue, orbit: [q.x, q.y, q.z, q.w] };
    this.updateCameras();
  }

  /** This applies calibrated wheel zoom or dolly and does not alter the camera target. */
  zoomBy(deltaYCssPx: number): void {
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
    this.stateValue = {
      ...this.stateValue,
      ratio: Math.max(
        minimumPermille / SCENE_PERMILLE_SCALE,
        Math.min(maximumPermille / SCENE_PERMILLE_SCALE, this.stateValue.ratio * factor),
      ),
    };
    this.updateCameras();
  }

  private updateCameras(): void {
    updateOrthographicCamera(this.orthographic, this.stateValue, this.widthCssPx, this.heightCssPx);
    updatePerspectiveCamera(
      this.perspective,
      this.stateValue,
      this.requestValue,
      this.widthCssPx,
      this.heightCssPx,
      this.worldCenterZ,
      this.framingTangentValue,
    );
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
): () => void {
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let button = 0;
  let shift = false;
  const pointerDown = (event: PointerEvent): void => {
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    button = event.button;
    shift = event.shiftKey;
    canvas.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) {
      return;
    }
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (rig.kind === ORTHOGRAPHIC || button !== 0 || shift) {
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
    rig.zoomBy(event.deltaY);
    changed();
  };
  const contextMenu = (event: MouseEvent): void => event.preventDefault();
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", contextMenu);
  return (): void => {
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerUp);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("contextmenu", contextMenu);
  };
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
): void {
  const origin = orthographicClipPoint({ x: 0, y: 0, z: 0 }, state, widthCssPx, heightCssPx);
  const xBasis = orthographicClipPoint({ x: scalarCount(), y: 0, z: 0 }, state, widthCssPx, heightCssPx);
  const yBasis = orthographicClipPoint({ x: 0, y: scalarCount(), z: 0 }, state, widthCssPx, heightCssPx);
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.projectionMatrix.set(
    xBasis.x - origin.x, yBasis.x - origin.x, 0, origin.x,
    xBasis.y - origin.y, yBasis.y - origin.y, 0, origin.y,
    0, 0, 0, 0,
    0, 0, 0, scalarCount(),
  );
  camera.projectionMatrixInverse.identity();
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
  request: SceneCameraRequest,
  widthCssPx: number,
  heightCssPx: number,
  worldCenterZ: number,
  framingTangent: number,
): void {
  const target = perspectiveTarget(state, worldCenterZ);
  const span = Math.max(
    state.bounds.x[1] - state.bounds.x[0],
    state.bounds.y[1] - state.bounds.y[0],
  );
  const distance = span * state.ratio;
  const aspect = widthCssPx / heightCssPx;
  const navigationRange = request.kind === "perspective"
    ? request.navigation.maximumDollyPermille / request.navigation.minimumDollyPermille
    : request.navigation.maximumZoomPermille / request.navigation.minimumZoomPermille;
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
  camera.near = distance / navigationRange;
  camera.far = distance * (navigationRange + scalarCount());
  const review = state as ReviewCameraState;
  const orbit = new THREE.Quaternion(...(review.orbit ?? [0, 0, 0, 1]));
  camera.up.set(0, 0, scalarCount()).applyQuaternion(orbit);
  camera.position.copy(target).add(new THREE.Vector3(
    Math.cos(state.angle) * distance, Math.sin(state.angle) * distance, distance,
  ).applyQuaternion(orbit));
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
  widthCssPx: number,
  heightCssPx: number,
): number {
  const target = perspectiveBoundsCenter(state, worldCenterZ);
  const position = target.clone().addScaledVector(openingDirection(), span * Math.SQRT2);
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
    ...(validFramingTangent(review.framingTangent) ? { framingTangent: review.framingTangent } : {}),
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
