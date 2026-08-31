"""Frozen retrieval metrics derived from one completed experiment artifact.

The calculations keep every arm on the same population of run cells. Letting a
missing rank remove a cell from one arm's denominator would make a retriever
look stronger precisely when it failed to return a target.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


BASELINE = "BASELINE"
CHUNK_BASELINE = "BASELINE-CHUNK-BM25"


class MetricsError(Exception):
    """Raised when an artifact cannot support the preregistered calculation."""


@dataclass(frozen=True, slots=True)
class Rate:
    """A measured total carried with its population, never as a bare rate."""

    numerator: float
    denominator: int

    def __post_init__(self) -> None:
        if type(self.denominator) is not int or isinstance(self.denominator, bool) or self.denominator < 1:
            raise MetricsError("a rate needs a positive integer denominator")

    @property
    def value(self) -> float:
        """The rate for arithmetic; rendering still retains both components."""
        return self.numerator / self.denominator


@dataclass(frozen=True, slots=True)
class StratumMetrics:
    """All preregistered rates for one language stratum and one completed arm."""

    lang_pair: str
    denominator: int
    recall_at: Mapping[int, Rate]
    mrr: Rate
    unique_recall_at: Mapping[int, Rate]
    lost_recall_at: Mapping[int, Rate]


@dataclass(frozen=True, slots=True)
class RunArmMetrics:
    """Metrics for an arm that ran, including a zero-result completed arm."""

    name: str
    recall_at: Mapping[int, Rate]
    mrr: Rate
    unique_recall_at: Mapping[int, Rate]
    lost_recall_at: Mapping[int, Rate]
    strata: Mapping[str, StratumMetrics]


@dataclass(frozen=True, slots=True)
class NotRunArmMetrics:
    """An arm that did not run, kept distinct from a completed zero result."""

    name: str
    reason: str


ArmMetrics = RunArmMetrics | NotRunArmMetrics


@dataclass(frozen=True, slots=True)
class ArmDecision:
    """The frozen rule's values for one completed non-lexical arm."""

    name: str
    materiality_gap_percentage_points: float
    condition_a: bool
    worst_stratum_regression_percentage_points: float
    condition_b: bool


@dataclass(frozen=True, slots=True)
class NotRunDecision:
    """A decision that cannot exist because its candidate arm did not run."""

    name: str
    reason: str


Decision = ArmDecision | NotRunDecision


@dataclass(frozen=True, slots=True)
class ExperimentMetrics:
    """The complete, reproducible measurement derived from the artifact."""

    denominator: int
    stratum_denominators: Mapping[str, int]
    arms: Mapping[str, ArmMetrics]
    best_lexical_arm: str
    decisions: Mapping[str, Decision]


def _required_mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise MetricsError(f"{name} must be an object")
    return value


def _required_string(value: object, name: str) -> str:
    if type(value) is not str or not value.strip():
        raise MetricsError(f"{name} must be a non-empty string")
    return value


def _run_cells(artifact: Mapping[str, object]) -> tuple[Mapping[str, object], ...]:
    raw_cells = artifact.get("cells")
    if type(raw_cells) is not list:
        raise MetricsError("cells must be a list")
    cells: list[Mapping[str, object]] = []
    keys: set[str] = set()
    for index, raw_cell in enumerate(raw_cells):
        cell = _required_mapping(raw_cell, f"cells[{index}]")
        bridge = _required_string(cell.get("bridge"), f"cells[{index}].bridge")
        direction = _required_string(cell.get("direction"), f"cells[{index}].direction")
        _required_string(cell.get("lang_pair"), f"cells[{index}].lang_pair")
        status = cell.get("status")
        if status not in {"RUN", "NOT_RUN"}:
            raise MetricsError(f"cells[{index}].status must be RUN or NOT_RUN")
        key = f"{bridge}|{direction}"
        if key in keys:
            raise MetricsError(f"cells contains duplicate key {key!r}")
        keys.add(key)
        if status == "RUN":
            cells.append(cell)
    if not cells:
        raise MetricsError("an experiment needs at least one RUN cell")

    # An artifact may carry more than one cell population -- a governed set and
    # a negative-control set scored by the same arms. Pooling them produces one
    # denominator over two questions, which is how a control silently changes
    # every headline figure while every individual number stays true. Refusing
    # is the only safe reading: this function computes ONE comparison, and a
    # caller with two populations must split them before asking.
    populations = {cell["set"] for cell in cells if "set" in cell}
    if len(populations) > 1:
        raise MetricsError(
            "cells carry more than one 'set' — "
            f"{sorted(populations)}. Metrics are computed over a single "
            "population; pooling a control set with the governed set would "
            "share one denominator between two different questions."
        )
    return tuple(cells)


