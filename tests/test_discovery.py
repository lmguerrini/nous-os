"""Acceptance tests for discovery's recorded rubric and durable bridge history."""

from __future__ import annotations

import inspect
import sqlite3
import types
from collections import Counter
from dataclasses import is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType

import pytest

import nous_os.adjudication as adjudication
import nous_os.discovery as discovery
from nous_os.adjudication import RejectionMemory
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    DiscoveryError,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    RoundStatus,
    TrivialityArchetype,
    check_grounded,
    check_not_already_stated,
    rotation_order,
    run_round,
)
from nous_os.derived import search
from nous_os.identity import canonical_bytes
from nous_os.provenance import Citation, Locator
from nous_os.snapshots import SnapshotStore
from tests.test_adjudication import _scalar_violations


SOURCE_A = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
SOURCE_B = "src_01BRZ3NDEKTSV4RRFFQ69G5FAV"
_WHEN = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)


def _citation(*, source_id: str = SOURCE_A, span: str = "quoted words", start: int = 0) -> Citation:
    return Citation(source_id, "a" * 64, Locator(start, start + len(span.encode("utf-8"))), span)


def _endpoint(*, project: str = "project-a", quote: str = "quoted words", source_id: str = SOURCE_A) -> Endpoint:
    return Endpoint(project=project, citation=_citation(source_id=source_id, span=quote), quote=quote)


def _gates(*, failed: Gate | None = None) -> GateVector:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    reasons: dict[Gate, str] = {}
    triviality = None
    if failed is not None:
        outcomes[failed] = GateOutcome.FAIL
        reasons[failed] = f"{failed.value} was recorded as failing"
        if failed is Gate.G4:
            triviality = TrivialityArchetype.GENERIC_PROCESS_OVERLAP
    return GateVector(outcomes=outcomes, reasons=reasons, triviality=triviality)


def _card(
    suffix: str,
    *,
    cluster: str = "cluster-a",
    failed: Gate | None = None,
    origin_round: int = 1,
) -> BridgeCard:
    return BridgeCard(
        card_id=f"asr_01ARZ3NDEKTSV4RRFFQ69G5F{suffix}",
        cluster_id=cluster,
        left=_endpoint(),
        right=_endpoint(project="project-b", source_id=SOURCE_B),
        epistemic_class=EpistemicClass.DERIVED,
        depth=Depth.DEEP,
        non_triviality="The mechanism crosses implementation boundaries.",
        consequence="Project-b can falsify this by running the named integration.",
        noise_objection="The shared vocabulary may be coincidental.",
        gates=_gates(failed=failed),
        origin_round=origin_round,
    )


def _card_with_gates(suffix: str, gates: GateVector, *, cluster: str) -> BridgeCard:
    """Keep a complete card fixed while a test changes only its gate record."""
    card = _card(suffix, cluster=cluster)
    return BridgeCard(
        card_id=card.card_id,
        cluster_id=card.cluster_id,
        left=card.left,
        right=card.right,
        epistemic_class=card.epistemic_class,
        depth=card.depth,
        non_triviality=card.non_triviality,
        consequence=card.consequence,
        noise_objection=card.noise_objection,
        gates=gates,
        origin_round=card.origin_round,
    )


def _assert_refused(callable_: object) -> None:
    assert callable(callable_)
    with pytest.raises(DiscoveryError):
        callable_()  # type: ignore[operator]


def _assert_each_clause_is_necessary(guard: object, discriminating_samples: dict[str, object]) -> None:
    """The promotion-boundary helper pattern, retained against clause-vacuity."""
    assert callable(guard)
    assert discriminating_samples, "clause-necessity needs at least one sample"
    for clause, sample in discriminating_samples.items():
        baseline = guard(frozenset(), sample)  # type: ignore[operator]
        assert guard(frozenset({clause}), sample) is not baseline  # type: ignore[operator]


def _passes_with_gate_disabled(disabled: frozenset[str], vector: GateVector) -> bool:
    """Test driver whose six clauses correspond one-for-one to GateVector.passes."""
    return all(
        vector.outcome(gate) is GateOutcome.PASS
        for gate in Gate
        if gate.value not in disabled
    )


