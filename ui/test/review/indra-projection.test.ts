/**
 * Indra's Pearls projection assembly tests (D-073 row D7): complete ProjectionResult, contract
 * validator against independently derived witnesses, source-ledger conservation, exact
 * known-answer geometry (disc images, paired-disc slots, generator orbits), the bounded lazy
 * level tree (`requestedLevelId`, caps, stale tokens), the labelled fallback packing,
 * determinism (repeat, permuted snapshot arrays) and `request.abort`.
 *
 * The fixture is a synthetic raw ledger with six real hierarchy roots of distinct sizes
 * (16, 13, 11, 9, 7, 4 members), so the ring packing certifies a genus-3 group and every
 * depth-1 letter carries exactly one real community. Edges are original attested hierarchy
 * edges plus attested and exploratory cross-community edges, several between the same pair of
 * communities so that lifted routes bundle more than one real edge.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { validateProjectionResult, type ProjectionValidationContext } from '../../src/projection/contract.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import {
  indraContainerId, indraLiftedRouteId, indraOrbitCurveId, indraRequestForLevelToken, indrasPearlsProjection,
  INDRA_DISPLAY_SCALE, INDRA_GENERATOR_POLICY, INDRA_LEVEL_CACHE, INDRA_PROJECTION_VERSION, IndraProjectionRefusal,
  mobiusImageOfDisc, parseIndraLevelId, pearlSlotOffset, planeDiscContains, schottkyPearlDisc,
  type IndraLoadToken,
} from '../../src/projection/indra.ts';
import {
  compareCodepointIds, enumerateReducedWords, pearlMemberDigest, reducedWordCount, wordKey,
  type ReducedWord,
} from '../../src/indra/assignment.ts';
import { levelIdForWord, ROOT_LEVEL_ID } from '../../src/indra/levels.ts';
import { cx, cxAbs, cxSub } from '../../src/indra/complex.ts';
import { halfSpaceHyperbolicDistance } from '../../src/indra/geometry3d.ts';
import { mobiusApply, mobiusMatrix } from '../../src/indra/mobius.ts';
import { buildSchottkyGroup, packPairedDiscsOnRing } from '../../src/indra/schottky.ts';
import type {
  AnalyticalDomain, ProjectionRequest, ProjectionResult, RecursiveLevel, SemanticGraphSnapshot,
} from '../../src/projection/contract-types.ts';

type IndraRequest = ProjectionRequest<'indras-pearls'>;
const pad = (value: number): string => String(value).padStart(2, '0');

function rawNode(id: string, level: 1 | 2 | 3, parent: string | null, importance: number): Record<string, unknown> {
  return {
    id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
    title: `Titolo ${id}`, title_full: `Titolo ${id}`,
    importance: { value: importance, components: {} }, size: 1,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  };
}

interface CommunitySpec { readonly id: string; readonly children: number; readonly leavesPerChild: number }
const COMMUNITIES: readonly CommunitySpec[] = [
  { id: 'a', children: 3, leavesPerChild: 4 }, // 16 members
  { id: 'b', children: 3, leavesPerChild: 3 }, // 13
  { id: 'c', children: 2, leavesPerChild: 4 }, // 11
  { id: 'd', children: 2, leavesPerChild: 3 }, // 9
  { id: 'e', children: 2, leavesPerChild: 2 }, // 7
  { id: 'f', children: 1, leavesPerChild: 2 }, // 4
];
const COMMUNITY_SIZES = new Map(COMMUNITIES.map(spec => [`n:${spec.id}`, 1 + spec.children * (1 + spec.leavesPerChild)]));

function buildLedger(specs: readonly CommunitySpec[], crossEdges: boolean): { rawNodes: Record<string, unknown>[]; rawEdges: Record<string, unknown>[] } {
  const rawNodes: Record<string, unknown>[] = [];
  const rawEdges: Record<string, unknown>[] = [];
  let importanceIndex = 0;
  const nextImportance = (): number => ((importanceIndex++ * 37) % 101 + 1) / 102;
  const addEdge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory'): void => {
    rawEdges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
  };
  for (const spec of specs) {
    const root = `n:${spec.id}`;
    rawNodes.push(rawNode(root, 1, null, nextImportance()));
    for (let child = 1; child <= spec.children; child += 1) {
      const childId = `${root}:${pad(child)}`;
      rawNodes.push(rawNode(childId, 2, root, nextImportance()));
      addEdge(`att:${spec.id}:${pad(child)}`, root, childId, 'attested');
      for (let leaf = 1; leaf <= spec.leavesPerChild; leaf += 1) {
        const leafId = `${childId}:${pad(leaf)}`;
        rawNodes.push(rawNode(leafId, 3, childId, nextImportance()));
        addEdge(`att:${spec.id}:${pad(child)}:${pad(leaf)}`, childId, leafId, 'attested');
      }
    }
  }
  if (crossEdges) {
    addEdge('x:ab:1', 'n:a:01:01', 'n:b:01:01', 'attested');
    addEdge('x:ab:2', 'n:a:02:02', 'n:b:02', 'attested');
    addEdge('x:ab:3', 'n:a:03', 'n:b:03:03', 'exploratory');
    addEdge('x:bc:1', 'n:b:01', 'n:c:01:01', 'attested');
    addEdge('x:cd:1', 'n:c:02:04', 'n:d:01', 'exploratory');
    addEdge('x:ae:1', 'n:a', 'n:e', 'attested');
    addEdge('x:df:1', 'n:d:02:03', 'n:f:01:02', 'attested');
    addEdge('x:ef:1', 'n:e:02:01', 'n:f', 'attested');
    addEdge('x:ff:1', 'n:f:01:01', 'n:f:01:02', 'attested');
  }
  return { rawNodes, rawEdges };
}

interface Fixture {
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  readonly request: IndraRequest;
  readonly sourceBytes: Uint8Array;
}

async function makeFixture(specs: readonly CommunitySpec[], crossEdges = true, domainFilter?: (id: string) => boolean): Promise<Fixture> {
  const { rawNodes, rawEdges } = buildLedger(specs, crossEdges);
  const input = {
    manifest: { fixture: 'indra-projection-d7' },
    index: { schema: 'nousos.review-graph/2', nodes: rawNodes, edges: rawEdges },
    details: [],
  };
  const sourceBytes = canonicalSourceBytes(input);
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
  const ids = snapshot.nodes.map(node => node.id).filter(domainFilter ?? (() => true));
  const domain = selectAnalyticalDomain(snapshot, ids);
  const request: IndraRequest = {
    id: 'indras-pearls', snapshotDigest: snapshot.digest, domain,
    parameters: { dimension: '2d', maxDepth: 3, maxWords: 200, generatorPolicy: INDRA_GENERATOR_POLICY, tolerance: 1e-6, expandZ: 1 },
  };
  return { snapshot, domain, request, sourceBytes };
}

let fixturePromise: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
  fixturePromise ??= makeFixture(COMMUNITIES);
  return fixturePromise;
}

function withParameters(request: IndraRequest, patch: Partial<IndraRequest['parameters']>): IndraRequest {
  return { ...request, parameters: { ...request.parameters, ...patch } };
}

function keyOfLevelId(levelId: string): string {
  const parsed = parseIndraLevelId(levelId);
  assert.ok(parsed !== null && parsed.kind === 'word', `${levelId} is not a word level`);
  return wordKey(parsed.word);
}

function wordOfLevelId(levelId: string): ReducedWord {
  const parsed = parseIndraLevelId(levelId);
  assert.ok(parsed !== null, `${levelId} is not a level`);
  return parsed.kind === 'root' ? [] : parsed.word;
}

function loadedMembers(level: RecursiveLevel): readonly string[] {
  if (!level.loaded) assert.fail(`level ${level.id} must be loaded`);
  return level.memberNodeIds;
}

/**
 * Independent level witnesses: a loaded level's members are its own; an opened (unloaded) level's
 * members are the union of its descendants in the same result; an unopened stub's members come
 * from a second run that opens exactly that stub and unions its children.
 */
