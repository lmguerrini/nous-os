"""Acceptance oracles for attribution, human adjudication, and memory separation."""

from __future__ import annotations

import dataclasses
import ast
import copy
import importlib
import re
import inspect
import json
import pickle
import pkgutil
import tomllib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import CodeType, SimpleNamespace
from typing import Iterable, Optional, get_args, get_origin, get_type_hints

import pytest

import nous_os
from nous_os.adjudication import (
    AgentMemory,
    AdjudicationError,
    HumanDecision,
    PromotionRecord,
    Rejection,
    RejectionMemory,
    Verdict,
    promote,
)
from nous_os.attribution import AttributionError, AttributedKey, KeyOrigin, is_promotable
from nous_os.candidates import Proposal
from nous_os.canonical import Assertion
from nous_os.discovery import BridgeCard
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey
from nous_os.untrusted import UntrustedText
from tests.probes import decision_probes
from tests.probes import no_global_decision


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
            authorizations=tmp_path / "must-not-exist.jsonl",
        )
    assert "candidate" not in str(raised.value)
    assert not (tmp_path / "must-not-exist.jsonl").exists()


def test_pytest_pythonpath_keeps_source_and_repository_imports_available() -> None:
    """Bare pytest needs src imports and tests.probes without package installation."""
    project_file = Path(__file__).resolve().parents[1] / "pyproject.toml"
    configuration = tomllib.loads(project_file.read_text(encoding="utf-8"))
    pythonpath = configuration["tool"]["pytest"]["ini_options"]["pythonpath"]
    assert "src" in pythonpath
    # Both entries are asserted against the file's own text, because that is the
    # only check that can fail under BOTH invocations. `find_spec` cannot: this
    # module imports `tests.probes` at module scope, so it is already in
    # sys.modules and the spec is returned without consulting sys.path at all.
    assert "." in pythonpath
    assert importlib.util.find_spec("tests.probes") is not None


def test_no_module_imports_the_src_prefixed_package() -> None:
    """The source and installed package names must not create split identities."""
    root = Path(__file__).resolve().parents[1]
    offenders = []
    # Scoped to the two source roots: an in-tree virtualenv or vendored
    # dependency under the repository root would otherwise be scanned.
    for path in [q for directory in ("src", "tests") for q in (root / directory).rglob("*.py")]:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"^\s*(?:from|import)\s+src(?:\.|\s|$)", line):
                offenders.append(f"{path.relative_to(root)}:{line_number}")
    assert offenders == []


class _AssertionWriteScanner(ast.NodeVisitor):
    """Find a durable write fed directly by an Assertion-typed visible name."""

    _WRITE_METHODS = frozenset({"write", "write_text", "write_bytes"})

    def __init__(self) -> None:
        self._assertion_names = {"Assertion"}
        self._assertion_arguments: list[set[str]] = [set()]
        self.findings: list[int] = []

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module == "nous_os.canonical":
            self._assertion_names.update(
                alias.asname or alias.name for alias in node.names if alias.name == "Assertion"
            )
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        arguments = (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)
        assertion_arguments = {
            argument.arg
            for argument in arguments
            if isinstance(argument.annotation, ast.Name)
            and argument.annotation.id in self._assertion_names
        }
        self._assertion_arguments.append(assertion_arguments)
        self.generic_visit(node)
        self._assertion_arguments.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if (
            isinstance(node.target, ast.Name)
            and isinstance(node.annotation, ast.Name)
            and node.annotation.id in self._assertion_names
        ):
            self._assertion_arguments[-1].add(node.target.id)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in self._WRITE_METHODS
            and any(
                isinstance(name, ast.Name)
                and name.id in set().union(*self._assertion_arguments)
                for argument in (*node.args, *(keyword.value for keyword in node.keywords))
                for name in ast.walk(argument)
            )
        ):
            self.findings.append(node.lineno)
        self.generic_visit(node)


def test_no_module_durably_writes_an_assertion_until_a_later_capability_wires_it() -> None:
    """Canon is files today only in concept: promotion writes authorization, not Assertion data.

    This is a forward obligation, not a present defect. When a capability adds
    durable Assertion storage, this guard must fail so its authorization and
    temporal wiring are decided at the point that path becomes real.
    """
    root = Path(__file__).resolve().parents[1] / "src" / "nous_os"
    findings = {
        path.relative_to(root).as_posix(): scanner.findings
        for path in root.rglob("*.py")
        for scanner in [_AssertionWriteScanner()]
        if not (scanner.visit(ast.parse(path.read_text(encoding="utf-8"))) or False)
        and scanner.findings
    }
    assert findings == {}