def test_gate_vocabulary_and_partial_vectors_cannot_pass() -> None:
    assert len(Gate) == 6
    assert {gate.value for gate in Gate} == {
        "cross_project",
        "grounded",
        "not_already_stated",
        "non_trivial",
        "consequential",
        "survives_noise_objection",
    }
    empty = GateVector(outcomes={}, reasons={})
    assert tuple(empty.outcomes) == tuple(Gate)
    assert set(empty.outcomes.values()) == {GateOutcome.UNKNOWN}
    assert empty.passes is False
    single_pass = GateVector(outcomes={Gate.G1: GateOutcome.PASS}, reasons={})
    assert len(single_pass.outcomes) == 6  # Immutable normalization prevents a partial mapping.
    assert single_pass.passes is False
    # The constructor's single entry normalizes safely; this forged post-build
    # state isolates the all-over-Gate predicate from that normalization.
    object.__setattr__(single_pass, "outcomes", MappingProxyType({Gate.G1: GateOutcome.PASS}))
    assert single_pass.passes is False
    absent = GateVector(outcomes={gate: GateOutcome.PASS for gate in tuple(Gate)[:-1]}, reasons={})
    unknown = GateVector(
        outcomes={gate: GateOutcome.UNKNOWN if gate is Gate.G6 else GateOutcome.PASS for gate in Gate},
        reasons={},
    )
    assert absent.passes is False
    assert unknown.passes is False
    _assert_each_clause_is_necessary(
        _passes_with_gate_disabled,
        {
            gate.value: GateVector(
                outcomes={other: GateOutcome.UNKNOWN if other is gate else GateOutcome.PASS for other in Gate},
                reasons={},
            )
            for gate in Gate
        },
    )


def test_uninitialised_gate_is_not_a_declared_member() -> None:
    """An enum-shaped object without a member identity cannot enter a gate vector."""
    fabricated = object.__new__(Gate)
    assert discovery._is_member(fabricated, tuple(Gate)) is False


def test_fail_without_reason_is_the_only_invalid_condition() -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    outcomes[Gate.G1] = GateOutcome.FAIL
    assert outcomes[Gate.G1] is GateOutcome.FAIL
    assert all(outcome is GateOutcome.PASS for gate, outcome in outcomes.items() if gate is not Gate.G1)
    assert Gate.G4 is not Gate.G1
    _assert_refused(lambda: GateVector(outcomes=outcomes, reasons={}))


def test_pass_with_reason_is_the_only_invalid_condition() -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    assert all(outcome is GateOutcome.PASS for outcome in outcomes.values())
    _assert_refused(lambda: GateVector(outcomes=outcomes, reasons={Gate.G1: "not a failure"}))


def test_g4_failure_without_archetype_is_the_only_invalid_condition() -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    outcomes[Gate.G4] = GateOutcome.FAIL
    reasons = {Gate.G4: "The overlap is generic."}
    assert reasons[Gate.G4].strip()
    assert all(outcome is GateOutcome.PASS for gate, outcome in outcomes.items() if gate is not Gate.G4)
    _assert_refused(lambda: GateVector(outcomes=outcomes, reasons=reasons))


def test_archetype_outside_g4_failure_is_the_only_invalid_condition() -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    assert all(outcome is GateOutcome.PASS for outcome in outcomes.values())
    assert not {gate for gate, outcome in outcomes.items() if gate is Gate.G4 and outcome is GateOutcome.FAIL}
    _assert_refused(
        lambda: GateVector(
            outcomes=outcomes,
            reasons={},
            triviality=TrivialityArchetype.COMMODITY_TOOLING,
        )
    )


def test_archetype_vocabulary_is_pinned() -> None:
    assert len(TrivialityArchetype) == 4
    assert {member.value for member in TrivialityArchetype} == {
        "commodity_tooling",
        "generic_process_overlap",
        "same_ecosystem_by_definition",
        "restated_cross_reference",
    }


def test_quote_boundary_allows_25_words_and_refuses_26_in_isolation() -> None:
    words_25 = " ".join(f"word{number}" for number in range(25))
    words_26 = " ".join(f"word{number}" for number in range(26))
    endpoint = _endpoint(quote=words_25)
    assert endpoint.project.strip()
    assert type(endpoint.citation) is Citation
    assert _gates().passes is True
    assert len(words_25.split()) == 25
    assert len(words_26.split()) == 26
    with pytest.raises(DiscoveryError, match="at most 25"):
        _endpoint(quote=words_26)


