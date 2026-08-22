"""Proposal records preserve typed content and exact append-only bytes."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

import pytest

import nous_os.candidates as candidate_bindings
from nous_os.candidates import CandidateError, CandidateStore, Proposal
from nous_os.identity import canonical_bytes
from nous_os.untrusted import UntrustedText


_PROPOSAL_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_PROPOSED_AT = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)


def _proposal(
    *,
    content: object = UntrustedText("candidate text"),
    proposed_at: datetime = _PROPOSED_AT,
    proposal_id: str = _PROPOSAL_ID,
    source_id: str = _SOURCE_ID,
    holder: str = "reviewer",
) -> Proposal:
    """Construct through the public record type with deliberately broad inputs."""
    return Proposal(
        proposal_id=proposal_id,
        source_id=source_id,
        content=content,  # type: ignore[arg-type]
        proposed_at=proposed_at,
        holder=holder,
    )


def _fail_if_proposal_is_constructed(**kwargs: object) -> NoReturn:
    """Expose a missing store guard before the record constructor can help it."""
    pytest.fail(f"the store reached proposal construction with {sorted(kwargs)!r}")


def test_a_bare_string_is_refused_by_both_content_guards(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting either content guard would admit or forward an ordinary string."""
    with pytest.raises(CandidateError, match="UntrustedText"):
        _proposal(content="ordinary string")

    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="UntrustedText"):
        store.record(
            source_id=_SOURCE_ID,
            content="ordinary string",  # type: ignore[arg-type]
            proposed_at=_PROPOSED_AT,
            holder="reviewer",
        )


def test_an_untrusted_text_subclass_is_refused_by_both_content_guards(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replacing either exact-type check with isinstance would admit a subtype."""

    def allow_test_subclass(
        cls: type[UntrustedText],
        **kwargs: object,
    ) -> None:
        del cls, kwargs

    monkeypatch.setattr(
        UntrustedText,
        "__init_subclass__",
        classmethod(allow_test_subclass),
    )

    class DerivedUntrustedText(UntrustedText):
        pass

    content = DerivedUntrustedText("derived candidate text")
    with pytest.raises(CandidateError, match="UntrustedText"):
        _proposal(content=content)

    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="UntrustedText"):
        store.record(
            source_id=_SOURCE_ID,
            content=content,
            proposed_at=_PROPOSED_AT,
            holder="reviewer",
        )


def test_the_store_refuses_a_non_string_source_identifier_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting the store source guard would reach the replaced constructor."""
    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="source_id must be a string"):
        store.record(
            source_id=object(),  # type: ignore[arg-type]
            content=UntrustedText("candidate text"),
            proposed_at=_PROPOSED_AT,
            holder="reviewer",
        )


def test_the_store_refuses_a_non_datetime_instant_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting the store instant guard would reach the replaced constructor."""
    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="proposed_at must be a datetime"):
        store.record(
            source_id=_SOURCE_ID,
            content=UntrustedText("candidate text"),
            proposed_at=object(),  # type: ignore[arg-type]
            holder="reviewer",
        )


def test_the_store_refuses_a_non_string_holder_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting the store holder guard would reach the replaced constructor."""
    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="proposal holder must be a string"):
        store.record(
            source_id=_SOURCE_ID,
            content=UntrustedText("candidate text"),
            proposed_at=_PROPOSED_AT,
            holder=object(),  # type: ignore[arg-type]
        )


def test_the_store_refuses_a_string_subclass_source_identifier_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replacing the store's source exact-type check would reach construction."""

    class DerivedString(str):
        pass

    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="source_id must be a string"):
        store.record(
            source_id=DerivedString(_SOURCE_ID),
            content=UntrustedText("candidate text"),
            proposed_at=_PROPOSED_AT,
            holder="reviewer",
        )


def test_the_store_refuses_a_datetime_subclass_instant_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replacing the store's instant exact-type check would reach construction."""

    class DerivedDatetime(datetime):
        pass

    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    proposed_at = DerivedDatetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
    with pytest.raises(CandidateError, match="proposed_at must be a datetime"):
        store.record(
            source_id=_SOURCE_ID,
            content=UntrustedText("candidate text"),
            proposed_at=proposed_at,
            holder="reviewer",
        )


