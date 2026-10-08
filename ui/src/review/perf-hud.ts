import { currentRenderReadiness, renderPercent } from "./render-readiness.ts";
import type { RenderReadiness } from "./render-readiness.ts";

/** Discreet, opt-in D-081 performance HUD. No sampling work runs while closed. */
export type D081Status = {
  nodes?: { visible?: number; represented?: number; total?: number; eligible?: number; aggregated?: number };
  edges?: { drawn?: number; bundled?: number; eligible?: number; total?: number };
  depth?: { level?: number; label?: string };
  quality?: "movimento" | "recupero" | "completa" | string;
  msSinceInteraction?: number;
  msToFullQuality?: number | null;
  hint?: string | null;
};
type HudWindow = Window & {
  __d081?: { status?: () => D081Status };
  __d067?: { witness?: () => { lod?: { nodes?: { rendered?: number; available?: number }; arcs?: { rendered?: number; available?: number } } } };
};
type FrameSample = { at: number; ms: number };

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

export function frameStats(frames: readonly FrameSample[]): { fps50: number; fps95: number; ms50: number; ms95: number } {
  const ms = frames.map(frame => frame.ms).filter(value => Number.isFinite(value) && value > 0);
  const fps = ms.map(value => 1000 / value);
  return { fps50: percentile(fps, 0.5), fps95: percentile(fps, 0.95), ms50: percentile(ms, 0.5), ms95: percentile(ms, 0.95) };
}

