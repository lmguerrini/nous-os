"""Carry a claim key's origin because a string cannot carry its own history.

``ClaimKey`` correctly refuses an ``UntrustedText`` object, but text extracted
from that object is an ordinary ``str`` by the time a key is formed.  No check
at the key boundary can recover whether those bytes came from a person, a
canonical derivation, or a document.  This module therefore records that fact
at the point it is known, rather than pretending that origin can be inferred
later from an identical-looking string.

The vocabulary is deliberately closed and promotion is an allowlist.  Unknown
does not mean harmless, and content-derived keys remain useful to describe a
proposal while being unsuitable for promotion.  A citation is required only
for content origin: attaching one to any other origin would turn evidence of
source origin into decorative, contradictory metadata.  This type cannot
prove that a caller described the origin truthfully; it closes the narrower,
mechanical gap of losing an origin that was already established.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Final

from nous_os.provenance import Citation
from nous_os.temporal import ClaimKey


class AttributionError(Exception):
    """Raised when a key's stated origin is internally contradictory."""


class KeyOrigin(Enum):
    """The closed ways an explicit key may have entered this boundary."""

    OPERATOR = "operator"
    DERIVED = "derived"
    CONTENT = "content"
    UNKNOWN = "unknown"


_KEY_ORIGIN_MEMBERS: Final[tuple[KeyOrigin, ...]] = tuple(KeyOrigin)

#: The only origins permitted to approach the promotion boundary.
PROMOTABLE_ORIGINS: Final[frozenset[KeyOrigin]] = frozenset(
    {KeyOrigin.OPERATOR, KeyOrigin.DERIVED}
)


def _is_canonical_origin(value: object) -> bool:
    """Recognize declared members, excluding uninitialized enum instances."""
    return any(value is member for member in _KEY_ORIGIN_MEMBERS)


@dataclass(frozen=True, slots=True)
class AttributedKey:
    """A closed-form claim key paired with the origin known at creation."""

    key: ClaimKey
    origin: KeyOrigin
    citation: Citation | None = None

    def __post_init__(self) -> None:
        if type(self.key) is not ClaimKey:
            raise AttributionError(
                f"key must be a ClaimKey, not {type(self.key).__name__}"
            )
        if not _is_canonical_origin(self.origin):
            raise AttributionError("origin must be a declared KeyOrigin member")
        if self.origin is KeyOrigin.CONTENT:
            if type(self.citation) is not Citation:
                raise AttributionError("content origin requires an exact Citation")
        elif self.citation is not None:
            raise AttributionError("only content origin may carry a citation")


def is_promotable(attributed: AttributedKey) -> bool:
    """Whether a key's recorded origin is explicitly eligible for promotion."""
    if type(attributed) is not AttributedKey:
        raise AttributionError(
            "promotion eligibility requires an exact AttributedKey, not "
            f"{type(attributed).__name__}"
        )
    # This is an allowlist: an origin not named here is never permission.
    return any(attributed.origin is origin for origin in PROMOTABLE_ORIGINS)
