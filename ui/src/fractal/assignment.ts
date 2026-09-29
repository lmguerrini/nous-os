/**
 * Fractal sector assignment (tranche E4 of the views-extension plan).
 *
 * Implements the `sector-locality-v2` rules pinned by the gates G5 and G5.1: contiguous size-proportional community widths
 * `b(C)=min(pi/180, pi/C)`, `R=2pi-C b(C)`, `w_j=b(C)+R n_j/n` with the last right endpoint
 * forced to exactly `2pi` (correction refused above 1e-12); strictly internal member angles
 * through the guard `g_j=min(w_j/10,1e-3)`; the BFS/reversal/ID-tied-DFS candidate order scored
 * by the median shortest circular length of original attested intra-community edges; the 40/20/40
 * slot split for communities of at least four members; and the G5.1 typed giant allocation whose
 * group sub-sectors come only from real primary-hierarchy children with at least two members,
 * while leaf children join the direct members in a residual span ordered by the Fiedler vector
 * of the residual induced subgraph (BFS from the highest-importance node on a disconnected or
 * tied-Fiedler residual). Importance gives the external potential `G = 0.25 + 1.5 q` by midrank
 * with ID ties; the potential stays independent of the angle. Every eligible community and
 * group sub-sector must satisfy `L/L_random <= 0.5` against the 16 seeded shuffle baselines
 * `SHA-256(domainDigest / groupId / seed)`, else a typed `edge-locality-refusal` carries the
 * measured ratio. No membership is ever invented or moved. Pure deterministic module; the
 * eigen backend is the integrated Jacobi solver `jacobi-cyclic-v1`.
 */
import type { Digest, EdgeAttestation, EdgeId, NodeId } from '../projection/contract-types.ts';
import { digestPayload } from '../engine/digest.ts';
import { buildSpectralGraph, type SpectralEdge } from '../holographic/adjacency.ts';
import { DENSE_SYMMETRIC_SOLVER_VERSION, denseLaplacian, solveDenseSymmetricEigen } from '../holographic/dense.ts';
import { largestEntryIndex } from '../holographic/linear-algebra.ts';
import { circularAngleDelta } from './inverse-rays.ts';
import { potentialForRank } from './parameters.ts';

export const SECTOR_POLICY_VERSION = 'sector-locality-v2';
export const FRACTAL_ASSIGNMENT_VERSION = 'fractal-assignment-v1';
export const FRACTAL_ORDER_RULE_VERSION = 'bfs-reversal-dfs-median-v1';
export const EDGE_LOCALITY_SEED_VERSION = 'sha256-fisher-yates-v1';
/** Maximum accepted floating correction when the last sector right endpoint is set to exactly 2pi. */
export const SECTOR_CORRECTION_TOLERANCE = 1e-12;
export const EDGE_LOCALITY_RATIO_LIMIT = 0.5;
export const EDGE_LOCALITY_SEED_COUNT = 16;
/** lambda3 - lambda2 at or below this value is a tied Fiedler value; the BFS fallback applies. */
export const FIEDLER_TIE_TOLERANCE = 1e-10;
/** Fiedler entries rounded to this grid are order ties, resolved by codepoint ID. */
export const FIEDLER_ENTRY_ROUNDING = 1e-12;
/** Domain cap that also bounds the admissible community count. */
export const FRACTAL_DOMAIN_NODE_CAP = 850;
const SECTOR_GUARD_CAP = 1e-3;

export interface FractalSectorNode {
  readonly id: NodeId;
  readonly communityId: string;
  /** Source importance; the caller labels a derived statistic via `importancePolicy`. */
  readonly importance: number;
}

export interface FractalSectorEdge {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly attestation: EdgeAttestation;
}

export interface FractalSectorHierarchyChild {
  readonly childId: string;
  /** Real primary-hierarchy child members restricted to the analytical domain. */
  readonly memberNodeIds: readonly NodeId[];
}

export interface FractalSectorCommunity {
  readonly communityId: string;
  readonly memberNodeIds: readonly NodeId[];
  readonly hierarchyChildren?: readonly FractalSectorHierarchyChild[];
}

export interface FractalSectorInput {
  readonly nodes: readonly FractalSectorNode[];
  readonly edges: readonly FractalSectorEdge[];
  readonly communities: readonly FractalSectorCommunity[];
  readonly domainDigest: Digest;
  /** Enters the digest; the caller assembles it from the consumed module versions. */
  readonly numericalBackendVersion: string;
  /** Labels the importance source, e.g. source importance or a declared derived statistic. */
  readonly importancePolicy: string;
  readonly edgeLocalitySeedCount?: number;
  readonly edgeLocalityRatioLimit?: number;
}

