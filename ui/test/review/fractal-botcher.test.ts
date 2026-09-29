import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Complex } from '../../src/projection/contract-types.ts';
import {
  BOTCHER_VERSION,
  botcherResiduals,
  cxAbs,
  cxAdd,
  cxArg,
  cxConjugate,
  cxPowInteger,
  cxSub,
  checkBotcherDerivative,
  cx,
  forwardBotcher,
} from '../../src/fractal/botcher.ts';
import { certifyFractalDynamics, defaultRayIterations, potentialRangeForCount } from '../../src/fractal/parameters.ts';

const RECORD_C = -0.04976470588235294;

function recordDynamics(power: 2 | 3) {
  return { power, c: RECORD_C };
}

function rayIterations(power: 2 | 3): number {
  return defaultRayIterations(power, RECORD_C, potentialRangeForCount(850)[0]);
}

const exteriorPoints = [0.25, 1.0, 1.75].flatMap((potential) =>
  [0, Math.PI / 4, 3 * Math.PI / 5, -2.5].map((angle) => {
    const modulus = Math.exp(potential);
    return cx(modulus * Math.cos(angle), modulus * Math.sin(angle));
  }),
);

test('botcher c = 0 gives Phi(z) = z exactly with unit derivative', () => {
  const dynamics = { power: 2 as const, c: 0 };
  const points = [cx(0, 0), cx(2 * Math.cos(Math.PI / 4), 2 * Math.sin(Math.PI / 4)), cx(-3.5, 0.25), cx(1e6, -1e-6)];
  for (const power of [2, 3] as const) {
    for (const z of points) {
      const evaluation = forwardBotcher(z, { ...dynamics, power }, 5);
      assert.equal(evaluation.kind, 'evaluation');
      if (evaluation.kind !== 'evaluation') continue;
      assert.equal(evaluation.version, BOTCHER_VERSION);
      assert.deepEqual(evaluation.phi, z);
      assert.deepEqual(evaluation.derivative, cx(1, 0));
      assert.equal(evaluation.branchTrusted, true);
      assert.equal(evaluation.tailBound, 0);
      assert.equal(evaluation.modulusProduct, 1);
      assert.equal(evaluation.unwrappedArgument, cxArg(z));
      assert.equal(evaluation.orbit.length, 6);
      assert.deepEqual(evaluation.orbit[1], cxPowInteger(z, power));
    }
  }
});

test('botcher satisfies the functional equation Phi(F(z)) = Phi(z)^p with finite residual at the record c', () => {
  for (const power of [2, 3] as const) {
    const dynamics = recordDynamics(power);
    const iterations = rayIterations(power);
    for (const z of exteriorPoints) {
      const residuals = botcherResiduals(z, dynamics, iterations);
      assert.equal(residuals.kind, 'residuals');
      if (residuals.kind !== 'residuals') continue;
      assert.ok(residuals.functionalEquation <= 1e-9, `p=${power} functional residual ${residuals.functionalEquation}`);
      assert.ok(residuals.truncation <= 1e-11, `p=${power} truncation ${residuals.truncation}`);
      assert.equal(residuals.atZ.branchTrusted, true);
      // Modulus half of the functional equation and orbit bookkeeping.
      assert.deepEqual(residuals.atZ.orbit[1], cxAdd(cxPowInteger(z, power), cx(RECORD_C, 0)));
      const modulusRatio = Math.abs(cxAbs(residuals.atImage.phi) - Math.pow(cxAbs(residuals.atZ.phi), power));
      assert.ok(modulusRatio / Math.pow(cxAbs(residuals.atZ.phi), power) <= 1e-9);
    }
  }
});

test('botcher residuals shrink as N grows', () => {
  for (const power of [2, 3] as const) {
    const dynamics = recordDynamics(power);
    const z = exteriorPoints[1] as Complex;
    const coarse = botcherResiduals(z, dynamics, 3);
    const fine = botcherResiduals(z, dynamics, 8);
    assert.equal(coarse.kind, 'residuals');
    assert.equal(fine.kind, 'residuals');
    if (coarse.kind !== 'residuals' || fine.kind !== 'residuals') continue;
    assert.ok(fine.functionalEquation < coarse.functionalEquation, `p=${power}`);
    assert.ok(fine.truncation < coarse.truncation, `p=${power}`);
  }
});

