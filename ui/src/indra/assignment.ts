/** Disjoint hierarchy-to-word assignment for Indra's Pearls (D-073 row D4).
 *
 * Semantic assignment: the primary-parent hierarchy
 * defines a disjoint partition — every real node belongs to exactly one child pearl via its
 * declared primary-parent chain; multi-domain memberships are links, never duplicate nodes.
 * The pearls at a depth are the reduced words w = s_1…s_d with s_(j+1) != s_j^{-1}; there are
 * exactly 2g(2g-1)^(d-1) of them at depth d. Where the hierarchy is shallower than the word
 * tree, the stable-ID-ranked child partitions are distributed onto the word prefixes with
 * importance-balanced bins. A pearl's memberNodeIds is the exact source-derived set, its real
 * induced subgraph is E[S] = {e in E : source(e), target(e) in S}, and cross-pearl edges stay
 * in the parent-level cross-edge ledger — an edge never becomes an edge inside both pearls.
 * The word maps the container, not the data identity. Deterministic: inputs are canonicalised
 * to codepoint order, so member/edge permutations give byte-identical assignments. */
import { digestPayload } from '../engine/digest.ts';
import type { Digest, EdgeId, NodeId } from '../projection/contract-types.ts';

export const ASSIGNMENT_VERSION = 'indra-assignment-v1';

/** One letter of a reduced word: generator index 0..g-1 and direction (+1 forward, -1 inverse). */
export interface WordLetter {
  readonly generator: number;
  readonly direction: 1 | -1;
}

/** A reduced word over the 2g letters; empty words are not produced by this module. */
export type ReducedWord = readonly WordLetter[];

export function makeLetter(generator: number, direction: 1 | -1): WordLetter {
  return { generator, direction };
}

export function letterInverse(letter: WordLetter): WordLetter {
  return { generator: letter.generator, direction: letter.direction === 1 ? -1 : 1 };
}

function sameLetter(left: WordLetter, right: WordLetter): boolean {
  return left.generator === right.generator && left.direction === right.direction;
}

/** Canonical letter alphabet order: (generator, direction) with +1 before -1. */
export function letterOrdinal(letter: WordLetter, genus: number): number {
  if (!Number.isInteger(letter.generator) || letter.generator < 0 || letter.generator >= genus) {
    throw new RangeError(`letter generator ${letter.generator} is outside the genus-${genus} alphabet`);
  }
  return 2 * letter.generator + (letter.direction === -1 ? 1 : 0);
}

/** A word is reduced when no letter is the inverse of its predecessor (free-group reduction). */
export function isReducedWord(word: readonly WordLetter[], genus?: number): boolean {
  if (word.length === 0) return false;
  for (let index = 0; index < word.length; index += 1) {
    const letter = word[index] as WordLetter;
    if (genus !== undefined && (letter.generator < 0 || letter.generator >= genus)) return false;
    if (index > 0) {
      const previous = word[index - 1] as WordLetter;
      if (sameLetter(letterInverse(previous), letter)) return false;
    }
  }
  return true;
}

export function wordDepth(word: ReducedWord): number {
  return word.length;
}

export function wordParent(word: ReducedWord): ReducedWord | null {
  return word.length <= 1 ? null : word.slice(0, -1);
}

/** Deterministic key, for example the depth-2 word "0+1-": letters joined in order. */
export function wordKey(word: ReducedWord): string {
  return word.map(letter => `${letter.generator}${letter.direction === 1 ? '+' : '-'}`).join('');
}

/** Exact count of reduced words of the given depth: 2g(2g-1)^(d-1). */
export function reducedWordCount(genus: number, depth: number): number {
  if (!Number.isInteger(genus) || genus < 1) throw new RangeError(`genus must be a positive integer, received ${genus}`);
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError(`depth must be a positive integer, received ${depth}`);
  return 2 * genus * Math.pow(2 * genus - 1, depth - 1);
}

function letterAlphabet(genus: number): WordLetter[] {
  const letters: WordLetter[] = [];
  for (let generator = 0; generator < genus; generator += 1) {
    letters.push({ generator, direction: 1 });
    letters.push({ generator, direction: -1 });
  }
  return letters;
}

