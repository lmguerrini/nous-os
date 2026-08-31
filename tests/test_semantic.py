"""The dense semantic index, and its third answer.

Two things this suite exists to protect, the same two `test_measure.py`
protects for the alias layer:

**Determinism across processes, not within one.** A digest compared with a
digest of the same in-process call proves nothing about a second machine
loading the same weights; the cross-process test below is a fresh interpreter,
not a second call.

**Not-run is a real outcome.** An index whose weights could not be resolved
reports `IndexStatus.NOT_RUN` with a reason, never an empty index that a caller
would read as "searched everything and matched nothing".

The two backends are used for real throughout -- no stand-in encoder. That
makes the suite slow; it is what "byte-identical across processes" actually
has to mean for an ONNX session and a real tokenizer, not an approximation of
it with a mock that could not have carried the defects those things carry.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

# Resolution must never reach the network in this suite: every checkpoint this
# capability was preregistered against is already in the local cache, and a
# suite that can silently fall back to downloading is a suite whose runtime
# and outcome depend on whatever network happens to be present that day.
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import nous_os
from nous_os.chunking import Chunk, chunk_document
from nous_os.identity import new_source_id
from nous_os.semantic import (
    DENSE_EN,
    DENSE_ML,
    MAX_TOKENS,
    Backend,
    IndexStatus,
    ModelSpec,
    OnnxBackend,
    SemanticError,
    SemanticIndex,
    build,
    not_run,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def _sid(tail: str) -> str:
    return "src_" + tail.rjust(26, "0")

SOURCE_LIGHTHOUSE = _sid("BEACN")
SOURCE_BREAD = _sid("BREAD")
SOURCE_STORM = _sid("STRM")
SOURCE_TIE_LOW = _sid("TAGA")
SOURCE_TIE_HIGH = _sid("TAGZ")

LIGHTHOUSE_TEXT = (
    "# Coastal navigation\n\n"
    "The lighthouse keeper lit the beacon at dusk so that ships passing the "
    "rocky headland could find the safe channel into the harbour."
)
BREAD_TEXT = (
    "# Baking\n\n"
    "Knead the dough for ten minutes, let it rise for an hour, then bake the "
    "loaf until the crust is golden brown and the kitchen smells of bread."
)
STORM_TEXT = (
    "# Weather\n\n"
    "A storm rolled in from the sea overnight, and heavy rain and high winds "
    "kept every boat in the harbour until morning."
)


def _mixed_chunks() -> tuple[Chunk, ...]:
    """Three documents, deliberately unrelated in subject, none a paraphrase
    of another -- so a real ranking between them is not a coin flip."""
    return (
        chunk_document(SOURCE_LIGHTHOUSE, LIGHTHOUSE_TEXT)
        + chunk_document(SOURCE_BREAD, BREAD_TEXT)
        + chunk_document(SOURCE_STORM, STORM_TEXT)
    )


def _en_index() -> SemanticIndex:
    return build(_mixed_chunks(), DENSE_EN)


@pytest.fixture(scope="module")
def en_backend() -> OnnxBackend:
    return OnnxBackend(DENSE_EN)


# --- the fixture is not degenerate -----------------------------------------


def _content_words(text: str) -> set[str]:
    """Lower-cased words over three characters, so a shared "the" or "and"
    does not read as the near-duplicate wording this guard exists to catch."""
    return {w.strip(".,#").lower() for w in text.split() if len(w.strip(".,#")) > 3}


def test_the_fixture_has_several_sources_and_no_shared_wording() -> None:
    """Guard the guard: a tie-break or exclusion test over one source or over
    near-duplicate wording could pass by accident."""
    chunks = _mixed_chunks()
    assert len({c.source_id for c in chunks}) == 3
    words = [_content_words(LIGHTHOUSE_TEXT), _content_words(BREAD_TEXT), _content_words(STORM_TEXT)]
    for i in range(3):
        for j in range(i + 1, 3):
            assert len(words[i] & words[j]) <= 1


# --- construction, and its refusals -----------------------------------------


def test_build_refuses_an_empty_chunk_set() -> None:
    """An empty index would score every query zero and read as complete."""
    with pytest.raises(SemanticError):
        build((), DENSE_EN)


def test_build_refuses_chunks_that_share_an_id() -> None:
    chunk = chunk_document(SOURCE_LIGHTHOUSE, LIGHTHOUSE_TEXT)[0]
    with pytest.raises(SemanticError):
        build((chunk, chunk), DENSE_EN)


def test_build_refuses_a_spec_that_is_not_a_model_spec() -> None:
    with pytest.raises(SemanticError):
        build(_mixed_chunks(), "sentence-transformers/all-MiniLM-L6-v2")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "spec",
    [
        ModelSpec("BOGUS-REPO", "sentence-transformers/this-repo-does-not-exist-nous-os"),
        ModelSpec("BOGUS-FILE", DENSE_EN.repo_id, "onnx/does-not-exist.onnx", DENSE_EN.tokenizer_filename),
    ],
    ids=["absent repository", "absent file in a real repository"],
)
def test_an_unresolvable_model_yields_not_run_with_a_reason(spec: ModelSpec) -> None:
    result = build(_mixed_chunks(), spec)
    assert result.status is IndexStatus.NOT_RUN
    assert result.reason and spec.name in result.reason
    assert result.chunk_ids == () and result.source_ids == ()
    assert result.vectors is None and result.backend is None
    with pytest.raises(SemanticError):
        result.search("anything", limit=1)
    with pytest.raises(SemanticError):
        result.state_digest()


def test_the_two_unresolvable_reasons_are_distinguishable() -> None:
    """A caller reading the reason months later must be able to tell "the
    repository is gone" apart from "this one file within it is gone"."""
    by_repo = build(
        _mixed_chunks(), ModelSpec("A", "sentence-transformers/this-repo-does-not-exist-nous-os")
    )
    by_file = build(
        _mixed_chunks(),
        ModelSpec("B", DENSE_EN.repo_id, "onnx/does-not-exist.onnx", DENSE_EN.tokenizer_filename),
    )
    assert by_repo.reason != by_file.reason
    assert DENSE_EN.repo_id in by_file.reason


