"""Test the independent semantic projection oracle; this does not establish synthetic claim truth."""

from __future__ import annotations

from dataclasses import dataclass, fields, replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from nous_os.canonical import LifecycleState, SupportClass
from nous_os.discovery import Depth, EpistemicClass, GateOutcome, TrivialityArchetype
from nous_os.projection import (
    AssertionAttributes,
    BridgeAttributes,
    BridgeDisposition,
    ClusterAttributes,
    ConflictAttributes,
    EdgeKind,
    NodeKind,
    PolicyId,
    ProjectionError,
    ProjectionIR,
    ProjectionNode,
    ProjectionEdge,
    ProvenanceRef,
    RejectionAttributes,
    Side,
    SourceAttributes,
    SubjectAttributes,
    TemporalDisposition,
    TemporalQuestion,
    _BridgeSideAttributes,
    from_payload,
)
from nous_os.temporal import Overlap

from tests.visual_neutral_projection import neutral_digest, neutral_projection
import tests.visual_neutral_projection as oracle


FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "projection"
FIXTURE_NAMES = tuple(sorted(path.name for path in FIXTURE_DIR.glob("*.json") if path.name != "MANIFEST.json"))

_NODE_ATTRIBUTE_TYPES = {
    NodeKind.SOURCE: SourceAttributes,
    NodeKind.SUBJECT: SubjectAttributes,
    NodeKind.CLUSTER: ClusterAttributes,
    NodeKind.ASSERTION: AssertionAttributes,
    NodeKind.CONFLICT: ConflictAttributes,
    NodeKind.BRIDGE: BridgeAttributes,
    NodeKind.REJECTION: RejectionAttributes,
}
_EDGE_ATTRIBUTE_TYPES = {
    EdgeKind.ABOUT: type(None),
    EdgeKind.CITES: ProvenanceRef,
    EdgeKind.CONFLICT_MEMBER: type(None),
    EdgeKind.BRIDGE_SIDE: _BridgeSideAttributes,
    EdgeKind.IN_CLUSTER: type(None),
    EdgeKind.REJECTS: type(None),
}
_RECORD_TYPES = (
    AssertionAttributes,
    BridgeAttributes,
    ClusterAttributes,
    ConflictAttributes,
    ProvenanceRef,
    RejectionAttributes,
    SourceAttributes,
    SubjectAttributes,
    TemporalQuestion,
    _BridgeSideAttributes,
)


def _payload(filename: str) -> dict[str, object]:
    value = json.loads((FIXTURE_DIR / filename).read_bytes())
    assert type(value) is dict
    return value


def _code_unit_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def _assert_no_float(value: object) -> int:
    count = 0
    if type(value) is float:
        raise AssertionError("float found in neutral projection")
    if type(value) is dict:
        items = tuple(value.values())
        iterated = 0
        for item in items:
            iterated += 1
            count += _assert_no_float(item)
        assert iterated == len(items)
        return count + 1
    if type(value) is list:
        iterated = 0
        for item in value:
            iterated += 1
            count += _assert_no_float(item)
        assert iterated == len(value)
        return count + 1
    return 1


def _assert_normalised(original: object, actual: object) -> int:
    if type(original) is datetime:
        assert type(actual) is str
        instant = datetime.fromisoformat(actual)
        assert instant.astimezone(timezone.utc).isoformat() == actual
        return 1
    if type(original) in oracle._ENUM_TYPES:
        assert type(actual) is str
        assert actual == original.value  # type: ignore[union-attr]
        return 1
    if type(original) in _RECORD_TYPES:
        assert type(actual) is dict
        expected_names = {field.name for field in fields(original)}
        assert set(actual) == expected_names
        count = 0
        iterated = 0
        for field in fields(original):
            iterated += 1
            count += _assert_normalised(getattr(original, field.name), actual[field.name])
        assert iterated == len(expected_names)
        assert count > 0
        return count + 1
    if type(original) is tuple:
        assert type(actual) is list
        assert len(actual) == len(original)
        count = 0
        iterated = 0
        for old, new in zip(original, actual):
            iterated += 1
            count += _assert_normalised(old, new)
        assert iterated == len(original)
        return count + 1
    if original is None:
        assert actual is None
        return 1
    assert type(actual) is type(original)
    assert actual == original
    return 1


