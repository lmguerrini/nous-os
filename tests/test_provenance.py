"""G-PROV: citations resolve exact bytes and quote-lint preserves failure reasons."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.provenance import (
    Citation,
    Locator,
    LocatorOutOfRange,
    LocatorSplitsCharacter,
    LocatorSplitsGrapheme,
    SnapshotNotText,
    SpanMismatch,
    quote_lint,
    read_span,
    resolves,
)
from nous_os.snapshots import SnapshotNotFound, SnapshotStore


SYNTHETIC_FIXTURE: dict[str, object] = {
    "source_id": "src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "snapshots": [
        "Harbour marker: blue.\nCafé bell: noon.\n",
        "Harbour marker: green.\nCafé bell: noon.\n",
    ],
    "assertions": [
        {
            "id": "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "text": "The harbour marker is blue.",
            "snapshot": 0,
            "start_byte": 16,
            "end_byte": 20,
            "span": "blue",
        },
        {
            "id": "asr_01ARZ3NDEKTSV4RRFFQ69G5FB0",
            "text": "The café bell is at noon.",
            "snapshot": 0,
            "start_byte": 22,
            "end_byte": 27,
            "span": "Café",
        },
    ],
}


def _fixture_store(tmp_path: Path) -> tuple[SnapshotStore, dict[str, object], list[object]]:
    fixture = SYNTHETIC_FIXTURE
    store = SnapshotStore(tmp_path)
    source_id = fixture["source_id"]
    assert isinstance(source_id, str)
    snapshots = fixture["snapshots"]
    assert isinstance(snapshots, list)
    stored = [store.put(source_id, text.encode("utf-8")) for text in snapshots]
    return store, fixture, stored


def _citation(
    digest: str,
    start: int,
    end: int,
    span: str,
    source_id: str = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
) -> Citation:
    return Citation(
        source_id=source_id,
        snapshot_digest=digest,
        locator=Locator(start, end),
        span=span,
    )


def test_p6_every_fixture_assertion_resolves_its_cited_snapshot_bytes(tmp_path: Path) -> None:
    store, fixture, snapshots = _fixture_store(tmp_path)
    assertions = fixture["assertions"]
    assert isinstance(assertions, list) and assertions, "fixture assertions guard against empty coverage"

    for assertion in assertions:
        assert isinstance(assertion, dict)
        snapshot_index = assertion["snapshot"]
        assert isinstance(snapshot_index, int)
        snapshot = snapshots[snapshot_index]
        source_id = fixture["source_id"]
        assert isinstance(source_id, str)
        start_byte = assertion["start_byte"]
        end_byte = assertion["end_byte"]
        span = assertion["span"]
        assert isinstance(start_byte, int)
        assert isinstance(end_byte, int)
        assert isinstance(span, str)
        citation = _citation(
            snapshot.digest,
            start_byte,
            end_byte,
            span,
            source_id,
        )
        assertion_id = assertion["id"]
        text = assertion["text"]
        assert isinstance(assertion_id, str)
        assert isinstance(text, str)
        record = Assertion(
            id=assertion_id,
            text=text,
            citation=citation,
            support=SupportClass.DIRECT_QUOTE,
            recorded_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            state=LifecycleState.CANDIDATE,
        )
        assert read_span(store, record.citation) == span
        assert quote_lint(store, record.citation) is None


def test_p7_a_corrupted_span_is_refused_as_a_span_mismatch(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"marker: blue")

    with pytest.raises(SpanMismatch):
        quote_lint(store, _citation(snapshot.digest, 8, 12, "green"))


def test_p7_shifted_offsets_are_refused_as_a_span_mismatch(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"marker: blue")

    with pytest.raises(SpanMismatch):
        quote_lint(store, _citation(snapshot.digest, 0, 6, "blue"))


def test_p7_offsets_past_the_snapshot_are_refused_as_out_of_range(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"short")

    with pytest.raises(LocatorOutOfRange):
        quote_lint(store, _citation(snapshot.digest, 0, 99, "short"))


def test_p7_an_absent_snapshot_is_refused_as_snapshot_not_found(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)

    with pytest.raises(SnapshotNotFound):
        quote_lint(store, _citation("f" * 64, 0, 4, "lost"))


def test_p7_offsets_inside_a_multibyte_character_are_refused_as_a_split_character(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path)
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", "Café".encode("utf-8"))

    with pytest.raises(LocatorSplitsCharacter):
        quote_lint(store, _citation(snapshot.digest, 0, 4, "Caf"))


@pytest.mark.parametrize(
    ("shape", "text"),
    (
        ("zwj", "A👩‍💻B"),
        ("variation_selector", "A✈️B"),
        ("combining_nonspacing_mark", "Ae\u0301B"),
        ("combining_spacing_mark", "Aक\u093eB"),
        ("combining_enclosing_mark", "Ae\u20ddB"),
        ("regional_indicator_pair", "A🇮🇹B"),
        ("emoji_modifier", "A👍🏽B"),
    ),
)
def test_p7_snapshot_lint_refuses_each_extended_grapheme_boundary(
    tmp_path: Path, shape: str, text: str
) -> None:
    """Both sides of every listed extended-grapheme split are invalid."""
    store = SnapshotStore(tmp_path)
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", text.encode("utf-8"))
    split_char = 2
    for start_char, end_char in ((1, split_char), (split_char, len(text) - 1)):
        start_byte = len(text[:start_char].encode("utf-8"))
        end_byte = len(text[:end_char].encode("utf-8"))
        with pytest.raises(LocatorSplitsGrapheme):
            read_span(
                store,
                _citation(snapshot.digest, start_byte, end_byte, text[start_char:end_char]),
            )


def test_p8_a_quote_valid_for_one_snapshot_fails_for_changed_later_bytes(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path)
    earlier = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"marker: blue")
    later = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"marker: green")
    old_citation = _citation(earlier.digest, 8, 12, "blue")
    later_citation = _citation(later.digest, 8, 12, "blue")

    assert quote_lint(store, old_citation) is None
    with pytest.raises(SpanMismatch):
        quote_lint(store, later_citation)


def test_a_valid_cited_range_over_an_invalid_tail_raises_snapshotnottext(
    tmp_path: Path,
) -> None:
    """A byte the citation never claims must not surface as an undeclared crash."""
    store = SnapshotStore(tmp_path)
    span = "the claim holds"
    data = span.encode("utf-8") + b"\xff\xfe tail"
    snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", data)
    citation = _citation(snapshot.digest, 0, len(span.encode("utf-8")), span)

    with pytest.raises(SnapshotNotText):
        read_span(store, citation)


def test_resolves_over_a_mixed_batch_counts_instead_of_aborting(tmp_path: Path) -> None:
    """One non-text snapshot in a batch must not abort the count over the rest."""
    store = SnapshotStore(tmp_path)
    good_snapshot = store.put("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", b"marker: blue")
    good_citation = _citation(good_snapshot.digest, 8, 12, "blue")

    span = "the claim holds"
    bad_source_id = "src_01BRZ3NDEKTSV4RRFFQ69G5FAV"
    bad_data = span.encode("utf-8") + b"\xff\xfe tail"
    bad_snapshot = store.put(bad_source_id, bad_data)
    bad_citation = _citation(
        bad_snapshot.digest, 0, len(span.encode("utf-8")), span, bad_source_id
    )

    assert resolves(store, good_citation) is True
    assert resolves(store, bad_citation) is False
