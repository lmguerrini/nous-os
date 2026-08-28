import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { GraphRendererHandle, MultiCameraRendererHandle, NodeFootprintWitness } from "#engine/renderer-handle.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { mount as mountSigma } from "#render2d/index.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { mount as mountThree } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { cameraStateForBounds } from "#render3f/camera.tsx";
import {
  assertProjectedCameraFramingSubjectsInsideViewport,
  sceneCameraFramingSubjects,
} from "#render3f/camera-framing.ts";
import type { ParityRenderer } from "#browser/parity.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";
import { buildScene } from "#scene/index.ts";
import { immediateNeighbourhoodFraming } from "#test-render3f/review-framing.ts";

/** This names the review views and does not name a renderer implementation detail. */
export type Review3dView = "macro" | "meso" | "micro" | "selected" | "focused" | "orbit-a" | "orbit-b";

/** This names a renderer shared with the parity suite and does not admit an unregistered renderer. */
export type Review3dRenderer = ParityRenderer;

/** This requests one static visual review frame and does not alter the fixture selected by the page module. */
export type Review3dCaptureRequest = {
  readonly renderer: Review3dRenderer;
  readonly view: Review3dView;
};

/** This records one mounted review frame and does not retain a renderer instance. */
export type Review3dCaptureWitness = {
  readonly renderer: Review3dRenderer;
  readonly view: Review3dView;
  readonly semanticDigest: string;
  readonly requestedVisualState: VisualState;
  readonly observedVisualState: VisualState;
  readonly selectedOrFocusedId: string | null;
  readonly surface: {
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly projection: {
    readonly kind: VisualState["cameraKind"];
    readonly comparisonNote: string | null;
  };
  readonly drawnExtentFraming: {
    readonly checkedSubjectCount: number;
    readonly minimumClearanceCssPx: number;
  } | null;
  readonly microFraming: {
    readonly selectedElementId: string;
    readonly selectionRule: string;
    readonly degree: number;
    readonly centeringRule: string;
    readonly neighbourCount: number;
    readonly targetCameraCenter: { readonly x: number; readonly y: number };
    readonly targetFootprint: NodeFootprintWitness | null;
  };
};

/** This exposes fixed review capture operations and does not expose renderer-private state. */
export type Review3dPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  capture(request: Review3dCaptureRequest): Promise<Review3dCaptureWitness>;
  destroy(): Promise<void>;
};

type RendererMount = (
  container: HTMLElement,
  graph: VisualGraph,
  options: RenderOptions,
  framingBox: undefined,
  initialVisualState: VisualState,
) => GraphRendererHandle;

type MountedRenderer = {
  readonly handle: GraphRendererHandle;
};

type ReviewFraming = {
  readonly bounds: VisualStateCamera["bounds"];
  readonly micro: {
    readonly selectedElementId: string;
    readonly selectionRule: string;
    readonly degree: number;
    readonly centeringRule: string;
    readonly neighbourCount: number;
    readonly targetCameraCenter: { readonly x: number; readonly y: number };
    readonly bounds: VisualStateCamera["bounds"];
  };
};

declare global {
  interface Window {
    __review3d?: Review3dPageApi;
  }
}

const FIXTURE_URL = ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/");
const PAGE_ROOT_ID = "review3d-root";
const PAGE_RENDERER_ID = "review3d-renderer";
const REVIEW3D_RENDERERS = ["sigma-2d", "r3f-2d", "r3f-3d"] as const satisfies readonly Review3dRenderer[];
const REQUIRED_HANDLE_METHODS = [
  "readVisualState",
  "setSelection",
  "getSelection",
  "setFocus",
  "getFocus",
  "readSurfaceWitness",
  "readNodeFootprintWitnesses",
  "destroy",
] as const;
const MULTI_CAMERA_HANDLE_METHODS = ["setCameraKind"] as const;
const CAPTURE_OPTIONS: RenderOptions = {
  morphology: "stellar",
  organization: "indra",
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "meso",
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};
const PERSPECTIVE_COMPARISON_NOTE = "Perspective uses camera.ratio as a calibrated dolly distance and camera.angle as an orbit; it has no equivalent orthographic zoom ratio.";
const MICRO_FRAMING_RULE = "unique node with the maximum count of incident relations; ties are rejected";
const MICRO_CENTERING_RULE = "bounding-box midpoint of the selected node and every immediate relation endpoint";
const CAPTURE_WIDTH_CSS_PX = 1_200;
const CAPTURE_HEIGHT_CSS_PX = 800;

