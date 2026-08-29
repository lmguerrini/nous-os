import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION, assertCalibrationProfile } from "#engine/calibration.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import type {
  Coordinates,
  EngineEdge,
  EngineGraph,
  EngineNode,
  RenderedStateCarrier,
  VisualGraph,
} from "#engine/contract.ts";
import {
  assertEngineAccessTrace,
  createEngineGraphView,
} from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import type { ResolvedMaterial } from "#engine/lod.ts";
import { MACRO, MESO, lodView } from "#engine/lod.ts";
import type { EdgeMaterial, MorphologyProfile, NodeMaterial } from "#engine/morphology.ts";
import { MYCELIUM, NEURAL, SHARED_SCENE_MATERIAL_TARGET, STELLAR, applyMorphology } from "#engine/morphology.ts";
import { assertIndraLayout, flatOrganization, indraLayout } from "#engine/organization.ts";
import type { AggregateWindow } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { TOKEN_RAMPS, resolveTokens, separationLuminance, separationRatio } from "#engine/tokens.ts";
import type { OklchToken, TokenMap } from "#engine/tokens.ts";
import { assertVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type {
  RenderedStateChannel,
  Scene,
  SceneCameraRequest,
  SceneEdge,
  SceneEdgeLabelCandidacy,
  SceneInteractionState,
  SceneNode,
  SceneTokenMap,
} from "#scene/contract.ts";
import {
  SCENE_LABEL_FONT_FAMILY,
  SCENE_LABEL_FONT_WEIGHT,
  SCENE_PERMILLE_QUANTUM,
  SCENE_PERMILLE_SCALE,
  assertSceneFieldRegister,
} from "#scene/contract.ts";
import { applyRenderedStateChannel, renderedStateChannel, renderedStateToken } from "#scene/rendered-state.ts";

/** This is the mathematical divisor for a midpoint or symmetric half-width and does not borrow a filament tuning value. */
const BISECTION_DIVISOR = 2;

/** This is the fixed instant sampled by the pure scene model; elapsed scene time is not a calibration property and no runtime clock enters this module. */
const PROPAGATION_SAMPLE_ELAPSED_MILLISECONDS = 220;

/** This is the fully faded luminance endpoint of a blind terminal and does not remove its governed node or relation. */
const BLIND_TERMINAL_LUMINANCE_PERMILLE = 0;

/** This is Flat's own empty cross-community relation set: Flat resolves no windows, so nothing is ever cross-community there. */
const NO_CROSS_COMMUNITY_RELATIONS: ReadonlySet<string> = new Set();

type LabelPlacementCandidate = {
  readonly id: string;
  readonly priority: number;
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
};

type ResolvedSceneInputs = {
  readonly cameraKind: CameraKind;
  readonly tokens: SceneTokenMap;
};

/** This builds a complete pure scene from governed engine inputs and does not allocate a renderer or inspect semantic content. */
export function buildScene(
  graph: VisualGraph,
  visualState: VisualState,
  calibration: CalibrationProfile = DEFAULT_CALIBRATION,
  tokensOrCamera?: TokenMap | CameraKind,
  cameraOrTokens?: CameraKind | TokenMap,
): Scene {
  assertCalibrationProfile(calibration);
  assertVisualState(graph, visualState);
  const inputs = resolveSceneInputs(visualState, tokensOrCamera, cameraOrTokens);
  const { graph: tracedGraph, trace } = createEngineGraphView(graph);
  const engineGraph = orderEngineGraph(tracedGraph);
  const morphology = morphologyProfile(visualState.morphology);
  const morphologyMaterial = applyMorphology(engineGraph, morphology, calibration, SHARED_SCENE_MATERIAL_TARGET);
  const activeTokens = shippingTokens(inputs.tokens, visualState.palette, visualState.theme, calibration);
  const organization = resolveOrganization(engineGraph, calibration, () => layoutAnchors(engineGraph, calibration), visualState.organization);
  // Cross-community weighting is Indra-only: Flat's `organization.windows` is always empty, and
  // treating every edge as "no owning window" there would dim the entire Flat scene rather than
  // nothing at all. The same reasoning holds when Indra itself resolves zero windows (no
  // aggregates to cross between): with no owner map to consult, every edge would otherwise be
  // marked "outside every window" and dampened as cross-community when there is no community for
  // it to be outside of.
  const crossCommunityEdgeIds = visualState.organization === "indra" && organization.windows.length > 0
    ? crossCommunityRelationIds(engineGraph, organization.windows)
    : NO_CROSS_COMMUNITY_RELATIONS;
  const view = lodView(engineGraph, organization.nodeAnchors, visualState.lodBand);
  const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
  const edgeMaterials = new Map(morphologyMaterial.edges.map((edge) => [edge.id, edge]));
  const nodes = engineGraph.nodes.map((node) => sceneNode(
    node,
    requiredCoordinate(view.anchors, node.id),
    requiredNodeMaterial(nodeMaterials, node.id),
    view.material,
    morphology,
    visualState,
    calibration,
    activeTokens,
  ));
  const edgeCandidacies = edgeLabelCandidacies(engineGraph, visualState, calibration, activeTokens, crossCommunityEdgeIds);
  const edges = engineGraph.edges.map((edge) => sceneEdge(
    edge,
    requiredCoordinate(view.anchors, edge.source),
    requiredCoordinate(view.anchors, edge.target),
    requiredEdgeMaterial(edgeMaterials, edge.id),
    view.material,
    morphology,
    edgeCandidacies.get(edge.id) ?? null,
    visualState,
    calibration,
    activeTokens,
    crossCommunityEdgeIds.has(edge.id),
  ));
  const selectedLabelIds = selectedSceneLabelIds(nodes, edges, visualState, calibration);
  assertEngineAccessTrace(trace);
  const scene: Scene = {
    field: { token: copyToken(requiredToken(activeTokens, "background")) },
    tokens: inputs.tokens,
    tokenEncoding: {
      gamutCompressionRange: calibration.labels.collisionPaddingPx / calibration.layout.idealEdgeLengthPx,
      gamutCompressionExponent: calibration.layout.idealEdgeLengthPx / calibration.labels.densityCap,
    },
    nodes,
    edges,
    aggregates: [...organization.windows]
      .sort(compareIds)
      .map((window, index) => ({
        id: window.id,
        kind: window.kind,
        members: [...window.members],
        center: copyCoordinates(window.center),
        radius: window.radius,
        windowPaddingPx: calibration.aggregate.windowPaddingPx,
        windowFillOpacityPermille: calibration.aggregate.windowFillOpacityPermille,
        windowFillCoreRadiusFractionPermille: calibration.aggregate.windowFillCoreRadiusFractionPermille,
        windowFillFalloffPermille: calibration.aggregate.windowFillFalloffPermille,
        token: copyToken(aggregateWindowToken(activeTokens, visualState.palette, index)),
        strokeWidthPx: materialIncludes(view.material.aggregate, "outline")
          ? (calibration.filament.baseWidthPx * calibration.lod.macroAggregateOutlineWidthMultiplierPermille) / SCENE_PERMILLE_SCALE
          : calibration.filament.baseWidthPx,
        strokeOpacityPermille: materialIncludes(view.material.aggregate, "outline")
          ? calibration.lod.macroAggregateOutlineAlphaPermille
          : calibration.aggregate.windowStrokeAlphaPermille,
        bounds: { ...window.bounds },
      })),
    selectedLabelIds,
    selectedProvenance: selectedProvenance(graph, visualState),
    camera: sceneCameraRequest(inputs.cameraKind, visualState, calibration),
  };
  assertSceneFieldRegister(scene);
  return scene;
}

/** This resolves the complete node material token and does not convert it to renderer bytes. */
export function resolveSceneNodeMaterialToken(
  tokens: TokenMap,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  return renderedStateToken(nodeTokenForMaterial(tokens, material, resolved, calibration), carrier, calibration);
}

/** This resolves the complete edge material token and does not convert it to renderer bytes. */
export function resolveSceneEdgeMaterialToken(
  tokens: TokenMap,
  _material: EdgeMaterial,
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  const base = minimumNodeContrastToken(
    requiredToken(tokens, "edge"),
    requiredToken(tokens, "background"),
    calibration,
  );
  return renderedStateToken(base, carrier, calibration);
}

/** This resolves one uniform along-length filament texture and cannot receive governed relation state, kind, or provenance. */
export function resolveSceneFilamentLuminance(calibration: CalibrationProfile): {
  readonly luminanceStartPermille: number;
  readonly luminanceMidPermille: number;
  readonly luminanceEndPermille: number;
} {
  return {
    luminanceStartPermille: calibration.filament.endpointLuminanceGainPermille,
    luminanceMidPermille: calibration.filament.midSpanLuminanceFactorPermille,
    luminanceEndPermille: calibration.filament.endpointLuminanceGainPermille,
  };
}

/** This resolves categorical terminal material into existing endpoint luminance channels and does not inspect relation semantics. */
function resolveTerminalFilamentLuminance(
  material: EdgeMaterial,
  calibration: CalibrationProfile,
): ReturnType<typeof resolveSceneFilamentLuminance> {
  const resolved = resolveSceneFilamentLuminance(calibration);
  if (material.terminalTreatment !== MYCELIUM.terminalTreatment) {
    return resolved;
  }
  return {
    ...resolved,
    luminanceStartPermille: material.sourceTerminal
      ? BLIND_TERMINAL_LUMINANCE_PERMILLE
      : resolved.luminanceStartPermille,
    luminanceEndPermille: material.targetTerminal
      ? BLIND_TERMINAL_LUMINANCE_PERMILLE
      : resolved.luminanceEndPermille,
  };
}

/** This narrows a visible terminal endpoint while a blind terminal retains a blunt filament width. */
function terminalWidthPx(
  widthPx: number,
  terminal: boolean,
  treatment: EdgeMaterial["terminalTreatment"],
  terminalSizeMultiplierPermille: number,
): number {
  return terminal && treatment === STELLAR.terminalTreatment
    ? (widthPx * terminalSizeMultiplierPermille) / SCENE_PERMILLE_SCALE
    : widthPx;
}

/** This selects calibrated non-colliding labels and does not measure text with renderer or DOM APIs. */
export function resolveSceneLabelIds(
  candidates: readonly LabelPlacementCandidate[],
  calibration: CalibrationProfile,
  densityCap = calibration.labels.densityCap,
): readonly string[] {
  const selected: LabelPlacementCandidate[] = [];
  const sorted = [...candidates].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  for (const candidate of sorted) {
    if (selected.length >= densityCap) {
      break;
    }
    if (selected.every((placed) => !labelBoxesCollide(candidate, placed, calibration.labels.collisionPaddingPx))) {
      selected.push(candidate);
    }
  }
  return selected.map((candidate) => candidate.id);
}

function sceneNode(
  node: EngineNode,
  anchor: Coordinates,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  morphology: MorphologyProfile,
  visualState: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
): SceneNode {
  const scale = SCENE_PERMILLE_SCALE;
  const selectedMultiplier = visualState.selectedId === node.id
    ? calibration.selection.emphasisMultiplierPermille / scale
    : 1;
  const baseRadiusPx = nodeSizeForMaterial(material, resolved, morphology, calibration);
  const radiusPx = baseRadiusPx * selectedMultiplier;
  const isJunction = Number(material.facts.degree.value) >= 2;
  const isTerminal = material.facts.terminal.value === true;
  const fusedJunction = isJunction && material.junctionGeometry === MYCELIUM.junctionGeometry;
  const blindTerminal = isTerminal && material.terminalTreatment === MYCELIUM.terminalTreatment;
  const channel = renderedStateChannel(node.rendered ?? null, calibration);
  const baseToken = nodeTokenForMaterial(tokens, material, resolved, calibration);
  const requestedHaloRadiusPx = (materialIncludes(resolved.node, "halo") ? material.haloRadiusPx : baseRadiusPx) * selectedMultiplier;
  const requestedHaloIntensityPermille = materialIncludes(resolved.node, "halo")
    ? material.haloIntensityPermille
    : 0;
  const haloRadiusPx = fusedJunction || blindTerminal ? radiusPx : requestedHaloRadiusPx;
  const haloIntensityPermille = fusedJunction || blindTerminal ? 0 : requestedHaloIntensityPermille;
  return {
    id: node.id,
    kind: node.kind,
    position: copyCoordinates(anchor),
    radiusPx,
    token: copyToken(applyRenderedStateChannel(baseToken, channel, calibration)),
    opacityPermille: blindTerminal ? 0 : interactionOpacity(material.opacityPermille, node.id, visualState, calibration),
    junctionGeometry: isJunction ? material.junctionGeometry : null,
    terminalTreatment: isTerminal ? material.terminalTreatment : null,
    haloRadiusPx,
    haloCoreGapPx: fusedJunction || blindTerminal ? 0 : calibration.luminance.coreBeforeHaloMinimumPx,
    haloIntensityPermille,
    haloAlphaStops: resolveSceneHaloAlphaStops(haloIntensityPermille, calibration),
    coreSharpnessPermille: calibration.morphology[morphology.id].coreSharpnessPermille,
    labelCandidacy: materialIncludes(resolved.node, "label") ? {
      text: node.visual.role,
      token: copyToken(requiredToken(tokens, "text")),
      priority: nodeLabelPriority(node, material, calibration),
      opacityPermille: calibration.labels.nodeLabelOpacityPermille,
      sizePx: calibration.labels.nodeLabelSizePx,
      fontFamily: SCENE_LABEL_FONT_FAMILY,
      fontWeight: SCENE_LABEL_FONT_WEIGHT,
      collisionPaddingPx: calibration.labels.collisionPaddingPx,
      placementOffsetPx: haloRadiusPx,
    } : null,
    renderedStateChannel: channel,
    interaction: interactionState(node.id, visualState),
    lodBand: visualState.lodBand,
    stackingPriority: node.visual.label_priority,
  };
}

function sceneEdge(
  edge: EngineEdge,
  source: Coordinates,
  target: Coordinates,
  material: EdgeMaterial,
  resolved: ResolvedMaterial,
  morphology: MorphologyProfile,
  labelCandidacy: SceneEdgeLabelCandidacy,
  visualState: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
  crossCommunity: boolean,
): SceneEdge {
  const scale = SCENE_PERMILLE_SCALE;
  const emphasis = visualState.selectedId === edge.id
    ? calibration.selection.emphasisMultiplierPermille / scale
    : 1;
  const crossWidthFactor = crossCommunity
    ? calibration.aggregate.crossWindowRelationWidthFactorPermille / scale
    : 1;
  const width = edgeWidthForMaterial(material, resolved, calibration) * emphasis * crossWidthFactor;
  const filamentMaterial = calibration.morphology[morphology.id];
  const widthStartPx = terminalWidthPx(
    (width * material.widthStartPermille) / scale,
    material.sourceTerminal,
    material.terminalTreatment,
    filamentMaterial.sharedSceneTerminalSizeMultiplierPermille,
  );
  const widthEndPx = terminalWidthPx(
    (width * material.widthEndPermille) / scale,
    material.targetTerminal,
    material.terminalTreatment,
    filamentMaterial.sharedSceneTerminalSizeMultiplierPermille,
  );
  const curvature = edgeCurvatureForMaterial(material, resolved);
  const controlPoint = quadraticControlPoint(source, target, curvature);
  const path = sampleQuadraticPath(source, target, controlPoint, curvature, calibration.lod.bandThresholds.length);
  const travelledDistance = propagationDistance(PROPAGATION_SAMPLE_ELAPSED_MILLISECONDS, calibration);
  const propagation = reducedMotionPosition(
    { controlPoints: path },
    travelledDistance,
    visualState.reducedMotion || calibration.motion.reducedMotionSwitch,
  );
  const length = arcLength({ controlPoints: path });
  const normalisedArcPosition = propagation.continuous
    ? normalisedPropagationPosition(travelledDistance, length)
    : 1;
  const channel = renderedStateChannel(edge.rendered ?? null, calibration);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    junctionStartGeometry: material.sourceJunction ? material.junctionGeometry : null,
    junctionEndGeometry: material.targetJunction ? material.junctionGeometry : null,
    terminalStartTreatment: material.sourceTerminal ? material.terminalTreatment : null,
    terminalEndTreatment: material.targetTerminal ? material.terminalTreatment : null,
    path,
    controlPoint,
    bodyWidthPx: width,
    widthStartPx,
    widthEndPx,
    pickTolerancePx: calibration.filament.pickTolerancePx,
    minimumDeviceWidthPx: calibration.filament.minimumDeviceWidthPermille / scale,
    token: copyToken(applyRenderedStateChannel(
      minimumNodeContrastToken(requiredToken(tokens, "edge"), requiredToken(tokens, "background"), calibration),
      channel,
      calibration,
    )),
    opacityPermille: interactionOpacity(
      crossCommunityOpacity(material.opacityPermille, crossCommunity, calibration),
      edge.id,
      visualState,
      calibration,
    ),
    renderedStateChannel: channel,
    labelCandidacy,
    interaction: interactionState(edge.id, visualState),
    lodBand: visualState.lodBand,
    filament: {
      minimumWidthFactorPermille: calibration.filament.minimumWidthFactorPermille,
      junctionStartPermille: material.junctionStartPermille,
      junctionEndPermille: material.junctionEndPermille,
      sheathScalePermille: filamentMaterial.sheathScalePermille,
      sheathAlphaPermille: filamentMaterial.sheathAlphaPermille,
      coreScalePermille: filamentMaterial.coreScalePermille,
      hotMixPermille: filamentMaterial.hotMixPermille,
      hotAlphaPermille: filamentMaterial.hotAlphaPermille,
      hotCorePermille: material.hotCorePermille,
      // scene/build.ts only ever feeds the shared-scene render3f pipeline (render2d resolves its own
      // filament material directly from calibration), so the shared-scene meander knobs are always
      // the correct read here and never touch the legacy renderer's frozen meander.
      wobbleAmplitudePermille: filamentMaterial.sharedSceneFilamentWobbleAmplitudePermille,
      wobbleFrequencyMilliradians: filamentMaterial.sharedSceneWobbleFrequencyMilliradians,
      phasePermille: material.phasePermille,
      afterglowDecayPermille: calibration.motion.afterglowDecayPermille,
      ...resolveTerminalFilamentLuminance(material, calibration),
    },
    propagation: {
      position: copyCoordinates(propagation.position),
      pathLength: length,
      arcPositionPermille: Math.round(normalisedArcPosition * scale),
      continuous: propagation.continuous,
      endpointExpressed: propagation.endpointExpressed,
    },
    stackingPriority: edge.visual.label_priority,
  };
}

