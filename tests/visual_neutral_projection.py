"""Independent neutral semantic projection; this does not establish source truth or renderer sufficiency."""

from __future__ import annotations

from dataclasses import fields
from datetime import datetime, timezone

from nous_os.identity import digest_payload
from nous_os.canonical import LifecycleState, SupportClass
from nous_os.discovery import Depth, EpistemicClass, Gate, GateOutcome, TrivialityArchetype
from nous_os.temporal import Overlap
from nous_os.projection import (
    AssertionAttributes,
    BridgeAttributes,
    ClusterAttributes,
    ConflictAttributes,
    EdgeKind,
    NodeKind,
    ProjectionIR,
    ProjectionNode,
    ProjectionEdge,
    ProvenanceRef,
    RejectionAttributes,
    SourceAttributes,
    SubjectAttributes,
    TemporalQuestion,
    _BridgeSideAttributes,
    BridgeDisposition,
    PolicyId,
    Side,
    TemporalDisposition,
)


_ENUM_TYPES = (
    BridgeDisposition,
    Depth,
    EdgeKind,
    EpistemicClass,
    Gate,
    GateOutcome,
    LifecycleState,
    NodeKind,
    Overlap,
    PolicyId,
    Side,
    SupportClass,
    TemporalDisposition,
    TrivialityArchetype,
)


def _code_unit_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def _normalise(value: object) -> object:
    if value is None or type(value) is str or type(value) is int or type(value) is bool:
        return value
    if type(value) is float:
        raise TypeError("float is not part of the neutral projection")
    if type(value) is datetime:
        if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
            raise TypeError("instant must carry a timezone")
        return value.astimezone(timezone.utc).isoformat()
    if type(value) in _ENUM_TYPES:
        return value.value  # type: ignore[union-attr]
    if type(value) is tuple:
        return [_normalise(item) for item in value]
    if type(value) is list:
        return [_normalise(item) for item in value]
    if type(value) is dict:
        return {key: _normalise(item) for key, item in value.items()}
    if type(value) in (
        ProvenanceRef,
        SourceAttributes,
        SubjectAttributes,
        ClusterAttributes,
        AssertionAttributes,
        ConflictAttributes,
        BridgeAttributes,
        RejectionAttributes,
        _BridgeSideAttributes,
        TemporalQuestion,
    ):
        return {field.name: _normalise(getattr(value, field.name)) for field in fields(value)}
    raise TypeError(f"unsupported projection value: {type(value).__name__}")


def _node(node: ProjectionNode) -> dict[str, object]:
    return {
        "id": node.id,
        "kind": node.kind.value,
        "semantic": _normalise(node.attributes),
    }


def _edge(edge: ProjectionEdge) -> dict[str, object]:
    return {
        "id": edge.id,
        "kind": edge.kind.value,
        "source": edge.source,
        "target": edge.target,
        "semantic": _normalise(edge.attributes),
    }


def neutral_projection(ir: ProjectionIR) -> dict[str, object]:
    """Return the canonical semantic view of one typed projection graph."""
    if type(ir) is not ProjectionIR:
        raise TypeError("ir must be an exact ProjectionIR")
    return {
        "schema_version": ir.schema_version,
        "policy_id": ir.policy_id.value,
        "question": _normalise(ir.question),
        "nodes": [_node(node) for node in sorted(ir.nodes, key=lambda item: _code_unit_key(item.id))],
        "edges": [_edge(edge) for edge in sorted(ir.edges, key=lambda item: _code_unit_key(item.id))],
    }


def neutral_digest(ir: ProjectionIR) -> str:
    """Return the sha256 of the neutral semantic projection."""
    return digest_payload(neutral_projection(ir))
