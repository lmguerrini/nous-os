"""Immutable source snapshots.

A snapshot is the exact bytes of a source at one moment, stored under the
digest of those bytes. **Immutability is structural, not a rule anyone has to
follow**: the name of the file is the hash of its contents, so editing the
contents in place cannot leave the file where it was. There is no code path
that overwrites a snapshot because there is no code path that could.

Re-ingesting a source whose bytes changed therefore *adds*; it never replaces.
The earlier snapshot remains byte-identical and still resolvable, which is what
lets an assertion made against it keep making sense afterwards.

This module stores and resolves snapshots. It does not decide *when* to take
one, does not track what has been seen, and keeps no ledger — that is a later
capability, and putting it here would mean this one certifies behaviour it was
never scoped to test.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from nous_os.identity import SOURCE_PREFIX, digest_bytes, require_id

#: Extension for stored snapshot bodies. The stem is the digest.
SNAPSHOT_SUFFIX = ".snapshot"


class SnapshotNotFound(Exception):
    """Raised when a cited snapshot is absent from the store.

    Distinct from a corrupt snapshot: absent and wrong are different answers
    and are never collapsed into one.
    """


class SnapshotCorrupt(Exception):
    """Raised when a stored snapshot's bytes do not hash to its own name."""


@dataclass(frozen=True, slots=True)
class Snapshot:
    """One immutable capture of a source's bytes."""

    source_id: str
    digest: str
    data: bytes

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        # Exactly bytes. A bytearray satisfies the annotation and every
        # isinstance check, and then the caller can edit it afterwards -- the
        # digest was verified once, at construction, against contents that no
        # longer exist. An immutable value has to actually be immutable.
        if type(self.data) is not bytes:
            raise SnapshotCorrupt(
                f"snapshot data must be immutable bytes, not {type(self.data).__name__}"
            )
        actual = digest_bytes(self.data)
        if actual != self.digest:
            raise SnapshotCorrupt(
                f"snapshot claims digest {self.digest} but its bytes hash to {actual}"
            )


class SnapshotStore:
    """An append-only, content-addressed store of source snapshots."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def _dir(self, source_id: str) -> Path:
        return self._root / require_id(source_id, SOURCE_PREFIX)

    def _path(self, source_id: str, digest: str) -> Path:
        return self._dir(source_id) / f"{digest}{SNAPSHOT_SUFFIX}"

    def put(self, source_id: str, data: bytes) -> Snapshot:
        """Store ``data`` as a snapshot of ``source_id`` and return it.

        Storing bytes that are already present is a no-op that returns the
        existing snapshot: re-ingesting an unchanged source must not create a
        second copy of it, and must not fail either.
        """
        digest = digest_bytes(data)
        path = self._path(source_id, digest)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            # Write to a sibling and move, so an interrupted write cannot leave
            # a truncated file sitting under a digest that promises otherwise.
            temporary = path.with_suffix(".partial")
            temporary.write_bytes(data)
            temporary.replace(path)
        return Snapshot(source_id=source_id, digest=digest, data=data)

    def get(self, source_id: str, digest: str) -> Snapshot:
        """Resolve one snapshot, verifying its bytes still hash to its name."""
        path = self._path(source_id, digest)
        if not path.is_file():
            raise SnapshotNotFound(f"no snapshot {digest} for {source_id}")
        data = path.read_bytes()
        actual = digest_bytes(data)
        if actual != digest:
            raise SnapshotCorrupt(
                f"snapshot {digest} of {source_id} now hashes to {actual}"
            )
        return Snapshot(source_id=source_id, digest=digest, data=data)

    def digests(self, source_id: str) -> tuple[str, ...]:
        """Every snapshot digest held for ``source_id``, sorted.

        Sorted rather than chronological: this store deliberately records no
        time, so an order derived from the filesystem would be an accident
        presented as a fact.
        """
        directory = self._dir(source_id)
        if not directory.is_dir():
            return ()
        return tuple(
            sorted(
                path.stem
                for path in directory.iterdir()
                if path.suffix == SNAPSHOT_SUFFIX
            )
        )

    def has(self, source_id: str, digest: str) -> bool:
        return self._path(source_id, digest).is_file()
