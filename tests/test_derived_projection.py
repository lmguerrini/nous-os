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


def test_projected_search_crosses_escapes_and_returns_readable_text(tmp_path: Path) -> None:
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
        assert "alpha" in hits[0].text or "intuizione" in hits[0].text or "quoted" in hits[0].text
        assert not any(key in hits[0].text for key in (
            '"kind"', '"provider"', '"account"', '"payload"',
            '"content_type"', '"parts"',
        ))
        assert hits[0].source_id == SOURCE_A
        assert hits[0].snapshot_digest
        assert hits[0].kind == "message"


def test_punctuated_natural_queries_retry_without_changing_valid_fts(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    body = json.dumps({"kind": "message", "provider": "chatgpt.com", "role": "assistant",
                       "created_at": "2026-01-01T00:00:00Z", "payload": {
                           "title": "Friendly heading",
                           "content": {"parts": ["L'intuizione, città? risposta chiara"]}}}, ensure_ascii=False)
    ingest(store, ledger, SOURCE_A, UntrustedText(body), datetime(2026, 1, 1, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)
    punctuated = search(path, "L'intuizione, città?")
    assert len(punctuated) == 1
    assert punctuated[0].source_id == SOURCE_A
    assert punctuated[0].snapshot_digest
    assert "L'intuizione" in punctuated[0].text
    assert punctuated[0].kind == "message"
    assert punctuated[0].role == "assistant"
    assert punctuated[0].created_at == "2026-01-01T00:00:00Z"
    assert punctuated[0].title == "Friendly heading"
    assert search(path, '"città"') == punctuated
    assert search(path, '"absent" OR "città"') == punctuated
    assert not search(path, "metadata_only")
    assert not search(path, "content_type")
    assert "\\n" not in project(body)


def test_punctuated_natural_question_uses_or_when_only_some_tokens_match(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    body = json.dumps({"kind": "message", "provider": "chatgpt.com", "payload": {
        "content": {"parts": ["A violet lagoon appears at dusk"]}}})
    ingest(store, ledger, SOURCE_A, UntrustedText(body), datetime(2026, 1, 1, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)

    hits = search(path, "Where can the violet lagoon be found?")
    assert [hit.source_id for hit in hits] == [SOURCE_A]
    assert "lagoon" in hits[0].text


def test_title_is_omitted_for_missing_title_and_unparseable_json(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    envelope = json.dumps({"kind": "message", "provider": "chatgpt.com", "payload": {
        "content": {"parts": ["readable bluebird prose"]}}})
    ingest(store, ledger, SOURCE_A, UntrustedText(envelope),
           datetime(2026, 1, 1, tzinfo=timezone.utc))
    ingest(store, ledger, SOURCE_B, UntrustedText("not-json readable amberbird prose"),
           datetime(2026, 1, 2, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)

    cases = (("bluebird", SOURCE_A, "bluebird"), ("amberbird", SOURCE_B, "amberbird"))
    for query, source_id, expected_text in cases:
        hits = search(path, query)
        assert [hit.source_id for hit in hits] == [source_id]
        assert expected_text in hits[0].text
        assert hits[0].title is None


def test_long_match_returns_a_bounded_snippet_with_ellipsis(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    words = [f"word{index}" for index in range(80)]
    words[40] = "distinctivematch"
    ingest(store, ledger, SOURCE_A, UntrustedText(" ".join(words)),
           datetime(2026, 1, 1, tzinfo=timezone.utc))
    path = tmp_path / "derived.sqlite3"
    build(store, ledger, path)

    hits = search(path, "distinctivematch")
    assert len(hits) == 1
    assert "distinctivematch" in hits[0].text
    assert "…" in hits[0].text
    assert len(hits[0].text) < len(" ".join(words))
    assert len(hits[0].text.split()) <= 26


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
