/** Renderer boundary: published only after a frame or a stage-changing canvas pass is presented. */
export type PresentedStageCounts = { readonly required: number; readonly loaded: number; readonly drawn: number };
export type PresentedRenderReadiness = {
  readonly frame: number;
  // D085-S3 BEGIN: a renderer-owned presentation is distinct from page preparation counts.
  readonly origin: 'renderer' | 'preparation';
  // D085-S3 END
  readonly view: string;
  readonly quality: 'movimento' | 'recupero' | 'completa';
  readonly ladder: 0 | 1 | 2 | 3 | 4;
  // D085-S3 BEGIN: these describe the submitted drawing buffer, not window DPR.
  readonly pixelRatio?: number;
  readonly fullPixelRatio?: number;
  // D085-S3 END
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

export function presentRenderReadiness(value: Omit<PresentedRenderReadiness, 'frame' | 'origin'>): PresentedRenderReadiness {
  // D085-S3 BEGIN
  const next = { ...value, frame: ++frame, origin: 'renderer' as const };
  // D085-S3 END
  latest = next;
  sink?.(next);
  return next;
}

// D082-A-PERF BEGIN: during a new-scene preparation the resident old frame is
// still displayed. Report only buffers actually prepared and zero drawn for the
// requested scene; a renderer presentation supersedes this transient state.
export function reportPreparationReadiness(value: Omit<PresentedRenderReadiness, 'frame' | 'origin'>): void {
  // D085-S3 BEGIN: preparation never carries a presented-frame certificate.
  sink?.({ ...value, frame: ++frame, origin: 'preparation' });
  // D085-S3 END
}
// D082-A-PERF END

export function lastPresentedReadiness(): PresentedRenderReadiness | null { return latest; }
