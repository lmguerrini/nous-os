/**
 * Fractal dynamics parameters (tranche E1 of the views-extension plan).
 *
 * Derives and certifies the polynomial family F_c(z) = z^p + c used by the external-coordinate
 * fractal projection: power p from the stable top-level community count, real parameter
 * c from the domain graph density, the attracting fixed point, the bounded critical orbit,
 * the escape radius, the importance potential range G = 0.25 + 1.5 q and the display scale
 * s = 100 sqrt(n/172). Pure deterministic arithmetic; no snapshot, store or rendering access.
 */
import type { Complex, ProjectionParameters } from '../projection/contract-types.ts';

export const FRACTAL_PARAMETERS_VERSION = 'fractal-parameters-v1';
/** c = 0.05 (2d - 1) keeps |c| <= 0.05, a conservative interval for p in {2, 3}. */
export const FRACTAL_C_MAGNITUDE = 0.05;
/** G = FRACTAL_POTENTIAL_FLOOR + FRACTAL_POTENTIAL_SPAN * q with q the importance midrank. */
export const FRACTAL_POTENTIAL_FLOOR = 0.25;
export const FRACTAL_POTENTIAL_SPAN = 1.5;
export const FRACTAL_SCALE_REFERENCE_NODES = 172;
export const FRACTAL_SCALE_REFERENCE_FACTOR = 100;

/** Declared truncation target for the finite Böttcher series; drives default ray iterations. */
export const FRACTAL_RAY_SERIES_TAIL_TARGET = 1e-12;
const MAX_RAY_ITERATIONS = 24;
const CRITICAL_ORBIT_ITERATIONS = 64;
const CRITICAL_ORBIT_CONVERGENCE = 1e-12;
const FIXED_POINT_RESIDUAL_TOLERANCE = 1e-12;
const ROOT_NEWTON_ITERATIONS = 100;
const ROOT_NEWTON_TOLERANCE = 1e-15;

export type FractalPower = 2 | 3;

/** Minimal dynamics descriptor consumed by the Böttcher evaluation and the inverse rays. */
export interface FractalDynamics {
  readonly power: FractalPower;
  readonly c: number;
}

/** Stable graph features that select the dynamics. All counts are integers. */
export interface FractalFeatureInput {
  /** Stable top-level community count (or the declared derived partition count for the legacy slice). */
  readonly communityCount: number;
  /** Domain node count n. */
  readonly domainNodeCount: number;
  /** Original attested edge count m_a induced on the domain. */
  readonly attestedEdgeCount: number;
}

export interface CertifiedFractalDynamics extends FractalDynamics {
  readonly certified: true;
  readonly version: typeof FRACTAL_PARAMETERS_VERSION;
  readonly density: number;
  /** Attracting fixed point z* of F_c with |p z*^(p-1)| < 1. */
  readonly fixedPoint: Complex;
  readonly multiplier: number;
  readonly fixedPointResidual: number;
  /** r > 1 with r^p - r >= |c|: orbits above r escape monotonically in modulus. */
  readonly escapeRadius: number;
  /** |F_c^k(0)| for k = 0..K; the critical orbit stays bounded and converges to z*. */
  readonly criticalOrbit: readonly number[];
  /** Signed terminal value F_c^K(0) of the bounded critical orbit. */
  readonly criticalOrbitTerminal: number;
  readonly criticalOrbitSupremum: number;
  readonly criticalOrbitConvergence: number;
}

export type FractalDynamicsCertification =
  | CertifiedFractalDynamics
  | Readonly<{
      readonly certified: false;
      readonly code: 'invalid-features' | 'uncertified-fixed-point' | 'unbounded-critical-orbit';
      readonly detail: string;
    }>;

/** p = 2 + (communityCount mod 2), so an even count gives p = 2 and an odd count p = 3. */
export function deriveFractalPower(communityCount: number): FractalPower {
  return communityCount % 2 === 0 ? 2 : 3;
}

/** d = 0 for n < 2, otherwise d = min(1, 2 m_a / (n (n - 1))). */
export function deriveDensity(domainNodeCount: number, attestedEdgeCount: number): number {
  if (domainNodeCount < 2) return 0;
  return Math.min(1, (2 * attestedEdgeCount) / (domainNodeCount * (domainNodeCount - 1)));
}

/** c = 0.05 (2d - 1), always real. */
export function deriveC(density: number): number {
  return FRACTAL_C_MAGNITUDE * (2 * density - 1);
}

function polynomialRoot(power: FractalPower, c: number): number | null {
  // Solve z^p - z + c = 0 for the small (attracting) real root by damped Newton.
  if (power === 2) {
    const s = Math.sqrt(1 - 4 * c);
    const candidates = [(1 - s) / 2, (1 + s) / 2];
    let best: number | null = null;
    let bestMultiplier = Infinity;
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate)) continue;
      const multiplier = Math.abs(2 * candidate);
      if (multiplier < bestMultiplier) {
        bestMultiplier = multiplier;
        best = candidate;
      }
    }
    return best;
  }
  let z = c;
  for (let i = 0; i < ROOT_NEWTON_ITERATIONS; i += 1) {
    const h = z * z * z - z + c;
    const hPrime = 3 * z * z - 1;
    if (Math.abs(hPrime) < 1e-300) return null;
    const next = z - h / hPrime;
    if (!Number.isFinite(next)) return null;
    const delta = Math.abs(next - z);
    z = next;
    if (delta <= ROOT_NEWTON_TOLERANCE * Math.max(1, Math.abs(z))) break;
  }
  return Number.isFinite(z) ? z : null;
}

