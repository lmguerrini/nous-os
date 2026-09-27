# D-067 review graph

The page is a read-only review projection over the D-066 export. It does not promote D-065 cards to canon or define an epistemology. The export format, digest and verified source spans remain unchanged. Spatial proximity is never an epistemic relation; only typed, attested edges support navigation.

## Four independent axes

| Axis | Options | Changes |
| --- | --- | --- |
| Proiezione | 2D, 3D ortografico, 3D prospettico, Focus 3D | Camera and framing. Focus 3D requires a selection. |
| Morfologia | Stellar, Neural, Mycelium | The product engine's rendering grammar; graph identities and relations stay fixed. |
| Organizzazione | Flat, Indra | Layout and conversation membership windows, not a lens or a new relation. |
| Lente | Registered reading mode and lenses from a sidecar | This export feeds no registered lens. The selector explains availability and never changes the graph. |

Black and white is the default. Optional semantic colour indicates standing; it does not encode the D-065 evidence classes. The main renderer groups seven export types into three readable families: **Aggregati** (domains and conversations, larger halo), **Concetti** (cards, proposals, canon, intermediate size), and **Fonti** (verified spans and records, smaller and quieter). The panel legend documents family size, halo, brightness, meaning and the attested relation line. The advanced **Provenienza/Debug** mode mounts the D-066 views and exposes their seven type shapes, standing colours and class codes as a technical view.

**Stato dell'evidenza** is a provisional D-065 review convention: A, explicit founder statement; B, direct consequence supported by canon; C, strong unapproved interpretation; D, analogy or creative hypothesis. These are not epistemic modes or lenses. Their filter and rationale are in Avanzate; the main view shows no class letter or class colour. The panel uses `standingOf` to distinguish canon, proposal, review card, source and structure in plain Italian.

## Focus and navigation

Selecting a node or relation follows actual visible edges. The first level is selected plus one hop, or a relation's endpoints plus one hop. The product view brightens that set, dims the rest and frames it within the canvas. **Espandi** adds one level with a 60-node cap; **Indietro** pops one focus frame; **Reimposta** clears selection and emphasis and fits. Search takes the same path. Axis changes preserve the focus stack. The right panel is outside the canvas and moves below it under 1100 px. The renderer receives the canvas alone and explicit zero insets because there are no canvas overlays.

The proposed viewer target is `NavigationTarget = {level: "passage"|"work"|"constellation", id, parent_id?, snapshot_digest, source_edge_ids[]}`. Each level reports `{available, reason, targets}`. The panel breadcrumb links only targets backed by export edges:

- **Passaggio**: an `evidence` span and its `record` context through `quotes`, with verified bytes, voice, date, byte range and digest. This is a NousOS review passage, not a public `Passage`.
- **Opera**: unavailable as a Work. Conversations are dialogue containers with inventory category and inferred project name, without Work, Edition or Manifestation identity. A separate **Conversazione (contenitore, non un'opera)** link follows `record → in_conversation → conversation`.
- **Costellazione**: available only as **Gruppo di revisione, non una costellazione epistemica**. It follows `conversation → classified_in → domain` or `card → links → domain`. The attestations are inventory or D-065 tagging, not an epistemic correspondence.

Indra windows use `in_conversation` membership. Each cited record belongs to one conversation container, so these windows are disjoint by construction. Domains can overlap through several cards and conversations; they are not Indra windows. Flat perspective uses deterministic depth from the engine layout; Indra remains planar. A 3D projection therefore does not imply a new semantic layer.

## Lens sidecar

`serve --lenses <path>` optionally loads a JSON sidecar once at startup. It requires `schema: "nousos-review-lenses-1"` and serves `/api/lenses.json` from memory. Without it, the route returns JSON 404 and the page says **Registro delle lenti non fornito**. The sidecar carries `reading_mode`, `other_modes`, `lenses`, `planned`, `not_lenses`, `sources` and `notice`. The page validates their shape, displays the active reading mode as predefinita, and explains why other modes or lenses cannot be selected. Planned entries have no fabricated IDs. No private lens snapshot text is in this repository.

## Export, serve and checks

Set `PACKAGE` to your review package and `INVENTORY` to its inventory; both hold your own material and stay outside this repository. The package directory must hold `COLLEGAMENTI-D065.jsonl`, one JSON card per line, and the inventory is JSON Lines as well; `tests/test_graph_review.py` builds a synthetic package and inventory. The export discovers `WORKSPACE.env` next to `PACKAGE`, or accepts `NOUS_OS_GRAPH_WORKSPACE_ENV`. Write the output outside this repository.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m nous_os.graph_review export \
  --package "$PACKAGE" --inventory "$INVENTORY" --out "$TMPDIR/d067/export.json" --context 2
npm --prefix ui run build:review
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m nous_os.graph_review serve \
  --export "$TMPDIR/d067/export.json" --lenses "$TMPDIR/d067/lenses.json" \
  --port 8766 --static ui/dist/review
```

Omit `--lenses` when no approved sidecar exists. The loopback server serves only `/`, `/index.html`, `/review.js`, `/api/export.json`, `/api/lenses.json` and `/api/health`; it rejects query strings and checks the export digest before binding. The `.sha256` file written next to an export holds that content digest (canonical JSON without `generated_at` and `export_digest`), not a hash of the file bytes, which change with `generated_at` on every regeneration. The export uses only read grants (`provenance.span`, `knowledge.context`, `canon.assertions`), and source text stays in your export and the loopback response. The server opens no NousOS store.

With the server running on any dataset, you can run `D067_VIEWER=1 REVIEW_URL=http://127.0.0.1:8766 SHOTS_DIR="$TMPDIR/d067/shots" npx playwright test --project=review-d067` from `ui/`. The suite refuses a repository-local shot directory, writes sixteen states with witnesses and pixel metrics to `SHOTS_DIR`, and checks label collision, focus framing, colour and visual differences. The old D-066 browser spec is superseded. Its export and unit tests remain as substrate checks.
