"""Temporal partitioning preserves unknowns and reports disagreement without choosing."""

from __future__ import annotations

from dataclasses import FrozenInstanceError, dataclass, fields, replace
from datetime import datetime, timedelta, timezone
import inspect
from typing import get_type_hints

import pytest

from nous_os.canonical import Assertion, CanonicalError, LifecycleState, SupportClass
from nous_os.provenance import Citation, Locator
from nous_os.temporal import (
    AsOf,
    AsOfRanking,
    AssertionIdentityConflict,
    ClaimKey,
    ClaimKeyError,
    Conflict,
    NonCanonicalAssertion,
    Overlap,
    RankingDivergence,
    TemporalError,
    TemporalAssertionError,
    TemporalIndex,
    TemporalTypeError,
    as_of_ranking,
)
from nous_os.untrusted import UntrustedText


SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _assertion(
    number: int,
    *,
    recorded_at: datetime = BASE,
    valid_from: datetime | None = BASE,
    valid_to: datetime | None = None,
    text: str | None = None,
) -> Assertion:
    span = f"span-{number}"
    return Assertion(
        id=f"asr_{number:026X}",
        text=text or f"claim {number}",
        citation=Citation(
            SOURCE_ID, f"{number:064x}", Locator(0, len(span)), span
        ),
        support=SupportClass.DIRECT_QUOTE,
        recorded_at=recorded_at,
        state=LifecycleState.CANONICAL,
        valid_from=valid_from,
        valid_to=valid_to,
    )


def _index(key: ClaimKey, assertions: tuple[Assertion, ...]) -> TemporalIndex:
    result = TemporalIndex()
    for assertion in assertions:
        result.add(key, assertion)
    return result


def _ids(assertions: tuple[Assertion, ...]) -> tuple[str, ...]:
    return tuple(assertion.id for assertion in assertions)


def test_claim_key_accepts_only_the_explicit_ascii_subject_grammar() -> None:
    valid = ("a", "lowercase-7", "two.parts", "a-1.b-2", "z" * 64)
    assert len(valid) == 5
    assert tuple(ClaimKey(value).value for value in valid) == valid

    invalid = (
        "",
        "A",
        "has space",
        "tab\tkey",
        "line\nbreak",
        "é",
        "-start",
        ".start",
        "end-",
        "end.",
        "two--separators",
        "two.-separators",
        "two..separators",
        "x" * 65,
        7,
    )
    assert len(invalid) == 15
    for value in invalid:
        with pytest.raises(ClaimKeyError):
            ClaimKey(value)  # type: ignore[arg-type]


def test_claim_key_refuses_untrusted_text_and_a_string_subclass_before_assignment() -> None:
    class MisleadingString(str):
        def __hash__(self) -> int:
            return 1

        def __eq__(self, other: object) -> bool:
            return True

    with pytest.raises(ClaimKeyError, match="must be a str"):
        ClaimKey(UntrustedText("claimed-subject"))  # type: ignore[arg-type]
    with pytest.raises(ClaimKeyError, match="must be a str"):
        ClaimKey(MisleadingString("claimed-subject"))


def test_add_uses_exact_types_and_preserves_one_identifier_one_subject() -> None:
    key = ClaimKey("subject")
    assertion = _assertion(1)
    index = TemporalIndex()
    with pytest.raises(TemporalTypeError):
        index.add("subject", assertion)  # type: ignore[arg-type]
    with pytest.raises(TemporalTypeError):
        index.add(key, object())  # type: ignore[arg-type]
    index.add(key, assertion)
    index.add(key, assertion)
    assert _ids(index.assertions(key)) == (assertion.id,)

    changed = _assertion(1, text="changed content")
    with pytest.raises(AssertionIdentityConflict, match=assertion.id):
        index.add(key, changed)
    with pytest.raises(AssertionIdentityConflict, match=assertion.id):
        index.add(ClaimKey("other"), assertion)
    earlier = ClaimKey("a-subject")
    index.add(earlier, _assertion(2))
    assert index.keys() == (earlier, key)


