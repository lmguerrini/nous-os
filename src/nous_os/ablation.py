"""Measuring what a context strategy actually delivers.

**Two numbers, never one.** Document-level inclusion and anchor-chunk-level
inclusion are reported separately in every output of this module, and nothing
here emits a combined "inclusion rate". That rule is the whole reason this
module exists: a previous analysis found document-level inclusion nearly
complete and read it as evidence that context selection was not the problem,
while chunk-level inclusion was thin. Both numbers were true. Combining them
would have hidden the one that mattered, and a single rate is exactly the shape
that invites it.

**Partial is its own answer.** A bridge with exactly one of its two anchors
present is neither a success nor a failure, and is counted in its own column so
that it cannot quietly become either.

**Language is a dimension, not a covariate.** Every count is additionally broken
out by language pair, because a strategy that wins only on same-language bridges
has not won — it has found an alias problem, which belongs to a different gate.

**The ranking is held fixed across arms.** The independent variable is the
cohesion strategy and nothing else; if each arm ranked differently, a difference
in outcome would not be attributable to cohesion at all.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Iterable

from nous_os.chunking import Chunk
from nous_os.compile import CohesionStrategy, compile_pack


class AblationError(Exception):
    """Raised when a measurement cannot be carried out as specified."""


@dataclass(frozen=True, slots=True)
class Bridge:
    """Two endpoints that a strategy must deliver together to be useful."""

    id: str
    lang_pair: str
    a_doc: str
    a_anchor: str
    b_doc: str
    b_anchor: str

    def __post_init__(self) -> None:
        for field_name in ("id", "lang_pair", "a_doc", "a_anchor", "b_doc", "b_anchor"):
            value = getattr(self, field_name)
            if type(value) is not str or not value.strip():
                raise AblationError(f"a bridge needs a {field_name}")


@dataclass(frozen=True, slots=True)
class BridgeOutcome:
    """What one arm delivered for one bridge. Three separate facts."""

    bridge_id: str
    lang_pair: str
    #: Both endpoint documents present in the pack.
    doc_inclusion: bool
    #: **Both** grounding-anchor chunks present. The metric the defect turns on.
    anchor_both: bool
    #: Exactly one anchor chunk present. Neither success nor failure.
    anchor_one: bool

    def __post_init__(self) -> None:
        if self.anchor_both and self.anchor_one:
            raise AblationError("a bridge cannot have both anchors and exactly one")


@dataclass(frozen=True, slots=True)
class ArmResult:
    """Everything one arm did at one budget. No field combines the two metrics."""

    arm: str
    budget_tokens: int
    outcomes: tuple[BridgeOutcome, ...]
    manifest_determinism: bool
    tokens_used: int
    chunks_delivered: int
    structural_additions: int
    docs_touched: int
    compile_latency_ms: float

    @property
    def doc_inclusion_count(self) -> int:
        return sum(1 for o in self.outcomes if o.doc_inclusion)

    @property
    def anchor_both_count(self) -> int:
        return sum(1 for o in self.outcomes if o.anchor_both)

    @property
    def anchor_one_count(self) -> int:
        return sum(1 for o in self.outcomes if o.anchor_one)

    @property
    def budget_fraction(self) -> float:
        return self.tokens_used / self.budget_tokens if self.budget_tokens else 0.0

    def by_lang_pair(self) -> dict[str, dict[str, int]]:
        """Every count again, per language pair. Still never combined."""
        strata: dict[str, dict[str, int]] = {}
        for outcome in self.outcomes:
            row = strata.setdefault(
                outcome.lang_pair,
                {"bridges": 0, "doc_inclusion": 0, "anchor_both": 0, "anchor_one": 0},
            )
            row["bridges"] += 1
            row["doc_inclusion"] += int(outcome.doc_inclusion)
            row["anchor_both"] += int(outcome.anchor_both)
            row["anchor_one"] += int(outcome.anchor_one)
        return {key: strata[key] for key in sorted(strata)}


def resolve_anchor(chunks: tuple[Chunk, ...], doc: str, anchor: str) -> str | None:
    """The chunk in ``doc`` containing ``anchor``, or None if there is none.

    None is a real answer: an anchor whose text is not in the corpus cannot be
    delivered by any strategy, and counting that as a strategy's failure would
    charge every arm for a property of the evidence.
    """
    needle = " ".join(anchor.split()).casefold()
    if not needle:
        return None
    for chunk in chunks:
        if chunk.source_id != doc:
            continue
        if needle in " ".join(chunk.text.split()).casefold():
            return chunk.id
    return None


def run_arm(
    chunks: tuple[Chunk, ...],
    ranking: tuple[str, ...],
    strategy: CohesionStrategy,
    budget_tokens: int,
    bridges: Iterable[Bridge],
) -> ArmResult:
    """Compile one pack and measure what it delivered, bridge by bridge."""
    started = time.perf_counter()
    pack = compile_pack(chunks, ranking, strategy, budget_tokens)
    latency_ms = (time.perf_counter() - started) * 1000.0

    # Recompiled once more, from unchanged inputs. A manifest that differs is a
    # defect and disqualifies the arm regardless of its other numbers.
    again = compile_pack(chunks, ranking, strategy, budget_tokens)
    deterministic = pack.manifest.digest == again.manifest.digest

    present_chunks = set(pack.manifest.chunk_ids)
    present_docs = set(pack.manifest.source_ids)

    outcomes = []
    for bridge in bridges:
        a_chunk = resolve_anchor(chunks, bridge.a_doc, bridge.a_anchor)
        b_chunk = resolve_anchor(chunks, bridge.b_doc, bridge.b_anchor)
        anchors_present = sum(
            1 for cid in (a_chunk, b_chunk) if cid is not None and cid in present_chunks
        )
        outcomes.append(
            BridgeOutcome(
                bridge_id=bridge.id,
                lang_pair=bridge.lang_pair,
                doc_inclusion=bridge.a_doc in present_docs and bridge.b_doc in present_docs,
                anchor_both=anchors_present == 2,
                anchor_one=anchors_present == 1,
            )
        )

    return ArmResult(
        arm=strategy.name,
        budget_tokens=budget_tokens,
        outcomes=tuple(outcomes),
        manifest_determinism=deterministic,
        tokens_used=pack.manifest.tokens_used,
        chunks_delivered=len(pack.manifest.chunk_ids),
        structural_additions=len(pack.manifest.structural),
        docs_touched=len(pack.manifest.source_ids),
        compile_latency_ms=latency_ms,
    )


@dataclass(frozen=True, slots=True)
class Verdict:
    """Whether an arm beat the baseline, and why or why not."""

    arm: str
    wins: bool
    reasons: tuple[str, ...]
    structural_additions: int
    tokens_used: int


def judge(baseline: ArmResult, candidate: ArmResult) -> Verdict:
    """Apply the preregistered rule. Executable, so it cannot be argued after.

    An arm wins when its both-anchor count is higher, its document count is not
    lower, it regresses no language stratum, and its manifest is deterministic.
    Every clause is checked and every failure is named.
    """
    if baseline.budget_tokens != candidate.budget_tokens:
        raise AblationError("arms are only comparable at the same budget")
    reasons: list[str] = []
    if not candidate.manifest_determinism:
        reasons.append("its inclusion manifest is not reproducible")
    if candidate.anchor_both_count <= baseline.anchor_both_count:
        reasons.append(
            f"both-anchor count {candidate.anchor_both_count} does not beat "
            f"the baseline's {baseline.anchor_both_count}"
        )
    if candidate.doc_inclusion_count < baseline.doc_inclusion_count:
        reasons.append(
            f"document count {candidate.doc_inclusion_count} is below "
            f"the baseline's {baseline.doc_inclusion_count}"
        )
    base_strata = baseline.by_lang_pair()
    for lang_pair, row in candidate.by_lang_pair().items():
        was = base_strata.get(lang_pair, {}).get("anchor_both", 0)
        if row["anchor_both"] < was:
            reasons.append(
                f"it regresses {lang_pair}: {row['anchor_both']} both-anchor against {was}"
            )
    return Verdict(
        arm=candidate.arm,
        wins=not reasons,
        reasons=tuple(reasons),
        structural_additions=candidate.structural_additions,
        tokens_used=candidate.tokens_used,
    )


def smallest_winner(verdicts: Iterable[Verdict]) -> Verdict | None:
    """The smallest winning arm, or None when nothing won.

    None is the preregistered outcome for "no arm wins", and it is a complete
    result rather than a failure: the compiler still ships, with the baseline as
    its default and a recorded finding that structural cohesion did not pay.

    "Smallest" is ordered as preregistered: fewer structural additions first,
    then fewer tokens. A tie surviving both is returned as the first by arm
    name and **must be escalated rather than broken by preference** — the caller
    is expected to notice, which is why ties are detectable from the result.
    """
    winners = [v for v in verdicts if v.wins]
    if not winners:
        return None
    return sorted(winners, key=lambda v: (v.structural_additions, v.tokens_used, v.arm))[0]


def stratified_ranking(chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
    """A corpus-wide ordering that knows nothing about what is being looked for.

    Round-robin across documents, taking each document's chunks in order: the
    first chunk of every document, then the second of every document, and so on.

    **The ranking must not know the answer.** Ordering chunks by similarity to
    the very anchors the measurement is about would put the result into the
    input — the circularity this project refuses at proposal, in the form
    "retain the load-bearing chunks of an undiscovered bridge". Before discovery
    nothing knows which chunks are load-bearing, and an assembler that needs
    that knowledge has assumed its own conclusion.

    Diversity-first is also what the earlier experiment actually used, so the
    baseline arm measures against what happened rather than an idealisation.
    """
    per_source: dict[str, list[Chunk]] = {}
    for chunk in chunks:
        per_source.setdefault(chunk.source_id, []).append(chunk)
    for ordered in per_source.values():
        ordered.sort(key=lambda c: c.ordinal)
    order: list[str] = []
    depth = 0
    # Sorted rather than insertion-ordered: the ranking is a fact about the
    # corpus, not about the order the caller happened to hand chunks over in.
    sources = sorted(per_source)
    while True:
        added = False
        for source_id in sources:
            column = per_source[source_id]
            if depth < len(column):
                order.append(column[depth].id)
                added = True
        if not added:
            break
        depth += 1
    return tuple(order)
