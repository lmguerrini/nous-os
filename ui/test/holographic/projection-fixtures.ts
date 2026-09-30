/** Shared synthetic snapshot builders for the D-073 Holographic projection tests.
 * Synthetic IDs only; every snapshot is built through the real normaliser from a raw ledger. */

import { digestPayload } from '../../src/engine/digest.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import type { AnalyticalDomain, ProjectionRequest, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';

export interface SyntheticNode {
  readonly id: string;
  readonly community: string | null;
  readonly importance: number;
}

export interface SyntheticEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly attestation?: 'attested' | 'exploratory';
  readonly weight?: number;
}

export interface SnapshotFixture {
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  readonly sourceBytes: Uint8Array;
}

export type HolographicParameters = ProjectionRequest<'holographic'>['parameters'];

export const DEFAULT_PARAMETERS: HolographicParameters = {
  dimension: '2d', modes: 24, restartSize: 96, maxRestarts: 8, eigenTolerance: 1e-8,
  eigenspacePolicyVersion: 'projector-probe-v1', heatTimes: [0.5, 2], ridge: 0, signalId: 'importance',
};

export async function buildSnapshotFixture(
  nodes: readonly SyntheticNode[],
  edges: readonly SyntheticEdge[],
  domainNodeIds?: readonly string[],
): Promise<SnapshotFixture> {
  const rawNodes = nodes.map(node => ({
    id: node.id, level: 1, kind: 'concept', parent: null, parents: [],
    domains: node.community === null ? [] : [node.community],
    title: `Titolo ${node.id}`, title_full: `Titolo ${node.id}`,
    importance: { value: node.importance, components: {} }, size: 1,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  }));
  const rawEdges = edges.map(edge => ({
    id: edge.id, source: edge.source, target: edge.target, class: edge.attestation ?? 'attested',
    type: 'relates', directed: false, evidence: [], ...(edge.weight === undefined ? {} : { weight: edge.weight }),
  }));
  const input = {
    manifest: { fixture: 'holographic-projection-f11' },
    index: { schema: 'nousos.review-graph/2', nodes: rawNodes, edges: rawEdges },
    details: [],
  };
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
  const domain = selectAnalyticalDomain(snapshot, domainNodeIds ?? snapshot.nodes.map(node => node.id));
  return { snapshot, domain, sourceBytes: canonicalSourceBytes(input) };
}

export function requestFor(fixture: SnapshotFixture, overrides: Partial<HolographicParameters> = {}): ProjectionRequest<'holographic'> {
  return {
    id: 'holographic', snapshotDigest: fixture.snapshot.digest, domain: fixture.domain,
    parameters: { ...DEFAULT_PARAMETERS, ...overrides },
  };
}

/** Deterministic digest-seeded unit interval draw; no Math.random anywhere. */
export function unitDraw(...parts: (string | number)[]): number {
  return parseInt(digestPayload(['holographic-projection-fixture', ...parts]).slice(0, 8), 16) / 0x100000000;
}

export function pad(value: number, width = 4): string {
  return String(value).padStart(width, '0');
}

/** A knowledge-graph-shaped synthetic graph (communities with hubs, preferential internal
 * attachment, sparse cross-community bridges through the hubs). Connected by construction. */
export function syntheticKnowledgeGraph(nodeCount: number, communityCount: number, seed: string): {
  readonly nodes: SyntheticNode[];
  readonly edges: SyntheticEdge[];
} {
  const nodes: SyntheticNode[] = [];
  const edges: SyntheticEdge[] = [];
  const members: string[][] = Array.from({ length: communityCount }, () => []);
  for (let index = 0; index < nodeCount; index += 1) {
    const community = index % communityCount;
    const id = `k${pad(index)}`;
    members[community]!.push(id);
    nodes.push({ id, community: `c${pad(community, 2)}`, importance: 0.05 + 0.9 * unitDraw(seed, 'importance', index) });
  }
  let edgeOrdinal = 0;
  const link = (source: string, target: string): void => {
    edges.push({ id: `e${pad(edgeOrdinal, 5)}`, source, target });
    edgeOrdinal += 1;
  };
  const HUBS = 3;
  for (const [community, list] of members.entries()) {
    for (let slot = 1; slot < list.length; slot += 1) {
      // Preferential attachment: the first HUBS members of a community attract most links.
      const draws = slot === 1 ? 1 : 2;
      const chosen = new Set<number>();
      for (let draw = 0; draw < draws; draw += 1) {
        const roll = unitDraw(seed, 'attach', community, slot, draw);
        const target = roll < 0.6 ? Math.min(slot - 1, Math.floor(unitDraw(seed, 'hub', community, slot, draw) * HUBS))
          : Math.floor(unitDraw(seed, 'any', community, slot, draw) * slot);
        chosen.add(target);
      }
      for (const target of [...chosen].sort((a, b) => a - b)) link(list[slot]!, list[target]!);
    }
  }
  // Bridges: a ring over the community hubs guarantees connectivity, plus sparse random bridges.
  for (let community = 0; community < communityCount; community += 1) {
    link(members[community]![0]!, members[(community + 1) % communityCount]![0]!);
  }
  const bridgeCount = Math.floor(nodeCount / 40);
  for (let bridge = 0; bridge < bridgeCount; bridge += 1) {
    const a = Math.floor(unitDraw(seed, 'bridge-a', bridge) * nodeCount);
    const b = Math.floor(unitDraw(seed, 'bridge-b', bridge) * nodeCount);
    if (a !== b && a % communityCount !== b % communityCount) link(nodes[a]!.id, nodes[b]!.id);
  }
  return { nodes, edges };
}
