import { appendAll, maxOf, minOf } from '#render-common/array-aggregation.ts';
/** G7 spectral 2D/3D geometry. Each attested component solves the symmetric
 * normalised Laplacian N = D^-1/2 L D^-1/2; the orthonormal u eigenvectors are
 * shared by heat and recovery, while the displayed Koren coordinates use
 * v = D^-1/2 u, so L v = lambda D v. Components are centred, scaled to unit
 * maximum extent, then packed by descending size and smallest ID with a 0.5
 * gutter. The G6 projector-probe-v2 rule canonicalises tied eigenspaces before
 * the degree conversion. Every failed numerical witness returns typed empty
 * coordinates; no fallback layout is substituted. */

import { digestPayload } from '../engine/digest.ts';
import type { Dimension, Digest, Explanation, NodeId, Vec2, Vec3 } from '../projection/contract-types.ts';
import { normalizedSpectralGraph, spectralComponentGraph, type SpectralGraph } from './adjacency.ts';
import { DENSE_DEFAULT_MAX_N, DENSE_SYMMETRIC_SOLVER_VERSION, solveDenseSymmetricEigen, type DenseEigenSolution } from './dense.ts';
import { LANCZOS_SOLVER_VERSION, lanczosRestartSize, solveSpectrum, type LanczosOptions } from './lanczos.ts';
import { largestEntryIndex, modifiedGramSchmidtTwice, norm2, orthogonalityDefect } from './linear-algebra.ts';
import { eigenbasisFromDense, eigenbasisFromLanczos, type Eigenbasis } from './signals.ts';

export const SPECTRAL_GEOMETRY_VERSION = 'holographic-geometry-v4';
/** Request-schema identifier retained until the projection contract can be migrated. */
export const EIGENSPACE_POLICY_VERSION = 'projector-probe-v1';
/** Version of the actual canonical-axis rule, included in geometry and result digests. */
export const CANONICAL_EIGENSPACE_POLICY_VERSION = 'projector-probe-v2';
export const CLUSTER_RELATIVE_TOLERANCE = 1e-8;
export const CLUSTER_GAP_FACTOR = 4;
export const PROBE_ACCEPT_NORM = 1e-8;
export const PROBE_AMBIGUITY_MARGIN = 1e-7;
export const PROBE_LIMIT_FACTOR = 4;
export const REPEAT_PROJECTOR_TOLERANCE = 1e-8;
export const EIGENSPACE_RESIDUAL_TOLERANCE = 1e-8;
export const GEOMETRY_SIGN_TIE_TOLERANCE = 1e-10;
export const COORDINATE_QUANTIZATION = 1e-10;
export const EIGENVALUE_DIGEST_QUANTIZATION = 1e-10;
/** Graphs at or below this order use the dense reference backend by default. Derived from
 * the dense solver's own ceiling (dense.ts size policy): the literal lives there only. */
export const GEOMETRY_DENSE_DEFAULT_MAX_N = DENSE_DEFAULT_MAX_N;

export type SpectralBackend = 'dense' | 'lanczos';
export type GeometryRefusalCode = 'ambiguous-eigenspace' | 'insufficient-rank' | 'solver-failure';

export interface SpectralGeometryOptions {
  readonly dimension: Dimension;
  readonly snapshotDigest: Digest;
  readonly domainDigest: Digest;
  readonly backend?: SpectralBackend;
  /** Passed to the Lanczos backend; the seed defaults to the domain digest. */
  readonly lanczos?: LanczosOptions;
  /** A projection-owned spectrum, already checked by its solver. Geometry independently
   * checks its residuals and orthogonality and uses it without another eigensolve. */
  readonly validatedBasis?: Eigenbasis;
  /** Local bases from the projection's single spectral solve, in component ledger order. */
  readonly componentBases?: readonly Eigenbasis[];
  readonly priorSolverFailure?: string;
  /** Internal component rank; public calls use the full requested dimension. */
  readonly axisCount?: number;
}

export interface GeometryClusterWitness {
  readonly ordinal: number;
  readonly eigenvalueMin: number;
  readonly eigenvalueMax: number;
  readonly multiplicity: number;
  readonly selectedAxes: number;
  readonly lowerGap: number;
  readonly upperGap: number | null;
  readonly probeOrdinals: readonly number[];
}

export interface SpectralSolverWitness {
  readonly backend: SpectralBackend;
  readonly solverVersion: string;
  readonly normEstimate: number;
  readonly relativeResidualMax: number | null;
  readonly orthogonalityDefect: number | null;
  readonly repeatProjectorDrift: number | null;
}

export interface SpectralGeometryCoordinates {
  readonly kind: 'coordinates';
  readonly algorithmVersion: string;
  readonly eigenspacePolicy: string;
  readonly dimension: Dimension;
  readonly axes: number;
  readonly nodeIds: readonly NodeId[];
  readonly loadedNodeIds: readonly NodeId[];
  readonly quantizationStep: number;
  readonly clusterTolerance: number;
  /** Quantised canonical columns, column-major n x axes. */
  readonly coordinates: Float64Array;
  readonly positions2?: Readonly<Partial<Record<NodeId, Vec2>>>;
  readonly positions3?: Readonly<Partial<Record<NodeId, Vec3>>>;
  readonly clusters: readonly GeometryClusterWitness[];
  readonly solver: SpectralSolverWitness;
  readonly resultDigest: Digest;
  readonly explanation: Explanation;
}

export interface SpectralGeometryRefusal {
  readonly kind: 'no-coordinates';
  readonly code: GeometryRefusalCode;
  readonly message: string;
  readonly algorithmVersion: string;
  readonly eigenspacePolicy: string;
  readonly dimension: Dimension;
  readonly axes: number;
  readonly nodeIds: readonly NodeId[];
  readonly loadedNodeIds: readonly NodeId[];
  readonly clusterTolerance: number;
  /** The eigenvalues the solver returned, ascending (the failed witness). */
  readonly eigenvalues: Float64Array;
  readonly solver: SpectralSolverWitness;
  readonly resultDigest: Digest;
  readonly explanation: Explanation;
}

