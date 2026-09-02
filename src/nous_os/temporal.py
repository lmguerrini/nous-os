"""Temporal questions and disagreements over canonical assertions.

Validity and recording are separate axes because a claim can have held in the
world before this system learned it, or be recorded promptly while its period
of validity remains unknown. This module preserves that distinction instead of
letting one timestamp answer both questions. It also reports disagreement
without selecting a side: conflict member order is deterministic **for
reproducibility only**, never precedence.

``ClaimKey`` is supplied by a caller; it is never inferred from assertion or
source content. A plain ``str`` obtained from ``UntrustedText.as_data()`` is
indistinguishable here from any other plain string, so this module cannot and
does not claim to detect that derivation. It does refuse an ``UntrustedText``
object itself through its exact-string type boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import re

from nous_os.canonical import Assertion, CanonicalError as _CanonicalError, LifecycleState


_CLAIM_KEY = re.compile(r"[a-z0-9]+(?:[.-][a-z0-9]+)*\Z")
_ABSENT: object = object()


class TemporalError(Exception):
    """Raised when a temporal query would claim more than canon establishes."""


class ClaimKeyError(TemporalError):
    """Raised when a supplied subject name cannot be a stable explicit key."""


class TemporalTypeError(TemporalError):
    """Raised when an exact trust-boundary type is not the required type."""


class AssertionIdentityConflict(TemporalError):
    """Raised when one assertion identifier is made to name different content."""


class NonCanonicalAssertion(TemporalError):
    """Raised when a temporal projection is given a non-canonical assertion."""


class RankingDivergence(TemporalError):
    """Raised when a caller's ranking names an assertion this index does not hold."""


class TemporalAssertionError(TemporalError):
    """Raised when one named assertion cannot support a temporal read."""


@dataclass(frozen=True, slots=True, order=True, init=False)
class ClaimKey:
    """An explicit subject name, never a conclusion drawn from source text."""

    value: str

    def __init__(self, value: str) -> None:
        # This must precede assignment. A str subclass can replace equality or
        # hashing, turning an explicit key into a caller-controlled dictionary
        # behaviour rather than a stable subject name.
        if type(value) is not str:
            raise ClaimKeyError(
                f"claim key must be a str, not {type(value).__name__}"
            )
        if not 1 <= len(value) <= 64 or _CLAIM_KEY.fullmatch(value) is None:
            raise ClaimKeyError(
                "claim key must be 1..64 lowercase ASCII letters, digits, '-' or '.' "
                "with separators only between name parts"
            )
        object.__setattr__(self, "value", value)


class Overlap(Enum):
    """What the available validity bounds establish about a pair of intervals."""

    OVERLAPS = "overlaps"
    DISJOINT = "disjoint"
    UNDETERMINED = "undetermined"


@dataclass(frozen=True, slots=True)
class AsOf:
    """The complete three-way answer at independently supplied temporal axes."""

    established: tuple[Assertion, ...]
    excluded: tuple[Assertion, ...]
    undetermined: tuple[Assertion, ...]


@dataclass(frozen=True, slots=True)
class AsOfRanking:
    """A caller-ranked three-way temporal answer, without a chosen assertion."""

    kept: tuple[str, ...]
    excluded: tuple[str, ...]
    undetermined: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Conflict:
    """A connected disagreement under one explicit key, without a selected side."""

    key: ClaimKey
    members: tuple[Assertion, ...]
    overlap: Overlap


def _utc(value: datetime, field: str) -> datetime:
    """Normalise a checked instant before deciding a temporal relation."""
    try:
        return value.astimezone(timezone.utc)
    except (OverflowError, OSError, ValueError) as error:
        raise TemporalError(f"{field} cannot be normalised to UTC") from error


def _query_instant(value: datetime | None, field: str) -> datetime | None:
    if value is None:
        return None
    if type(value) is not datetime:
        raise TemporalTypeError(f"{field} must be a datetime or None")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise TemporalError(f"{field} must carry a timezone")
    return _utc(value, field)


def _validity_at(assertion: Assertion, instant: datetime) -> Overlap:
    """Classify a point against known interval evidence, without inventing bounds."""
    lower = assertion.valid_from
    upper = assertion.valid_to
    if lower is not None and instant < _utc(lower, "valid_from"):
        return Overlap.DISJOINT
    if upper is not None and instant >= _utc(upper, "valid_to"):
        return Overlap.DISJOINT
    if lower is None or upper is None:
        return Overlap.UNDETERMINED
    return Overlap.OVERLAPS


