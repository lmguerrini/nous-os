"""The derived record header fields make conversation context readable."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import nous_os.core as core
import nous_os.derived as derived
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier
from nous_os.ledger import Ledger, ingest
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText
from test_derived import _canon


CONVERSATION = "src_01CRZ3NDEKTSV4RRFFQ69G5FAB"
M1 = "src_01CRZ3NDEKTSV4RRFFQ69G5FAC"
M2 = "src_01CRZ3NDEKTSV4RRFFQ69G5FAD"
M3 = "src_01CRZ3NDEKTSV4RRFFQ69G5FAE"
M2B = "src_01CRZ3NDEKTSV4RRFFQ69G5FAF"
NO_CONTAINER = "src_01CRZ3NDEKTSV4RRFFQ69G5FAG"
NON_JSON = "src_01CRZ3NDEKTSV4RRFFQ69G5FAH"
UNKNOWN = "src_01CRZ3NDEKTSV4RRFFQ69G5FAJ"
MISSING_CREATED_AT = "src_01CRZ3NDEKTSV4RRFFQ69G5FAK"
NUMERIC_CREATED_AT = "src_01CRZ3NDEKTSV4RRFFQ69G5FAM"
TIE_LOW = "src_01CRZ3NDEKTSV4RRFFQ69G5FAN"
TIE_HIGH = "src_01CRZ3NDEKTSV4RRFFQ69G5FAP"
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _header(**fields: object) -> str:
    return json.dumps(fields, separators=(",", ":"), sort_keys=True)


def _context_canon(tmp_path: Path) -> tuple[SnapshotStore, Ledger, Path]:
    """A conversation, its fork, two non-conversation cases, and a tip update."""
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    bodies = (
        (
            CONVERSATION,
            _header(kind="conversation", provider="adapter", external_id="C1", created_at="2026-01-01T00:00:00Z"),
        ),
        (
            M1,
            _header(kind="message", provider="adapter", external_id="m1", container_external_id="C1", role="user", created_at="2026-01-01T01:00:00Z"),
        ),
        (
            M2,
            _header(kind="message", provider="adapter", external_id="m2", container_external_id="C1", parent_external_id="m1", role="assistant", created_at="2026-01-01T02:00:00Z"),
        ),
        # Ingest the higher source id first: the timestamp tie must still use source_id.
        (
            TIE_HIGH,
            _header(kind="message", provider="adapter", external_id="tie-high", container_external_id="C1", parent_external_id="m2", role="assistant", created_at="2026-01-01T02:30:00Z"),
        ),
        (
            TIE_LOW,
            _header(kind="message", provider="adapter", external_id="tie-low", container_external_id="C1", parent_external_id="m2", role="assistant", created_at="2026-01-01T02:30:00Z"),
        ),
        (
            M3,
            _header(kind="message", provider="adapter", external_id="m3", container_external_id="C1", parent_external_id="m2", role="assistant", created_at="2026-01-01T03:00:00Z"),
        ),
        (
            M2B,
            _header(kind="message", provider="adapter", external_id="m2b", container_external_id="C1", parent_external_id="m1", role="assistant", created_at="2026-01-01T04:00:00Z"),
        ),
        (
            MISSING_CREATED_AT,
            _header(kind="message", provider="adapter", external_id="missing-created-at", container_external_id="C1", role="assistant"),
        ),
        (
            NUMERIC_CREATED_AT,
            _header(kind="message", provider="adapter", external_id="numeric-created-at", container_external_id="C1", role="assistant", created_at=1),
        ),
        (
            NO_CONTAINER,
            _header(kind="document", provider="adapter", external_id="standalone", role="system", created_at="2026-01-01T05:00:00Z"),
        ),
        (NON_JSON, "this body is not JSON"),
    )
    for offset, (source_id, body) in enumerate(bodies):
        ingest(store, ledger, source_id, UntrustedText(body), T0 + timedelta(minutes=offset))
    ingest(
        store,
        ledger,
        M3,
        UntrustedText(
            _header(
                kind="message",
                provider="adapter",
                external_id="m3",
                container_external_id="C1",
                parent_external_id="m2",
                role="assistant-tip",
                created_at="2026-01-01T03:00:00Z",
            )
        ),
        T0 + timedelta(days=1),
    )
    return store, ledger, tmp_path


def _reverse_tie_scan_order(path: Path) -> None:
    """Ensure a missing ORDER BY source_id cannot inherit the build's row order."""
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE INDEX test_reverse_tie_scan ON record("
            "container_external_id, created_at IS NULL, created_at, source_id DESC)"
        )
        connection.commit()
    finally:
        connection.close()