export function createFrameSampler(
  request: (callback: (at: number) => void) => number,
  cancel: (id: number) => void,
): { start(): void; stop(): void; frames(): readonly FrameSample[] } {
  const samples: FrameSample[] = [];
  let running = false;
  let previous: number | null = null;
  let requestId = 0;
  const tick = (at: number) => {
    if (!running) return;
    if (previous !== null && at > previous) samples.push({ at, ms: at - previous });
    previous = at;
    while (samples.length > 120) samples.shift();
    requestId = request(tick);
  };
  return {
    start() { if (running) return; running = true; previous = null; samples.length = 0; requestId = request(tick); },
    stop() { if (!running) return; running = false; cancel(requestId); requestId = 0; previous = null; },
    frames: () => samples,
  };
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A persisted open panel is display state, not a measurement session. */
export function hudMeasurementActive(open: boolean, status: D081Status | null,
  readiness: RenderReadiness | null = null): boolean {
  // D085-S3 BEGIN: the renderer witness can finish before the page status
  // event. An open HUD must stop its sampler when that full draw is reported.
  const quality = readiness?.view.includes('/3d/') ? readiness.quality : status?.quality;
  return open && (quality === 'movimento' || quality === 'recupero');
  // D085-S3 END
}

export function formatHud(status: D081Status | null, frames: readonly FrameSample[], fallback?: { nodes?: { rendered: number; available: number }; edges?: { rendered: number; available: number } }, readiness: RenderReadiness | null = currentRenderReadiness()): string {
  const rates = frameStats(frames);
  const nodes = status?.nodes;
  const edges = status?.edges;
  const nodeDrawn = nodes?.visible ?? fallback?.nodes?.rendered ?? 0;
  const nodeEligible = nodes?.eligible ?? fallback?.nodes?.available ?? 0;
  const nodeTotal = nodes?.total ?? nodeEligible;
  const edgeDrawn = edges?.drawn ?? fallback?.edges?.rendered ?? 0;
  const edgeEligible = edges?.eligible ?? fallback?.edges?.available ?? 0;
  const edgeTotal = edges?.total ?? edgeEligible;
  // D085-S3 BEGIN: the presented renderer phase owns the visible 3D quality label.
  const quality = readiness?.view.includes('/3d/') ? readiness.quality
    : status?.quality ?? "dati in attesa";
  // D085-S3 END
  const lastFullRecovery = formatDuration(status?.msToFullQuality);
  const depth = status?.depth?.label ?? (status?.depth?.level === undefined ? "—" : `livello ${status.depth.level}`);
  // D082-A-STALE BEGIN
  // D085-S3 BEGIN
  const ratioLine = readiness?.pixelRatio === undefined || readiness.fullPixelRatio === undefined ? ''
    : ` · pixel ${readiness.pixelRatio.toLocaleString('it-IT', { maximumFractionDigits: 2 })}× / ${readiness.fullPixelRatio.toLocaleString('it-IT', { maximumFractionDigits: 2 })}×`;
  // D085-S3 END
  const renderRows = readiness ? `<dt title="Stima lato renderer di intervalli richiesti, pronti e visibili; pubblicata due frame dopo il tentativo di disegno. Non conferma la presentazione al compositor.">Render</dt><dd>${renderPercent(readiness)}% · ${readiness.quality}${ratioLine}</dd>
    <dt>Nodi pronti / disegnati / richiesti · totali</dt><dd>${readiness.nodes.loaded.toLocaleString("it-IT")} / ${readiness.nodes.drawn.toLocaleString("it-IT")} / ${readiness.nodes.required.toLocaleString("it-IT")} · ${nodes?.total?.toLocaleString("it-IT") ?? "—"}</dd>
    <dt>Archi pronti / disegnati / richiesti · totali</dt><dd>${readiness.allEdges.loaded.toLocaleString("it-IT")} / ${readiness.allEdges.drawn.toLocaleString("it-IT")} / ${readiness.allEdges.required.toLocaleString("it-IT")} · ${edges?.total?.toLocaleString("it-IT") ?? "—"}</dd>
    <dt>LOD · profondità</dt><dd>${readiness.ladder} · ${readiness.depthLabel ?? "—"}</dd>` : "<dt>Render</dt><dd>in attesa dei dati renderer</dd>";
  // D082-A-STALE END
  return `<dl>
    ${renderRows}
    <dt>FPS p50 / p95</dt><dd>${rates.fps50.toFixed(1)} / ${rates.fps95.toFixed(1)}</dd>
    <dt>Frame ms p50 / p95</dt><dd>${rates.ms50.toFixed(1)} / ${rates.ms95.toFixed(1)}</dd>
    <dt>Nodi visibili / rappr.</dt><dd>${nodeDrawn} / ${nodes?.represented ?? nodeDrawn} · ${nodeEligible} elegg. / ${nodeTotal} tot. · +${nodes?.aggregated ?? 0}</dd>
    <dt>Archi / bundle</dt><dd>${edgeDrawn} / ${edges?.bundled ?? 0} · ${edgeEligible} elegg. / ${edgeTotal} tot.</dd>
    <dt>Qualità · LOD</dt><dd>${quality} · ${depth}</dd>
    <dt>Ultima interazione</dt><dd>${formatDuration(status?.msSinceInteraction)} fa</dd>
    <dt>Ultimo recupero completo</dt><dd>${lastFullRecovery}</dd>
  </dl>${status?.hint ? `<p class="performance-hint"></p>` : ""}`;
}

export function mountPerformanceHud(surface: HTMLElement, opener: HTMLButtonElement): { setOpen(open: boolean): void; readStatus(): D081Status | null } {
  const win = window as HudWindow;
  const heading = surface.querySelector("h2") ?? document.createElement("h2");
  heading.textContent = "Prestazioni";
  if (!heading.isConnected) surface.append(heading);
  const content = document.createElement("div"); content.className = "performance-content"; surface.append(content);
  const sampler = createFrameSampler(callback => requestAnimationFrame(callback), id => cancelAnimationFrame(id));
  let status: D081Status | null = null;
  let readiness = currentRenderReadiness();
  let open = false;
  let measuring = false;
  const syncMeasurement = () => {
    // D085-S3 BEGIN
    const active = hudMeasurementActive(open, status, readiness);
    // D085-S3 END
    if (active === measuring) return;
    measuring = active;
    if (active) sampler.start(); else sampler.stop();
  };
  const onStatus = (event: Event) => {
    const detail = (event as CustomEvent<D081Status>).detail;
    status = detail ?? win.__d081?.status?.() ?? null;
    syncMeasurement(); refresh();
  };
  const onRender = (event: Event) => {
    readiness = (event as CustomEvent<RenderReadiness>).detail ?? currentRenderReadiness();
    // D085-S3 BEGIN
    syncMeasurement();
    // D085-S3 END
    refresh();
  };
  const refresh = () => {
    if (!open) return;
    status = win.__d081?.status?.() ?? status;
    const witness = win.__d067?.witness?.();
    readiness = currentRenderReadiness() ?? readiness;
    content.innerHTML = formatHud(status, sampler.frames(), {
      ...(witness?.lod?.nodes ? { nodes: { rendered: witness.lod.nodes.rendered ?? 0, available: witness.lod.nodes.available ?? 0 } } : {}),
      ...(witness?.lod?.arcs ? { edges: { rendered: witness.lod.arcs.rendered ?? 0, available: witness.lod.arcs.available ?? 0 } } : {}),
    }, readiness);
    const hint = content.querySelector(".performance-hint");
    if (hint) hint.textContent = status?.hint ?? "";
  };
  const setOpen = (next: boolean) => {
    if (next === open) return;
    open = next;
    surface.hidden = !open;
    opener.setAttribute("aria-pressed", String(open));
    try { localStorage.setItem("d081-performance-open", String(open)); } catch { /* storage can be disabled */ }
    if (open) {
      status = win.__d081?.status?.() ?? null;
      window.addEventListener("d081:status", onStatus);
      window.addEventListener("d082:render", onRender);
      syncMeasurement(); refresh();
    } else {
      sampler.stop(); measuring = false;
      window.removeEventListener("d081:status", onStatus);
      window.removeEventListener("d082:render", onRender);
      status = null; readiness = currentRenderReadiness();
    }
  };
  let initiallyOpen = false;
  try { initiallyOpen = localStorage.getItem("d081-performance-open") === "true"; } catch { /* storage can be disabled */ }
  if (initiallyOpen) setOpen(true);
  return { setOpen, readStatus: () => status };
}
