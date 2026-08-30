import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { CAMERA_KINDS } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  ASSEMBLE,
  CONDENSE,
  DISSOLVE,
  MOTION_GRAMMARS,
  PULSE,
  RECONFIGURE,
  RECURSIVE_BLOOM,
  restingPhase,
} from "#engine/motion-grammar.ts";
import type { MotionModulation } from "#engine/motion-grammar.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type { SceneEdge, SceneNode } from "#scene/contract.ts";
import { assertMotionEdgeEndpointsFollowNodes, assertMotionGovernedIdentity, assertMotionRestingCompleteness, buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneTokens } from "./support.ts";

/** This is the sampled phase set used to check governed identity continuity is not a once-only property, mirroring the axis's own sample density (see ui/test/engine/motion-grammar.test.ts). */
const SAMPLE_PHASES = [0, 0.13, 0.25, 0.37, 0.5, 0.63, 0.75, 0.87, 1];

const MORPHOLOGIES: readonly Morphology[] = ["stellar", "neural", "mycelium"];
const ORGANIZATIONS: readonly Organization[] = ["flat", "indra"];
const GENERAL_FIXTURE_FILES = ["discovery-at-question.json", "reliability-at-question.json", "substrate-all-time.json"];

/** This reads a checked-in projection fixture by file name and does not manufacture graph structure in the test. */
function fixtureGraph(fileName: string): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", fileName);
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** This reads the community-scale Indra topology fixture (30 resolved windows) and does not manufacture graph structure in the test. */
function indraFixtureGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "indra", "indra-community-windows.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** This creates validated view state at an explicit morphology, organization, and camera kind, and does not select motion. */
function motionBaseState(graph: VisualGraph, morphology: Morphology, organization: Organization, cameraKind: CameraKind): VisualState {
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    cameraKind,
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    morphology,
    organization,
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  });
}

function idSet(items: readonly { readonly id: string }[]): readonly string[] {
  return items.map((item) => item.id).sort();
}

test("Still, and every policy at its own resting phase, reproduces today's static scene byte for byte across fixtures, morphologies, organizations, and camera kinds", () => {
  let configurations = 0;
  for (const fixtureFile of GENERAL_FIXTURE_FILES) {
    const graph = fixtureGraph(fixtureFile);
    for (const morphology of MORPHOLOGIES) {
      for (const organization of ORGANIZATIONS) {
        for (const cameraKind of CAMERA_KINDS) {
          const state = motionBaseState(graph, morphology, organization, cameraKind);
          const tokens = sceneTokens(state);
          const staticBytes = JSON.stringify(buildScene(graph, state, DEFAULT_CALIBRATION, tokens, cameraKind));
          for (const policy of MOTION_GRAMMARS) {
            const motionState: VisualState = { ...state, motionGrammar: policy };
            const motionBytes = JSON.stringify(buildScene(graph, motionState, DEFAULT_CALIBRATION, tokens, cameraKind));
            assert.equal(
              motionBytes,
              staticBytes,
              `${fixtureFile} ${morphology}/${organization}/${cameraKind} "${policy}" at its own resting phase diverged from the static baseline`,
            );
            configurations += 1;
          }
        }
      }
    }
  }
  // Community-scale Indra coverage: the same claim under organization=indra with 30 resolved
  // aggregate windows actually present, across every morphology and camera kind.
  const indraGraph = indraFixtureGraph();
  for (const morphology of MORPHOLOGIES) {
    for (const cameraKind of CAMERA_KINDS) {
      const state = motionBaseState(indraGraph, morphology, "indra", cameraKind);
      const tokens = sceneTokens(state);
      const staticBytes = JSON.stringify(buildScene(indraGraph, state, DEFAULT_CALIBRATION, tokens, cameraKind));
      for (const policy of MOTION_GRAMMARS) {
        const motionState: VisualState = { ...state, motionGrammar: policy };
        const motionBytes = JSON.stringify(buildScene(indraGraph, motionState, DEFAULT_CALIBRATION, tokens, cameraKind));
        assert.equal(
          motionBytes,
          staticBytes,
          `indra-community-windows.json ${morphology}/indra/${cameraKind} "${policy}" at its own resting phase diverged from the static baseline`,
        );
        configurations += 1;
      }
    }
  }
  assert.ok(
    configurations >= 250,
    `expected broad coverage across fixtures, morphologies, organizations, camera kinds, and every policy; only checked ${configurations}`,
  );
  process.stdout.write(`motion resting byte-identity verified across ${configurations} configurations\n`);
});

test("an explicitly supplied phase argument equal to a policy's own resting phase reproduces the static baseline exactly, and an omitted phase resolves the same default", () => {
  const graph = sceneFixtureGraph();
  const secondGraph = fixtureGraph("substrate-all-time.json");
  let checks = 0;
  for (const [label, subject] of [["discovery-at-question", graph], ["substrate-all-time", secondGraph]] as const) {
    const state = motionBaseState(subject, "stellar", "flat", "orthographic");
    const tokens = sceneTokens(state);
    const staticBytes = JSON.stringify(buildScene(subject, state, DEFAULT_CALIBRATION, tokens, "orthographic"));
    for (const policy of MOTION_GRAMMARS) {
      const motionState: VisualState = { ...state, motionGrammar: policy };
      const defaultPhaseBytes = JSON.stringify(buildScene(subject, motionState, DEFAULT_CALIBRATION, tokens, "orthographic"));
      const explicitPhaseBytes = JSON.stringify(
        buildScene(subject, motionState, DEFAULT_CALIBRATION, tokens, "orthographic", restingPhase(policy)),
      );
      assert.equal(defaultPhaseBytes, staticBytes, `${label} "${policy}" default phase diverged`);
      assert.equal(explicitPhaseBytes, staticBytes, `${label} "${policy}" explicit resting-phase argument diverged`);
      checks += 1;
    }
  }
  assert.equal(checks, 2 * MOTION_GRAMMARS.length);
});

