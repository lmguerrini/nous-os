"""Authority is granted explicitly and never inferred from caller-supplied data.

Ingested documents may contain text that asks a reader to promote material or
perform an outside action. Recognising suspicious wording cannot secure that
boundary: unfamiliar wording would eventually evade the recogniser. Instead,
this module gives content no route into the authorization decision. An
operation's required tier lives in a private registry, a grant holds an exact
set of tiers, and every governed invocation passes through :func:`execute`.

The tiers deliberately have no ordering. Treating them as a ladder would let a
single broad comparison turn distinct permissions into implied permissions;
set membership requires every permission to be granted on its own. The
registry is permanent within a loaded module instance so a later registration
cannot quietly redefine either an operation's authority or its implementation.
Reloading the module produces a new, empty registry.

A grant is a declaration of authority by the code that constructs it, not an
unforgeable token: code able to construct one can declare any tier. Who may
issue grants is a question this module does not answer.

This boundary does not decide which application operations should exist, who
should receive grants, or how grants should persist. Those policy and lifecycle
questions belong elsewhere. Its narrower promise is that registered code is
unreachable through this interface unless the supplied grant holds the one
tier recorded for that operation.
"""

from __future__ import annotations

import threading as _threading
import unicodedata as _unicodedata
from collections.abc import Callable as _Callable
from dataclasses import dataclass as _dataclass
from enum import Enum as _Enum
from typing import Final as _Final

# The future import binds ``annotations`` as a module-level compiler setting,
# not as part of this module's public surface. Remove it so the visible surface
# remains exactly the names declared in ``__all__``.
try:
    del annotations
except NameError:
    pass

__all__ = (
    "CapabilityError",
    "NotAuthorized",
    "UnknownOperation",
    "RegistrationError",
    "Tier",
    "Grant",
    "register",
    "execute",
    "required_tier",
    "registered_names",
)


class CapabilityError(Exception):
    """Base error for invalid grants and refused governed operations."""


class NotAuthorized(CapabilityError):
    """Raised when a grant lacks the exact tier an operation requires."""


class UnknownOperation(CapabilityError):
    """Raised when no governed operation has been registered under a name."""


class RegistrationError(CapabilityError):
    """Raised when a registration is invalid or would replace an existing one."""


class Tier(_Enum):
    """Distinct kinds of authority, intentionally without rank or implication."""

    READ = "read"
    PROPOSE = "propose"
    PROMOTE = "promote"
    EXTERNAL_CONSEQUENTIAL_ACTION = "external_consequential_action"


_TIER_MEMBERS: _Final = tuple(Tier)

# The operation-name rule refuses strings outside NFC, strings with leading or
# trailing whitespace, and strings containing a Default_Ignorable_Code_Point,
# a control, format, surrogate, unassigned, private-use, or separator
# character, a non-ASCII space, or a listed blank-rendering character. Two
# operation names that a reviewer cannot tell apart must not be able to carry
# different authority. This guard reduces that hazard but does not eliminate
# it. Homoglyphs and confusable scripts are not covered because they require
# UTS #39 data that the standard library does not ship. A blank-rendering
# character outside the listed set is also not covered because rendering as
# nothing is not a property the standard library can decide in general.
# Operation names are chosen by the code that registers them, rather than
# supplied by content, so this is a review-integrity measure and not part of
# the content-injection defence.
_REFUSED_OPERATION_NAME_CATEGORIES: _Final = frozenset(
    {"Cc", "Cf", "Cs", "Cn", "Co", "Zl", "Zp"}
)
_REFUSED_OPERATION_NAME_CODE_POINTS: _Final = frozenset(
    (
        # Unicode 16 Default_Ignorable_Code_Point.
        *range(0x00AD, 0x00AE),
        *range(0x034F, 0x0350),
        *range(0x061C, 0x061D),
        *range(0x115F, 0x1161),
        *range(0x17B4, 0x17B6),
        *range(0x180B, 0x1810),
        *range(0x200B, 0x2010),
        *range(0x202A, 0x202F),
        *range(0x2060, 0x2070),
        *range(0x3164, 0x3165),
        *range(0xFE00, 0xFE10),
        *range(0xFEFF, 0xFF00),
        *range(0xFFA0, 0xFFA1),
        *range(0xFFF0, 0xFFF9),
        *range(0x1BCA0, 0x1BCA4),
        *range(0x1D173, 0x1D17B),
        *range(0xE0000, 0xE1000),
        # Blank-rendering characters outside Default_Ignorable_Code_Point.
        0x2800,
        0x2D7F,
        0x1107F,
        0x113D0,
        0x11A47,
        0x11A99,
        0x11F42,
        0x13441,
        0x13442,
        0x16FE4,
    )
)


