"""Human review files, promotion records, and append-only canonical assertions.

This module is intentionally a console-side boundary, not an operation in the
application catalogue.  A proposal remains immutable; a review reads its JSON
content, binds a human decision to its content digest and scope, records the
existing authorization, and only then writes a canonical assertion version.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Final, Iterable, Mapping

import nous_os.operations  # noqa: F401 -- registers the fixed promotion operation
from nous_os import cli
from nous_os.adjudication import AdjudicationError, HumanDecision, PromotionRecord, Verdict
from nous_os.attribution import AttributedKey, KeyOrigin
from nous_os.candidates import CandidateError, CandidateStore, Proposal, read_derived_citations
from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.capability import Grant, NotAuthorized, Tier, execute, required_tier
from nous_os.derived import CanonDivergence
from nous_os.identity import ASSERTION_PREFIX, canonical_bytes, digest_bytes, require_id
from nous_os.extraction import ExtractionStore
from nous_os.ledger import Ledger
from nous_os.provenance import (
    Citation,
    DerivedCitation,
    DerivedAssetMismatch,
    Locator,
    ProvenanceError,
    quote_lint,
    quote_lint_derived,
)
from nous_os.snapshots import SnapshotCorrupt, SnapshotNotFound, SnapshotStore
from nous_os.temporal import ClaimKey, ClaimKeyError


class ReviewError(Exception):
    """Raised when a review file, candidate, or canon record is not truthful."""


class CandidateRefused(ReviewError):
    """Raised with a stable reason when a proposal cannot be reviewed."""


class DecisionRefused(ReviewError):
    """Raised with a stable reason when a decision-line shape is invalid."""


_KINDS: Final[frozenset[str]] = frozenset(
    {
        "DECISION",
        "REQUIREMENT",
        "CONCEPT",
        "RELATIONSHIP",
        "OPEN_QUESTION",
        "CHANGE_OVER_TIME",
        "CONTRADICTION",
    }
)
_ORIGINS: Final[frozenset[str]] = frozenset(
    {"USER_AUTHORED", "ASSISTANT_SUGGESTED", "QUOTED", "INFERRED"}
)
_DECISION_VERDICTS: Final[frozenset[str]] = frozenset({"approve", "reject", "defer"})
_DECISION_FIELDS: Final[frozenset[str]] = frozenset(
    {"candidate_id", "version", "verdict", "scope", "reason", "decided_at", "decider"}
)
_CANDIDATE_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "statement",
        "kind",
        "scope",
        "origin",
        "support",
        "citations",
        "counter_citations",
        "valid_from",
        "valid_to",
        "why",
        "producer",
        "batch",
        "supersedes",
        "derived_citations",
        "derived_counter_citations",
        "notes",
    }
)
#: The producer's own working notes on a candidate (why it was shortlisted, what is uncertain, which earlier candidate it
#: refines). Optional, typed, bounded; carried on the candidate for the reviewer to read and never interpreted by the
#: console: notes do not change any outcome, are not a decision, and are not written into a canonical version.
_NOTES_MAX_CHARS: Final = 4000
_CITATION_FIELDS: Final[frozenset[str]] = frozenset(
    {"source_id", "snapshot_digest", "start_byte", "end_byte", "span"}
)
_CANON_FILE_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "id",
        "text",
        "citation",
        "support",
        "recorded_at",
        "state",
        "valid_from",
        "valid_to",
        "candidate_id",
        "candidate_version",
        "promotion_record_digest",
        "previous_digest",
        "version_digest",
        "derived_citations",
        "derived_counter_citations",
    }
)
_CANON_INDEX_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "assertion_id",
        "content_digest",
        "previous_digest",
        "candidate_id",
        "candidate_version",
        "promotion_record_digest",
        "version_digest",
        "decided_at",
    }
)
_AUDIT_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "decision_digest",
        "outcome",
        "candidate_id",
        "candidate_version",
        "verdict",
        "scope",
        "decided_at",
        "decider",
        "applied_at",
        "assertion_id",
        "content_digest",
        "refusal_reason",
    }
)
_OUTCOMES: Final[frozenset[str]] = frozenset(
    {
        "APPLIED",
        "STALE",
        "SCOPE_MISMATCH",
        "UNKNOWN_CANDIDATE",
        "DUPLICATE",
        "DECIDER_NOT_HUMAN",
        "ORIGIN_NEEDS_REASON",
        "NOT_PROMOTABLE",
        "RESERVED",
        "ALREADY_DECIDED",
        "CANDIDATE_MALFORMED",
        "EVIDENCE_UNRESOLVED",
        "SUPERSEDED_NOT_TAIL",
        "SUPERSEDES_UNCHANGED",
        "DECIDED_IN_FUTURE",
        "DERIVED_CITATION_FAILED",
    }
)
_REFUSED_DECIDER_WORDS: Final[frozenset[str]] = frozenset(
    {"assistant", "agent", "model", "ai", "bot", "system", "automation"}
)
_WORD: Final[re.Pattern[str]] = re.compile(r"[a-z]+")
_HEX64: Final[re.Pattern[str]] = re.compile(r"[0-9a-f]{64}\Z")


def _non_blank(value: object, reason: str, error_type: type[ReviewError]) -> str:
    if type(value) is not str or not value.strip():
        raise error_type(reason)
    return value


def _instant(value: object, reason: str, error_type: type[ReviewError]) -> datetime:
    if type(value) is not str:
        raise error_type(reason)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise error_type(reason) from error
    if parsed.tzinfo is None or parsed.tzinfo.utcoffset(parsed) is None:
        raise error_type(reason)
    try:
        parsed.astimezone(timezone.utc)
    except (OverflowError, OSError, ValueError) as error:
        raise error_type(reason) from error
    return parsed


def _optional_instant(value: object, reason: str) -> datetime | None:
    if value is None:
        return None
    return _instant(value, reason, CandidateRefused)


def _instant_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _digest(value: object) -> str:
    return digest_bytes(canonical_bytes(value))


def _citation_from_payload(value: object, reason: str) -> Citation:
    if type(value) is not dict or set(value) != _CITATION_FIELDS:
        raise CandidateRefused(reason)
    try:
        return Citation(
            source_id=value["source_id"],
            snapshot_digest=value["snapshot_digest"],
            locator=Locator(value["start_byte"], value["end_byte"]),
            span=value["span"],
        )
    except (KeyError, ProvenanceError) as error:
        raise CandidateRefused(reason) from error


def _citation_payload(citation: Citation) -> dict[str, object]:
    return citation.as_payload()


def _support(value: object) -> SupportClass:
    if type(value) is not str:
        raise CandidateRefused("UNKNOWN_SUPPORT")
    try:
        return SupportClass(value)
    except ValueError as error:
        raise CandidateRefused("UNKNOWN_SUPPORT") from error


def _digest_text(value: object, reason: str, error_type: type[ReviewError]) -> str:
    if type(value) is not str or _HEX64.fullmatch(value) is None:
        raise error_type(reason)
    return value


@dataclass(frozen=True, slots=True)
class ReviewCandidate:
    """A validated, typed reading of one immutable proposal."""

    proposal: Proposal
    statement: str
    kind: str
    scope: str
    origin: str
    support: SupportClass
    citations: tuple[Citation, ...]
    counter_citations: tuple[Citation, ...]
    derived_citations: tuple[DerivedCitation, ...]
    derived_counter_citations: tuple[DerivedCitation, ...]
    valid_from: datetime | None
    valid_to: datetime | None
    why: str
    producer: str
    batch: str
    supersedes: str | None
    notes: str | None
    _content_bytes: bytes

    @classmethod
    def from_proposal(cls, proposal: Proposal) -> "ReviewCandidate":
        if type(proposal) is not Proposal:
            raise CandidateRefused("NOT_A_PROPOSAL")
        try:
            payload = json.loads(proposal.content.as_data())
        except json.JSONDecodeError as error:
            raise CandidateRefused("CONTENT_NOT_JSON") from error
        required_fields = _CANDIDATE_FIELDS - {"derived_citations", "derived_counter_citations", "notes"}
        if (
            type(payload) is not dict
            or not required_fields <= set(payload)
            or not set(payload) <= _CANDIDATE_FIELDS
        ):
            raise CandidateRefused("CANDIDATE_SHAPE")

        statement = _non_blank(payload["statement"], "MISSING_STATEMENT", CandidateRefused)
        kind = payload["kind"]
        if type(kind) is not str or kind not in _KINDS:
            raise CandidateRefused("UNKNOWN_KIND")
        scope = _non_blank(payload["scope"], "BLANK_SCOPE", CandidateRefused)
        origin = payload["origin"]
        if type(origin) is not str or origin not in _ORIGINS:
            raise CandidateRefused("UNKNOWN_ORIGIN")
        support = _support(payload["support"])
        citations_payload = payload["citations"]
        if type(citations_payload) is not list or not citations_payload:
            raise CandidateRefused("MISSING_CITATION")
        citations = tuple(
            _citation_from_payload(citation, "MALFORMED_CITATION")
            for citation in citations_payload
        )
        counters_payload = payload["counter_citations"]
        if type(counters_payload) is not list:
            raise CandidateRefused("MALFORMED_COUNTER_CITATIONS")
        counter_citations = tuple(
            _citation_from_payload(citation, "MALFORMED_COUNTER_CITATION")
            for citation in counters_payload
        )
        try:
            derived_citations, derived_counter_citations = read_derived_citations(proposal)
        except CandidateError as error:
            raise CandidateRefused("MALFORMED_DERIVED_CITATION") from error
        valid_from = _optional_instant(payload["valid_from"], "MALFORMED_VALID_FROM")
        valid_to = _optional_instant(payload["valid_to"], "MALFORMED_VALID_TO")
        if valid_from is not None and valid_to is not None:
            if valid_to.astimezone(timezone.utc) <= valid_from.astimezone(timezone.utc):
                raise CandidateRefused("INVALID_VALIDITY_INTERVAL")
        why = payload["why"]
        if type(why) is not str:
            raise CandidateRefused("MALFORMED_WHY")
        notes = payload.get("notes")
        if notes is not None and (type(notes) is not str or len(notes) > _NOTES_MAX_CHARS):
            raise CandidateRefused("MALFORMED_NOTES")
        producer = _non_blank(payload["producer"], "MALFORMED_PRODUCER", CandidateRefused)
        batch = _non_blank(payload["batch"], "MALFORMED_BATCH", CandidateRefused)
        supersedes = payload["supersedes"]
        if supersedes is not None:
            if type(supersedes) is not str or "@" not in supersedes:
                raise CandidateRefused("MALFORMED_SUPERSEDES")
            proposal_id, version = supersedes.rsplit("@", 1)
            try:
                require_id(proposal_id, ASSERTION_PREFIX)
                _digest_text(version, "MALFORMED_SUPERSEDES", CandidateRefused)
            except Exception as error:
                if isinstance(error, CandidateRefused):
                    raise
                raise CandidateRefused("MALFORMED_SUPERSEDES") from error
        try:
            content_bytes = canonical_bytes(payload)
        except (TypeError, ValueError) as error:
            raise CandidateRefused("CANDIDATE_NOT_CANONICAL") from error
        return cls(
            proposal=proposal,
            statement=statement,
            kind=kind,
            scope=scope,
            origin=origin,
            support=support,
            citations=citations,
            counter_citations=counter_citations,
            derived_citations=derived_citations,
            derived_counter_citations=derived_counter_citations,
            valid_from=valid_from,
            valid_to=valid_to,
            why=why,
            producer=producer,
            batch=batch,
            supersedes=supersedes,
            notes=notes,
            _content_bytes=content_bytes,
        )

    @property
    def version(self) -> str:
        """The content digest that a decision binds, independent of file spelling."""
        return digest_bytes(self._content_bytes)

    @property
    def anchor(self) -> Citation:
        """The first citation, which the candidate shape reserves as its anchor."""
        return self.citations[0]


@dataclass(frozen=True, slots=True)
class ReviewDecision:
    """One decision-file line, validated before it can be applied."""

    candidate_id: str
    version: str
    verdict: str
    scope: str
    reason: str
    decided_at: datetime
    decided_at_text: str
    decider: str

    @classmethod
    def from_payload(cls, payload: object) -> "ReviewDecision":
        if type(payload) is not dict or set(payload) != _DECISION_FIELDS:
            raise DecisionRefused("DECISION_SHAPE")
        candidate_id = _non_blank(payload["candidate_id"], "MISSING_CANDIDATE_ID", DecisionRefused)
        version = _digest_text(payload["version"], "MALFORMED_VERSION", DecisionRefused)
        verdict = payload["verdict"]
        if type(verdict) is not str or verdict not in _DECISION_VERDICTS:
            raise DecisionRefused("UNKNOWN_VERDICT")
        scope = _non_blank(payload["scope"], "BLANK_SCOPE", DecisionRefused)
        reason = payload["reason"]
        if type(reason) is not str:
            raise DecisionRefused("MALFORMED_REASON")
        decided_at_text = payload["decided_at"]
        decided_at = _instant(decided_at_text, "MALFORMED_DECIDED_AT", DecisionRefused)
        decider = _non_blank(payload["decider"], "BLANK_DECIDER", DecisionRefused)
        return cls(
            candidate_id=candidate_id,
            version=version,
            verdict=verdict,
            scope=scope,
            reason=reason,
            decided_at=decided_at,
            decided_at_text=decided_at_text,
            decider=decider,
        )

    def as_payload(self) -> dict[str, str]:
        return {
            "candidate_id": self.candidate_id,
            "version": self.version,
            "verdict": self.verdict,
            "scope": self.scope,
            "reason": self.reason,
            "decided_at": self.decided_at_text,
            "decider": self.decider,
        }

    @property
    def digest(self) -> str:
        return _digest(self.as_payload())


@dataclass(frozen=True, slots=True)
class AuditEntry:
    """One append-only record of an attempted human decision."""

    decision_digest: str
    outcome: str
    candidate_id: str
    candidate_version: str
    verdict: str
    scope: str
    decided_at: str
    decider: str
    applied_at: str
    assertion_id: str | None = None
    content_digest: str | None = None
    refusal_reason: str | None = None

    def as_payload(self) -> dict[str, str | None]:
        return {
            "decision_digest": self.decision_digest,
            "outcome": self.outcome,
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "verdict": self.verdict,
            "scope": self.scope,
            "decided_at": self.decided_at,
            "decider": self.decider,
            "applied_at": self.applied_at,
            "assertion_id": self.assertion_id,
            "content_digest": self.content_digest,
            "refusal_reason": self.refusal_reason,
        }

    @classmethod
    def from_payload(cls, payload: object) -> "AuditEntry":
        if type(payload) is not dict or set(payload) != _AUDIT_FIELDS:
            raise ReviewError("AUDIT_SHAPE")
        try:
            entry = cls(
                decision_digest=_digest_text(payload["decision_digest"], "AUDIT_DIGEST", ReviewError),
                outcome=payload["outcome"],
                candidate_id=payload["candidate_id"],
                candidate_version=payload["candidate_version"],
                verdict=payload["verdict"],
                scope=payload["scope"],
                decided_at=payload["decided_at"],
                decider=payload["decider"],
                applied_at=payload["applied_at"],
                assertion_id=payload["assertion_id"],
                content_digest=payload["content_digest"],
                refusal_reason=payload["refusal_reason"],
            )
        except KeyError as error:
            raise ReviewError("AUDIT_SHAPE") from error
        if entry.outcome not in _OUTCOMES:
            raise ReviewError("AUDIT_OUTCOME")
        for field in (
            "candidate_id",
            "candidate_version",
            "verdict",
            "scope",
            "decided_at",
            "decider",
            "applied_at",
        ):
            if type(getattr(entry, field)) is not str:
                raise ReviewError("AUDIT_VALUE")
        if (entry.assertion_id is None) != (entry.content_digest is None):
            raise ReviewError("AUDIT_ASSERTION_LINK")
        if entry.refusal_reason is not None and (
            type(entry.refusal_reason) is not str or not entry.refusal_reason
        ):
            raise ReviewError("AUDIT_REFUSAL_REASON")
        if entry.assertion_id is not None:
            try:
                require_id(entry.assertion_id, ASSERTION_PREFIX)
                _digest_text(entry.content_digest, "AUDIT_ASSERTION_LINK", ReviewError)
            except Exception as error:
                if isinstance(error, ReviewError):
                    raise
                raise ReviewError("AUDIT_ASSERTION_LINK") from error
        return entry


@dataclass(frozen=True, slots=True)
class CanonVersion:
    """One verified canonical assertion version reconstructed from its file."""

    assertion: Assertion
    candidate_id: str
    candidate_version: str
    promotion_record_digest: str
    previous_digest: str | None
    version_digest: str
    derived_citations: tuple[DerivedCitation, ...]
    derived_counter_citations: tuple[DerivedCitation, ...]

    @property
    def content_digest(self) -> str:
        return self.assertion.content_digest

    def as_payload(self) -> dict[str, object]:
        return {
            "assertion_id": self.assertion.id,
            "content_digest": self.content_digest,
            "previous_digest": self.previous_digest,
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "promotion_record_digest": self.promotion_record_digest,
            "version_digest": self.version_digest,
        "decided_at": _instant_text(self.assertion.recorded_at),
        }


@dataclass(frozen=True, slots=True)
class QueueEntry:
    """A candidate and its latest durable review status, without changing either."""

    candidate_id: str
    version: str
    scope: str | None
    outcome: str

    def as_payload(self) -> dict[str, str | None]:
        return {
            "candidate_id": self.candidate_id,
            "version": self.version,
            "scope": self.scope,
            "outcome": self.outcome,
        }


@dataclass(frozen=True, slots=True)
class CanonWrite:
    """The result of a content-addressed assertion write attempt."""

    assertion_id: str
    content_digest: str
    previous_digest: str | None
    written: bool


def _json_lines(path: Path, *, encoding: str) -> tuple[str, ...]:
    """Read JSON Lines using its one record separator, LF.

    JSON strings may contain Unicode line separators.  They are data, rather
    than record boundaries, because every writer in this module terminates a
    record with exactly ``b"\\n"``.
    """
    text = Path(path).read_text(encoding=encoding)
    if not text:
        return ()
    if text.endswith("\n"):
        text = text[:-1]
    return tuple(text.split("\n"))


def _read_decisions(path: Path) -> tuple[ReviewDecision, ...]:
    found: list[ReviewDecision] = []
    for number, line in enumerate(_json_lines(path, encoding="utf-8-sig"), start=1):
        if not line:
            raise DecisionRefused(f"DECISION_LINE_{number}_EMPTY")
        try:
            found.append(ReviewDecision.from_payload(json.loads(line)))
        except (DecisionRefused, json.JSONDecodeError) as error:
            raise DecisionRefused(f"DECISION_LINE_{number}: {error}") from error
    return tuple(found)


def _audit_entries(path: Path) -> tuple[AuditEntry, ...]:
    path = Path(path)
    if not path.is_file():
        return ()
    found: list[AuditEntry] = []
    for number, line in enumerate(_json_lines(path, encoding="utf-8"), start=1):
        if not line:
            raise ReviewError(f"AUDIT_LINE_{number}_EMPTY")
        try:
            found.append(AuditEntry.from_payload(json.loads(line)))
        except (ReviewError, json.JSONDecodeError) as error:
            raise ReviewError(f"AUDIT_LINE_{number}: {error}") from error
    return tuple(found)


def _append_audit(path: Path, entry: AuditEntry) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as handle:
        handle.write(canonical_bytes(entry.as_payload()) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())


def _append_json_line(path: Path, payload: Mapping[str, object]) -> None:
    """Append one durable canonical JSON line."""
    with Path(path).open("ab") as handle:
        handle.write(canonical_bytes(payload) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())


@contextmanager
def _application_lock(audit_log: Path) -> Iterable[None]:
    """Serialize every mutable step for one audit log."""
    path = Path(f"{Path(audit_log)}.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _role_word_refused(decider: str) -> bool:
    return any(word in _REFUSED_DECIDER_WORDS for word in _WORD.findall(decider.casefold()))


def _audit_for(
    decision: ReviewDecision,
    outcome: str,
    *,
    assertion: CanonWrite | None = None,
    refusal_reason: str | None = None,
) -> AuditEntry:
    if outcome not in _OUTCOMES:
        raise ReviewError("AUDIT_OUTCOME")
    return AuditEntry(
        decision_digest=decision.digest,
        outcome=outcome,
        candidate_id=decision.candidate_id,
        candidate_version=decision.version,
        verdict=decision.verdict,
        scope=decision.scope,
        decided_at=decision.decided_at_text,
        decider=decision.decider,
        applied_at=datetime.now(timezone.utc).isoformat(),
        assertion_id=None if assertion is None else assertion.assertion_id,
        content_digest=None if assertion is None else assertion.content_digest,
        refusal_reason=refusal_reason,
    )


def _canonical_assertion_payload(
    assertion: Assertion,
    *,
    candidate_id: str,
    candidate_version: str,
    promotion_record_digest: str,
    previous_digest: str | None,
    derived_citations: tuple[DerivedCitation, ...],
    derived_counter_citations: tuple[DerivedCitation, ...],
) -> dict[str, object]:
    payload = {
        "id": assertion.id,
        "text": assertion.text,
        "citation": _citation_payload(assertion.citation),
        "support": assertion.support.value,
        "recorded_at": _instant_text(assertion.recorded_at),
        "state": assertion.state.value,
        "valid_from": None if assertion.valid_from is None else _instant_text(assertion.valid_from),
        "valid_to": None if assertion.valid_to is None else _instant_text(assertion.valid_to),
        "candidate_id": candidate_id,
        "candidate_version": candidate_version,
        "promotion_record_digest": promotion_record_digest,
        "previous_digest": previous_digest,
        "derived_citations": [citation.as_payload() for citation in derived_citations],
        "derived_counter_citations": [
            citation.as_payload() for citation in derived_counter_citations
        ],
    }
    return {**payload, "version_digest": _digest(payload)}


def _assertion_for(
    candidate: ReviewCandidate,
    decision: ReviewDecision,
    previous: CanonVersion | None,
) -> Assertion:
    """Build exactly the assertion a candidate would write to canon."""
    assertion_id = None if previous is None else previous.assertion.id
    if assertion_id is None:
        from nous_os.identity import new_assertion_id

        assertion_id = new_assertion_id()
    return Assertion(
        id=assertion_id,
        text=candidate.statement,
        citation=candidate.anchor,
        support=candidate.support,
        recorded_at=decision.decided_at,
        state=LifecycleState.CANONICAL,
        valid_from=candidate.valid_from,
        valid_to=candidate.valid_to,
    )


def _canon_versions(canon_root: Path) -> tuple[CanonVersion, ...]:
    return canon_index(canon_root)


def _previous_version(candidate: ReviewCandidate, canon_root: Path) -> CanonVersion | None:
    if candidate.supersedes is None:
        return None
    previous_id, previous_version = candidate.supersedes.rsplit("@", 1)
    for version in _canon_versions(canon_root):
        if (
            version.candidate_id == previous_id
            and version.candidate_version == previous_version
        ):
            return version
    return None


def _is_tail(version: CanonVersion, canon_root: Path) -> bool:
    """Whether no later version already follows this assertion version."""
    return not any(
        other.previous_digest == version.content_digest
        for other in _canon_versions(canon_root)
    )


def _written_candidate_version(
    candidate: ReviewCandidate, canon_root: Path
) -> CanonVersion | None:
    matches = [
        version
        for version in _canon_versions(canon_root)
        if (
            version.candidate_id == candidate.proposal.proposal_id
            and version.candidate_version == candidate.version
        )
    ]
    if len(matches) > 1:
        raise CanonDivergence("candidate has more than one canonical assertion version")
    return None if not matches else matches[0]


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ensure_index_entry(root: Path, payload: dict[str, object]) -> None:
    """Record one version record once, refusing an incompatible duplicate."""
    path = root / "assertions.jsonl"
    if path.exists():
        if not path.is_file():
            raise CanonDivergence(f"canonical assertion index is not a file: {path}")
        for number, line in enumerate(_json_lines(path, encoding="utf-8"), start=1):
            if not line:
                raise CanonDivergence(f"canonical assertion index has an empty line: {path}:{number}")
            try:
                existing = json.loads(line)
            except json.JSONDecodeError as error:
                raise CanonDivergence(
                    f"canonical assertion index is unreadable: {path}:{number}"
                ) from error
            if (
                type(existing) is dict
                and existing.get("assertion_id") == payload["assertion_id"]
                and existing.get("content_digest") == payload["content_digest"]
            ):
                if canonical_bytes(existing) != canonical_bytes(payload):
                    raise CanonDivergence(f"canonical assertion index diverges: {path}:{number}")
                return
    _append_json_line(path, payload)


def _index_payload(
    *,
    assertion: Assertion,
    candidate: ReviewCandidate,
    promotion_record_digest: str,
    previous_digest: str | None,
    version_digest: str,
) -> dict[str, object]:
    return {
        "assertion_id": assertion.id,
        "content_digest": assertion.content_digest,
        "previous_digest": previous_digest,
        "candidate_id": candidate.proposal.proposal_id,
        "candidate_version": candidate.version,
        "promotion_record_digest": promotion_record_digest,
        "version_digest": version_digest,
        "decided_at": _instant_text(assertion.recorded_at),
    }


def _write_assertion(
    *,
    candidate: ReviewCandidate,
    decision: ReviewDecision,
    promotion_record_digest: str,
    canon_root: Path,
) -> CanonWrite:
    existing_version = _written_candidate_version(candidate, canon_root)
    if existing_version is not None:
        if existing_version.promotion_record_digest != promotion_record_digest:
            raise CanonDivergence("candidate promotion record diverges")
        return CanonWrite(
            existing_version.assertion.id,
            existing_version.content_digest,
            existing_version.previous_digest,
            False,
        )
    previous = _previous_version(candidate, canon_root)
    assertion = _assertion_for(candidate, decision, previous)
    previous_digest = None if previous is None else previous.content_digest
    digest = assertion.content_digest
    payload = _canonical_assertion_payload(
        assertion,
        candidate_id=candidate.proposal.proposal_id,
        candidate_version=candidate.version,
        promotion_record_digest=promotion_record_digest,
        previous_digest=previous_digest,
        derived_citations=candidate.derived_citations,
        derived_counter_citations=candidate.derived_counter_citations,
    )
    root = Path(canon_root)
    version_path = root / "assertions" / assertion.id / f"{digest}.json"
    index_payload = _index_payload(
        assertion=assertion,
        candidate=candidate,
        promotion_record_digest=promotion_record_digest,
        previous_digest=previous_digest,
        version_digest=payload["version_digest"],
    )
    if version_path.exists():
        try:
            existing = json.loads(version_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise CanonDivergence(f"canonical assertion file is unreadable: {version_path}") from error
        if canonical_bytes(existing) != canonical_bytes(payload):
            raise CanonDivergence(f"canonical assertion file diverges: {version_path}")
        _ensure_index_entry(root, index_payload)
        return CanonWrite(assertion.id, digest, previous_digest, False)

    version_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{digest}.", suffix=".partial", dir=version_path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_bytes(payload) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, version_path)
        _fsync_directory(version_path.parent)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise
    _ensure_index_entry(root, index_payload)
    return CanonWrite(assertion.id, digest, previous_digest, True)


def _scope_claim_key(scope: str) -> ClaimKey | None:
    """Derive a stable claim key from a free-text scope.

    NFKD-decompose, drop the combining marks (so ``é`` reads ``e``), lower-case,
    replace every run of characters outside ``[a-z0-9]`` -- dashes of any
    width, quotes, slashes, non-Latin letters -- with one ``-``, and remove
    edge separators. Keys longer than 64 characters end at the last available
    ``-`` boundary, or at character 64 when no such boundary exists. The same
    scope therefore always derives the same claim key.
    """
    import unicodedata  # local, as the sibling modules do for rarely used helpers

    decomposed = unicodedata.normalize("NFKD", scope)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()
    key = re.sub(r"[^a-z0-9]+", "-", stripped).strip("-")
    if not key:
        return None
    if len(key) > 64:
        prefix = key[:64].rstrip("-")
        boundary = prefix.rfind("-")
        key = prefix[:boundary] if boundary >= 0 else prefix
    return ClaimKey(key)


def _subject_for(candidate: ReviewCandidate) -> AttributedKey:
    """Bind an explicit key scope or a deterministic derived scope key."""
    try:
        return AttributedKey(key=ClaimKey(candidate.scope), origin=KeyOrigin.OPERATOR)
    except (ClaimKeyError, ValueError):
        key = _scope_claim_key(candidate.scope)
        if key is None:
            raise ReviewError("NOT_PROMOTABLE")
        return AttributedKey(key=key, origin=KeyOrigin.DERIVED)


def _promotion_decision(candidate: ReviewCandidate, decision: ReviewDecision) -> HumanDecision:
    rationale = decision.reason if decision.reason.strip() else "Decision recorded without added rationale."
    return HumanDecision(
        adjudicator=decision.decider,
        verdict=Verdict.PROMOTE,
        decided_at=decision.decided_at,
        rationale=rationale,
        subject=_subject_for(candidate),
    )


def _require_promote_grant(grant: Grant) -> None:
    """Refuse a weak grant before reading or writing any mutable store."""
    if required_tier("promote_candidate") is not Tier.PROMOTE:
        raise ReviewError("promotion registry tier diverged")
    if type(grant) is not Grant or not grant.holds(Tier.PROMOTE):
        raise NotAuthorized("the grant does not hold the operation's required tier")


def _validate_canon_root(
    canon_root: Path, *, resumable_pairs: frozenset[tuple[str, str]] = frozenset()
) -> None:
    """Reject impossible canonical paths before any mutable side effect."""
    root = Path(canon_root)
    ancestor = root
    while ancestor != ancestor.parent:
        if ancestor.exists() and not ancestor.is_dir():
            raise ReviewError("CANON_ROOT_NOT_DIRECTORY")
        ancestor = ancestor.parent
    if root.exists() and not root.is_dir():
        raise ReviewError("CANON_ROOT_NOT_DIRECTORY")
    assertions = root / "assertions"
    if assertions.exists() and not assertions.is_dir():
        raise ReviewError("CANON_ASSERTIONS_NOT_DIRECTORY")
    index = root / "assertions.jsonl"
    if index.exists() and not index.is_file():
        raise ReviewError("CANON_INDEX_NOT_FILE")
    if root.exists():
        # A regular file at the index path is viable only if it is the index
        # it claims to be.  Verify all existing bytes before an authorization
        # can be appended for a later write that would fail.
        try:
            canon_index(root)
        except CanonDivergence:
            missing = _unindexed_versions(root)
            missing_pairs = {
                (version.candidate_id, version.candidate_version)
                for version in missing.values()
            }
            if not missing_pairs or not missing_pairs <= resumable_pairs:
                raise


def _prepare_canon_root(canon_root: Path) -> None:
    """Create the canonical directories before reserving a decision."""
    root = Path(canon_root)
    assertions = root / "assertions"
    try:
        root.mkdir(parents=True, exist_ok=True)
        assertions.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ReviewError("CANON_ROOT_UNAVAILABLE") from error
    if not root.is_dir():
        raise ReviewError("CANON_ROOT_NOT_DIRECTORY")
    if not assertions.is_dir():
        raise ReviewError("CANON_ASSERTIONS_NOT_DIRECTORY")


def _resumable_pairs(
    decisions: Iterable[ReviewDecision], entries: Iterable[AuditEntry]
) -> frozenset[tuple[str, str]]:
    entries = tuple(entries)
    reserved = {entry.decision_digest for entry in entries if entry.outcome == "RESERVED"}
    completed = {entry.decision_digest for entry in entries if entry.outcome == "APPLIED"}
    return frozenset(
        (decision.candidate_id, decision.version)
        for decision in decisions
        if decision.digest in reserved and decision.digest not in completed
    )


def _authorization_payload(
    path: Path, *, candidate: ReviewCandidate, decision: ReviewDecision
) -> dict[str, object] | None:
    """Find the durable promotion record that makes a reserved run resumable."""
    path = Path(path)
    if not path.exists():
        return None
    if not path.is_file():
        raise ReviewError("AUTHORIZATIONS_NOT_FILE")
    decided_at = _instant_text(decision.decided_at)
    for number, line in enumerate(_json_lines(path, encoding="utf-8"), start=1):
        if not line:
            raise ReviewError(f"AUTHORIZATION_LINE_{number}_EMPTY")
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            raise ReviewError(f"AUTHORIZATION_LINE_{number}_MALFORMED") from error
        if type(payload) is not dict:
            raise ReviewError(f"AUTHORIZATION_LINE_{number}_MALFORMED")
        if (
            payload.get("proposal_id") == candidate.proposal.proposal_id
            and payload.get("decided_at") == decided_at
            and payload.get("verdict") == Verdict.PROMOTE.value
        ):
            return payload
    return None


def _sync_authorizations(path: Path) -> None:
    with Path(path).open("rb") as handle:
        os.fsync(handle.fileno())


def _all_citations(candidate: ReviewCandidate) -> tuple[Citation, ...]:
    return candidate.citations + candidate.counter_citations


def _all_derived_citations(candidate: ReviewCandidate) -> tuple[DerivedCitation, ...]:
    return candidate.derived_citations + candidate.derived_counter_citations


def _evidence_is_resolved(candidate: ReviewCandidate, snapshots: SnapshotStore) -> str | None:
    try:
        for citation in _all_citations(candidate):
            quote_lint(snapshots, citation)
    except (ProvenanceError, SnapshotNotFound, SnapshotCorrupt) as error:
        return type(error).__name__
    return None


def _derived_evidence_is_resolved(
    candidate: ReviewCandidate,
    extraction_store: ExtractionStore,
    snapshots: SnapshotStore,
    ledger: Ledger | None,
) -> str | None:
    """Lint every derived citation without changing any store or canonical file."""
    if not _all_derived_citations(candidate):
        return None
    if ledger is None:
        return DerivedAssetMismatch.__name__
    try:
        for citation in _all_derived_citations(candidate):
            quote_lint_derived(extraction_store, snapshots, ledger, citation)
    except Exception as error:
        return type(error).__name__
    return None


def apply(
    *,
    decisions_path: Path,
    data_root: Path,
    candidate_store_path: Path,
    snapshot_root: Path,
    extraction_store_path: Path | None = None,
    ledger_path: Path | None = None,
    authorizations_path: Path,
    canon_root: Path,
    audit_log: Path,
    grant: Grant,
) -> tuple[AuditEntry, ...]:
    """Apply a decision file in order under a promotion grant.

    ``data_root`` and ``snapshot_root`` are explicit so no mutable or evidence
    store can be silently selected by an omitted default.
    """
    _require_promote_grant(grant)
    # Resolve the explicit root without opening or creating it.
    Path(data_root).expanduser().resolve()
    Path(snapshot_root).expanduser().resolve()
    preflight_decisions = _read_decisions(Path(decisions_path))
    preflight_audit = _audit_entries(Path(audit_log))
    _validate_canon_root(
        Path(canon_root),
        resumable_pairs=_resumable_pairs(preflight_decisions, preflight_audit),
    )

    with _application_lock(Path(audit_log)):
        decisions = _read_decisions(Path(decisions_path))
        store = CandidateStore(Path(candidate_store_path))
        proposals = {proposal.proposal_id: proposal for proposal in store.proposals()}
        snapshots = SnapshotStore(Path(snapshot_root))
        extraction_store = ExtractionStore(extraction_store_path)
        ledger = None if ledger_path is None else Ledger(Path(ledger_path))
        prior_audit = _audit_entries(Path(audit_log))
        known_digests = {entry.decision_digest for entry in prior_audit}
        applied_pairs = {
            (entry.candidate_id, entry.candidate_version)
            for entry in prior_audit
            if entry.outcome == "APPLIED"
        }
        reserved_digests = {
            entry.decision_digest for entry in prior_audit if entry.outcome == "RESERVED"
        }
        completed_digests = {
            entry.decision_digest for entry in prior_audit if entry.outcome == "APPLIED"
        }
        reserved_pairs = {
            (entry.candidate_id, entry.candidate_version)
            for entry in prior_audit
            if entry.outcome == "RESERVED"
        }
        resumable_pairs = _resumable_pairs(decisions, prior_audit)
        _validate_canon_root(Path(canon_root), resumable_pairs=resumable_pairs)
        _repair_reserved_index_entries(Path(canon_root), resumable_pairs)
        applied: list[AuditEntry] = []

        def record(entry: AuditEntry) -> None:
            _append_audit(Path(audit_log), entry)
            known_digests.add(entry.decision_digest)
            if entry.outcome == "RESERVED":
                reserved_digests.add(entry.decision_digest)
                reserved_pairs.add((entry.candidate_id, entry.candidate_version))
            if entry.outcome == "APPLIED":
                applied_pairs.add((entry.candidate_id, entry.candidate_version))
                completed_digests.add(entry.decision_digest)
            applied.append(entry)

        for decision in decisions:
            pair = (decision.candidate_id, decision.version)
            if pair in applied_pairs:
                record(_audit_for(decision, "ALREADY_DECIDED"))
                continue
            resuming = decision.digest in reserved_digests and decision.digest not in completed_digests
            if pair in reserved_pairs and not resuming:
                record(_audit_for(decision, "ALREADY_DECIDED"))
                continue
            if decision.digest in known_digests and not resuming:
                record(_audit_for(decision, "DUPLICATE"))
                continue
            if decision.decided_at > datetime.now(timezone.utc) + timedelta(minutes=5):
                record(_audit_for(decision, "DECIDED_IN_FUTURE"))
                continue

            proposal = proposals.get(decision.candidate_id)
            candidate: ReviewCandidate | None = None
            outcome: str | None = None
            refusal_reason: str | None = None
            if proposal is None:
                outcome = "UNKNOWN_CANDIDATE"
            else:
                try:
                    candidate = ReviewCandidate.from_proposal(proposal)
                except CandidateRefused as error:
                    outcome = "CANDIDATE_MALFORMED"
                    refusal_reason = str(error)
                if candidate is not None:
                    if decision.version != candidate.version:
                        outcome = "STALE"
                    elif decision.scope != candidate.scope:
                        outcome = "SCOPE_MISMATCH"
                    elif _role_word_refused(decision.decider):
                        outcome = "DECIDER_NOT_HUMAN"
                    elif (
                        decision.verdict == "approve"
                        and candidate.origin in {"QUOTED", "ASSISTANT_SUGGESTED"}
                        and (not decision.reason.strip() or candidate.support is SupportClass.UNKNOWN)
                    ):
                        outcome = "ORIGIN_NEEDS_REASON"

            if outcome is not None:
                record(_audit_for(decision, outcome, refusal_reason=refusal_reason))
                continue

            if candidate is None:  # pragma: no cover - guarded by the candidate lookup above
                raise ReviewError("candidate resolution diverged")
            if decision.verdict != "approve":
                record(_audit_for(decision, "APPLIED"))
                continue

            evidence_error = _evidence_is_resolved(candidate, snapshots)
            if evidence_error is not None:
                record(
                    _audit_for(
                        decision,
                        "EVIDENCE_UNRESOLVED",
                        refusal_reason=evidence_error,
                    )
                )
                continue
            derived_evidence_error = _derived_evidence_is_resolved(
                candidate, extraction_store, snapshots, ledger
            )
            if derived_evidence_error is not None:
                record(
                    _audit_for(
                        decision,
                        "DERIVED_CITATION_FAILED",
                        refusal_reason=derived_evidence_error,
                    )
                )
                continue
            previous = _previous_version(candidate, Path(canon_root))
            if candidate.supersedes is not None and (
                previous is None or not _is_tail(previous, Path(canon_root))
            ):
                record(_audit_for(decision, "SUPERSEDED_NOT_TAIL"))
                continue
            if (
                previous is not None
                and _assertion_for(candidate, decision, previous).content_digest
                == previous.content_digest
            ):
                record(_audit_for(decision, "SUPERSEDES_UNCHANGED"))
                continue

            _prepare_canon_root(Path(canon_root))
            if not resuming:
                record(_audit_for(decision, "RESERVED"))
            try:
                authorization = _authorization_payload(
                    Path(authorizations_path), candidate=candidate, decision=decision
                )
                if authorization is None:
                    human_decision = _promotion_decision(candidate, decision)
                    promotion = execute(
                        grant,
                        "promote_candidate",
                        decision=human_decision,
                        candidate=candidate.proposal,
                        authorizations=Path(authorizations_path),
                    )
                    if type(promotion) is not PromotionRecord:
                        raise ReviewError("promotion registry returned an invalid record")
                    _sync_authorizations(Path(authorizations_path))
                    promotion_record_digest = _digest(promotion.as_payload())
                else:
                    promotion_record_digest = _digest(authorization)
                write = _write_assertion(
                    candidate=candidate,
                    decision=decision,
                    promotion_record_digest=promotion_record_digest,
                    canon_root=Path(canon_root),
                )
            except (AdjudicationError, ReviewError, ClaimKeyError):
                record(_audit_for(decision, "NOT_PROMOTABLE"))
                continue
            record(_audit_for(decision, "APPLIED", assertion=write))
        return tuple(applied)


def _canon_version_from_file(path: Path) -> CanonVersion:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CanonDivergence(f"canonical assertion file is unreadable: {path}") from error
    if type(payload) is not dict or set(payload) != _CANON_FILE_FIELDS:
        raise CanonDivergence(f"canonical assertion file has the wrong shape: {path}")
    try:
        version_digest = _digest_text(
            payload["version_digest"], "CANON_VERSION_DIGEST", ReviewError
        )
        wrapper = {key: value for key, value in payload.items() if key != "version_digest"}
        if _digest(wrapper) != version_digest:
            raise ReviewError("CANON_VERSION_DIGEST")
        citation_payload = payload["citation"]
        if type(citation_payload) is not dict or set(citation_payload) != _CITATION_FIELDS:
            raise CanonDivergence(f"canonical citation shape diverges: {path}")
        citation = Citation(
            source_id=citation_payload["source_id"],
            snapshot_digest=citation_payload["snapshot_digest"],
            locator=Locator(citation_payload["start_byte"], citation_payload["end_byte"]),
            span=citation_payload["span"],
        )
        derived_payload = payload["derived_citations"]
        derived_counter_payload = payload["derived_counter_citations"]
        if type(derived_payload) is not list or type(derived_counter_payload) is not list:
            raise ReviewError("CANON_DERIVED_CITATIONS")
        from nous_os.provenance import derived_citation_from_payload

        derived_citations = tuple(
            derived_citation_from_payload(item) for item in derived_payload
        )
        derived_counter_citations = tuple(
            derived_citation_from_payload(item) for item in derived_counter_payload
        )
        assertion = Assertion(
            id=payload["id"],
            text=payload["text"],
            citation=citation,
            support=SupportClass(payload["support"]),
            recorded_at=_instant(payload["recorded_at"], "CANON_RECORDED_AT", ReviewError),
            state=LifecycleState(payload["state"]),
            valid_from=(
                None
                if payload["valid_from"] is None
                else _instant(payload["valid_from"], "CANON_VALID_FROM", ReviewError)
            ),
            valid_to=(
                None
                if payload["valid_to"] is None
                else _instant(payload["valid_to"], "CANON_VALID_TO", ReviewError)
            ),
        )
        candidate_id = payload["candidate_id"]
        candidate_version = _digest_text(payload["candidate_version"], "CANON_VERSION", ReviewError)
        record_digest = _digest_text(
            payload["promotion_record_digest"], "CANON_PROMOTION_DIGEST", ReviewError
        )
        previous_digest = payload["previous_digest"]
        if previous_digest is not None:
            previous_digest = _digest_text(previous_digest, "CANON_PREVIOUS_DIGEST", ReviewError)
    except (CanonicalError, KeyError, ProvenanceError, ReviewError, ValueError) as error:
        raise CanonDivergence(f"canonical assertion file diverges: {path}") from error
    if assertion.id != path.parent.name or assertion.content_digest != path.stem:
        raise CanonDivergence(f"canonical assertion identity or digest diverges: {path}")
    if assertion.state is not LifecycleState.CANONICAL:
        raise CanonDivergence(f"canonical assertion is not canonical: {path}")
    if type(candidate_id) is not str:
        raise CanonDivergence(f"canonical candidate identifier diverges: {path}")
    return CanonVersion(
        assertion=assertion,
        candidate_id=candidate_id,
        candidate_version=candidate_version,
        promotion_record_digest=record_digest,
        previous_digest=previous_digest,
        version_digest=version_digest,
        derived_citations=derived_citations,
        derived_counter_citations=derived_counter_citations,
    )


def _verify_chain(versions: Iterable[CanonVersion]) -> None:
    by_id: dict[str, list[CanonVersion]] = {}
    for version in versions:
        by_id.setdefault(version.assertion.id, []).append(version)
    for assertion_id, group in by_id.items():
        digests = {version.content_digest for version in group}
        predecessors = {version.content_digest: version.previous_digest for version in group}
        if len(digests) != len(group):
            raise CanonDivergence(f"duplicate canonical assertion digest for {assertion_id}")
        roots = [digest for digest, previous in predecessors.items() if previous is None]
        if len(roots) != 1:
            raise CanonDivergence(f"canonical chain has no unique root for {assertion_id}")
        successors: dict[str, int] = {}
        for digest, previous in predecessors.items():
            if previous is None:
                continue
            if previous not in digests or previous == digest:
                raise CanonDivergence(f"canonical chain has an invalid predecessor for {assertion_id}")
            successors[previous] = successors.get(previous, 0) + 1
            if successors[previous] > 1:
                raise CanonDivergence(f"canonical chain branches for {assertion_id}")
        seen: set[str] = set()
        current = next(iter(roots))
        while current not in seen:
            seen.add(current)
            next_items = [digest for digest, previous in predecessors.items() if previous == current]
            if not next_items:
                break
            current = next_items[0]
        if seen != digests:
            raise CanonDivergence(f"canonical chain is cyclic or disconnected for {assertion_id}")


def _canon_index_payloads(root: Path) -> tuple[dict[str, object], ...]:
    path = root / "assertions.jsonl"
    if not path.exists():
        return ()
    if not path.is_file():
        raise CanonDivergence(f"canonical assertion index is not a file: {path}")
    found: list[dict[str, object]] = []
    for number, line in enumerate(_json_lines(path, encoding="utf-8"), start=1):
        if not line:
            raise CanonDivergence(f"canonical assertion index has an empty line: {path}:{number}")
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            raise CanonDivergence(
                f"canonical assertion index is unreadable: {path}:{number}"
            ) from error
        if type(payload) is not dict or set(payload) != _CANON_INDEX_FIELDS:
            raise CanonDivergence(f"canonical assertion index has the wrong shape: {path}:{number}")
        try:
            require_id(payload["assertion_id"], ASSERTION_PREFIX)
            _digest_text(payload["content_digest"], "CANON_INDEX_CONTENT_DIGEST", ReviewError)
            _digest_text(payload["candidate_version"], "CANON_INDEX_VERSION", ReviewError)
            _digest_text(
                payload["promotion_record_digest"], "CANON_INDEX_PROMOTION_DIGEST", ReviewError
            )
            _digest_text(payload["version_digest"], "CANON_INDEX_VERSION_RECORD_DIGEST", ReviewError)
            if payload["previous_digest"] is not None:
                _digest_text(payload["previous_digest"], "CANON_INDEX_PREVIOUS_DIGEST", ReviewError)
            _instant(payload["decided_at"], "CANON_INDEX_DECIDED_AT", ReviewError)
            if type(payload["candidate_id"]) is not str:
                raise ReviewError("CANON_INDEX_CANDIDATE")
        except (KeyError, ReviewError, ValueError) as error:
            raise CanonDivergence(f"canonical assertion index diverges: {path}:{number}") from error
        found.append(payload)
    return tuple(found)


def canon_index(canon_root: Path) -> tuple[CanonVersion, ...]:
    """Rebuild a deterministic verified assertion listing from durable version records."""
    base = Path(canon_root)
    root = base / "assertions"
    index_payloads = _canon_index_payloads(base)
    if not root.exists():
        if index_payloads:
            raise CanonDivergence(f"canonical assertion files are absent for index: {base}")
        return ()
    if not root.is_dir():
        raise CanonDivergence(f"canonical assertion root is not a directory: {root}")
    paths = sorted(path for path in root.rglob("*.json") if path.is_file())
    versions = tuple(_canon_version_from_file(path) for path in paths)
    _verify_chain(versions)
    expected = {
        (version.assertion.id, version.content_digest): version.as_payload() for version in versions
    }
    indexed: dict[tuple[str, str], dict[str, object]] = {}
    for payload in index_payloads:
        key = (payload["assertion_id"], payload["content_digest"])
        if key in indexed or key not in expected:
            raise CanonDivergence(f"canonical assertion index diverges: {base / 'assertions.jsonl'}")
        if canonical_bytes(payload) != canonical_bytes(expected[key]):
            raise CanonDivergence(f"canonical assertion index diverges: {base / 'assertions.jsonl'}")
        indexed[key] = payload
    if set(indexed) != set(expected):
        raise CanonDivergence(f"canonical assertion index diverges: {base / 'assertions.jsonl'}")
    return tuple(sorted(versions, key=lambda version: (version.assertion.id, version.content_digest)))


def _unindexed_versions(canon_root: Path) -> dict[tuple[str, str], CanonVersion]:
    """Return verified versions whose only missing record is their index line."""
    base = Path(canon_root)
    root = base / "assertions"
    index_payloads = _canon_index_payloads(base)
    if not root.exists():
        if index_payloads:
            raise CanonDivergence(f"canonical assertion files are absent for index: {base}")
        return {}
    if not root.is_dir():
        raise CanonDivergence(f"canonical assertion root is not a directory: {root}")
    versions = tuple(_canon_version_from_file(path) for path in sorted(root.rglob("*.json")) if path.is_file())
    _verify_chain(versions)
    expected = {
        (version.assertion.id, version.content_digest): version for version in versions
    }
    indexed: set[tuple[str, str]] = set()
    for payload in index_payloads:
        key = (payload["assertion_id"], payload["content_digest"])
        version = expected.get(key)
        if key in indexed or version is None:
            raise CanonDivergence(f"canonical assertion index diverges: {base / 'assertions.jsonl'}")
        if canonical_bytes(payload) != canonical_bytes(version.as_payload()):
            raise CanonDivergence(f"canonical assertion index diverges: {base / 'assertions.jsonl'}")
        indexed.add(key)
    return {key: version for key, version in expected.items() if key not in indexed}


def _repair_reserved_index_entries(
    canon_root: Path, resumable_pairs: frozenset[tuple[str, str]]
) -> None:
    """Finish index appends left behind by exact unfinished reservations."""
    if not resumable_pairs:
        return
    missing = _unindexed_versions(canon_root)
    missing_pairs = {
        (version.candidate_id, version.candidate_version) for version in missing.values()
    }
    if not missing_pairs:
        return
    if not missing_pairs <= resumable_pairs:
        raise CanonDivergence(f"canonical assertion index diverges: {Path(canon_root) / 'assertions.jsonl'}")
    for version in missing.values():
        _ensure_index_entry(Path(canon_root), version.as_payload())


def queue(store: CandidateStore, log: Path) -> tuple[QueueEntry, ...]:
    """List candidates and their latest durable review outcome without writing."""
    if type(store) is not CandidateStore:
        raise ReviewError("QUEUE_REQUIRES_CANDIDATE_STORE")
    latest: dict[tuple[str, str], AuditEntry] = {}
    for entry in _audit_entries(Path(log)):
        key = (entry.candidate_id, entry.candidate_version)
        # Replay and idempotency outcomes are durable observations, but they
        # do not replace the prior applied decision the queue is reporting.
        if entry.outcome in {"DUPLICATE", "ALREADY_DECIDED", "RESERVED"} and key in latest:
            continue
        latest[key] = entry
    status = {
        "approve": "approved",
        "reject": "rejected",
        "defer": "deferred",
    }
    found: list[QueueEntry] = []
    for proposal in store.proposals():
        try:
            candidate = ReviewCandidate.from_proposal(proposal)
        except CandidateRefused:
            found.append(QueueEntry(proposal.proposal_id, "", None, "none"))
            continue
        entry = latest.get((proposal.proposal_id, candidate.version))
        outcome = "none"
        if entry is not None:
            if entry.outcome == "APPLIED":
                outcome = status[entry.verdict]
            elif entry.outcome == "STALE":
                outcome = "stale-refused"
        found.append(QueueEntry(proposal.proposal_id, candidate.version, candidate.scope, outcome))
    return tuple(found)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nous-os-review", allow_abbrev=False)
    subparsers = parser.add_subparsers(dest="command", required=True)
    apply_parser = subparsers.add_parser("apply", allow_abbrev=False)
    apply_parser.add_argument("decision_file")
    apply_parser.add_argument("--data-root", required=True)
    apply_parser.add_argument("--candidate-store-path", required=True)
    apply_parser.add_argument("--snapshot-root", required=True)
    apply_parser.add_argument("--extraction-store-path", default=None)
    apply_parser.add_argument("--ledger-path", default=None)
    apply_parser.add_argument("--authorizations-path", required=True)
    apply_parser.add_argument("--canon-root", required=True)
    apply_parser.add_argument("--audit-log", required=True)
    apply_parser.add_argument(
        "--tier",
        action="append",
        choices=sorted(member.value for member in Tier),
        default=None,
    )
    apply_parser.add_argument("--holder", dest="process_holder", default=None)

    queue_parser = subparsers.add_parser("queue", allow_abbrev=False)
    queue_parser.add_argument("--candidate-store-path", required=True)
    queue_parser.add_argument("--audit-log", required=True)

    index_parser = subparsers.add_parser("canon-index", allow_abbrev=False)
    index_parser.add_argument("--canon-root", required=True)
    return parser


def _render(items: Iterable[object]) -> str:
    payload = []
    for item in items:
        method = getattr(item, "as_payload", None)
        if not callable(method):
            raise ReviewError("unrenderable review result")
        payload.append(method())
    return json.dumps(payload, sort_keys=True, allow_nan=False)


def main(argv: list[str] | None = None) -> int:
    """Run the dedicated human console; it is not a Core or stdio operation."""
    namespace = _parser().parse_args(argv)
    try:
        if namespace.command == "apply":
            grant = cli._resolve_grant(namespace, os.environ)
            result = apply(
                decisions_path=Path(namespace.decision_file),
                data_root=Path(namespace.data_root),
                candidate_store_path=Path(namespace.candidate_store_path),
                snapshot_root=Path(namespace.snapshot_root),
                extraction_store_path=(
                    None
                    if namespace.extraction_store_path is None
                    else Path(namespace.extraction_store_path)
                ),
                ledger_path=None if namespace.ledger_path is None else Path(namespace.ledger_path),
                authorizations_path=Path(namespace.authorizations_path),
                canon_root=Path(namespace.canon_root),
                audit_log=Path(namespace.audit_log),
                grant=grant,
            )
        elif namespace.command == "queue":
            result = queue(CandidateStore(Path(namespace.candidate_store_path)), Path(namespace.audit_log))
        else:
            result = canon_index(Path(namespace.canon_root))
        print(_render(result))
        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
