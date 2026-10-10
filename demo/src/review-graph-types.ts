/**
 * Output types of the adapter: the `nousos.review-graph/2` dataset. The index node and
 * edge mirror `ui/src/review/graph-v2.ts` (the client validator); details records are
 * read line by line by `server/graph_drawer.py`; the manifest is what
 * `server/nousos_graph_server.py` re-verifies (digest over the canonical encoding of
 * everything except `digest`).
 */

/** Index node, mirror of `GraphNode` in `ui/src/review/graph-v2.ts`. */
export interface ReviewGraphNode {
  id: string;
  level: 1 | 2 | 3 | 4;
  kind: string;
  subkind?: string;
  status?: string;
  parent: string | null;
  /** Every membership as a node id: the primary parent first, then additional ones; `[]` for roots. */
  parents: string[];
  /** Bare keys of the root domains this node belongs to (root id `domain:k` → `k`), primary first, deduplicated; a root lists only its own key. */
  domains: string[];
  domain_mentions?: string[];
  /** Bare key of the primary domain (`domains[0]`); the approved data carries it on level-3 nodes only. */
  primary_domain?: string;
  primary_domain_anchors?: Record<string, number>;
  title: string;
  display_label?: string;
  title_full: string;
  date?: string;
  origin?: string;
  snippet?: string;
  importance: { value: number; components: Record<string, number> };
  size: number;
  counts: { children: number; descendants: number; canon: number; passages: number; live_proposals?: number };
  /** Set on level-3 nodes attached directly under a level-1 root. */
  level_skip?: boolean;
}

/** Index edge, mirror of `GraphEdge` in `ui/src/review/graph-v2.ts`. */
export interface ReviewGraphEdge {
  id: string;
  source: string;
  target: string;
  class: "attested" | "exploratory";
  type: string;
  directed: boolean;
  evidence: unknown[];
  explanation?: string;
  inference?: string;
  confidence?: string;
  counter_evidence?: unknown[];
  status?: "exploratory/non-canonical";
}

export interface ReviewGraphIndex {
  schema: "nousos.review-graph/2";
  nodes: ReviewGraphNode[];
  edges: ReviewGraphEdge[];
}

/** Citation as it appears inside detail records. */
export interface DetailCitation {
  source_id: string;
  snapshot_digest: string;
  start_byte: number;
  end_byte: number;
  span: string;
  source_date?: string;
  role?: string;
}

/** Details record of a level-4 proposal (drawer: `statement`, `citations`, `record`). */
export interface ProposalDetailRecord {
  id: string;
  kind: "proposal";
  statement: string;
  citations: DetailCitation[];
  record: { date?: string; role?: string };
}

/** Details record of a conversation (drawer: `inventory`). */
export interface ConversationDetailRecord {
  id: string;
  kind: "conversation";
  inventory: { messages: number; provider?: string; conversation?: string };
}

/** Details record of an attachment or non-conversation source (drawer: `file_name`, `owner_conversation`, `spans`, digests). */
export interface SourceDetailRecord {
  id: string;
  kind: "attachment_source" | "non_conversation_source";
  file_name?: string;
  owner_conversation?: string;
  spans: { span: string }[];
  provider?: string;
  source_id?: string;
  snapshot_digest?: string;
  asset_digest?: string;
  asset_id?: string;
}

/** Details record of a level-1/2 aggregate (drawer: `evidence`). */
export interface AggregateDetailRecord {
  id: string;
  kind: "domain" | "project" | "system" | "work";
  evidence: { span: string }[];
}

/** Details record of a level-5 passage (drawer: `citation`, `record`, `context_before`, `context_after`). */
export interface PassageDetailRecord {
  id: string;
  kind: "passage";
  parent: string;
  citation: DetailCitation;
  record: { kind: "message"; role: string; date: string; source_id?: string };
  context_before?: string;
  context_after?: string;
}

export type DetailsRecord =
  | ProposalDetailRecord
  | ConversationDetailRecord
  | SourceDetailRecord
  | AggregateDetailRecord
  | PassageDetailRecord;

/** Byte offset of each details record's line inside `details.jsonl`. */
export type DetailsOffsets = Record<string, number>;

/** Dataset manifest. `digest` = sha256 of the canonical encoding of the manifest without `digest`. */
export interface DatasetManifest {
  schema: "nousos.review-graph/2";
  generated_at: "1970-01-01T00:00:00Z";
  counts: {
    nodes: number;
    edges: number;
    details: number;
    passages: number;
    nodes_by_kind: Record<string, number>;
    nodes_by_level: Record<string, number>;
    nodes_by_status: Record<string, number>;
    edges_by_class: Record<string, number>;
    edges_by_type: Record<string, number>;
    level_skip: number;
  };
  limits: { children_max: 100; response_max_bytes: 1048576; search_max: 50 };
  files: { "index.json": string; "details.jsonl": string; "details-offsets.json": string };
  generator: { name: string; version: string; seed?: number };
  digest: string;
}
