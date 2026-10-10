/**
 * KB-side interfaces. A KB that wants its review graph rendered by the approved page
 * exposes one {@link KbSnapshot}: a forest of {@link KbNode}s (levels 1–4), the real
 * {@link KbRelation}s between them, and the lazily loaded {@link KbPassage}s (level 5,
 * never part of the index). The adapter in `kb-to-review-graph.ts` is the only code
 * that turns a snapshot into the `nousos.review-graph/2` dataset.
 *
 * Ids are stable strings matching `[A-Za-z0-9_:.-]{1,180}`. Id prefixes that the
 * drawer hard-codes: conversation nodes are `conversation:<x>`, source nodes are
 * `source:<x>` (a citation's `source_id` carries the bare `<x>`, an attachment
 * source's `owner_conversation` carries a conversation id), and a passage of node
 * `<nodeId>` number `<n>` has id `passage:<nodeId>:<n>` — so `<nodeId>` must not end
 * with `:<digits>`.
 */

/** Node kinds and the hierarchy level each occupies. */
export type KbKind =
  | "domain"                    // level 1: roots / knowledge domains
  | "project"                   // level 2: aggregates
  | "system"                    // level 2: aggregates
  | "work"                      // level 2: aggregates
  | "conversation"              // level 3: container
  | "attachment_source"         // level 3: source attached to a conversation
  | "non_conversation_source"   // level 3: any other source
  | "proposal";                 // level 4: statement / record

/** The level each kind occupies; level 5 exists only for passages (lazy, not in the index). */
export const KIND_LEVEL: Record<KbKind, 1 | 2 | 3 | 4> = {
  domain: 1,
  project: 2,
  system: 2,
  work: 2,
  conversation: 3,
  attachment_source: 3,
  non_conversation_source: 3,
  proposal: 4,
};

/** Free-form epistemic status of a statement; the page highlights `canon` and passes others through. */
export type KbStatus = "canon" | "non-canonical/attested" | "proposal" | (string & {});

/** Author role of a message, as the drawer labels it. */
export type KbRole = "user" | "assistant" | "human" | "system";

/**
 * A verifiable citation into a snapshot of a source. `snapshot_digest` is 64 lowercase
 * hex chars; `start_byte`/`end_byte` delimit the cited span inside the snapshot
 * (`0 <= start_byte < end_byte`); `span` is the cited text itself.
 */
export interface KbCitation {
  /** Bare source key (without the `source:` prefix) of a level-3 source node. */
  source_id: string;
  /** sha256 hex (64 chars) of the exact snapshot the span was read from. */
  snapshot_digest: string;
  /** Byte offset of the first byte of the span. */
  start_byte: number;
  /** Byte offset one past the last byte of the span. */
  end_byte: number;
  /** The cited text, verbatim. */
  span: string;
  /** Date the snapshot was taken, `YYYY-MM-DD`, when known. */
  source_date?: string;
  /** Author role of the cited message, when known. */
  role?: KbRole;
}

/**
 * A level-5 passage: a verbatim quote attached to exactly one level-4 node, loaded on
 * demand. Passages live only in `details.jsonl` (ids `passage:<nodeId>:<n>`, `n` from 1);
 * they never appear in the index. The drawer reaches them through the node's children.
 */
export interface KbPassage {
  /** The level-4 node the passage documents. */
  node: string;
  /** 1-based ordinal within the node; determines the passage id. */
  n: number;
  citation: KbCitation;
  /** The message record the passage was taken from. */
  record: { kind: "message"; role: KbRole; date: string; source_id?: string };
  /** Optional verbatim context around the span, shown as `… before … span … after …`. */
  context_before?: string;
  context_after?: string;
}

/**
 * One node of the knowledge base. `parent` forms a forest: exactly one primary parent,
 * roots (`level: 1`) have none, and a parent's level is always lower than the child's.
 * A level-3 node may sit directly under a level-1 root; mark it `level_skip: true`.
 * `parents` lists additional memberships (co-membership is derived by the renderer —
 * never emit it as relations). Drawer content is carried per kind:
 * - `domain`/`project`/`system`/`work`: `evidence` (a verbatim span representing them);
 * - `conversation`: `inventory` (message counts; full text is not exported);
 * - sources: `file_name`, `owner_conversation`, `spans`, provider and digest fields;
 * - `proposal`: `statement`, `citations`, `record`.
 */
