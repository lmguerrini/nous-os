import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSIGNMENT_VERSION, assignMembersToWords, enumerateReducedWords, importanceBalancedBins,
  isReducedWord, letterInverse, makeLetter, partitionByPrimaryParentChain, pearlMemberDigest,
  reducedWordCount, wordExtensions, wordKey, wordParent,
  type AssignmentMember, type InducedEdgeRecord, type ReducedWord,
} from '../../src/indra/assignment.ts';

function member(id: string, primaryParentId: string | null, importance: number): AssignmentMember {
  return { id, primaryParentId, importance };
}

function edge(id: string, source: string, target: string): InducedEdgeRecord {
  return { id, source, target };
}

function letter(generator: number, direction: 1 | -1): ReducedWord {
  return [makeLetter(generator, direction)];
}

test('reduced-word counts follow 2g(2g-1)^(d-1) and enumeration is canonical', () => {
  assert.equal(reducedWordCount(2, 1), 4);
  assert.equal(reducedWordCount(2, 2), 12);
  assert.equal(reducedWordCount(2, 3), 36);
  assert.equal(reducedWordCount(4, 3), 392);
  const depth2 = enumerateReducedWords(2, 2);
  assert.equal(depth2.length, 12);
  assert.deepEqual(depth2.slice(0, 4).map(wordKey), ['0+0+', '0+1+', '0+1-', '0-0-']);
  assert.deepEqual(depth2.map(wordKey), [...depth2.map(wordKey)].sort());
  for (const word of depth2) assert.ok(isReducedWord(word, 2));
  const unique = new Set(depth2.map(wordKey));
  assert.equal(unique.size, 12);
  assert.equal(enumerateReducedWords(2, 1).map(wordKey).join(' '), '0+ 0- 1+ 1-');
});

test('reduction, parents and extensions of words', () => {
  assert.ok(isReducedWord([makeLetter(0, 1), makeLetter(0, 1)], 2));
  assert.ok(!isReducedWord([makeLetter(0, 1), makeLetter(0, -1)], 2), 'a letter followed by its inverse is not reduced');
  assert.ok(!isReducedWord([makeLetter(0, -1), makeLetter(0, 1)], 2));
  assert.ok(!isReducedWord([makeLetter(1, 1), makeLetter(1, -1)], 2));
  assert.ok(!isReducedWord([makeLetter(3, 1)], 2), 'generator above the genus alphabet');
  assert.ok(!isReducedWord([]));
  assert.deepEqual(letterInverse(makeLetter(2, 1)), makeLetter(2, -1));
  assert.deepEqual(wordParent([makeLetter(0, 1), makeLetter(1, -1)]), letter(0, 1));
  assert.equal(wordParent(letter(1, -1)), null);
  assert.deepEqual(wordExtensions(letter(0, 1), 2).map(wordKey), ['0+0+', '0+1+', '0+1-']);
  assert.equal(wordExtensions(letter(0, 1), 2).length, 3);
  assert.equal(wordExtensions([], 4).length, 8);
});

test('the primary-parent chain partitions members disjointly with a known answer', () => {
  const members = [
    member('c1', 'p', 5),
    member('c2', 'p', 5),
    member('a1', 'c1', 3),
    member('a2', 'a1', 1),
    member('b1', 'c2', 2),
    member('b2', 'c2', 1),
  ];
  const outcome = partitionByPrimaryParentChain(members, ['c1', 'c2']);
  assert.equal(outcome.kind, 'partition');
  if (outcome.kind !== 'partition') return;
  assert.deepEqual(outcome.partitions.get('c1'), ['a1', 'a2', 'c1']);
  assert.deepEqual(outcome.partitions.get('c2'), ['b1', 'b2', 'c2']);
});

