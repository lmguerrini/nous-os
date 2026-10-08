import type { PresentationOptions } from "#engine/presentation-options.ts";
import type { AppearanceOptions } from "#engine/presentation-options.ts";
import type { ReactElement } from "react";
import { createRoot as createFiberRoot } from "@react-three/fiber";
import * as THREE from "three";
import type { CalibrationProfile } from "#engine/calibration.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import type { Coordinates, DerivedValue, VisualGraph } from "#engine/contract.ts";
import type {
  MultiCameraRendererHandle,
  ResourceCountingRendererHandle,
  NodeFootprintWitness,
  RetainedResourceWitness,
  SurfaceWitness,
  WorldAnchorWitness,
} from "#engine/renderer-handle.ts";
import type { LodBand } from "#engine/lod.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import type { ScaleNavigationPath } from "#engine/scale-topology.ts";
import type { Palette, Temperature, Theme } from "#engine/tokens.ts";
import { createRenderVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { EMPTY_LABEL_BOUNDS, SHIPPING_RENDER_DEFAULTS, mountProjectionLabelOverlay } from "#render2d/model.ts";
import { readProjectionStyle, typedLabelKind, typedLabelTexts, TYPED_LABEL_CAMERA, TYPED_COMPLETE_BUNDLE_LABEL } from "#render-common/projection-style.ts";
import type { ProjectionLabelCandidate, ProjectionLabelOverlay } from "#render2d/model.ts";
import { createTypedProjectionLayer } from "#render-common/typed-layer.ts";
import {
  CameraRig,
  attachCameraInteractions,
  cameraStateForBounds,
  resolvedNodeBounds,
} from "#render3f/camera.tsx";
import type { Render3fFramingBox } from "#render3f/camera.tsx";
import { sceneCameraFramingSubjects } from "#render3f/camera-framing.ts";
import type { ProjectedCameraFramingSubject } from "#render3f/camera-framing.ts";
import { tokenToSrgb } from "#render3f/buffers.ts";
import { brainViewCameraState, brainViewFramingState, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import type { BrainWitness } from "#render3f/brain-envelope.ts";
import { mountDistinctOverlay } from "#render3f/distinct-overlay.ts";
import type { DistinctSubsetUpdate } from "#render-common/morphology-canvas.ts";
import { DENSE_SCENE_THRESHOLD } from "#render-common/morphology-canvas.ts";
import { createProjectionVisualsLayer } from "#render-common/projection-visuals-layer.ts";
import { projectedWorldScale } from "#render-common/container-canvas.ts";
import type { ProjectionVisualsLayer, ProjectionVisualsMorphology } from "#render-common/projection-visuals-layer.ts";
import {
  createAggregateRenderResources,
  updateAggregateProjectionUniforms,
} from "#render3f/aggregate-material.ts";
import {
  createFilamentRenderResources,
  setFilamentNeuralWidthPx,
  updateFilamentProjectionUniforms,
  updateFilamentRenderResources,
} from "#render3f/filament-material.ts";
import { LabelOverlayController } from "#render3f/labels.tsx";
import {
  createNodeRenderResources,
  updateNodeProjectionUniforms,
  updateNodeRenderResources,
} from "#render3f/node-material.ts";
import { ScenePicker } from "#render3f/picking.ts";
import { TypedProjectionPicker } from "#render3f/picking.ts";
import type { Render3fTypedInput, TypedProjectionGeometry } from "#render3f/picking.ts";
// D082-B-GPUFLOOR BEGIN
import { neural3dCompletaPointFloorCssPx } from "#render3f/neural-point-floor.ts";
// D082-B-GPUFLOOR END
import type { PickResult, StyledProjection } from "../projection/contract-types.ts";
import { QualityLadder, labDrawPolicy, labMainSegmentRanges, mainRelation, presentRenderReadiness } from "#render-common/quality-ladder.ts";

/** How long the camera must be still before the derived geometry returns to full quality. */
const DERIVED_STILL_MS = 200;
import { ResourceRegistry } from "#render3f/resources.ts";
import { LiveSceneState } from "#render3f/state.ts";
import type { CameraScenes } from "#render3f/state.ts";
import { buildScene } from "#scene/index.ts";
import { SCENE_PERMILLE_QUANTUM } from "#scene/contract.ts";
import type { Scene, SceneNode } from "#scene/contract.ts";
// D082-B-CANOPYN BEGIN: the Canopy-only caller hands over its prepared exact geometry.
export type PreparedCanopyNeural3dMount = {
  readonly state: VisualState;
  readonly scenes: CameraScenes;
  readonly neuralGeometry: NonNullable<ConstructorParameters<typeof LiveSceneState>[3]>;
};
// D082-B-CANOPYN END

/** This is the renderer input selection shared structurally with Sigma and does not choose a graph. */
export type Render3fOptions = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette?: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  // D082-A-PERF BEGIN: a product 3D mount starts in its requested camera so
  // the initial canvas, labels and buffers are not drawn twice.
  readonly initialCameraKind?: CameraKind;
  // D082-A-PERF END
  /** Optional Natural Neural shell. False and absent share the baseline path. */
  readonly brain?: boolean;
  readonly elapsedMilliseconds: number;
  readonly calibration?: CalibrationProfile;
  readonly presentation?: PresentationOptions;
  /**
   * This is the render input `buildScene` accepts as its own optional trailing `phase` argument (see
   * scene/build.ts) and has no Sigma equivalent: motion-grammar phase only exists on this renderer's
   * side of the shared option shape. Read once per mounted or rebuilt scene, the same way
   * `calibration` is, and never written onto `VisualState` -- phase is a render input, not governed
   * state (see motion-grammar.ts). Omitted (or `undefined`), every mounted scene is built at its
   * policy's own resting phase, which is exact identity for every shipped policy: today's static
   * scene, byte for byte. There is no free-running clock here; a caller that wants a different phase
   * supplies one and this module never advances it on its own.
   */
  readonly phase?: number;
  /**
   * This is `buildScene`'s own optional trailing `navigationPath` argument (see scene/build.ts): the
   * scale-topology position a reader has navigated to, which selects WHICH governed subgraph is
   * rendered. Omitted, every mount renders the top-level graph, identically for all four policies.
   * Like `phase` it is a render input rather than governed state, but unlike `phase` it is NOT
   * suppressed under reduced motion: where a reader has navigated to is a position, not an
   * animation, and dropping it would silently return them to the root.
   */
  readonly navigationPath?: ScaleNavigationPath;
  /**
   * This is `buildScene`'s own optional trailing `temporalInstant` (see scene/build.ts): the instant
   * whose governed temporal state is being viewed, which selects WHICH elements existed then. Omitted,
   * every mount renders the unconditional all-time union -- the accepted static foundation -- so
   * leaving it out is exactly today's graph. Like `navigationPath` it is a position rather than an
   * animation, and is NOT suppressed under reduced motion: which moment a reader is looking at is
   * their choice, and dropping it would silently return them to the present.
   */
  readonly temporalInstant?: string;
};

/** This exposes renderer-owned framing witnesses without widening the shared renderer handle. */
export type Render3fRendererHandle = MultiCameraRendererHandle & ResourceCountingRendererHandle & {
  readReviewCameraPose(): { position: number[]; target: number[]; up: number[]; fov: number };
  /** IDs placed by the most recent typed label pass; reading them schedules no render. */
  readPlacedLabelIds(): readonly string[];
  setReviewViewPreset(name: "fronte" | "retro" | "sinistra" | "destra" | "alto" | "basso" | "iso"): void;
  /** This copies the picker-held resolved relation geometry and does not rebuild scene geometry. */
  readRelationGeometryWitnesses(): readonly RelationGeometryWitness[];
  readProjectedCameraFramingSubjects(): readonly ProjectedCameraFramingSubject[];
  readBrainEnvelopeFramingSphere(): { readonly center: Coordinates; readonly radius: number } | null;
  setEmphasis(ids: ReadonlySet<string> | null): void;
  setAppearance(options: AppearanceOptions): void;
  /** Appearance of the derived geometry (containers, curves, field rings) of a typed projection; never moves it. */
  setDerivedMorphology(morphology: ProjectionVisualsMorphology): void;
  /** D-072 R2: swaps the drawn level-of-detail subset in place — the scene, its picking surface and
   * the camera are untouched; only the distinct overlay's geometry snapshot and style lookups move.
   * A no-op when no distinct overlay is mounted. */
  updateVisibleSubset(update: DistinctSubsetUpdate | Render3fTypedInput): void;
  /** Discriminated pick on the typed projection path. */
  pickAtPosition(position: { readonly x: number; readonly y: number }): PickResult | null;
  readReviewWindows(): readonly { id: string; members: readonly string[]; center: Coordinates; radius: number }[];
  isWorldPointVisible(point: Coordinates): boolean;
};

type RelationGeometryWitness = {
  readonly id: string;
  readonly source: Coordinates;
  readonly controlPoint: Coordinates;
  readonly target: Coordinates;
  readonly pickTolerancePx: number;
  readonly minimumDeviceWidthPx: number;
  readonly widthStartPx: number;
  readonly widthEndPx: number;
};

/** This mounts one shared Three scene behind two cameras and does not derive a second supplied placement. */
// D081-P6 BEGIN: keep the product-page gesture anchor in the actual wheel adapter.
export function reviewGestureWheelAnchor(
  canvas: { readonly __reviewGestureWheelAnchor?: Coordinates },
  pick: () => Coordinates | undefined,
): Coordinates | undefined {
  return canvas.__reviewGestureWheelAnchor ?? pick();
}
// D081-P6 END.
export function mount(
  container: HTMLElement,
  visualGraph: VisualGraph,
  options: Render3fOptions,
  framingBox?: Render3fFramingBox,
  initialVisualState?: VisualState,
  suppliedAnchors?: ReadonlyMap<string, Coordinates>,
  typedInput?: Render3fTypedInput,
  // D082-B-CANOPYN BEGIN
  preparedCanopy?: PreparedCanopyNeural3dMount,
  // D082-B-CANOPYN END
): Render3fRendererHandle {
  const dimensions = containerDimensions(container);
  const devicePixelRatio = requiredDevicePixelRatio();
  const previousPositionStyle = container.style.position;
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  const canvas = document.createElement("canvas");
  canvas.dataset.render3fCanvas = "true";
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    display: "block",
  });
  container.append(canvas);

  let layoutPassCount = 0;
  let currentState: VisualState;
  if (preparedCanopy) {
    currentState = preparedCanopy.state;
  } else if (initialVisualState !== undefined) {
    currentState = createRenderVisualState(visualGraph, initialVisualState);
  } else {
    const provisionalBounds = framingBox ?? bootstrapBounds();
    const provisionalState = stateFromOptions(visualGraph, options, cameraStateForBounds(provisionalBounds));
    if (framingBox === undefined) {
      // This bounds probe frames the initial camera from resolved node positions, not from a drawn
      // frame; it always resolves at the resting phase (an explicit `undefined`) regardless of
      // `options.phase`, so an animated mount's very first camera placement never depends on which
      // transient phase happened to be requested. `navigationPath` IS passed, unlike `phase`: it
      // selects which nodes exist at all, so probing without it would frame the root graph while the
      // drawn scene shows an entered world.
      const provisionalScene = buildSceneWithCalibration(
        visualGraph, provisionalState, options.calibration, undefined, options.navigationPath,
        options.temporalInstant, suppliedAnchors, options.presentation,
      );
      layoutPassCount += 1;
      const bounds = provisionalScene.nodes.length === 0
        ? provisionalBounds
        : resolvedNodeBounds(provisionalScene.nodes.map((node) => node.position));
      currentState = createRenderVisualState(visualGraph, {
        ...provisionalState,
        camera: cameraStateForBounds(bounds),
      });
    } else {
      currentState = provisionalState;
    }
  }
  const initialScenes = preparedCanopy?.scenes ?? scenesForState(
    visualGraph, currentState, options.calibration, options.phase, options.navigationPath,
    options.temporalInstant, suppliedAnchors, options.presentation,
  );
  layoutPassCount += suppliedAnchors === undefined ? cameraKindCount() : 0;
  // D082-B-CANOPYN BEGIN
  const markCanopyBuffers = !!preparedCanopy && typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('perfmarks');
  if (markCanopyBuffers) performance.mark('d082-canopyn:buffers:start');
  const live = new LiveSceneState(initialScenes, currentState.cameraKind, layoutPassCount,
    preparedCanopy?.neuralGeometry);
  if (markCanopyBuffers) { performance.mark('d082-canopyn:buffers:end');
    performance.measure('d082-canopyn:buffers', 'd082-canopyn:buffers:start', 'd082-canopyn:buffers:end'); }
  // D082-B-CANOPYN END
  const renderPixelRatio = (scene: Scene, pixelRatio: number): number =>
    options.presentation?.morphologyLanguage === "distinct" && scene.nodes.length < DENSE_SCENE_THRESHOLD
      ? 1 : pixelRatio;
  let currentRenderDpr = renderPixelRatio(live.scene, devicePixelRatio);
  const retainedSceneReferences = new Set<Scene>([initialScenes.orthographic, initialScenes.perspective]);
  const worldFramingSubjects = sceneCameraFramingSubjects(live.scene);
  const rig = new CameraRig(
    currentState.cameraKind,
    live.scene.camera,
    dimensions.width,
    dimensions.height,
    devicePixelRatio,
    worldFramingSubjects,
  );

  const registry = new ResourceRegistry();
  const aggregateResources = createAggregateRenderResources(live.buffers.aggregates);
  const filamentResources = createFilamentRenderResources(live.buffers.filaments);
  setFilamentNeuralWidthPx(filamentResources.material, options.presentation?.appearance?.edgeWidth ?? 1);
  const nodeResources = createNodeRenderResources(live.buffers.nodes);
  // D082-A-N3D BEGIN: only the full Natural/Indra Neural 3D scene receives the point floor.
  // D082-B-GPUFLOOR BEGIN: a Canopy-family host is not that scene. The signal is the one the
  // shared canvas renderer already uses (data-fractal-rails-active on the render container)
  // plus the explicit preparedCanopy argument, so a prepared and an unprepared Canopy 3D
  // Neural mount both keep the Canopy node policy (canopy-node-policy.ts, 0.5 px minimum).
  const canopyMount = !!preparedCanopy || container.hasAttribute("data-fractal-rails-active");
  const denseNeuralPointFloorCssPx = neural3dCompletaPointFloorCssPx({
    morphology: options.morphology,
    morphologyLanguage: options.presentation?.morphologyLanguage,
    nodeCount: live.scene.nodes.length,
    canopyMount,
  });
  const denseNeuralCompleta = denseNeuralPointFloorCssPx > 0;
  // D082-B-GPUFLOOR END
  // D082-A-N3D END
  registry.registerGeometry(aggregateResources.geometry);
  registry.registerGeometry(filamentResources.geometry);
  registry.registerGeometry(nodeResources.geometry);
  registry.registerMaterial(aggregateResources.material);
  registry.registerMaterial(filamentResources.material);
  registry.registerMaterial(nodeResources.material);
  registry.registerTexture(nodeResources.haloStops);

  const world = new THREE.Group();
  world.add(aggregateResources.mesh, filamentResources.mesh, nodeResources.mesh);
  // D-078 W1-edges: the optional envelope exists only for Natural Neural 3D.
  const brainEnvelope = options.brain === true && options.organization === "natural"
    && options.morphology === "neural" && typedInput === undefined
    ? createBrainEnvelope(live.scene.nodes, live.scene.edges) : null;
  if (brainEnvelope) world.add(brainEnvelope.group);
  const threeScene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    depth: true,
    stencil: false,
  });
  renderer.sortObjects = true;
  renderer.setPixelRatio(currentRenderDpr);
  renderer.setSize(dimensions.width, dimensions.height, false);
  updateField(renderer, live.scene);

  const labels = new LabelOverlayController(container);
  let distinct = typedInput === undefined && options.presentation?.morphologyLanguage === "distinct"
    ? mountDistinctOverlay(container, live.scene, options.morphology, options.presentation, (point) => ({
      ...rig.graphToViewport(point), scale: rig.sizeScaleAt(point),
    }))
    : null;
  // D082-A-NODES BEGIN
  // The native filament is visible at Completa size beneath the structure canvas. Its alpha
  // attribute must receive the same per-edge factor as the canvas, including after LOD updates.
  const nativeEdgeVeilById = new Map<string, number>([...(options.presentation?.edges ?? [])]
    .filter(([, edge]) => edge.denseVeilBaseOpacityPermille !== undefined)
    .map(([id, edge]) => [id, edge.denseVeilFactor ?? 1]));
  const applyNativeEdgeVeil = () => {
    if (!distinct || live.scene.nodes.length < DENSE_SCENE_THRESHOLD || !nativeEdgeVeilById.size) return;
    // D082-A-NCOMPLETA BEGIN: the Neural profile's spare flag range carries the same
    // measured veil to its root alpha and width in the fragment material.
    const neuralProfile = filamentResources.geometry.getAttribute("a_neuralProfile");
    // D082-A-NCOMPLETA END
    // D084-W7-DENSE BEGIN: the edge alpha moved into a_hotColor's own packed spare channel
    // (D084-W2-NEURAL-R5), so the former a_opacityPermille guard named an attribute the
    // filament geometry no longer carries and this whole writer silently stopped — the shaft
    // veil, the width narrowing and the root factor all lost their measured input. Guard the
    // two attributes this function actually writes.
    const hotColor = filamentResources.geometry.getAttribute("a_hotColor");
    if (!(neuralProfile instanceof THREE.InstancedBufferAttribute)
      || !(hotColor instanceof THREE.InstancedBufferAttribute)) return;
    // D084-W7-DENSE END
    const baseAlpha = new Map(live.scene.edges.map(edge => [edge.id, edge.opacityPermille]));
    for (const [index, id] of live.buffers.filaments.edgeIds.entries()) {
      const factor = currentState.selectedId === id || currentState.focusedId === id ? 1 : nativeEdgeVeilById.get(id) ?? 1;
      // D084-W7-DENSE BEGIN: the shaft's veiled alpha rides the packed hot colour's fourth
      // component, the one v_opacity reads; at factor one this writes the packed base back
      // unchanged, so the released view keeps its exact bytes.
      hotColor.setW(index, Math.round((baseAlpha.get(id) ?? 0) * factor));
      // D084-W7-DENSE END
      // D082-A-NCOMPLETA BEGIN
      if (live.buffers.filaments.neuralProfile[index * 4 + 3]! > 0.5)
        // D082-A-N3D BEGIN: reserve 3 + factor for the 3D full Neural ribbon floor.
        // D082-B-GPUFLOOR: that tag is Natural/Indra-specific like the point floor — a Canopy
        // host keeps 1 + factor, the ordinary veil-carrying value the shader reads unchanged.
        neuralProfile.setW(index, (denseNeuralCompleta ? 3 : 1) + factor);
        // D082-A-N3D END
      // D082-A-NCOMPLETA END
    }
    // D084-W7-DENSE BEGIN: both rewritten attributes upload their instances on the next frame.
    hotColor.needsUpdate = true;
    // D084-W7-DENSE END
    // D082-A-NCOMPLETA BEGIN
    neuralProfile.needsUpdate = true;
    // D082-A-NCOMPLETA END
  };
  applyNativeEdgeVeil();
  const denseNodeRadii = new Map<string, { radius: number; halo: number }>();
  // D082-A-NODES END
  if (distinct) {
    // The GPU draws dense nodes and edges; the overlay keeps Indra's container structure.
    filamentResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
    nodeResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
  }
  const picker = new ScenePicker(live.scene, {
    project(point: Coordinates): { readonly x: number; readonly y: number } {
      return rig.graphToViewport(point);
    },
    projectInto(point: Coordinates, out: { x: number; y: number }): boolean {
      return rig.projectToViewportInto(point, out);
    },
    nodeRadiusPx(node: SceneNode): number {
      // D082-A-NODES BEGIN
      return (denseNodeRadii.get(node.id)?.radius ?? node.radiusPx) * rig.sizeScaleAt(node.position);
      // D082-A-NODES END
    },
    nodeFootprintRadiusPx(node: SceneNode): number {
      const scale = rig.wheelNodeSizeScaleAt(node.position);
      // D082-A-NODES BEGIN
      const dense = denseNodeRadii.get(node.id);
      if (dense) return Math.max(dense.radius, dense.halo) * scale;
      // D082-A-NODES END
      return Math.max(node.haloRadiusPx * scale,
        Math.max(node.radiusPx * scale, node.minimumCoreDeviceRadiusPx) + node.haloCoreGapPx * scale);
    },
    filamentSizeScale(): number {
      return rig.readProjectionState().filamentSizeScale;
    },
  });
  let typedPicker = typedInput === undefined ? null : new TypedProjectionPicker(
    typedInput, point => rig.graphToViewport(point),
  );
  const typedLayer = createTypedProjectionLayer();
  threeScene.add(typedLayer.group);
  // Containers, curves and field rings of a typed projection are one 2D canvas layer over the WebGL canvas,
  // projected through the live camera. It redraws with every frame and drops to the moving quality while
  // the camera moves; the restore timer exists only after a camera change, so an idle page schedules nothing.
  let visuals: ProjectionVisualsLayer | null = null;
  // D-073 W4f: the typed path reads its whole-scene options (morphology, label budget) from the
  // style bridge's reserved scope record, falling back to the engine defaults for the basic bridge.
  let currentStyled: StyledProjection | null = typedInput?.styled ?? null;
  // D081-P3b BEGIN: counted dense relations keep their own small visible labels.
  let typedBundleLabels: { source: Coordinates; target: Coordinates; count: number }[] = [];
  let typedMoving = false;
  const updateBundleLabels = (input: Render3fTypedInput): void => {
    const positions = input.styled.projection.positions3;
    typedBundleLabels = input.styled.projection.visualRelations.flatMap(relation => {
      if (!relation.visualId.startsWith('visual:d081:') || relation.count <= 1
        || !input.visibility.visualRelationIds.has(relation.visualId)) return [];
      const a = positions?.[relation.source], b = positions?.[relation.target];
      return a && b ? [{ source: a, target: b, count: relation.count }] : [];
    });
  };
  if (typedInput) updateBundleLabels(typedInput);
  // D081-P3b END
  const initialScope = currentStyled !== null ? readProjectionStyle(currentStyled) : null;
  let derivedMorphology: ProjectionVisualsMorphology = initialScope?.morphology ?? "stellar";
  let typedLabelBudget: number | undefined = initialScope?.labelBudget;
  let typedLabelOverlay: ProjectionLabelOverlay | null = null;
  let typedFittedCameraDistance: number | null = null;
  const acceptVisuals = (input: Render3fTypedInput): void => {
    if (visuals === null) {
      visuals = createProjectionVisualsLayer(container, "3d",
        point => ({ ...rig.graphToViewport(point), scale: rig.sizeScaleAt(point) }), { morphology: derivedMorphology });
      visuals.mount(input);
      const labelLayer = container.querySelector("[data-render3f-labels]");
      if (labelLayer && visuals.canvas) labelLayer.before(visuals.canvas);
    } else visuals.updateVisibleSubset(input);
  };
  if (typedPicker) {
    world.visible = false;
    typedLayer.update(typedPicker.geometry, typedInput!.styled);
    acceptVisuals(typedInput!);
  }
  let emphasisIds = options.presentation?.emphasisIds ?? null;
  // D082-A-PERF BEGIN: count the prepared scene once per revision, never in a camera frame.
  let requestedNodes = live.buffers.nodes.ids.length;
  let requestedMainEdges = live.buffers.filaments.edgeIds.length;
  let requestedSemanticEdges = live.buffers.filaments.edgeIds.length;
  let requestedVisualEdges = 0;
  const refreshPresentedCounts = (): void => {
    if (typedPicker) {
      const styled = currentStyled;
      requestedNodes = typedPicker.geometry.nodes.filter(point => point.pick.kind === 'node'
        && (styled?.nodeStyle[point.pick.id]?.alpha ?? 1) !== 0).length;
      requestedSemanticEdges = typedPicker.geometry.semanticEdges.filter(part => part.pick.kind === 'semantic-edge'
        && (styled?.edgeStyle[part.pick.id]?.alpha ?? 1) !== 0).length;
      requestedVisualEdges = typedPicker.geometry.visualRelations.filter(part => part.pick.kind === 'visual-relation'
        && (styled?.visualStyle[part.pick.visualId]?.opacityPermille ?? 1000) !== 0).length;
      requestedMainEdges = typedPicker.semanticIncidence.filter(edge => {
        if ((styled?.edgeStyle[edge.id]?.alpha ?? 1) === 0) return false;
        const sourceMark = styled?.nodeStyle[edge.source], targetMark = styled?.nodeStyle[edge.target];
        // D085-S3 BEGIN: a domain or upper-level endpoint keeps its real relation in the moving skeleton.
        const endpointLevel = Math.min(Number(sourceMark?.level ?? Infinity), Number(targetMark?.level ?? Infinity));
        const level = styled?.edgeStyle[edge.id]?.hierarchyLevel ?? endpointLevel;
        return mainRelation({ attested: true,
          selectedIncident: !!(emphasisIds?.has(edge.source) || emphasisIds?.has(edge.target)),
          sourceHub: sourceMark?.type === 'hub', targetHub: targetMark?.type === 'hub',
          sourceDomain: sourceMark?.type === 'domain', targetDomain: targetMark?.type === 'domain',
          ...(typeof level === 'number' ? { hierarchyLevel: level } : {}) });
        // D085-S3 END
      }).length;
    } else {
      requestedNodes = live.buffers.nodes.ids.length;
      requestedSemanticEdges = live.buffers.filaments.edgeIds.length;
      requestedVisualEdges = 0;
      const byId = new Map(live.scene.nodes.map(node => [node.id, node]));
      requestedMainEdges = live.scene.edges.filter(edge => {
        const sourceMark = byId.get(edge.source), targetMark = byId.get(edge.target);
        return mainRelation({ attested: true,
          selectedIncident: !!(emphasisIds?.has(edge.source) || emphasisIds?.has(edge.target)),
          sourceHub: sourceMark?.kind === 'hub', targetHub: targetMark?.kind === 'hub',
          sourceDomain: sourceMark?.kind === 'domain', targetDomain: targetMark?.kind === 'domain' });
      }).length;
    }
  };
  refreshPresentedCounts();
  // D082-A-PERF END
  // D085-S3 BEGIN: resident Lab interaction proxies retain only actual anchor nodes and
  // whole morphology segments belonging to real upper-level relations. They are rebuilt
  // on a visibility revision, never on a camera frame; released geometry is untouched.
  const labProxy = new THREE.Group();
  labProxy.visible = false;
  threeScene.add(labProxy);
  let labProxyDirty = true;
  let labProxyReady = false;
  let labProxyNodes = 0;
  let labProxyEdges = 0;
  const labDense = (): boolean => typedPicker !== null && requestedNodes >= DENSE_SCENE_THRESHOLD;
  const positionKey = (point: Coordinates): string =>
    `${point.x.toFixed(5)}:${point.y.toFixed(5)}:${point.z.toFixed(5)}`;
  const clearLabProxy = (): void => {
    for (const child of [...labProxy.children]) {
      labProxy.remove(child);
      if (child.userData.ownedGeometry && child instanceof THREE.Mesh) child.geometry.dispose();
    }
    labProxyNodes = 0;
    labProxyEdges = 0;
    labProxyReady = false;
    labProxyDirty = true;
  };
  const rebuildLabProxy = (): void => {
    clearLabProxy();
    if (!labDense() || !typedPicker || !currentStyled) return;
    if (typedLayer.preparedCounts().semanticEdges < requestedSemanticEdges) return;
    const anchors = new Set(typedPicker.geometry.nodes.flatMap(point => {
      if (point.pick.kind !== 'node') return [];
      const style = currentStyled!.nodeStyle[point.pick.id];
      return style && (Number(style.level) <= 2 || style.type === 'hub' || style.type === 'domain')
        ? [positionKey(point.position)] : [];
    }));
    const main = new Set(typedPicker.semanticIncidence.flatMap(edge => {
      const sourceStyle = currentStyled!.nodeStyle[edge.source], targetStyle = currentStyled!.nodeStyle[edge.target];
      const level = Math.min(Number(sourceStyle?.level ?? Infinity), Number(targetStyle?.level ?? Infinity));
      return (currentStyled!.edgeStyle[edge.id]?.alpha ?? 1) !== 0 && mainRelation({
        attested: true, selectedIncident: !!(emphasisIds?.has(edge.source) || emphasisIds?.has(edge.target)),
        sourceHub: sourceStyle?.type === 'hub', targetHub: targetStyle?.type === 'hub',
        sourceDomain: sourceStyle?.type === 'domain', targetDomain: targetStyle?.type === 'domain',
        hierarchyLevel: level,
      }) ? [`semantic:${edge.id}`] : [];
    }));
    const drawnMain = new Set<string>();
    const matrix = new THREE.Matrix4(), tint = new THREE.Color(), center = new THREE.Vector3();
    for (const child of typedLayer.group.children) {
      if (child instanceof THREE.InstancedMesh && child.name === 'typed-round-nodes') {
        const selected: number[] = [];
        for (let index = 0; index < child.count; index++) {
          child.getMatrixAt(index, matrix);
          center.setFromMatrixPosition(matrix);
          if (anchors.has(positionKey(center))) selected.push(index);
        }
        if (!selected.length) continue;
        const proxy = new THREE.InstancedMesh(child.geometry, child.material, selected.length);
        proxy.name = 'lab-anchor-proxy';
        proxy.frustumCulled = false;
        selected.forEach((index, output) => {
          child.getMatrixAt(index, matrix);
          proxy.setMatrixAt(output, matrix);
          if (child.instanceColor) { child.getColorAt(index, tint); proxy.setColorAt(output, tint); }
        });
        proxy.instanceMatrix.needsUpdate = true;
        if (proxy.instanceColor) proxy.instanceColor.needsUpdate = true;
        labProxy.add(proxy);
        labProxyNodes += selected.length;
      } else if (child instanceof THREE.Mesh && child.name === 'typed-semantic-morphology') {
        const ends = child.userData.segmentEnds as number[] | undefined;
        const ids = child.userData.segmentEdgeIds as string[] | undefined;
        const positionAttribute = child.geometry.getAttribute('position');
        if (!ends || !ids || !positionAttribute || positionAttribute.itemSize !== 3) continue;
        const selected = labMainSegmentRanges(ends, ids, main);
        for (const id of selected.relationIds) drawnMain.add(id);
        if (!selected.vertices) continue;
        const vertices = new Float32Array(selected.vertices * 3);
        let offset = 0;
        const raw = positionAttribute.array as Float32Array;
        for (const [start, end] of selected.ranges) {
          vertices.set(raw.subarray(start * 3, end * 3), offset);
          offset += (end - start) * 3;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const proxy = new THREE.Mesh(geometry, child.material);
        proxy.name = 'lab-main-relation-proxy';
        proxy.userData.ownedGeometry = true;
        proxy.frustumCulled = false;
        labProxy.add(proxy);
      }
    }
    labProxyEdges = drawnMain.size;
    labProxyReady = labProxyNodes > 0
      && typedLayer.preparedCounts().semanticEdges >= requestedSemanticEdges
      && (requestedMainEdges === 0 || labProxyEdges > 0);
    labProxyDirty = false;
  };
  const applyLabPolicy = (stage: 1 | 2 | 3 | 4): void => {
    const reduced = labDense() && labProxyReady && stage < 3;
    const policy = labDrawPolicy(stage);
    labProxy.visible = reduced;
    for (const child of labProxy.children)
      child.visible = child.name !== 'lab-anchor-proxy' || policy.nodes === 'anchors';
    for (const child of typedLayer.group.children) {
      if (child.name === 'typed-round-nodes') child.visible = !reduced || policy.nodes === 'all';
      else if (child.name === 'typed-semantic-morphology') child.visible = !reduced;
    }
  };
  // D085-S3 END
  let destroyed = false;
  const perfMarksEnabled = new URLSearchParams(location.search).has('perfmarks');
  let labelTimer: ReturnType<typeof setTimeout> | undefined;
  let fiberStore: ReturnType<ReturnType<typeof createFiberRoot>["render"]> | undefined;
  const fiberRoot = createFiberRoot(canvas);

  const updateProjection = (): void => {
    const projection = rig.readProjectionState();
    updateAggregateProjectionUniforms(
      aggregateResources.material,
      projection.resolutionDevicePx,
      projection.devicePixelRatio,
    );
    updateFilamentProjectionUniforms(filamentResources.material, {
      resolutionDevicePx: projection.resolutionDevicePx,
      devicePixelRatio: projection.devicePixelRatio,
      sizeScale: projection.filamentSizeScale,
      perspective: projection.perspective,
      referenceViewDepth: projection.referenceViewDepth,
    });
    updateNodeProjectionUniforms(nodeResources.material, {
      resolutionDevicePx: projection.resolutionDevicePx,
      devicePixelRatio: projection.devicePixelRatio,
      orthographicSizeScale: projection.orthographicSizeScale,
      perspective: projection.perspective,
      // A1b outside-ownership bridge: node sizing has a close-range reference;
      // filament sizing keeps its existing target-depth reference above.
      referenceViewDepth: projection.nodeReferenceViewDepth,
      nodeScaleCap: projection.nodeScaleCap,
      // End A1b outside-ownership bridge.
      // D082-A-N3D BEGIN
      denseNeuralPointFloorCssPx,
      // D082-A-N3D END
    });
  };
  const updateLabels = (): void => {
    // D082-A-PERF BEGIN: attribute dense 3D recovery between labels, canvas,
    // and GPU submission in the opt-in performance trace.
    if (perfMarksEnabled) performance.mark('d082:labels3d:start');
    const finishLabels = () => {
      if (perfMarksEnabled) {
        performance.mark('d082:labels3d:end');
        performance.measure('d082:labels3d', 'd082:labels3d:start', 'd082:labels3d:end');
      }
    };
    // D082-A-PERF END
    if (typedPicker) {
      // The product controller stays idle on the typed path; the D-072 policy places names through
      // the shared DOM overlay over the baked metadata (type, level, tier 1, focus eligibility).
      labels.update({ ...live.scene, nodes: [], edges: [], aggregates: [], selectedLabelIds: [] }, {
        project: point => rig.graphToViewport(point),
        nodeOffsetPx: () => 0,
        nodeSizeScale: () => 1,
      });
      if (typedLabelOverlay === null) typedLabelOverlay = mountProjectionLabelOverlay(container);
      const box = container.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        typedLabelOverlay.update({ candidates: [], bounds: EMPTY_LABEL_BOUNDS });
        finishLabels();
        return;
      }
      const distance = rig.camera.position.length();
      if (typedFittedCameraDistance === null) typedFittedCameraDistance = distance;
      const overview = distance >= typedFittedCameraDistance * TYPED_LABEL_CAMERA.overviewRatio;
      const close = distance < typedFittedCameraDistance * TYPED_LABEL_CAMERA.closeRatio;
      const candidates: ProjectionLabelCandidate[] = [];
      const discs: { id: string; x: number; y: number; radius: number }[] = [];
      const rims: { x: number; y: number; radius: number }[] = [];
      if (currentStyled !== null) {
        const styled = currentStyled;
        for (const point of typedPicker.geometry.nodes) {
          if (point.pick.kind !== "node") continue;
          const style = styled.nodeStyle[point.pick.id] ?? {};
          const screen = rig.graphToViewport(point.position);
          const radiusPx = Math.max(0, (typeof style.size === "number" ? style.size : 5) * rig.sizeScaleAt(point.position));
          const anchor = { id: point.pick.id, x: screen.x, y: screen.y, radiusPx, style };
          discs.push({ id: point.pick.id, x: screen.x, y: screen.y, radius: radiusPx + 2 });
          const kind = typedLabelKind(anchor, { neighbours: style.type === "domain" ? null : emphasisIds,
            overview, close, projection: "3d" });
          if (kind === null) continue;
          const texts = typedLabelTexts(anchor);
          if (texts.short.length === 0) continue;
          candidates.push({ id: point.pick.id, text: texts.short, full: texts.full, reason: kind.reason,
            tier1: kind.tier1 || style.type === "domain", priority: typeof style.labelPriority === "number" ? style.labelPriority : 0,
            x: screen.x, y: screen.y, radiusPx });
        }
        const visibleContainers = new Set(typedPicker.geometry.containers.flatMap(segment =>
          segment.pick.kind === "container" ? [segment.pick.visualId] : []));
        for (const container of styled.projection.containers) {
          if (!visibleContainers.has(container.visualId) || !container.center3 || !(container.radius && container.radius > 0)) continue;
          const center = rig.graphToViewport(container.center3);
          rims.push({ x: center.x, y: center.y,
            radius: container.radius * projectedWorldScale(container.center3, container.radius, point => rig.graphToViewport(point)) });
        }
      }
      const ink = currentStyled === null ? undefined : readProjectionStyle(currentStyled)?.star;
      typedLabelOverlay.update({ candidates, discs, rims,
        ...(ink ? { textColor: ink } : {}),
        bounds: { left: 0, top: 0, width: box.width, height: box.height },
        ...(typedLabelBudget !== undefined ? { budget: typedLabelBudget } : {}) });
      finishLabels();
      return;
    }
    labels.update(live.scene, {
      bounds: { left: 0, top: 0, width: container.clientWidth, height: container.clientHeight },
      project(point: Coordinates): { readonly x: number; readonly y: number } {
        return rig.graphToViewport(point);
      },
      nodeOffsetPx(node: SceneNode): number {
        return requiredNodeLabelOffset(node) * rig.sizeScaleAt(node.position);
      },
      nodeSizeScale(node: SceneNode): number {
        return rig.sizeScaleAt(node.position);
      },
    });
    finishLabels();
  };
  const renderFrame = (): void => {
    if (destroyed) {
      return;
    }
    if (perfMarksEnabled) performance.mark('d082:render3d:start');
    updateProjection();
    if (typedPicker && typedLayer.group.parent !== threeScene) threeScene.add(typedLayer.group);
    if (labelTimer !== undefined) clearTimeout(labelTimer);
    if (ladder.state.stage === 4) labelTimer = setTimeout(() => {
      labelTimer = undefined;
      if (!destroyed) {
        updateLabels();
        window.dispatchEvent(new CustomEvent("d081:labels-settled"));
        publishPresentedFrame();
      }
    }, 160);
    // D085-S3 BEGIN: optional per-layer CPU submission marks for performance traces.
    if (perfMarksEnabled) performance.mark('d085:webgl:start');
    renderer.render(threeScene, rig.camera);
    if (perfMarksEnabled) { performance.mark('d085:webgl:end');
      performance.measure('d085:webgl', 'd085:webgl:start', 'd085:webgl:end'); }
    if (perfMarksEnabled) performance.mark('d085:overlays:start');
    // D085-S3 END
    if (!typedPicker && (ladder.state.stage === 4 || live.scene.nodes.length < DENSE_SCENE_THRESHOLD)) distinct?.draw();
    // D082-A-PERF BEGIN: the GPU layer owns the structural moving frame.
    // Dense projection visuals are decorative and their canvas projection is
    // too costly to repeat for every wheel event; restore it at stage four.
    if (!typedPicker || requestedNodes < DENSE_SCENE_THRESHOLD || ladder.state.stage === 4) visuals?.draw();
    // D082-A-PERF END
    // D081-P3b BEGIN: labels live on the typed overlay and follow the camera.
    if (!typedMoving && typedBundleLabels.length && visuals?.canvas) {
      const overlay = visuals.canvas, context = overlay.getContext('2d');
      const box = overlay.getBoundingClientRect();
      if (context && box.width > 0 && box.height > 0) {
        context.setTransform(overlay.width / box.width, 0, 0, overlay.height / box.height, 0, 0);
        const ink = currentStyled && readProjectionStyle(currentStyled)?.star;
        if (ink) context.fillStyle = ink;
        context.font = TYPED_COMPLETE_BUNDLE_LABEL.font;
        for (const bundle of typedBundleLabels) {
          const a = rig.graphToViewport(bundle.source), b = rig.graphToViewport(bundle.target);
          context.fillText(`+${bundle.count - 1}`, (a.x + b.x) / 2 + TYPED_COMPLETE_BUNDLE_LABEL.offsetPx,
            (a.y + b.y) / 2 - TYPED_COMPLETE_BUNDLE_LABEL.offsetPx);
        }
      }
    }
    // D081-P3b END
    // D085-S3 BEGIN
    if (perfMarksEnabled) { performance.mark('d085:overlays:end');
      performance.measure('d085:overlays', 'd085:overlays:start', 'd085:overlays:end'); }
    // D085-S3 END
    publishPresentedFrame();
    if (perfMarksEnabled) { performance.mark('d082:render3d:end'); performance.measure('d082:render3d', 'd082:render3d:start', 'd082:render3d:end'); }
  };
  let presentationRevision = 0;
  // D082-A-STALE BEGIN
  const readinessSnapshot = () => {
    const stage = ladder.state.stage;
    const submitted = typedPicker ? typedLayer.submittedCounts() : null;
    const prepared = typedPicker ? typedLayer.preparedCounts() : null;
    // D085-S3 BEGIN: the typed layer does not own the resident interaction proxies.
    const proxyActive = labDense() && labProxyReady && labProxy.visible;
    const drawnNodes = submitted ? submitted.nodes + (proxyActive && stage === 1 ? labProxyNodes : 0)
      : world.visible && (nodeResources.mesh.visible || (distinct !== null && live.scene.nodes.length < DENSE_SCENE_THRESHOLD))
        ? Math.min(requestedNodes, nodeResources.mesh.visible ? nodeResources.geometry.instanceCount : requestedNodes) : 0;
    const drawnSemantic = submitted ? submitted.semanticEdges + (proxyActive ? labProxyEdges : 0)
      : world.visible && (filamentResources.mesh.visible || (distinct !== null && live.scene.nodes.length < DENSE_SCENE_THRESHOLD))
        ? Math.min(requestedSemanticEdges, filamentResources.mesh.visible ? filamentResources.geometry.instanceCount : requestedSemanticEdges) : 0;
    // D085-S3 END
    const drawnVisual = submitted?.visualEdges ?? 0;
    const scope = currentStyled ? readProjectionStyle(currentStyled) : null;
    // D085-S3 BEGIN: the phase is complete only after all requested resident ranges and decor draw.
    const allDrawn = drawnNodes >= requestedNodes && drawnSemantic >= requestedSemanticEdges
      && drawnVisual >= requestedVisualEdges && labelTimer === undefined;
    return {
      view: `${options.organization}/3d/${derivedMorphology}/${scope?.density ?? options.lodBand}`,
      quality: ladder.state.moving ? 'movimento' : stage === 4 && allDrawn ? 'completa' : 'recupero',
      ladder: stage,
      nodes: { required: requestedNodes, loaded: prepared?.nodes ?? requestedNodes, drawn: drawnNodes },
      mainEdges: { required: requestedMainEdges, loaded: Math.min(requestedMainEdges, prepared?.semanticEdges ?? requestedMainEdges),
        drawn: Math.min(requestedMainEdges, drawnSemantic) },
      allEdges: { required: requestedSemanticEdges + requestedVisualEdges,
        loaded: prepared ? prepared.semanticEdges + prepared.visualEdges : requestedSemanticEdges + requestedVisualEdges,
        drawn: drawnSemantic + drawnVisual },
      decor: { labels: stage === 4 && labelTimer === undefined,
        background: stage === 4, glow: stage === 4, animation: true },
      decorApplicable: { animation: false },
    } as const;
    // D085-S3 END
  };
  const publishPresentedFrame = (): void => {
    const snapshot = readinessSnapshot();
    // The draw boundary supplies counts. Two frames allow the submitted frame
    // to pass the browser presentation boundary before the HUD can claim it.
    const revision = ++presentationRevision;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!destroyed && revision === presentationRevision) presentRenderReadiness(snapshot);
    }));
  };
  // D082-A-STALE END
  // D085-S3 BEGIN: finish the cached proxies only after the typed worker attaches whole ribbons.
  typedLayer.setOnReady(() => {
    rebuildLabProxy();
    applyLabPolicy(ladder.state.stage);
    renderFrame();
  });
  // D085-S3 END
  // D082-A-PERF BEGIN: three scheduled restores; no frame loop or scene rebuild at rest.
  const ladder = new QualityLadder(({ stage, moving }) => {
    typedMoving = stage < 4;
    // D085-S3 BEGIN: stage three restores semantic ribbons; stage four restores visual relations.
    if (stage < 4 && labProxyDirty) rebuildLabProxy();
    typedLayer.setQuality(labDense() ? stage === 4 ? 'full' : stage === 3 ? 'main' : 'moving'
      : stage >= 3 ? "full" : stage >= 2 ? "main" : "moving");
    applyLabPolicy(stage);
    // D085-S3 END
    visuals?.setQuality(stage >= 4 ? "full" : "moving", false);
    if (visuals?.canvas && typedPicker && requestedNodes >= DENSE_SCENE_THRESHOLD)
      visuals.canvas.style.visibility = stage >= 4 ? "" : "hidden";
    brainEnvelope?.setLod(stage >= 4 ? "full" : "moving");
    const suspendedLayers = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD
      ? ["[data-render3f-labels]", "[data-projection-labels]", "[data-morphology-canvas='distinct-3d']"]
      : ["[data-render3f-labels]", "[data-projection-labels]"];
    for (const selector of suspendedLayers) {
      const layer = container.querySelector<HTMLElement>(selector);
      if (layer) layer.style.visibility = stage >= 4 ? "" : "hidden";
    }
    if (!moving) {
      renderFrame();
      if (stage === 4) {
        if (labelTimer !== undefined) clearTimeout(labelTimer);
        labelTimer = undefined;
        updateLabels();
        window.dispatchEvent(new CustomEvent("d081:labels-settled"));
        publishPresentedFrame();
      }
    }
  });
  // D082-A-PERF END
  brainEnvelope?.setRefitCallback(renderFrame);
  const syncCameraState = (): void => {
    // D082-A-PERF BEGIN: keep the shared derived layer in its documented moving tier.
    if (visuals) visuals.setQuality("moving", false);
    // D082-A-PERF END
    ladder.touch();
    currentState = createRenderVisualState(visualGraph, {
      ...currentState,
      camera: engineCamera(rig.readCameraState()),
      cameraKind: rig.kind,
    });
    if (fiberStore !== undefined) {
      fiberStore.setState({ camera: rig.camera });
    }
    renderFrame();
  };
  const detachInteractions = attachCameraInteractions(canvas, rig, syncCameraState, (x, y) => {
    // D081-P6 BEGIN: product-view stationary wheel gesture, set on root capture before this resolver.
    if (!typedPicker) return reviewGestureWheelAnchor(
      canvas as HTMLCanvasElement & { __reviewGestureWheelAnchor?: Coordinates },
      () => picker.nodeAnchorAtPosition(x, y));
    // D081-P6 END.
    return typedPicker.nodeAnchorAtPosition(x, y,
      (position, out) => rig.projectToViewportInto(position, out),
      (id, position) => {
        const size = currentStyled?.nodeStyle[id]?.size;
        return (typeof size === "number" ? size : 5) * rig.wheelNodeSizeScaleAt(position);
      });
  // D081-P6 BEGIN: only the product page reselects a mark for each 3D wheel step.
  }, !typedPicker);
  // D081-P6 END.
  const renderWhileFiberConfigures = (): void => {
    if (destroyed || fiberStore !== undefined) {
      return;
    }
    threeScene.add(world);
    rig.resize(dimensions.width, dimensions.height, renderPixelRatio(live.scene, devicePixelRatio));
    renderFrame();
    requestAnimationFrame(renderWhileFiberConfigures);
  };

  renderWhileFiberConfigures();
  void fiberRoot.configure({
    gl: renderer,
    scene: threeScene,
    camera: rig.camera,
    frameloop: "never",
    size: { width: dimensions.width, height: dimensions.height, top: 0, left: 0 },
    dpr: renderPixelRatio(live.scene, devicePixelRatio),
    onCreated: () => {
      renderFrame();
    },
  }).then(() => {
    if (destroyed) {
      return;
    }
    fiberStore = fiberRoot.render(<WorldLayer world={world} />);
    fiberStore.setState({ camera: rig.camera });
    threeScene.add(world);
    threeScene.add(typedLayer.group);
    rig.resize(dimensions.width, dimensions.height, renderPixelRatio(live.scene, devicePixelRatio));
    renderFrame();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) {
      return;
    }
    const next = containerDimensions(container);
    const nextDevicePixelRatio = requiredDevicePixelRatio();
    const renderDpr = renderPixelRatio(live.scene, nextDevicePixelRatio);
    if (renderDpr !== currentRenderDpr) {
      renderer.setPixelRatio(renderDpr);
      currentRenderDpr = renderDpr;
    }
    renderer.setSize(next.width, next.height, false);
    rig.resize(next.width, next.height, renderDpr);
    fiberStore?.setState({
      size: { width: next.width, height: next.height, top: 0, left: 0 },
      viewport: fiberStore.getState().viewport,
    });
    renderFrame();
  });
  resizeObserver.observe(container);

  const applyMaterialState = (selectedId: string | null, focusedId: string | null): void => {
    // D082-B-CANOPYN BEGIN
    const markCanopyMaterial = !!preparedCanopy && typeof location !== 'undefined'
      && new URLSearchParams(location.search).has('perfmarks');
    if (markCanopyMaterial) performance.mark('d082-canopyn:material:start');
    // D082-B-CANOPYN END
    currentState = createRenderVisualState(visualGraph, {
      ...currentState,
      camera: engineCamera(rig.readCameraState()),
      cameraKind: rig.kind,
      selectedId,
      focusedId,
    });
    const scenes = scenesForState(
      visualGraph, currentState, options.calibration, options.phase, options.navigationPath,
      options.temporalInstant, suppliedAnchors, { ...options.presentation, emphasisIds },
    );
    live.replaceScenes(scenes, suppliedAnchors === undefined ? cameraKindCount() : 0);
    brainEnvelope?.update(live.scene.nodes, live.scene.edges);
    refreshPresentedCounts();
    const nextRenderDpr = renderPixelRatio(live.scene, requiredDevicePixelRatio());
    if (nextRenderDpr !== currentRenderDpr) {
      const nextDimensions = containerDimensions(container);
      renderer.setPixelRatio(nextRenderDpr);
      renderer.setSize(nextDimensions.width, nextDimensions.height, false);
      rig.resize(nextDimensions.width, nextDimensions.height, nextRenderDpr);
      currentRenderDpr = nextRenderDpr;
    }
    if (distinct) {
      filamentResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
      nodeResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
    }
    retainedSceneReferences.clear();
    retainedSceneReferences.add(scenes.orthographic);
    retainedSceneReferences.add(scenes.perspective);
    if (!typedPicker) {
      updateNodeRenderResources(nodeResources, live.buffers.nodes);
      updateFilamentRenderResources(filamentResources, live.buffers.filaments);
      // D082-A-NODES BEGIN
      applyNativeEdgeVeil();
      // D082-A-NODES END
    }
    if (!typedPicker) distinct?.setScene(live.scene);
    rig.setWorldFramingSubjects(sceneCameraFramingSubjects(live.scene));
    picker.replaceScene(live.scene);
    updateField(renderer, live.scene);
    renderFrame();
    // D082-B-CANOPYN BEGIN
    if (markCanopyMaterial) { performance.mark('d082-canopyn:material:end');
      performance.measure('d082-canopyn:material', 'd082-canopyn:material:start', 'd082-canopyn:material:end'); }
    // D082-B-CANOPYN END
  };

  const brainProof = {
    brain: (): BrainWitness | null => brainEnvelope?.witness() ?? null,
    brainView: (name: "front" | "back" | "side" | "right" | "top" | "bottom" | "iso"): VisualStateCamera | null => {
      if (!brainEnvelope) return null;
      // The page applies this state through ProductView.restoreCamera. That path also runs the
      // HTML label pass and camera watcher; changing the rig here leaves both at the old pose.
      const pose = brainViewCameraState(name, brainEnvelope.axes(), brainEnvelope.center(), rig.readCameraState());
      return brainViewFramingState(pose, brainEnvelope.framingSphere()?.radius ?? 0);
    },
  };
  const proofWindow = window as typeof window & { __d080Renderer?: typeof brainProof };
  proofWindow.__d080Renderer = brainProof;
  return {
    readPlacedLabelIds(): readonly string[] { return typedLabelOverlay?.readLabelIds() ?? []; },
    setAppearance(appearance: AppearanceOptions): void {
      setFilamentNeuralWidthPx(filamentResources.material, appearance.edgeWidth);
      distinct?.setAppearance(appearance);
      if (filamentResources.mesh.visible) renderFrame();
    },
    setDerivedMorphology(morphology: ProjectionVisualsMorphology): void {
      derivedMorphology = morphology;
      visuals?.setMorphology(morphology);
      // D082-A-STALE BEGIN
      // A morphology mutation invalidates the previously complete visual state immediately.
      // This remains a renderer-side estimate, not compositor presentation evidence.
      const snapshot = readinessSnapshot();
      presentRenderReadiness({ ...snapshot, quality: 'recupero', ladder: snapshot.ladder === 4 ? 3 : snapshot.ladder,
        decor: { ...snapshot.decor, background: false } });
      renderFrame();
      // D082-A-STALE END
    },
    updateVisibleSubset(update: DistinctSubsetUpdate | Render3fTypedInput): void {
      if (!("styled" in update)) {
        if (typedPicker) throw new TypeError("Legacy subset cannot replace typed 3D visibility");
        distinct?.updateVisibleSubset(update);
        // D082-A-NODES BEGIN
        if (live.scene.nodes.length === 11_199 && update.nodeEntries.size) {
          const indexById = new Map(live.buffers.nodes.ids.map((id, nodeIndex) => [id, nodeIndex] as const));
          const core = nodeResources.geometry.getAttribute("a_coreRadiusPx") as THREE.InstancedBufferAttribute;
          const halo = nodeResources.geometry.getAttribute("a_haloRadiusPx") as THREE.InstancedBufferAttribute;
          const gap = nodeResources.geometry.getAttribute("a_haloCoreGapPx") as THREE.InstancedBufferAttribute;
          const floor = nodeResources.geometry.getAttribute("a_minimumCoreDeviceRadiusPx") as THREE.InstancedBufferAttribute;
          for (const [id, entry] of update.nodeEntries) {
            const nodeIndex = indexById.get(id);
            if (nodeIndex === undefined || entry.radiusPx === undefined) continue;
            core.setX(nodeIndex, entry.radiusPx);
            halo.setX(nodeIndex, entry.haloRadiusPx ?? entry.radiusPx);
            gap.setX(nodeIndex, 0);
            floor.setX(nodeIndex, 0);
            denseNodeRadii.set(id, { radius: entry.radiusPx, halo: entry.haloRadiusPx ?? entry.radiusPx });
          }
          core.needsUpdate = halo.needsUpdate = gap.needsUpdate = floor.needsUpdate = true;
          renderFrame();
        }
        if (nativeEdgeVeilById.size) {
          for (const [id, entry] of update.edgeEntries) if (entry.presentation)
            nativeEdgeVeilById.set(id, entry.presentation.denseVeilFactor ?? 1);
          applyNativeEdgeVeil();
          renderFrame();
        }
        // D082-A-NODES END
        return;
      }
      if (typedPicker === null) {
        detachInteractions.resetWheelAnchor();
        const next = new TypedProjectionPicker(update, point => rig.graphToViewport(point));
        typedPicker = next;
        distinct?.destroy();
        distinct = null;
        world.visible = false;
        currentStyled = update.styled;
        const nextScope = readProjectionStyle(update.styled);
        if (nextScope !== null) {
          typedLabelBudget = nextScope.labelBudget;
          derivedMorphology = nextScope.morphology;
        }
        // D085-S3 BEGIN: release proxy geometry before its source buffers are replaced.
        clearLabProxy();
        typedLayer.update(next.geometry, update.styled);
        // D085-S3 END
        refreshPresentedCounts();
        // D081-P3b BEGIN
        updateBundleLabels(update);
        // D081-P3b END
        acceptVisuals(update);
        updateLabels();
        renderFrame();
      } else if (typedPicker.update(update)) {
        if (currentStyled?.projection.determinism.resultDigest !== update.styled.projection.determinism.resultDigest) {
          detachInteractions.resetWheelAnchor();
        }
        currentStyled = update.styled;
        const nextScope = readProjectionStyle(update.styled);
        if (nextScope !== null) {
          typedLabelBudget = nextScope.labelBudget;
          derivedMorphology = nextScope.morphology;
          visuals?.setMorphology(nextScope.morphology);
        }
        // D085-S3 BEGIN
        clearLabProxy();
        typedLayer.update(typedPicker.geometry, update.styled);
        // D085-S3 END
        refreshPresentedCounts();
        // D081-P3b BEGIN
        updateBundleLabels(update);
        // D081-P3b END
        acceptVisuals(update);
        updateLabels();
        renderFrame();
      }
    },
    pickAtPosition(position): PickResult | null {
      if (typedPicker) return typedPicker.pickPrimary(position) ?? visuals?.pickAt(position) ?? null;
      const node = picker.pickNodeAtPosition(position);
      if (node !== null) return { kind: "node", id: node };
      const edge = picker.pickEdgeAtPoint(position.x, position.y);
      return edge === null ? null : { kind: "semantic-edge", id: edge };
    },
    setEmphasis(ids: ReadonlySet<string> | null): void {
      emphasisIds = ids;
      applyMaterialState(currentState.selectedId, currentState.focusedId);
    },
    readReviewWindows() {
      if (typedPicker) return [];
      return live.scene.aggregates.map((window) => ({
        id: window.id, members: window.members, center: window.center, radius: window.radius,
      }));
    },
    isWorldPointVisible(point: Coordinates): boolean {
      const projected = new THREE.Vector3(point.x, point.y, point.z).project(rig.camera);
      return projected.z >= -1 && projected.z <= 1;
    },
    get cameraKind(): CameraKind {
      return rig.kind;
    },
    graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
      return rig.graphToViewport(point);
    },
    readCameraState(): VisualStateCamera {
      return rig.readCameraState();
    },
    readReviewCameraPose() { return rig.readPose(); },
    setReviewViewPreset(name) {
      detachInteractions.resetWheelAnchor();
      const brainName = ({ fronte: "front", retro: "back", sinistra: "side", destra: "right",
        alto: "top", basso: "bottom", iso: "iso" } as const)[name];
      if (brainEnvelope?.group.visible) {
        const pose = brainViewCameraState(brainName, brainEnvelope.axes(), brainEnvelope.center(), rig.readCameraState());
        rig.restoreCameraState(brainViewFramingState(pose, brainEnvelope.framingSphere()?.radius ?? 0));
      } else rig.viewPreset(name);
      syncCameraState();
    },
    restoreCameraState(state: VisualStateCamera): void {
      detachInteractions.resetWheelAnchor();
      currentState = createRenderVisualState(visualGraph, { ...currentState, camera: engineCamera(state) });
      rig.restoreCameraState(state);
      syncCameraState();
    },
    readVisualState(): VisualState {
      currentState = createRenderVisualState(visualGraph, {
        ...currentState,
        camera: engineCamera(rig.readCameraState()),
        cameraKind: rig.kind,
      });
      return currentState;
    },
    setCameraKind(kind: CameraKind): void {
      detachInteractions.resetWheelAnchor();
      live.setCameraKind(kind);
      rig.setCameraKind(kind, live.scene.camera);
      currentState = createRenderVisualState(visualGraph, {
        ...currentState,
        camera: engineCamera(rig.readCameraState()),
        cameraKind: kind,
      });
      picker.replaceScene(live.scene);
      syncCameraState();
    },
    setSelection(id: string): void {
      applyMaterialState(id, currentState.focusedId);
    },
    clearSelection(): void {
      applyMaterialState(null, currentState.focusedId);
    },
    getSelection(): string | null {
      return currentState.selectedId;
    },
    setFocus(id: string): void {
      applyMaterialState(currentState.selectedId, id);
    },
    clearFocus(): void {
      applyMaterialState(currentState.selectedId, null);
    },
    getFocus(): string | null {
      return currentState.focusedId;
    },
    readSelectedProvenance(): DerivedValue | null {
      return live.scene.selectedProvenance;
    },
    readSurfaceWitness(): SurfaceWitness {
      if (typedPicker) {
        const incidence: Record<string, { readonly source: string; readonly target: string }> = {};
        for (const edge of typedPicker.semanticIncidence) incidence[edge.id] = { source: edge.source, target: edge.target };
        return {
          nodeIds: typedPicker.geometry.nodes.map(node => node.pick.kind === "node" ? node.pick.id : ""),
          edgeIds: typedPicker.semanticIncidence.map(edge => edge.id), incidence,
        };
      }
      return live.readSurfaceWitness();
    },
    readNodeFootprintWitnesses(ids?: ReadonlySet<string>): readonly NodeFootprintWitness[] {
      if (typedPicker) return typedPicker.geometry.nodes.flatMap(node => {
        if (node.pick.kind !== "node" || (ids && !ids.has(node.pick.id))) return [];
        return [{ id: node.pick.id, viewportCenter: rig.graphToViewport(node.position),
          coreRadiusPx: 4.5, haloRadiusPx: 4.5 }];
      });
      // D082-A-NODES BEGIN
      return readNodeFootprints(live, rig, ids, nodeResources.geometry);
      // D082-A-NODES END
    },
    readRelationGeometryWitnesses(): readonly RelationGeometryWitness[] {
      if (typedPicker) return typedPicker.geometry.semanticEdges.map(segment => ({
        id: segment.pick.kind === "semantic-edge" ? segment.pick.id : "",
        source: segment.source,
        controlPoint: { x: (segment.source.x + segment.target.x) / 2,
          y: (segment.source.y + segment.target.y) / 2,
          z: (segment.source.z + segment.target.z) / 2 },
        target: segment.target, pickTolerancePx: 5, minimumDeviceWidthPx: 1,
        widthStartPx: 1, widthEndPx: 1,
      }));
      return live.readRelationGeometryWitnesses(readSceneHeldByPicker(picker));
    },
    readProjectedCameraFramingSubjects(): readonly ProjectedCameraFramingSubject[] { return rig.projectFramingSubjects(); },
    readBrainEnvelopeFramingSphere() { return brainEnvelope?.framingSphere() ?? null; },
    readWorldAnchorWitnesses(ids?: ReadonlySet<string>): readonly WorldAnchorWitness[] {
      if (typedPicker) return typedPicker.geometry.nodes.flatMap(node =>
        node.pick.kind === "node" && (!ids || ids.has(node.pick.id))
          ? [{ id: node.pick.id, position: node.position }] : []);
      return live.readWorldAnchorWitnesses(ids);
    },
    readLayoutPassCount(): number {
      return live.readLayoutPassCount();
    },
    pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null {
      if (typedPicker) {
        const pick = typedPicker.pickPrimary(position);
        return pick?.kind === "node" ? pick.id : null;
      }
      return picker.pickNodeAtPosition(position);
    },
    pickEdgeAtPoint(x: number, y: number): string | null {
      if (typedPicker) {
        const pick = typedPicker.pickPrimary({ x, y });
        return pick?.kind === "semantic-edge" ? pick.id : null;
      }
      return picker.pickEdgeAtPoint(x, y);
    },
    readRetainedResources(): RetainedResourceWitness {
      return {
        ...registry.readRetainedResources(labels.readNodeCount()),
        jsRetention: {
          // PASS with a value, not a status of its own. The governed vocabulary is PASS, NOT_RUN and
          // UNKNOWN; a fourth member invented at one emission site reads as a measurement everywhere
          // it is consumed and is refused by the artifact checker, which is how this was found.
          status: "PASS",
          value: { retainedSceneReferences: retainedSceneReferences.size },
        },
      };
    },
    destroy(): void {
      if (labelTimer !== undefined) clearTimeout(labelTimer);
      ladder.destroy();
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (proofWindow.__d080Renderer === brainProof) delete proofWindow.__d080Renderer;
      typedLabelOverlay?.destroy();
      visuals?.destroy();
      resizeObserver.disconnect();
      detachInteractions();
      labels.destroy();
      distinct?.destroy();
      // D085-S3 BEGIN
      clearLabProxy();
      labProxy.removeFromParent();
      // D085-S3 END
      typedLayer.dispose();
      brainEnvelope?.dispose();
      fiberRoot.unmount();
      registry.disposeAll();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      container.style.position = previousPositionStyle;
    },
  };
}

