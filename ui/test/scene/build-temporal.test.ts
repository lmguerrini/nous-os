import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { ASSEMBLE, MOTION_GRAMMARS, restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { OPENING_ARRIVAL_INSTANT } from "#engine/opening.ts";
import { HIERARCHICAL, enterChildWorld, rootNavigationPath } from "#engine/scale-topology.ts";
import { allTimeMembership, resolveTemporalMembership, resolveTemporalPlacements } from "#engine/temporal.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type { Scene, SceneNode } from "#scene/contract.ts";
import { assertNavigatedGraphSubset, buildScene } from "#scene/build.ts";
import { sceneTokens } from "./support.ts";

// This is the composition mechanism CAP-13's temporal addendum requires: buildScene accepts a temporal
// instant the same way it already accepts a ScaleTopology navigationPath -- an optional trailing render
// input, resolved from #engine/temporal.ts and never carried by VisualState. These tests exercise that
// composition directly, at the scene layer, independent of a mounted renderer: Temporal Playback (WHAT
// exists) and MotionGrammar (HOW it moves) must compose without either axis ever leaking into the
// other's own concern.

const T0 = "2024-01-15T00:00:00+00:00";
const T3 = "2024-09-22T00:00:00+00:00";
const T7 = "2025-06-18T00:00:00+00:00";

function temporalGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function temporalState(graph: VisualGraph, motionGrammar?: MotionGrammar): VisualState {
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
    ...(motionGrammar === undefined ? {} : { motionGrammar }),
  });
}

function sceneIds(scene: Scene): { readonly nodes: readonly string[]; readonly edges: readonly string[] } {
  return {
    nodes: [...scene.nodes.map((node) => node.id)].sort(),
    edges: [...scene.edges.map((edge) => edge.id)].sort(),
  };
}

function requiredSceneNode(nodesById: ReadonlyMap<string, SceneNode>, id: string): SceneNode {
  const node = nodesById.get(id);
  if (node === undefined) {
    throw new Error(`temporal continuity test scene is missing node ${id}`);
  }
  return node;
}

test("an omitted temporalInstant renders the unconditional all-time union, byte-identical to no temporal axis at all", () => {
  const graph = temporalGraph();
  const state = temporalState(graph);
  const tokens = sceneTokens(state);
  const withoutAxis = buildScene(graph, state, DEFAULT_CALIBRATION, tokens);
  const explicitlyOmitted = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", undefined, undefined, undefined);
  assert.equal(JSON.stringify(explicitlyOmitted), JSON.stringify(withoutAxis));
  const ids = sceneIds(withoutAxis);
  const allTime = allTimeMembership(graph);
  assert.deepEqual(ids.nodes, [...allTime.nodeIds].sort());
  assert.deepEqual(ids.edges, [...allTime.edgeIds].sort());
  // The all-time union is unconditional: it includes the temporally unknown orphan and an assertion
  // that has since expired, neither of which any dated instant ever renders (see below).
  assert.ok(ids.nodes.includes("source:src-orphan"));
  assert.ok(ids.nodes.includes("assertion:a2"));
});

test("a temporal instant renders exactly the governed membership at that instant, and never invents an id", () => {
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  const state = temporalState(graph);
  const tokens = sceneTokens(state);
  for (const instant of [T0, T3, T7]) {
    const scene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", undefined, undefined, instant);
    const ids = sceneIds(scene);
    const membership = resolveTemporalMembership(graph, placements, instant);
    assert.deepEqual(ids.nodes, [...membership.nodeIds].sort(), instant);
    assert.deepEqual(ids.edges, [...membership.edgeIds].sort(), instant);
    assert.ok(!ids.nodes.includes("source:src-orphan"), `temporally unknown element rendered at ${instant}`);
  }
});

