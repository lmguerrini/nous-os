/** D-073 tranche F, row F9 (model half) — the Holographic error and baseline model: region
 * witnesses from real rank-checked recoveries on path graphs with hand-derived answers, the
 * aggregate distribution, and the stated no-topology limitation on every explanation. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import {
  EXPLAIN_NO_TOPOLOGY_CLAIM, EXPLAIN_STATED_BASELINE, HOLOGRAPHIC_EXPLAIN_VERSION,
  coincidentNodeDisplayExplanation, errorModelExplanation, holographicErrorModel, regionReconstructionExplanation, regionReconstructionWitness,
  type RegionDescriptor, type RegionReconstructionWitness,
} from '../../src/holographic/explain.ts';
import { RECOVERY_BASELINE_GLOBAL_MEAN, recoverBandlimitedSignal } from '../../src/holographic/recovery.ts';
import { eigenbasisFromDense, syntheticSignal } from '../../src/holographic/signals.ts';
import { pathGraph } from './fixtures.ts';

function witnessFor(
  values: number[], sampleIndices: number[], bandlimit: number, regionId: string, ridge = 0,
): RegionReconstructionWitness {
  const graph = pathGraph(values.length);
  const basis = eigenbasisFromDense(solveDenseSymmetricEigen(denseLaplacian(graph)));
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from(values), `signal-${regionId}`);
  const region: RegionDescriptor = {
    regionId, kind: 'community', memberNodeIds: sampleIndices.map(index => graph.nodeIds[index]!),
  };
  return regionReconstructionWitness(
    region, recoverBandlimitedSignal(graph, basis, signal, sampleIndices, { bandlimit, ridge }), { bandlimit, ridge },
  );
}

/** Affine P3 [5,3,1] sampled at nodes 0 and 1 with k=2: exact recovery; the global-mean predictor
 * (sample mean 4) misses the held-out truth 1 by |1-4|/1 = 3. */
const exactWitness = (): RegionReconstructionWitness => witnessFor([5, 3, 1], [0, 1], 2, 'exact');
/** P5 [1,2,3,4,10] sampled at 0..2 with k=1: the constant-mode least squares IS the sample mean 2,
 * so the recovery coincides with the stated baseline and gains nothing. */
const meanEquivalentWitness = (): RegionReconstructionWitness => witnessFor([1, 2, 3, 4, 10], [0, 1, 2], 1, 'mean-equivalent');
/** P3 sampled at one endpoint with k=2: rank 1 < 2, the recovery refuses. */
const refusedWitness = (): RegionReconstructionWitness => witnessFor([1, 0, -1], [0], 2, 'refused');

test('an exact recovery beats the stated global-mean baseline and is recorded with the hand-derived errors', () => {
  const witness = exactWitness();
  assert.equal(witness.status, 'recovered');
  assert.equal(witness.exact, true);
  assert.equal(witness.claim, 'exact-bandlimited-recovery');
  assert.equal(witness.rank, 2);
  assert.equal(witness.memberCount, 2);
  assert.ok(witness.heldOutRelativeError !== null && witness.heldOutRelativeError <= 1e-10);
  assert.ok(Math.abs(witness.statedBaselineRelativeError! - 3) < 1e-9);
  assert.ok(Math.abs(witness.localNeighbourBaselineRelativeError! - 2) < 1e-9);
  // The recovery error sits at the energy floor, so the ratio is withheld, never manufactured.
  assert.equal(witness.improvementOverStatedBaseline, null);
  assert.equal(witness.beatsStatedBaseline, true);
});

test('a recovery equal to the mean predictor is not counted as beating it (improvement exactly 1)', () => {
  const witness = meanEquivalentWitness();
  assert.equal(witness.status, 'recovered');
  assert.equal(witness.exact, false);
  assert.equal(witness.claim, 'least-squares-estimate');
  // Held-out nodes 3 and 4: truth [4, 10] against the constant 2.
  const expected = Math.sqrt((4 - 2) ** 2 + (10 - 2) ** 2) / Math.sqrt(4 ** 2 + 10 ** 2);
  assert.ok(Math.abs(witness.heldOutRelativeError! - expected) < 1e-12, `${String(witness.heldOutRelativeError)} vs ${String(expected)}`);
  assert.ok(Math.abs(witness.statedBaselineRelativeError! - expected) < 1e-12);
  assert.ok(Math.abs(witness.improvementOverStatedBaseline! - 1) < 1e-12);
  assert.equal(witness.beatsStatedBaseline, false);
});

