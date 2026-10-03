import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DisclosureHistory, emptyDisclosure, v2Visible } from '../../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import { routeRelationsAfterLOD } from '../../src/review/relation-routing.ts';
import { emptyRevealState, stepReveal } from '../../src/review/reveal-controller.ts';

const node = (id: string, level: V2Node['level'], parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic',
  title: id, title_full: id, importance: { value: 1, components: {} }, size: .5,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});

test('a full window pages beyond the cap, retains ancestors, and every page is reversible', () => {
  const children = Array.from({ length: 23 }, (_, index) => node(`leaf:${String(index).padStart(2, '0')}`, 4, 'conversation'));
  const index: V2Index = { nodes: [node('root', 1, null), node('conversation', 3, 'root'), ...children], edges: [] };
  const state = emptyDisclosure(); state.expanded.add('root');
  assert.deepEqual(v2Visible(index, state, new Map(), 10).nodes.map(item => item.id), ['root', 'conversation']);
  state.expanded.add('conversation'); state.manualOrder.push('conversation');
  const union = new Set<string>();
  for (const count of [5, 10, 15, 20, 23]) {
    state.pages.set('conversation', count);
    const frame = v2Visible(index, state, new Map(), 10, 'conversation');
    assert.ok(frame.nodes.length <= 10);
    assert.ok(frame.nodes.some(item => item.id === 'conversation'));
    for (const item of frame.nodes) union.add(item.id);
  }
  assert.equal(union.size, index.nodes.length);
  state.pages.set('conversation', 5);
  assert.ok(v2Visible(index, state, new Map(), 10, 'conversation').nodes.some(item => item.id === 'leaf:00'));
});

test('attested reading excludes exploratory relations; exploratory reading adds permitted source relations', () => {
  const nodes = [node('a', 1, null), node('b', 1, null), node('c', 1, null)];
  const relations = [
    { id: 'attested', channel: 'semantic' as const, source: 'a', target: 'b', class: 'attested' as const, type: 'link' },
    { id: 'exploratory', channel: 'semantic' as const, source: 'a', target: 'c', class: 'exploratory' as const, type: 'analogy' },
  ];
  const base = { nodes, disclosedIds: new Set(nodes.map(item => item.id)),
    renderedNodeIds: new Set(nodes.map(item => item.id)), relations, budget: 3 };
  const attested = routeRelationsAfterLOD({ ...base, reading: 'attested' });
  const exploratory = routeRelationsAfterLOD({ ...base, reading: 'exploratory' });
  assert.deepEqual(attested.drawn.flatMap(edge => edge.sourceRelationIds), ['attested']);
  assert.deepEqual(new Set(exploratory.drawn.flatMap(edge => edge.sourceRelationIds)), new Set(['attested', 'exploratory']));
  assert.ok(attested.invariant.ok && exploratory.invariant.ok);
});

test('direct reveal reaches a late child after earlier pages fill the renderer', () => {
  const children = Array.from({ length: 1059 }, (_, index) => node(`leaf:${String(index).padStart(4, '0')}`, 4, 'conversation'));
  const index: V2Index = { nodes: [node('root', 1, null), node('conversation', 3, 'root'), ...children], edges: [] };
  const history = new DisclosureHistory();
  history.reveal('leaf:1058', index);
  assert.equal(history.state.manualOrder.at(-1), 'conversation');
  assert.ok(v2Visible(index, history.state).nodes.some(item => item.id === 'leaf:1058'));
});

test('settled zoom keeps admitting later children after the automatic window fills', () => {
  const children = Array.from({ length: 23 }, (_, index) => node(`leaf:${String(index).padStart(2, '0')}`, 4, 'conversation'));
  const index: V2Index = { nodes: [node('root', 1, null), node('conversation', 3, 'root'), ...children], edges: [] };
  const disclosure = emptyDisclosure(); disclosure.expanded.add('root');
  let previous = emptyRevealState();
  const reached = new Set<string>();
  for (const zoom of [3.8, 3.9, 4, 4.1, 4.2]) {
    const decision = stepReveal({ index, disclosure, zoom, settled: true, cursor: { x: 100, y: 100 },
      selectionId: null, focusId: null, viewport: { x: 0, y: 0, width: 200, height: 200 },
      positions: new Map([['root', { x: 110, y: 100 }], ['conversation', { x: 100, y: 100 }]]),
      previous, cap: 10, pageSize: 5 });
    for (const id of decision.disclosedIds) reached.add(id);
    assert.ok(decision.disclosedIds.length <= 10);
    previous = decision.state;
  }
  assert.equal(reached.size, index.nodes.length);
  const outward = stepReveal({ index, disclosure, zoom: 1.1, settled: true, cursor: null,
    selectionId: null, focusId: null, viewport: { x: 0, y: 0, width: 200, height: 200 },
    positions: new Map(), previous, cap: 10, pageSize: 5 });
  assert.equal(outward.disclosedIds.length, 2);
});