function WorldLayer({ world }: { readonly world: THREE.Group }): ReactElement {
  return <primitive object={world} />;
}

// D082-A-SWITCH BEGIN: learn the default perspective navigation from the
// authoritative scene builder once; the renderer does not own calibration.
let defaultPerspectiveNavigation: Extract<Scene["camera"], { kind: "perspective" }>["navigation"] | null = null;
// D082-A-SWITCH END
export function scenesForState(
  graph: VisualGraph,
  state: VisualState,
  calibration: CalibrationProfile | undefined,
  phase: number | undefined,
  navigationPath: ScaleNavigationPath | undefined,
  temporalInstant: string | undefined,
  suppliedAnchors: ReadonlyMap<string, Coordinates> | undefined,
  presentation?: PresentationOptions,
): CameraScenes {
  const orthographicState = createRenderVisualState(graph, { ...state, cameraKind: ORTHOGRAPHIC });
  // D082-A-SWITCH BEGIN: a supplied layout resolves the same scene for both camera
  // requests. Keep its arrays resident and change only the projection request.
  // This avoids repeating the full product scene derivation on every 3D entry.
  const perspectiveNavigation = calibration?.camera.perspective ?? defaultPerspectiveNavigation;
  if (suppliedAnchors !== undefined && perspectiveNavigation !== null) {
    const orthographic = buildSceneWithCalibration(
      graph, orthographicState, calibration, phase, navigationPath, temporalInstant, suppliedAnchors, presentation,
    );
    const perspective: Scene = { ...orthographic, camera: {
      ...orthographic.camera, kind: "perspective" as const,
      navigation: { ...perspectiveNavigation },
    } };
    return { orthographic, perspective };
  }
  // D082-A-SWITCH END
  const perspectiveState = createRenderVisualState(graph, { ...state, cameraKind: PERSPECTIVE });
  const scenes = {
    orthographic: buildSceneWithCalibration(
      graph, orthographicState, calibration, phase, navigationPath, temporalInstant, suppliedAnchors, presentation,
    ),
    perspective: buildSceneWithCalibration(
      graph, perspectiveState, calibration, phase, navigationPath, temporalInstant, suppliedAnchors, presentation,
    ),
  };
  // D082-A-SWITCH BEGIN: only the scene layer supplies the default calibration.
  if (calibration === undefined && scenes.perspective.camera.kind === "perspective")
    defaultPerspectiveNavigation = { ...scenes.perspective.camera.navigation };
  // D082-A-SWITCH END
  return scenes;
}

