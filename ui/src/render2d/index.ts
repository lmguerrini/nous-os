import { mixTowardField, revisedCanvasNodeColor } from "#engine/presentation-options.ts";
import type { AppearanceOptions, EdgeCategory, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
// "D082-A-NCOMPLETA2 BEGIN"
import { nativeNodePresentationBase } from "#render2d/native-node-presentation.ts";
// "D082-A-NCOMPLETA2 END"
import { buildMorphologyGeometry, NEURAL_HALO_MAX_ALPHA, NEURAL_HALO_MAX_RADIUS_RATIO } from "#engine/morphology-geometry.ts";
import type { MorphologyGeometry } from "#engine/morphology-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import { DENSE_SCENE_THRESHOLD, drawMorphologyCanvas, stellarStarCoreRadiusPx } from "#render-common/morphology-canvas.ts";
import { TYPED_COMPLETE_BUNDLE_LABEL } from "#render-common/projection-style.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import type { DistinctSubsetUpdate } from "#render-common/morphology-canvas.ts";
import Sigma from "sigma";
import { MultiDirectedGraph } from "graphology";
import { createEdgeCompoundProgram, NodeCircleProgram } from "sigma/rendering";
import type { NodeProgramType } from "sigma/rendering";
import type { CameraState, EdgeDisplayData, NodeDisplayData, RenderParams } from "sigma/types";
import { parseColor } from "sigma/utils";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import type { Coordinates, DerivedValue, VisualGraph } from "#engine/contract.ts";
import { renderDebugAssertionsEnabled } from "#engine/contract.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import type { NodeFootprintWitness, WorldAnchorWitness } from "#engine/renderer-handle.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { createRenderVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { createFilamentProgram, FilamentProgram } from "#render2d/filament-program.ts";
import {
  createLiveRelationGeometryBindings, createLiveRelationMaterialBindings,
  liveRelationGeometryWitnesses, liveRelationMaterialBindings,
} from "#render2d/relation-bindings.ts";
import type { LiveRelationGeometryBindings, LiveRelationMaterialBindings, RelationMaterialBinding, RenderRelationGeometryWitness } from "#render2d/relation-bindings.ts";
export type { RelationMaterialBinding, RenderRelationGeometryWitness } from "#render2d/relation-bindings.ts";
import type { FilamentUniformMaterial } from "#render2d/filament-program.ts";
import {
  buildRenderModel,
  edgeLabelCandidatesForState,
  edgeAttributesForVisualState,
  nodeAttributesForVisualState,
  renderOptionsForVisualState,
  resolveRenderOptions,
  resolveLabelIds,
  selectedProvenanceForVisualState,
  prepareProjection2d,
  projection2dVisibilityKey,
  projection2dRevisionAction,
  mountProjectionLabelOverlay,
  EMPTY_LABEL_BOUNDS,
  readProjectionStyle,
  typedLabelKind,
  typedLabelTexts,
  typedRgbaColor,
  TYPED_LABEL_CAMERA,
  buildScreenPickIndex,
} from "#render2d/model.ts";
import type {
  LabelPlacementCandidate,
  ProjectionLabelCandidate,
  RenderEdgeAttributes,
  RenderModel,
  RenderNodeAttributes,
  RenderOptions,
  Projection2dScene,
  ScreenPickIndex,
  ScreenPickSegment,
} from "#render2d/model.ts";
import type { PickResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection, Vec2 } from "../projection/contract-types.ts";
import { createProjectionVisualsLayer } from "#render-common/projection-visuals-layer.ts";
import type { ProjectionVisualsMorphology } from "#render-common/projection-visuals-layer.ts";
import { ALL_EDGES_QUALITY_STAGE, FULL_QUALITY_STAGE, QualityLadder, mainRelation, presentRenderReadiness } from "#render-common/quality-ladder.ts";
import { createPresentedPublisher } from "#render-common/presented-publisher.ts";
// "D086-BURST BEGIN"
import { renderReadinessHost } from "#render-common/render-readiness-producer.ts";
// "D086-BURST END"
// Size-fix BEGIN
import { canvasNodeFloorPx, createNativeSizeLaw, geometryDegrees } from "#render-common/native-node-law.ts";
// Size-fix END
// "D082-A-NODES BEGIN"
import { denseNativeEdgeAlpha } from "#render-common/dense-node-scale.ts";
// "D082-A-NODES END"

/** Sigma multiplies its camera ratio by this factor for each wheel notch. */
export const TWO_D_ZOOMING_RATIO = 1 + 1 / (2 * 2);

/** This reports one live glow footprint and does not expose graph semantics. */
export type RenderNodeGlowWitness = {
  readonly id: string;
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly coreRadiusPx: number;
  readonly haloRadiusPx: number;
};

/** This records ids and incidence read from the mounted Sigma graph and does not inspect the render model. */
export type RenderSurfaceWitness = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
};

/** This records one real stacked-material rejection and does not leave the live renderer stacked. */
export type StackedMaterialControlWitness = {
  readonly relationId: string;
  readonly materialTypes: readonly string[];
  readonly message: string;
};

/** This reports the mounted renderer's live picking surface without exposing its Sigma instance. */
export type RenderPickingSurface = {
  readonly pixelRatio: number;
  readonly downSizingRatio: number;
  readonly drawingBufferHeight: number;
  readonly width: number;
  readonly height: number;
  readonly sizeRatio: number;
  readonly minEdgeThickness: number;
};

/** The review page owns hover and click picking. Sigma's private captor listeners otherwise
 * read the WebGL picking buffers on every move, press, release and wheel event as well. Keep
 * the captors themselves attached so panning, zooming and touch camera gestures still work. */
export function suppressSigmaAutomaticPicking(sigma: Sigma): void {
  type Listener = (...args: never[]) => void;
  type Captor = { off(event: string, listener: Listener): unknown };
  const hooked = sigma as unknown as {
    activeListeners: Record<string, Listener>;
    getMouseCaptor(): Captor;
    getTouchCaptor(): Captor;
  };
  const mouse = hooked.getMouseCaptor();
  const touch = hooked.getTouchCaptor();
  for (const [event, name] of [
    ["mousemove", "handleMove"], ["mousedown", "handleDown"], ["mouseup", "handleUp"],
    ["wheel", "handleWheel"], ["click", "handleClick"], ["rightClick", "handleRightClick"],
    ["doubleClick", "handleDoubleClick"],
  ] as const) mouse.off(event, hooked.activeListeners[name]!);
  for (const [event, name] of [
    ["touchdown", "handleDown"], ["touchdown", "handleMove"], ["touchup", "handleUp"],
    ["touchmove", "handleMove"], ["tap", "handleClick"], ["doubletap", "handleDoubleClick"],
  ] as const) touch.off(event, hooked.activeListeners[name]!);
}

/** A synchronous click path and a coalesced hover path over the same picker. */
export function createPointerPickGate<T>(
  pick: (position: Vec2) => T | null,
  deliverHover: (position: Vec2, result: T | null) => void,
  cameraMoving: () => boolean,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
): {
  move(position: Vec2): void; press(position: Vec2): void; release(position: Vec2): void;
  cancel(): void; leave(): void; click(position: Vec2): T | null | undefined;
  hoverResult(): T | null; dragged(): boolean; destroy(): void;
} {
  let pressed: Vec2 | null = null;
  let didDrag = false;
  let latest: Vec2 | null = null;
  let hover: T | null = null;
  let frame = 0;
  const schedule = () => {
    if (frame || latest === null || pressed !== null) return;
    frame = requestFrame(() => {
      frame = 0;
      if (pressed !== null || latest === null) return;
      if (cameraMoving()) { schedule(); return; }
      const position = latest;
      latest = null;
      hover = pick(position);
      deliverHover(position, hover);
    });
  };
  const move = (position: Vec2) => {
    if (pressed !== null) {
      if (Math.hypot(position.x - pressed.x, position.y - pressed.y) > PROJECTION_CLICK_DRAG_TOLERANCE_PX) didDrag = true;
      return;
    }
    latest = position;
    schedule();
  };
  const leave = () => { latest = null; hover = null; if (frame) cancelFrame(frame); frame = 0; };
  return {
    move,
    press(position) { leave(); pressed = position; didDrag = false; },
    release(position) {
      if (pressed !== null && Math.hypot(position.x - pressed.x, position.y - pressed.y) > PROJECTION_CLICK_DRAG_TOLERANCE_PX) didDrag = true;
      pressed = null;
    },
    cancel() { leave(); pressed = null; didDrag = true; },
    leave,
    click(position) {
      if (didDrag) { didDrag = false; return undefined; }
      pressed = null;
      return pick(position);
    },
    hoverResult: () => hover,
    dragged: () => didDrag,
    destroy: leave,
  };
}

/** This is one mounted renderer and does not retain an independent graph copy. */
export type RenderHandle = {
  readonly model: RenderModel;
  /** Changes the distinct canvas appearance without repeating layout or remounting Sigma. */
  setAppearance(options: AppearanceOptions): void;
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
  readCameraState(): RenderCameraState;
  isCameraAnimating(): boolean;
  restoreCameraState(state: RenderCameraState): void;
  /** This reports the serialisable view state and does not expose graph semantics. */
  readVisualState(): VisualState;
  /** This selects one existing graph element and changes material only. */
  setSelection(id: string): void;
  /** This clears selection and restores the unselected material. */
  clearSelection(): void;
  /** This reports the selected graph element id without returning graph contents. */
  getSelection(): string | null;
  /** This focuses one existing graph element and dims material outside that singleton focus set. */
  setFocus(id: string): void;
  setEmphasis(ids: ReadonlySet<string> | null): void;
  /** This clears focus and restores undimmed material. */
  clearFocus(): void;
  /** This reports the focused graph element id without returning graph contents. */
  getFocus(): string | null;
  /** This changes only selection/focus material factors and preserves the mounted graph and its anchors. */
  setSelectionFocusFactors(factors: Readonly<Pick<CalibrationProfile["selection"], "emphasisMultiplierPermille" | "focusDimFactorPermille">> | undefined): void;
  /** This controls interaction-driven relation-label reveal without changing relation material or topology. */
  setEdgeLabelRevealVisible(visible: boolean): void;
  /** This returns the selected element's existing graph derivation record and does not synthesise provenance. */
  readSelectedProvenance(): DerivedValue | null;
  /** This reports live glow geometry and does not inspect an offscreen canvas. */
  readGlowWitnesses(): readonly RenderNodeGlowWitness[];
  /** This controls glow compositing and does not change graph material. */
  setGlowVisible(visible: boolean): void;
  /** This reports the material programs bound to each live relation and does not expose semantic payload. */
  readRelationMaterialBindings(): readonly RelationMaterialBinding[];
  /** This reports control points from the live program attribute buffer and does not recalculate curve geometry. */
  readRelationGeometryWitnesses(): readonly RenderRelationGeometryWitness[];
  /** This reports node and relation ids from mounted Sigma state and does not read the render model. */
  readSurfaceWitness(): RenderSurfaceWitness;
  /** This reports world anchors from MOUNTED renderer state and does not read the model that fed it. */
  readWorldAnchorWitnesses(): readonly WorldAnchorWitness[];
  /** This counts layout passes this handle has run since mount and does not run one. */
  readLayoutPassCount(): number;
  /** This names the camera this renderer draws through and does not offer to change it. */
  readonly cameraKind: CameraKind;
  /** This reports live drawn node footprints under the name every renderer answers to. */
  readNodeFootprintWitnesses(): readonly NodeFootprintWitness[];
  /** This stacks two live programs for one relation, renders them, and restores the single-program pipeline. */
  proveStackedMaterialControlRejects(): StackedMaterialControlWitness;
  /** This returns the node the mounted renderer itself picks at one viewport position. */
  pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null;
  /** This returns the edge the mounted renderer itself picks at one viewport position. */
  pickEdgeAtPoint(x: number, y: number): string | null;
  /** This reports the mounted renderer's picking metrics without creating a second renderer. */
  readPickingSurface(): RenderPickingSurface;
  /** This converts a live node size into the mounted renderer's viewport scale. */
  scaleSize(size: number): number;
  /** Swaps the drawn level-of-detail subset in place — the mounted Sigma graph, its
   * picking buffers and the camera are untouched; only the distinct canvas's geometry snapshot
   * and style lookups move. A no-op when no distinct canvas is mounted. */
  updateVisibleSubset(update: DistinctSubsetUpdate): void;
  destroy(): void;
};

/** This records the camera and its world framing and does not retain a Sigma instance. */
export type RenderCameraState = CameraState & {
  readonly bounds: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  };
};

/** This is one explicit Sigma framing box and does not change world anchors. */
export type RenderFramingBox = {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
};