test('botcher is normalized at infinity: |Phi(z)/z - 1| and argument error bounded by 2|c|/|z|^p', () => {
  for (const power of [2, 3] as const) {
    for (const c of [RECORD_C, 0.05, -0.05]) {
      const dynamics = { power, c };
      for (const angle of [0, 0.7, 2.1, -2.9]) {
        const modulus = 4;
        const z = cx(modulus * Math.cos(angle), modulus * Math.sin(angle));
        const evaluation = forwardBotcher(z, dynamics, rayIterations(power));
        assert.equal(evaluation.kind, 'evaluation');
        if (evaluation.kind !== 'evaluation') continue;
        const bound = (2 * Math.abs(c)) / Math.pow(modulus, power);
        const relative = cxAbs(cxSub(evaluation.phi, z)) / modulus;
        assert.ok(relative <= bound, `p=${power} c=${c} relative ${relative} > ${bound}`);
        const argumentDelta = Math.abs(Math.atan2(Math.sin(cxArg(evaluation.phi) - angle), Math.cos(cxArg(evaluation.phi) - angle)));
        assert.ok(argumentDelta <= bound, `p=${power} c=${c} argument ${argumentDelta} > ${bound}`);
        assert.equal(evaluation.branchTrusted, true);
      }
    }
  }
});

test('botcher respects the conjugation symmetry Phi(conj z) = conj Phi(z) for real c', () => {
  for (const power of [2, 3] as const) {
    const dynamics = recordDynamics(power);
    for (const z of exteriorPoints) {
      const direct = forwardBotcher(z, dynamics, rayIterations(power));
      const conjugated = forwardBotcher(cxConjugate(z), dynamics, rayIterations(power));
      assert.equal(direct.kind, 'evaluation');
      assert.equal(conjugated.kind, 'evaluation');
      if (direct.kind !== 'evaluation' || conjugated.kind !== 'evaluation') continue;
      const difference = cxAbs(cxSub(direct.phi, cxConjugate(conjugated.phi)));
      assert.ok(difference / cxAbs(direct.phi) <= 1e-14, `p=${power} symmetry ${difference}`);
    }
  }
});

test('botcher analytic derivative agrees with a checked central finite difference', () => {
  for (const power of [2, 3] as const) {
    const dynamics = recordDynamics(power);
    for (const z of exteriorPoints) {
      const check = checkBotcherDerivative(z, dynamics, rayIterations(power), 1e-7);
      assert.equal(check.kind, 'derivative-check');
      if (check.kind !== 'derivative-check') continue;
      assert.ok(check.relativeError <= 1e-6, `p=${power} relativeError ${check.relativeError}`);
    }
  }
});

test('botcher flags untrusted branches inside the escape radius and fails on zero log arguments', () => {
  const dynamics = recordDynamics(2);
  const inside = forwardBotcher(cx(0.5, 0.1), dynamics, rayIterations(2));
  assert.equal(inside.kind, 'evaluation');
  if (inside.kind === 'evaluation') assert.equal(inside.branchTrusted, false);
  // 0.25^2 = 0.0625 exactly in binary, so 1 + c/z^2 is exactly zero for c = -0.0625.
  const zeroLog = forwardBotcher(cx(0.25, 0), { power: 2, c: -0.0625 }, 5);
  assert.deepEqual(zeroLog, { kind: 'failure', code: 'zero-log-argument', detail: (zeroLog as { detail: string }).detail });
  // An escaping orbit records Infinity without producing NaN, and stays exact for c = 0.
  const escaping = forwardBotcher(cx(1e6, -1e-6), { power: 3, c: 0 }, 5);
  assert.equal(escaping.kind, 'evaluation');
  if (escaping.kind === 'evaluation') {
    assert.deepEqual(escaping.phi, cx(1e6, -1e-6));
    assert.equal(escaping.orbit.length, 6);
    assert.equal(cxAbs(escaping.orbit[5] as Complex), Infinity);
  }
});

test('botcher rejects invalid iterations and nonfinite input deterministically', () => {
  const dynamics = recordDynamics(2);
  for (const bad of [forwardBotcher(cx(2, 0), dynamics, 0), forwardBotcher(cx(2, 0), dynamics, -1), forwardBotcher(cx(2, 0), dynamics, 2.5)]) {
    assert.deepEqual(bad, { kind: 'failure', code: 'invalid-iterations', detail: (bad as { detail: string }).detail });
  }
  const nonfinite = forwardBotcher(cx(Number.NaN, 1), dynamics, 5);
  assert.equal(nonfinite.kind, 'failure');
  assert.equal((nonfinite as { code: string }).code, 'nonfinite-input');
  const repeat = forwardBotcher(cx(Number.NaN, 1), dynamics, 5);
  assert.deepEqual(nonfinite, repeat);
});

test('botcher is byte-stable across repeated evaluation', () => {
  for (const power of [2, 3] as const) {
    const dynamics = recordDynamics(power);
    for (const z of exteriorPoints) {
      assert.deepEqual(forwardBotcher(z, dynamics, rayIterations(power)), forwardBotcher(z, dynamics, rayIterations(power)));
    }
  }
});
