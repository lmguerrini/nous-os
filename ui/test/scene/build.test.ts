import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION, assertCalibrationProfile } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import type { RenderedStateCarrier, VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";
import { createEngineGraphView, createRenderedStateCarrier, createSemantic, assertEngineAccessTrace } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Scene } from "#scene/contract.ts";
import {
  SCENE_LABEL_FONT_FAMILY,
  SCENE_LABEL_FONT_WEIGHT,
  SCENE_PERMILLE_QUANTUM,
  SCENE_PERMILLE_SCALE,
  assertSceneFieldRegister,
} from "#scene/contract.ts";
import { buildScene, resolveSceneFilamentLuminance, resolveSceneLabelIds } from "#scene/build.ts";
import { sceneFixtureGraph, sceneTokens, sceneVisualState } from "./support.ts";

/** This is a deliberately non-zero depth used to prove scene depth ignores non-layout stimuli. */
const NON_LAYOUT_DEPTH_STIMULUS = 1;

/** This is a deliberate hue mutation used only to prove camera selection cannot change shared scene channels. */
const HUE_CONTROL_MUTATION_DEGREES = 1;

/** This is the arithmetic identity for node kinds without a kind-specific label boost and is not a tuneable material value. */
const NO_KIND_PRIORITY_BOOST = 0;

/** This is the endpoint count of an unsampled straight quadratic and is not a tuneable path value. */
const QUADRATIC_ENDPOINT_COUNT = 2;

/** This reads the checked-in projection fixture that resolves zero aggregate windows under Indra and does not manufacture graph structure. */
function zeroAggregateFixtureGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "reliability-at-question.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

test("buildScene is byte-deterministic across independent calls and shuffled graph input", () => {
  const graph = sceneFixtureGraph();
  const selected = graph.nodes[0];
  const focused = graph.nodes[1];
  if (selected === undefined || focused === undefined) {
    throw new TypeError("scene fixture requires selected and focused nodes");
  }
  const state = sceneVisualState(graph, selected.id, focused.id);
  assertSceneBuilderDeterministic(
    (input) => buildScene(input, state, DEFAULT_CALIBRATION, sceneTokens(state)),
    graph,
  );

  let controlCall = 0;
  const controlOutput = captureFailure(() => assertSceneBuilderDeterministic((input) => {
    const scene = buildScene(input, state, DEFAULT_CALIBRATION, sceneTokens(state));
    controlCall += 1;
    return controlCall === 1 ? scene : { ...scene, selectedLabelIds: [...scene.selectedLabelIds, "order-control"] };
  }, graph));
  assert.match(controlOutput, /repeated scene bytes differ/);
  process.stdout.write(`scene-determinism negative control observed: ${controlOutput}\n`);
});

test("scene depth remains layout-only under semantic, kind, provenance, and anchor controls", () => {
  const baselineGraph = sceneFixtureGraph();
  const selected = baselineGraph.nodes[0];
  if (selected === undefined) {
    throw new TypeError("scene fixture requires a selected depth control node");
  }
  const graph = graphWithDepthStimuli(baselineGraph);
  const state = sceneVisualState(graph, selected.id);
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), PERSPECTIVE);
  const baselineState = sceneVisualState(baselineGraph, selected.id);
  const baseline = buildScene(baselineGraph, baselineState, DEFAULT_CALIBRATION, sceneTokens(baselineState), PERSPECTIVE);
  assertLayoutDepthOnly(scene, DEFAULT_CALIBRATION);
  assertDepthAndNavigationChannelsMatch(baseline, scene);
  const mutant = structuredClone(scene);
  const first = mutant.nodes[0];
  if (first === undefined) {
    throw new TypeError("scene fixture requires a node depth control");
  }
  const mutablePosition = first.position as { z: number };
  mutablePosition.z = NON_LAYOUT_DEPTH_STIMULUS;
  const controlOutput = captureFailure(() => assertLayoutDepthOnly(mutant, DEFAULT_CALIBRATION));
  assert.match(controlOutput, /non-layout depth at node/);
  process.stdout.write(`scene-depth negative control observed: ${controlOutput}\n`);

  const navigationMutant = structuredClone(scene);
  if (navigationMutant.camera.kind !== "perspective") {
    throw new TypeError("scene fixture requires perspective navigation");
  }
  (navigationMutant.camera.navigation as { minimumDollyPermille: number }).minimumDollyPermille += SCENE_PERMILLE_QUANTUM;
  const navigationControlOutput = captureFailure(() => assertDepthAndNavigationChannelsMatch(baseline, navigationMutant));
  assert.match(navigationControlOutput, /depth or navigation channel changed/);
  process.stdout.write(`scene-navigation negative control observed: ${navigationControlOutput}\n`);
});

test("filament luminance taper is uniform across relations in different governed states", () => {
  const relations = [
    {
      id: "temporal-established",
      governedState: createRenderedStateCarrier([{ enumType: "TemporalDisposition", member: "established" }]),
      taper: resolveSceneFilamentLuminance(DEFAULT_CALIBRATION),
    },
    {
      id: "bridge-rejected-derived",
      governedState: createRenderedStateCarrier([
        { enumType: "BridgeDisposition", member: "rejected" },
        { enumType: "EpistemicClass", member: "derived" },
      ]),
      taper: resolveSceneFilamentLuminance(DEFAULT_CALIBRATION),
    },
  ];
  assert.notDeepEqual(relations[0]?.governedState, relations[1]?.governedState);
  assertUniformFilamentTaper(relations);

  const second = relations[1];
  if (second === undefined) {
    throw new TypeError("filament taper control requires a second relation");
  }
  const mutant = [relations[0], {
    ...second,
    taper: { ...second.taper, luminanceMidPermille: second.taper.luminanceMidPermille + SCENE_PERMILLE_QUANTUM },
  }].filter((relation) => relation !== undefined);
  const controlOutput = captureFailure(() => assertUniformFilamentTaper(mutant));
  assert.match(controlOutput, /filament luminance taper varied across governed states/);
  process.stdout.write(`filament-luminance negative control observed: ${controlOutput}\n`);
});