def _is_refused_operation_name_character(character: str) -> bool:
    """Decide whether one operation-name character is unsafe to register."""
    category = _unicodedata.category(character)
    return (
        ord(character) in _REFUSED_OPERATION_NAME_CODE_POINTS
        or category in _REFUSED_OPERATION_NAME_CATEGORIES
        or (category == "Zs" and character != " ")
    )

#: Marks an instance before normalizing caller-owned tier input. Normalization
#: can invoke supplied iteration or hashing code; occupying the slot first
#: makes same-instance initializer re-entry hit the existing refusal guard.
_UNDER_CONSTRUCTION: _Final = object()


def _is_canonical_tier(value: object) -> bool:
    """Recognize only declared members, not uninitialized enum instances.

    Exact type alone admits instances made without enum construction. Identity
    against the closed vocabulary prevents those objects from entering grants
    or the registry and later failing when member metadata is read.
    """
    return any(value is member for member in _TIER_MEMBERS)


@_dataclass(frozen=True, slots=True, init=False)
class Grant:
    """A holder and exact tier set, frozen against ordinary field assignment.

    A caller able to bypass the frozen assignment guard could equally construct
    a grant for any tier directly; this module deliberately leaves issuance
    unrestricted.
    """

    holder: str
    tiers: frozenset[Tier]

    def __init__(self, holder: str, tiers: frozenset[Tier]) -> None:
        """Claim the instance before validating caller-controlled tier input.

        Normalizing tiers can invoke supplied iteration or hashing methods.
        Placing a non-authorizing marker in the slot first makes same-instance
        re-entry hit the guard, while real field values are delayed until every
        check passes. A failed construction keeps the marker and is refused by
        both ``holds`` and ``execute``.
        """
        if hasattr(self, "tiers"):
            raise CapabilityError("an initialized grant cannot be initialized again")
        object.__setattr__(self, "tiers", _UNDER_CONSTRUCTION)

        if type(holder) is not str:
            raise CapabilityError("grant holder must be a string")

        try:
            normalized = frozenset(tiers)
        except Exception as error:
            raise CapabilityError(
                "grant tiers must be an iterable of Tier members"
            ) from error

        if any(not _is_canonical_tier(tier) for tier in normalized):
            raise CapabilityError("every grant tier must be a Tier member")

        object.__setattr__(self, "holder", holder)
        object.__setattr__(self, "tiers", normalized)

    def __init_subclass__(cls, **kwargs: object) -> None:
        # Subclassing is refused, not discouraged. A subclass can override
        # holds while still satisfying isinstance, turning a type check into a
        # route around the recorded tiers. Refusing the mechanism keeps that
        # failure independent of the exact-type defence in execute.
        raise CapabilityError(
            "Grant may not be subclassed: a subclass could report authority "
            "that the grant does not hold"
        )

    def holds(self, tier: Tier) -> bool:
        """Check a canonical tier without delegating to caller-owned behavior."""
        if not _is_canonical_tier(tier):
            raise CapabilityError("a queried grant tier must be a Tier member")
        if type(self.tiers) is not frozenset:
            raise CapabilityError("grant tiers must be an exact frozenset")
        return frozenset.__contains__(self.tiers, tier)

    def __setstate__(self, state: object) -> None:
        """Refuse restoration that could bypass construction-time validation.

        Frozen slotted dataclasses otherwise restore their slots directly,
        bypassing the validating ``__init__`` and allowing an issued grant to
        be widened in place.
        """
        raise CapabilityError(
            "grant state cannot be restored in place; construct a new Grant"
        )

    def __reduce__(self) -> tuple:
        """Rebuild through the validating constructor, never by restoring slots.

        Direct slot restoration would bypass the validating ``__init__``,
        preserving invalid tiers or widening authority during a round trip.
        """
        return (Grant, (self.holder, self.tiers))


