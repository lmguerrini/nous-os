/** Temporary rendering detail only. Every stage retains the requested scene and camera. */
export type QualityStage = 1 | 2 | 3 | 4;
export type QualityState = { readonly stage: QualityStage; readonly moving: boolean };
export const FULL_QUALITY_STAGE: QualityStage = 4;
export const ALL_EDGES_QUALITY_STAGE: QualityStage = 3;
// D082-A-PERF BEGIN
/** Leave headroom under a 50 ms main-thread preparation task. */
export const MODEL_PREP_SLICE_MS = 24;
// D082-A-PERF END
// D086-BURST BEGIN: renderer readiness helpers cross the existing governed boundary together.
export { presentRenderReadiness, renderReadinessHost } from './render-readiness-producer.ts';
// D086-BURST END

// D086-BURST BEGIN: a retained native scene can present a different real subset.
export function nativeSubsetCounts(
  nodes: readonly { readonly id: string }[],
  edges: readonly { readonly id: string; readonly source: string; readonly target: string }[],
  residentKinds: ReadonlyMap<string, string>, emphasis: ReadonlySet<string> | null,
): { nodes: number; mainEdges: number; allEdges: number } {
  const mainEdges = edges.filter(edge => mainRelation({ attested: true,
    selectedIncident: !!(emphasis?.has(edge.source) || emphasis?.has(edge.target)),
    sourceHub: residentKinds.get(edge.source) === 'hub', targetHub: residentKinds.get(edge.target) === 'hub',
    sourceDomain: residentKinds.get(edge.source) === 'domain',
    targetDomain: residentKinds.get(edge.target) === 'domain' })).length;
  return { nodes: nodes.length, mainEdges, allEdges: edges.length };
}
// D086-BURST END

/** The last input restarts this clock. Stage 4 is reached 320 ms after that input. */
export const QUALITY_RESTORE_MS = [0, 80, 160, 320] as const;

// D085-S3 BEGIN: Lab 3D uses a CSS-pixel drawing buffer through the moving
// tiers, then restores the exact requested buffer before the full draw tier.
export function labPixelRatio(stage: QualityStage, fullPixelRatio: number): number {
  return stage < 3 ? Math.min(fullPixelRatio, 1) : fullPixelRatio;
}
/** The page owns this taxonomy; renderer organization alone cannot identify a Lab law. */
export function labInteractionEnabled(topology: string | undefined): boolean {
  return topology !== undefined && topology !== 'natural';
}
/** Sparse and non-Lab scenes retain their existing interaction presentation. */
export function labDenseInteraction(topology: string | undefined, nodes: number, threshold: number): boolean {
  return labInteractionEnabled(topology) && nodes >= threshold;
}
/** Mirror typed-layer's opacity buckets and insertion order, then select by node ID.
 * A count mismatch refuses the proxy rather than associating an instance with another node. */
export function labAnchorInstanceIndices(nodes: readonly { id: string; alpha: number }[],
  anchors: ReadonlySet<string>, bucketCounts: readonly number[],
): readonly (readonly number[])[] | null {
  const buckets = new Map<number, string[]>();
  for (const node of nodes) {
    const alpha = Math.max(0, Math.min(1, Number.isFinite(node.alpha) ? node.alpha : 1));
    if (alpha <= 0) continue;
    const bucket = buckets.get(alpha) ?? [];
    bucket.push(node.id);
    buckets.set(alpha, bucket);
  }
  const ordered = [...buckets.values()];
  if (ordered.length !== bucketCounts.length || ordered.some((bucket, index) => bucket.length !== bucketCounts[index]))
    return null;
  return ordered.map(bucket => bucket.flatMap((id, index) => anchors.has(id) ? [index] : []));
}
/** Native Lab skeleton: only real node and relation IDs from the mounted scene. */
export type NativeRelationRank = Readonly<{ evidenceCount: number; relationClass: 'attested' | 'exploratory' | 'structural' }>;
export type NativeAnchorRules = Readonly<{ kind: number; level: number; emphasis: number;
  degree: number; relationEndpoint: number; fallback: number }>;