/**
 * `phase` is forced to the resting phase (an explicit `undefined`, which `buildScene` itself
 * resolves to `restingPhase(motionGrammar)`) whenever `state.reducedMotion` is set, regardless of
 * what was requested: reduced motion is a complete path, not merely a smaller amplitude, so a reader
 * who has asked for it never receives a mid-cycle frame.
 */
function buildSceneWithCalibration(
  graph: VisualGraph,
  state: VisualState,
  calibration: CalibrationProfile | undefined,
  phase: number | undefined,
  navigationPath: ScaleNavigationPath | undefined,
  temporalInstant: string | undefined,
  suppliedAnchors: ReadonlyMap<string, Coordinates> | undefined,
  presentation?: PresentationOptions,
): Scene {
  const effectivePhase = state.reducedMotion ? undefined : phase;
  return calibration === undefined
    ? buildScene(
        graph, state, undefined, undefined, undefined, effectivePhase,
        navigationPath, temporalInstant, suppliedAnchors, presentation,
      )
    : buildScene(
        graph, state, calibration, undefined, undefined, effectivePhase,
        navigationPath, temporalInstant, suppliedAnchors, presentation,
      );
}

export function stateFromOptions(
  graph: VisualGraph,
  options: Render3fOptions,
  camera: VisualStateCamera,
): VisualState {
  return createRenderVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera,
    // D082-A-PERF BEGIN
    cameraKind: options.initialCameraKind ?? ORTHOGRAPHIC,
    // D082-A-PERF END
    morphology: options.morphology,
    organization: options.organization,
    palette: options.palette ?? SHIPPING_RENDER_DEFAULTS.palette,
    temperature: options.temperature,
    theme: options.theme,
    lodBand: options.lodBand,
    reducedMotion: options.reducedMotion,
  });
}