function resolveSceneInputs(
  visualState: VisualState,
  tokensOrCamera: TokenMap | CameraKind | undefined,
  cameraOrTokens: CameraKind | TokenMap | undefined,
): ResolvedSceneInputs {
  const resolvedTokens = resolveTokens(
    visualState.palette,
    visualState.temperature,
    visualState.theme,
    visualState.hueAnchorDegrees,
  ) as SceneTokenMap;
  if (tokensOrCamera === undefined) {
    if (cameraOrTokens !== undefined) {
      throw new TypeError("scene fifth argument requires an explicit fourth argument");
    }
    return {
      cameraKind: visualState.cameraKind,
      tokens: resolvedTokens,
    };
  }
  if (typeof tokensOrCamera === "string") {
    if (typeof cameraOrTokens === "string") {
      throw new TypeError("scene camera kind was supplied twice");
    }
    return {
      cameraKind: tokensOrCamera,
      tokens: cameraOrTokens === undefined
        ? resolvedTokens
        : requireCompleteResolvedTokens(cameraOrTokens, resolvedTokens),
    };
  }
  if (cameraOrTokens !== undefined && typeof cameraOrTokens !== "string") {
    throw new TypeError("scene tokens were supplied twice");
  }
  return {
    cameraKind: cameraOrTokens ?? visualState.cameraKind,
    tokens: requireCompleteResolvedTokens(tokensOrCamera, resolvedTokens),
  };
}