async function levelWitnesses(fx: Fixture, result: ProjectionResult, request: IndraRequest = fx.request):
Promise<Record<string, { memberNodeIds: string[]; memberDigest: string }>> {
  const byId = new Map(result.levels.map(level => [level.id, level]));
  const cache = new Map<string, readonly string[]>();
  const membersIn = async (levels: ReadonlyMap<string, RecursiveLevel>, id: string): Promise<readonly string[]> => {
    const level = levels.get(id)!;
    if (level.loaded) return level.memberNodeIds;
    const children = level.childLevelIds.filter(childId => levels.has(childId));
    if (children.length === 0) return [];
    const union: string[] = [];
    for (const childId of children) union.push(...await membersIn(levels, childId));
    return union;
  };
  const witnesses: Record<string, { memberNodeIds: string[]; memberDigest: string }> = {};
  for (const level of result.levels) {
    let members = cache.get(level.id);
    if (members === undefined) {
      members = await membersIn(byId, level.id);
      if (members.length === 0 && level.memberCount > 0) {
        // A stub is opened directly; a stub whose children exceed a cap cannot open, so its parent is opened and the stub is read as a loaded child.
        let opened: ProjectionResult;
        try {
          opened = await indrasPearlsProjection.project(fx.snapshot, { ...request, requestedLevelId: level.id });
        } catch (error) {
          if (!(error instanceof IndraProjectionRefusal) || !/cap-exceeded/.test(error.code)) throw error;
          opened = await indrasPearlsProjection.project(fx.snapshot, { ...request, requestedLevelId: level.parentId! });
        }
        members = await membersIn(new Map(opened.levels.map(item => [item.id, item])), level.id);
      }
      cache.set(level.id, members);
    }
    const sorted = [...members].sort(compareCodepointIds);
    witnesses[level.id] = { memberNodeIds: sorted, memberDigest: pearlMemberDigest(wordOfLevelId(level.id), sorted) };
  }
  return witnesses;
}

/** Independent lifted-route witness: the real domain edges between each pair of loaded pearls. */
function liftedRouteWitnesses(fx: Fixture, result: ProjectionResult): Record<string, string[]> {
  const levelOfNode = new Map<string, string>();
  for (const level of result.levels) if (level.loaded) for (const id of level.memberNodeIds) levelOfNode.set(id, level.id);
  const witnesses: Record<string, string[]> = {};
  for (const edge of fx.snapshot.edges) {
    if (!fx.domain.edgeIds.includes(edge.id)) continue;
    const from = levelOfNode.get(edge.source)!;
    const to = levelOfNode.get(edge.target)!;
    if (from === to) continue;
    const [first, second] = [keyOfLevelId(from), keyOfLevelId(to)].sort(compareCodepointIds);
    (witnesses[indraLiftedRouteId(first!, second!)] ??= []).push(edge.id);
  }
  return witnesses;
}

async function validationContext(fx: Fixture, result: ProjectionResult, request: IndraRequest = fx.request): Promise<ProjectionValidationContext> {
  return { snapshot: fx.snapshot, domain: fx.domain, request,
    witnesses: { levels: await levelWitnesses(fx, result, request), liftedRouteEdgeIds: liftedRouteWitnesses(fx, result) } };
}

test('the projection assembles a complete contract-valid 2D result from a certified Schottky group', async () => {
  const fx = await fixture();
  const { snapshot, domain, request } = fx;
  const result = await indrasPearlsProjection.project(snapshot, request);

  assert.equal(indrasPearlsProjection.id, 'indras-pearls');
  assert.equal(indrasPearlsProjection.version, INDRA_PROJECTION_VERSION);
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.ok(Object.hasOwn(result, 'positions2') && !Object.hasOwn(result, 'positions3'));
  assert.deepEqual(result.loadedNodeIds, domain.nodeIds);
  assert.deepEqual(Object.keys(result.positions2!).sort(compareCodepointIds), [...domain.nodeIds]);
  assert.equal(result.determinism.algorithmId, 'indras-pearls');
  assert.ok(result.determinism.parameterHash.length > 0 && result.determinism.resultDigest.length > 0);
  assert.deepEqual(result.fields, []);

  // The contract validator accepts the result against independently derived witnesses.
  const context = await validationContext(fx, result);
  assert.doesNotThrow(() => validateProjectionResult(result, context));

  // Six real hierarchy roots: a genus-3 group, six depth-1 pearls, all conserved.
  const diagnostic = (code: string) => result.diagnostics.find(item => item.code === code)!;
  assert.equal(diagnostic('indra:geometry-mode').value, 'schottky');
  assert.equal(diagnostic('indra:genus').value, 3);
  assert.equal(diagnostic('indra:word-count:depth-1').value, 6);
  assert.equal(diagnostic('indra:word-capacity:depth-1').value, reducedWordCount(3, 1));
  assert.equal(diagnostic('indra:member-conservation').value, 1);
  assert.ok(Number(diagnostic('indra:schottky-min-separation').value) > request.parameters.tolerance);
  assert.equal(diagnostic('indra:schottky-min-separation').acceptable, true);
  assert.ok(Number(diagnostic('indra:max-generator-condition').value) >= 1);
  assert.ok(Number(diagnostic('indra:max-exterior-image-ratio').value) < 1);
  assert.equal(diagnostic('indra:level-count').acceptable, true);
  for (const item of result.diagnostics) assert.ok(item.acceptable, `${item.code} must be acceptable on the reference fixture`);

  // Levels: an unopened-root promise whose six children are the loaded depth-1 pearls.
  const levels = new Map(result.levels.map(level => [level.id, level]));
  const root = levels.get(ROOT_LEVEL_ID)!;
  assert.equal(root.loaded, false);
  assert.equal(root.parentId, null);
  assert.equal(root.memberCount, domain.nodeIds.length);
  assert.equal(root.childLevelIds.length, 6);
  const loadedIds = new Set<string>();
  for (const levelId of root.childLevelIds) {
    const level = levels.get(levelId)!;
    assert.equal(level.depth, 1);
    assert.equal(level.loaded, true);
    for (const id of loadedMembers(level)) {
      assert.ok(!loadedIds.has(id), `node ${id} appears in two loaded levels`);
      loadedIds.add(id);
    }
  }
  assert.deepEqual([...loadedIds].sort(compareCodepointIds), [...domain.nodeIds], 'every domain node exactly once');

  // Unopened grandchildren keep identity, count, digest and a token, and no coordinates.
  const stub = [...levels.values()].find(level => level.depth === 2)!;
  assert.equal(stub.loaded, false);
  assert.ok(!('memberNodeIds' in stub) && !('inducedEdgeIds' in stub));
  if (stub.loaded) assert.fail('stub must be unloaded');
  assert.equal(stub.loadToken.projectionId, 'indras-pearls');
  assert.equal(stub.loadToken.snapshotDigest, snapshot.digest);
  assert.equal(stub.loadToken.domainDigest, domain.domainDigest);
  assert.equal(stub.loadToken.parameterHash, result.determinism.parameterHash);
  assert.equal(stub.loadToken.levelId, stub.id);
  assert.deepEqual(result.lod.progressiveLevelIds, [...levels.values()].filter(level => level.loaded).map(level => level.id));
});

test('every pearl container holds its members inside its disc, and sibling discs are disjoint', async () => {
  const { snapshot, request } = await fixture();
  const result = await indrasPearlsProjection.project(snapshot, request);
  const levels = new Map(result.levels.map(level => [level.id, level]));
  assert.equal(result.containers.length, 6);
  for (const container of result.containers) {
    assert.equal(container.shape, 'circle');
    assert.equal(container.parentVisualId, null);
    assert.ok(container.center2 !== undefined && container.radius !== undefined && container.radius > 0);
    assert.ok(!Object.hasOwn(container, 'center3'));
    const level = levels.get(container.levelId)!;
    assert.deepEqual(container.memberNodeIds, loadedMembers(level));
    assert.equal(container.memberCount, container.memberNodeIds!.length);
    for (const id of container.memberNodeIds!) {
      const point = result.positions2![id]!;
      const distance = Math.hypot(point.x - container.center2!.x, point.y - container.center2!.y);
      assert.ok(distance < container.radius!, `node ${id} lies strictly inside its pearl`);
      assert.ok(distance <= 0.85 * container.radius! + 1e-9, `node ${id} keeps the documented margin from the pearl boundary`);
    }
  }
  for (let i = 0; i < result.containers.length; i += 1) {
    for (let j = i + 1; j < result.containers.length; j += 1) {
      const a = result.containers[i]!;
      const b = result.containers[j]!;
      const gap = Math.hypot(a.center2!.x - b.center2!.x, a.center2!.y - b.center2!.y) - a.radius! - b.radius!;
      assert.ok(gap > 0, `pearls ${a.visualId} and ${b.visualId} overlap`);
    }
  }
  // Positions are pairwise distinct (no two nodes collapse on one slot).
  const seen = new Set(Object.values(result.positions2!).map(point => `${point!.x}|${point!.y}`));
  assert.equal(seen.size, Object.keys(result.positions2!).length);
});

