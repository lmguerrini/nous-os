"""The data root is configuration, and these tests are what make that checkable.

The central pair is ``test_two_distinct_roots_describe_identically`` and
``test_two_distinct_roots_with_different_content_describe_differently``. Only
the first is the obvious test, and on its own it is a weak oracle: a function
that ignored the root entirely and returned a constant would pass it. The
second is what makes the first mean something.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nous_os.config import (
    ENV_VAR,
    DataRoot,
    DataRootNotADirectory,
    DataRootNotConfigured,
    describe_corpus,
    list_documents,
    resolve_data_root,
)


def _write_corpus(root: Path, body: str) -> None:
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "first.md").write_text(f"# First\n\n{body}\n", encoding="utf-8")
    (root / "second.md").write_text(f"# Second\n\n{body}\n", encoding="utf-8")
    (root / "ignored.txt").write_text("not canonical\n", encoding="utf-8")


# --- resolution order ------------------------------------------------------


def test_an_unconfigured_root_is_refused_rather_than_guessed() -> None:
    with pytest.raises(DataRootNotConfigured):
        resolve_data_root(environ={})


def test_the_environment_variable_supplies_the_root(tmp_path: Path) -> None:
    resolved = resolve_data_root(environ={ENV_VAR: str(tmp_path)})
    assert resolved.path == tmp_path.resolve()


def test_an_explicit_argument_outranks_the_environment(tmp_path: Path) -> None:
    chosen = tmp_path / "chosen"
    other = tmp_path / "other"
    chosen.mkdir()
    other.mkdir()
    resolved = resolve_data_root(chosen, environ={ENV_VAR: str(other)})
    assert resolved.path == chosen.resolve()


def test_a_blank_environment_variable_is_not_a_root() -> None:
    with pytest.raises(DataRootNotConfigured):
        resolve_data_root(environ={ENV_VAR: "   "})


def test_resolve_data_root_honours_the_real_process_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The route an end user actually has: no explicit argument, no injected environ.

    Every other test in this module calls ``resolve_data_root`` with an
    ``environ=`` override, which leaves the real-process-environment branch of
    resolution completely unexercised. There is no ``--data-root`` flag, so
    this environment variable is the only handle an end user has, and this is
    the only test that calls ``resolve_data_root()`` the way an end user does.
    """
    monkeypatch.setenv(ENV_VAR, str(tmp_path))
    resolved = resolve_data_root()
    assert resolved.path == tmp_path.resolve()


def test_a_root_that_is_not_a_directory_is_refused(tmp_path: Path) -> None:
    file_path = tmp_path / "a-file.md"
    file_path.write_text("x\n", encoding="utf-8")
    with pytest.raises(DataRootNotADirectory):
        resolve_data_root(file_path)


def test_a_tilde_root_is_expanded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller who passes ``~/notes`` gets their home directory, not a literal ``~``."""
    monkeypatch.setenv("HOME", str(tmp_path))
    resolved = resolve_data_root("~")
    assert resolved.path == tmp_path.resolve()


def test_no_default_names_a_location(tmp_path: Path) -> None:
    """Resolution consults exactly the sources it documents, and nothing else.

    An environment carrying every plausible corpus variable except this
    project's own must still refuse.
    """
    decoys = {
        "HOME": str(tmp_path),
        "PWD": str(tmp_path),
        "XDG_DATA_HOME": str(tmp_path),
        "NOTES_DIR": str(tmp_path),
        "OBSIDIAN_VAULT": str(tmp_path),
    }
    with pytest.raises(DataRootNotConfigured):
        resolve_data_root(environ=decoys)


# --- A4: the same operation against two distinct roots ---------------------


def test_two_distinct_roots_describe_identically(tmp_path: Path) -> None:
    """Identical corpora at different locations produce identical descriptions.

    This is the property that makes the product reusable by someone whose
    corpus lives somewhere else entirely.
    """
    first = tmp_path / "root-one"
    second = tmp_path / "somewhere" / "else" / "root-two"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    _write_corpus(first, "same body")
    _write_corpus(second, "same body")

    assert first.resolve() != second.resolve()

    one = describe_corpus(resolve_data_root(first))
    two = describe_corpus(resolve_data_root(second, environ={}))

    assert one == two
    assert one == (
        ("notes/first.md", one[0][1]),
        ("second.md", one[1][1]),
    )


def test_two_distinct_roots_with_different_content_describe_differently(
    tmp_path: Path,
) -> None:
    """The counterpart oracle: the description really reads the root it was given.

    Without this, a constant-returning implementation satisfies the test above.
    """
    first = tmp_path / "root-one"
    second = tmp_path / "root-two"
    first.mkdir()
    second.mkdir()
    _write_corpus(first, "one body")
    _write_corpus(second, "a different body")

    one = describe_corpus(resolve_data_root(first))
    two = describe_corpus(resolve_data_root(second))

    assert [path for path, _ in one] == [path for path, _ in two]
    assert [digest for _, digest in one] != [digest for _, digest in two]


def test_listing_is_sorted_and_root_relative(tmp_path: Path) -> None:
    _write_corpus(tmp_path, "body")
    listed = list_documents(DataRoot(tmp_path.resolve()))
    assert listed == ("notes/first.md", "second.md")
    assert not any(str(tmp_path) in entry for entry in listed)


def test_an_uppercase_suffix_is_still_canonical(tmp_path: Path) -> None:
    """The suffix comparison is case-insensitive: a ``.MD`` file is canon too."""
    (tmp_path / "SHOUTED.MD").write_text("# Shouted\n", encoding="utf-8")
    assert list_documents(DataRoot(tmp_path.resolve())) == ("SHOUTED.MD",)


def test_an_empty_root_lists_nothing_and_does_not_raise(tmp_path: Path) -> None:
    """Empty is a real answer, and is not the same answer as unconfigured."""
    assert list_documents(resolve_data_root(tmp_path)) == ()
