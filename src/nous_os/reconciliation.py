"""Typed, evidence-linked relation proposals kept apart from source memory.

Relations make a narrowly bounded statement about two immutable source
versions.  They do not merge source identities, rewrite source history, or
decide which source is right.  Class-specific construction checks prevent an
otherwise plausible-looking relation from silently claiming a stronger fact
than its evidence can establish.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Iterable

from nous_os.identity import (
    RELATION_PREFIX,
    InvalidIdentifier,
    canonical_bytes,
    digest_bytes,
    digest_payload,
    file_is_present,
    new_relation_id,
    require_id,
)
from nous_os.provenance import Citation, Locator, ProvenanceError, quote_lint
from nous_os.snapshots import SnapshotCorrupt, SnapshotNotFound, SnapshotStore

if TYPE_CHECKING:
    from nous_os.ledger import Ledger


_HEX64 = re.compile(r"[0-9a-f]{64}")

#: Text shorter than this is too slight to mechanically propose a restatement.
MIN_TEXT_CHARS = 40
#: Equal-text groups beyond this many source identities are counted, not expanded.
MAX_GROUP_SOURCES = 12


class RelationError(Exception):
    """Raised when a relation would claim more than its evidence establishes."""


class DuplicateRelation(RelationError):
    """A content-identical relation is already present in the append-only record."""


class UnresolvableRelationEvidence(RelationError):
    """An end or citation cannot be resolved, so recording would preserve a false reference."""


class RelationClass(Enum):
    """The closed kinds of statement one relation proposal may make."""

    SAME_SOURCE = "same_source"
    REVISION = "revision"
    RESTATEMENT = "restatement"
    RELATED = "related"
    CONTRADICTION = "contradiction"
    UNKNOWN = "unknown"


class EvidenceBasis(Enum):
    """The closed bases a relation may declare, never collapsed to a score."""

    PROVIDER_IDENTITY = "provider_identity"
    PROVIDER_ASSIGNED_ID = "provider_assigned_id"
    TEXT_EQUALITY = "text_equality"
    BYTE_EQUALITY = "byte_equality"
    MODEL_JUDGEMENT = "model_judgement"
    LEDGER_LINEAGE = "ledger_lineage"
    COMPARABLE_CLAIMS = "comparable_claims"


class Origin(Enum):
    """How a relation was proposed; origin never changes the relation's standing."""

    MECHANICAL = "mechanical"
    MODEL = "model"
    OPERATOR = "operator"


class Exclusion(Enum):
    """Declared context that prevents a statement from being a contradiction."""

    QUOTATION = "quotation"
    HYPOTHETICAL = "hypothetical"
    CHANGED_REQUIREMENT = "changed_requirement"
    PROVIDER_ROLE = "provider_role"
    BRANCH_ALTERNATIVE = "branch_alternative"


class TemporalBasis(Enum):
    """Which stated clock qualifies one claim in a contradiction proposal."""

    STATED_TIME = "stated_time"
    RECORD_TIME = "record_time"


