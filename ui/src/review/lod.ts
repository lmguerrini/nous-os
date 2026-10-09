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

/** How many nodes, arcs and labels each density admits in the lower-density LOD. */
// D086-CUSTOM BEGIN
export type Density = "essential" | "balanced" | "complete" | "custom";
// D086-CUSTOM END

// D086-CUSTOM BEGIN
export const DENSITIES: readonly Exclude<Density, 'custom'>[] = ["essential", "balanced", "complete"];
// D086-CUSTOM END

export type LodBudget = {
  readonly nodes: number;
  readonly arcs: number;
  readonly labels: number;
};

/** Lower-density render budgets. The Complete entry is retained for projection paths that
 * still use a bounded domain; Natural and Indra Complete use their full-scene contracts. */
export const DENSITY_BUDGETS: Readonly<Record<Density, LodBudget>> = {
  essential: { nodes: 80, arcs: 100, labels: 20 },
  balanced: { nodes: 400, arcs: 450, labels: 40 },
  complete: { nodes: 850, arcs: 1200, labels: 60 },
  // D086-CUSTOM BEGIN: the page replaces this placeholder with its exact request.
  custom: { nodes: 400, arcs: 450, labels: 40 },
  // D086-CUSTOM END
};

// D085-S2 BEGIN: Bilanciata realmente intermedia. One budget per topology:
// the geometry that must stay recognisable decides how many real glyphs Bilanciata admits,
// instead of one global 400-node step for Natural, Canopy, Julia, Sierpiński and Llull alike.
// Essenziale keeps its approved 80/100/20 everywhere (Canopy keeps its 150 marks); Completa
// keeps its bounded-path entry. Natural and Indra keep the classic 400/450 budget.
// The Lab balanced budgets admit more real nodes and arcs at their topology scales.
export type BudgetTopology = 'natural' | 'indra' | 'canopy' | 'julia' | 'sierpinski' | 'lull';