function requireCompleteResolvedTokens(tokens: TokenMap, expected: TokenMap): SceneTokenMap {
  const names = Object.keys(tokens).sort(compareText);
  const expectedNames = Object.keys(expected).sort(compareText);
  if (names.length !== expectedNames.length
    || names.some((name, index) => name !== expectedNames[index])) {
    throw new TypeError("scene tokens must be the complete resolved token map");
  }
  for (const name of expectedNames) {
    const actual = tokens[name];
    const resolved = expected[name];
    if (actual === undefined || resolved === undefined
      || actual.lightnessPermille !== resolved.lightnessPermille
      || actual.chromaPermille !== resolved.chromaPermille
      || actual.hueDegrees !== resolved.hueDegrees) {
      throw new TypeError(`scene resolved token changed: ${name}`);
    }
  }
  return tokens as SceneTokenMap;
}

function sceneCameraRequest(
  kind: CameraKind,
  visualState: VisualState,
  calibration: CalibrationProfile,
): SceneCameraRequest {
  const frame = {
    x: visualState.camera.x,
    y: visualState.camera.y,
    angle: visualState.camera.angle,
    ratio: visualState.camera.ratio,
    bounds: {
      x: [visualState.camera.bounds.x[0], visualState.camera.bounds.x[1]] as const,
      y: [visualState.camera.bounds.y[0], visualState.camera.bounds.y[1]] as const,
    },
  };
  if (kind === "orthographic") {
    return {
      ...frame,
      kind,
      navigation: { ...calibration.camera.orthographic },
    };
  }
  return {
    ...frame,
    kind,
    navigation: { ...calibration.camera.perspective },
  };
}

