"""Build synthetic Projection IR fixtures; this does not assert anything about real sources."""

from __future__ import annotations

import argparse
from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Final

if __package__ in (None, ""):
    _REPOSITORY = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(_REPOSITORY / "src"))

from nous_os.adjudication import Rejection
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.discovery import (
    BridgeCard,
    Depth,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    TrivialityArchetype,
)
from nous_os.identity import _ALPHABET, canonical_bytes, digest_bytes
from nous_os.projection import (
    ALL_TIME,
    DISCOVERY,
    RELIABILITY,
    BridgeDisposition,
    EdgeKind,
    KnowledgeState,
    NodeKind,
    ProjectionIR,
    TemporalDisposition,
    TemporalQuestion,
    project,
    substrate,
)
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey, Overlap, TemporalIndex


FIXTURE_DIR: Final = Path(__file__).resolve().parents[1] / "fixtures" / "synthetic" / "projection"
BASE: Final = datetime(2026, 1, 1, tzinfo=timezone.utc)
QUESTION: Final = TemporalQuestion(valid_at=datetime(2026, 1, 5, tzinfo=timezone.utc))


def _instant(day: int) -> datetime:
    return BASE.replace(day=day)


def _body(label: str) -> str:
    """Derive one fixed Crockford body; this does not mint production identity."""
    digest = hashlib.sha256(label.encode("utf-8")).digest()[:17]
    number = int.from_bytes(digest, "big") >> 6
    return "".join(_ALPHABET[(number >> (125 - 5 * index)) & 31] for index in range(26))


def _id(prefix: str, label: str) -> str:
    return f"{prefix}_{_body('synthetic-projection:' + label)}"


def _source(label: str) -> str:
    return _id("src", label)


def _assertion(
    label: str,
    source_id: str,
    *,
    recorded_day: int,
    support: SupportClass,
    valid_from: int | None,
    valid_to: int | None,
) -> Assertion:
    span = f"synthetic quote {label}"
    return Assertion(
        _id("asr", label),
        f"Synthetic projection claim {label}.",
        Citation(
            source_id,
            hashlib.sha256(("synthetic-snapshot:" + label).encode("utf-8")).hexdigest(),
            Locator(0, len(span.encode("utf-8"))),
            span,
        ),
        support,
        _instant(recorded_day),
        LifecycleState.CANONICAL,
        None if valid_from is None else _instant(valid_from),
        None if valid_to is None else _instant(valid_to),
    )


def _endpoint(source_id: str, label: str) -> Endpoint:
    span = f"synthetic endpoint {label}"
    return Endpoint(
        f"synthetic-project-{label}",
        Citation(
            source_id,
            hashlib.sha256(("synthetic-endpoint:" + label).encode("utf-8")).hexdigest(),
            Locator(0, len(span.encode("utf-8"))),
            span,
        ),
        span,
    )


def _gates(*, failed: Gate | None = None, unknown: Gate | None = None) -> GateVector:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    reasons: dict[Gate, str] = {}
    triviality = None
    if failed is not None:
        outcomes[failed] = GateOutcome.FAIL
        reasons[failed] = f"synthetic failure for {failed.value}"
        if failed is Gate.G4:
            triviality = TrivialityArchetype.GENERIC_PROCESS_OVERLAP
    if unknown is not None:
        outcomes[unknown] = GateOutcome.UNKNOWN
    return GateVector(outcomes, reasons, triviality)


def _card(
    label: str,
    cluster_id: str,
    left_source: str,
    right_source: str,
    epistemic_class: EpistemicClass,
    gates: GateVector,
) -> BridgeCard:
    return BridgeCard(
        _id("asr", "bridge-" + label),
        cluster_id,
        _endpoint(left_source, label + "-left"),
        _endpoint(right_source, label + "-right"),
        epistemic_class,
        Depth.DEEP,
        f"Synthetic non-triviality note for {label}.",
        f"Synthetic consequence note for {label}.",
        f"Synthetic noise objection for {label}.",
        gates,
        1,
    )


