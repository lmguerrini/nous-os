/** Renderer and organization independent, settled camera disclosure. All coordinates are viewport pixels. */
import { LOD_ENTER_INTERMEDIATE, LOD_ENTER_NEAR, LOD_EXIT_INTERMEDIATE, LOD_EXIT_NEAR } from './lod.ts';
import { V2_CAP, V2_PAGE, v2Visible } from './v2-core.ts';
import type { DisclosureState, V2Index, V2Node } from './v2-core.ts';

export const REVEAL_THRESHOLDS = [LOD_ENTER_INTERMEDIATE, 2.6, 3.7, LOD_ENTER_NEAR, 6.5, 8] as const;
export const REVEAL_EXIT_THRESHOLDS = [LOD_EXIT_INTERMEDIATE, 2, LOD_EXIT_NEAR, 4.2, 5.4, 6.8] as const;
export type RevealBand = 'far' | 'intermediate' | 'near' | 'deep';
/** Perspective ratio is a dolly distance. Its calibrated wheel gesture travels a shorter
 * numeric interval than Sigma's ratio, so map both to the same disclosure scale. */
export function cameraRevealZoom(fitRatio: number, liveRatio: number, projection: '2d' | '3d'): number {
  if (!Number.isFinite(fitRatio) || !Number.isFinite(liveRatio) || fitRatio <= 0 || liveRatio <= 0) return 1;
  return Math.max(0.1, Math.pow(fitRatio / liveRatio, projection === '3d' ? 2.5 : 1));
}
export type RevealSource = 'cursor' | 'selection' | 'viewport' | null;
export type RevealPosition = Readonly<{ x: number; y: number; radius?: number }>;
export type RevealAdmission = Readonly<{ parentId: string; count: number; threshold: number; band?: RevealBand; clusterId: string; order: number }>;
export type RevealRelease = Readonly<{ parentId: string; clusterId: string; band: RevealBand; cause: 'band-exit' | 'fit' | 'cap-eviction' }>;
export type RevealState = Readonly<{
  epoch: number; focusClusterId: string | null; focusSource: RevealSource;
  pendingFocusClusterId: string | null;
  lastZoom: number; band: RevealBand; tier: number; admissions: readonly RevealAdmission[];
  pendingPassages: readonly string[];
}>;
export type RevealInput = Readonly<{
  index: V2Index; disclosure: DisclosureState; zoom: number; settled: boolean;
  cursor: Readonly<{ x: number; y: number }> | null;
  selectionId: string | null; focusId: string | null;
  /** Only an intentional selection may preserve a focus path; hover is merely a camera anchor. */
  explicitFocusId?: string | null;
  fit?: boolean;
  viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  positions: ReadonlyMap<string, RevealPosition>;
  previous: RevealState;
  cap?: number; pageSize?: number; minZoomStep?: number;
}>;
export type RevealDecision = Readonly<{
  state: RevealState; auto: ReadonlyMap<string, number>;
  admittedIds: readonly string[]; evictedParentIds: readonly string[];
  released: readonly RevealRelease[];
  passageRequests: readonly string[]; disclosedIds: readonly string[];
  band: RevealBand; capped: boolean;
}>;

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
type Hierarchy = { byId: Map<string, V2Node>; children: Map<string, V2Node[]>; cluster: Map<string, string> };
const hierarchies = new WeakMap<V2Index, { count: number; value: Hierarchy }>();
function hierarchy(index: V2Index): Hierarchy {
  const cached = hierarchies.get(index);
  if (cached?.count === index.nodes.length) return cached.value;
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  const children = new Map<string, V2Node[]>(), cluster = new Map<string, string>();
  for (const node of index.nodes) if (node.parent) {
    const list = children.get(node.parent) ?? [];
    list.push(node); children.set(node.parent, list);
  }
  for (const [parentId, list] of children) list.sort((a, b) =>
    (byId.get(parentId)?.level === 1 ? a.level - b.level : 0) || cmp(a.id, b.id));
  const clusterOf = (id: string): string | null => {
    const known = cluster.get(id);
    if (known) return known;
    let node = byId.get(id); const path: string[] = [], seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      path.push(node.id); seen.add(node.id);
      if (node.level === 1) {
        for (const member of path) cluster.set(member, node.id);
        return node.id;
      }
      node = node.parent ? byId.get(node.parent) : undefined;
    }
    return null;
  };
  for (const node of index.nodes) clusterOf(node.id);
  const value = { byId, children, cluster };
  hierarchies.set(index, { count: index.nodes.length, value });
  return value;
}
/** Cached primary-parent membership for the page's focus and witness accounting. */
export function revealClusterOf(index: V2Index, id: string): string | null {
  return hierarchy(index).cluster.get(id) ?? null;
}
export const emptyRevealState = (zoom = 1): RevealState => ({
  epoch: 0, focusClusterId: null, focusSource: null, pendingFocusClusterId: null,
  lastZoom: zoom, band: 'far', tier: -1,
  admissions: [], pendingPassages: [],
});
/** A stationary pointer may change focus after confirmation, but cannot spend a zoom admission. */
export function focusOnlyReveal(previous: RevealState, sampled: RevealState): RevealState {
  return { ...previous, focusClusterId: sampled.focusClusterId, focusSource: sampled.focusSource,
    pendingFocusClusterId: sampled.pendingFocusClusterId, epoch: sampled.epoch };
}
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
  const { byId, children, cluster } = hierarchy(input.index);
  const clusterOf = (id: string): string | null => cluster.get(id) ?? null;
  const inside = (p: RevealPosition) => p.x >= input.viewport.x && p.x <= input.viewport.x + input.viewport.width &&
    p.y >= input.viewport.y && p.y <= input.viewport.y + input.viewport.height;
  const center = { x: input.viewport.x + input.viewport.width / 2, y: input.viewport.y + input.viewport.height / 2 };
  const current = v2Visible(input.index, input.disclosure, autoPages(input.previous.admissions), cap,
    input.previous.admissions.at(-1)?.parentId);
  const visible = new Set(current.nodes.map(node => node.id));
  const placed = current.nodes.filter(node => {
    const p = input.positions.get(node.id); return p && inside(p);
  });
  const nearest = (point: { x: number; y: number }, hit: boolean): V2Node | undefined => {
    let best: V2Node | undefined, bestDistance = Infinity;
    for (const node of placed) {
      const p = input.positions.get(node.id)!;
      const d = distance(p, point);
      if (hit && d > Math.max(32, p.radius ?? 12)) continue;
      if (d < bestDistance || d === bestDistance && best && cmp(node.id, best.id) < 0) {
        best = node; bestDistance = d;
      }
    }
    return best;
  };
  const cursorNode = input.cursor && nearest(input.cursor, true);
  const selected = input.selectionId && byId.has(input.selectionId) ? input.selectionId
    : input.focusId && byId.has(input.focusId) ? input.focusId : null;
  const centered = nearest(center, false);
  const sticky = input.cursor && input.previous.focusClusterId &&
    (input.zoom >= input.previous.lastZoom || input.zoom >= REVEAL_EXIT_THRESHOLDS[0])
    ? input.previous.focusClusterId : null;
  const cursorCluster = cursorNode ? clusterOf(cursorNode.id) : null;
  const anchor = cursorNode?.id ?? selected ?? centered?.id ?? null;
  const proposedSource: RevealSource = cursorCluster || sticky && input.cursor ? 'cursor' : selected ? 'selection' : centered ? 'viewport' : null;
  const proposedCluster = cursorCluster ?? sticky ?? (anchor ? clusterOf(anchor) : null);
  // A single settled projection can hit a neighbouring hub while the camera moves. The next
  // settled sample must confirm a cursor-driven switch before it starts a new reveal epoch.
  const pendingFocusClusterId = input.settled && cursorCluster && input.previous.focusClusterId &&
    cursorCluster !== input.previous.focusClusterId &&
    input.previous.pendingFocusClusterId !== cursorCluster ? cursorCluster : null;
  const clusterId = !input.settled || pendingFocusClusterId
    ? input.previous.focusClusterId : proposedCluster;
  const source = input.settled ? proposedSource : input.previous.focusSource;
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
  const protectedIds = new Set([input.selectionId, input.explicitFocusId, ...input.disclosure.manualOrder].filter((id): id is string => !!id));
  const protectedPath = new Set<string>();
  for (const id of protectedIds) {
    let node = byId.get(id); const seen = new Set<string>();
    while (node && !seen.has(node.id)) { seen.add(node.id); protectedPath.add(node.id); node = node.parent ? byId.get(node.parent) : undefined; }
  }
  const passages = new Set(input.previous.pendingPassages);
  const band = input.fit ? 'far' : input.settled ? revealBand(input.zoom, input.previous.band) : input.previous.band;
  const bandRank: Record<RevealBand, number> = { far: 0, intermediate: 1, near: 2, deep: 3 };
  const admissionBand = (item: RevealAdmission): RevealBand => item.band ?? revealBand(REVEAL_THRESHOLDS[item.threshold] ?? 1);
  const released: RevealRelease[] = [];
  if (input.settled && (input.fit || input.zoom < input.previous.lastZoom)) {
    while (tier >= 0 && input.zoom < REVEAL_EXIT_THRESHOLDS[tier]!) tier--;
    if (input.fit) tier = -1;
    admissions = admissions.filter(item => {
      if ((!input.fit && bandRank[admissionBand(item)] <= bandRank[band] && item.threshold <= tier) || protectedPath.has(item.parentId)) return true;
      released.push({ parentId: item.parentId, clusterId: item.clusterId, band: admissionBand(item),
        cause: input.fit ? 'fit' : 'band-exit' });
      return false;
    });
    for (const id of passages) if (!protectedPath.has(id) && !admissions.some(item => item.parentId === id)) passages.delete(id);
  }
  const admit = (threshold: number, parent: V2Node): void => {
    const before = new Set(v2Visible(input.index, input.disclosure, autoPages(admissions), cap,
      admissions.at(-1)?.parentId).nodes.map(node => node.id));
    const currentAuto = autoPages(admissions).get(parent.id);
    const available = children.get(parent.id) ?? [];
    const existing = currentAuto ?? (input.disclosure.overview && parent.level === 1
      ? available.filter(node => node.level === 2).length : 0);
    if (existing >= available.length || input.disclosure.expanded.has(parent.id)) return;
    const proposal: RevealAdmission = { parentId: parent.id,
      count: Math.min(currentAuto === undefined ? existing + page : page, available.length - (currentAuto ?? 0)),
      threshold, band, clusterId: clusterOf(parent.id)!, order: admissions.length ? Math.max(...admissions.map(a => a.order)) + 1 : 0 };
    let candidate = [...admissions, proposal];
    const wanted = Math.min(page, available.length - existing);
    const succeeds = (items: readonly RevealAdmission[]) => {
      const result = v2Visible(input.index, input.disclosure, autoPages(items), cap, parent.id);
      const now = new Set(result.nodes.map(node => node.id));
      return result.nodes.length <= cap &&
        available.slice(existing, existing + wanted).every(node => now.has(node.id) && !before.has(node.id)) &&
        (parent.level >= 3 && result.capped || [...autoPages(items)].every(([id, count]) =>
          (children.get(id) ?? []).slice(0, count).every(node => now.has(node.id))));
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
    if (succeeds(candidate)) {
      admissions = candidate; evicted.push(...removed);
      for (const victim of removed) for (const item of input.previous.admissions.filter(item => item.parentId === victim))
        released.push({ parentId: item.parentId, clusterId: item.clusterId, band: admissionBand(item), cause: 'cap-eviction' });
    }
  };
  const chooseParent = (threshold: number): V2Node | undefined => {
    const maxLevel = threshold >= 3 ? 4 : threshold >= 2 ? 3 : 2;
    const all = v2Visible(input.index, input.disclosure, autoPages(admissions), cap,
      admissions.at(-1)?.parentId).nodes;
    // A collapsed focused domain has only its level-1 root on screen. Open its first page
    // before looking for deeper parents; subsequent settled steps can follow those children.
    const root = clusterId ? byId.get(clusterId) : undefined;
    const rootHasHiddenChildren = !!root && all.some(node => node.id === root.id) &&
      (children.get(root.id)?.some(child => !all.some(node => node.id === child.id)) ?? false);
    if (rootHasHiddenChildren && (cursorNode?.id === root?.id ||
        !all.some(node => node.parent === root!.id))) return root;
    for (const cluster of clusterId ? [clusterId] : clusterOrder) {
      const candidates = all.filter(node => clusterOf(node.id) === cluster && node.level >= 2 && node.level <= maxLevel &&
        !input.disclosure.expanded.has(node.id) &&
        ((children.get(node.id)?.length ?? 0) > (autoPages(admissions).get(node.id) ?? 0) ||
          (node.level === 4 && !passages.has(node.id) && node.counts.passages > (children.get(node.id)?.length ?? 0))));
      candidates.sort((a, b) => {
        const pa = input.positions.get(a.id), pb = input.positions.get(b.id);
        const point = cluster === clusterId && input.cursor ? input.cursor : center;
        // Continue through the parent under the pointer before opening unrelated leaves.
        return Number(cursorNode?.level && cursorNode.level >= 3 && b.id === cursorNode.id) -
          Number(cursorNode?.level && cursorNode.level >= 3 && a.id === cursorNode.id) ||
          b.level - a.level || (pa ? distance(pa, point) : Infinity) - (pb ? distance(pb, point) : Infinity) || cmp(a.id, b.id);
      });
      if (candidates[0]) return candidates[0];
    }
    if (rootHasHiddenChildren) return root;
    return undefined;
  };
  if (!input.fit && band !== 'far' && input.settled && Number.isFinite(input.zoom) && input.zoom > input.previous.lastZoom &&
      input.zoom >= input.previous.lastZoom * (input.minZoomStep ?? 1)) {
    // One admission per settled camera step, even if several numeric thresholds were crossed
    // or no threshold was crossed inside a broad LOD band.
    const reached = REVEAL_THRESHOLDS.reduce((last, threshold, index) => input.zoom >= threshold ? index : last, -1);
    tier = Math.min(REVEAL_THRESHOLDS.length - 1, Math.max(tier + 1, reached));
    const parent = chooseParent(tier);
    if (parent) {
      const loaded = children.get(parent.id)?.length ?? 0;
      if (parent.level === 4 && parent.counts.passages > loaded &&
          (autoPages(admissions).get(parent.id) ?? 0) >= loaded) {
        if (!passages.has(parent.id)) requests.push(parent.id);
        passages.add(parent.id);
      } else admit(tier, parent);
    }
  }
  // A fetch completion can materialize its page at the same camera threshold.
  for (const id of input.fit ? [] : [...passages]) if ((children.get(id)?.length ?? 0) > (autoPages(admissions).get(id) ?? 0)) {
    const parent = byId.get(id);
    const previousCount = autoPages(admissions).get(id) ?? 0;
    if (parent && input.settled) admit(tier, parent);
    if ((autoPages(admissions).get(id) ?? 0) > previousCount) passages.delete(id);
  }
  const auto = autoPages(admissions);
  const after = v2Visible(input.index, input.disclosure, auto, cap, admissions.at(-1)?.parentId);
  return { state: { epoch, focusClusterId: clusterId, focusSource: source, pendingFocusClusterId,
      lastZoom: input.settled && Number.isFinite(input.zoom) ? input.zoom : input.previous.lastZoom, band, tier,
      admissions, pendingPassages: [...passages].sort(cmp) }, auto,
    admittedIds: after.nodes.map(node => node.id).filter(id => !visible.has(id)).sort(cmp),
    evictedParentIds: [...new Set(evicted)].sort(cmp), released, passageRequests: requests.sort(cmp),
    disclosedIds: after.nodes.map(node => node.id), band, capped: after.capped };
}