def test_assertion_write_tripwire_covers_keyword_nested_and_module_scopes() -> None:
    """Ordinary argument syntax and lexical scope cannot hide Assertion writes."""
    sources = (
        "from nous_os.canonical import Assertion\n"
        "def save(assertion: Assertion, path):\n"
        "    path.write_text(data=assertion.subject)\n",
        "from nous_os.canonical import Assertion\n"
        "def save(assertion: Assertion, path):\n"
        "    def write():\n"
        "        path.write_text(assertion.subject)\n"
        "    write()\n",
        "from nous_os.canonical import Assertion\n"
        "assertion: Assertion\n"
        "path.write_text(assertion.subject)\n",
    )
    findings = []
    for source in sources:
        scanner = _AssertionWriteScanner()
        scanner.visit(ast.parse(source))
        findings.append(scanner.findings)
    assert findings == [[3], [4], [3]]


def _walk_codes(code: CodeType) -> Iterable[CodeType]:
    """Yield a code object and every nested function body it contains."""
    yield code
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            yield from _walk_codes(constant)


def _constructs_decision(
    callable_: object, disabled: frozenset[str] = frozenset()
) -> bool:
    """Find resolved aliases and literal class-name references in nested code.

    This is a union: changing a guard must only add coverage, never exchange
    one reference shape for another.  It detects the shapes enumerated here,
    but is secondary evidence rather than a completeness proof (for example,
    container-held references are outside this walk).  Value-side validation
    at ``promote`` is the primary control.
    """
    code = getattr(callable_, "__code__", None)
    globals_ = getattr(callable_, "__globals__", {})
    return type(code) is CodeType and any(
        ("alias" not in disabled and globals_.get(name) is HumanDecision)
        or ("literal" not in disabled and name == "HumanDecision")
        for nested in _walk_codes(code)
        for name in nested.co_names
    )


def _assert_each_clause_is_necessary(
    guard: object, discriminating_samples: dict[str, object]
) -> None:
    """Each named clause must change its own discriminating guard verdict.

    The sample set is required to be non-empty: a caller that supplies none
    would otherwise pass this helper without any clause being exercised, which
    is the vacuity this helper exists to prevent one level down.
    """
    assert callable(guard)
    assert discriminating_samples, "clause-necessity needs at least one sample"
    for clause, sample in discriminating_samples.items():
        baseline = guard(frozenset(), sample)
        assert guard(frozenset({clause}), sample) is not baseline


def _package_callables() -> tuple[tuple[str, object], frozenset[str], frozenset[str]]:
    """Walk every package module and every reachable callable member.

    Public module functions and public classes are discovered from the package;
    every callable member of each public class is retained, including dunders.
    Descriptor wrappers are opened before bytecode is inspected, and nested code
    objects are handled by ``_walk_codes``.
    """
    found: list[tuple[str, object]] = []
    coverage: set[str] = set()
    skipped: set[str] = set()

    def retain(qualified: str, callable_: object) -> None:
        """Keep analysable callables and name every unanalysable one."""
        coverage.add(qualified)
        if not callable(callable_):
            return
        if type(getattr(callable_, "__code__", None)) is CodeType:
            found.append((qualified, callable_))
        else:
            skipped.add(qualified)

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
                retain(qualified, value)
            elif inspect.isclass(value):
                for method_name, method in vars(value).items():
                    if method_name.startswith("_") and not (
                        method_name.startswith("__") and method_name.endswith("__")
                    ):
                        continue
                    if isinstance(method, (staticmethod, classmethod)):
                        method = method.__func__
                        method_qualified = f"{qualified}.{method_name}"
                        retain(method_qualified, method)
                    elif isinstance(method, property):
                        for accessor_name in ("fget", "fset", "fdel"):
                            accessor = getattr(method, accessor_name)
                            if accessor is not None:
                                method_qualified = f"{qualified}.{method_name}.{accessor_name}"
                                retain(method_qualified, accessor)
                    else:
                        method_qualified = f"{qualified}.{method_name}"
                        retain(method_qualified, method)
    return tuple(found), frozenset(coverage), frozenset(skipped)


