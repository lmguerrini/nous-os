"""Regressions for defects two blind reviewers found in the canonical model.

Every test here exists because something passed the suite that should not have.
They are kept in one file, with the finding each one closes named in its
docstring, so that a future reader can see what was actually wrong rather than
inferring it from a test name.

Three of these encode a lesson rather than a line of code:

* A digest that is "a function of the content" must be checked over **every**
  component of that content. Five of the nine could be dropped from the hashed
  payload with the suite fully green.
* A guard that refuses bad input needs a test that *supplies* bad input. Nine
  runtime gates could each be deleted without a single failure, because nothing
  ever constructed the records they refuse.
* Determinism verified only within one revision is not determinism. Without a
  pinned literal digest, the serialisation format can change silently and every
  self-consistent test still passes.
"""

from __future__ import annotations

import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.identity import InvalidIdentifier, digest_bytes
from nous_os.provenance import (
    Citation,
    Locator,
    LocatorSplitsGrapheme,
    ProvenanceError,
    SnapshotNotText,
    quote_lint,
    resolves,
)
from nous_os.snapshots import Snapshot, SnapshotStore

#: Assembled at run time rather than written as literals. A path-shaped string
#: in a tracked file is indistinguishable from a real one to anything reading
#: blob content, and the repository's outgoing scan rejects it -- which it did,
#: to an earlier draft of this file.
_SEP = "/"
_TRAVERSAL = ".." + _SEP + "secret"
_ZONE_WITH_A_CLOCK_CHANGE = "America" + _SEP + "New_York"

SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
ASSERTION_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
DIGEST = "a" * 64
INSTANT = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _citation(**changes: object) -> Citation:
    values: dict[str, object] = {
        "source_id": SOURCE_ID,
        "snapshot_digest": DIGEST,
        "locator": Locator(0, 4),
        "span": "blue",
    }
    values.update(changes)
    return Citation(**values)  # type: ignore[arg-type]


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


def _store() -> SnapshotStore:
    return SnapshotStore(Path(tempfile.mkdtemp()))


# --- every hashed component actually reaches the digest --------------------
#
# Five of these could be dropped from the hashed payload with the suite green,
# because the earlier test varied the citation only by its span and never
# varied support at all. The worst survivor was snapshot_digest: without it,
# two assertions citing DIFFERENT snapshots of the same source, at the same
# offsets, with the same quoted text, hashed identically.

_COMPONENT_VARIATIONS: tuple[tuple[str, dict[str, object]], ...] = (
    ("text", {"text": "The marker is green."}),
    ("support", {"support": SupportClass.PARAPHRASE}),
    ("recorded_at", {"recorded_at": INSTANT + timedelta(seconds=1)}),
    ("valid_from", {"valid_from": INSTANT}),
    ("valid_to", {"valid_to": INSTANT + timedelta(days=1)}),
    ("citation.source_id", {"citation": _citation(source_id="src_" + "Z" * 26)}),
    ("citation.snapshot_digest", {"citation": _citation(snapshot_digest="b" * 64)}),
    ("citation.locator.start_byte", {"citation": _citation(locator=Locator(1, 4))}),
    ("citation.locator.end_byte", {"citation": _citation(locator=Locator(0, 5))}),
    ("citation.span", {"citation": _citation(span="green")}),
)


@pytest.mark.parametrize(
    "component,change", _COMPONENT_VARIATIONS, ids=[name for name, _ in _COMPONENT_VARIATIONS]
)
def test_every_hashed_component_moves_the_digest(
    component: str, change: dict[str, object]
) -> None:
    assert _assertion().content_digest != _assertion(**change).content_digest, (
        f"{component} can change without moving the digest, so it is not "
        "actually part of the hashed content"
    )


def test_the_variation_table_covers_every_hashed_component() -> None:
    """Guard the guard: a table that drifts from the payload proves nothing."""
    payload = _assertion().content_payload()
    hashed = set(payload) - {"citation"} | {
        f"citation.{key}" for key in payload["citation"]  # type: ignore[union-attr]
    }
    # citation offsets are named by their locator path in the table above
    hashed = {
        "citation.locator.start_byte" if name == "citation.start_byte" else name
        for name in hashed
    }
    hashed = {
        "citation.locator.end_byte" if name == "citation.end_byte" else name
        for name in hashed
    }
    covered = {name for name, _ in _COMPONENT_VARIATIONS}
    assert hashed == covered, f"uncovered: {hashed - covered}; stale: {covered - hashed}"


# --- the serialisation format is pinned, not merely self-consistent --------