const rendererMounts: Readonly<Record<Review3dRenderer, RendererMount>> = {
  "sigma-2d": mountSigma as unknown as RendererMount,
  "r3f-2d": mountThree as unknown as RendererMount,
  "r3f-3d": mountThree as unknown as RendererMount,
};

/** This installs the static visual-review page module and does not begin a capture until the spec requests one. */
export async function installReview3dPage(): Promise<void> {
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
      throw new Error(`review3d fixture failed with ${response.status}`);
    }
    const graph = toVisualGraph(JSON.parse(await response.text()) as unknown);
    assertVisualGraphFieldRegister(graph);
    const root = document.createElement("main");
    root.id = PAGE_ROOT_ID;
    root.style.cssText = `width:1200px;height:800px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = PAGE_RENDERER_ID;
    container.style.cssText = "width:1200px;height:800px;position:relative";
    root.append(container);
    document.body.replaceChildren(root);
    document.body.style.margin = "0";

    const framing = framingFor(graph);
    const targetId = primaryNodeId(graph);
    let mounted: MountedRenderer | undefined;
    const destroy = async (): Promise<void> => {
      mounted?.handle.destroy();
      mounted = undefined;
      container.replaceChildren();
      await settle();
    };
    const capture = async (request: Review3dCaptureRequest): Promise<Review3dCaptureWitness> => {
      if (!REVIEW3D_RENDERERS.includes(request.renderer)) {
        throw new Error(`review3d renderer ${request.renderer} is not registered`);
      }
      if (!isReview3dView(request.view)) {
        throw new Error(`review3d view ${request.view} is not registered`);
      }
      await destroy();
      const requestedVisualState = requestedState(graph, request, framing, targetId);
      const options: RenderOptions = { ...CAPTURE_OPTIONS, lodBand: requestedVisualState.lodBand };
      const raw = rendererMounts[request.renderer](container, graph, options, undefined, requestedVisualState);
      const handle = requiredGraphRendererHandle(raw, request.renderer);
      if (request.renderer === "r3f-3d") {
        requiredMultiCameraHandle(handle, request.renderer).setCameraKind(PERSPECTIVE);
      }
      mounted = { handle };
      applyInteractionState(handle, requestedVisualState);
      await settle();
      const observedVisualState = handle.readVisualState();
      assertRequestedVisualState(requestedVisualState, observedVisualState, request.renderer, request.view);
      const surface = handle.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error(`review3d ${request.renderer} ${request.view} mounted an empty visible surface`);
      }
      const drawnExtentFraming = requiresFullGraphPerspectiveFraming(request)
        ? assertProjectedCameraFramingSubjectsInsideViewport(
            requiredRender3fHandle(handle, request.renderer).readProjectedCameraFramingSubjects(),
            CAPTURE_WIDTH_CSS_PX,
            CAPTURE_HEIGHT_CSS_PX,
            `review3d ${request.renderer}/${request.view}`,
          )
        : null;
      return {
        renderer: request.renderer,
        view: request.view,
        semanticDigest: semanticDigest(graph),
        requestedVisualState,
        observedVisualState,
        selectedOrFocusedId: requestedVisualState.selectedId ?? requestedVisualState.focusedId,
        surface: { nodeCount: surface.nodeIds.length, edgeCount: surface.edgeIds.length },
        projection: {
          kind: observedVisualState.cameraKind,
          comparisonNote: request.renderer === "r3f-3d" ? PERSPECTIVE_COMPARISON_NOTE : null,
        },
        drawnExtentFraming,
        microFraming: {
          selectedElementId: framing.micro.selectedElementId,
          selectionRule: framing.micro.selectionRule,
          degree: framing.micro.degree,
          centeringRule: framing.micro.centeringRule,
          neighbourCount: framing.micro.neighbourCount,
          targetCameraCenter: framing.micro.targetCameraCenter,
          targetFootprint: nodeFootprint(handle, framing.micro.selectedElementId),
        },
      };
    };
    window.__review3d = { ready: true, errors, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__review3d = unavailableApi(errors);
  }
}

function requestedState(
  graph: VisualGraph,
  request: Review3dCaptureRequest,
  framing: ReviewFraming,
  targetId: string,
): VisualState {
  const configuration = viewConfiguration(request.view);
  const framingBounds = request.view === "micro" ? framing.micro.bounds : framing.bounds;
  const defaultCamera = cameraStateForBounds(framingBounds);
  const baseCamera = {
    ...defaultCamera,
    angle: configuration.angle,
    // The close view's zoom comes from its own bounds, so it keeps the framing helper's ratio rather
    // than multiplying a second zoom on top of an already-tight frame.
    ratio: request.view === "micro" ? defaultCamera.ratio : configuration.ratio,
  };
  const baseState = createVisualState(graph, {
    selectedId: configuration.interaction === "selected" ? targetId : null,
    focusedId: configuration.interaction === "focused" ? targetId : null,
    camera: baseCamera,
    cameraKind: request.renderer === "r3f-3d" ? PERSPECTIVE : ORTHOGRAPHIC,
    morphology: CAPTURE_OPTIONS.morphology,
    organization: CAPTURE_OPTIONS.organization,
    palette: CAPTURE_OPTIONS.palette ?? "monochrome",
    temperature: CAPTURE_OPTIONS.temperature,
    theme: CAPTURE_OPTIONS.theme,
    lodBand: configuration.lodBand,
    reducedMotion: true,
  });
  // A zoomed view recentres on the content that view is about, by one rule for every renderer.
  // Uniform in mechanism, not in target: meso shows the graph and micro shows a neighbourhood, and
  // they are about different things. Centring micro on the whole-scene centroid was uniform,
  // principled, and produced a close-up containing no nodes at all — the centroid falls in the void
  // between clusters, and at a ratio of 0.28 that void fills the frame. Every gate stayed green on
  // it, because a lit-pixel floor cannot tell a subject from three filaments passing through (F33).
  const center = request.view === "micro" || configuration.ratio >= defaultCamera.ratio
    ? baseCamera
    : resolvedSceneCameraCenter(graph, baseState);
  return createVisualState(graph, {
    selectedId: configuration.interaction === "selected" ? targetId : null,
    focusedId: configuration.interaction === "focused" ? targetId : null,
    camera: {
      ...baseCamera,
      x: center.x,
      y: center.y,
    },
    cameraKind: request.renderer === "r3f-3d" ? PERSPECTIVE : ORTHOGRAPHIC,
    morphology: CAPTURE_OPTIONS.morphology,
    organization: CAPTURE_OPTIONS.organization,
    palette: CAPTURE_OPTIONS.palette ?? "monochrome",
    temperature: CAPTURE_OPTIONS.temperature,
    theme: CAPTURE_OPTIONS.theme,
    lodBand: configuration.lodBand,
    reducedMotion: true,
  });
}

/** This centres a zoomed capture on the positions resolved for the renderer-facing scene. */
function resolvedSceneCameraCenter(
  graph: VisualGraph,
  state: VisualState,
): { readonly x: number; readonly y: number } {
  const subjects = sceneCameraFramingSubjects(buildScene(graph, state));
  if (subjects.length === 0) {
    throw new Error("review3d zoom framing requires one resolved scene subject");
  }
  const total = subjects.reduce(
    (sum, subject) => ({ x: sum.x + subject.position.x, y: sum.y + subject.position.y }),
    { x: 0, y: 0 },
  );
  return {
    x: normaliseWithinBounds(total.x / subjects.length, state.camera.bounds.x),
    y: normaliseWithinBounds(total.y / subjects.length, state.camera.bounds.y),
  };
}

function viewConfiguration(view: Review3dView): {
  readonly lodBand: VisualState["lodBand"];
  readonly ratio: number;
  readonly angle: number;
  readonly interaction: "none" | "selected" | "focused";
} {
  switch (view) {
    case "macro":
      return { lodBand: "macro", ratio: 1, angle: 0, interaction: "none" };
    case "meso":
      return { lodBand: "meso", ratio: 0.55, angle: 0, interaction: "none" };
    case "micro":
      return { lodBand: "micro", ratio: 0.28, angle: 0, interaction: "none" };
    case "selected":
      return { lodBand: "meso", ratio: 0.55, angle: 0, interaction: "selected" };
    case "focused":
      return { lodBand: "meso", ratio: 0.55, angle: 0, interaction: "focused" };
    case "orbit-a":
      return { lodBand: "meso", ratio: 1, angle: 0, interaction: "none" };
    case "orbit-b":
      return { lodBand: "meso", ratio: 1, angle: 0.65, interaction: "none" };
  }
}

function applyInteractionState(handle: GraphRendererHandle, state: VisualState): void {
  if (state.selectedId !== null) {
    handle.setSelection(state.selectedId);
  }
  if (state.focusedId !== null) {
    handle.setFocus(state.focusedId);
  }
  if (handle.getSelection() !== state.selectedId || handle.getFocus() !== state.focusedId) {
    throw new Error("review3d renderer did not retain the requested interaction state");
  }
}

function framingFor(graph: VisualGraph): ReviewFraming {
  const anchors = layoutAnchors(createEngineGraphView(graph).graph, DEFAULT_CALIBRATION);
  if (anchors.size === 0) {
    throw new Error("review3d framing requires at least one layout anchor");
  }
  const values = [...anchors.values()];
  const bounds = {
    x: extentWithMargin(values.map((anchor) => anchor.x)),
    y: extentWithMargin(values.map((anchor) => anchor.y)),
  };
  const target = highestDegreeNode(graph);
  const neighbourhood = immediateNeighbourhoodFraming(graph, anchors, target.id);
  // The close view frames the neighbourhood's OWN extent through the same helper the widest view
  // uses, rather than applying a zoom ratio to a centre expressed in a normalised space this harness
  // has to guess the convention of. Two attempts to compute that centre put the subject against the
  // top edge and then out of frame entirely, while every gate stayed green; deriving bounds and
  // letting the established helper turn them into a camera removes the guess rather than tuning it.
  const neighbourhoodAnchors = neighbourhood.nodeIds.map((id) => {
    const anchor = anchors.get(id);
    if (anchor === undefined) {
      throw new Error(`review3d micro framing lacks a layout anchor for ${id}`);
    }
    return anchor;
  });
  const microBounds = {
    x: extentWithMargin(neighbourhoodAnchors.map((anchor) => anchor.x)),
    y: extentWithMargin(neighbourhoodAnchors.map((anchor) => anchor.y)),
  };
  return {
    bounds,
    micro: {
      selectedElementId: target.id,
      selectionRule: MICRO_FRAMING_RULE,
      degree: target.degree,
      centeringRule: MICRO_CENTERING_RULE,
      neighbourCount: neighbourhood.nodeIds.length - 1,
      bounds: microBounds,
      targetCameraCenter: {
        x: normaliseWithinBounds(neighbourhood.center.x, bounds.x),
        y: normaliseWithinBounds(neighbourhood.center.y, bounds.y),
      },
    },
  };
}

function requiresFullGraphPerspectiveFraming(request: Review3dCaptureRequest): boolean {
  return request.renderer === "r3f-3d"
    && ["macro", "orbit-a", "orbit-b"].includes(request.view);
}

function extentWithMargin(values: readonly number[]): readonly [number, number] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const margin = span === 0
    ? 1
    : (span * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  return [minimum - margin, maximum + margin];
}

function highestDegreeNode(graph: VisualGraph): { readonly id: string; readonly degree: number } {
  const degrees = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    const sourceDegree = degrees.get(edge.source);
    const targetDegree = degrees.get(edge.target);
    if (sourceDegree === undefined || targetDegree === undefined) {
      throw new Error(`review3d micro framing relation ${edge.id} has an unavailable endpoint`);
    }
    degrees.set(edge.source, sourceDegree + 1);
    if (edge.target !== edge.source) {
      degrees.set(edge.target, targetDegree + 1);
    }
  }
  const ranked = [...degrees.entries()]
    .map(([id, degree]) => ({ id, degree }))
    .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id));
  const target = ranked[0];
  if (target === undefined) {
    throw new Error("review3d micro framing requires one graph node");
  }
  if (ranked[1]?.degree === target.degree) {
    throw new Error(`review3d micro framing maximum degree ${target.degree} is not unique`);
  }
  return target;
}

function normaliseWithinBounds(value: number, bounds: readonly [number, number]): number {
  return (value - bounds[0]) / (bounds[1] - bounds[0]);
}

function primaryNodeId(graph: VisualGraph): string {
  const node = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))[0];
  if (node === undefined) {
    throw new Error("review3d selection and focus require one graph node");
  }
  return node.id;
}

function assertRequestedVisualState(
  requested: VisualState,
  observed: VisualState,
  renderer: Review3dRenderer,
  view: Review3dView,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(requested)) {
    throw new Error(`review3d ${renderer} ${view} did not retain the requested VisualState`);
  }
}

function nodeFootprint(handle: GraphRendererHandle, id: string): NodeFootprintWitness | null {
  return handle.readNodeFootprintWitnesses().find((candidate) => candidate.id === id) ?? null;
}

function requiredRender3fHandle(handle: GraphRendererHandle, renderer: Review3dRenderer): Render3fRendererHandle {
  const candidate = handle as Partial<Render3fRendererHandle>;
  if (typeof candidate.readProjectedCameraFramingSubjects !== "function") {
    throw new Error(`review3d ${renderer} has no projected camera framing witness`);
  }
  return candidate as Render3fRendererHandle;
}

function requiredGraphRendererHandle(value: unknown, renderer: Review3dRenderer): GraphRendererHandle {
  if (!isRecord(value)) {
    throw new Error(`review3d ${renderer} did not return a GraphRendererHandle`);
  }
  const missing: string[] = REQUIRED_HANDLE_METHODS.filter((name) => typeof value[name] !== "function");
  if (typeof value.cameraKind !== "string") {
    missing.push("cameraKind");
  }
  if (missing.length > 0) {
    throw new Error(`review3d ${renderer} is missing GraphRendererHandle ${missing.join(", ")}`);
  }
  return value as unknown as GraphRendererHandle;
}

function requiredMultiCameraHandle(handle: GraphRendererHandle, renderer: Review3dRenderer): MultiCameraRendererHandle {
  const value = handle as unknown as Record<string, unknown>;
  const missing = MULTI_CAMERA_HANDLE_METHODS.filter((name) => typeof value[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`review3d ${renderer} is missing MultiCameraRendererHandle ${missing.join(", ")}`);
  }
  return handle as MultiCameraRendererHandle;
}

function isReview3dView(value: string): value is Review3dView {
  return ["macro", "meso", "micro", "selected", "focused", "orbit-a", "orbit-b"].includes(value as Review3dView);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function settle(): Promise<void> {
  await nextPaint();
  await nextPaint();
  await nextPaint();
}

function unavailableApi(errors: readonly string[]): Review3dPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "review3d page module is unavailable");
  };
  return {
    ready: false,
    errors,
    capture: async () => unavailable(),
    destroy: async () => unavailable(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (typeof window !== "undefined") {
  void installReview3dPage();
}
