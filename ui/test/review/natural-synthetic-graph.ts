/**
 * Deterministic synthetic ledger fixtures for the D-073 C7 Natural property and migration tests.
 * Everything is generated from an integer seed through a fixed PRNG: the graphs are entirely
 * synthetic — no real titles, ids, quotes or private data appear anywhere in this module.
 *
 * The shape deliberately exercises every path the Natural bridge walks: a three-level hierarchy
 * under three synthetic domains (so co-membership chords exist), level-3 nodes with multiple
 * domain memberships, source edges of both attestation classes and several types (including
 * `contains` rows the relation planner must skip), mixed node standings, arbitrary JSON evidence
 * payloads, and level-5 passage detail rows with paired value/null/absent `context` cases that
 * `createSemanticSnapshot` materializes as display nodes.
 */
import type { RawJsonObject } from '../../src/projection/contract-types.ts';

/** The shape of the fixture the generator returns, already in `normalizeRawLedger` input form. */
export interface SyntheticNaturalLedger {
  readonly manifest: RawJsonObject;
  readonly index: { readonly schema: 'nousos.review-graph/2'; readonly nodes: RawJsonObject[]; readonly edges: RawJsonObject[] };
  readonly details: RawJsonObject[];
  /** Detail rows to materialize as level-5 passage display nodes. */
  readonly passageIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

/** mulberry32: a fixed seed gives a fixed graph, byte for byte, on every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic seeded shuffle (Fisher–Yates over the generator, never Math.random). */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const left = result[i]!;
    result[i] = result[j]!;
    result[j] = left;
  }
  return result;
}

const SYNTHETIC_EVIDENCE = (ordinal: number): RawJsonObject => ({
  source_id: `synthetic-evidence-${ordinal}`,
  snapshot_digest: `synthetic-digest-${ordinal}`,
  span: `bytes ${ordinal}-${ordinal + 16}`,
  payload: { note: 'synthetic', ordinal, nested: [ordinal, { deep: true }] },
});

/**
 * Builds one seeded synthetic ledger. `projects`/`conversationSpread`/`messageSpread` control the
 * size class; the seed controls the topology (memberships, cross edges, statuses) inside it.
 */