/** This is the scene layer's uniform organization result and does not distinguish Flat's shared anchors from Indra's independent re-layout at the call site. */
type ResolvedOrganization = {
  readonly windows: readonly AggregateWindow[];
  readonly nodeAnchors: LayoutAnchors;
};

/**
 * This selects Flat's unchanged shared-anchor windows or Indra's independent re-layout and does not
 * let either leak into the other's node positions. The shared anchors arrive as a thunk because
 * Indra never reads them: it re-derives every position from the governed aggregates. Computing them
 * eagerly did not merely waste the work, it decided the outcome, since the disc layout raises on
 * graphs whose aggregates are large enough to fill the reference frame and so failed builds that
 * were going to discard its result. Flat still calls it, and still raises where it always did.
 */
function resolveOrganization(
  graph: EngineGraph,
  calibration: CalibrationProfile,
  sharedAnchors: () => LayoutAnchors,
  organization: VisualState["organization"],
): ResolvedOrganization {
  if (organization === "indra") {
    const relayout = indraLayout(graph, calibration);
    assertIndraLayout(graph, relayout);
    return { windows: relayout.windows, nodeAnchors: relayout.nodeAnchors };
  }
  const anchors = sharedAnchors();
  return { windows: flatOrganization(graph, anchors).windows, nodeAnchors: anchors };
}