test("scene resolves renderer inputs for filament picking, labels, aggregates, and navigation", () => {
  const graph = sceneFixtureGraph();
  const relation = graph.edges[0];
  if (relation === undefined) {
    throw new TypeError("scene fixture requires a material control relation");
  }
  const state = { ...sceneVisualState(graph), palette: "interstellar" as const };
  const tokens = sceneTokens(state);
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, tokens);
  assertResolvedRendererInputs(scene, DEFAULT_CALIBRATION, tokens);

  const selectedState = { ...sceneVisualState(graph, relation.id), palette: "interstellar" as const };
  const focusedState = { ...sceneVisualState(graph, null, relation.id), palette: "interstellar" as const };
  const selectedScene = buildScene(graph, selectedState, DEFAULT_CALIBRATION, sceneTokens(selectedState));
  const focusedScene = buildScene(graph, focusedState, DEFAULT_CALIBRATION, sceneTokens(focusedState));
  assertEdgeLabelStateResolution(
    relation,
    scene,
    selectedScene,
    focusedScene,
    DEFAULT_CALIBRATION,
  );
  assertCompleteResolvedTokens(scene, tokens);
  assertQuadraticControlAgreement(scene);
  assertStackingPriorities(graph, scene, selectedScene, relation.id);
  const monochromeState = sceneVisualState(graph);
  const monochromeTokens = sceneTokens(monochromeState);
  assertCompleteResolvedTokens(
    buildScene(graph, monochromeState, DEFAULT_CALIBRATION, monochromeTokens),
    monochromeTokens,
  );

  const curvedCalibration = structuredClone(DEFAULT_CALIBRATION);
  (curvedCalibration.filament as { curvatureMagnitudePermille: number }).curvatureMagnitudePermille =
    DEFAULT_CALIBRATION.morphology.stellar.curvatureMagnitudePermille;
  const curvedScene = buildScene(graph, state, curvedCalibration, tokens);
  assertResolvedRendererInputs(curvedScene, curvedCalibration, tokens);
  assertQuadraticControlAgreement(curvedScene);

  const filteredTokens = Object.fromEntries(
    Object.entries(tokens).filter(([name]) => name !== "surface"),
  );
  const tokenControlOutput = captureFailure(() => buildScene(
    graph,
    state,
    DEFAULT_CALIBRATION,
    filteredTokens,
  ));
  assert.match(tokenControlOutput, /complete resolved token map/);
  process.stdout.write(`scene-token-map negative control observed: ${tokenControlOutput}\n`);

  const curved = curvedScene.edges.find((edge) => edge.path.length > QUADRATIC_ENDPOINT_COUNT);
  if (curved === undefined) {
    throw new TypeError("scene fixture requires a curved relation");
  }
  const geometryControl: Scene = {
    ...curvedScene,
    edges: curvedScene.edges.map((edge) => edge.id === curved.id
      ? { ...edge, controlPoint: { ...edge.controlPoint, x: edge.controlPoint.x + SCENE_PERMILLE_QUANTUM } }
      : edge),
  };
  const geometryControlOutput = captureFailure(() => assertQuadraticControlAgreement(geometryControl));
  assert.match(geometryControlOutput, /quadratic sample disagrees with direct control/);
  process.stdout.write(`scene-quadratic-control negative control observed: ${geometryControlOutput}\n`);

  const stackingEdge = scene.edges.find((edge) => edge.labelCandidacy !== null);
  if (stackingEdge?.labelCandidacy === null || stackingEdge?.labelCandidacy === undefined) {
    throw new TypeError("scene fixture requires an edge stacking control");
  }
  const stackingControl: Scene = {
    ...scene,
    edges: scene.edges.map((edge) => edge.id === stackingEdge.id
      ? { ...edge, stackingPriority: stackingEdge.labelCandidacy?.priority ?? edge.stackingPriority }
      : edge),
  };
  const stackingControlOutput = captureFailure(() => assertStackingPriorities(graph, stackingControl, selectedScene, relation.id));
  assert.match(stackingControlOutput, /edge stacking priority changed/);
  process.stdout.write(`scene-stacking-priority negative control observed: ${stackingControlOutput}\n`);

  const macroState = { ...state, lodBand: "macro" as const };
  const macroTokens = sceneTokens(macroState);
  const macroScene = buildScene(graph, macroState, DEFAULT_CALIBRATION, macroTokens);
  assertResolvedRendererInputs(macroScene, DEFAULT_CALIBRATION, macroTokens, true);

  const first = scene.edges[0];
  if (first === undefined) {
    throw new TypeError("scene fixture requires a material control edge");
  }
  const mutant: Scene = {
    ...scene,
    edges: scene.edges.map((edge) => edge.id === first.id
      ? { ...edge, minimumDeviceWidthPx: edge.minimumDeviceWidthPx + SCENE_PERMILLE_QUANTUM }
      : edge),
  };
  const controlOutput = captureFailure(() => assertResolvedRendererInputs(mutant, DEFAULT_CALIBRATION, tokens));
  assert.match(controlOutput, /filament device-width floor changed/);
  process.stdout.write(`scene-renderer-input negative control observed: ${controlOutput}\n`);
});

test("Indra with zero resolved aggregate windows treats no relation as cross-community", () => {
  const graph = zeroAggregateFixtureGraph();
  const indraState = sceneVisualState(graph);
  const indraScene = buildScene(graph, indraState, DEFAULT_CALIBRATION, sceneTokens(indraState));
  assert.equal(indraScene.aggregates.length, 0, "fixture is expected to resolve zero aggregate windows under Indra");
  assert.equal(indraScene.edges.length, 6, "fixture is expected to carry six relations");

  // Flat's `organization.windows` is always empty, and build.ts already guards Flat against reading
  // that as "every edge is cross-community". None of the material channels crossCommunityOpacity and
  // the cross-community width factor scale (opacityPermille, bodyWidthPx) depend on node position --
  // only on morphology material, the resolved LOD band, and interaction state, all of which this
  // comparison holds fixed across organizations. So if Indra's own zero-window case is guarded the
  // same way Flat already is, its edges' opacity and width must match Flat's, edge for edge; this
  // does not reuse crossCommunityRelationIds or its ownership algorithm at all.
  const flatState = { ...indraState, organization: "flat" as const };
  const flatScene = buildScene(graph, flatState, DEFAULT_CALIBRATION, sceneTokens(flatState));
  assert.equal(flatScene.aggregates.length, 0, "flat control is expected to resolve zero aggregate windows");
  for (const edge of indraScene.edges) {
    const flatEdge = flatScene.edges.find((candidate) => candidate.id === edge.id);
    if (flatEdge === undefined) {
      throw new TypeError(`flat control scene is missing relation ${edge.id}`);
    }
    assert.equal(edge.opacityPermille, flatEdge.opacityPermille, `${edge.id} opacity dampened as cross-community with zero resolved windows`);
    assert.equal(edge.bodyWidthPx, flatEdge.bodyWidthPx, `${edge.id} width dampened as cross-community with zero resolved windows`);
  }

  // Negative control: prove the two comparisons above can actually fail, by dampening a flat edge the
  // way the unfixed code dampened every Indra edge on this fixture (40% opacity, 55% width -- this
  // fixture's own calibrated cross-community factors).
  const dampenedFirst = flatScene.edges[0];
  if (dampenedFirst === undefined) {
    throw new TypeError("flat control scene requires at least one relation");
  }
  const dampenedControl: Scene = {
    ...flatScene,
    edges: flatScene.edges.map((edge) => (edge.id === dampenedFirst.id
      ? {
        ...edge,
        opacityPermille: Math.round((edge.opacityPermille * DEFAULT_CALIBRATION.aggregate.crossWindowRelationOpacityFactorPermille) / SCENE_PERMILLE_SCALE),
        bodyWidthPx: (edge.bodyWidthPx * DEFAULT_CALIBRATION.aggregate.crossWindowRelationWidthFactorPermille) / SCENE_PERMILLE_SCALE,
      }
      : edge)),
  };
  const controlOutput = captureFailure(() => {
    const dampenedEdge = dampenedControl.edges.find((candidate) => candidate.id === dampenedFirst.id);
    if (dampenedEdge === undefined) {
      throw new TypeError("dampened control is missing its target relation");
    }
    assert.equal(dampenedEdge.opacityPermille, dampenedFirst.opacityPermille, `${dampenedEdge.id} opacity dampened as cross-community with zero resolved windows`);
  });
  assert.match(controlOutput, /opacity dampened as cross-community/);
  process.stdout.write(`indra-zero-window negative control observed: ${controlOutput}\n`);
});