test('the six depth-1 pearls are the paired discs at the weight-ordered slots, one real community each', async () => {
  const { snapshot, request } = await fixture();
  const result = await indrasPearlsProjection.project(snapshot, request);
  // Children by descending size: a(16) b(13) c(11) d(9) e(7) f(4) fill slots 0..5; letter +i is slot 2i+1 and -i is slot 2i.
  const slotOrder = [...COMMUNITY_SIZES.entries()].sort((left, right) => (right[1] - left[1]) || compareCodepointIds(left[0], right[0]));
  const expectedByWord = new Map<string, string>();
  slotOrder.forEach(([communityId], slot) => {
    const generator = Math.floor(slot / 2);
    expectedByWord.set(`${generator}${slot % 2 === 0 ? '-' : '+'}`, communityId);
  });
  const pairRadius = (pair: number): number => 0.4 * slotOrder[2 * pair]![1] / slotOrder[0]![1];
  for (const container of result.containers) {
    const key = keyOfLevelId(container.levelId);
    const communityId = expectedByWord.get(key)!;
    assert.equal(container.sourceCommunityId, communityId, `pearl ${key}`);
    assert.equal(container.memberCount, COMMUNITY_SIZES.get(communityId));
    assert.ok(container.memberNodeIds!.every(id => id === communityId || id.startsWith(`${communityId}:`)));
    // Pair radius is proportional to the heavier child of the pair (known answer, unscaled 0.4 * w / w_max).
    const generator = Number(key.slice(0, -1));
    assert.ok(Math.abs(container.radius! / INDRA_DISPLAY_SCALE - pairRadius(generator)) < 1e-12);
  }
});

test('the assembled result conserves the source ledger and domain against the independent oracle', async () => {
  const fx = await fixture();
  const result = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const context = await validationContext(fx, result);
  await assert.doesNotReject(assertProjectionInvariants(result, context, {
    expectedSourceBytes: fx.sourceBytes,
    semanticEdgeCarriers: fx.snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, class: edge.attestation })),
  }));
  const sourceIds = new Set([...fx.snapshot.nodes.map(node => node.id), ...fx.snapshot.edges.map(edge => edge.id)]);
  assert.deepEqual(result.domainNodeIds, fx.domain.nodeIds);
  assert.deepEqual(result.domainEdgeIds, fx.domain.edgeIds);
  for (const container of result.containers) assert.ok(!sourceIds.has(container.visualId));
  for (const curve of result.curves) assert.ok(!sourceIds.has(curve.visualId));
  for (const relation of result.visualRelations) assert.ok(!sourceIds.has(relation.visualId));
});

test('lifted routes are semantic:false bundles over real cross-pearl edges, never new edges', async () => {
  const fx = await fixture();
  const result = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const levelOfNode = new Map<string, string>();
  for (const level of result.levels) if (level.loaded) for (const id of level.memberNodeIds) levelOfNode.set(id, level.id);
  const edges = new Map(fx.snapshot.edges.map(edge => [edge.id, edge]));
  assert.ok(result.visualRelations.length >= 5);
  const covered = new Set<string>();
  for (const relation of result.visualRelations) {
    assert.equal(relation.semantic, false);
    assert.equal(relation.kind, 'lifted-route');
    assert.ok(relation.visualId.startsWith('visual:'));
    assert.ok(relation.underlyingEdgeIds.length > 0);
    assert.equal(relation.count, relation.underlyingEdgeIds.length);
    assert.equal(relation.explanationId, relation.visualId);
    assert.notEqual(levelOfNode.get(relation.source), levelOfNode.get(relation.target));
    const pair = new Set([levelOfNode.get(relation.source), levelOfNode.get(relation.target)]);
    for (const edgeId of relation.underlyingEdgeIds) {
      const edge = edges.get(edgeId)!;
      assert.deepEqual(new Set([levelOfNode.get(edge.source), levelOfNode.get(edge.target)]), pair, `edge ${edgeId} joins the same two pearls`);
      covered.add(edgeId);
    }
    const explanation = result.explanations[relation.explanationId]!;
    assert.equal(explanation.elementKind, 'visual-relation');
    assert.deepEqual([...explanation.sourceIds], [...relation.underlyingEdgeIds].sort(compareCodepointIds));
  }
  // Exactly the cross-pearl source edges are bundled: 8 cross edges; the within-community edge is not.
  assert.deepEqual([...covered].sort(compareCodepointIds), fx.domain.edgeIds.filter(id => id.startsWith('x:') && id !== 'x:ff:1'));
  const bundled = result.visualRelations.find(relation => relation.count === 3)!;
  assert.deepEqual([...bundled.underlyingEdgeIds].sort(compareCodepointIds), ['x:ab:1', 'x:ab:2', 'x:ab:3']);
  // The original semantic edges stay in the domain, one per source edge, untouched.
  assert.deepEqual(result.domainEdgeIds, fx.domain.edgeIds);
});

test('mobiusImageOfDisc is the exact disc image: sampled circle points land on the image circle', () => {
  const matrix = mobiusMatrix(cx(2, 1), cx(-1, 3), cx(0.5, -0.25), cx(1, 2));
  const disc = { center: cx(3, -2), radius: 0.75 };
  const image = mobiusImageOfDisc(matrix, disc);
  for (let index = 0; index < 64; index += 1) {
    const angle = (2 * Math.PI * index) / 64;
    const onCircle = cx(disc.center.re + disc.radius * Math.cos(angle), disc.center.im + disc.radius * Math.sin(angle));
    const mapped = mobiusApply(matrix, onCircle);
    assert.equal(mapped.kind, 'finite');
    if (mapped.kind === 'finite') assert.ok(Math.abs(cxAbs(cxSub(mapped.value, image.center)) - image.radius) < 1e-9 * Math.max(1, image.radius));
  }
  // The interior maps to the interior: the image of the centre lies inside the image disc.
  const centreImage = mobiusApply(matrix, disc.center);
  assert.equal(centreImage.kind, 'finite');
  if (centreImage.kind === 'finite') assert.ok(cxAbs(cxSub(centreImage.value, image.center)) < image.radius);
  // Affine case (c = 0): centre maps, radius scales by |a/d|.
  const affine = mobiusImageOfDisc(mobiusMatrix(cx(2, 0), cx(1, 1), cx(0, 0), cx(0, 1)), { center: cx(1, 0), radius: 3 });
  // f(z) = (2 z + 1 + i) / i, so f(1) = (3 + i) / i = 1 - 3i and the radius scales by |2 / i| = 2.
  assert.ok(cxAbs(cxSub(affine.center, cx(1, -3))) < 1e-12);
  assert.ok(Math.abs(affine.radius - 6) < 1e-12);
  // Negative control: a disc containing the pole of the map is refused typed, never inverted into an exterior.
  const pole = cx(-1, 0);
  const thrown = (call: () => unknown): unknown => { try { call(); } catch (error) { return error; } assert.fail('the call must throw'); };
  const poleRefusal = thrown(() => mobiusImageOfDisc(mobiusMatrix(cx(1, 0), cx(0, 0), cx(1, 0), cx(1, 0)), { center: pole, radius: 0.5 })) as IndraProjectionRefusal;
  assert.ok(poleRefusal instanceof IndraProjectionRefusal);
  assert.equal(poleRefusal.code, 'pole-in-disc');
  assert.equal(poleRefusal.name, 'IndraProjectionRefusal');
  assert.ok(!(poleRefusal instanceof RangeError), 'the refusal is not a plain RangeError');
  // Negative control: a tangent disc (D = 0) is the same typed pole refusal, not a zero-radius image.
  assert.throws(() => mobiusImageOfDisc(mobiusMatrix(cx(1, 0), cx(0, 0), cx(1, 0), cx(1, 0)), { center: pole, radius: 1 }), /pole-in-disc/);
});

test('a disc image the inversion makes nonfinite is a typed refusal, never a bogus disc', () => {
  // f(z) = z / (z + 1e-160) has its pole a hair outside the 1e-200 disc at the origin, but
  // |q|^2 - r^2 = 1e-320 is so small that 1/D overflows: the image centre cannot be finite.
  const extreme = mobiusMatrix(cx(1, 0), cx(0, 0), cx(1, 0), cx(1e-160, 0));
  let caught: unknown;
  try { mobiusImageOfDisc(extreme, { center: cx(0, 0), radius: 1e-200 }); } catch (error) { caught = error; }
  assert.ok(caught instanceof IndraProjectionRefusal, `the refusal is typed, got ${String(caught)}`);
  assert.equal((caught as IndraProjectionRefusal).code, 'nonfinite-disc-image');
  assert.equal((caught as IndraProjectionRefusal).name, 'IndraProjectionRefusal');
  assert.ok(!(caught instanceof RangeError), 'the refusal is not a plain RangeError');
  // Positive control: the same map on a disc far from the pole still yields a finite exact image.
  const far = mobiusImageOfDisc(extreme, { center: cx(1, 0), radius: 0.25 });
  assert.ok(Number.isFinite(far.radius) && far.radius > 0);
  const farCentre = mobiusApply(extreme, cx(1, 0));
  assert.equal(farCentre.kind, 'finite');
  if (farCentre.kind === 'finite') assert.ok(cxAbs(cxSub(farCentre.value, far.center)) < far.radius);
});

