import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addScaledInPlace,
  createMatrix,
  dot,
  frobeniusNorm,
  gramMatrix,
  identityMatrix,
  largestEntryIndex,
  matVec,
  maxAbs,
  modifiedGramSchmidtTwice,
  norm2,
  orthogonalityDefect,
  scaleInPlace,
  sumEntries,
  transposeMatVec,
} from '../../src/holographic/linear-algebra.ts';

test('dot and norm2 match hand arithmetic, including orthogonality', () => {
  assert.equal(dot(Float64Array.from([1, 2, 3]), Float64Array.from([4, -5, 6])), 12);
  assert.equal(dot(Float64Array.from([1, 0]), Float64Array.from([0, 1])), 0);
  assert.equal(norm2(Float64Array.from([3, 4])), 5);
  assert.equal(norm2(new Float64Array(3)), 0);
  const x = Float64Array.from([0.3, -1.2, 2.5]);
  assert.equal(norm2(Float64Array.from(x.map((value) => 2 * value))), 2 * norm2(x));
});

test('matVec and transposeMatVec honour the column-major layout', () => {
  // A = [[1,2,3],[4,5,6]] (2 rows, 3 cols); column-major data is [1,4,2,5,3,6].
  const matrix = createMatrix(2, 3);
  matrix.data.set([1, 4, 2, 5, 3, 6]);
  const ones = Float64Array.from([1, 1, 1]);
  assert.deepEqual(matVec(matrix, ones), Float64Array.from([6, 15]));
  assert.deepEqual(transposeMatVec(matrix, Float64Array.from([1, 2])), Float64Array.from([9, 12, 15]));
});

test('frobeniusNorm and gramMatrix agree with hand values', () => {
  const matrix = createMatrix(2, 2);
  matrix.data.set([3, 0, 4, 0]); // columns (3,0) and (4,0) -> A = [[3,4],[0,0]]
  assert.equal(frobeniusNorm(matrix), 5);
  const gram = gramMatrix([Float64Array.from([1, 2]), Float64Array.from([3, 4])]);
  assert.deepEqual(gram.data, Float64Array.from([5, 11, 11, 25]));
});

test('orthogonalityDefect is zero for orthonormal columns and sqrt(2) for a duplicated column', () => {
  const e1 = Float64Array.from([1, 0, 0]);
  const e2 = Float64Array.from([0, 1, 0]);
  assert.equal(orthogonalityDefect([e1, e2]), 0);
  assert.ok(Math.abs(orthogonalityDefect([Float64Array.from([1, 0]), Float64Array.from([1, 0])]) - Math.sqrt(2)) < 1e-15);
  const identity = identityMatrix(5);
  const columns = Array.from({ length: 5 }, (_unused, index) => identity.data.subarray(index * 5, (index + 1) * 5));
  assert.equal(orthogonalityDefect(columns), 0);
});

test('modifiedGramSchmidtTwice orthogonalises and detects exact dependence', () => {
  const e1 = Float64Array.from([1, 0, 0]);
  const e2 = Float64Array.from([0, 1, 0]);
  const w = Float64Array.from([1, 1, 1]);
  const norm = modifiedGramSchmidtTwice(w, [e1, e2]);
  assert.deepEqual(w, Float64Array.from([0, 0, 1]));
  assert.equal(norm, 1);
  const dependent = Float64Array.from([3, 0, 0]);
  assert.equal(modifiedGramSchmidtTwice(dependent, [e1]), 0);
  // A second application changes nothing beyond roundoff.
  const again = Float64Array.from([0.1, -0.7, 0.3]);
  modifiedGramSchmidtTwice(again, [e1, e2]);
  const normAfterFirst = norm2(again);
  modifiedGramSchmidtTwice(again, [e1, e2]);
  assert.ok(Math.abs(norm2(again) - normAfterFirst) < 1e-15);
  assert.equal(dot(again, e1), 0);
  assert.equal(dot(again, e2), 0);
});

test('in-place vector routines and reductions are exact on integer fixtures', () => {
  const target = Float64Array.from([1, 2, 3]);
  addScaledInPlace(target, Float64Array.from([10, 20, 30]), 2);
  assert.deepEqual(target, Float64Array.from([21, 42, 63]));
  scaleInPlace(target, -1);
  assert.deepEqual(target, Float64Array.from([-21, -42, -63]));
  assert.equal(sumEntries(target), -126);
  assert.equal(maxAbs(target), 63);
});

test('largestEntryIndex prefers the largest magnitude and breaks ties by smallest index', () => {
  assert.equal(largestEntryIndex(Float64Array.from([-5, 3, 5])), 0);
  assert.equal(largestEntryIndex(Float64Array.from([-7, 1, 3])), 0);
  assert.equal(largestEntryIndex(Float64Array.from([1, -9, 2])), 1);
});

test('shape violations are refused', () => {
  assert.throws(() => createMatrix(-1, 2), /invalid matrix shape/);
  assert.throws(() => dot(new Float64Array(2), new Float64Array(3)), /dot operands/);
  assert.throws(() => addScaledInPlace(new Float64Array(2), new Float64Array(3), 1), /addScaledInPlace/);
});
