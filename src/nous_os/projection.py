"""Renderer-independent knowledge graphs, without selecting a disputed claim."""

from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime, timezone
from enum import Enum
from typing import Final

from nous_os.adjudication import Rejection
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.discovery import (
    BridgeCard,
    Depth,
    DiscoveryError,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    TrivialityArchetype,
)
from nous_os.identity import InvalidIdentifier, canonical_bytes, digest_payload
from nous_os.provenance import Citation, Locator, ProvenanceError
from nous_os.temporal import ClaimKey, Conflict, Overlap, TemporalIndex


SCHEMA_VERSION: Final = "nous-projection-ir/1"


class ProjectionError(Exception):
    """Raised when a projection would cease to be a closed semantic graph."""


class ProjectionIdentityConflict(ProjectionError):
    """Raised when one projection identifier is assigned different content."""


class ProjectionPolicyError(ProjectionError):
    """Raised when a policy contains a dead or incoherent admission rule."""


class NodeKind(Enum):
    """The closed node vocabulary; it does not prescribe presentation."""

    SOURCE = "source"
    SUBJECT = "subject"
    CLUSTER = "cluster"
    ASSERTION = "assertion"
    CONFLICT = "conflict"
    BRIDGE = "bridge"
    REJECTION = "rejection"


class EdgeKind(Enum):
    """The closed relation vocabulary; no relation selects a preferred claim."""

    ABOUT = "about"
    CITES = "cites"
    CONFLICT_MEMBER = "conflict_member"
    BRIDGE_SIDE = "bridge_side"
    IN_CLUSTER = "in_cluster"
    REJECTS = "rejects"


class Side(Enum):
    """The recorded endpoint position, not an ordering or a preference."""

    LEFT = "left"
    RIGHT = "right"


class TemporalDisposition(Enum):
    """The source index's three-way temporal answer, carried without revision."""

    ESTABLISHED = "established"
    EXCLUDED = "excluded"
    UNDETERMINED = "undetermined"


class BridgeDisposition(Enum):
    """The complete gate-vector disposition, not a scalar assessment."""

    ACCEPTED = "accepted"
    REJECTED = "rejected"
    UNDETERMINED = "undetermined"


class PolicyId(Enum):
    """Internal policy identifiers; no user-facing label is claimed here."""

    RELIABILITY = "reliability"
    DISCOVERY = "discovery"
    EXPERIMENTAL = "experimental"


_NODE_KINDS: Final = tuple(NodeKind)
_EDGE_KINDS: Final = tuple(EdgeKind)
_SIDES: Final = tuple(Side)
_TEMPORAL_DISPOSITIONS: Final = tuple(TemporalDisposition)
_BRIDGE_DISPOSITIONS: Final = tuple(BridgeDisposition)
_POLICY_IDS: Final = tuple(PolicyId)
_SUPPORT_CLASSES: Final = tuple(SupportClass)
_LIFECYCLE_STATES: Final = tuple(LifecycleState)
_OVERLAPS: Final = tuple(Overlap)
_EPISTEMIC_CLASSES: Final = tuple(EpistemicClass)
_DEPTHS: Final = tuple(Depth)
_GATES: Final = tuple(Gate)
_GATE_OUTCOMES: Final = tuple(GateOutcome)


def _is_member(value: object, members: tuple[Enum, ...]) -> bool:
    """Recognize declared enum members by identity, never by a lookalike value."""
    return any(value is member for member in members)


def _text(value: object, field: str) -> str:
    if type(value) is not str or not value.strip():
        raise ProjectionError(f"{field} must be a non-blank string")
    return value


