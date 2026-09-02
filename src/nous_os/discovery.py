"""Record candidate bridges without pretending that discovery is judgement.

A bridge can be useful before it is accepted, and a failed bridge can be useful
after it is rejected.  This module therefore records both in one append-only
registry.  It supplies only two mechanical checks: whether endpoint text can
be re-found, and whether a supplied co-mention probe finds the link stated
elsewhere.  The remaining gates are recorded human or model judgements in a
closed vocabulary; no heuristic here gets to manufacture them.

The registry is intentionally never compacted in V1.  A later projection
depends on rejected cards retaining their typed trace, while rejection memory
allows a later round to avoid re-adjudicating a cluster already known to fail.
Neither trace proves that a recorded judgement was wise or that supplied terms
were well chosen.  It makes those limits visible instead of laundering them
into a numeric score or an unrecorded decision.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Sequence

from nous_os.adjudication import RejectionMemory
from nous_os.identity import ASSERTION_PREFIX, canonical_bytes, file_is_present, require_id
from nous_os.operations import read_span, search
from nous_os.provenance import (
    Citation,
    Locator,
    LocatorOutOfRange,
    LocatorSplitsCharacter,
    LocatorSplitsGrapheme,
    SnapshotNotText,
    resolves,
)
from nous_os.snapshots import SnapshotCorrupt, SnapshotNotFound, SnapshotStore


class DiscoveryError(Exception):
    """Raised when a discovery record or its append-only representation is invalid."""


class Gate(Enum):
    """The closed bridge rubric; every gate is recorded, even when unknown."""

    G1 = "cross_project"
    G2 = "grounded"
    G3 = "not_already_stated"
    G4 = "non_trivial"
    G5 = "consequential"
    G6 = "survives_noise_objection"


class GateOutcome(Enum):
    """The closed recorded outcomes; unknown is not permission to pass."""

    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"


class Depth(Enum):
    """How the link is described, as a closed label.

    Ordered for readability only.  The order carries **no ordering meaning**:
    these are not ranks, they do not average, and nothing may compare them
    with ``<``.
    """

    OBVIOUS = "obvious"
    MODERATE = "moderate"
    DEEP = "deep"


class EpistemicClass(Enum):
    """The closed ways a bridge's statement can be related to its endpoints."""

    EXPLICIT = "explicit"
    DERIVED = "derived"
    SPECULATIVE = "speculative"


class TrivialityArchetype(Enum):
    """The four named failure classes for the non-triviality judgement gate."""

    COMMODITY_TOOLING = "commodity_tooling"
    GENERIC_PROCESS_OVERLAP = "generic_process_overlap"
    SAME_ECOSYSTEM_BY_DEFINITION = "same_ecosystem_by_definition"
    RESTATED_CROSS_REFERENCE = "restated_cross_reference"


class RoundStatus(Enum):
    """Whether a round actually adjudicated one or more proposed cards."""

    COMPLETE = "complete"
    NOT_RUN = "not_run"


_GATE_MEMBERS = tuple(Gate)
_OUTCOME_MEMBERS = tuple(GateOutcome)
_DEPTH_MEMBERS = tuple(Depth)
_EPISTEMIC_MEMBERS = tuple(EpistemicClass)
_ARCHETYPE_MEMBERS = tuple(TrivialityArchetype)
_ROUND_STATUS_MEMBERS = tuple(RoundStatus)


def _is_member(value: object, members: tuple[Enum, ...]) -> bool:
    """Recognize only declared enum members, excluding uninitialized lookalikes."""
    return any(value is member for member in members)


def _non_blank(value: object, field: str) -> str:
    """Require exact ordinary text before it becomes durable record content."""
    if type(value) is not str or not value.strip():
        raise DiscoveryError(f"{field} must be a non-blank string")
    return value


def _reason(value: object, gate: Gate) -> str:
    """Require a reason whose text can teach the next discovery round."""
    return _non_blank(value, f"reason for {gate.value}")


