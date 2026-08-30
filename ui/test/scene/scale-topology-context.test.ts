import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  ATOMIC,
  HIERARCHICAL,
  HOLOGRAPHIC,
  RECURSIVE,
  enterChildWorld,
  holographicContext,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import type { ScaleNavigationPath, ScaleTopology } from "#engine/scale-topology.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type { Scene, SceneEdge, SceneNode } from "#scene/contract.ts";
import { assertNavigatedGraphSubset, buildScene } from "#scene/build.ts";
import { sceneTokens } from "./support.ts";

/** This reads a checked-in projection fixture by file name and does not manufacture graph structure in the test. */
function fixtureGraph(fileName: string): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", fileName);
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function discoveryGraph(): VisualGraph {
  return fixtureGraph("discovery-at-question.json");
}

const SHARED_CLUSTER = "cluster:shared-synthetic-cluster";
const BRIDGE_A = "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6";
const SOURCE_VMZQH = "source:src_VMZQH8736EREJCH28C4Q2RPHA1";
const SOURCE_W01T = "source:src_W01T4SYMNAXJA855RC7SPFEFVV";

/** This creates validated view state at an explicit scaleTopology policy and does not select motion. */
function navigationState(graph: VisualGraph, policy: ScaleTopology): VisualState {
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    cameraKind: "orthographic",
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    morphology: "stellar",
    organization: "flat",
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
    scaleTopology: policy,
  });
}

function idSet(items: readonly { readonly id: string }[]): readonly string[] {
  return [...new Set(items.map((item) => item.id))].sort();
}

function sceneAt(graph: VisualGraph, policy: ScaleTopology, path?: ScaleNavigationPath): Scene {
  const state = navigationState(graph, policy);
  return buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", undefined, path);
}

function pathTo(graph: VisualGraph, policy: ScaleTopology, ids: readonly string[]): ScaleNavigationPath {
  return ids.reduce((path, id) => enterChildWorld(graph, path, id), rootNavigationPath(policy));
}

test("top-level rendering (no world entered) is byte-identical across all four scale-topology policies, with or without a root navigationPath", () => {
  const graph = discoveryGraph();
  const baseline = JSON.stringify(sceneAt(graph, ATOMIC));
  for (const policy of [ATOMIC, HIERARCHICAL, RECURSIVE, HOLOGRAPHIC] as const) {
    const omitted = JSON.stringify(sceneAt(graph, policy));
    assert.equal(omitted, baseline, `${policy} with no navigationPath diverged from the top-level baseline`);
    const rooted = JSON.stringify(sceneAt(graph, policy, rootNavigationPath(policy)));
    assert.equal(rooted, baseline, `${policy} with an empty root navigationPath diverged from the top-level baseline`);
  }
});

test("Recursive renders exactly the entered child world's own node and relation ids, nothing more", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, RECURSIVE, [SHARED_CLUSTER]);
  const world = path.worlds[0];
  if (world === undefined) {
    throw new TypeError("recursive walk lost its entered world");
  }
  const scene = sceneAt(graph, RECURSIVE, path);
  assert.deepEqual(idSet(scene.nodes), [...world.nodeIds].sort());
  assert.deepEqual(idSet(scene.edges), [...world.edgeIds].sort());
});