test('schottky pearl discs are nested images of the paired discs and the letters partition the words', () => {
  const packed = packPairedDiscsOnRing([
    { id: 'p', weight: 16 }, { id: 'q', weight: 13 }, { id: 'r', weight: 11 }, { id: 's', weight: 9 },
  ], { separationMargin: 1e-6 });
  assert.equal(packed.kind, 'packed');
  if (packed.kind !== 'packed') return;
  const built = buildSchottkyGroup(packed.pairs, { separationMargin: 1e-6 });
  assert.equal(built.kind, 'schottky');
  if (built.kind !== 'schottky') return;
  const { group } = built;
  // Depth 1: +i is B_i and -i is A_i exactly.
  for (const generator of group.generators) {
    assert.deepEqual(schottkyPearlDisc(group, [{ generator: generator.index, direction: 1 }]).disc, generator.b);
    assert.deepEqual(schottkyPearlDisc(group, [{ generator: generator.index, direction: -1 }]).disc, generator.a);
  }
  // Depth 2: f_s1(D(s2)) sits inside D(s1), and it equals the sampled image of the s2 disc under f_s1.
  for (const word of enumerateReducedWords(group.genus, 2)) {
    const parent = schottkyPearlDisc(group, word.slice(0, 1)).disc;
    const child = schottkyPearlDisc(group, word);
    assert.ok(cxAbs(cxSub(child.disc.center, parent.center)) + child.disc.radius <= parent.radius, `${wordKey(word)} nests in ${wordKey(word.slice(0, 1))}`);
    const first = word[0]!;
    const matrix = first.direction === 1 ? group.generators[first.generator]!.matrix : group.generators[first.generator]!.inverse;
    const last = word[1]!;
    const base = last.direction === 1 ? group.generators[last.generator]!.b : group.generators[last.generator]!.a;
    for (let index = 0; index < 32; index += 1) {
      const angle = (2 * Math.PI * index) / 32;
      const mapped = mobiusApply(matrix, cx(base.center.re + base.radius * Math.cos(angle), base.center.im + base.radius * Math.sin(angle)));
      assert.equal(mapped.kind, 'finite');
      if (mapped.kind === 'finite') assert.ok(Math.abs(cxAbs(cxSub(mapped.value, child.disc.center)) - child.disc.radius) < 1e-9);
    }
  }
  // Sibling pearls at depth 2 are pairwise disjoint (cylinder discs of distinct words).
  const words = enumerateReducedWords(group.genus, 2);
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i + 1; j < words.length; j += 1) {
      const a = schottkyPearlDisc(group, words[i]!).disc;
      const b = schottkyPearlDisc(group, words[j]!).disc;
      assert.ok(cxAbs(cxSub(a.center, b.center)) > a.radius + b.radius, `${wordKey(words[i]!)} and ${wordKey(words[j]!)} are disjoint`);
    }
  }
  // Negative control: an empty word has no pearl.
  assert.throws(() => schottkyPearlDisc(group, []), /non-empty word/);
});

test('overlapping paired discs are refused by the group construction and never yield a projection geometry', () => {
  const overlapping = buildSchottkyGroup([
    { aCenter: cx(0, 0), bCenter: cx(1, 0), radius: 0.6 },
    { aCenter: cx(0, 3), bCenter: cx(3, 3), radius: 0.5 },
  ]);
  assert.equal(overlapping.kind, 'refusal');
  if (overlapping.kind === 'refusal') assert.equal(overlapping.code, 'circle-overlap');
  assert.equal(packPairedDiscsOnRing([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }]).kind, 'refusal');
});

test('the 3D result lifts every pearl to the hemisphere over its disc and every node inside its sphere', async () => {
  const fx = await fixture();
  const request3 = withParameters(fx.request, { dimension: '3d' });
  const result = await indrasPearlsProjection.project(fx.snapshot, request3);
  assert.ok(Object.hasOwn(result, 'positions3') && !Object.hasOwn(result, 'positions2'));
  const context3 = await validationContext(fx, result, request3);
  assert.doesNotThrow(() => validateProjectionResult(result, context3));
  const levels = new Map(result.levels.map(level => [level.id, level]));
  for (const container of result.containers) {
    assert.equal(container.shape, 'sphere');
    assert.ok(container.center3 !== undefined && container.center3.z === 0, 'the sphere is centred on the boundary plane');
    assert.ok(!Object.hasOwn(container, 'center2'));
    for (const id of loadedMembers(levels.get(container.levelId)!)) {
      const point = result.positions3![id]!;
      assert.ok(point.z > 0, `node ${id} keeps t > 0`);
      const distance = Math.hypot(point.x - container.center3!.x, point.y - container.center3!.y, point.z);
      assert.ok(distance <= container.radius!, `node ${id} lies inside its sphere`);
    }
  }
  assert.equal(result.diagnostics.find(item => item.code === 'indra:3d-node-height-clamped')!.value, 0);
  // Orbit points keep t > 0 and each step is the same hyperbolic isometry: consecutive distances are equal.
  assert.equal(result.curves.length, 3);
  for (const curve of result.curves) {
    assert.equal(curve.purpose, 'orbit');
    assert.ok(curve.points3 !== undefined && !Object.hasOwn(curve, 'points2'));
    assert.equal(curve.points3!.length, 13);
    for (const point of curve.points3!) assert.ok(point.z > 0);
    const points = curve.points3!.map(point => ({ z: cx(point.x / INDRA_DISPLAY_SCALE, point.y / INDRA_DISPLAY_SCALE), t: point.z / INDRA_DISPLAY_SCALE }));
    const distances = points.slice(1).map((point, index) => halfSpaceHyperbolicDistance(points[index]!, point));
    for (let index = 1; index < 6; index += 1) {
      assert.ok(Math.abs(distances[index]! - distances[0]!) < 1e-6 * Math.max(1, distances[0]!), `orbit step ${index} preserves the hyperbolic distance`);
    }
  }
});

test('expandZ scales node heights and clamps them inside the pearl sphere, witnessed', async () => {
  const fx = await fixture();
  const base = await indrasPearlsProjection.project(fx.snapshot, withParameters(fx.request, { dimension: '3d', expandZ: 1 }));
  const flat = await indrasPearlsProjection.project(fx.snapshot, withParameters(fx.request, { dimension: '3d', expandZ: 0.3 }));
  const tall = await indrasPearlsProjection.project(fx.snapshot, withParameters(fx.request, { dimension: '3d', expandZ: 2.5 }));
  for (const id of fx.domain.nodeIds) {
    const a = base.positions3![id]!;
    const b = flat.positions3![id]!;
    assert.equal(a.x, b.x);
    assert.equal(a.y, b.y);
    assert.ok(Math.abs(b.z - 0.3 * a.z) < 1e-9 * Math.max(1, a.z), `node ${id} scales linearly while unclamped`);
  }
  assert.equal(flat.diagnostics.find(item => item.code === 'indra:3d-node-height-clamped')!.value, 0);
  const clamped = Number(tall.diagnostics.find(item => item.code === 'indra:3d-node-height-clamped')!.value);
  assert.ok(clamped > 0, 'a tall lift reaches the sphere bound for some nodes');
  const levels = new Map(tall.levels.map(level => [level.id, level]));
  for (const container of tall.containers) {
    for (const id of loadedMembers(levels.get(container.levelId)!)) {
      const point = tall.positions3![id]!;
      assert.ok(Math.hypot(point.x - container.center3!.x, point.y - container.center3!.y, point.z) < container.radius!, `node ${id} stays inside its sphere`);
    }
  }
  assert.notEqual(tall.determinism.parameterHash, base.determinism.parameterHash);
});

test('orbit curves follow the paired-disc map and converge to its attracting fixed point (2D)', async () => {
  const { snapshot, request } = await fixture();
  const result = await indrasPearlsProjection.project(snapshot, request);
  assert.equal(result.curves.length, 3);
  const disc = (key: string): { re: number; im: number; radius: number } => {
    const container = result.containers.find(item => keyOfLevelId(item.levelId) === key)!;
    return { re: container.center2!.x / INDRA_DISPLAY_SCALE, im: container.center2!.y / INDRA_DISPLAY_SCALE, radius: container.radius! / INDRA_DISPLAY_SCALE };
  };
  for (let generator = 0; generator < 3; generator += 1) {
    const curve = result.curves.find(item => item.visualId === indraOrbitCurveId(generator))!;
    assert.equal(curve.purpose, 'orbit');
    assert.equal(curve.points2!.length, 13);
    const a = disc(`${generator}-`);
    const b = disc(`${generator}+`);
    const points = curve.points2!.map(point => ({ re: point.x / INDRA_DISPLAY_SCALE, im: point.y / INDRA_DISPLAY_SCALE }));
    assert.deepEqual(points[0], { re: 0, im: 0 });
    for (let step = 0; step + 1 < points.length; step += 1) {
      // Closed form f(z) = b + r^2 / (z - a), independent of the matrix code.
      const dx = points[step]!.re - a.re;
      const dy = points[step]!.im - a.im;
      const norm = dx * dx + dy * dy;
      const expected = { re: b.re + (a.radius * a.radius * dx) / norm, im: b.im - (a.radius * a.radius * dy) / norm };
      assert.ok(Math.hypot(points[step + 1]!.re - expected.re, points[step + 1]!.im - expected.im) < 1e-9, `generator ${generator} step ${step}`);
    }
    const last = points[12]!;
    assert.ok(Math.hypot(last.re - b.re, last.im - b.im) < b.radius, 'the orbit ends inside the disc B');
    const explanation = result.explanations[curve.visualId]!;
    assert.equal(explanation.elementKind, 'curve');
    assert.ok(Number(explanation.numericalWitness!.finalStepDistance) < 1e-3, 'the orbit has contracted');
    assert.deepEqual([...explanation.sourceIds], []);
    assert.ok(explanation.limitation!.includes('never displayed') && explanation.limitation!.includes('derived geometry'));
  }
});

