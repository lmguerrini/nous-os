"""Synthetic contract checks for bounded candidate retrieval."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from nous_os import candidate_search as search
from nous_os.capability import Grant, Tier
from nous_os.core import CATALOGUE, invoke, resolve_workspace
from nous_os.identity import canonical_bytes, digest_bytes


SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
OLD = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
NEW = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAA"
THIRD = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAB"


def _content(statement: str, *, notes: str | None = None, supersedes: str | None = None,
             kind: str = "DECISION", origin: str = "USER_AUTHORED") -> dict:
    result = {
        "statement": statement, "kind": kind, "scope": "synthetic.scope", "origin": origin,
        "support": "direct_quote", "citations": [{"source_id": SOURCE, "snapshot_digest": "0" * 64,
            "start_byte": 0, "end_byte": 12, "span": "Café l’amour"}],
        "counter_citations": [], "valid_from": None, "valid_to": None,
        "why": "Synthetic only", "producer": "fixture/1", "batch": "fixture",
        "supersedes": supersedes,
    }
    if notes is not None:
        result["notes"] = notes
    return result


def _write(path: Path, rows: list[tuple[str, dict]]) -> None:
    path.write_text("".join(json.dumps({"proposal_id": candidate_id, "source_id": SOURCE,
        "content": json.dumps(content, ensure_ascii=False), "proposed_at": "2026-01-01T00:00:00+00:00",
        "holder": "fixture"}, ensure_ascii=False) + "\n" for candidate_id, content in rows), encoding="utf-8")


def _paths(tmp_path: Path) -> tuple[Path, Path]:
    store, manifest = tmp_path / "candidates.jsonl", tmp_path / "replacements.jsonl"
    _write(store, [(OLD, _content("Café l’amour opens"))])
    manifest.write_text("", encoding="utf-8")
    return store, manifest


def _search(store: Path, manifest: Path | None, query: str, **kwargs) -> dict:
    return search.search_candidates(store_path=store, replacement_path=manifest,
        canon_root=None, semantic_index_path=None, derived_path=None, query=query, **kwargs)


def test_query_operators_phrases_unicode_and_escaped_spans(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    before = (hashlib.sha256(store.read_bytes()).digest(), hashlib.sha256(manifest.read_bytes()).digest())
    for query in ('"Café l’amour"', "Café", "l'amour", "l’amour", "opens OR missing", "Café*"):
        assert _search(store, manifest, query)["total_matched"] == 1
    assert _search(store, manifest, "span:Café")["total_matched"] == 0
    assert _search(store, manifest, "NEAR ( ^ ")["total_matched"] == 0
    assert before == (hashlib.sha256(store.read_bytes()).digest(), hashlib.sha256(manifest.read_bytes()).digest())


@pytest.mark.parametrize("query,code", [('', "InvalidQuery"), ('"unclosed', "InvalidQuery"),
    ('* : ^', "InvalidQuery"), ('x ' * 17, "QueryTooComplex"),
    ('* ' * 17 + 'x', "QueryTooComplex"), ('x' * 257, "QueryTooComplex"),
    ('x' + ' ' * 256 + 'y', "QueryTooComplex")])
def test_query_limits(tmp_path: Path, query: str, code: str) -> None:
    store, manifest = _paths(tmp_path)
    with pytest.raises(search.CandidateSearchError, match=f"^{code}$"):
        _search(store, manifest, query)


def test_labels_and_exact_canon_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    rows = [
        (OLD, _content("alpha recorded", notes="facet: APPROVED_DECISION")),
        (NEW, _content("alpha proposed", notes="epistemic: HYPOTHESIS; facet: APPROVED_DECISION")),
        (THIRD, _content("alpha uncertain", notes="epistemic: UNKNOWN; facet: PROPOSAL")),
    ]
    _write(store, rows)
    # The same id with another version must never become canonical.
    wrong = SimpleNamespace(candidate_id=OLD, candidate_version="0" * 64,
                            assertion=SimpleNamespace(id="asr_wrong"))
    monkeypatch.setattr(search, "canon_index", lambda _root: (wrong,))
    canon_root = tmp_path / "canon"
    canon_root.mkdir()
    answer = search.search_candidates(store_path=store, replacement_path=manifest,
        canon_root=canon_root, semantic_index_path=None, derived_path=None, query="alpha")
    by_id = {hit["candidate_id"]: hit for hit in answer["hits"]}
    assert by_id[OLD]["epistemic_label"] == "DECISION_STATED_BY_PERSON"
    assert by_id[OLD]["canonical_status"] == "non_canonical"
    assert by_id[OLD]["is_asserted"] is False
    assert by_id[NEW]["epistemic_label"] == "HYPOTHESIS"
    assert by_id[NEW]["label_basis"] == "epistemic_tag"
    assert by_id[THIRD]["epistemic_label"] == "NOT_YET_CLASSIFIED"
    assert by_id[THIRD]["label_basis"] == "epistemic_tag"
    matching = SimpleNamespace(candidate_id=OLD, candidate_version=by_id[OLD]["candidate_version"],
                               assertion=SimpleNamespace(id="asr_matching"))
    monkeypatch.setattr(search, "canon_index", lambda _root: (matching,))
    canonical = search.search_candidates(store_path=store, replacement_path=manifest,
        canon_root=canon_root, semantic_index_path=None, derived_path=None, query="alpha")
    promoted = next(hit for hit in canonical["hits"] if hit["candidate_id"] == OLD)
    assert (promoted["canonical_status"], promoted["epistemic_label"], promoted["label_basis"]) == ("canonical", "CANONICAL", "canon")
    assert promoted["wording"].startswith("Promoted canonical assertion: ")


def test_replacements_pagination_and_stale_cursor(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    _write(store, [(OLD, _content("alpha old")), (NEW, _content("alpha new")),
                   (THIRD, _content("alpha third"))])
    manifest.write_text(json.dumps({"old": OLD, "new": NEW, "ignored": 1}) + "\n", encoding="utf-8")
    current = _search(store, manifest, "alpha")
    assert current["total_matched"] == 2
    assert (current["replaced_excluded"], current["replaced_unreadable"]) == (1, 0)
    first = _search(store, manifest, "alpha", limit=1, include_replaced=True)
    second = _search(store, manifest, "alpha", limit=1, include_replaced=True,
                     cursor=first["next_cursor"])
    assert first["total_matched"] == 3
    assert (first["replaced_excluded"], first["replaced_unreadable"]) == (0, 0)
    assert first["hits"][0]["rank"] == 1 and second["hits"][0]["rank"] == 2
    assert any(hit["replaced"] and hit["superseded_by"] == NEW
               for hit in _search(store, manifest, "alpha", include_replaced=True)["hits"])
    with pytest.raises(search.CandidateSearchError, match="^StaleCursor$"):
        _search(store, manifest, "other", limit=1, include_replaced=True, cursor=first["next_cursor"])
    with pytest.raises(search.CandidateSearchError, match="^InvalidCursor$"):
        _search(store, manifest, "alpha", cursor="not-json")
    with pytest.raises(search.CandidateSearchError, match="^InvalidCursor$"):
        _search(store, manifest, "alpha", limit=1, include_replaced=True,
                cursor=first["next_cursor"] + "!")
    manifest.write_text("", encoding="utf-8")
    with pytest.raises(search.CandidateSearchError, match="^StaleCursor$"):
        _search(store, manifest, "alpha", limit=1, include_replaced=True, cursor=first["next_cursor"])


def test_refused_replaced_version_is_counted_but_never_returned(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    old = _content("alpha malformed old")
    old["valid_from"] = "not-an-instant"
    _write(store, [(OLD, old), (NEW, _content("alpha live"))])
    manifest.write_text(json.dumps({"old": OLD, "new": NEW}) + "\n", encoding="utf-8")

    default = _search(store, manifest, "alpha")
    included = _search(store, manifest, "alpha", include_replaced=True)
    for result in (default, included):
        assert result["total_matched"] == 1
        assert [hit["candidate_id"] for hit in result["hits"]] == [NEW]
        assert result["replaced_unreadable"] == 1
    assert default["replaced_excluded"] == 0
    assert included["replaced_excluded"] == 0


def test_refused_supersedes_target_is_counted(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    old = _content("alpha malformed old")
    old["valid_from"] = "not-an-instant"
    old_version = digest_bytes(canonical_bytes(old))
    _write(store, [(OLD, old), (NEW, _content("alpha live",
        supersedes=f"{OLD}@{old_version}"))])

    result = _search(store, manifest, "alpha", include_replaced=True)
    assert result["replaced_unreadable"] == 1
    assert [hit["candidate_id"] for hit in result["hits"]] == [NEW]


def test_refused_live_version_fails_even_with_replaced_version(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    old = _content("alpha malformed old")
    old["valid_from"] = "not-an-instant"
    live = _content("alpha malformed live")
    live["valid_from"] = "not-an-instant"
    _write(store, [(OLD, old), (NEW, _content("alpha valid")), (THIRD, live)])
    manifest.write_text(json.dumps({"old": OLD, "new": NEW}) + "\n", encoding="utf-8")

    with pytest.raises(search.CandidateSearchError, match="^CandidateStoreUnreadable$"):
        _search(store, manifest, "alpha")
    with pytest.raises(search.CandidateSearchError, match="^CandidateStoreUnreadable$"):
        _search(store, manifest, "alpha", include_replaced=True)


def test_supersedes_and_store_failures(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    old = _search(store, manifest, "Café")["hits"][0]
    _write(store, [(OLD, _content("alpha old")), (NEW, _content("alpha new",
        supersedes=f"{OLD}@{old['candidate_version']}"))])
    # Version above belongs to the earlier content, so this is inconsistent.
    with pytest.raises(search.CandidateSearchError, match="^ReplacementManifestInconsistent$"):
        _search(store, manifest, "alpha")
    _write(store, [(OLD, _content("Café l’amour opens")), (NEW, _content("alpha new",
        supersedes=f"{OLD}@{old['candidate_version']}"))])
    assert _search(store, manifest, "opens")["total_matched"] == 0
    with pytest.raises(search.CandidateSearchError, match="^ReplacementManifestUnavailable$"):
        _search(store, None, "alpha")
    manifest.write_text(json.dumps({"old": OLD, "new": THIRD}) + "\n", encoding="utf-8")
    with pytest.raises(search.CandidateSearchError, match="^ReplacementManifestInconsistent$"):
        _search(store, manifest, "alpha")
    store.unlink()
    with pytest.raises(search.CandidateSearchError, match="^CandidateStoreAbsent$"):
        _search(store, manifest, "alpha")
    store.write_text("malformed\n", encoding="utf-8")
    with pytest.raises(search.CandidateSearchError, match="^CandidateStoreUnreadable$"):
        _search(store, manifest, "alpha")


def test_duplicate_ids_and_limit_refused(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    with pytest.raises(search.CandidateSearchError, match="^InvalidQuery$"):
        _search(store, manifest, "Café", limit=21)
    row = store.read_text(encoding="utf-8")
    store.write_text(row + row, encoding="utf-8")
    with pytest.raises(search.CandidateSearchError, match="^CandidateStoreUnreadable$"):
        _search(store, manifest, "Café")


def test_deadlines_and_semantic_unavailable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    monkeypatch.setattr(search, "BUILD_SECONDS", -1)
    with pytest.raises(search.CandidateSearchError, match="^BuildTimeout$"):
        _search(store, manifest, "Café")
    monkeypatch.setattr(search, "BUILD_SECONDS", 20)
    with pytest.raises(search.CandidateSearchError, match="^SemanticUnavailable$"):
        _search(store, manifest, "Café", ranking="source_semantic")
    monkeypatch.setattr(search, "SEARCH_SECONDS", -1)
    with pytest.raises(search.CandidateSearchError, match="^SearchTimeout$"):
        _search(store, manifest, "Café")


def test_source_semantic_is_cited_source_ranking(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    monkeypatch.setattr(search, "semantic_search", lambda *_args, **_kwargs: {
        "status": "complete", "hits": [{"source_id": SOURCE}],
    })
    answer = _search(store, manifest, "no textual match", ranking="source_semantic")
    assert answer["ranking"] == "source_semantic"
    assert answer["total_matched"] == 1
    assert answer["hits"][0]["semantic_basis"] == "cited_source_rank"
    assert answer["hits"][0]["score"] == 0


def test_dense_asset_hit_reaches_candidate_through_derived_citation_only(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    asset_source = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"
    candidate = _content("Independent claim")
    candidate["derived_citations"] = [{
        "asset_source_id": asset_source, "asset_digest": "0" * 64,
        "extractor": "plain_text", "extractor_version": "extraction/1",
        "record_digest": "1" * 64, "start_char": 0, "end_char": 4,
        "span": "Quay",
    }]
    _write(store, [(OLD, candidate)])
    monkeypatch.setattr(search, "semantic_search", lambda *_args, **_kwargs: {
        "status": "complete", "hits": [{"source_id": asset_source}],
    })

    result = _search(store, manifest, "unmatched query", ranking="source_semantic")
    assert result["total_matched"] == 1
    assert result["hits"][0]["candidate_id"] == OLD
    assert result["hits"][0]["semantic_basis"] == "cited_source_rank"
    assert result["hits"][0]["citations"][0]["source_id"] == SOURCE
    assert result["hits"][0]["derived_citations"][0]["asset_source_id"] == asset_source


def test_dense_call_has_its_own_deadline_and_never_returns_a_partial_page(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    clock = [100.0]
    monkeypatch.setattr(search.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(search, "SEARCH_SECONDS", 2)
    monkeypatch.setattr(search, "SEMANTIC_SECONDS", 60)

    def slow_backend(*_args, **_kwargs):
        clock[0] += 8
        return {"status": "complete", "hits": [{"source_id": SOURCE}]}

    monkeypatch.setattr(search, "semantic_search", slow_backend)
    answer = _search(store, manifest, "Café", ranking="source_semantic")
    assert answer["status"] == "complete" and answer["total_matched"] == 1

    def timed_out_backend(*_args, **_kwargs):
        clock[0] += 61
        return {"status": "complete", "hits": [{"source_id": SOURCE}]}

    monkeypatch.setattr(search, "semantic_search", timed_out_backend)
    with pytest.raises(search.CandidateSearchError, match="^SearchTimeout$"):
        _search(store, manifest, "Café", ranking="source_semantic")


def test_text_standing_first_and_text_relevance_is_pure_bm25(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, manifest = _paths(tmp_path)
    _write(store, [(OLD, _content("alpha alpha alpha proposal", notes="facet: PROPOSAL")),
                   (NEW, _content("alpha personal decision")),
                   (THIRD, _content("alpha canonical", notes="facet: PROPOSAL"))])
    initial = _search(store, manifest, "alpha")
    canonical_version = next(hit["candidate_version"] for hit in initial["hits"]
                             if hit["candidate_id"] == THIRD)
    monkeypatch.setattr(search, "canon_index", lambda _root: (
        SimpleNamespace(candidate_id=THIRD, candidate_version=canonical_version,
                        assertion=SimpleNamespace(id="asr_synthetic")),))
    canon_root = tmp_path / "canon"
    canon_root.mkdir()
    result = search.search_candidates(store_path=store, replacement_path=manifest,
        canon_root=canon_root, semantic_index_path=None, derived_path=None,
        query="alpha")
    relevance = search.search_candidates(store_path=store, replacement_path=manifest,
        canon_root=canon_root, semantic_index_path=None, derived_path=None,
        query="alpha", ranking="text_relevance")
    assert result["ranking"] == "text" and relevance["ranking"] == "text_relevance"
    assert [hit["candidate_id"] for hit in result["hits"]] == [THIRD, NEW, OLD]
    assert relevance["hits"][0]["candidate_id"] == OLD
    assert [hit["score"] for hit in relevance["hits"]] == sorted(
        hit["score"] for hit in relevance["hits"])
    assert [hit["epistemic_label"] for hit in result["hits"]] == [
        "CANONICAL", "DECISION_STATED_BY_PERSON", "PROPOSAL_NOT_APPROVED"]
    assert result["hits"][1]["wording"].startswith("Recorded candidate proposal: ")
    assert result["hits"][1]["is_asserted"] is False


@pytest.mark.parametrize("ranking", ["text", "text_relevance", "source_semantic"])
def test_public_ranking_values_and_cursor_binding(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ranking: str) -> None:
    store, manifest = _paths(tmp_path)
    _write(store, [(OLD, _content("alpha first")), (NEW, _content("alpha second"))])
    monkeypatch.setattr(search, "semantic_search", lambda *_args, **_kwargs: {
        "status": "complete", "hits": [{"source_id": SOURCE}],
    })
    first = _search(store, manifest, "alpha", ranking=ranking, limit=1)
    assert first["ranking"] == ranking and first["total_matched"] == 2
    assert first["next_cursor"] is not None
    second = _search(store, manifest, "alpha", ranking=ranking, limit=1,
                     cursor=first["next_cursor"])
    assert second["hits"][0]["rank"] == 2
    other = "text_relevance" if ranking == "text" else "text"
    with pytest.raises(search.CandidateSearchError, match="^StaleCursor$"):
        _search(store, manifest, "alpha", ranking=other, limit=1,
                cursor=first["next_cursor"])


def test_unknown_ranking_is_refused(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    with pytest.raises(search.CandidateSearchError, match="^InvalidQuery$"):
        _search(store, manifest, "Café", ranking="unknown")


def test_catalogue_read_exposure(tmp_path: Path) -> None:
    store, manifest = _paths(tmp_path)
    documents = tmp_path / "documents"
    documents.mkdir()
    workspace = resolve_workspace(data_root=documents, snapshot_root=tmp_path / "snapshots",
        ledger_path=tmp_path / "ledger.jsonl", derived_path=tmp_path / "derived.sqlite",
        candidate_store_path=store, candidate_replacements_path=manifest,
        bridge_registry_path=tmp_path / "bridges.jsonl", rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl")
    descriptor = next(item for item in CATALOGUE if item.external_name == "candidate.search")
    assert descriptor.tier is Tier.READ
    ranking = next(parameter for parameter in descriptor.parameters if parameter.name == "ranking")
    assert all(value in ranking.description for value in
               ("text", "text_relevance", "source_semantic"))
    result = invoke(Grant("reader", frozenset({Tier.READ})), "candidate.search", workspace, {"query": "Café"})
    assert result["status"] == "complete" and result["hits"][0]["candidate_id"] == OLD
    relevance = invoke(Grant("reader", frozenset({Tier.READ})), "candidate.search", workspace,
                       {"query": "Café", "ranking": "text_relevance"})
    assert relevance["ranking"] == "text_relevance"


def test_cli_and_mcp_expose_the_same_read(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from nous_os import cli, mcp

    store, manifest = _paths(tmp_path)
    documents = tmp_path / "documents"
    documents.mkdir()
    locations = ["--data-root", str(documents), "--snapshot-root", str(tmp_path / "snapshots"),
        "--ledger-path", str(tmp_path / "ledger.jsonl"), "--derived-path", str(tmp_path / "derived.sqlite"),
        "--candidate-store-path", str(store), "--candidate-replacements-path", str(manifest),
        "--bridge-registry-path", str(tmp_path / "bridges.jsonl"),
        "--rejection-memory-path", str(tmp_path / "rejections.jsonl"),
        "--relation-store-path", str(tmp_path / "relations.jsonl")]
    assert cli.main([*locations, "candidate.search", "--query", "Café"]) == 0
    cli_result = json.loads(capsys.readouterr().out)
    workspace = resolve_workspace(data_root=documents, snapshot_root=tmp_path / "snapshots",
        ledger_path=tmp_path / "ledger.jsonl", derived_path=tmp_path / "derived.sqlite",
        candidate_store_path=store, candidate_replacements_path=manifest,
        bridge_registry_path=tmp_path / "bridges.jsonl", rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl")
    response = mcp.dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "candidate.search", "arguments": {"query": "Café"}}},
        Grant("reader", frozenset({Tier.READ})), workspace)
    assert response is not None and "result" in response
    mcp_result = json.loads(response["result"]["content"][0]["text"])
    assert mcp_result == cli_result
    assert cli.main([*locations, "candidate.search", "--query", "Café",
                     "--ranking", "text_relevance"]) == 0
    assert json.loads(capsys.readouterr().out)["ranking"] == "text_relevance"
    relevance_response = mcp.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "candidate.search", "arguments": {
            "query": "Café", "ranking": "text_relevance"}}},
        Grant("reader", frozenset({Tier.READ})), workspace)
    assert relevance_response is not None and "result" in relevance_response
    assert json.loads(relevance_response["result"]["content"][0]["text"])["ranking"] == "text_relevance"
