/** This is a typed semantic state coordinate and does not identify a member by raw string alone. */
export type StateKey = {
  readonly enumType: string;
  readonly member: string;
};

export type VocabularyProvider = () => readonly StateKey[];

const rendered = [
  ...members("TemporalDisposition", ["established", "excluded", "undetermined"]),
  ...members("BridgeDisposition", ["accepted", "rejected", "undetermined"]),
  ...members("EpistemicClass", ["explicit", "derived", "speculative"]),
] as const;

const inspected = [
  ...members("NodeKind", ["source", "subject", "cluster", "assertion", "conflict", "bridge", "rejection"]),
  ...members("EdgeKind", ["about", "cites", "conflict_member", "bridge_side", "in_cluster", "rejects"]),
  ...members("Gate", ["cross_project", "grounded", "not_already_stated", "non_trivial", "consequential", "survives_noise_objection"]),
  ...members("GateOutcome", ["pass", "fail", "unknown"]),
  ...members("Depth", ["obvious", "moderate", "deep"]),
  ...members("TrivialityArchetype", ["commodity_tooling", "generic_process_overlap", "same_ecosystem_by_definition", "restated_cross_reference"]),
  ...members("SupportClass", ["direct_quote", "paraphrase", "summary", "inferred", "unknown"]),
  ...members("LifecycleState", ["canonical", "candidate", "rejected"]),
  ...members("PolicyId", ["reliability", "discovery", "experimental"]),
  ...members("Overlap", ["overlaps", "disjoint", "undetermined"]),
  ...members("Side", ["left", "right"]),
] as const;

/** This is the hue-independent persistent partition and does not make raw strings globally unique. */
export const RENDERED: readonly StateKey[] = rendered;

/** This is the one-interaction inspection partition and does not discard free-text inspection data. */
export const INSPECTED: readonly StateKey[] = inspected;

/** This names inspected record fields that are not closed vocabulary members. */
export const INSPECTED_FREE_TEXT_FIELDS = ["failed_gate"] as const;

/** This names retained inspection fields and does not turn free text into a closed state. */
export const INSPECTED_RECORD_FIELDS = ["provenance", "failed_gate"] as const;

export const FULL_VOCABULARY: readonly StateKey[] = [...RENDERED, ...INSPECTED];

/** This is the injected-provider baseline vocabulary and does not collapse equal raw strings. */
export const FULL_VOCABULARY_BASELINE = FULL_VOCABULARY;

/** This is the sole default vocabulary source and does not allow a raw-string-only lookup. */
export const DEFAULT_VOCABULARY_PROVIDER: VocabularyProvider = () => FULL_VOCABULARY;

/** This reads the injected vocabulary source and does not cache or alter its result. */
export function readVocabulary(provider: VocabularyProvider = DEFAULT_VOCABULARY_PROVIDER): readonly StateKey[] {
  const vocabulary = provider();
  if (!Array.isArray(vocabulary)) {
    throw new TypeError("vocabulary provider must return an array");
  }
  return vocabulary;
}

/** This returns the pinned partition after checking the injected vocabulary and does not reinterpret a state. */
export function partition(provider: VocabularyProvider = DEFAULT_VOCABULARY_PROVIDER): {
  readonly rendered: readonly StateKey[];
  readonly inspected: readonly StateKey[];
} {
  assertPartition(provider);
  return { rendered: RENDERED, inspected: INSPECTED };
}

/** This asserts exact rendered/inspected membership against the injected vocabulary and does not permit drift. */
export function assertPartition(provider?: VocabularyProvider): void;
export function assertPartition(
  rendered: readonly StateKey[],
  inspected: readonly StateKey[],
  provider?: VocabularyProvider,
): void;
export function assertPartition(
  first: VocabularyProvider | readonly StateKey[] = DEFAULT_VOCABULARY_PROVIDER,
  second?: readonly StateKey[],
  third?: VocabularyProvider,
): void {
  const suppliedProvider = typeof first === "function" ? first : (third ?? DEFAULT_VOCABULARY_PROVIDER);
  const suppliedRendered = typeof first === "function" ? RENDERED : first;
  const suppliedInspected = typeof first === "function" ? INSPECTED : second;
  if (suppliedInspected === undefined) {
    throw new TypeError("partition requires both rendered and inspected sets");
  }

  const vocabulary = readVocabulary(suppliedProvider);
  const vocabularySet = stateSet(vocabulary, "vocabulary");
  const renderedSet = stateSet(suppliedRendered, "rendered");
  const inspectedSet = stateSet(suppliedInspected, "inspected");
  assertExactSet(renderedSet, stateSet(RENDERED, "pinned rendered"), "rendered set");
  assertExactSet(inspectedSet, stateSet(INSPECTED, "pinned inspected"), "inspected set");
  for (const key of renderedSet) {
    if (inspectedSet.has(key)) {
      throw new TypeError("rendered and inspected sets intersect");
    }
  }
  const union = new Set<string>([...renderedSet, ...inspectedSet]);
  assertExactSet(union, vocabularySet, "rendered/inspected union");
}

function members(enumType: string, rawMembers: readonly string[]): StateKey[] {
  return rawMembers.map((member) => ({ enumType, member }));
}

function stateSet(values: readonly StateKey[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "object" || value === null || typeof value.enumType !== "string" || typeof value.member !== "string" || value.enumType.length === 0 || value.member.length === 0) {
      throw new TypeError(`${label} contains an invalid state key`);
    }
    const key = stateId(value);
    if (result.has(key)) {
      throw new TypeError(`${label} contains a duplicate state key`);
    }
    result.add(key);
  }
  return result;
}

function stateId(value: StateKey): string {
  return `${value.enumType}\u0000${value.member}`;
}

function assertExactSet(actual: Set<string>, expected: Set<string>, label: string): void {
  if (actual.size !== expected.size || [...actual].some((key) => !expected.has(key))) {
    throw new TypeError(`${label} does not match the pinned vocabulary`);
  }
}