test("a non-positive coreSharpnessPermille is refused at both the calibration boundary and the built-scene boundary", () => {
  // node-material.ts (the live shader) applies coreSharpnessPermille as `pow(coreProfile, sharpness)`.
  // At zero this collapses the governed radial gradient into a flat, hard-edged binary-coverage disc --
  // exactly the disc criterion B17 measured and rejected -- so a safe-integer bound alone (which zero
  // and every negative integer already clear) is not enough; both boundaries must refuse it.
  for (const nonPositive of [0, -1]) {
    const badCalibration: CalibrationProfile = {
      ...DEFAULT_CALIBRATION,
      morphology: {
        ...DEFAULT_CALIBRATION.morphology,
        stellar: { ...DEFAULT_CALIBRATION.morphology.stellar, coreSharpnessPermille: nonPositive },
      },
    };
    assert.throws(
      () => assertCalibrationProfile(badCalibration),
      /morphology\.stellar\.coreSharpnessPermille must be a positive safe integer/,
      `calibration boundary accepted coreSharpnessPermille ${nonPositive}`,
    );
  }

  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state));
  const first = scene.nodes[0];
  if (first === undefined) {
    throw new TypeError("scene fixture requires a node to mutate for the coreSharpnessPermille control");
  }
  for (const nonPositive of [0, -1]) {
    const mutant: Scene = {
      ...scene,
      nodes: scene.nodes.map((node) => (node.id === first.id ? { ...node, coreSharpnessPermille: nonPositive } : node)),
    };
    assert.throws(
      () => assertSceneFieldRegister(mutant),
      /coreSharpnessPermille must be a positive safe integer/,
      `built-scene boundary accepted coreSharpnessPermille ${nonPositive}`,
    );
  }
});

test("all three morphologies remain separated in at least three resolved non-halo channels at meso and micro", () => {
  const graph = sceneFixtureGraph();
  const morphologies: readonly Morphology[] = ["stellar", "neural", "mycelium"];
  const scenes = new Map<Morphology, MorphologyBandScenes>();
  for (const morphology of morphologies) {
    const base = sceneVisualState(graph);
    const mesoState = { ...base, morphology, lodBand: "meso" as const };
    const microState = { ...base, morphology, lodBand: "micro" as const };
    scenes.set(morphology, {
      meso: buildScene(graph, mesoState, DEFAULT_CALIBRATION, sceneTokens(mesoState)),
      micro: buildScene(graph, microState, DEFAULT_CALIBRATION, sceneTokens(microState)),
    });
  }
  assertMorphologySceneStructure(graph, scenes);
  assertMorphologySceneSeparation(scenes);

  const neural = requiredMorphologyScenes(scenes, "neural");
  const identicalControl = new Map(scenes);
  identicalControl.set("mycelium", {
    meso: structuredClone(neural.meso),
    micro: structuredClone(neural.micro),
  });
  const controlOutput = captureFailure(() => assertMorphologySceneSeparation(identicalControl));
  assert.match(controlOutput, /neural\/mycelium.*0 distinct non-halo channels/);
  process.stdout.write(`morphology-separation negative control observed: ${controlOutput}\n`);
});

/**
 * GEOMETRY ONLY, per the binding human decision this pins: Neural's axon-like process is selected by
 * the longest incident relation's span in the layout actually resolved, and nothing else. This is a
 * view-dependent visual/material role, not a claim about a stable per-relation property -- the second
 * half of this test demonstrates that directly by re-resolving the same fixture under Indra's
 * independent re-layout and observing the pick move for the same soma. A different committed fixture,
 * calibration, or layout is free to select a different relation; this only pins what the CURRENT
 * fixture resolves to today.
 */
test("Neural's axon-like endpoint is the longest incident relation by resolved span, and the pick is view-dependent under a different layout", () => {
  const graph = sceneFixtureGraph();
  const flatState = { ...sceneVisualState(graph), morphology: "neural" as const, organization: "flat" as const, lodBand: "micro" as const };
  const scene = buildScene(graph, flatState, DEFAULT_CALIBRATION, sceneTokens(flatState));
  const junctions = junctionNodeIds(scene, 2);
  assert.ok(junctions.length > 0, "the fixture requires at least one junction to exercise axon-like selection");

  for (const nodeId of junctions) {
    const incident = incidentEdgesWithSpan(scene, nodeId);
    assert.ok(incident.length >= 2, `${nodeId} is a junction and must carry at least two incident relations`);
    const longest = longestSpan(incident);
    const longestWidth = myEndWidth(longest.edge, nodeId);
    for (const candidate of incident) {
      if (candidate.edge.id === longest.edge.id) {
        continue;
      }
      const candidateWidth = myEndWidth(candidate.edge, nodeId);
      assert.ok(
        longestWidth > candidateWidth,
        `${nodeId}'s longest incident relation ${longest.edge.id} (span ${longest.span}) did not resolve a `
          + `wider endpoint (${longestWidth}) than ${candidate.edge.id} (span ${candidate.span}, width ${candidateWidth})`,
      );
    }
  }

  // Stellar and Mycelium never make this selection: every incident relation at a junction carries the
  // SAME per-morphology dendrite factor, so no relation is ever singled out as strictly widest by span.
  for (const otherMorphology of ["stellar", "mycelium"] as const) {
    const otherState = { ...sceneVisualState(graph), morphology: otherMorphology, organization: "flat" as const, lodBand: "micro" as const };
    const otherScene = buildScene(graph, otherState, DEFAULT_CALIBRATION, sceneTokens(otherState));
    const anyStrictlyWidestBySpan = junctionNodeIds(otherScene, 2).some((nodeId) => {
      const incident = incidentEdgesWithSpan(otherScene, nodeId);
      const longest = longestSpan(incident);
      const longestWidth = myEndWidth(longest.edge, nodeId);
      return incident.some((candidate) => candidate.edge.id !== longest.edge.id && longestWidth > myEndWidth(candidate.edge, nodeId));
    });
    assert.equal(anyStrictlyWidestBySpan, false, `${otherMorphology} must never select a span-based axon-like endpoint`);
  }

  // View-dependence: Indra re-lays the same fixture out independently, so the same soma's longest
  // incident relation is free to change -- and here it does, which is the accepted instability, not a
  // regression to guard against.
  const indraState = { ...sceneVisualState(graph), morphology: "neural" as const, organization: "indra" as const, lodBand: "micro" as const };
  const indraScene = buildScene(graph, indraState, DEFAULT_CALIBRATION, sceneTokens(indraState));
  const indraJunctions = new Set(junctionNodeIds(indraScene, 2));
  const sharedJunctionIds = junctions.filter((nodeId) => indraJunctions.has(nodeId));
  assert.ok(sharedJunctionIds.length > 0, "flat and Indra must share at least one junction node id to compare");
  const picks = sharedJunctionIds.map((nodeId) => ({
    nodeId,
    flatPick: longestSpan(incidentEdgesWithSpan(scene, nodeId)).edge.id,
    indraPick: longestSpan(incidentEdgesWithSpan(indraScene, nodeId)).edge.id,
  }));
  const moved = picks.find((pick) => pick.flatPick !== pick.indraPick);
  assert.ok(moved !== undefined, "no junction's axon-like pick moved between Flat and Indra layouts -- the instability this test exists to demonstrate did not occur");
  process.stdout.write(`axon-like view-dependence observed: ${moved.nodeId} flat picked ${moved.flatPick}, Indra picked ${moved.indraPick}\n`);
});

test("camera selection changes only the camera request while scene channels remain shared", () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const tokens = sceneTokens(state);
  const orthographic = buildScene(graph, state, DEFAULT_CALIBRATION, tokens);
  const cameraFirst = buildScene(graph, state, DEFAULT_CALIBRATION, PERSPECTIVE, tokens);
  const tokenFirst = buildScene(graph, state, DEFAULT_CALIBRATION, tokens, PERSPECTIVE);
  assert.deepEqual(cameraFirst, tokenFirst);
  assertSharedCameraChannels(orthographic, cameraFirst);

  const mutant = structuredClone(cameraFirst);
  const first = mutant.nodes[0];
  if (first === undefined) {
    throw new TypeError("scene fixture requires a camera channel control");
  }
  (first.token as { hueDegrees: number }).hueDegrees += HUE_CONTROL_MUTATION_DEGREES;
  const controlOutput = captureFailure(() => assertSharedCameraChannels(orthographic, mutant));
  assert.match(controlOutput, /camera selection changed resolved scene channels/);
  process.stdout.write(`shared-camera-channel negative control observed: ${controlOutput}\n`);
});

