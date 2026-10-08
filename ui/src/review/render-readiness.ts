// D082-A-PERF BEGIN: renderer presentation reports enter the A-HUD contract through this sink.
import { installRenderReadinessSink } from '#render-common/render-readiness-producer.ts';
// D082-A-PERF END
// D082-B1f BEGIN
import { capUnpresentedCanopySomata } from '../fractal/canopy-soma-readiness.ts';
// D082-B1f END
// D085-S3 BEGIN
import { withRenderProgress } from './toolbar-status.ts';
// D085-S3 END

export type ReadinessStage = "nodes" | "mainEdges" | "allEdges" | "decor";
export type StageCounts = { readonly required: number; readonly loaded: number; readonly drawn: number };
export type RenderDecor = { readonly labels: boolean; readonly background: boolean; readonly glow: boolean; readonly animation: boolean };
export type RenderReadiness = {
  readonly frame: number;
  // D085-S3 BEGIN
  readonly origin?: 'renderer' | 'preparation';
  // D085-S3 END
  readonly view: string;
  readonly quality: "movimento" | "recupero" | "completa";
  readonly ladder: 0 | 1 | 2 | 3 | 4;
  // D085-S3 BEGIN
  readonly pixelRatio?: number;
  readonly fullPixelRatio?: number;
  readonly skeleton?: { readonly anchors: number; readonly mainRelations: number };
  // D085-S3 END
  readonly nodes: StageCounts;
  readonly mainEdges: StageCounts;
  readonly allEdges: StageCounts;
  readonly decor: RenderDecor;
  /** Optional extension for scenes or user settings where a decor stage does not apply. */
  readonly decorApplicable?: Partial<Record<keyof RenderDecor, boolean>>;
  /** D-081 depth presentation carried beside the renderer ladder in the HUD. */
  readonly depthLabel?: string;
};

// D082-A-STALE BEGIN
/**
 * The percentage is a coalesced renderer-side estimate of requested, loaded, and visible ranges,
 * published after the next animation frame following a submission. It is not a compositor acknowledgement.
 */
// D082-A-STALE END

const decorKeys: readonly (keyof RenderDecor)[] = ["labels", "background", "glow", "animation"];
let current: RenderReadiness | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let listeners = new Set<(readiness: RenderReadiness) => void>();
let pending: RenderReadiness | null = null;
let lastDispatchAt = 0;
// D082-A-PERF BEGIN: page recovery may lead; a presented renderer frame owns settled readiness.
let rendererAuthoritative = false;
let acceptingRenderer = false;
// D082-A-PERF END
// D082-B1f BEGIN: the renderer's node buffer can precede Canopy's separate soma canvas.
let lastPresentedRenderer: RenderReadiness | null = null;
function canopySomaPending(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
  const hosts = document.querySelectorAll('.view-host');
  const currentHost = hosts.item(hosts.length - 1);
  return !!currentHost && currentHost.hasAttribute('data-fractal-soma-required')
    && !currentHost.hasAttribute('data-fractal-somata-ready');
}
// D082-B1f END

function ratio(counts: StageCounts): number {
  return counts.required === 0 ? 1 : Math.min(1, Math.max(0, counts.drawn / counts.required));
}

function decorProgress(readiness: RenderReadiness): { fraction: number; complete: boolean } {
  const applicable = decorKeys.filter(key => readiness.decorApplicable?.[key] !== false);
  if (!applicable.length) return { fraction: 1, complete: true };
  const ready = applicable.filter(key => readiness.decor[key]).length;
  return { fraction: ready / applicable.length, complete: ready === applicable.length };
}

export function renderPercent(readiness: RenderReadiness): number {
  const decor = decorProgress(readiness);
  const value = Math.floor(100 * (
    0.40 * ratio(readiness.nodes) +
    0.25 * ratio(readiness.mainEdges) +
    0.20 * ratio(readiness.allEdges) +
    0.15 * decor.fraction
  ));
  const countsComplete = [readiness.nodes, readiness.mainEdges, readiness.allEdges]
    .every(counts => counts.drawn === counts.required);
  // D085-S3 BEGIN: a reduced draw tier or interim page counts cannot certify completion.
  const presented = !readiness.view.includes('/3d/') || readiness.origin === 'renderer';
  // Reduced resolution is still an interaction frame.
  const fullBuffer = readiness.pixelRatio === undefined || readiness.fullPixelRatio === undefined
    || readiness.pixelRatio === readiness.fullPixelRatio;
  return countsComplete && decor.complete && presented && fullBuffer
    && readiness.quality === 'completa' && readiness.ladder === 4
    ? 100 : Math.min(99, Math.max(0, value));
  // D085-S3 END
}

