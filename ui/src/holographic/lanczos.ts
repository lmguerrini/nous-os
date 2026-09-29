/** D-073 tranche F, row F4 — bounded restarted Lanczos with full reorthogonalisation for the
 * Holographic spectral core.
 *
 * Target: k = min(24, n - c) lowest NONTRIVIAL modes of L = D - A over attested edges, where
 * c is the connected-component count (n-1 is the connected special case). The
 * zero-eigenvalue cluster is exact by construction: its eigenspace is the span of the component
 * indicators, so the solver returns c orthonormalised indicators with numerically checked
 * residuals instead of iterating for them, and runs Lanczos on their orthogonal complement.
 *
 * Per restart cycle the Krylov basis grows to r = min(n - c, max(2k + 8, 96)) columns with two
 * modified Gram-Schmidt passes against every column (full reorthogonalisation). Breakdowns
 * (invariant subspaces, which tie multiplicities cause) inject deterministic SHA-256-seeded
 * noise vectors — this is how degenerate eigenvalues accumulate copies. The projected problem
 * H = V^T L V is formed explicitly and solved by the dense reference solver; wanted Ritz pairs
 * are accepted only on direct residual checks. Thick restarts keep the k + 12 smallest Ritz
 * vectors (at most m - 8) and expand a fresh chain from the last kept vector, which discards
 * the high-end junk the chain has already resolved; nonconvergence, orthogonality failure,
 * negative eigenvalues or a zero-cluster ambiguity refuse with a typed code and diagnostics,
 * never a silent substitute.
 *
 * Work per restart: O(rm + r^2 n + r^3); peak memory O(m + r n + r^2). Deterministic by
 * (graph bytes, seed, options): identical inputs give identical outputs bit for bit. */

import { digestPayload } from '../engine/digest.ts';
import type { SpectralGraph } from './adjacency.ts';
import {
  addScaledInPlace,
  dot,
  largestEntryIndex,
  modifiedGramSchmidtTwice,
  norm2,
  orthogonalityDefect,
} from './linear-algebra.ts';
import { solveDenseSymmetricEigen } from './dense.ts';

export const LANCZOS_SOLVER_VERSION = 'thick-restart-lanczos-fullreorth-v1';
export const LANCZOS_DEFAULT_MODES = 24;
export const LANCZOS_DEFAULT_TOLERANCE = 1e-8;
export const LANCZOS_DEFAULT_MAX_RESTARTS = 8;
export const LANCZOS_DEFAULT_ORTHOGONALITY_TOLERANCE = 1e-8;
/** Post-reorthogonalisation norm below this fraction of max(1, ||L||_2 bound) means the
 * Krylov iteration hit an invariant subspace and a deterministic noise vector is injected. */
export const LANCZOS_BREAKDOWN_RELATIVE_TOLERANCE = 1e-11;

export type LanczosRefusalCode =
  | 'invalid-input'
  | 'injection-failure'
  | 'nonconvergence'
  | 'orthogonality-failure'
  | 'negative-eigenvalue'
  | 'component-count-mismatch';

export interface LanczosOptions {
  /** Wanted nontrivial modes; clamped to min(k, n - c). Default 24. */
  readonly k?: number;
  /** Krylov restart size r; default min(n - c, max(2k + 8, 96)). */
  readonly restartSize?: number;
  readonly maxRestarts?: number;
  /** Relative residual tolerance on max(1, ||L||_2 Gershgorin bound). Default 1e-8. */
  readonly tolerance?: number;
  readonly orthogonalityTolerance?: number;
  /** Digest-addressed seed (domain digest by convention); enters the noise stream hash. */
  readonly seed?: string;
}

export interface LanczosCycleLog {
  readonly basisSize: number;
  readonly keptVectors: number;
  readonly convergedWanted: number;
  readonly maxWantedRelativeResidual: number;
  readonly matvecsInCycle: number;
  readonly injectionsInCycle: number;
}