def _cell_key(cell: Mapping[str, object]) -> str:
    return f"{cell['bridge']}|{cell['direction']}"


def _rank(arm_name: str, ranks: Mapping[str, object], cell: Mapping[str, object]) -> int | None:
    key = _cell_key(cell)
    if key not in ranks:
        raise MetricsError(f"RUN cell {key!r} is missing from arm {arm_name!r}")
    rank = ranks[key]
    if rank is None:
        return None
    if type(rank) is not int or isinstance(rank, bool) or rank < 1:
        raise MetricsError(f"rank for {key!r} in arm {arm_name!r} must be a positive integer or null")
    return rank


def _hits(arm_name: str, ranks: Mapping[str, object], cells: tuple[Mapping[str, object], ...], k: int) -> set[str]:
    return {
        _cell_key(cell)
        for cell in cells
        if (rank := _rank(arm_name, ranks, cell)) is not None and rank <= k
    }


def _rate(count: float, denominator: int) -> Rate:
    return Rate(count, denominator)


def _metrics_for_cells(
    arm_name: str,
    ranks: Mapping[str, object],
    baseline_ranks: Mapping[str, object],
    cells: tuple[Mapping[str, object], ...],
    k_values: tuple[int, ...],
) -> tuple[Mapping[int, Rate], Rate, Mapping[int, Rate], Mapping[int, Rate]]:
    denominator = len(cells)
    recall_at: dict[int, Rate] = {}
    unique_at: dict[int, Rate] = {}
    lost_at: dict[int, Rate] = {}
    for k in k_values:
        arm_hits = _hits(arm_name, ranks, cells, k)
        baseline_hits = _hits(BASELINE, baseline_ranks, cells, k)
        recall_at[k] = _rate(len(arm_hits), denominator)
        unique_at[k] = _rate(len(arm_hits - baseline_hits), denominator)
        lost_at[k] = _rate(len(baseline_hits - arm_hits), denominator)
    reciprocal_total = sum(
        1 / rank
        for cell in cells
        if (rank := _rank(arm_name, ranks, cell)) is not None and rank <= 20
    )
    return recall_at, _rate(reciprocal_total, denominator), unique_at, lost_at


def _best_lexical_arm(arms: Mapping[str, ArmMetrics]) -> str:
    baseline = arms.get(BASELINE)
    chunk = arms.get(CHUNK_BASELINE)
    if not isinstance(baseline, RunArmMetrics) or not isinstance(chunk, RunArmMetrics):
        raise MetricsError("both lexical arms must have RUN status for the decision rule")
    baseline_rate = baseline.recall_at[10].value
    chunk_rate = chunk.recall_at[10].value
    if baseline_rate == chunk_rate:
        raise MetricsError("the lexical arms tie at recall@10; the frozen rule has no higher arm")
    return BASELINE if baseline_rate > chunk_rate else CHUNK_BASELINE


