"""Generate the CAP-15 retrieval report directly from its raw artifact."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Mapping

try:
    from benchmarks.metrics import (
        MATERIALITY_THRESHOLD_POINTS,
        STRATUM_REGRESSION_FLOOR_POINTS,
        ArmDecision,
        ExperimentMetrics,
        MetricsError,
        NotRunArmMetrics,
        NotRunDecision,
        Rate,
        RunArmMetrics,
        compute_metrics,
    )
except ModuleNotFoundError:  # Supports direct execution from benchmarks/.
    from metrics import (
        MATERIALITY_THRESHOLD_POINTS,
        STRATUM_REGRESSION_FLOOR_POINTS,
        ArmDecision,
        ExperimentMetrics,
        MetricsError,
        NotRunArmMetrics,
        NotRunDecision,
        Rate,
        RunArmMetrics,
        compute_metrics,
    )


class ReportError(Exception):
    """Raised when an artifact lacks the facts needed for a published report."""


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ReportError(f"{name} must be an object")
    return value


def _int(value: object, name: str) -> int:
    if type(value) is not int or isinstance(value, bool) or value < 0:
        raise ReportError(f"{name} must be a non-negative integer")
    return value


def _string(value: object, name: str) -> str:
    if type(value) is not str or not value.strip():
        raise ReportError(f"{name} must be a non-empty string")
    return value


def _format_rate(rate: Rate) -> str:
    """Render both measured components so a percentage cannot hide its base."""
    numerator_value = float(rate.numerator)
    numerator = str(int(numerator_value)) if numerator_value.is_integer() else f"{numerator_value:.4f}"
    return f"{numerator}/{rate.denominator} ({rate.value * 100:.1f}%)"


def _format_points(value: float) -> str:
    return f"{value:+.1f} percentage points"


def _reason_counts(artifact: Mapping[str, object]) -> Mapping[str, int]:
    raw_cells = artifact.get("cells")
    if type(raw_cells) is not list:
        raise ReportError("cells must be a list")
    counts: dict[str, int] = {}
    for index, raw_cell in enumerate(raw_cells):
        cell = _mapping(raw_cell, f"cells[{index}]")
        if cell.get("status") == "NOT_RUN":
            reason = _string(cell.get("not_run_reason"), f"cells[{index}].not_run_reason")
            counts[reason] = counts.get(reason, 0) + 1
    return {reason: counts[reason] for reason in sorted(counts)}


def _pooled_table(arm: RunArmMetrics) -> list[str]:
    rows = ["| Metric | Value |", "| --- | --- |"]
    for k in (1, 5, 10, 20):
        rows.append(f"| Recall@{k} | {_format_rate(arm.recall_at[k])} |")
    rows.extend(
        [
            f"| MRR@20 (reciprocal-rank total over ranks <= 20 / cells) | {_format_rate(arm.mrr)} |",
            f"| Unique recall@10 vs BASELINE | {_format_rate(arm.unique_recall_at[10])} |",
            f"| Lost recall@10 vs BASELINE | {_format_rate(arm.lost_recall_at[10])} |",
        ]
    )
    return rows


def _stratum_table(arm: RunArmMetrics) -> list[str]:
    rows = [
        "| Language stratum | Recall@1 | Recall@5 | Recall@10 | Recall@20 | MRR | Unique@10 | Lost@10 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for lang_pair in sorted(arm.strata):
        metrics = arm.strata[lang_pair]
        rows.append(
            "| "
            + " | ".join(
                (
                    lang_pair,
                    _format_rate(metrics.recall_at[1]),
                    _format_rate(metrics.recall_at[5]),
                    _format_rate(metrics.recall_at[10]),
                    _format_rate(metrics.recall_at[20]),
                    _format_rate(metrics.mrr),
                    _format_rate(metrics.unique_recall_at[10]),
                    _format_rate(metrics.lost_recall_at[10]),
                )
            )
            + " |"
        )
    return rows


def _not_run_tables(arm: NotRunArmMetrics, metrics: ExperimentMetrics) -> list[str]:
    rows = ["| Status | Reason |", "| --- | --- |", f"| NOT_RUN | {arm.reason} |", "", "| Language stratum | Status | Reason |", "| --- | --- | --- |"]
    rows.extend(f"| {lang_pair} | NOT_RUN | {arm.reason} |" for lang_pair in sorted(metrics.stratum_denominators))
    return rows


def _cost_table(artifact: Mapping[str, object], scored_cells: int) -> list[str]:
    """Cost, rendered from the artifact rather than transcribed beside it.

    An audit found this capability's latency and build figures living only in a
    governance document, under a heading declaring that no measured figure was
    transcribed there. They had been computed by hand from a SUPERSEDED artifact,
    so they were also stale: the multiple they quoted was self-inconsistent and
    the build seconds belonged to a different run.

    Every number here therefore comes out of the artifact, and the denominator is
    printed beside it so a reader can divide it back. Fields the instrument did not
    record -- per-query medians exist for the dense arms only -- are rendered
    NOT_RECORDED rather than derived silently from a total.
    """
    arms = _mapping(artifact.get("arms"), "arms")
    lines = [
        "",
        "## Cost",
        "",
        f"Totals are over {scored_cells} scored cells (governed plus the negative control), which is",
        "the denominator to divide by. Index build happens once per corpus; query cost is per call.",
        "",
        "| Arm | Total query seconds | Mean ms/query | Recorded median ms | Index build seconds | Vector bytes |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for name in sorted(arms):
        arm = _mapping(arms[name], f"arms.{name}")
        if arm.get("status") != "RUN":
            lines.append(f"| {name} | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |")
            continue
        seconds = arm.get("seconds")
        mean = f"{1000 * float(seconds) / scored_cells:.2f}" if isinstance(seconds, (int, float)) else "NOT_RECORDED"
        total = f"{float(seconds):.4f}" if isinstance(seconds, (int, float)) else "NOT_RECORDED"
        median = arm.get("query_ms_median")
        build = arm.get("build_seconds")
        vector_bytes = arm.get("vector_bytes")
        lines.append(
            f"| {name} | {total} | {mean} | "
            f"{median if median is not None else 'NOT_RECORDED'} | "
            f"{f'{float(build):.2f}' if isinstance(build, (int, float)) else 'NOT_RECORDED'} | "
            f"{vector_bytes if vector_bytes is not None else 'NOT_RECORDED'} |"
        )
    lines.extend((
        "",
        "The preregistered five-repetition protocol with a full range was applied to the dense arms",
        "only, so no range exists for the lexical arms and the rule forbidding a difference smaller",
        "than the larger arm's own range cannot be applied. Memory was not recorded.",
    ))
    return lines


def render_report(artifact: Mapping[str, object]) -> str:
    """Render a deterministic report whose measured values all come from ``artifact``."""
    metrics = compute_metrics(artifact)
    corpus = _mapping(artifact.get("corpus"), "corpus")
    bridges = _mapping(artifact.get("bridges"), "bridges")
    digest = _string(artifact.get("determinism_payload_digest"), "determinism_payload_digest")
    documents = _int(corpus.get("documents"), "corpus.documents")
    chunks = _int(corpus.get("chunks"), "corpus.chunks")
    max_tokens = _int(corpus.get("max_tokens"), "corpus.max_tokens")
    tier = _string(corpus.get("tier"), "corpus.tier")
    governed = _int(bridges.get("governed"), "bridges.governed")
    bridge_cells = _int(bridges.get("cells"), "bridges.cells")
    runnable = _int(bridges.get("runnable"), "bridges.runnable")
    raw_cells = artifact.get("cells")
    assert isinstance(raw_cells, list)
    reasons = _reason_counts(artifact)

    lines = [
        "# CAP-15 Retrieval Experiment",
        "",
        "## Run identity",
        "",
        f"- Determinism payload digest: `{digest}`",
        "",
        "## Corpus and population",
        "",
        f"- Corpus: {documents} documents, {chunks} chunks, max_tokens {max_tokens}, tier {tier}.",
        f"- Bridges: {governed} governed, {bridge_cells} cells, {runnable} runnable.",
        f"- Retrieval denominator: {metrics.denominator} RUN cells.",
        f"- NOT_RUN cells: {len(raw_cells) - metrics.denominator}.",
        "- Language-stratum denominators: "
        + ", ".join(f"{lang_pair} {count}" for lang_pair, count in sorted(metrics.stratum_denominators.items()))
        + ".",
        "- NOT_RUN cell reasons:",
    ]
    if reasons:
        lines.extend(f"  - {reason}: {count} cells." for reason, count in reasons.items())
    else:
        lines.append("  - None.")

    for arm_name in sorted(metrics.arms):
        arm = metrics.arms[arm_name]
        lines.extend(("", f"## Arm: {arm_name}", ""))
        if isinstance(arm, RunArmMetrics):
            lines.extend(_pooled_table(arm))
            lines.extend(("", "### By language stratum", ""))
            lines.extend(_stratum_table(arm))
        else:
            lines.extend(_not_run_tables(arm, metrics))

    # The cost table appears only when the artifact actually carries timings, and then it
    # REQUIRES the run's own scored-cell count. Falling back to the surviving RUN cells
    # would divide a total measured over the governed set PLUS the negative control by the
    # governed set alone, overstating every per-query figure. An artifact with no timings
    # has nothing to divide, so it needs no denominator and gets no table -- the demand
    # fires exactly where a wrong denominator could do damage.
    arms_raw = _mapping(artifact.get("arms"), "arms")
    has_timings = any(
        isinstance(a, Mapping) and a.get("seconds") is not None for a in arms_raw.values()
    )
    if has_timings:
        scored = artifact.get("scored_cells")
        if not isinstance(scored, int) or scored < 1:
            raise ReportError(
                "an artifact carrying timings must record scored_cells: the denominator "
                "those timings were measured over"
            )
        lines.extend(_cost_table(artifact, scored))

    lines.extend(("", "## Frozen decision rule", "", f"- Best lexical arm at recall@10: {metrics.best_lexical_arm}.", "", "| Candidate arm | Materiality gap | "
        f"Condition A (>= {MATERIALITY_THRESHOLD_POINTS:+.1f}) | Worst stratum regression | "
        f"Condition B (>= {STRATUM_REGRESSION_FLOOR_POINTS:+.1f}) |", "| --- | --- | --- | --- | --- |"))
    for arm_name in sorted(metrics.decisions):
        decision = metrics.decisions[arm_name]
        if isinstance(decision, ArmDecision):
            lines.append(
                f"| {arm_name} | {_format_points(decision.materiality_gap_percentage_points)} | "
                f"{decision.condition_a} | {_format_points(decision.worst_stratum_regression_percentage_points)} | "
                f"{decision.condition_b} |"
            )
        else:
            assert isinstance(decision, NotRunDecision)
            lines.append(f"| {arm_name} | NOT_RUN ({decision.reason}) | NOT_RUN | NOT_RUN | NOT_RUN |")
    return "\n".join(lines) + "\n"


def generate_report(artifact_path: Path, output_path: Path = Path("docs/CAP-15-RETRIEVAL.md")) -> str:
    """Load one artifact and write its generated Markdown report atomically enough for tests."""
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReportError(f"cannot read artifact {artifact_path}: {error}") from error
    report = render_report(_mapping(artifact, "artifact"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    """Generate the fixed report path from the one required artifact argument."""
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        raise ReportError("usage: python3 benchmarks/report.py ARTIFACT.json")
    generate_report(Path(arguments[0]))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MetricsError, ReportError) as error:
        raise SystemExit(str(error))
