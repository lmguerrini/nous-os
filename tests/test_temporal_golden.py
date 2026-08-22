"""Golden temporal cases transcribed from the Kestrel Bay fixture text."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey, Overlap, TemporalIndex


REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS = REPO_ROOT / "fixtures" / "synthetic" / "corpus"
B = datetime(2026, 1, 1, tzinfo=timezone.utc)
A = datetime(2026, 3, 20, tzinfo=timezone.utc)
C = datetime(2026, 4, 20, tzinfo=timezone.utc)
R5 = datetime(2026, 3, 25, tzinfo=timezone.utc)

SOURCE_IDS = {
    "notes/tides.md": "src_1",
    "notes/lighthouse.md": "src_2",
    "harbour-office.md": "src_3",
    "survey-five": "src_4",
    "survey-six": "src_5",
}

KEEPERS = "Before automation, three keepers\nworked a rotating watch."
AUTOMATED = "Automated in the spring of its ninetieth year."
OFFICE_RECORDS = "The harbour office has kept these records since the lighthouse was automated."
TIDES = "Local records kept by the harbour office describe a\nmean range of four metres, with spring tides reaching five."
TRANSFER = "The keepers' logbooks were transferred to the harbour office and are the source\nof the bay's earliest tide records."

# Literal transcriptions of the G-TIME query table in GOLDEN.md.
G_TIME_ROWS = (
    (
        "at-keeper-valid-from",
        {"valid_at": B},
        ("asr_00000000000000000000000101",),
        ("asr_00000000000000000000000103", "asr_00000000000000000000000104"),
        ("asr_00000000000000000000000102", "asr_00000000000000000000000105"),
    ),
    (
        "before-automation",
        {"valid_at": datetime(2026, 3, 19, tzinfo=timezone.utc)},
        ("asr_00000000000000000000000101",),
        ("asr_00000000000000000000000103", "asr_00000000000000000000000104"),
        ("asr_00000000000000000000000102", "asr_00000000000000000000000105"),
    ),
    (
        "at-automation",
        {"valid_at": A},
        (),
        ("asr_00000000000000000000000101", "asr_00000000000000000000000102"),
        (
            "asr_00000000000000000000000103",
            "asr_00000000000000000000000104",
            "asr_00000000000000000000000105",
        ),
    ),
    (
        "recorded-r5",
        {"recorded_as_of": R5},
        (
            "asr_00000000000000000000000101",
            "asr_00000000000000000000000102",
            "asr_00000000000000000000000103",
            "asr_00000000000000000000000105",
        ),
        ("asr_00000000000000000000000104",),
        (),
    ),
    (
        "both-axes-before-automation",
        {"valid_at": datetime(2026, 3, 19, tzinfo=timezone.utc), "recorded_as_of": R5},
        ("asr_00000000000000000000000101",),
        ("asr_00000000000000000000000103", "asr_00000000000000000000000104"),
        ("asr_00000000000000000000000102", "asr_00000000000000000000000105"),
    ),
)

# Literal transcriptions of every G-CONTRA row in GOLDEN.md.
G_CONTRA_ROWS = (
    ("tide-mean-2026", ("asr_00000000000000000000000201", "asr_00000000000000000000000202"), Overlap.OVERLAPS, True),
    ("tide-spring-range", ("asr_00000000000000000000000207", "asr_00000000000000000000000208"), Overlap.UNDETERMINED, True),
    ("tide-mean-2027", ("asr_00000000000000000000000209", "asr_00000000000000000000000210", "asr_00000000000000000000000211"), Overlap.OVERLAPS, True),
    ("keepers-watch", ("asr_00000000000000000000000203", "asr_00000000000000000000000204"), Overlap.DISJOINT, False),
    ("office-records and lighthouse-status", ("asr_00000000000000000000000205", "asr_00000000000000000000000206"), Overlap.OVERLAPS, False),
)


def _parse_ids(cell: str) -> frozenset[str]:
    if cell == "—":
        return frozenset()
    return frozenset(part.strip().strip("`") for part in cell.split(","))


def _parse_temporal_tables(text: str) -> dict[str, list[tuple]]:
    tables: dict[str, list[tuple]] = {
        "G-TIME-ASSERTIONS": [],
        "G-TIME": [],
        "G-CONTRA": [],
    }
    section = None
    table = None
    for line in text.splitlines():
        if line.startswith("## G-TIME"):
            section = "G-TIME"
            table = None
        elif line.startswith("## G-CONTRA"):
            section = "G-CONTRA"
            table = None
        elif line.startswith("## "):
            section = None
            table = None
        elif section == "G-TIME" and line.startswith(
            "| Assertion id | Validity | Recorded at | Why, from the text |"
        ):
            table = "G-TIME-ASSERTIONS"
        elif section == "G-TIME" and line.startswith("| Query | Established | Excluded | Undetermined |"):
            table = "G-TIME"
        elif section == "G-CONTRA" and line.startswith("| Claim key | Members | Overlap | Conflict? |"):
            table = "G-CONTRA"
        elif table and line.startswith("|") and not line.startswith("|---"):
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if table == "G-TIME-ASSERTIONS":
                tables[table].append(
                    (
                        cells[0].strip("` "),
                        cells[1].strip("` "),
                        cells[2].strip("` "),
                    )
                )
            elif table == "G-TIME":
                tables[table].append(
                    (cells[0], _parse_ids(cells[1]), _parse_ids(cells[2]), _parse_ids(cells[3]))
                )
            else:
                conflict = cells[3].lower()
                assert conflict in {"yes", "no"}, f"invalid Conflict? value: {cells[3]!r}"
                tables[table].append(
                    (cells[0], _parse_ids(cells[1]), cells[2].strip("` "), conflict == "yes")
                )
    return tables


def _query_label(query: dict[str, datetime]) -> str:
    return "; ".join(
        f"{axis}={query[axis].isoformat()}"
        for axis in ("valid_at", "recorded_as_of")
        if axis in query
    )


def _expected_temporal_tables(time_rows=G_TIME_ROWS, contra_rows=G_CONTRA_ROWS) -> tuple[Counter, Counter]:
    expected_time = Counter(
        (
            _query_label(query),
            frozenset(established),
            frozenset(excluded),
            frozenset(undetermined),
        )
        for _, query, established, excluded, undetermined in time_rows
    )
    expected_contra = Counter(
        (key, frozenset(member_ids), overlap.value, is_conflict)
        for key, member_ids, overlap, is_conflict in contra_rows
    )
    return expected_time, expected_contra


def _fixture_instant_label(value: datetime | None) -> str:
    if value is None:
        return ""
    if value == B:
        return "B"
    if value == A:
        return "A"
    return value.isoformat()


def _executable_g_time_assertion_rows() -> list[tuple[str, str, str]]:
    rows = []
    for assertion in sorted(_time_index()._all_assertions(), key=lambda item: item.id):
        validity = (
            f"[{_fixture_instant_label(assertion.valid_from)}, "
            f"{_fixture_instant_label(assertion.valid_to)})"
        )
        rows.append(
            (
                assertion.id,
                validity,
                _fixture_instant_label(assertion.recorded_at),
            )
        )
    return rows


def _temporal_tables_match(
    tables: dict[str, list[tuple]], time_rows=G_TIME_ROWS, contra_rows=G_CONTRA_ROWS
) -> bool:
    expected_time, expected_contra = _expected_temporal_tables(time_rows, contra_rows)
    return (
        tables["G-TIME-ASSERTIONS"] == _executable_g_time_assertion_rows()
        and Counter(tables["G-TIME"]) == expected_time
        and Counter(tables["G-CONTRA"]) == expected_contra
    )


def _published_temporal_tables() -> dict[str, list[tuple]]:
    return _parse_temporal_tables(
        (REPO_ROOT / "fixtures" / "synthetic" / "GOLDEN.md").read_text(encoding="utf-8")
    )


def _citation(document: str, sentence: str) -> Citation:
    payload = (CORPUS / document).read_bytes()
    span = sentence.encode("utf-8")
    start = payload.index(span)
    return Citation(SOURCE_IDS[document], "a" * 64, Locator(start, start + len(span)), sentence)


def _survey_citation(source: str, sentence: str) -> Citation:
    return Citation(SOURCE_IDS[source], "b" * 64 if source == "survey-five" else "c" * 64, Locator(0, len(sentence)), sentence)


def _assertion(
    assertion_id: str,
    text: str,
    citation: Citation,
    recorded_at: datetime,
    valid_from: datetime | None,
    valid_to: datetime | None,
) -> Assertion:
    return Assertion(
        id=assertion_id,
        text=text,
        citation=citation,
        support=SupportClass.DIRECT_QUOTE,
        recorded_at=recorded_at,
        state=LifecycleState.CANONICAL,
        valid_from=valid_from,
        valid_to=valid_to,
    )


def _time_index() -> TemporalIndex:
    index = TemporalIndex()
    keepers = _citation("notes/lighthouse.md", KEEPERS)
    office = _citation("notes/tides.md", OFFICE_RECORDS)
    transfer = _citation("notes/lighthouse.md", TRANSFER)
    rows = (
        ("keepers", _assertion("asr_00000000000000000000000101", "Three keepers worked a rotating watch before automation.", keepers, B, B, A)),
        ("keepers-unknown-start", _assertion("asr_00000000000000000000000102", "Three keepers worked a rotating watch before automation.", keepers, B, None, A)),
        ("office-records", _assertion("asr_00000000000000000000000103", "The harbour office has kept tide records since automation.", office, datetime(2026, 3, 21, tzinfo=timezone.utc), A, None)),
        ("office-records-late", _assertion("asr_00000000000000000000000104", "The harbour office has kept tide records since automation.", office, datetime(2026, 3, 30, tzinfo=timezone.utc), A, None)),
        ("keepers-logbooks", _assertion("asr_00000000000000000000000105", "The keepers' logbooks were transferred to the harbour office.", transfer, datetime(2026, 3, 22, tzinfo=timezone.utc), None, None)),
    )
    assert len(rows) == 5
    for key, assertion in rows:
        index.add(ClaimKey(key), assertion)
    return index


def _contra_index() -> TemporalIndex:
    index = TemporalIndex()
    tides = _citation("notes/tides.md", TIDES)
    keepers = _citation("notes/lighthouse.md", KEEPERS)
    automated = _citation("notes/lighthouse.md", AUTOMATED)
    office = _citation("notes/tides.md", OFFICE_RECORDS)
    survey_five = _survey_citation("survey-five", "A 2026 survey reports a mean range of five metres.")
    survey_six = _survey_citation("survey-six", "A 2027 survey reports a mean range of six metres.")
    rows = (
        ("tide-mean-2026", _assertion("asr_00000000000000000000000201", "Kestrel Bay has a mean tidal range of four metres.", tides, B, B, C)),
        ("tide-mean-2026", _assertion("asr_00000000000000000000000202", "Kestrel Bay has a mean tidal range of five metres.", survey_five, C, A, C)),
        ("keepers-watch", _assertion("asr_00000000000000000000000203", "Three keepers worked a rotating watch.", keepers, B, B, A)),
        ("keepers-watch", _assertion("asr_00000000000000000000000204", "The lighthouse was automated.", automated, A, A, C)),
        ("office-records", _assertion("asr_00000000000000000000000205", "The harbour office has tide records.", office, A, A, C)),
        ("lighthouse-status", _assertion("asr_00000000000000000000000206", "The lighthouse was automated.", automated, A, A, C)),
        ("tide-spring-range", _assertion("asr_00000000000000000000000207", "Spring tides reach five metres.", tides, B, A, C)),
        ("tide-spring-range", _assertion("asr_00000000000000000000000208", "Spring tides reach six metres.", survey_six, C, None, C)),
        ("tide-mean-2027", _assertion("asr_00000000000000000000000209", "Kestrel Bay has a mean tidal range of four metres.", tides, B, A, C)),
        ("tide-mean-2027", _assertion("asr_00000000000000000000000210", "Kestrel Bay has a mean tidal range of five metres.", survey_five, A, A, C)),
        ("tide-mean-2027", _assertion("asr_00000000000000000000000211", "Kestrel Bay has a mean tidal range of six metres.", survey_six, C, A, C)),
    )
    assert len(rows) == 11
    for key, assertion in rows:
        index.add(ClaimKey(key), assertion)
    return index


def _ids(assertions: tuple[Assertion, ...]) -> set[str]:
    return {assertion.id for assertion in assertions}


def test_g_time_partitions_the_documented_assertions() -> None:
    assert len(G_TIME_ROWS) == 5
    index = _time_index()
    for name, query, established, excluded, undetermined in G_TIME_ROWS:
        answer = index.as_of(**query)
        assert _ids(answer.established) == set(established), name
        assert _ids(answer.excluded) == set(excluded), name
        assert _ids(answer.undetermined) == set(undetermined), name


def test_g_contra_reports_the_documented_groups_and_every_cited_side() -> None:
    assert len(G_CONTRA_ROWS) == 5
    index = _contra_index()
    conflicts = index.conflicts()
    assert len(conflicts) != 0, "NOT_RUN: G-CONTRA produced no conflicts"
    assert len(conflicts) == 3
    by_key = {conflict.key.value: conflict for conflict in conflicts}
    expected_conflict_keys = {key for key, _, _, is_conflict in G_CONTRA_ROWS if is_conflict}
    assert set(by_key) == expected_conflict_keys
    for key, member_ids, overlap, is_conflict in G_CONTRA_ROWS:
        if not is_conflict:
            keys = (
                ("office-records", "lighthouse-status")
                if key == "office-records and lighthouse-status"
                else (key,)
            )
            for isolated_key in keys:
                assert isolated_key not in by_key, isolated_key
            continue
        conflict = by_key[key]
        assert _ids(conflict.members) == set(member_ids), key
        assert conflict.overlap is overlap, key
        citations = tuple(member.citation for member in conflict.members)
        assert all(type(citation) is Citation for citation in citations), key
        assert len(set(citations)) == len(citations), key


def test_the_published_temporal_tables_are_the_executable_cases() -> None:
    tables = _published_temporal_tables()
    assert (
        tables["G-TIME-ASSERTIONS"] and tables["G-TIME"] and tables["G-CONTRA"]
    ), "no rows parsed; the document shape changed"
    assert len(tables["G-TIME-ASSERTIONS"]) == 5
    assert len(tables["G-TIME"]) == 5
    assert len(tables["G-CONTRA"]) == 5
    assert sum(row[3] for row in tables["G-CONTRA"]) == 3
    assert _temporal_tables_match(tables)


def test_the_temporal_document_comparison_rejects_a_wrong_expectation() -> None:
    sample = (
        "## G-TIME\n\n"
        "| Assertion id | Validity | Recorded at | Why, from the text |\n"
        "|---|---|---|---|\n"
        "| asr_right | `[B, A)` | `B` | sample |\n\n"
        "| Query | Established | Excluded | Undetermined |\n"
        "|---|---|---|---|\n"
        "| valid_at=2026-01-01T00:00:00+00:00 | `asr_right` | — | — |\n"
    )
    tables = _parse_temporal_tables(sample)
    assert tables["G-TIME-ASSERTIONS"] == [("asr_right", "[B, A)", "B")]
    assert tables["G-TIME"] == [
        (
            "valid_at=2026-01-01T00:00:00+00:00",
            frozenset({"asr_right"}),
            frozenset(),
            frozenset(),
        )
    ]
    wrong_time = (("sample", {"valid_at": B}, ("asr_wrong",), (), ()),)
    assert not _temporal_tables_match(tables, wrong_time, ())