test("governed identity continuity: the modulated node and relation id sets equal the governed graph's own, at every sampled phase and for every policy", () => {
  const subjects: readonly (readonly [string, VisualGraph])[] = [
    ["discovery-at-question", sceneFixtureGraph()],
    ["reliability-at-question", fixtureGraph("reliability-at-question.json")],
  ];
  let checks = 0;
  for (const [label, graph] of subjects) {
    const expectedNodeIds = idSet(graph.nodes);
    const expectedEdgeIds = idSet(graph.edges);
    for (const policy of MOTION_GRAMMARS) {
      for (const phase of SAMPLE_PHASES) {
        const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: policy };
        const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", phase);
        assert.deepEqual(idSet(scene.nodes), expectedNodeIds, `${label} "${policy}"@${phase} node id set changed`);
        assert.deepEqual(idSet(scene.edges), expectedEdgeIds, `${label} "${policy}"@${phase} relation id set changed`);
        checks += 1;
      }
    }
  }
  assert.equal(checks, subjects.length * MOTION_GRAMMARS.length * SAMPLE_PHASES.length);
  process.stdout.write(`per-phase governed identity checked across ${checks} scene builds\n`);
});

test("every relation's own drawn endpoints coincide with its source and target nodes' drawn positions, for every policy at every sampled phase", () => {
  const subjects: readonly (readonly [string, VisualGraph])[] = [
    ["discovery-at-question", sceneFixtureGraph()],
    ["reliability-at-question", fixtureGraph("reliability-at-question.json")],
  ];
  let maxGapPx = 0;
  let checks = 0;
  for (const [label, graph] of subjects) {
    for (const policy of MOTION_GRAMMARS) {
      for (const phase of SAMPLE_PHASES) {
        const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: policy };
        const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", phase);
        // buildScene already enforces this invariant internally (applyMotionGrammar calls it directly
        // against what it produced); this call re-checks it from the outside, against this scene's own
        // already-built nodes and relations, so the claim below is not merely "it didn't throw".
        assert.doesNotThrow(
          () => assertMotionEdgeEndpointsFollowNodes(scene.nodes, scene.edges),
          `${label} "${policy}"@${phase} drew at least one relation detached from its own node`,
        );
        const positionById = new Map(scene.nodes.map((node) => [node.id, node.position] as const));
        for (const edge of scene.edges) {
          const sourcePosition = positionById.get(edge.source);
          const targetPosition = positionById.get(edge.target);
          const start = edge.path[0];
          const end = edge.path[edge.path.length - 1];
          if (sourcePosition === undefined || targetPosition === undefined || start === undefined || end === undefined) {
            throw new TypeError(`${label} "${policy}"@${phase} relation ${edge.id} is missing resolved geometry`);
          }
          maxGapPx = Math.max(maxGapPx, Math.hypot(start.x - sourcePosition.x, start.y - sourcePosition.y));
          maxGapPx = Math.max(maxGapPx, Math.hypot(end.x - targetPosition.x, end.y - targetPosition.y));
        }
        checks += 1;
      }
    }
  }
  assert.equal(checks, subjects.length * MOTION_GRAMMARS.length * SAMPLE_PHASES.length);
  process.stdout.write(`relation-endpoint attachment checked across ${checks} scene builds; measured maximum endpoint gap = ${maxGapPx}px\n`);
});

test("negative control: assertMotionEdgeEndpointsFollowNodes refuses a relation left detached from a node that moved", () => {
  const graph = sceneFixtureGraph();
  const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: RECONFIGURE };
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", 0.25);
  const targetEdge = scene.edges.find((edge) => edge.path[0] !== undefined && edge.path[edge.path.length - 1] !== undefined);
  if (targetEdge === undefined) {
    throw new TypeError("motion fixture requires at least one relation with resolved geometry");
  }
  const displacedNodes: readonly SceneNode[] = scene.nodes.map((node) => (
    node.id === targetEdge.source
      ? { ...node, position: { x: node.position.x + 500, y: node.position.y - 500, z: node.position.z } }
      : node
  ));
  const output = captureFailure(() => assertMotionEdgeEndpointsFollowNodes(displacedNodes, scene.edges));
  assert.match(output, /scene relation is drawn detached from its own source node: /);
  process.stdout.write(`motion-edge-attachment negative control (source detached) observed: ${output}\n`);
});

test("negative control: assertMotionEdgeEndpointsFollowNodes reports a distinct message for a detached target endpoint", () => {
  const graph = sceneFixtureGraph();
  const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: RECONFIGURE };
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", 0.25);
  const targetEdge = scene.edges.find((edge) => edge.path[0] !== undefined && edge.path[edge.path.length - 1] !== undefined);
  if (targetEdge === undefined) {
    throw new TypeError("motion fixture requires at least one relation with resolved geometry");
  }
  const displacedNodes: readonly SceneNode[] = scene.nodes.map((node) => (
    node.id === targetEdge.target
      ? { ...node, position: { x: node.position.x - 500, y: node.position.y + 500, z: node.position.z } }
      : node
  ));
  const output = captureFailure(() => assertMotionEdgeEndpointsFollowNodes(displacedNodes, scene.edges));
  assert.match(output, /scene relation is drawn detached from its own target node: /);
  process.stdout.write(`motion-edge-attachment negative control (target detached) observed: ${output}\n`);
});

test("assertMotionEdgeEndpointsFollowNodes accepts the genuinely attached case", () => {
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, motionBaseState(graph, "stellar", "flat", "orthographic"), DEFAULT_CALIBRATION, sceneTokens(motionBaseState(graph, "stellar", "flat", "orthographic")), "orthographic");
  assert.doesNotThrow(() => assertMotionEdgeEndpointsFollowNodes(scene.nodes, scene.edges));
});

