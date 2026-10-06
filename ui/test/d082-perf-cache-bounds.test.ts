import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneCache } from '../src/render-common/scene-cache.ts';
import { geometryPrepStats, incrementalNeuralGeometry } from '../src/render-common/prep-worker.ts';
import { cachedStarfieldStars, starfieldCacheOccupancy, resetStarfieldCache } from '../src/render-common/starfield.ts';
import { PageResultCache } from '../src/projection/page-result-cache.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import type { MorphologyInput } from '../src/engine/morphology-geometry.ts';
import { neuralSomaFrames, neuralShapeCacheOccupancy, readNeuralShapeCacheStats,
  somaOutlineRadiusAtAngle } from '../src/render-common/morphology-canvas.ts';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { sceneBufferCacheStats } from '../src/render3f/buffers.ts';
import { somaLobeAreaScale } from '../src/engine/morphology-geometry.ts';
import type { NeuralSomaFrame } from '../src/render-common/morphology-canvas.ts';

test('100 synthetic mode switches keep scene and projection caches within byte limits', () => {
  const scenes = new SceneCache<{ bytes: Uint8Array }>(8, 64 * 1024);
  const layouts = new PageResultCache<{ positions: Float64Array }>(8, 64 * 1024);
  for (let switchIndex = 0; switchIndex < 100; switchIndex++) {
    scenes.set(`scene-${switchIndex}`, { bytes: new Uint8Array(16 * 1024) });
    layouts.set(`layout-${switchIndex}`, { positions: new Float64Array(2048) });
    assert.ok(scenes.stats.estimatedBytes <= scenes.stats.byteLimit);
    assert.ok(layouts.stats.estimatedBytes <= layouts.stats.byteLimit);
  }
  assert.ok(scenes.stats.size <= 4);
  assert.ok(layouts.stats.entries <= 4);
  assert.equal(scenes.get('scene-0'), undefined);
  assert.equal(layouts.get('layout-0'), undefined);
  assert.ok(scenes.get('scene-99'));
  assert.ok(layouts.get('layout-99'));
  const productionScene = new SceneCache<{ bytes: Uint8Array }>();
  const productionLayout = new PageResultCache<{ positions: Float64Array }>();
  resetStarfieldCache();
  for (let switchIndex = 0; switchIndex < 100; switchIndex++) {
    productionScene.set(`scene-${switchIndex}`, { bytes: new Uint8Array(1024 * 1024) });
    productionLayout.set(`layout-${switchIndex}`, { positions: new Float64Array(16 * 1024) });
    cachedStarfieldStars(600 + switchIndex, 400, 0.2);
  }
  assert.ok(productionScene.stats.estimatedBytes <= productionScene.stats.byteLimit);
  assert.ok(productionLayout.stats.estimatedBytes <= productionLayout.stats.byteLimit);
  assert.ok(starfieldCacheOccupancy().estimatedBytes <= starfieldCacheOccupancy().byteLimit);
  assert.ok(starfieldCacheOccupancy().entries <= starfieldCacheOccupancy().entryLimit);
  assert.ok(geometryPrepStats().size <= 2);
  assert.ok(geometryPrepStats().estimatedBytes <= geometryPrepStats().byteLimit);
  assert.ok(sceneBufferCacheStats().size <= 2);
  assert.ok(sceneBufferCacheStats().estimatedBytes <= sceneBufferCacheStats().byteLimit);
});

test('Neural lobe preparation remains reusable when zoom changes soma radius', () => {
  const geometry = buildMorphologyGeometry('neural', [
    { id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 4 },
    { id: 'b', position: { x: 20, y: 0, z: 0 }, radius: 4 },
  ], [{ id: 'ab', source: 'a', target: 'b', width: 1 }]);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map() };
  const before = readNeuralShapeCacheStats();
  for (let zoomStep = 0; zoomStep < 100; zoomStep++) {
    const scale = 1 + zoomStep / 15;
    neuralSomaFrames(geometry,
      point => ({ x: point.x * scale, y: point.y * scale, scale }),
      style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE);
  }
  const after = readNeuralShapeCacheStats();
  assert.ok(after.lobeHits - before.lobeHits >= 190);
  assert.ok(after.lobeMisses - before.lobeMisses <= 10);
  const occupancy = neuralShapeCacheOccupancy();
  assert.ok(occupancy.lobes <= occupancy.entryLimit);
  assert.ok(occupancy.silhouettes <= occupancy.entryLimit);
  assert.ok(occupancy.lobeBytes <= occupancy.byteLimit);
  assert.ok(occupancy.silhouetteBytes <= occupancy.byteLimit);
});

test('3D camera roll reuses dimensionless soma shape and moving tier skips integration', () => {
  const geometry = buildMorphologyGeometry('neural', [
    { id: 'roll-a', position: { x: -10, y: 0, z: 0 }, radius: 4 },
    { id: 'roll-b', position: { x: 10, y: 0, z: 0 }, radius: 4 },
  ], [{ id: 'roll-edge', source: 'roll-a', target: 'roll-b', width: 1 }]);
  const style = { fieldColor: '#000', nodes: new Map(), edges: new Map() };
  const before = readNeuralShapeCacheStats();
  let first: ReturnType<typeof neuralSomaFrames> | null = null;
  for (let step = 0; step < 80; step++) {
    const angle = step * Math.PI / 160;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const frames = neuralSomaFrames(geometry, point => ({ x: point.x * cos - point.y * sin,
      y: point.x * sin + point.y * cos, scale: 1 }),
    style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, '3d');
    if (step === 0) first = frames;
    if (step === 79) for (const [id, frame] of frames) {
      const base = first!.get(id)!;
      for (let sample = 0; sample < 64; sample++) {
        const polar = sample * Math.PI / 32;
        assert.ok(Math.abs(somaOutlineRadiusAtAngle(frame, polar + angle)
          - somaOutlineRadiusAtAngle(base, polar)) < 0.001);
      }
    }
  }
  const after = readNeuralShapeCacheStats();
  assert.ok(after.lobeHits - before.lobeHits >= 150);
  assert.ok(after.lobeMisses - before.lobeMisses <= 10);
  for (let step = 0; step < 80; step++) {
    const angle = step * Math.PI / 160;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const frames = neuralSomaFrames(geometry, point => ({ x: point.x * cos - point.y * sin,
      y: point.x * sin + point.y * cos, scale: 1 }),
    style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, '3d', true);
    for (const frame of frames.values()) {
      assert.equal(frame.lobes?.length, 0);
      assert.equal(frame.lobeAreaScale, 1);
    }
  }
  assert.equal(readNeuralShapeCacheStats().lobeMisses, after.lobeMisses);
  const occupancy = neuralShapeCacheOccupancy();
  assert.ok(occupancy.lobeBytes + occupancy.silhouetteBytes <= 8 * 1024 * 1024);
});