def _interval_overlap(left: Assertion, right: Assertion) -> Overlap:
    """Decide overlap when evidence can decide it, retaining a genuine unknown."""
    left_start = None if left.valid_from is None else _utc(left.valid_from, "valid_from")
    left_end = None if left.valid_to is None else _utc(left.valid_to, "valid_to")
    right_start = None if right.valid_from is None else _utc(right.valid_from, "valid_from")
    right_end = None if right.valid_to is None else _utc(right.valid_to, "valid_to")

    first = _ABSENT if left_start is None or right_end is None else left_start < right_end
    second = _ABSENT if right_start is None or left_end is None else right_start < left_end
    if first is False or second is False:
        return Overlap.DISJOINT
    if first is True and second is True:
        return Overlap.OVERLAPS
    return Overlap.UNDETERMINED


def _content_digest(assertion: Assertion) -> str:
    try:
        return assertion.content_digest
    except _CanonicalError as error:
        raise TemporalAssertionError(
            f"assertion {assertion.id} cannot support a temporal read"
        ) from error


def _assertion_order(assertion: Assertion) -> tuple[datetime, str, str]:
    return (
        _utc(assertion.recorded_at, "recorded_at"),
        _content_digest(assertion),
        assertion.id,
    )


class TemporalIndex:
    """A temporal projection holding only canonical assertions.

    Callers that need a rebuilt projection re-add assertions from canon.
    """

    def __init__(self) -> None:
        self._by_key: dict[ClaimKey, dict[str, Assertion]] = {}

    def add(self, key: ClaimKey, assertion: Assertion) -> None:
        """Add one explicit association, refusing an identifier that changes meaning."""
        if type(key) is not ClaimKey:
            raise TemporalTypeError(
                f"key must be a ClaimKey, not {type(key).__name__}"
            )
        if type(assertion) is not Assertion:
            raise TemporalTypeError(
                f"assertion must be an Assertion, not {type(assertion).__name__}"
            )
        if assertion.state is not LifecycleState.CANONICAL:
            raise NonCanonicalAssertion(
                "assertion state must be CANONICAL, not "
                f"{assertion.state.name}"
            )
        for held_key, held in self._by_key.items():
            prior = held.get(assertion.id, _ABSENT)
            if prior is _ABSENT:
                continue
            if held_key != key:
                raise AssertionIdentityConflict(
                    f"{assertion.id} is already associated with {held_key.value}; "
                    "one assertion is about one subject here"
                )
            if prior.content_digest != assertion.content_digest:
                raise AssertionIdentityConflict(
                    f"{assertion.id} is already held with different content; "
                    "an identifier names one thing"
                )
            return
        self._by_key.setdefault(key, {})[assertion.id] = assertion

    def keys(self) -> tuple[ClaimKey, ...]:
        """Return subject keys in their explicit textual order."""
        return tuple(sorted(self._by_key))

    def assertions(self, key: ClaimKey) -> tuple[Assertion, ...]:
        """Return one key's assertions in recorded-time reproducible order."""
        if type(key) is not ClaimKey:
            raise TemporalTypeError(
                f"key must be a ClaimKey, not {type(key).__name__}"
            )
        return tuple(sorted(self._by_key.get(key, {}).values(), key=_assertion_order))

    def _all_assertions(self) -> tuple[Assertion, ...]:
        return tuple(
            assertion
            for key in self.keys()
            for assertion in self.assertions(key)
        )

    def as_of(
        self,
        *,
        valid_at: datetime | None = None,
        recorded_as_of: datetime | None = None,
    ) -> AsOf:
        """Partition every held assertion using only the requested time axes."""
        validity_instant = _query_instant(valid_at, "valid_at")
        recorded_instant = _query_instant(recorded_as_of, "recorded_as_of")
        established: list[Assertion] = []
        excluded: list[Assertion] = []
        undetermined: list[Assertion] = []
        for assertion in self._all_assertions():
            valid_state = (
                Overlap.OVERLAPS
                if validity_instant is None
                else _validity_at(assertion, validity_instant)
            )
            recorded_state = (
                Overlap.OVERLAPS
                if recorded_instant is None
                else (
                    Overlap.OVERLAPS
                    if _utc(assertion.recorded_at, "recorded_at") <= recorded_instant
                    else Overlap.DISJOINT
                )
            )
            if valid_state is Overlap.DISJOINT or recorded_state is Overlap.DISJOINT:
                excluded.append(assertion)
            elif (
                valid_state is Overlap.UNDETERMINED
                or recorded_state is Overlap.UNDETERMINED
            ):
                undetermined.append(assertion)
            else:
                established.append(assertion)
        return AsOf(tuple(established), tuple(excluded), tuple(undetermined))

    def supersession(self, key: ClaimKey) -> tuple[Assertion, ...]:
        """Return recorded history without deleting prior assertions."""
        return self.assertions(key)

    def conflicts(self, key: ClaimKey | None = None) -> tuple[Conflict, ...]:
        """Report connected disagreeing groups without making any one authoritative."""
        if key is not None and type(key) is not ClaimKey:
            raise TemporalTypeError(
                f"key must be a ClaimKey or None, not {type(key).__name__}"
            )
        keys = (key,) if key is not None else self.keys()
        found: list[Conflict] = []
        for subject in keys:
            if subject is None:
                raise TemporalError("conflict query selected an absent claim key")
            assertions = tuple(self._by_key.get(subject, {}).values())
            for assertion in assertions:
                _content_digest(assertion)
            edges: list[tuple[int, int, Overlap]] = []
            for left_index, left in enumerate(assertions):
                for right_index in range(left_index + 1, len(assertions)):
                    right = assertions[right_index]
                    if _content_digest(left) == _content_digest(right):
                        continue
                    relation = _interval_overlap(left, right)
                    if relation is not Overlap.DISJOINT:
                        edges.append((left_index, right_index, relation))
            connected = list(range(len(assertions)))

            def root(position: int) -> int:
                while connected[position] != position:
                    connected[position] = connected[connected[position]]
                    position = connected[position]
                return position

            for left_index, right_index, _ in edges:
                left_root, right_root = root(left_index), root(right_index)
                if left_root != right_root:
                    connected[right_root] = left_root
            groups: dict[int, list[int]] = {}
            for position in range(len(assertions)):
                groups.setdefault(root(position), []).append(position)
            for positions in groups.values():
                if len(positions) < 2:
                    continue
                members = tuple(
                    sorted(
                        (assertions[position] for position in positions),
                        key=lambda assertion: (_content_digest(assertion), assertion.id),
                    )
                )
                # `edges` answers "are these positions connected?" and, for that
                # question alone, correctly omits DISJOINT pairs -- a disjoint pair
                # cannot connect two positions. The group's reported overlap answers
                # a different question, "what do the bounds establish about every
                # pair in this group?", and that quantifier's domain must be every
                # member pair, DISJOINT ones included, or a disjoint counter-example
                # is deleted before `all(...)` ever sees it. So this is computed
                # fresh over `positions`, not filtered from `edges`.
                sorted_positions = sorted(positions)
                pair_relations = [
                    _interval_overlap(assertions[left_index], assertions[right_index])
                    for index, left_index in enumerate(sorted_positions)
                    for right_index in sorted_positions[index + 1 :]
                    if _content_digest(assertions[left_index])
                    != _content_digest(assertions[right_index])
                ]
                # An empty domain here means every pair in the group shared a
                # content digest; that was never a disagreement, so, exactly as
                # before, it falls to UNDETERMINED rather than a vacuous OVERLAPS.
                group_overlap = (
                    Overlap.OVERLAPS
                    if pair_relations
                    and all(relation is Overlap.OVERLAPS for relation in pair_relations)
                    else Overlap.UNDETERMINED
                )
                found.append(Conflict(subject, members, group_overlap))
        return tuple(
            sorted(
                found,
                key=lambda conflict: (
                    conflict.key,
                    tuple(
                        (_content_digest(member), member.id)
                        for member in conflict.members
                    ),
                ),
            )
        )