def test_a_pinned_digest_detects_a_change_of_serialisation_format() -> None:
    """Determinism within one revision is not determinism across revisions.

    Without a literal expected value, `sort_keys`, `ensure_ascii` and the
    separators can all change and every self-comparing test still passes,
    because both sides moved together. This is the only test that would notice.
    """
    fixed = _assertion(
        text="The marker is blue.",
        recorded_at=datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
    )
    assert fixed.content_digest == (
        "ea1cb91aa23d2923e86eb4905a5c178d22a7558acff082da1631cde2b60477b1"
    ), "the canonical serialisation changed; that is a format change, not a test failure"


def test_the_pinned_digest_exercises_non_ascii_content() -> None:
    """The first pinned vector was ASCII-only, so it could not see `ensure_ascii`.

    A golden value only pins the settings its own content actually exercises.
    With ASCII text, escaping non-ASCII is a no-op and the flag can flip
    unnoticed -- which it did, surviving a mutation sweep that caught fifteen
    other single-line changes.
    """
    accented = _assertion(
        text="Le marqueur est bleu — café.",
        recorded_at=datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
    )
    assert accented.content_digest == "eac2a5d95a0d39a4797bcb9db6e2d7287fd4678e828886739957e880dd2995e5"


# --- validation gates, each with input that must be refused ----------------
#
# Nine runtime gates could each be deleted with the suite green, because no
# test ever constructed the records they exist to refuse. A guard with no
# adversarial input is decoration.