/**
 * This derives, purely as a rendering weight, which real relations cross between governed aggregates
 * or touch a satellite outside every window. It changes no relation's identity, drawn status, or
 * binding -- every governed relation id from `graph.edges` is still present in the returned scene
 * unconditionally; this only marks which of those already-drawn relations render quieter.
 */
function crossCommunityRelationIds(graph: EngineGraph, windows: readonly AggregateWindow[]): ReadonlySet<string> {
  const ownerOf = new Map<string, string>();
  for (const window of windows) {
    ownerOf.set(window.id, window.id);
    for (const member of window.members) {
      ownerOf.set(member, window.id);
    }
  }
  const cross = new Set<string>();
  for (const edge of graph.edges) {
    const sourceOwner = ownerOf.get(edge.source);
    const targetOwner = ownerOf.get(edge.target);
    if (sourceOwner === undefined || targetOwner === undefined || sourceOwner !== targetOwner) {
      cross.add(edge.id);
    }
  }
  return cross;
}

/** This dampens one already-resolved opacity for a cross-community relation or its label and does not alter a local relation's opacity. */
function crossCommunityOpacity(opacityPermille: number, crossCommunity: boolean, calibration: CalibrationProfile): number {
  return crossCommunity
    ? Math.round((opacityPermille * calibration.aggregate.crossWindowRelationOpacityFactorPermille) / SCENE_PERMILLE_SCALE)
    : opacityPermille;
}

function orderEngineGraph(graph: EngineGraph): EngineGraph {
  return {
    nodes: [...graph.nodes].sort(compareIds),
    edges: [...graph.edges].sort(compareIds),
  };
}

function morphologyProfile(morphology: VisualState["morphology"]): MorphologyProfile {
  if (morphology === STELLAR.id) {
    return STELLAR;
  }
  if (morphology === NEURAL.id) {
    return NEURAL;
  }
  return MYCELIUM;
}

function nodeSizeForMaterial(
  node: NodeMaterial,
  material: ResolvedMaterial,
  morphology: MorphologyProfile,
  calibration: CalibrationProfile,
): number {
  if (materialIncludes(material.node, "core")) {
    return node.coreSizePx;
  }
  const scale = SCENE_PERMILLE_SCALE;
  const range = calibration.salience.maxNodeSizePx - calibration.salience.minNodeSizePx;
  const mass = calibration.salience.minNodeSizePx + ((node.prominencePermille * range) / scale);
  const morphologyMultiplier = calibration.morphology[morphology.id].nodeSizeMultiplierPermille;
  return (mass * morphologyMultiplier * calibration.lod.macroNodeSizeMultiplierPermille) / (scale * scale);
}

function nodeTokenForMaterial(
  tokens: TokenMap,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  calibration: CalibrationProfile,
): OklchToken {
  const prominence = prominenceToken(tokens, material.prominencePermille, calibration);
  return materialIncludes(resolved.node, "hop-distance")
    ? hopDistanceToken(prominence, material, requiredToken(tokens, "background"), calibration)
    : prominence;
}

function nodeLabelPriority(
  node: EngineNode,
  material: NodeMaterial,
  calibration: CalibrationProfile,
): number {
  const base = material.prominencePermille + calibration.labels.priorityWeights.node;
  if (node.kind === "assertion") {
    return base + calibration.labels.priorityWeights.assertion;
  }
  if (node.kind === "bridge") {
    return base + calibration.labels.priorityWeights.bridge;
  }
  return base;
}

