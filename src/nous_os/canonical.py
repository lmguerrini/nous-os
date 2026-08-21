"""The canonical record: an assertion, what supports it, and when it held.

This module defines the **fields and their invariants**. It defines no
workflow. There is deliberately no function here that moves an assertion from
one lifecycle state to another, and no function that answers a question about
time. Both belong to later capabilities, and providing them early would mean
this one's acceptance certifies behaviour nobody tested.

Three shapes carry most of the meaning:

**Support is a typed class, never a number.** There is no confidence score, no
probability and no weight anywhere in this module, and a test enforces that.
A scalar invites arithmetic — averaging two claims' confidence, thresholding at
0.7 — and every such operation is meaningless over evidence. A closed
vocabulary can only be read, compared for equality, and reasoned about.

**Two time axes, and no third.** ``valid_from``/``valid_to`` say when the claim
was true of the world; ``recorded_at`` says when this system learned it. They
answer different questions and are routinely conflated, which is why they are
separate fields here rather than one "date".

**Unknown is representable.** ``SupportClass.UNKNOWN`` and an absent
``valid_from`` are real answers meaning "not established", distinct from any
substantive value. Nothing here silently supplies a default that would turn a
gap into a fact.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from nous_os.identity import ASSERTION_PREFIX, digest_payload, require_id
from nous_os.provenance import Citation


class CanonicalError(Exception):
    """Raised when a record cannot be formed as specified."""


class LifecycleState(Enum):
    """Where a record sits relative to canon.

    A **state**, not a transition. Nothing in this capability moves a record
    between these; that path is human-gated and is defined elsewhere. The
    absence of a transition function here is deliberate and is asserted by a
    test, so it cannot be added inadvertently.
    """

    CANONICAL = "canonical"
    CANDIDATE = "candidate"
    REJECTED = "rejected"


class SupportClass(Enum):
    """How the cited span supports the claim. A closed vocabulary.

    Ordered from most to least direct for readability only. The order carries
    **no arithmetic meaning**: these are not ranks, they do not average, and
    nothing may compare them with ``<``.
    """

    #: The span states the claim in its own words, verbatim.
    DIRECT_QUOTE = "direct_quote"
    #: The span states the claim, in different words.
    PARAPHRASE = "paraphrase"
    #: The claim condenses a longer span that states it across several parts.
    SUMMARY = "summary"
    #: The claim follows from the span but the span does not state it.
    INFERRED = "inferred"
    #: Support has not been established. Not "weak support" — no answer yet.
    UNKNOWN = "unknown"


def _as_utc(value: datetime) -> str:
    """One instant, one representation.

    ``datetime.isoformat`` serialises how an instant was *written*, not which
    instant it is: ``12:00+00:00`` and ``13:00+01:00`` are equal datetimes that
    format differently. Hashing that directly would make the content digest
    move when nothing about the content moved, which breaks the only property
    that makes digests useful -- that they change exactly when the content
    does. Normalising to UTC first means the digest is a function of the
    instant rather than of the offset whoever recorded it happened to use.
    """
    return value.astimezone(timezone.utc).isoformat()


def _require_instant(value: datetime, field: str) -> datetime:
    if not isinstance(value, datetime):
        raise CanonicalError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise CanonicalError(
            f"{field} must carry a timezone; a naive timestamp means different "
            "instants on different machines"
        )
    return value


@dataclass(frozen=True)
class Assertion:
    """One claim, its provenance, its validity, and its lifecycle state."""

    id: str
    text: str
    citation: Citation
    support: SupportClass
    recorded_at: datetime
    state: LifecycleState
    valid_from: datetime | None = None
    valid_to: datetime | None = None

    def __post_init__(self) -> None:
        require_id(self.id, ASSERTION_PREFIX)
        if not self.text or not self.text.strip():
            raise CanonicalError("an assertion must carry a claim")
        if not isinstance(self.support, SupportClass):
            raise CanonicalError("support must be a SupportClass, never a scalar")
        if not isinstance(self.state, LifecycleState):
            raise CanonicalError("state must be a LifecycleState")
        _require_instant(self.recorded_at, "recorded_at")
        if self.valid_from is not None:
            _require_instant(self.valid_from, "valid_from")
        if self.valid_to is not None:
            _require_instant(self.valid_to, "valid_to")
        if (
            self.valid_from is not None
            and self.valid_to is not None
            and self.valid_to <= self.valid_from
        ):
            raise CanonicalError(
                f"valid_to {self.valid_to.isoformat()} does not follow "
                f"valid_from {self.valid_from.isoformat()}"
            )

    def content_payload(self) -> dict[str, object]:
        """The content of this assertion, in canonical form.

        **Excludes ``id`` and ``state``, deliberately.** An identity is not
        content — minting a new id for the same claim must not read as an edit.
        A lifecycle state is not content either: moving a record between
        candidate and canon changes its standing, not what it says, and if a
        state change altered the content digest then "has this claim been
        edited?" could no longer be answered by comparing digests.

        This is therefore a **content digest, not a tamper seal** over the whole
        record. It detects edits to what is claimed and where it came from. It
        does not, and is not meant to, detect an altered id or state.

        Instants are normalised to UTC before hashing, so the digest is a
        function of *which instant* rather than of the offset it was written
        in. Text is **not** normalised: NFC and NFD forms of the same word are
        different strings and different bytes, and quietly folding them would
        be the system rewriting what a source actually said.
        """
        return {
            "text": self.text,
            "citation": self.citation.as_payload(),
            "support": self.support.value,
            "recorded_at": _as_utc(self.recorded_at),
            "valid_from": None if self.valid_from is None else _as_utc(self.valid_from),
            "valid_to": None if self.valid_to is None else _as_utc(self.valid_to),
        }

    @property
    def content_digest(self) -> str:
        """sha256 over this assertion's canonical content form."""
        return digest_payload(self.content_payload())