export type SpectralGeometryOutcome = SpectralGeometryCoordinates | SpectralGeometryRefusal;

interface SolvedSpectrum {
  readonly eigenvalues: Float64Array;
  readonly eigenvectors: Float64Array;
  readonly count: number;
  readonly solverVersion: string;
  readonly normEstimate: number;
  readonly relativeResidualMax: number;
  readonly orthogonalityDefect: number;
}

interface Cluster {
  readonly start: number;
  readonly end: number;
}

function denseNormalized(graph: SpectralGraph): DenseEigenSolution {
  const values = new Float64Array(graph.size * graph.size);
  for (let row = 0; row < graph.size; row += 1) {
    values[row + row * graph.size] = graph.degrees[row] === 0 ? 0 : 1;
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1)
      values[row + graph.csrNeighbor[slot]! * graph.size] = -graph.csrWeight[slot]!;
  }
  return solveDenseSymmetricEigen({ n: graph.size, values });
}

/** Lanczos assumes constant component indicators are exact zero modes. Conjugate N by
 * a Householder map that sends the constant unit vector to sqrt(D)/sqrt(vol). The
 * returned vectors are mapped back to N's Euclidean-orthonormal coordinates. */
function normalizedLanczos(graph: SpectralGraph, options: LanczosOptions): ReturnType<typeof solveSpectrum> {
  const n = graph.size;
  const householder = new Float64Array(n);
  const volume = graph.degrees.reduce((sum, degree) => sum + degree, 0);
  if (volume > 0) {
    for (let i = 0; i < n; i += 1) householder[i] = 1 / Math.sqrt(n) - Math.sqrt(graph.degrees[i]! / volume);
    const length = norm2(householder);
    if (length > 1e-14) for (let i = 0; i < n; i += 1) householder[i] = householder[i]! / length;
    else householder.fill(0);
  }
  const transform = (x: Float64Array): Float64Array => {
    let projection = 0;
    for (let i = 0; i < n; i += 1) projection += householder[i]! * x[i]!;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i += 1) y[i] = x[i]! - 2 * projection * householder[i]!;
    return y;
  };
  const conjugated: SpectralGraph = { ...graph,
    applyLaplacian: (x: Float64Array): Float64Array => transform(graph.applyLaplacian(transform(x))),
  };
  const outcome = solveSpectrum(conjugated, options);
  if (outcome.kind === 'refusal') return outcome;
  const eigenvectors = new Float64Array(outcome.eigenvectors.length);
  for (let mode = 0; mode < outcome.eigenvalues.length; mode += 1)
    eigenvectors.set(transform(outcome.eigenvectors.subarray(mode * n, (mode + 1) * n)), mode * n);
  return { ...outcome, eigenvectors };
}

export interface NormalizedBasisSolve {
  readonly basis: Eigenbasis | null;
  readonly componentBases: readonly Eigenbasis[];
  readonly backend: SpectralBackend;
  readonly refusal: string | null;
  readonly restartsUsed: number | null;
}

/** One solve per attested component. The merged orthonormal u basis serves heat and
 * reconstruction; geometry converts these same u modes to Koren v = D^-1/2 u. */
export function solveNormalizedComponentBases(graph: SpectralGraph, options: LanczosOptions): NormalizedBasisSolve {
  const componentBases: Eigenbasis[] = [];
  let backend: SpectralBackend = 'dense';
  let restartsUsed: number | null = null;
  for (const component of graph.components) {
    const local = normalizedSpectralGraph(spectralComponentGraph(graph, component.memberIndices));
    if (local.size <= DENSE_DEFAULT_MAX_N) {
      componentBases.push(eigenbasisFromDense(denseNormalized(local)));
    } else {
      backend = 'lanczos';
      const outcome = normalizedLanczos(local, {
        ...options, k: Math.min(options.k ?? 24, local.size - 1),
        restartSize: Math.min(local.size - 1, Math.max(options.restartSize ?? 0,
          lanczosRestartSize(local.size - 1, options.k ?? 24), local.size >= 500 && (options.k ?? 24) >= 20 ? 320 : 0)),
      });
      if (outcome.kind === 'refusal') return { basis: null, componentBases: [], backend,
        refusal: `lanczos ${outcome.code} after ${String(outcome.restartsUsed)} restart(s): ${outcome.message}`,
        restartsUsed: outcome.restartsUsed };
      restartsUsed = Math.max(restartsUsed ?? 0, outcome.restartsUsed);
      componentBases.push(eigenbasisFromLanczos(outcome));
    }
  }
  const entries: { component: number; mode: number; value: number }[] = [];
  componentBases.forEach((basis, component) => {
    for (let mode = 0; mode < basis.count; mode += 1)
      entries.push({ component, mode, value: basis.eigenvalues[mode]! });
  });
  entries.sort((a, b) => (a.mode === 0 && b.mode !== 0 ? -1 : a.mode !== 0 && b.mode === 0 ? 1 : a.value - b.value)
    || a.component - b.component || a.mode - b.mode);
  const n = graph.size;
  const eigenvalues = new Float64Array(entries.length);
  const eigenvectors = new Float64Array(n * entries.length);
  for (const [column, entry] of entries.entries()) {
    const localBasis = componentBases[entry.component]!;
    eigenvalues[column] = entry.value;
    graph.components[entry.component]!.memberIndices.forEach((global, local) => {
      eigenvectors[column * n + global] = localBasis.eigenvectors[entry.mode * localBasis.n + local]!;
    });
  }
  return { basis: { algorithmVersion: componentBases.length === 1 ? componentBases[0]!.algorithmVersion : `${backend}-normalized-components-v1`, n, count: entries.length,
    eigenvalues, eigenvectors, complete: entries.length === n }, componentBases, backend, refusal: null, restartsUsed };
}

