import { armFrameCounter, firedSinceArming, settleUncounted } from "#browser/frame-counter.ts";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createRenderedStateCarrier } from "#engine/contract.ts";
import type { Coordinates, RenderedStateCarrier, VisualGraph } from "#engine/contract.ts";
import type { GraphRendererHandle, MultiCameraRendererHandle,
  ResourceCountingRendererHandle, NodeFootprintWitness, RetainedResourceWitness, SurfaceWitness, WorldAnchorWitness } from "#engine/renderer-handle.ts";
import { createVisualState, deserializeVisualState, serializeVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { mount as mountSigma } from "#render2d/index.ts";
import type { RenderFramingBox } from "#render2d/index.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { mount as mountThree } from "#render3f/mount.tsx";
import { buildScene, legalRenderedCombinations } from "#scene/index.ts";
import type { Scene } from "#scene/index.ts";

/** This names each renderer observed by the parity suite and does not name an implementation detail. */
export const PARITY_RENDERERS = ["sigma-2d", "r3f-2d", "r3f-3d"] as const;

/** This names one renderer observed by the parity suite and does not accept an unregistered renderer. */
export type ParityRenderer = typeof PARITY_RENDERERS[number];

/** This names the R3F renderers covered by the full-app smoke and does not include the fixed-camera renderer. */
export type FullAppRenderer = Exclude<ParityRenderer, "sigma-2d">;

/** This names the synthetic policy fixtures used by the full-app smoke and does not name renderer state. */
export type FullAppPolicy = "Discovery" | "Reliability";

import { PROJECTION_DEPENDENT_SCENE_CHANNELS, assertSceneCameraParity } from "#browser/parity-contract.ts";
export { PROJECTION_DEPENDENT_SCENE_CHANNELS, assertSceneCameraParity };

/** This records the live surface and node witnesses of one mounted renderer and does not retain its input graph. */
export type MountedParityWitness = {
  readonly renderer: ParityRenderer;
  readonly surface: SurfaceWitness;
  readonly footprints: readonly NodeFootprintWitness[];
  readonly visualState: VisualState;
};

/** This records one legal governed state drawn by one mounted renderer and does not inspect a resolved material token. */
export type RenderedStatePixelWitness = {
  readonly renderer: ParityRenderer;
  readonly stateKey: string;
  readonly targetId: string;
  readonly point: { readonly x: number; readonly y: number };
};

/** This records a node picked at its renderer-projected anchor and does not reuse another renderer's projection. */
export type NodePickWitness = {
  readonly id: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly pickedId: string | null;
};

/** This records the pixels and real provenance used for an interaction observation and does not infer provenance. */
export type InteractionWitness = {
  readonly selectedId: string;
  readonly outsideFocusId: string;
  readonly selectedFootprint: NodeFootprintWitness;
  readonly outsideFocusFootprint: NodeFootprintWitness;
  readonly provenance: { readonly value: unknown; readonly origin: string } | null;
};

/** This records a controlled zero-tolerance mount and does not claim that zero tolerance is usable. */
export type ZeroToleranceWitness = {
  readonly renderer: ParityRenderer;
  readonly configuredPickTolerancePx: number;
};

/** This records the camera/layout operations that the public handle can or cannot witness and does not fabricate anchors. */
export type CameraLayoutCapabilityWitness = {
  readonly renderer: "r3f-2d";
  readonly missingMethods: readonly string[];
};

/** This records mounted state used for a determinism digest and does not substitute graph-input anchors for live anchors. */
export type DeterminismSemanticWitness = {
  readonly renderer: ParityRenderer;
  readonly surface: SurfaceWitness;
  readonly footprints: readonly NodeFootprintWitness[];
  readonly camera: VisualState["camera"];
};

/** This records a live R3F full-app mount and does not retain the graph used to create it. */
export type FullAppMountWitness = {
  readonly renderer: FullAppRenderer;
  readonly surface: SurfaceWitness;
  readonly footprints: readonly NodeFootprintWitness[];
  readonly visualState: VisualState;
  /** This is null when the renderer does not enumerate its own graphics resources, and is never a fabricated zero. */
  readonly retainedResources: RetainedResourceWitness | null;
};

/** This records one R3F camera switch through live renderer witnesses and does not infer anchors from input data. */
export type FullAppCameraSwitchWitness = {
  readonly renderer: FullAppRenderer;
  readonly before: {
    readonly visualState: VisualState;
    readonly anchors: readonly WorldAnchorWitness[];
    readonly layoutPassCount: number;
  };
  readonly after: {
    readonly visualState: VisualState;
    readonly anchors: readonly WorldAnchorWitness[];
    readonly layoutPassCount: number;
  };
};

/** This records a live provenance-backed interaction target and does not derive provenance from fixture input. */
export type FullAppInteractionWitness = {
  readonly renderer: FullAppRenderer;
  readonly selectedId: string;
  readonly outsideFocusId: string;
  readonly selectedFootprint: NodeFootprintWitness;
  readonly outsideFocusFootprint: NodeFootprintWitness;
};

/** This records a serialised-view restoration through live render and picking witnesses and does not retain a destroyed handle. */
export type FullAppVisualStateRoundTripWitness = {
  readonly renderer: FullAppRenderer;
  readonly serializedVisualState: string;
  readonly original: FullAppMountWitness;
  readonly restored: FullAppMountWitness;
  readonly pickedNodeId: string;
  readonly originalPickedNodeId: string | null;
  readonly restoredPickedNodeId: string | null;
};

/** This records full-app cleanup after frame settling and does not count unrelated page elements. */
export type FullAppShutdownWitness = {
  readonly canvases: number;
  readonly domLabelOverlays: number;
  readonly framesAfterShutdown: number;
};

/** This exposes browser-side parity operations and does not expose renderer-private state. */
export type ParityBrowserApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  mountAll(): Promise<readonly MountedParityWitness[]>;
  mountBase(renderer: ParityRenderer): Promise<MountedParityWitness>;
  readSceneCameraParity(): Promise<{
    readonly differences: readonly string[];
    readonly negativeControlOutput: string;
  }>;
  renderLegalState(renderer: ParityRenderer, stateIndex: number): Promise<RenderedStatePixelWitness>;
  prepareInteraction(renderer: ParityRenderer): Promise<InteractionWitness>;
  select(renderer: ParityRenderer, id: string): Promise<void>;
  selectedProvenance(renderer: ParityRenderer): Promise<{ readonly value: unknown; readonly origin: string } | null>;
  footprint(renderer: ParityRenderer, id: string): Promise<NodeFootprintWitness>;
  clearSelection(renderer: ParityRenderer): Promise<void>;
  focus(renderer: ParityRenderer, id: string): Promise<void>;
  clearFocus(renderer: ParityRenderer): Promise<void>;
  nodePickSamples(renderer: ParityRenderer, count: number): Promise<readonly NodePickWitness[]>;
  pickNodeAt(renderer: ParityRenderer, point: { readonly x: number; readonly y: number }): Promise<string | null>;
  mountZeroToleranceControl(renderer: ParityRenderer): Promise<ZeroToleranceWitness>;
  readCameraLayoutCapability(): Promise<CameraLayoutCapabilityWitness>;
  readDeterminismSemanticWitness(renderer: ParityRenderer): Promise<DeterminismSemanticWitness>;
  mountFullAppState(renderer: FullAppRenderer, policy: FullAppPolicy, lodBand: VisualState["lodBand"], reducedMotion: boolean): Promise<FullAppMountWitness>;
  readFullAppState(renderer: FullAppRenderer): Promise<FullAppMountWitness>;
  switchFullAppCamera(renderer: FullAppRenderer, target: CameraKind): Promise<FullAppCameraSwitchWitness>;
  prepareFullAppInteraction(renderer: FullAppRenderer): Promise<FullAppInteractionWitness>;
  restoreFullAppVisualState(renderer: FullAppRenderer): Promise<FullAppVisualStateRoundTripWitness>;
  shutdownFullApp(): Promise<FullAppShutdownWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __parity?: ParityBrowserApi;
  }
}