function edgeWidthForMaterial(edge: EdgeMaterial, material: ResolvedMaterial, calibration: CalibrationProfile): number {
  const resolvedKindWidth = kindWidth(edge);
  if (materialIncludes(material.edge, "skeleton")) {
    return (resolvedKindWidth * calibration.lod.macroFilamentWidthMultiplierPermille) / SCENE_PERMILLE_SCALE;
  }
  return materialIncludes(material.edge, "taper") ? edge.widthPx : resolvedKindWidth;
}

function edgeCurvatureForMaterial(edge: EdgeMaterial, material: ResolvedMaterial): number {
  return materialIncludes(material.edge, "curvature")
    ? edge.curvaturePermille / SCENE_PERMILLE_SCALE
    : 0;
}

function kindWidth(edge: EdgeMaterial): number {
  if (edge.taperPermille === 0) {
    throw new TypeError("scene taper material must be non-zero");
  }
  return (edge.widthPx * SCENE_PERMILLE_SCALE) / edge.taperPermille;
}

function prominenceToken(tokens: TokenMap, prominencePermille: number, calibration: CalibrationProfile): OklchToken {
  const background = requiredToken(tokens, "background");
  const lowProminence = minimumNodeContrastToken(requiredToken(tokens, "accent2"), background, calibration);
  const highProminence = requiredToken(tokens, "peak");
  const lightnessTravel = prominenceTravel(
    prominencePermille,
    calibration.luminance.prominenceLightnessGainPermille,
  );
  const chromaTravel = prominenceTravel(
    prominencePermille,
    calibration.luminance.prominenceChromaFalloffPermille,
  );
  const scale = SCENE_PERMILLE_SCALE;
  return {
    lightnessPermille: Math.round(lowProminence.lightnessPermille + ((highProminence.lightnessPermille - lowProminence.lightnessPermille) * lightnessTravel / scale)),
    chromaPermille: Math.round(lowProminence.chromaPermille + ((highProminence.chromaPermille - lowProminence.chromaPermille) * chromaTravel / scale)),
    hueDegrees: lowProminence.hueDegrees,
  };
}

function minimumNodeContrastToken(
  token: OklchToken,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  const scale = SCENE_PERMILLE_SCALE;
  const minimumContrast = calibration.luminance.minimumNodeContrastPermille / scale;
  const backgroundLuminance = separationLuminance(background);
  let candidate = token;
  while (
    (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast)
    && candidate.lightnessPermille < scale
  ) {
    candidate = {
      ...candidate,
      lightnessPermille: candidate.lightnessPermille + SCENE_PERMILLE_QUANTUM,
    };
  }
  if (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast) {
    throw new TypeError("scene node contrast calibration is unreachable");
  }
  return candidate;
}

function hopDistanceToken(
  token: OklchToken,
  material: NodeMaterial,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  const hopDistance = requiredHopDistance(material.facts.hopDistanceFromHub.value);
  const darkened = {
    ...token,
    lightnessPermille: Math.max(
      0,
      token.lightnessPermille - (hopDistance * calibration.lod.microHopDistanceLightnessStepPermille),
    ),
  };
  return minimumNodeContrastToken(darkened, background, calibration);
}

function requiredHopDistance(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("scene hop-distance material is unavailable");
  }
  return Number(value);
}

function prominenceTravel(prominencePermille: number, gainPermille: number): number {
  return Math.max(
    0,
    Math.min(SCENE_PERMILLE_SCALE, (prominencePermille * gainPermille) / SCENE_PERMILLE_SCALE),
  );
}

function quadraticControlPoint(
  source: Coordinates,
  target: Coordinates,
  curvature: number,
): Coordinates {
  return {
    x: (source.x + target.x) / 2 - ((target.y - source.y) * curvature),
    y: (source.y + target.y) / 2 + ((target.x - source.x) * curvature),
    z: source.z + ((target.z - source.z) / 2),
  };
}

function sampleQuadraticPath(
  source: Coordinates,
  target: Coordinates,
  control: Coordinates,
  curvature: number,
  steps: number,
): readonly Coordinates[] {
  if (curvature === 0) {
    return [copyCoordinates(source), copyCoordinates(target)];
  }
  if (steps < BISECTION_DIVISOR) {
    throw new TypeError("scene quadratic path requires at least two segments");
  }
  const samples: Coordinates[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const parameter = index / steps;
    const inverse = 1 - parameter;
    samples.push({
      x: (inverse * inverse * source.x) + (2 * inverse * parameter * control.x) + (parameter * parameter * target.x),
      y: (inverse * inverse * source.y) + (2 * inverse * parameter * control.y) + (parameter * parameter * target.y),
      z: (inverse * inverse * source.z) + (2 * inverse * parameter * control.z) + (parameter * parameter * target.z),
    });
  }
  return samples;
}

function resolveSceneHaloAlphaStops(
  haloIntensityPermille: number,
  calibration: CalibrationProfile,
): readonly { readonly offset: number; readonly alphaMultiplier: number }[] {
  const finalIndex = Math.max(1, calibration.luminance.haloSampleCount - 1);
  const exponent = BISECTION_DIVISOR
    + (calibration.luminance.haloFalloffPermille / SCENE_PERMILLE_SCALE);
  const peakAlphaMultiplier = haloIntensityPermille / SCENE_PERMILLE_SCALE;
  return Array.from({ length: finalIndex + 1 }, (_value, index) => {
    const offset = index / finalIndex;
    return {
      offset,
      alphaMultiplier: peakAlphaMultiplier * ((1 - offset) ** exponent),
    };
  });
}