type SolveAttempt =
  | { readonly kind: 'solved'; readonly solved: SolvedSpectrum }
  | { readonly kind: 'solver-failure'; readonly message: string; readonly solverVersion: string; readonly relativeResidualMax: number | null };

function solveOnce(graph: SpectralGraph, backend: SpectralBackend, lanczos: LanczosOptions | undefined): SolveAttempt {
  if (backend === 'dense') {
    // A dense refusal above DENSE_DEFAULT_MAX_N (and any other dense refusal) is a typed
    // solver failure, never an escaping throw; no benchmark opt-in exists in production code.
    let solution: DenseEigenSolution;
    try {
      solution = denseNormalized(graph);
    } catch (error) {
      return {
        kind: 'solver-failure',
        message: `the dense backend refused: ${error instanceof Error ? error.message : String(error)}`,
        solverVersion: DENSE_SYMMETRIC_SOLVER_VERSION,
        relativeResidualMax: null,
      };
    }
    const lambdaMax = solution.n > 0 ? solution.eigenvalues[solution.n - 1]! : 0;
    return {
      kind: 'solved',
      solved: {
        eigenvalues: solution.eigenvalues,
        eigenvectors: solution.eigenvectors,
        count: solution.n,
        solverVersion: DENSE_SYMMETRIC_SOLVER_VERSION,
        normEstimate: lambdaMax,
        relativeResidualMax: solution.maxAbsResidual / Math.max(1, lambdaMax),
        orthogonalityDefect: solution.orthogonalityDefect,
      },
    };
  }
  const outcome = normalizedLanczos(graph, lanczos ?? {});
  if (outcome.kind === 'refusal') {
    return {
      kind: 'solver-failure',
      message: `the Lanczos backend refused (${outcome.code}): ${outcome.message}`,
      solverVersion: LANCZOS_SOLVER_VERSION,
      relativeResidualMax: outcome.maxRelativeResidual,
    };
  }
  return {
    kind: 'solved',
    solved: {
      eigenvalues: outcome.eigenvalues,
      eigenvectors: outcome.eigenvectors,
      count: outcome.eigenvalues.length,
      solverVersion: LANCZOS_SOLVER_VERSION,
      normEstimate: graph.spectralNormBound,
      relativeResidualMax: outcome.relativeResidualMax,
      orthogonalityDefect: outcome.orthogonalityDefect,
    },
  };
}

function boundaryTolerance(solved: SolvedSpectrum, upper: number): number {
  const lower = upper - 1;
  const left = Math.abs(solved.eigenvalues[lower] ?? 0);
  const right = Math.abs(solved.eigenvalues[upper] ?? 0);
  return CLUSTER_RELATIVE_TOLERANCE * Math.max(1, solved.normEstimate, left, right);
}

function buildClusters(solved: SolvedSpectrum): Cluster[] {
  const clusters: Cluster[] = [];
  let start = 0;
  for (let index = 1; index < solved.count; index += 1) {
    if (solved.eigenvalues[index]! - solved.eigenvalues[index - 1]! > boundaryTolerance(solved, index)) {
      clusters.push({ start, end: index });
      start = index;
    }
  }
  clusters.push({ start, end: solved.count });
  return clusters;
}

function probeColumn(graph: SpectralGraph, clusterOrdinal: number, probeOrdinal: number, snapshotDigest: Digest, domainDigest: Digest): Float64Array {
  const n = graph.size;
  // The only nontrivial mode of a two-node component is fixed by ID order;
  // Rademacher probes would miss it with probability 1/2 on every draw.
  if (n === 2 && probeOrdinal === 0) return Float64Array.of(1 / Math.SQRT2, -1 / Math.SQRT2);
  const column = new Float64Array(n);
  const scale = 1 / Math.sqrt(n);
  for (let index = 0; index < n; index += 1) {
    const hex = digestPayload([snapshotDigest, domainDigest, CANONICAL_EIGENSPACE_POLICY_VERSION, clusterOrdinal, probeOrdinal, graph.nodeIds[index]!]);
    column[index] = (parseInt(hex.slice(0, 1), 16) % 2 === 0 ? 1 : -1) * scale;
  }
  return column;
}

/** y = P probe = sum_{j in cluster} u_j (u_j^T probe). */
function projectThroughCluster(solved: SolvedSpectrum, cluster: Cluster, probe: Float64Array): Float64Array {
  const n = solved.eigenvectors.length / solved.count;
  const projected = new Float64Array(n);
  for (let mode = cluster.start; mode < cluster.end; mode += 1) {
    let coefficient = 0;
    const base = mode * n;
    for (let index = 0; index < n; index += 1) coefficient += solved.eigenvectors[base + index]! * probe[index]!;
    if (coefficient === 0) continue;
    for (let index = 0; index < n; index += 1) {
      projected[index] = projected[index]! + coefficient * solved.eigenvectors[base + index]!;
    }
  }
  return projected;
}

/** The exact action of L inside the cluster span: sum_{j in cluster} lambda_j u_j (u_j^T y). */
function applyClusterEigenvalueAction(solved: SolvedSpectrum, cluster: Cluster, y: Float64Array): Float64Array {
  const n = solved.eigenvectors.length / solved.count;
  const action = new Float64Array(n);
  for (let mode = cluster.start; mode < cluster.end; mode += 1) {
    let coefficient = 0;
    const base = mode * n;
    for (let index = 0; index < n; index += 1) coefficient += solved.eigenvectors[base + index]! * y[index]!;
    if (coefficient === 0) continue;
    const scaled = solved.eigenvalues[mode]! * coefficient;
    for (let index = 0; index < n; index += 1) {
      action[index] = action[index]! + scaled * solved.eigenvectors[base + index]!;
    }
  }
  return action;
}