export interface LanczosConverged {
  readonly kind: 'converged';
  readonly algorithmVersion: string;
  readonly seedUsed: string;
  /** c exact zeros followed by the k lowest nontrivial eigenvalues, ascending. */
  readonly eigenvalues: Float64Array;
  /** n x (c + k) column-major; column j is the unit eigenvector of eigenvalues[j],
   * sign-fixed so the largest-absolute entry (ties by smallest node ID) is positive. */
  readonly eigenvectors: Float64Array;
  /** Absolute residuals ||L u_j - lambda_j u_j||_2, recomputed on the final columns. */
  readonly residuals: Float64Array;
  readonly relativeResidualMax: number;
  readonly orthogonalityDefect: number;
  readonly zeroModeMaxResidual: number;
  readonly zeroModes: number;
  readonly requestedModes: number;
  readonly componentCount: number;
  readonly restartSize: number;
  readonly restartsUsed: number;
  readonly matvecCount: number;
  readonly peakBasisSize: number;
  readonly finalBasisSize: number;
  readonly cycles: readonly LanczosCycleLog[];
  readonly durationMs: number;
  readonly estimatedPeakMemoryBytes: number;
}

export interface LanczosRefusal {
  readonly kind: 'refusal';
  readonly algorithmVersion: string;
  readonly code: LanczosRefusalCode;
  readonly message: string;
  readonly convergedModes: number;
  readonly requestedModes: number;
  readonly maxRelativeResidual: number | null;
  readonly restartsUsed: number;
  readonly cycles: readonly LanczosCycleLog[];
  readonly durationMs: number;
  readonly componentCount: number;
}

export type LanczosOutcome = LanczosConverged | LanczosRefusal;

/** Default Krylov restart size r = min(n, max(2k + 8, 96)), clamped to the effective
 * (complement) dimension, which is the mathematical ceiling on independent basis columns.
 * The 96 floor is a measured default: at the 850-node disclosure cap a degree-18 ring packs
 * its k = 24 wanted modes into a narrow cluster that stalls at r = 64 (20/24 modes after 8
 * restarts, seed-dependent) and converges reliably at r >= 80. */
export function lanczosRestartSize(effectiveDimension: number, k: number): number {
  return Math.min(effectiveDimension, Math.max(2 * k + 8, 96));
}

/** Deterministic uniform noise from SHA-256 counter blocks; no Math.random anywhere. */
class DeterministicNoise {
  private block: number[] = [];
  private counter = 0;
  private readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
  }

  nextDouble(): number {
    if (this.block.length === 0) {
      const hex = digestPayload([this.seed, LANCZOS_SOLVER_VERSION, 'noise-v1', this.counter]);
      this.counter += 1;
      for (let index = 0; index < 8; index += 1) this.block.push(parseInt(hex.slice(index * 8, index * 8 + 8), 16));
    }
    const unit = this.block.pop()! / 4294967296;
    return unit * 2 - 1;
  }

  fill(vector: Float64Array): void {
    for (let index = 0; index < vector.length; index += 1) vector[index] = this.nextDouble();
  }
}