def _semantic_fields(record_type: type[object], prefix: str) -> tuple[str, ...]:
    names: list[str] = []
    count = 0
    for field in fields(record_type):
        count += 1
        path = f"{prefix}.{field.name}"
        if field.name == "provenance":
            names.extend(_semantic_fields(ProvenanceRef, path))
        else:
            names.append(path)
    assert count == len(fields(record_type))
    assert len(names) > 0
    return tuple(names)


def _all_semantic_fields() -> set[str]:
    result: set[str] = set()
    count = 0
    for kind, record_type in _NODE_ATTRIBUTE_TYPES.items():
        count += 1
        result.update(_semantic_fields(record_type, f"node.{kind.value}"))
    assert count == len(_NODE_ATTRIBUTE_TYPES)
    result.update(_semantic_fields(ProvenanceRef, "edge.cites.provenance"))
    result.update(_semantic_fields(_BridgeSideAttributes, "edge.bridge_side"))
    assert len(result) > 0
    return result


def test_fixtures_restore_to_the_exhaustive_normalised_shape() -> None:
    assert len(FIXTURE_NAMES) == 5
    restored: list[ProjectionIR] = []
    for filename in FIXTURE_NAMES:
        ir = from_payload(_payload(filename))
        restored.append(ir)
        view = neutral_projection(ir)
        assert set(view) == {"schema_version", "policy_id", "question", "nodes", "edges"}
        assert type(view["nodes"]) is list and len(view["nodes"]) > 0
        assert type(view["edges"]) is list and len(view["edges"]) > 0
        assert [item["id"] for item in view["nodes"]] == sorted(
            (item["id"] for item in view["nodes"]), key=_code_unit_key
        )
        assert [item["id"] for item in view["edges"]] == sorted(
            (item["id"] for item in view["edges"]), key=_code_unit_key
        )
        assert _assert_no_float(view) > 0
        assert _assert_normalised(ir.question, view["question"]) > 0
        node_count = 0
        for node, actual in zip(ir.nodes, view["nodes"]):
            node_count += 1
            assert set(actual) == {"id", "kind", "semantic"}
            assert actual["id"] == node.id
            assert actual["kind"] == node.kind.value
            expected_fields = {field.name for field in fields(node.attributes)}
            assert set(actual["semantic"]) == expected_fields
            assert _assert_normalised(node.attributes, actual["semantic"]) > 0
        assert node_count == len(ir.nodes)
        edge_count = 0
        for edge, actual in zip(ir.edges, view["edges"]):
            edge_count += 1
            assert set(actual) == {"id", "kind", "source", "target", "semantic"}
            assert actual["id"] == edge.id
            assert actual["kind"] == edge.kind.value
            assert actual["source"] == edge.source
            assert actual["target"] == edge.target
            if edge.attributes is None:
                assert actual["semantic"] is None
            else:
                expected_fields = {field.name for field in fields(edge.attributes)}
                assert set(actual["semantic"]) == expected_fields
                assert _assert_normalised(edge.attributes, actual["semantic"]) > 0
        assert edge_count == len(ir.edges)

    assert len(restored) == len(FIXTURE_NAMES)
    node_kinds = {node.kind for ir in restored for node in ir.nodes}
    edge_kinds = {edge.kind for ir in restored for edge in ir.edges}
    assert node_kinds == set(NodeKind)
    assert edge_kinds == set(EdgeKind)