/** ||P - P'||_F for two bases of the same cluster, summed entrywise. The trace identity
 * 2m - 2||U^T U'||_F^2 cancels catastrophically for identical bases, so the projectors are
 * formed entry by entry and differenced directly; each entry carries only O(eps) error. */
function projectorDrift(solved: SolvedSpectrum, repeated: SolvedSpectrum, cluster: Cluster): number {
  const n = solved.eigenvectors.length / solved.count;
  let frobeniusSquared = 0;
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      let difference = 0;
      for (let mode = cluster.start; mode < cluster.end; mode += 1) {
        difference +=
          solved.eigenvectors[row + mode * n]! * solved.eigenvectors[column + mode * n]! -
          repeated.eigenvectors[row + mode * n]! * repeated.eigenvectors[column + mode * n]!;
      }
      frobeniusSquared += difference * difference;
    }
  }
  return Math.sqrt(frobeniusSquared);
}

function scaleEigenvalue(value: number): number {
  return Math.round(value / EIGENVALUE_DIGEST_QUANTIZATION);
}

function formatList(values: readonly (number | string)[]): string {
  return values.join(',');
}

/** The declared no-coordinate state for a failed solve: no positions, no loaded IDs. */
function solverFailureState(
  graph: SpectralGraph,
  options: SpectralGeometryOptions,
  backend: SpectralBackend,
  attempt: { readonly message: string; readonly solverVersion: string; readonly relativeResidualMax: number | null },
  zeroThreshold: number,
): SpectralGeometryRefusal {
  const axes = options.dimension === '2d' ? 2 : 3;
  const resultDigest = digestPayload([
    SPECTRAL_GEOMETRY_VERSION,
    CANONICAL_EIGENSPACE_POLICY_VERSION,
    'no-coordinates',
    'solver-failure',
    options.snapshotDigest,
    options.domainDigest,
    options.dimension,
    axes,
    backend,
    attempt.solverVersion,
  ]);
  return {
    kind: 'no-coordinates',
    code: 'solver-failure',
    message: attempt.message,
    algorithmVersion: SPECTRAL_GEOMETRY_VERSION,
    eigenspacePolicy: CANONICAL_EIGENSPACE_POLICY_VERSION,
    dimension: options.dimension,
    axes,
    nodeIds: graph.nodeIds,
    loadedNodeIds: [],
    clusterTolerance: zeroThreshold,
    eigenvalues: new Float64Array(0),
    solver: {
      backend,
      solverVersion: attempt.solverVersion,
      normEstimate: graph.spectralNormBound,
      relativeResidualMax: attempt.relativeResidualMax,
      orthogonalityDefect: null,
      repeatProjectorDrift: null,
    },
    resultDigest,
    explanation: {
      elementId: 'holographic-spectral-geometry',
      elementKind: 'field',
      summary: `No spectral coordinates: ${attempt.message}`,
      sourceIds: [],
      parameterIds: [options.snapshotDigest, options.domainDigest, CANONICAL_EIGENSPACE_POLICY_VERSION],
      numericalWitness: {
        code: 'solver-failure',
        axes,
        backend,
        tolerance: zeroThreshold,
        maxRelativeResidual: attempt.relativeResidualMax === null ? 'n/a' : attempt.relativeResidualMax,
        resultDigest,
      },
      limitation: 'The eigensolver failed its convergence or orthogonality witness; no coordinate claim is made.',
    },
  };
}