/** All reduced words of exactly the given depth, in canonical lexicographic letter order. */
export function enumerateReducedWords(genus: number, depth: number): ReducedWord[] {
  if (!Number.isInteger(genus) || genus < 1) throw new RangeError(`genus must be a positive integer, received ${genus}`);
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError(`depth must be a positive integer, received ${depth}`);
  const alphabet = letterAlphabet(genus);
  let words: ReducedWord[] = alphabet.map(letter => [letter]);
  for (let level = 2; level <= depth; level += 1) {
    const extended: ReducedWord[] = [];
    for (const word of words) {
      const last = word[word.length - 1] as WordLetter;
      for (const letter of alphabet) {
        if (sameLetter(letterInverse(last), letter)) continue;
        extended.push([...word, letter]);
      }
    }
    words = extended;
  }
  return words;
}

/** The reduced extensions of a word (every letter except the inverse of its last letter). */
export function wordExtensions(word: ReducedWord, genus: number): ReducedWord[] {
  const alphabet = letterAlphabet(genus);
  if (word.length === 0) return alphabet.map(letter => [letter]);
  const last = word[word.length - 1] as WordLetter;
  const extensions: ReducedWord[] = [];
  for (const letter of alphabet) {
    if (sameLetter(letterInverse(last), letter)) continue;
    extensions.push([...word, letter]);
  }
  return extensions;
}

