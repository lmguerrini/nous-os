import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  syntheticNaturalLedger, type SyntheticNaturalLedger,
} from './natural-synthetic-graph.ts';
import {
  canonicalLedgerBytes, canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger,
} from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { validateProjectionResult } from '../../src/projection/contract.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import {
  NATURAL_LAYOUT_VERSION, naturalProjection, resolveNaturalArrangement,
} from '../../src/projection/natural-bridge.ts';
import type {
  AnalyticalDomain, Dimension, NaturalArrangement, ProjectionRequest, ProjectionResult,
  SemanticGraphSnapshot, VisualRelation,
} from '../../src/projection/contract-types.ts';

/**
 * D-073 C7 property suite for the Natural bridge, over deterministic seeded synthetic ledgers
 * (the fixture module documents that no real or private data appears). The existing
 * `natural-bridge.test.ts` pins coordinate parity and digest behaviour against the D-072 page
 * path; this file adds the conservation, style-invariance, determinism and negative-control
 * properties of the full matrix 2D/3D × stellar/neural/mycelium × constellation/network/mycelium
 * on graphs that also exercise level-5 passage materialization, both attestation classes and
 * multi-domain memberships.
 */

const ARRANGEMENTS: readonly NaturalArrangement[] = ['constellation', 'network', 'mycelium'];
const STYLES = ['stellar', 'neural', 'mycelium'] as const;
const POLICIES = ['attested-essential', 'combined-essential'] as const;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type NaturalParameters = ProjectionRequest<'natural'>['parameters'];
type NaturalPolicy = NaturalParameters['layoutRelationPolicy'];

interface NaturalCase {
  readonly input: SyntheticNaturalLedger;
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  /** Pre-normalizer oracle bytes, captured before any typed view exists. */
  readonly oracleBytes: Uint8Array;
}

async function materialize(input: SyntheticNaturalLedger): Promise<NaturalCase> {
  const oracleBytes = canonicalSourceBytes(input);
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input), input.passageIds);
  const domain = selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id));
  return { input, snapshot, domain, oracleBytes };
}

function naturalRequest(domain: AnalyticalDomain, overrides: Partial<NaturalParameters> = {}): ProjectionRequest<'natural'> {
  return {
    id: 'natural',
    snapshotDigest: domain.snapshotDigest,
    domain,
    parameters: {
      dimension: '2d',
      arrangement: 'constellation',
      layoutVersion: NATURAL_LAYOUT_VERSION,
      layoutRelationPolicy: 'combined-essential',
      volumeExpansion: { x: 1.15, y: 0.95, z: 1.3 },
      ...overrides,
    },
  };
}

function witnessesOf(result: ProjectionResult) {
  return {
    levels: {},
    liftedRouteEdgeIds: Object.fromEntries(result.visualRelations
      .filter(relation => relation.kind === 'lifted-route')
      .map(relation => [relation.visualId, relation.underlyingEdgeIds])),
  };
}

/**
 * The independent conservation oracle: every domain node exactly once, no invented node or edge,
 * visual relations non-semantic with real underlying source edges, and attested/exploratory kept
 * distinct. Deliberately recomputes everything from the snapshot instead of trusting the result.
 */
