import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeLetter, type AssignmentMember, type InducedEdgeRecord } from '../../src/indra/assignment.ts';
import {
  ROOT_LEVEL_ID, createLazyLevelCache, levelIdForWord, levelTokenKey, loadChildLevels,
  planLevelDepth, unloadedLevelStub, type LevelLoadToken,
} from '../../src/indra/levels.ts';

function member(id: string, primaryParentId: string | null, importance: number): AssignmentMember {
  return { id, primaryParentId, importance };
}

function edge(id: string, source: string, target: string): InducedEdgeRecord {
  return { id, source, target };
}

function rootToken(levelId = ROOT_LEVEL_ID): LevelLoadToken {
  return { snapshotDigest: 'snap-abc', domainDigest: 'dom-def', parameterHash: 'par-001', levelId };
}

function rootFixture(): { members: AssignmentMember[]; edges: InducedEdgeRecord[]; childIds: string[] } {
  const members = [
    member('c1', 'p', 5),
    member('m11', 'c1', 2),
    member('c2', 'p', 4),
    member('m21', 'c2', 1),
  ];
  const edges = [edge('e1', 'm11', 'c1'), edge('e2', 'c1', 'c2')];
  return { members, edges, childIds: ['c1', 'c2'] };
}

const OPTIONS = { genus: 2, maxDepth: 2, maxWords: 100, nodeBudget: 50 };

test('level planning enforces genus, depth and the word-count cap', () => {
  assert.deepEqual(planLevelDepth(2, 1, { maxDepth: 2, maxWords: 100 }), { kind: 'planned', wordCount: 4 });
  assert.deepEqual(planLevelDepth(2, 2, { maxDepth: 2, maxWords: 100 }), { kind: 'planned', wordCount: 12 });
  const depthCap = planLevelDepth(2, 3, { maxDepth: 2, maxWords: 100 });
  assert.equal(depthCap.kind, 'refusal');
  if (depthCap.kind === 'refusal') assert.equal(depthCap.code, 'depth-cap-exceeded');
  const wordCap = planLevelDepth(4, 3, { maxDepth: 4, maxWords: 300 });
  assert.equal(wordCap.kind, 'refusal');
  if (wordCap.kind === 'refusal') {
    assert.equal(wordCap.code, 'word-cap-exceeded');
    assert.equal(wordCap.witness.wordCount, 392);
  }
  assert.deepEqual(planLevelDepth(4, 3, { maxDepth: 4, maxWords: 392 }), { kind: 'planned', wordCount: 392 });
  const zeroDepth = planLevelDepth(2, 0, { maxDepth: 2, maxWords: 100 });
  assert.equal(zeroDepth.kind, 'refusal');
  if (zeroDepth.kind === 'refusal') assert.equal(zeroDepth.code, 'invalid-depth');
  const badGenus = planLevelDepth(1, 1, { maxDepth: 2, maxWords: 100 });
  assert.equal(badGenus.kind, 'refusal');
  if (badGenus.kind === 'refusal') assert.equal(badGenus.code, 'invalid-genus');
  const badMaxDepth = planLevelDepth(2, 1, { maxDepth: 0, maxWords: 100 });
  assert.equal(badMaxDepth.kind, 'refusal');
  if (badMaxDepth.kind === 'refusal') assert.equal(badMaxDepth.code, 'invalid-depth');
});

test('the root load materialises the four depth-1 pearls as contract levels', () => {
  const { members, edges, childIds } = rootFixture();
  const cache = createLazyLevelCache();
  const outcome = loadChildLevels({ token: rootToken(), parentWord: null, members, edges, childIds, options: OPTIONS, cache });
  assert.equal(outcome.kind, 'loaded');
  if (outcome.kind !== 'loaded') return;
  assert.equal(outcome.fromCache, false);
  assert.equal(outcome.parentLevelId, ROOT_LEVEL_ID);
  assert.equal(outcome.levels.length, 4);
  const first = outcome.levels[0];
  if (first === undefined || first.loaded !== true) throw new Error('first level missing');
  assert.equal(first.id, 'indra-level-1-0+');
  assert.equal(first.parentId, ROOT_LEVEL_ID);
  assert.equal(first.depth, 1);
  assert.equal(first.maxDepth, 2);
  assert.deepEqual(first.memberNodeIds, ['c1']);
  assert.deepEqual(first.inducedEdgeIds, []);
  assert.equal(first.memberCount, 1);
  assert.deepEqual(first.childLevelIds, ['indra-level-2-0+0+', 'indra-level-2-0+1+', 'indra-level-2-0+1-']);
  assert.match(first.memberDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(outcome.crossEdges, [
    { id: 'e1', sourceWordKey: '0-', targetWordKey: '0+' },
    { id: 'e2', sourceWordKey: '0+', targetWordKey: '1+' },
  ]);
  const second = outcome.levels[1];
  if (second === undefined || second.loaded !== true) throw new Error('second level missing');
  assert.deepEqual(second.memberNodeIds, ['m11']);
});

test('a second identical load hits the cache and other parameters miss it', () => {
  const { members, edges, childIds } = rootFixture();
  const cache = createLazyLevelCache();
  const first = loadChildLevels({ token: rootToken(), parentWord: null, members, edges, childIds, options: OPTIONS, cache });
  const second = loadChildLevels({ token: rootToken(), parentWord: null, members, edges, childIds, options: OPTIONS, cache });
  assert.equal(second.kind, 'loaded');
  if (second.kind !== 'loaded') return;
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.levels, first.kind === 'loaded' ? first.levels : []);
  assert.deepEqual(second.crossEdges, first.kind === 'loaded' ? first.crossEdges : []);
  const otherParameter = loadChildLevels({
    token: { ...rootToken(), parameterHash: 'par-002' },
    parentWord: null,
    members,
    edges,
    childIds,
    options: OPTIONS,
    cache,
  });
  assert.equal(otherParameter.kind, 'loaded');
  if (otherParameter.kind === 'loaded') assert.equal(otherParameter.fromCache, false);
  assert.equal(cache.size, 2);
});

