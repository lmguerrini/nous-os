import { maxOf, minOf } from '#render-common/array-aggregation.ts';
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
/** Surface samples of the mounted glass sphere for the point-based fit solver. */
export function framingEnvelopeSpherePoints(center: Coordinates, radius: number): Coordinates[] {
  const points: Coordinates[] = [];
  for (let latitude = 0; latitude <= 12; latitude += 1) {
    const polar = Math.PI * latitude / 12;
    const ring = radius * Math.sin(polar);
    const count = latitude === 0 || latitude === 12 ? 1 : 24;
    for (let longitude = 0; longitude < count; longitude += 1) {
      const azimuth = Math.PI * 2 * longitude / count;
      points.push({ x: center.x + ring * Math.cos(azimuth),
        y: center.y + radius * Math.cos(polar), z: center.z + ring * Math.sin(azimuth) });
    }
  }
  return points;
}
export function framingVolumePoints(points: readonly Coordinates[]): Coordinates[] {
  if (!points.length) return [];
  const bounds = (axis: keyof Coordinates) => [minOf(points.map(point => point[axis])), maxOf(points.map(point => point[axis]))] as const;
  const x = bounds('x'), y = bounds('y'), z = bounds('z');
  const center = { x: (x[0] + x[1]) / 2, y: (y[0] + y[1]) / 2, z: (z[0] + z[1]) / 2 };
  const radius = maxOf(points.map(point => Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z)));
  return framingSpherePoints(center, radius);
}

const MAX_ITERATIONS = 8;
const CENTRE_TOLERANCE_PX = 1.5;
/** A camera field whose measured response is weaker than this share of the stronger field's response cannot be
 * solved for: seen from a top view the target's own depth axis answers with a nearly zero pixel motion. A healthy
 * view answers with two responses of comparable size, so the share sits well below that and well above zero. */
const MIN_FIELD_SHARE = 1 / 4;
/** Two responses closer than this sine are parallel for solving purposes; only the stronger field is then used.
 * The two responses of a healthy view are the camera's own screen axes, which are orthogonal. */
const MIN_RESPONSE_SINE = 0.3;
/** A pan step may move the target by at most this multiple of the framed points' bounding-sphere radius, and the
 * target may never leave that sphere expanded by the same margin. */
const PAN_SPHERE_MARGIN = 1;
/** The zoom field stays within this multiplicative range of the camera the solve started from, so a degenerate
 * measurement cannot dolly the camera to extremes (the fov is derived from this same distance). */
const ZOOM_EXCURSION = 4096;

function projectAll(handle: CameraHandle, points: readonly Coordinates[]): Pixel[] {
  return points.map((point) => handle.graphToViewport(point));
}

function extentOf(pixels: readonly Pixel[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: minOf(pixels.map((p) => p.x)),
    maxX: maxOf(pixels.map((p) => p.x)),
    minY: minOf(pixels.map((p) => p.y)),
    maxY: maxOf(pixels.map((p) => p.y)),
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
    const farX = maxOf(pixels.map((p) => Math.abs(p.x - anchor.x)));
    const farY = maxOf(pixels.map((p) => Math.abs(p.y - anchor.y)));
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
    // A probe that leaves the reference point behind the camera measures nothing usable.
    if (!Number.isFinite(after.x) || !Number.isFinite(after.y)) return { x: Number.NaN, y: Number.NaN };
    const response = { x: (after.x - before.x) / step, y: (after.y - before.y) / step };
    if (Math.hypot(response.x, response.y) * step > 0.05) return response;
    step *= 10;
  }
  return { x: 0, y: 0 };
}

function finiteResponse(response: Pixel): boolean {
  return Number.isFinite(response.x) && Number.isFinite(response.y);
}

/**
 * Moves the camera so the anchor (the selection, or the centre of the projected extent) lands on
 * `target`, using the measured 2×2 response of a reference point. The solve is conditioning-aware:
 * a field that answers too weakly or too parallel to the other (a perspective camera panning along
 * its own view axis, as every top or bottom preset does) is left unchanged and the correction runs
 * in least squares along the usable field. Every step is then bounded by the framed points' own
 * extent, so an ill-conditioned measurement can never fling the target away.
 */
function pan(handle: CameraHandle, camera: VisualStateCamera, request: FrameRequest, target: Pixel): VisualStateCamera {
  const pixels = projectAll(handle, request.points);
  const anchor = anchorOf(pixels, request.anchorFirst);
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  if (Math.hypot(dx, dy) <= CENTRE_TOLERANCE_PX) return camera;
  const reference = request.anchorFirst ? request.points[0]! : request.points[nearestIndex(pixels, anchor)]!;
  const step = panStep(handle, camera, { x: dx, y: dy }, reference);
  if (!step || (step.x === 0 && step.y === 0)) return camera;
  const bounded = boundedPanStep(camera, step, framedSphere(camera, request.points));
  const next = { ...camera, x: camera.x + bounded.x, y: camera.y + bounded.y };
  handle.restoreCameraState(next);
  return next;
}

