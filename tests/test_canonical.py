"""Typed-class and lifecycle gates for canonical assertions."""

from __future__ import annotations

from dataclasses import FrozenInstanceError, dataclass, fields, is_dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import inspect
import unicodedata
from types import ModuleType
from typing import Any, get_args, get_type_hints

import pytest

from nous_os import canonical, identity, provenance, snapshots
from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.provenance import Citation, Locator


MODEL_MODULES: tuple[ModuleType, ...] = (identity, snapshots, provenance, canonical)
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
ASSERTION_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
INSTANT = datetime(2025, 1, 2, tzinfo=timezone.utc)


def _citation() -> Citation:
    return Citation(SOURCE_ID, "a" * 64, Locator(0, 4), "blue")


def _assertion(**changes: object) -> Assertion:
    values: dict[str, object] = {
        "id": ASSERTION_ID,
        "text": "The marker is blue.",
        "citation": _citation(),
        "support": SupportClass.DIRECT_QUOTE,
        "recorded_at": INSTANT,
        "state": LifecycleState.CANDIDATE,
    }
    values.update(changes)
    return Assertion(**values)  # type: ignore[arg-type]


def _contains_type(annotation: object, wanted: type[object]) -> bool:
    return annotation is wanted or any(_contains_type(part, wanted) for part in get_args(annotation))


def _scalar_confidence_offences(classes: list[type[object]]) -> list[str]:
    suggestive = ("score", "confidence", "probability", "weight", "certainty", "rank")
    offences = []
    for record_class in classes:
        annotations = get_type_hints(record_class)
        for field in fields(record_class):
            annotation = annotations[field.name]
            if _contains_type(annotation, float) or (
                any(word in field.name.lower() for word in suggestive)
                and (_contains_type(annotation, int) or _contains_type(annotation, str))
            ):
                offences.append(f"{record_class.__name__}.{field.name}")
    return offences


def _model_dataclasses() -> list[type[object]]:
    return [
        member
        for module in MODEL_MODULES
        for _, member in inspect.getmembers(module, inspect.isclass)
        if member.__module__ == module.__name__ and is_dataclass(member)
    ]


def test_p12_no_scalar_confidence_field_exists_in_any_model_dataclass() -> None:
    assert _scalar_confidence_offences(_model_dataclasses()) == []


def test_p12_the_scalar_confidence_check_has_a_positive_control() -> None:
    @dataclass
    class WouldBeInvalid:
        measurement: float
        evidence_rank: int
        confidence_label: str

    assert _scalar_confidence_offences([WouldBeInvalid]) == [
        "WouldBeInvalid.measurement",
        "WouldBeInvalid.evidence_rank",
        "WouldBeInvalid.confidence_label",
    ]


def test_p13_support_is_a_closed_enum_with_no_ordering() -> None:
    assert issubclass(SupportClass, Enum)
    assert {member.value for member in SupportClass} == {
        "direct_quote",
        "paraphrase",
        "summary",
        "inferred",
        "unknown",
    }
    with pytest.raises(ValueError):
        SupportClass("unlisted")
    with pytest.raises(TypeError):
        _ = SupportClass.DIRECT_QUOTE < SupportClass.PARAPHRASE  # type: ignore[operator]


def _transition_callables() -> list[str]:
    findings = []
    for module in MODEL_MODULES:
        for name, callable_object in inspect.getmembers(module, inspect.isfunction):
            hints = get_type_hints(callable_object)
            parameters = inspect.signature(callable_object).parameters
            takes_record = any(hints.get(parameter.name) is Assertion for parameter in parameters.values())
            if takes_record and hints.get("return") is Assertion:
                findings.append(f"{module.__name__}.{name}")
    return findings


def _state_setting_methods() -> list[str]:
    findings = []
    for name, method in inspect.getmembers(Assertion, inspect.isfunction):
        if name == "__init__":
            continue
        hints = get_type_hints(method)
        parameters = inspect.signature(method).parameters
        if any(hints.get(parameter.name) is LifecycleState for parameter in parameters.values()):
            findings.append(name)
    return findings


