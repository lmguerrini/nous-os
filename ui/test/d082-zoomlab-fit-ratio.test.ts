import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const source = new URL("../src/review/product-view.ts", import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "../dist/evidence/d082-zoomlab-fit.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(source)),
    sourcefile: "d082-zoomlab-fit-entry.ts",
    loader: "ts",
    contents: `export { productLabelZoomTiers, productSceneFitKey, productSceneFitRatio } from ${JSON.stringify(fileURLToPath(source))};\n` +
      `export { densityStableOverviewRatio } from ${JSON.stringify(fileURLToPath(new URL("../src/review/v2-page.ts", import.meta.url)))};\n` +
      `export { cameraRevealZoom } from ${JSON.stringify(fileURLToPath(new URL("../src/review/reveal-controller.ts", import.meta.url)))};\n` +
      `export { lodLevelFromZoom } from ${JSON.stringify(fileURLToPath(new URL("../src/review/lod.ts", import.meta.url)))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const { productLabelZoomTiers, productSceneFitKey, productSceneFitRatio } =
  await import(pathToFileURL(bundlePath).href) as typeof import("../src/review/product-view.ts");
const { densityStableOverviewRatio, cameraRevealZoom, lodLevelFromZoom } =
  await import(pathToFileURL(bundlePath).href) as typeof import("../src/review/v2-page.ts") &
    typeof import("../src/review/reveal-controller.ts") & typeof import("../src/review/lod.ts");

test("semantic fit ratios are isolated by density on a density-stable camera key", () => {
  const fits = new Map<string, number>();
  const cameraKey = "2d/natural/constellation";
  fits.set(productSceneFitKey(cameraKey, 40), 1.344); // Bilanciata
  fits.set(productSceneFitKey(cameraKey, 60), 4.428); // Completa

  const completeFit = productSceneFitRatio(fits, cameraKey, 60, 2.267);
  assert.equal(completeFit, 4.428);
  assert.deepEqual(productLabelZoomTiers(2.267, completeFit), { overview: false, close: false },
    "Completa at its third wheel step enters the semantic zoom label tier");
  assert.equal(productSceneFitRatio(fits, cameraKey, 40, 2.267), 1.344,
    "the Bilanciata fit remains available when the density returns");
});

test("a density without a recorded fit uses its live ratio fallback", () => {
  const fits = new Map<string, number>([[productSceneFitKey("2d/natural", 40), 1.344]]);
  const liveRatio = 2.267;
  const fitted = productSceneFitRatio(fits, "2d/natural", 60, liveRatio);
  assert.equal(fitted, liveRatio);
  assert.deepEqual(productLabelZoomTiers(liveRatio, fitted), { overview: true, close: false });
});

test("page LOD borrows the latest same-view fit until the active density gets its own fit", () => {
  const cameraMorphologyReadingKey = "2d/natural/constellation/stellar/combined";
  const ratiosByDensity = new Map<string, number>([[`${cameraMorphologyReadingKey}/balanced`, 1.344]]);
  const mostRecentByView = new Map([[cameraMorphologyReadingKey, 1.344]]);

  const liveRatioAtComplete = 0.575;
  const borrowedFit = densityStableOverviewRatio(
    ratiosByDensity, mostRecentByView, cameraMorphologyReadingKey, "complete", null, liveRatioAtComplete);
  const borrowedZoom = cameraRevealZoom(borrowedFit, liveRatioAtComplete, "2d");
  assert.equal(borrowedFit, 1.344);
  assert.equal(lodLevelFromZoom(borrowedZoom, "far"), "intermediate",
    "the third wheel step crosses the intermediate page LOD threshold from the Bilanciata fit");

  const completeFit = 2.1;
  ratiosByDensity.set(`${cameraMorphologyReadingKey}/complete`, completeFit);
  mostRecentByView.set(cameraMorphologyReadingKey, completeFit);
  assert.equal(densityStableOverviewRatio(
    ratiosByDensity, mostRecentByView, cameraMorphologyReadingKey, "complete", 0.9, liveRatioAtComplete), completeFit,
  "after Adatta, Completa's own recorded fit takes precedence");
  assert.equal(densityStableOverviewRatio(
    ratiosByDensity, mostRecentByView, cameraMorphologyReadingKey, "balanced", 0.9, liveRatioAtComplete), 1.344,
    "an earlier density-specific fit remains available when returning to Bilanciata");
});

test("page LOD falls back to its remembered fit when the reading key changes", () => {
  const readingA = "2d/natural/constellation/stellar/attested";
  const readingB = "2d/natural/constellation/stellar/combined";
  const ratiosByDensity = new Map<string, number>();
  const mostRecentByView = new Map([[readingA, 1.344]]);
  const rememberedOverviewRatio = 1.344;
  const liveRatioAtComplete = 0.575;

  const borrowedFit = densityStableOverviewRatio(
    ratiosByDensity, mostRecentByView, readingB, "complete", rememberedOverviewRatio, liveRatioAtComplete);
  const borrowedZoom = cameraRevealZoom(borrowedFit, liveRatioAtComplete, "2d");

  assert.equal(borrowedFit, rememberedOverviewRatio);
  assert.equal(lodLevelFromZoom(borrowedZoom, "far"), "intermediate",
    "the fit recorded under the prior reading keeps Completa at z3 in intermediate LOD");
});
