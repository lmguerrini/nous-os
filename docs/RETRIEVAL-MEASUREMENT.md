# Retrieval measurement

## Question

The measurement asks whether dense retrieval or a hybrid of dense and lexical retrieval should replace the lexical baseline for finding the target side of cross-language bridges. It compares retrieval rankings over the same eligible bridge directions. The decision is limited to retrieval quality under this method; it does not establish that semantic retrieval is suitable for every corpus or use.

## Arms

- **BASELINE** is the document-level full-text lexical search. The derived store uses SQLite FTS5 with the `unicode61` tokenizer and ranks matches with BM25 (`src/nous_os/derived.py`).
- **BASELINE-ALIAS** applies an explicitly chosen alias mechanism to query terms before lexical matching. Alias expansion is optional and has no implicit default. The alias module exposes a null table, a hand-authored glossary, and aliases derived from aligned pairs (`src/nous_os/aliases.py`).
- **BASELINE-CHUNK-BM25** is the chunk-level lexical control, using Okapi BM25 with fixed `k1 = 1.2` and `b = 0.75` (`benchmarks/chunk_bm25.py`). It helps separate a change in retrieval method from a change in document-versus-chunk granularity.
- **Dense arms** use named local model specifications: DENSE-ML (`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`), DENSE-EN (`sentence-transformers/all-MiniLM-L6-v2`), and DENSE-E5 (`intfloat/multilingual-e5-small`). E5 uses `query: ` and `passage: ` prefixes for queries and indexed text. The code chooses no model by default. Weights are resolved locally; an unavailable model is recorded as not run.
- **Hybrid RRF** combines ranked retrieval lists using reciprocal-rank fusion. The semantic search implementation uses the fixed RRF constant 60 and source-level fusion for the distinct-source route (`src/nous_os/semantic_index.py`).

The report and metric layer consume arm rankings; the repository does not include a private-corpus runner or a private artifact. For your own corpus, the retrieval implementation and any corpus-specific orchestration must produce an artifact with the schema consumed by `benchmarks/metrics.py` and `benchmarks/report.py`.

## Cells and bridges

A bridge identifies the paired source and target material used as a retrieval question. A cell is one directed query for a bridge: direction matters, so the reverse direction is a separate cell when included. A runnable cell identifies the target document and target chunk whose rank is checked. Cells without the required target material are `NOT_RUN` and carry a reason. The metric implementation refuses duplicate bridge-direction keys and refuses to pool multiple named populations into one comparison.

## Metrics and denominator

Only cells marked `RUN` enter retrieval metrics. Every completed arm must provide a rank or an explicit null for every such cell; an absent rank is invalid. The pooled denominator is the number of `RUN` cells. Each language-pair stratum has its own denominator equal to its `RUN` cells.

- **Recall@k** counts cells whose target is ranked at position `k` or higher, divided by the applicable pooled or stratum denominator. A null rank is a miss.
- **MRR@20** sums the reciprocal of each target rank up to rank 20, assigning zero when the target is absent or below the cutoff, then divides by the same cell denominator.
- **Unique recall@k vs BASELINE** counts cells hit by that arm within `k` but not by BASELINE within `k`, divided by the denominator.
- **Lost recall@k vs BASELINE** counts cells hit by BASELINE within `k` but not by that arm within `k`, divided by the denominator.
- **NOT_RUN** cells are excluded from these denominators. A completed arm with no hits has recall zero; an arm or cell that did not run has status and reason, not a zero score.

## Frozen decision rule

The reference is the highest-scoring available lexical arm at Recall@10 among BASELINE, BASELINE-CHUNK-BM25, and BASELINE-ALIAS. The two required lexical arms must have run, and a tie between lexical arms is an error for this rule. Every non-lexical candidate is compared with that best lexical reference.

A candidate meets condition A when its pooled Recall@10 is at least 10 percentage points above the best lexical arm. It meets condition B when its worst language-stratum Recall@10 change is no worse than -2 percentage points. The rule therefore requires both a material pooled gain and protection against a larger loss in any measured stratum. For an arm that did not run, the decision is `NOT_RUN` with its reason; the metrics do not convert that absence to zero.

The recorded outcome vocabulary includes `DENSE_NOT_QUALIFIED`, `HYBRID_NOT_JUSTIFIED`, and `LEXICAL_BASELINE_RETAINED`. These labels describe the decision; the synthetic metric tests exercise the numerical rule and the repository-wide published-claims test guards the stated outcome.

## Determinism checks

The artifact carries a determinism payload digest, and the report renderer produces stable Markdown from an unchanged artifact. The chunk BM25 index orders its stored structure canonically and digests its normalized counts and fixed parameters. Semantic-index tests check repeated builds, input-order independence, fresh-process agreement across hash seeds, and byte-identical ranking behavior. These checks establish repeatability for the tested implementation and inputs; they do not publish or identify any private corpus.

## Running it on your own corpus

Use the retrieval code with your own source material and explicitly selected alias table and model. Keep unavailable arms marked `NOT_RUN` with a reason, and create an artifact containing the `cells`, `arms`, `k_values`, and run-identity fields expected by `benchmarks/metrics.py` and `benchmarks/report.py`. The report generator renders that artifact; it does not ingest or evaluate a corpus by itself. Pass both paths explicitly so generated measurements go to a location you choose:

```bash
python3 benchmarks/report.py path/to/your-artifact.json path/to/output.md
```

## Results

The measurement was run on a private corpus that this repository does not contain. Its figures and corpus characteristics are not published. The recorded decision was to keep the lexical baseline, as stated by the outcome guard in [`tests/test_published_claims.py`](../tests/test_published_claims.py), which defines the reached outcome vocabulary and asserts that tracked Markdown preserves it. The published, reproducible part is the instrument and its synthetic tests in [`tests/test_metrics.py`](../tests/test_metrics.py) and [`tests/test_cap15_report.py`](../tests/test_cap15_report.py).
