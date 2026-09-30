import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { validateProjectionResult } from '../../src/projection/contract.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import { assignFractalSectors, codepointCompare } from '../../src/fractal/assignment.ts';
import {
  FRACTAL_LEVEL_MEMBERSHIP_POLICY, FRACTAL_NUMERIC_BACKEND_VERSION,
  FRACTAL_PROJECTION_VERSION, fractalChildLevelId, fractalCommunityLevelId, fractalProjection,
  fractalResidualLevelId, deriveFractalCommunities,
} from '../../src/projection/fractal.ts';
import { certifyFractalDynamics, fractalContractParameters } from '../../src/fractal/parameters.ts';
import { FRACTAL_IMPORTANCE_POLICY } from '../../src/projection/fractal.ts';
import { FRACTAL_QUALIFICATION_GIANT_COUNT, FRACTAL_QUALIFICATION_NODE_COUNT,
  FRACTAL_QUALIFICATION_SEED, createFractalQualificationInput } from './fractal-qualification-fixture.ts';
import { digestPayload } from '../../src/engine/digest.ts';
import type { ProjectionRequest, ProjectionResult, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';

const METRIC_BUDGET_MS = 20_000;
const EPSILON_BUDGET = 1e-6;
const LOCALITY_BUDGET = 0.5;
const REGION_RESIDUAL_BUDGET = 1e-6;

function diagnostic(result: ProjectionResult, code: string): number {
  const row = result.diagnostics.find(item => item.code === code);
  assert.ok(row, `missing diagnostic ${code}`);
  assert.equal(typeof row.value, 'number', `${code} is numeric`);
  return row.value as number;
}

function witnessesFromHierarchy(snapshot: SemanticGraphSnapshot, domainIds: readonly string[]) {
  const parentOf = new Map(snapshot.nodes.map(node => [node.id, node.parentId]));
  const rootOf = (id: string): string => {
    let current = id;
    while (parentOf.get(current) !== null && parentOf.get(current) !== undefined && parentOf.has(parentOf.get(current)!))
      current = parentOf.get(current)!;
    return current;
  };
  const membersByRoot = new Map<string, string[]>();
  for (const id of domainIds) {
    const root = rootOf(id);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), id]);
  }
  const levels: Record<string, { memberNodeIds: readonly string[]; memberDigest: string }> = {};
  const add = (id: string, members: readonly string[]) => {
    const sorted = [...members].sort(codepointCompare);
    levels[id] = { memberNodeIds: sorted,
      memberDigest: digestPayload({ policy: FRACTAL_LEVEL_MEMBERSHIP_POLICY, members: sorted }) };
  };
  for (const [root, members] of membersByRoot) {
    add(fractalCommunityLevelId(root), members);
    const groupMembers = new Map<string, string[]>();
    for (const member of members) {
      if (member === root) continue;
      let current = member;
      while (parentOf.get(current) !== root) current = parentOf.get(current)!;
      groupMembers.set(current, [...(groupMembers.get(current) ?? []), member]);
    }
    const groups = [...groupMembers].filter(([, rows]) => rows.length >= 2);
    for (const [childId, rows] of groups) add(fractalChildLevelId(root, childId), rows);
    if (groups.length) {
      const grouped = new Set(groups.flatMap(([, rows]) => rows));
      add(fractalResidualLevelId(root), members.filter(id => !grouped.has(id)));
    }
  }
  return { levels, liftedRouteEdgeIds: {} };
}

function localityMetrics(result: ProjectionResult) {
  return result.diagnostics.filter(row => row.code.startsWith('fractal:edge-locality:')).map(row => ({
    scope: row.code.slice('fractal:edge-locality:'.length), ratio: typeof row.value === 'number' ? row.value : null,
    eligible: typeof row.value === 'number', acceptable: row.acceptable,
  }));
}

