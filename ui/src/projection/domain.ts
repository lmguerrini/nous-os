import { digestPayload } from '../engine/digest.ts';
import { V2_CAP, v2Visible } from '../review/v2-core.ts';
import type { DisclosureState, V2Index } from '../review/v2-core.ts';
import type { AnalyticalDomain, NodeId, SemanticGraphSnapshot } from './contract-types.ts';

/** The disclosure policy is part of the cache identity, independently of visual LOD. */
export const DISCLOSED_DOMAIN_POLICY = 'v2-visible-disclosed';
export const DISCLOSED_DOMAIN_VERSION = '1';
export const DISCLOSED_LEVEL_POLICY = 'v2-visible-pages-v1';

export interface DomainSelectionOptions {
  readonly selectionPolicy?: string;
  readonly selectionPolicyVersion?: string;
  readonly levelPolicy?: string;
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

/** Select from the full immutable snapshot. The result contains identity only, never geometry. */
export function selectAnalyticalDomain(
  snapshot: SemanticGraphSnapshot,
  disclosedNodeIds: Iterable<NodeId>,
  options: DomainSelectionOptions = {},
): AnalyticalDomain {
  const selectionPolicy = options.selectionPolicy ?? DISCLOSED_DOMAIN_POLICY;
  const selectionPolicyVersion = options.selectionPolicyVersion ?? DISCLOSED_DOMAIN_VERSION;
  const levelPolicy = options.levelPolicy ?? DISCLOSED_LEVEL_POLICY;
  if (!snapshot.digest || !selectionPolicy || !selectionPolicyVersion || !levelPolicy) {
    throw new Error('Analytical domain requires a snapshot digest and named policies');
  }

  const selected = new Set<NodeId>();
  for (const id of disclosedNodeIds) {
    if (typeof id !== 'string' || !id) throw new Error('Invalid disclosed node ID');
    if (selected.has(id)) throw new Error(`Duplicate disclosed node ID: ${id}`);
    selected.add(id);
    if (selected.size > V2_CAP) throw new Error(`Analytical domain exceeds ${V2_CAP} nodes`);
  }

  const fullNodeIds = new Set<NodeId>();
  for (const node of snapshot.nodes) {
    if (fullNodeIds.has(node.id)) throw new Error(`Duplicate snapshot node ID: ${node.id}`);
    fullNodeIds.add(node.id);
  }
  for (const id of selected) {
    if (!fullNodeIds.has(id)) throw new Error(`Disclosed node is absent from snapshot: ${id}`);
  }

  const nodeIds = [...selected].sort(codepointOrder);
  const edgeIds: string[] = [];
  const seenEdges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (seenEdges.has(edge.id)) throw new Error(`Duplicate snapshot edge ID: ${edge.id}`);
    seenEdges.add(edge.id);
    if (selected.has(edge.source) && selected.has(edge.target)) edgeIds.push(edge.id);
  }
  edgeIds.sort(codepointOrder);

  const domainDigest = digestPayload({ snapshotDigest: snapshot.digest, selectionPolicy,
    selectionPolicyVersion, levelPolicy, nodeIds });
  return Object.freeze({ snapshotDigest: snapshot.digest, domainDigest, selectionPolicy,
    selectionPolicyVersion, levelPolicy, nodeIds: Object.freeze(nodeIds),
    edgeIds: Object.freeze(edgeIds), maxNodes: V2_CAP });
}

/** Use the existing progressive disclosure semantics, including its 850-node cap. */
export function selectDisclosedAnalyticalDomain(
  snapshot: SemanticGraphSnapshot,
  index: V2Index,
  disclosure: DisclosureState,
  auto: ReadonlySet<string> = new Set(),
): AnalyticalDomain {
  const visible = v2Visible(index, disclosure, auto, V2_CAP);
  return selectAnalyticalDomain(snapshot, visible.nodes.map((node) => node.id));
}
