import { armFrameCounter, firedSinceArming, settleUncounted } from "#browser/frame-counter.ts";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { createEngineGraphView, type VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { MACRO, MESO, MICRO, resolvedMaterial } from "#engine/lod.ts";
import { buildScene } from "#scene/build.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { mount as mountSigma } from "#render2d/index.ts";
import type { RenderHandle } from "#render2d/index.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { mount as mountThree } from "#render3f/mount.tsx";
import type { GraphRendererHandle, MultiCameraRendererHandle,
  ResourceCountingRendererHandle, RetainedResourceWitness } from "#engine/renderer-handle.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";
import {
  PERFORMANCE_VIEWPORT,
  SOFTWARE_RASTERISATION_LABEL,
  WARMUP_FRAMES,
  notRunPerformanceRecord,
  type Distribution,
  type MemoryUsage,
  type MemoryValue,
  type PerformanceCombination,
  type PerformanceMeasurements,
  type PerformanceRecord,
  type PerformanceScale,
  type ProgressiveBand,
  type ProgressiveValue,
  type Measurement,
} from "#browser/performance-contract.ts";

const FRAME_SAMPLES = 60;
const LATENCY_SAMPLES = 3;
const PICK_SAMPLES = 24;
const PROGRESSIVE_BANDS = [MACRO, MESO, MICRO] as const;

type RendererDefinition = {
  readonly name: PerformanceRecord["renderer"];
  readonly cameraKind: CameraKind;
  readonly mount: (container: HTMLElement, graph: VisualGraph, options: RenderOptions, state: VisualState) => GraphRendererHandle;
};

type Fixture = {
  readonly file: string;
  readonly scale: PerformanceScale;
  readonly graph: VisualGraph;
};

type FixtureLoad = {
  readonly file: string;
  readonly scale: PerformanceScale;
  readonly graph: VisualGraph | null;
  readonly error: string | null;
};

type FrameResult = {
  readonly timestamps: readonly number[];
  readonly fired: number;
};

declare global {
  interface Window {
    __performance?: PerformancePageApi;
  }
}

type PerformancePageApi = {
  readonly run: (combination: PerformanceCombination, observedCommitSha: string) => Promise<PerformanceRecord>;
};

const options: RenderOptions = {
  morphology: "stellar",
  organization: "indra",
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: MICRO,
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
  calibration: DEFAULT_CALIBRATION,
};

const rendererDefinitions: readonly RendererDefinition[] = [
  {
    name: "sigma-2d",
    cameraKind: ORTHOGRAPHIC,
    mount: (container, graph, renderOptions, state) => adaptSigmaHandle(mountSigma(container, graph, renderOptions, undefined, state)),
  },
  {
    name: "r3f-2d",
    cameraKind: ORTHOGRAPHIC,
    mount: (container, graph, renderOptions, state) => mountThree(container, graph, renderOptions, undefined, state),
  },
  {
    name: "r3f-3d",
    cameraKind: PERSPECTIVE,
    mount: (container, graph, renderOptions, state) => mountThree(container, graph, renderOptions, undefined, state),
  },
];

/** This installs the page runner and does not start a measurement until the spec supplies a commit SHA. */
export function installPerformancePage(): void {
  window.__performance = { run: runPerformance };
}

async function runPerformance(combination: PerformanceCombination, observedCommitSha: string): Promise<PerformanceRecord> {
  const renderer = rendererDefinitions.find((definition) => definition.name === combination.renderer);
  if (renderer === undefined) {
    throw new Error(`unknown renderer ${combination.renderer}`);
  }
  const fixture = await loadFixture(combination);
  const container = createContainer();
  try {
    if (fixture.graph === null) {
      return unavailableRecord(renderer, fixture, observedCommitSha);
    }
    const modelCosts = measureModelCosts(fixture.graph, ORTHOGRAPHIC);
    return await measureRecord(renderer, { file: fixture.file, scale: fixture.scale, graph: fixture.graph }, container, observedCommitSha, modelCosts);
  } finally {
    container.remove();
  }
}

async function loadFixture(combination: PerformanceCombination): Promise<FixtureLoad> {
  try {
    const response = await fetch(["fixtures", "synthetic", "projection", "stress", combination.fixture].join("/"), { cache: "no-store" });
    if (!response.ok) {
      return { file: combination.fixture, scale: combination.scale, graph: null, error: `fixture failed with ${response.status}` };
    }
    return { file: combination.fixture, scale: combination.scale, graph: toVisualGraph(JSON.parse(await response.text()) as unknown), error: null };
  } catch (error: unknown) {
    return { file: combination.fixture, scale: combination.scale, graph: null, error: errorMessage(error) };
  }
}

/** This narrows a handle to one that can enumerate its own graphics resources and does not assume a renderer can. */
function resourceCountingHandle(handle: GraphRendererHandle): ResourceCountingRendererHandle | null {
  const candidate = handle as { readonly readRetainedResources?: unknown };
  return typeof candidate.readRetainedResources === "function" ? handle as ResourceCountingRendererHandle : null;
}

function unavailableRecord(
  renderer: RendererDefinition,
  fixture: FixtureLoad,
  observedCommitSha: string,
): PerformanceRecord {
  const reason = `fixture ${fixture.file} did not load: ${fixture.error ?? "unknown fixture failure"}`;
  return notRunPerformanceRecord(
    { renderer: renderer.name, scale: fixture.scale, fixture: fixture.file },
    observedCommitSha,
    window.devicePixelRatio,
    reason,
  );
}

/** This narrows a handle to one that can switch camera and does not assume a renderer can. */
function multiCameraHandle(handle: GraphRendererHandle): MultiCameraRendererHandle | null {
  const candidate = handle as { readonly setCameraKind?: unknown };
  return typeof candidate.setCameraKind === "function" ? handle as MultiCameraRendererHandle : null;
}

function adaptSigmaHandle(handle: RenderHandle): GraphRendererHandle {
  return {
    ...handle,
    // Sigma has one camera and no `setCameraKind`. That is not an omission: the ability lives on
    // MultiCameraRendererHandle, so a renderer that cannot switch simply does not claim it, and the
    // switch measurement records NOT_RUN rather than timing a call that never happened.
    cameraKind: ORTHOGRAPHIC,
    readNodeFootprintWitnesses: handle.readGlowWitnesses,
    // No `readRetainedResources` either. Sigma's WebGL resources are owned inside the graph library
    // and are not enumerable from outside it, so this renderer does not claim the capability and the
    // memory measurement records UNKNOWN for it rather than a number nobody read.
  };
}

function createContainer(): HTMLElement {
  const shell = document.createElement("main");
  shell.style.cssText = `width:${PERFORMANCE_VIEWPORT.width}px;height:${PERFORMANCE_VIEWPORT.height}px;position:relative`;
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;position:relative";
  shell.append(container);
  document.body.replaceChildren(shell);
  return container;
}

async function measureRecord(
  renderer: RendererDefinition,
  fixture: Fixture,
  container: HTMLElement,
  observedCommitSha: string,
  modelCosts: ModelCosts | null,
): Promise<PerformanceRecord> {
  const base = {
    renderer: renderer.name,
    scale: fixture.scale,
    fixture: fixture.file,
    syntheticFixture: true as const,
    rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
    elementCounts: {
      fixtureNodes: fixture.graph.nodes.length,
      fixtureEdges: fixture.graph.edges.length,
      renderedNodes: "NOT_RUN" as const,
      renderedEdges: "NOT_RUN" as const,
    },
    devicePixelRatio: window.devicePixelRatio,
    viewport: PERFORMANCE_VIEWPORT,
    observedCommitSha,
    warmup: { framesExcluded: WARMUP_FRAMES, reason: "Warm-up frames let browser and renderer scheduling settle; they are excluded from all timed frame distributions." },
  };
  if (modelCosts === null) {
    return {
      ...base,
      measurements: notRunMeasurements("scene-model timing failed before renderer mount"),
      error: "scene-model timing failed before renderer mount",
    };
  }

  let handle: GraphRendererHandle | undefined;
  let initialRender: Measurement<Distribution>;
  try {
    const state = initialState(fixture.graph, renderer.cameraKind);
    const start = performance.now();
    const mounted = renderer.mount(container, fixture.graph, options, state);
    handle = mounted;
    const firstPaint = await firstPaintContainingGraph(mounted, start);
    initialRender = pass(distribution([firstPaint]), "initial render latency is mount start to first RAF with a non-empty renderer surface");
  } catch (error: unknown) {
    handle?.destroy();
    const reason = `renderer failed to reach ${fixture.scale}: ${errorMessage(error)}`;
    return {
      ...base,
      measurements: {
        ...notRunMeasurements(reason),
        layoutCost: modelCosts.layoutCost,
        sceneModelBuildCost: modelCosts.sceneModelBuildCost,
      },
      error: reason,
    };
  }
  if (handle === undefined) {
    throw new Error("renderer mount returned no handle");
  }

  const surface = safeSurface(handle);
  const renderedCounts = surface === null
    ? base.elementCounts
    : { ...base.elementCounts, renderedNodes: surface.nodeIds.length, renderedEdges: surface.edgeIds.length };
  const measurements: PerformanceMeasurements = {
    frameTime: await measureFrameTime(handle),
    initialRenderLatency: initialRender,
    layoutCost: modelCosts.layoutCost,
    sceneModelBuildCost: modelCosts.sceneModelBuildCost,
    interactionLatency: await measureInteraction(handle, fixture.graph),
    pickingLatency: measurePicking(handle, fixture.graph),
    memory: measureMemory(handle),
    cameraTransitionCost: renderer.name === "r3f-3d" ? await measureCameraTransition(handle) : notRun("orbit/dolly transition is only defined for r3f-3d"),
    cameraSwitchCost: await measureCameraSwitch(handle),
    progressiveDisclosure: notRun("progressive disclosure is measured after the base handle is released"),
  };
  handle.destroy();
  return {
    ...base,
    elementCounts: renderedCounts,
    measurements: { ...measurements, progressiveDisclosure: await measureProgressiveDisclosure(renderer, fixture, container) },
  };
}

type ModelCosts = {
  readonly layoutCost: Measurement<Distribution>;
  readonly sceneModelBuildCost: Measurement<Distribution>;
};

function measureModelCosts(graph: VisualGraph, cameraKind: CameraKind): ModelCosts | null {
  try {
    const layoutSamples: number[] = [];
    const buildSamples: number[] = [];
    const state = initialState(graph, cameraKind);
    for (let sample = 0; sample < LATENCY_SAMPLES; sample += 1) {
      const { graph: engineGraph } = createEngineGraphView(graph);
      const layoutStart = performance.now();
      layoutAnchors(engineGraph, DEFAULT_CALIBRATION);
      layoutSamples.push(performance.now() - layoutStart);
      const buildStart = performance.now();
      buildScene(graph, state, DEFAULT_CALIBRATION, cameraKind);
      buildSamples.push(performance.now() - buildStart);
    }
    return {
      layoutCost: pass(distribution(layoutSamples), "layoutAnchors is timed separately from scene construction and painting"),
      sceneModelBuildCost: pass(distribution(buildSamples), "buildScene is timed as shared renderer-neutral scene-model work"),
    };
  } catch {
    return null;
  }
}

async function measureFrameTime(handle: GraphRendererHandle): Promise<Measurement<Distribution>> {
  try {
    for (let index = 0; index < WARMUP_FRAMES; index += 1) {
      await settleUncounted();
    }
    armFrameCounter();
    const result = await collectFrames(FRAME_SAMPLES + 1);
    if (result.fired < FRAME_SAMPLES + 1 || result.timestamps.length < FRAME_SAMPLES + 1) {
      return notRun(`frame counter fired ${result.fired} frames; ${FRAME_SAMPLES + 1} were required`);
    }
    const samples = result.timestamps.slice(1).map((timestamp, index) => timestamp - (result.timestamps[index] ?? timestamp));
    return pass(distribution(samples), "frame intervals use the existing frame counter after five uncounted warm-up frames");
  } catch (error: unknown) {
    return notRun(`frame timing did not run: ${errorMessage(error)}`);
  }
}

async function collectFrames(count: number): Promise<FrameResult> {
  const timestamps: number[] = [];
  await new Promise<void>((resolve) => {
    const next = (timestamp: number): void => {
      timestamps.push(timestamp);
      if (timestamps.length >= count) {
        resolve();
        return;
      }
      window.requestAnimationFrame(next);
    };
    window.requestAnimationFrame(next);
  });
  return { timestamps, fired: firedSinceArming() };
}

async function firstPaintContainingGraph(handle: GraphRendererHandle, start: number): Promise<number> {
  let consecutiveBlankFrames = 0;
  let lastCanvasImage: PixelImage | undefined;
  for (let frame = 0; frame < 180; frame += 1) {
    await nextPaint();
    const surface = safeSurface(handle);
    const canvas = document.querySelector("canvas");
    if (surface !== null && surface.nodeIds.length + surface.edgeIds.length > 0 && canvas !== null && canvas.width > 0 && canvas.height > 0 && canvasFingerprint().length > 0) {
      const image = await canvasPixelImage(canvas);
      try {
        assertLitPixelFloor(image, "performance first-paint canvas");
        return performance.now() - start;
      } catch {
        consecutiveBlankFrames += 1;
        lastCanvasImage = image;
        if (consecutiveBlankFrames >= 3) {
          assertLitPixelFloor(image, "performance first-paint canvas");
        }
      }
    }
  }
  if (lastCanvasImage !== undefined) {
    assertLitPixelFloor(lastCanvasImage, "performance first-paint canvas");
  }
  throw new Error("no painted frame containing graph content");
}

async function canvasPixelImage(canvas: HTMLCanvasElement): Promise<PixelImage> {
  const response = await fetch(canvas.toDataURL("image/png"));
  const bitmap = await createImageBitmap(await response.blob());
  const copy = document.createElement("canvas");
  copy.width = bitmap.width;
  copy.height = bitmap.height;
  const context = copy.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error("performance first-paint canvas cannot be read as pixels");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: copy.width, height: copy.height, data: context.getImageData(0, 0, copy.width, copy.height).data };
}

