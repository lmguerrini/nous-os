"""The derived store: an index built from canon, and thrown away without loss.

**Canon is files.** This module builds a SQLite database out of the canonical
layer and holds exactly nothing that the canonical layer does not already say.
Deleting it loses no information, and rebuilding it produces the same bytes —
not merely the same answers. That is a stronger claim than it sounds, and it is
the point: if a rebuild could differ, then something in the store came from
somewhere other than canon, and nobody would know what.

Byte-identical rebuilds need every source of incidental variation closed:

* a fixed page size, so layout does not depend on a compile-time default;
* rows inserted in a **canonical order** derived from content, never from a
  directory listing or a dictionary's iteration;
* no timestamps, no row ids that depend on insertion history, no ``AUTOINCREMENT``;
* ``VACUUM`` at the end, so free-page history from the build itself is discarded.
  On a build this shape it removes nothing — the build only inserts, so there
  are no free pages to reclaim, and measurement confirms page count, free list
  and file size are unchanged by it. It is kept as a guarantee about the shape
  of the output rather than as an optimisation, and the property it promises
  (no free pages) is asserted directly rather than inferred from the layout.

The legacy FTS indexed canonical JSON, including keys and escape artifacts.
Schema version 2 indexes an NFC text projection while content.body and search
excerpts remain the canonical JSON. Rebuild an older derived index from canon.

**A divergence is reported, not indexed around.** If the ledger names a snapshot
the store does not hold, this refuses to build. An index that quietly skipped it
would answer questions as though a document did not exist, which is worse than
failing: the failure is visible and the silence is not.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from nous_os.identity import SOURCE_PREFIX, digest_bytes, file_is_present, require_id
from nous_os.ledger import Ledger
from nous_os.snapshots import SnapshotNotFound, SnapshotStore
from nous_os.text_projection import project

#: Fixed so the file layout does not depend on a build-time default.
PAGE_SIZE = 4096
SCHEMA_VERSION = 2  # Version 1 indexed JSON body directly.

SCHEMA = (
    "CREATE TABLE source ("
    " source_id TEXT PRIMARY KEY NOT NULL"
    ")",
    "CREATE TABLE version ("
    " source_id TEXT NOT NULL,"
    " sequence INTEGER NOT NULL,"
    " snapshot_digest TEXT NOT NULL,"
    " previous_digest TEXT,"
    " recorded_at TEXT NOT NULL,"
    " quarantine TEXT NOT NULL,"
    " PRIMARY KEY (source_id, sequence)"
    ")",
    # Keyed on the PAIR, not on the digest alone. A digest is a function of
    # bytes; a snapshot belongs to a source. Two sources quoting the same
    # sentence -- shared boilerplate, a mirrored feed, a document copied across
    # -- share a digest and are two different facts. Keyed on the digest, the
    # second one silently disappeared from the index and its text was attributed
    # to the first.
    "CREATE TABLE content ("
    " snapshot_digest TEXT NOT NULL,"
    " source_id TEXT NOT NULL,"
    " byte_length INTEGER NOT NULL,"
    " body TEXT NOT NULL,"
    " PRIMARY KEY (snapshot_digest, source_id)"
    ")",
    "CREATE TABLE record ("
    " snapshot_digest TEXT NOT NULL,"
    " source_id TEXT NOT NULL,"
    " kind TEXT,"
    " provider TEXT,"
    " external_id TEXT,"
    " container_external_id TEXT,"
    " parent_external_id TEXT,"
    " role TEXT,"
    " created_at TEXT,"
    " PRIMARY KEY (snapshot_digest, source_id)"
    ")",
    "CREATE INDEX record_container ON record(container_external_id, created_at, source_id)",
    # A legacy binary must fail to search this generation, even though it does
    # not inspect user_version. Its SQL still names the removed `search` table.
    "CREATE VIRTUAL TABLE search_plain USING fts5("
    " body, snapshot_digest UNINDEXED, source_id UNINDEXED, tokenize='unicode61'"
    ")",
)


class DerivedStoreError(Exception):
    """Raised when the derived store cannot be built truthfully."""


class QueryError(DerivedStoreError):
    """The query could not be parsed. **Not** a statement about the store.

    Kept distinct because a caller looping over many query terms will
    reasonably skip one the query language rejects — and must not skip an
    unreadable store the same way. Collapsing the two let a run that read
    nothing at all report itself as complete.
    """


class StoreUnusable(DerivedStoreError):
    """The store cannot be read: absent, empty, corrupt, or not this schema."""


class CanonDivergence(DerivedStoreError):
    """The canonical layer does not hold something the ledger names.

    Its own failure, deliberately. This is the divergence the ingest capability
    left visible rather than healing in passing: a ledger restored beside an
    incomplete snapshot store. Repairing it silently here would hide it in the
    one place designed to notice.
    """


def _open_for_reading(path: Path) -> sqlite3.Connection:
    """Open read-only, and refuse rather than conjuring an empty database.

    `sqlite3.connect` creates the file. Querying a store that has been deleted
    therefore left a zero-byte file behind, and `build` then refused forever
    with a message about a previous build that never happened -- turning the
    documented recovery path into a permanent failure after one stray read.
    """
    path = Path(path)
    if not file_is_present(path):
        raise DerivedStoreError(f"no derived store at {path.name}; build it first")
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.DatabaseError as error:
        connection.close()
        raise StoreUnusable(f"the store could not be read: {error}") from error
    if version != SCHEMA_VERSION:
        connection.close()
        raise StoreUnusable(
            f"derived schema version {version}; rebuild from canon with "
            "PYTHONPATH=src python3 -m nous_os.derived rebuild --snapshot-root SNAPSHOTS "
            "--ledger-path LEDGER --derived-path INDEX"
        )
    return connection


@dataclass(frozen=True, slots=True)
class SearchHit:
    """One result. Ordered by relevance, then by digest to break ties."""

    snapshot_digest: str
    source_id: str
    excerpt: str
    kind: str | None = None
    role: str | None = None
    created_at: str | None = None
    title: str | None = None

    @property
    def text(self) -> str:
        """Reader-facing text; ``excerpt`` remains an internal compatibility alias."""
        return self.excerpt


_RECORD_FIELDS = (
    "kind",
    "provider",
    "external_id",
    "container_external_id",
    "parent_external_id",
    "role",
    "created_at",
)


def _record_values(body: str) -> tuple[str | None, ...]:
    """Return the record header fields canon explicitly carries in one body.

    A content snapshot remains the complete stored fact.  The record table is
    only a typed, rebuildable index over seven top-level JSON fields, so a
    malformed body, an array, or a non-string field contributes no invented
    metadata.
    """
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return (None,) * len(_RECORD_FIELDS)
    if type(payload) is not dict:
        return (None,) * len(_RECORD_FIELDS)
    return tuple(
        value if type(value) is str else None
        for value in (payload.get(field) for field in _RECORD_FIELDS)
    )


def _canonical_rows(store: SnapshotStore, ledger: Ledger) -> tuple[list, list, list, list]:
    """Everything the store will hold, in the one order it will hold it.

    Ordering is derived from content — source id, then position in that source's
    own chain — so it is a fact about canon rather than about how the filesystem
    happened to answer.
    """
    sources = sorted({entry.source_id for entry in ledger.entries()})
    versions: list[tuple] = []
    contents: list[tuple] = []
    seen: set[tuple[str, str]] = set()

    for source_id in sources:
        for sequence, entry in enumerate(ledger.chain(source_id)):
            versions.append(
                (
                    entry.source_id,
                    sequence,
                    entry.snapshot_digest,
                    entry.previous_digest,
                    entry.recorded_at.isoformat(),
                    ",".join(reason.value for reason in entry.quarantine),
                )
            )
            # The existence check runs for EVERY entry, before any dedup. It
            # used to sit after it, so an entry whose digest had already been
            # seen from another source skipped the check entirely and a build
            # succeeded with canon incomplete -- the exact thing this refusal
            # exists to prevent.
            try:
                snapshot = store.get(entry.source_id, entry.snapshot_digest)
            except SnapshotNotFound as error:
                raise CanonDivergence(
                    f"the ledger names snapshot {entry.snapshot_digest} of "
                    f"{entry.source_id}, which the snapshot store does not hold; "
                    "canon is incomplete and an index built now would answer as "
                    "though that version never existed"
                ) from error
            if (entry.snapshot_digest, entry.source_id) in seen:
                continue
            seen.add((entry.snapshot_digest, entry.source_id))
            try:
                body = snapshot.data.decode("utf-8")
            except UnicodeDecodeError as error:
                # Not a silent substitution. Replacing undecodable bytes with
                # U+FFFD would index text no source ever contained, in the one
                # module whose whole claim is that it holds nothing canon does
                # not say.
                raise DerivedStoreError(
                    f"snapshot {entry.snapshot_digest} of {entry.source_id} is "
                    "not UTF-8 text and cannot be indexed as text"
                ) from error
            contents.append(
                (entry.snapshot_digest, entry.source_id, len(snapshot.data), body)
            )

    # Sorted by the same pair the table is keyed on, so the insertion order is a
    # fact about canon rather than about how the ledger happened to be walked.
    contents.sort(key=lambda row: (row[0], row[1]))
    records = [
        (snapshot_digest, source_id, *_record_values(body))
        for snapshot_digest, source_id, _byte_length, body in contents
    ]
    return [(source_id,) for source_id in sources], versions, contents, records


def build(store: SnapshotStore, ledger: Ledger, path: Path) -> Path:
    """Build the derived store at ``path`` from canon alone.

    Refuses to overwrite. A rebuild builds a separate sibling and atomically
    replaces the live database only after that separate build verifies.
    """
    path = Path(path)
    if path.exists():
        raise DerivedStoreError(
            f"{path.name} already exists; build refuses to overwrite it; a rebuild "
            "publishes a separately verified sibling instead"
        )
    sources, versions, contents, records = _canonical_rows(store, ledger)

    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute(f"PRAGMA page_size={PAGE_SIZE}")
        connection.execute("PRAGMA journal_mode=DELETE")
        for statement in SCHEMA:
            connection.execute(statement)
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        connection.executemany("INSERT INTO source VALUES (?)", sources)
        connection.executemany("INSERT INTO version VALUES (?,?,?,?,?,?)", versions)
        connection.executemany("INSERT INTO content VALUES (?,?,?,?)", contents)
        if any(statement.startswith("CREATE TABLE record ") for statement in SCHEMA):
            connection.executemany("INSERT INTO record VALUES (?,?,?,?,?,?,?,?,?)", records)
        connection.executemany(
            "INSERT INTO search_plain (body, snapshot_digest, source_id) VALUES (?,?,?)",
            [(project(row[3]), row[0], row[1]) for row in contents],
        )
        connection.commit()
        connection.execute("VACUUM")
        connection.commit()
    finally:
        connection.close()
    return path


def rebuild(store: SnapshotStore, ledger: Ledger, path: Path) -> Path:
    """Build and verify a sibling, then atomically publish it over ``path``.

    On POSIX, ``os.replace`` leaves a reader connection opened before the
    replacement on the generation it opened; a later ``_open_for_reading``
    opens the published generation. The published path is never opened for
    writing or removed during the rebuild. A non-blocking sibling lock covers
    every mutable step, so a concurrent rebuild cannot disturb this one.
    """
    path = Path(path)
    sibling = path.with_name(path.name + ".rebuild")
    journal = sibling.with_name(sibling.name + "-journal")
    lock_path = path.with_name(path.name + ".rebuild.lock")

    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DerivedStoreError(f"rebuild in progress for {path.name}") from error
        try:
            # A sibling is only unfinished work, never a published generation.
            sibling.unlink(missing_ok=True)
            journal.unlink(missing_ok=True)
            try:
                build(store, ledger, sibling)
                verify(sibling)
                os.replace(sibling, path)
            except BaseException:
                # Keep the failure that interrupted the build or publication. Cleanup
                # must not replace it with a secondary failure.
                for artifact in (sibling, journal):
                    try:
                        artifact.unlink(missing_ok=True)
                    except OSError:
                        pass
                raise
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        os.close(handle)
    return path


def state_digest(path: Path) -> str:
    """The digest of the store's bytes.

    The file itself, not a summary of its contents: G-REBUILD's claim is
    byte-identical state, and hashing a canonical dump instead would prove a
    weaker thing while sounding like the same one.
    """
    return digest_bytes(Path(path).read_bytes())


def search(path: Path, query: str, limit: int = 10, role: str | None = None) -> tuple[SearchHit, ...]:
    """Full-text search, ordered deterministically.

    Ranked by relevance, then by digest and source, so equally-ranked rows have
    one order rather than whatever order the index walked them in.

    **This clause cannot be observed to matter on the current build, and that is
    stated rather than glossed.** Rows are inserted in digest order, so the
    index's own walk order already *is* digest order and removing the secondary
    key changes nothing measurable. It is kept because SQLite specifies no order
    for equal sort keys: the current behaviour is an observation about one
    engine, not a contract, and relying on it would make result order depend on
    something nobody agreed to.
    """
    if type(query) is not str or not query.strip():
        raise DerivedStoreError("a search needs a query")
    if type(limit) is not int or isinstance(limit, bool) or limit < 1:
        raise DerivedStoreError(f"limit must be a positive integer, not {limit!r}")
    if role is not None and (type(role) is not str or role not in {"user", "assistant"}):
        raise DerivedStoreError("role must be 'user', 'assistant', or None")
    # Natural-language punctuation is not FTS syntax. Retry only parser errors,
    # quoting each unicode61 token and OR-ing them so a question remains useful
    # when not every word appears in one message. OR is intentional here: implicit
    # AND across every question word made ordinary questions return no hits.
    tokens: list[str] = []
    token = ""
    for char in query:
        if char.isalnum() or unicodedata.category(char).startswith(("M", "Co")):
            token += char
        elif token:
            tokens.append(token)
            token = ""
    if token:
        tokens.append(token)
    if not tokens:
        # Punctuation alone cannot match a unicode61 token; say so instead of
        # leaking the engine's parser message.
        raise QueryError("the query has no searchable words")
    fallback_query = " OR ".join('"' + word.replace('"', '""') + '"' for word in tokens)

    connection = _open_for_reading(path)
    try:
        has_record = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record'"
        ).fetchone() is not None
        metadata_columns = (
            "r.kind, r.role, r.created_at"
            if has_record else "NULL, NULL, NULL"
        )
        record_join = (
            " LEFT JOIN record r ON r.snapshot_digest = s.snapshot_digest"
            "  AND r.source_id = s.source_id"
            if has_record else ""
        )
        statement = (
            "SELECT s.snapshot_digest, s.source_id,"
            " snippet(search_plain, 0, '', '', ' … ', 24),"
            f" {metadata_columns}, c.body, rank"
            " FROM search_plain s JOIN content c ON c.snapshot_digest = s.snapshot_digest"
            "  AND c.source_id = s.source_id"
            f"{record_join}"
            " WHERE search_plain MATCH ?"
            + (" AND r.role = ?" if role is not None else "")
            + " ORDER BY rank, s.snapshot_digest, s.source_id LIMIT ?"
        )
        parameters = (query, role, limit) if role is not None else (query, limit)
        try:
            rows = connection.execute(statement, parameters).fetchall()
        except sqlite3.OperationalError as error:
            error_text = str(error).lower()
            parser_error = "fts5: syntax error" in error_text or "unterminated string" in error_text
            if error_text.startswith("no such column:"):
                reported_column = error_text.partition(":")[2].strip()
                table_definition = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name='search_plain'"
                ).fetchone()
                is_fts5 = bool(
                    table_definition
                    and table_definition[0]
                    and "using fts5" in table_definition[0].lower()
                )
                fts_columns = {
                    row[1].lower()
                    for row in connection.execute("PRAGMA table_info(search_plain)").fetchall()
                }
                # FTS5 supplies rank, so its missing-column error can come from MATCH.
                parser_error = (
                    "." not in reported_column
                    and (reported_column != "rank" or is_fts5)
                    and "body" in fts_columns
                )
            if not parser_error or not fallback_query:
                raise
            parameters = (fallback_query, role, limit) if role is not None else (fallback_query, limit)
            rows = connection.execute(statement, parameters).fetchall()
    except sqlite3.OperationalError as error:
        # A malformed query is this module's failure to report, not the storage
        # engine's to leak.
        raise QueryError(f"the query could not be run: {error}") from error
    except sqlite3.DatabaseError as error:
        # DatabaseError is OperationalError's parent: "file is not a database"
        # and "disk image is malformed" arrive here, and are facts about the
        # store rather than about the query.
        raise StoreUnusable(f"the store could not be read: {error}") from error
    finally:
        connection.close()
    hits = []
    for row in rows:
        try:
            body_value = json.loads(row[6])
        except (json.JSONDecodeError, TypeError):
            body_value = None
        title = None
        if isinstance(body_value, dict):
            payload = body_value.get("payload")
            record_value = payload.get("record") if isinstance(payload, dict) else None
            for candidate in (
                payload.get("title") if isinstance(payload, dict) else None,
                record_value.get("title") if isinstance(record_value, dict) else None,
                body_value.get("title"),
            ):
                if isinstance(candidate, str) and candidate:
                    title = candidate
                    break
        hits.append(SearchHit(
            snapshot_digest=row[0], source_id=row[1], excerpt=row[2],
            kind=row[3], role=row[4], created_at=row[5], title=title,
        ))
    return tuple(hits)


#: The tables a usable store must have. Checked rather than assumed: SQLite
#: accepts a zero-byte file as a valid empty database, so "the file is there"
#: says nothing about whether anything can be read out of it.
_REQUIRED_TABLES = ("source", "version", "content", "record", "search_plain")


def verify(path: Path) -> None:
    """Raise unless ``path`` is a store this module can actually read.

    Called before a run rather than discovered during one. A zero-byte file is
    a valid empty SQLite database, so every query against it fails with
    "no such table" — and a caller skipping unparseable terms would skip all of
    them and report a completed run over nothing.
    """
    connection = _open_for_reading(path)
    try:
        present = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            ).fetchall()
        }
    except sqlite3.DatabaseError as error:
        raise StoreUnusable(f"the store could not be read: {error}") from error
    finally:
        connection.close()
    absent = [name for name in _REQUIRED_TABLES if name not in present]
    if absent:
        raise StoreUnusable(
            f"{Path(path).name} is not a derived store; it is missing {', '.join(absent)}"
        )


def _validate_context_window(before: int, after: int, limit: int) -> None:
    """Refuse window values that would change a bounded context query's meaning."""
    for name, value, minimum in (
        ("before", before, 0),
        ("after", after, 0),
        ("limit", limit, 1),
    ):
        if type(value) is not int or isinstance(value, bool) or value < minimum:
            qualifier = "non-negative" if minimum == 0 else "positive"
            raise QueryError(f"{name} must be a {qualifier} integer")