function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / SCENE_PERMILLE_SCALE;
}

function normalisedPropagationPosition(travelledDistance: number, length: number): number {
  return length === 0 ? 1 : Math.max(0, Math.min(travelledDistance / length, 1));
}

function edgeLabelCandidacies(
  graph: EngineGraph,
  state: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
  crossCommunityEdgeIds: ReadonlySet<string>,
): ReadonlyMap<string, SceneEdgeLabelCandidacy> {
  if (state.lodBand === MACRO) {
    return new Map();
  }
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const selectedRelation = state.selectedId !== null && edgeIds.has(state.selectedId) ? state.selectedId : null;
  const focusedRelation = state.focusedId !== null && edgeIds.has(state.focusedId) ? state.focusedId : null;
  const focusedNode = state.focusedId !== null && nodeIds.has(state.focusedId) ? state.focusedId : null;
  const relevant = new Set<string>();
  if (selectedRelation !== null) {
    relevant.add(selectedRelation);
  }
  if (focusedRelation !== null) {
    relevant.add(focusedRelation);
  }
  if (focusedNode !== null) {
    for (const edge of graph.edges) {
      if (edge.source === focusedNode || edge.target === focusedNode) {
        relevant.add(edge.id);
      }
    }
  }
  const candidates = state.lodBand === MESO || relevant.size > 0
    ? graph.edges.filter((edge) => relevant.has(edge.id))
    : graph.edges;
  return new Map(candidates.map((edge) => {
    const selected = edge.id === selectedRelation;
    const focused = edge.id === focusedRelation || (focusedNode !== null && (edge.source === focusedNode || edge.target === focusedNode));
    const crossCommunity = crossCommunityEdgeIds.has(edge.id);
    const basePriority = edge.visual.label_priority + calibration.labels.priorityWeights.edge
      + (selected
        ? calibration.labels.edgeSelectionPriorityBoost
        : focused ? calibration.labels.edgeFocusPriorityBoost : 0);
    const baseOpacity = selected
      ? calibration.labels.edgeLabelSelectedOpacityPermille
      : focused ? calibration.labels.edgeLabelFocusOpacityPermille : calibration.labels.edgeLabelOpacityPermille;
    return [edge.id, {
      text: edge.kind,
      token: copyToken(requiredToken(tokens, "textMuted")),
      // A local relation's label wins the density cap ahead of a cross-community one at the same
      // base priority; this only reorders which already-eligible labels are selected first under the
      // density cap and never removes a governed label from candidacy.
      priority: crossCommunity ? basePriority - calibration.aggregate.crossWindowRelationLabelPriorityPenalty : basePriority,
      opacityPermille: crossCommunityOpacity(baseOpacity, crossCommunity, calibration),
      sizePx: calibration.labels.edgeLabelSizePx,
      fontFamily: SCENE_LABEL_FONT_FAMILY,
      fontWeight: SCENE_LABEL_FONT_WEIGHT,
      collisionPaddingPx: calibration.labels.collisionPaddingPx,
    }];
  }));
}

function selectedSceneLabelIds(
  nodes: readonly SceneNode[],
  edges: readonly SceneEdge[],
  visualState: VisualState,
  calibration: CalibrationProfile,
): readonly string[] {
  const nodeCandidates = nodes.flatMap((node): readonly LabelPlacementCandidate[] => {
    if (node.labelCandidacy === null) {
      return [];
    }
    const center = worldToReferenceFrame(node.position, visualState, calibration);
    const width = node.labelCandidacy.text.length * node.labelCandidacy.sizePx;
    return [{
      id: node.id,
      priority: node.labelCandidacy.priority,
      minimumX: center.x + node.labelCandidacy.placementOffsetPx,
      minimumY: center.y - node.labelCandidacy.sizePx,
      maximumX: center.x + node.labelCandidacy.placementOffsetPx + width,
      maximumY: center.y + node.labelCandidacy.sizePx,
    }];
  });
  const edgeCandidates = edges.flatMap((edge): readonly LabelPlacementCandidate[] => {
    if (edge.labelCandidacy === null) {
      return [];
    }
    const midpoint = edge.path[Math.floor(edge.path.length / BISECTION_DIVISOR)];
    if (midpoint === undefined) {
      throw new TypeError("scene edge label path has no midpoint");
    }
    const center = worldToReferenceFrame(midpoint, visualState, calibration);
    const width = edge.labelCandidacy.text.length * edge.labelCandidacy.sizePx;
    return [{
      id: edge.id,
      priority: edge.labelCandidacy.priority,
      minimumX: center.x - (width / BISECTION_DIVISOR),
      minimumY: center.y - edge.labelCandidacy.sizePx,
      maximumX: center.x + (width / BISECTION_DIVISOR),
      maximumY: center.y + edge.labelCandidacy.sizePx,
    }];
  });
  return [
    ...resolveSceneLabelIds(nodeCandidates, calibration),
    ...resolveSceneLabelIds(edgeCandidates, calibration, calibration.labels.edgeDensityCap),
  ].sort(compareText);
}

