"""Persistent dense retrieval over a derived-store tip corpus."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
import nous_os.semantic_index as semantic_index
from nous_os.capability import Grant, Tier
from nous_os.derived import build as build_derived
from nous_os.derived import rebuild as rebuild_derived
from nous_os.ledger import Ledger, ingest
from nous_os.provenance import Citation, Locator, quote_lint, read_span
from nous_os.semantic import DENSE_EN, ModelSpec, OnnxBackend, SemanticError
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText


def _sid(tail: str) -> str:
    return "src_" + tail.rjust(26, "0")


LIGHTHOUSE = _sid("BEACN")
BAKING = _sid("BAKE")
LONG = _sid("PARA")
DUPLICATE = _sid("TWNN")
EMPTY = _sid("ASSET")
RECOVERY = _sid("RECVR")
TIP = _sid("TNP")
TIE_FIRST = _sid("TADA")
TIE_SECOND = _sid("TADB")
EXTRA = _sid("EXTRA")

_DENSE_BACKEND: OnnxBackend | None = None
_DENSE_REASON: str | None = None


def _require_dense_en() -> OnnxBackend:
    """Load the cached encoder once, visibly skipping model-dependent pins if absent."""
    global _DENSE_BACKEND, _DENSE_REASON
    if _DENSE_BACKEND is None and _DENSE_REASON is None:
        try:
            _DENSE_BACKEND = OnnxBackend(DENSE_EN)
        except SemanticError as error:
            _DENSE_REASON = str(error)
    if _DENSE_REASON is not None:
        pytest.skip(_DENSE_REASON)
    assert _DENSE_BACKEND is not None
    return _DENSE_BACKEND


def _message(parts: list[object]) -> str:
    return json.dumps({"payload": {"message": {"content": {"parts": parts}}}}, ensure_ascii=False)


def _semantic_canon(tmp_path: Path) -> tuple[SnapshotStore, Path]:
    """Build tip records spanning text, duplicated text, emptiness, recovery, and supersession."""
    store = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    paragraph = " ".join(f"paragraphword{number}" for number in range(70))
    duplicate = " ".join(["repeated"] * 70)
    records = (
        (LIGHTHOUSE, _message(["The beacon guides ships through the safe harbour channel at night."])),
        (BAKING, _message(["Knead bread dough, let it rise, then bake a golden loaf."])),
        (LONG, _message([paragraph + " first.\n", paragraph + " second.\n", paragraph + " third."])),
        (DUPLICATE, _message([duplicate + "\n\n" + duplicate])),
        (EMPTY, _message([1, {"asset": "image"}])),
        (RECOVERY, json.dumps({"text": "Recovered notes describe an offline archive."})),
        (TIP, _message(["obsolete draft about an old subject"])),
        (TIE_FIRST, _message(["Two sources share precisely this retrieval text."])),
        (TIE_SECOND, _message(["Two sources share precisely this retrieval text."])),
    )
    for offset, (source_id, body) in enumerate(records):
        ingest(store, ledger, source_id, UntrustedText(body), at + timedelta(minutes=offset))
    ingest(
        store,
        ledger,
        TIP,
        UntrustedText(_message(["newest release note describes the durable tip record"])),
        at + timedelta(days=1),
    )
    derived_path = tmp_path / "derived.sqlite"
    build_derived(store, ledger, derived_path)
    return store, derived_path


def _minimal_generation(
    index_path: Path,
    *,
    include_chunk: bool = False,
    backend: str = "NOT-CACHED",
    repo_id: str = "no/such-local-checkpoint",
) -> Path:
    """Write a structurally valid small generation without needing model weights."""
    chunk_id = _sid("MINI") + "#0000"
    vectors = b"\0\0\0\0" if include_chunk else b""
    ids = (chunk_id,) if include_chunk else ()
    digest = semantic_index._state_digest(ids, vectors)
    generation = index_path / f"gen-{digest}"
    generation.mkdir(parents=True)
    (generation / "vectors.f32").write_bytes(vectors)
    metadata = {
        "format": "1",
        "projection": "v1",
        "chunk_max_tokens": "120",
        "backend": backend,
        "repo_id": repo_id,
        "onnx_filename": "onnx/model.onnx",
        "tokenizer_filename": "tokenizer.json",
        "checkpoint_digest": "0" * 64,
        "tokenizer_digest": "0" * 64,
        "max_tokens": "256",
        "batch_size": "32",
        "dimension": "1",
        "chunks": "1" if include_chunk else "0",
        "records_indexed": "1" if include_chunk else "0",
        "records_empty": "0",
        "derived_digest": "0" * 64,
        "state_digest": digest,
    }
    connection = sqlite3.connect(generation / "index.sqlite3")
    try:
        connection.execute("PRAGMA page_size=4096")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("CREATE TABLE meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        connection.execute(
            "CREATE TABLE chunk(chunk_id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL,"
            "snapshot_digest TEXT NOT NULL, ordinal INTEGER NOT NULL, heading_path TEXT NOT NULL,"
            "text TEXT NOT NULL, start_byte INTEGER, end_byte INTEGER, citation_state TEXT NOT NULL)"
        )
        connection.executemany(
            "INSERT INTO meta VALUES (?, ?)",
            [(key, metadata[key]) for key in semantic_index._META_KEYS],
        )
        if include_chunk:
            connection.execute(
                "INSERT INTO chunk VALUES (?, ?, ?, 0, '[]', 'small text', NULL, NULL, 'absent')",
                (chunk_id, _sid("MINI"), "0" * 64),
            )
        connection.commit()
        connection.execute("VACUUM")
        connection.commit()
    finally:
        connection.close()
    (index_path / "CURRENT").write_text(generation.name + "\n", encoding="utf-8")
    return generation


def _workspace(tmp_path: Path, semantic_path: Path | None = None) -> core.Workspace:
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
        semantic_index_path=semantic_path,
        environ={},
    )


def test_record_text_pins_text_projection_v1() -> None:
    """O1: only the fixed nested text shapes contribute a projected document."""
    assert semantic_index.record_text(_message(["one", 2, "two"])) == "one\ntwo"
    assert semantic_index.record_text(json.dumps({"payload": {"message": {"content": {"text": "body"}}}})) == "body"
    assert semantic_index.record_text(json.dumps({"payload": {"message": {"text": "message"}}})) == "message"
    assert semantic_index.record_text(json.dumps({"text": "recovered"})) == "recovered"
    assert semantic_index.record_text(json.dumps({"payload": {"message": {"content": {"thoughts": ["no"]}}}})) == ""
    assert semantic_index.record_text("not JSON") == ""
    assert semantic_index.record_text("[]") == ""


def test_build_is_byte_identical_across_rebuilds_and_worker_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O1: generation bytes, the index digest, idempotence, publication failure, and not-run are pinned."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    parallel_root = tmp_path / "parallel"
    first = semantic_index.build(derived_path, first_root, DENSE_EN, workers=1)
    second = semantic_index.build(derived_path, second_root, DENSE_EN, workers=1)
    parallel = semantic_index.build(derived_path, parallel_root, DENSE_EN, workers=2)
    first_generation = first_root / first.generation  # type: ignore[operator]
    second_generation = second_root / second.generation  # type: ignore[operator]
    parallel_generation = parallel_root / parallel.generation  # type: ignore[operator]
    for name in ("index.sqlite3", "vectors.f32"):
        assert (first_generation / name).read_bytes() == (second_generation / name).read_bytes()
        assert (first_generation / name).read_bytes() == (parallel_generation / name).read_bytes()
    verified = semantic_index.verify(first_root)
    assert first.state_digest == verified["state_digest"] == first.generation.removeprefix("gen-")
    again = semantic_index.build(derived_path, first_root, DENSE_EN)
    assert again.generation == first.generation
    assert [path.name for path in first_root.glob("gen-*")] == [first.generation]
    old_generation = first.generation
    ledger = Ledger(tmp_path / "ledger.jsonl")
    ingest(
        _store,
        ledger,
        EXTRA,
        UntrustedText(_message(["An extra record makes this derived store different."])),
        datetime(2026, 1, 3, tzinfo=timezone.utc),
    )
    rebuild_derived(_store, ledger, derived_path)
    failed_generation: list[str] = []

    def fail_staged_verify(rebuild_root: Path) -> dict[str, str]:
        failed_generation.append((rebuild_root / "CURRENT").read_text(encoding="utf-8").strip())
        raise RuntimeError("injected verify")

    with monkeypatch.context() as scoped:
        scoped.setattr(semantic_index, "verify", fail_staged_verify)
        with pytest.raises(RuntimeError, match="injected verify"):
            semantic_index.build(derived_path, first_root, DENSE_EN)
    assert failed_generation and failed_generation[0] != old_generation
    new_generation = failed_generation[0]
    assert (first_root / "CURRENT").read_text(encoding="utf-8").strip() == old_generation
    assert not (first_root / new_generation).exists()
    assert [path.name for path in first_root.glob("gen-*")] == [old_generation]
    assert not list(first_root.glob(".rebuild-*"))
    assert not (first_root / "CURRENT.tmp").exists()
    assert semantic_index.verify(first_root)["current"] == old_generation
    original_replace = os.replace

    def fail_current_replace(source: os.PathLike[str] | str, destination: os.PathLike[str] | str) -> None:
        if Path(source).name == "CURRENT.tmp" and Path(destination).name == "CURRENT":
            raise OSError("injected CURRENT publish")
        original_replace(source, destination)

    with monkeypatch.context() as scoped:
        scoped.setattr(os, "replace", fail_current_replace)
        with pytest.raises(OSError, match="injected CURRENT publish"):
            semantic_index.build(derived_path, first_root, DENSE_EN)
    assert (first_root / "CURRENT").read_text(encoding="utf-8").strip() == old_generation
    assert not (first_root / new_generation).exists()
    assert [path.name for path in first_root.glob("gen-*")] == [old_generation]
    assert not list(first_root.glob(".rebuild-*"))
    assert not (first_root / "CURRENT.tmp").exists()
    assert semantic_index.verify(first_root)["current"] == old_generation
    unavailable_root = tmp_path / "unavailable"
    not_run = semantic_index.build(
        derived_path,
        unavailable_root,
        ModelSpec("MISSING", "no/such-local-checkpoint"),
    )
    assert not_run.status == "not_run" and not_run.reason
    assert not unavailable_root.exists()


def test_search_pins_ranking_distinct_tip_selection_and_citations(tmp_path: Path) -> None:
    """O2: ranking reads only tips and every located result is quote-lintable canon text."""
    _require_dense_en()
    store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    answer = semantic_index.search(index_path, "beacon navigation for ships entering a harbour", limit=100)
    assert answer["status"] == "complete"
    hits = answer["hits"]
    assert hits[0]["source_id"] == LIGHTHOUSE
    assert [hit["rank"] for hit in hits] == list(range(1, len(hits) + 1))
    assert all("obsolete draft" not in hit["text"] for hit in hits)
    assert any(hit["source_id"] == TIP and "newest release" in hit["text"] for hit in hits)
    connection = sqlite3.connect(index_path / f"gen-{answer['index_digest']}" / "index.sqlite3")
    try:
        chunk_ids = {row[0] for row in connection.execute("SELECT chunk_id FROM chunk")}
    finally:
        connection.close()
    assert {hit["chunk_id"] for hit in hits} <= chunk_ids
    for hit in hits:
        citation = hit["citation"]
        if citation is None:
            continue
        checked = Citation(
            citation["source_id"],
            citation["snapshot_digest"],
            Locator(citation["start_byte"], citation["end_byte"]),
            citation["span"],
        )
        assert read_span(store, checked) == citation["span"]
        quote_lint(store, checked)
        assert citation["span"] == json.dumps(hit["text"], ensure_ascii=False)[1:-1]
    duplicate_hits = [hit for hit in hits if hit["source_id"] == DUPLICATE]
    assert duplicate_hits and all(hit["citation"] is None for hit in duplicate_hits)
    assert {hit["citation_state"] for hit in duplicate_hits} == {"ambiguous"}
    assert len([hit for hit in hits if hit["source_id"] == LONG]) > 1
    tie_hits = [hit for hit in hits if hit["source_id"] in {TIE_FIRST, TIE_SECOND}]
    assert len(tie_hits) == 2
    assert tie_hits[0]["score"] == tie_hits[1]["score"]
    assert tie_hits[1]["rank"] == tie_hits[0]["rank"] + 1
    assert [hit["chunk_id"] for hit in tie_hits] == sorted(hit["chunk_id"] for hit in tie_hits)
    distinct = semantic_index.search(
        index_path, "beacon navigation for ships entering a harbour", limit=100, distinct=True
    )
    expected = []
    seen: set[str] = set()
    for hit in hits:
        if hit["source_id"] not in seen:
            seen.add(hit["source_id"])
            expected.append(hit["chunk_id"])
    assert [hit["chunk_id"] for hit in distinct["hits"]] == expected


def test_not_run_and_unusable_index_outcomes_are_distinct(tmp_path: Path) -> None:
    """O3: absent locations and broken generations cannot both look like empty retrieval."""
    assert semantic_index.search(None, "anything") == {
        "status": "not_run",
        "reason": "no semantic index location is configured (NOUS_OS_SEMANTIC_INDEX_PATH or --semantic-index-path)",
        "hits": [],
    }
    absent = semantic_index.search(tmp_path / "absent", "anything")
    assert absent["status"] == "not_run" and absent["hits"] == [] and "CURRENT" in absent["reason"]
    fake_root = tmp_path / "fake"
    _minimal_generation(fake_root)
    with pytest.raises(semantic_index.SemanticIndexUnusable, match="chunks"):
        semantic_index.verify(fake_root)
    with pytest.raises(semantic_index.SemanticIndexUnusable, match="chunks"):
        semantic_index.search(fake_root, "anything")
    missing_table_root = tmp_path / "missing-table"
    generation = _minimal_generation(missing_table_root)
    connection = sqlite3.connect(generation / "index.sqlite3")
    try:
        connection.execute("DROP TABLE chunk")
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(semantic_index.SemanticIndexUnusable, match="tables"):
        semantic_index.search(missing_table_root, "anything")
    truncated_root = tmp_path / "truncated"
    generation = _minimal_generation(truncated_root, include_chunk=True)
    (generation / "vectors.f32").write_bytes(b"\0\0\0")
    with pytest.raises(semantic_index.SemanticIndexUnusable, match="vectors.f32"):
        semantic_index.search(truncated_root, "anything")
    with pytest.raises(semantic_index.SemanticIndexError):
        semantic_index.search(fake_root, "")
    for bad_limit in (0, True):
        with pytest.raises(semantic_index.SemanticIndexError):
            semantic_index.search(fake_root, "anything", limit=bad_limit)  # type: ignore[arg-type]


def test_checkpoint_mismatch_is_not_run(tmp_path: Path) -> None:
    """O3: loading different checkpoint bytes is visible rather than silently queried."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    report = semantic_index.build(derived_path, index_path, DENSE_EN)
    connection = sqlite3.connect(index_path / report.generation / "index.sqlite3")  # type: ignore[operator]
    try:
        connection.execute("UPDATE meta SET value = ? WHERE key = 'checkpoint_digest'", ("0" * 64,))
        connection.commit()
    finally:
        connection.close()
    answer = semantic_index.search(index_path, "beacon")
    assert answer["status"] == "not_run"
    assert report.checkpoint_digest in answer["reason"] and "0" * 64 in answer["reason"]


