import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import { DEFAULT_CALIBRATION, assertCalibrationProfile } from "#engine/calibration.ts";
import { quantizeCameraFramingUpperBound } from "#render3f/camera-framing.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { SceneCameraRequest } from "#scene/contract.ts";

/**
 * The D-071 G4 defect: the perspective camera derived its fov from the dolly distance, so
 * `distance × tan(fov/2)` stayed constant and the wheel changed only the perspective strength,
 * never the magnification. These tests pin the fixed-fov dolly: `ratio` moves the camera,
 * the angle stays at the tangent that frames the default opening at `ratio = 1`.
 */

const cameraSource = new URL("../../src/render3f/camera.tsx", import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d071-camera.mjs");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(cameraSource, "utf8"), { loader: "tsx", format: "esm" }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { CameraRig } =
  await import(pathToFileURL(output).href) as typeof import("../../src/render3f/camera.tsx");

const WIDTH = 1_200;
const HEIGHT = 800;
const BOUNDS = { x: [-450, 450] as const, y: [-450, 450] as const };
const SPAN = 900;
const VERTICAL_HALF_SPAN = 450;
const NAVIGATION = DEFAULT_CALIBRATION.camera.perspective;

function makeRig(ratio = 1) {
  const request: SceneCameraRequest = {
    kind: "perspective",
    x: 0.5,
    y: 0.5,
    angle: 0,
    ratio,
    bounds: BOUNDS,
    navigation: NAVIGATION,
  };
  return new CameraRig(PERSPECTIVE, request, WIDTH, HEIGHT, 1, []);
}

/** Two points symmetric about the target along world y: with the identity orbit and angle 0 the
 * camera looks along (1, 0, 1), so both sit at exactly the target-plane depth and their projected
 * separation must follow 1 / ratio while the fov stays fixed. */
const NEAR_PAIR = { x: 0, y: -300, z: 0 };
const FAR_PAIR = { x: 0, y: 300, z: 0 };
const separationOf = (rig: ReturnType<typeof makeRig>): number => {
  const a = rig.graphToViewport(NEAR_PAIR);
  const b = rig.graphToViewport(FAR_PAIR);
  return Math.hypot(a.x - b.x, a.y - b.y);
};

/** The fov the shipped formula produced before G4: tan(fov/2) = defaultTangent / ratio. */
function legacyFovDegrees(ratio: number): number {
  const defaultTangent = quantizeCameraFramingUpperBound(VERTICAL_HALF_SPAN / (SPAN * Math.SQRT2));
  const framingScale = defaultTangent / (VERTICAL_HALF_SPAN / SPAN);
  return 2 * Math.atan((VERTICAL_HALF_SPAN / (SPAN * ratio)) * framingScale) * 180 / Math.PI;
}

test("the perspective fov stays fixed while only the dolly ratio changes", () => {
  const rig = makeRig(1);
  const openingFov = rig.readPose().fov;
  for (const ratio of [0.08, 0.25, 0.5, 2, 4, 10]) {
    rig.restoreCameraState({ ...rig.readCameraState(), ratio });
    assert.equal(rig.readPose().fov, openingFov, `fov must not follow ratio ${ratio}`);
  }
  rig.restoreCameraState({ ...rig.readCameraState(), bounds: { x: [-1350, 1350], y: [-450, 450] } });
  assert.ok(Math.abs(rig.readPose().fov - openingFov) > 5, "the fov still follows the scene bounds");
});

test("the ratio = 1 view is exactly the one the previous formula framed", () => {
  const rig = makeRig(1);
  const pose = rig.readPose();
  assert.ok(Math.abs(pose.fov - legacyFovDegrees(1)) < 1e-9, "fov at ratio 1 equals the legacy fov at ratio 1");
  assert.ok(Math.abs(pose.fov - legacyFovDegrees(0.5)) > 5, "the legacy dolly-zoom no longer tracks the ratio");
  for (const [index, coordinate] of pose.position.entries()) {
    assert.ok(Math.abs(coordinate - [SPAN, 0, SPAN][index]!) < 1e-9, "camera position keeps distance = span × ratio");
  }
  for (const [index, coordinate] of pose.target.entries()) {
    assert.ok(Math.abs(coordinate) < 1e-9, "camera target stays the bounds centre");
  }
});

test("projected size at the target plane scales as 1 / ratio", () => {
  const rig = makeRig(1);
  const base = separationOf(rig);
  assert.ok(base > 100, `the measured pair separation is usable (${base.toFixed(3)} px)`);
  rig.restoreCameraState({ ...rig.readCameraState(), ratio: 0.25 });
  assert.ok(Math.abs(separationOf(rig) / (4 * base) - 1) < 0.02, "4× closer magnifies 4×");
  rig.restoreCameraState({ ...rig.readCameraState(), ratio: 4 });
  assert.ok(Math.abs(separationOf(rig) / (0.25 * base) - 1) < 0.02, "4× farther shrinks 4×");
});

test("wheel steps magnify by one constant factor within the calibration dolly limits", () => {
  assert.doesNotThrow(() => assertCalibrationProfile(DEFAULT_CALIBRATION));
  const { minimumDollyPermille, maximumDollyPermille } = NAVIGATION;
  assert.ok(Number.isSafeInteger(minimumDollyPermille) && Number.isSafeInteger(maximumDollyPermille));
  assert.ok(minimumDollyPermille > 0 && minimumDollyPermille < maximumDollyPermille);
  assert.ok(SCENE_PERMILLE_SCALE / minimumDollyPermille >= 12, "the closest dolly magnifies at least 12×");
  assert.ok(maximumDollyPermille / SCENE_PERMILLE_SCALE >= 10, "the farthest dolly shrinks to at most a tenth");

  const rig = makeRig(1);
  const base = separationOf(rig);
  const openingFov = rig.readPose().fov;
  for (let step = 0; step < 5; step += 1) {
    rig.zoomBy(-120);
  }
  assert.ok(Math.abs(rig.readCameraState().ratio - Math.exp(-0.75)) < 1e-12, "five steps compound one constant factor");
  assert.ok(Math.abs(rig.readPose().fov - openingFov) < 1e-9, "the wheel leaves the fov untouched");
  assert.ok(separationOf(rig) >= 1.8 * base, `five wheel-in steps magnified ${separationOf(rig) / base}×`);
  for (let step = 0; step < 10; step += 1) {
    rig.zoomBy(120);
  }
  assert.ok(separationOf(rig) < base, `ten wheel-out steps shrank the pair to ${separationOf(rig) / base}×`);

  const closest = makeRig(1);
  closest.zoomBy(-1_000_000_000);
  assert.equal(closest.readCameraState().ratio, minimumDollyPermille / SCENE_PERMILLE_SCALE);
  const farthest = makeRig(1);
  farthest.zoomBy(1_000_000_000);
  assert.equal(farthest.readCameraState().ratio, maximumDollyPermille / SCENE_PERMILLE_SCALE);
  const closestDistance = SPAN * minimumDollyPermille / SCENE_PERMILLE_SCALE;
  assert.ok(closest.camera.near > 0 && closest.camera.near < closestDistance / 2,
    `near ${closest.camera.near} stays well inside the closest target distance ${closestDistance}`);
  assert.ok(closest.camera.far > closestDistance + SPAN,
    `far ${closest.camera.far} still covers the whole bounds at the closest dolly`);
});
