// D085-S7 BEGIN
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRouteInvariant, measureRelationDetail, selectRelationDetail } from '../../src/review/relation-routing.ts';
import { readFileSync } from 'node:fs';
import type { RouteResult, RoutedEdge } from '../../src/review/relation-routing.ts';
import { formatD081GraphStatus } from '../../src/review/toolbar-status.ts';
import { countExcludedRelations } from '../../src/review/visibility-witness.ts';

const edge = (id: string, from: string, to: string, count: number,
  kind: RoutedEdge['class'] = 'attested', type = 'relates'): RoutedEdge => ({
  id, channel: 'lifted', from: { id: from, kind: 'node' }, to: { id: to, kind: 'node' },
  count, class: kind, type, sourceRelationIds: [id], explanationId: id,
});
const visible = new Set(['a', 'b', 'c', 'd']);
const candidates = [
  edge('contains:a:b', 'a', 'b', 1, 'structural', 'contains'),
  edge('strong-a', 'a', 'c', 5), edge('strong-b', 'b', 'd', 4),
  edge('extra-a', 'a', 'd', 2), edge('extra-b', 'b', 'c', 2),
  edge('explore-a', 'a', 'c', 3, 'exploratory'),
  edge('explore-b', 'b', 'd', 2, 'exploratory'),
  edge('explore-extra', 'a', 'd', 1, 'exploratory'),
];
const route: RouteResult = { drawn: candidates, suppressed: [], aggregates: [],
  renderedNodeIds: [...visible], budget: 100, derivedCurves: 0,
  invariant: checkRouteInvariant(candidates, visible, []) };

test('Essenziali keeps real high-count coverage; Tutte adds deterministic admitted edges', () => {
  const essential = selectRelationDetail(route, 'essential');
  const all = selectRelationDetail(route, 'all');
  assert.ok(essential.drawn.length < all.drawn.length);
  assert.ok(essential.drawn.some(item => item.id === 'contains:a:b'));
  assert.ok(essential.drawn.some(item => item.id === 'strong-a'));
  assert.ok(essential.drawn.some(item => item.id === 'strong-b'));
  assert.ok(essential.drawn.some(item => item.class === 'exploratory'));
  assert.ok(essential.drawn.every(item => all.drawn.includes(item)));
  assert.equal(essential.detail?.availableDrawn, all.drawn.length);
  assert.equal(essential.detail?.additionalDrawn, all.drawn.length - essential.drawn.length);
  assert.equal(essential.detail?.represented, essential.drawn.filter(item => item.type !== 'contains')
    .reduce((sum, item) => sum + item.count, 0));
  assert.equal(essential.detail?.guideDrawn, 1);
  assert.deepEqual(essential.detail?.classes.attested, {
    essentialDrawn: 2, allDrawn: 4, essentialRepresented: 9,
    allRepresented: 13, additionalDrawn: 2, additionalRepresented: 4,
  });
  assert.equal(essential.invariant.ok, true);
  assert.deepEqual(selectRelationDetail(route, 'essential'), essential);
  assert.deepEqual(selectRelationDetail(route, 'all'), all);
});

test('detail selection never leaves an absent endpoint or stale relation after switching', () => {
  const first = selectRelationDetail(route, 'essential');
  const expanded = selectRelationDetail(route, 'all');
  const again = selectRelationDetail(route, 'essential');
  assert.deepEqual(again.drawn, first.drawn);
  assert.equal(expanded.drawn.length, candidates.length);
  assert.equal(first.suppressed.length, candidates.length - first.drawn.length);
  assert.ok(first.suppressed.every(item => item.cause === 'detail-filter'));
  assert.equal(first.invariant.ok, true);
});

test('source-backed typed routes remain pickable with their original provenance', () => {
  const typed = { ...edge('route', 'a', 'c', 2), channel: 'visual' as const,
    type: 'lifted-route', sourceRelationIds: ['visual:fractal:route:cross'] };
  const candidate: RouteResult = { ...route, drawn: [
    edge('dominant', 'a', 'c', 9), typed, edge('other', 'b', 'd', 1),
  ] };
  const selected = selectRelationDetail(candidate, 'essential');
  assert.ok(selected.drawn.includes(typed));
  assert.deepEqual(selected.drawn.find(item => item.id === 'route')?.sourceRelationIds,
    ['visual:fractal:route:cross']);
});

test('a view can keep its earlier sparse source-backed Essenziali route as a subset', () => {
  const sparse = new Set(['strong-a', 'explore-a']);
  const selected = selectRelationDetail(route, 'essential', sparse);
  assert.deepEqual(selected.drawn.map(item => item.id), ['contains:a:b', 'strong-a', 'explore-a']);
  assert.equal(selected.detail?.additionalDrawn, route.drawn.length - selected.drawn.length);
  assert.equal(selected.invariant.ok, true);
});

