/** D-073 tranche F, row F7 — rank-checked band-limited recovery, the measurable
 * part-to-whole claim of the Holographic view.
 *
 * For a band limit k the model basis is U_k, the first k orthonormal modes of
 * the projection's symmetric degree-normalised Laplacian N (zero cluster first).
 * Given samples x_S on a region S, solve
 *   a* = argmin_a || P_S U_k a - x_S ||_2^2 + lambda ||a||_2^2,   x* = U_k a*,
 * through the normal equations (Gram + lambda I) a = U_k^T P_S^T x_S, diagonalised by the
 * dense reference eigensolver. The sampled matrix P_S U_k is rank-checked through its
 * singular values (square roots of the Gram eigenvalues): when the rank is below k the
 * recovery REFUSES with the measured rank, singular values and condition number — a
 * one-endpoint sample of the three-node path is the required refusal fixture. Every
 * accepted result carries an explicit held-out error ||P_Sbar (x - x*)||_2 over the
 * unsampled complement, plus the same error for a global-mean and a local-neighbour
 * interpolation baseline. "Exact recovery" is claimed only for a truly k-band-limited
 * signal (measured projection residual) with full column rank and lambda = 0, with the
 * held-out residual witnessed at the full signal scale (the reported relative error keeps
 * the epsilon-floored formula, which a numerically zero held-out truth would
 * otherwise distort); importance is generally not band-limited and is never silently upgraded.
 * The projection selects the largest prefix with full numerical rank and sample condition
 * at most 30, before looking at held-out values. */

import type { SpectralGraph } from './adjacency.ts';
import { DENSE_DEFAULT_MAX_N, solveDenseSymmetricEigen } from './dense.ts';
import type { Eigenbasis, GraphSignal } from './signals.ts';

export const HOLOGRAPHIC_RECOVERY_VERSION = 'holographic-recovery-v2';
export const RECOVERY_BASELINE_GLOBAL_MEAN = 'global-mean-v1';
export const RECOVERY_BASELINE_LOCAL_NEIGHBOUR = 'local-neighbour-weighted-fallback-mean-v1';
export const RECOVERY_DEFAULT_RANK_TOLERANCE = 1e-10;
export const RECOVERY_DEFAULT_CLAIM_TOLERANCE = 1e-8;
export const RECOVERY_ENERGY_FLOOR = 1e-12;
/** Fixed before looking at signal values or held-out errors. The cap limits amplification
 * of sample noise and floating-point error in the local inverse problem. */
export const RECOVERY_MAX_SAMPLE_CONDITION = 30;

export type RecoveryClaim = 'exact-bandlimited-recovery' | 'least-squares-estimate' | 'ridge-estimate';

export interface RecoveryOptions {
  /** Band limit k: the first k modes of the basis (zero cluster included). Capped at the
   * dense Gram ceiling DENSE_DEFAULT_MAX_N: the k x k normal-equation Gram matrix is
   * diagonalised by the dense reference eigensolver. */
  readonly bandlimit: number;
  /** Ridge lambda >= 0; 0 by default. */
  readonly ridge?: number;
  /** Relative singular-value threshold defining numerical rank. Default 1e-10. */
  readonly rankTolerance?: number;
  /** Tolerance for the exact-recovery claim. Default 1e-8. */
  readonly claimTolerance?: number;
}

export interface HeldOutMetrics {
  readonly indices: readonly number[];
  /** ||P_Sbar (x - x*)||_2 / max(||P_Sbar x||_2, 1e-12); null when nothing is held out. */
  readonly relativeError: number | null;
  readonly mae: number | null;
  /** ||P_Sbar (x - x*)||_2 itself; the exactness witness scales it by the signal norm so a
   * numerically zero held-out truth (the P3 middle node) cannot fake a failure or a pass. */
  readonly residualNorm: number | null;
}

export interface BaselineMetrics {
  readonly kind: 'global-mean' | 'local-neighbour';
  readonly policy: string;
  readonly heldOutRelativeError: number | null;
  readonly heldOutMae: number | null;
  /** baseline error / recovery error; null when either side is null or the recovery error
   * is at the floor (then the improvement is reported via exactness instead). */
  readonly improvementFactor: number | null;
}

