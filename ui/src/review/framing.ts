/**
 * Framing that does not depend on any renderer's camera convention.
 *
 * Sigma keeps its camera in normalised framed-graph coordinates, the orthographic R3F camera in its
 * own zoom units, and the perspective camera treats `ratio` as a dolly distance. Re-deriving each
 * convention is how a focus ends up behind the side panel or thousands of pixels off screen. So the
 * solver measures instead: it nudges one camera field at a time, watches how the projected points
 * move, corrects from that measurement, and checks the result by projecting again.
 */
import type { Coordinates } from "../engine/contract.ts";
import type { VisualStateCamera } from "../engine/visual-state.ts";

export type CameraHandle = {
  readCameraState(): VisualStateCamera;
  restoreCameraState(state: VisualStateCamera): void;
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
};

/** Container-local CSS pixels. */
export type FrameRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

export type FrameRequest = {
  readonly points: readonly Coordinates[];
  readonly rect: FrameRect;
  /** Clear space kept between the framed points and the rect edges. */
  readonly marginPx: number;
  /** Centre the first point (the selection) rather than the bounding box. */
  readonly anchorFirst: boolean;
  /** Share of the available space the framed points should fill. */
  readonly fill: number;
};

export type FrameResult = {
  readonly camera: VisualStateCamera;
  readonly fits: boolean;
  readonly iterations: number;
};

type Pixel = { readonly x: number; readonly y: number };

/** Six world-space supports of a containing sphere; fit them with the same camera solver as nodes. */
export function framingSpherePoints(center: Coordinates, radius: number): Coordinates[] {
  if (!Number.isFinite(radius) || radius < 0) throw new TypeError('framing sphere radius must be finite and non-negative');
  return (['x', 'y', 'z'] as const).flatMap(axis => [-1, 1].map(sign =>
    ({ ...center, [axis]: center[axis] + sign * radius })));
}
export function framingVolumePoints(points: readonly Coordinates[]): Coordinates[] {
  if (!points.length) return [];
  const bounds = (axis: keyof Coordinates) => [Math.min(...points.map(point => point[axis])), Math.max(...points.map(point => point[axis]))] as const;
  const x = bounds('x'), y = bounds('y'), z = bounds('z');
  const center = { x: (x[0] + x[1]) / 2, y: (y[0] + y[1]) / 2, z: (z[0] + z[1]) / 2 };
  const radius = Math.max(...points.map(point => Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z)));
  return framingSpherePoints(center, radius);
}

const MAX_ITERATIONS = 8;
const CENTRE_TOLERANCE_PX = 1.5;

function projectAll(handle: CameraHandle, points: readonly Coordinates[]): Pixel[] {
  return points.map((point) => handle.graphToViewport(point));
}

function extentOf(pixels: readonly Pixel[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...pixels.map((p) => p.x)),
    maxX: Math.max(...pixels.map((p) => p.x)),
    minY: Math.min(...pixels.map((p) => p.y)),
    maxY: Math.max(...pixels.map((p) => p.y)),
  };
}

function anchorOf(pixels: readonly Pixel[], anchorFirst: boolean): Pixel {
  if (anchorFirst) return pixels[0]!;
  const extent = extentOf(pixels);
  return { x: (extent.minX + extent.maxX) / 2, y: (extent.minY + extent.maxY) / 2 };
}

/** How much wider than the available space the framed points are when the anchor sits at the centre. */
function overflow(pixels: readonly Pixel[], request: FrameRequest): number {
  const availableX = Math.max(1, request.rect.width - (2 * request.marginPx));
  const availableY = Math.max(1, request.rect.height - (2 * request.marginPx));
  const anchor = anchorOf(pixels, request.anchorFirst);
  if (request.anchorFirst) {
    const farX = Math.max(...pixels.map((p) => Math.abs(p.x - anchor.x)));
    const farY = Math.max(...pixels.map((p) => Math.abs(p.y - anchor.y)));
    return Math.max((2 * farX) / availableX, (2 * farY) / availableY);
  }
  const extent = extentOf(pixels);
  return Math.max((extent.maxX - extent.minX) / availableX, (extent.maxY - extent.minY) / availableY);
}

function spanOf(pixels: readonly Pixel[]): number {
  const extent = extentOf(pixels);
  return Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
}

function withField(camera: VisualStateCamera, field: "x" | "y" | "ratio", value: number): VisualStateCamera {
  return { ...camera, [field]: value };
}

/** Pixel motion of `anchor` per unit change of one camera field, measured with a finite difference. */
function sensitivity(
  handle: CameraHandle,
  camera: VisualStateCamera,
  field: "x" | "y",
  point: Coordinates,
): Pixel {
  const before = handle.graphToViewport(point);
  let step = 1e-3 * Math.max(1, Math.abs(camera[field]));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    handle.restoreCameraState(withField(camera, field, camera[field] + step));
    const after = handle.graphToViewport(point);
    handle.restoreCameraState(camera);
    const response = { x: (after.x - before.x) / step, y: (after.y - before.y) / step };
    if (Math.hypot(response.x, response.y) * step > 0.05) return response;
    step *= 10;
  }
  return { x: 0, y: 0 };
}

/**
 * Moves the camera so the anchor (the selection, or the centre of the projected extent) lands on
 * `target`, using the measured 2×2 response of a reference point. In perspective, points at other
 * depths respond slightly differently; the outer loop re-measures, so the error shrinks each pass.
 */
