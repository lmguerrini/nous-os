# demo — a synthetic knowledge base for the graph review page

The review page under `ui/review/` draws a `nousos.review-graph/2` dataset: an index of nodes and real relations, detail records loaded
on demand, and a manifest with digests. This folder generates such a dataset from an **invented** knowledge base, so the page can be run,
tested and photographed without anyone's private data. The counts of the `reference` profile are **illustrative**: round figures
with no relation to any real dataset. Only two are fixed, because the page needs them: 11,199 nodes in total (the Completa
calibration is keyed to that count) and exactly nine root domains (the Llull topology). Every title, statement and quotation is built from invented syllables. No real
text, name or identifier enters it.

| File | Role |
|---|---|
| `src/kb-types.ts` | The interfaces a knowledge base implements: `KbSnapshot`, `KbNode`, `KbRelation`, `KbCitation`, `KbPassage`, documented field by field. |
| `src/kb-to-review-graph.ts` | The pure adapter `KbSnapshot → { index, details, manifestWithoutDigest }`: no I/O and no randomness. |
| `src/write-dataset.ts` | Writes `index.json`, `details.jsonl`, `details-offsets.json` and `manifest.json`, with their digests. |
| `src/canonical-json.ts` | Byte-identical to Python's `json.dumps(…, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"`. |
| `src/review-graph-types.ts` | Output types: index nodes and edges, detail records by kind, manifest. |
| `src/synthetic-kb.ts` | Seeded generator of the invented knowledge base. Two profiles: `reference` (illustrative counts; 11,199 nodes, nine root domains) and `small` (600). |
| `src/cli.ts` | The `synth`, `build` and `validate` commands. |
| `test/*.test.ts` | Canonical JSON equals Python's bytes, determinism, one edge per relation, acceptance by the page's own validator, rejections, and a smoke check that the text stays invented. |

**Runtime:** Node.js with `--experimental-strip-types` (Node 24 recommended). No dependencies.

## Commands (from the repository root)

```bash
node --experimental-strip-types demo/src/cli.ts synth --profile reference --seed 1 --out demo/out/reference
node --experimental-strip-types demo/src/cli.ts validate demo/out/reference/dataset
PYTHONPATH=src python3 -m nous_os.graph_review serve --graph demo/out/reference/dataset --port 8766
node --test "demo/test/*.test.ts"
```

The `serve` command expects the page built under `ui/dist/review` (`npm --prefix ui run build:review`). It recomputes the dataset digest
before serving. Then open `http://127.0.0.1:8766/#experimental=fractal`; the flag enables the Geometry Lab topologies.

Generation is deterministic:
- seed 1 of the `reference` profile always produces the manifest digest
  `2979f23ca08fefa34bce303aa4f703f40c8c34ac798600543cc76e90e4a01929`;
- the gallery in `docs/assets/gallery/` is captured from that dataset; no pixel parity with any earlier capture is claimed;
- `fixtures/kb-small.json` is the `small` profile at seed 1, and a test regenerates it byte for byte.

`build --kb <file> --out <dir>` turns any `KbSnapshot` JSON into a dataset. This is how a real knowledge base would be adapted. Real data
belongs outside this repository.

## Mapping a knowledge base onto `kb-types.ts`

| Concept | Field | Rule |
|---|---|---|
| top-level areas | `KbNode` with `kind: "domain"`, `parent: null`, id `domain:<key>` | Level 1. The Llull topology needs **exactly nine**; any other number only disables Llull. |
| aggregates (projects, systems, works) | `kind: "project" \| "system" \| "work"` | Level 2. |
| containers and sources | `kind: "conversation" \| "attachment_source" \| "non_conversation_source"` | Level 3. May sit directly under a root with `level_skip: true`. |
| statements | `kind: "proposal"` | Level 4, with `statement`, `citations`, `record` and `status`. |
| primary hierarchy | `parent` | One primary parent, forming a forest. A parent's level is lower. |
| extra memberships | `parents` | Never emitted as relations: the renderer derives co-membership. |
| relations backed by records | `KbRelation` with `class: "attested"` | `evidence` holds the citations. |
| non-canonical inferences | `class: "exploratory"` | An `explanation` is required, plus an inference type (`analogy`, `resonance`, `dependency`, `continuity`, `contradiction`, `application` or `card`). |
| provenance | `KbCitation` | `source_id`, `snapshot_digest` (64 hex), `start_byte`, `end_byte`, `span`. |
| quotations loaded on demand | `KbPassage` | Level 5, never in the index. |

## What the adapter refuses

**One index node per knowledge-base node and one index edge per relation, nothing else.** Containment, co-membership, aggregation
(Indra pearls, Llull bundles, density aggregates) and decorative guides are drawn by the renderer and never enter the data.

The adapter throws on any of these:
- malformed or duplicate ids;
- a kind at the wrong level;
- unknown parents, a parent whose level is not lower, or a cycle;
- a misplaced `level_skip`;
- a relation with a missing endpoint, a self-loop or an unknown class;
- an exploratory relation without an explanation;
- a non-hex digest;
- passages attached to a node that is not a statement.
