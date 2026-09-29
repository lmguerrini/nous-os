import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDGE_LOCALITY_RATIO_LIMIT,
  FRACTAL_ASSIGNMENT_VERSION,
  FIEDLER_TIE_TOLERANCE,
  SECTOR_POLICY_VERSION,
  assignFractalSectors,
  circularEdgeMedian,
  codepointCompare,
  fiedlerLocalityOrder,
  radialSpreadMetrics,
  sectorGuard,
  sectorIntervals,
  splitSlotT,
  uniformMidrankT,
  type FractalSectorAssignment,
  type FractalSectorCommunity,
  type FractalSectorEdge,
  type FractalSectorInput,
  type FractalSectorNode,
} from '../../src/fractal/assignment.ts';
import { invertExternalPoint } from '../../src/fractal/inverse-rays.ts';
import { cxAbs } from '../../src/fractal/botcher.ts';
import { potentialForRank, potentialRangeForCount } from '../../src/fractal/parameters.ts';

/** Recorded fixture constants. */
const RECORD_C = -0.04976470588235294;
const TWO_PI = 2 * Math.PI;
const idOf = (i: number) => `n${String((137 * i) % 850).padStart(3, '0')}`;

function sortedIdImportance(): Map<string, number> {
  const ids: string[] = [];
  for (let i = 0; i < 850; i += 1) ids.push(idOf(i));
  const sorted = ids.sort(codepointCompare);
  const importanceOf = new Map<string, number>();
  sorted.forEach((nodeId, rank) => importanceOf.set(nodeId, rank));
  return importanceOf;
}

interface PathFixture {
  readonly nodes: FractalSectorNode[];
  readonly edges: FractalSectorEdge[];
  readonly giantIds: string[];
  readonly smallIds: string[];
}

/** Two-community path fixture: giant path i = 0..giantSize-1, small path after it, one cross edge. */
function pathFixture(giantSize: number): PathFixture {
  const importanceOf = sortedIdImportance();
  const nodes: FractalSectorNode[] = [];
  const edges: FractalSectorEdge[] = [];
  const giantIds: string[] = [];
  const smallIds: string[] = [];
  for (let i = 0; i < 850; i += 1) {
    const nodeId = idOf(i);
    const inGiant = i < giantSize;
    (inGiant ? giantIds : smallIds).push(nodeId);
    nodes.push({ id: nodeId, communityId: inGiant ? 'community-giant' : 'community-small', importance: importanceOf.get(nodeId)! });
  }
  for (let i = 0; i + 1 < 850; i += 1) {
    if (i < giantSize - 1 || i >= giantSize) {
      edges.push({ id: `e${i}`, source: idOf(i), target: idOf(i + 1), attestation: 'attested' });
    }
  }
  edges.push({ id: 'cross-edge', source: idOf(giantSize - 1), target: idOf(giantSize), attestation: 'attested' });
  return { nodes, edges, giantIds, smallIds };
}

function makeInput(
  nodes: readonly FractalSectorNode[],
  edges: readonly FractalSectorEdge[],
  communities: readonly FractalSectorCommunity[],
  domainDigest: string,
): FractalSectorInput {
  return {
    nodes: [...nodes],
    edges: [...edges],
    communities: [...communities],
    domainDigest,
    numericalBackendVersion: 'jacobi-cyclic-v1+sha256-canonical-json-v1',
    importancePolicy: 'sorted-id-rank-v1',
  };
}

const assignments = new Map<string, FractalSectorAssignment>();

function memoizedAssignment(key: string, build: () => FractalSectorAssignment): FractalSectorAssignment {
  const cached = assignments.get(key);
  if (cached !== undefined) return cached;
  const result = build();
  assignments.set(key, result);
  return result;
}

function requireAssignment(key: string, build: () => FractalSectorInput): FractalSectorAssignment {
  const result = memoizedAssignment(key, () => {
    const assigned = assignFractalSectors(build());
    assert.equal(assigned.kind, 'assignment', `${key} must assign`);
    return assigned as FractalSectorAssignment;
  });
  return result;
}

/** All-leaf giant: 697 leaf children, no group children. */
function allLeafFixtureInput(): FractalSectorInput {
  const fixture = pathFixture(697);
  const children = fixture.giantIds.map((nodeId) => ({ childId: `l-${nodeId}`, memberNodeIds: [nodeId] }));
  const communities: FractalSectorCommunity[] = [
    { communityId: 'community-giant', memberNodeIds: fixture.giantIds, hierarchyChildren: children },
    { communityId: 'community-small', memberNodeIds: fixture.smallIds },
  ];
  return makeInput(fixture.nodes, fixture.edges, communities, 'all-leaf-domain-digest');
}

