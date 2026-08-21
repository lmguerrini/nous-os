"""The ingest ledger: what was taken in, when, and what it replaced.

**The ledger is a file.** Not a database — canon is files, and a ledger that
lived only in an index would make the derived layer authoritative for the one
question the derived layer is supposed to be rebuildable from. It is append-only
JSON Lines, one entry per line, each line the canonical serialisation of its
entry. Reading it back is the whole of recovery.

Three properties this module exists to hold, and each has a direction that is
easy to lose:

**Deterministic.** The same inputs, in the same order, produce byte-identical
ledger contents in any process. No wall clock is read here; the caller supplies
the instant, because a ledger that timestamps itself cannot be reproduced.

**Idempotent.** Re-ingesting bytes that have not changed appends nothing,
creates no snapshot, and says so. Ingest is something a person will run
repeatedly over a corpus that mostly has not changed, so "no change" is the
common path and must be cheap and silent.

**Invalidation fires if and only if the source bytes change.** Both directions
matter and they fail differently: firing when nothing changed throws away work
that was still good, and failing to fire when something did serves answers
derived from text that no longer exists. Nothing else — not a new instant, not a
re-run, not a quarantine reason — may invalidate anything.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from nous_os.identity import SOURCE_PREFIX, canonical_bytes, require_id
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import QuarantineReason, UntrustedText, inspect_shape


class LedgerError(Exception):
    """Raised when an operation would make the ledger untrue."""


class IdentifierCollision(LedgerError):
    """Raised when a different record claims an identifier already held.

    Uniqueness is a property of a **collection**, so it is enforced here rather
    than on the record: a single assertion cannot know about another one. This
    is the obligation the canonical-model capability recorded and could not
    discharge, because it deliberately ships no collection.
    """


class IngestStatus(Enum):
    """What an ingest did. A closed vocabulary."""

    #: This source had never been seen.
    INGESTED = "ingested"
    #: The bytes are the ones already held. Nothing was written.
    UNCHANGED = "unchanged"
    #: The bytes differ from the held version, which is now superseded.
    SUPERSEDED = "superseded"


def _instant(value: datetime, field: str) -> str:
    if not isinstance(value, datetime):
        raise LedgerError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise LedgerError(f"{field} must carry a timezone")
    try:
        return value.astimezone(timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise LedgerError(f"{field} cannot be normalised to UTC") from error


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """One recorded ingest."""

    source_id: str
    snapshot_digest: str
    previous_digest: str | None
    recorded_at: datetime
    quarantine: tuple[QuarantineReason, ...] = ()

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        if type(self.snapshot_digest) is not str or len(self.snapshot_digest) != 64:
            raise LedgerError("snapshot_digest must be a 64-character digest")
        if self.previous_digest is not None and type(self.previous_digest) is not str:
            raise LedgerError("previous_digest must be a digest or None")
        if self.previous_digest == self.snapshot_digest:
            raise LedgerError(
                "an entry cannot supersede itself; identical bytes are not a new version"
            )
        _instant(self.recorded_at, "recorded_at")
        if type(self.quarantine) is not tuple or any(
            not isinstance(reason, QuarantineReason) for reason in self.quarantine
        ):
            raise LedgerError("quarantine must be a tuple of QuarantineReason")

    def as_payload(self) -> dict[str, object]:
        """The canonical form written to the ledger file."""
        return {
            "source_id": self.source_id,
            "snapshot_digest": self.snapshot_digest,
            "previous_digest": self.previous_digest,
            "recorded_at": _instant(self.recorded_at, "recorded_at"),
            "quarantine": [reason.value for reason in self.quarantine],
        }


@dataclass(frozen=True, slots=True)
class IngestResult:
    """What one ingest call did, and whether anything was invalidated."""

    status: IngestStatus
    entry: LedgerEntry | None
    invalidated_digest: str | None

    @property
    def invalidated(self) -> bool:
        """Whether this ingest invalidated a previously held version."""
        return self.invalidated_digest is not None


class Ledger:
    """An append-only record of ingests, backed by one file."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def entries(self) -> tuple[LedgerEntry, ...]:
        """Every entry, in the order recorded.

        Order comes from the file, not from the filesystem: the ledger is the
        authority on sequence, and a directory listing is not a sequence.
        """
        if not self._path.is_file():
            return ()
        found = []
        for number, line in enumerate(
            self._path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as error:
                raise LedgerError(f"ledger line {number} is not readable") from error
            found.append(
                LedgerEntry(
                    source_id=payload["source_id"],
                    snapshot_digest=payload["snapshot_digest"],
                    previous_digest=payload["previous_digest"],
                    recorded_at=datetime.fromisoformat(payload["recorded_at"]),
                    quarantine=tuple(
                        QuarantineReason(value) for value in payload["quarantine"]
                    ),
                )
            )
        return tuple(found)

    def append(self, entry: LedgerEntry) -> None:
        """Append one entry. The only way the ledger grows."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = canonical_bytes(entry.as_payload())
        with self._path.open("ab") as handle:
            handle.write(line + b"\n")

    def chain(self, source_id: str) -> tuple[LedgerEntry, ...]:
        """This source's versions, oldest first.

        **Order comes from the file**, which is append-only and is therefore the
        authority on sequence. The ``previous_digest`` links are then *verified*
        against that order rather than used to rebuild it.

        The distinction is not academic. An earlier version of this method keyed
        reconstruction on ``previous_digest``, treating it as unique — which it
        is not, because content repeats. Someone editing a document, reverting
        it, and making the same edit again produces two entries with the same
        predecessor, and that is an ordinary thing to do rather than a corrupt
        ledger. Rebuilding from the links reported it as a broken history; the
        history was fine and the reconstruction was wrong.
        """
        require_id(source_id, SOURCE_PREFIX)
        mine = tuple(entry for entry in self.entries() if entry.source_id == source_id)
        if not mine:
            return ()
        if mine[0].previous_digest is not None:
            raise LedgerError(
                f"the first recorded entry for {source_id} claims a predecessor, so "
                "this ledger does not contain the start of its history"
            )
        for earlier, later in zip(mine, mine[1:]):
            if later.previous_digest != earlier.snapshot_digest:
                raise LedgerError(
                    f"the version chain for {source_id} is broken: an entry claims "
                    f"predecessor {later.previous_digest} where the preceding entry "
                    f"recorded {earlier.snapshot_digest}"
                )
        return mine

    def current_digest(self, source_id: str) -> str | None:
        """The digest currently held for this source, or None if never ingested."""
        chain = self.chain(source_id)
        return chain[-1].snapshot_digest if chain else None


def ingest(
    store: SnapshotStore,
    ledger: Ledger,
    source_id: str,
    content: UntrustedText,
    recorded_at: datetime,
) -> IngestResult:
    """Take content in, and report exactly what changed.

    ``content`` is ``UntrustedText`` and not ``str`` on purpose: everything that
    reaches this function came from outside, and the signature is where that
    stops being a matter of anyone's memory.
    """
    require_id(source_id, SOURCE_PREFIX)
    if not isinstance(content, UntrustedText):
        raise LedgerError(
            "ingest takes UntrustedText; a bare str would make ingested content "
            "indistinguishable from text this system wrote itself"
        )
    _instant(recorded_at, "recorded_at")

    data = content.as_data().encode("utf-8")
    snapshot = store.put(source_id, data)
    held = ledger.current_digest(source_id)

    if held == snapshot.digest:
        # Idempotent. Nothing is appended: a second identical ingest is not a
        # second version, and recording it would make the chain describe how
        # often ingest was run rather than how often the source changed.
        return IngestResult(IngestStatus.UNCHANGED, None, None)

    entry = LedgerEntry(
        source_id=source_id,
        snapshot_digest=snapshot.digest,
        previous_digest=held,
        recorded_at=recorded_at,
        quarantine=inspect_shape(content),
    )
    ledger.append(entry)
    if held is None:
        return IngestResult(IngestStatus.INGESTED, entry, None)
    return IngestResult(IngestStatus.SUPERSEDED, entry, held)


class AssertionRegistry:
    """Identifier uniqueness, enforced where a collection actually exists.

    The canonical-model capability could not do this: uniqueness is a property
    of a set, and a single record cannot see its siblings. This is the smallest
    thing that can hold the obligation — a mapping from id to content digest,
    which refuses a second, *different* record claiming an id it already holds
    and accepts an identical re-registration, because re-ingest must stay
    idempotent here too.
    """

    __slots__ = ("_seen",)

    def __init__(self) -> None:
        self._seen: dict[str, str] = {}

    def register(self, assertion_id: str, content_digest: str) -> None:
        existing = self._seen.get(assertion_id)
        if existing is None:
            self._seen[assertion_id] = content_digest
            return
        if existing != content_digest:
            raise IdentifierCollision(
                f"{assertion_id} is already held with different content; an "
                "identifier names one thing"
            )

    def __contains__(self, assertion_id: object) -> bool:
        return assertion_id in self._seen

    def __len__(self) -> int:
        return len(self._seen)