type RendererMount = (
  container: HTMLElement,
  graph: VisualGraph,
  options: RenderOptions,
  framingBox?: RenderFramingBox,
  initialVisualState?: VisualState,
) => GraphRendererHandle;

type MountedRenderer = {
  readonly graph: VisualGraph;
  readonly handle: GraphRendererHandle;
  readonly options: RenderOptions;
};

const FIXTURE_URL = "fixtures/synthetic/projection/discovery-at-question.json";
const FULL_APP_FIXTURE_URLS: Readonly<Record<FullAppPolicy, string>> = {
  Discovery: ["fixtures", "synthetic", "projection", "discovery-all-time.json"].join("/"),
  Reliability: ["fixtures", "synthetic", "projection", "reliability-all-time.json"].join("/"),
};
const PAGE_ROOT_ID = "parity-root";
const pageRendererId = (renderer: ParityRenderer): string => `parity-renderer-${renderer}`;
const rendererMounts: Readonly<Record<ParityRenderer, RendererMount>> = {
  "sigma-2d": mountSigma as unknown as RendererMount,
  "r3f-2d": mountThree as unknown as RendererMount,
  "r3f-3d": mountThree as unknown as RendererMount,
};
const BASE_OPTIONS: RenderOptions = {
  morphology: "stellar",
  organization: "indra",
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: 0,
};
/** This names the ability only a multi-camera renderer has and does not require it of every renderer. */
const MULTI_CAMERA_HANDLE_METHODS = ["setCameraKind"] as const;
const REQUIRED_HANDLE_METHODS = [
  "graphToViewport",
  "readCameraState",
  "restoreCameraState",
  "readVisualState",
  "setSelection",
  "clearSelection",
  "getSelection",
  "setFocus",
  "clearFocus",
  "getFocus",
  "readSelectedProvenance",
  "readSurfaceWitness",
  "readNodeFootprintWitnesses",
  "pickNodeAtPosition",
  "pickEdgeAtPoint",
  "destroy",
] as const;
const WORLD_LAYOUT_METHODS = ["readWorldAnchorWitnesses", "readLayoutPassCount"] as const;