test('1e-3 quantised shape key stays within a measured 100 px outline error', t => {
  const base: NeuralSomaFrame = { x: 0, y: 0, radius: 100, angle: 0.483,
    eccentricity: 1.73, harmonics: [], spindle: true, leaf: false,
    lobes: [{ angle: 0.21, strength: 0.4 }, { angle: 2.1, strength: 0.36 },
      { angle: -1.4, strength: 0.3 }] };
  const area = (frame: NeuralSomaFrame) => somaLobeAreaScale(frame.lobes ?? [],
    angle => somaOutlineRadiusAtAngle({ ...frame, lobes: [] }, angle));
  let maximum = 0;
  for (const sign of [-1, 1]) {
    const shifted: NeuralSomaFrame = { ...base, angle: base.angle + sign * 0.000499,
      eccentricity: base.eccentricity + sign * 0.000499,
      lobes: base.lobes!.map(lobe => ({ angle: lobe.angle + sign * 0.000499,
        strength: lobe.strength + sign * 0.000499 })) };
    const exact = { ...shifted, lobeAreaScale: area(shifted) };
    const cached = { ...shifted, lobeAreaScale: area(base) };
    for (let i = 0; i < 720; i++) {
      const angle = 2 * Math.PI * i / 720;
      maximum = Math.max(maximum, Math.abs(somaOutlineRadiusAtAngle(exact, angle)
        - somaOutlineRadiusAtAngle(cached, angle)));
    }
  }
  t.diagnostic(`maximum sampled cache-normalisation error at 100 px: ${maximum.toFixed(4)} px`);
  assert.ok(maximum < 0.5);
});

test('incremental Neural reveal and removal match a full geometry build', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`,
    position: { x: i * 8, y: (i % 5) * 11, z: i % 3 }, radius: 3 + i % 4 }));
  const edges = Array.from({ length: 23 }, (_, i) => ({ id: `e${i}`,
    source: `n${i}`, target: `n${i + 1}`, width: 1 }));
  const input = (count: number): MorphologyInput => ({ nodes: nodes.slice(0, count),
    edges: edges.slice(0, count - 1), colonies: [], containers: [] });
  let before = input(8);
  let previous = buildMorphologyGeometry('neural', before.nodes, before.edges);
  for (const count of [9, 10, 13, 17, 24, 15, 8, 19]) {
    const after = input(count);
    const incremental = incrementalNeuralGeometry(previous, before, after, 1);
    const exact = buildMorphologyGeometry('neural', after.nodes, after.edges);
    assert.deepEqual(incremental, exact);
    if (count > 13) assert.equal(incremental.nodes[0], previous.nodes[0]);
    previous = incremental;
    before = after;
  }
});

test('incremental Neural geometry equals a full build across incident changes', () => {
  const initial: MorphologyInput = {
    nodes: [
      { id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 3 },
      { id: 'b', position: { x: 10, y: 0, z: 0 }, radius: 4 },
      { id: 'c', position: { x: 20, y: 0, z: 0 }, radius: 5 },
      { id: 'd', position: { x: 30, y: 8, z: 0 }, radius: 3 },
    ],
    edges: [{ id: 'ab', source: 'a', target: 'b', width: 1 },
      { id: 'bc', source: 'b', target: 'c', width: 2 },
      { id: 'cd', source: 'c', target: 'd', width: 1 }],
    colonies: [], containers: [],
  };
  let before = initial;
  let previous = buildMorphologyGeometry('neural', before.nodes, before.edges);
  const cases: [string, (input: MorphologyInput) => MorphologyInput][] = [
    ['move endpoint', input => ({ ...input, nodes: input.nodes.map(n => n.id === 'a'
      ? { ...n, position: { x: 0, y: 10, z: 0 } } : n) })],
    ['change radius', input => ({ ...input, nodes: input.nodes.map(n => n.id === 'b'
      ? { ...n, radius: 7 } : n) })],
    ['change width', input => ({ ...input, edges: input.edges.map(e => e.id === 'bc'
      ? { ...e, width: 3 } : e) })],
    ['rewire', input => ({ ...input, edges: input.edges.map(e => e.id === 'cd'
      ? { ...e, source: 'a' } : e) })],
    ['remove edge and node', input => ({ ...input, nodes: input.nodes.filter(n => n.id !== 'd'),
      edges: input.edges.filter(e => e.id !== 'cd') })],
  ];
  for (const [name, change] of cases) {
    const after = change(before);
    const next = incrementalNeuralGeometry(previous, before, after, 1);
    assert.deepEqual(next, buildMorphologyGeometry('neural', after.nodes, after.edges), name);
    before = after; previous = next;
  }
});
