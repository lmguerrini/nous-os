import { readSemantic } from "#engine/contract.ts";
import type { VisualGraph, VisualNode } from "#engine/contract.ts";

/**
 * This is one element's resolved valid-time placement. An assertion carries a
 * governed `valid_from`, and a rejection carries its own governed instant,
 * `rejected_at` — the moment the rejection itself came to exist, not a date
 * borrowed from whatever it rejects — so both are read explicitly, and only
 * the remaining, genuinely undated kinds ever reach the derivation rule below.
 *
 * `explicit` is read directly from governed evidence. `derived` is computed
 * from governed incidence and always names the governed elements that caused
 * it, so it is traceable rather than asserted. `unknown` means no defensible
 * placement exists and is never silently dated.
 */
export type TemporalPlacement =
  | { readonly class: "explicit"; readonly at: string; readonly until: string | null }
  | { readonly class: "derived"; readonly at: string; readonly through: string; readonly causes: readonly string[] }
  | { readonly class: "unknown" };

/** This is the measured count of each temporal class and is reported, never gated. */
export type TemporalClassCounts = {
  readonly explicit: number;
  readonly derived: number;
  readonly unknown: number;
};

/** This is the canonical id subset visible at one instant and does not admit an id absent from the graph. */
export type TemporalMembership = {
  readonly instant: string;
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
};

type DerivationRule = {
  readonly edgeKind: string;
  readonly selfRole: "source" | "target";
};

// Each undated kind derives through exactly one governed relation, in the
// direction fixed by the preregistered element inventory. `selfRole` names
// which endpoint of that edge kind is the node being placed; the other
// endpoint is the governed neighbour whose own placement is read.
const DERIVATION_RULES: Readonly<Record<string, DerivationRule>> = {
  subject: { edgeKind: "about", selfRole: "target" },
  source: { edgeKind: "cites", selfRole: "target" },
  conflict: { edgeKind: "conflict_member", selfRole: "source" },
  bridge: { edgeKind: "bridge_side", selfRole: "source" },
  cluster: { edgeKind: "in_cluster", selfRole: "target" },
};

/** This resolves every canonical node's temporal placement and does not mutate the supplied graph. */
export function resolveTemporalPlacements(graph: VisualGraph): ReadonlyMap<string, TemporalPlacement> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, TemporalPlacement>();
  const resolving = new Set<string>();

  function resolve(nodeId: string): TemporalPlacement {
    const cached = resolved.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (resolving.has(nodeId)) {
      throw new TypeError(`temporal derivation cycle detected at ${nodeId}`);
    }
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new TypeError(`temporal derivation requires a canonical node for ${nodeId}`);
    }
    resolving.add(nodeId);
    const placement =
      node.kind === "assertion"
        ? explicitPlacement(node)
        : node.kind === "rejection"
          ? rejectionPlacement(node)
          : derivedPlacement(node, graph.edges, resolve);
    resolving.delete(nodeId);
    resolved.set(nodeId, placement);
    return placement;
  }

  for (const node of graph.nodes) {
    resolve(node.id);
  }
  return resolved;
}

/** This reads one governed assertion's own valid time and does not consult `recorded_at`. */
function explicitPlacement(node: VisualNode): TemporalPlacement {
  const attributes = readSemantic(node.semantic) as Record<string, unknown>;
  const validFrom = attributes.valid_from;
  if (validFrom === null) {
    return { class: "unknown" };
  }
  if (typeof validFrom !== "string") {
    throw new TypeError(`assertion ${node.id} valid_from must be a string or null`);
  }
  const validTo = attributes.valid_to;
  if (validTo !== null && typeof validTo !== "string") {
    throw new TypeError(`assertion ${node.id} valid_to must be a string or null`);
  }
  return { class: "explicit", at: validFrom, until: validTo };
}

/**
 * This reads one governed rejection's own valid time and never back-propagates
 * it through the derivation rule used for genuinely undated kinds — the
 * rejection did not exist before `rejected_at`, so an earlier instant is never
 * invented for it. `until` is left `null` because `rejected_at` is governed
 * evidence for when the rejected state begins, not for when it ends.
 */
