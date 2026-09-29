/** Optional viewer diagnostics. Sampling and repaint timers exist only while the surface is open. */
type Count = { rendered: number; available: number };
export type CanvasSize = { id: string; width: number; height: number; cssWidth: number; cssHeight: number; dpr: number };
export type PerformanceSnapshot = {
  activity: "attivo" | "a riposo";
  fps: { median: number; p95: number };
  frameTime: { median: number; p95: number };
  nodes: Count; arcs: Count; labels: number; titles: number; flowFps: number; quality: "piena" | "movimento";
  dpr: number; canvases: CanvasSize[];
};

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

type Witness = { lod?: { nodes?: Count; arcs?: Count; labels?: { rendered: number } };
  disclosure?: { visible?: number; total?: number }; arcs?: { shown?: number; total?: number };
  labels?: readonly unknown[]; titleCount?: number };
type DiagnosticWindow = Window & {
  __d067?: { witness(): Witness };
  __d072?: Record<string, unknown> & { quality?: () => string; cameraWatchRunning?: () => boolean;
    cameraFrames?: () => readonly number[]; flowFps?: () => number; flowActive?: () => boolean;
    perf?: () => PerformanceSnapshot };
};

/** Idle gaps are excluded even when a new drawing wakes the page much later. */
export function activeFrameDelta(previous: number | null, now: number, active: boolean): number | null {
  if (!active || previous === null) return null;
  const gap = now - previous;
  return gap > 0 && gap <= 100 ? gap : null;
}

/** The independent flow clock never qualifies a camera frame as scene activity. */
export function sceneFrameActive(quality: string | undefined, cameraWatchRunning: boolean): boolean {
  return quality === "moving" || cameraWatchRunning;
}

function canvasSizes(viewport: HTMLElement): CanvasSize[] {
  return [...viewport.querySelectorAll<HTMLCanvasElement>("canvas")].map((canvas, index) => {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width || parseFloat(getComputedStyle(canvas).width) || 0;
    const cssHeight = rect.height || parseFloat(getComputedStyle(canvas).height) || 0;
    return {
      id: canvas.id || canvas.dataset.morphologyCanvas && "morphology" || canvas.dataset.render3fCanvas && "three" || canvas.dataset.flowCanvas && "flow" ||
        [...canvas.classList].join(" ") || `canvas-${index}`,
      width: canvas.width, height: canvas.height, cssWidth, cssHeight,
      dpr: cssWidth > 0 ? canvas.width / cssWidth : 0,
    };
  });
}

export function mountPerformanceOverlay(surface: HTMLElement, viewport: HTMLElement): { setOpen(open: boolean): void; read(): PerformanceSnapshot } {
  const win = window as DiagnosticWindow;
  const content = document.createElement("div");
  content.className = "performance-content";
  surface.append(content);
  const frames: { at: number; ms: number }[] = [];
  let previous: number | null = null;
  let active = false;
  let frameRequest = 0;
  let refreshTimer = 0;
  let open = false;
  const sample = (at: number) => {
    if (!open) return;
    const diagnostics = win.__d072;
    const running = sceneFrameActive(diagnostics?.quality?.(), diagnostics?.cameraWatchRunning?.() === true);
    if (!running && active) frames.length = 0;
    active = running;
    for (const frameAt of diagnostics?.cameraFrames?.() ?? []) {
      if (previous !== null && frameAt <= previous) continue;
      const delta = activeFrameDelta(previous, frameAt, running);
      if (delta !== null) frames.push({ at: frameAt, ms: delta });
      previous = frameAt;
    }
    while (frames.length > 120) frames.shift();
    frameRequest = requestAnimationFrame(sample);
  };
  const read = (): PerformanceSnapshot => {
    const times = frames.map(frame => frame.ms);
    const fps = times.map(ms => ms > 0 ? 1000 / ms : 0);
    const witness = win.__d067?.witness();
    const canvases = canvasSizes(viewport);
    const drawing = canvases.find(canvas => canvas.id === "morphology") ?? canvases.find(canvas => canvas.id === "three");
    const nodes = witness?.lod?.nodes ?? { rendered: witness?.disclosure?.visible ?? 0, available: witness?.disclosure?.total ?? witness?.disclosure?.visible ?? 0 };
    const arcs = witness?.lod?.arcs ?? { rendered: witness?.arcs?.shown ?? 0, available: witness?.arcs?.total ?? 0 };
    return {
      activity: active ? "attivo" : "a riposo",
      fps: { median: percentile(fps, 0.5), p95: percentile(fps, 0.95) },
      frameTime: { median: percentile(times, 0.5), p95: percentile(times, 0.95) },
      nodes, arcs, labels: witness?.lod?.labels?.rendered ?? witness?.labels?.length ?? 0,
      titles: witness?.titleCount ?? 0,
      flowFps: win.__d072?.flowActive?.() ? win.__d072?.flowFps?.() ?? 0 : 0,
      quality: win.__d072?.quality?.() === "moving" ? "movimento" : "piena",
      dpr: drawing?.dpr ?? window.devicePixelRatio, canvases,
    };
  };
  const refresh = () => {
    if (!open) return;
    const value = read();
    const scene = value.activity === "a riposo" ? "a riposo" : `${value.fps.median.toFixed(1)} fps · p95 ${value.frameTime.p95.toFixed(1)} ms`;
    const flow = value.flowFps > 0 ? `${value.flowFps.toFixed(0)} fps (limitato a 30)` : "a riposo";
    content.innerHTML = `<p class="performance-activity">${value.activity}</p><dl><dt>Scena</dt><dd>${scene}</dd>
      <dt>Flusso</dt><dd>${flow}</dd>
      <dt>Nodi</dt><dd>${value.nodes.rendered} / ${value.nodes.available}</dd>
      <dt>Archi</dt><dd>${value.arcs.rendered} / ${value.arcs.available}</dd>
      <dt>Etichette</dt><dd>${value.labels} · titoli ${value.titles}</dd>
      <dt>Qualità</dt><dd>${value.quality}</dd>
      <dt>DPR</dt><dd>${value.dpr.toFixed(2)}</dd></dl>`;
  };
  const setOpen = (next: boolean) => {
    if (next === open) return;
    open = next;
    if (open) {
      frames.length = 0;
      previous = win.__d072?.cameraFrames?.().at(-1) ?? null;
      active = false;
      frameRequest = requestAnimationFrame(sample);
      refresh();
      refreshTimer = window.setInterval(refresh, 250);
    } else {
      cancelAnimationFrame(frameRequest);
      clearInterval(refreshTimer);
      frameRequest = 0;
      refreshTimer = 0;
      previous = null;
      active = false;
    }
  };
  win.__d072 = { ...(win.__d072 ?? {}), perf: read };
  return { setOpen, read };
}