function assertNaturalConservation(
  result: ProjectionResult,
  snapshot: SemanticGraphSnapshot,
  policy: NaturalPolicy,
): void {
  const expectedNodes = snapshot.nodes.map(node => node.id).sort(compare);
  assert.deepEqual(result.domainNodeIds, expectedNodes, 'domain membership differs from the source ledger');
  assert.equal(new Set(result.domainNodeIds).size, expectedNodes.length, 'a domain node appears more than once');
  const member = new Set(result.domainNodeIds);
  const expectedEdges = snapshot.edges
    .filter(edge => member.has(edge.source) && member.has(edge.target))
    .map(edge => edge.id).sort(compare);
  assert.deepEqual(result.domainEdgeIds, expectedEdges, 'domain edges differ from the induced source edges');

  assert.deepEqual([...result.loadedNodeIds].sort(compare), expectedNodes, 'Natural loads its whole domain');
  const positions = result.positions2 ?? result.positions3!;
  assert.deepEqual(Object.keys(positions).sort(compare), expectedNodes, 'coordinate keys differ from the domain');
  assert.equal(result.positions2 !== undefined && result.positions3 !== undefined, false, 'both dimensional maps present');
  for (const [id, point] of Object.entries(positions)) {
    const coordinate = point as { readonly x: number; readonly y: number; readonly z?: number };
    assert.ok(Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y), `nonfinite coordinate ${id}`);
    if (result.positions3 !== undefined) assert.ok(Number.isFinite(coordinate.z), `nonfinite z for ${id}`);
    else assert.equal('z' in coordinate, false, `2D coordinate ${id} carries z`);
  }

  const sourceEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  const sourceNodeIds = new Set(snapshot.nodes.map(node => node.id));
  const seenVisual = new Set<string>();
  for (const relation of result.visualRelations) {
    assert.equal(relation.semantic, false, `visual relation ${relation.visualId} became semantic`);
    assert.ok(relation.visualId.startsWith('visual:'), `visual relation ${relation.visualId} left the reserved namespace`);
    assert.ok(!sourceNodeIds.has(relation.visualId) && !sourceEdges.has(relation.visualId),
      `visual relation ${relation.visualId} collides with a source id`);
    assert.ok(!seenVisual.has(relation.visualId), `duplicate visual relation ${relation.visualId}`);
    seenVisual.add(relation.visualId);
    assert.ok(member.has(relation.source) && member.has(relation.target),
      `visual relation ${relation.visualId} has an endpoint outside the domain`);
    const unique = new Set(relation.underlyingEdgeIds);
    assert.equal(unique.size, relation.underlyingEdgeIds.length,
      `visual relation ${relation.visualId} repeats a contributor`);
    for (const id of relation.underlyingEdgeIds) {
      const edge = sourceEdges.get(id);
      assert.ok(edge !== undefined, `visual relation ${relation.visualId} names invented edge ${id}`);
    }
    if (relation.kind === 'lifted-route') {
      assert.ok(relation.underlyingEdgeIds.length > 0, `lifted route ${relation.visualId} has no underlying edge`);
      assert.equal(relation.count, relation.underlyingEdgeIds.length,
        `lifted route ${relation.visualId} count differs from its contributors`);
      const classes = new Set(relation.underlyingEdgeIds.map(id => sourceEdges.get(id)!.attestation));
      assert.equal(classes.size, 1, `attested and exploratory mix inside lifted route ${relation.visualId}`);
      if (policy === 'attested-essential') {
        assert.equal([...classes][0], 'attested',
          `attested-only reading lifted an exploratory edge in ${relation.visualId}`);
      }
    } else if (relation.kind === 'synthetic-containment') {
      assert.equal(relation.underlyingEdgeIds.length, 0,
        `synthetic containment ${relation.visualId} claims source edges`);
    }
  }

  // The immutable source keeps its two attestation classes distinct, byte for byte.
  for (const edge of snapshot.edges) {
    assert.equal(edge.attestation, edge.rawEdge.raw.class, `edge ${edge.id} changed attestation class`);
  }
}

test('the seeded synthetic fixtures carry both attestation classes and materialized passages', async () => {
  for (const seed of [20260930, 7331, 4242]) {
    const { snapshot } = await materialize(syntheticNaturalLedger(seed));
    const classes = new Set(snapshot.edges.map(edge => edge.attestation));
    assert.deepEqual([...classes].sort(), ['attested', 'exploratory'], `seed ${seed} needs both edge classes`);
    const passages = snapshot.nodes.filter(node => node.sourceKind === 'detail-passage');
    assert.ok(passages.length > 0, `seed ${seed} materializes level-5 passage display nodes`);
    assert.ok(snapshot.nodes.some(node => node.communityIds.length > 1), `seed ${seed} has a multi-domain membership`);
  }
});

test('full matrix 2D/3D × arrangements × policies conserves domain, source and relations', async () => {
  for (const seed of [20260930, 7331]) {
    const { snapshot, domain, oracleBytes } = await materialize(syntheticNaturalLedger(seed));
    const ledgerDigestBefore = snapshot.rawLedger.canonicalBytesDigest;
    const ledgerBytesBefore = canonicalLedgerBytes(snapshot.rawLedger);
    for (const dimension of ['2d', '3d'] as const) for (const arrangement of ARRANGEMENTS)
      for (const layoutRelationPolicy of POLICIES) {
        const request = naturalRequest(domain, { dimension, arrangement, layoutRelationPolicy });
        const result = await naturalProjection.project(snapshot, request);
        assertNaturalConservation(result, snapshot, layoutRelationPolicy);
        const witnesses = witnessesOf(result);
        validateProjectionResult(result, { snapshot, domain, request, witnesses });
        await assertProjectionInvariants(result, { snapshot, domain, request, witnesses }, { expectedSourceBytes: oracleBytes });
        assert.equal(snapshot.rawLedger.canonicalBytesDigest, ledgerDigestBefore,
          `${dimension}/${arrangement}: the projection changed the source ledger digest`);
        const bytesAfter = canonicalLedgerBytes(snapshot.rawLedger);
        assert.equal(bytesAfter.length === ledgerBytesBefore.length
          && bytesAfter.every((byte, index) => byte === ledgerBytesBefore[index]), true,
          `${dimension}/${arrangement}: the projection changed the source ledger bytes`);
      }
  }
});