test("Reconfigure genuinely moves a relation's own drawn endpoints away from its resting geometry mid-phase, proving the edge-follows-node fix is live and not a no-op", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const stillPathById = new Map<string, readonly { readonly x: number; readonly y: number }[]>(
    stillScene.edges.map((edge) => [edge.id, edge.path]),
  );
  const reconfigureState: VisualState = { ...baseState, motionGrammar: RECONFIGURE };
  const midCycle = buildScene(graph, reconfigureState, DEFAULT_CALIBRATION, sceneTokens(reconfigureState), "orthographic", 0.25);
  let movedEdgeCount = 0;
  for (const edge of midCycle.edges) {
    const restingPath = stillPathById.get(edge.id);
    if (restingPath === undefined) {
      throw new TypeError(`reconfigure edge-geometry fixture is missing a resting path for relation: ${edge.id}`);
    }
    const restingStart = restingPath[0];
    const movedStart = edge.path[0];
    if (restingStart === undefined || movedStart === undefined) {
      throw new TypeError(`reconfigure edge-geometry fixture is missing resolved geometry for relation: ${edge.id}`);
    }
    if (restingStart.x !== movedStart.x || restingStart.y !== movedStart.y) {
      movedEdgeCount += 1;
    }
  }
  assert.ok(movedEdgeCount > 0, "Reconfigure at phase 0.25 moved no relation's own drawn path relative to the static baseline");
});

test("no invented element: every drawn node and relation id at every sampled phase is a real graph id, not merely the same count", () => {
  const graph = sceneFixtureGraph();
  const knownNodeIds = new Set(graph.nodes.map((node) => node.id));
  const knownEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  for (const policy of MOTION_GRAMMARS) {
    for (const phase of SAMPLE_PHASES) {
      const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: policy };
      const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", phase);
      for (const node of scene.nodes) {
        assert.ok(knownNodeIds.has(node.id), `"${policy}"@${phase} drew a node id absent from the governed graph: ${node.id}`);
      }
      for (const edge of scene.edges) {
        assert.ok(knownEdgeIds.has(edge.id), `"${policy}"@${phase} drew a relation id absent from the governed graph: ${edge.id}`);
      }
    }
  }
});

test("z stays layout-only under motion: no policy, at any sampled phase, changes a node's z coordinate", () => {
  const graph = sceneFixtureGraph();
  const stillState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, stillState, DEFAULT_CALIBRATION, sceneTokens(stillState), "orthographic");
  const stillZById = new Map(stillScene.nodes.map((node) => [node.id, node.position.z]));
  for (const policy of MOTION_GRAMMARS) {
    for (const phase of SAMPLE_PHASES) {
      const state: VisualState = { ...stillState, motionGrammar: policy };
      const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", phase);
      for (const node of scene.nodes) {
        assert.equal(node.position.z, stillZById.get(node.id), `"${policy}"@${phase} moved node ${node.id} in z`);
      }
    }
  }
});

test("transient omission is allowed; resting omission is not, for the same policy on the same graph", () => {
  // Stellar is used deliberately: it is the one morphology whose static scene never forces a node's
  // opacity to zero on its own (unlike Mycelium's blind terminals), so any zero-opacity node observed
  // here is attributable to motion alone.
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");

  for (const policy of [ASSEMBLE, DISSOLVE] as const) {
    const rest = restingPhase(policy);
    const nonRestPhase = rest === 0 ? 1 : 0;
    const motionState: VisualState = { ...baseState, motionGrammar: policy };

    const transientScene = buildScene(graph, motionState, DEFAULT_CALIBRATION, sceneTokens(motionState), "orthographic", nonRestPhase);
    assert.ok(
      transientScene.nodes.some((node) => node.opacityPermille === 0),
      `"${policy}" at its own non-resting phase ${nonRestPhase} never omitted anything, so the "transient omission is allowed" half is vacuous`,
    );

    const restingScene = buildScene(graph, motionState, DEFAULT_CALIBRATION, sceneTokens(motionState), "orthographic", rest);
    assert.ok(
      restingScene.nodes.every((node) => node.opacityPermille > 0),
      `"${policy}" omitted a node at its own resting phase ${rest}`,
    );
    assert.ok(
      restingScene.edges.every((edge) => edge.opacityPermille > 0),
      `"${policy}" omitted a relation at its own resting phase ${rest}`,
    );
  }
});

