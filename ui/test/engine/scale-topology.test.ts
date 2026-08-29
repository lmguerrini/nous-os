import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  ATOMIC,
  HIERARCHICAL,
  HOLOGRAPHIC,
  HOLOGRAPHIC_UNAVAILABLE_CONTEXT,
  RECURSIVE,
  SCALE_TOPOLOGIES,
  assertChildWorld,
  backNavigation,
  childWorld,
  currentNavigableNodeIds,
  enterChildWorld,
  enterableKind,
  holographicContext,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import type { ChildWorld, ScaleTopology } from "#engine/scale-topology.ts";

/** This reads one checked-in projection fixture and does not manufacture graph structure. */
function fixtureGraph(name: string): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(
    join(process.cwd(), "..", "fixtures", "synthetic", "projection", name),
    "utf8",
  )) as unknown);
}

function discoveryGraph(): VisualGraph {
  return fixtureGraph("discovery-at-question.json");
}

function reliabilityAtQuestionGraph(): VisualGraph {
  return fixtureGraph("reliability-at-question.json");
}

const SHARED_CLUSTER = "cluster:shared-synthetic-cluster";
const LONELY_CLUSTER = "cluster:lonely-synthetic-cluster";
const CONFLICT_A = "conflict:a6f8572024a765f3464d02c4ef6b8be64f7877e6afc401c1241f1ce644eed384";
const CONFLICT_B = "conflict:741067d7abefe872c53e3950ff88c05dd102d161d2c04d511981ab4d436e1ce1";
const BRIDGE_A = "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6";
const BRIDGE_B = "bridge:asr_J936VNJ2V7Z8933ATMX7MJ4KE1";
const BRIDGE_C = "bridge:asr_JM31PFESFYAKASHC0PCJ5R73QY";
const SOURCE_VMZQH = "source:src_VMZQH8736EREJCH28C4Q2RPHA1";
const SOURCE_W01T = "source:src_W01T4SYMNAXJA855RC7SPFEFVV";
const ASSERTION_ESSGDR0N = "assertion:asr_ESSGDR0NQDZKN3S4MW5GHA6BRM";
const ASSERTION_SRMYMBJ = "assertion:asr_SRMYMBJ820XS1T5A7KCFDS5QP5";
const SUBJECT_CONFLICT = "subject:conflict-subject";
const REJECTION = "rejection:57ef957416a9cc319ed1579c1e30e450d67a5e5b9a83b88532e7939f1c70d376";
const ASSERTION_3N8REEP = "assertion:asr_3N8REEPQF5FW301DG544P5B6PD";
const ASSERTION_SMTB0CS = "assertion:asr_SMTB0CSZJQ358QNW8833KCCV38";

function sorted(ids: readonly string[]): readonly string[] {
  return [...ids].sort();
}

test("the scale-topology axis is a closed four-member vocabulary, deliberately separate from Organization", () => {
  assert.deepEqual(SCALE_TOPOLOGIES, [ATOMIC, HIERARCHICAL, RECURSIVE, HOLOGRAPHIC]);
  assert.deepEqual([...SCALE_TOPOLOGIES], ["atomic", "hierarchical", "recursive", "holographic"]);
  assert.equal(new Set(SCALE_TOPOLOGIES).size, 4);
});

test("Atomic never enters, for every governed element kind present in the fixture", () => {
  const graph = discoveryGraph();
  for (const node of graph.nodes) {
    assert.equal(enterableKind(graph, node.id, ATOMIC), "not-enterable", node.id);
  }
  const path = rootNavigationPath(ATOMIC);
  for (const node of graph.nodes) {
    assert.throws(() => enterChildWorld(graph, path, node.id), /cannot enter this element/);
  }
});

