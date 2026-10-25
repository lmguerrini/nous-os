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
from nous_os.semantic import DENSE_E5, DENSE_EN, ModelSpec, OnnxBackend, SemanticError
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
MULTI = _sid("MANY")
PARTS = _sid("PARTS")

MULTI_PARAGRAPHS = (
    "The garden shed needs a fresh coat of paint before the autumn rain arrives.",
    "Our telescope mount wobbles whenever the tripod stands on soft lawn, so we moved it onto the patio stones.",
    "The pancake recipe calls for two eggs, a cup of flour and a pinch of salt.",
)
MESSAGE_PARTS = (
    "The orchard ladder needs a new rung before the apple harvest.",
    "Cider pressing starts once the barrels are scrubbed.",
)

_BACKENDS: dict[str, OnnxBackend | str] = {}


def _require_backend(spec: ModelSpec) -> OnnxBackend:
    """Load a cached encoder once, visibly skipping model-dependent pins if absent."""
    if spec.name not in _BACKENDS:
        try:
            _BACKENDS[spec.name] = OnnxBackend(spec)
        except SemanticError as error:
            _BACKENDS[spec.name] = str(error)
    loaded = _BACKENDS[spec.name]
    if isinstance(loaded, str):
        pytest.skip(loaded)
    return loaded


def _require_dense_en() -> OnnxBackend:
    return _require_backend(DENSE_EN)


def _without_tip_metadata(answer: dict[str, object]) -> dict[str, object]:
    """Compare rankings when one call intentionally adds tip fields."""
    payload = dict(answer)
    payload["hits"] = [
        {key: value for key, value in hit.items() if key not in {"role", "created_at"}}
        for hit in answer["hits"]
    ]
    return payload


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
        (MULTI, _message(["\n\n".join(MULTI_PARAGRAPHS)])),
        (PARTS, _message([MESSAGE_PARTS[0], {"asset": "image"}, MESSAGE_PARTS[1]])),
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
    projection: str = "v1",
    omit: tuple[str, ...] = (),
    encoder: OnnxBackend | None = None,
) -> Path:
    """Write a structurally valid small generation, by default without model weights.

    A ``projection`` of ``"v1"`` writes only the keys that projection recorded;
    ``"v2"`` writes every key in ``_META_KEYS`` except those in ``omit``. With an
    ``encoder`` the one chunk's vector is its raw encoding and the meta names
    that encoder's checkpoint, so a search can complete against the generation.
    """
    chunk_id = _sid("MINI") + "#0000"
    if encoder is not None:
        vector = encoder.encode(("small text",))[0]
        vectors = vector.tobytes(order="C")
        dimension = str(vector.shape[0])
        backend, repo_id = encoder.name, encoder._spec.repo_id
        checkpoint_digest, tokenizer_digest = encoder.checkpoint_digest, encoder.tokenizer_digest
    else:
        vectors = b"\0\0\0\0" if include_chunk else b""
        dimension = "1"
        checkpoint_digest = tokenizer_digest = "0" * 64
    ids = (chunk_id,) if include_chunk else ()
    digest = semantic_index._state_digest(ids, vectors)
    generation = index_path / f"gen-{digest}"
    generation.mkdir(parents=True)
    (generation / "vectors.f32").write_bytes(vectors)
    metadata = {
        "format": "1",
        "projection": projection,
        "chunk_max_tokens": "120" if projection == "v1" else "40",
        "chunk_max_words": "40",
        "query_prefix": "query: ",
        "passage_prefix": "passage: ",
        "backend": backend,
        "repo_id": repo_id,
        "onnx_filename": "onnx/model.onnx",
        "tokenizer_filename": "tokenizer.json",
        "checkpoint_digest": checkpoint_digest,
        "tokenizer_digest": tokenizer_digest,
        "max_tokens": "256",
        "batch_size": "32",
        "dimension": dimension,
        "chunks": "1" if include_chunk else "0",
        "records_indexed": "1" if include_chunk else "0",
        "records_empty": "0",
        "derived_digest": "0" * 64,
        "state_digest": digest,
    }
    if projection == "v1":
        omit = omit + semantic_index._V2_META_KEYS
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
            [(key, metadata[key]) for key in semantic_index._META_KEYS if key not in omit],
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


def _fake_search_generation(index_path: Path, vectors, source_ids: list[str]) -> Path:
    """Make a small structurally valid generation for deterministic ranking tests."""
    import numpy as np

    generation = _minimal_generation(index_path, include_chunk=True, projection="v2")
    values = np.asarray(vectors, dtype=np.float32)
    ids = [f"{_sid('RANK')}#{number:04d}" for number in range(len(source_ids))]
    (generation / "vectors.f32").write_bytes(values.tobytes())
    connection = sqlite3.connect(generation / "index.sqlite3")
    try:
        connection.execute("DELETE FROM chunk")
        connection.executemany(
            "INSERT INTO chunk VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, 'absent')",
            [
                (chunk_id, source_id, "0" * 64, number, f"rank text {number}")
                for number, (chunk_id, source_id) in enumerate(zip(ids, source_ids))
            ],
        )
        connection.execute("UPDATE meta SET value = ? WHERE key = 'chunks'", (str(len(ids)),))
        connection.execute("UPDATE meta SET value = ? WHERE key = 'dimension'", (str(values.shape[1]),))
        connection.commit()
    finally:
        connection.close()
    return generation