export function nativeLabSkeleton(nodes: readonly { id: string; kind: string; interaction?: string }[],
  edges: readonly { id: string; source: string; target: string }[],
  levels: ReadonlyMap<string, number> = new Map(), emphasisIds: ReadonlySet<string> = new Set(),
  wholeResidentRelations = false, relationRanks: ReadonlyMap<string, NativeRelationRank> = new Map(),
): { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string>; anchorRules: NativeAnchorRules } {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const degree = new Map<string, number>();
  for (const edge of edges) if (byId.has(edge.source) && byId.has(edge.target)) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const anchors = new Set<string>();
  const rules = { kind: 0, level: 0, emphasis: 0, degree: 0, relationEndpoint: 0, fallback: 0 };
  for (const node of nodes) {
    if (node.kind === 'domain' || node.kind === 'hub') { anchors.add(node.id); rules.kind++; }
    else if ((levels.get(node.id) ?? Infinity) <= 2) { anchors.add(node.id); rules.level++; }
    else if (emphasisIds.has(node.id) || node.interaction === 'selected' || node.interaction === 'focused') {
      anchors.add(node.id); rules.emphasis++;
    }
  }
  // The highest-degree real nodes remain recognizable even when the scene erases
  // source kinds. Degree ties use IDs, never layout position or insertion order.
  const hubs = nodes.filter(node => (degree.get(node.id) ?? 0) > 1)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 48);
  for (const hub of hubs) if (!anchors.has(hub.id)) { anchors.add(hub.id); rules.degree++; }
  const priorityAnchors = new Set(anchors);
  let main = edges.filter(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    return source !== undefined && target !== undefined && mainRelation({ attested: true,
      selectedIncident: emphasisIds.has(edge.source) || emphasisIds.has(edge.target)
        || source.interaction === 'selected' || target.interaction === 'selected',
      sourceHub: source.kind === 'hub', targetHub: target.kind === 'hub',
      sourceDomain: source.kind === 'domain', targetDomain: target.kind === 'domain',
    });
  });
  // Small resident sets retain all real relations. Larger native sets offer
  // both classified and anchor-incident relations to the semantic cap; a
  // nonempty classifier must not suppress a real upper-level root relation.
  if (wholeResidentRelations) {
    const classifiedIds = new Set(main.map(edge => edge.id));
    main = edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)
      && (edges.length <= 1024 || classifiedIds.has(edge.id)
        || anchors.has(edge.source) || anchors.has(edge.target)));
  } else if (main.length === 0) main = edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)
    && (anchors.has(edge.source) || anchors.has(edge.target)));
  const rootIncident = (edge: typeof edges[number]): boolean => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    return source?.kind === 'domain' || target?.kind === 'domain'
      || Math.min(levels.get(edge.source) ?? Infinity, levels.get(edge.target) ?? Infinity) <= 1;
  };
  const classRank = (value: NativeRelationRank | undefined): number =>
    value?.relationClass === 'attested' ? 2 : value?.relationClass === 'structural' ? 1 : 0;
  main.sort((a, b) => Number(rootIncident(b)) - Number(rootIncident(a))
    || Number(priorityAnchors.has(b.source) || priorityAnchors.has(b.target))
      - Number(priorityAnchors.has(a.source) || priorityAnchors.has(a.target))
    || (relationRanks.get(b.id)?.evidenceCount ?? 0) - (relationRanks.get(a.id)?.evidenceCount ?? 0)
    || classRank(relationRanks.get(b.id)) - classRank(relationRanks.get(a.id))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (main.length > 1024) main = main.slice(0, 1024);
  for (const edge of main) for (const id of [edge.source, edge.target])
    if (!anchors.has(id)) { anchors.add(id); rules.relationEndpoint++; }
  if (anchors.size === 0 && nodes.length) { anchors.add(nodes.map(node => node.id).sort()[0]!); rules.fallback++; }
  return { nodeIds: anchors, edgeIds: new Set(main.map(edge => edge.id)), anchorRules: rules };
}
// D085-S3 END

