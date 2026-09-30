/**
 * Fractal projection assembly tests (tranche E6): complete ProjectionResult, contract validator,
 * conservation oracle, determinism (repeat + permuted snapshot arrays), the 3D labelled scalar
 * lift, G5.1 giant subdivision through real sub-communities only, and the negative controls
 * demanded by the tranche plan: an uncertified `c` refused, an inverse-ray residual above
 * tolerance refused, and `request.abort` honoured.
 *
 * The fixture is a synthetic raw ledger with two real top-level communities: a 39/54 giant whose
 * real primary-hierarchy children are two group children (20 and 16 members) plus two leaf
 * children, and a 15-member path community. Edges are original attested path/cross edges plus one
 * exploratory edge; the locality order of the residual span stays in the dense backend range.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { validateProjectionResult, type ProjectionValidationContext } from '../../src/projection/contract.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import {
  certifiedDynamicsForRequest, FRACTAL_LEVEL_MEMBERSHIP_POLICY, FRACTAL_PROJECTION_VERSION,
  fractalChildLevelId, fractalCommunityLevelId, fractalContainerId, fractalProjection,
  fractalResidualLevelId, fractalResidualContainerId, fractalSubContainerId, fractalRefusalProjection,
} from '../../src/projection/fractal.ts';
import { codepointCompare, FRACTAL_ASSIGNMENT_VERSION } from '../../src/fractal/assignment.ts';
import { BOTCHER_VERSION } from '../../src/fractal/botcher.ts';
import { INVERSE_RAYS_VERSION } from '../../src/fractal/inverse-rays.ts';
import { certifyFractalDynamics, displayScaleForCount, fractalContractParameters, potentialRangeForCount, type CertifiedFractalDynamics } from '../../src/fractal/parameters.ts';
import { FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION } from '../../src/fractal/explain.ts';
import { digestPayload } from '../../src/engine/digest.ts';
import type {
  AnalyticalDomain, ProjectionRequest, SemanticGraphSnapshot,
} from '../../src/projection/contract-types.ts';

const NODE_COUNT = 54;
const G1_LEAVES = 19;
const G2_LEAVES = 15;
const B_LEAVES = 14;
const pad = (value: number): string => String(value).padStart(2, '0');

function rawNode(id: string, level: 1 | 2 | 3, parent: string | null, importance: number): Record<string, unknown> {
  return {
    id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
    title: `Titolo ${id}`, title_full: `Titolo ${id}`,
    importance: { value: importance, components: {} }, size: 1,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  };
}

/** Independent derivation of the community structure from the snapshot parent chains. */
interface CommunityStructure {
  readonly membersByCommunity: ReadonlyMap<string, readonly string[]>;
  readonly groupChildrenByCommunity: ReadonlyMap<string, readonly Readonly<{ childId: string; members: readonly string[] }>[]>;
  readonly residualByCommunity: ReadonlyMap<string, readonly string[]>;
}

function independentCommunityStructure(snapshot: SemanticGraphSnapshot, domainIds: readonly string[]): CommunityStructure {
  const parentOf = new Map<string, string | null>();
  for (const node of snapshot.nodes) parentOf.set(node.id, node.parentId);
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentOf.get(current);
      if (parent === null || parent === undefined || !parentOf.has(parent)) return current;
      current = parent;
    }
    throw new Error(`parent cycle at ${current}`);
  };
  const membersByRoot = new Map<string, string[]>();
  for (const id of domainIds) {
    const root = rootOf(id);
    const list = membersByRoot.get(root);
    if (list === undefined) membersByRoot.set(root, [id]);
    else list.push(id);
  }
  const membersByCommunity = new Map<string, readonly string[]>();
  const groupChildrenByCommunity = new Map<string, readonly { childId: string; members: readonly string[] }[]>();
  const residualByCommunity = new Map<string, readonly string[]>();
  for (const [root, unsorted] of membersByRoot) {
    const members = [...unsorted].sort(codepointCompare);
    membersByCommunity.set(root, members);
    // Walk each non-root member up to the root child it descends through; that child's set
    // (itself included) is exactly the real primary-hierarchy child membership.
    const membersOfChild = new Map<string, string[]>();
    for (const member of members) {
      if (member === root) continue;
      let current = member;
      while (parentOf.get(current) !== root) current = parentOf.get(current)!;
      const list = membersOfChild.get(current);
      if (list === undefined) membersOfChild.set(current, [member]);
      else list.push(member);
    }
    const groups: { childId: string; members: string[] }[] = [];
    const covered = new Set<string>();
    for (const childId of [...membersOfChild.keys()].sort(codepointCompare)) {
      const childMembers = [...membersOfChild.get(childId)!].sort(codepointCompare);
      if (childMembers.length >= 2) {
        groups.push({ childId, members: childMembers });
        for (const id of childMembers) covered.add(id);
      }
    }
    groupChildrenByCommunity.set(root, groups);
    residualByCommunity.set(root, members.filter(id => !covered.has(id)));
  }
  return { membersByCommunity, groupChildrenByCommunity, residualByCommunity };
}

