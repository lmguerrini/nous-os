"""The supplied-document and rendered-window bundle adapter, on an invented harbour.

Every input is the public synthetic bundle or a temporary deviation from it.
No fixture is a real export or a real person's material.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os import capture_bundle
from nous_os.capability import Grant, Tier
from nous_os.capture_bundle import (
    BundleFileClass,
    BundleFormatError,
    BundleRefusal,
    inventory,
    normalize,
)
from nous_os.identity import digest_bytes
from nous_os.ledger import Ledger
from nous_os.snapshots import SnapshotStore
from nous_os.sources import (
    ExportIdentity,
    IdentityBasis,
    IdentityRegistry,
    Parentage,
    Role,
    SightingLog,
    SourceKind,
    SourceRecord,
    ingest_export,
    verify_source_memory,
)


FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "capture-bundle"
PROVIDER = "bundle-source"
ACCOUNT = "account-1"
ACCOUNT_BASIS = "native-conversation-account"
T0 = datetime(2026, 9, 12, 8, 0, tzinfo=timezone.utc)
PROMOTE = Grant("operator", frozenset({Tier.PROMOTE}))
RECORDS_IN_FIXTURE = 10  # 3 documents, 3 windows, 4 unique captured messages


def _copy(tmp_path: Path, name: str = "bundle") -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURE, target)
    return target


def _edit_json(path: Path, transform) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    transform(value)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _update_declaration(root: Path, relative: str) -> None:
    """Make one manifest entry describe its current bytes after a focused deviation."""

    data = (root / relative).read_bytes()

    def change(manifest: dict) -> None:
        entry = next(entry for entry in manifest["files"] if entry["path"] == relative)
        entry["bytes"] = len(data)
        entry["sha256"] = digest_bytes(data)

    _edit_json(root / "INPUT_MANIFEST.json", change)


def _declare(root: Path, relative: str, source_kind: str = "keeper_note") -> None:
    data = (root / relative).read_bytes()

    def change(manifest: dict) -> None:
        manifest["files"].append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": digest_bytes(data),
                "source_kind": source_kind,
                "sensitivity": "synthetic",
            }
        )

    _edit_json(root / "INPUT_MANIFEST.json", change)


def _records(root: Path = FIXTURE):
    normalized = normalize(
        inventory(root), provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS
    )
    return normalized, tuple(normalized.records)


def _by_kind(records: tuple[SourceRecord, ...], kind: SourceKind) -> dict[str, SourceRecord]:
    return {record.external_id: record for record in records if record.kind is kind}


class _Memory:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = SnapshotStore(root / "snapshots")
        self.ledger = Ledger(root / "ledger.jsonl")
        self.registry = IdentityRegistry(root / "identities.jsonl")
        self.sightings = SightingLog(root / "sightings.jsonl")

    def ingest_bundle(self, bundle: Path, at: datetime = T0):
        normalized, records = _records(bundle)
        export = ExportIdentity(
            provider=PROVIDER,
            export_id=normalized.inventory.manifest_digest,
            created_at="2026-09-12T07:30:00+00:00",
            format_version="bundle-1",
        )
        report = ingest_export(
            grant=PROMOTE,
            store=self.store,
            ledger=self.ledger,
            registry=self.registry,
            sightings=self.sightings,
            export=export,
            records=records,
            recorded_at=at,
        )
        return normalized, report

    def digest(self) -> dict[str, str]:
        tree = hashlib.sha256()
        for path in sorted((self.root / "snapshots").rglob("*")):
            if path.is_file():
                tree.update(path.name.encode("utf-8"))
                tree.update(path.read_bytes())
        return {
            "ledger": digest_bytes(self.ledger.path.read_bytes()),
            "identities": digest_bytes(self.registry.path.read_bytes()),
            "sightings": digest_bytes(self.sightings.path.read_bytes()),
            "snapshots": tree.hexdigest(),
        }


def test_normalization_is_deterministic() -> None:
    first, first_records = _records()
    second, second_records = _records()
    assert [record.snapshot_bytes() for record in first_records] == [record.snapshot_bytes() for record in second_records]
    assert [record.identity_key for record in first_records] == [record.identity_key for record in second_records]
    assert len(first_records) == RECORDS_IN_FIXTURE and first.refusals == ()
    assert first.counters == second.counters


def test_the_same_bundle_twice_writes_nothing(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    normalized, first = memory.ingest_bundle(FIXTURE)
    assert normalized.documents == 3 and normalized.windows == 3 and normalized.captured_messages == 4
    assert first.records_offered == RECORDS_IN_FIXTURE and first.ingested == RECORDS_IN_FIXTURE
    assert first.identities_minted == RECORDS_IN_FIXTURE and first.sightings_recorded == RECORDS_IN_FIXTURE
    before = memory.digest()
    _, second = memory.ingest_bundle(FIXTURE, at=T0 + timedelta(hours=1))
    assert second.unchanged == RECORDS_IN_FIXTURE
    assert second.identities_minted == 0 and second.sightings_recorded == 0
    assert memory.digest() == before
    assert verify_source_memory(memory.registry, memory.ledger, memory.store, memory.sightings) == ()


def test_messages_are_deduplicated_on_id_with_occurrences() -> None:
    normalized, records = _records()
    assert [record.kind for record in records] == [
        SourceKind.DOCUMENT,
        SourceKind.DOCUMENT,
        SourceKind.DOCUMENT,
        SourceKind.CAPTURE_WINDOW,
        SourceKind.CAPTURE_WINDOW,
        SourceKind.CAPTURE_WINDOW,
        SourceKind.CAPTURED_MESSAGE,
        SourceKind.CAPTURED_MESSAGE,
        SourceKind.CAPTURED_MESSAGE,
        SourceKind.CAPTURED_MESSAGE,
    ]
    messages = _by_kind(records, SourceKind.CAPTURED_MESSAGE)
    assert list(messages) == ["msg-a1", "msg-b2", "msg-c3", "msg-d4"]
    assert messages["msg-a1"].payload["occurrences"] == [
        {"window_index": 0, "position": 0, "captured_at": "2026-09-12T07:32:00+00:00"},
        {"window_index": 1, "position": 0, "captured_at": "2026-09-12T07:34:00+00:00"},
    ]
    assert messages["msg-c3"].payload["occurrences"] == [
        {"window_index": 1, "position": 1, "captured_at": "2026-09-12T07:34:00+00:00"},
        {"window_index": 2, "position": 0, "captured_at": "2026-09-12T07:36:00+00:00"},
    ]
    for message in messages.values():
        assert message.created_at is None
        assert message.parent_external_id is None
        assert message.parentage is Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT
        assert message.container_external_id == "conv-1"
        assert message.payload["account_basis"] == ACCOUNT_BASIS
    assert messages["msg-a1"].role is Role.USER
    windows = _by_kind(records, SourceKind.CAPTURE_WINDOW)
    assert windows["conv-1#0"].payload["message_ids"] == ["msg-a1", "msg-b2"]
    assert windows["conv-1#0"].payload["buttons"] == [
        {"label": "Copy", "disabled": False},
        {"label": "Retry", "disabled": True},
    ]
    assert windows["conv-1#2"].payload["account_basis"] == ACCOUNT_BASIS
    assert normalized.occurrences == 6


def test_a_captured_message_is_not_a_native_message(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    native = SourceRecord(
        provider=PROVIDER,
        account=ACCOUNT,
        kind=SourceKind.MESSAGE,
        external_id="msg-a1",
        identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload={"text": "When does the fog watch begin?"},
        locator="native.json#/messages/0",
        container_external_id="conv-1",
        parentage=Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT,
        role=Role.USER,
    )
    native_export = ExportIdentity(
        provider=PROVIDER,
        export_id="native-1",
        created_at="2026-09-12T07:00:00+00:00",
        format_version="native-1",
    )
    native_report = ingest_export(
        grant=PROMOTE,
        store=memory.store,
        ledger=memory.ledger,
        registry=memory.registry,
        sightings=memory.sightings,
        export=native_export,
        records=(native,),
        recorded_at=T0,
    )
    native_id = native_report.results[0].source_id
    _, capture_report = memory.ingest_bundle(FIXTURE, at=T0 + timedelta(minutes=1))
    capture_id = next(
        result.source_id
        for result in capture_report.results
        if result.kind is SourceKind.CAPTURED_MESSAGE and result.external_id == "msg-a1"
    )
    assert capture_id != native_id
    assert len(memory.ledger.chain(native_id)) == 1
    identities = memory.registry.held()
    assert (PROVIDER, ACCOUNT, SourceKind.MESSAGE.value, "msg-a1") in identities
    assert (PROVIDER, ACCOUNT, SourceKind.CAPTURED_MESSAGE.value, "msg-a1") in identities


def test_inconsistent_and_empty_occurrences(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def change(capture: dict) -> None:
        capture["branches"][1]["messages"][0]["text"] = "When does the storm watch begin?"

    _edit_json(root / "capture" / "interface.json", change)
    _update_declaration(root, "capture/interface.json")
    normalized, records = _records(root)
    messages = _by_kind(records, SourceKind.CAPTURED_MESSAGE)
    assert "msg-a1" not in messages
    assert messages["msg-b2"].payload["text"] == ""
    assert messages["msg-b2"].payload["html"] == "<img alt=\"signal chart\">"
    inconsistent = [item for item in normalized.refusals if item.refusal is BundleRefusal.INCONSISTENT_OCCURRENCES]
    assert len(inconsistent) == 1
    assert "branches/0" in inconsistent[0].locator and "branches/1" in inconsistent[0].locator
    assert normalized.inconsistent_ids == 1 and normalized.empty_text_messages == 1


def test_every_deviation_is_refused_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "watch.txt").write_text("Changed after the manifest.\n", encoding="utf-8")
    (root / "documents" / "supply.json").unlink()
    (root / "stray.txt").write_text("A file without a declaration.\n", encoding="utf-8")
    (root / "documents" / "non-text.txt").write_bytes(b"\xff\xfe")
    _declare(root, "documents/non-text.txt")
    def add_missing_id(capture: dict) -> None:
        capture["branches"][2]["messages"].append(
            {"role": "user", "text": "No identifier.", "text_content": "No identifier."}
        )
        capture["branches"][2]["messages"].append(
            {
                "id": "msg-malformed",
                "role": "user",
                "text_content": "Missing rendered text.",
            }
        )
        capture["branches"][2]["messages"].append(
            {
                "id": "msg-unknown",
                "role": "unlisted",
                "text": "An unlisted role.",
                "text_content": "An unlisted role.",
            }
        )

    _edit_json(root / "capture" / "interface.json", add_missing_id)
    _update_declaration(root, "capture/interface.json")
    normalized, ignored_records = _records(root)
    assert ignored_records
    refusals = {item.refusal for item in normalized.refusals}
    assert {
        BundleRefusal.DIGEST_MISMATCH,
        BundleRefusal.BYTE_COUNT_MISMATCH,
        BundleRefusal.UNDECLARED_FILE,
        BundleRefusal.MISSING_DECLARED_FILE,
        BundleRefusal.NOT_TEXT,
        BundleRefusal.MALFORMED_CAPTURE,
        BundleRefusal.MESSAGE_WITHOUT_ID,
        BundleRefusal.UNKNOWN_ROLE,
    } <= refusals
    assert normalized.counters["digest_mismatches"] == 1
    assert normalized.counters["byte_count_mismatches"] == 1
    assert normalized.counters["undeclared_files"] == 1
    assert normalized.counters["missing_declared_files"] == 1
    assert normalized.counters["not_text"] == 1
    assert normalized.counters["malformed_captures"] >= 1
    assert normalized.counters["messages_without_id"] == 1
    assert normalized.counters["unknown_roles"] == 1


def test_account_is_explicit_and_recorded() -> None:
    normalized, records = _records()
    for record in records:
        assert record.account == ACCOUNT
        if record.kind in (SourceKind.CAPTURE_WINDOW, SourceKind.CAPTURED_MESSAGE):
            assert record.payload["account_basis"] == ACCOUNT_BASIS
    with pytest.raises(BundleFormatError, match="account"):
        normalize(inventory(FIXTURE), provider=PROVIDER, account="", account_basis=ACCOUNT_BASIS)


def test_documents_are_attributed_to_their_supplier_not_the_captured_provider() -> None:
    normalized = normalize(
        inventory(FIXTURE),
        provider=PROVIDER,
        account=ACCOUNT,
        account_basis=ACCOUNT_BASIS,
        document_provider="supplier",
        document_account="keeper",
    )
    records = tuple(normalized.records)
    for record in records:
        if record.kind is SourceKind.DOCUMENT:
            assert (record.provider, record.account) == ("supplier", "keeper")
        else:
            assert (record.provider, record.account) == (PROVIDER, ACCOUNT)
    with pytest.raises(BundleFormatError, match="document_provider"):
        normalize(
            inventory(FIXTURE),
            provider=PROVIDER,
            account=ACCOUNT,
            account_basis=ACCOUNT_BASIS,
            document_provider="",
        )


def test_documents_use_manifest_attribution_and_extension_types() -> None:
    normalized, records = _records()
    documents = _by_kind(records, SourceKind.DOCUMENT)
    assert list(documents) == [
        "documents/harbour-notes.md",
        "documents/supply.json",
        "documents/watch.txt",
    ]
    assert documents["documents/harbour-notes.md"].content_type == "text/markdown"
    assert documents["documents/supply.json"].content_type == "application/json"
    assert documents["documents/watch.txt"].content_type == "text/plain"
    assert documents["documents/watch.txt"].payload["source_kind"] == "watch_note"
    assert documents["documents/watch.txt"].payload["sensitivity"] == "synthetic"
    assert documents["documents/watch.txt"].payload["sha256"] == digest_bytes(
        (FIXTURE / "documents" / "watch.txt").read_bytes()
    )
    classes = {entry.path: entry.file_class for entry in normalized.inventory.entries}
    assert classes["INPUT_MANIFEST.json"] is BundleFileClass.MANIFEST
    assert classes["capture/interface.json"] is BundleFileClass.CAPTURE


def test_undeclared_symlink_is_refused_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "link.txt").symlink_to("watch.txt")

    normalized, records = _records(root)

    assert all(record.external_id != "documents/link.txt" for record in records)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.SYMLINK_REFUSED) == 1
    assert normalized.counters["symlinks_refused"] == 1


def test_declared_file_replaced_by_symlink_after_inventory_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    inv = inventory(root)
    equal_bytes_outside_root = tmp_path / "equal-bytes.txt"
    equal_bytes_outside_root.write_bytes(declared.read_bytes())
    declared.unlink()
    declared.symlink_to(equal_bytes_outside_root)

    normalized = normalize(inv, provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS)
    records = tuple(normalized.records)

    assert all(record.external_id != "documents/watch.txt" for record in records)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.SYMLINK_REFUSED) == 1
    assert normalized.counters["symlinks_refused"] == 1


def test_equal_text_messages_keep_every_rendering(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def add_distinct_renderings(capture: dict) -> None:
        first = capture["branches"][0]["messages"][0]
        second = capture["branches"][1]["messages"][0]
        first["html"] = "<p>first rendering</p>"
        first["links"] = [{"href": "https://bundle.invalid/first", "label": "first"}]
        second["html"] = "<p>second rendering</p>"
        second["links"] = [{"href": "https://bundle.invalid/second", "label": "second"}]

    _edit_json(root / "capture" / "interface.json", add_distinct_renderings)
    _update_declaration(root, "capture/interface.json")
    normalized, records = _records(root)
    messages = _by_kind(records, SourceKind.CAPTURED_MESSAGE)

    assert len(messages) == 4
    assert messages["msg-a1"].payload["renderings"] == [
        {
            "window_index": 0,
            "html": "<p>first rendering</p>",
            "links": [{"href": "https://bundle.invalid/first", "label": "first"}],
        },
        {
            "window_index": 1,
            "html": "<p>second rendering</p>",
            "links": [{"href": "https://bundle.invalid/second", "label": "second"}],
        },
    ]
    assert BundleRefusal.INCONSISTENT_OCCURRENCES not in {item.refusal for item in normalized.refusals}


def test_uppercase_declared_sha256_matches(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def uppercase_digest(manifest: dict) -> None:
        entry = next(entry for entry in manifest["files"] if entry["path"] == "documents/watch.txt")
        entry["sha256"] = entry["sha256"].upper()

    _edit_json(root / "INPUT_MANIFEST.json", uppercase_digest)
    normalized, records = _records(root)

    assert "documents/watch.txt" in _by_kind(records, SourceKind.DOCUMENT)
    assert BundleRefusal.DIGEST_MISMATCH not in {item.refusal for item in normalized.refusals}
    assert normalized.counters["digest_mismatches"] == 0


@pytest.mark.parametrize(("field", "value"), [("source_kind", None), ("sensitivity", "")])
def test_document_declaration_requires_non_empty_attribution(
    tmp_path: Path, field: str, value: str | None
) -> None:
    root = _copy(tmp_path)

    def remove_attribution(manifest: dict) -> None:
        entry = next(entry for entry in manifest["files"] if entry["path"] == "documents/watch.txt")
        if value is None:
            entry.pop(field)
        else:
            entry[field] = value

    _edit_json(root / "INPUT_MANIFEST.json", remove_attribution)
    normalized, records = _records(root)

    assert "documents/watch.txt" not in _by_kind(records, SourceKind.DOCUMENT)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.MALFORMED_DECLARATION) == 1
    assert normalized.counters["malformed_declarations"] == 1


def test_multiple_declared_captures_refuse_all_capture_records(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    additional_capture = root / "capture" / "additional.json"
    additional_capture.write_bytes((root / "capture" / "interface.json").read_bytes())
    _declare(root, "capture/additional.json", "rendered_window_capture")

    normalized, records = _records(root)

    assert len(_by_kind(records, SourceKind.DOCUMENT)) == 3
    assert not [
        record
        for record in records
        if record.kind in (SourceKind.CAPTURE_WINDOW, SourceKind.CAPTURED_MESSAGE)
    ]
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.MULTIPLE_CAPTURES) == 1
    assert normalized.counters["multiple_captures"] == 1


def test_normalization_materializes_records_before_returning(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    normalized = normalize(
        inventory(root), provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS
    )

    assert isinstance(normalized.records, tuple)
    assert normalized.refusals == ()
    partial = iter(normalized.records)
    first = next(partial)
    counters = normalized.counters
    remaining = tuple(partial)
    fresh_count = len(
        normalize(
            inventory(root), provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS
        ).records
    )

    assert counters["documents"] == 3
    assert len((first, *remaining)) == fresh_count


def test_declared_file_deleted_after_inventory_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    inv = inventory(root)
    (root / "documents" / "watch.txt").unlink()

    normalized = normalize(inv, provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS)
    records = tuple(normalized.records)

    assert "documents/watch.txt" not in _by_kind(records, SourceKind.DOCUMENT)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.MISSING_DECLARED_FILE) == 1
    assert normalized.counters["missing_declared_files"] == 1


def test_declared_file_larger_than_bound_is_not_read_whole(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy(tmp_path)
    large = root / "documents" / "large.txt"
    with large.open("wb") as stream:
        stream.truncate(capture_bundle.MAX_FILE_BYTES + 1)

    def declare_large_file(manifest: dict) -> None:
        manifest["files"].append(
            {
                "path": "documents/large.txt",
                "bytes": capture_bundle.MAX_FILE_BYTES + 1,
                "sha256": "0" * 64,
                "source_kind": "keeper_note",
                "sensitivity": "synthetic",
            }
        )

    _edit_json(root / "INPUT_MANIFEST.json", declare_large_file)
    original_read_bytes = Path.read_bytes

    def reject_large_read(path: Path) -> bytes:
        if path == large:
            raise AssertionError("the large declared file was read")
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", reject_large_read)
    normalized = normalize(
        inventory(root), provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS
    )
    records = tuple(normalized.records)

    assert "documents/large.txt" not in _by_kind(records, SourceKind.DOCUMENT)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.TOO_LARGE) == 1
    assert normalized.counters["too_large"] == 1
