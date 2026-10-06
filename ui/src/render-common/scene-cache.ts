/** Bounded exact-key cache for pure scene preparation. Values are immutable after publication. */
export class SceneCache<T> {
  readonly capacity: number;
  readonly byteLimit: number;
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private retainedBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  constructor(capacity = 2, byteLimit = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(byteLimit) || byteLimit < 1)
      throw new RangeError('Invalid scene cache bounds');
    this.capacity = capacity;
    this.byteLimit = byteLimit;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) { this.missCount++; return undefined; }
    this.hitCount++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): void {
    const bytes = key.length * 2 + sceneValueBytes(value);
    const previous = this.entries.get(key);
    if (previous) { this.retainedBytes -= previous.bytes; this.entries.delete(key); }
    if (bytes > this.byteLimit) return;
    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;
    while (this.entries.size > this.capacity || this.retainedBytes > this.byteLimit) {
      const oldest = this.entries.keys().next().value!;
      this.retainedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
  getOrBuild(key: string, build: () => T): T {
    const value = this.get(key);
    if (value !== undefined) return value;
    const next = build();
    this.set(key, next);
    return next;
  }
  clear(): void { this.entries.clear(); this.retainedBytes = 0; }
  get stats() { return { hits: this.hitCount, misses: this.missCount, size: this.entries.size,
    estimatedBytes: this.retainedBytes, byteLimit: this.byteLimit }; }
}

/** Count retained array storage and object fields only on insertion, outside frame loops. */
function sceneValueBytes(value: unknown): number {
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
      let bytes = 48;
      for (const [key, entry] of item) bytes += 24 + visit(key) + visit(entry);
      return bytes;
    }
    if (item instanceof Set) {
      let bytes = 48;
      for (const entry of item) bytes += 16 + visit(entry);
      return bytes;
    }
    let bytes = Array.isArray(item) ? 24 : 48;
    for (const [key, entry] of Object.entries(item)) bytes += key.length * 2 + 8 + visit(entry);
    return bytes;
  };
  return visit(value);
}

/** Cache identity includes the full positioned scene, reading/style inputs and geometry version. */
export function preparedSceneKey(version: string, scene: {
  readonly nodes: unknown; readonly edges: unknown; readonly aggregates: unknown;
  readonly tokens: unknown; readonly tokenEncoding: unknown;
}): string {
  return JSON.stringify([version, scene.nodes, scene.edges, scene.aggregates, scene.tokens, scene.tokenEncoding]);
}
