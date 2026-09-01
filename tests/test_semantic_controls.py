"""Negative controls for CAP-15: dense similarity must not become authority.

Four things this suite exists to pin, not to prove clever:

**N2 — no write path.** `semantic.py` builds an index over already-chunked
text. It has no business creating a proposal, a bridge, or an assertion, and
this is checked over the module's actual import statements, not a comment
someone could forget to update.

**N3 — exact retrieval must not regress.** `fixtures/synthetic/GOLDEN.md`
freezes four G-RETR cases under the published criterion "returns that one and
no other" — containment is not enough, and this project has a recorded
finding (CAP-05 J9) about exactly that mistake. This measures the dense
arm's actual top-1 behaviour against the frozen expectation and pins whatever
it finds, including a miss, rather than only the outcome that flatters dense.

**N4 — grounding survives.** Every hit has to resolve to a real, indexed
chunk from the source it claims, containing text that is genuinely part of
that document. A ranking that points at nothing real is worse than no
ranking.

**N5 — the empty answer.** A cosine index has no notion of "no match"; it
always returns the `limit` nearest vectors, however unrelated the query. BM25
returns nothing when no term matches. This measures whether the two arms'
top-1 scores, on queries the fixture can and cannot answer, actually separate
— because if they do not, no threshold on cosine similarity alone can stand
in for BM25's empty result.
"""

from __future__ import annotations

import ast
import os
from dataclasses import replace
from pathlib import Path

import pytest

# Resolution must never reach the network in this suite: both checkpoints are
# already in the local cache, and a suite that can silently fall back to
# downloading has a runtime and an outcome that depend on whatever network
# happens to be present that day.
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from benchmarks.chunk_bm25 import ChunkBM25
from nous_os.chunking import Chunk, chunk_document
from nous_os.semantic import DENSE_ML, IndexStatus, SemanticHit, SemanticIndex, build

REPO_ROOT = Path(__file__).resolve().parent.parent
SEMANTIC_SOURCE = REPO_ROOT / "src" / "nous_os" / "semantic.py"
BILINGUAL = REPO_ROOT / "fixtures" / "synthetic" / "bilingual"


def _sid(tail: str) -> str:
    return "src_" + tail.rjust(26, "0")


DOCS = {
    "en-tides": _sid("ENTDES"),
    "it-maree": _sid("TMAREE"),
    "en-lighthouse": _sid("ENGHTHSE"),
    "it-faro": _sid("TFAR"),
}

# Read from fixtures/synthetic/GOLDEN.md's G-RETR table, not from a run:
# each query appears verbatim in exactly one document.
G_RETR = (
    ("tide", "en-tides"),
    ("marea", "it-maree"),
    ("lighthouse", "en-lighthouse"),
    ("faro", "it-faro"),
)

# Wholly absent from the four lighthouse/tides documents -- two unrelated
# subjects, so a match on either would be a fixture defect, not a real hit.
NO_ANSWER_QUERIES = (
    "semiconductor fabrication wafer etching process",
    "medieval falconry hunting birds hood jesses",
)


def _bilingual_chunks() -> tuple[Chunk, ...]:
    chunks: tuple[Chunk, ...] = ()
    for name, source_id in DOCS.items():
        text = (BILINGUAL / f"{name}.md").read_text(encoding="utf-8")
        chunks += chunk_document(source_id, text)
    return chunks


@pytest.fixture(scope="module")
def bilingual_index() -> SemanticIndex:
    index = build(_bilingual_chunks(), DENSE_ML)
    assert index.status is IndexStatus.COMPLETE, (
        "DENSE-ML must already be cached locally for this suite; see semantic.py's "
        "network posture"
    )
    return index


# --- N2: no CAP-15 code path can emit a relation ----------------------------

#: Sourced by reading candidates.py, adjudication.py and discovery.py
#: directly: these are the modules a write into candidate, adjudication, or
#: discovery state has to go through.
_WRITE_PATH_MODULES = {
    "candidates",
    "adjudication",
    "discovery",
    "nous_os.candidates",
    "nous_os.adjudication",
    "nous_os.discovery",
}


def _imported_write_paths(source: str) -> set[str]:
    """The write-path modules ``source`` imports, found over the AST.

    A grep for the word "candidates" would pass as long as nobody typed it in
    a comment; this walks the actual `Import`/`ImportFrom` nodes, so a real
    ``import nous_os.candidates`` or ``from nous_os import adjudication`` is
    what gets caught, not incidental text.
    """
    tree = ast.parse(source)
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in _WRITE_PATH_MODULES:
                    found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module in _WRITE_PATH_MODULES:
                found.add(node.module)
            for alias in node.names:
                qualified = f"{node.module}.{alias.name}" if node.module else alias.name
                if qualified in _WRITE_PATH_MODULES:
                    found.add(qualified)
    return found


