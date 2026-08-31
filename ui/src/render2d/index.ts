import Sigma from "sigma";
import { createEdgeCompoundProgram } from "sigma/rendering";
import type { CameraState, EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { parseColor } from "sigma/utils";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import type { Coordinates, DerivedValue, VisualGraph } from "#engine/contract.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import type { NodeFootprintWitness, WorldAnchorWitness } from "#engine/renderer-handle.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { createFilamentProgram, FilamentProgram } from "#render2d/filament-program.ts";
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
} from "#render2d/model.ts";
import type {
  LabelPlacementCandidate,
  RenderEdgeAttributes,
  RenderModel,
  RenderNodeAttributes,
  RenderOptions,
} from "#render2d/model.ts";

/** This reports one live glow footprint and does not expose graph semantics. */
export type RenderNodeGlowWitness = {
  readonly id: string;
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly coreRadiusPx: number;
  readonly haloRadiusPx: number;
};

/** This records the live material programs bound to one relation and does not expose graph semantics. */
export type RelationMaterialBinding = {
  readonly relationId: string;
  readonly materialTypes: readonly string[];
};

/** This reports one relation's live draw control point and does not inspect the render model. */
export type RenderRelationGeometryWitness = {
  readonly relationId: string;
  readonly controlPoint: { readonly x: number; readonly y: number };
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

/** This is one mounted renderer and does not retain an independent graph copy. */
export type RenderHandle = {
  readonly model: RenderModel;
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
  readCameraState(): RenderCameraState;
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
): RenderHandle {
  const suppliedState = initialVisualState === undefined
    ? undefined
    : createVisualState(visualGraph, initialVisualState);
  const activeOptions = resolveRenderOptions(suppliedState === undefined ? options : renderOptionsForVisualState(options, suppliedState));
  const model = buildRenderModel(visualGraph, activeOptions, undefined, suppliedAnchors);
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
  const materialBindings = createLiveRelationMaterialBindings();
  const geometryBindings = createLiveRelationGeometryBindings();
  const edgeProgramClasses = {
    filament: createObservedFilamentProgram(model.filamentMaterial, "filament", materialBindings, geometryBindings),
  };
  const sigma = new Sigma(model.graph, container, {
    defaultEdgeType: "filament",
    edgeProgramClasses,
    renderLabels: model.material.node.includes("label"),
    renderEdgeLabels: false,
    labelSize: calibration.labels.nodeLabelSizePx,
    edgeLabelSize: calibration.labels.edgeLabelSizePx,
    labelColor: { attribute: "labelColor", color: requiredTokenColor(model, "text") },
    edgeLabelColor: { attribute: "labelColor", color: requiredTokenColor(model, "textMuted") },
    zIndex: true,
    enableEdgeEvents: true,
  });
  const picking = sigma as unknown as {
    getNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null;
    getEdgeAtPoint(x: number, y: number): string | null;
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
  assertSingleMaterialPerRelation(liveRelationMaterialBindings(sigma, materialBindings));
  let currentState = suppliedState ?? createVisualState(visualGraph, {
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
  let edgeLabelRevealVisible = true;
  const applyVisualStateAppearance = (): void => {
    for (const [id, attributes] of baseNodeAttributes) {
      model.graph.replaceNodeAttributes(id, nodeAttributesForVisualState(attributes, id, currentState, appearanceCalibration));
    }
    for (const [id, attributes] of baseEdgeAttributes) {
      model.graph.replaceEdgeAttributes(id, edgeAttributesForVisualState(attributes, id, currentState, appearanceCalibration));
    }
    sigma.refresh();
  };
  const refreshCameraInVisualState = (): VisualState => createVisualState(visualGraph, {
    ...currentState,
    camera: readCameraState(sigma),
  });
  const updateVisualState = (selection: string | null, focus: string | null): void => {
    currentState = createVisualState(visualGraph, {
      ...refreshCameraInVisualState(),
      selectedId: selection,
      focusedId: focus,
    });
    applyVisualStateAppearance();
    placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible);
  };
  if (currentState.selectedId !== null || currentState.focusedId !== null) {
    applyVisualStateAppearance();
  }
  placeNodeLabels(sigma, model, calibration);
  placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible);
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
  const glow = model.material.node.includes("halo")
    ? mountNodeGlow(sigma, model, options.calibration)
    : noGlowLayer();
  sigma.refresh();
  return {
    model,
    graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
      return sigma.graphToViewport(point);
    },
    readCameraState(): RenderCameraState {
      return readCameraState(sigma);
    },
    restoreCameraState(state: RenderCameraState): void {
      restoreCameraState(sigma, state);
      currentState = createVisualState(visualGraph, { ...currentState, camera: state });
      placeNodeLabels(sigma, model, calibration);
      placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible);
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
      placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible);
    },
    setEdgeLabelRevealVisible(visible: boolean): void {
      edgeLabelRevealVisible = visible;
      placeEdgeLabels(sigma, model, currentState, calibration, edgeLabelRevealVisible);
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
        createObservedFilamentProgram(model.filamentMaterial, "filament", materialBindings, geometryBindings),
        createObservedFilamentProgram(model.filamentMaterial, "filament-control", materialBindings, geometryBindings),
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
      return picking.getNodeAtPosition(position);
    },
    pickEdgeAtPoint(x: number, y: number): string | null {
      return picking.getEdgeAtPoint(x, y);
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
      glow.destroy();
      windows.destroy();
      sigma.kill();
    },
  };
}