def test_rejection_memory_excludes_a_cluster_and_positive_control_reproposes_it(tmp_path: Path) -> None:
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    rejected = _card("A", cluster="X", failed=Gate.G1)
    first = run_round(round_number=1, candidates=(rejected,), registry=registry, memory=memory, at=_WHEN)
    assert first.status is RoundStatus.COMPLETE
    assert first.rejected == (rejected,)
    before = registry.cards()
    second = run_round(round_number=2, candidates=(rejected,), registry=registry, memory=memory, at=_WHEN)
    assert second.status is RoundStatus.NOT_RUN
    assert second.skipped == ("X",)
    assert second.accepted == ()
    assert second.rejected == ()
    assert second.proposed == ()
    assert registry.cards() == before
    control = run_round(
        round_number=2,
        candidates=(rejected,),
        registry=registry,
        memory=memory,
        at=_WHEN,
        consult_memory=False,
    )
    assert control.status is RoundStatus.COMPLETE
    assert control.skipped == ()
    assert control.proposed == (rejected,)
    assert control.rejected == (rejected,)
    assert len(registry.cards()) == 2


def test_preseeded_rejection_memory_is_consulted_in_round_one_with_positive_control(tmp_path: Path) -> None:
    candidate = _card("A", cluster="preseeded", failed=Gate.G1)
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    memory.record(
        cluster_id=candidate.cluster_id,
        failed_gate=Gate.G1.value,
        reason="The cluster was rejected by the spike.",
        round_number=1,
        rejected_at=_WHEN,
    )
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")

    skipped = run_round(
        round_number=1,
        candidates=(candidate,),
        registry=registry,
        memory=memory,
        at=_WHEN,
    )
    assert skipped.status is RoundStatus.NOT_RUN
    assert skipped.skipped == (candidate.cluster_id,)
    assert skipped.accepted == ()
    assert skipped.rejected == ()
    assert registry.cards() == ()

    control = run_round(
        round_number=1,
        candidates=(candidate,),
        registry=registry,
        memory=memory,
        at=_WHEN,
        consult_memory=False,
    )
    assert control.status is RoundStatus.COMPLETE
    assert control.skipped == ()
    assert control.accepted == ()
    assert control.rejected == (candidate,)
    assert registry.cards() == (candidate,)


def test_card_sort_key_and_round_registry_pin_card_id_tie_break(tmp_path: Path) -> None:
    lower_id = _card("A", cluster="identical-payload")
    higher_id = _card("B", cluster="identical-payload")
    lower_payload = lower_id.as_payload()
    higher_payload = higher_id.as_payload()
    lower_payload.pop("card_id")
    higher_payload.pop("card_id")
    assert canonical_bytes(lower_payload) == canonical_bytes(higher_payload)
    supplied_order = (higher_id, lower_id)
    expected_card_id_order = (lower_id, higher_id)
    assert tuple(card.card_id for card in supplied_order) == (
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FB",
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FA",
    )
    assert tuple(card.card_id for card in expected_card_id_order) == (
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FA",
        "asr_01ARZ3NDEKTSV4RRFFQ69G5FB",
    )
    assert tuple(sorted(supplied_order, key=discovery._card_sort_key)) == expected_card_id_order

    first_path = tmp_path / "first.jsonl"
    second_path = tmp_path / "second.jsonl"
    first = run_round(
        round_number=1,
        candidates=supplied_order,
        registry=BridgeRegistry(first_path),
        memory=RejectionMemory(tmp_path / "first-rejections.jsonl"),
        at=_WHEN,
    )
    second = run_round(
        round_number=1,
        candidates=expected_card_id_order,
        registry=BridgeRegistry(second_path),
        memory=RejectionMemory(tmp_path / "second-rejections.jsonl"),
        at=_WHEN,
    )
    assert first.accepted == expected_card_id_order
    assert second.accepted == expected_card_id_order
    assert first_path.read_bytes() == second_path.read_bytes()


def test_run_round_requires_a_timezone_aware_at(tmp_path: Path) -> None:
    kwargs = dict(
        round_number=1,
        candidates=(),
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=RejectionMemory(tmp_path / "rejections.jsonl"),
    )
    with pytest.raises(TypeError):
        run_round(**kwargs)  # type: ignore[arg-type]
    with pytest.raises(DiscoveryError, match="at must carry a timezone"):
        run_round(**kwargs, at=_WHEN.replace(tzinfo=None))


