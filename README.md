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

## What NousOS is, and what it is not

**It is** a library and two local transports over a canonical layer of plain
files: identity, provenance, versioning, a rebuildable index, temporal reasoning,
a human-gated candidate layer, and renderer-independent projections of the
resulting graph, with three renderers that draw them.

**It is not** any of the following, and no part of this repository claims to be:

- Not a hosted service, a daemon, or anything that opens a network socket. Both
  transports are local: a command line and a stdio JSON-RPC server.
- Not a chat product, and not an agent. It publishes operations; it does not
  decide when to call them.
- Not a system that writes to your canon. Nineteen operations ship. Sixteen are
  read-only and three record proposals apart from canon. **None of them can
  promote anything into canon** — promotion is a separate human act.
- Not a retrieval breakthrough. `docs/CAP-15-RETRIEVAL.md` reports what was
  actually measured, including where the numbers are poor and where a planned
  comparison could not be run at all. That measurement was taken over a private
  corpus that is **not** in this repository: what ships is the aggregate result
  and opaque cell identifiers, never a document, a title, a path or a quotation
  from it.
- Not a general-purpose graph visualisation library. The visual layer draws this
  project's own projections.

## Your data stays outside this repository

**NousOS never stores your knowledge inside its own source tree, and this
repository has never contained any.** The separation is physical, not merely a
matter of `.gitignore`:

- Every store location is **configuration you supply**. NousOS resolves seven of
  them and **refuses to start if one is missing** rather than guessing a
  default — see the quickstart below for the whole list.
- `fixtures/synthetic/` holds small, wholly invented documents used by the tests.
  They contain no personal material and are safe to read, copy and publish.
- The derived index is rebuildable from the canonical files and is never
  committed; `.gitignore` refuses `*.db`, `*.sqlite` and `*.sqlite3`.
- A test in the suite refuses any absolute machine path, personal identifier or
  credential in tracked file content or names. It runs with `pytest`, like every
  other test here — this repository ships no commit hook and no CI configuration,
  so nothing runs it for you.

If you point NousOS at a private corpus, that corpus stays where you put it. The
only thing this repository holds is the software that reads it.

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
| Visual engine over those projections | present |
| 2D renderer (Sigma, WebGL) | present |
| 3D renderer (Three.js / React Three Fiber), orthographic and perspective | present |
| Controlled comparison of the three renderers | present, `docs/RENDERER-COMPARISON.md` |
| Semantic retrieval, measured and reported honestly | present, opt-in, `docs/CAP-15-RETRIEVAL.md` |
| Vocabulary: the two registers of names, and the map between them | present |
| Command-line and stdio JSON-RPC interfaces | present, `docs/INTEROPERABILITY.md` |

Every operation `core.py` publishes is reachable through two transports: the
`cli.py` command line and the `mcp.py` stdio JSON-RPC server, shaped like the
Model Context Protocol's `initialize` / `tools/list` / `tools/call` trio.
Neither hand-writes its own operation list; both are generated by walking the
same catalogue, so what one surface offers cannot drift from what the other
does by having been typed twice.

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

**Python 3.11 or newer** for the package. It has **no third-party runtime
dependencies**: `import nous_os` works with nothing else installed.
`nous_os.semantic` is the one exception and is opt-in behind the `semantic`
extra, so a clean install stays dependency-free unless a caller asks for dense
retrieval.

**Node.js 24 or newer, with npm**, for `ui/` — the visual engine and the three
renderers, which are about half this repository by file count. The suites there
are developed against Node 24.11 and npm 11.6. The Python package does not
import any of it, and you can ignore `ui/` entirely if you only want the library.

## Run

No installation step is required. From a clone:

```bash
PYTHONPATH=src python3 -m nous_os --version
```

Installing the package works too and nothing here depends on it:

```bash
python3 -m pip install .
```

## Quickstart

**NousOS resolves seven store locations and refuses to start if any is missing.**
It never guesses one, and that refusal is deliberate: a knowledge system that
invents a location writes your data somewhere you did not choose. The shortest
way to a working instance is to point the data root at the public synthetic
corpus and give the other six locations a scratch directory:

```bash
WORKSPACE="$(mktemp -d)"                       # any directory you choose
mkdir -p "$WORKSPACE/snapshots"

export PYTHONPATH=src
export NOUS_OS_DATA_ROOT=fixtures/synthetic/corpus
export NOUS_OS_SNAPSHOT_ROOT="$WORKSPACE/snapshots"
export NOUS_OS_LEDGER_PATH="$WORKSPACE/ledger.jsonl"
export NOUS_OS_DERIVED_PATH="$WORKSPACE/derived.sqlite3"
export NOUS_OS_CANDIDATE_STORE_PATH="$WORKSPACE/candidates.jsonl"
export NOUS_OS_BRIDGE_REGISTRY_PATH="$WORKSPACE/bridges.jsonl"
export NOUS_OS_REJECTION_MEMORY_PATH="$WORKSPACE/rejections.jsonl"

python3 -m nous_os system.capabilities
python3 -m nous_os system.health
```

Every location also has a command-line option (`--data-root`, `--snapshot-root`,
and so on) if you would rather not use the environment. `system.health` reports
each location as `healthy`, `absent` or `unknown` — never as a silent zero.

### The stdio JSON-RPC transport

The same catalogue, over the Model Context Protocol's message shape. A client
launches the module and speaks JSON-RPC on stdin and stdout:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"system.health","arguments":{}}}' \
  | python3 -m nous_os.mcp