/** Codepoint-order comparison for stable IDs; equal-tie ordering uses this everywhere. */
export function compareCodepointIds(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** A member of the parent pearl: its declared primary parent drives the partition. */
export interface AssignmentMember {
  readonly id: NodeId;
  readonly primaryParentId: NodeId | null;
  readonly importance: number;
}

/** A source edge over the parent member set; never a visual or synthetic relation. */
export interface InducedEdgeRecord {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
}

export type PartitionRefusalCode =
  | 'duplicate-member-id'
  | 'invalid-importance'
  | 'duplicate-child-id'
  | 'unknown-child'
  | 'unassignable-member'
  | 'parent-cycle';

export type PartitionOutcome =
  | Readonly<{ kind: 'partition'; partitions: ReadonlyMap<string, readonly NodeId[]> }>
  | Readonly<{ kind: 'refusal'; code: PartitionRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>;

interface RefusalShape<C extends string> {
  readonly kind: 'refusal';
  readonly code: C;
  readonly message: string;
  readonly witness: Readonly<Record<string, number | string>>;
}

/**
 * Disjoint primary-parent partition: each member belongs to exactly one child, namely the
 * first child-community id reached by walking the declared primary-parent chain upwards.
 * A member that is itself a child is assigned to itself. A chain that escapes the member set
 * or cycles is a typed refusal — membership is never guessed.
 */
export function partitionByPrimaryParentChain(
  members: readonly AssignmentMember[],
  childIds: readonly string[],
): PartitionOutcome {
  const memberById = validateMembers(members);
  if (memberById instanceof RefusalError) return memberById.outcome;
  const children = new Set<string>();
  for (const childId of childIds) {
    if (children.has(childId)) {
      return refusal('duplicate-child-id', `child ${childId} appears more than once`, { childCount: childIds.length });
    }
    children.add(childId);
    if (!memberById.has(childId)) {
      return refusal('unknown-child', `child ${childId} is not a member of the parent pearl`, { child: childId });
    }
  }
  if (children.size === 0) {
    return refusal('unassignable-member', 'no hierarchy children were supplied, so no primary-parent partition exists', { childCount: 0 });
  }
  const partitions = new Map<string, NodeId[]>([...children].map(childId => [childId, [] as NodeId[]]));
  for (const member of members) {
    const assignment = assignToChild(member, memberById, children);
    if (assignment instanceof RefusalError) return assignment.outcome;
    (partitions.get(assignment) as NodeId[]).push(member.id);
  }
  for (const [childId, ids] of partitions) partitions.set(childId, [...ids].sort(compareCodepointIds));
  return { kind: 'partition', partitions };
}

function assignToChild(member: AssignmentMember, memberById: ReadonlyMap<string, AssignmentMember>, children: ReadonlySet<string>): string | RefusalError<PartitionRefusalCode> {
  const visited = new Set<NodeId>([member.id]);
  let current: AssignmentMember = member;
  for (;;) {
    if (children.has(current.id)) return current.id;
    const parentId = current.primaryParentId;
    if (parentId === null) {
      return new RefusalError(refusal('unassignable-member',
        `the primary-parent chain of ${member.id} reaches the root without meeting a hierarchy child (last node ${current.id})`,
        { member: member.id, lastAncestor: current.id }));
    }
    if (visited.has(parentId)) {
      return new RefusalError(refusal('parent-cycle', `the primary-parent chain of ${member.id} revisits ${parentId}`, { member: member.id, revisited: parentId }));
    }
    visited.add(parentId);
    const parent = memberById.get(parentId);
    if (parent === undefined) {
      return new RefusalError(refusal('unassignable-member',
        `the primary-parent chain of ${member.id} leaves the member set at ${parentId}`,
        { member: member.id, missingAncestor: parentId }));
    }
    current = parent;
  }
}

/** Greedy importance-balanced bins: each unit (kept intact) goes to the bin with the least
 * cumulative importance, ties to the lowest bin index. Deterministic for a fixed unit order. */
export function importanceBalancedBins<T>(
  units: readonly T[],
  importanceOf: (unit: T) => number,
  binCount: number,
): readonly (readonly T[])[] {
  if (!Number.isInteger(binCount) || binCount < 1) throw new RangeError(`binCount must be a positive integer, received ${binCount}`);
  const bins: T[][] = Array.from({ length: binCount }, () => [] as T[]);
  const sums = new Array<number>(binCount).fill(0);
  for (const unit of units) {
    const importance = importanceOf(unit);
    if (!Number.isFinite(importance)) throw new RangeError(`unit importance must be finite, received ${importance}`);
    let target = 0;
    for (let index = 1; index < binCount; index += 1) {
      if ((sums[index] as number) < (sums[target] as number)) target = index;
    }
    (bins[target] as T[]).push(unit);
    sums[target] = (sums[target] as number) + importance;
  }
  return bins;
}

export type PearlMapping = 'hierarchy' | 'balanced-bin' | 'hierarchy-plus-bin';

export interface PearlAssignment {
  readonly word: ReducedWord;
  readonly depth: number;
  readonly wordKeyValue: string;
  readonly memberNodeIds: readonly NodeId[];
  readonly memberDigest: Digest;
  readonly mapping: PearlMapping;
  /** Real hierarchy children whose members this pearl contains. */
  readonly hierarchyChildIds: readonly string[];
  /** Children (beyond the word alphabet) whose members were distributed by balanced bins. */
  readonly binnedFromChildIds: readonly string[];
  /** E[S]: exactly the source edges with both endpoints in this pearl. */
  readonly inducedEdgeIds: readonly EdgeId[];
}

export interface CrossEdgeLedgerEntry {
  readonly id: EdgeId;
  readonly sourceWordKey: string;
  readonly targetWordKey: string;
}

export interface WordAssignment {
  readonly version: typeof ASSIGNMENT_VERSION;
  readonly genus: number;
  readonly parentWordKey: string | null;
  readonly depth: number;
  readonly pearls: readonly PearlAssignment[];
  readonly crossEdges: readonly CrossEdgeLedgerEntry[];
  readonly memberCount: number;
}

export type WordAssignmentRefusalCode = PartitionRefusalCode | 'invalid-genus' | 'edge-outside-members';

export type WordAssignmentOutcome =
  | Readonly<{ kind: 'assignment'; assignment: WordAssignment }>
  | Readonly<{ kind: 'refusal'; code: WordAssignmentRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>;

export interface WordAssignmentInput {
  /** Pearl being refined; null refines the root into the 2g depth-1 letters. */
  readonly parentWord: ReducedWord | null;
  readonly genus: number;
  readonly members: readonly AssignmentMember[];
  /** Edges induced over the member set; each must have both endpoints among the members. */
  readonly edges: readonly InducedEdgeRecord[];
  /** Ordered real hierarchy children present in this pearl (caller's D3 weight/codepoint order),
   * or null/[] when the hierarchy is no deeper than this pearl. */
  readonly childIds: readonly string[] | null;
}

class RefusalError<C extends string> extends Error {
  readonly outcome: RefusalShape<C>;
  constructor(outcome: RefusalShape<C>) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

function refusal<C extends string>(code: C, message: string, witness: Readonly<Record<string, number | string>> = {}): RefusalShape<C> {
  return { kind: 'refusal', code, message, witness };
}

function validateMembers(members: readonly AssignmentMember[]): ReadonlyMap<string, AssignmentMember> | RefusalError<PartitionRefusalCode> {
  const memberById = new Map<string, AssignmentMember>();
  for (const member of members) {
    if (memberById.has(member.id)) {
      return new RefusalError(refusal('duplicate-member-id', `member ${member.id} appears more than once`, { member: member.id }));
    }
    if (!Number.isFinite(member.importance)) {
      return new RefusalError(refusal('invalid-importance', `member ${member.id} has importance ${member.importance}`, { member: member.id }));
    }
    memberById.set(member.id, member);
  }
  return memberById;
}

/**
 * Assigns every member of a parent pearl to exactly one reduced-word prefix.
 *
 * With k real children and W word prefixes at the next depth:
 * - k >= W: children map to prefixes in the given order; each extra child's members are then
 *   distributed by importance-balanced bins over the prefixes.
 * - k < W (the hierarchy is shallower than the word tree): every child partition is distributed
 *   over all W prefixes by the same balanced-bin rule, with the prefix importance sums carried
 *   across partitions so the whole parent stays balanced; a pearl with no children at all bins
 *   its whole member set. The word maps the container, never the data identity.
 */
export function assignMembersToWords(input: WordAssignmentInput): WordAssignmentOutcome {
  const { genus, parentWord } = input;
  if (!Number.isInteger(genus) || genus < 2) {
    return refusal('invalid-genus', `a certified Schottky group needs genus >= 2, received ${genus}`, { genus });
  }
  if (parentWord !== null && !isReducedWord(parentWord, genus)) {
    return refusal('invalid-genus', `the parent word ${wordKey(parentWord)} is not a reduced word of genus ${genus}`, { genus });
  }
  const members = [...input.members].sort((left, right) => compareCodepointIds(left.id, right.id));
  const memberById = validateMembers(members);
  if (memberById instanceof RefusalError) return memberById.outcome;
  const edges = [...input.edges].sort((left, right) => compareCodepointIds(left.id, right.id));
  const prefixes = wordExtensions(parentWord ?? [], genus);
  const prefixKeys = prefixes.map(word => wordKey(word));
  const depth = (parentWord?.length ?? 0) + 1;

  const perPrefixMembers: NodeId[][] = prefixes.map(() => [] as NodeId[]);
  const perPrefixChildren: string[][] = prefixes.map(() => [] as string[]);
  const perPrefixBinnedFrom: string[][] = prefixes.map(() => [] as string[]);
  const prefixSums: number[] = new Array<number>(prefixes.length).fill(0);
  /** Greedy lightest-prefix placement; the sums carry across calls so bins stay balanced. */
  const placeMembers = (orderedMembers: readonly AssignmentMember[]): void => {
    for (const entry of orderedMembers) {
      let target = 0;
      for (let index = 1; index < prefixSums.length; index += 1) {
        if ((prefixSums[index] as number) < (prefixSums[target] as number)) target = index;
      }
      (perPrefixMembers[target] as NodeId[]).push(entry.id);
      prefixSums[target] = (prefixSums[target] as number) + entry.importance;
    }
  };
  const partitionMembers = (partition: ReadonlyMap<string, readonly NodeId[]>, childId: string): readonly AssignmentMember[] =>
    [...(partition.get(childId) as readonly NodeId[])]
      .map(id => memberById.get(id) as AssignmentMember)
      .sort((left, right) => compareCodepointIds(left.id, right.id));
  let mapping: PearlMapping = 'balanced-bin';
  const orderedChildIds = input.childIds ?? [];
  if (orderedChildIds.length >= prefixes.length) {
    mapping = orderedChildIds.length > prefixes.length ? 'hierarchy-plus-bin' : 'hierarchy';
    const partition = partitionByPrimaryParentChain(members, orderedChildIds);
    if (partition.kind === 'refusal') return partition;
    for (let index = 0; index < prefixes.length; index += 1) {
      const childId = orderedChildIds[index] as string;
      // A slotted child keeps its members together on its own letter: the word tree pairing
      // follows the D3 slot order, so only extras are balanced below.
      for (const entry of partitionMembers(partition.partitions, childId)) {
        (perPrefixMembers[index] as NodeId[]).push(entry.id);
        prefixSums[index] = (prefixSums[index] as number) + entry.importance;
      }
      (perPrefixChildren[index] as string[]).push(childId);
    }
    // Extra children (beyond the word alphabet) stay in their own partition; their members are
    // distributed over all prefixes by the balanced rule, recorded as binned provenance.
    for (const childId of orderedChildIds.slice(prefixes.length)) {
      const before = perPrefixMembers.map(ids => ids.length);
      placeMembers(partitionMembers(partition.partitions, childId));
      perPrefixMembers.forEach((ids, index) => {
        if (ids.length > (before[index] as number)) {
          (perPrefixChildren[index] as string[]).push(childId);
          (perPrefixBinnedFrom[index] as string[]).push(childId);
        }
      });
    }
  } else if (orderedChildIds.length > 0) {
    // Hierarchy shallower than the word tree: each child partition fills the lightest prefixes,
    // with the sums carried across partitions so the parent stays balanced overall.
    mapping = 'hierarchy-plus-bin';
    const partition = partitionByPrimaryParentChain(members, orderedChildIds);
    if (partition.kind === 'refusal') return partition;
    for (const childId of orderedChildIds) {
      const before = perPrefixMembers.map(ids => ids.length);
      placeMembers(partitionMembers(partition.partitions, childId));
      perPrefixMembers.forEach((ids, index) => {
        if (ids.length > (before[index] as number)) (perPrefixChildren[index] as string[]).push(childId);
      });
    }
  } else {
    // Leaf pearl: the whole member set fills the prefixes by the balanced rule.
    mapping = 'balanced-bin';
    placeMembers(members);
  }

  const prefixIndexOf = new Map<NodeId, number>();
  for (let index = 0; index < prefixes.length; index += 1) {
    for (const id of perPrefixMembers[index] as readonly NodeId[]) {
      if (prefixIndexOf.has(id)) {
        return refusal('duplicate-member-id', `member ${id} was assigned to more than one prefix`, { member: id });
      }
      prefixIndexOf.set(id, index);
    }
  }
  if (prefixIndexOf.size !== members.length) {
    return refusal('unassignable-member', `only ${prefixIndexOf.size} of ${members.length} members reached a word prefix`, {
      assigned: prefixIndexOf.size,
      members: members.length,
    });
  }

  const induced: EdgeId[][] = prefixes.map(() => [] as EdgeId[]);
  const crossEdges: CrossEdgeLedgerEntry[] = [];
  for (const edge of edges) {
    const sourceIndex = prefixIndexOf.get(edge.source);
    const targetIndex = prefixIndexOf.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) {
      return refusal('edge-outside-members', `edge ${edge.id} has an endpoint outside the member set`, {
        edge: edge.id,
        source: edge.source,
        target: edge.target,
      });
    }
    if (sourceIndex === targetIndex) {
      (induced[sourceIndex] as EdgeId[]).push(edge.id);
    } else {
      crossEdges.push({
        id: edge.id,
        sourceWordKey: prefixKeys[sourceIndex] as string,
        targetWordKey: prefixKeys[targetIndex] as string,
      });
    }
  }

  const pearls: PearlAssignment[] = prefixes.map((word, index) => {
    const memberNodeIds = [...(perPrefixMembers[index] as NodeId[])].sort(compareCodepointIds);
    return {
      word,
      depth,
      wordKeyValue: prefixKeys[index] as string,
      memberNodeIds,
      memberDigest: pearlMemberDigest(word, memberNodeIds),
      mapping,
      hierarchyChildIds: [...(perPrefixChildren[index] as string[])].sort(compareCodepointIds),
      binnedFromChildIds: [...(perPrefixBinnedFrom[index] as string[])].sort(compareCodepointIds),
      inducedEdgeIds: [...(induced[index] as EdgeId[])].sort(compareCodepointIds),
    };
  });
  return {
    kind: 'assignment',
    assignment: {
      version: ASSIGNMENT_VERSION,
      genus,
      parentWordKey: parentWord === null ? null : wordKey(parentWord),
      depth,
      pearls,
      crossEdges: [...crossEdges].sort((left, right) => compareCodepointIds(left.id, right.id)),
      memberCount: members.length,
    },
  };
}

/** Digest of one pearl's exact member set; deterministic by (version, word, sorted ids). */
export function pearlMemberDigest(word: ReducedWord, memberNodeIds: readonly NodeId[]): Digest {
  return digestPayload([ASSIGNMENT_VERSION, 'pearl-members-v1', wordKey(word), [...memberNodeIds].sort(compareCodepointIds)]);
}
