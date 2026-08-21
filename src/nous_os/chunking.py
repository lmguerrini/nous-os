"""Splitting a document into pieces that remember where they came from.

A chunk that has been stripped of its heading, its neighbours and its frame is
a sentence with no referent, and a pack full of them can contain every document
that matters while containing none of the meaning. That is the defect this
project's context work exists to settle: document-level inclusion was nearly
complete while anchor-level inclusion was thin, and the two were read as one
number.

So a chunk here carries its structure with it: the heading path above it, its
position in document order, and the references it makes to elsewhere in the
corpus. **Nothing in this module knows what a chunk is *for*.** Selection
strategies use this structure; the structure does not anticipate them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

from nous_os.identity import SOURCE_PREFIX, require_id

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
_WORD = re.compile(r"\S+")


class ChunkingError(Exception):
    """Raised when a document cannot be split as specified."""


@dataclass(frozen=True, slots=True)
class Chunk:
    """One piece of a document, and the structure it sits in."""

    id: str
    source_id: str
    ordinal: int
    heading_path: tuple[str, ...]
    text: str
    tokens: int
    references: tuple[str, ...] = field(default=())

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        if type(self.ordinal) is not int or self.ordinal < 0:
            raise ChunkingError("a chunk's position must be a non-negative integer")
        if not self.text.strip():
            raise ChunkingError("a chunk must carry text")

    @property
    def section(self) -> tuple[str, ...]:
        """The lowest heading this chunk sits under, as a full path.

        Two chunks are siblings when their sections are equal — which is a
        different question from sharing a top-level heading, and the reason the
        whole path is carried rather than just the last element.
        """
        return self.heading_path


def estimate_tokens(text: str) -> int:
    """A deterministic size estimate, in whitespace-separated words.

    Deliberately not a real tokeniser. A budget comparison between arms needs a
    measure that is identical on every machine and in every process; a
    model-specific tokeniser would make the ablation's budgets depend on which
    library version happened to be installed. It is an **estimate**, it is
    named one, and every arm is measured with the same one.
    """
    return len(_WORD.findall(text))


def chunk_document(source_id: str, text: str, *, max_tokens: int = 120) -> tuple[Chunk, ...]:
    """Split ``text`` into structured chunks, deterministically.

    Splits on blank lines, then packs consecutive blocks up to ``max_tokens``
    while they share a heading path — a chunk never spans a heading boundary,
    because a chunk that does cannot say which section it belongs to.
    """
    require_id(source_id, SOURCE_PREFIX)
    if type(text) is not str:
        raise ChunkingError("a document is text")

    path: list[str] = []
    blocks: list[tuple[tuple[str, ...], str]] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            body = "\n".join(current).strip()
            if body:
                blocks.append((tuple(path), body))
            current.clear()

    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading:
            flush()
            depth = len(heading.group(1))
            del path[depth - 1 :]
            path.append(heading.group(2))
            continue
        if not line.strip():
            flush()
            continue
        current.append(line)
    flush()

    chunks: list[Chunk] = []
    pending: list[str] = []
    pending_path: tuple[str, ...] | None = None

    def emit() -> None:
        nonlocal pending, pending_path
        if not pending or pending_path is None:
            return
        body = "\n\n".join(pending)
        ordinal = len(chunks)
        chunks.append(
            Chunk(
                id=f"{source_id}#{ordinal:04d}",
                source_id=source_id,
                ordinal=ordinal,
                heading_path=pending_path,
                text=body,
                tokens=estimate_tokens(body),
                references=tuple(sorted(set(_LINK.findall(body)))),
            )
        )
        pending = []
        pending_path = None

    for block_path, body in blocks:
        if pending_path is not None and (
            block_path != pending_path
            or estimate_tokens("\n\n".join(pending + [body])) > max_tokens
        ):
            emit()
        if pending_path is None:
            pending_path = block_path
        pending.append(body)
    emit()
    return tuple(chunks)


def by_id(chunks: Iterable[Chunk]) -> dict[str, Chunk]:
    """Index chunks by identifier, refusing a duplicate."""
    index: dict[str, Chunk] = {}
    for chunk in chunks:
        if chunk.id in index:
            raise ChunkingError(f"two chunks share the identifier {chunk.id}")
        index[chunk.id] = chunk
    return index