function rejectionPlacement(node: VisualNode): TemporalPlacement {
  const attributes = readSemantic(node.semantic) as Record<string, unknown>;
  const rejectedAt = attributes.rejected_at;
  if (typeof rejectedAt !== "string") {
    return { class: "unknown" };
  }
  return { class: "explicit", at: rejectedAt, until: null };
}

/** This derives one undated kind's placement from its one governed incidence rule and does not extend the chain past it. */
function derivedPlacement(
  node: VisualNode,
  edges: VisualGraph["edges"],
  resolve: (id: string) => TemporalPlacement,
): TemporalPlacement {
  const rule = DERIVATION_RULES[node.kind];
  if (rule === undefined) {
    return { class: "unknown" };
  }
  const neighbourIds = incidentNeighbours(node.id, rule, edges);
  let bestEpoch: number | undefined;
  let bestAt: string | undefined;
  let causes: string[] = [];
  for (const neighbourId of neighbourIds) {
    const placement = resolve(neighbourId);
    if (placement.class === "unknown") {
      continue;
    }
    const epoch = epochMillis(placement.at);
    if (bestEpoch === undefined || epoch < bestEpoch) {
      bestEpoch = epoch;
      bestAt = placement.at;
      causes = [neighbourId];
    } else if (epoch === bestEpoch) {
      causes.push(neighbourId);
    }
  }
  if (bestAt === undefined) {
    return { class: "unknown" };
  }
  return { class: "derived", at: bestAt, through: rule.edgeKind, causes: Object.freeze([...new Set(causes)].sort()) };
}

function incidentNeighbours(nodeId: string, rule: DerivationRule, edges: VisualGraph["edges"]): readonly string[] {
  const neighbours: string[] = [];
  for (const edge of edges) {
    if (edge.kind !== rule.edgeKind) {
      continue;
    }
    if (rule.selfRole === "target" && edge.target === nodeId) {
      neighbours.push(edge.source);
    } else if (rule.selfRole === "source" && edge.source === nodeId) {
      neighbours.push(edge.target);
    }
  }
  return neighbours.sort();
}

/** This counts each temporal class and does not treat the count as a pass/fail gate. */
export function temporalClassCounts(placements: ReadonlyMap<string, TemporalPlacement>): TemporalClassCounts {
  let explicit = 0;
  let derived = 0;
  let unknown = 0;
  for (const placement of placements.values()) {
    if (placement.class === "explicit") {
      explicit += 1;
    } else if (placement.class === "derived") {
      derived += 1;
    } else {
      unknown += 1;
    }
  }
  return { explicit, derived, unknown };
}

/** This resolves the canonical id subset valid-time-visible at one instant and does not invent an id outside the graph. */
export function resolveTemporalMembership(
  graph: VisualGraph,
  placements: ReadonlyMap<string, TemporalPlacement>,
  instant: string,
): TemporalMembership {
  const at = epochMillis(instant);
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    const placement = placements.get(node.id);
    if (placement === undefined) {
      throw new TypeError(`temporal membership requires a placement for ${node.id}`);
    }
    if (isPresentAt(placement, at)) {
      nodeIds.add(node.id);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      edgeIds.add(edge.id);
    }
  }
  return { instant, nodeIds, edgeIds };
}

function isPresentAt(placement: TemporalPlacement, at: number): boolean {
  if (placement.class === "unknown") {
    return false;
  }
  if (at < epochMillis(placement.at)) {
    return false;
  }
  if (placement.class === "explicit" && placement.until !== null) {
    return at < epochMillis(placement.until);
  }
  return true;
}

/** This is the unconditional all-time union of every canonical id and is the resting state Temporal Playback enters from and returns to. */
export function allTimeMembership(graph: VisualGraph): TemporalMembership {
  return {
    instant: "all-time",
    nodeIds: new Set(graph.nodes.map((node) => node.id)),
    edgeIds: new Set(graph.edges.map((edge) => edge.id)),
  };
}

function epochMillis(instant: string): number {
  const epoch = Date.parse(instant);
  if (Number.isNaN(epoch)) {
    throw new TypeError(`temporal instant is not parseable: ${instant}`);
  }
  return epoch;
}
