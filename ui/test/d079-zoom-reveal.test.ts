import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraRevealZoom, emptyRevealState, revealBand, stepReveal } from '../src/review/reveal-controller.ts';
import { emptyDisclosure, v2Visible } from '../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../src/review/v2-core.ts';

const node = (id: string, level: V2Node['level'], parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic',
  title: id, title_full: id, importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const viewport = { x: 0, y: 0, width: 1000, height: 800 };

test('fit keeps all level-2 entries while direct level-3 sources are counted, then wheel reveals them', () => {
  const index: V2Index = { nodes: [node('domain', 1, null), node('project', 2, 'domain'),
    ...Array.from({ length: 80 }, (_, i) => node(`source:${String(i).padStart(3, '0')}`, 3, 'domain'))], edges: [] };
  const disclosure = emptyDisclosure(); disclosure.overview = true;
  const fit = v2Visible(index, disclosure);
  assert.deepEqual(fit.counts, { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 });
  assert.equal(fit.hidden.get('domain'), 80);
  const first = stepReveal({ index, disclosure, previous: emptyRevealState(), zoom: 2, settled: true,
    cursor: { x: 100, y: 100 }, selectionId: null, focusId: null, viewport,
    positions: new Map([['domain', { x: 100, y: 100, radius: 30 }], ['project', { x: 350, y: 100 }]]) });
  assert.equal(first.state.focusClusterId, 'domain');
  assert.ok(first.disclosedIds.includes('project'));
  assert.ok(first.disclosedIds.some(id => id.startsWith('source:')));
  assert.ok(first.disclosedIds.length <= 850);
});

test('2D and 3D camera ratios cross four reveal depths with hysteresis', () => {
  for (const dimension of ['2d', '3d'] as const) {
    const magnifications = [1, 2, 5, 8];
    const ratios = magnifications.map(value => dimension === '3d' ? 1 / Math.pow(value, 1 / 2.5) : 1 / value);
    let band: ReturnType<typeof revealBand> = 'far';
    const actual = ratios.map(ratio => band = revealBand(cameraRevealZoom(1, ratio, dimension), band));
    assert.deepEqual(actual, ['far', 'intermediate', 'near', 'deep']);
    assert.equal(revealBand(5.6, 'deep'), 'deep');
    assert.equal(revealBand(5.3, 'deep'), 'near');
  }
});

test('local cap pages into proposals and passages and compacts on outward zoom', () => {
  const nodes = [node('domain', 1, null), node('project', 2, 'domain'), node('source', 3, 'project'),
    ...Array.from({ length: 20 }, (_, i) => node(`proposal:${String(i).padStart(2, '0')}`, 4, 'source')),
    node('passage', 5, 'proposal:00')];
  const index: V2Index = { nodes, edges: [] };
  const disclosure = emptyDisclosure(); disclosure.overview = true;
  let previous = emptyRevealState();
  const seen = new Set<string>();
  const counts: number[] = [];
  const positions = new Map([['domain', { x: 100, y: 100 }], ['project', { x: 100, y: 100 }],
    ['source', { x: 100, y: 100 }], ['proposal:00', { x: 100, y: 100 }]]);
  for (const zoom of [2, 2.7, 3.8, 5, 6.6, 8]) {
    const result = stepReveal({ index, disclosure, previous, zoom, settled: true,
      cursor: { x: 100, y: 100 }, selectionId: null, focusId: null, viewport, positions,
      cap: 8, pageSize: 3 });
    previous = result.state;
    result.disclosedIds.forEach(id => seen.add(id));
    assert.ok(result.disclosedIds.length <= 8);
    assert.equal(result.state.focusClusterId, 'domain');
    counts.push(result.disclosedIds.filter(id => id.startsWith('proposal:') || id === 'passage').length);
  }
  assert.ok(counts.some(count => count > 0));
  assert.ok(seen.has('proposal:00'));
  assert.ok(seen.has('passage'), 'a crowded proposal page still reaches level 5');
  const out = stepReveal({ index, disclosure, previous, zoom: 1, settled: true,
    cursor: { x: 100, y: 100 }, selectionId: null, focusId: null, viewport, positions,
    cap: 8, pageSize: 3 });
  assert.ok(out.disclosedIds.length < previous.admissions.length + 3);
  assert.deepEqual(v2Visible(index, disclosure).counts, { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 });
});

test('each depth grows along one branch, shrinks back, and sub-notch jitter adds nothing', () => {
  const index: V2Index = { nodes: [node('domain', 1, null), node('project', 2, 'domain'),
    node('source', 3, 'project'), node('proposal', 4, 'source'), node('passage', 5, 'proposal')], edges: [] };
  const disclosure = emptyDisclosure(); disclosure.overview = true;
  let previous = emptyRevealState();
  const positions = new Map([['source', { x: 100, y: 100, radius: 24 }]]);
  const levels: number[][] = [];
  for (const zoom of [1, 2, 2.7, 3.8, 5]) {
    const decision = stepReveal({ index, disclosure, previous, zoom, settled: true,
      cursor: { x: 100, y: 100 }, selectionId: 'source', focusId: 'source', viewport, positions,
      minZoomStep: 1.08 });
    previous = decision.state;
    const shown = new Set(decision.disclosedIds);
    levels.push([1, 2, 3, 4, 5].map(level => index.nodes.filter(item => item.level === level && shown.has(item.id)).length));
  }
  for (let i = 1; i < levels.length; i++) for (let level = 0; level < 5; level++)
    assert.ok(levels[i]![level]! >= levels[i - 1]![level]!);
  assert.equal(levels.at(-1)![4], 1);
  const jitter = stepReveal({ index, disclosure, previous, zoom: 5.02, settled: true,
    cursor: { x: 100, y: 100 }, selectionId: 'source', focusId: 'source', viewport, positions,
    minZoomStep: 1.08 });
  assert.deepEqual(jitter.disclosedIds, stepReveal({ index, disclosure, previous, zoom: 5, settled: true,
    cursor: { x: 100, y: 100 }, selectionId: 'source', focusId: 'source', viewport, positions }).disclosedIds);
  const out = stepReveal({ index, disclosure, previous: jitter.state, zoom: 1, settled: true,
    cursor: null, selectionId: null, focusId: null, viewport, positions: new Map(), minZoomStep: 1.08 });
  assert.deepEqual(out.disclosedIds, ['domain', 'project']);
});
