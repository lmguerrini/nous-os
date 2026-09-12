"""The sharded conversation-mapping export adapter, proved on an invented harbour.

Every path here is the synthetic fixture under ``fixtures/synthetic/mapping-export``
or a copy of it edited in a temporary directory. Nothing is a real export.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os.capability import Grant, Tier
from nous_os.identity import digest_bytes
from nous_os.ledger import IngestStatus, Ledger
from nous_os.mapping_export import (
    ExportFormatError,
    MappingFileClass,
    MappingRefusal,
    inventory,
    normalize,
)
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

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "mapping-export"
PROVIDER = "lighthouse.example"
ACCOUNT = "account-keeper"
T0 = datetime(2026, 9, 6, 9, 0, tzinfo=timezone.utc)
PROMOTE = Grant("operator", frozenset({Tier.PROMOTE}))
RECORDS_IN_FIXTURE = 19  # 4 conversations, 11 messages, 4 assets


def _copy(tmp_path: Path, name: str = "export") -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURE, target)
    return target


def _edit(path: Path, transform) -> None:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    transform(parsed)
    path.write_text(json.dumps(parsed, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def _redeclare(root: Path) -> None:
    """Rewrite the manifest's sizes after an edit, so the manifest still describes the files."""

    def transform(manifest: dict) -> None:
        for entry in manifest["export_files"]:
            path = root / entry["path"]
            if path.exists():
                entry["size_bytes"] = path.stat().st_size

    _edit(root / "export_manifest.json", transform)


def _requested_at(root: Path, value: str) -> None:
    _edit(root / "sites" / "export_manifest.json", lambda site: site.__setitem__("requested_at", value))


class _Memory:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = SnapshotStore(root / "snapshots")
        self.ledger = Ledger(root / "ledger.jsonl")
        self.registry = IdentityRegistry(root / "identities.jsonl")
        self.sightings = SightingLog(root / "sightings.jsonl")

    def ingest(self, export_root: Path, at: datetime = T0):
        normalized = normalize(inventory(export_root, provider=PROVIDER))
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

    def digest(self) -> dict[str, str]:
        tree = hashlib.sha256()
        for path in sorted((self.root / "snapshots").rglob("*")):
            if path.is_file():
                tree.update(path.name.encode())
                tree.update(path.read_bytes())
        return {
            "ledger": digest_bytes(self.ledger.path.read_bytes()),
            "identities": digest_bytes(self.registry.path.read_bytes()),
            "sightings": digest_bytes(self.sightings.path.read_bytes()),
            "snapshots": tree.hexdigest(),
        }


def _by_kind(records, kind: SourceKind) -> dict:
    return {record.external_id: record for record in records if record.kind is kind}


# --- the inventory ---------------------------------------------------------------------


def test_the_inventory_classifies_every_declared_file_and_anchors_the_export() -> None:
    inv = inventory(FIXTURE, provider=PROVIDER)
    classes = {entry.path: entry.file_class for entry in inv.entries}
    assert classes == {
        "export_manifest.json": MappingFileClass.EXPORT_MANIFEST,
        "sites/export_manifest.json": MappingFileClass.SITE_MANIFEST,
        "conversations-000.json": MappingFileClass.CONVERSATION_SHARD,
        "conversations-001.json": MappingFileClass.CONVERSATION_SHARD,
        "library_files.json": MappingFileClass.ASSET_INDEX,
        "conversation_asset_file_names.json": MappingFileClass.ASSET_NAME_MAP,
        "file_chart01.dat": MappingFileClass.ASSET,
        "file-oil-ledger.dat": MappingFileClass.ASSET,
        "file_recipe.dat": MappingFileClass.ASSET,
        "file_sketch.dat": MappingFileClass.ASSET,
        "chat.html": MappingFileClass.RENDERED_TRANSCRIPT,
        "user.json": MappingFileClass.ACCOUNT_METADATA,
        "user_settings.json": MappingFileClass.OPAQUE_METADATA,
        "ads.json": MappingFileClass.OPAQUE_METADATA,
    }
    assert inv.account == ACCOUNT
    assert inv.export.provider == PROVIDER
    assert inv.export.created_at == "2026-09-05T06:00:00+00:00"
    assert inv.export.format_version == "1"
    # The manifest's own bytes name the export, visibly a content basis.
    assert inv.export.export_id == digest_bytes((FIXTURE / "export_manifest.json").read_bytes())
    assert inv.export_id_basis is IdentityBasis.CONTENT
    for entry in inv.entries:
        assert entry.digest == digest_bytes((FIXTURE / entry.path).read_bytes())