function dispatch(readiness: RenderReadiness): void {
  lastDispatchAt = Date.now();
  for (const listener of [...listeners]) listener(readiness);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent<RenderReadiness>("d082:render", { detail: readiness }));
  }
}

function flush(): void {
  pendingTimer = null;
  if (!pending) return;
  const value = pending;
  pending = null;
  dispatch(value);
}

function coherentCounts(counts: StageCounts): StageCounts {
  const required = Number.isFinite(counts.required) ? Math.max(0, Math.trunc(counts.required)) : 0;
  const loaded = Number.isFinite(counts.loaded) ? Math.min(required, Math.max(0, Math.trunc(counts.loaded))) : 0;
  const drawn = Number.isFinite(counts.drawn) ? Math.min(loaded, Math.max(0, Math.trunc(counts.drawn))) : 0;
  return { required, loaded, drawn };
}

/** Renderer → HUD. Snapshot access is immediate; event/listener delivery is coalesced to at most 10 Hz. */
export function reportRenderReadiness(next: RenderReadiness): void {
  // D082-A-PERF BEGIN: the page's interim producer cannot overwrite a presented frame.
  if (!acceptingRenderer) {
    if (next.quality === 'recupero') rendererAuthoritative = false;
    else if (rendererAuthoritative) return;
  }
  // D082-A-PERF END
  // D082-B1f BEGIN: a drawn fallback disc is still a loaded, unpresented soma.
  const presented = canopySomaPending() ? capUnpresentedCanopySomata(next) : next;
  // D082-B1f END
  const counted: RenderReadiness = {
    ...presented,
    nodes: coherentCounts(presented.nodes),
    mainEdges: coherentCounts(presented.mainEdges),
    allEdges: coherentCounts(presented.allEdges),
  };
  // D085-S3 BEGIN: normalize the public phase as well as its percentage.
  const coherent: RenderReadiness = counted.view.includes('/3d/')
    && counted.quality === 'completa' && renderPercent(counted) < 100
    ? { ...counted, quality: 'recupero' } : counted;
  // D085-S3 END
  current = coherent;
  // D085-S3 BEGIN: renderer presentations refresh the toolbar even when the page
  // has no new graph-status event. The witness guards 100% until a drawn frame.
  if (coherent.view.includes('/3d/') && typeof document !== 'undefined'
    && typeof document.getElementById === 'function') {
    const percent = renderPercent(coherent);
    const phase = percent === 100 ? 'Completa' : coherent.quality === 'movimento' ? 'Movimento' : 'Recupero';
    const statusLine = document.getElementById('human-status');
    if (statusLine) {
      const line = withRenderProgress(statusLine.textContent ?? '', percent);
      if (statusLine.textContent !== line) statusLine.textContent = line;
      // D085-S3 BEGIN: the header's live tooltip is custom, not a native title.
      if (statusLine.dataset.tooltip !== line) statusLine.dataset.tooltip = line;
      statusLine.removeAttribute('title');
      // D085-S3 END
    }
    const graphStatus = document.getElementById('graph-status-cap');
    if (graphStatus?.textContent) {
      const line = graphStatus.textContent.replace(/Qualità: (?:Movimento|Recupero|Completa)\./,
        `Qualità: ${phase}.`);
      if (graphStatus.textContent !== line) graphStatus.textContent = line;
    }
  }
  // D085-S3 END
  pending = coherent;
  if (pendingTimer !== null) return;
  const wait = Math.max(0, 100 - (Date.now() - lastDispatchAt));
  pendingTimer = setTimeout(flush, wait);
}

export function currentRenderReadiness(): RenderReadiness | null { return current; }

export function onRenderReadiness(listener: (readiness: RenderReadiness) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// D082-A-PERF BEGIN: no polling; renderers invoke the sink only after presented stage changes.
installRenderReadinessSink(next => {
  acceptingRenderer = true;
  rendererAuthoritative = true;
  // D082-B1f BEGIN
  lastPresentedRenderer = next;
  // D082-B1f END
  try { reportRenderReadiness(next); }
  finally { acceptingRenderer = false; }
});
// D082-A-PERF END

// D082-B1f BEGIN: re-publish the most recent presented frame when the canvas changes stage.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
  for (const type of ['d082:canopy-soma-pending', 'd082:canopy-soma-ready'])
  document.addEventListener(type, () => {
    if (!lastPresentedRenderer) return;
    acceptingRenderer = true;
    try { reportRenderReadiness(lastPresentedRenderer); }
    finally { acceptingRenderer = false; }
  });
// D082-B1f END

type D082Window = Window & { __d082?: { render?: () => RenderReadiness | null; renderPercent?: () => number | null } };
if (typeof window !== "undefined") {
  const win = window as D082Window;
  win.__d082 = {
    ...win.__d082,
    render: currentRenderReadiness,
    renderPercent: () => current ? renderPercent(current) : null,
  };
}
