/** D-072 L1 — semantic level of detail, pure of every renderer and the DOM.
 *
 * Three camera levels (far, intermediate, near) with hysteresis bands, three density settings
 * (Essenziale, Bilanciata, Completa) and the separate adaptive budgets for nodes, arcs and
 * labels requested for the page. Everything here is a deterministic fold over its inputs: the
 * same disclosed graph, level, density and focus always produce the same rendered set, with
 * ids as the only tie-breaker.
 *
 * The page computes the layout over the whole disclosed set and applies these selections as a
 * pure render filter, so changing the level or the density never moves a node: coordinates of
 * the nodes that stay visible are the layout's own incremental, seeded positions.
 */

/** Semantic level of detail driven by the camera, with hysteresis. */
export type LodLevel = "far" | "intermediate" | "near";

/** How many nodes, arcs and labels each density admits. «Completa» is never all arcs at once. */
export type Density = "essential" | "balanced" | "complete";

export const DENSITIES: readonly Density[] = ["essential", "balanced", "complete"];

export type LodBudget = {
  readonly nodes: number;
  readonly arcs: number;
  readonly labels: number;
};

/** Adaptive budgets per density: Essenziale ≈ 150/150/20, Bilanciata (default) ≈ 400/450/40,
 * Completa up to the 850-node cap with at most ≈ 1 200 arcs and 60 labels. */
export const DENSITY_BUDGETS: Readonly<Record<Density, LodBudget>> = {
  essential: { nodes: 150, arcs: 150, labels: 20 },
  balanced: { nodes: 400, arcs: 450, labels: 40 },
  complete: { nodes: 850, arcs: 1200, labels: 60 },
};

export function normalizeDensity(value: unknown, fallback: Density = "balanced"): Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value)
    ? (value as Density)
    : fallback;
}

/** Camera magnification (1 = fitted overview) at which a level is entered, and the lower edge of
 * its hysteresis band. Between the exit and the enter value the level never changes, so small
 * wheel movements back and forth — a notch is roughly a 1.1× step — can neither add nor remove
 * elements. The bands are wider than a full notch on each side. */
export const LOD_ENTER_INTERMEDIATE = 1.9;
export const LOD_EXIT_INTERMEDIATE = 1.2;
export const LOD_ENTER_NEAR = 4.75;
export const LOD_EXIT_NEAR = 3;

/** The LOD level for a camera magnification, given the previous level. Pure: the previous level
 * carries the hysteresis, so the function is stable for a jittering zoom inside a band and only
 * changes when a band is truly crossed. */
export function lodLevelFromZoom(zoom: number, previous: LodLevel): LodLevel {
  if (!Number.isFinite(zoom)) return previous;
  if (previous === "near") return zoom < LOD_EXIT_NEAR ? "intermediate" : "near";
  if (previous === "intermediate") {
    if (zoom >= LOD_ENTER_NEAR) return "near";
    if (zoom < LOD_EXIT_INTERMEDIATE) return "far";
    return "intermediate";
  }
  return zoom >= LOD_ENTER_INTERMEDIATE ? "intermediate" : "far";
}

/** One node as the LOD sees it: structural role, then importance. */
export type LodNodeInfo = {
  readonly id: string;
  readonly level: number;
  readonly parent: string | null;
  readonly importance: number;
};

/** One relation candidate as the LOD sees it. */
export type LodArcInfo = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly class: "attested" | "exploratory";
  readonly count: number;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The community of a node: its level-1 ancestor (itself for a domain). Pure, memoized; the
 * resolver walks the declared parent chain only and falls back to the node itself. */
export function communityResolver(
  nodes: readonly { id: string; level: number; parent: string | null }[],
): (id: string) => string {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const cache = new Map<string, string>();
  const communityOf = (id: string): string => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const found: string[] = [];
    let cursor = byId.get(id);
    const seen = new Set<string>();
    let root = id;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      root = cursor.id;
      found.push(cursor.id);
      if (cursor.level === 1 || !cursor.parent) break;
      cursor = byId.get(cursor.parent);
    }
    for (const visited of found) cache.set(visited, root);
    return root;
  };
  return communityOf;
}