def _workspace(
    tmp_path: Path, semantic_path: Path | None = None, derived_path: Path | None = None
) -> core.Workspace:
    data_root = tmp_path / "documents"
    data_root.mkdir()
    return core.resolve_workspace(
        data_root=data_root,
        snapshot_root=tmp_path / "snapshots",
        ledger_path=tmp_path / "ledger.jsonl",
        derived_path=tmp_path / "derived.sqlite" if derived_path is None else derived_path,
        candidate_store_path=tmp_path / "candidates.jsonl",
        bridge_registry_path=tmp_path / "bridges.jsonl",
        rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl",
        semantic_index_path=semantic_path,
        environ={},
    )


def _published_turn_sidecar(index_path: Path, query: str) -> None:
    """Install a tiny compatible sidecar with an assistant-context mapping."""
    encoder = _require_dense_en()
    generation_name = (index_path / "CURRENT").read_text(encoding="utf-8").strip()
    generation = index_path / generation_name
    connection = sqlite3.connect(generation / "index.sqlite3")
    try:
        meta = dict(connection.execute("SELECT key, value FROM meta"))
    finally:
        connection.close()
    vector = encoder.encode((meta.get("query_prefix", "") + query,))[0]
    sidecar = index_path / "turn-pairs"
    sidecar.mkdir()
    database = sqlite3.connect(sidecar / "index.sqlite3")
    try:
        database.execute(
            "CREATE TABLE turn(source_id TEXT PRIMARY KEY NOT NULL, assistant_source_id TEXT NOT NULL, input_chars INTEGER NOT NULL)"
        )
        database.execute("CREATE TABLE meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        database.execute("INSERT INTO turn VALUES (?, ?, ?)", (LIGHTHOUSE, BAKING, 1))
        database.executemany(
            "INSERT INTO meta VALUES (?, ?)",
            sorted({
                "format": "R117-turn-pair-v1",
                "base_generation": generation_name,
                "backend": meta["backend"],
                "dimension": meta["dimension"],
                "pairs": "1",
            }.items()),
        )
        database.commit()
    finally:
        database.close()
    vector.tofile(sidecar / "vectors.f32")
    (sidecar / "COMPLETE.json").write_text(
        json.dumps({
            "format": "R117-turn-pair-v1",
            "base_generation": generation_name,
            "backend": meta["backend"],
            "dimension": int(meta["dimension"]),
            "pairs": 1,
            "vector_bytes": int(vector.nbytes),
            "published": True,
        }) + "\n",
        encoding="utf-8",
    )


def test_record_text_pins_text_projection_v1() -> None:
    """O1: only the fixed nested text shapes contribute a projected document, part by part."""
    bodies = {
        _message(["one", 2, "two"]): ("one", "two"),
        json.dumps({"payload": {"message": {"content": {"text": "body"}}}}): ("body",),
        json.dumps({"payload": {"message": {"text": "message"}}}): ("message",),
        json.dumps({"text": "recovered"}): ("recovered",),
        json.dumps({"payload": {"message": {"content": {"thoughts": ["no"]}}}}): (),
        "not JSON": (),
        "[]": (),
    }
    for body, parts in bodies.items():
        assert semantic_index.record_parts(body) == parts
        assert semantic_index.record_text(body) == "\n".join(parts)
    assert semantic_index.record_text(_message(["one", 2, "two"])) == "one\ntwo"


def test_multi_part_record_chunks_never_cross_a_part_join(tmp_path: Path) -> None:
    """F1: parts are packed one at a time so every chunk sits inside one part's JSON string."""
    _store, derived_path = _semantic_canon(tmp_path)
    items, _indexed, _empty = semantic_index._collect_chunks(derived_path)
    parts_items = [item for item in items if item.chunk.source_id == PARTS]
    assert [item.chunk.text for item in parts_items] == list(MESSAGE_PARTS)
    assert [item.chunk.ordinal for item in parts_items] == [0, 1]
    assert [item.chunk.id for item in parts_items] == [f"{PARTS}#0000", f"{PARTS}#0001"]
    assert {item.citation_state for item in parts_items} == {"located"}
    assert {item.citation_state for item in items if item.chunk.source_id != DUPLICATE} == {"located"}
    ordinals = [item.chunk.ordinal for item in items if item.chunk.source_id == LONG]
    assert ordinals == list(range(len(ordinals))) and len(ordinals) > 1


def test_pack_sentences_pins_text_projection_v2() -> None:
    """O1: chunks are verbatim contiguous spans packed by sentence inside blank-line blocks."""
    pack = semantic_index.pack_sentences
    heading = "# Field notes"
    long_paragraph = (
        "The first sentence names the subject at hand. The second sentence adds a detail: "
        "the detail is small; the third sentence asks whether it matters? It does! The "
        "fifth sentence trails off… The sixth sentence closes the paragraph."
    )
    text = f"{heading}\n\n{long_paragraph}\n \t\nLine one\nLine two\n\n\n"
    chunks = pack(text, 14)
    assert chunks == pack(text, 14)
    assert all(chunk_text == text[start:end] for start, end, chunk_text in chunks)
    assert all(chunk_text == chunk_text.strip() for _start, _end, chunk_text in chunks)
    assert [chunk_text for _start, _end, chunk_text in chunks] == [
        heading,
        "The first sentence names the subject at hand. The second sentence adds a detail:",
        "the detail is small; the third sentence asks whether it matters? It does!",
        "The fifth sentence trails off… The sixth sentence closes the paragraph.",
        "Line one\nLine two",
    ]
    assert all(len(chunk_text.split()) <= 14 for _start, _end, chunk_text in chunks)
    assert [start for start, _end, _text in chunks] == sorted(start for start, _end, _text in chunks)
    single = " ".join(f"word{number}" for number in range(30)) + ". Short tail."
    assert [chunk_text for _start, _end, chunk_text in pack(single, 14)] == [
        " ".join(f"word{number}" for number in range(30)) + ".",
        "Short tail.",
    ]
    assert [chunk_text for _start, _end, chunk_text in pack("one two.\n\nthree four.", 100)] == [
        "one two.",
        "three four.",
    ]
    assert [chunk_text for _start, _end, chunk_text in pack("First block one.\r\n\r\nSecond block two.", 100)] == [
        "First block one.",
        "Second block two.",
    ]
    assert pack("", 14) == () and pack(" \n\t \n ", 14) == ()
    with pytest.raises(semantic_index.SemanticIndexError):
        pack("text", 0)


@pytest.mark.parametrize("spec", [DENSE_EN, DENSE_E5], ids=["DENSE-EN", "DENSE-E5"])
def test_build_is_byte_identical_across_rebuilds_and_worker_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, spec: ModelSpec
) -> None:
    """O1: generation bytes, the index digest, idempotence, publication failure, and not-run are pinned."""
    _require_backend(spec)
    _store, derived_path = _semantic_canon(tmp_path)
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    parallel_root = tmp_path / "parallel"
    first = semantic_index.build(derived_path, first_root, spec, workers=1)
    second = semantic_index.build(derived_path, second_root, spec, workers=1)
    parallel = semantic_index.build(derived_path, parallel_root, spec, workers=2)
    first_generation = first_root / first.generation  # type: ignore[operator]
    second_generation = second_root / second.generation  # type: ignore[operator]
    parallel_generation = parallel_root / parallel.generation  # type: ignore[operator]
    for name in ("index.sqlite3", "vectors.f32"):
        assert (first_generation / name).read_bytes() == (second_generation / name).read_bytes()
        assert (first_generation / name).read_bytes() == (parallel_generation / name).read_bytes()
    verified = semantic_index.verify(first_root)
    assert first.state_digest == verified["state_digest"] == first.generation.removeprefix("gen-")
    again = semantic_index.build(derived_path, first_root, spec)
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
            semantic_index.build(derived_path, first_root, spec)
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
            semantic_index.build(derived_path, first_root, spec)
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
    assert "collapsed_same_text" not in answer
    assert all("same_text_source_ids" not in hit for hit in hits)
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
    source_ranked = []
    seen_sources: set[str] = set()
    for hit in hits:
        if hit["source_id"] not in seen_sources:
            seen_sources.add(hit["source_id"])
            source_ranked.append(hit)
    expected = []
    by_text: dict[str, dict[str, object]] = {}
    dropped = 0
    for hit in source_ranked:
        normalized = " ".join(hit["text"].split()).casefold()
        if normalized in by_text:
            by_text[normalized].setdefault("same_text_source_ids", []).append(hit["source_id"])
            dropped += 1
        else:
            by_text[normalized] = dict(hit)
            expected.append(by_text[normalized])
    assert [hit["chunk_id"] for hit in distinct["hits"]] == [hit["chunk_id"] for hit in expected]
    assert [hit["rank"] for hit in distinct["hits"]] == list(range(1, len(expected) + 1))
    assert distinct["collapsed_same_text"] == dropped > 0
    assert [hit.get("same_text_source_ids") for hit in distinct["hits"]] == [
        hit.get("same_text_source_ids") for hit in expected
    ]
    refilled = semantic_index.search(
        index_path, "beacon navigation for ships entering a harbour", limit=3, distinct=True
    )
    assert len(refilled["hits"]) == 3
    assert [hit["chunk_id"] for hit in refilled["hits"]] == [hit["chunk_id"] for hit in expected[:3]]
    assert [hit["rank"] for hit in refilled["hits"]] == [1, 2, 3]