test("Hierarchical enters only a declared containment root; every other governed kind is refused", () => {
  const graph = discoveryGraph();
  const aggregateIds = new Set(graph.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").map((node) => node.id));
  assert.ok(aggregateIds.size > 0);
  for (const node of graph.nodes) {
    const kind = enterableKind(graph, node.id, HIERARCHICAL);
    if (aggregateIds.has(node.id)) {
      assert.equal(kind, "containment", node.id);
    } else {
      assert.equal(kind, "not-enterable", node.id);
    }
  }
});

test("Hierarchical reaches depth zero on a fixture that declares no aggregate at all", () => {
  const graph = reliabilityAtQuestionGraph();
  assert.ok(graph.nodes.every((node) => node.kind !== "cluster" && node.kind !== "conflict"));
  for (const node of graph.nodes) {
    assert.equal(enterableKind(graph, node.id, HIERARCHICAL), "not-enterable", node.id);
  }
});

test("Recursive and Holographic enter every governed element that carries at least one real relation", () => {
  const graph = discoveryGraph();
  for (const policy of [RECURSIVE, HOLOGRAPHIC] as const) {
    for (const node of graph.nodes) {
      const kind = enterableKind(graph, node.id, policy);
      if (node.kind === "cluster" || node.kind === "conflict") {
        assert.equal(kind, "containment", `${policy} ${node.id}`);
      } else {
        assert.equal(kind, "neighbourhood", `${policy} ${node.id}`);
      }
    }
  }
});

test("Recursive refuses a node with zero real incident relations", () => {
  const graph = discoveryGraph();
  const isolated: VisualGraph = {
    ...graph,
    edges: graph.edges.filter((edge) => edge.source !== "subject:orphan-subject" && edge.target !== "subject:orphan-subject"),
  };
  assert.equal(enterableKind(isolated, "subject:orphan-subject", RECURSIVE), "not-enterable");
});

test("a containment world is exactly the aggregate, its real members, and the defining membership relations, nothing more", () => {
  const graph = discoveryGraph();
  const sharedCluster = childWorld(graph, SHARED_CLUSTER, "containment");
  assert.equal(sharedCluster.kind, "containment");
  assert.equal(sharedCluster.rootId, SHARED_CLUSTER);
  assert.deepEqual(sorted(sharedCluster.nodeIds), sorted([SHARED_CLUSTER, BRIDGE_A, BRIDGE_B, BRIDGE_C]));
  assert.equal(sharedCluster.edgeIds.length, 3);
  assertChildWorld(graph, sharedCluster);

  const conflictA = childWorld(graph, CONFLICT_A, "containment");
  assert.deepEqual(sorted(conflictA.nodeIds), sorted([CONFLICT_A, ASSERTION_3N8REEP, ASSERTION_ESSGDR0N, ASSERTION_SMTB0CS]));
  assert.equal(conflictA.edgeIds.length, 3);
  assertChildWorld(graph, conflictA);

  // An aggregate the IR declares with zero real members is a legitimate empty containment world,
  // not a defect: the cluster itself is the whole of it.
  const lonelyCluster = childWorld(graph, LONELY_CLUSTER, "containment");
  assert.deepEqual(lonelyCluster.nodeIds, [LONELY_CLUSTER]);
  assert.deepEqual(lonelyCluster.edgeIds, []);
  assertChildWorld(graph, lonelyCluster);
});

test("childWorld refuses to build a containment world for a node that is not a declared aggregate", () => {
  const graph = discoveryGraph();
  assert.throws(() => childWorld(graph, BRIDGE_A, "containment"), /requires a cluster or conflict root/);
});

test("a neighbourhood world is exactly one node, its incident relations, and their endpoints, no more", () => {
  const graph = discoveryGraph();
  const bridgeWorld = childWorld(graph, BRIDGE_A, "neighbourhood");
  assert.equal(bridgeWorld.kind, "neighbourhood");
  assert.deepEqual(sorted(bridgeWorld.nodeIds), sorted([BRIDGE_A, SHARED_CLUSTER, SOURCE_W01T, SOURCE_VMZQH]));
  assert.equal(bridgeWorld.edgeIds.length, 3);
  assertChildWorld(graph, bridgeWorld);

  const sourceWorld = childWorld(graph, SOURCE_VMZQH, "neighbourhood");
  assert.deepEqual(
    sorted(sourceWorld.nodeIds),
    sorted([SOURCE_VMZQH, ASSERTION_ESSGDR0N, ASSERTION_SRMYMBJ, BRIDGE_A, BRIDGE_B, BRIDGE_C]),
  );
  assert.equal(sourceWorld.edgeIds.length, 5);
  assertChildWorld(graph, sourceWorld);
});

test("containment and neighbourhood worlds for the same root are two distinct, correctly labelled worlds, never conflated", () => {
  const graph = discoveryGraph();
  const containment = childWorld(graph, LONELY_CLUSTER, "containment");
  const neighbourhood = childWorld(graph, LONELY_CLUSTER, "neighbourhood");
  assert.equal(containment.kind, "containment");
  assert.equal(neighbourhood.kind, "neighbourhood");
  assert.deepEqual(containment.nodeIds, [LONELY_CLUSTER]);
  assert.deepEqual(sorted(neighbourhood.nodeIds), sorted([LONELY_CLUSTER, REJECTION]));
  assert.notDeepEqual(containment.nodeIds, neighbourhood.nodeIds);
  assertChildWorld(graph, containment);
  assertChildWorld(graph, neighbourhood);
});

test("assertChildWorld refuses a fabricated member never declared by a real membership relation", () => {
  const graph = discoveryGraph();
  const real = childWorld(graph, SHARED_CLUSTER, "containment");
  const fabricated: ChildWorld = { ...real, nodeIds: sorted([...real.nodeIds, ASSERTION_3N8REEP]) };
  assert.throws(() => assertChildWorld(graph, fabricated), /does not match the governed relation it must equal exactly/);
});

test("assertChildWorld refuses a fabricated relation that does not exist in the canonical graph", () => {
  const graph = discoveryGraph();
  const real = childWorld(graph, SHARED_CLUSTER, "containment");
  const fabricated: ChildWorld = { ...real, edgeIds: sorted([...real.edgeIds, "ghost-relation-does-not-exist"]) };
  assert.throws(() => assertChildWorld(graph, fabricated), /relation absent from the canonical graph/);
});

test("assertChildWorld refuses a real relation smuggled in that does not actually belong to this child world", () => {
  const graph = discoveryGraph();
  const real = childWorld(graph, SHARED_CLUSTER, "containment");
  // rejects:57ef... is a real governed relation, but it targets the lonely cluster, not this one; its
  // source is also outside this world's own node set, so it fails the endpoint check first.
  const rejectsEdge = graph.edges.find((edge) => edge.kind === "rejects");
  assert.ok(rejectsEdge !== undefined);
  const fabricated: ChildWorld = { ...real, edgeIds: sorted([...real.edgeIds, rejectsEdge.id]) };
  assert.throws(() => assertChildWorld(graph, fabricated), /relation endpoint is missing from its own node set/);
});

test("assertChildWorld refuses a child naming a node absent from the canonical graph entirely", () => {
  const graph = discoveryGraph();
  const real = childWorld(graph, BRIDGE_A, "neighbourhood");
  const fabricated: ChildWorld = { ...real, nodeIds: sorted([...real.nodeIds, "node-not-in-canonical-graph"]) };
  assert.throws(() => assertChildWorld(graph, fabricated), /node absent from the canonical graph/);
});

test("assertChildWorld refuses a duplicate id smuggled into an otherwise-real node or relation set", () => {
  const graph = discoveryGraph();
  const real = childWorld(graph, BRIDGE_A, "neighbourhood");
  const duplicated: ChildWorld = { ...real, nodeIds: [...real.nodeIds, real.nodeIds[0] as string].sort() };
  assert.throws(() => assertChildWorld(graph, duplicated), /set contains a duplicate/);
});

test("childWorld and enterableKind are deterministic and ignore source node and edge array order", () => {
  const graph = discoveryGraph();
  const reordered: VisualGraph = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
  assert.deepEqual(childWorld(graph, SHARED_CLUSTER, "containment"), childWorld(reordered, SHARED_CLUSTER, "containment"));
  assert.deepEqual(childWorld(graph, SOURCE_VMZQH, "neighbourhood"), childWorld(reordered, SOURCE_VMZQH, "neighbourhood"));
  assert.equal(enterableKind(graph, SHARED_CLUSTER, RECURSIVE), enterableKind(reordered, SHARED_CLUSTER, RECURSIVE));
  // Same input, byte-identical output: calling twice on the identical input never drifts.
  assert.deepEqual(childWorld(graph, SHARED_CLUSTER, "containment"), childWorld(graph, SHARED_CLUSTER, "containment"));
});

test("Recursive walks five real levels deep on the fixture, reusing the same enter operation at every level", () => {
  const graph = discoveryGraph();
  let path = rootNavigationPath(RECURSIVE);
  assert.deepEqual(currentNavigableNodeIds(graph, path), sorted(graph.nodes.map((node) => node.id)));

  path = enterChildWorld(graph, path, SHARED_CLUSTER);
  assert.equal(path.worlds.length, 1);
  assert.equal(path.worlds[0]?.kind, "containment");
  assert.deepEqual(currentNavigableNodeIds(graph, path), sorted([SHARED_CLUSTER, BRIDGE_A, BRIDGE_B, BRIDGE_C]));

  path = enterChildWorld(graph, path, BRIDGE_A);
  assert.equal(path.worlds.length, 2);
  assert.equal(path.worlds[1]?.kind, "neighbourhood");
  assert.deepEqual(currentNavigableNodeIds(graph, path), sorted([BRIDGE_A, SHARED_CLUSTER, SOURCE_W01T, SOURCE_VMZQH]));

  path = enterChildWorld(graph, path, SOURCE_VMZQH);
  assert.equal(path.worlds.length, 3);
  assert.equal(path.worlds[2]?.kind, "neighbourhood");
  assert.deepEqual(
    currentNavigableNodeIds(graph, path),
    sorted([SOURCE_VMZQH, ASSERTION_ESSGDR0N, ASSERTION_SRMYMBJ, BRIDGE_A, BRIDGE_B, BRIDGE_C]),
  );

  path = enterChildWorld(graph, path, ASSERTION_ESSGDR0N);
  assert.equal(path.worlds.length, 4);
  assert.equal(path.worlds[3]?.kind, "neighbourhood");
  assert.deepEqual(currentNavigableNodeIds(graph, path), sorted([ASSERTION_ESSGDR0N, SUBJECT_CONFLICT, SOURCE_VMZQH, CONFLICT_A]));

  path = enterChildWorld(graph, path, CONFLICT_A);
  assert.equal(path.worlds.length, 5);
  assert.equal(path.worlds[4]?.kind, "containment");
  assert.deepEqual(
    currentNavigableNodeIds(graph, path),
    sorted([CONFLICT_A, ASSERTION_3N8REEP, ASSERTION_ESSGDR0N, ASSERTION_SMTB0CS]),
  );

  // Back navigation restores the previous world exactly, one level per call.
  const backOnce = backNavigation(path);
  assert.equal(backOnce.worlds.length, 4);
  assert.deepEqual(backOnce.worlds, path.worlds.slice(0, 4));
  let backToRoot = path;
  for (let step = 0; step < path.worlds.length; step += 1) {
    backToRoot = backNavigation(backToRoot);
  }
  assert.deepEqual(backToRoot, rootNavigationPath(RECURSIVE));
  assert.throws(() => backNavigation(backToRoot), /already at the canonical top level/);
});

test("enterChildWorld refuses a target that is not part of the current navigable world", () => {
  const graph = discoveryGraph();
  const path = enterChildWorld(graph, rootNavigationPath(RECURSIVE), SHARED_CLUSTER);
  // ASSERTION_3N8REEP belongs to CONFLICT_A's world, not the shared cluster's.
  assert.throws(() => enterChildWorld(graph, path, ASSERTION_3N8REEP), /not part of the current world/);
});

test("Hierarchical caps depth at one: the declared containment root enters, its member does not", () => {
  const graph = discoveryGraph();
  const path = enterChildWorld(graph, rootNavigationPath(HIERARCHICAL), SHARED_CLUSTER);
  assert.equal(path.worlds.length, 1);
  assert.throws(() => enterChildWorld(graph, path, BRIDGE_A), /cannot enter this element/);
});

function pathTo(graph: VisualGraph, policy: ScaleTopology, ids: readonly string[]) {
  return ids.reduce((path, id) => enterChildWorld(graph, path, id), rootNavigationPath(policy));
}

test("Holographic preserves parent context, the full path back, and its position within the canonical graph", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER, BRIDGE_A]);
  const context = holographicContext(graph, path);
  assert.deepEqual(context.currentWorld, path.worlds[1]);
  assert.deepEqual(context.parent, { kind: "containment", rootId: SHARED_CLUSTER });
  assert.deepEqual(context.pathBack, [
    { kind: "containment", rootId: SHARED_CLUSTER },
    { kind: "neighbourhood", rootId: BRIDGE_A },
  ]);
  assert.equal(context.position.canonicalNodeCount, graph.nodes.length);
  assert.equal(context.position.canonicalEdgeCount, graph.edges.length);
  assert.equal(context.position.worldNodeCount, 4);
  assert.equal(context.position.worldEdgeCount, 3);
});