/** Undirected adjacency over the available nodes: every relation plus the parent-child links,
 * neighbour lists deduplicated and sorted. Feeds the near-level neighbourhood walk and the
 * hub ranking. */
export function adjacencyOf(
  nodes: readonly { id: string; parent: string | null }[],
  edges: readonly { source: string; target: string }[],
): Map<string, readonly string[]> {
  const ids = new Set(nodes.map(node => node.id));
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    (links.get(a) ?? links.set(a, new Set()).get(a)!).add(b);
    (links.get(b) ?? links.set(b, new Set()).get(b)!).add(a);
  };
  for (const edge of edges) link(edge.source, edge.target);
  for (const node of nodes) if (node.parent) link(node.parent, node.id);
  const adjacency = new Map<string, readonly string[]>();
  for (const id of ids) adjacency.set(id, [...(links.get(id) ?? [])].sort(compare));
  return adjacency;
}

/** How far the near level walks out of the focus: two hops, the neighbourhood depth. */
export const NEAR_HOPS = 2;

export type SelectNodesInput = {
  readonly nodes: readonly LodNodeInfo[];
  readonly level: LodLevel;
  readonly budget: number;
  /** The explicit set: the selection with its parents, the hovered focus, and every child of a
   * node the user expanded by hand. Kept even when the budget is tight. */
  readonly pinned: ReadonlySet<string>;
  /** The node or domain the reading is about; drives the near-level neighbourhood. */
  readonly focus: string | null;
  /** Visible members of the selected aggregate, admitted before ordinary LOD fill. */
  readonly priority?: ReadonlySet<string>;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly communityOf: (id: string) => string;
};

export type LodNodeSelection = {
  /** The rendered ids in deterministic selection order (pinned first). */
  readonly rendered: readonly string[];
  /** The available ids left out, sorted by id. */
  readonly dropped: readonly string[];
};

/** Choose the nodes actually rendered from the available (disclosed) set.
 *
 * Structural role first, then importance, ids as the only tie-breaker:
 * 1. the explicit set (selection with its parents, focus, children of a manual expansion);
 * 2. the domains, which anchor every level;
 * 3. near only: the focus neighbourhood, two hops;
 * 4. the aggregate tier (level 2) by importance;
 * 5. far: hubs by relation degree; intermediate and near: the principal nodes of each
 *    community, round-robin by importance so no community hogs the budget.
 *
 * Pinned ids are kept even beyond the budget: an explicit user action wins and lower-priority
 * elements give way. */
