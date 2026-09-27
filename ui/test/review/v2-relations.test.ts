import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coMembership, projectRelations } from '../../src/review/v2-relations.ts';
import type { V2Node } from '../../src/review/v2-core.ts';
import type { GraphEdge } from '../../src/review/graph-v2.ts';

const node = (id: string, level: V2Node['level'], parent: string | null, domains: string[] = []): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains, kind: 'synthetic', title: id, title_full: id,
  importance: { value: 0, components: {} }, size: 0, counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const nodes = [
  node('domain:a', 1, null), node('domain:b', 1, null), node('domain:c', 1, null),
  node('conversation:1', 3, 'domain:a', ['a', 'b']), node('conversation:2', 3, 'domain:a', ['a', 'b']),
  node('conversation:3', 3, 'domain:b', ['b', 'c']), node('proposal:1', 4, 'conversation:1'),
  node('proposal:2', 4, 'conversation:3'),
];
const edge = (id: string, source: string, target: string, kind: GraphEdge['class'], type = 'relates'): GraphEdge => ({
  id, source, target, class: kind, type, directed: true, evidence: [{ source_id: `source:${id}` }],
  ...(kind === 'exploratory' ? { explanation: 'Synthetic inference', status: 'exploratory/non-canonical' as const } : {}),
});
const edges = [
  edge('a', 'proposal:1', 'proposal:2', 'attested'),
  edge('b', 'conversation:1', 'conversation:3', 'attested'),
  edge('c', 'proposal:1', 'proposal:2', 'exploratory', 'analogy'),
  edge('d', 'proposal:1', 'domain:b', 'attested', 'mentions'),
  edge('e', 'conversation:1', 'domain:b', 'attested', 'classified_in'),
];

test('co-membership counts conversations once per domain pair', () => {
  const visible = new Set(['domain:a', 'domain:b', 'domain:c']);
  const pairs = coMembership(nodes, visible);
  assert.deepEqual(pairs.map(item => [item.source, item.target, item.count]), [
    ['domain:a', 'domain:b', 2], ['domain:b', 'domain:c', 1],
  ]);
  assert.ok(pairs[0]!.width > pairs[1]!.width);
});

test('lifting merges underlying evidence and applies readings after aggregation', () => {
  const visible = new Set(['domain:a', 'domain:b', 'domain:c']);
  const attested = projectRelations(nodes, edges, visible, 'attested', 'flat');
  assert.equal(attested.edges.filter(item => item.class === 'exploratory').length, 0);
  const lifted = attested.edges.find(item => item.type === 'co_membership' && item.source === 'domain:a');
  assert.deepEqual(lifted?.underlying.map(item => item.id), ['a', 'b']);
  assert.equal(lifted?.count, 2);
  assert.equal(attested.edges.some(item => item.underlying.some(source => source.id === 'd' || source.id === 'e')), false);
  const exploratory = projectRelations(nodes, edges, visible, 'exploratory', 'flat');
  assert.ok(exploratory.edges.some(item => item.class === 'exploratory' && item.underlying[0]?.id === 'c'));
  const all = projectRelations(nodes, edges, visible, 'combined', 'flat', 'all');
  assert.ok(all.edges.some(item => item.underlying.some(source => source.id === 'd')));
});

test('Indra hides chords until active or all-relations mode', () => {
  const visible = new Set(['domain:a', 'domain:b']);
  assert.equal(projectRelations(nodes, edges, visible, 'exploratory', 'indra').edges.length, 0);
  const active = projectRelations(nodes, edges, visible, 'exploratory', 'indra', 'essential', 'domain:a');
  assert.ok(active.edges.some(item => item.class === 'exploratory'));
  const all = projectRelations(nodes, edges, visible, 'combined', 'indra', 'all');
  assert.ok(all.edges.some(item => item.underlying.some(source => source.id === 'd')));
  assert.ok(active.edges.every(item => item.underlying.every(source => source.id !== 'd')));
});