def test_semantic_py_imports_no_candidate_adjudication_or_discovery_write_path() -> None:
    """CAP-15 builds an index; it must be structurally unable to create a
    candidate, a bridge, or an assertion. The only way this module could turn
    a dense hit into a write is by reaching into one of those modules, so the
    absence of any such import is the whole guarantee."""
    source = SEMANTIC_SOURCE.read_text(encoding="utf-8")
    assert _imported_write_paths(source) == set()


def test_the_write_path_check_actually_fires_on_a_planted_import() -> None:
    """Guard the guard above: prove the checker is a real detector and not a
    tautology that would pass no matter what semantic.py contained."""
    source = SEMANTIC_SOURCE.read_text(encoding="utf-8")

    by_module = source + "\nfrom nous_os.candidates import Proposal\n"
    assert _imported_write_paths(by_module) == {"nous_os.candidates"}

    by_submodule_name = source + "\nfrom nous_os import adjudication\n"
    assert _imported_write_paths(by_submodule_name) == {"nous_os.adjudication"}

    bare = source + "\nimport discovery\n"
    assert _imported_write_paths(bare) == {"discovery"}


# --- N3: exact retrieval must not regress -----------------------------------


def test_exact_retrieval_top1_matches_the_documented_golden_cases(
    bilingual_index: SemanticIndex,
) -> None:
    """Pins DENSE-ML's observed top-1 behaviour against GOLDEN.md's G-RETR
    table, one case at a time.

    The published criterion is "returns that one and no other" -- scoring by
    containment would credit a system that returned every document with a
    perfect run, which is exactly the CAP-05 J9 mistake this project has
    already recorded. Checking rank 1 enforces "no other" directly: a wrong
    top hit is a MISS even if the right document is present lower down.

    Dense retrieval is not guaranteed to reproduce exact lexical matching.
    What follows is what was actually observed for DENSE-ML, over the pinned
    encode configuration in semantic.py, on this fixture -- a recorded fact
    about this run, not an assumed property of dense retrieval in general. If
    a future change to the backend, the pinned configuration, or the fixture
    text moves any one of these off top rank, this is meant to go red rather
    than be quietly rewritten to match.
    """
    top1 = {query: bilingual_index.search(query, limit=1)[0] for query, _ in G_RETR}

    # Observed: DENSE-ML puts the documented document in first place for all
    # four G-RETR cases over this fixture.
    assert top1["tide"].source_id == DOCS["en-tides"], (
        f"'tide' top-1 was {top1['tide'].source_id!r} (score {top1['tide'].score!r}), "
        f"not en-tides"
    )
    assert top1["marea"].source_id == DOCS["it-maree"], (
        f"'marea' top-1 was {top1['marea'].source_id!r} (score {top1['marea'].score!r}), "
        f"not it-maree"
    )
    assert top1["lighthouse"].source_id == DOCS["en-lighthouse"], (
        f"'lighthouse' top-1 was {top1['lighthouse'].source_id!r} "
        f"(score {top1['lighthouse'].score!r}), not en-lighthouse"
    )
    assert top1["faro"].source_id == DOCS["it-faro"], (
        f"'faro' top-1 was {top1['faro'].source_id!r} (score {top1['faro'].score!r}), "
        f"not it-faro"
    )


# --- N4: grounding survives -------------------------------------------------


def _assert_hit_is_grounded(
    hit: SemanticHit,
    chunks_by_id: dict[str, Chunk],
    document_text_by_source: dict[str, str],
) -> None:
    """A hit means nothing unless it resolves to a chunk that was actually
    indexed, from the source it claims, whose text is genuinely part of that
    document. Any one of the three failing is a ranking pointing at nothing
    real."""
    assert hit.chunk_id in chunks_by_id, f"{hit.chunk_id} was never indexed"
    chunk = chunks_by_id[hit.chunk_id]
    assert hit.source_id == chunk.source_id, (
        f"{hit.chunk_id} belongs to {chunk.source_id!r}, the hit claims {hit.source_id!r}"
    )
    document_text = document_text_by_source[chunk.source_id]
    assert chunk.text in document_text, (
        f"{hit.chunk_id}'s stored text is not actually part of {chunk.source_id}'s document"
    )


def _document_texts() -> dict[str, str]:
    return {DOCS[name]: (BILINGUAL / f"{name}.md").read_text(encoding="utf-8") for name in DOCS}


def test_every_hit_resolves_to_a_real_indexed_chunk(bilingual_index: SemanticIndex) -> None:
    chunks_by_id = {chunk.id: chunk for chunk in _bilingual_chunks()}
    document_text_by_source = _document_texts()
    for query, _ in G_RETR:
        for hit in bilingual_index.search(query, limit=4):
            _assert_hit_is_grounded(hit, chunks_by_id, document_text_by_source)