def test_run_round_consults_rejection_memory_before_proposing(tmp_path: Path) -> None:
    """The actual round, not a local stand-in, has the memory exclusion effect."""
    card = _card("B", cluster="memory-cluster", failed=Gate.G1)
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    memory.record(
        cluster_id=card.cluster_id,
        failed_gate=Gate.G1.value,
        reason="The known failure remains decisive.",
        round_number=1,
        rejected_at=_WHEN,
    )
    result = run_round(
        round_number=2,
        candidates=(card,),
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=memory,
        at=_WHEN,
    )
    assert result.status is RoundStatus.NOT_RUN
    assert result.skipped == (card.cluster_id,)
    assert result.proposed == result.accepted == result.rejected == result.undetermined == ()


def test_rejection_memory_records_the_first_failing_gate_in_closed_order(tmp_path: Path) -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    outcomes[Gate.G2] = GateOutcome.FAIL
    outcomes[Gate.G5] = GateOutcome.FAIL
    card = _card("B", cluster="first-failure")
    card = BridgeCard(
        card_id=card.card_id,
        cluster_id=card.cluster_id,
        left=card.left,
        right=card.right,
        epistemic_class=card.epistemic_class,
        depth=card.depth,
        non_triviality=card.non_triviality,
        consequence=card.consequence,
        noise_objection=card.noise_objection,
        gates=GateVector(
            outcomes=outcomes,
            reasons={Gate.G2: "The span was not re-found.", Gate.G5: "No action was named."},
        ),
        origin_round=card.origin_round,
    )
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    result = run_round(
        round_number=4,
        candidates=(card,),
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=memory,
        at=_WHEN,
    )
    assert result.rejected == (card,)
    recorded = memory.rejections()
    assert len(recorded) == 1
    assert recorded[0].failed_gate == Gate.G2.value
    assert recorded[0].reason == "The span was not re-found."
    assert recorded[0].round_number == 4
    assert recorded[0].rejected_at == _WHEN


def test_failed_and_unknown_card_is_rejected_by_the_first_failed_gate(tmp_path: Path) -> None:
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    outcomes[Gate.G2] = GateOutcome.UNKNOWN
    outcomes[Gate.G5] = GateOutcome.FAIL
    card = _card_with_gates(
        "H",
        GateVector(outcomes=outcomes, reasons={Gate.G5: "The consequence is absent."}),
        cluster="fail-wins-over-unknown",
    )
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    result = run_round(
        round_number=1,
        candidates=(card,),
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=memory,
        at=_WHEN,
    )
    assert result.rejected == (card,)
    assert result.undetermined == ()
    assert memory.rejections()[0].failed_gate == Gate.G5.value


def test_unknown_grounding_is_undetermined_and_leaves_no_durable_trace(tmp_path: Path) -> None:
    """The documented absent-snapshot path stays eligible rather than rejected."""
    endpoint = _endpoint()
    grounded = check_grounded(SnapshotStore(tmp_path / "snapshots"), endpoint)
    assert grounded is GateOutcome.UNKNOWN
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    outcomes[Gate.G2] = grounded
    card = _card_with_gates(
        "J", GateVector(outcomes=outcomes, reasons={}), cluster="awaiting-snapshot"
    )
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    result = run_round(
        round_number=1, candidates=(card,), registry=registry, memory=memory, at=_WHEN
    )
    assert result.status is RoundStatus.COMPLETE
    assert result.accepted == result.rejected == ()
    assert result.undetermined == (card,)
    assert registry.cards() == ()
    assert registry.mined_clusters() == frozenset()
    assert memory.rejections() == ()


def test_undetermined_cluster_is_re_adjudicated_when_evidence_later_exists(tmp_path: Path) -> None:
    unknown_outcomes = {gate: GateOutcome.PASS for gate in Gate}
    unknown_outcomes[Gate.G2] = GateOutcome.UNKNOWN
    undetermined = _card_with_gates(
        "K", GateVector(outcomes=unknown_outcomes, reasons={}), cluster="later-evidence"
    )
    resolved = _card("M", cluster="later-evidence", origin_round=2)
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    first = run_round(
        round_number=1, candidates=(undetermined,), registry=registry, memory=memory, at=_WHEN
    )
    second = run_round(
        round_number=2, candidates=(resolved,), registry=registry, memory=memory, at=_WHEN
    )
    assert first.undetermined == (undetermined,)
    assert second.skipped == ()
    assert second.proposed == second.accepted == (resolved,)
    assert registry.cards() == (resolved,)


