"""Record human adjudication without allowing a proposal to promote itself.

Arrival in a candidate ledger is evidence only that somebody or something
proposed material.  It is not a human decision, and it is not a mutation of
canonical knowledge.  This module keeps those acts separate: a decision is a
typed value supplied at the boundary, while :func:`promote` writes only an
append-only authorization record.  It deliberately neither imports nor calls
any canonical assertion writer.  A later capability may consume the record;
this one cannot make canonical content by itself.

The same separation applies to memory.  Rejection memory remains typed and
append-only because a later projection must be able to see why a candidate
failed.  Agent memory is a physically separate string-only store: that
absence of promotion-shaped values is a mechanism, not a convention.  These
records cannot establish that a named person made a truthful decision; they
ensure that no provider identity or remembered note is mistaken for authority.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from nous_os.attribution import AttributedKey, KeyOrigin, is_promotable
from nous_os.candidates import Proposal
from nous_os.identity import canonical_bytes


class AdjudicationError(Exception):
    """Raised when an adjudication record or its append-only storage is invalid."""


class Verdict(Enum):
    """The closed human outcomes; defer is an outcome, never latent permission."""

    PROMOTE = "promote"
    REJECT = "reject"
    DEFER = "defer"


_VERDICT_MEMBERS = tuple(Verdict)


def _is_canonical_verdict(value: object) -> bool:
    """Recognize only the enum's actual declared members by identity."""
    return any(value is member for member in _VERDICT_MEMBERS)