def test_grounding_check_fires_on_a_chunk_id_that_was_never_indexed() -> None:
    chunks_by_id = {chunk.id: chunk for chunk in _bilingual_chunks()}
    document_text_by_source = _document_texts()
    forged = SemanticHit(
        chunk_id="src_" + "F" * 26 + "#0000", source_id=DOCS["en-tides"], score=0.9, rank=1
    )
    with pytest.raises(AssertionError):
        _assert_hit_is_grounded(forged, chunks_by_id, document_text_by_source)


def test_grounding_check_fires_on_a_source_id_that_does_not_match_the_chunk() -> None:
    chunks_by_id = {chunk.id: chunk for chunk in _bilingual_chunks()}
    document_text_by_source = _document_texts()
    real_chunk_id, real_chunk = next(iter(chunks_by_id.items()))
    assert real_chunk.source_id != DOCS["it-faro"], "fixture assumption broke: pick another chunk"
    mismatched = SemanticHit(
        chunk_id=real_chunk_id, source_id=DOCS["it-faro"], score=0.9, rank=1
    )
    with pytest.raises(AssertionError):
        _assert_hit_is_grounded(mismatched, chunks_by_id, document_text_by_source)


def test_grounding_check_fires_when_the_chunk_text_is_not_in_its_claimed_document() -> None:
    """Simulates a corrupted index entry: right id, right source, wrong text."""
    chunks_by_id = {chunk.id: chunk for chunk in _bilingual_chunks()}
    document_text_by_source = _document_texts()
    real_chunk_id, real_chunk = next(iter(chunks_by_id.items()))
    doctored_chunk = replace(real_chunk, text="This sentence appears in no fixture document.")
    doctored_chunks_by_id = {**chunks_by_id, real_chunk_id: doctored_chunk}
    hit = SemanticHit(chunk_id=real_chunk_id, source_id=real_chunk.source_id, score=0.9, rank=1)
    with pytest.raises(AssertionError):
        _assert_hit_is_grounded(hit, doctored_chunks_by_id, document_text_by_source)


# --- N5: the empty answer ---------------------------------------------------


def test_cosine_score_ranges_overlap_between_answered_and_unanswered_queries(
    bilingual_index: SemanticIndex,
) -> None:
    """The single most important architectural difference between the arms.

    `ChunkBM25.search` returns an empty tuple when no term matches, so "no
    answer" is a distinguishable outcome by construction. `SemanticIndex.search`
    always returns the ``limit`` nearest vectors, however unrelated the query
    -- there is no vector-space equivalent of an empty result. This measures
    whether a threshold on the score alone could still stand in for that
    missing signal, by comparing the observed top-1 cosine score for queries
    the fixture can answer against the observed top-1 score for queries about
    a subject the fixture never mentions.

    No threshold is chosen in advance and checked against; a value picked
    after seeing these two ranges would be a tuned parameter dressed up as a
    property. What is asserted is only whether the two ranges as observed
    overlap.
    """
    answered_scores = {query: bilingual_index.search(query, limit=1)[0].score for query, _ in G_RETR}
    unanswered_scores = {query: bilingual_index.search(query, limit=1)[0].score for query in NO_ANSWER_QUERIES}

    answered_min, answered_max = min(answered_scores.values()), max(answered_scores.values())
    unanswered_min, unanswered_max = min(unanswered_scores.values()), max(unanswered_scores.values())

    overlaps = not (unanswered_max < answered_min or answered_max < unanswered_min)
    # Observed: the top unanswered score is higher than the lowest answered
    # score, so the ranges overlap and no single cosine threshold separates
    # "the fixture has this" from "the fixture has nothing about this".
    assert overlaps, (
        f"expected the ranges to overlap and they did not: "
        f"answered={answered_scores} [{answered_min!r}, {answered_max!r}], "
        f"unanswered={unanswered_scores} [{unanswered_min!r}, {unanswered_max!r}]"
    )


def test_bm25_returns_nothing_for_the_same_unanswerable_queries() -> None:
    """On THIS four-document fixture the lexical arm returns nothing.

    Scope matters and is stated in the docstring rather than left to a reader.
    An earlier version of this line called the result "the asymmetry N5 names:
    lexical retrieval has a real 'no answer'" -- generalising four documents into
    a property of lexical retrieval. A private corpus showed that claim to be
    false: there, BM25 does return results for queries that have no answer.
    `F16` records the error; this docstring is the same claim
    in the product repository, and it is narrowed to the fixture it measures.
    """
    index = ChunkBM25(_bilingual_chunks())
    for query in NO_ANSWER_QUERIES:
        assert index.search(query, limit=4) == (), f"{query!r} unexpectedly matched a term"
    # And BM25 does answer the queries the fixture can answer, so the empty
    # result above is "no match", not "the index is broken".
    for query, expected_name in G_RETR:
        hits = index.search(query, limit=4)
        assert hits and hits[0].source_id == DOCS[expected_name]
