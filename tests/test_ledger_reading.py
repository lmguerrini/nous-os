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
    zones = [timezone.utc, timezone(timedelta(hours=2)), timezone(timedelta(hours=-5, minutes=-30))]
    at = T0
    for step in range(200):
        source = rng.choice(SOURCES)
        text = rng.choice(texts)
        at += timedelta(minutes=1)
        warm_result = ingest(store, warm, source, UntrustedText(text), at.astimezone(rng.choice(zones)))
        fresh = Ledger(warm.path)
        assert _spelled(warm.entries()) == _spelled(fresh.entries()), step
        for candidate in SOURCES:
            assert _spelled(warm.chain(candidate)) == _spelled(fresh.chain(candidate)), (step, candidate)
            assert warm.current_digest(candidate) == fresh.current_digest(candidate), (step, candidate)
        assert warm_result.status in (IngestStatus.INGESTED, IngestStatus.UNCHANGED, IngestStatus.SUPERSEDED)
    assert len(warm.entries()) == len(Ledger(warm.path).entries()) > 8


def _spelled(entries) -> list[tuple]:
    """Entries with their instants as text: ``==`` on datetimes compares instants and
    would hide a timezone the file does not carry."""
    return [(e.source_id, e.snapshot_digest, e.previous_digest, e.recorded_at.isoformat(), e.quarantine) for e in entries]


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
    assert parses["count"] == 1
    parses["count"] = 0
    for index, source in enumerate(SOURCES * 5):
        ingest(store, ledger, source, UntrustedText(f"text {index}"), T0 + timedelta(minutes=index))
    assert parses["count"] == 0  # the warm reading answered every question
    assert Ledger(ledger.path).entries() == ledger.entries()
    assert parses["count"] == 1  # the fresh instance read the file exactly once


# --- findings of the first independent review of this change ------------------------------


class _ReplaceAfterStat(Ledger):
    """A scheduler point: replace the file under its path (same size, new inode)
    right after the pre-write identity is sampled and before the write. Reproduces
    an audit's race, in which an earlier form extended its reading with the
    replacement's identity and answered from a history the file no longer held."""

    def __init__(self, path: Path, replacement: Path) -> None:
        super().__init__(path)
        self._replacement = replacement
        self.armed = False

    def _identity_of(self, status):
        result = Ledger._identity_of(status)
        if self.armed:
            self.armed = False
            os.replace(self._replacement, self.path)
        return result


class _ReplaceAfterParse(Ledger):
    """A scheduler point: replace the file after it was parsed, before the identity is re-read."""

    def __init__(self, path: Path, replacement: Path, times: int = 1) -> None:
        super().__init__(path)
        self._replacement = replacement
        self._times = times

    def _parse(self):
        parsed = super()._parse()
        if self._times:
            self._times -= 1
            data = self.path.read_bytes()
            self.path.write_bytes(self._replacement.read_bytes())
            self._replacement.write_bytes(data)
        return parsed


def _same_size_pair(tmp_path: Path) -> tuple[Path, Path, LedgerEntry, LedgerEntry]:
    old = LedgerEntry(SOURCES[0], "a" * 64, None, T0)
    new = LedgerEntry(SOURCES[1], "b" * 64, None, T0)
    path = tmp_path / "ledger.jsonl"
    replacement = tmp_path / "replacement.jsonl"
    path.write_bytes(canonical_bytes(old.as_payload()) + b"\n")
    replacement.write_bytes(canonical_bytes(new.as_payload()) + b"\n")
    assert path.stat().st_size == replacement.stat().st_size
    return path, replacement, old, new


def test_a_file_replaced_between_the_stat_and_the_write_is_not_mistaken_for_the_reading(tmp_path: Path) -> None:
    """Whatever the file now holds, the warm instance answers what a fresh one answers.
    (The line went to the file that was replaced away -- that is the replacer's doing,
    and the ledger's job is not to pretend otherwise.)"""
    path, replacement, old, new = _same_size_pair(tmp_path)
    tail = LedgerEntry(SOURCES[2], "c" * 64, None, T0)
    warm = _ReplaceAfterStat(path, replacement)
    assert warm.entries() == (old,)
    warm.armed = True
    warm.append(tail)
    assert warm.entries() == Ledger(path).entries()
    assert warm.entries()[0] == new
    assert old not in warm.entries()