function pan(handle: CameraHandle, camera: VisualStateCamera, request: FrameRequest, target: Pixel): VisualStateCamera {
  const pixels = projectAll(handle, request.points);
  const anchor = anchorOf(pixels, request.anchorFirst);
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  if (Math.hypot(dx, dy) <= CENTRE_TOLERANCE_PX) return camera;
  const reference = request.anchorFirst ? request.points[0]! : request.points[nearestIndex(pixels, anchor)]!;
  const alongX = sensitivity(handle, camera, "x", reference);
  const alongY = sensitivity(handle, camera, "y", reference);
  const determinant = (alongX.x * alongY.y) - (alongY.x * alongX.y);
  if (Math.abs(determinant) < 1e-12) return camera;
  const deltaX = ((dx * alongY.y) - (alongY.x * dy)) / determinant;
  const deltaY = ((alongX.x * dy) - (dx * alongX.y)) / determinant;
  const next = { ...camera, x: camera.x + deltaX, y: camera.y + deltaY };
  handle.restoreCameraState(next);
  return next;
}

function nearestIndex(pixels: readonly Pixel[], to: Pixel): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  pixels.forEach((pixel, index) => {
    const distance = Math.hypot(pixel.x - to.x, pixel.y - to.y);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Changes the zoom field until the framed points fill `fill` of the available space. */
function zoom(handle: CameraHandle, camera: VisualStateCamera, request: FrameRequest): VisualStateCamera {
  const pixels = projectAll(handle, request.points);
  const span = spanOf(pixels);
  // A lone node has no extent to fit: keep the zoom and only centre it.
  if (span < 1) return camera;
  const current = overflow(pixels, request);
  const wanted = request.fill;
  if (Math.abs(current - wanted) / wanted < 0.04) return camera;
  // Measure the local exponent between zoom field and on-screen size (−1 for an orthographic zoom,
  // close to −1 for a dolly), then take the step that should land on the wanted size.
  const probe = camera.ratio * 1.05;
  handle.restoreCameraState(withField(camera, "ratio", probe));
  const probed = spanOf(projectAll(handle, request.points));
  handle.restoreCameraState(camera);
  let exponent = -1;
  if (probed >= 1) {
    const measured = Math.log(probed / span) / Math.log(1.05);
    if (Number.isFinite(measured) && measured < -0.2) exponent = measured;
  }
  const scale = Math.pow(current / wanted, -1 / exponent);
  const ratio = camera.ratio * Math.min(8, Math.max(1 / 8, scale));
  const next = withField(camera, "ratio", ratio);
  handle.restoreCameraState(next);
  return next;
}

function fitsInside(pixels: readonly Pixel[], request: FrameRequest): boolean {
  const extent = extentOf(pixels);
  const { left, top, width, height } = request.rect;
  const margin = request.marginPx - 0.5;
  return extent.minX >= left + margin && extent.maxX <= left + width - margin
    && extent.minY >= top + margin && extent.maxY <= top + height - margin;
}

/**
 * Solves a camera that frames `points` inside `rect` and leaves the renderer on it.
 * Callers that animate restore their start camera and interpolate towards the result.
 */
export function solveFraming(handle: CameraHandle, request: FrameRequest): FrameResult {
  if (request.points.length === 0) {
    return { camera: handle.readCameraState(), fits: true, iterations: 0 };
  }
  const initial = handle.readCameraState();
  // A point behind a perspective camera projects to a non-finite pixel; framing on it would produce a non-finite zoom.
  const usable = (camera: VisualStateCamera) => Number.isFinite(camera.x) && Number.isFinite(camera.y)
    && Number.isFinite(camera.ratio) && camera.ratio > 0
    && projectAll(handle, request.points).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!usable(initial)) {
    let widened = initial;
    for (let attempt = 0; attempt < 8 && !usable(widened); attempt++) {
      widened = withField(widened, 'ratio', widened.ratio * 1.5);
      handle.restoreCameraState(widened);
    }
    if (!usable(widened)) { handle.restoreCameraState(initial); return { camera: initial, fits: false, iterations: 0 }; }
  }
  const target = { x: request.rect.left + (request.rect.width / 2), y: request.rect.top + (request.rect.height / 2) };
  let camera = handle.readCameraState();
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations += 1) {
    camera = pan(handle, camera, request, target);
    camera = zoom(handle, camera, request);
    camera = pan(handle, camera, request, target);
    if (!usable(camera)) {
      handle.restoreCameraState(initial);
      return { camera: initial, fits: false, iterations: iterations + 1 };
    }
    const pixels = projectAll(handle, request.points);
    const anchor = anchorOf(pixels, request.anchorFirst);
    const centred = Math.hypot(anchor.x - target.x, anchor.y - target.y) <= CENTRE_TOLERANCE_PX * 2;
    if (centred && fitsInside(pixels, request)) {
      return { camera, fits: true, iterations: iterations + 1 };
    }
  }
  // Last resort: widen until everything is inside, never leaving part of the selection hidden.
  for (let widen = 0; widen < 6 && !fitsInside(projectAll(handle, request.points), request); widen += 1) {
    camera = withField(camera, "ratio", camera.ratio * 1.2);
    handle.restoreCameraState(camera);
  }
  return { camera, fits: fitsInside(projectAll(handle, request.points), request), iterations };
}
