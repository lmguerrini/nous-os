/** D-073 tranche F, row F3 — dense symmetric eigensolver, the reference for small graphs. Cyclic Jacobi with plane rotations: simple,
 * numerically very accurate and fully deterministic; cost O(n^3) per sweep, reported honestly.
 * The solver refuses oversize or nonconverging inputs instead of silently degrading.
 *
 * Size policy:
 * the dense route is a separately benchmarked fallback for graphs of at most
 * DENSE_DEFAULT_MAX_N = 172 nodes, never a silent substitute at the 850-node disclosure cap.
 * A plain call therefore refuses n > 172. Solving a larger n is reserved to the reference
 * benchmarks and requires BOTH an explicit maxN and the named opt-in DENSE_BENCHMARK_OPT_IN
 * (bounded by DENSE_BENCHMARK_MAX_N); production callers above the ceiling must use the
 * bounded Lanczos solver instead. */

import type { SpectralGraph } from './adjacency.ts';
import { createMatrix, dot, frobeniusNorm, identityMatrix, largestEntryIndex, norm2 } from './linear-algebra.ts';

export const DENSE_SYMMETRIC_SOLVER_VERSION = 'jacobi-cyclic-v1';
/** The dense fallback ceiling: a plain call refuses any larger order. */
export const DENSE_DEFAULT_MAX_N = 172;
export const DENSE_DEFAULT_SWEEP_LIMIT = 64;
/** The largest order the named benchmark opt-in may authorize. */
export const DENSE_BENCHMARK_MAX_N = 1024;
/** Named opt-in token: the only way to solve n > DENSE_DEFAULT_MAX_N. Reserved for the
 * separately benchmarked reference tests; production callers must use Lanczos above 172. */
export const DENSE_BENCHMARK_OPT_IN = 'dense-benchmark-reference-v1' as const;

/** Symmetric n x n matrix, column-major, both triangles stored. */
export interface DenseSymmetricMatrix {
  readonly n: number;
  readonly values: Float64Array;
}

export interface DenseEigenOptions {
  readonly maxN?: number;
  readonly sweepLimit?: number;
  /** Must equal DENSE_BENCHMARK_OPT_IN to authorize any maxN above DENSE_DEFAULT_MAX_N.
   * Named so a silent large dense route cannot be constructed by accident. */
  readonly benchmarkOptIn?: typeof DENSE_BENCHMARK_OPT_IN;
}

export interface DenseEigenSolution {
  readonly n: number;
  /** Ascending; exact ties keep the sweep's diagonal order (stable). */
  readonly eigenvalues: Float64Array;
  /** n x n column-major; column j is the unit eigenvector of eigenvalues[j].
   * Each column's largest-absolute entry (ties by smallest row index) is positive. */
  readonly eigenvectors: Float64Array;
  readonly sweeps: number;
  readonly rotations: number;
  readonly offDiagonalNorm: number;
  /** max_j ||A v_j - lambda_j v_j||_2 against the ORIGINAL matrix. */
  readonly maxAbsResidual: number;
  readonly orthogonalityDefect: number;
  readonly durationMs: number;
}

/** Dense L = D - A of a spectral graph, for the reference path and cross-checks. */
export function denseLaplacian(graph: SpectralGraph): DenseSymmetricMatrix {
  const n = graph.size;
  const values = new Float64Array(n * n);
  for (let row = 0; row < n; row += 1) {
    values[row + row * n] = graph.degrees[row]!;
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1) {
      const col = graph.csrNeighbor[slot]!;
      const weight = graph.csrWeight[slot]!;
      values[row + col * n] = -weight;
    }
  }
  return { n, values };
}

function applyOriginal(matrix: Float64Array, n: number, x: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let col = 0; col < n; col += 1) {
    const coefficient = x[col]!;
    if (coefficient === 0) continue;
    const base = col * n;
    for (let row = 0; row < n; row += 1) y[row] = y[row]! + coefficient * matrix[base + row]!;
  }
  return y;
}