def test_add_accepts_only_canonical_assertions() -> None:
    key = ClaimKey("canonical-only")
    index = TemporalIndex()
    states = tuple(LifecycleState)
    assert len(states) == 3
    canonical_states = tuple(
        state for state in states if state is LifecycleState.CANONICAL
    )
    assert canonical_states == (LifecycleState.CANONICAL,)
    canonical = _assertion(3)
    index.add(key, canonical)
    assert index.assertions(key) == (canonical,)

    non_canonical_states = tuple(
        state for state in states if state is not LifecycleState.CANONICAL
    )
    assert len(non_canonical_states) == 2
    for number, state in enumerate(non_canonical_states, start=4):
        assertion = replace(_assertion(number), state=state)
        with pytest.raises(NonCanonicalAssertion, match=state.name):
            index.add(key, assertion)
    assert index.assertions(key) == (canonical,)


def test_partition_is_total_and_disjoint_for_every_generated_bound_and_axis_case() -> None:
    t1 = BASE + timedelta(days=1)
    t2 = BASE + timedelta(days=2)
    assertions = (
        _assertion(10, valid_from=t1, valid_to=t2),
        _assertion(11, valid_from=None, valid_to=t2),
        _assertion(12, valid_from=t1, valid_to=None),
        _assertion(13, valid_from=None, valid_to=None),
    )
    key = ClaimKey("partition")
    index = _index(key, assertions)
    queries = tuple(
        (valid_at, recorded_at)
        for valid_at in (None, BASE, t1, t2)
        for recorded_at in (None, BASE - timedelta(seconds=1), BASE)
    )
    assert len(assertions) == 4
    assert len(queries) == 12
    expected = {assertion.id for assertion in assertions}
    assert len(expected) == 4
    for valid_at, recorded_at in queries:
        answer = index.as_of(valid_at=valid_at, recorded_as_of=recorded_at)
        partitions = (
            {assertion.id for assertion in answer.established},
            {assertion.id for assertion in answer.excluded},
            {assertion.id for assertion in answer.undetermined},
        )
        assert len(partitions) == 3
        assert partitions[0] | partitions[1] | partitions[2] == expected
        assert partitions[0].isdisjoint(partitions[1])
        assert partitions[0].isdisjoint(partitions[2])
        assert partitions[1].isdisjoint(partitions[2])


def test_validity_and_recorded_axes_answer_independently_in_both_directions() -> None:
    valid_late_recorded_early = _assertion(
        20, recorded_at=BASE, valid_from=BASE + timedelta(days=2), valid_to=BASE + timedelta(days=4)
    )
    valid_early_recorded_late = _assertion(
        21, recorded_at=BASE + timedelta(days=2), valid_from=BASE, valid_to=BASE + timedelta(days=4)
    )
    index = _index(ClaimKey("axes"), (valid_late_recorded_early, valid_early_recorded_late))

    valid_only = index.as_of(valid_at=BASE + timedelta(days=1))
    assert _ids(valid_only.excluded) == (valid_late_recorded_early.id,)
    assert _ids(valid_only.established) == (valid_early_recorded_late.id,)
    recorded_only = index.as_of(recorded_as_of=BASE + timedelta(days=1))
    assert _ids(recorded_only.established) == (valid_late_recorded_early.id,)
    assert _ids(recorded_only.excluded) == (valid_early_recorded_late.id,)


def test_absent_bounds_never_default_to_an_infinite_validity_interval() -> None:
    upper_only = _assertion(30, valid_from=None, valid_to=BASE + timedelta(days=2))
    bounded = _assertion(31, valid_from=BASE, valid_to=BASE + timedelta(days=3))
    index = _index(ClaimKey("unknown-bounds"), (upper_only, bounded))
    before_upper = index.as_of(valid_at=BASE + timedelta(days=1))
    assert _ids(before_upper.undetermined) == (upper_only.id,)
    assert _ids(before_upper.established) == (bounded.id,)
    after_upper = index.as_of(valid_at=BASE + timedelta(days=2))
    assert _ids(after_upper.excluded) == (upper_only.id,)
    assert _ids(after_upper.established) == (bounded.id,)
    query_instants = (BASE - timedelta(days=1), BASE, BASE + timedelta(days=1), BASE + timedelta(days=3))
    assert len(query_instants) == 4
    for instant in query_instants:
        assert upper_only.id not in _ids(index.as_of(valid_at=instant).established)