test('the token must name the level the request expands', () => {
  const { members, edges, childIds } = rootFixture();
  const mismatch = loadChildLevels({ token: rootToken('indra-level-9-nope'), parentWord: null, members, edges, childIds, options: OPTIONS });
  assert.equal(mismatch.kind, 'refusal');
  if (mismatch.kind === 'refusal') {
    assert.equal(mismatch.code, 'token-level-mismatch');
    assert.equal(mismatch.witness.parentLevelId, ROOT_LEVEL_ID);
  }
  const wordParent = loadChildLevels({
    token: rootToken(),
    parentWord: [makeLetter(0, 1)],
    members,
    edges,
    childIds,
    options: OPTIONS,
  });
  assert.equal(wordParent.kind, 'refusal');
  if (wordParent.kind === 'refusal') assert.equal(wordParent.code, 'token-level-mismatch');
});

test('node budget and cap refusals surface before any assignment work', () => {
  const { members, edges, childIds } = rootFixture();
  const budget = loadChildLevels({
    token: rootToken(),
    parentWord: null,
    members,
    edges,
    childIds,
    options: { ...OPTIONS, nodeBudget: 3 },
    cache: createLazyLevelCache(),
  });
  assert.equal(budget.kind, 'refusal');
  if (budget.kind === 'refusal') {
    assert.equal(budget.code, 'node-budget-exceeded');
    assert.equal(budget.witness.memberCount, 4);
  }
  const wordCap = loadChildLevels({
    token: { ...rootToken(), levelId: levelIdForWord([makeLetter(0, 1)]) },
    parentWord: [makeLetter(0, 1)],
    members,
    edges,
    childIds: null,
    options: { ...OPTIONS, maxWords: 10 },
  });
  assert.equal(wordCap.kind, 'refusal');
  if (wordCap.kind === 'refusal') assert.equal(wordCap.code, 'word-cap-exceeded');
  const depthCap = loadChildLevels({
    token: { ...rootToken(), levelId: levelIdForWord([makeLetter(0, 1), makeLetter(1, 1)]) },
    parentWord: [makeLetter(0, 1), makeLetter(1, 1)],
    members,
    edges,
    childIds: null,
    options: OPTIONS,
  });
  assert.equal(depthCap.kind, 'refusal');
  if (depthCap.kind === 'refusal') assert.equal(depthCap.code, 'depth-cap-exceeded');
});

test('assignment refusals pass through with their inner code as a witness', () => {
  const members = [member('c1', 'p', 1), member('x', 'ghost', 1)];
  const outcome = loadChildLevels({
    token: rootToken(),
    parentWord: null,
    members,
    edges: [],
    childIds: ['c1'],
    options: OPTIONS,
  });
  assert.equal(outcome.kind, 'refusal');
  if (outcome.kind === 'refusal') {
    assert.equal(outcome.code, 'assignment-refusal');
    assert.equal(outcome.witness.innerCode, 'unassignable-member');
  }
  const unreduced = loadChildLevels({
    token: rootToken(levelIdForWord([makeLetter(0, 1), makeLetter(0, -1)])),
    parentWord: [makeLetter(0, 1), makeLetter(0, -1)],
    members,
    edges: [],
    childIds: null,
    options: OPTIONS,
  });
  assert.equal(unreduced.kind, 'refusal');
  if (unreduced.kind === 'refusal') assert.equal(unreduced.code, 'invalid-parent-word');
});