/** Attracting fixed point of F_c(z) = z^p + c with its multiplier |p z*^(p-1)|, or null when uncertified. */
export function attractingFixedPoint(
  power: FractalPower,
  c: number,
): Readonly<{ fixedPoint: number; multiplier: number; residual: number }> | null {
  const root = polynomialRoot(power, c);
  if (root === null) return null;
  const residual = Math.abs(Math.pow(root, power) + c - root);
  if (!Number.isFinite(residual) || residual > FIXED_POINT_RESIDUAL_TOLERANCE) return null;
  const multiplier = Math.abs(power * Math.pow(root, power - 1));
  if (!Number.isFinite(multiplier) || multiplier >= 1) return null;
  return { fixedPoint: root, multiplier, residual };
}

/** Positive root of r^p - r - |c| = 0: the deterministic escape-radius witness. */
export function escapeRadiusFor(power: FractalPower, cMagnitude: number): number {
  if (cMagnitude === 0) return 1;
  let r = 1 + Math.pow(cMagnitude, 1 / power);
  for (let i = 0; i < ROOT_NEWTON_ITERATIONS; i += 1) {
    const h = Math.pow(r, power) - r - cMagnitude;
    const hPrime = power * Math.pow(r, power - 1) - 1;
    const next = r - h / hPrime;
    if (!Number.isFinite(next)) break;
    const delta = Math.abs(next - r);
    r = next;
    if (delta <= ROOT_NEWTON_TOLERANCE) break;
  }
  return r;
}

/** Orbit of the critical point 0: signed F_c^k(0) for k = 0..iterations plus the magnitude supremum. */
export function criticalOrbit(
  power: FractalPower,
  c: number,
  iterations: number,
): Readonly<{ values: number[]; magnitudes: number[]; supremum: number; nonfinite: boolean }> {
  const values: number[] = [];
  const magnitudes: number[] = [];
  let z = 0;
  let supremum = 0;
  let nonfinite = false;
  for (let k = 0; k <= iterations; k += 1) {
    values.push(z);
    magnitudes.push(Math.abs(z));
    if (!Number.isFinite(z)) {
      nonfinite = true;
      break;
    }
    supremum = Math.max(supremum, Math.abs(z));
    z = Math.pow(z, power) + c;
  }
  return { values, magnitudes, supremum, nonfinite };
}

/** Certify the dynamics before any Böttcher claim. */
export function certifyFractalDynamics(features: FractalFeatureInput): FractalDynamicsCertification {
  const { communityCount, domainNodeCount, attestedEdgeCount } = features;
  const integer = (value: number) => Number.isInteger(value);
  if (
    !Number.isFinite(communityCount) || !Number.isFinite(domainNodeCount) || !Number.isFinite(attestedEdgeCount) ||
    !integer(communityCount) || !integer(domainNodeCount) || !integer(attestedEdgeCount) ||
    communityCount < 1 || domainNodeCount < 1 || attestedEdgeCount < 0
  ) {
    return {
      certified: false,
      code: 'invalid-features',
      detail: `communityCount=${communityCount}, domainNodeCount=${domainNodeCount}, attestedEdgeCount=${attestedEdgeCount}`,
    };
  }
  const power = deriveFractalPower(communityCount);
  const density = deriveDensity(domainNodeCount, attestedEdgeCount);
  const c = deriveC(density);
  if (!Number.isFinite(c)) {
    return { certified: false, code: 'invalid-features', detail: `nonfinite c from density ${density}` };
  }
  const fixed = attractingFixedPoint(power, c);
  if (fixed === null) {
    return {
      certified: false,
      code: 'uncertified-fixed-point',
      detail: `no attracting fixed point certified for p=${power}, c=${c}`,
    };
  }
  const escapeRadius = escapeRadiusFor(power, Math.abs(c));
  const orbit = criticalOrbit(power, c, CRITICAL_ORBIT_ITERATIONS);
  if (orbit.nonfinite || orbit.supremum > escapeRadius) {
    return {
      certified: false,
      code: 'unbounded-critical-orbit',
      detail: `critical orbit supremum ${orbit.supremum} exceeds escape radius ${escapeRadius}`,
    };
  }
  const last = orbit.values.length > 0 ? orbit.values[orbit.values.length - 1] as number : 0;
  const convergence = Math.abs(last - fixed.fixedPoint);
  if (!(convergence <= CRITICAL_ORBIT_CONVERGENCE)) {
    return {
      certified: false,
      code: 'unbounded-critical-orbit',
      detail: `critical orbit did not converge to the fixed point (|z_K - z*| = ${convergence})`,
    };
  }
  return {
    certified: true,
    version: FRACTAL_PARAMETERS_VERSION,
    power,
    c,
    density,
    fixedPoint: { re: fixed.fixedPoint, im: 0 },
    multiplier: fixed.multiplier,
    fixedPointResidual: fixed.residual,
    escapeRadius,
    criticalOrbit: orbit.magnitudes,
    criticalOrbitTerminal: last,
    criticalOrbitSupremum: orbit.supremum,
    criticalOrbitConvergence: convergence,
  };
}

