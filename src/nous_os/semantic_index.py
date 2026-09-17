"""A persistent dense index over derived-store tip records.

The index is expendable state: its SQLite rows and float32 file are rebuilt
solely from a derived store and one explicitly named local checkpoint.  It
refuses to choose weights, contact a network, or turn an unavailable encoder
into an empty successful answer.  NumPy and the optional semantic extra stay
inside build and search so importing this module keeps the base package free
of those dependencies.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from nous_os.chunking import Chunk, estimate_tokens
from nous_os.derived import DerivedStoreError, QueryError
from nous_os.derived import search as lexical_search
from nous_os.derived import state_digest as derived_state_digest
from nous_os.derived import verify as verify_derived
from nous_os.identity import digest_bytes
from nous_os.provenance import Citation, Locator, quote_lint, read_span
from nous_os.snapshots import Snapshot, SnapshotNotFound


FORMAT: Final = "1"
PROJECTION: Final = "v2"
CHUNK_MAX_WORDS: Final = 40
MAX_TOKENS: Final = 256
BATCH_SIZE: Final = 32
_CITATION_STATES: Final = frozenset({"located", "absent", "ambiguous", "unlintable"})
#: Keys a projection v1 generation predates. Absent there, they read as empty
#: prefixes; absent from a v2 generation, they make it unusable.
_V2_META_KEYS: Final = ("chunk_max_words", "query_prefix", "passage_prefix")
_META_KEYS: Final = (
    "format",
    "projection",
    "chunk_max_tokens",
    "chunk_max_words",
    "query_prefix",
    "passage_prefix",
    "backend",
    "repo_id",
    "onnx_filename",
    "tokenizer_filename",
    "checkpoint_digest",
    "tokenizer_digest",
    "max_tokens",
    "batch_size",
    "dimension",
    "chunks",
    "records_indexed",
    "records_empty",
    "derived_digest",
    "state_digest",
)
_TURN_PAIR_FORMAT: Final = "R117-turn-pair-v1"
_RRF_K: Final = 60
_LEXICAL_STOP: Final = frozenset({
    "il", "lo", "la", "i", "gli", "le", "un", "una", "di", "del", "della", "dei", "delle",
    "a", "al", "alla", "ai", "alle", "da", "dal", "in", "nel", "nella", "con", "su", "per",
    "tra", "fra", "e", "o", "che", "non", "come", "cosa", "quale", "quali", "è", "the", "an",
    "of", "to", "from", "for", "and", "or", "on", "with", "before", "after", "deve", "stare",
    "va", "più",
})


class SemanticIndexError(Exception):
    """Raised when a requested semantic-index action has invalid inputs."""


class SemanticIndexUnusable(SemanticIndexError):
    """The published index cannot be verified and must not answer a search.

    This is distinct from an unavailable encoder: a broken index may otherwise
    look like a complete query with no hits, which is an answer it has not
    earned the right to give.
    """


class SemanticIndexBuildInProgress(SemanticIndexError):
    """A concurrent builder holds the exclusive publication lock."""


@dataclass(frozen=True, slots=True)
class BuildReport:
    """The recorded outcome of one rebuild attempt, including a not-run reason."""

    status: str
    generation: str | None
    chunks: int
    records_indexed: int
    records_empty: int
    citations_located: int
    citations_absent: int
    citations_ambiguous: int
    citations_unlintable: int
    dimension: int | None
    checkpoint_digest: str | None
    state_digest: str | None
    elapsed_s: float
    reason: str | None = None

    def __post_init__(self) -> None:
        if self.status not in {"complete", "not_run"}:
            raise SemanticIndexError("a build report status is complete or not_run")
        for name in (
            "chunks",
            "records_indexed",
            "records_empty",
            "citations_located",
            "citations_absent",
            "citations_ambiguous",
            "citations_unlintable",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise SemanticIndexError(f"build report {name} must be a non-negative integer")
        if self.dimension is not None and (type(self.dimension) is not int or self.dimension < 1):
            raise SemanticIndexError("build report dimension must be a positive integer or None")
        if type(self.elapsed_s) is not float or self.elapsed_s < 0:
            raise SemanticIndexError("build report elapsed_s must be a non-negative float")
        if self.status == "complete":
            if any(value is None for value in (self.generation, self.dimension, self.checkpoint_digest, self.state_digest)):
                raise SemanticIndexError("a complete build report must identify its generation")
            if self.reason is not None:
                raise SemanticIndexError("a complete build report has no not-run reason")
        elif type(self.reason) is not str or not self.reason.strip():
            raise SemanticIndexError("a not-run build report must say why it did not run")

    def as_payload(self) -> dict[str, object]:
        """Render the stable JSON-shaped report used by the module command line."""
        payload: dict[str, object] = {
            "status": self.status,
            "generation": self.generation,
            "chunks": self.chunks,
            "records_indexed": self.records_indexed,
            "records_empty": self.records_empty,
            "citations": {
                "located": self.citations_located,
                "absent": self.citations_absent,
                "ambiguous": self.citations_ambiguous,
                "unlintable": self.citations_unlintable,
            },
            "dimension": self.dimension,
            "checkpoint_digest": self.checkpoint_digest,
            "state_digest": self.state_digest,
            "elapsed_s": self.elapsed_s,
        }
        if self.reason is not None:
            payload["reason"] = self.reason
        return payload


@dataclass(frozen=True, slots=True)
class _IndexedChunk:
    """A chunk plus the snapshot identity and citation state the index persists."""

    chunk: Chunk
    snapshot_digest: str
    start_byte: int | None
    end_byte: int | None
    citation_state: str

    def __post_init__(self) -> None:
        if self.citation_state not in _CITATION_STATES:
            raise SemanticIndexError("an indexed chunk has an undeclared citation state")
        located = self.citation_state == "located"
        if located != (self.start_byte is not None and self.end_byte is not None):
            raise SemanticIndexError("only a located chunk carries a byte range")


class _OneSnapshotStore:
    """The one immutable body used to run the normal provenance checks at build time."""

    def __init__(self, snapshot: Snapshot) -> None:
        self._snapshot = snapshot

    def get(self, source_id: str, digest: str) -> Snapshot:
        if source_id == self._snapshot.source_id and digest == self._snapshot.digest:
            return self._snapshot
        raise SnapshotNotFound(f"no snapshot {digest} for {source_id}")


def record_parts(body: str) -> tuple[str, ...]:
    """Select one derived record body's text parts; projections v1 and v2 share this step.

    Projection intentionally recognizes only the stable payload/message/content
    shapes named here. The string items of ``content.parts`` are returned one by
    one so a chunk never crosses a part join; the ``content.text``,
    ``message.text`` and top-level ``text`` fallbacks are one part. Invalid JSON
    and any body that cannot establish text are empty rather than guessed from
    provider-specific structure.
    """
    if type(body) is not str:
        return ()
    try:
        top = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return ()
    if type(top) is not dict:
        return ()
    payload = top.get("payload")
    payload_object = payload if type(payload) is dict else top
    message = payload_object.get("message")
    message_object = message if type(message) is dict else payload_object
    content = message_object.get("content")
    if type(content) is dict:
        parts = content.get("parts")
        if type(parts) is list:
            return tuple(part for part in parts if type(part) is str)
        content_text = content.get("text")
        if type(content_text) is str:
            return (content_text,)
    message_text = message_object.get("text")
    if type(message_text) is str:
        return (message_text,)
    top_text = top.get("text")
    return (top_text,) if type(top_text) is str else ()


def record_text(body: str) -> str:
    """Select one derived record body's text: its parts joined by a newline."""
    return "\n".join(record_parts(body))


