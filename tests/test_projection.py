"""Small CAP-10 smoke checks; the full projection oracle is maintained separately."""

from __future__ import annotations

import ast
from dataclasses import dataclass, fields, is_dataclass, replace
from datetime import datetime, timedelta, timezone
import inspect
from pathlib import Path
import copy
import os
import subprocess
import sys

import pytest

import nous_os.projection as projection_module
import nous_os.operations as operations_module
from nous_os.adjudication import Rejection, RejectionMemory
from nous_os.capability import Grant, NotAuthorized, Tier, execute, required_tier
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    TrivialityArchetype,
    run_round,
)
from nous_os.identity import canonical_bytes, digest_payload
from nous_os.projection import (
    ALL_TIME,
    DISCOVERY,
    RELIABILITY,
    KnowledgeState,
    EdgeKind,
    NodeKind,
    BridgeDisposition,
    PolicyId,
    ProjectionPolicy,
    ProjectionPolicyError,
    TemporalDisposition,
    TemporalQuestion,
    from_payload,
    project,
    substrate,
)
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey, Overlap, TemporalIndex


_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_DIGEST = "0" * 64


def _instant(day: int, hour: int = 0) -> datetime:
    return datetime(2026, 1, day, hour, tzinfo=timezone.utc)


def _assertion(
    assertion_id: str,
    text: str,
    *,
    recorded_day: int = 1,
    valid_from: int = 1,
    valid_to: int = 6,
) -> Assertion:
    return Assertion(
        assertion_id,
        text,
        Citation(_SOURCE, _DIGEST, Locator(0, 1), "x"),
        SupportClass.DIRECT_QUOTE,
        _instant(recorded_day),
        LifecycleState.CANONICAL,
        _instant(valid_from),
        _instant(valid_to),
    )