test("buildScene avoids semantic reads, preserves selected provenance, and resolves interaction states", () => {
  const original = sceneFixtureGraph();
  const selected = original.nodes[0];
  const focused = original.nodes[1];
  if (selected === undefined || focused === undefined) {
    throw new TypeError("scene fixture requires selected and focused nodes");
  }
  const protectedGraph = graphWithForbiddenSemantics(original);
  const state = sceneVisualState(protectedGraph, selected.id, focused.id);
  const scene = buildScene(protectedGraph, state, DEFAULT_CALIBRATION, sceneTokens(state));
  assertProvenanceAndInteractions(scene, protectedGraph, selected.id, focused.id);

  const wrongProvenance = protectedGraph.nodes[1]?.derived;
  if (wrongProvenance === undefined) {
    throw new TypeError("scene fixture requires a provenance control");
  }
  const provenanceControlOutput = captureFailure(() => assertProvenanceAndInteractions(
    { ...scene, selectedProvenance: wrongProvenance },
    protectedGraph,
    selected.id,
    focused.id,
  ));
  assert.match(provenanceControlOutput, /selected provenance identity changed/);
  process.stdout.write(`scene-provenance negative control observed: ${provenanceControlOutput}\n`);

  const interactionControl: Scene = {
    ...scene,
    nodes: scene.nodes.map((node) => node.id === selected.id ? { ...node, interaction: "none" } : node),
  };
  const interactionControlOutput = captureFailure(() => assertProvenanceAndInteractions(
    interactionControl,
    protectedGraph,
    selected.id,
    focused.id,
  ));
  assert.match(interactionControlOutput, /selected interaction was not resolved/);
  process.stdout.write(`scene-interaction negative control observed: ${interactionControlOutput}\n`);

  const semanticControlOutput = captureFailure(() => {
    void protectedGraph.nodes[0]?.semantic;
  });
  assert.match(semanticControlOutput, /scene read semantic node content/);
  process.stdout.write(`scene-semantic guard control observed: ${semanticControlOutput}\n`);

  const forced = createEngineGraphView(original);
  const forcedNode = forced.graph.nodes[0] as (typeof forced.graph.nodes)[number] & { readonly semantic?: unknown } | undefined;
  if (forcedNode === undefined) {
    throw new TypeError("scene fixture requires an engine trace control node");
  }
  void forcedNode.semantic;
  const controlOutput = captureFailure(() => assertEngineAccessTrace(forced.trace));
  assert.match(controlOutput, /outside the structural allow-list: node\.semantic/);
  process.stdout.write(`scene-access-trace negative control observed: ${controlOutput}\n`);
});

test("scene label selection keeps calibrated priority and collision ordering", () => {
  const candidates = [
    { id: "low", priority: 10, minimumX: 0, minimumY: 0, maximumX: 10, maximumY: 10 },
    { id: "high", priority: 20, minimumX: 0, minimumY: 0, maximumX: 10, maximumY: 10 },
    { id: "far", priority: 5, minimumX: 100, minimumY: 100, maximumX: 110, maximumY: 110 },
  ];
  const selected = resolveSceneLabelIds(candidates, DEFAULT_CALIBRATION);
  assertResolvedLabelOrder(selected);
  const controlOutput = captureFailure(() => assertResolvedLabelOrder(["low", "far"]));
  assert.match(controlOutput, /label priority or collision ordering changed/);
  process.stdout.write(`scene-label negative control observed: ${controlOutput}\n`);
});

test("scene propagation resolves ordinary travel and reduced-motion endpoints on the same paths", () => {
  const graph = sceneFixtureGraph();
  const ordinaryState = sceneVisualState(graph);
  const reducedState = { ...ordinaryState, reducedMotion: true };
  const ordinary = buildScene(graph, ordinaryState, DEFAULT_CALIBRATION, sceneTokens(ordinaryState));
  const reduced = buildScene(graph, reducedState, DEFAULT_CALIBRATION, sceneTokens(reducedState));
  assertPropagationResolution(ordinary, reduced);

  const first = reduced.edges[0];
  if (first === undefined) {
    throw new TypeError("scene fixture requires a propagation control edge");
  }
  const control: Scene = {
    ...reduced,
    edges: reduced.edges.map((edge) => edge.id === first.id
      ? { ...edge, propagation: { ...edge.propagation, continuous: true, endpointExpressed: false } }
      : edge),
  };
  const controlOutput = captureFailure(() => assertPropagationResolution(ordinary, control));
  assert.match(controlOutput, /reduced propagation remained continuous/);
  process.stdout.write(`scene-propagation negative control observed: ${controlOutput}\n`);
});

function assertSceneBuilderDeterministic(
  builder: (graph: VisualGraph) => Scene,
  graph: VisualGraph,
): void {
  const first = JSON.stringify(builder(graph));
  const second = JSON.stringify(builder(graph));
  if (first !== second) {
    throw new Error("repeated scene bytes differ");
  }
  const shuffled = JSON.stringify(builder({
    ...graph,
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  }));
  if (first !== shuffled) {
    throw new Error("shuffled-input scene bytes differ");
  }
}

function assertProvenanceAndInteractions(
  scene: Scene,
  graph: VisualGraph,
  selectedId: string,
  focusedId: string,
): void {
  const selected = graph.nodes.find((node) => node.id === selectedId);
  if (selected === undefined || scene.selectedProvenance !== selected.derived) {
    throw new Error("selected provenance identity changed");
  }
  if (scene.nodes.find((node) => node.id === selectedId)?.interaction !== "selected") {
    throw new Error("selected interaction was not resolved");
  }
  if (scene.nodes.find((node) => node.id === focusedId)?.interaction !== "focused") {
    throw new Error("focused interaction was not resolved");
  }
  if (!scene.nodes.filter((node) => node.id !== selectedId && node.id !== focusedId).every(
    (node) => node.interaction === "dimmed",
  )) {
    throw new Error("focus dim interaction was not resolved");
  }
}

function assertResolvedLabelOrder(ids: readonly string[]): void {
  if (ids.length !== 2 || ids[0] !== "high" || ids[1] !== "far") {
    throw new Error(`label priority or collision ordering changed: ${ids.join(",")}`);
  }
}

function assertSharedCameraChannels(orthographic: Scene, perspective: Scene): void {
  if (orthographic.camera.kind !== "orthographic" || perspective.camera.kind !== "perspective") {
    throw new Error("camera requests did not resolve their closed kinds");
  }
  const orthographicChannels = JSON.stringify({
    nodes: orthographic.nodes,
    edges: orthographic.edges,
    aggregates: orthographic.aggregates,
  });
  const perspectiveChannels = JSON.stringify({
    nodes: perspective.nodes,
    edges: perspective.edges,
    aggregates: perspective.aggregates,
  });
  if (orthographicChannels !== perspectiveChannels) {
    throw new Error("camera selection changed resolved scene channels");
  }
}

function assertPropagationResolution(ordinary: Scene, reduced: Scene): void {
  if (ordinary.edges.length === 0 || reduced.edges.length !== ordinary.edges.length) {
    throw new Error("scene propagation edge set changed");
  }
  for (const ordinaryEdge of ordinary.edges) {
    const reducedEdge = reduced.edges.find((edge) => edge.id === ordinaryEdge.id);
    if (reducedEdge === undefined || JSON.stringify(reducedEdge.path) !== JSON.stringify(ordinaryEdge.path)) {
      throw new Error(`propagation path changed for ${ordinaryEdge.id}`);
    }
    if (!ordinaryEdge.propagation.continuous || ordinaryEdge.propagation.endpointExpressed) {
      throw new Error(`ordinary propagation did not remain continuous for ${ordinaryEdge.id}`);
    }
    if (reducedEdge.propagation.continuous || !reducedEdge.propagation.endpointExpressed) {
      throw new Error(`reduced propagation remained continuous for ${ordinaryEdge.id}`);
    }
  }
}