test('Lab detail reports independently routed D-084 sets without changing their IDs', () => {
  const first: RouteResult = { ...route, drawn: [edge('lab-essential', 'a', 'b', 2)] };
  const complete: RouteResult = { ...route, drawn: [edge('lab-all', 'a', 'c', 3),
    edge('lab-extra', 'b', 'd', 1)] };
  const essential = measureRelationDetail(first, complete, 'essential');
  const all = measureRelationDetail(first, complete, 'all');
  assert.deepEqual(essential.drawn.map(item => item.id), ['lab-essential']);
  assert.deepEqual(all.drawn.map(item => item.id), ['lab-all', 'lab-extra']);
  assert.equal(essential.detail?.essentialDrawn, 1);
  assert.equal(essential.detail?.availableDrawn, 2);
  assert.equal(essential.detail?.additionalDrawn, 2);
  assert.equal(all.detail?.essentialRepresented, 2);
  assert.equal(all.detail?.availableRepresented, 4);
});

test('classic Indra retains the established essential routing cap', () => {
  const page = readFileSync(new URL('../../src/review/v2-page.ts', import.meta.url), 'utf8');
  assert.match(page, /!lab && organization === 'indra' && this\.relationDetail === 'essential'\s*\? Math\.min\(budget\.arcs, INDRA_ESSENTIAL_ARC_CAP\)/);
});

test('Lab pages route the requested detail before measuring and preserve Complete Canopy', () => {
  const page = readFileSync(new URL('../../src/review/v2-page.ts', import.meta.url), 'utf8');
  assert.match(page, /this\.topology === 'natural' \? 'all' : this\.relationDetail/);
  assert.match(page, /const selectedRoute: RouteResult = this\.topology === 'natural'\s*\? selectRelationDetail\(typedCandidate/);
  assert.match(page, /const lab = this\.topology !== 'natural'/);
  assert.match(page, /const canopyDetailInput = lab && canopy && this\.relationDetail === 'essential'/);
  assert.match(page, /const canopyArcs = canopy \? this\.density === 'complete'\s*\? projectedArcs\.edges : canopyEvidenceArcs\(projectedArcs\.edges\)/);
  assert.match(page, /let route = lab \? measureRelationDetail\(/);
});

test('lifted endpoints retain only the aggregates used by drawn detail and the status separates guides', () => {
  const lifted: RoutedEdge = { ...edge('lifted', 'a', 'c', 4),
    from: { id: 'a', kind: 'aggregate' }, to: { id: 'c', kind: 'node' } };
  const extra: RoutedEdge = { ...edge('extra', 'b', 'd', 1),
    from: { id: 'b', kind: 'aggregate' }, to: { id: 'd', kind: 'node' } };
  const aggregates = [
    { id: 'a', memberCount: 3, hiddenByDisclosure: 2, hiddenByLOD: 0, sourceEdgeCount: 4, explanationId: 'aggregate:a' },
    { id: 'b', memberCount: 2, hiddenByDisclosure: 1, hiddenByLOD: 0, sourceEdgeCount: 1, explanationId: 'aggregate:b' },
  ];
  const candidate: RouteResult = { ...route, drawn: [lifted, extra], aggregates,
    invariant: checkRouteInvariant([lifted, extra], visible, aggregates) };
  const selected = selectRelationDetail(candidate, 'essential');
  assert.deepEqual(selected.drawn.map(item => item.id), ['lifted']);
  assert.deepEqual(selected.aggregates.map(item => item.id), ['a']);
  assert.equal(selected.invariant.ok, true);
  const formatted = formatD081GraphStatus({
    nodes: { visible: 4, represented: 4, total: 4, eligible: 4, aggregated: 0, aggregates: 0 },
    edges: { drawn: selected.drawn.length, bundled: 4, bundles: 1, eligible: 2, total: 2,
      detail: selected.detail! },
    depth: { level: 1, label: 'Panoramica' }, quality: 'completa', msSinceInteraction: 0,
    msToFullQuality: 0, limit: null, hint: null,
  });
  assert.match(formatted.line, /Rel\. Essenziali: 4; Tutte: 5/);
  assert.match(formatted.details[1], /Essenziali 1 tracciati \/ 4 relazioni, Tutte 2 tracciati \/ 5 relazioni/);
});

test('witness attributes only actually removed source records to detail', () => {
  const result = countExcludedRelations({ nodes: [...visible].map(id => ({ id })), renderedNodeIds: visible,
    relations: [
      { id: 'removed', source: 'a', target: 'c', class: 'attested', type: 'relates' },
      { id: 'budget', source: 'b', target: 'd', class: 'attested', type: 'mentions' },
    ], drawnSourceIds: new Set(), reading: 'attested', relationDetail: 'essential',
    organization: 'natural', detailFilteredSourceIds: new Set(['removed']) });
  assert.deepEqual(result, { budget: 1, hiddenEndpoint: 0, readingFilter: 0, detailFilter: 1 });
});
// D085-S7 END