test("MotionGrammar never changes which ids a temporal instant renders, at rest or mid-phase, for every policy", () => {
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  const membership = resolveTemporalMembership(graph, placements, T3);
  const expectedNodeIds = [...membership.nodeIds].sort();
  const expectedEdgeIds = [...membership.edgeIds].sort();
  assert.ok(expectedNodeIds.length > 0 && expectedNodeIds.length < graph.nodes.length, "T3 must be a genuine partial membership for this test to mean anything");

  const pixelDistinctSignatures = new Set<string>();
  for (const policy of MOTION_GRAMMARS) {
    const state = temporalState(graph, policy);
    const tokens = sceneTokens(state);
    for (const phase of [0, 0.35, restingPhase(policy)]) {
      const scene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", phase, undefined, T3);
      const ids = sceneIds(scene);
      assert.deepEqual(ids.nodes, expectedNodeIds, `${policy}@${phase} changed the rendered node id set`);
      assert.deepEqual(ids.edges, expectedEdgeIds, `${policy}@${phase} changed the rendered relation id set`);
      pixelDistinctSignatures.add(JSON.stringify(scene.nodes.map((node) => [node.opacityPermille, node.radiusPx])));
    }
  }
  // Motion is not a no-op: different policies/phases really do draw the fixed id set differently.
  assert.ok(pixelDistinctSignatures.size > 1, "no policy/phase combination visually differed, motion evidence would be vacuous");
});

test("an animated transition converges exactly to the governed membership at its own target T, at every policy's own resting phase", () => {
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  for (const instant of [T0, T3, T7]) {
    const membership = resolveTemporalMembership(graph, placements, instant);
    const expectedNodeIds = [...membership.nodeIds].sort();
    const expectedEdgeIds = [...membership.edgeIds].sort();
    for (const policy of MOTION_GRAMMARS) {
      const state = temporalState(graph, policy);
      const tokens = sceneTokens(state);
      const scene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", restingPhase(policy), undefined, instant);
      const ids = sceneIds(scene);
      assert.deepEqual(ids.nodes, expectedNodeIds, `${policy} resting phase at ${instant} did not converge to the governed membership`);
      assert.deepEqual(ids.edges, expectedEdgeIds, `${policy} resting phase at ${instant} did not converge to the governed membership`);
      // Resting means resting: every node and relation actually present must be drawn at full
      // strength, never left mid-transition.
      for (const node of scene.nodes) {
        assert.equal(node.opacityPermille, 1000, `${policy}@rest left a node not fully opaque at ${instant}: ${node.id}`);
      }
    }
  }
});

test("Assemble under a temporal instant renders an element valid since an earlier instant unchanged across phase, while an element newly valid at this instant still visibly sweeps in", () => {
  // This is CAP-13's V3 repair, exercised directly: replaying an instant's own Assemble construction
  // must never re-animate history that already happened. Before the fix, resolveStructuralGeometry
  // staggered EVERY element present at an instant by real BFS hop-distance from the hub alone, with no
  // notion of which of them had already been valid since an earlier governed instant -- so a node
  // valid since T0 differed between a mid-phase render of T3 and T3's own resting render exactly as
  // much as a node newly valid at T3 did. This test would have failed against that formula: it asserts
  // an already-valid node renders byte-identically at a mid-phase and at rest, and that at least one
  // newly-valid node genuinely does not.
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  const state = temporalState(graph, ASSEMBLE);
  const tokens = sceneTokens(state);
  const midPhase = 0.4;
  const restPhase = restingPhase(ASSEMBLE);
  const midScene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", midPhase, undefined, T3);
  const restScene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", restPhase, undefined, T3);
  const t3Epoch = Date.parse(T3);

  const alreadyValidIds = new Set<string>();
  const newlyValidIds = new Set<string>();
  for (const node of midScene.nodes) {
    const placement = placements.get(node.id);
    if (placement === undefined || placement.class === "unknown") {
      throw new Error(`temporal fixture node ${node.id} unexpectedly has no dated placement at T3`);
    }
    if (Date.parse(placement.at) < t3Epoch) {
      alreadyValidIds.add(node.id);
    } else {
      newlyValidIds.add(node.id);
    }
  }
  assert.ok(alreadyValidIds.size > 0, "T3 must include a node valid since an earlier governed instant for this test to mean anything");
  assert.ok(newlyValidIds.size > 0, "T3 must include a node newly valid at T3 for this test to mean anything");

  const midById = new Map(midScene.nodes.map((node) => [node.id, node] as const));
  const restById = new Map(restScene.nodes.map((node) => [node.id, node] as const));
  for (const id of alreadyValidIds) {
    const mid = requiredSceneNode(midById, id);
    const rest = requiredSceneNode(restById, id);
    assert.equal(mid.opacityPermille, rest.opacityPermille, `node ${id}, already valid since before T3, must render at the same opacity mid-phase as at rest`);
    assert.deepEqual(mid.position, rest.position, `node ${id}, already valid since before T3, must render at the same position mid-phase as at rest`);
  }
  let sawGenuineSweep = false;
  for (const id of newlyValidIds) {
    const mid = requiredSceneNode(midById, id);
    const rest = requiredSceneNode(restById, id);
    if (mid.opacityPermille !== rest.opacityPermille || JSON.stringify(mid.position) !== JSON.stringify(rest.position)) {
      sawGenuineSweep = true;
    }
  }
  assert.ok(sawGenuineSweep, "at least one node newly valid at T3 must still be mid-transition at a non-resting phase, or the sweep would be vacuous");
});

