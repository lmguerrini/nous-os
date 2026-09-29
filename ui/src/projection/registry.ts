import { digestPayload } from "../engine/digest.ts";
import type {
  Dimension, ProjectionId, ProjectionRequest, ProjectionResult, SemanticGraphSnapshot,
} from "./contract-types.ts";

/** Bounded cache cap: at most 128 completed projections are retained per registry. */
export const PROJECTION_CACHE_CAPACITY = 128;

export type RegisteredProjectionId = ProjectionId | "indra-legacy";

/** Common seam for current and future projection modules, including the legacy adapter. */
export interface ProjectionPlugin<Request = unknown, Result = unknown> {
  readonly id: RegisteredProjectionId;
  readonly version: string;
  project(snapshot: SemanticGraphSnapshot, request: Request): Promise<Result> | Result;
}

export interface ProjectionCacheKey {
  readonly snapshotDigest: string;
  readonly domainDigest: string;
  readonly algorithmId: RegisteredProjectionId;
  readonly algorithmVersion: string;
  readonly parameters: unknown;
  readonly requestedLevelId?: string;
}

export interface ProjectionCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
  readonly capacity: number;
}

/** Canonical typed encoding supports finite fractional projection parameters and ignores object insertion order. */
export function projectionParameterDigest(value: unknown): string {
  return digestPayload(toCanonicalTree(value));
}

/** A cache key includes every contract input that can affect mathematical output. */
export function projectionCacheKeyDigest(key: ProjectionCacheKey): string {
  const dimension = key.parameters !== null && typeof key.parameters === "object"
    ? (key.parameters as { dimension?: unknown }).dimension
    : undefined;
  if (dimension !== "2d" && dimension !== "3d") throw new TypeError("projection parameters must declare dimension");
  const canonical = [
    "projection-cache-key-v1", key.snapshotDigest, key.domainDigest, key.algorithmId,
    key.algorithmVersion, dimension, projectionParameterDigest(key.parameters),
    key.requestedLevelId === undefined ? null : key.requestedLevelId,
  ];
  return digestPayload(canonical);
}

/** LRU result cache. invalidate() is explicit; entries are never invalidated by hidden time or page state. */
export class ProjectionResultCache<Result = unknown> {
  readonly #capacity: number;
  readonly #entries = new Map<string, Result>();
  readonly #pending = new Map<string, Promise<Result>>();
  #hits = 0;
  #misses = 0;

  constructor(capacity = PROJECTION_CACHE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("cache capacity must be a positive integer");
    this.#capacity = capacity;
  }

  get(keyDigest: string): Result | undefined {
    if (!this.#entries.has(keyDigest)) return undefined;
    const value = this.#entries.get(keyDigest) as Result;
    this.#entries.delete(keyDigest);
    this.#entries.set(keyDigest, value);
    this.#hits += 1;
    return value;
  }

  async getOrCompute(keyDigest: string, compute: () => Promise<Result> | Result): Promise<Readonly<{ value: Result; hit: boolean }>> {
    const existing = this.get(keyDigest);
    if (existing !== undefined) return { value: existing, hit: true };
    const pending = this.#pending.get(keyDigest);
    if (pending !== undefined) {
      this.#hits += 1;
      return { value: await pending, hit: true };
    }
    this.#misses += 1;
    const task = Promise.resolve().then(compute);
    this.#pending.set(keyDigest, task);
    try {
      const value = await task;
      this.#entries.delete(keyDigest);
      this.#entries.set(keyDigest, value);
      while (this.#entries.size > this.#capacity) {
        const oldest = this.#entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#entries.delete(oldest);
      }
      return { value, hit: false };
    } finally {
      if (this.#pending.get(keyDigest) === task) this.#pending.delete(keyDigest);
    }
  }

  invalidate(keyDigest?: string): number {
    if (keyDigest !== undefined) return this.#entries.delete(keyDigest) ? 1 : 0;
    const removed = this.#entries.size;
    this.#entries.clear();
    return removed;
  }

  get stats(): ProjectionCacheStats {
    return { hits: this.#hits, misses: this.#misses, size: this.#entries.size, capacity: this.#capacity };
  }
}

export interface RegistryProjectionRequest {
  readonly snapshotDigest: string;
  readonly domain: Readonly<{ snapshotDigest: string; domainDigest: string }>;
  readonly parameters: Readonly<{ dimension: Dimension; [key: string]: unknown }>;
  readonly requestedLevelId?: string;
}

export interface RegistryProjectionOutcome<Result> {
  readonly result: Result;
  readonly cacheHit: boolean;
  readonly cacheKeyDigest: string;
}

/** Registers plugins without importing any projection implementation. */
export class ProjectionRegistry {
  readonly #plugins = new Map<RegisteredProjectionId, ProjectionPlugin<any, any>>();
  readonly cache: ProjectionResultCache<unknown>;

  constructor(cache = new ProjectionResultCache()) { this.cache = cache; }

  register<Request, Result>(plugin: ProjectionPlugin<Request, Result>): void {
    if (!plugin.version.trim()) throw new TypeError("projection version must be non-empty");
    if (this.#plugins.has(plugin.id)) throw new Error(`projection already registered: ${plugin.id}`);
    this.#plugins.set(plugin.id, plugin);
  }

  unregister(id: RegisteredProjectionId): boolean { return this.#plugins.delete(id); }

  has(id: RegisteredProjectionId): boolean { return this.#plugins.has(id); }

  ids(): readonly RegisteredProjectionId[] { return [...this.#plugins.keys()].sort(); }

  async project<Result = ProjectionResult>(
    id: RegisteredProjectionId,
    snapshot: SemanticGraphSnapshot,
    request: RegistryProjectionRequest | ProjectionRequest,
  ): Promise<RegistryProjectionOutcome<Result>> {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new Error(`projection is not registered: ${id}`);
    if (request.snapshotDigest !== snapshot.digest || request.domain.snapshotDigest !== snapshot.digest)
      throw new Error("projection request snapshot digest mismatch");
    const keyDigest = projectionCacheKeyDigest({
      snapshotDigest: request.snapshotDigest,
      domainDigest: request.domain.domainDigest,
      algorithmId: id,
      algorithmVersion: plugin.version,
      parameters: request.parameters,
      ...(request.requestedLevelId === undefined ? {} : { requestedLevelId: request.requestedLevelId }),
    });
    const outcome = await this.cache.getOrCompute(keyDigest, () => plugin.project(snapshot, request));
    return { result: outcome.value as Result, cacheHit: outcome.hit, cacheKeyDigest: keyDigest };
  }
}

function toCanonicalTree(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("projection parameters require finite numbers");
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (Array.isArray(value)) return ["array", value.map(toCanonicalTree)];
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("projection parameters must be plain JSON objects");
    const keys = Object.keys(value).sort(compareCodepoints);
    if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError("projection parameters cannot have hidden or symbol keys");
    return ["object", keys.map(key => [key, toCanonicalTree((value as Record<string, unknown>)[key])])];
  }
  throw new TypeError(`unsupported projection parameter: ${typeof value}`);
}

function compareCodepoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}
