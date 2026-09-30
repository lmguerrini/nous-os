import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger, canonicalLedgerBytes } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { validateProjectionResult, type ProjectionValidationContext } from '../../src/projection/contract.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import type { ProjectionId, ProjectionParameters, ProjectionRequest, ProjectionResult, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import { naturalProjection, NATURAL_LAYOUT_VERSION } from '../../src/projection/natural-bridge.ts';
import { indrasPearlsProjection, INDRA_GENERATOR_POLICY } from '../../src/projection/indra.ts';
import { fractalProjection } from '../../src/projection/fractal.ts';
import { certifyFractalDynamics, fractalContractParameters } from '../../src/fractal/parameters.ts';
import { holographicProjection } from '../../src/projection/holographic.ts';
import { EIGENSPACE_POLICY_VERSION } from '../../src/holographic/geometry.ts';
import { pearlMemberDigest } from '../../src/indra/assignment.ts';
import { FRACTAL_LEVEL_MEMBERSHIP_POLICY } from '../../src/projection/fractal.ts';
import { digestPayload } from '../../src/engine/digest.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** One fully synthetic, deterministic six-community hierarchy shared by every projection. */
async function fixture() {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let ordinal = 0;
  const addNode = (id: string, level: number, parent: string | null) => {
    nodes.push({ id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
      title: `Synthetic ${id}`, title_full: `Synthetic ${id}`, status: id === 'n:0' ? 'canon' : 'candidate',
      importance: { value: (ordinal++ + 1) / 100, components: { fixture: 1 } }, size: 1,
      counts: { children: 0, descendants: 0, canon: 0, passages: 0 }, context: id.endsWith(':01') ? null : { fixture: id } });
  };
  const addEdge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory') => {
    edges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [{ fixture: id }] });
  };
  for (let c = 0; c < 6; c++) {
    const root = `n:${c}`;
    addNode(root, 1, null);
    for (let j = 1; j <= 4; j++) {
      const child = `${root}:${pad(j)}`;
      addNode(child, 2, root);
      addEdge(`e:${root}:${pad(j)}`, root, child, 'attested');
      const leaves = j === 1 ? 3 : j === 2 ? 2 : 0;
      for (let k = 1; k <= leaves; k++) {
        const leaf = `${child}:${pad(k)}`;
        addNode(leaf, 3, child);
        addEdge(`e:${child}:${pad(k)}`, child, leaf, (k + c) % 4 === 0 ? 'exploratory' : 'attested');
        if (k > 1) addEdge(`e:${child}:chain:${pad(k)}`, `${child}:${pad(k - 1)}`, leaf, 'attested');
      }
      if (j > 1) addEdge(`e:${root}:chain:${pad(j)}`, `${root}:${pad(j - 1)}`, child, 'attested');
    }
  }
  // A real inter-community edge exercises lifted-route contributor checks.
  addEdge('e:cross:01', 'n:0:01:01', 'n:1:01:01', 'exploratory');
  const input = { manifest: { fixture: 'views-invariants-g1', version: 1 },
    index: { schema: 'nousos.review-graph/2', nodes, edges }, details: [] as Record<string, unknown>[] };
  const sourceBytes = canonicalSourceBytes(input);
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
  const domain = selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id));
  return { input, sourceBytes, snapshot, domain };
}

function requestFor(id: ProjectionId, dimension: '2d' | '3d', snapshot: SemanticGraphSnapshot,
  domain: Awaited<ReturnType<typeof fixture>>['domain']): ProjectionRequest {
  const base = { id, snapshotDigest: snapshot.digest, domain };
  switch (id) {
    case 'natural': return { ...base, id, parameters: { dimension, arrangement: 'network', layoutVersion: NATURAL_LAYOUT_VERSION,
      layoutRelationPolicy: 'combined-essential', volumeExpansion: { x: 1, y: 1, z: 1.2 } } };
    case 'indras-pearls': return { ...base, id, parameters: { dimension, maxDepth: 2, maxWords: 120,
      generatorPolicy: INDRA_GENERATOR_POLICY, tolerance: 1e-6, expandZ: 1 } };
    case 'fractal': {
      const attestedEdgeCount = snapshot.edges.filter(edge => edge.attestation === 'attested' && domain.edgeIds.includes(edge.id)).length;
      const certification = certifyFractalDynamics({ communityCount: 6, domainNodeCount: domain.nodeIds.length, attestedEdgeCount });
      if (!certification.certified) throw new Error(`synthetic fixture dynamics refused: ${certification.code}`);
      return { ...base, id, parameters: { ...fractalContractParameters(certification, domain.nodeIds.length), dimension } };
    }
    case 'holographic': return { ...base, id, parameters: { dimension, modes: 3, restartSize: 16, maxRestarts: 3,
      eigenTolerance: 1e-8, eigenspacePolicyVersion: EIGENSPACE_POLICY_VERSION, heatTimes: [0, 0.5], ridge: 0.01,
      signalId: 'importance' } };
  }
}

