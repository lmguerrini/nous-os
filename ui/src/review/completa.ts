/** D-081 P3: the complete legacy scene. Every indexed node is a glyph and every eligible
 * source relation contributes exactly once to an individual line or a counted parallel bundle. */
import type { V2Index, V2Visible } from './v2-core.ts';
import type { LiftedRelation, RelationProjection } from './v2-relations.ts';
import type { Reading } from './view-contract.ts';
import { relationVisible } from './reading.ts';
import type { RouteResult, RoutedEdge } from './relation-routing.ts';

export const COMPLETE_IDLE_MS = 350;
export function completeQuality(nowMs: number, lastInteractionMs: number, renderPending: boolean): 'movimento' | 'recupero' | 'completa' {
  if (nowMs - lastInteractionMs < COMPLETE_IDLE_MS) return 'movimento';
  return renderPending ? 'recupero' : 'completa';
}

export function completeVisible(index: V2Index): V2Visible {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const node of index.nodes) counts[node.level] = (counts[node.level] ?? 0) + 1;
  return { nodes: index.nodes, edges: index.edges, hidden: new Map(), capped: false, counts };
}

export function completeRelations(index: V2Index, reading: Reading): RelationProjection {
  const ids = new Set(index.nodes.map(node => node.id));
  const edges: LiftedRelation[] = index.edges
    .filter(edge => ids.has(edge.source) && ids.has(edge.target) &&
      relationVisible(edge.type === 'classified_in' ? 'structural' : edge.class, reading))
    .map(edge => ({ ...edge, class: edge.type === 'classified_in' ? 'structural' as const : edge.class,
      count: 1, underlying: [edge], lifted: false, width: 0.7 }));
  for (const node of index.nodes) if (node.parent && ids.has(node.parent))
    edges.push({ id: `contains:${node.id}`, source: node.parent, target: node.id,
      class: 'structural', type: 'contains', directed: true, evidence: [],
      count: 1, underlying: [], lifted: false, width: 0.65 });
  return { edges, byId: new Map(edges.map(edge => [edge.id, edge])), total: edges.length };
}

/** Parallel source edges share one visible line. No fan or global line cap discards a source. */
export function completeRoute(relations: readonly LiftedRelation[], rendered: ReadonlySet<string>, splitParallel = false): RouteResult {
  const buckets = new Map<string, LiftedRelation[]>();
  for (const relation of relations) {
    const [from, to] = relation.source < relation.target
      ? [relation.source, relation.target] : [relation.target, relation.source];
    const key = JSON.stringify([from, to, relation.class, relation.type, splitParallel ? relation.id : '']);
    const bucket = buckets.get(key) ?? [];
    bucket.push(relation);
    buckets.set(key, bucket);
  }
  const drawn: RoutedEdge[] = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
    const [from, to] = JSON.parse(key) as [string, string, string, string];
    const first = members[0]!;
    return { id: members.length === 1 ? first.id : `route:complete:${first.id}`,
      channel: 'lifted', from: { id: from, kind: 'node' }, to: { id: to, kind: 'node' },
      count: members.length, class: first.class, type: first.type,
      sourceRelationIds: members.map(member => member.id), explanationId: first.id };
  });
  const violations = drawn.flatMap(edge => (['from', 'to'] as const)
    .filter(side => !rendered.has(edge[side].id))
    .map(side => ({ edgeId: edge.id, endpoint: side, reason: 'node-glyph-absent' })));
  return { drawn, suppressed: [], aggregates: [], renderedNodeIds: [...rendered].sort(),
    budget: drawn.length, derivedCurves: 0, invariant: { ok: violations.length === 0, violations } };
}
