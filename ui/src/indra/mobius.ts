/** Deterministically normalized 2x2 complex Moebius matrices with inverse, conditioning and pole-aware evaluation (D-073 row D2). */
import {
  CX_ONE, CX_ZERO, cxAbs, cxAdd, cxClose, cxDivide, cxIsFinite, cxMul, cxNegate, cxScale, cxSafeDivide, cxSqrt, cxSub,
  type Complex,
} from './complex.ts';

export interface MobiusMatrix {
  readonly a: Complex;
  readonly b: Complex;
  readonly c: Complex;
  readonly d: Complex;
}

export const MOBIUS_IDENTITY: MobiusMatrix = { a: CX_ONE, b: CX_ZERO, c: CX_ZERO, d: CX_ONE };

export type MobiusImage =
  | Readonly<{ kind: 'finite'; value: Complex }>
  | Readonly<{ kind: 'infinity' }>;

export const MOBIUS_INFINITY: MobiusImage = Object.freeze({ kind: 'infinity' }) as MobiusImage;

/** Every entry must be finite; nonfinite input is a programming error and is refused here. */
export function mobiusMatrix(a: Complex, b: Complex, c: Complex, d: Complex): MobiusMatrix {
  for (const entry of [a, b, c, d]) {
    if (!cxIsFinite(entry)) throw new TypeError(`moebius matrix entries must be finite: ${JSON.stringify(entry)}`);
  }
  return { a, b, c, d };
}

/** Raw generator matrix of the paired-disc map f(z) = (b z + (r^2 - a b)) / (z - a), with determinant -r^2. */
export function mobiusFromCirclePair(aCenter: Complex, bCenter: Complex, radius: number): MobiusMatrix {
  const radiusSquared = cxScale(CX_ONE, radius * radius);
  const product = cxMul(aCenter, bCenter);
  return mobiusMatrix(bCenter, cxSub(radiusSquared, product), CX_ONE, cxNegate(aCenter));
}

export function mobiusDeterminant(m: MobiusMatrix): Complex {
  return cxSub(cxMul(m.a, m.d), cxMul(m.b, m.c));
}

export function mobiusFrobeniusNorm(m: MobiusMatrix): number {
  return Math.hypot(cxAbs(m.a), cxAbs(m.b), cxAbs(m.c), cxAbs(m.d));
}

/** Exact inverse of a determinant-one representative: the signed adjugate, in canonical sign. */
export function mobiusInverseOfNormalized(m: MobiusMatrix): MobiusMatrix {
  return mobiusCanonicalSign(mobiusMatrix(m.d, cxNegate(m.b), cxNegate(m.c), m.a));
}

/** General inverse: adjugate divided by the determinant, in canonical sign. Throws on a singular matrix. */
export function mobiusInverse(m: MobiusMatrix): MobiusMatrix {
  const determinant = mobiusDeterminant(m);
  if (cxAbs(determinant) === 0) throw new RangeError('moebius inverse requires a nonzero determinant');
  const determinantInverse = cxDivide(CX_ONE, determinant);
  return mobiusCanonicalSign(mobiusMatrix(
    cxMul(m.d, determinantInverse),
    cxMul(cxNegate(m.b), determinantInverse),
    cxMul(cxNegate(m.c), determinantInverse),
    cxMul(m.a, determinantInverse),
  ));
}

/** Matrix product m*n, which composes maps as z -> m(n(z)). */
export function mobiusCompose(m: MobiusMatrix, n: MobiusMatrix): MobiusMatrix {
  return mobiusMatrix(
    cxAdd(cxMul(m.a, n.a), cxMul(m.b, n.c)),
    cxAdd(cxMul(m.a, n.b), cxMul(m.b, n.d)),
    cxAdd(cxMul(m.c, n.a), cxMul(m.d, n.c)),
    cxAdd(cxMul(m.c, n.b), cxMul(m.d, n.d)),
  );
}

const CANONICAL_SIGN_RELATIVE = 1e-12;

/** Fixes the PSL(2,C) sign ambiguity: the first significant entry (a, b, c, d) has positive real, else positive imaginary part. */
export function mobiusCanonicalSign(m: MobiusMatrix): MobiusMatrix {
  const threshold = CANONICAL_SIGN_RELATIVE * mobiusFrobeniusNorm(m);
  for (const entry of [m.a, m.b, m.c, m.d]) {
    if (Math.abs(entry.re) > threshold) return entry.re > 0 ? m : negateMatrix(m);
    if (Math.abs(entry.im) > threshold) return entry.im > 0 ? m : negateMatrix(m);
  }
  return m;
}

