/** D-073 tranche F, row F1 — attested adjacency normalisation and component ledger for the
 * Holographic spectral core.
 *
 * Builds the symmetric nonnegative weighted adjacency A over ORIGINAL ATTESTED edges only:
 *   A_ij = sum over attested edges between i and j of w_e; parallel edges sum;
 *   a directed edge of weight w symmetrises to w/2 in each direction; self-loops contribute
 *   0 to L = D - A and are excluded and counted instead.
 * Exploratory edges are never blended into A: they are returned as a separate selectable
 * channel with identity only. D_ii = sum_j A_ij and L = D - A follows.
 * Pure module; deterministic under any node/edge input order. */

import type { EdgeAttestation, EdgeId, NodeId } from '../projection/contract-types.ts';

export const HOLOGRAPHIC_ADJACENCY_VERSION = 'holographic-adjacency-v1';
export const ADJACENCY_WEIGHT_POLICY_UNIT = 'attested-unit-v1';
export const ADJACENCY_WEIGHT_POLICY_EXPLICIT = 'attested-explicit-v1';
export const ADJACENCY_DIRECTED_POLICY = 'symmetrize-half-v1';
export const ADJACENCY_SELF_LOOP_POLICY = 'excluded-from-laplacian-v1';

/** Weighted edge view of a source edge. `weight` is the versioned derived analysis weight
 * (the validated v2 GraphEdge has no weight field); omit it for the unit-weight policy. */
export interface SpectralEdge {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly directed: boolean;
  readonly attestation: EdgeAttestation;
  readonly weight?: number;
}

export interface SpectralGraphInput {
  readonly nodeIds: readonly NodeId[];
  readonly edges: readonly SpectralEdge[];
  readonly weightPolicy?: typeof ADJACENCY_WEIGHT_POLICY_UNIT | typeof ADJACENCY_WEIGHT_POLICY_EXPLICIT;
}

export interface SpectralComponent {
  readonly index: number;
  readonly memberIndices: readonly number[];
  readonly smallestNodeId: NodeId;
}

export interface ExploratoryChannelEdge {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly directed: boolean;
}

export interface SpectralGraph {
  readonly algorithmVersion: string;
  readonly weightPolicy: string;
  readonly directedPolicy: string;
  readonly selfLoopPolicy: string;
  readonly nodeIds: readonly NodeId[];
  readonly size: number;
  readonly indexOf: ReadonlyMap<NodeId, number>;
  readonly attestedEdgeCount: number;
  readonly exploratoryEdgeCount: number;
  readonly excludedSelfLoopCount: number;
  /** D_ii = sum_j A_ij over the attested symmetric adjacency. */
  readonly degrees: Float64Array;
  readonly totalAttestedWeight: number;
  /** Gershgorin bound ||L||_2 <= 2 max_i D_i (L is symmetric weakly diagonally dominant). */
  readonly spectralNormBound: number;
  readonly csrRowStart: Int32Array;
  readonly csrNeighbor: Int32Array;
  readonly csrWeight: Float64Array;
  readonly components: readonly SpectralComponent[];
  readonly componentOf: Int32Array;
  readonly componentCount: number;
  /** Exploratory edges: a separate selectable analytic channel, never part of L. */
  readonly exploratoryChannel: readonly ExploratoryChannelEdge[];
  applyAdjacency(x: Float64Array): Float64Array;
  applyLaplacian(x: Float64Array): Float64Array;
  /** Edge-sum form sum_{i<j} A_ij (x_i - x_j)^2; an independent cross-check of x^T L x. */
  quadraticForm(x: Float64Array): number;
}

