/** D-073 tranche F, row F5 — stable graph signals and the graph Fourier transform.
 *
 * For a real signal x over the domain nodes and the symmetric Laplacian L = U Lambda U^T
 * built in holographic/adjacency.ts, the graph Fourier coefficients are x_hat = U^T x and
 * the reconstruction from a mode subset is x* = U_sel x_hat_sel. With a complete orthonormal
 * basis Parseval holds exactly, ||x||_2^2 = sum_j x_hat_j^2; with a partial basis the
 * retained energy is a Bessel prefix and rises monotonically with the mode count.
 *
 * The first measured scalar signal is the source importance feature; it is a graph feature
 * with recorded provenance, never knowledge inferred from topology. Pure module; every
 * routine is deterministic. */

import { digestPayload } from '../engine/digest.ts';
import type { Digest, NodeId } from '../projection/contract-types.ts';
import { DENSE_SYMMETRIC_SOLVER_VERSION, type DenseEigenSolution } from './dense.ts';
import type { LanczosConverged } from './lanczos.ts';

export const HOLOGRAPHIC_SIGNALS_VERSION = 'holographic-signals-v1';
export const SIGNAL_WEIGHT_POLICY = 'unit-orthonormal-basis-v1';
/** Values entering a signal digest are quantised to this grid (canonical JSON is integral). */
export const SIGNAL_DIGEST_QUANTIZATION = 1e-9;
/** Guard keeping quantised digest values inside the safe-integer range. */
export const SIGNAL_MAX_ABS_VALUE = 1e6;

function fail(message: string): never {
  throw new Error(`holographic-signals: ${message}`);
}

/** Retained eigenpairs of L in the domain's sorted node order. `eigenvectors` is column-major
 * n x count with column j the unit eigenvector of the ascending `eigenvalues[j]`. */
export interface Eigenbasis {
  readonly algorithmVersion: string;
  readonly n: number;
  readonly count: number;
  readonly eigenvalues: Float64Array;
  readonly eigenvectors: Float64Array;
  /** True exactly when count === n, the case in which Parseval is an identity. */
  readonly complete: boolean;
}

export function eigenbasisFromLanczos(outcome: LanczosConverged): Eigenbasis {
  const count = outcome.eigenvalues.length;
  const n = count === 0 ? outcome.componentCount : outcome.eigenvectors.length / count;
  if (outcome.eigenvectors.length !== n * count) {
    fail('internal inconsistency between returned eigenvalues and eigenvectors');
  }
  return {
    algorithmVersion: outcome.algorithmVersion,
    n,
    count,
    eigenvalues: outcome.eigenvalues,
    eigenvectors: outcome.eigenvectors,
    complete: count === n,
  };
}

export function eigenbasisFromDense(solution: DenseEigenSolution): Eigenbasis {
  return {
    algorithmVersion: DENSE_SYMMETRIC_SOLVER_VERSION,
    n: solution.n,
    count: solution.n,
    eigenvalues: solution.eigenvalues,
    eigenvectors: solution.eigenvectors,
    complete: solution.n > 0,
  };
}

export interface SignalProvenance {
  readonly signalId: string;
  /** 'feature': measured source feature; 'synthetic': declared test/derived signal. */
  readonly source: 'feature' | 'synthetic';
  readonly featureKey: string | null;
  readonly nodeCount: number;
  readonly digest: Digest;
  readonly policy: string;
  readonly digestQuantization: number;
}

/** A real scalar signal over the domain's sorted node order. */
export interface GraphSignal {
  readonly algorithmVersion: string;
  readonly signalId: string;
  readonly values: Float64Array;
  readonly provenance: SignalProvenance;
}

function quantizeForDigest(values: Float64Array): number[] {
  const scaled: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) fail('nonfinite signal values cannot be digested');
    if (Math.abs(value) > SIGNAL_MAX_ABS_VALUE) {
      fail(`signal value ${String(value)} exceeds the digest guard ${String(SIGNAL_MAX_ABS_VALUE)}`);
    }
    scaled.push(Math.round(value / SIGNAL_DIGEST_QUANTIZATION));
  }
  return scaled;
}

function buildSignal(
  nodeIds: readonly NodeId[],
  values: Float64Array,
  signalId: string,
  source: 'feature' | 'synthetic',
  featureKey: string | null,
): GraphSignal {
  if (typeof signalId !== 'string' || signalId.length === 0) fail('signalId must be a nonempty string');
  if (values.length !== nodeIds.length) {
    fail(`signal length ${String(values.length)} does not match the ${String(nodeIds.length)} domain nodes`);
  }
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('signal values must all be finite numbers');
  }
  const digest = digestPayload([
    HOLOGRAPHIC_SIGNALS_VERSION,
    'signal-v1',
    signalId,
    source,
    featureKey,
    nodeIds,
    quantizeForDigest(values),
  ]);
  return {
    algorithmVersion: HOLOGRAPHIC_SIGNALS_VERSION,
    signalId,
    values,
    provenance: {
      signalId,
      source,
      featureKey,
      nodeCount: nodeIds.length,
      digest,
      policy: 'finite-required-v1',
      digestQuantization: SIGNAL_DIGEST_QUANTIZATION,
    },
  };
}

/** First measured scalar signal: a source feature (importance) read for every
 * domain node. Missing, nonfinite or oversized values refuse; nothing is imputed. */
