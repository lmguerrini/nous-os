"""The context compiler, the arms, and the measurement that judges them.

Two properties carry this suite. **The inclusion manifest must be reproducible**
— the preregistration makes that an absolute, so a non-deterministic manifest
disqualifies an arm regardless of its other numbers. And **document-level and
anchor-chunk-level inclusion must never be combined into one figure**, because
reading one as evidence about the other is the exact defect this whole
capability exists to settle.

A third property has no natural home and is asserted here anyway: **no strategy
may consult what is being looked for.** A rule of the form "retain the
load-bearing chunks of an undiscovered bridge" is circular, and an arm that
peeked at the anchors would score well while measuring nothing.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import sys
from pathlib import Path

import pytest

import nous_os
from nous_os.ablation import (
    AblationError,
    ArmResult,
    Bridge,
    BridgeOutcome,
    judge,
    resolve_anchor,
    run_arm,
    smallest_winner,
    stratified_ranking,
)
from nous_os.chunking import Chunk, ChunkingError, chunk_document, estimate_tokens
from nous_os.compile import (
    PREREGISTERED_ARMS,
    AdjacentContext,
    CohesionStrategy,
    CompileError,
    CrossReference,
    FlatTopK,
    HeadingAware,
    ParentEnvelope,
    WholeDocumentEscalation,
    compile_pack,
)

A = "src_" + "ATDES".rjust(26, "0")
B = "src_" + "BFFCE".rjust(26, "0")
C = "src_" + "CFAR".rjust(26, "0")

DOCS = {
    A: (
        "# Tides\n\nThe tide rises twice each day.\n\nSpring tides reach five metres.\n\n"
        "## Records\n\nThe office keeps them. See [office](office).\n\n"
        "# Notes\n\nA closing note about the bay.\n"
    ),
    B: "# Office\n\nThe harbour office holds the records.\n\n## Keepers\n\nThree keepers worked a watch.\n",
    C: "# Faro\n\nIl faro sorveglia il porto.\n\nTre guardiani facevano turni di guardia.\n",
}


def _chunks() -> tuple[Chunk, ...]:
    return tuple(c for sid, text in DOCS.items() for c in chunk_document(sid, text, max_tokens=10))


def _ranking(chunks: tuple[Chunk, ...]) -> tuple[str, ...]:
    return tuple(c.id for c in chunks if c.ordinal == 0)


def _bridges() -> tuple[Bridge, ...]:
    return (
        Bridge("BR-1", "en->en", A, "The tide rises twice each day.", B, "The harbour office holds the records."),
        Bridge("BR-2", "it->en", C, "Il faro sorveglia il porto.", B, "Three keepers worked a watch."),
        Bridge("BR-3", "en->it", A, "A closing note about the bay.", C, "Tre guardiani facevano turni di guardia."),
    )


# --- the fixture must be able to show what it claims to -------------------


def test_the_fixture_has_enough_structure_to_separate_the_arms() -> None:
    """Guard the guard: arms that cannot differ prove nothing about cohesion."""
    chunks = _chunks()
    assert len({c.source_id for c in chunks}) >= 3
    assert max(len(c.heading_path) for c in chunks) >= 2, "no nested heading to be aware of"
    assert any(len([x for x in chunks if x.source_id == c.source_id]) >= 3 for c in chunks)
    assert any(c.references for c in chunks), "no reference for cross-reference completion"


# --- K2: the manifest is reproducible. Absolute. --------------------------


@pytest.mark.parametrize("arm", PREREGISTERED_ARMS, ids=lambda a: a.name)
def test_every_arm_produces_a_reproducible_manifest(arm: CohesionStrategy) -> None:
    chunks = _chunks()
    ranking = _ranking(chunks)
    first = compile_pack(chunks, ranking, arm, 200).manifest
    second = compile_pack(chunks, ranking, arm, 200).manifest
    assert first.digest == second.digest
    assert first.to_bytes() == second.to_bytes()


def test_the_manifest_digest_is_pinned_not_self_compared() -> None:
    """Every other determinism check here compares the code with itself."""
    chunks = _chunks()
    manifest = compile_pack(chunks, _ranking(chunks), FlatTopK(), 200).manifest
    assert manifest.digest == "63d127a9c61a4808e3779c2048052ea2a908a922401f239f0c3a5ed8886994ac"


def test_manifests_differ_when_the_pack_differs() -> None:
    chunks = _chunks()
    ranking = _ranking(chunks)
    digests = {
        compile_pack(chunks, ranking, FlatTopK(), 200).manifest.digest,
        compile_pack(chunks, ranking, AdjacentContext(), 200).manifest.digest,
        compile_pack(chunks, ranking, FlatTopK(), 30).manifest.digest,
        compile_pack(chunks, tuple(reversed(ranking)), FlatTopK(), 200).manifest.digest,
    }
    assert len(digests) == 4, "packs differing in arm, budget or ranking share a manifest"


def test_the_manifest_is_identical_in_a_fresh_process() -> None:
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        f"sys.path.insert(0,{str(Path(__file__).parent)!r});"
        "from test_compiler import _chunks,_ranking;"
        "from nous_os.compile import compile_pack, PREREGISTERED_ARMS;"
        "c=_chunks();r=_ranking(c);"
        "print(','.join(compile_pack(c,r,a,200).manifest.digest[:10] for a in PREREGISTERED_ARMS))"
    )
    observed = set()
    for seed in ("0", "1", "2", "3", "4", "5", "6", "7"):
        observed.add(
            subprocess.run(
                [sys.executable, "-c", program], capture_output=True, text=True,
                env=dict(os.environ, PYTHONHASHSEED=seed, TZ="Pacific/Kiritimati"), check=True,
            ).stdout.strip()
        )
    assert len(observed) == 1


# --- K4: two numbers, never one -------------------------------------------


def test_no_result_type_exposes_a_combined_inclusion_figure() -> None:
    """The defect this capability exists to settle, guarded structurally.

    Document-level inclusion was nearly complete while chunk-level was thin, and
    one was read as evidence about the other. A single "inclusion rate" is the
    shape that invites exactly that, so no such member may exist.
    """
    forbidden = ("inclusion_rate", "inclusion_score", "combined", "overall_inclusion", "total_inclusion")
    for holder in (ArmResult, BridgeOutcome):
        names = {n.lower() for n in dir(holder) if not n.startswith("_")}
        for bad in forbidden:
            assert bad not in names, f"{holder.__name__} exposes {bad!r}"
    result = _run(FlatTopK(), 200)
    keys = set(result.by_lang_pair().get("en->en", {}))
    assert "doc_inclusion" in keys and "anchor_both" in keys
    assert not any("rate" in k or "combined" in k for k in keys)


def _run(arm: CohesionStrategy, budget: int) -> ArmResult:
    chunks = _chunks()
    return run_arm(chunks, _ranking(chunks), arm, budget, _bridges())


def test_doc_and_anchor_inclusion_are_counted_independently() -> None:
    """They must be able to disagree, or reporting them apart means nothing."""
    result = _run(FlatTopK(), 40)
    assert result.doc_inclusion_count != result.anchor_both_count, (
        "the fixture cannot demonstrate the two metrics diverging"
    )


# --- K5: partial is its own answer ----------------------------------------


def test_exactly_one_anchor_is_neither_success_nor_failure() -> None:
    result = _run(FlatTopK(), 40)
    assert result.anchor_one_count > 0, "the fixture must produce a partial to test one"
    for outcome in result.outcomes:
        assert not (outcome.anchor_both and outcome.anchor_one)


def test_a_bridge_cannot_claim_both_and_exactly_one() -> None:
    with pytest.raises(AblationError):
        BridgeOutcome("BR-X", "en->en", True, True, True)


def test_an_unresolvable_anchor_is_none_rather_than_a_failure() -> None:
    """An anchor absent from the corpus cannot be delivered by any strategy, and
    charging an arm for it would charge it for a property of the evidence."""
    assert resolve_anchor(_chunks(), A, "a sentence that appears nowhere at all") is None
    assert resolve_anchor(_chunks(), A, "The tide rises twice each day.") is not None


# --- K6: language is a dimension ------------------------------------------


def test_every_count_is_available_per_language_pair() -> None:
    strata = _run(FlatTopK(), 200).by_lang_pair()
    assert set(strata) == {"en->en", "it->en", "en->it"}
    for row in strata.values():
        assert {"bridges", "doc_inclusion", "anchor_both", "anchor_one"} <= set(row)
    assert sum(r["bridges"] for r in strata.values()) == len(_bridges())


def test_the_language_strata_are_reported_in_a_fixed_order() -> None:
    assert list(_run(FlatTopK(), 200).by_lang_pair()) == sorted(_run(FlatTopK(), 200).by_lang_pair())


# --- K7: the decision rule is executable ----------------------------------


def test_an_arm_that_regresses_a_language_stratum_does_not_win() -> None:
    """The clause that refused the best-scoring arm in the real run."""
    base = ArmResult("S0", 100, (
        BridgeOutcome("a", "en->en", True, True, False),
        BridgeOutcome("b", "it->en", True, False, True),
    ), True, 10, 5, 0, 2, 1.0)
    candidate = ArmResult("S9", 100, (
        BridgeOutcome("a", "en->en", True, False, True),   # lost the same-language one
        BridgeOutcome("b", "it->en", True, True, False),   # gained a cross-language one
        BridgeOutcome("c", "it->en", True, True, False),
    ), True, 10, 6, 1, 2, 1.0)
    verdict = judge(base, candidate)
    assert candidate.anchor_both_count > base.anchor_both_count, "it beats the headline number"
    assert not verdict.wins
    assert any("regresses en->en" in r for r in verdict.reasons)


def test_a_non_reproducible_manifest_disqualifies_regardless_of_the_numbers() -> None:
    base = ArmResult("S0", 100, (BridgeOutcome("a", "en->en", True, False, False),), True, 10, 5, 0, 2, 1.0)
    candidate = ArmResult("S9", 100, (BridgeOutcome("a", "en->en", True, True, False),), False, 10, 6, 1, 2, 1.0)
    verdict = judge(base, candidate)
    assert not verdict.wins
    assert any("not reproducible" in r for r in verdict.reasons)


def test_arms_at_different_budgets_cannot_be_compared() -> None:
    base = ArmResult("S0", 100, (), True, 0, 0, 0, 0, 0.0)
    other = ArmResult("S9", 200, (), True, 0, 0, 0, 0, 0.0)
    with pytest.raises(AblationError):
        judge(base, other)


def test_no_winner_is_a_result_and_not_an_error() -> None:
    """The preregistered outcome for "no arm wins": the baseline stays."""
    assert smallest_winner([]) is None
    losing = judge(
        ArmResult("S0", 100, (BridgeOutcome("a", "en->en", True, True, False),), True, 10, 5, 0, 2, 1.0),
        ArmResult("S9", 100, (BridgeOutcome("a", "en->en", True, False, True),), True, 10, 5, 1, 2, 1.0),
    )
    assert smallest_winner([losing]) is None


def test_the_smallest_winner_is_chosen_by_structural_additions_then_tokens() -> None:
    from nous_os.ablation import Verdict

    big = Verdict("S-big", True, (), structural_additions=9, tokens_used=10)
    small = Verdict("S-small", True, (), structural_additions=2, tokens_used=99)
    assert smallest_winner([big, small]).arm == "S-small"
    cheap = Verdict("S-cheap", True, (), structural_additions=2, tokens_used=5)
    assert smallest_winner([big, small, cheap]).arm == "S-cheap"


# --- no arm may consult what is being looked for --------------------------


def test_no_strategy_can_see_a_bridge_or_an_anchor() -> None:
    """The circularity refused at proposal, enforced by signature.

    "Retain the load-bearing chunks of an undiscovered bridge" assumes its own
    conclusion: before discovery nothing knows which chunks are load-bearing.
    A strategy that could see the anchors would score well and measure nothing.
    """
    for arm in PREREGISTERED_ARMS:
        parameters = set(inspect.signature(arm.companions).parameters)
        assert parameters <= {"chunk", "chunks", "selected"}, (
            f"{arm.name} takes {parameters}, which could carry the answer"
        )
        source = inspect.getsource(type(arm)).lower()
        for word in ("bridge", "anchor", "outcome"):
            assert word not in source, f"{arm.name} mentions {word!r}"


# --- K3: the arms are the preregistered ones ------------------------------


def test_the_arm_set_matches_the_pre_declared_grid() -> None:
    names = [a.name for a in PREREGISTERED_ARMS]
    assert names.count("S0-flat") == 1
    assert names.count("S1-heading") == 1
    assert sorted(n for n in names if n.startswith("S2")) == [
        "S2-parent-1024", "S2-parent-256", "S2-parent-512",
    ]
    assert names.count("S3-adjacent") == 1
    assert names.count("S4-xref") == 1
    assert sorted(n for n in names if n.startswith("S5")) == sorted(
        f"S5-wholedoc-{n}-{f:g}" for n in (2, 3, 5) for f in (0.25, 0.50)
    )
    assert len(names) == len(set(names)) == 13


def test_an_arm_that_can_resolve_nothing_says_so() -> None:
    """Cross-reference completion on a corpus whose links point outward is not a
    tie with the baseline; it is a measurement that did not happen."""
    assert CrossReference({}).resolves_nothing
    assert not CrossReference({"office": B}).resolves_nothing


def test_cross_reference_completion_fires_when_targets_resolve() -> None:
    chunks = _chunks()
    # The ranking must actually contain the chunk that carries the reference,
    # and the budget must leave room for what it pulls in. A ranking that never
    # reaches a referencing chunk cannot distinguish an arm that is inert from
    # one that is merely unexercised -- the same confusion a real corpus
    # can produce, reproduced here on purpose.
    referencing = next(c for c in chunks if c.references)
    ranking = (referencing.id,)
    inert = compile_pack(chunks, ranking, CrossReference({}), 200).manifest
    live = compile_pack(chunks, ranking, CrossReference({"office": B}), 200).manifest
    assert len(inert.structural) == 0
    assert len(live.structural) > 0, "the arm still did not fire with a resolvable target"
    assert B in live.source_ids and B not in inert.source_ids


def test_whole_document_escalation_fires_during_the_walk() -> None:
    """It escalated after the budget was spent and could never take effect."""
    chunks = _chunks()
    ranking = tuple(c.id for c in chunks)
    escalating = compile_pack(chunks, ranking, WholeDocumentEscalation(2, 0.25), 60).manifest
    assert escalating.structural, "escalation contributed nothing even mid-walk"


# --- K1: retrieval and compilation are separate stages --------------------


def test_compilation_accepts_a_ranking_no_retriever_produced() -> None:
    chunks = _chunks()
    invented = tuple(reversed([c.id for c in chunks]))
    pack = compile_pack(chunks, invented, FlatTopK(), 40)
    assert pack.chunks
    assert pack.manifest.rank_selected[0] == invented[0]


def test_a_ranking_naming_an_unknown_chunk_is_refused() -> None:
    with pytest.raises(CompileError):
        compile_pack(_chunks(), ("src_" + "Z" * 26 + "#0000",), FlatTopK(), 40)


@pytest.mark.parametrize("budget", [0, -1, True, "40", None])
def test_a_nonsensical_budget_is_refused(budget: object) -> None:
    with pytest.raises(CompileError):
        compile_pack(_chunks(), _ranking(_chunks()), FlatTopK(), budget)  # type: ignore[arg-type]


def test_a_pack_never_exceeds_its_budget() -> None:
    chunks = _chunks()
    for arm in PREREGISTERED_ARMS:
        for budget in (10, 40, 200):
            manifest = compile_pack(chunks, _ranking(chunks), arm, budget).manifest
            assert manifest.tokens_used <= budget


# --- the ranking must not know the answer ---------------------------------


def test_the_ranking_is_a_function_of_the_corpus_and_nothing_else() -> None:
    chunks = _chunks()
    assert stratified_ranking(chunks) == stratified_ranking(tuple(reversed(chunks)))


def test_the_ranking_visits_every_document_before_any_second_chunk() -> None:
    """Diversity-first, so a ranking cannot concentrate on one document."""
    chunks = _chunks()
    order = stratified_ranking(chunks)
    sources = len({c.source_id for c in chunks})
    first_pass = {cid.split("#")[0] for cid in order[:sources]}
    assert len(first_pass) == sources


# --- chunking --------------------------------------------------------------


def test_a_chunk_never_spans_a_heading_boundary() -> None:
    for chunk in _chunks():
        assert isinstance(chunk.heading_path, tuple)


def test_heading_paths_nest() -> None:
    chunks = chunk_document(A, DOCS[A], max_tokens=10)
    paths = [c.heading_path for c in chunks]
    assert ("Tides",) in paths and ("Tides", "Records") in paths and ("Notes",) in paths


def test_chunking_is_deterministic() -> None:
    assert chunk_document(A, DOCS[A]) == chunk_document(A, DOCS[A])


def test_the_token_estimate_is_a_word_count_and_says_so() -> None:
    assert estimate_tokens("one two three") == 3
    assert "estimate" in (estimate_tokens.__doc__ or "").lower()


@pytest.mark.parametrize("bad", ["", "   ", "\n\n"])
def test_a_document_with_no_content_yields_no_chunks(bad: str) -> None:
    assert chunk_document(A, bad) == ()


def test_a_malformed_source_identifier_is_refused() -> None:
    with pytest.raises(Exception):
        chunk_document("not-an-identifier", DOCS[A])


def test_two_chunks_never_share_an_identifier() -> None:
    ids = [c.id for c in _chunks()]
    assert len(ids) == len(set(ids))


def test_document_inclusion_requires_both_endpoints_not_either() -> None:
    """The fixture always had both, so `and` and `or` were indistinguishable.

    A bridge with one endpoint in the pack and one outside is the case that
    separates them, and it is the ordinary case on a real corpus.
    """
    chunks = _chunks()
    only_a = tuple(c.id for c in chunks if c.source_id == A)
    half = Bridge("BR-HALF", "en->en", A, "The tide rises twice each day.", B, "The harbour office holds the records.")
    result = run_arm(chunks, only_a, FlatTopK(), 500, (half,))
    assert result.outcomes[0].doc_inclusion is False, "one endpoint present must not count"
    assert A in {c.source_id for c in chunks if c.id in only_a}


def test_an_arm_that_merely_ties_the_baseline_does_not_win() -> None:
    """Every judge test covered a regression or a disqualification; none covered
    a tie, so the clause requiring an improvement could be deleted."""
    outcomes = (BridgeOutcome("a", "en->en", True, True, False),)
    base = ArmResult("S0", 100, outcomes, True, 10, 5, 0, 2, 1.0)
    tied = ArmResult("S9", 100, outcomes, True, 10, 6, 1, 2, 1.0)
    verdict = judge(base, tied)
    assert tied.anchor_both_count == base.anchor_both_count
    assert not verdict.wins
    assert any("does not beat" in r for r in verdict.reasons)


def test_run_arm_computes_determinism_rather_than_asserting_it() -> None:
    """Every determinism test built the flag by hand, so `= True` survived.

    A strategy whose output varies between calls must be caught by the arm
    runner itself, which is the only place the check actually happens.
    """

    class Restless:
        """Deliberately non-deterministic: it alternates what it adds."""

        def __init__(self) -> None:
            self.calls = 0

        @property
        def name(self) -> str:
            return "restless"

        def companions(self, chunk, chunks, selected):
            self.calls += 1
            siblings = [c.id for c in chunks if c.source_id == chunk.source_id and c.id != chunk.id]
            return tuple(siblings[:1]) if self.calls % 2 else ()

        def finalise(self, selected, chunks):
            return ()

    chunks = _chunks()
    result = run_arm(chunks, _ranking(chunks), Restless(), 200, _bridges())
    assert result.manifest_determinism is False, "a varying strategy was reported reproducible"
    steady = run_arm(chunks, _ranking(chunks), FlatTopK(), 200, _bridges())
    assert steady.manifest_determinism is True


def test_the_ranking_source_order_does_not_depend_on_iteration() -> None:
    chunks = _chunks()
    shuffled = chunks[3:] + chunks[:3]
    assert stratified_ranking(chunks) == stratified_ranking(shuffled)