interface Fixture {
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  readonly request: ProjectionRequest<'fractal'>;
  readonly sourceBytes: Uint8Array;
  readonly dynamics: CertifiedFractalDynamics;
  readonly structure: CommunityStructure;
}

let fixturePromise: Promise<Fixture> | undefined;

function fixture(): Promise<Fixture> {
  fixturePromise ??= (async (): Promise<Fixture> => {
    const rawNodes: Record<string, unknown>[] = [];
    const rawEdges: Record<string, unknown>[] = [];
    let importanceIndex = 0;
    const nextImportance = (): number => ((importanceIndex++ * 29) % NODE_COUNT + 1) / (NODE_COUNT + 1);
    const addNode = (id: string, level: 1 | 2 | 3, parent: string | null): void => {
      rawNodes.push(rawNode(id, level, parent, nextImportance()));
    };
    const addEdge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory'): void => {
      rawEdges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
    };

    addNode('n:a', 1, null);
    addNode('n:a:g1', 2, 'n:a');
    for (let index = 1; index <= G1_LEAVES; index += 1) addNode(`n:a:g1:c${pad(index)}`, 3, 'n:a:g1');
    addNode('n:a:g2', 2, 'n:a');
    for (let index = 1; index <= G2_LEAVES; index += 1) addNode(`n:a:g2:c${pad(index)}`, 3, 'n:a:g2');
    addNode('n:a:l1', 2, 'n:a');
    addNode('n:a:l2', 2, 'n:a');
    addNode('n:b', 1, null);
    for (let index = 1; index <= B_LEAVES; index += 1) addNode(`n:b:p${pad(index)}`, 2, 'n:b');

    let edgeOrdinal = 0;
    const chain = (ids: readonly string[]): void => {
      for (let index = 0; index + 1 < ids.length; index += 1) {
        edgeOrdinal += 1;
        addEdge(`att:${pad(edgeOrdinal)}`, ids[index]!, ids[index + 1]!, 'attested');
      }
    };
    chain(['n:a:g1', ...Array.from({ length: G1_LEAVES }, (_, index) => `n:a:g1:c${pad(index + 1)}`)]);
    chain(['n:a:g2', ...Array.from({ length: G2_LEAVES }, (_, index) => `n:a:g2:c${pad(index + 1)}`)]);
    chain(['n:b', ...Array.from({ length: B_LEAVES }, (_, index) => `n:b:p${pad(index + 1)}`)]);
    edgeOrdinal += 1;
    addEdge(`att:${pad(edgeOrdinal)}`, 'n:a', 'n:a:l1', 'attested');
    edgeOrdinal += 1;
    addEdge(`att:${pad(edgeOrdinal)}`, 'n:a', 'n:a:l2', 'attested');
    edgeOrdinal += 1;
    addEdge(`att:${pad(edgeOrdinal)}`, 'n:a:l1', 'n:b', 'attested');
    addEdge('exp:01', 'n:a:g1:c01', 'n:a:g2:c01', 'exploratory');

    const input = {
      manifest: { fixture: 'fractal-projection-e6' },
      index: { schema: 'nousos.review-graph/2', nodes: rawNodes, edges: rawEdges },
      details: [],
    };
    const sourceBytes = canonicalSourceBytes(input);
    const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
    const domain = selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id));

    const attestedEdgeCount = snapshot.edges.filter(edge => edge.attestation === 'attested').length;
    const certification = certifyFractalDynamics({ communityCount: 2, domainNodeCount: NODE_COUNT, attestedEdgeCount });
    if (!certification.certified) throw new Error(`fixture dynamics refused certification: ${certification.code}`);
    const contract = fractalContractParameters(certification, NODE_COUNT);
    const request: ProjectionRequest<'fractal'> = {
      id: 'fractal', snapshotDigest: snapshot.digest, domain,
      parameters: { ...contract, dimension: '2d' },
    };
    return {
      snapshot, domain, request, sourceBytes, dynamics: certification,
      structure: independentCommunityStructure(snapshot, domain.nodeIds),
    };
  })();
  return fixturePromise;
}