async function measureInteraction(handle: GraphRendererHandle, graph: VisualGraph): Promise<Measurement<Distribution>> {
  const ids = graph.nodes.slice(0, LATENCY_SAMPLES).map((node) => node.id);
  if (ids.length === 0) {
    return notRun("fixture has no nodes to select");
  }
  try {
    const samples: number[] = [];
    for (const id of ids) {
      await settleUncounted();
      const before = canvasFingerprint();
      const start = performance.now();
      handle.setSelection(id);
      let changed = false;
      for (let frame = 1; frame <= 12; frame += 1) {
        await nextPaint();
        if (canvasFingerprint() !== before) {
          samples.push(performance.now() - start);
          changed = true;
          break;
        }
      }
      handle.clearSelection();
      await settleUncounted();
      if (!changed) {
        return notRun(`selection of ${id} produced no observed pixel change within 12 frames`);
      }
    }
    return pass(distribution(samples), "selection start to the first RAF whose canvas fingerprint differs from the settled baseline");
  } catch (error: unknown) {
    return notRun(`interaction timing did not run: ${errorMessage(error)}`);
  }
}

function measurePicking(handle: GraphRendererHandle, graph: VisualGraph): Measurement<Distribution> {
  const points = graph.nodes.slice(0, PICK_SAMPLES).map((node) => ({ x: node.visual.anchor.x, y: node.visual.anchor.y, z: node.visual.anchor.z, kind: "node" as const }));
  const edgePoints = graph.edges.slice(0, PICK_SAMPLES).map((edge) => {
    const point = edge.visual.path[Math.floor(edge.visual.path.length / 2)] ?? edge.visual.anchor;
    return { x: point.x, y: point.y, z: point.z, kind: "edge" as const };
  });
  const samples: number[] = [];
  try {
    for (const point of [...points, ...edgePoints].slice(0, PICK_SAMPLES)) {
    const viewport = handle.graphToViewport({ x: point.x, y: point.y, z: point.z });
      const start = performance.now();
      if (point.kind === "node") {
        handle.pickNodeAtPosition(viewport);
      } else {
        handle.pickEdgeAtPoint(viewport.x, viewport.y);
      }
      samples.push(performance.now() - start);
    }
    if (samples.length === 0) {
      return notRun("fixture has no positions to pick");
    }
    return pass(distribution(samples), "synchronous node and edge picking calls over a fixed sample of projected fixture positions");
  } catch (error: unknown) {
    return notRun(`picking timing did not run: ${errorMessage(error)}`);
  }
}

