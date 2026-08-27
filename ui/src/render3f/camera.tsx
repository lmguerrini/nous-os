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
  canonicalCameraFramingPoints,
  quantizeCameraFramingValue,
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

/** This owns both cameras over one world coordinate system and does not retain graph semantics. */
export class CameraRig {
  private readonly orthographic = new THREE.OrthographicCamera();
  private readonly perspective = new THREE.PerspectiveCamera();
  private kindValue: CameraKind;
  private stateValue: VisualStateCamera;
  private requestValue: SceneCameraRequest;
  private widthCssPx: number;
  private heightCssPx: number;
  private devicePixelRatio: number;
  private worldCenterZ: number;
  private worldFramingPoints: readonly Coordinates[];

  /** This creates both projections over copied state and does not modify a world object. */
  constructor(
    kind: CameraKind,
    request: SceneCameraRequest,
    widthCssPx: number,
    heightCssPx: number,
    devicePixelRatio: number,
    worldFramingPoints: readonly Coordinates[],
  ) {
    this.kindValue = kind;
    this.stateValue = copyCameraState(request);
    this.requestValue = request;
    this.widthCssPx = requiredDimension(widthCssPx, "camera viewport width");
    this.heightCssPx = requiredDimension(heightCssPx, "camera viewport height");
    this.devicePixelRatio = requiredDimension(devicePixelRatio, "camera device pixel ratio");
    this.worldFramingPoints = canonicalCameraFramingPoints(worldFramingPoints);
    this.worldCenterZ = quantizeCameraFramingValue(resolvedWorldCenterZ(this.worldFramingPoints));
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

  /** This copies the serialisable camera record and does not expose mutable camera state. */
  readCameraState(): VisualStateCamera {
    return copyCameraState(this.stateValue);
  }

  /** This restores serialisable camera state and does not move a world anchor. */
  restoreCameraState(state: VisualStateCamera): void {
    this.stateValue = copyCameraState(state);
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
  setWorldFramingPoints(points: readonly Coordinates[]): void {
    this.worldFramingPoints = canonicalCameraFramingPoints(points);
    this.worldCenterZ = quantizeCameraFramingValue(resolvedWorldCenterZ(this.worldFramingPoints));
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
      this.stateValue = {
        ...this.stateValue,
        x: this.stateValue.x - ((deltaXCssPx / this.widthCssPx) * this.stateValue.ratio * sensitivity),
        y: this.stateValue.y + ((deltaYCssPx / this.heightCssPx) * this.stateValue.ratio * sensitivity),
      };
    }
    this.updateCameras();
  }

  /** This orbits the perspective camera from horizontal motion and does not alter layout depth. */
  orbitBy(deltaXCssPx: number): void {
    if (this.requestValue.kind !== "perspective") {
      return;
    }
    const sensitivity = this.requestValue.navigation.orbitSensitivityPermille / SCENE_PERMILLE_SCALE;
    this.stateValue = {
      ...this.stateValue,
      angle: this.stateValue.angle + ((deltaXCssPx / this.widthCssPx) * sensitivity * Math.PI * bisectionDivisor()),
    };
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
    const factor = Math.exp(
      (deltaYCssPx / this.heightCssPx) * sensitivityPermille / SCENE_PERMILLE_SCALE,
    );
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
      this.worldFramingPoints,
    );
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
  const pointerDown = (event: PointerEvent): void => {
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    button = event.button;
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
    if (rig.kind === ORTHOGRAPHIC || button !== 0) {
      rig.panBy(deltaX, deltaY);
    } else {
      rig.orbitBy(deltaX);
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
  worldFramingPoints: readonly Coordinates[],
): void {
  const target = perspectiveTarget(state, worldCenterZ);
  const span = Math.max(
    state.bounds.x[1] - state.bounds.x[0],
    state.bounds.y[1] - state.bounds.y[0],
  );
  const distance = span * state.ratio;
  const aspect = widthCssPx / heightCssPx;
  const verticalHalfSpan = Math.max(
    (state.bounds.y[1] - state.bounds.y[0]) / bisectionDivisor(),
    (state.bounds.x[1] - state.bounds.x[0]) / (bisectionDivisor() * aspect),
  );
  const defaultTangent = perspectiveDefaultHalfAngleTangent(
    state,
    aspect,
    span,
    verticalHalfSpan,
    worldCenterZ,
    worldFramingPoints,
  );
  const defaultBoundsTangent = verticalHalfSpan / span;
  const framingScale = defaultTangent / defaultBoundsTangent;
  const navigationRange = request.kind === "perspective"
    ? request.navigation.maximumDollyPermille / request.navigation.minimumDollyPermille
    : request.navigation.maximumZoomPermille / request.navigation.minimumZoomPermille;
  camera.aspect = aspect;
  camera.fov = (
    bisectionDivisor()
    * Math.atan((verticalHalfSpan / distance) * framingScale)
    * halfTurnDegrees()
  ) / Math.PI;
  camera.near = distance / navigationRange;
  camera.far = distance * (navigationRange + scalarCount());
  camera.up.set(0, 0, scalarCount());
  camera.position.set(
    target.x + (Math.cos(state.angle) * distance),
    target.y + (Math.sin(state.angle) * distance),
    target.z + distance,
  );
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
  worldFramingPoints: readonly Coordinates[],
): number {
  const target = perspectiveBoundsCenter(state, worldCenterZ);
  const position = new THREE.Vector3(
    target.x + (Math.cos(state.angle) * span),
    target.y + (Math.sin(state.angle) * span),
    target.z + span,
  );
  const matrixWorld = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 0, scalarCount()));
  matrixWorld.setPosition(position);
  const matrixWorldInverse = matrixWorld.invert();
  let requiredTangent = 0;
  for (const point of worldFramingPoints) {
    const view = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrixWorldInverse);
    const depth = Math.max(-view.z, SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE);
    requiredTangent = Math.max(
      requiredTangent,
      Math.abs(view.y) / depth,
      Math.abs(view.x) / (depth * aspect),
    );
  }
  const targetDistance = position.distanceTo(target);
  return quantizeCameraFramingValue(Math.max(verticalHalfSpan / targetDistance, requiredTangent));
}

function perspectiveTarget(state: VisualStateCamera, worldCenterZ: number): THREE.Vector3 {
  const normalise = createNormalizationFunction(copyMutableBounds(state.bounds));
  const target = normalise.inverse({ x: state.x, y: state.y });
  return new THREE.Vector3(target.x, target.y, worldCenterZ);
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

function copyCameraState(state: VisualStateCamera | SceneCameraRequest): VisualStateCamera {
  return {
    x: state.x,
    y: state.y,
    angle: state.angle,
    ratio: state.ratio,
    bounds: copyBounds(state.bounds),
  };
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
