import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { stellarArcAlpha, stellarArcWidthPx } from '#render-common/morphology-canvas.ts';

// product-view imports the browser renderers; bundle the two pure presentation exports.
const bundled = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: fileURLToPath(new URL('../src/review/', import.meta.url)),
    sourcefile: 'd079-w6-links-entry.ts', loader: 'ts',
    contents: `export { perceptibleEdgeFloors, applyPerceptibleEdgeFloors } from ${JSON.stringify(
      fileURLToPath(new URL('../src/review/product-view.ts', import.meta.url)))};` } });
const bundlePath = join(mkdtempSync(join(tmpdir(), 'd079-w6-links-')), 'floors.mjs');
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { perceptibleEdgeFloors, applyPerceptibleEdgeFloors } = await import(pathToFileURL(bundlePath).href) as
  typeof import('../src/review/product-view.ts');

test('each Natural and Indra morphology has a perceptible class hierarchy', () => {
  for (const organization of ['natural', 'indra'] as const)
    for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
      const structural = perceptibleEdgeFloors(organization, morphology, 'structural');
      const attested = perceptibleEdgeFloors(organization, morphology, 'attested');
      const exploratory = perceptibleEdgeFloors(organization, morphology, 'exploratory');
      assert.ok(structural.opacityPermille < attested.opacityPermille,
        `${organization}/${morphology}: structural alpha`);
      assert.ok(attested.opacityPermille < exploratory.opacityPermille,
        `${organization}/${morphology}: attested alpha`);
      assert.ok(structural.widthPermille <= attested.widthPermille);
      assert.ok(attested.widthPermille <= exploratory.widthPermille);
      assert.ok(structural.opacityPermille >= (morphology === 'stellar' ? 850 : 440));
      assert.ok(structural.widthPermille >= (morphology === 'stellar' ? 850 : 800));
      assert.ok(exploratory.opacityPermille <= 1000);
      assert.ok(exploratory.widthPermille <= 1000);
    }
});

test('the S12 Natural Stellar containment line reaches the upper arc window', () => {
  // At the default black-and-white tint (0.64 sRGB) against #050505, the weakest
  // intra-community structural arc targets at least 1.75:1 native pixel contrast.
  const luminance = (channel: number) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const contrast = (alpha: number) =>
    (luminance(alpha * 0.64 * 255 + (1 - alpha) * 5) + 0.05) / (luminance(5) + 0.05);
  const natural = applyPerceptibleEdgeFloors('natural', 'stellar', 'structural', 500, 800);
  assert.deepEqual(natural, { opacityPermille: 900, widthPermille: 900 });
  assert.ok(stellarArcAlpha('intra', natural.opacityPermille / 1000) >= 0.3349);
  assert.equal(stellarArcWidthPx('intra', natural.widthPermille / 1000), 0.9);
  assert.ok(contrast(stellarArcAlpha('intra', natural.opacityPermille / 1000)) >= 1.75);
  const indra = applyPerceptibleEdgeFloors('indra', 'stellar', 'structural', 330, 720);
  assert.deepEqual(indra, { opacityPermille: 850, widthPermille: 850 });
  assert.ok(stellarArcAlpha('intra', indra.opacityPermille / 1000) >= 0.3274);
  assert.equal(stellarArcWidthPx('intra', indra.widthPermille / 1000), 0.85);
  assert.ok(contrast(stellarArcAlpha('intra', indra.opacityPermille / 1000)) >= 1.75);
  assert.deepEqual(applyPerceptibleEdgeFloors('indra', 'neural', 'attested', 360, 800),
    { opacityPermille: 560, widthPermille: 900 });
});

test('an edge above either floor keeps its existing width and opacity', () => {
  for (const organization of ['natural', 'indra'] as const)
    for (const morphology of ['stellar', 'neural', 'mycelium'] as const)
      for (const kind of ['structural', 'attested', 'exploratory'] as const) {
        const floor = perceptibleEdgeFloors(organization, morphology, kind);
        assert.deepEqual(applyPerceptibleEdgeFloors(organization, morphology, kind,
          floor.opacityPermille + 25, floor.widthPermille + 75),
        { opacityPermille: floor.opacityPermille + 25, widthPermille: floor.widthPermille + 75 });
        assert.deepEqual(applyPerceptibleEdgeFloors(organization, morphology, kind,
          floor.opacityPermille + 25, floor.widthPermille - 50),
        { opacityPermille: floor.opacityPermille + 25, widthPermille: floor.widthPermille });
      }
});