def test_round_dispositions_are_total_disjoint_and_known_before_any_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    accepted = _card("A", cluster="accepted")
    rejected = _card("B", cluster="rejected", failed=Gate.G1)
    unknown_outcomes = {gate: GateOutcome.PASS for gate in Gate}
    unknown_outcomes[Gate.G2] = GateOutcome.UNKNOWN
    undetermined = _card_with_gates(
        "C", GateVector(outcomes=unknown_outcomes, reasons={}), cluster="undetermined"
    )
    skipped = _card("D", cluster="already-rejected", failed=Gate.G5)
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    memory.record(
        cluster_id=skipped.cluster_id,
        failed_gate=Gate.G5.value,
        reason="The prior round is decisive.",
        round_number=1,
        rejected_at=_WHEN,
    )
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    evaluated: set[str] = set()
    original_accepted = BridgeCard.accepted
    original_record = BridgeRegistry.record

    def observing_accepted(card: BridgeCard) -> bool:
        evaluated.add(card.card_id)
        return original_accepted.__get__(card, BridgeCard)

    def record_after_full_classification(store: BridgeRegistry, card: BridgeCard) -> BridgeCard:
        assert evaluated == {accepted.card_id, rejected.card_id, undetermined.card_id}
        return original_record(store, card)

    monkeypatch.setattr(BridgeCard, "accepted", property(observing_accepted))
    monkeypatch.setattr(BridgeRegistry, "record", record_after_full_classification)
    result = run_round(
        round_number=2,
        candidates=(accepted, rejected, undetermined, skipped),
        registry=registry,
        memory=memory,
        at=_WHEN,
    )
    dispositions = result.accepted + result.rejected + result.undetermined
    assert Counter(dispositions) == Counter(result.proposed)
    skipped_cards = tuple(card for card in (accepted, rejected, undetermined, skipped) if card.cluster_id in result.skipped)
    assert Counter(skipped_cards + dispositions) == Counter((accepted, rejected, undetermined, skipped))


def test_round_result_constructor_rejects_non_partitioned_complete_and_nonempty_not_run() -> None:
    """RoundResult itself, rather than only run_round, owns these status invariants."""
    accepted = _card("N", cluster="complete-accepted")
    rejected = _card("P", cluster="complete-rejected", failed=Gate.G1)
    with pytest.raises(DiscoveryError, match="dispositions must partition"):
        discovery.RoundResult(
            round_number=1,
            status=RoundStatus.COMPLETE,
            proposed=(accepted, rejected),
            accepted=(accepted,),
            rejected=(),
            skipped=(),
        )
    with pytest.raises(DiscoveryError, match="not-run round cannot"):
        discovery.RoundResult(
            round_number=1,
            status=RoundStatus.NOT_RUN,
            proposed=(accepted,),
            accepted=(),
            rejected=(),
            skipped=(),
        )