def _instant(value: datetime, field: str) -> str:
    """Return one timezone-aware instant so equivalent records have one payload form."""
    if type(value) is not datetime:
        raise RelationError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise RelationError(f"{field} must carry a timezone")
    try:
        return value.astimezone(timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise RelationError(f"{field} cannot be normalised to UTC") from error


def _digest(value: object, field: str) -> str:
    """Validate a digest before it reaches a snapshot-store path."""
    if type(value) is not str or not _HEX64.fullmatch(value):
        raise RelationError(f"{field} must be 64 lowercase hex characters: {value!r}")
    return value


def _nonblank(value: object, field: str) -> str:
    if type(value) is not str or not value.strip():
        raise RelationError(f"{field} must be a non-blank string")
    return value


def _enum_tuple(value: object, member_type: type[Enum], field: str) -> tuple[Enum, ...]:
    """Validate a unique closed vocabulary without treating it as an ordered score."""
    if type(value) is not tuple or any(type(member) is not member_type for member in value):
        raise RelationError(f"{field} must be a tuple of {member_type.__name__}")
    if len(set(value)) != len(value):
        raise RelationError(f"{field} must not name one member more than once")
    return tuple(sorted(value, key=lambda member: member.value))


@dataclass(frozen=True, slots=True)
class RelationEnd:
    """One source version at an end of a relation.

    An optional provider label preserves the evidence needed to refuse an
    explicitly cross-provider revision.  It is descriptive provenance only;
    it never changes the source identity named by ``source_id``.
    """

    source_id: str
    snapshot_digest: str
    provider: str | None = None

    def __post_init__(self) -> None:
        if type(self.source_id) is not str:
            raise RelationError("source_id must be a string")
        try:
            require_id(self.source_id, "src")
        except Exception as error:
            raise RelationError(f"source_id is not valid: {error}") from error
        _digest(self.snapshot_digest, "snapshot_digest")
        if self.provider is not None:
            _nonblank(self.provider, "provider")

    def as_payload(self) -> dict[str, object]:
        return {
            "source_id": self.source_id,
            "snapshot_digest": self.snapshot_digest,
            "provider": self.provider,
        }


@dataclass(frozen=True, slots=True)
class Lineage:
    """The earlier digest a revision names, preventing timestamp-as-lineage claims."""

    previous_digest: str

    def __post_init__(self) -> None:
        _digest(self.previous_digest, "previous_digest")

    def as_payload(self) -> dict[str, str]:
        return {"previous_digest": self.previous_digest}


@dataclass(frozen=True, slots=True)
class Claim:
    """One cited claim with its explicitly declared temporal qualification."""

    citation: Citation
    valid_at: datetime
    temporal_basis: TemporalBasis

    def __post_init__(self) -> None:
        if type(self.citation) is not Citation:
            raise RelationError("claim citation must be a Citation")
        _instant(self.valid_at, "claim valid_at")
        if type(self.temporal_basis) is not TemporalBasis:
            raise RelationError("claim temporal_basis must be a TemporalBasis")

    def as_payload(self) -> dict[str, object]:
        return {
            "citation": self.citation.as_payload(),
            "valid_at": _instant(self.valid_at, "claim valid_at"),
            "temporal_basis": self.temporal_basis.value,
        }


@dataclass(frozen=True, slots=True)
class Claims:
    """The two qualified claim citations required for a contradiction proposal."""

    left: Claim
    right: Claim

    def __post_init__(self) -> None:
        if type(self.left) is not Claim or type(self.right) is not Claim:
            raise RelationError("claims must hold one Claim for each end")

    def as_payload(self) -> dict[str, object]:
        return {"left": self.left.as_payload(), "right": self.right.as_payload()}


def _matches_end(citation: Citation, end: RelationEnd) -> bool:
    return citation.source_id == end.source_id and citation.snapshot_digest == end.snapshot_digest


def _citations_for(citations: tuple[Citation, ...], end: RelationEnd) -> tuple[Citation, ...]:
    return tuple(citation for citation in citations if _matches_end(citation, end))


@dataclass(frozen=True, slots=True)
class RelationProposal:
    """An unrecorded typed proposal, with no identity or authority of its own."""

    relation_class: RelationClass
    left: RelationEnd
    right: RelationEnd
    bases: tuple[EvidenceBasis, ...]
    citations: tuple[Citation, ...]
    origin: Origin
    producer: str
    proposed_at: datetime
    scope: str | None = None
    exclusions: tuple[Exclusion, ...] = ()
    lineage: Lineage | None = None
    claims: Claims | None = None
    notes: str = ""

    def __post_init__(self) -> None:
        if type(self.relation_class) is not RelationClass:
            raise RelationError("relation_class must be a RelationClass")
        if type(self.left) is not RelationEnd or type(self.right) is not RelationEnd:
            raise RelationError("left and right must be RelationEnd values")
        if self.left.source_id == self.right.source_id and self.left.snapshot_digest == self.right.snapshot_digest:
            raise RelationError("a relation cannot join the identical source version to itself")
        normalized_bases = _enum_tuple(self.bases, EvidenceBasis, "bases")
        object.__setattr__(self, "bases", normalized_bases)
        if type(self.citations) is not tuple or any(type(citation) is not Citation for citation in self.citations):
            raise RelationError("citations must be a tuple of Citation")
        if len(set(self.citations)) != len(self.citations):
            raise RelationError("citations must not repeat one citation")
        if type(self.origin) is not Origin:
            raise RelationError("origin must be an Origin")
        _nonblank(self.producer, "producer")
        _instant(self.proposed_at, "proposed_at")
        if self.scope is not None:
            _nonblank(self.scope, "scope")
        normalized_exclusions = _enum_tuple(self.exclusions, Exclusion, "exclusions")
        object.__setattr__(self, "exclusions", normalized_exclusions)
        if self.lineage is not None and type(self.lineage) is not Lineage:
            raise RelationError("lineage must be a Lineage or None")
        if self.claims is not None and type(self.claims) is not Claims:
            raise RelationError("claims must be Claims or None")
        if type(self.notes) is not str:
            raise RelationError("notes must be a string")
        self._validate_admissibility()

    def _validate_admissibility(self) -> None:
        bases = frozenset(self.bases)
        has_left_citation = bool(_citations_for(self.citations, self.left))
        has_right_citation = bool(_citations_for(self.citations, self.right))

        if self.relation_class is RelationClass.SAME_SOURCE:
            identity_basis = EvidenceBasis.PROVIDER_IDENTITY in bases
            assigned_and_equal = {
                EvidenceBasis.PROVIDER_ASSIGNED_ID,
                EvidenceBasis.TEXT_EQUALITY,
            }.issubset(bases)
            if not (identity_basis or assigned_and_equal):
                raise RelationError(
                    "SAME_SOURCE requires PROVIDER_IDENTITY or both "
                    "PROVIDER_ASSIGNED_ID and TEXT_EQUALITY"
                )
            if (
                self.left.provider is not None
                and self.right.provider is not None
                and self.left.provider != self.right.provider
            ):
                raise RelationError("SAME_SOURCE cannot join ends from different providers")
            if self.lineage is not None or self.claims is not None:
                raise RelationError("SAME_SOURCE carries neither lineage nor claims")
            return

        if self.relation_class is RelationClass.REVISION:
            if self.left.source_id != self.right.source_id:
                raise RelationError("REVISION requires the same source_id at both ends")
            if (
                self.left.provider is not None
                and self.right.provider is not None
                and self.left.provider != self.right.provider
            ):
                raise RelationError("REVISION cannot join ends from different providers")
            if self.lineage is None:
                raise RelationError("REVISION requires lineage naming the earlier digest")
            if self.lineage.previous_digest != self.left.snapshot_digest:
                raise RelationError("REVISION lineage must name the left earlier digest")
            if not ({EvidenceBasis.LEDGER_LINEAGE, EvidenceBasis.PROVIDER_IDENTITY} & bases):
                raise RelationError("REVISION requires LEDGER_LINEAGE or PROVIDER_IDENTITY")
            if self.claims is not None:
                raise RelationError("REVISION carries lineage, not claims")
            return

        if self.relation_class is RelationClass.RESTATEMENT:
            if self.left.source_id == self.right.source_id:
                raise RelationError("RESTATEMENT requires different source ids")
            if EvidenceBasis.PROVIDER_IDENTITY in bases:
                raise RelationError("RESTATEMENT refuses PROVIDER_IDENTITY; classify as SAME_SOURCE")
            if not ({EvidenceBasis.BYTE_EQUALITY, EvidenceBasis.TEXT_EQUALITY, EvidenceBasis.MODEL_JUDGEMENT} & bases):
                raise RelationError("RESTATEMENT requires BYTE_EQUALITY, TEXT_EQUALITY, or MODEL_JUDGEMENT")
            if not has_left_citation or not has_right_citation:
                raise RelationError("RESTATEMENT requires one citation on each end")
            if self.lineage is not None or self.claims is not None:
                raise RelationError("RESTATEMENT carries neither lineage nor claims")
            return

        if self.relation_class is RelationClass.RELATED:
            if not bases:
                raise RelationError("RELATED requires at least one evidence basis")
            if not has_left_citation or not has_right_citation:
                raise RelationError("RELATED requires one citation on each end")
            if self.lineage is not None or self.claims is not None:
                raise RelationError("RELATED carries neither lineage nor claims")
            return

        if self.relation_class is RelationClass.CONTRADICTION:
            if EvidenceBasis.COMPARABLE_CLAIMS not in bases:
                raise RelationError("CONTRADICTION requires COMPARABLE_CLAIMS")
            if self.exclusions:
                raise RelationError(
                    f"CONTRADICTION refuses exclusion {self.exclusions[0].name}"
                )
            if self.claims is None:
                raise RelationError("CONTRADICTION requires claims")
            if self.scope is None or not self.scope.strip():
                raise RelationError("CONTRADICTION requires a non-blank shared scope")
            if not _matches_end(self.claims.left.citation, self.left):
                raise RelationError("CONTRADICTION left claim citation must name the left end")
            if not _matches_end(self.claims.right.citation, self.right):
                raise RelationError("CONTRADICTION right claim citation must name the right end")
            if self.lineage is not None:
                raise RelationError("CONTRADICTION carries claims, not lineage")
            return

        if self.relation_class is RelationClass.UNKNOWN:
            if not self.notes.strip():
                raise RelationError("UNKNOWN requires notes stating what is not established")
            if self.lineage is not None or self.claims is not None:
                raise RelationError("UNKNOWN carries neither lineage nor claims")
            return

        raise RelationError(f"unhandled relation class: {self.relation_class!r}")  # pragma: no cover

    def all_citations(self) -> tuple[Citation, ...]:
        """Every citation to resolve, including the two claim citations when present."""
        if self.claims is None:
            return self.citations
        return self.citations + (self.claims.left.citation, self.claims.right.citation)

    def as_payload(self) -> dict[str, object]:
        """The canonical proposal shape, before a store mints its record identity."""
        return {
            "relation_class": self.relation_class.value,
            "left": self.left.as_payload(),
            "right": self.right.as_payload(),
            "bases": [basis.value for basis in self.bases],
            "citations": [citation.as_payload() for citation in self.citations],
            "origin": self.origin.value,
            "producer": self.producer,
            "proposed_at": _instant(self.proposed_at, "proposed_at"),
            "scope": self.scope,
            "exclusions": [exclusion.value for exclusion in self.exclusions],
            "lineage": None if self.lineage is None else self.lineage.as_payload(),
            "claims": None if self.claims is None else self.claims.as_payload(),
            "notes": self.notes,
        }

    def recorded(self, relation_id: str) -> Relation:
        """Attach a newly minted id only when the proposal is about to be appended."""
        return Relation(relation_id=relation_id, **self._terms())

    def _terms(self) -> dict[str, object]:
        return {
            "relation_class": self.relation_class,
            "left": self.left,
            "right": self.right,
            "bases": self.bases,
            "citations": self.citations,
            "origin": self.origin,
            "producer": self.producer,
            "proposed_at": self.proposed_at,
            "scope": self.scope,
            "exclusions": self.exclusions,
            "lineage": self.lineage,
            "claims": self.claims,
            "notes": self.notes,
        }

    @classmethod
    def from_payload(cls, payload: object) -> RelationProposal:
        """Read one explicit JSON proposal through the same closed constructors."""
        if type(payload) is not dict or set(payload) != _PROPOSAL_PAYLOAD_KEYS:
            raise RelationError(
                f"relation proposal must have exactly {sorted(_PROPOSAL_PAYLOAD_KEYS)}"
            )
        return cls(**_proposal_terms_from_payload(payload))


@dataclass(frozen=True, slots=True)
class Relation(RelationProposal):
    """One append-only relation record, identified independently of its content."""

    relation_id: str = ""

    def __post_init__(self) -> None:
        RelationProposal.__post_init__(self)
        if type(self.relation_id) is not str:
            raise RelationError("relation_id must be a string")
        try:
            require_id(self.relation_id, RELATION_PREFIX)
        except Exception as error:
            raise RelationError(f"relation_id is not valid: {error}") from error

    def as_payload(self) -> dict[str, object]:
        payload = RelationProposal.as_payload(self)
        return {"relation_id": self.relation_id, **payload}

    def content_payload(self) -> dict[str, object]:
        """Fields that define duplicate content, excluding minted id and proposal instant."""
        payload = self.as_payload()
        del payload["relation_id"]
        del payload["proposed_at"]
        return payload

    @property
    def content_digest(self) -> str:
        return digest_payload(self.content_payload())

    @classmethod
    def from_payload(cls, payload: object) -> Relation:
        if type(payload) is not dict:
            raise RelationError("relation payload must be an object")
        required = frozenset({"relation_id", *_PROPOSAL_PAYLOAD_KEYS})
        if set(payload) != required:
            raise RelationError(f"relation payload must have exactly {sorted(required)}")
        return cls(relation_id=payload["relation_id"], **_proposal_terms_from_payload(payload))


_PROPOSAL_PAYLOAD_KEYS = frozenset(
    {
        "relation_class",
        "left",
        "right",
        "bases",
        "citations",
        "origin",
        "producer",
        "proposed_at",
        "scope",
        "exclusions",
        "lineage",
        "claims",
        "notes",
    }
)


def _citation_from_payload(payload: object, field: str) -> Citation:
    if type(payload) is not dict or set(payload) != {
        "source_id", "snapshot_digest", "start_byte", "end_byte", "span"
    }:
        raise RelationError(f"{field} must be a citation object")
    try:
        return Citation(
            payload["source_id"],
            payload["snapshot_digest"],
            Locator(payload["start_byte"], payload["end_byte"]),
            payload["span"],
        )
    except (InvalidIdentifier, ProvenanceError, TypeError, ValueError) as error:
        raise RelationError(f"{field} is not a valid citation: {error}") from error


def _end_from_payload(payload: object, field: str) -> RelationEnd:
    if type(payload) is not dict or set(payload) != {"source_id", "snapshot_digest", "provider"}:
        raise RelationError(f"{field} must be an end object")
    return RelationEnd(
        source_id=payload["source_id"],
        snapshot_digest=payload["snapshot_digest"],
        provider=payload["provider"],
    )


def _claim_from_payload(payload: object, field: str) -> Claim:
    if type(payload) is not dict or set(payload) != {"citation", "valid_at", "temporal_basis"}:
        raise RelationError(f"{field} must be a claim object")
    if type(payload["valid_at"]) is not str:
        raise RelationError(f"{field}.valid_at must be an instant string")
    try:
        valid_at = datetime.fromisoformat(payload["valid_at"])
        temporal_basis = TemporalBasis(payload["temporal_basis"])
    except (TypeError, ValueError) as error:
        raise RelationError(f"{field} is not valid: {error}") from error
    return Claim(_citation_from_payload(payload["citation"], f"{field}.citation"), valid_at, temporal_basis)


def _proposal_terms_from_payload(payload: object) -> dict[str, object]:
    if type(payload) is not dict or not _PROPOSAL_PAYLOAD_KEYS.issubset(payload):
        raise RelationError(
            f"relation proposal must have exactly {sorted(_PROPOSAL_PAYLOAD_KEYS)}"
        )
    proposal_payload = {key: payload[key] for key in _PROPOSAL_PAYLOAD_KEYS}
    if set(proposal_payload) != _PROPOSAL_PAYLOAD_KEYS:
        raise RelationError(
            f"relation proposal must have exactly {sorted(_PROPOSAL_PAYLOAD_KEYS)}"
        )
    if type(proposal_payload["bases"]) is not list:
        raise RelationError("bases must be an array")
    if type(proposal_payload["citations"]) is not list:
        raise RelationError("citations must be an array")
    if type(proposal_payload["exclusions"]) is not list:
        raise RelationError("exclusions must be an array")
    if type(proposal_payload["proposed_at"]) is not str:
        raise RelationError("proposed_at must be an instant string")
    try:
        relation_class = RelationClass(proposal_payload["relation_class"])
        bases = tuple(EvidenceBasis(value) for value in proposal_payload["bases"])
        origin = Origin(proposal_payload["origin"])
        exclusions = tuple(Exclusion(value) for value in proposal_payload["exclusions"])
        proposed_at = datetime.fromisoformat(proposal_payload["proposed_at"])
    except (TypeError, ValueError) as error:
        raise RelationError(f"relation proposal has an unknown closed value: {error}") from error
    lineage_payload = proposal_payload["lineage"]
    if lineage_payload is None:
        lineage = None
    elif type(lineage_payload) is dict and set(lineage_payload) == {"previous_digest"}:
        lineage = Lineage(lineage_payload["previous_digest"])
    else:
        raise RelationError("lineage must be null or an object with previous_digest")
    claims_payload = proposal_payload["claims"]
    if claims_payload is None:
        claims = None
    elif type(claims_payload) is dict and set(claims_payload) == {"left", "right"}:
        claims = Claims(
            _claim_from_payload(claims_payload["left"], "claims.left"),
            _claim_from_payload(claims_payload["right"], "claims.right"),
        )
    else:
        raise RelationError("claims must be null or an object with left and right")
    return {
        "relation_class": relation_class,
        "left": _end_from_payload(proposal_payload["left"], "left"),
        "right": _end_from_payload(proposal_payload["right"], "right"),
        "bases": bases,
        "citations": tuple(
            _citation_from_payload(citation, f"citations[{index}]")
            for index, citation in enumerate(proposal_payload["citations"])
        ),
        "origin": origin,
        "producer": proposal_payload["producer"],
        "proposed_at": proposed_at,
        "scope": proposal_payload["scope"],
        "exclusions": exclusions,
        "lineage": lineage,
        "claims": claims,
        "notes": proposal_payload["notes"],
    }


class RelationStore:
    """Append-only JSON Lines relation proposals, with evidence checked before append."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        if self._path.exists():
            if not file_is_present(self._path):
                raise RelationError("relation store path exists but is not a regular file")
            if self._path.stat().st_size == 0:
                raise RelationError(
                    "relation store path is zero-byte and contains no relation JSONL records"
                )
            self.relations()

    @property
    def path(self) -> Path:
        return self._path

    @contextlib.contextmanager
    def exclusive(self):
        """Hold the relation-store lock across duplicate detection and append.

        A duplicate check is meaningful only while no other cooperating writer
        can append.  The sibling lock file deliberately follows the ledger's
        POSIX advisory-lock convention; it is released even when validation or
        writing raises.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = os.open(str(self._path) + ".lock", os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
            os.close(handle)

    def record(self, proposal: RelationProposal, snapshots: SnapshotStore) -> Relation:
        """Verify both ends and every quote before appending one new relation.

        All checks complete before the file is opened.  That ordering prevents
        a missing snapshot or a bad span from leaving a partial proposal in an
        otherwise append-only history.
        """
        if type(proposal) is not RelationProposal:
            raise RelationError("record takes a RelationProposal")
        if type(snapshots) is not SnapshotStore:
            raise RelationError("record takes a SnapshotStore")
        self._verify_proposal_evidence(proposal, snapshots)
        # proposed_at is intentionally removed from duplicate content below;
        # the explicit expression keeps the store's comparison independent of
        # callers choosing a different recording instant for the same claim.
        proposal_content = proposal.as_payload()
        del proposal_content["proposed_at"]
        content_digest = digest_payload(proposal_content)
        with self.exclusive():
            if any(record.content_digest == content_digest for record in self.relations()):
                raise DuplicateRelation("a content-identical relation is already recorded")
            relation = proposal.recorded(new_relation_id())
            with self._path.open("ab") as handle:
                handle.write(canonical_bytes(relation.as_payload()) + b"\n")
            return relation

    def relations(
        self,
        *,
        source_id: str | None = None,
        relation_class: RelationClass | None = None,
    ) -> tuple[Relation, ...]:
        """Every stored relation matching the optional source and class filters."""
        if source_id is not None:
            if type(source_id) is not str:
                raise RelationError("source_id filter must be a string or None")
            try:
                require_id(source_id, "src")
            except Exception as error:
                raise RelationError(f"source_id filter is not valid: {error}") from error
        if relation_class is not None and type(relation_class) is not RelationClass:
            raise RelationError("relation_class filter must be a RelationClass or None")
        if not file_is_present(self._path):
            return ()
        try:
            lines = self._path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as error:
            raise RelationError(f"relation store is not readable: {error}") from error
        found: list[Relation] = []
        for number, line in enumerate(lines, start=1):
            try:
                relation = Relation.from_payload(json.loads(line))
            except (RelationError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise RelationError(f"relation line {number} is not readable: {error}") from error
            if source_id is not None and source_id not in {relation.left.source_id, relation.right.source_id}:
                continue
            if relation_class is not None and relation.relation_class is not relation_class:
                continue
            found.append(relation)
        return tuple(found)

    def _verify_proposal_evidence(self, proposal: RelationProposal, snapshots: SnapshotStore) -> None:
        for end in (proposal.left, proposal.right):
            try:
                snapshots.get(end.source_id, end.snapshot_digest)
            except (SnapshotNotFound, SnapshotCorrupt) as error:
                raise UnresolvableRelationEvidence(
                    f"relation end cannot be resolved: {error}"
                ) from error
        for citation in proposal.all_citations():
            try:
                quote_lint(snapshots, citation)
            except (ProvenanceError, SnapshotNotFound, SnapshotCorrupt) as error:
                raise UnresolvableRelationEvidence(
                    f"relation citation cannot be resolved: {error}"
                ) from error

    def verify(self, snapshots: SnapshotStore) -> RelationVerification:
        """Report every unresolvable stored relation without deleting or rewriting one."""
        if type(snapshots) is not SnapshotStore:
            raise RelationError("verify takes a SnapshotStore")
        records = self.relations()
        unresolvable_ids: list[str] = []
        for relation in records:
            try:
                self._verify_proposal_evidence(relation, snapshots)
            except UnresolvableRelationEvidence:
                unresolvable_ids.append(relation.relation_id)
        return RelationVerification(
            total=len(records),
            resolvable=len(records) - len(unresolvable_ids),
            unresolvable=len(unresolvable_ids),
            unresolvable_ids=tuple(unresolvable_ids),
        )


@dataclass(frozen=True, slots=True)
class RelationVerification:
    """Counts from a non-mutating resolution pass over the stored relations."""

    total: int
    resolvable: int
    unresolvable: int
    unresolvable_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if any(type(value) is not int or value < 0 for value in (self.total, self.resolvable, self.unresolvable)):
            raise RelationError("verification counts must be non-negative integers")
        if self.total != self.resolvable + self.unresolvable:
            raise RelationError("verification counts must partition the stored relations")
        if type(self.unresolvable_ids) is not tuple or any(type(value) is not str for value in self.unresolvable_ids):
            raise RelationError("unresolvable_ids must be a tuple of strings")
        if len(self.unresolvable_ids) != self.unresolvable:
            raise RelationError("unresolvable_ids must name every unresolvable relation exactly once")

    def as_payload(self) -> dict[str, object]:
        return {
            "total": self.total,
            "resolvable": self.resolvable,
            "unresolvable": self.unresolvable,
            "unresolvable_ids": list(self.unresolvable_ids),
        }


@dataclass(frozen=True, slots=True)
class TextView:
    """One extracted normalized message text, deliberately separate from adapter payload shapes."""

    source_id: str
    snapshot_digest: str
    provider: str
    text: str

    def __post_init__(self) -> None:
        RelationEnd(self.source_id, self.snapshot_digest, self.provider)
        if type(self.text) is not str:
            raise RelationError("text must be a string")


def lineage_relations(ledger: Ledger) -> tuple[RelationProposal, ...]:
    """Produce one revision proposal for every ledger entry that names a predecessor."""
    relations: list[RelationProposal] = []
    for entry in ledger.entries():
        if entry.previous_digest is None:
            continue
        relations.append(
            RelationProposal(
                relation_class=RelationClass.REVISION,
                left=RelationEnd(entry.source_id, entry.previous_digest),
                right=RelationEnd(entry.source_id, entry.snapshot_digest),
                bases=(EvidenceBasis.LEDGER_LINEAGE,),
                citations=(),
                origin=Origin.MECHANICAL,
                producer="reconciliation.lineage/1",
                proposed_at=entry.recorded_at,
                lineage=Lineage(entry.previous_digest),
            )
        )
    return tuple(relations)


@dataclass(frozen=True, slots=True)
class TextEqualityResult:
    """What one pass of the text producer established, and what it could not.

    ``unlocatable`` counts source versions whose text was equal to another's
    but could not be found verbatim, exactly once, inside their own snapshot
    bytes; ``oversized_groups`` counts equal-text groups larger than the bound.
    Both are counted rather than dropped, because a producer that silently
    emitted fewer proposals than the evidence supports would be reporting
    "no restatement" where it means "did not look".
    """

    proposals: tuple[RelationProposal, ...]
    unlocatable: int
    oversized_groups: int
    short_texts_skipped: int


def _encoded_occurrence(data: bytes, text: str) -> Locator | None:
    """Where ``text``, as canonical JSON encodes it, sits in ``data`` — exactly once."""
    needle = json.dumps(text, ensure_ascii=False)[1:-1].encode("utf-8")
    if not needle:
        return None
    start = data.find(needle)
    if start < 0 or data.find(needle, start + 1) >= 0:
        return None
    return Locator(start_byte=start, end_byte=start + len(needle))


def text_equality_relations(
    records: Iterable[TextView],
    *,
    store: SnapshotStore,
    proposed_at: datetime,
    producer: str = "reconciliation.text-equality/2",
) -> TextEqualityResult:
    """Hash-join equal texts into ``RESTATEMENT`` proposals, each end cited from its own snapshot.

    One pass groups views by the digest of their text; only groups holding
    more than one source id yield anything, and a pair inside a group is
    proposed only when the text is found verbatim, once, in both snapshots'
    canonical bytes — the citation is the encoded occurrence, so it
    quote-lints.  Texts shorter than ``MIN_TEXT_CHARS`` are skipped (a two-word
    reply shared by hundreds of messages is not a restatement of anything)
    and a group larger than ``MAX_GROUP_SOURCES`` is counted, not expanded: the bound
    is what keeps this a join and not a matrix.  Two versions of one source id
    are never paired: that is lineage, not restatement.
    """
    if type(store) is not SnapshotStore:
        raise RelationError("text_equality_relations needs the snapshot store to cite from")
    _instant(proposed_at, "proposed_at")
    by_digest: dict[str, dict[tuple[str, str], TextView] | None] = {}
    short = 0
    oversized = 0
    for record in records:
        if type(record) is not TextView:
            raise RelationError("text_equality_relations takes TextView values")
        if len(record.text) < MIN_TEXT_CHARS:
            short += 1
            continue
        text_digest = digest_bytes(record.text.encode("utf-8"))
        views = by_digest.get(text_digest)
        if views is None and text_digest in by_digest:
            continue
        if views is None:
            views = {}
            by_digest[text_digest] = views
        source_ids = {source_id for source_id, _ in views}
        if record.source_id not in source_ids and len(source_ids) == MAX_GROUP_SOURCES:
            # Do not retain later views for an oversized group: its single
            # count is the answer, and retaining it would defeat the bound.
            views.clear()
            by_digest[text_digest] = None
            oversized += 1
            continue
        key = (record.source_id, record.snapshot_digest)
        present = views.get(key)
        if present is None or record.provider < present.provider:
            views[key] = record
    proposals: list[RelationProposal] = []
    unlocatable = 0
    for text_digest in sorted(by_digest):
        views = by_digest[text_digest]
        if views is None:
            continue
        if len({source_id for source_id, _ in views}) < 2:
            continue
        ordered = sorted(
            views.values(), key=lambda view: (view.source_id, view.snapshot_digest)
        )
        cited: dict[tuple[str, str], Citation] = {}
        for view in ordered:
            try:
                data = store.get(view.source_id, view.snapshot_digest).data
            except (SnapshotNotFound, SnapshotCorrupt):
                unlocatable += 1
                continue
            locator = _encoded_occurrence(data, view.text)
            if locator is None:
                unlocatable += 1
                continue
            cited[(view.source_id, view.snapshot_digest)] = Citation(
                source_id=view.source_id,
                snapshot_digest=view.snapshot_digest,
                locator=locator,
                span=data[locator.start_byte:locator.end_byte].decode("utf-8"),
            )
        with_citation = [
            view
            for view in ordered
            if (view.source_id, view.snapshot_digest) in cited
        ]
        for index, left in enumerate(with_citation):
            for right in with_citation[index + 1:]:
                if left.source_id == right.source_id:
                    continue
                proposals.append(
                    RelationProposal(
                        relation_class=RelationClass.RESTATEMENT,
                        left=RelationEnd(left.source_id, left.snapshot_digest, left.provider),
                        right=RelationEnd(right.source_id, right.snapshot_digest, right.provider),
                        bases=(EvidenceBasis.TEXT_EQUALITY,),
                        citations=(
                            cited[(left.source_id, left.snapshot_digest)],
                            cited[(right.source_id, right.snapshot_digest)],
                        ),
                        origin=Origin.MECHANICAL,
                        producer=producer,
                        proposed_at=proposed_at,
                        notes="equal normalised text in two source versions; restatement asserts nothing about identity",
                    )
                )
    return TextEqualityResult(tuple(proposals), unlocatable, oversized, short)
