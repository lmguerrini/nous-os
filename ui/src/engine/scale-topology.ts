import type { EngineGraph, VisualGraph } from "#engine/contract.ts";
import { assertEngineAccessTrace, createEngineGraphView } from "#engine/contract.ts";
import { aggregateMemberships } from "#engine/layout.ts";

type EngineNode = EngineGraph["nodes"][number];
type EngineEdge = EngineGraph["edges"][number];

/**
 * This is the closed scale/navigation-topology vocabulary and does not select a rendering
 * morphology or an aggregate-window organization. Morphology answers what an element looks like;
 * Organization answers how the graph is arranged at this level; ScaleTopology answers what happens
 * when an element becomes a navigable world at another scale. The three are orthogonal on purpose.
 */
export type ScaleTopology = "atomic" | "hierarchical" | "recursive" | "holographic";

/** This is the baseline member: no enter transition exists at all, selection and inspection only. */
export const ATOMIC: ScaleTopology = "atomic";

/** This member enters a declared containment world only, one level deep, because that is all the governed IR ever declares. */
export const HIERARCHICAL: ScaleTopology = "hierarchical";

/** This member enters both a containment world and a governed-neighbourhood world, at any depth, by reusing the same operation at each level. */
export const RECURSIVE: ScaleTopology = "recursive";

/** This member is Recursive plus a preserved-context bundle back to the whole, drawn only from relations NousOS actually governs. */
export const HOLOGRAPHIC: ScaleTopology = "holographic";

/** This is the complete closed scale-topology vocabulary and does not admit a fifth member. */
export const SCALE_TOPOLOGIES = [ATOMIC, HIERARCHICAL, RECURSIVE, HOLOGRAPHIC] as const;

const CONTAINMENT = "containment" as const;
const NEIGHBOURHOOD = "neighbourhood" as const;
const NOT_ENTERABLE = "not-enterable" as const;

/**
 * This is the label distinguishing a declared containment world from a governed-neighbourhood
 * world; it is kept as an inline field type rather than a second named export so the two never
 * collapse into one exported vocabulary the two-kind distinction depends on staying apart.
 */
type ChildWorldKind = typeof CONTAINMENT | typeof NEIGHBOURHOOD;

/** This is what `enterableKind` may answer under a given policy and does not itself construct a world. */
type EnterableKind = ChildWorldKind | typeof NOT_ENTERABLE;

