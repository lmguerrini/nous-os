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

import json
import re
import unicodedata
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from nous_os.extraction import ExtractionError, ExtractionOutcome, Extractor
from nous_os.identity import SOURCE_PREFIX, digest_bytes, require_id
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


class DerivedRecordNotFound(ProvenanceError):
    """The extraction record named by a derived citation is absent."""


class DerivedRecordCorrupt(ProvenanceError, ExtractionError):
    """The extraction record does not authenticate its stored payload."""


class DerivedVersionMismatch(ProvenanceError):
    """The citation names a different extractor version than the record."""


class DerivedOwnerMismatch(ProvenanceError):
    """The cited asset source is not an owner of the stored extraction."""


class DerivedAssetMismatch(ProvenanceError):
    """The latest source metadata does not name the extracted asset bytes."""


class DerivedLedgerUnreadable(ProvenanceError):
    """The asset ledger cannot provide a validated source history."""


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
class CharLocator:
    """A half-open character range into extracted Unicode text."""

    start_char: int
    end_char: int

    def __post_init__(self) -> None:
        for name, value in (("start_char", self.start_char), ("end_char", self.end_char)):
            if type(value) is not int:
                raise ProvenanceError(f"{name} must be an int, not {type(value).__name__}")
        if self.start_char < 0:
            raise ProvenanceError(f"negative start offset: {self.start_char}")
        if self.end_char <= self.start_char:
            raise ProvenanceError(
                f"empty or inverted range: [{self.start_char}, {self.end_char})"
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


@dataclass(frozen=True, slots=True)
class DerivedCitation:
    """A quote from text deterministically extracted from an attachment."""

    asset_source_id: str
    asset_digest: str
    extractor: Extractor
    extractor_version: str
    record_digest: str
    locator: CharLocator
    span: str

    def __post_init__(self) -> None:
        if type(self.asset_source_id) is not str:
            raise ProvenanceError(
                "asset_source_id must be a str, "
                f"not {type(self.asset_source_id).__name__}"
            )
        require_id(self.asset_source_id, SOURCE_PREFIX)
        if type(self.asset_digest) is not str or _HEX64.fullmatch(self.asset_digest) is None:
            raise ProvenanceError("asset_digest must be 64 lowercase hex characters")
        if type(self.record_digest) is not str or _HEX64.fullmatch(self.record_digest) is None:
            raise ProvenanceError("record_digest must be 64 lowercase hex characters")
        if type(self.extractor) is not Extractor:
            raise ProvenanceError(
                f"extractor must be an Extractor, not {type(self.extractor).__name__}"
            )
        if type(self.extractor_version) is not str or not self.extractor_version.strip():
            raise ProvenanceError("extractor_version must be a non-blank str")
        if type(self.locator) is not CharLocator:
            raise ProvenanceError(
                f"locator must be a CharLocator, not {type(self.locator).__name__}"
            )
        if type(self.span) is not str:
            raise ProvenanceError(f"span must be a str, not {type(self.span).__name__}")
        if not self.span:
            raise ProvenanceError("a derived citation must carry the span it claims to quote")

    def as_payload(self) -> dict[str, object]:
        """The complete content form of this derived citation."""
        return {
            "asset_source_id": self.asset_source_id,
            "asset_digest": self.asset_digest,
            "extractor": self.extractor.value,
            "extractor_version": self.extractor_version,
            "record_digest": self.record_digest,
            "start_char": self.locator.start_char,
            "end_char": self.locator.end_char,
            "span": self.span,
        }


_DERIVED_CITATION_FIELDS = frozenset(
    {
        "asset_source_id",
        "asset_digest",
        "extractor",
        "extractor_version",
        "record_digest",
        "start_char",
        "end_char",
        "span",
    }
)


def derived_citation_from_payload(value: object) -> DerivedCitation:
    """Construct a closed derived citation from its JSON-shaped payload."""
    if type(value) is not dict or set(value) != _DERIVED_CITATION_FIELDS:
        raise ProvenanceError("derived citation has the wrong shape")
    extractor_value = value["extractor"]
    if type(extractor_value) is not str:
        raise ProvenanceError("derived citation extractor must be a string")
    try:
        extractor = Extractor(extractor_value)
    except ValueError as error:
        raise ProvenanceError("derived citation extractor is not declared") from error
    return DerivedCitation(
        asset_source_id=value["asset_source_id"],
        asset_digest=value["asset_digest"],
        extractor=extractor,
        extractor_version=value["extractor_version"],
        record_digest=value["record_digest"],
        locator=CharLocator(value["start_char"], value["end_char"]),
        span=value["span"],
    )


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
        snapshot_text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SnapshotNotText(
            f"snapshot {citation.snapshot_digest} is not UTF-8 text, so no "
            "byte range in it names a span"
        ) from error

    character_offsets = _utf8_character_offsets(snapshot_text)
    _validate_grapheme_span(
        snapshot_text,
        character_offsets[start],
        character_offsets[end],
        f"range [{start}, {end})",
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


def _utf8_character_offsets(text: str) -> dict[int, int]:
    """Map each UTF-8 codepoint boundary to its Unicode-string index."""
    offsets = {0: 0}
    byte_offset = 0
    for character_index, character in enumerate(text, start=1):
        byte_offset += len(character.encode("utf-8"))
        offsets[byte_offset] = character_index
    return offsets


def _is_grapheme_extend(character: str) -> bool:
    """Whether this codepoint extends the preceding grapheme cluster."""
    codepoint = ord(character)
    return (
        unicodedata.category(character) in {"Mn", "Mc", "Me"}
        or 0xFE00 <= codepoint <= 0xFE0F
        or 0xE0100 <= codepoint <= 0xE01EF
        or 0x1F3FB <= codepoint <= 0x1F3FF
    )


def _is_regional_indicator(character: str) -> bool:
    return 0x1F1E6 <= ord(character) <= 0x1F1FF


def _grapheme_boundaries(text: str) -> frozenset[int]:
    """Return citation boundaries excluding Extend, ZWJ, and RI-pair breaks.

    This is a subset of UAX #29: it refuses boundaries before grapheme-extend
    codepoints, on either side of ZWJ, and inside regional-indicator pairs.
    """
    boundaries = {0}
    regional_indicator_run = 1 if text and _is_regional_indicator(text[0]) else 0
    for index in range(1, len(text)):
        previous, current = text[index - 1], text[index]
        refuses_boundary = (
            current == "\u200d" or previous == "\u200d" or _is_grapheme_extend(current)
        )
        if (
            not refuses_boundary
            and _is_regional_indicator(previous)
            and _is_regional_indicator(current)
            and regional_indicator_run % 2
        ):
            refuses_boundary = True
        if not refuses_boundary:
            boundaries.add(index)
        regional_indicator_run = (
            regional_indicator_run + 1
            if _is_regional_indicator(previous) and _is_regional_indicator(current)
            else int(_is_regional_indicator(current))
        )
    boundaries.add(len(text))
    return frozenset(boundaries)


def _validate_grapheme_span(text: str, start: int, end: int, description: str) -> None:
    """Refuse a range with either boundary inside an extended grapheme cluster."""
    boundaries = _grapheme_boundaries(text)
    if start not in boundaries:
        raise LocatorSplitsGrapheme(
            f"{description} begins part-way through an extended grapheme cluster"
        )
    if end not in boundaries:
        raise LocatorSplitsGrapheme(
            f"{description} ends part-way through an extended grapheme cluster"
        )


def _derived_span(text: str, locator: CharLocator) -> str:
    """Read a character range while applying ``read_span``'s grapheme rule."""
    if locator.end_char > len(text):
        raise LocatorOutOfRange(
            f"range [{locator.start_char}, {locator.end_char}) exceeds the {len(text)}-character extraction"
        )
    _validate_grapheme_span(
        text,
        locator.start_char,
        locator.end_char,
        f"range [{locator.start_char}, {locator.end_char})",
    )
    return text[locator.start_char:locator.end_char]


def _latest_validated_ledger_snapshot(ledger: object, source_id: str) -> str | None:
    """Return a source's validated ledger tip without changing the ledger store."""
    from nous_os.ledger import Ledger, LedgerError

    # Ledger.chain takes the locking read path, which creates a ``.lock`` file.
    # Lint must leave every store byte-identical, so it instead uses Ledger's
    # own line-to-LedgerEntry parser and the same per-source link checks without
    # acquiring a lock or writing any file.
    try:
        ledger_path = getattr(ledger, "path")
        if not isinstance(ledger_path, Path):
            raise LedgerError("the asset ledger has no readable path")
        entries = tuple(
            Ledger._entry_from_line(line, number)
            for number, line in enumerate(
                ledger_path.read_text(encoding="utf-8").splitlines(), start=1
            )
            if line
        )
        chain = tuple(entry for entry in entries if entry.source_id == source_id)
        if chain and chain[0].previous_digest is not None:
            raise LedgerError(
                f"the first recorded entry for {source_id} claims a predecessor, so "
                "this ledger does not contain the start of its history"
            )
        for earlier, later in zip(chain, chain[1:]):
            if later.previous_digest != earlier.snapshot_digest:
                raise LedgerError(
                    f"the version chain for {source_id} is broken: an entry claims "
                    f"predecessor {later.previous_digest} where the preceding entry "
                    f"recorded {earlier.snapshot_digest}"
                )
    except Exception as error:
        raise DerivedLedgerUnreadable("the asset ledger cannot be read as a valid history") from error
    return None if not chain else chain[-1].snapshot_digest


def quote_lint_derived(extraction_store, snapshot_store: SnapshotStore, ledger, citation: DerivedCitation) -> None:
    """Verify a quote against preserved extraction evidence and current asset metadata."""
    from nous_os.extraction import extraction_record_digest

    stored = extraction_store.get(citation.extractor, citation.asset_digest)
    calculated = extraction_record_digest(stored.payload)
    if calculated != stored.record_digest or calculated != citation.record_digest:
        raise DerivedRecordCorrupt("derived citation record digest does not match the stored payload")
    if citation.extractor_version != stored.extractor_version:
        raise DerivedVersionMismatch(
            f"citation names extractor version {citation.extractor_version!r}, "
            f"stored record has {stored.extractor_version!r}"
        )
    if citation.asset_source_id not in {source_id for source_id, _name in stored.owners}:
        raise DerivedOwnerMismatch("citation asset source is not an owner of the extraction record")
    latest_snapshot_digest = _latest_validated_ledger_snapshot(
        ledger, citation.asset_source_id
    )
    if latest_snapshot_digest is None:
        raise DerivedAssetMismatch("the asset source has no latest ledger snapshot")
    try:
        metadata = json.loads(
            snapshot_store.get(citation.asset_source_id, latest_snapshot_digest).data.decode("utf-8")
        )
        payload = metadata["payload"]
        if type(payload) is not dict or payload.get("digest") != citation.asset_digest:
            raise DerivedAssetMismatch("latest asset metadata does not name the cited digest")
    except DerivedAssetMismatch:
        raise
    except Exception as error:
        raise DerivedAssetMismatch("latest asset metadata cannot establish the cited digest") from error
    found = _derived_span(stored.text, citation.locator)
    if found != citation.span:
        raise SpanMismatch(
            "the extracted text does not say this at the cited offsets: "
            f"cited {citation.span!r}, found {found!r}"
        )


class DerivationState(Enum):
    """The reproducibility state of a derived citation."""

    REPRODUCED = "reproduced"
    DIVERGED = "diverged"
    NOT_EXECUTABLE = "not_executable"


@dataclass(frozen=True, slots=True)
class DerivationVerdict:
    """What a fresh extraction observed, without rewriting stored evidence."""

    state: DerivationState
    reason: str
    observed_asset_digest: str | None
    observed_text_digest: str | None

    def __post_init__(self) -> None:
        if type(self.state) is not DerivationState:
            raise ProvenanceError("derivation state must be a DerivationState")
        if type(self.reason) is not str:
            raise ProvenanceError("derivation reason must be a str")
        for name, value in (
            ("observed_asset_digest", self.observed_asset_digest),
            ("observed_text_digest", self.observed_text_digest),
        ):
            if value is not None and (type(value) is not str or _HEX64.fullmatch(value) is None):
                raise ProvenanceError(f"{name} must be a lowercase sha256 digest or None")

    def as_payload(self) -> dict[str, str | None]:
        return {
            "state": self.state.value,
            "reason": self.reason,
            "observed_asset_digest": self.observed_asset_digest,
            "observed_text_digest": self.observed_text_digest,
        }


def verify_derivation(
    read_asset_bytes: Callable[[str], bytes | None], extraction_store, citation: DerivedCitation
) -> DerivationVerdict:
    """Re-extract one attachment when bytes are available; never raise to a caller."""
    try:
        data = read_asset_bytes(citation.asset_source_id)
    except Exception as error:
        return DerivationVerdict(DerivationState.NOT_EXECUTABLE, f"bytes unavailable: {type(error).__name__}", None, None)
    if data is None:
        return DerivationVerdict(DerivationState.NOT_EXECUTABLE, "bytes unavailable", None, None)
    if type(data) is not bytes:
        return DerivationVerdict(DerivationState.NOT_EXECUTABLE, "bytes unavailable", None, None)
    observed_asset_digest = digest_bytes(data)
    if observed_asset_digest != citation.asset_digest:
        return DerivationVerdict(
            DerivationState.DIVERGED,
            f"asset digest differs: expected {citation.asset_digest}, observed {observed_asset_digest}",
            observed_asset_digest,
            None,
        )
    try:
        from nous_os.extraction import extract_bytes

        stored = extraction_store.get(citation.extractor, citation.asset_digest)
        if citation.record_digest != stored.record_digest:
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                f"citation names record digest {citation.record_digest}, store holds {stored.record_digest}",
                observed_asset_digest,
                None,
            )
        if citation.extractor_version != stored.extractor_version:
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                "citation names extractor version "
                f"{citation.extractor_version}, store holds {stored.extractor_version}",
                observed_asset_digest,
                None,
            )
        stored_outcome_value = stored.payload.get("outcome")
        try:
            stored_outcome = ExtractionOutcome(stored_outcome_value)
        except (TypeError, ValueError):
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                "stored extraction outcome is unavailable",
                observed_asset_digest,
                None,
            )
        extracted = extract_bytes(
            data,
            pdf_backend=Extractor.PDF_TEXT_TOOL
            if citation.extractor is Extractor.PDF_TEXT_TOOL
            else None,
        )
        if (
            stored_outcome is ExtractionOutcome.TOOL_UNAVAILABLE
            or extracted.outcome is ExtractionOutcome.TOOL_UNAVAILABLE
        ):
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                f"tool unavailable: {citation.extractor.value}",
                observed_asset_digest,
                extracted.text_digest,
            )
        if extracted.outcome is not stored_outcome:
            return DerivationVerdict(
                DerivationState.DIVERGED,
                "extraction outcome differs: "
                f"recorded {stored_outcome.value}, observed {extracted.outcome.value}",
                observed_asset_digest,
                extracted.text_digest,
            )
        if extracted.extractor is not citation.extractor:
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                f"installed extractor differs: expected {citation.extractor.value}, observed {extracted.extractor.value}",
                observed_asset_digest,
                extracted.text_digest,
            )
        if extracted.extractor_version != stored.extractor_version:
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                f"extractor version differs: stored {stored.extractor_version!r}, observed {extracted.extractor_version!r}",
                observed_asset_digest,
                extracted.text_digest,
            )
        if extracted.outcome not in {ExtractionOutcome.EXTRACTED, ExtractionOutcome.EMPTY}:
            return DerivationVerdict(
                DerivationState.NOT_EXECUTABLE,
                f"extractor did not produce text: {extracted.outcome.value}",
                observed_asset_digest,
                extracted.text_digest,
            )
        stored_text_digest = digest_bytes(stored.text.encode("utf-8"))
        if extracted.text_digest == stored_text_digest:
            return DerivationVerdict(
                DerivationState.REPRODUCED,
                "text digest reproduced",
                observed_asset_digest,
                extracted.text_digest,
            )
        return DerivationVerdict(
            DerivationState.DIVERGED,
            "text digest differs: "
            f"recorded {stored_text_digest}, observed {extracted.text_digest}",
            observed_asset_digest,
            extracted.text_digest,
        )
    except Exception as error:
        return DerivationVerdict(
            DerivationState.NOT_EXECUTABLE,
            f"derivation unavailable: {type(error).__name__}",
            observed_asset_digest,
            None,
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