function spectralGeometryBlock(graph: SpectralGraph, options: SpectralGeometryOptions): SpectralGeometryOutcome {
  const n = graph.size;
  const axes = options.axisCount ?? (options.dimension === '2d' ? 2 : 3);
  const backend = options.backend ?? (n <= GEOMETRY_DENSE_DEFAULT_MAX_N ? 'dense' : 'lanczos');
  const lanczos: LanczosOptions = { ...options.lanczos, seed: options.lanczos?.seed ?? options.domainDigest };
  const zeroThreshold = CLUSTER_RELATIVE_TOLERANCE * Math.max(1, graph.spectralNormBound);

  if (options.priorSolverFailure !== undefined) {
    return solverFailureState(graph, options, backend, {
      message: options.priorSolverFailure,
      solverVersion: backend === 'dense' ? DENSE_SYMMETRIC_SOLVER_VERSION : LANCZOS_SOLVER_VERSION,
      relativeResidualMax: null,
    }, zeroThreshold);
  }
  let attempt: SolveAttempt;
  if (options.validatedBasis !== undefined) {
    const basis = options.validatedBasis;
    let worst = 0;
    const scale = Math.max(1, graph.spectralNormBound);
    if (basis.n !== n || basis.count < graph.componentCount ||
        basis.eigenvalues.length !== basis.count || basis.eigenvectors.length !== n * basis.count) {
      return solverFailureState(graph, options, backend, {
        message: 'the supplied spectrum has incompatible dimensions', solverVersion: basis.algorithmVersion, relativeResidualMax: null,
      }, zeroThreshold);
    }
    const columns: Float64Array[] = [];
    for (let mode = 0; mode < basis.count; mode += 1) {
      const vector = basis.eigenvectors.subarray(mode * n, (mode + 1) * n);
      const product = graph.applyLaplacian(vector);
      for (let row = 0; row < n; row += 1) product[row] = product[row]! - basis.eigenvalues[mode]! * vector[row]!;
      worst = Math.max(worst, norm2(product) / scale);
      columns.push(vector);
    }
    const defect = orthogonalityDefect(columns);
    if (worst > EIGENSPACE_RESIDUAL_TOLERANCE || defect > EIGENSPACE_RESIDUAL_TOLERANCE) {
      return solverFailureState(graph, options, backend, {
        message: `the supplied spectrum failed geometry validation (relative residual ${worst}, orthogonality ${defect})`,
        solverVersion: basis.algorithmVersion, relativeResidualMax: worst,
      }, zeroThreshold);
    }
    attempt = { kind: 'solved', solved: {
      eigenvalues: basis.eigenvalues, eigenvectors: basis.eigenvectors, count: basis.count,
      solverVersion: basis.algorithmVersion, normEstimate: graph.spectralNormBound,
      relativeResidualMax: worst, orthogonalityDefect: defect,
    } };
  } else attempt = solveOnce(graph, backend, lanczos);
  if (attempt.kind === 'solver-failure') {
    return solverFailureState(graph, options, backend, attempt, zeroThreshold);
  }
  const solved = attempt.solved;
  const clusters = buildClusters(solved);

  const refuse = (code: GeometryRefusalCode, message: string, tolerance: number): SpectralGeometryRefusal => {
    const eigenvaluesScaled: number[] = [];
    for (const value of solved.eigenvalues) eigenvaluesScaled.push(scaleEigenvalue(value));
    const resultDigest = digestPayload([
      SPECTRAL_GEOMETRY_VERSION,
      CANONICAL_EIGENSPACE_POLICY_VERSION,
      'no-coordinates',
      code,
      options.snapshotDigest,
      options.domainDigest,
      options.dimension,
      axes,
      backend,
      solved.solverVersion,
      eigenvaluesScaled,
    ]);
    return {
      kind: 'no-coordinates',
      code,
      message,
      algorithmVersion: SPECTRAL_GEOMETRY_VERSION,
      eigenspacePolicy: CANONICAL_EIGENSPACE_POLICY_VERSION,
      dimension: options.dimension,
      axes,
      nodeIds: graph.nodeIds,
      loadedNodeIds: [],
      clusterTolerance: tolerance,
      eigenvalues: solved.eigenvalues,
      solver: {
        backend,
        solverVersion: solved.solverVersion,
        normEstimate: solved.normEstimate,
        relativeResidualMax: solved.relativeResidualMax,
        orthogonalityDefect: solved.orthogonalityDefect,
        repeatProjectorDrift: null,
      },
      resultDigest,
      explanation: {
        elementId: 'holographic-spectral-geometry',
        elementKind: 'field',
        summary: `No spectral coordinates: ${message}`,
        sourceIds: [],
        parameterIds: [options.snapshotDigest, options.domainDigest, CANONICAL_EIGENSPACE_POLICY_VERSION],
        numericalWitness: {
          code,
          axes,
          backend,
          clusterEigenvalues: formatList(eigenvaluesScaled),
          tolerance,
          componentCount: graph.componentCount,
          resultDigest,
        },
        limitation: 'No position-dependent visual is defined in this state; no fallback layout exists.',
      },
    };
  };

  // The zero-eigenvalue cluster (the whole component cluster, |lambda| <= tau) is skipped.
  let firstNonzero = 0;
  const firstCluster = clusters[0]!;
  if (Math.abs(solved.eigenvalues[firstCluster.end - 1]!) <= zeroThreshold) {
    firstNonzero = 1;
  }

  const retained: Cluster[] = [];
  let cumulative = 0;
  for (let ordinal = firstNonzero; ordinal < clusters.length; ordinal += 1) {
    const cluster = clusters[ordinal]!;
    const previous = clusters[ordinal - 1]!;
    const gap = solved.eigenvalues[cluster.start]! - solved.eigenvalues[previous.end - 1]!;
    const gapTolerance = boundaryTolerance(solved, cluster.start);
    if (gap <= CLUSTER_GAP_FACTOR * gapTolerance) {
      return refuse(
        'ambiguous-eigenspace',
        `the gap ${gap.toExponential(3)} between eigenvalue clusters at indices ${String(previous.end - 1)}/${String(cluster.start)} does not exceed ${String(CLUSTER_GAP_FACTOR)} tau = ${(CLUSTER_GAP_FACTOR * gapTolerance).toExponential(3)}; no cluster boundary may be chosen here`,
        gapTolerance,
      );
    }
    retained.push(cluster);
    cumulative += Math.min(axes - cumulative, cluster.end - cluster.start);
    if (cumulative === axes) {
      if (cluster.end < solved.count) {
        const upperGap = solved.eigenvalues[cluster.end]! - solved.eigenvalues[cluster.end - 1]!;
        const upperTolerance = boundaryTolerance(solved, cluster.end);
        if (upperGap <= CLUSTER_GAP_FACTOR * upperTolerance) {
          return refuse('ambiguous-eigenspace',
            `the upper gap ${upperGap.toExponential(3)} of the selected cluster does not exceed ${String(CLUSTER_GAP_FACTOR)} tau = ${(CLUSTER_GAP_FACTOR * upperTolerance).toExponential(3)}`,
            upperTolerance);
        }
      } else if (solved.count < n) {
        return refuse('ambiguous-eigenspace',
          `the selected cluster ends at the last of ${String(solved.count)} partial-spectrum modes; its full multiplicity and upper gap cannot be certified`,
          boundaryTolerance(solved, cluster.start));
      }
      break;
    }
  }
  if (cumulative < axes) {
    return refuse(
      'insufficient-rank',
      `only ${String(cumulative)} nonzero cluster dimensions are available for the requested ${String(axes)} axes${backend === 'lanczos' ? ` within the ${String(solved.count - graph.componentCount)} solved nontrivial modes` : ''}`,
      zeroThreshold,
    );
  }

  // Canonical projector-probe columns, cluster by cluster, probe ordinal by probe ordinal.
  const chosen: Float64Array[] = [];
  const witnesses: GeometryClusterWitness[] = [];
  const probeOrdinalLimit = PROBE_LIMIT_FACTOR * n;
  let selected = 0;
  for (const [ordinalOffset, cluster] of retained.entries()) {
    const clusterOrdinal = firstNonzero + ordinalOffset;
    const multiplicity = cluster.end - cluster.start;
    const selectedAxes = Math.min(axes - selected, multiplicity);
    const probeOrdinals: number[] = [];
    for (let probeOrdinal = 0; probeOrdinal < probeOrdinalLimit && probeOrdinals.length < selectedAxes; probeOrdinal += 1) {
      const probe = probeColumn(graph, clusterOrdinal, probeOrdinal, options.snapshotDigest, options.domainDigest);
      const candidate = projectThroughCluster(solved, cluster, probe);
      const norm = modifiedGramSchmidtTwice(candidate, chosen);
      if (norm <= PROBE_ACCEPT_NORM) continue;
      if (norm <= PROBE_ACCEPT_NORM + PROBE_AMBIGUITY_MARGIN) {
        return refuse(
          'ambiguous-eigenspace',
          `probe ${String(probeOrdinal)} of cluster ${String(clusterOrdinal)} has reorthogonalised norm ${norm.toExponential(3)} within ${String(PROBE_AMBIGUITY_MARGIN)} of the acceptance threshold ${String(PROBE_ACCEPT_NORM)}; the pivot is numerically ambiguous`,
          boundaryTolerance(solved, cluster.start),
        );
      }
      for (let index = 0; index < n; index += 1) candidate[index] = candidate[index]! / norm;
      const pivot = largestEntryIndex(candidate, GEOMETRY_SIGN_TIE_TOLERANCE);
      if (candidate[pivot]! < 0) {
        for (let index = 0; index < n; index += 1) candidate[index] = -candidate[index]!;
      }
      chosen.push(candidate);
      probeOrdinals.push(probeOrdinal);
    }
    if (probeOrdinals.length < selectedAxes) {
      return refuse(
        'insufficient-rank',
        `cluster ${String(clusterOrdinal)} produced only ${String(probeOrdinals.length)}/${String(selectedAxes)} independent probe columns within ${String(probeOrdinalLimit)} probes; the probe projection is degenerate`,
        boundaryTolerance(solved, cluster.start),
      );
    }
    witnesses.push({
      ordinal: clusterOrdinal,
      eigenvalueMin: solved.eigenvalues[cluster.start]!,
      eigenvalueMax: solved.eigenvalues[cluster.end - 1]!,
      multiplicity,
      selectedAxes,
      lowerGap: solved.eigenvalues[cluster.start]! - solved.eigenvalues[clusters[clusterOrdinal - 1]!.end - 1]!,
      upperGap: cluster.end < solved.count ? solved.eigenvalues[cluster.end]! - solved.eigenvalues[cluster.end - 1]! : null,
      probeOrdinals,
    });
    selected += selectedAxes;
  }

  // Residual, orthogonality and repeat-solve projector checks on the assembled geometry.
  const residualScale = Math.max(1, solved.normEstimate);
  let checkedColumn = 0;
  for (const [ordinalOffset, cluster] of retained.entries()) {
    for (let local = 0; local < witnesses[ordinalOffset]!.selectedAxes; local += 1) {
      const column = chosen[checkedColumn++]!;
      const action = applyClusterEigenvalueAction(solved, cluster, column);
      const product = graph.applyLaplacian(column);
      for (let index = 0; index < n; index += 1) product[index] = product[index]! - action[index]!;
      if (norm2(product) > EIGENSPACE_RESIDUAL_TOLERANCE * residualScale) {
        return refuse(
          'solver-failure',
          `a geometry column of cluster ${String(firstNonzero + ordinalOffset)} failed its eigenspace residual check (${norm2(product).toExponential(3)} > ${String(EIGENSPACE_RESIDUAL_TOLERANCE)} scale)`,
          boundaryTolerance(solved, cluster.start),
        );
      }
    }
  }
  const defect = orthogonalityDefect(chosen);
  if (defect > EIGENSPACE_RESIDUAL_TOLERANCE) {
    return refuse('solver-failure', `geometry column orthogonality defect ${defect.toExponential(3)} exceeds ${String(EIGENSPACE_RESIDUAL_TOLERANCE)}`, zeroThreshold);
  }
  let drift: number | null = options.validatedBasis === undefined ? 0 : null;
  if (options.validatedBasis === undefined) {
    const repeatAttempt = solveOnce(graph, backend, lanczos);
    if (repeatAttempt.kind === 'solver-failure') return solverFailureState(graph, options, backend, repeatAttempt, zeroThreshold);
    for (const cluster of retained) drift = Math.max(drift!, projectorDrift(solved, repeatAttempt.solved, cluster));
  }
  if (drift !== null && drift > REPEAT_PROJECTOR_TOLERANCE) {
    return refuse('solver-failure', `the repeat solve moved a retained projector by ${drift.toExponential(3)} > ${String(REPEAT_PROJECTOR_TOLERANCE)}`, zeroThreshold);
  }

  // Koren coordinates v = D^-1/2 u. The component is centred by its axis
  // midranges and scaled to unit maximum extent; this is a visual affine map
  // applied after the genuine generalized eigensystem is solved.
  const raw = chosen.map(column => Float64Array.from(column, (value, index) =>
    graph.degrees[index]! > 0 ? value / Math.sqrt(graph.degrees[index]!) : 0));
  let maxExtent = 0;
  const centers: number[] = [];
  for (const column of raw) {
    const low = minOf(column);
    const high = maxOf(column);
    centers.push((low + high) / 2);
    maxExtent = Math.max(maxExtent, high - low);
  }
  const displayScale = maxExtent > 0 ? 1 / maxExtent : 1;

  // Fixed 1e-10 quantisation precedes the result digest.
  const coordinates = new Float64Array(n * axes);
  const grid: number[][] = [];
  for (let axis = 0; axis < axes; axis += 1) {
    const column = chosen[axis]!;
    const axisGrid: number[] = [];
    for (let index = 0; index < n; index += 1) {
      const units = Math.round(((raw[axis]![index]! - centers[axis]!) * displayScale) / COORDINATE_QUANTIZATION);
      axisGrid.push(units);
      coordinates[index + axis * n] = units * COORDINATE_QUANTIZATION;
    }
    grid.push(axisGrid);
  }

  const positions2: Partial<Record<NodeId, Vec2>> = {};
  const positions3: Partial<Record<NodeId, Vec3>> = {};
  for (let index = 0; index < n; index += 1) {
    const id = graph.nodeIds[index]!;
    if (options.dimension === '2d') {
      positions2[id] = { x: coordinates[index]!, y: axes > 1 ? coordinates[index + n]! : 0 };
    } else {
      positions3[id] = { x: coordinates[index]!, y: axes > 1 ? coordinates[index + n]! : 0, z: axes > 2 ? coordinates[index + 2 * n]! : 0 };
    }
  }

  const resultDigest = digestPayload([
    SPECTRAL_GEOMETRY_VERSION,
    CANONICAL_EIGENSPACE_POLICY_VERSION,
    'coordinates',
    options.snapshotDigest,
    options.domainDigest,
    options.dimension,
    axes,
    backend,
    solved.solverVersion,
    grid,
    witnesses.map((witness) => [
      witness.ordinal,
      scaleEigenvalue(witness.eigenvalueMin),
      scaleEigenvalue(witness.eigenvalueMax),
      witness.multiplicity,
      witness.selectedAxes,
      scaleEigenvalue(witness.lowerGap),
      witness.upperGap === null ? null : scaleEigenvalue(witness.upperGap),
      witness.probeOrdinals,
    ]),
  ]);

  const tolerance = boundaryTolerance(solved, retained[0]!.start);

  return {
    kind: 'coordinates',
    algorithmVersion: SPECTRAL_GEOMETRY_VERSION,
    eigenspacePolicy: CANONICAL_EIGENSPACE_POLICY_VERSION,
    dimension: options.dimension,
    axes,
    nodeIds: graph.nodeIds,
    loadedNodeIds: graph.nodeIds,
    quantizationStep: COORDINATE_QUANTIZATION,
    clusterTolerance: tolerance,
    coordinates,
    ...(options.dimension === '2d' ? { positions2 } : { positions3 }),
    clusters: witnesses,
    solver: {
      backend,
      solverVersion: solved.solverVersion,
      normEstimate: solved.normEstimate,
      relativeResidualMax: solved.relativeResidualMax,
      orthogonalityDefect: solved.orthogonalityDefect,
      repeatProjectorDrift: drift,
    },
    resultDigest,
    explanation: {
      elementId: 'holographic-spectral-geometry',
      elementKind: 'field',
      summary:
        `Canonical spectral ${options.dimension} geometry from ${String(witnesses.length)} isolated eigenvalue cluster(s) ` +
        `of the attested degree-normalised Laplacian N = D^-1/2 L D^-1/2 (${CANONICAL_EIGENSPACE_POLICY_VERSION}); ` +
        `Koren coordinates v = D^-1/2 u solve L v = lambda D v; assi scelti per convenzione canonica dentro un autospazio degenere. ` +
        `Each component is centred and scaled to unit maximum extent; coordinates are quantised to 1e-10`,
      sourceIds: [],
      parameterIds: [options.snapshotDigest, options.domainDigest, CANONICAL_EIGENSPACE_POLICY_VERSION],
      numericalWitness: {
        axes,
        backend,
        solverVersion: solved.solverVersion,
        clusterTolerance: tolerance,
        clusters: formatList(witnesses.map((witness) => `${witness.eigenvalueMin.toExponential(6)}x${String(witness.multiplicity)}`)),
        selectedAxes: formatList(witnesses.map((witness) => witness.selectedAxes)),
        clusterGaps: formatList(witnesses.map((witness) => `${witness.lowerGap.toExponential(3)}/${witness.upperGap === null ? 'spectrum-end' : witness.upperGap.toExponential(3)}`)),
        probeOrdinals: formatList(witnesses.flatMap((witness) => witness.probeOrdinals)),
        relativeResidualMax: solved.relativeResidualMax,
        orthogonalityDefect: solved.orthogonalityDefect,
        repeatProjectorDrift: drift ?? 'not repeated: projection-owned validated basis',
        quantization: '1e-10',
        normalization: 'N=D^-1/2 L D^-1/2; v=D^-1/2 u',
        componentScale: displayScale,
        resultDigest,
      },
      limitation: 'Spectral coordinates are a visual projection of graph features; axis orientation inside a tied eigenspace follows the deterministic probe policy and carries no semantic-edge meaning.',
    },
  };
}