def test_the_caller_must_name_the_provider() -> None:
    with pytest.raises(ExportFormatError, match="provider"):
        inventory(FIXTURE, provider="")


def test_an_uploaded_json_file_the_index_points_at_is_an_asset_not_a_structured_file(tmp_path: Path) -> None:
    """A parseable upload that happens to look like an account object or a name map stays an asset."""
    root = _copy(tmp_path)
    (root / "file_recipe.dat").write_text(json.dumps({"id": "impostor", "email": "impostor-at-example"}))
    _redeclare(root)
    inv = inventory(root, provider=PROVIDER)
    assert inv.account == ACCOUNT
    assert dict((e.path, e.file_class) for e in inv.entries)["file_recipe.dat"] is MappingFileClass.ASSET


def test_a_missing_declared_file_and_an_undeclared_file_are_both_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "file_recipe.dat").unlink()
    (root / "stray.txt").write_text("not declared by anyone\n")
    inv = inventory(root, provider=PROVIDER)
    classes = {entry.path: entry.file_class for entry in inv.entries}
    assert classes["file_recipe.dat"] is MappingFileClass.MISSING
    assert classes["stray.txt"] is MappingFileClass.UNDECLARED
    normalized = normalize(inv)
    refusals = {(item.locator, item.refusal) for item in normalized.rejected}
    assert ("file_recipe.dat", MappingRefusal.MISSING_DECLARED_FILE) in refusals
    assert ("stray.txt", MappingRefusal.UNDECLARED_FILE) in refusals
    assert normalized.index_entries_without_file == 2  # the expired image, and now the recipe


def test_another_manifest_version_two_manifests_or_no_request_time_are_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path, "version")
    _edit(root / "export_manifest.json", lambda manifest: manifest.__setitem__("version", 2))
    with pytest.raises(ExportFormatError, match="version"):
        inventory(root, provider=PROVIDER)

    root = _copy(tmp_path, "two")
    shutil.copy(root / "export_manifest.json", root / "export_manifest_copy.json")
    with pytest.raises(ExportFormatError, match="2 manifest-shaped"):
        inventory(root, provider=PROVIDER)

    root = _copy(tmp_path, "unanchored")
    _requested_at(root, "")
    with pytest.raises(ExportFormatError, match="request time"):
        inventory(root, provider=PROVIDER)


def test_an_export_that_changes_between_inventory_and_normalization_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    inv = inventory(root, provider=PROVIDER)
    (root / "conversations-001.json").write_text("[]\n")
    with pytest.raises(ExportFormatError, match="not stable"):
        normalize(inv)


# --- the records ------------------------------------------------------------------------


def test_normalization_is_deterministic() -> None:
    inv = inventory(FIXTURE, provider=PROVIDER)
    first, second = normalize(inv), normalize(inv)
    assert [r.external_id for r in first.records] == [r.external_id for r in second.records]
    assert [r.snapshot_bytes() for r in first.records] == [r.snapshot_bytes() for r in second.records]
    assert len(first.records) == RECORDS_IN_FIXTURE and first.rejected == ()


