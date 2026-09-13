"""Human review files, promotion records, and append-only canonical assertions.

This module is intentionally a console-side boundary, not an operation in the
application catalogue.  A proposal remains immutable; a review reads its JSON
content, binds a human decision to its content digest and scope, records the
existing authorization, and only then writes a canonical assertion version.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Final, Iterable, Mapping

import nous_os.operations  # noqa: F401 -- registers the fixed promotion operation
from nous_os import cli
from nous_os.adjudication import AdjudicationError, HumanDecision, PromotionRecord, Verdict
from nous_os.attribution import AttributedKey, KeyOrigin
from nous_os.candidates import CandidateStore, Proposal
from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.capability import Grant, NotAuthorized, Tier, execute, required_tier
from nous_os.derived import CanonDivergence
from nous_os.identity import ASSERTION_PREFIX, canonical_bytes, digest_bytes, require_id
from nous_os.provenance import Citation, Locator, ProvenanceError
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
    }
)
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
    valid_from: datetime | None
    valid_to: datetime | None
    why: str
    producer: str
    batch: str
    supersedes: str | None
    _content_bytes: bytes

    @classmethod
    def from_proposal(cls, proposal: Proposal) -> "ReviewCandidate":
        if type(proposal) is not Proposal:
            raise CandidateRefused("NOT_A_PROPOSAL")
        try:
            payload = json.loads(proposal.content.as_data())
        except json.JSONDecodeError as error:
            raise CandidateRefused("CONTENT_NOT_JSON") from error
        if type(payload) is not dict or set(payload) != _CANDIDATE_FIELDS:
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
        valid_from = _optional_instant(payload["valid_from"], "MALFORMED_VALID_FROM")
        valid_to = _optional_instant(payload["valid_to"], "MALFORMED_VALID_TO")
        if valid_from is not None and valid_to is not None:
            if valid_to.astimezone(timezone.utc) <= valid_from.astimezone(timezone.utc):
                raise CandidateRefused("INVALID_VALIDITY_INTERVAL")
        why = payload["why"]
        if type(why) is not str:
            raise CandidateRefused("MALFORMED_WHY")
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
            valid_from=valid_from,
            valid_to=valid_to,
            why=why,
            producer=producer,
            batch=batch,
            supersedes=supersedes,
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


def _read_decisions(path: Path) -> tuple[ReviewDecision, ...]:
    found: list[ReviewDecision] = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
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
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
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


def _role_word_refused(decider: str) -> bool:
    return any(word in _REFUSED_DECIDER_WORDS for word in _WORD.findall(decider.casefold()))


def _audit_for(decision: ReviewDecision, outcome: str, *, assertion: CanonWrite | None = None) -> AuditEntry:
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
    )


def _canonical_assertion_payload(
    assertion: Assertion,
    *,
    candidate_id: str,
    candidate_version: str,
    promotion_record_digest: str,
    previous_digest: str | None,
) -> dict[str, object]:
    return {
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
    }


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


def _write_assertion(
    *,
    candidate: ReviewCandidate,
    decision: ReviewDecision,
    promotion_record_digest: str,
    canon_root: Path,
) -> CanonWrite:
    previous = _previous_version(candidate, canon_root)
    assertion_id = previous.assertion.id if previous is not None else None
    if assertion_id is None:
        from nous_os.identity import new_assertion_id

        assertion_id = new_assertion_id()
    previous_digest = None if previous is None else previous.content_digest
    assertion = Assertion(
        id=assertion_id,
        text=candidate.statement,
        citation=candidate.anchor,
        support=candidate.support,
        recorded_at=decision.decided_at,
        state=LifecycleState.CANONICAL,
        valid_from=candidate.valid_from,
        valid_to=candidate.valid_to,
    )
    digest = assertion.content_digest
    payload = _canonical_assertion_payload(
        assertion,
        candidate_id=candidate.proposal.proposal_id,
        candidate_version=candidate.version,
        promotion_record_digest=promotion_record_digest,
        previous_digest=previous_digest,
    )
    root = Path(canon_root)
    version_path = root / "assertions" / assertion.id / f"{digest}.json"
    if version_path.exists():
        try:
            existing = json.loads(version_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise CanonDivergence(f"canonical assertion file is unreadable: {version_path}") from error
        if canonical_bytes(existing) != canonical_bytes(payload):
            raise CanonDivergence(f"canonical assertion file diverges: {version_path}")
        return CanonWrite(assertion.id, digest, previous_digest, False)

    version_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with version_path.open("xb") as handle:
            handle.write(canonical_bytes(payload) + b"\n")
    except FileExistsError:
        # A concurrent writer is equivalent only when it wrote these exact bytes.
        return _write_assertion(
            candidate=candidate,
            decision=decision,
            promotion_record_digest=promotion_record_digest,
            canon_root=canon_root,
        )
    index_path = root / "assertions.jsonl"
    index_payload = {
        "assertion_id": assertion.id,
        "content_digest": digest,
        "previous_digest": previous_digest,
        "candidate_id": candidate.proposal.proposal_id,
        "candidate_version": candidate.version,
        "promotion_record_digest": promotion_record_digest,
        "decided_at": _instant_text(decision.decided_at),
    }
    with index_path.open("ab") as handle:
        handle.write(canonical_bytes(index_payload) + b"\n")
    return CanonWrite(assertion.id, digest, previous_digest, True)


def _subject_for(candidate: ReviewCandidate) -> AttributedKey:
    """Bind the explicit scope supplied in the human decision to an operator key."""
    try:
        return AttributedKey(key=ClaimKey(candidate.scope), origin=KeyOrigin.OPERATOR)
    except (ClaimKeyError, ValueError) as error:
        raise ReviewError("NOT_PROMOTABLE") from error


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


def apply(
    *,
    decisions_path: Path,
    data_root: Path,
    candidate_store_path: Path,
    authorizations_path: Path,
    canon_root: Path,
    audit_log: Path,
    grant: Grant,
) -> tuple[AuditEntry, ...]:
    """Apply a decision file in order under a promotion grant.

    ``data_root`` is deliberately an explicit argument even though this writer
    does not open it: its presence prevents a process from selecting a real
    root by an omitted default.
    """
    _require_promote_grant(grant)
    # Resolve the explicit root without opening or creating it.
    Path(data_root).expanduser().resolve()
    decisions = _read_decisions(Path(decisions_path))
    store = CandidateStore(Path(candidate_store_path))
    proposals = {proposal.proposal_id: proposal for proposal in store.proposals()}
    prior_audit = _audit_entries(Path(audit_log))
    known_digests = {entry.decision_digest for entry in prior_audit}
    applied: list[AuditEntry] = []

    for decision in decisions:
        if decision.digest in known_digests:
            # A duplicate produces no new audit line: replay must leave every
            # store byte-identical, including the audit log that detects it.
            applied.append(_audit_for(decision, "DUPLICATE"))
            continue
        proposal = proposals.get(decision.candidate_id)
        candidate: ReviewCandidate | None = None
        outcome: str | None = None
        if proposal is None:
            outcome = "UNKNOWN_CANDIDATE"
        else:
            candidate = ReviewCandidate.from_proposal(proposal)
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
            entry = _audit_for(decision, outcome)
            _append_audit(Path(audit_log), entry)
            known_digests.add(decision.digest)
            applied.append(entry)
            continue

        if candidate is None:  # pragma: no cover - guarded by the candidate lookup above
            raise ReviewError("candidate resolution diverged")
        if decision.verdict != "approve":
            entry = _audit_for(decision, "APPLIED")
            _append_audit(Path(audit_log), entry)
            known_digests.add(decision.digest)
            applied.append(entry)
            continue

        try:
            human_decision = _promotion_decision(candidate, decision)
            record = execute(
                grant,
                "promote_candidate",
                decision=human_decision,
                candidate=candidate.proposal,
                authorizations=Path(authorizations_path),
            )
        except (AdjudicationError, ReviewError, ClaimKeyError) as error:
            entry = _audit_for(decision, "NOT_PROMOTABLE")
            _append_audit(Path(audit_log), entry)
            known_digests.add(decision.digest)
            applied.append(entry)
            continue
        if type(record) is not PromotionRecord:
            raise ReviewError("promotion registry returned an invalid record")
        write = _write_assertion(
            candidate=candidate,
            decision=decision,
            promotion_record_digest=_digest(record.as_payload()),
            canon_root=Path(canon_root),
        )
        entry = _audit_for(decision, "APPLIED", assertion=write)
        _append_audit(Path(audit_log), entry)
        known_digests.add(decision.digest)
        applied.append(entry)
    return tuple(applied)


def _canon_version_from_file(path: Path) -> CanonVersion:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CanonDivergence(f"canonical assertion file is unreadable: {path}") from error
    if type(payload) is not dict or set(payload) != _CANON_FILE_FIELDS:
        raise CanonDivergence(f"canonical assertion file has the wrong shape: {path}")
    try:
        citation_payload = payload["citation"]
        if type(citation_payload) is not dict or set(citation_payload) != _CITATION_FIELDS:
            raise CanonDivergence(f"canonical citation shape diverges: {path}")
        citation = Citation(
            source_id=citation_payload["source_id"],
            snapshot_digest=citation_payload["snapshot_digest"],
            locator=Locator(citation_payload["start_byte"], citation_payload["end_byte"]),
            span=citation_payload["span"],
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


def canon_index(canon_root: Path) -> tuple[CanonVersion, ...]:
    """Rebuild a deterministic verified assertion listing from version files alone."""
    root = Path(canon_root) / "assertions"
    if not root.exists():
        return ()
    if not root.is_dir():
        raise CanonDivergence(f"canonical assertion root is not a directory: {root}")
    paths = sorted(path for path in root.rglob("*.json") if path.is_file())
    versions = tuple(_canon_version_from_file(path) for path in paths)
    _verify_chain(versions)
    return tuple(sorted(versions, key=lambda version: (version.assertion.id, version.content_digest)))


def queue(store: CandidateStore, log: Path) -> tuple[QueueEntry, ...]:
    """List candidates and their latest durable review outcome without writing."""
    if type(store) is not CandidateStore:
        raise ReviewError("QUEUE_REQUIRES_CANDIDATE_STORE")
    latest: dict[tuple[str, str], AuditEntry] = {}
    for entry in _audit_entries(Path(log)):
        latest[(entry.candidate_id, entry.candidate_version)] = entry
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