_REGISTRY: _Final[dict[str, tuple[Tier, _Callable[..., object]]]] = {}
_REGISTRY_LOCK: _Final = _threading.RLock()


def register(name: str, tier: Tier, implementation: _Callable[..., object]) -> None:
    """Permanently bind an operation through one atomic registry operation.

    Exact strings give lookup and storage ordinary string identity, and
    ``setdefault`` makes them one operation so callbacks cannot run between.
    Names outside NFC, names with leading or trailing whitespace, and names
    containing a Default_Ignorable_Code_Point, a control, format, surrogate,
    unassigned, private-use, or separator character, a non-ASCII space, or a
    listed blank-rendering character are refused. Two operation names that a
    reviewer cannot tell apart must not be able to carry different authority.
    This guard reduces that hazard but does not eliminate it. Homoglyphs and
    confusable scripts are not covered because they require UTS #39 data that
    the standard library does not ship. A blank-rendering character outside
    the listed set is also not covered because rendering as nothing is not a
    property the standard library can decide in general. Operation names are
    chosen by the code that registers them, rather than supplied by content,
    so this is a review-integrity measure and not part of the content-injection
    defence.
    """
    if type(name) is not str:
        raise RegistrationError("an operation name must be a non-blank string")
    if name != name.strip():
        raise RegistrationError(
            "an operation name cannot have leading or trailing whitespace"
        )
    if not name.strip():
        raise RegistrationError("an operation name must be a non-blank string")
    if name != _unicodedata.normalize("NFC", name):
        raise RegistrationError(
            "an operation name must be in Unicode Normalization Form C"
        )
    if any(_is_refused_operation_name_character(character) for character in name):
        raise RegistrationError(
            "an operation name cannot contain a Default_Ignorable, control, "
            "format, surrogate, unassigned, private-use, separator, non-ASCII "
            "space, or listed blank-rendering character"
        )
    if not _is_canonical_tier(tier):
        raise RegistrationError("an operation tier must be a Tier member")
    if not callable(implementation):
        raise RegistrationError("an operation implementation must be callable")

    entry = (tier, implementation)
    with _REGISTRY_LOCK:
        if _REGISTRY.setdefault(name, entry) is not entry:
            raise RegistrationError("an operation name may be registered only once")


def _registered_operation(name: str) -> tuple[Tier, _Callable[..., object]]:
    if type(name) is not str:
        raise UnknownOperation("the operation is not registered")

    with _REGISTRY_LOCK:
        try:
            return _REGISTRY[name]
        except KeyError:
            raise UnknownOperation("the operation is not registered") from None


def execute(grant: Grant, name: str, /, **kwargs: object) -> object:
    """Invoke a governed operation only after looking up and checking authority.

    Keyword arguments remain untouched until the authorization decision has
    succeeded. They can therefore carry arbitrary application data, including
    hostile document text, without gaining a path to the registry lookup or
    the membership check. The stored-set check is deliberate belt-and-braces,
    duplicating the refusal ``holds`` would produce so this security boundary
    has no single point of failure.
    """
    tier, implementation = _registered_operation(name)
    refusal = "the grant does not hold the operation's required tier"
    if type(grant) is not Grant:
        raise NotAuthorized(refusal)
    if type(getattr(grant, "tiers", None)) is not frozenset:
        raise NotAuthorized(refusal)
    try:
        authorized = grant.holds(tier)
    except Exception:
        authorized = False
    if not authorized:
        raise NotAuthorized(refusal)
    return implementation(**kwargs)


def required_tier(name: str) -> Tier:
    """Return the tier fixed by registration for a governed operation."""
    tier, _ = _registered_operation(name)
    return tier


def registered_names() -> tuple[str, ...]:
    """Return registered operation names in a deterministic order."""
    with _REGISTRY_LOCK:
        return tuple(sorted(_REGISTRY))
