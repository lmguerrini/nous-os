"""Source memory: identity that survives re-import, and a second import that writes nothing.

Every record here is invented in the test body. The seam under test knows no
provider and no format, and these tests prove that by feeding it records from
two unrelated synthetic shapes.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os.capability import Grant, NotAuthorized, Tier
from nous_os.identity import digest_bytes
from nous_os.ledger import IngestStatus, Ledger
from nous_os.snapshots import SnapshotStore
from nous_os.sources import (
    ExportIdentity,
    Identity,
    IdentityBasis,
    IdentityRegistry,
    IngestReport,
    Parentage,
    RecordOutcome,
    Role,
    Sighting,
    SightingLog,
    SourceKind,
    SourceMemoryError,
    SourceRecord,
    ingest_export,
    verify_source_memory,
)

T0 = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
T1 = T0 + timedelta(days=1)
PROVIDER = "example.test"
ACCOUNT = "account-0001"
PROMOTE = Grant("operator", frozenset({Tier.PROMOTE}))
READ_ONLY = Grant("reader", frozenset({Tier.READ, Tier.PROPOSE}))


def _export(export_id: str = "export-a") -> ExportIdentity:
    return ExportIdentity(
        provider=PROVIDER,
        export_id=export_id,
        created_at="2026-03-01T08:00:00+00:00",
        format_version="1.0",
        archive_digest="0" * 64,
    )


def _record(
    kind: SourceKind,
    external_id: str,
    payload: object,
    *,
    locator: str = "records.json#/0",
    container: str | None = None,
    parent: str | None = None,
    parentage: Parentage = Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT,
    role: Role | None = None,
) -> SourceRecord:
    return SourceRecord(
        provider=PROVIDER,
        account=ACCOUNT,
        kind=kind,
        external_id=external_id,
        identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload=payload,
        locator=locator,
        container_external_id=container,
        parent_external_id=parent,
        parentage=parentage,
        role=role,
        created_at="2026-02-28T10:00:00+00:00",
    )


def _corpus() -> list[SourceRecord]:
    """A conversation, two messages on a branch, and a memory file."""
    return [
        _record(SourceKind.CONVERSATION, "conv-1", {"title": "Tides at the harbour"}),
        _record(
            SourceKind.MESSAGE,
            "msg-1",
            {"text": "When is high water?"},
            container="conv-1",
            parent=None,
            parentage=Parentage.REPRESENTED,
            role=Role.USER,
        ),
        _record(
            SourceKind.MESSAGE,
            "msg-2",
            {"text": "Twice a day, about twelve hours apart."},
            container="conv-1",
            parent="msg-1",
            parentage=Parentage.REPRESENTED,
            role=Role.ASSISTANT,
        ),
        _record(SourceKind.MEMORY_FILE, "notes/tides", {"content": "Prefers the morning tide."}),
    ]


class _Memory:
    """The four canonical files of source memory, under one temporary root."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = SnapshotStore(root / "snapshots")
        self.ledger = Ledger(root / "ledger.jsonl")
        self.registry = IdentityRegistry(root / "identities.jsonl")
        self.sightings = SightingLog(root / "sightings.jsonl")

    def ingest(self, records, export=None, at=T0, grant=PROMOTE, minter=None) -> IngestReport:
        return ingest_export(
            grant=grant,
            store=self.store,
            ledger=self.ledger,
            registry=self.registry,
            sightings=self.sightings,
            export=export or _export(),
            records=records,
            recorded_at=at,
            minter=minter,
        )

    def digest(self) -> dict[str, str]:
        """One digest per canonical file, and one over the whole snapshot tree."""
        snapshot_tree = hashlib.sha256()
        for path in sorted((self.root / "snapshots").rglob("*.snapshot")):
            snapshot_tree.update(path.relative_to(self.root).as_posix().encode())
            snapshot_tree.update(path.read_bytes())
        return {
            "ledger": digest_bytes(self.ledger.path.read_bytes()),
            "identities": digest_bytes(self.registry.path.read_bytes()),
            "sightings": digest_bytes(self.sightings.path.read_bytes()),
            "snapshots": snapshot_tree.hexdigest(),
        }


@pytest.fixture
def memory(tmp_path: Path) -> _Memory:
    return _Memory(tmp_path)


# --- O1: the same export twice writes nothing -------------------------------