/** This mounts the WebGL boundary and does not derive a second supplied placement. */
export function mount(
  container: HTMLElement,
  visualGraph: VisualGraph,
  options: RenderOptions,
  framingBox?: RenderFramingBox,
  initialVisualState?: VisualState,
  suppliedAnchors?: LayoutAnchors,
  // "D082-A-PERF BEGIN"
  preparedModel?: RenderModel,
  // "D082-A-PERF END"
): RenderHandle {
  const suppliedState = initialVisualState === undefined
    ? undefined
    : createRenderVisualState(visualGraph, initialVisualState);
  const activeOptions = resolveRenderOptions(suppliedState === undefined ? options : renderOptionsForVisualState(options, suppliedState));
  const modelOptions = activeOptions.presentation?.emphasisIds
    ? { ...activeOptions, presentation: { ...activeOptions.presentation, emphasisIds: null } }
    : activeOptions;
  // "D082-A-PERF BEGIN"
  const model = preparedModel ?? buildRenderModel(visualGraph, modelOptions, undefined, suppliedAnchors);
  // "D082-A-PERF END"
  // Incremented where layout is actually resolved, so the number is a record of what ran rather
  // than a literal describing what is expected to have run.
  const layoutPasses = suppliedAnchors === undefined ? 1 : 0;
  const calibration = activeOptions.calibration ?? DEFAULT_CALIBRATION;
  const baseNodeAttributes = new Map<string, RenderNodeAttributes>(
    model.graph.nodes().map((id) => [id, model.graph.getNodeAttributes(id)]),
  );
  const baseEdgeAttributes = new Map<string, RenderEdgeAttributes>(
    model.graph.edges().map((id) => [id, model.graph.getEdgeAttributes(id)]),
  );
  // A-PERF BEGIN: label opacity always starts from the current visual state's
  // unmodified colour. Reapplying it to the previous label colour made every
  // settled pass mutate Graphology and schedule another full Sigma refresh.
  const edgeLabelBaseColors = new Map<string, string>(
    [...baseEdgeAttributes].map(([id, attributes]) => [id, attributes.labelColor]),
  );
  const placeCurrentEdgeLabels = () => {
    // "D082-A-PERF BEGIN": product DOM labels only — skip ranking hidden Sigma labels.
    if (!nativeLabelsUsed) return;
    // "D082-A-PERF END"
    // "D082-A-PERF BEGIN": the product view supplies its own DOM labels and sets
    // nativeLabels=false. Ranking every hidden Sigma label cost over a second
    // on Completa entry while renderEdgeLabels remained false throughout.
    // "D082-A-PERF END"
    placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible, edgeLabelBaseColors);
  };
  // A-PERF END
  // "D082-A-NODES BEGIN"
  const nativeEdgeVeilById = new Map<string, number>([...(activeOptions.presentation?.edges ?? [])]
    .filter(([, edge]) => edge.denseVeilBaseOpacityPermille !== undefined)
    .map(([id, edge]) => [id, edge.denseVeilFactor ?? 1]));
  const nativeEdgeVeilFloorById = new Set<string>([...(activeOptions.presentation?.edges ?? [])]
    .filter(([, edge]) => (edge as typeof edge & { denseNativeAlphaFloor?: boolean }).denseNativeAlphaFloor === true)
    .map(([id]) => id));
  const withNativeEdgeVeil = (id: string, color: string): string => {
    const factor = id === currentState.selectedId || id === currentState.focusedId ? 1 : nativeEdgeVeilById.get(id) ?? 1;
    if (factor === 1) return color;
    const parsed = parseColor(color);
    // Sigma's native edge colour is encoded into a byte alpha channel. The Completa
    // screen-density model can request sub-byte alpha, so preserve a two-byte visible veil.
    const alpha = denseNativeEdgeAlpha(parsed.a, factor, nativeEdgeVeilFloorById.has(id));
    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
  };
  // "D082-A-NODES END"
  const materialBindings = createLiveRelationMaterialBindings();
  const geometryBindings = createLiveRelationGeometryBindings();
  // The distinct morphology canvas covers the WebGL tiers. Keep the compatibility picking
  // buffer for renderer witnesses while suppressing the invisible full-DPR screen pass.
  const screenPaint = { enabled: true };
  const nativeLabelsUsed = activeOptions.presentation?.nativeLabels !== false;
  const edgeProgramClasses = {
    filament: createObservedFilamentProgram(model.filamentMaterial, "filament", materialBindings, geometryBindings, screenPaint),
  };
  const sigma = new Sigma(model.graph, container, {
    defaultEdgeType: "filament",
    edgeProgramClasses,
    nodeProgramClasses: { circle: createPickingCapableNodeProgram(screenPaint) },
    renderLabels: nativeLabelsUsed && model.material.node.includes("label"),
    renderEdgeLabels: false,
    labelSize: calibration.labels.nodeLabelSizePx,
    edgeLabelSize: calibration.labels.edgeLabelSizePx,
    labelColor: { attribute: "labelColor", color: requiredTokenColor(model, "text") },
    edgeLabelColor: { attribute: "labelColor", color: requiredTokenColor(model, "textMuted") },
    zoomingRatio: TWO_D_ZOOMING_RATIO,
    zIndex: true,
    enableEdgeEvents: true,
  });
  suppressSigmaAutomaticPicking(sigma);
  const picking = sigma as unknown as {
    readonly webGLContexts: {
      readonly edges: {
        readonly drawingBufferHeight: number;
      };
    };
  };
  materialBindings.observe(sigma);
  geometryBindings.observe(sigma);
  if (framingBox !== undefined) {
    sigma.setCustomBBox(copyFramingBox(framingBox));
    sigma.refresh();
  }
  if (suppliedState !== undefined) {
    restoreCameraState(sigma, cameraStateFromVisualState(suppliedState.camera));
  }
  // The full material witness walks every relation at mount.
  if (renderDebugAssertionsEnabled()) assertSingleMaterialPerRelation(liveRelationMaterialBindings(sigma, materialBindings));
  let currentState = suppliedState ?? createRenderVisualState(visualGraph, {
    selectedId: null,
    focusedId: null,
    camera: readCameraState(sigma),
    cameraKind: ORTHOGRAPHIC,
    morphology: activeOptions.morphology,
    organization: activeOptions.organization,
    palette: activeOptions.palette,
    temperature: activeOptions.temperature,
    theme: activeOptions.theme,
    lodBand: activeOptions.lodBand,
    reducedMotion: activeOptions.reducedMotion,
  });
  let appearanceCalibration = calibration;
  let emphasisIds = activeOptions.presentation?.emphasisIds ?? null;
  let edgeLabelRevealVisible = true;
  const dimmedNode = <T extends { color: string; haloIntensityPermille: number }>(attributes: T): T => ({
    ...attributes,
    color: mixTowardField(attributes.color, model.fieldColor, calibration.selection.focusDimFactorPermille),
    haloIntensityPermille: Math.round(
      (attributes.haloIntensityPermille * calibration.selection.focusDimFactorPermille) / SCENE_PERMILLE_SCALE,
    ),
  });
  const applyVisualStateAppearance = (): void => {
    for (const [id, attributes] of baseNodeAttributes) {
      const adjusted = nodeAttributesForVisualState(attributes, id, currentState, appearanceCalibration);
      model.graph.replaceNodeAttributes(id, emphasisIds && !emphasisIds.has(id) ? dimmedNode(adjusted) : adjusted);
    }
    for (const [id, attributes] of baseEdgeAttributes) {
      const adjusted = edgeAttributesForVisualState(attributes, id, currentState, appearanceCalibration);
      const bright = emphasisIds === null || (
        emphasisIds.has(model.graph.source(id)) && emphasisIds.has(model.graph.target(id))
      );
      // "D082-A-NODES BEGIN": the Completa veil factor applies to the native edge colour (A-PERF keeps the base label colour)
      const next = bright ? { ...adjusted, color: withNativeEdgeVeil(id, adjusted.color) } : {
        ...adjusted,
        color: withNativeEdgeVeil(id, mixTowardField(adjusted.color, model.fieldColor, calibration.selection.focusDimFactorPermille)),
      };
      // "D082-A-NODES END"
      // A-PERF BEGIN
      edgeLabelBaseColors.set(id, next.labelColor);
      model.graph.replaceEdgeAttributes(id, next);
      // A-PERF END
    }
    sigma.refresh();
  };
  const refreshCameraInVisualState = (): VisualState => createRenderVisualState(visualGraph, {
    ...currentState,
    camera: readCameraState(sigma),
  });
  const updateVisualState = (selection: string | null, focus: string | null): void => {
    currentState = createRenderVisualState(visualGraph, {
      ...refreshCameraInVisualState(),
      selectedId: selection,
      focusedId: focus,
    });
    applyVisualStateAppearance();
    placeCurrentEdgeLabels();
  };
  // "D082-A-NODES BEGIN"
  if (currentState.selectedId !== null || currentState.focusedId !== null || emphasisIds !== null || nativeEdgeVeilById.size > 0) {
    applyVisualStateAppearance();
  }
  // "D082-A-NODES END"
  // "D082-A-PERF BEGIN"
  if (nativeLabelsUsed) placeNodeLabels(sigma, model, calibration);
  // "D082-A-PERF END"
  placeCurrentEdgeLabels();
  // Mount the aggregate windows FIRST and the glow second, then render once more.
  // Each layer calls sigma.resize(true) when it is created, and a resize clears
  // every 2D layer -- so whichever layer is created last silently wipes the one
  // created before it, and only a subsequent render puts it back. Measured: the
  // glow drew correctly inside its own draw() and read back fully transparent
  // afterwards, because no render followed the windows' resize. Creating the glow
  // last, and refreshing after both, means neither layer can be left blank.
  // DOM order is set by insertion, not by creation order, so the glow still sits
  // BELOW the windows: atmosphere does not occlude structure.
  const windows = mountAggregateWindows(sigma, model, options.calibration);
  const distinctLanguage = activeOptions.presentation?.morphologyLanguage === "distinct";
  const glow = model.material.node.includes("halo") && !(distinctLanguage && model.graph.order >= DENSE_SCENE_THRESHOLD)
    ? mountNodeGlow(sigma, model, options.calibration, !distinctLanguage)
    : noGlowLayer();
  const distinct = distinctLanguage
    ? mountDistinctCanvas(sigma, model, activeOptions, screenPaint)
    : null;
  sigma.refresh();
  let handlePickGeometry = activeOptions.presentation?.morphologyGeometry;
  let handlePickIndex: ScreenPickIndex;
  let handlePickFrame = '';
  let handlePickSettleTimer: ReturnType<typeof setTimeout> | undefined;
  // Size-fix BEGIN: a dense Lab scene draws its GPU discs at the radius the morphology
  // canvas gives the same node, so the density never changes a node's size. The canvas keeps
  // reading the encoded radius; only Sigma's size attribute follows the settled camera scale.
  const nativeSizeLaw = model.graph.order >= DENSE_SCENE_THRESHOLD
    ? createNativeSizeLaw({
      morphology: activeOptions.morphology,
      active: activeOptions.presentation?.nativeNodeSizeLaw === true,
      given: new Map([...baseNodeAttributes].map(([id, attributes]) => [id, attributes.size] as const)),
      degree: geometryDegrees(activeOptions.presentation?.morphologyGeometry),
      projectedScale: () => sigma.scaleSize(1),
      floorPx: () => canvasNodeFloorPx(activeOptions.morphology, sigma.getContainer().closest('[data-fractal-rails-active]') !== null),
      write: sizes => {
        for (const [id, size] of sizes) {
          const base = baseNodeAttributes.get(id);
          if (base) baseNodeAttributes.set(id, { ...base, size });
        }
        applyVisualStateAppearance();
      },
    }) : null;
  // Size-fix END
  const rebuildHandlePickIndex = () => {
    // Size-fix BEGIN
    nativeSizeLaw?.settle();
    // Size-fix END
    if (handlePickSettleTimer !== undefined) { clearTimeout(handlePickSettleTimer); handlePickSettleTimer = undefined; }
    const dimensions = sigma.getDimensions();
    const discs = model.graph.nodes().sort((a, b) => model.graph.getNodeAttribute(a, 'zIndex') - model.graph.getNodeAttribute(b, 'zIndex'))
      .map(id => {
        const attributes = model.graph.getNodeAttributes(id);
        const p = sigma.graphToViewport(attributes);
        return { id, x: p.x, y: p.y, radius: sigma.scaleSize(attributes.size) + 2 };
      });
    const edges: ScreenPickSegment[] = [];
    if (handlePickGeometry) {
      for (const part of handlePickGeometry.drawnSegments) for (let i = 1; i < part.samples.length; i++) {
        const a = sigma.graphToViewport(part.samples[i - 1]!), b = sigma.graphToViewport(part.samples[i]!);
        edges.push({ id: part.edgeId, ax: a.x, ay: a.y, bx: b.x, by: b.y,
          tolerance: calibration.filament.pickTolerancePx * (2 + 1) + 1 });
      }
    } else for (const id of model.graph.edges()) {
      const a = sigma.graphToViewport(model.graph.getNodeAttributes(model.graph.source(id)));
      const b = sigma.graphToViewport(model.graph.getNodeAttributes(model.graph.target(id)));
      edges.push({ id, ax: a.x, ay: a.y, bx: b.x, by: b.y,
        tolerance: model.graph.getEdgeAttribute(id, 'pickTolerancePx') });
    }
    handlePickIndex = buildScreenPickIndex(discs, [], edges, dimensions.width, dimensions.height);
    handlePickFrame = JSON.stringify([sigma.getCamera().getState(), dimensions.width, dimensions.height]);
  };
  rebuildHandlePickIndex();
  sigma.on('afterRender', () => {
    const dimensions = sigma.getDimensions();
    const frame = JSON.stringify([sigma.getCamera().getState(), dimensions.width, dimensions.height]);
    if (frame !== handlePickFrame) {
      if (handlePickSettleTimer !== undefined) clearTimeout(handlePickSettleTimer);
      handlePickSettleTimer = setTimeout(() => { handlePickSettleTimer = undefined; rebuildHandlePickIndex(); }, 2 ** (2 + 2 + 2 + 1));
    }
  });
  return {
    model,
    setAppearance(appearance: AppearanceOptions): void {
      model.filamentMaterial.neuralWidthPx = appearance.edgeWidth;
      if (model.graph.order >= DENSE_SCENE_THRESHOLD) sigma.refresh();
      distinct?.setAppearance(appearance);
      rebuildHandlePickIndex();
    },
    updateVisibleSubset(update: DistinctSubsetUpdate): void {
      distinct?.updateVisibleSubset(update);
      // Size-fix BEGIN
      nativeSizeLaw?.retarget(update.nativeNodeSizeLaw === true, new Map([...update.nodeEntries].flatMap(([id, entry]) =>
        entry.radiusPx === undefined ? [] : [[id, entry.radiusPx] as const])), geometryDegrees(update.geometry));
      // Size-fix END
      // "D082-A-NCOMPLETA2 BEGIN": the settled fit arrives after Sigma's prepared model.
      // Keep its native node tier and the visual-state baseline on the same radii as
      // the distinct canvas; a graph write after refresh leaves the old discs on screen.
      let nativeNodeStyleChanged = false;
      // "D082-A-VEIL2 BEGIN: A-INT12 leaves the native Stellar/Mycelium tier"
      // untouched on a subset refresh. Only Neural needs its post-fit soma settle.
      if (activeOptions.morphology === "neural") for (const [id, entry] of update.nodeEntries) {
        const base = baseNodeAttributes.get(id);
        if (!base || entry.radiusPx === undefined) continue;
        // "D086-F1 BEGIN": retain the settled native law size while updating Neural's halo.
        baseNodeAttributes.set(id, nativeNodePresentationBase(base, entry, nativeSizeLaw !== null && update.nativeNodeSizeLaw === true));
        // "D086-F1 END"
        nativeNodeStyleChanged = true;
      }
      // "D082-A-VEIL2 END"
      // "D082-A-NCOMPLETA2 END"
      // "D082-A-NODES BEGIN"
      if (nativeEdgeVeilById.size || nativeNodeStyleChanged) {
        for (const [id, entry] of update.edgeEntries) if (entry.presentation) {
          nativeEdgeVeilById.set(id, entry.presentation.denseVeilFactor ?? 1);
          // "D082-A-NCOMPLETA3 BEGIN": a fit updates the native white root too.
          const base = baseEdgeAttributes.get(id);
          // "D082-A-VEIL2 BEGIN: preserve the non-Neural edge baseline"
          if (activeOptions.morphology === "neural" && base) baseEdgeAttributes.set(id, { ...base,
            neuralDenseFactor: entry.presentation.neuralDenseFactor ?? 1 });
          // "D082-A-VEIL2 END"
          // "D082-A-NCOMPLETA3 END"
        }
        applyVisualStateAppearance();
      }
      // "D082-A-NODES END"
      handlePickGeometry = update.geometry;
      rebuildHandlePickIndex();
    },
    graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
      return sigma.graphToViewport(point);
    },
    readCameraState(): RenderCameraState {
      return readCameraState(sigma);
    },
    isCameraAnimating(): boolean {
      return sigma.getCamera().isAnimated();
    },
    restoreCameraState(state: RenderCameraState): void {
      restoreCameraState(sigma, state);
      currentState = createRenderVisualState(visualGraph, { ...currentState, camera: state });
      // "D082-A-PERF BEGIN": without the hidden-label pass, keep the one refresh the framing needs.
      if (!nativeLabelsUsed) sigma.refresh();
      // "D082-A-PERF END"
      // "D082-A-PERF BEGIN"
      if (nativeLabelsUsed) placeNodeLabels(sigma, model, calibration);
      // "D082-A-PERF END"
      placeCurrentEdgeLabels();
    },
    readVisualState(): VisualState {
      currentState = refreshCameraInVisualState();
      return currentState;
    },
    setSelection(id: string): void {
      updateVisualState(id, currentState.focusedId);
    },
    clearSelection(): void {
      updateVisualState(null, currentState.focusedId);
    },
    getSelection(): string | null {
      return currentState.selectedId;
    },
    setEmphasis(ids: ReadonlySet<string> | null): void {
      emphasisIds = ids;
      applyVisualStateAppearance();
    },
    setFocus(id: string): void {
      updateVisualState(currentState.selectedId, id);
    },
    clearFocus(): void {
      updateVisualState(currentState.selectedId, null);
    },
    getFocus(): string | null {
      return currentState.focusedId;
    },
    setSelectionFocusFactors(factors): void {
      appearanceCalibration = factors === undefined
        ? calibration
        : {
            ...calibration,
            selection: {
              ...calibration.selection,
              ...factors,
            },
          };
      applyVisualStateAppearance();
      placeCurrentEdgeLabels();
    },
    setEdgeLabelRevealVisible(visible: boolean): void {
      edgeLabelRevealVisible = visible;
      placeCurrentEdgeLabels();
    },
    readSelectedProvenance(): DerivedValue | null {
      return selectedProvenanceForVisualState(visualGraph, currentState);
    },
    readGlowWitnesses(): readonly RenderNodeGlowWitness[] {
      return glow.readWitnesses();
    },
    setGlowVisible(visible: boolean): void {
      glow.setVisible(visible);
    },
    readRelationMaterialBindings(): readonly RelationMaterialBinding[] {
      return liveRelationMaterialBindings(sigma, materialBindings);
    },
    readRelationGeometryWitnesses(): readonly RenderRelationGeometryWitness[] {
      return liveRelationGeometryWitnesses(sigma, geometryBindings);
    },
    // Read from the graph Sigma is actually holding, not from `model.anchors`, so a parity check
    // asking whether a camera change moved an anchor is answered by the mounted renderer rather
    // than by the model that fed it — comparing a model with itself would pass forever.
    readWorldAnchorWitnesses(): readonly WorldAnchorWitness[] {
      return model.graph.nodes().map((id) => {
        const attributes = model.graph.getNodeAttributes(id) as { readonly x: number; readonly y: number };
        return { id, position: { x: attributes.x, y: attributes.y, z: 0 } };
      });
    },
    // Sigma runs layout once, at mount, and has no camera change that could run another. The count
    // is therefore a constant here — and it is reported rather than omitted, because a parity check
    // needs the same question answered by every renderer to mean anything.
    readLayoutPassCount(): number {
      return layoutPasses;
    },
    cameraKind: ORTHOGRAPHIC,
    // The same live footprints `readGlowWitnesses` reports, under the name every renderer answers to.
    // One reading, two names: the older one is this renderer's own vocabulary and is kept because its
    // existing evidence cites it; the common one exists so a parity check can ask all three renderers
    // the same question.
    readNodeFootprintWitnesses(): readonly NodeFootprintWitness[] {
      return glow.readWitnesses();
    },
    readSurfaceWitness(): RenderSurfaceWitness {
      return liveSurfaceWitness(sigma);
    },
    proveStackedMaterialControlRejects(): StackedMaterialControlWitness {
      const bindings = liveRelationMaterialBindings(sigma, materialBindings);
      const relation = bindings[0];
      if (relation === undefined) {
        throw new TypeError("stacked-material control requires one live relation binding");
      }
      const originalProgramClasses = sigma.getSetting("edgeProgramClasses");
      const stackedProgram = createEdgeCompoundProgram([
        createObservedFilamentProgram(model.filamentMaterial, "filament", materialBindings, geometryBindings, screenPaint),
        createObservedFilamentProgram(model.filamentMaterial, "filament-control", materialBindings, geometryBindings, screenPaint),
      ]);
      try {
        sigma.setSetting("edgeProgramClasses", { ...originalProgramClasses, filament: stackedProgram });
        sigma.refresh();
        const stacked = liveRelationMaterialBindings(sigma, materialBindings);
        const stackedRelation = stacked.find((binding) => binding.relationId === relation.relationId);
        if (stackedRelation === undefined) {
          throw new TypeError(`stacked-material control lost live relation ${relation.relationId}`);
        }
        let message: string | undefined;
        try {
          assertSingleMaterialPerRelation(stacked);
        } catch (error: unknown) {
          message = error instanceof Error ? error.message : String(error);
        }
        if (message === undefined) {
          throw new TypeError("stacked-material control did not fail the live material assertion");
        }
        return { relationId: relation.relationId, materialTypes: stackedRelation.materialTypes, message };
      } finally {
        try {
          sigma.setSetting("edgeProgramClasses", originalProgramClasses);
        } finally {
          sigma.refresh();
        }
      }
    },
    pickNodeAtPosition(position): string | null {
      return handlePickIndex.nodeAt(position);
    },
    pickEdgeAtPoint(x: number, y: number): string | null {
      return handlePickIndex.edgeAt({ x, y });
    },
    readPickingSurface(): RenderPickingSurface {
      const { pixelRatio, downSizingRatio, sizeRatio, minEdgeThickness } = sigma.getRenderParams();
      const dimensions = sigma.getDimensions();
      return {
        pixelRatio,
        downSizingRatio,
        drawingBufferHeight: picking.webGLContexts.edges.drawingBufferHeight,
        width: dimensions.width,
        height: dimensions.height,
        sizeRatio,
        minEdgeThickness,
      };
    },
    scaleSize(size: number): number {
      return sigma.scaleSize(size);
    },
    destroy(): void {
      if (handlePickSettleTimer !== undefined) clearTimeout(handlePickSettleTimer);
      distinct?.destroy();
      glow.destroy();
      windows.destroy();
      sigma.kill();
    },
  };
}