test('a rank-deficient region stays a refusal: measured rank, no error, no improvement, no claim', () => {
  const witness = refusedWitness();
  assert.equal(witness.status, 'refused');
  assert.equal(witness.refusalCode, 'rank-deficient');
  assert.equal(witness.rank, 1);
  assert.equal(witness.claim, null);
  assert.equal(witness.exact, null);
  for (const value of [witness.heldOutRelativeError, witness.heldOutMae, witness.statedBaselineRelativeError,
    witness.localNeighbourBaselineRelativeError, witness.improvementOverStatedBaseline, witness.beatsStatedBaseline])
    assert.equal(value, null);
  const explanation = regionReconstructionExplanation(witness);
  assert.match(explanation.summary, /refused band-limited recovery/);
  assert.match(explanation.summary, /No value is imputed and no claim is made/);
  assert.deepEqual(explanation.numericalWitness, {
    status: 'refused', refusalCode: 'rank-deficient', memberCount: 1, bandlimit: 2, measuredRank: 1,
  });
});

test('the aggregate model reports the honest distribution over recovered and refused regions', () => {
  const witnesses = [exactWitness(), meanEquivalentWitness(), refusedWitness()];
  const model = holographicErrorModel(witnesses);
  assert.equal(model.algorithmVersion, HOLOGRAPHIC_EXPLAIN_VERSION);
  assert.equal(model.statedBaseline, RECOVERY_BASELINE_GLOBAL_MEAN);
  assert.equal(model.statedBaseline, EXPLAIN_STATED_BASELINE);
  assert.equal(model.regionCount, 3);
  assert.equal(model.recoveredCount, 2);
  assert.equal(model.refusedCount, 1);
  assert.equal(model.comparedCount, 2);
  assert.equal(model.beatsStatedBaselineCount, 1, 'only the exact recovery beats the baseline');
  assert.equal(model.anyExactClaim, true);
  // Median of two held-out errors is the mean of the middle pair; the worst is the larger one.
  const meanEquivalentError = Math.sqrt(68) / Math.sqrt(116);
  const exactError = witnesses[0]!.heldOutRelativeError!;
  assert.ok(Math.abs(model.medianHeldOutRelativeError! - (exactError + meanEquivalentError) / 2) < 1e-12);
  assert.ok(Math.abs(model.worstHeldOutRelativeError! - meanEquivalentError) < 1e-12);
  // Only the mean-equivalent region has a ratio (the exact one is at the floor).
  assert.ok(Math.abs(model.medianImprovementOverStatedBaseline! - 1) < 1e-12);
  assert.ok(Math.abs(model.worstImprovementOverStatedBaseline! - 1) < 1e-12);
  assert.match(model.summary, /2\/3 sampled regions recovered/);
  assert.match(model.summary, /1\/2 beat the stated global-mean baseline/);
  assert.match(model.summary, /1 region\(s\) refused on rank/);
});

test('the median of an odd count is the middle held-out error and a k=1 recovery never claims a gain', () => {
  // P5 [1,2,3,4,10] sampled at 0,1 with k=1: the sample mean 1.5; held-out truth [3,4,10].
  const a = witnessFor([1, 2, 3, 4, 10], [0, 1], 1, 'a');
  const b = meanEquivalentWitness();
  const c = witnessFor([1, 2, 3, 4, 10], [0, 1, 2, 3], 1, 'c');
  const model = holographicErrorModel([a, b, c]);
  const errors = [a, b, c].map(witness => witness.heldOutRelativeError!).sort((x, y) => x - y);
  assert.equal(model.medianHeldOutRelativeError, errors[1]);
  assert.equal(model.worstHeldOutRelativeError, errors[2]);
  assert.equal(model.beatsStatedBaselineCount, 0, 'k=1 recovery is the mean predictor: never a claimed gain');
  assert.equal(model.comparedCount, 3);
});

