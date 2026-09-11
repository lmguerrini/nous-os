"""The manifest-1.0 assistant-export adapter, over a wholly synthetic export.

`fixtures/synthetic/export/` is invented from end to end -- a harbour office,
a lighthouse, a keeper -- and its files carry deliberately unhelpful names so
that classifying by shape is what the tests exercise. Nothing here reads any
real export.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os.assistant_export import (
    ExportFormatError,
    FileClass,
    NormalizationRefusal,
    inventory,
    normalize,
)
from nous_os.capability import Grant, Tier
from nous_os.ledger import IngestStatus, Ledger
from nous_os.snapshots import SnapshotStore
from nous_os.sources import (
    IdentityBasis,
    IdentityRegistry,
    Parentage,
    Role,
    SightingLog,
    SourceKind,
    ingest_export,
    verify_source_memory,
)

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "export"
ACCOUNT = "account-keeper"
EXPORT_ID = "synthetic-export-01"
T0 = datetime(2026, 3, 2, 9, 0, tzinfo=timezone.utc)
PROMOTE = Grant("operator", frozenset({Tier.PROMOTE}))


def _copy(tmp_path: Path, name: str = "export") -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURE, target)
    return target


def _edit(path: Path, transform) -> None:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    transform(parsed)
    path.write_text(json.dumps(parsed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _rename_export(root: Path, export_id: str) -> None:
    def transform(manifest: dict) -> None:
        for entry in manifest["data_files"]:
            entry["export_url"] = entry["export_url"].replace(EXPORT_ID, export_id)

    _edit(root / "manifest.json", transform)


class _Memory:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = SnapshotStore(root / "snapshots")
        self.ledger = Ledger(root / "ledger.jsonl")
        self.registry = IdentityRegistry(root / "identities.jsonl")
        self.sightings = SightingLog(root / "sightings.jsonl")

    def ingest(self, export_root: Path, at: datetime = T0):
        normalized = normalize(inventory(export_root))
        return normalized, ingest_export(
            grant=PROMOTE,
            store=self.store,
            ledger=self.ledger,
            registry=self.registry,
            sightings=self.sightings,
            export=normalized.inventory.export,
            records=normalized.records,
            recorded_at=at,
        )


# --- the inventory ---------------------------------------------------------------


def test_the_inventory_establishes_provider_export_and_account_from_the_input() -> None:
    inv = inventory(FIXTURE)
    assert inv.observed_provider_host == "provider.example"
    assert inv.export.provider == "provider.example"
    assert inv.export.export_id == EXPORT_ID
    assert inv.export_id_basis is IdentityBasis.PROVIDER_IDENTIFIER
    assert inv.export.created_at == "2026-03-01T08:00:00.000000+00:00"
    assert inv.export.format_version == "1.0"
    assert inv.account == ACCOUNT
    assert {entry.path: entry.file_class for entry in inv.entries} == {
        "manifest.json": FileClass.EXPORT_MANIFEST,
        "notes/refl.json": FileClass.REFLECTIONS,
        "recall/mem.json": FileClass.MEMORIES,
        "sketches/one.json": FileClass.DESIGN_CONVERSATION,
        "stray.txt": FileClass.UNCLASSIFIED,
        "talks.json": FileClass.CONVERSATIONS,
        "who/login_history.json": FileClass.ACCOUNT_METADATA,
        "who/users.json": FileClass.ACCOUNT_METADATA,
        "workspaces/proj.json": FileClass.PROJECT,
    }
    assert all(len(entry.digest) == 64 and entry.byte_length > 0 for entry in inv.entries)


def test_a_caller_may_name_the_provider_and_the_observed_host_is_still_recorded() -> None:
    inv = inventory(FIXTURE, provider="named-by-the-caller")
    assert inv.export.provider == "named-by-the-caller"
    assert inv.observed_provider_host == "provider.example"
    records = normalize(inv).records
    assert {record.provider for record in records} == {"named-by-the-caller"}


# --- O6: classification is by shape, never by name ------------------------------


def test_classification_is_by_shape_not_by_name(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    # Every file renamed to something that names a different category, or nothing.
    (root / "talks.json").rename(root / "memories.json")
    (root / "recall" / "mem.json").rename(root / "recall" / "conversations.json")
    (root / "manifest.json").rename(root / "z.json")
    (root / "sketches").rename(root / "projects")
    (root / "workspaces" / "proj.json").rename(root / "workspaces" / "design_chats.json")
    inv = inventory(root)
    classes = {entry.path: entry.file_class for entry in inv.entries}
    assert classes["memories.json"] is FileClass.CONVERSATIONS
    assert classes["recall/conversations.json"] is FileClass.MEMORIES
    assert classes["z.json"] is FileClass.EXPORT_MANIFEST
    assert classes["projects/one.json"] is FileClass.DESIGN_CONVERSATION
    assert classes["workspaces/design_chats.json"] is FileClass.PROJECT
    # Archiver residue is noise, not content, and does not become unclassified.
    (root / "__MACOSX").mkdir()
    (root / "__MACOSX" / "._talks.json").write_bytes(b"\x00\x05\x16\x07")
    (root / ".DS_Store").write_bytes(b"\x00\x00\x00\x01Bud1")
    (root / "._z.json").write_bytes(b"\x00")
    inv = inventory(root)
    assert inv.paths(FileClass.FILESYSTEM_NOISE) == (".DS_Store", "._z.json", "__MACOSX/._talks.json")
    # The one unclassifiable file is counted as a refusal, with its path.
    normalized = normalize(inv)
    assert [(item.locator, item.refusal) for item in normalized.rejected] == [
        ("stray.txt", NormalizationRefusal.UNCLASSIFIED_FILE)
    ]
    # Nothing was lost to the renaming: the same records come out.
    assert {r.identity_key for r in normalized.records} == {
        r.identity_key for r in normalize(inventory(FIXTURE)).records
    }


def test_two_manifests_are_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    shutil.copy(root / "manifest.json", root / "manifest-again.json")
    with pytest.raises(ExportFormatError, match="2 manifest"):
        inventory(root)


def test_no_manifest_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "manifest.json").unlink()
    with pytest.raises(ExportFormatError, match="0 manifest"):
        inventory(root)


def test_another_manifest_version_is_refused_not_adapted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "manifest.json", lambda manifest: manifest.__setitem__("version", "2.0"))
    with pytest.raises(ExportFormatError, match="version"):
        inventory(root)


def test_files_that_disagree_about_the_account_are_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "recall" / "mem.json", lambda memories: memories.__setitem__("account_uuid", "someone-else"))
    with pytest.raises(ExportFormatError, match="2 account"):
        inventory(root)


def test_an_export_that_changes_between_inventory_and_normalization_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    inv = inventory(root)
    _edit(root / "talks.json", lambda talks: talks[0].__setitem__("name", "changed"))
    with pytest.raises(ExportFormatError, match="changed since"):
        normalize(inv)


def test_export_identity_falls_back_to_the_manifest_bytes_when_urls_share_no_identifier(
    tmp_path: Path,
) -> None:
    root = _copy(tmp_path)

    def transform(manifest: dict) -> None:
        for index, entry in enumerate(manifest["data_files"]):
            entry["export_url"] = f"https://provider.example/download/{index}"

    _edit(root / "manifest.json", transform)
    inv = inventory(root)
    assert inv.export_id_basis is IdentityBasis.CONTENT
    assert len(inv.export.export_id) == 64


# --- the records -------------------------------------------------------------------


def test_every_provider_class_becomes_its_own_kind_and_nothing_is_lost() -> None:
    normalized = normalize(inventory(FIXTURE))
    by_kind: dict[SourceKind, list] = {}
    for record in normalized.records:
        by_kind.setdefault(record.kind, []).append(record)
    assert {kind: len(records) for kind, records in by_kind.items()} == {
        SourceKind.CONVERSATION: 3,
        SourceKind.MESSAGE: 6,
        SourceKind.DESIGN_CONVERSATION: 1,
        SourceKind.DESIGN_MESSAGE: 2,
        SourceKind.PROJECT: 1,
        SourceKind.PROJECT_DOCUMENT: 1,
        SourceKind.MEMORY_SUMMARY: 1,
        SourceKind.MEMORY_FILE: 2,
        SourceKind.REFLECTION: 1,
    }
    assert [(item.locator, item.refusal) for item in normalized.rejected] == [
        ("stray.txt", NormalizationRefusal.UNCLASSIFIED_FILE)
    ]
    # A conversation's payload holds the provider record minus its messages, plus their ids.
    conversation = next(r for r in by_kind[SourceKind.CONVERSATION] if r.payload["children"])
    assert "chat_messages" not in conversation.payload["record"]
    assert conversation.payload["record"]["name"] == "Tides at the harbour"
    assert len(conversation.payload["children"]) == 4
    assert conversation.locator == "talks.json#/0"
    # An empty conversation is still a record, with no children.
    empty = next(r for r in by_kind[SourceKind.CONVERSATION] if r.external_id == "conversation-empty")
    assert empty.payload["children"] == []
    # Every message keeps the provider's object verbatim and names its conversation.
    message = next(r for r in by_kind[SourceKind.MESSAGE] if r.external_id == "message-01")
    assert message.container_external_id == conversation.external_id
    assert message.role is Role.USER
    assert message.payload["record"]["sender"] == "human"
    assert message.locator == "talks.json#/0/chat_messages/0"
    assert message.attachments == (
        {"name": "tide-table.txt", "reference": None, "media_type": "text/plain", "byte_length": 42},
    )
    fourth = next(r for r in by_kind[SourceKind.MESSAGE] if r.external_id == "message-04")
    assert fourth.attachments == (
        {"name": "lamp.png", "reference": "file-lamp", "media_type": None, "byte_length": None},
    )
    # Memory and reflection records carry their provider category and nothing canonical.
    summary = by_kind[SourceKind.MEMORY_SUMMARY][0]
    assert summary.external_id == ACCOUNT and summary.content_type == "text/plain"
    assert {r.identity_basis for r in by_kind[SourceKind.MEMORY_FILE]} == {IdentityBasis.PROVIDER_PATH}
    assert {r.external_id for r in by_kind[SourceKind.MEMORY_FILE]} == {"areas/harbour.md", "topics/lighthouse.md"}
    reflection = by_kind[SourceKind.REFLECTION][0]
    assert reflection.identity_basis is IdentityBasis.PROVIDER_LABEL
    assert reflection.external_id == "2026-02:2026-03"
    # A project document names its project; the project names its documents.
    document = by_kind[SourceKind.PROJECT_DOCUMENT][0]
    project = by_kind[SourceKind.PROJECT][0]
    assert document.container_external_id == project.external_id
    assert project.payload["children"] == [document.external_id]
    assert "docs" not in project.payload["record"]
    # Design records keep the provider's own message shape.
    design_message = next(r for r in by_kind[SourceKind.DESIGN_MESSAGE] if r.role is Role.USER)
    assert design_message.attachments == (
        {"name": "board.png", "reference": "attachment-board", "media_type": "image", "byte_length": None},
    )
    assert "messages" not in by_kind[SourceKind.DESIGN_CONVERSATION][0].payload["record"]


# --- O3: parentage ------------------------------------------------------------------


def test_parentage_is_preserved_where_represented() -> None:
    records = normalize(inventory(FIXTURE)).records
    messages = {r.external_id: r for r in records if r.kind is SourceKind.MESSAGE}
    # A null parent is no parent; the record is a represented root.
    assert messages["message-01"].parent_external_id is None
    assert messages["message-01"].parentage is Parentage.REPRESENTED
    # Two children of one parent: a regeneration branch, both kept, both naming it.
    assert messages["message-02"].parent_external_id == "message-01"
    assert messages["message-03"].parent_external_id == "message-01"
    assert messages["message-04"].parent_external_id == "message-03"
    # A parent the export does not contain is kept verbatim, not erased and not invented.
    assert messages["message-05"].parent_external_id == "message-not-exported"
    assert messages["message-05"].parentage is Parentage.REPRESENTED
    # Design messages carry no parent field: the export cannot say, and neither does the record.
    design = [r for r in records if r.kind is SourceKind.DESIGN_MESSAGE]
    assert {r.parentage for r in design} == {Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT}
    assert {r.parent_external_id for r in design} == {None}


def test_the_providers_no_parent_sentinel_is_normalized_to_no_parent(tmp_path: Path) -> None:
    """The observed export marks a root with an all-zero identifier-shaped value, not null."""
    sentinel = "-".join(["0" * 8, "0" * 4, "4" + "0" * 3, "8" + "0" * 3, "0" * 12])
    root = _copy(tmp_path)
    _edit(root / "talks.json", lambda talks: talks[0]["chat_messages"][0].__setitem__("parent_message_uuid", sentinel))
    records = normalize(inventory(root)).records
    first = next(r for r in records if r.kind is SourceKind.MESSAGE and r.external_id == "message-01")
    assert first.parent_external_id is None
    assert first.parentage is Parentage.REPRESENTED
    assert first.payload["record"]["parent_message_uuid"] == sentinel  # the provider's value, verbatim


def test_a_message_without_a_parent_field_is_unsupported_not_a_root(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "talks.json", lambda talks: talks[1]["chat_messages"][0].pop("parent_message_uuid"))
    records = normalize(inventory(root)).records
    orphaned = next(r for r in records if r.kind is SourceKind.MESSAGE and r.external_id == "message-05")
    assert orphaned.parentage is Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT
    assert orphaned.parent_external_id is None


# --- O10: account metadata --------------------------------------------------------


def test_account_metadata_is_classified_and_not_normalized() -> None:
    inv = inventory(FIXTURE)
    assert inv.paths(FileClass.ACCOUNT_METADATA) == ("who/login_history.json", "who/users.json")
    normalized = normalize(inv)
    assert not any(record.locator.startswith("who/") for record in normalized.records)
    assert not any(item.locator.startswith("who/") for item in normalized.rejected)
    # The one thing read from it: the account identifier that scopes every record.
    assert {record.account for record in normalized.records} == {ACCOUNT}


# --- refusals inside a classified file ---------------------------------------------


def test_objects_without_an_identity_are_refused_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(talks: list) -> None:
        talks[0]["chat_messages"][1].pop("uuid")  # a message with no identity
        talks[0]["chat_messages"].append("not an object")
        talks.append({"name": "no uuid", "chat_messages": []})

    _edit(root / "talks.json", transform)
    normalized = normalize(inventory(root))
    rejected = {(item.locator, item.refusal) for item in normalized.rejected}
    assert ("talks.json#/0/chat_messages/1", NormalizationRefusal.MISSING_IDENTITY) in rejected
    assert ("talks.json#/0/chat_messages/4", NormalizationRefusal.NOT_AN_OBJECT) in rejected
    assert ("talks.json#/3", NormalizationRefusal.MISSING_IDENTITY) in rejected
    conversation = next(r for r in normalized.records if r.kind is SourceKind.CONVERSATION and r.locator == "talks.json#/0")
    assert len(conversation.payload["children"]) == 3  # the refused message is not a child


def test_feedback_items_are_identified_by_provider_id_or_visibly_by_content(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(notes: dict) -> None:
        notes["feedback"] = [
            {"uuid": "feedback-01", "text": "numbered by the provider"},
            {"text": "not numbered by the provider"},
        ]

    _edit(root / "notes" / "refl.json", transform)
    feedback = [r for r in normalize(inventory(root)).records if r.kind is SourceKind.FEEDBACK]
    assert [(r.identity_basis, r.external_id) for r in feedback[:1]] == [
        (IdentityBasis.PROVIDER_IDENTIFIER, "feedback-01")
    ]
    assert feedback[1].identity_basis is IdentityBasis.CONTENT and len(feedback[1].external_id) == 64


# --- O2 and the whole fixture through the seam ----------------------------------------


def test_the_whole_fixture_ingests_and_ingests_again_unchanged(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    normalized, first = memory.ingest(FIXTURE)
    assert first.records_offered == 18 and first.ingested == 18 and first.rejected == 0
    assert first.identities_minted == 18 and first.sightings_recorded == 18
    assert len(normalized.rejected) == 1  # stray.txt, reported by the adapter, not the seam
    _, second = memory.ingest(FIXTURE, at=T0 + timedelta(hours=1))
    assert second.unchanged == 18 and second.ingested == 0 and second.superseded == 0
    assert second.identities_minted == 0 and second.sightings_recorded == 0
    assert second.not_sighted == ()
    assert verify_source_memory(memory.registry, memory.ledger, memory.store) == ()


def test_a_title_rename_is_a_revision_of_the_same_conversation(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    _, first = memory.ingest(FIXTURE)
    before = {result.external_id: result.source_id for result in first.results}

    renamed = _copy(tmp_path, "renamed")
    _rename_export(renamed, "synthetic-export-02")
    _edit(renamed / "talks.json", lambda talks: talks[0].__setitem__("name", "Tides at the old harbour"))
    _, second = memory.ingest(renamed, at=T0 + timedelta(days=1))

    after = {result.external_id: result.source_id for result in second.results}
    assert after == before  # every identity kept, the conversation's included
    statuses = {(result.kind, result.external_id): result.status for result in second.results}
    assert statuses[(SourceKind.CONVERSATION, "conversation-tides")] is IngestStatus.SUPERSEDED
    assert sum(1 for status in statuses.values() if status is IngestStatus.SUPERSEDED) == 1
    assert second.unchanged == 17 and second.identities_minted == 0
    assert second.sightings_recorded == 18  # a new export saw every record
    conversation_id = before["conversation-tides"]
    assert len(memory.ledger.chain(conversation_id)) == 2
    assert memory.sightings.exports_for(conversation_id) == (
        EXPORT_ID,
        "synthetic-export-02",
    )


def test_an_appended_message_touches_exactly_two_records(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    memory.ingest(FIXTURE)
    grown = _copy(tmp_path, "grown")
    _rename_export(grown, "synthetic-export-03")

    def transform(talks: list) -> None:
        last = talks[0]["chat_messages"][-1]
        talks[0]["chat_messages"].append(
            {
                "uuid": "message-07",
                "text": "Noted.",
                "content": [{"type": "text", "text": "Noted."}],
                "sender": "assistant",
                "created_at": "2026-02-12T08:00:00.000000Z",
                "updated_at": "2026-02-12T08:00:00.000000Z",
                "attachments": [],
                "files": [],
                "parent_message_uuid": last["uuid"],
            }
        )

    _edit(grown / "talks.json", transform)
    _, report = memory.ingest(grown, at=T0 + timedelta(days=2))
    assert report.ingested == 1 and report.superseded == 1 and report.unchanged == 17
    assert report.identities_minted == 1


# --- findings of the first independent review, each with its own oracle ------------


def test_a_parseable_file_under_a_residue_name_is_classified_by_shape(tmp_path: Path) -> None:
    """A name pattern set aside as archiver noise must not hide content: a second manifest
    saved as a resource-fork name is still a second manifest, and a conversations file so
    named still yields its records."""
    root = _copy(tmp_path)
    shutil.copy(root / "manifest.json", root / "._manifest.json")
    with pytest.raises(ExportFormatError, match="2 manifest"):
        inventory(root)
    (root / "._manifest.json").unlink()
    (root / "__MACOSX").mkdir()
    (root / "talks.json").rename(root / "__MACOSX" / "._talks.json")
    normalized = normalize(inventory(root))
    assert {r.kind for r in normalized.records} >= {SourceKind.CONVERSATION, SourceKind.MESSAGE}
    assert inventory(root).paths(FileClass.FILESYSTEM_NOISE) == ()


def test_only_the_observed_sentinel_is_no_parent(tmp_path: Path) -> None:
    """Anything but the exact observed value is a real parent and is kept verbatim: a
    differently-versioned all-zero identifier, an ordinary identifier, and the sentinel
    with a stray newline."""
    exact = "-".join(["0" * 8, "0" * 4, "4" + "0" * 3, "8" + "0" * 3, "0" * 12])
    version_one = "-".join(["0" * 8, "0" * 4, "1" + "0" * 3, "a" + "0" * 3, "0" * 12])
    ordinary = "-".join(["7d3f1c2a", "9b4e", "4a6d", "8c1f", "0e5b2a7c9d31"])
    cases = ((exact, None), (version_one, version_one), (ordinary, ordinary), (exact + "\n", exact + "\n"))
    for index, (parent, expected) in enumerate(cases):
        root = _copy(tmp_path, f"case-{index}")
        _edit(root / "talks.json", lambda talks, parent=parent: talks[0]["chat_messages"][0].__setitem__("parent_message_uuid", parent))
        first = next(
            r for r in normalize(inventory(root)).records
            if r.kind is SourceKind.MESSAGE and r.external_id == "message-01"
        )
        assert first.parent_external_id == expected, parent
        assert first.parentage is Parentage.REPRESENTED


def test_malformed_elements_are_refused_with_locators_not_raised(tmp_path: Path) -> None:
    """Classification tolerates a malformed element so one bad row does not unclassify a
    file; the inventory's own reads must tolerate it too, or the caller gets a raw
    exception instead of an inventory."""
    root = _copy(tmp_path)
    _edit(root / "talks.json", lambda talks: talks.append("not an object"))
    _edit(root / "sketches" / "one.json", lambda design: design.__setitem__("messages", 5))
    _edit(root / "who" / "login_history.json", lambda history: history.__setitem__("login_events", 7))
    _edit(root / "who" / "users.json", lambda users: users.append("a string"))
    normalized = normalize(inventory(root))
    rejected = {(item.locator, item.refusal) for item in normalized.rejected}
    assert ("talks.json#/3", NormalizationRefusal.NOT_AN_OBJECT) in rejected
    assert ("sketches/one.json#/messages", NormalizationRefusal.NOT_AN_OBJECT) in rejected
    assert any(r.kind is SourceKind.CONVERSATION for r in normalized.records)