@dataclass(frozen=True, slots=True)
class GateVector:
    """One complete rubric record, never a partial collection that can pass by vacuity."""

    outcomes: Mapping[Gate, GateOutcome]
    reasons: Mapping[Gate, str]
    triviality: TrivialityArchetype | None = None

    def __post_init__(self) -> None:
        outcomes = self.outcomes
        reasons = self.reasons
        if type(outcomes) not in (dict, MappingProxyType):
            raise DiscoveryError("outcomes must be a mapping")
        if type(reasons) not in (dict, MappingProxyType):
            raise DiscoveryError("reasons must be a mapping")
        normalized: dict[Gate, GateOutcome] = {}
        for gate, outcome in outcomes.items():
            if not _is_member(gate, _GATE_MEMBERS):
                raise DiscoveryError("outcome keys must be declared Gate members")
            if not _is_member(outcome, _OUTCOME_MEMBERS):
                raise DiscoveryError("outcomes must be declared GateOutcome members")
            normalized[gate] = outcome  # type: ignore[assignment]
        normalized = {
            gate: normalized.get(gate, GateOutcome.UNKNOWN) for gate in Gate
        }
        normalized_reasons: dict[Gate, str] = {}
        for gate, reason in reasons.items():
            if not _is_member(gate, _GATE_MEMBERS):
                raise DiscoveryError("reason keys must be declared Gate members")
            normalized_reasons[gate] = _reason(reason, gate)  # type: ignore[arg-type]
        for gate in Gate:
            has_reason = gate in normalized_reasons
            if normalized[gate] is GateOutcome.FAIL and not has_reason:
                raise DiscoveryError(f"failed gate {gate.value} needs a reason")
            if normalized[gate] is not GateOutcome.FAIL and has_reason:
                raise DiscoveryError(f"only a failed gate may carry a reason: {gate.value}")
        if normalized[Gate.G4] is GateOutcome.FAIL:
            if not _is_member(self.triviality, _ARCHETYPE_MEMBERS):
                raise DiscoveryError("a failed non-triviality gate needs a TrivialityArchetype")
        elif self.triviality is not None:
            raise DiscoveryError("a TrivialityArchetype is only allowed for a failed G4")
        object.__setattr__(self, "outcomes", MappingProxyType(normalized))
        object.__setattr__(self, "reasons", MappingProxyType(normalized_reasons))

    def outcome(self, gate: Gate) -> GateOutcome:
        """Return one closed outcome after rejecting a forged gate value."""
        if not _is_member(gate, _GATE_MEMBERS):
            raise DiscoveryError("gate must be a declared Gate member")
        # Normal construction always stores every gate.  Treating a forged or
        # damaged partial mapping as unknown keeps the predicate fail-closed.
        return self.outcomes.get(gate, GateOutcome.UNKNOWN)

    def __hash__(self) -> int:
        """Hash normalized immutable mappings by their closed-enumeration contents."""
        return hash(
            (
                tuple((gate, self.outcome(gate)) for gate in Gate),
                tuple((gate, self.reasons[gate]) for gate in Gate if gate in self.reasons),
                self.triviality,
            )
        )

    @property
    def passes(self) -> bool:
        """Whether every member of the closed rubric was affirmatively recorded."""
        return all(self.outcome(gate) is GateOutcome.PASS for gate in Gate)


@dataclass(frozen=True, slots=True)
class Endpoint:
    """One short, checkable project endpoint for a candidate bridge."""

    project: str
    citation: Citation
    quote: str

    def __post_init__(self) -> None:
        _non_blank(self.project, "project")
        if type(self.citation) is not Citation:
            raise DiscoveryError(
                f"citation must be a Citation, not {type(self.citation).__name__}"
            )
        _non_blank(self.quote, "quote")
        if len(self.quote.split()) > 25:
            raise DiscoveryError("quote must contain at most 25 words")