function assertCompleteResolvedTokens(scene: Scene, expected: ReturnType<typeof sceneTokens>): void {
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(scene.tokens).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const firstDifference = expectedNames.find((name) => scene.tokens[name] === undefined)
      ?? actualNames.find((name) => expected[name] === undefined)
      ?? "unknown";
    throw new Error(`resolved token map was filtered or changed at ${firstDifference}`);
  }
  for (const name of expectedNames) {
    if (JSON.stringify(scene.tokens[name]) !== JSON.stringify(expected[name])) {
      throw new Error(`resolved token map was filtered or changed at ${name}`);
    }
  }
  for (const name of ["background", "edge", "peak", "text", "textMuted", "accent2", "accent3"]) {
    if (scene.tokens[name] === undefined) {
      throw new Error(`resolved named token is unavailable: ${name}`);
    }
  }
  if (scene.tokens !== expected) {
    throw new Error("resolved token map identity changed at the scene boundary");
  }
}

function assertQuadraticControlAgreement(scene: Scene): void {
  for (const edge of scene.edges) {
    const source = edge.path[0];
    const target = edge.path.at(-1);
    if (source === undefined || target === undefined || edge.path.length < QUADRATIC_ENDPOINT_COUNT) {
      throw new Error(`quadratic path lacks endpoints for ${edge.id}`);
    }
    const sampleCount = edge.path.length - SCENE_PERMILLE_QUANTUM;
    if (edge.path.length === QUADRATIC_ENDPOINT_COUNT) {
      const expectedControl = {
        x: (source.x + target.x) / QUADRATIC_ENDPOINT_COUNT,
        y: (source.y + target.y) / QUADRATIC_ENDPOINT_COUNT,
        z: (source.z + target.z) / QUADRATIC_ENDPOINT_COUNT,
      };
      if (JSON.stringify(edge.controlPoint) !== JSON.stringify(expectedControl)) {
        throw new Error(`quadratic sample disagrees with direct control for ${edge.id} at straight midpoint`);
      }
      continue;
    }
    for (const [index, actual] of edge.path.entries()) {
      const parameter = index / sampleCount;
      const inverse = 1 - parameter;
      const expected = {
        x: (inverse * inverse * source.x) + (2 * inverse * parameter * edge.controlPoint.x) + (parameter * parameter * target.x),
        y: (inverse * inverse * source.y) + (2 * inverse * parameter * edge.controlPoint.y) + (parameter * parameter * target.y),
        z: (inverse * inverse * source.z) + (2 * inverse * parameter * edge.controlPoint.z) + (parameter * parameter * target.z),
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`quadratic sample disagrees with direct control for ${edge.id} at sample ${index}`);
      }
    }
  }
}

function assertStackingPriorities(
  graph: VisualGraph,
  ordinary: Scene,
  selected: Scene,
  selectedEdgeId: string,
): void {
  for (const node of ordinary.nodes) {
    const source = graph.nodes.find((candidate) => candidate.id === node.id);
    if (source === undefined || node.stackingPriority !== source.visual.label_priority) {
      throw new Error(`node stacking priority changed for ${node.id}`);
    }
  }
  for (const edge of ordinary.edges) {
    const source = graph.edges.find((candidate) => candidate.id === edge.id);
    if (source === undefined || edge.stackingPriority !== source.visual.label_priority) {
      throw new Error(`edge stacking priority changed for ${edge.id}`);
    }
  }
  const ordinarySelectedEdge = ordinary.edges.find((edge) => edge.id === selectedEdgeId);
  const selectedEdge = selected.edges.find((edge) => edge.id === selectedEdgeId);
  if (ordinarySelectedEdge === undefined || selectedEdge === undefined
    || ordinarySelectedEdge.stackingPriority !== selectedEdge.stackingPriority) {
    throw new Error(`edge stacking priority changed with interaction for ${selectedEdgeId}`);
  }
  if (ordinarySelectedEdge.labelCandidacy === null || selectedEdge.labelCandidacy === null
    || ordinarySelectedEdge.labelCandidacy.priority === selectedEdge.labelCandidacy.priority) {
    throw new Error(`edge label priority did not remain distinct from stacking for ${selectedEdgeId}`);
  }
}

type FilamentTaperRelation = {
  readonly id: string;
  readonly governedState: RenderedStateCarrier;
  readonly taper: ReturnType<typeof resolveSceneFilamentLuminance>;
};

function assertUniformFilamentTaper(relations: readonly FilamentTaperRelation[]): void {
  const first = relations[0];
  if (first === undefined) {
    throw new TypeError("filament taper comparison requires one relation");
  }
  const expected = JSON.stringify(first.taper);
  for (const relation of relations.slice(1)) {
    if (JSON.stringify(relation.taper) !== expected) {
      throw new Error(`filament luminance taper varied across governed states: ${first.id}/${relation.id}`);
    }
  }
}