test('integrated Fractal qualifies the seeded 850-node cap, G5.1 hierarchy and determinism budgets', async () => {
  const input = createFractalQualificationInput();
  const sourceBytes = canonicalSourceBytes(input);
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
  const domain = selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id));
  assert.equal(domain.nodeIds.length, FRACTAL_QUALIFICATION_NODE_COUNT);
  const communityDerivation = deriveFractalCommunities(snapshot, domain.nodeIds);
  const attestedEdgeCount = snapshot.edges.filter(edge => edge.attestation === 'attested'
    && domain.nodeIds.includes(edge.source) && domain.nodeIds.includes(edge.target)).length;
  const features = { communityCount: communityDerivation.communities.length,
    domainNodeCount: domain.nodeIds.length, attestedEdgeCount };
  const certification = certifyFractalDynamics(features);
  if (!certification.certified) assert.fail(`fixture dynamics refused: ${certification.code}`);
  const request: ProjectionRequest<'fractal'> = { id: 'fractal', snapshotDigest: snapshot.digest, domain,
    parameters: { ...fractalContractParameters(certification, domain.nodeIds.length), dimension: '2d' } };
  const context = { snapshot, domain, request, witnesses: witnessesFromHierarchy(snapshot, domain.nodeIds) };

  const started = performance.now();
  const coldStarted = performance.now();
  const cold = await fractalProjection.project(snapshot, request);
  const coldMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  const warm = await fractalProjection.project(snapshot, request);
  const warmMs = performance.now() - warmStarted;
  const shuffledSnapshot = { ...snapshot, nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse() } as SemanticGraphSnapshot;
  const permuted = await fractalProjection.project(shuffledSnapshot, request);
  const measuredMs = performance.now() - started;

  assert.equal(cold.coordinateState.kind, 'coordinates');
  assert.equal(cold.loadedNodeIds.length, FRACTAL_QUALIFICATION_NODE_COUNT);
  assert.equal(Object.keys(cold.positions2!).length, FRACTAL_QUALIFICATION_NODE_COUNT);
  assert.equal(cold.determinism.algorithmVersion, FRACTAL_PROJECTION_VERSION);
  assert.equal(cold.determinism.numericBackendVersion, FRACTAL_NUMERIC_BACKEND_VERSION);
  assert.equal(cold.determinism.resultDigest, warm.determinism.resultDigest);
  assert.equal(cold.determinism.parameterHash, warm.determinism.parameterHash);
  assert.equal(cold.determinism.resultDigest, permuted.determinism.resultDigest);
  assert.deepEqual(cold.positions2, permuted.positions2);

  const inverseResidual = diagnostic(cold, 'fractal:max-inverse-residual');
  const levelAgreement = diagnostic(cold, 'fractal:max-level-agreement');
  const regionResidual = diagnostic(cold, 'fractal:region-max-residual');
  const regionAgreement = diagnostic(cold, 'fractal:region-max-level-agreement');
  const equipotentialResidual = diagnostic(cold, 'fractal:equipotential-max-residual');
  const equipotentialAgreement = diagnostic(cold, 'fractal:equipotential-max-level-agreement');
  const radialSpread = diagnostic(cold, 'fractal:radial-iqr-over-median');
  assert.ok(inverseResidual <= EPSILON_BUDGET);
  assert.ok(levelAgreement <= EPSILON_BUDGET);
  assert.ok(regionResidual <= REGION_RESIDUAL_BUDGET);
  assert.ok(regionAgreement <= EPSILON_BUDGET);
  assert.ok(equipotentialResidual <= REGION_RESIDUAL_BUDGET);
  assert.ok(equipotentialAgreement <= EPSILON_BUDGET);
  assert.ok(radialSpread >= 0.15);

  const assignment = assignFractalSectors({
    nodes: communityDerivation.nodes,
    edges: snapshot.edges.filter(edge => domain.nodeIds.includes(edge.source) && domain.nodeIds.includes(edge.target))
      .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, attestation: edge.attestation })),
    communities: communityDerivation.communities, domainDigest: domain.domainDigest,
    numericalBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION, importancePolicy: FRACTAL_IMPORTANCE_POLICY,
  });
  assert.equal(assignment.kind, 'assignment');
  if (assignment.kind !== 'assignment') assert.fail('sector assignment refused');
  const sectors = assignment.sectors;
  for (let i = 0; i < sectors.length; i++) {
    assert.ok(Math.abs(sectors[i]!.interval.left - (i === 0 ? 0 : sectors[i - 1]!.interval.right)) <= 1e-12,
      'top-level sectors are contiguous');
    assert.ok(sectors[i]!.order.length > 0);
    assert.equal(new Set(sectors[i]!.order).size, sectors[i]!.order.length);
  }
  assert.ok(Math.abs(sectors.at(-1)!.interval.right - 2 * Math.PI) <= 1e-12);
  const giant = sectors.find(sector => sector.giant)!;
  assert.equal(giant.communityId, 'synthetic:community:giant');
  assert.equal(giant.order.length, FRACTAL_QUALIFICATION_GIANT_COUNT);
  assert.equal(giant.allocation!.groupSubSectors.length, 7);
  let childCursor = giant.allocation!.innerInterval.left;
  for (const child of giant.allocation!.groupSubSectors) {
    assert.ok(Math.abs(child.interval.left - childCursor) <= 1e-12, 'real group child sub-sectors are contiguous');
    childCursor = child.interval.right;
    assert.ok(child.memberNodeIds.length >= 2);
    assert.ok(child.order.every(id => child.memberNodeIds.includes(id)));
  }
  assert.ok(Math.abs(childCursor - giant.allocation!.residualInterval.left) <= 1e-12);
  assert.ok(Math.abs(giant.allocation!.residualInterval.right - giant.allocation!.innerInterval.right) <= 1e-12);
  assert.equal(giant.allocation!.residualNodeIds.length, 120);
  const giantLevel = cold.levels.find(level => level.id === fractalCommunityLevelId(giant.communityId))!;
  assert.equal(giantLevel.loaded, false);
  assert.deepEqual(giantLevel.childLevelIds, [
    ...giant.allocation!.groupSubSectors.map(child => fractalChildLevelId(giant.communityId, child.childId)),
    fractalResidualLevelId(giant.communityId),
  ]);
  assert.ok(!giantLevel.childLevelIds.some(id => id.includes(':leaf:')),
    'only real group children receive subdivision levels; hierarchy leaves remain in residual');

  const locality = localityMetrics(cold);
  assert.ok(locality.length >= 4, 'community and eligible group locality witnesses are reported');
  for (const row of locality) {
    assert.equal(row.acceptable, true, row.scope);
    if (row.eligible) assert.ok(row.ratio! <= LOCALITY_BUDGET, `${row.scope} locality ${row.ratio}`);
  }
  validateProjectionResult(cold, context);
  await assertProjectionInvariants(cold, context, { expectedSourceBytes: sourceBytes,
    semanticEdgeCarriers: snapshot.edges.filter(edge => domain.edgeIds.includes(edge.id)).map(edge => ({
      id: edge.id, source: edge.source, target: edge.target, class: edge.attestation,
    })) });
  assert.deepEqual(Buffer.from(canonicalSourceBytes(input)), Buffer.from(sourceBytes));
  assert.ok(measuredMs < METRIC_BUDGET_MS, `cold + warm + permutation took ${measuredMs.toFixed(1)}ms; budget ${METRIC_BUDGET_MS}ms`);

  const metrics = { fixture: 'seeded synthetic graph', seed: FRACTAL_QUALIFICATION_SEED,
    nodes: domain.nodeIds.length, giantCommunityNodes: FRACTAL_QUALIFICATION_GIANT_COUNT,
    attestedEdges: snapshot.edges.filter(edge => edge.attestation === 'attested').length,
    exploratoryEdges: snapshot.edges.filter(edge => edge.attestation === 'exploratory').length,
    residuals: { inverseRay: inverseResidual, levelAgreement, region: regionResidual,
      regionLevelAgreement: regionAgreement, equipotential: equipotentialResidual,
      equipotentialLevelAgreement: equipotentialAgreement },
    radialIqrOverMedian: radialSpread, edgeLocality: locality,
    sectorContiguity: true, repeatDigest: true, permutationDigest: true,
    coldMs: Number(coldMs.toFixed(1)), warmMs: Number(warmMs.toFixed(1)),
    coldWarmPermutationMs: Number(measuredMs.toFixed(1)), budgets: { residual: EPSILON_BUDGET,
      localityRatio: LOCALITY_BUDGET, regionResidual: REGION_RESIDUAL_BUDGET, timeMs: METRIC_BUDGET_MS } };
  console.log(`D073_FRACTAL_QUALIFICATION ${JSON.stringify(metrics)}`);
});