def _instant(value: object, field: str) -> str:
    """Validate and represent one timezone-aware instant in canonical UTC."""
    if type(value) is not datetime:
        raise AdjudicationError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise AdjudicationError(
            f"{field} must carry a timezone; a naive timestamp means different "
            "instants on different machines"
        )
    try:
        return value.astimezone(timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise AdjudicationError(f"{field} cannot be normalised to UTC") from error


def _non_blank(value: object, field: str) -> str:
    """Require exact, non-blank ordinary text before it enters a record."""
    if type(value) is not str or not value.strip():
        raise AdjudicationError(f"{field} must be a non-blank string")
    return value


@dataclass(frozen=True, slots=True)
class HumanDecision:
    """A decision supplied by a person at the adjudication boundary."""

    adjudicator: str
    verdict: Verdict
    decided_at: datetime
    rationale: str
    subject: AttributedKey

    def __post_init__(self) -> None:
        _non_blank(self.adjudicator, "adjudicator")
        if not _is_canonical_verdict(self.verdict):
            raise AdjudicationError("verdict must be a declared Verdict member")
        _instant(self.decided_at, "decided_at")
        _non_blank(self.rationale, "rationale")
        if type(self.subject) is not AttributedKey:
            raise AdjudicationError(
                f"subject must be an AttributedKey, not {type(self.subject).__name__}"
            )

    def __init_subclass__(cls, **kwargs: object) -> None:
        del cls, kwargs
        raise AdjudicationError(
            "decision records may not be subclassed: a subtype could report a "
            "verdict it does not hold"
        )


# A private identity alias lets the public structural guard distinguish a
# function that checks a decision from code that constructs one.
_DECISION_TYPE = HumanDecision


@dataclass(frozen=True, slots=True)
class PromotionRecord:
    """The append-only fact that promotion was authorised, not performed."""

    proposal_id: str
    adjudicator: str
    decided_at: datetime
    verdict: Verdict
    subject_key: str
    subject_origin: KeyOrigin

    def __post_init__(self) -> None:
        _non_blank(self.proposal_id, "proposal_id")
        _non_blank(self.adjudicator, "adjudicator")
        _instant(self.decided_at, "decided_at")
        if not _is_canonical_verdict(self.verdict):
            raise AdjudicationError("verdict must be a declared Verdict member")
        _non_blank(self.subject_key, "subject_key")
        # The value is carried as an enum member until serialisation, so an
        # uninitialised lookalike cannot be written as an origin string.
        if not any(self.subject_origin is origin for origin in KeyOrigin):
            raise AdjudicationError("subject_origin must be a declared KeyOrigin member")

    def as_payload(self) -> dict[str, str]:
        """Return the one JSON shape appended to the authorization ledger."""
        return {
            "proposal_id": self.proposal_id,
            "adjudicator": self.adjudicator,
            "decided_at": _instant(self.decided_at, "decided_at"),
            "verdict": self.verdict.value,
            "subject_key": self.subject_key,
            "subject_origin": self.subject_origin.value,
        }


def promote(*, decision: HumanDecision, candidate: Proposal, canon: Path) -> PromotionRecord:
    """Append authorization for a valid human promotion; never write canon itself."""
    # This is intentionally first: a malformed decision must not cause any
    # candidate inspection, path coercion, or filesystem activity.
    if type(decision) is not _DECISION_TYPE:
        raise AdjudicationError("decision must be an exact adjudication record")
    if decision.verdict is not Verdict.PROMOTE:
        raise AdjudicationError(
            f"decision verdict {decision.verdict.value!r} does not authorize promotion"
        )
    if not is_promotable(decision.subject):
        raise AdjudicationError(
            f"key origin {decision.subject.origin.value!r} does not authorize promotion"
        )
    if type(candidate) is not Proposal:
        raise AdjudicationError(
            f"candidate must be a Proposal, not {type(candidate).__name__}"
        )

    record = PromotionRecord(
        proposal_id=candidate.proposal_id,
        adjudicator=decision.adjudicator,
        decided_at=decision.decided_at,
        verdict=decision.verdict,
        subject_key=decision.subject.key.value,
        subject_origin=decision.subject.origin,
    )
    path = Path(canon)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as handle:
        handle.write(canonical_bytes(record.as_payload()) + b"\n")
    return record


@dataclass(frozen=True, slots=True)
class Rejection:
    """One durable failed gate, retained even if a later round succeeds."""

    cluster_id: str
    failed_gate: str
    reason: str
    round_number: int
    rejected_at: datetime

    def __post_init__(self) -> None:
        _non_blank(self.cluster_id, "cluster_id")
        _non_blank(self.failed_gate, "failed_gate")
        _non_blank(self.reason, "reason")
        if type(self.round_number) is not int or self.round_number < 1:
            raise AdjudicationError("round_number must be an int of at least one")
        _instant(self.rejected_at, "rejected_at")

    def as_payload(self) -> dict[str, str | int]:
        """Return the one canonical JSON representation of the rejection."""
        return {
            "cluster_id": self.cluster_id,
            "failed_gate": self.failed_gate,
            "reason": self.reason,
            "round_number": self.round_number,
            "rejected_at": _instant(self.rejected_at, "rejected_at"),
        }


class RejectionMemory:
    """Append-only rejection trace; recorded failures are never compacted or erased."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def record(
        self,
        *,
        cluster_id: str,
        failed_gate: str,
        reason: str,
        round_number: int,
        rejected_at: datetime,
    ) -> Rejection:
        """Append one typed failed-gate trace and return the exact record."""
        rejection = Rejection(
            cluster_id=cluster_id,
            failed_gate=failed_gate,
            reason=reason,
            round_number=round_number,
            rejected_at=rejected_at,
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(rejection.as_payload()) + b"\n")
        return rejection

    def rejections(self) -> tuple[Rejection, ...]:
        """Return every rejection in the file's append order, without sorting."""
        if not self._path.is_file():
            return ()
        found: list[Rejection] = []
        for number, line in enumerate(self._path.read_text(encoding="utf-8").splitlines(), 1):
            if not line:
                continue
            try:
                payload = json.loads(line)
                found.append(
                    Rejection(
                        cluster_id=payload["cluster_id"],
                        failed_gate=payload["failed_gate"],
                        reason=payload["reason"],
                        round_number=payload["round_number"],
                        rejected_at=datetime.fromisoformat(payload["rejected_at"]),
                    )
                )
            except (AdjudicationError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise AdjudicationError(
                    f"rejection line {number} is not readable: {error}"
                ) from error
        return tuple(found)

    def is_rejected(self, cluster_id: str) -> bool:
        """Whether this exact cluster identifier has at least one durable trace."""
        if type(cluster_id) is not str:
            raise AdjudicationError("cluster_id must be an exact string")
        return any(rejection.cluster_id == cluster_id for rejection in self.rejections())

    def rejected_clusters(self) -> frozenset[str]:
        """Return the unordered set of clusters that have a rejection trace."""
        return frozenset(rejection.cluster_id for rejection in self.rejections())


class AgentMemory:
    """A physically distinct string-only note store with no route to promotion.

    This separation is the mechanism, not a convention: its public reads have
    no promotion-shaped value to hand to an adjudication path.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def remember(self, *, session: str, note: str, at: datetime) -> None:
        """Append a note as data, never as an adjudication-shaped value."""
        payload = {
            "session": _non_blank(session, "session"),
            "note": _non_blank(note, "note"),
            "at": _instant(at, "at"),
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(payload) + b"\n")

    def notes(self) -> tuple[tuple[str, str, str], ...]:
        """Return only plain session, note, and instant strings in file order."""
        if not self._path.is_file():
            return ()
        found: list[tuple[str, str, str]] = []
        for number, line in enumerate(self._path.read_text(encoding="utf-8").splitlines(), 1):
            if not line:
                continue
            try:
                payload = json.loads(line)
                session = _non_blank(payload["session"], "session")
                note = _non_blank(payload["note"], "note")
                instant = _instant(datetime.fromisoformat(payload["at"]), "at")
            except (AdjudicationError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise AdjudicationError(
                    f"agent-memory line {number} is not readable: {error}"
                ) from error
            found.append((session, note, instant))
        return tuple(found)