function assertResolvedRendererInputs(
  scene: Scene,
  calibration: CalibrationProfile,
  tokens: ReturnType<typeof sceneTokens>,
  aggregateOutline = false,
): void {
  const expectedTaper = resolveSceneFilamentLuminance(calibration);
  if (
    scene.tokenEncoding.gamutCompressionRange !== calibration.labels.collisionPaddingPx / calibration.layout.idealEdgeLengthPx
    || scene.tokenEncoding.gamutCompressionExponent !== calibration.layout.idealEdgeLengthPx / calibration.labels.densityCap
  ) {
    throw new Error("token encoding profile changed");
  }
  if (expectedTaper.luminanceStartPermille <= expectedTaper.luminanceMidPermille
    || expectedTaper.luminanceEndPermille <= expectedTaper.luminanceMidPermille) {
    throw new Error("filament endpoints are not brighter than the mid-span");
  }
  for (const edge of scene.edges) {
    if (edge.pickTolerancePx !== calibration.filament.pickTolerancePx) {
      throw new Error(`filament pick tolerance changed for ${edge.id}`);
    }
    if (edge.minimumDeviceWidthPx !== calibration.filament.minimumDeviceWidthPermille / SCENE_PERMILLE_SCALE) {
      throw new Error(`filament device-width floor changed for ${edge.id}`);
    }
    if (edge.filament.minimumWidthFactorPermille !== calibration.filament.minimumWidthFactorPermille) {
      throw new Error(`filament minimum-width factor changed for ${edge.id}`);
    }
    if (edge.path.length > QUADRATIC_ENDPOINT_COUNT
      && edge.path.length !== calibration.lod.bandThresholds.length + SCENE_PERMILLE_QUANTUM) {
      throw new Error(`filament sample count changed for ${edge.id}`);
    }
    if (JSON.stringify({
      luminanceStartPermille: edge.filament.luminanceStartPermille,
      luminanceMidPermille: edge.filament.luminanceMidPermille,
      luminanceEndPermille: edge.filament.luminanceEndPermille,
    }) !== JSON.stringify(expectedTaper)) {
      throw new Error(`filament luminance resolution changed for ${edge.id}`);
    }
    const candidate = edge.labelCandidacy;
    if (candidate !== null && (
      candidate.sizePx !== calibration.labels.edgeLabelSizePx
      || candidate.fontFamily !== SCENE_LABEL_FONT_FAMILY
      || candidate.fontWeight !== SCENE_LABEL_FONT_WEIGHT
      || candidate.collisionPaddingPx !== calibration.labels.collisionPaddingPx
      || JSON.stringify(candidate.token) !== JSON.stringify(tokens.textMuted)
    )) {
      throw new Error(`edge label material changed for ${edge.id}`);
    }
  }
  for (const node of scene.nodes) {
    if (
      node.haloCoreGapPx !== calibration.luminance.coreBeforeHaloMinimumPx
      || node.haloAlphaStops.length !== calibration.luminance.haloSampleCount
      || node.haloAlphaStops[0]?.alphaMultiplier !== node.haloIntensityPermille / SCENE_PERMILLE_SCALE
      || node.haloAlphaStops.at(-1)?.alphaMultiplier !== 0
    ) {
      throw new Error(`node halo profile changed for ${node.id}`);
    }
    if (node.minimumCoreDeviceRadiusPx !== calibration.salience.minimumCoreDeviceRadiusPx) {
      throw new Error(`node minimum core device radius changed for ${node.id}`);
    }
    const candidate = node.labelCandidacy;
    if (candidate === null) {
      continue;
    }
    const kindPriority = node.kind === "assertion"
      ? calibration.labels.priorityWeights.assertion
      : node.kind === "bridge" ? calibration.labels.priorityWeights.bridge : NO_KIND_PRIORITY_BOOST;
    const minimumPriority = calibration.labels.priorityWeights.node + kindPriority;
    if (
      candidate.sizePx !== calibration.labels.nodeLabelSizePx
      || candidate.opacityPermille !== calibration.labels.nodeLabelOpacityPermille
      || candidate.fontFamily !== SCENE_LABEL_FONT_FAMILY
      || candidate.fontWeight !== SCENE_LABEL_FONT_WEIGHT
      || candidate.collisionPaddingPx !== calibration.labels.collisionPaddingPx
      || candidate.placementOffsetPx !== node.haloRadiusPx
      || candidate.priority < minimumPriority
      || JSON.stringify(candidate.token) !== JSON.stringify(tokens.text)
    ) {
      throw new Error(`node label material changed for ${node.id}`);
    }
  }
  for (const aggregate of scene.aggregates) {
    const expectedStrokeWidth = aggregateOutline
      ? (calibration.filament.baseWidthPx * calibration.lod.macroAggregateOutlineWidthMultiplierPermille) / SCENE_PERMILLE_SCALE
      : calibration.filament.baseWidthPx;
    const expectedStrokeOpacity = aggregateOutline
      ? calibration.lod.macroAggregateOutlineAlphaPermille
      : calibration.aggregate.windowStrokeAlphaPermille;
    if (
      aggregate.windowPaddingPx !== calibration.aggregate.windowPaddingPx
      || aggregate.strokeWidthPx !== expectedStrokeWidth
      || aggregate.strokeOpacityPermille !== expectedStrokeOpacity
      || JSON.stringify(aggregate.token) !== JSON.stringify(tokens.accent3)
    ) {
      throw new Error(`aggregate material changed for ${aggregate.id}`);
    }
  }
  if (scene.camera.kind !== "orthographic"
    || JSON.stringify(scene.camera.navigation) !== JSON.stringify(calibration.camera.orthographic)) {
    throw new Error("orthographic navigation changed");
  }
}

function assertEdgeLabelStateResolution(
  relation: VisualEdge,
  ordinary: Scene,
  selected: Scene,
  focused: Scene,
  calibration: CalibrationProfile,
): void {
  const ordinaryCandidate = ordinary.edges.find((edge) => edge.id === relation.id)?.labelCandidacy;
  const selectedCandidate = selected.edges.find((edge) => edge.id === relation.id)?.labelCandidacy;
  const focusedCandidate = focused.edges.find((edge) => edge.id === relation.id)?.labelCandidacy;
  if (ordinaryCandidate === null || ordinaryCandidate === undefined
    || selectedCandidate === null || selectedCandidate === undefined
    || focusedCandidate === null || focusedCandidate === undefined) {
    throw new TypeError("scene fixture requires ordinary, selected, and focused edge labels");
  }
  // The fixture's default VisualState organizes as Indra, so a relation touching a satellite or
  // spanning two governed aggregates is cross-community and its label carries the same calibrated
  // dampening its filament does (see crossCommunityOpacity/crossCommunityRelationIds in
  // #scene/build.ts). That dampening is state-independent -- it applies identically whether the
  // relation is ordinary, selected, or focused -- so it only shifts every expected value below by the
  // same calibrated amount rather than changing what this check actually proves about state transitions.
  const crossCommunity = isCrossCommunityRelation(ordinary, relation);
  const expectedOpacity = (opacityPermille: number): number => crossCommunity
    ? Math.round((opacityPermille * calibration.aggregate.crossWindowRelationOpacityFactorPermille) / SCENE_PERMILLE_SCALE)
    : opacityPermille;
  const ordinaryPriority = relation.visual.label_priority + calibration.labels.priorityWeights.edge
    - (crossCommunity ? calibration.aggregate.crossWindowRelationLabelPriorityPenalty : 0);
  if (
    ordinaryCandidate.priority !== ordinaryPriority
    || ordinaryCandidate.opacityPermille !== expectedOpacity(calibration.labels.edgeLabelOpacityPermille)
    || selectedCandidate.priority !== ordinaryPriority + calibration.labels.edgeSelectionPriorityBoost
    || selectedCandidate.opacityPermille !== expectedOpacity(calibration.labels.edgeLabelSelectedOpacityPermille)
    || focusedCandidate.priority !== ordinaryPriority + calibration.labels.edgeFocusPriorityBoost
    || focusedCandidate.opacityPermille !== expectedOpacity(calibration.labels.edgeLabelFocusOpacityPermille)
  ) {
    throw new Error(`edge label state material changed for ${relation.id}`);
  }
}

/**
 * This reads the scene's already-resolved aggregates and reapplies the same ownership rule
 * build.ts's crossCommunityRelationIds uses over that same production-derived membership: owned by
 * the window it is a member of, and cross-community when unowned or split between two owners. It
 * does not re-derive window membership itself -- that still comes from the built scene. Because the
 * classification rule is the same rule under test, applied to the same data, this function cannot by
 * itself catch a defect in *which* edges build.ts calls cross-community; what it lets the assertions
 * below confirm is that whatever classification the built scene already reports is dampened by the
 * calibrated magnitude consistently across the ordinary, selected, and focused label states.
 */
function isCrossCommunityRelation(scene: Scene, relation: VisualEdge): boolean {
  const ownerOf = new Map<string, string>();
  for (const aggregate of scene.aggregates) {
    ownerOf.set(aggregate.id, aggregate.id);
    for (const member of aggregate.members) {
      ownerOf.set(member, aggregate.id);
    }
  }
  const sourceOwner = ownerOf.get(relation.source);
  const targetOwner = ownerOf.get(relation.target);
  return sourceOwner === undefined || targetOwner === undefined || sourceOwner !== targetOwner;
}

function assertLayoutDepthOnly(scene: Scene, calibration: CalibrationProfile): void {
  for (const node of scene.nodes) {
    if (node.position.z !== 0) {
      throw new Error(`non-layout depth at node ${node.id}: ${node.position.z}`);
    }
  }
  for (const edge of scene.edges) {
    if (edge.controlPoint.z !== 0) {
      throw new Error(`non-layout control depth on edge ${edge.id}: ${edge.controlPoint.z}`);
    }
    for (const point of edge.path) {
      if (point.z !== 0) {
        throw new Error(`non-layout depth on edge ${edge.id}: ${point.z}`);
      }
    }
    if (edge.propagation.position.z !== 0) {
      throw new Error(`non-layout propagation depth on edge ${edge.id}: ${edge.propagation.position.z}`);
    }
  }
  for (const aggregate of scene.aggregates) {
    if (aggregate.center.z !== 0) {
      throw new Error(`non-layout depth at aggregate ${aggregate.id}: ${aggregate.center.z}`);
    }
  }
  if (scene.camera.kind !== "perspective"
    || JSON.stringify(scene.camera.navigation) !== JSON.stringify(calibration.camera.perspective)) {
    throw new Error("perspective navigation was not resolved solely from calibration");
  }
}

