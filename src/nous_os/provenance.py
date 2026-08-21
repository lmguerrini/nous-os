"""Provenance: where a claim came from, exactly.

A provenance record that cannot be resolved looks exactly like one that can,
right up until somebody checks. So the record here is not a reference to a
document — it is a reference to **specific bytes of a specific snapshot**,
carrying the text it claims to have found there. Checking it is then a
comparison, not a judgement.

That check is **quote-lint**, and it fails in ways that are kept distinguishable
on purpose. "The snapshot is gone", "the offsets no longer point at anything",
"the offsets point somewhere real but the text there is different" and "the
offsets fall inside a character" are four different problems with four
different causes, and collapsing them into one error would throw away the only
information a person needs to fix it.
"""

from __future__ import annotations

from dataclasses import dataclass

from nous_os.identity import SOURCE_PREFIX, require_id
from nous_os.snapshots import SnapshotNotFound, SnapshotStore


class ProvenanceError(Exception):
    """Base class for a citation that does not hold up."""


class LocatorOutOfRange(ProvenanceError):
    """The cited offsets fall outside the snapshot."""


class LocatorSplitsCharacter(ProvenanceError):
    """The cited offsets fall inside a multi-byte character.

    Its own failure, not a mismatch: the offsets are arithmetically valid and
    the text is not wrong, the boundary is. Reporting this as a mismatch would
    send someone looking for an edit that never happened.
    """


class SpanMismatch(ProvenanceError):
    """The snapshot holds different text at the cited offsets."""


@dataclass(frozen=True)
class Locator:
    """A half-open byte range into a snapshot: ``[start, end)``.

    Byte offsets rather than line numbers. A line number is a description of a
    rendering, and it moves when anything above it is edited; a byte range into
    an immutable snapshot means one thing forever.
    """

    start_byte: int
    end_byte: int

    def __post_init__(self) -> None:
        if not isinstance(self.start_byte, int) or not isinstance(self.end_byte, int):
            raise ProvenanceError("locator offsets must be integers")
        if self.start_byte < 0:
            raise ProvenanceError(f"negative start offset: {self.start_byte}")
        if self.end_byte <= self.start_byte:
            raise ProvenanceError(
                f"empty or inverted range: [{self.start_byte}, {self.end_byte})"
            )


@dataclass(frozen=True)
class Citation:
    """A claim about what a named snapshot says at a named place."""

    source_id: str
    snapshot_digest: str
    locator: Locator
    span: str

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        if not self.snapshot_digest:
            raise ProvenanceError("a citation must name a snapshot digest")
        if not self.span:
            raise ProvenanceError("a citation must carry the span it claims to quote")

    def as_payload(self) -> dict[str, object]:
        """The content form of this citation, for hashing."""
        return {
            "source_id": self.source_id,
            "snapshot_digest": self.snapshot_digest,
            "start_byte": self.locator.start_byte,
            "end_byte": self.locator.end_byte,
            "span": self.span,
        }


def read_span(store: SnapshotStore, citation: Citation) -> str:
    """Return the text the snapshot actually holds at the cited offsets.

    Raises rather than guessing. A snapshot that is absent raises
    ``SnapshotNotFound`` from the store unchanged, because "the thing you cited
    is not here" is the store's fact to report, not this module's to reword.
    """
    snapshot = store.get(citation.source_id, citation.snapshot_digest)
    data = snapshot.data
    if citation.locator.end_byte > len(data):
        raise LocatorOutOfRange(
            f"range [{citation.locator.start_byte}, {citation.locator.end_byte}) "
            f"exceeds the {len(data)}-byte snapshot"
        )
    fragment = data[citation.locator.start_byte : citation.locator.end_byte]
    try:
        return fragment.decode("utf-8")
    except UnicodeDecodeError as error:
        raise LocatorSplitsCharacter(
            f"range [{citation.locator.start_byte}, {citation.locator.end_byte}) "
            "does not begin and end on character boundaries"
        ) from error


def quote_lint(store: SnapshotStore, citation: Citation) -> None:
    """Verify the citation quotes its source exactly. Raise if it does not.

    Returns ``None`` on success deliberately. A boolean return invites
    ``if quote_lint(...)`` at a call site that then treats a corrupt citation
    as merely falsy, and the reason for the failure — the useful part — is
    discarded on the way.
    """
    found = read_span(store, citation)
    if found != citation.span:
        raise SpanMismatch(
            "the snapshot does not say this at the cited offsets: "
            f"cited {citation.span!r}, found {found!r}"
        )


def resolves(store: SnapshotStore, citation: Citation) -> bool:
    """Whether ``citation`` passes quote-lint. For reporting over a set.

    Use ``quote_lint`` when acting on one citation; this exists for counting
    across many, where the individual reasons are collected separately.
    """
    try:
        quote_lint(store, citation)
    except (ProvenanceError, SnapshotNotFound):
        return False
    return True