test('the chain refuses ghosts, cycles, duplicates and nonfinite importance', () => {
  const base = [member('c1', 'p', 1), member('x', 'ghost', 1)];
  const ghost = partitionByPrimaryParentChain(base, ['c1']);
  assert.equal(ghost.kind, 'refusal');
  if (ghost.kind === 'refusal') {
    assert.equal(ghost.code, 'unassignable-member');
    assert.equal(ghost.witness.missingAncestor, 'ghost');
  }
  const cycle = partitionByPrimaryParentChain(
    [member('y', 'z', 1), member('z', 'y', 1), member('w', null, 1)],
    ['w'],
  );
  assert.equal(cycle.kind, 'refusal');
  if (cycle.kind === 'refusal') assert.equal(cycle.code, 'parent-cycle');
  const rootChain = partitionByPrimaryParentChain([member('r', null, 1), member('s', 'r', 1)], ['s']);
  assert.equal(rootChain.kind, 'refusal');
  if (rootChain.kind === 'refusal') {
    assert.equal(rootChain.code, 'unassignable-member');
    assert.equal(rootChain.witness.lastAncestor, 'r');
  }
  const duplicate = partitionByPrimaryParentChain([member('c1', 'p', 1), member('c1', 'p', 1)], ['c1']);
  assert.equal(duplicate.kind, 'refusal');
  if (duplicate.kind === 'refusal') assert.equal(duplicate.code, 'duplicate-member-id');
  const badImportance = partitionByPrimaryParentChain([member('c1', 'p', Number.NaN)], ['c1']);
  assert.equal(badImportance.kind, 'refusal');
  if (badImportance.kind === 'refusal') assert.equal(badImportance.code, 'invalid-importance');
  const unknownChild = partitionByPrimaryParentChain([member('c1', 'p', 1)], ['c9']);
  assert.equal(unknownChild.kind, 'refusal');
  if (unknownChild.kind === 'refusal') assert.equal(unknownChild.code, 'unknown-child');
  const noChildren = partitionByPrimaryParentChain([member('c1', 'p', 1)], []);
  assert.equal(noChildren.kind, 'refusal');
  if (noChildren.kind === 'refusal') assert.equal(noChildren.code, 'unassignable-member');
});

test('importance-balanced bins have a known answer and lowest-index ties', () => {
  const importance = new Map([['a', 10], ['b', 1], ['c', 1], ['d', 1]]);
  const bins = importanceBalancedBins(['a', 'b', 'c', 'd'], id => importance.get(id) ?? 0, 2);
  assert.deepEqual(bins.map(bin => [...bin]), [['a'], ['b', 'c', 'd']]);
  const ties = importanceBalancedBins(['a', 'b'], () => 1, 2);
  assert.deepEqual(ties.map(bin => [...bin]), [['a'], ['b']]);
});

test('five children over four letters: whole partitions, binned extras, exact induced edges', () => {
  const members = [
    member('c1', 'p', 5),
    member('m11', 'c1', 2),
    member('c2', 'p', 4),
    member('c3', 'p', 3),
    member('m31', 'c3', 1),
    member('c4', 'p', 2),
    member('c5', 'p', 6),
    member('m51', 'c5', 1),
    member('m52', 'c5', 1),
  ];
  const edges = [
    edge('e1', 'm11', 'c1'),
    edge('e2', 'c1', 'c2'),
    edge('e3', 'm51', 'm52'),
    edge('e4', 'c3', 'm31'),
    edge('e5', 'c4', 'c5'),
    edge('e6', 'c2', 'c5'),
  ];
  const outcome = assignMembersToWords({ parentWord: null, genus: 2, members, edges, childIds: ['c1', 'c2', 'c3', 'c4', 'c5'] });
  assert.equal(outcome.kind, 'assignment');
  if (outcome.kind !== 'assignment') return;
  const { assignment } = outcome;
  assert.equal(assignment.version, ASSIGNMENT_VERSION);
  assert.equal(assignment.genus, 2);
  assert.equal(assignment.parentWordKey, null);
  assert.equal(assignment.depth, 1);
  assert.equal(assignment.memberCount, 9);
  assert.deepEqual(assignment.pearls.map(pearl => pearl.wordKeyValue), ['0+', '0-', '1+', '1-']);
  assert.deepEqual(assignment.pearls[0]?.memberNodeIds, ['c1', 'm11']);
  assert.deepEqual(assignment.pearls[1]?.memberNodeIds, ['c2', 'm51']);
  assert.deepEqual(assignment.pearls[2]?.memberNodeIds, ['c3', 'm31', 'm52']);
  assert.deepEqual(assignment.pearls[3]?.memberNodeIds, ['c4', 'c5']);
  assert.deepEqual(assignment.pearls.map(pearl => pearl.mapping), ['hierarchy-plus-bin', 'hierarchy-plus-bin', 'hierarchy-plus-bin', 'hierarchy-plus-bin']);
  assert.deepEqual(assignment.pearls[0]?.hierarchyChildIds, ['c1']);
  assert.deepEqual(assignment.pearls[1]?.hierarchyChildIds, ['c2', 'c5']);
  assert.deepEqual(assignment.pearls[2]?.hierarchyChildIds, ['c3', 'c5']);
  assert.deepEqual(assignment.pearls[3]?.hierarchyChildIds, ['c4', 'c5']);
  assert.deepEqual(assignment.pearls[0]?.binnedFromChildIds, []);
  assert.deepEqual(assignment.pearls[1]?.binnedFromChildIds, ['c5']);
  assert.deepEqual(assignment.pearls[3]?.binnedFromChildIds, ['c5']);
  assert.deepEqual(assignment.pearls[0]?.inducedEdgeIds, ['e1']);
  assert.deepEqual(assignment.pearls[1]?.inducedEdgeIds, []);
  assert.deepEqual(assignment.pearls[2]?.inducedEdgeIds, ['e4']);
  assert.deepEqual(assignment.pearls[3]?.inducedEdgeIds, ['e5']);
  assert.deepEqual(assignment.crossEdges, [
    { id: 'e2', sourceWordKey: '0+', targetWordKey: '0-' },
    { id: 'e3', sourceWordKey: '0-', targetWordKey: '1+' },
    { id: 'e6', sourceWordKey: '0-', targetWordKey: '1-' },
  ]);
});