function assertDepthAndNavigationChannelsMatch(baseline: Scene, candidate: Scene): void {
  const depthAndNavigation = (scene: Scene): string => JSON.stringify({
    nodes: scene.nodes.map((node) => ({ id: node.id, z: node.position.z })),
    edges: scene.edges.map((edge) => ({
      id: edge.id,
      control: edge.controlPoint.z,
      path: edge.path.map((point) => point.z),
      propagation: edge.propagation.position.z,
    })),
    aggregates: scene.aggregates.map((aggregate) => ({ id: aggregate.id, z: aggregate.center.z })),
    navigation: scene.camera.navigation,
  });
  if (depthAndNavigation(baseline) !== depthAndNavigation(candidate)) {
    throw new Error("depth or navigation channel changed under governed state, kind, or provenance stimuli");
  }
}

function graphWithDepthStimuli(graph: VisualGraph): VisualGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node, index) => ({
      ...node,
      kind: alternateSilentRole(node),
      rendered: alternateGovernedState(node),
      semantic: createSemantic({ depth: index + NON_LAYOUT_DEPTH_STIMULUS }),
      derived: { value: { depth: index + NON_LAYOUT_DEPTH_STIMULUS }, origin: `depth-control:${node.derived.origin}` },
      visual: {
        ...node.visual,
        role: alternateSilentRole(node),
        anchor: { ...node.visual.anchor, z: index + NON_LAYOUT_DEPTH_STIMULUS },
      },
    })),
    edges: graph.edges.map((edge, index) => ({
      ...edge,
      kind: alternateSilentEdgeRole(edge),
      semantic: createSemantic({ depth: index + NON_LAYOUT_DEPTH_STIMULUS }),
      derived: { value: { depth: index + NON_LAYOUT_DEPTH_STIMULUS }, origin: `depth-control:${edge.derived.origin}` },
      visual: {
        ...edge.visual,
        role: alternateSilentEdgeRole(edge),
        anchor: { ...edge.visual.anchor, z: index + NON_LAYOUT_DEPTH_STIMULUS },
        path: edge.visual.path.map((point) => ({ ...point, z: index + NON_LAYOUT_DEPTH_STIMULUS })),
      },
    })),
  };
}

function alternateSilentRole(node: VisualNode): VisualNode["visual"]["role"] {
  if (node.kind === "source") {
    return "subject";
  }
  if (node.kind === "subject") {
    return "source";
  }
  return node.visual.role;
}

function alternateSilentEdgeRole(edge: VisualEdge): VisualEdge["visual"]["role"] {
  if (edge.kind === "about") {
    return "cites";
  }
  if (edge.kind === "cites") {
    return "about";
  }
  return edge.visual.role;
}

function alternateGovernedState(node: VisualNode): RenderedStateCarrier {
  if (node.kind === "assertion") {
    const current = node.rendered?.[0]?.member;
    return createRenderedStateCarrier([{
      enumType: "TemporalDisposition",
      member: current === "established" ? "excluded" : "established",
    }]);
  }
  if (node.kind === "bridge") {
    const current = node.rendered?.[0]?.member;
    return createRenderedStateCarrier([
      { enumType: "BridgeDisposition", member: current === "accepted" ? "rejected" : "accepted" },
      { enumType: "EpistemicClass", member: "speculative" },
    ]);
  }
  return null;
}

function graphWithForbiddenSemantics(graph: VisualGraph): VisualGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(forbidNodeSemantic),
    edges: graph.edges.map(forbidEdgeSemantic),
  };
}

function forbidNodeSemantic(node: VisualNode): VisualNode {
  const protectedNode = { ...node };
  Object.defineProperty(protectedNode, "semantic", {
    get(): never {
      throw new Error("scene read semantic node content");
    },
  });
  return protectedNode;
}

function forbidEdgeSemantic(edge: VisualEdge): VisualEdge {
  const protectedEdge = { ...edge };
  Object.defineProperty(protectedEdge, "semantic", {
    get(): never {
      throw new Error("scene read semantic edge content");
    },
  });
  return protectedEdge;
}

type MorphologyBandScenes = {
  readonly meso: Scene;
  readonly micro: Scene;
};

type MorphologyChannel = "width" | "curvature" | "junction" | "terminal" | "halo";

const NON_HALO_MORPHOLOGY_CHANNELS: readonly MorphologyChannel[] = [
  "width",
  "curvature",
  "junction",
  "terminal",
];

function assertMorphologySceneStructure(
  graph: VisualGraph,
  scenes: ReadonlyMap<Morphology, MorphologyBandScenes>,
): void {
  const expectedNodes = graph.nodes.map((node) => node.id).sort();
  const expectedEdges = graph.edges
    .map((edge) => [edge.id, edge.source, edge.target])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  let expectedAggregates: string | undefined;
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const bands = requiredMorphologyScenes(scenes, morphology);
    for (const scene of [bands.meso, bands.micro]) {
      assert.deepEqual(scene.nodes.map((node) => node.id).sort(), expectedNodes, `${morphology} node set changed`);
      assert.deepEqual(
        scene.edges.map((edge) => [edge.id, edge.source, edge.target]).sort(([left], [right]) => String(left).localeCompare(String(right))),
        expectedEdges,
        `${morphology} edge set or incidence changed`,
      );
      const aggregates = JSON.stringify(scene.aggregates.map((aggregate) => [aggregate.id, aggregate.members]).sort());
      expectedAggregates ??= aggregates;
      assert.equal(aggregates, expectedAggregates, `${morphology} aggregate/group set changed`);
    }
  }
}

function assertMorphologySceneSeparation(scenes: ReadonlyMap<Morphology, MorphologyBandScenes>): void {
  const pairs: readonly (readonly [Morphology, Morphology])[] = [
    ["stellar", "neural"],
    ["stellar", "mycelium"],
    ["neural", "mycelium"],
  ];
  for (const band of ["meso", "micro"] as const) {
    for (const [leftName, rightName] of pairs) {
      const left = requiredMorphologyScenes(scenes, leftName)[band];
      const right = requiredMorphologyScenes(scenes, rightName)[band];
      const differing = NON_HALO_MORPHOLOGY_CHANNELS.filter(
        (channel) => morphologyChannelFingerprint(left, channel) !== morphologyChannelFingerprint(right, channel),
      );
      if (differing.length < 3) {
        throw new Error(
          `${band} ${leftName}/${rightName} resolved to ${differing.length} distinct non-halo channels: ${differing.join(",")}`,
        );
      }
    }
  }
}

function morphologyChannelFingerprint(scene: Scene, channel: MorphologyChannel): string {
  if (channel === "width") {
    return JSON.stringify(scene.edges.map((edge) => [edge.id, edge.bodyWidthPx, edge.widthStartPx, edge.widthEndPx]));
  }
  if (channel === "curvature") {
    return JSON.stringify(scene.edges.map((edge) => [edge.id, edge.controlPoint]));
  }
  if (channel === "junction") {
    return JSON.stringify({
      nodes: scene.nodes
        .filter((node) => node.junctionGeometry !== null)
        .map((node) => [node.id, node.junctionGeometry]),
      edges: scene.edges.map((edge) => [
        edge.id,
        edge.junctionStartGeometry,
        edge.junctionEndGeometry,
        edge.filament.junctionStartPermille,
        edge.filament.junctionEndPermille,
      ]),
    });
  }
  if (channel === "terminal") {
    return JSON.stringify({
      nodes: scene.nodes
        .filter((node) => node.terminalTreatment !== null)
        .map((node) => [node.id, node.terminalTreatment, node.radiusPx, node.opacityPermille]),
      edges: scene.edges.map((edge) => [
        edge.id,
        edge.terminalStartTreatment,
        edge.terminalEndTreatment,
        edge.filament.luminanceStartPermille,
        edge.filament.luminanceEndPermille,
      ]),
    });
  }
  return JSON.stringify(scene.nodes.map((node) => [
    node.id,
    node.haloRadiusPx / node.radiusPx,
    node.haloCoreGapPx,
    node.haloIntensityPermille,
  ]));
}