export function solveDenseSymmetricEigen(matrix: DenseSymmetricMatrix, options: DenseEigenOptions = {}): DenseEigenSolution {
  const started = performance.now();
  const n = matrix.n;
  const maxN = options.maxN ?? DENSE_DEFAULT_MAX_N;
  const sweepLimit = options.sweepLimit ?? DENSE_DEFAULT_SWEEP_LIMIT;
  if (!Number.isInteger(n) || n < 0) fail(`invalid order ${n}`);
  if (maxN > DENSE_DEFAULT_MAX_N && options.benchmarkOptIn !== DENSE_BENCHMARK_OPT_IN) {
    fail(
      `maxN=${maxN} exceeds the dense fallback ceiling ${DENSE_DEFAULT_MAX_N}; the dense route above ${DENSE_DEFAULT_MAX_N} is ` +
        `reserved to the separately benchmarked reference tests and requires benchmarkOptIn=${DENSE_BENCHMARK_OPT_IN}; ` +
        'production callers must use the Lanczos solver',
    );
  }
  if (maxN > DENSE_BENCHMARK_MAX_N) {
    fail(`maxN=${maxN} exceeds the benchmark ceiling ${DENSE_BENCHMARK_MAX_N} even with the opt-in`);
  }
  if (n > maxN) {
    fail(
      `refuses n=${n} > maxN=${maxN}; the dense solver is the benchmarked fallback for graphs of at most ` +
        `${DENSE_DEFAULT_MAX_N} nodes (use the Lanczos solver above that ceiling)`,
    );
  }
  if (matrix.values.length !== n * n) fail(`values length ${matrix.values.length} does not match n=${n}`);
  for (const value of matrix.values) {
    if (!Number.isFinite(value)) fail('refuses nonfinite matrix entries');
  }
  if (n === 0) {
    return {
      n: 0, eigenvalues: new Float64Array(0), eigenvectors: new Float64Array(0),
      sweeps: 0, rotations: 0, offDiagonalNorm: 0, maxAbsResidual: 0, orthogonalityDefect: 0,
      durationMs: performance.now() - started,
    };
  }

  const a = Float64Array.from(matrix.values);
  const v = identityMatrix(n);
  const original = matrix.values;
  const scale = frobeniusNorm({ rows: n, cols: n, data: a }) || 1;
  // Convergence: off-diagonal Frobenius norm below a machine-epsilon multiple of the scale.
  // Pairs far below the per-element share are skipped; both bounds derive from this target.
  const offTarget = Math.max(32 * Number.EPSILON * scale * Math.sqrt(n), 1e-300);
  const skipThreshold = offTarget / Math.max(1, (n * (n - 1)) / 2);

  const offDiagonal = (): number => {
    let sum = 0;
    for (let col = 0; col < n; col += 1) {
      for (let row = col + 1; row < n; row += 1) {
        const value = a[row + col * n]!;
        sum += value * value;
      }
    }
    return Math.sqrt(2 * sum);
  };

  let sweeps = 0;
  let rotations = 0;
  let off = offDiagonal();
  while (off > offTarget && sweeps < sweepLimit) {
    sweeps += 1;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p + q * n]!;
        if (Math.abs(apq) <= skipThreshold) continue;
        rotations += 1;
        const app = a[p + p * n]!;
        const aqq = a[q + q * n]!;
        const tau = (aqq - app) / (2 * apq);
        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        for (let i = 0; i < n; i += 1) {
          if (i === p || i === q) continue;
          const aip = a[i + p * n]!;
          const aiq = a[i + q * n]!;
          a[i + p * n] = c * aip - s * aiq;
          a[p + i * n] = a[i + p * n]!;
          a[i + q * n] = s * aip + c * aiq;
          a[q + i * n] = a[i + q * n]!;
        }
        a[p + q * n] = 0;
        a[q + p * n] = 0;
        a[p + p * n] = app - t * apq;
        a[q + q * n] = aqq + t * apq;
        for (let i = 0; i < n; i += 1) {
          const vip = v.data[i + p * n]!;
          const viq = v.data[i + q * n]!;
          v.data[i + p * n] = c * vip - s * viq;
          v.data[i + q * n] = s * vip + c * viq;
        }
      }
    }
    off = offDiagonal();
  }
  if (off > offTarget) fail(`nonconvergence after ${sweeps} sweeps (off-diagonal ${off})`);

  const order = Array.from({ length: n }, (_unused, index) => index).sort((x, y) => a[x + x * n]! - a[y + y * n]! || x - y);
  const eigenvalues = new Float64Array(n);
  const eigenvectors = new Float64Array(n * n);
  for (let out = 0; out < n; out += 1) {
    const source = order[out]!;
    eigenvalues[out] = a[source + source * n]!;
    const column = v.data.subarray(source * n, (source + 1) * n);
    const pivot = largestEntryIndex(column, 1e-10);
    const sign = column[pivot]! < 0 ? -1 : 1;
    for (let row = 0; row < n; row += 1) eigenvectors[row + out * n] = column[row]! * sign;
  }

  let maxAbsResidual = 0;
  let defectSum = 0;
  const column = new Float64Array(n);
  const gram = createMatrix(n, n);
  for (let j = 0; j < n; j += 1) {
    column.set(eigenvectors.subarray(j * n, (j + 1) * n));
    const product = applyOriginal(original, n, column);
    addInPlace(product, column, -eigenvalues[j]!);
    maxAbsResidual = Math.max(maxAbsResidual, norm2(product));
    for (let i = j; i < n; i += 1) {
      const other = eigenvectors.subarray(i * n, (i + 1) * n);
      const value = dot(other, column);
      gram.data[i + j * n] = value;
      gram.data[j + i * n] = value;
    }
  }
  for (let col = 0; col < n; col += 1) {
    for (let row = 0; row < n; row += 1) {
      const delta = gram.data[row + col * n]! - (row === col ? 1 : 0);
      defectSum += delta * delta;
    }
  }

  return {
    n,
    eigenvalues,
    eigenvectors,
    sweeps,
    rotations,
    offDiagonalNorm: off,
    maxAbsResidual,
    orthogonalityDefect: Math.sqrt(defectSum),
    durationMs: performance.now() - started,
  };
}

function addInPlace(target: Float64Array, source: Float64Array, alpha: number): void {
  for (let index = 0; index < target.length; index += 1) target[index] = target[index]! + alpha * source[index]!;
}

function fail(message: string): never {
  throw new Error(`holographic-dense: ${message}`);
}
