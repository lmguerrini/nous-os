"""ZH14's one zero-hit retry at the product MCP boundary."""

import json

import pytest

from nous_os import core, mcp
from nous_os.capability import Grant, Tier
from nous_os.derived import SearchHit


READ = Grant("reader", frozenset({Tier.READ}))


@pytest.mark.parametrize(("query", "expected"), [
    ("the mitigation risks for project policies", "mitigation project policies"),
    ("a policy about rischio and regola", "policy rischio regola"),
    ('"spring tides reaching five" extra words', '"spring tides reaching five"'),
    ('not "spring tides" irrelevant src_ABC123', 'not "spring tides" src_ABC123'),
    ("not risks mitigation irrelevant", "not risks mitigation irrelevant"),
    ("abc_12 risks mitigation extra", "abc_12 risks mitigation extra"),
    ("a and the", "a and the"),
    ("", ""),
    ('"exact phrase"', '"exact phrase"'),
    ('"first phrase" drop "second phrase" tail', '"first phrase" "second phrase"'),
    ('NEVER "café vero" extra 42B', 'NEVER "café vero" 42B'),
    ("not NEVER without nonsense useful", "not NEVER without nonsense useful"),
    ("senza più ragione inutile", "senza ragione inutile"),
])
def test_knowledge_search_frozen_narrow_query(query: str, expected: str) -> None:
    assert mcp._narrow_query(query) == expected


def test_knowledge_search_existing_hit_is_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hit = core._render_search((SearchHit(
        "a" * 64, "src_01ARZ3NDEKTSV4RRFFQ69G5FAV", "readable match", "message",
        "assistant", "2026-01-01T00:00:00Z", "A title",
    ),))[0]
    calls = []

    def invoke(grant, name, workspace, arguments):
        calls.append((grant, name, workspace, arguments))
        return [hit]

    monkeypatch.setattr(core, "invoke", invoke)
    workspace = object()
    answer = mcp._handle_tools_call({"name": "knowledge.search", "arguments": {
        "query": "alpha beta", "limit": 3, "role": "assistant",
    }}, READ, workspace)
    assert answer == {"content": [{"type": "text", "text": json.dumps([hit], sort_keys=True, allow_nan=False)}]}
    assert calls == [(READ, "knowledge.search", workspace,
                      {"query": "alpha beta", "limit": 3, "role": "assistant"})]


def test_knowledge_search_zero_hit_retry_marks_hits_and_shows_exact_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hit = {"source_id": "fixture", "snapshot_digest": "a" * 64, "text": "match",
           "kind": "message", "role": "assistant", "created_at": None}
    calls = []

    def invoke(grant, name, workspace, arguments):
        calls.append(dict(arguments))
        return [] if len(calls) == 1 else [hit]

    monkeypatch.setattr(core, "invoke", invoke)
    answer = mcp._handle_tools_call({"name": "knowledge.search", "arguments": {
        "query": 'why "spring tides reaching five" extra words', "limit": 3, "role": "assistant",
    }}, READ, object())
    narrowed = '"spring tides reaching five"'
    assert calls == [
        {"query": 'why "spring tides reaching five" extra words', "limit": 3, "role": "assistant"},
        {"query": narrowed, "limit": 3, "role": "assistant"},
    ]
    content = answer["content"]
    assert len(content) == 2
    assert json.loads(content[0]["text"]) == [{**hit, "narrowed_query": narrowed}]
    assert json.loads(content[1]["text"]) == {"search_notice": {"narrowed_query": narrowed}}
    assert hit == {"source_id": "fixture", "snapshot_digest": "a" * 64, "text": "match",
                   "kind": "message", "role": "assistant", "created_at": None}


def test_knowledge_search_zero_hit_retry_happens_once_even_when_still_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    def invoke(grant, name, workspace, arguments):
        calls.append(dict(arguments))
        return []

    monkeypatch.setattr(core, "invoke", invoke)
    answer = mcp._handle_tools_call({"name": "knowledge.search", "arguments": {
        "query": "not risks mitigation irrelevant",
    }}, READ, object())
    assert calls == [
        {"query": "not risks mitigation irrelevant"},
        {"query": "not risks mitigation irrelevant"},
    ]
    assert json.loads(answer["content"][0]["text"]) == []
    assert json.loads(answer["content"][1]["text"]) == {
        "search_notice": {"narrowed_query": "not risks mitigation irrelevant"}}


def test_knowledge_search_retry_does_not_apply_to_other_empty_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    def invoke(grant, name, workspace, arguments):
        calls.append(name)
        return []

    monkeypatch.setattr(core, "invoke", invoke)
    answer = mcp._handle_tools_call({"name": "candidate.proposals"}, READ, object())
    assert calls == ["candidate.proposals"]
    assert answer == {"content": [{"type": "text", "text": "[]"}]}