def _record_answer(row: tuple) -> dict[str, object]:
    """Render one indexed record without exposing index-only linkage fields."""
    return {
        "source_id": row[0],
        "snapshot_digest": row[1],
        "kind": row[2],
        "provider": row[3],
        "role": row[7],
        "created_at": row[8],
        "external_id": row[4],
        "parent_external_id": row[6],
        "bytes": row[9],
        "body": row[10],
    }


def _text_record_answer(connection: sqlite3.Connection, row: tuple, max_chars: int) -> dict[str, object]:
    """Render a record with its indexed plain-text projection instead of its body."""
    answer = _record_answer(row)
    answer.pop("body")
    projection = connection.execute(
        "SELECT body FROM search_plain WHERE source_id = ? AND snapshot_digest = ?",
        (row[0], row[1]),
    ).fetchone()
    full_text = None if projection is None else projection[0]
    answer.update({
        "text": None if full_text is None else full_text[:max_chars],
        "text_chars": None if full_text is None else len(full_text),
        "text_truncated": full_text is not None and len(full_text) > max_chars,
    })
    return answer


_RECORD_SELECT = (
    "SELECT r.source_id, r.snapshot_digest, r.kind, r.provider, r.external_id,"
    " r.container_external_id, r.parent_external_id, r.role, r.created_at,"
    " c.byte_length, c.body"
    " FROM record r JOIN content c ON c.snapshot_digest = r.snapshot_digest"
    "  AND c.source_id = r.source_id"
)


