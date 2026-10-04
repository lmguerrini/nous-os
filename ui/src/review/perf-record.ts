/** Bounded measurements of work owned by the product view. Reading the record allocates;
 * recording a frame only overwrites preallocated numeric slots. */
export class PerfRecord {
  private readonly frameMs = new Float64Array(240);
  private readonly flowMs = new Float64Array(240);
  private frameHead = 0;
  private frameCount = 0;
  private flowHead = 0;
  private flowCount = 0;
  private readonly phases = new Map<string, { count: number; lastMs: number; totalMs: number; maxMs: number }>();

  frame(ms: number, kind: 'camera' | 'flow' = 'camera'): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (kind === 'flow') {
      this.flowMs[this.flowHead] = ms;
      this.flowHead = (this.flowHead + 1) % this.flowMs.length;
      this.flowCount = Math.min(this.flowCount + 1, this.flowMs.length);
    } else {
      this.frameMs[this.frameHead] = ms;
      this.frameHead = (this.frameHead + 1) % this.frameMs.length;
      this.frameCount = Math.min(this.frameCount + 1, this.frameMs.length);
    }
  }

  phase(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let entry = this.phases.get(name);
    if (!entry) { entry = { count: 0, lastMs: 0, totalMs: 0, maxMs: 0 }; this.phases.set(name, entry); }
    entry.count++;
    entry.lastMs = ms;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
  }

  snapshot(quality: 'full' | 'moving', dpr: number, drawCalls: number | null = null) {
    const frames: number[] = [];
    for (let i = 0; i < this.frameCount; i++)
      frames.push(this.frameMs[(this.frameHead - this.frameCount + i + this.frameMs.length) % this.frameMs.length]!);
    const flowFrames: number[] = [];
    for (let i = 0; i < this.flowCount; i++)
      flowFrames.push(this.flowMs[(this.flowHead - this.flowCount + i + this.flowMs.length) % this.flowMs.length]!);
    const jsHeapBytes = (globalThis.performance as Performance & { memory?: { usedJSHeapSize?: number } } | undefined)
      ?.memory?.usedJSHeapSize ?? null;
    return { frameJsMs: frames, flowJsMs: flowFrames, phases: Object.fromEntries(this.phases),
      quality, dpr, drawCalls, jsHeapBytes };
  }
}