function negateMatrix(m: MobiusMatrix): MobiusMatrix {
  return { a: cxNegate(m.a), b: cxNegate(m.b), c: cxNegate(m.c), d: cxNegate(m.d) };
}

export interface MobiusNormalizationOptions {
  readonly determinantFloor?: number;
  readonly tolerance?: number;
}

export interface MobiusNormalization {
  readonly matrix: MobiusMatrix;
  readonly determinant: Complex;
  readonly determinantMagnitude: number;
  readonly squareRootFactor: Complex;
  readonly determinantOneError: number;
}

/** Divides by the principal square root of the determinant, then fixes the canonical sign. */
export function mobiusNormalize(m: MobiusMatrix, options?: MobiusNormalizationOptions): MobiusNormalization {
  const determinantFloor = options?.determinantFloor ?? 1e-12;
  const determinant = mobiusDeterminant(m);
  const determinantMagnitude = cxAbs(determinant);
  if (!(determinantMagnitude > determinantFloor)) {
    throw new RangeError(`moebius determinant magnitude ${determinantMagnitude} is at or below the floor ${determinantFloor}`);
  }
  const squareRootFactor = cxSqrt(determinant);
  const matrix = mobiusCanonicalSign(mobiusMatrix(
    cxDivide(m.a, squareRootFactor),
    cxDivide(m.b, squareRootFactor),
    cxDivide(m.c, squareRootFactor),
    cxDivide(m.d, squareRootFactor),
  ));
  const determinantOneError = cxAbs(cxSub(mobiusDeterminant(matrix), CX_ONE));
  return { matrix, determinant, determinantMagnitude, squareRootFactor, determinantOneError };
}

/** kappa_F = ||M||_F * ||M^-1||_F on the determinant-one representative. */
export function mobiusConditionFrobenius(m: MobiusMatrix, options?: MobiusNormalizationOptions): number {
  const normalized = mobiusNormalize(m, options).matrix;
  return mobiusFrobeniusNorm(normalized) * mobiusFrobeniusNorm(mobiusInverseOfNormalized(normalized));
}

/** min(||M M^-1 - I||_F, ||M M^-1 + I||_F): the sign ambiguity of PSL(2,C) does not count as an error. */
export function mobiusIdentityDeviation(m: MobiusMatrix, options?: MobiusNormalizationOptions): number {
  const normalized = mobiusNormalize(m, options).matrix;
  const product = mobiusCompose(normalized, mobiusInverseOfNormalized(normalized));
  const plus = Math.hypot(
    product.a.re - 1, product.a.im,
    product.b.re, product.b.im,
    product.c.re, product.c.im,
    product.d.re - 1, product.d.im,
  );
  const minus = Math.hypot(
    product.a.re + 1, product.a.im,
    product.b.re, product.b.im,
    product.c.re, product.c.im,
    product.d.re + 1, product.d.im,
  );
  return Math.min(plus, minus);
}

export interface MobiusApplyOptions {
  readonly poleRelativeEpsilon?: number;
}

const DEFAULT_POLE_RELATIVE_EPSILON = 1e-14;

/** Homogeneous evaluation (a z + b) / (c z + d); catastrophic cancellation against the pole is reported as infinity. */
export function mobiusApply(m: MobiusMatrix, z: Complex, options?: MobiusApplyOptions): MobiusImage {
  const cz = cxMul(m.c, z);
  const denominator = cxAdd(cz, m.d);
  const epsilon = options?.poleRelativeEpsilon ?? DEFAULT_POLE_RELATIVE_EPSILON;
  const cancellationScale = cxAbs(cz) + cxAbs(m.d);
  if (cxAbs(denominator) <= epsilon * cancellationScale) return MOBIUS_INFINITY;
  const numerator = cxAdd(cxMul(m.a, z), m.b);
  const quotient = cxSafeDivide(numerator, denominator);
  if (quotient.kind === 'pole') return MOBIUS_INFINITY;
  return { kind: 'finite', value: quotient.value };
}