test('requestedLevelId opens exactly one pearl whose children are the real induced subgraph', async () => {
  const fx = await fixture();
  const first = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const target = first.containers.find(container => container.sourceCommunityId === 'n:b')!;
  const targetLevelId = target.levelId;
  const openedRequest: IndraRequest = { ...fx.request, requestedLevelId: targetLevelId };
  const opened = await indrasPearlsProjection.project(fx.snapshot, openedRequest);
  const context = await validationContext(fx, opened, openedRequest);
  assert.doesNotThrow(() => validateProjectionResult(opened, context));
  await assert.doesNotReject(assertProjectionInvariants(opened, context, { expectedSourceBytes: fx.sourceBytes }));
  assert.deepEqual(opened.loadedNodeIds, fx.domain.nodeIds);
  assert.notEqual(opened.determinism.resultDigest, first.determinism.resultDigest);
  assert.equal(opened.determinism.parameterHash, first.determinism.parameterHash, 'the level does not enter the parameter hash');

  const levels = new Map(opened.levels.map(level => [level.id, level]));
  const promise = levels.get(targetLevelId)!;
  assert.equal(promise.loaded, false, 'an opened pearl is an aggregate promise; its children carry the members');
  assert.ok(promise.childLevelIds.length >= 2);
  const children = promise.childLevelIds.map(id => levels.get(id)!);
  const targetMembers = first.containers.find(container => container.levelId === targetLevelId)!.memberNodeIds!;
  const childMembers: string[] = [];
  for (const child of children) {
    assert.equal(child.loaded, true);
    assert.equal(child.depth, 2);
    assert.equal(child.parentId, targetLevelId);
    childMembers.push(...loadedMembers(child));
    // Induced edges are exactly the source edges with both endpoints in the child (independent recomputation).
    const members = new Set(loadedMembers(child));
    const expected = fx.snapshot.edges.filter(edge => members.has(edge.source) && members.has(edge.target)).map(edge => edge.id).sort(compareCodepointIds);
    if (!child.loaded) assert.fail('child must be loaded');
    assert.deepEqual([...child.inducedEdgeIds], expected);
  }
  assert.deepEqual(childMembers.sort(compareCodepointIds), [...targetMembers].sort(compareCodepointIds), 'children partition the opened pearl');
  // The other five depth-1 pearls stay loaded, positioned in their own discs.
  assert.equal([...levels.values()].filter(level => level.depth === 1 && level.loaded).length, 5);
  // Child containers nest inside the opened container, which keeps its geometry but lists no members.
  const openedContainer = opened.containers.find(container => container.visualId === indraContainerId(keyOfLevelId(targetLevelId)))!;
  assert.ok(!Object.hasOwn(openedContainer, 'memberNodeIds'));
  assert.equal(openedContainer.memberCount, targetMembers.length);
  for (const childId of promise.childLevelIds) {
    const container = opened.containers.find(item => item.visualId === indraContainerId(keyOfLevelId(childId)))!;
    assert.equal(container.parentVisualId, openedContainer.visualId);
    const gap = openedContainer.radius! - Math.hypot(container.center2!.x - openedContainer.center2!.x, container.center2!.y - openedContainer.center2!.y) - container.radius!;
    assert.ok(gap >= -1e-9, `child pearl ${container.visualId} nests in its parent`);
    for (const id of container.memberNodeIds!) {
      const point = opened.positions2![id]!;
      assert.ok(Math.hypot(point.x - container.center2!.x, point.y - container.center2!.y) < container.radius!);
    }
  }
  // Opening the root explicitly is the default request.
  const explicitRoot = await indrasPearlsProjection.project(fx.snapshot, { ...fx.request, requestedLevelId: ROOT_LEVEL_ID });
  assert.equal(explicitRoot.determinism.resultDigest, first.determinism.resultDigest);

  // A depth-2 pearl opens as well: the path root -> depth 1 -> depth 2 stays aggregate, its children are depth 3.
  const deeperId = promise.childLevelIds[0]!;
  const deeperRequest: IndraRequest = { ...fx.request, requestedLevelId: deeperId };
  const deeper = await indrasPearlsProjection.project(fx.snapshot, deeperRequest);
  const deeperContext = await validationContext(fx, deeper, deeperRequest);
  assert.doesNotThrow(() => validateProjectionResult(deeper, deeperContext));
  const deeperLevels = new Map(deeper.levels.map(level => [level.id, level]));
  assert.equal(deeperLevels.get(deeperId)!.loaded, false);
  assert.equal(deeperLevels.get(targetLevelId)!.loaded, false);
  assert.equal(deeperLevels.get(ROOT_LEVEL_ID)!.loaded, false);
  const deeperChildren = deeperLevels.get(deeperId)!.childLevelIds.map(id => deeperLevels.get(id)!);
  assert.ok(deeperChildren.length >= 1 && deeperChildren.every(child => child.loaded && child.depth === 3));
  assert.deepEqual(deeper.loadedNodeIds, fx.domain.nodeIds);
});

test('caps are enforced and witnessed: depth cap, word cap and the total level budget', async () => {
  const fx = await fixture();
  const full = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const fullNonRoot = full.levels.filter(level => level.depth > 0).length;
  assert.ok(fullNonRoot > 6);

  // Depth cap 1: only the six pearls; no grandchildren are promised and the cap is witnessed.
  const depthOne = withParameters(fx.request, { maxDepth: 1 });
  const capped = await indrasPearlsProjection.project(fx.snapshot, depthOne);
  assert.equal(capped.levels.filter(level => level.depth > 0).length, 6);
  assert.ok(capped.levels.every(level => level.maxDepth === 1 && level.depth <= 1));
  assert.ok(capped.levels.filter(level => level.depth === 1).every(level => level.childLevelIds.length === 0));
  assert.equal(capped.diagnostics.find(item => item.code === 'indra:depth-cap-pearls')!.value, 6);
  const cappedContext = await validationContext(fx, capped, depthOne);
  assert.doesNotThrow(() => validateProjectionResult(capped, cappedContext));
  // A pearl at the depth cap cannot be opened.
  const atCap = capped.levels.find(level => level.depth === 1)!;
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...depthOne, requestedLevelId: atCap.id }), /depth-cap-exceeded/);

  // Word cap: six depth-1 words exceed a cap of five (refused); a cap of six materialises the six pearls and no promise (witnessed).
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, withParameters(fx.request, { maxWords: 5 })), /word-cap-exceeded/);
  const sixWords = withParameters(fx.request, { maxWords: 6 });
  const tight = await indrasPearlsProjection.project(fx.snapshot, sixWords);
  assert.equal(tight.levels.filter(level => level.depth > 0).length, 6);
  assert.equal(tight.diagnostics.find(item => item.code === 'indra:stub-levels-omitted')!.value, fullNonRoot - 6);
  assert.equal(tight.diagnostics.find(item => item.code === 'indra:materialised-words')!.value, 6);
  assert.equal(tight.diagnostics.find(item => item.code === 'indra:word-capacity:depth-1')!.value, 6);
  assert.equal(tight.diagnostics.find(item => item.code === 'indra:level-count')!.value, 6);
  assert.doesNotThrow(() => validateProjectionResult(tight, { ...cappedContext, request: sixWords }));

  // One word short of the full budget: some parents keep their promises, the rest are omitted whole, the total never exceeds the cap.
  const short = withParameters(fx.request, { maxWords: fullNonRoot - 1 });
  const partial = await indrasPearlsProjection.project(fx.snapshot, short);
  assert.equal(partial.diagnostics.find(item => item.code === 'indra:word-cap-pearls')!.value, 0);
  const partialCount = partial.levels.filter(level => level.depth > 0).length;
  assert.ok(partialCount <= fullNonRoot - 1 && partialCount > 6);
  assert.ok(Number(partial.diagnostics.find(item => item.code === 'indra:stub-levels-omitted')!.value) > 0);
  const partialContext = await validationContext(fx, partial, short);
  assert.doesNotThrow(() => validateProjectionResult(partial, partialContext));

  // The validator enforces the same word budget on a result that overshoots it.
  const fullContext = await validationContext(fx, full);
  assert.throws(() => validateProjectionResult(full, { ...fullContext, request: sixWords }), /word budget exceeded/);

  // Invalid parameters are refused at the boundary.
  for (const patch of [{ maxDepth: 0 }, { maxDepth: 99 }, { maxWords: 0 }, { tolerance: 0 }, { tolerance: 0.5 }, { expandZ: 0.1 },
    { expandZ: 9 }, { generatorPolicy: 'other' }] as const) {
    await assert.rejects(indrasPearlsProjection.project(fx.snapshot, withParameters(fx.request, patch)), IndraProjectionRefusal, JSON.stringify(patch));
  }
});

