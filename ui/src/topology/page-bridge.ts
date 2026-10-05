/** Full source snapshot and deterministic adapter into the classic scene pipeline. */
import type { GraphManifest } from '../review/graph-v2.ts';
import type { V2Index } from '../review/v2-core.ts';
import type { LayoutResult } from '../review/layout-v2.ts';
import type { TopologyDimension, TopologyId, TopologyLayout, TopologySnapshot } from './contract.ts';
import { TOPOLOGY_LAWS } from './registry.ts';
import { composeIndra } from './indra-compose.ts';

export function topologySnapshot(manifest: GraphManifest, index: V2Index): TopologySnapshot {
  const ids = new Set(index.nodes.map(node => node.id));
  const nodes = index.nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent,
    size: node.size, domains: [...node.domains], kind: node.kind,
    primaryDomain: node.primary_domain ?? node.domains[0] ?? null,
    importance: node.importance.value, title: node.title,
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.date !== undefined ? { date: node.date } : {}) }));
  const sourceEdges = index.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({
    id: edge.id, source: edge.source, target: edge.target,
    class: edge.type === 'classified_in' ? 'structural' as const : edge.class, type: edge.type,
  }));
  // The indexed primary-parent relation is real graph structure; Completa exposes it as contains:<id>.
  const hierarchyEdges = index.nodes.filter(node => node.parent && ids.has(node.parent)).map(node => ({
    id: `contains:${node.id}`, source: node.parent!, target: node.id,
    class: 'structural' as const, type: 'contains',
  }));
  const edges = [...sourceEdges, ...hierarchyEdges];
  if (new Set(edges.map(edge => edge.id)).size !== edges.length)
    throw new Error('Topology snapshot: duplicate real relation ID');
  return { digest: manifest.digest, nodes, edges };
}
export function computeTopologyLayout(id: Exclude<TopologyId, 'natural'>,
  snapshot: TopologySnapshot, dimension: TopologyDimension, indra: boolean): TopologyLayout {
  const law = TOPOLOGY_LAWS[id]!;
  const support = law.supports(dimension);
  if (!support.ok) throw new Error(support.reason);
  const result = indra ? composeIndra(law, snapshot, dimension) : law.layoutFull(snapshot, dimension);
  if (result.positions.size !== snapshot.nodes.length || result.witnesses.size !== snapshot.nodes.length)
    throw new Error(`${id}: la legge non ha collocato e spiegato ogni nodo reale`);
  for (const node of snapshot.nodes) {
    const point = result.positions.get(node.id);
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite) || !result.witnesses.has(node.id))
      throw new Error(`${id}: coordinata o testimone mancante per ${node.id}`);
  }
  if (result.diagnostics.some(diagnostic => !diagnostic.acceptable))
    throw new Error(`${id}: certificato geometrico rifiutato`);
  const semanticIds = new Set([...snapshot.nodes.map(node => node.id), ...snapshot.edges.map(edge => edge.id)]);
  const guideIds = new Set<string>();
  for (const guide of result.guides) {
    if (guide.semantic !== false || semanticIds.has(guide.id) || guideIds.has(guide.id))
      throw new Error(`${id}: guida non semantica con ID non univoco`);
    guideIds.add(guide.id);
  }
  return result;
}
export function topologyLayoutResult(result: TopologyLayout): LayoutResult {
  return { positions: result.positions, containers: result.containers, source: 'topology-law' };
}
