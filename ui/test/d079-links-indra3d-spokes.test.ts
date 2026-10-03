import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { screenSpaceEdgeWidthPx, stellarArcAlpha, stellarArcWidthPx } from '#render-common/morphology-canvas.ts';

// Bundle only the pure review presentation exports; product-view imports browser renderers.
const bundled = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: fileURLToPath(new URL('../src/review/', import.meta.url)),
    sourcefile: 'd079-links-indra3d-entry.ts', loader: 'ts',
    contents: `export { edgePresentationFloors, perceptibleEdgeFloors, applyPerceptibleEdgeFloors, structuralSpokeScreenWidthPx } from ${JSON.stringify(
      fileURLToPath(new URL('../src/review/product-view.ts', import.meta.url)))};` } });
const bundlePath = join(mkdtempSync(join(tmpdir(), 'd079-links-indra3d-')), 'floors.mjs');
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { edgePresentationFloors, perceptibleEdgeFloors, applyPerceptibleEdgeFloors,
  structuralSpokeScreenWidthPx } = await import(pathToFileURL(bundlePath).href) as
  typeof import('../src/review/product-view.ts');

test('Indra 3D containment floors clear the shell while semantic arcs retain their hierarchy', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const raw = edgePresentationFloors('indra', morphology, true, '3d');
    const structural = perceptibleEdgeFloors('indra', morphology, 'structural', '3d');
    const attested = perceptibleEdgeFloors('indra', morphology, 'attested', '3d');
    assert.ok(raw.opacityPermille >= 450);
    assert.ok(raw.widthPermille >= 800);
    assert.ok(structural.opacityPermille >= (morphology === 'stellar' ? 900 : 530));
    assert.ok(structural.widthPermille >= 850);
    assert.ok(structural.opacityPermille < attested.opacityPermille);
    assert.ok(structural.widthPermille < attested.widthPermille);
    const resolved = applyPerceptibleEdgeFloors('indra', morphology, 'structural',
      raw.opacityPermille, raw.widthPermille, '3d');
    assert.deepEqual(resolved, structural);
    if (morphology === 'stellar') {
      assert.equal(stellarArcWidthPx('intra', structural.widthPermille / 1000), 0.85);
      assert.equal(stellarArcWidthPx('intra', attested.widthPermille / 1000), 0.9);
      assert.ok(stellarArcAlpha('intra', structural.opacityPermille / 1000) <
        stellarArcAlpha('intra', attested.opacityPermille / 1000));
    }
  }
});

test('screen-space spoke width survives far-side perspective without changing other edges', () => {
  const floor = structuralSpokeScreenWidthPx('indra', '3d', true);
  assert.equal(floor, 0.75);
  assert.equal(screenSpaceEdgeWidthPx(0.42, floor), 0.75);
  assert.equal(screenSpaceEdgeWidthPx(0.75, floor) * 2, 1.5);
  assert.equal(screenSpaceEdgeWidthPx(0.92, floor), 0.92);
  for (const organization of ['natural', 'indra'] as const)
    for (const projection of ['2d', '3d'] as const)
      if (organization !== 'indra' || projection !== '3d')
        assert.equal(structuralSpokeScreenWidthPx(organization, projection, true), undefined);
  assert.equal(structuralSpokeScreenWidthPx('indra', '3d', false), undefined);
  assert.equal(screenSpaceEdgeWidthPx(0.42), 0.42);
});

test('Natural and Indra 2D floor tables remain unchanged', () => {
  for (const organization of ['natural', 'indra'] as const)
    for (const morphology of ['stellar', 'neural', 'mycelium'] as const)
      for (const kind of ['structural', 'attested', 'exploratory'] as const) {
        assert.deepEqual(perceptibleEdgeFloors(organization, morphology, kind, '2d'),
          perceptibleEdgeFloors(organization, morphology, kind));
        assert.deepEqual(edgePresentationFloors(organization, morphology, kind === 'structural', '2d'),
          edgePresentationFloors(organization, morphology, kind === 'structural'));
      }
});