def test_round_write_failure_leaves_at_most_one_registry_card_without_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-card appends limit a rejected-memory failure to its current card."""
    candidates = (
        _card("Q", cluster="cl-A", failed=Gate.G1),
        _card("R", cluster="cl-B", failed=Gate.G2),
        _card("S", cluster="cl-C", failed=Gate.G3),
    )
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    original_record = RejectionMemory.record

    def fail_memory_write(*args: object, **kwargs: object) -> object:
        raise OSError("disk full")

    monkeypatch.setattr(RejectionMemory, "record", fail_memory_write)
    with pytest.raises(OSError, match="disk full"):
        run_round(
            round_number=1,
            candidates=candidates,
            registry=registry,
            memory=memory,
            at=_WHEN,
        )
    monkeypatch.setattr(RejectionMemory, "record", original_record)
    assert len(registry.cards()) <= len(memory.rejections()) + 1


def test_a_rejection_trace_never_exists_without_its_registry_card(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The registry append must precede the memory append for the same card.

    The two orders fail differently, and only one of them is recoverable. With
    the registry written first, a failed memory write leaves a card whose
    cluster is not remembered: the next round proposes it again and records it
    again, which is wasteful but self-correcting. With the memory written
    first, a failed registry write leaves a rejection trace for a cluster that
    was never recorded, and ``consult_memory`` then skips that cluster in every
    later round, so it can never be recorded at all.

    The docstring of ``run_round`` states this ordering. Without this test the
    claim was true and unverified, and swapping the two appends left the whole
    suite green.
    """
    candidates = (
        _card("Q", cluster="cl-A", failed=Gate.G1),
        _card("R", cluster="cl-B", failed=Gate.G2),
    )
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    original_record = BridgeRegistry.record

    def fail_registry_write(*args: object, **kwargs: object) -> object:
        raise OSError("disk full")

    monkeypatch.setattr(BridgeRegistry, "record", fail_registry_write)
    with pytest.raises(OSError, match="disk full"):
        run_round(
            round_number=1,
            candidates=candidates,
            registry=registry,
            memory=memory,
            at=_WHEN,
        )
    monkeypatch.setattr(BridgeRegistry, "record", original_record)
    recorded = {card.cluster_id for card in registry.cards()}
    remembered = {rejection.cluster_id for rejection in memory.rejections()}
    assert remembered <= recorded, (
        "a cluster is remembered as rejected but holds no registry card, so a "
        "later round will skip it forever"
    )


def test_round_registry_records_mixed_dispositions_in_canonical_card_order(tmp_path: Path) -> None:
    """The append-only registry layout ignores the accepted/rejected grouping."""
    alpha = _card("T", cluster="alpha")
    beta = _card("V", cluster="beta", failed=Gate.G1)
    delta = _card("W", cluster="delta")
    gamma = _card("X", cluster="gamma", failed=Gate.G2)
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    run_round(
        round_number=1,
        candidates=(gamma, delta, beta, alpha),
        registry=registry,
        memory=RejectionMemory(tmp_path / "rejections.jsonl"),
        at=_WHEN,
    )
    assert registry.cards() == (alpha, beta, delta, gamma)


def test_round_registry_appends_are_deterministic_for_the_same_candidate_order(tmp_path: Path) -> None:
    first_path = tmp_path / "first.jsonl"
    second_path = tmp_path / "second.jsonl"
    candidates = (_card("C", cluster="same-a"), _card("D", cluster="same-b"))
    first = run_round(
        round_number=1,
        candidates=candidates,
        registry=BridgeRegistry(first_path),
        memory=RejectionMemory(tmp_path / "first-rejections.jsonl"),
        at=_WHEN,
    )
    second = run_round(
        round_number=1,
        candidates=candidates,
        registry=BridgeRegistry(second_path),
        memory=RejectionMemory(tmp_path / "second-rejections.jsonl"),
        at=_WHEN,
    )
    assert first.accepted == second.accepted
    assert first_path.read_bytes() == second_path.read_bytes()


def test_accumulation_is_monotone_and_preserves_origin_round(tmp_path: Path) -> None:
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    first_card = _card("C", cluster="round-one", origin_round=1)
    second_card = _card("D", cluster="round-two", origin_round=2)
    third_card = _card("E", cluster="round-three", origin_round=3)
    first = run_round(round_number=1, candidates=(first_card,), registry=registry, memory=memory, at=_WHEN)
    accepted_after_first = registry.accepted()
    second = run_round(round_number=2, candidates=(second_card,), registry=registry, memory=memory, at=_WHEN)
    accepted_after_second = registry.accepted()
    third = run_round(round_number=3, candidates=(third_card,), registry=registry, memory=memory, at=_WHEN)
    accepted_after_third = registry.accepted()
    assert {card.cluster_id for card in second.proposed} - {card.cluster_id for card in first.proposed} == {"round-two"}
    assert {card.cluster_id for card in third.proposed} - {card.cluster_id for card in second.proposed} == {"round-three"}
    assert set(accepted_after_first) <= set(accepted_after_second) <= set(accepted_after_third)
    assert [card.origin_round for card in accepted_after_third] == [1, 2, 3]


def test_empty_round_is_not_run(tmp_path: Path) -> None:
    result = run_round(
        round_number=1,
        candidates=(),
        registry=BridgeRegistry(tmp_path / "bridges.jsonl"),
        memory=RejectionMemory(tmp_path / "rejections.jsonl"),
        at=_WHEN,
    )
    assert result.status is RoundStatus.NOT_RUN
    assert result.proposed == ()
    assert result.accepted == ()
    assert result.rejected == ()