def test_record_rows_keep_rebuild_byte_identical_to_a_direct_build(tmp_path: Path) -> None:
    """O1: the pre-existing canon fixture now populates the record index too."""
    store, ledger, base = _canon(tmp_path)
    rebuilt = base / "rebuilt.sqlite"
    direct = base / "direct.sqlite"
    derived.build(store, ledger, rebuilt)
    derived.rebuild(store, ledger, rebuilt)
    derived.build(store, ledger, direct)

    connection = sqlite3.connect(rebuilt)
    try:
        assert connection.execute("SELECT count(*) FROM record").fetchone()[0] > 0
    finally:
        connection.close()
    assert derived.state_digest(rebuilt) == derived.state_digest(direct)


def test_context_by_source_and_container_uses_tip_records_in_created_order(tmp_path: Path) -> None:
    """O2: source windows and container reads use the documented total order."""
    store, ledger, base = _context_canon(tmp_path)
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)
    _reverse_tie_scan_order(path)

    answer = derived.context(path, source_id=M2, before=1, after=1)
    assert answer["container"] == "C1"
    assert answer["position"] == 1
    assert answer["total"] == 8
    assert [record["external_id"] for record in answer["before"]] == ["m1"]
    assert [record["external_id"] for record in answer["after"]] == ["tie-low"]

    wider = derived.context(path, source_id=M2, before=1, after=2)
    assert [record["external_id"] for record in wider["after"]] == ["tie-low", "tie-high"]
    assert [record["source_id"] for record in wider["after"]] == [TIE_LOW, TIE_HIGH]

    tip = derived.context(path, source_id=M3)
    assert tip["target"]["role"] == "assistant-tip"
    assert tip["target"]["body"].endswith('"role":"assistant-tip"}')

    container = derived.context(path, container="C1", limit=8)
    assert container["total"] == 8
    assert container["offset"] == 0
    assert container["limit"] == 8
    assert container["returned"] == 8
    assert container["has_more"] is False
    assert container["next_offset"] is None
    assert [record["external_id"] for record in container["records"]] == [
        "m1",
        "m2",
        "tie-low",
        "tie-high",
        "m3",
        "m2b",
        "missing-created-at",
        "numeric-created-at",
    ]
    assert [record["source_id"] for record in container["records"][-2:]] == [
        MISSING_CREATED_AT,
        NUMERIC_CREATED_AT,
    ]


def test_context_container_pages_walk_stable_order_and_validate_offset(tmp_path: Path) -> None:
    store, ledger, base = _context_canon(tmp_path)
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)
    expected = [
        "m1", "m2", "tie-low", "tie-high", "m3", "m2b", "missing-created-at", "numeric-created-at",
    ]
    page = derived.context(path, container="C1", limit=3)
    seen: list[str] = []
    while True:
        seen.extend(record["external_id"] for record in page["records"])
        if not page["has_more"]:
            assert page["next_offset"] is None
            break
        page = derived.context(path, container="C1", limit=3, offset=page["next_offset"])
    assert seen == expected
    assert page["offset"] == 6
    assert page["returned"] == 2
    for offset in (8, 12, 2**63):
        empty = derived.context(path, container="C1", offset=offset)
        assert empty["records"] == []
        assert empty["has_more"] is False
        assert empty["next_offset"] is None
    for offset in (-1, True, 1.5, "1"):
        with pytest.raises(derived.QueryError, match="offset"):
            derived.context(path, container="C1", offset=offset)
    with pytest.raises(derived.QueryError, match="only valid with container"):
        derived.context(path, source_id=M1, offset=1)


def test_context_container_pages_more_than_default_limit(tmp_path: Path) -> None:
    store, ledger, base = _context_canon(tmp_path)
    for index in range(31):
        source_id = f"src_01CRZ3NDEKTSV4RRFFQ69G5F{index:02X}"
        ingest(
            store,
            ledger,
            source_id,
            UntrustedText(_header(
                kind="message",
                provider="adapter",
                external_id=f"bulk-{index:02d}",
                container_external_id="bulk-container",
                role="user",
                created_at=f"2026-02-01T00:{index:02d}:00Z",
            )),
            T0 + timedelta(minutes=index),
        )
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)
    first = derived.context(path, container="bulk-container", limit=30)
    second = derived.context(path, container="bulk-container", limit=30, offset=first["next_offset"])
    records = first["records"] + second["records"]
    assert first["limit"] == second["limit"] == 30
    assert first["returned"] == 30
    assert first["has_more"] is True
    assert second["returned"] == 1
    assert second["has_more"] is False
    assert second["next_offset"] is None
    assert [record["external_id"] for record in records] == [f"bulk-{index:02d}" for index in range(31)]
    assert len({record["source_id"] for record in records}) == 31