def test_the_store_refuses_a_string_subclass_holder_before_constructing_a_proposal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replacing the store's holder exact-type check would reach construction."""

    class DerivedString(str):
        pass

    monkeypatch.setattr(
        candidate_bindings,
        "Proposal",
        _fail_if_proposal_is_constructed,
    )
    store = CandidateStore(tmp_path / "candidates.jsonl")
    with pytest.raises(CandidateError, match="proposal holder must be a string"):
        store.record(
            source_id=_SOURCE_ID,
            content=UntrustedText("candidate text"),
            proposed_at=_PROPOSED_AT,
            holder=DerivedString("reviewer"),
        )


def test_the_record_model_refuses_a_string_subclass_source_identifier() -> None:
    """Replacing the identifier exact-type check with isinstance admits a subtype."""

    class DerivedString(str):
        pass

    with pytest.raises(CandidateError, match="source_id must be a string"):
        _proposal(source_id=DerivedString(_SOURCE_ID))


def test_the_record_model_refuses_a_datetime_subclass_instant() -> None:
    """Replacing the instant exact-type check with isinstance admits a subtype."""

    class DerivedDatetime(datetime):
        pass

    proposed_at = DerivedDatetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
    with pytest.raises(CandidateError, match="proposed_at must be a datetime"):
        _proposal(proposed_at=proposed_at)


def test_the_record_model_refuses_a_string_subclass_holder() -> None:
    """Replacing the holder exact-type check with isinstance admits a subtype."""

    class DerivedString(str):
        pass

    with pytest.raises(CandidateError, match="non-blank"):
        _proposal(holder=DerivedString("reviewer"))


def test_a_naive_proposal_datetime_is_refused() -> None:
    """Deleting timezone validation would make a local wall time a valid instant."""
    with pytest.raises(CandidateError, match="timezone"):
        _proposal(proposed_at=datetime(2026, 1, 2, 12, 0))


def test_an_invalid_proposal_identifier_is_refused() -> None:
    """Deleting identifier validation would admit an id outside the vocabulary."""
    with pytest.raises(CandidateError, match="identifiers are not valid"):
        _proposal(proposal_id="not_an_assertion_identifier")


def test_a_blank_proposal_holder_is_refused() -> None:
    """Deleting the blank-holder guard would erase useful proposal provenance."""
    with pytest.raises(CandidateError, match="non-blank"):
        _proposal(holder=" \t")


def test_proposals_are_read_back_in_file_order(tmp_path: Path) -> None:
    """Reversing collected records would rewrite append order during read-back."""
    store = CandidateStore(tmp_path / "candidates.jsonl")
    first = store.record(
        source_id=_SOURCE_ID,
        content=UntrustedText("first proposal"),
        proposed_at=_PROPOSED_AT,
        holder="first reviewer",
    )
    second = store.record(
        source_id=_SOURCE_ID,
        content=UntrustedText("second proposal"),
        proposed_at=_PROPOSED_AT,
        holder="second reviewer",
    )

    assert store.proposals() == (first, second)


def test_record_writes_the_canonical_proposal_bytes(tmp_path: Path) -> None:
    """Using default JSON serialization would add noncanonical spaces or escapes."""
    path = tmp_path / "candidates.jsonl"
    store = CandidateStore(path)
    recorded = store.record(
        source_id=_SOURCE_ID,
        content=UntrustedText("proposta è dati"),
        proposed_at=_PROPOSED_AT,
        holder="reviewer",
    )

    assert path.read_bytes() == canonical_bytes(recorded.as_payload()) + b"\n"


def test_an_unreadable_proposal_line_raises_instead_of_being_skipped(
    tmp_path: Path,
) -> None:
    """Continuing after corrupt JSON would silently report an incomplete history."""
    path = tmp_path / "candidates.jsonl"
    store = CandidateStore(path)
    store.record(
        source_id=_SOURCE_ID,
        content=UntrustedText("readable proposal"),
        proposed_at=_PROPOSED_AT,
        holder="reviewer",
    )
    with path.open("ab") as handle:
        handle.write(b"{not readable}\n")

    with pytest.raises(CandidateError, match="proposal line 2 is not readable"):
        store.proposals()