def test_transports_workspace_health_and_module_cli_pin_the_new_read(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """O4: the generated transports expose identical arguments and accept the location flag."""
    semantic_path = tmp_path / "semantic"
    semantic_path.mkdir()
    workspace = _workspace(tmp_path, semantic_path)
    grant = Grant("reader", frozenset({Tier.READ}))
    capabilities = core.invoke(grant, "system.capabilities", workspace, {})
    descriptor = next(item for item in capabilities["operations"] if item["name"] == "knowledge.semantic")
    assert [(item["name"], item["type"], item["required"]) for item in descriptor["parameters"]] == [
        ("query", "string", True), ("limit", "integer", False), ("distinct", "boolean", False)
    ]
    tools = mcp._handle_tools_list({})["tools"]
    tool = next(item for item in tools if item["name"] == "knowledge.semantic")
    assert tool["inputSchema"]["properties"] == {
        item["name"]: {"type": item["type"], "description": item["description"]}
        for item in descriptor["parameters"]
    }
    assert core.invoke(grant, "system.health", workspace, {})["semantic_index_path"] == "healthy"
    cli_namespace = cli._build_parser().parse_args([
        "--data-root", str(tmp_path / "other-documents"), "--snapshot-root", str(tmp_path / "other-snapshots"),
        "--ledger-path", str(tmp_path / "other-ledger"), "--derived-path", str(tmp_path / "other-derived"),
        "--candidate-store-path", str(tmp_path / "other-candidates"), "--bridge-registry-path", str(tmp_path / "other-bridges"),
        "--rejection-memory-path", str(tmp_path / "other-rejections"), "--relation-store-path", str(tmp_path / "other-relations"),
        "--semantic-index-path", str(semantic_path), "knowledge.semantic", "--query", "beacon",
    ])
    assert cli_namespace.semantic_index_path == str(semantic_path)
    mcp_namespace = mcp._build_start_parser().parse_args(["--semantic-index-path", str(semantic_path)])
    assert mcp_namespace.semantic_index_path == str(semantic_path)
    assert semantic_index.main(["build"]) == 1
    refusal = capsys.readouterr().err
    assert "DENSE-ML" in refusal and "DENSE-EN" in refusal
    program = (
        "import sys; import nous_os, nous_os.core, nous_os.cli, nous_os.mcp, nous_os.semantic_index;"
        "print(sorted(m for m in ('numpy','onnxruntime','tokenizers','huggingface_hub') if m in sys.modules))"
    )
    result = subprocess.run(
        [sys.executable, "-c", program], capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}, check=True,
    )
    assert result.stdout.strip() == "[]"