def test_the_same_export_twice_writes_nothing(memory: _Memory) -> None:
    first = memory.ingest(_corpus())
    assert first.ingested == 4 and first.identities_minted == 4 and first.sightings_recorded == 4
    before = memory.digest()

    second = memory.ingest(_corpus(), at=T1)

    assert second.records_offered == 4
    assert second.unchanged == 4
    assert second.ingested == 0 and second.superseded == 0 and second.rejected == 0
    assert second.identities_minted == 0
    assert second.sightings_recorded == 0
    assert second.not_sighted == ()
    assert memory.digest() == before
    assert verify_source_memory(memory.registry, memory.ledger, memory.store) == ()


def test_record_bytes_are_deterministic_across_key_order_and_processes() -> None:
    one = _record(SourceKind.PROJECT, "p", {"b": 1, "a": [1, 2, {"z": "ä"}]})
    other = _record(SourceKind.PROJECT, "p", {"a": [1, 2, {"z": "ä"}], "b": 1})
    assert one.snapshot_bytes() == other.snapshot_bytes()
    assert "ä".encode("utf-8") in one.snapshot_bytes()


# --- identity survives re-import; content change is a revision --------------


def test_a_content_change_is_a_new_version_and_the_old_one_still_resolves(memory: _Memory) -> None:
    memory.ingest(_corpus())
    held = memory.registry.resolve(_corpus()[0])
    assert held is not None

    changed = _corpus()
    changed[0] = _record(SourceKind.CONVERSATION, "conv-1", {"title": "Tides at the old harbour"})
    report = memory.ingest(changed, export=_export("export-b"), at=T1)

    assert memory.registry.resolve(changed[0]) == held  # identity kept
    assert report.superseded == 1 and report.unchanged == 3 and report.ingested == 0
    chain = memory.ledger.chain(held.source_id)
    assert len(chain) == 2 and chain[1].previous_digest == chain[0].snapshot_digest
    earlier = memory.store.get(held.source_id, chain[0].snapshot_digest)
    assert earlier.data == _corpus()[0].snapshot_bytes()
    # The unchanged records gained a sighting under the new export and nothing else.
    assert report.sightings_recorded == 4
    assert memory.sightings.exports_for(held.source_id) == ("export-a", "export-b")


def test_a_second_export_with_identical_content_appends_sightings_only(memory: _Memory) -> None:
    memory.ingest(_corpus())
    before = memory.digest()
    report = memory.ingest(_corpus(), export=_export("export-b"), at=T1)
    assert report.unchanged == 4 and report.sightings_recorded == 4 and report.identities_minted == 0
    after = memory.digest()
    assert after["ledger"] == before["ledger"]
    assert after["identities"] == before["identities"]
    assert after["snapshots"] == before["snapshots"]
    assert after["sightings"] != before["sightings"]


# --- O9: absence from a later export deletes nothing -------------------------


def test_absence_from_a_later_export_deletes_nothing(memory: _Memory) -> None:
    memory.ingest(_corpus())
    before = memory.digest()
    memory_file = memory.registry.resolve(_corpus()[3])
    assert memory_file is not None

    report = memory.ingest(_corpus()[:3], export=_export("export-b"), at=T1)

    assert report.not_sighted == (memory_file.source_id,)
    after = memory.digest()
    assert after["ledger"] == before["ledger"]
    assert after["identities"] == before["identities"]
    assert after["snapshots"] == before["snapshots"]
    assert len(memory.ledger.chain(memory_file.source_id)) == 1
    assert memory.sightings.exports_for(memory_file.source_id) == ("export-a",)


# --- O4: authority --------------------------------------------------------------


def test_the_driver_refuses_a_grant_without_promote(memory: _Memory) -> None:
    with pytest.raises(NotAuthorized):
        memory.ingest(_corpus(), grant=READ_ONLY)
    assert not memory.registry.path.exists()
    assert not memory.ledger.path.exists()
    assert not memory.sightings.path.exists()
    assert not (memory.root / "snapshots").exists()


def test_the_driver_refuses_a_grant_lookalike(memory: _Memory) -> None:
    class Lookalike:
        holder = "operator"
        tiers = frozenset({Tier.PROMOTE})

        def holds(self, tier: Tier) -> bool:
            return True

    with pytest.raises(NotAuthorized):
        memory.ingest(_corpus(), grant=Lookalike())  # type: ignore[arg-type]


# --- O5: duplicate evidence ----------------------------------------------------


