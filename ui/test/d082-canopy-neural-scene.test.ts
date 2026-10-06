import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/scene/build.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { createVisualState } from '../src/engine/visual-state.ts';
import { buildSceneBuffers, sceneBufferCacheStats } from '../src/render3f/buffers.ts';
import { geometryPrepStats, prepareGeometry } from '../src/render-common/prep-worker.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';
import { canopyInitialFitNeedsSubsetRefresh, canopyEmphasisChanged,
  prepareCanopyDenseInStages } from '../src/fractal/canopy-neural-stages.ts';

test('D082 Canopy Neural 3D builds its complete fit scene once and bounds preparation stages', async () => {
  let completeBuilds = 0;
  completeBuilds++; // Initial full drawing for this data, density and morphology.
  if (canopyInitialFitNeedsSubsetRefresh('3d', 'neural', true)) completeBuilds++;
  assert.equal(completeBuilds, 1);
  assert.equal(canopyInitialFitNeedsSubsetRefresh('2d', 'neural', true), true);
  assert.equal(canopyInitialFitNeedsSubsetRefresh('3d', 'stellar', true), true);
  assert.equal(canopyInitialFitNeedsSubsetRefresh('3d', 'neural', false), true);
  assert.equal(canopyEmphasisChanged(null, null), false);
  assert.equal(canopyEmphasisChanged(new Set(['a']), new Set(['a'])), false);
  assert.equal(canopyEmphasisChanged(null, new Set(['a'])), true);
  assert.equal(canopyEmphasisChanged(new Set(['a']), new Set(['b'])), true);

  const order: string[] = [];
  const sample = { id: 'canopy:a', x: 0, y: 0, screenX: 0, screenY: 0,
    importance: 1, baseRadiusPx: 1 };
  const result = await prepareCanopyDenseInStages([sample],
    { zoomProgress: 0, screenDistanceNorm: new Map() }, [], {
      scales: async () => { order.push('worker'); return new Map([[sample.id,
        { id: sample.id, localDensity: 1, scale: 1, radiusPx: 1, representativeId: sample.id }]]); },
      edges: () => { order.push('edge-density'); return new Map(); },
      yieldTask: async () => { order.push('task-boundary'); },
    });
  assert.deepEqual(order, ['worker', 'task-boundary', 'edge-density', 'task-boundary']);
  assert.equal(result.scales.get(sample.id)?.radiusPx, 1);
});

test('D082 Canopy Neural 3D worker geometry has the exact GPU buffer input and output', async () => {
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, createVisualState(graph, {
    ...sceneVisualState(graph), morphology: 'neural',
  }));
  const neuralEdges = scene.edges.filter(edge => edge.filament.hotMixPermille > 0);
  assert.ok(neuralEdges.length > 0);
  const args = ['neural',
    scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),
    neuralEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx })),
  ] as const;
  const direct = buildSceneBuffers(scene);
  // Evict the direct result so the next call exercises the prepared input rather than a cache hit.
  for (let offset = 1; offset <= 3; offset++) buildSceneBuffers({ ...scene, nodes: scene.nodes.map((node, index) =>
    index === 0 ? { ...node, radiusPx: node.radiusPx + offset } : node) });
  const before = geometryPrepStats();
  const prepared = await prepareGeometry([...args]);
  assert.deepEqual(prepared, buildMorphologyGeometry(...args));
  assert.strictEqual(await prepareGeometry([...args]), prepared);
  assert.equal(geometryPrepStats().misses, before.misses + 1);
  const misses = sceneBufferCacheStats().misses;
  const fromWorker = buildSceneBuffers(scene, prepared);
  assert.equal(sceneBufferCacheStats().misses, misses + 1);
  assert.deepEqual(fromWorker, direct);
});