def test_not_run_requires_a_reason() -> None:
    with pytest.raises(SemanticError):
        not_run("DENSE-EN", "   ")


def test_a_working_model_still_builds_after_an_unresolvable_one_was_tried() -> None:
    """The not-run path must not corrupt anything a later, valid build needs."""
    build(_mixed_chunks(), ModelSpec("A", "sentence-transformers/this-repo-does-not-exist-nous-os"))
    result = build(_mixed_chunks(), DENSE_EN)
    assert result.status is IndexStatus.COMPLETE


# --- both real backends, named and distinct ---------------------------------


@pytest.mark.parametrize("spec", [DENSE_EN, DENSE_ML], ids=["DENSE-EN", "DENSE-ML"])
def test_each_named_backend_resolves_and_reports_its_own_checkpoint(spec: ModelSpec) -> None:
    backend = OnnxBackend(spec)
    assert isinstance(backend, Backend)
    assert backend.name == spec.name
    assert len(backend.checkpoint_digest) == 64
    int(backend.checkpoint_digest, 16)  # hex, not raised


def test_the_two_backends_load_different_weights() -> None:
    assert OnnxBackend(DENSE_EN).checkpoint_digest != OnnxBackend(DENSE_ML).checkpoint_digest


def test_no_module_level_default_backend_is_offered() -> None:
    """Mirrors aliases.py's own guard: nothing here is "the" encoder."""
    import nous_os.semantic as module

    for forbidden in ("default", "default_backend", "recommended", "preferred"):
        assert not hasattr(module, forbidden)
    for name in dir(module):
        if name.startswith("_"):
            continue
        value = getattr(module, name)
        if isinstance(value, type):
            continue
        assert not isinstance(value, Backend), (
            f"{name} is a ready-made backend at module level, which a caller "
            "would reach for without choosing"
        )


# --- pooling, normalisation, and the mask that makes both true -------------


