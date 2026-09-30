import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDGE_LOCALITY_RATIO_LIMIT,
  FRACTAL_GROUP_CHILD_ORDER_RULE_VERSION,
  FRACTAL_ORDER_RULE_VERSION,
  ORDER_REFINEMENT_MAX_PASSES,
  ORDER_REFINEMENT_VERSION,
  SPECTRAL_ORDER_VERSION,
  assignFractalSectors,
  circularEdgeMedian,
  communitySpectralOrder,
  refineCircularOrder,
  splitSlotT,
  uniformMidrankT,
  type FractalCommunitySector,
  type FractalSectorAssignment,
  type FractalSectorEdge,
  type FractalSectorInput,
  type FractalSectorNode,
} from '../../src/fractal/assignment.ts';

const pad = (i: number) => String(i).padStart(3, '0');
type Pair = readonly [string, string];

function edgeOf(id: string, source: string, target: string): FractalSectorEdge {
  return { id, source, target, attestation: 'attested' };
}

function inputOf(
  nodes: readonly FractalSectorNode[],
  edges: readonly FractalSectorEdge[],
  groups: readonly { id: string; members: readonly string[] }[],
  ratioLimit?: number,
): FractalSectorInput {
  return {
    nodes: [...nodes],
    edges: [...edges],
    communities: groups.map((group) => ({ communityId: group.id, memberNodeIds: [...group.members] })),
    domainDigest: 'order-candidates-digest',
    numericalBackendVersion: 'jacobi-cyclic-v1+sha256-canonical-json-v1',
    importancePolicy: 'sorted-id-rank-v1',
    ...(ratioLimit === undefined ? {} : { edgeLocalityRatioLimit: ratioLimit }),
  };
}

/** Path community `p000..` of `count` nodes as the only community. */
function pathInput(count: number, closeCycle = false): FractalSectorInput {
  const ids = Array.from({ length: count }, (_, i) => `p${pad(i)}`);
  const nodes = ids.map((id, i) => ({ id, communityId: 'only', importance: i }));
  const edges: FractalSectorEdge[] = [];
  for (let i = 0; i + 1 < count; i += 1) edges.push(edgeOf(`e${pad(i)}`, ids[i]!, ids[i + 1]!));
  if (closeCycle) edges.push(edgeOf('e-close', ids[count - 1]!, ids[0]!));
  return inputOf(nodes, edges, [{ id: 'only', members: ids }]);
}

function assigned(input: FractalSectorInput): FractalSectorAssignment {
  const result = assignFractalSectors(input);
  assert.equal(result.kind, 'assignment', result.kind === 'failure' ? result.detail : '');
  return result as FractalSectorAssignment;
}

function sectorOf(result: FractalSectorAssignment, communityId: string): FractalCommunitySector {
  return result.sectors.find((sector) => sector.communityId === communityId)!;
}

/** Star community (center + 3 leaves + 2 isolated members) beside a long path community; the
 * star has the structure of the community that refused on the qualification dataset. */
function starInput(ratioLimit?: number): FractalSectorInput {
  const star = [0, 1, 2, 3, 4, 5].map((i) => `m${i}`);
  const filler = Array.from({ length: 44 }, (_, i) => `q${pad(i)}`);
  const nodes = [
    ...star.map((id, i) => ({ id, communityId: 'star', importance: i })),
    ...filler.map((id, i) => ({ id, communityId: 'filler', importance: 100 + i })),
  ];
  const edges: FractalSectorEdge[] = [edgeOf('s1', 'm5', 'm1'), edgeOf('s2', 'm5', 'm3'), edgeOf('s3', 'm5', 'm4')];
  for (let i = 0; i + 1 < filler.length; i += 1) edges.push(edgeOf(`f${pad(i)}`, filler[i]!, filler[i + 1]!));
  return inputOf(nodes, edges, [{ id: 'star', members: star }, { id: 'filler', members: filler }], ratioLimit);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, index) => {
    for (const rest of permutations([...items.slice(0, index), ...items.slice(index + 1)])) out.push([item, ...rest]);
  });
  return out;
}