def test_duplicate_evidence_does_not_duplicate_records(memory: _Memory) -> None:
    records = _corpus()
    identical_twin = _record(
        SourceKind.MEMORY_FILE,
        "notes/tides",
        {"content": "Prefers the morning tide."},
        locator="records.json#/9",
    )
    conflicting_twin = _record(SourceKind.CONVERSATION, "conv-1", {"title": "Something else"})
    report = memory.ingest(records + [identical_twin, conflicting_twin])

    assert report.records_offered == 4  # two identities collapsed, one conflicting set aside
    by_id = {(r.kind, r.external_id): r for r in report.results}
    assert by_id[(SourceKind.MEMORY_FILE, "notes/tides")].status is IngestStatus.INGESTED
    assert by_id[(SourceKind.CONVERSATION, "conv-1")].outcome is RecordOutcome.CONFLICTING_DUPLICATE
    assert by_id[(SourceKind.CONVERSATION, "conv-1")].source_id is None
    assert report.rejected == 1 and report.ingested == 3
    assert memory.registry.resolve(records[0]) is None  # nothing minted for the conflict
    assert len(memory.registry.entries()) == 3


# --- O7: the mutation oracle ----------------------------------------------------


def test_bypassing_the_registry_is_detected_by_the_idempotency_oracle(memory: _Memory) -> None:
    """If identities were minted fresh each run, O1's assertions fail. Demonstrated."""

    class _Amnesiac(IdentityRegistry):
        def resolve(self, record: SourceRecord) -> Identity | None:
            return None

        def held(self) -> dict:
            return {}

    memory.registry = _Amnesiac(memory.root / "identities.jsonl")
    memory.ingest(_corpus())
    before = memory.digest()
    second = memory.ingest(_corpus(), at=T1)
    assert second.unchanged != 4
    assert second.identities_minted != 0
    assert memory.digest() != before


# --- O8: the seam takes records from any adapter ---------------------------------


def test_the_seam_takes_records_from_any_adapter(memory: _Memory) -> None:
    """A second synthetic provider, an unrelated shape, the same seam untouched."""

    def other_adapter():
        rows = [
            {"id": "n1", "kind": "note", "body": "Lighthouse keeper's log, page one."},
            {"id": "n2", "kind": "note", "body": "Page two."},
        ]
        for index, row in enumerate(rows):
            yield SourceRecord(
                provider="other.example",
                account="someone",
                kind=SourceKind.PROJECT_DOCUMENT,
                external_id=row["id"],
                identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
                payload=row,
                locator=f"notes.csv#{index}",
            )

    export = ExportIdentity(
        provider="other.example", export_id="dump-7", created_at="2026-01-01", format_version="csv-1"
    )
    first = memory.ingest(other_adapter(), export=export)
    second = memory.ingest(other_adapter(), export=export, at=T1)
    assert first.ingested == 2 and second.unchanged == 2 and second.identities_minted == 0


def test_a_record_from_another_provider_is_refused_for_this_export(memory: _Memory) -> None:
    stray = SourceRecord(
        provider="other.example",
        account=ACCOUNT,
        kind=SourceKind.PROJECT,
        external_id="p",
        identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload={},
        locator="x",
    )
    with pytest.raises(SourceMemoryError):
        memory.ingest([stray])


# --- O13: an identity without history -------------------------------------------


def test_an_identity_without_history_is_reported_and_reused(memory: _Memory) -> None:
    record = _corpus()[0]
    minted = memory.registry.mint(record, T0)  # a process that died before ingesting
    assert verify_source_memory(memory.registry, memory.ledger, memory.store) == (
        ("IDENTITY_WITHOUT_HISTORY", minted.source_id),
    )
    report = memory.ingest([record])
    assert report.identities_minted == 0 and report.ingested == 1
    assert report.results[0].source_id == minted.source_id
    assert verify_source_memory(memory.registry, memory.ledger, memory.store) == ()


def test_verification_names_history_without_identity_and_missing_snapshots(memory: _Memory) -> None:
    memory.ingest(_corpus())
    held = memory.registry.resolve(_corpus()[1])
    assert held is not None
    # A ledger line for a source the registry never named.
    orphan = memory.ledger.entries()[0]
    memory.ledger.append(
        type(orphan)(
            source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            snapshot_digest=orphan.snapshot_digest,
            previous_digest=None,
            recorded_at=T1,
        )
    )
    # A snapshot removed from under the ledger.
    for path in (memory.root / "snapshots" / held.source_id).iterdir():
        path.unlink()
    problems = verify_source_memory(memory.registry, memory.ledger, memory.store)
    assert ("HISTORY_WITHOUT_IDENTITY", "src_01ARZ3NDEKTSV4RRFFQ69G5FAV") in problems
    assert any(kind == "SNAPSHOT_MISSING" and value.startswith(held.source_id) for kind, value in problems)


# --- the registry and the log are append-only and loud ----------------------------