/** This is the switch every distinct-path program consults before its invisible screen pass. */
export type ScreenPaintControl = { enabled: boolean };

/** This plans which Sigma layers the distinct canvas may collapse and does not touch a renderer. */
export type DistinctLayerPolicy = {
  /** Layers that never answer anything: display none, backing collapsed to one pixel. */
  readonly collapse: readonly string[];
  /** Compatibility WebGL picking surfaces: hidden, with their full backing retained. */
  readonly pickingOnly: readonly string[];
  /** The captor surface: stays visible for events, backing collapsed to one pixel. */
  readonly shrinkBacking: readonly string[];
};

/**
 * This resolves the distinct path's layer plan from what actually draws. The morphology canvas
 * paints nodes, arcs and containers; DOM labels paint names; the page owns hover. What remains
 * per Sigma layer is picking (`nodes`, `edges`) and event capture (`mouse`), so everything else
 * is removed from compositing instead of merely being repainted blank every frame.
 */
export function distinctLayerPolicy(input: { nativeTier: boolean; nativeLabelsUsed: boolean }): DistinctLayerPolicy {
  const collapse = input.nativeLabelsUsed ? ["hovers", "hoverNodes"] : ["labels", "edgeLabels", "hovers", "hoverNodes"];
  return {
    collapse,
    pickingOnly: input.nativeTier ? [] : ["edges", "nodes"],
    shrinkBacking: ["mouse"],
  };
}

