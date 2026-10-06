/** Renderer boundary: published only after a frame or a stage-changing canvas pass is presented. */
export type PresentedStageCounts = { readonly required: number; readonly loaded: number; readonly drawn: number };
export type PresentedRenderReadiness = {
  readonly frame: number;
  readonly view: string;
  readonly quality: 'movimento' | 'recupero' | 'completa';
  readonly ladder: 0 | 1 | 2 | 3 | 4;
  readonly nodes: PresentedStageCounts;
  readonly mainEdges: PresentedStageCounts;
  readonly allEdges: PresentedStageCounts;
  readonly decor: { readonly labels: boolean; readonly background: boolean; readonly glow: boolean; readonly animation: boolean };
  readonly decorApplicable?: { readonly labels?: boolean; readonly background?: boolean; readonly glow?: boolean; readonly animation?: boolean };
};

let frame = 0;
let sink: ((next: PresentedRenderReadiness) => void) | null = null;
let latest: PresentedRenderReadiness | null = null;

/** A-HUD installs its contract function once; this keeps renderers independent of review UI. */
export function installRenderReadinessSink(next: (value: PresentedRenderReadiness) => void): () => void {
  const previous = sink;
  sink = next;
  if (latest) next(latest);
  return () => { if (sink === next) sink = previous; };
}

export function presentRenderReadiness(value: Omit<PresentedRenderReadiness, 'frame'>): PresentedRenderReadiness {
  const next = { ...value, frame: ++frame };
  latest = next;
  sink?.(next);
  return next;
}

// D082-A-PERF BEGIN: during a new-scene preparation the resident old frame is
// still displayed. Report only buffers actually prepared and zero drawn for the
// requested scene; a renderer presentation supersedes this transient state.
export function reportPreparationReadiness(value: Omit<PresentedRenderReadiness, 'frame'>): void {
  sink?.({ ...value, frame: ++frame });
}
// D082-A-PERF END

export function lastPresentedReadiness(): PresentedRenderReadiness | null { return latest; }
