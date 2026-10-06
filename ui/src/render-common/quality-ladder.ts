/** Temporary rendering detail only. Every stage retains the requested scene and camera. */
export type QualityStage = 1 | 2 | 3 | 4;
export type QualityState = { readonly stage: QualityStage; readonly moving: boolean };
export const FULL_QUALITY_STAGE: QualityStage = 4;
export const ALL_EDGES_QUALITY_STAGE: QualityStage = 3;
// D082-A-PERF BEGIN
/** Leave headroom under a 50 ms main-thread preparation task. */
export const MODEL_PREP_SLICE_MS = 24;
// D082-A-PERF END
export { presentRenderReadiness } from './render-readiness-producer.ts';

/** The last input restarts this clock. Stage 4 is reached 320 ms after that input. */
export const QUALITY_RESTORE_MS = [0, 80, 160, 320] as const;

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
