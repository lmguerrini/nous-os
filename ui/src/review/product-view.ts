import { createVisualState } from "../engine/visual-state.ts";
import type { VisualStateCamera } from "../engine/visual-state.ts";
import type { Coordinates } from "../engine/contract.ts";
import type { GraphRendererHandle } from "../engine/renderer-handle.ts";
import { DEFAULT_CALIBRATION } from "../engine/calibration.ts";
import { SCENE_PERMILLE_SCALE } from "../scene/contract.ts";
import { mount as mount2d } from "../render2d/index.ts";
import type { RenderHandle } from "../render2d/index.ts";
import { mount as mount3d } from "../render3f/mount.tsx";
import type { Render3fRendererHandle } from "../render3f/mount.tsx";
import { framingSpherePoints, framingVolumePoints, solveFraming } from "./framing.ts";
import { framingShellRingPoints } from "./framing-shell.ts";
import { adaptReviewExport, restrictAnchors, subgraph } from "./product-adapter.ts";
import { placeDynamic } from "./live-placement.ts";
import { relaxDepth } from "./depth.ts";
import { LABEL_BUDGET, disambiguateLabels, footprintDisc, labelCandidateKind, occludedAnchors, placeLabels, shortLabelWithEllipsis } from "./labels.ts";
import type { DepthSample, LabelRim } from "./labels.ts";
import { encodingOf, SEMANTIC_COLOUR, standingOf } from "./presentation.ts";
import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";
import type { MorphologyInput } from "../engine/morphology-geometry.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { PALETTES, hexRgb, v2CategoryColour } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
import { relationClass, relationVisible } from "./reading.ts";
import type { ReviewEdge } from "./model.ts";
import { indraArcPresentation } from "./v2-relations.ts";
import { v2Encoding } from "./v2-adapter.ts";
import type { ReviewCameraState } from "../render3f/camera.tsx";
import { defaultObliqueOrbit, resolvedNodeBounds } from "../render3f/camera.tsx";
import { buildContainerGeometry } from "../engine/container-geometry.ts";
import type { MorphologyContainerPath } from "../engine/container-geometry.ts";
import { containerSphereLOD, containerTitleFont, placeContainerTitles, projectedWorldScale } from "../render-common/container-canvas.ts";
import type { CanvasDisc } from "../render-common/container-canvas.ts";
import { MORPHOLOGY_CONTRACT, stellarIndra3dNodeRadiusPx } from "../engine/morphology-contract.ts";
import { drawFlowLayer } from "../render-common/morphology-canvas.ts";
import type { DistinctSubsetUpdate, MorphologyCanvasStyle } from "../render-common/morphology-canvas.ts";
import type { Axes, CreateProductView, Insets, LabelWitness, ViewportRect, VisibleSubsetUpdate } from "./view-contract.ts";
import { NATURAL_ORGANIZATION } from "./view-contract.ts";
import {
  CAMERA_STILLNESS_MS,
  MovingLabelPassSchedule,
  QualityGovernor,
  ScheduleMarks,
  cameraWatchShouldRun,
  movingLabelPassHasCandidates,
  occlusionSampleCap,
  capOcclusionSamples,
  perspectiveSizeScale,
  renderPixelScale,
  resolutionApplyPlan,
  rgbFromUnit,
} from "./render-schedule.ts";
import type { RenderQuality } from "./render-schedule.ts";
import type {
  Dimension, NaturalArrangement, PickResult, ProjectionResult, RenderVisibility, SemanticEdge, SemanticGraphSnapshot,
  StyledProjection, VisualRelation,
} from "../projection/contract-types.ts";
import { resolveNaturalArrangement } from "../projection/natural-bridge.ts";
import { validatePickResult, validateRenderVisibility, validateSemanticEdgeCarriers } from "../projection/contract.ts";
import { structuralVisualPresentation } from "../engine/presentation-options.ts";
import type { StructuralVisualPresentation } from "../engine/presentation-options.ts";
import {
  classifyEdgeCategory,
  flowAnimatedEdgeCount,
  flowAnimates,
  flowLayerFrameDue,
  flowLayerResumeAlpha,
  flowLayerShouldRun,
  claimFlowMotion,
  ownsFlowMotion,
  releaseFlowMotion,
  setFlowNow,
} from "#render-common/flow.ts";

/** The opt-in product input keeps source edges and B9 visual IDs in separate collections. */
export type ProductProjectionInput = Readonly<{
  styled: StyledProjection;
  visibility: RenderVisibility;
  semanticEdges: readonly SemanticEdge[];
  visualRelations: readonly VisualRelation[];
  structuralPresentation: ReadonlyMap<string, StructuralVisualPresentation>;
}>;

/** A renderer adapter consumes the frozen result and mask without a ReviewEdge conversion. */
export type ProductProjectionRenderer = {
  readonly dimension: Dimension;
  mount(input: ProductProjectionInput): void;
  updateVisibleSubset(input: ProductProjectionInput): void;
  pickAt(position: Readonly<{ x: number; y: number }>): PickResult | null;
  destroy(): void;
};

function pickVisible(pick: PickResult, visibility: RenderVisibility): boolean {
  switch (pick.kind) {
    case "node": return visibility.nodeIds.has(pick.id);
    case "semantic-edge": return visibility.semanticEdgeIds.has(pick.id);
    case "visual-relation": return visibility.visualRelationIds.has(pick.visualId);
    case "container": return visibility.containerIds.has(pick.visualId);
    case "curve": return visibility.curveIds.has(pick.visualId);
    case "field": return visibility.fieldIds.has(pick.visualId);
  }
}

function assertProductProjectionDimension(dimension: Dimension, result: ProjectionResult): void {
  if (result.coordinateState.kind === "no-coordinates") {
    if (result.positions2 || result.positions3) throw new Error("refused projection has coordinates");
  } else if (dimension === "2d" ? !result.positions2 || !!result.positions3
    : !result.positions3 || !!result.positions2) {
    throw new Error("projection dimension mismatch");
  }
}

export function prepareProductProjection(
  styled: StyledProjection, visibility: RenderVisibility, snapshot: SemanticGraphSnapshot,
): ProductProjectionInput {
  const result: ProjectionResult = styled.projection;
  if (result.determinism.snapshotDigest !== snapshot.digest || result.fullLedger.snapshotDigest !== snapshot.digest ||
      result.fullLedger.canonicalBytesDigest !== snapshot.rawLedger.canonicalBytesDigest)
    throw new Error("projection source ledger mismatch");
  validateRenderVisibility(result, visibility, snapshot);
  const sourceEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  if (sourceEdges.size !== snapshot.edges.length) throw new Error("duplicate source edge ID");
  const sourceIds = new Set([...snapshot.nodes.map(node => node.id), ...sourceEdges.keys()]);
  const semanticEdges = result.domainEdgeIds.map(id => {
    const edge = sourceEdges.get(id);
    if (!edge) throw new Error(`unknown source edge ${id}`);
    return edge;
  });
  validateSemanticEdgeCarriers(semanticEdges, result, snapshot);
  const visualIds = new Set<string>();
  const structuralPresentation = new Map<string, StructuralVisualPresentation>();
  for (const relation of result.visualRelations) {
    if (!relation.visualId.startsWith("visual:") || sourceIds.has(relation.visualId) ||
        visualIds.has(relation.visualId) || relation.semantic !== false ||
        !result.domainNodeIds.includes(relation.source) || !result.domainNodeIds.includes(relation.target) ||
        new Set(relation.underlyingEdgeIds).size !== relation.underlyingEdgeIds.length ||
        relation.underlyingEdgeIds.some(id => !sourceEdges.has(id)) ||
        (relation.kind === "lifted-route" && relation.underlyingEdgeIds.length === 0))
      throw new Error(`invalid visual relation ${relation.visualId}`);
    visualIds.add(relation.visualId);
    structuralPresentation.set(relation.visualId, structuralVisualPresentation(relation));
  }
  return { styled, visibility, semanticEdges, visualRelations: result.visualRelations, structuralPresentation };
}

/** B8 can opt in here; createProductView below remains the current page path. */
export function mountProductProjection(
  dimension: Dimension, styled: StyledProjection, visibility: RenderVisibility,
  snapshot: SemanticGraphSnapshot,
  renderers: Readonly<Record<Dimension, () => ProductProjectionRenderer>>,
): Readonly<{ updateVisibleSubset(styled: StyledProjection, visibility: RenderVisibility,
  snapshot: SemanticGraphSnapshot): void;
  pickAt(position: Readonly<{ x: number; y: number }>): PickResult | null; destroy(): void }> {
  assertProductProjectionDimension(dimension, styled.projection);
  const initial = prepareProductProjection(styled, visibility, snapshot);
  const renderer = renderers[dimension]();
  if (renderer.dimension !== dimension) throw new Error("projection renderer dimension mismatch");
  renderer.mount(initial);
  let disposed = false;
  let current = initial;
  return {
    updateVisibleSubset(nextStyled, nextVisibility, nextSnapshot) {
      if (disposed) throw new Error("projection renderer destroyed");
      assertProductProjectionDimension(dimension, nextStyled.projection);
      const next = prepareProductProjection(nextStyled, nextVisibility, nextSnapshot);
      renderer.updateVisibleSubset(next);
      current = next;
    },
    pickAt(position) {
      if (disposed) return null;
      const pick = renderer.pickAt(position);
      if (!pick) return null;
      validatePickResult(current.styled.projection, pick);
      return pickVisible(pick, current.visibility) ? pick : null;
    },
    destroy() { if (!disposed) { disposed = true; renderer.destroy(); } },
  };
}

/** On-screen radius of an Indra container's own marker; the container ring carries the node. */
const INDRA_CONTAINER_MARKER_PX = 2.5;

/** One offscreen measuring canvas owned by this module (never a per-renderer context, which would
 * pin a dead renderer's canvas after teardown). Both measuring fonts — container titles and node
 * labels — live on it; every measure sets its font before reading, so sharing is invisible. */
let measureCanvas: HTMLCanvasElement | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas.getContext("2d");
}

/** Title width at the font its level draws with, on the shared measuring canvas. A stable
 * module-level identity: the title-layout memo (keyed by measure identity) then hits for every
 * pass of every view of the page session instead of once per pass. */
const titleMeasure = (text: string, level: number): number => {
  const context = measureContext();
  if (!context) return [...text].length * 6.5;
  context.font = containerTitleFont(level);
  return context.measureText(text).width;
};

const options = {
  palette: "monochrome" as const,
  temperature: "balanced" as const,
  theme: "dark" as const,
  lodBand: "micro" as const,
  reducedMotion: true,
  elapsedMilliseconds: 0,
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const anchorBaseline = new Map<string, {
  flat: ReadonlyMap<string, Coordinates>; indra: ReadonlyMap<string, Coordinates>;
  depth: ReadonlyMap<string, Coordinates>;
}>();
/** Mount the product renderers while preserving camera and label state across axis changes. */
/** Pointer travel (CSS px) beyond which a press-and-release is a drag, not a click. */
const CLICK_DRAG_TOLERANCE_PX = 5;

// Views overlap during a page refresh. Each one owns its shadow so retiring an older view
// cannot restore the browser descriptor over the new view's live resolution getter.
const devicePixelRatioShadows: Array<{ get: () => number }> = [];
let originalDevicePixelRatioDescriptor: PropertyDescriptor | undefined;
let nativeDevicePixelRatio: number | undefined;

export function installDevicePixelRatioShadow(get: () => number): () => void {
  if (devicePixelRatioShadows.length === 0) {
    originalDevicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    nativeDevicePixelRatio = window.devicePixelRatio;
  }
  const entry = { get };
  devicePixelRatioShadows.push(entry);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get });
  return () => {
    const index = devicePixelRatioShadows.indexOf(entry);
    if (index < 0) return;
    devicePixelRatioShadows.splice(index, 1);
    const top = devicePixelRatioShadows.at(-1);
    if (top) Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: top.get });
    else {
      if (originalDevicePixelRatioDescriptor) Object.defineProperty(window, "devicePixelRatio", originalDevicePixelRatioDescriptor);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
      originalDevicePixelRatioDescriptor = undefined;
      nativeDevicePixelRatio = undefined;
    }
  };
}