function memberDigest(members: readonly string[]): string {
  return digestPayload({ policy: FRACTAL_LEVEL_MEMBERSHIP_POLICY, members: [...members].sort(codepointCompare) });
}

/** The validation context with independent level witnesses derived from the parent chains only. */
async function validationContext(): Promise<ProjectionValidationContext> {
  const { snapshot, domain, request, structure } = await fixture();
  const levels: Record<string, { memberNodeIds: string[]; memberDigest: string }> = {};
  const addWitness = (levelId: string, members: readonly string[]): void => {
    levels[levelId] = { memberNodeIds: [...members].sort(codepointCompare), memberDigest: memberDigest(members) };
  };
  for (const [communityId, members] of structure.membersByCommunity) {
    addWitness(fractalCommunityLevelId(communityId), members);
    for (const group of structure.groupChildrenByCommunity.get(communityId) ?? []) {
      addWitness(fractalChildLevelId(communityId, group.childId), group.members);
    }
    if ((structure.groupChildrenByCommunity.get(communityId) ?? []).length > 0) {
      addWitness(fractalResidualLevelId(communityId), structure.residualByCommunity.get(communityId)!);
    }
  }
  return { snapshot, domain, request, witnesses: { levels, liftedRouteEdgeIds: {} } };
}

/** Access a level member list only after proving the level is loaded (union narrowing). */
function loadedMembersOf(level: { readonly loaded: boolean } | undefined, levelId: string): readonly string[] {
  assert.ok(level !== undefined, `missing level ${levelId}`);
  if (level.loaded !== true) assert.fail(`level ${levelId} must be loaded`);
  if (!('memberNodeIds' in level)) assert.fail(`loaded level ${levelId} carries no members`);
  return (level as { readonly memberNodeIds: readonly string[] }).memberNodeIds;
}

