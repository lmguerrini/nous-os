/** D-073 tranche F, row F4 — bounded restarted Lanczos with full reorthogonalisation for the
 * Holographic spectral core.
 *
 * Target: k = min(24, n - c) lowest NONTRIVIAL modes of L = D - A over attested edges, where
 * c is the connected-component count (n-1 is the connected special case). The
 * zero-eigenvalue cluster is exact by construction: its eigenspace is the span of the component
 * indicators, so the solver returns c orthonormalised indicators with numerically checked
 * residuals instead of iterating for them, and runs Lanczos on their orthogonal complement.
 *
 * Per restart cycle the Krylov basis grows to r = min(n - c, max(2k + 8, 256)) columns with two
 * modified Gram-Schmidt passes against every column (full reorthogonalisation). Breakdowns
 * (invariant subspaces, which tie multiplicities cause) inject deterministic SHA-256-seeded
 * noise vectors — this is how degenerate eigenvalues accumulate copies. The projected problem
 * H = V^T L V is formed explicitly and solved by a private symmetric Householder reduction
 * and implicit QL solver. Its 512-column memory cap is separate from the 172-node dense
 * reference ceiling. Wanted Ritz pairs
 * are accepted only on direct residual checks. Thick restarts keep the k + 12 smallest Ritz
 * vectors (at most m - 8) and expand a fresh chain from the last kept vector, which discards
 * the high-end junk the chain has already resolved; nonconvergence, orthogonality failure,
 * negative eigenvalues, a zero-cluster ambiguity, a restart size whose projected order
 * exceeds 512 or a refusal of the projected QL solve refuse with a typed
 * code and diagnostics, never a silent substitute.
 *
 * A certified simple unit-weight cycle uses its exact Fourier modes, because one scalar
 * Krylov chain can miss the second copy of each paired eigenvalue. All returned columns
 * pass the same direct residual and orthogonality checks.
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

export const LANCZOS_SOLVER_VERSION = 'thick-restart-lanczos-householder-ql-v2';
export const LANCZOS_DEFAULT_MODES = 24;
export const LANCZOS_DEFAULT_TOLERANCE = 1e-8;
export const LANCZOS_DEFAULT_MAX_RESTARTS = 8;
export const LANCZOS_DEFAULT_ORTHOGONALITY_TOLERANCE = 1e-8;
/** Post-reorthogonalisation norm below this fraction of max(1, ||L||_2 bound) means the
 * Krylov iteration hit an invariant subspace and a deterministic noise vector is injected. */
export const LANCZOS_BREAKDOWN_RELATIVE_TOLERANCE = 1e-11;

export type LanczosRefusalCode =
  | 'invalid-input'
  | 'projected-size-above-cap'
  | 'injection-failure'
  | 'nonconvergence'
  | 'orthogonality-failure'
  | 'negative-eigenvalue'
  | 'component-count-mismatch'
  | 'projected-ql-solve-refused';

