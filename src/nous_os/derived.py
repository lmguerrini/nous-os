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
    "CREATE VIRTUAL TABLE search USING fts5("
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
    if not path.is_file():
        raise DerivedStoreError(f"no derived store at {path.name}; build it first")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


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
            "INSERT INTO search (body, snapshot_digest, source_id) VALUES (?,?,?)",
            [(row[3], row[0], row[1]) for row in contents],
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
    connection = _open_for_reading(path)
    try:
        rows = connection.execute(
            "SELECT s.snapshot_digest, s.source_id,"
            " substr(c.body, 1, 120), rank"
            " FROM search s JOIN content c ON c.snapshot_digest = s.snapshot_digest"
            "  AND c.source_id = s.source_id"
            " WHERE search MATCH ?"
            " ORDER BY rank, s.snapshot_digest, s.source_id"
            " LIMIT ?",
            (query, limit),
        ).fetchall()
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
    return tuple(
        SearchHit(snapshot_digest=row[0], source_id=row[1], excerpt=row[2]) for row in rows
    )


#: The tables a usable store must have. Checked rather than assumed: SQLite
#: accepts a zero-byte file as a valid empty database, so "the file is there"
#: says nothing about whether anything can be read out of it.
_REQUIRED_TABLES = ("source", "version", "content", "search")


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