@dataclass(frozen=True, slots=True)
class BridgeCard:
    """A typed candidate bridge, accepted only when its complete gate vector passes."""

    card_id: str
    cluster_id: str
    left: Endpoint
    right: Endpoint
    epistemic_class: EpistemicClass
    depth: Depth
    non_triviality: str
    consequence: str
    noise_objection: str
    gates: GateVector
    origin_round: int

    def __post_init__(self) -> None:
        try:
            require_id(self.card_id, ASSERTION_PREFIX)
        except Exception as error:
            raise DiscoveryError(f"card_id is not valid: {error}") from error
        _non_blank(self.cluster_id, "cluster_id")
        if type(self.left) is not Endpoint or type(self.right) is not Endpoint:
            raise DiscoveryError("left and right must be exact Endpoint records")
        if not _is_member(self.epistemic_class, _EPISTEMIC_MEMBERS):
            raise DiscoveryError("epistemic_class must be a declared EpistemicClass member")
        if not _is_member(self.depth, _DEPTH_MEMBERS):
            raise DiscoveryError("depth must be a declared Depth member")
        _non_blank(self.non_triviality, "non_triviality")
        _non_blank(self.consequence, "consequence")
        _non_blank(self.noise_objection, "noise_objection")
        if type(self.gates) is not GateVector:
            raise DiscoveryError("gates must be an exact GateVector")
        if type(self.origin_round) is not int or self.origin_round < 1:
            raise DiscoveryError("origin_round must be an int of at least one")

    @property
    def accepted(self) -> bool:
        """Acceptance is exactly the closed gate predicate, with no second rule."""
        return self.gates.passes

    def as_payload(self) -> dict[str, object]:
        """Return the one canonical JSONL representation of this bridge card."""
        return {
            "card_id": self.card_id,
            "cluster_id": self.cluster_id,
            "left": _endpoint_payload(self.left),
            "right": _endpoint_payload(self.right),
            "epistemic_class": self.epistemic_class.value,
            "depth": self.depth.value,
            "non_triviality": self.non_triviality,
            "consequence": self.consequence,
            "noise_objection": self.noise_objection,
            "gates": {
                "outcomes": {gate.value: self.gates.outcome(gate).value for gate in Gate},
                "reasons": {
                    gate.value: self.gates.reasons[gate] for gate in Gate if gate in self.gates.reasons
                },
                "triviality": (
                    None if self.gates.triviality is None else self.gates.triviality.value
                ),
            },
            "origin_round": self.origin_round,
        }


def _endpoint_payload(endpoint: Endpoint) -> dict[str, object]:
    """Build endpoint data from fields after its exact record check."""
    if type(endpoint) is not Endpoint:
        raise DiscoveryError("endpoint must be an exact Endpoint")
    return {
        "project": endpoint.project,
        "citation": endpoint.citation.as_payload(),
        "quote": endpoint.quote,
    }


def _endpoint_from_payload(payload: object) -> Endpoint:
    """Restore one endpoint through the public constructors and their validation."""
    if type(payload) is not dict:
        raise DiscoveryError("endpoint payload must be an object")
    citation_payload = payload["citation"]
    if type(citation_payload) is not dict:
        raise DiscoveryError("citation payload must be an object")
    return Endpoint(
        project=payload["project"],
        citation=Citation(
            source_id=citation_payload["source_id"],
            snapshot_digest=citation_payload["snapshot_digest"],
            locator=Locator(
                citation_payload["start_byte"], citation_payload["end_byte"]
            ),
            span=citation_payload["span"],
        ),
        quote=payload["quote"],
    )


