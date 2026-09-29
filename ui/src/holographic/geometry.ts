/** D-073 tranche F, row F8 — spectral 2D/3D geometry under the deterministic tied-eigenspace
 * policy `projector-probe-v1`.
 *
 * Domain node IDs are sorted by codepoint and connected components are ordered by smallest
 * ID (both fixed by holographic/adjacency.ts). The symmetric Laplacian is solved with the
 * dense reference solver (small graphs, exact ||L||_2 from lambda_max) or the bounded
 * restarted Lanczos solver (Gershgorin norm estimate). Eigenvalues ascend and are clustered:
 * adjacent values within tau = 1e-8 max(1, ||L||_2, |lambda_i|, |lambda_{i+1}|) share a
 * cluster, a gap to either neighbouring cluster must exceed 4 tau, and the whole
 * zero-eigenvalue cluster is skipped. Whole nonzero clusters are included in increasing
 * order until their cumulative multiplicity equals the requested 2/3-axis count; crossing it
 * refuses `no-coordinates/ambiguous-eigenspace`, running out of nonzero modes refuses
 * `no-coordinates/insufficient-rank` — a cluster is never split.
 *
 * Each retained cluster contributes its orthogonal projector P = U U^T through SHA-256 probe
 * columns with entries +-1/sqrt(n) derived from (snapshotDigest, domainDigest, cluster
 * ordinal, probe ordinal, node ID, projector-probe-v1). The smallest probe ordinal whose
 * reorthogonalised norm exceeds 1e-8 is chosen (a pivot within 1e-7 of that threshold
 * refuses), then modified Gram-Schmidt is applied twice against every previously chosen
 * column, and each column's sign is fixed so its largest-absolute entry (ties by smallest
 * node ID) is positive. Rank deficiency after 4n probes, a projector drift over 1e-8 under a
 * repeat solve, or a failed residual/orthogonality check refuses with a typed code. The
 * canonical columns are quantised to 1e-10 before the result digest; every refusal returns
 * empty loaded IDs and no positions, never a fallback layout. */

import { digestPayload } from '../engine/digest.ts';
import type { Dimension, Digest, Explanation, NodeId, Vec2, Vec3 } from '../projection/contract-types.ts';
import type { SpectralGraph } from './adjacency.ts';
import { DENSE_SYMMETRIC_SOLVER_VERSION, denseLaplacian, solveDenseSymmetricEigen } from './dense.ts';
import { LANCZOS_SOLVER_VERSION, solveSpectrum, type LanczosOptions } from './lanczos.ts';
import { largestEntryIndex, modifiedGramSchmidtTwice, norm2, orthogonalityDefect } from './linear-algebra.ts';

export const SPECTRAL_GEOMETRY_VERSION = 'holographic-geometry-v1';
export const EIGENSPACE_POLICY_VERSION = 'projector-probe-v1';
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
/** Graphs at or below this order use the dense reference backend by default. */
export const GEOMETRY_DENSE_DEFAULT_MAX_N = 200;

export type SpectralBackend = 'dense' | 'lanczos';
export type GeometryRefusalCode = 'ambiguous-eigenspace' | 'insufficient-rank' | 'solver-failure';

export interface SpectralGeometryOptions {
  readonly dimension: Dimension;
  readonly snapshotDigest: Digest;
  readonly domainDigest: Digest;
  readonly backend?: SpectralBackend;
  /** Passed to the Lanczos backend; the seed defaults to the domain digest. */
  readonly lanczos?: LanczosOptions;
}