/** This records material programs after their live processing pass and does not infer them from graph attributes. */
type LiveRelationMaterialBindings = {
  observe(sigma: Sigma): void;
  record(fingerprint: number, materialType: string): void;
  materialTypesFor(sigma: Sigma, relationId: string): readonly string[];
};

/** This records control points written into the live program attribute buffer and does not derive them from display attributes. */
type LiveRelationGeometryBindings = {
  observe(sigma: Sigma): void;
  record(fingerprint: number, controlPoint: { readonly x: number; readonly y: number }): void;
  controlPointFor(sigma: Sigma, relationId: string): { readonly x: number; readonly y: number } | undefined;
};

/** This creates a live material-program recorder and does not construct bindings from relation types. */
function createLiveRelationMaterialBindings(): LiveRelationMaterialBindings {
  let materialTypesByFingerprint = new Map<number, string[]>();
  return {
    observe(sigma: Sigma): void {
      sigma.on("beforeProcess", () => {
        materialTypesByFingerprint = new Map<number, string[]>();
      });
    },
    record(fingerprint: number, materialType: string): void {
      const materialTypes = materialTypesByFingerprint.get(fingerprint) ?? [];
      materialTypes.push(materialType);
      materialTypesByFingerprint.set(fingerprint, materialTypes);
    },
    materialTypesFor(sigma: Sigma, relationId: string): readonly string[] {
      const fingerprint = relationFingerprints(sigma).get(relationId);
      if (fingerprint === undefined) {
        throw new TypeError(`live relation ${relationId} has no Sigma fingerprint`);
      }
      return [...(materialTypesByFingerprint.get(fingerprint) ?? [])];
    },
  };
}

/** This creates a recorder for the actual control attributes written by the live filament program. */
function createLiveRelationGeometryBindings(): LiveRelationGeometryBindings {
  let controlPointsByFingerprint = new Map<number, { readonly x: number; readonly y: number }>();
  return {
    observe(sigma: Sigma): void {
      sigma.on("beforeProcess", () => {
        controlPointsByFingerprint = new Map<number, { readonly x: number; readonly y: number }>();
      });
    },
    record(fingerprint, controlPoint): void {
      controlPointsByFingerprint.set(fingerprint, controlPoint);
    },
    controlPointFor(sigma: Sigma, relationId: string): { readonly x: number; readonly y: number } | undefined {
      const fingerprint = relationFingerprints(sigma).get(relationId);
      if (fingerprint === undefined) {
        throw new TypeError(`live relation ${relationId} has no Sigma fingerprint`);
      }
      return controlPointsByFingerprint.get(fingerprint);
    },
  };
}

/** This instruments a filament program's actual live processing and does not create another relation. */
function createObservedFilamentProgram(
  material: FilamentUniformMaterial,
  materialType: string,
  bindings: LiveRelationMaterialBindings,
  geometryBindings: LiveRelationGeometryBindings,
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
  };
}