_BLANK_LINE: Final = re.compile(r"\n[ \t\r]*\n")
_SENTENCE_END: Final = re.compile(r"[.?!…:;](?=\s)|\n")


def _stripped_span(text: str, start: int, end: int) -> tuple[int, int]:
    """Move ``start`` and ``end`` inward past whitespace without copying the text."""
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _sentence_spans(text: str, start: int, end: int) -> tuple[tuple[int, int], ...]:
    """Split one block into stripped, non-empty sentence spans in document order."""
    spans: list[tuple[int, int]] = []
    cursor = start
    for match in _SENTENCE_END.finditer(text, start, end):
        spans.append((cursor, match.end()))
        cursor = match.end()
    spans.append((cursor, end))
    stripped = (_stripped_span(text, span_start, span_end) for span_start, span_end in spans)
    return tuple(span for span in stripped if span[0] < span[1])


def pack_sentences(text: str, max_words: int) -> tuple[tuple[int, int, str], ...]:
    """Text projection v2: verbatim, contiguous sentence-packed spans of ``text``.

    Every chunk is exactly ``text[start:end]`` with its edges stripped of
    whitespace. Blank lines bound blocks a chunk never crosses; inside a block
    a sentence ends at ``.``, ``?``, ``!``, ``…``, ``:`` or ``;`` followed by
    whitespace, or at a newline, so a heading line is an ordinary sentence.
    Consecutive sentences are packed while the whitespace-word count stays at
    or below ``max_words``; one sentence longer than that is emitted alone.
    """
    if type(text) is not str:
        raise SemanticIndexError("a projected record is text")
    if type(max_words) is not int or isinstance(max_words, bool) or max_words < 1:
        raise SemanticIndexError(f"max_words must be a positive integer, not {max_words!r}")
    chunks: list[tuple[int, int, str]] = []
    block_start = 0
    boundaries = [match.start() for match in _BLANK_LINE.finditer(text)]
    for block_end in boundaries + [len(text)]:
        pending_start: int | None = None
        pending_end = block_start
        pending_words = 0
        for sentence_start, sentence_end in _sentence_spans(text, block_start, block_end):
            words = estimate_tokens(text[sentence_start:sentence_end])
            if pending_start is not None and pending_words + words > max_words:
                chunks.append((pending_start, pending_end, text[pending_start:pending_end]))
                pending_start = None
                pending_words = 0
            if pending_start is None:
                pending_start = sentence_start
            pending_end = sentence_end
            pending_words += words
        if pending_start is not None:
            chunks.append((pending_start, pending_end, text[pending_start:pending_end]))
        block_start = block_end
    return tuple(chunks)


def _needle(text: str) -> bytes:
    """The exact JSON-string bytes a projected chunk must occupy in its body."""
    return json.dumps(text, ensure_ascii=False)[1:-1].encode("utf-8")


def _citation_location(
    source_id: str, snapshot_digest: str, body: str, text: str
) -> tuple[int | None, int | None, str]:
    """Locate and quote-lint one chunk, refusing ambiguous or unsafe byte ranges."""
    body_bytes = body.encode("utf-8")
    needle = _needle(text)
    occurrences = body_bytes.count(needle)
    if occurrences == 0:
        return None, None, "absent"
    if occurrences != 1:
        return None, None, "ambiguous"
    start = body_bytes.find(needle)
    end = start + len(needle)
    try:
        citation = Citation(source_id, snapshot_digest, Locator(start, end), needle.decode("utf-8"))
        store = _OneSnapshotStore(Snapshot(source_id, snapshot_digest, body_bytes))
        if read_span(store, citation) != citation.span:
            return None, None, "unlintable"
        quote_lint(store, citation)
    except Exception:
        return None, None, "unlintable"
    return start, end, "located"