test('hierarchy shallower than the word tree bins each child partition across the letters', () => {
  const members = [
    member('c1', 'p', 4),
    member('a1', 'c1', 4),
    member('c2', 'p', 1),
    member('b1', 'c2', 1),
  ];
  const edges = [
    edge('e1', 'a1', 'c1'),
    edge('e2', 'a1', 'b1'),
    edge('e3', 'b1', 'c2'),
    edge('e4', 'c1', 'c1'),
  ];
  const outcome = assignMembersToWords({ parentWord: null, genus: 2, members, edges, childIds: ['c1', 'c2'] });
  assert.equal(outcome.kind, 'assignment');
  if (outcome.kind !== 'assignment') return;
  const { pearls } = outcome.assignment;
  assert.deepEqual(pearls.map(pearl => pearl.memberNodeIds), [['a1'], ['c1'], ['b1'], ['c2']]);
  assert.deepEqual(pearls.map(pearl => pearl.mapping), ['hierarchy-plus-bin', 'hierarchy-plus-bin', 'hierarchy-plus-bin', 'hierarchy-plus-bin']);
  assert.deepEqual(pearls.map(pearl => pearl.hierarchyChildIds), [['c1'], ['c1'], ['c2'], ['c2']]);
  assert.deepEqual(pearls.map(pearl => pearl.inducedEdgeIds), [[], ['e4'], [], []]);
  assert.deepEqual(outcome.assignment.crossEdges.map(entry => entry.id), ['e1', 'e2', 'e3']);
  assert.equal(outcome.assignment.memberCount, 4);
});

test('a leaf pearl bins its whole member set and keeps self-loops induced', () => {
  const members = [member('m1', null, 3), member('m2', 'x', 1), member('m3', 'y', 1), member('m4', 'z', 1)];
  const edges = [edge('s1', 'm1', 'm1'), edge('x1', 'm1', 'm2')];
  const outcome = assignMembersToWords({ parentWord: null, genus: 2, members, edges, childIds: null });
  assert.equal(outcome.kind, 'assignment');
  if (outcome.kind !== 'assignment') return;
  const { pearls, crossEdges } = outcome.assignment;
  assert.deepEqual(pearls.map(pearl => pearl.memberNodeIds), [['m1'], ['m2'], ['m3'], ['m4']]);
  assert.deepEqual(pearls.map(pearl => pearl.mapping), ['balanced-bin', 'balanced-bin', 'balanced-bin', 'balanced-bin']);
  assert.deepEqual(pearls.map(pearl => pearl.hierarchyChildIds), [[], [], [], []]);
  assert.deepEqual(pearls[0]?.inducedEdgeIds, ['s1']);
  assert.deepEqual(crossEdges.map(entry => entry.id), ['x1']);
});

test('deeper refinement under a parent word uses the 2g-1 extensions', () => {
  const parentWord = letter(0, 1);
  const members = [
    member('d1', null, 2),
    member('d2', 'd1', 2),
    member('d3', 'd1', 2),
  ];
  const outcome = assignMembersToWords({ parentWord, genus: 2, members, edges: [edge('f1', 'd1', 'd2'), edge('f2', 'd2', 'd3')], childIds: null });
  assert.equal(outcome.kind, 'assignment');
  if (outcome.kind !== 'assignment') return;
  const { pearls, parentWordKey, depth } = outcome.assignment;
  assert.equal(parentWordKey, '0+');
  assert.equal(depth, 2);
  assert.deepEqual(pearls.map(pearl => pearl.wordKeyValue), ['0+0+', '0+1+', '0+1-']);
  assert.deepEqual(pearls.map(pearl => pearl.memberNodeIds), [['d1'], ['d2'], ['d3']]);
  assert.deepEqual(pearls.flatMap(pearl => pearl.inducedEdgeIds), []);
  assert.deepEqual(outcome.assignment.crossEdges.map(entry => entry.id), ['f1', 'f2']);
});

