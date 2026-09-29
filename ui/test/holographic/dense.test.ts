import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DENSE_BENCHMARK_MAX_N,
  DENSE_BENCHMARK_OPT_IN,
  DENSE_DEFAULT_MAX_N,
  denseLaplacian,
  solveDenseSymmetricEigen,
  type DenseSymmetricMatrix,
} from '../../src/holographic/dense.ts';
import { buildSpectralGraph } from '../../src/holographic/adjacency.ts';
import { cycleGraph, completeGraph, noiseVector, pathGraph, ringLatticeGraph, starGraph } from './fixtures.ts';

function column(matrix: Float64Array, n: number, col: number): Float64Array {
  return matrix.subarray(col * n, (col + 1) * n);
}

test('the path of three nodes solves to eigenvalues 0, 1, 3 with the known eigenvectors', () => {
  const graph = pathGraph(3);
  const solution = solveDenseSymmetricEigen(denseLaplacian(graph));
  assert.deepEqual(Array.from(solution.eigenvalues.map((value) => Math.round(value * 1e9) / 1e9)), [0, 1, 3]);
  assert.ok(Math.abs(solution.eigenvalues[0]!) < 1e-12);
  assert.ok(Math.abs(solution.eigenvalues[1]! - 1) < 1e-12);
  assert.ok(Math.abs(solution.eigenvalues[2]! - 3) < 1e-12);
  // lambda = 1 mode [1, 0, -1]/sqrt(2), sign-fixed so the first pivot entry is positive.
  const mode1 = column(solution.eigenvectors, 3, 1);
  assert.ok(Math.abs(mode1[0]! - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(mode1[1]!) < 1e-12);
  assert.ok(Math.abs(mode1[2]! + Math.SQRT1_2) < 1e-12);
  // lambda = 3 mode [-1, 2, -1]/sqrt(6) after the largest-|entry| sign fix.
  const mode3 = column(solution.eigenvectors, 3, 2);
  const expected = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
  for (let index = 0; index < 3; index += 1) assert.ok(Math.abs(mode3[index]! - expected[index]!) < 1e-12);
  assert.ok(solution.maxAbsResidual < 1e-12);
  assert.ok(solution.orthogonalityDefect < 1e-13);
});

test('identity and diagonal matrices solve exactly in ascending order', () => {
  const identity: DenseSymmetricMatrix = { n: 4, values: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  const identitySolution = solveDenseSymmetricEigen(identity);
  assert.deepEqual(Array.from(identitySolution.eigenvalues), [1, 1, 1, 1]);
  assert.equal(identitySolution.rotations, 0);

  const diagonal: DenseSymmetricMatrix = { n: 3, values: Float64Array.from([3, 0, 0, 0, -1, 0, 0, 0, 2]) };
  const diagonalSolution = solveDenseSymmetricEigen(diagonal);
  assert.deepEqual(Array.from(diagonalSolution.eigenvalues), [-1, 2, 3]);
  // Columns: eigenvalue -1 -> e2, eigenvalue 2 -> e3, eigenvalue 3 -> e1 (column-major).
  assert.deepEqual(Array.from(diagonalSolution.eigenvectors), [0, 1, 0, 0, 0, 1, 1, 0, 0]);
});

test('the 2x2 fixture [[2,1],[1,2]] solves to 1 and 3 with sign-fixed vectors', () => {
  const matrix: DenseSymmetricMatrix = { n: 2, values: Float64Array.from([2, 1, 1, 2]) };
  const solution = solveDenseSymmetricEigen(matrix);
  assert.ok(Math.abs(solution.eigenvalues[0]! - 1) < 1e-14);
  assert.ok(Math.abs(solution.eigenvalues[1]! - 3) < 1e-14);
  const first = column(solution.eigenvectors, 2, 0);
  const second = column(solution.eigenvectors, 2, 1);
  assert.ok(Math.abs(first[0]! - Math.SQRT1_2) < 1e-14 && Math.abs(first[1]! + Math.SQRT1_2) < 1e-14);
  assert.ok(Math.abs(second[0]! - Math.SQRT1_2) < 1e-14 && Math.abs(second[1]! - Math.SQRT1_2) < 1e-14);
});

test('weighted and directed two-node Laplacians solve to their exact spectra', () => {
  const weighted = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'w', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 3 }],
  });
  const weightedSolution = solveDenseSymmetricEigen(denseLaplacian(weighted));
  assert.ok(Math.abs(weightedSolution.eigenvalues[0]!) < 1e-14);
  assert.ok(Math.abs(weightedSolution.eigenvalues[1]! - 6) < 1e-14);

  const directed = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'd', source: 'a', target: 'b', directed: true, attestation: 'attested', weight: 2 }],
  });
  const directedSolution = solveDenseSymmetricEigen(denseLaplacian(directed));
  assert.ok(Math.abs(directedSolution.eigenvalues[1]! - 2) < 1e-14);
});

