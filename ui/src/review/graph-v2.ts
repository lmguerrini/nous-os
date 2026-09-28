/** Validated, renderer independent progressive disclosure for review graph v2. */
export interface GraphNode {
  id: string;
  level: 1 | 2 | 3 | 4;
  kind: string;
  subkind?: string;
  status?: string;
  parent: string | null;
  parents: string[];
  domains: string[];
  domain_mentions?: string[];
  primary_domain?: string;
  primary_domain_anchors?: Record<string, number>;
  title: string;
  display_label?: string;
  title_full: string;
  date?: string;
  origin?: string;
  snippet?: string;
  importance: { value: number; components: Record<string, number> };
  size: number;
  counts: { children: number; descendants: number; canon: number; passages: number; live_proposals?: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  class: 'attested' | 'exploratory';
  type: string;
  directed: boolean;
  evidence: unknown[];
  explanation?: string;
  inference?: string;
  confidence?: string;
  counter_evidence?: unknown[];
  status?: 'exploratory/non-canonical';
}

export interface GraphIndex { schema: 'nousos.review-graph/2'; nodes: GraphNode[]; edges: GraphEdge[] }
export interface GraphManifest { schema: 'nousos.review-graph/2'; digest: string; counts: Record<string, unknown>; limits: Record<string, number> }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateIndex(value: unknown): GraphIndex {
  if (!object(value) || value.schema !== 'nousos.review-graph/2' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('Invalid review graph index');
  }
  const ids = new Set<string>();
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of value.nodes) {
    if (!object(node) || typeof node.id !== 'string' || ids.has(node.id) || ![1, 2, 3, 4].includes(Number(node.level)) ||
        typeof node.kind !== 'string' || typeof node.title !== 'string' || typeof node.title_full !== 'string' ||
        (node.display_label !== undefined && typeof node.display_label !== 'string') ||
        !(node.parent === null || typeof node.parent === 'string') ||
        !Array.isArray(node.parents) || !node.parents.every(p => typeof p === 'string') ||
        !Array.isArray(node.domains) || !node.domains.every(d => typeof d === 'string') ||
        (node.domain_mentions !== undefined && (!Array.isArray(node.domain_mentions) || !node.domain_mentions.every(d => typeof d === 'string'))) ||
        (node.primary_domain !== undefined && typeof node.primary_domain !== 'string') ||
        !object(node.counts) || !['children', 'descendants', 'canon', 'passages'].every(k => Number.isInteger((node.counts as Record<string, unknown>)[k]) && Number((node.counts as Record<string, unknown>)[k]) >= 0) ||
        !object(node.importance) || typeof node.importance.value !== 'number' || !object(node.importance.components) ||
        typeof node.size !== 'number' || node.size < 0 || node.size > 1) {
      throw new Error('Invalid review graph node');
    }
    ids.add(node.id);
    nodeById.set(node.id, node);
  }
  for (const node of value.nodes) {
    if (node.parent !== null) {
      const parent = nodeById.get(node.parent);
      if (!parent || Number(parent.level) >= Number(node.level)) throw new Error('Invalid review graph parent');
    }
  }
  for (const edge of value.edges) {
    if (!object(edge) || typeof edge.id !== 'string' || !ids.has(String(edge.source)) || !ids.has(String(edge.target)) ||
        !['attested', 'exploratory'].includes(String(edge.class)) || typeof edge.type !== 'string' ||
        typeof edge.directed !== 'boolean' || !Array.isArray(edge.evidence) ||
        (edge.class === 'exploratory' && (edge.status !== 'exploratory/non-canonical' || typeof edge.explanation !== 'string'))) {
      throw new Error('Invalid review graph edge');
    }
  }
  return value as unknown as GraphIndex;
}

export function displayLabel(node: Pick<GraphNode, 'title' | 'display_label'>): string {
  return node.display_label ?? node.title;
}

export function presentationText(node: Pick<GraphNode, 'title' | 'display_label' | 'title_full'>): { short: string; full: string } {
  return { short: displayLabel(node), full: node.title_full };
}

