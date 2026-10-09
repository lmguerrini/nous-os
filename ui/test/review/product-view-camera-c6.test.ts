import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Axes } from "../../src/review/view-contract.ts";
import type { VisualStateCamera } from "../../src/engine/visual-state.ts";

/**
 * D-073 C6: the product camera key is arrangement-qualified for Natural while the legacy
 * pre-arrangement key stays as the replay source, and an explicit fit or reset still wins over the
 * replay. The view module imports render3f TSX, so the pure C6 seam is esbuild-bundled once — the
 * repo's own pattern from `test/review/device-pixel-ratio-shadow.test.ts` — and imported under the
 * WebGL shims those modules' import graphs expect. The functions under test are exactly the ones the
 * view's mount/save/frame/reset paths call; no renderer is instantiated and no result is simulated.
 */

const source = new URL("../../src/review/product-view.ts", import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d073-c6-camera.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(source)),
    sourcefile: "d073-c6-camera-entry.ts",
    loader: "ts",
    contents: `export { assertNaturalArrangementAxis, brainRendererEnabled, commitProductCamera, forgetProductCamera, nativeSubsetRequiresRemount, preparationHostLive, productCameraKey, productViewRemountsAxes, replayProductCamera, resolvedViewArrangement } from ${JSON.stringify(fileURLToPath(source))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const {
  assertNaturalArrangementAxis, brainRendererEnabled, commitProductCamera, forgetProductCamera, productCameraKey,
  nativeSubsetRequiresRemount, preparationHostLive, productViewRemountsAxes, replayProductCamera, resolvedViewArrangement,
} = await import(pathToFileURL(bundlePath).href) as typeof import("../../src/review/product-view.ts");

// D086-F2 BEGIN: the native tier cannot present a new edge or node ID through
// the canvas-only subset API. Both density directions and same-count swaps matter.
test("native scene identity includes drawn node and edge IDs", () => {
  const nodes = new Set(["a", "b"]);
  const balanced = new Set(["edge:a"]);
  const complete = new Set(["edge:a", "edge:b"]);
  assert.equal(nativeSubsetRequiresRemount(11_199, nodes, balanced, nodes, complete), true);
  assert.equal(nativeSubsetRequiresRemount(11_199, nodes, complete, nodes, balanced), true);
  assert.equal(nativeSubsetRequiresRemount(11_199, nodes, balanced, nodes, new Set(["edge:b"])), true);
  assert.equal(nativeSubsetRequiresRemount(11_199, nodes, balanced, new Set(["a", "c"]), balanced), true);
  assert.equal(nativeSubsetRequiresRemount(11_199, nodes, balanced, nodes, balanced), false);
  assert.equal(nativeSubsetRequiresRemount(100, nodes, balanced, nodes, complete), false);
});
// D086-F2 END

// D086-F2 BEGIN: a removed async host must stop reporting preparation for an
// obsolete scene, even though its worker may still finish in the background.
test("superseded preparation loses its presentation lease", () => {
  assert.equal(preparationHostLive({ isConnected: true } as HTMLElement), true);
  assert.equal(preparationHostLive({ isConnected: false } as HTMLElement), false);
});
// D086-F2 END

const axes = (overrides: Partial<Axes> = {}): Axes => ({
  projection: "2d",
  morphology: "stellar",
  organization: "natural",
  colour: "bw",
  labels: true,
  reading: "attested",
  ...overrides,
});
const camera = (x: number): VisualStateCamera => ({
  x, y: 0, angle: 0, ratio: 2, bounds: { x: [-10, 10], y: [-10, 10] },
});

test("brain renderer gate is off by default and only accepts Natural Neural 3D", () => {
  const eligible = axes({ projection: "3d", morphology: "neural" });
  assert.equal(brainRendererEnabled(eligible), false);
  assert.equal(brainRendererEnabled(eligible, true), true);
  assert.equal(brainRendererEnabled(axes({ ...eligible, brain: false }), true), false);
  assert.equal(brainRendererEnabled(axes({ ...eligible, organization: "indra" }), true), false);
  assert.equal(brainRendererEnabled(axes({ ...eligible, morphology: "stellar" }), true), false);
  assert.equal(brainRendererEnabled(axes({ ...eligible, projection: "2d" }), true), false);
  assert.equal(productViewRemountsAxes(eligible, axes({ ...eligible, brain: true })), true);
});

test("the camera key is arrangement-qualified for Natural and unchanged in form for Indra", () => {
  assert.deepEqual(productCameraKey(axes({ arrangement: "constellation" })),
    { key: "2d/natural/constellation", legacyKey: "2d/natural", replaysLegacy: true });
  assert.deepEqual(productCameraKey(axes({ projection: "3d", morphology: "neural", arrangement: "network" })),
    { key: "3d/natural/network", legacyKey: "3d/natural", replaysLegacy: true });
  // The pinned D-072 legacy form: projection/organization, which is also Indra's whole key.
  assert.deepEqual(productCameraKey(axes({ organization: "indra" })),
    { key: "2d/indra", legacyKey: "2d/indra", replaysLegacy: false });
  assert.deepEqual(productCameraKey(axes({ projection: "3d", organization: "indra" })),
    { key: "3d/indra", legacyKey: "3d/indra", replaysLegacy: false });
});

// D086-F2 BEGIN: Canopy retains a camera independent of every Natural arrangement.
test("Canopy camera space does not replay Natural or Indra", () => {
  const cameras = new Map<string, VisualStateCamera>();
  const fits = new Map<string, number>();
  for (const projection of ['2d', '3d'] as const) {
    const natural = productCameraKey(axes({ projection, arrangement: 'network' }));
    const canopy = productCameraKey(axes({ projection }), 'natural', false, true);
    const indra = productCameraKey(axes({ projection, organization: 'indra' }));
    assert.notEqual(canopy.key, natural.key);
    assert.notEqual(canopy.key, indra.key);
    assert.equal(canopy.replaysLegacy, false);
    commitProductCamera(cameras, fits, natural, camera(0.35), 2);
    assert.equal(replayProductCamera(cameras, fits, canopy), undefined);
    commitProductCamera(cameras, fits, canopy, camera(0.7), 1.45);
    assert.equal(replayProductCamera(cameras, fits, canopy)?.x, 0.7);
    assert.equal(replayProductCamera(cameras, fits, natural)?.x, 0.35);
  }
});
// D086-F2 END

// D086-F2 BEGIN: a law mount must never replay Natural's normalization bounds.
test("a law camera uses its own coordinate-space record and leaves Natural replay intact", () => {
  const natural = productCameraKey(axes({ arrangement: 'constellation' }));
  const julia = productCameraKey(axes({ arrangement: 'constellation' }), 'julia');
  const sierpinski = productCameraKey(axes({ arrangement: 'constellation' }), 'sierpinski');
  assert.notEqual(julia.key, natural.key);
  assert.notEqual(sierpinski.key, julia.key);
  assert.equal(julia.replaysLegacy, false);
  const cameras = new Map<string, VisualStateCamera>();
  const fits = new Map<string, number>();
  const naturalCamera = { ...camera(0.4), bounds: { x: [-849, 885] as const, y: [-600, 600] as const } };
  const juliaCamera = { ...camera(0.6), bounds: { x: [-6, 6] as const, y: [-6, 6] as const } };
  commitProductCamera(cameras, fits, natural, naturalCamera, 1.1375);
  assert.equal(replayProductCamera(cameras, fits, julia), undefined, 'Julia must fit its own layout');
  commitProductCamera(cameras, fits, julia, juliaCamera, 1.2488);
  assert.equal(replayProductCamera(cameras, fits, sierpinski), undefined);
  assert.equal(replayProductCamera(cameras, fits, natural), naturalCamera, 'return to Natural replays its camera');
  assert.equal(replayProductCamera(cameras, fits, julia), juliaCamera, 'return to Julia replays Julia');
});
// D086-F2 END

test("an unresolved arrangement resolves from the morphology once and an explicit one wins", () => {
  assert.equal(resolvedViewArrangement(axes({ morphology: "stellar" })), "constellation");
  assert.equal(resolvedViewArrangement(axes({ morphology: "neural" })), "network");
  assert.equal(resolvedViewArrangement(axes({ morphology: "mycelium" })), "mycelium");
  assert.equal(resolvedViewArrangement(axes({ morphology: "stellar", arrangement: "mycelium" })), "mycelium");
  assert.equal(resolvedViewArrangement(axes({ organization: "indra" })), null);
  assert.equal(productCameraKey(axes({ morphology: "neural" })).key, "2d/natural/network");
  assert.equal(productCameraKey(axes({ morphology: "stellar", arrangement: "network" })).key, "2d/natural/network");
});

test("an old camera replays under the new key and is promoted with its fit ratio", () => {
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const old = camera(7);
  cameras.set("2d/natural", old);
  fitRatio.set("2d/natural", 4);
  const keys = productCameraKey(axes({ morphology: "mycelium" }));
  assert.equal(replayProductCamera(cameras, fitRatio, keys), old, "the legacy camera replays");
  assert.equal(cameras.get("2d/natural/mycelium"), old, "the replay landed under the new key");
  assert.equal(fitRatio.get("2d/natural/mycelium"), 4, "the mounted fit ratio replayed with it");
  assert.equal(replayProductCamera(cameras, fitRatio, keys), old, "the second read comes from the new key");
  // A camera already under the new key wins over the legacy entry; the legacy entry is not overwritten by a read.
  const fresh = camera(9);
  cameras.set(keys.key, fresh);
  assert.equal(replayProductCamera(cameras, fitRatio, keys), fresh);
  assert.equal(cameras.get("2d/natural"), old);
  // Indra never replays and never promotes: its key is its own legacy key.
  const indraKeys = productCameraKey(axes({ organization: "indra" }));
  assert.equal(replayProductCamera(cameras, fitRatio, indraKeys), undefined);
  assert.equal(cameras.has("2d/indra"), false);
  // Nothing to replay at all: undefined, and no entry is invented.
  const empty = { cameras: new Map<string, VisualStateCamera>(), fitRatio: new Map<string, number>() };
  assert.equal(replayProductCamera(empty.cameras, empty.fitRatio, keys), undefined);
  assert.equal(empty.cameras.size, 0);
});

test("an explicit fit commits under both keys and an explicit reset cannot be replayed back", () => {
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const keys = productCameraKey(axes({ arrangement: "mycelium" }));
  const fitted = camera(11);
  commitProductCamera(cameras, fitRatio, keys, fitted, 6);
  assert.equal(cameras.get("2d/natural/mycelium"), fitted);
  assert.equal(cameras.get("2d/natural"), fitted, "the explicit fit becomes the replay source");
  assert.equal(fitRatio.get("2d/natural/mycelium"), 6);
  assert.equal(fitRatio.get("2d/natural"), 6);
  // A later arrangement switch replays the explicitly fitted camera, not a pre-fit one.
  const replayed = replayProductCamera(cameras, fitRatio, productCameraKey(axes({ morphology: "neural" })));
  assert.equal(replayed, fitted);
  // The explicit reset forgets both spellings, so the remount refits instead of resurrecting.
  forgetProductCamera(cameras, fitRatio, keys);
  assert.equal(cameras.has("2d/natural/mycelium"), false);
  assert.equal(cameras.has("2d/natural"), false, "the deleted camera cannot be replayed back");
  assert.equal(fitRatio.has("2d/natural/mycelium"), false);
  assert.equal(fitRatio.has("2d/natural"), false);
  assert.equal(replayProductCamera(cameras, fitRatio, keys), undefined);
  // Indra commits and forgets exactly one key.
  const indraKeys = productCameraKey(axes({ projection: "3d", organization: "indra" }));
  const indraCameras = new Map<string, VisualStateCamera>();
  const indraFitRatio = new Map<string, number>();
  commitProductCamera(indraCameras, indraFitRatio, indraKeys, camera(1), 3);
  assert.deepEqual([...indraCameras.keys()], ["3d/indra"]);
  forgetProductCamera(indraCameras, indraFitRatio, indraKeys);
  assert.equal(indraCameras.size + indraFitRatio.size, 0);
});

test("an arrangement change remounts and a style switch that keeps the arrangement does not", () => {
  const base = axes({ arrangement: "constellation" });
  assert.equal(productViewRemountsAxes(base, axes({ arrangement: "network" })), true);
  assert.equal(productViewRemountsAxes(base, axes({ morphology: "neural" })), true,
    "an unresolved morphology switch resolves a different arrangement and remounts");
  assert.equal(productViewRemountsAxes(base, axes({ morphology: "neural", arrangement: "constellation" })), true,
    "a style switch still remounts as in D-072; the camera carries over through the key, not the remount");
  assert.equal(productViewRemountsAxes(base, axes({ colour: "warm", arrangement: "constellation" })), true,
    "a colour change still remounts as in D-072");
  assert.equal(productViewRemountsAxes(base, axes({ labels: false, arrangement: "constellation" })), false);
  assert.equal(productViewRemountsAxes(base, axes({ reading: "combined", arrangement: "constellation" })), true,
    "a reading change still remounts as in D-072");
  assert.equal(
    productViewRemountsAxes(axes({ morphology: "stellar" }), axes({ morphology: "stellar", arrangement: "constellation" })),
    false, "resolving an arrangement the view already had does not remount");
  assert.equal(productViewRemountsAxes(base, axes({ organization: "indra" })), true);
  assert.equal(productViewRemountsAxes(base, axes({ projection: "3d", arrangement: "constellation" })), true);
  assert.equal(productViewRemountsAxes(axes({ projection: "3d", morphology: "mycelium", arrangement: "mycelium" }),
    axes({ projection: "3d", morphology: "mycelium", arrangement: "mycelium", labels: false })), false);
});

test("an arrangement on the Indra view is refused with the register rule", () => {
  assert.throws(() => assertNaturalArrangementAxis(axes({ organization: "indra", arrangement: "network" })),
    /arrangement-requires-natural/);
  assertNaturalArrangementAxis(axes({ organization: "indra" }));
  assertNaturalArrangementAxis(axes({ arrangement: "network" }));
  assertNaturalArrangementAxis(axes());
});

test("the key derivation is deterministic under repetition and permuted evaluation", () => {
  const variants = [
    axes({ arrangement: "constellation" }),
    axes({ morphology: "neural" }),
    axes({ projection: "3d", morphology: "mycelium", arrangement: "network" }),
    axes({ organization: "indra" }),
    axes({ projection: "3d", organization: "indra" }),
    axes({ projection: "3d", morphology: "mycelium" }),
  ];
  const forward = variants.map((value) => productCameraKey(value));
  for (const [index, variant] of variants.entries())
    for (let repeat = 0; repeat < 5; repeat++)
      assert.deepEqual(productCameraKey(variant), forward[index]);
  const reversed = [...variants].reverse().map((value) => productCameraKey(value));
  assert.deepEqual(reversed, [...forward].reverse(), "evaluation order does not change any key");
  // Every Natural key is distinct per arrangement within a projection, and no key collides at all.
  assert.equal(new Set(forward.map((value) => value.key)).size, forward.length);
});