function measureMemory(handle: GraphRendererHandle): Measurement<MemoryValue> {
  const browserMemory = browserMemoryMeasurement();
  let retainedResources: Measurement<RetainedResourceWitness>;
  const counting = resourceCountingHandle(handle);
  if (counting === null) {
    retainedResources = unknown("this renderer does not enumerate its own graphics resources, so none were read");
  } else {
    try {
      retainedResources = pass(counting.readRetainedResources(), "renderer-owned retained resources read from the renderer handle");
    } catch (error: unknown) {
      retainedResources = unknown(`renderer retained-resource witness unavailable: ${errorMessage(error)}`);
    }
  }
  return pass({ browserMemory, retainedResources }, "browser heap and renderer-owned resources are recorded independently");
}

async function measureCameraTransition(handle: GraphRendererHandle): Promise<Measurement<Distribution>> {
  try {
    const before = handle.readCameraState();
    const target = { ...before, angle: before.angle + 0.25, ratio: before.ratio * 0.92 };
    const samples: number[] = [];
    for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
      const start = performance.now();
      handle.restoreCameraState(target);
      await nextPaint();
      samples.push(performance.now() - start);
      handle.restoreCameraState(before);
      await settleUncounted();
    }
    return pass(distribution(samples), "r3f-3d orbit/dolly proxy restores an angle and dolly ratio and ends at the first painted frame");
  } catch (error: unknown) {
    return notRun(`r3f-3d camera transition did not run: ${errorMessage(error)}`);
  }
}

