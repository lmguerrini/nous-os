/** D-073 tranche F, row F7 — known-answer and property tests for rank-checked band-limited
 * recovery with an explicit held-out error (the measurable part-to-whole claim). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DENSE_BENCHMARK_OPT_IN, DENSE_DEFAULT_MAX_N, denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import { recoverBandlimitedSignal, recoverStableBandlimit, type RecoveryOutcome } from '../../src/holographic/recovery.ts';
import { eigenbasisFromDense, syntheticSignal, type Eigenbasis } from '../../src/holographic/signals.ts';
import type { SpectralGraph } from '../../src/holographic/adjacency.ts';
import { noiseVector, pathGraph, ringLatticeGraph } from './fixtures.ts';

function denseBasis(graph: SpectralGraph): Eigenbasis {
  return eigenbasisFromDense(solveDenseSymmetricEigen(denseLaplacian(graph)));
}

test('P3: sampling both endpoints recovers the band-limited [1,0,-1] exactly with k=2', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from([1, 0, -1]), 'p3-exact');
  const outcome = recoverBandlimitedSignal(graph, basis, signal, [0, 2], { bandlimit: 2 });
  assert.ok(outcome.kind === 'recovered', outcome.kind === 'refusal' ? outcome.message : '');
  assert.equal(outcome.exact, true);
  assert.equal(outcome.claim, 'exact-bandlimited-recovery');
  assert.equal(outcome.rank, 2);
  assert.equal(outcome.sampleCount, 2);
  assert.ok(Math.abs(outcome.singularValues[0]! - Math.sqrt(2 / 3)) < 1e-12);
  assert.ok(Math.abs(outcome.singularValues[1]! - 1) < 1e-12);
  assert.ok(Math.abs(outcome.conditionNumber! - Math.sqrt(1.5)) < 1e-12);
  assert.ok(Math.abs(outcome.coefficients[0]!) < 1e-12, 'zero-mode coefficient');
  assert.ok(Math.abs(outcome.coefficients[1]! - Math.SQRT2) < 1e-12, 'lambda=1 coefficient');
  for (const [index, value] of [1, 0, -1].entries()) {
    assert.ok(Math.abs(outcome.reconstructed[index]! - value) < 1e-12, `reconstructed ${index}`);
  }
  assert.deepEqual([...outcome.heldOut.indices], [1]);
  // The held-out truth is exactly 0, so the epsilon-floored relative error is
  // inflated by the 1e-12 denominator; the residual norm is the machine-level witness.
  assert.ok(outcome.heldOut.relativeError !== null && Number.isFinite(outcome.heldOut.relativeError));
  assert.ok(outcome.heldOut.residualNorm !== null && outcome.heldOut.residualNorm <= 1e-12);
  assert.ok(outcome.heldOut.mae !== null && outcome.heldOut.mae <= 1e-12);
  // Both baselines also predict 0 here (the samples average to 0), so the global-mean
  // improvement factor is 0 (or null at the recovery floor), never a manufactured gain.
  assert.ok(outcome.globalMeanBaseline.heldOutRelativeError !== null && outcome.globalMeanBaseline.heldOutRelativeError <= 1e-10);
  const improvement = outcome.globalMeanBaseline.improvementFactor;
  assert.ok(improvement === null || improvement === 0, `improvement ${String(improvement)}`);
});

test('P3: the affine band-limited signal [5,3,1] beats both interpolation baselines when endpoints-adjacent nodes are sampled', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from([5, 3, 1]), 'p3-affine');
  const outcome = recoverBandlimitedSignal(graph, basis, signal, [0, 1], { bandlimit: 2 });
  assert.ok(outcome.kind === 'recovered');
  assert.equal(outcome.exact, true);
  assert.ok(outcome.heldOut.relativeError !== null && outcome.heldOut.relativeError <= 1e-10);
  assert.ok(outcome.globalMeanBaseline.heldOutRelativeError !== null && Math.abs(outcome.globalMeanBaseline.heldOutRelativeError - 3) < 1e-9);
  assert.ok(outcome.localNeighbourBaseline.heldOutRelativeError !== null && Math.abs(outcome.localNeighbourBaseline.heldOutRelativeError - 2) < 1e-9);
});

test('P3: a one-endpoint sample is rank-deficient and refuses exact recovery', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from([1, 0, -1]), 'p3-refuse');
  const outcome = recoverBandlimitedSignal(graph, basis, signal, [0], { bandlimit: 2 });
  assert.ok(outcome.kind === 'refusal', 'a one-endpoint sample must refuse');
  assert.equal(outcome.code, 'rank-deficient');
  assert.equal(outcome.rank, 1);
  assert.equal(outcome.sampleCount, 1);
  assert.ok(Math.abs(outcome.singularValues[0]!) <= 1e-12);
  assert.ok(Math.abs(outcome.singularValues[1]! - Math.sqrt(5 / 6)) < 1e-12);
  assert.match(outcome.message, /rank 1/);
  const ridged = recoverBandlimitedSignal(graph, basis, signal, [0], { bandlimit: 2, ridge: 0.5 });
  assert.ok(ridged.kind === 'refusal', 'a ridge cannot buy rank');
  assert.equal(ridged.code, 'rank-deficient');
});

test('the stable band rule selects by sample rank and condition, independently of held-out values', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const smooth = Float64Array.from([5, 3, 1]);
  const alteredHeldOut = Float64Array.from([5, 3, 100]);
  const samples = [0, 1];
  const first = recoverStableBandlimit(graph, basis, smooth, samples, { maxBandlimit: 3, maxCondition: 30 });
  const second = recoverStableBandlimit(graph, basis, alteredHeldOut, samples, { maxBandlimit: 3, maxCondition: 30 });
  assert.equal(first.kind, 'recovered');
  assert.equal(second.kind, 'recovered');
  assert.equal(first.bandlimit, 2);
  assert.equal(second.bandlimit, 2);
  if (first.kind === 'recovered' && second.kind === 'recovered') {
    assert.ok(first.conditionNumber! <= 30);
    assert.ok(first.heldOut.relativeError! < second.heldOut.relativeError!);
  }
  const strict = recoverStableBandlimit(graph, basis, smooth, samples, { maxBandlimit: 3, maxCondition: 1 });
  assert.equal(strict.bandlimit, 1);
});

test('a non-band-limited signal is recovered with an explicit held-out error and no exact claim', () => {
  const graph = ringLatticeGraph(30, 'recovery', 2);
  const basis = denseBasis(graph);
  const x = noiseVector(graph.size, 'recovery-x');
  const samples = Array.from({ length: graph.size }, (_unused, index) => index).filter((index) => index % 3 === 0);
  const outcome = recoverBandlimitedSignal(graph, basis, x, samples, { bandlimit: 4 });
  assert.ok(outcome.kind === 'recovered', outcome.kind === 'refusal' ? outcome.message : '');
  assert.equal(outcome.exact, false);
  assert.equal(outcome.claim, 'least-squares-estimate');
  assert.equal(outcome.rank, 4);
  assert.ok(outcome.bandlimitedRelativeResidual > 1e-8, 'the noise signal is not 4-band-limited');
  assert.ok(outcome.heldOut.relativeError !== null);
  assert.ok(outcome.heldOut.relativeError! > 0 && Number.isFinite(outcome.heldOut.relativeError!));
  assert.ok(outcome.heldOut.mae !== null && outcome.heldOut.mae! > 0);
  assert.ok(outcome.sampleRelativeResidual >= 0 && outcome.sampleRelativeResidual < 1, 'the least-squares residual stays a bounded real number');
  assert.ok(outcome.heldOut.residualNorm !== null && outcome.heldOut.residualNorm > 0);
  for (const baseline of [outcome.globalMeanBaseline, outcome.localNeighbourBaseline]) {
    assert.ok(baseline.heldOutRelativeError !== null && Number.isFinite(baseline.heldOutRelativeError!));
  }
});

test('sampling every node is trivially exact for any signal at k = n', () => {
  const graph = pathGraph(4);
  const basis = denseBasis(graph);
  const x = noiseVector(graph.size, 'full-sample');
  const outcome = recoverBandlimitedSignal(graph, basis, x, [0, 1, 2, 3], { bandlimit: 4 });
  assert.ok(outcome.kind === 'recovered');
  assert.equal(outcome.rank, 4);
  assert.equal(outcome.heldOut.relativeError, null);
  assert.equal(outcome.heldOut.mae, null);
  assert.equal(outcome.exact, true);
  assert.equal(outcome.globalMeanBaseline.heldOutRelativeError, null);
});

test('a ridge estimate never claims exactness', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from([1, 0, -1]), 'p3-ridge');
  const outcome = recoverBandlimitedSignal(graph, basis, signal, [0, 2], { bandlimit: 2, ridge: 1e-6 });
  assert.ok(outcome.kind === 'recovered');
  assert.equal(outcome.exact, false);
  assert.equal(outcome.claim, 'ridge-estimate');
  assert.ok(outcome.heldOut.residualNorm !== null && outcome.heldOut.residualNorm > 0 && outcome.heldOut.residualNorm < 1e-3);
});

test('invalid inputs refuse loudly', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const x = Float64Array.from([1, 0, -1]);
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [0], { bandlimit: 0 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [0], { bandlimit: 4 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [], { bandlimit: 2 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [0, 0], { bandlimit: 2 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [3], { bandlimit: 2 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, x, [0, 2], { bandlimit: 2, ridge: -1 }));
  assert.throws(() => recoverBandlimitedSignal(graph, basis, Float64Array.from([1, Number.NaN, -1]), [0, 2], { bandlimit: 2 }));
});

test('a bandlimit above the dense Gram ceiling is refused in argument validation', () => {
  // The 173-node complete basis is legitimate, but its k = 173 Gram matrix exceeds the dense
  // reference eigensolver's ceiling, so production recovery must refuse before diagonalising.
  const graph = pathGraph(173);
  const basis = eigenbasisFromDense(
    solveDenseSymmetricEigen(denseLaplacian(graph), { maxN: 173, benchmarkOptIn: DENSE_BENCHMARK_OPT_IN }),
  );
  assert.ok(basis.count === 173 && basis.complete);
  const x = noiseVector(graph.size, 'recovery-gram-ceiling');
  assert.throws(
    () => recoverBandlimitedSignal(graph, basis, x, [0, 1, 2], { bandlimit: 173 }),
    /bandlimit 173 exceeds the dense Gram ceiling 172/,
  );
  // The ceiling itself remains admissible: k = 172 over a full sample solves its Gram system
  // (the path's clustered high modes make it a genuine least-squares solve, not an exact claim).
  const allNodes = Array.from({ length: graph.size }, (_unused, index) => index);
  const atCeiling = recoverBandlimitedSignal(graph, basis, x, allNodes, { bandlimit: DENSE_DEFAULT_MAX_N });
  assert.ok(atCeiling.kind === 'recovered');
  assert.equal(atCeiling.rank, DENSE_DEFAULT_MAX_N);
  assert.equal(atCeiling.claim, 'least-squares-estimate');
});

test('the held-out metrics match their definitions on the P3 fixture', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const x = Float64Array.from([2, 1, 0]);
  const outcome = recoverBandlimitedSignal(graph, basis, x, [0], { bandlimit: 1 });
  assert.ok(outcome.kind === 'recovered');
  // k = 1 is the constant mode; the least-squares fit on sample {0} is the constant 2.
  assert.deepEqual([...outcome.heldOut.indices], [1, 2]);
  const numerator = Math.hypot(1 - 2, 0 - 2);
  const denominator = Math.hypot(1, 0);
  assert.ok(outcome.heldOut.relativeError !== null);
  assert.ok(Math.abs(outcome.heldOut.relativeError - numerator / denominator) < 1e-12);
  assert.ok(outcome.heldOut.mae !== null);
  assert.ok(Math.abs(outcome.heldOut.mae - (1 + 2) / 2) < 1e-12);
  const outcome2: RecoveryOutcome = recoverBandlimitedSignal(graph, basis, x, [2, 1, 0], { bandlimit: 1 });
  assert.ok(outcome2.kind === 'recovered');
  assert.deepEqual([...outcome2.sampleIndices], [0, 1, 2], 'samples are normalised into a sorted set');
});
