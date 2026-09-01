"""The package imports and reports a version.

The subprocess test deliberately does not assume the package was installed.
A suite that only passes after an editable install is a suite that fails on a
fresh clone for the first person who runs it before reading the README.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

import nous_os

REPO_ROOT = Path(__file__).resolve().parent.parent

#: The directory the package was imported from, so the child process finds the
#: same code this process is testing -- installed or not, and without naming a
#: location on any particular machine.
_IMPORT_ROOT = str(Path(nous_os.__file__).resolve().parent.parent)


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = (
        _IMPORT_ROOT if not existing else os.pathsep.join([_IMPORT_ROOT, existing])
    )
    return env


def test_package_reports_a_version() -> None:
    assert isinstance(nous_os.__version__, str)
    assert nous_os.__version__


def test_package_version_matches_pyproject() -> None:
    """Two sources of truth, one of which is unchecked, drift silently.

    ``__init__.__version__`` and ``pyproject.toml``'s ``project.version`` are
    both hand-written today; nothing before this test noticed if they
    disagreed.
    """
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert nous_os.__version__ == pyproject["project"]["version"]


def test_version_flag_prints_the_same_version() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "nous_os", "--version"],
        capture_output=True,
        text=True,
        check=True,
        env=_child_env(),
    )
    assert result.stdout.strip() == nous_os.__version__


def test_the_command_surface_is_generated_from_the_published_catalogue() -> None:
    """Scope guard, updated deliberately: the command surface now exists.

    The earlier version of this test asserted the surface was still only
    ``--version``, on the premise that adding an operation would arrive with
    the work that tests it. That work has now arrived: ``nous_os.cli`` builds
    one subcommand per entry in ``nous_os.core.CATALOGUE``, generated rather
    than hand-written. This test reads the catalogue itself, rather than
    retyping a list of names that could drift from it, and checks that every
    published name actually reaches the real ``--help`` output.
    """
    result = subprocess.run(
        [sys.executable, "-m", "nous_os", "--help"],
        capture_output=True,
        text=True,
        check=True,
        env=_child_env(),
    )
    assert "--version" in result.stdout

    import nous_os.core as core

    for descriptor in core.CATALOGUE:
        assert descriptor.external_name in result.stdout