test("Assemble under the opening arrival instant renders every element already valid at the timeline's own last governed instant unchanged across phase, while an element the timeline never carried to rest still visibly sweeps in", () => {
  // This is the CAP-13 post-audit repair, exercised directly: the opening's own arrival step used to be
  // indistinguishable from an omitted temporalInstant (both a `null` continuity), which replayed the
  // whole structural sweep across the entire graph at that one frame -- the exact defect the test above
  // already proves fixed for every dated instant, just not for the frame the opening plays after them.
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  const state = temporalState(graph, ASSEMBLE);
  const tokens = sceneTokens(state);
  const midPhase = 0.4;
  const restPhase = restingPhase(ASSEMBLE);
  const midScene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", midPhase, undefined, OPENING_ARRIVAL_INSTANT);
  const restScene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", restPhase, undefined, OPENING_ARRIVAL_INSTANT);

  const allTime = allTimeMembership(graph);
  assert.deepEqual(sceneIds(midScene).nodes, [...allTime.nodeIds].sort());
  assert.deepEqual(sceneIds(restScene).nodes, [...allTime.nodeIds].sort());

  let latestDatedInstant: string | undefined;
  let latestDatedEpoch = Number.NEGATIVE_INFINITY;
  for (const placement of placements.values()) {
    if (placement.class === "unknown") {
      continue;
    }
    const epoch = Date.parse(placement.at);
    if (epoch > latestDatedEpoch) {
      latestDatedEpoch = epoch;
      latestDatedInstant = placement.at;
    }
  }
  if (latestDatedInstant === undefined) {
    throw new Error("temporal fixture unexpectedly has no dated placement");
  }
  const alreadyValidIds = resolveTemporalMembership(graph, placements, latestDatedInstant).nodeIds;
  assert.ok(alreadyValidIds.size > 0, "the timeline's own last governed instant must already carry at least one node to rest for this test to mean anything");
  // The all-time union includes the fixture's own withdrawn assertion (valid_to before the timeline's
  // own last governed instant, see the "omitted temporalInstant" test above): it was NOT part of what
  // the timeline last carried to rest, so it belongs on the sweeping side, alongside the temporally
  // unknown orphan, never on the already-valid side.
  assert.ok(!alreadyValidIds.has("assertion:a2"), "an element withdrawn before the timeline's own last governed instant must not count as already valid");

  const midById = new Map(midScene.nodes.map((node) => [node.id, node] as const));
  const restById = new Map(restScene.nodes.map((node) => [node.id, node] as const));

  for (const id of alreadyValidIds) {
    const mid = requiredSceneNode(midById, id);
    const rest = requiredSceneNode(restById, id);
    assert.equal(mid.opacityPermille, rest.opacityPermille, `node ${id}, already valid at the timeline's own last governed instant, must render at the same opacity mid-phase as at rest`);
    assert.deepEqual(mid.position, rest.position, `node ${id}, already valid at the timeline's own last governed instant, must render at the same position mid-phase as at rest`);
  }

  let sawGenuineSweep = false;
  for (const node of midScene.nodes) {
    if (alreadyValidIds.has(node.id)) {
      continue;
    }
    const mid = requiredSceneNode(midById, node.id);
    const rest = requiredSceneNode(restById, node.id);
    if (mid.opacityPermille !== rest.opacityPermille || JSON.stringify(mid.position) !== JSON.stringify(rest.position)) {
      sawGenuineSweep = true;
    }
  }
  assert.ok(sawGenuineSweep, "at least one element the timeline never carried to rest must still be mid-transition at the arrival's own non-resting phase, or the sweep would be vacuous");
});

