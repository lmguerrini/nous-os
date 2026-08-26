"""No machine path, personal identifier or credential in tracked bytes.

This suite scans what the repository would actually ship -- ``git ls-files`` --
rather than the working tree, because an untracked file is not published. It
scans every tracked path, with no allowlist of extensions: content is decoded
as UTF-8 with ``errors="replace"`` and searched regardless of suffix, so a
``.sh``, ``.pem`` or any other non-``.md`` file is covered exactly like a
``.py`` file, and a file that cannot be cleanly decoded is scanned as
replacement-substituted text rather than silently skipped. The tracked file
*names* are scanned too -- see the bottom of this module -- because a personal
identifier in a path is published exactly like one in a file body.

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

ABSOLUTE_PATH_PATTERNS = (
    re.compile(r"/[U]sers/[A-Za-z0-9._-]+"),
    re.compile(r"/[h]ome/[A-Za-z0-9._-]+"),
    re.compile(r"[C]:\\\\?[U]sers\\\\?"),
    re.compile(r"/[V]olumes/[A-Za-z0-9._-]+"),
    re.compile(r"/[p]rivate/(?:tmp|var)/[A-Za-z0-9._-]+"),
    re.compile(r"~/(?:[D]esktop|[D]ocuments|[D]ownloads|[L]ibrary|[P]ictures|[M]usic|[M]ovies)(?:/[A-Za-z0-9._-]+)*"),
    re.compile(r"/[o]pt/[A-Za-z0-9._-]+"),
    re.compile(r"/[s]rv/[A-Za-z0-9._-]+"),
    re.compile(r"/[A]pplications/[A-Za-z0-9._-]+"),
    re.compile(r"/[n]et/[A-Za-z0-9._-]+"),
    re.compile(r"%[U]SERPROFILE%\\[A-Za-z0-9._-]+"),
    re.compile(r"\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+"),
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
    re.compile(r"\bx[o]xb-[A-Za-z0-9-]{10,}"),
    re.compile(r"\b[A]IzaSy[A-Za-z0-9_-]{16,}"),
)

ALL_PATTERNS = ABSOLUTE_PATH_PATTERNS + IDENTIFIER_PATTERNS + CREDENTIAL_PATTERNS

#: Ancestor directory names too short or too common to be evidence of a
#: particular checkout. A component this ordinary is expected to appear in
#: unrelated prose -- an OS mount point, a generic project folder -- and
#: excluding it is what keeps the check's verdict independent of where the
#: repository happens to be checked out (Defect 5).
_GENERIC_ANCESTOR_NAMES = frozenset(
    {
        "users", "home", "volumes", "private", "tmp", "var", "opt", "srv",
        "net", "mnt", "media", "run", "usr", "local", "share", "data",
        "root", "projects", "workspace", "code", "repo", "repos", "src",
        "dev", "work", "checkout", "checkouts", "build", "desktop",
        "documents", "downloads", "applications",
    }
)
_MIN_ANCESTOR_NAME_LENGTH = 5


def _git_ls_files() -> list[str]:
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("requires a git checkout: .git is not present")
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [name for name in listed.split("\0") if name]


def tracked_files() -> list[Path]:
    return [REPO_ROOT / name for name in _git_ls_files()]


def tracked_file_names() -> list[str]:
    return _git_ls_files()


def readable_tracked_files() -> list[Path]:
    """Every tracked file, scanned regardless of extension.

    No suffix allowlist: an extension a future contributor did not think to
    add is not a way to make a leak invisible to this scan. The equality guard
    below proves this filter did not silently exclude a tracked path that is no
    longer a regular readable file.
    """
    return [path for path in tracked_files() if path.is_file()]


def test_every_tracked_path_is_scanned() -> None:
    """A tracked non-file must fail closed rather than vanish from the scan."""
    tracked = set(tracked_files())
    scanned = set(readable_tracked_files())
    not_scanned = sorted(
        path.relative_to(REPO_ROOT).as_posix()
        for path in tracked - scanned
    )
    assert scanned == tracked, (
        "tracked paths were not scanned:\n"
        + "\n".join(not_scanned)
    )


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


def _distinctive_ancestor_names() -> list[str]:
    names = []
    for ancestor in REPO_ROOT.parents:
        name = ancestor.name
        if len(name) < _MIN_ANCESTOR_NAME_LENGTH:
            continue
        if name.lower() in _GENERIC_ANCESTOR_NAMES:
            continue
        names.append(name)
    return names


def test_no_directory_above_the_repository_is_named_in_tracked_bytes() -> None:
    """Any distinctive ancestor of the repository is private to this checkout.

    Matched by whole path component, not by raw substring, and only for
    ancestor names long or specific enough to be evidence of anything. A
    substring match makes the verdict depend on where the repository is
    checked out: on a checkout under a platform's shared temporary directory,
    an ordinary, non-identifying ancestor name would otherwise become
    forbidden everywhere it is mentioned in prose (Defect 5).
    """
    names = _distinctive_ancestor_names()
    if not names:
        return
    wanted = set(names)
    offences = []
    for path in readable_tracked_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        components = set(re.split(r"[\\/]+", text))
        hit = components & wanted
        if hit:
            offences.append(f"{path.relative_to(REPO_ROOT)} names an ancestor directory: {sorted(hit)}")
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


@pytest.mark.parametrize("pattern", ALL_PATTERNS, ids=lambda p: p.pattern[:24])
def test_no_forbidden_shape_in_tracked_file_names(pattern: re.Pattern[str]) -> None:
    """File names are published too (Defect 4): a name is scanned like a body.

    Empty content and a leaking name pass every other check in this module,
    so the name itself needs its own pass over the same patterns.
    """
    offences = [name for name in tracked_file_names() if pattern.search(name)]
    assert not offences, "forbidden shape in a tracked file name:\n" + "\n".join(offences)


def test_the_scanner_detects_what_it_claims_to() -> None:
    """A gate that cannot fail is not a gate.

    Every pattern in every family is shown to match a constructed positive,
    and the number of positives is asserted equal to the number of patterns,
    so a newly added pattern cannot arrive without a control and a pattern
    replaced by an inert regex cannot pass unnoticed (Defect 2).

    The positives are assembled from fragments at run time. Written out as
    literals they would be genuine path- and credential-shaped strings in a
    tracked file, and a fixture that looks like a real secret cannot be told
    apart from one by anything reading blob content -- including the scan
    that guards this repository, which rejected an earlier draft of this test
    for exactly that reason.

    A mutation that replaces a pattern with an inert literal must not look
    "caught" just because that literal then reappears in this file's own
    source: every sample here is built from fragments that do not spell out
    any pattern's source text, so a mutated pattern is judged only against a
    freshly assembled, realistic positive -- never against itself.
    """
    sep = "/"
    bs = chr(92)
    quote = chr(34)
    samples = {
        ABSOLUTE_PATH_PATTERNS[0]: sep + "Users" + sep + "person" + sep + "notes",
        ABSOLUTE_PATH_PATTERNS[1]: sep + "home" + sep + "person" + sep + "notes",
        ABSOLUTE_PATH_PATTERNS[2]: "C:" + bs + "Users" + bs,
        ABSOLUTE_PATH_PATTERNS[3]: sep + "Volumes" + sep + "drive",
        ABSOLUTE_PATH_PATTERNS[4]: sep + "private" + sep + "tmp" + sep + "x",
        ABSOLUTE_PATH_PATTERNS[5]: "~" + sep + "Desktop" + sep + "private-notes",
        ABSOLUTE_PATH_PATTERNS[6]: sep + "opt" + sep + "data",
        ABSOLUTE_PATH_PATTERNS[7]: sep + "srv" + sep + "notes",
        ABSOLUTE_PATH_PATTERNS[8]: sep + "Applications" + sep + "App",
        ABSOLUTE_PATH_PATTERNS[9]: sep + "net" + sep + "fileserver",
        ABSOLUTE_PATH_PATTERNS[10]: "%" + "USERPROFILE" + "%" + bs + "notes",
        ABSOLUTE_PATH_PATTERNS[11]: bs + bs + "NAS" + bs + "share",
        IDENTIFIER_PATTERNS[0]: "person" + "@" + "example.com",
        CREDENTIAL_PATTERNS[0]: "s" + "k-" + "A" * 24,
        CREDENTIAL_PATTERNS[1]: "gh" + "p_" + "B" * 24,
        CREDENTIAL_PATTERNS[2]: "A" + "KIA" + "0" * 16,
        CREDENTIAL_PATTERNS[3]: "-----" + "BEGIN RSA " + "PRI" + "V" + "ATE KEY" + "-----",
        CREDENTIAL_PATTERNS[4]: "api" + "_" + "key" + " = " + quote + "x" * 12 + quote,
        CREDENTIAL_PATTERNS[5]: "x" + "o" + "xb-" + "a" * 20,
        CREDENTIAL_PATTERNS[6]: "A" + "I" + "zaSy" + "x" * 33,
    }
    assert len(samples) == len(ALL_PATTERNS), (
        "every pattern needs exactly one positive control: "
        f"{len(samples)} controls for {len(ALL_PATTERNS)} patterns"
    )
    for pattern, sample in samples.items():
        assert pattern.search(sample), f"pattern {pattern.pattern!r} missed {sample!r}"


# --- the README must describe the repository that exists -------------------
#
# A stale README has now been an audit finding three times. Each was repaired by
# editing the document, which fixes that instance and prevents nothing. The
# document states its own contract -- "this document describes what exists
# rather than what is planned" -- so that contract is checkable, and this is the
# check.


def _readme_layout_entries() -> set[str]:
    """Module filenames named inside the README's layout block."""
    text = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    inside = text.split("```", 2)
    block = next((part for part in inside if "src/" in part and "nous_os/" in part), "")
    return {
        word
        for line in block.splitlines()
        for word in [line.strip().lstrip("├└─│ ").split()[0] if line.strip().lstrip("├└─│ ") else ""]
        if word.endswith(".py")
    }