def test_registry_partitions_mixed_history_and_rotation_is_stable(tmp_path: Path) -> None:
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    accepted = _card("F", cluster="accepted")
    rejected = _card("G", cluster="rejected", failed=Gate.G5)
    registry.record(accepted)
    registry.record(rejected)
    cards = registry.cards()
    accepted_cards = registry.accepted()
    rejected_cards = registry.rejected()
    assert accepted_cards and rejected_cards
    assert set(accepted_cards) | set(rejected_cards) == set(cards)
    assert set(accepted_cards) & set(rejected_cards) == set()
    unseen_one = _card("H", cluster="unseen-one")
    unseen_two = _card("K", cluster="unseen-two")
    ordered = rotation_order(registry, (rejected, unseen_one, accepted, unseen_two))
    assert ordered == (unseen_one, unseen_two, rejected, accepted)


def test_an_unreadable_bridge_line_is_reported_not_skipped(tmp_path: Path) -> None:
    """A line nobody can parse is not an absent line."""
    path = tmp_path / "bridges.jsonl"
    registry = BridgeRegistry(path)
    registry.record(_card("A", cluster="cluster-a"))
    with path.open("ab") as handle:
        handle.write(b"{not json\n")
    with pytest.raises(DiscoveryError, match="bridge line 2 is not readable"):
        registry.cards()