def test_field_completeness_is_derived_from_the_source_dataclasses() -> None:
    assert len(_NODE_ATTRIBUTE_TYPES) == 7
    assert len(_EDGE_ATTRIBUTE_TYPES) == 6
    node_kind_count = 0
    for kind, record_type in _NODE_ATTRIBUTE_TYPES.items():
        node_kind_count += 1
        expected = {field.name for field in fields(record_type)}
        assert len(expected) > 0
        assert all(type(record_type) is type for _field in fields(record_type))
        assert expected == {
            field.name
            for ir in (from_payload(_payload("discovery-all-time.json")),)
            for node in ir.nodes
            if node.kind is kind
            for field in fields(node.attributes)
        }
    assert node_kind_count == len(_NODE_ATTRIBUTE_TYPES)
    edge_kind_count = 0
    for kind, record_type in _EDGE_ATTRIBUTE_TYPES.items():
        edge_kind_count += 1
        matching = [
            edge
            for edge in from_payload(_payload("discovery-all-time.json")).edges
            if edge.kind is kind
        ]
        assert len(matching) > 0
        if record_type is type(None):
            assert all(edge.attributes is None for edge in matching)
        else:
            assert all(
                {field.name for field in fields(edge.attributes)} == {field.name for field in fields(record_type)}
                for edge in matching
            )
    assert edge_kind_count == len(_EDGE_ATTRIBUTE_TYPES)

    assert _all_semantic_fields() == {
        *{
            f"node.{kind.value}.{field.name}"
            for kind, record_type in _NODE_ATTRIBUTE_TYPES.items()
            for field in fields(record_type)
            if field.name != "provenance"
        },
        *{
            f"node.{kind.value}.provenance.{field.name}"
            for kind, record_type in _NODE_ATTRIBUTE_TYPES.items()
            for parent in fields(record_type)
            if parent.name == "provenance"
            for field in fields(ProvenanceRef)
        },
        *{f"edge.cites.provenance.{field.name}" for field in fields(ProvenanceRef)},
        *{
            f"edge.bridge_side.{field.name}"
            for field in fields(_BridgeSideAttributes)
            if field.name != "provenance"
        },
        *{f"edge.bridge_side.provenance.{field.name}" for field in fields(ProvenanceRef)},
    }


@dataclass(frozen=True, slots=True)
class _Expectation:
    path: str
    transformation: str
    outcome: str


_DISCRIMINATION_REGISTRY = (
    _Expectation("node.source.source_id", "replace with another valid source id", "refusal"),
    _Expectation("node.subject.key", "replace with another valid claim key", "refusal"),
    _Expectation("node.cluster.cluster_id", "replace with another cluster label", "refusal"),
    _Expectation("node.assertion.assertion_id", "replace with another valid assertion id", "refusal"),
    _Expectation("node.assertion.text", "append text", "digest-change"),
    _Expectation("node.assertion.support", "select another SupportClass member", "digest-change"),
    _Expectation("node.assertion.lifecycle", "select rejected lifecycle", "refusal"),
    _Expectation("node.assertion.recorded_at", "add one hour", "digest-change"),
    _Expectation("node.assertion.valid_from", "add one hour", "digest-change"),
    _Expectation("node.assertion.valid_to", "add one hour", "digest-change"),
    _Expectation("node.assertion.provenance.source_id", "replace with another valid source id", "refusal"),
    _Expectation("node.assertion.provenance.snapshot_digest", "change one digest hex digit", "refusal"),
    _Expectation("node.assertion.provenance.start_byte", "add one byte", "refusal"),
    _Expectation("node.assertion.provenance.end_byte", "add one byte", "refusal"),
    _Expectation("node.assertion.provenance.span", "append span text", "refusal"),
    _Expectation("node.assertion.temporal", "select undetermined disposition", "refusal"),
    _Expectation("node.conflict.subject_key", "replace with another subject key", "digest-change"),
    _Expectation("node.conflict.overlap", "select another overlap", "digest-change"),
    _Expectation("node.conflict.members", "replace every member token", "refusal"),
    _Expectation("node.bridge.card_id", "replace with another valid assertion id", "refusal"),
    _Expectation("node.bridge.cluster_id", "replace with another cluster label", "refusal"),
    _Expectation("node.bridge.epistemic_class", "select another epistemic class", "digest-change"),
    _Expectation("node.bridge.depth", "select another depth", "digest-change"),
    _Expectation("node.bridge.non_triviality", "append text", "digest-change"),
    _Expectation("node.bridge.consequence", "append text", "digest-change"),
    _Expectation("node.bridge.noise_objection", "append text", "digest-change"),
    _Expectation("node.bridge.origin_round", "add one round", "digest-change"),
    _Expectation("node.bridge.gate_outcomes", "change one outcome", "refusal"),
    _Expectation("node.bridge.gate_reasons", "change one reason", "digest-change"),
    _Expectation("node.bridge.triviality", "select another archetype", "digest-change"),
    _Expectation("node.bridge.disposition", "select a mismatching disposition", "refusal"),
    _Expectation("node.rejection.cluster_id", "replace with another cluster label", "digest-change"),
    _Expectation("node.rejection.failed_gate", "replace free text", "digest-change"),
    _Expectation("node.rejection.reason", "append text", "digest-change"),
    _Expectation("node.rejection.round_number", "add one round", "digest-change"),
    _Expectation("node.rejection.rejected_at", "add one hour", "digest-change"),
    _Expectation("edge.cites.provenance.source_id", "replace with another valid source id", "refusal"),
    _Expectation("edge.cites.provenance.snapshot_digest", "change one digest hex digit", "refusal"),
    _Expectation("edge.cites.provenance.start_byte", "add one byte", "refusal"),
    _Expectation("edge.cites.provenance.end_byte", "add one byte", "refusal"),
    _Expectation("edge.cites.provenance.span", "append span text", "refusal"),
    _Expectation("edge.bridge_side.side", "change left to right", "refusal"),
    _Expectation("edge.bridge_side.project", "append text", "digest-change"),
    _Expectation("edge.bridge_side.quote", "append text", "digest-change"),
    _Expectation("edge.bridge_side.provenance.source_id", "replace with another valid source id", "refusal"),
    _Expectation("edge.bridge_side.provenance.snapshot_digest", "change one digest hex digit", "digest-change"),
    _Expectation("edge.bridge_side.provenance.start_byte", "add one byte", "digest-change"),
    _Expectation("edge.bridge_side.provenance.end_byte", "add one byte", "digest-change"),
    _Expectation("edge.bridge_side.provenance.span", "append span text", "digest-change"),
)