export interface RecoveryResult {
  readonly kind: 'recovered';
  readonly algorithmVersion: string;
  readonly claim: RecoveryClaim;
  readonly exact: boolean;
  readonly bandlimit: number;
  readonly ridge: number;
  readonly sampleCount: number;
  readonly sampleIndices: readonly number[];
  /** a* in the retained-mode coordinate system. */
  readonly coefficients: Float64Array;
  /** x* = U_k a* over all domain nodes. */
  readonly reconstructed: Float64Array;
  readonly rank: number;
  /** Ascending singular values of P_S U_k. */
  readonly singularValues: Float64Array;
  /** sigma_max / sigma_min over the above-threshold singular values; null when rank <= 1. */
  readonly conditionNumber: number | null;
  /** ||P_S U_k a* - x_S||_2 / max(||x_S||_2, 1e-12). */
  readonly sampleRelativeResidual: number;
  /** ||x - U_k U_k^T x||_2 / max(||x||_2, 1e-12): distance from k-band-limited. */
  readonly bandlimitedRelativeResidual: number;
  readonly heldOut: HeldOutMetrics;
  readonly globalMeanBaseline: BaselineMetrics;
  readonly localNeighbourBaseline: BaselineMetrics;
}

export interface RecoveryRefusal {
  readonly kind: 'refusal';
  readonly algorithmVersion: string;
  readonly code: 'rank-deficient';
  readonly message: string;
  readonly bandlimit: number;
  readonly ridge: number;
  readonly sampleCount: number;
  readonly rank: number;
  readonly singularValues: Float64Array;
  readonly conditionNumber: number | null;
}

export type RecoveryOutcome = RecoveryResult | RecoveryRefusal;

/** A shared sampling inverse for several structural signals. The band is selected separately
 * from P_S U_k; target values are read only after that choice. One Gram eigensolve serves
 * every coordinate and community signal, without another graph eigensolve. */
export interface StructuralTargetError {
  readonly id: string;
  readonly heldOutRelativeError: number | null;
  readonly heldOutResidualNorm: number | null;
  readonly signalNorm: number;
  readonly bandlimitedRelativeResidual: number;
}

export interface StructuralRecovery {
  readonly bandlimit: number;
  readonly rank: number;
  readonly conditionNumber: number | null;
  readonly status: 'recovered' | 'rank-deficient';
  readonly targets: readonly StructuralTargetError[];
}

