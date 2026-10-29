# Candidate search

`candidate.search` is a READ operation for bounded retrieval of recorded candidate proposals. It is available through the Core catalogue, CLI, and stdio MCP server. It does not promote proposals. A hit is marked canonical only when the verified canon reader has a promoted assertion with the same candidate id **and** content version.

Configure `NOUS_OS_CANDIDATE_STORE_PATH` and `NOUS_OS_CANDIDATE_REPLACEMENTS_PATH`. The replacement manifest is a read-only JSONL file with `old` and `new` proposal ids on each row. It is maintained by the review process; search never writes it. Set `NOUS_OS_CANON_ROOT_PATH` to enable the exact promoted-assertion join. `ranking="source_semantic"` also needs an existing semantic index. No search request rebuilds that dense index.

The request takes `query` (required), `limit` (1–20, default 10), an opaque `cursor`, `include_replaced` (default false), and `ranking` (`text`, `text_relevance`, or `source_semantic`). Queries contain plain words and double-quoted phrases; an unmatched double quote is ignored as punctuation. Every term is escaped as a literal FTS phrase, so supplied operators do not change query syntax. Queries with more than 16 terms (words or quoted phrases) use each distinct unquoted token as an alternative, while quoted phrases remain phrases; the 256-character query limit still applies. The default `text` ranking first selects the initial 100 matches by BM25 score, then candidate id and version. Within that slice only, promoted canonical standing, recorded decisions stated by a person, then other standing break equal-score ties; candidate id and version break remaining ties. Standing does not promote candidates from outside that BM25/id-selected slice. `text_relevance` gives the plain BM25 relevance order. BM25 covers statements, cited spans, content scope, and bounded `scope:` note tags. Cited spans are decoded from JSON and normalized before indexing. Semantic ranking uses the rank of cited **sources**, not similarity to candidate statements; each such hit states `semantic_basis: "cited_source_rank"`.

`epistemic_label` describes the record's standing or subject, not an independent approval:

| Label | Meaning |
| --- | --- |
| `CANONICAL` | The exact candidate id and content version has a promoted canonical assertion. |
| `DECISION_STATED_BY_PERSON` | A decision recorded as stated by the person. This is a recorded statement, not an approval or a promotion. |
| `PROPOSAL_NOT_APPROVED` | A proposal or assistant suggestion with no recorded approval. |
| `HYPOTHESIS` | An open question or hypothesis. |
| `INTERPRETATION` | An interpretation of source material. |
| `HISTORICAL_DESCRIPTION` | A description of past events or state. |
| `IMPLEMENTATION_STATE_AT_DATE` | A description of implementation state at a particular date. |
| `NOT_YET_CLASSIFIED` | No recognized, unambiguous classification is available. |

Only `epistemic_label: "CANONICAL"`, `canonical_status: "canonical"`, and `is_asserted: true` signify a promoted decision. These three fields reflect the same verified canon join; `DECISION_STATED_BY_PERSON` alone never signifies promotion.

The response includes `store_generation`, `total_matched`, `replaced_excluded`, `replaced_unreadable`, `hits`, and `next_cursor`. `replaced_excluded` counts readable replaced versions matching this query but omitted when `include_replaced=false` (zero when true). `replaced_unreadable` counts replaced versions in the store refused by proposal or review validation and omitted regardless of `include_replaced`; they cannot be returned even when it is true. A refused version is omitted only when its valid proposal id is a manifest `old` or a `supersedes` target. A refused live version makes the whole request fail with `CandidateStoreUnreadable`. Each hit includes the proposal content, citations, exact canon standing, a conservative epistemic label, and replacement status. Non-canonical hits say “Recorded candidate proposal” and have `is_asserted: false`. Canonical hits say “Promoted canonical assertion” and have `is_asserted: true`. A cursor becomes stale when the proposal store, manifest, request, or canon join changes.

Missing, unreadable, or inconsistent stores fail with explicit error codes rather than an empty page. The index is in memory, cached by proposal-file identity and metadata, and built with a deadline. Search has a separate deadline and returns no partial page. A dense backend still running after its deadline causes `SearchTimeout`; another dense request receives `SearchTimeout` until that worker exits. Logs contain only operation metadata, counts, duration, and error code.