def _changed_value(path: str, value: object) -> object:
    field = path.rsplit(".", 1)[-1]
    if field == "source_id":
        return "src_changed"
    if field in {"assertion_id", "card_id"}:
        return "asr_01ARZ3NDEKTSV4RRFFQ69FZZ"
    if field == "key":
        return "changed-subject"
    if field == "subject_key":
        return "changed-subject"
    if field == "cluster_id":
        return "changed-cluster"
    if field in {"text", "non_triviality", "consequence", "noise_objection", "span", "project", "quote", "reason"}:
        assert type(value) is str
        return value + " changed"
    if field == "failed_gate":
        return "changed-gate"
    if field == "snapshot_digest":
        assert type(value) is str
        return value[:-1] + ("0" if value[-1] != "0" else "1")
    if field in {"start_byte", "end_byte", "origin_round", "round_number"}:
        assert type(value) is int
        return value + 1
    if field in {"recorded_at", "valid_from", "valid_to", "rejected_at"}:
        assert type(value) is datetime
        return value + timedelta(hours=1)
    if field == "support":
        return SupportClass.INFERRED if value is not SupportClass.INFERRED else SupportClass.UNKNOWN
    if field == "lifecycle":
        return LifecycleState.REJECTED
    if field == "temporal":
        return TemporalDisposition.UNDETERMINED
    if field == "overlap":
        return Overlap.UNDETERMINED if value is not Overlap.UNDETERMINED else Overlap.OVERLAPS
    if field == "epistemic_class":
        return EpistemicClass.EXPLICIT if value is not EpistemicClass.EXPLICIT else EpistemicClass.DERIVED
    if field == "depth":
        return Depth.MODERATE if value is not Depth.MODERATE else Depth.OBVIOUS
    if field == "gate_outcomes":
        return tuple((gate, GateOutcome.UNKNOWN if outcome is not GateOutcome.UNKNOWN else GateOutcome.PASS) for gate, outcome in value)  # type: ignore[misc]
    if field == "gate_reasons":
        assert type(value) is tuple and len(value) > 0
        return ((value[0][0], value[0][1] + " changed"),) + value[1:]
    if field == "triviality":
        return (
            TrivialityArchetype.COMMODITY_TOOLING.value
            if value != TrivialityArchetype.COMMODITY_TOOLING.value
            else TrivialityArchetype.GENERIC_PROCESS_OVERLAP.value
        )
    if field == "disposition":
        return BridgeDisposition.REJECTED
    if field == "members":
        assert type(value) is tuple
        return tuple(member + "x" for member in value)
    if field == "side":
        return Side.RIGHT
    raise AssertionError(f"no pinned transformation for {path}")


