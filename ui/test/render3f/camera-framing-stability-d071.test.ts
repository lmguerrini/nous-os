import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";
import type { PerspectiveCamera } from "three";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { solveFraming } from "../../src/review/framing.ts";
import type { FrameRequest } from "../../src/review/framing.ts";
import type { CameraFramingSubject } from "#render3f/camera-framing.ts";
import type { SceneCameraRequest } from "#scene/contract.ts";

/**
 * The D-071 G4b defect: every camera update re-derived the perspective half-angle tangent from
 * the live framing subjects, so a semantic-zoom reveal (82 → 88 visible nodes) jumped the fov
 * from 50.5° to 58.4° mid-wheel and the whole view shrank about 15 % while the reader was
 * zooming in. These tests pin the new contract: the tangent is rig state, recomputed only where
 * the framing is deliberate (construction, a tangent-less restore), carried by saved camera
 * states, and reused unchanged by wheel, orbit, pan, disclosure subjects and viewport resizes.
 */

const cameraSource = new URL("../../src/render3f/camera.tsx", import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d071-camera-framing.mjs");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(cameraSource, "utf8"), { loader: "tsx", format: "esm" }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { CameraRig } =
  await import(pathToFileURL(output).href) as typeof import("../../src/render3f/camera.tsx");

const WIDTH = 1_200;
const HEIGHT = 800;
const BOUNDS = { x: [-450, 450] as const, y: [-450, 450] as const };
const NAVIGATION = DEFAULT_CALIBRATION.camera.perspective;

function makeRig(
  subjects: readonly CameraFramingSubject[],
  bounds: { readonly x: readonly [number, number]; readonly y: readonly [number, number] } = BOUNDS,
  ratio = 1,
) {
  const request: SceneCameraRequest = {
    kind: "perspective",
    x: 0.5,
    y: 0.5,
    angle: 0,
    ratio,
    bounds,
    navigation: NAVIGATION,
  };
  return new CameraRig(PERSPECTIVE, request, WIDTH, HEIGHT, 1, subjects);
}

function subject(id: string, x: number, y: number, z: number, extentCssPx = 4): CameraFramingSubject {
  return { id, position: { x, y, z }, extentCssPx, sizeMode: "node" };
}

test('D-100 a restored 3D camera retains its projection and node size across visible subsets', () => {
  const complete = makeRig([subject('a', -100, 0, -300), subject('b', 100, 0, 500)], BOUNDS, 0.6);
  const saved = complete.readCameraState();
  const sparse = makeRig([subject('a', -100, 0, -300)], BOUNDS, 0.6);
  sparse.restoreCameraState(saved);
  const point = { x: -100, y: 0, z: -300 };
  assert.deepEqual(sparse.readPose(), complete.readPose());
  assert.deepEqual(sparse.graphToViewport(point), complete.graphToViewport(point));
  assert.equal(sparse.sizeScaleAt(point), complete.sizeScaleAt(point));
  sparse.setWorldFramingSubjects([subject('a', -100, 0, -300), subject('c', 0, 0, 900)]);
  assert.deepEqual(sparse.graphToViewport(point), complete.graphToViewport(point));
  assert.equal(sparse.sizeScaleAt(point), complete.sizeScaleAt(point));
});

test('D-100 CPU radius uses the GPU depth floor at a perspective camera centre', () => {
  const rig = makeRig([subject('a', 0, 0, 0)], BOUNDS, 0.6);
  const [x, y, z] = rig.readPose().position;
  assert.ok(Math.abs(rig.sizeScaleAt({ x: x!, y: y!, z: z! }) - 1_000) < 1e-6);
});

/** The pre-reveal scene: nodes well inside the bounds, like a small Indra opening. */
const BASE_POSITIONS: readonly (readonly [number, number, number])[] = [
  [-300, -260, -120], [300, -260, -120], [-300, 260, -120], [300, 260, -120],
  [-300, -260, 120], [300, -260, 120], [-300, 260, 120], [300, 260, 120],
  [0, 0, -300], [0, 0, 300],
];
const BASE_SUBJECTS: readonly CameraFramingSubject[] = BASE_POSITIONS
  .map((position, index) => subject(`base:${index}`, position[0], position[1], position[2]));

/** The reveal: six new nodes outside the old framing, placed laterally like the semantic-zoom
 * children that were measured (they push the required tangent past the bounds term, which
 * is what made the pre-fix fov jump from 50.5° to 58.4°). */
const REVEALED_SUBJECTS: readonly CameraFramingSubject[] = [
  ...BASE_SUBJECTS,
  subject("revealed:0", 700, 60, 40), subject("revealed:1", -700, -60, 40),
  subject("revealed:2", 630, 120, -60), subject("revealed:3", -630, -120, -60),
  subject("revealed:4", 740, 0, 0, 6), subject("revealed:5", -740, 0, 0, 6),
];
const REVEALED_BOUNDS = { x: [-740, 740] as const, y: [-450, 450] as const };

const FIT_RECT: FrameRequest["rect"] = { left: 0, top: 0, width: WIDTH, height: HEIGHT };
const fitRequest = (points: readonly { x: number; y: number; z: number }[]): FrameRequest => ({
  points, rect: FIT_RECT, marginPx: 32, anchorFirst: false, fill: 0.9,
});

test("changing the world framing subjects alone leaves the fov unchanged", () => {
  const rig = makeRig(BASE_SUBJECTS);
  const openingFov = rig.readPose().fov;
  rig.setWorldFramingSubjects(REVEALED_SUBJECTS);
  assert.equal(rig.readPose().fov, openingFov, "a disclosure must not move the fov");
  rig.zoomBy(-120);
  rig.orbitBy(40, 25);
  rig.panBy(30, -20);
  assert.equal(rig.readPose().fov, openingFov, "wheel, orbit and pan must not move the fov");
  rig.resize(700, 900, 2);
  assert.equal(rig.readPose().fov, openingFov, "a panel resize must not move the fov");
  assert.ok(Math.abs((rig.camera as PerspectiveCamera).aspect - 700 / 900) < 1e-12,
    "the viewport aspect still updates the projection");
  // The same subjects do move the fov when the framing is deliberately recomputed.
  const remounted = makeRig(REVEALED_SUBJECTS, REVEALED_BOUNDS);
  assert.ok(Math.abs(remounted.readPose().fov - openingFov) > 2,
    `a fresh construction reframes (opening ${openingFov.toFixed(2)}°, remount ${remounted.readPose().fov.toFixed(2)}°)`);
});

test("an explicit fit or reset recomputes the framing tangent", () => {
  const rig = makeRig(BASE_SUBJECTS);
  const openingFov = rig.readPose().fov;
  // Reset and the first mount both delete the saved camera and construct the rig fresh: the
  // tangent then comes from the live subjects (the constructor path, proven above).
  const reset = makeRig(REVEALED_SUBJECTS, REVEALED_BOUNDS);
  assert.ok(Math.abs(reset.readPose().fov - openingFov) > 2, "a reset remount reframes from the live subjects");
  // A restore that carries no tangent (a fresh `cameraStateForBounds` record) is the other
  // deliberate path: it derives the tangent from the restored state and the current subjects.
  rig.setWorldFramingSubjects(REVEALED_SUBJECTS);
  rig.restoreCameraState({ x: 0.5, y: 0.5, angle: 0, ratio: 2, bounds: REVEALED_BOUNDS });
  assert.ok(Math.abs(rig.readPose().fov - openingFov) > 2, "a tangent-less restore reframes from the current subjects");
});

test("the fit solver reframes by ratio under the fixed tangent and still frames everything", () => {
  const rig = makeRig(BASE_SUBJECTS);
  const opening = solveFraming(rig, fitRequest(BASE_SUBJECTS.map((item) => item.position)));
  assert.equal(opening.fits, true, "the opening fit frames the base scene");
  const fitFov = rig.readPose().fov;
  // The reveal feeds new subjects; «Adatta» then runs the same measurement-based solver, which
  // adjusts the dolly ratio while the installed tangent — and so the fov — stays fixed.
  rig.setWorldFramingSubjects(REVEALED_SUBJECTS);
  const refit = solveFraming(rig, fitRequest(REVEALED_SUBJECTS.map((item) => item.position)));
  assert.equal(refit.fits, true, "the fit after the reveal frames every revealed node");
  assert.equal(rig.readPose().fov, fitFov, "the fit path keeps the installed fov");
  for (const item of REVEALED_SUBJECTS) {
    const projected = rig.graphToViewport(item.position);
    assert.ok(projected.x >= FIT_RECT.left && projected.x <= FIT_RECT.left + FIT_RECT.width
      && projected.y >= FIT_RECT.top && projected.y <= FIT_RECT.top + FIT_RECT.height,
      `revealed subject ${item.id} stays inside the viewport after the fit`);
  }
});

test("a restore of a saved state brings its own fov back", () => {
  const opening = makeRig(BASE_SUBJECTS);
  const saved = opening.readCameraState();
  const savedFov = opening.readPose().fov;
  assert.ok(typeof (saved as { framingTangent?: number }).framingTangent === "number",
    "a read state carries the framing tangent");
  // The disclosure remount: a fresh rig over the revealed scene (which alone would reframe),
  // immediately followed by the page restoring the pre-reveal camera into it.
  const remounted = makeRig(REVEALED_SUBJECTS, REVEALED_BOUNDS, saved.ratio);
  assert.ok(Math.abs(remounted.readPose().fov - savedFov) > 2,
    "the remount alone reframes (the measured pre-fix jump)");
  remounted.restoreCameraState(saved);
  assert.equal(remounted.readPose().fov, savedFov, "the restore reproduces the saved fov exactly");
  assert.deepEqual(remounted.readPose().position, opening.readPose().position,
    "the dolly position also continues from the saved state");
  // Saved states survive a JSON round trip (the page stores and compares them as JSON).
  remounted.setWorldFramingSubjects(BASE_SUBJECTS);
  remounted.restoreCameraState(JSON.parse(JSON.stringify(saved)) as typeof saved);
  assert.equal(remounted.readPose().fov, savedFov, "a JSON-round-tripped state keeps its fov");
});
