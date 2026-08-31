"""NousOS operates with nothing outside this repository present.

The obligation this suite discharges is stated as independence from one
particular external tree. It is tested as independence from **every** external
tree, for two reasons. The weaker one is that the general property implies the
specific one. The stronger one is that naming a private tree in a public test
would publish the very thing the independence rule exists to keep out, so the
specific form of this test cannot be written here without breaking a different
rule.

What is proved: the package imports nothing outside the standard library and
itself, and it performs its work in a process that can see a copy of the
package and nothing else.
"""

from __future__ import annotations

import ast
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = REPO_ROOT / "src" / "nous_os"

#: Third-party runtime dependencies this project has deliberately taken. A
#: change to this set is a change to what a clean clone must install, and each
#: name here has to earn that: `nous_os.semantic` is a fully offline, in-process
#: dense index with no substitute in the standard library -- `onnxruntime` runs
#: the checkpoint, `tokenizers` and `huggingface_hub` load it and its vocabulary
#: from the local cache, and `numpy` is the array type all three speak. Nothing
#: else in the package reaches outside the standard library.
ALLOWED_THIRD_PARTY: frozenset[str] = frozenset(
    {"numpy", "onnxruntime", "tokenizers", "huggingface_hub"}
)


def _top_level_imports(source: Path) -> set[str]:
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # a relative import stays inside the package
                continue
            if node.module:
                names.add(node.module.split(".")[0])
    return names


def test_the_package_has_modules_to_check() -> None:
    """Guard the guard."""
    assert list(PACKAGE_ROOT.rglob("*.py")), "no package modules found"


def test_every_import_is_standard_library_or_this_package() -> None:
    stdlib = set(sys.stdlib_module_names)
    offences = []
    for module in sorted(PACKAGE_ROOT.rglob("*.py")):
        for name in sorted(_top_level_imports(module)):
            if name in stdlib or name == "nous_os" or name in ALLOWED_THIRD_PARTY:
                continue
            offences.append(f"{module.relative_to(REPO_ROOT)} imports {name!r}")
    assert not offences, "imports outside the standard library:\n" + "\n".join(offences)


def test_the_package_works_with_only_a_copy_of_itself_on_the_path(tmp_path: Path) -> None:
    """The literal test: run the work where nothing else is reachable.

    The package is copied to an isolated directory and the interpreter is
    started from an unrelated working directory with ``-P`` (do not prepend
    the working directory) and ``-S`` (do not import ``site`` at all), so the
    only importable location besides the standard library is that copy. Any
    reliance on a tree outside the package fails here.

    ``-s`` (ignore only the *user* site directory) is deliberately not used in
    its place: global site-packages stay on ``sys.path`` under ``-s``, so a
    package that quietly depended on something installed system-wide would
    still import and this check would pass regardless. Verified: with ``-s``
    alone, ``import pytest`` still succeeds even with ``PYTHONPATH`` pointed
    at a directory that does not exist; with ``-S``, the same import raises
    ``ModuleNotFoundError`` and the standard library still works. Do not
    "simplify" this back to ``-s`` -- it silently reopens the hole.

    ``-I`` is deliberately not used either: isolated mode also implies ``-E``,
    which discards ``PYTHONPATH`` and would leave the package unreachable,
    turning a real check into one that cannot run.
    """
    island = tmp_path / "island"
    island.mkdir()
    shutil.copytree(PACKAGE_ROOT, island / "nous_os")

    corpus = tmp_path / "elsewhere" / "corpus"
    (corpus / "sub").mkdir(parents=True)
    (corpus / "sub" / "one.md").write_text("# One\n\nbody\n", encoding="utf-8")
    (corpus / "two.md").write_text("# Two\n\nbody\n", encoding="utf-8")

    cwd = tmp_path / "unrelated"
    cwd.mkdir()

    program = textwrap.dedent(
        """
        import sys

        import nous_os
        from nous_os.config import describe_corpus, resolve_data_root

        # An editable install leaves a path hook in the site directory that
        # would put the repository's own copy back on the path, and the check
        # below would then pass by importing the very tree it is meant to do
        # without. Prove which copy was loaded before trusting the result.
        loaded_from = sys.argv[2]
        assert nous_os.__file__.startswith(loaded_from), (
            f"imported {nous_os.__file__} rather than the isolated copy "
            f"under {loaded_from}"
        )

        root = resolve_data_root(sys.argv[1])
        for relative, digest in describe_corpus(root):
            print(relative, digest[:12])
        """
    )

    result = subprocess.run(
        [sys.executable, "-P", "-S", "-c", program, str(corpus), str(island)],
        cwd=cwd,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(island), "PATH": os.defpath},
    )

    assert result.returncode == 0, result.stderr
    lines = [line.split()[0] for line in result.stdout.strip().splitlines()]
    assert lines == ["sub/one.md", "two.md"]


def test_no_tracked_file_reaches_outside_the_repository() -> None:
    """No tracked path escapes the repository, by symlink or by parent traversal."""
    if not (REPO_ROOT / ".git").exists():
        pytest.skip("requires a git checkout: .git is not present")
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    offences = []
    for name in (n for n in listed.split("\0") if n):
        path = REPO_ROOT / name
        if path.is_symlink():
            offences.append(f"{name} is a symlink")
            continue
        try:
            path.resolve().relative_to(REPO_ROOT)
        except ValueError:
            offences.append(f"{name} resolves outside the repository")
    assert not offences, "\n".join(offences)