/** This reads material programs that actually processed every live relation and does not inspect source graph semantics. */
function liveRelationMaterialBindings(sigma: Sigma, bindings: LiveRelationMaterialBindings): readonly RelationMaterialBinding[] {
  const graph = sigma.getGraph();
  return [...graph.edges()].sort().map((relationId) => {
    const materialTypes = bindings.materialTypesFor(sigma, relationId);
    if (materialTypes.length === 0) {
      throw new TypeError(`live relation ${relationId} has no processed material program`);
    }
    return { relationId, materialTypes };
  });
}

/** This reconstructs Sigma's internal processing-order fingerprints from public display state and does not infer a material binding. */
function relationFingerprints(sigma: Sigma): ReadonlyMap<string, number> {
  const graph = sigma.getGraph();
  const relationIds = [...graph.edges()];
  if (sigma.getSetting("zIndex")) {
    relationIds.sort((left, right) => {
      const leftData = sigma.getEdgeDisplayData(left);
      const rightData = sigma.getEdgeDisplayData(right);
      if (leftData === undefined || rightData === undefined) {
        throw new TypeError("live relation fingerprint requires display data");
      }
      return leftData.zIndex - rightData.zIndex;
    });
  }
  const firstRelationFingerprint = graph.nodes().length + 1;
  return new Map(relationIds.map((relationId, offset) => [relationId, firstRelationFingerprint + offset]));
}

/** This reads control attributes from the live filament program and does not recreate them with a geometry helper. */
function liveRelationGeometryWitnesses(
  sigma: Sigma,
  bindings: LiveRelationGeometryBindings,
): readonly RenderRelationGeometryWitness[] {
  const graph = sigma.getGraph();
  return [...graph.edges()].sort().map((relationId) => {
    const controlPoint = bindings.controlPointFor(sigma, relationId);
    if (controlPoint === undefined) {
      throw new TypeError(`live relation ${relationId} has no processed control-point attributes`);
    }
    const viewportControlPoint = sigma.framedGraphToViewport(controlPoint);
    return { relationId, controlPoint: { x: viewportControlPoint.x, y: viewportControlPoint.y } };
  });
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
): GlowLayer {
  const profile = calibration ?? DEFAULT_CALIBRATION;
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
      );
      if (haloRadius <= coreRadius) {
        continue;
      }
      const gradient = context.createRadialGradient(center.x, center.y, coreRadius, center.x, center.y, haloRadius);
      const color = parseColor(attributes.color);
      const peakAlpha = (boundedPermille(attributes.haloIntensityPermille, profile) / permilleScale(profile)) * color.a;
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
          ),
        };
      });
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

/** This keeps the calibrated clear radial gap around every resolved node core. */
function resolvedGlowHaloRadius(
  coreRadiusPx: number,
  requestedHaloRadiusPx: number,
  calibration: CalibrationProfile,
): number {
  return Math.max(requestedHaloRadiusPx, coreRadiusPx + calibration.luminance.coreBeforeHaloMinimumPx);
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
  sigma.setCustomBBox({
    x: [state.bounds.x[0], state.bounds.x[1]],
    y: [state.bounds.y[0], state.bounds.y[1]],
  });
  sigma.getCamera().setState(state);
  sigma.refresh();
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
  for (const id of model.graph.nodes()) {
    const attributes = model.graph.getNodeAttributes(id);
    model.graph.setNodeAttribute(id, "label", selected.has(id) ? attributes.labelText : "");
  }
  sigma.refresh();
}

/** This renders a small collision-filtered subset of IR-derived relation labels and does not alter relation identity. */
function placeEdgeLabels(
  sigma: Sigma,
  model: RenderModel,
  state: Pick<VisualState, "selectedId" | "focusedId">,
  calibration: CalibrationProfile,
  revealVisible: boolean,
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
    const candidates = eligible.map((candidate) => {
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
    for (const id of resolveLabelIds(candidates, calibration, calibration.labels.edgeDensityCap)) {
      visible.add(id);
    }
  }
  const byId = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  for (const id of model.graph.edges()) {
    const candidate = byId.get(id);
    const shown = candidate !== undefined && visible.has(id);
    const attributes = model.graph.getEdgeAttributes(id);
    model.graph.mergeEdgeAttributes(id, {
      label: shown && candidate !== undefined ? candidate.text : "",
      forceLabel: shown,
      labelColor: candidate === undefined
        ? attributes.labelColor
        : withCalibratedAlpha(attributes.labelColor, candidate.opacityPermille, calibration),
    });
  }
  sigma.setSetting("renderEdgeLabels", visible.size > 0);
  sigma.refresh();
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
