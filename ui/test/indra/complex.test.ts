import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CX_I, CX_ONE, CX_POLE, CX_ZERO, cx, cxAbs, cxAbsSquared, cxAdd, cxArg, cxClose, cxConjugate, cxDivide, cxFromPolar,
  cxIsFinite, cxIsZero, cxMul, cxNegate, cxSafeDivide, cxScale, cxSqrt, cxSub,
} from '../../src/indra/complex.ts';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededSample(seed: number, scale: number): { re: number; im: number }[] {
  const random = mulberry32(seed);
  const values: { re: number; im: number }[] = [];
  for (let index = 0; index < 40; index += 1) {
    values.push({ re: (random() * 2 - 1) * scale, im: (random() * 2 - 1) * scale });
  }
  return values;
}

test('complex conjugate mirrors the sign of the imaginary part and squares to the modulus', () => {
  assert.deepEqual(cxConjugate(cx(3, 4)), { re: 3, im: -4 });
  assert.deepEqual(cxConjugate(cx(0, -2)), { re: 0, im: 2 });
  assert.deepEqual(cxConjugate(CX_I), { re: 0, im: -1 });
  for (const z of [...seededSample(11, 1), ...seededSample(12, 100), ...seededSample(13, 1e-6)]) {
    const product = cxMul(z, cxConjugate(z));
    assert.ok(cxClose(product, cx(cxAbsSquared(z), 0), { absolute: 1e-9, relative: 1e-9 }), `z*conj(z) != |z|^2 for ${JSON.stringify(z)}`);
    assert.ok(Math.abs(product.im) <= 1e-9 * Math.max(1, cxAbsSquared(z)));
  }
});

test('complex modulus and squared modulus use overflow-safe scaling', () => {
  assert.equal(cxAbs(cx(3, 4)), 5);
  assert.equal(cxAbs(CX_ZERO), 0);
  assert.equal(cxAbsSquared(cx(3, 4)), 25);
  const huge = cx(1e200, 1e200);
  assert.ok(Number.isFinite(cxAbs(huge)));
  assert.ok(Math.abs(cxAbs(huge) - Math.SQRT2 * 1e200) <= 1e184);
  const subnormal = cx(1e-160, 1e-160);
  assert.ok(cxAbsSquared(subnormal) > 0);
  assert.equal(cxAbsSquared(cx(1e-200, 1e-200)), 0);
  assert.ok(cxIsFinite(huge));
  assert.ok(!cxIsFinite(cx(Number.NaN, 0)));
  assert.ok(!cxIsFinite(cx(0, Number.POSITIVE_INFINITY)));
});

test('complex addition, subtraction, negation and real scaling agree with component algebra', () => {
  assert.deepEqual(cxAdd(cx(1, 2), cx(3, -1)), { re: 4, im: 1 });
  assert.deepEqual(cxSub(cx(1, 2), cx(3, -1)), { re: -2, im: 3 });
  assert.deepEqual(cxNegate(cx(1, -2)), { re: -1, im: 2 });
  assert.deepEqual(cxScale(cx(1, -2), -3), { re: -3, im: 6 });
  for (const z of seededSample(21, 5)) {
    for (const w of seededSample(22, 5)) {
      assert.deepEqual(cxAdd(z, w), { re: z.re + w.re, im: z.im + w.im });
      assert.deepEqual(cxSub(z, w), { re: z.re - w.re, im: z.im - w.im });
    }
  }
});

test('complex multiplication matches the naive product on moderate magnitudes', () => {
  for (const z of seededSample(31, 7)) {
    for (const w of seededSample(32, 7)) {
      const naive = { re: z.re * w.re - z.im * w.im, im: z.re * w.im + z.im * w.re };
      assert.ok(cxClose(cxMul(z, w), naive, { absolute: 1e-12, relative: 1e-12 }), `z*w disagrees for ${JSON.stringify(z)} ${JSON.stringify(w)}`);
    }
  }
  assert.deepEqual(cxMul(CX_I, CX_I), { re: -1, im: 0 });
  assert.deepEqual(cxMul(CX_ONE, cx(2, -3)), { re: 2, im: -3 });
  assert.deepEqual(cxMul(CX_ZERO, cx(5, 5)), CX_ZERO);
});