function witnessesFor(result: ProjectionResult, domainNodeIds: readonly string[]) {
  const levels: Record<string, { memberNodeIds: readonly string[]; memberDigest: string }> = {};
  for (const level of result.levels) {
    const memberNodeIds = level.loaded ? [...level.memberNodeIds] : domainNodeIds.slice(0, level.memberCount);
    let memberDigest: string;
    if (level.id.startsWith('indra-level-')) {
      // Indra's level digest includes the reduced word; preserve the projection's declared witness.
      memberDigest = level.memberDigest ?? digestPayload({ members: [...memberNodeIds].sort() });
    } else if (level.id.startsWith('fractal:')) {
      memberDigest = digestPayload({ policy: FRACTAL_LEVEL_MEMBERSHIP_POLICY, members: [...memberNodeIds].sort() });
    } else memberDigest = level.memberDigest ?? digestPayload({ members: [...memberNodeIds].sort() });
    levels[level.id] = { memberNodeIds, memberDigest };
  }
  const liftedRouteEdgeIds = Object.fromEntries(result.visualRelations.filter(relation => relation.kind === 'lifted-route')
    .map(relation => [relation.visualId, [...relation.underlyingEdgeIds]]));
  return { levels, liftedRouteEdgeIds };
}

const projections = {
  natural: naturalProjection,
  'indras-pearls': indrasPearlsProjection,
  fractal: fractalProjection,
  holographic: holographicProjection,
} as const;

