/** D-080 A5b: a small page-owned cache for completed projection and layout results. */
import type { LayoutInput } from '../review/layout-v2.ts';

/** Includes the source digest and every argument passed to computeLayout. */
export function pageLayoutKey(sourceDigest: string, input: LayoutInput): string {
  return JSON.stringify([sourceDigest, input.nodes, input.edges, input.organization,
    input.morphology, input.projection, input.expandZ ?? null,
    input.previous ? [...input.previous] : null]);
}

export class PageResultCache<T> {
  readonly capacity: number;
  readonly byteLimit: number;
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  // D082-A-PERF BEGIN: a 50-mode tour must settle at a fixed, modest heap cap.
  constructor(capacity = 2, byteLimit = 8 * 1024 * 1024) {
  // D082-A-PERF END
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(byteLimit) || byteLimit < 1)
      throw new RangeError('Invalid page projection cache bounds');
    this.capacity = capacity;
    this.byteLimit = byteLimit;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    const bytes = estimateRetainedBytes(value) + key.length * 2;
    if (bytes > this.byteLimit) return;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.capacity || this.bytes > this.byteLimit) {
      const oldest = this.entries.keys().next().value as string;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  get stats() {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size,
      capacity: this.capacity, estimatedBytes: this.bytes, byteLimit: this.byteLimit };
  }
}

/** Conservative, cycle-safe estimate used only on insertion, never in a camera frame. */
export function estimateRetainedBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): number => {
    if (item === null || item === undefined) return 0;
    if (typeof item === 'string') return item.length * 2;
    if (typeof item === 'number' || typeof item === 'boolean') return 8;
    if (typeof item !== 'object' || seen.has(item)) return 0;
    seen.add(item);
    if (ArrayBuffer.isView(item)) return item.byteLength;
    if (item instanceof ArrayBuffer) return item.byteLength;
    if (item instanceof Map) {
      let bytes = 64;
      for (const [key, entry] of item) bytes += 24 + visit(key) + visit(entry);
      return bytes;
    }
    if (item instanceof Set) {
      let bytes = 64;
      for (const entry of item) bytes += 16 + visit(entry);
      return bytes;
    }
    let bytes = Array.isArray(item) ? 24 : 48;
    for (const [key, entry] of Object.entries(item)) bytes += key.length * 2 + 8 + visit(entry);
    return bytes;
  };
  return visit(value);
}
