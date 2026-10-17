"""Regression checks for generated CAP-15 Markdown."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from benchmarks.report import generate_report, render_report
from tests.test_metrics import _artifact


def test_report_is_a_fixed_point(tmp_path: Path) -> None:
    artifact_path = tmp_path / "artifact.json"
    output_path = tmp_path / "CAP-15-RETRIEVAL.md"
    artifact_path.write_text(json.dumps(_artifact()), encoding="utf-8")
    first = generate_report(artifact_path, output_path)
    second = generate_report(artifact_path, output_path)
    assert first == second == output_path.read_text(encoding="utf-8")


def test_no_retrieval_artifact_or_generated_report_is_tracked() -> None:
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], check=True, capture_output=True
    ).stdout.decode("utf-8").split("\0")
    required = {
        "corpus",
        "bridges",
        "k_values",
        "k_max",
        "determinism_payload_digest",
        "cells",
        "arms",
    }
    matches = []
    for relative in tracked:
        if not relative.endswith(".json"):
            continue
        candidate = Path(relative)
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and required <= payload.keys():
            matches.append(candidate)
    assert not matches, f"retrieval artifacts must not be tracked: {matches}"
    assert "docs/CAP-15-RETRIEVAL.md" not in tracked


def test_report_comparison_detects_a_changed_measured_number() -> None:
    generated = render_report(_artifact())
    mutated = generated.replace("3/5 (60.0%)", "4/5 (80.0%)", 1)
    assert mutated != generated


def test_report_keeps_a_not_run_arm_distinct_from_zero() -> None:
    generated = render_report(_artifact())
    unavailable = generated.split("## Arm: UNAVAILABLE", 1)[1].split("## Frozen decision rule", 1)[0]
    assert "| NOT_RUN | model unavailable |" in unavailable
    assert "0.0" not in unavailable


def test_report_changes_when_the_artifact_changes() -> None:
    artifact = _artifact()
    original = render_report(artifact)
    artifact["arms"]["DENSE"]["ranks"]["b3|A->B"] = 1
    changed = render_report(artifact)
    assert changed != original