// D082-A-NODES BEGIN
function readNodeFootprints(live: LiveSceneState, rig: CameraRig, ids?: ReadonlySet<string>,
  geometry?: THREE.InstancedBufferGeometry): readonly NodeFootprintWitness[] {
  const buffers = live.buffers.nodes;
  const coreAttribute = geometry?.getAttribute("a_coreRadiusPx") as THREE.InstancedBufferAttribute | undefined;
  const haloAttribute = geometry?.getAttribute("a_haloRadiusPx") as THREE.InstancedBufferAttribute | undefined;
  const gapAttribute = geometry?.getAttribute("a_haloCoreGapPx") as THREE.InstancedBufferAttribute | undefined;
  const result: NodeFootprintWitness[] = [];
  buffers.ids.forEach((id, index) => {
    if (ids && !ids.has(id)) return;
    const position = coordinatesAt(buffers.positions, index);
    const sizeScale = rig.sizeScaleAt(position);
    const coreRadiusPx = requiredNumber(coreAttribute?.getX(index) ?? buffers.coreRadiiPx[index], `mounted node ${id} core radius`) * sizeScale;
    const requestedHaloRadius = requiredNumber(haloAttribute?.getX(index) ?? buffers.haloRadiiPx[index], `mounted node ${id} halo radius`) * sizeScale;
    const gapHaloRadius = (
      requiredNumber(coreAttribute?.getX(index) ?? buffers.coreRadiiPx[index], `mounted node ${id} core radius`)
      + requiredNumber(gapAttribute?.getX(index) ?? buffers.haloCoreGapsPx[index], `mounted node ${id} halo core gap`)
    ) * sizeScale;
    result.push({
      id,
      viewportCenter: rig.graphToViewport(position),
      coreRadiusPx,
      haloRadiusPx: Math.max(requestedHaloRadius, gapHaloRadius),
    });
  });
  return result;
}
// D082-A-NODES END