def test_the_registry_mints_once_and_refuses_a_second_minting(memory: _Memory) -> None:
    record = _corpus()[0]
    first = memory.registry.mint(record, T0)
    with pytest.raises(SourceMemoryError):
        memory.registry.mint(record, T1)
    assert memory.registry.resolve(record) == first


def test_an_unreadable_registry_line_is_reported_not_skipped(memory: _Memory) -> None:
    memory.registry.mint(_corpus()[0], T0)
    with memory.registry.path.open("a", encoding="utf-8") as handle:
        handle.write('{"provider": "example.test"\n')
    with pytest.raises(SourceMemoryError, match="line 2"):
        memory.registry.entries()


def test_an_unreadable_sighting_line_is_reported_not_skipped(memory: _Memory) -> None:
    memory.ingest(_corpus())
    with memory.sightings.path.open("a", encoding="utf-8") as handle:
        handle.write("not json\n")
    with pytest.raises(SourceMemoryError, match="line 5"):
        memory.sightings.entries()


def test_a_sighting_is_recorded_once_per_source_export_and_version(memory: _Memory) -> None:
    sighting = Sighting(
        source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        provider=PROVIDER,
        export_id="export-a",
        snapshot_digest="a" * 64,
        locator="x#/0",
        observed_at=T0,
    )
    assert memory.sightings.record(sighting) is True
    assert memory.sightings.record(sighting) is False
    later_version = Sighting(
        source_id=sighting.source_id,
        provider=PROVIDER,
        export_id="export-a",
        snapshot_digest="b" * 64,
        locator="x#/0",
        observed_at=T1,
    )
    assert memory.sightings.record(later_version) is True
    assert len(memory.sightings.entries()) == 2


# --- the record model refuses what it cannot mean ---------------------------------


def test_unsupported_parentage_cannot_name_a_parent() -> None:
    with pytest.raises(SourceMemoryError):
        _record(SourceKind.DESIGN_MESSAGE, "d", {}, parent="p")


def test_represented_parentage_with_no_parent_is_a_root() -> None:
    root = _record(SourceKind.MESSAGE, "m", {}, parentage=Parentage.REPRESENTED)
    assert root.parent_external_id is None and root.parentage is Parentage.REPRESENTED
    assert root.snapshot_payload()["parentage"] == "represented"


def test_a_payload_without_a_canonical_form_is_refused() -> None:
    with pytest.raises(SourceMemoryError):
        _record(SourceKind.PROJECT, "p", {"when": T0})
    with pytest.raises(SourceMemoryError):
        _record(SourceKind.PROJECT, "p", {"n": float("nan")})


def test_the_locator_is_not_part_of_the_versioned_bytes() -> None:
    here = _record(SourceKind.PROJECT, "p", {"a": 1}, locator="one.json#/0")
    there = _record(SourceKind.PROJECT, "p", {"a": 1}, locator="two.json#/7")
    assert here.snapshot_bytes() == there.snapshot_bytes()
    assert "locator" not in here.snapshot_payload()


def test_the_report_payload_carries_counts_by_kind_and_is_json_shaped(memory: _Memory) -> None:
    report = memory.ingest(_corpus())
    payload = report.as_payload()
    assert payload["by_kind"] == {
        "conversation": {"ingested": 1, "unchanged": 0, "superseded": 0, "rejected": 0},
        "message": {"ingested": 2, "unchanged": 0, "superseded": 0, "rejected": 0},
        "memory_file": {"ingested": 1, "unchanged": 0, "superseded": 0, "rejected": 0},
    }
    assert payload["export"]["export_id"] == "export-a"
    import json

    json.dumps(payload)  # every value is plain data


# --- findings of the first independent review, each with its own oracle ------------