def test_identities_parentage_and_times() -> None:
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    conversations = _by_kind(normalized.records, SourceKind.CONVERSATION)
    messages = _by_kind(normalized.records, SourceKind.MESSAGE)
    assets = _by_kind(normalized.records, SourceKind.ASSET)
    assert set(conversations) == {"conversation-tides", "conversation-lamp", "conversation-bell", "conversation-buoy"}
    assert set(messages) == {
        "msg-tide-01", "msg-tide-02", "msg-tide-03", "msg-tide-04", "msg-tide-02b",
        "msg-lamp-01", "msg-lamp-02", "msg-lamp-03", "msg-bell-01", "msg-buoy-01", "msg-buoy-02",
    }
    assert set(assets) == {"file_chart01", "file-oil-ledger", "file_recipe", "file_sketch"}
    for record in normalized.records:
        assert record.identity_basis is IdentityBasis.PROVIDER_IDENTIFIER
        assert record.account == ACCOUNT and record.provider == PROVIDER

    tides = conversations["conversation-tides"]
    assert "mapping" not in tides.payload
    assert tides.payload["node_ids"] == [
        "node-root-tides", "msg-tide-01", "msg-tide-02", "msg-tide-03", "msg-tide-04", "msg-tide-02b",
    ]
    assert tides.payload["nodes"]["msg-tide-01"] == {"parent": "node-root-tides", "children": ["msg-tide-02"]}
    assert tides.container_external_id is None
    assert conversations["conversation-lamp"].container_external_id == "g-p-harbour-project"
    # Epoch seconds rendered once, in UTC, to the microsecond, fraction or not.
    assert tides.created_at == "2026-09-10T00:26:40.250000+00:00"
    assert tides.updated_at == "2026-09-10T00:36:40.500000+00:00"
    assert messages["msg-tide-02"].created_at == "2026-09-10T00:26:42.000000+00:00"

    first = messages["msg-tide-01"]
    assert first.parent_external_id is None and first.parentage is Parentage.REPRESENTED
    assert first.container_external_id == "conversation-tides" and first.role is Role.USER
    assert messages["msg-tide-02"].parent_external_id == "msg-tide-01"
    assert messages["msg-tide-02"].role is Role.ASSISTANT
    # The provider's message object is the payload, verbatim.
    assert messages["msg-tide-03"].payload["content"]["content_type"] == "thoughts"
    assert messages["msg-tide-04"].payload["content"] == {"content_type": "reasoning_recap", "content": "Reasoned over the almanac."}
    assert messages["msg-lamp-01"].payload["metadata"]["attachments"][0]["id"] == "file_chart01"


def test_a_branch_is_two_children_of_one_parent() -> None:
    """The regeneration names the same parent through its pointer, whatever the children list says."""
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    messages = _by_kind(normalized.records, SourceKind.MESSAGE)
    assert messages["msg-tide-02"].parent_external_id == "msg-tide-01"
    assert messages["msg-tide-02b"].parent_external_id == "msg-tide-01"
    tides = _by_kind(normalized.records, SourceKind.CONVERSATION)["conversation-tides"]
    assert tides.payload["nodes"]["msg-tide-01"]["children"] == ["msg-tide-02"]  # kept as the export wrote it
    assert "msg-tide-02b" in tides.payload["node_ids"]
    assert normalized.dangling_parents == 0


def test_a_parent_the_mapping_does_not_hold_is_kept_verbatim_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(shard: list) -> None:
        shard[1]["mapping"]["msg-lamp-02"]["parent"] = "msg-vanished"

    _edit(root / "conversations-000.json", transform)
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert _by_kind(normalized.records, SourceKind.MESSAGE)["msg-lamp-02"].parent_external_id == "msg-vanished"
    assert normalized.dangling_parents == 1