_TIP_CONTAINER_RECORDS = (
    _RECORD_SELECT
    + " JOIN version v ON v.source_id = r.source_id"
    "  AND v.snapshot_digest = r.snapshot_digest"
    " WHERE r.container_external_id = ?"
    "  AND v.sequence = ("
    "   SELECT MAX(tip.sequence) FROM version tip WHERE tip.source_id = v.source_id"
    "  )"
    " ORDER BY r.created_at IS NULL, r.created_at, r.source_id"
)


def context(
    path: Path,
    *,
    source_id: str | None = None,
    container: str | None = None,
    before: int = 2,
    after: int = 2,
    limit: int = 200,
    offset: int | None = None,
    view: str = "full",
    max_chars: int | None = None,
) -> dict[str, object]:
    """Read a source's conversation neighbourhood or a container's tip records.

    The index stores header fields only for snapshots canon already holds.  A
    source lookup first selects that source's tip, while a container lookup
    selects the tip of every source before ordering the resulting records.
    """
    if (source_id is None) == (container is None):
        raise QueryError("context requires exactly one of source_id or container")
    if source_id is not None and offset is not None:
        raise QueryError("offset is only valid with container")
    if container is not None:
        if offset is None:
            offset = 0
        if type(offset) is not int or isinstance(offset, bool) or offset < 0:
            raise QueryError("offset must be a non-negative integer")
    if view not in ("full", "text"):
        raise QueryError("view must be 'full' or 'text'")
    if view == "full" and max_chars is not None:
        raise QueryError("max_chars is only valid with view='text'")
    if max_chars is None:
        max_chars = 4000
    if type(max_chars) is not int or isinstance(max_chars, bool) or not 200 <= max_chars <= 20000:
        raise QueryError("max_chars must be an integer from 200 to 20000")
    _validate_context_window(before, after, limit)
    verify(path)
    connection = _open_for_reading(path)
    try:
        render = _record_answer if view == "full" else lambda row: _text_record_answer(connection, row, max_chars)
        def finish(answer: dict[str, object]) -> dict[str, object]:
            if view == "text":
                answer["view"] = {
                    "name": "text",
                    "max_chars": max_chars,
                    "full_text": "call knowledge.context with view full, or provenance.span with a citation, for the exact source bytes",
                    "basis": "text is a plain projection; citations refer to the source bytes",
                }
            return answer
        if source_id is not None:
            tip = connection.execute(
                "SELECT snapshot_digest FROM version WHERE source_id = ?"
                " ORDER BY sequence DESC LIMIT 1",
                (source_id,),
            ).fetchone()
            if tip is None:
                raise DerivedStoreError(f"source {source_id!r} is not in the derived index")
            target = connection.execute(
                _RECORD_SELECT + " WHERE r.source_id = ? AND r.snapshot_digest = ?",
                (source_id, tip[0]),
            ).fetchone()
            if target is None:
                raise StoreUnusable("the derived store is missing the source's tip record")
            target_answer = render(target)
            target_container = target[5]
            if target_container is None:
                return finish({
                    "source_id": source_id,
                    "container": None,
                    "target": target_answer,
                    "before": [],
                    "after": [],
                    "note": "no container recorded",
                })
            rows = connection.execute(_TIP_CONTAINER_RECORDS, (target_container,)).fetchall()
            position = next(
                (
                    index
                    for index, row in enumerate(rows)
                    if row[0] == target[0] and row[1] == target[1]
                ),
                None,
            )
            if position is None:
                raise StoreUnusable(
                    "the derived store's tip record is absent from its container query"
                )
            return finish({
                "source_id": source_id,
                "container": target_container,
                "position": position,
                "total": len(rows),
                "target": target_answer,
                "before": [render(row) for row in rows[max(0, position - before) : position]],
                "after": [render(row) for row in rows[position + 1 : position + 1 + after]],
            })
        total = connection.execute(
            "SELECT COUNT(*) FROM (" + _TIP_CONTAINER_RECORDS + ")", (container,)
        ).fetchone()[0]
        if offset >= total:
            rows = []
        else:
            rows = connection.execute(
                _TIP_CONTAINER_RECORDS + " LIMIT ? OFFSET ?", (container, limit, offset)
            ).fetchall()
        records = [render(row) for row in rows]
        returned = len(records)
        has_more = offset + returned < total
        return finish({
            "container": container,
            "total": total,
            "records": records,
            "offset": offset,
            "limit": limit,
            "returned": returned,
            "has_more": has_more,
            "next_offset": offset + returned if has_more else None,
        })
    except sqlite3.DatabaseError as error:
        raise StoreUnusable(f"the store could not be read: {error}") from error
    finally:
        connection.close()