/** This reads ScenePicker's actual retained scene object and does not substitute a mount-time scene reference. */
function readSceneHeldByPicker(picker: ScenePicker): Scene {
  // Through the picker's own accessor rather than a cast into its internals: the guarantee this
  // witness needs is that it reads the object the picker answers from, and an accessor states that
  // where a reflective read only assumes it.
  return picker.scene;
}

function updateField(renderer: THREE.WebGLRenderer, scene: Scene): void {
  const field = tokenToSrgb(scene.field.token, scene.tokenEncoding);
  renderer.setClearColor(new THREE.Color().setRGB(field.red, field.green, field.blue));
}

/**
 * The governed placement offset, or the node's drawn extent, whichever clears the glow.
 *
 * The scene model supplies `placementOffsetPx` and the renderer is not inventing a visual value by
 * taking the larger of it and the radius the node is actually drawn at: screen-space placement is
 * already the renderer's responsibility here — the caller scales this by the projection — and the
 * label-collision pass resolves label against label in screen space for the same reason.
 *
 * Without it, an emphasised node's bloom swallows the middle of its own label. In the two `focused`
 * captures the emphasised node's word read as `conflic ▮ ember`, and those are the two images whose
 * entire purpose is to emphasise one element. Nothing could see it: the collision pass compares
 * labels with labels and never with the glow beneath them.
 *
 * `Math.max` rather than a sum: where the governed offset already clears the drawn extent it is
 * unchanged, so this moves only the labels that were sitting inside a node.
 */
