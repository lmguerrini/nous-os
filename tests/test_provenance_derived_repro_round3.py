"""Regression oracles for derived citations: stale text digests, citation binding in the derivation check, locator rules and linear grapheme runs."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from nous_os.extraction import ExtractionError, Extractor, extraction_record_digest
from nous_os.identity import digest_bytes
from nous_os.provenance import CharLocator, DerivationState, DerivedCitation, ProvenanceError, quote_lint_derived, verify_derivation
from tests.test_provenance_derived import _FIXTURE, _PLAIN_DIGEST, _PLAIN_SOURCE, _copy_fixture, _plain_citation


def _tamper_text_keep_text_digest(store_root: Path) -> str:
    path = next(p for p in (store_root / Extractor.PLAIN_TEXT.value).glob("*.json"))
    wrapper = json.loads(path.read_text(encoding="utf-8"))
    wrapper["record"]["text"] = "Tampered text that the extractor never produced."
    wrapper["record_digest"] = extraction_record_digest(wrapper["record"])
    path.write_text(json.dumps(wrapper, sort_keys=True, ensure_ascii=False), encoding="utf-8")
    return wrapper["record_digest"]


def test_b1_a_record_whose_text_digest_is_stale_is_corrupt_not_reproduced(tmp_path: Path) -> None:
    store, snapshots, ledger = _copy_fixture(tmp_path)
    new_record_digest = _tamper_text_keep_text_digest(tmp_path / "extraction-store")
    with pytest.raises(ExtractionError):
        store.get(Extractor.PLAIN_TEXT, _PLAIN_DIGEST)
    citation = DerivedCitation(
        asset_source_id=_PLAIN_SOURCE, asset_digest=_PLAIN_DIGEST, extractor=Extractor.PLAIN_TEXT,
        extractor_version="extraction/1", record_digest=new_record_digest, locator=CharLocator(0, 8), span="Tampered",
    )
    plain = (_FIXTURE / "extraction-source.txt").read_bytes()
    verdict = verify_derivation(lambda _source: plain, store, citation)
    assert verdict.state is not DerivationState.REPRODUCED, verdict


def test_m2_a_citation_naming_another_record_digest_or_version_is_not_reproduced(tmp_path: Path) -> None:
    store, _snapshots, _ledger = _copy_fixture(tmp_path)
    plain = (_FIXTURE / "extraction-source.txt").read_bytes()
    base = _plain_citation()
    other_digest = DerivedCitation(
        asset_source_id=base.asset_source_id, asset_digest=base.asset_digest, extractor=base.extractor,
        extractor_version=base.extractor_version, record_digest="0" * 64, locator=base.locator, span=base.span,
    )
    verdict = verify_derivation(lambda _source: plain, store, other_digest)
    assert verdict.state is not DerivationState.REPRODUCED, verdict
    other_version = DerivedCitation(
        asset_source_id=base.asset_source_id, asset_digest=base.asset_digest, extractor=base.extractor,
        extractor_version="extraction/9", record_digest=base.record_digest, locator=base.locator, span=base.span,
    )
    verdict = verify_derivation(lambda _source: plain, store, other_version)
    assert verdict.state is not DerivationState.REPRODUCED, verdict


def test_m3_diverged_reason_names_the_asset_digest_figures(tmp_path: Path) -> None:
    store, _snapshots, _ledger = _copy_fixture(tmp_path)
    changed = verify_derivation(lambda _source: b"changed", store, _plain_citation())
    assert changed.state is DerivationState.DIVERGED
    assert digest_bytes(b"changed") in changed.reason and _PLAIN_DIGEST in changed.reason, changed.reason


@pytest.mark.parametrize(("start", "end"), ((0, 0), (4, 4)))
def test_m3_an_empty_locator_is_refused(start: int, end: int) -> None:
    with pytest.raises(ProvenanceError):
        CharLocator(start, end)


@pytest.mark.parametrize(("start", "end"), ((False, 4), (0, True)))
def test_m3_boolean_offsets_are_refused(start: object, end: object) -> None:
    with pytest.raises(ProvenanceError):
        CharLocator(start, end)  # type: ignore[arg-type]


def test_m1_regional_indicator_runs_are_linear(tmp_path: Path) -> None:
    from nous_os.provenance import _grapheme_boundaries

    text = "\U0001F1EE\U0001F1F9" * 4000  # 8,000 regional indicators = 4,000 flags
    started = time.perf_counter()
    boundaries = _grapheme_boundaries(text)
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, elapsed
    assert 1 not in boundaries and 2 in boundaries


def test_m3_lint_refuses_a_citation_whose_record_digest_differs_from_the_consistent_store(tmp_path: Path) -> None:
    from nous_os.provenance import DerivedRecordCorrupt

    store, snapshots, ledger = _copy_fixture(tmp_path)
    base = _plain_citation()
    other = DerivedCitation(
        asset_source_id=base.asset_source_id, asset_digest=base.asset_digest, extractor=base.extractor,
        extractor_version=base.extractor_version, record_digest="0" * 64, locator=base.locator, span=base.span,
    )
    with pytest.raises(DerivedRecordCorrupt):
        quote_lint_derived(store, snapshots, ledger, other)