// D085-S3 BEGIN: Lab camera work uses resident geometry at four explicit draw tiers.
export type LabDrawPolicy = Readonly<{
  nodes: 'anchors' | 'all';
  semanticEdges: 'main' | 'all';
  visualEdges: boolean;
  decor: boolean;
}>;
export function labDrawPolicy(stage: QualityStage): LabDrawPolicy {
  return {
    nodes: stage === 1 ? 'anchors' : 'all',
    semanticEdges: stage < 3 ? 'main' : 'all',
    visualEdges: stage === 4,
    decor: stage === 4,
  };
}
/** Select complete, already prepared morphology segments for real relation IDs. */
export function labMainSegmentRanges(ends: readonly number[], ids: readonly string[],
  main: ReadonlySet<string>): { ranges: readonly (readonly [number, number])[]; relationIds: ReadonlySet<string>; vertices: number } {
  const ranges: [number, number][] = [];
  const relationIds = new Set<string>();
  let previous = 0, vertices = 0;
  for (let index = 0; index < ends.length; index++) {
    const end = ends[index]!;
    const id = ids[index];
    if (id !== undefined && main.has(id) && end > previous) {
      ranges.push([previous, end]);
      relationIds.add(id);
      vertices += end - previous;
    }
    previous = end;
  }
  return { ranges, relationIds, vertices };
}
// D085-S3 END

export function qualityAt(elapsedMs: number): QualityStage {
  if (elapsedMs < QUALITY_RESTORE_MS[1]) return 1;
  if (elapsedMs < QUALITY_RESTORE_MS[2]) return 2;
  if (elapsedMs < QUALITY_RESTORE_MS[3]) return 3;
  return 4;
}

/** A relation is main when it carries selected context, a hub/domain bridge, or high hierarchy. */
export function mainRelation(input: {
  readonly selectedIncident?: boolean;
  readonly neighbourhoodIncident?: boolean;
  readonly sourceHub?: boolean;
  readonly targetHub?: boolean;
  readonly sourceDomain?: boolean;
  readonly targetDomain?: boolean;
  readonly hierarchyLevel?: number;
  readonly attested?: boolean;
  readonly exploratory?: boolean;
}): boolean {
  return input.hierarchyLevel !== undefined && input.hierarchyLevel <= 2
    || !!(input.sourceHub || input.sourceDomain) && !!(input.targetHub || input.targetDomain)
    || !!(input.attested || input.exploratory) && !!(input.selectedIncident || input.neighbourhoodIncident);
}

/** Schedules only the three restoration changes. No free-running frame loop. */
export class QualityLadder {
  private readonly onChange: (state: QualityState) => void;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stateValue: QualityState = { stage: 4, moving: false };
  private lastInput = 0;
  private disposed = false;

  constructor(onChange: (state: QualityState) => void,
    now: () => number = () => performance.now(),
    schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = (callback, delay) => setTimeout(callback, delay),
    cancel: (timer: ReturnType<typeof setTimeout>) => void = timer => clearTimeout(timer)) {
    this.onChange = onChange;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  get state(): QualityState { return this.stateValue; }

  touch(): void {
    if (this.disposed) return;
    this.lastInput = this.now();
    if (this.timer !== undefined) this.cancel(this.timer);
    this.set({ stage: 1, moving: true });
    this.queue();
  }

  restoreNow(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.set({ stage: 4, moving: false });
  }

  destroy(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private set(next: QualityState): void {
    if (next.stage === this.stateValue.stage && next.moving === this.stateValue.moving) return;
    this.stateValue = next;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfmarks'))
      performance.mark(`d082:quality:stage-${next.stage}`);
    this.onChange(next);
  }

  private queue(): void {
    const elapsed = Math.max(0, this.now() - this.lastInput);
    const stage = qualityAt(elapsed);
    if (stage === 4) {
      this.timer = undefined;
      this.set({ stage: 4, moving: false });
      return;
    }
    const nextAt = QUALITY_RESTORE_MS[stage];
    this.timer = this.schedule(() => {
      this.timer = undefined;
      const next = qualityAt(Math.max(0, this.now() - this.lastInput));
      this.set({ stage: next, moving: false });
      this.queue();
    }, Math.max(1, nextAt - elapsed));
  }
}