/** Mixed giant: g1..g4 of 100/90/80/70 consecutive path members, then 357 leaf children. */
function mixedFixtureInput(): FractalSectorInput {
  const fixture = pathFixture(697);
  const children: { childId: string; memberNodeIds: string[] }[] = [];
  const groupSizes = [100, 90, 80, 70];
  let cursor = 0;
  groupSizes.forEach((size, index) => {
    children.push({ childId: `g${index + 1}`, memberNodeIds: fixture.giantIds.slice(cursor, cursor + size) });
    cursor += size;
  });
  for (let index = cursor; index < fixture.giantIds.length; index += 1) {
    const nodeId = fixture.giantIds[index]!;
    children.push({ childId: `l-${nodeId}`, memberNodeIds: [nodeId] });
  }
  const communities: FractalSectorCommunity[] = [
    { communityId: 'community-giant', memberNodeIds: fixture.giantIds, hierarchyChildren: children },
    { communityId: 'community-small', memberNodeIds: fixture.smallIds },
  ];
  return makeInput(fixture.nodes, fixture.edges, communities, 'mixed-domain-digest');
}

/** Giant without child groups: the community BFS + 40/20/40 rule for the whole giant. */
function noChildrenFixtureInput(): FractalSectorInput {
  const fixture = pathFixture(697);
  const communities: FractalSectorCommunity[] = [
    { communityId: 'community-giant', memberNodeIds: fixture.giantIds },
    { communityId: 'community-small', memberNodeIds: fixture.smallIds },
  ];
  return makeInput(fixture.nodes, fixture.edges, communities, 'no-children-domain-digest');
}

/** Skewed fixture: 700 (giant, 7 group children of 80 + 140 residual) / 100 / 35 / 10 / 5. */
function skewedFixtureInput(): FractalSectorInput {
  const sizes: [string, number][] = [['skew-a', 700], ['skew-b', 100], ['skew-c', 35], ['skew-d', 10], ['skew-e', 5]];
  const importanceOf = sortedIdImportance();
  const nodes: FractalSectorNode[] = [];
  const edges: FractalSectorEdge[] = [];
  const membersByCommunity = new Map<string, string[]>();
  let cursor = 0;
  for (const [communityId, size] of sizes) {
    const members: string[] = [];
    for (let k = 0; k < size; k += 1) {
      const nodeId = idOf(cursor + k);
      members.push(nodeId);
      nodes.push({ id: nodeId, communityId, importance: importanceOf.get(nodeId)! });
      if (k > 0) edges.push({ id: `e-${communityId}-${k}`, source: idOf(cursor + k - 1), target: nodeId, attestation: 'attested' });
    }
    membersByCommunity.set(communityId, members);
    cursor += size;
  }
  edges.push({ id: 'cross-edge', source: idOf(699), target: idOf(700), attestation: 'attested' });
  const giantMembers = membersByCommunity.get('skew-a')!;
  const hierarchy: { childId: string; memberNodeIds: string[] }[] = [];
  for (let group = 0; group < 7; group += 1) {
    hierarchy.push({ childId: `child-${String(group).padStart(2, '0')}`, memberNodeIds: giantMembers.slice(group * 80, group * 80 + 80) });
  }
  const communities: FractalSectorCommunity[] = [...membersByCommunity.entries()].map(([communityId, memberNodeIds]) =>
    communityId === 'skew-a' ? { communityId, memberNodeIds, hierarchyChildren: hierarchy } : { communityId, memberNodeIds });
  return makeInput(nodes, edges, communities, 'skewed-domain-digest');
}

/** Singleton fixture: 850 one-member communities, no edges. */
function singletonFixtureInput(): FractalSectorInput {
  const importanceOf = sortedIdImportance();
  const nodes: FractalSectorNode[] = [];
  const communities: FractalSectorCommunity[] = [];
  for (let i = 0; i < 850; i += 1) {
    const nodeId = idOf(i);
    nodes.push({ id: nodeId, communityId: `c-${nodeId}`, importance: importanceOf.get(nodeId)! });
    communities.push({ communityId: `c-${nodeId}`, memberNodeIds: [nodeId] });
  }
  return makeInput(nodes, [], communities, 'singleton-domain-digest');
}

