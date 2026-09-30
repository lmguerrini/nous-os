/** Final relation selection after node LOD. This module never changes source provenance. */
import { EXPLORATORY_RESERVE_SHARE } from './lod.ts';
import type { RevealBand, RevealSource } from './reveal-controller.ts';

export type RouteChannel = 'semantic' | 'lifted' | 'visual';
export type RouteCause = 'endpoint-unrepresented' | 'self-aggregate' | 'line-budget' | 'fan-degree' | 'reading-filter';
export type RouteNode = Readonly<{ id: string; parent: string | null; level: 1 | 2 | 3 | 4 | 5; passageCount?: number }>;
export type RouteRelation = Readonly<{
  id: string; channel: RouteChannel; source: string; target: string;
  class: 'attested' | 'exploratory'; type: string; count?: number;
  explanationId?: string; sourceEdgeIds?: readonly string[];
}>;
export type RouteEndpoint = Readonly<{ id: string; kind: 'node' | 'aggregate' }>;
export type RoutedEdge = Readonly<{
  id: string; channel: RouteChannel; from: RouteEndpoint; to: RouteEndpoint;
  count: number; class: RouteRelation['class']; type: string;
  sourceRelationIds: readonly string[]; explanationId: string;
}>;
export type RouteAggregate = Readonly<{
  id: string; memberCount: number; hiddenByDisclosure: number; hiddenByLOD: number;
  sourceEdgeCount: number; explanationId: string;
}>;
export type RouteSuppression = Readonly<{ id: string; cause: RouteCause }>;
export type EndpointViolation = Readonly<{ edgeId: string; endpoint: 'from' | 'to'; reason: string }>;
export type RouteInvariant = Readonly<{ ok: boolean; violations: readonly EndpointViolation[] }>;
export type RouteResult = Readonly<{
  drawn: readonly RoutedEdge[]; suppressed: readonly RouteSuppression[];
  aggregates: readonly RouteAggregate[]; renderedNodeIds: readonly string[];
  budget: number; derivedCurves: number; invariant: RouteInvariant;
}>;
export type RouteInput = Readonly<{
  nodes: readonly RouteNode[]; disclosedIds: ReadonlySet<string>; renderedNodeIds: ReadonlySet<string>;
  relations: readonly RouteRelation[]; budget: number; focusId?: string | null;
  reading?: 'attested' | 'exploratory' | 'combined';
  pinnedRelationIds?: ReadonlySet<string>; fanDegree?: number;
  derivedCurveIds?: readonly string[];
}>;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pair = (a: RouteEndpoint, b: RouteEndpoint): [RouteEndpoint, RouteEndpoint] => cmp(a.id, b.id) <= 0 ? [a, b] : [b, a];

/** Validate the actual drawn list, independent of the algorithm that produced it. */
export function checkRouteInvariant(
  drawn: readonly Pick<RoutedEdge, 'id' | 'from' | 'to'>[],
  renderedNodeIds: ReadonlySet<string>, aggregates: readonly Pick<RouteAggregate, 'id' | 'memberCount' | 'explanationId'>[],
): RouteInvariant {
  const aggregateById = new Map(aggregates.map(aggregate => [aggregate.id, aggregate]));
  const violations: EndpointViolation[] = [];
  for (const edge of drawn) for (const side of ['from', 'to'] as const) {
    const endpoint = edge[side];
    const reason = endpoint.kind === 'node'
      ? renderedNodeIds.has(endpoint.id) ? null : 'node-glyph-absent'
      : endpoint.kind === 'aggregate'
        ? !renderedNodeIds.has(endpoint.id) ? 'aggregate-glyph-absent'
          : !aggregateById.has(endpoint.id) ? 'aggregate-absent'
            : (aggregateById.get(endpoint.id)!.memberCount < 1 || !aggregateById.get(endpoint.id)!.explanationId)
              ? 'aggregate-unexplained' : null
        : 'invalid-endpoint-kind';
    if (reason) violations.push({ edgeId: edge.id, endpoint: side, reason });
  }
  return { ok: violations.length === 0, violations };
}

