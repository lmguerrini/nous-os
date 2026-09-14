"""Rebuild publication keeps a complete derived generation readable."""

from __future__ import annotations

import fcntl
import sqlite3
from datetime import timedelta
from pathlib import Path

import pytest

from nous_os import derived
from nous_os.derived import CanonDivergence, DerivedStoreError, StoreUnusable
from nous_os.ledger import ingest
from nous_os.untrusted import UntrustedText
from test_derived import SOURCE_A, T0, _canon


def _sibling(path: Path) -> Path:
    return path.with_name(path.name + ".rebuild")


def _journal(path: Path) -> Path:
    sibling = _sibling(path)
    return sibling.with_name(sibling.name + "-journal")


def _lock(path: Path) -> Path:
    return path.with_name(path.name + ".rebuild.lock")


def _search_on_open_connection(connection, query: str) -> tuple[derived.SearchHit, ...]:
    rows = connection.execute(
        "SELECT s.snapshot_digest, s.source_id,"
        " substr(c.body, 1, 120), rank"
        " FROM search s JOIN content c ON c.snapshot_digest = s.snapshot_digest"
        "  AND c.source_id = s.source_id"
        " WHERE search MATCH ?"
        " ORDER BY rank, s.snapshot_digest, s.source_id",
        (query,),
    ).fetchall()
    return tuple(
        derived.SearchHit(snapshot_digest=row[0], source_id=row[1], excerpt=row[2])
        for row in rows
    )


def test_rebuild_matches_a_direct_build_and_leaves_no_sibling(tmp_path: Path) -> None:
    """O1: publishing a sibling has exactly direct-build bytes."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    direct = tmp_path / "direct.sqlite3"
    derived.build(store, ledger, path)

    assert derived.rebuild(store, ledger, path) == path
    derived.build(store, ledger, direct)

    assert derived.state_digest(path) == derived.state_digest(direct)
    assert not _sibling(path).exists()
    assert not _journal(path).exists()


def test_rebuild_keeps_the_published_generation_readable_until_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O2: the opened reader stays old while a fresh reader gets the new store."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    sibling = _sibling(path)
    derived.build(store, ledger, path)
    old_inode = path.stat().st_ino
    reader = derived._open_for_reading(path)
    observer = derived._open_for_reading(path)
    old_rows = _search_on_open_connection(observer, "bay")
    ingest(
        store,
        ledger,
        SOURCE_A,
        UntrustedText("The bay has a newly recorded channel."),
        T0 + timedelta(days=20),
    )
    observed: dict[str, tuple[derived.SearchHit, ...]] = {}
    original_canonical_rows = derived._canonical_rows
    original_build = derived.build

    def observe_canonical_rows(*args: object) -> tuple[list, list, list]:
        rows = original_canonical_rows(*args)  # type: ignore[arg-type]
        observed["canonical_reader"] = _search_on_open_connection(observer, "bay")
        observed["canonical_public"] = derived.search(path, "bay")
        return rows

    def observe_completed_sibling(*args: object) -> Path:
        result = original_build(*args)  # type: ignore[arg-type]
        build_path = Path(args[2])
        assert build_path == sibling
        assert build_path.parent == path.parent
        assert build_path.exists()
        observed["sibling_reader"] = _search_on_open_connection(observer, "bay")
        observed["sibling_public"] = derived.search(path, "bay")
        return result

    monkeypatch.setattr(derived, "_canonical_rows", observe_canonical_rows)
    monkeypatch.setattr(derived, "build", observe_completed_sibling)
    try:
        assert derived.rebuild(store, ledger, path) == path
        assert observed == {
            "canonical_reader": old_rows,
            "canonical_public": old_rows,
            "sibling_reader": old_rows,
            "sibling_public": old_rows,
        }
        assert _search_on_open_connection(reader, "bay") == old_rows
        assert path.stat().st_ino != old_inode
        assert derived.search(path, "bay") != old_rows
    finally:
        observer.close()
        reader.close()


@pytest.mark.parametrize("error_type", [CanonDivergence, OSError, KeyboardInterrupt])
def test_rebuild_failure_preserves_the_published_store_and_cleans_the_sibling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error_type: type[BaseException]
) -> None:
    """O3: a build failure preserves old bytes and propagates its own type."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    sibling = _sibling(path)
    journal = _journal(path)
    derived.build(store, ledger, path)
    before = path.read_bytes()
    before_inode = path.stat().st_ino

    def fail_after_creating_partial_sibling(*_args: object) -> tuple[list, list, list]:
        sibling.write_bytes(b"partial rebuild")
        journal.write_bytes(b"partial journal")
        raise error_type("the original build failure")

    monkeypatch.setattr(derived, "_canonical_rows", fail_after_creating_partial_sibling)
    with pytest.raises(error_type) as raised:
        derived.rebuild(store, ledger, path)

    assert type(raised.value) is error_type
    assert path.read_bytes() == before
    assert path.stat().st_ino == before_inode
    assert not sibling.exists()
    assert not journal.exists()