test('fractal projection assembles a complete contract-valid 2D result from inverse external rays', async () => {
  const { snapshot, domain, request, dynamics, structure } = await fixture();
  const result = await fractalProjection.project(snapshot, request);

  assert.equal(fractalProjection.id, 'fractal');
  assert.equal(fractalProjection.version, FRACTAL_PROJECTION_VERSION);
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.ok(Object.hasOwn(result, 'positions2') && !Object.hasOwn(result, 'positions3'));
  assert.deepEqual(result.loadedNodeIds, domain.nodeIds);
  assert.deepEqual(Object.keys(result.positions2!).sort(codepointCompare), [...domain.nodeIds].sort(codepointCompare));
  for (const id of Object.keys(result.positions2!)) {
    const point = result.positions2![id]!;
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(!Object.hasOwn(point, 'z'));
  }
  assert.equal(result.determinism.algorithmId, 'fractal');
  assert.equal(result.determinism.algorithmVersion, FRACTAL_PROJECTION_VERSION);
  assert.ok(result.determinism.numericBackendVersion.includes(BOTCHER_VERSION));
  assert.ok(result.determinism.numericBackendVersion.includes(INVERSE_RAYS_VERSION));
  assert.ok(result.determinism.numericBackendVersion.includes(FRACTAL_ASSIGNMENT_VERSION));
  assert.ok(result.determinism.parameterHash.length > 0);

  // Positions are true inverse images: the carried residual is within the requested tolerance.
  const maxResidual = result.diagnostics.find(item => item.code === 'fractal:max-inverse-residual')!;
  assert.ok(Number(maxResidual.value) <= request.parameters.residualTolerance && maxResidual.acceptable);
  const radial = result.diagnostics.find(item => item.code === 'fractal:radial-iqr-over-median')!;
  assert.ok(Number(radial.value) >= 0.15 && radial.acceptable);
  const retention = result.diagnostics.find(item => item.code === 'fractal:mapped-retention')!;
  assert.equal(retention.value, 1);

  // Levels: the giant is a promise subdivided only through its real group children.
  const levels = new Map(result.levels.map(level => [level.id, level]));
  const expectedLevelIds = new Set<string>();
  for (const [communityId] of structure.membersByCommunity) {
    expectedLevelIds.add(fractalCommunityLevelId(communityId));
    for (const group of structure.groupChildrenByCommunity.get(communityId) ?? []) {
      expectedLevelIds.add(fractalChildLevelId(communityId, group.childId));
    }
    if ((structure.groupChildrenByCommunity.get(communityId) ?? []).length > 0) {
      expectedLevelIds.add(fractalResidualLevelId(communityId));
    }
  }
  assert.deepEqual([...levels.keys()].sort(codepointCompare), [...expectedLevelIds].sort(codepointCompare));

  const giantMembers = structure.membersByCommunity.get('n:a')!;
  assert.ok(giantMembers.length > domain.nodeIds.length / 2);
  const giantLevel = levels.get(fractalCommunityLevelId('n:a'))!;
  assert.ok(giantLevel.loaded === false, 'the giant community level is a promise');
  if ('memberNodeIds' in giantLevel) assert.fail('unloaded level carries members');
  if (!('loadToken' in giantLevel)) assert.fail('promise level lacks a load token');
  assert.equal(giantLevel.memberCount, giantMembers.length);
  assert.equal(giantLevel.memberDigest, memberDigest(giantMembers));
  assert.deepEqual(giantLevel.childLevelIds, [
    fractalChildLevelId('n:a', 'n:a:g1'), fractalChildLevelId('n:a', 'n:a:g2'), fractalResidualLevelId('n:a'),
  ]);
  const token = giantLevel.loadToken;
  assert.equal(token.snapshotDigest, snapshot.digest);
  assert.equal(token.domainDigest, domain.domainDigest);
  assert.equal(token.projectionId, 'fractal');
  assert.equal(token.parameterHash, result.determinism.parameterHash);
  assert.equal(token.levelId, giantLevel.id);

  for (const [communityId, members] of structure.membersByCommunity) {
    const groups = structure.groupChildrenByCommunity.get(communityId) ?? [];
    if (groups.length === 0) {
      assert.deepEqual(loadedMembersOf(levels.get(fractalCommunityLevelId(communityId)), fractalCommunityLevelId(communityId)), members);
      continue;
    }
    for (const group of groups) {
      assert.deepEqual(
        loadedMembersOf(levels.get(fractalChildLevelId(communityId, group.childId)), fractalChildLevelId(communityId, group.childId)),
        group.members);
    }
    assert.deepEqual(
      loadedMembersOf(levels.get(fractalResidualLevelId(communityId)), fractalResidualLevelId(communityId)),
      structure.residualByCommunity.get(communityId));
  }
  // Leaf children never become levels: l1 and l2 appear only inside the residual level.
  assert.ok(loadedMembersOf(levels.get(fractalResidualLevelId('n:a')), fractalResidualLevelId('n:a')).includes('n:a:l1'));
  assert.ok(!levels.has(fractalChildLevelId('n:a', 'n:a:l1')));

  // Containers: community regions with sampled mapped boundaries; the giant's is aggregate only.
  const containers = new Map(result.containers.map(container => [container.visualId, container]));
  assert.deepEqual([...containers.keys()].sort(codepointCompare), [
    fractalContainerId('n:a'), fractalContainerId('n:b'),
    fractalResidualContainerId('n:a'),
    fractalSubContainerId('n:a', 'n:a:g1'), fractalSubContainerId('n:a', 'n:a:g2'),
  ].sort(codepointCompare));
  const giantContainer = containers.get(fractalContainerId('n:a'))!;
  assert.equal(giantContainer.memberCount, giantMembers.length);
  assert.ok(!Object.hasOwn(giantContainer, 'memberNodeIds'));
  assert.ok(giantContainer.boundary2!.length >= 20);
  for (const point of giantContainer.boundary2!) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  const groupContainer = containers.get(fractalSubContainerId('n:a', 'n:a:g1'))!;
  assert.deepEqual(groupContainer.memberNodeIds, structure.groupChildrenByCommunity.get('n:a')!.find(group => group.childId === 'n:a:g1')!.members);
  assert.ok(groupContainer.boundary2!.length >= 20);

  // Equipotentials exist only as declared derived curve geometry, never as edges or containers.
  assert.equal(result.visualRelations.length, 0);
  assert.equal(result.curves.length, 3);
  for (const curve of result.curves) {
    assert.equal(curve.purpose, 'field-contour');
    assert.ok(curve.points2 !== undefined && curve.points2.length >= 24);
    assert.ok(!Object.hasOwn(curve, 'points3'));
    assert.ok(!Object.hasOwn(curve, 'visualRelationId'));
  }
  assert.deepEqual(result.domainEdgeIds, domain.edgeIds);

  // Scalar potential field over the whole domain with G from importance midranks.
  assert.equal(result.fields.length, 1);
  const field = result.fields[0]!;
  if (field.kind !== 'scalar') assert.fail('the potential field must be scalar');
  assert.deepEqual(field.sampleIds, domain.nodeIds);
  const [minPotential, maxPotential] = potentialRangeForCount(domain.nodeIds.length);
  for (const value of field.values) assert.ok(value >= minPotential - 1e-12 && value <= maxPotential + 1e-12);

  // Explanations: p, c, G, theta, N, residual and branch witness for every node and container.
  for (const id of domain.nodeIds) {
    const explanation = result.explanations[id]!;
    assert.equal(explanation.elementKind, 'node');
    const witness = explanation.numericalWitness!;
    assert.equal(witness.p, dynamics.power);
    assert.equal(witness.c, dynamics.c);
    assert.equal(witness.N, request.parameters.rayIterations);
    assert.ok(Number.isFinite(witness.G as number) && (witness.G as number) > 0);
    assert.ok(Number.isFinite(witness.theta as number) && (witness.theta as number) >= 0 && (witness.theta as number) < 2 * Math.PI);
    assert.ok((witness.inverseResidual as number) <= request.parameters.residualTolerance);
    assert.ok(Number.isFinite(witness.branchArgumentError as number));
    assert.ok(Number.isFinite(witness.branchMaxStepArgumentDelta as number));
  }
  for (const container of result.containers) {
    assert.ok(result.explanations[container.visualId] !== undefined, `missing container explanation ${container.visualId}`);
  }

  // Measured per-community edge-locality reported exactly for the real communities and group
  // sub-sectors (never the residual, a leaf child, or the cross/exploratory edges), all passing.
  const localityCodes = result.diagnostics.filter(item => item.code.startsWith('fractal:edge-locality:')).map(item => item.code);
  assert.deepEqual(localityCodes.sort(), [
    'fractal:edge-locality:n:a', 'fractal:edge-locality:n:a:g1', 'fractal:edge-locality:n:a:g2', 'fractal:edge-locality:n:b',
  ]);
  for (const code of localityCodes) {
    const item = result.diagnostics.find(entry => entry.code === code)!;
    assert.equal(typeof item.value, 'number', `${code} carries the measured ratio`);
    assert.ok(Number.isFinite(item.value as number) && (item.value as number) > 0 && (item.value as number) <= 0.5, `${code} ratio`);
    assert.equal(item.acceptable, true);
  }
  assert.ok(!result.diagnostics.some(item => item.code === 'fractal:3d-scalar-lift'));

  // The contract validator accepts the assembled result against the independent witnesses.
  const context = await validationContext();
  assert.doesNotThrow(() => validateProjectionResult(result, context));
});

