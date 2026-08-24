// MUST be first: installs the frame counter before any renderer module evaluates.
import { armFrameCounter, firedSinceArming, settleUncounted } from "#browser/frame-counter.ts";
import Sigma from "sigma";
import { MultiDirectedGraph } from "graphology";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { canonicalBytes } from "#engine/canonical.ts";
import {
  assertNoPassthrough,
  assertVisualGraphFieldRegister,
  readSemantic,
  semanticDigest,
} from "#engine/contract.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { resolveLodBand } from "#engine/lod.ts";
import type { LodBand } from "#engine/lod.ts";
import { layoutAnchors, sharedAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { mount, restoreCameraState } from "#render2d/index.ts";
import { FilamentProgram } from "#render2d/filament-program.ts";
import { quadraticPoint } from "#render2d/geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";
import type { RenderCameraState, RenderFramingBox, RenderHandle } from "#render2d/index.ts";
import type { RenderOptions as ModelRenderOptions } from "#render2d/model.ts";

type Policy = "Reliability" | "Discovery";

type FixtureFacts = {
  readonly nodes: number;
  readonly edges: number;
  readonly sha256: string;
  readonly semanticDigest: string;
  readonly semanticProjectionCanonical: string;
};

type RenderLayerWitness = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
};

type RenderWitness = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly canvasCount: number;
  readonly backingStorePixels: number;
  readonly layers: readonly RenderLayerWitness[];
};

type PickWitness = {
  readonly edgeId: string | null;
  readonly point: { readonly x: number; readonly y: number };
  /** Whether the edge that was returned actually covers the sampled point. See OG-CAP-11-2. */
  readonly pickedCoversPoint?: boolean;
  readonly onScreen?: boolean;
};

type DenseFilamentDistance = {
  readonly distancePx: number;
  readonly deviationBoundPx: number;
};

type PickingCell = {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
  /** The point the picking pass actually shaded for this cell. */
  readonly centre: Coordinates;
};

type PickingSigmaInternals = {
  readonly webGLContexts: {
    readonly edges: {
      readonly drawingBufferHeight: number;
    };
  };
};

type Snapshot = {
  readonly policy: Policy;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  readonly selectedNode: string | null;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly propagation: Readonly<Record<string, { readonly continuous: boolean; readonly endpointExpressed: boolean }>>;
  readonly windows: readonly {
    readonly id: string;
    readonly members: readonly string[];
    readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number };
    readonly viewportCenter: { readonly x: number; readonly y: number };
    readonly viewportRadius: number;
  }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, FixtureFacts>>;
  readonly rendering: RenderWitness;
  readonly edgeSamples: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
};

type EvidenceApi = {
  readonly ready: boolean;
  readonly errors: string[];
  readonly checks: string[];
  switchPolicy(policy: Policy): Promise<Snapshot>;
  switchMorphology(morphology: Morphology): Promise<Snapshot>;
  switchOrganization(organization: Organization): Promise<Snapshot>;
  setLodBand(band: LodBand): Promise<Snapshot>;
  setLodZoom(zoom: number): Promise<Snapshot>;
  setReducedMotion(reducedMotion: boolean): Promise<Snapshot>;
  selectNode(id: string): Promise<Snapshot>;
  read(): Snapshot;
  pick(edgeId: string, parameter: number, offsetPixels?: number): PickWitness;
  unambiguousParameters(edgeId: string): readonly number[];
  coincidentPartners(edgeId: string): readonly string[] | null;
  pickChord(edgeId: string): PickWitness;
  pickStraightControl(): Promise<string | null>;
  showEmptyGraphControl(): Promise<void>;
  hideEmptyGraphControl(): void;
  shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }>;
};

declare global {
  interface Window {
    __evidence?: EvidenceApi;
  }
}

// Relative on purpose. These resolve against the served root exactly as a rooted
// form would, and a rooted literal is indistinguishable from a machine path to the
// outgoing scanner -- which refuses the commit rather than guessing.
const FIXTURE_URLS: Readonly<Record<Policy, string>> = {
  Reliability: "fixtures/synthetic/projection/reliability-all-time.json",
  Discovery: "fixtures/synthetic/projection/discovery-all-time.json",
};

