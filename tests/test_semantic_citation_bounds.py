"""Selected JSON fields bound semantic citation locations."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nous_os.identity import digest_bytes
from nous_os import semantic_index


SOURCE_ID = "src_" + "0" * 23 + "M3X"


def _locations(body: str) -> list[tuple[str, tuple[int, int], tuple[int | None, int | None, str]]]:
    raw = body.encode("utf-8")
    ranges = semantic_index._json_string_ranges(body)
    return [
        (text, ranges[path], semantic_index._citation_location(
            SOURCE_ID, digest_bytes(raw), body, text, ranges[path]
        ))
        for text, path in semantic_index._part_fields(body)
    ]


def test_citation_refuses_unique_metadata_hit_outside_selected_field() -> None:
    body = '{"payload":{"message":{"content":{"text":"caf\\u00e9"}}},"metadata":"café"}'
    original = body.encode("utf-8")

    assert semantic_index.record_parts(body) == ("café",)
    assert _locations(body) == [("café", (42, 51), (None, None, "absent"))]
    assert original[42:51] == b"caf\\u00e9"
    assert original[68:73] == "café".encode("utf-8")
    assert body.encode("utf-8") == original


def test_chunk_collection_passes_the_selected_field_range(monkeypatch: pytest.MonkeyPatch) -> None:
    body = '{"payload":{"message":{"content":{"text":"caf\\u00e9"}}},"metadata":"café"}'
    monkeypatch.setattr(semantic_index, "_tip_records", lambda _path: ((SOURCE_ID, digest_bytes(body.encode()), body),))

    chunks, indexed, empty = semantic_index._collect_chunks(Path("unused"))

    assert (indexed, empty) == (1, 0)
    assert [(item.chunk.id, item.chunk.text, item.start_byte, item.end_byte, item.citation_state)
            for item in chunks] == [(f"{SOURCE_ID}#0000", "café", None, None, "absent")]


def test_unique_in_field_hit_keeps_identical_original_byte_offsets() -> None:
    body = '{"payload":{"message":{"content":{"text":"café"}}},"metadata":"other"}'
    raw = body.encode("utf-8")
    start = raw.index("café".encode("utf-8"))
    end = start + len("café".encode("utf-8"))

    assert _locations(body) == [("café", (start, end), (start, end, "located"))]


def test_whole_body_duplicates_and_escaped_absence_keep_existing_states() -> None:
    duplicate = '{"content":{"text":"same"},"metadata":"same"}'
    escaped = '{"content":{"text":"caf\\u00e9"}}'

    assert _locations(duplicate)[0][2] == (None, None, "ambiguous")
    assert _locations(escaped)[0][2] == (None, None, "absent")


@pytest.mark.parametrize("record, paths", [
    ({"content": {"parts": ["one", 7, "two"]}},
     (("content", "parts", 0), ("content", "parts", 2))),
    ({"content": {"text": "one"}}, (("content", "text"),)),
    ({"message": {"text": "one"}}, (("message", "text"),)),
    ({"text": "one"}, (("text",),)),
    ({"kind": "message", "provider": "claude.ai", "payload": {"record": {
        "text": "fallback", "content": [{"type": "text", "text": "block"}],
    }}}, (("payload", "record", "content", 0, "text"),)),
    ({"kind": "message", "provider": "claude.ai", "payload": {"record": {
        "text": "fallback", "content": [{"type": "thinking", "text": "ignored"}],
    }}}, (("payload", "record", "text"),)),
    ({"kind": "design_message", "provider": "claude.ai", "payload": {"record": {
        "content": {"content": "intro", "contentBlocks": [{"type": "text", "text": "block"}]},
    }}}, (("payload", "record", "content", "content"),
          ("payload", "record", "content", "contentBlocks", 0, "text"))),
    ({"kind": "memory_file", "provider": "claude.ai", "payload": {"record": {"content": "Gentle rain"}}},
     (("payload", "record", "content"),)),
    ({"kind": "memory_file", "provider": "claude.ai", "payload": {"text": "fallback", "record": {}}},
     (("payload", "text"),)),
    ({"kind": "memory_summary", "provider": "claude.ai", "payload": {"record": {
        "conversations_memory": "Gentle rain",
    }}}, (("payload", "record", "conversations_memory"),)),
    ({"kind": "reflection", "provider": "claude.ai", "payload": {"record": {"content": {
        "hero_title": "Gentle rain", "topics": ["Quiet river", {"nested": "Bright moon"}],
    }}}}, (("payload", "record", "content", "hero_title"),
           ("payload", "record", "content", "topics", 0),
           ("payload", "record", "content", "topics", 1, "nested"))),
])
def test_projected_paths_follow_selected_field_ranges(record: dict, paths: tuple[tuple, ...]) -> None:
    body = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    fields = semantic_index._part_fields(body)
    assert tuple(path for _text, path in fields) == paths
    assert tuple(text for text, _path in fields) == semantic_index.record_parts(body)
    assert all(result == (*field_range, "located") for _text, field_range, result in _locations(body))


def test_original_ranges_handle_escaped_quotes_backslashes_and_duplicate_keys() -> None:
    body = '{"content":{"text":"stale","text":"a\\\"b\\\\c"},"metadata":"stale"}'
    fields = semantic_index._part_fields(body)
    ranges = semantic_index._json_string_ranges(body)
    assert fields == (('a"b\\c', ("content", "text")),)
    field_range = ranges[("content", "text")]
    assert body.encode("utf-8")[slice(*field_range)] == b'a\\"b\\\\c'
    assert _locations(body)[0][2] == (*field_range, "located")