test('for one fixed arrangement the three styles give identical coordinates and result digest', async () => {
  const { snapshot, domain } = await materialize(syntheticNaturalLedger(20260930));
  const digests = new Set<string>();
  for (const dimension of ['2d', '3d'] as const) for (const arrangement of ARRANGEMENTS) {
    const request = naturalRequest(domain, { dimension, arrangement });
    const reference = await naturalProjection.project(snapshot, request);
    digests.add(reference.determinism.resultDigest);
    for (const style of STYLES) {
      // G1: an explicit arrangement is never replaced by the style default, so a style switch is a restyle only.
      assert.equal(resolveNaturalArrangement(style, arrangement), arrangement);
      const styled = await naturalProjection.project(snapshot,
        naturalRequest(domain, { ...request.parameters, arrangement: resolveNaturalArrangement(style, arrangement) }));
      assert.deepEqual(styled, reference, `${dimension}/${arrangement}/${style} restyled the coordinates`);
      assert.equal(styled.determinism.resultDigest, reference.determinism.resultDigest);
    }
  }
  assert.equal(digests.size, 6, 'each dimension/arrangement pair has its own digest');
});

test('the digest and coordinates repeat for an identical Natural request', async () => {
  const base = await materialize(syntheticNaturalLedger(4242));
  const request = naturalRequest(base.domain, { dimension: '3d', arrangement: 'network' });
  const first = await naturalProjection.project(base.snapshot, request);
  const repeat = await naturalProjection.project(base.snapshot, request);
  assert.deepEqual(repeat, first, 'a repeated request changed the result');
  assert.equal(repeat.determinism.resultDigest, first.determinism.resultDigest);
  assert.equal(repeat.determinism.parameterHash, first.determinism.parameterHash);
});

test('negative controls: a dropped node, an invented edge and a semantic relation each fail the property checks', async () => {
  const input = syntheticNaturalLedger(20260930);
  const { snapshot, domain } = await materialize(input);
  const request = naturalRequest(domain, { dimension: '3d', arrangement: 'constellation' });
  const result = await naturalProjection.project(snapshot, request);
  const witnesses = witnessesOf(result);

  const invented = structuredClone(result) as any;
  const inventedRoute = invented.visualRelations.find((relation: VisualRelation) => relation.kind === 'lifted-route')!;
  inventedRoute.underlyingEdgeIds = [...inventedRoute.underlyingEdgeIds, 'synthetic-invented-edge'];
  assert.throws(() => assertNaturalConservation(invented, snapshot, 'combined-essential'), /invented edge/);
  assert.throws(() => validateProjectionResult(invented, { snapshot, domain, request, witnesses: witnessesOf(invented) }),
    /out-of-domain or unknown ID/);

  const semantic = structuredClone(result) as any;
  semantic.visualRelations.find((relation: VisualRelation) => relation.kind === 'lifted-route')!.semantic = true;
  assert.throws(() => assertNaturalConservation(semantic, snapshot, 'combined-essential'), /became semantic/);
  assert.throws(() => validateProjectionResult(semantic, { snapshot, domain, request, witnesses }),
    /became semantic/);

  const dropped = structuredClone(result) as any;
  delete dropped.positions3![dropped.loadedNodeIds[5]!];
  assert.throws(() => assertNaturalConservation(dropped, snapshot, 'combined-essential'), /coordinate keys differ/);
  assert.throws(() => validateProjectionResult(dropped, { snapshot, domain, request, witnesses }),
    /coordinate keys/);

  // A fixture that dropped a source node breaks conservation at the boundary itself.
  const referenced = new Set<string>();
  for (const edge of input.index.edges) { referenced.add(edge.source as string); referenced.add(edge.target as string); }
  for (const detail of input.details) referenced.add(detail.parent as string);
  const droppedNodeId = input.index.nodes.find(node => !referenced.has(node.id as string))!.id as string;
  const mutatedInput: SyntheticNaturalLedger = {
    ...input,
    index: { ...input.index, nodes: input.index.nodes.filter(node => node.id !== droppedNodeId) },
  };
  const mutated = await materialize(mutatedInput);
  assert.equal(mutated.snapshot.nodes.length, snapshot.nodes.length - 1);
  assert.throws(() => selectAnalyticalDomain(mutated.snapshot, input.nodeIds), /absent from snapshot/);
  const mutatedRequest = naturalRequest(mutated.domain, { dimension: '3d', arrangement: 'constellation' });
  const mutatedResult = await naturalProjection.project(mutated.snapshot, mutatedRequest);
  assert.throws(() => assertNaturalConservation(mutatedResult, snapshot, 'combined-essential'),
    /domain membership differs from the source ledger/);
  assert.throws(() => validateProjectionResult(mutatedResult,
    { snapshot, domain, request, witnesses: witnessesOf(mutatedResult) }), /projection contract/);
});
