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

**A divergence is reported, not indexed around.** If the ledger names a snapshot
the store does not hold, this refuses to build. An index that quietly skipped it
would answer questions as though a document did not exist, which is worse than
failing: the failure is visible and the silence is not.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from nous_os.identity import SOURCE_PREFIX, digest_bytes, require_id
from nous_os.ledger import Ledger
from nous_os.snapshots import SnapshotNotFound, SnapshotStore

#: Fixed so the file layout does not depend on a build-time default.
PAGE_SIZE = 4096

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
    "CREATE TABLE content ("
    " snapshot_digest TEXT PRIMARY KEY NOT NULL,"
    " source_id TEXT NOT NULL,"
    " byte_length INTEGER NOT NULL,"
    " body TEXT NOT NULL"
    ")",
    "CREATE VIRTUAL TABLE search USING fts5("
    " body, snapshot_digest UNINDEXED, tokenize='unicode61'"
    ")",
)


class DerivedStoreError(Exception):
    """Raised when the derived store cannot be built truthfully."""


class CanonDivergence(DerivedStoreError):
    """The canonical layer does not hold something the ledger names.

    Its own failure, deliberately. This is the divergence the ingest capability
    left visible rather than healing in passing: a ledger restored beside an
    incomplete snapshot store. Repairing it silently here would hide it in the
    one place designed to notice.
    """


@dataclass(frozen=True, slots=True)
class SearchHit:
    """One result. Ordered by relevance, then by digest to break ties."""

    snapshot_digest: str
    source_id: str
    excerpt: str


def _canonical_rows(store: SnapshotStore, ledger: Ledger) -> tuple[list, list, list]:
    """Everything the store will hold, in the one order it will hold it.

    Ordering is derived from content — source id, then position in that source's
    own chain — so it is a fact about canon rather than about how the filesystem
    happened to answer.
    """
    sources = sorted({entry.source_id for entry in ledger.entries()})
    versions: list[tuple] = []
    contents: list[tuple] = []
    seen_digests: set[str] = set()

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
            if entry.snapshot_digest in seen_digests:
                continue
            seen_digests.add(entry.snapshot_digest)
            try:
                snapshot = store.get(entry.source_id, entry.snapshot_digest)
            except SnapshotNotFound as error:
                raise CanonDivergence(
                    f"the ledger names snapshot {entry.snapshot_digest} of "
                    f"{entry.source_id}, which the snapshot store does not hold; "
                    "canon is incomplete and an index built now would answer as "
                    "though that version never existed"
                ) from error
            contents.append(
                (
                    entry.snapshot_digest,
                    entry.source_id,
                    len(snapshot.data),
                    snapshot.data.decode("utf-8", errors="replace"),
                )
            )

    contents.sort(key=lambda row: row[0])
    return [(source_id,) for source_id in sources], versions, contents


def build(store: SnapshotStore, ledger: Ledger, path: Path) -> Path:
    """Build the derived store at ``path`` from canon alone.

    Refuses to overwrite. A rebuild deletes first, deliberately: writing over a
    live database would leave whatever the previous build put there and call the
    result a rebuild.
    """
    path = Path(path)
    if path.exists():
        raise DerivedStoreError(
            f"{path.name} already exists; a rebuild removes the store first, so "
            "that nothing from the previous build can survive into this one"
        )
    sources, versions, contents = _canonical_rows(store, ledger)

    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute(f"PRAGMA page_size={PAGE_SIZE}")
        connection.execute("PRAGMA journal_mode=DELETE")
        for statement in SCHEMA:
            connection.execute(statement)
        connection.executemany("INSERT INTO source VALUES (?)", sources)
        connection.executemany("INSERT INTO version VALUES (?,?,?,?,?,?)", versions)
        connection.executemany("INSERT INTO content VALUES (?,?,?,?)", contents)
        connection.executemany(
            "INSERT INTO search (body, snapshot_digest) VALUES (?,?)",
            [(row[3], row[0]) for row in contents],
        )
        connection.commit()
        connection.execute("VACUUM")
        connection.commit()
    finally:
        connection.close()
    return path


def rebuild(store: SnapshotStore, ledger: Ledger, path: Path) -> Path:
    """Delete the store and build it again. The whole of recovery."""
    path = Path(path)
    if path.exists():
        path.unlink()
    return build(store, ledger, path)


def state_digest(path: Path) -> str:
    """The digest of the store's bytes.

    The file itself, not a summary of its contents: G-REBUILD's claim is
    byte-identical state, and hashing a canonical dump instead would prove a
    weaker thing while sounding like the same one.
    """
    return digest_bytes(Path(path).read_bytes())


def search(path: Path, query: str, limit: int = 10) -> tuple[SearchHit, ...]:
    """Full-text search, ordered deterministically.

    Ranked by relevance and then by digest, because two equally-ranked rows
    would otherwise come back in whatever order the index walked them, and a
    result order that varies is not reproducible evidence.
    """
    if type(query) is not str or not query.strip():
        raise DerivedStoreError("a search needs a query")
    connection = sqlite3.connect(Path(path))
    try:
        rows = connection.execute(
            "SELECT s.snapshot_digest, c.source_id,"
            " substr(c.body, 1, 120), rank"
            " FROM search s JOIN content c ON c.snapshot_digest = s.snapshot_digest"
            " WHERE search MATCH ?"
            " ORDER BY rank, s.snapshot_digest"
            " LIMIT ?",
            (query, limit),
        ).fetchall()
    finally:
        connection.close()
    return tuple(
        SearchHit(snapshot_digest=row[0], source_id=row[1], excerpt=row[2]) for row in rows
    )


def sources(path: Path) -> tuple[str, ...]:
    """Every source the store holds, sorted."""
    connection = sqlite3.connect(Path(path))
    try:
        rows = connection.execute("SELECT source_id FROM source ORDER BY source_id").fetchall()
    finally:
        connection.close()
    return tuple(row[0] for row in rows)


def versions(path: Path, source_id: str) -> tuple[str, ...]:
    """One source's snapshot digests, oldest first."""
    require_id(source_id, SOURCE_PREFIX)
    connection = sqlite3.connect(Path(path))
    try:
        rows = connection.execute(
            "SELECT snapshot_digest FROM version WHERE source_id = ? ORDER BY sequence",
            (source_id,),
        ).fetchall()
    finally:
        connection.close()
    return tuple(row[0] for row in rows)