test('complex multiplication is scale-safe where naive products overflow to NaN', () => {
  const cancelling = cxMul(cx(1e200, 1e200), cx(1e155, 1e155));
  const naiveRe = 1e200 * 1e155 - 1e200 * 1e155;
  assert.ok(Number.isNaN(naiveRe));
  assert.equal(cancelling.re, 0);
  assert.equal(cancelling.im, Number.POSITIVE_INFINITY);
  const cancellingImaginary = cxMul(cx(1e200, 1e200), cx(1e155, -1e155));
  const naiveIm = 1e200 * -1e155 + 1e200 * 1e155;
  assert.ok(Number.isNaN(naiveIm));
  assert.equal(cancellingImaginary.re, Number.POSITIVE_INFINITY);
  assert.equal(cancellingImaginary.im, 0);
});

test('complex division round-trips through multiplication and covers both Smith branches', () => {
  for (const z of [...seededSample(41, 1), ...seededSample(42, 250)]) {
    for (const w of [...seededSample(43, 1), ...seededSample(44, 250)]) {
      if (Math.max(Math.abs(w.re), Math.abs(w.im)) < 5e-2) continue;
      const quotient = cxDivide(z, w);
      const back = cxMul(quotient, w);
      assert.ok(cxClose(back, z, { absolute: 1e-9, relative: 1e-9 }), `(z/w)*w != z for ${JSON.stringify(z)} ${JSON.stringify(w)}`);
    }
  }
  const realDominant = cxDivide(cx(1, 1), cx(2, 0.5));
  const imaginaryDominant = cxDivide(cx(1, 1), cx(0.5, 2));
  assert.ok(cxClose(realDominant, cx(0.5882352941176471, 0.35294117647058826), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(imaginaryDominant, cx(0.5882352941176471, -0.35294117647058826), { absolute: 1e-12, relative: 1e-12 }));
  for (const z of seededSample(45, 9)) {
    const selfQuotient = cxDivide(z, z);
    assert.ok(cxClose(selfQuotient, CX_ONE, { absolute: 1e-12, relative: 1e-12 }));
  }
});

test('pole division reports infinity instead of dividing by zero or overflowing', () => {
  assert.equal(cxSafeDivide(CX_ONE, CX_ZERO), CX_POLE);
  assert.equal(cxSafeDivide(CX_ZERO, CX_ZERO), CX_POLE);
  assert.equal(cxSafeDivide(cx(1, -1), cx(0, 0)), CX_POLE);
  assert.equal(cxSafeDivide(cx(1e200, 1e200), cx(1e-200, 1e-200)), CX_POLE);
  assert.equal(cxSafeDivide(cx(1e200, 0), cx(1e-160, 0)), CX_POLE);
  const finite = cxSafeDivide(cx(1, 0), cx(1e-300, 0));
  assert.equal(finite.kind, 'finite');
  if (finite.kind === 'finite') assert.ok(Math.abs(finite.value.re - 1e300) / 1e300 < 1e-12);
  assert.throws(() => cxDivide(CX_ONE, CX_ZERO), RangeError);
  assert.throws(() => cxDivide(cx(1e200, 0), cx(1e-160, 0)), RangeError);
});

test('complex square root takes the deterministic principal branch and squares back', () => {
  assert.deepEqual(cxSqrt(cx(-1, 0)), { re: 0, im: 1 });
  assert.deepEqual(cxSqrt(cx(-4, 0)), { re: 0, im: 2 });
  assert.deepEqual(cxSqrt(cx(4, 0)), { re: 2, im: 0 });
  assert.deepEqual(cxSqrt(CX_ZERO), CX_ZERO);
  assert.deepEqual(cxSqrt(cx(0, 2)), { re: 1, im: 1 });
  assert.ok(cxClose(cxSqrt(cx(3, 4)), cx(2, 1), { absolute: 1e-12, relative: 1e-12 }));
  assert.ok(cxClose(cxSqrt(cx(-0.16, 0)), cx(0, 0.4), { absolute: 1e-12, relative: 1e-12 }));
  for (const z of [...seededSample(51, 3), ...seededSample(52, 1e-3), ...seededSample(53, 1e4), cx(0, -2)]) {
    const root = cxSqrt(z);
    assert.ok(root.re >= 0, `principal root must have nonnegative real part for ${JSON.stringify(z)}`);
    if (root.re === 0) assert.ok(root.im >= 0);
    assert.ok(cxClose(cxMul(root, root), z, { absolute: 1e-12, relative: 1e-12 }), `sqrt(z)^2 != z for ${JSON.stringify(z)}`);
    if (!(z.im === 0 && z.re < 0)) {
      assert.ok(cxClose(cxSqrt(cxConjugate(z)), cxConjugate(root), { absolute: 1e-12, relative: 1e-12 }), `conjugation symmetry failed for ${JSON.stringify(z)}`);
    }
  }
  assert.ok(cxClose(cxSqrt(cxConjugate(cx(-0.16, 0))), cxSqrt(cx(-0.16, 0)), { absolute: 0, relative: 0 }));
});

test('argument and polar construction round-trip deterministically', () => {
  for (let index = 0; index < 32; index += 1) {
    const radius = 0.25 + index * 0.5;
    const angle = -Math.PI + (index * 2 * Math.PI) / 32;
    const z = cxFromPolar(radius, angle);
    assert.ok(cxClose(z, cxFromPolar(cxAbs(z), cxArg(z)), { absolute: 1e-12, relative: 1e-12 }));
    assert.ok(Math.abs(cxAbs(z) - radius) <= 1e-12 * radius);
  }
  assert.equal(cxArg(CX_ONE), 0);
  assert.equal(cxArg(CX_I), Math.PI / 2);
  assert.equal(cxArg(cx(-1, 0)), Math.PI);
  assert.equal(cxIsZero(CX_ZERO), true);
  assert.equal(cxIsZero(cx(0, 1)), false);
});

test('conjugation distributes over the pole-free field operations', () => {
  for (const z of seededSample(61, 6)) {
    for (const w of seededSample(62, 6)) {
      assert.ok(cxClose(cxConjugate(cxAdd(z, w)), cxAdd(cxConjugate(z), cxConjugate(w)), { absolute: 1e-12, relative: 1e-12 }));
      assert.ok(cxClose(cxConjugate(cxSub(z, w)), cxSub(cxConjugate(z), cxConjugate(w)), { absolute: 1e-12, relative: 1e-12 }));
      assert.ok(cxClose(cxConjugate(cxMul(z, w)), cxMul(cxConjugate(z), cxConjugate(w)), { absolute: 1e-12, relative: 1e-12 }));
      assert.ok(cxClose(cxConjugate(cxDivide(z, w)), cxDivide(cxConjugate(z), cxConjugate(w)), { absolute: 1e-9, relative: 1e-9 }));
    }
  }
});

test('cxClose separates equal values from perturbed values at the requested tolerance', () => {
  assert.ok(cxClose(cx(1, 2), cx(1, 2)));
  assert.ok(cxClose(cx(1, 2), cx(1 + 1e-13, 2)));
  assert.ok(!cxClose(cx(1, 2), cx(1.1, 2)));
  assert.ok(cxClose(cx(1e6, 0), cx(1e6 + 1, 0), { absolute: 2 }));
  assert.ok(!cxClose(cx(1e6, 0), cx(1e6 + 1, 0), { absolute: 0.5 }));
});
