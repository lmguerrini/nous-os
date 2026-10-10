/**
 * A seeded, fully deterministic generator of an invented knowledge base. Every text is
 * built from generated pseudo-words (syllable joins) — no real-word lists, no names of
 * people, places, companies, projects or products, and no string copied from anywhere.
 * Dates fall in 2024–2026; digests are random hex from the PRNG.
 *
 * Two profiles:
 * - `reference` — the large demonstration dataset. Two figures are product constraints:
 *   11,199 index nodes in total, because the page's Completa calibration is keyed to that
 *   count, and exactly 9 root domains, because the Llull topology needs nine roots. Every
 *   other count (aggregates, containers, level skips, proposals, statuses, relations,
 *   passages) is illustrative: a round figure with no relation to any real dataset;
 * - `small` — the same shape scaled to ~600 nodes for fast tests.
 *
 * The aggregate counts are targets: each is hit exactly by construction (remainders are
 * absorbed by the hub tier), so the byte output is stable for a seed.
 */

import type { KbCitation, KbInferenceKind, KbNode, KbPassage, KbRelation, KbRole, KbSnapshot } from "./kb-types.ts";

export type SyntheticProfile = "reference" | "small";

interface ProfileSpec {
  domains: number;
  projects: number;
  systems: number;
  works: number;
  conversations: number;
  attachments: number;
  nonConversationSources: number;
  levelSkip: number;
  proposals: number;
  hubs: number;
  medium: number;
  mediumRange: [number, number];
  hubMinimum: number;
  hubJitter: number;
  extraMemberships: number;
  canon: number;
  nonCanonical: number;
  mentions: number;
  classifiedIn: number;
  relates: number;
  exploratory: Partial<Record<KbInferenceKind, number>>;
  extraPassages: number;
}

const PROFILES: Record<SyntheticProfile, ProfileSpec> = {
  reference: {
    domains: 9,
    projects: 10,
    systems: 12,
    works: 8,
    conversations: 150,
    attachments: 120,
    nonConversationSources: 80,
    levelSkip: 300,
    proposals: 10810,
    hubs: 12,
    medium: 30,
    mediumRange: [40, 90],
    hubMinimum: 500,
    hubJitter: 60,
    extraMemberships: 250,
    canon: 20,
    nonCanonical: 40,
    mentions: 4000,
    classifiedIn: 400,
    relates: 10,
    exploratory: {
      application: 60,
      continuity: 50,
      analogy: 30,
      dependency: 20,
      resonance: 10,
      card: 10,
      contradiction: 20,
    },
    extraPassages: 40,
  },
  small: {
    domains: 9,
    projects: 2,
    systems: 4,
    works: 2,
    conversations: 12,
    attachments: 8,
    nonConversationSources: 6,
    levelSkip: 22,
    proposals: 557,
    hubs: 2,
    medium: 2,
    mediumRange: [20, 40],
    hubMinimum: 150,
    hubJitter: 20,
    extraMemberships: 14,
    canon: 1,
    nonCanonical: 2,
    mentions: 230,
    classifiedIn: 24,
    relates: 2,
    exploratory: { application: 5, continuity: 4, analogy: 2, dependency: 2, resonance: 1, card: 1, contradiction: 1 },
    extraPassages: 3,
  },
};

export const SYNTHETIC_GENERATOR = { name: "synthetic-kb", version: "1.0.0" } as const;

