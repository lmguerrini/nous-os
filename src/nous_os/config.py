"""Where NousOS reads from, and how that location is decided.

The data root is **configuration**. Nothing in this module knows a path on the
machine that wrote it, and there is no default that names one. A location the
caller did not supply is not guessed: it is refused, because a system that
invents a plausible root works perfectly for its author and silently reads the
wrong thing for everyone else.

Resolution order, highest first:

1. an explicit argument, which a caller passes deliberately;
2. the ``NOUS_OS_DATA_ROOT`` environment variable;
3. nothing -- which raises, and is not an error to be smoothed over.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

ENV_VAR = "NOUS_OS_DATA_ROOT"

#: Extensions the canonical layer recognises today. Canon is files; this is the
#: set of files it is made of, and it grows with the work that can read them.
CANONICAL_SUFFIXES = (".md",)


class DataRootNotConfigured(Exception):
    """Raised when no data root was supplied by any configured source.

    Deliberately not a subclass of anything a caller is likely to catch by
    accident. Not knowing where the corpus lives is a third answer, distinct
    from "the corpus is empty".
    """


class DataRootNotADirectory(Exception):
    """Raised when the configured data root does not resolve to a directory."""


@dataclass(frozen=True)
class DataRoot:
    """A resolved corpus location.

    Frozen so that a root cannot be repointed after the code that trusted it
    has already read from it.
    """

    path: Path

    def __post_init__(self) -> None:
        if not self.path.is_dir():
            raise DataRootNotADirectory(f"not a directory: {self.path}")


def resolve_data_root(
    explicit: str | os.PathLike[str] | None = None,
    *,
    environ: dict[str, str] | None = None,
) -> DataRoot:
    """Resolve the data root, or refuse.

    ``environ`` is injectable so the resolution order is testable without
    mutating the real process environment.
    """
    env = os.environ if environ is None else environ

    candidate: str | os.PathLike[str] | None = explicit
    if candidate is None:
        from_env = env.get(ENV_VAR)
        if from_env is not None and from_env.strip():
            candidate = from_env

    if candidate is None:
        raise DataRootNotConfigured(
            "no data root was configured; pass one explicitly or set "
            f"{ENV_VAR}. NousOS does not guess a location."
        )

    return DataRoot(Path(candidate).expanduser().resolve())


def list_documents(root: DataRoot) -> tuple[str, ...]:
    """Every canonical document under ``root``, as sorted root-relative paths.

    Root-relative on purpose: the result describes the corpus, not the machine
    it happens to sit on, so the same corpus under two different roots produces
    the same answer.
    """
    found = [
        path.relative_to(root.path).as_posix()
        for path in root.path.rglob("*")
        if path.is_file() and path.suffix.lower() in CANONICAL_SUFFIXES
    ]
    return tuple(sorted(found))


def describe_corpus(root: DataRoot) -> tuple[tuple[str, str], ...]:
    """Each canonical document under ``root`` with the digest of its bytes.

    Deterministic and root-independent: the pair is a root-relative path and a
    content hash, and neither carries the location. Two identical corpora under
    different roots describe identically; two different corpora do not.
    """
    described = []
    for relative in list_documents(root):
        digest = hashlib.sha256((root.path / relative).read_bytes()).hexdigest()
        described.append((relative, digest))
    return tuple(described)
