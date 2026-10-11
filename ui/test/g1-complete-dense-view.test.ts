import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DENSE_NEURAL_POINT_FLOOR_CSS_PX } from '../src/engine/presentation-options.ts';
import { DENSE_SCENE_THRESHOLD, denseDrawingDensity, denseNodeScales, denseZoomBand,
  isCompleteDenseView, isReferenceCompleta, naturalCompletaFitPoints, usesDenseDrawingPolicy,
} from '../src/render-common/dense-node-scale.ts';
import { neuralShapeCacheEntryLimitFor } from '../src/render-common/morphology-canvas.ts';
import { labNativeSizeLawApplies } from '../src/render-common/native-node-law.ts';
import { neural3dCompletaPointFloorCssPx } from '../src/render3f/neural-point-floor.ts';

// The approved r4 decisions, kept here as independent oracles.
const oldIsReferenceCompleta = (nodeCount: number, visibleCount: number) =>
  nodeCount === 11_199 && visibleCount === 11_199;
const oldUsesDenseDrawingPolicy = (nodeCount: number, visibleCount: number, density: string) =>
  oldIsReferenceCompleta(nodeCount, visibleCount) || density === 'custom';
const oldLabNativeSizeLawApplies = (topology: string | undefined, nodeCount: number, visibleCount: number) =>
  topology !== undefined && topology !== 'natural' && !oldIsReferenceCompleta(nodeCount, visibleCount);
const oldNeuralPointFloor = (dense: boolean, nativeRadiusOnly: boolean, canopy: boolean) =>
  dense && !nativeRadiusOnly && !canopy ? DENSE_NEURAL_POINT_FLOOR_CSS_PX : 0;
const oldNeuralCacheEntryLimit = (_nodeCount: number) => 12_000;

function decisions(nodeCount: number, visibleCount: number, density: string,
  projection: '2d' | '3d', zoomProgress: number, atlasMaximum: boolean, old = false) {
  const drawingDensity = denseDrawingDensity(density, atlasMaximum);
  const complete = old ? oldIsReferenceCompleta(nodeCount, visibleCount)
    : isCompleteDenseView(nodeCount, visibleCount);
  const customDense = drawingDensity === 'custom' && !complete;
  const dense = old ? oldUsesDenseDrawingPolicy(nodeCount, visibleCount, drawingDensity)
    : usesDenseDrawingPolicy(nodeCount, visibleCount, drawingDensity);
  const samples = [
    { id: 'a', x: 0, y: 0, screenX: 10, screenY: 10, importance: 1, baseRadiusPx: 8,
      projectionScale: projection === '3d' ? 1.4 : 1 },
    { id: 'b', x: 3, y: 1, screenX: 17, screenY: 11, importance: 0.3, baseRadiusPx: 5,
      projectionScale: projection === '3d' ? 0.8 : 1 },
  ];
  const fitPoints = [{ x: -10, y: 2 }, { x: 2, y: 9 }, { x: 12, y: -3 }];
  return {
    complete, customDense, dense,
    labNative: old ? oldLabNativeSizeLawApplies('julia', nodeCount, visibleCount)
      : labNativeSizeLawApplies('julia', nodeCount, visibleCount),
    pointFloor: projection === '3d'
      ? old ? oldNeuralPointFloor(dense, customDense, false)
        : neural3dCompletaPointFloorCssPx({ morphology: 'neural', morphologyLanguage: 'distinct',
          canopyMount: false, usesDenseDrawingPolicy: dense, denseNativeRadiusOnly: customDense })
      : 0,
    fit: complete && projection === '2d' ? naturalCompletaFitPoints(fitPoints) : fitPoints,
    zoomBand: dense ? denseZoomBand(1 / Math.pow(1.25, zoomProgress * 6), 1) : 0,
    radii: dense ? [...denseNodeScales(samples, { zoomProgress, nativeRadiusOnly: customDense,
      screenDistanceNorm: new Map([['a', 0], ['b', 0.7]]) })] : [],
  };
}

test('r4 decisions retain the approved density, zoom and projection branches exactly', () => {
  assert.equal(DENSE_SCENE_THRESHOLD, 1200);
  for (const density of ['complete', 'custom', 'balanced', 'essential'])
    for (const projection of ['2d', '3d'] as const)
      for (const zoom of [0, 1 / 3, 1])
        for (const atlasMaximum of [false, true])
          assert.deepEqual(decisions(11_199, 11_199, density, projection, zoom, atlasMaximum),
            decisions(11_199, 11_199, density, projection, zoom, atlasMaximum, true));
  assert.equal(neuralShapeCacheEntryLimitFor(11_199), oldNeuralCacheEntryLimit(11_199));
});

