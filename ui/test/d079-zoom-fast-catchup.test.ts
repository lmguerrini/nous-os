import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVEAL_THRESHOLDS, autoPages, emptyRevealState, focusOnlyReveal, stepReveal } from '../src/review/reveal-controller.ts';
import { emptyDisclosure, v2Visible } from '../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../src/review/v2-core.ts';

const node = (id: string, level: V2Node['level'], parent: string | null, passages = 0): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic',
  title: id, title_full: id, importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages },
});
const viewport = { x: 0, y: 0, width: 1000, height: 600 };
const positions = new Map([
  ['a', { x: 80, y: 100, radius: 24 }], ['a-project', { x: 120, y: 100, radius: 20 }],
  ['a-near', { x: 100, y: 100, radius: 18 }], ['a-far', { x: 410, y: 100, radius: 18 }],
  ['b', { x: 800, y: 100, radius: 24 }], ['b-project', { x: 820, y: 100, radius: 20 }],
]);
const index: V2Index = { nodes: [
  node('a', 1, null), node('a-project', 2, 'a'), node('a-near', 3, 'a'), node('a-far', 3, 'a'),
  node('a-near-proposal', 4, 'a-near', 2), node('a-far-proposal', 4, 'a-far', 2),
  node('b', 1, null), node('b-project', 2, 'b'), node('b-source', 3, 'b'),
  node('b-proposal', 4, 'b-source', 2),
], edges: [] };
const disclosure = emptyDisclosure();
disclosure.expanded.add('a'); disclosure.expanded.add('b');
const input = (previous = emptyRevealState(), zoom = 8, overrides: object = {}) => ({
  index, disclosure, previous, zoom, settled: true, cursor: { x: 100, y: 100 },
  selectionId: 'b-project', focusId: 'b-project', viewport, positions, pageSize: 2, ...overrides,
});

test('one deep settled sample follows the pointer through an unplaced level 4 and requests level 5', () => {
  const fast = stepReveal(input());
  assert.equal(fast.state.focusClusterId, 'a');
  assert.deepEqual(fast.state.catchUp, { from: -1, to: REVEAL_THRESHOLDS.length - 1,
    admissions: fast.state.admissions.length });
  assert.ok(fast.state.admissions.length > 1 && fast.state.admissions.length <= REVEAL_THRESHOLDS.length);
  assert.ok(fast.disclosedIds.includes('a-near-proposal'));
  assert.ok(fast.passageRequests.includes('a-near-proposal'));
  assert.ok(fast.state.pendingPassages.includes('a-near-proposal'));
  assert.ok(fast.state.admissions.every(item => item.clusterId === 'a' && item.count <= 2));
  assert.ok(!fast.disclosedIds.includes('b-proposal'));

  let slow = emptyRevealState();
  for (const zoom of [2, 2.7, 3.8, 5, 6.6, 8]) slow = stepReveal(input(slow, zoom)).state;
  const slowIds = v2Visible(index, disclosure, autoPages(slow.admissions)).nodes.map(item => item.id);
  assert.ok(slowIds.includes('a-near-proposal'));
  assert.ok(fast.disclosedIds.filter(id => id.endsWith('-proposal')).every(id => slowIds.includes(id)));
  assert.ok(slow.pendingPassages.includes('a-near-proposal'));

  const loaded = { ...index, nodes: [...index.nodes, node('a-near-passage', 5, 'a-near-proposal')] };
  const fetched = stepReveal(input(fast.state, 8, { index: loaded }));
  assert.ok(fetched.disclosedIds.includes('a-near-passage'));
  assert.equal(fetched.state.catchUp?.to, REVEAL_THRESHOLDS.length - 1);
});

test('one crossed threshold admits one page; stationary, unsettled, and outward samples do not admit', () => {
  const collapsed = emptyDisclosure();
  collapsed.overview = true;
  const first = stepReveal(input(emptyRevealState(), 2, { disclosure: collapsed }));
  assert.equal(first.state.admissions.length, 1);
  assert.equal(first.state.catchUp, null);
  const stationary = stepReveal(input(first.state, 2, { disclosure: collapsed }));
  assert.equal(stationary.state.admissions.length, 1);
  assert.equal(focusOnlyReveal(first.state, stationary.state).admissions.length, 1);
  const moving = stepReveal(input(first.state, 8, { disclosure: collapsed, settled: false }));
  assert.equal(moving.state.admissions.length, 1);
  const fast = stepReveal(input(first.state, 8, { disclosure: collapsed }));
  const outward = stepReveal(input(fast.state, 1.1, { disclosure: collapsed }));
  assert.equal(outward.state.admissions.length, 0);
  assert.equal(outward.state.catchUp, null);
});

test('fast catch-up respects the global cap and evicts only older off-cluster pages', () => {
  const previous = { ...emptyRevealState(), admissions: [
    { parentId: 'b-project', count: 1, threshold: 0, clusterId: 'b', order: 0 },
  ] };
  const fast = stepReveal(input(previous, 8, { cap: 7, pageSize: 1, selectionId: null, focusId: null }));
  assert.ok(fast.disclosedIds.length <= 7);
  assert.ok(fast.state.admissions.filter(item => item.order > 0).every(item => item.clusterId === 'a'));
  assert.ok(fast.state.catchUp && fast.state.catchUp.admissions <= REVEAL_THRESHOLDS.length);
  assert.ok(fast.evictedParentIds.every(id => id === 'b-project'));
  assert.ok(fast.state.admissions.every(item => item.count <= 1));
});
