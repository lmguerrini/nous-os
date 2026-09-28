import assert from "node:assert/strict";
import { test } from "node:test";
import {
  framingVolumePoints,
  solveFraming,
  type CameraHandle,
  type FrameRequest,
} from "../../src/review/framing.ts";
import type { Coordinates } from "../../src/engine/contract.ts";
import type { VisualStateCamera } from "../../src/engine/visual-state.ts";

/**
 * Fake perspective cameras over one shared convention: the camera fields x/y address the world
 * target through the bounds' normalisation (exactly what the sigma camera and the R3F perspective
 * target do), the dolly distance is `span × ratio`, and the vertical field of view is 40° like the
 * review default. `alto` looks straight down the world y axis, so moving the y field moves the
 * target along the viewing direction — the D-071 defect's geometry.
 */

type FakeOptions = {
  readonly view: "fronte" | "alto";
  readonly bounds: { readonly x: readonly [number, number]; readonly y: readonly [number, number] };
  readonly width: number;
  readonly height: number;
  readonly initial: { readonly x: number; readonly y: number; readonly ratio: number };
  /** Any move of the y field puts every point behind the camera: a non-finite probe response. */
  readonly poisonY?: boolean;
  /** Degenerate zoom: the projection ignores the ratio field entirely. */
  readonly ignoreZoom?: boolean;
};

const spanOf = (bounds: FakeOptions["bounds"]): number =>
  Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]);

const worldTargetOf = (camera: VisualStateCamera): { x: number; y: number } => {
  const span = spanOf(camera.bounds);
  return {
    x: (camera.bounds.x[0] + camera.bounds.x[1]) / 2 + (camera.x - 0.5) * span,
    y: (camera.bounds.y[0] + camera.bounds.y[1]) / 2 + (camera.y - 0.5) * span,
  };
};

function fakePerspective(options: FakeOptions): {
  readonly handle: CameraHandle;
  maxRatioSeen(): number;
} {
  let state: VisualStateCamera = {
    x: options.initial.x, y: options.initial.y, angle: 0, ratio: options.initial.ratio, bounds: options.bounds,
  };
  let maxRatio = state.ratio;
  const span = spanOf(options.bounds);
  const focal = (options.height / 2) / Math.tan(Math.PI / 9);
  return {
    handle: {
      readCameraState: () => ({ ...state }),
      restoreCameraState: (next) => {
        state = { ...next };
        if (Number.isFinite(state.ratio)) maxRatio = Math.max(maxRatio, state.ratio);
      },
      graphToViewport: (point: Coordinates) => {
        if (options.poisonY && state.y !== options.initial.y) return { x: Number.NaN, y: Number.NaN };
        const target = worldTargetOf(state);
        const distance = options.ignoreZoom ? span : span * state.ratio;
        const depth = options.view === "alto" ? distance + (point.y - target.y) : distance + point.z;
        if (depth <= 0) return { x: Number.NaN, y: Number.NaN };
        const vertical = options.view === "alto" ? point.z : target.y - point.y;
        return {
          x: options.width / 2 + (point.x - target.x) * focal / depth,
          y: options.height / 2 - vertical * focal / depth,
        };
      },
    },
    maxRatioSeen: () => maxRatio,
  };
}

/** Deterministic cloud in a box, plus one node parked slightly off the volume centre: the anchor's
 * reference node, whose response to the y field is tiny but not exactly zero (the D-071 conditioning). */
function cloud(count: number, half: { x: number; y: number; z: number }, withCentreNode: boolean): Coordinates[] {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const points = Array.from({ length: count }, () => ({
    x: (next() * 2 - 1) * half.x,
    y: (next() * 2 - 1) * half.y,
    z: (next() * 2 - 1) * half.z,
  }));
  if (withCentreNode) points.push({ x: 12, y: 6, z: 3 });
  return points;
}

const requestOf = (points: readonly Coordinates[], width: number, height: number): FrameRequest => ({
  points,
  rect: { left: 0, top: 0, width, height },
  marginPx: 24,
  anchorFirst: false,
  fill: 0.92,
});

const pixelsOf = (handle: CameraHandle, points: readonly Coordinates[]) => points.map((p) => handle.graphToViewport(p));

const extentShare = (pixels: readonly { x: number; y: number }[], request: FrameRequest): number => {
  const minX = Math.min(...pixels.map((p) => p.x)), maxX = Math.max(...pixels.map((p) => p.x));
  const minY = Math.min(...pixels.map((p) => p.y)), maxY = Math.max(...pixels.map((p) => p.y));
  const availableX = Math.max(1, request.rect.width - 2 * request.marginPx);
  const availableY = Math.max(1, request.rect.height - 2 * request.marginPx);
  return Math.max((maxX - minX) / availableX, (maxY - minY) / availableY);
};

