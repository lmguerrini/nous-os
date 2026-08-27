import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import type { RenderedStateCarrier, VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";
import { createEngineGraphView, createRenderedStateCarrier, createSemantic, assertEngineAccessTrace } from "#engine/contract.ts";
import type { Scene } from "#scene/contract.ts";
import {
  SCENE_LABEL_FONT_FAMILY,
  SCENE_LABEL_FONT_WEIGHT,
  SCENE_PERMILLE_QUANTUM,
  SCENE_PERMILLE_SCALE,
} from "#scene/contract.ts";
import { buildScene, resolveSceneFilamentLuminance, resolveSceneLabelIds } from "#scene/build.ts";
import { sceneFixtureGraph, sceneTokens, sceneVisualState } from "./support.ts";

/** This is a deliberately non-zero depth used to prove scene depth ignores non-layout stimuli. */
const NON_LAYOUT_DEPTH_STIMULUS = 1;

/** This is a deliberate hue mutation used only to prove camera selection cannot change shared scene channels. */
const HUE_CONTROL_MUTATION_DEGREES = 1;

/** This is the arithmetic identity for node kinds without a kind-specific label boost and is not a tuneable material value. */
const NO_KIND_PRIORITY_BOOST = 0;

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
  assertEdgeLabelStateResolution(
    relation,
    scene,
    buildScene(graph, selectedState, DEFAULT_CALIBRATION, sceneTokens(selectedState)),
    buildScene(graph, focusedState, DEFAULT_CALIBRATION, sceneTokens(focusedState)),
    DEFAULT_CALIBRATION,
  );

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
  const ordinaryPriority = relation.visual.label_priority + calibration.labels.priorityWeights.edge;
  if (
    ordinaryCandidate.priority !== ordinaryPriority
    || ordinaryCandidate.opacityPermille !== calibration.labels.edgeLabelOpacityPermille
    || selectedCandidate.priority !== ordinaryPriority + calibration.labels.edgeSelectionPriorityBoost
    || selectedCandidate.opacityPermille !== calibration.labels.edgeLabelSelectedOpacityPermille
    || focusedCandidate.priority !== ordinaryPriority + calibration.labels.edgeFocusPriorityBoost
    || focusedCandidate.opacityPermille !== calibration.labels.edgeLabelFocusOpacityPermille
  ) {
    throw new Error(`edge label state material changed for ${relation.id}`);
  }
}

function assertLayoutDepthOnly(scene: Scene, calibration: CalibrationProfile): void {
  for (const node of scene.nodes) {
    if (node.position.z !== 0) {
      throw new Error(`non-layout depth at node ${node.id}: ${node.position.z}`);
    }
  }
  for (const edge of scene.edges) {
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

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}