def _find_node(ir: ProjectionIR, kind: NodeKind, path: str) -> ProjectionNode:
    candidates = [node for node in ir.nodes if node.kind is kind]
    assert len(candidates) > 0
    if path.endswith("gate_reasons") or path.endswith("triviality"):
        candidates = [node for node in candidates if node.attributes.gate_reasons or node.attributes.triviality is not None]  # type: ignore[union-attr]
        assert len(candidates) > 0
    if path.endswith("valid_from"):
        candidates = [node for node in candidates if node.attributes.valid_from is not None]  # type: ignore[union-attr]
        assert len(candidates) > 0
    if path.endswith("valid_to"):
        candidates = [node for node in candidates if node.attributes.valid_to is not None]  # type: ignore[union-attr]
        assert len(candidates) > 0
    return candidates[0]


def _mutate(ir: ProjectionIR, path: str) -> ProjectionIR:
    parts = path.split(".")
    if parts[0] == "node":
        kind = NodeKind(parts[1])
        node = _find_node(ir, kind, path)
        attribute = node.attributes
        if parts[2] == "provenance":
            old_nested = getattr(attribute.provenance, parts[3])  # type: ignore[union-attr]
            nested = replace(attribute.provenance, **{parts[3]: _changed_value(path, old_nested)})  # type: ignore[union-attr]
            changed_attribute = replace(attribute, provenance=nested)
        else:
            field = parts[2]
            changed_attribute = replace(attribute, **{field: _changed_value(path, getattr(attribute, field))})
        changed_node = replace(node, attributes=changed_attribute)
        return replace(ir, nodes=tuple(changed_node if item is node else item for item in ir.nodes))

    if parts[0] == "edge":
        kind = EdgeKind(parts[1])
        candidates = [edge for edge in ir.edges if edge.kind is kind]
        assert len(candidates) > 0
        if kind is EdgeKind.BRIDGE_SIDE:
            candidates = [edge for edge in candidates if edge.attributes.side is Side.LEFT]  # type: ignore[union-attr]
            assert len(candidates) > 0
        edge = candidates[0]
        attribute = edge.attributes
        if parts[2] == "provenance":
            provenance = attribute if kind is EdgeKind.CITES else attribute.provenance
            old_nested = getattr(provenance, parts[3])
            nested = replace(provenance, **{parts[3]: _changed_value(path, old_nested)})
            changed_attribute = nested if kind is EdgeKind.CITES else replace(attribute, provenance=nested)
        else:
            field = parts[2]
            changed_attribute = replace(attribute, **{field: _changed_value(path, getattr(attribute, field))})
        changed_edge = replace(edge, attributes=changed_attribute)
        return replace(ir, edges=tuple(changed_edge if item is edge else item for item in ir.edges))
    raise AssertionError(f"unknown registry path: {path}")


def test_pinned_discrimination_registry_covers_and_runs_every_semantic_leaf() -> None:
    assert len(_DISCRIMINATION_REGISTRY) == len(set(entry.path for entry in _DISCRIMINATION_REGISTRY))
    assert {entry.path for entry in _DISCRIMINATION_REGISTRY} == _all_semantic_fields()
    assert len(_DISCRIMINATION_REGISTRY) > 0
    base = from_payload(_payload("substrate-all-time.json"))
    ran = 0
    for entry in _DISCRIMINATION_REGISTRY:
        assert type(entry.transformation) is str and len(entry.transformation) > 0
        assert entry.outcome in {"digest-change", "refusal"}
        try:
            changed = _mutate(base, entry.path)
        except ProjectionError:
            assert entry.outcome == "refusal", entry.path
        else:
            assert entry.outcome == "digest-change", entry.path
            assert neutral_digest(changed) != neutral_digest(base), entry.path
        ran += 1
    assert ran == len(_DISCRIMINATION_REGISTRY)


def test_oracle_source_does_not_call_the_producer_encoder() -> None:
    source = Path(oracle.__file__).read_text(encoding="utf-8")
    assert "as_payload(" not in source