def _card_from_payload(payload: object) -> BridgeCard:
    """Restore one registry row only through the validating public shapes."""
    if type(payload) is not dict:
        raise DiscoveryError("bridge payload must be an object")
    gates_payload = payload["gates"]
    if type(gates_payload) is not dict:
        raise DiscoveryError("gate payload must be an object")
    outcomes_payload = gates_payload["outcomes"]
    reasons_payload = gates_payload["reasons"]
    if type(outcomes_payload) is not dict or type(reasons_payload) is not dict:
        raise DiscoveryError("gate outcomes and reasons must be objects")
    return BridgeCard(
        card_id=payload["card_id"],
        cluster_id=payload["cluster_id"],
        left=_endpoint_from_payload(payload["left"]),
        right=_endpoint_from_payload(payload["right"]),
        epistemic_class=EpistemicClass(payload["epistemic_class"]),
        depth=Depth(payload["depth"]),
        non_triviality=payload["non_triviality"],
        consequence=payload["consequence"],
        noise_objection=payload["noise_objection"],
        gates=GateVector(
            outcomes={Gate(gate): GateOutcome(outcome) for gate, outcome in outcomes_payload.items()},
            reasons={Gate(gate): reason for gate, reason in reasons_payload.items()},
            triviality=(
                None
                if gates_payload["triviality"] is None
                else TrivialityArchetype(gates_payload["triviality"])
            ),
        ),
        origin_round=payload["origin_round"],
    )