def as_of_ranking(
    index: TemporalIndex,
    ranking: tuple[str, ...],
    *,
    valid_at: datetime | None = None,
    recorded_as_of: datetime | None = None,
) -> AsOfRanking:
    """Partition a caller ranking into kept, excluded, and undetermined ids.

    Each tuple preserves the supplied ranking order, and together the tuples
    contain every supplied id exactly once.
    """
    if type(index) is not TemporalIndex:
        raise TemporalTypeError(
            f"index must be a TemporalIndex, not {type(index).__name__}"
        )
    if type(ranking) is not tuple:
        raise TemporalTypeError("ranking must be a tuple of assertion ids")
    seen: set[str] = set()
    for assertion_id in ranking:
        if type(assertion_id) is not str:
            raise TemporalTypeError("ranking must be a tuple of str assertion ids")
        if assertion_id in seen:
            raise RankingDivergence(f"ranking repeats assertion id {assertion_id}")
        seen.add(assertion_id)
    held = {assertion.id for assertion in index._all_assertions()}
    for assertion_id in ranking:
        if assertion_id not in held:
            raise RankingDivergence(
                f"ranking names assertion id {assertion_id} which the index does not hold"
            )
    answer = index.as_of(
        valid_at=valid_at, recorded_as_of=recorded_as_of
    )
    established = {assertion.id for assertion in answer.established}
    excluded = {assertion.id for assertion in answer.excluded}
    undetermined = {assertion.id for assertion in answer.undetermined}
    return AsOfRanking(
        tuple(assertion_id for assertion_id in ranking if assertion_id in established),
        tuple(assertion_id for assertion_id in ranking if assertion_id in excluded),
        tuple(assertion_id for assertion_id in ranking if assertion_id in undetermined),
    )