async function measureCameraSwitch(handle: GraphRendererHandle): Promise<Measurement<Distribution>> {
  const target = handle.cameraKind === ORTHOGRAPHIC ? PERSPECTIVE : ORTHOGRAPHIC;
  try {
    const switchable = multiCameraHandle(handle);
    if (switchable === null) {
      return notRun("this renderer exposes one camera and cannot switch, so there is nothing to time");
    }
    const samples: number[] = [];
    for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
      const start = performance.now();
      switchable.setCameraKind(target);
      await nextPaint();
      if (switchable.cameraKind !== target) {
        return notRun(`setCameraKind did not expose the requested ${target} camera`);
      }
      samples.push(performance.now() - start);
      switchable.setCameraKind(switchable.cameraKind === ORTHOGRAPHIC ? PERSPECTIVE : ORTHOGRAPHIC);
      await settleUncounted();
    }
    return pass(distribution(samples), "setCameraKind to the alternate camera through the first painted frame");
  } catch (error: unknown) {
    return notRun(`2D↔3D camera switch did not run: ${errorMessage(error)}`);
  }
}

async function measureProgressiveDisclosure(
  renderer: RendererDefinition,
  fixture: Fixture,
  container: HTMLElement,
): Promise<Measurement<ProgressiveValue>> {
  let scene: ReturnType<typeof buildScene>;
  try {
    scene = buildScene(fixture.graph, initialState(fixture.graph, renderer.cameraKind), DEFAULT_CALIBRATION, renderer.cameraKind);
  } catch (error: unknown) {
    return notRun(`progressive disclosure scene resolution did not run: ${errorMessage(error)}`);
  }
  const aggregationForcedBand = scene.aggregates.length > 0 ? MACRO : null;
  const bands: ProgressiveBand[] = [];
  for (const band of PROGRESSIVE_BANDS) {
    const bandOptions = { ...options, lodBand: band };
    let handle: GraphRendererHandle | undefined;
    try {
      const state = initialState(fixture.graph, renderer.cameraKind, band);
      const start = performance.now();
      handle = renderer.mount(container, fixture.graph, bandOptions, state);
      const latency = await firstPaintContainingGraph(handle, start);
      const surface = safeSurface(handle);
      bands.push({
        band,
        aggregationMaterial: resolvedMaterial(band).aggregate,
        aggregateCount: pass(scene.aggregates.length, "resolved scene aggregate count for this explicit LOD band"),
        mountToFirstPaint: pass(distribution([latency]), "LOD-band mount to first painted graph frame"),
        renderedElementCounts: surface === null
          ? notRun("renderer surface witness unavailable for this LOD band")
          : pass({ nodes: surface.nodeIds.length, edges: surface.edgeIds.length }, "live surface witness count after this LOD band mount"),
      });
    } catch (error: unknown) {
      bands.push({
        band,
        aggregationMaterial: resolvedMaterial(band).aggregate,
        aggregateCount: pass(scene.aggregates.length, "resolved scene aggregate count for this failed LOD-band attempt"),
        mountToFirstPaint: notRun(`LOD band ${band} failed: ${errorMessage(error)}`),
        renderedElementCounts: notRun(`LOD band ${band} failed before a surface witness was available`),
      });
    } finally {
      handle?.destroy();
    }
  }
  return pass({
    aggregationForcedAtScale: aggregationForcedBand === null ? null : fixture.scale,
    aggregationForcedBand,
    aggregationCriterion: "aggregation is reported when the scene has aggregate records and the explicit macro band exposes aggregate material; no automatic scale threshold is inferred",
    bands,
  }, "explicit macro, meso, and micro mounts measure progressive-disclosure cost without changing fixture topology");
}

