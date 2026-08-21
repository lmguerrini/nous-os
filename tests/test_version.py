"""The package imports and reports a version."""

from __future__ import annotations

import subprocess
import sys

import nous_os


def test_package_reports_a_version() -> None:
    assert isinstance(nous_os.__version__, str)
    assert nous_os.__version__


def test_version_flag_prints_the_same_version() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "nous_os", "--version"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == nous_os.__version__