# ``promote`` is allowed to reference the class only to enforce an exact-type
# boundary, while ``__reduce__`` may reference it only to reconstruct through
# validation; any other reference, including a type-checking helper, is drift.
_MAY_REFERENCE_DECISION = frozenset(
    {"nous_os.adjudication.promote", "nous_os.adjudication.HumanDecision.__reduce__"}
)


_PROBE_CASES = (
    ("direct constructor", decision_probes.direct_constructor, True),
    ("local alias constructor", decision_probes.local_alias_constructor, True),
    ("dunder constructor", decision_probes.DecisionFactory.__call__, True),
    ("text mention", decision_probes.mentions_decision_in_text, False),
    ("type check", decision_probes.type_checks_decision, True),
    ("module qualified", decision_probes.module_qualified_constructor, True),
    ("function local import", decision_probes.function_local_import_constructor, True),
    ("alias only", decision_probes.alias_only_constructor, True),
    ("isolated module qualified", no_global_decision.module_qualified_constructor, True),
    ("isolated function local import", no_global_decision.function_local_import_constructor, True),
)


@pytest.mark.parametrize("label, probe, expected", _PROBE_CASES, ids=[case[0] for case in _PROBE_CASES])
def test_decision_reference_probe_cases_are_pinned(
    label: str, probe: object, expected: bool
) -> None:
    """The same identity detector catches capabilities, not text or spellings."""
    assert len(_PROBE_CASES) == 10
    assert _constructs_decision(probe) is expected, label


def test_decision_reference_union_pins_each_half() -> None:
    """The identity and literal halves each detect a shape the other misses."""
    assert "HumanDecision" not in vars(no_global_decision)
    assert vars(decision_probes)["Decision"] is HumanDecision
    _assert_each_clause_is_necessary(
        lambda disabled, sample: _constructs_decision(sample, disabled),
        {
            "alias": decision_probes.alias_only_constructor,
            "literal": no_global_decision.module_qualified_constructor,
        },
    )


def test_no_public_package_callable_constructs_a_human_decision() -> None:
    """The static oracle pins reachable references by resolved object identity."""
    callables, coverage, skipped = _package_callables()
    assert "nous_os.adjudication.HumanDecision.__init_subclass__" in coverage
    assert "nous_os.adjudication.HumanDecision.__post_init__" in coverage
    assert "nous_os.adjudication.PromotionRecord.as_payload" in coverage
    assert "nous_os.adjudication.Verdict.__new__" in coverage
    assert any(name.endswith(".fget") for name in coverage)
    assert skipped == frozenset()
    visited = len(callables)
    # Floor recomputed from a real run: 577 callables were visited. Recompute
    # it whenever the package gains a module or public callable surface.
    assert visited > 576, f"structural walk visited only {visited} callables"
    observed = frozenset(name for name, value in callables if _constructs_decision(value))
    assert observed == _MAY_REFERENCE_DECISION


