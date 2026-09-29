import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProjectionRegistry, ProjectionResultCache, projectionCacheKeyDigest, projectionParameterDigest,
  type ProjectionCacheKey,
  PROJECTION_CACHE_CAPACITY,
} from "../../src/projection/registry.ts";
import type { SemanticGraphSnapshot } from "../../src/projection/contract-types.ts";

const snapshot = { digest: "snap-a" } as SemanticGraphSnapshot;
const parameters = {
  dimension: "3d" as const,
  arrangement: "mycelium",
  relationPolicy: "combined-essential",
  volume: { x: 1.25, y: 2, z: 0.75 },
  continuityAnchor: { "n:b": { x: 2.5, y: 0, z: 1 }, "n:a": { x: -1, y: 3, z: 0 } },
};
const key: ProjectionCacheKey = {
  snapshotDigest: "snap-a", domainDigest: "domain-a", algorithmId: "natural", algorithmVersion: "v1",
  parameters, requestedLevelId: "level-2",
};

test("parameter digest ignores object insertion order and preserves array order", () => {
  assert.equal(projectionParameterDigest({ a: 1, b: { x: 0.5, y: 2 } }),
    projectionParameterDigest({ b: { y: 2, x: 0.5 }, a: 1 }));
  assert.notEqual(projectionParameterDigest({ values: [1, 2] }), projectionParameterDigest({ values: [2, 1] }));
  assert.notEqual(projectionParameterDigest({ x: 0 }), projectionParameterDigest({ x: -0 }));
  assert.throws(() => projectionParameterDigest({ x: Infinity }), /finite/);
});

test("cache key is deterministic for permuted parameters and changes for every identity input", async () => {
  const permuted: ProjectionCacheKey = {
    requestedLevelId: "level-2", parameters: {
      continuityAnchor: { "n:a": { z: 0, y: 3, x: -1 }, "n:b": { z: 1, x: 2.5, y: 0 } },
      volume: { z: 0.75, x: 1.25, y: 2 }, relationPolicy: "combined-essential",
      arrangement: "mycelium", dimension: "3d",
    }, algorithmVersion: "v1", algorithmId: "natural", domainDigest: "domain-a", snapshotDigest: "snap-a",
  };
  const digest = projectionCacheKeyDigest(key);
  assert.equal(digest, projectionCacheKeyDigest(permuted));
  const changes: ProjectionCacheKey[] = [
    { ...key, snapshotDigest: "snap-b" }, { ...key, domainDigest: "domain-b" },
    { ...key, algorithmId: "fractal" }, { ...key, algorithmVersion: "v2" },
    { ...key, requestedLevelId: "level-3" },
    { ...key, parameters: { ...parameters, arrangement: "network" } },
    { ...key, parameters: { ...parameters, relationPolicy: "attested-essential" } },
    { ...key, parameters: { ...parameters, volume: { ...parameters.volume, y: 2.1 } } },
    { ...key, parameters: { ...parameters, continuityAnchor: { "n:a": { x: 5, y: 3, z: 0 } } } },
    { ...key, parameters: { ...parameters, dimension: "2d" } },
  ];
  for (const changed of changes) assert.notEqual(projectionCacheKeyDigest(changed), digest);
  const { requestedLevelId: _levelId, ...withoutLevel } = key;
  assert.notEqual(projectionCacheKeyDigest(withoutLevel), digest);
  const cache = new ProjectionResultCache<string>();
  assert.equal((await cache.getOrCompute(digest, () => "base")).hit, false);
  assert.equal((await cache.getOrCompute(projectionCacheKeyDigest(permuted), () => "wrong")).hit, true);
  for (const changed of changes)
    assert.equal((await cache.getOrCompute(projectionCacheKeyDigest(changed), () => "changed")).hit, false);
  assert.throws(() => projectionCacheKeyDigest({ ...key, parameters: { arrangement: "mycelium" } }), /dimension/);
});

test("registry accepts future plugin IDs without importing an implementation and reports hits", async () => {
  const registry = new ProjectionRegistry();
  let calls = 0;
  registry.register({ id: "indra-legacy", version: "packing-v4", project: (_snapshot, request: { value: number }) => {
    calls += 1;
    return { answer: request.value };
  } });
  const request = { snapshotDigest: "snap-a", domain: { snapshotDigest: "snap-a", domainDigest: "domain-a" },
    parameters: { dimension: "2d" as const, level: 5, tune: 0.25 }, value: 42 };
  const first = await registry.project<{ answer: number }>("indra-legacy", snapshot, request);
  const repeated = await registry.project<{ answer: number }>("indra-legacy", snapshot, request);
  assert.equal(first.cacheHit, false);
  assert.equal(repeated.cacheHit, true);
  assert.equal(first.cacheKeyDigest, repeated.cacheKeyDigest);
  assert.deepEqual(first.result, { answer: 42 });
  assert.equal(calls, 1);
  assert.deepEqual(registry.ids(), ["indra-legacy"]);
  assert.throws(() => registry.register({ id: "indra-legacy", version: "v1", project: () => ({}) }), /already registered/);
});

test("explicit invalidation and bounded LRU eviction retain only the documented cap", async () => {
  const cache = new ProjectionResultCache<number>(2);
  let runs = 0;
  const compute = () => ++runs;
  assert.equal((await cache.getOrCompute("a", compute)).hit, false);
  assert.equal((await cache.getOrCompute("b", compute)).hit, false);
  assert.equal(cache.get("a"), 1); // refresh a, making b the least-recently used entry
  await cache.getOrCompute("c", compute);
  assert.equal(cache.stats.size, 2);
  assert.equal(cache.get("b"), undefined);
  assert.equal((await cache.getOrCompute("a", compute)).hit, true);
  assert.equal(cache.invalidate("a"), 1);
  assert.equal((await cache.getOrCompute("a", compute)).hit, false);
  assert.equal(cache.invalidate(), 2);
  assert.equal(cache.stats.size, 0);
  assert.equal(PROJECTION_CACHE_CAPACITY, 128);
  assert.equal(cache.stats.capacity, 2);
  assert.equal(runs, 4);
});

test("overlapping identical requests share one computation and the waiter is a hit", async () => {
  const cache = new ProjectionResultCache<number>();
  let calls = 0;
  let resolve: ((value: number) => void) | undefined;
  const compute = () => {
    calls += 1;
    return new Promise<number>(done => { resolve = done; });
  };
  const firstPromise = cache.getOrCompute("same", compute);
  const secondPromise = cache.getOrCompute("same", compute);
  assert.equal(calls, 0); // compute is scheduled after the pending slot is installed
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve?.(7);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(first, { value: 7, hit: false });
  assert.deepEqual(second, { value: 7, hit: true });
  assert.equal(calls, 1);
});

test("snapshot/domain mismatch is rejected before plugin execution", async () => {
  const registry = new ProjectionRegistry();
  registry.register({ id: "natural", version: "v1", project: () => assert.fail("must not run") });
  await assert.rejects(registry.project("natural", snapshot, {
    snapshotDigest: "other", domain: { snapshotDigest: "other", domainDigest: "domain-a" },
    parameters: { dimension: "2d" },
  }), /snapshot digest mismatch/);
});
