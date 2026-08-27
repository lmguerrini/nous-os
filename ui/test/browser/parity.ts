import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createRenderedStateCarrier } from "#engine/contract.ts";
import type { Coordinates, RenderedStateCarrier, VisualGraph } from "#engine/contract.ts";
import type { GraphRendererHandle, MultiCameraRendererHandle, NodeFootprintWitness, SurfaceWitness } from "#engine/renderer-handle.ts";
import { createVisualState } from "#engine/visual-state.ts";
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

/** This pins the only resolved-scene channel permitted to vary by camera and does not allow an empty allowance. */
export const PROJECTION_DEPENDENT_SCENE_CHANNELS = ["camera.kind", "camera.navigation"] as const;

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
  "readRetainedResources",
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

/** This rejects camera scene changes outside the pinned projection channel list and does not accept a vacuous camera change. */
export function assertSceneCameraParity(differences: readonly string[]): void {
  const declaredProjectionChannels: readonly string[] = PROJECTION_DEPENDENT_SCENE_CHANNELS;
  if (declaredProjectionChannels.length === 0) {
    throw new Error("P2 projection-dependent scene channel list is empty");
  }
  const illegal = differences.filter((path) => !PROJECTION_DEPENDENT_SCENE_CHANNELS.includes(path as typeof PROJECTION_DEPENDENT_SCENE_CHANNELS[number]));
  if (illegal.length > 0) {
    throw new Error(`P2 illegal scene-channel difference: ${illegal.join(", ")}`);
  }
  if (!differences.includes("camera.kind")) {
    throw new Error("P2 camera-kind control did not produce the pinned camera.kind difference");
  }
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
    const mount = async (renderer: ParityRenderer, candidateGraph = graph, options = BASE_OPTIONS): Promise<MountedParityWitness> => {
      for (const candidate of PARITY_RENDERERS) {
        containerFor(candidate).style.visibility = candidate === renderer ? "visible" : "hidden";
      }
      mounted.get(renderer)?.handle.destroy();
      const container = containerFor(renderer);
      container.replaceChildren();
      const raw = rendererMounts[renderer](container, candidateGraph, options);
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
        const snapshot = await mount("r3f-2d");
        return {
          renderer: "r3f-2d",
          missingMethods: missingMethods(snapshot as unknown as GraphRendererHandle, WORLD_LAYOUT_METHODS),
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
    destroy: async () => unavailable(),
  };
}