test('sector widths reproduce the record fixtures with exact contiguity', () => {
  const two = sectorIntervals([697, 153]);
  assert.equal(two.length, 2);
  assert.equal(two[0]!.left, 0);
  assert.ok(Math.abs(two[0]!.width - (294.56 * Math.PI) / 180) <= 1e-12, `giant width ${two[0]!.width}`);
  assert.ok(Math.abs(two[1]!.width - (65.44 * Math.PI) / 180) <= 1e-12, `small width ${two[1]!.width}`);
  assert.equal(two[1]!.right, TWO_PI);
  assert.ok(Math.abs(two[0]!.right - two[1]!.left) === 0);
  const skewed = sectorIntervals([700, 100, 35, 10, 5]);
  assert.ok(Math.abs(skewed[0]!.width - (293.352941 * Math.PI) / 180) <= 1e-8);
  for (let index = 1; index < skewed.length; index += 1) {
    assert.equal(skewed[index]!.left, skewed[index - 1]!.right);
  }
  assert.equal(skewed[4]!.right, TWO_PI);
  const singletons = sectorIntervals(new Array(850).fill(1));
  assert.equal(singletons.length, 850);
  assert.ok(Math.abs(singletons[0]!.width - (0.423529 * Math.PI) / 180) <= 1e-8);
  // b(C) = min(pi/180, pi/C): 2 communities get the 1-degree base, 850 get pi/850 + R/850 with R = pi.
  assert.ok(Math.abs(two[0]!.width - (Math.PI / 180 + (TWO_PI - 2 * (Math.PI / 180)) * (697 / 850))) <= 1e-15);
  assert.ok(Math.abs(singletons[0]!.width - (Math.PI / 850 + Math.PI / 850)) <= 1e-15);
  // Guards: giant sectors clamp at 1e-3, tiny singleton sectors use width/10.
  assert.equal(sectorGuard(two[0]!.width), 1e-3);
  assert.ok(Math.abs(sectorGuard(singletons[0]!.width) - singletons[0]!.width / 10) <= 1e-18);
  assert.throws(() => sectorIntervals([]));
  assert.throws(() => sectorIntervals([0, 2]));
});

test('uniform midrank and 40/20/40 slot formulas are strictly internal with a fixed fifth gap', () => {
  for (const count of [1, 2, 3, 7, 153]) {
    for (let rank = 0; rank < count; rank += 1) {
      const t = uniformMidrankT(rank, count);
      assert.ok(t > 0 && t < 1);
      assert.equal(t, (rank + 0.5) / count);
    }
  }
  for (const count of [4, 5, 10, 35, 100, 153, 697]) {
    const half = Math.floor(count / 2);
    for (let rank = 0; rank < count; rank += 1) {
      const t = splitSlotT(rank, count);
      assert.ok(t > 0 && t < 1);
      if (rank < half) assert.ok(t < 0.4);
      else assert.ok(t > 0.6);
    }
    // The one graph-order cut keeps a fixed 20% normalized separation.
    assert.ok(splitSlotT(half, count) - splitSlotT(half - 1, count) > 0.2);
    assert.equal(splitSlotT(0, count), (0.5 / half) * 0.4);
  }
});

test('all-leaf giant reproduces the earlier G5.1 record row', () => {
  const result = requireAssignment('all-leaf', allLeafFixtureInput);
  assert.equal(result.version, FRACTAL_ASSIGNMENT_VERSION);
  assert.equal(result.sectorPolicyVersion, SECTOR_POLICY_VERSION);
  assert.equal(result.nodeCount, 850);
  assert.equal(result.communityCount, 2);
  const giant = result.sectors.find((sector) => sector.communityId === 'community-giant')!;
  assert.ok(giant.giant);
  assert.ok(Math.abs(giant.interval.width - (294.56 * Math.PI) / 180) <= 1e-12);
  const allocation = giant.allocation!;
  assert.equal(allocation.groupSubSectors.length, 0);
  assert.equal(allocation.residualNodeIds.length, 697);
  // The inner sector is [left + g, right - g] up to one ULP of accumulation.
  const guard = sectorGuard(giant.interval.width);
  assert.ok(Math.abs(allocation.innerInterval.left - (giant.interval.left + guard)) <= 1e-15);
  assert.ok(Math.abs(allocation.innerInterval.right - (giant.interval.right - guard)) <= 1e-14);
  assert.ok(Math.abs(allocation.innerInterval.width - (giant.interval.width - 2 * guard)) <= 1e-15);
  // The whole inner sector is the residual span.
  assert.ok(Math.abs(allocation.residualInterval.left - allocation.innerInterval.left) <= 1e-15);
  assert.ok(Math.abs(allocation.residualInterval.width - allocation.innerInterval.width) <= 1e-15);
});