def _tip_records(derived_path: Path) -> tuple[tuple[str, str, str], ...]:
    """Read one maximum-sequence record per source from a verified derived store."""
    derived_path = Path(derived_path)
    verify_derived(derived_path)
    try:
        connection = sqlite3.connect(f"file:{derived_path.resolve()}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                "SELECT v.source_id, v.snapshot_digest, c.body"
                " FROM version v JOIN content c ON c.source_id = v.source_id"
                "  AND c.snapshot_digest = v.snapshot_digest"
                " WHERE v.sequence = ("
                "  SELECT MAX(tip.sequence) FROM version tip WHERE tip.source_id = v.source_id"
                " ) ORDER BY v.source_id"
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.DatabaseError as error:
        raise SemanticIndexError(f"derived store could not be read for semantic indexing: {error}") from error
    return tuple((row[0], row[1], row[2]) for row in rows)


def _collect_chunks(derived_path: Path) -> tuple[tuple[_IndexedChunk, ...], int, int]:
    """Project and chunk every source tip in canonical source order."""
    indexed: list[_IndexedChunk] = []
    records_indexed = 0
    records_empty = 0
    for source_id, snapshot_digest, body in _tip_records(derived_path):
        parts = record_parts(body)
        if not "\n".join(parts):
            records_empty += 1
            continue
        records_indexed += 1
        spans = tuple(
            chunk_text for part in parts for _start, _end, chunk_text in pack_sentences(part, CHUNK_MAX_WORDS)
        )
        for ordinal, chunk_text in enumerate(spans):
            chunk = Chunk(
                id=f"{source_id}#{ordinal:04d}",
                source_id=source_id,
                ordinal=ordinal,
                heading_path=(),
                text=chunk_text,
                tokens=estimate_tokens(chunk_text),
            )
            start, end, state = _citation_location(source_id, snapshot_digest, body, chunk_text)
            indexed.append(_IndexedChunk(chunk, snapshot_digest, start, end, state))
    indexed.sort(key=lambda item: item.chunk.id)
    return tuple(indexed), records_indexed, records_empty


_WORKER_BACKEND: object | None = None


def _worker_init(spec: object) -> None:
    """Construct the one encoder each spawned worker owns."""
    global _WORKER_BACKEND
    from nous_os.semantic import OnnxBackend

    _WORKER_BACKEND = OnnxBackend(spec)


def _worker_encode(texts: tuple[str, ...]):
    """Encode exactly one pre-composed batch in the worker that received it."""
    if _WORKER_BACKEND is None:
        raise SemanticIndexError("semantic worker has no backend")
    return _WORKER_BACKEND.encode(texts)  # type: ignore[union-attr]


def _encode(
    items: tuple[_IndexedChunk, ...], spec: object, workers: int, backend: object
):
    """Encode deterministic token-length batches and return chunk-id-order vectors.

    The passage prefix is applied here, for encoding only; the stored text stays
    the raw chunk.
    """
    import numpy as np

    passage_prefix = spec.passage_prefix  # type: ignore[attr-defined]
    encoding_order = tuple(sorted(items, key=lambda item: (item.chunk.tokens, item.chunk.id)))
    batches = tuple(
        tuple(passage_prefix + item.chunk.text for item in encoding_order[start : start + BATCH_SIZE])
        for start in range(0, len(encoding_order), BATCH_SIZE)
    )
    if workers == 1:
        encoded = tuple(backend.encode(batch) for batch in batches)  # type: ignore[union-attr]
    else:
        import multiprocessing

        context = multiprocessing.get_context("spawn")
        with context.Pool(processes=workers, initializer=_worker_init, initargs=(spec,)) as pool:
            encoded = tuple(pool.map(_worker_encode, batches))

    by_id: dict[str, object] = {}
    dimension: int | None = None
    for batch, matrix, batch_items in zip(
        batches,
        encoded,
        (encoding_order[start : start + BATCH_SIZE] for start in range(0, len(encoding_order), BATCH_SIZE)),
    ):
        matrix = np.ascontiguousarray(matrix, dtype=np.float32)
        if matrix.ndim != 2 or matrix.shape[0] != len(batch):
            raise SemanticIndexError("the backend returned the wrong vector matrix shape")
        if matrix.shape[1] < 1:
            raise SemanticIndexError("the backend returned vectors with no dimension")
        if dimension is None:
            dimension = int(matrix.shape[1])
        elif matrix.shape[1] != dimension:
            raise SemanticIndexError("the backend changed vector dimension between batches")
        for item, vector in zip(batch_items, matrix):
            by_id[item.chunk.id] = vector
    if dimension is None:
        raise SemanticIndexError("a semantic index needs at least one non-empty projected record")
    ordered = tuple(sorted(items, key=lambda item: item.chunk.id))
    vectors = np.ascontiguousarray(np.stack([by_id[item.chunk.id] for item in ordered]), dtype=np.float32)
    return vectors, dimension


def _state_digest(chunk_ids: tuple[str, ...], vector_bytes: bytes) -> str:
    """The byte-level index digest, computed exactly as ``semantic.SemanticIndex.state_digest``."""
    return digest_bytes(b"\0".join(item.encode("utf-8") for item in chunk_ids) + b"\0\0" + vector_bytes)


def _generation_name(state: str) -> str:
    return f"gen-{state}"


def _write_generation(
    generation: Path,
    items: tuple[_IndexedChunk, ...],
    vectors,
    *,
    spec: object,
    backend: object,
    records_indexed: int,
    records_empty: int,
    derived_digest: str,
    state: str,
) -> None:
    """Materialize one deterministic generation without publishing it."""
    generation.mkdir(parents=True, exist_ok=False)
    vector_path = generation / "vectors.f32"
    vectors.tofile(vector_path)
    database_path = generation / "index.sqlite3"
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA page_size=4096")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("CREATE TABLE meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        connection.execute(
            "CREATE TABLE chunk("
            "chunk_id TEXT PRIMARY KEY NOT NULL,"
            "source_id TEXT NOT NULL,"
            "snapshot_digest TEXT NOT NULL,"
            "ordinal INTEGER NOT NULL,"
            "heading_path TEXT NOT NULL,"
            "text TEXT NOT NULL,"
            "start_byte INTEGER,"
            "end_byte INTEGER,"
            "citation_state TEXT NOT NULL)"
        )
        rows = [
            (
                item.chunk.id,
                item.chunk.source_id,
                item.snapshot_digest,
                item.chunk.ordinal,
                json.dumps(list(item.chunk.heading_path), ensure_ascii=False, separators=(",", ":")),
                item.chunk.text,
                item.start_byte,
                item.end_byte,
                item.citation_state,
            )
            for item in items
        ]
        connection.executemany("INSERT INTO chunk VALUES (?,?,?,?,?,?,?,?,?)", rows)
        # The chunk budget has always been counted in whitespace words (the
        # estimate `chunking.estimate_tokens` makes), so the legacy key records
        # the same budget the v2 key does.
        metadata = {
            "format": FORMAT,
            "projection": PROJECTION,
            "chunk_max_tokens": str(CHUNK_MAX_WORDS),
            "chunk_max_words": str(CHUNK_MAX_WORDS),
            "query_prefix": spec.query_prefix,  # type: ignore[union-attr]
            "passage_prefix": spec.passage_prefix,  # type: ignore[union-attr]
            "backend": backend.name,  # type: ignore[union-attr]
            "repo_id": spec.repo_id,  # type: ignore[union-attr]
            "onnx_filename": spec.onnx_filename,  # type: ignore[union-attr]
            "tokenizer_filename": spec.tokenizer_filename,  # type: ignore[union-attr]
            "checkpoint_digest": backend.checkpoint_digest,  # type: ignore[union-attr]
            "tokenizer_digest": backend.tokenizer_digest,  # type: ignore[union-attr]
            "max_tokens": str(MAX_TOKENS),
            "batch_size": str(BATCH_SIZE),
            "dimension": str(vectors.shape[1]),
            "chunks": str(len(items)),
            "records_indexed": str(records_indexed),
            "records_empty": str(records_empty),
            "derived_digest": derived_digest,
            "state_digest": state,
        }
        connection.executemany(
            "INSERT INTO meta VALUES (?,?)", [(key, metadata[key]) for key in _META_KEYS]
        )
        connection.commit()
        connection.execute("VACUUM")
        connection.commit()
    finally:
        connection.close()


def _read_current(index_path: Path) -> str | None:
    """Return a configured generation name, or ``None`` when CURRENT is absent."""
    current_path = Path(index_path) / "CURRENT"
    try:
        value = current_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise SemanticIndexUnusable(f"CURRENT: could not be read: {error}") from error
    if not value:
        raise SemanticIndexUnusable("CURRENT: generation name is empty")
    if value != Path(value).name or not value.startswith("gen-"):
        raise SemanticIndexUnusable("CURRENT: generation name is not a generation directory")
    return value


def _required_generation(index_path: Path) -> tuple[str, Path]:
    """Resolve CURRENT to an existing generation, never a path outside the index root."""
    name = _read_current(index_path)
    if name is None:
        raise SemanticIndexUnusable("CURRENT: missing")
    generation = Path(index_path) / name
    if not generation.is_dir():
        raise SemanticIndexUnusable("CURRENT: named generation is missing")
    return name, generation


def _integer_meta(meta: dict[str, str], key: str, *, minimum: int = 0) -> int:
    try:
        value = int(meta[key])
    except (KeyError, TypeError, ValueError) as error:
        raise SemanticIndexUnusable(f"meta {key}: not an integer") from error
    if value < minimum:
        raise SemanticIndexUnusable(f"meta {key}: below {minimum}")
    return value


def _check_generation(index_path: Path) -> tuple[str, Path, dict[str, str]]:
    """The structural check every read makes: files, tables, meta, counts, vector length.

    No digest is recomputed and no chunk row is scanned; that is `verify`. A
    projection v1 generation predates the prefix and word-budget keys and is
    accepted without them, as empty prefixes.
    """
    name, generation = _required_generation(Path(index_path))
    database_path = generation / "index.sqlite3"
    vector_path = generation / "vectors.f32"
    if not database_path.is_file():
        raise SemanticIndexUnusable("index.sqlite3: missing")
    if not vector_path.is_file():
        raise SemanticIndexUnusable("vectors.f32: missing")
    try:
        connection = sqlite3.connect(f"file:{database_path.resolve()}?mode=ro", uri=True)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            missing = [table for table in ("meta", "chunk") if table not in tables]
            if missing:
                raise SemanticIndexUnusable(f"tables: missing {', '.join(missing)}")
            meta = dict(connection.execute("SELECT key, value FROM meta ORDER BY key").fetchall())
            optional = _V2_META_KEYS if meta.get("projection") == "v1" else ()
            absent_meta = [key for key in _META_KEYS if key not in meta and key not in optional]
            if absent_meta:
                raise SemanticIndexUnusable(f"meta: missing {', '.join(absent_meta)}")
            row_count = connection.execute("SELECT COUNT(*) FROM chunk").fetchone()[0]
        finally:
            connection.close()
    except SemanticIndexUnusable:
        raise
    except sqlite3.DatabaseError as error:
        raise SemanticIndexUnusable(f"sqlite: {error}") from error
    chunks = _integer_meta(meta, "chunks", minimum=1)
    dimension = _integer_meta(meta, "dimension", minimum=1)
    if chunks != row_count:
        raise SemanticIndexUnusable("chunks: metadata does not equal chunk row count")
    try:
        vector_length = vector_path.stat().st_size
    except OSError as error:
        raise SemanticIndexUnusable(f"vectors.f32: could not be read: {error}") from error
    if vector_length != chunks * dimension * 4:
        raise SemanticIndexUnusable("vectors.f32: length does not equal chunks × dimension × 4")
    return name, generation, meta


def verify(index_path: Path) -> dict[str, str]:
    """Verify a published generation in full, digest included.

    Refuses every missing, truncated, mismatched, or malformed component with
    the failed check named. It does not treat a broken index as a zero-hit one.
    An empty index would otherwise read as searched and found nothing. This is
    the only read that recomputes the index digest and scans every chunk row;
    `search` makes the structural check alone.
    """
    name, generation, meta = _check_generation(index_path)
    database_path = generation / "index.sqlite3"
    vector_path = generation / "vectors.f32"
    chunks = _integer_meta(meta, "chunks", minimum=1)
    dimension = _integer_meta(meta, "dimension", minimum=1)
    try:
        connection = sqlite3.connect(f"file:{database_path.resolve()}?mode=ro", uri=True)
        try:
            for chunk_id, heading_path, start, end, state in connection.execute(
                "SELECT chunk_id, heading_path, start_byte, end_byte, citation_state"
                " FROM chunk ORDER BY chunk_id"
            ):
                try:
                    path = json.loads(heading_path)
                except (TypeError, json.JSONDecodeError) as error:
                    raise SemanticIndexUnusable(f"heading_path: {chunk_id} is not JSON") from error
                if type(path) is not list or any(type(part) is not str for part in path):
                    raise SemanticIndexUnusable(f"heading_path: {chunk_id} is not a string list")
                if state not in _CITATION_STATES:
                    raise SemanticIndexUnusable(f"citation_state: {chunk_id} is not declared")
                if state == "located" and not (
                    type(start) is int and type(end) is int and 0 <= start < end
                ):
                    raise SemanticIndexUnusable(f"located range: {chunk_id} is invalid")
                if state != "located" and (start is not None or end is not None):
                    raise SemanticIndexUnusable(f"citation range: {chunk_id} exists without located state")
            chunk_ids = tuple(
                row[0] for row in connection.execute("SELECT chunk_id FROM chunk ORDER BY chunk_id")
            )
        finally:
            connection.close()
    except SemanticIndexUnusable:
        raise
    except sqlite3.DatabaseError as error:
        raise SemanticIndexUnusable(f"sqlite: {error}") from error
    expected_length = chunks * dimension * 4
    try:
        vector_bytes = vector_path.read_bytes()
    except OSError as error:
        raise SemanticIndexUnusable(f"vectors.f32: could not be read: {error}") from error
    if len(vector_bytes) != expected_length:
        raise SemanticIndexUnusable("vectors.f32: length does not equal chunks × dimension × 4")
    observed_state = _state_digest(chunk_ids, vector_bytes)
    if meta["state_digest"] != observed_state:
        raise SemanticIndexUnusable("state_digest: metadata does not match chunk ids and vectors")
    if name != _generation_name(observed_state):
        raise SemanticIndexUnusable("generation suffix: does not match the recomputed index digest")
    result = dict(meta)
    result["current"] = name
    return result


def status(index_path: Path, derived_path: Path | None = None) -> dict[str, str | None]:
    """Report a generation's metadata and, when possible, a fresh derived digest."""
    current = _read_current(Path(index_path))
    if current is None:
        result: dict[str, str | None] = {"current": None}
    else:
        verified = verify(index_path)
        result = dict(verified)
    if derived_path is not None:
        try:
            result["derived_digest_now"] = derived_state_digest(Path(derived_path))
        except OSError:
            pass
    return result


def _not_run(reason: str) -> dict[str, object]:
    return {"status": "not_run", "reason": reason, "hits": []}


def _backend_for(meta: dict[str, str]):
    """Load precisely the checkpoint header fields the generation recorded."""
    try:
        import nous_os.semantic as semantic
    except ImportError as error:
        return None, f"semantic extra is not importable: {error}"
    try:
        spec = semantic.ModelSpec(
            meta["backend"],
            meta["repo_id"],
            meta["onnx_filename"],
            meta["tokenizer_filename"],
            query_prefix=meta.get("query_prefix", ""),
            passage_prefix=meta.get("passage_prefix", ""),
        )
        return semantic.OnnxBackend(spec), None
    except semantic.SemanticError as error:
        return None, str(error)


def _lexical_prefix_query(query: str) -> str:
    """Make a bounded FTS prefix query from meaningful user-query terms."""
    terms = []
    for term in re.findall(r"[\w'’\-\.]+", query.lower()):
        term = term.strip("'’.")
        if term and term not in _LEXICAL_STOP and len(term) >= 3:
            terms.append(term[:5] if len(term) > 6 else term)
    return " OR ".join(f'"{term}"*' for term in terms)


def _read_turn_pairs(
    index_path: Path, generation_name: str, meta: dict[str, str]
) -> tuple[list[tuple[str, str]], object] | None:
    """Read a compatible published turn sidecar, otherwise decline augmentation.

    A sidecar is optional recall state. Its failure must not make CURRENT's
    ordinary dense retrieval unavailable.
    """
    sidecar = index_path / "turn-pairs"
    try:
        complete = json.loads((sidecar / "COMPLETE.json").read_text(encoding="utf-8"))
        if type(complete) is not dict or complete.get("format") != _TURN_PAIR_FORMAT:
            return None
        if complete.get("published") is not True:
            return None
        pairs, dimension = complete.get("pairs"), complete.get("dimension")
        if type(pairs) is not int or pairs < 1 or type(dimension) is not int or dimension < 1:
            return None
        if (
            complete.get("base_generation") != generation_name
            or complete.get("backend") != meta["backend"]
            or dimension != _integer_meta(meta, "dimension", minimum=1)
            or complete.get("vector_bytes") != pairs * dimension * 4
            or (sidecar / "vectors.f32").stat().st_size != pairs * dimension * 4
        ):
            return None
        connection = sqlite3.connect(f"file:{(sidecar / 'index.sqlite3').resolve()}?mode=ro", uri=True)
        try:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if not {"meta", "turn"} <= tables:
                return None
            stored = dict(connection.execute("SELECT key, value FROM meta"))
            if (
                stored.get("format") != _TURN_PAIR_FORMAT
                or stored.get("base_generation") != generation_name
                or stored.get("backend") != meta["backend"]
                or stored.get("dimension") != str(dimension)
                or stored.get("pairs") != str(pairs)
            ):
                return None
            turns = connection.execute(
                "SELECT source_id, assistant_source_id FROM turn ORDER BY source_id"
            ).fetchall()
        finally:
            connection.close()
        if (
            len(turns) != pairs
            or any(type(left) is not str or type(right) is not str for left, right in turns)
            or len({right for _left, right in turns}) != pairs
        ):
            return None
        import numpy as np

        vectors = np.fromfile(sidecar / "vectors.f32", dtype=np.float32)
        if vectors.size != pairs * dimension:
            return None
        return [(left, right) for left, right in turns], vectors.reshape((pairs, dimension))
    except (OSError, ValueError, TypeError, json.JSONDecodeError, sqlite3.DatabaseError):
        return None


def search(
    index_path: Path | None,
    query: str,
    limit: int = 10,
    distinct: bool = False,
    derived_path: Path | None = None,
) -> dict[str, object]:
    """Search a structurally checked local index, or record why no dense search ran.

    A missing configured location, absent CURRENT, unavailable optional extra,
    or unavailable recorded checkpoint is a not-run answer. A structurally
    broken generation instead raises ``SemanticIndexUnusable`` so callers do
    not mistake corruption for a completed empty ranking. The check is
    `_check_generation`, not `verify`: a truncated vectors file or a missing
    table is refused, a flipped vector byte is not detected here, and only the
    ranked rows are read in full. `verify` is the full check.

    The query is encoded under the generation's recorded ``query_prefix``,
    empty for a projection v1 generation.
    """
    if type(query) is not str or not query.strip():
        raise SemanticIndexError("a semantic search needs a query")
    if type(limit) is not int or isinstance(limit, bool) or limit < 1:
        raise SemanticIndexError(f"limit must be a positive integer, not {limit!r}")
    if type(distinct) is not bool:
        raise SemanticIndexError(f"distinct must be a boolean, not {type(distinct).__name__}")
    if index_path is None:
        return _not_run(
            "no semantic index location is configured (NOUS_OS_SEMANTIC_INDEX_PATH or --semantic-index-path)"
        )
    path = Path(index_path)
    try:
        current = _read_current(path)
    except SemanticIndexUnusable:
        raise
    if current is None:
        return _not_run(f"no CURRENT generation at {path}")
    _name, generation, meta = _check_generation(path)
    backend, reason = _backend_for(meta)
    if backend is None:
        return _not_run(f"backend {meta['backend']!r} could not be loaded: {reason}")
    if backend.checkpoint_digest != meta["checkpoint_digest"]:
        return _not_run(
            "checkpoint digest differs: index "
            f"{meta['checkpoint_digest']}, loaded {backend.checkpoint_digest}"
        )
    import numpy as np

    chunks = _integer_meta(meta, "chunks")
    dimension = _integer_meta(meta, "dimension", minimum=1)
    vectors = np.fromfile(generation / "vectors.f32", dtype=np.float32).reshape((chunks, dimension))
    query_vector = backend.encode((meta.get("query_prefix", "") + query,))[0]
    scores = vectors @ query_vector
    try:
        connection = sqlite3.connect(f"file:{(generation / 'index.sqlite3').resolve()}?mode=ro", uri=True)
        try:
            rows = connection.execute("SELECT chunk_id, source_id FROM chunk ORDER BY chunk_id").fetchall()
            if len(rows) != chunks:
                raise SemanticIndexUnusable("chunks: metadata does not equal chunk row count")
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
            contexts: dict[str, str] = {}
            context_chunk_ids: dict[str, str] = {}
            rrf_scores: dict[str, float] = {}
            augmented = False
            # RRF is a source-level ranking. Explicit chunk-level callers keep
            # the established dense-only result; the governed user route asks
            # for distinct source hits by default.
            if distinct and derived_path is not None:
                sidecar = _read_turn_pairs(path, _name, meta)
                if sidecar is not None:
                    turns, turn_vectors = sidecar
                    raw_sources = [candidate[1][1] for candidate in candidates[:200]]
                    reply_to_user = {assistant_source: user_source for user_source, assistant_source in turns}
                    reply_sources = list(dict.fromkeys(
                        reply_to_user[assistant_source]
                        for assistant_source in raw_sources
                        if assistant_source in reply_to_user
                    ))
                    try:
                        lexical_query = _lexical_prefix_query(query)
                        lexical_sources = (
                            list(dict.fromkeys(hit.source_id for hit in lexical_search(Path(derived_path), lexical_query, limit=50)))
                            if lexical_query else []
                        )
                    except (QueryError, DerivedStoreError):
                        lexical_sources = []
                    turn_scores = turn_vectors @ query_vector
                    turn_sources = [
                        source_id for _score, source_id in sorted(
                            ((float(score), source_id) for score, (source_id, _assistant) in zip(turn_scores, turns)),
                            key=lambda item: (-item[0], item[1]),
                        )[:200]
                    ]
                    # A retrieved assistant response can generalise to the
                    # immediately preceding user question.  The sidecar has
                    # already validated this one-to-one relationship; its
                    # source citation remains the user source and the reply
                    # remains separately attributed as context below.
                    for ranked in (lexical_sources, raw_sources, turn_sources, reply_sources):
                        for position, source_id in enumerate(ranked, start=1):
                            rrf_scores[source_id] = rrf_scores.get(source_id, 0.0) + 1.0 / (_RRF_K + position)
                    fused = sorted(rrf_scores, key=lambda source_id: (-rrf_scores[source_id], source_id))
                    best_by_source: dict[str, tuple[float, tuple[str, str]]] = {}
                    for candidate in candidates:
                        best_by_source.setdefault(candidate[1][1], candidate)
                    selected = [best_by_source[source_id] for source_id in fused[:limit] if source_id in best_by_source]
                    contexts = dict(turns)
                    augmented = True
            details: dict[str, tuple[object, ...]] = {}
            detail_ids = {chunk_id for _score, (chunk_id, _source_id) in selected}
            if augmented:
                context_sources = {
                    contexts[source_id] for _score, (_chunk_id, source_id) in selected if source_id in contexts
                }
                for _score, (chunk_id, source_id) in candidates:
                    if source_id in context_sources:
                        context_chunk_ids[source_id] = chunk_id
                        detail_ids.add(chunk_id)
                        context_sources.remove(source_id)
                    if not context_sources:
                        break
            for chunk_id in detail_ids:
                detail = connection.execute(
                    "SELECT snapshot_digest, ordinal, heading_path, text, start_byte, end_byte,"
                    " citation_state FROM chunk WHERE chunk_id = ?",
                    (chunk_id,),
                ).fetchone()
                if detail is None:
                    raise SemanticIndexUnusable(f"chunk: {chunk_id} vanished between ranking and reading")
                details[chunk_id] = detail
        finally:
            connection.close()
    except SemanticIndexUnusable:
        raise
    except sqlite3.DatabaseError as error:
        raise SemanticIndexUnusable(f"sqlite: {error}") from error
    hits: list[dict[str, object]] = []
    for rank, (score, (chunk_id, source_id)) in enumerate(selected, start=1):
        snapshot_digest, ordinal, heading_json, text, start, end, state = details[chunk_id]
        citation = None
        if state == "located":
            citation = {
                "source_id": source_id,
                "snapshot_digest": snapshot_digest,
                "start_byte": start,
                "end_byte": end,
                "span": _needle(text).decode("utf-8"),
            }
        hit: dict[str, object] = {
                "rank": rank,
                "score": score,
                "chunk_id": chunk_id,
                "source_id": source_id,
                "snapshot_digest": snapshot_digest,
                "ordinal": ordinal,
                "heading_path": json.loads(heading_json),
                "text": text,
                "citation": citation,
                "citation_state": state,
            }
        if augmented:
            hit["rrf_score"] = rrf_scores[source_id]
            context_source = contexts.get(source_id)
            context_chunk_id = context_chunk_ids.get(context_source) if context_source is not None else None
            if context_source is not None and context_chunk_id is not None:
                context_detail = details[context_chunk_id]
                ctx_digest, _ctx_ordinal, _ctx_heading, ctx_text, ctx_start, ctx_end, ctx_state = context_detail
                hit["context_source_id"] = context_source
                hit["context_citation"] = (
                    {
                        "source_id": context_source,
                        "snapshot_digest": ctx_digest,
                        "start_byte": ctx_start,
                        "end_byte": ctx_end,
                        "span": _needle(ctx_text).decode("utf-8"),
                    }
                    if ctx_state == "located"
                    else None
                )
        hits.append(hit)
    result: dict[str, object] = {
        "status": "complete",
        "backend": meta["backend"],
        "checkpoint_digest": meta["checkpoint_digest"],
        "index_digest": meta["state_digest"],
        "chunks": chunks,
        "hits": hits,
    }
    if augmented:
        result["ranking"] = "turn-reply-rrf-k60"
    return result


def build(
    derived_path: Path, index_path: Path, spec: object, *, workers: int = 1
) -> BuildReport:
    """Rebuild and atomically publish a local dense generation.

    The checkpoint is loaded before the index directory or lock is created, so
    an unavailable local backend returns a not-run report and writes nothing.
    Once work begins a non-blocking lock serializes builders; any failure before
    CURRENT changes removes its private rebuild directory and leaves the prior
    published generation readable.
    """
    started = time.monotonic()
    if type(workers) is not int or isinstance(workers, bool) or workers < 1:
        raise SemanticIndexError(f"workers must be a positive integer, not {workers!r}")
    try:
        import nous_os.semantic as semantic
    except ImportError as error:
        return BuildReport(
            "not_run", None, 0, 0, 0, 0, 0, 0, 0, None, None, None,
            float(time.monotonic() - started), f"semantic extra is not importable: {error}"
        )
    try:
        backend = semantic.OnnxBackend(spec)
    except semantic.SemanticError as error:
        return BuildReport(
            "not_run", None, 0, 0, 0, 0, 0, 0, 0, None, None, None,
            float(time.monotonic() - started), str(error)
        )
    root = Path(index_path)
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / ".build.lock"
    handle = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    rebuild_root: Path | None = None
    target: Path | None = None
    current_tmp = root / "CURRENT.tmp"
    moved = False
    published = False
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SemanticIndexBuildInProgress(f"semantic index build in progress for {root.name}") from error
        try:
            items, records_indexed, records_empty = _collect_chunks(Path(derived_path))
            if not items:
                raise SemanticIndexError("a semantic index needs at least one non-empty projected record")
            vectors, dimension = _encode(items, spec, workers, backend)
            vector_bytes = vectors.tobytes(order="C")
            state = _state_digest(tuple(item.chunk.id for item in items), vector_bytes)
            generation_name = _generation_name(state)
            citation_counts = {
                name: sum(item.citation_state == name for item in items) for name in _CITATION_STATES
            }
            derived_digest = derived_state_digest(Path(derived_path))
            rebuild_root = root / f".rebuild-{os.getpid()}"
            target = root / generation_name
            if rebuild_root.exists():
                shutil.rmtree(rebuild_root)
            rebuild_root.mkdir()
            staged_generation = rebuild_root / generation_name
            _write_generation(
                staged_generation,
                items,
                vectors,
                spec=spec,
                backend=backend,
                records_indexed=records_indexed,
                records_empty=records_empty,
                derived_digest=derived_digest,
                state=state,
            )
            (rebuild_root / "CURRENT").write_text(generation_name + "\n", encoding="utf-8")
            verify(rebuild_root)
            previous = _read_current(root)
            if target.exists():
                if (
                    (target / "index.sqlite3").read_bytes() != (staged_generation / "index.sqlite3").read_bytes()
                    or (target / "vectors.f32").read_bytes() != (staged_generation / "vectors.f32").read_bytes()
                ):
                    raise SemanticIndexError("existing generation differs from this deterministic rebuild")
            else:
                os.replace(staged_generation, target)
                moved = True
            current_tmp.write_text(generation_name + "\n", encoding="utf-8")
            os.replace(current_tmp, root / "CURRENT")
            published = True
            if previous is not None and previous != generation_name:
                try:
                    shutil.rmtree(root / previous)
                except OSError:
                    pass
        finally:
            if not published and moved and target is not None:
                try:
                    shutil.rmtree(target)
                except OSError:
                    pass
            if rebuild_root is not None:
                try:
                    shutil.rmtree(rebuild_root)
                except FileNotFoundError:
                    pass
            if not published:
                try:
                    current_tmp.unlink(missing_ok=True)
                except OSError:
                    pass
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        os.close(handle)
    return BuildReport(
        "complete",
        generation_name,
        len(items),
        records_indexed,
        records_empty,
        citation_counts["located"],
        citation_counts["absent"],
        citation_counts["ambiguous"],
        citation_counts["unlintable"],
        dimension,
        backend.checkpoint_digest,
        state,
        float(time.monotonic() - started),
    )


def _resolve_path(value: str | None, env_var: str, description: str) -> Path:
    """Resolve a command-line path from its flag or named environment variable."""
    candidate = value if value is not None else os.environ.get(env_var)
    if candidate is None or not candidate.strip():
        raise SemanticIndexError(f"no {description} was configured; pass its flag or set {env_var}")
    return Path(candidate).expanduser().resolve()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m nous_os.semantic_index")
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--derived-path", default=None)
    build_parser.add_argument("--semantic-index-path", default=None)
    build_parser.add_argument("--backend", choices=("DENSE-ML", "DENSE-EN", "DENSE-E5"), default=None)
    build_parser.add_argument("--workers", type=int, default=1)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--semantic-index-path", default=None)
    status_parser = commands.add_parser("status")
    status_parser.add_argument("--semantic-index-path", default=None)
    status_parser.add_argument("--derived-path", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the narrow index command line with one JSON answer or one named refusal."""
    parser = _parser()
    namespace = parser.parse_args(argv)
    try:
        if namespace.command == "build" and namespace.backend is None:
            raise SemanticIndexError(
                "no default backend is offered; pass --backend DENSE-ML, --backend DENSE-EN"
                " or --backend DENSE-E5"
            )
        index_path = _resolve_path(
            namespace.semantic_index_path, "NOUS_OS_SEMANTIC_INDEX_PATH", "semantic index path"
        )
        if namespace.command == "build":
            derived_path = _resolve_path(
                namespace.derived_path, "NOUS_OS_DERIVED_PATH", "derived path"
            )
            from nous_os.semantic import DENSE_E5, DENSE_EN, DENSE_ML

            spec = {"DENSE-ML": DENSE_ML, "DENSE-EN": DENSE_EN, "DENSE-E5": DENSE_E5}[namespace.backend]
            result: object = build(derived_path, index_path, spec, workers=namespace.workers).as_payload()
        elif namespace.command == "verify":
            result = verify(index_path)
        else:
            derived_path = (
                _resolve_path(namespace.derived_path, "NOUS_OS_DERIVED_PATH", "derived path")
                if namespace.derived_path is not None
                or bool(os.environ.get("NOUS_OS_DERIVED_PATH", "").strip())
                else None
            )
            result = status(index_path, derived_path)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))
        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
