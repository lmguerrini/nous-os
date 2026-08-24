// MUST be first: installs the frame counter before any renderer module evaluates.
import { armFrameCounter, firedSinceArming, settleUncounted } from "#browser/frame-counter.ts";
import Sigma from "sigma";
import { MultiDirectedGraph } from "graphology";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, Semantic, VisualGraph } from "#engine/contract.ts";
import { resolveLodBand } from "#engine/lod.ts";
import type { LodBand } from "#engine/lod.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { mount, readCameraState, restoreCameraState } from "#render2d/index.ts";
import { FilamentProgram } from "#render2d/filament-program.ts";
import { quadraticPoint } from "#render2d/geometry.ts";
import type { RenderCameraState, RenderHandle } from "#render2d/index.ts";
import type { RenderOptions as ModelRenderOptions } from "#render2d/model.ts";

type Policy = "Reliability" | "Discovery";

type FixtureFacts = {
  readonly nodes: number;
  readonly edges: number;
  readonly sha256: string;
};

type PixelWitness = {
  readonly canvasCount: number;
  readonly nonTransparentPixels: number;
  readonly colouredPixels: number;
};

type PickWitness = {
  readonly edgeId: string | null;
  readonly point: { readonly x: number; readonly y: number };
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
  readonly windows: readonly { readonly id: string; readonly members: readonly string[]; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, FixtureFacts>>;
  readonly pixels: PixelWitness;
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
  pickChord(edgeId: string): PickWitness;
  pickStraightControl(): Promise<string | null>;
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

const errors: string[] = [];
const checks: string[] = [];
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
    const graph = browserProjectionAdapter(payload);
    const fixture = payload as { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] };
    return [policy as Policy, graph, {
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      sha256: await sha256(text),
    }] as const;
  }));
  const graphs = new Map<Policy, VisualGraph>();
  const fixtureFacts: Record<string, FixtureFacts> = {};
  for (const [policy, graph, facts] of loaded) {
    graphs.set(policy, graph);
    fixtureFacts[policy] = facts;
  }
  checks.push("governed fixtures fetched from the served root");

  let policy: Policy = "Discovery";
  let selectedNode: string | null = null;
  let product: RenderHandle | undefined;
  let picking: Sigma | undefined;

  const remount = async (cameraState?: RenderCameraState): Promise<void> => {
    product?.destroy();
    picking?.kill();
    product = undefined;
    picking = undefined;
    await waitForNonZeroBox(container);
    const graph = requiredGraph(graphs, policy);
    product = mount(container, graph, options);
    // This separate surface is the actual Sigma edge-picking framebuffer.  The
    // product mount remains the surface inspected for rendered pixels.
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
    const auditor = requiredSigma(picking);
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, anchor] of handle.model.anchors) {
      const point = auditor.graphToViewport(anchor);
      positions[id] = { x: point.x, y: point.y };
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
      windows: handle.model.windows.map((window) => ({ id: window.id, members: window.members, bounds: window.bounds })),
      rejectionBounds: handle.model.organization.rejectionBounds,
      fixtureFacts,
      pixels: renderedPixels(container),
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
      const privateSigma = auditor as unknown as { getEdgeAtPoint(x: number, y: number): string | null };
      return { edgeId: privateSigma.getEdgeAtPoint(point.x, point.y), point };
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
    async shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }> {
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

function renderedPixels(container: HTMLElement): PixelWitness {
  const canvases = [...container.querySelectorAll("canvas")];
  let nonTransparentPixels = 0;
  let colouredPixels = 0;
  for (const canvas of canvases) {
    const sensor = document.createElement("canvas");
    sensor.width = canvas.width;
    sensor.height = canvas.height;
    const context = sensor.getContext("2d", { willReadFrequently: true });
    if (context === null || sensor.width === 0 || sensor.height === 0) {
      continue;
    }
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, sensor.width, sensor.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha !== 0) {
        nonTransparentPixels += 1;
      }
      if (alpha !== 0 && (red !== 0 || green !== 0 || blue !== 0)) {
        colouredPixels += 1;
      }
    }
  }
  return { canvasCount: canvases.length, nonTransparentPixels, colouredPixels };
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
    pickChord: unavailable,
    pickStraightControl: async () => unavailable(),
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

/**
 * This is the browser-safe execution of the adapter's visual boundary.  The
 * production adapter's top-level canonical SHA-256 import is Node-only, while
 * the visual mapping below is the same adapter mapping and deliberately keeps
 * opaque semantic values unreadable by the renderer.
 */
function browserProjectionAdapter(payload: unknown): VisualGraph {
  const wire = payload as {
    readonly schema_version: string;
    readonly policy_id: string;
    readonly question: { readonly valid_at: string | null; readonly recorded_as_of: string | null };
    readonly nodes: readonly { readonly id: string; readonly kind: string }[];
    readonly edges: readonly { readonly id: string; readonly kind: string; readonly source: string; readonly target: string }[];
  };
  if (!Array.isArray(wire.nodes) || !Array.isArray(wire.edges)) {
    throw new TypeError("projection payload has no node or edge arrays");
  }
  return {
    schema_version: wire.schema_version,
    policy_id: wire.policy_id,
    question: { valid_at: wire.question.valid_at, recorded_as_of: wire.question.recorded_as_of },
    nodes: wire.nodes.slice().sort(compareId).map((node, index) => ({
      id: node.id,
      kind: node.kind,
      semantic: Object.freeze({}) as Semantic,
      derived: { value: null, origin: "projection-adapter" },
      visual: visualMetadata(node.kind, index),
    })),
    edges: wire.edges.slice().sort(compareId).map((edge, index) => ({
      id: edge.id,
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
      semantic: Object.freeze({}) as Semantic,
      derived: { value: null, origin: "projection-adapter" },
      visual: visualMetadata(edge.kind, index),
    })),
  };
}

function visualMetadata(role: string, index: number): VisualGraph["nodes"][number]["visual"] {
  return {
    role,
    anchor: { x: index, y: 0, z: 0 },
    path: [{ x: index, y: 0, z: 0 }],
    lod: { minimum: 0, maximum: 1 },
    label_priority: 0,
  };
}

function compareId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