export function recoverStructuralSignals(
  basis: Eigenbasis,
  sampleIndices: readonly number[],
  bandlimit: number,
  targets: readonly Readonly<{ id: string; values: Float64Array }>[],
  ridge = 0,
): StructuralRecovery {
  const { n } = basis;
  const k = bandlimit;
  if (!Number.isInteger(k) || k < 1 || k > basis.count || k > DENSE_DEFAULT_MAX_N)
    fail('invalid structural bandlimit');
  if (!Number.isFinite(ridge) || ridge < 0) fail('invalid structural ridge');
  const samples = [...sampleIndices].sort((a, b) => a - b);
  if (samples.length === 0 || samples.some((s, i) => !Number.isInteger(s) || s < 0 || s >= n || (i > 0 && s === samples[i - 1])))
    fail('invalid structural sample set');
  const gram = new Float64Array(k * k);
  for (let j = 0; j < k; j += 1) for (let i = j; i < k; i += 1) {
    let sum = 0;
    for (const s of samples) sum += basis.eigenvectors[j * n + s]! * basis.eigenvectors[i * n + s]!;
    gram[i + j * k] = sum;
    gram[j + i * k] = sum;
  }
  const decomposition = solveDenseSymmetricEigen({ n: k, values: gram });
  const sigmaMax = Math.sqrt(Math.max(0, decomposition.eigenvalues[k - 1]!));
  const threshold = sigmaMax * RECOVERY_DEFAULT_RANK_TOLERANCE;
  let rank = 0;
  let sigmaMin = Number.POSITIVE_INFINITY;
  for (const eigenvalue of decomposition.eigenvalues) {
    const sigma = Math.sqrt(Math.max(0, eigenvalue));
    if (sigma > threshold) { rank += 1; sigmaMin = Math.min(sigmaMin, sigma); }
  }
  const conditionNumber = rank > 0 ? sigmaMax / sigmaMin : null;
  if (rank < k) return { bandlimit: k, rank, conditionNumber, status: 'rank-deficient', targets: [] };
  const measured: StructuralTargetError[] = [];
  const mask = new Uint8Array(n);
  for (const s of samples) mask[s] = 1;
  for (const target of targets) {
    const values = target.values;
    if (values.length !== n || values.some(value => !Number.isFinite(value))) fail('invalid structural target');
    const rhs = new Float64Array(k);
    const fullCoefficients = new Float64Array(k);
    let fullEnergy = 0;
    for (let node = 0; node < n; node += 1) fullEnergy += values[node]! ** 2;
    for (let mode = 0; mode < k; mode += 1) {
      const offset = mode * n;
      for (const s of samples) rhs[mode] = rhs[mode]! + basis.eigenvectors[offset + s]! * values[s]!;
      for (let node = 0; node < n; node += 1) fullCoefficients[mode] = fullCoefficients[mode]! + basis.eigenvectors[offset + node]! * values[node]!;
    }
    const coefficients = new Float64Array(k);
    for (let mode = 0; mode < k; mode += 1) {
      let projected = 0;
      for (let j = 0; j < k; j += 1) projected += decomposition.eigenvectors[j + mode * k]! * rhs[j]!;
      const weight = projected / (decomposition.eigenvalues[mode]! + ridge);
      for (let j = 0; j < k; j += 1) coefficients[j] = coefficients[j]! + weight * decomposition.eigenvectors[j + mode * k]!;
    }
    let heldError = 0;
    let heldEnergy = 0;
    let bandError = 0;
    for (let node = 0; node < n; node += 1) {
      let reconstructed = 0;
      let projected = 0;
      for (let mode = 0; mode < k; mode += 1) {
        const u = basis.eigenvectors[mode * n + node]!;
        reconstructed += u * coefficients[mode]!;
        projected += u * fullCoefficients[mode]!;
      }
      bandError += (values[node]! - projected) ** 2;
      if (!mask[node]) {
        heldError += (values[node]! - reconstructed) ** 2;
        heldEnergy += values[node]! ** 2;
      }
    }
    measured.push({ id: target.id,
      heldOutRelativeError: samples.length === n ? null : Math.sqrt(heldError) / Math.max(Math.sqrt(heldEnergy), RECOVERY_ENERGY_FLOOR),
      heldOutResidualNorm: samples.length === n ? null : Math.sqrt(heldError),
      signalNorm: Math.sqrt(fullEnergy),
      bandlimitedRelativeResidual: Math.sqrt(bandError) / Math.max(Math.sqrt(fullEnergy), RECOVERY_ENERGY_FLOOR) });
  }
  return { bandlimit: k, rank, conditionNumber, status: 'recovered', targets: measured };
}

/** Choose the largest stable prefix of low modes using sampled geometry alone. Since adding
 * a column cannot increase the smallest singular value or decrease the largest one, the
 * first rank or condition failure ends the search. A failed first mode remains a refusal.
 * No held-out value participates in model selection. */
export function recoverStableBandlimit(
  graph: SpectralGraph,
  basis: Eigenbasis,
  signal: GraphSignal | Float64Array,
  sampleIndices: readonly number[],
  options: Readonly<{ maxBandlimit: number; ridge?: number; maxCondition?: number }>,
): RecoveryOutcome {
  const cap = Math.min(options.maxBandlimit, basis.count, sampleIndices.length, DENSE_DEFAULT_MAX_N);
  if (!Number.isInteger(options.maxBandlimit) || cap < 1) fail('maxBandlimit must allow at least one sampled mode');
  const maxCondition = options.maxCondition ?? RECOVERY_MAX_SAMPLE_CONDITION;
  if (!Number.isFinite(maxCondition) || maxCondition < 1) fail('maxCondition must be finite and at least one');
  let acceptedBandlimit = 0;
  let firstFailedBandlimit = 0;
  // The probe has no signal values. Only its rank and singular-value condition are used;
  // the measured signal and its complement are read once, after k is fixed.
  const samplingProbe = new Float64Array(graph.size);
  for (let k = 1; k <= cap; k += 1) {
    const outcome = recoverBandlimitedSignal(graph, basis, samplingProbe, sampleIndices,
      { bandlimit: k, ...(options.ridge === undefined ? {} : { ridge: options.ridge }) });
    if (outcome.kind === 'refusal') { firstFailedBandlimit = k; break; }
    if (outcome.conditionNumber !== null && outcome.conditionNumber > maxCondition) break;
    acceptedBandlimit = k;
  }
  return recoverBandlimitedSignal(graph, basis, signal, sampleIndices,
    { bandlimit: acceptedBandlimit || firstFailedBandlimit || 1,
      ...(options.ridge === undefined ? {} : { ridge: options.ridge }) });
}

