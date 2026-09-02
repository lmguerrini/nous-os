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

import re
import unicodedata
from dataclasses import dataclass

from nous_os.identity import SOURCE_PREFIX, require_id
from nous_os.snapshots import SnapshotCorrupt, SnapshotNotFound, SnapshotStore


_HEX64 = re.compile(r"[0-9a-f]{64}")


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


class SnapshotNotText(ProvenanceError):
    """The snapshot is not UTF-8 text at all.

    Its own failure. Reporting this as a split character would say the offsets
    are wrong when the offsets are fine and the *file* is not text -- a
    confidently wrong reason, which is the thing this module refuses to give.
    """


class LocatorSplitsGrapheme(ProvenanceError):
    """The cited range begins or ends part-way through a written character.

    Distinct from splitting a codepoint. ``café`` in decomposed form is five
    codepoints, and a range covering the first four decodes cleanly to
    ``cafe`` -- a quote that drops the accent and changes the word, which
    quote-lint would otherwise certify as exact.
    """


class SpanMismatch(ProvenanceError):
    """The snapshot holds different text at the cited offsets."""


@dataclass(frozen=True, slots=True)
class Locator:
    """A half-open byte range into a snapshot: ``[start, end)``.

    Byte offsets rather than line numbers. A line number is a description of a
    rendering, and it moves when anything above it is edited; a byte range into
    an immutable snapshot means one thing forever.
    """

    start_byte: int
    end_byte: int

    def __post_init__(self) -> None:
        for name, value in (("start_byte", self.start_byte), ("end_byte", self.end_byte)):
            # bool is a subclass of int, so isinstance would accept True/False.
            # They compare equal to 1/0 but serialise as `true`/`false`, which
            # would give two digests to one offset -- an "if and only if"
            # broken by a type nobody meant to allow.
            if type(value) is not int:
                raise ProvenanceError(
                    f"{name} must be an int, not {type(value).__name__}"
                )
        if self.start_byte < 0:
            raise ProvenanceError(f"negative start offset: {self.start_byte}")
        if self.end_byte <= self.start_byte:
            raise ProvenanceError(
                f"empty or inverted range: [{self.start_byte}, {self.end_byte})"
            )


@dataclass(frozen=True, slots=True)
class Citation:
    """A claim about what a named snapshot says at a named place."""

    source_id: str
    snapshot_digest: str
    locator: Locator
    span: str

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        # Exact types, not isinstance. The canonical schema is closed on
        # purpose: a subclass can override a method or shadow a field, and a
        # record whose shape depends on what someone passed in is not a schema.
        if type(self.locator) is not Locator:
            raise ProvenanceError(
                f"locator must be a Locator, not {type(self.locator).__name__}"
            )
        if type(self.span) is not str:
            raise ProvenanceError(f"span must be a str, not {type(self.span).__name__}")
        if type(self.snapshot_digest) is not str:
            raise ProvenanceError("snapshot_digest must be a str")
        # A digest is 64 lowercase hex characters and nothing else. Unvalidated
        # it reaches a filesystem path, where a relative traversal escapes the
        # store entirely and reads a file that is not a snapshot at all.
        if not _HEX64.fullmatch(self.snapshot_digest):
            raise ProvenanceError(
                f"snapshot_digest must be 64 lowercase hex characters: "
                f"{self.snapshot_digest!r}"
            )
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
    start, end = citation.locator.start_byte, citation.locator.end_byte
    fragment = data[start:end]
    try:
        text = fragment.decode("utf-8")
    except UnicodeDecodeError as error:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise SnapshotNotText(
                f"snapshot {citation.snapshot_digest} is not UTF-8 text, so no "
                "byte range in it names a span"
            ) from error
        raise LocatorSplitsCharacter(
            f"range [{start}, {end}) does not begin and end on character boundaries"
        ) from error

    # The cited range decoded, but a byte anywhere else in the snapshot can
    # still be invalid UTF-8 -- a text document with a corrupted or binary
    # tail is not text, even where this one citation happens to land cleanly.
    # Decoded here purely as a check: the result is not the range this
    # function returns, so nothing keeps it.
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SnapshotNotText(
            f"snapshot {citation.snapshot_digest} is not UTF-8 text, so no "
            "byte range in it names a span"
        ) from error

    # Codepoint boundaries are not character boundaries. A range may decode
    # cleanly and still cut a written character in half, when what follows is a
    # combining mark that belongs to the last codepoint inside the range.
    if text and unicodedata.combining(text[0]):
        raise LocatorSplitsGrapheme(
            f"range [{start}, {end}) begins on a combining mark, part-way "
            "through a written character"
        )
    trailing = data[end:end + 4]
    if trailing:
        try:
            following = trailing.decode("utf-8", errors="ignore")
        except UnicodeDecodeError:  # pragma: no cover - errors="ignore" cannot raise
            following = ""
        if following and unicodedata.combining(following[0]):
            raise LocatorSplitsGrapheme(
                f"range [{start}, {end}) ends immediately before a combining "
                "mark, cutting a written character in half"
            )
    return text


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
    except (ProvenanceError, SnapshotNotFound, SnapshotCorrupt):
        # SnapshotCorrupt belongs here too. This function exists to count
        # across many citations, and a bulk report that aborts on the first
        # corrupt snapshot fails at exactly the condition it was built to
        # surface.
        return False
    return True