test('aborting between pearls cancels the load and leaves the cache empty', () => {
  const { members, edges, childIds } = rootFixture();
  const controller = new AbortController();
  const cache = createLazyLevelCache();
  const progress: number[] = [];
  const cancelled = loadChildLevels({
    token: rootToken(),
    parentWord: null,
    members,
    edges,
    childIds,
    options: OPTIONS,
    cache,
    abort: controller.signal,
    onProgress: loaded => {
      progress.push(loaded);
      if (loaded === 1) controller.abort();
    },
  });
  assert.equal(cancelled.kind, 'cancelled');
  if (cancelled.kind === 'cancelled') assert.equal(cancelled.loadedSoFar, 1);
  assert.deepEqual(progress, [1]);
  assert.equal(cache.has(rootToken()), false);
  assert.equal(cache.size, 0);
  const full = loadChildLevels({ token: rootToken(), parentWord: null, members, edges, childIds, options: OPTIONS, cache });
  assert.equal(full.kind, 'loaded');
  if (full.kind === 'loaded') assert.equal(full.levels.length, 4);
  const preAborted = loadChildLevels({
    token: rootToken(),
    parentWord: null,
    members,
    edges,
    childIds,
    options: { ...OPTIONS, nodeBudget: 50 },
    cache: createLazyLevelCache(),
    abort: AbortSignal.abort(),
  });
  assert.equal(preAborted.kind, 'cancelled');
  if (preAborted.kind === 'cancelled') assert.equal(preAborted.loadedSoFar, 0);
});

test('a deeper load bins leaf members into the 2g-1 extensions and stops advertising at the cap', () => {
  const parentWord = [makeLetter(0, 1)];
  const members = [member('d1', null, 2), member('d2', 'd1', 2), member('d3', 'd1', 2)];
  const outcome = loadChildLevels({
    token: rootToken(levelIdForWord(parentWord)),
    parentWord,
    members,
    edges: [edge('f1', 'd1', 'd2')],
    childIds: null,
    options: OPTIONS,
  });
  assert.equal(outcome.kind, 'loaded');
  if (outcome.kind !== 'loaded') return;
  assert.equal(outcome.levels.length, 3);
  assert.deepEqual(outcome.levels.map(level => level.id), ['indra-level-2-0+0+', 'indra-level-2-0+1+', 'indra-level-2-0+1-']);
  for (const level of outcome.levels) {
    assert.equal(level.parentId, 'indra-level-1-0+');
    assert.equal(level.depth, 2);
    assert.deepEqual(level.childLevelIds, [], 'depth 3 exceeds maxDepth 2, so nothing is advertised');
  }
  const loadedMembers = outcome.levels.map(level => (level.loaded ? level.memberNodeIds : []));
  assert.deepEqual(loadedMembers, [['d1'], ['d2'], ['d3']]);
  assert.deepEqual(outcome.crossEdges.map(entry => entry.id), ['f1']);
});

test('the LRU cache evicts the least recently used entry', () => {
  const cache = createLazyLevelCache(1);
  const tokenA = rootToken('indra-level-1-a');
  const tokenB = rootToken('indra-level-1-b');
  cache.put(tokenA, { levels: [], pearls: [], crossEdges: [] });
  assert.equal(cache.has(tokenA), true);
  cache.put(tokenB, { levels: [], pearls: [], crossEdges: [] });
  assert.equal(cache.size, 1);
  assert.equal(cache.has(tokenA), false);
  assert.equal(cache.has(tokenB), true);
  const tokenASecond = rootToken('indra-level-1-a2');
  cache.put(tokenASecond, { levels: [], pearls: [], crossEdges: [] });
  cache.get(tokenASecond);
  cache.put(rootToken('indra-level-1-b'), { levels: [], pearls: [], crossEdges: [] });
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(levelTokenKey(rootToken()), levelTokenKey(rootToken()));
  assert.notEqual(levelTokenKey(rootToken()), levelTokenKey(rootToken('indra-level-1-a')));
});

test('unloaded stubs carry identity, count and token metadata with no coordinates', () => {
  const stub = unloadedLevelStub({
    id: 'indra-level-2-0+1+',
    parentId: 'indra-level-1-0+',
    depth: 2,
    maxDepth: 4,
    memberCount: 17,
    token: rootToken('indra-level-2-0+1+'),
  });
  assert.equal(stub.loaded, false);
  assert.equal(stub.id, 'indra-level-2-0+1+');
  assert.equal(stub.memberCount, 17);
  assert.deepEqual(stub.childLevelIds, []);
  assert.equal(Object.hasOwn(stub, 'memberNodeIds'), false);
  assert.equal(Object.hasOwn(stub, 'inducedEdgeIds'), false);
  if (stub.loaded === false) {
    assert.equal(stub.loadToken.projectionId, 'indras-pearls');
    assert.equal(stub.loadToken.parameterHash, 'par-001');
    assert.equal(stub.loadToken.levelId, 'indra-level-2-0+1+');
  }
});
