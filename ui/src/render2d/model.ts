import type { PresentationOptions } from "#engine/presentation-options.ts";
import { mixTowardField, tintRgba } from "#engine/presentation-options.ts";
import { MultiDirectedGraph } from "graphology";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
// "D082-A-PERF BEGIN"
import { memoizedContrastToken } from "#render-common/contrast-cache.ts";
import { mainRelation, MODEL_PREP_SLICE_MS } from "#render-common/quality-ladder.ts";
// "D082-A-PERF END"
// The governed RENDERED composition is NOT resolved here. It lives in the shared scene layer, which
// composes the two axes of a relation's carrier positionally instead of averaging them: the local
// version collapsed nine legal combinations onto five values, so two elements in different semantic
// states drew byte-identical. Importing it is how this renderer inherits that repair rather than
// carrying a second copy of the arithmetic that would drift from it.
import { renderedStateToken } from "#scene/rendered-state.ts";
import { assertEngineAccessTrace, assertVisualGraphFieldRegister, createEngineGraphView, renderDebugAssertionsEnabled } from "#engine/contract.ts";
import type { Coordinates, DerivedValue, EngineAccessTrace, RenderedState, RenderedStateCarrier, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
// D084-W2-NEURAL-R3 BEGIN: dense WebGL receives the same leaf body scale as canvas and 3D.
import { neuralEndpointBodyScale } from "#engine/morphology-geometry.ts";
// D084-W2-NEURAL-R3 END
import type { LayoutAnchors } from "#engine/layout.ts";
import { lodView } from "#engine/lod.ts";
import type { LodBand, ResolvedMaterial } from "#engine/lod.ts";
import { applyMorphology, MYCELIUM, NEURAL, STELLAR } from "#engine/morphology.ts";
import type { EdgeMaterial, Morphology, MorphologyProfile, NodeMaterial } from "#engine/morphology.ts";
import { assertIndraOrganization, flatOrganization, indraOrganization } from "#engine/organization.ts";
import type { AggregateWindow, Organization, OrganizationResult } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { resolveTokens, separationLuminance, separationRatio } from "#engine/tokens.ts";
import type { OklchToken, Palette, Temperature, Theme, TokenMap } from "#engine/tokens.ts";
import { assertVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { filamentGeometry, sampleFilament } from "#render2d/geometry.ts";
import { neuralRootRatio } from "#engine/morphology-geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";
import type { FilamentUniformMaterial } from "#render2d/filament-program.ts";
import { validateRenderVisibility } from "../projection/contract.ts";
import type { ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection, Vec2, VisualContainer, VisualCurve, VisualRelation, MathematicalField } from "../projection/contract-types.ts";
import { LABEL_BUDGET, disambiguateLabels, footprintDisc, placeLabels, shortLabelWithEllipsis } from "#render-common/labels.ts";
import type { LabelCandidate, LabelDisc, LabelReason, LabelRim, PlacedLabel, ViewportRect } from "#render-common/labels.ts";
import { TYPED_LABEL_DOM } from "#render-common/projection-style.ts";

// Typed style and label policy live below both renderers; this re-export preserves the 2D model API.
export { readProjectionStyle, typedLabelKind, typedLabelTexts, typedRgbaColor } from "#render-common/projection-style.ts";
export { TYPED_LABEL_CAMERA } from "#render-common/projection-style.ts";
export type { ProjectionStyleScope } from "#render-common/projection-style.ts";

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
  /** Neural root ratios derived from the drawn incident edges. */
  readonly neuralRootRatios?: readonly [number, number];
  // D084-W2-NEURAL-R3 BEGIN
  readonly neuralBodyScales?: readonly [number, number];
  // D084-W2-NEURAL-R3 END
  // "D082-A-NCOMPLETA3 BEGIN": native Neural roots follow their edge's local veil.
  readonly neuralDenseFactor?: number;
  // "D082-A-NCOMPLETA3 END"
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

/** Screen-space geometry used by both 2D views. Input order is paint order. */
export type ScreenPickDisc = { readonly id: string; readonly x: number; readonly y: number; readonly radius: number };
export type ScreenPickSegment = { readonly id: string; readonly ax: number; readonly ay: number;
  readonly bx: number; readonly by: number; readonly tolerance: number };
export type ScreenPickIndex = {
  nodeAt(point: { readonly x: number; readonly y: number }): string | null;
  edgeAt(point: { readonly x: number; readonly y: number }): string | null;
};

/** One rebuild per drawn frame revision or settled camera, with constant-size pointer queries. */
export function buildScreenPickIndex(
  discs: readonly ScreenPickDisc[], rims: readonly ScreenPickSegment[], edges: readonly ScreenPickSegment[],
  width: number, height: number,
): ScreenPickIndex {
  const cell = 2 ** (2 + 2 + 1);
  const columns = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const nodeCells = new Map<number, number[]>();
  const rimCells = new Map<number, number[]>();
  const edgeCells = new Map<number, number[]>();
  const insert = (map: Map<number, number[]>, index: number, left: number, top: number, right: number, bottom: number) => {
    if (![left, top, right, bottom].every(Number.isFinite) || right < 0 || bottom < 0 || left > width || top > height) return;
    const x0 = Math.max(0, Math.floor(left / cell)), x1 = Math.min(columns - 1, Math.floor(right / cell));
    const y0 = Math.max(0, Math.floor(top / cell)), y1 = Math.min(rows - 1, Math.floor(bottom / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = y * columns + x;
      const list = map.get(key);
      if (list) list.push(index); else map.set(key, [index]);
    }
  };
  discs.forEach((d, i) => insert(nodeCells, i, d.x - d.radius, d.y - d.radius, d.x + d.radius, d.y + d.radius));
  const indexSegments = (segments: readonly ScreenPickSegment[], map: Map<number, number[]>) => segments.forEach((s, i) =>
    insert(map, i, Math.min(s.ax, s.bx) - s.tolerance, Math.min(s.ay, s.by) - s.tolerance,
      Math.max(s.ax, s.bx) + s.tolerance, Math.max(s.ay, s.by) + s.tolerance));
  indexSegments(rims, rimCells);
  indexSegments(edges, edgeCells);
  const entries = (map: Map<number, number[]>, point: { readonly x: number; readonly y: number }) => {
    const x = Math.floor(point.x / cell), y = Math.floor(point.y / cell);
    return x < 0 || y < 0 || x >= columns || y >= rows ? [] : map.get(y * columns + x) ?? [];
  };
  const distance = (point: { readonly x: number; readonly y: number }, s: ScreenPickSegment) => {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const t = Math.max(0, Math.min(1, ((point.x - s.ax) * dx + (point.y - s.ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(point.x - s.ax - t * dx, point.y - s.ay - t * dy);
  };
  const nearest = (segments: readonly ScreenPickSegment[], map: Map<number, number[]>, point: { readonly x: number; readonly y: number }) => {
    let found: string | null = null, best = Infinity;
    for (const i of entries(map, point)) {
      const segment = segments[i]!;
      const d = distance(point, segment);
      if (d <= segment.tolerance && d < best) { best = d; found = segment.id; }
    }
    return found;
  };
  return {
    nodeAt(point) {
      // Later discs are painted over earlier ones. A rim answers only outside all discs.
      const candidates = entries(nodeCells, point);
      for (let i = candidates.length - 1; i >= 0; i--) {
        const disc = discs[candidates[i]!]!;
        if (Math.hypot(point.x - disc.x, point.y - disc.y) <= disc.radius) return disc.id;
      }
      return nearest(rims, rimCells, point);
    },
    edgeAt: point => nearest(edges, edgeCells, point),
  };
}

/** This is the renderer input selection and does not choose a semantic graph. */
export type RenderOptions = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette?: Palette;
  /** This is the human-selected hue anchor and is required only when `palette` is `"accent-hue"`; every other palette ignores it, exactly as `resolveTokens` does. */
  readonly hueAnchorDegrees?: number;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  readonly elapsedMilliseconds: number;
  readonly calibration?: CalibrationProfile;
  readonly presentation?: PresentationOptions;
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

/** Typed projection scene. Source edges and structural visuals never share an edge carrier. */
export type Projection2dScene = {
  readonly digest: string;
  readonly revision: number;
  readonly nodes: ReadonlyMap<string, { readonly position: Vec2; readonly style: Readonly<Record<string, number | string>> }>;
  readonly semanticEdges: ReadonlyMap<string, { readonly source: string; readonly target: string; readonly attestation: 'attested' | 'exploratory'; readonly style: Readonly<Record<string, number | string>> }>;
  readonly visualRelations: ReadonlyMap<string, VisualRelation>;
  readonly curves: ReadonlyMap<string, VisualCurve>;
  readonly containers: ReadonlyMap<string, VisualContainer>;
  readonly fields: ReadonlyMap<string, MathematicalField>;
  readonly styled: StyledProjection;
  readonly visibility: RenderVisibility;
};

/** Validates the six independent classes before any Sigma/canvas mutation. */
export function prepareProjection2d(
  snapshot: SemanticGraphSnapshot, styled: StyledProjection, visibility: RenderVisibility,
): Projection2dScene {
  const result: ProjectionResult = styled.projection;
  if (result.determinism.snapshotDigest !== snapshot.digest) throw new Error('projection snapshot mismatch');
  validateRenderVisibility(result, visibility, snapshot);
  if (result.positions3 !== undefined || (result.coordinateState.kind === 'coordinates' && result.positions2 === undefined)) {
    throw new Error('2D renderer requires 2D coordinates');
  }
  const positions = result.positions2 ?? {};
  const nodes = new Map<string, { position: Vec2; style: Readonly<Record<string, number | string>> }>();
  for (const id of visibility.nodeIds) {
    const position = positions[id];
    if (position === undefined) throw new Error(`visible node has no 2D position: ${id}`);
    nodes.set(id, { position, style: styled.nodeStyle[id] ?? {} });
  }
  const sourceEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  const semanticEdges = new Map<string, { source: string; target: string; attestation: 'attested' | 'exploratory'; style: Readonly<Record<string, number | string>> }>();
  for (const id of visibility.semanticEdgeIds) {
    const edge = sourceEdges.get(id);
    if (edge === undefined) throw new Error(`unknown source edge: ${id}`);
    semanticEdges.set(id, { source: edge.source, target: edge.target, attestation: edge.attestation, style: styled.edgeStyle[id] ?? {} });
  }
  const select = <T extends { readonly visualId: string }>(items: readonly T[], ids: ReadonlySet<string>): ReadonlyMap<string, T> =>
    new Map(items.filter(item => ids.has(item.visualId)).map(item => [item.visualId, item]));
  return {
    digest: result.determinism.resultDigest, revision: visibility.revision, nodes, semanticEdges,
    visualRelations: select(result.visualRelations, visibility.visualRelationIds),
    curves: select(result.curves, visibility.curveIds),
    containers: select(result.containers, visibility.containerIds),
    fields: new Map(result.fields.filter(item => visibility.fieldIds.has(item.id)).map(item => [item.id, item])),
    styled, visibility,
  };
}

/** Stable content key for equal-revision conflict detection; set iteration order is irrelevant. */
export function projection2dVisibilityKey(styled: StyledProjection, visibility: RenderVisibility): string {
  const ids = (set: ReadonlySet<string>) => [...set].sort();
  return JSON.stringify([
    visibility.projectionResultDigest, visibility.revision, visibility.density,
    ids(visibility.levelIds), ids(visibility.nodeIds), ids(visibility.semanticEdgeIds),
    ids(visibility.visualRelationIds), ids(visibility.curveIds), ids(visibility.containerIds), ids(visibility.fieldIds),
    styled.nodeStyle, styled.edgeStyle, styled.visualStyle,
  ]);
}

/** Revision handling is independent of Sigma and runs before any graph mutation. */
export function projection2dRevisionAction(
  currentRevision: number, currentKey: string, nextRevision: number, nextKey: string,
): 'stale' | 'same' | 'apply' {
  if (nextRevision < currentRevision) return 'stale';
  if (nextRevision === currentRevision) {
    if (nextKey !== currentKey) throw new Error('equal projection visibility revision changed content');
    return 'same';
  }
  return 'apply';
}

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

/** This creates a Sigma graph from the engine state and does not derive a second supplied placement. */
export function buildRenderModel(
  graph: VisualGraph,
  options: RenderOptions,
  visualState?: VisualState,
  suppliedAnchors?: LayoutAnchors,
): RenderModel {
  // "D082-A-PERF BEGIN": the synchronous contract consumes the same steps as the
  // large-entry async path, so its final graph and attribute order stay exact.
  const steps = renderModelSteps(graph, options, visualState, suppliedAnchors);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
  // "D082-A-PERF END"
}

// "D082-A-PERF BEGIN"
export async function prepareRenderModelInSlices(
  graph: VisualGraph, options: RenderOptions, visualState?: VisualState,
  suppliedAnchors?: LayoutAnchors,
  onProgress?: (progress: RenderModelProgress) => void,
): Promise<RenderModel> {
  const steps = renderModelSteps(graph, options, visualState, suppliedAnchors);
  let step = steps.next();
  while (!step.done) {
    onProgress?.(step.value);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    step = steps.next();
  }
  return step.value;
}

export type RenderModelProgress = {
  readonly stage: 'nodes' | 'mainEdges' | 'allEdges';
  readonly nodesLoaded: number;
  readonly mainEdgesLoaded: number;
  readonly edgesLoaded: number;
  readonly mainEdgesRequired: number;
};

function* renderModelSteps(
  graph: VisualGraph, options: RenderOptions, visualState?: VisualState,
  suppliedAnchors?: LayoutAnchors,
): Generator<RenderModelProgress, RenderModel, void> {
  let sliceBegan = performance.now();
  const sliceDue = () => {
    if (performance.now() - sliceBegan < MODEL_PREP_SLICE_MS) return false;
    sliceBegan = performance.now();
    return true;
  };
// "D082-A-PERF END"
  // "D082-A-PERF BEGIN": explicit debug runs keep the exhaustive boundary audit.
  if (renderDebugAssertionsEnabled()) assertVisualGraphFieldRegister(graph);
  if (visualState !== undefined) {
    if (renderDebugAssertionsEnabled()) assertVisualState(graph, visualState);
  }
  const { graph: engineGraph, trace: engineAccessTrace } = createEngineGraphView(graph, { fast: true });
  // "D082-A-PERF END"
  const activeOptions = resolveRenderOptions(visualState === undefined ? options : renderOptionsForVisualState(options, visualState));
  const calibration = activeOptions.calibration ?? DEFAULT_CALIBRATION;
  // Anchor sharing is established at the visual-graph boundary before a renderer
  // receives its structural engine view.  `sharedAnchors(Discovery, Reliability)`
  // records the policy transition on those two source graph identities; a fresh
  // EngineGraph is intentionally created for every render and cannot carry that
  // transition cache.  The resulting anchors remain the only layout input exposed
  // to the engine below.
  const anchors = suppliedAnchors ?? layoutAnchors(graph, calibration);
  const morphology = morphologyProfile(activeOptions.morphology);
  const morphologyMaterial = applyMorphology(engineGraph, morphology, calibration);
  const tokens = shippingTokens(
    resolveTokens(activeOptions.palette, activeOptions.temperature, activeOptions.theme, activeOptions.hueAnchorDegrees),
    activeOptions.palette,
    activeOptions.theme,
    calibration,
  );
  const tokenColors = new Map(Object.entries(tokens).map(([name, token]) => [name, tokenColor(token, permilleScale(calibration), calibration)]));
  const fieldColor = requiredTokenColor(tokenColors, "background");
  const organization = activeOptions.organization === "indra"
    ? indraOrganization(engineGraph, calibration, anchors, activeOptions.presentation?.windowGeometryFromAnchors)
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
    neuralProfile: morphology.id === NEURAL.id,
    neuralWidthPx: activeOptions.presentation?.appearance?.edgeWidth ?? 1,
  };
  const filaments = new Map<string, FilamentGeometry>();
  const propagation = new Map<string, FilamentPropagation>();

  // "D082-A-PERF BEGIN": main relations use the same predicate as the renderer's
  // presented-frame ledger. Work on them before secondary relations, then add
  // all records to Graphology in source order for identical final paint order.
  const isMain = (edge: (typeof engineGraph.edges)[number]): boolean => {
    const source = activeOptions.presentation?.nodes?.get(edge.source)?.glyph;
    const target = activeOptions.presentation?.nodes?.get(edge.target)?.glyph;
    const category = activeOptions.presentation?.edges?.get(edge.id)?.category;
    return mainRelation({ attested: category === 'attested', exploratory: category === 'exploratory',
      selectedIncident: !!(activeOptions.presentation?.emphasisIds?.has(edge.source)
        || activeOptions.presentation?.emphasisIds?.has(edge.target)),
      sourceHub: source === 'double-ring', targetHub: target === 'double-ring',
      sourceDomain: source === 'ring', targetDomain: target === 'ring' });
  };
  const mainEdges = engineGraph.edges.filter(isMain);
  const secondaryEdges = engineGraph.edges.filter(edge => !isMain(edge));
  const progress = (stage: RenderModelProgress['stage'], mainEdgesLoaded: number, edgesLoaded: number): RenderModelProgress => ({
    stage, nodesLoaded: sigmaGraph.order, mainEdgesLoaded, edgesLoaded,
    mainEdgesRequired: mainEdges.length,
  });
  // "D082-A-PERF END"

  for (const node of engineGraph.nodes) {
    const anchor = view.anchors.get(node.id);
    const nodeMaterial = nodeMaterials.get(node.id);
    if (anchor === undefined || nodeMaterial === undefined) {
      throw new TypeError("renderer node material lacks an engine anchor");
    }
    const size = nodeSizeForMaterial(nodeMaterial, view.material, morphology, calibration);
    const appearance = activeOptions.presentation?.nodes?.get(node.id);
    const baseColor = nodeColorForMaterial(tokens, nodeMaterial, view.material, node.rendered ?? null, calibration);
    const tintedColor = appearance?.tintSrgb
      ? tintRgba(baseColor, appearance.tintSrgb, SCENE_PERMILLE_SCALE)
      : baseColor;
    const attributes: RenderNodeAttributes = {
      x: anchor.x,
      y: anchor.y,
      size: appearance?.radiusPx ?? (appearance ? (size * appearance.corePermille) / SCENE_PERMILLE_SCALE : size),
      color: appearance ? mixTowardField(tintedColor, fieldColor, appearance.opacityPermille) : baseColor,
      haloRadiusPx: (materialIncludes(view.material.node, "halo") ? nodeMaterial.haloRadiusPx : size)
        * (appearance ? appearance.haloPermille / SCENE_PERMILLE_SCALE : 1),
      haloIntensityPermille: materialIncludes(view.material.node, "halo") ? nodeMaterial.haloIntensityPermille : 0,
      label: "",
      labelText: activeOptions.presentation?.nativeLabels === false
        ? ""
        : materialIncludes(view.material.node, "label") ? node.visual.role : "",
      labelPriority: labelPriority(nodeMaterial.prominencePermille),
      labelColor: tokenColor(requiredToken(tokens, "text"), calibration.labels.nodeLabelOpacityPermille, calibration),
      zIndex: node.visual.label_priority,
    };
    const resolvedNode = nodeAttributesForVisualState(attributes, node.id, visualState, calibration);
    const emphasized = activeOptions.presentation?.emphasisIds;
    sigmaGraph.addNode(node.id, emphasized && !emphasized.has(node.id) ? {
      ...resolvedNode,
      color: mixTowardField(resolvedNode.color, fieldColor, calibration.selection.focusDimFactorPermille),
      haloIntensityPermille: Math.round(
        (resolvedNode.haloIntensityPermille * calibration.selection.focusDimFactorPermille) / SCENE_PERMILLE_SCALE,
      ),
    } : resolvedNode);
    // "D082-A-PERF BEGIN"
    if (sliceDue()) yield progress('nodes', 0, 0);
    // "D082-A-PERF END"
  }
  // "D082-A-PERF BEGIN"
  yield progress('nodes', 0, 0);
  // "D082-A-PERF END"
  // Pass the shared endpoint degree grammar to the Sigma filament.
  const neuralDegree = new Map<string, number>();
  for (const edge of engineGraph.edges) {
    neuralDegree.set(edge.source, (neuralDegree.get(edge.source) ?? 0) + 1);
    neuralDegree.set(edge.target, (neuralDegree.get(edge.target) ?? 0) + 1);
  }
  // "D082-A-PERF BEGIN"
  const preparedEdges = new Map<string, { filament: FilamentGeometry;
    propagation: FilamentPropagation; attributes: RenderEdgeAttributes }>();
  let edgesLoaded = 0;
  for (const [pass, edges] of [mainEdges, secondaryEdges].entries()) {
    for (const edge of edges) {
  // "D082-A-PERF END"
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
      const propagationRecord: FilamentPropagation = {
        position: state.position,
        length,
        arcPosition,
        continuous: state.continuous,
        endpointExpressed: state.endpointExpressed,
      };
      const attributes: RenderEdgeAttributes = {
        size: edgeWidthForMaterial(edgeMaterial, view.material, calibration),
        pickTolerancePx: calibration.filament.pickTolerancePx,
        widthStart: edgeMaterial.widthStartPermille / materialScale,
        widthEnd: edgeMaterial.widthEndPermille / materialScale,
        junctionStart: edgeMaterial.junctionStartPermille / materialScale,
        junctionEnd: edgeMaterial.junctionEndPermille / materialScale,
        wobblePhase: (edgeMaterial.phasePermille / materialScale) * Math.PI * 2,
        hotCore: edgeMaterial.hotCorePermille / materialScale,
        neuralRootRatios: [neuralRootRatio(neuralDegree.get(edge.source) ?? 1),
          neuralRootRatio(neuralDegree.get(edge.target) ?? 1)],
        // D084-W2-NEURAL-R3 BEGIN
        neuralBodyScales: activeOptions.morphology === "neural"
          ? [neuralEndpointBodyScale(neuralDegree.get(edge.source) ?? 0),
            neuralEndpointBodyScale(neuralDegree.get(edge.target) ?? 0)]
          : [1, 1],
        // D084-W2-NEURAL-R3 END
        // "D082-A-NCOMPLETA3 BEGIN"
        // "D082-A-VEIL2 BEGIN: keep non-Neural edge records identical to A-INT12"
        ...((activeOptions.morphology === "neural")
          ? { neuralDenseFactor: activeOptions.presentation?.edges?.get(edge.id)?.neuralDenseFactor ?? 1 }
          : {}),
        // "D082-A-VEIL2 END"
        // "D082-A-NCOMPLETA3 END"
        color: edgeColorForMaterial(tokens, edgeMaterial, calibration),
        type: "filament",
        curvature,
        propagationArcPosition: arcPosition,
        propagationContinuous: state.continuous ? 1 : 0,
        afterglowDecayPermille: calibration.motion.afterglowDecayPermille,
        label: "",
        labelText: activeOptions.presentation?.nativeLabels === false ? "" : edge.kind,
        forceLabel: false,
        labelColor: requiredTokenColor(tokenColors, "textMuted"),
        zIndex: edge.visual.label_priority,
      };
      const resolvedEdge = edgeAttributesForVisualState(attributes, edge.id, visualState, calibration);
      const emphasized = activeOptions.presentation?.emphasisIds;
      preparedEdges.set(edge.id, { filament, propagation: propagationRecord, attributes:
        emphasized && (!emphasized.has(edge.source) || !emphasized.has(edge.target)) ? {
          ...resolvedEdge,
          color: mixTowardField(resolvedEdge.color, fieldColor, calibration.selection.focusDimFactorPermille),
        } : resolvedEdge });
      edgesLoaded++;
      // "D082-A-PERF BEGIN"
      if (sliceDue()) yield progress(pass === 0 ? 'mainEdges' : 'allEdges',
        Math.min(edgesLoaded, mainEdges.length), edgesLoaded);
      // "D082-A-PERF END"
    }
    if (pass === 0) yield progress('mainEdges', mainEdges.length, edgesLoaded);
  }
  // "D082-A-PERF BEGIN"
  yield progress('allEdges', mainEdges.length, edgesLoaded);
  for (const edge of engineGraph.edges) {
    const prepared = preparedEdges.get(edge.id)!;
    filaments.set(edge.id, prepared.filament);
    propagation.set(edge.id, prepared.propagation);
    sigmaGraph.addEdgeWithKey(edge.id, edge.source, edge.target, prepared.attributes);
    if (sliceDue()) yield progress('allEdges', mainEdges.length, edgesLoaded);
  }
  // "D082-A-PERF END"
  // "D082-A-PERF BEGIN"
  if (renderDebugAssertionsEnabled()) assertEngineAccessTrace(engineAccessTrace);
  // "D082-A-PERF END"
  return { graph: sigmaGraph, anchors, windows: organization.windows, organization, tokens, tokenColors, fieldColor, lodBand: view.band, material: view.material, filamentMaterial: filamentUniformMaterial, filaments, propagation, engineAccessTrace };
}

/** This applies VisualState's active view settings and leaves elapsed runtime settings unchanged. */
export function renderOptionsForVisualState(options: RenderOptions, state: VisualState): RenderOptions {
  // hueAnchorDegrees is dropped from the carried-over options before it is (conditionally)
  // reapplied below, so a caller's own stale value can never survive alongside a state that carries
  // none of its own -- the field always reflects `state`, exactly like the other overridden fields.
  const { hueAnchorDegrees: _carriedHueAnchorDegrees, ...carriedOptions } = options;
  const resolved: RenderOptions = {
    ...carriedOptions,
    morphology: state.morphology,
    organization: state.organization,
    palette: state.palette,
    temperature: state.temperature,
    theme: state.theme,
    lodBand: state.lodBand,
    reducedMotion: state.reducedMotion,
  };
  // hueAnchorDegrees is optional on both VisualState and RenderOptions; under exactOptionalPropertyTypes
  // an explicit `undefined` is not the same as an absent key, so it is set only when the state
  // actually carries one -- mirroring how VisualState's own constructor treats the same field.
  return state.hueAnchorDegrees === undefined ? resolved : { ...resolved, hueAnchorDegrees: state.hueAnchorDegrees };
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
  const focusedNodeEdges = state.focusedId !== null && model.graph.hasNode(state.focusedId)
    ? new Set(model.graph.edges(state.focusedId)) : null;
  if (focusedNodeEdges !== null) {
    for (const edgeId of focusedNodeEdges) {
      relevant.add(edgeId);
    }
  }
  const candidateIds = model.lodBand === "meso"
    ? relevant
    : relevant.size > 0 ? relevant : new Set(model.graph.edges());
  return [...candidateIds].map((id) => {
    const attributes = model.graph.getEdgeAttributes(id);
    const selected = id === selectedRelation;
    const focused = id === focusedRelation || (focusedNodeEdges?.has(id) ?? false);
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
  // "D082-A-PERF BEGIN"
  return memoizedContrastToken(token, background, calibration, uncachedMinimumNodeContrastToken);
}

function uncachedMinimumNodeContrastToken(
  token: OklchToken,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  // "D082-A-PERF END"
  const scale = permilleScale(calibration);
  const minimumContrast = calibration.luminance.minimumNodeContrastPermille / scale;
  const backgroundLuminance = separationLuminance(background);
  let candidate = token;
  while (
    (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast)
    && candidate.lightnessPermille < scale
  ) {
    candidate = { ...candidate, lightnessPermille: candidate.lightnessPermille + 1 };
  }
  if (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast) {
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
function permilleScale(_calibration: CalibrationProfile): number {
  // Was `calibration.morphology.stellar.opacityPermille`, which happens to hold the permille base
  // and is therefore the right value for entirely the wrong reason: restyling a morphology's
  // opacity would silently move the base every permille quantity in this file is expressed
  // against. The scale is a representation unit, not a tuneable one, and now reads as one.
  return SCENE_PERMILLE_SCALE;
}

/** This turns elapsed time into calibrated path distance and does not schedule continuous movement. */
function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / permilleScale(calibration);
}

/** This normalises travelled distance to the sampled arc and does not use vertex index spacing. */
function normalisedPropagationPosition(travelledDistance: number, length: number): number {
  return length === 0 ? 1 : Math.max(0, Math.min(travelledDistance / length, 1));
}

// ---------------------------------------------------------------- typed projection labels

/** One projected label anchor of a typed projection: policy metadata from the style bridge plus
 * the renderer's live screen position and footprint radius. */
export type ProjectionLabelCandidate = {
  readonly id: string;
  /** The short (page-truncated) display label; `full` stays in the tooltip, as the product pass. */
  readonly text: string;
  readonly full: string;
  readonly reason: LabelReason;
  readonly tier1: boolean;
  readonly priority: number;
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
};

export type ProjectionLabelOverlayInput = {
  readonly candidates: readonly ProjectionLabelCandidate[];
  readonly bounds: ViewportRect;
  /** Every drawn node, including nodes without a label candidate. */
  readonly discs?: readonly LabelDisc[];
  /** Visible aggregate outlines, in viewport coordinates. */
  readonly rims?: readonly LabelRim[];
  /** Resolved palette text colour for names and their attachment lines. */
  readonly textColor?: string;
  /** The density label allowance; absent keeps the absolute product ceiling. */
  readonly budget?: number;
};

/** The empty viewport rectangle, used to idle the shared label overlay without a measured host. */
export const EMPTY_LABEL_BOUNDS: ViewportRect = { left: 0, top: 0, width: 0, height: 0 };

/** The product label DOM styling, shared by the typed mounts in both dimensions. */
export type ProjectionLabelOverlay = {
  /** One full placement pass: ellipsize, disambiguate, place against discs and budget, repaint. */
  update(input: ProjectionLabelOverlayInput): number;
  readCount(): number;
  readLabelIds(): readonly string[];
  destroy(): void;
};

const PROJECTION_LABEL_FONT_PX = TYPED_LABEL_DOM.fontPx;
const PROJECTION_LABEL_LINE_PX = TYPED_LABEL_DOM.linePx;
const PROJECTION_LABEL_TEXT = "#e8e8e8";
const PROJECTION_LABEL_EMPHASIS = "#ffffff";
/** One lazily created measure surface per document; tests without a DOM use the text estimator. */
let projectionLabelMeasureContext: CanvasRenderingContext2D | null | undefined;
function projectionLabelMeasure(): CanvasRenderingContext2D | null {
  if (projectionLabelMeasureContext !== undefined) return projectionLabelMeasureContext;
  projectionLabelMeasureContext = typeof document === "undefined"
    ? null
    : document.createElement("canvas").getContext("2d");
  return projectionLabelMeasureContext;
}

/** Mounts the product label DOM layer over one renderer host. No timers: it repaints only when
 * the host calls `update`, so an idle page draws nothing and schedules nothing. */
export function mountProjectionLabelOverlay(host: HTMLElement): ProjectionLabelOverlay {
  const layer = document.createElement("div");
  layer.dataset.projectionLabels = "true";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  host.append(layer);
  let placedIds: readonly string[] = [];
  const singleLineWidth = (text: string): number => {
    const context = projectionLabelMeasure();
    if (context) context.font = `${PROJECTION_LABEL_FONT_PX}px Arial`;
    return text.split(/\s+/)
      .reduce((sum, word) => sum
        + (context?.measureText(word).width ?? word.length * PROJECTION_LABEL_FONT_PX * TYPED_LABEL_DOM.widthFactor)
        + TYPED_LABEL_DOM.wordPadPx, 0);
  };
  const measured = (text: string, maxWidth: number, maxLines: number) => {
    const context = projectionLabelMeasure();
    if (context) context.font = `${PROJECTION_LABEL_FONT_PX}px Arial`;
    const words = text.split(/\s+/);
    let lines = 1;
    let width = 0;
    let current = 0;
    for (const word of words) {
      const wordWidth = (context?.measureText(word).width
        ?? word.length * PROJECTION_LABEL_FONT_PX * TYPED_LABEL_DOM.widthFactor) + TYPED_LABEL_DOM.wordPadPx;
      if (current + wordWidth > maxWidth && current > 0 && lines < maxLines) {
        width = Math.max(width, current);
        current = 0;
        lines++;
      }
      current += wordWidth;
    }
    width = Math.min(maxWidth, Math.max(width, current));
    return { width: Math.max(TYPED_LABEL_DOM.minWidthPx, width + TYPED_LABEL_DOM.boxPadPx),
      height: lines * PROJECTION_LABEL_LINE_PX + PROJECTION_LABEL_LINE_PX / 2 };
  };
  const elementFor = (label: PlacedLabel, full: string): HTMLDivElement => {
    const element = document.createElement("div");
    element.dataset.projectionLabelId = label.id;
    if (full.length > 0) element.title = full;
    Object.assign(element.style, {
      position: "absolute",
      left: `${label.rect.left}px`,
      top: `${label.rect.top}px`,
      width: `${label.rect.width}px`,
      height: `${label.rect.height}px`,
      boxSizing: "border-box",
      padding: "4px 6px",
      font: `${PROJECTION_LABEL_FONT_PX}px/${PROJECTION_LABEL_LINE_PX}px Arial`,
      color: label.reason === "selected" ? PROJECTION_LABEL_EMPHASIS
        : label.reason === "hover" ? PROJECTION_LABEL_EMPHASIS : PROJECTION_LABEL_TEXT,
      background: label.reason === "hover" || label.reason === "selected" ? "rgba(10,10,10,.94)" : "rgba(10,10,10,.72)",
      textShadow: "0 0 2px #000, 0 1px 2px #000",
      borderRadius: "3px",
      whiteSpace: "normal",
      overflow: "hidden",
    });
    const lines = Math.max(1, Math.round((label.rect.height - PROJECTION_LABEL_LINE_PX / 2) / PROJECTION_LABEL_LINE_PX));
    const text = document.createElement("span");
    text.textContent = label.text;
    text.style.setProperty("display", "-webkit-box");
    text.style.setProperty("-webkit-box-orient", "vertical");
    text.style.setProperty("-webkit-line-clamp", String(lines));
    text.style.setProperty("overflow", "hidden");
    element.append(text);
    return element;
  };
  return {
    update(input): number {
      const fullText = new Map(input.candidates.map(candidate => [candidate.id, candidate.full]));
      // The placed candidate carries the policy's own fields only: `full` (a boolean flag on the
      // placement type) is never set here — the complete title stays in the tooltip map above.
      const marked: LabelCandidate[] = input.candidates.map(candidate => ({
        id: candidate.id,
        text: shortLabelWithEllipsis({
          short: candidate.text,
          full: candidate.full.length > 0 ? candidate.full : candidate.text,
          maxWidth: TYPED_LABEL_DOM.maxWidthPx,
          measure: singleLineWidth,
        }),
        reason: candidate.reason,
        x: candidate.x,
        y: candidate.y,
        priority: candidate.priority,
        ...(candidate.tier1 ? { tier1: true } : {}),
        ...(candidate.radiusPx > 0 ? { radius: candidate.radiusPx } : {}),
      }));
      const discs: readonly LabelDisc[] = input.discs ?? input.candidates.map(candidate =>
        footprintDisc({ id: candidate.id, x: candidate.x, y: candidate.y, coreRadiusPx: candidate.radiusPx }));
      const placed = placeLabels(
        disambiguateLabels(marked),
        input.bounds,
        measured,
        [],
        input.budget ?? LABEL_BUDGET,
        discs,
        input.rims ?? [],
      );
      placedIds = placed.map(label => label.id);
      const leaders = placed.filter(label => label.leader !== undefined);
      const lines = leaders.length > 0 ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
      if (lines) {
        Object.assign(lines.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", overflow: "hidden" });
        lines.setAttribute("viewBox", `0 0 ${input.bounds.width} ${input.bounds.height}`);
        lines.dataset.projectionLabelLeaders = "true";
        for (const label of leaders) {
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", String(label.leader!.from.x));
          line.setAttribute("y1", String(label.leader!.from.y));
          line.setAttribute("x2", String(label.leader!.to.x));
          line.setAttribute("y2", String(label.leader!.to.y));
          line.setAttribute("stroke", input.textColor ?? PROJECTION_LABEL_TEXT);
          line.setAttribute("stroke-width", "1");
          line.setAttribute("stroke-opacity", "0.7");
          lines.append(line);
        }
      }
      const elements = placed.map(label => {
        const element = elementFor(label, fullText.get(label.id) ?? "");
        if (input.textColor) element.style.color = input.textColor;
        return element;
      });
      layer.replaceChildren(...(lines ? [lines] : []), ...elements);
      return placed.length;
    },
    readCount: () => placedIds.length,
    readLabelIds: () => placedIds,
    destroy(): void {
      layer.remove();
      placedIds = [];
    },
  };
}