test("the opening arrival's resting frame stays byte-identical to an omitted temporalInstant's, for every MotionGrammar policy", () => {
  // This is the hard constraint the post-audit repair must never move: the opening's own arrival is
  // graded against this SAME byte-identity, pixel for pixel, in ui/test/browser/opening.spec.ts; this
  // pins the identical guarantee at the scene layer, independent of a mounted renderer or a screenshot.
  const graph = temporalGraph();
  for (const policy of MOTION_GRAMMARS) {
    const state = temporalState(graph, policy);
    const tokens = sceneTokens(state);
    const restPhase = restingPhase(policy);
    const arrival = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", restPhase, undefined, OPENING_ARRIVAL_INSTANT);
    const omitted = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", restPhase, undefined, undefined);
    assert.equal(JSON.stringify(arrival), JSON.stringify(omitted), `${policy} arrival diverged from the omitted-temporalInstant render at rest`);
  }
});

test("negative control: a fabricated temporal membership containing an id absent from the canonical graph is refused by the same boundary scale-topology already shares", () => {
  const graph = temporalGraph();
  const placements = resolveTemporalPlacements(graph);
  const membership = resolveTemporalMembership(graph, placements, T7);
  const genuinelyRendered: VisualGraph = {
    ...graph,
    nodes: graph.nodes.filter((node) => membership.nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => membership.edgeIds.has(edge.id)),
  };
  // This is exactly what resolveTemporalRenderGraph itself checks (assertNavigatedGraphSubset) before
  // handing the result on: the genuine result passes, and a version carrying one fabricated id the
  // canonical graph never had is refused. Exercised directly, the same way
  // ui/test/scene/scale-topology-context.test.ts already exercises this shared boundary, rather than
  // needing a genuinely broken temporal resolver to reach it.
  assert.doesNotThrow(() => assertNavigatedGraphSubset(graph, genuinelyRendered));
  const fabricated: VisualGraph = {
    ...genuinelyRendered,
    nodes: [...genuinelyRendered.nodes, { ...graph.nodes[0]!, id: "assertion:a999-invented" }],
  };
  assert.throws(() => assertNavigatedGraphSubset(graph, fabricated), /names a node absent from the canonical graph/);
});

test("combining a scale-topology navigationPath with a temporal instant fails closed rather than silently drawing an inconsistent world", () => {
  const graph = temporalGraph();
  const state = createVisualState(graph, { ...temporalState(graph), scaleTopology: HIERARCHICAL });
  const tokens = sceneTokens(state);
  // cluster:cluster-beta is a valid Hierarchical containment world against the untouched canonical
  // graph (scale-topology itself never consults time), but at T0 none of its governed members have
  // yet become valid: the temporal instant has already excluded every one of them before scale-topology
  // ever gets to check the world it was handed against what remains. This composition is not required
  // to render something sensible -- only to refuse rather than silently draw an inconsistent world.
  const path = enterChildWorld(graph, rootNavigationPath(HIERARCHICAL), "cluster:cluster-beta");
  assert.throws(
    () => buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", undefined, path, T0),
  );
});
