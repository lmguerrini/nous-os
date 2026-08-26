import { MultiDirectedGraph } from "graphology";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertEngineAccessTrace, createEngineGraphView } from "#engine/contract.ts";
import type { Coordinates, DerivedValue, EngineAccessTrace, RenderedState, RenderedStateCarrier, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { lodView } from "#engine/lod.ts";
import type { LodBand, ResolvedMaterial } from "#engine/lod.ts";
import { applyMorphology, MYCELIUM, NEURAL, STELLAR } from "#engine/morphology.ts";
import type { EdgeMaterial, Morphology, MorphologyProfile, NodeMaterial } from "#engine/morphology.ts";
import { assertIndraOrganization, flatOrganization, indraOrganization } from "#engine/organization.ts";
import type { AggregateWindow, Organization, OrganizationResult } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { contrastRatio, relativeLuminance, resolveTokens } from "#engine/tokens.ts";
import type { OklchToken, Palette, Temperature, Theme, TokenMap } from "#engine/tokens.ts";
import { assertVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { filamentGeometry, sampleFilament } from "#render2d/geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";
import type { FilamentUniformMaterial } from "#render2d/filament-program.ts";

/** This is one Sigma node payload and does not retain opaque semantic content. */
export type RenderNodeAttributes = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly haloRadiusPx: number;
  readonly haloIntensityPermille: number;
  readonly label: string;
  readonly labelText: string;
  readonly labelPriority: number;
  readonly labelColor: string;
  readonly zIndex: number;
};

/** This is one Sigma edge payload and does not retain opaque semantic content. */
export type RenderEdgeAttributes = {
  readonly size: number;
  readonly pickTolerancePx: number;
  readonly widthStart: number;
  readonly widthEnd: number;
  readonly junctionStart: number;
  readonly junctionEnd: number;
  readonly wobblePhase: number;
  readonly hotCore: number;
  readonly color: string;
  readonly type: string;
  readonly curvature: number;
  readonly propagationArcPosition: number;
  readonly propagationContinuous: number;
  readonly afterglowDecayPermille: number;
  readonly label: string;
  readonly labelText: string;
  readonly forceLabel: boolean;
  readonly labelColor: string;
  readonly zIndex: number;
};

/** This is the renderer input selection and does not choose a semantic graph. */
export type RenderOptions = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette?: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  readonly elapsedMilliseconds: number;
  readonly calibration?: CalibrationProfile;
};

/** This is the declared shipping selection and does not constrain explicit palette comparisons. */
export const SHIPPING_RENDER_DEFAULTS = {
  palette: "monochrome",
} as const;

type ResolvedRenderOptions = Omit<RenderOptions, "palette"> & {
  readonly palette: Palette;
};

/** This fills the declared shipping palette and does not replace an explicit caller selection. */
export function resolveRenderOptions(options: RenderOptions): ResolvedRenderOptions {
  return { ...options, palette: options.palette ?? SHIPPING_RENDER_DEFAULTS.palette };
}

/** This is one filament propagation result and does not schedule a frame. */
export type FilamentPropagation = {
  readonly position: Coordinates;
  readonly length: number;
  readonly arcPosition: number;
  readonly continuous: boolean;
  readonly endpointExpressed: boolean;
};

/** This is the full render model and does not allocate a WebGL context. */
export type RenderModel = {
  readonly graph: MultiDirectedGraph<RenderNodeAttributes, RenderEdgeAttributes>;
  readonly anchors: ReadonlyMap<string, Coordinates>;
  readonly windows: readonly AggregateWindow[];
  readonly organization: OrganizationResult;
  readonly tokens: TokenMap;
  readonly tokenColors: ReadonlyMap<string, string>;
  /** This is the resolved shell field and does not create a renderer layer. */
  readonly fieldColor: string;
  readonly lodBand: LodBand;
  readonly material: ResolvedMaterial;
  readonly filamentMaterial: FilamentUniformMaterial;
  readonly filaments: ReadonlyMap<string, FilamentGeometry>;
  readonly propagation: ReadonlyMap<string, FilamentPropagation>;
  /** This records the engine-view fields read while this model was built and does not expose semantic values. */
  readonly engineAccessTrace: EngineAccessTrace;
};

/** This is one screen-space label candidate and does not create a visual node. */
export type LabelPlacementCandidate = {
  readonly id: string;
  readonly priority: number;
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
};