class BridgeRegistry:
    """Append-only bridge cards, including rejected cards that later projections need.

    The registry is never emptied or compacted in V1.  Reading returns file
    order so durable history stays distinct from a convenience ordering.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def record(self, card: BridgeCard) -> BridgeCard:
        """Append one exact card in canonical JSONL form and return it unchanged."""
        if type(card) is not BridgeCard:
            raise DiscoveryError(f"card must be a BridgeCard, not {type(card).__name__}")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(card.as_payload()) + b"\n")
        return card

    def cards(self) -> tuple[BridgeCard, ...]:
        """Return every card in file order, without compacting or filtering history."""
        if not file_is_present(self._path):
            return ()
        found: list[BridgeCard] = []
        for number, line in enumerate(self._path.read_text(encoding="utf-8").splitlines(), 1):
            if not line:
                continue
            try:
                found.append(_card_from_payload(json.loads(line)))
            except (DiscoveryError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise DiscoveryError(f"bridge line {number} is not readable: {error}") from error
        return tuple(found)

    def accepted(self) -> tuple[BridgeCard, ...]:
        """Return the accepted partition of the append-only card history."""
        return tuple(card for card in self.cards() if card.accepted)

    def rejected(self) -> tuple[BridgeCard, ...]:
        """Return the rejected partition of the append-only card history."""
        return tuple(card for card in self.cards() if not card.accepted)

    def cluster_ids(self) -> frozenset[str]:
        """Return accepted cluster identifiers only, as the accepted projection."""
        return frozenset(card.cluster_id for card in self.accepted())

    def mined_clusters(self) -> frozenset[str]:
        """Return every cluster that has left a durable card trace, accepted or rejected."""
        return frozenset(card.cluster_id for card in self.cards())


def check_grounded(store: SnapshotStore, endpoint: Endpoint) -> GateOutcome:
    """Mechanically check G2 as PASS, FAIL, or unavailable evidence.

    Missing, corrupt, and non-text snapshots are UNKNOWN because their bytes
    cannot be read as evidence. Out-of-range and split-boundary locators are
    FAIL because the citation itself cannot name the asserted bytes. A
    readable span whose recorded citation or endpoint quote disagrees is FAIL.
    """
    if type(store) is not SnapshotStore:
        raise DiscoveryError("store must be an exact SnapshotStore")
    if type(endpoint) is not Endpoint:
        raise DiscoveryError("endpoint must be an exact Endpoint")
    try:
        citation_resolves = resolves(store, endpoint.citation)
        found = read_span(store, endpoint.citation)
    except (SnapshotNotFound, SnapshotCorrupt, SnapshotNotText):
        return GateOutcome.UNKNOWN
    except (LocatorOutOfRange, LocatorSplitsCharacter, LocatorSplitsGrapheme):
        return GateOutcome.FAIL
    if not citation_resolves or found != endpoint.quote:
        return GateOutcome.FAIL
    return GateOutcome.PASS


def _terms(value: Sequence[str], field: str) -> tuple[str, ...]:
    """Require a supplied non-empty probe instead of deriving terms or passing vacuously."""
    if type(value) not in (tuple, list):
        raise DiscoveryError(f"{field} must be a sequence of terms")
    terms = tuple(value)
    if not terms:
        raise DiscoveryError(f"{field} must not be empty")
    for term in terms:
        _non_blank(term, f"{field} term")
    return terms


def check_not_already_stated(
    derived_path: Path,
    *,
    left_terms: Sequence[str],
    right_terms: Sequence[str],
    endpoint_documents: frozenset[str],
) -> GateOutcome:
    """Mechanically check G3 with supplied co-mention terms and endpoint exclusion."""
    left = _terms(left_terms, "left_terms")
    right = _terms(right_terms, "right_terms")
    if type(endpoint_documents) is not frozenset or any(
        type(document) is not str for document in endpoint_documents
    ):
        raise DiscoveryError("endpoint_documents must be a frozenset of exact strings")
    for left_term in left:
        for right_term in right:
            # FTS whitespace joins terms with AND.  The terms are supplied;
            # this module does not rank, transform, or infer them.
            for hit in search(Path(derived_path), f"{left_term} {right_term}"):
                if hit.source_id not in endpoint_documents:
                    return GateOutcome.FAIL
    return GateOutcome.PASS


@dataclass(frozen=True, slots=True)
class RoundResult:
    """The observable result of one round after exclusion and full disposition."""

    round_number: int
    status: RoundStatus
    proposed: tuple[BridgeCard, ...]
    accepted: tuple[BridgeCard, ...]
    rejected: tuple[BridgeCard, ...]
    skipped: tuple[str, ...]
    undetermined: tuple[BridgeCard, ...] = ()

    def __post_init__(self) -> None:
        if type(self.round_number) is not int or self.round_number < 1:
            raise DiscoveryError("round_number must be an int of at least one")
        if not _is_member(self.status, _ROUND_STATUS_MEMBERS):
            raise DiscoveryError("status must be a declared RoundStatus member")
        for field, cards in (
            ("proposed", self.proposed),
            ("accepted", self.accepted),
            ("rejected", self.rejected),
            ("undetermined", self.undetermined),
        ):
            if type(cards) is not tuple or any(type(card) is not BridgeCard for card in cards):
                raise DiscoveryError(f"{field} must be a tuple of exact BridgeCard records")
        if type(self.skipped) is not tuple:
            raise DiscoveryError("skipped must be a tuple")
        for cluster_id in self.skipped:
            _non_blank(cluster_id, "skipped cluster_id")
        partition = self.accepted + self.rejected + self.undetermined
        if self.status is RoundStatus.COMPLETE and sorted(
            partition, key=_card_sort_key
        ) != sorted(self.proposed, key=_card_sort_key):
            raise DiscoveryError("complete round dispositions must partition proposed cards")
        if self.status is RoundStatus.NOT_RUN and any(
            (self.proposed, self.accepted, self.rejected, self.undetermined)
        ):
            raise DiscoveryError("a not-run round cannot contain proposed cards")


def _card_sort_key(card: BridgeCard) -> tuple[bytes, str]:
    """Give a total content order; card_id breaks otherwise identical-card ties."""
    payload = card.as_payload()
    card_id = payload.pop("card_id")
    return canonical_bytes(payload), card_id


def run_round(
    *,
    round_number: int,
    candidates: Sequence[BridgeCard],
    registry: BridgeRegistry,
    memory: RejectionMemory,
    at: datetime,
    consult_memory: bool = True,
) -> RoundResult:
    """Classify a deterministic round before durable writes.

    All cards are classified before durable writes begin. Recorded cards are
    then written one at a time in canonical content order: a rejected card's
    registry append precedes its memory append, so a write failure can leave
    at most that one card only partially recorded. A card with no failed gate
    is undetermined: absent evidence is neither a rejection nor a mined trace,
    so it is returned without a registry or memory write and remains eligible
    for a later round.
    """
    if type(round_number) is not int or round_number < 1:
        raise DiscoveryError("round_number must be an int of at least one")
    if type(candidates) not in (tuple, list):
        raise DiscoveryError("candidates must be a sequence")
    if any(type(card) is not BridgeCard for card in candidates):
        raise DiscoveryError("candidates must contain exact BridgeCard records")
    if type(registry) is not BridgeRegistry:
        raise DiscoveryError("registry must be an exact BridgeRegistry")
    if type(memory) is not RejectionMemory:
        raise DiscoveryError("memory must be an exact RejectionMemory")
    if type(at) is not datetime:
        raise DiscoveryError("at must be a datetime")
    if at.tzinfo is None or at.tzinfo.utcoffset(at) is None:
        raise DiscoveryError(
            "at must carry a timezone; a naive timestamp means different instants on different machines"
        )
    if type(consult_memory) is not bool:
        raise DiscoveryError("consult_memory must be a bool")

    remembered = memory.rejected_clusters() if consult_memory else frozenset()
    skipped = tuple(card.cluster_id for card in candidates if card.cluster_id in remembered)
    proposed = tuple(card for card in candidates if card.cluster_id not in remembered)
    if not proposed:
        return RoundResult(
            round_number=round_number,
            status=RoundStatus.NOT_RUN,
            proposed=(),
            accepted=(),
            rejected=(),
            undetermined=(),
            skipped=skipped,
        )
    accepted: list[BridgeCard] = []
    rejected: list[BridgeCard] = []
    undetermined: list[BridgeCard] = []
    for card in sorted(proposed, key=_card_sort_key):
        if card.accepted:
            accepted.append(card)
            continue
        if any(card.gates.outcome(gate) is GateOutcome.FAIL for gate in Gate):
            rejected.append(card)
            continue
        undetermined.append(card)

    # Every disposition is known before either append-only store is touched.
    # Keep each card's two appends adjacent to bound a failed memory write to
    # that card, while preserving the durable registry's canonical order.
    for card in sorted(accepted + rejected, key=_card_sort_key):
        registry.record(card)
        if card in rejected:
            failed_gate = next(
                gate for gate in Gate if card.gates.outcome(gate) is GateOutcome.FAIL
            )
            memory.record(
                cluster_id=card.cluster_id,
                failed_gate=failed_gate.value,
                reason=card.gates.reasons[failed_gate],
                round_number=round_number,
                rejected_at=at,
            )
    return RoundResult(
        round_number=round_number,
        status=RoundStatus.COMPLETE,
        proposed=proposed,
        accepted=tuple(accepted),
        rejected=tuple(rejected),
        undetermined=tuple(undetermined),
        skipped=skipped,
    )


def rotation_order(
    registry: BridgeRegistry, candidates: Sequence[BridgeCard]
) -> tuple[BridgeCard, ...]:
    """Put unmined clusters first while preserving caller order inside both groups."""
    if type(registry) is not BridgeRegistry:
        raise DiscoveryError("registry must be an exact BridgeRegistry")
    if type(candidates) not in (tuple, list):
        raise DiscoveryError("candidates must be a sequence")
    if any(type(card) is not BridgeCard for card in candidates):
        raise DiscoveryError("candidates must contain exact BridgeCard records")
    mined = registry.mined_clusters()
    return tuple(card for card in candidates if card.cluster_id not in mined) + tuple(
        card for card in candidates if card.cluster_id in mined
    )