def test_context_offset_catalogue_and_core_binding(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    grant = Grant("reader", frozenset({Tier.READ}))
    expected = ("source_id", "container", "before", "after", "limit", "offset", "view", "max_chars")
    direct = core.invoke(grant, "system.capabilities", workspace, {})
    operation = next(item for item in direct["operations"] if item["name"] == "knowledge.context")
    assert tuple(parameter["name"] for parameter in operation["parameters"]) == expected
    bound = core._bind_context(workspace, {"container": "C1", "offset": 4})
    assert bound["offset"] == 4


def test_context_refusals_missing_headers_and_legacy_index_are_named(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O3: query shape, missing sources, no container, and missing schema stay distinct."""
    store, ledger, base = _context_canon(tmp_path)
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)

    with pytest.raises(derived.DerivedStoreError, match="not in the derived index"):
        derived.context(path, source_id=UNKNOWN)
    no_container = derived.context(path, source_id=NO_CONTAINER)
    assert no_container["container"] is None
    assert no_container["before"] == []
    assert no_container["after"] == []
    assert no_container["note"] == "no container recorded"
    non_json = derived.context(path, source_id=NON_JSON)
    assert non_json["target"]["kind"] is None
    assert non_json["target"]["external_id"] is None
    with pytest.raises(derived.QueryError, match="exactly one of source_id or container"):
        derived.context(path)
    with pytest.raises(derived.QueryError, match="exactly one of source_id or container"):
        derived.context(path, source_id=M1, container="C1")

    old_schema = tuple(
        statement
        for statement in derived.SCHEMA
        if not statement.startswith("CREATE TABLE record ")
        and not statement.startswith("CREATE INDEX record_container ")
    )
    monkeypatch.setattr(derived, "SCHEMA", old_schema)
    legacy = base / "legacy.sqlite"
    derived.build(store, ledger, legacy)
    with pytest.raises(derived.StoreUnusable, match="record"):
        derived.context(legacy, source_id=M1)


def _workspace(tmp_path: Path) -> core.Workspace:
    data_root = tmp_path / "documents"
    data_root.mkdir()
    return core.resolve_workspace(
        data_root=data_root,
        snapshot_root=tmp_path / "snapshots",
        ledger_path=tmp_path / "ledger.jsonl",
        derived_path=tmp_path / "derived.sqlite",
        candidate_store_path=tmp_path / "candidates.jsonl",
        bridge_registry_path=tmp_path / "bridges.jsonl",
        rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl",
    )


def test_context_catalogue_parameters_match_through_both_transports(tmp_path: Path) -> None:
    """O4: both catalogue readers expose context parameters in order."""
    workspace = _workspace(tmp_path)
    grant = Grant("reader", frozenset({Tier.READ}))
    expected = ("source_id", "container", "before", "after", "limit", "offset", "view", "max_chars")
    direct = core.invoke(grant, "system.capabilities", workspace, {})
    direct_context = next(item for item in direct["operations"] if item["name"] == "knowledge.context")
    assert tuple(parameter["name"] for parameter in direct_context["parameters"]) == expected

    response = mcp.dispatch(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "system.capabilities", "arguments": {}},
        },
        grant,
        workspace,
    )
    assert response is not None
    payload = json.loads(response["result"]["content"][0]["text"])
    mcp_context = next(item for item in payload["operations"] if item["name"] == "knowledge.context")
    assert tuple(parameter["name"] for parameter in mcp_context["parameters"]) == expected


def test_context_text_view_projects_and_truncates_source_and_container_records(tmp_path: Path) -> None:
    store, ledger, base = _context_canon(tmp_path)
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)
    connection = sqlite3.connect(path)
    try:
        connection.execute("UPDATE search_plain SET body = ? WHERE source_id = ?", ("x" * 250, M2))
        connection.commit()
    finally:
        connection.close()

    full = derived.context(path, source_id=M2)
    text = derived.context(path, source_id=M2, view="text", max_chars=200)
    assert text["target"]["source_id"] == full["target"]["source_id"]
    assert "body" not in text["target"]
    assert text["target"]["text"] == "x" * 200
    assert text["target"]["text_chars"] == 250
    assert text["target"]["text_truncated"] is True
    assert text["view"]["name"] == "text"
    assert all("body" not in record and isinstance(record["text"], str) for record in text["before"] + text["after"])

    container = derived.context(path, container="C1", view="text", max_chars=200)
    assert all("body" not in record and "text_chars" in record for record in container["records"])
    assert all(len(record["text"]) <= 200 for record in container["records"])


def test_context_text_missing_projection_and_invalid_arguments(tmp_path: Path) -> None:
    store, ledger, base = _context_canon(tmp_path)
    path = base / "derived.sqlite"
    derived.build(store, ledger, path)
    connection = sqlite3.connect(path)
    try:
        connection.execute("DELETE FROM search_plain WHERE source_id = ?", (NO_CONTAINER,))
        connection.commit()
    finally:
        connection.close()
    absent = derived.context(path, source_id=NO_CONTAINER, view="text")
    assert absent["target"]["text"] is None
    assert absent["target"]["text_chars"] is None
    assert absent["target"]["text_truncated"] is False
    for kwargs in ({"view": "compact"}, {"view": "full", "max_chars": 300}, {"view": "text", "max_chars": 199}):
        with pytest.raises(derived.QueryError):
            derived.context(path, source_id=M1, **kwargs)