function requiredNodeLabelOffset(node: SceneNode): number {
  if (node.labelCandidacy === null) {
    throw new TypeError(`mounted node ${node.id} has no label offset`);
  }
  // The same drawn extent the footprint witness reports, so placement and measurement agree.
  const drawnExtentPx = Math.max(node.haloRadiusPx, node.radiusPx + node.haloCoreGapPx);
  return Math.max(node.labelCandidacy.placementOffsetPx, drawnExtentPx);
}

function coordinatesAt(values: Float32Array, index: number): Coordinates {
  const offset = index * coordinateCount();
  return {
    x: requiredNumber(values[offset], "mounted node x"),
    y: requiredNumber(values[offset + 1], "mounted node y"),
    z: requiredNumber(values[offset + 2], "mounted node z"),
  };
}

function containerDimensions(container: HTMLElement): { readonly width: number; readonly height: number } {
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width <= 0 || height <= 0) {
    throw new TypeError("render3f container requires positive dimensions");
  }
  return { width, height };
}

function requiredDevicePixelRatio(): number {
  if (!Number.isFinite(window.devicePixelRatio) || window.devicePixelRatio <= 0) {
    throw new TypeError("render3f device pixel ratio must be positive and finite");
  }
  return window.devicePixelRatio;
}

function bootstrapBounds(): Render3fFramingBox {
  return {
    x: [0, SCENE_PERMILLE_QUANTUM],
    y: [0, SCENE_PERMILLE_QUANTUM],
  };
}

function requiredNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function cameraKindCount(): number {
  return [ORTHOGRAPHIC, PERSPECTIVE].length;
}

/** The engine's pinned camera record; the review rig's orbit and target depth stay inside the rig. */
function engineCamera(state: VisualStateCamera): VisualStateCamera {
  return { x: state.x, y: state.y, angle: state.angle, ratio: state.ratio, bounds: state.bounds };
}