test('assignment refuses invalid genus, edges outside the member set and bad words', () => {
  const members = [member('a', null, 1)];
  const genus = assignMembersToWords({ parentWord: null, genus: 1, members, edges: [], childIds: null });
  assert.equal(genus.kind, 'refusal');
  if (genus.kind === 'refusal') assert.equal(genus.code, 'invalid-genus');
  const outside = assignMembersToWords({ parentWord: null, genus: 2, members, edges: [edge('e', 'a', 'ghost')], childIds: null });
  assert.equal(outside.kind, 'refusal');
  if (outside.kind === 'refusal') assert.equal(outside.code, 'edge-outside-members');
  const unreduced = assignMembersToWords({
    parentWord: [makeLetter(0, 1), makeLetter(0, -1)],
    genus: 2,
    members,
    edges: [],
    childIds: null,
  });
  assert.equal(unreduced.kind, 'refusal');
  if (unreduced.kind === 'refusal') assert.equal(unreduced.code, 'invalid-genus');
});

function largerFixture(): { members: AssignmentMember[]; edges: InducedEdgeRecord[]; childIds: string[] } {
  const members: AssignmentMember[] = [
    member('cA', 'root', 10),
    member('cB', 'root', 6),
  ];
  const edges: InducedEdgeRecord[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `a${index}`;
    const parentId = index === 0 ? 'cA' : `a${index - 1}`;
    members.push(member(id, parentId, 8 - index));
    edges.push(edge(`ea${index}`, id, parentId));
  }
  for (let index = 0; index < 8; index += 1) {
    const id = `b${index}`;
    const parentId = index === 0 ? 'cB' : `b${index - 1}`;
    members.push(member(id, parentId, 7 - index));
    edges.push(edge(`eb${index}`, id, parentId));
  }
  edges.push(edge('xa0b0', 'a0', 'b0'), edge('xa7b7', 'a7', 'b7'), edge('xcAcB', 'cA', 'cB'), edge('xa0a2', 'a0', 'a2'));
  return { members, edges, childIds: ['cA', 'cB'] };
}

test('induced-edge equality, disjointness and conservation hold on a larger fixture', () => {
  const { members, edges, childIds } = largerFixture();
  const outcome = assignMembersToWords({ parentWord: null, genus: 3, members, edges, childIds });
  assert.equal(outcome.kind, 'assignment');
  if (outcome.kind !== 'assignment') return;
  const { pearls, crossEdges } = outcome.assignment;
  const memberSet = new Set(members.map(entry => entry.id));
  const assigned: string[] = [];
  for (const pearl of pearls) {
    for (const id of pearl.memberNodeIds) {
      assert.ok(memberSet.has(id), `${id} is not a member`);
      assert.ok(!assigned.includes(id), `${id} is duplicated across pearls`);
      assigned.push(id);
    }
  }
  assert.deepEqual([...assigned].sort(), [...memberSet].sort());
  const pearlOf = new Map<string, string>();
  for (const pearl of pearls) {
    const set = new Set(pearl.memberNodeIds);
    const expected = edges
      .filter(item => set.has(item.source) && set.has(item.target))
      .map(item => item.id)
      .sort();
    assert.deepEqual(pearl.inducedEdgeIds, expected, `induced edges of ${pearl.wordKeyValue}`);
    for (const id of pearl.memberNodeIds) pearlOf.set(id, pearl.wordKeyValue);
  }
  const allListed = [...pearls.flatMap(pearl => pearl.inducedEdgeIds), ...crossEdges.map(entry => entry.id)].sort();
  const allEdgeIds = edges.map(item => item.id).sort();
  assert.deepEqual(allListed, allEdgeIds);
  assert.equal(new Set(allListed).size, allListed.length, 'no edge is listed twice');
  for (const entry of crossEdges) {
    const sourceEdge = edges.find(item => item.id === entry.id);
    assert.ok(sourceEdge !== undefined);
    assert.notEqual(pearlOf.get(sourceEdge.source), pearlOf.get(sourceEdge.target));
    assert.equal(pearlOf.get(sourceEdge.source), entry.sourceWordKey);
    assert.equal(pearlOf.get(sourceEdge.target), entry.targetWordKey);
  }
});

test('assignments are deterministic under double runs and input permutations', () => {
  const { members, edges, childIds } = largerFixture();
  const first = assignMembersToWords({ parentWord: null, genus: 3, members, edges, childIds });
  const second = assignMembersToWords({ parentWord: null, genus: 3, members, edges, childIds });
  assert.deepEqual(first, second);
  const permuted = assignMembersToWords({
    parentWord: null,
    genus: 3,
    members: [...members].reverse(),
    edges: [...edges].reverse(),
    childIds,
  });
  assert.deepEqual(permuted, first);
});

test('pearl member digests are deterministic and member-sensitive', () => {
  const word = letter(1, -1);
  const digest = pearlMemberDigest(word, ['b', 'a']);
  assert.equal(digest, pearlMemberDigest(word, ['a', 'b']));
  assert.notEqual(digest, pearlMemberDigest(word, ['a', 'b', 'c']));
  assert.notEqual(digest, pearlMemberDigest(letter(1, 1), ['a', 'b']));
  assert.match(digest, /^[0-9a-f]{64}$/);
});