test('tie fixtures: complete K5 gives 0,5,5,5,5 and cycle C4 gives 0,2,2,4', () => {
  const complete = solveDenseSymmetricEigen(denseLaplacian(completeGraph(5)));
  for (const [index, expected] of [0, 5, 5, 5, 5].entries()) {
    assert.ok(Math.abs(complete.eigenvalues[index]! - expected) < 1e-12, `K5 eigenvalue ${index}`);
  }
  const cycle = solveDenseSymmetricEigen(denseLaplacian(cycleGraph(4)));
  for (const [index, expected] of [0, 2, 2, 4].entries()) {
    assert.ok(Math.abs(cycle.eigenvalues[index]! - expected) < 1e-12, `C4 eigenvalue ${index}`);
  }
});

test('symmetric invariants: eigenvalue sum equals the trace and squares equal the Frobenius norm', () => {
  const n = 30;
  const stream = noiseVector((n * (n + 1)) / 2, 'dense-invariants');
  const values = new Float64Array(n * n);
  let cursor = 0;
  let trace = 0;
  let frobeniusSquared = 0;
  for (let col = 0; col < n; col += 1) {
    for (let row = col; row < n; row += 1) {
      const value = row === col ? stream[cursor++]! + 2 : stream[cursor++]!;
      values[row + col * n] = value;
      values[col + row * n] = value;
      if (row === col) trace += value;
      frobeniusSquared += row === col ? value * value : 2 * value * value;
    }
  }
  const solution = solveDenseSymmetricEigen({ n, values });
  const eigenvalueSum = Array.from(solution.eigenvalues).reduce((sum, value) => sum + value, 0);
  const eigenvalueSquaredSum = Array.from(solution.eigenvalues).reduce((sum, value) => sum + value * value, 0);
  assert.ok(Math.abs(eigenvalueSum - trace) < 1e-9 * Math.abs(trace));
  assert.ok(Math.abs(eigenvalueSquaredSum - frobeniusSquared) < 1e-9 * frobeniusSquared);
  assert.ok(solution.maxAbsResidual < 1e-12 * Math.sqrt(frobeniusSquared));
});

test('denseLaplacian matches the sparse Laplacian apply on a deterministic graph', () => {
  const graph = ringLatticeGraph(20, 'dense-consistency', 2);
  const dense = denseLaplacian(graph);
  for (let trial = 0; trial < 3; trial += 1) {
    const x = noiseVector(graph.size, `apply-${trial}`);
    const sparse = graph.applyLaplacian(x);
    for (let index = 0; index < graph.size; index += 1) {
      let sum = 0;
      for (let col = 0; col < graph.size; col += 1) sum += dense.values[index + col * graph.size]! * x[col]!;
      assert.ok(Math.abs(sum - sparse[index]!) < 1e-10);
    }
  }
});

test('the Gershgorin spectral-norm bound covers the largest eigenvalue on fixtures', () => {
  for (const graph of [pathGraph(8), cycleGraph(9), starGraph(7), completeGraph(6), ringLatticeGraph(25, 'bound', 2)]) {
    const solution = solveDenseSymmetricEigen(denseLaplacian(graph));
    const largest = solution.eigenvalues[graph.size - 1]!;
    assert.ok(graph.spectralNormBound >= largest - 1e-9, `bound ${graph.spectralNormBound} vs ${largest}`);
    assert.ok(largest >= -1e-12);
  }
});