test("determinism: repeated buildScene calls on identical input, including phase, are byte-identical and independent of call order", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const tokens = sceneTokens(baseState);

  for (const policy of MOTION_GRAMMARS) {
    const state: VisualState = { ...baseState, motionGrammar: policy };
    const first = JSON.stringify(buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", 0.42));
    const second = JSON.stringify(buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", 0.42));
    assert.equal(first, second, `"${policy}" repeated calls diverged`);
  }

  const forward = MOTION_GRAMMARS.flatMap((policy) => SAMPLE_PHASES.map((phase) => {
    const state: VisualState = { ...baseState, motionGrammar: policy };
    return [`${policy}@${phase}`, JSON.stringify(buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", phase))] as const;
  }));
  const backward = [...MOTION_GRAMMARS].reverse().flatMap((policy) => [...SAMPLE_PHASES].reverse().map((phase) => {
    const state: VisualState = { ...baseState, motionGrammar: policy };
    return [`${policy}@${phase}`, JSON.stringify(buildScene(graph, state, DEFAULT_CALIBRATION, tokens, "orthographic", phase))] as const;
  }));
  const forwardByKey = new Map(forward);
  for (const [key, bytes] of backward) {
    assert.equal(forwardByKey.get(key), bytes, `${key} depends on call order`);
  }
});

test("Reconfigure actually displaces a node away from its resolved static position mid-phase, proving the offset channel is live", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const reconfigureState: VisualState = { ...baseState, motionGrammar: RECONFIGURE };
  const midCycle = buildScene(graph, reconfigureState, DEFAULT_CALIBRATION, sceneTokens(reconfigureState), "orthographic", 0.25);
  assert.ok(
    midCycle.nodes.some((node, index) => {
      const still = stillScene.nodes[index];
      return still !== undefined && still.id === node.id && (node.position.x !== still.position.x || node.position.y !== still.position.y);
    }),
    "Reconfigure at phase 0.25 displaced no node relative to the static baseline",
  );
});

test("Reconfigure's offset channel is genuinely driven by calibration.layout.idealEdgeLengthPx: displacement scales exactly with that parameter, not with a node's own radius or a fixed constant", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const reconfigureState: VisualState = { ...baseState, motionGrammar: RECONFIGURE };
  const tokens = sceneTokens(reconfigureState);
  // breathingEnvelope(0.25) = sin(2*pi*0.25) = 1, its own peak magnitude, so every node's offset
  // channel is live here (see motion-grammar.ts's own breathingAmplitude, never zero at any seed).
  const displacedPhase = 0.25;

  function narrowedCalibration(idealEdgeLengthPx: number): CalibrationProfile {
    return { ...DEFAULT_CALIBRATION, layout: { ...DEFAULT_CALIBRATION.layout, idealEdgeLengthPx } };
  }

  // Only layout.idealEdgeLengthPx differs between the two profiles below; every node-sizing
  // parameter (salience.min/maxNodeSizePx, degreeExponentPermille) is held fixed, so a node's own
  // resolved radiusPx is identical under both -- isolating this test's claim to the reference this
  // capability's own defect and fix are about, not to a confound from node size also moving.
  const narrowCalibration = narrowedCalibration(60);
  const wideCalibration = narrowedCalibration(240);
  const referenceRatio = wideCalibration.layout.idealEdgeLengthPx / narrowCalibration.layout.idealEdgeLengthPx;

  type ResolvedMotion = {
    readonly offsets: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>;
    readonly restingRadiusById: ReadonlyMap<string, number>;
  };

  function resolveMotion(calibration: CalibrationProfile): ResolvedMotion {
    // The resting-phase build and the displaced-phase build below share this one calibration, so
    // idealEdgeLengthPx's own separate effect on the force layout itself (it is also the layout's
    // target edge length) cancels out of this per-calibration delta: what is left is exactly the
    // offset channel's own contribution. (Radius is NOT compared resting-vs-displaced here: Reconfigure's
    // own scale channel legitimately changes radiusPx between those two phases, independent of this
    // control's own claim about the offset channel.)
    const resting = buildScene(graph, reconfigureState, calibration, tokens, "orthographic", restingPhase(RECONFIGURE));
    const displaced = buildScene(graph, reconfigureState, calibration, tokens, "orthographic", displacedPhase);
    const restingPositionById = new Map(resting.nodes.map((node) => [node.id, node.position]));
    const restingRadiusById = new Map(resting.nodes.map((node) => [node.id, node.radiusPx]));
    const offsets = new Map<string, { readonly dx: number; readonly dy: number }>();
    for (const node of displaced.nodes) {
      const restingPosition = restingPositionById.get(node.id);
      if (restingPosition === undefined) {
        throw new TypeError(`reconfigure wiring control is missing a resting position for node: ${node.id}`);
      }
      offsets.set(node.id, { dx: node.position.x - restingPosition.x, dy: node.position.y - restingPosition.y });
    }
    return { offsets, restingRadiusById };
  }

  const narrowMotion = resolveMotion(narrowCalibration);
  const wideMotion = resolveMotion(wideCalibration);
  const narrowOffsets = narrowMotion.offsets;
  const wideOffsets = wideMotion.offsets;
  assert.equal(narrowOffsets.size, wideOffsets.size);

  // Confirms the isolation claimed above: a node's own resting radius is unaffected by
  // idealEdgeLengthPx (no node-sizing calibration path was touched), so any offset difference below
  // is attributable only to the reference this test is actually about.
  for (const [nodeId, narrowRadius] of narrowMotion.restingRadiusById) {
    assert.equal(wideMotion.restingRadiusById.get(nodeId), narrowRadius, `node ${nodeId} resting radius differed between calibrations that only change layout.idealEdgeLengthPx`);
  }

  let liveChecks = 0;
  for (const [nodeId, narrowOffset] of narrowOffsets) {
    const wideOffset = wideOffsets.get(nodeId);
    if (wideOffset === undefined) {
      throw new TypeError(`reconfigure wiring control is missing a wide-calibration offset for node: ${nodeId}`);
    }
    if (narrowOffset.dx === 0 && narrowOffset.dy === 0) {
      continue;
    }
    // Exact, not approximate: both builds share the identical rounded offsetXPermille/offsetYPermille
    // integer from motion-grammar.ts (calibration never reaches that pure, position-blind axis), so
    // the two calibrations' own pixel offsets differ by exactly referenceRatio -- a fixed reference
    // (the pre-fix node-radius coupling, or a hardcoded constant standing in for idealEdgeLengthPx)
    // would instead leave narrowOffset and wideOffset equal, failing this assertion.
    assert.ok(
      Math.abs(wideOffset.dx - (narrowOffset.dx * referenceRatio)) < 1e-6,
      `node ${nodeId} x offset did not scale with calibration.layout.idealEdgeLengthPx: narrow=${narrowOffset.dx}, wide=${wideOffset.dx}, expected wide=${narrowOffset.dx * referenceRatio}`,
    );
    assert.ok(
      Math.abs(wideOffset.dy - (narrowOffset.dy * referenceRatio)) < 1e-6,
      `node ${nodeId} y offset did not scale with calibration.layout.idealEdgeLengthPx: narrow=${narrowOffset.dy}, wide=${wideOffset.dy}, expected wide=${narrowOffset.dy * referenceRatio}`,
    );
    liveChecks += 1;
  }
  assert.ok(liveChecks > 0, "reconfigure wiring control never observed a live (non-zero) offset to compare, so the claim above is vacuous");
});

/** This is the same plain, unweighted centroid `#scene/build.ts`'s own resolveCondenseGeometry computes, recomputed here from the static scene rather than imported, so this file's own claims about Condense are checked against an independently derived reference point. */
function centroidOf(nodes: readonly SceneNode[]): { readonly x: number; readonly y: number } {
  return {
    x: nodes.reduce((total, node) => total + node.position.x, 0) / nodes.length,
    y: nodes.reduce((total, node) => total + node.position.y, 0) / nodes.length,
  };
}

type StructuralRankForTest = {
  readonly hubId: string;
  readonly rankById: ReadonlyMap<string, number>;
  readonly parentById: ReadonlyMap<string, string>;
};

/**
 * This independently recomputes the same real BFS hop-distance-from-a-hub ranking
 * `#scene/build.ts`'s own (private) `resolveStructuralRank` computes -- from the raw governed graph,
 * never by importing that private function -- so the tests below check the shipped implementation's
 * real behaviour against an independently derived expectation, the same discipline `centroidOf` above
 * already applies to Condense. Mirrors that function's own algorithm exactly: hub = greatest real
 * incidence degree, ties broken by lowest id; BFS hop-distance from the hub, ties broken by lowest
 * neighbour id; a node the relation set never reaches is placed one hop beyond the farthest node
 * actually reached, never left undefined.
 */
function structuralRankForTest(graph: VisualGraph): StructuralRankForTest {
  const nodeIds = [...graph.nodes.map((node) => node.id)].sort();
  const degreeById = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const neighborsById = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of graph.edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1);
    neighborsById.get(edge.source)?.push(edge.target);
    neighborsById.get(edge.target)?.push(edge.source);
  }
  const firstId = nodeIds[0];
  if (firstId === undefined) {
    throw new TypeError("structural rank test fixture requires at least one node");
  }
  let hubId = firstId;
  let hubDegree = -1;
  for (const id of nodeIds) {
    const degree = degreeById.get(id) ?? 0;
    if (degree > hubDegree) {
      hubDegree = degree;
      hubId = id;
    }
  }
  const hopById = new Map<string, number>([[hubId, 0]]);
  const parentById = new Map<string, string>();
  const queue: string[] = [hubId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) {
      continue;
    }
    const hop = hopById.get(current) ?? 0;
    const neighbors = [...(neighborsById.get(current) ?? [])].sort();
    for (const neighborId of neighbors) {
      if (hopById.has(neighborId)) {
        continue;
      }
      hopById.set(neighborId, hop + 1);
      parentById.set(neighborId, current);
      queue.push(neighborId);
    }
  }
  const reachedMaxHop = Math.max(0, ...hopById.values());
  const unreachedHop = reachedMaxHop + 1;
  for (const id of nodeIds) {
    if (!hopById.has(id)) {
      hopById.set(id, unreachedHop);
    }
  }
  const maxHop = Math.max(1, ...hopById.values());
  const rankById = new Map<string, number>([...hopById].map(([id, hop]) => [id, hop / maxHop] as const));
  return { hubId, rankById, parentById };
}