def _instant(value: object, field: str) -> str:
    if type(value) is not datetime:
        raise ProjectionError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ProjectionError(f"{field} must carry a timezone")
    try:
        return value.astimezone(timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise ProjectionError(f"{field} cannot be normalised to UTC") from error


def _optional_instant(value: object, field: str) -> datetime | None:
    if value is None:
        return None
    _instant(value, field)
    return value  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class ProvenanceRef:
    """The cited bytes as recorded; this does not establish that they still resolve."""

    source_id: str
    snapshot_digest: str
    start_byte: int
    end_byte: int
    span: str

    def __post_init__(self) -> None:
        _text(self.source_id, "source_id")
        _text(self.snapshot_digest, "snapshot_digest")
        if type(self.start_byte) is not int or type(self.end_byte) is not int:
            raise ProjectionError("citation offsets must be exact ints")
        if self.start_byte < 0 or self.end_byte <= self.start_byte:
            raise ProjectionError("citation offsets must form a non-empty range")
        _text(self.span, "span")


@dataclass(frozen=True, slots=True)
class SourceAttributes:
    """A source identifier only; source metadata is outside this projection."""

    source_id: str

    def __post_init__(self) -> None:
        _text(self.source_id, "source_id")


@dataclass(frozen=True, slots=True)
class SubjectAttributes:
    """One explicit claim key; it is not inferred from assertion text."""

    key: str

    def __post_init__(self) -> None:
        _text(self.key, "key")


@dataclass(frozen=True, slots=True)
class ClusterAttributes:
    """The source's free cluster label, not a validated entity identity."""

    cluster_id: str

    def __post_init__(self) -> None:
        _text(self.cluster_id, "cluster_id")


@dataclass(frozen=True, slots=True)
class AssertionAttributes:
    """Canonical assertion fields plus the index's temporal disposition."""

    assertion_id: str
    text: str
    support: SupportClass
    lifecycle: LifecycleState
    recorded_at: datetime
    valid_from: datetime | None
    valid_to: datetime | None
    provenance: ProvenanceRef
    temporal: TemporalDisposition

    def __post_init__(self) -> None:
        _text(self.assertion_id, "assertion_id")
        _text(self.text, "text")
        if not _is_member(self.support, _SUPPORT_CLASSES):
            raise ProjectionError("support must be a declared SupportClass member")
        if not _is_member(self.lifecycle, _LIFECYCLE_STATES):
            raise ProjectionError("lifecycle must be a declared LifecycleState member")
        # The only store that holds canonical assertions refuses everything else,
        # so an IR claiming otherwise asserts a state the system cannot hold.
        # When a store for non-canonical assertions exists, this check widens with it.
        if self.lifecycle is not LifecycleState.CANONICAL:
            raise ProjectionError("only canonical assertions can be restored")
        _instant(self.recorded_at, "recorded_at")
        _optional_instant(self.valid_from, "valid_from")
        _optional_instant(self.valid_to, "valid_to")
        if self.valid_from is not None and self.valid_to is not None:
            if self.valid_to.astimezone(timezone.utc) <= self.valid_from.astimezone(timezone.utc):
                raise ProjectionError("valid_to must follow valid_from")
        if type(self.provenance) is not ProvenanceRef:
            raise ProjectionError("provenance must be an exact ProvenanceRef")
        if not _is_member(self.temporal, _TEMPORAL_DISPOSITIONS):
            raise ProjectionError("temporal must be a declared TemporalDisposition member")


@dataclass(frozen=True, slots=True)
class ConflictAttributes:
    """A connected conflict and its complete member set, without pairwise claims."""

    subject_key: str
    overlap: Overlap
    members: tuple[str, ...]

    def __post_init__(self) -> None:
        _text(self.subject_key, "subject_key")
        if not _is_member(self.overlap, _OVERLAPS):
            raise ProjectionError("overlap must be a declared Overlap member")
        if type(self.members) is not tuple or len(self.members) < 2:
            raise ProjectionError("conflict members must be a tuple of at least two ids")
        if any(type(member) is not str or not member.strip() for member in self.members):
            raise ProjectionError("conflict members must be exact non-blank strings")
        if tuple(sorted(self.members)) != self.members or len(set(self.members)) != len(self.members):
            raise ProjectionError("conflict members must be unique and sorted")


@dataclass(frozen=True, slots=True)
class BridgeAttributes:
    """A card's full gate evidence; this does not establish that a bridge is useful."""

    card_id: str
    cluster_id: str
    epistemic_class: EpistemicClass
    depth: Depth
    non_triviality: str
    consequence: str
    noise_objection: str
    origin_round: int
    gate_outcomes: tuple[tuple[Gate, GateOutcome], ...]
    gate_reasons: tuple[tuple[Gate, str], ...]
    triviality: str | None
    disposition: BridgeDisposition

    def __post_init__(self) -> None:
        _text(self.card_id, "card_id")
        _text(self.cluster_id, "cluster_id")
        if not _is_member(self.epistemic_class, _EPISTEMIC_CLASSES):
            raise ProjectionError("epistemic_class must be a declared EpistemicClass member")
        if not _is_member(self.depth, _DEPTHS):
            raise ProjectionError("depth must be a declared Depth member")
        _text(self.non_triviality, "non_triviality")
        _text(self.consequence, "consequence")
        _text(self.noise_objection, "noise_objection")
        if type(self.origin_round) is not int or self.origin_round < 1:
            raise ProjectionError("origin_round must be an int of at least one")
        if type(self.gate_outcomes) is not tuple or len(self.gate_outcomes) != len(Gate):
            raise ProjectionError("gate_outcomes must contain every declared Gate")
        for expected, pair in zip(Gate, self.gate_outcomes):
            if type(pair) is not tuple or len(pair) != 2 or pair[0] is not expected:
                raise ProjectionError("gate_outcomes must use closed Gate order")
            if not _is_member(pair[1], _GATE_OUTCOMES):
                raise ProjectionError("gate outcomes must be declared GateOutcome members")
        if type(self.gate_reasons) is not tuple:
            raise ProjectionError("gate_reasons must be a tuple")
        seen: set[Gate] = set()
        for pair in self.gate_reasons:
            if type(pair) is not tuple or len(pair) != 2 or not _is_member(pair[0], _GATES):
                raise ProjectionError("gate reasons must name declared Gate members")
            if pair[0] in seen or pair[0] not in Gate:
                raise ProjectionError("gate reasons must not repeat a gate")
            seen.add(pair[0])
            _text(pair[1], "gate reason")
            outcome = self.gate_outcomes[list(Gate).index(pair[0])][1]
            if outcome is not GateOutcome.FAIL:
                raise ProjectionError("only failed gates may carry reasons")
        if self.triviality is not None:
            _text(self.triviality, "triviality")
        if not _is_member(self.disposition, _BRIDGE_DISPOSITIONS):
            raise ProjectionError("disposition must be a declared BridgeDisposition member")


@dataclass(frozen=True, slots=True)
class RejectionAttributes:
    """A recorded failed gate; it does not decide future candidate quality."""

    cluster_id: str
    failed_gate: str
    reason: str
    round_number: int
    rejected_at: datetime

    def __post_init__(self) -> None:
        _text(self.cluster_id, "cluster_id")
        _text(self.failed_gate, "failed_gate")
        _text(self.reason, "reason")
        if type(self.round_number) is not int or self.round_number < 1:
            raise ProjectionError("round_number must be an int of at least one")
        _instant(self.rejected_at, "rejected_at")


@dataclass(frozen=True, slots=True)
class _BridgeSideAttributes:
    side: Side
    project: str
    quote: str
    provenance: ProvenanceRef

    def __post_init__(self) -> None:
        if not _is_member(self.side, _SIDES):
            raise ProjectionError("side must be a declared Side member")
        _text(self.project, "project")
        _text(self.quote, "quote")
        if type(self.provenance) is not ProvenanceRef:
            raise ProjectionError("side provenance must be an exact ProvenanceRef")


_NODE_ATTRIBUTES: Final = {
    NodeKind.SOURCE: SourceAttributes,
    NodeKind.SUBJECT: SubjectAttributes,
    NodeKind.CLUSTER: ClusterAttributes,
    NodeKind.ASSERTION: AssertionAttributes,
    NodeKind.CONFLICT: ConflictAttributes,
    NodeKind.BRIDGE: BridgeAttributes,
    NodeKind.REJECTION: RejectionAttributes,
}
_EDGE_ATTRIBUTES: Final = {
    EdgeKind.ABOUT: type(None),
    EdgeKind.CITES: ProvenanceRef,
    EdgeKind.CONFLICT_MEMBER: type(None),
    EdgeKind.BRIDGE_SIDE: _BridgeSideAttributes,
    EdgeKind.IN_CLUSTER: type(None),
    EdgeKind.REJECTS: type(None),
}


@dataclass(frozen=True, slots=True)
class ProjectionNode:
    """One typed graph node; its attributes must match its declared kind exactly."""

    id: str
    kind: NodeKind
    attributes: object

    def __post_init__(self) -> None:
        _text(self.id, "node id")
        if not _is_member(self.kind, _NODE_KINDS):
            raise ProjectionError("node kind must be a declared NodeKind member")
        if type(self.attributes) is not _NODE_ATTRIBUTES[self.kind]:
            raise ProjectionError("node attributes do not match node kind")


@dataclass(frozen=True, slots=True)
class ProjectionEdge:
    """One typed directed graph edge; it does not carry display instructions."""

    id: str
    kind: EdgeKind
    source: str
    target: str
    attributes: object

    def __post_init__(self) -> None:
        _text(self.id, "edge id")
        if not _is_member(self.kind, _EDGE_KINDS):
            raise ProjectionError("edge kind must be a declared EdgeKind member")
        _text(self.source, "edge source")
        _text(self.target, "edge target")
        if type(self.attributes) is not _EDGE_ATTRIBUTES[self.kind]:
            raise ProjectionError("edge attributes do not match edge kind")


@dataclass(frozen=True, slots=True)
class TemporalQuestion:
    """The two supplied temporal axes; no current time is supplied implicitly."""

    valid_at: datetime | None = None
    recorded_as_of: datetime | None = None

    def __post_init__(self) -> None:
        _optional_instant(self.valid_at, "valid_at")
        _optional_instant(self.recorded_as_of, "recorded_as_of")


@dataclass(frozen=True, slots=True)
class KnowledgeState:
    """Projection inputs read once; this does not make the mutable index thread-safe."""

    index: TemporalIndex
    bridges: tuple[BridgeCard, ...] = ()
    rejections: tuple[Rejection, ...] = ()

    def __post_init__(self) -> None:
        if type(self.index) is not TemporalIndex:
            raise ProjectionError("index must be an exact TemporalIndex")
        if type(self.bridges) is not tuple or any(type(card) is not BridgeCard for card in self.bridges):
            raise ProjectionError("bridges must be a tuple of exact BridgeCard records")
        if type(self.rejections) is not tuple or any(
            type(rejection) is not Rejection for rejection in self.rejections
        ):
            raise ProjectionError("rejections must be a tuple of exact Rejection records")


@dataclass(frozen=True, slots=True)
class ProjectionPolicy:
    """An omission policy; it cannot change graph semantics or temporal answers."""

    policy_id: PolicyId
    admit_kinds: frozenset[NodeKind]
    admit_temporal: frozenset[TemporalDisposition]
    admit_bridge_dispositions: frozenset[BridgeDisposition]
    admit_epistemic: frozenset[EpistemicClass]

    def __post_init__(self) -> None:
        if not _is_member(self.policy_id, _POLICY_IDS):
            raise ProjectionPolicyError("policy_id must be a declared PolicyId member")
        for name, value, members in (
            ("admit_kinds", self.admit_kinds, _NODE_KINDS),
            ("admit_temporal", self.admit_temporal, _TEMPORAL_DISPOSITIONS),
            ("admit_bridge_dispositions", self.admit_bridge_dispositions, _BRIDGE_DISPOSITIONS),
            ("admit_epistemic", self.admit_epistemic, _EPISTEMIC_CLASSES),
        ):
            if type(value) is not frozenset or not all(_is_member(item, members) for item in value):
                raise ProjectionPolicyError(f"{name} must be a frozenset of declared members")
        if NodeKind.SOURCE not in self.admit_kinds:
            raise ProjectionPolicyError("SOURCE must be admitted by kind")
        if NodeKind.ASSERTION in self.admit_kinds and NodeKind.SUBJECT not in self.admit_kinds:
            raise ProjectionPolicyError("ASSERTION admission requires SUBJECT admission")
        if NodeKind.CONFLICT in self.admit_kinds and NodeKind.ASSERTION not in self.admit_kinds:
            raise ProjectionPolicyError("CONFLICT admission requires ASSERTION admission")
        if NodeKind.BRIDGE in self.admit_kinds and NodeKind.CLUSTER not in self.admit_kinds:
            raise ProjectionPolicyError("BRIDGE admission requires CLUSTER admission")
        if NodeKind.REJECTION in self.admit_kinds and NodeKind.CLUSTER not in self.admit_kinds:
            raise ProjectionPolicyError("REJECTION admission requires CLUSTER admission")
        bridges_admitted = NodeKind.BRIDGE in self.admit_kinds
        if bridges_admitted != bool(self.admit_bridge_dispositions) or bridges_admitted != bool(
            self.admit_epistemic
        ):
            raise ProjectionPolicyError("bridge admission and both bridge predicates must agree")
        if not self.admit_temporal:
            raise ProjectionPolicyError("admit_temporal must not be empty")


ALL_TIME: Final = TemporalQuestion()
RELIABILITY: Final = ProjectionPolicy(
    PolicyId.RELIABILITY,
    frozenset({NodeKind.SOURCE, NodeKind.SUBJECT, NodeKind.ASSERTION, NodeKind.CONFLICT}),
    frozenset({TemporalDisposition.ESTABLISHED}),
    frozenset(),
    frozenset(),
)
DISCOVERY: Final = ProjectionPolicy(
    PolicyId.DISCOVERY,
    frozenset(NodeKind),
    frozenset(TemporalDisposition),
    frozenset(BridgeDisposition),
    frozenset(EpistemicClass),
)


def _provenance(citation: Citation) -> ProvenanceRef:
    if type(citation) is not Citation or type(citation.locator) is not Locator:
        raise ProjectionError("citation must be an exact Citation with an exact Locator")
    return ProvenanceRef(
        citation.source_id,
        citation.snapshot_digest,
        citation.locator.start_byte,
        citation.locator.end_byte,
        citation.span,
    )


def _bridge_disposition(card: BridgeCard | GateVector) -> BridgeDisposition:
    gates = card.gates if type(card) is BridgeCard else card
    if gates.passes:
        return BridgeDisposition.ACCEPTED
    if any(gates.outcome(gate) is GateOutcome.FAIL for gate in Gate):
        return BridgeDisposition.REJECTED
    return BridgeDisposition.UNDETERMINED


def _node_payload(node: ProjectionNode) -> dict[str, object]:
    return {"id": node.id, "kind": node.kind.value, "attributes": _attributes_payload(node.attributes)}


def _edge_payload(edge: ProjectionEdge) -> dict[str, object]:
    return {
        "id": edge.id,
        "kind": edge.kind.value,
        "source": edge.source,
        "target": edge.target,
        "attributes": _attributes_payload(edge.attributes),
    }


def _attributes_payload(attributes: object) -> object:
    if attributes is None:
        return None
    if type(attributes) is ProvenanceRef:
        return {
            "source_id": attributes.source_id,
            "snapshot_digest": attributes.snapshot_digest,
            "start_byte": attributes.start_byte,
            "end_byte": attributes.end_byte,
            "span": attributes.span,
        }
    if type(attributes) is SourceAttributes:
        return {"source_id": attributes.source_id}
    if type(attributes) is SubjectAttributes:
        return {"key": attributes.key}
    if type(attributes) is ClusterAttributes:
        return {"cluster_id": attributes.cluster_id}
    if type(attributes) is AssertionAttributes:
        return {
            "assertion_id": attributes.assertion_id,
            "text": attributes.text,
            "support": attributes.support.value,
            "lifecycle": attributes.lifecycle.value,
            "recorded_at": _instant(attributes.recorded_at, "recorded_at"),
            "valid_from": None if attributes.valid_from is None else _instant(attributes.valid_from, "valid_from"),
            "valid_to": None if attributes.valid_to is None else _instant(attributes.valid_to, "valid_to"),
            "provenance": _attributes_payload(attributes.provenance),
            "temporal": attributes.temporal.value,
        }
    if type(attributes) is ConflictAttributes:
        return {
            "subject_key": attributes.subject_key,
            "overlap": attributes.overlap.value,
            "members": list(attributes.members),
        }
    if type(attributes) is BridgeAttributes:
        return {
            "card_id": attributes.card_id,
            "cluster_id": attributes.cluster_id,
            "epistemic_class": attributes.epistemic_class.value,
            "depth": attributes.depth.value,
            "non_triviality": attributes.non_triviality,
            "consequence": attributes.consequence,
            "noise_objection": attributes.noise_objection,
            "origin_round": attributes.origin_round,
            "gate_outcomes": [[gate.value, outcome.value] for gate, outcome in attributes.gate_outcomes],
            "gate_reasons": [[gate.value, reason] for gate, reason in attributes.gate_reasons],
            "triviality": attributes.triviality,
            "disposition": attributes.disposition.value,
        }
    if type(attributes) is RejectionAttributes:
        return {
            "cluster_id": attributes.cluster_id,
            "failed_gate": attributes.failed_gate,
            "reason": attributes.reason,
            "round_number": attributes.round_number,
            "rejected_at": _instant(attributes.rejected_at, "rejected_at"),
        }
    if type(attributes) is _BridgeSideAttributes:
        return {
            "side": attributes.side.value,
            "project": attributes.project,
            "quote": attributes.quote,
            "provenance": _attributes_payload(attributes.provenance),
        }
    raise ProjectionError("unknown projection attribute record")


@dataclass(frozen=True, slots=True)
class ProjectionIR:
    """A closed graph snapshot; it does not prove source truth or renderer sufficiency."""

    schema_version: str
    policy_id: PolicyId
    question: TemporalQuestion
    nodes: tuple[ProjectionNode, ...]
    edges: tuple[ProjectionEdge, ...]

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise ProjectionError(f"unsupported schema version: {self.schema_version!r}")
        if not _is_member(self.policy_id, _POLICY_IDS):
            raise ProjectionError("policy_id must be a declared PolicyId member")
        if type(self.question) is not TemporalQuestion:
            raise ProjectionError("question must be an exact TemporalQuestion")
        if type(self.nodes) is not tuple or any(type(node) is not ProjectionNode for node in self.nodes):
            raise ProjectionError("nodes must be a tuple of exact ProjectionNode records")
        if type(self.edges) is not tuple or any(type(edge) is not ProjectionEdge for edge in self.edges):
            raise ProjectionError("edges must be a tuple of exact ProjectionEdge records")
        node_ids = [node.id for node in self.nodes]
        edge_ids = [edge.id for edge in self.edges]
        if len(set(node_ids)) != len(node_ids):
            raise ProjectionIdentityConflict("projection node identifiers must be unique")
        if len(set(edge_ids)) != len(edge_ids):
            raise ProjectionIdentityConflict("projection edge identifiers must be unique")
        nodes = {node.id: node for node in self.nodes}
        for node in self.nodes:
            if node.kind is NodeKind.SOURCE and node.id != f"source:{node.attributes.source_id}":  # type: ignore[union-attr]
                raise ProjectionError("source node id must agree with source_id")
            if node.kind is NodeKind.SUBJECT and node.id != f"subject:{node.attributes.key}":  # type: ignore[union-attr]
                raise ProjectionError("subject node id must agree with key")
            if node.kind is NodeKind.CLUSTER and node.id != f"cluster:{node.attributes.cluster_id}":  # type: ignore[union-attr]
                raise ProjectionError("cluster node id must agree with cluster_id")
            if node.kind is NodeKind.ASSERTION and node.id != f"assertion:{node.attributes.assertion_id}":  # type: ignore[union-attr]
                raise ProjectionError("assertion node id must agree with assertion_id")
            if node.kind is NodeKind.BRIDGE and node.id != f"bridge:{node.attributes.card_id}":  # type: ignore[union-attr]
                raise ProjectionError("bridge node id must agree with card_id")
        signatures = {
            EdgeKind.ABOUT: (NodeKind.ASSERTION, NodeKind.SUBJECT),
            EdgeKind.CITES: (NodeKind.ASSERTION, NodeKind.SOURCE),
            EdgeKind.CONFLICT_MEMBER: (NodeKind.CONFLICT, NodeKind.ASSERTION),
            EdgeKind.BRIDGE_SIDE: (NodeKind.BRIDGE, NodeKind.SOURCE),
            EdgeKind.IN_CLUSTER: (NodeKind.BRIDGE, NodeKind.CLUSTER),
            EdgeKind.REJECTS: (NodeKind.REJECTION, NodeKind.CLUSTER),
        }
        for edge in self.edges:
            if edge.source not in nodes or edge.target not in nodes:
                raise ProjectionError(f"edge {edge.id} has an absent endpoint")
            expected_source, expected_target = signatures[edge.kind]
            if nodes[edge.source].kind is not expected_source or nodes[edge.target].kind is not expected_target:
                raise ProjectionError(f"edge {edge.id} has endpoint kinds inconsistent with {edge.kind.value}")
        incident = {node.id: 0 for node in self.nodes}
        for edge in self.edges:
            incident[edge.source] += 1
            incident[edge.target] += 1
        for node in self.nodes:
            if node.kind in (NodeKind.SOURCE, NodeKind.SUBJECT, NodeKind.CLUSTER) and not incident[node.id]:
                raise ProjectionError(f"referent node {node.id} has no incident edge")
        self._validate_cardinality(nodes)

    def _validate_cardinality(self, nodes: dict[str, ProjectionNode]) -> None:
        outgoing = {node_id: [] for node_id in nodes}
        for edge in self.edges:
            outgoing[edge.source].append(edge)
        for node in self.nodes:
            edges = outgoing[node.id]
            if node.kind is NodeKind.ASSERTION:
                about = [edge for edge in edges if edge.kind is EdgeKind.ABOUT]
                cites = [edge for edge in edges if edge.kind is EdgeKind.CITES]
                if len(edges) != 2 or len(about) != 1 or len(cites) != 1:
                    raise ProjectionError(f"assertion {node.id} must have one ABOUT and one CITES edge")
                assertion = node.attributes
                if cites[0].attributes != assertion.provenance:  # type: ignore[union-attr]
                    raise ProjectionError("CITES provenance must equal assertion provenance")
            elif node.kind is NodeKind.CONFLICT:
                members = node.attributes.members  # type: ignore[union-attr]
                actual = [edge for edge in edges if edge.kind is EdgeKind.CONFLICT_MEMBER]
                expected_targets = {f"assertion:{member}" for member in members}
                if len(edges) != len(members) or {edge.target for edge in actual} != expected_targets:
                    raise ProjectionError(f"conflict {node.id} must retain every member edge")
            elif node.kind is NodeKind.BRIDGE:
                sides = [edge for edge in edges if edge.kind is EdgeKind.BRIDGE_SIDE]
                clusters = [edge for edge in edges if edge.kind is EdgeKind.IN_CLUSTER]
                if len(edges) != 3 or len(sides) != 2 or len(clusters) != 1:
                    raise ProjectionError(f"bridge {node.id} must have two sides and one cluster edge")
                side_values = {edge.attributes.side for edge in sides}  # type: ignore[union-attr]
                if side_values != {Side.LEFT, Side.RIGHT}:
                    raise ProjectionError("bridge sides must contain one LEFT and one RIGHT")
                if clusters[0].target != f"cluster:{node.attributes.cluster_id}":  # type: ignore[union-attr]
                    raise ProjectionError("IN_CLUSTER must name the bridge cluster")
            elif node.kind is NodeKind.REJECTION:
                rejects = [edge for edge in edges if edge.kind is EdgeKind.REJECTS]
                if len(edges) != 1 or len(rejects) != 1:
                    raise ProjectionError(f"rejection {node.id} must have one REJECTS edge")

    def as_payload(self) -> dict[str, object]:
        """Return the complete wire form, with enums and instants already encoded."""
        return {
            "schema_version": self.schema_version,
            "policy_id": self.policy_id.value,
            "question": {
                "valid_at": None if self.question.valid_at is None else _instant(self.question.valid_at, "valid_at"),
                "recorded_as_of": (
                    None
                    if self.question.recorded_as_of is None
                    else _instant(self.question.recorded_as_of, "recorded_as_of")
                ),
            },
            "nodes": [_node_payload(node) for node in sorted(self.nodes, key=lambda node: node.id)],
            "edges": [_edge_payload(edge) for edge in sorted(self.edges, key=lambda edge: edge.id)],
        }

    @property
    def ir_digest(self) -> str:
        """sha256 over the canonical wire form, not a tamper seal over source stores."""
        return digest_payload(self.as_payload())


def _add_node(nodes: dict[str, ProjectionNode], node: ProjectionNode) -> None:
    prior = nodes.get(node.id)
    if prior is None:
        nodes[node.id] = node
    elif canonical_bytes(_node_payload(prior)) != canonical_bytes(_node_payload(node)):
        raise ProjectionIdentityConflict(f"node id {node.id!r} names different content")


def _add_edge(edges: dict[str, ProjectionEdge], edge: ProjectionEdge) -> None:
    prior = edges.get(edge.id)
    if prior is None:
        edges[edge.id] = edge
    elif canonical_bytes(_edge_payload(prior)) != canonical_bytes(_edge_payload(edge)):
        raise ProjectionIdentityConflict(f"edge id {edge.id!r} names different content")


def _read_state(
    state: KnowledgeState, question: TemporalQuestion
) -> tuple[tuple[ClaimKey, ...], tuple[tuple[Assertion, ...], ...], object, tuple[Conflict, ...]]:
    if type(state) is not KnowledgeState:
        raise ProjectionError("state must be an exact KnowledgeState")
    if type(question) is not TemporalQuestion:
        raise ProjectionError("question must be an exact TemporalQuestion")
    keys = state.index.keys()
    assertions = tuple(state.index.assertions(key) for key in keys)
    answer = state.index.as_of(valid_at=question.valid_at, recorded_as_of=question.recorded_as_of)
    conflicts = state.index.conflicts()
    return keys, assertions, answer, conflicts


def substrate(state: KnowledgeState, *, question: TemporalQuestion = ALL_TIME) -> ProjectionIR:
    """Read all input once and emit the full graph; this does not make the index thread-safe."""
    keys, assertion_groups, answer, conflicts = _read_state(state, question)
    dispositions: dict[str, TemporalDisposition] = {}
    for disposition, assertions in (
        (TemporalDisposition.ESTABLISHED, answer.established),
        (TemporalDisposition.EXCLUDED, answer.excluded),
        (TemporalDisposition.UNDETERMINED, answer.undetermined),
    ):
        for assertion in assertions:
            if type(assertion) is not Assertion:
                raise ProjectionError("temporal answer must contain exact Assertion records")
            prior = dispositions.get(assertion.id)
            if prior is not None and prior is not disposition:
                raise ProjectionError("one assertion cannot have two temporal dispositions")
            dispositions[assertion.id] = disposition
    nodes: dict[str, ProjectionNode] = {}
    edges: dict[str, ProjectionEdge] = {}
    for key, assertions in zip(keys, assertion_groups):
        _add_node(nodes, ProjectionNode(f"subject:{key.value}", NodeKind.SUBJECT, SubjectAttributes(key.value)))
        for assertion in assertions:
            if type(assertion) is not Assertion:
                raise ProjectionError("index assertions must be exact Assertion records")
            provenance = _provenance(assertion.citation)
            temporal = dispositions.get(assertion.id)
            if temporal is None:
                raise ProjectionError("index temporal answer omitted an assertion")
            assertion_node = f"assertion:{assertion.id}"
            source_node = f"source:{provenance.source_id}"
            _add_node(
                nodes,
                ProjectionNode(
                    assertion_node,
                    NodeKind.ASSERTION,
                    AssertionAttributes(
                        assertion.id,
                        assertion.text,
                        assertion.support,
                        assertion.state,
                        assertion.recorded_at,
                        assertion.valid_from,
                        assertion.valid_to,
                        provenance,
                        temporal,
                    ),
                ),
            )
            _add_node(nodes, ProjectionNode(source_node, NodeKind.SOURCE, SourceAttributes(provenance.source_id)))
            _add_edge(edges, ProjectionEdge(f"about:{assertion.id}", EdgeKind.ABOUT, assertion_node, f"subject:{key.value}", None))
            _add_edge(edges, ProjectionEdge(f"cites:{assertion.id}", EdgeKind.CITES, assertion_node, source_node, provenance))
    for conflict in conflicts:
        if type(conflict) is not Conflict:
            raise ProjectionError("index conflicts must be exact Conflict records")
        members = tuple(sorted(member.id for member in conflict.members))
        conflict_id = f"conflict:{digest_payload({'subject': conflict.key.value, 'members': list(members)})}"
        _add_node(
            nodes,
            ProjectionNode(
                conflict_id,
                NodeKind.CONFLICT,
                ConflictAttributes(conflict.key.value, conflict.overlap, members),
            ),
        )
        for member in members:
            _add_edge(
                edges,
                ProjectionEdge(
                    f"member:{conflict_id}:{member}",
                    EdgeKind.CONFLICT_MEMBER,
                    conflict_id,
                    f"assertion:{member}",
                    None,
                ),
            )
    for card in state.bridges:
        attributes = BridgeAttributes(
            card.card_id,
            card.cluster_id,
            card.epistemic_class,
            card.depth,
            card.non_triviality,
            card.consequence,
            card.noise_objection,
            card.origin_round,
            tuple((gate, card.gates.outcome(gate)) for gate in Gate),
            tuple((gate, card.gates.reasons[gate]) for gate in Gate if gate in card.gates.reasons),
            None if card.gates.triviality is None else card.gates.triviality.value,
            _bridge_disposition(card),
        )
        bridge_node = f"bridge:{card.card_id}"
        _add_node(nodes, ProjectionNode(bridge_node, NodeKind.BRIDGE, attributes))
        _add_node(nodes, ProjectionNode(f"cluster:{card.cluster_id}", NodeKind.CLUSTER, ClusterAttributes(card.cluster_id)))
        _add_edge(edges, ProjectionEdge(f"in-cluster:{card.card_id}", EdgeKind.IN_CLUSTER, bridge_node, f"cluster:{card.cluster_id}", None))
        for side, endpoint in ((Side.LEFT, card.left), (Side.RIGHT, card.right)):
            if type(endpoint) is not Endpoint:
                raise ProjectionError("bridge endpoints must be exact Endpoint records")
            provenance = _provenance(endpoint.citation)
            source_node = f"source:{provenance.source_id}"
            _add_node(nodes, ProjectionNode(source_node, NodeKind.SOURCE, SourceAttributes(provenance.source_id)))
            _add_edge(
                edges,
                ProjectionEdge(
                    f"side:{card.card_id}:{side.value}",
                    EdgeKind.BRIDGE_SIDE,
                    bridge_node,
                    source_node,
                    _BridgeSideAttributes(side, endpoint.project, endpoint.quote, provenance),
                ),
            )
    for rejection in state.rejections:
        attributes = RejectionAttributes(
            rejection.cluster_id,
            rejection.failed_gate,
            rejection.reason,
            rejection.round_number,
            rejection.rejected_at,
        )
        rejection_id = f"rejection:{digest_payload(rejection.as_payload())}"
        _add_node(nodes, ProjectionNode(rejection_id, NodeKind.REJECTION, attributes))
        _add_node(
            nodes,
            ProjectionNode(f"cluster:{rejection.cluster_id}", NodeKind.CLUSTER, ClusterAttributes(rejection.cluster_id)),
        )
        _add_edge(
            edges,
            ProjectionEdge(
                f"rejects:{rejection_id}",
                EdgeKind.REJECTS,
                rejection_id,
                f"cluster:{rejection.cluster_id}",
                None,
            ),
        )
    return ProjectionIR(
        SCHEMA_VERSION,
        PolicyId.DISCOVERY,
        question,
        tuple(sorted(nodes.values(), key=lambda node: node.id)),
        tuple(sorted(edges.values(), key=lambda edge: edge.id)),
    )


def _admit_node(node: ProjectionNode, policy: ProjectionPolicy) -> bool:
    if node.kind not in policy.admit_kinds:
        return False
    if node.kind is NodeKind.ASSERTION:
        return node.attributes.temporal in policy.admit_temporal  # type: ignore[union-attr]
    if node.kind is NodeKind.BRIDGE:
        attributes = node.attributes
        return (
            attributes.disposition in policy.admit_bridge_dispositions  # type: ignore[union-attr]
            and attributes.epistemic_class in policy.admit_epistemic  # type: ignore[union-attr]
        )
    return True


def _filter(ir: ProjectionIR, policy: ProjectionPolicy) -> ProjectionIR:
    if type(ir) is not ProjectionIR:
        raise ProjectionError("filter input must be an exact ProjectionIR")
    if type(policy) is not ProjectionPolicy:
        raise ProjectionPolicyError("policy must be an exact ProjectionPolicy")
    admitted = {node.id for node in ir.nodes if _admit_node(node, policy)}
    for node in ir.nodes:
        if node.kind is not NodeKind.CONFLICT or node.id not in admitted:
            continue
        members = node.attributes.members  # type: ignore[union-attr]
        if any(f"assertion:{member}" not in admitted for member in members):
            admitted.remove(node.id)
    edges = tuple(
        edge for edge in ir.edges if edge.source in admitted and edge.target in admitted
    )
    incident = {node_id: 0 for node_id in admitted}
    for edge in edges:
        incident[edge.source] += 1
        incident[edge.target] += 1
    admitted = {
        node_id
        for node_id in admitted
        if next(node for node in ir.nodes if node.id == node_id).kind
        not in (NodeKind.SOURCE, NodeKind.SUBJECT, NodeKind.CLUSTER)
        or incident[node_id] > 0
    }
    return ProjectionIR(
        SCHEMA_VERSION,
        policy.policy_id,
        ir.question,
        tuple(node for node in ir.nodes if node.id in admitted),
        edges,
    )


def project(
    state: KnowledgeState,
    policy: ProjectionPolicy,
    *,
    question: TemporalQuestion = ALL_TIME,
) -> ProjectionIR:
    """Apply one coherent omission policy to the single full semantic substrate."""
    return _filter(substrate(state, question=question), policy)


def _object(payload: object, keys: tuple[str, ...], name: str) -> dict[str, object]:
    if type(payload) is not dict or set(payload) != set(keys):
        raise ProjectionError(f"{name} must contain exactly its declared fields")
    return payload


def _from_instant(value: object, field: str) -> datetime | None:
    if value is None:
        return None
    if type(value) is not str:
        raise ProjectionError(f"{field} payload must be an instant string or null")
    try:
        instant = datetime.fromisoformat(value)
    except ValueError as error:
        raise ProjectionError(f"{field} payload is not an ISO instant") from error
    _instant(instant, field)
    return instant


def _from_provenance(payload: object) -> ProvenanceRef:
    value = _object(payload, ("source_id", "snapshot_digest", "start_byte", "end_byte", "span"), "provenance")
    try:
        locator = Locator(value["start_byte"], value["end_byte"])
        citation = Citation(
            value["source_id"],
            value["snapshot_digest"],
            locator,
            value["span"],
        )
    except (InvalidIdentifier, ProvenanceError) as error:
        raise ProjectionError(str(error)) from error
    return ProvenanceRef(
        citation.source_id,
        citation.snapshot_digest,
        citation.locator.start_byte,
        citation.locator.end_byte,
        citation.span,
    )


def _from_gate_vector(outcomes_payload: object, reasons_payload: object, triviality: object) -> GateVector:
    if type(outcomes_payload) is not list or type(reasons_payload) is not list:
        raise ProjectionError("bridge gate payloads must be arrays")
    try:
        outcomes = {
            Gate(pair[0]): GateOutcome(pair[1])
            for pair in outcomes_payload
            if type(pair) is list and len(pair) == 2
        }
        reasons = {
            Gate(pair[0]): pair[1]
            for pair in reasons_payload
            if type(pair) is list and len(pair) == 2
        }
        if len(outcomes) != len(outcomes_payload) or len(reasons) != len(reasons_payload):
            raise ProjectionError("bridge gate entries must be two-item arrays")
        archetype = None if triviality is None else TrivialityArchetype(triviality)
        return GateVector(outcomes, reasons, archetype)
    except ProjectionError:
        raise
    except (DiscoveryError, TypeError, ValueError) as error:
        raise ProjectionError(str(error)) from error


def _from_attributes(kind: NodeKind | EdgeKind, payload: object) -> object:
    if kind is EdgeKind.ABOUT or kind is EdgeKind.CONFLICT_MEMBER or kind is EdgeKind.IN_CLUSTER or kind is EdgeKind.REJECTS:
        if payload is not None:
            raise ProjectionError("empty edge attributes must be null")
        return None
    if kind is EdgeKind.CITES:
        return _from_provenance(payload)
    if kind is EdgeKind.BRIDGE_SIDE:
        value = _object(payload, ("side", "project", "quote", "provenance"), "bridge side attributes")
        return _BridgeSideAttributes(Side(value["side"]), value["project"], value["quote"], _from_provenance(value["provenance"]))
    if kind is NodeKind.SOURCE:
        value = _object(payload, ("source_id",), "source attributes")
        return SourceAttributes(value["source_id"])
    if kind is NodeKind.SUBJECT:
        value = _object(payload, ("key",), "subject attributes")
        return SubjectAttributes(value["key"])
    if kind is NodeKind.CLUSTER:
        value = _object(payload, ("cluster_id",), "cluster attributes")
        return ClusterAttributes(value["cluster_id"])
    if kind is NodeKind.ASSERTION:
        value = _object(payload, ("assertion_id", "text", "support", "lifecycle", "recorded_at", "valid_from", "valid_to", "provenance", "temporal"), "assertion attributes")
        return AssertionAttributes(value["assertion_id"], value["text"], SupportClass(value["support"]), LifecycleState(value["lifecycle"]), _from_instant(value["recorded_at"], "recorded_at"), _from_instant(value["valid_from"], "valid_from"), _from_instant(value["valid_to"], "valid_to"), _from_provenance(value["provenance"]), TemporalDisposition(value["temporal"]))
    if kind is NodeKind.CONFLICT:
        value = _object(payload, ("subject_key", "overlap", "members"), "conflict attributes")
        if type(value["members"]) is not list:
            raise ProjectionError("conflict members payload must be an array")
        return ConflictAttributes(value["subject_key"], Overlap(value["overlap"]), tuple(value["members"]))
    if kind is NodeKind.BRIDGE:
        value = _object(payload, ("card_id", "cluster_id", "epistemic_class", "depth", "non_triviality", "consequence", "noise_objection", "origin_round", "gate_outcomes", "gate_reasons", "triviality", "disposition"), "bridge attributes")
        gates = _from_gate_vector(
            value["gate_outcomes"], value["gate_reasons"], value["triviality"]
        )
        try:
            stated = BridgeDisposition(value["disposition"])
            derived = _bridge_disposition(gates)
        except (TypeError, ValueError) as error:
            raise ProjectionError(str(error)) from error
        if stated is not derived:
            raise ProjectionError(
                f"bridge disposition disagrees with gate vector: {stated.value} != {derived.value}"
            )
        outcomes = tuple((gate, gates.outcome(gate)) for gate in Gate)
        reasons = tuple((gate, gates.reasons[gate]) for gate in Gate if gate in gates.reasons)
        return BridgeAttributes(value["card_id"], value["cluster_id"], EpistemicClass(value["epistemic_class"]), Depth(value["depth"]), value["non_triviality"], value["consequence"], value["noise_objection"], value["origin_round"], outcomes, reasons, None if gates.triviality is None else gates.triviality.value, derived)
    if kind is NodeKind.REJECTION:
        value = _object(payload, ("cluster_id", "failed_gate", "reason", "round_number", "rejected_at"), "rejection attributes")
        return RejectionAttributes(value["cluster_id"], value["failed_gate"], value["reason"], value["round_number"], _from_instant(value["rejected_at"], "rejected_at"))
    raise ProjectionError("unknown projection kind")


def from_payload(payload: object) -> ProjectionIR:
    """Restore the wire form only through the validating graph constructors."""
    value = _object(payload, ("schema_version", "policy_id", "question", "nodes", "edges"), "projection payload")
    question = _object(value["question"], ("valid_at", "recorded_as_of"), "question payload")
    if type(value["nodes"]) is not list or type(value["edges"]) is not list:
        raise ProjectionError("nodes and edges payloads must be arrays")
    nodes = []
    for item in value["nodes"]:
        node = _object(item, ("id", "kind", "attributes"), "node payload")
        kind = NodeKind(node["kind"])
        nodes.append(ProjectionNode(node["id"], kind, _from_attributes(kind, node["attributes"])))
    edges = []
    for item in value["edges"]:
        edge = _object(item, ("id", "kind", "source", "target", "attributes"), "edge payload")
        kind = EdgeKind(edge["kind"])
        edges.append(ProjectionEdge(edge["id"], kind, edge["source"], edge["target"], _from_attributes(kind, edge["attributes"])))
    return ProjectionIR(value["schema_version"], PolicyId(value["policy_id"]), TemporalQuestion(_from_instant(question["valid_at"], "valid_at"), _from_instant(question["recorded_as_of"], "recorded_as_of")), tuple(nodes), tuple(edges))