test("Holographic at the first level has no parent, and reports the real relations crossing its own boundary", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  const context = holographicContext(graph, path);
  assert.equal(context.parent, null);
  assert.equal(context.pathBack.length, 1);
  assert.equal(context.boundaryRelations.length, 6);
  assert.ok(context.boundaryRelations.every((relation) => relation.outsideNodeId === SOURCE_W01T || relation.outsideNodeId === SOURCE_VMZQH));
  assert.ok(context.boundaryRelations.every((relation) => !path.worlds[0]?.edgeIds.includes(relation.edgeId)));
});

test("Holographic reports provenance for exactly the current world's own elements, and the fixed list of what it cannot preserve", () => {
  const graph = discoveryGraph();
  const path = pathTo(graph, HOLOGRAPHIC, [SHARED_CLUSTER]);
  const context = holographicContext(graph, path);
  const expectedIds = sorted([...(path.worlds[0]?.nodeIds ?? []), ...(path.worlds[0]?.edgeIds ?? [])]);
  assert.deepEqual(sorted(context.provenance.map((record) => record.id)), expectedIds);
  assert.ok(context.provenance.every((record) => record.origin.length > 0));
  assert.deepEqual(context.unavailable, HOLOGRAPHIC_UNAVAILABLE_CONTEXT);
  assert.deepEqual([...context.unavailable], [
    "lens semantics",
    "symbolic correspondence",
    "cross-domain facet alignment",
  ]);
});

test("holographicContext refuses a non-Holographic path and an unentered path", () => {
  const graph = discoveryGraph();
  const recursivePath = enterChildWorld(graph, rootNavigationPath(RECURSIVE), SHARED_CLUSTER);
  // ScaleNavigationPath.policy is typed as the whole ScaleTopology union, so a caller can hold a
  // RECURSIVE-built path in a HOLOGRAPHIC-typed variable without a cast; this is the runtime refusal
  // that keeps such a caller honest.
  assert.throws(() => holographicContext(graph, recursivePath), /requires the holographic scale topology/);
  assert.throws(() => holographicContext(graph, rootNavigationPath(HOLOGRAPHIC)), /requires an entered child world/);
});
