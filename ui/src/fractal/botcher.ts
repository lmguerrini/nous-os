/**
 * Forward Böttcher coordinate for F_c(z) = z^p + c (tranche E2).
 *
 * Finite branch-continuous evaluation
 *   Phi_{c,N}(z) = z exp(sum_{k=0}^{N-1} p^{-k-1} Log(1 + c / F_c^k(z)^p)),
 * with every Log taken on a factor 1 + c/z_k^p that stays inside |x| < 1 for exterior
 * points, so the principal branch is the continuously unwrapped one and no angle aliases.
 * Normalization Phi_c(z)/z -> 1 at infinity; functional equation Phi_c(F_c(z)) = Phi_c(z)^p.
 * The analytic derivative is Phi_{c,N}'(z) = Phi_{c,N}(z) * prod_{k=0}^{N-1} z_k^{p-1} / z_N,
 * checked against a central finite difference. Pure deterministic arithmetic.
 */
import type { Complex } from '../projection/contract-types.ts';
import type { FractalDynamics } from './parameters.ts';
import { seriesTailBound } from './parameters.ts';

export const BOTCHER_VERSION = 'botcher-series-v1';

export function cx(re: number, im = 0): Complex {
  return { re, im };
}
export function cxAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}
export function cxSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}
export function cxMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
export function cxScale(a: Complex, s: number): Complex {
  return { re: a.re * s, im: a.im * s };
}
export function cxDiv(a: Complex, b: Complex): Complex {
  const denominator = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / denominator, im: (a.im * b.re - a.re * b.im) / denominator };
}
export function cxAbs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}
export function cxArg(a: Complex): number {
  return Math.atan2(a.im, a.re);
}
export function cxExp(a: Complex): Complex {
  const modulus = Math.exp(a.re);
  return { re: modulus * Math.cos(a.im), im: modulus * Math.sin(a.im) };
}
/** Principal logarithm; the caller guarantees the argument is off the branch-cut abuse. */
export function cxLogPrincipal(a: Complex): Complex {
  return { re: Math.log(cxAbs(a)), im: cxArg(a) };
}
export function cxConjugate(a: Complex): Complex {
  return { re: a.re, im: -a.im };
}
/** Integer power by repeated multiplication (p is 2 or 3 here). */
export function cxPowInteger(a: Complex, n: number): Complex {
  let result = cx(1, 0);
  for (let i = 0; i < n; i += 1) result = cxMul(result, a);
  return result;
}
export function cxIsFinite(a: Complex): boolean {
  return Number.isFinite(a.re) && Number.isFinite(a.im);
}

export interface BotcherEvaluation {
  readonly kind: 'evaluation';
  readonly version: typeof BOTCHER_VERSION;
  readonly phi: Complex;
  readonly derivative: Complex;
  /** Forward orbit z_0 .. z_N with z_{k+1} = z_k^p + c. */
  readonly orbit: readonly Complex[];
  /** Principal Log(1 + c / z_k^p) terms, k = 0 .. N-1. */
  readonly logTerms: readonly Complex[];
  /** arg(z_0) + sum p^{-k-1} arg(1 + c/z_k^p): raw unwrapped argument of Phi_{c,N}(z). */
  readonly unwrappedArgument: number;
  /** |Phi| / |z|: the modulus correction product. */
  readonly modulusProduct: number;
  /** True when every |c / z_k^p| < 1, so no principal branch aliases. */
  readonly branchTrusted: boolean;
  /** Conservative bound on the omitted tail of the series (Infinity when untrusted). */
  readonly tailBound: number;
}

export type BotcherFailureCode =
  | 'invalid-iterations'
  | 'nonfinite-input'
  | 'nonfinite-orbit'
  | 'zero-log-argument'
  | 'nonfinite-log-term'
  | 'nonfinite-derivative';

export type BotcherResult =
  | BotcherEvaluation
  | Readonly<{ readonly kind: 'failure'; readonly code: BotcherFailureCode; readonly detail: string }>;

