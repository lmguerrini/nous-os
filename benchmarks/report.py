"""Generate the CAP-15 retrieval report directly from its raw artifact."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Mapping

try:
    from benchmarks.metrics import (
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
            f"| MRR (reciprocal-rank total / cells) | {_format_rate(arm.mrr)} |",
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

    lines.extend(("", "## Frozen decision rule", "", f"- Best lexical arm at recall@10: {metrics.best_lexical_arm}.", "", "| Candidate arm | Materiality gap | Condition A (>= +10.0) | Worst stratum regression | Condition B (>= -2.0) |", "| --- | --- | --- | --- | --- |"))
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