test('the assembled result conserves the source ledger and domain against the independent oracle', async () => {
  const { snapshot, request, sourceBytes } = await fixture();
  const context = await validationContext();
  const result = await fractalProjection.project(snapshot, request);
  await assert.doesNotReject(assertProjectionInvariants(result, context, {
    expectedSourceBytes: sourceBytes,
    semanticEdgeCarriers: snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, class: edge.attestation })),
  }));
});

test('repeat requests and permuted snapshot arrays produce the identical result digest', async () => {
  const { snapshot, request } = await fixture();
  const first = await fractalProjection.project(snapshot, request);
  const repeat = await fractalProjection.project(snapshot, request);
  assert.equal(repeat.determinism.resultDigest, first.determinism.resultDigest);
  assert.equal(repeat.determinism.parameterHash, first.determinism.parameterHash);

  const permutedSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges.slice(17), ...snapshot.edges.slice(0, 17)],
  } as SemanticGraphSnapshot;
  assert.equal(permutedSnapshot.digest, snapshot.digest);
  const permuted = await fractalProjection.project(permutedSnapshot, request);
  assert.equal(permuted.determinism.resultDigest, first.determinism.resultDigest);
  assert.deepEqual(permuted.positions2, first.positions2);
});

test('the 3D result is the labelled scalar lift of G and validates in 3D', async () => {
  const { snapshot, domain, request } = await fixture();
  const request3: ProjectionRequest<'fractal'> = { ...request, parameters: { ...request.parameters, dimension: '3d' } };
  const context = await validationContext();
  const result = await fractalProjection.project(snapshot, request3);
  assert.ok(Object.hasOwn(result, 'positions3') && !Object.hasOwn(result, 'positions2'));
  const scale = displayScaleForCount(domain.nodeIds.length);
  const field = result.fields[0]!;
  if (field.kind !== 'scalar') assert.fail('the potential field must be scalar');
  domain.nodeIds.forEach((id, index) => {
    const point = result.positions3![id]!;
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.equal(point.z, scale * field.values[index]!);
  });
  const lift = result.diagnostics.find(item => item.code === 'fractal:3d-scalar-lift')!;
  assert.equal(lift.value, FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION);
  assert.equal(lift.acceptable, true);
  assert.doesNotThrow(() => validateProjectionResult(result, { ...context, request: request3 }));
});