export interface FractalSectorInterval {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

export interface FiedlerOrderWitness {
  readonly method: 'single' | 'fiedler' | 'bfs-fallback' | 'none';
  readonly nodeCount: number;
  readonly componentCount: number;
  readonly lambda2: number | null;
  readonly lambda3: number | null;
  readonly eigenGap: number | null;
  readonly tiedFiedlerValue: boolean;
  readonly pivotNodeId: string | null;
  readonly sweeps: number | null;
  readonly maxAbsResidual: number | null;
  readonly orthogonalityDefect: number | null;
  readonly solverVersion: string;
}

export interface FractalGroupSubSector {
  readonly childId: string;
  readonly memberNodeIds: readonly NodeId[];
  readonly interval: FractalSectorInterval;
  /** Slot order of the members inside the sub-sector. */
  readonly order: readonly NodeId[];
}

export interface FractalGiantAllocation {
  readonly communityId: string;
  readonly innerInterval: FractalSectorInterval;
  readonly groupSubSectors: readonly FractalGroupSubSector[];
  readonly residualNodeIds: readonly NodeId[];
  readonly residualInterval: FractalSectorInterval;
  readonly leafOrder: readonly NodeId[];
  readonly leafOrderWitness: FiedlerOrderWitness;
}

export interface FractalCommunitySector {
  readonly communityId: string;
  readonly interval: FractalSectorInterval;
  readonly guard: number;
  readonly giant: boolean;
  readonly slotPolicy: 'uniform-midrank' | 'bfs-split-40-20-40';
  readonly order: readonly NodeId[];
  readonly allocation: FractalGiantAllocation | null;
}

export interface FractalNodeTarget {
  readonly nodeId: NodeId;
  readonly communityId: string;
  readonly potential: number;
  readonly angle: number;
  readonly groupChildId: string | undefined;
}

export interface FractalEdgeLocalityReport {
  readonly groupId: string;
  readonly scope: 'community' | 'group-sub-sector';
  readonly memberCount: number;
  readonly intraEdgeCount: number;
  readonly eligible: boolean;
  readonly localityMedian: number | null;
  readonly randomizedBaseline: number | null;
  readonly ratio: number | null;
}

export interface FractalSectorDiagnostics {
  readonly attestedEdgeCount: number;
  readonly exploratoryEdgeCount: number;
  readonly ignoredSelfLoopCount: number;
  readonly ignoredNonGiantChildCount: number;
  readonly giantCommunityId: string | null;
}

export interface FractalSectorAssignment {
  readonly kind: 'assignment';
  readonly version: typeof FRACTAL_ASSIGNMENT_VERSION;
  readonly sectorPolicyVersion: typeof SECTOR_POLICY_VERSION;
  readonly orderRuleVersion: typeof FRACTAL_ORDER_RULE_VERSION;
  readonly numericalBackendVersion: string;
  readonly importancePolicy: string;
  readonly nodeCount: number;
  readonly communityCount: number;
  readonly sectors: readonly FractalCommunitySector[];
  /** Sorted by node ID: the external target of every disclosed node. */
  readonly targets: readonly FractalNodeTarget[];
  readonly edgeLocality: readonly FractalEdgeLocalityReport[];
  readonly diagnostics: FractalSectorDiagnostics;
  readonly assignmentDigest: Digest;
}

export type FractalSectorFailureCode =
  | 'invalid-sector-partition'
  | 'edge-locality-refusal'
  | 'fiedler-solver-refused';

export interface FractalSectorFailure {
  readonly kind: 'failure';
  readonly code: FractalSectorFailureCode;
  readonly detail: string;
  readonly groupId?: string;
  readonly ratio?: number;
}

export type FractalSectorResult = FractalSectorAssignment | FractalSectorFailure;

/** Codepoint order (never UTF-16 code-unit order) for all ID comparisons. */
export function codepointCompare(a: string, b: string): number {
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const x = a.codePointAt(left)!;
    const y = b.codePointAt(right)!;
    if (x !== y) return x < y ? -1 : 1;
    left += x > 0xffff ? 2 : 1;
    right += y > 0xffff ? 2 : 1;
  }
  return left === a.length ? (right === b.length ? 0 : -1) : 1;
}

/**
 * Contiguous size-proportional sector intervals over [0, 2pi): half-open, first left exactly 0,
 * last right forced to exactly 2pi with the correction checked against 1e-12.
 */
export function sectorIntervals(sizes: readonly number[]): readonly FractalSectorInterval[] {
  const communityCount = sizes.length;
  if (communityCount < 1) throw new Error('fractal-assignment: at least one community is required');
  let nodeCount = 0;
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`fractal-assignment: community size ${size} is not a positive integer`);
    nodeCount += size;
  }
  const base = Math.min(Math.PI / 180, Math.PI / communityCount);
  const remainder = 2 * Math.PI - communityCount * base;
  const intervals: FractalSectorInterval[] = [];
  let cursor = 0;
  for (let index = 0; index < communityCount; index += 1) {
    const natural = cursor + base + (remainder * sizes[index]!) / nodeCount;
    const last = index === communityCount - 1;
    if (last && Math.abs(natural - 2 * Math.PI) > SECTOR_CORRECTION_TOLERANCE) {
      throw new Error(`fractal-assignment: sector correction ${natural - 2 * Math.PI} breaches ${SECTOR_CORRECTION_TOLERANCE}`);
    }
    const right = last ? 2 * Math.PI : natural;
    intervals.push({ left: cursor, right, width: right - cursor });
    cursor = right;
  }
  return intervals;
}