def test_two_processes_ingesting_at_once_mint_one_identity_per_record(tmp_path: Path) -> None:
    """Minting is read-then-append; without a lock two runs both mint and the registry
    names one key twice, after which every read of it refuses forever. Two processes,
    one export, one memory root: every identity is minted exactly once."""
    import subprocess
    import sys

    worker = tmp_path / "worker.py"
    worker.write_text(
        "import sys\n"
        "from datetime import datetime, timezone\n"
        "from pathlib import Path\n"
        "from nous_os.capability import Grant, Tier\n"
        "from nous_os.ledger import Ledger\n"
        "from nous_os.snapshots import SnapshotStore\n"
        "from nous_os.sources import *\n"
        "root = Path(sys.argv[1])\n"
        "records = [SourceRecord(provider='p', account='a', kind=SourceKind.MESSAGE, external_id=f'm-{i:04d}',\n"
        "    identity_basis=IdentityBasis.PROVIDER_IDENTIFIER, payload={'i': i}, locator=f'x#/{i}') for i in range(120)]\n"
        "report = ingest_export(grant=Grant('o', frozenset({Tier.PROMOTE})), store=SnapshotStore(root / 'snapshots'),\n"
        "    ledger=Ledger(root / 'ledger.jsonl'), registry=IdentityRegistry(root / 'identities.jsonl'),\n"
        "    sightings=SightingLog(root / 'sightings.jsonl'),\n"
        "    export=ExportIdentity(provider='p', export_id='e', created_at='t', format_version='1'),\n"
        "    records=records, recorded_at=datetime(2026, 3, 1, tzinfo=timezone.utc))\n"
        "print(report.ingested, report.unchanged, report.identities_minted)\n"
    )
    env = {"PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}
    memory = tmp_path / "memory"
    runs = [
        subprocess.Popen([sys.executable, str(worker), str(memory)], env=env, stdout=subprocess.PIPE, text=True)
        for _ in range(2)
    ]
    outputs = [run.communicate()[0].split() for run in runs]
    assert all(run.returncode == 0 for run in runs), outputs
    counts = [tuple(int(value) for value in output) for output in outputs]
    assert sum(ingested for ingested, _, _ in counts) == 120
    assert sum(unchanged for _, unchanged, _ in counts) == 120
    assert sum(minted for _, _, minted in counts) == 120
    registry = IdentityRegistry(memory / "identities.jsonl")
    assert len(registry.held()) == 120  # refuses if any key were named twice
    assert (
        verify_source_memory(
            registry, Ledger(memory / "ledger.jsonl"), SnapshotStore(memory / "snapshots"),
            SightingLog(memory / "sightings.jsonl"),
        )
        == ()
    )


def test_a_run_reads_each_index_once_however_many_records_it_takes(memory: _Memory, monkeypatch) -> None:
    """Re-reading the registry and the sighting log per record made ingest quadratic in
    memory size. One run reads each file once and keeps the index current itself."""
    reads = {"registry": 0, "sightings": 0}
    original_registry = IdentityRegistry.entries
    original_sightings = SightingLog.entries

    def counted_registry(self):
        reads["registry"] += 1
        return original_registry(self)

    def counted_sightings(self):
        reads["sightings"] += 1
        return original_sightings(self)

    monkeypatch.setattr(IdentityRegistry, "entries", counted_registry)
    monkeypatch.setattr(SightingLog, "entries", counted_sightings)
    many = [
        _record(SourceKind.MESSAGE, f"m-{i}", {"i": i}, container="c", parentage=Parentage.REPRESENTED)
        for i in range(40)
    ]
    memory.ingest(many)
    assert reads == {"registry": 1, "sightings": 1}
    reads.update(registry=0, sightings=0)
    memory.ingest(many, at=T1)
    assert reads == {"registry": 1, "sightings": 1}


def test_identities_are_keyed_on_kind_as_well_as_external_id(memory: _Memory) -> None:
    same_id = [
        _record(SourceKind.PROJECT, "shared", {"a": 1}),
        _record(SourceKind.PROJECT_DOCUMENT, "shared", {"b": 2}, container="shared"),
    ]
    report = memory.ingest(same_id)
    assert report.ingested == 2 and report.identities_minted == 2
    assert len({result.source_id for result in report.results}) == 2


def test_a_rejected_duplicate_is_not_reported_as_absent(memory: _Memory) -> None:
    memory.ingest(_corpus())
    conflicting = _corpus() + [_record(SourceKind.CONVERSATION, "conv-1", {"title": "Other"})]
    report = memory.ingest(conflicting, export=_export("export-b"), at=T1)
    assert report.rejected == 1
    assert report.not_sighted == ()  # it was in the export, twice; refused is not absent


def test_verification_names_a_version_no_export_is_recorded_as_carrying(memory: _Memory) -> None:
    """A process that dies between the ledger append and the sighting append leaves a
    version nobody is recorded as having carried; the next run of the same export writes
    that one sighting and nothing else, and verification names the gap until it does."""
    memory.ingest(_corpus())
    lines = memory.sightings.path.read_text(encoding="utf-8").splitlines()
    memory.sightings.path.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")
    problems = verify_source_memory(memory.registry, memory.ledger, memory.store, memory.sightings)
    assert len(problems) == 1 and problems[0][0] == "HISTORY_WITHOUT_SIGHTING"
    report = memory.ingest(_corpus(), at=T1)
    assert report.unchanged == 4 and report.sightings_recorded == 1 and report.identities_minted == 0
    assert verify_source_memory(memory.registry, memory.ledger, memory.store, memory.sightings) == ()