def test_rebuild_keyboard_interrupt_mid_insert_preserves_the_published_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O3: cleanup also holds when an open sibling is interrupted mid-insert."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    sibling = _sibling(path)
    journal = _journal(path)
    derived.build(store, ledger, path)
    before = path.read_bytes()
    before_inode = path.stat().st_ino
    original_connect = derived.sqlite3.connect
    sibling_reader: sqlite3.Connection | None = None

    class InterruptingConnection:
        def __init__(self, connection: sqlite3.Connection) -> None:
            self.connection = connection

        def __getattr__(self, name: str) -> object:
            return getattr(self.connection, name)

        def executemany(self, statement: str, rows: list[tuple]) -> object:
            nonlocal sibling_reader
            if statement.startswith("INSERT INTO content"):
                self.connection.executemany(statement, rows[:1])
                sibling_reader = original_connect(sibling)
                raise KeyboardInterrupt("interrupted during content insert")
            return self.connection.executemany(statement, rows)

    def interrupting_connect(*args: object, **kwargs: object) -> InterruptingConnection:
        return InterruptingConnection(original_connect(*args, **kwargs))

    monkeypatch.setattr(derived.sqlite3, "connect", interrupting_connect)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            derived.rebuild(store, ledger, path)
    finally:
        if sibling_reader is not None:
            sibling_reader.close()

    assert type(raised.value) is KeyboardInterrupt
    assert path.read_bytes() == before
    assert path.stat().st_ino == before_inode
    assert not sibling.exists()
    assert not journal.exists()


def test_rebuild_discards_a_stale_sibling_and_never_publishes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O4: stale work is discarded before a verified generation is published."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    direct = tmp_path / "direct.sqlite3"
    sibling = _sibling(path)
    journal = _journal(path)
    garbage = b"stale rebuild bytes"
    sibling.write_bytes(garbage)

    def fail_publication(source: Path, destination: Path) -> None:
        assert source == sibling
        assert destination == path
        raise OSError("publication interrupted")

    with monkeypatch.context() as publication_patch:
        publication_patch.setattr(derived.os, "replace", fail_publication)
        with pytest.raises(OSError):
            derived.rebuild(store, ledger, path)
    assert not sibling.exists()
    assert not journal.exists()

    assert derived.rebuild(store, ledger, path) == path
    derived.verify(path)
    derived.build(store, ledger, direct)
    assert derived.state_digest(path) == derived.state_digest(direct)
    assert path.read_bytes() != garbage
    assert not sibling.exists()
    assert not journal.exists()


def test_rebuild_refuses_while_another_rebuild_holds_its_lock(tmp_path: Path) -> None:
    """O5: a concurrent rebuild cannot touch an active rebuild's sibling."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    sibling = _sibling(path)
    journal = _journal(path)
    lock = _lock(path)
    derived.build(store, ledger, path)
    before = path.read_bytes()
    before_inode = path.stat().st_ino
    sibling.write_bytes(b"active rebuild sibling")
    journal.write_bytes(b"active rebuild journal")

    with lock.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        with pytest.raises(DerivedStoreError, match="rebuild in progress"):
            derived.rebuild(store, ledger, path)
        assert sibling.read_bytes() == b"active rebuild sibling"
        assert journal.read_bytes() == b"active rebuild journal"
        assert path.read_bytes() == before
        assert path.stat().st_ino == before_inode
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    assert derived.rebuild(store, ledger, path) == path
    assert lock.is_file()
    assert not sibling.exists()
    assert not journal.exists()


def test_rebuild_does_not_publish_a_sibling_that_fails_verification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O3b: verification failure preserves the old generation and cleans up."""
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    sibling = _sibling(path)
    journal = _journal(path)
    derived.build(store, ledger, path)
    before = path.read_bytes()
    calls = 0

    def fail_once(candidate: Path) -> None:
        nonlocal calls
        assert candidate == sibling
        calls += 1
        if calls == 1:
            raise StoreUnusable("the new generation is unusable")

    monkeypatch.setattr(derived, "verify", fail_once)
    with pytest.raises(StoreUnusable) as raised:
        derived.rebuild(store, ledger, path)

    assert type(raised.value) is StoreUnusable
    assert calls == 1
    assert path.read_bytes() == before
    assert not sibling.exists()
    assert not journal.exists()
