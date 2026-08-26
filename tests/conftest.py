"""Emit the built-in pytest JUnit result with an identity the browser can verify."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest


_COMMIT_SHA = re.compile(r"[0-9a-f]{40,64}", re.IGNORECASE)
_RESULT_FILE = Path("ui") / "dist" / "evidence" / "pytest-results.xml"


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest's built-in JUnit reporter and do not require caller flags."""
    if config.option.xmlpath is None:
        result_file = config.rootpath / _RESULT_FILE
        result_file.parent.mkdir(parents=True, exist_ok=True)
        config.option.xmlpath = str(result_file)


@pytest.fixture(scope="session", autouse=True)
def _record_evidence_identity(
    pytestconfig: pytest.Config,
    record_testsuite_property: Callable[[str, object], None],
) -> None:
    """Record this suite's command and tree identity and do not infer a passing result."""
    record_testsuite_property("command", "python3 -m pytest tests/ -q")
    record_testsuite_property("commitSha", _current_commit_sha(pytestconfig.rootpath))


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