def test_grounded_passes_when_resolved_span_is_exact(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    snapshot = store.put(SOURCE_A, b"quoted words")
    endpoint = Endpoint(SOURCE_A, Citation(SOURCE_A, snapshot.digest, Locator(0, 12), "quoted words"), "quoted words")
    assert check_grounded(store, endpoint) is GateOutcome.PASS


def test_grounded_fails_when_resolved_span_differs_from_endpoint_quote(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    snapshot = store.put(SOURCE_A, b"quoted words")
    endpoint = Endpoint(SOURCE_A, Citation(SOURCE_A, snapshot.digest, Locator(0, 12), "quoted words"), "other words")
    assert check_grounded(store, endpoint) is GateOutcome.FAIL


def test_grounded_fails_when_the_citation_span_lies_about_readable_bytes(tmp_path: Path) -> None:
    """A matching endpoint quote cannot make a citation that fails quote-lint pass."""
    store = SnapshotStore(tmp_path / "snapshots")
    snapshot = store.put(SOURCE_A, b"quoted words")
    endpoint = Endpoint(
        SOURCE_A,
        Citation(SOURCE_A, snapshot.digest, Locator(0, 12), "invented text"),
        "quoted words",
    )
    assert check_grounded(store, endpoint) is GateOutcome.FAIL

    def grounded_condition(disabled: frozenset[str], sample: tuple[bool, str, str]) -> bool:
        citation_resolves, found, quote = sample
        return not any(
            violated
            for clause, violated in (
                ("citation_resolves", not citation_resolves),
                ("endpoint_quote", found != quote),
            )
            if clause not in disabled
        )

    _assert_each_clause_is_necessary(
        grounded_condition,
        {
            "citation_resolves": (False, "quoted words", "quoted words"),
            "endpoint_quote": (True, "quoted words", "other words"),
        },
    )


def test_grounded_missing_snapshot_is_unknown_not_fail(tmp_path: Path) -> None:
    endpoint = _endpoint()
    outcome = check_grounded(SnapshotStore(tmp_path / "snapshots"), endpoint)
    assert outcome is GateOutcome.UNKNOWN
    assert outcome is not GateOutcome.FAIL


@pytest.mark.parametrize(
    ("label", "data", "locator", "span", "expected"),
    (
        ("out_of_range", b"quoted words", Locator(0, 999), "quoted words", GateOutcome.FAIL),
        ("splits_character", "é".encode(), Locator(0, 1), "é", GateOutcome.FAIL),
        ("splits_grapheme", "e\u0301".encode(), Locator(0, 1), "e", GateOutcome.FAIL),
        ("not_text", b"\xff", Locator(0, 1), "x", GateOutcome.UNKNOWN),
        (
            "not_text_only_in_tail",
            "quoted words".encode("utf-8") + b"\xff\xfe tail",
            Locator(0, 12),
            "quoted words",
            GateOutcome.UNKNOWN,
        ),
    ),
)
def test_grounded_maps_each_read_failure_to_its_evidence_outcome(
    label: str, data: bytes, locator: Locator, span: str, expected: GateOutcome, tmp_path: Path
) -> None:
    store = SnapshotStore(tmp_path / label)
    snapshot = store.put(SOURCE_A, data)
    endpoint = Endpoint(SOURCE_A, Citation(SOURCE_A, snapshot.digest, locator, span), span)
    assert check_grounded(store, endpoint) is expected


def test_grounded_treats_a_corrupt_snapshot_as_unavailable_evidence(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "snapshots")
    snapshot = store.put(SOURCE_A, b"quoted words")
    path = tmp_path / "snapshots" / SOURCE_A / f"{snapshot.digest}.snapshot"
    path.write_bytes(b"corrupted")
    endpoint = Endpoint(SOURCE_A, Citation(SOURCE_A, snapshot.digest, Locator(0, 7), "quoted"), "quoted")
    assert check_grounded(store, endpoint) is GateOutcome.UNKNOWN


def _derived_store(path: Path, rows: tuple[tuple[str, str, str], ...]) -> Path:
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE content (snapshot_digest TEXT, source_id TEXT, body TEXT)")
        connection.execute("PRAGMA user_version=2")
        connection.execute("CREATE VIRTUAL TABLE search_plain USING fts5(body, snapshot_digest UNINDEXED, source_id UNINDEXED)")
        for digest, source_id, body in rows:
            connection.execute("INSERT INTO content VALUES (?,?,?)", (digest, source_id, body))
            connection.execute("INSERT INTO search_plain VALUES (?,?,?)", (body, digest, source_id))
        connection.commit()
    finally:
        connection.close()
    return path


def test_co_mention_outside_endpoint_documents_fails_and_observes_the_hit(tmp_path: Path) -> None:
    path = _derived_store(
        tmp_path / "derived.sqlite",
        (("a" * 64, SOURCE_A, "alpha beta endpoint"), ("b" * 64, SOURCE_B, "alpha beta elsewhere")),
    )
    hits = search(path, "alpha beta")
    assert hits
    assert any(hit.source_id == SOURCE_B for hit in hits)
    assert check_not_already_stated(
        path, left_terms=("alpha",), right_terms=("beta",), endpoint_documents=frozenset({SOURCE_A})
    ) is GateOutcome.FAIL


def test_co_mentions_only_in_endpoint_documents_pass(tmp_path: Path) -> None:
    path = _derived_store(tmp_path / "derived.sqlite", (("a" * 64, SOURCE_A, "alpha beta endpoint"),))
    assert search(path, "alpha beta")
    assert check_not_already_stated(
        path, left_terms=("alpha",), right_terms=("beta",), endpoint_documents=frozenset({SOURCE_A})
    ) is GateOutcome.PASS


def test_empty_co_mention_terms_refuse_in_isolation(tmp_path: Path) -> None:
    path = _derived_store(tmp_path / "derived.sqlite", (("a" * 64, SOURCE_A, "alpha beta endpoint"),))
    assert path.is_file()
    assert frozenset({SOURCE_A}) == frozenset({SOURCE_A})
    _assert_refused(
        lambda: check_not_already_stated(
            path, left_terms=(), right_terms=("beta",), endpoint_documents=frozenset({SOURCE_A})
        )
    )


def test_public_discovery_dataclasses_have_no_scalar_fields() -> None:
    """Use the package-wide recursive scalar guard for discovery records too."""
    public = tuple(
        cls
        for _, cls in inspect.getmembers(discovery, inspect.isclass)
        if cls.__module__ == discovery.__name__ and not cls.__name__.startswith("_") and is_dataclass(cls)
    )
    assert public
    assert _scalar_violations(public) == ()


def test_adjudication_has_no_discovery_import_record() -> None:
    imported_modules = {
        value.__name__
        for value in adjudication.__dict__.values()
        if isinstance(value, types.ModuleType)
    }
    assert "nous_os.discovery" not in imported_modules
    code_names = {
        name
        for value in adjudication.__dict__.values()
        if inspect.isfunction(value)
        for name in value.__code__.co_names
    }
    assert "discovery" not in code_names