/** A camera every renderer accepts: finite centre and a finite, positive zoom or dolly. */
function validCamera(camera: VisualStateCamera | undefined | null): camera is VisualStateCamera {
  return !!camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio)
    && camera.ratio > 0;
}

function finitePoint(point: Coordinates): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/**
 * D-073 C6: the arrangement a live view resolved, or null for Indra. Natural's explicit arrangement
 * — never the current style — decides both placement carryover and camera carryover, so one function
 * names both: a producer that never resolved one selects its morphology's creation-time default
 * here, exactly the once-only rule the saved-view reader applies at read time.
 */
export function resolvedViewArrangement(axes: Axes): NaturalArrangement | null {
  return axes.organization === "indra" ? null : resolveNaturalArrangement(axes.morphology, axes.arrangement);
}

/** D-073 C6: the arrangement-qualified camera key plus the pre-arrangement key it replaces. */
export type ProductCameraKey = Readonly<{
  /** `${projection}/natural/${arrangement}` for Natural, `${projection}/indra` for Indra. */
  readonly key: string;
  /** The D-072 form `${projection}/${organization}`: Indra's own key, Natural's replay source. */
  readonly legacyKey: string;
  /** True only for Natural, whose legacy key can still hold a camera the new key never met. */
  readonly replaysLegacy: boolean;
}>;

/**
 * D-073 C6: the product camera key. D-072 keyed the camera by projection and organization alone, so
 * every Natural arrangement shared one entry; with the arrangement explicit the key is qualified by
 * the resolved arrangement, and camera carryover follows arrangement continuity, never the currently
 * selected morphology. The legacy spelling stays as the replay source, so a camera recorded before
 * the arrangement axis existed still replays instead of being silently dropped.
 */
export function productCameraKey(axes: Axes): ProductCameraKey {
  if (axes.organization === "indra") {
    const key = `${axes.projection}/indra`;
    return { key, legacyKey: key, replaysLegacy: false };
  }
  return {
    key: `${axes.projection}/${NATURAL_ORGANIZATION}/${resolveNaturalArrangement(axes.morphology, axes.arrangement)}`,
    legacyKey: `${axes.projection}/${axes.organization}`,
    replaysLegacy: true,
  };
}

/**
 * D-073 C6: reads the camera for the current key, replaying the legacy entry under the new key when
 * only that exists — an old camera recorded before the arrangement axis replays under the new key
 * and is promoted there, so later lookups read the new key directly and a save cannot fork the two.
 * The mounted fit ratio the label tiers read replays with it. These are the view's own maps and
 * nothing else; no renderer state is touched.
 */
export function replayProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
): VisualStateCamera | undefined {
  const saved = cameras.get(keys.key);
  if (saved !== undefined) return saved;
  if (!keys.replaysLegacy) return undefined;
  const legacy = cameras.get(keys.legacyKey);
  if (legacy === undefined) return undefined;
  cameras.set(keys.key, legacy);
  const legacyRatio = fitRatio.get(keys.legacyKey);
  if (legacyRatio !== undefined && !fitRatio.has(keys.key)) fitRatio.set(keys.key, legacyRatio);
  return legacy;
}

/**
 * D-073 C6: records a camera under the current key and, for Natural, mirrors it into the legacy key,
 * so the entry an arrangement never visited stays the view's most recent Natural camera — which an
 * explicit fit or reset replaces for every later replay, never a stale pre-fit camera. An optional
 * mounted fit ratio commits the same way.
 */
export function commitProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
  camera: VisualStateCamera,
  fittedRatio?: number,
): void {
  cameras.set(keys.key, camera);
  if (fittedRatio !== undefined) fitRatio.set(keys.key, fittedRatio);
  if (keys.replaysLegacy) {
    cameras.set(keys.legacyKey, camera);
    if (fittedRatio !== undefined) fitRatio.set(keys.legacyKey, fittedRatio);
  }
}

/**
 * D-073 C6: forgets the camera of the current key together with its legacy mirror, so an explicit
 * reset refits on remount instead of replaying the very camera it deleted.
 */
export function forgetProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
): void {
  cameras.delete(keys.key);
  fitRatio.delete(keys.key);
  if (keys.replaysLegacy) {
    cameras.delete(keys.legacyKey);
    fitRatio.delete(keys.legacyKey);
  }
}

/**
 * D-073 C6: refuses an arrangement on the Indra view with the same rule the saved-view register
 * applies, so the closed axis vocabulary gains no in-memory spelling.
 */
export function assertNaturalArrangementAxis(axes: Axes): void {
  if (axes.organization === "indra" && axes.arrangement !== undefined) {
    throw new TypeError("ViewInput.axes.arrangement is only valid for the Natural view [arrangement-requires-natural]");
  }
}

/**
 * D-073 C6: whether an axes change must remount. The D-072 field comparison plus one term: a changed
 * resolved Natural arrangement changes the positions, so it remounts, while a style switch that keeps
 * the arrangement resolved restyles the same scene and the camera carries over through the map.
 */
export function productViewRemountsAxes(previous: Axes, next: Axes): boolean {
  const oldDepth = previous.organization === "flat" && previous.projection === "3d";
  const newDepth = next.organization === "flat" && next.projection === "3d";
  return previous.projection !== next.projection
    || previous.morphology !== next.morphology
    || previous.organization !== next.organization
    || previous.colour !== next.colour
    || previous.reading !== next.reading
    || oldDepth !== newDepth
    || resolvedViewArrangement(previous) !== resolvedViewArrangement(next);
}

