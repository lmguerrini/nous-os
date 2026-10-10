/**
 * The pure adapter: `KbSnapshot → { index, details, manifestWithoutDigest }`.
 * No I/O, no randomness — the same snapshot always yields byte-identical files.
 *
 * Dataset rules enforced here:
 * - one index node per KB node at levels 1–4 (passages are level 5 and lazy);
 * - exactly one index edge per KB relation and nothing else — containment,
 *   co-membership, aggregation and decorative structure are the renderer's;
 * - exploratory edges carry `status: "exploratory/non-canonical"` and their explanation;
 * - rejects: duplicate node/relation ids, malformed ids, kind/level mismatches,
 *   missing endpoints, self-loops, unknown relation classes, exploratory relations
 *   without an explanation, parents whose level is not lower, primary-hierarchy
 *   cycles, level-1 ids that are not `domain:<key>`, and KB `domains` entries that
 *   are not level-1 node ids.
 *
 * Domain and membership convention (what the approved page reads):
 * - dataset `domains` holds the **bare keys** of the referenced root domains
 *   (root id `domain:k` → key `k`), primary domain first, deduplicated; a root lists
 *   only its own key, and a node without explicit domains gets the key of the root
 *   of its primary chain;
 * - dataset `primary_domain` is `domains[0]`, emitted on level-3 nodes only;
 * - dataset `parents` lists every membership — the primary parent first, then the
 *   additional ones — and is `[]` for roots.
 *
 * Importance formula (all inputs computable from the KB, value always finite):
 *   value = 0.42·log2(1 + degree) + 0.31·log2(1 + descendants)
 *         + 0.15·canonFlag + 0.12·log2(1 + passages)
 * where `degree` is the number of relations touching the node, `descendants` the
 * number of primary descendants, `canonFlag` is 1 when the node or any descendant has
 * status `canon`, and `passages` the number of passages attached to the node or its
 * descendants. The raw components are recorded in `importance.components`.
 * `size` spreads the nodes over [0.05, 1] by importance rank (ties broken by id).
 */

import type {
  AggregateDetailRecord,
  ConversationDetailRecord,
  DetailsRecord,
  DetailsOffsets,
  PassageDetailRecord,
  ProposalDetailRecord,
  ReviewGraphEdge,
  ReviewGraphIndex,
  ReviewGraphNode,
  SourceDetailRecord,
} from "./review-graph-types.ts";
import type {
  DetailCitation,
  DatasetManifest,
} from "./review-graph-types.ts";
import type { KbCitation, KbNode, KbPassage, KbRelation, KbSnapshot } from "./kb-types.ts";
import { KIND_LEVEL } from "./kb-types.ts";

export interface AdapterResult {
  index: ReviewGraphIndex;
  details: DetailsRecord[];
  manifestWithoutDigest: Omit<DatasetManifest, "digest" | "files">;
}

const ID_PATTERN = /^[A-Za-z0-9_:.-]{1,180}$/;
const DOMAIN_ID = /^domain:([A-Za-z0-9_.-]{1,160})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The bare domain key of a root id (`domain:k` → `k`). */
function domainKey(rootId: string): string {
  return rootId.slice("domain:".length);
}

function fail(message: string): never {
  throw new Error(`kb-to-review-graph: ${message}`);
}