def build_state() -> KnowledgeState:
    """Construct one complete synthetic state; this does not select a claim."""
    source_alpha = _source("assertion-alpha")
    source_beta = _source("assertion-beta")
    source_gamma = _source("assertion-gamma")
    source_unknown = _source("assertion-unknown")
    source_orphan = _source("assertion-orphan")

    conflict_members = (
        _assertion(
            "conflict-alpha",
            source_alpha,
            recorded_day=1,
            support=SupportClass.DIRECT_QUOTE,
            valid_from=1,
            valid_to=10,
        ),
        _assertion(
            "conflict-beta",
            source_beta,
            recorded_day=2,
            support=SupportClass.PARAPHRASE,
            valid_from=1,
            valid_to=10,
        ),
        _assertion(
            "conflict-gamma",
            source_gamma,
            recorded_day=3,
            support=SupportClass.SUMMARY,
            valid_from=1,
            valid_to=3,
        ),
    )
    uncertain_members = (
        _assertion(
            "uncertain-open",
            source_unknown,
            recorded_day=4,
            support=SupportClass.UNKNOWN,
            valid_from=None,
            valid_to=10,
        ),
        _assertion(
            "uncertain-bounded",
            source_beta,
            recorded_day=5,
            support=SupportClass.INFERRED,
            valid_from=1,
            valid_to=10,
        ),
    )
    orphan = _assertion(
        "orphan-at-question",
        source_orphan,
        recorded_day=6,
        support=SupportClass.SUMMARY,
        valid_from=1,
        valid_to=3,
    )

    index = TemporalIndex()
    for key, assertions in (
        ("conflict-subject", conflict_members),
        ("uncertain-subject", uncertain_members),
        ("orphan-subject", (orphan,)),
    ):
        for assertion in assertions:
            index.add(ClaimKey(key), assertion)

    shared_cluster = "shared-synthetic-cluster"
    bridges = (
        _card(
            "accepted",
            shared_cluster,
            source_alpha,
            source_beta,
            EpistemicClass.EXPLICIT,
            _gates(),
        ),
        _card(
            "rejected-g4",
            shared_cluster,
            source_beta,
            source_alpha,
            EpistemicClass.DERIVED,
            _gates(failed=Gate.G4),
        ),
        _card(
            "undetermined",
            shared_cluster,
            source_alpha,
            source_beta,
            EpistemicClass.SPECULATIVE,
            _gates(unknown=Gate.G6),
        ),
    )
    rejections = (
        Rejection(
            "lonely-synthetic-cluster",
            Gate.G2.value,
            "Synthetic rejection leaves this cluster without a bridge.",
            1,
            _instant(6),
        ),
    )
    return KnowledgeState(index, bridges, rejections)


def _fixture_irs(state: KnowledgeState) -> dict[str, ProjectionIR]:
    return {
        "reliability-all-time.json": project(state, RELIABILITY),
        "discovery-all-time.json": project(state, DISCOVERY),
        "reliability-at-question.json": project(state, RELIABILITY, question=QUESTION),
        "discovery-at-question.json": project(state, DISCOVERY, question=QUESTION),
        "substrate-all-time.json": substrate(state),
    }


def _find_node(ir: ProjectionIR, kind: NodeKind, *, contains: str = "") -> object:
    matches = [node for node in ir.nodes if node.kind is kind and contains in node.id]
    if len(matches) != 1:
        raise AssertionError(f"expected one {kind.value} node containing {contains!r}")
    return matches[0]


def _witnesses(irs: dict[str, ProjectionIR]) -> dict[str, object]:
    all_time = irs["discovery-all-time.json"]
    at_question = irs["reliability-at-question.json"]
    cluster = _find_node(all_time, NodeKind.CLUSTER, contains="shared-synthetic-cluster")
    conflict = next(node for node in all_time.nodes if node.kind is NodeKind.CONFLICT and len(node.attributes.members) >= 3)
    dropped = next(
        member for member in conflict.attributes.members
        if f"assertion:{member}" not in {node.id for node in at_question.nodes}
    )
    orphan_id = f"source:{_source('assertion-orphan')}"
    rejection = _find_node(all_time, NodeKind.REJECTION, contains="rejection:")
    return {
        "cluster_aggregate": {
            "cluster_id": cluster.id,
            "bridge_ids": [
                edge.source
                for edge in all_time.edges
                if edge.kind is EdgeKind.IN_CLUSTER and edge.target == cluster.id
            ],
        },
        "conflict_aggregate": {
            "conflict_id": conflict.id,
            "member_ids": [f"assertion:{member}" for member in conflict.attributes.members],
        },
        "temporal_conflict": {
            "conflict_id": conflict.id,
            "dropped_member_id": f"assertion:{dropped}",
            "filtered_fixture": "reliability-at-question.json",
        },
        "filtered_orphan": {
            "referent_id": orphan_id,
            "present_fixture": "discovery-all-time.json",
            "filtered_fixture": "reliability-at-question.json",
        },
        "disconnected_rejection": {
            "rejection_id": rejection.id,
            "cluster_id": f"cluster:{rejection.attributes.cluster_id}",
        },
    }


def _components(ir: ProjectionIR) -> tuple[frozenset[str], ...]:
    neighbours: dict[str, set[str]] = {node.id: set() for node in ir.nodes}
    for edge in ir.edges:
        neighbours[edge.source].add(edge.target)
        neighbours[edge.target].add(edge.source)
    remaining = set(neighbours)
    found: list[frozenset[str]] = []
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
        found.append(frozenset(component))
    return tuple(sorted(found, key=lambda component: sorted(component)))