def compute_metrics(artifact: Mapping[str, object]) -> ExperimentMetrics:
    """Compute the frozen metrics while excluding only cells that did not run.

    The input is validated before arithmetic. In particular, each completed arm
    must carry an explicit rank or null for every run cell, preventing a missing
    value from silently becoming either a hit or a denominator change.
    """
    artifact = _required_mapping(artifact, "artifact")
    raw_k_values = artifact.get("k_values")
    if type(raw_k_values) is not list or not raw_k_values:
        raise MetricsError("k_values must be a non-empty list")
    k_values = tuple(raw_k_values)
    if any(type(k) is not int or isinstance(k, bool) or k < 1 for k in k_values):
        raise MetricsError("k_values must contain positive integers")
    if len(set(k_values)) != len(k_values):
        raise MetricsError("k_values must not repeat a value")
    if 10 not in k_values:
        raise MetricsError("k_values must include 10 for the frozen decision rule")

    cells = _run_cells(artifact)
    denominator = len(cells)
    stratum_cells: dict[str, tuple[Mapping[str, object], ...]] = {}
    for lang_pair in sorted({cell["lang_pair"] for cell in cells}):
        stratum_cells[lang_pair] = tuple(cell for cell in cells if cell["lang_pair"] == lang_pair)

    raw_arms = _required_mapping(artifact.get("arms"), "arms")
    if BASELINE not in raw_arms or CHUNK_BASELINE not in raw_arms:
        raise MetricsError("arms must include both lexical arms")
    parsed_arms: dict[str, ArmMetrics] = {}
    raw_run_ranks: dict[str, Mapping[str, object]] = {}
    for arm_name in sorted(raw_arms):
        _required_string(arm_name, "arm name")
        raw_arm = _required_mapping(raw_arms[arm_name], f"arms[{arm_name!r}]")
        status = raw_arm.get("status")
        if status == "NOT_RUN":
            reason = _required_string(raw_arm.get("not_run_reason"), f"arms[{arm_name!r}].not_run_reason")
            parsed_arms[arm_name] = NotRunArmMetrics(arm_name, reason)
            continue
        if status != "RUN":
            raise MetricsError(f"arms[{arm_name!r}].status must be RUN or NOT_RUN")
        ranks = _required_mapping(raw_arm.get("ranks"), f"arms[{arm_name!r}].ranks")
        raw_run_ranks[arm_name] = ranks

    baseline_ranks = raw_run_ranks.get(BASELINE)
    if baseline_ranks is None:
        raise MetricsError("BASELINE must have RUN status")
    for arm_name in sorted(raw_run_ranks):
        ranks = raw_run_ranks[arm_name]
        recall_at, mrr, unique_at, lost_at = _metrics_for_cells(
            arm_name, ranks, baseline_ranks, cells, k_values
        )
        strata: dict[str, StratumMetrics] = {}
        for lang_pair, group in stratum_cells.items():
            stratum_recall, stratum_mrr, stratum_unique, stratum_lost = _metrics_for_cells(
                arm_name, ranks, baseline_ranks, group, k_values
            )
            strata[lang_pair] = StratumMetrics(
                lang_pair, len(group), stratum_recall, stratum_mrr, stratum_unique, stratum_lost
            )
        parsed_arms[arm_name] = RunArmMetrics(
            arm_name, recall_at, mrr, unique_at, lost_at, strata
        )

    best_lexical = _best_lexical_arm(parsed_arms)
    reference = parsed_arms[best_lexical]
    assert isinstance(reference, RunArmMetrics)
    decisions: dict[str, Decision] = {}
    for arm_name, arm in parsed_arms.items():
        if arm_name in {BASELINE, CHUNK_BASELINE}:
            continue
        if isinstance(arm, NotRunArmMetrics):
            decisions[arm_name] = NotRunDecision(arm_name, arm.reason)
            continue
        materiality = (arm.recall_at[10].value - reference.recall_at[10].value) * 100
        stratum_deltas = tuple(
            (arm.strata[lang_pair].recall_at[10].value - reference.strata[lang_pair].recall_at[10].value)
            * 100
            for lang_pair in sorted(reference.strata)
        )
        worst = min(stratum_deltas)
        decisions[arm_name] = ArmDecision(
            arm_name,
            materiality,
            materiality >= 10.0,
            worst,
            worst >= -2.0,
        )

    return ExperimentMetrics(
        denominator,
        {lang_pair: len(group) for lang_pair, group in stratum_cells.items()},
        parsed_arms,
        best_lexical,
        decisions,
    )