/** Slot angles of a community sector under the 40/20/40 split rule, as placed by the assignment. */
function splitSlotAngles(sector: FractalCommunitySector): number[] {
  const count = sector.order.length;
  const inner = sector.interval.width - 2 * sector.guard;
  return Array.from({ length: count }, (_, rank) => sector.interval.left + sector.guard + splitSlotT(rank, count) * inner);
}

function medianOf(order: readonly string[], pairs: readonly Pair[], angles: readonly number[]): number | null {
  const angleOf = new Map(order.map((id, rank) => [id, angles[rank]!]));
  return circularEdgeMedian(pairs, angleOf);
}

test('order rule and candidate versions are named, and group children keep the original rule', () => {
  assert.equal(FRACTAL_ORDER_RULE_VERSION, 'bfs-reversal-dfs-spectral-refined-median-v2');
  assert.equal(FRACTAL_GROUP_CHILD_ORDER_RULE_VERSION, 'bfs-reversal-dfs-median-v1');
  assert.equal(SPECTRAL_ORDER_VERSION, 'component-fiedler-order-v1');
  assert.equal(ORDER_REFINEMENT_VERSION, 'circular-relocate-reverse-v1');
  assert.equal(assigned(pathInput(8)).orderRuleVersion, FRACTAL_ORDER_RULE_VERSION);
});

test('a star community that the three original orders refused now reaches the exhaustive minimum', () => {
  const result = assigned(starInput());
  const star = sectorOf(result, 'star');
  const pairs: Pair[] = [['m5', 'm1'], ['m5', 'm3'], ['m5', 'm4']];
  const angles = splitSlotAngles(star);
  let minimum = Infinity;
  for (const order of permutations(star.order)) minimum = Math.min(minimum, medianOf(order, pairs, angles)!);
  const report = result.edgeLocality.find((entry) => entry.groupId === 'star')!;
  assert.ok(Math.abs(report.localityMedian! - minimum) < 1e-15, `median ${report.localityMedian} vs exhaustive minimum ${minimum}`);
  assert.ok(report.ratio! <= EDGE_LOCALITY_RATIO_LIMIT, `ratio ${report.ratio}`);
  assert.match(star.orderCandidate, /^refined-/);
  assert.equal(result.edgeLocality.length, 2);
});

test('path and cycle communities reach the smallest possible median edge length', () => {
  for (const [count, closeCycle] of [[16, false], [12, true]] as const) {
    const result = assigned(pathInput(count, closeCycle));
    const sector = result.sectors[0]!;
    const inner = sector.interval.width - 2 * sector.guard;
    // Every edge joins two distinct slots, so no edge is shorter than one within-half slot step.
    const step = (0.4 * inner) / Math.floor(count / 2);
    const report = result.edgeLocality[0]!;
    assert.ok(Math.abs(report.localityMedian! - step) < 1e-12, `${count}${closeCycle ? ' cycle' : ' path'}: ${report.localityMedian} vs ${step}`);
    assert.ok(report.ratio! < EDGE_LOCALITY_RATIO_LIMIT);
  }
});

test('a clique cannot pass under any order and is refused with ratio 1', () => {
  const ids = [0, 1, 2, 3, 4, 5].map((i) => `k${i}`);
  const pairs: Pair[] = [];
  const edges: FractalSectorEdge[] = [];
  for (let i = 0; i < 6; i += 1) {
    for (let j = i + 1; j < 6; j += 1) {
      pairs.push([ids[i]!, ids[j]!]);
      edges.push(edgeOf(`k${i}-${j}`, ids[i]!, ids[j]!));
    }
  }
  const nodes = ids.map((id, i) => ({ id, communityId: 'clique', importance: i }));
  const input = inputOf(nodes, edges, [{ id: 'clique', members: ids }]);
  const result = assignFractalSectors(input);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  assert.equal(result.code, 'edge-locality-refusal');
  assert.ok(Math.abs(result.ratio! - 1) < 1e-9);
  const sector = assigned(inputOf(nodes, edges, [{ id: 'clique', members: ids }], 1e9)).sectors[0]!;
  const angles = splitSlotAngles(sector);
  const medians = new Set(permutations(ids).map((order) => medianOf(order, pairs, angles)!.toFixed(15)));
  assert.equal(medians.size, 1, 'a clique has the same median length under every order');
});