test("Condense actually pulls nodes toward the structure's own centre mid-phase, proving the convergence channel is live -- the defect this fix answers to is that it never repositioned anything", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const centroid = centroidOf(stillScene.nodes);
  const stillById = new Map(stillScene.nodes.map((node) => [node.id, node]));
  const condenseState: VisualState = { ...baseState, motionGrammar: CONDENSE };
  const midCycle = buildScene(graph, condenseState, DEFAULT_CALIBRATION, sceneTokens(condenseState), "orthographic", 0.5);

  let moved = 0;
  for (const node of midCycle.nodes) {
    const still = stillById.get(node.id);
    if (still === undefined) {
      throw new TypeError(`condense fixture is missing a resting position for node: ${node.id}`);
    }
    if (node.position.x === still.position.x && node.position.y === still.position.y) {
      continue;
    }
    moved += 1;
    const restingDistance = Math.hypot(still.position.x - centroid.x, still.position.y - centroid.y);
    const midDistance = Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y);
    assert.ok(midDistance < restingDistance, `node ${node.id} moved away from the structure's own centre instead of toward it: resting=${restingDistance}, mid=${midDistance}`);
  }
  assert.ok(moved > 0, "Condense at phase 0.5 displaced no node relative to the static baseline, so the claim above is vacuous");
});

test("Condense only ever moves a node closer to the structure's own centre than its resting position, never further, at every sampled phase", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const centroid = centroidOf(stillScene.nodes);
  const restingDistanceById = new Map(stillScene.nodes.map((node) => [node.id, Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y)]));
  const condenseState: VisualState = { ...baseState, motionGrammar: CONDENSE };
  for (const phase of SAMPLE_PHASES) {
    const scene = buildScene(graph, condenseState, DEFAULT_CALIBRATION, sceneTokens(condenseState), "orthographic", phase);
    for (const node of scene.nodes) {
      const restingDistance = restingDistanceById.get(node.id);
      if (restingDistance === undefined) {
        throw new TypeError(`condense fixture is missing a resting distance for node: ${node.id}`);
      }
      const distance = Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y);
      assert.ok(
        distance <= restingDistance + 1e-6,
        `node ${node.id}@${phase} sits at distance ${distance} from the structure's own centre, further than its own resting distance ${restingDistance}`,
      );
    }
  }
});

test("Condense's fade and shrink now track each node's own real distance from the structure's centre -- farther nodes fade and shrink strictly more than nearer ones -- replacing the id-hash split this fix removes", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const centroid = centroidOf(stillScene.nodes);
  const stillById = new Map(stillScene.nodes.map((node) => [node.id, node]));
  const distanceById = new Map(stillScene.nodes.map((node) => [node.id, Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y)]));

  const condenseState: VisualState = { ...baseState, motionGrammar: CONDENSE };
  const midCycle = buildScene(graph, condenseState, DEFAULT_CALIBRATION, sceneTokens(condenseState), "orthographic", 0.5);

  // Ratios (mid-phase over resting), not raw pixel values: two nodes' own static radius and opacity
  // already differ for reasons unrelated to Condense (prominence, morphology), so comparing raw
  // radiusPx/opacityPermille across two different nodes would confound Condense's own contribution
  // with that pre-existing difference. The ratio isolates exactly what Condense itself did to a node.
  const ranked = [...midCycle.nodes].sort((left, right) => {
    const leftDistance = distanceById.get(left.id);
    const rightDistance = distanceById.get(right.id);
    if (leftDistance === undefined || rightDistance === undefined) {
      throw new TypeError("condense fixture is missing a resolved distance");
    }
    return leftDistance - rightDistance;
  });

  let strictComparisons = 0;
  for (let index = 1; index < ranked.length; index += 1) {
    const nearer = ranked[index - 1];
    const farther = ranked[index];
    if (nearer === undefined || farther === undefined) {
      continue;
    }
    const nearerDistance = distanceById.get(nearer.id);
    const fartherDistance = distanceById.get(farther.id);
    if (nearerDistance === undefined || fartherDistance === undefined || nearerDistance === fartherDistance) {
      continue;
    }
    const nearerStill = stillById.get(nearer.id);
    const fartherStill = stillById.get(farther.id);
    if (nearerStill === undefined || fartherStill === undefined) {
      throw new TypeError("condense fixture is missing a resting node");
    }
    const nearerOpacityRatio = nearerStill.opacityPermille === 0 ? 0 : nearer.opacityPermille / nearerStill.opacityPermille;
    const fartherOpacityRatio = fartherStill.opacityPermille === 0 ? 0 : farther.opacityPermille / fartherStill.opacityPermille;
    const nearerScaleRatio = nearerStill.radiusPx === 0 ? 0 : nearer.radiusPx / nearerStill.radiusPx;
    const fartherScaleRatio = fartherStill.radiusPx === 0 ? 0 : farther.radiusPx / fartherStill.radiusPx;
    assert.ok(
      fartherOpacityRatio <= nearerOpacityRatio + 1e-9,
      `node ${farther.id} (distance ${fartherDistance}) faded less than closer node ${nearer.id} (distance ${nearerDistance}): ${fartherOpacityRatio} > ${nearerOpacityRatio}`,
    );
    assert.ok(
      fartherScaleRatio <= nearerScaleRatio + 1e-9,
      `node ${farther.id} (distance ${fartherDistance}) shrank less than closer node ${nearer.id} (distance ${nearerDistance}): ${fartherScaleRatio} > ${nearerScaleRatio}`,
    );
    strictComparisons += 1;
  }
  assert.ok(strictComparisons > 0, "condense monotonic-fade check made no real distance comparisons, so the claim above is vacuous");

  // And the two ends of the ranked-by-distance list are genuinely distinct, not merely non-increasing
  // by coincidence of rounding: the single farthest node fades and shrinks strictly more than the
  // single nearest one.
  const nearest = ranked[0];
  const farthest = ranked[ranked.length - 1];
  if (nearest === undefined || farthest === undefined) {
    throw new TypeError("condense fixture requires at least two nodes");
  }
  assert.ok(farthest.opacityPermille < nearest.opacityPermille, "the single farthest node was not strictly more faded than the single nearest node");
});

