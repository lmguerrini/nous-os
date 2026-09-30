/** Finite lazy Indra levels with caps, a digest-keyed cache and cancellation (D-073 row D5).
 *
 * Cost/cache/LOD: work is bounded by a depth limit D, a
 * maximum word count for the words a load materialises (the 2g(2g-1)^(d-1) words of a depth are
 * a theoretical figure, never materialised at once) and a node budget; levels load on demand, cache
 * per (snapshot digest, domain digest, parameters, level id) and unopened descendants keep only
 * identity/count metadata with no coordinates. Loading a level materialises the reduced-word
 * children of one parent word through the D4 assignment, so every loaded level carries the real
 * memberNodeIds and induced edge ids of its pearl. An aborted load stops between pearls, is
 * reported as cancelled and never populates the cache. */
import type { Digest, EdgeId, NodeId, RecursiveLevel } from '../projection/contract-types.ts';
import {
  ASSIGNMENT_VERSION, assignMembersToWords, isReducedWord, reducedWordCount, wordExtensions, wordKey,
  type AssignmentMember, type CrossEdgeLedgerEntry, type InducedEdgeRecord, type PearlAssignment, type ReducedWord,
} from './assignment.ts';

export const LEVELS_VERSION = 'indra-levels-v2';
export const LEVEL_PROJECTION_ID = 'indras-pearls';

export const ROOT_LEVEL_ID = 'indra-level-0-root';

/** Stable level id of one word's pearl, for example "indra-level-2-0+1-". */
export function levelIdForWord(word: ReducedWord): string {
  return `indra-level-${word.length}-${wordKey(word)}`;
}

export interface LazyLevelOptions {
  readonly genus: number;
  /** Maximum word-tree depth D that may ever be materialised. */
  readonly maxDepth: number;
  /** Cap on reducedWordCount(genus, depth) for any loaded depth. */
  readonly maxWords: number;
  /** Cap on the member count of one level load. */
  readonly nodeBudget: number;
}

export type LevelPlanRefusalCode = 'invalid-genus' | 'invalid-depth' | 'depth-cap-exceeded' | 'word-cap-exceeded';

export type LevelPlan =
  | Readonly<{ kind: 'planned'; wordCount: number }>
  | Readonly<{ kind: 'refusal'; code: LevelPlanRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>;

/** Bounds check for materialising depth `depth`: depth <= D and 2g(2g-1)^(depth-1) <= maxWords. */
export function planLevelDepth(genus: number, depth: number, options: Pick<LazyLevelOptions, 'maxDepth' | 'maxWords'>): LevelPlan {
  if (!Number.isInteger(genus) || genus < 2) {
    return { kind: 'refusal', code: 'invalid-genus', message: `genus must be an integer >= 2, received ${genus}`, witness: { genus } };
  }
  if (!Number.isInteger(depth) || depth < 1) {
    return { kind: 'refusal', code: 'invalid-depth', message: `depth must be a positive integer, received ${depth}`, witness: { depth } };
  }
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 1) {
    return { kind: 'refusal', code: 'invalid-depth', message: `maxDepth must be a positive integer, received ${options.maxDepth}`, witness: { maxDepth: options.maxDepth } };
  }
  if (depth > options.maxDepth) {
    return { kind: 'refusal', code: 'depth-cap-exceeded', message: `depth ${depth} exceeds the depth cap ${options.maxDepth}`, witness: { depth, maxDepth: options.maxDepth } };
  }
  const wordCount = reducedWordCount(genus, depth);
  if (wordCount > options.maxWords) {
    return { kind: 'refusal', code: 'word-cap-exceeded', message: `depth ${depth} needs ${wordCount} reduced words, above the cap ${options.maxWords}`, witness: { depth, wordCount, maxWords: options.maxWords } };
  }
  return { kind: 'planned', wordCount };
}

/**
 * Lazy per-pearl bounds for materialising the children of one parent at `childDepth`: the depth
 * cap is hard, and the words actually materialised (the 2g letters at depth 1, the 2g-1 reduced
 * extensions of one pearl deeper) must fit the word cap. The theoretical depth-wide count of
 * `planLevelDepth` is a witness figure only; it never blocks opening one pearl.
 */