/** The opt-in canvas follows Sigma's camera while its original passes retain picking and witnesses. */
function mountDistinctCanvas(
  sigma: Sigma,
  model: RenderModel,
  options: RenderOptions,
  screenPaint: ScreenPaintControl,
): {
  setAppearance(options: AppearanceOptions): void;
  updateVisibleSubset(update: DistinctSubsetUpdate): void;
  destroy(): void;
} {
  const graph = model.graph;
  const perfMarksEnabled = new URLSearchParams(location.search).has('perfmarks');
  const buildGeometry = (curvature: number) => buildMorphologyGeometry(
    options.morphology,
    graph.nodes().map((id) => {
      const node = graph.getNodeAttributes(id);
      return { id, position: { x: node.x, y: node.y, z: 0 }, radius: node.size };
    }),
    graph.edges().map((id) => ({ id, source: graph.source(id), target: graph.target(id), width: graph.getEdgeAttributes(id).size })),
    model.windows.map((window) => ({ id: window.id, members: window.members, center: window.center })),
    curvature,
    options.presentation?.containers,
  );
  const shared = options.presentation?.morphologyInput;
  let sharedInput = shared;
  const sharedGeometry = (curvature: number) => sharedInput
    ? buildMorphologyGeometry(options.morphology, sharedInput.nodes, sharedInput.edges, sharedInput.colonies, curvature, sharedInput.containers)
    : buildGeometry(curvature);
  let geometry = options.presentation?.morphologyGeometry ?? sharedGeometry(options.presentation?.appearance?.curvature ?? DEFAULT_APPEARANCE.curvature);
  const canvas = document.createElement("canvas");
  canvas.dataset.morphologyCanvas = "distinct";
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
  requiredCanvas(sigma, "labels").before(canvas);
  const nativeTier = graph.order >= DENSE_SCENE_THRESHOLD;
  const layerPolicy = distinctLayerPolicy({
    nativeTier,
    nativeLabelsUsed: options.presentation?.nativeLabels !== false,
  });
  const collapsed = layerPolicy.collapse
    .map((id) => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousDisplay = collapsed.map((item) => item.style.display);
  const previousBacking = collapsed.map((item) => [item.width, item.height] as const);
  const shrinkable = layerPolicy.shrinkBacking
    .map((id) => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousShrinkBacking = shrinkable.map((item) => [item.width, item.height] as const);
  const detached = layerPolicy.pickingOnly
    .map((id) => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousDetachedDisplay = detached.map((item) => item.style.display);
  const collapseLayer = (): void => {
    // One pixel, not zero: a canvas keeps its context and its measureText surface either way,
    // and 1×1 keeps the backing store alive without a full-DPR buffer to composite or clear.
    for (const item of collapsed) {
      item.style.display = "none";
      item.width = 1;
      item.height = 1;
    }
    for (const item of shrinkable) {
      item.width = 1;
      item.height = 1;
    }
  };
  collapseLayer();
  // Sigma's own resize restores every layer it owns to full backing size; this listener is what
  // keeps the collapsed plan true after a window resize without fighting the renderer.
  sigma.on("resize", collapseLayer);
  if (!nativeTier) {
    screenPaint.enabled = false;
    for (const item of detached) item.style.display = "none";
  }
  let appearance = options.presentation?.appearance ?? DEFAULT_APPEARANCE;
  const context = canvas.getContext("2d");
  // "D082-A-NCOMPLETA2 BEGIN": a subset revision changes these map identities so
  // the projected soma/edge paint cache sees the new fitted styles.
  let nodeStyles = new Map(graph.nodes().map((id) => [id, {
    color: graph.getNodeAttributes(id).color,
    glyph: options.presentation?.nodes?.get(id)?.glyph,
    radiusPx: options.presentation?.nodes?.get(id)?.radiusPx,
  }]));
  let edgeStyles = new Map<string, { color: string; presentation: import("#engine/presentation-options.ts").EdgePresentation | undefined }>(graph.edges().map((id) => [id, {
    color: graph.getEdgeAttributes(id).color,
    presentation: options.presentation?.edges?.get(id),
  }]));
  let mainEdgeIds = new Set(graph.edges().filter(id => {
    const source = graph.source(id), target = graph.target(id);
    const category = options.presentation?.edges?.get(id)?.category;
    const sourceGlyph = options.presentation?.nodes?.get(source)?.glyph;
    const targetGlyph = options.presentation?.nodes?.get(target)?.glyph;
    return mainRelation({ attested: category === 'attested', exploratory: category === 'exploratory',
      selectedIncident: !!(options.presentation?.emphasisIds?.has(source) || options.presentation?.emphasisIds?.has(target)),
      sourceHub: sourceGlyph === 'double-ring', targetHub: targetGlyph === 'double-ring',
      sourceDomain: sourceGlyph === 'ring', targetDomain: targetGlyph === 'ring' });
  }));
  let requestedNodes = 0, requestedEdges = 0, requestedMainEdges = 0;
  // "D086-BURST BEGIN": the distinct canvas owns the visible subset census.
  let readinessView = (options as typeof options & { readinessView?: string }).readinessView;
  // "D086-BURST END"
  let nativeCountDirty = true;
  let nativeNodeIdsDrawn = 0;
  let nativeEdgeIdsDrawn: string[] = [];
  const recountPresented = (): void => {
    requestedNodes = nativeTier ? graph.order : geometry.nodes.length;
    requestedEdges = nativeTier ? graph.size : geometry.edges.length;
    requestedMainEdges = nativeTier ? mainEdgeIds.size
      : geometry.edges.filter(edge => mainEdgeIds.has(edge.id)).length;
    nativeCountDirty = true;
  };
  recountPresented();
  let lastMorphologyCamera = JSON.stringify(sigma.getCamera().getState());
  // "D086-BURST BEGIN"
  const readinessHost = renderReadinessHost(sigma.getContainer());
  const publisher = createPresentedPublisher(presentRenderReadiness);
  publisher.setHost(readinessHost);
  // "D086-BURST END"
  const publishPresented = (): void => {
    const stage = ladder.state.stage;
    const nativeNodesCanvas = sigma.getCanvases().nodes;
    const nativeEdgesCanvas = sigma.getCanvases().edges;
    if (nativeTier && nativeCountDirty) {
      nativeNodeIdsDrawn = graph.nodes().filter(id => { const data = sigma.getNodeDisplayData(id);
        return data !== undefined && !data.hidden; }).length;
      nativeEdgeIdsDrawn = graph.edges().filter(id => { const data = sigma.getEdgeDisplayData(id);
        return data !== undefined && !data.hidden; });
      nativeCountDirty = nativeNodeIdsDrawn === 0 && graph.order > 0;
    }
    const nativeNodesDrawn = nativeTier && nativeNodesCanvas?.style.display !== 'none' ? nativeNodeIdsDrawn : 0;
    const nativeDrawnIds = nativeTier && nativeEdgesCanvas?.style.display !== 'none' ? nativeEdgeIdsDrawn : [];
    const nativeEdgesDrawn = nativeDrawnIds.length;
    const canvasDrawn = !nativeTier && canvas.style.visibility !== 'hidden' && context !== null;
    const nodesDrawn = nativeTier ? nativeNodesDrawn : canvasDrawn ? geometry.nodes.length : 0;
    const edgesDrawn = nativeTier ? nativeEdgesDrawn : canvasDrawn ? geometry.edges.length : 0;
    const mainDrawn = nativeTier ? nativeDrawnIds.filter(id => mainEdgeIds.has(id)).length
      : canvasDrawn ? geometry.edges.filter(edge => mainEdgeIds.has(edge.id)).length : 0;
    const snapshot = {
      view: readinessView ?? `distinct/2d/${options.morphology}`,
      quality: ladder.state.moving ? 'movimento' : stage === FULL_QUALITY_STAGE ? 'completa' : 'recupero',
      ladder: stage,
      nodes: { required: requestedNodes, loaded: requestedNodes, drawn: nodesDrawn },
      mainEdges: { required: requestedMainEdges, loaded: requestedMainEdges, drawn: mainDrawn },
      allEdges: { required: requestedEdges, loaded: requestedEdges, drawn: edgesDrawn },
      decor: { labels: stage === FULL_QUALITY_STAGE, background: stage === FULL_QUALITY_STAGE,
        glow: stage === FULL_QUALITY_STAGE, animation: true },
      decorApplicable: { animation: false },
    } as const;
    publisher.publish(snapshot);
  };
  const ladder = new QualityLadder(({ stage, moving }) => {
    if (nativeTier) canvas.style.visibility = stage === FULL_QUALITY_STAGE ? '' : 'hidden';
    if (!moving && stage === FULL_QUALITY_STAGE) draw();
    else if (!moving) publishPresented();
  });
  const draw = (): void => {
    if (!context) return;
    const cameraFrame = JSON.stringify(sigma.getCamera().getState());
    if (cameraFrame !== lastMorphologyCamera) {
      lastMorphologyCamera = cameraFrame;
      ladder.touch();
    }
    if (nativeTier && ladder.state.stage !== FULL_QUALITY_STAGE) { publishPresented(); return; }
    if (perfMarksEnabled) performance.mark("d082:render2d:canvas:start");
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * devicePixelRatio));
    const height = Math.max(1, Math.round(box.height * devicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const projected = new WeakMap<Coordinates, { x: number; y: number; scale: number }>();
    drawMorphologyCanvas(context, geometry, (point) => {
      let value = projected.get(point);
      if (!value) {
        const screen = sigma.graphToViewport(point);
        value = { x: screen.x, y: screen.y, scale: sigma.scaleSize(1) };
        projected.set(point, value);
      }
      return value;
    }, {
      fieldColor: model.fieldColor,
      interaction: options.presentation?.morphologyInteraction,
      nodes: nodeStyles,
      edges: edgeStyles,
    }, appearance, undefined, "2d", nativeTier);
    publishPresented();
    if (perfMarksEnabled) { performance.mark("d082:render2d:canvas:end"); performance.measure("d082:render2d:canvas", "d082:render2d:canvas:start", "d082:render2d:canvas:end"); }
  };
  (canvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw = draw;
  sigma.on("afterRender", draw);
  draw();
  return {
    setAppearance(next): void {
      if (next.curvature !== appearance.curvature) geometry = sharedGeometry(next.curvature);
      appearance = next;
      draw();
    },
    // The LOD swap: `draw` closes over the three mutables below, so the update only assigns
    // them and repaints once — no Sigma refresh, no layer re-creation, no camera touch. The
    // swapped input also feeds any later curvature rebuild, so an appearance change after an
    // in-place update derives from the current subset, not the mounted one.
    updateVisibleSubset(update): void {
      geometry = update.geometry;
      // "D086-BURST BEGIN"
      readinessView = update.readinessView ?? readinessView;
      // "D086-BURST END"
      sharedInput = update.input;
      nodeStyles = new Map(nodeStyles);
      edgeStyles = new Map(edgeStyles);
      for (const [id, entry] of update.nodeEntries) {
        const current = nodeStyles.get(id);
        // "D086-BURST BEGIN": a retained canvas must consume the revised color as well as radius.
        if (current) nodeStyles.set(id, { ...current, glyph: entry.glyph, radiusPx: entry.radiusPx,
          color: revisedCanvasNodeColor(current.color, model.fieldColor,
            entry.tintSrgb, entry.opacityPermille) });
        // "D086-BURST END"
      }
      for (const [id, entry] of update.edgeEntries)
        edgeStyles.set(id, { color: entry.color, presentation: entry.presentation });
      // "D086-BURST BEGIN": newly visible real relations join the current main census.
      mainEdgeIds = new Set(update.input.edges.filter(edge => {
        const category = edgeStyles.get(edge.id)?.presentation?.category;
        const sourceGlyph = nodeStyles.get(edge.source)?.glyph;
        const targetGlyph = nodeStyles.get(edge.target)?.glyph;
        return mainRelation({ attested: category === 'attested', exploratory: category === 'exploratory',
          selectedIncident: !!(options.presentation?.emphasisIds?.has(edge.source)
            || options.presentation?.emphasisIds?.has(edge.target)),
          sourceHub: sourceGlyph === 'double-ring', targetHub: targetGlyph === 'double-ring',
          sourceDomain: sourceGlyph === 'ring', targetDomain: targetGlyph === 'ring' });
      }).map(edge => edge.id));
      recountPresented();
      // "D086-BURST END"
      // "D082-A-NCOMPLETA2 END"
      draw();
    },
    destroy(): void {
      publisher.dispose();
      ladder.destroy();
      sigma.off("afterRender", draw);
      sigma.off("resize", collapseLayer);
      collapsed.forEach((item, index) => {
        item.style.display = previousDisplay[index] ?? "";
        const backing = previousBacking[index];
        if (backing) { item.width = backing[0]; item.height = backing[1]; }
      });
      shrinkable.forEach((item, index) => {
        const backing = previousShrinkBacking[index];
        if (backing) { item.width = backing[0]; item.height = backing[1]; }
      });
      screenPaint.enabled = true;
      detached.forEach((item, index) => { item.style.display = previousDetachedDisplay[index] ?? ""; });
      // Polish-III haze repair BEGIN: invalidate pending settled-glow redraws before unmount.
      delete (canvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw;
      // Polish-III haze repair END
      canvas.remove();
    },
  };
}

/** This instruments a filament program's actual live processing and does not create another relation. */
function createObservedFilamentProgram(
  material: FilamentUniformMaterial,
  materialType: string,
  bindings: LiveRelationMaterialBindings,
  geometryBindings: LiveRelationGeometryBindings,
  screenPaint: ScreenPaintControl,
): typeof FilamentProgram {
  const BaseProgram = createFilamentProgram(material);
  return class extends BaseProgram {
    override process(
      edgeIndex: number,
      offset: number,
      sourceData: NodeDisplayData,
      targetData: NodeDisplayData,
      data: EdgeDisplayData,
    ): void {
      super.process(edgeIndex, offset, sourceData, targetData, data);
      if (!data.hidden && !sourceData.hidden && !targetData.hidden) {
        bindings.record(edgeIndex, materialType);
        const controlStart = (offset * this.STRIDE) + ["source-x", "source-y", "target-x", "target-y"].length;
        const x = this.array[controlStart];
        const y = this.array[controlStart + 1];
        if (x === undefined || y === undefined) {
          throw new TypeError("live filament program did not write its control-point attributes");
        }
        geometryBindings.record(edgeIndex, { x, y });
      }
    }

    // Preserve Sigma's compatibility picking buffer while the hidden tier skips its screen pass.
    override render(params: RenderParams): void {
      if (screenPaint.enabled) {
        super.render(params);
        return;
      }
      if (this.hasNothingToRender()) {
        return;
      }
      const pick = this.pickProgram;
      if (pick === null) {
        return;
      }
      pick.gl.viewport(
        0,
        0,
        (params.width * params.pixelRatio) / params.downSizingRatio,
        (params.height * params.pixelRatio) / params.downSizingRatio,
      );
      this.bindProgram(pick);
      this.renderProgram({ ...params, pixelRatio: params.pixelRatio / params.downSizingRatio }, pick);
      this.unbindProgram(pick);
    }
  };
}

/** This wraps Sigma's circle node program so the hidden tier keeps its picking pass only. */
function createPickingCapableNodeProgram(screenPaint: ScreenPaintControl): NodeProgramType {
  return class extends NodeCircleProgram {
    override render(params: RenderParams): void {
      if (screenPaint.enabled) {
        super.render(params);
        return;
      }
      if (this.hasNothingToRender()) {
        return;
      }
      const pick = this.pickProgram;
      if (pick === null) {
        return;
      }
      pick.gl.viewport(
        0,
        0,
        (params.width * params.pixelRatio) / params.downSizingRatio,
        (params.height * params.pixelRatio) / params.downSizingRatio,
      );
      this.bindProgram(pick);
      this.renderProgram({ ...params, pixelRatio: params.pixelRatio / params.downSizingRatio }, pick);
      this.unbindProgram(pick);
    }
  };
}

/** This reads ids and incidence from the mounted Sigma graph and does not use the render model. */
function liveSurfaceWitness(sigma: Sigma): RenderSurfaceWitness {
  const graph = sigma.getGraph();
  const edgeIds = [...graph.edges()].sort();
  return {
    nodeIds: [...graph.nodes()].sort(),
    edgeIds,
    incidence: Object.fromEntries(edgeIds.map((edgeId) => [edgeId, {
      source: graph.source(edgeId),
      target: graph.target(edgeId),
    }])),
  };
}

/** This refuses material stacking for each live relation binding. */
export function assertSingleMaterialPerRelation(bindings: readonly RelationMaterialBinding[]): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.relationId)) {
      throw new TypeError(`relation ${binding.relationId} has multiple material bindings`);
    }
    seen.add(binding.relationId);
    if (binding.materialTypes.length !== 1) {
      throw new TypeError(`relation ${binding.relationId} must bind exactly one material program`);
    }
  }
}

/** This draws morphology-shaped node halos below edges and does not introduce a second node topology. */
function mountNodeGlow(
  sigma: Sigma,
  model: RenderModel,
  calibration: CalibrationProfile | undefined,
  paint = true,
): GlowLayer {
  const profile = calibration ?? DEFAULT_CALIBRATION;
  if (!paint) {
    // The distinct path covers the glow with its own canvas and keeps only the footprints the
    // DOM label pass collides against: no layer, no afterRender draw, witnesses unchanged.
    return witnessesOnlyGlowLayer(sigma, model, profile);
  }
  sigma.createCanvasContext("node-glow");
  const canvas = requiredCanvas(sigma, "node-glow");
  // Below the aggregate windows: the ring is structure, the glow is atmosphere.
  requiredCanvas(sigma, "aggregate-windows").before(canvas);
  sigma.resize(true);
  const context = canvas.getContext("2d");
  const draw = (): void => {
    if (context === null) {
      return;
    }
    // Sigma reports viewport coordinates and scaled radii in CSS pixels, while
    // this layer's backing store is in device pixels. Read the actual canvas
    // backing-to-CSS ratio rather than a renderer parameter: the layer can be
    // resized independently, so the canvas itself is the authoritative surface.
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return;
    }
    const scaleX = canvas.width / box.width;
    const scaleY = canvas.height / box.height;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    for (const id of model.graph.nodes()) {
      const attributes = model.graph.getNodeAttributes(id);
      const center = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
      const coreRadius = sigma.scaleSize(attributes.size);
      const haloRadius = resolvedGlowHaloRadius(
        coreRadius,
        sigma.scaleSize(attributes.haloRadiusPx),
        profile,
        model.filamentMaterial.neuralProfile ?? false,
      );
      if (haloRadius <= coreRadius) {
        continue;
      }
      const gradient = context.createRadialGradient(center.x, center.y, coreRadius, center.x, center.y, haloRadius);
      const color = parseColor(attributes.color);
      const requestedAlpha = (boundedPermille(attributes.haloIntensityPermille, profile) / permilleScale(profile)) * color.a;
      const peakAlpha = model.filamentMaterial.neuralProfile ? Math.min(requestedAlpha, NEURAL_HALO_MAX_ALPHA) : requestedAlpha;
      for (const stop of haloAlphaStops(profile, peakAlpha)) {
        gradient.addColorStop(stop.offset, `rgba(${color.r}, ${color.g}, ${color.b}, ${stop.alpha})`);
      }
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(center.x, center.y, haloRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  };
  sigma.on("afterRender", draw);
  draw();
  return {
    readWitnesses(): readonly RenderNodeGlowWitness[] {
      return glowWitnesses(sigma, model, profile);
    },
    setVisible(visible: boolean): void {
      canvas.style.visibility = visible ? "visible" : "hidden";
    },
    destroy(): void {
      sigma.off("afterRender", draw);
      sigma.killLayer("node-glow");
    },
  };
}

/** This reports the live core and halo footprints with or without a painted canvas. */
function glowWitnesses(sigma: Sigma, model: RenderModel, profile: CalibrationProfile): readonly RenderNodeGlowWitness[] {
  return model.graph.nodes().map((id) => {
    const attributes = model.graph.getNodeAttributes(id);
    const coreRadiusPx = sigma.scaleSize(attributes.size);
    const viewportCenter = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
    return {
      id,
      viewportCenter,
      coreRadiusPx,
      haloRadiusPx: resolvedGlowHaloRadius(
        coreRadiusPx,
        sigma.scaleSize(attributes.haloRadiusPx),
        profile,
        model.filamentMaterial.neuralProfile ?? false,
      ),
    };
  });
}

/** This answers the footprint witnesses the label pass collides against without a layer of its own. */
function witnessesOnlyGlowLayer(sigma: Sigma, model: RenderModel, profile: CalibrationProfile): GlowLayer {
  return {
    readWitnesses(): readonly RenderNodeGlowWitness[] {
      return glowWitnesses(sigma, model, profile);
    },
    setVisible(): void {},
    destroy(): void {},
  };
}

/** This keeps the calibrated clear radial gap around every resolved node core. */
function resolvedGlowHaloRadius(
  coreRadiusPx: number,
  requestedHaloRadiusPx: number,
  calibration: CalibrationProfile,
  neural = false,
): number {
  const radius = Math.max(requestedHaloRadiusPx, coreRadiusPx + calibration.luminance.coreBeforeHaloMinimumPx);
  return neural ? Math.min(radius, coreRadiusPx * NEURAL_HALO_MAX_RADIUS_RATIO) : radius;
}

type GlowLayer = {
  readWitnesses(): readonly RenderNodeGlowWitness[];
  setVisible(visible: boolean): void;
  destroy(): void;
};

function noGlowLayer(): GlowLayer {
  return {
    readWitnesses(): readonly RenderNodeGlowWitness[] {
      return [];
    },
    setVisible(): void {},
    destroy(): void {},
  };
}

/** This samples a monotonic halo alpha profile and does not read renderer state. */
export function haloAlphaStops(
  calibration: CalibrationProfile,
  peakAlpha: number,
): readonly { readonly offset: number; readonly alpha: number }[] {
  const finalIndex = Math.max(1, calibration.luminance.haloSampleCount - 1);
  const exponent = 2 + (boundedPermille(calibration.luminance.haloFalloffPermille, calibration) / permilleScale(calibration));
  return Array.from({ length: finalIndex + 1 }, (_, index) => {
    const offset = index / finalIndex;
    return { offset, alpha: peakAlpha * ((1 - offset) ** exponent) };
  });
}

/** This captures the Sigma camera with the extent that makes its coordinates stable across graph changes. */
export function readCameraState(sigma: Sigma): RenderCameraState {
  const bounds = sigma.getCustomBBox() ?? sigma.getBBox();
  return {
    ...sigma.getCamera().getState(),
    bounds: {
      x: [bounds.x[0], bounds.x[1]],
      y: [bounds.y[0], bounds.y[1]],
    },
  };
}

/** This restores a camera and its framing before Sigma recalculates display coordinates. */
export function restoreCameraState(sigma: Sigma, state: RenderCameraState): void {
  // Camera changes schedule Sigma's render themselves. Its full
  // refresh reprocesses the entire graph and is only needed for a new bbox.
  const current = sigma.getCustomBBox() ?? sigma.getBBox();
  const boundsChanged = current.x[0] !== state.bounds.x[0] || current.x[1] !== state.bounds.x[1]
    || current.y[0] !== state.bounds.y[0] || current.y[1] !== state.bounds.y[1];
  const camera = sigma.getCamera();
  const before = camera.getState();
  const cameraChanged = before.x !== state.x || before.y !== state.y
    || before.angle !== state.angle || before.ratio !== state.ratio;
  if (boundsChanged) sigma.setCustomBBox({
    x: [state.bounds.x[0], state.bounds.x[1]],
    y: [state.bounds.y[0], state.bounds.y[1]],
  });
  if (cameraChanged) camera.setState(state);
  if (boundsChanged) sigma.refresh();
}

function cameraStateFromVisualState(camera: VisualStateCamera): RenderCameraState {
  return {
    x: camera.x,
    y: camera.y,
    angle: camera.angle,
    ratio: camera.ratio,
    bounds: {
      x: [camera.bounds.x[0], camera.bounds.x[1]],
      y: [camera.bounds.y[0], camera.bounds.y[1]],
    },
  };
}

function placeNodeLabels(sigma: Sigma, model: RenderModel, calibration: CalibrationProfile): void {
  if (!model.material.node.includes("label")) {
    return;
  }
  const labels = requiredCanvas(sigma, "labels");
  const context = labels.getContext("2d");
  if (context === null) {
    throw new TypeError("Sigma label canvas is unavailable");
  }
  const settings = sigma.getSettings();
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
  const candidates: LabelPlacementCandidate[] = [];
  for (const id of model.graph.nodes()) {
    const attributes = model.graph.getNodeAttributes(id);
    if (attributes.labelText === "") {
      continue;
    }
    const center = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
    const coreRadius = sigma.scaleSize(attributes.size);
    candidates.push({
      id,
      priority: attributes.labelPriority,
      minimumX: center.x + coreRadius,
      minimumY: center.y - settings.labelSize,
      maximumX: center.x + coreRadius + context.measureText(attributes.labelText).width,
      maximumY: center.y + settings.labelSize,
    });
  }
  const selected = new Set(resolveLabelIds(candidates, calibration));
  // Sigma reprocesses every node and edge on refresh. An unchanged
  // label result must not schedule another whole-graph pass at rest.
  let changed = false;
  for (const id of model.graph.nodes()) {
    const attributes = model.graph.getNodeAttributes(id);
    const next = selected.has(id) ? attributes.labelText : "";
    if (attributes.label !== next) { model.graph.setNodeAttribute(id, "label", next); changed = true; }
  }
  if (changed) sigma.refresh();
}

/** This renders a small collision-filtered subset of IR-derived relation labels and does not alter relation identity. */
function placeEdgeLabels(
  sigma: Sigma,
  model: RenderModel,
  state: Pick<VisualState, "selectedId" | "focusedId">,
  calibration: CalibrationProfile,
  revealVisible: boolean,
  // A-PERF BEGIN
  baseColors: ReadonlyMap<string, string>,
  // A-PERF END
): void {
  const eligible = revealVisible ? edgeLabelCandidatesForState(model, state, calibration) : [];
  const visible = new Set<string>();
  if (eligible.length > 0) {
    const labels = requiredCanvas(sigma, "edgeLabels");
    const context = labels.getContext("2d");
    if (context === null) {
      throw new TypeError("Sigma edge label canvas is unavailable");
    }
    const settings = sigma.getSettings();
    context.font = `${settings.edgeLabelWeight} ${calibration.labels.edgeLabelSizePx}px ${settings.edgeLabelFont}`;
    // Selection is priority ordered and capped by the calibration.
    // Measure only until the cap is full; lower-priority candidates cannot
    // displace it. This keeps dense Completa entry off the text-metrics
    // slow path while preserving the exact resolver order and collision rule.
    const chosen = selectCappedLabelPlacements(eligible, calibration.labels.edgeDensityCap,
      calibration.labels.collisionPaddingPx, candidate => {
      const source = model.graph.source(candidate.id);
      const target = model.graph.target(candidate.id);
      const sourceAttributes = model.graph.getNodeAttributes(source);
      const targetAttributes = model.graph.getNodeAttributes(target);
      const sourcePoint = sigma.graphToViewport({ x: sourceAttributes.x, y: sourceAttributes.y });
      const targetPoint = sigma.graphToViewport({ x: targetAttributes.x, y: targetAttributes.y });
      const centerX = (sourcePoint.x + targetPoint.x) / 2;
      const centerY = (sourcePoint.y + targetPoint.y) / 2;
      const width = context.measureText(candidate.text).width;
      return {
        ...candidate,
        minimumX: centerX - (width / 2),
        minimumY: centerY - calibration.labels.edgeLabelSizePx,
        maximumX: centerX + (width / 2),
        maximumY: centerY + calibration.labels.edgeLabelSizePx,
      };
    });
    for (const item of chosen) visible.add(item.id);
  }
  const byId = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  // Keep Sigma's graph and settings untouched for identical labels.
  let changed = false;
  for (const id of model.graph.edges()) {
    const candidate = byId.get(id);
    const shown = candidate !== undefined && visible.has(id);
    const attributes = model.graph.getEdgeAttributes(id);
    const label = shown && candidate !== undefined ? candidate.text : "";
    // A-PERF BEGIN: never compound alpha from a preceding pass.
    const baseColor = baseColors.get(id) ?? attributes.labelColor;
    const labelColor = candidate === undefined || !shown
      ? baseColor
      : withCalibratedAlpha(baseColor, candidate.opacityPermille, calibration);
    // A-PERF END
    if (attributes.label !== label || attributes.forceLabel !== shown || attributes.labelColor !== labelColor) {
      model.graph.mergeEdgeAttributes(id, { label, forceLabel: shown, labelColor });
      changed = true;
    }
  }
  // An empty relation text draws nothing, whatever selected it: sigma's edge-label pass is
  // enabled only when a label would actually put ink on its layer.
  const drawable = eligible.some((candidate) => visible.has(candidate.id) && candidate.text !== "");
  if (sigma.getSetting("renderEdgeLabels") !== drawable) { sigma.setSetting("renderEdgeLabels", drawable); changed = true; }
  if (changed) sigma.refresh();
}

/** Lazy equivalent of the priority/collision resolver for a small display cap. */
export function selectCappedLabelPlacements<T extends { id: string; priority: number }>(
  candidates: readonly T[], cap: number, padding: number,
  measure: (candidate: T) => import('./model.ts').LabelPlacementCandidate,
): readonly import('./model.ts').LabelPlacementCandidate[] {
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const chosen: import('./model.ts').LabelPlacementCandidate[] = [];
  for (const candidate of ordered) {
    if (chosen.length >= cap) break;
    const placed = measure(candidate);
    if (chosen.every(other => placed.minimumX > other.maximumX + padding
      || placed.maximumX + padding < other.minimumX
      || placed.minimumY > other.maximumY + padding
      || placed.maximumY + padding < other.minimumY)) chosen.push(placed);
  }
  return chosen;
}

/** This composes a governed label opacity over a resolved neutral token and does not change its hue. */
function withCalibratedAlpha(color: string, opacityPermille: number, calibration: CalibrationProfile): string {
  const parsed = parseColor(color);
  const alpha = (parsed.a * boundedPermille(opacityPermille, calibration)) / permilleScale(calibration);
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
}

/** This draws engine aggregate discs in Sigma coordinates and does not infer window membership. */
function mountAggregateWindows(
  sigma: Sigma,
  model: RenderModel,
  calibration: CalibrationProfile | undefined,
): { readonly destroy: () => void } {
  const profile = calibration ?? DEFAULT_CALIBRATION;
  sigma.createCanvasContext("aggregate-windows");
  const canvas = requiredCanvas(sigma, "aggregate-windows");
  requiredCanvas(sigma, "edges").before(canvas);
  sigma.resize(true);
  // A flat organization has no windows: the layer still exists (the glow is inserted below it)
  // but a windowless clear is the only thing it would ever paint, so it collapses instead of
  // holding a full-DPR backing store Sigma re-clears on every render.
  const windowless = model.windows.length === 0;
  const collapseLayer = (): void => {
    if (!windowless) return;
    canvas.style.display = "none";
    canvas.width = 1;
    canvas.height = 1;
  };
  collapseLayer();
  sigma.on("resize", collapseLayer);
  const context = canvas.getContext("2d");
  const draw = (): void => {
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    const outline = model.material.aggregate.includes("outline");
    context.lineWidth = outline
      ? (profile.filament.baseWidthPx * profile.lod.macroAggregateOutlineWidthMultiplierPermille) / permilleScale(profile)
      : profile.filament.baseWidthPx;
    context.globalAlpha = (outline ? profile.lod.macroAggregateOutlineAlphaPermille : profile.aggregate.windowStrokeAlphaPermille) / permilleScale(profile);
    context.strokeStyle = requiredTokenColor(model, "accent3");
    for (const window of model.windows) {
      const center = sigma.graphToViewport(window.center);
      const radiusPoint = sigma.graphToViewport({ x: window.center.x + window.radius, y: window.center.y });
      const radius = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);
      context.beginPath();
      context.arc(center.x, center.y, radius, 0, Math.PI * 2);
      context.stroke();
    }
  };
  sigma.on("afterRender", draw);
  draw();
  return {
    destroy(): void {
      sigma.off("afterRender", draw);
      sigma.off("resize", collapseLayer);
      sigma.killLayer("aggregate-windows");
    },
  };
}

function requiredCanvas(sigma: Sigma, id: string): HTMLCanvasElement {
  const canvas = sigma.getCanvases()[id];
  if (canvas === undefined) {
    throw new TypeError(`Sigma canvas ${id} is unavailable`);
  }
  return canvas;
}

function boundedPermille(value: number, calibration: CalibrationProfile): number {
  return Math.max(0, Math.min(permilleScale(calibration), value));
}

function permilleScale(_calibration: CalibrationProfile): number {
  // Was `calibration.morphology.stellar.opacityPermille`, which happens to hold the permille base
  // and is therefore the right value for entirely the wrong reason: restyling a morphology's
  // opacity would silently move the base every permille quantity in this file is expressed
  // against. The scale is a representation unit, not a tuneable one, and now reads as one.
  return SCENE_PERMILLE_SCALE;
}

/** This formats one resolved token for the canvas and does not establish an alpha policy. */
function requiredTokenColor(model: RenderModel, name: string): string {
  const color = model.tokenColors.get(name);
  if (color === undefined) {
    throw new TypeError("aggregate stroke token is unavailable");
  }
  return color;
}

function copyFramingBox(box: RenderFramingBox): { readonly x: [number, number]; readonly y: [number, number] } {
  return {
    x: [box.x[0], box.x[1]],
    y: [box.y[0], box.y[1]],
  };
}

/** Opt-in B10a renderer. The legacy page continues to call mount() above. */
export type Projection2dHandle = {
  readonly dimension: '2d';
  updateVisibleSubset(styled: StyledProjection, visibility: RenderVisibility): void;
  pickAtPoint(position: Vec2): PickResult | null;
  /** Samples a node through the mounted Sigma camera at settle time. */
  graphToViewport(point: Vec2): Vec2;
  readCameraState(): CameraState;
  /** Restore the mounted fitted camera without remounting. */
  restoreCameraState(state: CameraState): void;
  /** IDs placed by the most recent typed label pass; reading them schedules no render. */
  readPlacedLabelIds(): readonly string[];
  /** Appearance of the derived geometry (containers, curves, field rings); never moves it. */
  setDerivedMorphology(morphology: ProjectionVisualsMorphology): void;
  readSurfaceWitness(): Readonly<{ nodeIds: readonly string[]; semanticEdgeIds: readonly string[]; visualRelationIds: readonly string[]; curveIds: readonly string[]; containerIds: readonly string[]; fieldIds: readonly string[] }>;
  destroy(): void;
};

type ProjectionNodeAttributes = { x: number; y: number; size: number; color: string; label: string };
type ProjectionEdgeAttributes = { size: number; color: string };
const PROJECTION_PICK_RADIUS_PX = DEFAULT_CALIBRATION.filament.pickTolerancePx;
const PROJECTION_NODE_RADIUS_PX = PROJECTION_PICK_RADIUS_PX * (2 + 1 / 2);
const PROJECTION_CLICK_DRAG_TOLERANCE_PX = PROJECTION_PICK_RADIUS_PX * (2 + 1 / 2);

function styleNumber(style: Readonly<Record<string, number | string>>, key: string, fallback: number): number {
  const value = style[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function styleColor(style: Readonly<Record<string, number | string>>, fallback: string): string {
  const value = style.color;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
function styleAlpha(style: Readonly<Record<string, number | string>>, fallback: number): number {
  return Math.min(1, Math.max(0, styleNumber(style, 'alpha', fallback)));
}
/** The product glyph grammar as the style bridge bakes it; anything else stays the engine default. */
function projectionGlyph(style: Readonly<Record<string, number | string>>): NodeGlyph | undefined {
  const value = style.glyph;
  return value === 'filled' || value === 'ring' || value === 'double-ring' || value === 'hollow' ? value : undefined;
}
function projectionEdgeCategory(style: Readonly<Record<string, number | string>>, attestation: 'attested' | 'exploratory'): EdgeCategory {
  const value = style.category;
  return value === 'attested' || value === 'exploratory' || value === 'containment' ? value : attestation;
}
function projectionEdgePresentation(
  style: Readonly<Record<string, number | string>>, attestation: 'attested' | 'exploratory',
): EdgePresentation {
  return {
    category: projectionEdgeCategory(style, attestation),
    opacityPermille: styleNumber(style, 'opacityPermille', SCENE_PERMILLE_SCALE),
    widthPermille: styleNumber(style, 'widthPermille', SCENE_PERMILLE_SCALE),
  };
}
function projectionNodeAttributes(scene: Projection2dScene, id: string): ProjectionNodeAttributes {
  const node = scene.nodes.get(id)!;
  return { x: node.position.x, y: node.position.y, size: Math.max(1 / 2, styleNumber(node.style, 'size', PROJECTION_NODE_RADIUS_PX)),
    color: typedRgbaColor(styleColor(node.style, "#9bc8ed"), styleAlpha(node.style, 1)), label: '' };
}
function projectionEdgeAttributes(scene: Projection2dScene, id: string): ProjectionEdgeAttributes {
  const edge = scene.semanticEdges.get(id)!;
  return { size: Math.max(1 / 2, styleNumber(edge.style, 'size', 1 + 1 / 2)),
    color: typedRgbaColor(styleColor(edge.style, edge.attestation === 'attested' ? "#729ebd" : "#ad8e6a"), styleAlpha(edge.style, 1)) };
}

/** Everything the morphology canvas pass needs for one visible subset: the engine geometry, the
 * per-node ink (colour, glyph, radius, alpha) and the per-edge presentation the style bridge
 * baked. Communities derive from the snapshot's own parent links, never from a new layout. */
function projectionMorphologyPaint(
  morphology: Morphology, scene: Projection2dScene, snapshot: SemanticGraphSnapshot, curvature = DEFAULT_APPEARANCE.curvature,
): { geometry: MorphologyGeometry;
  nodeStyles: ReadonlyMap<string, { color: string; glyph: NodeGlyph | undefined; radiusPx: number; opacity: number }>;
  edgeStyles: ReadonlyMap<string, { color: string; presentation: EdgePresentation | undefined }> } {
  const visible = new Set(scene.nodes.keys());
  const parentById = new Map(snapshot.nodes.map(node => [node.id, node.parentId]));
  const colonyMembers = new Map<string, string[]>();
  const nodes = [...scene.nodes].map(([id, node]) => {
    const parent = parentById.get(id);
    const community = parent !== null && parent !== undefined && parent !== id && visible.has(parent) ? parent : id;
    const members = colonyMembers.get(community);
    if (members) members.push(id);
    else colonyMembers.set(community, [id]);
    return { id, position: { x: node.position.x, y: node.position.y, z: 0 }, radius: styleNumber(node.style, 'size', PROJECTION_NODE_RADIUS_PX) };
  });
  const positionById = new Map(nodes.map(node => [node.id, node.position]));
  const colonies = [...colonyMembers].map(([id, members]) => {
    const center = members.reduce(
      (sum, member) => ({ x: sum.x + positionById.get(member)!.x, y: sum.y + positionById.get(member)!.y, z: 0 }),
      { x: 0, y: 0, z: 0 },
    );
    return { id, members, center: { x: center.x / members.length, y: center.y / members.length, z: 0 } };
  });
  const edges = [...scene.semanticEdges].map(([id, edge]) =>
    ({ id, source: edge.source, target: edge.target, width: styleNumber(edge.style, 'size', 1) }));
  const nodeStyles = new Map([...scene.nodes].map(([id, node]) => [id, {
    color: styleColor(node.style, "#9bc8ed"),
    glyph: projectionGlyph(node.style),
    radiusPx: styleNumber(node.style, 'size', PROJECTION_NODE_RADIUS_PX),
    opacity: styleAlpha(node.style, 1),
  }]));
  const edgeStyles = new Map([...scene.semanticEdges].map(([id, edge]) => [id, {
    color: styleColor(edge.style, edge.attestation === 'attested' ? "#729ebd" : "#ad8e6a"),
    presentation: projectionEdgePresentation(edge.style, edge.attestation),
  }]));
  return {
    geometry: buildMorphologyGeometry(morphology, nodes, edges, colonies, curvature, []),
    nodeStyles,
    edgeStyles,
  };
}

/** Mounts a typed projection once and diffs later visibility revisions on the same Sigma/camera.
 * This worker's pass: Sigma keeps picking and camera; the product morphology canvas paints the structure, and
 * the shared DOM overlay places labels under the density budget. No semantic value is derived here. */
export function mountProjection2d(
  container: HTMLElement, snapshot: SemanticGraphSnapshot, styled: StyledProjection, visibility: RenderVisibility,
): Projection2dHandle {
  let scene = prepareProjection2d(snapshot, styled, visibility);
  let contentKey = projection2dVisibilityKey(styled, visibility);
  let scope = readProjectionStyle(styled);
  let morphology: Morphology = scope?.morphology ?? 'stellar';
  let labelBudget = scope?.labelBudget;
  const graph = new MultiDirectedGraph<ProjectionNodeAttributes, ProjectionEdgeAttributes>();
  for (const id of scene.nodes.keys()) graph.addNode(id, projectionNodeAttributes(scene, id));
  for (const [id, edge] of scene.semanticEdges) graph.addEdgeWithKey(id, edge.source, edge.target, projectionEdgeAttributes(scene, id));
  const sigma = new Sigma(graph, container, { enableEdgeEvents: true, renderLabels: false, renderEdgeLabels: false,
    zoomingRatio: TWO_D_ZOOMING_RATIO });
  suppressSigmaAutomaticPicking(sigma as unknown as Sigma);
  // Sigma otherwise renormalizes its graph coordinates whenever disclosure adds a node.
  // Keep the mount's world frame fixed while the graph changes in place.
  const framePoints = Object.values(styled.projection.positions2 ?? {}).filter((point): point is Vec2 => !!point);
  if (framePoints.length) {
    const xs = framePoints.map(point => point.x), ys = framePoints.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    sigma.setCustomBBox({ x: [minX - 1, maxX + 1], y: [minY - 1, maxY + 1] });
  }
  sigma.createCanvasContext('projection-visuals');
  const canvas = sigma.getCanvases()['projection-visuals'];
  if (canvas === undefined) throw new Error('projection canvas unavailable');
  canvas.style.pointerEvents = 'none';
  sigma.resize(true);
  const context = canvas.getContext('2d');
  const viewport = (point: Vec2) => sigma.graphToViewport(point);
  const line = (a: Vec2, b: Vec2): void => {
    const start = viewport(a); const end = viewport(b);
    context!.moveTo(start.x, start.y); context!.lineTo(end.x, end.y);
  };
  // The dense Indra line pass rests during camera motion.
  let movingLines = false;
  let visualEdgesPainted = 0;
  const draw = (): void => {
    visualEdgesPainted = 0;
    if (context === null) return;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    context.setTransform(canvas.width / box.width, 0, 0, canvas.height / box.height, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    if (movingLines) return;
    for (const relation of scene.visualRelations.values()) {
      const a = scene.nodes.get(relation.source)?.position;
      const b = scene.nodes.get(relation.target)?.position;
      if (a === undefined || b === undefined) continue;
      const record = scene.styled.visualStyle[relation.visualId] ?? {};
      context.globalAlpha = Math.min(1, Math.max(0, styleNumber(record, 'opacityPermille', SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE));
      if (context.globalAlpha <= 0) continue;
      context.lineWidth = Math.max(1 / 2 / 2, styleNumber(record, 'widthPermille', SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE);
      context.strokeStyle = styleColor(record, "#8fa8ac");
      context.beginPath(); line(a, b); context.stroke();
      visualEdgesPainted++;
      // Every parallel bundle declares the extra relations.
      // "D087-LABELS BEGIN": the bundle count is label text; the labels axis hides it too.
      if (relation.visualId.startsWith("visual:d081:") && relation.count > 1 && scope?.labels !== false) {
        const midpoint = viewport({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        context.globalAlpha = TYPED_COMPLETE_BUNDLE_LABEL.alpha;
        context.fillStyle = styleColor(record, "#bfc6cc");
        context.font = TYPED_COMPLETE_BUNDLE_LABEL.font;
        context.fillText(`+${relation.count - 1}`, midpoint.x + TYPED_COMPLETE_BUNDLE_LABEL.offsetPx,
          midpoint.y - TYPED_COMPLETE_BUNDLE_LABEL.offsetPx);
      }
    }
    context.globalAlpha = 1;
  };
  // Containers, curves and field rings are the shared derived-geometry layer; this canvas keeps the structural relations.
  const visuals = createProjectionVisualsLayer(container, '2d', point => {
    const p = sigma.graphToViewport(point);
    return { x: p.x, y: p.y, scale: sigma.scaleSize(1) };
  });
  visuals.mount({ styled, visibility });
  visuals.setMorphology(morphology);
  // The morphology canvas and the collapsed Sigma layers follow the distinct path's own plan.
  let paint = projectionMorphologyPaint(morphology, scene, snapshot, scope?.curvature);
  const morphologyCanvas = document.createElement('canvas');
  morphologyCanvas.dataset.morphologyCanvas = 'projection';
  Object.assign(morphologyCanvas.style, { position: 'absolute', inset: '0', width: "100%", height: "100%", pointerEvents: 'none' });
  // The mount types its Sigma over the projection attribute records; the canvas lookup only
  // touches the layer registry, which is generic-independent.
  requiredCanvas(sigma as unknown as Sigma, 'labels').before(morphologyCanvas);
  // Density changes can cross the native GPU threshold in place.
  let nativeTier = scene.nodes.size >= DENSE_SCENE_THRESHOLD;
  const layerPolicy = distinctLayerPolicy({ nativeTier, nativeLabelsUsed: false });
  const collapsed = layerPolicy.collapse
    .map(id => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousDisplay = collapsed.map(item => item.style.display);
  const previousBacking = collapsed.map(item => [item.width, item.height] as const);
  const shrinkable = layerPolicy.shrinkBacking
    .map(id => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousShrinkBacking = shrinkable.map(item => [item.width, item.height] as const);
  const detached = ['edges', 'nodes']
    .map(id => sigma.getCanvases()[id])
    .filter((item): item is HTMLCanvasElement => item !== undefined);
  const previousDetachedDisplay = detached.map(item => item.style.display);
  const collapseLayer = (): void => {
    for (const item of collapsed) {
      item.style.display = 'none';
      item.width = 1;
      item.height = 1;
    }
    for (const item of shrinkable) {
      item.width = 1;
      item.height = 1;
    }
  };
  collapseLayer();
  sigma.on('resize', collapseLayer);
  if (!nativeTier) for (const item of detached) item.style.display = 'none';
  const morphologyContext = morphologyCanvas.getContext('2d');
  const drawMorphology = (): void => {
    if (!morphologyContext) return;
    const box = morphologyCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * devicePixelRatio));
    const height = Math.max(1, Math.round(box.height * devicePixelRatio));
    if (morphologyCanvas.width !== width || morphologyCanvas.height !== height) {
      morphologyCanvas.width = width;
      morphologyCanvas.height = height;
    }
    const projected = new WeakMap<Coordinates, { x: number; y: number; scale: number }>();
    drawMorphologyCanvas(morphologyContext, paint.geometry, point => {
      let value = projected.get(point);
      if (!value) {
        const screen = sigma.graphToViewport(point);
        value = { x: screen.x, y: screen.y, scale: sigma.scaleSize(1) };
        projected.set(point, value);
      }
      return value;
    }, { fieldColor: scope?.background ?? "#050505", nodes: paint.nodeStyles, edges: paint.edgeStyles },
      // The style's per-edge size already includes the live width multiplier; applying it again
      // through AppearanceOptions would square the slider value.
      { ...DEFAULT_APPEARANCE, curvature: scope?.curvature ?? DEFAULT_APPEARANCE.curvature },
      undefined, '2d', nativeTier);
  };
  // The DOM label overlay: one placement pass per rendered frame, no timers, zero when idle.
  const labels = mountProjectionLabelOverlay(container);
  let fittedRatio: number | null = null;
  // "D087-LABELS BEGIN": the off clear is one-shot per transition — the first suppressed pass
  // empties the overlay once; every later suppressed pass (each redraw while off) does nothing.
  let labelsOffCleared = scope?.labels === false;
  // "D087-LABELS END"
  const labelPass = (): void => {
    const box = container.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    // "D087-LABELS BEGIN": with the labels axis off this pass builds no candidate, disc or rim and
    // measures nothing; the single empty repaint clears whatever the previous on state placed.
    if (scope?.labels === false) {
      if (!labelsOffCleared) {
        labelsOffCleared = true;
        labels.update({ candidates: [], bounds: EMPTY_LABEL_BOUNDS });
      }
      return;
    }
    labelsOffCleared = false;
    // "D087-LABELS END"
    const ratio = sigma.getCamera().getState().ratio;
    if (fittedRatio === null) fittedRatio = ratio;
    const overview = ratio >= fittedRatio * TYPED_LABEL_CAMERA.overviewRatio;
    const close = ratio < fittedRatio * TYPED_LABEL_CAMERA.closeRatio;
    const scale = sigma.scaleSize(1);
    const candidates: ProjectionLabelCandidate[] = [];
    const discs: { id: string; x: number; y: number; radius: number }[] = [];
    const rims: { x: number; y: number; radius: number }[] = [];
    for (const [id, node] of scene.nodes) {
      const style = node.style as Readonly<Record<string, number | string>>;
      const radiusPx = Math.max(0, styleNumber(style, 'size', PROJECTION_NODE_RADIUS_PX) * scale);
      const screen = sigma.graphToViewport(node.position);
      discs.push({ id, x: screen.x, y: screen.y, radius: radiusPx + 2 });
      const anchor = { id, x: screen.x, y: screen.y, radiusPx, style };
      const kind = typedLabelKind(anchor, { neighbours: null, overview, close, projection: '2d' });
      if (kind === null) continue;
      const texts = typedLabelTexts(anchor);
      if (texts.short.length === 0) continue;
      candidates.push({ id, text: texts.short, full: texts.full, reason: kind.reason, tier1: kind.tier1,
        priority: styleNumber(style, 'labelPriority', 0), x: screen.x, y: screen.y, radiusPx });
    }
    for (const [, container] of scene.containers) {
      if (!container.center2 || !(container.radius && container.radius > 0)) continue;
      const center = sigma.graphToViewport(container.center2);
      const outer = sigma.graphToViewport({ x: container.center2.x + container.radius, y: container.center2.y });
      rims.push({ x: center.x, y: center.y, radius: Math.hypot(outer.x - center.x, outer.y - center.y) });
    }
    labels.update({ candidates, discs, rims, textColor: scope?.star ?? "#e8e8e8",
      bounds: { left: 0, top: 0, width: box.width, height: box.height },
      ...(labelBudget !== undefined ? { budget: labelBudget } : {}) });
  };
  let semanticPickIndex: ScreenPickIndex | null = null;
  let visualPickIndex: ScreenPickIndex | null = null;
  let pickFrame = '';
  let pickSettleTimer: ReturnType<typeof setTimeout> | undefined;
  const rebuildPickIndex = (): void => {
    if (pickSettleTimer !== undefined) { clearTimeout(pickSettleTimer); pickSettleTimer = undefined; }
    const bounds = container.getBoundingClientRect();
    const scale = sigma.scaleSize(1);
    const contract = MORPHOLOGY_CONTRACT[morphology];
    const discs = paint.geometry.nodes.map(node => {
      const p = sigma.graphToViewport(node.position);
      const given = paint.nodeStyles.get(node.id)?.radiusPx ?? node.radius;
      const basis = Math.min(contract.node.maxRadiusPx, Math.max(2,
        given * scale * contract.node.scale));
      const radius = morphology === 'stellar' ? stellarStarCoreRadiusPx(basis, node.degree) : basis;
      return { id: node.id, x: p.x, y: p.y, radius: radius + 2 };
    });
    const semantic: ScreenPickSegment[] = [];
    for (const part of paint.geometry.drawnSegments) for (let i = 1; i < part.samples.length; i++) {
      const a = sigma.graphToViewport(part.samples[i - 1]!);
      const b = sigma.graphToViewport(part.samples[i]!);
      semantic.push({ id: part.edgeId, ax: a.x, ay: a.y, bx: b.x, by: b.y,
        tolerance: PROJECTION_PICK_RADIUS_PX + Math.max(0, part.widthMid * scale / 2) });
    }
    const relations: ScreenPickSegment[] = [];
    for (const relation of scene.visualRelations.values()) {
      const source = scene.nodes.get(relation.source)?.position;
      const target = scene.nodes.get(relation.target)?.position;
      if (!source || !target) continue;
      const a = sigma.graphToViewport(source), b = sigma.graphToViewport(target);
      relations.push({ id: relation.visualId, ax: a.x, ay: a.y, bx: b.x, by: b.y, tolerance: PROJECTION_PICK_RADIUS_PX });
    }
    semanticPickIndex = buildScreenPickIndex(discs, [], semantic, bounds.width, bounds.height);
    visualPickIndex = buildScreenPickIndex([], [], relations, bounds.width, bounds.height);
    pickFrame = JSON.stringify([sigma.getCamera().getState(), bounds.width, bounds.height]);
  };
  // Keep native glyphs responsive and restore counted relations when the camera rests.
  let lastLineCameraFrame = JSON.stringify(sigma.getCamera().getState());
  let mainEdgeIds = new Set<string>();
  let nativeCountDirty = true;
  let nativeNodeIdsDrawn: string[] = [];
  let nativeEdgeIdsDrawn: string[] = [];
  const recountMainEdges = (): void => {
    mainEdgeIds = new Set([...scene.semanticEdges].filter(([, edge]) => {
      const source = scene.nodes.get(edge.source)?.style;
      const target = scene.nodes.get(edge.target)?.style;
      const level = edge.style.hierarchyLevel;
      return mainRelation({ attested: edge.attestation === 'attested', exploratory: edge.attestation === 'exploratory',
        sourceHub: source?.type === 'hub', targetHub: target?.type === 'hub',
        sourceDomain: source?.type === 'domain', targetDomain: target?.type === 'domain',
        ...(typeof level === 'number' ? { hierarchyLevel: level } : {}) });
    }).map(([id]) => id));
    nativeCountDirty = true;
  };
  recountMainEdges();
  // "D082-A-STALE BEGIN"
  const readinessSnapshot = () => {
    const stage = ladder.state.stage;
    const nodes = scene.nodes.size, semantic = scene.semanticEdges.size, visual = scene.visualRelations.size;
    const nodeCanvas = sigma.getCanvases().nodes, edgeCanvas = sigma.getCanvases().edges;
    if (nativeTier && nativeCountDirty) {
      nativeNodeIdsDrawn = [...scene.nodes.keys()].filter(id => { const data = sigma.getNodeDisplayData(id);
        return data !== undefined && !data.hidden; });
      nativeEdgeIdsDrawn = [...scene.semanticEdges.keys()].filter(id => { const data = sigma.getEdgeDisplayData(id);
        return data !== undefined && !data.hidden; });
      nativeCountDirty = nativeNodeIdsDrawn.length === 0 && scene.nodes.size > 0;
    }
    const nativeNodeIds = nativeTier && nodeCanvas?.style.display !== 'none' ? nativeNodeIdsDrawn : [];
    const nativeEdgeIds = nativeTier && edgeCanvas?.style.display !== 'none' ? nativeEdgeIdsDrawn : [];
    const morphologyVisible = !nativeTier && morphologyCanvas.style.visibility !== 'hidden'
      && morphologyContext !== null;
    const nodeDrawn = nativeTier ? nativeNodeIds.length : morphologyVisible ? paint.geometry.nodes.length : 0;
    const semanticDrawn = nativeTier ? nativeEdgeIds.length : morphologyVisible ? paint.geometry.edges.length : 0;
    const mainDrawn = nativeTier ? nativeEdgeIds.filter(id => mainEdgeIds.has(id)).length
      : morphologyVisible ? paint.geometry.edges.filter(edge => mainEdgeIds.has(edge.id)).length : 0;
    // "D086-BURST BEGIN"
    const typedOwner = scene.styled.projection.determinism.algorithmId === 'indras-pearls'
      ? 'indra' : scene.styled.projection.determinism.algorithmId;
    // "D086-BURST END"
    return {
      // "D086-BURST BEGIN": typed readiness uses the page's topology and reading key.
      view: `${typedOwner}/2d/${morphology}/${scope?.density ?? 'default'}/${scope?.reading ?? 'combined'}`,
      // "D086-BURST END"
      quality: ladder.state.moving ? 'movimento' : stage === FULL_QUALITY_STAGE ? 'completa' : 'recupero',
      ladder: stage,
      nodes: { required: nodes, loaded: nodes, drawn: nodeDrawn },
      mainEdges: { required: mainEdgeIds.size, loaded: mainEdgeIds.size, drawn: mainDrawn },
      allEdges: { required: semantic + visual, loaded: semantic + visual,
        drawn: semanticDrawn + visualEdgesPainted },
      decor: { labels: stage === FULL_QUALITY_STAGE, background: stage === FULL_QUALITY_STAGE,
        glow: stage === FULL_QUALITY_STAGE, animation: true },
      decorApplicable: { animation: false },
    } as const;
  };
  // "D086-BURST BEGIN"
  const readinessHost = renderReadinessHost(container);
  const publisher = createPresentedPublisher(presentRenderReadiness);
  publisher.setHost(readinessHost);
  // "D086-BURST END"
  const publishPresented = (): void => {
    publisher.publish(readinessSnapshot());
  };
  // "D082-A-STALE END"
  // Dense native glyphs remain visible while costly decorative canvases rest.
  const ladder = new QualityLadder(({ stage, moving }) => {
    if (nativeTier && scope?.density === 'complete') movingLines = stage < ALL_EDGES_QUALITY_STAGE;
    if (nativeTier) {
      morphologyCanvas.style.visibility = stage === FULL_QUALITY_STAGE ? '' : 'hidden';
      if (visuals.canvas) visuals.canvas.style.visibility = stage === FULL_QUALITY_STAGE ? '' : 'hidden';
    }
    const labelLayer = container.querySelector<HTMLElement>('[data-projection-labels]');
    if (labelLayer) labelLayer.style.visibility = stage === FULL_QUALITY_STAGE ? '' : 'hidden';
    if (!moving) redraw();
  });
  const redraw = (): void => {
    const lineCameraFrame = JSON.stringify(sigma.getCamera().getState());
    if (lineCameraFrame !== lastLineCameraFrame) {
      lastLineCameraFrame = lineCameraFrame;
      ladder.touch();
    }
    if (!nativeTier || ladder.state.stage === FULL_QUALITY_STAGE) drawMorphology();
    draw();
    if (!nativeTier || ladder.state.stage === FULL_QUALITY_STAGE) visuals.draw();
    if (ladder.state.stage === FULL_QUALITY_STAGE) labelPass();
    publishPresented();
    const bounds = container.getBoundingClientRect();
    const frame = JSON.stringify([sigma.getCamera().getState(), bounds.width, bounds.height]);
    if (frame !== pickFrame) {
      if (pickSettleTimer !== undefined) clearTimeout(pickSettleTimer);
      pickSettleTimer = setTimeout(() => { pickSettleTimer = undefined; rebuildPickIndex(); }, 2 ** (2 + 2 + 2 + 1));
    }
  };
  // Polish-III haze repair BEGIN: let the settled glow request one normal presentation after camera motion.
  (morphologyCanvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw = redraw;
  // Polish-III haze repair END
  sigma.on('afterRender', redraw);
  drawMorphology();
  draw();
  labelPass();
  publishPresented();
  rebuildPickIndex();
  const pickNow = (position: Vec2): PickResult | null => {
    const node = semanticPickIndex?.nodeAt(position);
    if (node) return { kind: 'node', id: node };
    const edge = semanticPickIndex?.edgeAt(position);
    if (edge) return { kind: 'semantic-edge', id: edge };
    const visual = visualPickIndex?.edgeAt(position);
    if (visual) return { kind: 'visual-relation', visualId: visual };
    return visuals.pickAt(position);
  };
  const localPointer = (event: PointerEvent): Vec2 => {
    const bounds = container.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  let replayingHover = false;
  let handlingHoverMove = false;
  let handlingClick = false;
  let latestClient = { x: 0, y: 0 };
  const hoverGate = createPointerPickGate(pickNow, () => {
    replayingHover = true;
    try {
      container.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: latestClient.x, clientY: latestClient.y,
      }));
    } finally { replayingHover = false; }
  }, () => sigma.getCamera().isAnimated());
  const onPointerMoveCapture = (event: PointerEvent) => {
    if (replayingHover) return;
    latestClient = { x: event.clientX, y: event.clientY };
    handlingHoverMove = true;
    hoverGate.move(localPointer(event));
    queueMicrotask(() => { handlingHoverMove = false; });
  };
  const onPointerDownCapture = (event: PointerEvent) => hoverGate.press(localPointer(event));
  const onPointerUpCapture = (event: PointerEvent) => hoverGate.release(localPointer(event));
  const onPointerCancelCapture = () => hoverGate.cancel();
  const onClickCapture = (event: MouseEvent) => {
    if (hoverGate.dragged()) {
      hoverGate.cancel();
      event.stopImmediatePropagation();
      return;
    }
    handlingClick = true;
    queueMicrotask(() => { handlingClick = false; });
  };
  const onPointerLeaveCapture = () => hoverGate.leave();
  container.addEventListener('pointermove', onPointerMoveCapture, true);
  container.addEventListener('pointerdown', onPointerDownCapture, true);
  container.addEventListener('pointerup', onPointerUpCapture, true);
  container.addEventListener('pointercancel', onPointerCancelCapture, true);
  container.addEventListener('pointerleave', onPointerLeaveCapture, true);
  container.addEventListener('click', onClickCapture, true);
  return {
    dimension: '2d',
    updateVisibleSubset(nextStyled, nextVisibility): void {
      const nextKey = projection2dVisibilityKey(nextStyled, nextVisibility);
      const action = projection2dRevisionAction(scene.revision, contentKey, nextVisibility.revision, nextKey);
      if (action !== 'apply') return;
      const next = prepareProjection2d(snapshot, nextStyled, nextVisibility);
      const nextScope = readProjectionStyle(nextStyled);
      const nextMorphology = nextScope?.morphology ?? morphology;
      for (const id of graph.edges()) if (!next.semanticEdges.has(id)) graph.dropEdge(id);
      for (const id of graph.nodes()) if (!next.nodes.has(id)) graph.dropNode(id);
      for (const id of next.nodes.keys()) {
        const attributes = projectionNodeAttributes(next, id);
        if (graph.hasNode(id)) graph.replaceNodeAttributes(id, attributes);
        else graph.addNode(id, attributes);
      }
      for (const [id, edge] of next.semanticEdges) {
        const attributes = projectionEdgeAttributes(next, id);
        if (graph.hasEdge(id) && graph.source(id) === edge.source && graph.target(id) === edge.target)
          graph.replaceEdgeAttributes(id, attributes);
        else {
          if (graph.hasEdge(id)) graph.dropEdge(id);
          graph.addEdgeWithKey(id, edge.source, edge.target, attributes);
        }
      }
      scene = next;
      recountMainEdges();
      // Switch the already-mounted Sigma layers with the scene size.
      const nextNativeTier = next.nodes.size >= DENSE_SCENE_THRESHOLD;
      if (nextNativeTier !== nativeTier) {
        nativeTier = nextNativeTier;
        detached.forEach((item, index) => { item.style.display = nativeTier ? previousDetachedDisplay[index] ?? '' : 'none'; });
      }
      contentKey = nextKey;
      scope = nextScope;
      if (!nativeTier || scope?.density !== 'complete') {
        movingLines = false;
      }
      labelBudget = nextScope?.labelBudget ?? labelBudget;
      morphology = nextMorphology;
      // One deterministic rebuild per applied revision (an expansion, never a frame): the engine
      // derives hub degree and colonies from the new subset, so nothing is patched in place.
      paint = projectionMorphologyPaint(nextMorphology, next, snapshot, nextScope?.curvature);
      visuals.updateVisibleSubset({ styled: nextStyled, visibility: nextVisibility });
      visuals.setMorphology(nextMorphology);
      sigma.refresh();
      redraw();
      rebuildPickIndex();
    },
    pickAtPoint(position): PickResult | null {
      if (replayingHover || handlingHoverMove) return hoverGate.hoverResult();
      if (handlingClick) return hoverGate.click(position) ?? null;
      return pickNow(position);
    },
    graphToViewport: point => sigma.graphToViewport(point),
    readCameraState: () => sigma.getCamera().getState(),
    // Zoom recompaction uses the same mounted Sigma camera for Adatta.
    restoreCameraState(state) {
      // Camera state changes schedule Sigma's normal render;
      // refresh would reprocess every node and edge, even for the same pose.
      const current = sigma.getCamera().getState();
      if (current.x !== state.x || current.y !== state.y || current.ratio !== state.ratio || current.angle !== state.angle)
        sigma.getCamera().setState(state);
    },
    readPlacedLabelIds: () => labels.readLabelIds(),
    readSurfaceWitness: () => ({ nodeIds: graph.nodes(), semanticEdgeIds: graph.edges(),
      visualRelationIds: [...scene.visualRelations.keys()], curveIds: [...scene.curves.keys()],
      containerIds: [...scene.containers.keys()], fieldIds: [...scene.fields.keys()] }),
    setDerivedMorphology: morphology => {
      visuals.setMorphology(morphology);
      // "D082-A-STALE BEGIN"
      publisher.invalidate();
      const snapshot = readinessSnapshot();
      // "D086-BURST BEGIN"
      presentRenderReadiness({ ...snapshot, quality: 'recupero', ladder: snapshot.ladder === FULL_QUALITY_STAGE ? ALL_EDGES_QUALITY_STAGE : snapshot.ladder,
        decor: { ...snapshot.decor, background: false } }, readinessHost);
      // "D086-BURST END"
      sigma.refresh();
      // "D082-A-STALE END"
    },
    destroy(): void {
      publisher.dispose();
      ladder.destroy();
      if (pickSettleTimer !== undefined) clearTimeout(pickSettleTimer);
      hoverGate.destroy();
      container.removeEventListener('pointermove', onPointerMoveCapture, true);
      container.removeEventListener('pointerdown', onPointerDownCapture, true);
      container.removeEventListener('pointerup', onPointerUpCapture, true);
      container.removeEventListener('pointercancel', onPointerCancelCapture, true);
      container.removeEventListener('pointerleave', onPointerLeaveCapture, true);
      container.removeEventListener('click', onClickCapture, true);
      sigma.off('afterRender', redraw);
      sigma.off('resize', collapseLayer);
      labels.destroy();
      collapsed.forEach((item, index) => {
        item.style.display = previousDisplay[index] ?? '';
        const backing = previousBacking[index];
        if (backing) { item.width = backing[0]; item.height = backing[1]; }
      });
      shrinkable.forEach((item, index) => {
        const backing = previousShrinkBacking[index];
        if (backing) { item.width = backing[0]; item.height = backing[1]; }
      });
      detached.forEach((item, index) => { item.style.display = previousDetachedDisplay[index] ?? ''; });
      // Polish-III haze repair BEGIN: a pending settled-glow callback must not repaint a removed canvas.
      delete (morphologyCanvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw;
      // Polish-III haze repair END
      morphologyCanvas.remove();
      visuals.destroy();
      sigma.kill();
    },
  };
}
