import type {
  ProjectionResult,
  RenderVisibility,
  SemanticEdge,
  SemanticGraphSnapshot,
  SemanticNode,
} from "../../src/projection/contract-types.ts";

/** A minimal D-073 style-bridge fixture: a deterministic synthetic snapshot/result/visibility
 * triple that satisfies the render contract validators, so the tests exercise the style
 * derivation rather than fixture assembly. No renderer dependency: node-only. */

export type StyleFixtureNode = {
  readonly id: string;
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly status?: string;
  readonly title: string;
  readonly displayLabel?: string;
  readonly titleFull: string;
  readonly parentId: string | null;
};

const rawNode = (node: StyleFixtureNode) => ({
  sourcePath: "index.nodes" as const,
  ordinal: 0,
  raw: {
    id: node.id, kind: "source", level: node.level, size: 0.5,
    status: node.status, title: node.title,
    ...(node.displayLabel !== undefined ? { display_label: node.displayLabel } : {}),
    title_full: node.titleFull,
    importance: { value: 1 }, parent: node.parentId, domains: [],
  },
  rawJson: {},
  canonicalJson: "",
});

const semanticNode = (node: StyleFixtureNode): SemanticNode => ({
  id: node.id,
  kind: "source",
  standing: "standing",
  communityIds: [],
  parentId: node.parentId,
  provenance: [],
  features: {},
  sourceKind: "index-node",
  rawNode: rawNode(node),
} as unknown as SemanticNode);

const semanticEdge = (id: string, source: string, target: string, attestation: "attested" | "exploratory"): SemanticEdge =>
  ({ id, source, target, kind: "relation", directed: true, analysisWeight: 1, weightPolicy: "test",
    attestation, provenance: [], rawEdge: { sourcePath: "index.edges", ordinal: 0, raw: {}, rawJson: {}, canonicalJson: "" } } as unknown as SemanticEdge);

export type StyleFixture = {
  readonly snapshot: SemanticGraphSnapshot;
  readonly result: ProjectionResult;
  readonly visibility: RenderVisibility;
  readonly nodes: readonly StyleFixtureNode[];
};

export function buildStyleFixture(nodeCount = 6): StyleFixture {
  const nodes: StyleFixtureNode[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const level = (index === 0 ? 1 : (index % 4) + 2) as 1 | 2 | 3 | 4 | 5;
    nodes.push({
      id: `node-${index}`,
      level,
      ...(index === 1 ? { status: "canon" } : {}),
      title: `Opera ${index} di test con titolo lungo`,
      displayLabel: `Opera ${index}`,
      titleFull: `Opera ${index} di test con titolo lungo completo`,
      parentId: index === 0 ? null : "node-0",
    });
  }
  const edges = nodes.slice(0, -1).map((node, index) =>
    semanticEdge(`edge-${index}`, node.id, nodes[index + 1]!.id, index % 2 === 0 ? "attested" : "exploratory"));
  const positions2: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, index) => {
    positions2[node.id] = { x: (index % 10) * 40, y: Math.floor(index / 10) * 40 };
  });
  const snapshot = {
    schemaVersion: "test",
    digest: "digest-1",
    digestAlgorithm: "sha256-canonical-json-v1",
    rawLedger: {
      indexSchema: "nousos.review-graph/2", manifest: {}, manifestCanonicalJson: "",
      indexHeaderCanonicalJson: "", nodes: [], edges: [], details: [], canonicalBytesDigest: "digest-1",
    },
    nodes: nodes.map(semanticNode),
    edges,
    communityIds: [],
  } as unknown as SemanticGraphSnapshot;
  const result = {
    id: "natural",
    determinism: { resultDigest: "result-1", snapshotDigest: "digest-1" },
    coordinateState: { kind: "coordinates" },
    loadedNodeIds: nodes.map(node => node.id),
    domainEdgeIds: edges.map(edge => edge.id),
    positions2,
    levels: [{ id: "root", parentId: null, depth: 0, maxDepth: 1, loaded: true, childLevelIds: [],
      memberCount: nodes.length, memberDigest: "members-1",
      memberNodeIds: nodes.map(node => node.id), inducedEdgeIds: edges.map(edge => edge.id) }],
    lod: { maxVisibleNodes: nodeCount, maxVisibleSemanticEdges: edges.length,
      maxVisibleVisualRelations: 4, maxVisibleCurves: 4, maxVisibleContainers: 4, maxVisibleFields: 4 },
    visualRelations: [{ visualId: "visual:relation:co:node-0:node-1", semantic: false,
      kind: "co-membership", source: "node-0", target: "node-1", underlyingEdgeIds: [], count: 1 }],
    curves: [],
    containers: [],
    fields: [],
  } as unknown as ProjectionResult;
  const set = (...ids: string[]) => new Set(ids);
  const visibility: RenderVisibility = {
    projectionResultDigest: "result-1", revision: 1, density: 1, levelIds: set("root"),
    nodeIds: set(...nodes.map(node => node.id)), semanticEdgeIds: set(...edges.map(edge => edge.id)),
    visualRelationIds: set("visual:relation:co:node-0:node-1"), curveIds: set(), containerIds: set(), fieldIds: set(),
  };
  return { snapshot, result, visibility, nodes };
}
