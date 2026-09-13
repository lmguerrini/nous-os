"""Oracles for citations into preserved attachment extraction text."""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nous_os import cli, core, mcp
from nous_os.capability import Grant, Tier
from nous_os.candidates import CandidateStore
from nous_os.extraction import (
    ExtractionOutcome,
    ExtractionStore,
    Extractor,
    deduplicate_extractions,
    extract_bytes,
    extraction_record_digest,
)
from nous_os.identity import canonical_bytes, digest_bytes
from nous_os.ledger import Ledger, LedgerEntry
from nous_os.provenance import (
    CharLocator,
    DerivationState,
    DerivedAssetMismatch,
    DerivedCitation,
    DerivedOwnerMismatch,
    DerivedRecordCorrupt,
    DerivedRecordNotFound,
    DerivedVersionMismatch,
    LocatorOutOfRange,
    LocatorSplitsGrapheme,
    ProvenanceError,
    SpanMismatch,
    quote_lint_derived,
    verify_derivation,
)
from nous_os.review import ReviewCandidate, apply
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText


_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE = _ROOT / "fixtures" / "synthetic"
_PLAIN_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_NOTEBOOK_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"
_PLAIN_DIGEST = "6dc87d4980b6879c52c8f673f64bebaecb28addfefcae568c72855b63089af77"
_NOTEBOOK_DIGEST = "bfd35bf6bfe13bde346bfbfbd27fb158e5d291a0a2413e689f1daa579137efc9"
_WHEN = datetime(2026, 1, 2, tzinfo=timezone.utc)


def _copy_fixture(tmp_path: Path) -> tuple[ExtractionStore, SnapshotStore, Ledger]:
    store_root = tmp_path / "extraction-store"
    snapshot_root = tmp_path / "snapshots"
    shutil.copytree(_FIXTURE / "extraction-store", store_root)
    shutil.copytree(_FIXTURE / "extraction-snapshots", snapshot_root)
    ledger_path = tmp_path / "ledger.jsonl"
    shutil.copyfile(_FIXTURE / "extraction-ledger.jsonl", ledger_path)
    return ExtractionStore(store_root), SnapshotStore(snapshot_root), Ledger(ledger_path)


def _plain_citation() -> DerivedCitation:
    return DerivedCitation(
        asset_source_id=_PLAIN_SOURCE,
        asset_digest=_PLAIN_DIGEST,
        extractor=Extractor.PLAIN_TEXT,
        extractor_version="extraction/1",
        record_digest="964163f80959d234933526f2b87cd4b01993584d13bdc20ab371377936122115",
        locator=CharLocator(0, 4),
        span="Quay",
    )


def _notebook_citation() -> DerivedCitation:
    return DerivedCitation(
        asset_source_id=_NOTEBOOK_SOURCE,
        asset_digest=_NOTEBOOK_DIGEST,
        extractor=Extractor.NOTEBOOK_CELLS,
        extractor_version="extraction/1",
        record_digest="4b917ecd458e6d314035b75537b16002bee1e1d87dbf5be36e1270e6ba94f81b",
        locator=CharLocator(0, 8),
        span="Notebook",
    )


def _write_latest_metadata(
    snapshots: SnapshotStore, ledger: Ledger, source_id: str, asset_digest: str
) -> None:
    snapshot = snapshots.put(source_id, canonical_bytes({"payload": {"digest": asset_digest}}))
    previous = ledger.current_digest(source_id)
    ledger.append(LedgerEntry(source_id, snapshot.digest, previous, _WHEN))


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("asset_source_id", _PLAIN_SOURCE),
        ("asset_digest", _PLAIN_DIGEST),
        ("extractor_version", "extraction/1"),
        ("record_digest", "964163f80959d234933526f2b87cd4b01993584d13bdc20ab371377936122115"),
        ("span", "Quay"),
    ),
)
def test_o1_derived_citation_refuses_string_subclasses(field: str, value: str) -> None:
    class ForgedString(str):
        def __str__(self) -> str:
            return "not-a-source-id"

    with pytest.raises(ProvenanceError):
        replace(_plain_citation(), **{field: ForgedString(value)})


