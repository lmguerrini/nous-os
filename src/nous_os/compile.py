"""The context compiler: turning a ranking into a pack, and saying what it saw.

**Three stages, kept separate.** Retrieval decides what is *relevant*.
Compilation decides what actually *goes in the pack*. Reasoning does something
with the result. This module is the middle one, and it never performs the first:
it is handed a ranking and does not care where the ranking came from. That is
testable, and it is tested with a ranking no retriever produced.

**Every pack emits an inclusion manifest.** What was seen must be recoverable
afterwards, and the manifest must be identical when the same pack is compiled
again. A non-deterministic manifest is a defect and not a score — it disqualifies
a strategy regardless of how well that strategy performs.

**A strategy may not consult what it is looking for.** No arm here is permitted
to know which chunks are the answer. A rule of the form "retain the load-bearing
chunks of an undiscovered bridge" is circular — before discovery, nothing knows
which chunks are load-bearing — and is refused at proposal rather than
implemented and measured. The strategies below see structure and nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from nous_os.chunking import Chunk
from nous_os.identity import canonical_bytes, digest_payload


class CompileError(Exception):
    """Raised when a pack cannot be compiled as specified."""


@runtime_checkable
class CohesionStrategy(Protocol):
    """A way of deciding what else belongs once a chunk has been chosen."""

    @property
    def name(self) -> str:
        """A stable label, so a result can say which arm produced it."""

    def companions(
        self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]
    ) -> tuple[str, ...]:
        """Chunk ids that ``chunk`` brings with it, in a fixed order.

        ``selected`` is what has been taken so far. An arm whose condition is a
        property of the selection rather than of one chunk needs it **during**
        the walk: deciding afterwards means deciding once the budget is already
        spent, which is indistinguishable from never deciding at all.
        """

    def finalise(
        self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]
    ) -> tuple[str, ...]:
        """Further ids to consider once the ranked walk is done."""


def _same_source(chunks: tuple[Chunk, ...], source_id: str) -> tuple[Chunk, ...]:
    return tuple(c for c in chunks if c.source_id == source_id)


@dataclass(frozen=True, slots=True)
class FlatTopK:
    """**S0 — the baseline.** Rank order, nothing structural.

    The strategy the earlier experiment actually ran, kept as the baseline so
    every other arm is measured against what happened rather than against an
    idealisation of it.
    """

    @property
    def name(self) -> str:
        return "S0-flat"

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        return ()

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class HeadingAware:
    """**S1** — siblings under the same lowest heading become eligible."""

    @property
    def name(self) -> str:
        return "S1-heading"

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(
            c.id
            for c in _same_source(chunks, chunk.source_id)
            if c.id != chunk.id and c.heading_path == chunk.heading_path
        )

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class ParentEnvelope:
    """**S2** — pull in the parent section, up to a size cap.

    So that a chunk is never delivered stripped of the frame that gives it its
    referent. The cap is a swept parameter and part of the arm's label.
    """

    cap_tokens: int

    @property
    def name(self) -> str:
        return f"S2-parent-{self.cap_tokens}"

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        if not chunk.heading_path:
            return ()
        parent = chunk.heading_path[:-1]
        taken: list[str] = []
        spent = 0
        for c in _same_source(chunks, chunk.source_id):
            if c.id == chunk.id or c.heading_path[: len(parent)] != parent:
                continue
            if spent + c.tokens > self.cap_tokens:
                break
            taken.append(c.id)
            spent += c.tokens
        return tuple(taken)

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class AdjacentContext:
    """**S3** — the chunk before and the chunk after, in document order.

    The cheapest possible structural repair, and included precisely because it
    is cheap: it is the control that says whether anything more elaborate is
    earning its complexity. Its radius is fixed at one deliberately — sweeping
    it would turn the cheap control into a tuned arm.
    """

    @property
    def name(self) -> str:
        return "S3-adjacent"

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        siblings = _same_source(chunks, chunk.source_id)
        return tuple(
            c.id for c in siblings if abs(c.ordinal - chunk.ordinal) == 1
        )

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True)
class CrossReference:
    """**S4** — chunks a selected chunk points at become eligible. One hop.

    A reference in a document names another **document**, by whatever convention
    that corpus uses; a chunk carries a derived **identifier**. The mapping
    between the two is a property of the corpus, so the caller supplies it.

    An empty mapping means this arm resolves nothing and therefore never fires —
    which is a fact about the corpus, not a result about cross-reference
    completion, and ``resolves_nothing`` exists so a report can say which.
    """

    targets_to_sources: dict[str, str]

    @property
    def name(self) -> str:
        return "S4-xref"

    @property
    def resolves_nothing(self) -> bool:
        return not self.targets_to_sources

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        wanted = {
            self.targets_to_sources[t] for t in chunk.references if t in self.targets_to_sources
        }
        if not wanted:
            return ()
        return tuple(c.id for c in chunks if c.source_id in wanted and c.id != chunk.id)

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class WholeDocumentEscalation:
    """**S5** — a document contributing enough becomes a whole document.

    Applied after the ranked walk rather than per chunk, because the condition
    is a property of the selection as a whole. Both thresholds are swept and
    both appear in the arm's label.
    """

    min_chunks: int
    min_fraction: float

    @property
    def name(self) -> str:
        return f"S5-wholedoc-{self.min_chunks}-{self.min_fraction:g}"

    def companions(self, chunk: Chunk, chunks: tuple[Chunk, ...], selected: tuple[str, ...]) -> tuple[str, ...]:
        """Escalate **during** the walk, while there is still budget to do it in.

        An earlier version escalated afterwards. The threshold was met in the
        evaluation and not one escalation fitted, because the ranked walk had
        already spent the budget to the last token — so the arm reported a
        result while never having fired. Reporting that as a tie would have
        been a statement about cross-document escalation that no measurement
        supported.
        """
        chosen = set(selected) | {chunk.id}
        in_source = _same_source(chunks, chunk.source_id)
        picked = sum(1 for c in in_source if c.id in chosen)
        fraction = picked / len(in_source) if in_source else 0.0
        if picked >= self.min_chunks or fraction >= self.min_fraction:
            return tuple(c.id for c in in_source if c.id not in chosen)
        return ()

    def finalise(self, selected: tuple[str, ...], chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class InclusionManifest:
    """What a compiled pack saw, recorded so it can be recovered afterwards."""

    strategy: str
    budget_tokens: int
    chunk_ids: tuple[str, ...]
    rank_selected: tuple[str, ...]
    structural: tuple[str, ...]
    source_ids: tuple[str, ...]
    tokens_used: int

    def as_payload(self) -> dict[str, object]:
        return {
            "strategy": self.strategy,
            "budget_tokens": self.budget_tokens,
            "chunk_ids": list(self.chunk_ids),
            "rank_selected": list(self.rank_selected),
            "structural": list(self.structural),
            "source_ids": list(self.source_ids),
            "tokens_used": self.tokens_used,
        }

    @property
    def digest(self) -> str:
        return digest_payload(self.as_payload())

    def to_bytes(self) -> bytes:
        return canonical_bytes(self.as_payload())


@dataclass(frozen=True, slots=True)
class Pack:
    """A compiled pack and the manifest that says what went into it."""

    chunks: tuple[Chunk, ...]
    manifest: InclusionManifest


def compile_pack(
    chunks: tuple[Chunk, ...],
    ranking: tuple[str, ...],
    strategy: CohesionStrategy,
    budget_tokens: int,
) -> Pack:
    """Fill a budget from ``ranking``, letting ``strategy`` add structure.

    ``ranking`` is supplied. This function performs no retrieval and has no
    opinion about how the order was arrived at — which is what makes the two
    stages separately testable.
    """
    if type(budget_tokens) is not int or budget_tokens < 1:
        raise CompileError("a budget must be a positive number of tokens")
    if not isinstance(strategy, CohesionStrategy):
        raise CompileError("compilation needs a cohesion strategy")
    index = {c.id: c for c in chunks}
    if len(index) != len(chunks):
        raise CompileError("two chunks share an identifier")
    unknown = [cid for cid in ranking if cid not in index]
    if unknown:
        raise CompileError(f"the ranking names {len(unknown)} chunk(s) that were not supplied")

    chosen: list[str] = []
    rank_selected: list[str] = []
    structural: list[str] = []
    spent = 0

    def take(cid: str, structural_addition: bool) -> bool:
        nonlocal spent
        if cid in chosen:
            return False
        cost = index[cid].tokens
        if spent + cost > budget_tokens:
            return False
        chosen.append(cid)
        (structural if structural_addition else rank_selected).append(cid)
        spent += cost
        return True

    for cid in ranking:
        if not take(cid, False):
            continue
        for companion in strategy.companions(index[cid], chunks, tuple(chosen)):
            take(companion, True)

    for addition in strategy.finalise(tuple(chosen), chunks):
        take(addition, True)

    manifest = InclusionManifest(
        strategy=strategy.name,
        budget_tokens=budget_tokens,
        chunk_ids=tuple(chosen),
        rank_selected=tuple(rank_selected),
        structural=tuple(structural),
        source_ids=tuple(sorted({index[cid].source_id for cid in chosen})),
        tokens_used=spent,
    )
    return Pack(tuple(index[cid] for cid in chosen), manifest)


#: The six preregistered arms, with the pre-declared parameter grid expanded
#: into labelled sub-arms. Declared here as data so that the set of arms cannot
#: drift from the frozen document without the difference being visible.
PREREGISTERED_ARMS: tuple[CohesionStrategy, ...] = (
    FlatTopK(),
    HeadingAware(),
    ParentEnvelope(256),
    ParentEnvelope(512),
    ParentEnvelope(1024),
    AdjacentContext(),
    CrossReference({}),
    WholeDocumentEscalation(2, 0.25),
    WholeDocumentEscalation(2, 0.50),
    WholeDocumentEscalation(3, 0.25),
    WholeDocumentEscalation(3, 0.50),
    WholeDocumentEscalation(5, 0.25),
    WholeDocumentEscalation(5, 0.50),
)
