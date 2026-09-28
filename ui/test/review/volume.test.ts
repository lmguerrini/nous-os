import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point3 } from "../../src/review/layout-v2.ts";
import { applyExpansion, canonicalize, equilibrate, rotateToPrincipalAxes, volumeStats } from "../../src/review/volume.ts";

/** Deterministic LCG in [0,1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function unitBall(count: number, seed = 7): Point3[] {
  const next = lcg(seed);
  const points: Point3[] = [];
  while (points.length < count) {
    const x = next() * 2 - 1, y = next() * 2 - 1, z = next() * 2 - 1;
    if (x * x + y * y + z * z <= 1) points.push({ x, y, z });
  }
  return points;
}

test("volumeStats: a flat sheet has λ3/λ1 below 0.05 and a ball above 0.6", () => {
  const next = lcg(11);
  const flat: Point3[] = Array.from({ length: 300 }, () => ({ x: (next() * 2 - 1) * 100, y: (next() * 2 - 1) * 100, z: 0 }));
  const sheet = volumeStats(flat);
  assert.ok(sheet.ratios.third < 0.05, `flat λ3/λ1 ${sheet.ratios.third}`);
  assert.ok(sheet.eigenvalues[0] >= sheet.eigenvalues[1] && sheet.eigenvalues[1] >= sheet.eigenvalues[2]);

  const ball = volumeStats(unitBall(400));
  assert.ok(ball.ratios.third > 0.6, `ball λ3/λ1 ${ball.ratios.third}`);
});

test("volumeStats trims the 2% farthest outliers and reports the trim count", () => {
  const points = unitBall(100);
  const withOutlier = [...points, { x: 1e6, y: 0, z: 0 }, { x: -1e6, y: 0, z: 0 }];
  const stats = volumeStats(withOutlier);
  assert.ok(stats.trimmed >= 2, `trimmed ${stats.trimmed}`);
  assert.ok(stats.count === 102);
  // A couple of extreme outliers must not collapse the ball into a needle.
  assert.ok(stats.ratios.third > 0.5, `robust λ3/λ1 ${stats.ratios.third}`);
});

test("applyExpansion scales each axis exactly and never changes ids", () => {
  const positions = new Map<string, Point3>([
    ["a", { x: 1, y: -2, z: 3 }],
    ["b", { x: 4, y: 5, z: -6 }],
  ]);
  const scaled = applyExpansion(positions, { expandX: 2, expandY: 3, expandZ: 4 });
  assert.deepEqual(scaled.get("a"), { x: 2, y: -6, z: 12 });
  assert.deepEqual(scaled.get("b"), { x: 8, y: 15, z: -24 });
  assert.deepEqual([...scaled.keys()], ["a", "b"]);
  assert.deepEqual(positions.get("a"), { x: 1, y: -2, z: 3 });
});

test("equilibrate balances a squashed ellipsoid to ratios ≥ 0.6", () => {
  const ball = unitBall(400, 23);
  const squashed = ball.map(point => ({ x: point.x * 100, y: point.y * 100, z: point.z * 35 }));
  assert.ok(volumeStats(squashed).ratios.third < 0.6, "fixture must start squashed");
  const expansion = equilibrate(squashed);
  const squashedMap = new Map(squashed.map((point, index) => [`n${index}`, point] as const));
  const balanced = applyExpansion(squashedMap, expansion);
  assert.ok(volumeStats(balanced).ratios.third >= 0.6, `balanced λ3/λ1 ${volumeStats(balanced).ratios.third.toFixed(3)}`);
  // The overall size is preserved: the geometric mean of the expansion is 1.
  assert.ok(Math.abs(expansion.expandX * expansion.expandY * expansion.expandZ - 1) < 1e-6);
});

test("volumeStats and equilibrate are deterministic", () => {
  const points = unitBall(150, 5).map(point => ({ x: point.x * 50, y: point.y * 60, z: point.z * 20 }));
  assert.deepEqual(volumeStats(points), volumeStats(points));
  assert.deepEqual(equilibrate(points), equilibrate(points));
  const map = new Map(points.map((point, index) => [`n${index}`, point] as const));
  assert.deepEqual(volumeStats(map), volumeStats(points));
});

test("canonicalize rotates a tilted elongated cloud into principal axes and normalises anisotropy", () => {
  const next = lcg(31);
  // A cloud elongated along a tilted axis: its principal axis is not aligned with X, Y or Z, so a plain
  // diagonal scaling (the old equilibrate path) could not fix it — the rotation must happen first.
  const points: Point3[] = Array.from({ length: 400 }, () => {
    const a = next() * 2 - 1, b = next() * 2 - 1, c = next() * 2 - 1;
    return { x: a * 90 + b * 8 + c * 4, y: a * 60 + b * 30 + c * 6, z: a * 12 + b * 5 + c * 40 };
  });
  const before = volumeStats(points);
  const canonical = canonicalize(points);
  const stats = volumeStats(canonical);
  assert.ok(stats.ratios.second >= 0.5, `λ2/λ1 ${stats.ratios.second.toFixed(3)}`);
  assert.ok(stats.ratios.third >= 0.3, `λ3/λ1 ${stats.ratios.third.toFixed(3)}`);
  assert.ok(stats.ratios.second >= before.ratios.second, "canonicalise must never worsen λ2/λ1");
  assert.ok(stats.ratios.third >= before.ratios.third, "canonicalise must never worsen λ3/λ1");
  // The canonical frame's covariance is diagonal, so equilibrate is exact and reaches a ball.
  const balanced = applyExpansion(canonical, equilibrate(canonical));
  assert.ok(volumeStats(balanced).ratios.second >= 0.6, `balanced λ2/λ1 ${volumeStats(balanced).ratios.second.toFixed(3)}`);
  assert.ok(volumeStats(balanced).ratios.third >= 0.6, `balanced λ3/λ1 ${volumeStats(balanced).ratios.third.toFixed(3)}`);
});

test("canonicalize and rotateToPrincipalAxes are deterministic and preserve ids", () => {
  const ball = unitBall(200, 7);
  assert.deepEqual(canonicalize(ball), canonicalize(ball));
  assert.deepEqual(rotateToPrincipalAxes(ball), rotateToPrincipalAxes(ball));
  const map = new Map(ball.map((point, index) => [`n${index}`, point] as const));
  assert.deepEqual([...canonicalize(map).keys()], [...map.keys()]);
});
