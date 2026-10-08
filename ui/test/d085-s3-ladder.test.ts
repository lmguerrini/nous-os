import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityLadder, labDrawPolicy, labMainSegmentRanges, labPixelRatio } from '../src/render-common/quality-ladder.ts';
import { currentRenderReadiness, renderPercent, reportRenderReadiness } from '../src/review/render-readiness.ts';
import { preserveRenderProgress, withRenderProgress } from '../src/review/toolbar-status.ts';
import { formatHud, hudMeasurementActive } from '../src/review/perf-hud.ts';
import * as THREE from 'three';
import { updateAggregateProjectionUniforms } from '../src/render3f/aggregate-material.ts';
import { updateFilamentProjectionUniforms } from '../src/render3f/filament-material.ts';
import { updateNodeProjectionUniforms } from '../src/render3f/node-material.ts';

// D085-S3 BEGIN
test('Lab 3D stages retain anchor and real structural ribbons before progressively restoring all geometry', () => {
  assert.deepEqual(labDrawPolicy(1), { nodes: 'anchors', semanticEdges: 'main', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(2), { nodes: 'all', semanticEdges: 'main', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(3), { nodes: 'all', semanticEdges: 'all', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(4), { nodes: 'all', semanticEdges: 'all', visualEdges: true, decor: true });
  assert.deepEqual(labMainSegmentRanges([6, 18, 24, 30], ['semantic:root', 'semantic:leaf',
    'semantic:root', 'visual:guide'], new Set(['semantic:root'])), {
    ranges: [[0, 6], [18, 24]], relationIds: new Set(['semantic:root']), vertices: 12,
  });
});

test('100 percent and complete phase require the full requested draw tier', () => {
  const full = {
    frame: 1, view: 'lab/3d/julia/complete', origin: 'renderer' as const,
    quality: 'completa' as const, ladder: 4 as const,
    nodes: { required: 20, loaded: 20, drawn: 20 },
    mainEdges: { required: 4, loaded: 4, drawn: 4 },
    allEdges: { required: 30, loaded: 30, drawn: 30 },
    decor: { labels: true, background: true, glow: true, animation: true },
  };
  assert.equal(renderPercent(full), 100);
  assert.ok(renderPercent({ ...full, origin: 'preparation' }) < 100);
  reportRenderReadiness({ ...full, origin: 'preparation' });
  assert.equal(currentRenderReadiness()?.quality, 'recupero');
  assert.ok(renderPercent({ ...full, quality: 'movimento', ladder: 1 }) < 100);
  assert.ok(renderPercent({ ...full, quality: 'recupero', ladder: 3 }) < 100);
  assert.ok(renderPercent({ ...full, nodes: { ...full.nodes, drawn: 19 } }) < 100);
  assert.ok(renderPercent({ ...full, allEdges: { ...full.allEdges, drawn: 29 } }) < 100);
});

test('Lab ladder schedules no frame or timeout after the final restoration', () => {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const states: string[] = [];
  let restorationDraws = 0;
  const ladder = new QualityLadder(state => {
    states.push(`${state.stage}:${state.moving}`);
    if (!state.moving) restorationDraws++;
  },
    () => now,
    (callback, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    timer => { timers.delete(timer as unknown as number); });
  ladder.touch();
  for (const at of [80, 160, 320]) {
    now = at;
    const due = [...timers].filter(([, timer]) => timer.at <= now);
    for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
  }
  assert.deepEqual(states, ['1:true', '2:false', '3:false', '4:false']);
  assert.equal(timers.size, 0);
  now = 5_000;
  assert.equal(restorationDraws, 3);
  assert.equal(timers.size, 0);
  ladder.destroy();
});

test('Lab buffer ratio stays low through interaction and restores exactly before full quality', () => {
  assert.deepEqual([1, 2, 3, 4].map(stage => labPixelRatio(stage as 1 | 2 | 3 | 4, 1.5)),
    [1, 1, 1.5, 1.5]);
  assert.deepEqual([1, 2, 3, 4].map(stage => labPixelRatio(stage as 1 | 2 | 3 | 4, 0.8)),
    [0.8, 0.8, 0.8, 0.8]);
  const full = {
    frame: 1, view: 'lab/3d/julia/complete', origin: 'renderer' as const,
    quality: 'completa' as const, ladder: 4 as const,
    pixelRatio: 1.5, fullPixelRatio: 1.5,
    nodes: { required: 2, loaded: 2, drawn: 2 },
    mainEdges: { required: 2, loaded: 2, drawn: 2 },
    allEdges: { required: 2, loaded: 2, drawn: 2 },
    decor: { labels: true, background: true, glow: true, animation: true },
  };
  assert.equal(renderPercent(full), 100);
  assert.ok(renderPercent({ ...full, pixelRatio: 1 }) < 100);
  assert.match(formatHud(null, [], undefined, { ...full, pixelRatio: 1 }), /pixel 1× \/ 1,5×/);
  assert.equal(hudMeasurementActive(true, { quality: 'recupero' }, full), false);
  assert.equal(hudMeasurementActive(true, { quality: 'completa' },
    { ...full, quality: 'movimento', ladder: 1, pixelRatio: 1 }), true);
});

test('node, filament, and aggregate projection uniforms use one actual buffer ratio', () => {
  const common = { u_resolutionDevicePx: { value: new THREE.Vector2() }, u_devicePixelRatio: { value: 0 } };
  const material = (extra: Record<string, { value: unknown }> = {}) =>
    new THREE.RawShaderMaterial({ uniforms: { ...common,
      u_resolutionDevicePx: { value: new THREE.Vector2() },
      u_devicePixelRatio: { value: 0 }, ...extra } });
  const aggregate = material();
  const filament = material({ u_sizeScale: { value: 0 }, u_isPerspective: { value: 0 },
    u_referenceViewDepth: { value: 0 } });
  const node = material({ u_orthographicSizeScale: { value: 0 }, u_isPerspective: { value: 0 },
    u_referenceViewDepth: { value: 0 }, u_nodeScaleCap: { value: 0 },
    u_denseNeuralPointFloorCssPx: { value: 0 } });
  for (const stage of [1, 4] as const) {
    const ratio = labPixelRatio(stage, 1.5);
    const resolution: [number, number] = [1440 * ratio, 1194 * ratio];
    updateAggregateProjectionUniforms(aggregate, resolution, ratio);
    updateFilamentProjectionUniforms(filament, { resolutionDevicePx: resolution,
      devicePixelRatio: ratio, sizeScale: 1, perspective: true, referenceViewDepth: 1 });
    updateNodeProjectionUniforms(node, { resolutionDevicePx: resolution,
      devicePixelRatio: ratio, orthographicSizeScale: 1, perspective: true,
      referenceViewDepth: 1, nodeScaleCap: 1 });
    for (const current of [aggregate, filament, node]) {
      assert.equal(current.uniforms.u_devicePixelRatio?.value, ratio);
      const vector = current.uniforms.u_resolutionDevicePx?.value as THREE.Vector2;
      assert.deepEqual([vector.x, vector.y], resolution);
    }
  }
  aggregate.dispose(); filament.dispose(); node.dispose();
});

test('the 3D toolbar phase follows the renderer witness through recovery and completion', () => {
  const previous = (globalThis as { window?: unknown }).window;
  let percent = 87;
  let quality: 'recupero' | 'completa' = 'recupero';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __d082: { render: () => ({ view: 'natural/3d/stellar/complete', quality }),
      renderPercent: () => percent },
  } });
  try {
    assert.equal(withRenderProgress('Nodi 20 visibili', 100), 'Nodi 20 visibili · Render 87% · Recupero');
    percent = 100;
    quality = 'completa';
    assert.equal(preserveRenderProgress('Nodi 20 visibili', 'Nodi 20 visibili · Render 87% · Recupero'),
      'Nodi 20 visibili · Render 100% · Completa');
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});
// D085-S3 END