def test_the_readme_layout_names_every_tracked_module() -> None:
    tracked = {
        path.name
        for path in (REPO_ROOT / "src" / "nous_os").glob("*.py")
        if path.name != "__init__.py" or True
    }
    described = _readme_layout_entries()
    missing = tracked - described
    assert not missing, (
        f"the README's layout omits modules that exist: {sorted(missing)}. "
        "The document claims to describe what exists."
    )


def test_the_readme_layout_names_nothing_that_does_not_exist() -> None:
    tracked = {path.name for path in (REPO_ROOT / "src" / "nous_os").glob("*.py")}
    invented = _readme_layout_entries() - tracked
    assert not invented, f"the README's layout names files that do not exist: {sorted(invented)}"


def test_the_readme_does_not_call_a_shipped_area_unbuilt() -> None:
    """Guard against the specific shape the finding took, three times."""
    text = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    shipped_modules = {path.stem for path in (REPO_ROOT / "src" / "nous_os").glob("*.py")}
    claims = [
        line
        for line in text.splitlines()
        if "not yet built" in line
    ]
    for line in claims:
        lowered = line.lower()
        for module in shipped_modules:
            if module in ("__init__", "__main__", "config"):
                continue
            assert module not in lowered, (
                f"the README says {module!r} is not yet built, but "
                f"src/nous_os/{module}.py is tracked"
            )