/** Lift missing endpoints only along their primary-parent chain, then share one line budget. */
export function routeRelationsAfterLOD(input: RouteInput): RouteResult {
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const rendered = input.renderedNodeIds;
  const nearestGlyph = (id: string): RouteEndpoint | null => {
    const seen = new Set<string>(); let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      if (rendered.has(cursor)) return { id: cursor, kind: cursor === id ? 'node' : 'aggregate' };
      seen.add(cursor); cursor = byId.get(cursor)?.parent ?? null;
    }
    return null;
  };
  const representedBy = (id: string): string | null => nearestGlyph(id)?.id ?? null;
  const counts = new Map<string, { disclosure: number; lod: number }>();
  const knownPassages = new Map<string, number>();
  for (const node of input.nodes) if (node.level === 5 && node.parent)
    knownPassages.set(node.parent, (knownPassages.get(node.parent) ?? 0) + 1);
  for (const node of input.nodes) {
    if (!rendered.has(node.id)) {
      const owner = representedBy(node.id);
      if (owner) {
        const count = counts.get(owner) ?? { disclosure: 0, lod: 0 };
        if (input.disclosedIds.has(node.id)) count.lod++; else count.disclosure++;
        counts.set(owner, count);
      }
    }
    if (node.level === 4 && node.passageCount) {
      const known = knownPassages.get(node.id) ?? 0;
      const unloaded = Math.max(0, node.passageCount - known);
      const owner = representedBy(node.id);
      if (owner && unloaded) {
        const count = counts.get(owner) ?? { disclosure: 0, lod: 0 };
        count.disclosure += unloaded; counts.set(owner, count);
      }
    }
  }
  type Bucket = { from: RouteEndpoint; to: RouteEndpoint; class: RouteRelation['class']; type: string;
    channel: RouteChannel; source: RouteRelation[]; count: number; explanationId: string };
  const buckets = new Map<string, Bucket>();
  const suppressed: RouteSuppression[] = [];
  for (const relation of [...input.relations].sort((a, b) => cmp(a.id, b.id))) {
    if (input.reading === 'attested' && relation.class === 'exploratory') {
      suppressed.push({ id: relation.id, cause: 'reading-filter' }); continue;
    }
    const from = nearestGlyph(relation.source), to = nearestGlyph(relation.target);
    if (!from || !to) { suppressed.push({ id: relation.id, cause: 'endpoint-unrepresented' }); continue; }
    if (from.id === to.id) { suppressed.push({ id: relation.id, cause: 'self-aggregate' }); continue; }
    const [a, b] = pair(from, to);
    const key = [a.id, b.id, relation.class, relation.type].join('\u0000');
    const bucket = buckets.get(key) ?? { from: a, to: b, class: relation.class, type: relation.type,
      channel: relation.channel, source: [], count: 0, explanationId: relation.explanationId ?? `route:${key}` };
    if (a.kind === 'aggregate') bucket.from = a;
    if (b.kind === 'aggregate') bucket.to = b;
    bucket.source.push(relation);
    bucket.count += Math.max(1, relation.count ?? 1);
    if (bucket.channel !== relation.channel) bucket.channel = 'lifted';
    buckets.set(key, bucket);
  }
  const focused = (bucket: Bucket) => input.focusId !== null && input.focusId !== undefined &&
    (bucket.from.id === input.focusId || bucket.to.id === input.focusId ||
      bucket.source.some(relation => relation.source === input.focusId || relation.target === input.focusId));
  const pinned = (bucket: Bucket) => bucket.source.some(relation => input.pinnedRelationIds?.has(relation.id));
  const rank = (a: Bucket, b: Bucket) => Number(pinned(b)) - Number(pinned(a)) || Number(focused(b)) - Number(focused(a)) ||
    b.count - a.count || cmp(a.from.id, b.from.id) || cmp(a.to.id, b.to.id) || cmp(a.type, b.type);
  const all = [...buckets.values()].sort(rank);
  const budget = Math.max(0, Math.floor(input.budget));
  const fan = input.fanDegree ?? Math.max(2, Math.ceil(Math.sqrt(budget)));
  const reserve = Math.min(all.filter(bucket => bucket.class === 'exploratory').length,
    Math.floor(budget * EXPLORATORY_RESERVE_SHARE));
  const exploratory = all.filter(bucket => bucket.class === 'exploratory');
  const queue = [...exploratory.slice(0, reserve), ...all.filter(bucket => !exploratory.slice(0, reserve).includes(bucket))];
  const degree = new Map<string, number>(), accepted: Bucket[] = [];
  for (const bucket of queue) {
    if (accepted.length >= budget && !pinned(bucket)) {
      suppressed.push(...bucket.source.map(relation => ({ id: relation.id, cause: 'line-budget' as const }))); continue;
    }
    if (!pinned(bucket) && ((degree.get(bucket.from.id) ?? 0) >= fan || (degree.get(bucket.to.id) ?? 0) >= fan)) {
      suppressed.push(...bucket.source.map(relation => ({ id: relation.id, cause: 'fan-degree' as const }))); continue;
    }
    accepted.push(bucket);
    degree.set(bucket.from.id, (degree.get(bucket.from.id) ?? 0) + 1);
    degree.set(bucket.to.id, (degree.get(bucket.to.id) ?? 0) + 1);
  }
  const edgeCounts = new Map<string, Set<string>>();
  for (const bucket of accepted) for (const endpoint of [bucket.from, bucket.to]) if (endpoint.kind === 'aggregate') {
    const ids = edgeCounts.get(endpoint.id) ?? new Set<string>();
    for (const relation of bucket.source) for (const id of relation.sourceEdgeIds ??
      (relation.channel === 'visual' ? [] : [relation.id])) ids.add(id);
    edgeCounts.set(endpoint.id, ids);
  }
  const aggregates: RouteAggregate[] = [...edgeCounts].sort(([a], [b]) => cmp(a, b)).map(([id, edgeIds]) => {
    const count = counts.get(id) ?? { disclosure: 0, lod: 0 };
    return { id, memberCount: 1 + count.disclosure + count.lod,
      hiddenByDisclosure: count.disclosure, hiddenByLOD: count.lod,
      sourceEdgeCount: edgeIds.size, explanationId: `aggregate:${id}` };
  });
  const drawn: RoutedEdge[] = accepted.map(bucket => ({
    id: bucket.source.length === 1 ? bucket.source[0]!.id : `route:${bucket.from.id}:${bucket.to.id}:${bucket.class}:${bucket.type}`,
    channel: bucket.channel, from: bucket.from, to: bucket.to, count: bucket.count,
    class: bucket.class, type: bucket.type, sourceRelationIds: bucket.source.map(relation => relation.id),
    explanationId: bucket.explanationId,
  }));
  const renderedNodeIds = [...rendered].sort(cmp);
  return { drawn, suppressed: suppressed.sort((a, b) => cmp(a.id, b.id)), aggregates,
    renderedNodeIds, budget, derivedCurves: input.derivedCurveIds?.length ?? 0,
    invariant: checkRouteInvariant(drawn, rendered, aggregates) };
}

