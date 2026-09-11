"""The ledger reads its file once per change, not once per question -- and never serves a stale read.

Every ledger here is built in the test body. The properties are those a reader of
the file would already expect: a long-lived instance answers exactly like a fresh
one, anything that touches the file is seen on the next question, and a broken
file still fails the way it always did.
"""

from __future__ import annotations

import os
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os.identity import canonical_bytes
from nous_os.ledger import IngestStatus, Ledger, LedgerEntry, LedgerError, ingest
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText

T0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
SOURCES = tuple(f"src_{letter * 26}" for letter in "ABCDEFGH")


def _digest(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _fresh(tmp_path: Path) -> tuple[SnapshotStore, Ledger]:
    return SnapshotStore(tmp_path / "snapshots"), Ledger(tmp_path / "ledger.jsonl")


# --- O1: a long-lived reading answers like a fresh one --------------------------------


def test_a_long_lived_reading_answers_like_a_fresh_one_after_every_step(tmp_path: Path) -> None:
    """Two hundred seeded steps over eight sources, with reverts and repeated edits,
    and after every one the warm instance agrees with a fresh instance on every
    method it has."""
    store, warm = _fresh(tmp_path)
    rng = random.Random(20260912)
    texts = ["tide table", "lamp schedule", "tide table", "keeper's log", "lamp schedule"]
    at = T0
    for step in range(200):
        source = rng.choice(SOURCES)
        text = rng.choice(texts)
        at += timedelta(minutes=1)
        warm_result = ingest(store, warm, source, UntrustedText(text), at)
        fresh = Ledger(warm.path)
        assert warm.entries() == fresh.entries(), step
        for candidate in SOURCES:
            assert warm.chain(candidate) == fresh.chain(candidate), (step, candidate)
            assert warm.current_digest(candidate) == fresh.current_digest(candidate), (step, candidate)
        assert warm_result.status in (IngestStatus.INGESTED, IngestStatus.UNCHANGED, IngestStatus.SUPERSEDED)
    assert len(warm.entries()) == len(Ledger(warm.path).entries()) > 8


# --- O2: the file format and the written bytes are unchanged -----------------------------


def test_the_file_format_and_written_bytes_are_unchanged(tmp_path: Path) -> None:
    """A ledger written by hand in the format the file has always had reads identically,
    and every append adds exactly the canonical line and nothing else."""
    path = tmp_path / "ledger.jsonl"
    first = LedgerEntry(SOURCES[0], _digest("one"), None, T0)
    second = LedgerEntry(SOURCES[0], _digest("two"), _digest("one"), T0 + timedelta(hours=1))
    path.write_bytes(canonical_bytes(first.as_payload()) + b"\n" + canonical_bytes(second.as_payload()) + b"\n")
    ledger = Ledger(path)
    assert ledger.entries() == (first, second)
    assert ledger.chain(SOURCES[0]) == (first, second)
    before = path.read_bytes()
    third = LedgerEntry(SOURCES[1], _digest("three"), None, T0 + timedelta(hours=2))
    ledger.append(third)
    assert path.read_bytes() == before + canonical_bytes(third.as_payload()) + b"\n"
    assert ledger.entries() == (first, second, third)
    assert Ledger(path).entries() == (first, second, third)


# --- O3, O4, O5, O6: whatever touches the file is seen on the next question --------------


def test_an_in_place_edit_is_observed_not_masked(tmp_path: Path) -> None:
    store, ledger = _fresh(tmp_path)
    ingest(store, ledger, SOURCES[0], UntrustedText("one"), T0)
    ingest(store, ledger, SOURCES[0], UntrustedText("two"), T0 + timedelta(hours=1))
    assert len(ledger.chain(SOURCES[0])) == 2  # the reading is warm
    lines = ledger.path.read_bytes().split(b"\n")
    # The same size: one hex digit of the first entry's digest changed in place,
    # so the line is still well formed and the chain no longer links.
    original = lines[0]
    marker = b'"snapshot_digest":"'
    at = original.index(marker) + len(marker)
    swapped = b"0" if original[at : at + 1] != b"0" else b"1"
    edited = original[:at] + swapped + original[at + 1 :]
    assert len(edited) == len(original) and edited != original
    ledger.path.write_bytes(b"\n".join([edited] + lines[1:]))
    with pytest.raises(LedgerError, match="broken"):
        ledger.chain(SOURCES[0])


def test_an_edit_that_restores_the_modification_time_is_still_observed(tmp_path: Path) -> None:
    """Modification time can be put back by any user tool; the change time cannot.
    A reading that trusted size and mtime alone would serve the old content here."""
    store, ledger = _fresh(tmp_path)
    ingest(store, ledger, SOURCES[0], UntrustedText("one"), T0)
    ingest(store, ledger, SOURCES[1], UntrustedText("two"), T0)
    assert len(ledger.entries()) == 2
    status = os.stat(ledger.path)
    lines = ledger.path.read_bytes().split(b"\n")
    # Swap the two lines: same bytes, same size, different sequence.
    ledger.path.write_bytes(b"\n".join([lines[1], lines[0]] + lines[2:]))
    os.utime(ledger.path, ns=(status.st_atime_ns, status.st_mtime_ns))
    assert os.stat(ledger.path).st_size == status.st_size
    assert os.stat(ledger.path).st_mtime_ns == status.st_mtime_ns
    assert ledger.entries()[0].source_id == SOURCES[1]
    assert ledger.entries() == Ledger(ledger.path).entries()


def test_truncation_is_observed_and_a_partial_line_still_raises(tmp_path: Path) -> None:
    store, ledger = _fresh(tmp_path)
    for hour in range(3):
        ingest(store, ledger, SOURCES[0], UntrustedText(f"version {hour}"), T0 + timedelta(hours=hour))
    assert len(ledger.chain(SOURCES[0])) == 3
    lines = ledger.path.read_bytes().split(b"\n")
    ledger.path.write_bytes(b"\n".join(lines[:2]) + b"\n")  # the last version gone
    assert len(ledger.chain(SOURCES[0])) == 2
    assert ledger.current_digest(SOURCES[0]) == Ledger(ledger.path).current_digest(SOURCES[0])
    with ledger.path.open("ab") as handle:
        handle.write(lines[2][: len(lines[2]) // 2])  # a write that died half way
    with pytest.raises(LedgerError, match="line 3"):
        ledger.entries()
    with pytest.raises(LedgerError, match="line 3"):
        Ledger(ledger.path).entries()


def test_an_append_by_another_instance_is_seen(tmp_path: Path) -> None:
    store, first = _fresh(tmp_path)
    second = Ledger(first.path)
    ingest(store, first, SOURCES[0], UntrustedText("one"), T0)
    assert len(second.entries()) == 1  # second is now warm too
    ingest(store, second, SOURCES[1], UntrustedText("two"), T0 + timedelta(hours=1))
    assert [entry.source_id for entry in first.entries()] == [SOURCES[0], SOURCES[1]]
    assert first.current_digest(SOURCES[1]) == second.current_digest(SOURCES[1])
    # And the other way round, after the first appends again.
    ingest(store, first, SOURCES[1], UntrustedText("three"), T0 + timedelta(hours=2))
    assert len(second.chain(SOURCES[1])) == 2


def test_an_append_by_another_process_is_seen(tmp_path: Path) -> None:
    import subprocess
    import sys

    store, ledger = _fresh(tmp_path)
    ingest(store, ledger, SOURCES[0], UntrustedText("one"), T0)
    assert len(ledger.entries()) == 1
    script = (
        "import sys\n"
        "from datetime import datetime, timezone\n"
        "from pathlib import Path\n"
        "from nous_os.ledger import Ledger, ingest\n"
        "from nous_os.snapshots import SnapshotStore\n"
        "from nous_os.untrusted import UntrustedText\n"
        f"ingest(SnapshotStore(Path({str(tmp_path / 'snapshots')!r})), Ledger(Path({str(ledger.path)!r})), {SOURCES[1]!r}, UntrustedText('two'), datetime(2026, 1, 1, 13, tzinfo=timezone.utc))\n"
    )
    env = {"PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}
    subprocess.run([sys.executable, "-c", script], env=env, check=True)
    assert [entry.source_id for entry in ledger.entries()] == [SOURCES[0], SOURCES[1]]


# --- O7: a fresh instance reconstructs the state --------------------------------------------


def test_a_fresh_instance_reconstructs_the_state(tmp_path: Path) -> None:
    store, warm = _fresh(tmp_path)
    for hour, source in enumerate(SOURCES * 3):
        ingest(store, warm, source, UntrustedText(f"text {hour // 8}"), T0 + timedelta(hours=hour))
    fresh = Ledger(warm.path)
    assert fresh.entries() == warm.entries()
    assert all(fresh.chain(source) == warm.chain(source) for source in SOURCES)
    assert all(len(fresh.chain(source)) == 3 for source in SOURCES)


def test_an_absent_file_is_an_empty_history_until_it_exists(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.jsonl")
    assert ledger.entries() == () and ledger.current_digest(SOURCES[0]) is None
    store = SnapshotStore(tmp_path / "snapshots")
    ingest(store, ledger, SOURCES[0], UntrustedText("one"), T0)
    assert len(ledger.entries()) == 1
    ledger.path.unlink()
    assert ledger.entries() == ()


# --- O8: a run of ingests parses the file once ------------------------------------------------


def test_a_run_of_ingests_parses_the_file_once(tmp_path: Path, monkeypatch) -> None:
    """The measured defect: every ingest re-parsed the whole file. Now a run parses it
    once, and a run over an unchanged file parses it once more at most."""
    parses = {"count": 0}
    original = Ledger._parse

    def counted(self):
        parses["count"] += 1
        return original(self)

    monkeypatch.setattr(Ledger, "_parse", counted)
    store, ledger = _fresh(tmp_path)
    for index, source in enumerate(SOURCES * 5):
        ingest(store, ledger, source, UntrustedText(f"text {index}"), T0 + timedelta(minutes=index))
    assert parses["count"] <= 1
    parses["count"] = 0
    for index, source in enumerate(SOURCES * 5):
        ingest(store, ledger, source, UntrustedText(f"text {index}"), T0 + timedelta(minutes=index))
    assert parses["count"] == 0  # the warm reading answered every question
    assert Ledger(ledger.path).entries() == ledger.entries()
    assert parses["count"] == 1  # the fresh instance read the file exactly once
