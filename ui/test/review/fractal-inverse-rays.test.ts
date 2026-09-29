import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RESIDUAL_TOLERANCE,
  INVERSE_RAYS_VERSION,
  LEVEL_AGREEMENT_TOLERANCE,
  circularAngleDelta,
  defaultInverseRayOptions,
  externalCoordinate,
  invertExternalPoint,
} from '../../src/fractal/inverse-rays.ts';
import { cxAbs, cxConjugate, cxSub, forwardBotcher } from '../../src/fractal/botcher.ts';
import { defaultRayIterations, potentialRangeForCount, type FractalDynamics } from '../../src/fractal/parameters.ts';

const RECORD_C = -0.04976470588235294;
const DYNAMICS_2: FractalDynamics = { power: 2, c: RECORD_C };
const DYNAMICS_3: FractalDynamics = { power: 3, c: RECORD_C };
const ANGLES = [0, Math.PI / 4, 3 * Math.PI / 5, -2.5, 7.0];

test('inverse-rays c = 0 inverts w = 2 e^{i pi/4} to z = w exactly', () => {
  const dynamics: FractalDynamics = { power: 2, c: 0 };
  const target = externalCoordinate(Math.log(2), Math.PI / 4);
  const result = invertExternalPoint(dynamics, Math.log(2), Math.PI / 4);
  assert.equal(result.kind, 'solution');
  if (result.kind !== 'solution') return;
  assert.equal(result.version, INVERSE_RAYS_VERSION);
  assert.equal(result.iterations, 1);
  assert.ok(cxAbs(cxSub(result.z, target)) / cxAbs(target) <= 1e-12);
  assert.ok(result.residual <= 1e-12);
  assert.ok(result.levelAgreement <= 1e-12);
  assert.ok(result.branchWitness.argumentError <= 1e-12);
  // Other exterior targets invert exactly as well.
  for (const angle of ANGLES) {
    for (const potential of [0.25, 1.0, 1.75]) {
      const solved = invertExternalPoint(dynamics, potential, angle);
      assert.equal(solved.kind, 'solution');
      if (solved.kind !== 'solution') continue;
      const w = externalCoordinate(potential, angle);
      assert.ok(cxAbs(cxSub(solved.z, w)) / cxAbs(w) <= 1e-12);
      assert.ok(solved.residual <= 1e-12);
    }
  }
});

test('inverse-rays solves the record fixtures with residual <= 1e-6 and N/N+1 agreement', () => {
  for (const dynamics of [DYNAMICS_2, DYNAMICS_3]) {
    for (const angle of ANGLES) {
      for (const potential of [0.25, 1.0, 1.75]) {
        const result = invertExternalPoint(dynamics, potential, angle);
        assert.equal(result.kind, 'solution', `p=${dynamics.power} angle=${angle} potential=${potential}`);
        if (result.kind !== 'solution') continue;
        assert.ok(result.residual <= DEFAULT_RESIDUAL_TOLERANCE, `residual ${result.residual}`);
        assert.ok(result.residual <= 1e-10, `achieved residual ${result.residual}`);
        assert.ok(result.levelAgreement <= LEVEL_AGREEMENT_TOLERANCE, `levelAgreement ${result.levelAgreement}`);
        assert.ok(result.branchWitness.argumentError <= DEFAULT_RESIDUAL_TOLERANCE);
        assert.ok(result.branchWitness.maxStepArgumentDelta < Math.PI / 2);
        assert.equal(result.iterations, defaultRayIterations(dynamics.power, dynamics.c, potential));
        // Independent cross-check with the forward evaluation from the botcher module.
        const forward = forwardBotcher(result.z, dynamics, result.iterations);
        assert.equal(forward.kind, 'evaluation');
        if (forward.kind === 'evaluation') {
          const w = externalCoordinate(potential, angle);
          assert.ok(cxAbs(cxSub(forward.phi, w)) / cxAbs(w) <= DEFAULT_RESIDUAL_TOLERANCE);
          assert.equal(forward.branchTrusted, true);
        }
      }
    }
  }
});