def test_vectors_are_l2_normalised() -> None:
    index = _en_index()
    norms = np.linalg.norm(index.vectors, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


def test_vectors_are_float32(en_backend: OnnxBackend) -> None:
    vectors = en_backend.encode(("a short sentence",))
    assert vectors.dtype == np.float32


def test_preregistered_truncation_length_is_fixed_and_applied(en_backend: OnnxBackend) -> None:
    """Every published dense vector depends on this exact maximum length.

    Pinning only the value would allow the encoder to stop applying it, so the
    tokenizer is also given a longer input and required to truncate it.
    """
    assert MAX_TOKENS == 256
    encoding = en_backend._tokenizer.encode("token " * (MAX_TOKENS * 2))
    assert len(encoding.ids) == MAX_TOKENS


def test_pooling_respects_the_attention_mask_not_just_the_raw_average(
    en_backend: OnnxBackend,
) -> None:
    """A padded batch and the same text encoded alone must not differ.

    If pooling averaged over every position including padding rather than
    over the attention mask, padding a short text out to match a much longer
    one in the same batch would pull its vector toward the pad embedding and
    the two encodings would disagree. They must not.
    """
    short = "The keeper lit the lamp."
    long_padding_forcer = (
        "A very long sentence, deliberately padded out with many extra words "
        "so that the short sentence above is forced to carry a great deal of "
        "padding when the two are tokenized and batched together for encoding."
    )
    alone = en_backend.encode((short,))[0]
    batched = en_backend.encode((short, long_padding_forcer))[0]
    assert np.array_equal(alone, batched), "batch padding changed the pooled vector"


def test_a_longer_batch_actually_pads_the_shorter_sequence() -> None:
    """Guard the guard above: if this tokenizer's config did not pad at all,
    the invariance test would pass trivially because there is no padding to
    hide a masking bug behind. Checked independently of `OnnxBackend`, with
    the same public tokenizer library and file it loads, not by reaching into
    the backend's own state."""
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer

    tokenizer_path = hf_hub_download(repo_id=DENSE_EN.repo_id, filename=DENSE_EN.tokenizer_filename)
    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding(length=None)
    encodings = tokenizer.encode_batch(
        ["short", "a considerably longer piece of text than the other one in this batch"]
    )
    lengths = {len(e.ids) for e in encodings}
    assert len(lengths) == 1, "the batch was not padded to a common length"
    assert 0 in encodings[0].attention_mask, "the shorter sequence carries no padding to mask"


# --- ranking: ties and exclusion --------------------------------------------


def test_ties_break_by_chunk_id_ascending_not_by_row_order(en_backend: OnnxBackend) -> None:
    """Constructed, not asserted: two rows holding literally the same vector,
    stored in the array in the WRONG order for the expected answer. A
    tie-break that silently fell back to array position would return the
    first row and this would catch it."""
    vector = en_backend.encode(("a sentence used only to manufacture a tie",))[0]
    vectors = np.ascontiguousarray(np.stack([vector, vector]), dtype=np.float32)
    high_id = f"{SOURCE_TIE_HIGH}#0000"
    low_id = f"{SOURCE_TIE_LOW}#0000"
    index = SemanticIndex(
        IndexStatus.COMPLETE,
        en_backend.name,
        (high_id, low_id),  # the larger id occupies row 0, deliberately
        (SOURCE_TIE_HIGH, SOURCE_TIE_LOW),
        vectors,
        en_backend.checkpoint_digest,
        None,
        en_backend,
    )
    hits = index.search("anything at all", limit=2)
    assert hits[0].score == hits[1].score, "the constructed tie is not actually tied"
    assert [hit.chunk_id for hit in hits] == [low_id, high_id]
    assert [hit.rank for hit in hits] == [1, 2]


def test_exclude_sources_is_applied_before_the_limit_cut() -> None:
    index = _en_index()
    query = "ships and lighthouses along the coast during a storm"
    baseline = index.search(query, limit=3)
    assert len({hit.source_id for hit in baseline}) == 3, "the fixture must rank all three sources"

    excluded = baseline[0].source_id
    filtered = index.search(query, limit=2, exclude_sources=frozenset({excluded}))

    # If exclusion ran AFTER the top-2 cut, and the excluded source held the
    # top spot, only one candidate would remain in a 2-item slice. Getting two
    # back proves the excluded source never occupied a slot to begin with.
    assert len(filtered) == 2
    assert all(hit.source_id != excluded for hit in filtered)
    assert [hit.chunk_id for hit in filtered] == [hit.chunk_id for hit in baseline[1:3]]


def test_exclude_sources_actually_removes_chunks_when_fewer_remain() -> None:
    index = _en_index()
    excluded = frozenset({SOURCE_LIGHTHOUSE, SOURCE_BREAD})
    hits = index.search("anything", limit=10, exclude_sources=excluded)
    assert hits and all(hit.source_id == SOURCE_STORM for hit in hits)


def test_exclude_sources_must_be_a_frozenset() -> None:
    index = _en_index()
    with pytest.raises(SemanticError):
        index.search("anything", limit=1, exclude_sources={SOURCE_LIGHTHOUSE})  # type: ignore[arg-type]


def test_search_refusals() -> None:
    index = _en_index()
    with pytest.raises(SemanticError):
        index.search("", limit=1)
    with pytest.raises(SemanticError):
        index.search("   ", limit=1)
    for bad_limit in (0, -1, True, "3", None):
        with pytest.raises(SemanticError):
            index.search("anything", limit=bad_limit)  # type: ignore[arg-type]


def test_rank_is_one_based_and_contiguous() -> None:
    index = _en_index()
    hits = index.search("anything at all", limit=3)
    assert [hit.rank for hit in hits] == [1, 2, 3]


# --- state_digest and the equality it replaces ------------------------------


def test_state_digest_is_a_function_of_the_index_not_a_constant() -> None:
    a = build(_mixed_chunks(), DENSE_EN)
    reworded_storm = STORM_TEXT + " An extra sentence changes what this chunk actually says."
    b = build(
        chunk_document(SOURCE_LIGHTHOUSE, LIGHTHOUSE_TEXT)
        + chunk_document(SOURCE_BREAD, BREAD_TEXT)
        + chunk_document(SOURCE_STORM, reworded_storm),
        DENSE_EN,
    )
    assert a.state_digest() != b.state_digest()


def test_state_digest_agrees_for_two_builds_from_the_same_chunks() -> None:
    first = build(_mixed_chunks(), DENSE_EN).state_digest()
    second = build(_mixed_chunks(), DENSE_EN).state_digest()
    assert first == second


def test_state_digest_does_not_depend_on_input_order() -> None:
    """`build` sorts by chunk id internally; a caller handing chunks in a
    different order must still get the identical digest."""
    forward = build(_mixed_chunks(), DENSE_EN).state_digest()
    backward = build(tuple(reversed(_mixed_chunks())), DENSE_EN).state_digest()
    assert forward == backward


def test_equality_is_disabled_rather_than_raising_on_compare(en_backend: OnnxBackend) -> None:
    """A generated `__eq__` comparing a numpy-array field with `==` raises;
    this class turns that off rather than let a caller discover it at random."""
    a = build(_mixed_chunks(), DENSE_EN)
    b = build(_mixed_chunks(), DENSE_EN)
    assert (a == b) is False  # identity comparison, not a raised ValueError
    assert a == a


# --- determinism, across a fresh interpreter --------------------------------


def test_two_builds_in_this_process_agree_exactly() -> None:
    assert build(_mixed_chunks(), DENSE_EN).state_digest() == build(
        _mixed_chunks(), DENSE_EN
    ).state_digest()


def test_the_index_is_byte_identical_in_a_fresh_process() -> None:
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        f"sys.path.insert(0,{str(Path(__file__).parent)!r});"
        "from test_semantic import _mixed_chunks;"
        "from nous_os.semantic import DENSE_EN, build;"
        "print(build(_mixed_chunks(), DENSE_EN).state_digest())"
    )
    in_process = build(_mixed_chunks(), DENSE_EN).state_digest()
    observed = set()
    for seed in ("0", "3", "9"):
        environment = dict(
            os.environ, PYTHONHASHSEED=seed, TZ="Pacific/Kiritimati", LC_ALL="C", HF_HUB_OFFLINE="1"
        )
        result = subprocess.run(
            [sys.executable, "-c", program], capture_output=True, text=True,
            env=environment, check=True,
        )
        observed.add(result.stdout.strip())
    assert observed == {in_process}, f"digest varied across processes/seeds: {observed}"


def test_ranking_is_byte_identical_in_a_fresh_process() -> None:
    """Determinism of the vectors is necessary but not sufficient; the ranking
    a caller actually reads has to match too."""
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        f"sys.path.insert(0,{str(Path(__file__).parent)!r});"
        "from test_semantic import _mixed_chunks;"
        "from nous_os.semantic import DENSE_EN, build;"
        "hits = build(_mixed_chunks(), DENSE_EN).search('storms near the coast', limit=3);"
        "print(','.join(f'{h.chunk_id}:{h.score!r}:{h.rank}' for h in hits))"
    )
    index = build(_mixed_chunks(), DENSE_EN)
    in_process = index.search("storms near the coast", limit=3)
    in_process_line = ",".join(f"{h.chunk_id}:{h.score!r}:{h.rank}" for h in in_process)
    result = subprocess.run(
        [sys.executable, "-c", program], capture_output=True, text=True,
        env=dict(os.environ, HF_HUB_OFFLINE="1"), check=True,
    )
    assert result.stdout.strip() == in_process_line