export interface GeometryClusterWitness {
  readonly ordinal: number;
  readonly eigenvalueMin: number;
  readonly eigenvalueMax: number;
  readonly multiplicity: number;
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

type SolveAttempt =
  | { readonly kind: 'solved'; readonly solved: SolvedSpectrum }
  | { readonly kind: 'solver-failure'; readonly message: string; readonly solverVersion: string; readonly relativeResidualMax: number | null };

function solveOnce(graph: SpectralGraph, backend: SpectralBackend, lanczos: LanczosOptions | undefined): SolveAttempt {
  if (backend === 'dense') {
    const solution = solveDenseSymmetricEigen(denseLaplacian(graph));
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
  const outcome = solveSpectrum(graph, lanczos);
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
  const column = new Float64Array(n);
  const scale = 1 / Math.sqrt(n);
  for (let index = 0; index < n; index += 1) {
    const hex = digestPayload([snapshotDigest, domainDigest, EIGENSPACE_POLICY_VERSION, clusterOrdinal, probeOrdinal, graph.nodeIds[index]!]);
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
    EIGENSPACE_POLICY_VERSION,
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
    eigenspacePolicy: EIGENSPACE_POLICY_VERSION,
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
      parameterIds: [options.snapshotDigest, options.domainDigest, EIGENSPACE_POLICY_VERSION],
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

export function spectralGeometry(graph: SpectralGraph, options: SpectralGeometryOptions): SpectralGeometryOutcome {
  const n = graph.size;
  const axes = options.dimension === '2d' ? 2 : 3;
  const backend = options.backend ?? (n <= GEOMETRY_DENSE_DEFAULT_MAX_N ? 'dense' : 'lanczos');
  const lanczos: LanczosOptions = { ...options.lanczos, seed: options.lanczos?.seed ?? options.domainDigest };
  const zeroThreshold = CLUSTER_RELATIVE_TOLERANCE * Math.max(1, graph.spectralNormBound);

  const attempt = solveOnce(graph, backend, lanczos);
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
      EIGENSPACE_POLICY_VERSION,
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
      eigenspacePolicy: EIGENSPACE_POLICY_VERSION,
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
        parameterIds: [options.snapshotDigest, options.domainDigest, EIGENSPACE_POLICY_VERSION],
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
    const multiplicity = cluster.end - cluster.start;
    if (cumulative + multiplicity > axes) {
      return refuse(
        'ambiguous-eigenspace',
        `including the whole eigenvalue cluster [${solved.eigenvalues[cluster.start]!.toExponential(3)}, ${solved.eigenvalues[cluster.end - 1]!.toExponential(3)}] of multiplicity ${String(multiplicity)} would cross the requested ${String(axes)}-axis count (${String(cumulative)} + ${String(multiplicity)}); a tied eigenspace is never split`,
        boundaryTolerance(solved, cluster.start),
      );
    }
    retained.push(cluster);
    cumulative += multiplicity;
    if (cumulative === axes) break;
  }
  if (cumulative < axes) {
    return refuse(
      'insufficient-rank',
      `only ${String(cumulative)} nonzero cluster dimensions are available for the requested ${String(axes)} axes${backend === 'lanczos' ? ` within the ${String(solved.count - graph.componentCount)} solved nontrivial modes` : ''}; whole clusters never split`,
      zeroThreshold,
    );
  }

  // Canonical projector-probe columns, cluster by cluster, probe ordinal by probe ordinal.
  const chosen: Float64Array[] = [];
  const witnesses: GeometryClusterWitness[] = [];
  const probeOrdinalLimit = PROBE_LIMIT_FACTOR * n;
  for (const [ordinalOffset, cluster] of retained.entries()) {
    const clusterOrdinal = firstNonzero + ordinalOffset;
    const multiplicity = cluster.end - cluster.start;
    const probeOrdinals: number[] = [];
    for (let probeOrdinal = 0; probeOrdinal < probeOrdinalLimit && probeOrdinals.length < multiplicity; probeOrdinal += 1) {
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
    if (probeOrdinals.length < multiplicity) {
      return refuse(
        'insufficient-rank',
        `cluster ${String(clusterOrdinal)} produced only ${String(probeOrdinals.length)}/${String(multiplicity)} independent probe columns within ${String(probeOrdinalLimit)} probes; the projector rank is deficient`,
        boundaryTolerance(solved, cluster.start),
      );
    }
    witnesses.push({
      ordinal: clusterOrdinal,
      eigenvalueMin: solved.eigenvalues[cluster.start]!,
      eigenvalueMax: solved.eigenvalues[cluster.end - 1]!,
      multiplicity,
      probeOrdinals,
    });
  }

  // Residual, orthogonality and repeat-solve projector checks on the assembled geometry.
  const residualScale = Math.max(1, solved.normEstimate);
  for (const [ordinalOffset, cluster] of retained.entries()) {
    const column = chosen[ordinalOffset]!;
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
  const defect = orthogonalityDefect(chosen);
  if (defect > EIGENSPACE_RESIDUAL_TOLERANCE) {
    return refuse('solver-failure', `geometry column orthogonality defect ${defect.toExponential(3)} exceeds ${String(EIGENSPACE_RESIDUAL_TOLERANCE)}`, zeroThreshold);
  }
  const repeatAttempt = solveOnce(graph, backend, lanczos);
  if (repeatAttempt.kind === 'solver-failure') {
    return solverFailureState(graph, options, backend, repeatAttempt, zeroThreshold);
  }
  let drift = 0;
  for (const cluster of retained) drift = Math.max(drift, projectorDrift(solved, repeatAttempt.solved, cluster));
  if (drift > REPEAT_PROJECTOR_TOLERANCE) {
    return refuse('solver-failure', `the repeat solve moved a retained projector by ${drift.toExponential(3)} > ${String(REPEAT_PROJECTOR_TOLERANCE)}`, zeroThreshold);
  }

  // Fixed 1e-10 quantisation precedes the result digest.
  const coordinates = new Float64Array(n * axes);
  const grid: number[][] = [];
  for (let axis = 0; axis < axes; axis += 1) {
    const column = chosen[axis]!;
    const axisGrid: number[] = [];
    for (let index = 0; index < n; index += 1) {
      const units = Math.round(column[index]! / COORDINATE_QUANTIZATION);
      axisGrid.push(units);
      coordinates[index + axis * n] = units * COORDINATE_QUANTIZATION;
    }
    grid.push(axisGrid);
  }

  const positions2: Partial<Record<NodeId, Vec2>> = {};
  const positions3: Partial<Record<NodeId, Vec3>> = {};
  for (let index = 0; index < n; index += 1) {
    const id = graph.nodeIds[index]!;
    if (axes === 2) {
      positions2[id] = { x: coordinates[index]!, y: coordinates[index + n]! };
    } else {
      positions3[id] = { x: coordinates[index]!, y: coordinates[index + n]!, z: coordinates[index + 2 * n]! };
    }
  }

  const resultDigest = digestPayload([
    SPECTRAL_GEOMETRY_VERSION,
    EIGENSPACE_POLICY_VERSION,
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
      witness.probeOrdinals,
    ]),
  ]);

  const tolerance = boundaryTolerance(solved, retained[0]!.start);

  return {
    kind: 'coordinates',
    algorithmVersion: SPECTRAL_GEOMETRY_VERSION,
    eigenspacePolicy: EIGENSPACE_POLICY_VERSION,
    dimension: options.dimension,
    axes,
    nodeIds: graph.nodeIds,
    loadedNodeIds: graph.nodeIds,
    quantizationStep: COORDINATE_QUANTIZATION,
    clusterTolerance: tolerance,
    coordinates,
    ...(axes === 2 ? { positions2 } : { positions3 }),
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
        `Canonical spectral ${options.dimension} geometry from ${String(witnesses.length)} whole eigenvalue cluster(s) ` +
        `of the attested Laplacian (projector-probe-v1); coordinates are quantised to 1e-10 and orientation within a tied ` +
        `eigenspace is fixed by digest-seeded probes, so it is a labelled convention, not measured semantics`,
      sourceIds: [],
      parameterIds: [options.snapshotDigest, options.domainDigest, EIGENSPACE_POLICY_VERSION],
      numericalWitness: {
        axes,
        backend,
        solverVersion: solved.solverVersion,
        clusterTolerance: tolerance,
        clusters: formatList(witnesses.map((witness) => `${witness.eigenvalueMin.toExponential(6)}x${String(witness.multiplicity)}`)),
        probeOrdinals: formatList(witnesses.flatMap((witness) => witness.probeOrdinals)),
        relativeResidualMax: solved.relativeResidualMax,
        orthogonalityDefect: solved.orthogonalityDefect,
        repeatProjectorDrift: drift,
        quantization: '1e-10',
        resultDigest,
      },
      limitation: 'Spectral coordinates are a visual projection of graph features; axis orientation inside a tied eigenspace follows the deterministic probe policy and carries no semantic-edge meaning.',
    },
  };
}
