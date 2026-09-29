import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CX_ONE, CX_ZERO, cx, cxAbs, cxClose, cxMul, cxNegate, cxScale } from '../../src/indra/complex.ts';
import {
  MOBIUS_IDENTITY, MOBIUS_INFINITY, mobiusApply, mobiusCanonicalSign, mobiusCompose, mobiusConditionFrobenius,
  mobiusDeterminant, mobiusFrobeniusNorm, mobiusFromCirclePair, mobiusIdentityDeviation, mobiusInverse,
  mobiusInverseOfNormalized, mobiusInverseRoundTrip, mobiusMatrix, mobiusNormalize, mobiusSameMap,
  validateMobiusMatrix,
} from '../../src/indra/mobius.ts';

const A1 = cx(-4, 0);
const B1 = cx(-2, 0);
const R1 = 0.4;
const A2 = cx(2, 0);
const B2 = cx(4, 0);

function rawFirstGenerator() {
  return mobiusFromCirclePair(A1, B1, R1);
}

function normalizedFirstGenerator() {
  return mobiusNormalize(rawFirstGenerator()).matrix;
}

test('paired-disc generator raw matrix matches the closed form and its determinant is -r^2', () => {
  const raw = rawFirstGenerator();
  assert.ok(cxClose(raw.a, cx(-2, 0), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(raw.b, cx(0.16 - 8, 0), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(raw.c, CX_ONE, { absolute: 1e-15, relative: 1e-15 }));
  assert.ok(cxClose(raw.d, cx(4, 0), { absolute: 1e-12, relative: 1e-12 }));
  const determinant = mobiusDeterminant(raw);
  assert.ok(cxClose(determinant, cx(-0.16, 0), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(Math.abs(mobiusNormalize(raw).determinantMagnitude - 0.16) < 1e-12);
});

test('moebius normalization fixes determinant one deterministically with a canonical sign', () => {
  const raw = rawFirstGenerator();
  const normalization = mobiusNormalize(raw);
  assert.ok(cxClose(normalization.squareRootFactor, cx(0, 0.4), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(normalization.matrix.a, cx(0, 5), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(normalization.matrix.b, cx(0, 19.6), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(normalization.matrix.c, cx(0, -2.5), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(normalization.matrix.d, cx(0, -10), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(normalization.determinantOneError < 1e-12);
  assert.deepEqual(mobiusCanonicalSign(normalization.matrix), normalization.matrix);
  assert.throws(() => mobiusNormalize(mobiusMatrix(CX_ONE, CX_ZERO, CX_ONE, CX_ZERO)), RangeError);
});

test('normalization is invariant under rescaling the raw matrix by any nonzero complex factor', () => {
  const raw = rawFirstGenerator();
  const reference = mobiusNormalize(raw).matrix;
  for (const factor of [cx(-1, 0), cx(0, 1), cx(2, 0), cx(1, 1), cx(-3, 0.5)]) {
    const rescaled = mobiusMatrix(cxMul(raw.a, factor), cxMul(raw.b, factor), cxMul(raw.c, factor), cxMul(raw.d, factor));
    const normalization = mobiusNormalize(rescaled);
    assert.ok(normalization.determinantOneError < 1e-12);
    assert.ok(mobiusSameMap(normalization.matrix, reference, 1e-9), `rescale by ${JSON.stringify(factor)} changed the normalized map`);
    assert.deepEqual(mobiusCanonicalSign(normalization.matrix), normalization.matrix);
  }
});

test('matrix constructor refuses nonfinite entries', () => {
  assert.throws(() => mobiusMatrix(cx(Number.NaN, 0), CX_ZERO, CX_ZERO, CX_ONE), TypeError);
  assert.throws(() => mobiusMatrix(CX_ONE, CX_ZERO, CX_ZERO, cx(0, Number.POSITIVE_INFINITY)), TypeError);
});

test('known answer: the first generator maps -3 to -1.84 and back', () => {
  const raw = rawFirstGenerator();
  const normalized = normalizedFirstGenerator();
  for (const matrix of [raw, normalized]) {
    const image = mobiusApply(matrix, cx(-3, 0));
    assert.equal(image.kind, 'finite');
    if (image.kind === 'finite') {
      assert.ok(cxClose(image.value, cx(-1.84, 0), { absolute: 1e-12, relative: 1e-12 }), `f(-3) = ${JSON.stringify(image.value)}`);
    }
    const roundTrip = mobiusInverseRoundTrip(matrix, cx(-3, 0));
    assert.equal(roundTrip.kind, 'round-trip');
    if (roundTrip.kind === 'round-trip') assert.ok(roundTrip.relativeError < 1e-12);
  }
  const inverseImage = mobiusApply(mobiusInverseOfNormalized(normalized), cx(-1.84, 0));
  assert.equal(inverseImage.kind, 'finite');
  if (inverseImage.kind === 'finite') {
    assert.ok(cxClose(inverseImage.value, cx(-3, 0), { absolute: 1e-12, relative: 1e-12 }));
  }
  const second = mobiusApply(mobiusFromCirclePair(A2, B2, R1), cx(3, 0));
  assert.equal(second.kind, 'finite');
  if (second.kind === 'finite') {
    assert.ok(cxClose(second.value, cx(4.16, 0), { absolute: 1e-12, relative: 1e-12 }));
  }
});

test('the generator pole at z = a maps to infinity, including near the pole', () => {
  const normalized = normalizedFirstGenerator();
  assert.equal(mobiusApply(normalized, cx(-4, 0)), MOBIUS_INFINITY);
  assert.equal(mobiusApply(normalized, cx(-3.9999999999999996, 0)), MOBIUS_INFINITY);
  const nearby = mobiusApply(normalized, cx(-4 + 1e-6, 0));
  assert.equal(nearby.kind, 'finite');
  if (nearby.kind === 'finite') assert.ok(cxAbs(nearby.value) > 1e5);
  const raw = rawFirstGenerator();
  assert.equal(mobiusApply(raw, cx(-4, 0)), MOBIUS_INFINITY);
});

test('the identity map passes every finite point through unchanged', () => {
  for (const z of [CX_ZERO, cx(1, 1), cx(-3.7, 12.25), cx(1e8, -1e-8)]) {
    const image = mobiusApply(MOBIUS_IDENTITY, z);
    assert.equal(image.kind, 'finite');
    if (image.kind === 'finite') assert.deepEqual(image.value, z);
  }
});

test('sign-flipped matrices represent the same map and evaluate identically', () => {
  const normalized = normalizedFirstGenerator();
  const flipped = mobiusMatrix(cxNegate(normalized.a), cxNegate(normalized.b), cxNegate(normalized.c), cxNegate(normalized.d));
  assert.ok(mobiusSameMap(normalized, flipped, 0));
  for (const z of [cx(-3, 0), cx(-10, 5), cx(0, 0), cx(100, -100), cx(-4.5, 0.2)]) {
    const first = mobiusApply(normalized, z);
    const second = mobiusApply(flipped, z);
    assert.equal(first.kind, second.kind);
    if (first.kind === 'finite' && second.kind === 'finite') {
      assert.ok(cxClose(first.value, second.value, { absolute: 1e-12, relative: 1e-12 }));
    }
  }
});

test('frobenius norm and condition witness match the known values for the fixture generator', () => {
  const raw = rawFirstGenerator();
  assert.equal(mobiusFrobeniusNorm(raw), Math.hypot(2, 7.84, 1, 4));
  const condition = mobiusConditionFrobenius(raw);
  assert.ok(Math.abs(condition - 515.41) < 1e-9, `kappa_F = ${condition}`);
  assert.ok(mobiusConditionFrobenius(MOBIUS_IDENTITY) <= 4 + 1e-9);
});

test('inverse of a normalized matrix is the signed adjugate and composes back to the identity map', () => {
  const normalized = normalizedFirstGenerator();
  const inverse = mobiusInverseOfNormalized(normalized);
  assert.ok(cxClose(inverse.a, cx(0, -10), { absolute: 1e-12, relative: 1e-12 }) || cxClose(inverse.a, cx(0, 10), { absolute: 1e-12, relative: 1e-12 }));
  const composed = mobiusCompose(normalized, inverse);
  for (const z of [cx(-3, 0), cx(11, -7), cx(0, 4), cx(-4 + 1e-3, 1e-3)]) {
    const image = mobiusApply(composed, z);
    assert.equal(image.kind, 'finite');
    if (image.kind === 'finite') {
      assert.ok(cxClose(image.value, z, { absolute: 1e-9, relative: 1e-9 }), `f o f^-1 at ${JSON.stringify(z)} gave ${JSON.stringify(image.value)}`);
    }
  }
  assert.ok(mobiusIdentityDeviation(normalized) < 1e-12);
  assert.ok(mobiusSameMap(mobiusInverse(normalized), inverse, 1e-9));
  assert.throws(() => mobiusInverse(mobiusMatrix(CX_ONE, CX_ZERO, CX_ONE, CX_ZERO)), RangeError);
});

test('composition agrees with sequential application and is sign-invariant', () => {
  const first = normalizedFirstGenerator();
  const second = mobiusNormalize(mobiusFromCirclePair(A2, B2, R1)).matrix;
  const composed = mobiusCompose(first, second);
  const scaled = mobiusMatrix(cxScale(composed.a, 7), cxScale(composed.b, 7), cxScale(composed.c, 7), cxScale(composed.d, 7));
  for (const z of [cx(-3, 0), cx(-6, 2), cx(0, 0), cx(-4.5, -1), cx(50, 50)]) {
    const inner = mobiusApply(second, z);
    const outer = inner.kind === 'finite' ? mobiusApply(first, inner.value) : MOBIUS_INFINITY;
    const direct = mobiusApply(composed, z);
    const directScaled = mobiusApply(scaled, z);
    assert.equal(outer.kind, direct.kind);
    assert.equal(directScaled.kind, direct.kind);
    if (outer.kind === 'finite' && direct.kind === 'finite' && directScaled.kind === 'finite') {
      assert.ok(cxClose(outer.value, direct.value, { absolute: 1e-9, relative: 1e-9 }));
      assert.ok(cxClose(directScaled.value, direct.value, { absolute: 1e-9, relative: 1e-9 }));
    }
  }
});

test('matrix validation accepts the fixture and refuses degenerate or ill-conditioned matrices', () => {
  const valid = validateMobiusMatrix(rawFirstGenerator());
  assert.equal(valid.kind, 'valid');
  if (valid.kind === 'valid') {
    assert.ok(valid.conditionFrobenius < 1e9);
    assert.ok(valid.identityDeviation < 1e-12);
  }
  const tinyRadius = validateMobiusMatrix(mobiusFromCirclePair(A1, B1, 1e-7));
  assert.equal(tinyRadius.kind, 'invalid');
  if (tinyRadius.kind === 'invalid') assert.equal(tinyRadius.code, 'degenerate-determinant');
  const illConditioned = validateMobiusMatrix(rawFirstGenerator(), { conditionBound: 100 });
  assert.equal(illConditioned.kind, 'invalid');
  if (illConditioned.kind === 'invalid') assert.equal(illConditioned.code, 'condition-bound-exceeded');
});

test('inverse round trip stays tight over exterior sample points of both fixture generators', () => {
  for (const [aCenter, bCenter] of [[A1, B1], [A2, B2]] as const) {
    const raw = mobiusFromCirclePair(aCenter, bCenter, R1);
    for (const factor of [1.5, 3, 10, 100]) {
      for (let step = 0; step < 12; step += 1) {
        const angle = (2 * Math.PI * step) / 12;
        const z = cx(aCenter.re + factor * R1 * Math.cos(angle), aCenter.im + factor * R1 * Math.sin(angle));
        const roundTrip = mobiusInverseRoundTrip(raw, z);
        assert.equal(roundTrip.kind, 'round-trip');
        if (roundTrip.kind === 'round-trip') assert.ok(roundTrip.relativeError < 1e-9, `round trip error ${roundTrip.relativeError} at ${JSON.stringify(z)}`);
      }
    }
  }
});