/** This compares resolved scenes field-by-field and does not collapse a missing field into equality. */
export function sceneDifferencePaths(left: unknown, right: unknown, path = ""): readonly string[] {
  if (Object.is(left, right)) {
    return [];
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return [path];
    }
    return left.flatMap((value, index) => sceneDifferencePaths(value, right[index], `${path}[${index}]`));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => sceneDifferencePaths(left[key], right[key], path === "" ? key : `${path}.${key}`));
  }
  return [path];
}


/** This rejects unequal mounted surfaces and does not use the scene model as either side of the comparison. */
export function assertSurfaceParity(reference: SurfaceWitness, observed: SurfaceWitness, renderer: ParityRenderer): void {
  assertSameIdSet("P1 rendered node ids", reference.nodeIds, observed.nodeIds, renderer);
  assertSameIdSet("P1 rendered relation ids", reference.edgeIds, observed.edgeIds, renderer);
  for (const id of sortedIds(reference.edgeIds)) {
    const expected = reference.incidence[id];
    const actual = observed.incidence[id];
    if (expected === undefined || actual === undefined || expected.source !== actual.source || expected.target !== actual.target) {
      throw new Error(`P1 ${renderer} relation ${id} has incidence ${formatIncidence(actual)} instead of ${formatIncidence(expected)}`);
    }
  }
}

/** This records the message produced by an assertion control and does not treat a passing control as evidence. */
export function failingControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("control unexpectedly passed");
}

/** This returns the derived non-null governed domain and does not maintain a second hand-written domain list. */
export function derivedNonNullRenderedStateDomain(): readonly RenderedStateCarrier[] {
  const domain = legalRenderedCombinations().filter((carrier): carrier is Exclude<RenderedStateCarrier, null> => carrier !== null);
  if (domain.length !== 12) {
    throw new Error(`P3 derived legal non-null governed domain has ${domain.length} members instead of 12`);
  }
  return domain;
}