export function solveSpectrum(graph: SpectralGraph, options: LanczosOptions = {}): LanczosOutcome {
  const started = performance.now();
  const n = graph.size;
  const c = graph.componentCount;
  const nEff = n - c;
  const kRequested = options.k ?? LANCZOS_DEFAULT_MODES;
  const maxRestarts = options.maxRestarts ?? LANCZOS_DEFAULT_MAX_RESTARTS;
  const tolerance = options.tolerance ?? LANCZOS_DEFAULT_TOLERANCE;
  const orthTol = options.orthogonalityTolerance ?? LANCZOS_DEFAULT_ORTHOGONALITY_TOLERANCE;
  const seed = options.seed ?? 'holographic-lanczos-default-seed';
  const refuse = (code: LanczosRefusalCode, message: string, extra: Readonly<{ convergedModes?: number; maxRelativeResidual?: number | null; restartsUsed?: number; cycles?: readonly LanczosCycleLog[] }> = {}): LanczosRefusal => ({
    kind: 'refusal',
    algorithmVersion: LANCZOS_SOLVER_VERSION,
    code,
    message,
    convergedModes: extra.convergedModes ?? 0,
    requestedModes: Math.max(0, Math.min(kRequested, nEff)),
    maxRelativeResidual: extra.maxRelativeResidual ?? null,
    restartsUsed: extra.restartsUsed ?? 0,
    cycles: extra.cycles ?? [],
    durationMs: performance.now() - started,
    componentCount: c,
  });

  if (!Number.isInteger(kRequested) || kRequested < 0) return refuse('invalid-input', `k must be a nonnegative integer, got ${String(kRequested)}`);
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) return refuse('invalid-input', `maxRestarts must be a nonnegative integer, got ${String(maxRestarts)}`);
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return refuse('invalid-input', `tolerance must be positive and finite, got ${String(tolerance)}`);
  if (!(orthTol > 0) || !Number.isFinite(orthTol)) return refuse('invalid-input', `orthogonalityTolerance must be positive and finite, got ${String(orthTol)}`);

  const k = Math.min(kRequested, nEff);
  const bound = Math.max(1, graph.spectralNormBound);
  const zeroThreshold = 1e-8 * bound;
  const breakdownTolerance = LANCZOS_BREAKDOWN_RELATIVE_TOLERANCE * bound;
  const denominator = bound;
  if (options.restartSize !== undefined && (!Number.isInteger(options.restartSize) || options.restartSize < k + 1)) {
    return refuse('invalid-input', `restartSize ${String(options.restartSize)} cannot hold k=${String(k)} modes`);
  }
  const r = Math.min(options.restartSize ?? lanczosRestartSize(nEff, k), nEff);

  // Exact zero cluster: component indicators have disjoint supports, so they are exactly
  // orthogonal; normalising each is a complete orthonormalisation of the null space.
  const zeroColumns: Float64Array[] = [];
  for (const component of graph.components) {
    const indicator = new Float64Array(n);
    const scale = 1 / Math.sqrt(component.memberIndices.length);
    for (const index of component.memberIndices) indicator[index] = scale;
    zeroColumns.push(indicator);
  }
  let zeroModeMaxResidual = 0;
  for (const indicator of zeroColumns) {
    zeroModeMaxResidual = Math.max(zeroModeMaxResidual, norm2(graph.applyLaplacian(indicator)));
  }
  if (zeroModeMaxResidual > zeroThreshold) {
    return refuse('component-count-mismatch', `component indicator residual ${zeroModeMaxResidual} exceeds the zero-cluster threshold ${zeroThreshold}`);
  }

  if (k === 0) {
    const assembled = assembleConverged(graph, zeroColumns, zeroModeMaxResidual, new Float64Array(0), [], {
      seed, restartSize: r, restartsUsed: 0, matvecCount: 0, peakBasisSize: 0, finalBasisSize: 0,
      cycles: [], started, denominator, tolerance, orthTol,
    });
    if (assembled.kind === 'converged') return assembled.value;
    return refuse('nonconvergence', 'the trivial-only solve failed its residual re-verification');
  }

  const noise = new DeterministicNoise(seed);
  let basis: Float64Array[] = [];
  let basisProducts: Float64Array[] = [];
  let matvecCount = 0;
  let restartsUsed = 0;
  let peakBasisSize = 0;
  const cycles: LanczosCycleLog[] = [];

  const drawOrthogonalVector = (): { vector: Float64Array; norm: number } | null => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = new Float64Array(n);
      noise.fill(candidate);
      // One combined sequence per pass: subtracting basis projections after the zero pass
      // would reintroduce zero-mode components amplified by the Krylov recurrence.
      const norm = modifiedGramSchmidtTwice(candidate, [...zeroColumns, ...basis]);
      if (norm > breakdownTolerance) return { vector: candidate, norm };
    }
    return null;
  };

  for (;;) {
    let cycleMatvecs = 0;
    let injections = 0;
    if (basis.length === 0) {
      const drawn = drawOrthogonalVector();
      if (!drawn) return refuse('injection-failure', 'the start vector never escaped the current span', { cycles });
      scaleInPlace2(drawn.vector, 1 / drawn.norm);
      basis = [drawn.vector];
      basisProducts = [graph.applyLaplacian(drawn.vector)];
      cycleMatvecs += 1;
    }
    let stalled = false;
    while (basis.length < r) {
      const last = basis[basis.length - 1]!;
      const w = Float64Array.from(basisProducts[basis.length - 1]!);
      let norm = modifiedGramSchmidtTwice(w, [...zeroColumns, ...basis]);
      if (norm <= breakdownTolerance) {
        if (basis.length === nEff) break;
        const drawn = drawOrthogonalVector();
        if (!drawn) {
          stalled = true;
          break;
        }
        injections += 1;
        w.set(drawn.vector);
        norm = drawn.norm;
      }
      scaleInPlace2(w, 1 / norm);
      basis.push(w);
      basisProducts.push(graph.applyLaplacian(w));
      cycleMatvecs += 1;
    }
    if (stalled) return refuse('injection-failure', `noise injections could not extend the ${basis.length}-column basis`, { cycles, restartsUsed });
    const m = basis.length;
    peakBasisSize = Math.max(peakBasisSize, m);
    matvecCount += cycleMatvecs;

    const defect = orthogonalityDefect([...zeroColumns, ...basis]);
    if (defect > orthTol) {
      return refuse('orthogonality-failure', `basis orthogonality defect ${defect} exceeds ${orthTol}`, { cycles, restartsUsed, maxRelativeResidual: null });
    }

    const hValues = new Float64Array(m * m);
    for (let col = 0; col < m; col += 1) {
      for (let row = 0; row <= col; row += 1) {
        const value = dot(basis[row]!, basisProducts[col]!);
        hValues[row + col * m] = value;
        if (row !== col) hValues[col + row * m] = value;
      }
    }
    const projected = solveDenseSymmetricEigen({ n: m, values: hValues });

    // Ritz vectors for the k wanted pairs (residual-checked) plus the extra retained vectors
    // a thick restart keeps beyond k, bounded by the basis size.
    const ritzCount = Math.min(m, k + 12);
    const ritzVectors: Float64Array[] = [];
    const residuals: number[] = [];
    for (let wanted = 0; wanted < ritzCount; wanted += 1) {
      const theta = projected.eigenvalues[wanted]!;
      const y = new Float64Array(n);
      for (let column = 0; column < m; column += 1) {
        const coefficient = projected.eigenvectors[column + wanted * m]!;
        if (coefficient !== 0) addScaledInPlace(y, basis[column]!, coefficient);
      }
      ritzVectors.push(y);
      if (wanted < k) {
        const product = graph.applyLaplacian(y);
        cycleMatvecs += 1;
        addScaledInPlace(product, y, -theta);
        residuals.push(norm2(product) / denominator);
      }
    }
    matvecCount += k;

    let convergedWanted = 0;
    let maxRelativeResidual = 0;
    for (const residual of residuals) {
      if (residual <= tolerance) convergedWanted += 1;
      maxRelativeResidual = Math.max(maxRelativeResidual, residual);
    }

    if (convergedWanted === k) {
      for (let wanted = 0; wanted < k; wanted += 1) {
        const theta = projected.eigenvalues[wanted]!;
        if (theta < -zeroThreshold) {
          return refuse('negative-eigenvalue', `Ritz value ${theta} is negative beyond tolerance`, { cycles, restartsUsed, convergedModes: 0, maxRelativeResidual });
        }
        if (theta <= zeroThreshold) {
          return refuse('component-count-mismatch', `nontrivial Ritz value ${theta} falls inside the zero cluster (threshold ${zeroThreshold}); the eigenvalue tie is ambiguous at this tolerance`, { cycles, restartsUsed, convergedModes: 0, maxRelativeResidual });
        }
      }
      const assembled = assembleConverged(graph, zeroColumns, zeroModeMaxResidual, projected.eigenvalues.subarray(0, k), ritzVectors, {
        seed, restartSize: r, restartsUsed, matvecCount, peakBasisSize, finalBasisSize: m,
        cycles: [...cycles, { basisSize: m, keptVectors: 0, convergedWanted, maxWantedRelativeResidual: maxRelativeResidual, matvecsInCycle: cycleMatvecs, injectionsInCycle: injections }],
        started, denominator, tolerance, orthTol,
      });
      if (assembled.kind === 'converged') return assembled.value;
      // The final reorthogonalisation degraded a residual past tolerance: keep iterating.
    }

    // Thick restart keeps the smallest Ritz vectors, then continues expanding from the last.
    // m >= 2k + 8 whenever m < nEff (the basis would otherwise already span the complement and
    // converge exactly), so m - 8 >= k; the max() only guards arithmetic pathologies.
    const keepCount = Math.max(Math.min(k, m), Math.min(m - 8, k + 12));
    cycles.push({ basisSize: m, keptVectors: keepCount, convergedWanted, maxWantedRelativeResidual: maxRelativeResidual, matvecsInCycle: cycleMatvecs, injectionsInCycle: injections });
    if (restartsUsed >= maxRestarts) {
      return refuse('nonconvergence', `${convergedWanted}/${k} wanted modes converged after ${restartsUsed} restarts (worst relative residual ${maxRelativeResidual})`, { cycles, restartsUsed, convergedModes: convergedWanted, maxRelativeResidual });
    }
    restartsUsed += 1;
    const keptBasis: Float64Array[] = [];
    for (let wanted = 0; wanted < keepCount; wanted += 1) {
      const y = ritzVectors[wanted]!;
      modifiedGramSchmidtTwice(y, [...zeroColumns, ...keptBasis]);
      scaleInPlace2(y, 1 / norm2(y));
      keptBasis.push(y);
    }
    basis = keptBasis;
    basisProducts = keptBasis.map((vector) => graph.applyLaplacian(vector));
    matvecCount += keptBasis.length;
  }
}

