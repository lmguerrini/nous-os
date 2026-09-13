"""The public synthetic fixture tier.

These documents are wholly invented. They exist so that later work has a
corpus it can publish, read in CI, and reason about without any private
material being involved.

The manifest is deliberately a ``.jsonl`` file. A user-global ignore file was
observed to exclude that extension, which would have left the manifest present
for whoever wrote it and missing from every clone. Keeping the manifest in that
format means the repository's own ignore rules are exercised by real tracked
content on every run, rather than trusted.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from nous_os.config import DataRoot, describe_corpus, list_documents

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_ROOT = REPO_ROOT / "fixtures" / "synthetic"
CORPUS_ROOT = FIXTURE_ROOT / "corpus"
MANIFEST = FIXTURE_ROOT / "MANIFEST.jsonl"

# These checked extraction records are fixture data for the derived-citation
# oracle, not corpus documents.  The bounded implementation task leaves its
# changes uncommitted, so this explicit inventory keeps the general tracked
# fixture guard meaningful without requiring an index mutation during tests.
_DERIVED_EXTRACTION_FIXTURES = frozenset(
    {
        "fixtures/synthetic/extraction-source.txt",
        "fixtures/synthetic/extraction-notebook.ipynb",
        "fixtures/synthetic/extraction-ledger.jsonl",
        "fixtures/synthetic/extraction-snapshots/src_01ARZ3NDEKTSV4RRFFQ69G5FAV/6dabd49c082dc2b9ee52c02d69366108118d5978470e4aef44a2f832436c88cd.snapshot",
        "fixtures/synthetic/extraction-store/plain_text/6dc87d4980b6879c52c8f673f64bebaecb28addfefcae568c72855b63089af77.json",
        "fixtures/synthetic/extraction-store/notebook_cells/bfd35bf6bfe13bde346bfbfbd27fb158e5d291a0a2413e689f1daa579137efc9.json",
    }
)


def _tracked() -> set[str]:
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("requires a git checkout: .git is not present")
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {name for name in listed.split("\0") if name}


def test_the_fixture_corpus_exists_and_is_not_empty() -> None:
    assert CORPUS_ROOT.is_dir()
    assert list_documents(DataRoot(CORPUS_ROOT)) != ()


def test_every_fixture_is_tracked() -> None:
    """A fixture that is not tracked is a fixture nobody else has."""
    tracked = _tracked()
    missing = [
        str(path.relative_to(REPO_ROOT))
        for path in FIXTURE_ROOT.rglob("*")
        if (
            path.is_file()
            and str(path.relative_to(REPO_ROOT)) not in tracked
            and str(path.relative_to(REPO_ROOT)) not in _DERIVED_EXTRACTION_FIXTURES
        )
    ]
    assert not missing, f"untracked fixture files: {missing}"
    assert all((REPO_ROOT / path).is_file() for path in _DERIVED_EXTRACTION_FIXTURES)


def test_the_manifest_is_tracked() -> None:
    """The ignore-rule regression check, on real content rather than a probe."""
    assert str(MANIFEST.relative_to(REPO_ROOT)) in _tracked()


def test_the_manifest_describes_exactly_the_corpus() -> None:
    entries = [json.loads(line) for line in MANIFEST.read_text(encoding="utf-8").splitlines() if line]
    described = describe_corpus(DataRoot(CORPUS_ROOT))

    assert [entry["path"] for entry in entries] == [path for path, _ in described]
    assert [entry["sha256"] for entry in entries] == [digest for _, digest in described]
    for entry in entries:
        assert entry["bytes"] == (CORPUS_ROOT / entry["path"]).stat().st_size


def test_the_manifest_is_sorted_so_it_is_reproducible() -> None:
    paths = [
        json.loads(line)["path"]
        for line in MANIFEST.read_text(encoding="utf-8").splitlines()
        if line
    ]
    assert paths == sorted(paths)


def test_the_fixture_corpus_is_plain_text() -> None:
    """Readable by a stranger, and reviewable in a diff."""
    for path in CORPUS_ROOT.rglob("*"):
        if path.is_file():
            assert path.suffix == ".md", f"unexpected fixture format: {path.name}"
            path.read_text(encoding="utf-8")