export type MobiusRoundTrip =
  | Readonly<{ kind: 'round-trip'; absoluteError: number; relativeError: number }>
  | Readonly<{ kind: 'pole-image' }>;

/** Applies m, then the exact normalized inverse, and measures the return error at a non-pole point. */
export function mobiusInverseRoundTrip(m: MobiusMatrix, z: Complex, options?: MobiusApplyOptions): MobiusRoundTrip {
  const image = mobiusApply(m, z, options);
  if (image.kind === 'infinity') return { kind: 'pole-image' };
  const normalized = mobiusNormalize(m);
  const back = mobiusApply(mobiusInverseOfNormalized(normalized.matrix), image.value, options);
  if (back.kind === 'infinity') return { kind: 'pole-image' };
  const absoluteError = cxAbs(cxSub(back.value, z));
  const relativeError = absoluteError / Math.max(1, cxAbs(z));
  return { kind: 'round-trip', absoluteError, relativeError };
}

export type MobiusValidationCode =
  | 'degenerate-determinant'
  | 'determinant-one-error'
  | 'inverse-identity-error'
  | 'condition-bound-exceeded';

export interface MobiusValidationOptions {
  readonly determinantFloor?: number;
  readonly tolerance?: number;
  readonly conditionBound?: number;
}

export type MobiusValidation =
  | Readonly<{
    kind: 'valid';
    normalization: MobiusNormalization;
    conditionFrobenius: number;
    identityDeviation: number;
  }>
  | Readonly<{
    kind: 'invalid';
    code: MobiusValidationCode;
    message: string;
    witness: Readonly<Record<string, number | string>>;
  }>;

export function validateMobiusMatrix(m: MobiusMatrix, options?: MobiusValidationOptions): MobiusValidation {
  const determinantFloor = options?.determinantFloor ?? 1e-12;
  const tolerance = options?.tolerance ?? 1e-9;
  const conditionBound = options?.conditionBound ?? 1e9;
  const determinantMagnitude = cxAbs(mobiusDeterminant(m));
  if (!(determinantMagnitude > determinantFloor)) {
    return {
      kind: 'invalid',
      code: 'degenerate-determinant',
      message: `determinant magnitude ${determinantMagnitude} is at or below the floor ${determinantFloor}`,
      witness: { determinantMagnitude, determinantFloor },
    };
  }
  const normalization = mobiusNormalize(m, { determinantFloor, tolerance });
  if (!(normalization.determinantOneError < tolerance)) {
    return {
      kind: 'invalid',
      code: 'determinant-one-error',
      message: `normalized determinant deviates from one by ${normalization.determinantOneError}, tolerance ${tolerance}`,
      witness: { determinantOneError: normalization.determinantOneError, tolerance },
    };
  }
  const identityDeviation = mobiusIdentityDeviation(m, { determinantFloor, tolerance });
  if (!(identityDeviation < tolerance)) {
    return {
      kind: 'invalid',
      code: 'inverse-identity-error',
      message: `||M M^-1 - I||_F is ${identityDeviation}, tolerance ${tolerance}`,
      witness: { identityDeviation, tolerance },
    };
  }
  const conditionFrobenius = mobiusConditionFrobenius(m, { determinantFloor, tolerance });
  if (!(conditionFrobenius < conditionBound)) {
    return {
      kind: 'invalid',
      code: 'condition-bound-exceeded',
      message: `kappa_F is ${conditionFrobenius}, bound ${conditionBound}`,
      witness: { conditionFrobenius, conditionBound },
    };
  }
  return { kind: 'valid', normalization, conditionFrobenius, identityDeviation };
}

/** Equal as maps up to the PSL(2,C) sign: every entry agrees, or every entry is negated. */
export function mobiusSameMap(m: MobiusMatrix, n: MobiusMatrix, tolerance = 1e-9): boolean {
  const closeness = { absolute: tolerance, relative: tolerance };
  return (cxClose(m.a, n.a, closeness) && cxClose(m.b, n.b, closeness) && cxClose(m.c, n.c, closeness) && cxClose(m.d, n.d, closeness))
    || (cxClose(m.a, cxNegate(n.a), closeness) && cxClose(m.b, cxNegate(n.b), closeness) && cxClose(m.c, cxNegate(n.c), closeness) && cxClose(m.d, cxNegate(n.d), closeness));
}