function fail(message: string): never {
  throw new Error(`holographic-recovery: ${message}`);
}

function norm(x: Float64Array): number {
  let sum = 0;
  for (const value of x) sum += value * value;
  return Math.sqrt(sum);
}

export function recoverBandlimitedSignal(
  graph: SpectralGraph,
  basis: Eigenbasis,
  signal: GraphSignal | Float64Array,
  sampleIndices: readonly number[],
  options: RecoveryOptions,
): RecoveryOutcome {
  const n = graph.size;
  if (basis.n !== n) fail(`basis dimension ${String(basis.n)} does not match the ${String(n)}-node domain`);
  const values = signal instanceof Float64Array ? signal : signal.values;
  if (values.length !== n) fail(`signal length ${String(values.length)} does not match the ${String(n)}-node domain`);
  for (const value of values) {
    if (!Number.isFinite(value)) fail('recovery refuses nonfinite signal values');
  }
  const k = options.bandlimit;
  if (!Number.isInteger(k) || k < 1 || k > basis.count) {
    fail(`bandlimit ${String(k)} must be an integer between 1 and ${String(basis.count)}`);
  }
  if (k > DENSE_DEFAULT_MAX_N) {
    fail(
      `bandlimit ${String(k)} exceeds the dense Gram ceiling ${String(DENSE_DEFAULT_MAX_N)}; ` +
        `the ${String(k)}x${String(k)} normal-equation Gram matrix is diagonalised by the dense reference eigensolver, which refuses orders above ${String(DENSE_DEFAULT_MAX_N)}`,
    );
  }
  const ridge = options.ridge ?? 0;
  if (!(ridge >= 0) || !Number.isFinite(ridge)) fail(`ridge ${String(ridge)} must be finite and nonnegative`);
  const rankTolerance = options.rankTolerance ?? RECOVERY_DEFAULT_RANK_TOLERANCE;
  if (!(rankTolerance > 0) || !Number.isFinite(rankTolerance)) fail('rankTolerance must be positive and finite');
  const claimTolerance = options.claimTolerance ?? RECOVERY_DEFAULT_CLAIM_TOLERANCE;
  if (!(claimTolerance > 0) || !Number.isFinite(claimTolerance)) fail('claimTolerance must be positive and finite');
  if (sampleIndices.length === 0) fail('the sample region needs at least one node');

  const sampled = new Uint8Array(n);
  const samples: number[] = [];
  for (const index of sampleIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= n) {
      fail(`sample index ${String(index)} is outside the ${String(n)}-node domain`);
    }
    if (sampled[index]) fail(`sample index ${String(index)} appears twice; samples are a set`);
    sampled[index] = 1;
    samples.push(index);
  }
  samples.sort((a, b) => a - b);
  const m = samples.length;

  // Sampled model matrix M = P_S U_k (m x k) and right-hand side b = x_S.
  const gram = new Float64Array(k * k);
  const rhs = new Float64Array(k);
  const b = new Float64Array(m);
  for (let t = 0; t < m; t += 1) {
    const node = samples[t]!;
    b[t] = values[node]!;
    for (let mode = 0; mode < k; mode += 1) {
      rhs[mode] = rhs[mode]! + basis.eigenvectors[mode * n + node]! * values[node]!;
    }
  }
  for (let modeJ = 0; modeJ < k; modeJ += 1) {
    for (let modeI = modeJ; modeI < k; modeI += 1) {
      let sum = 0;
      for (let t = 0; t < m; t += 1) {
        const node = samples[t]!;
        sum += basis.eigenvectors[modeI * n + node]! * basis.eigenvectors[modeJ * n + node]!;
      }
      gram[modeI + modeJ * k] = sum;
      if (modeI !== modeJ) gram[modeJ + modeI * k] = sum;
    }
  }

  const diagonalized = solveDenseSymmetricEigen({ n: k, values: gram });
  const singularValues = new Float64Array(k);
  for (let mode = 0; mode < k; mode += 1) {
    singularValues[mode] = Math.sqrt(Math.max(0, diagonalized.eigenvalues[mode]!));
  }
  let sigmaMax = 0;
  for (const value of singularValues) sigmaMax = Math.max(sigmaMax, value);
  const threshold = sigmaMax * rankTolerance;
  let rank = 0;
  let sigmaMin = Number.POSITIVE_INFINITY;
  for (const value of singularValues) {
    if (value > threshold) {
      rank += 1;
      sigmaMin = Math.min(sigmaMin, value);
    }
  }
  const conditionNumber = rank >= 1 && Number.isFinite(sigmaMax / sigmaMin) ? sigmaMax / sigmaMin : null;

  if (rank < k) {
    return {
      kind: 'refusal',
      algorithmVersion: HOLOGRAPHIC_RECOVERY_VERSION,
      code: 'rank-deficient',
      message:
        `P_S U_k has rank ${String(rank)} < k = ${String(k)} (sigma_max = ${sigmaMax.toExponential(3)}, ` +
        `threshold ${threshold.toExponential(3)}); the samples cannot identify the ${String(k)}-mode model, ` +
        `so no recovery is claimed${ridge > 0 ? ' even under the requested ridge' : ''}`,
      bandlimit: k,
      ridge,
      sampleCount: m,
      rank,
      singularValues,
      conditionNumber,
    };
  }

  // (Gram + ridge I) a = rhs via the spectral decomposition: mu_j -> mu_j + ridge.
  const coefficients = new Float64Array(k);
  for (let mode = 0; mode < k; mode += 1) {
    const denominator = diagonalized.eigenvalues[mode]! + ridge;
    if (!(denominator > 0)) fail('the shifted Gram system is singular; this is a rank-refusal path');
    let projected = 0;
    for (let entry = 0; entry < k; entry += 1) {
      projected += diagonalized.eigenvectors[entry + mode * k]! * rhs[entry]!;
    }
    const weight = projected / denominator;
    if (weight === 0) continue;
    for (let entry = 0; entry < k; entry += 1) {
      coefficients[entry] = coefficients[entry]! + weight * diagonalized.eigenvectors[entry + mode * k]!;
    }
  }

  const reconstructed = new Float64Array(n);
  for (let mode = 0; mode < k; mode += 1) {
    const coefficient = coefficients[mode]!;
    if (coefficient === 0) continue;
    for (let node = 0; node < n; node += 1) {
      reconstructed[node] = reconstructed[node]! + coefficient * basis.eigenvectors[mode * n + node]!;
    }
  }

  let sampleResidualSum = 0;
  for (let t = 0; t < m; t += 1) {
    const node = samples[t]!;
    let prediction = 0;
    for (let mode = 0; mode < k; mode += 1) {
      prediction += basis.eigenvectors[mode * n + node]! * coefficients[mode]!;
    }
    const delta = prediction - b[t]!;
    sampleResidualSum += delta * delta;
  }
  const sampleRelativeResidual = Math.sqrt(sampleResidualSum) / Math.max(norm(b), RECOVERY_ENERGY_FLOOR);

  let inputEnergy = 0;
  let projectionResidualSum = 0;
  {
    const projection = new Float64Array(n);
    for (let mode = 0; mode < k; mode += 1) {
      let coefficient = 0;
      for (let node = 0; node < n; node += 1) coefficient += basis.eigenvectors[mode * n + node]! * values[node]!;
      for (let node = 0; node < n; node += 1) projection[node] = projection[node]! + coefficient * basis.eigenvectors[mode * n + node]!;
    }
    for (const [node, value] of values.entries()) {
      const delta = value - projection[node]!;
      projectionResidualSum += delta * delta;
    }
  }
  for (const value of values) inputEnergy += value * value;
  const bandlimitedRelativeResidual = Math.sqrt(projectionResidualSum) / Math.max(Math.sqrt(inputEnergy), RECOVERY_ENERGY_FLOOR);

  const heldIndices: number[] = [];
  for (let node = 0; node < n; node += 1) if (!sampled[node]) heldIndices.push(node);
  const heldOut = measureHeldOut(values, reconstructed, heldIndices);

  let sampleMean = 0;
  for (let t = 0; t < m; t += 1) sampleMean += b[t]!;
  sampleMean /= m;
  const meanPrediction = new Float64Array(n).fill(sampleMean);
  const globalMeanBaseline = baselineMetrics('global-mean', RECOVERY_BASELINE_GLOBAL_MEAN, values, meanPrediction, heldIndices, heldOut);

  const neighbourPrediction = new Float64Array(n).fill(sampleMean);
  for (const node of heldIndices) {
    let weightSum = 0;
    let valueSum = 0;
    for (let slot = graph.csrRowStart[node]!; slot < graph.csrRowStart[node + 1]!; slot += 1) {
      const neighbor = graph.csrNeighbor[slot]!;
      if (sampled[neighbor]) {
        const weight = graph.csrWeight[slot]!;
        weightSum += weight;
        valueSum += weight * values[neighbor]!;
      }
    }
    if (weightSum > 0) neighbourPrediction[node] = valueSum / weightSum;
  }
  const localNeighbourBaseline = baselineMetrics('local-neighbour', RECOVERY_BASELINE_LOCAL_NEIGHBOUR, values, neighbourPrediction, heldIndices, heldOut);

  const exact =
    ridge === 0 &&
    rank === k &&
    bandlimitedRelativeResidual <= claimTolerance &&
    sampleRelativeResidual <= claimTolerance &&
    (heldOut.relativeError === null ||
      heldOut.relativeError <= claimTolerance ||
      (heldOut.residualNorm !== null && heldOut.residualNorm <= claimTolerance * Math.max(Math.sqrt(inputEnergy), RECOVERY_ENERGY_FLOOR)));

  return {
    kind: 'recovered',
    algorithmVersion: HOLOGRAPHIC_RECOVERY_VERSION,
    claim: exact ? 'exact-bandlimited-recovery' : ridge > 0 ? 'ridge-estimate' : 'least-squares-estimate',
    exact,
    bandlimit: k,
    ridge,
    sampleCount: m,
    sampleIndices: samples,
    coefficients,
    reconstructed,
    rank,
    singularValues,
    conditionNumber,
    sampleRelativeResidual,
    bandlimitedRelativeResidual,
    heldOut,
    globalMeanBaseline,
    localNeighbourBaseline,
  };
}