test("Holographic renders measurably more governed content than Recursive for the identical entered world: real boundary relations reaching a real named outside", () => {
  const graph = discoveryGraph();
  const recursivePath = pathTo(graph, RECURSIVE, [SHARED_CLUSTER]);
  const holographicPath = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  const context = holographicContext(graph, holographicPath);

  const recursiveScene = sceneAt(graph, RECURSIVE, recursivePath);
  const holographicScene = sceneAt(graph, HOLOGRAPHIC, holographicPath);

  // Hand-verified against the engine-level fixture expectations in test/engine/scale-topology.test.ts:
  // SHARED_CLUSTER's containment world has 4 nodes and 3 relations; its boundary carries exactly 6 real
  // relations, all reaching one of two real outside sources.
  assert.equal(context.boundaryRelations.length, 6);
  assert.ok(context.boundaryRelations.every((relation) => (
    relation.outsideNodeId === SOURCE_W01T || relation.outsideNodeId === SOURCE_VMZQH
  )));

  assert.equal(recursiveScene.nodes.length, 4);
  assert.equal(recursiveScene.edges.length, 3);
  assert.equal(holographicScene.nodes.length, 6);
  assert.equal(holographicScene.edges.length, 9);

  const addedNodeIds = idSet(holographicScene.nodes).filter((id) => !idSet(recursiveScene.nodes).includes(id));
  const addedEdgeIds = idSet(holographicScene.edges).filter((id) => !idSet(recursiveScene.edges).includes(id));
  assert.deepEqual(addedNodeIds, [SOURCE_VMZQH, SOURCE_W01T].sort());
  assert.deepEqual(addedEdgeIds, [...context.boundaryRelations.map((relation) => relation.edgeId)].sort());

  assert.notEqual(JSON.stringify(holographicScene), JSON.stringify(recursiveScene));
  process.stdout.write(
    `scale-topology context: holographic added ${addedNodeIds.length} node(s) and ${addedEdgeIds.length} relation(s) `
    + `beyond recursive for the same entered world (${SHARED_CLUSTER})\n`,
  );

  // Every added element is a real governed member of the canonical graph, not an invented one.
  const canonicalNodeIds = new Set(graph.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  for (const id of addedNodeIds) {
    assert.ok(canonicalNodeIds.has(id), `holographic drew a node id absent from the canonical graph: ${id}`);
  }
  for (const id of addedEdgeIds) {
    assert.ok(canonicalEdgeIds.has(id), `holographic drew a relation id absent from the canonical graph: ${id}`);
  }
});

test("Holographic makes an ancestor two levels back perceptible as a real node, when Recursive does not reach it at all", () => {
  const graph = discoveryGraph();
  const steps = [SHARED_CLUSTER, BRIDGE_A, SOURCE_VMZQH];
  const recursivePath = pathTo(graph, RECURSIVE, steps);
  const holographicPath = pathTo(graph, HOLOGRAPHIC, steps);
  const context = holographicContext(graph, holographicPath);

  const recursiveScene = sceneAt(graph, RECURSIVE, recursivePath);
  const holographicScene = sceneAt(graph, HOLOGRAPHIC, holographicPath);

  assert.ok(!idSet(recursiveScene.nodes).includes(SHARED_CLUSTER), "recursive already drew the grandparent root; test fixture assumption is stale");
  const pathBackIds = context.pathBack.map((entry) => entry.rootId);
  assert.ok(pathBackIds.includes(SHARED_CLUSTER));
  assert.ok(idSet(holographicScene.nodes).includes(SHARED_CLUSTER), "holographic did not render the path-back ancestor root");

  const expectedNodeIds = new Set([
    ...context.currentWorld.nodeIds,
    ...context.boundaryRelations.map((relation) => relation.outsideNodeId),
    ...pathBackIds,
  ]);
  const expectedEdgeIds = new Set([
    ...context.currentWorld.edgeIds,
    ...context.boundaryRelations.map((relation) => relation.edgeId),
  ]);
  assert.deepEqual(idSet(holographicScene.nodes), [...expectedNodeIds].sort());
  assert.deepEqual(idSet(holographicScene.edges), [...expectedEdgeIds].sort());
});

test("every governed node and relation id holographic draws beyond the sampled fixture's canonical graph is refused", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  const scene = sceneAt(graph, HOLOGRAPHIC, path);
  const canonicalNodeIds = new Set(graph.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  for (const node of scene.nodes) {
    assert.ok(canonicalNodeIds.has(node.id), `holographic drew a node id absent from the canonical graph: ${node.id}`);
  }
  for (const edge of scene.edges) {
    assert.ok(canonicalEdgeIds.has(edge.id), `holographic drew a relation id absent from the canonical graph: ${edge.id}`);
  }
});

test("buildScene refuses a navigationPath whose policy does not match visualState.scaleTopology", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  assert.throws(
    () => sceneAt(graph, RECURSIVE, path),
    /navigation path policy does not match visualState\.scaleTopology/,
  );
});

test("negative control: assertNavigatedGraphSubset refuses a fabricated node absent from the canonical graph", () => {
  const graph = discoveryGraph();
  const first = graph.nodes[0];
  if (first === undefined) {
    throw new TypeError("scale-topology fixture requires at least one node");
  }
  const fabricated: VisualGraph = { ...graph, nodes: [{ ...first, id: "node:ghost-does-not-exist" }] };
  const output = captureFailure(() => assertNavigatedGraphSubset(graph, fabricated));
  assert.match(output, /names a node absent from the canonical graph/);
});

test("negative control: assertNavigatedGraphSubset refuses a fabricated relation absent from the canonical graph", () => {
  const graph = discoveryGraph();
  const worldNodes = graph.nodes.slice(0, 2);
  const firstEdge = graph.edges[0];
  if (firstEdge === undefined) {
    throw new TypeError("scale-topology fixture requires at least one relation");
  }
  const fabricated: VisualGraph = {
    ...graph,
    nodes: worldNodes,
    edges: [{ ...firstEdge, id: "edge:ghost-does-not-exist" }],
  };
  const output = captureFailure(() => assertNavigatedGraphSubset(graph, fabricated));
  assert.match(output, /names a relation absent from the canonical graph/);
});

test("negative control: assertNavigatedGraphSubset refuses a real relation whose outside endpoint is not in the navigated node set", () => {
  const graph = discoveryGraph();
  const boundaryEdge = graph.edges.find((edge) => edge.source === SOURCE_VMZQH || edge.target === SOURCE_VMZQH);
  if (boundaryEdge === undefined) {
    throw new TypeError("scale-topology fixture requires a relation touching the sampled outside node");
  }
  const sourceNode = graph.nodes.find((node) => node.id === boundaryEdge.source);
  if (sourceNode === undefined) {
    throw new TypeError("scale-topology fixture is missing the boundary relation's own source node");
  }
  // Only the edge's source is included -- its target (a real canonical id) is missing from this
  // navigated node set, so the relation's outside endpoint is unreachable within what is drawn.
  const fabricated: VisualGraph = { ...graph, nodes: [sourceNode], edges: [boundaryEdge] };
  const output = captureFailure(() => assertNavigatedGraphSubset(graph, fabricated));
  assert.match(output, /relation endpoint is missing from its own node set/);
});

test("assertNavigatedGraphSubset accepts the genuine navigated graph buildScene produces", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  const scene = sceneAt(graph, HOLOGRAPHIC, path);
  const navigated: VisualGraph = {
    ...graph,
    nodes: graph.nodes.filter((node) => scene.nodes.some((sceneNode: SceneNode) => sceneNode.id === node.id)),
    edges: graph.edges.filter((edge) => scene.edges.some((sceneEdge: SceneEdge) => sceneEdge.id === edge.id)),
  };
  assert.doesNotThrow(() => assertNavigatedGraphSubset(graph, navigated));
});

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}