def test_excluded_and_undetermined_dominate_established_across_either_axis() -> None:
    valid_excluded = _assertion(40, valid_from=BASE + timedelta(days=2), valid_to=BASE + timedelta(days=4))
    valid_unknown = _assertion(41, valid_from=None, valid_to=None)
    recorded_excluded = _assertion(
        42, recorded_at=BASE + timedelta(days=2), valid_from=BASE, valid_to=BASE + timedelta(days=4)
    )
    index = _index(ClaimKey("dominance"), (valid_excluded, valid_unknown, recorded_excluded))

    valid_query = index.as_of(valid_at=BASE)
    assert _ids(valid_query.excluded) == (valid_excluded.id,)
    assert _ids(valid_query.undetermined) == (valid_unknown.id,)
    assert _ids(valid_query.established) == (recorded_excluded.id,)
    recorded_query = index.as_of(recorded_as_of=BASE)
    assert _ids(recorded_query.excluded) == (recorded_excluded.id,)
    assert _ids(recorded_query.established) == (valid_excluded.id, valid_unknown.id)
    both = index.as_of(valid_at=BASE, recorded_as_of=BASE)
    assert _ids(both.excluded) == (valid_excluded.id, recorded_excluded.id)
    assert _ids(both.undetermined) == (valid_unknown.id,)


def test_half_open_validity_boundaries_and_abutting_intervals_are_not_overlap() -> None:
    start = BASE
    middle = BASE + timedelta(days=1)
    end = BASE + timedelta(days=2)
    left = _assertion(50, valid_from=start, valid_to=middle)
    right = _assertion(51, valid_from=middle, valid_to=end)
    index = _index(ClaimKey("boundaries"), (left, right))
    at_start = index.as_of(valid_at=start)
    assert _ids(at_start.established) == (left.id,)
    assert _ids(at_start.excluded) == (right.id,)
    at_middle = index.as_of(valid_at=middle)
    assert _ids(at_middle.excluded) == (left.id,)
    assert _ids(at_middle.established) == (right.id,)
    conflicts = index.conflicts()
    assert len(conflicts) == 0
    overlapping = _assertion(52, valid_from=start, valid_to=end)
    positive_control = _index(ClaimKey("boundaries-control"), (left, overlapping))
    assert len(positive_control.conflicts()) == 1


def test_conflicts_settle_decisive_disjointness_with_one_absent_bound() -> None:
    t1 = BASE + timedelta(days=1)
    t2 = BASE + timedelta(days=2)
    t3 = BASE + timedelta(days=3)
    cases = (
        (
            ClaimKey("later-open"),
            (
                _assertion(53, valid_from=t1, valid_to=t2),
                _assertion(54, valid_from=t2, valid_to=None),
            ),
        ),
        (
            ClaimKey("earlier-open"),
            (
                _assertion(55, valid_from=None, valid_to=t2),
                _assertion(56, valid_from=t2, valid_to=t3),
            ),
        ),
    )
    assert len(cases) == 2
    for key, assertions in cases:
        conflicts = _index(key, assertions).conflicts()
        assert len(conflicts) == 0

    undecidable = _index(
        ClaimKey("undetermined-bound"),
        (
            _assertion(57, valid_from=t1, valid_to=t3),
            _assertion(58, valid_from=None, valid_to=t3 + timedelta(days=1)),
        ),
    ).conflicts()
    assert len(undecidable) == 1
    assert undecidable[0].overlap is Overlap.UNDETERMINED


def test_add_order_cannot_change_temporal_answers_or_conflict_membership() -> None:
    first = _assertion(60, recorded_at=BASE + timedelta(days=2), valid_from=BASE)
    second = _assertion(61, recorded_at=BASE, valid_from=BASE)
    third = _assertion(62, recorded_at=BASE + timedelta(days=1), valid_from=None)
    assertions = (first, second, third)
    orders = (assertions, tuple(reversed(assertions)), (second, first, third))
    assert len(orders) == 3
    key = ClaimKey("order")
    observed = []
    for order in orders:
        index = _index(key, order)
        assert len(index.conflicts()) == 1
        observed.append((
            index.assertions(key),
            index.supersession(key),
            index.conflicts(),
            index.as_of(valid_at=BASE, recorded_as_of=BASE + timedelta(days=3)),
        ))
    assert len(observed) == 3
    assert observed[0] == observed[1] == observed[2]