/** This is one IR-derived relation label candidate and does not add an edge or infer text. */
export type EdgeLabelCandidate = {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly opacityPermille: number;
};

/** This selects non-colliding labels by calibrated priority and does not alter node material. */
export function resolveLabelIds(
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

/** This creates a Sigma graph from the engine state and does not inspect semantic values. */
export function buildRenderModel(graph: VisualGraph, options: RenderOptions, visualState?: VisualState): RenderModel {
  if (visualState !== undefined) {
    assertVisualState(graph, visualState);
  }
  const { graph: engineGraph, trace: engineAccessTrace } = createEngineGraphView(graph);
  const activeOptions = resolveRenderOptions(visualState === undefined ? options : renderOptionsForVisualState(options, visualState));
  const calibration = activeOptions.calibration ?? DEFAULT_CALIBRATION;
  // Anchor sharing is established at the visual-graph boundary before a renderer
  // receives its structural engine view.  `sharedAnchors(Discovery, Reliability)`
  // records the policy transition on those two source graph identities; a fresh
  // EngineGraph is intentionally created for every render and cannot carry that
  // transition cache.  The resulting anchors remain the only layout input exposed
  // to the engine below.
  const anchors = layoutAnchors(graph, calibration);
  const morphology = morphologyProfile(activeOptions.morphology);
  const morphologyMaterial = applyMorphology(engineGraph, morphology, calibration);
  const tokens = shippingTokens(
    resolveTokens(activeOptions.palette, activeOptions.temperature, activeOptions.theme),
    activeOptions.palette,
    activeOptions.theme,
    calibration,
  );
  const tokenColors = new Map(Object.entries(tokens).map(([name, token]) => [name, tokenColor(token, permilleScale(calibration), calibration)]));
  const fieldColor = requiredTokenColor(tokenColors, "background");
  const organization = activeOptions.organization === "indra"
    ? indraOrganization(engineGraph, calibration, anchors)
    : flatOrganization(engineGraph, anchors);
  if (activeOptions.organization === "indra") {
    assertIndraOrganization(engineGraph, organization);
  }
  const view = lodView(engineGraph, anchors, activeOptions.lodBand);
  const sigmaGraph = new MultiDirectedGraph<RenderNodeAttributes, RenderEdgeAttributes>();
  const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
  const edgeMaterials = new Map(morphologyMaterial.edges.map((edge) => [edge.id, edge]));
  const filamentMaterial = calibration.morphology[morphology.id];
  const materialScale = permilleScale(calibration);
  const filamentUniformMaterial: FilamentUniformMaterial = {
    minimumWidthFactor: calibration.filament.minimumWidthFactorPermille / materialScale,
    // Fragment coordinates are device pixels, while this calibrated visibility
    // floor is a CSS-pixel requirement. The production shader applies its live
    // pixel ratio before comparing the two coordinate spaces.
    minimumBodyWidth: calibration.filament.minimumDeviceWidthPermille / materialScale,
    sheathScale: filamentMaterial.sheathScalePermille / materialScale,
    sheathAlpha: filamentMaterial.sheathAlphaPermille / materialScale,
    coreScale: filamentMaterial.coreScalePermille / materialScale,
    hotMix: filamentMaterial.hotMixPermille / materialScale,
    hotAlpha: filamentMaterial.hotAlphaPermille / materialScale,
    wobbleAmplitude: filamentMaterial.filamentWobbleAmplitudePermille / materialScale,
    wobbleFrequency: filamentMaterial.wobbleFrequencyMilliradians / materialScale,
    hotColor: requiredTokenColor(tokenColors, "peak"),
  };
  const filaments = new Map<string, FilamentGeometry>();
  const propagation = new Map<string, FilamentPropagation>();

  for (const node of engineGraph.nodes) {
    const anchor = view.anchors.get(node.id);
    const nodeMaterial = nodeMaterials.get(node.id);
    if (anchor === undefined || nodeMaterial === undefined) {
      throw new TypeError("renderer node material lacks an engine anchor");
    }
    const size = nodeSizeForMaterial(nodeMaterial, view.material, morphology, calibration);
    const attributes: RenderNodeAttributes = {
      x: anchor.x,
      y: anchor.y,
      size,
      color: nodeColorForMaterial(tokens, nodeMaterial, view.material, node.rendered ?? null, calibration),
      haloRadiusPx: materialIncludes(view.material.node, "halo") ? nodeMaterial.haloRadiusPx : size,
      haloIntensityPermille: materialIncludes(view.material.node, "halo") ? nodeMaterial.haloIntensityPermille : 0,
      label: "",
      labelText: materialIncludes(view.material.node, "label") ? node.visual.role : "",
      labelPriority: labelPriority(nodeMaterial.prominencePermille),
      labelColor: tokenColor(requiredToken(tokens, "text"), calibration.labels.nodeLabelOpacityPermille, calibration),
      zIndex: node.visual.label_priority,
    };
    sigmaGraph.addNode(node.id, nodeAttributesForVisualState(attributes, node.id, visualState, calibration));
  }
  for (const edge of engineGraph.edges) {
    const source = view.anchors.get(edge.source);
    const target = view.anchors.get(edge.target);
    const edgeMaterial = edgeMaterials.get(edge.id);
    if (source === undefined || target === undefined || edgeMaterial === undefined) {
      throw new TypeError("renderer edge material lacks an engine anchor");
    }
    const curvature = edgeCurvatureForMaterial(edgeMaterial, view.material, calibration);
    const filament = filamentGeometry(source, target, curvature);
    const path = { controlPoints: sampleFilament(filament, calibration) };
    const travelledDistance = propagationDistance(activeOptions.elapsedMilliseconds, calibration);
    const state = reducedMotionPosition(path, travelledDistance, activeOptions.reducedMotion || calibration.motion.reducedMotionSwitch);
    const length = arcLength(path);
    const arcPosition = state.continuous ? normalisedPropagationPosition(travelledDistance, length) : 1;
    filaments.set(edge.id, filament);
    propagation.set(edge.id, {
      position: state.position,
      length,
      arcPosition,
      continuous: state.continuous,
      endpointExpressed: state.endpointExpressed,
    });
    const attributes: RenderEdgeAttributes = {
      size: edgeWidthForMaterial(edgeMaterial, view.material, calibration),
      pickTolerancePx: calibration.filament.pickTolerancePx,
      widthStart: edgeMaterial.widthStartPermille / materialScale,
      widthEnd: edgeMaterial.widthEndPermille / materialScale,
      junctionStart: edgeMaterial.junctionStartPermille / materialScale,
      junctionEnd: edgeMaterial.junctionEndPermille / materialScale,
      wobblePhase: (edgeMaterial.phasePermille / materialScale) * Math.PI * 2,
      hotCore: edgeMaterial.hotCorePermille / materialScale,
      color: edgeColorForMaterial(tokens, edgeMaterial, calibration),
      type: "filament",
      curvature,
      propagationArcPosition: arcPosition,
      propagationContinuous: state.continuous ? 1 : 0,
      afterglowDecayPermille: calibration.motion.afterglowDecayPermille,
      label: "",
      labelText: edge.kind,
      forceLabel: false,
      labelColor: requiredTokenColor(tokenColors, "textMuted"),
      zIndex: edge.visual.label_priority,
    };
    sigmaGraph.addEdgeWithKey(edge.id, edge.source, edge.target, edgeAttributesForVisualState(attributes, edge.id, visualState, calibration));
  }
  assertEngineAccessTrace(engineAccessTrace);
  return { graph: sigmaGraph, anchors, windows: organization.windows, organization, tokens, tokenColors, fieldColor, lodBand: view.band, material: view.material, filamentMaterial: filamentUniformMaterial, filaments, propagation, engineAccessTrace };
}

/** This applies VisualState's active view settings and leaves elapsed runtime settings unchanged. */
export function renderOptionsForVisualState(options: RenderOptions, state: VisualState): RenderOptions {
  return {
    ...options,
    morphology: state.morphology,
    organization: state.organization,
    palette: state.palette,
    temperature: state.temperature,
    theme: state.theme,
    lodBand: state.lodBand,
    reducedMotion: state.reducedMotion,
  };
}

/** This selects IR-derived relation labels by LOD and current focus without changing graph structure. */
export function edgeLabelCandidatesForState(
  model: RenderModel,
  state: Pick<VisualState, "selectedId" | "focusedId">,
  calibration: CalibrationProfile,
): readonly EdgeLabelCandidate[] {
  if (model.lodBand === "macro") {
    return [];
  }
  const relevant = new Set<string>();
  const selectedRelation = state.selectedId !== null && model.graph.hasEdge(state.selectedId) ? state.selectedId : null;
  const focusedRelation = state.focusedId !== null && model.graph.hasEdge(state.focusedId) ? state.focusedId : null;
  if (selectedRelation !== null) {
    relevant.add(selectedRelation);
  }
  if (focusedRelation !== null) {
    relevant.add(focusedRelation);
  }
  if (state.focusedId !== null && model.graph.hasNode(state.focusedId)) {
    for (const edgeId of model.graph.edges(state.focusedId)) {
      relevant.add(edgeId);
    }
  }
  const candidateIds = model.lodBand === "meso"
    ? relevant
    : relevant.size > 0 ? relevant : new Set(model.graph.edges());
  return [...candidateIds].map((id) => {
    const attributes = model.graph.getEdgeAttributes(id);
    const selected = id === selectedRelation;
    const focused = id === focusedRelation || (state.focusedId !== null && model.graph.hasNode(state.focusedId) && model.graph.edges(state.focusedId).includes(id));
    return {
      id,
      text: attributes.labelText,
      priority: attributes.zIndex + calibration.labels.priorityWeights.edge
        + (selected ? calibration.labels.edgeSelectionPriorityBoost : focused ? calibration.labels.edgeFocusPriorityBoost : 0),
      opacityPermille: selected
        ? calibration.labels.edgeLabelSelectedOpacityPermille
        : focused ? calibration.labels.edgeLabelFocusOpacityPermille : calibration.labels.edgeLabelOpacityPermille,
    };
  });
}

/** This returns the selected element's existing derivation record and does not synthesise provenance. */
export function selectedProvenanceForVisualState(
  graph: VisualGraph,
  state: VisualState,
): DerivedValue | null {
  if (state.selectedId === null) {
    return null;
  }
  const element = [...graph.nodes, ...graph.edges].find((candidate) => candidate.id === state.selectedId);
  if (element === undefined) {
    throw new TypeError("selected graph element provenance is unavailable");
  }
  return element.derived;
}

/** This changes selected node material only and does not change a node id, anchor, or label. */
export function nodeAttributesForVisualState(
  attributes: RenderNodeAttributes,
  id: string,
  state: VisualState | undefined,
  calibration: CalibrationProfile,
): RenderNodeAttributes {
  if (state === undefined) {
    return attributes;
  }
  const selected = state.selectedId === id;
  const scale = permilleScale(calibration);
  const emphasis = selected ? calibration.selection.emphasisMultiplierPermille / scale : scale / scale;
  return {
    ...attributes,
    size: attributes.size * emphasis,
    haloRadiusPx: attributes.haloRadiusPx * emphasis,
    color: focusAdjustedColor(attributes.color, state.focusedId === id, state.focusedId !== null, calibration),
  };
}

/** This changes selected edge material only and does not change edge incidence or geometry. */
export function edgeAttributesForVisualState(
  attributes: RenderEdgeAttributes,
  id: string,
  state: VisualState | undefined,
  calibration: CalibrationProfile,
): RenderEdgeAttributes {
  if (state === undefined) {
    return attributes;
  }
  const scale = permilleScale(calibration);
  const emphasis = state.selectedId === id
    ? calibration.selection.emphasisMultiplierPermille / scale
    : scale / scale;
  return {
    ...attributes,
    size: attributes.size * emphasis,
    color: focusAdjustedColor(attributes.color, state.focusedId === id, state.focusedId !== null, calibration),
  };
}

function materialIncludes(items: readonly string[], item: string): boolean {
  return items.includes(item);
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
  const scale = permilleScale(calibration);
  const range = calibration.salience.maxNodeSizePx - calibration.salience.minNodeSizePx;
  const mass = calibration.salience.minNodeSizePx + ((node.prominencePermille * range) / scale);
  const morphologyMultiplier = calibration.morphology[morphology.id].nodeSizeMultiplierPermille;
  return (mass * morphologyMultiplier * calibration.lod.macroNodeSizeMultiplierPermille) / (scale * scale);
}

function nodeColorForMaterial(
  tokens: TokenMap,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  rendered: RenderedStateCarrier,
  calibration: CalibrationProfile,
): string {
  return tokenColor(renderedStateToken(nodeTokenForMaterial(tokens, material, resolved, calibration), rendered, calibration), material.opacityPermille, calibration);
}

/** This applies the bounded governed RENDERED material delta and does not alter hue, opacity, topology-derived prominence, or node mass. */
function renderedStateToken(
  token: OklchToken,
  rendered: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  if (rendered === null) {
    return token;
  }
  const delta = Math.round(
    rendered.reduce((total, state) => total + renderedStateLightnessDelta(state, calibration), 0) / rendered.length,
  );
  return {
    ...token,
    lightnessPermille: Math.max(0, Math.min(permilleScale(calibration), token.lightnessPermille + delta)),
  };
}

/** This reads one calibrated RENDERED material delta and does not supply a renderer-local semantic literal. */
function renderedStateLightnessDelta(state: RenderedState, calibration: CalibrationProfile): number {
  if (state.enumType === "TemporalDisposition") {
    if (state.member === "established") {
      return calibration.renderedState.temporalEstablishedLightnessDeltaPermille;
    }
    if (state.member === "excluded") {
      return calibration.renderedState.temporalExcludedLightnessDeltaPermille;
    }
    return calibration.renderedState.temporalUndeterminedLightnessDeltaPermille;
  }
  if (state.enumType === "BridgeDisposition") {
    if (state.member === "accepted") {
      return calibration.renderedState.bridgeAcceptedLightnessDeltaPermille;
    }
    if (state.member === "rejected") {
      return calibration.renderedState.bridgeRejectedLightnessDeltaPermille;
    }
    return calibration.renderedState.bridgeUndeterminedLightnessDeltaPermille;
  }
  if (state.member === "explicit") {
    return calibration.renderedState.epistemicExplicitLightnessDeltaPermille;
  }
  if (state.member === "derived") {
    return calibration.renderedState.epistemicDerivedLightnessDeltaPermille;
  }
  return calibration.renderedState.epistemicSpeculativeLightnessDeltaPermille;
}

/** This resolves the node token in OKLCH and does not convert it to renderer bytes. */
export function nodeTokenForMaterial(
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

function edgeWidthForMaterial(edge: EdgeMaterial, material: ResolvedMaterial, calibration: CalibrationProfile): number {
  const resolvedKindWidth = kindWidth(edge, calibration);
  if (materialIncludes(material.edge, "skeleton")) {
    return (resolvedKindWidth * calibration.lod.macroFilamentWidthMultiplierPermille) / permilleScale(calibration);
  }
  return materialIncludes(material.edge, "taper") ? edge.widthPx : resolvedKindWidth;
}

function edgeCurvatureForMaterial(edge: EdgeMaterial, material: ResolvedMaterial, calibration: CalibrationProfile): number {
  return materialIncludes(material.edge, "curvature")
    ? edge.curvaturePermille / permilleScale(calibration)
    : 0;
}

function edgeColorForMaterial(
  tokens: TokenMap,
  edge: EdgeMaterial,
  calibration: CalibrationProfile,
): string {
  return tokenColor(
    minimumNodeContrastToken(requiredToken(tokens, "edge"), requiredToken(tokens, "background"), calibration),
    edge.opacityPermille,
    calibration,
  );
}

function kindWidth(edge: EdgeMaterial, calibration: CalibrationProfile): number {
  if (edge.taperPermille === 0) {
    throw new TypeError("renderer taper material must be non-zero");
  }
  return (edge.widthPx * permilleScale(calibration)) / edge.taperPermille;
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
    lightnessPermille: Math.max(0, token.lightnessPermille - (hopDistance * calibration.lod.microHopDistanceLightnessStepPermille)),
  };
  return minimumNodeContrastToken(darkened, background, calibration);
}

function requiredHopDistance(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("renderer hop-distance material is unavailable");
  }
  const hopDistance = Number(value);
  if (hopDistance < 0) {
    throw new TypeError("renderer hop-distance material is unavailable");
  }
  return hopDistance;
}