test('an empty or all-refused region set makes no reconstruction claim', () => {
  const empty = holographicErrorModel([]);
  assert.equal(empty.regionCount, 0);
  assert.equal(empty.medianHeldOutRelativeError, null);
  assert.equal(empty.medianImprovementOverStatedBaseline, null);
  assert.equal(empty.anyExactClaim, false);
  assert.match(empty.summary, /no eligible region was declared, so no part-to-whole measurement exists/);

  const refused = holographicErrorModel([refusedWitness(), witnessFor([1, 0, -1], [2], 2, 'refused-2')]);
  assert.equal(refused.recoveredCount, 0);
  assert.equal(refused.refusedCount, 2);
  assert.equal(refused.beatsStatedBaselineCount, 0);
  assert.equal(refused.medianHeldOutRelativeError, null);
  assert.match(refused.summary, /every one refused on rank; no reconstruction claim is made/);
});

test('every explanation carries the stated baseline and the verbatim no-topology limitation', () => {
  const witnesses = [exactWitness(), meanEquivalentWitness(), refusedWitness()];
  const explanations = [
    ...witnesses.map(witness => regionReconstructionExplanation(witness)),
    errorModelExplanation(holographicErrorModel(witnesses), { signalId: 'importance', bandlimit: 2, ridge: 0, regionPolicy: 'source-community-v1' }),
  ];
  for (const explanation of explanations) {
    assert.equal(explanation.limitation, EXPLAIN_NO_TOPOLOGY_CLAIM);
    assert.ok(explanation.parameterIds.includes(RECOVERY_BASELINE_GLOBAL_MEAN), `${explanation.elementId} names the baseline`);
    assert.ok(explanation.elementId.startsWith('visual:holographic:'));
  }
  assert.match(EXPLAIN_NO_TOPOLOGY_CLAIM, /^No topology claim is made/);
  assert.match(EXPLAIN_NO_TOPOLOGY_CLAIM, /never a recovered semantic edge/);
  const recovered = regionReconstructionExplanation(exactWitness());
  assert.equal(recovered.numericalWitness!.statedBaseline, 'global-mean-v1');
  assert.equal(recovered.numericalWitness!.improvementOverStatedBaseline, 'n/a');
  assert.equal(recovered.numericalWitness!.beatsStatedBaseline, true);
  assert.equal(recovered.elementId, 'visual:holographic:reconstruction:exact');
  const aggregate = errorModelExplanation(holographicErrorModel(witnesses), { signalId: 'importance', bandlimit: 2, ridge: 0.5, regionPolicy: 'source-community-v1' });
  assert.ok(aggregate.parameterIds.includes('ridge=0.5'));
  assert.equal(aggregate.numericalWitness!.regionCount, 3);
  const unavailable = errorModelExplanation(holographicErrorModel([]), {
    signalId: 'importance', bandlimit: 0, ridge: 0, regionPolicy: 'source-community-v1', unavailableReason: 'the spectral basis is unavailable',
  });
  assert.match(unavailable.summary, /reconstruction witness unavailable: the spectral basis is unavailable\. No reconstruction claim is made/);
  assert.equal(unavailable.limitation, EXPLAIN_NO_TOPOLOGY_CLAIM);
});

test('a ridge recovery is labelled a ridge estimate, never an exact claim', () => {
  const witness = witnessFor([5, 3, 1], [0, 1], 2, 'ridge', 0.25);
  assert.equal(witness.status, 'recovered');
  assert.equal(witness.exact, false);
  assert.equal(witness.claim, 'ridge-estimate');
  assert.equal(witness.ridge, 0.25);
  assert.equal(holographicErrorModel([witness]).anyExactClaim, false);
});

test('coincident-node wording keeps exact spectral coordinates separate from display radius', () => {
  const explanation = coincidentNodeDisplayExplanation('node-1', [0.125, -0.5], 0.025, 'coincident-node-ring-v1');
  assert.equal(explanation.elementId, 'node-1');
  assert.equal(explanation.elementKind, 'node');
  assert.match(explanation.summary, /Posizione spettrale esatta \(0\.125, -0\.5\)/);
  assert.match(explanation.summary, /spostamento di visualizzazione per nodi coincidenti: r=0\.0250000/);
  assert.deepEqual(explanation.numericalWitness, { exactCoordinate: '(0.125, -0.5)', displayOffsetRadius: 0.025 });
  assert.ok(explanation.parameterIds.includes('coincident-node-ring-v1'));
});
