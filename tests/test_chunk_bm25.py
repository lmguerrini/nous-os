"""Checks for the chunk-level lexical retrieval control."""

from __future__ import annotations

import os
import subprocess
import sys
from math import isclose, log
from pathlib import Path

import pytest

import nous_os
from benchmarks.chunk_bm25 import B, K1, ChunkBM25, LexicalError
from nous_os.aliases import HandGlossary
from nous_os.chunking import Chunk, estimate_tokens


SOURCE_A = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
SOURCE_B = "src_01BRZ3NDEKTSV4RRFFQ69G5FAV"
SOURCE_C = "src_01CRZ3NDEKTSV4RRFFQ69G5FAV"


def _chunk(chunk_id: str, source_id: str, text: str) -> Chunk:
    return Chunk(
        id=chunk_id,
        source_id=source_id,
        ordinal=0,
        heading_path=(),
        text=text,
        tokens=estimate_tokens(text),
    )


def test_bm25_matches_a_hand_computed_three_chunk_oracle() -> None:
    index = ChunkBM25(
        (
            _chunk("chunk-a", SOURCE_A, "alpha alpha beta"),
            _chunk("chunk-b", SOURCE_B, "alpha gamma gamma"),
            _chunk("chunk-c", SOURCE_C, "delta epsilon zeta"),
        )
    )

    hit = index.search("alpha", limit=1)[0]

    # N=3, df(alpha)=2, so idf=ln(1 + (3-2+0.5)/(2+0.5))=ln(1.6).
    # avgdl=3 and |d|=3; for f=2 the factor is 2*(1.2+1)/(2+1.2)=1.375.
    expected = log(1.6) * 1.375
    assert hit.chunk_id == "chunk-a"
    assert isclose(hit.score, expected, rel_tol=0.0, abs_tol=1e-12)
    assert (K1, B) == (1.2, 0.75)


def test_source_exclusion_happens_before_the_rank_cut() -> None:
    index = ChunkBM25(
        (
            _chunk("chunk-a", SOURCE_A, "needle needle needle"),
            _chunk("chunk-b", SOURCE_B, "needle needle"),
            _chunk("chunk-c", SOURCE_C, "needle"),
        )
    )

    hits = index.search("needle", limit=2, exclude_sources=frozenset({SOURCE_A}))

    assert tuple(hit.chunk_id for hit in hits) == ("chunk-b", "chunk-c")
    assert tuple(hit.rank for hit in hits) == (1, 2)


def test_real_score_ties_are_broken_by_chunk_id_not_input_order() -> None:
    index = ChunkBM25(
        (
            _chunk("chunk-b", SOURCE_B, "needle other"),
            _chunk("chunk-a", SOURCE_A, "needle other"),
        )
    )

    hits = index.search("needle", limit=2)

    assert hits[0].score == hits[1].score
    assert tuple(hit.chunk_id for hit in hits) == ("chunk-a", "chunk-b")


def test_query_aliases_expand_only_when_a_derivation_is_named() -> None:
    index = ChunkBM25((_chunk("chunk-a", SOURCE_A, "the hue is blue"),))

    assert index.search("colour", limit=1) == ()
    hits = index.search("colour", limit=1, aliases=HandGlossary({"colour": "hue"}))
    assert tuple(hit.chunk_id for hit in hits) == ("chunk-a",)


def test_shared_normalisation_and_one_character_rule_apply_to_queries() -> None:
    index = ChunkBM25((_chunk("chunk-a", SOURCE_A, "full width token"),))

    hits = index.search("Ａ ＦＵＬＬ", limit=1)

    assert tuple(hit.chunk_id for hit in hits) == ("chunk-a",)


def test_empty_index_is_refused_and_empty_normalised_query_is_not_an_error() -> None:
    with pytest.raises(LexicalError, match="non-empty"):
        ChunkBM25(())

    index = ChunkBM25((_chunk("chunk-a", SOURCE_A, "searchable text"),))
    assert index.search("A 7 _ !", limit=1) == ()
    with pytest.raises(LexicalError, match="positive integer"):
        index.search("searchable", limit=0)


def test_state_digest_is_independent_of_input_order_and_process_hash_seed() -> None:
    first = _chunk("chunk-a", SOURCE_A, "needle alpha")
    second = _chunk("chunk-b", SOURCE_B, "needle beta")
    index = ChunkBM25((second, first))
    assert index.state_digest() == ChunkBM25((first, second)).state_digest()

    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        "from benchmarks.chunk_bm25 import ChunkBM25;"
        "from nous_os.chunking import Chunk;"
        "a=Chunk('chunk-a','src_01ARZ3NDEKTSV4RRFFQ69G5FAV',0,(), 'needle alpha',2);"
        "b=Chunk('chunk-b','src_01BRZ3NDEKTSV4RRFFQ69G5FAV',0,(), 'needle beta',2);"
        "print(ChunkBM25((b,a)).state_digest())"
    )
    observed = set()
    for seed in ("0", "1", "2", "3"):
        result = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True,
            check=True,
            env=dict(os.environ, PYTHONHASHSEED=seed),
            text=True,
        )
        observed.add(result.stdout.strip())
    assert observed == {index.state_digest()}


def test_state_digest_changes_when_the_index_structure_changes() -> None:
    first = ChunkBM25((_chunk("chunk-a", SOURCE_A, "needle alpha"),))
    second = ChunkBM25((_chunk("chunk-a", SOURCE_A, "needle beta"),))

    assert first.state_digest() != second.state_digest()


def test_preregistered_parameters_refuse_alternatives() -> None:
    chunks = (_chunk("chunk-a", SOURCE_A, "needle"),)

    with pytest.raises(LexicalError, match="fixed"):
        ChunkBM25(chunks, k1=0.75, b=1.2)
