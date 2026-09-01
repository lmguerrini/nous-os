# NousOS

A local-first knowledge system whose canonical layer is plain files.

NousOS is being built in the open, one bounded piece at a time. This repository
holds the product only. It is early: the surface below is small on purpose, and
this document describes what exists rather than what is planned.

## Principles

These are constraints the code is tested against, not aspirations.

- **Canon is files.** Every database NousOS builds is reconstructible from the
  canonical file layer alone. Deleting the derived store loses nothing.
- **The data root is configuration.** No machine path and no personal
  identifier appears in product code. NousOS reads the corpus you point it at,
  and it has no opinion about where that is.
- **Unknown is a third answer.** A check that did not run is never recorded as
  one that passed, and an absent measurement is never reported as zero.
- **Nothing becomes canonical because a machine produced it.** Generated
  material lands in a candidate layer and is promoted only by a person.
- **The names are part of the product.** What each concept is called, and which
  concepts have earned a name from the vocabulary of knowledge rather than of
  software, is written down in `docs/VOCABULARY.md` and checked against the code by
  the test suite.
- **No complexity without evidence.** A new mechanism needs a named failure
  mode, a reproducible test, and an observed win before it earns a place.

## Status

| Area | State |
|---|---|
| Package skeleton and version surface | present |
| Data-root resolution from configuration | present |
| Public synthetic fixtures | present |
| Canonical record: identity, content hashing, provenance | present |
| Immutable source snapshots | present |
| Ingestion: append-only ledger, versioning, invalidation | present |
| Derived index, rebuildable from the files alone | present |
| Measuring instrument and cross-language baseline | present |
| Context compilation, with a measured default | present |
| Authority boundary for governed operations | present |
| Renderer-independent projections of the graph | present |
| Visual engine and a 2D renderer over those projections | present |
| Vocabulary: the two registers of names, and the map between them | present |
| Command-line and other interfaces | not yet built |

The command surface is currently `--version`. Operations will arrive with the
work that defines and tests them.

**What ingestion guarantees.** Taking a source in twice changes nothing the
second time, and a version is recorded only when the bytes actually differ. The
history of a source is a plain append-only file, so recovering it means reading
it. Content that arrives from a source is held in its own type that cannot stand
in for text this project wrote — text that reads as an instruction is labelled
and still stored, because refusing it would quietly lose part of your corpus.

**How context is assembled.** A pack is built from a ranking, and every pack
records what went into it — reproducibly, so the same inputs always yield the
same record. Which assembly strategy is the default was decided by measurement
rather than by preference: of six families, five were measured and none beat the
plain one, so the plain one stayed. The sixth could not be measured at all on
that corpus and is recorded as
unmeasured rather than as a tie, because those are different facts. Two numbers are always reported apart — whether both documents
of a pair made it in, and whether the specific passages that ground the claim
made it in — because reading the first as evidence about the second is a mistake
that has already been made once here, and it took real work to notice.

**How results are measured.** The instrument is built before the things it
judges, so it cannot be shaped by the answers it later reports. Expected results
are written down from reading the documents, never recorded from a run — a
golden file regenerated from the code it constrains cannot fail. Every
measurement carries a third answer: a check that could not run says so, and
never reports a pass. Relating terms across languages is a pluggable layer with
no default, because the fixed hand-written table is *measured* insufficient and
its proposed replacement is unmeasured, and preferring an unmeasured design to a
measured-poor one is still a guess.

**What the index guarantees.** It is built from the files and holds nothing they
do not already say, so deleting it loses nothing: rebuilding produces the same
bytes, not merely the same answers. If it could differ between rebuilds, then
something in it came from somewhere other than your files, and nobody would know
what. A rebuild refuses rather than quietly indexing around a gap.

**What the canonical record holds.** A claim, the source it came from, the exact
bytes it quotes, when it was true, and when this system learned it. Identity is
minted independently of content, so correcting a typo does not rename the thing;
the content digest is exactly a function of content, so an edit is detectable.
Support for a claim is a typed class — there is no confidence score anywhere,
because a scalar invites arithmetic over evidence.