export function featureSignal(
  nodeIds: readonly NodeId[],
  features: Readonly<Record<NodeId, number>>,
  options: Readonly<{ signalId: string; featureKey: string }>,
): GraphSignal {
  if (typeof options.featureKey !== 'string' || options.featureKey.length === 0) {
    fail('featureKey must be a nonempty string');
  }
  const values = new Float64Array(nodeIds.length);
  for (const [index, id] of nodeIds.entries()) {
    const value = features[id];
    if (value === undefined) fail(`node ${id} has no measured value for feature ${options.featureKey}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`node ${id} has a nonfinite value for feature ${options.featureKey}`);
    }
    values[index] = value;
  }
  return buildSignal(nodeIds, values, options.signalId, 'feature', options.featureKey);
}

/** Declared synthetic signal (known-answer fixtures, derived analytic fields). Same finite
 * validation and provenance discipline; never presented as a measured feature. */
export function syntheticSignal(nodeIds: readonly NodeId[], values: Float64Array, signalId: string): GraphSignal {
  return buildSignal(nodeIds, values, signalId, 'synthetic', null);
}

/** x_hat = U^T x over every retained mode. */
export function fourierCoefficients(basis: Eigenbasis, signal: GraphSignal): Float64Array {
  if (signal.values.length !== basis.n) {
    fail(`signal length ${String(signal.values.length)} does not match the basis dimension ${String(basis.n)}`);
  }
  const coefficients = new Float64Array(basis.count);
  const x = signal.values;
  for (let mode = 0; mode < basis.count; mode += 1) {
    let sum = 0;
    const base = mode * basis.n;
    for (let index = 0; index < basis.n; index += 1) sum += basis.eigenvectors[base + index]! * x[index]!;
    coefficients[mode] = sum;
  }
  return coefficients;
}

/** x* = sum_{j < modeCount} x_hat_j u_j. */
export function reconstructSignal(basis: Eigenbasis, coefficients: Float64Array, modeCount = coefficients.length): Float64Array {
  if (coefficients.length > basis.count) {
    fail(`${String(coefficients.length)} coefficients exceed the ${String(basis.count)} retained modes`);
  }
  if (!Number.isInteger(modeCount) || modeCount < 0 || modeCount > coefficients.length) {
    fail(`modeCount ${String(modeCount)} must be between 0 and ${String(coefficients.length)}`);
  }
  const reconstructed = new Float64Array(basis.n);
  for (let mode = 0; mode < modeCount; mode += 1) {
    const coefficient = coefficients[mode]!;
    if (coefficient === 0) continue;
    const base = mode * basis.n;
    for (let index = 0; index < basis.n; index += 1) {
      reconstructed[index] = reconstructed[index]! + coefficient * basis.eigenvectors[base + index]!;
    }
  }
  return reconstructed;
}

/** Heat-diffused source-community indicator restricted to the chosen stable band.
 * This is a graph-derived structural probe, never a measured node attribute. */
export function bandlimitedCommunityIndicator(
  basis: Eigenbasis, memberIndices: readonly number[], bandlimit: number, time = 1,
): Float64Array {
  if (!Number.isInteger(bandlimit) || bandlimit < 1 || bandlimit > basis.count || !Number.isFinite(time) || time < 0)
    fail('invalid community indicator band or heat time');
  const members = new Set(memberIndices);
  if (members.size !== memberIndices.length || [...members].some(index => !Number.isInteger(index) || index < 0 || index >= basis.n))
    fail('invalid community indicator members');
  const coefficients = new Float64Array(bandlimit);
  for (let mode = 0; mode < bandlimit; mode += 1) {
    let coefficient = 0;
    for (const index of members) coefficient += basis.eigenvectors[mode * basis.n + index]!;
    coefficients[mode] = coefficient * Math.exp(-time * basis.eigenvalues[mode]!);
  }
  return reconstructSignal(basis, coefficients);
}

export function signalEnergy(x: Float64Array): number {
  let sum = 0;
  for (const value of x) sum += value * value;
  return sum;
}

/** ||x||_2^2 - sum_j x_hat_j^2. Exactly 0 (up to roundoff) for a complete basis (Parseval);
 * nonnegative for a partial basis (Bessel), equality when x lies in the retained span. */
export function parsevalDefect(basis: Eigenbasis, signal: GraphSignal, coefficients: Float64Array): number {
  if (coefficients.length !== basis.count) {
    fail(`expected ${String(basis.count)} coefficients, got ${String(coefficients.length)}`);
  }
  return signalEnergy(signal.values) - signalEnergy(coefficients);
}

/** sum_{j < modeCount} x_hat_j^2; monotone nondecreasing in modeCount. */
export function retainedEnergy(coefficients: Float64Array, modeCount: number): number {
  if (!Number.isInteger(modeCount) || modeCount < 0 || modeCount > coefficients.length) {
    fail(`modeCount ${String(modeCount)} must be between 0 and ${String(coefficients.length)}`);
  }
  let sum = 0;
  for (let mode = 0; mode < modeCount; mode += 1) sum += coefficients[mode]! * coefficients[mode]!;
  return sum;
}

/** Orthogonal projection U U^T x of the signal onto the retained span. */
export function projectOntoBasis(basis: Eigenbasis, signal: GraphSignal): Float64Array {
  return reconstructSignal(basis, fourierCoefficients(basis, signal));
}

/** ||x - U_k U_k^T x||_2 / max(||x||_2, 1e-12): how far x is from k-bandlimited. */
export function bandlimitedResidual(basis: Eigenbasis, signal: GraphSignal, modeCount: number): number {
  const projection = reconstructSignal(basis, fourierCoefficients(basis, signal), modeCount);
  let sum = 0;
  for (const [index, value] of signal.values.entries()) {
    const delta = value - projection[index]!;
    sum += delta * delta;
  }
  return Math.sqrt(sum) / Math.max(Math.sqrt(signalEnergy(signal.values)), 1e-12);
}