def test_assets_are_identified_and_linked_not_normalized() -> None:
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    assets = _by_kind(normalized.records, SourceKind.ASSET)
    chart = assets["file_chart01"]
    chart_bytes = (FIXTURE / "file_chart01.dat").read_bytes()
    assert chart.payload["digest"] == digest_bytes(chart_bytes)
    assert chart.payload["byte_length"] == len(chart_bytes)
    assert chart.payload["detected_type"] == "text/plain"
    assert chart.payload["given_name"] == "harbour-chart.png"
    assert chart.payload["declared_mimes"] == ["image/png"]
    assert chart.payload["referenced_by"] == ["msg-lamp-01"]
    assert chart.payload["index"]["origination_message_id"] == "msg-lamp-01"
    assert chart.locator == "file_chart01.dat"
    # The bytes of the file are not in the snapshot.
    assert chart_bytes.strip() not in chart.snapshot_bytes()
    recipe = assets["file_recipe"]
    assert recipe.payload["detected_type"] == "application/json"
    assert recipe.payload["referenced_by"] == [] and recipe.payload["given_name"] is None
    assert recipe.payload["index"]["library_file_category"] == "upload"
    ledger_asset = assets["file-oil-ledger"]
    assert ledger_asset.payload["referenced_by"] == ["msg-lamp-03"]
    assert ledger_asset.payload["index"] == {}
    # Message records carry their references as the message made them.
    lamp_03 = _by_kind(normalized.records, SourceKind.MESSAGE)["msg-lamp-03"]
    assert [ref["asset_id"] for ref in lamp_03.attachments] == ["file-oil-ledger", "file_gone"]


def test_dangling_and_duplicate_assets(tmp_path: Path) -> None:
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    assert normalized.dangling_asset_references == 1  # file_gone, referenced by msg-lamp-03
    assert normalized.index_entries_without_file == 1  # the expired image in the index
    assert "file_gone" not in _by_kind(normalized.records, SourceKind.ASSET)

    root = _copy(tmp_path)
    shutil.copy(root / "file_chart01.dat", root / "file_chart02.dat")
    _edit(root / "conversation_asset_file_names.json", lambda names: names.__setitem__("file_chart02.dat", "harbour-chart-again.png"))

    def declare(manifest: dict) -> None:
        manifest["export_files"].append({"path": "file_chart02.dat", "size_bytes": (root / "file_chart02.dat").stat().st_size})
        manifest["logical_files"]["file_chart02.dat"] = {"files": ["file_chart02.dat"], "sharded": False}

    _edit(root / "export_manifest.json", declare)
    _redeclare(root)
    assets = _by_kind(normalize(inventory(root, provider=PROVIDER)).records, SourceKind.ASSET)
    assert assets["file_chart01"].payload["digest"] == assets["file_chart02"].payload["digest"]
    assert assets["file_chart02"].external_id == "file_chart02"  # two provider files, two records


def test_binary_types_are_detected_from_the_first_bytes() -> None:
    from nous_os.mapping_export import _detected_type

    assert _detected_type(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) == "image/png"
    assert _detected_type(b"\xff\xd8\xff\xe0" + b"\x00" * 8) == "image/jpeg"
    assert _detected_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert _detected_type(b"%PDF-1.7\n") == "application/pdf"
    assert _detected_type(b"PK\x03\x04\x14\x00") == "application/zip"
    assert _detected_type(b"\x00\x00\x00\x18ftypmp42") == "video/mp4"
    assert _detected_type(b"  {\"a\": 1}") == "application/json"
    assert _detected_type("plain words\n".encode()) == "text/plain"
    assert _detected_type(b"\x00\x01\x02\xff\xfe") == "application/octet-stream"


def test_every_deviation_is_refused_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(shard: list) -> None:
        shard.append("not an object")
        shard.append({"conversation_id": "no-mapping", "mapping": "not a mapping"})
        shard.append({"mapping": {}})  # no identity
        tides = shard[0]["mapping"]
        tides["msg-tide-04"]["message"]["author"]["role"] = "lighthouse"
        tides["msg-tide-03"]["message"]["create_time"] = "yesterday"
        tides["msg-tide-02b"]["message"]["id"] = ""
        tides["node-odd"] = {"id": "node-odd", "parent": "msg-tide-01", "children": [], "message": "text, not an object"}

    _edit(root / "conversations-000.json", transform)
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    refusals = sorted((item.locator, item.refusal.value) for item in normalized.rejected)
    assert refusals == [
        ("conversations-000.json#/0/mapping/msg-tide-02b", "missing_identity"),
        ("conversations-000.json#/0/mapping/msg-tide-03", "malformed_time"),
        ("conversations-000.json#/0/mapping/msg-tide-04", "unknown_role"),
        ("conversations-000.json#/0/mapping/node-odd", "not_an_object"),
        ("conversations-000.json#/2", "not_an_object"),
        ("conversations-000.json#/3", "malformed_mapping"),
        ("conversations-000.json#/4", "missing_identity"),
    ]
    # Everything well formed is still there.
    assert len(normalized.records) == RECORDS_IN_FIXTURE - 3