export function syntheticNaturalLedger(seed: number, options: {
  readonly domains?: number;
  readonly projectsPerDomain?: number;
  readonly conversationsPerProject?: number;
  readonly messagesPerConversation?: number;
} = {}): SyntheticNaturalLedger {
  const random = mulberry32(seed);
  const domainCount = options.domains ?? 3;
  const projectsPerDomain = options.projectsPerDomain ?? 2;
  const conversationsPerProject = options.conversationsPerProject ?? 3;
  const messagesPerConversation = options.messagesPerConversation ?? 3;
  const nodes: RawJsonObject[] = [];
  const edges: RawJsonObject[] = [];
  const details: RawJsonObject[] = [];
  let edgeOrdinal = 0;
  let evidenceOrdinal = 0;

  const domainIds: string[] = [];
  for (let d = 0; d < domainCount; d++) {
    const id = `synthetic-domain-${d}`;
    domainIds.push(id);
    nodes.push({
      id, level: 1, kind: 'domain', parent: null, parents: [], domains: [id],
      status: d === 0 ? 'canon' : 'overlay',
      epistemic_status: d === 1 ? null : 'synthetic',
      title: `Synthetic domain ${d}`, title_full: `Synthetic domain ${d} (full)`,
      display_label: `SD${d}`, date: `2026-0${d + 1}-01`, origin: 'synthetic-fixture',
      importance: { value: 0.5 + d * 0.1, components: { synthetic: 0.5 } }, size: 1 - d * 0.2,
      counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
      citations: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)],
    });
  }

  const messageIds: string[] = [];
  const conversationIds: string[] = [];
  let projectOrdinal = 0;
  let conversationOrdinal = 0;
  let messageOrdinal = 0;
  for (let d = 0; d < domainCount; d++) {
    const projectCount = projectsPerDomain + (random() < 0.5 ? 0 : 1);
    for (let p = 0; p < projectCount; p++) {
      const projectId = `synthetic-project-${projectOrdinal++}`;
      const domain = domainIds[d]!;
      nodes.push({
        id: projectId, level: 2, kind: 'project', parent: domain, parents: [domain], domains: [domain],
        ...(random() < 0.5 ? { status: 'canon' } : {}),
        title: `Synthetic project ${projectId}`, title_full: `Synthetic project ${projectId} (full)`,
        statement: 'Synthetic statement', scope: 'Synthetic scope', why: 'Synthetic why',
        importance: { value: random(), components: { synthetic: random() } }, size: random(),
        counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
      });
      const conversationCount = conversationsPerProject + Math.floor(random() * 2);
      for (let c = 0; c < conversationCount; c++) {
        const conversationId = `synthetic-conversation-${conversationOrdinal++}`;
        conversationIds.push(conversationId);
        // A second domain membership on some conversations gives the co-membership chords a basis.
        const other = domainIds[(d + 1 + Math.floor(random() * (domainCount - 1))) % domainCount]!;
        const memberships = random() < 0.4 ? [domain, other] : [domain];
        nodes.push({
          id: conversationId, level: 3, kind: 'conversation', parent: projectId, parents: [projectId],
          domains: memberships, ...(random() < 0.25 ? { status: 'proposal' } : {}),
          title: `Synthetic conversation ${conversationId}`, title_full: `Synthetic conversation ${conversationId} (full)`,
          importance: { value: random(), components: { synthetic: random() } }, size: random(),
          counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
        });
        const messageCount = messagesPerConversation + Math.floor(random() * 3);
        for (let m = 0; m < messageCount; m++) {
          const messageId = `synthetic-message-${messageOrdinal++}`;
          messageIds.push(messageId);
          const passageCount = random() < 0.35 ? 1 : 0;
          nodes.push({
            id: messageId, level: 4, kind: 'message', parent: conversationId, parents: [conversationId],
            domains: memberships, ...(random() < 0.2 ? { status: 'overlay' } : {}),
            ...(random() < 0.2 ? { epistemic_status: null } : {}),
            title: `Synthetic message ${messageId}`, title_full: `Synthetic message ${messageId} (full)`,
            importance: { value: random(), components: { synthetic: random() } }, size: random(),
            counts: { children: 0, descendants: 0, canon: 0, passages: passageCount },
            ...(random() < 0.3 ? { citations: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)] } : {}),
          });
          for (let k = 0; k < passageCount; k++) {
            const passageId = `synthetic-passage-${messageId}-${k}`;
            details.push({
              id: passageId, batch: `synthetic-batch-${seed}`, kind: 'passage', level: 5,
              parent: messageId, title: `Synthetic passage ${k} of ${messageId}`,
              statement: 'Synthetic passage statement', support: 'synthetic',
              // Paired value/null/absent context cases across the passage rows.
              context: k === 0 ? { synthetic: true, ordinal: k } : null,
              provenance_line: 'synthetic provenance line',
              citations: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)],
            });
          }
        }
      }
    }
  }

  // Exact child/descendant counts from the declared hierarchy, as the source index would carry them.
  const byId = new Map(nodes.map(node => [node.id as string, node]));
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = node.parent as string | null;
    if (parent === null) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(node.id as string);
    childrenOf.set(parent, list);
  }
  const descendantsOf = (id: string): number => (childrenOf.get(id) ?? []).reduce(
    (total, child) => total + 1 + descendantsOf(child), 0);
  for (const node of nodes) {
    const id = node.id as string;
    const passages = (node.counts as { passages: number }).passages;
    (node as { counts: RawJsonObject }).counts = {
      children: (childrenOf.get(id) ?? []).length,
      descendants: descendantsOf(id),
      canon: byId.size > 0 && id.endsWith('0') ? 1 : 0,
      passages,
    };
  }

  // Source edges: a seeded subset of the hierarchy as explicit `contains` rows (the relation planner
  // must skip these; containment visuals come from the parents, never from these rows), plus cross
  // links of the types the planner lifts, with both attestation classes represented.
  for (const [index, conversation] of conversationIds.entries()) {
    if (random() >= 0.25) continue;
    const parent = byId.get(conversation)!.parent as string;
    edges.push({
      id: `synthetic-edge-${edgeOrdinal++}`, source: parent, target: conversation,
      class: 'attested', type: 'contains', directed: true, evidence: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)],
    });
    void index;
  }
  for (let i = 0; i < messageIds.length; i++) {
    if (random() >= 0.4) continue;
    const source = messageIds[i]!;
    const target = messageIds[(i + 1 + Math.floor(random() * 4)) % messageIds.length]!;
    if (source === target) continue;
    const exploratory = random() < 0.5;
    edges.push({
      id: `synthetic-edge-${edgeOrdinal++}`, source, target,
      class: exploratory ? 'exploratory' : 'attested',
      type: random() < 0.3 ? 'mentions' : 'relates', directed: random() < 0.5,
      evidence: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)],
      weight: 1 + Math.floor(random() * 3),
    });
  }
  for (const [index, conversation] of conversationIds.entries()) {
    if (random() >= 0.3 || messageIds.length === 0) continue;
    edges.push({
      id: `synthetic-edge-${edgeOrdinal++}`, source: conversation,
      target: domainIds[index % domainIds.length]!,
      class: random() < 0.5 ? 'exploratory' : 'attested', type: 'mentions', directed: true,
      evidence: [SYNTHETIC_EVIDENCE(evidenceOrdinal++)],
    });
  }

  return {
    manifest: {
      schema: 'nousos.review-graph/2', digest: `synthetic-manifest-${seed}`,
      counts: { nodes: nodes.length, edges: edges.length },
      limits: { response_max_bytes: 4096 }, rules: { fixture: 'natural-synthetic-v1', seed },
    },
    index: { schema: 'nousos.review-graph/2', nodes, edges },
    details,
    passageIds: details.map(detail => detail.id as string),
    nodeIds: nodes.map(node => node.id as string),
    edgeIds: edges.map(edge => edge.id as string),
  };
}