```

**Once serving begins, stdout carries nothing but JSON-RPC messages.** Every
other message the server produces goes to stderr.

**Authority is fixed when the process starts and never widens.** The default
grant is read-only, so a `tools/call` naming one of the three proposal
operations is refused with `NotAuthorized` rather than served. Raising it is an
explicit argument (`--tier`) at launch, and no message, argument value or client
identity can change it afterwards. `docs/INTEROPERABILITY.md` describes the
whole contract, including how a client should be configured.

### Portable proposals

`artifact.py` reads and writes a portable proposal artifact: a file a separate
process — including one with no access to your canon — can produce, and which
this system will accept as a *proposal* and never as authority. An artifact that
arrives carrying a claim to authority is refused rather than downgraded.

## Tests

The Python suite runs from a clean clone. `pytest` is required; installing this
package is not.

```bash
python3 -m pip install pytest
npm --prefix ui ci
python3 -m pytest tests/ -q
```

**The `npm --prefix ui ci` step is not optional, and this document used to say it
was.** Five tests in `tests/test_vocabulary.py` check a published document
against the renderer's own resolved values by bundling the TypeScript that
produces them, rather than by reimplementing the arithmetic in Python. Without
`ui/node_modules`, those five **fail** with a stated reason — they do not skip
and they do not pass. Measured from a clean clone: **1243 passed and 5 failed**
without the npm step, **1248 passed** with it.

The TypeScript half has its own checks, run from `ui/`:

```bash
npm --prefix ui run typecheck
npm --prefix ui run test:unit
```

Some tests exist to keep the repository honest rather than to check behaviour:
one refuses any absolute machine path, personal identifier or credential in
tracked file content or names, one proves the data root really is
configuration by running the same operation against two different roots, and
one proves the package imports and works with no external tree present.

### What does not run from a public clone

Some checks depend on things a clone cannot carry. Each of them fails with a
stated reason rather than reporting a pass.

**`npm --prefix ui run test:unit` does not pass from a fresh clone, and this is
expected.** Measured from one: **461 of 477 pass and 16 fail.** All sixteen read
generated evidence under `ui/dist/` — comparison and performance artifacts,
capture manifests — which is run output, is deliberately not committed, and is
produced by the browser suites below. A document generated from an artifact is
checked against that artifact rather than against a copy of its numbers, so
without the artifact the check refuses instead of passing vacuously.

Once that evidence exists, a second dependency applies that a clone still cannot
satisfy: six of the acceptance criteria resolve against human judgement records
held outside this repository, discharged by a person looking at rendered images.
No public substitute for that judgement exists, and inventing one would make six
criteria pass against something nobody judged. **That dependency is recorded
rather than re-measured here** — from a clean clone it cannot be observed at
all, because the missing `ui/dist/` evidence fails the same checks first.

**The browser suites** under `ui/test/browser/` need Playwright browsers
installed and a real GPU adapter, and they are what produce `ui/dist/`. They are
not part of either default run.

**`tests/test_semantic.py`** needs the `semantic` extra
(`pip install .[semantic]`) and the two ONNX checkpoints `semantic.py` names
already present in the local Hugging Face cache. Resolution passes
`local_files_only`, so it never contacts the network and never downloads: a
checkpoint that is not already cached is reported as not-run, with the reason,
rather than fetched. Obtaining weights is a separate, deliberate human act.

## Layout

```
src/
└── nous_os/
    ├── __init__.py       the version surface
    ├── __main__.py       the process entry point, delegating to cli.py
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
    ├── operations.py     registration of the project's governed operations
    ├── core.py           the one application service boundary
    ├── cli.py            the command-line transport, generated from the catalogue
    ├── mcp.py            the stdio JSON-RPC transport, generated from the catalogue
    └── artifact.py       the portable proposal artifact; refused if it carries authority
ui/
├── src/
│   ├── adapter/          projections read into the visual model, meaning kept sealed
│   ├── engine/           renderer-independent visual model, layout, and the axes
│   │                     of presentation: morphology, organization, detail, colour
│   ├── scene/            every material, geometry, label and interaction value,
│   │                     resolved once and handed to whichever renderer draws it
│   ├── render2d/         the Sigma renderer, over WebGL; resolves its own model
│   ├── render3f/         the Three.js / React Three Fiber renderer, orthographic
│   │                     and perspective, over the shared scene model
│   └── comparison/       the controlled analysis across the three renderers
└── test/                 unit, scene, renderer and browser-evidence suites
tests/                    the Python suite described above
benchmarks/               the measuring instrument's own reporting scripts
docs/
├── VOCABULARY.md              the technical and epistemic registers, and the map
│                              between them; checked against the code by the suite
├── INTEROPERABILITY.md        the Core contract and its two transports
├── RENDERER-COMPARISON.md     three renderers over one semantic state
├── CAP-14-COMPARISON.md       the 2D/3D controlled comparison, generated from evidence
├── CAP-15-RETRIEVAL.md        the retrieval measurement, including what did not run
└── cap15-retrieval-artifact.json
                               the artifact that measurement is generated from, so the
                               document can be checked against it rather than trusted
fixtures/
└── synthetic/
    ├── MANIFEST.jsonl    path and content digest per document
    ├── GOLDEN.md         what a correct search must return, and why
    ├── DISCOVERY.md      published candidate-lifecycle and discovery expectations
    ├── corpus/           public, invented test documents
    ├── bilingual/        the same subjects in two languages
    ├── injection/        text that reads as an instruction, for the boundary tests
    └── projection/       fixed graphs the visual layer is measured against
```

The visual layer is deliberately split so that meaning and drawing cannot leak into
each other: `engine/` holds nothing specific to a rendering technology, and a
renderer is handed a much smaller view of the graph than the one it is given —
with what it reads recorded, so that reading too much is detectable rather than
merely discouraged.

## License

MIT. See `LICENSE`.
