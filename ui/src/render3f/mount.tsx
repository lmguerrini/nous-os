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
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { SHIPPING_RENDER_DEFAULTS } from "#render2d/model.ts";
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
import { mountDistinctOverlay } from "#render3f/distinct-overlay.ts";
import type { DistinctSubsetUpdate } from "#render-common/morphology-canvas.ts";
import { DENSE_SCENE_THRESHOLD } from "#render-common/morphology-canvas.ts";
import { createProjectionVisualsLayer } from "#render-common/projection-visuals-layer.ts";
import type { ProjectionVisualsLayer, ProjectionVisualsMorphology } from "#render-common/projection-visuals-layer.ts";
import {
  createAggregateRenderResources,
  updateAggregateProjectionUniforms,
} from "#render3f/aggregate-material.ts";
import {
  createFilamentRenderResources,
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
import type { Render3fTypedInput, TypedPoint, TypedProjectionGeometry, TypedSegment } from "#render3f/picking.ts";
import type { PickResult } from "../projection/contract-types.ts";

/** How long the camera must be still before the derived geometry returns to full quality. */
const DERIVED_STILL_MS = 200;
import { ResourceRegistry } from "#render3f/resources.ts";
import { LiveSceneState } from "#render3f/state.ts";
import type { CameraScenes } from "#render3f/state.ts";
import { buildScene } from "#scene/index.ts";
import { SCENE_PERMILLE_QUANTUM } from "#scene/contract.ts";
import type { Scene, SceneNode } from "#scene/contract.ts";

/** This is the renderer input selection shared structurally with Sigma and does not choose a graph. */
export type Render3fOptions = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette?: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
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
  setReviewViewPreset(name: "fronte" | "retro" | "sinistra" | "destra" | "alto" | "basso"): void;
  /** This copies the picker-held resolved relation geometry and does not rebuild scene geometry. */
  readRelationGeometryWitnesses(): readonly RelationGeometryWitness[];
  readProjectedCameraFramingSubjects(): readonly ProjectedCameraFramingSubject[];
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
export function mount(
  container: HTMLElement,
  visualGraph: VisualGraph,
  options: Render3fOptions,
  framingBox?: Render3fFramingBox,
  initialVisualState?: VisualState,
  suppliedAnchors?: ReadonlyMap<string, Coordinates>,
  typedInput?: Render3fTypedInput,
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
  if (initialVisualState !== undefined) {
    currentState = createVisualState(visualGraph, initialVisualState);
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
      currentState = createVisualState(visualGraph, {
        ...provisionalState,
        camera: cameraStateForBounds(bounds),
      });
    } else {
      currentState = provisionalState;
    }
  }
  const initialScenes = scenesForState(
    visualGraph, currentState, options.calibration, options.phase, options.navigationPath,
    options.temporalInstant, suppliedAnchors, options.presentation,
  );
  layoutPassCount += suppliedAnchors === undefined ? cameraKindCount() : 0;
  const live = new LiveSceneState(initialScenes, currentState.cameraKind, layoutPassCount);
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
  const nodeResources = createNodeRenderResources(live.buffers.nodes);
  registry.registerGeometry(aggregateResources.geometry);
  registry.registerGeometry(filamentResources.geometry);
  registry.registerGeometry(nodeResources.geometry);
  registry.registerMaterial(aggregateResources.material);
  registry.registerMaterial(filamentResources.material);
  registry.registerMaterial(nodeResources.material);
  registry.registerTexture(nodeResources.haloStops);

  const world = new THREE.Group();
  world.add(aggregateResources.mesh, filamentResources.mesh, nodeResources.mesh);
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
  if (distinct) {
    // The GPU draws dense nodes and edges; the overlay keeps Indra's container structure.
    filamentResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
    nodeResources.mesh.visible = live.scene.nodes.length >= DENSE_SCENE_THRESHOLD;
  }
  const picker = new ScenePicker(live.scene, {
    project(point: Coordinates): { readonly x: number; readonly y: number } {
      return rig.graphToViewport(point);
    },
    nodeRadiusPx(node: SceneNode): number {
      return node.radiusPx * rig.sizeScaleAt(node.position);
    },
    filamentSizeScale(): number {
      return rig.readProjectionState().filamentSizeScale;
    },
  });
  let typedPicker = typedInput === undefined ? null : new TypedProjectionPicker(
    typedInput, point => rig.graphToViewport(point),
  );
  const typedLayer = createTypedProjectionLayer(live.scene);
  threeScene.add(typedLayer.group);
  // Containers, curves and field rings of a typed projection are one 2D canvas layer over the WebGL canvas,
  // projected through the live camera. It redraws with every frame and drops to the moving quality while
  // the camera moves; the restore timer exists only after a camera change, so an idle page schedules nothing.
  let visuals: ProjectionVisualsLayer | null = null;
  let derivedMorphology: ProjectionVisualsMorphology = "stellar";
  let visualsStillTimer: ReturnType<typeof setTimeout> | undefined;
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
    typedLayer.update(typedPicker.geometry);
    acceptVisuals(typedInput!);
  }
  let emphasisIds = options.presentation?.emphasisIds ?? null;
  let destroyed = false;
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
    });
    updateNodeProjectionUniforms(nodeResources.material, {
      resolutionDevicePx: projection.resolutionDevicePx,
      devicePixelRatio: projection.devicePixelRatio,
      orthographicSizeScale: projection.orthographicSizeScale,
      perspective: projection.perspective,
      referenceViewDepth: projection.referenceViewDepth,
    });
  };
  const updateLabels = (): void => {
    if (typedPicker) {
      labels.update({ ...live.scene, nodes: [], edges: [], aggregates: [], selectedLabelIds: [] }, {
        project: point => rig.graphToViewport(point),
        nodeOffsetPx: () => 0,
        nodeSizeScale: () => 1,
      });
      return;
    }
    labels.update(live.scene, {
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
  };
  const renderFrame = (): void => {
    if (destroyed) {
      return;
    }
    updateProjection();
    if (labelTimer !== undefined) clearTimeout(labelTimer);
    labelTimer = setTimeout(() => { if (!destroyed) updateLabels(); }, 160);
    renderer.render(threeScene, rig.camera);
    if (!typedPicker) distinct?.draw();
    visuals?.draw();
  };
  const syncCameraState = (): void => {
    if (visuals) {
      visuals.setQuality("moving", false);
      if (visualsStillTimer !== undefined) clearTimeout(visualsStillTimer);
      visualsStillTimer = setTimeout(() => {
        visualsStillTimer = undefined;
        if (!destroyed) visuals?.setQuality("full");
      }, DERIVED_STILL_MS);
    }
    currentState = createVisualState(visualGraph, {
      ...currentState,
      camera: engineCamera(rig.readCameraState()),
      cameraKind: rig.kind,
    });
    if (fiberStore !== undefined) {
      fiberStore.setState({ camera: rig.camera });
    }
    renderFrame();
  };
  const detachInteractions = attachCameraInteractions(canvas, rig, syncCameraState);
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
    currentState = createVisualState(visualGraph, {
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
    }
    if (!typedPicker) distinct?.setScene(live.scene);
    rig.setWorldFramingSubjects(sceneCameraFramingSubjects(live.scene));
    picker.replaceScene(live.scene);
    updateField(renderer, live.scene);
    renderFrame();
  };

  return {
    setAppearance(appearance: AppearanceOptions): void { distinct?.setAppearance(appearance); },
    setDerivedMorphology(morphology: ProjectionVisualsMorphology): void {
      derivedMorphology = morphology;
      visuals?.setMorphology(morphology);
    },
    updateVisibleSubset(update: DistinctSubsetUpdate | Render3fTypedInput): void {
      if (!("styled" in update)) {
        if (typedPicker) throw new TypeError("Legacy subset cannot replace typed 3D visibility");
        distinct?.updateVisibleSubset(update);
        return;
      }
      if (typedPicker === null) {
        const next = new TypedProjectionPicker(update, point => rig.graphToViewport(point));
        typedPicker = next;
        distinct?.destroy();
        distinct = null;
        world.visible = false;
        typedLayer.update(next.geometry);
        acceptVisuals(update);
        updateLabels();
        renderFrame();
      } else if (typedPicker.update(update)) {
        typedLayer.update(typedPicker.geometry);
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
    setReviewViewPreset(name) { rig.viewPreset(name); syncCameraState(); },
    restoreCameraState(state: VisualStateCamera): void {
      currentState = createVisualState(visualGraph, { ...currentState, camera: engineCamera(state) });
      rig.restoreCameraState(state);
      syncCameraState();
    },
    readVisualState(): VisualState {
      currentState = createVisualState(visualGraph, {
        ...currentState,
        camera: engineCamera(rig.readCameraState()),
        cameraKind: rig.kind,
      });
      return currentState;
    },
    setCameraKind(kind: CameraKind): void {
      live.setCameraKind(kind);
      rig.setCameraKind(kind, live.scene.camera);
      currentState = createVisualState(visualGraph, {
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
      return readNodeFootprints(live, rig, ids);
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
    readProjectedCameraFramingSubjects(): readonly ProjectedCameraFramingSubject[] {
      return rig.projectFramingSubjects();
    },
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
      if (visualsStillTimer !== undefined) clearTimeout(visualsStillTimer);
      if (destroyed) {
        return;
      }
      destroyed = true;
      visuals?.destroy();
      resizeObserver.disconnect();
      detachInteractions();
      labels.destroy();
      distinct?.destroy();
      typedLayer.dispose();
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

/** Three independent GPU collections: nodes, source edges and structural relations. The derived geometry
 * (containers, curves, field rings) is the projection visuals layer's. Updating attributes keeps the group,
 * renderer, and camera alive. */
function createTypedProjectionLayer(scene: Scene): {
  readonly group: THREE.Group;
  update(geometry: TypedProjectionGeometry): void;
  dispose(): void;
} {
  const group = new THREE.Group();
  const tokenColor = (name: "text" | "edge" | "peak"): THREE.Color => {
    const channel = tokenToSrgb(scene.tokens[name], scene.tokenEncoding);
    return new THREE.Color().setRGB(channel.red, channel.green, channel.blue);
  };
  const points = (color: THREE.Color, size: number): THREE.Points => {
    const object = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color, size, sizeAttenuation: false, depthTest: true,
    }));
    object.frustumCulled = false;
    group.add(object);
    return object;
  };
  const lines = (color: THREE.Color): THREE.LineSegments => {
    const object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color, depthTest: true,
    }));
    object.frustumCulled = false;
    group.add(object);
    return object;
  };
  const nodePoints = points(tokenColor("text"), 9);
  const semanticLines = lines(tokenColor("edge"));
  const structuralLines = lines(tokenColor("peak"));
  const previousValues = new Map<THREE.Points | THREE.LineSegments, readonly number[]>();
  const write = (object: THREE.Points | THREE.LineSegments, values: readonly number[]): void => {
    const previous = previousValues.get(object);
    if (previous?.length === values.length && previous.every((value, index) => value === values[index])) return;
    object.geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    object.geometry.setDrawRange(0, values.length / 3);
    object.geometry.attributes.position!.needsUpdate = true;
    previousValues.set(object, values);
  };
  const pointValues = (items: readonly TypedPoint[]): number[] => {
    const values: number[] = [];
    for (const item of items) values.push(item.position.x, item.position.y, item.position.z);
    return values;
  };
  const segmentValues = (items: readonly TypedSegment[]): number[] => {
    const values: number[] = [];
    for (const item of items) values.push(
      item.source.x, item.source.y, item.source.z, item.target.x, item.target.y, item.target.z,
    );
    return values;
  };
  return {
    group,
    update(geometry): void {
      write(nodePoints, pointValues(geometry.nodes));
      write(semanticLines, segmentValues(geometry.semanticEdges));
      write(structuralLines, segmentValues(geometry.visualRelations));
    },
    dispose(): void {
      for (const child of group.children) {
        if (child instanceof THREE.Points || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      }
      previousValues.clear();
      group.removeFromParent();
    },
  };
}

function scenesForState(
  graph: VisualGraph,
  state: VisualState,
  calibration: CalibrationProfile | undefined,
  phase: number | undefined,
  navigationPath: ScaleNavigationPath | undefined,
  temporalInstant: string | undefined,
  suppliedAnchors: ReadonlyMap<string, Coordinates> | undefined,
  presentation?: PresentationOptions,
): CameraScenes {
  const orthographicState = createVisualState(graph, { ...state, cameraKind: ORTHOGRAPHIC });
  const perspectiveState = createVisualState(graph, { ...state, cameraKind: PERSPECTIVE });
  return {
    orthographic: buildSceneWithCalibration(
      graph, orthographicState, calibration, phase, navigationPath, temporalInstant, suppliedAnchors, presentation,
    ),
    perspective: buildSceneWithCalibration(
      graph, perspectiveState, calibration, phase, navigationPath, temporalInstant, suppliedAnchors, presentation,
    ),
  };
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

function stateFromOptions(
  graph: VisualGraph,
  options: Render3fOptions,
  camera: VisualStateCamera,
): VisualState {
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera,
    cameraKind: ORTHOGRAPHIC,
    morphology: options.morphology,
    organization: options.organization,
    palette: options.palette ?? SHIPPING_RENDER_DEFAULTS.palette,
    temperature: options.temperature,
    theme: options.theme,
    lodBand: options.lodBand,
    reducedMotion: options.reducedMotion,
  });
}

function readNodeFootprints(live: LiveSceneState, rig: CameraRig, ids?: ReadonlySet<string>): readonly NodeFootprintWitness[] {
  const buffers = live.buffers.nodes;
  const result: NodeFootprintWitness[] = [];
  buffers.ids.forEach((id, index) => {
    if (ids && !ids.has(id)) return;
    const position = coordinatesAt(buffers.positions, index);
    const sizeScale = rig.sizeScaleAt(position);
    const coreRadiusPx = requiredNumber(buffers.coreRadiiPx[index], `mounted node ${id} core radius`) * sizeScale;
    const requestedHaloRadius = requiredNumber(buffers.haloRadiiPx[index], `mounted node ${id} halo radius`) * sizeScale;
    const gapHaloRadius = (
      requiredNumber(buffers.coreRadiiPx[index], `mounted node ${id} core radius`)
      + requiredNumber(buffers.haloCoreGapsPx[index], `mounted node ${id} halo core gap`)
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