test('requested levels that are malformed, non-reduced, out of alphabet or empty are refused', async () => {
  const fx = await fixture();
  const first = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  for (const levelId of ['garbage', 'indra-level-1-', 'indra-level-2-0+1', 'indra-level-02-0+1-', 'indra-level-1-07+']) {
    await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...fx.request, requestedLevelId: levelId }), /invalid-request/, levelId);
  }
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...fx.request, requestedLevelId: 'indra-level-1-9+' }), /level-not-found/);
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...fx.request, requestedLevelId: 'indra-level-2-0+0-' }), /level-not-found/);
  // The smallest community (4 members) fills fewer than the five depth-2 slots of its pearl: an empty slot cannot be opened.
  const smallest = first.containers.find(container => container.sourceCommunityId === 'n:f')!;
  const smallestWord = wordOfLevelId(smallest.levelId);
  const present = new Set(first.levels.filter(level => level.parentId === smallest.levelId).map(level => level.id));
  const missing = [{ generator: 0, direction: 1 }, { generator: 0, direction: -1 }, { generator: 1, direction: 1 }, { generator: 1, direction: -1 },
    { generator: 2, direction: 1 }, { generator: 2, direction: -1 }]
    .map(letter => [...smallestWord, letter] as ReducedWord)
    .filter(word => word[word.length - 2]!.generator !== word[word.length - 1]!.generator || word[word.length - 2]!.direction === word[word.length - 1]!.direction)
    .map(word => levelIdForWord(word)).filter(id => !present.has(id));
  assert.ok(missing.length > 0, 'an empty word slot exists under the smallest pearl');
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...fx.request, requestedLevelId: missing[0]! }), /level-not-found/);
  assert.ok(first.diagnostics.find(item => item.code === 'indra:empty-word-slots')!.value as number > 0);
});

test('stale level tokens are refused and a fresh token opens exactly its level', async () => {
  const fx = await fixture();
  const first = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const stub = first.levels.find(level => level.depth === 2)!;
  if (stub.loaded) assert.fail('expected an unopened promise');
  const fresh = await indraRequestForLevelToken(fx.snapshot, fx.request, stub.loadToken);
  assert.equal(fresh.requestedLevelId, stub.id);
  const opened = await indrasPearlsProjection.project(fx.snapshot, fresh);
  assert.equal(opened.levels.find(level => level.id === stub.id)!.loaded, false);
  assert.ok(opened.levels.some(level => level.parentId === stub.id && level.loaded));

  const stale: readonly (readonly [string, IndraLoadToken])[] = [
    ['parameterHash', { ...stub.loadToken, parameterHash: 'stale-parameter-hash' }],
    ['domainDigest', { ...stub.loadToken, domainDigest: 'stale-domain-digest' }],
    ['snapshotDigest', { ...stub.loadToken, snapshotDigest: 'stale-snapshot-digest' }],
    ['projectionId', { ...stub.loadToken, projectionId: 'natural' }],
  ];
  for (const [field, token] of stale) {
    await assert.rejects(indraRequestForLevelToken(fx.snapshot, fx.request, token), /stale-load-token/, field);
  }
  await assert.rejects(indraRequestForLevelToken(fx.snapshot, fx.request, { ...stub.loadToken, levelId: 'not-a-level' }), /stale-load-token/);
  // A token minted under other parameters is stale for this request.
  const other = withParameters(fx.request, { tolerance: 1e-5 });
  const otherStub = (await indrasPearlsProjection.project(fx.snapshot, other)).levels.find(level => level.depth === 2)!;
  if (otherStub.loaded) assert.fail('expected an unopened promise');
  await assert.rejects(indraRequestForLevelToken(fx.snapshot, fx.request, otherStub.loadToken), /stale-load-token/);
  // The contract validator rejects a result whose unopened level carries a stale token.
  const context = await validationContext(fx, first);
  const tampered: ProjectionResult = { ...first, levels: first.levels.map(level =>
    level.id === stub.id && !level.loaded ? { ...level, loadToken: { ...level.loadToken, parameterHash: 'stale-parameter-hash' } } : level) };
  assert.throws(() => validateProjectionResult(tampered, context), /stale load token/);
});

test('the validator rejects results that drop, duplicate or mis-assign a pearl member', async () => {
  const fx = await fixture();
  const result = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const context = await validationContext(fx, result);
  const loaded = result.levels.filter(level => level.loaded);
  const victim = loaded[0]!;
  const other = loaded[1]!;
  if (!victim.loaded || !other.loaded) assert.fail('expected loaded levels');
  const replace = (level: RecursiveLevel): RecursiveLevel => {
    if (level.id === victim.id && level.loaded) {
      return { ...level, memberNodeIds: [...level.memberNodeIds, other.memberNodeIds[0]!], memberCount: level.memberCount + 1 };
    }
    return level;
  };
  assert.throws(() => validateProjectionResult({ ...result, levels: result.levels.map(replace) }, context), /member count mismatch|multiple loaded levels|differs from its exact set/);
  const dropped: ProjectionResult = { ...result, levels: result.levels.map(level =>
    level.id === victim.id && level.loaded ? { ...level, memberNodeIds: level.memberNodeIds.slice(1), memberCount: level.memberCount - 1 } : level) };
  assert.throws(() => validateProjectionResult(dropped, context), /mismatch|differs from its exact set/);
});

test('repeat requests and permuted snapshot arrays produce the identical result digest', async () => {
  const { snapshot, request } = await fixture();
  const first = await indrasPearlsProjection.project(snapshot, request);
  // These witnesses recompute from scratch (the memoization has its own test below).
  INDRA_LEVEL_CACHE.clear();
  const repeat = await indrasPearlsProjection.project(snapshot, request);
  assert.equal(repeat.determinism.resultDigest, first.determinism.resultDigest);
  assert.equal(repeat.determinism.parameterHash, first.determinism.parameterHash);

  INDRA_LEVEL_CACHE.clear();
  const permutedSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges.slice(17), ...snapshot.edges.slice(0, 17)].reverse(),
  } as SemanticGraphSnapshot;
  assert.equal(permutedSnapshot.digest, snapshot.digest);
  const permuted = await indrasPearlsProjection.project(permutedSnapshot, request);
  assert.equal(permuted.determinism.resultDigest, first.determinism.resultDigest);
  assert.deepEqual(permuted.positions2, first.positions2);
  assert.deepEqual(permuted.levels, first.levels);
  INDRA_LEVEL_CACHE.clear();
  const opened = { ...request, requestedLevelId: first.containers[0]!.levelId };
  assert.equal((await indrasPearlsProjection.project(permutedSnapshot, opened)).determinism.resultDigest,
    (await indrasPearlsProjection.project(snapshot, opened)).determinism.resultDigest);

  // Changed parameters change the parameter hash and every token; a changed domain changes the domain digest.
  const other = await indrasPearlsProjection.project(snapshot, withParameters(request, { tolerance: 1e-5 }));
  assert.notEqual(other.determinism.parameterHash, first.determinism.parameterHash);
  assert.notEqual(other.determinism.resultDigest, first.determinism.resultDigest);
  const smaller = await makeFixture(COMMUNITIES, true, id => id !== 'n:f:01:02');
  const smallerResult = await indrasPearlsProjection.project(smaller.snapshot, smaller.request);
  assert.notEqual(smallerResult.determinism.domainDigest, first.determinism.domainDigest);
  assert.equal(smallerResult.loadedNodeIds.length, first.loadedNodeIds.length - 1);
  const smallerContext = await validationContext(smaller, smallerResult);
  assert.doesNotThrow(() => validateProjectionResult(smallerResult, smallerContext));
});

