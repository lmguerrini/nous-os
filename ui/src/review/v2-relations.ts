import type { GraphEdge } from './graph-v2.ts';
import type { V2Node } from './v2-core.ts';
import type { Reading } from './view-contract.ts';
import type { VisualRelation } from '../projection/contract-types.ts';

export type LiftedRelation = GraphEdge & {
  count: number;
  underlying: readonly GraphEdge[];
  lifted: boolean;
  width: number;
};
export type RelationDetail = 'essential' | 'all';
export type RelationProjection = {
  edges: LiftedRelation[];
  byId: ReadonlyMap<string, LiftedRelation>;
  total: number;
};
/** Source records and display geometry have separate identities and collections. */
export type TypedRelationProjection = {
  semanticEdges: readonly GraphEdge[];
  visualRelations: readonly VisualRelation[];
  total: number;
};
export type TypedPathStep =
  | Readonly<{ kind: 'semantic-edge'; edge: GraphEdge }>
  | Readonly<{ kind: 'visual-relation'; relation: VisualRelation }>;

/** Classify v2Path's temporary synthetic hierarchy steps before any new panel/pick consumes them. */
export function typedPathSteps(steps: readonly (GraphEdge | {
  class: 'attested'; type: 'contains'; source: string; target: string;
})[]): TypedPathStep[] {
  return steps.map(step => {
    if ('id' in step) return { kind: 'semantic-edge', edge: step };
    const visualId = `visual:relation:contains:${step.target}`;
    return { kind: 'visual-relation', relation: {
      visualId, kind: 'synthetic-containment', semantic: false,
      source: step.source, target: step.target, underlyingEdgeIds: [],
      count: 1, explanationId: visualId,
    } };
  });
}
export const INDRA_ESSENTIAL_ARC_CAP = 160;

/** Indra recedes its semantic arcs so the nested shells stay legible. Non-selected arcs are strongly
 * reduced: the opacity factor is at most half of the D-070 value (0.6 in 3D, 1.0 in 2D). */
export function indraArcPresentation(projection: "2d" | "3d", exploratory: boolean): { opacityFactor: number; widthFactor: number } {
  if (projection === "3d")
    return { opacityFactor: exploratory ? 0.5 : 0.3, widthFactor: 0.55 };
  return { opacityFactor: exploratory ? 0.7 : 0.5, widthFactor: 0.7 };
}

/** Resolve hidden endpoints along the declared primary-parent chain only. */
export function visibleAncestor(id: string, visible: ReadonlySet<string>, nodes: ReadonlyMap<string, V2Node>): string | null {
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    if (visible.has(cursor)) return cursor;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.parent ?? null;
  }
  return null;
}

const pair = (a: string, b: string) => a < b ? [a, b] as const : [b, a] as const;
const width = (count: number) => Math.min(3.4, 0.7 + Math.log2(count + 1) * 0.42);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Typed output for the projection/render bridge. Original semantic records are never rewritten. */
export function projectTypedRelations(
  nodes: readonly V2Node[], edges: readonly GraphEdge[], visible: ReadonlySet<string>,
  reading: Reading, organization: 'natural' | 'indra', detail: RelationDetail = 'essential',
  active: string | null = null,
): TypedRelationProjection {
  const legacy = projectRelations(nodes, edges, visible, reading, organization, detail, active);
  const semanticEdges = edges.filter(edge => visible.has(edge.source) && visible.has(edge.target) &&
    (reading !== 'attested' || edge.class === 'attested'));
  const sourceIds = new Set(edges.map(edge => edge.id));
  const nodeIds = new Set(nodes.map(node => node.id));
  if (sourceIds.size !== edges.length) throw new Error('Duplicate source edge ID');
  const visualRelations: VisualRelation[] = legacy.edges.map(relation => {
    const kind: VisualRelation['kind'] = relation.type === 'co_membership' ? 'co-membership'
      : relation.type === 'contains' ? 'synthetic-containment' : 'lifted-route';
    // Legacy presentation folds only its first matching arc into a co-membership chord.
    // The typed record must still identify every original contributor to that chord.
    const contributors = kind === 'co-membership' ? [
      ...relation.underlying,
      ...legacy.edges.filter(other => other !== relation && other.class === 'attested' &&
        other.source === relation.source && other.target === relation.target &&
        other.type !== 'contains').flatMap(other => other.underlying),
    ] : relation.underlying;
    const underlyingEdgeIds = [...new Set(contributors.map(edge => edge.id))].sort(compare);
    if (underlyingEdgeIds.some(id => !sourceIds.has(id)) ||
        (kind === 'lifted-route' && underlyingEdgeIds.length === 0)) {
      throw new Error(`Invalid underlying source edges for ${relation.id}`);
    }
    const visualId = `visual:relation:${relation.id}`;
    if (sourceIds.has(visualId) || nodeIds.has(visualId)) throw new Error(`Visual ID collides with source: ${visualId}`);
    return { visualId, kind, semantic: false, source: relation.source, target: relation.target,
      underlyingEdgeIds, count: relation.count, explanationId: visualId };
  });
  return { semanticEdges, visualRelations, total: legacy.total };
}

