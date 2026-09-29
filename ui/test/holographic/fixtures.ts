/** Shared deterministic graph fixtures for the D-073 Holographic spectral-core tests.
 * Synthetic IDs only; every graph is built from attested unit-weight edges unless stated. */

import { digestPayload } from '../../src/engine/digest.ts';
import { buildSpectralGraph, type SpectralEdge, type SpectralGraph } from '../../src/holographic/adjacency.ts';

function ids(count: number, prefix = 'n'): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${String(index).padStart(4, '0')}`);
}

function unit(id: string, source: string, target: string, extra: Partial<SpectralEdge> = {}): SpectralEdge {
  return { id, source, target, directed: false, attestation: 'attested', ...extra };
}

export function pathGraph(nodeCount: number, weights?: number[]): SpectralGraph {
  const nodes = ids(nodeCount);
  const edges = nodes.slice(1).map((node, index) => {
    const weight = weights?.[index];
    return unit(`p${index}`, nodes[index]!, node, weight === undefined ? {} : { weight });
  });
  return buildSpectralGraph({ nodeIds: nodes, edges });
}

export function cycleGraph(nodeCount: number): SpectralGraph {
  const nodes = ids(nodeCount);
  const edges = nodes.map((node, index) => unit(`c${index}`, node, nodes[(index + 1) % nodeCount]!));
  return buildSpectralGraph({ nodeIds: nodes, edges });
}

export function starGraph(leaves: number, centerId = 'hub'): SpectralGraph {
  const center = [centerId];
  const leafIds = ids(leaves, 'leaf');
  const edges = leafIds.map((leaf, index) => unit(`s${index}`, centerId, leaf));
  return buildSpectralGraph({ nodeIds: [...center, ...leafIds], edges });
}

export function completeGraph(nodeCount: number): SpectralGraph {
  const nodes = ids(nodeCount);
  const edges: SpectralEdge[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    for (let j = i + 1; j < nodeCount; j += 1) edges.push(unit(`k${i}-${j}`, nodes[i]!, nodes[j]!));
  }
  return buildSpectralGraph({ nodeIds: nodes, edges });
}

export function combineGraphs(parts: readonly SpectralGraph[], prefixes: readonly string[]): SpectralGraph {
  const nodeIds: string[] = [];
  const edges: SpectralEdge[] = [];
  for (const [partIndex, part] of parts.entries()) {
    const prefix = prefixes[partIndex]!;
    const local = new Map<string, string>();
    for (const id of part.nodeIds) {
      const mapped = `${prefix}${id}`;
      local.set(id, mapped);
      nodeIds.push(mapped);
    }
    for (const edge of part.exploratoryChannel) {
      edges.push({ id: `${prefix}${edge.id}`, source: local.get(edge.source)!, target: local.get(edge.target)!, directed: edge.directed, attestation: 'exploratory' });
    }
    for (let slot = 0; slot < part.csrNeighbor.length; slot += 1) {
      const row = findRow(part, slot);
      const neighbor = part.csrNeighbor[slot]!;
      if (neighbor <= row) continue; // CSR stores both directions; keep the upper triangle
      const source = part.nodeIds[row]!;
      const target = part.nodeIds[neighbor]!;
      edges.push({
        id: `${prefix}${source}-${target}`,
        source: local.get(source)!,
        target: local.get(target)!,
        directed: false,
        attestation: 'attested',
        ...(part.weightPolicy === 'attested-explicit-v1' ? { weight: part.csrWeight[slot]! } : {}),
      });
    }
  }
  return buildSpectralGraph({ nodeIds, edges });
}

function findRow(part: SpectralGraph, slot: number): number {
  for (let row = 0; row < part.size; row += 1) {
    if (slot >= part.csrRowStart[row]! && slot < part.csrRowStart[row + 1]!) return row;
  }
  throw new Error('fixture row lookup failed');
}

/** Ring lattice plus deterministic digest-seeded chords; connected by construction. */
export function ringLatticeGraph(nodeCount: number, chordSeed: string, expectedChordsPerNode = 2): SpectralGraph {
  const nodes = ids(nodeCount);
  const edges: SpectralEdge[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    edges.push(unit(`r${index}`, nodes[index]!, nodes[(index + 1) % nodeCount]!));
  }
  const density = (2 * expectedChordsPerNode) / Math.max(1, nodeCount - 3);
  for (let i = 0; i < nodeCount; i += 1) {
    for (let j = i + 2; j < nodeCount; j += 1) {
      if (i === 0 && j === nodeCount - 1) continue;
      const hex = digestPayload([chordSeed, 'chord', i, j]).slice(0, 6);
      if (parseInt(hex, 16) / 0xffffff <= density) {
        edges.push(unit(`h${i}-${j}`, nodes[i]!, nodes[j]!));
      }
    }
  }
  return buildSpectralGraph({ nodeIds: nodes, edges });
}

/** Deterministic pseudorandom vector from a digest seed (independent of Math.random). */
export function noiseVector(length: number, seed: string): Float64Array {
  const vector = new Float64Array(length);
  for (let block = 0; block * 8 < length; block += 1) {
    const hex = digestPayload([seed, 'fixture-noise', block]);
    for (let offset = 0; offset < 8 && block * 8 + offset < length; offset += 1) {
      vector[block * 8 + offset] = (parseInt(hex.slice(offset * 8, offset * 8 + 8), 16) / 4294967296) * 2 - 1;
    }
  }
  return vector;
}

/** Two K4 cliques bridged by one very weak attested edge (a deliberate zero-cluster ambiguity). */
export function weakBridgeGraph(bridgeWeight: number): SpectralGraph {
  const left = completeGraph(4).nodeIds.map((id) => `a${id}`);
  const right = completeGraph(4).nodeIds.map((id) => `b${id}`);
  const edges: SpectralEdge[] = [];
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      edges.push(unit(`la${i}-${j}`, left[i]!, left[j]!));
      edges.push(unit(`rb${i}-${j}`, right[i]!, right[j]!));
    }
  }
  edges.push(unit('bridge', left[0]!, right[0]!, { weight: bridgeWeight }));
  return buildSpectralGraph({ nodeIds: [...left, ...right], edges, weightPolicy: 'attested-explicit-v1' });
}