test('all-leaf Fiedler witness matches the record eigenvalues and pivot', () => {
  const result = requireAssignment('all-leaf', allLeafFixtureInput);
  const witness = result.sectors.find((sector) => sector.communityId === 'community-giant')!.allocation!.leafOrderWitness;
  assert.equal(witness.method, 'fiedler');
  assert.equal(witness.componentCount, 1);
  assert.equal(witness.tiedFiedlerValue, false);
  assert.equal(witness.pivotNodeId, 'n000');
  assert.ok(Math.abs(witness.lambda2! - 2.03158e-5) <= 1e-9, `lambda2 ${witness.lambda2}`);
  assert.ok(Math.abs(witness.lambda3! - 8.12627e-5) <= 1e-9, `lambda3 ${witness.lambda3}`);
  assert.ok(witness.eigenGap! > FIEDLER_TIE_TOLERANCE);
  assert.ok(witness.maxAbsResidual! <= 1e-10);
  assert.ok(witness.orthogonalityDefect! <= 1e-9);
  assert.equal(witness.solverVersion, 'jacobi-cyclic-v1');
});

test('all-leaf locality, retention and radial spread meet the G5 gates', () => {
  const result = requireAssignment('all-leaf', allLeafFixtureInput);
  const giant = result.sectors.find((sector) => sector.communityId === 'community-giant')!;
  const reports = new Map(result.edgeLocality.map((report) => [report.groupId, report]));
  const giantReport = reports.get('community-giant')!;
  assert.equal(giantReport.eligible, true);
  assert.equal(giantReport.intraEdgeCount, 696);
  assert.ok(Math.abs(giantReport.localityMedian! - 0.007373) <= 1e-6, `giant L ${giantReport.localityMedian}`);
  assert.ok(giantReport.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  const smallReport = reports.get('community-small')!;
  assert.ok(Math.abs(smallReport.localityMedian! - 0.005962) <= 1e-6, `small L ${smallReport.localityMedian}`);
  assert.ok(smallReport.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  // 100% mapped external-sector retention: every node has exactly one strictly internal target.
  assert.equal(result.targets.length, 850);
  const seen = new Set<string>();
  for (const target of result.targets) {
    assert.ok(!seen.has(target.nodeId));
    seen.add(target.nodeId);
    const sector = result.sectors.find((candidate) => candidate.communityId === target.communityId)!;
    assert.ok(target.angle > sector.interval.left && target.angle < sector.interval.right, `${target.nodeId} angle internal`);
  }
  assert.equal(seen.size, 850);
  // Mapping: inverse residual, radii and the record radial quartiles.
  const radii: number[] = [];
  let maxResidual = 0;
  for (const target of result.targets) {
    const solved = invertExternalPoint({ power: 2, c: RECORD_C }, target.potential, target.angle);
    assert.equal(solved.kind, 'solution', `${target.nodeId} must invert`);
    if (solved.kind !== 'solution') continue;
    assert.ok(solved.residual <= 1e-6);
    assert.ok(solved.levelAgreement <= 1e-9);
    maxResidual = Math.max(maxResidual, solved.residual);
    radii.push(cxAbs(solved.z));
  }
  assert.ok(maxResidual <= 1e-9, `measured max residual ${maxResidual}`);
  const spread = radialSpreadMetrics(radii);
  assert.ok(Math.abs(spread.q1 - 1.871502) <= 1e-4, `q1 ${spread.q1}`);
  assert.ok(Math.abs(spread.median - 2.714183) <= 1e-4, `median ${spread.median}`);
  assert.ok(Math.abs(spread.q3 - 3.952242) <= 1e-4, `q3 ${spread.q3}`);
  assert.ok(Math.abs(spread.iqrOverMedian - 0.766617) <= 1e-4);
  assert.ok(spread.iqrOverMedian >= 0.15);
});

test('mixed giant reproduces the earlier G5.1 record row', () => {
  const result = requireAssignment('mixed', mixedFixtureInput);
  const giant = result.sectors.find((sector) => sector.communityId === 'community-giant')!;
  const allocation = giant.allocation!;
  assert.equal(allocation.groupSubSectors.length, 4);
  assert.deepEqual(allocation.groupSubSectors.map((sub) => sub.memberNodeIds.length), [100, 90, 80, 70]);
  assert.deepEqual(allocation.groupSubSectors.map((sub) => sub.childId), ['g1', 'g2', 'g3', 'g4']);
  assert.equal(allocation.residualNodeIds.length, 357);
  // Widths proportional to member counts inside the guarded inner sector.
  const inner = giant.interval.width - 2 * 1e-3;
  for (const sub of allocation.groupSubSectors) {
    assert.ok(Math.abs(sub.interval.width - (inner * sub.memberNodeIds.length) / 697) <= 1e-12);
  }
  assert.ok(Math.abs(allocation.residualInterval.width - (inner * 357) / 697) <= 1e-12);
  // Contiguity: sub-sectors tile the inner sector in child-ID order and members stay inside.
  let cursor = giant.interval.left + 1e-3;
  const angleOf = new Map(result.targets.map((target) => [target.nodeId, target.angle]));
  for (const sub of allocation.groupSubSectors) {
    assert.ok(Math.abs(sub.interval.left - cursor) <= 1e-12);
    cursor = sub.interval.right;
    for (const id of sub.memberNodeIds) {
      const angle = angleOf.get(id)!;
      assert.ok(angle > sub.interval.left && angle < sub.interval.right, `${id} inside ${sub.childId}`);
    }
  }
  assert.ok(Math.abs(allocation.residualInterval.left - cursor) <= 1e-12);
  for (const id of allocation.residualNodeIds) {
    const angle = angleOf.get(id)!;
    assert.ok(angle > allocation.residualInterval.left && angle < allocation.residualInterval.right, `${id} inside residual span`);
  }
  // No community interleaves: all giant members inside the giant sector, small members outside.
  for (const target of result.targets) {
    const sector = result.sectors.find((candidate) => candidate.communityId === target.communityId)!;
    assert.ok(target.angle > sector.interval.left && target.angle < sector.interval.right);
  }
  // Record eigen pair for the 357-leaf residual and the smallest-ID path-end pivot.
  const witness = allocation.leafOrderWitness;
  assert.equal(witness.method, 'fiedler');
  assert.ok(Math.abs(witness.lambda2! - 7.74391e-5) <= 1e-9);
  assert.ok(Math.abs(witness.lambda3! - 3.09751e-4) <= 1e-8);
  // Path ends of the residual are n680 (position 340) and n152 (position 696); the tie rule picks n152.
  assert.ok(['n152', 'n680'].includes(witness.pivotNodeId!));
  assert.equal(witness.pivotNodeId, 'n152');
  // Leaf order is the path order or its reversal, with the path ends at the extremes.
  const residualPathOrder: string[] = [];
  for (let i = 340; i <= 696; i += 1) residualPathOrder.push(idOf(i));
  const forward = allocation.leafOrder.every((id, index) => id === residualPathOrder[index]);
  const backward = allocation.leafOrder.every((id, index) => id === residualPathOrder[residualPathOrder.length - 1 - index]);
  assert.ok(forward || backward, 'leaf order is a monotone path order');
});

test('mixed giant locality holds per community and per group sub-sector', () => {
  const result = requireAssignment('mixed', mixedFixtureInput);
  const reports = new Map(result.edgeLocality.map((report) => [`${report.scope}:${report.groupId}`, report]));
  const giant = reports.get('community:community-giant')!;
  assert.equal(giant.intraEdgeCount, 696);
  assert.ok(Math.abs(giant.localityMedian! - 0.007373) <= 1e-6);
  assert.ok(giant.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  for (const [groupId, expected] of [['g1', 0.007373], ['g2', 0.007373], ['g3', 0.007373], ['g4', 0.007373]] as const) {
    const report = reports.get(`group-sub-sector:${groupId}`)!;
    assert.equal(report.eligible, true);
    assert.ok(Math.abs(report.localityMedian! - expected) <= 1e-6, `${groupId} L ${report.localityMedian}`);
    assert.ok(report.ratio! > 0 && report.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  }
  const small = reports.get('community:community-small')!;
  assert.ok(Math.abs(small.localityMedian! - 0.005962) <= 1e-6);
  assert.ok(small.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  // Radii depend only on potentials, so the radial spread equals the all-leaf fixture's.
  const allLeaf = requireAssignment('all-leaf', allLeafFixtureInput);
  for (const target of result.targets) {
    const other = allLeaf.targets.find((candidate) => candidate.nodeId === target.nodeId)!;
    assert.equal(target.potential, other.potential);
  }
});

test('childless giant keeps the community BFS + 40/20/40 rule', () => {
  const result = requireAssignment('no-children', noChildrenFixtureInput);
  const giant = result.sectors.find((sector) => sector.communityId === 'community-giant')!;
  assert.ok(giant.giant);
  assert.equal(giant.slotPolicy, 'bfs-split-40-20-40');
  assert.equal(giant.allocation, null);
  assert.equal(giant.order.length, 697);
  const small = result.sectors.find((sector) => sector.communityId === 'community-small')!;
  assert.equal(small.slotPolicy, 'bfs-split-40-20-40');
  const reports = new Map(result.edgeLocality.map((report) => [report.groupId, report]));
  const giantReport = reports.get('community-giant')!;
  assert.ok(Math.abs(giantReport.localityMedian! - 0.005898) <= 1e-6, `childless giant L ${giantReport.localityMedian}`);
  assert.ok(giantReport.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  const smallReport = reports.get('community-small')!;
  assert.ok(Math.abs(smallReport.localityMedian! - 0.005962) <= 1e-6);
});

test('skewed fixture reproduces the earlier record locality row', () => {
  const result = requireAssignment('skewed', skewedFixtureInput);
  assert.equal(result.communityCount, 5);
  const giant = result.sectors.find((sector) => sector.communityId === 'skew-a')!;
  assert.ok(Math.abs(giant.interval.width - (293.352941 * Math.PI) / 180) <= 1e-8);
  assert.equal(giant.allocation!.groupSubSectors.length, 7);
  assert.equal(giant.allocation!.groupSubSectors[0]!.memberNodeIds.length, 80);
  assert.equal(giant.allocation!.residualNodeIds.length, 140);
  const expected: Record<string, number> = {
    'skew-a': 0.007311,
    'skew-b': 0.005955,
    'skew-c': 0.006190,
    'skew-d': 0.007068,
    'skew-e': 0.008650,
  };
  for (const report of result.edgeLocality) {
    if (report.scope !== 'community') continue;
    const tolerance = expected[report.groupId] === 0.008650 ? 2e-6 : 1e-6;
    assert.ok(Math.abs(report.localityMedian! - expected[report.groupId]!) <= tolerance, `${report.groupId} L ${report.localityMedian}`);
    assert.ok(report.ratio! <= EDGE_LOCALITY_RATIO_LIMIT, `${report.groupId} ratio ${report.ratio}`);
  }
  // The five-member community is the tightest gate in the record (0.4199 there) and stays real.
  const five = result.edgeLocality.find((report) => report.groupId === 'skew-e')!;
  assert.ok(five.ratio! > 0.1 && five.ratio! <= EDGE_LOCALITY_RATIO_LIMIT);
  assert.equal(result.sectors.filter((sector) => sector.giant).length, 1);
  assert.equal(result.sectors.filter((sector) => sector.slotPolicy === 'bfs-split-40-20-40' && !sector.giant).length, 4);
});

test('singleton fixture: 850 one-member communities map with no eligible locality set', () => {
  const result = requireAssignment('singletons', singletonFixtureInput);
  assert.equal(result.communityCount, 850);
  assert.equal(result.targets.length, 850);
  assert.ok(result.edgeLocality.every((report) => !report.eligible && report.ratio === null));
  // Equal sizes still accumulate cursor ULPs, so compare against the same-index helper interval.
  const expected = sectorIntervals(new Array(850).fill(1));
  for (const [index, sector] of result.sectors.entries()) {
    assert.ok(Math.abs(sector.interval.width - expected[index]!.width) <= 1e-15);
    assert.equal(sector.interval.left, expected[index]!.left);
    assert.ok(Math.abs(sector.interval.width - TWO_PI / 850) <= 1e-12);
    assert.equal(sector.slotPolicy, 'uniform-midrank');
    assert.equal(sector.order.length, 1);
    const target = result.targets.find((candidate) => candidate.communityId === sector.communityId)!;
    const guard = sectorGuard(sector.interval.width);
    assert.ok(Math.abs(target.angle - (sector.interval.left + guard + 0.5 * (sector.interval.width - 2 * guard))) <= 1e-15);
  }
  assert.ok(Math.abs(result.sectors[849]!.interval.right - TWO_PI) === 0);
});

test('importance midranks: potentials strictly increase, ties break by ID, angles never interfere', () => {
  const result = requireAssignment('mixed', mixedFixtureInput);
  const ranked = [...result.targets].sort((a, b) => a.potential - b.potential);
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(ranked[index]!.potential > ranked[index - 1]!.potential);
  }
  const [minPotential, maxPotential] = potentialRangeForCount(850);
  assert.ok(Math.abs(ranked[0]!.potential - minPotential) <= 1e-15);
  assert.ok(Math.abs(ranked[849]!.potential - maxPotential) <= 1e-15);
  // The importance order is the sorted-ID rank, independent of the path position.
  const sortedIds = [...new Set(result.targets.map((target) => target.nodeId))].sort(codepointCompare);
  sortedIds.forEach((nodeId, rank) => {
    const target = result.targets.find((candidate) => candidate.nodeId === nodeId)!;
    assert.ok(Math.abs(target.potential - potentialForRank(rank, 850)) <= 1e-15);
  });
});

test('determinism: byte-identical double runs and permuted input order', () => {
  const first = requireAssignment('mixed', mixedFixtureInput);
  const second = assignFractalSectors(mixedFixtureInput()) as FractalSectorAssignment;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  const base = mixedFixtureInput();
  const permuted = makeInput(
    [...base.nodes].reverse(),
    [...base.edges].sort((a, b) => codepointCompare(b.id, a.id)),
    [...base.communities].reverse().map((community) => ({
      ...community,
      memberNodeIds: [...community.memberNodeIds].reverse(),
      hierarchyChildren: [...(community.hierarchyChildren ?? [])].reverse().map((child) => ({ ...child, memberNodeIds: [...child.memberNodeIds].reverse() })),
    })),
    'mixed-domain-digest',
  );
  const permutedResult = assignFractalSectors(permuted) as FractalSectorAssignment;
  assert.equal(JSON.stringify(permutedResult), JSON.stringify(first));
  assert.equal(permutedResult.assignmentDigest, first.assignmentDigest);
});

test('typed invalid-sector-partition refusals', () => {
  type MutableNode = { id: string; communityId: string; importance: number };
  type MutableCommunity = { communityId: string; memberNodeIds: string[]; hierarchyChildren?: { childId: string; memberNodeIds: string[] }[] };
  const base = (): { nodes: MutableNode[]; edges: FractalSectorEdge[]; communities: MutableCommunity[] } => {
    const nodes = [1, 2, 3, 4].map((i) => ({ id: `x${i}`, communityId: 'c1', importance: i }));
    const edges: FractalSectorEdge[] = [{ id: 'e1', source: 'x1', target: 'x2', attestation: 'attested' }];
    const communities: MutableCommunity[] = [{ communityId: 'c1', memberNodeIds: ['x1', 'x2', 'x3', 'x4'] }];
    return { nodes, edges, communities };
  };
  const refuse = (input: FractalSectorInput): string => {
    const result = assignFractalSectors(input);
    assert.equal(result.kind, 'failure');
    return result.kind === 'failure' ? result.code : '';
  };
  const make = (mutate: (parts: ReturnType<typeof base>) => void): FractalSectorInput => {
    const parts = base();
    mutate(parts);
    return makeInput(parts.nodes, parts.edges, parts.communities, 'refusal-digest');
  };
  // A node missing from every member list.
  assert.equal(refuse(make((parts) => { parts.communities[0]!.memberNodeIds = ['x1', 'x2', 'x3']; })), 'invalid-sector-partition');
  // A node claiming an undeclared community.
  assert.equal(refuse(make((parts) => { parts.nodes[0]!.communityId = 'c9'; })), 'invalid-sector-partition');
  // The same member listed in two communities.
  assert.equal(refuse(make((parts) => {
    parts.nodes[3] = { id: 'x4', communityId: 'c2', importance: 4 };
    parts.communities.push({ communityId: 'c2', memberNodeIds: ['x4'] });
    parts.communities[0]!.memberNodeIds = ['x1', 'x2', 'x3', 'x4'];
  })), 'invalid-sector-partition');
  // An empty community.
  assert.equal(refuse(make((parts) => { parts.communities.push({ communityId: 'c2', memberNodeIds: [] }); })), 'invalid-sector-partition');
  // A hierarchy child outside the parent.
  assert.equal(refuse(make((parts) => {
    parts.communities[0]!.hierarchyChildren = [{ childId: 'bad', memberNodeIds: ['x1', 'x4'] }];
    parts.communities.push({ communityId: 'c2', memberNodeIds: ['x4'] });
    parts.nodes[3] = { id: 'x4', communityId: 'c2', importance: 4 };
    parts.communities[0]!.memberNodeIds = ['x1', 'x2', 'x3'];
  })), 'invalid-sector-partition');
  // Overlapping children of one community.
  assert.equal(refuse(make((parts) => {
    parts.communities[0]!.hierarchyChildren = [
      { childId: 'a', memberNodeIds: ['x1', 'x2'] },
      { childId: 'b', memberNodeIds: ['x2', 'x3'] },
    ];
  })), 'invalid-sector-partition');
  // A child with no members.
  assert.equal(refuse(make((parts) => { parts.communities[0]!.hierarchyChildren = [{ childId: 'empty', memberNodeIds: [] }]; })), 'invalid-sector-partition');
  // Duplicate edge IDs and edges off the domain.
  assert.equal(refuse(make((parts) => { parts.edges.push({ id: 'e1', source: 'x3', target: 'x4', attestation: 'attested' }); })), 'invalid-sector-partition');
  assert.equal(refuse(make((parts) => { parts.edges.push({ id: 'e9', source: 'x1', target: 'zz', attestation: 'attested' }); })), 'invalid-sector-partition');
  // Nonfinite importance.
  assert.equal(refuse(make((parts) => { parts.nodes[0] = { id: 'x1', communityId: 'c1', importance: Number.NaN }; })), 'invalid-sector-partition');
  // Community count above min(n, 850).
  const manyNodes: FractalSectorNode[] = [];
  const manyCommunities: FractalSectorCommunity[] = [];
  for (let index = 0; index < 851; index += 1) {
    const id = `s${String(index).padStart(4, '0')}`;
    manyNodes.push({ id, communityId: `c${String(index).padStart(4, '0')}`, importance: index });
    manyCommunities.push({ communityId: `c${String(index).padStart(4, '0')}`, memberNodeIds: [id] });
  }
  assert.equal(refuse(makeInput(manyNodes, [], manyCommunities, 'cap-digest')), 'invalid-sector-partition');
  // Empty domain and empty community list.
  assert.equal(refuse(makeInput([], [], [{ communityId: 'c', memberNodeIds: [] }], 'empty-digest')), 'invalid-sector-partition');
  assert.equal(refuse(makeInput([{ id: 'x1', communityId: 'c1', importance: 0 }], [], [], 'noc-digest')), 'invalid-sector-partition');
});

test('edge-locality-refusal carries the measured ratio for a complete graph', () => {
  const nodes = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `k${i}`, communityId: 'kcommunity', importance: i }));
  const edges: FractalSectorEdge[] = [];
  for (let i = 0; i < 6; i += 1) {
    for (let j = i + 1; j < 6; j += 1) edges.push({ id: `ke${i}-${j}`, source: `k${i}`, target: `k${j}`, attestation: 'attested' });
  }
  const result = assignFractalSectors(makeInput(nodes, edges, [{ communityId: 'kcommunity', memberNodeIds: nodes.map((node) => node.id) }], 'complete-digest'));
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.code, 'edge-locality-refusal');
    assert.equal(result.groupId, 'kcommunity');
    assert.ok(result.ratio! > EDGE_LOCALITY_RATIO_LIMIT);
    assert.ok(result.ratio! < 1 + 1e-9);
    assert.ok(result.detail.includes('ratio'));
  }
});

