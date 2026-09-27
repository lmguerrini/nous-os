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
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(dimensions.width, dimensions.height, false);
  updateField(renderer, live.scene);

  const labels = new LabelOverlayController(container);
  const distinct = options.presentation?.morphologyLanguage === "distinct"
    ? mountDistinctOverlay(container, live.scene, options.morphology, options.presentation, (point) => ({
      ...rig.graphToViewport(point), scale: rig.sizeScaleAt(point),
    }))
    : null;
  if (distinct) {
    filamentResources.mesh.visible = false;
    nodeResources.mesh.visible = false;
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
  let emphasisIds = options.presentation?.emphasisIds ?? null;
  let destroyed = false;
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
    updateLabels();
    renderer.render(threeScene, rig.camera);
    distinct?.draw();
  };
  const syncCameraState = (): void => {
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
    rig.resize(dimensions.width, dimensions.height, devicePixelRatio);
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
    dpr: devicePixelRatio,
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
    rig.resize(dimensions.width, dimensions.height, devicePixelRatio);
    renderFrame();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) {
      return;
    }
    const next = containerDimensions(container);
    const nextDevicePixelRatio = requiredDevicePixelRatio();
    renderer.setPixelRatio(nextDevicePixelRatio);
    renderer.setSize(next.width, next.height, false);
    rig.resize(next.width, next.height, nextDevicePixelRatio);
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
    retainedSceneReferences.clear();
    retainedSceneReferences.add(scenes.orthographic);
    retainedSceneReferences.add(scenes.perspective);
    updateNodeRenderResources(nodeResources, live.buffers.nodes);
    updateFilamentRenderResources(filamentResources, live.buffers.filaments);
    distinct?.setScene(live.scene);
    rig.setWorldFramingSubjects(sceneCameraFramingSubjects(live.scene));
    picker.replaceScene(live.scene);
    updateField(renderer, live.scene);
    renderFrame();
  };

  return {
    setAppearance(appearance: AppearanceOptions): void { distinct?.setAppearance(appearance); },
    setEmphasis(ids: ReadonlySet<string> | null): void {
      emphasisIds = ids;
      applyMaterialState(currentState.selectedId, currentState.focusedId);
    },
    readReviewWindows() {
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
      return live.readSurfaceWitness();
    },
    readNodeFootprintWitnesses(): readonly NodeFootprintWitness[] {
      return readNodeFootprints(live, rig);
    },
    readRelationGeometryWitnesses(): readonly RelationGeometryWitness[] {
      return live.readRelationGeometryWitnesses(readSceneHeldByPicker(picker));
    },
    readProjectedCameraFramingSubjects(): readonly ProjectedCameraFramingSubject[] {
      return rig.projectFramingSubjects();
    },
    readWorldAnchorWitnesses(): readonly WorldAnchorWitness[] {
      return live.readWorldAnchorWitnesses();
    },
    readLayoutPassCount(): number {
      return live.readLayoutPassCount();
    },
    pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null {
      return picker.pickNodeAtPosition(position);
    },
    pickEdgeAtPoint(x: number, y: number): string | null {
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
      if (destroyed) {
        return;
      }
      destroyed = true;
      resizeObserver.disconnect();
      detachInteractions();
      labels.destroy();
      distinct?.destroy();
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

function readNodeFootprints(live: LiveSceneState, rig: CameraRig): readonly NodeFootprintWitness[] {
  const buffers = live.buffers.nodes;
  return buffers.ids.map((id, index) => {
    const position = coordinatesAt(buffers.positions, index);
    const sizeScale = rig.sizeScaleAt(position);
    const coreRadiusPx = requiredNumber(buffers.coreRadiiPx[index], `mounted node ${id} core radius`) * sizeScale;
    const requestedHaloRadius = requiredNumber(buffers.haloRadiiPx[index], `mounted node ${id} halo radius`) * sizeScale;
    const gapHaloRadius = (
      requiredNumber(buffers.coreRadiiPx[index], `mounted node ${id} core radius`)
      + requiredNumber(buffers.haloCoreGapsPx[index], `mounted node ${id} halo core gap`)
    ) * sizeScale;
    return {
      id,
      viewportCenter: rig.graphToViewport(position),
      coreRadiusPx,
      haloRadiusPx: Math.max(requestedHaloRadius, gapHaloRadius),
    };
  });
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
