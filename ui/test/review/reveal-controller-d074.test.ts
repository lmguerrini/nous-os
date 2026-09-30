import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyRevealState, stepReveal } from '../../src/review/reveal-controller.ts';
import type { RevealState } from '../../src/review/reveal-controller.ts';
import { emptyDisclosure, v2Visible } from '../../src/review/v2-core.ts';
import type { V2Node, V2Index } from '../../src/review/v2-core.ts';

const node = (id: string, level: V2Node['level'], parent: string | null, passages = 0): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic', title: id, title_full: id,
  importance: { value: 0, components: {} }, size: 0,
  counts: { children: 0, descendants: 0, canon: 0, passages },
});
function hierarchy(): V2Index {
  const nodes = [node('a', 1, null), node('b', 1, null), node('a-p', 2, 'a'), node('b-p', 2, 'b')];
  for (const root of ['a', 'b']) for (let i = 0; i < 5; i++) {
    const conversation = `${root}-c${i}`;
    nodes.push(node(conversation, 3, `${root}-p`));
    for (let j = 0; j < 6; j++) nodes.push(node(`${conversation}-q${j}`, 4, conversation, 3));
  }
  return { nodes, edges: [] };
}
const disclosure = emptyDisclosure();
disclosure.expanded.add('a'); disclosure.expanded.add('b');
const positions = new Map([
  ['a', { x: 80, y: 100, radius: 22 }], ['a-p', { x: 100, y: 100, radius: 22 }],
  ['b', { x: 800, y: 100, radius: 22 }], ['b-p', { x: 820, y: 100, radius: 22 }],
]);
const viewport = { x: 0, y: 0, width: 1000, height: 600 };
const advance = (index: V2Index, previous: RevealState, zoom: number, overrides: object = {}) =>
  stepReveal({ index, disclosure, previous, zoom, settled: true, cursor: { x: 100, y: 100 },
    selectionId: null, focusId: null, positions, viewport, ...overrides });

test('four settled inward thresholds monotonically admit the cursor cluster, with one page each', () => {
  const index = hierarchy();
  let state = emptyRevealState();
  let prior = new Set<string>();
  const sizes: number[] = [];
  for (const zoom of [2, 2.7, 3.8, 5]) {
    const result = advance(index, state, zoom, { pageSize: 2 });
    const focused = new Set(result.disclosedIds.filter(id => id.startsWith('a-')));
    for (const id of prior) assert.ok(focused.has(id), `${id} disappeared at ${zoom}`);
    assert.ok(result.admittedIds.length > 0 && result.admittedIds.length <= 2);
    assert.equal(result.state.focusClusterId, 'a');
    assert.equal(result.state.focusSource, 'cursor');
    assert.equal(result.state.epoch, 1);
    sizes.push(focused.size); prior = focused; state = result.state;
  }
  assert.deepEqual(sizes, [3, 5, 7, 9]);
  assert.ok(prior.has('a-c0-q0'));
});

test('outward changes inside the hysteresis band preserve admissions; lower crossing compacts', () => {
  const index = hierarchy();
  const inward = advance(index, emptyRevealState(), 5, { pageSize: 2 });
  const jitter = advance(index, inward.state, 4.4, { pageSize: 2 });
  assert.deepEqual(jitter.disclosedIds, inward.disclosedIds);
  const outward = advance(index, jitter.state, 4.1, { pageSize: 2 });
  assert.ok(outward.disclosedIds.length < jitter.disclosedIds.length);
  assert.equal(outward.state.epoch, 1);
});

test('budget evicts other-cluster automatic pages, retaining selected and manual paths', () => {
  const index = hierarchy();
  const prior = { ...emptyRevealState(), lastZoom: 1, tier: -1, admissions: [
    { parentId: 'b-p', count: 3, threshold: 0, clusterId: 'b', order: 0 },
  ] };
  const result = advance(index, prior, 2, { cap: 6, pageSize: 2 });
  assert.deepEqual(result.evictedParentIds, ['b-p']);
  assert.ok(result.auto.has('a-p'));
  assert.ok(!result.auto.has('b-p'));
  assert.ok(result.disclosedIds.includes('a-p') && result.disclosedIds.includes('b-p'));
  assert.ok(result.disclosedIds.length <= 6);
  const manual = emptyDisclosure(); manual.expanded.add('a'); manual.expanded.add('b');
  manual.manualOrder.push('b-p'); manual.expanded.add('b-p');
  const protectedResult = advance(index, prior, 2, { cap: 6, pageSize: 2, disclosure: manual, selectionId: 'b-c0' });
  assert.ok(protectedResult.disclosedIds.includes('b-c0'));
  assert.ok(!protectedResult.evictedParentIds.includes('b-p'));
});

test('deep threshold requests level-5 passages and later admits fetched children without another zoom', () => {
  const index = hierarchy();
  let state = emptyRevealState();
  for (const zoom of [2, 2.7, 3.8, 5]) state = advance(index, state, zoom, { pageSize: 2 }).state;
  const deep = advance(index, state, 6.6, { pageSize: 2 });
  assert.deepEqual(deep.passageRequests, ['a-c0-q0']);
  assert.deepEqual(deep.state.pendingPassages, ['a-c0-q0']);
  const loaded = { ...index, nodes: [...index.nodes, node('passage-0', 5, 'a-c0-q0'), node('passage-1', 5, 'a-c0-q0')] };
  const fetched = advance(loaded, deep.state, 6.6, { pageSize: 2 });
  assert.deepEqual(fetched.passageRequests, []);
  assert.ok(fetched.disclosedIds.includes('passage-0'));
  assert.equal(fetched.state.pendingPassages.length, 0);
  assert.equal(v2Visible(loaded, disclosure, fetched.auto).counts[5], 2);
  const nextPage = advance(loaded, fetched.state, 8.1, { pageSize: 2 });
  assert.deepEqual(nextPage.passageRequests, ['a-c0-q0']);
  const complete = { ...loaded, nodes: [...loaded.nodes, node('passage-2', 5, 'a-c0-q0')] };
  const last = advance(complete, nextPage.state, 8.1, { pageSize: 2 });
  assert.ok(last.disclosedIds.includes('passage-2'));
});

test('unsettled camera samples do not consume a threshold', () => {
  const index = hierarchy();
  const moving = advance(index, emptyRevealState(), 2, { settled: false });
  assert.equal(moving.admittedIds.length, 0);
  assert.equal(moving.state.lastZoom, 1);
  const settled = advance(index, moving.state, 2);
  assert.ok(settled.admittedIds.length > 0);
});