test("negative control: assertMotionGovernedIdentity refuses a fabricated extra node id", () => {
  const graph = sceneFixtureGraph();
  const state = motionBaseState(graph, "stellar", "flat", "orthographic");
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic");
  const first = scene.nodes[0];
  if (first === undefined) {
    throw new TypeError("motion fixture requires at least one node");
  }
  const fabricated: SceneNode = { ...first, id: "node:motion-ghost" };
  const output = captureFailure(() => assertMotionGovernedIdentity(scene, [...scene.nodes, fabricated], scene.edges));
  assert.match(output, /changed the governed node id set/);
  process.stdout.write(`motion-identity negative control (fabricated node) observed: ${output}\n`);
});

test("negative control: assertMotionGovernedIdentity refuses a dropped relation id", () => {
  const graph = sceneFixtureGraph();
  const state = motionBaseState(graph, "stellar", "flat", "orthographic");
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic");
  assert.ok(scene.edges.length > 1, "motion fixture requires more than one relation for a drop control");
  const output = captureFailure(() => assertMotionGovernedIdentity(scene, scene.nodes, scene.edges.slice(1)));
  assert.match(output, /changed the governed relation id set/);
  process.stdout.write(`motion-identity negative control (dropped relation) observed: ${output}\n`);
});

test("negative control: assertMotionGovernedIdentity refuses relation ids reordered relative to the pre-modulation scene", () => {
  const graph = sceneFixtureGraph();
  const state = motionBaseState(graph, "stellar", "flat", "orthographic");
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic");
  assert.ok(scene.nodes.length > 1, "motion fixture requires more than one node for a reorder control");
  const output = captureFailure(() => assertMotionGovernedIdentity(scene, [...scene.nodes].reverse(), scene.edges));
  assert.match(output, /changed the governed node id set/);
  process.stdout.write(`motion-identity negative control (reordered nodes) observed: ${output}\n`);
});

test("negative control: assertMotionRestingCompleteness refuses a node left dark at its own declared resting phase", () => {
  const dark: MotionModulation = {
    policy: "assemble",
    phase: 1,
    nodes: [{ id: "node:one", opacityPermille: 0, scalePermille: 1000, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 }],
    edges: [{ id: "edge:one", opacityPermille: 1000, revealPermille: 1000 }],
  };
  const output = captureFailure(() => assertMotionRestingCompleteness(dark));
  assert.match(output, /leaves node dark, scaled away, or displaced at its own resting phase: node:one/);
  process.stdout.write(`motion-resting-completeness negative control (dark node) observed: ${output}\n`);
});

test("negative control: assertMotionRestingCompleteness refuses a relation left dark at its own declared resting phase, with a distinct message from the node case", () => {
  const dark: MotionModulation = {
    policy: "dissolve",
    phase: 0,
    nodes: [{ id: "node:one", opacityPermille: 1000, scalePermille: 1000, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 }],
    edges: [{ id: "edge:one", opacityPermille: 0, revealPermille: 0 }],
  };
  const output = captureFailure(() => assertMotionRestingCompleteness(dark));
  assert.match(output, /leaves relation dark at its own resting phase: edge:one/);
  process.stdout.write(`motion-resting-completeness negative control (dark relation) observed: ${output}\n`);
});

test("assertMotionGovernedIdentity and assertMotionRestingCompleteness both accept the genuinely complete, unmodified case", () => {
  const graph = sceneFixtureGraph();
  const state = motionBaseState(graph, "stellar", "flat", "orthographic");
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic");
  assert.doesNotThrow(() => assertMotionGovernedIdentity(scene, scene.nodes, scene.edges));
  const identity: MotionModulation = {
    policy: "still",
    phase: 0,
    nodes: [{ id: "node:one", opacityPermille: 1000, scalePermille: 1000, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 }],
    edges: [{ id: "edge:one", opacityPermille: 1000, revealPermille: 1000 }],
  };
  assert.doesNotThrow(() => assertMotionRestingCompleteness(identity));
});

// ---------------------------------------------------------------------------------------------
// Human review disposition (2026-08-30): geometry/propagation primary, luminance secondary.
// ---------------------------------------------------------------------------------------------