test('inverse-rays mapped radii track e^G and increase strictly along each ray', () => {
  for (const dynamics of [DYNAMICS_2, DYNAMICS_3]) {
    for (const angle of ANGLES) {
      let previousRadius = 0;
      for (const potential of [0.2508, 0.75, 1.25, 1.75]) {
        const result = invertExternalPoint(dynamics, potential, angle);
        assert.equal(result.kind, 'solution');
        if (result.kind !== 'solution') continue;
        const radius = cxAbs(result.z);
        assert.ok(radius > previousRadius, `radius order at angle ${angle}`);
        previousRadius = radius;
        const expected = Math.exp(potential);
        assert.ok(
          Math.abs(radius / expected - 1) <= 0.025,
          `p=${dynamics.power} G=${potential} angle=${angle}: |z|=${radius} vs e^G=${expected}`,
        );
      }
    }
  }
});

test('inverse-rays preserves conjugation symmetry of the real-coefficient dynamics', () => {
  for (const dynamics of [DYNAMICS_2, DYNAMICS_3]) {
    for (const angle of [Math.PI / 4, 3 * Math.PI / 5, 2.0]) {
      const direct = invertExternalPoint(dynamics, 1.0, angle);
      const mirrored = invertExternalPoint(dynamics, 1.0, -angle);
      assert.equal(direct.kind, 'solution');
      assert.equal(mirrored.kind, 'solution');
      if (direct.kind !== 'solution' || mirrored.kind !== 'solution') continue;
      const difference = cxAbs(cxSub(direct.z, cxConjugate(mirrored.z)));
      assert.ok(difference / cxAbs(direct.z) <= 1e-12, `symmetry error ${difference}`);
    }
  }
});

test('inverse-rays keeps a stable deterministic potential step schedule', () => {
  const options = defaultInverseRayOptions(1.0, DYNAMICS_2);
  const result = invertExternalPoint(DYNAMICS_2, 1.0, Math.PI / 4, options);
  assert.equal(result.kind, 'solution');
  if (result.kind !== 'solution') return;
  assert.ok(result.potentialStep <= options.maxPotentialStep);
  assert.equal(result.steps.length, Math.ceil((options.highPotential - 1.0) / options.maxPotentialStep) + 1);
  assert.ok(Math.abs((result.steps[0] as { potential: number }).potential - options.highPotential) <= 1e-12);
  assert.ok(Math.abs((result.steps[result.steps.length - 1] as { potential: number }).potential - 1.0) <= 1e-12);
  for (let j = 1; j < result.steps.length; j += 1) {
    const previous = result.steps[j - 1] as { potential: number };
    const current = result.steps[j] as { potential: number };
    assert.ok(current.potential < previous.potential);
    assert.ok(Math.abs(previous.potential - current.potential - result.potentialStep) <= 1e-9);
  }
});

test('inverse-rays is deterministic across double runs and permuted target order', () => {
  const targets: ReadonlyArray<readonly [number, number]> = [[0.25, 0], [1.0, Math.PI / 4], [1.75, -2.5]];
  const forward = targets.map(([potential, angle]) => invertExternalPoint(DYNAMICS_2, potential, angle));
  const repeated = targets.map(([potential, angle]) => invertExternalPoint(DYNAMICS_2, potential, angle));
  const permuted = [...targets.keys()].sort((a, b) => b - a).map((index) => {
    const [potential, angle] = targets[index] as readonly [number, number];
    return invertExternalPoint(DYNAMICS_2, potential, angle);
  });
  for (let i = 0; i < targets.length; i += 1) {
    assert.deepEqual(forward[i], repeated[i]);
    const original = forward[i];
    const mirrored = permuted[targets.length - 1 - i];
    assert.deepEqual(original, mirrored);
  }
});

