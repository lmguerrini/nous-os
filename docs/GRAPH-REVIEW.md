# Local graph review explorer (D-066)

This explorer is a review projection of the D-065 connection cards and their cited NousOS source spans. It is not canon and does not define a final model. A connection card's tags and A/B/C/D class are provisional review conventions. The export marks each citation that fails byte verification and each record whose context cannot be read.

The classes are **una convenzione provvisoria di revisione (D-065), non un modello epistemico**: A = "dichiarazione esplicita del fondatore"; B = "conseguenza diretta sostenuta dal canone"; C = "interpretazione forte non approvata"; D = "analogia o ipotesi creativa da sottoporre al fondatore".

## Model

| Node | Meaning and epistemic nature |
| --- | --- |
| `domain` | Atlasfield, ATLASvault, Quillmap, Orchardline, NousOS, FORGE, Showcase, Dossier, QRS. All nine are retained. Structural; `link_count` counts cards tagged with the domain. |
| `connection` | D-065 card. Provisional class A/B/C/D with its rationale. |
| `evidence` | Distinct cited span by source ID and byte range. Source fact of record, founder or assistant voice; repeated citations merge into one node. `verified` records byte comparison. |
| `record` | Cited source record, source voice, date, digest, container, and bounded text context. |
| `conversation` | Cited container. Inventory category and authentic project ID; the project name is explicitly inferred. Structural. |
| `candidate` | Distilled proposal, with the package's standing and epistemic label. Canonical status is joined to `canon.assertions` when present. |
| `canon` | Promoted canonical assertion, with its ID and text. |

| Directed edge | Attestation |
| --- | --- |
| connection → domain `links` | `d065-review-tagging`: the package's `linked` field, **not** founder wording. `Showcase / Dossier` expands to both domains. |
| connection → evidence `supported_by` | `d065-card` |
| evidence → record `quotes` | `provenance.span`; exact byte range |
| record → conversation `in_conversation` | `knowledge.context`, when available |
| conversation → domain `classified_in` | `inventory-v1 (project name inferred)`; A maps to Atlasfield and ATLASvault, B to FORGE. Other categories have no domain edge. |
| evidence → candidate `distilled_as` | `d065-card` |
| candidate → canon `promoted_as` | `canon.assertions` |

An edge's `weight` is the count of distinct evidence rows behind it, usually one. It is **not epistemic strength**. Positions and distances are a visual layout, never relations. The nine domain nodes are pinned to an even 2D circle or a 3D Fibonacci sphere in label order. Other nodes use a seeded, 160-iteration force simulation with type-specific minimum distances and a final collision pass. Coordinates remain within `[-1, 1]`, preserving the anchor shape and comparable 3D axes. Parameters are stored in the export. Repeated spans across cards are one evidence node with multiple `supported_by` edges. Candidate versions are retained where the package or canonical assertion gives one. Replaced proposals absent from the package are not shown.

Panel badges distinguish canonical assertions, promoted and other proposals, review cards, cited sources, and structural nodes. Relations carry no canonical badge; their `attested_by` value names the evidence path and the panel explains it in Italian. A card's "Evidenze canoniche collegate" counts its distinct evidence nodes whose candidate has a `promoted_as` link to canon.

## Export and serve

Set `PACKAGE` to the directory containing your review package's JSONL and `INVENTORY` to its inventory; both hold your own material and stay outside this repository. That directory must hold `COLLEGAMENTI-D065.jsonl`, one JSON card per line; `tests/test_graph_review.py` builds a synthetic package and inventory. The export discovers `WORKSPACE.env` next to `PACKAGE`, or accepts `NOUS_OS_GRAPH_WORKSPACE_ENV` to select a different env file. The output must be outside this repository.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m nous_os.graph_review export \
  --package "$PACKAGE" --inventory "$INVENTORY" --out "$TMPDIR/d066/export.json" --context 2
cd ui && npm run build:review && cd ..
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m nous_os.graph_review serve \
  --export "$TMPDIR/d066/export.json" --port 8766 --static ui/dist/review
```

Open `http://127.0.0.1:8766`. The server serves only `/`, `/index.html`, `/review.js`, `/api/export.json`, and `/api/health`. It checks the export digest before binding, rejects query strings, and never opens a NousOS store. The export records SHA-256 inputs, its own content digest (excluding `generated_at`), verification counts, model definitions, and layout parameters. A `.sha256` companion file holds the same digest. Two exports of unchanged inputs have the same digest.

With the server running on any dataset, browser review captures can be produced with `REVIEW_EXPLORER=1 REVIEW_URL=http://127.0.0.1:8766 SHOTS_DIR="$TMPDIR/d066/shots" npx playwright test --project=review-explorer` from `ui/`. `SHOTS_DIR` must be outside the repository. The spec also writes `timings.json` with navigation, view-switch, and 2-second orbit frame counts.

## Read-only boundary and limits

Export uses the product Core with a grant containing only `Tier.READ`, and invokes only `provenance.span`, `knowledge.context`, and `canon.assertions`. It hashes the candidate and canon store generation files without modifying them. Source text appears only in the digest identified file outside the repository and in the loopback response. The browser requests no remote services. Serve reads the export and static bundle only. No route mutates stores, sources, relations, indexes, or canon.

The shared product renderers (`ui/src/render2d`, `render3f`, `engine`, `scene`, `adapter`) lay their product grammar out on a plane (`z = 0` in `engine/layout.ts` and `scene/build.ts`). This separate review renderer uses the export's real 3D coordinates with OrbitControls. Neither projection implies a relation from spatial proximity. Context excerpts are capped at 700 characters per record; missing context remains marked. Only cited records and the D-065 cards appear; this is not an exhaustive NousOS graph.
