"""The measuring instrument: the instrument, built before the thing it judges.

A later capability picks a context-compilation strategy on measured evidence.
The instrument that produces that evidence is built here, first, so that it
cannot be shaped by the result it will later report. That ordering is the whole
reason this exists as its own capability.

**Not-run is a third outcome, and it is the important one.** Every result this
module produces carries a status, and a run whose corpus was absent reports
``NOT_RUN`` rather than an empty pass. Downstream capabilities cite these
numbers; a instrument that reported success when it had nothing to measure would
poison every conclusion drawn from it, silently, and long after the run that
produced it.

The measurements are deliberately plain. A rescue rate is a count over a count,
reported with both numbers, so a reader sees the count and its denominator
rather than a bare percentage, and can judge the denominator for themselves.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from nous_os.aliases import AliasTable, expand_query
from nous_os.derived import DerivedStoreError, search
from nous_os.identity import canonical_bytes, digest_payload


class MeasurementError(Exception):
    """Raised when a run cannot be carried out as specified."""


class Outcome(Enum):
    """What one golden case did. Three answers, not two."""

    #: Every expected document was found.
    HIT = "hit"
    #: At least one expected document was not found.
    MISS = "miss"
    #: The case was not evaluated. Not a miss, and certainly not a hit.
    NOT_RUN = "not_run"


class RunStatus(Enum):
    """Whether the run happened at all."""

    COMPLETE = "complete"
    #: The corpus this run needed was not present. **Never a pass.**
    NOT_RUN = "not_run"


@dataclass(frozen=True, slots=True)
class GoldenCase:
    """One query and the documents a correct system must return for it."""

    #: Source identifiers, not digests. A golden file naming digests would have
    #: to be rewritten whenever a fixture's wording changed, which invites
    #: regenerating expectations from the run they are meant to constrain.
    query: str
    expect: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self.query) is not str or not self.query.strip():
            raise MeasurementError("a golden case needs a query")
        if type(self.expect) is not tuple or not self.expect:
            raise MeasurementError(f"case {self.query!r} must expect at least one document")
        if len(set(self.expect)) != len(self.expect):
            raise MeasurementError(f"case {self.query!r} lists a document twice")


@dataclass(frozen=True, slots=True)
class CaseResult:
    """What one case actually did."""

    query: str
    outcome: Outcome
    expected: tuple[str, ...]
    found: tuple[str, ...]

    @property
    def missing(self) -> tuple[str, ...]:
        return tuple(sorted(set(self.expected) - set(self.found)))


@dataclass(frozen=True, slots=True)
class RunResult:
    """The outcome of a whole run, reported so it can be compared and cited."""

    status: RunStatus
    derivation: str
    results: tuple[CaseResult, ...]
    reason: str | None = None

    @property
    def hits(self) -> int:
        return sum(1 for r in self.results if r.outcome is Outcome.HIT)

    @property
    def misses(self) -> tuple[CaseResult, ...]:
        return tuple(r for r in self.results if r.outcome is Outcome.MISS)

    def as_payload(self) -> dict[str, object]:
        """The canonical form, for comparison across runs and processes."""
        return {
            "status": self.status.value,
            "derivation": self.derivation,
            "reason": self.reason,
            "cases": [
                {
                    "query": r.query,
                    "outcome": r.outcome.value,
                    "expected": list(r.expected),
                    "found": list(r.found),
                }
                for r in self.results
            ],
        }

    @property
    def digest(self) -> str:
        """A digest of the whole run, so two runs can be compared exactly."""
        return digest_payload(self.as_payload())

    def to_bytes(self) -> bytes:
        return canonical_bytes(self.as_payload())


def not_run(derivation: str, reason: str) -> RunResult:
    """A run that did not happen, said out loud.

    Construction requires a reason. A not-run result with no explanation is
    indistinguishable from an oversight, and this is the value most likely to be
    read months later by someone deciding whether a benchmark supports a claim.
    """
    if type(reason) is not str or not reason.strip():
        raise MeasurementError("a not-run result must say why it did not run")
    return RunResult(RunStatus.NOT_RUN, derivation, (), reason)


def run_golden(
    store_path: Path,
    cases: tuple[GoldenCase, ...],
    table: AliasTable,
    limit: int = 20,
) -> RunResult:
    """Run every case against the index and report what each did.

    Refuses an empty case set: a run over no cases would report a perfect score
    and would mean nothing, which is the shape of result this module exists to
    make impossible.
    """
    if not cases:
        raise MeasurementError("a run needs at least one case; an empty run scores perfectly")
    path = Path(store_path)
    if not path.is_file():
        return not_run(table.name, f"no derived store at {path.name}")

    results = []
    for case in cases:
        found: list[str] = []
        for term in expand_query(table, case.query):
            try:
                hits = search(path, term, limit=limit)
            except DerivedStoreError:
                # A term the query language cannot parse contributes nothing.
                # It is not an error in the case, and it is not a silent pass:
                # the case still succeeds or fails on what the other terms found.
                continue
            for hit in hits:
                if hit.source_id not in found:
                    found.append(hit.source_id)
        ordered = tuple(sorted(found))
        outcome = Outcome.HIT if set(case.expect) <= set(ordered) else Outcome.MISS
        results.append(CaseResult(case.query, outcome, case.expect, ordered))
    return RunResult(RunStatus.COMPLETE, table.name, tuple(results))


@dataclass(frozen=True, slots=True)
class RescueMeasurement:
    """How many of a baseline's misses another derivation recovered.

    Both counts are carried, not just the ratio. A figure measured on a
    private corpus is a count over its denominator, and a percentage alone
    would hide the denominator that makes it meaningful.
    """

    derivation: str
    rescued: int
    baseline_misses: int
    status: RunStatus
    reason: str | None = None

    @property
    def rate(self) -> float | None:
        """The proportion, or None when there is nothing to take a proportion of."""
        if self.status is not RunStatus.COMPLETE or self.baseline_misses == 0:
            return None
        return self.rescued / self.baseline_misses

    def describe(self) -> str:
        if self.status is not RunStatus.COMPLETE:
            return f"{self.derivation}: NOT RUN ({self.reason})"
        if self.baseline_misses == 0:
            return f"{self.derivation}: nothing to rescue (baseline had no misses)"
        return (
            f"{self.derivation}: rescued {self.rescued}/{self.baseline_misses} "
            f"({self.rescued / self.baseline_misses:.1%})"
        )


def measure_rescue(baseline: RunResult, candidate: RunResult) -> RescueMeasurement:
    """How many of ``baseline``'s misses ``candidate`` turned into hits.

    A rescue is a case the baseline missed and the candidate hit. A case the
    candidate *breaks* — baseline hit, candidate missed — is not netted off
    silently; it makes the measurement refuse, because a derivation that trades
    one document for another has not rescued anything and a single number would
    conceal that.
    """
    if baseline.status is not RunStatus.COMPLETE:
        return RescueMeasurement(
            candidate.derivation, 0, 0, RunStatus.NOT_RUN,
            f"the baseline did not run: {baseline.reason}",
        )
    if candidate.status is not RunStatus.COMPLETE:
        return RescueMeasurement(
            candidate.derivation, 0, 0, RunStatus.NOT_RUN,
            f"the candidate did not run: {candidate.reason}",
        )
    by_query = {r.query: r for r in candidate.results}
    missing = [r.query for r in baseline.results if r.query not in by_query]
    if missing:
        raise MeasurementError(
            f"the two runs do not cover the same cases; {len(missing)} absent from the candidate"
        )
    baseline_misses = [r for r in baseline.results if r.outcome is Outcome.MISS]
    broke = [
        r.query
        for r in baseline.results
        if r.outcome is Outcome.HIT and by_query[r.query].outcome is Outcome.MISS
    ]
    if broke:
        return RescueMeasurement(
            candidate.derivation, 0, len(baseline_misses), RunStatus.NOT_RUN,
            f"the candidate lost {len(broke)} case(s) the baseline found; "
            "a net figure would hide that",
        )
    rescued = sum(
        1 for r in baseline_misses if by_query[r.query].outcome is Outcome.HIT
    )
    return RescueMeasurement(
        candidate.derivation, rescued, len(baseline_misses), RunStatus.COMPLETE
    )