export const createProductView: CreateProductView = async (input) => {
  // D-073 C6: the arrangement axis is Natural-only at every entry point, creation included.
  assertNaturalArrangementAxis(input.axes);
  const prepared = input.v2Prepared ?? adaptReviewExport(input.data);
  const base = (input.v2Prepared ? undefined : anchorBaseline.get(input.data.export_digest)) ?? {
    flat: prepared.flatAnchors, indra: prepared.indraAnchors,
    depth: relaxDepth(prepared.flatGraph, prepared.flatAnchors),
  };
  anchorBaseline.set(input.data.export_digest, base);
  const flatAnchors = input.v2Prepared ? base.flat : placeDynamic(base.flat, input.data);
  const indraAnchors = input.v2Prepared ? base.indra : placeDynamic(base.indra, input.data);
  const fullDepth = input.v2Prepared ? base.flat : placeDynamic(base.depth, input.data);
  const nodesById = new Map(input.data.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(input.data.edges.map((edge) => [edge.id, edge]));
  const degree = new Map<string, number>();
  for (const edge of input.data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const container = input.container;
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const layer = document.createElement("div");
  layer.dataset.reviewLabels = "true";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    zIndex: "20",
    pointerEvents: "none",
    overflow: "hidden",
  });
  let axes: Axes = { ...input.axes };
  let appearance: AppearanceOptions = input.appearance ?? DEFAULT_APPEARANCE;
  let customPalette: PaletteValues = input.customPalette ?? PALETTES.bw;
  let visible = new Set(input.visibleNodeIds);
  let insets = input.insets;
  // D-072 R2: the level-of-detail mode. When the page names the drawn edge subset it takes ownership
  // of the LOD: every node of `data` is mounted for picking and style coverage, the drawn edges are
  // `drawnEdges`, and a later band or density change lands in place through `updateVisibleSubset`
  // instead of a remount. The containers become view-local state for the same reason — an in-place
  // subset change maps new Indra containers without recreating the view.
  const lodMode = input.visibleEdgeIds !== undefined;
  const mountedIds = new Set(input.data.nodes.map((node) => node.id));
  // The edges the mounted graph itself holds (captured at mount); an in-place update only needs
  // style entries for drawn edges beyond this set.
  const mountedEdgeIds = new Set<string>();
  let layoutContainers = input.layoutContainers;
  // D-072 R2: the label allowance is view state — an in-place density change moves it with the
  // subset instead of remounting.
  let labelBudget = input.labelBudget;
  let drawnEdges: readonly ReviewEdge[];
  let drawnEdgeIds: ReadonlySet<string>;
  const readingAllows = (edge: ReviewEdge): boolean => {
    const kind = input.v2Prepared ? edge.attested_by as "attested" | "exploratory" : relationClass(edge, nodesById);
    return input.v2Prepared ? axes.reading !== "attested" || kind === "attested" : relationVisible(kind, axes.reading);
  };
  const initialDrawn = input.data.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target) && readingAllows(edge));
  drawnEdges = initialDrawn;
  drawnEdgeIds = new Set(initialDrawn.map((edge) => edge.id));
  // The latest drawing the view handed its renderers; the LOD edge hit-test reads it. Kept in step
  // by mount() and updateVisibleSubset().
  let drawnGeometry: import("../engine/morphology-geometry.ts").MorphologyGeometry | null = null;
  let committedScene: ReturnType<typeof buildDrawnScene> | null = null;
  // D-072 R2: the marker bits (glyph, radiusPx) the renderers' style maps last saw, so an
  // in-place subset change can ship only the entries that actually flipped.
  let lastNodeMarks = new Map<string, { glyph: import("../engine/presentation-options.ts").NodeGlyph | undefined; radiusPx: number | undefined }>();
  let handle: GraphRendererHandle | null = null;
  let sigma: RenderHandle | null = null;
  let three: Render3fRendererHandle | null = null;
  let selected: string | null = null;
  let emphasis: ReadonlySet<string> | null = null;
  let focusStyle: { members: ReadonlySet<string>; arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null = null;
  let hover: { kind: "node" | "edge"; id: string; x: number; y: number } | null = null;
  const morphologyInteraction: {
    hoverId: string | null; focusIds: ReadonlySet<string> | null; labelDiscs: readonly CanvasDisc[] | null; containerColor: string | null;
    /** D-072 P1a: the shared passes read both fields — "moving" makes the container/morphology
     * pass draw its reduced frame, "separate" leaves the travelling highlights to the overlay. */
    quality: RenderQuality; flowLayer: "inline" | "separate";
    dimFocus?: { members: ReadonlySet<string>; arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null;
  } = { hoverId: null, focusIds: null, labelDiscs: null, containerColor: null, quality: "full", flowLayer: "separate" };
  const redrawMorphology = () => (container.querySelector("canvas[data-morphology-canvas]") as
    (HTMLCanvasElement & { __morphRedraw?: () => void }) | null)?.__morphRedraw?.();
  let placed: LabelWitness[] = [];
  let visibleTitleCount = 0;
  let frameId = 0;
  let hoverFrame = 0;
  let movingLabelFrame = 0;
  let destroyed = false;
  let lastCamera = "";
  let cameraLabelTimer: ReturnType<typeof setTimeout> | undefined;
  let cameraLabelIdle: number | null = null;
  // D-072 P1a: the scheduled backing-store scale of the canvas layers. The view shadows
  // `window.devicePixelRatio` with a live getter for its whole lifetime: the only per-draw readers
  // of the global are the two morphology canvases (render2d and the 3D distinct overlay), so the
  // cap reaches exactly the layers it names while the GL layers keep the ratio they captured at
  // mount. Restored in destroy().
  const viewNativeDevicePixelRatio = nativeDevicePixelRatio ?? window.devicePixelRatio;
  let scheduledDevicePixelRatio = renderPixelScale("full", viewNativeDevicePixelRatio);
  const removeDevicePixelRatioShadow = installDevicePixelRatioShadow(() => scheduledDevicePixelRatio);
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  // Luminous flow animation (D-072 P1a): a dedicated overlay canvas above the morphology layer
  // repaints only the travelling highlights, at about 30 fps, pausing whenever nothing can animate
  // (hidden tab, reduced motion, controls off, no animated edge left). The main morphology canvas
  // is touched only by camera, scene and appearance changes.
  let flowMotion = input.flowMotion ?? true;
  const qualityGovernor = new QualityGovernor();
  // D-072 R3 (X9): the moving label pass runs one frame after the camera change that requested
  // it, never synchronously inside a watch tick; and the scheduling events a test reads
  // through `__d072.marks()` — quality flips, resolution applies, label passes, remounts.
  const movingLabelSchedule = new MovingLabelPassSchedule();
  const scheduleMarks = new ScheduleMarks();
  let flowCanvas: HTMLCanvasElement | null = null;
  let flowContext: CanvasRenderingContext2D | null = null;
  let flowCleared = true;
  let flowScene: {
    readonly geometry: Parameters<typeof drawFlowLayer>[1];
    readonly project: Parameters<typeof drawFlowLayer>[2];
    readonly style: MorphologyCanvasStyle;
  } | null = null;
  const flowLoop = { running: false, raf: 0, origin: null as number | null, lastFrameMs: 0, resumedAtMs: 0, frameCostMs: 0, frames: 0, windowStartMs: 0, measuredFps: 0 };
  const flowAnimatesNow = () => flowAnimates({ intensity: appearance.flowIntensity, speed: appearance.flowSpeed, motionEnabled: flowMotion, reducedMotion: input.reducedMotion });
  const ensureFlowCanvas = () => {
    if (flowCanvas) return flowCanvas;
    const canvas = document.createElement("canvas");
    canvas.dataset.flowCanvas = "true";
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "10" });
    container.append(canvas);
    flowCanvas = canvas;
    flowContext = canvas.getContext("2d");
    return canvas;
  };
  const sizeFlowCanvas = () => {
    const canvas = ensureFlowCanvas();
    const box = canvas.getBoundingClientRect();
    // D-072 R3 (X9): the flow layer sizes at the scheduled scale — motion never changes it, so a
    // resize mid-drag keeps the rest resolution instead of swapping the backing store.
    const width = Math.max(1, Math.round(box.width * scheduledDevicePixelRatio));
    const height = Math.max(1, Math.round(box.height * scheduledDevicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  };
  const clearFlowOverlay = () => {
    if (!flowCanvas || !flowContext) return;
    flowContext.setTransform(1, 0, 0, 1, 0, 0);
    flowContext.clearRect(0, 0, flowCanvas.width, flowCanvas.height);
    flowCleared = true;
  };
  const drawFlowOverlay = (now: number, force = false) => {
    if (!flowCanvas || !flowContext || !flowScene || destroyed || handle === null) return;
    // While the camera moves the overlay rests cleared: the highlights would trail one capped
    // frame behind the geometry, and the moving frame stays lighter without them.
    if (morphologyInteraction.quality === "moving") {
      if (!flowCleared) clearFlowOverlay();
      return;
    }
    const box = flowCanvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    flowContext.setTransform(flowCanvas.width / box.width, 0, 0, flowCanvas.height / box.height, 0, 0);
    flowContext.clearRect(0, 0, box.width, box.height);
    flowCleared = false;
    // A forced draw (the test hook, captures) never fades: the phase is the caller's, full alpha.
    flowContext.globalAlpha = force ? 1 : flowLayerResumeAlpha(now - flowLoop.resumedAtMs);
    drawFlowLayer(flowContext, flowScene.geometry, flowScene.project, flowScene.style, appearance, axes.projection);
    flowContext.globalAlpha = 1;
  };
  const flowTick = (now: number) => {
    flowLoop.raf = 0;
    if (destroyed || handle === null) { flowLoop.running = false; return; }
    const allowed = flowAnimatesNow();
    if (!flowLayerFrameDue(now, flowLoop.lastFrameMs)) {
      // Paused between frames: only a still-running reason may reschedule; the visibilitychange
      // listener and syncFlowLoop own resuming.
      if (allowed && !document.hidden) flowLoop.raf = requestAnimationFrame(flowTick);
      else flowLoop.running = false;
      return;
    }
    flowLoop.lastFrameMs = now;
    // One flow-clock origin for the view's whole life: pauses never reset it, so the travelling
    // heads resume exactly where they were — only the overlay fades, nothing jumps.
    if (flowLoop.origin === null) flowLoop.origin = now;
    setFlowNow(now - flowLoop.origin);
    const began = performance.now();
    drawFlowOverlay(now);
    flowLoop.frameCostMs = performance.now() - began;
    if (now - flowLoop.windowStartMs >= 1000) { flowLoop.measuredFps = flowLoop.frames; flowLoop.frames = 0; flowLoop.windowStartMs = now; }
    flowLoop.frames += 1;
    if (flowLayerShouldRun({ allowed, hidden: document.hidden, animatedEdges: flowAnimatedEdgeCount() })) flowLoop.raf = requestAnimationFrame(flowTick);
    else {
      flowLoop.running = false;
      if (!document.hidden) { clearFlowOverlay(); redrawMorphology(); }
    }
  };
  const startFlowLoop = () => {
    if (destroyed || flowLoop.running) return;
    flowLoop.running = true;
    flowLoop.resumedAtMs = performance.now();
    flowLoop.lastFrameMs = 0;
    flowLoop.raf = requestAnimationFrame(flowTick);
  };
  const stopFlowLoop = () => {
    if (flowLoop.raf) cancelAnimationFrame(flowLoop.raf);
    flowLoop.raf = 0;
    flowLoop.running = false;
  };
  const flowOwner = {};
  let flowFlag: boolean | null = null;
  const syncFlowLoop = () => {
    if (destroyed) return;
    const allowed = flowAnimatesNow();
    claimFlowMotion(flowOwner, allowed);
    if (allowed !== flowFlag) {
      // The base pass flips between the overlay-owned highlights and the static cue: repaint it
      // once so an exploratory reading never shows both or neither.
      flowFlag = allowed;
      if (!allowed) clearFlowOverlay();
      if (!destroyed && handle !== null) redrawMorphology();
    }
    if (allowed && !flowLoop.running && !document.hidden) startFlowLoop();
    else if (!allowed && flowLoop.running) { stopFlowLoop(); if (!document.hidden) redrawMorphology(); }
  };
  const onVisibilityChange = () => {
    if (document.hidden) stopFlowLoop();
    else syncFlowLoop();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const fullAnchor = (current: Axes) =>
    current.organization === "indra"
      ? indraAnchors
      : fullDepth;
  const localRect = (): ViewportRect => ({
    left: insets.left,
    top: insets.top,
    width: Math.max(1, container.clientWidth - insets.left - insets.right),
    height: Math.max(1, container.clientHeight - insets.top - insets.bottom),
  });
  const pageRect = (): ViewportRect => {
    const r = container.getBoundingClientRect();
    const local = localRect();
    return { left: r.left + local.left, top: r.top + local.top, width: local.width, height: local.height };
  };
  const graph = () => subgraph(axes.organization === "indra" ? prepared.indraGraph : prepared.flatGraph, visible);
  // D-073 C6: the camera key is arrangement-qualified for Natural (see productCameraKey). Reads go
  // through the legacy replay, writes mirror back so an explicit fit becomes the replay source, and
  // the two maps above are the only state any of this touches.
  const cameraKeys = () => productCameraKey(axes);
  const restoreSavedCamera = () => replayProductCamera(cameras, fitRatio, cameraKeys());
  const commitCamera = (camera: VisualStateCamera, fittedRatio?: number) =>
    commitProductCamera(cameras, fitRatio, cameraKeys(), camera, fittedRatio);
  // D-072 R3 (X9): the coarse tier-1 check behind the moving pass early-out. It must be cheap and
  // conservative: labels on and a Flat organization with at least one visible domain means domain
  // names may place; hover and selection are read directly. A false "candidates" only costs one
  // reduced pass; a false "no candidates" is impossible — each tier-1 source is checked.
  const movingPassCandidates = (ids: ReadonlySet<string> = visible) => movingLabelPassHasCandidates({
    hoverId: hover?.kind === "node" ? hover.id : null,
    selectedId: selected,
    flatDomains: axes.labels && axes.organization === "flat"
      && [...ids].some((id) => nodesById.get(id)?.type === "domain"),
  });
  function project(point: Coordinates) {
    return handle!.graphToViewport(point);
  }
  /** D-072 R2: in LOD mode the mounted renderers witness every disclosed node, so every consumer
   * that means "what is drawn" filters through the drawn subset. */
  const throughVisible = <T extends { id: string }>(items: readonly T[]): readonly T[] =>
    lodMode ? items.filter((item) => visible.has(item.id)) : items;
  function labelPass(preview?: { visible: ReadonlySet<string>; containers: typeof layoutContainers; budget: typeof labelBudget }) {
    if (!handle || destroyed) return;
    const labelVisible = preview?.visible ?? visible;
    const labelContainers = preview?.containers ?? layoutContainers;
    const labelBudgetNow = preview?.budget ?? labelBudget;
    const visibleWitnesses = <T extends { id: string }>(items: readonly T[]): readonly T[] =>
      lodMode ? items.filter((item) => labelVisible.has(item.id)) : items;
    // D-072 P1a: while the camera moves this pass is the reduced one — tier-1 labels only, no
    // depth-occlusion build, no trailing morphology repaint (the renderer repaints every camera
    // frame already). The full pass returns on the frame after quality is restored.
    const moving = morphologyInteraction.quality === "moving";
    const movingIndra3d = moving && three !== null && axes.organization === "indra";
    const movingIds = movingIndra3d ? new Set([selected, hover?.id].filter((id): id is string => id != null)) : undefined;
    // D-072 R3 (X9): while moving with no tier-1 candidate the reduced pass has zero output, so
    // it is skipped entirely — no anchor projection, no footprint discs, no Indra container
    // title placement, no DOM rebuild. The rest labels were dropped at motion start; this keeps
    // the layer empty through the whole drag at no cost.
    if (moving && !movingPassCandidates(labelVisible)) {
      if (placed.length > 0 || layer.childElementCount > 0) { placed = []; visibleTitleCount = 0; layer.replaceChildren(); }
      scheduleMarks.record("label-pass-skip", performance.now(), 0);
      return;
    }
    const began = performance.now();
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    container.style.backgroundColor = palette.background;
    // The palette's container role reaches the scene through the shared interaction object: the
    // morphology layer reads it on its next redraw and draws the shells with it.
    morphologyInteraction.containerColor = palette.container;
    const bounds = localRect();
    const camera = handle.readCameraState();
    const fitted = fitRatio.get(cameraKeys().key) ?? camera.ratio;
    const overview = camera.ratio >= fitted * 0.6;
    const close = camera.ratio < fitted * 0.25;
    const neighbours = emphasis ?? new Set<string>();
    const anchors = new Map(visibleWitnesses(movingIds ? three!.readWorldAnchorWitnesses(movingIds) : handle.readWorldAnchorWitnesses())
      .filter(item => !movingIndra3d || item.id === selected || item.id === hover?.id)
      .map((item) => [item.id, item.position]));
    // Depth occlusion: in 3D a label whose anchor sits behind nearer geometry is hidden. Depth is the
    // distance along the camera's view axis, so nearer geometry has a smaller depth.
    let occluded: ReadonlySet<string> = new Set<string>();
    if (three && !moving) {
      const pose = three.readReviewCameraPose();
      const viewX = pose.target[0]! - pose.position[0]!, viewY = pose.target[1]! - pose.position[1]!, viewZ = pose.target[2]! - pose.position[2]!;
      const viewLength = Math.hypot(viewX, viewY, viewZ) || 1;
      const samples: DepthSample[] = [];
      for (const [id, position] of anchors) {
        const p = project(position);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const depth = ((position.x - pose.position[0]!) * viewX + (position.y - pose.position[1]!) * viewY + (position.z - pose.position[2]!) * viewZ) / viewLength;
        samples.push({ id, x: p.x, y: p.y, depth });
      }
      // D-072 P1a hitch fix: the occlusion pass is O(n²) over what it is fed — at 425+ visible
      // anchors it alone was the 100–340 ms settle hitch. It now receives at most the nearest
      // `occlusionSampleCap(LABEL_BUDGET)` anchors by depth (the geometry that actually covers
      // others on screen); anchors beyond the cap keep their labels, which still pass the full
      // collision placement, so the no-overlap guarantee never depends on this cap.
      occluded = occludedAnchors(capOcclusionSamples(samples, occlusionSampleCap(LABEL_BUDGET)));
    }
    // One name per container: the canvas draws a container's title exactly where the shared
    // placement puts it, and the DOM label pass suppresses the same container's node label in
    // exactly those cases (and allows it otherwise), so a pearl never carries two names. The
    // interaction must be the same object state the canvas layer uses, so both agree on the LOD.
    const containerInteraction = { hoverId: morphologyInteraction.hoverId, focusIds: morphologyInteraction.focusIds, dimFocus: focusStyle };
    const pathById = new Map<string, MorphologyContainerPath>();
    if (!movingIndra3d && axes.organization === "indra" && labelContainers) {
      for (const path of buildContainerGeometry(axes.morphology, labelContainers)) pathById.set(path.id, path);
    }
    // The pearls about to be drawn, projected with their radii: every label must avoid them, not only
    // other labels. Each disc is the node's real drawn footprint (for a neural soma, its minor
    // radius — the long half-axis is not a blocking radius) plus a small clearance, grown only while
    // hovered or focused, because that is when the drawn pearl itself grows. Discs non-finite or
    // covering the whole viewport (the camera at or inside the node) block nothing: they cannot be
    // obstacles, and unbounded they once exhausted the tab. This one set is shared with the canvas
    // title pass through the interaction, so titles and labels are placed by one collision set.
    const contract = MORPHOLOGY_CONTRACT[axes.morphology];
    const footprints = visibleWitnesses(movingIds ? three!.readNodeFootprintWitnesses(movingIds) : handle.readNodeFootprintWitnesses())
      .filter(footprint => !movingIndra3d || footprint.id === selected || footprint.id === hover?.id);
    const span = Math.max(bounds.width, bounds.height);
    const discs: CanvasDisc[] = [];
    for (const footprint of footprints) {
      const { x, y } = footprint.viewportCenter;
      const core = footprint.coreRadiusPx;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(core) || !(core >= 0)) continue;
      const emphasisFactor = morphologyInteraction.hoverId === footprint.id ? contract.hover.radiusMultiplier
        : morphologyInteraction.focusIds?.has(footprint.id) ? contract.focus.radiusMultiplier : 1;
      const disc = footprintDisc({ id: footprint.id, x, y, coreRadiusPx: core }, emphasisFactor);
      if (disc.radius >= span) continue;
      discs.push(disc);
    }
    morphologyInteraction.labelDiscs = discs;
    // Titles are placed on the canvas's own rectangle (the overlay canvas spans the container), with
    // the same discs the DOM pass uses; the reserved rects below are exactly the drawn ones. The
    // width is measured with the title font itself on the shared module canvas, so a title that
    // fits the 190 px budget is never truncated by an estimate.
    const titleBounds = { width: container.clientWidth, height: container.clientHeight };
    const titlePlacements = movingIndra3d ? [] : placeContainerTitles([...pathById.values()], project, titleBounds, axes.projection, containerInteraction, discs, titleMeasure);
    visibleTitleCount = titlePlacements.length;
    const titledContainerIds = new Set(titlePlacements.map(placement => placement.id));
    const footprintRadius = new Map(footprints.map(footprint => [footprint.id, footprint.coreRadiusPx]));
    const candidates = [];
    const fullText = new Map<string, string>();
    for (const [id, position] of anchors) {
      const node = nodesById.get(id);
      if (!node) continue;
      const p = project(position);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (three && !three.isWorldPointVisible(position))) continue;
      if (p.x < bounds.left || p.y < bounds.top || p.x > bounds.left + bounds.width || p.y > bounds.top + bounds.height)
        continue;
      const chosen = selected === id;
      const hovered = hover?.kind === "node" && hover.id === id;
      // A label occluded by nearer geometry is hidden, except the selection and hover and the
      // Flat domains (tier 1: a domain name is always placed, drawn above the geometry).
      if (occluded.has(id) && !chosen && !hovered
        && !(axes.organization === "flat" && node.type === "domain")) continue;
      // A container whose canvas title is drawn carries no second name (its own node label waits).
      if (pathById.has(id) && !chosen && !hovered && titledContainerIds.has(id))
        continue;
      const kind = labelCandidateKind({ id, node, selected: chosen, hovered, labels: axes.labels,
        neighbour: neighbours.has(id), overview, close, organization: axes.organization,
        projection: axes.projection, focusMembers: focusStyle?.members ?? null, moving });
      if (!kind) continue;
      const { reason, tier1 } = kind;
      const text = input.text(id);
      fullText.set(id, text.full);
      candidates.push({
        id,
        text: input.v2Prepared ? text.short : chosen || hovered ? text.full : text.short,
        reason,
        x: hovered ? hover!.x : p.x,
        y: hovered ? hover!.y : p.y,
        priority: degree.get(id) ?? 0,
        full: !input.v2Prepared && (chosen || hovered),
        ...(tier1 ? { tier1: true } : {}),
        ...(footprintRadius.has(id) ? { radius: footprintRadius.get(id)! } : {}),
      });
    }
    // A selected container can have dozens of neighbours; name the few nearest to it so labels do not bury the
    // structure (the others keep their emphasis and are named on hover or zoom).
    const neighbourLabels = candidates.filter(item => item.reason === "neighbour");
    if (neighbourLabels.length > 16 && selected) {
      const origin = candidates.find(item => item.id === selected);
      const keep = new Set(neighbourLabels
        .map(item => ({ id: item.id, distance: origin ? Math.hypot(item.x - origin.x, item.y - origin.y) : 0 }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 16).map(item => item.id));
      for (let index = candidates.length - 1; index >= 0; index--)
        if (candidates[index]!.reason === "neighbour" && !keep.has(candidates[index]!.id)) candidates.splice(index, 1);
    }
    const context = measureContext();
    if (context) context.font = `${appearance.labelSizePx}px Arial`;
    const measured = (text: string, maxWidth: number, maxLines: number) => {
      const font = `${appearance.labelSizePx}px Arial`;
      if (context) context.font = font;
      const words = text.split(/\s+/);
      let lines = 1;
      let width = 0;
      let current = 0;
      for (const word of words) {
        const w = (context?.measureText(word).width ?? word.length * appearance.labelSizePx * 0.58) + 5;
        if (current + w > maxWidth && current > 0 && lines < maxLines) {
          width = Math.max(width, current);
          current = 0;
          lines++;
        }
        current += w;
      }
      width = Math.min(maxWidth, Math.max(width, current));
      return { width: Math.max(32, width + 12), height: lines * (appearance.labelSizePx + 4) + 8 };
    };
    const density = appearance.labelDensity / DEFAULT_APPEARANCE.labelDensity;
    const limited = density >= 1 ? candidates : candidates.filter((candidate, index) =>
      candidate.full || candidate.reason === "selected" || index < Math.round(candidates.length * density));
    // Any floating overlay that covers part of the canvas (the Aspetto panel, the axis gizmo, the
    // panel edge tab) is reserved, so labels stay fully inside the visible area not covered by
    // panels — and so do the drawn container titles: titles and node labels are placed by one
    // shared collision set.
    const reserved: ViewportRect[] = titlePlacements.map(placement => ({
      left: placement.left - 4, top: placement.top - 4, width: placement.width + 8, height: placement.height + 8,
    }));
    const rims: LabelRim[] = [];
    if (axes.organization === "indra") for (const path of pathById.values()) {
      const center = project(path.center);
      const worldRadius = axes.projection === "2d" ? path.radius2d ?? path.radius : path.radius;
      const radius = worldRadius * projectedWorldScale(path.center, worldRadius, project);
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(radius)) continue;
      if (axes.projection === "3d" && !containerSphereLOD(path.level, path.open !== false,
        morphologyInteraction.focusIds?.has(path.id) ?? false, radius)) continue;
      rims.push({ x: center.x, y: center.y, radius });
    }
    const hostRect = container.getBoundingClientRect();
    for (const overlay of [document.getElementById("appearance-panel"), document.getElementById("gizmo"), document.getElementById("panel-edge-toggle")]) {
      if (!overlay || overlay.hidden) continue;
      const rect = overlay.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      reserved.push({ left: rect.left - hostRect.left, top: rect.top - hostRect.top,
        width: rect.width, height: rect.height });
    }
    // A short label stays on one line: a page-truncated short title is marked with «…» on a word
    // boundary, a too-wide text is cut the same way, and a « · +N» count is never the part cut
    // (the full title stays in the tooltip and the panel), never a clipped word.
    const singleLineWidth = (text: string) => {
      if (context) context.font = `${appearance.labelSizePx}px Arial`;
      return text.split(/\s+/)
        .reduce((sum, word) => sum + (context?.measureText(word).width ?? word.length * appearance.labelSizePx * 0.58) + 5, 0);
    };
    const marked = limited.map(candidate => candidate.full ? candidate : {
      ...candidate,
      text: shortLabelWithEllipsis({
        short: candidate.text,
        full: input.v2Prepared ? candidate.text : fullText.get(candidate.id) ?? candidate.text,
        maxWidth: 180,
        measure: singleLineWidth,
      }),
    });
    const labelled = disambiguateLabels(marked);
    // D-072 FixA: the density's own allowance (20/40/60, L1's ViewInput.labelBudget) drives the
    // placement; the absolute LABEL_BUDGET stays only as the default for callers that say nothing.
    // D-072 R2: an in-place density change moves the allowance with the subset.
    const allowance = labelBudgetNow ?? LABEL_BUDGET;
    const next = placeLabels(labelled, bounds, measured, reserved, allowance, discs, rims);
    const rect = container.getBoundingClientRect();
    placed = next.map((label) => ({
      ...label,
      rect: {
        left: rect.left + label.rect.left,
        top: rect.top + label.rect.top,
        width: label.rect.width,
        height: label.rect.height,
      },
    }));
    layer.replaceChildren(
      ...next.map((label) => {
        const el = document.createElement("div");
        el.dataset.reviewLabelId = label.id;
        // A truncated or cut label keeps its complete title in the tooltip.
        const whole = fullText.get(label.id);
        if (whole !== undefined) el.title = whole;
        Object.assign(el.style, {
          position: "absolute",
          left: `${label.rect.left}px`,
          top: `${label.rect.top}px`,
          width: `${label.rect.width}px`,
          height: `${label.rect.height}px`,
          boxSizing: "border-box",
          padding: "4px 6px",
          font: `${appearance.labelSizePx}px/${appearance.labelSizePx + 4}px Arial`,
          color: label.reason === "selected" ? palette.selection : label.reason === "hover" ? palette.hover : palette.text,
          // A tier-1 label may sit over another node's pearl: the dark scrim plus a text halo
          // keeps its words legible there (requirement: legible above a pearl, never under its
          // own node or the panel).
          background: axes.organization === "indra" ? "transparent"
            : label.reason === "hover" || label.reason === "selected" ? "rgba(10,10,10,.94)" : "rgba(10,10,10,.72)",
          textShadow: axes.organization === "indra" ? "0 0 3px #000, 0 0 3px #000, 0 0 5px #000"
            : "0 0 2px #000, 0 1px 2px #000",
          borderRadius: "3px",
          whiteSpace: "normal",
          overflow: "hidden",
        });
        // Clamp to the lines the placement measured: a longer text ends with an ellipsis instead of showing part of
        // a line that did not fit (the full text is in the hover label and the panel). The inner element clips at its
        // own content edge; the outer box would clip only at its padding edge and let the next line peek through.
        const lines = Math.max(1, Math.round((label.rect.height - 8) / (appearance.labelSizePx + 4)));
        const text = document.createElement("span");
        text.textContent = label.text;
        text.style.setProperty("display", "-webkit-box");
        text.style.setProperty("-webkit-box-orient", "vertical");
        text.style.setProperty("-webkit-line-clamp", String(lines));
        text.style.setProperty("overflow", "hidden");
        text.style.setProperty("max-height", `${lines * (appearance.labelSizePx + 4)}px`);
        el.append(text);
        return el;
      }),
    );
    for (const { id, position } of movingIndra3d ? [] : handle.readWorldAnchorWitnesses()) {
      if (nodesById.get(id)?.origin !== "dynamic") continue;
      const point = project(position);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const ring = document.createElement("span");
      ring.dataset.dynamicRingId = id;
      Object.assign(ring.style, { position: "absolute", left: `${point.x - 8}px`, top: `${point.y - 8}px`,
        width: "16px", height: "16px", border: "1px solid #b9b9b9", borderRadius: "50%", opacity: "0.68" });
      layer.append(ring);
    }
    if (axes.colour === "custom") {
      const anchors = new Map(visibleWitnesses(handle.readWorldAnchorWitnesses()).map((item) => [item.id, item.position]));
      for (const [id, colour] of [[selected, palette.selection], [hover?.kind === "node" ? hover.id : null, palette.hover]] as const) {
        const position = id ? anchors.get(id) : null;
        if (!position) continue;
        const point = project(position);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const marker = document.createElement("span");
        marker.dataset.reviewMarkerId = id!;
        Object.assign(marker.style, { position: "absolute", left: `${point.x - 12}px`, top: `${point.y - 12}px`,
          width: "24px", height: "24px", border: `2px solid ${colour}`, borderRadius: "50%" });
        layer.append(marker);
      }
    }
    // The shared discs this pass just published feed the canvas title placement: repaint the
    // morphology layer even when no animation loop is running (reduced motion), so the ink and
    // the reserved rectangles can never sit at two different placements. While the camera moves
    // the renderer's own repaint consumes the fresh discs; no extra pass is scheduled here.
    if (!moving) redrawMorphology();
    scheduleMarks.record(moving ? "label-pass-moving" : "label-pass-full", began, performance.now() - began);
  }
  // D-072 P1a: no polling at rest. The camera watch loop runs only while something moves — a
  // pressed pointer on the canvas, an open motion window (wheel, keys, a programmatic camera
  // write) or a camera state that changed within the stillness interval — and stops itself after
  // 300 ms of an unchanged camera with nothing pressed and no window open. Nothing in these files
  // runs a forever rAF loop anymore: the flow layer above is the only always-on animation, and it
  // pauses whenever nothing can animate.
  const cameraWatch = { running: false, lastChangeMs: null as number | null, motionUntilMs: 0 };
  const cameraFrameTimes: number[] = [];
  // The settle label pass (D-072 P1a): deferred to idle time so the camera-settle frame itself
  // stays light — one 100–340 ms hitch per interaction was exactly this pass running synchronously
  // at settle. `requestIdleCallback` with a timeout keeps it within ~220 ms even under load; the
  // setTimeout fallback keeps non-browser hosts on the old cadence. Coalesced: each new camera
  // change cancels the pending pass and reschedules it.
  const cancelSettleLabelPass = () => {
    if (cameraLabelIdle !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(cameraLabelIdle);
    cameraLabelIdle = null;
    if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
    cameraLabelTimer = undefined;
  };
  const scheduleSettleLabelPass = () => {
    cancelSettleLabelPass();
    if (typeof requestIdleCallback === "function") {
      cameraLabelIdle = requestIdleCallback(() => { cameraLabelIdle = null; if (!destroyed) labelPass(); }, { timeout: 220 });
    } else {
      cameraLabelTimer = setTimeout(() => { if (!destroyed) labelPass(); }, 200);
    }
  };
  // Capped resolution (D-072 P1a / R3): the backing-store scale swap runs outside any frame
  // loop, on a debounce, and only at rest. D-072 R3 (X9) removed the mid-motion swap — the 90 ms
  // resize plus full repaint into every drag was one 110–190 ms frame; the moving pass is cheap
  // because of its reduced drawing, not a lower resolution, so the canvases keep the rest scale
  // while moving and the only applies left are policy changes at rest (a DPR or window change).
  const applyResolution = () => {
    const plan = resolutionApplyPlan(morphologyInteraction.quality, viewNativeDevicePixelRatio, scheduledDevicePixelRatio);
    if (!plan.apply) return;
    const began = performance.now();
    scheduledDevicePixelRatio = plan.scale;
    sizeFlowCanvas();
    redrawMorphology();
    scheduleMarks.record("resolution-apply", began, performance.now() - began);
  };
  const scheduleResolution = (delayMs: number) => {
    if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
    resolutionTimer = setTimeout(() => { if (!destroyed) applyResolution(); }, delayMs);
  };
  const onQualityMoving = () => {
    morphologyInteraction.quality = "moving";
    scheduleMarks.record("quality-moving", performance.now(), 0);
    // X9: no backing-store swap during motion. A rest apply still pending from a previous
    // settle is cancelled here; the settle path schedules it again.
    if (resolutionTimer !== undefined) { clearTimeout(resolutionTimer); resolutionTimer = undefined; }
    // With no tier-1 candidate the reduced pass has zero output: drop the rest labels once (they
    // would otherwise sit at pre-motion positions through the drag); every later moving pass
    // early-outs in labelPass.
    if (!movingPassCandidates() && (placed.length > 0 || layer.childElementCount > 0)) {
      placed = [];
      layer.replaceChildren();
    }
  };
  const onQualityFull = (now: number) => {
    morphologyInteraction.quality = "full";
    scheduleMarks.record("quality-full", now, 0);
    scheduleResolution(40);
    // The full drawing returns on this frame; the deferred full label pass brings the other labels
    // back, and the flow overlay fades in with its clock uninterrupted.
    flowLoop.resumedAtMs = now;
    redrawMorphology();
    scheduleSettleLabelPass();
  };
  function startCameraWatch() {
    if (destroyed || cameraWatch.running || handle === null) return;
    cameraWatch.running = true;
    frameId = requestAnimationFrame(cameraWatchTick);
  }
  // D-072 R3 (X9): the moving label pass runs here, one animation frame after the camera change
  // that requested it — the camera frame lands first, the tier-1 labels follow on the next frame,
  // and the first camera-watch tick never carries the pass's cost (anchor projection, footprint
  // discs, Indra container titles, DOM rebuild) synchronously.
  const runMovingLabelPass = (now: number) => {
    movingLabelFrame = 0;
    if (destroyed || handle === null) return;
    movingLabelSchedule.ran(now);
    labelPass();
  };
  const noteCameraMotion = () => {
    cameraWatch.motionUntilMs = performance.now() + CAMERA_STILLNESS_MS;
    startCameraWatch();
  };
  function cameraWatchTick(now: number) {
    frameId = 0;
    if (destroyed || handle === null) { cameraWatch.running = false; return; }
    const state = JSON.stringify(handle.readCameraState());
    if (state !== lastCamera) {
      lastCamera = state;
      cameraFrameTimes.push(now);
      if (cameraFrameTimes.length > 120) cameraFrameTimes.shift();
      cameraWatch.lastChangeMs = now;
      if (qualityGovernor.touch(now) === "moving") onQualityMoving();
      // Labels track the camera while it moves — tier-1 only, throttled to the interval, and
      // always deferred to the next frame (see runMovingLabelPass), never synchronous here.
      if (movingLabelSchedule.request(now) === "defer") {
        if (movingLabelFrame) cancelAnimationFrame(movingLabelFrame);
        movingLabelFrame = requestAnimationFrame(runMovingLabelPass);
      }
      scheduleSettleLabelPass();
    } else if (qualityGovernor.poll(now) === "full") onQualityFull(now);
    if (!cameraWatchShouldRun({ nowMs: now, lastChangeMs: cameraWatch.lastChangeMs, pressed: pressedAt !== null, motionUntilMs: cameraWatch.motionUntilMs })) {
      cameraWatch.running = false;
      return;
    }
    frameId = requestAnimationFrame(cameraWatchTick);
  }
  /** The edges the drawing shows for one node subset: reading-allowed relations whose both
   * endpoints are in the subset — exactly the set the mounted graph's subgraph would keep. */
  const resolveDrawnEdges = (records: readonly ReviewEdge[], ids: ReadonlySet<string>): readonly ReviewEdge[] =>
    records.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && readingAllows(edge));
  /** The presentation edge record for one drawn relation: colour category, opacity and width
   * derived from the relation record and the axes alone — never from the subset, which is why an
   * in-place LOD change only ever needs entries for edges that were not drawn before. */
  const presentationEdge = (edge: ReviewEdge, palette: PaletteValues) => {
    const exploratory = (input.v2Prepared ? edge.attested_by : relationClass(edge, nodesById)) === "exploratory";
    const relation = edge.v2 as import('./v2-relations.ts').LiftedRelation | undefined;
    const coMembership = Boolean(input.v2Prepared && relation?.type === 'co_membership');
    const containment = Boolean(input.v2Prepared && relation?.type === 'contains');
    const category = classifyEdgeCategory(exploratory, containment);
    // In Indra the pearls carry the structure: unselected semantic arcs recede (thinner, fainter) so rims and names read.
    const indraDim = axes.organization === 'indra' ? indraArcPresentation(axes.projection, exploratory) : null;
    return { category,
      // Width is never the only signal: exploratory reads through its halo and flow, not through extra thickness.
      opacityPermille: input.v2Prepared ? Math.round(SCENE_PERMILLE_SCALE
        * (exploratory ? 0.9 : coMembership ? 0.62 : containment ? 0.5 : axes.reading === 'attested' ? 0.68 : 0.36)
        * (indraDim?.opacityFactor ?? 1))
        : axes.reading !== "attested" && !exploratory ? Math.round(SCENE_PERMILLE_SCALE * 0.45) : SCENE_PERMILLE_SCALE,
      widthPermille: input.v2Prepared ? Math.round(SCENE_PERMILLE_SCALE
        * (coMembership ? Math.min(1.4, (relation?.width ?? 1) * 0.75) : containment ? 0.8 : 1)
        * (indraDim?.widthFactor ?? 1))
        : SCENE_PERMILLE_SCALE,
      ...(axes.colour === "bw" && input.v2Prepared ? { tintSrgb: [0.64, 0.64, 0.64] as const }
        : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(exploratory ? palette.exploratory : palette.attested) }),
    } as const;
  };
  /** D-072 R2: the whole drawing of the current drawn subset — presentation maps, morphology
   * input and geometry — derived from view state only. mount() and updateVisibleSubset() both
   * build through this one path, so an in-place LOD swap and a remount of the same subset derive
   * identical pixels. `anchors` is the mounted anchor map; only drawn ids are ever read. */
  function buildDrawnScene(anchors: ReadonlyMap<string, Coordinates>, state: {
    visible: ReadonlySet<string>; containers: typeof layoutContainers; edges: readonly ReviewEdge[];
  } = { visible, containers: layoutContainers, edges: drawnEdges }) {
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    const openContainers = new Set(input.v2Prepared && axes.organization === "indra"
      ? (state.containers ?? []).filter((container) => container.open !== false).map((container) => container.id) : []);
    const containers = state.containers && axes.organization === "indra" ? state.containers : undefined;
    const presentation = {
      morphologyLanguage: "distinct" as const,
      nativeLabels: false,
      windowGeometryFromAnchors: true,
      ...(containers ? { containers } : {}),
      emphasisIds: emphasis,
      appearance,
      edges: new Map(state.edges.map((edge) => [edge.id, presentationEdge(edge, palette)] as const)),
      nodes: new Map(
        input.data.nodes
          .filter((node) => state.visible.has(node.id))
          .map((node) => {
            const v2Encoded = input.v2Prepared ? v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale) : null;
            const encoding = v2Encoded ?? encodingOf(node, input.data);
            return [node.id, {
              ...encoding,
              glyph: v2Encoded ? v2Encoded.glyph : (node.type === "domain" || node.type === "conversation" ? "ring"
                : node.type === "canon" ? "double-ring"
                : node.type === "record" || node.type === "evidence" ? "hollow" : "filled") as "ring" | "double-ring" | "hollow" | "filled",
              ...(node.origin === "dynamic" ? { haloPermille: Math.round(encoding.haloPermille * 0.55) } : {}),
              ...(input.v2Prepared && state.visible.size > 400 ? { haloPermille: Math.round(encoding.haloPermille * 0.28) } : {}),
              ...(v2Encoded && axes.morphology === "neural" ? { radiusPx: v2Encoded.radiusPx * (
                (node.v2 as import("./v2-core.ts").V2Node).level >= 3 ? 0.62
                  : (node.v2 as import("./v2-core.ts").V2Node).level === 2 ? 0.8 : 1) } : {}),
              // In Indra a node whose children are visible is drawn by its container ring; its own disc
              // shrinks to a small hollow marker. A closed `+N` container keeps its own pearl, because
              // below the sphere LOD the pearl is all that carries it.
              ...(openContainers.has(node.id) ? { radiusPx: INDRA_CONTAINER_MARKER_PX, haloPermille: 0, glyph: "hollow" as const } : {}),
              ...(axes.morphology === "stellar" && axes.organization === "indra" && axes.projection === "3d"
                ? { radiusPx: stellarIndra3dNodeRadiusPx(openContainers.has(node.id) ? INDRA_CONTAINER_MARKER_PX
                  : v2Encoded?.radiusPx ?? encoding.corePermille * 8 / SCENE_PERMILLE_SCALE,
                  axes.morphology, axes.organization, axes.projection) } : {}),
              ...(input.v2Prepared && axes.colour === "bw" ? { tintSrgb: (() => { const level = (node.v2 as import("./v2-core.ts").V2Node).level; const gray = level <= 2 ? 0.88 : level <= 4 ? 0.7 : 0.56; return [gray, gray, gray] as const; })() }
                : input.v2Prepared && axes.colour !== "bw" ? {tintSrgb:hexRgb(v2CategoryColour(node.v2 as import("./v2-core.ts").V2Node,palette,axes.colour==='custom'?input.v2Colours:undefined))}
                : axes.colour === "semantic" ? { tintSrgb: SEMANTIC_COLOUR[standingOf(node, input.data)] }
                : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(palette[input.text(node.id).family === "aggregate" ? "aggregate" : "concept"]) }),
            }] as const;
          }),
      ),
    };
    const colonyMembers = new Map<string, string[]>();
    for (const node of input.data.nodes) if (state.visible.has(node.id) && anchors.has(node.id)) {
      const parent = (node.v2 as { parent?: string | null } | undefined)?.parent;
      const community = parent && state.visible.has(parent) ? parent : node.id;
      const members = colonyMembers.get(community) ?? [];
      members.push(node.id);
      colonyMembers.set(community, members);
    }
    const morphologyInput: MorphologyInput = {
      nodes: [...presentation.nodes].flatMap(([id, value]) => {
        const position = anchors.get(id);
        return position ? [{ id, position, radius: value.radiusPx ?? value.corePermille * 8 / SCENE_PERMILLE_SCALE }] : [];
      }),
      edges: state.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
        // The drawer applies the presentation width factor; the geometry carries the unit body width.
        width: 1 })),
      colonies: [...colonyMembers].map(([id, members]) => {
        const positions = members.map(member => anchors.get(member)!).filter(Boolean);
        const center = { x: positions.reduce((s, p) => s + p.x, 0) / positions.length,
          y: positions.reduce((s, p) => s + p.y, 0) / positions.length,
          z: positions.reduce((s, p) => s + p.z, 0) / positions.length };
        return { id, members, center };
      }),
      containers: containers ?? [],
    };
    const geometry = buildMorphologyGeometry(axes.morphology, morphologyInput.nodes, morphologyInput.edges,
      morphologyInput.colonies, appearance.curvature, morphologyInput.containers);
    return { palette, presentation, morphologyInput, geometry };
  }
  function mount() {
    const began = performance.now();
    sigma?.destroy();
    three?.destroy();
    sigma = null;
    three = null;
    handle = null;
    // D-072 R2: the drawn subset is resolved once per mount (and once per in-place update) — the
    // reading-allowed edges whose both endpoints are visible, the exact set the previous
    // subgraph-plus-reading filter produced.
    drawnEdges = resolveDrawnEdges(input.data.edges, visible);
    drawnEdgeIds = new Set(drawnEdges.map((edge) => edge.id));
    if (lodMode) for (const id of drawnEdgeIds) mountedEdgeIds.add(id);
    // The mounted graph: in LOD mode every disclosed node stays mounted — picking, witnesses and
    // style coverage for any future subset; otherwise exactly the visible subset as before. The
    // mounted edges are the drawn subset either way.
    const all = subgraph(axes.organization === "indra" ? prepared.indraGraph : prepared.flatGraph, lodMode ? mountedIds : visible);
    const subset = { ...all, edges: all.edges.filter((edge) => drawnEdgeIds.has(edge.id)) };
    const anchors = restrictAnchors(fullAnchor(axes), lodMode ? mountedIds : visible);
    const { palette, presentation, morphologyInput, geometry } = buildDrawnScene(anchors);
    container.style.backgroundColor = palette.background;
    morphologyInteraction.containerColor = palette.container;
    morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
    const sharedPresentation = { ...presentation, morphologyInput, morphologyInteraction,
      morphologyGeometry: geometry };
    const renderOptions = {
      ...options,
      ...(axes.organization === 'indra' ? { calibration: { ...DEFAULT_CALIBRATION,
        selection: { ...DEFAULT_CALIBRATION.selection, focusDimFactorPermille: 600 } } } : {}),
      morphology: axes.morphology,
      // On the v2 dataset the page's layout places every node and its canvas layer draws the Indra containers, so the
      // engine's own membership windows stay off in both organizations.
      organization: input.v2Prepared ? "flat" as const : axes.organization,
      reducedMotion: input.reducedMotion,
      presentation: sharedPresentation,
    };
    // Each renderer derives its own first camera; framing below then works in whatever convention it uses.
    if (axes.projection === "2d") sigma = mount2d(container, subset, renderOptions, undefined, undefined, anchors);
    else {
      // Supplied anchors already contain the bounds; skip a provisional full scene build. In LOD
      // mode the provisional frame covers the drawn subset, exactly what a non-LOD mount would fit.
      const drawnAnchors = lodMode ? restrictAnchors(anchors, visible) : anchors;
      const frame = drawnAnchors.size ? resolvedNodeBounds([...drawnAnchors.values()]) : undefined;
      three = mount3d(container, subset, renderOptions, frame, undefined, anchors);
      three.setCameraKind("perspective");
    }
    handle = (sigma ?? three)!;
    drawnGeometry = geometry;
    committedScene = { palette, presentation, morphologyInput, geometry };
    lastNodeMarks = new Map([...presentation.nodes].map(([id, value]) =>
      [id, { glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined, radiusPx: value.radiusPx }]));
    // D-072 P1a: the flow overlay draws with the same geometry, projector and style the main pass
    // uses — the geometry this view built for both renderers, the live projector the mounted
    // renderer answers with (2D: Sigma's viewport mapping and size scale; 3D: the review pose's
    // perspective size scale, exactly the rig's `sizeScaleAt`), and the presentation maps the
    // shared drawer reads its colours from.
    ensureFlowCanvas();
    sizeFlowCanvas();
    flowScene = {
      geometry: sharedPresentation.morphologyGeometry,
      project: sigma
        ? (point) => { const p = sigma!.graphToViewport(point); return { x: p.x, y: p.y, scale: sigma!.scaleSize(1) }; }
        : (point) => {
          const p = handle!.graphToViewport(point);
          return { x: p.x, y: p.y, scale: perspectiveSizeScale(three!.readReviewCameraPose(), point) };
        },
      style: {
        fieldColor: palette.background,
        interaction: morphologyInteraction,
        nodes: new Map([...presentation.nodes].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(245, 245, 245)",
          glyph: value.glyph,
          radiusPx: value.radiusPx,
        }])),
        edges: new Map([...presentation.edges].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)",
          presentation: value,
        }])),
      },
    };
    container.append(layer);
    if (emphasis) {
      sigma?.setEmphasis(emphasis);
      three?.setEmphasis(emphasis);
    }
    if (selected && (visible.has(selected) || drawnEdgeIds.has(selected)))
      handle.setSelection(selected);
    const saved = restoreSavedCamera();
    if (saved && validCamera(saved)) handle.restoreCameraState(saved);
    else {
      if (three && input.v2Prepared) handle.restoreCameraState({ ...handle.readCameraState(), orbit: defaultObliqueOrbit() } as ReviewCameraState);
      const initialPoints = input.data.nodes.filter((n) => visible.has(n.id)).map((n) => anchors.get(n.id)!).filter(Boolean);
      if (axes.projection === '3d' && axes.organization === 'flat')
        initialPoints.push(...framingVolumePoints(initialPoints));
      if (axes.organization === 'indra' && layoutContainers) {
        const outer = layoutContainers.find(item => item.level === 0);
        // The framing subjects include the whole drawn shell: in 3D the limb circle (radius ×
        // projectedWorldScale) reaches beyond the six axis supports under the oblique default
        // orbit, so the fit gets the shell's great-circle ring too.
        if (outer) initialPoints.push(...(axes.projection === '2d'
          ? framingSpherePoints(outer.center, outer.radius2d ?? outer.radius)
          : framingShellRingPoints(outer.center, outer.radius)));
      }
      solveFraming(handle, {
        points: initialPoints,
        rect: localRect(),
        marginPx: 24,
        anchorFirst: false,
        fill: 0.92,
      });
      // D-073 C6: a solved fit commits under the arrangement-qualified key and mirrors into the
      // legacy one, so this camera is what a later arrangement switch replays.
      const settled = handle.readCameraState();
      commitCamera(settled, settled.ratio);
    }
    // The mounted camera (any restored or solved framing included) is the watch loop's baseline:
    // only changes from here on are motion.
    lastCamera = JSON.stringify(handle.readCameraState());
    labelPass();
    syncFlowLoop();
    scheduleMarks.record("mount", began, performance.now() - began);
  }
  function saveCamera() {
    const camera = handle?.readCameraState();
    if (camera && validCamera(camera)) commitCamera(camera);
  }
  /** D-072 R2: apply one level-of-detail subset change in place. Everything the drawing shows is
   * rebuilt through buildDrawnScene — the same derivation a remount of this subset would run — and
   * pushed into the mounted renderers' distinct layers, the flow overlay and the label pass. The
   * renderers, the camera, the flow clock and every other frame of the page's state are not
   * touched. Returns false when the update cannot land in place; the caller remounts then. */
  function applyVisibleSubset(update: VisibleSubsetUpdate): boolean {
    if (!lodMode || destroyed || handle === null || committedScene === null) return false;
    for (const id of update.visibleNodeIds) if (!mountedIds.has(id)) return false;
    const began = performance.now();
    const oldScene = committedScene;
    const oldLabels = [...layer.childNodes];
    const oldPlaced = placed;
    const oldDiscs = morphologyInteraction.labelDiscs;
    const oldColor = morphologyInteraction.containerColor;
    const oldBackground = container.style.backgroundColor;
    const oldFocusIds = morphologyInteraction.focusIds;
    const oldSelection = selected;
    const nextVisible = new Set(update.visibleNodeIds);
    const nextContainers = update.containers ?? layoutContainers;
    const nextBudget = update.labelBudget ?? labelBudget;
    const records = update.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target, type: edge.type,
      attested_by: edge.class, weight: "count" in edge ? edge.count : 1,
      evidence_ids: [], v2: edge,
    }) as ReviewEdge);
    const nextEdges = resolveDrawnEdges(records, nextVisible);
    const nextEdgeIds = new Set(nextEdges.map((edge) => edge.id));
    const nextSelection = selected && (nextVisible.has(selected) || nextEdgeIds.has(selected)) ? selected : null;
    const anchors = restrictAnchors(fullAnchor(axes), mountedIds);
    const nextScene = buildDrawnScene(anchors, { visible: nextVisible, containers: nextContainers, edges: nextEdges });
    const { presentation, morphologyInput, geometry } = nextScene;
    const nextNodeMarks = new Map([...presentation.nodes].map(([id, value]) =>
      [id, { glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined, radiusPx: value.radiusPx }] as const));
    const nodeEntries = new Map<string, { glyph: import("../engine/presentation-options.ts").NodeGlyph | undefined; radiusPx: number | undefined }>();
    for (const [id, mark] of nextNodeMarks) {
      const before = lastNodeMarks.get(id);
      if (!before || before.glyph !== mark.glyph || before.radiusPx !== mark.radiusPx) nodeEntries.set(id, mark);
    }
    const edgeEntries = new Map<string, { color: string; presentation: ReturnType<typeof presentationEdge> }>();
    for (const [id, value] of presentation.edges) if (!mountedEdgeIds.has(id))
      edgeEntries.set(id, { color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value });
    const nextOverlay: DistinctSubsetUpdate = { input: morphologyInput, geometry, nodeEntries, edgeEntries };
    // Rollback sends complete old style entries: a renderer may have accepted all of its new
    // entries before its canvas draw threw. The old geometry hides any newly introduced ids.
    const restoreOverlay: DistinctSubsetUpdate = {
      input: oldScene.morphologyInput, geometry: oldScene.geometry,
      nodeEntries: new Map([...oldScene.presentation.nodes].map(([id, value]) => [id, {
        glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined,
        radiusPx: value.radiusPx,
      }])),
      edgeEntries: new Map([...oldScene.presentation.edges].map(([id, value]) => [id, {
        color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value,
      }])),
    };
    const oldSizes = new Map<string, number>();
    if (sigma) for (const [id, entry] of nodeEntries)
      if (entry.radiusPx !== undefined && sigma.model.graph.hasNode(id))
        oldSizes.set(id, sigma.model.graph.getNodeAttribute(id, "size"));
    const nextFlowScene = flowScene && {
      ...flowScene, geometry,
      style: {
        ...flowScene.style,
        nodes: new Map([...presentation.nodes].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(245, 245, 245)",
          glyph: value.glyph, radiusPx: value.radiusPx,
        }])),
        edges: new Map([...presentation.edges].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value,
        }])),
      },
    };
    try {
      sigma?.updateVisibleSubset(nextOverlay);
      three?.updateVisibleSubset(nextOverlay);
      if (sigma) for (const [id, entry] of nodeEntries)
        if (entry.radiusPx !== undefined && sigma.model.graph.hasNode(id))
          sigma.model.graph.setNodeAttribute(id, "size", entry.radiusPx);
      labelPass({ visible: nextVisible, containers: nextContainers, budget: nextBudget });
      if (oldSelection && !nextSelection) {
        handle.clearSelection();
        morphologyInteraction.focusIds = new Set([...(emphasis ?? [])]);
        redrawMorphology();
      }
      scheduleMarks.record("lod-in-place", began, performance.now() - began);
    } catch (error) {
      // Attempt both restorations even if one renderer was the source of the failure. A transient
      // draw fault must not leave one overlay on the new scene while the page keeps this view.
      let rollbackError: unknown;
      try { sigma?.updateVisibleSubset(restoreOverlay); } catch (failure) { rollbackError = failure; }
      try { three?.updateVisibleSubset(restoreOverlay); } catch (failure) { rollbackError ??= failure; }
      if (sigma) for (const [id, size] of oldSizes)
        try { sigma.model.graph.setNodeAttribute(id, "size", size); } catch (failure) { rollbackError ??= failure; }
      try {
        layer.replaceChildren(...oldLabels);
        placed = oldPlaced;
        morphologyInteraction.labelDiscs = oldDiscs;
        morphologyInteraction.containerColor = oldColor;
        morphologyInteraction.focusIds = oldFocusIds;
        container.style.backgroundColor = oldBackground;
        if (oldSelection) handle.setSelection(oldSelection);
        else handle.clearSelection();
        redrawMorphology();
      } catch (failure) { rollbackError ??= failure; }
      if (rollbackError) throw new AggregateError([error, rollbackError], "LOD update and rollback failed");
      return false;
    }
    visible = nextVisible;
    layoutContainers = nextContainers;
    labelBudget = nextBudget;
    drawnEdges = nextEdges;
    drawnEdgeIds = nextEdgeIds;
    drawnGeometry = geometry;
    committedScene = nextScene;
    lastNodeMarks = nextNodeMarks;
    selected = nextSelection;
    for (const edge of records) edgesById.set(edge.id, edge);
    if (nextFlowScene) flowScene = nextFlowScene;
    return true;
  }

  const pointer = (event: PointerEvent) => {
    const r = container.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  /** D-072 R2: in LOD mode the mounted renderers hold the mount-time edge set, so edge picking
   * hit-tests the drawn geometry itself — the segments the distinct canvas last drew, projected
   * through the same live projector, with the same tolerance the Indra container rims use. */
  function drawnEdgeAtPoint(p: { x: number; y: number }): string | null {
    if (!drawnGeometry) return null;
    let closest: { id: string; distance: number } | null = null;
    for (const part of drawnGeometry.drawnSegments) {
      for (let index = 1; index < part.samples.length; index++) {
        const a = project(part.samples[index - 1]!), b = project(part.samples[index]!);
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
        const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (distance < 7 && (!closest || distance < closest.distance)) closest = { id: part.edgeId, distance };
      }
    }
    return closest?.id ?? null;
  }
  function pick(p: { x: number; y: number }) {
    if (!handle) return null;
    const node = handle.pickNodeAtPosition(p);
    if (node && (!lodMode || visible.has(node))) return { kind: "node" as const, id: node };
    if (axes.organization === 'indra' && layoutContainers) {
      let closest: { id: string; distance: number } | null = null;
      for (const outline of buildContainerGeometry(axes.morphology, layoutContainers)) {
        // Only a sphere the view actually draws answers a click on its rim; a closed pearl below the
        // LOD is picked by its pearl marker instead.
        if (axes.projection === '3d') {
          const center = project(outline.center);
          const limbRadius = outline.radius * projectedWorldScale(outline.center, outline.radius, project);
          if (!containerSphereLOD(outline.level, outline.open !== false,
            morphologyInteraction.focusIds?.has(outline.id) ?? false, Math.max(0.5, limbRadius))) continue;
          if (center.x + limbRadius < -8 || center.x - limbRadius > container.clientWidth + 8
            || center.y + limbRadius < -8 || center.y - limbRadius > container.clientHeight + 8) continue;
        }
        const circles = axes.projection === '3d' ? (outline.shell ?? [outline.points]) : [outline.points];
        for (const circle of circles) {
          const projected = circle.map(point => project(point));
          for (let index = 1; index < projected.length; index++) {
            const a = projected[index - 1]!, b = projected[index]!;
            const dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
            const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
            if (distance < 7 && (!closest || distance < closest.distance)) closest = { id: outline.id, distance };
          }
        }
      }
      if (closest) return { kind: 'node' as const, id: closest.id };
    }
    const edge = lodMode ? drawnEdgeAtPoint(p) : handle.pickEdgeAtPoint(p.x, p.y);
    return edge ? { kind: "edge" as const, id: edge } : null;
  }
  const onMove = (event: PointerEvent) => {
    // A pressed pointer owns the orbit. Picking under its early drag samples can rebuild the
    // 3D scene and issue a second label pass in the same frame; hover resumes on release.
    if (pressedAt !== null) return;
    const p = pointer(event);
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      const target = pick(p);
      hover = target ? { ...target, ...p } : null;
      morphologyInteraction.hoverId = hover?.id ?? null;
      redrawMorphology();
      input.events.onHover(hover ? { ...hover, x: event.clientX, y: event.clientY } : null);
      labelPass();
    });
  };
  // A drag that orbits or pans ends with a click on the same canvas; it must not select what happens
  // to lie under the pointer when the drag stops.
  const overControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
    "#fullscreen-bar, #appearance-panel, #gizmo, #toast, #focus-chip, #details",
  ));
  let pressedAt: { x: number; y: number } | null = null;
  const onPress = (event: PointerEvent) => {
    if (overControl(event.target)) return;
    cancelAnimationFrame(hoverFrame);
    pressedAt = { x: event.clientX, y: event.clientY };
    // A press may become a drag: the camera watch loop starts observing from the press, not from
    // the first camera change.
    noteCameraMotion();
  };
  const onClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    const moved = pressedAt === null ? 0 : Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (moved > CLICK_DRAG_TOLERANCE_PX) return;
    const r = container.getBoundingClientRect();
    const target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    input.events.onPick(target ? {...target, shiftKey:event.shiftKey} : null);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    noteCameraMotion();
    const r = container.getBoundingClientRect();
    const target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    if (target?.kind === "node") input.events.onDoublePick?.(target);
  };
  const onLeave = () => {
    hover = null;
    morphologyInteraction.hoverId = null;
    redrawMorphology();
    input.events.onHover(null);
    labelPass();
  };
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerdown", onPress);
  container.addEventListener("click", onClick);
  container.addEventListener("dblclick", onDoubleClick);
  container.addEventListener("pointerleave", onLeave);
  // Wheel and keyboard navigation move the camera without a pointer press; each event opens the
  // motion window so the watch loop observes the change (and stops again at stillness).
  const onWheel = () => noteCameraMotion();
  const onKeyNavigation = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    noteCameraMotion();
  };
  container.addEventListener("wheel", onWheel, { passive: true });
  container.addEventListener("keydown", onKeyNavigation);
  // A panel collapse or reopen changes the container's size while the camera state stays
  // byte-identical, so `followCamera` never re-runs the label pass and the labels keep the
  // closed-canvas positions. One resize observation closes the loop: the renderers' own
  // observers (registered first) resize the rig, and this pass runs on the next frame with the
  // updated geometry.
  const resizeLabelObserver = new ResizeObserver(() => {
    if (destroyed) return;
    requestAnimationFrame(() => { if (!destroyed) { sizeFlowCanvas(); labelPass(); } });
  });
  resizeLabelObserver.observe(container);
  try { mount(); }
  catch (error) {
    destroyed = true;
    resizeLabelObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
    if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
    cancelAnimationFrame(frameId);
    cancelAnimationFrame(hoverFrame);
    cancelAnimationFrame(movingLabelFrame);
    stopFlowLoop();
    removeDevicePixelRatioShadow();
    throw error;
  }
  (globalThis as typeof globalThis & { __d071?: unknown }).__d071 = {
    flow: {
      // Test/measurement hooks for the browser checks.
      now: (milliseconds: number) => { if (ownsFlowMotion(flowOwner)) { setFlowNow(milliseconds); drawFlowOverlay(performance.now(), true); } },
      animatedEdges: () => flowAnimatedEdgeCount(),
      motionAllowed: () => flowAnimatesNow(),
      frameCostMs: () => flowLoop.frameCostMs,
      setMotion: (enabled: boolean) => { if (!destroyed) { flowMotion = enabled; syncFlowLoop(); } },
    },
  };
  // D-072 P1a test hooks: the quality state, the measured flow-layer cadence, and whether the
  // camera watch loop (the only thing allowed to poll the camera) is running at all. D-072 R3
  // adds `marks()`: the last 400 scheduling events `{ name, at, ms }` — quality flips, resolution
  // applies, label passes with their duration (skips included), remounts — never per frame.
  (globalThis as typeof globalThis & { __d072?: Record<string, unknown> }).__d072 = {
    ...((globalThis as typeof globalThis & { __d072?: Record<string, unknown> }).__d072 ?? {}),
    quality: () => morphologyInteraction.quality,
    flowFps: () => flowLoop.measuredFps,
    cameraWatchRunning: () => cameraWatch.running,
    cameraFrames: () => cameraFrameTimes,
    marks: () => scheduleMarks.list(),
  };
  async function frameIds(ids: readonly string[], anchorFirst: boolean, marginPx = 32, fill = 0.9) {
    // The framing belongs to the renderer mounted now; a remount during the animation must not receive a camera
    // interpolated in another renderer's convention.
    const current = handle;
    if (!current) return;
    // The framing solver and the settle animation move the camera programmatically: keep the
    // watch loop observing for their whole duration.
    noteCameraMotion();
    const byId = new Map(throughVisible(current.readWorldAnchorWitnesses()).map((p) => [p.id, p.position]));
    // The layout already knows every visible position; right after a remount the renderer may not report them all yet.
    const layout = restrictAnchors(fullAnchor(axes), visible);
    const points = ids.map((id) => layout.get(id) ?? byId.get(id)).filter((p): p is Coordinates => p !== undefined && finitePoint(p));
    if (ids.length === visible.size && axes.projection === '3d' && axes.organization === 'flat')
      points.push(...framingVolumePoints(points));
    if (ids.length === visible.size && axes.organization === 'indra' && layoutContainers) {
      const outer = layoutContainers.find(item => item.level === 0);
      if (outer) points.push(...(axes.projection === '2d'
        ? framingSpherePoints(outer.center, outer.radius2d ?? outer.radius)
        : framingShellRingPoints(outer.center, outer.radius)));
    }
    if (ids.length === visible.size && three)
      points.push(...(lodMode
        ? three.readRelationGeometryWitnesses().filter((relation) => drawnEdgeIds.has(relation.id))
        : three.readRelationGeometryWitnesses()).map((relation) => relation.controlPoint).filter(finitePoint));
    if (!points.length) return;
    const start = current.readCameraState();
    const startZ = three?.readReviewCameraPose().target[2] ?? 0;
    const finalZ = mean(points.map((point) => point.z));
    if (three) current.restoreCameraState({ ...start, targetZ: finalZ } as ReviewCameraState);
    const solved = solveFraming(current, {
      points,
      rect: localRect(),
      marginPx,
      anchorFirst: anchorFirst && points.length > 1,
      fill,
    });
    const final = solved.camera;
    if (!validCamera(final)) {
      if (validCamera(start)) current.restoreCameraState(start);
      // The programmatic motion is over either way: settle quality now so the closing pass below
      // is the full one — labels return with the framing, never a settle later.
      if (qualityGovernor.endMotion(performance.now()) === "full") onQualityFull(performance.now());
      labelPass();
      return;
    }
    if (!input.reducedMotion && validCamera(start)) {
      current.restoreCameraState(start);
      await new Promise<void>((resolve) => {
        const begun = performance.now();
        const tick = (now: number) => {
          if (destroyed || handle !== current) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - begun) / 400);
          const smooth = t * t * (3 - 2 * t);
          try {
            current.restoreCameraState({
              ...final,
              x: start.x + (final.x - start.x) * smooth,
              y: start.y + (final.y - start.y) * smooth,
              ratio: start.ratio + (final.ratio - start.ratio) * smooth,
              ...(three ? { targetZ: startZ + (finalZ - startZ) * smooth } : {}),
            });
          } catch {
            resolve();
            return;
          }
          noteCameraMotion();
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    }
    if (handle !== current) return;
    current.restoreCameraState(final);
    // D-073 C6: the explicit framing lands under the current key and its legacy mirror, so it — not
    // some older camera — is what a later replay offers.
    commitCamera(final);
    // The programmatic framing has landed: nothing further will move the camera, so quality
    // returns to full now — the closing label pass below draws the full set, and secondary labels
    // return with the fit itself rather than through the stillness delay and the idle settle.
    if (qualityGovernor.endMotion(performance.now()) === "full") onQualityFull(performance.now());
    labelPass();
  }
  return {
    async setAxes(next) {
      const old = axes;
      // D-073 C6: the merged axes are validated before they are applied, so an arrangement on the
      // Indra view is refused without leaving the view on half-migrated axes.
      const merged: Axes = { ...axes, ...next };
      assertNaturalArrangementAxis(merged);
      saveCamera();
      axes = merged;
      if (!productViewRemountsAxes(old, axes)) labelPass();
      else mount();
    },
    async setVisible(ids) {
      saveCamera();
      visible = new Set(ids);
      if (selected && !visible.has(selected)) selected = null;
      mount();
    },
    updateVisibleSubset(update) { return applyVisibleSubset(update); },
    setInsets(value) {
      insets = value;
      labelPass();
    },
    async setAppearance(value) { appearance = value; saveCamera(); mount(); },
    setFlowMotion(enabled) { flowMotion = enabled; syncFlowLoop(); },
    async setPalette(value) { customPalette = value; saveCamera(); mount(); },
    viewPreset(name) { three?.setReviewViewPreset(name); noteCameraMotion(); labelPass(); },
    camera() { return three?.readReviewCameraPose() ?? null; },
    readCamera() { return handle?.readCameraState() ?? null; },
    restoreCamera(state) { if (handle && validCamera(state as VisualStateCamera)) {
      handle.restoreCameraState(state as VisualStateCamera); noteCameraMotion(); labelPass();
    } },
    async resetCamera() {
      // D-073 C6: an explicit reset forgets both spellings, so the remount refits instead of
      // replaying back the camera it just deleted.
      forgetProductCamera(cameras, fitRatio, cameraKeys());
      mount();
    },
    select(id) {
      selected = id && (visible.has(id)
        || (axes.organization === 'indra' && layoutContainers?.some(item => item.id === id))
        || (lodMode ? drawnEdgeIds.has(id) : graph().edges.some((e) => e.id === id))) ? id : null;
      morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
      redrawMorphology();
      if (handle) {
        if (selected && visible.has(selected)) handle.setSelection(selected);
        else handle.clearSelection();
      }
      labelPass();
    },
    setEmphasis(ids) {
      emphasis = ids;
      morphologyInteraction.focusIds = new Set([...(ids ?? []), ...(selected ? [selected] : [])]);
      redrawMorphology();
      sigma?.setEmphasis(ids);
      three?.setEmphasis(ids);
      labelPass();
    },
    setFocusStyle(style) {
      focusStyle = style;
      morphologyInteraction.dimFocus = style;
      redrawMorphology();
      labelPass();
    },
    frame: (ids) => frameIds(ids, true),
    frameFocus: (ids) => frameIds(ids, false, 60, 0.78),
    fit: () => frameIds([...visible], false),
    witness() {
      if (!handle) throw new Error("view destroyed");
      const r = container.getBoundingClientRect();
      const mounted = throughVisible(handle.readWorldAnchorWitnesses());
      const radii = new Map(handle.readNodeFootprintWitnesses().map(footprint => [footprint.id, footprint.coreRadiusPx]));
      const nodeViewport = Object.fromEntries(
        mounted.map(({ id, position }) => {
          const p = project(position);
          const radius = radii.get(id);
          return [id, { x: r.left + p.x, y: r.top + p.y, ...(radius !== undefined ? { radius } : {}) }];
        }),
      );
      const positions = Object.fromEntries(
        mounted.map(({ id, position }) => [id, { x: position.x, y: position.y, z: position.z }]),
      );
      const zs = mounted.map((p) => p.position.z);
      const zMean = mean(zs);
      const windows = sigma?.model.windows ?? three?.readReviewWindows() ?? [];
      return {
        axes,
        cameraKind: handle.cameraKind,
        visibleRect: pageRect(),
        nodeViewport,
        positions,
        labels: placed,
        titleCount: visibleTitleCount,
        selected,
        emphasised: [...(emphasis ?? [])],
        windows: windows.map((w) => ({
          id: w.id,
          members: w.members,
          center: { x: w.center.x, y: w.center.y },
          radius: w.radius,
        })),
        depth: {
          zMin: zs.length ? Math.min(...zs) : 0,
          zMax: zs.length ? Math.max(...zs) : 0,
          zStd: Math.sqrt(mean(zs.map((z) => (z - zMean) ** 2))),
        },
        anchorsSource: input.v2Prepared ? "v2-layout" :
          axes.organization === "indra"
            ? "engine-indra"
            : axes.projection === "3d"
              ? "engine-flat+depth"
              : "engine-flat",
        palette: "monochrome",
      };
    },
    destroy() {
      destroyed = true;
      stopFlowLoop();
      releaseFlowMotion(flowOwner);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
      if (cameraLabelIdle !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(cameraLabelIdle);
      cameraLabelIdle = null;
      resizeLabelObserver.disconnect();
      if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(hoverFrame);
      cancelAnimationFrame(movingLabelFrame);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerdown", onPress);
      container.removeEventListener("click", onClick);
      container.removeEventListener("dblclick", onDoubleClick);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("keydown", onKeyNavigation);
      sigma?.destroy();
      three?.destroy();
      layer.remove();
      flowCanvas?.remove();
      flowCanvas = null;
      flowContext = null;
      flowScene = null;
      // The devicePixelRatio shadow lives exactly as long as the view.
      removeDevicePixelRatioShadow();
      handle = null;
    },
  };
};
