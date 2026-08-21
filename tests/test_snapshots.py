"""Snapshot gates: deduplication, append-only history, and corruption detection."""

from __future__ import annotations

from pathlib import Path

import pytest

from nous_os.snapshots import SNAPSHOT_SUFFIX, SnapshotCorrupt, SnapshotStore


SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"


def test_p9_storing_identical_bytes_twice_keeps_one_snapshot(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)

    first = store.put(SOURCE_ID, b"invented source bytes")
    second = store.put(SOURCE_ID, b"invented source bytes")

    assert first == second
    assert store.digests(SOURCE_ID) == (first.digest,)


def test_p10_changed_bytes_add_a_snapshot_while_the_earlier_one_remains_resolvable(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path)
    earlier = store.put(SOURCE_ID, b"first invented version")
    later = store.put(SOURCE_ID, b"second invented version")

    assert later.digest != earlier.digest
    assert set(store.digests(SOURCE_ID)) == {earlier.digest, later.digest}
    assert store.get(SOURCE_ID, earlier.digest).data == b"first invented version"
    assert store.get(SOURCE_ID, later.digest).data == b"second invented version"


def test_p11_altered_stored_bytes_are_detected_instead_of_being_served(tmp_path: Path) -> None:
    """Content-addressed names make direct disk alteration observable as corruption."""
    store = SnapshotStore(tmp_path)
    snapshot = store.put(SOURCE_ID, b"immutable invented bytes")
    stored_path = tmp_path / SOURCE_ID / f"{snapshot.digest}{SNAPSHOT_SUFFIX}"
    stored_path.write_bytes(b"altered invented bytes")

    with pytest.raises(SnapshotCorrupt):
        store.get(SOURCE_ID, snapshot.digest)