test('an uncertified dynamics and a request disagreeing with the certified parameters are refused', async () => {
  const { snapshot, request } = await fixture();
  assert.throws(
    () => certifiedDynamicsForRequest({ communityCount: 0, domainNodeCount: NODE_COUNT, attestedEdgeCount: 40 }, request.parameters),
    /uncertified-dynamics/,
  );
  await assert.rejects(
    fractalProjection.project(snapshot, { ...request, parameters: { ...request.parameters, power: 3 } }),
    /parameter-mismatch/,
  );
  await assert.rejects(
    fractalProjection.project(snapshot, { ...request, parameters: { ...request.parameters, scale: 999 } }),
    /parameter-mismatch/,
  );
});

test('an inverse-ray residual above the requested tolerance is refused, never projected', async () => {
  const { snapshot, request } = await fixture();
  await assert.rejects(
    fractalProjection.project(snapshot, { ...request, parameters: { ...request.parameters, residualTolerance: 1e-18 } }),
    /inverse-ray-failed/,
  );
});

test('request.abort is honoured at the typed checkpoints', async () => {
  const { snapshot, request } = await fixture();
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    fractalProjection.project(snapshot, { ...request, abort: before.signal }),
    /abort/,
  );
  const mid = new AbortController();
  const pending = fractalProjection.project(snapshot, { ...request, abort: mid.signal });
  mid.abort(new Error('stop now'));
  await assert.rejects(pending, /stop now/);
});

test('the typed invalid-sector-partition refusal carries no coordinates and validates', async () => {
  const { snapshot, domain, request, dynamics } = await fixture();
  const refusal = await fractalRefusalProjection(snapshot, request,
    { code: 'invalid-sector-partition', detail: 'fixture refusal' }, dynamics);
  assert.equal(refusal.coordinateState.kind, 'no-coordinates');
  assert.equal(refusal.loadedNodeIds.length, 0);
  assert.ok(!Object.hasOwn(refusal, 'positions2') && !Object.hasOwn(refusal, 'positions3'));
  assert.equal(refusal.containers.length, 0);
  assert.equal(refusal.levels.length, 0);
  const failing = refusal.diagnostics.find(item => item.code === 'invalid-sector-partition')!;
  assert.equal(failing.acceptable, false);
  if (refusal.coordinateState.kind !== 'no-coordinates') assert.fail('unreachable');
  assert.ok(refusal.explanations[refusal.coordinateState.explanationId] !== undefined);
  assert.doesNotThrow(() => validateProjectionResult(refusal, {
    snapshot, domain, request, witnesses: { levels: {}, liftedRouteEdgeIds: {} },
  }));
});