def test_decision_reference_walk_refuses_unanalysable_callable_members(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A partial factory has no code object, so package coverage must fail closed."""
    import nous_os.adjudication as adjudication

    class DecisionMint:
        make = decision_probes.PartialDecisionMint.make

    DecisionMint.__module__ = adjudication.__name__
    monkeypatch.setattr(adjudication, "DecisionMint", DecisionMint, raising=False)
    _callables, _coverage, skipped = _package_callables()
    assert skipped == frozenset({"nous_os.adjudication.DecisionMint.make"})


def test_static_allowlist_and_runtime_counter_are_independent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """References may be allowlisted, while an executed construction is still observable."""
    assert _constructs_decision(promote) is True
    assert "nous_os.adjudication.promote" in _MAY_REFERENCE_DECISION

    calls = 0
    original_init = HumanDecision.__init__

    def counting_init(self: HumanDecision, *args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(HumanDecision, "__init__", counting_init)

    def runtime_construction(callable_: object) -> bool:
        before = calls
        try:
            callable_()
        except TypeError:
            pass
        return calls > before

    # Two direct assertions, not a clause-necessity rig. These are not the
    # clauses of any one guard: they are two SEPARATE oracles, and the property
    # worth stating is that each sees what the other cannot. Dressing that as a
    # per-clause rig would claim a structure this check does not have.
    assert _constructs_decision(decision_probes.PartialDecisionMint.make) is False
    assert runtime_construction(decision_probes.PartialDecisionMint.make) is True
    assert _constructs_decision(decision_probes.direct_constructor) is True


def test_decision_reference_counter_covers_executed_public_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The behavioural oracle covers executed paths; static analysis covers reachable references.

    Neither oracle alone is a completeness proof: one observes execution and
    the other observes reachable references.
    """
    accepted = _decision()
    refused = _decision(origin=KeyOrigin.UNKNOWN)
    candidate = _candidate()
    counter = 0
    original_init = HumanDecision.__init__

    def counting_init(self: HumanDecision, *args: object, **kwargs: object) -> None:
        nonlocal counter
        counter += 1
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(HumanDecision, "__init__", counting_init)
    _ = HumanDecision(
        adjudicator="positive control",
        verdict=Verdict.PROMOTE,
        decided_at=_WHEN,
        rationale="counter control",
        subject=_subject(KeyOrigin.OPERATOR),
    )
    assert counter == 1
    counter = 0

    rejection_memory = RejectionMemory(tmp_path / "rejections.jsonl")
    agent_memory = AgentMemory(tmp_path / "agent.jsonl")
    import nous_os.adjudication as adjudication

    drivers = {
        "nous_os.adjudication.promote": lambda: promote(
            decision=accepted, candidate=candidate, authorizations=tmp_path / "authorizations.jsonl"
        ),
        "nous_os.adjudication.RejectionMemory.record": lambda: rejection_memory.record(
            cluster_id="cluster", failed_gate="origin", reason="unknown", round_number=1, rejected_at=_WHEN
        ),
        "nous_os.adjudication.RejectionMemory.rejections": rejection_memory.rejections,
        "nous_os.adjudication.RejectionMemory.is_rejected": lambda: rejection_memory.is_rejected("cluster"),
        "nous_os.adjudication.RejectionMemory.rejected_clusters": rejection_memory.rejected_clusters,
        "nous_os.adjudication.AgentMemory.remember": lambda: agent_memory.remember(
            session="session", note="note", at=_WHEN
        ),
        "nous_os.adjudication.AgentMemory.notes": agent_memory.notes,
    }
    public_classes = tuple(
        value
        for name, value in vars(adjudication).items()
        if not name.startswith("_")
        and inspect.isclass(value)
        and value.__module__ == adjudication.__name__
    )
    entry_points = (
        tuple(
            f"{adjudication.__name__}.{name}"
            for name, value in vars(adjudication).items()
            if not name.startswith("_")
            and inspect.isfunction(value)
            and value.__module__ == adjudication.__name__
        )
        + tuple(
            f"nous_os.adjudication.{cls.__name__}.{name}"
            for cls in public_classes
            for name, value in vars(cls).items()
            if not name.startswith("_") and inspect.isfunction(value)
        )
    )
    authorizations = tmp_path / "authorizations.jsonl"
    promotion_record = PromotionRecord(
        proposal_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        adjudicator="human reviewer",
        decided_at=_WHEN,
        verdict=Verdict.PROMOTE,
        subject_key="subject",
        subject_origin=KeyOrigin.OPERATOR,
    )
    rejection_record = Rejection(
        cluster_id="cluster",
        failed_gate="origin",
        reason="unknown",
        round_number=1,
        rejected_at=_WHEN,
    )

    def drive_promote() -> PromotionRecord:
        result = promote(decision=accepted, candidate=candidate, authorizations=authorizations)
        assert authorizations.is_file()
        return result

    def drive_record() -> Rejection:
        return rejection_memory.record(
            cluster_id="cluster",
            failed_gate="origin",
            reason="unknown",
            round_number=1,
            rejected_at=_WHEN,
        )

    def drive_remember() -> tuple[tuple[str, str, str], ...]:
        agent_memory.remember(session="session", note="note", at=_WHEN)
        result = agent_memory.notes()
        assert result == (("session", "note", _WHEN.isoformat()),)
        return result

    drivers.update(
        {
            "nous_os.adjudication.PromotionRecord.as_payload": promotion_record.as_payload,
            "nous_os.adjudication.Rejection.as_payload": rejection_record.as_payload,
            "nous_os.adjudication.promote": drive_promote,
            "nous_os.adjudication.RejectionMemory.record": drive_record,
            "nous_os.adjudication.AgentMemory.remember": drive_remember,
        }
    )
    assert len(entry_points) == 9
    assert frozenset(drivers) == frozenset(entry_points)
    observations = [drivers[entry_point]() for entry_point in entry_points]
    assert len(observations) == len(entry_points) == 9
    assert all(observation is not None for observation in observations)
    assert rejection_memory.rejections() == (rejection_record,)
    assert agent_memory.notes() == (("session", "note", _WHEN.isoformat()),)

    with pytest.raises(AdjudicationError, match="unknown"):
        promote(decision=refused, candidate=candidate, authorizations=tmp_path / "refused.jsonl")

    for origin in KeyOrigin:
        AttributedKey(
            key=ClaimKey("subject"),
            origin=origin,
            citation=_CITATION if origin is KeyOrigin.CONTENT else None,
        )
    assert counter == 0


def test_promote_accepts_only_the_promote_verdict(tmp_path: Path) -> None:
    """The accepted control writes exactly one matching authorization line."""
    decision = _decision(verdict=Verdict.PROMOTE)
    candidate = _candidate()
    target = tmp_path / "promotions.jsonl"
    before = b"existing line\n"
    target.write_bytes(before)
    record = promote(
        decision=decision,
        candidate=candidate,
        authorizations=target,
    )
    assert record.verdict is Verdict.PROMOTE
    written = target.read_bytes()
    lines = written.splitlines(keepends=True)
    assert len(lines) == 2
    assert lines[0] == before
    assert written.endswith(b"\n")
    assert len(written) - len(before) == len(lines[-1])
    assert json.loads(lines[-1]) == {
        "proposal_id": "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "adjudicator": "human reviewer",
        "decided_at": "2026-01-02T12:00:00+00:00",
        "verdict": "promote",
        "subject_key": "subject",
        "subject_origin": "operator",
    }


def test_human_decision_restoration_revalidates_for_pickle_and_copies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pickle, shallow copy, and deep copy rebuild through validating construction."""
    decision = _decision()
    original_post_init = HumanDecision.__post_init__
    calls = 0

    def counting_post_init(self: HumanDecision) -> None:
        nonlocal calls
        calls += 1
        original_post_init(self)

    monkeypatch.setattr(HumanDecision, "__post_init__", counting_post_init)
    round_trips = (
        ("pickle", lambda value: pickle.loads(pickle.dumps(value))),
        ("copy", copy.copy),
        ("deepcopy", copy.deepcopy),
    )
    for label, round_trip in round_trips:
        calls = 0
        restored = round_trip(decision)
        assert type(restored) is HumanDecision, label
        assert restored == decision, label
        assert calls == 1, label


def test_human_decision_refuses_in_place_state_restoration() -> None:
    """Slot state cannot be restored around the validating constructor."""
    with pytest.raises(AdjudicationError, match="state cannot be restored"):
        _decision().__setstate__({})


def test_promote_refuses_unset_fabricated_decision_without_writing(tmp_path: Path) -> None:
    """Unset slots raise the domain error before any candidate or filesystem work."""
    target = tmp_path / "deep" / "nested" / "authorization.jsonl"
    fabricated = object.__new__(HumanDecision)
    with pytest.raises(AdjudicationError, match="adjudicator"):
        promote(decision=fabricated, candidate=_candidate(), authorizations=target)
    assert not target.parent.exists()


@pytest.mark.parametrize("field_name", ("adjudicator", "verdict", "decided_at", "rationale", "subject"))
def test_promote_revalidates_each_fabricated_decision_field(
    field_name: str, tmp_path: Path
) -> None:
    """Every field is checked at the boundary, not merely during construction."""
    valid = _decision()
    fabricated = object.__new__(HumanDecision)
    for name in ("adjudicator", "verdict", "decided_at", "rationale", "subject"):
        object.__setattr__(fabricated, name, getattr(valid, name))
    object.__setattr__(fabricated, field_name, object())
    target = tmp_path / field_name / "authorization.jsonl"
    with pytest.raises(AdjudicationError, match=field_name):
        promote(decision=fabricated, candidate=_candidate(), authorizations=target)
    assert not target.parent.exists()


_REFUSAL_CASES = ("decision", "reject", "defer", "content", "unknown", "candidate")


@pytest.mark.parametrize("refusal", _REFUSAL_CASES)
@pytest.mark.parametrize("target_exists", (False, True))
def test_every_refusal_leaves_authorizations_byte_identical(
    refusal: str, target_exists: bool, tmp_path: Path
) -> None:
    """Each isolated refusal leaves both absent and existing targets untouched."""
    assert len(_REFUSAL_CASES) == 6
    target = tmp_path / "deep" / refusal / "authorization.jsonl"
    original = b"known authorization bytes\n"
    if target_exists:
        target.parent.mkdir(parents=True)
        target.write_bytes(original)

    candidate = _candidate()
    if refusal == "decision":
        decision: object = object()
        assert type(candidate) is Proposal
    else:
        decision = _decision(
            verdict={
                "reject": Verdict.REJECT,
                "defer": Verdict.DEFER,
            }.get(refusal, Verdict.PROMOTE),
            origin={
                "content": KeyOrigin.CONTENT,
                "unknown": KeyOrigin.UNKNOWN,
            }.get(refusal, KeyOrigin.OPERATOR),
        )
        assert type(decision) is HumanDecision
        if refusal in {"reject", "defer"}:
            assert decision.verdict is {"reject": Verdict.REJECT, "defer": Verdict.DEFER}[refusal]
        else:
            assert decision.verdict is Verdict.PROMOTE
        if refusal in {"reject", "defer", "candidate"}:
            assert decision.subject.origin is KeyOrigin.OPERATOR
        if refusal in {"content", "unknown"}:
            assert is_promotable(decision.subject) is False
        else:
            assert is_promotable(decision.subject) is True
    if refusal == "candidate":
        candidate = object()
        assert type(decision) is HumanDecision
        assert decision.verdict is Verdict.PROMOTE
        assert is_promotable(decision.subject) is True
    else:
        assert type(candidate) is Proposal

    with pytest.raises(AdjudicationError, match={
        "decision": "decision",
        "reject": "'reject'",
        "defer": "'defer'",
        "content": "content",
        "unknown": "unknown",
        "candidate": "candidate",
    }[refusal]):
        promote(decision=decision, candidate=candidate, authorizations=target)  # type: ignore[arg-type]

    assert target.exists() is target_exists
    if target_exists:
        assert target.read_bytes() == original
    else:
        assert not target.parent.exists()


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
            assert promote(
                decision=decision,
                candidate=candidate,
                authorizations=destination,
            ).subject_origin is origin
        else:
            with pytest.raises(AdjudicationError, match=origin.value):
                promote(decision=decision, candidate=candidate, authorizations=destination)


def test_content_refusal_is_an_isolated_negative_control(tmp_path: Path) -> None:
    """Content origin alone, not a malformed decision or proposal, causes refusal."""
    decision = _decision(origin=KeyOrigin.CONTENT)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert decision.verdict is Verdict.PROMOTE
    assert type(candidate) is Proposal
    assert decision.subject.citation is _CITATION
    with pytest.raises(AdjudicationError, match="content"):
        promote(
            decision=decision,
            candidate=candidate,
            authorizations=tmp_path / "promotion.jsonl",
        )


def test_unknown_refusal_is_an_isolated_negative_control(tmp_path: Path) -> None:
    """Unknown origin alone cannot acquire permission by being unclassified."""
    decision = _decision(origin=KeyOrigin.UNKNOWN)
    candidate = _candidate()
    assert type(decision) is HumanDecision
    assert decision.verdict is Verdict.PROMOTE
    assert type(candidate) is Proposal
    assert decision.subject.citation is None
    with pytest.raises(AdjudicationError, match="unknown"):
        promote(
            decision=decision,
            candidate=candidate,
            authorizations=tmp_path / "promotion.jsonl",
        )


def test_uninitialised_enum_lookalikes_are_not_canonical_members() -> None:
    """Identity guards reject enum-shaped objects with no declared member value."""
    fabricated_verdict = object.__new__(Verdict)
    fabricated_origin = object.__new__(KeyOrigin)
    import nous_os.adjudication as adjudication
    import nous_os.attribution as attribution

    assert adjudication._is_canonical_verdict(fabricated_verdict) is False
    assert attribution._is_canonical_origin(fabricated_origin) is False
    with pytest.raises(AdjudicationError, match="Verdict"):
        HumanDecision(
            adjudicator="human reviewer",
            verdict=fabricated_verdict,
            decided_at=_WHEN,
            rationale="The stated evidence was reviewed.",
            subject=_subject(KeyOrigin.OPERATOR),
        )
    with pytest.raises(AttributionError, match="origin"):
        AttributedKey(ClaimKey("subject"), fabricated_origin)
    fabricated_key = object.__new__(AttributedKey)
    object.__setattr__(fabricated_key, "key", ClaimKey("subject"))
    object.__setattr__(fabricated_key, "origin", fabricated_origin)
    object.__setattr__(fabricated_key, "citation", None)
    assert is_promotable(fabricated_key) is False


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


def test_an_unreadable_rejection_line_is_reported_not_skipped(tmp_path: Path) -> None:
    """A line nobody can parse is not an absent line."""
    path = tmp_path / "rejections.jsonl"
    memory = RejectionMemory(path)
    memory.record(
        cluster_id="cluster-a",
        failed_gate="citation",
        reason="the cited bytes changed",
        round_number=1,
        rejected_at=_WHEN,
    )
    with path.open("ab") as handle:
        handle.write(b"{not json\n")
    with pytest.raises(AdjudicationError, match="rejection line 2 is not readable"):
        memory.rejections()


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


def test_an_unreadable_agent_memory_line_is_reported_not_skipped(tmp_path: Path) -> None:
    """A line nobody can parse is not an absent line."""
    path = tmp_path / "agent-memory.jsonl"
    memory = AgentMemory(path)
    memory.remember(session="session-1", note="follow up later", at=_WHEN)
    with path.open("ab") as handle:
        handle.write(b"{not json\n")
    with pytest.raises(AdjudicationError, match="agent-memory line 2 is not readable"):
        memory.notes()


def _allows_round_number(
    cls: type[object],
    field_name: str,
    *,
    disabled: frozenset[str] = frozenset(),
) -> bool:
    """Allow only Rejection and discovery-record discrete round counters."""
    rejection_counter = {
        "rejection_class": cls is Rejection,
        "round_number_field": field_name == "round_number",
    }
    discovery_counter = {
        "discovery_round_record": cls.__module__ == "nous_os.discovery"
        and cls.__name__ in {"BridgeCard", "RoundResult"},
        "round_counter_field": field_name in {"origin_round", "round_number"},
    }
    return all(value for name, value in rejection_counter.items() if name not in disabled) or all(
        value for name, value in discovery_counter.items() if name not in disabled
    )


def _allows_scalar_int(
    annotation: object, *, disabled: frozenset[str] = frozenset()
) -> bool:
    """Evaluate the scalar type clause at the sole enforcement point."""
    return "annotation_is_int" not in disabled and annotation is int


def _scalar_violations(classes: Iterable[type[object]]) -> tuple[str, ...]:
    """Reject a forbidden scalar anywhere in a resolved type expression."""
    forbidden = {float, int, complex, Decimal}

    def contains_forbidden(annotation: object, *, allow_top_level_int: bool) -> bool:
        if type(annotation) is type and annotation in forbidden:
            return not (allow_top_level_int and _allows_scalar_int(annotation))
        origin = get_origin(annotation)
        args = get_args(annotation)
        if origin is not None or args:
            return any(
                contains_forbidden(
                    argument, allow_top_level_int=False
                )
                for argument in args
            )
        if isinstance(annotation, (tuple, list)):
            return any(
                contains_forbidden(
                    argument, allow_top_level_int=False
                )
                for argument in annotation
            )
        return False

    violations: list[str] = []
    for cls in classes:
        for field_name, annotation in get_type_hints(cls).items():
            # Round count is a discrete event sequence, not confidence, score,
            # weight, or probability; this exact top-level field is the sole allowance.
            allow_top_level_int = _allows_round_number(cls, field_name)
            if contains_forbidden(
                annotation,
                allow_top_level_int=allow_top_level_int,
            ):
                violations.append(f"{cls.__name__}.{field_name}")
    return tuple(violations)


def test_public_cap09_dataclasses_carry_no_scalar_and_the_guard_is_live() -> None:
    """Resolved hints, rather than postponed field strings, enforce no scalar fields."""
    import nous_os.adjudication as adjudication
    import nous_os.attribution as attribution
    import nous_os.discovery as discovery

    records = tuple(
        cls
        for module in (attribution, adjudication, discovery)
        for name, cls in vars(module).items()
        if not name.startswith("_")
        and inspect.isclass(cls)
        and cls.__module__ == module.__name__
        and dataclasses.is_dataclass(cls)
    )
    assert _scalar_violations(records) == ()

    positive_shapes = (
        ("score", float),
        ("score", float | None),
        ("score", Optional[float]),
        ("scores", tuple[float, ...]),
        ("scores", list[float]),
        ("scores", dict[str, float]),
        ("score", Decimal | None),
        ("nested", tuple[tuple[float, ...], ...]),
        ("count", int),
    )
    assert len(positive_shapes) == 9
    for field_name, annotation in positive_shapes:
        probe = dataclasses.make_dataclass("ScalarProbe", [(field_name, annotation)])
        assert _scalar_violations((probe,)) == (f"ScalarProbe.{field_name}",)

    negative_shapes = (
        ("citation", Citation | None),
        ("subject", AttributedKey),
        ("verdict", Verdict),
        ("decided_at", datetime),
        ("origin", KeyOrigin),
    )
    assert len(negative_shapes) == 5
    for field_name, annotation in negative_shapes:
        probe = dataclasses.make_dataclass("NonScalarProbe", [(field_name, annotation)])
        assert _scalar_violations((probe,)) == ()


def test_round_number_allowance_is_top_level_only() -> None:
    """Only the four explicit discrete-round clauses allow a top-level int."""
    _assert_each_clause_is_necessary(
        lambda disabled, sample: _allows_round_number(
            sample[0],
            sample[1],
            disabled=disabled,
        ),
        {
            "rejection_class": (object, "round_number", int),
            "round_number_field": (Rejection, "not_round_number", int),
            "discovery_round_record": (Rejection, "origin_round", int),
            "round_counter_field": (BridgeCard, "weight", int),
        },
    )
    _assert_each_clause_is_necessary(
        lambda disabled, sample: _allows_scalar_int(sample, disabled=disabled),
        {"annotation_is_int": int},
    )
    original = Rejection.__annotations__["round_number"]
    Rejection.__annotations__["round_number"] = "tuple[int, ...]"
    try:
        assert _scalar_violations((Rejection,)) == ("Rejection.round_number",)
    finally:
        Rejection.__annotations__["round_number"] = original
    Rejection.__annotations__["round_number"] = "float"
    try:
        assert _scalar_violations((Rejection,)) == ("Rejection.round_number",)
    finally:
        Rejection.__annotations__["round_number"] = original


_NAIVE_ENTRY_POINTS = (
    (
        "HumanDecision.decided_at",
        lambda _tmp: HumanDecision(
            adjudicator="human reviewer",
            verdict=Verdict.PROMOTE,
            decided_at=_WHEN.replace(tzinfo=None),
            rationale="reviewed",
            subject=_subject(KeyOrigin.OPERATOR),
        ),
    ),
    (
        "Rejection.rejected_at",
        lambda _tmp: Rejection(
            cluster_id="cluster",
            failed_gate="origin",
            reason="unknown",
            round_number=1,
            rejected_at=_WHEN.replace(tzinfo=None),
        ),
    ),
    (
        "RejectionMemory.record(rejected_at=...)",
        lambda tmp: RejectionMemory(tmp / "rejections.jsonl").record(
            cluster_id="cluster",
            failed_gate="origin",
            reason="unknown",
            round_number=1,
            rejected_at=_WHEN.replace(tzinfo=None),
        ),
    ),
    (
        "AgentMemory.remember(at=...)",
        lambda tmp: AgentMemory(tmp / "agent.jsonl").remember(
            session="session",
            note="note",
            at=_WHEN.replace(tzinfo=None),
        ),
    ),
    (
        "PromotionRecord.decided_at",
        lambda _tmp: PromotionRecord(
            proposal_id="proposal",
            adjudicator="human reviewer",
            decided_at=_WHEN.replace(tzinfo=None),
            verdict=Verdict.PROMOTE,
            subject_key="subject",
            subject_origin=KeyOrigin.OPERATOR,
        ),
    ),
)


@pytest.mark.parametrize("entry_name, entry_point", _NAIVE_ENTRY_POINTS)
def test_every_datetime_entry_point_refuses_a_naive_instant(
    entry_name: str, entry_point: object, tmp_path: Path
) -> None:
    """Every public datetime boundary routes through the timezone refusal."""
    assert len(_NAIVE_ENTRY_POINTS) == 5
    assert entry_name
    with pytest.raises(AdjudicationError, match="timezone"):
        entry_point(tmp_path)  # type: ignore[operator]


def test_human_decision_subclasses_are_refused_at_class_creation() -> None:
    """Subclass refusal pins the first layer before promote's exact-type check."""
    # ``promote``'s exact-type check is the second layer; this pins the first.
    with pytest.raises(AdjudicationError, match="may not be subclassed"):
        class DecisionSubclass(HumanDecision):
            pass