export type ExclusionCause = 'closed-parent' | 'page-limit' | '850-cap' | 'density-LOD' | 'outside-viewport' |
  'not-loaded' | 'reading-filter' | 'endpoint-unrepresented' | 'projection-refusal';
export type RevealWitnessInput = Readonly<{
  revision: number; camera: { zoom: number; band: RevealBand; settled: boolean };
  focus: { clusterId: string | null; source: RevealSource; epoch: number };
  nodes: readonly RouteNode[]; disclosedIds: ReadonlySet<string>; renderedNodeIds: ReadonlySet<string>;
  revealableInFocus: number; renderedInFocus?: number; nodeBudget: number; route: RouteResult;
  disclosureBudget?: number; openParentIds?: ReadonlySet<string>;
  notLoadedIds?: readonly string[];
  exclusions?: Readonly<Record<string, ExclusionCause>>;
}>;
/** Exact JSON witness for the drawn frame; the invariant is recomputed from its own edges. */
export function buildRevealWitness(input: RevealWitnessInput) {
  const levels: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const node of input.nodes) if (input.disclosedIds.has(node.id)) levels[String(node.level) as keyof typeof levels]++;
  const aggregates = input.route.aggregates;
  const exclusions: Record<string, ExclusionCause> = {};
  for (const node of input.nodes) {
    if (input.disclosedIds.has(node.id)) {
      if (!input.renderedNodeIds.has(node.id)) exclusions[node.id] = 'density-LOD';
    } else if (node.parent && input.openParentIds?.has(node.parent)) {
      exclusions[node.id] = input.disclosedIds.size >= (input.disclosureBudget ?? 850) ? '850-cap' : 'page-limit';
    } else exclusions[node.id] = 'closed-parent';
  }
  for (const id of input.notLoadedIds ?? []) exclusions[id] = 'not-loaded';
  Object.assign(exclusions, input.exclusions);
  const drawn = input.route.drawn.map(edge => ({ id: edge.id, channel: edge.channel,
    from: edge.from, to: edge.to, count: edge.count }));
  return { revision: input.revision, camera: input.camera, focus: input.focus, levels,
    nodes: { disclosed: input.disclosedIds.size, rendered: input.renderedNodeIds.size,
      aggregateOnly: aggregates.length, renderedInFocus: input.renderedInFocus ?? input.renderedNodeIds.size,
      revealableInFocus: input.revealableInFocus, budget: input.nodeBudget },
    renderedNodeIds: [...input.renderedNodeIds].sort(cmp), aggregates,
    edges: { drawn, budget: input.route.budget, suppressed: input.route.suppressed },
    exclusions, derivedCurves: input.route.derivedCurves,
    invariant: checkRouteInvariant(drawn, input.renderedNodeIds, aggregates) };
}
