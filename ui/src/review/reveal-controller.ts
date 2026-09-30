/** Renderer and organization independent, settled camera disclosure. All coordinates are viewport pixels. */
import { LOD_ENTER_INTERMEDIATE, LOD_ENTER_NEAR, LOD_EXIT_INTERMEDIATE, LOD_EXIT_NEAR } from './lod.ts';
import { V2_CAP, V2_PAGE, v2Visible } from './v2-core.ts';
import type { DisclosureState, V2Index, V2Node } from './v2-core.ts';

export const REVEAL_THRESHOLDS = [LOD_ENTER_INTERMEDIATE, 2.6, 3.7, LOD_ENTER_NEAR, 6.5, 8] as const;
export const REVEAL_EXIT_THRESHOLDS = [LOD_EXIT_INTERMEDIATE, 2, LOD_EXIT_NEAR, 4.2, 5.4, 6.8] as const;
export type RevealBand = 'far' | 'intermediate' | 'near' | 'deep';
export type RevealSource = 'cursor' | 'selection' | 'viewport' | null;
export type RevealPosition = Readonly<{ x: number; y: number; radius?: number }>;
export type RevealAdmission = Readonly<{ parentId: string; count: number; threshold: number; clusterId: string; order: number }>;
export type RevealState = Readonly<{
  epoch: number; focusClusterId: string | null; focusSource: RevealSource;
  lastZoom: number; band: RevealBand; tier: number; admissions: readonly RevealAdmission[];
  pendingPassages: readonly string[];
}>;
export type RevealInput = Readonly<{
  index: V2Index; disclosure: DisclosureState; zoom: number; settled: boolean;
  cursor: Readonly<{ x: number; y: number }> | null;
  selectionId: string | null; focusId: string | null;
  viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  positions: ReadonlyMap<string, RevealPosition>;
  previous: RevealState;
  cap?: number; pageSize?: number;
}>;
export type RevealDecision = Readonly<{
  state: RevealState; auto: ReadonlyMap<string, number>;
  admittedIds: readonly string[]; evictedParentIds: readonly string[];
  passageRequests: readonly string[]; disclosedIds: readonly string[];
  band: RevealBand; capped: boolean;
}>;

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export const emptyRevealState = (zoom = 1): RevealState => ({
  epoch: 0, focusClusterId: null, focusSource: null, lastZoom: zoom, band: 'far', tier: -1,
  admissions: [], pendingPassages: [],
});
export function revealBand(zoom: number, previous: RevealBand = 'far'): RevealBand {
  if (!Number.isFinite(zoom)) return previous;
  if (previous === 'deep' && zoom >= REVEAL_EXIT_THRESHOLDS[4]) return 'deep';
  if (zoom >= REVEAL_THRESHOLDS[4]) return 'deep';
  if ((previous === 'near' || previous === 'deep') && zoom >= LOD_EXIT_NEAR) return 'near';
  if (zoom >= REVEAL_THRESHOLDS[3]) return 'near';
  if (previous !== 'far' && zoom >= LOD_EXIT_INTERMEDIATE) return 'intermediate';
  return zoom >= REVEAL_THRESHOLDS[0] ? 'intermediate' : 'far';
}
export function autoPages(admissions: readonly RevealAdmission[]): Map<string, number> {
  const pages = new Map<string, number>();
  for (const item of admissions) pages.set(item.parentId, (pages.get(item.parentId) ?? 0) + item.count);
  return pages;
}