/** Compare ids by Unicode code point for stable ordering. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const first = left[index]!.codePointAt(0)!;
    const second = right[index]!.codePointAt(0)!;
    if (first !== second) return first - second;
  }
  return left.length - right.length;
}

/** Fit a label into `limit` code points, cutting on a word boundary with an ellipsis. */
export function fitLabel(text: string, limit = 33): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  let cut = characters.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  if (space > Math.floor((limit - 1) / 3)) cut = cut.slice(0, space);
  return `${cut.join("").replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function toDetailCitation(citation: KbCitation): DetailCitation {
  const record: DetailCitation = {
    source_id: citation.source_id,
    snapshot_digest: citation.snapshot_digest,
    start_byte: citation.start_byte,
    end_byte: citation.end_byte,
    span: citation.span,
  };
  if (citation.source_date !== undefined) record.source_date = citation.source_date;
  if (citation.role !== undefined) record.role = citation.role;
  return record;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Validate the snapshot and build the index, details records and manifest body. */
export function kbToReviewGraph(kb: KbSnapshot): AdapterResult {
  if (!Array.isArray(kb.nodes) || !Array.isArray(kb.relations) || !Array.isArray(kb.passages)) {
    fail("snapshot needs nodes, relations and passages arrays");
  }

  const nodesById = new Map<string, KbNode>();
  for (const node of kb.nodes) {
    if (!ID_PATTERN.test(node.id)) fail(`node id "${node.id}" does not match [A-Za-z0-9_:.-]{1,180}`);
    if (nodesById.has(node.id)) fail(`duplicate node id "${node.id}"`);
    if (typeof node.title !== "string" || node.title.length === 0) fail(`node "${node.id}" needs a title`);
    const expected = (KIND_LEVEL as Record<string, 1 | 2 | 3 | 4 | undefined>)[node.kind as string];
    if (expected === undefined) fail(`node "${node.id}" has unknown kind "${node.kind}"`);
    if (node.level !== undefined && node.level !== expected) {
      fail(`node "${node.id}" of kind ${node.kind} must be at level ${expected}`);
    }
    if (expected === 1 && !DOMAIN_ID.test(node.id)) {
      fail(`level-1 node id "${node.id}" must be domain:<key> with <key> in [A-Za-z0-9_.-]{1,160}`);
    }
    nodesById.set(node.id, node);
  }

  // Primary hierarchy: exists, lower level, acyclic, roots only at level 1.
  for (const node of kb.nodes) {
    const level = KIND_LEVEL[node.kind];
    if (node.parent === null) {
      if (level !== 1) fail(`node "${node.id}" at level ${level} needs a parent`);
      continue;
    }
    const parent = nodesById.get(node.parent);
    if (parent === undefined) fail(`node "${node.id}" has unknown parent "${node.parent}"`);
    if (KIND_LEVEL[parent.kind] >= level) {
      fail(`parent "${parent.id}" of "${node.id}" must have a lower level`);
    }
    const seen = new Set<string>([node.id]);
    let walk: string | null = parent.id;
    while (walk !== null) {
      if (seen.has(walk)) fail(`cycle in the primary hierarchy at "${walk}"`);
      seen.add(walk);
      const current = nodesById.get(walk)!;
      if (current.parent !== null && !nodesById.has(current.parent)) {
        fail(`node "${current.id}" has unknown parent "${current.parent}"`);
      }
      walk = current.parent;
    }
    if (level === 3 && KIND_LEVEL[parent.kind] === 1 && !node.level_skip) {
      fail(`level-3 node "${node.id}" attached directly to a root must set level_skip`);
    }
    if (node.level_skip === true && !(level === 3 && KIND_LEVEL[parent.kind] === 1)) {
      fail(`node "${node.id}" sets level_skip outside the level-3-under-root case`);
    }
  }

  // Additional memberships.
  for (const node of kb.nodes) {
    for (const extra of node.parents ?? []) {
      if (!nodesById.has(extra)) fail(`node "${node.id}" has unknown additional parent "${extra}"`);
      if (extra === node.parent) fail(`node "${node.id}" repeats its primary parent in parents`);
    }
    const unique = new Set(node.parents ?? []);
    if (unique.size !== (node.parents ?? []).length) fail(`node "${node.id}" has duplicate additional parents`);
    for (const domain of node.domains ?? []) {
      const root = nodesById.get(domain);
      if (root === undefined) fail(`node "${node.id}" references unknown domain "${domain}"`);
      if (KIND_LEVEL[root.kind] !== 1) {
        fail(`node "${node.id}" references domain "${domain}" that is not a level-1 node id`);
      }
    }
  }

  // Relations.
  const relationIds = new Set<string>();
  for (const relation of kb.relations) {
    if (!ID_PATTERN.test(relation.id)) fail(`relation id "${relation.id}" does not match [A-Za-z0-9_:.-]{1,180}`);
    if (relationIds.has(relation.id)) fail(`duplicate relation id "${relation.id}"`);
    relationIds.add(relation.id);
    if (!nodesById.has(relation.source)) fail(`relation "${relation.id}" has unknown source "${relation.source}"`);
    if (!nodesById.has(relation.target)) fail(`relation "${relation.id}" has unknown target "${relation.target}"`);
    if (relation.source === relation.target) fail(`relation "${relation.id}" is a self-loop`);
    if (relation.class !== "attested" && relation.class !== "exploratory") {
      fail(`relation "${relation.id}" has unknown class "${String(relation.class)}"`);
    }
    if (relation.class === "exploratory" && typeof relation.explanation !== "string") {
      fail(`exploratory relation "${relation.id}" requires an explanation`);
    }
    if (!Array.isArray(relation.evidence)) fail(`relation "${relation.id}" needs an evidence array`);
    for (const citation of relation.evidence) {
      if (!HEX64.test(citation.snapshot_digest)) fail(`relation "${relation.id}" has a non-hex snapshot digest`);
    }
  }

  // Passages attach to level-4 nodes with unique ordinals.
  const passagesByNode = new Map<string, KbPassage[]>();
  const passageIds = new Set<string>();
  for (const passage of kb.passages) {
    const owner = nodesById.get(passage.node);
    if (owner === undefined) fail(`passage references unknown node "${passage.node}"`);
    if (KIND_LEVEL[owner.kind] !== 4) fail(`passage must attach to a level-4 node, not "${passage.node}"`);
    if (!Number.isInteger(passage.n) || passage.n < 1) fail(`passage of "${passage.node}" needs a positive ordinal`);
    const id = `passage:${passage.node}:${passage.n}`;
    if (passageIds.has(id)) fail(`duplicate passage id "${id}"`);
    passageIds.add(id);
    const list = passagesByNode.get(passage.node) ?? [];
    list.push(passage);
    passagesByNode.set(passage.node, list);
  }

  // Hierarchy roll-up: children, descendants, canon, passages, live proposals.
  const childrenOf = new Map<string, string[]>();
  for (const node of kb.nodes) {
    if (node.parent !== null) {
      const list = childrenOf.get(node.parent) ?? [];
      list.push(node.id);
      childrenOf.set(node.parent, list);
    }
  }
  const degree = new Map<string, number>();
  for (const relation of kb.relations) {
    degree.set(relation.source, (degree.get(relation.source) ?? 0) + 1);
    degree.set(relation.target, (degree.get(relation.target) ?? 0) + 1);
  }
  interface Rollup { descendants: number; canon: number; passages: number; live: number }
  const rollup = new Map<string, Rollup>();
  const ordered = [...kb.nodes].sort((a, b) => KIND_LEVEL[b.kind] - KIND_LEVEL[a.kind] || byCodePoint(a.id, b.id));
  for (const node of ordered) {
    let descendants = 0;
    let canon = node.status === "canon" ? 1 : 0;
    let passages = passagesByNode.get(node.id)?.length ?? 0;
    let live = KIND_LEVEL[node.kind] === 4 && node.status !== "canon" && node.status !== "non-canonical/attested" ? 1 : 0;
    for (const child of childrenOf.get(node.id) ?? []) {
      const childRollup = rollup.get(child)!;
      descendants += 1 + childRollup.descendants;
      canon += childRollup.canon;
      passages += childRollup.passages;
      live += childRollup.live;
    }
    rollup.set(node.id, { descendants, canon, passages, live });
  }

  // Domains: the root of the primary chain plus any level-1 additional parent.
  const rootCache = new Map<string, string>();
  function rootOf(node: KbNode): string {
    let current = node;
    const path: string[] = [];
    while (current.parent !== null) {
      path.push(current.id);
      const cached = rootCache.get(current.id);
      if (cached !== undefined) return cached;
      current = nodesById.get(current.parent)!;
    }
    for (const stepped of path) rootCache.set(stepped, current.id);
    return current.id;
  }

  const importanceValues = new Map<string, number>();
  for (const node of kb.nodes) {
    const stats = rollup.get(node.id)!;
    const value = round6(
      0.42 * Math.log2(1 + (degree.get(node.id) ?? 0)) +
      0.31 * Math.log2(1 + stats.descendants) +
      0.15 * (stats.canon > 0 ? 1 : 0) +
      0.12 * Math.log2(1 + stats.passages),
    );
    if (!Number.isFinite(value)) fail(`node "${node.id}" produced a non-finite importance`);
    importanceValues.set(node.id, value);
  }
  const ranked = [...kb.nodes].sort(
    (a, b) => importanceValues.get(a.id)! - importanceValues.get(b.id)! || byCodePoint(a.id, b.id),
  );
  const sizeOf = new Map<string, number>();
  ranked.forEach((node, index) => {
    const size = ranked.length === 1 ? 1 : round6(0.05 + 0.95 * (index / (ranked.length - 1)));
    sizeOf.set(node.id, size);
  });

  const indexNodes: ReviewGraphNode[] = ordered.map((node) => {
    const level = KIND_LEVEL[node.kind];
    const stats = rollup.get(node.id)!;
    // Bare domain keys, primary first: the root of the primary chain, then any level-1
    // additional membership and KB domain, deduplicated; a root lists only its own key.
    const primaryDomainKey = domainKey(rootOf(node));
    const extraDomainKeys = [...new Set(
      [...(node.parents ?? []).filter(id => KIND_LEVEL[nodesById.get(id)!.kind] === 1), ...(node.domains ?? [])]
        .sort(byCodePoint)
        .map(domainKey),
    )].filter(key => key !== primaryDomainKey);
    const domains = level === 1 ? [domainKey(node.id)] : [primaryDomainKey, ...extraDomainKeys];
    const parents = node.parent === null
      ? []
      : [...new Set([node.parent, ...[...(node.parents ?? [])].sort(byCodePoint)])];
    const counts: ReviewGraphNode["counts"] = {
      children: childrenOf.get(node.id)?.length ?? 0,
      descendants: stats.descendants,
      canon: stats.canon,
      passages: stats.passages,
    };
    if (level <= 3) counts.live_proposals = stats.live;
    const record: ReviewGraphNode = {
      id: node.id,
      level,
      kind: node.kind,
      parent: node.parent,
      parents,
      domains,
      title: node.title,
      display_label: fitLabel(node.short_label ?? node.title),
      title_full: node.title,
      importance: {
        value: importanceValues.get(node.id)!,
        components: {
          degree: degree.get(node.id) ?? 0,
          descendants: stats.descendants,
          canon: stats.canon,
          passages: stats.passages,
        },
      },
      size: sizeOf.get(node.id)!,
      counts,
    };
    if (level === 3) record.primary_domain = domains[0]!;
    if (node.status !== undefined) record.status = node.status;
    if (node.date !== undefined) record.date = node.date;
    if (node.origin !== undefined) record.origin = node.origin;
    if (node.level_skip === true) record.level_skip = true;
    return record;
  });

  const indexEdges: ReviewGraphEdge[] = kb.relations.map((relation) => {
    const edge: ReviewGraphEdge = {
      id: relation.id,
      source: relation.source,
      target: relation.target,
      class: relation.class,
      type: relation.type,
      directed: relation.directed,
      evidence: relation.evidence.map(toDetailCitation),
    };
    if (relation.class === "exploratory") {
      edge.status = "exploratory/non-canonical";
      edge.explanation = relation.explanation!;
    }
    if (relation.inference !== undefined) edge.inference = relation.inference;
    if (relation.confidence !== undefined) edge.confidence = relation.confidence;
    if (relation.counter_evidence !== undefined) edge.counter_evidence = relation.counter_evidence.map(toDetailCitation);
    return edge;
  }).sort((a, b) => byCodePoint(a.id, b.id));

  const details: DetailsRecord[] = [];
  for (const node of ordered) {
    if (node.kind === "proposal") {
      if (node.statement === undefined && node.citations === undefined && node.record === undefined) continue;
      const record: ProposalDetailRecord = {
        id: node.id,
        kind: "proposal",
        statement: node.statement ?? "",
        citations: (node.citations ?? []).map(toDetailCitation),
        record: node.record ?? {},
      };
      details.push(record);
    } else if (node.kind === "conversation") {
      if (node.inventory === undefined) continue;
      const record: ConversationDetailRecord = { id: node.id, kind: "conversation", inventory: node.inventory };
      details.push(record);
    } else if (node.kind === "attachment_source" || node.kind === "non_conversation_source") {
      const hasContent = node.file_name !== undefined || node.owner_conversation !== undefined || (node.spans ?? []).length > 0 ||
        node.provider !== undefined || node.source_id !== undefined || node.snapshot_digest !== undefined ||
        node.asset_digest !== undefined || node.asset_id !== undefined;
      if (!hasContent) continue;
      const record: SourceDetailRecord = { id: node.id, kind: node.kind, spans: node.spans ?? [] };
      if (node.file_name !== undefined) record.file_name = node.file_name;
      if (node.owner_conversation !== undefined) record.owner_conversation = node.owner_conversation;
      if (node.provider !== undefined) record.provider = node.provider;
      if (node.source_id !== undefined) record.source_id = node.source_id;
      if (node.snapshot_digest !== undefined) record.snapshot_digest = node.snapshot_digest;
      if (node.asset_digest !== undefined) record.asset_digest = node.asset_digest;
      if (node.asset_id !== undefined) record.asset_id = node.asset_id;
      details.push(record);
    } else if ((node.evidence ?? []).length > 0) {
      const record: AggregateDetailRecord = { id: node.id, kind: node.kind, evidence: node.evidence! };
      details.push(record);
    }
  }
  for (const node of ordered) {
    for (const passage of (passagesByNode.get(node.id) ?? []).sort((a, b) => a.n - b.n)) {
      const record: PassageDetailRecord = {
        id: `passage:${node.id}:${passage.n}`,
        kind: "passage",
        parent: node.id,
        citation: toDetailCitation(passage.citation),
        record: passage.record,
      };
      if (passage.context_before !== undefined) record.context_before = passage.context_before;
      if (passage.context_after !== undefined) record.context_after = passage.context_after;
      details.push(record);
    }
  }
  details.sort((a, b) => byCodePoint(a.id, b.id));

  const levels = kb.nodes.map(node => KIND_LEVEL[node.kind]);
  const manifestWithoutDigest: AdapterResult["manifestWithoutDigest"] = {
    schema: "nousos.review-graph/2",
    generated_at: "1970-01-01T00:00:00Z",
    counts: {
      nodes: kb.nodes.length,
      edges: kb.relations.length,
      details: details.length,
      passages: kb.passages.length,
      nodes_by_kind: countBy(kb.nodes, node => node.kind),
      nodes_by_level: countBy(levels.map(level => String(level)), level => level),
      nodes_by_status: countBy(kb.nodes.filter(node => node.status !== undefined), node => node.status!),
      edges_by_class: countBy(kb.relations, relation => relation.class),
      edges_by_type: countBy(kb.relations, relation => relation.type),
      level_skip: kb.nodes.filter(node => node.level_skip === true).length,
    },
    limits: { children_max: 100, response_max_bytes: 1048576, search_max: 50 },
    generator: kb.generator ?? { name: "kb-to-review-graph", version: "1.0.0" },
  };

  return {
    index: {
      schema: "nousos.review-graph/2",
      nodes: indexNodes,
      edges: indexEdges,
    },
    details,
    manifestWithoutDigest,
  };
}

export type { DetailsOffsets };