function browserMemoryMeasurement(): Measurement<MemoryUsage> {
  type MemoryPerformance = Performance & { readonly memory?: MemoryUsage & { readonly usedJSHeapSize: number; readonly totalJSHeapSize: number; readonly jsHeapSizeLimit: number } };
  const memory = (performance as MemoryPerformance).memory;
  if (memory === undefined) {
    return unknown("Chromium performance.memory is not exposed in this browser context");
  }
  return pass({
    usedJsHeapSize: memory.usedJSHeapSize,
    totalJsHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  }, "Chromium performance.memory heap reading");
}

/**
 * The LOD band is a parameter, because the progressive-disclosure measurement varies it.
 *
 * It used to read the module-level `options` constant, which is fixed at MICRO. The band loop
 * overrode `RenderOptions.lodBand` and left `VisualState.lodBand` at micro, so the three "bands" were
 * three micro states with an options field changing underneath — the measurement never varied what
 * it claimed to vary. The Three renderers then painted an entirely black canvas at macro on that
 * inconsistent pair and were recorded NOT_RUN, which was published as governed truth.
 */
function initialState(graph: VisualGraph, cameraKind: CameraKind, lodBand: RenderOptions["lodBand"] = options.lodBand) {
  const anchors = [...layoutAnchors(createEngineGraphView(graph).graph, DEFAULT_CALIBRATION).values()];
  const minimumX = Math.min(...anchors.map((anchor) => anchor.x));
  const maximumX = Math.max(...anchors.map((anchor) => anchor.x));
  const minimumY = Math.min(...anchors.map((anchor) => anchor.y));
  const maximumY = Math.max(...anchors.map((anchor) => anchor.y));
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera: {
      x: 0.5,
      y: 0.5,
      angle: 0,
      ratio: 1,
      bounds: { x: [minimumX, maximumX], y: [minimumY, maximumY] },
    },
    cameraKind,
    morphology: options.morphology,
    organization: options.organization,
    palette: options.palette ?? "monochrome",
    temperature: options.temperature,
    theme: options.theme,
    lodBand,
    reducedMotion: options.reducedMotion,
  });
}

