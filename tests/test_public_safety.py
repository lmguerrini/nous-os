"""No machine path, personal identifier or credential in tracked bytes.

This suite scans what the repository would actually ship -- ``git ls-files`` --
rather than the working tree, because an untracked file is not published.

**Why the patterns below are written oddly.** A scanner that contains the
literal strings it searches for reports itself. Each needle is therefore
written with a one-character class: the pattern ``/[U]sers/`` matches the real
home-directory prefix on this platform without the file ever containing that
prefix. That is not obfuscation; it is what lets the scanner cover the whole
tracked tree with no exemption list, and an exemption list is how a precise
control quietly becomes a hole.

This suite has already earned its keep once. An earlier draft of this very
docstring spelled the prefix out in an aside claiming the file did not contain
it, and the scan failed the moment the file was staged.

For the same reason no private location is named here. The absolute paths of
this machine are caught by resolving the home directory at run time, and every
other absolute path is caught by shape. Naming a private tree in a public test
would be the exact disclosure the test exists to prevent.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Text files worth scanning. Binary content is checked for presence, not read.
_TEXT_SUFFIXES = {".py", ".md", ".toml", ".json", ".jsonl", ".yaml", ".yml", ".cfg", ".txt", ""}

ABSOLUTE_PATH_PATTERNS = (
    re.compile(r"/[U]sers/[A-Za-z0-9._-]+"),
    re.compile(r"/[h]ome/[A-Za-z0-9._-]+"),
    re.compile(r"[C]:\\\\?[U]sers\\\\?"),
    re.compile(r"/[V]olumes/[A-Za-z0-9._-]+"),
    re.compile(r"/[p]rivate/(?:tmp|var)/[A-Za-z0-9._-]+"),
)

IDENTIFIER_PATTERNS = (
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
)

CREDENTIAL_PATTERNS = (
    re.compile(r"\bs[k]-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bgh[p]_[A-Za-z0-9]{16,}"),
    re.compile(r"\b[A]KIA[0-9A-Z]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRI[V]ATE KEY-----"),
    re.compile(r"\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*['\"][^'\"]{8,}"),
)


def tracked_files() -> list[Path]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [REPO_ROOT / name for name in listed.split("\0") if name]


def readable_tracked_files() -> list[Path]:
    return [
        path
        for path in tracked_files()
        if path.suffix.lower() in _TEXT_SUFFIXES and path.is_file()
    ]


def test_the_repository_actually_tracks_files() -> None:
    """Guard the guard: a scan over nothing passes trivially."""
    files = readable_tracked_files()
    assert len(files) >= 8, f"expected a populated tree, found {len(files)} readable files"


@pytest.mark.parametrize("pattern", ABSOLUTE_PATH_PATTERNS, ids=lambda p: p.pattern[:24])
def test_no_absolute_machine_path_in_tracked_bytes(pattern: re.Pattern[str]) -> None:
    offences = []
    for path in readable_tracked_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in pattern.finditer(text):
            offences.append(f"{path.relative_to(REPO_ROOT)}: {match.group(0)!r}")
    assert not offences, "absolute machine paths in tracked bytes:\n" + "\n".join(offences)


def test_this_machines_home_directory_is_absent_from_tracked_bytes() -> None:
    """Resolved at run time, so no private location is written down here."""
    home = str(Path.home())
    offences = [
        str(path.relative_to(REPO_ROOT))
        for path in readable_tracked_files()
        if home in path.read_text(encoding="utf-8", errors="replace")
    ]
    assert not offences, f"this machine's home directory appears in: {offences}"


def test_no_directory_above_the_repository_is_named_in_tracked_bytes() -> None:
    """Any ancestor of the repository is a location private to this checkout."""
    offences = []
    for ancestor in REPO_ROOT.parents:
        name = str(ancestor)
        if name in ("/", ""):
            continue
        for path in readable_tracked_files():
            if name in path.read_text(encoding="utf-8", errors="replace"):
                offences.append(f"{path.relative_to(REPO_ROOT)} names an ancestor directory")
    assert not offences, "\n".join(sorted(set(offences)))


@pytest.mark.parametrize("pattern", IDENTIFIER_PATTERNS, ids=lambda p: "email")
def test_no_personal_identifier_in_tracked_bytes(pattern: re.Pattern[str]) -> None:
    offences = []
    for path in readable_tracked_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in pattern.finditer(text):
            offences.append(f"{path.relative_to(REPO_ROOT)}: {match.group(0)!r}")
    assert not offences, "personal identifiers in tracked bytes:\n" + "\n".join(offences)


@pytest.mark.parametrize("pattern", CREDENTIAL_PATTERNS, ids=lambda p: p.pattern[:20])
def test_no_credential_material_in_tracked_bytes(pattern: re.Pattern[str]) -> None:
    offences = []
    for path in readable_tracked_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in pattern.finditer(text):
            offences.append(f"{path.relative_to(REPO_ROOT)}: {match.group(0)[:24]!r}")
    assert not offences, "credential-shaped material in tracked bytes:\n" + "\n".join(offences)


def test_the_scanner_detects_what_it_claims_to(tmp_path: Path) -> None:
    """A gate that cannot fail is not a gate.

    Each family is shown to match a constructed positive, so a future edit that
    breaks a pattern fails here rather than passing an empty scan.

    The positives are assembled from fragments at run time. Written out as
    literals they would be genuine path- and credential-shaped strings in a
    tracked file, and a fixture that looks like a real secret cannot be told
    apart from one by anything reading blob content -- including the scan that
    guards this repository, which rejected an earlier draft of this test for
    exactly that reason.
    """
    sep = "/"
    samples = {
        ABSOLUTE_PATH_PATTERNS[0]: sep + "Users" + sep + "person" + sep + "notes",
        ABSOLUTE_PATH_PATTERNS[1]: sep + "home" + sep + "person" + sep + "notes",
        IDENTIFIER_PATTERNS[0]: "person" + "@" + "example.com",
        CREDENTIAL_PATTERNS[0]: "s" + "k-" + "A" * 24,
        CREDENTIAL_PATTERNS[4]: "api" + "_" + "key" + " = " + chr(34) + "x" * 12 + chr(34),
    }
    for pattern, sample in samples.items():
        assert pattern.search(sample), f"pattern {pattern.pattern!r} missed {sample!r}"
