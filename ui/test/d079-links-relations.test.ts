import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge } from '../src/review/graph-v2.ts';
import type { V2Node } from '../src/review/v2-core.ts';
import { projectRelations, projectTypedRelations } from '../src/review/v2-relations.ts';
import { routeRelationsAfterLOD } from '../src/review/relation-routing.ts';
import { buildVisibilityWitness, countAggregateRepresentation, countExcludedRelations } from '../src/review/visibility-witness.ts';
import { relationVisible } from '../src/review/reading.ts';
import type { Axes } from '../src/review/view-contract.ts';

const node = (id: string, level: V2Node['level'], parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'source', title: id,
  title_full: id, importance: { value: 0, components: {} }, size: 0,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const edge = (id: string, source: string, target: string, kind: GraphEdge['class']): GraphEdge => ({
  id, source, target, class: kind, type: 'relates', directed: false, evidence: [],
});
const nodes = [node('domain:a', 1, null), node('domain:b', 1, null),
  ...Array.from({ length: 12 }, (_, i) => node(`source:${i}`, 3, i < 6 ? 'domain:a' : 'domain:b'))];
const sources = [edge('attested:a', 'source:0', 'source:6', 'attested'),
  edge('exploratory:a', 'source:1', 'source:7', 'exploratory')];
const visible = new Set(nodes.map(item => item.id));
const axes: Axes = { organization: 'indra', projection: '3d', morphology: 'neural',
  reading: 'combined', colour: 'bw', labels: true };

test('readings partition semantic relation ids and retain structural provenance', () => {
  const ids = (reading: Axes['reading']) => projectRelations(nodes, sources, visible, reading, 'indra', 'all').edges;
  const attested = ids('attested'), exploratory = ids('exploratory'), combined = ids('combined');
  const semantic = (relations: ReturnType<typeof ids>) => new Set(relations.filter(item => item.class !== 'structural').map(item => item.id));
  const a = semantic(attested), e = semantic(exploratory), c = semantic(combined);
  assert.deepEqual([...a].filter(id => e.has(id)), []);
  assert.deepEqual([...c].sort(), [...a, ...e].sort());
  for (const reading of [attested, exploratory, combined]) {
    assert.equal(reading.filter(item => item.class === 'structural' && item.type === 'contains').length, 12);
    assert.equal(reading.some(item => item.type === 'contains' && item.class !== 'structural'), false);
  }
  assert.equal(relationVisible('structural', 'exploratory'), true);
});

test('level-skipping sources receive parent containment in Natural and Indra', () => {
  for (const organization of ['natural', 'indra'] as const) {
    const projected = projectRelations(nodes, sources, visible, 'exploratory', organization);
    const relation = projected.byId.get('contains:source:0');
    assert.deepEqual([relation?.source, relation?.target, relation?.class],
      ['domain:a', 'source:0', 'structural']);
  }
});

test('typed semantic collection excludes structural source provenance', () => {
  const classified = { ...edge('classified', 'source:0', 'domain:b', 'attested'), type: 'classified_in' };
  const projected = projectTypedRelations(nodes, [classified], visible, 'combined', 'natural', 'all');
  assert.deepEqual(projected.semanticEdges, []);
  assert.ok(projected.visualRelations.some(relation => relation.underlyingEdgeIds.includes('classified')));
});

test('connectivity reserve adds at most one legitimate edge per isolated node', () => {
  const projected = projectRelations(nodes, sources, visible, 'combined', 'indra', 'all');
  const routed = routeRelationsAfterLOD({
    nodes, disclosedIds: visible, renderedNodeIds: visible,
    relations: projected.edges.map(item => ({ id: item.id, channel: 'lifted' as const,
      source: item.source, target: item.target, class: item.class, type: item.type, count: item.count })),
    budget: 1, reading: 'combined', fanDegree: 2,
  });
  const degree = new Set(routed.drawn.flatMap(item => [item.from.id, item.to.id]));
  assert.deepEqual([...visible].filter(id => !degree.has(id)), []);
  assert.ok(routed.drawn.length <= 1 + visible.size);
  assert.ok(routed.drawn.some(item => item.class === 'attested'));
  assert.ok(routed.drawn.some(item => item.class === 'exploratory'));
  assert.ok(routed.invariant.ok);
});

test('visibility counts the exact submitted instances in each separate class', () => {
  const projected = projectRelations(nodes, sources, visible, 'combined', 'indra', 'all');
  const submitted = projected.edges.map(item => ({ id: item.id, source: item.source,
    target: item.target, class: item.class }));
  const witness = buildVisibilityWitness({ axes, relationDetail: 'all', density: 'complete',
    nodes, renderedNodeIds: visible, submittedEdges: submitted, labels: 3,
    aggregateCount: 2, representedCount: 12, starCount: 0 });
  for (const kind of ['attested', 'exploratory', 'structural'] as const) {
    assert.equal(witness.edges.drawn[kind], witness.submitted[kind]);
    assert.equal(witness.edges.ids[kind].length, witness.submitted[kind]);
  }
  assert.equal(witness.zeroDegree.count, 0);
});

test('omitted source relations have one exclusion cause each', () => {
  const causes = countExcludedRelations({ nodes, renderedNodeIds: visible,
    relations: [
      { id: 'shown', source: 'domain:a', target: 'source:0', class: 'structural', type: 'contains' },
      { id: 'filtered', source: 'source:0', target: 'source:6', class: 'exploratory' },
      { id: 'budget', source: 'source:1', target: 'source:7', class: 'attested' },
    ], drawnSourceIds: new Set(['shown']), reading: 'attested', relationDetail: 'all',
    organization: 'natural' });
  assert.deepEqual(causes, { budget: 1, hiddenEndpoint: 0, readingFilter: 1, detailFilter: 0 });
});

test('aggregate representation counts hidden descendants once at their nearest drawn ancestor', () => {
  const local = [node('domain', 1, null), node('conversation', 3, 'domain'),
    node('source', 4, 'conversation'), node('passage', 5, 'source')];
  assert.deepEqual(countAggregateRepresentation(local, new Set(['domain', 'conversation'])),
    { drawn: 1, represented: 2 });
});

test('Indra essential routing keeps A and E disjoint, combined exact, and the reserve bounded', () => {
  const graph = [node('domain:a', 1, null), node('domain:b', 1, null),
    ...Array.from({ length: 140 }, (_, i) => node(`source:${i}`, 3, i < 70 ? 'domain:a' : 'domain:b'))];
  const relations = Array.from({ length: 70 }, (_, i) => [
    edge(`a:${i}`, `source:${i}`, `source:${i + 70}`, 'attested'),
    edge(`e:${i}`, `source:${i}`, `source:${(i + 1) % 70 + 70}`, 'exploratory'),
  ]).flat();
  const ids = new Set(graph.map(item => item.id));
  const routed = (reading: Axes['reading']) => routeRelationsAfterLOD({
    nodes: graph, disclosedIds: ids, renderedNodeIds: ids,
    relations: projectRelations(graph, relations, ids, reading, 'indra', 'essential').edges.map(item => ({
      id: item.id, channel: 'lifted' as const, source: item.source, target: item.target,
      class: item.class, type: item.type, count: item.count })),
    budget: 160, reading,
  });
  const a = routed('attested'), e = routed('exploratory'), c = routed('combined');
  const semantic = (result: typeof a) => new Set(result.drawn.filter(item => item.class !== 'structural').map(item => item.id));
  const aIds = semantic(a), eIds = semantic(e), cIds = semantic(c);
  assert.deepEqual([...aIds].filter(id => eIds.has(id)), []);
  assert.deepEqual([...cIds].sort(), [...aIds, ...eIds].sort());
  for (const result of [a, e, c]) {
    const degree = new Set(result.drawn.flatMap(item => [item.from.id, item.to.id]));
    assert.deepEqual([...ids].filter(id => !degree.has(id)), []);
    assert.ok(result.drawn.length <= result.budget + ids.size);
  }
});
