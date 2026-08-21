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
| Ingestion, retrieval, interfaces | not yet built |

The command surface is currently `--version`. Operations will arrive with the
work that defines and tests them.

**What the canonical record holds.** A claim, the source it came from, the exact
bytes it quotes, when it was true, and when this system learned it. Identity is
minted independently of content, so correcting a typo does not rename the thing;
the content digest is exactly a function of content, so an edit is detectable.
Support for a claim is a typed class — there is no confidence score anywhere,
because a scalar invites arithmetic over evidence.

## Requirements

Python 3.11 or newer. No third-party runtime dependencies.

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
    └── canonical.py      the assertion record
tests/                    the suite described above
fixtures/
└── synthetic/
    ├── MANIFEST.jsonl    path and content digest per document
    └── corpus/           public, invented test documents
```

## License

MIT. See `LICENSE`.