test('Fiedler order known answers: path spectrum, pivot and fallbacks', () => {
  // P5 spectrum: lambda2 = 2 - 2cos(pi/5), lambda3 = 2 - 2cos(2pi/5).
  const members = [0, 1, 2, 3, 4].map((i) => ({ id: `p${i}`, importance: 0 }));
  const pathEdges = [0, 1, 2, 3].map((i) => ({ source: `p${i}`, target: `p${i + 1}` }));
  const { order, witness } = fiedlerLocalityOrder(members, pathEdges);
  assert.equal(witness.method, 'fiedler');
  assert.ok(Math.abs(witness.lambda2! - (2 - 2 * Math.cos(Math.PI / 5))) <= 1e-9);
  assert.ok(Math.abs(witness.lambda3! - (2 - 2 * Math.cos((2 * Math.PI) / 5))) <= 1e-9);
  assert.equal(witness.pivotNodeId, 'p0');
  const forward = order.every((id, index) => id === `p${index}`);
  const backward = order.every((id, index) => id === `p${4 - index}`);
  assert.ok(forward || backward);
  // Singleton residual needs no eigensolve.
  const single = fiedlerLocalityOrder([{ id: 'only', importance: 1 }], []);
  assert.equal(single.witness.method, 'single');
  assert.deepEqual([...single.order], ['only']);
  // Disconnected residual: BFS restarts at the highest-importance node, then per component.
  const twoComponents = [
    { id: 'a1', importance: 1 },
    { id: 'a2', importance: 5 },
    { id: 'b1', importance: 9 },
    { id: 'b2', importance: 2 },
  ];
  const disconnectedEdges = [{ source: 'a1', target: 'a2' }, { source: 'b1', target: 'b2' }];
  const fallback = fiedlerLocalityOrder(twoComponents, disconnectedEdges);
  assert.equal(fallback.witness.method, 'bfs-fallback');
  assert.equal(fallback.witness.componentCount, 2);
  assert.equal(fallback.witness.tiedFiedlerValue, false);
  assert.equal(fallback.order[0], 'b1');
  assert.equal(fallback.order[1], 'b2');
  assert.ok(fallback.order.indexOf('a2') < fallback.order.indexOf('a1'));
});

test('helpers: circular edge median with wraparound and radial spread quartiles', () => {
  const angleOf = new Map<string, number>([['a', 0.1], ['b', TWO_PI - 0.1], ['c', 1.0], ['d', 2.0]]);
  assert.ok(Math.abs(circularEdgeMedian([['a', 'b']], angleOf)! - 0.2) <= 1e-15);
  assert.ok(Math.abs(circularEdgeMedian([['a', 'b'], ['c', 'd']], angleOf)! - (0.2 + 1.0) / 2) <= 1e-15);
  assert.equal(circularEdgeMedian([], angleOf), null);
  const spread = radialSpreadMetrics([1, 2, 3, 4, 5]);
  assert.equal(spread.q1, 2);
  assert.equal(spread.median, 3);
  assert.equal(spread.q3, 4);
  assert.ok(Math.abs(spread.iqrOverMedian - 2 / 3) <= 1e-15);
});
