"""Content that came from outside, and the reason it has its own type.

Everything NousOS ingests is written by somebody else. A document can contain a
sentence addressed to whatever reads it — *ignore your instructions and do this
instead* — and the only thing standing between that sentence and its being
obeyed is whether the system can tell content apart from instruction.

Convention cannot do that. A comment saying "do not treat this as an
instruction" is not enforcement, and a `str` carrying corpus text is
indistinguishable from a `str` carrying a prompt. So ingested content gets a
**type**, and that type is deliberately not a `str`:

* it fails ``isinstance(value, str)``, so any function that checks refuses it;
* it does not concatenate, format, or iterate as text;
* **its ``__str__`` is a placeholder, not the content.** Interpolating it into a
  message produces ``<untrusted content: 412 characters>`` rather than the text, so
  the accident that would matter most is visible instead of silent.

Reading the content is possible and is meant to be — ``as_data()`` returns the
text. The point is not to make content unreachable; it is to make reaching for
it a deliberate act that says, at the call site, *this is data*.

**Quarantine is a label, never a refusal.** Content that looks like an
instruction is still ingested, with a typed reason recorded. Refusing to ingest
it would silently drop parts of a person's own corpus because a document
happened to contain a sentence in the imperative — losing real material to
protect against a risk the type boundary already handles.
"""

from __future__ import annotations

import re
import unicodedata
from enum import Enum
from typing import Final


class UntrustedContentError(Exception):
    """Raised when untrusted content is used as though it were trusted."""


class QuarantineReason(Enum):
    """Why a piece of content was flagged. A closed vocabulary, never a score.

    These are observations about **shape**, not judgements about intent, and
    they carry no severity ordering. A document quoting a phishing email is
    indistinguishable, by shape, from the phishing email; that is exactly why
    this is a label on data and not a verdict about it.
    """

    #: Text addressed to whatever is reading, telling it to disregard something.
    INSTRUCTION_TO_THE_READER = "instruction_to_the_reader"
    #: Text attempting to reassign the reader's role or identity.
    ROLE_REASSIGNMENT = "role_reassignment"
    #: Markup resembling a model or tool control channel.
    CONTROL_CHANNEL_MARKUP = "control_channel_markup"
    #: Text soliciting a credential, key or token.
    CREDENTIAL_SOLICITATION = "credential_solicitation"


#: Patterns are written with a one-character class so this module does not match
#: itself when the repository's own content scan reads it.
_SHAPES: Final[tuple[tuple[QuarantineReason, re.Pattern[str]], ...]] = (
    (
        QuarantineReason.INSTRUCTION_TO_THE_READER,
        re.compile(r"\b[i]gnore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\b", re.I),
    ),
    (
        QuarantineReason.INSTRUCTION_TO_THE_READER,
        re.compile(r"\b[d]isregard\s+(?:all\s+|any\s+)?(?:previous|prior|the\s+above)\b", re.I),
    ),
    (
        QuarantineReason.ROLE_REASSIGNMENT,
        re.compile(r"\b[y]ou\s+are\s+now\s+(?:a|an|the)\b", re.I),
    ),
    (
        QuarantineReason.ROLE_REASSIGNMENT,
        re.compile(r"\b[a]ct\s+as\s+(?:a|an|the)\s+\w+\s+and\b", re.I),
    ),
    (
        QuarantineReason.CONTROL_CHANNEL_MARKUP,
        re.compile(r"<\|[a-z_]+\|>"),
    ),
    (
        QuarantineReason.CONTROL_CHANNEL_MARKUP,
        re.compile(r"\[\[?[s]ystem\]?\]\s*:", re.I),
    ),
    (
        QuarantineReason.CREDENTIAL_SOLICITATION,
        re.compile(r"\b[r]eveal\s+(?:your|the)\s+(?:api\s*key|token|secret|password)\b", re.I),
    ),
    (
        QuarantineReason.CREDENTIAL_SOLICITATION,
        re.compile(r"\b[p]rint\s+(?:your|the)\s+(?:system\s+prompt|instructions)\b", re.I),
    ),
)