export function planChildLevel(genus: number, childDepth: number, options: Pick<LazyLevelOptions, 'maxDepth' | 'maxWords'>): LevelPlan {
  if (!Number.isInteger(genus) || genus < 2) {
    return { kind: 'refusal', code: 'invalid-genus', message: `genus must be an integer >= 2, received ${genus}`, witness: { genus } };
  }
  if (!Number.isInteger(childDepth) || childDepth < 1) {
    return { kind: 'refusal', code: 'invalid-depth', message: `depth must be a positive integer, received ${childDepth}`, witness: { depth: childDepth } };
  }
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 1) {
    return { kind: 'refusal', code: 'invalid-depth', message: `maxDepth must be a positive integer, received ${options.maxDepth}`, witness: { maxDepth: options.maxDepth } };
  }
  if (childDepth > options.maxDepth) {
    return { kind: 'refusal', code: 'depth-cap-exceeded', message: `depth ${childDepth} exceeds the depth cap ${options.maxDepth}`, witness: { depth: childDepth, maxDepth: options.maxDepth } };
  }
  const wordCount = childDepth === 1 ? 2 * genus : 2 * genus - 1;
  if (wordCount > options.maxWords) {
    return { kind: 'refusal', code: 'word-cap-exceeded', message: `one pearl at depth ${childDepth} materialises ${wordCount} reduced words, above the cap ${options.maxWords}`, witness: { depth: childDepth, wordCount, maxWords: options.maxWords } };
  }
  return { kind: 'planned', wordCount };
}

/** Digest-addressed load token of one level; the projection id is fixed to 'indras-pearls'. */
export interface LevelLoadToken {
  readonly snapshotDigest: Digest;
  readonly domainDigest: Digest;
  readonly parameterHash: Digest;
  readonly levelId: string;
}

export function levelTokenKey(token: LevelLoadToken): string {
  return [LEVELS_VERSION, LEVEL_PROJECTION_ID, token.snapshotDigest, token.domainDigest, token.parameterHash, token.levelId].join('|');
}

export interface LevelCacheEntry {
  readonly levels: readonly RecursiveLevel[];
  readonly pearls: readonly PearlAssignment[];
  readonly crossEdges: readonly CrossEdgeLedgerEntry[];
}

/** Bounded LRU cache; identical tokens hit, eviction follows least-recently-used order. */
export interface LazyLevelCache {
  get(token: LevelLoadToken): LevelCacheEntry | undefined;
  put(token: LevelLoadToken, entry: LevelCacheEntry): void;
  has(token: LevelLoadToken): boolean;
  readonly size: number;
  clear(): void;
}

