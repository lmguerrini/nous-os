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
import type { Palette, Temperature, Theme } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { SHIPPING_RENDER_DEFAULTS } from "#render2d/model.ts";
import {
  CameraRig,
  attachCameraInteractions,
  cameraStateForBounds,
  resolvedNodeBounds,
  resolvedWorldCenterZ,
} from "#render3f/camera.tsx";
import type { Render3fFramingBox } from "#render3f/camera.tsx";
import { tokenToSrgb } from "#render3f/buffers.ts";
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
};

/** This mounts one shared Three scene behind two cameras and does not compute renderer-local material. */
export function mount(
  container: HTMLElement,
  visualGraph: VisualGraph,
  options: Render3fOptions,
  framingBox?: Render3fFramingBox,
  initialVisualState?: VisualState,
): MultiCameraRendererHandle & ResourceCountingRendererHandle {
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
      const provisionalScene = buildSceneWithCalibration(visualGraph, provisionalState, options.calibration);
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
  const initialScenes = scenesForState(visualGraph, currentState, options.calibration);
  layoutPassCount += cameraKindCount();
  const live = new LiveSceneState(initialScenes, currentState.cameraKind, layoutPassCount);
  const worldCenterZ = resolvedWorldCenterZ(live.scene.nodes.map((node) => node.position));
  const rig = new CameraRig(
    currentState.cameraKind,
    live.scene.camera,
    dimensions.width,
    dimensions.height,
    devicePixelRatio,
    worldCenterZ,
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
    });
  };
  const renderFrame = (): void => {
    if (destroyed) {
      return;
    }
    updateProjection();
    updateLabels();
    renderer.render(threeScene, rig.camera);
  };
  const syncCameraState = (): void => {
    currentState = createVisualState(visualGraph, {
      ...currentState,
      camera: rig.readCameraState(),
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
      camera: rig.readCameraState(),
      cameraKind: rig.kind,
      selectedId,
      focusedId,
    });
    const scenes = scenesForState(visualGraph, currentState, options.calibration);
    live.replaceScenes(scenes, cameraKindCount());
    updateNodeRenderResources(nodeResources, live.buffers.nodes);
    updateFilamentRenderResources(filamentResources, live.buffers.filaments);
    rig.setWorldCenterZ(resolvedWorldCenterZ(live.scene.nodes.map((node) => node.position)));
    picker.replaceScene(live.scene);
    updateField(renderer, live.scene);
    renderFrame();
  };

  return {
    get cameraKind(): CameraKind {
      return rig.kind;
    },
    graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
      return rig.graphToViewport(point);
    },
    readCameraState(): VisualStateCamera {
      return rig.readCameraState();
    },
    restoreCameraState(state: VisualStateCamera): void {
      currentState = createVisualState(visualGraph, { ...currentState, camera: state });
      rig.restoreCameraState(state);
      syncCameraState();
    },
    readVisualState(): VisualState {
      currentState = createVisualState(visualGraph, {
        ...currentState,
        camera: rig.readCameraState(),
        cameraKind: rig.kind,
      });
      return currentState;
    },
    setCameraKind(kind: CameraKind): void {
      live.setCameraKind(kind);
      rig.setCameraKind(kind, live.scene.camera);
      currentState = createVisualState(visualGraph, {
        ...currentState,
        camera: rig.readCameraState(),
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
      return registry.readRetainedResources(labels.readNodeCount());
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      resizeObserver.disconnect();
      detachInteractions();
      labels.destroy();
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
): CameraScenes {
  const orthographicState = createVisualState(graph, { ...state, cameraKind: ORTHOGRAPHIC });
  const perspectiveState = createVisualState(graph, { ...state, cameraKind: PERSPECTIVE });
  return {
    orthographic: buildSceneWithCalibration(graph, orthographicState, calibration),
    perspective: buildSceneWithCalibration(graph, perspectiveState, calibration),
  };
}

function buildSceneWithCalibration(
  graph: VisualGraph,
  state: VisualState,
  calibration: CalibrationProfile | undefined,
): Scene {
  return calibration === undefined
    ? buildScene(graph, state)
    : buildScene(graph, state, calibration);
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

function updateField(renderer: THREE.WebGLRenderer, scene: Scene): void {
  const field = tokenToSrgb(scene.field.token, scene.tokenEncoding);
  renderer.setClearColor(new THREE.Color().setRGB(field.red, field.green, field.blue));
}

function requiredNodeLabelOffset(node: SceneNode): number {
  if (node.labelCandidacy === null) {
    throw new TypeError(`mounted node ${node.id} has no label offset`);
  }
  return node.labelCandidacy.placementOffsetPx;
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