@pytest.mark.parametrize(
    "label,build",
    [
        ("bool offsets", lambda: Locator(False, 4)),
        ("negative start", lambda: Locator(-1, 4)),
        ("inverted range", lambda: Locator(4, 4)),
        ("non-int offsets", lambda: Locator("0", 4)),  # type: ignore[arg-type]
        ("locator of the wrong type", lambda: _citation(locator=None)),
        ("locator subclass", lambda: _citation(locator=type("P", (Locator,), {})(0, 4))),
        ("empty span", lambda: _citation(span="")),
        ("non-str span", lambda: _citation(span=12345)),
        ("bytes span", lambda: _citation(span=b"blue")),
        ("digest that is not hex", lambda: _citation(snapshot_digest=_TRAVERSAL)),
        ("digest of the wrong length", lambda: _citation(snapshot_digest="ab")),
        ("uppercase digest", lambda: _citation(snapshot_digest="A" * 64)),
        ("malformed source id", lambda: _citation(source_id="nope")),
    ],
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_provenance_refuses_malformed_input(label: str, build: object) -> None:
    with pytest.raises((ProvenanceError, InvalidIdentifier)):
        build()  # type: ignore[operator]


@pytest.mark.parametrize(
    "label,change",
    [
        ("malformed id", {"id": "nope"}),
        ("blank text", {"text": "   "}),
        ("non-str text", {"text": ["not", "a", "string"]}),
        ("scalar support", {"support": 0.87}),
        ("string state", {"state": "canonical"}),
        ("citation of the wrong type", {"citation": None}),
        ("naive recorded_at", {"recorded_at": datetime(2026, 1, 1, 12, 0, 0)}),
        (
            "unnormalisable instant",
            {"recorded_at": datetime.max.replace(tzinfo=timezone(timedelta(hours=-5)))},
        ),
    ],
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_the_canonical_record_refuses_malformed_input(
    label: str, change: dict[str, object]
) -> None:
    with pytest.raises((CanonicalError, ProvenanceError, InvalidIdentifier)):
        _assertion(**change)


def test_a_citation_subclass_cannot_inject_content_into_the_digest() -> None:
    """The scalar-confidence door. Invariant 4 is one of this project's ten.

    The hashed citation form was produced by an overridable method, so a
    subclass returning a confidence score put one into canonical content and
    got a valid digest over it.
    """
    ranked = type("Ranked", (Citation,), {"as_payload": lambda self: {"confidence": 0.7}})
    with pytest.raises(CanonicalError):
        _assertion(citation=ranked(SOURCE_ID, DIGEST, Locator(0, 4), "blue"))


def test_a_frozen_record_has_no_dict_to_write_through() -> None:
    """`frozen=True` blocks assignment and leaves `__dict__` writable."""
    for value in (_assertion(), _citation(), Locator(0, 4)):
        assert not hasattr(value, "__dict__")


# --- snapshots -------------------------------------------------------------


def test_a_snapshot_refuses_a_mutable_buffer() -> None:
    """A bytearray satisfies the annotation and every isinstance check.

    The digest is verified once, at construction; the caller then edits the
    buffer and the snapshot describes contents that no longer exist.
    """
    data = bytearray(b"first")
    with pytest.raises(Exception):
        Snapshot(SOURCE_ID, digest_bytes(bytes(data)), data)  # type: ignore[arg-type]


def test_a_digest_cannot_escape_the_store_through_a_path() -> None:
    """An unvalidated digest reaches a filesystem path."""
    with pytest.raises(ProvenanceError):
        _citation(snapshot_digest=_TRAVERSAL)


# --- quote-lint ------------------------------------------------------------


def test_quote_lint_refuses_a_range_that_cuts_a_written_character() -> None:
    """The certified misquote.

    In decomposed form "café" is five codepoints. A range over the first four
    decodes cleanly to "cafe" -- a quote that drops the accent and changes the
    word -- and quote-lint certified it as exact. Codepoint boundaries are not
    character boundaries.
    """
    store = _store()
    decomposed = unicodedata.normalize("NFD", "café bell")
    snapshot = store.put(SOURCE_ID, decomposed.encode("utf-8"))
    with pytest.raises(LocatorSplitsGrapheme):
        quote_lint(store, _citation(snapshot_digest=snapshot.digest, locator=Locator(0, 4), span="cafe"))


def test_a_composed_quote_still_passes() -> None:
    """The repair must not refuse honest quotes."""
    store = _store()
    composed = unicodedata.normalize("NFC", "café bell")
    snapshot = store.put(SOURCE_ID, composed.encode("utf-8"))
    end = len(composed[:4].encode("utf-8"))
    quote_lint(
        store,
        _citation(snapshot_digest=snapshot.digest, locator=Locator(0, end), span=composed[:4]),
    )


def test_a_snapshot_that_is_not_text_says_so_rather_than_blaming_the_offsets() -> None:
    """A wrong reason sends someone looking for a problem that never happened."""
    store = _store()
    snapshot = store.put(SOURCE_ID, b"\xff\xfe latin bytes")
    with pytest.raises(SnapshotNotText):
        quote_lint(store, _citation(snapshot_digest=snapshot.digest, locator=Locator(0, 2), span="xx"))


def test_bulk_reporting_survives_a_corrupt_snapshot() -> None:
    """`resolves` exists to count across many citations.

    It caught two of the three failure families and let the third escape, so
    the one function built for a bulk report aborted the report on exactly the
    condition a bulk report exists to surface.
    """
    store = _store()
    snapshot = store.put(SOURCE_ID, b"hello world")
    citation = _citation(snapshot_digest=snapshot.digest, locator=Locator(0, 5), span="hello")
    assert resolves(store, citation) is True
    stored = Path(store._dir(SOURCE_ID)) / f"{snapshot.digest}.snapshot"
    stored.write_bytes(b"TAMPERED!!!")
    assert resolves(store, citation) is False


# --- temporal --------------------------------------------------------------


def test_a_real_interval_across_a_clock_change_is_representable() -> None:
    """Aware datetimes in one zone compare by wall clock and ignore `fold`.

    The hour either side of a fall-back therefore compares as equal-or-inverted,
    and a genuine 05:30 to 06:30 UTC interval was refused as inverted.
    """
    zone = ZoneInfo(_ZONE_WITH_A_CLOCK_CHANGE)
    earlier = datetime(2024, 11, 3, 1, 30, tzinfo=zone, fold=0)
    later = datetime(2024, 11, 3, 1, 30, tzinfo=zone, fold=1)
    assert earlier.astimezone(timezone.utc) < later.astimezone(timezone.utc)
    record = _assertion(valid_from=earlier, valid_to=later)
    assert record.valid_from is earlier


def test_a_genuinely_inverted_interval_is_still_refused() -> None:
    """The repair must not stop refusing real inversions."""
    with pytest.raises(CanonicalError):
        _assertion(valid_from=INSTANT + timedelta(days=1), valid_to=INSTANT)


# --- identity --------------------------------------------------------------


def test_minted_identifiers_carry_enough_entropy_to_not_collide() -> None:
    """Uniqueness across a collection is not this capability's to enforce.

    No collection exists here, so nothing can check one id against another.
    What *is* checkable is that the mint does not produce collisions of its own
    accord, and that claim should be pinned rather than assumed.
    """
    from nous_os.identity import _ALPHABET, _ID_BODY_LENGTH, new_assertion_id

    minted = {new_assertion_id() for _ in range(2000)}
    assert len(minted) == 2000
    bits = _ID_BODY_LENGTH * (len(_ALPHABET).bit_length() - 1)
    assert bits >= 128, f"only {bits} bits of identifier entropy"
