/** Scale-safe complex arithmetic for the Indra's Pearls projection (D-073 row D1). Pole-aware division reports infinity instead of dividing by nearly zero. */
/** D-073 projection contract type, re-exported so the complex layer owns one definition. */
export type { Complex } from '../projection/contract-types.ts';
import type { Complex } from '../projection/contract-types.ts';

export const CX_ZERO: Complex = { re: 0, im: 0 };
export const CX_ONE: Complex = { re: 1, im: 0 };
export const CX_I: Complex = { re: 0, im: 1 };

export function cx(re: number, im = 0): Complex {
  return { re: canonicalZero(re), im: canonicalZero(im) };
}

/** Maps -0 to +0 so results stay byte-stable under canonical serialization. */
function canonicalZero(value: number): number {
  return value === 0 ? 0 : value;
}

export function cxFromPolar(radius: number, angle: number): Complex {
  return { re: radius * Math.cos(angle), im: radius * Math.sin(angle) };
}

export function cxIsFinite(z: Complex): boolean {
  return Number.isFinite(z.re) && Number.isFinite(z.im);
}

export function cxIsZero(z: Complex): boolean {
  return z.re === 0 && z.im === 0;
}

/** Overflow-safe modulus via hypot: |(1e200, 1e200)| stays finite where re*re + im*im overflows. */
export function cxAbs(z: Complex): number {
  return Math.hypot(z.re, z.im);
}

/** Scaled |z|^2: the dominant component is factored out before squaring. */
export function cxAbsSquared(z: Complex): number {
  const scale = Math.max(Math.abs(z.re), Math.abs(z.im));
  if (scale === 0) return 0;
  const re = z.re / scale;
  const im = z.im / scale;
  return scale * scale * (re * re + im * im);
}

export function cxArg(z: Complex): number {
  return Math.atan2(z.im, z.re);
}

export function cxConjugate(z: Complex): Complex {
  return { re: canonicalZero(z.re), im: canonicalZero(-z.im) };
}

export function cxNegate(z: Complex): Complex {
  return { re: canonicalZero(-z.re), im: canonicalZero(-z.im) };
}

export function cxAdd(z: Complex, w: Complex): Complex {
  return { re: canonicalZero(z.re + w.re), im: canonicalZero(z.im + w.im) };
}

export function cxSub(z: Complex, w: Complex): Complex {
  return { re: canonicalZero(z.re - w.re), im: canonicalZero(z.im - w.im) };
}

export function cxScale(z: Complex, factor: number): Complex {
  return { re: canonicalZero(z.re * factor), im: canonicalZero(z.im * factor) };
}

/** Smith-factored product: intermediate magnitudes stay bounded by 2|z|*|w|, so no premature overflow. */
export function cxMul(z: Complex, w: Complex): Complex {
  const a = z.re;
  const b = z.im;
  const c = w.re;
  const d = w.im;
  if (a === 0 && b === 0) return CX_ZERO;
  if (Math.abs(a) >= Math.abs(b)) {
    const t = b / a;
    return { re: canonicalZero(a * (c - d * t)), im: canonicalZero(a * (d + c * t)) };
  }
  const t = a / b;
  return { re: canonicalZero(b * (c * t - d)), im: canonicalZero(b * (c + d * t)) };
}

export type CxDivisionOutcome =
  | Readonly<{ kind: 'finite'; value: Complex }>
  | Readonly<{ kind: 'pole' }>;

export const CX_POLE: CxDivisionOutcome = Object.freeze({ kind: 'pole' }) as CxDivisionOutcome;

/** Smith quotient or null when the denominator is zero or the true quotient is not representable. */
function smithQuotient(numerator: Complex, denominator: Complex): Complex | null {
  const a = numerator.re;
  const b = numerator.im;
  const c = denominator.re;
  const d = denominator.im;
  const denominatorScale = Math.max(Math.abs(c), Math.abs(d));
  if (denominatorScale === 0) return null;
  if (Math.abs(c) >= Math.abs(d)) {
    const t = d / c;
    const denominatorValue = c + d * t;
    return { re: canonicalZero((a + b * t) / denominatorValue), im: canonicalZero((b - a * t) / denominatorValue) };
  }
  const t = c / d;
  const denominatorValue = d + c * t;
  return { re: canonicalZero((a * t + b) / denominatorValue), im: canonicalZero((b * t - a) / denominatorValue) };
}

/** Pole-aware division: an exact zero, near-zero or overflowing quotient is reported as { kind: 'pole' }. */
export function cxSafeDivide(numerator: Complex, denominator: Complex): CxDivisionOutcome {
  const quotient = smithQuotient(numerator, denominator);
  if (quotient === null || !cxIsFinite(quotient)) return CX_POLE;
  return { kind: 'finite', value: quotient };
}

/** Strict division for callers that have already excluded poles; throws instead of returning noise. */
export function cxDivide(numerator: Complex, denominator: Complex): Complex {
  const quotient = smithQuotient(numerator, denominator);
  if (quotient === null || !cxIsFinite(quotient)) {
    throw new RangeError('complex division pole: the denominator is zero or the quotient overflows');
  }
  return quotient;
}

/** Principal square root with the deterministic branch: the root has nonnegative imaginary part. */
export function cxSqrt(z: Complex): Complex {
  if (z.re === 0 && z.im === 0) return CX_ZERO;
  const modulus = cxAbs(z);
  if (z.re >= 0) {
    const re = Math.sqrt((modulus + z.re) / 2);
    return { re: canonicalZero(re), im: canonicalZero(z.im / (2 * re)) };
  }
  const sign = z.im >= 0 ? 1 : -1;
  const im = sign * Math.sqrt((modulus - z.re) / 2);
  return { re: canonicalZero(z.im / (2 * im)), im: canonicalZero(im) };
}

export interface CxCloseOptions {
  readonly absolute?: number;
  readonly relative?: number;
}

/** |z - w| <= absolute + relative * max(|z|, |w|). */
export function cxClose(z: Complex, w: Complex, options?: CxCloseOptions): boolean {
  const absolute = options?.absolute ?? 1e-12;
  const relative = options?.relative ?? 1e-12;
  const difference = cxAbs(cxSub(z, w));
  const scale = Math.max(cxAbs(z), cxAbs(w));
  return difference <= absolute + relative * scale;
}