/** This serialises one derived governed carrier for evidence and does not assign it a numeric material magnitude. */
export function renderedStateKey(carrier: RenderedStateCarrier): string {
  return carrier === null ? "null" : carrier.map((member) => `${member.enumType}.${member.member}`).join("+");
}

/** This installs the browser page module and does not write an evidence artifact. */
export async function installParityPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    errors.push(`error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    errors.push(`unhandledrejection: ${String(event.reason)}`);
  });
  try {
    const response = await fetch(FIXTURE_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`parity fixture failed with ${response.status}`);
    }
    const graph = toVisualGraph(JSON.parse(await response.text()) as unknown);
    assertVisualGraphFieldRegister(graph);
    const fullAppGraphs = await loadFullAppGraphs();
    const root = document.createElement("main");
    root.id = PAGE_ROOT_ID;
    root.style.cssText = "width:1200px;height:800px;position:relative";
    for (const renderer of PARITY_RENDERERS) {
      const container = document.createElement("div");
      container.id = pageRendererId(renderer);
      container.style.cssText = "width:1200px;height:800px;position:absolute;inset:0";
      root.append(container);
    }
    document.body.replaceChildren(root);
    const mounted = new Map<ParityRenderer, MountedRenderer>();
    const containerFor = (renderer: ParityRenderer): HTMLElement => requiredElement(pageRendererId(renderer));
    const mount = async (
      renderer: ParityRenderer,
      candidateGraph = graph,
      options = BASE_OPTIONS,
      initialVisualState?: VisualState,
    ): Promise<MountedParityWitness> => {
      for (const candidate of PARITY_RENDERERS) {
        containerFor(candidate).style.visibility = candidate === renderer ? "visible" : "hidden";
      }
      mounted.get(renderer)?.handle.destroy();
      const container = containerFor(renderer);
      container.replaceChildren();
      const raw = rendererMounts[renderer](container, candidateGraph, options, undefined, initialVisualState);
      const handle = requiredGraphRendererHandle(raw, renderer);
      if (renderer === "r3f-3d") {
        requiredMultiCameraHandle(handle, renderer).setCameraKind(PERSPECTIVE);
      }
      mounted.set(renderer, { graph: candidateGraph, handle, options });
      await nextPaint();
      await nextPaint();
      return mountedWitness(renderer, handle);
    };
    const current = (renderer: ParityRenderer): MountedRenderer => {
      const value = mounted.get(renderer);
      if (value === undefined) {
        throw new Error(`parity renderer ${renderer} is not mounted`);
      }
      return value;
    };
    const api: ParityBrowserApi = {
      ready: false,
      errors,
      async mountAll(): Promise<readonly MountedParityWitness[]> {
        return Promise.all(PARITY_RENDERERS.map(async (renderer) => mount(renderer)));
      },
      async mountBase(renderer: ParityRenderer): Promise<MountedParityWitness> {
        return mount(renderer);
      },
      async readSceneCameraParity(): Promise<{ readonly differences: readonly string[]; readonly negativeControlOutput: string }> {
        if (!mounted.has("sigma-2d")) {
          await mount("sigma-2d");
        }
        const sigma = current("sigma-2d");
        const initial = sigma.handle.readVisualState();
        const orthographic = createVisualState(graph, { ...initial, cameraKind: ORTHOGRAPHIC });
        const perspective = createVisualState(graph, { ...initial, cameraKind: PERSPECTIVE });
        const orthographicScene = buildScene(graph, orthographic);
        const perspectiveScene = buildScene(graph, perspective);
        const differences = sceneDifferencePaths(orthographicScene, perspectiveScene);
        assertSceneCameraParity(differences);
        const negativeControl = perturbSceneChannel(perspectiveScene);
        return {
          differences,
          negativeControlOutput: failingControlOutput(() => assertSceneCameraParity(sceneDifferencePaths(orthographicScene, negativeControl))),
        };
      },
      async renderLegalState(renderer: ParityRenderer, stateIndex: number): Promise<RenderedStatePixelWitness> {
        const carrier = requiredDomainItem(stateIndex);
        const variation = graphWithRenderedState(graph, carrier);
        const snapshot = await mount(renderer, variation);
        const targetId = renderedStateTargetId(variation, carrier);
        const footprint = snapshot.footprints.find((candidate) => candidate.id === targetId);
        if (footprint === undefined) {
          throw new Error(`P3 ${renderer} has no mounted node footprint for ${targetId}`);
        }
        return { renderer, stateKey: renderedStateKey(carrier), targetId, point: footprint.viewportCenter };
      },
      async prepareInteraction(renderer: ParityRenderer): Promise<InteractionWitness> {
        const snapshot = await mount(renderer);
        const selected = snapshot.footprints[0];
        const outside = snapshot.footprints.find((candidate) => candidate.id !== selected?.id);
        if (selected === undefined || outside === undefined) {
          throw new Error(`P4 ${renderer} requires two live node footprint witnesses`);
        }
        return {
          selectedId: selected.id,
          outsideFocusId: outside.id,
          selectedFootprint: selected,
          outsideFocusFootprint: outside,
          provenance: null,
        };
      },
      async select(renderer: ParityRenderer, id: string): Promise<void> {
        const handle = current(renderer).handle;
        handle.setSelection(id);
        if (handle.getSelection() !== id) {
          throw new Error(`P4 ${renderer} did not retain selected id ${id}`);
        }
        await nextPaint();
      },
      async selectedProvenance(renderer: ParityRenderer): Promise<{ readonly value: unknown; readonly origin: string } | null> {
        return current(renderer).handle.readSelectedProvenance();
      },
      async footprint(renderer: ParityRenderer, id: string): Promise<NodeFootprintWitness> {
        const footprint = current(renderer).handle.readNodeFootprintWitnesses().find((candidate) => candidate.id === id);
        if (footprint === undefined) {
          throw new Error(`parity renderer ${renderer} has no live footprint for ${id}`);
        }
        return footprint;
      },
      async clearSelection(renderer: ParityRenderer): Promise<void> {
        const handle = current(renderer).handle;
        handle.clearSelection();
        if (handle.getSelection() !== null) {
          throw new Error(`P4 ${renderer} did not clear selection`);
        }
        await nextPaint();
      },
      async focus(renderer: ParityRenderer, id: string): Promise<void> {
        const handle = current(renderer).handle;
        handle.setFocus(id);
        if (handle.getFocus() !== id) {
          throw new Error(`P4 ${renderer} did not retain focused id ${id}`);
        }
        await nextPaint();
      },
      async clearFocus(renderer: ParityRenderer): Promise<void> {
        current(renderer).handle.clearFocus();
        await nextPaint();
      },
      async nodePickSamples(renderer: ParityRenderer, count: number): Promise<readonly NodePickWitness[]> {
        const active = current(renderer);
        return active.graph.nodes.slice(0, count).map((node) => {
          const point = active.handle.graphToViewport(node.visual.anchor);
          return { id: node.id, point, pickedId: active.handle.pickNodeAtPosition(point) };
        });
      },
      async pickNodeAt(renderer: ParityRenderer, point: { readonly x: number; readonly y: number }): Promise<string | null> {
        return current(renderer).handle.pickNodeAtPosition(point);
      },
      async mountZeroToleranceControl(renderer: ParityRenderer): Promise<ZeroToleranceWitness> {
        const zeroToleranceCalibration = {
          ...DEFAULT_CALIBRATION,
          filament: { ...DEFAULT_CALIBRATION.filament, pickTolerancePx: 0 },
        };
        const options: RenderOptions = {
          ...BASE_OPTIONS,
          calibration: zeroToleranceCalibration,
        };
        await mount(renderer, graph, options);
        return { renderer, configuredPickTolerancePx: zeroToleranceCalibration.filament.pickTolerancePx };
      },
      async readCameraLayoutCapability(): Promise<CameraLayoutCapabilityWitness> {
        await mount("r3f-2d");
        return {
          renderer: "r3f-2d",
          missingMethods: missingMethods(current("r3f-2d").handle, WORLD_LAYOUT_METHODS),
        };
      },
      async readDeterminismSemanticWitness(renderer: ParityRenderer): Promise<DeterminismSemanticWitness> {
        const snapshot = await mount(renderer);
        return {
          renderer,
          surface: snapshot.surface,
          footprints: snapshot.footprints,
          camera: snapshot.visualState.camera,
        };
      },
      async mountFullAppState(renderer: FullAppRenderer, policy: FullAppPolicy, lodBand: VisualState["lodBand"], reducedMotion: boolean): Promise<FullAppMountWitness> {
        await mount(renderer, fullAppGraphs[policy], { ...BASE_OPTIONS, lodBand, reducedMotion });
        return fullAppMountWitness(renderer, current(renderer).handle);
      },
      async readFullAppState(renderer: FullAppRenderer): Promise<FullAppMountWitness> {
        const active = current(renderer);
        return fullAppMountWitness(renderer, active.handle);
      },
      async switchFullAppCamera(renderer: FullAppRenderer, target: CameraKind): Promise<FullAppCameraSwitchWitness> {
        const handle = current(renderer).handle;
        const switchable = requiredMultiCameraHandle(handle, renderer);
        const before = fullAppCameraWitness(handle);
        switchable.setCameraKind(target);
        await nextPaint();
        await nextPaint();
        return { renderer, before, after: fullAppCameraWitness(handle) };
      },
      async prepareFullAppInteraction(renderer: FullAppRenderer): Promise<FullAppInteractionWitness> {
        const handle = current(renderer).handle;
        const footprints = handle.readNodeFootprintWitnesses();
        let selected: NodeFootprintWitness | undefined;
        for (const candidate of footprints) {
          handle.setSelection(candidate.id);
          const provenance = handle.readSelectedProvenance();
          if (provenance !== null && provenance.value !== null && provenance.value !== undefined && provenance.origin.trim() !== "") {
            selected = candidate;
            break;
          }
        }
        handle.clearSelection();
        await nextPaint();
        if (selected === undefined) {
          throw new Error(`${renderer} has no live selection target with a non-empty derived origin`);
        }
        const outside = footprints.find((candidate) => candidate.id !== selected.id);
        if (outside === undefined) {
          throw new Error(`${renderer} requires a second live node footprint for focus`);
        }
        return {
          renderer,
          selectedId: selected.id,
          outsideFocusId: outside.id,
          selectedFootprint: selected,
          outsideFocusFootprint: outside,
        };
      },
      async restoreFullAppVisualState(renderer: FullAppRenderer): Promise<FullAppVisualStateRoundTripWitness> {
        const active = current(renderer);
        const original = fullAppMountWitness(renderer, active.handle);
        const picked = requiredLivePick(active.handle, original.footprints, `${renderer} source VisualState frame`);
        const serializedVisualState = serializeVisualState(active.handle.readVisualState());
        const restoredState = deserializeVisualState(active.graph, serializedVisualState);
        const graphForRestore = active.graph;
        const optionsForRestore = active.options;
        active.handle.destroy();
        mounted.delete(renderer);
        await mount(renderer, graphForRestore, optionsForRestore, restoredState);
        const restoredHandle = current(renderer).handle;
        const restored = fullAppMountWitness(renderer, restoredHandle);
        const restoredFootprint = restored.footprints.find((candidate) => candidate.id === picked.id);
        if (restoredFootprint === undefined) {
          throw new Error(`${renderer} restored VisualState frame lost live pick target ${picked.id}`);
        }
        return {
          renderer,
          serializedVisualState,
          original,
          restored,
          pickedNodeId: picked.id,
          originalPickedNodeId: picked.pickedId,
          restoredPickedNodeId: restoredHandle.pickNodeAtPosition(restoredFootprint.viewportCenter),
        };
      },
      async shutdownFullApp(): Promise<FullAppShutdownWitness> {
        for (const value of mounted.values()) {
          value.handle.destroy();
        }
        mounted.clear();
        armFrameCounter();
        await settleUncounted();
        await settleUncounted();
        await settleUncounted();
        return {
          canvases: document.querySelectorAll("canvas").length,
          domLabelOverlays: document.querySelectorAll('[data-render3f-labels="true"]').length,
          framesAfterShutdown: firedSinceArming(),
        };
      },
      async destroy(): Promise<void> {
        for (const value of mounted.values()) {
          value.handle.destroy();
        }
        mounted.clear();
        await nextPaint();
      },
    };
    window.__parity = { ...api, ready: true };
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    window.__parity = failedApi(errors);
  }
}

if (typeof window !== "undefined") {
  void installParityPage();
}

/** This narrows a handle to one that can enumerate its own graphics resources and does not assume a renderer can. */
function resourceCountingHandle(handle: GraphRendererHandle): ResourceCountingRendererHandle | null {
  const candidate = handle as { readonly readRetainedResources?: unknown };
  return typeof candidate.readRetainedResources === "function" ? handle as ResourceCountingRendererHandle : null;
}

function fullAppMountWitness(renderer: FullAppRenderer, handle: GraphRendererHandle): FullAppMountWitness {
  return {
    renderer,
    surface: handle.readSurfaceWitness(),
    footprints: handle.readNodeFootprintWitnesses(),
    visualState: handle.readVisualState(),
    // A renderer that cannot enumerate its own graphics resources reports none rather than a
    // fabricated zero: an unmeasured zero and a measured "nothing leaked" are indistinguishable.
    retainedResources: resourceCountingHandle(handle)?.readRetainedResources() ?? null,
  };
}

function fullAppCameraWitness(handle: GraphRendererHandle): FullAppCameraSwitchWitness["before"] {
  const missing = missingMethods(handle, WORLD_LAYOUT_METHODS);
  if (missing.length > 0) {
    throw new Error(`full-app camera switch requires GraphRendererHandle ${missing.join(", ")}`);
  }
  return {
    visualState: handle.readVisualState(),
    anchors: handle.readWorldAnchorWitnesses(),
    layoutPassCount: handle.readLayoutPassCount(),
  };
}

function requiredLivePick(
  handle: GraphRendererHandle,
  footprints: readonly NodeFootprintWitness[],
  label: string,
): { readonly id: string; readonly pickedId: string | null } {
  for (const footprint of footprints) {
    const pickedId = handle.pickNodeAtPosition(footprint.viewportCenter);
    if (pickedId === footprint.id) {
      return { id: footprint.id, pickedId };
    }
  }
  throw new Error(`${label} has no live pickable node footprint`);
}

/** This narrows a handle to one that can switch camera and does not assume a renderer can. */
function requiredMultiCameraHandle(handle: GraphRendererHandle, renderer: ParityRenderer): MultiCameraRendererHandle {
  const missing = missingMethods(handle, MULTI_CAMERA_HANDLE_METHODS);
  if (missing.length > 0) {
    throw new Error(`${renderer} is missing MultiCameraRendererHandle ${missing.join(", ")}`);
  }
  return handle as MultiCameraRendererHandle;
}

function mountedWitness(renderer: ParityRenderer, handle: GraphRendererHandle): MountedParityWitness {
  return {
    renderer,
    surface: handle.readSurfaceWitness(),
    footprints: handle.readNodeFootprintWitnesses(),
    visualState: handle.readVisualState(),
  };
}

function requiredGraphRendererHandle(value: unknown, renderer: ParityRenderer): GraphRendererHandle {
  if (!isRecord(value)) {
    throw new Error(`${renderer} did not return a GraphRendererHandle`);
  }
  const missing: string[] = REQUIRED_HANDLE_METHODS.filter((name) => typeof value[name] !== "function");
  if (typeof value.cameraKind !== "string") {
    missing.push("cameraKind");
  }
  if (missing.length > 0) {
    throw new Error(`${renderer} is missing GraphRendererHandle ${missing.join(", ")}`);
  }
  return value as unknown as GraphRendererHandle;
}

function graphWithRenderedState(graph: VisualGraph, carrier: RenderedStateCarrier): VisualGraph {
  const targetId = renderedStateTargetId(graph, carrier);
  const result: VisualGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === targetId
      ? { ...node, rendered: createRenderedStateCarrier(carrier) }
      : node),
  };
  assertVisualGraphFieldRegister(result);
  return result;
}

function renderedStateTargetId(graph: VisualGraph, carrier: RenderedStateCarrier): string {
  const first = carrier?.[0];
  const kind = first?.enumType === "TemporalDisposition" ? "assertion" : "bridge";
  const target = graph.nodes.find((node) => node.kind === kind);
  if (target === undefined) {
    throw new Error(`P3 fixture has no ${kind} node for derived state ${renderedStateKey(carrier)}`);
  }
  return target.id;
}

function requiredDomainItem(index: number): RenderedStateCarrier {
  const carrier = derivedNonNullRenderedStateDomain()[index];
  if (carrier === undefined) {
    throw new Error(`P3 derived governed state index ${index} is unavailable`);
  }
  return carrier;
}

function perturbSceneChannel(scene: Scene): Scene {
  const node = scene.nodes[0];
  if (node === undefined) {
    throw new Error("P2 negative control requires one resolved scene node");
  }
  return {
    ...scene,
    nodes: [{ ...node, token: { ...node.token, lightnessPermille: node.token.lightnessPermille + 1 } }, ...scene.nodes.slice(1)],
  };
}

function missingMethods(value: GraphRendererHandle, methods: readonly string[]): readonly string[] {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return methods.filter((name) => typeof record[name] !== "function");
}

function assertSameIdSet(label: string, left: readonly string[], right: readonly string[], renderer: ParityRenderer): void {
  const expected = sortedIds(left);
  const actual = sortedIds(right);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`${label} differs for ${renderer}: expected [${expected.join(", ")}], actual [${actual.join(", ")}]`);
  }
}

function sortedIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function formatIncidence(value: { readonly source: string; readonly target: string } | undefined): string {
  return value === undefined ? "missing" : `${value.source}->${value.target}`;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`parity page has no renderer container ${id}`);
  }
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function loadFullAppGraphs(): Promise<Readonly<Record<FullAppPolicy, VisualGraph>>> {
  const [discovery, reliability] = await Promise.all([
    loadFullAppGraph("Discovery"),
    loadFullAppGraph("Reliability"),
  ]);
  return { Discovery: discovery, Reliability: reliability };
}

async function loadFullAppGraph(policy: FullAppPolicy): Promise<VisualGraph> {
  const response = await fetch(FULL_APP_FIXTURE_URLS[policy], { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`full-app ${policy} fixture failed with ${response.status}`);
  }
  const graph = toVisualGraph(JSON.parse(await response.text()) as unknown);
  assertVisualGraphFieldRegister(graph);
  const expectedPolicyId = policy.toLowerCase();
  if (graph.policy_id !== expectedPolicyId) {
    throw new Error(`full-app ${policy} adapter returned policy_id ${graph.policy_id} instead of ${expectedPolicyId}`);
  }
  return graph;
}

function failedApi(errors: readonly string[]): ParityBrowserApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "parity page module is unavailable");
  };
  return {
    ready: false,
    errors,
    mountAll: async () => unavailable(),
    mountBase: async () => unavailable(),
    readSceneCameraParity: async () => unavailable(),
    renderLegalState: async () => unavailable(),
    prepareInteraction: async () => unavailable(),
    select: async () => unavailable(),
    selectedProvenance: async () => unavailable(),
    footprint: async () => unavailable(),
    clearSelection: async () => unavailable(),
    focus: async () => unavailable(),
    clearFocus: async () => unavailable(),
    nodePickSamples: async () => unavailable(),
    pickNodeAt: async () => unavailable(),
    mountZeroToleranceControl: async () => unavailable(),
    readCameraLayoutCapability: async () => unavailable(),
    readDeterminismSemanticWitness: async () => unavailable(),
    mountFullAppState: async () => unavailable(),
    readFullAppState: async () => unavailable(),
    switchFullAppCamera: async () => unavailable(),
    prepareFullAppInteraction: async () => unavailable(),
    restoreFullAppVisualState: async () => unavailable(),
    shutdownFullApp: async () => unavailable(),
    destroy: async () => unavailable(),
  };
}