test('the assembly memoizes level expansions in the bounded token-keyed LRU without changing results', async () => {
  const fx = await fixture();
  const opened: IndraRequest = { ...fx.request, requestedLevelId: (await indrasPearlsProjection.project(fx.snapshot, fx.request)).containers[0]!.levelId };
  INDRA_LEVEL_CACHE.clear();
  const first = await indrasPearlsProjection.project(fx.snapshot, opened);
  const expansions = INDRA_LEVEL_CACHE.size;
  assert.ok(expansions >= 2, `the run populated the level cache (${expansions} expansions)`);
  // Keys are the full load tokens: the root and the opened level sit under their own keys.
  const rootToken = { snapshotDigest: fx.snapshot.digest, domainDigest: fx.domain.domainDigest,
    parameterHash: first.determinism.parameterHash, levelId: ROOT_LEVEL_ID };
  assert.equal(INDRA_LEVEL_CACHE.has(rootToken), true);
  assert.equal(INDRA_LEVEL_CACHE.has({ ...rootToken, levelId: opened.requestedLevelId! }), true);
  assert.equal(INDRA_LEVEL_CACHE.has({ ...rootToken, levelId: ROOT_LEVEL_ID, snapshotDigest: 'other-snapshot' }), false, 'a foreign snapshot digest misses');
  // The repeat run hits every expansion: nothing is added, and the result is byte-identical.
  const second = await indrasPearlsProjection.project(fx.snapshot, opened);
  assert.equal(INDRA_LEVEL_CACHE.size, expansions, 'every expansion of the repeat run hit the cache');
  assert.equal(second.determinism.resultDigest, first.determinism.resultDigest, 'a fully cached run keeps the digest');
  assert.deepEqual(second.levels, first.levels);
  assert.deepEqual(second.positions2, first.positions2);
  // Changed parameters hash to a different key: the run misses, recomputes and stays correct.
  const other = await indrasPearlsProjection.project(fx.snapshot, withParameters(opened, { tolerance: 1e-5 }));
  assert.notEqual(other.determinism.parameterHash, first.determinism.parameterHash);
  assert.ok(INDRA_LEVEL_CACHE.size > expansions, 'changed parameters produce new keys');
  assert.equal(INDRA_LEVEL_CACHE.has(rootToken), true, 'the old key survives as its own entry');
  assert.ok(INDRA_LEVEL_CACHE.size <= 64, 'the LRU stays bounded');
});

test('an aborted run leaves the level cache sound and a later run matches the reference digest', async () => {
  const fx = await fixture();
  INDRA_LEVEL_CACHE.clear();
  const reference = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const reason = new Error('stop indra cache');
  let reads = 0;
  const counting = (limit: number): AbortSignal => ({
    get aborted(): boolean { reads += 1; return reads > limit; },
    reason,
  }) as unknown as AbortSignal;
  for (const limit of [0, 2, 5, 9, 14]) {
    reads = 0;
    await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...fx.request, abort: counting(limit) }), /stop indra cache/, `limit ${limit}`);
  }
  // Whatever complete expansions the aborted runs left behind, a clean run replays the reference.
  const after = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  assert.equal(after.determinism.resultDigest, reference.determinism.resultDigest);
  assert.deepEqual(after.levels, reference.levels);
  assert.deepEqual(after.positions2, reference.positions2);
});

test('request.abort is honoured between phases, including the last checkpoint before the digest', async () => {
  const { snapshot, request } = await fixture();
  const before = new AbortController();
  before.abort();
  await assert.rejects(indrasPearlsProjection.project(snapshot, { ...request, abort: before.signal }), /abort/i);

  const reason = new Error('stop indra');
  let reads = 0;
  const counting = (limit: number): AbortSignal => ({
    get aborted(): boolean { reads += 1; return reads > limit; },
    reason,
  }) as unknown as AbortSignal;
  reads = 0;
  const completed = await indrasPearlsProjection.project(snapshot, { ...request, abort: counting(Number.POSITIVE_INFINITY) });
  const totalReads = reads;
  assert.ok(totalReads >= 10, `the projection checks the signal between phases (${totalReads} checks)`);
  assert.ok(completed.determinism.resultDigest.length > 0);
  for (const limit of [0, 1, 3, Math.floor(totalReads / 2), totalReads - 1]) {
    reads = 0;
    await assert.rejects(indrasPearlsProjection.project(snapshot, { ...request, abort: counting(limit) }), /stop indra/, `limit ${limit}`);
  }
  reads = 0;
  const same = await indrasPearlsProjection.project(snapshot, { ...request, abort: counting(totalReads) });
  assert.equal(same.determinism.resultDigest, completed.determinism.resultDigest);
});

test('every container, curve, relation and node has a «why here» explanation with the word, path and witness', async () => {
  const { snapshot, request } = await fixture();
  const result = await indrasPearlsProjection.project(snapshot, request);
  const scale = INDRA_DISPLAY_SCALE;
  for (const container of result.containers) {
    const explanation = result.explanations[container.visualId]!;
    assert.equal(explanation.elementId, container.visualId);
    assert.equal(explanation.elementKind, 'container');
    const witness = explanation.numericalWitness!;
    const key = keyOfLevelId(container.levelId);
    assert.equal(witness.word, key);
    assert.equal(witness.mode, 'schottky');
    assert.equal(witness.depth, 1);
    assert.ok(Math.abs((witness.centreRe as number) * scale - container.center2!.x) < 1e-9);
    assert.ok(Math.abs((witness.centreIm as number) * scale - container.center2!.y) < 1e-9);
    assert.ok(Math.abs((witness.radius as number) * scale - container.radius!) < 1e-9);
    assert.equal(witness.genus, 3);
    assert.ok((witness.separationMargin as number) === request.parameters.tolerance);
    assert.ok(Number.isFinite(witness.maxConditionFrobenius as number));
    assert.ok(explanation.summary.includes(key));
    assert.deepEqual([...explanation.sourceIds], [container.sourceCommunityId]);
    assert.ok(explanation.limitation!.includes('limit set') && explanation.limitation!.includes('provenance'));
    // Source provenance (the IDs) never appears in the mathematical witness.
    assert.ok(!JSON.stringify(witness).includes('n:'));
  }
  for (const id of request.domain.nodeIds) {
    const explanation = result.explanations[id]!;
    assert.equal(explanation.elementKind, 'node');
    assert.equal(explanation.elementId, id);
    const witness = explanation.numericalWitness!;
    assert.ok((witness.offsetRatio as number) < 1);
    assert.ok(Number.isInteger(witness.rank) && (witness.rank as number) >= 0 && (witness.rank as number) < (witness.memberCount as number));
    assert.equal(explanation.sourceIds.length, 1);
  }
  for (const curve of result.curves) assert.equal(result.explanations[curve.visualId]!.elementKind, 'curve');
  for (const relation of result.visualRelations) assert.equal(result.explanations[relation.explanationId]!.elementKind, 'visual-relation');
});

test('planeDiscContains is exact on inside, tangent and crossing discs', () => {
  const parent = { center: cx(1, 1), radius: 2 };
  assert.equal(planeDiscContains(parent, { center: cx(1.5, 1), radius: 0.5 }), true);
  assert.equal(planeDiscContains(parent, { center: cx(2, 1), radius: 1 }), true, 'internally tangent');
  assert.equal(planeDiscContains(parent, { center: cx(2, 1), radius: 1.1 }), false);
  assert.equal(planeDiscContains(parent, { center: cx(4, 1), radius: 0.5 }), false);
  assert.equal(planeDiscContains(parent, { center: cx(1, 1), radius: 2 }), true, 'a disc contains itself');
});

test('pearlSlotOffset is a deterministic phyllotaxis that stays strictly inside the radius', () => {
  assert.deepEqual(pearlSlotOffset(0, 1, 10), { dx: 0, dy: 0 });
  const seen = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const { dx, dy } = pearlSlotOffset(index, 50, 10);
    assert.ok(Math.hypot(dx, dy) < 10);
    seen.add(`${dx}|${dy}`);
  }
  assert.equal(seen.size, 50);
  assert.deepEqual(pearlSlotOffset(7, 50, 10), pearlSlotOffset(7, 50, 10));
});