function labelPriority(prominencePermille: number): number {
  return prominencePermille;
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

function prominenceToken(tokens: TokenMap, prominencePermille: number, calibration: CalibrationProfile): OklchToken {
  const background = requiredToken(tokens, "background");
  const lowProminence = minimumNodeContrastToken(requiredToken(tokens, "accent2"), background, calibration);
  const highProminence = requiredToken(tokens, "peak");
  const lightnessTravel = prominenceTravel(
    prominencePermille,
    calibration.luminance.prominenceLightnessGainPermille,
    calibration,
  );
  const chromaTravel = prominenceTravel(
    prominencePermille,
    calibration.luminance.prominenceChromaFalloffPermille,
    calibration,
  );
  return {
    lightnessPermille: Math.round(lowProminence.lightnessPermille + ((highProminence.lightnessPermille - lowProminence.lightnessPermille) * lightnessTravel / permilleScale(calibration))),
    chromaPermille: Math.round(lowProminence.chromaPermille + ((highProminence.chromaPermille - lowProminence.chromaPermille) * chromaTravel / permilleScale(calibration))),
    hueDegrees: lowProminence.hueDegrees,
  };
}

function minimumNodeContrastToken(
  token: OklchToken,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  const scale = permilleScale(calibration);
  const minimumContrast = calibration.luminance.minimumNodeContrastPermille / scale;
  const backgroundLuminance = relativeLuminance(background);
  let candidate = token;
  while (
    (relativeLuminance(candidate) <= backgroundLuminance || contrastRatio(candidate, background) < minimumContrast)
    && candidate.lightnessPermille < scale
  ) {
    candidate = { ...candidate, lightnessPermille: candidate.lightnessPermille + 1 };
  }
  if (relativeLuminance(candidate) <= backgroundLuminance || contrastRatio(candidate, background) < minimumContrast) {
    throw new TypeError("renderer node contrast calibration is unreachable");
  }
  return candidate;
}

function prominenceTravel(prominencePermille: number, gainPermille: number, calibration: CalibrationProfile): number {
  return Math.max(0, Math.min(permilleScale(calibration), (prominencePermille * gainPermille) / permilleScale(calibration)));
}

function requiredToken(tokens: TokenMap, name: string): OklchToken {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError("renderer prominence token is unavailable");
  }
  return token;
}