function worldToReferenceFrame(
  point: Coordinates,
  visualState: VisualState,
  calibration: CalibrationProfile,
): { readonly x: number; readonly y: number } {
  const xBounds = visualState.camera.bounds.x;
  const yBounds = visualState.camera.bounds.y;
  return {
    x: ((point.x - xBounds[0]) / (xBounds[1] - xBounds[0])) * calibration.layout.referenceFrameWidthPx,
    y: ((point.y - yBounds[0]) / (yBounds[1] - yBounds[0])) * calibration.layout.referenceFrameHeightPx,
  };
}

function interactionState(id: string, state: VisualState): SceneInteractionState {
  if (state.selectedId === id) {
    return "selected";
  }
  if (state.focusedId === id) {
    return "focused";
  }
  return state.focusedId === null ? "none" : "dimmed";
}

function interactionOpacity(
  opacityPermille: number,
  id: string,
  state: VisualState,
  calibration: CalibrationProfile,
): number {
  return state.focusedId === null || state.focusedId === id
    ? Math.round(opacityPermille)
    : Math.round((opacityPermille * calibration.selection.focusDimFactorPermille) / SCENE_PERMILLE_SCALE);
}

function selectedProvenance(graph: VisualGraph, state: VisualState): Scene["selectedProvenance"] {
  if (state.selectedId === null) {
    return null;
  }
  const element = [...graph.nodes, ...graph.edges].find((candidate) => candidate.id === state.selectedId);
  if (element === undefined) {
    throw new TypeError("selected graph element provenance is unavailable");
  }
  return element.derived;
}

function shippingTokens(
  tokens: TokenMap,
  palette: VisualState["palette"],
  theme: VisualState["theme"],
  calibration: CalibrationProfile,
): TokenMap {
  if (palette !== "monochrome") {
    return tokens;
  }
  const neutral = Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [name, calibratedMonochromeToken(token, token.lightnessPermille)]),
  );
  if (theme === "light") {
    return neutral;
  }
  return {
    ...neutral,
    background: calibratedMonochromeToken(requiredToken(neutral, "background"), calibration.luminance.fieldLightnessPermille),
    edge: calibratedMonochromeToken(requiredToken(neutral, "edge"), calibration.luminance.filamentLightnessPermille),
    peak: calibratedMonochromeToken(requiredToken(neutral, "peak"), calibration.luminance.nodePeakLightnessPermille),
  };
}

function calibratedMonochromeToken(token: OklchToken, lightnessPermille: number): OklchToken {
  return {
    ...token,
    lightnessPermille,
    chromaPermille: 0,
  };
}

function labelBoxesCollide(
  candidate: LabelPlacementCandidate,
  placed: LabelPlacementCandidate,
  padding: number,
): boolean {
  return candidate.minimumX <= placed.maximumX + padding
    && candidate.maximumX + padding >= placed.minimumX
    && candidate.minimumY <= placed.maximumY + padding
    && candidate.maximumY + padding >= placed.minimumY;
}

function materialIncludes(items: readonly string[], item: string): boolean {
  return items.includes(item);
}

function requiredToken(tokens: TokenMap, name: string): OklchToken {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError(`scene token is unavailable: ${name}`);
  }
  return token;
}

/**
 * This is the one place community membership becomes visible as colour. Every other palette keeps
 * today's single fixed "accent3" window token, unconditionally; only `categorical` cycles the accent
 * ramp by each window's position in the already-sorted, already-deterministic window list, modulo the
 * ramp's own length (`TOKEN_RAMPS.accent`, six roles) -- so windows read as distinct colours only
 * within one pass of the ramp, and the ramp then repeats: on the 30-window Indra portal fixture
 * (test/scene/indra-fixture.test.ts), the six colours are shared five ways each. Nothing here decides
 * which nodes belong to which window -- organization.windows already did, and this only chooses which
 * already-derived colour renders it.
 */
function aggregateWindowToken(tokens: TokenMap, palette: VisualState["palette"], windowIndex: number): OklchToken {
  if (palette !== "categorical") {
    return requiredToken(tokens, "accent3");
  }
  const role = TOKEN_RAMPS.accent[windowIndex % TOKEN_RAMPS.accent.length];
  if (role === undefined) {
    throw new TypeError("categorical aggregate window token ramp is unavailable");
  }
  return requiredToken(tokens, role);
}

function requiredNodeMaterial(materials: ReadonlyMap<string, NodeMaterial>, id: string): NodeMaterial {
  const material = materials.get(id);
  if (material === undefined) {
    throw new TypeError("scene node material is unavailable");
  }
  return material;
}

function requiredEdgeMaterial(materials: ReadonlyMap<string, EdgeMaterial>, id: string): EdgeMaterial {
  const material = materials.get(id);
  if (material === undefined) {
    throw new TypeError("scene edge material is unavailable");
  }
  return material;
}

function requiredCoordinate(anchors: ReadonlyMap<string, Coordinates>, id: string): Coordinates {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError("scene anchor is unavailable");
  }
  return anchor;
}

function copyCoordinates(value: Coordinates): Coordinates {
  return { x: value.x, y: value.y, z: value.z };
}

function copyToken(value: OklchToken): OklchToken {
  return {
    lightnessPermille: value.lightnessPermille,
    chromaPermille: value.chromaPermille,
    hueDegrees: value.hueDegrees,
  };
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
