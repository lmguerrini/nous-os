"""Acceptance tests for the origin carrier at the promotion boundary."""

from __future__ import annotations

from nous_os.attribution import (
    PROMOTABLE_ORIGINS,
    AttributedKey,
    AttributionError,
    KeyOrigin,
    is_promotable,
)
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey


_CITATION = Citation(
    source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshot_digest="a" * 64,
    locator=Locator(0, 4),
    span="text",
)


def _key(origin: KeyOrigin, citation: Citation | None = None) -> AttributedKey:
    """Construct a valid carrier, supplying evidence only for content origin."""
    return AttributedKey(
        key=ClaimKey("subject"),
        origin=origin,
        citation=_CITATION if origin is KeyOrigin.CONTENT else citation,
    )


def test_promotable_origins_are_pinned_against_the_entire_closed_vocabulary() -> None:
    """Adding or changing an origin must fail both vocabulary and allowlist checks."""
    assert {member.value for member in KeyOrigin} == {
        "operator",
        "derived",
        "content",
        "unknown",
    }
    assert PROMOTABLE_ORIGINS == frozenset({KeyOrigin.OPERATOR, KeyOrigin.DERIVED})
    assert len(KeyOrigin) == 4

    observed = {origin: is_promotable(_key(origin)) for origin in KeyOrigin}
    assert sum(observed.values()) == 2
    assert {origin for origin, allowed in observed.items() if allowed} == PROMOTABLE_ORIGINS
    assert {origin for origin, allowed in observed.items() if not allowed} == {
        KeyOrigin.CONTENT,
        KeyOrigin.UNKNOWN,
    }


def test_content_origin_requires_an_exact_citation() -> None:
    """Content cannot merely claim an origin without identifying that content."""
    try:
        AttributedKey(ClaimKey("subject"), KeyOrigin.CONTENT)
    except AttributionError as error:
        assert "Citation" in str(error)
    else:  # pragma: no cover - the assertion is the test's real control
        raise AssertionError("content origin unexpectedly accepted no citation")


def test_non_content_origins_refuse_a_citation() -> None:
    """A source citation on another origin would make origin evidence meaningless."""
    for origin in KeyOrigin:
        if origin is KeyOrigin.CONTENT:
            continue
        try:
            AttributedKey(ClaimKey("subject"), origin, _CITATION)
        except AttributionError as error:
            assert "only content" in str(error)
        else:  # pragma: no cover - the assertion is the test's real control
            raise AssertionError(f"{origin.value} unexpectedly accepted a citation")


def test_key_and_optional_citation_are_exact_boundary_types() -> None:
    """A key or citation subtype must not decide behavior behind this record."""

    class KeySubclass(ClaimKey):
        pass

    try:
        AttributedKey(KeySubclass("subject"), KeyOrigin.OPERATOR)
    except AttributionError as error:
        assert "ClaimKey" in str(error)
    else:  # pragma: no cover
        raise AssertionError("a ClaimKey subclass crossed the boundary")


def test_eligibility_refuses_a_wrong_argument_instead_of_hiding_a_caller_bug() -> None:
    """The origin allowlist only answers questions about the exact carrier type."""
    try:
        is_promotable(object())  # type: ignore[arg-type]
    except AttributionError as error:
        assert "AttributedKey" in str(error)
    else:  # pragma: no cover
        raise AssertionError("a wrong eligibility argument silently returned False")