type IncidentRelationSpan = { readonly edge: Scene["edges"][number]; readonly span: number };

/** This lists every node id with at least `minimumDegree` incident relations in a resolved scene. */
function junctionNodeIds(scene: Scene, minimumDegree: number): readonly string[] {
  const degree = new Map<string, number>();
  for (const edge of scene.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [...degree.entries()].filter(([, count]) => count >= minimumDegree).map(([id]) => id).sort();
}

/** This pairs every relation incident to one node with its resolved layout span and does not weight by any material channel. */
function incidentEdgesWithSpan(scene: Scene, nodeId: string): readonly IncidentRelationSpan[] {
  const positionOf = new Map(scene.nodes.map((node) => [node.id, node.position]));
  const nodePosition = positionOf.get(nodeId);
  if (nodePosition === undefined) {
    throw new TypeError(`${nodeId} has no resolved scene position`);
  }
  return scene.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => {
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      const otherPosition = positionOf.get(otherId);
      if (otherPosition === undefined) {
        throw new TypeError(`${otherId} has no resolved scene position`);
      }
      return { edge, span: Math.hypot(nodePosition.x - otherPosition.x, nodePosition.y - otherPosition.y) };
    });
}

/** This is one relation's resolved endpoint width at the given node's own end and does not read the other endpoint. */
function myEndWidth(edge: Scene["edges"][number], nodeId: string): number {
  return edge.source === nodeId ? edge.widthStartPx : edge.widthEndPx;
}

/** This finds the greatest-span candidate, keeping the first on a tie, and requires a non-empty list. */
function longestSpan(candidates: readonly IncidentRelationSpan[]): IncidentRelationSpan {
  return candidates.reduce((max, candidate) => (candidate.span > max.span ? candidate : max));
}

function requiredMorphologyScenes(
  scenes: ReadonlyMap<Morphology, MorphologyBandScenes>,
  morphology: Morphology,
): MorphologyBandScenes {
  const resolved = scenes.get(morphology);
  if (resolved === undefined) {
    throw new TypeError(`${morphology} scene is unavailable`);
  }
  return resolved;
}

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}

test("the resolved filament body width carries the calibrated profile and visible-terminal narrowing", () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state));
  assert.ok(scene.edges.length > 1, "the fixture must supply more than one relation for a shared-ratio claim");

  const stellar = DEFAULT_CALIBRATION.morphology.stellar;
  const ratios = scene.edges.map((edge) => {
    assert.ok(Number.isFinite(edge.bodyWidthPx) && edge.bodyWidthPx > 0, `${edge.id} has no positive body width`);
    return { id: edge.id, start: edge.widthStartPx / edge.bodyWidthPx, end: edge.widthEndPx / edge.bodyWidthPx };
  });
  for (const [index, ratio] of ratios.entries()) {
    const edge = scene.edges[index];
    if (edge === undefined) {
      throw new TypeError("the ratio claim requires a matching relation");
    }
    const startTerminalFactor = edge.terminalStartTreatment === "visible-terminal"
      ? stellar.sharedSceneTerminalSizeMultiplierPermille / SCENE_PERMILLE_SCALE
      : 1;
    const endTerminalFactor = edge.terminalEndTreatment === "visible-terminal"
      ? stellar.sharedSceneTerminalSizeMultiplierPermille / SCENE_PERMILLE_SCALE
      : 1;
    const expectedStart = stellar.sharedSceneFilamentWidthStartPermille / SCENE_PERMILLE_SCALE * startTerminalFactor;
    const expectedEnd = stellar.sharedSceneFilamentWidthEndPermille / SCENE_PERMILLE_SCALE * endTerminalFactor;
    assert.ok(
      Math.abs(ratio.start - expectedStart) <= Number.EPSILON,
      `${ratio.id} start-to-body ratio lost its material binding`,
    );
    assert.ok(
      Math.abs(ratio.end - expectedEnd) <= Number.EPSILON,
      `${ratio.id} end-to-body ratio lost its material binding`,
    );
  }

  const perturbed = scene.edges.map((edge, index) => ({
    id: edge.id,
    start: edge.widthStartPx / (index === 0 ? edge.bodyWidthPx * 2 : edge.bodyWidthPx),
  }));
  const control = perturbed.every((ratio, index) => ratio.start === ratios[index]?.start);
  assert.equal(control, false, "the bound-ratio claim must fail when one relation's body width is wrong");
  process.stdout.write("filament body-width ratio negative control observed: a single perturbed base broke the shared ratio\n");
});

/**
 * CAP-13: an unfloored minimum-prominence node's core colour travelled zero distance from `accent2`
 * toward `peak`, rendering as a dim smudge no larger core radius alone could fix. `salience.
 * minimumCoreIntensityPermille` floors the PROMINENCE fed to that colour travel; this fixture's
 * lowest-prominence stellar node (`source:src_FMA6T2MD80ZTS2JWZNXWSKY00X`, unchanged degree in this
 * committed fixture) is the concrete case the floor exists for.
 */
test("a low-prominence node's core colour is floored while its size and halo keep tracking prominence unmodified", () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const tokens = sceneTokens(state);
  const floored = buildScene(graph, state, DEFAULT_CALIBRATION, tokens);
  const unfloored = buildScene(graph, state, {
    ...DEFAULT_CALIBRATION,
    salience: { ...DEFAULT_CALIBRATION.salience, minimumCoreIntensityPermille: 0 },
  }, tokens);

  const dimNodeId = "source:src_FMA6T2MD80ZTS2JWZNXWSKY00X";
  const flooredDim = requiredSceneNode(floored, dimNodeId);
  const unflooredDim = requiredSceneNode(unfloored, dimNodeId);
  assert.ok(
    flooredDim.token.lightnessPermille > unflooredDim.token.lightnessPermille,
    `the floor did not raise ${dimNodeId}'s core lightness: floored=${flooredDim.token.lightnessPermille}, `
    + `unfloored=${unflooredDim.token.lightnessPermille}`,
  );
  assert.equal(flooredDim.radiusPx, unflooredDim.radiusPx, "the floor moved a node's own scene-space size");
  assert.equal(flooredDim.haloRadiusPx, unflooredDim.haloRadiusPx, "the floor moved a node's own halo radius");
  assert.equal(
    flooredDim.haloIntensityPermille,
    unflooredDim.haloIntensityPermille,
    "the floor moved a node's own halo intensity",
  );

  // A node whose true rendered prominence is already at (or near) the top of the range is the gate's
  // own identity case -- `floor + (scale - floor) * 1000 / scale === scale` -- so the floor and its
  // absence must resolve to the identical colour for it.
  const brightNodeId = "source:src_VMZQH8736EREJCH28C4Q2RPHA1";
  const flooredBright = requiredSceneNode(floored, brightNodeId);
  const unflooredBright = requiredSceneNode(unfloored, brightNodeId);
  assert.equal(
    flooredBright.token.lightnessPermille,
    unflooredBright.token.lightnessPermille,
    "the floor changed an already-prominent node's core colour",
  );
  assert.ok(
    flooredBright.token.lightnessPermille > flooredDim.token.lightnessPermille,
    "degree stopped being legible in core colour once the floor was applied",
  );
});

function requiredSceneNode(scene: Scene, id: string): Scene["nodes"][number] {
  const node = scene.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new TypeError(`scene fixture no longer carries node ${id}`);
  }
  return node;
}