def test_o2_derived_lint_refuses_unreadable_ledger_without_a_lock_file(tmp_path: Path) -> None:
    store, snapshots, ledger = _copy_fixture(tmp_path)
    ledger.path.write_text(
        json.dumps(
            {
                "source_id": _PLAIN_SOURCE,
                "snapshot_digest": "6dabd49c082dc2b9ee52c02d69366108118d5978470e4aef44a2f832436c88cd",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ProvenanceError) as raised:
        quote_lint_derived(store, snapshots, ledger, _plain_citation())

    assert type(raised.value).__name__ == "DerivedLedgerUnreadable"
    assert not ledger.path.with_name(ledger.path.name + ".lock").exists()


def test_o1_derived_round_trip_and_reference_writer_fixture(tmp_path: Path) -> None:
    plain = (_FIXTURE / "extraction-source.txt").read_bytes()
    notebook = (_FIXTURE / "extraction-notebook.ipynb").read_bytes()
    expected = (
        (plain, _PLAIN_SOURCE, "quay.txt"),
        (notebook, _NOTEBOOK_SOURCE, "notebook.ipynb"),
    )
    written = ExtractionStore(tmp_path / "written")
    for data, source_id, given_name in expected:
        shared = deduplicate_extractions(
            (extract_bytes(data, source_id, given_name=given_name),)
        )[0]
        assert extraction_record_digest(shared.extraction.content_payload()) == shared.extraction.record_digest
        written.write(shared)
    fixture_files = sorted(path.relative_to(_FIXTURE / "extraction-store") for path in (_FIXTURE / "extraction-store").rglob("*.json"))
    assert [path.relative_to(tmp_path / "written") for path in sorted((tmp_path / "written").rglob("*.json"))] == fixture_files
    for relative in fixture_files:
        assert (tmp_path / "written" / relative).read_bytes() == (_FIXTURE / "extraction-store" / relative).read_bytes()


def test_o2_every_derived_lint_failure_is_named(tmp_path: Path) -> None:
    store, snapshots, ledger = _copy_fixture(tmp_path)
    citation = _plain_citation()
    assert quote_lint_derived(store, snapshots, ledger, citation) is None

    with pytest.raises(DerivedRecordNotFound):
        quote_lint_derived(ExtractionStore(tmp_path / "absent"), snapshots, ledger, citation)

    corrupt_path = tmp_path / "extraction-store" / "plain_text" / f"{_PLAIN_DIGEST}.json"
    corrupt = json.loads(corrupt_path.read_text(encoding="utf-8"))
    corrupt["record_digest"] = "0" * 64
    corrupt_path.write_bytes(canonical_bytes(corrupt) + b"\n")
    with pytest.raises(DerivedRecordCorrupt):
        quote_lint_derived(store, snapshots, ledger, citation)

    store, snapshots, ledger = _copy_fixture(tmp_path / "version")
    with pytest.raises(DerivedVersionMismatch):
        quote_lint_derived(store, snapshots, ledger, replace(citation, extractor_version="other"))
    with pytest.raises(DerivedOwnerMismatch):
        quote_lint_derived(store, snapshots, ledger, replace(citation, asset_source_id=_NOTEBOOK_SOURCE))
    with pytest.raises(LocatorOutOfRange):
        quote_lint_derived(store, snapshots, ledger, replace(citation, locator=CharLocator(0, 99)))
    with pytest.raises(SpanMismatch):
        quote_lint_derived(store, snapshots, ledger, replace(citation, span="other"))

    _write_latest_metadata(snapshots, ledger, _PLAIN_SOURCE, "0" * 64)
    with pytest.raises(DerivedAssetMismatch):
        quote_lint_derived(store, snapshots, ledger, citation)

    grapheme_source = _PLAIN_SOURCE
    grapheme_bytes = "Cafe\u0301".encode("utf-8")
    grapheme_shared = deduplicate_extractions(
        (extract_bytes(grapheme_bytes, grapheme_source, given_name="grapheme.txt"),)
    )[0]
    grapheme_store = ExtractionStore(tmp_path / "grapheme-store")
    grapheme_store.write(grapheme_shared)
    grapheme_snapshots = SnapshotStore(tmp_path / "grapheme-snapshots")
    grapheme_ledger = Ledger(tmp_path / "grapheme-ledger.jsonl")
    assert grapheme_shared.asset_digest is not None
    _write_latest_metadata(
        grapheme_snapshots, grapheme_ledger, grapheme_source, grapheme_shared.asset_digest
    )
    with pytest.raises(LocatorSplitsGrapheme):
        quote_lint_derived(
            grapheme_store,
            grapheme_snapshots,
            grapheme_ledger,
            DerivedCitation(
                asset_source_id=grapheme_source,
                asset_digest=grapheme_shared.asset_digest,
                extractor=grapheme_shared.extraction.extractor,
                extractor_version=grapheme_shared.extraction.extractor_version,
                record_digest=grapheme_shared.extraction.record_digest,
                locator=CharLocator(0, 4),
                span="Cafe",
            ),
        )


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
def test_o2_derived_lint_refuses_each_extended_grapheme_boundary(
    tmp_path: Path, shape: str, text: str
) -> None:
    """Both sides of every listed extended-grapheme split are invalid."""
    source_id = _PLAIN_SOURCE
    shared = deduplicate_extractions(
        (extract_bytes(text.encode("utf-8"), source_id, given_name=f"{shape}.txt"),)
    )[0]
    store = ExtractionStore(tmp_path / "store")
    store.write(shared)
    snapshots = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    assert shared.asset_digest is not None
    _write_latest_metadata(snapshots, ledger, source_id, shared.asset_digest)

    split_char = 2
    for start_char, end_char in ((1, split_char), (split_char, len(text) - 1)):
        with pytest.raises(LocatorSplitsGrapheme):
            quote_lint_derived(
                store,
                snapshots,
                ledger,
                DerivedCitation(
                    asset_source_id=source_id,
                    asset_digest=shared.asset_digest,
                    extractor=shared.extraction.extractor,
                    extractor_version=shared.extraction.extractor_version,
                    record_digest=shared.extraction.record_digest,
                    locator=CharLocator(start_char, end_char),
                    span=text[start_char:end_char],
                ),
            )


def test_o3_derivation_reproduces_diverges_and_reports_nonexecution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _snapshots, _ledger = _copy_fixture(tmp_path)
    plain = (_FIXTURE / "extraction-source.txt").read_bytes()
    notebook = (_FIXTURE / "extraction-notebook.ipynb").read_bytes()
    supplied = {_PLAIN_SOURCE: plain, _NOTEBOOK_SOURCE: notebook}
    assert verify_derivation(supplied.get, store, _plain_citation()).state is DerivationState.REPRODUCED
    assert verify_derivation(supplied.get, store, _notebook_citation()).state is DerivationState.REPRODUCED
    changed = verify_derivation(lambda _source: b"changed", store, _plain_citation())
    assert changed.state is DerivationState.DIVERGED
    assert changed.observed_asset_digest == digest_bytes(b"changed")
    assert verify_derivation(lambda _source: None, store, _plain_citation()).state is DerivationState.NOT_EXECUTABLE

    import nous_os.extraction as extraction_module

    original = extraction_module.extract_bytes

    def different_version(data: bytes, **kwargs: object):
        return replace(original(data, **kwargs), extractor_version="other")

    monkeypatch.setattr(extraction_module, "extract_bytes", different_version)
    version = verify_derivation(supplied.get, store, _plain_citation())
    assert version.state is DerivationState.NOT_EXECUTABLE
    assert "extractor version differs" in version.reason


def test_o3_derivation_does_not_reproduce_a_still_unavailable_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Equal empty text is not evidence that an unavailable tool reproduced."""
    import nous_os.extraction as extraction_module

    monkeypatch.setattr(extraction_module, "_pdftext_path", lambda: None)
    data = b"%PDF-1.4\n"
    shared = deduplicate_extractions(
        (extract_bytes(data, _PLAIN_SOURCE, given_name="attachment.pdf"),)
    )[0]
    assert shared.extraction.outcome is ExtractionOutcome.TOOL_UNAVAILABLE
    assert shared.asset_digest is not None
    store = ExtractionStore(tmp_path / "store")
    store.write(shared)
    citation = DerivedCitation(
        asset_source_id=_PLAIN_SOURCE,
        asset_digest=shared.asset_digest,
        extractor=shared.extraction.extractor,
        extractor_version=shared.extraction.extractor_version,
        record_digest=shared.extraction.record_digest,
        locator=CharLocator(0, 1),
        span="x",
    )

    verdict = verify_derivation(lambda _source: data, store, citation)

    assert verdict.state is DerivationState.NOT_EXECUTABLE
    assert citation.extractor.value in verdict.reason


def test_o3_derivation_reports_mismatched_outcomes_and_both_text_digests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _snapshots, _ledger = _copy_fixture(tmp_path)
    data = (_FIXTURE / "extraction-source.txt").read_bytes()
    stored = store.get(Extractor.PLAIN_TEXT, _PLAIN_DIGEST)
    recorded_text_digest = stored.payload["text_digest"]
    assert isinstance(recorded_text_digest, str)

    import nous_os.extraction as extraction_module

    original = extraction_module.extract_bytes

    def unreadable(data: bytes, **kwargs: object):
        return replace(original(data, **kwargs), outcome=ExtractionOutcome.UNREADABLE)

    monkeypatch.setattr(extraction_module, "extract_bytes", unreadable)
    mismatch = verify_derivation(lambda _source: data, store, _plain_citation())
    assert mismatch.state is DerivationState.DIVERGED
    assert "extracted" in mismatch.reason
    assert "unreadable" in mismatch.reason

    def changed_text(data: bytes, **kwargs: object):
        text = "changed"
        return replace(
            original(data, **kwargs),
            text=text,
            text_digest=digest_bytes(text.encode("utf-8")),
            locations=(),
        )

    monkeypatch.setattr(extraction_module, "extract_bytes", changed_text)
    divergence = verify_derivation(lambda _source: data, store, _plain_citation())
    assert divergence.state is DerivationState.DIVERGED
    assert divergence.observed_text_digest is not None
    assert recorded_text_digest in divergence.reason
    assert divergence.observed_text_digest in divergence.reason


def _candidate_content(derived: DerivedCitation) -> dict[str, object]:
    metadata = canonical_bytes({"payload": {"digest": _PLAIN_DIGEST}}).decode("utf-8")
    return {
        "statement": "The quay signal is amber.",
        "kind": "DECISION",
        "scope": "quay.signal",
        "origin": "USER_AUTHORED",
        "support": "direct_quote",
        "citations": [{
            "source_id": _PLAIN_SOURCE,
            "snapshot_digest": "6dabd49c082dc2b9ee52c02d69366108118d5978470e4aef44a2f832436c88cd",
            "start_byte": 0,
            "end_byte": 10,
            "span": metadata[:10],
        }],
        "counter_citations": [],
        "derived_citations": [derived.as_payload()],
        "derived_counter_citations": [],
        "valid_from": None,
        "valid_to": None,
        "why": "Fixture evidence is explicit.",
        "producer": "fixture/1",
        "batch": "fixture",
        "supersedes": None,
    }


def _decision(candidate: ReviewCandidate, minute: int) -> bytes:
    return canonical_bytes({
        "candidate_id": candidate.proposal.proposal_id,
        "version": candidate.version,
        "verdict": "approve",
        "scope": candidate.scope,
        "reason": "The evidence was reviewed.",
        "decided_at": f"2026-01-03T12:{minute:02d}:00+00:00",
        "decider": "reviewer",
    }) + b"\n"


def test_o4_review_refuses_bad_derived_citation_before_canon_and_promotes_good_one(
    tmp_path: Path,
) -> None:
    store, snapshots, ledger = _copy_fixture(tmp_path)
    del store
    data_root = tmp_path / "documents"
    data_root.mkdir()
    candidates = CandidateStore(tmp_path / "candidates.jsonl")
    bad = candidates.record(
        source_id=_PLAIN_SOURCE,
        content=UntrustedText(json.dumps(_candidate_content(replace(_plain_citation(), span="wrong")))),
        proposed_at=_WHEN,
        holder="reviewer",
    )
    bad_candidate = ReviewCandidate.from_proposal(bad)
    decisions = tmp_path / "bad-decisions.jsonl"
    decisions.write_bytes(_decision(bad_candidate, 0))
    canon_root = tmp_path / "canon"
    audit = tmp_path / "audit.jsonl"
    result = apply(
        decisions_path=decisions,
        data_root=data_root,
        candidate_store_path=candidates._path,
        snapshot_root=snapshots._root,
        extraction_store_path=tmp_path / "extraction-store",
        ledger_path=ledger.path,
        authorizations_path=tmp_path / "authorizations.jsonl",
        canon_root=canon_root,
        audit_log=audit,
        grant=Grant("reviewer", frozenset({Tier.PROMOTE})),
    )
    assert result[-1].outcome == "DERIVED_CITATION_FAILED"
    assert result[-1].refusal_reason == "SpanMismatch"
    assert not canon_root.exists()

    good = candidates.record(
        source_id=_PLAIN_SOURCE,
        content=UntrustedText(json.dumps(_candidate_content(_plain_citation()))),
        proposed_at=_WHEN,
        holder="reviewer",
    )
    good_candidate = ReviewCandidate.from_proposal(good)
    good_decisions = tmp_path / "good-decisions.jsonl"
    good_decisions.write_bytes(_decision(good_candidate, 1))
    result = apply(
        decisions_path=good_decisions,
        data_root=data_root,
        candidate_store_path=candidates._path,
        snapshot_root=snapshots._root,
        extraction_store_path=tmp_path / "extraction-store",
        ledger_path=ledger.path,
        authorizations_path=tmp_path / "authorizations.jsonl",
        canon_root=canon_root,
        audit_log=audit,
        grant=Grant("reviewer", frozenset({Tier.PROMOTE})),
    )
    assert result[-1].outcome == "APPLIED"
    promoted = json.loads(next((canon_root / "assertions").rglob("*.json")).read_text(encoding="utf-8"))
    assert promoted["derived_citations"] == [_plain_citation().as_payload()]
    assert promoted["derived_counter_citations"] == []


def test_o5_lint_and_verification_leave_stores_byte_identical(tmp_path: Path) -> None:
    store, snapshots, ledger = _copy_fixture(tmp_path)
    before = tuple(
        (path.relative_to(tmp_path).as_posix(), path.read_bytes())
        for path in sorted(path for path in tmp_path.rglob("*") if path.is_file())
    )
    quote_lint_derived(store, snapshots, ledger, _plain_citation())
    verify_derivation(lambda _source: (_FIXTURE / "extraction-source.txt").read_bytes(), store, _plain_citation())
    after = tuple(
        (path.relative_to(tmp_path).as_posix(), path.read_bytes())
        for path in sorted(path for path in tmp_path.rglob("*") if path.is_file())
    )
    assert after == before


def test_o6_catalogue_cli_and_stdio_agree_for_derived_verification(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _store, snapshots, ledger = _copy_fixture(tmp_path)
    data_root = tmp_path / "documents"
    data_root.mkdir()
    workspace = core.resolve_workspace(
        data_root=data_root,
        snapshot_root=snapshots._root,
        ledger_path=ledger.path,
        derived_path=tmp_path / "derived.sqlite",
        candidate_store_path=tmp_path / "candidates.jsonl",
        bridge_registry_path=tmp_path / "bridges.jsonl",
        rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl",
        extraction_store_path=tmp_path / "extraction-store",
    )
    citation = _plain_citation().as_payload()
    arguments = {"citation": citation, "full": True}
    grant = Grant("reader", frozenset({Tier.READ}))
    expected = core.invoke(grant, "provenance.verify_derived", workspace, arguments)
    assert expected["ok"] is True

    argv = [
        "--data-root", str(data_root),
        "--snapshot-root", str(snapshots._root),
        "--ledger-path", str(ledger.path),
        "--derived-path", str(tmp_path / "derived.sqlite"),
        "--candidate-store-path", str(tmp_path / "candidates.jsonl"),
        "--bridge-registry-path", str(tmp_path / "bridges.jsonl"),
        "--rejection-memory-path", str(tmp_path / "rejections.jsonl"),
        "--relation-store-path", str(tmp_path / "relations.jsonl"),
        "--extraction-store-path", str(tmp_path / "extraction-store"),
        "provenance.verify_derived",
        "--citation", json.dumps(citation),
        "--full",
    ]
    assert cli.main(argv) == 0
    cli_result = json.loads(capsys.readouterr().out)
    response = mcp.dispatch(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "provenance.verify_derived", "arguments": arguments},
        },
        grant,
        workspace,
    )
    assert response is not None
    stdio_result = json.loads(response["result"]["content"][0]["text"])
    assert cli_result == stdio_result == expected