function measureHeldOut(values: Float64Array, prediction: Float64Array, heldIndices: readonly number[]): HeldOutMetrics {
  if (heldIndices.length === 0) return { indices: [], relativeError: null, mae: null, residualNorm: null };
  let errorSum = 0;
  let truthSum = 0;
  let absoluteSum = 0;
  for (const node of heldIndices) {
    const delta = values[node]! - prediction[node]!;
    errorSum += delta * delta;
    truthSum += values[node]! * values[node]!;
    absoluteSum += Math.abs(delta);
  }
  return {
    indices: heldIndices,
    relativeError: Math.sqrt(errorSum) / Math.max(Math.sqrt(truthSum), RECOVERY_ENERGY_FLOOR),
    mae: absoluteSum / heldIndices.length,
    residualNorm: Math.sqrt(errorSum),
  };
}

function baselineMetrics(
  kind: 'global-mean' | 'local-neighbour',
  policy: string,
  values: Float64Array,
  prediction: Float64Array,
  heldIndices: readonly number[],
  recovery: HeldOutMetrics,
): BaselineMetrics {
  const heldOut = measureHeldOut(values, prediction, heldIndices);
  const improvementFactor =
    heldOut.relativeError !== null && recovery.relativeError !== null && recovery.relativeError > RECOVERY_ENERGY_FLOOR
      ? heldOut.relativeError / recovery.relativeError
      : null;
  return { kind, policy, heldOutRelativeError: heldOut.relativeError, heldOutMae: heldOut.mae, improvementFactor };
}