def test_semantic_role_filter_metadata_and_argument_validation(tmp_path: Path) -> None:
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    connection = sqlite3.connect(derived_path)
    try:
        connection.execute("UPDATE record SET role = 'user', created_at = '2026-01-02' WHERE source_id = ?", (LIGHTHOUSE,))
        connection.execute("UPDATE record SET role = 'assistant' WHERE source_id = ?", (BAKING,))
        connection.commit()
    finally:
        connection.close()
    user = semantic_index.search(index_path, "beacon navigation harbour", limit=10, distinct=True,
                                 derived_path=derived_path, role="user")
    assert user["hits"] and all(hit["role"] == "user" for hit in user["hits"])
    lighthouse = next(hit for hit in user["hits"] if hit["source_id"] == LIGHTHOUSE)
    assert lighthouse["created_at"] == "2026-01-02"
    plain = semantic_index.search(index_path, "beacon", limit=1)
    assert "role" not in plain["hits"][0] and "created_at" not in plain["hits"][0]
    with pytest.raises(semantic_index.SemanticIndexError, match="derived_path"):
        semantic_index.search(index_path, "beacon", role="user")
    with pytest.raises(semantic_index.SemanticIndexError, match="role"):
        semantic_index.search(index_path, "beacon", role="system")


def test_role_window_is_filled_after_filtering(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np

    sources = [_sid(f"AS{number:03d}") for number in range(201)] + [_sid("USER1"), _sid("USER2")]
    vectors = np.arange(len(sources), 0, -1, dtype=np.float32)[:, None]
    index_path = tmp_path / "role-window"
    _fake_search_generation(index_path, vectors, sources)
    class FakeBackend:
        checkpoint_digest = "0" * 64
        def encode(self, _texts):
            return np.ones((1, 1), dtype=np.float32)
    monkeypatch.setattr(semantic_index, "_backend_for", lambda _meta: (FakeBackend(), None))
    monkeypatch.setattr(semantic_index, "_tip_role_dates", lambda *_args, **_kwargs: {
        source: ("user" if source in sources[-2:] else "assistant", None) for source in sources
    })
    monkeypatch.setattr(semantic_index, "_read_turn_pairs", lambda *_args, **_kwargs: ([], np.empty((0, 1))))
    monkeypatch.setattr(semantic_index, "lexical_search", lambda *_args, **_kwargs: [])
    derived = tmp_path / "derived.sqlite"
    derived.touch()
    answer = semantic_index.search(index_path, "query", limit=10, derived_path=derived, role="user")
    assert {hit["source_id"] for hit in answer["hits"]} == set(sources[-2:])


def test_role_filter_requires_readable_record_table(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np

    index_path = tmp_path / "role-missing-store"
    _fake_search_generation(index_path, np.ones((1, 1), dtype=np.float32), [_sid("ONE")])
    class FakeBackend:
        checkpoint_digest = "0" * 64
        def encode(self, _texts):
            return np.ones((1, 1), dtype=np.float32)
    monkeypatch.setattr(semantic_index, "_backend_for", lambda _meta: (FakeBackend(), None))
    missing = tmp_path / "missing.sqlite"
    with pytest.raises(semantic_index.SemanticIndexError, match="derived store.*role metadata"):
        semantic_index.search(index_path, "query", derived_path=missing, role="user")
    malformed = tmp_path / "malformed.sqlite"
    sqlite3.connect(malformed).close()
    with pytest.raises(semantic_index.SemanticIndexError, match="record table"):
        semantic_index.search(index_path, "query", derived_path=malformed, role="user")


def test_augmented_search_refills_past_unindexed_lexical_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import numpy as np

    sources = [_sid("INDEX1"), _sid("INDEX2")]
    index_path = tmp_path / "refill"
    _fake_search_generation(index_path, np.array([[2.0], [1.0]], dtype=np.float32), sources)
    class FakeBackend:
        checkpoint_digest = "0" * 64
        def encode(self, _texts):
            return np.ones((1, 1), dtype=np.float32)
    monkeypatch.setattr(semantic_index, "_backend_for", lambda _meta: (FakeBackend(), None))
    monkeypatch.setattr(semantic_index, "_tip_role_dates", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(semantic_index, "_read_turn_pairs", lambda *_args, **_kwargs: ([], np.empty((0, 1))))
    monkeypatch.setattr(semantic_index, "lexical_search", lambda *_args, **_kwargs: [
        type("LexicalHit", (), {"source_id": _sid("AAALEX")})()
    ])
    derived = tmp_path / "derived.sqlite"
    derived.touch()
    answer = semantic_index.search(index_path, "query", limit=2, derived_path=derived)
    assert [hit["source_id"] for hit in answer["hits"]] == sources


def test_numpy_search_matches_previous_ranking_with_ties_and_turns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ranking remains byte-for-byte stable across limits, duplicate sources, and sidecars."""
    import numpy as np

    rng = np.random.default_rng(441)
    source_ids = [_sid(f"R{number // 2:03d}") for number in range(24)]
    vectors = rng.integers(-2, 3, size=(24, 6)).astype(np.float32)
    # Deliberate score ties are common, while repeated source ids exercise
    # source-level best-chunk selection and chunk-level duplicate retention.
    index_path = tmp_path / "ranking"
    generation = _fake_search_generation(index_path, vectors, source_ids)

    class FakeBackend:
        checkpoint_digest = "0" * 64

        def encode(self, texts):
            seed = sum(texts[0].encode("utf-8"))
            return np.random.default_rng(seed).integers(-2, 3, size=(1, 6)).astype(np.float32)

    backend = FakeBackend()
    monkeypatch.setattr(semantic_index, "_backend_for", lambda _meta: (backend, None))
    monkeypatch.setattr(semantic_index, "lexical_search", lambda *_args, **_kwargs: [])
    turns = [(source_ids[i], source_ids[i + 12]) for i in range(12)]
    turn_vectors = rng.integers(-2, 3, size=(12, 6)).astype(np.float32)
    monkeypatch.setattr(
        semantic_index, "_read_turn_pairs", lambda *_args, **_kwargs: (turns, turn_vectors)
    )

    connection = sqlite3.connect(generation / "index.sqlite3")
    try:
        rows = connection.execute("SELECT chunk_id, source_id FROM chunk ORDER BY chunk_id").fetchall()
    finally:
        connection.close()

    def old_ranking(query: str, limit: int, distinct: bool, augmented: bool):
        """Verbatim ranking operations from search before NumPy selection."""
        query_vector = backend.encode(("query: " + query,))[0]
        scores = vectors @ query_vector
        candidates = sorted(
            ((float(score), row) for score, row in zip(scores, rows)),
            key=lambda item: (-item[0], item[1][0]),
        )
        if distinct:
            seen: set[str] = set()
            candidates = [
                candidate
                for candidate in candidates
                if not (candidate[1][1] in seen or seen.add(candidate[1][1]))
            ]
        selected = candidates[:limit]
        rrf_scores: dict[str, float] = {}
        if distinct and augmented:
            raw_sources = [candidate[1][1] for candidate in candidates[:200]]
            reply_to_user = {assistant_source: user_source for user_source, assistant_source in turns}
            reply_sources = list(dict.fromkeys(
                reply_to_user[assistant_source]
                for assistant_source in raw_sources
                if assistant_source in reply_to_user
            ))
            turn_scores = turn_vectors @ query_vector
            turn_sources = [
                source_id for _score, source_id in sorted(
                    ((float(score), source_id) for score, (source_id, _assistant) in zip(turn_scores, turns)),
                    key=lambda item: (-item[0], item[1]),
                )[:200]
            ]
            for ranked in ([], raw_sources, turn_sources, reply_sources):
                for position, source_id in enumerate(ranked, start=1):
                    rrf_scores[source_id] = rrf_scores.get(source_id, 0.0) + 1.0 / (60 + position)
            fused = sorted(rrf_scores, key=lambda source_id: (-rrf_scores[source_id], source_id))
            best_by_source = {}
            for candidate in candidates:
                best_by_source.setdefault(candidate[1][1], candidate)
            selected = [best_by_source[source_id] for source_id in fused[:limit] if source_id in best_by_source]
        return selected, rrf_scores

    semantic_index.clear_search_cache()
    for query_number in range(9):
        query = f"random query {query_number}"
        for limit in (1, 2, 7, 13, 40):
            for distinct in (False, True):
                for augmented in (False, True):
                    semantic_index.clear_search_cache()
                    expected, expected_rrf = old_ranking(query, limit, distinct, augmented)
                    answer = semantic_index.search(
                        index_path, query, limit=limit, distinct=distinct,
                        derived_path=tmp_path / "derived" if augmented else None,
                    )
                    hits = answer["hits"]
                    if distinct:
                        connection = sqlite3.connect(generation / "index.sqlite3")
                        try:
                            chunk_text = dict(connection.execute("SELECT chunk_id, text FROM chunk"))
                        finally:
                            connection.close()
                        collapsed = []
                        seen_text = set()
                        for row in expected:
                            normalized = " ".join(chunk_text[row[1][0]].split()).casefold()
                            if normalized not in seen_text:
                                seen_text.add(normalized)
                                collapsed.append(row)
                            if len(collapsed) == limit:
                                break
                        expected = collapsed
                    assert [hit["chunk_id"] for hit in hits] == [row[1][0] for row in expected], (query, limit, distinct, augmented, hits, expected)
                    assert [hit["score"] for hit in hits] == [row[0] for row in expected], (query, limit, distinct, augmented, hits, expected)
                    if distinct and augmented:
                        assert answer["ranking"] == "turn-reply-rrf-k60"
                        assert [hit["rrf_score"] for hit in hits] == [
                            expected_rrf[row[1][1]] for row in expected
                        ]
                    else:
                        assert "ranking" not in answer


def test_search_cache_reuse_and_invalidation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The backend is retained for a generation and reloaded after CURRENT or vector changes."""
    import numpy as np

    class FakeBackend:
        checkpoint_digest = "0" * 64

        def encode(self, _texts):
            return np.ones((1, 1), dtype=np.float32)

    backend = FakeBackend()
    calls = []
    monkeypatch.setattr(semantic_index, "_backend_for", lambda _meta: (calls.append(1) or backend, None))
    root = tmp_path / "cache"
    first = _fake_search_generation(root, np.ones((1, 1), dtype=np.float32), [_sid("ONE")])
    semantic_index.clear_search_cache()
    semantic_index.search(root, "query")
    semantic_index.search(root, "query")
    assert len(calls) == 1
    import shutil

    second = root / "gen-second"
    shutil.copytree(first, second)
    (root / "CURRENT").write_text(second.name + "\n", encoding="utf-8")
    semantic_index.search(root, "query")
    assert len(calls) == 2
    # Restore CURRENT, then replace vectors with same-sized content and restore its mtime.
    (root / "CURRENT").write_text(first.name + "\n", encoding="utf-8")
    vector_path = first / "vectors.f32"
    import os
    original_stat = vector_path.stat()
    replacement = first / "replacement.f32"
    replacement.write_bytes(np.array([2.0], dtype=np.float32).tobytes())
    os.utime(replacement, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    os.replace(replacement, vector_path)
    os.utime(vector_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    semantic_index.search(root, "query")
    assert len(calls) == 3


def test_turn_rrf_sidecar_is_validated_and_keeps_two_citations(tmp_path: Path) -> None:
    """O1/O3: a compatible published sidecar augments source hits, never CURRENT."""
    _require_dense_en()
    store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    query = "beacon navigation for ships entering a harbour"
    ordinary = semantic_index.search(index_path, query, limit=3, distinct=True)
    _published_turn_sidecar(index_path, query)
    answer = semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )
    assert answer["ranking"] == "turn-reply-rrf-k60"
    first = answer["hits"][0]
    assert first["source_id"] == LIGHTHOUSE
    assert first["context_source_id"] == BAKING
    for key, expected_source in (("citation", LIGHTHOUSE), ("context_citation", BAKING)):
        citation = first[key]
        assert citation is not None and citation["source_id"] == expected_source
        checked = Citation(
            citation["source_id"], citation["snapshot_digest"],
            Locator(citation["start_byte"], citation["end_byte"]), citation["span"],
        )
        assert read_span(store, checked) == citation["span"]
    # The direct chunk-level API and a mismatched companion retain the old
    # dense response rather than treating optional recall state as CURRENT.
    assert semantic_index.search(index_path, query, limit=3) == semantic_index.search(
        index_path, query, limit=3
    )
    # A structurally complete sidecar may still name an absent source. Its RRF
    # score could otherwise win a small result window and then be discarded
    # after slicing, returning fewer hits than ordinary dense retrieval.
    database = sqlite3.connect(index_path / "turn-pairs" / "index.sqlite3")
    try:
        database.execute("UPDATE turn SET source_id = ?", ("000-dangling-user",))
        database.commit()
    finally:
        database.close()
    ordinary_dough = semantic_index.search(
        index_path, "how do I knead bread dough before baking", limit=1, distinct=True
    )
    assert _without_tip_metadata(semantic_index.search(
        index_path,
        "how do I knead bread dough before baking",
        limit=1,
        distinct=True,
        derived_path=derived_path,
    )) == ordinary_dough
    database = sqlite3.connect(index_path / "turn-pairs" / "index.sqlite3")
    try:
        database.execute("UPDATE turn SET source_id = ?", (LIGHTHOUSE,))
        database.commit()
    finally:
        database.close()
    # One assistant response must not be allowed to attribute two user sources.
    # A structurally complete but ambiguous optional sidecar falls back safely.
    database = sqlite3.connect(index_path / "turn-pairs" / "index.sqlite3")
    try:
        database.execute("INSERT INTO turn VALUES (?, ?, ?)", (BAKING, BAKING, 1))
        database.execute("UPDATE meta SET value = '2' WHERE key = 'pairs'")
        database.commit()
    finally:
        database.close()
    vectors_path = index_path / "turn-pairs" / "vectors.f32"
    vectors_path.write_bytes(vectors_path.read_bytes() * 2)
    complete_path = index_path / "turn-pairs" / "COMPLETE.json"
    complete = json.loads(complete_path.read_text(encoding="utf-8"))
    complete["pairs"] = 2
    complete["vector_bytes"] *= 2
    complete_path.write_text(json.dumps(complete), encoding="utf-8")
    assert _without_tip_metadata(semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )) == ordinary
    complete_path = index_path / "turn-pairs" / "COMPLETE.json"
    complete["base_generation"] = "gen-not-current"
    complete_path.write_text(json.dumps(complete), encoding="utf-8")
    assert _without_tip_metadata(semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )) == ordinary


def test_turn_rrf_sidecar_falls_back_when_a_user_source_is_duplicated(tmp_path: Path) -> None:
    """An optional sidecar may not map one user source to multiple replies."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    query = "beacon navigation for ships entering a harbour"
    ordinary = semantic_index.search(index_path, query, limit=3, distinct=True)
    _published_turn_sidecar(index_path, query)
    database = sqlite3.connect(index_path / "turn-pairs" / "index.sqlite3")
    try:
        database.execute("DROP TABLE turn")
        database.execute(
            "CREATE TABLE turn(source_id TEXT NOT NULL, assistant_source_id TEXT NOT NULL, "
            "input_chars INTEGER NOT NULL)"
        )
        database.executemany(
            "INSERT INTO turn VALUES (?, ?, ?)",
            ((LIGHTHOUSE, BAKING, 1), (LIGHTHOUSE, LONG, 1)),
        )
        database.execute("UPDATE meta SET value = '2' WHERE key = 'pairs'")
        database.commit()
    finally:
        database.close()
    vectors_path = index_path / "turn-pairs" / "vectors.f32"
    vectors_path.write_bytes(vectors_path.read_bytes() * 2)
    complete_path = index_path / "turn-pairs" / "COMPLETE.json"
    complete = json.loads(complete_path.read_text(encoding="utf-8"))
    complete["pairs"] = 2
    complete["vector_bytes"] *= 2
    complete_path.write_text(json.dumps(complete), encoding="utf-8")

    answer = semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )

    assert "ranking" not in answer
    assert _without_tip_metadata(answer) == ordinary


def test_turn_rrf_sidecar_falls_back_for_a_self_pair(tmp_path: Path) -> None:
    """An optional reply edge must not use the same source on both sides."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    query = "beacon navigation for ships entering a harbour"
    ordinary = semantic_index.search(index_path, query, limit=3, distinct=True)
    _published_turn_sidecar(index_path, query)
    database = sqlite3.connect(index_path / "turn-pairs" / "index.sqlite3")
    try:
        database.execute("UPDATE turn SET assistant_source_id = source_id")
        database.commit()
    finally:
        database.close()

    answer = semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )

    assert "ranking" not in answer
    assert _without_tip_metadata(answer) == ordinary


def test_turn_rrf_sidecar_falls_back_for_non_finite_vectors(tmp_path: Path) -> None:
    """Non-finite optional recall scores must not affect dense retrieval."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    query = "beacon navigation for ships entering a harbour"
    ordinary = semantic_index.search(index_path, query, limit=3, distinct=True)
    _published_turn_sidecar(index_path, query)
    vectors_path = index_path / "turn-pairs" / "vectors.f32"
    vectors_path.write_bytes(b"\x00\x00\xc0\x7f" * (vectors_path.stat().st_size // 4))

    answer = semantic_index.search(
        index_path, query, limit=3, distinct=True, derived_path=derived_path
    )

    assert "ranking" not in answer
    assert _without_tip_metadata(answer) == ordinary


def test_core_semantic_defaults_to_distinct_rrf_when_sidecar_is_published(tmp_path: Path) -> None:
    """O2: the governed normal user path receives the sidecar and safe default."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    query = "beacon navigation for ships entering a harbour"
    _published_turn_sidecar(index_path, query)
    workspace = _workspace(tmp_path, index_path, derived_path)
    answer = core.invoke(
        Grant("reader", frozenset({Tier.READ})), "knowledge.semantic", workspace, {"query": query}
    )
    assert answer["ranking"] == "turn-reply-rrf-k60"
    assert answer["hits"][0]["context_source_id"] == BAKING


def test_turn_reply_edge_can_return_the_user_source_of_a_retrieved_reply(tmp_path: Path) -> None:
    """The optional sidecar maps an assistant hit back to its user source safely."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)
    _published_turn_sidecar(index_path, "beacon navigation for ships entering a harbour")
    answer = semantic_index.search(
        index_path, "how do I knead bread dough before baking", limit=3, distinct=True, derived_path=derived_path
    )
    assert answer["ranking"] == "turn-reply-rrf-k60"
    first = answer["hits"][0]
    assert first["source_id"] == LIGHTHOUSE
    assert first["context_source_id"] == BAKING


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
        ("query", "string", True), ("limit", "integer", False), ("distinct", "boolean", False), ("role", "string", False)
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
    assert "DENSE-ML" in refusal and "DENSE-EN" in refusal and "DENSE-E5" in refusal
    program = (
        "import sys; import nous_os, nous_os.core, nous_os.cli, nous_os.mcp, nous_os.semantic_index;"
        "print(sorted(m for m in ('numpy','onnxruntime','tokenizers','huggingface_hub') if m in sys.modules))"
    )
    result = subprocess.run(
        [sys.executable, "-c", program], capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}, check=True,
    )
    assert result.stdout.strip() == "[]"


def test_dense_e5_v2_build_pins_prefixed_ranking_citations_and_meta(tmp_path: Path) -> None:
    """O2: v2 chunks are located verbatim spans ranked by the recorded prefixed cosine."""
    backend = _require_backend(DENSE_E5)
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    report = semantic_index.build(derived_path, index_path, DENSE_E5)
    assert report.status == "complete" and report.citations_absent == 0
    verified = semantic_index.verify(index_path)
    assert verified["projection"] == "v2"
    assert verified["chunk_max_words"] == str(semantic_index.CHUNK_MAX_WORDS) == "40"
    assert verified["query_prefix"] == "query: " and verified["passage_prefix"] == "passage: "
    assert verified["backend"] == "DENSE-E5"
    connection = sqlite3.connect(index_path / report.generation / "index.sqlite3")  # type: ignore[operator]
    try:
        rows = connection.execute(
            "SELECT chunk_id, source_id, text, heading_path, citation_state FROM chunk ORDER BY chunk_id"
        ).fetchall()
    finally:
        connection.close()
    assert {state for _id, source_id, _text, _path, state in rows if source_id != DUPLICATE} == {"located"}
    assert {state for _id, source_id, _text, _path, state in rows if source_id == DUPLICATE} == {"ambiguous"}
    assert {path for _id, _source, _text, path, _state in rows} == {"[]"}
    assert [text for _id, source_id, text, _path, _state in rows if source_id == MULTI] == list(MULTI_PARAGRAPHS)
    assert [(text, state) for _id, source_id, text, _path, state in rows if source_id == PARTS] == [
        (MESSAGE_PARTS[0], "located"),
        (MESSAGE_PARTS[1], "located"),
    ]
    query = "the telescope tripod wobbles when it stands on the lawn"
    answer = semantic_index.search(index_path, query, limit=100)
    hits = answer["hits"]
    assert hits[0]["source_id"] == MULTI and hits[0]["text"] == MULTI_PARAGRAPHS[1]
    assert [hit["rank"] for hit in hits] == list(range(1, len(rows) + 1))
    query_vector = backend.encode(("query: " + query,))[0]
    prefixed = {
        chunk_id: float(backend.encode(("passage: " + text,))[0] @ query_vector)
        for chunk_id, _source, text, _path, _state in rows
    }
    raw_query = backend.encode((query,))[0]
    unprefixed = {
        chunk_id: float(backend.encode((text,))[0] @ raw_query)
        for chunk_id, _source, text, _path, _state in rows
    }
    expected = sorted(prefixed, key=lambda chunk_id: (-prefixed[chunk_id], chunk_id))
    assert [hit["chunk_id"] for hit in hits] == expected
    assert all(abs(hit["score"] - prefixed[hit["chunk_id"]]) < 1e-5 for hit in hits)
    assert not all(abs(hit["score"] - unprefixed[hit["chunk_id"]]) < 1e-5 for hit in hits)


def test_projection_v1_generation_is_read_with_empty_prefixes(tmp_path: Path) -> None:
    """O3: a v1 generation lacks the v2 keys and still verifies and searches; a v2 one may not."""
    backend = _require_backend(DENSE_EN)
    v1_root = tmp_path / "v1"
    _minimal_generation(v1_root, include_chunk=True, encoder=backend)
    verified = semantic_index.verify(v1_root)
    assert verified["projection"] == "v1"
    assert not any(key in verified for key in semantic_index._V2_META_KEYS)
    answer = semantic_index.search(v1_root, "small text")
    assert answer["status"] == "complete" and len(answer["hits"]) == 1
    raw = float(backend.encode(("small text",))[0] @ backend.encode(("small text",))[0])
    assert abs(answer["hits"][0]["score"] - raw) < 1e-5
    assert answer["hits"][0]["text"] == "small text"
    for missing in semantic_index._V2_META_KEYS:
        root = tmp_path / f"v2-without-{missing}"
        _minimal_generation(root, include_chunk=True, projection="v2", omit=(missing,))
        with pytest.raises(semantic_index.SemanticIndexUnusable, match=f"meta: missing {missing}"):
            semantic_index.verify(root)
        with pytest.raises(semantic_index.SemanticIndexUnusable, match=f"meta: missing {missing}"):
            semantic_index.search(root, "anything")
    v2_root = tmp_path / "v2"
    _minimal_generation(v2_root, include_chunk=True, projection="v2", encoder=backend)
    assert semantic_index.verify(v2_root)["chunk_max_words"] == "40"
    assert semantic_index.search(v2_root, "small text")["status"] == "complete"


def test_search_makes_the_structural_check_and_verify_the_full_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O3: search reads without recomputing the index digest; verify still does."""
    _require_dense_en()
    _store, derived_path = _semantic_canon(tmp_path)
    index_path = tmp_path / "semantic"
    semantic_index.build(derived_path, index_path, DENSE_EN)

    def refuse_digest(chunk_ids: tuple[str, ...], vector_bytes: bytes) -> str:
        raise RuntimeError("injected digest")

    monkeypatch.setattr(semantic_index, "_state_digest", refuse_digest)
    answer = semantic_index.search(index_path, "beacon navigation for ships entering a harbour", limit=3)
    assert answer["status"] == "complete" and answer["hits"][0]["source_id"] == LIGHTHOUSE
    with pytest.raises(RuntimeError, match="injected digest"):
        semantic_index.verify(index_path)