export function createLazyLevelCache(maxEntries = 64): LazyLevelCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError(`maxEntries must be a positive integer, received ${maxEntries}`);
  const entries = new Map<string, { token: LevelLoadToken; entry: LevelCacheEntry }>();
  return {
    get(token: LevelLoadToken): LevelCacheEntry | undefined {
      const hit = entries.get(levelTokenKey(token));
      if (hit === undefined) return undefined;
      entries.delete(levelTokenKey(token));
      entries.set(levelTokenKey(token), hit);
      return hit.entry;
    },
    put(token: LevelLoadToken, entry: LevelCacheEntry): void {
      const key = levelTokenKey(token);
      entries.delete(key);
      entries.set(key, { token, entry });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    has(token: LevelLoadToken): boolean {
      return entries.has(levelTokenKey(token));
    },
    get size(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
  };
}

export interface LevelLoadRequest {
  readonly token: LevelLoadToken;
  /** Word whose pearl is being expanded; null expands the root level into its depth-1 letters. */
  readonly parentWord: ReducedWord | null;
  readonly members: readonly AssignmentMember[];
  readonly edges: readonly InducedEdgeRecord[];
  readonly childIds: readonly string[] | null;
  readonly options: LazyLevelOptions;
  readonly cache?: LazyLevelCache;
  readonly abort?: AbortSignal;
  /** Called after each materialised pearl; aborting inside it stops the load. */
  readonly onProgress?: (loaded: number) => void;
}

export type LevelLoadRefusalCode =
  | LevelPlanRefusalCode
  | 'invalid-parent-word'
  | 'token-level-mismatch'
  | 'node-budget-exceeded'
  | 'assignment-refusal';

export type LevelLoadOutcome =
  | Readonly<{
    kind: 'loaded';
    fromCache: boolean;
    parentLevelId: string;
    levels: readonly RecursiveLevel[];
    pearls: readonly PearlAssignment[];
    crossEdges: readonly CrossEdgeLedgerEntry[];
  }>
  | Readonly<{ kind: 'refusal'; code: LevelLoadRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>
  | Readonly<{ kind: 'cancelled'; loadedSoFar: number; parentLevelId: string }>;

export interface UnloadedLevelStubInput {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly memberCount: number;
  readonly token: LevelLoadToken;
  readonly childLevelIds?: readonly string[];
}

/** Contract-shaped unloaded level: identity/count metadata and a load token, no coordinates. */
export function unloadedLevelStub(input: UnloadedLevelStubInput): RecursiveLevel {
  return {
    id: input.id,
    parentId: input.parentId,
    depth: input.depth,
    maxDepth: input.maxDepth,
    loaded: false,
    childLevelIds: input.childLevelIds ?? [],
    memberCount: input.memberCount,
    loadToken: {
      snapshotDigest: input.token.snapshotDigest,
      domainDigest: input.token.domainDigest,
      projectionId: LEVEL_PROJECTION_ID,
      parameterHash: input.token.parameterHash,
      levelId: input.token.levelId,
    },
  };
}

/**
 * Materialises the next finite level: the reduced-word children of `parentWord`. The caps run
 * first (depth, word count, node budget), then the cache, then the D4 assignment; cancellation
 * is checked before every pearl and a cancelled load leaves the cache untouched.
 */
export function loadChildLevels(request: LevelLoadRequest): LevelLoadOutcome {
  const { options } = request;
  const parentLevelId = request.parentWord === null ? ROOT_LEVEL_ID : levelIdForWord(request.parentWord);
  if (request.parentWord !== null && !isReducedWord(request.parentWord, options.genus)) {
    return {
      kind: 'refusal',
      code: 'invalid-parent-word',
      message: `the parent word ${wordKey(request.parentWord)} is not reduced for genus ${options.genus}`,
      witness: { genus: options.genus },
    };
  }
  if (request.token.levelId !== parentLevelId) {
    return {
      kind: 'refusal',
      code: 'token-level-mismatch',
      message: `the token names level ${request.token.levelId} but the request expands ${parentLevelId}`,
      witness: { tokenLevelId: request.token.levelId, parentLevelId },
    };
  }
  const childDepth = (request.parentWord?.length ?? 0) + 1;
  const plan = planChildLevel(options.genus, childDepth, options);
  if (plan.kind === 'refusal') return plan;
  const cached = request.cache?.get(request.token);
  if (cached !== undefined) {
    return { kind: 'loaded', fromCache: true, parentLevelId, levels: cached.levels, pearls: cached.pearls, crossEdges: cached.crossEdges };
  }
  const aborted = (): boolean => request.abort?.aborted === true;
  if (request.members.length > options.nodeBudget) {
    return {
      kind: 'refusal',
      code: 'node-budget-exceeded',
      message: `the level needs ${request.members.length} members, above the node budget ${options.nodeBudget}`,
      witness: { memberCount: request.members.length, nodeBudget: options.nodeBudget },
    };
  }
  if (aborted()) {
    return { kind: 'cancelled', loadedSoFar: 0, parentLevelId };
  }
  const assignmentOutcome = assignMembersToWords({
    parentWord: request.parentWord,
    genus: options.genus,
    members: request.members,
    edges: request.edges,
    childIds: request.childIds,
  });
  if (assignmentOutcome.kind === 'refusal') {
    return {
      kind: 'refusal',
      code: 'assignment-refusal',
      message: assignmentOutcome.message,
      witness: { innerCode: assignmentOutcome.code, ...assignmentOutcome.witness },
    };
  }
  const { pearls, crossEdges } = assignmentOutcome.assignment;
  const grandChildPlan = planChildLevel(options.genus, childDepth + 1, options);
  const levels: RecursiveLevel[] = [];
  for (let index = 0; index < pearls.length; index += 1) {
    const pearl = pearls[index] as PearlAssignment;
    if (aborted()) {
      return { kind: 'cancelled', loadedSoFar: index, parentLevelId };
    }
    const word = pearl.word;
    levels.push({
      id: levelIdForWord(word),
      parentId: parentLevelId,
      depth: pearl.depth,
      maxDepth: options.maxDepth,
      loaded: true,
      childLevelIds: grandChildPlan.kind === 'planned' ? wordExtensions(word, options.genus).map(levelIdForWord) : [],
      memberCount: pearl.memberNodeIds.length,
      memberDigest: pearl.memberDigest,
      memberNodeIds: pearl.memberNodeIds,
      inducedEdgeIds: pearl.inducedEdgeIds,
    });
    request.onProgress?.(index + 1);
  }
  const entry: LevelCacheEntry = { levels, pearls, crossEdges };
  request.cache?.put(request.token, entry);
  return { kind: 'loaded', fromCache: false, parentLevelId, levels, pearls, crossEdges };
}

/** Re-export so D7 assembles diagnostics with the assignment version without a second import. */
export const LEVELS_ASSIGNMENT_VERSION = ASSIGNMENT_VERSION;
