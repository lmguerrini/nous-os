"""Acceptance oracles for attribution, human adjudication, and memory separation."""

from __future__ import annotations

import dataclasses
import importlib
import inspect
import pkgutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import CodeType, SimpleNamespace
from typing import Iterable, get_type_hints

import pytest

import nous_os
from nous_os.adjudication import (
    AgentMemory,
    AdjudicationError,
    HumanDecision,
    Rejection,
    RejectionMemory,
    Verdict,
    promote,
)
from nous_os.attribution import AttributedKey, KeyOrigin
from nous_os.candidates import Proposal
from nous_os.canonical import Assertion
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey
from nous_os.untrusted import UntrustedText


_WHEN = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
_CITATION = Citation(
    source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshot_digest="b" * 64,
    locator=Locator(0, 4),
    span="text",
)


def _candidate() -> Proposal:
    """Build a valid proposal whose failure cannot mask an adjudication check."""
    return Proposal(
        proposal_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        content=UntrustedText("proposal text"),
        proposed_at=_WHEN,
        holder="proposer",
    )


def _subject(origin: KeyOrigin) -> AttributedKey:
    """Build a valid origin carrier, including evidence for content origin only."""
    return AttributedKey(
        key=ClaimKey("subject"),
        origin=origin,
        citation=_CITATION if origin is KeyOrigin.CONTENT else None,
    )


def _decision(
    *,
    verdict: Verdict = Verdict.PROMOTE,
    origin: KeyOrigin = KeyOrigin.OPERATOR,
) -> HumanDecision:
    """Build a complete decision so each negative control isolates one failure."""
    return HumanDecision(
        adjudicator="human reviewer",
        verdict=verdict,
        decided_at=_WHEN,
        rationale="The stated evidence was reviewed.",
        subject=_subject(origin),
    )


@dataclass(frozen=True, slots=True)
class _DecisionShapedImpostor:
    adjudicator: str
    verdict: Verdict
    decided_at: datetime
    rationale: str
    subject: AttributedKey

    @property
    def __class__(self) -> type[HumanDecision]:
        """Exploit ``isinstance``'s reported-class hook without changing real type."""
        return HumanDecision


@pytest.mark.parametrize(
    "bad_decision",
    (
        None,
        object(),
        {
            "adjudicator": "human reviewer",
            "verdict": Verdict.PROMOTE,
            "decided_at": _WHEN,
            "rationale": "reviewed",
            "subject": _subject(KeyOrigin.OPERATOR),
        },
        SimpleNamespace(
            adjudicator="human reviewer",
            verdict=Verdict.PROMOTE,
            decided_at=_WHEN,
            rationale="reviewed",
            subject=_subject(KeyOrigin.OPERATOR),
        ),
        _DecisionShapedImpostor(
            adjudicator="human reviewer",
            verdict=Verdict.PROMOTE,
            decided_at=_WHEN,
            rationale="reviewed",
            subject=_subject(KeyOrigin.OPERATOR),
        ),
    ),
)
def test_promote_refuses_anything_not_exactly_a_decision_before_other_work(
    bad_decision: object, tmp_path: Path
) -> None:
    """A malformed decision must win even when candidate and path are unusable."""
    with pytest.raises(AdjudicationError, match="decision") as raised:
        promote(
            decision=bad_decision,  # type: ignore[arg-type]
            candidate=object(),  # type: ignore[arg-type]
            canon=tmp_path / "must-not-exist.jsonl",
        )
    assert "candidate" not in str(raised.value)
    assert not (tmp_path / "must-not-exist.jsonl").exists()


def _walk_codes(code: CodeType) -> Iterable[CodeType]:
    """Yield a code object and every nested function body it contains."""
    yield code
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            yield from _walk_codes(constant)


def _constructs_decision(callable_: object) -> bool:
    """Detect a function body that directly names the decision constructor."""
    code = getattr(callable_, "__code__", None)
    return type(code) is CodeType and any(
        "HumanDecision" in nested.co_names for nested in _walk_codes(code)
    )