test("Assemble's construction order follows real incidence (BFS hop-distance from the highest-degree hub), never an id: the hub reveals ahead of the single most distant node", () => {
  const graph = sceneFixtureGraph();
  const structural = structuralRankForTest(graph);
  const farthestIds = [...structural.rankById.entries()].filter(([, rank]) => rank === 1).map(([id]) => id);
  assert.ok(farthestIds.length > 0, "structural rank fixture never reaches maximum rank 1, so this test cannot compare against it");
  const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: ASSEMBLE };
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", 0.3);
  const opacityById = new Map(scene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  const hubOpacity = opacityById.get(structural.hubId);
  if (hubOpacity === undefined) {
    throw new TypeError("assemble structural-order fixture is missing the resolved hub node");
  }
  assert.ok(hubOpacity > 0, `assemble hub ${structural.hubId} unexpectedly has zero opacity at phase 0.3, so this comparison is vacuous`);
  for (const farId of farthestIds) {
    const farOpacity = opacityById.get(farId);
    if (farOpacity === undefined) {
      throw new TypeError(`assemble structural-order fixture is missing the resolved farthest node: ${farId}`);
    }
    assert.equal(farOpacity, 0, `expected the single most distant node ${farId} to still be fully unrevealed at phase 0.3 (opacity ${farOpacity}), behind hub ${structural.hubId} (opacity ${hubOpacity})`);
  }
  // Not a permanent exclusion: at Assemble's own resting phase, every node -- including the farthest --
  // is fully revealed, exactly like every other policy's own resting completeness.
  const restingScene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", restingPhase(ASSEMBLE));
  const restingOpacityById = new Map(restingScene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  for (const farId of farthestIds) {
    assert.equal(restingOpacityById.get(farId), 1000, `${farId} is not fully revealed at Assemble's own resting phase`);
  }
});

test("Dissolve's release order mirrors Assemble's, in reverse: the hub persists fully intact while the single most distant node has already begun releasing", () => {
  const graph = sceneFixtureGraph();
  const structural = structuralRankForTest(graph);
  const farthestIds = [...structural.rankById.entries()].filter(([, rank]) => rank === 1).map(([id]) => id);
  assert.ok(farthestIds.length > 0, "structural rank fixture never reaches maximum rank 1, so this test cannot compare against it");
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const stillOpacityById = new Map(stillScene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  const dissolveState: VisualState = { ...baseState, motionGrammar: DISSOLVE };
  const scene = buildScene(graph, dissolveState, DEFAULT_CALIBRATION, sceneTokens(dissolveState), "orthographic", 0.3);
  const opacityById = new Map(scene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  const hubStillOpacity = stillOpacityById.get(structural.hubId);
  const hubDissolveOpacity = opacityById.get(structural.hubId);
  if (hubStillOpacity === undefined || hubDissolveOpacity === undefined) {
    throw new TypeError("dissolve structural-order fixture is missing the resolved hub node");
  }
  assert.equal(hubDissolveOpacity, hubStillOpacity, `hub ${structural.hubId} should still be fully intact (unfaded) at phase 0.3`);
  for (const farId of farthestIds) {
    const farStillOpacity = stillOpacityById.get(farId);
    const farDissolveOpacity = opacityById.get(farId);
    if (farStillOpacity === undefined || farDissolveOpacity === undefined) {
      throw new TypeError(`dissolve structural-order fixture is missing the resolved farthest node: ${farId}`);
    }
    assert.ok(farDissolveOpacity < farStillOpacity, `expected the single most distant node ${farId} to have already begun releasing at phase 0.3 (dissolve=${farDissolveOpacity}, static=${farStillOpacity})`);
  }
});

test("RecursiveBloom's generation grouping comes from real hop-distance from the portal's own hub, never an id hash: the hub's own generation is already resolving while the farthest generation has not yet started", () => {
  const graph = sceneFixtureGraph();
  const structural = structuralRankForTest(graph);
  const farthestIds = [...structural.rankById.entries()].filter(([, rank]) => rank === 1).map(([id]) => id);
  assert.ok(farthestIds.length > 0, "structural rank fixture never reaches maximum rank 1, so this test cannot compare against it");
  const state: VisualState = { ...motionBaseState(graph, "stellar", "flat", "orthographic"), motionGrammar: RECURSIVE_BLOOM };
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", 0.4);
  const opacityById = new Map(scene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  const hubOpacity = opacityById.get(structural.hubId);
  if (hubOpacity === undefined) {
    throw new TypeError("recursive-bloom generation fixture is missing the resolved hub node");
  }
  assert.ok(hubOpacity > 0, `recursive-bloom hub ${structural.hubId} unexpectedly has zero opacity at phase 0.4, so this comparison is vacuous`);
  for (const farId of farthestIds) {
    const farOpacity = opacityById.get(farId);
    if (farOpacity === undefined) {
      throw new TypeError(`recursive-bloom generation fixture is missing the resolved farthest node: ${farId}`);
    }
    assert.equal(farOpacity, 0, `expected the single farthest generation's own node ${farId} to still be unstarted at phase 0.4 (opacity ${farOpacity})`);
  }
  // Not a permanent exclusion: at RecursiveBloom's own resting phase every node is fully resolved.
  const restingScene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), "orthographic", restingPhase(RECURSIVE_BLOOM));
  const restingOpacityById = new Map(restingScene.nodes.map((node) => [node.id, node.opacityPermille] as const));
  for (const farId of farthestIds) {
    assert.equal(restingOpacityById.get(farId), 1000, `${farId} is not fully revealed at RecursiveBloom's own resting phase`);
  }
});

test("Assemble's not-yet-resolved elements grow from their own real BFS parent's position -- geometry carries the propagation, not merely a fade in place", () => {
  const graph = sceneFixtureGraph();
  const structural = structuralRankForTest(graph);
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const stillPositionById = new Map(stillScene.nodes.map((node) => [node.id, node.position] as const));
  const assembleState: VisualState = { ...baseState, motionGrammar: ASSEMBLE };
  // Phase 0: every node's own reveal fraction (see resolveRevealFraction's own docstring) is exactly
  // zero regardless of rank, so every node with a real parent should render at EXACTLY that parent's
  // own static position -- a precise, not merely directional, claim.
  const assembleScene = buildScene(graph, assembleState, DEFAULT_CALIBRATION, sceneTokens(assembleState), "orthographic", 0);
  const assemblePositionById = new Map(assembleScene.nodes.map((node) => [node.id, node.position] as const));
  let checkedChildren = 0;
  for (const [childId, parentId] of structural.parentById) {
    const parentStillPosition = stillPositionById.get(parentId);
    const childAssemblePosition = assemblePositionById.get(childId);
    const childStillPosition = stillPositionById.get(childId);
    if (parentStillPosition === undefined || childAssemblePosition === undefined || childStillPosition === undefined) {
      throw new TypeError(`assemble growth fixture is missing resolved geometry for ${childId} or its parent ${parentId}`);
    }
    assert.ok(
      Math.abs(childAssemblePosition.x - parentStillPosition.x) < 1e-6 && Math.abs(childAssemblePosition.y - parentStillPosition.y) < 1e-6,
      `expected ${childId} to draw at its own real parent ${parentId}'s static position at phase 0: child=(${childAssemblePosition.x},${childAssemblePosition.y}) parent=(${parentStillPosition.x},${parentStillPosition.y})`,
    );
    checkedChildren += 1;
  }
  assert.ok(checkedChildren > 0, "assemble growth fixture resolved no node with a real BFS parent, so this test is vacuous");
  // And this is a genuine displacement, not merely every child already sitting at its parent's own
  // position: at least one checked child's own resting position is measurably apart from its parent's.
  const genuinelyDisplaced = [...structural.parentById].some(([childId, parentId]) => {
    const parentPosition = stillPositionById.get(parentId);
    const childPosition = stillPositionById.get(childId);
    return parentPosition !== undefined && childPosition !== undefined
      && Math.hypot(childPosition.x - parentPosition.x, childPosition.y - parentPosition.y) > 1;
  });
  assert.ok(genuinelyDisplaced, "every child's own resting position already coincided with its parent's, so the growth-from-parent claim above is vacuous");
});

test("Condense's opacity fade is dampened well below full: even the single most peripheral node stays meaningfully visible at the envelope's own peak, while scale still shrinks substantially -- contraction leads, dimming does not", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const condenseState: VisualState = { ...baseState, motionGrammar: CONDENSE };
  for (const phase of SAMPLE_PHASES) {
    const scene = buildScene(graph, condenseState, DEFAULT_CALIBRATION, sceneTokens(condenseState), "orthographic", phase);
    for (const node of scene.nodes) {
      assert.ok(node.opacityPermille >= 590, `node ${node.id}@${phase} opacity ${node.opacityPermille} fell below Condense's own dampened fade floor`);
    }
  }
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const stillRadiusById = new Map(stillScene.nodes.map((node) => [node.id, node.radiusPx] as const));
  const midCycle = buildScene(graph, condenseState, DEFAULT_CALIBRATION, sceneTokens(condenseState), "orthographic", 0.5);
  const shrankSubstantially = midCycle.nodes.some((node) => {
    const staticRadius = stillRadiusById.get(node.id);
    return staticRadius !== undefined && staticRadius > 0 && node.radiusPx / staticRadius < 0.4;
  });
  assert.ok(shrankSubstantially, "no node shrank below 40% of its own static radius at Condense's own envelope peak, so the spatial channel is not carrying real signal");
});

test("Pulse breathes as a real, centroid-distance-propagated wave rather than uniform lockstep: the nearest and farthest node from the structure's own centre reach different scale factors at a shared non-tie phase", () => {
  const graph = sceneFixtureGraph();
  const baseState = motionBaseState(graph, "stellar", "flat", "orthographic");
  const stillScene = buildScene(graph, baseState, DEFAULT_CALIBRATION, sceneTokens(baseState), "orthographic");
  const centroid = centroidOf(stillScene.nodes);
  const ranked = [...stillScene.nodes].sort((left, right) => (
    Math.hypot(left.position.x - centroid.x, left.position.y - centroid.y) - Math.hypot(right.position.x - centroid.x, right.position.y - centroid.y)
  ));
  const nearest = ranked[0];
  const farthest = ranked[ranked.length - 1];
  if (nearest === undefined || farthest === undefined || nearest.id === farthest.id) {
    throw new TypeError("pulse wave fixture requires at least two nodes at genuinely different distances from the centre");
  }
  const stillRadiusById = new Map(stillScene.nodes.map((node) => [node.id, node.radiusPx] as const));
  const pulseState: VisualState = { ...baseState, motionGrammar: PULSE };
  const scene = buildScene(graph, pulseState, DEFAULT_CALIBRATION, sceneTokens(pulseState), "orthographic", 0.2);
  const nearestScene = scene.nodes.find((node) => node.id === nearest.id);
  const farthestScene = scene.nodes.find((node) => node.id === farthest.id);
  const nearestStillRadius = stillRadiusById.get(nearest.id);
  const farthestStillRadius = stillRadiusById.get(farthest.id);
  if (nearestScene === undefined || farthestScene === undefined || nearestStillRadius === undefined || farthestStillRadius === undefined || nearestStillRadius === 0 || farthestStillRadius === 0) {
    throw new TypeError("pulse wave fixture is missing resolved geometry for the nearest or farthest node");
  }
  // Ratios, not raw radii: the two nodes' own static radii already differ for reasons unrelated to
  // Pulse (prominence), so the ratio isolates exactly what Pulse itself contributed.
  const nearestScaleFactor = nearestScene.radiusPx / nearestStillRadius;
  const farthestScaleFactor = farthestScene.radiusPx / farthestStillRadius;
  assert.notEqual(nearestScaleFactor, farthestScaleFactor, "pulse scaled the nearest and farthest node identically at phase 0.2, so no structural wave is actually live");
  // Not a permanent difference: at Pulse's own resting phase both return to exact identity.
  const restingScene = buildScene(graph, pulseState, DEFAULT_CALIBRATION, sceneTokens(pulseState), "orthographic", restingPhase(PULSE));
  const restingNearestRadius = restingScene.nodes.find((node) => node.id === nearest.id)?.radiusPx;
  assert.equal(restingNearestRadius, nearestStillRadius);
});

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}
