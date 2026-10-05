export type ReadinessStage = "nodes" | "mainEdges" | "allEdges" | "decor";
export type StageCounts = { readonly required: number; readonly loaded: number; readonly drawn: number };
export type RenderDecor = { readonly labels: boolean; readonly background: boolean; readonly glow: boolean; readonly animation: boolean };
export type RenderReadiness = {
  readonly frame: number;
  readonly view: string;
  readonly quality: "movimento" | "recupero" | "completa";
  readonly ladder: 0 | 1 | 2 | 3 | 4;
  readonly nodes: StageCounts;
  readonly mainEdges: StageCounts;
  readonly allEdges: StageCounts;
  readonly decor: RenderDecor;
  /** Optional extension for scenes or user settings where a decor stage does not apply. */
  readonly decorApplicable?: Partial<Record<keyof RenderDecor, boolean>>;
  /** D-081 depth presentation carried beside the renderer ladder in the HUD. */
  readonly depthLabel?: string;
};

const decorKeys: readonly (keyof RenderDecor)[] = ["labels", "background", "glow", "animation"];
let current: RenderReadiness | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let listeners = new Set<(readiness: RenderReadiness) => void>();
let pending: RenderReadiness | null = null;
let lastDispatchAt = 0;

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
  return countsComplete && decor.complete ? 100 : Math.min(99, Math.max(0, value));
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
  const coherent: RenderReadiness = {
    ...next,
    nodes: coherentCounts(next.nodes),
    mainEdges: coherentCounts(next.mainEdges),
    allEdges: coherentCounts(next.allEdges),
  };
  current = coherent;
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

type D082Window = Window & { __d082?: { render?: () => RenderReadiness | null; renderPercent?: () => number | null } };
if (typeof window !== "undefined") {
  const win = window as D082Window;
  win.__d082 = {
    ...win.__d082,
    render: currentRenderReadiness,
    renderPercent: () => current ? renderPercent(current) : null,
  };
}