def sources(path: Path) -> tuple[str, ...]:
    """Every source the store holds, sorted."""
    connection = _open_for_reading(path)
    try:
        rows = connection.execute("SELECT source_id FROM source ORDER BY source_id").fetchall()
    finally:
        connection.close()
    return tuple(row[0] for row in rows)


def versions(path: Path, source_id: str) -> tuple[str, ...]:
    """One source's snapshot digests, oldest first."""
    require_id(source_id, SOURCE_PREFIX)
    connection = _open_for_reading(path)
    try:
        rows = connection.execute(
            "SELECT snapshot_digest FROM version WHERE source_id = ? ORDER BY sequence",
            (source_id,),
        ).fetchall()
    finally:
        connection.close()
    return tuple(row[0] for row in rows)


def main() -> None:
    """Rebuild an index from explicitly named canon paths."""
    parser = argparse.ArgumentParser(description="Rebuild the derived index from canon")
    parser.add_argument("command", choices=("rebuild",))
    parser.add_argument("--snapshot-root", type=Path, required=True)
    parser.add_argument("--ledger-path", type=Path, required=True)
    parser.add_argument("--derived-path", type=Path, required=True)
    args = parser.parse_args()
    rebuild(SnapshotStore(args.snapshot_root), Ledger(args.ledger_path), args.derived_path)


if __name__ == "__main__":  # pragma: no cover
    main()