def test_identical_content_ids_have_total_reproducible_history_and_conflict_order() -> None:
    shared = _assertion(63, recorded_at=BASE, text="same cited claim")
    same_content_different_id = replace(shared, id="asr_00000000000000000000000040")
    different_content = _assertion(65, recorded_at=BASE, text="different cited claim")
    assert shared.id != same_content_different_id.id
    assert shared.content_digest == same_content_different_id.content_digest
    assert shared.content_digest != different_content.content_digest

    key = ClaimKey("identical-content-order")
    added_shared_first = _index(
        key, (shared, same_content_different_id, different_content)
    )
    added_same_content_first = _index(
        key, (same_content_different_id, shared, different_content)
    )
    first_answers = (
        added_shared_first.assertions(key),
        added_shared_first.supersession(key),
        added_shared_first.conflicts(key),
    )
    second_answers = (
        added_same_content_first.assertions(key),
        added_same_content_first.supersession(key),
        added_same_content_first.conflicts(key),
    )
    assert first_answers == second_answers
    assert len(first_answers[2]) == 1
    assert _ids(first_answers[2][0].members) == tuple(
        assertion.id
        for assertion in sorted(
            (shared, same_content_different_id, different_content),
            key=lambda assertion: (assertion.content_digest, assertion.id),
        )
    )


def test_supersession_uses_recorded_time_only_and_keeps_every_assertion() -> None:
    newest_valid_early = _assertion(
        70,
        recorded_at=BASE + timedelta(days=3),
        valid_from=BASE,
        valid_to=BASE + timedelta(days=4),
    )
    oldest_valid_late = _assertion(
        71,
        recorded_at=BASE,
        valid_from=BASE + timedelta(days=2),
        valid_to=BASE + timedelta(days=3),
    )
    key = ClaimKey("history")
    index = _index(key, (newest_valid_early, oldest_valid_late))
    expected = (oldest_valid_late.id, newest_valid_early.id)
    assert _ids(index.supersession(key)) == expected
    assert _ids(index.assertions(key)) == expected
    answer = index.as_of(recorded_as_of=BASE + timedelta(days=4))
    assert _ids(answer.established) == expected
    assert len(index.conflicts(key)) == 1


def test_supersession_uses_content_digest_to_break_equal_recorded_times() -> None:
    earlier = _assertion(120, recorded_at=BASE, text="early")
    tied = (
        _assertion(121, recorded_at=BASE + timedelta(days=1), text="amber"),
        _assertion(122, recorded_at=BASE + timedelta(days=1), text="basil"),
        _assertion(123, recorded_at=BASE + timedelta(days=1), text="cedar"),
    )
    assert len(tied) == 3
    assert len({assertion.recorded_at for assertion in tied}) == 1
    digest_order = tuple(
        assertion.id for assertion in sorted(tied, key=lambda assertion: assertion.content_digest)
    )
    text_order = tuple(
        assertion.id for assertion in sorted(tied, key=lambda assertion: assertion.text)
    )
    assert digest_order != text_order
    index = _index(ClaimKey("tied-history"), (tied[2], earlier, tied[0], tied[1]))
    assert _ids(index.supersession(ClaimKey("tied-history"))) == (
        "asr_00000000000000000000000078",
        "asr_0000000000000000000000007A",
        "asr_0000000000000000000000007B",
        "asr_00000000000000000000000079",
    )


def test_conflicts_keep_both_distinct_cited_sides_and_report_undetermined_overlap() -> None:
    first = _assertion(80, valid_from=BASE, valid_to=BASE + timedelta(days=3))
    second = _assertion(81, valid_from=None, valid_to=BASE + timedelta(days=4))
    index = _index(ClaimKey("provenance"), (first, second))
    conflicts = index.conflicts()
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.overlap is Overlap.UNDETERMINED
    assert len(conflict.members) == 2
    assert {member.id for member in conflict.members} == {first.id, second.id}
    citations = tuple(member.citation for member in conflict.members)
    assert len(citations) == 2
    assert citations[0] != citations[1]