export async function loadGraphV2(fetcher: typeof fetch = fetch, base = ''): Promise<{ manifest: GraphManifest; index: GraphIndex }> {
  const [manifestResponse, indexResponse] = await Promise.all([
    fetcher(`${base}/api/graph/manifest`), fetcher(`${base}/api/graph/index`),
  ]);
  if (!manifestResponse.ok || !indexResponse.ok) throw new Error('Review graph fetch failed');
  const manifest: unknown = await manifestResponse.json();
  if (!object(manifest) || manifest.schema !== 'nousos.review-graph/2' ||
      typeof manifest.digest !== 'string' || !object(manifest.counts) || !object(manifest.limits)) {
    throw new Error('Invalid review graph manifest');
  }
  return { manifest: manifest as unknown as GraphManifest, index: validateIndex(await indexResponse.json()) };
}

export function hierarchy(index: GraphIndex): { byId: Map<string, GraphNode>; children: Map<string, string[]>; ancestors: Map<string, string[]> } {
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  const ancestors = new Map<string, string[]>();
  for (const node of index.nodes) {
    if (node.parent !== null) children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
  }
  for (const list of children.values()) list.sort();
  for (const node of index.nodes) {
    const path: string[] = [];
    let parent = node.parent;
    const seen = new Set<string>();
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      path.unshift(parent);
      parent = byId.get(parent)?.parent ?? null;
    }
    ancestors.set(node.id, path);
  }
  return { byId, children, ancestors };
}

export const DEFAULT_VISIBLE_CAP = 400;
export interface Disclosure {
  expanded: Set<string>;
  visibleNodes: GraphNode[];
  visibleEdges: GraphEdge[];
  hiddenChildren: Map<string, number>;
  limitReached: boolean;
  reason?: string;
}

export function disclose(index: GraphIndex, expanded: ReadonlySet<string>, cap = DEFAULT_VISIBLE_CAP): Disclosure {
  if (!Number.isInteger(cap) || cap < 1) throw new Error('Visible node cap must be positive');
  const tree = hierarchy(index);
  const visibleNodes: GraphNode[] = [];
  const hiddenChildren = new Map<string, number>();
  const queue = index.nodes.filter(node => node.parent === null).map(node => node.id).sort();
  let limitReached = false;
  while (queue.length) {
    const id = queue.shift()!;
    const node = tree.byId.get(id)!;
    if (visibleNodes.length >= cap) { limitReached = true; break; }
    visibleNodes.push(node);
    const descendants = tree.children.get(id) ?? [];
    if (expanded.has(id)) queue.push(...descendants);
    else if (descendants.length || node.counts.passages) hiddenChildren.set(id, node.counts.children);
  }
  if (limitReached) {
    for (const id of queue) {
      const node = tree.byId.get(id);
      if (node?.parent) hiddenChildren.set(node.parent, (hiddenChildren.get(node.parent) ?? 0) + 1);
    }
  }
  const ids = new Set(visibleNodes.map(node => node.id));
  return { expanded: new Set(expanded), visibleNodes,
    visibleEdges: index.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    hiddenChildren, limitReached, ...(limitReached ? { reason: `Visible node cap of ${cap} reached` } : {}) };
}

export function collapse(index: GraphIndex, expanded: ReadonlySet<string>, id: string): Set<string> {
  const tree = hierarchy(index);
  const next = new Set(expanded);
  next.delete(id);
  for (const [child, ancestors] of tree.ancestors) if (ancestors.includes(id)) next.delete(child);
  return next;
}

export function revealPath(index: GraphIndex, expanded: ReadonlySet<string>, id: string, cap = DEFAULT_VISIBLE_CAP): Disclosure {
  const tree = hierarchy(index);
  if (!tree.byId.has(id)) throw new Error('Unknown review graph node');
  const next = new Set(expanded);
  for (const ancestor of tree.ancestors.get(id) ?? []) next.add(ancestor);
  return disclose(index, next, cap);
}