export interface KbNode {
  id: string;
  kind: KbKind;
  /** Optional; when present it must equal {@link KIND_LEVEL}[kind]. */
  level?: 1 | 2 | 3 | 4;
  /** Display title; also used as `title_full`. Keep it reasonably short. */
  title: string;
  /** Optional short label (<= 33 chars preferred); becomes `display_label`. */
  short_label?: string;
  /** Primary parent id, or null for level-1 roots. The dataset's `parents` is `[parent, ...parents]`, primary first. */
  parent: string | null;
  /** Additional memberships (any level); must not repeat `parent`. The dataset emits them after the primary parent. */
  parents?: string[];
  /** True when a level-3 node is attached directly under a level-1 root. */
  level_skip?: boolean;
  /**
   * Level-1 node ids (`domain:<key>`) of domains this node belongs to beyond the primary
   * chain. The dataset emits them as the **bare** `<key>`s — the convention the page reads —
   * primary domain (the root of the primary chain) first; a node without `domains` inherits
   * that root's key, and a root lists only its own key.
   */
  domains?: string[];
  /** `YYYY-MM-DD`, when the content is dated. */
  date?: string;
  /** Epistemic status; in practice only level-4 nodes carry one. */
  status?: KbStatus;
  /** Origin marker the drawer understands, e.g. `USER_AUTHORED` for owner-authored content. */
  origin?: "USER_AUTHORED" | "SOURCE_DERIVED" | (string & {});
  /** Drawer content for aggregates: a verbatim span standing for the whole. */
  evidence?: { span: string }[];
  /** Drawer content for conversations. */
  inventory?: { messages: number; provider?: string; conversation?: string };
  /** Drawer content for sources. */
  file_name?: string;
  /** Owning conversation id (bare, without `conversation:`), for attachment sources. */
  owner_conversation?: string;
  /** Verbatim spans kept from this source. */
  spans?: { span: string }[];
  provider?: string;
  source_id?: string;
  snapshot_digest?: string;
  asset_digest?: string;
  asset_id?: string;
  /** Drawer content for proposals: the distilled statement and its verifiable citations. */
  statement?: string;
  citations?: KbCitation[];
  /** Message-level provenance of a proposal. */
  record?: { date?: string; role?: KbRole };
}

export type KbRelationClass = "attested" | "exploratory";

/** Inference kinds of non-canonical relations; an exploratory relation's `type` is its kind. */
export type KbInferenceKind =
  | "analogy"
  | "resonance"
  | "dependency"
  | "continuity"
  | "contradiction"
  | "application"
  | "card";

/**
 * A real relation between two nodes — the only thing that becomes an index edge.
 * Containment, co-membership, aggregation and decorative structure are never relations:
 * the renderer derives them. `attested` relations are backed by verifiable records;
 * `exploratory` ones are non-canonical inferences and must explain themselves.
 */
export interface KbRelation {
  id: string;
  source: string;
  target: string;
  /** Attested types are free (e.g. `mentions`, `classified_in`, `relates`); exploratory types are {@link KbInferenceKind}s. */
  type: string;
  directed: boolean;
  class: KbRelationClass;
  /** Citations backing the relation; empty only for exploratory relations without evidence. */
  evidence: KbCitation[];
  /** Required for `exploratory`: why the inference is made. */
  explanation?: string;
  /** The inference kind; for exploratory relations this equals `type`. */
  inference?: KbInferenceKind;
  /** Free-form confidence label, e.g. `low`/`medium`/`high`. */
  confidence?: string;
  /** Citations that weigh against the inference. */
  counter_evidence?: KbCitation[];
}

/** The whole export from a KB. */
export interface KbSnapshot {
  schema: "nousos.demo-kb/1";
  /** Recorded in the dataset manifest. */
  generator?: { name: string; version: string; seed?: number };
  nodes: KbNode[];
  relations: KbRelation[];
  passages: KbPassage[];
}
