import {
  assertVisualGraphFieldRegister,
  createEngineGraphView,
  createRenderedStateCarrier,
  createSemantic,
} from "../engine/contract.ts";
import type { Coordinates, VisualGraph } from "../engine/contract.ts";
import { DEFAULT_CALIBRATION } from "../engine/calibration.ts";
import { layoutAnchors } from "../engine/layout.ts";
import { indraLayout } from "../engine/organization.ts";
import type { ReviewExport, ReviewNode, ReviewEdge } from "./model.ts";

const NODE_KIND = {
  domain: "subject",
  connection: "subject",
  candidate: "subject",
  canon: "subject",
  evidence: "source",
  record: "source",
  conversation: "cluster",
} as const;
const EDGE_TYPES = new Set([
  "in_conversation",
  "links",
  "supported_by",
  "quotes",
  "classified_in",
  "distilled_as",
  "promoted_as",
]);
export type Census = {
  nodes: number;
  edges: number;
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
  duplicateIds: string[];
  danglingEdges: string[];
};
/** Count export records before adaptation so missing and duplicate references remain visible. */
export function censusOf(data: ReviewExport): Census {
  const nodeTypes: Record<string, number> = {};
  const edgeTypes: Record<string, number> = {};
  const ids = new Set<string>();
  const allIds = new Set<string>();
  const duplicateIds: string[] = [];
  const danglingEdges: string[] = [];
  for (const node of data.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
    if (allIds.has(node.id)) duplicateIds.push(node.id);
    allIds.add(node.id);
    ids.add(node.id);
  }
  for (const edge of data.edges) {
    edgeTypes[edge.type] = (edgeTypes[edge.type] ?? 0) + 1;
    if (allIds.has(edge.id)) duplicateIds.push(edge.id);
    allIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) danglingEdges.push(edge.id);
  }
  return { nodes: data.nodes.length, edges: data.edges.length, nodeTypes, edgeTypes, duplicateIds, danglingEdges };
}
const origin = "review-export-structural-alias";
const zero: Coordinates = { x: 0, y: 0, z: 0 };
const visual = (role: "subject" | "source" | "cluster" | "about" | "in_cluster", priority: number) => ({
  role,
  anchor: zero,
  path: [],
  lod: { minimum: 0, maximum: 1 },
  label_priority: priority,
});
/**
 * Flat and Indra read the same ids through two structural aliases. Under Indra a conversation is a
 * `cluster` and its records are `in_cluster` members, so the engine draws its window. Under Flat the
 * conversation is an ordinary node linked to its records: the engine's Flat layout reserves a packed
 * disc for every cluster, and a large conversation cannot keep the calibrated
 * 16 px separation inside one. Nothing else differs, so selection and filters survive the switch.
 */
export type AdaptedReview = {
  graph: VisualGraph;
  flatGraph: VisualGraph;
  indraGraph: VisualGraph;
  originals: ReadonlyMap<string, ReviewNode | ReviewEdge>;
  flatAnchors: ReadonlyMap<string, Coordinates>;
  indraAnchors: ReadonlyMap<string, Coordinates>;
};
/** Translate export structure into engine graphs while retaining stable export ids. */
export function adaptReviewExport(data: ReviewExport): AdaptedReview {
  if (data.schema !== "nousos-graph-review-1" || !Array.isArray(data.nodes) || !Array.isArray(data.edges))
    throw new TypeError("invalid review export");
  const census = censusOf(data);
  if (census.duplicateIds.length || census.danglingEdges.length)
    throw new TypeError(
      `invalid review ids: ${JSON.stringify({ duplicates: census.duplicateIds, dangling: census.danglingEdges })}`,
    );
  const originals = new Map<string, ReviewNode | ReviewEdge>();
  const nodesFor = (clusterConversations: boolean) =>
    data.nodes.map((node) => {
      if (!(node.type in NODE_KIND) || typeof node.id !== "string" || !node.id)
        throw new TypeError("invalid review node");
      originals.set(node.id, structuredClone(node));
      const kind = node.type === "conversation" && !clusterConversations ? "subject" : NODE_KIND[node.type];
      const priority =
        node.type === "domain" || node.type === "conversation"
          ? 3
          : node.type === "evidence" || node.type === "record"
            ? 1
            : 2;
      return {
        id: node.id,
        kind,
        semantic: createSemantic(null),
        rendered: createRenderedStateCarrier(null),
        derived: { value: null, origin },
        visual: visual(kind, priority),
      };
    });
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const edgesFor = (clusterConversations: boolean) =>
    data.edges.map((edge) => {
      if (
        !EDGE_TYPES.has(edge.type) ||
        typeof edge.id !== "string" ||
        !edge.id ||
        typeof edge.source !== "string" ||
        typeof edge.target !== "string"
      )
        throw new TypeError("invalid review edge");
      if (
        edge.type === "in_conversation" &&
        (nodeById.get(edge.source)?.type !== "record" || nodeById.get(edge.target)?.type !== "conversation")
      )
        throw new TypeError("invalid conversation membership");
      originals.set(edge.id, structuredClone(edge));
      const kind = edge.type === "in_conversation" && clusterConversations ? "in_cluster" : "about";
      return {
        id: edge.id,
        kind,
        source: edge.source,
        target: edge.target,
        semantic: createSemantic(null),
        rendered: createRenderedStateCarrier(null),
        derived: { value: null, origin },
        visual: visual(kind, 0),
      };
    });
  const graphFor = (clusterConversations: boolean): VisualGraph => {
    const graph: VisualGraph = {
      schema_version: "nous-projection-ir/1",
      policy_id: "review-structural-alias",
      question: { valid_at: null, recorded_as_of: null },
      nodes: nodesFor(clusterConversations),
      edges: edgesFor(clusterConversations),
    };
    assertVisualGraphFieldRegister(graph);
    return graph;
  };
  const flatGraph = graphFor(false);
  const indraGraph = graphFor(true);
  const flatAnchors = layoutAnchors(createEngineGraphView(flatGraph).graph, DEFAULT_CALIBRATION);
  const indraAnchors = indraLayout(createEngineGraphView(indraGraph).graph, DEFAULT_CALIBRATION).nodeAnchors;
  return { graph: indraGraph, flatGraph, indraGraph, originals, flatAnchors, indraAnchors };
}
/** Restrict the product graph to the current filter without changing its original ids. */
export function subgraph(graph: VisualGraph, visibleIds: ReadonlySet<string>): VisualGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => visibleIds.has(node.id)),
    edges: graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
  };
}
/** Supply only anchors for nodes still present in the renderer graph. */
export function restrictAnchors(
  anchors: ReadonlyMap<string, Coordinates>,
  visibleIds: ReadonlySet<string>,
): ReadonlyMap<string, Coordinates> {
  const result = new Map<string, Coordinates>();
  for (const id of visibleIds) {
    const point = anchors.get(id);
    if (point) result.set(id, point);
  }
  return result;
}