/** Importance midrank q = (rank + 1/2) / n, ties ordered by codepoint ID upstream. */
export function importanceMidrank(rank: number, domainNodeCount: number): number {
  return (rank + 0.5) / domainNodeCount;
}

/** G = 0.25 + 1.5 q: the external potential assigned to an importance midrank. */
export function potentialForRank(rank: number, domainNodeCount: number): number {
  return FRACTAL_POTENTIAL_FLOOR + FRACTAL_POTENTIAL_SPAN * importanceMidrank(rank, domainNodeCount);
}

/** Exact potential range covered by the midrank rule for n domain nodes. */
export function potentialRangeForCount(domainNodeCount: number): readonly [number, number] {
  const n = Math.max(1, domainNodeCount);
  return [
    FRACTAL_POTENTIAL_FLOOR + FRACTAL_POTENTIAL_SPAN * (0.5 / n),
    FRACTAL_POTENTIAL_FLOOR + FRACTAL_POTENTIAL_SPAN * ((n - 0.5) / n),
  ];
}

/** Display scale s = 100 sqrt(max(n, 1) / 172). */
export function displayScaleForCount(domainNodeCount: number): number {
  return FRACTAL_SCALE_REFERENCE_FACTOR * Math.sqrt(Math.max(domainNodeCount, 1) / FRACTAL_SCALE_REFERENCE_NODES);
}

/**
 * Deterministic bound on the relative truncation error of the finite Böttcher series with N
 * forward iterates, for exterior points whose modulus is at least r0. The omitted tail is
 * sum_{k>=N} p^{-k-1} Log(1 + c/z_k^p), so the orbit is advanced N conservative steps
 * (r_{k+1} >= r_k^p - |c|) before accumulating |log(1 + x)| <= 2|x| for |x| <= 1/2.
 */
export function seriesTailBound(power: FractalPower, c: number, r0: number, iterations: number): number {
  if (c === 0) return 0;
  if (!Number.isFinite(r0) || !(r0 > 0)) return Infinity;
  const cMagnitude = Math.abs(c);
  let r = r0;
  for (let k = 0; k < iterations; k += 1) {
    if (!(r > Math.pow(cMagnitude, 1 / power))) return Infinity;
    r = Math.pow(r, power) - cMagnitude;
    if (!Number.isFinite(r) || !(r > 0)) return Infinity;
  }
  let coefficient = Math.pow(power, -(iterations + 1));
  let bound = 0;
  for (let term = 0; term < 64; term += 1) {
    const magnitude = cMagnitude / Math.pow(r, power);
    if (!Number.isFinite(magnitude)) break;
    if (magnitude > 0.5) return Infinity;
    bound += coefficient * 2 * magnitude;
    coefficient /= power;
    r = Math.pow(r, power) - cMagnitude;
    if (!Number.isFinite(r) || !(r > 0)) break;
    if (coefficient * 2 * (cMagnitude / Math.pow(r, power)) < 1e-30) break;
  }
  return bound;
}

/**
 * Smallest N in [1, 24] whose conservative tail bound at the minimum potential clears the
 * declared 1e-12 target; the maximum is returned when no N clears it. c = 0 is exact at N = 1.
 */
export function defaultRayIterations(power: FractalPower, c: number, minPotential: number): number {
  if (c === 0) return 1;
  // |z| >= 0.9 e^G for |c| <= 0.05 (the log-product modulus correction is below 0.06 there).
  const r0 = 0.9 * Math.exp(minPotential);
  for (let n = 1; n <= MAX_RAY_ITERATIONS; n += 1) {
    if (seriesTailBound(power, c, r0, n) <= FRACTAL_RAY_SERIES_TAIL_TARGET) return n;
  }
  return MAX_RAY_ITERATIONS;
}

export type FractalContractParameters = Omit<ProjectionParameters['fractal'], 'dimension'>;

/** Assemble the contract parameter fragment for the fractal projection from certified dynamics. */
export function fractalContractParameters(
  dynamics: CertifiedFractalDynamics,
  domainNodeCount: number,
  residualTolerance = 1e-6,
): FractalContractParameters {
  const potentialRange = potentialRangeForCount(domainNodeCount);
  return {
    power: dynamics.power,
    rayIterations: defaultRayIterations(dynamics.power, dynamics.c, potentialRange[0]),
    potentialRange,
    scale: displayScaleForCount(domainNodeCount),
    residualTolerance,
    sectorPolicyVersion: 'sector-locality-v2',
  };
}