/** Evaluate the finite branch-continuous Böttcher coordinate Phi_{c,N}(z) and its witness data. */
export function forwardBotcher(z: Complex, dynamics: FractalDynamics, iterations: number): BotcherResult {
  const { power, c } = dynamics;
  if (!Number.isInteger(iterations) || iterations < 1) {
    return { kind: 'failure', code: 'invalid-iterations', detail: `iterations=${iterations}` };
  }
  if (!cxIsFinite(z) || !Number.isFinite(c)) {
    return { kind: 'failure', code: 'nonfinite-input', detail: `z=(${z.re}, ${z.im}), c=${c}` };
  }
  // Orbit values may overflow to Infinity: an escaping orbit is the expected exterior witness,
  // and every later log term is then exactly 0 in double precision. NaN is always a failure.
  const orbit: Complex[] = [z];
  const logTerms: Complex[] = [];
  let sum = cx(0, 0);
  let derivativeExponent = cx(0, 0);
  let coefficient = 1 / power;
  let branchTrusted = true;
  for (let k = 0; k < iterations; k += 1) {
    const current = orbit[k] as Complex;
    // When |z_k|^p overflows, the escape direction is irrelevant to every series term, so the
    // witness records (Infinity, 0) instead of letting complex multiplication produce NaN.
    const magnitude = cxAbs(current);
    const next = !Number.isFinite(Math.pow(magnitude, power))
      ? cx(Number.POSITIVE_INFINITY, 0)
      : cxAdd(cxPowInteger(current, power), cx(c, 0));
    if (Number.isNaN(next.re) || Number.isNaN(next.im)) {
      return { kind: 'failure', code: 'nonfinite-orbit', detail: `iterate ${k + 1} is NaN` };
    }
    orbit.push(next);
    let term = cx(0, 0);
    if (c !== 0) {
      if (current.re === 0 && current.im === 0) {
        return {
          kind: 'failure',
          code: 'zero-log-argument',
          detail: `1 + c / z_${k}^${power} undefined at z_${k} = 0`,
        };
      }
      // When |z_k|^p would overflow, |c|/|z_k|^p < 1e-150 and the log term is exactly 0 in
      // double precision; the naive complex division would produce NaN instead.
      const denominatorMagnitude = Math.pow(cxAbs(current), power);
      if (Number.isFinite(denominatorMagnitude) && denominatorMagnitude <= 1e150) {
        const denominator = cxPowInteger(current, power);
        const ratio = cxDiv(cx(c, 0), denominator);
        if (!cxIsFinite(ratio)) {
          return {
            kind: 'failure',
            code: 'zero-log-argument',
            detail: `1 + c / z_${k}^${power} undefined at |z_${k}| = ${cxAbs(current)}`,
          };
        }
        const factor = cxAdd(cx(1, 0), ratio);
        if (factor.re === 0 && factor.im === 0) {
          return {
            kind: 'failure',
            code: 'zero-log-argument',
            detail: `1 + c / z_${k}^${power} = 0 at |z_${k}| = ${cxAbs(current)}`,
          };
        }
        term = cxLogPrincipal(factor);
        if (!cxIsFinite(term)) {
          return { kind: 'failure', code: 'nonfinite-log-term', detail: `term ${k} nonfinite` };
        }
        if (!(cxAbs(ratio) < 1)) branchTrusted = false;
      }
    }
    logTerms.push(term);
    sum = cxAdd(sum, cxScale(term, coefficient));
    // Phi' = Phi * prod z_k^{p-1} / z_N telescopes to exp(sum (p^{-k-1} - 1) L_k), which cannot overflow.
    derivativeExponent = cxAdd(derivativeExponent, cxScale(term, coefficient - 1));
    coefficient /= power;
  }
  const phi = cxMul(z, cxExp(sum));
  if (!cxIsFinite(phi)) {
    return { kind: 'failure', code: 'nonfinite-orbit', detail: 'phi nonfinite' };
  }
  const derivative = cxExp(derivativeExponent);
  if (!cxIsFinite(derivative)) {
    return { kind: 'failure', code: 'nonfinite-derivative', detail: 'derivative nonfinite' };
  }
  return {
    kind: 'evaluation',
    version: BOTCHER_VERSION,
    phi,
    derivative,
    orbit,
    logTerms,
    unwrappedArgument: cxArg(z) + sum.im,
    modulusProduct: cxAbs(z) === 0 ? 1 : cxAbs(phi) / cxAbs(z),
    branchTrusted,
    tailBound: branchTrusted ? seriesTailBound(power, c, cxAbs(z), iterations) : Infinity,
  };
}