/** Components are ordered by descending size, then smallest codepoint node ID. Each
 * occupies a unit-wide cell on x, with a 0.5-unit empty gutter. This ordering and
 * spacing depend only on the attested analytical domain. */
export function spectralGeometry(graph: SpectralGraph, options: SpectralGeometryOptions): SpectralGeometryOutcome {
  if (options.priorSolverFailure !== undefined) {
    const backend = options.backend ?? (graph.size <= DENSE_DEFAULT_MAX_N ? 'dense' : 'lanczos');
    return solverFailureState(graph, options, backend, {
      message: options.priorSolverFailure,
      solverVersion: backend === 'dense' ? DENSE_SYMMETRIC_SOLVER_VERSION : LANCZOS_SOLVER_VERSION,
      relativeResidualMax: null,
    }, CLUSTER_RELATIVE_TOLERANCE * Math.max(1, graph.spectralNormBound));
  }
  if (graph.componentCount === 1)
    return spectralGeometryBlock(normalizedSpectralGraph(graph), options);
  const axes = options.dimension === '2d' ? 2 : 3;
  const ordered = [...graph.components].sort((a, b) => b.memberIndices.length - a.memberIndices.length ||
    (a.smallestNodeId < b.smallestNodeId ? -1 : a.smallestNodeId > b.smallestNodeId ? 1 : 0));
  const coordinates = new Float64Array(graph.size * axes);
  const clusters: GeometryClusterWitness[] = [];
  const localDigests: string[] = [];
  let relativeResidualMax = 0;
  let orthogonality = 0;
  let normEstimate = 0;
  let solverVersion = '';
  let backend: SpectralBackend = 'dense';
  let tolerance = 0;
  for (const [place, component] of ordered.entries()) {
    const localGraph = spectralComponentGraph(graph, component.memberIndices);
    const localAxes = Math.min(axes, localGraph.size - 1);
    const center = place * 1.5;
    if (localAxes === 0) {
      coordinates[component.memberIndices[0]!] = center;
      localDigests.push(`singleton:${component.smallestNodeId}`);
      continue;
    }
    const local = spectralGeometryBlock(normalizedSpectralGraph(localGraph), {
      ...options, axisCount: localAxes,
      ...(options.componentBases === undefined ? {} : { validatedBasis: options.componentBases[component.index] }),
      domainDigest: digestPayload([options.domainDigest, 'component', component.smallestNodeId]),
    });
    if (local.kind === 'no-coordinates') {
      return { ...local, nodeIds: graph.nodeIds, resultDigest: digestPayload([
        SPECTRAL_GEOMETRY_VERSION, options.domainDigest, 'component-refusal', component.smallestNodeId, local.resultDigest,
      ]), explanation: { ...local.explanation,
        summary: `Component ${component.smallestNodeId} refused spectral coordinates: ${local.message}`,
      } };
    }
    localDigests.push(local.resultDigest);
    appendAll(clusters, local.clusters);
    relativeResidualMax = Math.max(relativeResidualMax, local.solver.relativeResidualMax ?? 0);
    orthogonality = Math.max(orthogonality, local.solver.orthogonalityDefect ?? 0);
    normEstimate = Math.max(normEstimate, local.solver.normEstimate);
    if (solverVersion === '' || local.solver.backend === 'lanczos') solverVersion = local.solver.solverVersion;
    backend = local.solver.backend === 'lanczos' ? 'lanczos' : backend;
    tolerance = Math.max(tolerance, local.clusterTolerance);
    for (const [localIndex, globalIndex] of component.memberIndices.entries()) {
      coordinates[globalIndex] = Math.round((center + local.coordinates[localIndex]!) / COORDINATE_QUANTIZATION) * COORDINATE_QUANTIZATION;
      for (let axis = 1; axis < axes; axis += 1)
        coordinates[axis * graph.size + globalIndex] = axis < localAxes ? local.coordinates[axis * localGraph.size + localIndex]! : 0;
    }
  }
  const positions2: Partial<Record<NodeId, Vec2>> = {};
  const positions3: Partial<Record<NodeId, Vec3>> = {};
  for (let index = 0; index < graph.size; index += 1) {
    const id = graph.nodeIds[index]!;
    const x = coordinates[index]!;
    const y = coordinates[graph.size + index]!;
    if (axes === 2) positions2[id] = { x, y };
    else positions3[id] = { x, y, z: coordinates[2 * graph.size + index]! };
  }
  const resultDigest = digestPayload([SPECTRAL_GEOMETRY_VERSION, CANONICAL_EIGENSPACE_POLICY_VERSION,
    options.snapshotDigest, options.domainDigest, options.dimension, 'size-desc-id-asc', 'gap=0.5',
    ordered.map(component => component.smallestNodeId), localDigests,
    Array.from(coordinates, value => Math.round(value / COORDINATE_QUANTIZATION))]);
  return {
    kind: 'coordinates', algorithmVersion: SPECTRAL_GEOMETRY_VERSION,
    eigenspacePolicy: CANONICAL_EIGENSPACE_POLICY_VERSION, dimension: options.dimension,
    axes, nodeIds: graph.nodeIds, loadedNodeIds: graph.nodeIds, quantizationStep: COORDINATE_QUANTIZATION,
    clusterTolerance: tolerance, coordinates, ...(axes === 2 ? { positions2 } : { positions3 }),
    clusters, solver: { backend, solverVersion, normEstimate, relativeResidualMax,
      orthogonalityDefect: orthogonality, repeatProjectorDrift: options.componentBases === undefined ? 0 : null },
    resultDigest,
    explanation: {
      elementId: 'holographic-spectral-geometry', elementKind: 'field',
      summary: `Attested components have independent degree-normalised Laplacian spectra: N = D^-1/2 L D^-1/2, ` +
        `Koren v = D^-1/2 u solves L v = lambda D v. Components are packed by descending size then smallest ID, ` +
        `in unit-wide x cells with a 0.5-unit gutter; each is centred and scaled to unit maximum extent. ` +
        `Tied modes use ${CANONICAL_EIGENSPACE_POLICY_VERSION}; assi scelti per convenzione canonica dentro un autospazio degenere.`,
      sourceIds: [], parameterIds: [options.snapshotDigest, options.domainDigest, CANONICAL_EIGENSPACE_POLICY_VERSION],
      numericalWitness: { axes, componentCount: ordered.length, order: ordered.map(component => component.smallestNodeId).join(','),
        gap: 0.5, normalization: 'N=D^-1/2 L D^-1/2; v=D^-1/2 u',
        selectedAxes: clusters.map(cluster => cluster.selectedAxes).join(','), resultDigest },
      limitation: 'Packing and axis orientations are deterministic visual conventions; they do not add semantic edges.',
    },
  };
}