/** The camera-field step that moves the anchor onto the residual `error`, solved only from well-conditioned fields. */
function panStep(
  handle: CameraHandle,
  camera: VisualStateCamera,
  error: Pixel,
  reference: Coordinates,
): { readonly x: number; readonly y: number } | null {
  const alongX = sensitivity(handle, camera, "x", reference);
  const alongY = sensitivity(handle, camera, "y", reference);
  if (!finiteResponse(alongX) || !finiteResponse(alongY)) return null;
  const lengthX = Math.hypot(alongX.x, alongX.y);
  const lengthY = Math.hypot(alongY.x, alongY.y);
  const determinant = (alongX.x * alongY.y) - (alongY.x * alongX.y);
  const sine = Math.abs(determinant) / Math.max(lengthX * lengthY, Number.MIN_VALUE);
  const usableX = lengthX >= Math.max(lengthX, lengthY) * MIN_FIELD_SHARE;
  const usableY = lengthY >= Math.max(lengthX, lengthY) * MIN_FIELD_SHARE;
  if (usableX && usableY && Number.isFinite(sine) && sine >= MIN_RESPONSE_SINE) {
    const deltaX = ((error.x * alongY.y) - (alongY.x * error.y)) / determinant;
    const deltaY = ((alongX.x * error.y) - (error.x * alongX.y)) / determinant;
    if (Number.isFinite(deltaX) && Number.isFinite(deltaY)) return { x: deltaX, y: deltaY };
  }
  // One field answers too weakly or too parallel to the other: least squares along the stronger response.
  const useX = lengthX >= lengthY;
  const primary = useX ? alongX : alongY;
  const denominator = (primary.x * primary.x) + (primary.y * primary.y);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const delta = ((error.x * primary.x) + (error.y * primary.y)) / denominator;
  if (!Number.isFinite(delta)) return null;
  return useX ? { x: delta, y: 0 } : { x: 0, y: delta };
}

type FramedSphere = { readonly centerX: number; readonly centerY: number; readonly radius: number };

/** Bounding sphere of the framed points in world units; a lone point falls back to the bounds' own half span. */
function framedSphere(camera: VisualStateCamera, points: readonly Coordinates[]): FramedSphere {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = points.map((point) => point.z);
  const center = {
    x: (minOf(xs) + maxOf(xs)) / 2,
    y: (minOf(ys) + maxOf(ys)) / 2,
    z: (minOf(zs) + maxOf(zs)) / 2,
  };
  const radius = maxOf(points.map((point) =>
    Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z)));
  return {
    centerX: center.x,
    centerY: center.y,
    radius: Number.isFinite(radius) ? Math.max(radius, fieldSpan(camera) / 2) : fieldSpan(camera) / 2,
  };
}

/** World units per unit of camera field: the normalisation maps the larger bounds extent onto one camera unit. */
function fieldSpan(camera: VisualStateCamera): number {
  const span = Math.max(camera.bounds.x[1] - camera.bounds.x[0], camera.bounds.y[1] - camera.bounds.y[0]);
  return Number.isFinite(span) && span > 0 ? span : 1;
}

/** The world x/y position the camera fields centre on; both live renderers normalise the bounds identically. */
function fieldTarget(camera: VisualStateCamera): { readonly x: number; readonly y: number } {
  const span = fieldSpan(camera);
  return {
    x: (camera.bounds.x[0] + camera.bounds.x[1]) / 2 + (camera.x - 0.5) * span,
    y: (camera.bounds.y[0] + camera.bounds.y[1]) / 2 + (camera.y - 0.5) * span,
  };
}

