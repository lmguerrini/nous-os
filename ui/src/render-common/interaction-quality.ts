/** A camera-quality transition has one pending timer at most, and none at rest. */
export type InteractionQuality = "full" | "moving";

export const INTERACTION_RESTORE_MS = 110;

export type QualityTimers = Readonly<{
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}>;

const browserTimers: QualityTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: timer => clearTimeout(timer),
};

/** Holds reduced drawing through a drag and restores it once after the last input. */
export class InteractionQualityController {
  private state: InteractionQuality = "full";
  private held = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly restored: () => void;
  private readonly timers: QualityTimers;
  private readonly delayMs: number;

  constructor(
    restored: () => void,
    timers: QualityTimers = browserTimers,
    delayMs: number = INTERACTION_RESTORE_MS,
  ) {
    this.restored = restored;
    this.timers = timers;
    this.delayMs = delayMs;
  }

  get quality(): InteractionQuality { return this.state; }

  /** A real camera change starts or extends the reduced pass. */
  touch(): InteractionQuality | null {
    if (this.disposed) return null;
    const changed = this.state === "full";
    this.state = "moving";
    this.arm();
    return changed ? "moving" : null;
  }

  /** Input can arrive before the next camera frame; keep an active deadline behind it. */
  defer(): void {
    if (!this.disposed && this.state === "moving") this.arm();
  }

  hold(): void {
    if (this.disposed) return;
    this.held = true;
    this.cancel();
  }

  release(): void {
    if (this.disposed || !this.held) return;
    this.held = false;
    if (this.state === "moving") this.arm();
  }

  /** A completed programmatic fit can restore in its closing frame. */
  endMotion(): InteractionQuality | null {
    if (this.disposed || this.state === "full") return null;
    this.cancel();
    this.state = "full";
    return "full";
  }

  destroy(): void {
    this.disposed = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.cancel();
    if (this.held) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      if (this.disposed || this.held || this.state !== "moving") return;
      this.state = "full";
      this.restored();
    }, this.delayMs);
  }
}
