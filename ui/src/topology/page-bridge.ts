/** Full source snapshot and deterministic adapter into the classic scene pipeline. */
import type { GraphManifest } from '../review/graph-v2.ts';
import type { V2Index } from '../review/v2-core.ts';
import type { LayoutResult } from '../review/layout-v2.ts';
import type { TopologyDimension, TopologyId, TopologyLayout, TopologySnapshot } from './contract.ts';
// D082-LAB-FIX3 BEGIN: preserve edge direction/provenance and share the inquiry worker.
import { topologyEdgeFromRaw } from './contract.ts';
import { buildLullInquiry } from './lull-inquiry.ts';
import type { LullInquiry } from './lull-inquiry.ts';
// D082-LAB-FIX3 END
import { TOPOLOGY_LAWS } from './registry.ts';
import { composeIndra } from './indra-compose.ts';

export function topologySnapshot(manifest: GraphManifest, index: V2Index): TopologySnapshot {
  const ids = new Set(index.nodes.map(node => node.id));
  const nodes = index.nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent,
    size: node.size, domains: [...node.domains], kind: node.kind,
    primaryDomain: node.primary_domain ?? node.domains[0] ?? null,
    // D082-LAB-FIX5 BEGIN: Lull's alphabet guides need the source's full title.
    importance: node.importance.value, title: node.title_full,
    // D082-LAB-FIX5 END
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.date !== undefined ? { date: node.date } : {}) }));
  // D082-LAB-FIX3 BEGIN: mapping metadata does not enter any law's coordinate rule.
  const sourceEdges = index.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge =>
    topologyEdgeFromRaw({ ...edge,
      class: edge.type === 'classified_in' ? 'structural' : edge.class,
      type: edge.type,
    }));
  // The indexed primary-parent relation is real graph structure; Completa exposes it as contains:<id>.
  const hierarchyEdges = index.nodes.filter(node => node.parent && ids.has(node.parent)).map(node =>
    topologyEdgeFromRaw({ id: `contains:${node.id}`, source: node.parent!, target: node.id,
      class: 'structural', type: 'contains', directed: true, evidence: ['index.json'] }));
  const edges = [...sourceEdges, ...hierarchyEdges];
  // D082-LAB-FIX3 END
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

// D082-LAB-FIX2 BEGIN: the review bundle embeds this worker source, so geometry
// runs outside the UI task without requiring another URL from the review server.
type PendingLayout = { resolve(value: TopologyLayout): void; reject(reason: Error): void };
// D082-LAB-FIX3 BEGIN: inquiry requests share the existing embedded worker.
type PendingInquiry = { resolve(value: LullInquiry): void; reject(reason: Error): void };
const pendingLayouts = new Map<number, PendingLayout>();
const pendingInquiries = new Map<number, PendingInquiry>();
// D082-LAB-FIX3 END
let topologyWorker: Worker | null = null;
let nextLayoutRequest = 0;

function embeddedTopologyWorker(): Worker | null {
  if (topologyWorker) return topologyWorker;
  const source = (globalThis as typeof globalThis & { __PROJECTION_WORKER_SOURCE__?: unknown }).__PROJECTION_WORKER_SOURCE__;
  if (typeof Worker === 'undefined' || typeof source !== 'string') return null;
  try {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = event => {
      const message = event.data as { kind?: string; requestId?: number; result?: TopologyLayout; message?: string };
      // D082-LAB-FIX3 BEGIN
      if (message.kind === 'lull-inquiry-result' || message.kind === 'lull-inquiry-error') {
        const task = pendingInquiries.get(message.requestId!);
        if (!task) return;
        pendingInquiries.delete(message.requestId!);
        if (message.kind === 'lull-inquiry-result' && 'result' in message && message.result)
          task.resolve(message.result as unknown as LullInquiry);
        else task.reject(new Error(message.message ?? 'Lull inquiry worker failed'));
        return;
      }
      // D082-LAB-FIX3 END
      if (message.kind !== 'topology-layout-result' && message.kind !== 'topology-layout-error') return;
      const task = pendingLayouts.get(message.requestId!);
      if (!task) return;
      pendingLayouts.delete(message.requestId!);
      if (message.kind === 'topology-layout-result' && message.result) task.resolve(message.result);
      else task.reject(new Error(message.message ?? 'Topology worker failed'));
    };
    worker.onerror = event => {
      for (const task of pendingLayouts.values()) task.reject(new Error(event.message || 'Topology worker failed'));
      pendingLayouts.clear();
      // D082-LAB-FIX3 BEGIN
      for (const task of pendingInquiries.values()) task.reject(new Error(event.message || 'Lull inquiry worker failed'));
      pendingInquiries.clear();
      // D082-LAB-FIX3 END
      worker.terminate();
      topologyWorker = null;
    };
    topologyWorker = worker;
    return worker;
  } catch { return null; }
}

export function computeTopologyLayoutAsync(id: Exclude<TopologyId, 'natural'>,
  snapshot: TopologySnapshot, dimension: TopologyDimension, indra: boolean): Promise<TopologyLayout> {
  const worker = embeddedTopologyWorker();
  if (!worker) return Promise.resolve().then(() => computeTopologyLayout(id, snapshot, dimension, indra));
  const requestId = ++nextLayoutRequest;
  return new Promise((resolve, reject) => {
    pendingLayouts.set(requestId, { resolve, reject });
    try { worker.postMessage({ kind: 'topology-layout', requestId, id, snapshot, dimension, indra }); }
    catch (error) { pendingLayouts.delete(requestId); reject(error); }
  });
}

// D082-LAB-FIX3 BEGIN
/** Build the Lull inquiry from the shared embedded projection worker. The page
 * filters eligible real relations before posting, so no callback crosses the
 * structured-clone boundary and the worker sees exactly the selected reading. */
export function computeLullInquiryAsync(snapshot: TopologySnapshot, selectedIds: ReadonlySet<string>,
  reading: string, eligible: (edge: TopologySnapshot['edges'][number]) => boolean): Promise<LullInquiry> {
  const filtered: TopologySnapshot = { ...snapshot, edges: snapshot.edges.filter(eligible) };
  const worker = embeddedTopologyWorker();
  // D082-LAB-FIX5 BEGIN: defer fallback validation so failures reject the promise.
  if (!worker) return Promise.resolve().then(() => buildLullInquiry(filtered, { selectedIds, reading }));
  // D082-LAB-FIX5 END
  const requestId = ++nextLayoutRequest;
  return new Promise((resolve, reject) => {
    pendingInquiries.set(requestId, { resolve, reject });
    try { worker.postMessage({ kind: 'lull-inquiry', requestId, snapshot: filtered, selectedIds: [...selectedIds], reading }); }
    catch (error) { pendingInquiries.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}
// D082-LAB-FIX3 END
// D082-LAB-FIX2 END
