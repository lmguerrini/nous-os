import test from "node:test";
import assert from "node:assert/strict";
import { percentile } from "../../src/review/perf-overlay.ts";
import { stellarDustAlpha, stellarDustFraction } from "#render-common/starfield.ts";

test("performance window computes exact median and p95, including an empty window", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([8, 2, 5, 4], 0.5), 4);
  assert.equal(percentile([8, 2, 5, 4], 0.95), 8);
});

test("decorative dust follows density and brightness with the default budget intact", () => {
  assert.equal(stellarDustFraction(0), 0);
  assert.equal(stellarDustFraction(0.125), 0.5);
  assert.equal(stellarDustFraction(0.25), 1);
  assert.equal(stellarDustFraction(1), 1);
  assert.equal(stellarDustAlpha(2, 0), 0);
  assert.equal(stellarDustAlpha(2, 0.35), 0.75);
  assert.ok(stellarDustAlpha(1, 1) > stellarDustAlpha(1, 0.35));
});