/** The deterministic PRNG used everywhere (mulberry32). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  private readonly next: () => number;
  constructor(next: () => number) {
    this.next = next;
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.next() * (index + 1));
      [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
    }
    return copy;
  }
}

// Pseudo-words: joins of invented syllables. ASCII only, so byte offsets equal lengths.
const SYLLABLES = [
  "bo", "dar", "fel", "gor", "hul", "jor", "kal", "mir", "nol", "pel",
  "qus", "rov", "sil", "tam", "vel", "wol", "xen", "yor", "zul", "tif",
  "fen", "gol", "pra", "vun", "ket", "mab", "sod", "lir", "nuv", "xad",
] as const;

function makeVocabulary(random: Random): {
  word: () => string;
  title: (words?: number) => string;
  sentence: (min: number, max: number) => string;
  fileName: () => string;
} {
  const word = (): string => {
    const parts = random.int(2, 3);
    let text = "";
    for (let index = 0; index < parts; index += 1) text += random.pick(SYLLABLES);
    return text;
  };
  const title = (words = random.int(1, 3)): string =>
    Array.from({ length: words }, () => word().replace(/^./, match => match.toUpperCase())).join(" ");
  const sentence = (min: number, max: number): string => {
    const count = random.int(min, max);
    const words = Array.from({ length: count }, () => word());
    for (let index = 1; index < words.length - 1; index += 1) {
      if (random.chance(0.12)) words[index] += random.pick([",", ";", ":"]);
    }
    const text = words.join(" ");
    return `${text.replace(/^./, match => match.toUpperCase())}${random.pick([".", ".", ".", "?", "!"])}`;
  };
  const fileName = (): string => `${word()}${random.chance(0.4) ? `-${word()}` : ""}${random.pick([".pdf", ".txt", ".md", ".png"])}`;
  return { word, title, sentence, fileName };
}

function makeDate(random: Random): string {
  const year = random.int(2024, 2026);
  const month = random.int(1, 12);
  const day = random.int(1, 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function makeHex(random: Random, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += "0123456789abcdef"[random.int(0, 15)];
  return text;
}

/** Generate a complete invented snapshot; identical (profile, seed) pairs give identical bytes. */
export function generateSyntheticKb(profile: SyntheticProfile, seed: number): KbSnapshot {
  const spec = PROFILES[profile];
  const random = new Random(mulberry32(seed));
  const vocabulary = makeVocabulary(random);
  const nodes: KbNode[] = [];
  const relations: KbRelation[] = [];
  const passages: KbPassage[] = [];

  // ---- Level 1: domains (the Llull topology needs exactly nine roots). ----
  const usedTitles = new Set<string>();
  const domainIds: string[] = [];
  for (let index = 1; index <= spec.domains; index += 1) {
    let title = vocabulary.title(2);
    while (usedTitles.has(title)) title = vocabulary.title(2);
    usedTitles.add(title);
    const id = `domain:d${index}`;
    domainIds.push(id);
    const node: KbNode = {
      id, kind: "domain", level: 1, title, parent: null,
      date: makeDate(random),
    };
    if (random.chance(0.7)) node.evidence = [{ span: vocabulary.sentence(6, 12) }];
    nodes.push(node);
  }

  // ---- Level 2: aggregates. ----
  const aggregateIds: string[] = [];
  const addAggregate = (kind: "project" | "system" | "work", tag: string, index: number): void => {
    const id = `${kind}:${tag}${String(index).padStart(2, "0")}`;
    aggregateIds.push(id);
    const longTitle = random.chance(0.25);
    const node: KbNode = {
      id, kind, level: 2, parent: random.pick(domainIds),
      title: longTitle ? `${vocabulary.title(3)} ${vocabulary.sentence(3, 6).slice(0, -1)}` : vocabulary.title(),
      date: makeDate(random),
    };
    if (longTitle || random.chance(0.3)) node.short_label = vocabulary.title(1);
    if (random.chance(0.5)) node.evidence = [{ span: vocabulary.sentence(6, 12) }];
    nodes.push(node);
  };
  for (let index = 1; index <= spec.projects; index += 1) addAggregate("project", "p", index);
  for (let index = 1; index <= spec.systems; index += 1) addAggregate("system", "s", index);
  for (let index = 1; index <= spec.works; index += 1) addAggregate("work", "w", index);

  // ---- Level 3: containers and sources. ----
  const conversationKeys: string[] = [];
  for (let index = 1; index <= spec.conversations; index += 1) {
    const key = `c${String(index).padStart(3, "0")}`;
    conversationKeys.push(key);
    nodes.push({
      id: `conversation:${key}`, kind: "conversation", level: 3,
      title: `${vocabulary.title(2)} ${makeDate(random)}`, parent: null,
      date: makeDate(random),
    });
  }
  const attachmentKeys: string[] = [];
  for (let index = 1; index <= spec.attachments; index += 1) {
    const key = `a${String(index).padStart(3, "0")}`;
    attachmentKeys.push(key);
    nodes.push({
      id: `source:${key}`, kind: "attachment_source", level: 3,
      title: vocabulary.title(2), parent: null,
      date: makeDate(random),
      file_name: vocabulary.fileName(),
      owner_conversation: random.pick(conversationKeys),
      spans: Array.from({ length: random.int(1, 3) }, () => ({ span: vocabulary.sentence(5, 12) })),
      provider: vocabulary.word(),
      source_id: key,
      snapshot_digest: makeHex(random, 64),
      asset_digest: makeHex(random, 64),
      asset_id: makeHex(random, 12),
    });
  }
  const nonConversationKeys: string[] = [];
  for (let index = 1; index <= spec.nonConversationSources; index += 1) {
    const key = `n${String(index).padStart(3, "0")}`;
    nonConversationKeys.push(key);
    nodes.push({
      id: `source:${key}`, kind: "non_conversation_source", level: 3,
      title: vocabulary.title(2), parent: null,
      date: makeDate(random),
      file_name: vocabulary.fileName(),
      spans: Array.from({ length: random.int(1, 3) }, () => ({ span: vocabulary.sentence(5, 12) })),
      provider: vocabulary.word(),
      source_id: key,
      snapshot_digest: makeHex(random, 64),
    });
  }

  interface Container { id: string; key: string; kind: "conversation" | "attachment_source" | "non_conversation_source" }
  const containers: Container[] = [
    ...conversationKeys.map(key => ({ id: `conversation:${key}`, key, kind: "conversation" as const })),
    ...attachmentKeys.map(key => ({ id: `source:${key}`, key, kind: "attachment_source" as const })),
    ...nonConversationKeys.map(key => ({ id: `source:${key}`, key, kind: "non_conversation_source" as const })),
  ];
  const containerById = new Map(containers.map(container => [container.id, container]));

  // Place level-3 nodes: `levelSkip` of them directly under a root, the rest under aggregates.
  const skipOrder = random.shuffle(containers.map((_, index) => index));
  const skipped = new Set(skipOrder.slice(0, spec.levelSkip));
  for (const container of containers) {
    const node = nodes.find(item => item.id === container.id)!;
    if (skipped.has(containers.indexOf(container))) {
      node.parent = random.pick(domainIds);
      node.level_skip = true;
    } else {
      node.parent = random.pick(aggregateIds);
    }
  }

  // ---- Level 4: proposals with a heavy-tailed spread over the containers. ----
  const containerOrder = random.shuffle(containers.map((_, index) => index));
  const hubIndexes = containerOrder.slice(0, spec.hubs);
  const mediumIndexes = containerOrder.slice(spec.hubs, spec.hubs + spec.medium);
  const smallIndexes = containerOrder.slice(spec.hubs + spec.medium);

  const childCount = new Map<number, number>();
  let allocated = 0;
  for (const index of mediumIndexes) {
    const count = random.int(spec.mediumRange[0], spec.mediumRange[1]);
    childCount.set(index, count);
    allocated += count;
  }
  for (const index of smallIndexes) {
    const count = random.int(0, 5);
    childCount.set(index, count);
    allocated += count;
  }
  // The hub tier absorbs the remainder so the total is exact.
  const hubTotal = spec.proposals - allocated;
  const base = Math.floor(hubTotal / spec.hubs);
  const remainder = hubTotal % spec.hubs;
  const hubCounts = Array.from({ length: spec.hubs }, (_, position) => base + (position < remainder ? 1 : 0));
  for (let position = 0; position < spec.hubs - 1 && base - spec.hubJitter > spec.hubMinimum; position += 1) {
    const transfer = random.int(-spec.hubJitter, spec.hubJitter);
    hubCounts[position]! += transfer;
    hubCounts[position + 1]! -= transfer;
  }
  hubIndexes.forEach((index, position) => childCount.set(index, hubCounts[position]!));

  const allSourceKeys = [...attachmentKeys, ...nonConversationKeys];
  const digestBySourceKey = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "attachment_source" || node.kind === "non_conversation_source") {
      digestBySourceKey.set(node.source_id!, node.snapshot_digest!);
    }
  }
  const sourceDigest = (key: string): string => digestBySourceKey.get(key) ?? makeHex(random, 64);
  const cursorByKey = new Map<string, number>();
  const makeCitation = (sourceKey: string): KbCitation => {
    const span = vocabulary.sentence(5, 14);
    const start = cursorByKey.get(sourceKey) ?? random.int(0, 4096);
    const citation: KbCitation = {
      source_id: sourceKey,
      snapshot_digest: sourceDigest(sourceKey),
      start_byte: start,
      end_byte: start + span.length + 1,
      span,
      source_date: makeDate(random),
      role: random.pick(["user", "assistant", "user", "human"] as const),
    };
    cursorByKey.set(sourceKey, citation.end_byte + random.int(1, 240));
    return citation;
  };

  const proposalIds: string[] = [];
  const proposalCitations = new Map<string, KbCitation>();
  const proposalDates = new Map<string, string>();
  for (const container of containers) {
    const count = childCount.get(containers.indexOf(container)) ?? 0;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const id = `proposal:${container.key}-${String(sequence).padStart(4, "0")}`;
      const date = makeDate(random);
      const ownSource = container.kind === "attachment_source" || container.kind === "non_conversation_source";
      const primary = ownSource && random.chance(0.7) ? container.key : random.pick(allSourceKeys);
      const citations = [makeCitation(primary)];
      if (random.chance(0.15)) citations.push(makeCitation(random.pick(allSourceKeys)));
      proposalIds.push(id);
      proposalCitations.set(id, citations[0]!);
      proposalDates.set(id, date);
      const node: KbNode = {
        id, kind: "proposal", level: 4, parent: container.id,
        title: vocabulary.title(2),
        date,
        status: "proposal",
        origin: random.chance(0.01) ? "USER_AUTHORED" : "SOURCE_DERIVED",
        statement: vocabulary.sentence(8, 18),
        citations,
        record: { date, role: random.pick(["user", "assistant", "human", "system"] as const) },
      };
      if (random.chance(0.2)) node.short_label = vocabulary.title(1);
      nodes.push(node);
    }
  }

  // ---- Statuses: exactly `canon` and `non-canonical/attested` counts, the rest proposals. ----
  const proposalNodes = nodes.filter(node => node.kind === "proposal");
  const statusOrder = random.shuffle(proposalNodes);
  statusOrder.slice(0, spec.canon).forEach(node => { node.status = "canon"; });
  statusOrder.slice(spec.canon, spec.canon + spec.nonCanonical).forEach(node => { node.status = "non-canonical/attested"; });

  // ---- Extra memberships. ----
  const membershipPool = random.shuffle([...aggregateIds, ...containers.map(container => container.id)]);
  const aggregateLevel = new Map(nodes.map(node => [node.id, node.level ?? 0]));
  for (const nodeId of membershipPool.slice(0, spec.extraMemberships)) {
    const node = nodes.find(item => item.id === nodeId)!;
    const level = aggregateLevel.get(nodeId) ?? 3;
    const candidates = [...domainIds, ...aggregateIds].filter(candidate => {
      if (candidate === node.parent) return false;
      if (candidate === nodeId) return false;
      return (aggregateLevel.get(candidate) ?? 0) < level;
    });
    if (candidates.length > 0) node.parents = [random.pick(candidates)];
  }

  // ---- Conversations get their inventories (needs final proposal counts). ----
  const proposalsByContainer = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "proposal") proposalsByContainer.set(node.parent!, (proposalsByContainer.get(node.parent!) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (node.kind !== "conversation") continue;
    const key = node.id.slice("conversation:".length);
    node.inventory = {
      messages: (proposalsByContainer.get(node.id) ?? 0) + random.int(3, 20),
      provider: vocabulary.word(),
      conversation: key,
    };
  }

  // ---- Relations (one per real relation; no structural edges). ----
  const makeEvidence = (): KbCitation[] => [makeCitation(random.pick(allSourceKeys))];
  let relationCounter = 0;
  const relationId = (family: string): string => {
    relationCounter += 1;
    return `rel:${family}-${String(relationCounter).padStart(5, "0")}`;
  };
  const randomProposal = (): string => random.pick(proposalIds);

  for (let index = 0; index < spec.mentions; index += 1) {
    const source = randomProposal();
    const roll = random.float();
    let target: string;
    if (roll < 0.55) {
      do { target = randomProposal(); } while (target === source);
    } else if (roll < 0.8) {
      target = `conversation:${random.pick(conversationKeys)}`;
    } else if (roll < 0.92) {
      target = random.pick(domainIds);
    } else {
      target = `source:${random.pick(allSourceKeys)}`;
    }
    relations.push({ id: relationId("mentions"), source, target, type: "mentions", directed: true, class: "attested", evidence: makeEvidence() });
  }

  for (let index = 0; index < spec.classifiedIn; index += 1) {
    const source = random.chance(0.5) ? randomProposal() : random.pick(containers).id;
    const target = random.pick(domainIds);
    if (source === target) continue;
    relations.push({ id: relationId("classified"), source, target, type: "classified_in", directed: true, class: "attested", evidence: makeEvidence() });
  }

  for (let index = 0; index < spec.relates; index += 1) {
    const source = random.pick(aggregateIds);
    let target = random.pick(aggregateIds);
    while (target === source) target = random.pick(aggregateIds);
    relations.push({ id: relationId("relates"), source, target, type: "relates", directed: false, class: "attested", evidence: makeEvidence() });
  }

  const DIRECTED_INFERENCES = new Set<KbInferenceKind>(["dependency", "application", "continuity", "card"]);
  const inferenceKinds = Object.keys(spec.exploratory) as KbInferenceKind[];
  for (const kind of inferenceKinds) {
    const count = spec.exploratory[kind] ?? 0;
    for (let index = 0; index < count; index += 1) {
      const source = random.chance(0.85) ? randomProposal() : random.pick(containers).id;
      let target = random.chance(0.85) ? randomProposal() : random.pick(containers).id;
      while (target === source) target = randomProposal();
      const relation: KbRelation = {
        id: relationId(kind),
        source,
        target,
        type: kind,
        directed: DIRECTED_INFERENCES.has(kind),
        class: "exploratory",
        evidence: random.chance(0.4) ? makeEvidence() : [],
        explanation: vocabulary.sentence(6, 14),
        inference: kind,
        confidence: random.pick(["low", "medium", "high"]),
      };
      if (kind === "contradiction" || (kind !== "card" && random.chance(0.3))) {
        relation.counter_evidence = makeEvidence();
      }
      relations.push(relation);
    }
  }

  // ---- Passages: one per proposal plus a few extras, all lazy (level 5). ----
  const passageOrder = random.shuffle(proposalIds);
  const extraByNode = new Set(passageOrder.slice(0, spec.extraPassages));
  for (const proposalId of proposalIds) {
    const citation = proposalCitations.get(proposalId)!;
    const addPassage = (n: number): void => {
      const passage: KbPassage = {
        node: proposalId,
        n,
        citation,
        record: {
          kind: "message",
          role: random.pick(["user", "assistant", "human"] as const satisfies readonly KbRole[]),
          date: proposalDates.get(proposalId)!,
          source_id: citation.source_id,
        },
      };
      if (random.chance(0.5)) passage.context_before = vocabulary.sentence(4, 8);
      if (random.chance(0.5)) passage.context_after = vocabulary.sentence(4, 8);
      passages.push(passage);
    };
    addPassage(1);
    if (extraByNode.has(proposalId)) addPassage(2);
  }

  return {
    schema: "nousos.demo-kb/1",
    generator: { ...SYNTHETIC_GENERATOR, seed },
    nodes,
    relations,
    passages,
  };
}

export const syntheticProfileNames = Object.keys(PROFILES) as SyntheticProfile[];