test('per-component spectral order lays the larger component first, each monotone along its path', () => {
  const longPath = Array.from({ length: 5 }, (_, i) => `a${i}`);
  const shortPath = Array.from({ length: 3 }, (_, i) => `b${i}`);
  const adjacency = new Map<string, string[]>();
  for (const id of [...longPath, ...shortPath]) adjacency.set(id, []);
  const link = (u: string, v: string) => { adjacency.get(u)!.push(v); adjacency.get(v)!.push(u); };
  for (let i = 0; i + 1 < 5; i += 1) link(longPath[i]!, longPath[i + 1]!);
  for (let i = 0; i + 1 < 3; i += 1) link(shortPath[i]!, shortPath[i + 1]!);
  const members = [...longPath, ...shortPath];
  const importanceOf = new Map(members.map((id) => [id, 0]));
  const order = communitySpectralOrder(members, adjacency, importanceOf);
  const head = order.slice(0, 5);
  const tail = order.slice(5);
  assert.ok(head.join() === longPath.join() || head.join() === [...longPath].reverse().join(), head.join());
  assert.ok(tail.join() === shortPath.join() || tail.join() === [...shortPath].reverse().join(), tail.join());
  assert.deepEqual([...communitySpectralOrder([...members].reverse(), adjacency, importanceOf)], order);
});

test('refinement keeps an optimal order, strictly improves a scrambled one and never raises the median', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `r${i}`);
  const angles = ids.map((_, rank) => 0.01 * rank);
  const pathPairs: Pair[] = ids.slice(0, -1).map((id, i) => [id, ids[i + 1]!]);
  const optimal = refineCircularOrder(ids, pathPairs, angles);
  assert.deepEqual([...optimal.order], ids);
  assert.equal(optimal.moves, 0);
  assert.ok(Math.abs(optimal.median! - 0.01) < 1e-15);

  const scrambled = ['r3', 'r0', 'r6', 'r1', 'r7', 'r4', 'r2', 'r5'];
  const before = medianOf(scrambled, pathPairs, angles)!;
  const refined = refineCircularOrder(scrambled, pathPairs, angles);
  assert.ok(refined.median! < before, `${refined.median} < ${before}`);
  assert.ok(refined.moves > 0 && refined.passes <= ORDER_REFINEMENT_MAX_PASSES);
  assert.equal(medianOf(refined.order, pathPairs, angles), refined.median);

  let state = 12345;
  const next = (bound: number) => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state % bound; };
  for (let trial = 0; trial < 20; trial += 1) {
    const count = 6 + next(10);
    const order = Array.from({ length: count }, (_, i) => `t${pad(i)}`);
    for (let i = count - 1; i > 0; i -= 1) { const j = next(i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const pairs: Pair[] = [];
    for (let e = 0; e < count; e += 1) {
      const u = next(count);
      const v = next(count);
      if (u !== v) pairs.push([`t${pad(u)}`, `t${pad(v)}`]);
    }
    if (pairs.length === 0) continue;
    const slotAngles = order.map((_, rank) => 0.4 * uniformMidrankT(rank, count));
    const start = medianOf(order, pairs, slotAngles)!;
    const result = refineCircularOrder(order, pairs, slotAngles);
    assert.ok(result.median! <= start, `trial ${trial}: ${result.median} <= ${start}`);
    assert.deepEqual([...result.order].sort(), [...order].sort());
    assert.deepEqual([...refineCircularOrder(order, pairs, slotAngles).order], [...result.order]);
  }
});