test('inverse-rays refuses non-exterior and nonfinite targets deterministically', () => {
  for (const potential of [0, -0.5]) {
    const failure = invertExternalPoint(DYNAMICS_2, potential, 1.0);
    assert.equal(failure.kind, 'failure');
    assert.equal((failure as { code: string }).code, 'target-not-exterior');
    assert.deepEqual(failure, invertExternalPoint(DYNAMICS_2, potential, 1.0));
  }
  const nonfinite = invertExternalPoint(DYNAMICS_2, Number.NaN, 1.0);
  assert.equal((nonfinite as { code: string }).code, 'nonfinite-target');
  const nonfiniteAngle = invertExternalPoint(DYNAMICS_2, 1.0, Number.POSITIVE_INFINITY);
  assert.equal((nonfiniteAngle as { code: string }).code, 'nonfinite-target');
});

test('inverse-rays rejects invalid options deterministically', () => {
  const base = defaultInverseRayOptions(1.0, DYNAMICS_2);
  const invalidOptions = [
    { ...base, iterations: 0 },
    { ...base, iterations: 1.5 },
    { ...base, highPotential: 1.0 },
    { ...base, highPotential: 0.5 },
    { ...base, maxPotentialStep: 0 },
    { ...base, maxPotentialStep: -1 },
    { ...base, residualTolerance: 0 },
  ];
  for (const options of invalidOptions) {
    const failure = invertExternalPoint(DYNAMICS_2, 1.0, 1.0, options);
    assert.equal(failure.kind, 'failure');
    assert.equal((failure as { code: string }).code, 'invalid-options');
    assert.deepEqual(failure, invertExternalPoint(DYNAMICS_2, 1.0, 1.0, options));
  }
});

test('inverse-rays fails deterministically when Newton cannot converge within its cap', () => {
  const options = { ...defaultInverseRayOptions(1.75, DYNAMICS_2), maxNewtonIterations: 0 };
  const failure = invertExternalPoint(DYNAMICS_2, 1.75, Math.PI / 4, options);
  assert.equal(failure.kind, 'failure');
  const typed = failure as { code: string; lastResidual: number; stepIndex: number };
  assert.equal(typed.code, 'max-iterations-exceeded');
  assert.ok(Number.isFinite(typed.lastResidual));
  assert.deepEqual(failure, invertExternalPoint(DYNAMICS_2, 1.75, Math.PI / 4, options));
});

test('inverse-rays circular angle helper wraps to [0, pi]', () => {
  assert.ok(Math.abs(circularAngleDelta(7.0, 7.0 - 2 * Math.PI)) <= 1e-15);
  assert.ok(Math.abs(circularAngleDelta(Math.PI, -Math.PI)) <= 1e-15);
  assert.ok(Math.abs(circularAngleDelta(0, Math.PI / 2) - Math.PI / 2) <= 1e-15);
  assert.ok(Math.abs(circularAngleDelta(0, 3 * Math.PI / 2) - Math.PI / 2) <= 1e-15);
  // Unwrapped target angles above 2 pi stay equivalent through the branch witness.
  const result = invertExternalPoint(DYNAMICS_2, 1.0, 7.0);
  assert.equal(result.kind, 'solution');
  if (result.kind === 'solution') {
    assert.ok(circularAngleDelta(result.branchWitness.unwrappedArgument, 7.0) <= DEFAULT_RESIDUAL_TOLERANCE);
  }
});

test('inverse-rays covers the whole certified potential range of the 850-node fixture', () => {
  const [minPotential, maxPotential] = potentialRangeForCount(850);
  for (const dynamics of [DYNAMICS_2, DYNAMICS_3]) {
    for (const potential of [minPotential, (minPotential + maxPotential) / 2, maxPotential]) {
      for (const angle of [0.3, Math.PI + 0.2, -3.05]) {
        const result = invertExternalPoint(dynamics, potential, angle);
        assert.equal(result.kind, 'solution', `p=${dynamics.power} G=${potential} theta=${angle}`);
        if (result.kind !== 'solution') continue;
        assert.ok(result.residual <= DEFAULT_RESIDUAL_TOLERANCE);
        assert.ok(result.levelAgreement <= LEVEL_AGREEMENT_TOLERANCE);
      }
    }
  }
});
