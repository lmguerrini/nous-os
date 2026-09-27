import type { GraphEdge } from './graph-v2.ts';
import type { V2Node } from './v2-core.ts';
import type { Reading } from './view-contract.ts';

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
};

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

export function projectRelations(
  nodes: readonly V2Node[], edges: readonly GraphEdge[], visible: ReadonlySet<string>,
  reading: Reading, organization: 'flat' | 'indra', detail: RelationDetail = 'essential',
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
    if (edge.type === 'mentions' && detail === 'essential' && active !== edge.source && active !== edge.target) continue;
    const source = visibleAncestor(edge.source, visible, byNode);
    const target = visibleAncestor(edge.target, visible, byNode);
    if (!source || !target || source === target) continue;
    if (organization === 'indra' && detail === 'essential' && active !== source && active !== target && active !== edge.source && active !== edge.target) continue;
    add(source, target, edge, edge.class === 'exploratory' ? 'exploratory_lift' : 'attested_lift', source !== edge.source || target !== edge.target);
  }
  const projected: LiftedRelation[] = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => ({
    id: `lift:${key}`, source: bucket.source, target: bucket.target, class: bucket.class,
    type: bucket.type, directed: false, evidence: [], count: bucket.items.length,
    underlying: bucket.items, lifted: bucket.lifted || bucket.items.length > 1,
    width: width(bucket.items.length),
  }));
  if (organization === 'flat') {
    for (const node of nodes) if (visible.has(node.id) && node.parent && visible.has(node.parent)) {
      projected.push({ id: `contains:${node.id}`, source: node.parent, target: node.id,
        class: 'attested', type: 'contains', directed: true, evidence: [], count: 1,
        underlying: [], lifted: false, width: 0.65 });
    }
  }
  if (organization === 'flat') {
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
  const byId = new Map(projected.map(edge => [edge.id, edge]));
  return { edges: projected, byId };
}
