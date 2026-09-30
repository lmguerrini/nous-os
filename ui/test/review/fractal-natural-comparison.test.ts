import assert from 'node:assert/strict';
import test from 'node:test';
import { digestPayload } from '../../src/engine/digest.ts';
import { assignFractalSectors, codepointCompare } from '../../src/fractal/assignment.ts';
import type { FractalCommunitySector } from '../../src/fractal/assignment.ts';
import { certifyFractalDynamics, fractalContractParameters } from '../../src/fractal/parameters.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { deriveFractalCommunities, FRACTAL_IMPORTANCE_POLICY, FRACTAL_NUMERIC_BACKEND_VERSION,
  fractalChildLevelId, fractalCommunityLevelId, fractalProjection } from '../../src/projection/fractal.ts';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { NATURAL_LAYOUT_VERSION, naturalProjection } from '../../src/projection/natural-bridge.ts';
import type { ProjectionRequest, ProjectionResult, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import { comparisonLedger } from './fractal-natural-comparison-fixture.ts';

const SEEDS = Array.from({ length: 16 }, (_, index) => 0xD073E100 + index);
const LOCALITY_LIMIT = 0.5;
const LOCALITY_DIAGNOSTIC_TOLERANCE = 0.1;
const codepointSorted = (values: readonly string[]) => [...values].sort(codepointCompare);

function permuteSnapshot(snapshot: SemanticGraphSnapshot): SemanticGraphSnapshot {
  return { ...snapshot, nodes: [...snapshot.nodes].reverse(), edges: [...snapshot.edges].reverse() };
}

function circularMedian(pairs: readonly (readonly [string, string])[], angleOf: ReadonlyMap<string, number>): number {
  const deltas = pairs.map(([source, target]) => {
    const delta = Math.abs(angleOf.get(source)! - angleOf.get(target)!);
    return Math.min(delta, 2 * Math.PI - delta);
  }).sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[middle]! : (deltas[middle - 1]! + deltas[middle]!) / 2;
}

/** Independent Fractal metric from mapped positions; the only shared primitive is canonical hashing. */
function fractalCommunityRatios(snapshot: SemanticGraphSnapshot, result: ProjectionResult,
  communities: ReturnType<typeof deriveFractalCommunities>, sectors: readonly FractalCommunitySector[], domainDigest: string) {
  const positions = result.positions2!;
  const groups: { id: string; members: readonly string[] }[] = [];
  for (const sector of sectors) {
    const community = communities.communities.find(row => row.communityId === sector.communityId)!;
    groups.push({ id: sector.communityId, members: community.memberNodeIds });
    for (const subSector of sector.allocation?.groupSubSectors ?? []) {
      groups.push({ id: subSector.childId, members: subSector.memberNodeIds });
    }
  }
  const measured: { id: string; ratio: number }[] = [];
  for (const group of groups) {
    const members = codepointSorted(group.members);
    if (members.length < 3) continue;
    const memberSet = new Set(members);
    const pairs = snapshot.edges.filter(edge => edge.attestation === 'attested'
      && memberSet.has(edge.source) && memberSet.has(edge.target))
      .map(edge => [edge.source, edge.target] as const);
    if (pairs.length === 0) continue;
    const angleOf = new Map(members.map(id => {
      const point = positions[id]!;
      return [id, Math.atan2(point.y, point.x)] as const;
    }));
    const observed = circularMedian(pairs, angleOf);
    const slots = [...angleOf.values()].sort((a, b) => a - b);
    let baselineTotal = 0;
    for (let seed = 0; seed < 16; seed += 1) {
      const permutation = [...members];
      for (let index = permutation.length - 1; index >= 1; index -= 1) {
        const word = Number.parseInt(digestPayload(['sha256-fisher-yates-v1', domainDigest, group.id, seed, index]).slice(0, 8), 16);
        const swap = Math.floor((word / 4294967296) * (index + 1));
        [permutation[index], permutation[swap]] = [permutation[swap]!, permutation[index]!];
      }
      const shuffledAngles = new Map(permutation.map((id, slot) => [id, slots[slot]!]));
      baselineTotal += circularMedian(pairs, shuffledAngles);
    }
    const baseline = baselineTotal / 16;
    assert.ok(baseline > 0, `${group.id} Fractal baseline is positive`);
    measured.push({ id: group.id, ratio: observed / baseline });
  }
  assert.ok(measured.length > 0, 'Fractal context includes eligible communities');
  return measured;
}

function assertFractalLocality(result: ProjectionResult, ratios: readonly { id: string; ratio: number }[]): number {
  const diagnostics = result.diagnostics.filter(row => row.code.startsWith('fractal:edge-locality:'));
  const expected = new Map(ratios.map(row => [row.id, row.ratio]));
  const eligibleDiagnostics = diagnostics.filter(row => typeof row.value === 'number');
  assert.equal(eligibleDiagnostics.length, expected.size, 'Fractal has one numeric diagnostic per independently eligible group');
  for (const row of eligibleDiagnostics) {
    const independent = expected.get(row.code.slice('fractal:edge-locality:'.length));
    assert.notEqual(independent, undefined, `${row.code} has an independent measurement`);
    assert.equal(row.acceptable, true, row.code);
    assert.ok(Math.abs((row.value as number) - independent!) <= LOCALITY_DIAGNOSTIC_TOLERANCE,
      `${row.code} diagnostic ${row.value} matches independent ratio ${independent} within ${LOCALITY_DIAGNOSTIC_TOLERANCE}`);
    assert.ok(independent! <= LOCALITY_LIMIT, `${row.code} independent ratio ${independent}`);
  }
  return Math.max(...ratios.map(row => row.ratio));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Natural context metric: circular edge-angle median divided by 16 deterministic shuffles. */
function naturalCommunityRatios(snapshot: SemanticGraphSnapshot, result: ProjectionResult): number[] {
  const positions = result.positions2!;
  const parent = new Map(snapshot.nodes.map(node => [node.id, node.parentId]));
  const rootOf = (id: string) => {
    let current = id;
    while (parent.get(current) != null && parent.has(parent.get(current)!)) current = parent.get(current)!;
    return current;
  };
  const communities = new Map<string, string[]>();
  for (const id of result.domainNodeIds) {
    const root = rootOf(id);
    communities.set(root, [...(communities.get(root) ?? []), id]);
  }
  const ratios: number[] = [];
  for (const [communityId, ids] of communities) {
    const memberSet = new Set(ids);
    const intra = snapshot.edges.filter(edge => edge.attestation === 'attested'
      && memberSet.has(edge.source) && memberSet.has(edge.target));
    if (ids.length < 3 || intra.length === 0) continue;
    const center = { x: ids.reduce((sum, id) => sum + positions[id]!.x, 0) / ids.length,
      y: ids.reduce((sum, id) => sum + positions[id]!.y, 0) / ids.length };
    const angle = new Map(ids.map(id => [id, Math.atan2(positions[id]!.y - center.y, positions[id]!.x - center.x)]));
    const edgeMedian = (angles: ReadonlyMap<string, number>) => median(intra.map(edge => {
      const delta = Math.abs(angles.get(edge.source)! - angles.get(edge.target)!);
      return Math.min(delta, 2 * Math.PI - delta);
    }));
    const observed = edgeMedian(angle);
    const slots = ids.map(id => angle.get(id)!).sort((a, b) => a - b);
    let state = [...communityId].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0;
    const baseline: number[] = [];
    for (let trial = 0; trial < 16; trial += 1) {
      const shuffled = [...slots];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = state % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      baseline.push(edgeMedian(new Map(ids.map((id, index) => [id, shuffled[index]!]))));
    }
    const randomMedian = median(baseline);
    assert.ok(randomMedian > 0, `${communityId} Natural baseline is positive`);
    ratios.push(observed / randomMedian);
  }
  assert.ok(ratios.length > 0, 'Natural context includes eligible communities');
  return ratios;
}

function assertSemanticIdentity(result: ProjectionResult, sourceNodeIds: readonly string[], sourceEdgeIds: readonly string[],
  sourceBytes: Uint8Array, input: ReturnType<typeof comparisonLedger>, snapshot: SemanticGraphSnapshot) {
  assert.deepEqual(result.domainNodeIds, codepointSorted(sourceNodeIds));
  assert.deepEqual(result.loadedNodeIds, codepointSorted(sourceNodeIds));
  assert.deepEqual(result.domainEdgeIds, codepointSorted(sourceEdgeIds));
  assert.deepEqual(Object.keys(result.positions2 ?? {}).sort(codepointCompare), codepointSorted(sourceNodeIds));
  assert.equal(result.fullLedger.canonicalBytesDigest, snapshot.rawLedger.canonicalBytesDigest);
  assert.deepEqual(Buffer.from(sourceBytes), Buffer.from(canonicalSourceBytes(input)));
  const sourceNodes = new Set(sourceNodeIds);
  const sourceEdges = new Set(sourceEdgeIds);
  for (const relation of result.visualRelations) {
    assert.equal(relation.semantic, false);
    assert.ok(!sourceNodes.has(relation.visualId) && !sourceEdges.has(relation.visualId),
      'visual relation IDs cannot collide with source node or edge IDs');
    assert.ok(sourceNodes.has(relation.source) && sourceNodes.has(relation.target));
    for (const edgeId of relation.underlyingEdgeIds) assert.ok(sourceEdges.has(edgeId), `no invented contributor ${edgeId}`);
  }
}

test('Fractal and Natural preserve one semantic graph across 16 seeded synthetic domains', async () => {
  const rows: { seed: number; communities: number; fractalMax: number; naturalMax: number }[] = [];
  let naturalPermutationDigestMismatches = 0;
  for (const seed of SEEDS) {
    const input = comparisonLedger(seed);
    const sourceBytes = canonicalSourceBytes(input);
    const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
    const domain = selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id));
    const before = Buffer.from(sourceBytes);
    const nodeIds = domain.nodeIds;
    const edgeIds = domain.edgeIds;
    const nodeSet = new Set(nodeIds);
    const domainEdges = snapshot.edges.filter(edge => nodeSet.has(edge.source) && nodeSet.has(edge.target));
    const derivation = deriveFractalCommunities(snapshot, nodeIds);
    const attestedEdgeCount = domainEdges.filter(edge => edge.attestation === 'attested').length;
    const certified = certifyFractalDynamics({ communityCount: derivation.communities.length,
      domainNodeCount: nodeIds.length, attestedEdgeCount });
    assert.equal(certified.certified, true, `seed ${seed} dynamics certified`);
    if (!certified.certified) continue;
    const fractalRequest: ProjectionRequest<'fractal'> = { id: 'fractal', snapshotDigest: snapshot.digest, domain,
      parameters: { ...fractalContractParameters(certified, nodeIds.length), dimension: '2d' } };
    const naturalRequest: ProjectionRequest<'natural'> = { id: 'natural', snapshotDigest: snapshot.digest, domain,
      parameters: { dimension: '2d', arrangement: 'network', layoutVersion: NATURAL_LAYOUT_VERSION,
        layoutRelationPolicy: 'combined-essential', volumeExpansion: { x: 1, y: 1, z: 1 } } };

    const fractal = await fractalProjection.project(snapshot, fractalRequest);
    const fractalRepeat = await fractalProjection.project(snapshot, fractalRequest);
    const fractalPermuted = await fractalProjection.project(permuteSnapshot(snapshot), fractalRequest);
    const natural = await naturalProjection.project(snapshot, naturalRequest);
    const naturalRepeat = await naturalProjection.project(snapshot, naturalRequest);
    const naturalPermuted = await naturalProjection.project(permuteSnapshot(snapshot), naturalRequest);

    assertSemanticIdentity(fractal, nodeIds, edgeIds, before, input, snapshot);
    assertSemanticIdentity(natural, nodeIds, edgeIds, before, input, snapshot);
    assert.deepEqual(fractal.domainNodeIds, natural.domainNodeIds);
    assert.deepEqual(fractal.domainEdgeIds, natural.domainEdgeIds);
    assert.equal(fractal.determinism.resultDigest, fractalRepeat.determinism.resultDigest);
    assert.equal(fractal.determinism.resultDigest, fractalPermuted.determinism.resultDigest);
    assert.deepEqual(fractal.positions2, fractalPermuted.positions2);
    assert.equal(natural.determinism.resultDigest, naturalRepeat.determinism.resultDigest);
    if (natural.determinism.resultDigest !== naturalPermuted.determinism.resultDigest)
      naturalPermutationDigestMismatches += 1;
    assert.deepEqual(natural.positions2, naturalPermuted.positions2);
    assert.deepEqual(natural.visualRelations.map(row => JSON.stringify(row)).sort(),
      naturalPermuted.visualRelations.map(row => JSON.stringify(row)).sort(),
      'Natural visual relation membership and provenance are permutation invariant');

    const sourceSemanticEdgeIds = new Set(edgeIds);
    for (const result of [fractal, natural]) {
      for (const id of Object.keys(result.positions2 ?? {})) assert.ok(nodeSet.has(id), `no invented node ${id}`);
      for (const relation of result.visualRelations) {
        assert.equal(relation.semantic, false);
        assert.ok(relation.underlyingEdgeIds.every(id => sourceSemanticEdgeIds.has(id)));
      }
    }

    const assignment = assignFractalSectors({ nodes: derivation.nodes,
      edges: domainEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, attestation: edge.attestation })),
      communities: derivation.communities, domainDigest: domain.domainDigest,
      numericalBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION, importancePolicy: FRACTAL_IMPORTANCE_POLICY });
    assert.equal(assignment.kind, 'assignment', `seed ${seed} sector assignment`);
    if (assignment.kind !== 'assignment') continue;
    for (let index = 0; index < assignment.sectors.length; index += 1) {
      const sector: FractalCommunitySector = assignment.sectors[index]!;
      assert.ok(Math.abs(sector.interval.left - (index === 0 ? 0 : assignment.sectors[index - 1]!.interval.right)) <= 1e-12,
        'top-level sector intervals are contiguous');
      for (const child of sector.allocation?.groupSubSectors ?? []) {
        assert.ok(derivation.communities.find(row => row.communityId === sector.communityId)?.hierarchyChildren
          ?.some(real => real.childId === child.childId), 'subdivision references a real hierarchy child');
      }
    }
    assert.ok(Math.abs(assignment.sectors.at(-1)!.interval.right - 2 * Math.PI) <= 1e-12);
    const giant = assignment.sectors.find(sector => sector.giant);
    if (!giant) assert.fail('fixture contains one genuine giant community');
    const giantCommunity = derivation.communities.find(row => row.communityId === giant.communityId);
    if (!giantCommunity) assert.fail('giant community has a source hierarchy partition');
    const realGroupIds = (giantCommunity.hierarchyChildren ?? [])
      .filter(child => child.memberNodeIds.length >= 2).map(child => child.childId);
    assert.ok(realGroupIds.length > 0, 'giant community subdivision has real group children');
    assert.ok(giant.allocation);
    assert.deepEqual(giant.allocation!.groupSubSectors.map(child => child.childId), realGroupIds);
    const giantLevel = fractal.levels.find(level => level.id === fractalCommunityLevelId(giant.communityId));
    if (!giantLevel || giantLevel.loaded !== false) assert.fail('giant community is a finite unloaded parent level');
    assert.deepEqual(giantLevel.childLevelIds, [
      ...realGroupIds.map(childId => fractalChildLevelId(giant.communityId, childId)),
      `fractal:community:${giant.communityId}:residual`,
    ]);
    for (const target of assignment.targets) {
      const id = target.nodeId;
      const position = fractal.positions2![id]!;
      let mappedAngle = Math.atan2(position.y, position.x);
      if (mappedAngle < 0) mappedAngle += 2 * Math.PI;
      const sector: FractalCommunitySector = assignment.sectors.find(row => row.communityId === target.communityId)!;
      assert.ok(mappedAngle >= sector.interval.left - 0.01 && mappedAngle <= sector.interval.right + 0.01,
        `mapped ray for ${id} remains within its contiguous community sector`);
    }
    const fractalRatios = fractalCommunityRatios(snapshot, fractal, derivation, assignment.sectors, domain.domainDigest);
    const fractalMax = assertFractalLocality(fractal, fractalRatios);
    const naturalMax = Math.max(...naturalCommunityRatios(snapshot, natural));
    rows.push({ seed, communities: derivation.communities.length, fractalMax, naturalMax });
    assert.deepEqual(Buffer.from(canonicalSourceBytes(input)), before, `seed ${seed} source ledger bytes unchanged`);
  }
  console.log(`D073_E10 seed | communities | Fractal max ratio | Natural max ratio\n${rows.map(row =>
    `${row.seed} | ${row.communities} | ${row.fractalMax.toFixed(3)} | ${row.naturalMax.toFixed(3)}`).join('\n')}`);
  console.log(`D073_E10 Natural permutation result-digest mismatches: ${naturalPermutationDigestMismatches}/16`);
  assert.equal(rows.length, 16);
});