function codepointOrder(a: string, b: string): number {
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

function fail(message: string): never {
  throw new Error(`holographic-adjacency: ${message}`);
}

export function buildSpectralGraph(input: SpectralGraphInput): SpectralGraph {
  const { nodeIds, edges } = input;
  if (!nodeIds || nodeIds.length === 0) fail('the analytical domain needs at least one node');
  const seenNodes = new Set<NodeId>();
  for (const id of nodeIds) {
    if (typeof id !== 'string' || id.length === 0) fail('node IDs must be nonempty strings');
    if (seenNodes.has(id)) fail(`duplicate node ID: ${id}`);
    seenNodes.add(id);
  }
  const sortedIds = [...nodeIds].sort(codepointOrder);
  const indexOf = new Map<NodeId, number>();
  for (let index = 0; index < sortedIds.length; index += 1) indexOf.set(sortedIds[index]!, index);
  const n = sortedIds.length;

  let explicitWeightSeen = false;
  const seenEdgeIds = new Set<EdgeId>();
  const parsed: { id: EdgeId; s: number; t: number; directed: boolean; attestation: EdgeAttestation; weight: number }[] = [];
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string' || edge.id.length === 0) fail('edge IDs must be nonempty strings');
    if (seenEdgeIds.has(edge.id)) fail(`duplicate edge ID: ${edge.id}`);
    seenEdgeIds.add(edge.id);
    if (edge.attestation !== 'attested' && edge.attestation !== 'exploratory') {
      fail(`edge ${edge.id} has attestation ${String(edge.attestation)}; canonical/candidate/exploratory classes stay distinct`);
    }
    const source = indexOf.get(edge.source);
    const target = indexOf.get(edge.target);
    if (source === undefined || target === undefined) {
      fail(`edge ${edge.id} references a node outside the analytical domain`);
    }
    let weight = 1;
    if (edge.weight !== undefined) {
      if (typeof edge.weight !== 'number' || !Number.isFinite(edge.weight) || edge.weight <= 0) {
        fail(`edge ${edge.id} has nonfinite or nonpositive weight ${String(edge.weight)}`);
      }
      weight = edge.weight;
      explicitWeightSeen = true;
    }
    parsed.push({ id: edge.id, s: source, t: target, directed: edge.directed === true, attestation: edge.attestation, weight });
  }

  const weightPolicy = input.weightPolicy ?? (explicitWeightSeen ? ADJACENCY_WEIGHT_POLICY_EXPLICIT : ADJACENCY_WEIGHT_POLICY_UNIT);
  if (weightPolicy === ADJACENCY_WEIGHT_POLICY_UNIT && explicitWeightSeen) {
    fail('explicit edge weights need the attested-explicit-v1 weight policy');
  }

  // Canonical edge order fixes floating-point summation order of parallel edges.
  parsed.sort((a, b) => (a.s - b.s) || (a.t - b.t) || codepointOrder(a.id, b.id));

  let attestedEdgeCount = 0;
  let exploratoryEdgeCount = 0;
  let excludedSelfLoopCount = 0;
  const exploratoryChannel: ExploratoryChannelEdge[] = [];
  const rows: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  for (const edge of parsed) {
    if (edge.attestation === 'exploratory') {
      exploratoryEdgeCount += 1;
      exploratoryChannel.push({ id: edge.id, source: sortedIds[edge.s]!, target: sortedIds[edge.t]!, directed: edge.directed });
      continue;
    }
    if (edge.s === edge.t) {
      excludedSelfLoopCount += 1;
      continue;
    }
    attestedEdgeCount += 1;
    const forward = edge.directed ? edge.weight / 2 : edge.weight;
    const a = rows[edge.s]!;
    const b = rows[edge.t]!;
    a.set(edge.t, (a.get(edge.t) ?? 0) + forward);
    b.set(edge.s, (b.get(edge.s) ?? 0) + forward);
  }

  const csrRowStart = new Int32Array(n + 1);
  let totalEntries = 0;
  for (let row = 0; row < n; row += 1) totalEntries += rows[row]!.size;
  const csrNeighbor = new Int32Array(totalEntries);
  const csrWeight = new Float64Array(totalEntries);
  const degrees = new Float64Array(n);
  let cursor = 0;
  for (let row = 0; row < n; row += 1) {
    csrRowStart[row] = cursor;
    const neighbors = [...rows[row]!.keys()].sort((a, b) => a - b);
    for (const neighbor of neighbors) {
      const weight = rows[row]!.get(neighbor)!;
      csrNeighbor[cursor] = neighbor;
      csrWeight[cursor] = weight;
      degrees[row] = degrees[row]! + weight;
      cursor += 1;
    }
  }
  csrRowStart[n] = cursor;
  const totalAttestedWeight = degrees.reduce((sum, value) => sum + value, 0) / 2;
  let maxDegree = 0;
  for (let row = 0; row < n; row += 1) if (degrees[row]! > maxDegree) maxDegree = degrees[row]!;

  // Component ledger over attested edges only, by smallest codepoint ID.
  const componentOf = new Int32Array(n).fill(-1);
  const components: SpectralComponent[] = [];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start += 1) {
    if (componentOf[start] !== -1) continue;
    const index = components.length;
    const members: number[] = [];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    componentOf[start] = index;
    while (head < tail) {
      const node = queue[head++]!;
      members.push(node);
      for (let slot = csrRowStart[node]!; slot < csrRowStart[node + 1]!; slot += 1) {
        const neighbor = csrNeighbor[slot]!;
        if (componentOf[neighbor] === -1) {
          componentOf[neighbor] = index;
          queue[tail++] = neighbor;
        }
      }
    }
    members.sort((a, b) => a - b);
    components.push({ index, memberIndices: members, smallestNodeId: sortedIds[members[0]!]! });
  }

  const applyAdjacency = (x: Float64Array): Float64Array => {
    if (x.length !== n) fail('adjacency apply needs a vector over the domain nodes');
    const y = new Float64Array(n);
    for (let row = 0; row < n; row += 1) {
      let sum = 0;
      for (let slot = csrRowStart[row]!; slot < csrRowStart[row + 1]!; slot += 1) {
        sum += csrWeight[slot]! * x[csrNeighbor[slot]!]!;
      }
      y[row] = sum;
    }
    return y;
  };

  const applyLaplacian = (x: Float64Array): Float64Array => {
    if (x.length !== n) fail('Laplacian apply needs a vector over the domain nodes');
    const y = new Float64Array(n);
    for (let row = 0; row < n; row += 1) {
      let sum = degrees[row]! * x[row]!;
      for (let slot = csrRowStart[row]!; slot < csrRowStart[row + 1]!; slot += 1) {
        sum -= csrWeight[slot]! * x[csrNeighbor[slot]!]!;
      }
      y[row] = sum;
    }
    return y;
  };

  const quadraticForm = (x: Float64Array): number => {
    if (x.length !== n) fail('quadratic form needs a vector over the domain nodes');
    let sum = 0;
    for (let row = 0; row < n; row += 1) {
      for (let slot = csrRowStart[row]!; slot < csrRowStart[row + 1]!; slot += 1) {
        const neighbor = csrNeighbor[slot]!;
        if (neighbor > row) {
          const delta = x[row]! - x[neighbor]!;
          sum += csrWeight[slot]! * delta * delta;
        }
      }
    }
    return sum;
  };

  return {
    algorithmVersion: HOLOGRAPHIC_ADJACENCY_VERSION,
    weightPolicy,
    directedPolicy: ADJACENCY_DIRECTED_POLICY,
    selfLoopPolicy: ADJACENCY_SELF_LOOP_POLICY,
    nodeIds: sortedIds,
    size: n,
    indexOf,
    attestedEdgeCount,
    exploratoryEdgeCount,
    excludedSelfLoopCount,
    degrees,
    totalAttestedWeight,
    spectralNormBound: 2 * maxDegree,
    csrRowStart,
    csrNeighbor,
    csrWeight,
    components,
    componentOf,
    componentCount: components.length,
    exploratoryChannel,
    applyAdjacency,
    applyLaplacian,
    quadraticForm,
  };
}