export function selectNodes(input: SelectNodesInput): LodNodeSelection {
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const rendered: string[] = [];
  const kept = new Set<string>();
  const room = () => kept.size < input.budget;
  const add = (id: string, force = false): void => {
    if (!byId.has(id) || kept.has(id)) return;
    if (!force && !room()) return;
    kept.add(id);
    rendered.push(id);
  };
  for (const id of [...input.pinned].sort(compare)) add(id, true);
  for (const node of [...input.nodes].filter(node => node.level === 1).sort((a, b) => compare(a.id, b.id))) add(node.id);
  for (const node of [...input.nodes].filter(node => input.priority?.has(node.id)).sort((a, b) => b.importance - a.importance || compare(a.id, b.id))) add(node.id);
  if (input.level === "near" && input.focus && byId.has(input.focus)) {
    add(input.focus);
    const seen = new Set([input.focus]);
    let frontier = [input.focus];
    for (let depth = 0; depth < NEAR_HOPS && room(); depth++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const neighbour of input.adjacency.get(id) ?? []) {
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          next.push(neighbour);
        }
      next.sort(compare);
      for (const id of next) add(id);
      frontier = next;
    }
  }
  const byImportance = (a: LodNodeInfo, b: LodNodeInfo) => b.importance - a.importance || compare(a.id, b.id);
  for (const node of [...input.nodes].filter(node => node.level === 2).sort(byImportance)) add(node.id);
  if (input.level === "far") {
    const hubs = [...input.nodes]
      .filter(node => node.level >= 3)
      .sort((a, b) => (input.adjacency.get(b.id)?.length ?? 0) - (input.adjacency.get(a.id)?.length ?? 0)
        || byImportance(a, b));
    for (const hub of hubs) add(hub.id);
  } else {
    const communities = new Map<string, LodNodeInfo[]>();
    for (const node of input.nodes)
      if (node.level === 3 || node.level === 4) {
        const key = input.communityOf(node.id);
        communities.set(key, [...(communities.get(key) ?? []), node]);
      }
    for (const list of communities.values()) list.sort(byImportance);
    const keys = [...communities.keys()].sort(compare);
    // D-072 FixC (X7): the round-robin walks to the longest community's length, so a community
    // shorter than the current round simply has no principal to offer that round — skip it
    // instead of reading past its end (`communities.get(key)[round]` of a short community was
    // the crash that emptied the labels when the zoom crossed into the intermediate level).
    const rounds = keys.reduce((most, key) => Math.max(most, communities.get(key)!.length), 0);
    for (let round = 0; round < rounds && room(); round++)
      for (const key of keys) {
        if (!room()) break;
        const principal = communities.get(key)![round];
        if (principal !== undefined) add(principal.id);
      }
  }
  return { rendered, dropped: [...byId.keys()].filter(id => !kept.has(id)).sort(compare) };
}

/** The log-once guard behind `safeSelectNodes`: a failing selection is insurance, not a
 * condition to narrate — the first failure is reported, the rest fall back in silence. */
let lodSelectionFailureLogged = false;
/** Test-only: re-arms the once-per-session failure log. */
export function resetLodSelectionFailureLog(): void {
  lodSelectionFailureLogged = false;
}

/** D-072 FixC (X7): the selection the page may actually use. A LOD selection failure must never
 * take the drawing down with it — `selectNodes` is pure and total by contract, but the guarantee
 * needed is behavioural: on any throw the previous selection survives verbatim (the
 * view keeps drawing exactly what it drew, labels included) and the failure is logged once per
 * session. Without a previous selection (the very first refresh) the degraded answer is the
 * always-safe tier: the pinned ids, which no level rule can drop. */
export function safeSelectNodes(
  input: SelectNodesInput,
  previous: LodNodeSelection | null,
): LodNodeSelection {
  try {
    return selectNodes(input);
  } catch (error) {
    if (!lodSelectionFailureLogged) {
      lodSelectionFailureLogged = true;
      console.error("[d072] LOD selection failed, keeping the previous selection", error);
    }
    if (previous !== null) return previous;
    const available = new Set(input.nodes.map(node => node.id));
    const rendered = [...input.pinned].filter(id => available.has(id)).sort(compare);
    return { rendered, dropped: [...available].filter(id => !input.pinned.has(id)).sort(compare) };
  }
}

/** Share of the arc budget reserved for exploratory relations when the reading shows them, so
 * weightier attested arcs cannot crowd the exploratory reading out of the picture. */
export const EXPLORATORY_RESERVE_SHARE = 0.35;

export type SelectArcsInput = {
  readonly arcs: readonly LodArcInfo[];
  readonly budget: number;
  /** Arc ids always kept: the selected relation, the contains path of the selection, the arcs a
   * manual expansion opened. */
  readonly pinned: ReadonlySet<string>;
  /** The focus node; its relations come right after the pinned ones and are never hidden. */
  readonly focus: string | null;
  /** Focus's strongest bridges and internal relations before ordinary LOD fill. */
  readonly priority?: readonly string[];
  readonly communityOf: (id: string) => string;
  /** True whenever the reading is not attested-only. */
  readonly keepExploratory: boolean;
};

