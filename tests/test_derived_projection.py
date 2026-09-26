"""Full-text projection keeps canon and result identity stable."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nous_os.derived import StoreUnusable, build, rebuild, search, verify
from nous_os.ledger import Ledger, ingest
from nous_os.snapshots import SnapshotStore
from nous_os.text_projection import project
from nous_os.untrusted import UntrustedText
from test_derived import SOURCE_A, SOURCE_B, SOURCE_C, SOURCE_D, _canon


def test_projected_search_crosses_escapes_and_keeps_json_excerpt(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    text = 'alpha beta\ngamma delta epsilon l’intuizione è città kā "quoted" \\ path'
    body = json.dumps({"kind": "message", "provider": "chatgpt.com",
                       "account": "metadata_only", "payload": {"content": {
                           "content_type": "text", "parts": [text]}}}, ensure_ascii=False)
    ingest(store, ledger, SOURCE_A, UntrustedText(body),
           datetime(2026, 1, 1, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)
    for query in ('"alpha beta gamma delta epsilon"', '"l intuizione è città kā"', '"l intuizione e citta ka"',
                  '"kā quoted path"'):
        hits = search(path, query)
        assert [hit.source_id for hit in hits] == [SOURCE_A]
        assert hits[0].excerpt == body[:120]
    assert not search(path, "metadata_only")
    assert not search(path, "content_type")
    assert "\\n" not in project(body)


def test_record_kinds_and_crlf_project_only_reader_text(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    records = (
        (SOURCE_A, {"kind": "message", "provider": "chatgpt.com", "payload": {
            "content": {"content_type": "reasoning_recap", "content": "violet\r\nriver"},
            "metadata": {"web_search_results": [{"title": "forbiddenmetadata"}]}}}),
        (SOURCE_B, {"kind": "message", "provider": "chatgpt.com", "payload": {
            "content": {"content_type": "thoughts", "thoughts": [{
                "content": "amber thought", "summary": "silver thought",
                "chunks": ["copper thought"], "source_analysis_msg_id": "hiddenmetadata"}]}}}),
        (SOURCE_C, {"kind": "design_message", "provider": "claude.ai", "payload": {
            "record": {"content": {"content": "design canvas",
                "contentBlocks": [{"type": "text", "text": "design block"}],
                "attachments": [{"content": "attached prose", "id": "attachmentmetadata"}]}}}}),
        (SOURCE_D, {"kind": "message", "provider": "claude.ai", "payload": {
            "record": {"text": "claude opening", "content": [
                {"type": "text", "text": "claude block"},
                {"type": "thinking", "thinking": "quiet reasoning", "summaries": ["short reasoning"]},
                {"type": "tool_result", "content": [{"title": "webresultmetadata"}]}
            ]}}}),
    )
    for source, record in records:
        ingest(store, ledger, source, UntrustedText(json.dumps(record, ensure_ascii=False)),
               datetime(2026, 1, 1, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)
    for query, source in (("\"violet river\"", SOURCE_A), ("amber", SOURCE_B),
                          ("silver", SOURCE_B), ("copper", SOURCE_B),
                          ("design canvas", SOURCE_C), ("design block", SOURCE_C),
                          ("attached prose", SOURCE_C), ("claude opening", SOURCE_D),
                          ("claude block", SOURCE_D), ("quiet reasoning", SOURCE_D)):
        assert [hit.source_id for hit in search(path, query)] == [source]
    for word in ("forbiddenmetadata", "hiddenmetadata", "attachmentmetadata",
                 "webresultmetadata", "content_type", "source_analysis_msg_id"):
        assert search(path, word) == ()


def test_ascii_ids_and_order_stay_fixed(tmp_path: Path) -> None:
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)
    hits = search(path, "coral")
    assert {hit.source_id for hit in hits} == {SOURCE_C, SOURCE_D}
    assert [hit.snapshot_digest for hit in hits] == sorted(hit.snapshot_digest for hit in hits)
    assert [hit.source_id for hit in search(path, "coral")] == [hit.source_id for hit in hits]


@pytest.mark.parametrize(("kind", "payload", "expected"), (
    ("captured_message", {"text": "first rendering", "text_content": "second rendering",
                          "occurrences": [{"id": "forbiddenmetadata"}]},
     "first rendering second rendering"),
    ("capture_window", {"buttons": [{"label": "visible button", "id": "forbiddenmetadata"}],
                        "captured_at": "forbiddenmetadata"}, "visible button"),
    ("document", {"text": "supplied document", "sha256": "forbiddenmetadata"},
     "supplied document"),
    ("memory_file", {"record": {"content": "remembered detail", "path": "forbiddenmetadata"}},
     "remembered detail"),
    ("project_document", {"record": {"content": "project note", "uuid": "forbiddenmetadata"}},
     "project note"),
    ("memory_summary", {"record": {"conversations_memory": "memory summary"}},
     "memory summary"),
    ("project", {"record": {"name": "project name", "description": "project description",
                            "prompt_template": "project prompt", "uuid": "forbiddenmetadata"}},
     "project name project description project prompt"),
    ("reflection", {"record": {"content": {"hero_title": "reflective title",
        "about_your_time": [{"title": "reflective section", "body": "reflective body"}],
        "stats": [{"id": "forbiddenmetadata"}]}}},
     "reflective title reflective section reflective body"),
    ("conversation", {"title": "conversation title", "conversation_id": "forbiddenmetadata"},
     "conversation title"),
    ("design_conversation", {"record": {"title": "design title", "uuid": "forbiddenmetadata"}},
     "design title"),
))
def test_other_record_text_fields(kind: str, payload: dict, expected: str) -> None:
    projected = project(json.dumps({"kind": kind, "payload": payload}))
    assert projected == expected
    assert "forbiddenmetadata" not in projected


def test_projection_normalizes_nfc_and_whitespace() -> None:
    assert project("citta\u0300\r\ncon  parole") == "città con parole"


def test_repeated_parts_remain_visible() -> None:
    body = json.dumps({"kind": "message", "provider": "chatgpt.com", "payload": {
        "content": {"parts": ["echo", "echo"]}}})
    assert project(body) == "echo echo"


def test_claude_text_and_single_block_are_one_field() -> None:
    body = json.dumps({"kind": "message", "provider": "claude.ai", "payload": {
        "record": {"text": "città echo", "content": [
            {"type": "text", "text": "citta\u0300\n echo"}]}}})
    assert project(body) == "città echo"


def test_design_content_and_matching_attachment_are_one_field() -> None:
    body = json.dumps({"kind": "design_message", "payload": {"record": {
        "content": {"content": "design prose", "attachments": [
            {"content": "design\n prose"}]}}}})
    assert project(body) == "design prose"


def test_legacy_json_index_misses_phrase_across_line_break(tmp_path: Path) -> None:
    body = json.dumps({"kind": "message", "provider": "chatgpt.com", "payload": {
        "content": {"parts": ["alpha\nbeta"]}}}, sort_keys=True, separators=(",", ":"))
    with sqlite3.connect(tmp_path / "phrase.sqlite3") as connection:
        connection.execute("CREATE VIRTUAL TABLE legacy USING fts5(body)")
        connection.execute("CREATE VIRTUAL TABLE plain USING fts5(body)")
        connection.execute("INSERT INTO legacy(body) VALUES (?)", (body,))
        connection.execute("INSERT INTO plain(body) VALUES (?)", (project(body),))
        legacy_hits = connection.execute(
            "SELECT count(*) FROM legacy WHERE legacy MATCH ?", ('"alpha beta"',)
        ).fetchone()[0]
        plain_hits = connection.execute(
            "SELECT count(*) FROM plain WHERE plain MATCH ?", ('"alpha beta"',)
        ).fetchone()[0]
    assert legacy_hits == 0
    assert plain_hits == 1


def test_older_schema_is_detected_and_rebuilt(tmp_path: Path) -> None:
    store, ledger, _ = _canon(tmp_path)
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)
    for version in (0, 1):
        with sqlite3.connect(path) as connection:
            connection.execute(f"PRAGMA user_version={version}")
        with pytest.raises(StoreUnusable, match="python3 -m nous_os.derived rebuild"):
            verify(path)
        with pytest.raises(StoreUnusable, match="python3 -m nous_os.derived rebuild"):
            search(path, "lighthouse")
    rebuild(store, ledger, path)
    verify(path)
    assert {hit.source_id for hit in search(path, "lighthouse")} == {SOURCE_B}
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
        with pytest.raises(sqlite3.OperationalError, match="no such table: search"):
            connection.execute("SELECT rowid FROM search WHERE search MATCH 'lighthouse'")