/** One co-membership chord per visible domain pair, counted by conversation. */
export function coMembership(nodes: readonly V2Node[], visible: ReadonlySet<string>): LiftedRelation[] {
  const domains = new Map<string, string>();
  for (const node of nodes) if (node.level === 1 && visible.has(node.id)) {
    domains.set(node.id, node.id);
    domains.set(node.id.replace(/^domain:/, ''), node.id);
  }
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.level !== 3) continue;
    const ids = [...new Set(node.domains.map(domain => domains.get(domain)).filter((id): id is string => !!id))].sort();
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const key = `${ids[a]}\u0000${ids[b]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [source, target] = key.split('\u0000');
    return { id: `co:${source}:${target}`, source: source!, target: target!, class: 'attested',
      type: 'co_membership', directed: false, evidence: [], count, underlying: [], lifted: true, width: width(count) };
  });
}

function projectLegacyRelations(
  nodes: readonly V2Node[], edges: readonly GraphEdge[], visible: ReadonlySet<string>,
  reading: Reading, organization: 'natural' | 'indra', detail: RelationDetail = 'essential',
  active: string | null = null,
): RelationProjection {
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const buckets = new Map<string, { source: string; target: string; class: GraphEdge['class']; type: string; items: GraphEdge[]; lifted: boolean }>();
  const add = (source: string, target: string, edge: GraphEdge, type: string, lifted: boolean) => {
    const [a, b] = pair(source, target);
    const key = `${a}\u0000${b}\u0000${edge.class}\u0000${type}`;
    const bucket = buckets.get(key) ?? { source: a, target: b, class: edge.class, type, items: [], lifted: false };
    bucket.items.push(edge);
    bucket.lifted ||= lifted;
    buckets.set(key, bucket);
  };
  for (const edge of edges) {
    if (edge.type === 'contains' || edge.type === 'classified_in') continue;
    if (reading === 'attested' && edge.class === 'exploratory') continue;
    if (organization === 'natural' && edge.type === 'mentions' && detail === 'essential' && active !== edge.source && active !== edge.target) continue;
    const source = visibleAncestor(edge.source, visible, byNode);
    const target = visibleAncestor(edge.target, visible, byNode);
    if (!source || !target || source === target) continue;
    add(source, target, edge, edge.class === 'exploratory' ? 'exploratory_lift' : 'attested_lift', source !== edge.source || target !== edge.target);
  }
  const projected: LiftedRelation[] = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => ({
    id: `lift:${key}`, source: bucket.source, target: bucket.target, class: bucket.class,
    type: bucket.type, directed: false, evidence: [], count: bucket.items.length,
    underlying: bucket.items, lifted: bucket.lifted || bucket.items.length > 1,
    width: width(bucket.items.length),
  }));
  if (organization === 'natural') {
    for (const node of nodes) if (visible.has(node.id) && node.parent && visible.has(node.parent)) {
      projected.push({ id: `contains:${node.id}`, source: node.parent, target: node.id,
        class: 'attested', type: 'contains', directed: true, evidence: [], count: 1,
        underlying: [], lifted: false, width: 0.65 });
    }
  }
  if (organization === 'natural' || organization === 'indra') {
    for (const membership of coMembership(nodes, visible)) {
      const duplicate = projected.findIndex(edge => edge.class === 'attested' &&
        edge.source === membership.source && edge.target === membership.target && edge.type !== 'contains');
      if (duplicate >= 0) {
        const extra = projected.splice(duplicate, 1)[0]!;
        membership.underlying = extra.underlying;
      }
      projected.push(membership);
    }
  }
  const total = projected.length;
  if (organization === 'indra' && detail === 'essential' && projected.length > INDRA_ESSENTIAL_ARC_CAP) {
    projected.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    projected.length = INDRA_ESSENTIAL_ARC_CAP;
  }
  const byId = new Map(projected.map(edge => [edge.id, edge]));
  return { edges: projected, byId, total };
}

/** Temporary shape for v2-page and the legacy Natural coordinate bridge. */
export function projectRelations(
  nodes: readonly V2Node[], edges: readonly GraphEdge[], visible: ReadonlySet<string>,
  reading: Reading, organization: 'natural' | 'indra', detail: RelationDetail = 'essential',
  active: string | null = null,
): RelationProjection {
  return projectLegacyRelations(nodes, edges, visible, reading, organization, detail, active);
}