type MutableRenderOptions = { -readonly [Key in keyof ModelRenderOptions]: ModelRenderOptions[Key] };

const options: MutableRenderOptions = {
  morphology: "stellar",
  organization: "indra",
  palette: "interstellar",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: false,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

const EMPTY_VISUAL_GRAPH: VisualGraph = {
  schema_version: "nous-projection-ir/1",
  policy_id: "empty-control",
  question: { valid_at: null, recorded_as_of: null },
  nodes: [],
  edges: [],
};

const errors: string[] = [];
const checks: string[] = [];
const DENSE_FILAMENT_TOLERANCE_PX = 0.05;
const MAX_DENSE_FILAMENT_SEGMENTS = 1024;
const EDGE_SAMPLE_PARAMETERS = Array.from({ length: 33 }, (_, index) => 0.02 + (index * 0.03));
// Counts frames that actually FIRE after shutdown, which is the property wanted:
// destroy must leave nothing still animating. The previous instrument counted
// scheduled-minus-fired at one instant, and Sigma's kill() *cancels* in-flight
// frames, so their decrement never ran and the count was permanently inflated by
// exactly the frames a correct teardown had cancelled -- it could not reach zero
// for any renderer that tears down properly. Measured: every canvas gone and
// staying gone, counter stuck at 4.
window.addEventListener("error", (event) => {
  errors.push(`error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  errors.push(`unhandledrejection: ${String(event.reason)}`);
});

void boot().catch((error: unknown) => {
  errors.push(`boot: ${message(error)}`);
  window.__evidence = failedApi();
});

async function boot(): Promise<void> {
  const shell = document.createElement("main");
  shell.id = "evidence-shell";
  shell.style.cssText = "width:960px;height:640px;position:relative;background:#111827";
  const container = document.createElement("div");
  container.id = "evidence-renderer";
  container.style.cssText = "width:100%;height:100%;position:relative";
  const pickingContainer = document.createElement("div");
  pickingContainer.id = "evidence-picking-target";
  pickingContainer.style.cssText = "width:960px;height:640px;position:fixed;left:-2000px;top:0";
  shell.append(container, pickingContainer);
  document.body.replaceChildren(shell);

  const loaded = await Promise.all(Object.entries(FIXTURE_URLS).map(async ([policy, url]) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`fixture ${policy} failed with ${response.status}`);
    }
    const text = await response.text();
    const payload = JSON.parse(text) as unknown;
    const graph = toVisualGraph(payload);
    assertVisualGraphFieldRegister(graph);
    const graphDigest = semanticDigest(graph);
    assertNoPassthrough(graph, payload, graphDigest);
    const fixture = payload as { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] };
    return [policy as Policy, graph, {
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      sha256: await sha256(text),
      semanticDigest: graphDigest,
      semanticProjectionCanonical: semanticProjectionCanonical(graph),
    }] as const;
  }));
  const graphs = new Map<Policy, VisualGraph>();
  const fixtureFacts: Record<string, FixtureFacts> = {};
  for (const [policy, graph, facts] of loaded) {
    graphs.set(policy, graph);
    fixtureFacts[policy] = facts;
  }
  checks.push("governed fixtures passed the real projection adapter, field register, semantic digest, and passthrough boundary");
  const discoveryGraph = requiredGraph(graphs, "Discovery");
  const reliabilityGraph = requiredGraph(graphs, "Reliability");
  sharedAnchors(discoveryGraph, reliabilityGraph);
  const discoveryFramingBox = framingBoxFor(discoveryGraph);

  let policy: Policy = "Discovery";
  let selectedNode: string | null = null;
  let product: RenderHandle | undefined;
  let picking: Sigma | undefined;
  let emptyControl: RenderHandle | undefined;
  let emptyContainer: HTMLElement | undefined;

  const remount = async (cameraState?: RenderCameraState): Promise<void> => {
    product?.destroy();
    picking?.kill();
    product = undefined;
    picking = undefined;
    await waitForNonZeroBox(container);
    const graph = requiredGraph(graphs, policy);
    product = mount(container, graph, options, discoveryFramingBox);
    // This separate surface is the actual Sigma edge-picking framebuffer. The
    // product mount provides the viewport coordinates used by screenshot checks.
    picking = new Sigma(product.model.graph, pickingContainer, {
      defaultEdgeType: "filament",
      edgeProgramClasses: { filament: FilamentProgram },
      renderLabels: product.model.lodBand === "micro",
      zIndex: true,
      enableEdgeEvents: true,
    });
    if (cameraState !== undefined) {
      product.restoreCameraState(cameraState);
      restoreCameraState(picking, cameraState);
    }
    await nextPaint();
    await nextPaint();
  };

  const read = (): Snapshot => {
    const handle = requiredHandle(product);
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, anchor] of handle.model.anchors) {
      const point = handle.graphToViewport(anchor);
      positions[id] = { x: point.x, y: point.y };
    }
    const edgeSamples: Record<string, readonly { x: number; y: number }[]> = {};
    for (const [id, filament] of handle.model.filaments) {
      edgeSamples[id] = [0.25, 0.5, 0.75].map((parameter) => {
        const point = handle.graphToViewport(quadraticPoint(filament, parameter));
        return { x: point.x, y: point.y };
      });
    }
    const propagation: Record<string, { continuous: boolean; endpointExpressed: boolean }> = {};
    for (const [id, state] of handle.model.propagation) {
      propagation[id] = { continuous: state.continuous, endpointExpressed: state.endpointExpressed };
    }
    return {
      policy,
      morphology: options.morphology,
      organization: options.organization,
      lodBand: options.lodBand,
      reducedMotion: options.reducedMotion,
      selectedNode,
      nodes: handle.model.graph.nodes(),
      edges: handle.model.graph.edges(),
      positions,
      propagation,
      windows: handle.model.windows.map((window) => {
        const viewportCenter = handle.graphToViewport(window.center);
        const radiusPoint = handle.graphToViewport({ x: window.center.x + window.radius, y: window.center.y, z: window.center.z });
        return {
          id: window.id,
          members: window.members,
          bounds: window.bounds,
          viewportCenter,
          viewportRadius: Math.hypot(radiusPoint.x - viewportCenter.x, radiusPoint.y - viewportCenter.y),
        };
      }),
      rejectionBounds: handle.model.organization.rejectionBounds,
      fixtureFacts,
      rendering: renderWitness(container),
      edgeSamples,
    };
  };

  const api: EvidenceApi = {
    ready: false,
    errors,
    checks,
    async switchPolicy(next): Promise<Snapshot> {
      const cameraState = requiredHandle(product).readCameraState();
      policy = next;
      selectedNode = null;
      await remount(cameraState);
      return read();
    },
    async switchMorphology(next): Promise<Snapshot> {
      options.morphology = next;
      await remount();
      return read();
    },
    async switchOrganization(next): Promise<Snapshot> {
      options.organization = next;
      await remount();
      return read();
    },
    async setLodBand(next): Promise<Snapshot> {
      options.lodBand = next;
      await remount();
      return read();
    },
    async setLodZoom(zoom): Promise<Snapshot> {
      options.lodBand = resolveLodBand(zoom, options.lodBand, DEFAULT_CALIBRATION);
      await remount();
      return read();
    },
    async setReducedMotion(next): Promise<Snapshot> {
      options.reducedMotion = next;
      await remount();
      return read();
    },
    async selectNode(id): Promise<Snapshot> {
      if (!requiredHandle(product).model.graph.hasNode(id)) {
        throw new Error(`unknown node ${id}`);
      }
      selectedNode = id;
      checks.push(`selected ${id}`);
      return read();
    },
    read,
    pick(edgeId, parameter, offsetPixels = 0): PickWitness {
      const handle = requiredHandle(product);
      const auditor = requiredSigma(picking);
      const filament = handle.model.filaments.get(edgeId);
      if (filament === undefined) {
        throw new Error(`unknown edge ${edgeId}`);
      }
      const world = quadraticPoint(filament, parameter);
      const viewport = auditor.graphToViewport(world);
      const normal = normalAt(filament.source, filament.control, filament.target, parameter);
      const point = { x: viewport.x + (normal.x * offsetPixels), y: viewport.y + (normal.y * offsetPixels) };
      // A point outside the drawn area cannot be picked by anything; report it so a
      // check can tell "nothing is there" from "the sample fell off the canvas".
      const size = auditor.getDimensions();
      const onScreen = point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height;
      const privateSigma = auditor as unknown as { getEdgeAtPoint(x: number, y: number): string | null };
      const picked = privateSigma.getEdgeAtPoint(point.x, point.y);
      // Whether the edge that was returned actually covers the sampled point.
      // Two relations that share an endpoint can be near-coincident ribbons -- one
      // measured pair sits 1.0367 apart against a half-width of 1.0 -- so demanding
      // that a point return the specific edge whose midpoint it is fails a correct
      // renderer. What must never happen is picking an edge that does NOT cover the
      // point. See OG-CAP-11-2.
      const pickedFilament = picked === null ? undefined : handle.model.filaments.get(picked);
      // Measured in VIEWPORT space, because the ribbon half-width is a pixel
      // quantity while filament control points are world coordinates -- comparing
      // the two directly is a unit error, and at this world scale one world unit is
      // well under a pixel.
      //
      // Measured against the picking CELL rather than the queried point. Sigma
      // renders the picking pass at half the CSS width and height, so one picking
      // pixel answers for a 2x2 block of CSS pixels: the identity returned is the
      // one rasterised for the cell, not for the exact point asked about. Requiring
      // the returned edge to cover the unquantised point therefore fails a correct
      // renderer whenever the edge reaches the cell without reaching that point --
      // measured, on the near-coincident pair OG-CAP-11-2 recorded. The property
      // that IS true of the instrument is kept and is still falsifiable: picking
      // must never return an edge that does not reach the cell it answered for.
      const pickedGeometry = picked === null || pickedFilament === undefined
        ? undefined
        : viewportFilament(pickedFilament, auditor);
      const covers = picked === null || pickedGeometry === undefined
        ? false
        : denseDistanceToFilament(
            pickedGeometry,
            pickingCellForPoint(auditor, { ...point, z: 0 }).centre,
          ).distancePx <= pickingRadiusPx(auditor, picked);
      return { edgeId: picked, point, pickedCoversPoint: covers, onScreen };
    },
    unambiguousParameters(edgeId): readonly number[] {
      return unambiguousParametersFor(requiredHandle(product), requiredSigma(picking), edgeId);
    },
    coincidentPartners(edgeId): readonly string[] | null {
      return coincidentPartnersFor(requiredHandle(product), requiredSigma(picking), edgeId);
    },
    pickChord(edgeId): PickWitness {
      const handle = requiredHandle(product);
      const auditor = requiredSigma(picking);
      const filament = handle.model.filaments.get(edgeId);
      if (filament === undefined) {
        throw new Error(`unknown edge ${edgeId}`);
      }
      const source = auditor.graphToViewport(filament.source);
      const target = auditor.graphToViewport(filament.target);
      const point = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
      const privateSigma = auditor as unknown as { getEdgeAtPoint(x: number, y: number): string | null };
      return { edgeId: privateSigma.getEdgeAtPoint(point.x, point.y), point };
    },
    async pickStraightControl(): Promise<string | null> {
      const controlContainer = document.createElement("div");
      controlContainer.style.cssText = "width:960px;height:640px;position:fixed;left:-2000px;top:0";
      document.body.append(controlContainer);
      const graph = new MultiDirectedGraph();
      graph.addNode("left", { x: 0, y: 0, size: 6, color: "#ffffff", label: "", zIndex: 0 });
      graph.addNode("right", { x: 1, y: 0, size: 6, color: "#ffffff", label: "", zIndex: 0 });
      graph.addEdgeWithKey("straight-control", "left", "right", { size: 4, color: "#ffffff", type: "filament", curvature: 0, label: "", zIndex: 0 });
      const control = new Sigma(graph, controlContainer, {
        defaultEdgeType: "filament",
        edgeProgramClasses: { filament: FilamentProgram },
        enableEdgeEvents: true,
      });
      await nextPaint();
      await nextPaint();
      const point = control.graphToViewport({ x: 0.5, y: 0 });
      const privateSigma = control as unknown as { getEdgeAtPoint(x: number, y: number): string | null };
      const picked = privateSigma.getEdgeAtPoint(point.x, point.y);
      control.kill();
      controlContainer.remove();
      return picked;
    },
    async showEmptyGraphControl(): Promise<void> {
      emptyControl?.destroy();
      emptyContainer?.remove();
      const control = document.createElement("div");
      control.id = "evidence-empty-renderer";
      control.style.cssText = "width:960px;height:640px;position:fixed;left:0;top:0;background:#111827";
      document.body.append(control);
      await waitForNonZeroBox(control);
      emptyContainer = control;
      emptyControl = mount(control, EMPTY_VISUAL_GRAPH, options);
      await nextPaint();
      await nextPaint();
    },
    hideEmptyGraphControl(): void {
      emptyControl?.destroy();
      emptyContainer?.remove();
      emptyControl = undefined;
      emptyContainer = undefined;
    },
    async shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }> {
      emptyControl?.destroy();
      emptyContainer?.remove();
      emptyControl = undefined;
      emptyContainer = undefined;
      product?.destroy();
      picking?.kill();
      product = undefined;
      picking = undefined;
      await nextPaint();
      // Arm only after teardown's own frames have settled, so cancelled frames are
      // never counted and only genuine post-destroy animation is. The settling
      // waits use the NATIVE scheduler: nextPaint() goes through the counting
      // wrapper, so waiting with it made the probe count its own three frames and
      // report exactly 3 every run.
      armFrameCounter();
      await settleUncounted();
      await settleUncounted();
      await settleUncounted();
      return { canvases: container.querySelectorAll("canvas").length, framesAfterShutdown: firedSinceArming() };
    },
  };

  await remount();
  window.__evidence = { ...api, ready: true };
}

function renderWitness(container: HTMLElement): RenderWitness {
  const canvases = [...container.querySelectorAll("canvas")];
  const box = container.getBoundingClientRect();
  const layers = canvases.map((canvas) => ({
    name: [...canvas.classList].find((name) => name.startsWith("sigma-")) ?? "unidentified",
    width: canvas.width,
    height: canvas.height,
  }));
  return {
    cssWidth: box.width,
    cssHeight: box.height,
    devicePixelRatio: window.devicePixelRatio,
    canvasCount: canvases.length,
    backingStorePixels: layers.reduce((total, layer) => total + (layer.width * layer.height), 0),
    layers,
  };
}

function normalAt(source: Coordinates, control: Coordinates, target: Coordinates, parameter: number): { readonly x: number; readonly y: number } {
  const inverse = 1 - parameter;
  const tangentX = (2 * inverse * (control.x - source.x)) + (2 * parameter * (target.x - control.x));
  const tangentY = (2 * inverse * (control.y - source.y)) + (2 * parameter * (target.y - control.y));
  const length = Math.hypot(tangentX, tangentY);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return { x: -tangentY / length, y: tangentX / length };
}

function unambiguousParametersFor(handle: RenderHandle, auditor: Sigma, edgeId: string): readonly number[] {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`unknown edge ${edgeId}`);
  }
  return EDGE_SAMPLE_PARAMETERS.filter((parameter) => coversAlone(handle, auditor, edgeId, filament, parameter));
}

// The picking pass is rasterised at half the CSS width and height, so one picking
// pixel answers for a 2x2 block of CSS pixels -- and the fragment that produced it
// was shaded at that cell's CENTRE, not at the point the caller asked about. So the
// centre is where the GPU's own test was evaluated, and it is the only place an
// analytic model can reproduce it. Measuring at the queried point instead is what
// made the identity check disagree with a correct renderer; requiring the WHOLE
// cell instead is sound but far stricter than the rasteriser, and it left a real
// edge with no testable point at all.
//
// Distances are viewport pixels because the ribbon half-width and the pick
// tolerance are pixel quantities while filament control points are world-space.
// The competitor's own radius decides whether the competitor can claim the cell,
// so it is computed per competitor, and its polyline deviation bound is added in
// the conservative direction: it can only reject candidates, never admit one.
function coversAlone(
  handle: RenderHandle,
  auditor: Sigma,
  edgeId: string,
  filament: FilamentGeometry,
  parameter: number,
): boolean {
  const centre = sampledCellCentre(handle, auditor, filament, parameter);
  if (denseDistanceToFilament(viewportFilament(filament, auditor), centre).distancePx > pickingRadiusPx(auditor, edgeId)) {
    return false;
  }
  return competitorsReaching(handle, auditor, edgeId, centre).length === 0;
}

/** This lists the other edges whose ribbons reach one shaded cell centre and does not read the picking framebuffer. */
function competitorsReaching(
  handle: RenderHandle,
  auditor: Sigma,
  edgeId: string,
  centre: Coordinates,
): readonly string[] {
  const reaching: string[] = [];
  for (const [otherEdgeId, otherFilament] of handle.model.filaments) {
    if (otherEdgeId === edgeId) {
      continue;
    }
    const distance = denseDistanceToFilament(viewportFilament(otherFilament, auditor), centre);
    if (distance.distancePx <= pickingRadiusPx(auditor, otherEdgeId) + distance.deviationBoundPx) {
      reaching.push(otherEdgeId);
    }
  }
  return reaching;
}

/** This locates the cell centre the picking pass shaded for one curve parameter and does not offset from the curve. */
function sampledCellCentre(
  handle: RenderHandle,
  auditor: Sigma,
  filament: FilamentGeometry,
  parameter: number,
): Coordinates {
  const point = auditor.graphToViewport(quadraticPoint(filament, parameter));
  return pickingCellForPoint(auditor, { ...point, z: 0 }).centre;
}

// An edge with no unambiguous cell is only accepted with an analytic certificate:
// model geometry, the live camera transform, and live edge attributes, but no
// rasterised output. At EVERY sampled parameter, the edge's own analytic ribbon
// and at least one other analytic ribbon must reach the picking cell centre, which
// makes the cell ambiguous. If either fails anywhere, the edge is not certified
// and the check fails naming it.
function coincidentPartnersFor(handle: RenderHandle, auditor: Sigma, edgeId: string): readonly string[] | null {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`unknown edge ${edgeId}`);
  }
  const geometry = viewportFilament(filament, auditor);
  const radius = pickingRadiusPx(auditor, edgeId);
  const partners = new Set<string>();
  for (const parameter of EDGE_SAMPLE_PARAMETERS) {
    const centre = sampledCellCentre(handle, auditor, filament, parameter);
    if (denseDistanceToFilament(geometry, centre).distancePx > radius) {
      return null;
    }
    const reaching = competitorsReaching(handle, auditor, edgeId, centre);
    if (reaching.length === 0) {
      return null;
    }
    for (const partner of reaching) {
      partners.add(partner);
    }
  }
  return [...partners].sort();
}

function pickingCellForPoint(sigma: Sigma, point: Coordinates): PickingCell {
  const { pixelRatio, downSizingRatio } = sigma.getRenderParams();
  const livePixelRatio = requiredPositiveNumber(pixelRatio, "picking Sigma pixel ratio");
  const liveDownSizingRatio = requiredPositiveNumber(downSizingRatio, "picking Sigma down-sizing ratio");
  const pickingHeight = requiredPositiveNumber(
    (sigma as unknown as PickingSigmaInternals).webGLContexts.edges.drawingBufferHeight,
    "picking Sigma drawing-buffer height",
  );
  const cellSize = liveDownSizingRatio / livePixelRatio;
  // Sigma's getPixelColor computes bx = floor(x / downSizingRatio * pixelRatio)
  // and by = floor(drawingBufferHeight / downSizingRatio - y / downSizingRatio * pixelRatio).
  // Solving those floor intervals in CSS coordinates gives x in [bx * cellSize,
  // (bx + 1) * cellSize) and, after the y flip, y in ((height / downSizingRatio -
  // by - 1) * cellSize, (height / downSizingRatio - by) * cellSize].
  const bufferX = Math.floor((point.x / liveDownSizingRatio) * livePixelRatio);
  const bufferY = Math.floor(
    (pickingHeight / liveDownSizingRatio) - ((point.y / liveDownSizingRatio) * livePixelRatio),
  );
  const minimumX = bufferX * cellSize;
  const maximumX = (bufferX + 1) * cellSize;
  const minimumY = ((pickingHeight / liveDownSizingRatio) - bufferY - 1) * cellSize;
  const maximumY = ((pickingHeight / liveDownSizingRatio) - bufferY) * cellSize;
  const centreX = (minimumX + maximumX) / 2;
  const centreY = (minimumY + maximumY) / 2;
  return {
    centre: { x: centreX, y: centreY, z: 0 },
    minimumX,
    maximumX,
    minimumY,
    maximumY,
  };
}

function denseDistanceToFilament(geometry: FilamentGeometry, point: Coordinates): DenseFilamentDistance {
  const controlOffset = filamentControlOffsetPx(geometry);
  const segments = denseFilamentSegments(controlOffset);
  let closest = Number.POSITIVE_INFINITY;
  let source = quadraticPoint(geometry, 0);
  for (let index = 1; index <= segments; index += 1) {
    const target = quadraticPoint(geometry, index / segments);
    closest = Math.min(closest, distanceToViewportSegment(point, source, target));
    source = target;
  }
  return {
    distancePx: closest,
    deviationBoundPx: controlOffset / (2 * segments * segments),
  };
}

function filamentControlOffsetPx(geometry: FilamentGeometry): number {
  const midpointX = (geometry.source.x + geometry.target.x) / 2;
  const midpointY = (geometry.source.y + geometry.target.y) / 2;
  return Math.hypot(geometry.control.x - midpointX, geometry.control.y - midpointY);
}

function denseFilamentSegments(controlOffsetPx: number): number {
  let segments = 1;
  // An N-segment quadratic polyline deviates by at most controlOffset / (2 * N²).
  while (
    controlOffsetPx / (2 * segments * segments) > DENSE_FILAMENT_TOLERANCE_PX
    && segments < MAX_DENSE_FILAMENT_SEGMENTS
  ) {
    segments *= 2;
  }
  return segments;
}

function distanceToViewportSegment(point: Coordinates, source: Coordinates, target: Coordinates): number {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const denominator = (deltaX * deltaX) + (deltaY * deltaY);
  if (denominator === 0) {
    return Math.hypot(point.x - source.x, point.y - source.y);
  }
  const projection = ((point.x - source.x) * deltaX) + ((point.y - source.y) * deltaY);
  const parameter = Math.max(0, Math.min(1, projection / denominator));
  return Math.hypot(
    point.x - (source.x + (deltaX * parameter)),
    point.y - (source.y + (deltaY * parameter)),
  );
}

function pickingRadiusPx(sigma: Sigma, edgeId: string): number {
  const { sizeRatio, minEdgeThickness } = sigma.getRenderParams();
  const attributes = sigma.getGraph().getEdgeAttributes(edgeId) as {
    readonly size?: unknown;
    readonly pickTolerancePx?: unknown;
  };
  const edgeWidthPx = requiredNonNegativeNumber(attributes.size, `edge ${edgeId} size`);
  const pickTolerancePx = requiredNonNegativeNumber(attributes.pickTolerancePx, `edge ${edgeId} pick tolerance`);
  const liveSizeRatio = requiredPositiveNumber(sizeRatio, "picking Sigma size ratio");
  const liveMinimumThickness = requiredNonNegativeNumber(minEdgeThickness, "picking Sigma minimum edge thickness");
  // A fixed CSS radius is wrong: each edge's uploaded size is scaled by the live
  // camera ratio before picking, so a competitor can claim a point beyond 3 px.
  // The model uploads baseWidthPx times one morphology width multiplier per 1,000;
  // the shader divides that width by the live sizeRatio, halves it, and adds the
  // calibrated pickTolerancePx. These calibrated lower and upper bounds reject
  // inflated live edge attributes. The shader uses distance < halfThickness while
  // this analytic oracle uses <=, a measure-zero difference at the boundary.
  const calibratedWidthsPx = [
    DEFAULT_CALIBRATION.morphology.stellar.filamentWidthMultiplierPermille,
    DEFAULT_CALIBRATION.morphology.neural.filamentWidthMultiplierPermille,
    DEFAULT_CALIBRATION.morphology.mycelium.filamentWidthMultiplierPermille,
  ].map((widthMultiplierPermille) => (
    (DEFAULT_CALIBRATION.filament.baseWidthPx * widthMultiplierPermille) / 1_000
  ));
  const minimumCalibratedRadiusPx = (
    Math.min(...calibratedWidthsPx) / liveSizeRatio / 2
  ) + DEFAULT_CALIBRATION.filament.pickTolerancePx;
  const maximumCalibratedRadiusPx = (
    Math.max(...calibratedWidthsPx) / liveSizeRatio / 2
  ) + DEFAULT_CALIBRATION.filament.pickTolerancePx;
  const radiusPx = (Math.max(liveMinimumThickness, edgeWidthPx / liveSizeRatio) / 2) + pickTolerancePx;
  if (radiusPx < minimumCalibratedRadiusPx || radiusPx > maximumCalibratedRadiusPx) {
    throw new Error(
      `edge ${edgeId} picking radius ${radiusPx}px is outside calibrated bounds [${minimumCalibratedRadiusPx}px, ${maximumCalibratedRadiusPx}px]`,
    );
  }
  return radiusPx;
}

function requiredPositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function requiredNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function viewportFilament(filament: FilamentGeometry, sigma: Sigma): FilamentGeometry {
  return {
    source: { ...sigma.graphToViewport(filament.source), z: 0 },
    control: { ...sigma.graphToViewport(filament.control), z: 0 },
    target: { ...sigma.graphToViewport(filament.target), z: 0 },
    curvature: filament.curvature,
  };
}

function semanticProjectionCanonical(graph: VisualGraph): string {
  return new TextDecoder().decode(canonicalBytes({
    schema_version: graph.schema_version,
    policy_id: graph.policy_id,
    question: {
      valid_at: graph.question.valid_at,
      recorded_as_of: graph.question.recorded_as_of,
    },
    nodes: graph.nodes
      .map((node) => ({ id: node.id, kind: node.kind, semantic: readSemantic(node.semantic) }))
      .sort(compareIds),
    edges: graph.edges
      .map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        semantic: readSemantic(edge.semantic),
      }))
      .sort(compareIds),
  }));
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

async function waitForNonZeroBox(container: HTMLElement): Promise<void> {
  for (let frame = 0; frame < 180; frame += 1) {
    const box = container.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return;
    }
    await nextPaint();
  }
  throw new Error("renderer container never acquired a non-zero box");
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function requiredGraph(graphs: ReadonlyMap<Policy, VisualGraph>, policy: Policy): VisualGraph {
  const graph = graphs.get(policy);
  if (graph === undefined) {
    throw new Error(`missing ${policy} graph`);
  }
  return graph;
}

function requiredHandle(handle: RenderHandle | undefined): RenderHandle {
  if (handle === undefined) {
    throw new Error("renderer has not mounted");
  }
  return handle;
}

function requiredSigma(sigma: Sigma | undefined): Sigma {
  if (sigma === undefined) {
    throw new Error("picking surface has not mounted");
  }
  return sigma;
}

/** This frames the complete Discovery universe once and does not fit a policy subset. */
function framingBoxFor(graph: VisualGraph): RenderFramingBox {
  const anchors = [...layoutAnchors(graph).values()];
  if (anchors.length === 0) {
    throw new Error("a shared framing graph requires anchors");
  }
  return {
    x: [
      Math.min(...anchors.map((anchor) => anchor.x)),
      Math.max(...anchors.map((anchor) => anchor.x)),
    ],
    y: [
      Math.min(...anchors.map((anchor) => anchor.y)),
      Math.max(...anchors.map((anchor) => anchor.y)),
    ],
  };
}

function failedApi(): EvidenceApi {
  const unavailable = (): never => {
    throw new Error("evidence boot failed");
  };
  return {
    ready: false,
    errors,
    checks,
    switchPolicy: async () => unavailable(),
    switchMorphology: async () => unavailable(),
    switchOrganization: async () => unavailable(),
    setLodBand: async () => unavailable(),
    setLodZoom: async () => unavailable(),
    setReducedMotion: async () => unavailable(),
    selectNode: async () => unavailable(),
    read: unavailable,
    pick: unavailable,
    unambiguousParameters: unavailable,
    coincidentPartners: unavailable,
    pickChord: unavailable,
    pickStraightControl: async () => unavailable(),
    showEmptyGraphControl: async () => unavailable(),
    hideEmptyGraphControl: unavailable,
    shutdown: async () => unavailable(),
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