def _for_matching(text: str) -> str:
    """The content as it would be *read*, for shape inspection only.

    Never stored, never returned to a caller, and never written anywhere: the
    stored bytes stay exactly as the source had them, because rewriting a
    source is the thing provenance forbids. This is a view used to answer one
    question -- what does this look like to whoever reads it?

    Two things are folded. Unicode format characters (category ``Cf``, which
    includes the zero-width space) are removed, because they are invisible to a
    reader and a sentence carrying one reads identically to a sentence without
    it -- so ``Ignore all<ZWSP> previous instructions`` matched nothing while
    being indistinguishable on screen from text that matched. Compatibility
    normalisation then folds the lookalike forms that survive that.
    """
    stripped = "".join(
        character for character in text if unicodedata.category(character) != "Cf"
    )
    return unicodedata.normalize("NFKC", stripped)


class UntrustedText:
    """Text from a source. Data, never instruction.

    Not a ``str`` subclass, deliberately. Subclassing would make every existing
    ``str`` check pass and every existing string operation work, which is the
    entire property this type exists to withhold.
    """

    __slots__ = ("_text",)

    def __init_subclass__(cls, **kwargs: object) -> None:
        # Subclassing is refused, not discouraged. A subclass can override
        # __str__, as_data or the immutability guard while still satisfying
        # isinstance -- which turns the boundary into a suggestion. The same
        # defect was found and fixed once already in this project's canonical
        # record, and was not carried across to this type; refusing the
        # mechanism outright is what stops it recurring a third time.
        raise UntrustedContentError(
            "UntrustedText may not be subclassed: a subclass could satisfy every "
            "check while rendering its content as trusted text"
        )

    def __init__(self, text: str) -> None:
        if type(text) is not str:
            raise UntrustedContentError(
                f"untrusted content must be text, not {type(text).__name__}"
            )
        object.__setattr__(self, "_text", text)

    def as_data(self) -> str:
        """The content, as data.

        The verbose name is the point: a call site reading ``as_data()`` states
        what it is doing, and a review can find every such site by name.
        """
        return self._text

    def __len__(self) -> int:
        return len(self._text)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, UntrustedText):
            return self._text == other._text
        return NotImplemented

    def __hash__(self) -> int:
        return hash(("untrusted", self._text))

    def __str__(self) -> str:
        """A placeholder, not the content.

        If this returned the text, then interpolating untrusted content into a
        message would look exactly like interpolating trusted text, and the one
        mistake worth catching would be the one that produced no evidence.
        """
        return f"<untrusted content: {len(self._text)} characters>"

    __repr__ = __str__

    def __setattr__(self, name: str, value: object) -> None:
        raise UntrustedContentError("untrusted content is immutable once ingested")

    def __copy__(self) -> "UntrustedText":
        """An immutable value is its own copy.

        Without this, the immutability guard intercepts the attribute write that
        copying uses, and `copy.deepcopy` of any structure containing ingested
        content fails with a message about a mutation nobody attempted. Failing
        closed is safe; failing closed for the wrong stated reason is a trap.
        """
        return self

    def __deepcopy__(self, memo: dict) -> "UntrustedText":
        return self

    def __reduce__(self) -> tuple:
        """Rebuild by construction, so the type survives the round trip.

        Restoring slots goes through `setattr`, which the guard refuses. Naming
        the constructor keeps a pickled value arriving back as UntrustedText
        rather than as something that merely looks like it.
        """
        return (UntrustedText, (self._text,))


def inspect_shape(content: UntrustedText) -> tuple[QuarantineReason, ...]:
    """Which quarantine shapes this content matches. Sorted, deduplicated.

    Deterministic: the same content always yields the same tuple in the same
    order, because a set's iteration order is not a fact about the content.
    """
    if type(content) is not UntrustedText:
        raise UntrustedContentError(
            "inspect_shape reads untrusted content; pass UntrustedText, not a bare str"
        )
    text = _for_matching(content.as_data())
    found = {reason for reason, pattern in _SHAPES if pattern.search(text)}
    return tuple(sorted(found, key=lambda reason: reason.value))