test('refinement caps and inputs are enforced', () => {
  const ids = ['x0', 'x1', 'x2', 'x3'];
  const angles = [0, 0.1, 0.2, 0.3];
  const pairs: Pair[] = [['x0', 'x3'], ['x1', 'x2']];
  assert.deepEqual([...refineCircularOrder(ids, pairs, angles, 0).order], ids);
  assert.deepEqual([...refineCircularOrder(ids, pairs, angles, 8, 0).order], ids);
  assert.equal(refineCircularOrder(ids, [], angles).median, null);
  assert.throws(() => refineCircularOrder(ids, pairs, [0, 1]), /slot angles/);
  assert.throws(() => refineCircularOrder(ids, [['x0', 'zz']], angles), /outside the order/);
});

test('the giant typed allocation is unchanged and reports its own candidate name', () => {
  const giant = Array.from({ length: 40 }, (_, i) => `g${pad(i)}`);
  const small = Array.from({ length: 6 }, (_, i) => `s${pad(i)}`);
  const nodes = [
    ...giant.map((id, i) => ({ id, communityId: 'giant', importance: i })),
    ...small.map((id, i) => ({ id, communityId: 'small', importance: 50 + i })),
  ];
  const edges: FractalSectorEdge[] = [];
  for (let i = 0; i + 1 < giant.length; i += 1) edges.push(edgeOf(`ge${pad(i)}`, giant[i]!, giant[i + 1]!));
  for (let i = 0; i + 1 < small.length; i += 1) edges.push(edgeOf(`se${pad(i)}`, small[i]!, small[i + 1]!));
  const base = inputOf(nodes, edges, [{ id: 'giant', members: giant }, { id: 'small', members: small }]);
  const input: FractalSectorInput = {
    ...base,
    communities: [
      { communityId: 'giant', memberNodeIds: giant, hierarchyChildren: [
        { childId: 'gc0', memberNodeIds: giant.slice(0, 15) },
        { childId: 'gc1', memberNodeIds: giant.slice(15, 30) },
      ] },
      { communityId: 'small', memberNodeIds: small },
    ],
  };
  const result = assigned(input);
  const giantSector = sectorOf(result, 'giant');
  assert.equal(giantSector.orderCandidate, 'giant-allocation');
  assert.notEqual(giantSector.allocation, null);
  assert.equal(giantSector.allocation!.groupSubSectors.length, 2);
  assert.doesNotMatch(sectorOf(result, 'small').orderCandidate, /^giant-allocation$/);
});

test('determinism: repeated and permuted inputs choose the same candidate and coordinates', () => {
  const sizes = [40, 30, 25, 12, 8];
  let state = 987654321;
  const next = (bound: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % bound; };
  const nodes: FractalSectorNode[] = [];
  const edges: FractalSectorEdge[] = [];
  const groups: { id: string; members: string[] }[] = [];
  sizes.forEach((size, g) => {
    const members = Array.from({ length: size }, (_, i) => `c${g}n${pad(i)}`);
    members.forEach((id, i) => nodes.push({ id, communityId: `c${g}`, importance: (i * 7) % size }));
    for (let e = 0; e < Math.floor(size / 2); e += 1) {
      const u = next(size);
      const v = next(size);
      if (u !== v) edges.push(edgeOf(`c${g}e${pad(e)}`, members[u]!, members[v]!));
    }
    groups.push({ id: `c${g}`, members });
  });
  const input = inputOf(nodes, edges, groups, 1e9);
  const first = assigned(input);
  assert.equal(JSON.stringify(assigned(input)), JSON.stringify(first));
  const permuted = inputOf(
    [...nodes].reverse(),
    [...edges].reverse(),
    [...groups].reverse().map((group) => ({ id: group.id, members: [...group.members].reverse() })),
    1e9,
  );
  const second = assigned(permuted);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(second.assignmentDigest, first.assignmentDigest);
  assert.ok(first.sectors.every((sector) => sector.orderCandidate.length > 0));
});