def test_conflict_count_and_maximal_group_are_pinned_by_the_hand_built_edges() -> None:
    # Reading this set gives edges 90--91 and 91--92; 93 is disjoint from all,
    # so transitive closure yields exactly one group of three.
    first = _assertion(
        90,
        recorded_at=BASE + timedelta(days=2),
        valid_from=BASE,
        valid_to=BASE + timedelta(days=2),
        text="alpha",
    )
    second = _assertion(
        91,
        recorded_at=BASE,
        valid_from=BASE + timedelta(days=1),
        valid_to=BASE + timedelta(days=3),
        text="beta",
    )
    third = _assertion(
        92,
        recorded_at=BASE + timedelta(days=1),
        valid_from=BASE + timedelta(days=2),
        valid_to=BASE + timedelta(days=4),
        text="gamma",
    )
    fourth = _assertion(93, valid_from=BASE + timedelta(days=5), valid_to=BASE + timedelta(days=6))
    index = _index(ClaimKey("groups"), (first, second, third, fourth))
    conflicts = index.conflicts()
    assert len(conflicts) == 1
    assert len(conflicts[0].members) == 3
    assert {member.id for member in conflicts[0].members} == {first.id, second.id, third.id}
    members = (first, second, third)
    recency_order = tuple(
        assertion.id for assertion in sorted(members, key=lambda assertion: assertion.recorded_at)
    )
    digest_order = tuple(
        assertion.id for assertion in sorted(members, key=lambda assertion: assertion.content_digest)
    )
    assert recency_order != digest_order
    member_digests = tuple(member.content_digest for member in conflicts[0].members)
    assert len(member_digests) == 3
    assert member_digests == (
        "229bd28931451eb53f3c07e3f38fab1479bd166cd9b016e3c569dc233251d76f",
        "32ad6d1725ae54ff53d0ddcb13234e7398ff2caf4214ff531ec393004c9dd306",
        "d982677fda1350f84966a0cc103f977f7b7a630d69fa47c8cbbe794631e6b7a7",
    )
    assert conflicts[0].overlap is Overlap.OVERLAPS