def _package_callables() -> tuple[tuple[str, object], frozenset[str]]:
    """Walk package-owned public Python functions and public class methods.

    Imported standard-library callables are inspected in their defining module,
    not again through every re-export.  Classes are traversed for their public
    methods rather than treated as a callable constructor target themselves.
    The explicit empty skipped set pins that no discovered package function was
    silently omitted for lacking bytecode.
    """
    found: list[tuple[str, object]] = []
    skipped: set[str] = set()
    modules = [nous_os]
    modules.extend(
        importlib.import_module(info.name)
        for info in pkgutil.iter_modules(nous_os.__path__, "nous_os.")
    )
    for module in modules:
        for name, value in vars(module).items():
            if name.startswith("_") or getattr(value, "__module__", None) != module.__name__:
                continue
            qualified = f"{module.__name__}.{name}"
            if inspect.isfunction(value):
                found.append((qualified, value))
            elif inspect.isclass(value):
                for method_name, method in vars(value).items():
                    if method_name.startswith("_"):
                        continue
                    if isinstance(method, (staticmethod, classmethod)):
                        method = method.__func__
                    method_qualified = f"{qualified}.{method_name}"
                    if inspect.isfunction(method):
                        found.append((method_qualified, method))
                    elif callable(method):
                        skipped.add(method_qualified)
    return tuple(found), frozenset(skipped)


def test_no_public_package_callable_constructs_a_human_decision() -> None:
    """The package has no route that can manufacture the required human value."""
    def positive_control() -> HumanDecision:
        return HumanDecision(
            adjudicator="probe human",
            verdict=Verdict.PROMOTE,
            decided_at=_WHEN,
            rationale="probe",
            subject=_subject(KeyOrigin.OPERATOR),
        )

    assert _constructs_decision(positive_control)
    callables, skipped = _package_callables()
    # All package-defined public functions have Python bytecode; an unexpected
    # extension descriptor must be named here rather than silently ignored.
    assert skipped == frozenset()
    visited = len(callables)
    assert visited > 40, f"structural walk visited only {visited} callables"
    offenders = [name for name, value in callables if _constructs_decision(value)]
    assert offenders == []


def test_promote_accepts_only_the_promote_verdict(tmp_path: Path) -> None:
    """The positive control proves the gate does not refuse every decision."""
    decision = _decision(verdict=Verdict.PROMOTE)
    candidate = _candidate()
    record = promote(decision=decision, candidate=candidate, canon=tmp_path / "promotions.jsonl")
    assert record.verdict is Verdict.PROMOTE


def test_reject_does_not_promote(tmp_path: Path) -> None:
    """A complete reject decision is refused only because of its verdict."""
    decision = _decision(verdict=Verdict.REJECT)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert type(candidate) is Proposal
    assert decision.subject.origin is KeyOrigin.OPERATOR
    with pytest.raises(AdjudicationError, match="'reject'"):
        promote(decision=decision, candidate=candidate, canon=tmp_path / "promotions.jsonl")


def test_defer_does_not_promote(tmp_path: Path) -> None:
    """Defer is a real outcome and cannot read as a pending promotion."""
    decision = _decision(verdict=Verdict.DEFER)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert type(candidate) is Proposal
    assert decision.subject.origin is KeyOrigin.OPERATOR
    with pytest.raises(AdjudicationError, match="'defer'"):
        promote(decision=decision, candidate=candidate, canon=tmp_path / "promotions.jsonl")


def test_origin_discrimination_is_driven_by_the_closed_enumeration(tmp_path: Path) -> None:
    """Only the allowlisted two origins may reach an authorization record."""
    for origin in KeyOrigin:
        decision = _decision(origin=origin)
        candidate = _candidate()
        assert type(decision) is HumanDecision
        assert decision.verdict is Verdict.PROMOTE
        assert type(candidate) is Proposal
        destination = tmp_path / f"{origin.value}.jsonl"
        if origin in {KeyOrigin.OPERATOR, KeyOrigin.DERIVED}:
            assert promote(decision=decision, candidate=candidate, canon=destination).subject_origin is origin
        else:
            with pytest.raises(AdjudicationError, match=origin.value):
                promote(decision=decision, candidate=candidate, canon=destination)


def test_content_refusal_is_an_isolated_negative_control(tmp_path: Path) -> None:
    """Content origin alone, not a malformed decision or proposal, causes refusal."""
    decision = _decision(origin=KeyOrigin.CONTENT)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert decision.verdict is Verdict.PROMOTE
    assert type(candidate) is Proposal
    assert decision.subject.citation is _CITATION
    with pytest.raises(AdjudicationError, match="content"):
        promote(decision=decision, candidate=candidate, canon=tmp_path / "promotion.jsonl")