test('four projection views preserve semantics and determinism in 2D and 3D', async () => {
  const started = performance.now();
  const fx = await fixture();
  const requirementFailures: string[] = [];
  let refusalCount = 0;
  const before = new Uint8Array(fx.sourceBytes);
  assert.deepEqual([...canonicalLedgerBytes(fx.snapshot.rawLedger)], [...before]);
  assert.deepEqual(new Set(fx.snapshot.edges.map(edge => edge.attestation)), new Set(['attested', 'exploratory']));
  assert.deepEqual(new Set(fx.snapshot.nodes.map(node => node.standing)), new Set(['canonical', 'candidate']));

  for (const id of Object.keys(projections) as ProjectionId[]) for (const dimension of ['2d', '3d'] as const) {
    const request = requestFor(id, dimension, fx.snapshot, fx.domain);
    const projection = projections[id] as { project(snapshot: SemanticGraphSnapshot, request: ProjectionRequest): Promise<ProjectionResult> };
    const result = await projection.project(fx.snapshot, request);
    const repeated = await projection.project(fx.snapshot, request);
    assert.equal(result.determinism.resultDigest, repeated.determinism.resultDigest, `${id}/${dimension} digest`);
    assert.equal(result.determinism.parameterHash, repeated.determinism.parameterHash, `${id}/${dimension} parameters`);
    assert.equal(result.coordinateState.kind, repeated.coordinateState.kind);
    const context: ProjectionValidationContext = { snapshot: fx.snapshot, domain: fx.domain, request,
      witnesses: witnessesFor(result, fx.domain.nodeIds) };
    validateProjectionResult(result, context);
    await assertProjectionInvariants(result, context, { expectedSourceBytes: before });

    assert.deepEqual([...canonicalLedgerBytes(fx.snapshot.rawLedger)], [...before], `${id}/${dimension} source bytes`);
    const semanticIds = new Set([...fx.snapshot.nodes.map(node => node.id), ...fx.snapshot.edges.map(edge => edge.id)]);
    for (const item of [...result.containers, ...result.visualRelations, ...result.curves])
      assert.ok(!semanticIds.has(item.visualId), `${id}/${dimension} visual ID collision ${item.visualId}`);
    for (const field of result.fields) assert.ok(!semanticIds.has(field.id), `${id}/${dimension} field ID collision ${field.id}`);
    for (const relation of result.visualRelations) {
      assert.equal(relation.semantic, false, `${id}/${dimension} semantic visual relation`);
      // Contract (contract-types.ts VisualRelation, contract.ts validator): a lifted route needs its real contributing edges;
      // an empty list is legal only for structural visuals (co-membership, synthetic containment).
      if (relation.kind === 'lifted-route' && relation.underlyingEdgeIds.length === 0) requirementFailures.push(`${id}/${dimension} ${relation.kind} ${relation.visualId} has no underlying edge ID`);
      for (const edgeId of relation.underlyingEdgeIds) assert.ok(fx.domain.edgeIds.includes(edgeId), `${id}/${dimension} invented edge ${edgeId}`);
    }
    for (const visual of [...result.containers.map(x => [x.visualId, x.visualId] as const),
      ...result.visualRelations.map(x => [x.visualId, x.explanationId] as const)])
      assert.ok(result.explanations[visual[1]], `${id}/${dimension} ${visual[0]} explanation missing`);
    for (const curve of result.curves) assert.ok(curve.points2 || curve.points3, `${id}/${dimension} curve lacks declared geometry`);
    for (const field of result.fields) assert.ok(result.explanations[field.id] || field.units.length > 0,
      `${id}/${dimension} field lacks explanation/derived declaration`);
    for (const edge of fx.snapshot.edges) assert.ok(['attested', 'exploratory'].includes(edge.attestation));
    for (const relation of result.visualRelations) assert.notEqual((relation as { attestation?: string }).attestation, 'attested');
    if (result.coordinateState.kind === 'no-coordinates') {
      refusalCount += 1;
      assert.deepEqual(result.loadedNodeIds, []);
      assert.equal(Object.hasOwn(result, 'positions2'), false);
      assert.equal(Object.hasOwn(result, 'positions3'), false);
    }

    // Each requested tamper must be rejected by the production contract/conservation checks.
    const reject = async (tampered: ProjectionResult, why: string) => {
      const changedContext = { ...context, witnesses: witnessesFor(tampered, fx.domain.nodeIds) };
      await assert.rejects(assertProjectionInvariants(tampered, changedContext, { expectedSourceBytes: before }),
        /projection (?:invariant|contract):/, `${id}/${dimension}: ${why}`);
    };
    const baseRelation = result.visualRelations[0] ?? {
      visualId: `visual:g1:negative:${id}:${dimension}`, kind: 'lifted-route' as const, semantic: false as const,
      source: fx.domain.nodeIds[0]!, target: fx.domain.nodeIds[1]!, underlyingEdgeIds: [fx.domain.edgeIds[0]!],
      count: 1, explanationId: `visual:g1:negative:${id}:${dimension}`,
    };
    const prefixRelations = result.visualRelations.length > 0 ? result.visualRelations.slice(1) : [];
    const relationResult = (relation: typeof baseRelation): ProjectionResult => ({ ...result,
      visualRelations: [relation, ...prefixRelations], explanations: { ...result.explanations,
        [relation.explanationId]: result.explanations[relation.explanationId] ?? {
          elementId: relation.visualId, elementKind: 'visual-relation', summary: 'negative control', sourceIds: [], parameterIds: [],
        } } });
    await reject(relationResult({ ...baseRelation, underlyingEdgeIds: ['invented-edge'] }), 'invented edge ID');
    await reject(relationResult({ ...baseRelation, semantic: true as false }), 'semantic visual relation');
    if (result.coordinateState.kind === 'coordinates') {
      const droppedId = result.loadedNodeIds[0]!;
      const dropped = { ...result, domainNodeIds: result.domainNodeIds.filter(id => id !== droppedId),
        loadedNodeIds: result.loadedNodeIds.filter(id => id !== droppedId),
        ...(dimension === '2d' ? { positions2: Object.fromEntries(Object.entries(result.positions2!).filter(([id]) => id !== droppedId)) }
          : { positions3: Object.fromEntries(Object.entries(result.positions3!).filter(([id]) => id !== droppedId)) }) };
      await reject(dropped, 'dropped domain node');
    }
    const loaded = result.levels.find(level => level.loaded);
    if (loaded?.loaded) {
      const members = loaded.memberNodeIds;
      const duplicate = { ...result, levels: result.levels.map(level => level.id === loaded.id
        ? { ...level, memberNodeIds: [...members, members[0]!] } : level) };
      await reject(duplicate, 'duplicated loaded member');
    }
  }
  assert.ok(performance.now() - started < 30_000, `suite exceeded 30 s: ${(performance.now() - started).toFixed(1)} ms`);
  assert.ok(refusalCount > 0, 'matrix must exercise a typed no-coordinate refusal');
  assert.equal(requirementFailures.length, 0,
    `every visual relation must cite at least one real source edge; found ${requirementFailures.length}: ${requirementFailures.slice(0, 3).join('; ')}`);
});
