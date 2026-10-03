import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRevealWitness, checkRouteInvariant, routeRelationsAfterLOD } from '../../src/review/relation-routing.ts';
import type { RouteNode, RouteRelation } from '../../src/review/relation-routing.ts';

const nodes: RouteNode[] = [
  { id: 'a', level: 1, parent: null }, { id: 'b', level: 1, parent: null },
  { id: 'a-p', level: 2, parent: 'a' }, { id: 'b-p', level: 2, parent: 'b' },
  { id: 'a-c', level: 3, parent: 'a-p' }, { id: 'b-c', level: 3, parent: 'b-p' },
  { id: 'a-q', level: 4, parent: 'a-c', passageCount: 3 },
  { id: 'a-s', level: 4, parent: 'a-c' },
  { id: 'b-q', level: 4, parent: 'b-c' },
  { id: 'a-k', level: 5, parent: 'a-q' },
];
const relation = (id: string, source: string, target: string, channel: RouteRelation['channel'] = 'semantic',
  type = 'supports'): RouteRelation => ({ id, source, target, channel, type, class: 'attested' });
const base = { nodes, disclosedIds: new Set(['a', 'b', 'a-p', 'b-p', 'a-c', 'b-c', 'a-q', 'b-q']),
  renderedNodeIds: new Set(['a', 'b', 'a-p', 'b-p']), budget: 5 };

test('relations lift to rendered primary-parent aggregates with disclosure and LOD counts', () => {
  const result = routeRelationsAfterLOD({ ...base, relations: [
    relation('e1', 'a-q', 'b-q'), relation('e2', 'a-s', 'b-q', 'lifted'),
    { ...relation('e3', 'a-k', 'b-c', 'visual'), sourceEdgeIds: ['source:e3'] },
  ], derivedCurveIds: ['orbit', 'equipotential'] });
  assert.equal(result.drawn.length, 1);
  assert.deepEqual(result.drawn[0]!.from, { id: 'a-p', kind: 'aggregate' });
  assert.deepEqual(result.drawn[0]!.to, { id: 'b-p', kind: 'aggregate' });
  assert.equal(result.drawn[0]!.count, 3);
  assert.equal(result.drawn[0]!.channel, 'lifted');
  assert.deepEqual(result.aggregates, [
    { id: 'a-p', memberCount: 7, hiddenByDisclosure: 4, hiddenByLOD: 2,
      sourceEdgeCount: 3, explanationId: 'aggregate:a-p' },
    { id: 'b-p', memberCount: 3, hiddenByDisclosure: 0, hiddenByLOD: 2,
      sourceEdgeCount: 3, explanationId: 'aggregate:b-p' },
  ]);
  assert.equal(result.derivedCurves, 2);
  assert.equal(result.invariant.ok, true);
  const witness = buildRevealWitness({ revision: 7, camera: { zoom: 6.6, band: 'deep', settled: true },
    focus: { clusterId: 'a', source: 'cursor', epoch: 1 }, nodes,
    disclosedIds: base.disclosedIds, renderedNodeIds: base.renderedNodeIds,
    revealableInFocus: 7, nodeBudget: 850, route: result, exclusions: { 'a-s': 'closed-parent' } });
  assert.deepEqual(witness.levels, { '1': 2, '2': 2, '3': 2, '4': 2, '5': 0 });
  assert.equal(witness.nodes.aggregateOnly, 2);
  assert.equal(witness.edges.drawn.length, 1);
  assert.equal(witness.invariant.ok, true);
  assert.equal(witness.exclusions['a-s'], 'closed-parent');
  assert.equal(witness.exclusions['a-c'], 'density-LOD');
  assert.equal(witness.exclusions['a-k'], 'closed-parent');
});

test('mixed direct and lifted contributors retain the aggregate endpoint and deterministic buckets', () => {
  const relations = [relation('direct', 'a-p', 'b'), relation('lifted', 'a-q', 'b')];
  const first = routeRelationsAfterLOD({ ...base, relations });
  const reversed = routeRelationsAfterLOD({ ...base, relations: [...relations].reverse() });
  assert.deepEqual(reversed, first);
  assert.deepEqual(first.drawn[0]?.from, { id: 'a-p', kind: 'aggregate' });
  assert.equal(first.aggregates[0]?.sourceEdgeCount, 2);
  assert.equal(first.invariant.ok, true);
});

test('reading-filtered source relations remain accounted for as suppressions', () => {
  const exploratory = { ...relation('exploratory', 'a-q', 'b-q'), class: 'exploratory' as const };
  const result = routeRelationsAfterLOD({ ...base, reading: 'attested', relations: [exploratory,
    relation('attested', 'a-q', 'b-q')] });
  assert.deepEqual(result.suppressed, [{ id: 'exploratory', cause: 'reading-filter' }]);
  assert.deepEqual(result.drawn.flatMap(edge => edge.sourceRelationIds), ['attested']);
  assert.equal(result.invariant.ok, true);
});

test('unrepresented and collapsed self-pairs have causes; reserve rescues isolated endpoints', () => {
  const result = routeRelationsAfterLOD({ ...base, relations: [
    relation('missing', 'unknown', 'b-q'), relation('self', 'a-q', 'a-s'),
    relation('one', 'a-q', 'b-q'), relation('two', 'a-c', 'b'),
  ], budget: 1 });
  assert.equal(result.drawn.length, 2);
  assert.deepEqual(Object.fromEntries(result.suppressed.map(item => [item.id, item.cause])), {
    missing: 'endpoint-unrepresented', self: 'self-aggregate',
  });
  const fan = routeRelationsAfterLOD({ ...base, nodes: [...nodes, { id: 'c', level: 1, parent: null },
    { id: 'd', level: 1, parent: null }], renderedNodeIds: new Set([...base.renderedNodeIds, 'c', 'd']),
    relations: [relation('a', 'a-q', 'b'), relation('b', 'a-q', 'c'), relation('c', 'a-q', 'd')],
    budget: 5, fanDegree: 2 });
  assert.equal(fan.drawn.length, 3);
  assert.deepEqual(fan.suppressed, []);
});

test('the invariant detects a crafted missing glyph and unexplained aggregate', () => {
  const result = checkRouteInvariant([
    { id: 'orphan', from: { id: 'ghost', kind: 'node' }, to: { id: 'a-p', kind: 'aggregate' } },
  ], new Set(['a-p']), [{ id: 'a-p', memberCount: 2, explanationId: '' }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(item => item.reason), ['node-glyph-absent', 'aggregate-unexplained']);
});