function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) {
    throw new Error("cannot create a distribution without samples");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samplesMs: [...samples],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("percentile index is unavailable");
  }
  return value;
}

function pass<Value>(value: Value, warmupReason: string): Measurement<Value> {
  return { status: "PASS", label: SOFTWARE_RASTERISATION_LABEL, warmupFramesExcluded: WARMUP_FRAMES, warmupReason, value };
}

function notRun<Value>(reason: string): Measurement<Value> {
  return { status: "NOT_RUN", label: SOFTWARE_RASTERISATION_LABEL, warmupFramesExcluded: WARMUP_FRAMES, warmupReason: "No measurement was taken because the operation did not run.", reason };
}

function unknown<Value>(reason: string): Measurement<Value> {
  return { status: "UNKNOWN", label: SOFTWARE_RASTERISATION_LABEL, warmupFramesExcluded: WARMUP_FRAMES, warmupReason: "No warm-up applies to this unavailable environment reading.", reason };
}

function notRunMeasurements(reason: string): PerformanceMeasurements {
  return {
    frameTime: notRun(reason),
    initialRenderLatency: notRun(reason),
    layoutCost: notRun(reason),
    sceneModelBuildCost: notRun(reason),
    interactionLatency: notRun(reason),
    pickingLatency: notRun(reason),
    memory: notRun(reason),
    cameraTransitionCost: notRun(reason),
    cameraSwitchCost: notRun(reason),
    progressiveDisclosure: notRun(reason),
  };
}

function safeSurface(handle: GraphRendererHandle) {
  try {
    return handle.readSurfaceWitness();
  } catch {
    return null;
  }
}

function canvasFingerprint(): string {
  return [...document.querySelectorAll("canvas")].map((canvas) => {
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return `${canvas.width}x${canvas.height}`;
    }
  }).join("|");
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

installPerformancePage();
