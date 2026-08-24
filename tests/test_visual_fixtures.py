"""Pin public Projection IR fixtures; this does not establish truth of synthetic claims."""

from __future__ import annotations

from collections import deque
import hashlib
import json
from pathlib import Path

from tests import visual_fixture_generator as generate
from nous_os.canonical import SupportClass
from nous_os.discovery import EpistemicClass, Gate, GateOutcome, TrivialityArchetype
from nous_os.identity import canonical_bytes
from nous_os.projection import (
    ALL_TIME,
    DISCOVERY,
    RELIABILITY,
    BridgeDisposition,
    EdgeKind,
    NodeKind,
    TemporalDisposition,
    project,
    substrate,
)
from nous_os.temporal import Overlap


FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "projection"
FIXTURES = {
    "reliability-all-time.json": (RELIABILITY, ALL_TIME),
    "discovery-all-time.json": (DISCOVERY, ALL_TIME),
    "reliability-at-question.json": (RELIABILITY, generate.QUESTION),
    "discovery-at-question.json": (DISCOVERY, generate.QUESTION),
}


def _payload(filename: str) -> dict[str, object]:
    value = json.loads((FIXTURE_DIR / filename).read_bytes())
    assert type(value) is dict
    return value


def _node_map(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    nodes = payload["nodes"]
    assert type(nodes) is list
    assert len(nodes) > 0
    result: dict[str, dict[str, object]] = {}
    for node in nodes:
        assert type(node) is dict
        assert type(node["id"]) is str
        result[node["id"]] = node
    assert len(result) == len(nodes)
    return result


def _edge_map(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    edges = payload["edges"]
    assert type(edges) is list
    assert len(edges) > 0
    result: dict[str, dict[str, object]] = {}
    for edge in edges:
        assert type(edge) is dict
        assert type(edge["id"]) is str
        result[edge["id"]] = edge
    assert len(result) == len(edges)
    return result


def _components(payload: dict[str, object]) -> tuple[frozenset[str], ...]:
    nodes = _node_map(payload)
    edges = _edge_map(payload)
    neighbours = {node_id: set() for node_id in nodes}
    for edge in edges.values():
        neighbours[edge["source"]].add(edge["target"])
        neighbours[edge["target"]].add(edge["source"])
    remaining = set(nodes)
    components: list[frozenset[str]] = []
    while remaining:
        start = next(iter(remaining))
        queue = deque([start])
        component: set[str] = set()
        while queue:
            node_id = queue.popleft()
            if node_id in component:
                continue
            component.add(node_id)
            remaining.discard(node_id)
            queue.extend(neighbours[node_id] - component)
        components.append(frozenset(component))
    assert len(components) > 0
    return tuple(components)


def test_fixture_bytes_equal_current_real_projection_output() -> None:
    state = generate.build_state()
    expected = {
        **{
            filename: canonical_bytes(project(state, policy, question=question).as_payload())
            for filename, (policy, question) in FIXTURES.items()
        },
        "substrate-all-time.json": canonical_bytes(substrate(state).as_payload()),
    }
    assert len(expected) == 5
    for filename, expected_bytes in expected.items():
        actual = (FIXTURE_DIR / filename).read_bytes()
        assert len(actual) > 0
        assert actual == expected_bytes, filename


def test_manifest_hashes_and_counts_pin_every_fixture() -> None:
    manifest = _payload("MANIFEST.json")
    entries = manifest["fixtures"]
    assert type(entries) is dict
    assert set(entries) == set(FIXTURES) | {"substrate-all-time.json"}
    for filename, entry in entries.items():
        assert type(entry) is dict
        raw = (FIXTURE_DIR / filename).read_bytes()
        payload = _payload(filename)
        assert entry["sha256"] == hashlib.sha256(raw).hexdigest()
        assert entry["node_count"] == len(payload["nodes"])
        assert entry["edge_count"] == len(payload["edges"])
        assert type(entry["witnesses"]) is dict


def test_manifest_witnesses_have_the_claimed_graph_properties() -> None:
    manifest = _payload("MANIFEST.json")
    entries = manifest["fixtures"]
    assert type(entries) is dict
    all_time_entry = entries["discovery-all-time.json"]
    assert type(all_time_entry) is dict
    witnesses = all_time_entry["witnesses"]
    assert type(witnesses) is dict
    assert set(witnesses) == {
        "cluster_aggregate",
        "conflict_aggregate",
        "temporal_conflict",
        "filtered_orphan",
        "disconnected_rejection",
    }
    all_time = _payload("discovery-all-time.json")
    nodes = _node_map(all_time)
    edges = _edge_map(all_time)
    assert len(nodes) > 0 and len(edges) > 0

    cluster_witness = witnesses["cluster_aggregate"]
    assert cluster_witness["cluster_id"] in nodes
    bridge_ids = cluster_witness["bridge_ids"]
    assert type(bridge_ids) is list and len(bridge_ids) >= 2
    assert all(bridge_id in nodes and nodes[bridge_id]["kind"] == NodeKind.BRIDGE.value for bridge_id in bridge_ids)
    cluster_edges = [
        edge for edge in edges.values()
        if edge["kind"] == EdgeKind.IN_CLUSTER.value and edge["target"] == cluster_witness["cluster_id"]
    ]
    assert len(cluster_edges) >= 2
    assert {edge["source"] for edge in cluster_edges} >= set(bridge_ids)

    conflict_witness = witnesses["conflict_aggregate"]
    conflict = nodes[conflict_witness["conflict_id"]]
    assert conflict["kind"] == NodeKind.CONFLICT.value
    member_ids = conflict_witness["member_ids"]
    assert type(member_ids) is list and len(member_ids) >= 3
    assert conflict["attributes"]["members"] == [member_id.removeprefix("assertion:") for member_id in member_ids]
    assert all(member_id in nodes and nodes[member_id]["kind"] == NodeKind.ASSERTION.value for member_id in member_ids)

    temporal_witness = witnesses["temporal_conflict"]
    discovery_at_question = _payload("discovery-at-question.json")
    discovery_at_question_nodes = _node_map(discovery_at_question)
    filtered = _payload(temporal_witness["filtered_fixture"])
    filtered_nodes = _node_map(filtered)
    assert temporal_witness["conflict_id"] in nodes
    assert temporal_witness["dropped_member_id"] in nodes
    assert temporal_witness["conflict_id"] in discovery_at_question_nodes
    assert temporal_witness["dropped_member_id"] in discovery_at_question_nodes
    assert temporal_witness["conflict_id"] not in filtered_nodes
    assert temporal_witness["dropped_member_id"] not in filtered_nodes

    orphan_witness = witnesses["filtered_orphan"]
    present = _payload(orphan_witness["present_fixture"])
    absent = _payload(orphan_witness["filtered_fixture"])
    assert orphan_witness["referent_id"] in _node_map(present)
    assert orphan_witness["referent_id"] in discovery_at_question_nodes
    assert orphan_witness["referent_id"] not in _node_map(absent)

    rejection_witness = witnesses["disconnected_rejection"]
    rejection_id = rejection_witness["rejection_id"]
    cluster_id = rejection_witness["cluster_id"]
    assert nodes[rejection_id]["kind"] == NodeKind.REJECTION.value
    assert nodes[cluster_id]["kind"] == NodeKind.CLUSTER.value
    components = _components(all_time)
    assert len(components) > 0
    assert frozenset({rejection_id, cluster_id}) in components
    assert all(
        component != frozenset({rejection_id, cluster_id}) or len(component) == 2
        for component in components
    )

    substrate_entry = entries["substrate-all-time.json"]
    assert type(substrate_entry) is dict
    assert substrate_entry["witnesses"] == witnesses
    substrate = _payload("substrate-all-time.json")
    assert _node_map(substrate) == nodes
    assert _edge_map(substrate) == edges

    for filename, entry in entries.items():
        assert type(entry) is dict
        fixture_witnesses = entry["witnesses"]
        assert type(fixture_witnesses) is dict
        for witness in fixture_witnesses.values():
            assert type(witness) is dict


def test_discovery_all_time_has_the_closed_node_and_edge_vocabularies() -> None:
    payload = _payload("discovery-all-time.json")
    nodes = _node_map(payload)
    edges = _edge_map(payload)
    assert len(nodes) >= len(NodeKind)
    assert len(edges) >= len(EdgeKind)
    assert {node["kind"] for node in nodes.values()} == {kind.value for kind in NodeKind}
    assert {edge["kind"] for edge in edges.values()} == {kind.value for kind in EdgeKind}


def test_reliability_is_a_byte_identical_subset_of_discovery_at_both_times() -> None:
    for reliability_name, discovery_name in (
        ("reliability-all-time.json", "discovery-all-time.json"),
        ("reliability-at-question.json", "discovery-at-question.json"),
    ):
        reliability = _payload(reliability_name)
        discovery = _payload(discovery_name)
        reliability_nodes = _node_map(reliability)
        discovery_nodes = _node_map(discovery)
        reliability_edges = _edge_map(reliability)
        discovery_edges = _edge_map(discovery)
        assert len(reliability_nodes) > 0 and len(reliability_edges) > 0
        assert set(reliability_nodes) <= set(discovery_nodes)
        assert set(reliability_edges) <= set(discovery_edges)
        for node_id, node in reliability_nodes.items():
            assert canonical_bytes(node) == canonical_bytes(discovery_nodes[node_id])


def test_policy_strict_difference_is_non_empty_and_kind_pinned_at_both_times() -> None:
    expected_kinds = {
        "reliability-all-time.json": {NodeKind.BRIDGE.value, NodeKind.CLUSTER.value, NodeKind.REJECTION.value},
        "reliability-at-question.json": {
            NodeKind.ASSERTION.value,
            NodeKind.BRIDGE.value,
            NodeKind.CLUSTER.value,
            NodeKind.CONFLICT.value,
            NodeKind.REJECTION.value,
            NodeKind.SOURCE.value,
            NodeKind.SUBJECT.value,
        },
    }
    for reliability_name, discovery_name in (
        ("reliability-all-time.json", "discovery-all-time.json"),
        ("reliability-at-question.json", "discovery-at-question.json"),
    ):
        reliability = _node_map(_payload(reliability_name))
        discovery = _node_map(_payload(discovery_name))
        difference = set(discovery) - set(reliability)
        assert len(difference) > 0
        assert {discovery[node_id]["kind"] for node_id in difference} == expected_kinds[reliability_name]


def test_all_required_enum_values_are_represented_in_fixture_population() -> None:
    payloads = [_payload(filename) for filename in FIXTURES] + [_payload("substrate-all-time.json")]
    assert len(payloads) == 5
    assertions = [node["attributes"] for payload in payloads for node in _node_map(payload).values() if node["kind"] == NodeKind.ASSERTION.value]
    bridges = [node["attributes"] for payload in payloads for node in _node_map(payload).values() if node["kind"] == NodeKind.BRIDGE.value]
    conflicts = [node["attributes"] for payload in payloads for node in _node_map(payload).values() if node["kind"] == NodeKind.CONFLICT.value]
    assert len(assertions) > 0 and len(bridges) > 0 and len(conflicts) > 0

    temporal_values = {attributes["temporal"] for attributes in assertions}
    assert {member.value for member in TemporalDisposition} <= temporal_values
    bridge_values = {attributes["disposition"] for attributes in bridges}
    assert {member.value for member in BridgeDisposition} <= bridge_values
    epistemic_values = {attributes["epistemic_class"] for attributes in bridges}
    assert {member.value for member in EpistemicClass} <= epistemic_values

    overlap_values = {attributes["overlap"] for attributes in conflicts}
    reachable_overlap_values = {
        member.value for member in Overlap if member is not Overlap.DISJOINT
    }
    assert overlap_values == reachable_overlap_values
    assert SupportClass.UNKNOWN.value in {attributes["support"] for attributes in assertions}

    gate_outcomes = {
        outcome
        for attributes in bridges
        for _gate, outcome in attributes["gate_outcomes"]
    }
    assert {member.value for member in GateOutcome} <= gate_outcomes
    g4_failures = [
        attributes
        for attributes in bridges
        if [Gate.G4.value, GateOutcome.FAIL.value] in attributes["gate_outcomes"]
    ]
    assert len(g4_failures) > 0
    assert all(
        attributes["triviality"] in {member.value for member in TrivialityArchetype}
        for attributes in g4_failures
    )