/** This calibrates the monochrome dark shipping master and leaves explicit palette or light-theme comparisons intact. */
function shippingTokens(
  tokens: TokenMap,
  palette: Palette,
  theme: Theme,
  calibration: CalibrationProfile,
): TokenMap {
  if (palette !== SHIPPING_RENDER_DEFAULTS.palette) {
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

/** This applies a governed neutral lightness and does not introduce hue into the shipping master. */
function calibratedMonochromeToken(token: OklchToken, lightnessPermille: number): OklchToken {
  return { ...token, lightnessPermille, chromaPermille: 0 };
}

/** This resolves material morphology and does not derive topology from a name. */
function morphologyProfile(morphology: Morphology): MorphologyProfile {
  if (morphology === STELLAR.id) {
    return STELLAR;
  }
  if (morphology === NEURAL.id) {
    return NEURAL;
  }
  return MYCELIUM;
}

/** This converts one OKLCH token at the renderer boundary and does not change the token space. */
export function tokenColor(token: OklchToken, opacityPermille: number, calibration: CalibrationProfile): string {
  const scale = permilleScale(calibration);
  const hueRadians = (token.hueDegrees * Math.PI) / Number("180");
  const color = gamutMappedSrgb(
    token.lightnessPermille / scale,
    token.chromaPermille / scale,
    Math.cos(hueRadians),
    Math.sin(hueRadians),
    calibration,
  );
  const opacity = opacityPermille / scale;
  const channels = [color.red, color.green, color.blue].map(srgbByte);
  return opacity === 1
    ? `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`
    : `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
}

function requiredTokenColor(tokenColors: ReadonlyMap<string, string>, name: string): string {
  const color = tokenColors.get(name);
  if (color === undefined) {
    throw new TypeError("renderer token colour is unavailable");
  }
  return color;
}

function focusAdjustedColor(
  color: string,
  isFocused: boolean,
  hasFocus: boolean,
  calibration: CalibrationProfile,
): string {
  if (!hasFocus || isFocused) {
    return color;
  }
  const parsed = color.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
  if (parsed === null) {
    throw new TypeError("renderer focus colour is unavailable");
  }
  const scale = permilleScale(calibration);
  const encodedOpacity = parsed.at(-Number("1"));
  const sourceOpacity = encodedOpacity === undefined ? scale / scale : Number(encodedOpacity);
  const opacity = sourceOpacity * calibration.selection.focusDimFactorPermille / scale;
  return `rgba(${parsed[1]}, ${parsed[2]}, ${parsed[3]}, ${opacity})`;
}

type LinearSrgb = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

const [LMS_L_A, LMS_L_B, LMS_M_A, LMS_M_B, LMS_S_A, LMS_S_B] = namedCoefficients(
  "0.3963377774", "0.2158037573", "-0.1055613458", "-0.0638541728", "-0.0894841775", "-1.291485548",
);
const [SRGB_R_L, SRGB_R_M, SRGB_R_S, SRGB_G_L, SRGB_G_M, SRGB_G_S, SRGB_B_L, SRGB_B_M, SRGB_B_S] = namedCoefficients(
  "4.0767416621", "-3.3077115913", "0.2309699292",
  "-1.2684380046", "2.6097574011", "-0.3413193965",
  "-0.0041960863", "-0.7034186147", "1.707614701",
);
const SRGB_THRESHOLD = Number("0.0031308");
const SRGB_LINEAR_DIVISOR = Number("12.92");
const SRGB_ENCODE_OFFSET = Number("0.055");
const SRGB_ENCODE_DIVISOR = Number("1.055");
const SRGB_ENCODE_EXPONENT = Number("2.4");
const SRGB_ENCODE_MULTIPLIER = Number("1.055");
const SRGB_BYTE_MAXIMUM = Number("255");

function gamutMappedSrgb(
  lightness: number,
  chroma: number,
  cosine: number,
  sine: number,
  calibration: CalibrationProfile,
): LinearSrgb {
  const step = gamutMappingStep(calibration);
  let mappedChroma = chroma;
  let color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  if (inSrgbGamut(color)) {
    return color;
  }
  while (!inSrgbGamut(color)) {
    mappedChroma = Math.max(0, mappedChroma - step);
    color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  }
  return oklchToLinearSrgb(
    lightness,
    mappedChroma * (Math.min(1, chroma / gamutCompressionRange(calibration)) ** gamutCompressionExponent(calibration)),
    cosine,
    sine,
  );
}

function gamutMappingStep(calibration: CalibrationProfile): number {
  const step = gamutCompressionRange(calibration) / permilleScale(calibration);
  if (step <= 0) {
    throw new TypeError("calibration gamut-mapping step must be positive");
  }
  return step;
}

function gamutCompressionRange(calibration: CalibrationProfile): number {
  return calibration.labels.collisionPaddingPx / calibration.layout.idealEdgeLengthPx;
}

function gamutCompressionExponent(calibration: CalibrationProfile): number {
  return calibration.layout.idealEdgeLengthPx / calibration.labels.densityCap;
}

function oklchToLinearSrgb(lightness: number, chroma: number, cosine: number, sine: number): LinearSrgb {
  const a = chroma * cosine;
  const b = chroma * sine;
  const l = lightness + (LMS_L_A * a) + (LMS_L_B * b);
  const m = lightness + (LMS_M_A * a) + (LMS_M_B * b);
  const s = lightness + (LMS_S_A * a) + (LMS_S_B * b);
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return {
    red: (SRGB_R_L * l3) + (SRGB_R_M * m3) + (SRGB_R_S * s3),
    green: (SRGB_G_L * l3) + (SRGB_G_M * m3) + (SRGB_G_S * s3),
    blue: (SRGB_B_L * l3) + (SRGB_B_M * m3) + (SRGB_B_S * s3),
  };
}

function inSrgbGamut(color: LinearSrgb): boolean {
  return [color.red, color.green, color.blue].every((channel) => channel >= 0 && channel <= 1);
}

function srgbByte(channel: number): number {
  return Math.round(linearToSrgb(channel) * SRGB_BYTE_MAXIMUM);
}

function linearToSrgb(channel: number): number {
  return channel <= SRGB_THRESHOLD
    ? channel * SRGB_LINEAR_DIVISOR
    : (SRGB_ENCODE_MULTIPLIER * (channel ** (1 / SRGB_ENCODE_EXPONENT))) - SRGB_ENCODE_OFFSET;
}

function namedCoefficients<const Values extends readonly string[]>(...values: Values): { readonly [Index in keyof Values]: number } {
  return values.map(Number) as { readonly [Index in keyof Values]: number };
}

/** This obtains the pinned scaled-integer base and does not introduce a renderer-local tuning number. */
function permilleScale(calibration: CalibrationProfile): number {
  return calibration.morphology.stellar.opacityPermille;
}

/** This turns elapsed time into calibrated path distance and does not schedule continuous movement. */
function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / permilleScale(calibration);
}

/** This normalises travelled distance to the sampled arc and does not use vertex index spacing. */
function normalisedPropagationPosition(travelledDistance: number, length: number): number {
  return length === 0 ? 1 : Math.max(0, Math.min(travelledDistance / length, 1));
}