def _small_state() -> KnowledgeState:
    index = TemporalIndex()
    index.add(ClaimKey("smoke"), _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAA", "one"))
    return KnowledgeState(index)


_SOURCE_B = "src_01BRZ3NDEKTSV4RRFFQ69G5FAV"


def _citation(source_id: str = _SOURCE, span: str = "x") -> Citation:
    return Citation(source_id, _DIGEST, Locator(0, len(span.encode("utf-8"))), span)


def _endpoint(*, source_id: str = _SOURCE, project: str = "project-a", quote: str = "x") -> Endpoint:
    return Endpoint(project, _citation(source_id, quote), quote)


def _gates(*, failed: Gate | None = None, unknown: Gate | None = None) -> GateVector:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    reasons: dict[Gate, str] = {}
    if failed is not None:
        outcomes[failed] = GateOutcome.FAIL
        reasons[failed] = f"{failed.value} failed"
    if unknown is not None:
        outcomes[unknown] = GateOutcome.UNKNOWN
    return GateVector(
        outcomes,
        reasons,
        TrivialityArchetype.GENERIC_PROCESS_OVERLAP if failed is Gate.G4 else None,
    )


def _card(
    suffix: str,
    *,
    cluster: str = "cluster-a",
    failed: Gate | None = None,
    unknown: Gate | None = None,
    epistemic: EpistemicClass = EpistemicClass.DERIVED,
    origin_round: int = 1,
) -> BridgeCard:
    return BridgeCard(
        f"asr_01ARZ3NDEKTSV4RRFFQ69G5F{suffix}",
        cluster,
        _endpoint(),
        _endpoint(source_id=_SOURCE_B, project="project-b"),
        epistemic,
        Depth.DEEP,
        "The mechanism crosses boundaries.",
        "A test can falsify the connection.",
        "The vocabulary may coincide.",
        _gates(failed=failed, unknown=unknown),
        origin_round,
    )


def _rejection(cluster: str = "cluster-a", *, round_number: int = 1) -> Rejection:
    return Rejection(cluster, Gate.G1.value, "recorded failure", round_number, _instant(2))


def _state(
    assertions: tuple[tuple[str, Assertion], ...] = (),
    *,
    bridges: tuple[BridgeCard, ...] = (),
    rejections: tuple[Rejection, ...] = (),
) -> KnowledgeState:
    index = TemporalIndex()
    for key, assertion in assertions:
        index.add(ClaimKey(key), assertion)
    return KnowledgeState(index, bridges, rejections)


def _all_kind_state() -> KnowledgeState:
    """Provide every semantic node and edge kind from explicit source inputs."""
    first = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAA", "first", valid_to=4)
    second = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAB", "second", valid_from=2, valid_to=5)
    return _state(
        (("subject-a", first), ("subject-a", second)),
        bridges=(_card("C"),),
        rejections=(_rejection(),),
    )


def _node_by_id(ir: object) -> dict[str, object]:
    return {node.id: node for node in ir.nodes}  # type: ignore[union-attr]


def _edge_by_id(ir: object) -> dict[str, object]:
    return {edge.id: edge for edge in ir.edges}  # type: ignore[union-attr]


def _local_conflict_id(subject: str, members: tuple[str, ...]) -> str:
    """Independent test-local reimplementation of the packet's conflict-id rule."""
    return f"conflict:{digest_payload({'subject': subject, 'members': list(sorted(members))})}"


def _local_rejection_id(rejection: Rejection) -> str:
    """Independent test-local reimplementation of the packet's rejection-id rule."""
    payload = {
        "cluster_id": rejection.cluster_id,
        "failed_gate": rejection.failed_gate,
        "reason": rejection.reason,
        "round_number": rejection.round_number,
        "rejected_at": rejection.rejected_at.astimezone(timezone.utc).isoformat(),
    }
    return f"rejection:{digest_payload(payload)}"


def test_substrate_emits_a_small_canonical_assertion_graph() -> None:
    ir = substrate(_small_state(), question=ALL_TIME)

    assert {node.kind for node in ir.nodes} == {
        NodeKind.SOURCE,
        NodeKind.SUBJECT,
        NodeKind.ASSERTION,
    }
    assert {edge.id for edge in ir.edges} == {
        "about:asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        "cites:asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    }


def test_both_presets_construct_distinct_admission_policies() -> None:
    reliability = project(_small_state(), RELIABILITY)
    discovery = project(_small_state(), DISCOVERY)

    assert RELIABILITY != DISCOVERY
    assert {node.id for node in reliability.nodes} <= {node.id for node in discovery.nodes}
    assert reliability.policy_id is RELIABILITY.policy_id
    assert discovery.policy_id is DISCOVERY.policy_id


def test_payload_round_trip_and_digest_are_stable() -> None:
    ir = project(_small_state(), DISCOVERY)

    assert from_payload(ir.as_payload()) == ir
    assert ir.ir_digest == ir.ir_digest


def test_restore_refuses_noncanonical_assertion_lifecycle_with_repaired_control() -> None:
    ir = substrate(_small_state())
    payload = copy.deepcopy(ir.as_payload())
    assertion = next(item for item in payload["nodes"] if item["kind"] == "assertion")
    assertion["attributes"]["lifecycle"] = LifecycleState.REJECTED.value
    attributes = next(node.attributes for node in ir.nodes if node.kind is NodeKind.ASSERTION)

    assert replace(attributes) == attributes
    with pytest.raises(projection_module.ProjectionError) as direct:
        replace(attributes, lifecycle=LifecycleState.REJECTED)
    assert str(direct.value) == "only canonical assertions can be restored"

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == "only canonical assertions can be restored"
    assert from_payload(ir.as_payload()) == ir


def test_restore_refuses_failed_gate_without_reason_with_repaired_control() -> None:
    ir = substrate(_state(bridges=(_card("H"),)))
    payload = copy.deepcopy(ir.as_payload())
    bridge = next(item for item in payload["nodes"] if item["kind"] == "bridge")
    bridge["attributes"]["gate_outcomes"][0][1] = GateOutcome.FAIL.value
    bridge["attributes"]["gate_reasons"] = []
    bridge["attributes"]["disposition"] = BridgeDisposition.REJECTED.value

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == "failed gate cross_project needs a reason"
    assert from_payload(ir.as_payload()) == ir


def test_restore_refuses_invalid_triviality_archetype_with_repaired_control() -> None:
    ir = substrate(_state(bridges=(_card("K"),)))
    payload = copy.deepcopy(ir.as_payload())
    bridge = next(item for item in payload["nodes"] if item["kind"] == "bridge")
    bridge["attributes"]["triviality"] = "not-an-archetype"

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == "'not-an-archetype' is not a valid TrivialityArchetype"
    assert from_payload(ir.as_payload()) == ir


def test_restore_refuses_stated_bridge_disposition_mismatch_with_repaired_control() -> None:
    ir = substrate(_state(bridges=(_card("J"),)))
    payload = copy.deepcopy(ir.as_payload())
    bridge = next(item for item in payload["nodes"] if item["kind"] == "bridge")
    bridge["attributes"]["disposition"] = BridgeDisposition.REJECTED.value

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == (
        "bridge disposition disagrees with gate vector: rejected != accepted"
    )
    assert from_payload(ir.as_payload()) == ir


def test_restore_refuses_invalid_snapshot_digest_in_both_copies_with_repaired_control() -> None:
    ir = substrate(_small_state())
    payload = copy.deepcopy(ir.as_payload())
    assertion = next(item for item in payload["nodes"] if item["kind"] == "assertion")
    cites = next(item for item in payload["edges"] if item["kind"] == "cites")
    assertion["attributes"]["provenance"]["snapshot_digest"] = "not-a-digest"
    cites["attributes"]["snapshot_digest"] = "not-a-digest"

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == (
        "snapshot_digest must be 64 lowercase hex characters: 'not-a-digest'"
    )
    assert from_payload(ir.as_payload()) == ir


def test_provenance_ref_refuses_invalid_source_and_digest_on_both_routes() -> None:
    """Citation validation belongs to ProvenanceRef, whether decoded or constructed."""
    ir = substrate(_small_state())
    valid = next(edge.attributes for edge in ir.edges if edge.kind is EdgeKind.CITES)

    for field, defective in (
        ("source_id", "not-a-source-id"),
        ("snapshot_digest", "not-a-digest"),
    ):
        assert replace(valid) == valid
        assert from_payload(ir.as_payload()) == ir
        with pytest.raises(projection_module.ProjectionError) as direct:
            replace(valid, **{field: defective})

        payload = copy.deepcopy(ir.as_payload())
        cites = next(item for item in payload["edges"] if item["kind"] == "cites")
        cites["attributes"][field] = defective
        with pytest.raises(projection_module.ProjectionError) as restored:
            from_payload(payload)
        assert str(restored.value) == str(direct.value)


def test_bridge_attributes_refuse_card_and_gate_defects_on_both_routes() -> None:
    """The bridge record owns identity, gate-vector, and derived-label validation."""
    ir = substrate(_state(bridges=(_card("P"),)))
    attributes = next(node.attributes for node in ir.nodes if node.kind is NodeKind.BRIDGE)

    cases = (
        (
            "card_id",
            lambda value: replace(value, card_id="not-a-valid-assertion-id"),
            lambda value: value.__setitem__("card_id", "not-a-valid-assertion-id"),
        ),
        (
            "failed gate without a reason",
            lambda value: replace(
                value,
                gate_outcomes=((Gate.G1, GateOutcome.FAIL),) + value.gate_outcomes[1:],
                gate_reasons=(),
                disposition=BridgeDisposition.REJECTED,
            ),
            lambda value: (
                value["gate_outcomes"][0].__setitem__(1, GateOutcome.FAIL.value),
                value.__setitem__("gate_reasons", []),
                value.__setitem__("disposition", BridgeDisposition.REJECTED.value),
            ),
        ),
        (
            "stated disposition mismatch",
            lambda value: replace(value, disposition=BridgeDisposition.REJECTED),
            lambda value: value.__setitem__("disposition", BridgeDisposition.REJECTED.value),
        ),
    )
    for _name, direct_change, payload_change in cases:
        assert replace(attributes) == attributes
        assert from_payload(ir.as_payload()) == ir
        with pytest.raises(projection_module.ProjectionError) as direct:
            direct_change(attributes)

        payload = copy.deepcopy(ir.as_payload())
        bridge = next(item for item in payload["nodes"] if item["kind"] == "bridge")
        payload_change(bridge["attributes"])
        with pytest.raises(projection_module.ProjectionError) as restored:
            from_payload(payload)
        assert str(restored.value) == str(direct.value), _name


def test_bridge_gate_wire_shape_is_refused_on_both_routes() -> None:
    """A payload must name every gate once and in the closed Gate order."""
    ir = substrate(_state(bridges=(_card("M"),)))
    attributes = next(node.attributes for node in ir.nodes if node.kind is NodeKind.BRIDGE)

    cases = (
        (
            "missing gate",
            lambda value: replace(value, gate_outcomes=value.gate_outcomes[:-1]),
            lambda value: value["gate_outcomes"].pop(),
        ),
        (
            "out-of-order gate",
            lambda value: replace(
                value, gate_outcomes=(value.gate_outcomes[1], value.gate_outcomes[0]) + value.gate_outcomes[2:]
            ),
            lambda value: value["gate_outcomes"].__setitem__(
                slice(0, 2), [value["gate_outcomes"][1], value["gate_outcomes"][0]]
            ),
        ),
    )
    for _name, direct_change, payload_change in cases:
        assert replace(attributes) == attributes
        assert from_payload(ir.as_payload()) == ir
        with pytest.raises(projection_module.ProjectionError) as direct:
            direct_change(attributes)

        payload = copy.deepcopy(ir.as_payload())
        bridge = next(item for item in payload["nodes"] if item["kind"] == "bridge")
        payload_change(bridge["attributes"])
        with pytest.raises(projection_module.ProjectionError) as restored:
            from_payload(payload)
        assert str(restored.value) == str(direct.value), _name


def test_bridge_side_quote_bound_is_refused_on_both_routes() -> None:
    """Projection bridge-side text retains Endpoint's 25-word bound."""
    ir = substrate(_state(bridges=(_card("N"),)))
    attributes = next(edge.attributes for edge in ir.edges if edge.kind is EdgeKind.BRIDGE_SIDE)
    too_long = " ".join("word" for _ in range(26))

    assert replace(attributes) == attributes
    assert from_payload(ir.as_payload()) == ir
    with pytest.raises(projection_module.ProjectionError) as direct:
        replace(attributes, quote=too_long)

    payload = copy.deepcopy(ir.as_payload())
    side = next(item for item in payload["edges"] if item["kind"] == "bridge_side")
    side["attributes"]["quote"] = too_long
    with pytest.raises(projection_module.ProjectionError) as restored:
        from_payload(payload)
    assert str(restored.value) == str(direct.value)


def test_projection_ir_refuses_provenance_targets_and_temporal_label_on_both_routes() -> None:
    """Whole-graph relations are checked identically after decoding and direct construction."""
    repaired = substrate(_all_kind_state())
    nodes = repaired.nodes
    edges = repaired.edges
    cites = next(edge for edge in edges if edge.kind is EdgeKind.CITES)
    side = next(
        edge
        for edge in edges
        if edge.kind is EdgeKind.BRIDGE_SIDE and edge.attributes.side is projection_module.Side.LEFT
    )
    assertion = next(node for node in nodes if node.kind is NodeKind.ASSERTION)

    def replace_edge(original: object, changed: object) -> tuple[object, ...]:
        return tuple(changed if edge is original else edge for edge in edges)

    def replace_node(original: object, changed: object) -> tuple[object, ...]:
        return tuple(changed if node is original else node for node in nodes)

    cases = (
        (
            "CITES source target",
            nodes,
            replace_edge(cites, replace(cites, target=f"source:{_SOURCE_B}")),
        ),
        (
            "BRIDGE_SIDE source target",
            nodes,
            replace_edge(side, replace(side, target=f"source:{_SOURCE_B}")),
        ),
        (
            "temporal disposition",
            replace_node(
                assertion,
                replace(
                    assertion,
                    attributes=replace(assertion.attributes, temporal=TemporalDisposition.EXCLUDED),
                ),
            ),
            edges,
        ),
    )
    for _name, changed_nodes, changed_edges in cases:
        assert projection_module.ProjectionIR(
            repaired.schema_version, repaired.policy_id, repaired.question, repaired.nodes, repaired.edges
        ) == repaired
        assert from_payload(repaired.as_payload()) == repaired
        with pytest.raises(projection_module.ProjectionError) as direct:
            projection_module.ProjectionIR(
                repaired.schema_version,
                repaired.policy_id,
                repaired.question,
                changed_nodes,
                changed_edges,
            )
        with pytest.raises(projection_module.ProjectionError) as restored:
            from_payload(_graph_payload(changed_nodes, changed_edges))
        assert str(restored.value) == str(direct.value), _name


def test_restore_refuses_coherent_id_rewrite_that_disagrees_with_assertion_attribute() -> None:
    assertion_a = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAA"
    assertion_b = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAB"
    ir = substrate(
        _state((("subject-a", _assertion(assertion_b, "assertion b")),))
    )
    payload = copy.deepcopy(ir.as_payload())
    assertion = next(item for item in payload["nodes"] if item["kind"] == "assertion")
    assertion["id"] = f"assertion:{assertion_a}"
    for edge in payload["edges"]:
        if edge["kind"] in {"about", "cites"}:
            edge["id"] = edge["id"].replace(assertion_b, assertion_a)
            edge["source"] = f"assertion:{assertion_a}"

    with pytest.raises(projection_module.ProjectionError) as refused:
        from_payload(payload)
    assert str(refused.value) == "assertion node id must agree with assertion_id"
    assert from_payload(ir.as_payload()) == ir


def test_strict_restore_round_trip_preserves_all_kind_ir_and_digest() -> None:
    ir = substrate(_all_kind_state())

    assert {node.kind for node in ir.nodes} == set(NodeKind)
    assert from_payload(ir.as_payload()) == ir
    assert from_payload(ir.as_payload()).ir_digest == ir.ir_digest
    assert ir.ir_digest == "7cbc8d9f5870a7ec7bf905768965f7b27abd0700915a52a9bab726a4bd4b7383"


def test_policy_refuses_a_dead_bridge_admission_knob() -> None:
    with pytest.raises(ProjectionPolicyError):
        ProjectionPolicy(
            RELIABILITY.policy_id,
            RELIABILITY.admit_kinds,
            frozenset({TemporalDisposition.ESTABLISHED}),
            frozenset(),
            frozenset({EpistemicClass.EXPLICIT}),
        )


def test_conflict_is_projected_whole_or_not_at_all_after_temporal_filtering() -> None:
    """Excluding the linking member must not claim that the disjoint survivors conflict."""
    index = TemporalIndex()
    key = ClaimKey("chain")
    assertion_a = _assertion(
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FAA", "A", valid_from=1, valid_to=3
    )
    assertion_b = _assertion(
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FAB", "B", recorded_day=11, valid_from=2, valid_to=4
    )
    assertion_c = _assertion(
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FAC", "C", valid_from=3, valid_to=5
    )
    for assertion in (assertion_a, assertion_b, assertion_c):
        index.add(key, assertion)
    state = KnowledgeState(index)
    question = TemporalQuestion(recorded_as_of=_instant(1, 23))

    reliability = project(state, RELIABILITY, question=question)
    discovery = project(state, DISCOVERY, question=question)
    reliability_nodes = {node.id for node in reliability.nodes}
    discovery_nodes = {node.id for node in discovery.nodes}

    conflict_id = _local_conflict_id(
        "chain",
        (
            "asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            "asr_01ARZ3NDEKTSV4RRFFQ69G5FAB",
            "asr_01ARZ3NDEKTSV4RRFFQ69G5FAC",
        ),
    )
    assert conflict_id not in reliability_nodes
    assert sum(edge.kind is EdgeKind.CONFLICT_MEMBER for edge in reliability.edges) == 0
    assert "subject:chain" in reliability_nodes
    assert "assertion:asr_01ARZ3NDEKTSV4RRFFQ69G5FAA" in reliability_nodes
    assert "assertion:asr_01ARZ3NDEKTSV4RRFFQ69G5FAC" in reliability_nodes
    assert "about:asr_01ARZ3NDEKTSV4RRFFQ69G5FAA" in {edge.id for edge in reliability.edges}
    assert "about:asr_01ARZ3NDEKTSV4RRFFQ69G5FAC" in {edge.id for edge in reliability.edges}
    assert conflict_id in discovery_nodes
    assert sum(edge.kind.value == "conflict_member" for edge in discovery.edges) == 3
    assert "assertion:asr_01ARZ3NDEKTSV4RRFFQ69G5FAB" in discovery_nodes


def test_substrate_neither_omits_nor_invents_known_ids() -> None:
    """Expected ids use test-local derived-id rules, never projection helpers."""
    state = _all_kind_state()
    # Re-read the fixture inputs explicitly rather than obtaining expectations from substrate.
    index_assertions = state.index.assertions(ClaimKey("subject-a"))
    assert len(index_assertions) == 2
    assertion_ids = tuple(assertion.id for assertion in index_assertions)
    card = state.bridges[0]
    rejection = state.rejections[0]
    conflict_id = _local_conflict_id("subject-a", assertion_ids)
    expected_nodes = {
        "subject:subject-a",
        *(f"assertion:{assertion_id}" for assertion_id in assertion_ids),
        f"source:{_SOURCE}",
        f"source:{_SOURCE_B}",
        conflict_id,
        f"bridge:{card.card_id}",
        f"cluster:{card.cluster_id}",
        _local_rejection_id(rejection),
    }
    expected_edges = {
        *(f"about:{assertion_id}" for assertion_id in assertion_ids),
        *(f"cites:{assertion_id}" for assertion_id in assertion_ids),
        *(f"member:{conflict_id}:{assertion_id}" for assertion_id in assertion_ids),
        f"in-cluster:{card.card_id}",
        f"side:{card.card_id}:left",
        f"side:{card.card_id}:right",
        f"rejects:{_local_rejection_id(rejection)}",
    }
    assert len(expected_nodes) == 9
    assert len(expected_edges) == 10

    ir = substrate(state)
    assert {node.id for node in ir.nodes} == expected_nodes
    assert {edge.id for edge in ir.edges} == expected_edges


def test_policy_filters_substrate_elements_without_reinterpreting_them() -> None:
    """Policies may omit elements but every retained wire payload remains byte-identical."""
    state = _all_kind_state()
    policies = (
        RELIABILITY,
        DISCOVERY,
        ProjectionPolicy(
            PolicyId.EXPERIMENTAL,
            frozenset(NodeKind),
            frozenset(TemporalDisposition),
            frozenset(BridgeDisposition),
            frozenset({EpistemicClass.EXPLICIT}),
        ),
        ProjectionPolicy(
            PolicyId.EXPERIMENTAL,
            frozenset(NodeKind),
            frozenset(TemporalDisposition),
            frozenset({BridgeDisposition.ACCEPTED}),
            frozenset(EpistemicClass),
        ),
    )
    expected_kind_counts = {kind: 1 for kind in NodeKind}
    expected_edge_kind_counts = {kind: 1 for kind in EdgeKind}
    full = substrate(state)
    assert len(full.nodes) == sum(expected_kind_counts.values()) + 2
    assert len(full.edges) == sum(expected_edge_kind_counts.values()) + 4
    full_payload = full.as_payload()
    node_payloads = {item["id"]: item for item in full_payload["nodes"]}
    edge_payloads = {item["id"]: item for item in full_payload["edges"]}
    assert len(policies) == 4
    for policy in policies:
        filtered = project(state, policy)
        assert len(filtered.nodes) > 0
        assert len(filtered.edges) > 0
        assert {node.id for node in filtered.nodes} <= set(node_payloads)
        assert {edge.id for edge in filtered.edges} <= set(edge_payloads)
        filtered_payload = filtered.as_payload()
        assert len(filtered_payload["nodes"]) == len(filtered.nodes)
        assert len(filtered_payload["edges"]) == len(filtered.edges)
        for item in filtered_payload["nodes"]:
            assert canonical_bytes(item) == canonical_bytes(node_payloads[item["id"]])
        for item in filtered_payload["edges"]:
            assert canonical_bytes(item) == canonical_bytes(edge_payloads[item["id"]])


def test_reliability_is_a_subset_of_discovery_over_policy_state_and_time_table() -> None:
    """The table keeps one known assertion per state so containment is not vacuous."""
    canonical = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAD", "canon", valid_to=5)
    second = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAE", "other", valid_from=2, valid_to=6)
    states = {
        "empty-ish": _state((("table", canonical),), bridges=(_card("D", failed=Gate.G1),)),
        "canon-only": _state((("table", canonical),)),
        "canon-conflict": _state((("table", canonical), ("table", second))),
        "accepted-bridge": _state((("table", canonical),), bridges=(_card("E"),)),
        "rejected-bridge": _state((("table", canonical),), bridges=(_card("F", failed=Gate.G1),)),
        "undetermined-bridge": _state((("table", canonical),), bridges=(_card("G", unknown=Gate.G2),)),
        "undetermined-temporal": _state((("table", replace(canonical, valid_from=None, valid_to=None)),)),
    }
    questions = (ALL_TIME, TemporalQuestion(valid_at=_instant(3)), TemporalQuestion(recorded_as_of=_instant(2)))
    assert len(states) == 7
    assert len(questions) == 3
    for name, state in states.items():
        input_assertion_count = sum(len(state.index.assertions(key)) for key in state.index.keys())
        assert input_assertion_count >= 1, name
        for question in questions:
            reliability = project(state, RELIABILITY, question=question)
            discovery = project(state, DISCOVERY, question=question)
            assert len(discovery.nodes) >= 3
            if not reliability.nodes:
                assert reliability.nodes == ()
                assert reliability.edges == ()
            for ir in ((reliability,) if reliability.nodes else ()) + (discovery,):
                node_ids = {node.id for node in ir.nodes}
                assert len(node_ids) == len(ir.nodes)
                assert all(edge.source in node_ids and edge.target in node_ids for edge in ir.edges)
                for node in ir.nodes:
                    if node.kind in (NodeKind.SOURCE, NodeKind.SUBJECT, NodeKind.CLUSTER):
                        assert any(edge.source == node.id or edge.target == node.id for edge in ir.edges)
            reliability_ids = {node.id for node in reliability.nodes} | {edge.id for edge in reliability.edges}
            discovery_ids = {node.id for node in discovery.nodes} | {edge.id for edge in discovery.edges}
            assert reliability_ids <= discovery_ids
            discovery_payload = {
                item["id"]: item
                for section in (discovery.as_payload()["nodes"], discovery.as_payload()["edges"])
                for item in section
            }
            reliability_payload = {
                item["id"]: item
                for section in (reliability.as_payload()["nodes"], reliability.as_payload()["edges"])
                for item in section
            }
            assert len(reliability_payload) == len(reliability_ids)
            for identifier, payload in reliability_payload.items():
                assert canonical_bytes(payload) == canonical_bytes(discovery_payload[identifier])

    strict_state = states["accepted-bridge"]
    strict_discovery = project(strict_state, DISCOVERY)
    strict_reliability = project(strict_state, RELIABILITY)
    card_id = strict_state.bridges[0].card_id
    assert ({node.id for node in strict_discovery.nodes} | {edge.id for edge in strict_discovery.edges}) - (
        {node.id for node in strict_reliability.nodes} | {edge.id for edge in strict_reliability.edges}
    ) == {
        f"bridge:{card_id}",
        "cluster:cluster-a",
        f"source:{_SOURCE_B}",
        f"in-cluster:{card_id}",
        f"side:{card_id}:left",
        f"side:{card_id}:right",
    }


def test_reliability_scopes_orphans_and_filtering_is_idempotent() -> None:
    """This claims idempotence only; it does not claim how many passes filter uses."""
    bridge_only = _state(bridges=(_card("H", epistemic=EpistemicClass.SPECULATIVE),))
    reliability = project(bridge_only, RELIABILITY)
    discovery = project(bridge_only, DISCOVERY)
    assert reliability.nodes == ()
    assert reliability.edges == ()
    assert len(discovery.nodes) == 4
    assert len(discovery.edges) == 3

    excluded = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAJ", "late", recorded_day=5)
    excluded_state = _state((("excluded", excluded),))
    excluded_reliability = project(excluded_state, RELIABILITY, question=TemporalQuestion(recorded_as_of=_instant(2)))
    excluded_discovery = project(excluded_state, DISCOVERY, question=TemporalQuestion(recorded_as_of=_instant(2)))
    assert "source:src_01ARZ3NDEKTSV4RRFFQ69G5FAV" not in {node.id for node in excluded_reliability.nodes}
    assert "source:src_01ARZ3NDEKTSV4RRFFQ69G5FAV" in {node.id for node in excluded_discovery.nodes}

    once = project(_all_kind_state(), DISCOVERY)
    assert len(once.nodes) == 9
    assert len(once.edges) == 10
    assert projection_module._filter(once, DISCOVERY) == once


# This is deliberately a test-local inventory: adding a payload dimension requires
# both an entry here and a row below.  It never calls projection to derive expected ids.
_DISCRIMINATION_FIELD_MAP = {
    "assertion_text": "Assertion.text",
    "assertion_support": "Assertion.support",
    "assertion_lifecycle": "Assertion.state",
    "assertion_recorded_at": "Assertion.recorded_at",
    "assertion_valid_from": "Assertion.valid_from",
    "assertion_valid_to": "Assertion.valid_to",
    "provenance_source_id": "Citation.source_id",
    "provenance_snapshot_digest": "Citation.snapshot_digest",
    "provenance_start_byte": "Locator.start_byte",
    "provenance_end_byte": "Locator.end_byte",
    "provenance_span": "Citation.span",
    "subject_key": "ClaimKey.value",
    "conflict_overlap": "Conflict.overlap",
    "conflict_members": "Conflict.members",
    "temporal_disposition": "AsOf partition",
    "cluster_id": "BridgeCard.cluster_id",
    "bridge_epistemic_class": "BridgeCard.epistemic_class",
    "bridge_depth": "BridgeCard.depth",
    "bridge_non_triviality": "BridgeCard.non_triviality",
    "bridge_consequence": "BridgeCard.consequence",
    "bridge_noise_objection": "BridgeCard.noise_objection",
    "bridge_origin_round": "BridgeCard.origin_round",
    "bridge_gate_outcomes": "GateVector.outcomes",
    "bridge_gate_reasons": "GateVector.reasons",
    "bridge_triviality": "GateVector.triviality",
    "bridge_disposition": "GateVector disposition",
    "side_assignment": "Endpoint position",
    "endpoint_project": "Endpoint.project",
    "endpoint_quote": "Endpoint.quote",
    "rejection_failed_gate": "Rejection.failed_gate",
    "rejection_reason": "Rejection.reason",
    "rejection_round_number": "Rejection.round_number",
    "rejection_rejected_at": "Rejection.rejected_at",
}


def _payload_slot_rows(payload: dict[str, object]) -> dict[str, tuple[object, object]]:
    """Return old/new values for every declared wire dimension, each changed alone."""
    nodes = {item["kind"]: item for item in payload["nodes"]}  # type: ignore[index]
    assertion = nodes["assertion"]["attributes"]
    conflict = nodes["conflict"]["attributes"]
    bridge = nodes["bridge"]["attributes"]
    rejection = nodes["rejection"]["attributes"]
    sides = [item for item in payload["edges"] if item["kind"] == "bridge_side"]  # type: ignore[index]
    return {
        "assertion_text": (assertion["text"], "changed assertion text"),
        "assertion_support": (assertion["support"], SupportClass.INFERRED.value),
        "assertion_lifecycle": (assertion["lifecycle"], LifecycleState.REJECTED.value),
        "assertion_recorded_at": (assertion["recorded_at"], _instant(3).isoformat()),
        "assertion_valid_from": (assertion["valid_from"], _instant(3).isoformat()),
        "assertion_valid_to": (assertion["valid_to"], _instant(6).isoformat()),
        "provenance_source_id": (assertion["provenance"]["source_id"], "src_changed"),
        "provenance_snapshot_digest": (assertion["provenance"]["snapshot_digest"], "1" * 64),
        "provenance_start_byte": (assertion["provenance"]["start_byte"], 1),
        "provenance_end_byte": (assertion["provenance"]["end_byte"], 2),
        "provenance_span": (assertion["provenance"]["span"], "y"),
        "subject_key": (nodes["subject"]["attributes"]["key"], "subject-b"),
        "conflict_overlap": (conflict["overlap"], Overlap.UNDETERMINED.value),
        "conflict_members": (conflict["members"], list(reversed(conflict["members"]))),
        "temporal_disposition": (assertion["temporal"], TemporalDisposition.UNDETERMINED.value),
        "cluster_id": (bridge["cluster_id"], "cluster-b"),
        "bridge_epistemic_class": (bridge["epistemic_class"], EpistemicClass.EXPLICIT.value),
        "bridge_depth": (bridge["depth"], Depth.MODERATE.value),
        "bridge_non_triviality": (bridge["non_triviality"], "changed non triviality"),
        "bridge_consequence": (bridge["consequence"], "changed consequence"),
        "bridge_noise_objection": (bridge["noise_objection"], "changed objection"),
        "bridge_origin_round": (bridge["origin_round"], 2),
        "bridge_gate_outcomes": (bridge["gate_outcomes"][0][1], GateOutcome.UNKNOWN.value),
        "bridge_gate_reasons": (bridge["gate_reasons"][0][1], "changed reason"),
        "bridge_triviality": (bridge["triviality"], "changed archetype"),
        "bridge_disposition": (bridge["disposition"], BridgeDisposition.UNDETERMINED.value),
        "side_assignment": (sides[0]["attributes"]["side"], "right"),
        "endpoint_project": (sides[0]["attributes"]["project"], "changed-project"),
        "endpoint_quote": (sides[0]["attributes"]["quote"], "changed quote"),
        "rejection_failed_gate": (rejection["failed_gate"], Gate.G2.value),
        "rejection_reason": (rejection["reason"], "changed rejection"),
        "rejection_round_number": (rejection["round_number"], 2),
        "rejection_rejected_at": (rejection["rejected_at"], _instant(3).isoformat()),
    }


def test_discrimination_table_has_one_digest_bearing_row_per_declared_dimension() -> None:
    """Each row changes one wire slot; it does not claim semantic mapping honesty."""
    card = _card("K", failed=Gate.G1)
    state = _state(
        (
            ("dimension", _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAK", "one", valid_to=4)),
            ("dimension", _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAM", "two", valid_from=2, valid_to=5)),
        ),
        bridges=(card,),
        rejections=(_rejection(),),
    )
    base = substrate(state).as_payload()
    rows = _payload_slot_rows(base)
    assert set(rows) == set(_DISCRIMINATION_FIELD_MAP)
    assert len(rows) == 33
    for dimension, (old, new) in rows.items():
        assert old != new, dimension
        changed = copy.deepcopy(base)
        # Locate the same scalar in exactly one declared slot; duplicate values are
        # avoided by the fixture above, so the negative control is singular.
        def replace_one(value: object) -> bool:
            if type(value) is dict:
                for key, item in value.items():
                    if item == old:
                        value[key] = new
                        return True
                    if replace_one(item):
                        return True
            elif type(value) is list:
                for position, item in enumerate(value):
                    if item == old:
                        value[position] = new
                        return True
                    if replace_one(item):
                        return True
            return False
        assert replace_one(changed), dimension
        assert canonical_bytes(base) != canonical_bytes(changed), dimension
        assert digest_payload(base) != digest_payload(changed), dimension


def test_utc_offset_spelling_is_a_digest_invariance_row() -> None:
    """This is deliberately invariance, not discrimination: both values name one instant."""
    utc = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAM", "offset", recorded_day=2)
    offset = replace(utc, recorded_at=datetime(2026, 1, 2, 1, tzinfo=timezone(timedelta(hours=1))))
    assert utc.recorded_at.isoformat() != offset.recorded_at.isoformat()
    assert utc.recorded_at.astimezone(timezone.utc) == offset.recorded_at.astimezone(timezone.utc)
    assert substrate(_state((("offset", utc),))).ir_digest == substrate(_state((("offset", offset),))).ir_digest


def test_wire_payload_encodes_closed_values_and_matches_assertion_normalisation() -> None:
    card = _card("N", failed=Gate.G1)
    assertion = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAN", "wire", recorded_day=2)
    ir = substrate(_state((("wire", assertion),), bridges=(card,), rejections=(_rejection(),)))
    payload = ir.as_payload()
    assert canonical_bytes(payload)
    assertion_payload = next(item for item in payload["nodes"] if item["kind"] == "assertion")["attributes"]
    bridge_payload = next(item for item in payload["nodes"] if item["kind"] == "bridge")["attributes"]
    assert assertion_payload["support"] == assertion.support.value
    assert assertion_payload["recorded_at"] == assertion.content_payload()["recorded_at"]
    assert assertion_payload["valid_from"] is not None
    assert bridge_payload["triviality"] is None
    assert type(bridge_payload["gate_outcomes"]) is list
    assert bridge_payload["gate_outcomes"] == [[gate.value, card.gates.outcome(gate).value] for gate in Gate]


def test_projection_context_carries_both_temporal_axes_and_policy_when_graph_is_identical() -> None:
    """The equal-graph controls isolate context; ALL_TIME is not a claim about now."""
    unbounded = replace(_assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAP", "unbounded"), valid_from=None, valid_to=None)
    state = _state((("context", unbounded),))
    all_time = project(state, RELIABILITY)
    valid_two = project(state, RELIABILITY, question=TemporalQuestion(valid_at=_instant(2)))
    valid_three = project(state, RELIABILITY, question=TemporalQuestion(valid_at=_instant(3)))
    recorded_two = project(state, RELIABILITY, question=TemporalQuestion(recorded_as_of=_instant(2)))
    recorded_three = project(state, RELIABILITY, question=TemporalQuestion(recorded_as_of=_instant(3)))
    mixed = project(state, RELIABILITY, question=TemporalQuestion(valid_at=_instant(2), recorded_as_of=_instant(3)))
    assert len(all_time.nodes) == 3
    assert next(node for node in all_time.nodes if node.kind is NodeKind.ASSERTION).attributes.temporal is TemporalDisposition.ESTABLISHED
    for left, right in ((valid_two, valid_three), (recorded_two, recorded_three), (valid_two, mixed)):
        assert left.nodes == right.nodes
        assert left.edges == right.edges
        assert left.ir_digest != right.ir_digest
    equivalent_policy = ProjectionPolicy(
        PolicyId.EXPERIMENTAL,
        RELIABILITY.admit_kinds,
        RELIABILITY.admit_temporal,
        RELIABILITY.admit_bridge_dispositions,
        RELIABILITY.admit_epistemic,
    )
    experimental = project(state, equivalent_policy)
    assert experimental.nodes == all_time.nodes
    assert experimental.edges == all_time.edges
    assert experimental.ir_digest != all_time.ir_digest
    offset_question = project(
        state,
        RELIABILITY,
        question=TemporalQuestion(valid_at=datetime(2026, 1, 2, 1, tzinfo=timezone(timedelta(hours=1)))),
    )
    assert offset_question.question.valid_at is not None
    assert offset_question.nodes == valid_two.nodes
    assert offset_question.edges == valid_two.edges
    assert offset_question.ir_digest == valid_two.ir_digest


def test_third_states_survive_in_payload_and_unknown_gate_has_its_own_disposition() -> None:
    unknown_support = replace(_assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAQ", "unknown support"), support=SupportClass.UNKNOWN)
    support_ir = substrate(_state((("third", unknown_support),)))
    support_node = next(node for node in support_ir.nodes if node.kind is NodeKind.ASSERTION)
    assert support_node.attributes.support is SupportClass.UNKNOWN
    assert next(item for item in support_ir.as_payload()["nodes"] if item["id"] == support_node.id)["attributes"]["support"] == "unknown"

    assert len(tuple(Gate)) == 6
    for gate in Gate:
        unknown_card = _card("R", unknown=gate)
        failed_card = _card("S", failed=gate)
        unknown_ir = substrate(_state(bridges=(unknown_card,)))
        failed_ir = substrate(_state(bridges=(failed_card,)))
        unknown_node = next(node for node in unknown_ir.nodes if node.id == f"bridge:{unknown_card.card_id}")
        failed_node = next(node for node in failed_ir.nodes if node.id == f"bridge:{failed_card.card_id}")
        assert unknown_node.attributes.gate_outcomes[list(Gate).index(gate)][1] is GateOutcome.UNKNOWN
        assert unknown_node.attributes.disposition is BridgeDisposition.UNDETERMINED
        assert failed_node.attributes.disposition is BridgeDisposition.REJECTED
        assert unknown_ir.ir_digest != failed_ir.ir_digest

    left = replace(_assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAT", "left"), valid_from=None, valid_to=None)
    right = replace(_assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAV", "right"), valid_from=None, valid_to=None)
    unknown_temporal = substrate(_state((("third", left), ("third", right))), question=TemporalQuestion(valid_at=_instant(2)))
    conflict = next(node for node in unknown_temporal.nodes if node.kind is NodeKind.CONFLICT)
    assert conflict.attributes.overlap is Overlap.UNDETERMINED
    assert all(
        node.attributes.temporal is TemporalDisposition.UNDETERMINED
        for node in unknown_temporal.nodes
        if node.kind is NodeKind.ASSERTION
    )


def test_shared_asr_namespace_and_cluster_merge_reproduce_source_join_semantics() -> None:
    """Cluster labels are free strings; run_round skips matching labels via rejected_clusters()."""
    shared = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAW"
    assertion = _assertion(shared, "assertion payload")
    card = replace(_card("W", cluster="review"), card_id=shared)
    other = _card("X", cluster="review", failed=Gate.G1)
    state = _state((("shared", assertion),), bridges=(card, other), rejections=(_rejection("review"),))
    ir = substrate(state)
    nodes = _node_by_id(ir)
    assert "assertion:asr_01ARZ3NDEKTSV4RRFFQ69G5FAW" in nodes
    assert "bridge:asr_01ARZ3NDEKTSV4RRFFQ69G5FAW" in nodes
    assert nodes["assertion:asr_01ARZ3NDEKTSV4RRFFQ69G5FAW"].kind is NodeKind.ASSERTION
    assert nodes["bridge:asr_01ARZ3NDEKTSV4RRFFQ69G5FAW"].kind is NodeKind.BRIDGE
    clusters = [node for node in ir.nodes if node.id == "cluster:review"]
    assert len(clusters) == 1
    merge_edges = [edge for edge in ir.edges if edge.target == "cluster:review"]
    assert len(merge_edges) == 3
    assert {edge.source for edge in merge_edges} == {
        f"bridge:{card.card_id}",
        f"bridge:{other.card_id}",
        _local_rejection_id(state.rejections[0]),
    }


def test_bridge_disposition_agrees_card_for_card_with_run_round(tmp_path: Path) -> None:
    cards = (
        _card("0"), _card("1"), _card("2"),
        _card("3", failed=Gate.G1), _card("4", failed=Gate.G2), _card("5", failed=Gate.G3),
        _card("6", unknown=Gate.G1), _card("7", unknown=Gate.G2), _card("8", unknown=Gate.G3),
    )
    expected_partition_counts = {"accepted": 3, "rejected": 3, "undetermined": 3}
    assert len(cards) == sum(expected_partition_counts.values())
    round_result = run_round(
        round_number=1,
        candidates=cards,
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=RejectionMemory(tmp_path / "rejections.jsonl"),
        at=_instant(2),
        consult_memory=False,
    )
    assert len(round_result.accepted) == expected_partition_counts["accepted"]
    assert len(round_result.rejected) == expected_partition_counts["rejected"]
    assert len(round_result.undetermined) == expected_partition_counts["undetermined"]
    projected = substrate(_state(bridges=cards))
    dispositions = {
        node.attributes.card_id: node.attributes.disposition
        for node in projected.nodes
        if node.kind is NodeKind.BRIDGE
    }
    assert len(dispositions) == len(cards)
    for card in round_result.accepted:
        assert dispositions[card.card_id] is BridgeDisposition.ACCEPTED
    for card in round_result.rejected:
        assert dispositions[card.card_id] is BridgeDisposition.REJECTED
    for card in round_result.undetermined:
        assert dispositions[card.card_id] is BridgeDisposition.UNDETERMINED


def test_projection_namespaces_hostile_cluster_labels_and_refuses_identity_conflicts() -> None:
    hostile = (_card("Y", cluster="conflict:deadbeef"), _card("Z", cluster="subject:x"))
    hostile_ir = substrate(_state(bridges=hostile))
    hostile_ids = {node.id for node in hostile_ir.nodes}
    assert "cluster:conflict:deadbeef" in hostile_ids
    assert "cluster:subject:x" in hostile_ids
    assert len(hostile_ids) == len(hostile_ir.nodes)

    first = _card("A", cluster="first")
    changed = replace(first, cluster_id="second")
    with pytest.raises(projection_module.ProjectionIdentityConflict, match="bridge:asr_01ARZ3NDEKTSV4RRFFQ69G5FA"):
        substrate(_state(bridges=(first, changed)))

    rejection = _rejection("collapsed")
    collapsed = substrate(_state(rejections=(rejection, rejection)))
    rejection_nodes = [node for node in collapsed.nodes if node.kind is NodeKind.REJECTION]
    assert len(rejection_nodes) == 1


def test_projection_round_trip_accepts_semantic_payload_change_and_refuses_broken_graph() -> None:
    """The restore route is checked over the A2-style state table, not one sample."""
    canonical = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FB2", "canon", valid_to=5)
    second = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FB3", "other", valid_from=2, valid_to=6)
    states = (
        _state((("table", canonical),), bridges=(_card("D", failed=Gate.G1),)),
        _state((("table", canonical),)),
        _state((("table", canonical), ("table", second))),
        _state((("table", canonical),), bridges=(_card("E"),)),
        _state((("table", canonical),), bridges=(_card("F", failed=Gate.G1),)),
        _state((("table", canonical),), bridges=(_card("G", unknown=Gate.G2),)),
        _state((("table", replace(canonical, valid_from=None, valid_to=None)),)),
    )
    assert len(states) == 7
    for state in states:
        assert sum(len(state.index.assertions(key)) for key in state.index.keys()) >= 1
        ir = substrate(state)
        payload = ir.as_payload()
        assert from_payload(payload) == ir
        assert from_payload(payload).ir_digest == ir.ir_digest

    semantic = copy.deepcopy(substrate(_all_kind_state()).as_payload())
    assertion_payload = next(item for item in semantic["nodes"] if item["kind"] == "assertion")
    assertion_payload["attributes"]["text"] = "semantically different text"
    restored = from_payload(semantic)
    original = from_payload(substrate(_all_kind_state()).as_payload())
    assert restored != original
    assert restored.ir_digest != original.ir_digest

    broken = copy.deepcopy(substrate(_all_kind_state()).as_payload())
    broken["nodes"][1]["id"] = broken["nodes"][0]["id"]
    with pytest.raises(projection_module.ProjectionIdentityConflict, match="unique"):
        from_payload(broken)


def _ordered_state(case: int, order: tuple[int, ...]) -> KnowledgeState:
    assertions = (
        _assertion(f"asr_{case * 10 + 1:026X}", "same", valid_to=4),
        _assertion(f"asr_{case * 10 + 2:026X}", "same", valid_to=4),
    )
    cards = (_card("B", cluster=f"Case-{case}"), _card("C", cluster=f"case-{case}"))
    rejections = (_rejection(f"tie-{case}", round_number=1), _rejection(f"tie-{case}", round_number=2))
    return _state(
        tuple(("ties", assertions[position]) for position in order),
        bridges=tuple(cards[position] for position in order),
        rejections=tuple(rejections[position] for position in order),
    )


def test_projection_is_deterministic_across_shuffled_insertions_and_genuine_ties() -> None:
    orders = ((0, 1), (1, 0), (0, 1))
    expected_assertion_count = 2
    assert len(orders) == 3
    cases = (1, 2, 3, 4)
    assert len(cases) == 4
    for case in cases:
        payloads = []
        digests = []
        for order in orders:
            state = _ordered_state(case, order)
            assert sum(len(state.index.assertions(key)) for key in state.index.keys()) == expected_assertion_count
            ir = substrate(state)
            payloads.append(canonical_bytes(ir.as_payload()))
            digests.append(ir.ir_digest)
        assert len(set(payloads)) == 1
        assert len(set(digests)) == 1


def test_projection_digest_is_hash_seed_stable_in_fresh_interpreters() -> None:
    """PYTHONHASHSEED is supplied before each subprocess starts, never monkeypatched in pytest."""
    program = '''
from datetime import datetime, timezone
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey, TemporalIndex
from nous_os.projection import KnowledgeState, substrate
t = datetime(2026, 1, 1, tzinfo=timezone.utc)
i = TemporalIndex()
for suffix in ("B", "A"):
    a = Assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5F" + suffix, "tie", Citation("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", "0" * 64, Locator(0, 1), "x"), SupportClass.DIRECT_QUOTE, t, LifecycleState.CANONICAL, t, datetime(2026, 1, 3, tzinfo=timezone.utc))
    i.add(ClaimKey("seed"), a)
print(substrate(KnowledgeState(i)).ir_digest)
'''
    digests = []
    for seed in ("0", "1", "12345", "99991"):
        environment = os.environ.copy()
        environment["PYTHONHASHSEED"] = seed
        source_root = str(Path(__file__).resolve().parents[1] / "src")
        environment["PYTHONPATH"] = source_root + os.pathsep + environment.get("PYTHONPATH", "")
        completed = subprocess.run(
            [sys.executable, "-c", program],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            text=True,
            capture_output=True,
            check=True,
        )
        digests.append(completed.stdout.strip())
    assert len(digests) == 4
    assert len(set(digests)) == 1


_DERIVATION_RULES = frozenset(
    {
        "node-id-namespacing",
        "node-kind",
        "edge-id-about",
        "edge-id-cites",
        "edge-id-member",
        "edge-id-side",
        "edge-id-in-cluster",
        "edge-id-rejects",
        "edge-kind",
        "edge-endpoint",
        "conflict-id",
        "rejection-id",
        "temporal-disposition",
        "bridge-disposition",
        "side",
        "schema-version",
        "policy-id",
        "temporal-question-context",
    }
)


def _ir_dataclasses(module: object) -> tuple[type[object], ...]:
    """Inspect the module for emitted-record dataclasses, not an authored class list."""
    return tuple(
        value
        for _name, value in inspect.getmembers(module, inspect.isclass)
        if value.__module__ == module.__name__
        and is_dataclass(value)
        and (
            value.__name__.endswith("Attributes")
            or value.__name__
            in {"ProvenanceRef", "ProjectionNode", "ProjectionEdge", "ProjectionIR", "TemporalQuestion"}
        )
    )


_FIELD_REGISTER = {
    "ProvenanceRef.source_id": "source:nous_os.provenance.Citation.source_id",
    "ProvenanceRef.snapshot_digest": "source:nous_os.provenance.Citation.snapshot_digest",
    "ProvenanceRef.start_byte": "source:nous_os.provenance.Locator.start_byte",
    "ProvenanceRef.end_byte": "source:nous_os.provenance.Locator.end_byte",
    "ProvenanceRef.span": "source:nous_os.provenance.Citation.span",
    "SourceAttributes.source_id": "source:nous_os.provenance.Citation.source_id",
    "SubjectAttributes.key": "source:nous_os.temporal.ClaimKey.value",
    "ClusterAttributes.cluster_id": "source:nous_os.discovery.BridgeCard.cluster_id",
    "AssertionAttributes.assertion_id": "source:nous_os.canonical.Assertion.id",
    "AssertionAttributes.text": "source:nous_os.canonical.Assertion.text",
    "AssertionAttributes.support": "source:nous_os.canonical.Assertion.support",
    "AssertionAttributes.lifecycle": "source:nous_os.canonical.Assertion.state",
    "AssertionAttributes.recorded_at": "source:nous_os.canonical.Assertion.recorded_at",
    "AssertionAttributes.valid_from": "source:nous_os.canonical.Assertion.valid_from",
    "AssertionAttributes.valid_to": "source:nous_os.canonical.Assertion.valid_to",
    "AssertionAttributes.provenance": "source:nous_os.canonical.Assertion.citation",
    "AssertionAttributes.temporal": "derived:temporal-disposition",
    "ConflictAttributes.subject_key": "source:nous_os.temporal.Conflict.key",
    "ConflictAttributes.overlap": "source:nous_os.temporal.Conflict.overlap",
    "ConflictAttributes.members": "source:nous_os.temporal.Conflict.members",
    "BridgeAttributes.card_id": "source:nous_os.discovery.BridgeCard.card_id",
    "BridgeAttributes.cluster_id": "source:nous_os.discovery.BridgeCard.cluster_id",
    "BridgeAttributes.epistemic_class": "source:nous_os.discovery.BridgeCard.epistemic_class",
    "BridgeAttributes.depth": "source:nous_os.discovery.BridgeCard.depth",
    "BridgeAttributes.non_triviality": "source:nous_os.discovery.BridgeCard.non_triviality",
    "BridgeAttributes.consequence": "source:nous_os.discovery.BridgeCard.consequence",
    "BridgeAttributes.noise_objection": "source:nous_os.discovery.BridgeCard.noise_objection",
    "BridgeAttributes.origin_round": "source:nous_os.discovery.BridgeCard.origin_round",
    "BridgeAttributes.gate_outcomes": "source:nous_os.discovery.GateVector.outcomes",
    "BridgeAttributes.gate_reasons": "source:nous_os.discovery.GateVector.reasons",
    "BridgeAttributes.triviality": "source:nous_os.discovery.GateVector.triviality",
    "BridgeAttributes.disposition": "derived:bridge-disposition",
    "RejectionAttributes.cluster_id": "source:nous_os.adjudication.Rejection.cluster_id",
    "RejectionAttributes.failed_gate": "source:nous_os.adjudication.Rejection.failed_gate",
    "RejectionAttributes.reason": "source:nous_os.adjudication.Rejection.reason",
    "RejectionAttributes.round_number": "source:nous_os.adjudication.Rejection.round_number",
    "RejectionAttributes.rejected_at": "source:nous_os.adjudication.Rejection.rejected_at",
    "_BridgeSideAttributes.side": "derived:side",
    "_BridgeSideAttributes.project": "source:nous_os.discovery.Endpoint.project",
    "_BridgeSideAttributes.quote": "source:nous_os.discovery.Endpoint.quote",
    "_BridgeSideAttributes.provenance": "source:nous_os.discovery.Endpoint.citation",
    "ProjectionNode.id": "derived:node-id-namespacing",
    "ProjectionNode.kind": "derived:node-kind",
    "ProjectionNode.attributes": "source:nous_os.projection.ProjectionNode.attributes",
    "ProjectionEdge.id": "derived:edge-id-about",
    "ProjectionEdge.kind": "derived:edge-kind",
    "ProjectionEdge.source": "derived:edge-endpoint",
    "ProjectionEdge.target": "derived:edge-endpoint",
    "ProjectionEdge.attributes": "source:nous_os.projection.ProjectionEdge.attributes",
    "TemporalQuestion.valid_at": "source:nous_os.projection.TemporalQuestion.valid_at",
    "TemporalQuestion.recorded_as_of": "source:nous_os.projection.TemporalQuestion.recorded_as_of",
    "ProjectionIR.schema_version": "derived:schema-version",
    "ProjectionIR.policy_id": "derived:policy-id",
    "ProjectionIR.question": "derived:temporal-question-context",
    "ProjectionIR.nodes": "source:nous_os.projection.ProjectionIR.nodes",
    "ProjectionIR.edges": "source:nous_os.projection.ProjectionIR.edges",
}


_RULE_PINNING_TESTS = {
    "node-id-namespacing": "test_projection_namespaces_hostile_cluster_labels_and_refuses_identity_conflicts",
    "node-kind": "test_substrate_emits_a_small_canonical_assertion_graph",
    "edge-id-about": "test_substrate_emits_a_small_canonical_assertion_graph",
    "edge-id-cites": "test_substrate_emits_a_small_canonical_assertion_graph",
    "edge-id-member": "test_substrate_neither_omits_nor_invents_known_ids",
    "edge-id-side": "test_substrate_neither_omits_nor_invents_known_ids",
    "edge-id-in-cluster": "test_substrate_neither_omits_nor_invents_known_ids",
    "edge-id-rejects": "test_substrate_neither_omits_nor_invents_known_ids",
    "edge-kind": "test_policy_filters_substrate_elements_without_reinterpreting_them",
    "edge-endpoint": "test_whole_graph_validation_rejects_each_named_defect_on_both_routes",
    "conflict-id": "test_conflict_is_projected_whole_or_not_at_all_after_temporal_filtering",
    "rejection-id": "test_substrate_neither_omits_nor_invents_known_ids",
    "temporal-disposition": "test_third_states_survive_in_payload_and_unknown_gate_has_its_own_disposition",
    "bridge-disposition": "test_bridge_disposition_agrees_card_for_card_with_run_round",
    "side": "test_substrate_neither_omits_nor_invents_known_ids",
    "schema-version": "test_projection_round_trip_accepts_semantic_payload_change_and_refuses_broken_graph",
    "policy-id": "test_projection_context_carries_both_temporal_axes_and_policy_when_graph_is_identical",
    "temporal-question-context": "test_projection_context_carries_both_temporal_axes_and_policy_when_graph_is_identical",
}


def _register_keys(classes: tuple[type[object], ...]) -> set[str]:
    return {f"{cls.__name__}.{field.name}" for cls in classes for field in fields(cls)}


def _assert_register_coverage(classes: tuple[type[object], ...], register: dict[str, str]) -> None:
    assert set(register) == _register_keys(classes)


def _assert_source_register_resolves(register: dict[str, str]) -> None:
    for mapping in register.values():
        if not mapping.startswith("source:"):
            continue
        module_name, class_name, attribute = mapping.removeprefix("source:").rsplit(".", 2)
        source_module = __import__(module_name, fromlist=[class_name])
        source_class = getattr(source_module, class_name)
        assert attribute in {field.name for field in fields(source_class)} or isinstance(
            getattr(source_class, attribute, None), property
        )


def test_field_register_covers_declared_ir_fields_and_only_uses_pinned_derivations() -> None:
    """This mechanical register catches undeclared drift, not renderer coupling or mapping honesty."""
    classes = _ir_dataclasses(projection_module)
    assert len(classes) == 13
    _assert_register_coverage(classes, _FIELD_REGISTER)
    _assert_source_register_resolves(_FIELD_REGISTER)
    assert len(_DERIVATION_RULES) == 18
    derived = {value.removeprefix("derived:") for value in _FIELD_REGISTER.values() if value.startswith("derived:")}
    assert derived
    assert derived <= _DERIVATION_RULES
    test_names = {
        name
        for name, value in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if name.startswith("test_") and value.__module__ == __name__
    }
    assert len(_RULE_PINNING_TESTS) == len(_DERIVATION_RULES)
    assert set(_RULE_PINNING_TESTS) == _DERIVATION_RULES
    assert set(_RULE_PINNING_TESTS.values()) <= test_names

    @dataclass(frozen=True)
    class SyntheticRecord:
        missing: str

    with pytest.raises(AssertionError):
        _assert_register_coverage((SyntheticRecord,), {})
    with pytest.raises(AssertionError):
        _assert_source_register_resolves({"SyntheticRecord.missing": "source:nous_os.canonical.Assertion.colour"})


def test_field_register_refused_vocabulary_is_a_secondary_sample_not_a_euphemism_detector() -> None:
    """Secondary sample only: obvious renderer words are refused, but a euphemism can evade it."""
    refused = {"colour", "color", "display", "geometry", "layout", "renderer", "theme"}
    names = {
        field.name.lower()
        for cls in _ir_dataclasses(projection_module)
        for field in fields(cls)
    }
    values = {
        member.value.lower()
        for _name, enum_class in inspect.getmembers(projection_module, inspect.isclass)
        if enum_class.__module__ == projection_module.__name__ and issubclass(enum_class, projection_module.Enum)
        for member in enum_class
    }
    assert len(_register_keys(_ir_dataclasses(projection_module))) == 56
    assert names
    assert values
    assert not any(token in name for token in refused for name in names | values)


def _graph_payload(
    nodes: tuple[object, ...], edges: tuple[object, ...]
) -> dict[str, object]:
    """Serialize hand-built graph records for the independent restore route."""
    return {
        "schema_version": projection_module.SCHEMA_VERSION,
        "policy_id": PolicyId.DISCOVERY.value,
        "question": {"valid_at": None, "recorded_as_of": None},
        "nodes": [projection_module._node_payload(node) for node in nodes],
        "edges": [projection_module._edge_payload(edge) for edge in edges],
    }


def _invalid_graph_cases() -> tuple[tuple[str, tuple[object, ...], tuple[object, ...]], ...]:
    """Change precisely one invariant from a complete valid graph per case."""
    first = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAA", "first", valid_to=4)
    second = _assertion("asr_01ARZ3NDEKTSV4RRFFQ69G5FAB", "second", valid_from=2, valid_to=5)
    base = substrate(
        _state(
            (("subject-a", first), ("subject-a", second)),
            bridges=(_card("C"),),
            rejections=(_rejection("cluster-b"),),
        )
    )
    nodes, edges = base.nodes, base.edges
    node = {item.id: item for item in nodes}
    edge = {item.id: item for item in edges}
    assertion = next(item for item in nodes if item.kind is NodeKind.ASSERTION)
    conflict = next(item for item in nodes if item.kind is NodeKind.CONFLICT)
    bridge = next(item for item in nodes if item.kind is NodeKind.BRIDGE)
    rejection = next(item for item in nodes if item.kind is NodeKind.REJECTION)
    about = next(item for item in edges if item.kind is EdgeKind.ABOUT)
    cites = next(item for item in edges if item.kind is EdgeKind.CITES)
    member = next(item for item in edges if item.kind is EdgeKind.CONFLICT_MEMBER)
    left = next(
        item
        for item in edges
        if item.kind is EdgeKind.BRIDGE_SIDE and item.attributes.side is projection_module.Side.LEFT
    )
    right = next(
        item
        for item in edges
        if item.kind is EdgeKind.BRIDGE_SIDE and item.attributes.side is projection_module.Side.RIGHT
    )
    in_cluster = next(item for item in edges if item.kind is EdgeKind.IN_CLUSTER)
    rejects = next(item for item in edges if item.kind is EdgeKind.REJECTS)
    changed_ref = projection_module.ProvenanceRef(_SOURCE_B, _DIGEST, 0, 1, "x")

    def replace_edge(original: object, changed: object) -> tuple[object, ...]:
        return tuple(changed if item is original else item for item in edges)

    return (
        ("duplicate node id", nodes + (replace(node["subject:subject-a"], id=assertion.id),), edges),
        ("duplicate edge id", nodes, edges + (replace(about, source=about.source),)),
        ("absent endpoint", nodes, replace_edge(about, replace(about, target="subject:absent"))),
        ("ABOUT wrong endpoint", nodes, replace_edge(about, replace(about, target=f"source:{_SOURCE}"))),
        ("BRIDGE only LEFT", nodes, tuple(item for item in edges if item is not right)),
        (
            "BRIDGE two LEFT",
            nodes,
            replace_edge(right, replace(right, attributes=replace(right.attributes, side=projection_module.Side.LEFT))),
        ),
        (
            "IN_CLUSTER wrong bridge cluster",
            nodes,
            replace_edge(in_cluster, replace(in_cluster, target="cluster:cluster-b")),
        ),
        ("CITES provenance mismatch", nodes, replace_edge(cites, replace(cites, attributes=changed_ref))),
        ("CONFLICT missing member", nodes, tuple(item for item in edges if item is not member)),
        (
            "orphan SOURCE",
            nodes + (projection_module.ProjectionNode("source:orphan", NodeKind.SOURCE, projection_module.SourceAttributes("orphan")),),
            edges,
        ),
        ("BRIDGE_SIDE overflow", nodes, edges + (replace(right, id="side:overflow", attributes=right.attributes),)),
        ("ABOUT overflow", nodes, edges + (replace(about, id="about:overflow"),)),
        ("CITES overflow", nodes, edges + (replace(cites, id="cites:overflow"),)),
        ("IN_CLUSTER overflow", nodes, edges + (replace(in_cluster, id="in-cluster:overflow"),)),
        ("REJECTS overflow", nodes, edges + (replace(rejects, id="rejects:overflow"),)),
        ("CONFLICT_MEMBER overflow", nodes, edges + (replace(member, id="member:overflow"),)),
        ("CITES wrong endpoint", nodes, replace_edge(cites, replace(cites, target="subject:subject-a"))),
        ("CONFLICT_MEMBER wrong endpoint", nodes, replace_edge(member, replace(member, target="subject:subject-a"))),
        ("BRIDGE_SIDE wrong endpoint", nodes, replace_edge(left, replace(left, target="cluster:cluster-a"))),
        ("IN_CLUSTER wrong endpoint", nodes, replace_edge(in_cluster, replace(in_cluster, target=f"source:{_SOURCE}"))),
        ("REJECTS wrong endpoint", nodes, replace_edge(rejects, replace(rejects, target=f"source:{_SOURCE}"))),
    )


def test_whole_graph_validation_rejects_each_named_defect_on_both_routes() -> None:
    """Direct construction and payload restoration reject the same one-variable graph defects."""
    repaired = substrate(_all_kind_state())
    assert len(repaired.nodes) == 9
    assert len(repaired.edges) == 10
    assert projection_module.ProjectionIR(
        repaired.schema_version, repaired.policy_id, repaired.question, repaired.nodes, repaired.edges
    ) == repaired
    assert from_payload(repaired.as_payload()) == repaired

    cases = _invalid_graph_cases()
    assert len(cases) == 21
    assert {name for name, _nodes, _edges in cases} >= {
        "ABOUT wrong endpoint",
        "CITES wrong endpoint",
        "CONFLICT_MEMBER wrong endpoint",
        "BRIDGE_SIDE wrong endpoint",
        "IN_CLUSTER wrong endpoint",
        "REJECTS wrong endpoint",
    }
    for name, nodes, edges in cases:
        assert projection_module.ProjectionIR(
            repaired.schema_version, repaired.policy_id, repaired.question, repaired.nodes, repaired.edges
        ) == repaired
        with pytest.raises(projection_module.ProjectionError) as direct:
            projection_module.ProjectionIR(projection_module.SCHEMA_VERSION, PolicyId.DISCOVERY, ALL_TIME, nodes, edges)
        with pytest.raises(type(direct.value)) as restored:
            from_payload(_graph_payload(nodes, edges))
        assert str(restored.value) == str(direct.value), name


def _imports_in(tree: ast.AST) -> set[str]:
    imports: set[str] = set()
    for item in ast.walk(tree):
        if type(item) is ast.Import:
            imports.update(f"import:{alias.name}" for alias in item.names)
        elif type(item) is ast.ImportFrom:
            imports.add(f"from:{item.module}")
    return imports


def _nonliteral_dynamic_accesses(tree: ast.AST) -> set[str]:
    refused: set[str] = set()
    for item in ast.walk(tree):
        if type(item) is not ast.Call or type(item.func) is not ast.Name:
            continue
        if item.func.id in {"getattr", "setattr"}:
            position = 1
        elif item.func.id == "__import__":
            position = 0
        else:
            continue
        if len(item.args) <= position or not (
            type(item.args[position]) is ast.Constant and type(item.args[position].value) is str
        ):
            refused.add(item.func.id)
    for item in ast.walk(tree):
        if type(item) is ast.Attribute and type(item.value) is ast.Name and item.value.id == "importlib":
            refused.add("importlib")
    return refused


def _expression_name(expression: ast.expr, aliases: dict[str, str]) -> str | None:
    if type(expression) is ast.Name:
        return aliases.get(expression.id, expression.id)
    if type(expression) is ast.Attribute:
        parent = _expression_name(expression.value, aliases)
        return None if parent is None else f"{parent}.{expression.attr}"
    return None


def _clock_and_io_hits(tree: ast.AST) -> set[str]:
    """Resolve simple imports, aliases, and re-exports before applying this secondary net."""
    aliases: dict[str, str] = {}
    for item in tree.body:  # type: ignore[union-attr]
        if type(item) is ast.Import:
            for alias in item.names:
                aliases[alias.asname or alias.name] = alias.name
        elif type(item) is ast.ImportFrom and item.module is not None:
            for alias in item.names:
                aliases[alias.asname or alias.name] = f"{item.module}.{alias.name}"
        elif type(item) is ast.Assign and len(item.targets) == 1 and type(item.targets[0]) is ast.Name:
            source = _expression_name(item.value, aliases)
            if source is not None:
                aliases[item.targets[0].id] = source
    forbidden = {
        "datetime.datetime.now",
        "datetime.datetime.utcnow",
        "datetime.datetime.today",
        "datetime.date.today",
        "time.time",
        "time.monotonic",
        "time.perf_counter",
        "time.clock_gettime",
        "open",
        "pathlib.Path.open",
        "pathlib.Path.read_bytes",
        "pathlib.Path.read_text",
    }
    hits = set()
    for item in ast.walk(tree):
        if type(item) is ast.Call:
            name = _expression_name(item.func, aliases)
            if name in forbidden or (name is not None and (name.startswith("random.") or name.startswith("secrets."))):
                hits.add(name)
        elif type(item) is ast.Attribute and _expression_name(item, aliases) == "os.environ":
            hits.add("os.environ")
    return hits


def test_projection_module_has_the_pinned_import_and_dynamic_call_surface() -> None:
    """The exact allow-list is the purity property; the clock deny-list below is only a sample."""
    tree = ast.parse(Path(projection_module.__file__).read_text(encoding="utf-8"))
    allowed_imports = {
        "from:__future__",
        "from:dataclasses",
        "from:datetime",
        "from:enum",
        "from:typing",
        "from:nous_os.adjudication",
        "from:nous_os.canonical",
        "from:nous_os.discovery",
        "from:nous_os.identity",
        "from:nous_os.provenance",
        "from:nous_os.temporal",
    }
    assert _imports_in(tree) == allowed_imports
    assert not _nonliteral_dynamic_accesses(tree)

    control = ast.parse("\n".join((
        "def bad(name, value):",
        "    getattr(value, name)",
        "    setattr(value, name, value)",
        "    __import__(name)",
        "    importlib.import_module(name)",
    )))
    assert _nonliteral_dynamic_accesses(control) == {"getattr", "setattr", "__import__", "importlib"}


def test_projection_clock_deny_list_is_a_secondary_net_with_alias_and_reexport_control() -> None:
    """Secondary net only: it samples clock and IO hazards and cannot establish purity by itself."""
    tree = ast.parse(Path(projection_module.__file__).read_text(encoding="utf-8"))
    assert not _clock_and_io_hits(tree)
    control = ast.parse("\n".join((
        "from datetime import datetime as _dt",
        "clock = _dt",
        "_dt.now()",
        "clock.utcnow()",
    )))
    assert _clock_and_io_hits(control) == {"datetime.datetime.now", "datetime.datetime.utcnow"}

    state = _all_kind_state()
    assert canonical_bytes(project(state, DISCOVERY).as_payload()) == canonical_bytes(project(state, DISCOVERY).as_payload())


def _state_canon_digest(state: KnowledgeState) -> str:
    """A test-local read-only digest of the projection's canonical assertion input."""
    rows = []
    for key in state.index.keys():
        rows.extend((key.value, assertion.content_payload()) for assertion in state.index.assertions(key))
    return digest_payload(rows)


def test_project_is_governed_as_a_read_without_mutating_canon() -> None:
    """Well-formed calls isolate READ authority from projection semantics and canonical input."""
    assert operations_module is not None
    state = _small_state()
    before = _state_canon_digest(state)
    kwargs = {"state": state, "policy": RELIABILITY, "question": ALL_TIME}
    assert required_tier("project") is Tier.READ
    expected = project(**kwargs)
    assert execute(Grant("reader", frozenset({Tier.READ})), "project", **kwargs) == expected
    assert _state_canon_digest(state) == before
    for grant in (Grant("empty", frozenset()), Grant("proposer", frozenset({Tier.PROPOSE}))):
        assert project(**kwargs) == expected
        with pytest.raises(NotAuthorized):
            execute(grant, "project", **kwargs)
        assert _state_canon_digest(state) == before


def _functions_referencing_state_index(tree: ast.AST) -> set[str]:
    hits: set[str] = set()
    for function in (item for item in tree.body if type(item) in {ast.FunctionDef, ast.AsyncFunctionDef}):  # type: ignore[union-attr]
        if any(
            type(item) is ast.Attribute and type(item.value) is ast.Name and item.value.id == "state" and item.attr == "index"
            for item in ast.walk(function)
        ):
            hits.add(function.name)
    return hits


def test_only_read_state_references_the_knowledge_state_index() -> None:
    """This pins one materialisation boundary only; it does not claim atomicity or thread safety."""
    tree = ast.parse(Path(projection_module.__file__).read_text(encoding="utf-8"))
    assert _functions_referencing_state_index(tree) == {"_read_state"}
    control = ast.parse("\n".join((
        "def snapshot(state):",
        "    return state.index.keys()",
        "def emit(state):",
        "    return state.index.conflicts()",
    )))
    assert _functions_referencing_state_index(control) == {"snapshot", "emit"}


def _policy_with(
    *,
    kinds: frozenset[NodeKind] | None = None,
    temporal: frozenset[TemporalDisposition] | None = None,
    bridge_dispositions: frozenset[BridgeDisposition] | None = None,
    epistemic: frozenset[EpistemicClass] | None = None,
) -> ProjectionPolicy:
    return ProjectionPolicy(
        PolicyId.EXPERIMENTAL,
        frozenset(NodeKind) if kinds is None else kinds,
        frozenset(TemporalDisposition) if temporal is None else temporal,
        frozenset(BridgeDisposition) if bridge_dispositions is None else bridge_dispositions,
        frozenset(EpistemicClass) if epistemic is None else epistemic,
    )


def test_projection_policy_clauses_each_have_a_single_subject_control() -> None:
    """Each coherence and admission clause gets a refusal and an identical accepted subject control."""
    all_kinds = frozenset(NodeKind)
    all_temporal = frozenset(TemporalDisposition)
    all_dispositions = frozenset(BridgeDisposition)
    all_epistemic = frozenset(EpistemicClass)
    cases = (
        (
            "ASSERTION admission requires SUBJECT admission",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.ASSERTION}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
            dict(kinds=frozenset({NodeKind.SOURCE}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
        ),
        (
            "CONFLICT admission requires ASSERTION admission",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.CONFLICT}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
            dict(kinds=frozenset({NodeKind.SOURCE}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
        ),
        (
            "BRIDGE admission requires CLUSTER admission",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE}), temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
        ),
        (
            "REJECTION admission requires CLUSTER admission",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.REJECTION}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.REJECTION, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=frozenset()),
        ),
        (
            "SOURCE must be admitted by kind",
            dict(kinds=all_kinds - {NodeKind.SOURCE}, temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
            dict(kinds=all_kinds, temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
        ),
        (
            "bridge admission and both bridge predicates must agree",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=frozenset(), epistemic=all_epistemic),
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
        ),
        (
            "bridge admission and both bridge predicates must agree",
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=frozenset()),
            dict(kinds=frozenset({NodeKind.SOURCE, NodeKind.BRIDGE, NodeKind.CLUSTER}), temporal=all_temporal,
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
        ),
        (
            "admit_temporal must not be empty",
            dict(kinds=all_kinds, temporal=frozenset(), bridge_dispositions=all_dispositions, epistemic=all_epistemic),
            dict(kinds=all_kinds, temporal=frozenset({TemporalDisposition.ESTABLISHED}),
                 bridge_dispositions=all_dispositions, epistemic=all_epistemic),
        ),
    )
    assert len(cases) == 8
    for message, bad, good in cases:
        with pytest.raises(ProjectionPolicyError, match=message):
            _policy_with(**bad)
        assert _policy_with(**good).policy_id is PolicyId.EXPERIMENTAL
