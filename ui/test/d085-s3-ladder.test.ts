import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityLadder, labDrawPolicy, labMainSegmentRanges } from '../src/render-common/quality-ladder.ts';
import { currentRenderReadiness, renderPercent, reportRenderReadiness } from '../src/review/render-readiness.ts';
import { preserveRenderProgress, withRenderProgress } from '../src/review/toolbar-status.ts';

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
  const ladder = new QualityLadder(state => { states.push(`${state.stage}:${state.moving}`); },
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
  ladder.destroy();
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