def verify(state: KnowledgeState, irs: dict[str, ProjectionIR]) -> None:
    """Check fixture witnesses against real projection output; this does not write files."""
    discovery = irs["discovery-all-time.json"]
    question = irs["reliability-at-question.json"]
    if {node.kind for node in discovery.nodes} != set(NodeKind):
        raise AssertionError("discovery-all-time is missing a node kind")
    if {edge.kind for edge in discovery.edges} != set(EdgeKind):
        raise AssertionError("discovery-all-time is missing an edge kind")
    witnesses = _witnesses(irs)
    cluster_id = witnesses["cluster_aggregate"]["cluster_id"]
    bridge_ids = witnesses["cluster_aggregate"]["bridge_ids"]
    if len(bridge_ids) < 2 or any(edge.target != cluster_id for edge in discovery.edges if edge.source in bridge_ids and edge.kind is EdgeKind.IN_CLUSTER):
        raise AssertionError("cluster aggregate witness is incomplete")
    conflict_id = witnesses["conflict_aggregate"]["conflict_id"]
    conflict = next(node for node in discovery.nodes if node.id == conflict_id)
    if len(conflict.attributes.members) < 3:
        raise AssertionError("conflict aggregate witness is too small")
    dropped_id = witnesses["temporal_conflict"]["dropped_member_id"]
    if conflict_id in {node.id for node in question.nodes} or dropped_id in {node.id for node in question.nodes}:
        raise AssertionError("temporal conflict witness was not filtered")
    orphan_id = witnesses["filtered_orphan"]["referent_id"]
    if orphan_id not in {node.id for node in discovery.nodes} or orphan_id in {node.id for node in question.nodes}:
        raise AssertionError("orphan witness did not change across filtering")
    rejection = witnesses["disconnected_rejection"]["rejection_id"]
    cluster = witnesses["disconnected_rejection"]["cluster_id"]
    if not any({rejection, cluster} == set(component) for component in _components(discovery)):
        raise AssertionError("rejection witness is not a two-node component")
    if not state.index.conflicts():
        raise AssertionError("synthetic state has no real temporal conflicts")


def _manifest(irs: dict[str, ProjectionIR], witnesses: dict[str, object]) -> dict[str, object]:
    entries: dict[str, object] = {}
    for filename, ir in irs.items():
        payload = ir.as_payload()
        entries[filename] = {
            "sha256": digest_bytes(canonical_bytes(payload)),
            "node_count": len(payload["nodes"]),
            "edge_count": len(payload["edges"]),
            "witnesses": witnesses if filename in {"discovery-all-time.json", "substrate-all-time.json"} else {},
        }
    return {
        "question": QUESTION.valid_at.astimezone(timezone.utc).isoformat(),
        "fixtures": entries,
    }


def write_fixtures() -> None:
    """Write the canonical fixture set and manifest; this is the only mutating path."""
    state = build_state()
    irs = _fixture_irs(state)
    verify(state, irs)
    witnesses = _witnesses(irs)
    for filename, ir in irs.items():
        (FIXTURE_DIR / filename).write_bytes(canonical_bytes(ir.as_payload()))
    (FIXTURE_DIR / "MANIFEST.json").write_bytes(canonical_bytes(_manifest(irs, witnesses)))


def _report(irs: dict[str, ProjectionIR]) -> str:
    lines = [f"question: {QUESTION.valid_at.astimezone(timezone.utc).isoformat()}"]
    for filename, ir in irs.items():
        node_counts = Counter(node.kind.value for node in ir.nodes)
        edge_counts = Counter(edge.kind.value for edge in ir.edges)
        temporal = Counter(
            node.attributes.temporal.value
            for node in ir.nodes
            if node.kind is NodeKind.ASSERTION
        )
        bridge = Counter(
            node.attributes.disposition.value
            for node in ir.nodes
            if node.kind is NodeKind.BRIDGE
        )
        lines.extend(
            (
                f"\n{filename}",
                f"  nodes: {len(ir.nodes)}; kinds: {dict(sorted(node_counts.items()))}",
                f"  edges: {len(ir.edges)}; kinds: {dict(sorted(edge_counts.items()))}",
                f"  components: {len(_components(ir))}",
                f"  temporal dispositions: {dict(sorted(temporal.items()))}",
                f"  bridge dispositions: {dict(sorted(bridge.items()))}",
                f"  digest: {ir.ir_digest}",
            )
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="report without writing fixtures")
    args = parser.parse_args()
    state = build_state()
    irs = _fixture_irs(state)
    verify(state, irs)
    if args.report:
        print(_report(irs))
    else:
        for filename, ir in irs.items():
            (FIXTURE_DIR / filename).write_bytes(canonical_bytes(ir.as_payload()))
        (FIXTURE_DIR / "MANIFEST.json").write_bytes(canonical_bytes(_manifest(irs, _witnesses(irs))))


if __name__ == "__main__":
    main()
