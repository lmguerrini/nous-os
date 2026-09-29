/** Conservation boundary for a projection and its immutable source snapshot. */
import { validateProjectionResult, validateSemanticEdgeCarriers } from './contract.ts';
import type { ProjectionValidationContext } from './contract.ts';
import { selectAnalyticalDomain } from './domain.ts';
import { assertFullLedgerHandle, assertSemanticSnapshot, canonicalLedgerBytes } from './normalize.ts';
import type { ProjectionResult } from './contract-types.ts';

export interface ConservationEvidence {
  /** Capture from canonicalSourceBytes before normalization, when available. */
  readonly expectedSourceBytes?: Uint8Array;
  /** ReviewEdge / semantic VisualGraph edges at an adapter or renderer boundary. */
  readonly semanticEdgeCarriers?: readonly Readonly<{ id: string; source: string; target: string;
    class?: string; attestation?: string }>[];
}

function requireConservation(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`projection invariant: ${message}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Recompute source and domain evidence; B3 checks coordinates, levels and visual namespaces. */
export async function assertProjectionInvariants(
  result: ProjectionResult,
  context: ProjectionValidationContext,
  evidence: ConservationEvidence = {},
): Promise<void> {
  const { snapshot, domain, request } = context;
  const before = canonicalLedgerBytes(snapshot.rawLedger);
  if (evidence.expectedSourceBytes !== undefined)
    requireConservation(sameBytes(before, evidence.expectedSourceBytes), 'source ledger bytes differ from the pre-normalizer oracle');

  await assertSemanticSnapshot(snapshot);
  await assertFullLedgerHandle(result.fullLedger, snapshot);

  requireConservation(domain.snapshotDigest === snapshot.digest, 'domain snapshot digest changed');
  const expectedDomain = selectAnalyticalDomain(snapshot, domain.nodeIds, {
    selectionPolicy: domain.selectionPolicy,
    selectionPolicyVersion: domain.selectionPolicyVersion,
    levelPolicy: domain.levelPolicy,
  });
  requireConservation(domain.domainDigest === expectedDomain.domainDigest
    && domain.maxNodes === expectedDomain.maxNodes
    && sameOrderedIds(domain.nodeIds, expectedDomain.nodeIds)
    && sameOrderedIds(domain.edgeIds, expectedDomain.edgeIds), 'domain selection, digest, cap or induced edges changed');
  requireConservation(request.domain.snapshotDigest === domain.snapshotDigest
    && request.domain.selectionPolicy === domain.selectionPolicy
    && request.domain.selectionPolicyVersion === domain.selectionPolicyVersion
    && request.domain.levelPolicy === domain.levelPolicy
    && request.domain.maxNodes === domain.maxNodes, 'request domain policy changed');

  validateProjectionResult(result, context);
  if (evidence.semanticEdgeCarriers !== undefined) {
    validateSemanticEdgeCarriers(evidence.semanticEdgeCarriers, result, snapshot);
    const edges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
    const seen = new Set<string>();
    for (const carrier of evidence.semanticEdgeCarriers) {
      requireConservation(!seen.has(carrier.id), `duplicate semantic edge carrier ${carrier.id}`);
      seen.add(carrier.id);
      const original = edges.get(carrier.id)!;
      requireConservation((carrier.class === undefined || carrier.class === original.attestation)
        && (carrier.attestation === undefined || carrier.attestation === original.attestation),
      `semantic edge carrier ${carrier.id} changed attestation`);
    }
  }

  requireConservation(sameBytes(before, canonicalLedgerBytes(snapshot.rawLedger)), 'source ledger bytes changed during validation');
}