def test_a_file_replaced_under_the_parse_is_read_again_not_answered_from(tmp_path: Path) -> None:
    path, replacement, old, new = _same_size_pair(tmp_path)
    warm = _ReplaceAfterParse(path, replacement)
    assert warm.entries() == (new,)  # the file the parse ended on, not the one it started on
    assert warm.entries() == Ledger(path).entries()


def test_a_file_that_keeps_changing_under_the_read_is_refused(tmp_path: Path) -> None:
    path, replacement, _, _ = _same_size_pair(tmp_path)
    restless = _ReplaceAfterParse(path, replacement, times=10)
    with pytest.raises(LedgerError, match="changed under every attempt"):
        restless.entries()


def test_a_long_history_of_one_source_is_verified_once_per_reading(tmp_path: Path, monkeypatch) -> None:
    """Asking a source's tip must not re-walk its whole history each time: the links
    were verified when the reading was made, and an append that links to the tip
    keeps them verified. 300 versions of one source: one full verification."""
    from nous_os import ledger as module

    full_verifications = {"count": 0}
    original = module._Reading.verified_chain

    def counted(self, source_id):
        if source_id not in self._verified and self._by_source.get(source_id):
            full_verifications["count"] += 1
        return original(self, source_id)

    monkeypatch.setattr(module._Reading, "verified_chain", counted)
    store, ledger = _fresh(tmp_path)
    for version in range(300):
        ingest(store, ledger, SOURCES[0], UntrustedText(f"version {version}"), T0 + timedelta(minutes=version))
    assert len(ledger.chain(SOURCES[0])) == 300
    assert full_verifications["count"] == 1
    # And a link that does not match the tip is still refused on the next question.
    ledger.append(LedgerEntry(SOURCES[0], "d" * 64, "e" * 64, T0 + timedelta(days=1)))
    with pytest.raises(LedgerError, match="broken"):
        ledger.current_digest(SOURCES[0])


def test_the_reading_holds_what_the_file_says_not_what_the_caller_passed(tmp_path: Path) -> None:
    """A caller's instant may carry a timezone; the file holds UTC. The derived store writes
    the instant's text, so a build from the instance that ingested must equal a build from
    a fresh instance byte for byte -- rebuildability is the ledger's promise, not only equality."""
    from nous_os import derived

    store, warm = _fresh(tmp_path)
    plus_two = timezone(timedelta(hours=2))
    ingest(store, warm, SOURCES[0], UntrustedText("one"), T0.astimezone(plus_two))
    ingest(store, warm, SOURCES[1], UntrustedText("two"), (T0 + timedelta(hours=1)).astimezone(plus_two))
    assert [e.recorded_at.isoformat() for e in warm.entries()] == [e.recorded_at.isoformat() for e in Ledger(warm.path).entries()]
    assert all(e.recorded_at.utcoffset() == timedelta(0) for e in warm.entries())
    from_warm = derived.build(store, warm, tmp_path / "warm.sqlite3")
    from_fresh = derived.build(store, Ledger(warm.path), tmp_path / "fresh.sqlite3")
    assert derived.state_digest(from_warm) == derived.state_digest(from_fresh)


def test_an_append_without_a_prior_read_does_not_hide_another_writer(tmp_path: Path) -> None:
    """Warm A; B appends; A appends without asking first. A must not extend its reading over
    B's line: the pre-write identity is not the reading's, so the reading is dropped."""
    store, a = _fresh(tmp_path)
    b = Ledger(a.path)
    ingest(store, a, SOURCES[0], UntrustedText("one"), T0)
    assert len(a.entries()) == 1  # a's reading is warm
    ingest(store, b, SOURCES[1], UntrustedText("two"), T0 + timedelta(hours=1))
    a.append(LedgerEntry(SOURCES[2], "c" * 64, None, T0 + timedelta(hours=2)))
    assert [e.source_id for e in a.entries()] == [SOURCES[0], SOURCES[1], SOURCES[2]]
    assert _spelled(a.entries()) == _spelled(Ledger(a.path).entries())


class _OtherWriterAfterStat(Ledger):
    """A scheduler point: another instance appends right after this one's pre-write check."""

    def __init__(self, path: Path, other: Ledger, entry: LedgerEntry) -> None:
        super().__init__(path)
        self._other, self._entry, self.armed = other, entry, False

    def _identity_of(self, status):
        result = Ledger._identity_of(status)
        if self.armed:
            self.armed = False
            self._other.append(self._entry)
        return result


