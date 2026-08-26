"""Emit the built-in pytest JUnit result with an identity the browser can verify."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
from collections.abc import Callable
from pathlib import Path

import pytest


_COMMIT_SHA = re.compile(r"[0-9a-f]{40,64}", re.IGNORECASE)
_RESULT_FILE = Path("ui") / "dist" / "evidence" / "pytest-results.xml"
_PARTIAL_RESULTS_DIRECTORY = Path("ui") / "dist" / "evidence" / "pytest-results"
_CANONICAL_ARGUMENTS = ("tests/", "-q")


def pytest_configure(config: pytest.Config) -> None:
    """Route only the exact full selection to the canonical JUnit result."""
    arguments = _invocation_arguments(config)
    artifact_path = _result_path(arguments)
    result_file = config.rootpath / artifact_path
    result_file.parent.mkdir(parents=True, exist_ok=True)
    config.option.xmlpath = str(artifact_path)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Record every collected node id and do not infer a selection from a result count."""
    config._d45r2_selected_node_ids = tuple(sorted(item.nodeid for item in items))  # type: ignore[attr-defined]


@pytest.fixture(scope="session", autouse=True)
def _record_evidence_identity(
    pytestconfig: pytest.Config,
    record_testsuite_property: Callable[[str, object], None],
) -> None:
    """Record this invocation's identity and do not infer a passing result."""
    arguments = _invocation_arguments(pytestconfig)
    selected = getattr(pytestconfig, "_d45r2_selected_node_ids", ())
    record_testsuite_property("command", _actual_command(arguments))
    record_testsuite_property("selection", json.dumps(arguments, separators=(",", ":")))
    record_testsuite_property("selectedNodeIds", json.dumps(selected, separators=(",", ":")))
    record_testsuite_property("artifactKind", "canonical-full-suite" if _is_canonical(arguments) else "partial-selection")
    record_testsuite_property("commitSha", _current_commit_sha(pytestconfig.rootpath))


def _invocation_arguments(config: pytest.Config) -> tuple[str, ...]:
    """Read pytest's received arguments and do not substitute a presumed full selection."""
    return tuple(str(argument) for argument in config.invocation_params.args)


def _actual_command(arguments: tuple[str, ...]) -> str:
    """Render the received selection and do not claim an unselected full suite."""
    return shlex.join(("python3", "-m", "pytest", *arguments))


def _is_canonical(arguments: tuple[str, ...]) -> bool:
    """Recognise only the declared full invocation and do not accept a subset or extra filter."""
    return arguments == _CANONICAL_ARGUMENTS


def _result_path(arguments: tuple[str, ...]) -> Path:
    """Give every partial selection a distinct result name and do not share the canonical file."""
    if _is_canonical(arguments):
        return _RESULT_FILE
    selection_digest = hashlib.sha256("\0".join(arguments).encode("utf-8")).hexdigest()
    return _PARTIAL_RESULTS_DIRECTORY / f"pytest-results-{selection_digest}.xml"


def _current_commit_sha(root: Path) -> str:
    """Read the checked-out commit without executing Git and do not guess when unavailable."""
    git_directory = root / ".git"
    try:
        head = (git_directory / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return "unavailable"
    if not head.startswith("ref: "):
        return head if _COMMIT_SHA.fullmatch(head) else "unavailable"
    reference = head.removeprefix("ref: ")
    try:
        sha = (git_directory / reference).read_text(encoding="utf-8").strip()
    except OSError:
        try:
            lines = (git_directory / "packed-refs").read_text(encoding="utf-8").splitlines()
        except OSError:
            return "unavailable"
        matches = [line.split(" ", 1)[0] for line in sorted(lines) if line.endswith(f" {reference}")]
        sha = matches[0] if len(matches) == 1 else ""
    return sha if _COMMIT_SHA.fullmatch(sha) else "unavailable"