test('oversize, nonfinite and nonconverging inputs are refused', () => {
  const graph = pathGraph(4);
  const matrix = denseLaplacian(graph);
  assert.throws(() => solveDenseSymmetricEigen(matrix, { maxN: 3 }), /refuses n=4 > maxN=3/);
  const nonfinite: DenseSymmetricMatrix = { n: 2, values: Float64Array.from([1, Number.NaN, Number.NaN, 2]) };
  assert.throws(() => solveDenseSymmetricEigen(nonfinite), /nonfinite matrix entries/);
  assert.throws(() => solveDenseSymmetricEigen(matrix, { sweepLimit: 0 }), /nonconvergence after 0 sweeps/);
  assert.throws(() => solveDenseSymmetricEigen({ n: 2, values: new Float64Array(3) }), /does not match n=2/);
});

test('the dense fallback ceiling is 172: a plain call refuses anything larger', () => {
  assert.equal(DENSE_DEFAULT_MAX_N, 172);
  // One node over the ceiling already refuses with the default options.
  const ceiling = denseLaplacian(ringLatticeGraph(173, 'dense-ceiling', 2));
  assert.throws(() => solveDenseSymmetricEigen(ceiling), /refuses n=173 > maxN=172/);
  assert.throws(() => solveDenseSymmetricEigen(ceiling), /use the Lanczos solver/);
  // At the ceiling itself the plain call still solves (the benchmarked 172-node fallback).
  const at172 = solveDenseSymmetricEigen(denseLaplacian(ringLatticeGraph(172, 'dense-ceiling-172', 2)));
  assert.equal(at172.n, 172);
  assert.ok(at172.maxAbsResidual <= 1e-10);
});

test('the 850-node disclosure cap is refused without the named benchmark opt-in', () => {
  const disclosure = denseLaplacian(ringLatticeGraph(850, 'dense-disclosure', 3));
  // Plain call: the prohibited silent dense 850 route must refuse.
  assert.throws(() => solveDenseSymmetricEigen(disclosure), /refuses n=850 > maxN=172/);
  assert.throws(() => solveDenseSymmetricEigen(disclosure), /use the Lanczos solver/);
  // An explicit larger maxN alone does not help: the named opt-in is required.
  assert.throws(
    () => solveDenseSymmetricEigen(disclosure, { maxN: 850 }),
    /exceeds the dense fallback ceiling 172; the dense route above 172 is reserved/,
  );
  assert.throws(
    () => solveDenseSymmetricEigen(disclosure, { maxN: 850 }),
    /requires benchmarkOptIn=dense-benchmark-reference-v1/,
  );
  // A mistyped opt-in token is not the named opt-in.
  assert.throws(
    () => solveDenseSymmetricEigen(disclosure, { maxN: 850, benchmarkOptIn: 'dense-benchmark-reference-v0' as typeof DENSE_BENCHMARK_OPT_IN }),
    /requires benchmarkOptIn=dense-benchmark-reference-v1/,
  );
  // Even with the opt-in the benchmark ceiling binds.
  assert.throws(
    () => solveDenseSymmetricEigen(disclosure, { maxN: DENSE_BENCHMARK_MAX_N + 1, benchmarkOptIn: DENSE_BENCHMARK_OPT_IN }),
    /exceeds the benchmark ceiling 1024 even with the opt-in/,
  );
});

test('the named benchmark opt-in unlocks the reference route above the ceiling', () => {
  // The opt-in is the separately benchmarked reference route: an explicit maxN above 172
  // solves only with the exact named token. Kept small here so the default gate stays fast;
  // the real 172/850 benchmark measurements live in lanczos.test.ts behind
  // RUN_SPECTRAL_BENCHMARK. A wrong sweep limit still refuses after the opt-in.
  const graph = ringLatticeGraph(200, 'dense-opt-in', 2);
  const matrix = denseLaplacian(graph);
  const solution = solveDenseSymmetricEigen(matrix, { maxN: 200, benchmarkOptIn: DENSE_BENCHMARK_OPT_IN });
  assert.equal(solution.n, 200);
  assert.ok(solution.maxAbsResidual <= 1e-10);
  assert.ok(solution.orthogonalityDefect <= 1e-12);
  assert.throws(
    () => solveDenseSymmetricEigen(matrix, { maxN: 200, sweepLimit: 0, benchmarkOptIn: DENSE_BENCHMARK_OPT_IN }),
    /nonconvergence after 0 sweeps/,
  );
});
