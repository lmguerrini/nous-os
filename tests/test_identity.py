"""G-ID: stable assertion identities and deterministic content digests."""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.identity import (
    ASSERTION_PREFIX,
    SOURCE_PREFIX,
    InvalidIdentifier,
    new_assertion_id,
    require_id,
)
from nous_os.provenance import Citation, Locator


REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
ASSERTION_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
RECORDED_AT = datetime(2025, 1, 2, 3, 4, tzinfo=timezone.utc)
VALID_FROM = datetime(2025, 1, 1, tzinfo=timezone.utc)
VALID_TO = datetime(2025, 2, 1, tzinfo=timezone.utc)


def _citation(
    *,
    digest: str = "a" * 64,
    start_byte: int = 0,
    end_byte: int = 4,
    span: str = "blue",
) -> Citation:
    return Citation(
        source_id=SOURCE_ID,
        snapshot_digest=digest,
        locator=Locator(start_byte=start_byte, end_byte=end_byte),
        span=span,
    )


def _assertion(**changes: object) -> Assertion:
    values: dict[str, object] = {
        "id": ASSERTION_ID,
        "text": "The marker is blue.",
        "citation": _citation(),
        "support": SupportClass.DIRECT_QUOTE,
        "recorded_at": RECORDED_AT,
        "state": LifecycleState.CANDIDATE,
        "valid_from": VALID_FROM,
        "valid_to": VALID_TO,
    }
    values.update(changes)
    return Assertion(**values)  # type: ignore[arg-type]


def test_p1_a_stable_id_survives_reingest_reordering_and_a_content_edit() -> None:
    original = _assertion()
    reingested = _assertion(id=original.id)
    sibling = _assertion(id="asr_01ARZ3NDEKTSV4RRFFQ69G5FB0")
    ingested_collection = [original, sibling]
    reordered_collection = [sibling, original]
    corrected = _assertion(id=original.id, text="The marker is azure.")

    assert reingested.id == original.id
    assert ingested_collection[0].id == original.id
    assert reordered_collection[1].id == original.id
    assert corrected.id == original.id
    assert corrected.content_digest != original.content_digest


@pytest.mark.parametrize(
    ("change", "description"),
    [
        ({"text": "The marker is green."}, "claim text"),
        ({"citation": _citation(span="cyan")}, "citation"),
        ({"recorded_at": RECORDED_AT + timedelta(minutes=1)}, "recorded time"),
        ({"valid_from": VALID_FROM + timedelta(days=1)}, "validity start"),
        ({"valid_to": VALID_TO + timedelta(days=1)}, "validity end"),
    ],
)
def test_p2_the_digest_changes_when_each_content_field_changes(
    change: dict[str, object], description: str
) -> None:
    """Each parameter is independently content, so no field is omitted from hashing."""
    assert _assertion(**change).content_digest != _assertion().content_digest, description


def test_p2_the_digest_is_identical_for_equal_content_regardless_of_id_state_or_order() -> None:
    original = _assertion()
    reserialised = _assertion()
    reminted = _assertion(id="asr_01ARZ3NDEKTSV4RRFFQ69G5FB0")
    state_changed = _assertion(state=LifecycleState.CANONICAL)
    in_order = [original, reminted]
    reordered = [reminted, original]

    assert reserialised.content_digest == original.content_digest
    assert reminted.content_digest == original.content_digest
    assert state_changed.content_digest == original.content_digest
    assert {record.id: record.content_digest for record in in_order} == {
        record.id: record.content_digest for record in reordered
    }


def test_p3_the_same_content_digest_is_stable_in_a_fresh_interpreter() -> None:
    expected = _assertion().content_digest
    program = "\n".join(
        [
            "from datetime import datetime, timezone",
            "from nous_os.canonical import Assertion, LifecycleState, SupportClass",
            "from nous_os.provenance import Citation, Locator",
            "citation = Citation('src_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'a' * 64, Locator(0, 4), 'blue')",
            "record = Assertion('asr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'The marker is blue.', citation, SupportClass.DIRECT_QUOTE, datetime(2025, 1, 2, 3, 4, tzinfo=timezone.utc), LifecycleState.CANDIDATE, datetime(2025, 1, 1, tzinfo=timezone.utc), datetime(2025, 2, 1, tzinfo=timezone.utc))",
            "print(record.content_digest)",
        ]
    )
    environment = os.environ.copy()
    source_root = str(REPO_ROOT / "src")
    environment["PYTHONPATH"] = source_root + os.pathsep + environment.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout.strip() == expected


def test_p4_separately_minted_ids_are_different_for_byte_identical_content() -> None:
    first_id = new_assertion_id(lambda: "01ARZ3NDEKTSV4RRFFQ69G5FAV")
    second_id = new_assertion_id(lambda: "01ARZ3NDEKTSV4RRFFQ69G5FB0")
    first = _assertion(id=first_id)
    second = _assertion(id=second_id)

    assert first_id != second_id
    assert first.content_payload() == second.content_payload()
    assert first.content_digest == second.content_digest


@pytest.mark.parametrize(
    ("value", "prefix"),
    [
        ("asr_not-valid", ASSERTION_PREFIX),
        ("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", ASSERTION_PREFIX),
        ("asr_01ARZ3NDEKTSV4RRFFQ69G5FAV", SOURCE_PREFIX),
    ],
)
def test_p5_malformed_and_wrong_kind_identifiers_are_refused(
    value: str, prefix: str
) -> None:
    with pytest.raises(InvalidIdentifier):
        require_id(value, prefix)