/** Strictly internal member placement guard g = min(width/10, 1e-3). */
export function sectorGuard(width: number): number {
  return Math.min(width / 10, SECTOR_GUARD_CAP);
}

/** Uniform midrank slot t_r = (r + 1/2)/count, strictly inside (0, 1). */
export function uniformMidrankT(rank: number, count: number): number {
  return (rank + 0.5) / count;
}

/** 40/20/40 split slot for communities of at least four members: first floor(n/2) members evenly
 * in (0, 0.4), the rest evenly in (0.6, 1), a fixed 20% separation across the one graph-order cut. */
export function splitSlotT(rank: number, count: number): number {
  const half = Math.floor(count / 2);
  if (rank < half) return ((rank + 0.5) / half) * 0.4;
  return 0.6 + ((rank - half + 0.5) / (count - half)) * 0.4;
}

/** Linear-interpolation quantile on the sorted copy (the numpy 'linear' method). */
function quantile(sorted: readonly number[], p: number): number {
  const count = sorted.length;
  if (count === 0) return NaN;
  if (count === 1) return sorted[0]!;
  const position = (count - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

/** Radius spread witness demanded by G5: (Q3 - Q1)/median on the mapped radii. */
export function radialSpreadMetrics(radii: readonly number[]): Readonly<{ q1: number; median: number; q3: number; iqrOverMedian: number }> {
  const sorted = [...radii].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  return { q1, median, q3, iqrOverMedian: (q3 - q1) / median };
}

type Adjacency = ReadonlyMap<NodeId, readonly NodeId[]>;

function buildAdjacency(memberSet: ReadonlySet<NodeId>, attestedEdges: readonly FractalSectorEdge[]): Adjacency {
  const sets = new Map<NodeId, Set<NodeId>>();
  for (const id of memberSet) sets.set(id, new Set<NodeId>());
  for (const edge of attestedEdges) {
    if (edge.source === edge.target) continue;
    if (!memberSet.has(edge.source) || !memberSet.has(edge.target)) continue;
    sets.get(edge.source)!.add(edge.target);
    sets.get(edge.target)!.add(edge.source);
  }
  const adjacency = new Map<NodeId, readonly NodeId[]>();
  for (const [id, neighbors] of sets) adjacency.set(id, [...neighbors].sort(codepointCompare));
  return adjacency;
}

/** Community BFS: components restart by minimum degree then ID; neighbors visit in ID order. */
function communityBfsOrder(sortedMembers: readonly NodeId[], adjacency: Adjacency): NodeId[] {
  const degree = (id: NodeId): number => adjacency.get(id)?.length ?? 0;
  const unvisited = new Set(sortedMembers);
  const order: NodeId[] = [];
  while (unvisited.size > 0) {
    let restart: NodeId | null = null;
    for (const id of unvisited) {
      if (restart === null || degree(id) < degree(restart) || (degree(id) === degree(restart) && codepointCompare(id, restart) < 0)) restart = id;
    }
    const queue: NodeId[] = [restart!];
    unvisited.delete(restart!);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      order.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (unvisited.delete(neighbor)) queue.push(neighbor);
      }
    }
  }
  return order;
}

/** Fixed ID-tied preorder DFS: same restart rule as the BFS, neighbors pushed in reverse ID order. */
function communityDfsOrder(sortedMembers: readonly NodeId[], adjacency: Adjacency): NodeId[] {
  const degree = (id: NodeId): number => adjacency.get(id)?.length ?? 0;
  const unvisited = new Set(sortedMembers);
  const order: NodeId[] = [];
  while (unvisited.size > 0) {
    let restart: NodeId | null = null;
    for (const id of unvisited) {
      if (restart === null || degree(id) < degree(restart) || (degree(id) === degree(restart) && codepointCompare(id, restart) < 0)) restart = id;
    }
    const stack: NodeId[] = [restart!];
    unvisited.delete(restart!);
    while (stack.length > 0) {
      const current = stack.pop()!;
      order.push(current);
      const pending = (adjacency.get(current) ?? []).filter((neighbor) => unvisited.has(neighbor));
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        unvisited.delete(pending[index]!);
        stack.push(pending[index]!);
      }
    }
  }
  return order;
}

/** G5.1 locality BFS: restarts by highest importance (ties by ID), neighbors by ID. */
function localityBfsOrder(
  members: readonly { id: NodeId; importance: number }[],
  adjacency: Adjacency,
): { order: NodeId[]; componentCount: number } {
  const importanceOf = new Map(members.map((member) => [member.id, member.importance]));
  const sortedMembers = [...new Set(members.map((member) => member.id))].sort(codepointCompare);
  const unvisited = new Set(sortedMembers);
  const order: NodeId[] = [];
  let componentCount = 0;
  while (unvisited.size > 0) {
    componentCount += 1;
    let restart: NodeId | null = null;
    for (const id of unvisited) {
      if (restart === null) restart = id;
      else {
        const a = importanceOf.get(id)!;
        const b = importanceOf.get(restart)!;
        if (a > b || (a === b && codepointCompare(id, restart) < 0)) restart = id;
      }
    }
    const queue: NodeId[] = [restart!];
    unvisited.delete(restart!);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      order.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (unvisited.delete(neighbor)) queue.push(neighbor);
      }
    }
  }
  return { order, componentCount };
}