/** One bounded page per crossed inward threshold, with reverse thresholds for compaction. */
export function stepReveal(input: RevealInput): RevealDecision {
  const cap = Math.max(1, Math.min(V2_CAP, Math.floor(input.cap ?? V2_CAP)));
  const page = Math.max(1, Math.min(V2_PAGE, Math.floor(input.pageSize ?? V2_PAGE)));
  const byId = new Map(input.index.nodes.map(node => [node.id, node]));
  const children = new Map<string, V2Node[]>();
  for (const node of input.index.nodes) if (node.parent) {
    const list = children.get(node.parent) ?? [];
    list.push(node); children.set(node.parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => cmp(a.id, b.id));
  const clusterOf = (id: string): string | null => {
    let node = byId.get(id); const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      if (node.level === 1) return node.id;
      seen.add(node.id); node = node.parent ? byId.get(node.parent) : undefined;
    }
    return null;
  };
  const inside = (p: RevealPosition) => p.x >= input.viewport.x && p.x <= input.viewport.x + input.viewport.width &&
    p.y >= input.viewport.y && p.y <= input.viewport.y + input.viewport.height;
  const center = { x: input.viewport.x + input.viewport.width / 2, y: input.viewport.y + input.viewport.height / 2 };
  const current = v2Visible(input.index, input.disclosure, autoPages(input.previous.admissions), cap);
  const visible = new Set(current.nodes.map(node => node.id));
  const placed = current.nodes.filter(node => {
    const p = input.positions.get(node.id); return p && inside(p);
  });
  const nearest = (point: { x: number; y: number }, hit: boolean): V2Node | undefined =>
    placed.filter(node => {
      const p = input.positions.get(node.id)!;
      return !hit || distance(p, point) <= (p.radius ?? 12);
    }).sort((a, b) => distance(input.positions.get(a.id)!, point) - distance(input.positions.get(b.id)!, point) || cmp(a.id, b.id))[0];
  const cursorNode = input.cursor && nearest(input.cursor, true);
  const selected = input.selectionId && byId.has(input.selectionId) ? input.selectionId
    : input.focusId && byId.has(input.focusId) ? input.focusId : null;
  const centered = nearest(center, false);
  const anchor = cursorNode?.id ?? selected ?? centered?.id ?? null;
  const source: RevealSource = cursorNode ? 'cursor' : selected ? 'selection' : centered ? 'viewport' : null;
  const clusterId = anchor ? clusterOf(anchor) : null;
  const epoch = input.previous.epoch + (clusterId !== input.previous.focusClusterId ? 1 : 0);
  const clusterOrder = [...new Set([
    clusterId,
    selected ? clusterOf(selected) : null,
    ...placed.sort((a, b) => distance(input.positions.get(a.id)!, center) - distance(input.positions.get(b.id)!, center) || cmp(a.id, b.id))
      .map(node => clusterOf(node.id)),
  ].filter((id): id is string => id !== null))];
  let admissions = [...input.previous.admissions];
  let tier = input.previous.tier;
  const evicted: string[] = [], requests: string[] = [];
  const protectedIds = new Set([input.selectionId, input.focusId, ...input.disclosure.manualOrder].filter((id): id is string => !!id));
  const protectedPath = new Set<string>();
  for (const id of protectedIds) {
    let node = byId.get(id); const seen = new Set<string>();
    while (node && !seen.has(node.id)) { seen.add(node.id); protectedPath.add(node.id); node = node.parent ? byId.get(node.parent) : undefined; }
  }
  const passages = new Set(input.previous.pendingPassages);
  if (input.settled && input.zoom < input.previous.lastZoom) {
    while (tier >= 0 && input.zoom < REVEAL_EXIT_THRESHOLDS[tier]!) tier--;
    admissions = admissions.filter(item => item.threshold <= tier || protectedPath.has(item.parentId));
  }
  const admit = (threshold: number, parent: V2Node): void => {
    const before = new Set(v2Visible(input.index, input.disclosure, autoPages(admissions), cap).nodes.map(node => node.id));
    const existing = autoPages(admissions).get(parent.id) ?? 0;
    const available = children.get(parent.id) ?? [];
    if (existing >= available.length || input.disclosure.expanded.has(parent.id)) return;
    const proposal: RevealAdmission = { parentId: parent.id, count: Math.min(page, available.length - existing),
      threshold, clusterId: clusterOf(parent.id)!, order: admissions.length ? Math.max(...admissions.map(a => a.order)) + 1 : 0 };
    let candidate = [...admissions, proposal];
    const wanted = Math.min(page, available.length - existing);
    const succeeds = (items: readonly RevealAdmission[]) => {
      const result = v2Visible(input.index, input.disclosure, autoPages(items), cap);
      const now = new Set(result.nodes.map(node => node.id));
      return result.nodes.length <= cap &&
        available.slice(existing, existing + wanted).every(node => now.has(node.id) && !before.has(node.id)) &&
        [...autoPages(items)].every(([id, count]) =>
          (children.get(id) ?? []).slice(0, count).every(node => now.has(node.id)));
    };
    const removed: string[] = [];
    if (!succeeds(candidate)) {
      const victims = admissions.filter(item => item.clusterId !== clusterId && !protectedPath.has(item.parentId))
        .sort((a, b) => {
          const rank = (id: string) => { const index = clusterOrder.indexOf(id); return index < 0 ? Infinity : index; };
          return rank(b.clusterId) - rank(a.clusterId) || a.order - b.order;
        });
      for (const victim of victims) {
        candidate = candidate.filter(item => item !== victim); removed.push(victim.parentId);
        if (succeeds(candidate)) break;
      }
    }
    if (succeeds(candidate)) { admissions = candidate; evicted.push(...removed); }
  };
  const chooseParent = (threshold: number): V2Node | undefined => {
    const maxLevel = threshold >= 4 ? 4 : threshold >= 2 ? 3 : 2;
    const all = v2Visible(input.index, input.disclosure, autoPages(admissions), cap).nodes;
    for (const cluster of clusterOrder) {
      const candidates = all.filter(node => clusterOf(node.id) === cluster && node.level >= 2 && node.level <= maxLevel &&
        !input.disclosure.expanded.has(node.id) &&
        ((children.get(node.id)?.length ?? 0) > (autoPages(admissions).get(node.id) ?? 0) ||
          (node.level === 4 && node.counts.passages > (children.get(node.id)?.length ?? 0))));
      candidates.sort((a, b) => {
        const pa = input.positions.get(a.id), pb = input.positions.get(b.id);
        const point = cluster === clusterId && input.cursor ? input.cursor : center;
        return b.level - a.level || (pa ? distance(pa, point) : Infinity) - (pb ? distance(pb, point) : Infinity) || cmp(a.id, b.id);
      });
      if (candidates[0]) return candidates[0];
    }
    return undefined;
  };
  if (input.settled && Number.isFinite(input.zoom) && input.zoom > input.previous.lastZoom) {
    for (let next = tier + 1; next < REVEAL_THRESHOLDS.length && input.zoom >= REVEAL_THRESHOLDS[next]!; next++) {
      tier = next;
      const parent = chooseParent(next);
      if (!parent) continue;
      const loaded = children.get(parent.id)?.length ?? 0;
      if (parent.level === 4 && parent.counts.passages > loaded &&
          (autoPages(admissions).get(parent.id) ?? 0) >= loaded) {
        if (!passages.has(parent.id)) requests.push(parent.id);
        passages.add(parent.id);
      } else admit(next, parent);
    }
  }
  // A fetch completion can materialize its page at the same camera threshold.
  for (const id of [...passages]) if ((children.get(id)?.length ?? 0) > (autoPages(admissions).get(id) ?? 0)) {
    const parent = byId.get(id);
    const previousCount = autoPages(admissions).get(id) ?? 0;
    if (parent && input.settled && tier >= 4) admit(tier, parent);
    if ((autoPages(admissions).get(id) ?? 0) > previousCount) passages.delete(id);
  }
  const auto = autoPages(admissions);
  const after = v2Visible(input.index, input.disclosure, auto, cap);
  const band = input.settled ? revealBand(input.zoom, input.previous.band) : input.previous.band;
  return { state: { epoch, focusClusterId: clusterId, focusSource: source,
      lastZoom: input.settled && Number.isFinite(input.zoom) ? input.zoom : input.previous.lastZoom, band, tier,
      admissions, pendingPassages: [...passages].sort(cmp) }, auto,
    admittedIds: after.nodes.map(node => node.id).filter(id => !visible.has(id)).sort(cmp),
    evictedParentIds: [...new Set(evicted)].sort(cmp), passageRequests: requests.sort(cmp),
    disclosedIds: after.nodes.map(node => node.id), band, capped: after.capped };
}