test('larger complete datasets take the same dense drawing branches as r4', () => {
  for (const nodeCount of [13_742, 16_000]) {
    assert.equal(isCompleteDenseView(nodeCount, nodeCount), true);
    assert.equal(isReferenceCompleta(nodeCount, nodeCount), true);
    for (const density of ['complete', 'custom'])
      for (const projection of ['2d', '3d'] as const)
        for (const zoom of [0, 0.5, 1])
          assert.deepEqual(decisions(nodeCount, nodeCount, density, projection, zoom, false),
            decisions(11_199, 11_199, density, projection, zoom, false));
    assert.equal(neuralShapeCacheEntryLimitFor(nodeCount), nodeCount);
  }
});

test('one hidden node leaves the complete branch, while Custom keeps its own dense safeguards', () => {
  for (const nodeCount of [11_199, 13_742, 16_000]) {
    assert.equal(isCompleteDenseView(nodeCount, nodeCount - 1), false);
    assert.equal(usesDenseDrawingPolicy(nodeCount, nodeCount - 1, 'complete'), false);
    assert.equal(usesDenseDrawingPolicy(nodeCount, nodeCount - 1, 'custom'), true);
    assert.equal(labNativeSizeLawApplies('julia', nodeCount, nodeCount - 1), true);
  }
});

test('density-prepared subsets compare their drawn nodes with the whole dataset', () => {
  const cases = [
    { name: 'Canopy Bilanciata', prepared: 2_504, total: 11_199, visible: 2_504,
      density: 'balanced', complete: false, dense: false },
    { name: 'Natural Custom 2,000', prepared: 2_000, total: 11_199, visible: 2_000,
      density: 'custom', complete: false, dense: true },
    { name: 'r4 Completa', prepared: 11_199, total: 11_199, visible: 11_199,
      density: 'complete', complete: true, dense: true },
    { name: 'larger Completa', prepared: 13_742, total: 13_742, visible: 13_742,
      density: 'complete', complete: true, dense: true },
    { name: 'larger Bilanciata', prepared: 3_000, total: 13_742, visible: 3_000,
      density: 'balanced', complete: false, dense: false },
  ] as const;
  for (const row of cases) {
    assert.equal(row.prepared, row.visible, `${row.name}: prepared scene matches drawn count`);
    assert.equal(isCompleteDenseView(row.total, row.visible), row.complete, row.name);
    assert.equal(usesDenseDrawingPolicy(row.total, row.visible, row.density), row.dense, row.name);
    assert.equal(labNativeSizeLawApplies('julia', row.total, row.visible), !row.complete, row.name);
    if (row.total === 11_199)
      assert.equal(isCompleteDenseView(row.total, row.visible), oldIsReferenceCompleta(row.total, row.visible),
        `${row.name}: approved r4 oracle`);
  }
});

test('the page gives the view its witness total and all complete decisions consume it', () => {
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /const totalNodes = datasetTotalNodeCount;/);
  assert.match(page, /\.\.\.\(\{ density: this\.density,\s+datasetTotalNodeCount,/);
  assert.match(view, /const datasetTotalNodeCount = input\.v2Prepared[\s\S]*?datasetTotalNodeCount \?\? Number\.NaN/);
  assert.equal((view.match(/isCompleteDenseView\(datasetTotalNodeCount,/g) ?? []).length, 9);
  assert.equal((view.match(/usesDenseDrawingPolicy\(datasetTotalNodeCount,/g) ?? []).length, 2);
  assert.equal((view.match(/labNativeSizeLawApplies\(input\.labTopology, datasetTotalNodeCount,/g) ?? []).length, 2);
});

test('small complete fixtures keep every old decision', () => {
  for (const nodeCount of [50, 400, 1_199]) {
    assert.equal(isCompleteDenseView(nodeCount, nodeCount), false);
    assert.equal(neuralShapeCacheEntryLimitFor(nodeCount), oldNeuralCacheEntryLimit(nodeCount));
    for (const density of ['complete', 'custom', 'balanced'])
      for (const projection of ['2d', '3d'] as const)
        assert.deepEqual(decisions(nodeCount, nodeCount, density, projection, 0.5, false),
          decisions(nodeCount, nodeCount, density, projection, 0.5, false, true));
  }
});