export interface LanczosOptions {
  /** Wanted nontrivial modes; clamped to min(k, n - c). Default 24. */
  readonly k?: number;
  /** Explicit Krylov restart size r. The default is min(n-c,max(2k+8,256));
   * explicit values are respected. Values above 512 refuse with
   * `projected-size-above-cap`; values above n-c but at most 512 refuse with
   * `invalid-input`. */
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

/** Default Krylov restart size r = min(n, max(2k + 8, 256)), clamped to the effective
 * (complement) dimension, which is the mathematical ceiling on independent basis columns.
 * The 256 floor resolves all five measured 850-node knowledge-graph shapes. */
export function lanczosRestartSize(effectiveDimension: number, k: number): number {
  return Math.min(effectiveDimension, Math.max(2 * k + 8, 256));
}

/** Orthogonal Householder reduction H=QTQ followed by implicit shifted QL on the real
 * symmetric tridiagonal T. This solver is private to the projected Ritz problem: the
 * separately governed dense reference route retains its 172-node ceiling. QL's rotations
 * are accumulated into Q; returned columns are eigenvectors in the original Krylov basis.
 * Each QL block is bounded to 64 iterations, with failure translated to a typed refusal. */
function projectedEigenproblem(values: Float64Array, n: number): { eigenvalues: Float64Array; eigenvectors: Float64Array } {
  const a = Float64Array.from(values);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  const at = (row: number, col: number): number => a[row + col * n]!;
  const put = (row: number, col: number, value: number): void => { a[row + col * n] = value; };
  for (let i = n - 1; i >= 1; i -= 1) {
    const l = i - 1;
    let h = 0;
    let scale = 0;
    if (l > 0) {
      for (let k = 0; k <= l; k += 1) scale += Math.abs(at(i, k));
      if (scale === 0) e[i] = at(i, l);
      else {
        for (let k = 0; k <= l; k += 1) { const v = at(i, k) / scale; put(i, k, v); h += v * v; }
        let f = at(i, l);
        const g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
        e[i] = scale * g;
        h -= f * g;
        put(i, l, f - g);
        f = 0;
        for (let j = 0; j <= l; j += 1) {
          put(j, i, at(i, j) / h);
          let sum = 0;
          for (let k = 0; k <= j; k += 1) sum += at(j, k) * at(i, k);
          for (let k = j + 1; k <= l; k += 1) sum += at(k, j) * at(i, k);
          e[j] = sum / h;
          f += e[j]! * at(i, j);
        }
        const hh = f / (2 * h);
        for (let j = 0; j <= l; j += 1) {
          f = at(i, j);
          const g2 = e[j]! - hh * f;
          e[j] = g2;
          for (let k = 0; k <= j; k += 1) put(j, k, at(j, k) - f * e[k]! - g2 * at(i, k));
        }
      }
    } else e[i] = at(i, l);
    d[i] = h;
  }
  d[0] = 0;
  e[0] = 0;
  for (let i = 0; i < n; i += 1) {
    const l = i - 1;
    if (d[i] !== 0) {
      for (let j = 0; j <= l; j += 1) {
        let g = 0;
        for (let k = 0; k <= l; k += 1) g += at(i, k) * at(k, j);
        for (let k = 0; k <= l; k += 1) put(k, j, at(k, j) - g * at(k, i));
      }
    }
    d[i] = at(i, i);
    put(i, i, 1);
    for (let j = 0; j <= l; j += 1) { put(j, i, 0); put(i, j, 0); }
  }
  for (let i = 1; i < n; i += 1) e[i - 1] = e[i]!;
  e[n - 1] = 0;
  for (let l = 0; l < n; l += 1) {
    let iterations = 0;
    for (;;) {
      let m = l;
      while (m < n - 1 && Math.abs(e[m]!) > Number.EPSILON * (Math.abs(d[m]!) + Math.abs(d[m + 1]!))) m += 1;
      if (m === l) break;
      if (++iterations > 64) throw new Error(`implicit QL did not converge for block starting at ${l}`);
      let g = (d[l + 1]! - d[l]!) / (2 * e[l]!);
      let r = Math.hypot(g, 1);
      g = d[m]! - d[l]! + e[l]! / (g + (g >= 0 ? r : -r));
      let s = 1;
      let c = 1;
      let p = 0;
      for (let i = m - 1; i >= l; i -= 1) {
        const f = s * e[i]!;
        const b = c * e[i]!;
        if (Math.abs(f) >= Math.abs(g)) {
          c = g / f;
          r = Math.hypot(c, 1);
          e[i + 1] = f * r;
          s = 1 / r;
          c *= s;
        } else {
          s = f / g;
          r = Math.hypot(s, 1);
          e[i + 1] = g * r;
          c = 1 / r;
          s *= c;
        }
        g = d[i + 1]! - p;
        r = (d[i]! - g) * s + 2 * c * b;
        p = s * r;
        d[i + 1] = g + p;
        g = c * r - b;
        for (let row = 0; row < n; row += 1) {
          const next = at(row, i + 1);
          put(row, i + 1, s * at(row, i) + c * next);
          put(row, i, c * at(row, i) - s * next);
        }
      }
      d[l] = d[l]! - p;
      e[l] = g;
      e[m] = 0;
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => d[i]! - d[j]! || i - j);
  const eigenvalues = new Float64Array(n);
  const eigenvectors = new Float64Array(n * n);
  for (let out = 0; out < n; out += 1) {
    const source = order[out]!;
    eigenvalues[out] = d[source]!;
    for (let row = 0; row < n; row += 1) eigenvectors[row + out * n] = at(row, source);
  }
  return { eigenvalues, eigenvectors };
}

/** Exact Fourier diagonalisation for a certified unit-weight simple cycle. This matters at
 * the disclosure cap: one scalar Krylov chain spans only one direction of each paired
 * eigenvalue, so small Ritz residuals alone cannot certify that it found both copies. */
function simpleCycleOrder(graph: SpectralGraph): number[] | null {
  const n = graph.size;
  if (n < 3 || graph.componentCount !== 1) return null;
  for (let row = 0; row < n; row += 1) {
    if (graph.csrRowStart[row + 1]! - graph.csrRowStart[row]! !== 2 || graph.degrees[row] !== 2) return null;
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1)
      if (graph.csrWeight[slot] !== 1) return null;
  }
  const order = [0];
  const seen = new Uint8Array(n);
  seen[0] = 1;
  let previous = -1;
  let current = 0;
  while (order.length < n) {
    const start = graph.csrRowStart[current]!;
    const first = graph.csrNeighbor[start]!;
    const second = graph.csrNeighbor[start + 1]!;
    const next = previous < 0 ? Math.min(first, second) : first === previous ? second : first;
    if (seen[next]) return null;
    seen[next] = 1;
    order.push(next);
    previous = current;
    current = next;
  }
  const start = graph.csrRowStart[current]!;
  if (graph.csrNeighbor[start] !== 0 && graph.csrNeighbor[start + 1] !== 0) return null;
  return order;
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
  // The projected m x m Ritz problem uses Householder QL, independently of dense.ts.
  const requestedRestart = options.restartSize ?? lanczosRestartSize(nEff, k);
  if (requestedRestart > nEff) {
    return refuse('invalid-input', `restartSize ${String(requestedRestart)} exceeds effective dimension ${String(nEff)}`);
  }
  if (requestedRestart > 512) {
    return refuse(
      'projected-size-above-cap',
      `restartSize ${String(requestedRestart)} exceeds the projected Householder QL memory cap 512`,
    );
  }
  const r = Math.min(nEff, requestedRestart);

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

  const cycleOrder = simpleCycleOrder(graph);
  if (cycleOrder !== null) {
    const values = new Float64Array(k);
    const columns: Float64Array[] = [];
    for (let mode = 0; mode < k; mode += 1) {
      const frequency = Math.floor(mode / 2) + 1;
      const isNyquist = n % 2 === 0 && frequency === n / 2;
      values[mode] = 2 - 2 * Math.cos(2 * Math.PI * frequency / n);
      const vector = new Float64Array(n);
      for (let position = 0; position < n; position += 1) {
        const angle = 2 * Math.PI * frequency * position / n;
        vector[cycleOrder[position]!] = isNyquist
          ? (position % 2 === 0 ? 1 : -1) / Math.sqrt(n)
          : Math.sqrt(2 / n) * (mode % 2 === 0 ? Math.cos(angle) : Math.sin(angle));
      }
      columns.push(vector);
    }
    const assembled = assembleConverged(graph, zeroColumns, zeroModeMaxResidual, values, columns, {
      seed, restartSize: r, restartsUsed: 0, matvecCount: k + c, peakBasisSize: k,
      finalBasisSize: k, cycles: [], started, denominator, tolerance, orthTol,
    });
    if (assembled.kind === 'converged') return assembled.value;
    return refuse('nonconvergence', 'the certified cycle Fourier eigenpairs failed direct verification');
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
    // A numerical QL failure is translated to a typed refusal, never an escaping throw.
    let projected: ReturnType<typeof projectedEigenproblem>;
    try {
      projected = projectedEigenproblem(hValues, m);
    } catch (error) {
      return refuse(
        'projected-ql-solve-refused',
        `the projected ${String(m)}x${String(m)} Ritz eigenproblem was refused by Householder QL: ${error instanceof Error ? error.message : String(error)}`,
        { cycles, restartsUsed },
      );
    }

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
