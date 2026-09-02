"""An unreadable location is a third answer, and every reader here must give it.

Absent and unreadable are different facts. "This history has never been
written" and "this history exists but cannot currently be read" both used to
report the same empty tuple, the same ``False``, or the same shorter listing,
which told a caller the wrong one of the two whenever a containing directory
lost its permissions rather than its content. Every case below writes a real
record, denies read access to a real directory with ``chmod 000``, and asserts
that the reader raises instead of reporting the denial as absence -- then
asserts, separately, that a location that is genuinely absent still returns
exactly what it returns today.

Every ``chmod`` is undone in a ``finally``, so a test that fails partway
through cannot leave an unreadable directory sitting in a temporary tree.
Skipped entirely under root, where ``chmod 000`` denies nothing: a test that
cannot fail in the environment it runs in is a decoration.
"""

from __future__ import annotations

import contextlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest

from nous_os import config, derived
from nous_os.derived import DerivedStoreError
from nous_os.adjudication import AgentMemory, RejectionMemory
from nous_os.candidates import CandidateStore
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    Endpoint,
)
from nous_os.ledger import Ledger, ingest
from nous_os.provenance import Citation, Locator
from nous_os.snapshots import SnapshotNotFound, SnapshotStore
from nous_os.untrusted import UntrustedText

pytestmark = pytest.mark.skipif(
    os.geteuid() == 0, reason="chmod 000 does not deny access to root"
)

SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
WHEN = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)


@contextlib.contextmanager
def _unreadable(directory: Path) -> Iterator[None]:
    """Deny read access to ``directory`` for the body of the block, then restore it."""
    os.chmod(directory, 0o000)
    try:
        yield
    finally:
        os.chmod(directory, 0o700)


def _card(cluster_id: str) -> BridgeCard:
    """The smallest complete, accepted card -- content is irrelevant to a read-back test."""
    citation = Citation(SOURCE_ID, "a" * 64, Locator(0, len(b"quoted words")), "quoted words")
    endpoint = Endpoint(project="project-a", citation=citation, quote="quoted words")
    return BridgeCard(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        cluster_id=cluster_id,
        left=endpoint,
        right=endpoint,
        epistemic_class=EpistemicClass.DERIVED,
        depth=Depth.DEEP,
        non_triviality="The mechanism crosses implementation boundaries.",
        consequence="Project-b can falsify this by running the named integration.",
        noise_objection="The shared vocabulary may be coincidental.",
        gates=GateVector(outcomes={gate: GateOutcome.PASS for gate in Gate}, reasons={}),
        origin_round=1,
    )


def test_candidatestore_proposals_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    path = store_dir / "candidates.jsonl"
    CandidateStore(path).record(
        source_id=SOURCE_ID, content=UntrustedText("x"), proposed_at=WHEN, holder="h"
    )
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            CandidateStore(path).proposals()
    assert CandidateStore(tmp_path / "never-written.jsonl").proposals() == ()


def test_rejectionmemory_rejections_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    path = store_dir / "rejections.jsonl"
    RejectionMemory(path).record(
        cluster_id="cluster-a",
        failed_gate="citation",
        reason="the cited bytes changed",
        round_number=1,
        rejected_at=WHEN,
    )
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            RejectionMemory(path).rejections()
    assert RejectionMemory(tmp_path / "never-written.jsonl").rejections() == ()


def test_agentmemory_notes_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    path = store_dir / "agent-memory.jsonl"
    AgentMemory(path).remember(session="s", note="a note", at=WHEN)
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            AgentMemory(path).notes()
    assert AgentMemory(tmp_path / "never-written.jsonl").notes() == ()


def test_bridgeregistry_cards_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    path = store_dir / "bridges.jsonl"
    BridgeRegistry(path).record(_card("cluster-a"))
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            BridgeRegistry(path).cards()
    assert BridgeRegistry(tmp_path / "never-written.jsonl").cards() == ()


def test_ledger_entries_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    path = store_dir / "ledger.jsonl"
    snapshots = SnapshotStore(tmp_path / "snapshots")
    ingest(snapshots, Ledger(path), SOURCE_ID, UntrustedText("x"), WHEN)
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            Ledger(path).entries()
    assert Ledger(tmp_path / "never-written.jsonl").entries() == ()


def test_snapshotstore_digests_raises_on_an_unreadable_root(tmp_path: Path) -> None:
    """A root that cannot be traversed is not the same fact as a source never snapshotted."""
    root = tmp_path / "snapshots"
    store = SnapshotStore(root)
    store.put(SOURCE_ID, b"content")
    with _unreadable(root):
        with pytest.raises(OSError):
            store.digests(SOURCE_ID)
    assert SnapshotStore(tmp_path / "never-written").digests(SOURCE_ID) == ()


def test_snapshotstore_has_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    root = tmp_path / "snapshots"
    store = SnapshotStore(root)
    snapshot = store.put(SOURCE_ID, b"content")
    with _unreadable(root / SOURCE_ID):
        with pytest.raises(OSError):
            store.has(SOURCE_ID, snapshot.digest)
    assert SnapshotStore(tmp_path / "never-written").has(SOURCE_ID, snapshot.digest) is False


def test_snapshotstore_get_raises_the_real_reason_not_snapshotnotfound(tmp_path: Path) -> None:
    """A denied read is a different fact from a missing snapshot, and must raise differently."""
    root = tmp_path / "snapshots"
    store = SnapshotStore(root)
    snapshot = store.put(SOURCE_ID, b"content")
    with _unreadable(root / SOURCE_ID):
        with pytest.raises(OSError) as excinfo:
            store.get(SOURCE_ID, snapshot.digest)
        assert not isinstance(excinfo.value, SnapshotNotFound)
    with pytest.raises(SnapshotNotFound):
        SnapshotStore(tmp_path / "never-written").get(SOURCE_ID, snapshot.digest)


def test_config_list_documents_raises_on_an_unreadable_subdirectory(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    (canon / "sub").mkdir(parents=True)
    (canon / "a.md").write_text("alpha\n")
    (canon / "sub" / "b.md").write_text("beta\n")
    root = config.resolve_data_root(canon)
    assert config.list_documents(root) == ("a.md", "sub/b.md")
    with _unreadable(canon / "sub"):
        with pytest.raises(OSError):
            config.list_documents(root)
    empty = tmp_path / "empty"
    empty.mkdir()
    assert config.list_documents(config.resolve_data_root(empty)) == ()


def test_derived_rebuild_raises_rather_than_producing_an_empty_index(tmp_path: Path) -> None:
    """The composition: an unreadable ledger directory must refuse the whole rebuild."""
    ledger_dir = tmp_path / "ledger"
    ledger_dir.mkdir()
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(ledger_dir / "ledger.jsonl")
    ingest(store, ledger, SOURCE_ID, UntrustedText("Ruritania borders Graustark.\n"), WHEN)
    db_path = tmp_path / "derived.db"
    derived.build(store, ledger, db_path)
    db_path.unlink()

    with _unreadable(ledger_dir):
        with pytest.raises(OSError):
            derived.rebuild(store, ledger, db_path)
    assert not db_path.exists()


def test_derived_search_raises_on_an_unreadable_directory(tmp_path: Path) -> None:
    """An unopenable store directory is not the same fact as a store never built."""
    store_dir = tmp_path / "store"
    store_dir.mkdir()
    db_path = store_dir / "derived.db"
    with _unreadable(store_dir):
        with pytest.raises(OSError):
            derived.search(db_path, "x")
    with pytest.raises(DerivedStoreError, match="no derived store at never-built.db; build it first"):
        derived.search(tmp_path / "never-built.db", "x")