def test_another_writer_appending_inside_the_write_window_is_not_hidden(tmp_path: Path) -> None:
    """Another writer lands a line between this instance's pre-write check and its write. The
    file is then two lines longer, not one; the reading is dropped, and the next question
    shows both lines."""
    store = SnapshotStore(tmp_path / "snapshots")
    other = Ledger(tmp_path / "ledger.jsonl")
    theirs = LedgerEntry(SOURCES[1], "b" * 64, None, T0 + timedelta(hours=1))
    a = _OtherWriterAfterStat(tmp_path / "ledger.jsonl", other, theirs)
    ingest(store, a, SOURCES[0], UntrustedText("one"), T0)
    assert len(a.entries()) == 1
    a.armed = True
    a.append(LedgerEntry(SOURCES[2], "c" * 64, None, T0 + timedelta(hours=2)))
    assert [e.source_id for e in a.entries()] == [SOURCES[0], SOURCES[1], SOURCES[2]]
    assert _spelled(a.entries()) == _spelled(Ledger(a.path).entries())


# --- findings of the targeted re-audit of the first repair ------------------------------


def test_a_reader_is_answered_not_refused_while_another_process_ingests(tmp_path: Path) -> None:
    """A reader without the lock, concurrent with a writer that holds it for every ingest,
    is waited for and answered: the parse takes the same lock. Before this, a sustained
    writer made every unlocked read fail after three attempts."""
    import subprocess
    import sys

    store, ledger = _fresh(tmp_path)
    for index in range(50):
        ingest(store, ledger, SOURCES[index % 8], UntrustedText(f"seed {index}"), T0 + timedelta(minutes=index))
    writer = tmp_path / "writer.py"
    writer.write_text(
        "import sys\n"
        "from datetime import datetime, timedelta, timezone\n"
        "from pathlib import Path\n"
        "from nous_os.ledger import Ledger, ingest\n"
        "from nous_os.snapshots import SnapshotStore\n"
        "from nous_os.untrusted import UntrustedText\n"
        "root = Path(sys.argv[1]); store = SnapshotStore(root / 'snapshots'); ledger = Ledger(root / 'ledger.jsonl')\n"
        "t0 = datetime(2026, 6, 1, tzinfo=timezone.utc)\n"
        "for i in range(400):\n"
        "    ingest(store, ledger, 'src_' + 'W' * 25 + 'ABCDEFGH'[i % 8], UntrustedText(f'w {i}'), t0 + timedelta(seconds=i))\n"
    )
    env = {"PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}
    process = subprocess.Popen([sys.executable, str(writer), str(tmp_path)], env=env)
    try:
        reader = Ledger(ledger.path)
        answered = 0
        while process.poll() is None:
            reader.entries()  # would raise LedgerError under a sustained writer without the lock on parse
            answered += 1
    finally:
        process.wait(timeout=120)
    assert process.returncode == 0
    assert answered > 0
    assert _spelled(reader.entries()) == _spelled(Ledger(ledger.path).entries())


def test_a_truncation_between_the_check_and_the_write_is_not_hidden(tmp_path: Path) -> None:
    """The size guard is an equality: a file that lost lines between the pre-write check and
    the write is not one line longer afterwards, and the reading is dropped."""
    store, warm = _fresh(tmp_path)
    for hour in range(3):
        ingest(store, warm, SOURCES[hour], UntrustedText(f"v{hour}"), T0 + timedelta(hours=hour))
    assert len(warm.entries()) == 3

    class _TruncateAfterCheck(Ledger):
        armed = False

        def _identity_of(self, status):
            result = Ledger._identity_of(status)
            if self.armed:
                self.armed = False
                lines = self.path.read_bytes().split(b"\n")
                self.path.write_bytes(b"\n".join(lines[:1]) + b"\n")
            return result

    shrinking = _TruncateAfterCheck(warm.path)
    assert len(shrinking.entries()) == 3
    shrinking.armed = True
    shrinking.append(LedgerEntry(SOURCES[3], "d" * 64, None, T0 + timedelta(hours=3)))
    assert [e.source_id for e in shrinking.entries()] == [SOURCES[0], SOURCES[3]]
    assert _spelled(shrinking.entries()) == _spelled(Ledger(warm.path).entries())
