import assert from "node:assert/strict";
import test from "node:test";
import {
  arcLength,
  positionAtDistance,
  reducedMotionPosition,
} from "#engine/propagation.ts";
import type { PropagationPath } from "#engine/propagation.ts";

/** This samples one curve at supplied parameters and does not use path position code. */
function sampledPath(parameters: readonly number[]): PropagationPath {
  return {
    controlPoints: parameters.map((parameter) => ({
      x: parameter,
      y: parameter * parameter,
      z: 0,
    })),
  };
}

/** This is an intentionally index-parameterized control and does not measure segments. */
function indexPosition(path: PropagationPath, travelledDistance: number): { readonly x: number; readonly y: number; readonly z: number } {
  const fraction = travelledDistance / arcLength(path);
  const index = fraction * (path.controlPoints.length - 1);
  const lower = Math.floor(index);
  const upper = Math.min(lower + 1, path.controlPoints.length - 1);
  const amount = index - lower;
  const start = path.controlPoints[lower];
  const end = path.controlPoints[upper];
  if (start === undefined || end === undefined) {
    throw new TypeError("control path is empty");
  }
  return {
    x: start.x + ((end.x - start.x) * amount),
    y: start.y + ((end.y - start.y) * amount),
    z: start.z + ((end.z - start.z) * amount),
  };
}

/** This measures point separation and does not call propagation position code. */
function separation(left: { readonly x: number; readonly y: number; readonly z: number }, right: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

test("arc-length positions agree for uniform and clustered curve sampling", () => {
  const uniform = sampledPath(Array.from({ length: 101 }, (_, index) => index / 100));
  const clustered = sampledPath(Array.from({ length: 101 }, (_, index) => (index / 100) ** 3));
  const pathLength = arcLength(uniform);
  const clusteredLength = arcLength(clustered);
  assert.ok(pathLength > 0);
  assert.ok(clusteredLength > 0);
  const fractions = [0.2, 0.5, 0.8];
  assert.equal(fractions.length, 3);
  for (const fraction of fractions) {
    const uniformPosition = positionAtDistance(uniform, pathLength * fraction);
    const clusteredPosition = positionAtDistance(clustered, clusteredLength * fraction);
    assert.ok(separation(uniformPosition, clusteredPosition) <= pathLength * 0.01);
  }
  assert.equal(fractions.length, 3);
});

test("an index-parameterized control fails clustered-sampling invariance", () => {
  const uniform = sampledPath(Array.from({ length: 101 }, (_, index) => index / 100));
  const clustered = sampledPath(Array.from({ length: 101 }, (_, index) => (index / 100) ** 3));
  const distance = arcLength(uniform) / 2;
  const correct = positionAtDistance(uniform, distance);
  const control = indexPosition(clustered, distance);
  assert.ok(separation(correct, control) > arcLength(uniform) * 0.01);
});

test("an equal-arc index implementation passes behaviorally", () => {
  const equalArc: PropagationPath = {
    controlPoints: Array.from({ length: 101 }, (_, index) => ({ x: index / 100, y: 0, z: 0 })),
  };
  const fractions = [0.2, 0.5, 0.8];
  assert.equal(fractions.length, 3);
  for (const fraction of fractions) {
    const distance = arcLength(equalArc) * fraction;
    assert.ok(separation(positionAtDistance(equalArc, distance), indexPosition(equalArc, distance)) <= arcLength(equalArc) * 0.01);
  }
  assert.equal(fractions.length, 3);
});

test("reduced motion stops continuous travel while expressing the endpoint", () => {
  const path: PropagationPath = { controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }] };
  const reduced = reducedMotionPosition(path, 0, true);
  const ordinary = reducedMotionPosition(path, 0, false);
  assert.equal(arcLength(path), 5);
  assert.deepEqual(reduced.position, { x: 3, y: 4, z: 0 });
  assert.equal(reduced.continuous, false);
  assert.equal(reduced.endpointExpressed, true);
  assert.deepEqual(ordinary.position, { x: 0, y: 0, z: 0 });
  assert.equal(ordinary.continuous, true);
  assert.equal(ordinary.endpointExpressed, false);
});