def test_no_public_temporal_name_or_conflict_field_can_express_a_resolution() -> None:
    import nous_os.temporal as temporal

    forbidden = ("winner", "preferred", "latest", "resolve", "resolver")
    scalar_types = (bool, int, float, complex)

    def public_attribute_names(value: object) -> frozenset[str]:
        return frozenset(name for name in dir(value) if not name.startswith("_"))

    def is_resolution_free(model: type[object]) -> bool:
        return all(
            not any(word in name.lower() for word in forbidden)
            for name in public_attribute_names(model)
        )

    def public_temporal_surface(module: object) -> frozenset[str]:
        module_names = {
            f"module:{name}" for name in public_attribute_names(module)
        }
        class_names = {
            f"{model.__name__}.{name}"
            for _, model in inspect.getmembers(module, inspect.isclass)
            if model.__module__ == temporal.__name__
            and not model.__name__.startswith("_")
            for name in public_attribute_names(model)
        }
        return frozenset((*module_names, *class_names))

    expected_surface = frozenset(
        {
            "module:AsOf",
            "module:AsOfRanking",
            "module:Assertion",
            "module:AssertionIdentityConflict",
            "module:ClaimKey",
            "module:ClaimKeyError",
            "module:Conflict",
            "module:Enum",
            "module:LifecycleState",
            "module:NonCanonicalAssertion",
            "module:Overlap",
            "module:RankingDivergence",
            "module:TemporalAssertionError",
            "module:TemporalError",
            "module:TemporalIndex",
            "module:TemporalTypeError",
            "module:annotations",
            "module:as_of_ranking",
            "module:dataclass",
            "module:datetime",
            "module:re",
            "module:timezone",
            "AsOf.established",
            "AsOf.excluded",
            "AsOf.undetermined",
            "AsOfRanking.excluded",
            "AsOfRanking.kept",
            "AsOfRanking.undetermined",
            "AssertionIdentityConflict.add_note",
            "AssertionIdentityConflict.args",
            "AssertionIdentityConflict.with_traceback",
            "ClaimKey.value",
            "ClaimKeyError.add_note",
            "ClaimKeyError.args",
            "ClaimKeyError.with_traceback",
            "Conflict.key",
            "Conflict.members",
            "Conflict.overlap",
            "NonCanonicalAssertion.add_note",
            "NonCanonicalAssertion.args",
            "NonCanonicalAssertion.with_traceback",
            "Overlap.DISJOINT",
            "Overlap.OVERLAPS",
            "Overlap.UNDETERMINED",
            "RankingDivergence.add_note",
            "RankingDivergence.args",
            "RankingDivergence.with_traceback",
            "TemporalAssertionError.add_note",
            "TemporalAssertionError.args",
            "TemporalAssertionError.with_traceback",
            "TemporalError.add_note",
            "TemporalError.args",
            "TemporalError.with_traceback",
            "TemporalIndex.add",
            "TemporalIndex.as_of",
            "TemporalIndex.assertions",
            "TemporalIndex.conflicts",
            "TemporalIndex.keys",
            "TemporalIndex.supersession",
            "TemporalTypeError.add_note",
            "TemporalTypeError.args",
            "TemporalTypeError.with_traceback",
        }
    )
    assert public_temporal_surface(temporal) == expected_surface

    public = public_attribute_names(temporal)
    assert public
    for name in public:
        assert not any(word in name.lower() for word in forbidden)
    public_classes = tuple(
        model
        for _, model in inspect.getmembers(temporal, inspect.isclass)
        if model.__module__ == temporal.__name__ and not model.__name__.startswith("_")
    )
    assert len(public_classes) > 0
    assert all(is_resolution_free(model) for model in public_classes)

    class ChosenProbe:
        @property
        def chosen(self) -> object:
            return object()

    class SafeProbe:
        def safe(self) -> None:
            pass

    def is_allowlisted(model: type[object], allowed: frozenset[str]) -> bool:
        return public_attribute_names(model) <= allowed

    assert not is_allowlisted(ChosenProbe, frozenset({"safe"}))
    assert is_allowlisted(SafeProbe, frozenset({"safe"}))

    def is_conflict_shape_safe(model: type[object]) -> bool:
        annotations = get_type_hints(model)
        return all(
            annotations[field.name] not in scalar_types for field in fields(model)
        )

    assert is_conflict_shape_safe(Conflict)

    class ResolvingProbe:
        def resolve(self) -> None:
            pass

    assert not is_resolution_free(ResolvingProbe)

    for scalar_type in scalar_types:
        ScalarConflict = dataclass(
            type(
                "ScalarConflict",
                (),
                {
                    "__annotations__": {
                        "key": ClaimKey,
                        "members": tuple[Assertion, ...],
                        "overlap": Overlap,
                        "resolution": scalar_type,
                    }
                },
            )
        )
        assert not is_conflict_shape_safe(ScalarConflict)


def test_as_of_ranking_preserves_caller_order_and_reports_divergence() -> None:
    first = _assertion(
        100,
        recorded_at=BASE + timedelta(days=1),
        valid_from=BASE,
        valid_to=BASE + timedelta(days=3),
        text="first established",
    )
    second = _assertion(
        101,
        recorded_at=BASE + timedelta(days=3),
        valid_from=BASE,
        valid_to=BASE + timedelta(days=3),
        text="second established",
    )
    third = _assertion(
        102,
        recorded_at=BASE + timedelta(days=2),
        valid_from=BASE,
        valid_to=BASE + timedelta(days=3),
        text="third established",
    )
    excluded = _assertion(
        103,
        valid_from=BASE + timedelta(days=2),
        valid_to=BASE + timedelta(days=3),
    )
    undetermined = _assertion(
        104, valid_from=None, valid_to=BASE + timedelta(days=3)
    )
    established = (first, second, third)
    index = _index(
        ClaimKey("ranking"), (*established, excluded, undetermined)
    )
    ranking = (second.id, excluded.id, third.id, undetermined.id, first.id)
    expected_kept = (
        "asr_00000000000000000000000065",
        "asr_00000000000000000000000066",
        "asr_00000000000000000000000064",
    )
    assert expected_kept != tuple(sorted(expected_kept))
    assert expected_kept != tuple(
        assertion.id
        for assertion in sorted(established, key=lambda assertion: assertion.content_digest)
    )
    assert expected_kept != tuple(
        assertion.id
        for assertion in sorted(established, key=lambda assertion: assertion.recorded_at)
    )
    answer = as_of_ranking(index, ranking, valid_at=BASE)
    assert answer == AsOfRanking(
        expected_kept,
        ("asr_00000000000000000000000067",),
        ("asr_00000000000000000000000068",),
    )
    with pytest.raises(RankingDivergence, match="asr_000000000000000000000000ZZ"):
        as_of_ranking(index, (first.id, "asr_000000000000000000000000ZZ"))
    with pytest.raises(RankingDivergence, match=first.id):
        as_of_ranking(index, (first.id, first.id))
    with pytest.raises(TemporalTypeError):
        as_of_ranking(index, [first.id])  # type: ignore[arg-type]
    with pytest.raises(TemporalTypeError):
        as_of_ranking(index, (UntrustedText(first.id),))  # type: ignore[arg-type]