def test_unknown_refusal_is_an_isolated_negative_control(tmp_path: Path) -> None:
    """Unknown origin alone cannot acquire permission by being unclassified."""
    decision = _decision(origin=KeyOrigin.UNKNOWN)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert decision.verdict is Verdict.PROMOTE
    assert type(candidate) is Proposal
    assert decision.subject.citation is None
    with pytest.raises(AdjudicationError, match="unknown"):
        promote(decision=decision, candidate=candidate, canon=tmp_path / "promotion.jsonl")


def test_rejection_memory_is_append_only_and_non_vacuous(tmp_path: Path) -> None:
    """An empty store says False, while a recorded cluster supplies the positive control."""
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    assert memory.is_rejected("cluster-a") is False
    first = memory.record(
        cluster_id="cluster-b",
        failed_gate="citation",
        reason="the cited bytes changed",
        round_number=1,
        rejected_at=_WHEN,
    )
    second = memory.record(
        cluster_id="cluster-a",
        failed_gate="origin",
        reason="the key came from content",
        round_number=2,
        rejected_at=_WHEN + timedelta(minutes=1),
    )
    assert memory.rejections() == (first, second)
    assert memory.is_rejected("cluster-a") is True
    assert memory.is_rejected("cluster-missing") is False
    assert memory.rejected_clusters() == frozenset({"cluster-a", "cluster-b"})
    with pytest.raises(AdjudicationError, match="exact string"):
        memory.is_rejected(1)  # type: ignore[arg-type]


def _contains_promotion_value(value: object) -> bool:
    """Find a promotion-shaped value through the plain containers memory may return."""
    forbidden = (HumanDecision, AttributedKey, Proposal, Assertion)
    if type(value) in forbidden:
        return True
    if type(value) in (tuple, list, frozenset):
        return any(_contains_promotion_value(item) for item in value)
    return False


def test_agent_memory_returns_only_plain_strings_and_no_promotion_value(tmp_path: Path) -> None:
    """The memory store's restricted read surface is the separation mechanism."""
    memory = AgentMemory(tmp_path / "agent-memory.jsonl")
    memory.remember(session="session-1", note="follow up later", at=_WHEN)
    public_methods = {
        name: value
        for name, value in vars(AgentMemory).items()
        if not name.startswith("_") and inspect.isfunction(value)
    }
    assert set(public_methods) == {"remember", "notes"}
    # ``notes`` is the sole read member. ``remember`` mutates the isolated file
    # and requires arguments, so it is not invoked by this read-surface walk.
    returned = public_methods["notes"](memory)
    assert returned == (("session-1", "follow up later", _WHEN.isoformat()),)
    assert not _contains_promotion_value(returned)

    class ProbeMemory:
        def notes(self) -> HumanDecision:
            return _decision()

    assert _contains_promotion_value(ProbeMemory().notes())


def _scalar_violations(classes: Iterable[type[object]]) -> tuple[str, ...]:
    """Resolve postponed annotations before rejecting scalar-bearing data shapes."""
    forbidden = {float, int, complex, Decimal}
    violations: list[str] = []
    for cls in classes:
        for field_name, annotation in get_type_hints(cls).items():
            # Round count is a discrete event sequence, not confidence, score,
            # weight, or probability; this exact field is the sole allowance.
            if cls is Rejection and field_name == "round_number" and annotation is int:
                continue
            if annotation in forbidden:
                violations.append(f"{cls.__name__}.{field_name}")
    return tuple(violations)


def test_public_cap09_dataclasses_carry_no_scalar_and_the_guard_is_live() -> None:
    """Resolved hints, rather than postponed field strings, enforce no scalar fields."""
    import nous_os.adjudication as adjudication
    import nous_os.attribution as attribution

    records = tuple(
        cls
        for module in (attribution, adjudication)
        for name, cls in vars(module).items()
        if not name.startswith("_")
        and inspect.isclass(cls)
        and cls.__module__ == module.__name__
        and dataclasses.is_dataclass(cls)
    )
    assert _scalar_violations(records) == ()

    @dataclass
    class ScalarProbe:
        score: float

    assert _scalar_violations((ScalarProbe,)) == ("ScalarProbe.score",)
