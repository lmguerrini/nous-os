import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineGraphView, assertVisualGraphFieldRegister } from '../src/engine/contract.ts';
import type { VisualGraph } from '../src/engine/contract.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { neuralSomaFrames, readNeuralShapeCacheStats } from '../src/render-common/morphology-canvas.ts';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { createRenderVisualState, assertVisualState } from '../src/engine/visual-state.ts';
import { createFrameSampler, hudMeasurementActive } from '../src/review/perf-hud.ts';
import { resolveLabelIds } from '../src/render2d/model.ts';
import { DEFAULT_CALIBRATION } from '../src/engine/calibration.ts';

test('persisted open HUD has no sampler requests at rest', () => {
  let requests = 0, cancelled = 0;
  const sampler = createFrameSampler(() => ++requests, () => { cancelled++; });
  if (hudMeasurementActive(true, { quality: 'completa' })) sampler.start();
  assert.equal(requests, 0);
  if (hudMeasurementActive(true, { quality: 'movimento' })) sampler.start();
  assert.equal(requests, 1);
  if (!hudMeasurementActive(true, { quality: 'completa' })) sampler.stop();
  assert.equal(cancelled, 1);
});

test('dense relation labels preserve exact selection while measuring only the prefix', async () => {
  const globals = globalThis as unknown as { WebGL2RenderingContext?: unknown; WebGLRenderingContext?: unknown };
  globals.WebGL2RenderingContext ??= { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
    UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 };
  globals.WebGLRenderingContext ??= { TRIANGLES: 9 };
  const { selectCappedLabelPlacements } = await import('../src/render2d/index.ts');
  const placements = Array.from({ length: 15800 }, (_, i) => ({ id: `edge-${i}`,
    priority: 20000 - i, minimumX: i * 20, maximumX: i * 20 + 10,
    minimumY: 0, maximumY: 10 }));
  let measured = 0;
  const lazy = selectCappedLabelPlacements(placements, DEFAULT_CALIBRATION.labels.edgeDensityCap,
    DEFAULT_CALIBRATION.labels.collisionPaddingPx, item => { measured++; return item; });
  const exact = resolveLabelIds(placements, DEFAULT_CALIBRATION, DEFAULT_CALIBRATION.labels.edgeDensityCap);
  assert.deepEqual(lazy.map(item => item.id), exact);
  assert.equal(measured, DEFAULT_CALIBRATION.labels.edgeDensityCap);
});

test('production structural projection performs no validation or per-read trace', () => {
  const globals = globalThis as unknown as { window?: unknown; location?: unknown };
  const oldWindow = globals.window, oldLocation = globals.location;
  try {
    globals.window = {};
    globals.location = { search: '' };
    const graph = { nodes: [{ id: 'n', kind: 'subject', rendered: null,
      visual: { role: 'subject', label_priority: 1 } }], edges: [] } as unknown as VisualGraph;
    const fast = createEngineGraphView(graph, { fast: true });
    for (let frame = 0; frame < 100; frame++) {
      assert.equal(fast.graph.nodes[0]?.visual.label_priority, 1);
    }
    assert.deepEqual(fast.trace.reads, []);
    assert.throws(() => assertVisualGraphFieldRegister(graph), /pinned register/);
    const invalidCamera = { selectedId: null, focusedId: null, cameraKind: 'orthographic',
      camera: { x: 0, y: 0, angle: 0, ratio: -1, bounds: { x: [-1, 1], y: [-1, 1] } },
      morphology: 'stellar', organization: 'natural', palette: 'monochrome',
      temperature: 'balanced', theme: 'dark', lodBand: 'micro', reducedMotion: false };
    for (let frame = 0; frame < 100; frame++) createRenderVisualState(graph, invalidCamera);
    assert.throws(() => assertVisualState(graph, invalidCamera));
    globals.location = { search: '?debugContracts=1' };
    assert.throws(() => createEngineGraphView(graph, { fast: true }), /pinned register/);
    assert.throws(() => createRenderVisualState(graph, invalidCamera));
  } finally {
    if (oldWindow === undefined) delete globals.window; else globals.window = oldWindow;
    if (oldLocation === undefined) delete globals.location; else globals.location = oldLocation;
  }
});

test('soma lobe integration is reused across 100 zoom steps and a matching remount', t => {
  const args: Parameters<typeof buildMorphologyGeometry> = ['neural', [
    { id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 4 },
    { id: 'b', position: { x: 20, y: 0, z: 0 }, radius: 4 },
  ], [{ id: 'edge', source: 'a', target: 'b', width: 1 }], [], 1, []];
  const geometry = buildMorphologyGeometry(...args);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map() };
  const before = readNeuralShapeCacheStats();
  const began = performance.now();
  for (let i = 0; i < 100; i++) {
    const scale = 1 + i / 100;
    const frames = neuralSomaFrames(geometry,
      point => ({ x: 100 + point.x * scale, y: 200 + point.y * scale, scale }),
      style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE);
    assert.equal(frames.size, 2);
  }
  const after = readNeuralShapeCacheStats();
  t.diagnostic(`soma zoom microbenchmark: 100 projections in ${(performance.now() - began).toFixed(1)} ms; ${after.lobeHits - before.lobeHits} lobe cache hits, ${after.lobeMisses - before.lobeMisses} misses`);
  assert.ok(after.lobeHits - before.lobeHits >= 190);
  assert.ok(after.lobeMisses - before.lobeMisses <= 10);
  const remount = buildMorphologyGeometry(...structuredClone(args));
  neuralSomaFrames(remount, point => ({ x: 100 + point.x, y: 200 + point.y, scale: 1 }),
    style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE);
  assert.equal(readNeuralShapeCacheStats().lobeMisses, after.lobeMisses);
});

test('an unchanged 2D camera never asks Sigma to reprocess its graph', async () => {
  const globals = globalThis as unknown as { WebGL2RenderingContext?: unknown; WebGLRenderingContext?: unknown };
  globals.WebGL2RenderingContext ??= { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
    UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 };
  globals.WebGLRenderingContext ??= { TRIANGLES: 9 };
  const { restoreCameraState } = await import('../src/render2d/index.ts');
  const state = { x: 0, y: 0, angle: 0, ratio: 1,
    bounds: { x: [-1, 1] as const, y: [-1, 1] as const } };
  let refreshes = 0, cameraUpdates = 0, bboxUpdates = 0;
  let current = { ...state };
  const sigma = {
    getCustomBBox: () => state.bounds,
    getCamera: () => ({ getState: () => current,
      setState: (next: typeof state) => { cameraUpdates++; current = next; } }),
    setCustomBBox: () => { bboxUpdates++; },
    refresh: () => { refreshes++; },
  } as unknown as Parameters<typeof restoreCameraState>[0];
  for (let frame = 0; frame < 100; frame++) restoreCameraState(sigma, state);
  assert.deepEqual([refreshes, cameraUpdates, bboxUpdates], [0, 0, 0]);
  restoreCameraState(sigma, { ...state, x: 1 });
  assert.deepEqual([refreshes, cameraUpdates, bboxUpdates], [0, 1, 0]);
  restoreCameraState(sigma, { ...state, x: 1, bounds: { x: [-2, 2] as const, y: [-1, 1] as const } });
  assert.deepEqual([refreshes, cameraUpdates, bboxUpdates], [1, 1, 1]);
});