/** Clamps a solved step so the target moves at most one sphere margin per step and stays inside the expanded sphere. */
function boundedPanStep(
  camera: VisualStateCamera,
  step: { readonly x: number; readonly y: number },
  sphere: FramedSphere,
): { readonly x: number; readonly y: number } {
  const span = fieldSpan(camera);
  const limit = sphere.radius * PAN_SPHERE_MARGIN;
  const stepWorld = Math.hypot(step.x, step.y) * span;
  const shortened = stepWorld > limit && stepWorld > 0 ? limit / stepWorld : 1;
  let deltaX = step.x * shortened;
  let deltaY = step.y * shortened;
  const from = fieldTarget(camera);
  const centreNow = Math.hypot(from.x - sphere.centerX, from.y - sphere.centerY);
  const centreNext = Math.hypot(from.x + deltaX * span - sphere.centerX, from.y + deltaY * span - sphere.centerY);
  // Never farther out than the expanded sphere allows, and never farther than the target already was.
  const allowed = Math.max(sphere.radius * (1 + PAN_SPHERE_MARGIN), centreNow);
  if (centreNext > allowed && centreNext > 0) {
    const contained = allowed / centreNext;
    deltaX *= contained;
    deltaY *= contained;
  }
  return { x: deltaX, y: deltaY };
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

type ZoomLimits = { readonly minimum: number; readonly maximum: number };

/** Changes the zoom field until the framed points fill `fill` of the available space. */
function zoom(handle: CameraHandle, camera: VisualStateCamera, request: FrameRequest, limits: ZoomLimits): VisualStateCamera {
  const pixels = projectAll(handle, request.points);
  const span = spanOf(pixels);
  // A lone node has no extent to fit: keep the zoom and only centre it.
  if (!Number.isFinite(span) || span < 1) return camera;
  const current = overflow(pixels, request);
  const wanted = request.fill;
  if (!Number.isFinite(current) || Math.abs(current - wanted) / wanted < 0.04) return camera;
  // Measure the local exponent between zoom field and on-screen size (−1 for an orthographic zoom,
  // close to −1 for a dolly), then take the step that should land on the wanted size.
  const probe = Math.min(limits.maximum, camera.ratio * 1.05);
  handle.restoreCameraState(withField(camera, "ratio", probe));
  const probed = spanOf(projectAll(handle, request.points));
  handle.restoreCameraState(camera);
  if (!Number.isFinite(probed)) return camera;
  let exponent = -1;
  if (probed >= 1) {
    const measured = Math.log(probed / span) / Math.log(1.05);
    if (Number.isFinite(measured) && measured < -0.2) exponent = measured;
  }
  const scale = Math.pow(current / wanted, -1 / exponent);
  if (!Number.isFinite(scale) || scale <= 0) return camera;
  const ratio = Math.min(limits.maximum, Math.max(limits.minimum, camera.ratio * Math.min(8, Math.max(1 / 8, scale))));
  if (!Number.isFinite(ratio) || ratio <= 0) return camera;
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

/** How far a projection is from the framing goal: zero when the points fill `fill` of the space and sit centred. */
function framingMiss(pixels: readonly Pixel[], request: FrameRequest, target: Pixel): number {
  const over = overflow(pixels, request);
  if (!Number.isFinite(over) || over <= 0) return Number.POSITIVE_INFINITY;
  const anchor = anchorOf(pixels, request.anchorFirst);
  const centred = Math.hypot(anchor.x - target.x, anchor.y - target.y)
    / Math.max(1, Math.min(request.rect.width, request.rect.height));
  return Math.abs(Math.log(over / request.fill)) + centred;
}

/**
 * Solves a camera that frames `points` inside `rect` and leaves the renderer on it.
 * Callers that animate restore their start camera and interpolate towards the result.
 * A step is kept only when it improves on the best projection seen; a solve that never
 * converges returns that best camera, never a diverged one.
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
  const limits: ZoomLimits = { minimum: camera.ratio / ZOOM_EXCURSION, maximum: camera.ratio * ZOOM_EXCURSION };
  let best = camera;
  let bestMiss = framingMiss(projectAll(handle, request.points), request, target);
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations += 1) {
    camera = pan(handle, camera, request, target);
    camera = zoom(handle, camera, request, limits);
    camera = pan(handle, camera, request, target);
    if (!usable(camera)) break;
    const pixels = projectAll(handle, request.points);
    const anchor = anchorOf(pixels, request.anchorFirst);
    const centred = Math.hypot(anchor.x - target.x, anchor.y - target.y) <= CENTRE_TOLERANCE_PX * 2;
    // D081-P6c BEGIN: being contained is insufficient after a close wheel dolly.
    // A tiny graph is also contained; keep solving until it fills the requested view.
    const fillError = Math.abs(Math.log(overflow(pixels, request) / request.fill));
    if (centred && fitsInside(pixels, request) && fillError < 0.04) {
      // D081-P6c END.
      return { camera, fits: true, iterations: iterations + 1 };
    }
    const miss = framingMiss(pixels, request, target);
    if (miss < bestMiss) {
      best = camera;
      bestMiss = miss;
    }
  }
  camera = best;
  handle.restoreCameraState(camera);
  // Last resort: widen until everything is inside, never leaving part of the selection hidden.
  for (let widen = 0; widen < 6 && !fitsInside(projectAll(handle, request.points), request); widen += 1) {
    camera = withField(camera, "ratio", Math.min(limits.maximum, camera.ratio * 1.2));
    handle.restoreCameraState(camera);
  }
  return { camera, fits: fitsInside(projectAll(handle, request.points), request), iterations };
}