def test_p14_no_lifecycle_transition_callable_or_state_setting_record_method_exists() -> None:
    record = _assertion()

    assert issubclass(LifecycleState, Enum)
    assert {member.value for member in LifecycleState} == {"canonical", "candidate", "rejected"}
    with pytest.raises(ValueError):
        LifecycleState("unlisted")
    assert _transition_callables() == []
    assert _state_setting_methods() == []
    with pytest.raises(FrozenInstanceError):
        record.state = LifecycleState.CANONICAL  # type: ignore[misc]


def test_p15_time_axes_are_independent_timezone_aware_and_ordered() -> None:
    names = {field.name for field in fields(Assertion)}
    assert {"recorded_at", "valid_from", "valid_to"} <= names
    naive = datetime(2025, 1, 2)

    for field_name in ("recorded_at", "valid_from", "valid_to"):
        with pytest.raises(CanonicalError):
            _assertion(**{field_name: naive})

    with pytest.raises(CanonicalError):
        _assertion(valid_from=INSTANT, valid_to=INSTANT)


def test_p16_unknown_support_and_absent_validity_start_are_distinct_answers() -> None:
    unknown = _assertion(support=SupportClass.UNKNOWN, valid_from=None)
    established = _assertion(
        support=SupportClass.DIRECT_QUOTE,
        valid_from=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )

    assert unknown.support is SupportClass.UNKNOWN
    assert unknown.support is not established.support
    assert unknown.valid_from is None
    assert established.valid_from is not None


# --- regression: one instant must have one digest --------------------------
#
# These exist because the property "the digest changes if and only if the
# content changes" was satisfied in one direction and quietly broken in the
# other. `datetime.isoformat` serialises how an instant was written, not which
# instant it is, so two equal datetimes written at different offsets hashed
# differently. Nothing in the suite exercised that case, because the property
# had been stated as "editing a time field changes the digest" -- true, and not
# the whole of it.

_SAME_INSTANT = (
    datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
    datetime(2026, 1, 1, 13, 0, 0, tzinfo=timezone(timedelta(hours=1))),
    datetime(2026, 1, 1, 7, 0, 0, tzinfo=timezone(timedelta(hours=-5))),
)


def test_the_three_expressions_used_here_really_are_one_instant() -> None:
    """Guard the guard: if these stopped being equal the tests below prove nothing."""
    first, *rest = _SAME_INSTANT
    assert all(first == other for other in rest)


@pytest.mark.parametrize("field", ["recorded_at", "valid_from", "valid_to"])
def test_one_instant_has_one_digest_whatever_offset_it_was_written_in(field: str) -> None:
    digests = {
        _assertion(**{field: instant}).content_digest for instant in _SAME_INSTANT
    }
    assert len(digests) == 1, (
        f"{field} written at different offsets produced {len(digests)} digests; "
        "the content did not change, so the digest must not"
    )


def test_a_genuinely_different_instant_still_changes_the_digest() -> None:
    """The other half of 'if and only if'. Normalising must not flatten real edits."""
    one_second_later = datetime(2026, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
    assert (
        _assertion(recorded_at=_SAME_INSTANT[0]).content_digest
        != _assertion(recorded_at=one_second_later).content_digest
    )


def test_claim_text_is_not_normalised_the_way_instants_are() -> None:
    """Deliberate asymmetry, recorded so nobody 'fixes' it.

    Two instants written at different offsets are the same instant. Two unicode
    normalisation forms are different strings, and folding them would be the
    system rewriting what a source said -- which is exactly what provenance
    exists to prevent.
    """
    composed = unicodedata.normalize("NFC", "café")
    decomposed = unicodedata.normalize("NFD", "café")
    assert composed != decomposed
    assert (
        _assertion(text=composed).content_digest
        != _assertion(text=decomposed).content_digest
    )