test("D-071 a top view whose y field answers along the viewing axis stays bounded and fits", () => {
  const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
  const nodes = cloud(60, { x: 450, y: 450, z: 150 }, true);
  const points = [...nodes, ...framingVolumePoints(nodes)];
  const { handle } = fakePerspective({ view: "alto", bounds, width: 900, height: 700, initial: { x: 0.5, y: 0.55, ratio: 1 } });
  const request = requestOf(points, 900, 700);

  const result = solveFraming(handle, request);

  const camera = result.camera;
  assert.ok(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio) && camera.ratio > 0,
    "the solved camera must stay finite");
  // The y field moves the target along the viewing direction here; its measured response at the
  // anchor's reference node is nearly zero, so the conditioning guard must leave the field alone
  // instead of dividing by it (the pre-fix solve moved the target by thousands of units).
  const target = worldTargetOf(camera);
  assert.ok(Math.abs(target.y - 45) <= 1e-6, `the weak y field must not move (target y ${target.y})`);
  const pixels = pixelsOf(handle, points);
  assert.ok(pixels.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), "projections must stay finite");
  assert.ok(result.fits, "the bounded solve must still fit every framed point");
  for (const p of pixels) {
    assert.ok(p.x >= -0.5 && p.x <= 900.5 && p.y >= -0.5 && p.y <= 700.5, `point (${p.x}, ${p.y}) must be inside the rect`);
  }
  const share = extentShare(pixels, request);
  assert.ok(share > 0.6 && share < 1.05, `the points must still fill the view, not collapse (share ${share.toFixed(3)})`);
});

test("D-071 a well-conditioned view is solved unchanged by the conditioning guard", () => {
  const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
  const points = cloud(40, { x: 450, y: 450, z: 0 }, false);
  const { handle } = fakePerspective({ view: "fronte", bounds, width: 900, height: 700, initial: { x: 0.58, y: 0.56, ratio: 0.9 } });
  const request = requestOf(points, 900, 700);

  const result = solveFraming(handle, request);

  assert.ok(result.fits, "the well-conditioned solve must fit");
  assert.ok(result.iterations <= 6, `expected fast convergence, took ${result.iterations}`);
  const centre = {
    x: (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2,
    y: (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2,
  };
  const target = worldTargetOf(result.camera);
  assert.ok(Math.abs(target.x - centre.x) <= 9, `target x ${target.x} must centre on the extent (centre ${centre.x})`);
  assert.ok(Math.abs(target.y - centre.y) <= 9, `target y ${target.y} must centre on the extent (centre ${centre.y})`);
  const share = extentShare(pixelsOf(handle, points), request);
  assert.ok(share > 0.85 && share < 0.99, `the fill target must be reached (share ${share.toFixed(3)})`);
});

test("D-071 a non-finite field response is rejected and never adopted", () => {
  const bounds = { x: [0, 1000] as const, y: [0, 1000] as const };
  const points: Coordinates[] = [{ x: 250, y: 250, z: 0 }, { x: 750, y: 250, z: 0 }, { x: 500, y: 750, z: 0 }];
  const { handle } = fakePerspective({ view: "fronte", bounds, width: 800, height: 600, initial: { x: 0.5, y: 0.5, ratio: 1 }, poisonY: true });

  const result = solveFraming(handle, requestOf(points, 800, 600));

  const camera = result.camera;
  assert.ok(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio) && camera.ratio > 0,
    "a poisoned probe must never leave a non-finite camera behind");
  assert.equal(camera.y, 0.5, "the field whose probe measures nothing usable must stay where it was");
  const pixels = pixelsOf(handle, points);
  assert.ok(pixels.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), "the renderer must be left on a finite camera");
  assert.ok(result.fits, "the usable x field and the zoom must still frame the points");
});

test("D-071 a degenerate zoom measurement cannot drive the ratio to extremes", () => {
  const bounds = { x: [0, 100] as const, y: [0, 100] as const };
  const points: Coordinates[] = [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }];
  const { handle, maxRatioSeen } = fakePerspective({
    view: "fronte", bounds, width: 800, height: 600, initial: { x: 0.5, y: 0.5, ratio: 1 }, ignoreZoom: true,
  });

  const result = solveFraming(handle, requestOf(points, 800, 600));

  assert.equal(result.fits, false, "nothing can fit when the zoom field has no effect");
  assert.ok(Number.isFinite(result.camera.ratio), "the returned camera stays finite");
  // Unbounded, the loop would compound its 8× per-step clamp for eight iterations (≈1.7e7); the
  // excursion bound keeps the renderer itself within a finite range of the solve's starting ratio.
  assert.ok(maxRatioSeen() <= 4200, `the zoom field ran to ${maxRatioSeen()}`);
});