## Requirements

Python 3.11 or newer. The package itself has **no third-party runtime dependencies**:
`import nous_os` works with nothing else installed. `nous_os.semantic` is the one
exception and is opt-in behind the `semantic` extra, so a clean install stays
dependency-free unless a caller asks for dense retrieval.

## Run

No installation step is required. From a clone:

```bash
PYTHONPATH=src python3 -m nous_os --version
```

Installing the package works too and nothing here depends on it:

```bash
python3 -m pip install .
```

## Tests

Installing this package is not required to run the suite; `pytest` is. The
suite runs from a clean clone with no machine-specific setup:

```bash
python3 -m pip install pytest
python3 -m pytest tests/ -q
```

Some tests exist to keep the repository honest rather than to check behaviour:
one refuses any absolute machine path, personal identifier or credential in
tracked file content or names, one proves the data root really is
configuration by running the same operation against two different roots, and
one proves the package imports and works with no external tree present.

`tests/test_semantic.py` is the one exception to "no machine-specific setup":
it needs the `semantic` extra (`pip install .[semantic]`) and the two ONNX
checkpoints `semantic.py` names already present in the local Hugging Face
cache. Resolution passes `local_files_only`, so it never contacts the network
and never downloads: a checkpoint that is not already cached is reported as
not-run, with the reason, rather than fetched. Obtaining weights is a separate,
deliberate human act.

## Fixtures

`fixtures/synthetic/` holds small, wholly invented documents used by the tests.
They contain no personal material and are safe to read, copy and publish. Any
private corpus stays outside this repository and is never committed.

## Layout

```
src/
└── nous_os/
    ├── __init__.py       the version surface
    ├── __main__.py       the command surface
    ├── config.py         data-root resolution
    ├── identity.py       stable ids and content hashing
    ├── snapshots.py      immutable, content-addressed source snapshots
    ├── provenance.py     citations, byte-range locators, quote-lint
    ├── canonical.py      the assertion record
    ├── untrusted.py      the boundary around content from outside
    ├── ledger.py         append-only ingest record and version chains
    ├── derived.py        the rebuildable index over everything above
    ├── aliases.py        interchangeable ways of relating terms across languages
    ├── measure.py        the measuring instrument, and its third answer
    ├── chunking.py       pieces of a document that remember where they came from
    ├── semantic.py       a derived, offline dense index over chunks, and its third answer
    ├── compile.py        assembling a pack, and recording what went into it
    ├── ablation.py       comparing assembly strategies without combining the numbers
    ├── capability.py     four kinds of authority, and the one door they are checked at
    ├── candidates.py     append-only proposals that are explicitly not canon
    ├── temporal.py       two time axes, supersession, and disagreement kept visible
    ├── attribution.py    a claim key that carries where it came from
    ├── adjudication.py   the human-gated boundary between a proposal and canon
    ├── discovery.py      bridge candidates, gates, and append-only rounds
    ├── projection.py     renderer-independent knowledge graph projections
    └── operations.py     registration of the project's governed operations
ui/
└── src/
    ├── adapter/          projections read into the visual model, meaning kept sealed
    ├── engine/           renderer-independent visual model, layout, and the axes
    │                     of presentation: morphology, organization, detail, colour
    └── render2d/         the 2D renderer that ships today, and only it knows WebGL
tests/                    the suite described above
docs/
└── VOCABULARY.md         the technical and epistemic registers, and the map between
                          them; checked against the code by the suite
fixtures/
└── synthetic/
    ├── MANIFEST.jsonl    path and content digest per document
    ├── GOLDEN.md         what a correct search must return, and why
    ├── DISCOVERY.md      published candidate-lifecycle and discovery expectations
    ├── corpus/           public, invented test documents
    └── bilingual/        the same subjects in two languages
```

The visual layer is deliberately split so that meaning and drawing cannot leak into
each other: `engine/` holds nothing specific to a rendering technology, and the
renderer is handed a much smaller view of the graph than the one it is given —
with what it reads recorded, so that reading too much is detectable rather than
merely discouraged.

## License

MIT. See `LICENSE`.