test('a domain with too few hierarchy children uses the labelled fallback packing, never a limit set', async () => {
  const fx = await makeFixture([{ id: 'z', children: 2, leavesPerChild: 1 }], false);
  const result = await indrasPearlsProjection.project(fx.snapshot, fx.request);
  const context = await validationContext(fx, result);
  assert.doesNotThrow(() => validateProjectionResult(result, context));
  assert.equal(result.diagnostics.find(item => item.code === 'indra:geometry-mode')!.value, 'fallback-packing');
  assert.equal(result.diagnostics.find(item => item.code === 'indra:genus')!.value, 0);
  assert.match(String(result.diagnostics.find(item => item.code === 'indra:fallback-reason')!.value), /insufficient-children/);
  assert.equal(result.curves.length, 0, 'no orbit or limit-set curve without a certified group');
  assert.ok(!result.diagnostics.some(item => item.code === 'indra:schottky-min-separation'));
  assert.deepEqual(result.loadedNodeIds, fx.domain.nodeIds);
  for (const container of result.containers) {
    const explanation = result.explanations[container.visualId]!;
    assert.equal(explanation.numericalWitness!.mode, 'fallback-packing');
    assert.ok(!('genus' in explanation.numericalWitness!));
    assert.ok(explanation.limitation!.includes('not a Schottky or Kleinian limit set'));
    assert.ok(explanation.summary.includes('not a Kleinian limit set'));
    for (const id of container.memberNodeIds!) {
      const point = result.positions2![id]!;
      assert.ok(Math.hypot(point.x - container.center2!.x, point.y - container.center2!.y) < container.radius!);
    }
  }
  for (let i = 0; i < result.containers.length; i += 1) {
    for (let j = i + 1; j < result.containers.length; j += 1) {
      const a = result.containers[i]!;
      const b = result.containers[j]!;
      assert.ok(Math.hypot(a.center2!.x - b.center2!.x, a.center2!.y - b.center2!.y) > a.radius! + b.radius!);
    }
  }
  // The fallback opens too: children nest inside the opened pearl and the result still validates.
  const target = result.containers.reduce((best, container) => container.memberCount > best.memberCount ? container : best);
  const openedRequest: IndraRequest = { ...fx.request, requestedLevelId: target.levelId };
  const opened = await indrasPearlsProjection.project(fx.snapshot, openedRequest);
  const openedContext = await validationContext(fx, opened, openedRequest);
  assert.doesNotThrow(() => validateProjectionResult(opened, openedContext));
  const parent = opened.containers.find(container => container.visualId === indraContainerId(keyOfLevelId(target.levelId)))!;
  const nested = opened.containers.filter(container => container.parentVisualId === parent.visualId);
  assert.ok(nested.length >= 2);
  for (const child of nested) {
    assert.ok(Math.hypot(child.center2!.x - parent.center2!.x, child.center2!.y - parent.center2!.y) + child.radius! <= parent.radius! + 1e-9);
  }
});

const GENUS_FOUR_COMMUNITIES: readonly CommunitySpec[] = [
  { id: 'a', children: 4, leavesPerChild: 6 },
  { id: 'b', children: 4, leavesPerChild: 5 },
  { id: 'c', children: 3, leavesPerChild: 5 },
  { id: 'd', children: 3, leavesPerChild: 4 },
  { id: 'e', children: 2, leavesPerChild: 4 },
  { id: 'f', children: 2, leavesPerChild: 3 },
  { id: 'g', children: 2, leavesPerChild: 2 },
  { id: 'h', children: 1, leavesPerChild: 3 },
  { id: 'i', children: 1, leavesPerChild: 2 },
];

let genusFourPromise: Promise<Fixture> | undefined;
function genusFourFixture(): Promise<Fixture> {
  genusFourPromise ??= makeFixture(GENUS_FOUR_COMMUNITIES);
  return genusFourPromise;
}

test('lazy opening reaches depth 3 at genus 4 although the whole depth exceeds maxWords', async () => {
  const fx = await genusFourFixture();
  const request = withParameters(fx.request, { maxDepth: 3, maxWords: 200 });
  const first = await indrasPearlsProjection.project(fx.snapshot, request);
  assert.equal(first.diagnostics.find(item => item.code === 'indra:genus')!.value, 4);
  assert.equal(first.diagnostics.find(item => item.code === 'indra:word-count:depth-1')!.value, 8);
  const openStep = async (levelId: string, expectDepth: number): Promise<{ result: ProjectionResult; request: IndraRequest }> => {
    const step: IndraRequest = { ...request, requestedLevelId: levelId };
    const result = await indrasPearlsProjection.project(fx.snapshot, step);
    const context = await validationContext(fx, result, step);
    assert.doesNotThrow(() => validateProjectionResult(result, context));
    assert.deepEqual(result.loadedNodeIds, fx.domain.nodeIds);
    const levels = new Map(result.levels.map(level => [level.id, level]));
    assert.equal(levels.get(levelId)!.loaded, false, 'the opened pearl is an aggregate promise');
    const children = levels.get(levelId)!.childLevelIds.map(id => levels.get(id)!);
    assert.ok(children.length >= 2 && children.every(child => child.loaded && child.depth === expectDepth));
    const childMembers = children.flatMap(child => [...loadedMembers(child)]).sort(compareCodepointIds);
    assert.deepEqual(childMembers, [...context.witnesses.levels[levelId]!.memberNodeIds], 'children conserve the opened pearl');
    // Materialised words stay far below the cap while the theoretical depth-3 count is 392.
    const materialised = Number(result.diagnostics.find(item => item.code === 'indra:materialised-words')!.value);
    assert.ok(materialised < 200);
    for (const child of children) {
      const container = result.containers.find(item => item.visualId === indraContainerId(keyOfLevelId(child.id)))!;
      const parent = result.containers.find(item => item.visualId === container.parentVisualId)!;
      assert.ok(planeDiscContains({ center: cx(parent.center2!.x, parent.center2!.y), radius: parent.radius! }, { center: cx(container.center2!.x, container.center2!.y), radius: container.radius! }));
      for (const id of loadedMembers(child)) {
        const point = result.positions2![id]!;
        assert.ok(Math.hypot(point.x - container.center2!.x, point.y - container.center2!.y) < container.radius!);
      }
    }
    return { result, request: step };
  };
  const depthOne = first.levels.filter(level => level.depth === 1).reduce((best, level) => level.memberCount > best.memberCount ? level : best);
  const one = await openStep(depthOne.id, 2);
  const openable = one.result.levels.filter(level => level.depth === 2 && level.loaded).reduce((best, level) => level.memberCount > best.memberCount ? level : best);
  assert.ok(openable.memberCount >= 2);
  const two = await openStep(openable.id, 3);
  assert.equal(two.result.diagnostics.find(item => item.code === 'indra:word-capacity:depth-3')!.value, 392);
  assert.equal(two.result.diagnostics.find(item => item.code === 'indra:materialised-words')!.value, two.result.levels.filter(level => level.depth > 0).length);
  // The depth-2 stub of the first result opens through its own load token (a finding on a large dataset).
  const token = first.levels.find(level => level.depth === 2 && !level.loaded)!;
  if (token.loaded) assert.fail('expected a promise');
  const viaToken = await indraRequestForLevelToken(fx.snapshot, request, token.loadToken);
  await assert.doesNotReject(indrasPearlsProjection.project(fx.snapshot, viaToken));
  // maxDepth stays hard: depth-3 pearls cannot open.
  const depthThree = two.result.levels.find(level => level.depth === 3 && level.loaded)!;
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...request, requestedLevelId: depthThree.id }), /depth-cap-exceeded/);
  // Determinism: repeat and permuted snapshot arrays give the identical depth-3 digest.
  const repeat = await indrasPearlsProjection.project(fx.snapshot, two.request);
  assert.equal(repeat.determinism.resultDigest, two.result.determinism.resultDigest);
  const permuted = { ...fx.snapshot, nodes: [...fx.snapshot.nodes].reverse(), edges: [...fx.snapshot.edges].reverse() } as SemanticGraphSnapshot;
  const permutedResult = await indrasPearlsProjection.project(permuted, two.request);
  assert.equal(permutedResult.determinism.resultDigest, two.result.determinism.resultDigest);
});

test('a single opened pearl whose materialised words exceed a small maxWords is refused with a typed error', async () => {
  const fx = await genusFourFixture();
  const request = withParameters(fx.request, { maxDepth: 3, maxWords: 9 });
  const first = await indrasPearlsProjection.project(fx.snapshot, request);
  assert.equal(first.levels.filter(level => level.depth > 0).length, 8, 'the eight root pearls fit, promises are omitted and witnessed');
  assert.ok(Number(first.diagnostics.find(item => item.code === 'indra:stub-levels-omitted')!.value) > 0);
  const heavy = first.levels.filter(level => level.depth === 1).reduce((best, level) => level.memberCount > best.memberCount ? level : best);
  const error = await indrasPearlsProjection.project(fx.snapshot, { ...request, requestedLevelId: heavy.id }).catch((caught: unknown) => caught);
  assert.ok(error instanceof IndraProjectionRefusal);
  assert.equal((error as IndraProjectionRefusal).code, 'word-cap-exceeded');
  // The same pearl opens once the cap admits the materialised set.
  const roomy = withParameters(fx.request, { maxDepth: 3, maxWords: 30 });
  await assert.doesNotReject(indrasPearlsProjection.project(fx.snapshot, { ...roomy, requestedLevelId: heavy.id }));
  // maxDepth 1 refuses any opening.
  await assert.rejects(indrasPearlsProjection.project(fx.snapshot, { ...withParameters(fx.request, { maxDepth: 1 }), requestedLevelId: heavy.id }), /depth-cap-exceeded/);
});