def test_as_of_ranking_partition_is_total_disjoint_and_caller_ordered() -> None:
    t1 = BASE + timedelta(days=1)
    t2 = BASE + timedelta(days=2)
    assertions = (
        _assertion(105, valid_from=t1, valid_to=t2),
        _assertion(106, valid_from=None, valid_to=t2),
        _assertion(107, valid_from=t1, valid_to=None),
        _assertion(108, valid_from=None, valid_to=None),
    )
    index = _index(ClaimKey("ranking-partition"), assertions)
    ranking = (assertions[3].id, assertions[1].id, assertions[0].id, assertions[2].id)
    queries = tuple(
        (valid_at, recorded_at)
        for valid_at in (None, BASE, t1, t2)
        for recorded_at in (None, BASE - timedelta(seconds=1), BASE)
    )
    assert len(queries) == 12
    for valid_at, recorded_at in queries:
        answer = index.as_of(valid_at=valid_at, recorded_as_of=recorded_at)
        ranked = as_of_ranking(
            index,
            ranking,
            valid_at=valid_at,
            recorded_as_of=recorded_at,
        )
        assert type(ranked) is AsOfRanking
        expected = (
            tuple(item for item in ranking if item in _ids(answer.established)),
            tuple(item for item in ranking if item in _ids(answer.excluded)),
            tuple(item for item in ranking if item in _ids(answer.undetermined)),
        )
        assert (ranked.kept, ranked.excluded, ranked.undetermined) == expected
        partitions = (set(ranked.kept), set(ranked.excluded), set(ranked.undetermined))
        assert partitions[0] | partitions[1] | partitions[2] == set(ranking)
        assert partitions[0].isdisjoint(partitions[1])
        assert partitions[0].isdisjoint(partitions[2])
        assert partitions[1].isdisjoint(partitions[2])
        ranked_ids = (*ranked.kept, *ranked.excluded, *ranked.undetermined)
        assert tuple(item for item in ranking if item in set(ranked_ids)) == ranking
        with pytest.raises(FrozenInstanceError):
            ranked.kept = ()  # type: ignore[misc]


def test_temporal_reads_wrap_canonical_content_errors_with_the_assertion_identity() -> None:
    unnormalisable = datetime.max.replace(tzinfo=timezone(-timedelta(hours=1)))
    assertion = _assertion(109, valid_from=unnormalisable)
    key = ClaimKey("broken-canonical-content")
    index = _index(key, (assertion,))
    reads = (
        lambda: index.assertions(key),
        lambda: index.as_of(valid_at=BASE),
        lambda: index.conflicts(key),
    )
    for read in reads:
        with pytest.raises(TemporalAssertionError, match=assertion.id) as raised:
            read()
        assert isinstance(raised.value.__cause__, CanonicalError)


def test_query_instants_require_exact_timezone_aware_datetimes() -> None:
    index = _index(ClaimKey("instants"), (_assertion(110),))
    with pytest.raises(TemporalError):
        index.as_of(valid_at=datetime(2026, 1, 1))
    with pytest.raises(TemporalTypeError):
        index.as_of(recorded_as_of="2026-01-01")  # type: ignore[arg-type]
    with pytest.raises(TemporalTypeError):
        index.conflicts(key="instants")  # type: ignore[arg-type]