const DENSITY_TOPOLOGY_BUDGETS: Readonly<Record<BudgetTopology, Readonly<Record<Density, LodBudget>>>> = {
  natural: {
    essential: { nodes: 80, arcs: 100, labels: 20 },
    balanced: { nodes: 400, arcs: 450, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
  indra: {
    essential: { nodes: 80, arcs: 100, labels: 20 },
    balanced: { nodes: 400, arcs: 450, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
  canopy: {
    essential: { nodes: 150, arcs: 160, labels: 20 },
    balanced: { nodes: 2500, arcs: 2600, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
  julia: {
    essential: { nodes: 80, arcs: 100, labels: 20 },
    balanced: { nodes: 4000, arcs: 4200, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
  sierpinski: {
    essential: { nodes: 80, arcs: 100, labels: 20 },
    balanced: { nodes: 2500, arcs: 2600, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
  lull: {
    essential: { nodes: 80, arcs: 100, labels: 20 },
    balanced: { nodes: 4000, arcs: 4200, labels: 40 },
    complete: { nodes: 850, arcs: 1200, labels: 60 },
    custom: { nodes: 400, arcs: 450, labels: 40 },
  },
};

/** The density budget of one topology. `DENSITY_BUDGETS` above remains the fixed
 * table verbatim — it still backs the density-independent Essenziale constants, the pinned
 * counts and the reachability proof — while every density-driven path in the page resolves
 * its budget through this function, so the witness can name the policy it applied. */
export function densityBudget(density: Density, topology: BudgetTopology): LodBudget {
  return DENSITY_TOPOLOGY_BUDGETS[topology][density];
}
// D085-S2 END

// D082-A-DENSITY BEGIN: both lower densities draw from one semantic, camera-independent
// disclosure. Keeping this pool identical is necessary for stable coordinates on a switch.
// D082 A-DENSITYc: the pool is a pure function of (index, explicit disclosure, selection).
// `base` must therefore be the EXPLICIT disclosure only — manual expansions over the overview,
// never the reveal controller's zoom admissions or any disclosure a previous density left
// behind. The cache is keyed by that base's contents, so two equal explicit disclosures share
// one pool and no other page state can reach it.
import type { V2Index, V2Visible, V2Node } from './v2-core.ts';
// D082-A-READINGS BEGIN
import type { Reading } from './view-contract.ts';
// D082-A-READINGS END
const DENSITY_POOL_LIMIT = 850;
// D085-S2 BEGIN: the shared candidate pool grows with the topology-aware Bilanciata budget.
// The fill order is untouched, so a larger pool is a prefix-stable extension of the smaller
// one: the first 850 candidates (and every coordinate computed over them) are identical.
const DENSITY_POOL_MARGIN = 450;
export function densityPoolLimit(budgetNodes: number): number {
  return Math.max(DENSITY_POOL_LIMIT, budgetNodes + DENSITY_POOL_MARGIN);
}
// D085-S2 END
const densityPoolCache = new WeakMap<V2Index, Map<string, V2Visible>>();
export function densityDisclosure(index: V2Index, base: V2Visible, selectedId: string | null = null,
  // D085-S2 BEGIN: `limit` defaults to the fixed pool for every existing caller.
  limit: number = DENSITY_POOL_LIMIT): V2Visible {
  // D085-S2 END
  const baseKey = base.nodes.map(node => node.id).sort().join(',');
  // D085-S2 BEGIN: the limit is part of the pool's identity, so a typed caller asking for
  // the fixed 850 pool and a classic caller asking for the Bilanciata pool never share
  // an entry. The selection-subsumption fast path keeps the same limit.
  const key = `${baseKey}|${selectedId ?? ''}|${limit}`;
  const retained = densityPoolCache.get(index);
  const cached = retained?.get(key) ?? (selectedId && retained?.get(`${baseKey}||${limit}`)?.nodes.some(node => node.id === selectedId)
    ? retained.get(`${baseKey}||${limit}`) : undefined);
  if (cached) return cached;
  // D085-S2 END
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  const degree = new Map<string, number>();
  for (const edge of index.edges) if (edge.class === 'attested') {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const score = (node: V2Node) => node.importance.value
    + Math.log1p(degree.get(node.id) ?? 0) * 0.6
    + Math.log1p(node.counts.passages ?? 0) * 0.15
    + Math.log1p(node.counts.live_proposals ?? 0) * 0.15;
  const rank = (a: V2Node, b: V2Node) => score(b) - score(a) || compare(a.id, b.id);
  const chosen = new Map<string, V2Node>();
  const add = (node: V2Node) => { if (chosen.size < limit) chosen.set(node.id, node); };
  // Domains, projects and conversations are the complete structural scaffold. It also
  // guarantees that every community has a visible representative.
  for (const node of index.nodes.filter(node => node.level <= 3).sort((a, b) => a.level - b.level || rank(a, b))) add(node);
  // A selection made in Completa remains representable after switching down.
  // Reserve its real ancestor path before ordinary proposal candidates.
  if (selectedId) {
    const path: V2Node[] = [];
    const seen = new Set<string>();
    let cursor = byId.get(selectedId);
    while (cursor && !seen.has(cursor.id)) {
      path.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    for (const node of path) add(node);
  }
  // Explicit disclosure takes precedence over ordinary proposal ranking.
  for (const node of base.nodes.filter(node => node.level > 3).sort(rank)) add(node);
  const communityOf = communityResolver(index.nodes);
  const groups = new Map<string, V2Node[]>();
  for (const node of index.nodes) if (node.level === 4 && !chosen.has(node.id)) {
    const community = communityOf(node.id);
    (groups.get(community) ?? groups.set(community, []).get(community)!).push(node);
  }
  for (const group of groups.values()) group.sort(rank);
  const keys = [...groups.keys()].sort(compare);
  // D085-S2 BEGIN: the round-robin stops at the caller's limit, not the fixed 850, or a
  // Bilanciata pool larger than 850 could never fill past the old cap. (D085-S2 END)
  for (let round = 0; chosen.size < limit && keys.some(key => round < groups.get(key)!.length); round++)
    for (const key of keys) {
      const node = groups.get(key)![round];
      if (node) add(node);
    }
  const nodes = [...chosen.values()];
  const ids = new Set(chosen.keys());
  const counts: Record<number, number> = {};
  for (const node of nodes) counts[node.level] = (counts[node.level] ?? 0) + 1;
  const children = new Map<string, number>();
  const shownChildren = new Map<string, number>();
  for (const node of index.nodes) if (node.parent) {
    children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
    if (ids.has(node.id)) shownChildren.set(node.parent, (shownChildren.get(node.parent) ?? 0) + 1);
  }
  const hidden = new Map<string, number>();
  for (const node of nodes) {
    const omitted = Math.max(0, (children.get(node.id) ?? 0) - (shownChildren.get(node.id) ?? 0));
    const unindexedPassages = node.level === 4 ? Math.max(0, (node.counts.passages ?? 0) - (children.get(node.id) ?? 0)) : 0;
    if (omitted + unindexedPassages > 0) hidden.set(node.id, omitted + unindexedPassages);
  }
  const result: V2Visible = { nodes, edges: index.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    hidden, capped: nodes.length < index.nodes.length, counts };
  const entries = retained ?? new Map<string, V2Visible>();
  if (entries.size >= 8) entries.delete(entries.keys().next().value!);
  entries.set(key, result);
  densityPoolCache.set(index, entries);
  return result;
}
/** Source-relation prefix for the lower levels. The balanced pass seeds itself with every
 * essential relation, then admits more relations whose two glyphs are present. */
export function densitySourceRelations<T extends { id: string; source: string; target: string; class: string; type: string }>(
  relations: readonly T[], rendered: ReadonlySet<string>, budget: number,
  importance: ReadonlyMap<string, number>, prior: readonly T[] = [], coveredNodes: ReadonlySet<string> = new Set(),
  fillRemaining = true,
): T[] {
  const eligible = relations.filter(edge => rendered.has(edge.source) && rendered.has(edge.target));
  const byId = new Map(eligible.map(edge => [edge.id, edge]));
  const score = (edge: T) => (edge.class === 'attested' ? 3 : edge.class === 'exploratory' ? 2 : 1)
    + ((importance.get(edge.source) ?? 0) + (importance.get(edge.target) ?? 0)) / 100;
  const ranked = eligible.sort((a, b) => score(b) - score(a) || compare(a.id, b.id));
  const chosen = new Map<string, T>();
  for (const edge of prior) {
    if (chosen.size >= budget) break;
    const current = byId.get(edge.id);
    if (current) chosen.set(current.id, current);
  }
  // D082-A-DENSITYg: cover selected glyphs before spending the remaining relation
  // budget on global priority. A relation can cover both endpoints; processing the
  // most important uncovered node first makes that choice deterministic and semantic.
  const incident = new Map<string, T[]>();
  for (const edge of ranked) {
    (incident.get(edge.source) ?? incident.set(edge.source, []).get(edge.source)!).push(edge);
    if (edge.target !== edge.source)
      (incident.get(edge.target) ?? incident.set(edge.target, []).get(edge.target)!).push(edge);
  }
  const degree = new Set(coveredNodes);
  for (const edge of chosen.values()) { degree.add(edge.source); degree.add(edge.target); }
  const nodes = [...rendered].sort((a, b) => (importance.get(b) ?? 0) - (importance.get(a) ?? 0) || compare(a, b));
  for (const id of nodes) {
    if (chosen.size >= budget) break;
    if (degree.has(id)) continue;
    const edge = incident.get(id)?.find(candidate => !chosen.has(candidate.id));
    if (!edge) continue;
    chosen.set(edge.id, edge);
    degree.add(edge.source);
    degree.add(edge.target);
  }
  if (fillRemaining) for (const edge of ranked) {
    if (chosen.size >= budget) break;
    chosen.set(edge.id, edge);
  }
  return [...chosen.values()];
}

/** Choose one shared edge budget across all relation classes, then expose its subsets by reading. */
// D082-A-READINGS BEGIN
export function densityRelationsByReading<T extends { id: string; source: string; target: string; class: string; type: string }>(
  relations: readonly T[], reading: Reading, rendered: ReadonlySet<string>, budget: number,
  importance: ReadonlyMap<string, number>, prior?: Readonly<{
    attested: readonly T[]; exploratory: readonly T[]; structural?: readonly T[];
  }>,
): { attested: T[]; exploratory: T[]; structural: T[]; drawn: T[] } {
  // Coverage and priority compete in one shared budget. This prevents structural
  // provenance from consuming the slots before semantic relations get a chance to
  // cover the selected nodes. The prior preserves Essenziale ⊂ Bilanciata.
  const selectedRelations = densitySourceRelations(relations, rendered, budget, importance,
    [...(prior?.attested ?? []), ...(prior?.exploratory ?? []), ...(prior?.structural ?? [])]);
  const attested = selectedRelations.filter(edge => edge.class === 'attested');
  const exploratory = selectedRelations.filter(edge => edge.class === 'exploratory');
  const structural = selectedRelations.filter(edge => edge.class === 'structural');
  const visibleRelations = reading === 'attested' ? attested
    : reading === 'exploratory' ? exploratory : [...attested, ...exploratory];
  const byId = new Map([...visibleRelations, ...structural].map(edge => [edge.id, edge]));
  return { attested, exploratory, structural, drawn: [...byId.values()] };
}

/** Nodes whose only selected semantic witness is hidden by the current reading. */
export function readingIsolatedNodeIds<D extends { source: string; target: string; class?: string },
  A extends { source: string; target: string; class: string; type?: string }>(
  rendered: ReadonlySet<string>, drawn: readonly D[], allRelations: readonly A[], reading: Reading,
): string[] {
  if (reading === 'combined') return [];
  // Structural provenance is present in every reading, but does not make a node
  // semantically connected to the active reading.
  const visibleClass = reading === 'attested' ? 'attested' : 'exploratory';
  const degree = new Set(drawn.filter(edge => edge.class === visibleClass)
    .flatMap(edge => [edge.source, edge.target]));
  const opposite = reading === 'attested' ? 'exploratory' : 'attested';
  return [...rendered].filter(id => !degree.has(id) && allRelations.some(edge => edge.class === opposite &&
    edge.type !== 'classified_in' && (edge.source === id && rendered.has(edge.target) || edge.target === id && rendered.has(edge.source)))).sort(compare);
}
// D082-A-READINGS END

/** Replace selected nodes that have no eligible relation to another selected node
 * with the highest-ranked connected candidate of the same hierarchy level. The
 * required prefix is retained verbatim, so Bilanciata can repair its own suffix
 * without ever dropping an Essenziale node. */
export function densityConnectedNodes<T extends { source: string; target: string }>(
  seed: readonly string[], candidates: readonly LodNodeInfo[], relations: readonly T[], budget: number,
  required: readonly string[] = [],
): string[] {
  const byId = new Map(candidates.map(node => [node.id, node]));
  // Explicit user state (reveal/search/selection/expansion/pin/focus) survives even
  // when it exceeds the nominal density budget. Only the planner's automatic picks
  // are eligible for the isolated-node repair below.
  const mandatory = new Set(required.filter(id => byId.has(id)));
  const chosen = [...new Set([...mandatory, ...seed.filter(id => !mandatory.has(id))])];
  const selected = new Set(chosen);
  const target = Math.max(budget, chosen.length);
  const rankedCandidates = [...candidates].sort((a, b) => b.importance - a.importance || compare(a.id, b.id));
  for (const candidate of rankedCandidates) {
    if (chosen.length >= target) break;
    if (!selected.has(candidate.id)) { selected.add(candidate.id); chosen.push(candidate.id); }
  }
  const neighbours = new Map<string, Set<string>>();
  for (const edge of relations) if (edge.source !== edge.target) {
    (neighbours.get(edge.source) ?? neighbours.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
    (neighbours.get(edge.target) ?? neighbours.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
  }
  while (true) {
    const degree = new Set<string>();
    for (const id of selected) for (const neighbour of neighbours.get(id) ?? [])
      if (selected.has(neighbour)) { degree.add(id); degree.add(neighbour); break; }
    const isolated = chosen.map((id, index) => ({ id, index, node: byId.get(id)! }))
      .filter(item => !mandatory.has(item.id) && !degree.has(item.id))
      .sort((a, b) => a.node.importance - b.node.importance || compare(b.id, a.id));
    let replaced = false;
    for (const item of isolated) {
      const replacement = rankedCandidates.find(candidate => candidate.level === item.node.level
        && !selected.has(candidate.id) && [...(neighbours.get(candidate.id) ?? [])]
          .some(neighbour => neighbour !== item.id && selected.has(neighbour)));
      if (!replacement) continue;
      selected.delete(item.id);
      selected.add(replacement.id);
      chosen[item.index] = replacement.id;
      replaced = true;
      break;
    }
    if (!replaced) return chosen;
  }
}
// D082-A-DENSITY END

// D085-S2 BEGIN: structure-aware selection score for the topology laws.
// A law's coordinates place every node of the fixed snapshot; radius (the potential band in
// Julia, the record band in Llull, the gasket scale in Sierpiński) is the structural feature
// the density must sample, because importance alone selects one radial band and the geometry
// stops being recognisable. The order the score induces interleaves the bands — first every
// band's most important member, then every band's second, and so on — so any budget draws
// all twelve radial quantiles before the hierarchy/community selector applies its own
// ordering. That selector guarantees broad coverage, not equal quantile occupancy; the
// production-path tests measure the actual draw distribution. On equal rank the outer band
// comes first. The score is pure in (positions, importance), yielding deterministic prefixes.
export const LAW_SELECTION_BANDS = 12;

export function lawSelectionScores(
  nodes: readonly { id: string; importance: number }[],
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number; z?: number }>>,
): ReadonlyMap<string, number> {
  const rows: { id: string; importance: number; radius: number }[] = [];
  for (const node of nodes) {
    const point = positions.get(node.id);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const radius = Math.hypot(point.x, point.y, point.z ?? 0);
    if (Number.isFinite(radius)) rows.push({ id: node.id, importance: node.importance, radius });
  }
  rows.sort((a, b) => a.radius - b.radius || compare(a.id, b.id));
  const bands: { id: string; importance: number }[][] = Array.from({ length: LAW_SELECTION_BANDS }, () => []);
  for (let index = 0; index < rows.length; index++) {
    const band = Math.min(LAW_SELECTION_BANDS - 1,
      Math.floor((index / rows.length) * LAW_SELECTION_BANDS));
    bands[band]!.push({ id: rows[index]!.id, importance: rows[index]!.importance });
  }
  const scores = new Map<string, number>();
  for (let band = 0; band < bands.length; band++) {
    // Importance ranks the members inside one band; the band fraction (< 1) only breaks
    // ties across bands at the same rank, outer band first.
    bands[band]!.sort((a, b) => b.importance - a.importance || compare(a.id, b.id));
    for (let rank = 0; rank < bands[band]!.length; rank++) {
      scores.set(bands[band]![rank]!.id, rank + band / LAW_SELECTION_BANDS);
    }
  }
  return scores;
}
// D085-S2 END

export function normalizeDensity(value: unknown, fallback: Density = "balanced"): Density {
  return typeof value === "string" && (value === 'custom' || (DENSITIES as readonly string[]).includes(value))
    ? (value as Density)
    : fallback;
}

/** Children on the newest disclosed page, admitted ahead of older LOD candidates. */
export function recentDisclosedPage(
  nodes: readonly { id: string; parent: string | null }[], parentId: string | undefined,
  requested: number, pageSize: number,
): string[] {
  if (!parentId) return [];
  const children = nodes.filter(node => node.parent === parentId).map(node => node.id).sort(compare);
  const end = Math.min(children.length, Math.max(0, requested));
  return children.slice(Math.max(0, end - pageSize), end);
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

/** Explicit disclosure tiers, computed only over nodes actually available after the cap. */
export function manualExpansionTiers(
  nodes: readonly LodNodeInfo[], manualOrder: readonly string[], pageSize: number,
): { pinnedContainers: Set<string>; pinnedChildren: string[]; priorityChildren: string[] } {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, LodNodeInfo[]>();
  for (const node of nodes) if (node.parent && byId.has(node.parent))
    (children.get(node.parent) ?? children.set(node.parent, []).get(node.parent)!).push(node);
  const ranked = (a: LodNodeInfo, b: LodNodeInfo) => b.importance - a.importance || compare(a.id, b.id);
  for (const list of children.values()) list.sort(ranked);
  const order = [...new Set(manualOrder)].filter(id => byId.has(id));
  const latest = order.at(-1);
  const pinnedChildren = (latest ? children.get(latest) ?? [] : []).slice(0, pageSize).map(node => node.id);
  const pinned = new Set(pinnedChildren);
  const priorityChildren: string[] = [];
  const seen = new Set(pinnedChildren);
  for (const id of order.slice(0, -1).toReversed())
    for (const node of children.get(id) ?? [])
      if (!seen.has(node.id)) { seen.add(node.id); priorityChildren.push(node.id); }
  return { pinnedContainers: new Set(order), pinnedChildren, priorityChildren };
}

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
  /** Selection path, hover, expanded containers, and at most one page of recent children. */
  readonly pinned: ReadonlySet<string>;
  /** The node or domain the reading is about; drives the near-level neighbourhood. */
  readonly focus: string | null;
  /** Visible focus or earlier-expansion members, admitted within the budget in caller order. */
  readonly priority?: ReadonlySet<string> | readonly string[];
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly communityOf: (id: string) => string;
  /** D082 lower densities keep the structural scaffold even under a large focus priority. */
  readonly reserveStructure?: boolean;
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
 * 1. the explicit set (selection path, hover, expanded containers, recent children);
 * 2. earlier expansion children and focus members within the budget;
 * 3. the domains, which anchor every level;
 * 4. near only: the focus neighbourhood, two hops;
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
  const byImportance = (a: LodNodeInfo, b: LodNodeInfo) => b.importance - a.importance || compare(a.id, b.id);
  // D082-A-DENSITY BEGIN: reserve every community before a focused priority can fill
  // the lower-density budget. Other callers retain their manual-expansion precedence.
  if (input.reserveStructure) {
    for (const node of [...input.nodes].filter(node => node.level === 1).sort((a, b) => compare(a.id, b.id))) add(node.id);
    for (const node of [...input.nodes].filter(node => node.level === 2).sort(byImportance)) add(node.id);
  }
  // D082-A-DENSITY END
  const priority = input.priority instanceof Set
    ? [...input.priority].sort((a, b) => (byId.get(b)?.importance ?? 0) - (byId.get(a)?.importance ?? 0) || compare(a, b))
    : input.priority ?? [];
  for (const id of priority) add(id);
  if (!input.reserveStructure) {
    for (const node of [...input.nodes].filter(node => node.level === 1).sort((a, b) => compare(a.id, b.id))) add(node.id);
  }
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
  if (!input.reserveStructure)
    for (const node of [...input.nodes].filter(node => node.level === 2).sort(byImportance)) add(node.id);
  // D082-A-DENSITY BEGIN: the first 80 marks are the 40 domain/project
  // anchors and 40 principal conversations spread across communities. Proposals
  // enter with Bilanciata, in a shared ordered suffix so E is a strict B prefix.
  const communities = new Map<string, { conversations: LodNodeInfo[]; proposals: LodNodeInfo[] }>();
  for (const node of input.nodes) if (node.level === 3 || node.level === 4) {
    const key = input.communityOf(node.id);
    const group = communities.get(key) ?? { conversations: [], proposals: [] };
    (node.level === 3 ? group.conversations : group.proposals).push(node);
    communities.set(key, group);
  }
  for (const group of communities.values()) {
    group.conversations.sort(byImportance);
    group.proposals.sort(byImportance);
  }
  const keys = [...communities.keys()].sort(compare);
  for (let round = 0; round < 5 && room(); round++) for (const key of keys) {
    const conversation = communities.get(key)!.conversations[round];
    if (conversation) add(conversation.id);
  }
  const rounds = keys.reduce((most, key) => {
    const group = communities.get(key)!;
    return Math.max(most, group.conversations.length - 5, group.proposals.length);
  }, 0);
  for (let round = 0; round < rounds && room(); round++) for (const key of keys) {
    const group = communities.get(key)!;
    const conversation = group.conversations[round + 5];
    if (conversation) add(conversation.id);
    const proposal = group.proposals[round];
    if (proposal) add(proposal.id);
  }
  // D082-A-DENSITY END
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
  /** Arc ids always kept: selected relation, selection path, and recent pinned children. */
  readonly pinned: ReadonlySet<string>;
  /** The focus node; its relations are ranked within the budget. */
  readonly focus: string | null;
  /** Focus's strongest bridges and internal relations before ordinary LOD fill. */
  readonly priority?: readonly string[];
  readonly communityOf: (id: string) => string;
  /** True whenever the reading is not attested-only. */
  readonly keepExploratory: boolean;
};

/** Ids admitted outside the arc budget: explicit pins only. */
export function forcedArcIds(input: Pick<SelectArcsInput, "arcs" | "pinned" | "focus">): readonly string[] {
  const forced = new Set<string>();
  const available = new Set(input.arcs.map(arc => arc.id));
  for (const id of [...input.pinned].sort(compare)) if (available.has(id)) forced.add(id);
  return [...forced];
}

/** Choose the arcs actually drawn. Priority order, deterministic within each tier (count
 * descending, then id): 1. explicit pins; 2. expansion/focus priority and focus incidents;
 * 3. bridges between communities; 4. attested by weight; 5. exploratory — kept visible within the budget whenever the reading shows them, at
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
  for (const arc of [...input.arcs].filter(incident).sort((a, b) => b.count - a.count || compare(a.id, b.id))) take(arc.id);
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
    const priority = new Set(input.priority ?? []);
    const available = input.arcs.filter(arc => arc.class === "exploratory").length;
    const target = Math.min(available, Math.floor(input.budget * EXPLORATORY_RESERVE_SHARE));
    const pending = exploratory.filter(arc => !kept.has(arc.id));
    while (chosen.filter(id => byId.get(id)!.class === "exploratory").length < target && pending.length > 0) {
      let victim = -1;
      for (let index = chosen.length - 1; index >= 0; index--) {
        const arc = byId.get(chosen[index]!)!;
        if (arc.class === "attested" && !isBridge(arc) && !input.pinned.has(arc.id) && !priority.has(arc.id) && !incident(arc)) {
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

/** The pre-focus resting/hover emphasis. A hover is transient and must not become F7 focus. */
export function restingEmphasis(input: {
  readonly hovered: string | null;
  readonly hoveredEdge: string | null;
  readonly relations: ReadonlyMap<string, { source: string; target: string }>;
  readonly nodes: readonly { id: string; parent: string | null }[];
  readonly containerIds: ReadonlySet<string>;
  readonly organization: "natural" | "indra";
  readonly absoluteContainerId: string;
}): Set<string> | null {
  const id = input.hovered;
  const relation = input.relations.get(input.hoveredEdge ?? "") ?? input.relations.get(id ?? "");
  if (!id && !relation) return null;
  const neighbours = new Set(relation ? [relation.source, relation.target] : [id!]);
  if (id === input.absoluteContainerId) neighbours.delete(id);
  if (input.organization === "indra" && id && (id === input.absoluteContainerId || input.containerIds.has(id))) {
    const byId = new Map(input.nodes.map(node => [node.id, node]));
    for (const visible of input.nodes) {
      let cursor: { id: string; parent: string | null } | undefined = visible;
      while (cursor?.parent) {
        if (cursor.parent === id) { neighbours.add(visible.id); break; }
        cursor = byId.get(cursor.parent);
      }
      if (id === input.absoluteContainerId) neighbours.add(visible.id);
    }
  }
  for (const edge of input.relations.values())
    if (edge.source === id || edge.target === id) {
      neighbours.add(edge.source);
      neighbours.add(edge.target);
    }
  return neighbours;
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