def test_account_data_yields_no_record() -> None:
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    for record in normalized.records:
        assert record.account == ACCOUNT
        assert "keeper-at-the-lighthouse" not in record.snapshot_bytes().decode()
    assert not [r for r in normalized.records if r.kind not in (SourceKind.CONVERSATION, SourceKind.MESSAGE, SourceKind.ASSET)]


# --- through the seam -----------------------------------------------------------------------


def test_the_same_export_twice_writes_nothing(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    normalized, first = memory.ingest(FIXTURE)
    assert first.records_offered == RECORDS_IN_FIXTURE and first.ingested == RECORDS_IN_FIXTURE
    assert first.identities_minted == RECORDS_IN_FIXTURE and first.sightings_recorded == RECORDS_IN_FIXTURE
    assert first.rejected == 0 and normalized.rejected == ()
    before = memory.digest()
    _, second = memory.ingest(FIXTURE, at=T0 + timedelta(hours=1))
    assert second.unchanged == RECORDS_IN_FIXTURE and second.ingested == 0 and second.superseded == 0
    assert second.identities_minted == 0 and second.sightings_recorded == 0
    assert memory.digest() == before
    assert verify_source_memory(memory.registry, memory.ledger, memory.store, memory.sightings) == ()


def test_a_title_rename_in_a_later_export_is_one_revision(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    _, first = memory.ingest(FIXTURE)
    before = {result.external_id: result.source_id for result in first.results}
    later = _copy(tmp_path, "later")
    _edit(later / "conversations-001.json", lambda shard: shard[0].__setitem__("title", "Fog bell schedule, revised"))
    _requested_at(later, "2026-09-06T06:00:00+00:00")
    _redeclare(later)
    _, second = memory.ingest(later, at=T0 + timedelta(days=1))
    after = {result.external_id: result.source_id for result in second.results}
    assert after == before
    statuses = {(result.kind, result.external_id): result.status for result in second.results}
    assert statuses[(SourceKind.CONVERSATION, "conversation-bell")] is IngestStatus.SUPERSEDED
    assert sum(1 for status in statuses.values() if status is IngestStatus.SUPERSEDED) == 1
    assert second.unchanged == RECORDS_IN_FIXTURE - 1 and second.identities_minted == 0
    assert second.sightings_recorded == RECORDS_IN_FIXTURE  # a new export saw every record
    assert len(memory.ledger.chain(before["conversation-bell"])) == 2


def test_an_appended_message_touches_exactly_two_records(tmp_path: Path) -> None:
    memory = _Memory(tmp_path / "memory")
    memory.ingest(FIXTURE)
    grown = _copy(tmp_path, "grown")

    def transform(shard: list) -> None:
        bell = shard[0]["mapping"]
        bell["msg-bell-02"] = {
            "id": "msg-bell-02", "parent": "msg-bell-01", "children": [],
            "message": {"id": "msg-bell-02", "author": {"role": "assistant"}, "create_time": 1789002002.0,
                        "content": {"content_type": "text", "parts": ["Two minutes it is."]}, "metadata": {}},
        }

    _edit(grown / "conversations-001.json", transform)
    _requested_at(grown, "2026-09-07T06:00:00+00:00")
    _redeclare(grown)
    _, report = memory.ingest(grown, at=T0 + timedelta(days=2))
    assert report.ingested == 1 and report.superseded == 1 and report.unchanged == RECORDS_IN_FIXTURE - 1
    assert report.identities_minted == 1


# --- findings of the independent review, each with its own oracle ---------------------------


def test_a_declared_shard_that_is_not_a_list_is_refused_not_opaque(tmp_path: Path) -> None:
    """The manifest declares which files are shards; a shard holding a bare number is refused, and the
    conversations it should have held are visibly missing rather than silently dropped."""
    root = _copy(tmp_path)
    (root / "conversations-001.json").write_text("[17]\n")
    _redeclare(root)
    inv = inventory(root, provider=PROVIDER)
    assert dict((e.path, e.file_class) for e in inv.entries)["conversations-001.json"] is MappingFileClass.CONVERSATION_SHARD
    normalized = normalize(inv)
    assert ("conversations-001.json#/0", MappingRefusal.NOT_AN_OBJECT) in {(r.locator, r.refusal) for r in normalized.rejected}
    (root / "conversations-001.json").write_text('{"not": "a list"}\n')
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert ("conversations-001.json", MappingRefusal.SHAPE_MISMATCH) in {(r.locator, r.refusal) for r in normalized.rejected}
    # bell and buoy gone (two conversations, three messages); the sketch, pointed at only by a buoy message,
    # is then a declared file nothing points at: classified by its own shape and refused, never dropped
    assert len(normalized.records) == RECORDS_IN_FIXTURE - 6
    assert ("file_sketch.dat", MappingRefusal.UNCLASSIFIED_FILE) in {(r.locator, r.refusal) for r in normalized.rejected}
    (root / "conversations-001.json").write_text("[]\n")
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert [r.refusal for r in normalized.rejected] == [MappingRefusal.UNCLASSIFIED_FILE]  # an empty shard is a shard
    assert len(normalized.records) == RECORDS_IN_FIXTURE - 6


def test_malformed_asset_index_elements_are_refused_and_the_rest_still_read(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(index: list) -> None:
        index.append(17)
        index.append({"mime_type": "image/png"})  # no identity

    _edit(root / "library_files.json", transform)
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    refusals = {(r.locator, r.refusal) for r in normalized.rejected}
    assert ("library_files.json#/3", MappingRefusal.NOT_AN_OBJECT) in refusals
    assert ("library_files.json#/4", MappingRefusal.MISSING_IDENTITY) in refusals
    assert len(normalized.records) == RECORDS_IN_FIXTURE
    assert _by_kind(normalized.records, SourceKind.ASSET)["file_recipe"].payload["index"]["library_file_category"] == "upload"


def test_an_asset_is_matched_by_name_or_stem_whatever_its_extension(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "file_recipe.dat").rename(root / "file_recipe.bin")
    _edit(root / "export_manifest.json", lambda m: [e.__setitem__("path", "file_recipe.bin") for e in m["export_files"] if e["path"] == "file_recipe.dat"])
    _edit(root / "export_manifest.json", lambda m: m["logical_files"].__setitem__("file_recipe.bin", m["logical_files"].pop("file_recipe.dat")))
    _redeclare(root)
    inv = inventory(root, provider=PROVIDER)
    assert dict((e.path, e.file_class) for e in inv.entries)["file_recipe.bin"] is MappingFileClass.ASSET
    assets = _by_kind(normalize(inv).records, SourceKind.ASSET)
    assert assets["file_recipe"].locator == "file_recipe.bin"
    # A name-map key without any extension still names its file.
    root = _copy(tmp_path, "bare")
    (root / "file_chart01.dat").rename(root / "file_chart01")
    _edit(root / "export_manifest.json", lambda m: [e.__setitem__("path", "file_chart01") for e in m["export_files"] if e["path"] == "file_chart01.dat"])
    _edit(root / "export_manifest.json", lambda m: m["logical_files"].__setitem__("file_chart01", m["logical_files"].pop("file_chart01.dat")))
    _redeclare(root)
    assert dict((e.path, e.file_class) for e in inventory(root, provider=PROVIDER).entries)["file_chart01"] is MappingFileClass.ASSET


def test_a_conversation_with_a_malformed_time_is_refused_but_its_messages_are_kept(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "conversations-001.json", lambda shard: shard[0].__setitem__("create_time", "not-an-epoch"))
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert ("conversations-001.json#/0", MappingRefusal.MALFORMED_TIME) in {(r.locator, r.refusal) for r in normalized.rejected}
    assert "conversation-bell" not in _by_kind(normalized.records, SourceKind.CONVERSATION)
    assert _by_kind(normalized.records, SourceKind.MESSAGE)["msg-bell-01"].container_external_id == "conversation-bell"
    # A non-finite number is malformed too, and never raises.
    (root / "conversations-001.json").write_text((root / "conversations-001.json").read_text().replace('"create_time": "not-an-epoch"', '"create_time": NaN'))
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert ("conversations-001.json#/0", MappingRefusal.MALFORMED_TIME) in {(r.locator, r.refusal) for r in normalized.rejected}


def test_a_name_map_entry_without_a_file_is_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "conversation_asset_file_names.json", lambda names: names.__setitem__("file_missing.dat", "missing.png"))
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert normalized.name_map_entries_without_file == 1
    assert "file_missing" not in _by_kind(normalized.records, SourceKind.ASSET)


def test_a_path_declared_twice_is_read_once_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "export_manifest.json", lambda m: m["export_files"].append(dict(m["export_files"][0])))
    inv = inventory(root, provider=PROVIDER)
    assert inv.duplicate_declarations == 1
    assert len([e for e in inv.entries if e.path == inv.entries[0].path]) == 1


def test_node_ids_need_not_equal_message_ids_and_parents_name_messages() -> None:
    """The buoy conversation's nodes are n0..n2; its message records name each other, never the nodes."""
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    messages = _by_kind(normalized.records, SourceKind.MESSAGE)
    assert messages["msg-buoy-01"].parent_external_id is None  # child of the root node n0
    assert messages["msg-buoy-02"].parent_external_id == "msg-buoy-01"  # n1's message, not "n1"
    buoy = _by_kind(normalized.records, SourceKind.CONVERSATION)["conversation-buoy"]
    assert buoy.payload["node_ids"] == ["n0", "n1", "n2"]
    assert buoy.payload["nodes"]["n2"] == {"parent": "n1", "children": []}


def test_a_file_only_a_message_points_at_is_an_asset() -> None:
    normalized = normalize(inventory(FIXTURE, provider=PROVIDER))
    sketch = _by_kind(normalized.records, SourceKind.ASSET)["file_sketch"]
    assert sketch.payload["referenced_by"] == ["msg-buoy-01"]
    assert sketch.payload["given_name"] is None and sketch.payload["index"] == {}


def test_a_pointer_carrying_upload_settles_no_other_file(tmp_path: Path) -> None:
    """An uploaded JSON shaped like a shard that points at another file: it is an asset, its pointers are
    not believed, and the other file is classified by its own shape and refused rather than vanishing."""
    root = _copy(tmp_path)
    (root / "file_recipe.dat").write_text(json.dumps([{"conversation_id": "smuggled", "mapping": {"n": {"id": "n", "parent": None, "children": [], "message": {"id": "smuggled-msg", "author": {"role": "user"}, "create_time": 1.0, "content": {"content_type": "multimodal_text", "parts": [{"content_type": "image_asset_pointer", "asset_pointer": "store://file_hidden"}]}, "metadata": {}}}}}]))
    (root / "file_hidden.dat").write_bytes(b"\x00\x01\x02\x03")

    def declare(manifest: dict) -> None:
        manifest["export_files"].append({"path": "file_hidden.dat", "size_bytes": 4})
        manifest["logical_files"]["file_hidden.dat"] = {"files": ["file_hidden.dat"], "sharded": False}

    _edit(root / "export_manifest.json", declare)
    _redeclare(root)
    inv = inventory(root, provider=PROVIDER)
    classes = {e.path: e.file_class for e in inv.entries}
    assert classes["file_recipe.dat"] is MappingFileClass.ASSET
    assert classes["file_hidden.dat"] is MappingFileClass.UNCLASSIFIED
    normalized = normalize(inv)
    assert ("file_hidden.dat", MappingRefusal.UNCLASSIFIED_FILE) in {(r.locator, r.refusal) for r in normalized.rejected}
    assert "smuggled" not in _by_kind(normalized.records, SourceKind.CONVERSATION)
    assert "file_hidden" not in _by_kind(normalized.records, SourceKind.ASSET)


def test_a_manifest_shaped_upload_does_not_make_the_export_ambiguous(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "file_recipe.dat").write_text(json.dumps({"version": 1, "manifest_file": "x", "export_files": [], "logical_files": {}}))
    _redeclare(root)
    inv = inventory(root, provider=PROVIDER)
    classes = {e.path: e.file_class for e in inv.entries}
    assert classes["export_manifest.json"] is MappingFileClass.EXPORT_MANIFEST
    assert classes["file_recipe.dat"] is MappingFileClass.ASSET


def test_a_settings_object_of_strings_is_opaque_and_its_values_reach_no_record() -> None:
    inv = inventory(FIXTURE, provider=PROVIDER)
    classes = {e.path: e.file_class for e in inv.entries}
    assert classes["user_settings.json"] is MappingFileClass.OPAQUE_METADATA
    assert classes["conversation_asset_file_names.json"] is MappingFileClass.ASSET_NAME_MAP
    normalized = normalize(inv)
    for record in normalized.records:
        assert b"a-setting-that-names-an-asset" not in record.snapshot_bytes()
    assert _by_kind(normalized.records, SourceKind.ASSET)["file_chart01"].payload["given_name"] == "harbour-chart.png"


def test_parent_pointers_that_are_not_identifiers_or_name_malformed_nodes_are_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def transform(shard: list) -> None:
        buoy = shard[1]["mapping"]
        buoy["n2"]["parent"] = 7  # not an identifier
        buoy["n3"] = {"id": "n3", "parent": "n1", "children": [], "message": {"id": "", "author": {"role": "user"}, "create_time": 1.0, "content": {"content_type": "text", "parts": ["x"]}, "metadata": {}}}
        buoy["n4"] = {"id": "n4", "parent": "n3", "children": [], "message": {"id": "msg-buoy-04", "author": {"role": "assistant"}, "create_time": 2.0, "content": {"content_type": "text", "parts": ["y"]}, "metadata": {}}}

    _edit(root / "conversations-001.json", transform)
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    messages = _by_kind(normalized.records, SourceKind.MESSAGE)
    assert messages["msg-buoy-02"].parent_external_id is None
    assert messages["msg-buoy-04"].parent_external_id == "n3"  # the malformed parent's node id, verbatim
    assert normalized.dangling_parents == 2
    assert ("conversations-001.json#/1/mapping/n3", MappingRefusal.MISSING_IDENTITY) in {(r.locator, r.refusal) for r in normalized.rejected}


def test_a_boolean_version_and_a_non_list_export_files_are_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path, "bool")
    _edit(root / "export_manifest.json", lambda m: m.__setitem__("version", True))
    with pytest.raises(ExportFormatError, match="version"):
        inventory(root, provider=PROVIDER)
    root = _copy(tmp_path, "files")
    _edit(root / "export_manifest.json", lambda m: m.__setitem__("export_files", 5))
    with pytest.raises(ExportFormatError, match="export_files"):
        inventory(root, provider=PROVIDER)


def test_an_unrepresentable_time_is_refused_not_raised(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    _edit(root / "conversations-001.json", lambda shard: shard[0]["mapping"]["msg-bell-01"]["message"].__setitem__("create_time", 1e300))
    _redeclare(root)
    normalized = normalize(inventory(root, provider=PROVIDER))
    assert ("conversations-001.json#/0/mapping/msg-bell-01", MappingRefusal.MALFORMED_TIME) in {(r.locator, r.refusal) for r in normalized.rejected}
    assert len(normalized.records) == RECORDS_IN_FIXTURE - 1