/** Ids admitted outside the arc budget: explicit pins and every relation incident to focus. */
export function forcedArcIds(input: Pick<SelectArcsInput, "arcs" | "pinned" | "focus">): readonly string[] {
  const forced = new Set<string>();
  const available = new Set(input.arcs.map(arc => arc.id));
  for (const id of [...input.pinned].sort(compare)) if (available.has(id)) forced.add(id);
  if (input.focus !== null)
    for (const arc of [...input.arcs].sort((a, b) => compare(a.id, b.id)))
      if (arc.source === input.focus || arc.target === input.focus) forced.add(arc.id);
  return [...forced];
}

/** Choose the arcs actually drawn. Priority order, deterministic within each tier (count
 * descending, then id): 1. selected or focus; 2. bridges between communities; 3. attested by
 * weight; 4. exploratory — kept visible within the budget whenever the reading shows them, at
 * which point the lowest-priority non-bridge attested arcs give way. */
export function selectArcs(input: SelectArcsInput): readonly string[] {
  const byId = new Map(input.arcs.map(arc => [arc.id, arc]));
  const chosen: string[] = [];
  const kept = new Set<string>();
  const take = (id: string, force = false): void => {
    if (!byId.has(id) || kept.has(id)) return;
    if (!force && kept.size >= input.budget) return;
    kept.add(id);
    chosen.push(id);
  };
  const incident = (arc: LodArcInfo): boolean =>
    input.focus !== null && (arc.source === input.focus || arc.target === input.focus);
  for (const id of forcedArcIds(input)) take(id, true);
  for (const id of input.priority ?? []) take(id);
  const isBridge = (arc: LodArcInfo): boolean => input.communityOf(arc.source) !== input.communityOf(arc.target);
  const byWeight = (a: LodArcInfo, b: LodArcInfo) => b.count - a.count || compare(a.id, b.id);
  const bridges: LodArcInfo[] = [];
  const attested: LodArcInfo[] = [];
  const exploratory: LodArcInfo[] = [];
  for (const arc of input.arcs) {
    if (kept.has(arc.id)) continue;
    if (isBridge(arc)) bridges.push(arc);
    else if (arc.class === "exploratory") exploratory.push(arc);
    else attested.push(arc);
  }
  bridges.sort(byWeight);
  attested.sort(byWeight);
  exploratory.sort(byWeight);
  for (const arc of [...bridges, ...attested, ...exploratory]) take(arc.id);
  if (input.keepExploratory) {
    const available = input.arcs.filter(arc => arc.class === "exploratory").length;
    const target = Math.min(available, Math.floor(input.budget * EXPLORATORY_RESERVE_SHARE));
    const pending = exploratory.filter(arc => !kept.has(arc.id));
    while (chosen.filter(id => byId.get(id)!.class === "exploratory").length < target && pending.length > 0) {
      let victim = -1;
      for (let index = chosen.length - 1; index >= 0; index--) {
        const arc = byId.get(chosen[index]!)!;
        if (arc.class === "attested" && !isBridge(arc) && !input.pinned.has(arc.id) && !incident(arc)) {
          victim = index;
          break;
        }
      }
      if (victim < 0) break;
      kept.delete(chosen[victim]!);
      chosen.splice(victim, 1);
      const next = pending.shift()!;
      kept.add(next.id);
      chosen.push(next.id);
    }
  }
  return chosen;
}

/** Italian thousands grouping for the panel counters («1.200»): «always» because the four-digit
 * no-separator CLDR default would print «1200» where the grouped form is required. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("it-IT", { useGrouping: "always" }).format(value);
}

/** Selection semantics over the disclosed graph. This never changes disclosure. */
export function focusMembers(
  nodes: readonly { id: string; level: number; parent: string | null; domains?: readonly string[] }[],
  edges: readonly { source: string; target: string }[], id: string,
): Set<string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const selected = byId.get(id);
  if (!selected) {
    const edge = edges.find(edge => (edge as { id?: string }).id === id);
    return new Set(edge ? [edge.source, edge.target] : []);
  }
  const members = new Set([id]);
  if (selected.level === 1 || selected.level === 3) {
    for (const node of nodes) {
      let parent = node.parent;
      while (parent) {
        if (parent === id) { members.add(node.id); break; }
        parent = byId.get(parent)?.parent ?? null;
      }
      if (selected.level === 1 && node.domains?.includes(id)) members.add(node.id);
    }
  } else {
    for (const edge of edges) if (edge.source === id || edge.target === id) {
      members.add(edge.source); members.add(edge.target);
    }
    for (const node of nodes) if (node.parent === id) members.add(node.id);
    if (selected.parent) members.add(selected.parent);
  }
  return members;
}