/** Median of the shortest circular angle deltas over the given edges; null with no edges. */
export function circularEdgeMedian(
  pairs: readonly (readonly [NodeId, NodeId])[],
  angleOf: ReadonlyMap<NodeId, number>,
): number | null {
  if (pairs.length === 0) return null;
  const deltas = pairs.map(([u, v]) => circularAngleDelta(angleOf.get(u)!, angleOf.get(v)!)).sort((a, b) => a - b);
  const middle = deltas.length >> 1;
  return deltas.length % 2 === 1 ? deltas[middle]! : (deltas[middle - 1]! + deltas[middle]!) / 2;
}

function compareIdSequences(a: readonly NodeId[], b: readonly NodeId[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const compared = codepointCompare(a[index]!, b[index]!);
    if (compared !== 0) return compared;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

interface OrderChoice {
  readonly order: readonly NodeId[];
  readonly median: number | null;
}

/** Score the BFS, reversal and ID-tied DFS candidates by median circular edge length; ties by
 * the serialized ID sequence, exactly the "existing candidate-order rule". */
function chooseCandidateOrder(
  sortedMembers: readonly NodeId[],
  adjacency: Adjacency,
  intraEdges: readonly (readonly [NodeId, NodeId])[],
  slotT: (rank: number, count: number) => number,
  place: (slot: number) => number,
): OrderChoice {
  const count = sortedMembers.length;
  const bfs = communityBfsOrder(sortedMembers, adjacency);
  const candidates: readonly NodeId[][] = [bfs, [...bfs].reverse(), communityDfsOrder(sortedMembers, adjacency)];
  let best: OrderChoice | null = null;
  for (const candidate of candidates) {
    const angleOf = new Map<NodeId, number>();
    candidate.forEach((id, rank) => angleOf.set(id, place(slotT(rank, count))));
    const median = circularEdgeMedian(intraEdges, angleOf);
    if (best === null || (median !== null && best.median === null) ||
      (median !== null && best.median !== null && median < best.median) ||
      (((median === null && best.median === null) || (median !== null && best.median !== null && median === best.median)) &&
        compareIdSequences(candidate, best.order) < 0)) {
      best = { order: candidate, median };
    }
  }
  return best!;
}

/**
 * G5.1 deterministic locality order of a residual set: Fiedler-vector order of the induced
 * subgraph, sign fixed by the largest-magnitude entry with ID ties; entries rounded to 1e-12
 * are order ties by ID. A disconnected residual or a tied Fiedler value (lambda3 - lambda2 <=
 * 1e-10) falls back to the highest-importance BFS. A singleton needs no eigensolve.
 */
export function fiedlerLocalityOrder(
  members: readonly { id: NodeId; importance: number }[],
  edges: readonly { source: NodeId; target: NodeId }[],
): Readonly<{ order: readonly NodeId[]; witness: FiedlerOrderWitness }> {
  const sortedMembers = [...members].sort((a, b) => codepointCompare(a.id, b.id));
  const nodeCount = sortedMembers.length;
  const emptyWitness: FiedlerOrderWitness = {
    method: 'none', nodeCount: 0, componentCount: 0, lambda2: null, lambda3: null, eigenGap: null,
    tiedFiedlerValue: false, pivotNodeId: null, sweeps: null, maxAbsResidual: null, orthogonalityDefect: null,
    solverVersion: DENSE_SYMMETRIC_SOLVER_VERSION,
  };
  if (nodeCount === 0) return { order: [], witness: emptyWitness };
  const memberSet = new Set(sortedMembers.map((member) => member.id));
  const adjacency = buildAdjacency(memberSet, edges.map((edge, index) => ({ id: `fiedler-${index}`, source: edge.source, target: edge.target, attestation: 'attested' as EdgeAttestation })));
  if (nodeCount === 1) {
    return {
      order: [sortedMembers[0]!.id],
      witness: { ...emptyWitness, method: 'single', nodeCount: 1, componentCount: 1, pivotNodeId: sortedMembers[0]!.id },
    };
  }
  // Connectivity first: a disconnected residual never reaches the eigensolve.
  {
    let componentCount = 0;
    const seen = new Set<NodeId>();
    for (const member of sortedMembers) {
      if (seen.has(member.id)) continue;
      componentCount += 1;
      const queue = [member.id];
      seen.add(member.id);
      let head = 0;
      while (head < queue.length) {
        for (const neighbor of adjacency.get(queue[head++]!) ?? []) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    if (componentCount > 1) {
      const { order } = localityBfsOrder(sortedMembers, adjacency);
      return {
        order,
        witness: { ...emptyWitness, method: 'bfs-fallback', nodeCount, componentCount },
      };
    }
  }
  const spectralEdges: SpectralEdge[] = edges.map((edge, index) => ({
    id: `fiedler-${index}`, source: edge.source, target: edge.target, directed: false, attestation: 'attested',
  }));
  let solution: ReturnType<typeof solveDenseSymmetricEigen>;
  try {
    solution = solveDenseSymmetricEigen(denseLaplacian(buildSpectralGraph({ nodeIds: sortedMembers.map((member) => member.id), edges: spectralEdges })));
  } catch (error) {
    throw new Error(`fractal-assignment: Fiedler backend refused n=${nodeCount}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lambda2 = solution.eigenvalues[1]!;
  const lambda3 = nodeCount >= 3 ? solution.eigenvalues[2]! : Number.POSITIVE_INFINITY;
  const eigenGap = lambda3 - lambda2;
  if (Number.isFinite(lambda3) && eigenGap <= FIEDLER_TIE_TOLERANCE) {
    const { order, componentCount } = localityBfsOrder(sortedMembers, adjacency);
    return {
      order,
      witness: {
        ...emptyWitness, method: 'bfs-fallback', nodeCount, componentCount, lambda2, lambda3, eigenGap,
        tiedFiedlerValue: true, sweeps: solution.sweeps, maxAbsResidual: solution.maxAbsResidual,
        orthogonalityDefect: solution.orthogonalityDefect,
      },
    };
  }
  const graphIds = sortedMembers.map((member) => member.id);
  const column = Float64Array.from(solution.eigenvectors.subarray(nodeCount, 2 * nodeCount));
  const pivot = largestEntryIndex(column, FIEDLER_TIE_TOLERANCE);
  const pivotNodeId = graphIds[pivot]!;
  const sign = column[pivot]! < 0 ? -1 : 1;
  const rounded = Array.from(column, (value) => Math.round(value * sign * (1 / FIEDLER_ENTRY_ROUNDING)));
  const order = sortedMembers
    .map((member, index) => ({ id: member.id, key: rounded[index]! }))
    .sort((a, b) => a.key - b.key || codepointCompare(a.id, b.id))
    .map((entry) => entry.id);
  return {
    order,
    witness: {
      ...emptyWitness, method: 'fiedler', nodeCount, componentCount: 1, lambda2, lambda3, eigenGap,
      pivotNodeId, sweeps: solution.sweeps, maxAbsResidual: solution.maxAbsResidual,
      orthogonalityDefect: solution.orthogonalityDefect,
    },
  };
}

/** Deterministic 32-bit word stream: SHA-256 of canonical JSON of the seed material. */
function seededUint32(domainDigest: Digest, groupId: string, seed: number, block: number): number {
  return Number.parseInt(digestPayload([EDGE_LOCALITY_SEED_VERSION, domainDigest, groupId, seed, block]).slice(0, 8), 16);
}

/** Fisher-Yates shuffle of the ID-sorted members onto the fixed ascending angular slots. */
function seededShuffle(domainDigest: Digest, groupId: string, seed: number, sortedIds: readonly NodeId[]): NodeId[] {
  const shuffled = [...sortedIds];
  for (let index = shuffled.length - 1; index >= 1; index -= 1) {
    const word = seededUint32(domainDigest, groupId, seed, index);
    const swap = Math.floor((word / 4294967296) * (index + 1));
    const temporary = shuffled[index]!;
    shuffled[index] = shuffled[swap]!;
    shuffled[swap] = temporary;
  }
  return shuffled;
}

function randomizedLocalityBaseline(
  domainDigest: Digest,
  groupId: string,
  sortedIds: readonly NodeId[],
  slotsAscending: readonly number[],
  intraEdges: readonly (readonly [NodeId, NodeId])[],
  seedCount: number,
): number {
  let total = 0;
  for (let seed = 0; seed < seedCount; seed += 1) {
    const permutation = seededShuffle(domainDigest, groupId, seed, sortedIds);
    const angleOf = new Map<NodeId, number>();
    permutation.forEach((id, slot) => angleOf.set(id, slotsAscending[slot]!));
    total += circularEdgeMedian(intraEdges, angleOf) ?? 0;
  }
  return total / seedCount;
}

function invalid(detail: string): FractalSectorFailure {
  return { kind: 'failure', code: 'invalid-sector-partition', detail };
}

/** Assign external angular sectors and importance midranks under `sector-locality-v2`. */
export function assignFractalSectors(input: FractalSectorInput): FractalSectorResult {
  const { nodes, edges, communities, domainDigest, numericalBackendVersion, importancePolicy } = input;
  const seedCount = input.edgeLocalitySeedCount ?? EDGE_LOCALITY_SEED_COUNT;
  const ratioLimit = input.edgeLocalityRatioLimit ?? EDGE_LOCALITY_RATIO_LIMIT;

  if (nodes.length === 0) return invalid('the analytical domain needs at least one node');
  const nodeById = new Map<NodeId, FractalSectorNode>();
  for (const node of nodes) {
    if (typeof node.id !== 'string' || node.id.length === 0) return invalid(`node id ${String(node.id)} is not a nonempty string`);
    if (nodeById.has(node.id)) return invalid(`duplicate node ID ${node.id}`);
    if (typeof node.importance !== 'number' || !Number.isFinite(node.importance)) return invalid(`node ${node.id} has nonfinite importance`);
    nodeById.set(node.id, node);
  }
  const nodeCount = nodes.length;
  if (communities.length === 0) return invalid('at least one real community is required');
  const communityIds = new Set<string>();
  for (const community of communities) {
    if (typeof community.communityId !== 'string' || community.communityId.length === 0) return invalid('community IDs must be nonempty strings');
    if (communityIds.has(community.communityId)) return invalid(`duplicate community ID ${community.communityId}`);
    communityIds.add(community.communityId);
  }
  if (communities.length > Math.min(nodeCount, FRACTAL_DOMAIN_NODE_CAP)) {
    return invalid(`community count ${communities.length} exceeds min(n, 850) = ${Math.min(nodeCount, FRACTAL_DOMAIN_NODE_CAP)}`);
  }
  const sortedCommunities = [...communities].sort((a, b) => codepointCompare(a.communityId, b.communityId));
  const membersByCommunity = new Map<string, NodeId[]>();
  for (const community of sortedCommunities) {
    if (community.memberNodeIds.length === 0) return invalid(`community ${community.communityId} has no members`);
    const seen = new Set<NodeId>();
    for (const id of community.memberNodeIds) {
      if (!nodeById.has(id)) return invalid(`community ${community.communityId} lists unknown node ${id}`);
      if (seen.has(id)) return invalid(`community ${community.communityId} lists node ${id} twice`);
      seen.add(id);
    }
    membersByCommunity.set(community.communityId, [...seen].sort(codepointCompare));
  }
  for (const node of nodes) {
    const members = membersByCommunity.get(node.communityId);
    if (members === undefined) return invalid(`node ${node.id} declares unknown community ${node.communityId}`);
    if (!members.includes(node.id)) return invalid(`node ${node.id} is not a declared member of ${node.communityId}`);
  }
  const totalListed = [...membersByCommunity.values()].reduce((sum, members) => sum + members.length, 0);
  if (totalListed !== nodeCount) return invalid(`community memberships list ${totalListed} nodes but the domain has ${nodeCount}`);

  const edgeIds = new Set<EdgeId>();
  let attestedEdgeCount = 0;
  let exploratoryEdgeCount = 0;
  let ignoredSelfLoopCount = 0;
  for (const edge of edges) {
    if (typeof edge.id !== 'string' || edge.id.length === 0) return invalid('edge IDs must be nonempty strings');
    if (edgeIds.has(edge.id)) return invalid(`duplicate edge ID ${edge.id}`);
    edgeIds.add(edge.id);
    if (edge.attestation !== 'attested' && edge.attestation !== 'exploratory') return invalid(`edge ${edge.id} has attestation ${String(edge.attestation)}`);
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return invalid(`edge ${edge.id} references a node outside the domain`);
    if (edge.source === edge.target) ignoredSelfLoopCount += 1;
    if (edge.attestation === 'attested') attestedEdgeCount += 1;
    else exploratoryEdgeCount += 1;
  }
  const attestedEdges = edges.filter((edge) => edge.attestation === 'attested' && edge.source !== edge.target);

  let intervals: readonly FractalSectorInterval[];
  try {
    intervals = sectorIntervals(sortedCommunities.map((community) => membersByCommunity.get(community.communityId)!.length));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }

  // Importance midranks: (importance, ID) total order; the potential stays angle-independent.
  const ranked = [...nodes].sort((a, b) => a.importance - b.importance || codepointCompare(a.id, b.id));
  const potentialOf = new Map<NodeId, number>();
  ranked.forEach((node, rank) => potentialOf.set(node.id, potentialForRank(rank, nodeCount)));
  const importanceOf = new Map(nodes.map((node) => [node.id, node.importance]));

  // Hierarchy children: disjoint per community, contained in the parent, at least one member.
  const childrenByCommunity = new Map<string, readonly FractalSectorHierarchyChild[]>();
  for (const community of sortedCommunities) {
    const declared = community.hierarchyChildren ?? [];
    if (declared.length === 0) continue;
    const seenChildIds = new Set<string>();
    const covered = new Set<NodeId>();
    const members = new Set(membersByCommunity.get(community.communityId)!);
    const sortedChildren: FractalSectorHierarchyChild[] = [];
    for (const child of declared) {
      if (typeof child.childId !== 'string' || child.childId.length === 0) return invalid('hierarchy child IDs must be nonempty strings');
      if (seenChildIds.has(child.childId)) return invalid(`duplicate hierarchy child ${child.childId} in ${community.communityId}`);
      seenChildIds.add(child.childId);
      if (child.memberNodeIds.length === 0) return invalid(`hierarchy child ${child.childId} has no members`);
      const childMembers: NodeId[] = [];
      for (const id of child.memberNodeIds) {
        if (!members.has(id)) return invalid(`hierarchy child ${child.childId} lists ${id} outside parent ${community.communityId}`);
        if (covered.has(id)) return invalid(`node ${id} belongs to two hierarchy children of ${community.communityId}`);
        covered.add(id);
        childMembers.push(id);
      }
      sortedChildren.push({ childId: child.childId, memberNodeIds: childMembers.sort(codepointCompare) });
    }
    sortedChildren.sort((a, b) => codepointCompare(a.childId, b.childId));
    childrenByCommunity.set(community.communityId, sortedChildren);
  }

  const giantCommunity = sortedCommunities.find((community) => membersByCommunity.get(community.communityId)!.length > nodeCount / 2) ?? null;
  let ignoredNonGiantChildCount = 0;
  for (const community of sortedCommunities) {
    if (giantCommunity === null || community.communityId !== giantCommunity.communityId) {
      ignoredNonGiantChildCount += childrenByCommunity.get(community.communityId)?.length ?? 0;
    }
  }

  const intraEdgesOf = (memberSet: ReadonlySet<NodeId>): [NodeId, NodeId][] => {
    const pairs: [NodeId, NodeId][] = [];
    for (const edge of attestedEdges) {
      if (memberSet.has(edge.source) && memberSet.has(edge.target)) pairs.push([edge.source, edge.target]);
    }
    return pairs;
  };

  const targets: FractalNodeTarget[] = [];
  const sectors: FractalCommunitySector[] = [];
  const localityReports: FractalEdgeLocalityReport[] = [];
  const targetAngleOf = new Map<NodeId, number>();

  const pushTarget = (nodeId: NodeId, communityId: string, angle: number, groupChildId: string | undefined): void => {
    targets.push({ nodeId, communityId, potential: potentialOf.get(nodeId)!, angle, groupChildId });
    targetAngleOf.set(nodeId, angle);
  };

  const scoreLocality = (
    groupId: string,
    scope: 'community' | 'group-sub-sector',
    memberIds: readonly NodeId[],
    intraEdges: readonly (readonly [NodeId, NodeId])[],
  ): FractalSectorResult | null => {
    const memberCount = memberIds.length;
    const intraEdgeCount = intraEdges.length;
    const median = circularEdgeMedian(intraEdges, targetAngleOf);
    const eligible = memberCount >= 3 && intraEdgeCount >= 1;
    if (!eligible) {
      localityReports.push({ groupId, scope, memberCount, intraEdgeCount, eligible, localityMedian: median, randomizedBaseline: null, ratio: null });
      return null;
    }
    const sortedIds = [...memberIds].sort(codepointCompare);
    const slots = sortedIds.map((id) => targetAngleOf.get(id)!).sort((a, b) => a - b);
    const baseline = randomizedLocalityBaseline(domainDigest, groupId, sortedIds, slots, intraEdges, seedCount);
    const ratio = median! / baseline;
    localityReports.push({ groupId, scope, memberCount, intraEdgeCount, eligible, localityMedian: median, randomizedBaseline: baseline, ratio });
    if (!(ratio <= ratioLimit)) {
      return {
        kind: 'failure',
        code: 'edge-locality-refusal',
        detail: `eligible set ${groupId} (${scope}) has L=${median}, L_random=${baseline}, ratio ${ratio} > ${ratioLimit}`,
        groupId,
        ratio,
      };
    }
    return null;
  };

  for (let index = 0; index < sortedCommunities.length; index += 1) {
    const community = sortedCommunities[index]!;
    const interval = intervals[index]!;
    const members = membersByCommunity.get(community.communityId)!;
    const memberSet = new Set(members);
    const intraEdges = intraEdgesOf(memberSet);
    const adjacency = buildAdjacency(memberSet, attestedEdges);
    const guard = sectorGuard(interval.width);
    const isGiant = giantCommunity?.communityId === community.communityId;
    const children = isGiant ? childrenByCommunity.get(community.communityId) ?? [] : [];

    if (isGiant && children.length > 0) {
      // G5.1 typed giant allocation: contiguous group sub-sectors from real group children in
      // child-ID order, widths proportional to member counts; leaf children and direct members
      // share the proportional residual span in the deterministic locality order.
      const innerLeft = interval.left + guard;
      const innerWidth = interval.width - 2 * guard;
      let cursor = innerLeft;
      const groupSubSectors: FractalGroupSubSector[] = [];
      for (const child of children) {
        if (child.memberNodeIds.length < 2) continue;
        const width = (innerWidth * child.memberNodeIds.length) / members.length;
        const left = cursor;
        const right = left + width;
        cursor = right;
        const childSet = new Set(child.memberNodeIds);
        const childEdges = intraEdgesOf(childSet);
        const childAdjacency = buildAdjacency(childSet, attestedEdges);
        const choice = chooseCandidateOrder(
          child.memberNodeIds,
          childAdjacency,
          childEdges,
          uniformMidrankT,
          (slot) => left + slot * width,
        );
        choice.order.forEach((id, rank) => pushTarget(id, community.communityId, left + uniformMidrankT(rank, child.memberNodeIds.length) * width, child.childId));
        groupSubSectors.push({ childId: child.childId, memberNodeIds: child.memberNodeIds, interval: { left, right, width: right - left }, order: choice.order });
      }
      const residualMembers = members.filter((id) => !groupSubSectors.some((subSector) => subSector.memberNodeIds.includes(id)));
      const residualRight = innerLeft + innerWidth;
      const residualWidth = residualRight - cursor;
      let leaf: Readonly<{ order: readonly NodeId[]; witness: FiedlerOrderWitness }>;
      try {
        leaf = fiedlerLocalityOrder(
          residualMembers.map((id) => ({ id, importance: importanceOf.get(id)! })),
          intraEdgesOf(new Set(residualMembers)).map(([source, target]) => ({ source, target })),
        );
      } catch (error) {
        return {
          kind: 'failure',
          code: 'fiedler-solver-refused',
          detail: error instanceof Error ? error.message : String(error),
          groupId: community.communityId,
        };
      }
      leaf.order.forEach((id, rank) => pushTarget(id, community.communityId, cursor + uniformMidrankT(rank, residualMembers.length) * residualWidth, undefined));
      const order = [...targets].filter((target) => target.communityId === community.communityId).sort((a, b) => a.angle - b.angle).map((target) => target.nodeId);
      sectors.push({
        communityId: community.communityId,
        interval,
        guard,
        giant: true,
        slotPolicy: 'uniform-midrank',
        order,
        allocation: {
          communityId: community.communityId,
          innerInterval: { left: innerLeft, right: residualRight, width: innerWidth },
          groupSubSectors,
          residualNodeIds: residualMembers,
          residualInterval: { left: cursor, right: residualRight, width: residualWidth },
          leafOrder: leaf.order,
          leafOrderWitness: leaf.witness,
        },
      });
      const communityFailure = scoreLocality(community.communityId, 'community', members, intraEdges);
      if (communityFailure !== null) return communityFailure;
      for (const subSector of groupSubSectors) {
        const subFailure = scoreLocality(subSector.childId, 'group-sub-sector', subSector.memberNodeIds, intraEdgesOf(new Set(subSector.memberNodeIds)));
        if (subFailure !== null) return subFailure;
      }
      continue;
    }

    // Community rule (also the childless giant): BFS/reversal/DFS candidates with the 40/20/40
    // split for at least four members, uniform midranks otherwise, all strictly inside the guard.
    const slotPolicy = members.length >= 4 ? 'bfs-split-40-20-40' : 'uniform-midrank';
    const slotT = members.length >= 4 ? splitSlotT : uniformMidrankT;
    const innerWidth = interval.width - 2 * guard;
    const choice = chooseCandidateOrder(
      members,
      adjacency,
      intraEdges,
      slotT,
      (slot) => interval.left + guard + slot * innerWidth,
    );
    choice.order.forEach((id, rank) => pushTarget(id, community.communityId, interval.left + guard + slotT(rank, members.length) * innerWidth, undefined));
    sectors.push({ communityId: community.communityId, interval, guard, giant: isGiant, slotPolicy, order: choice.order, allocation: null });
    const communityFailure = scoreLocality(community.communityId, 'community', members, intraEdges);
    if (communityFailure !== null) return communityFailure;
  }

  const assignmentDigest = digestPayload({
    policy: SECTOR_POLICY_VERSION,
    version: FRACTAL_ASSIGNMENT_VERSION,
    orderRule: FRACTAL_ORDER_RULE_VERSION,
    numericalBackend: numericalBackendVersion,
    importancePolicy,
    domainDigest,
    communities: sortedCommunities.map((community) => ({
      id: community.communityId,
      members: membersByCommunity.get(community.communityId)!,
      children: (childrenByCommunity.get(community.communityId) ?? []).map((child) => ({ childId: child.childId, members: child.memberNodeIds })),
    })),
    edgeIds: [...edgeIds].sort(codepointCompare),
    importanceOrder: ranked.map((node) => node.id),
    seedCount,
    ratioLimitMicro: Math.round(ratioLimit * 1e6),
  });

  return {
    kind: 'assignment',
    version: FRACTAL_ASSIGNMENT_VERSION,
    sectorPolicyVersion: SECTOR_POLICY_VERSION,
    orderRuleVersion: FRACTAL_ORDER_RULE_VERSION,
    numericalBackendVersion,
    importancePolicy,
    nodeCount,
    communityCount: sortedCommunities.length,
    sectors,
    targets: targets.sort((a, b) => codepointCompare(a.nodeId, b.nodeId)),
    edgeLocality: localityReports,
    diagnostics: {
      attestedEdgeCount,
      exploratoryEdgeCount,
      ignoredSelfLoopCount,
      ignoredNonGiantChildCount,
      giantCommunityId: giantCommunity?.communityId ?? null,
    },
    assignmentDigest,
  };
}
