import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STAR_CACHE_CAP,
  STARFIELD_MAX_STARS,
  cachedStarfieldStars,
  resetStarfieldCache,
  starfieldStars,
} from "#render-common/starfield.ts";

test("the star cache serves the identical array for the same key, equal to the pure list", () => {
  resetStarfieldCache();
  const first = cachedStarfieldStars(800, 600, 0.25);
  const second = cachedStarfieldStars(800, 600, 0.25);
  assert.equal(first, second, "the same key must not regenerate up to 2200 star objects per frame");
  assert.deepEqual(first, starfieldStars(800, 600, 0.25));
  assert.ok(first.length > 0 && first.length <= STARFIELD_MAX_STARS);
  // A different key is a different list, never a stale hit.
  assert.notEqual(cachedStarfieldStars(1024, 600, 0.25), first);
});

test("every distinct key still returns its exact pure list after the cache has been through its cap", () => {
  resetStarfieldCache();
  const keys = Array.from({ length: STAR_CACHE_CAP + 4 }, (_, index) => ({ width: 320 + index, height: 240, density: 0.1 + index * 0.05 }));
  for (const key of keys) cachedStarfieldStars(key.width, key.height, key.density);
  for (const key of keys)
    assert.deepEqual(cachedStarfieldStars(key.width, key.height, key.density), starfieldStars(key.width, key.height, key.density),
      `key ${key.width}x${key.height}@${key.density} served a wrong list after the cap reset`);
});

test("degenerate keys draw nothing and cache nothing that a real key could hit", () => {
  resetStarfieldCache();
  assert.equal(cachedStarfieldStars(0, 600, 0.25).length, 0);
  assert.equal(cachedStarfieldStars(800, 0, 0.25).length, 0);
  assert.equal(cachedStarfieldStars(800, 600, 0).length, 0);
});