export type FocusArc = { id: string; source: string; target: string; count?: number; class?: string };
export function focusArcs(members: ReadonlySet<string>, arcs: readonly FocusArc[], communityOf: (id: string) => string) {
  const inside = new Set<string>();
  const crossing: FocusArc[] = [];
  for (const arc of arcs) {
    const source = members.has(arc.source), target = members.has(arc.target);
    if (source && target) inside.add(arc.id);
    else if (source || target) crossing.push(arc);
  }
  const bridges = crossing.filter(arc => communityOf(arc.source) !== communityOf(arc.target))
    .sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || compare(a.id, b.id)).slice(0, 5);
  return { inside, bridges: new Set(bridges.map(arc => arc.id)),
    relevant: new Set([...inside, ...crossing.filter(arc => communityOf(arc.source) === communityOf(arc.target)).map(arc => arc.id)]) };
}

export function focusNeighbourhood(
  seed: ReadonlySet<string>, nodes: readonly { id: string; parent: string | null }[],
  arcs: readonly FocusArc[], depth: 1 | 2,
): { nodes: Set<string>; arcs: Set<string> } {
  const allowed = new Set(nodes.map(node => node.id));
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!allowed.has(a) || !allowed.has(b)) return;
    (links.get(a) ?? links.set(a, new Set()).get(a)!).add(b);
    (links.get(b) ?? links.set(b, new Set()).get(b)!).add(a);
  };
  for (const arc of arcs) link(arc.source, arc.target);
  for (const node of nodes) if (node.parent) link(node.id, node.parent);
  const visited = new Set([...seed].filter(id => allowed.has(id)));
  let frontier = [...visited];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbour of links.get(id) ?? [])
      if (!visited.has(neighbour)) { visited.add(neighbour); next.push(neighbour); }
    frontier = next;
  }
  const shownArcs = new Set(arcs.filter(arc => visited.has(arc.source) && visited.has(arc.target)).map(arc => arc.id));
  for (const node of nodes) if (node.parent && visited.has(node.id) && visited.has(node.parent))
    shownArcs.add(`contains:${node.id}`);
  return { nodes: visited, arcs: shownArcs };
}

/** What the camera does after a refresh rebuilds the view behind the same page. Pure.
 *
 * A density or level change draws a different slice of the *same* scene — the disclosed set, the
 * arrangement and the morphology are unchanged — so the camera is always restored, never refit:
 * changing how much one sees must not move what one sees. The restore also covers layout-extent
 * jitter that would otherwise masquerade as a bounds change. The refit stays reserved for scenes
 * whose bounds really changed (new disclosures, another morphology) and only while the user has
 * not taken the camera themselves. */
export function refreshCameraAction(state: {
  readonly hasCamera: boolean;
  readonly keep: boolean;
  readonly boundsChanged: boolean;
  readonly userMoved: boolean;
  /** The disclosed ids, the arrangement and the morphology are all unchanged — a density or
   * level refresh, a hover, a label toggle. Never refit, whatever the layout extents read like. */
  readonly sceneUnchanged: boolean;
}): "restore" | "refit" | "none" {
  if (!state.hasCamera) return "none";
  if (state.sceneUnchanged) return "restore";
  if (state.keep && (!state.boundsChanged || state.userMoved)) return "restore";
  if (state.boundsChanged) return "refit";
  return "none";
}