export interface BotcherResiduals {
  readonly kind: 'residuals';
  /** |Phi_{c,N}(F_c(z)) - Phi_{c,N}(z)^p| / |Phi_{c,N}(z)^p|: finite functional-equation residual. */
  readonly functionalEquation: number;
  /** |Phi_{c,N+1}(z) - Phi_{c,N}(z)| / |Phi_{c,N}(z)|: one-level truncation residual. */
  readonly truncation: number;
  readonly atZ: BotcherEvaluation;
  readonly atImage: BotcherEvaluation;
  readonly atNextLevel: BotcherEvaluation;
}

/** Measure the functional-equation and truncation residuals at an exterior point. */
export function botcherResiduals(
  z: Complex,
  dynamics: FractalDynamics,
  iterations: number,
): BotcherResiduals | Readonly<{ readonly kind: 'failure'; readonly code: BotcherFailureCode; readonly detail: string }> {
  const atZ = forwardBotcher(z, dynamics, iterations);
  if (atZ.kind === 'failure') return atZ;
  const image = cxAdd(cxPowInteger(z, dynamics.power), cx(dynamics.c, 0));
  const atImage = forwardBotcher(image, dynamics, iterations);
  if (atImage.kind === 'failure') return atImage;
  const atNextLevel = forwardBotcher(z, dynamics, iterations + 1);
  if (atNextLevel.kind === 'failure') return atNextLevel;
  const powered = cxPowInteger(atZ.phi, dynamics.power);
  const scale = Math.max(cxAbs(powered), 1e-300);
  return {
    kind: 'residuals',
    functionalEquation: cxAbs(cxSub(atImage.phi, powered)) / scale,
    truncation: cxAbs(cxSub(atNextLevel.phi, atZ.phi)) / Math.max(cxAbs(atZ.phi), 1e-300),
    atZ,
    atImage,
    atNextLevel,
  };
}

/** Analytic versus central finite-difference derivative check at an exterior point. */
export interface BotcherDerivativeCheck {
  readonly kind: 'derivative-check';
  readonly analytic: Complex;
  readonly numeric: Complex;
  readonly relativeError: number;
}

export function checkBotcherDerivative(
  z: Complex,
  dynamics: FractalDynamics,
  iterations: number,
  h: number,
): BotcherDerivativeCheck | Readonly<{ readonly kind: 'failure'; readonly code: BotcherFailureCode; readonly detail: string }> {
  const analyticEvaluation = forwardBotcher(z, dynamics, iterations);
  if (analyticEvaluation.kind === 'failure') return analyticEvaluation;
  const plus = forwardBotcher(cxAdd(z, cx(h, 0)), dynamics, iterations);
  if (plus.kind === 'failure') return plus;
  const minus = forwardBotcher(cxSub(z, cx(h, 0)), dynamics, iterations);
  if (minus.kind === 'failure') return minus;
  const numeric = cxScale(cxSub(plus.phi, minus.phi), 1 / (2 * h));
  const relativeError = cxAbs(cxSub(analyticEvaluation.derivative, numeric)) / Math.max(cxAbs(analyticEvaluation.derivative), 1e-300);
  return { kind: 'derivative-check', analytic: analyticEvaluation.derivative, numeric, relativeError };
}