interface AssemblyContext {
  readonly seed: string;
  readonly restartSize: number;
  readonly restartsUsed: number;
  readonly matvecCount: number;
  readonly peakBasisSize: number;
  readonly finalBasisSize: number;
  readonly cycles: readonly LanczosCycleLog[];
  readonly started: number;
  readonly denominator: number;
  readonly tolerance: number;
  readonly orthTol: number;
}

/** Final assembly: orthonormalise, sign-fix and re-verify every returned column. Returns a
 * refusal-shaped marker (not a LanczosRefusal) when the re-verification fails, so the caller
 * can keep iterating; converging callers return only the checked result. */
function assembleConverged(
  graph: SpectralGraph,
  zeroColumns: readonly Float64Array[],
  zeroModeMaxResidual: number,
  nontrivialValues: Float64Array,
  candidateColumns: readonly Float64Array[],
  context: AssemblyContext,
): { kind: 'converged'; value: LanczosConverged } | { kind: 'degraded' } {
  const n = graph.size;
  const c = zeroColumns.length;
  const k = nontrivialValues.length;
  const columns: Float64Array[] = [...zeroColumns];
  for (let wanted = 0; wanted < k; wanted += 1) {
    const y = Float64Array.from(candidateColumns[wanted] ?? new Float64Array(n));
    modifiedGramSchmidtTwice(y, columns);
    scaleInPlace2(y, 1 / norm2(y));
    columns.push(y);
  }

  const eigenvalues = new Float64Array(c + k);
  for (let index = 0; index < c; index += 1) eigenvalues[index] = 0;
  for (let wanted = 0; wanted < k; wanted += 1) eigenvalues[c + wanted] = nontrivialValues[wanted]!;

  const eigenvectors = new Float64Array(n * (c + k));
  const residuals = new Float64Array(c + k);
  let relativeResidualMax = 0;
  for (let column = 0; column < columns.length; column += 1) {
    const y = columns[column]!;
    const pivot = largestEntryIndex(y, 1e-10);
    if (y[pivot]! < 0) scaleInPlace2(y, -1);
    eigenvectors.set(y, column * n);
    const product = graph.applyLaplacian(y);
    addScaledInPlace(product, y, -eigenvalues[column]!);
    const absolute = norm2(product);
    residuals[column] = absolute;
    if (column >= c) relativeResidualMax = Math.max(relativeResidualMax, absolute / context.denominator);
  }
  if (relativeResidualMax > context.tolerance) return { kind: 'degraded' };
  const defect = orthogonalityDefect(columns);
  if (defect > context.orthTol) return { kind: 'degraded' };

  const nnz = graph.csrNeighbor.length;
  return {
    kind: 'converged',
    value: {
      kind: 'converged',
      algorithmVersion: LANCZOS_SOLVER_VERSION,
      seedUsed: context.seed,
      eigenvalues,
      eigenvectors,
      residuals,
      relativeResidualMax,
      orthogonalityDefect: defect,
      zeroModeMaxResidual,
      zeroModes: c,
      requestedModes: k,
      componentCount: graph.componentCount,
      restartSize: context.restartSize,
      restartsUsed: context.restartsUsed,
      matvecCount: context.matvecCount + columns.length,
      peakBasisSize: context.peakBasisSize,
      finalBasisSize: context.finalBasisSize,
      cycles: context.cycles,
      durationMs: performance.now() - context.started,
      estimatedPeakMemoryBytes: 8 * (2 * context.peakBasisSize * n + (c + k) * n + nnz * 1.5 + context.peakBasisSize * context.peakBasisSize) + 12 * nnz,
    },
  };
}

function scaleInPlace2(x: Float64Array, alpha: number): void {
  for (let index = 0; index < x.length; index += 1) x[index] = x[index]! * alpha;
}