/** This is one labelled child world and does not let a containment world and a neighbourhood world be mistaken for each other. */
export type ChildWorld = {
  readonly kind: ChildWorldKind;
  readonly rootId: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

/** This is one breadcrumb entry on a navigation path and does not retain a world's full subgraph. */
export type ScaleBreadcrumbEntry = {
  readonly kind: ChildWorldKind;
  readonly rootId: string;
};

/** This is a navigation path of entered worlds under one fixed policy and does not mutate in place. */
export type ScaleNavigationPath = {
  readonly policy: ScaleTopology;
  readonly worlds: readonly ChildWorld[];
};

/** This is one real governed relation crossing the current world's boundary and does not name a synthesized correspondence. */
export type ScaleBoundaryRelation = {
  readonly edgeId: string;
  readonly outsideNodeId: string;
};

/** This is one governed element's recorded provenance origin and does not carry its derived value. */
export type ScaleProvenanceRecord = {
  readonly id: string;
  readonly origin: string;
};

/**
 * This is the fixed, named list of context Holographic cannot supply because NousOS does not
 * possess it. It is reported, never simulated: no lens semantics, no symbolic
 * correspondence, and no cross-domain facet alignment exist in the governed graph to preserve.
 */
export const HOLOGRAPHIC_UNAVAILABLE_CONTEXT = [
  "lens semantics",
  "symbolic correspondence",
  "cross-domain facet alignment",
] as const;

/** This is Holographic's preserved-context bundle and names both what it preserved and what it could not. */
export type HolographicContext = {
  readonly currentWorld: ChildWorld;
  readonly parent: ScaleBreadcrumbEntry | null;
  readonly pathBack: readonly ScaleBreadcrumbEntry[];
  readonly boundaryRelations: readonly ScaleBoundaryRelation[];
  readonly position: {
    readonly canonicalNodeCount: number;
    readonly canonicalEdgeCount: number;
    readonly worldNodeCount: number;
    readonly worldEdgeCount: number;
  };
  readonly provenance: readonly ScaleProvenanceRecord[];
  readonly unavailable: typeof HOLOGRAPHIC_UNAVAILABLE_CONTEXT;
};

/**
 * This answers, purely from the canonical graph's own structure, whether one node is enterable
 * under a policy and as which kind. Atomic never enters. Hierarchical enters only a declared
 * containment root (a cluster or a conflict); every other node is refused, which is what caps its
 * depth at one, because no aggregate contains another. Recursive and Holographic additionally enter
 * any node's real governed neighbourhood.
 */
export function enterableKind(graph: VisualGraph, nodeId: string, policy: ScaleTopology): EnterableKind {
  const engineGraph = engineView(graph);
  const node = requiredEngineNode(engineGraph, nodeId);
  if (policy === ATOMIC) {
    return NOT_ENTERABLE;
  }
  const aggregateKind = aggregateKindOf(node);
  if (aggregateKind !== null) {
    return CONTAINMENT;
  }
  if (policy === HIERARCHICAL) {
    return NOT_ENTERABLE;
  }
  return hasIncidentEdge(engineGraph, nodeId) ? NEIGHBOURHOOD : NOT_ENTERABLE;
}

/**
 * This is the one operation every policy above Atomic reuses at every level: given a root and the
 * kind already decided for it, it returns the labelled subgraph and fabricates nothing. A
 * containment world is exactly the aggregate, its real members, and the defining membership
 * relations between them. A neighbourhood world is exactly one node, every relation incident to it,
 * and the endpoints of those relations — adjacency, never containment.
 */
export function childWorld(graph: VisualGraph, nodeId: string, kind: ChildWorldKind): ChildWorld {
  const engineGraph = engineView(graph);
  requiredEngineNode(engineGraph, nodeId);
  return kind === CONTAINMENT
    ? containmentChildWorld(engineGraph, nodeId)
    : neighbourhoodChildWorld(engineGraph, nodeId);
}

/**
 * This is the cross-level invariant, enforced rather than assumed: every id a child world names
 * must already be in the canonical graph, every named relation's endpoints must both be in the
 * world's own node set, and the world must equal exactly what `childWorld` itself recomputes for
 * the same root and kind — never a superset, never a subset, never a fabricated member or relation.
 */
export function assertChildWorld(graph: VisualGraph, world: ChildWorld): void {
  const engineGraph = engineView(graph);
  const knownNodeIds = new Set(engineGraph.nodes.map((node) => node.id));
  const knownEdgeIds = new Set(engineGraph.edges.map((edge) => edge.id));
  const edgesById = new Map(engineGraph.edges.map((edge) => [edge.id, edge]));
  for (const nodeId of world.nodeIds) {
    if (!knownNodeIds.has(nodeId)) {
      throw new TypeError(`scale topology child world names a node absent from the canonical graph: ${nodeId}`);
    }
  }
  const worldNodeIds = new Set(world.nodeIds);
  for (const edgeId of world.edgeIds) {
    if (!knownEdgeIds.has(edgeId)) {
      throw new TypeError(`scale topology child world names a relation absent from the canonical graph: ${edgeId}`);
    }
    const edge = requiredEngineEdge(edgesById, edgeId);
    if (!worldNodeIds.has(edge.source) || !worldNodeIds.has(edge.target)) {
      throw new TypeError(`scale topology child world relation endpoint is missing from its own node set: ${edgeId}`);
    }
  }
  const recomputed = world.kind === CONTAINMENT
    ? containmentChildWorld(engineGraph, world.rootId)
    : neighbourhoodChildWorld(engineGraph, world.rootId);
  assertSameIdSet(world.nodeIds, recomputed.nodeIds, "child world node");
  assertSameIdSet(world.edgeIds, recomputed.edgeIds, "child world relation");
}

/** This is a fresh navigation path at the canonical top level under one fixed policy. */
export function rootNavigationPath(policy: ScaleTopology): ScaleNavigationPath {
  return { policy, worlds: [] };
}

/** This is the node id set currently navigable: the canonical graph at the root, or the current world's own members one level in. */
export function currentNavigableNodeIds(graph: VisualGraph, path: ScaleNavigationPath): readonly string[] {
  const lastWorld = path.worlds[path.worlds.length - 1];
  if (lastWorld !== undefined) {
    return lastWorld.nodeIds;
  }
  const engineGraph = engineView(graph);
  return [...engineGraph.nodes.map((node) => node.id)].sort(compareText);
}

/**
 * This enters one child world from the current position: the target must already be part of the
 * current navigable world (or, at the root, part of the canonical graph), the policy must actually
 * permit entering it, and the resulting world is asserted a provable subset before it is returned.
 */
export function enterChildWorld(graph: VisualGraph, path: ScaleNavigationPath, nodeId: string): ScaleNavigationPath {
  const navigable = currentNavigableNodeIds(graph, path);
  if (!navigable.includes(nodeId)) {
    throw new TypeError(`scale topology navigation target is not part of the current world: ${nodeId}`);
  }
  const kind = enterableKind(graph, nodeId, path.policy);
  if (kind === NOT_ENTERABLE) {
    throw new TypeError(`scale topology "${path.policy}" cannot enter this element: ${nodeId}`);
  }
  const world = childWorld(graph, nodeId, kind);
  assertChildWorld(graph, world);
  return { policy: path.policy, worlds: [...path.worlds, world] };
}

/** This steps back one level on a navigation path and does not accept stepping back past the canonical top level. */
export function backNavigation(path: ScaleNavigationPath): ScaleNavigationPath {
  if (path.worlds.length === 0) {
    throw new TypeError("scale topology navigation is already at the canonical top level");
  }
  return { policy: path.policy, worlds: path.worlds.slice(0, -1) };
}

/**
 * This is Holographic's preserved-context bundle for the current position: parent context, the
 * full navigable path back, real governed relations crossing the current world's boundary to a
 * named outside node, the current world's own structure, its position within the canonical graph,
 * and recorded provenance for every element the world contains — plus the fixed, named list of
 * what NousOS does not possess and therefore cannot preserve.
 */
export function holographicContext(graph: VisualGraph, path: ScaleNavigationPath): HolographicContext {
  if (path.policy !== HOLOGRAPHIC) {
    throw new TypeError("holographic context requires the holographic scale topology");
  }
  const currentWorld = path.worlds[path.worlds.length - 1];
  if (currentWorld === undefined) {
    throw new TypeError("holographic context requires an entered child world");
  }
  assertChildWorld(graph, currentWorld);
  const engineGraph = engineView(graph);
  const worldNodeIds = new Set(currentWorld.nodeIds);
  const worldEdgeIds = new Set(currentWorld.edgeIds);
  const boundaryRelations = engineGraph.edges
    .filter((edge) => worldNodeIds.has(edge.source) !== worldNodeIds.has(edge.target))
    .map((edge) => ({
      edgeId: edge.id,
      outsideNodeId: worldNodeIds.has(edge.source) ? edge.target : edge.source,
    }))
    .sort((left, right) => compareText(left.edgeId, right.edgeId));
  const pathBack = path.worlds.map((world) => breadcrumbEntry(world));
  const parentEntry = pathBack[pathBack.length - 2];
  const provenance = [
    ...graph.nodes.filter((node) => worldNodeIds.has(node.id)),
    ...graph.edges.filter((edge) => worldEdgeIds.has(edge.id)),
  ]
    .map((element) => ({ id: element.id, origin: element.derived.origin }))
    .sort((left, right) => compareText(left.id, right.id));
  return {
    currentWorld,
    parent: parentEntry ?? null,
    pathBack,
    boundaryRelations,
    position: {
      canonicalNodeCount: engineGraph.nodes.length,
      canonicalEdgeCount: engineGraph.edges.length,
      worldNodeCount: currentWorld.nodeIds.length,
      worldEdgeCount: currentWorld.edgeIds.length,
    },
    provenance,
    unavailable: HOLOGRAPHIC_UNAVAILABLE_CONTEXT,
  };
}

function breadcrumbEntry(world: ChildWorld): ScaleBreadcrumbEntry {
  return { kind: world.kind, rootId: world.rootId };
}

function containmentChildWorld(graph: EngineGraph, nodeId: string): ChildWorld {
  const node = requiredEngineNode(graph, nodeId);
  const aggregateKind = aggregateKindOf(node);
  if (aggregateKind === null) {
    throw new TypeError(`scale topology containment world requires a cluster or conflict root, got: ${node.kind}`);
  }
  const memberships = aggregateMemberships(graph);
  const members = memberships.get(nodeId);
  if (members === undefined) {
    throw new TypeError(`scale topology containment root has no reserved membership: ${nodeId}`);
  }
  const definingEdges = graph.edges.filter((edge) => isDefiningMembershipEdge(edge, nodeId, aggregateKind));
  return {
    kind: CONTAINMENT,
    rootId: nodeId,
    nodeIds: uniqueSorted([nodeId, ...members]),
    edgeIds: uniqueSorted(definingEdges.map((edge) => edge.id)),
  };
}

function neighbourhoodChildWorld(graph: EngineGraph, nodeId: string): ChildWorld {
  const incident = graph.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  const endpointIds = incident.flatMap((edge) => [edge.source, edge.target]);
  return {
    kind: NEIGHBOURHOOD,
    rootId: nodeId,
    nodeIds: uniqueSorted([nodeId, ...endpointIds]),
    edgeIds: uniqueSorted(incident.map((edge) => edge.id)),
  };
}

function isDefiningMembershipEdge(edge: EngineEdge, aggregateId: string, aggregateKind: "cluster" | "conflict"): boolean {
  return aggregateKind === "cluster"
    ? edge.kind === "in_cluster" && edge.target === aggregateId
    : edge.kind === "conflict_member" && edge.source === aggregateId;
}

function aggregateKindOf(node: EngineNode): "cluster" | "conflict" | null {
  return node.kind === "cluster" || node.kind === "conflict" ? node.kind : null;
}

function hasIncidentEdge(graph: EngineGraph, nodeId: string): boolean {
  return graph.edges.some((edge) => edge.source === nodeId || edge.target === nodeId);
}

/**
 * This is the structural view every function above reads: a traced, engine-only projection of the
 * canonical graph, ordered by id for deterministic output, with its access trace asserted before
 * it is handed back — the same discipline `buildScene` applies, so this module cannot read a
 * semantic payload any more than the renderer can.
 */
function engineView(graph: VisualGraph): EngineGraph {
  const { graph: tracedGraph, trace } = createEngineGraphView(graph);
  const ordered: EngineGraph = {
    nodes: [...tracedGraph.nodes].sort(compareIds),
    edges: [...tracedGraph.edges].sort(compareIds),
  };
  assertEngineAccessTrace(trace);
  return ordered;
}

function requiredEngineNode(graph: EngineGraph, id: string): EngineNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new TypeError(`scale topology node is unavailable: ${id}`);
  }
  return node;
}

function requiredEngineEdge(edgesById: ReadonlyMap<string, EngineEdge>, id: string): EngineEdge {
  const edge = edgesById.get(id);
  if (edge === undefined) {
    throw new TypeError(`scale topology relation is unavailable: ${id}`);
  }
  return edge;
}

function assertSameIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) {
    throw new TypeError(`scale topology ${label} set contains a duplicate`);
  }
  const expectedSet = new Set(expected);
  if (actualSet.size !== expectedSet.size || [...actualSet].some((id) => !expectedSet.has(id))) {
    throw new TypeError(`scale topology ${label} set does not match the governed relation it must equal exactly`);
  }
}

function uniqueSorted(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort(compareText);
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
