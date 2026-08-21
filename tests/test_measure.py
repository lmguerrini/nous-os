"""The measuring instrument, and the alias layer it measures.

**A warning this suite encodes rather than states in prose.** The public fixture
set is four documents, built so the cross-language mechanism is visible at all.
Both alias derivations rescue every miss in it, and that number means nothing
about either derivation: the measured figure this project holds comes from a
private corpus that is not published here, and a toy fixture returning 100%
must never be read as beating it. A test below asserts that the public fixture
is small enough that nobody could mistake it for a benchmark.

The other thing this suite exists to protect is the third outcome. A run whose
corpus is absent reports `NOT_RUN`, not an empty pass, and a rescue rate with no
denominator is `None` rather than `0.0`. Later capabilities cite these numbers.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import nous_os
from nous_os.aliases import (
    AliasError,
    AliasTable,
    CorpusDerivedAliases,
    HandGlossary,
    NoAliases,
    expand_query,
    normalise,
)
from nous_os.derived import build
from nous_os.identity import digest_bytes
from nous_os.measure import (
    CaseResult,
    GoldenCase,
    MeasurementError,
    Outcome,
    RunStatus,
    measure_rescue,
    not_run,
    run_golden,
)
from nous_os.ledger import Ledger, ingest
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText

REPO_ROOT = Path(__file__).resolve().parent.parent
BILINGUAL = REPO_ROOT / "fixtures" / "synthetic" / "bilingual"
T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _sid(tail: str) -> str:
    return "src_" + tail.rjust(26, "0")


DOCS = {
    "en-tides": _sid("ENTDES"),
    "it-maree": _sid("TMAREE"),
    "en-lighthouse": _sid("ENGHTHSE"),
    "it-faro": _sid("TFAR"),
}

# Expectations read from the fixture text, not recorded from a run.
G_RETR = (
    GoldenCase("tide", (DOCS["en-tides"],), exact=True),
    GoldenCase("marea", (DOCS["it-maree"],), exact=True),
    GoldenCase("lighthouse", (DOCS["en-lighthouse"],), exact=True),
    GoldenCase("faro", (DOCS["it-faro"],), exact=True),
)
G_ITEN = (
    GoldenCase("tide", (DOCS["en-tides"], DOCS["it-maree"])),
    GoldenCase("lighthouse", (DOCS["en-lighthouse"], DOCS["it-faro"])),
)


def _indexed() -> Path:
    base = Path(tempfile.mkdtemp())
    store = SnapshotStore(base / "snapshots")
    ledger = Ledger(base / "ledger.jsonl")
    for day, (name, source_id) in enumerate(DOCS.items()):
        text = (BILINGUAL / f"{name}.md").read_text(encoding="utf-8")
        ingest(store, ledger, source_id, UntrustedText(text), T0 + timedelta(days=day))
    path = base / "index.db"
    build(store, ledger, path)
    return path


def _hand() -> HandGlossary:
    return HandGlossary({"tide": "marea", "lighthouse": "faro"})


def _corpus() -> CorpusDerivedAliases:
    pairs = tuple(
        (
            (BILINGUAL / f"{left}.md").read_text(encoding="utf-8"),
            (BILINGUAL / f"{right}.md").read_text(encoding="utf-8"),
        )
        for left, right in (("en-tides", "it-maree"), ("en-lighthouse", "it-faro"))
    )
    return CorpusDerivedAliases.from_aligned_pairs(pairs)


# --- the honesty guard -----------------------------------------------------


def test_the_public_fixture_is_too_small_to_be_a_benchmark() -> None:
    """Guard against the number in this suite being cited as a result.

    Both derivations rescue everything here. That is a property of a four-
    document fixture, not of either derivation, and the measured figure that
    matters was taken on a corpus this repository does not contain.
    """
    documents = sorted(BILINGUAL.glob("*.md"))
    assert len(documents) == 4, (
        "the public fixture has grown large enough to be mistaken for a benchmark; "
        "if it is meant to be one, it needs preregistered expectations, not this guard"
    )
    text = (REPO_ROOT / "fixtures" / "synthetic" / "GOLDEN.md").read_text(encoding="utf-8")
    assert "derived from the fixture text, not from a run" in text


# --- E1: G-RETR ------------------------------------------------------------


def test_exact_retrieval_reproduces_the_documented_expectations() -> None:
    result = run_golden(_indexed(), G_RETR, NoAliases())
    assert result.status is RunStatus.COMPLETE
    assert result.hits == len(G_RETR)
    assert result.misses == ()


def test_exact_retrieval_returns_only_the_documented_documents() -> None:
    """A system returning everything would score four hits and be useless."""
    result = run_golden(_indexed(), G_RETR, NoAliases())
    for case in result.results:
        assert set(case.found) == set(case.expected), (
            f"{case.query!r} returned {sorted(case.found)}, "
            f"documented expectation is {sorted(case.expected)}"
        )


# --- E2: determinism -------------------------------------------------------


def test_two_runs_of_the_same_cases_agree_exactly() -> None:
    path = _indexed()
    assert run_golden(path, G_RETR, NoAliases()).digest == run_golden(
        path, G_RETR, NoAliases()
    ).digest


def test_the_outcome_record_is_identical_in_a_fresh_process() -> None:
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        f"sys.path.insert(0,{str(Path(__file__).parent)!r});"
        "from test_measure import _indexed, G_RETR;"
        "from nous_os.aliases import NoAliases;"
        "from nous_os.measure import run_golden;"
        "print(run_golden(_indexed(), G_RETR, NoAliases()).digest)"
    )
    observed = set()
    for seed in ("0", "3", "9"):
        environment = dict(os.environ, PYTHONHASHSEED=seed, TZ="Pacific/Kiritimati", LC_ALL="C")
        observed.add(
            subprocess.run(
                [sys.executable, "-c", program], capture_output=True, text=True,
                env=environment, check=True,
            ).stdout.strip()
        )
    assert observed == {run_golden(_indexed(), G_RETR, NoAliases()).digest}


# --- E3: the alias layer is pluggable and chooses nothing ------------------


def test_the_module_names_no_default_derivation() -> None:
    """A default would be the unproven promotion this layer exists to prevent."""
    import nous_os.aliases as module

    exported = {name.lower() for name in dir(module) if not name.startswith("_")}
    for forbidden in ("default", "default_aliases", "recommended", "preferred"):
        assert forbidden not in exported, f"the module exposes {forbidden!r}"


@pytest.mark.parametrize("build_table", [NoAliases, _hand, _corpus], ids=["none", "hand", "corpus"])
def test_every_derivation_satisfies_one_interface(build_table) -> None:
    table = build_table()
    assert isinstance(table, AliasTable)
    assert isinstance(table.name, str) and table.name
    assert table.expand("tide") == tuple(sorted(table.expand("tide")))


def test_a_derivation_never_returns_the_term_it_was_given() -> None:
    for table in (NoAliases(), _hand(), _corpus()):
        assert "tide" not in table.expand("tide")


def test_the_two_derivations_agree_on_this_fixture_and_that_proves_nothing() -> None:
    """Recorded as a fact about the fixture, not as a comparison of derivations."""
    assert _hand().expand("tide") == _corpus().expand("tide") == ("marea",)


# --- E4: the measurement ---------------------------------------------------


def test_the_baseline_misses_the_cross_language_documents_by_construction() -> None:
    baseline = run_golden(_indexed(), G_ITEN, NoAliases())
    assert len(baseline.misses) == len(G_ITEN)
    for case in baseline.misses:
        assert case.missing, "a miss must name what it did not find"


@pytest.mark.parametrize("build_table", [_hand, _corpus], ids=["hand", "corpus"])
def test_a_derivation_rescues_and_the_measurement_reports_both_counts(build_table) -> None:
    path = _indexed()
    baseline = run_golden(path, G_ITEN, NoAliases())
    measured = measure_rescue(baseline, run_golden(path, G_ITEN, build_table()))
    assert measured.status is RunStatus.COMPLETE
    assert measured.baseline_misses == len(G_ITEN)
    assert measured.rescued == len(G_ITEN)
    assert f"{measured.rescued}/{measured.baseline_misses}" in measured.describe()


def test_a_derivation_that_loses_a_case_refuses_to_report_a_rate() -> None:
    """The baseline must have misses, or this passes for the wrong reason.

    An earlier version built its baseline from cases that all hit, so
    `baseline_misses` was zero and `rate is None` was satisfied by the
    *denominator* clause. The status clause was dead, and deleting it left the
    suite green while a refused measurement reported `0.0`.
    """
    path = _indexed()
    # Exact, because expansion only ever *adds* documents: under a containment
    # rule an alias layer cannot lose a case, so the losing state this test
    # exists for is only reachable where extra results are themselves a failure.
    kept = GoldenCase("marea", (DOCS["it-maree"],), exact=True)
    unrescuable = GoldenCase("tide", (DOCS["en-tides"], DOCS["it-faro"]))
    cases = (kept, unrescuable)

    baseline = run_golden(path, cases, NoAliases())
    assert [c.outcome for c in baseline.results] == [Outcome.HIT, Outcome.MISS]

    # This derivation drags a second document into an exact case the baseline
    # answered correctly, and rescues nothing.
    losing = HandGlossary({"marea": "tide"})
    candidate = run_golden(path, cases, losing)
    measured = measure_rescue(baseline, candidate)

    assert measured.status is RunStatus.NOT_RUN
    assert measured.baseline_misses > 0, "the dead-clause bug hides when there are no misses"
    assert measured.rate is None
    assert "lost" in (measured.reason or "")


def test_a_partial_rescue_reports_the_real_numerator_and_denominator() -> None:
    """Every other rescue case rescues everything, so numerator, denominator and
    total are indistinguishable and a constant satisfies all three."""
    path = _indexed()
    baseline = run_golden(path, G_ITEN, NoAliases())
    assert len(baseline.misses) == 2
    half = HandGlossary({"tide": "marea"})  # says nothing about lighthouse/faro
    measured = measure_rescue(baseline, run_golden(path, G_ITEN, half))
    assert measured.status is RunStatus.COMPLETE
    assert (measured.rescued, measured.baseline_misses) == (1, 2)
    assert measured.rate == 0.5
    assert "1/2" in measured.describe()
    assert "2/2" not in measured.describe()


def test_a_run_with_a_mix_of_hits_and_misses_counts_only_the_misses() -> None:
    path = _indexed()
    mixed = (
        GoldenCase("marea", (DOCS["it-maree"],)),
        GoldenCase("faro", (DOCS["it-faro"],)),
        G_ITEN[0],
    )
    baseline = run_golden(path, mixed, NoAliases())
    assert baseline.hits == 2 and len(baseline.misses) == 1
    measured = measure_rescue(baseline, run_golden(path, mixed, _hand()))
    assert (measured.rescued, measured.baseline_misses) == (1, 1)


def test_two_runs_over_different_cases_cannot_be_compared() -> None:
    path = _indexed()
    with pytest.raises(MeasurementError):
        measure_rescue(run_golden(path, G_RETR, NoAliases()), run_golden(path, G_ITEN, NoAliases()))


# --- E5: not-run is a third answer ----------------------------------------


def test_a_run_without_a_corpus_reports_not_run_rather_than_a_pass() -> None:
    result = run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, NoAliases())
    assert result.status is RunStatus.NOT_RUN
    assert result.hits == 0
    assert result.reason
    assert result.results == (), "a run that did not happen has no case results"


def test_a_rate_with_no_denominator_is_none_and_not_zero() -> None:
    path = _indexed()
    absent = run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, NoAliases())
    measured = measure_rescue(absent, run_golden(path, G_ITEN, _hand()))
    assert measured.status is RunStatus.NOT_RUN
    assert measured.rate is None
    assert "NOT RUN" in measured.describe()


def test_a_not_run_result_must_say_why() -> None:
    with pytest.raises(MeasurementError):
        not_run("hand-glossary", "   ")


def test_a_run_over_no_cases_is_refused() -> None:
    """An empty run scores perfectly and means nothing."""
    with pytest.raises(MeasurementError):
        run_golden(_indexed(), (), NoAliases())


# --- refusals --------------------------------------------------------------


@pytest.mark.parametrize(
    "query,expect",
    [("", ("src_" + "A" * 26,)), ("   ", ("src_" + "A" * 26,)), ("tide", ()),
     ("tide", ("src_" + "A" * 26, "src_" + "A" * 26))],
    ids=["empty query", "blank query", "no expectation", "duplicate expectation"],
)
def test_a_malformed_golden_case_is_refused(query: str, expect: tuple) -> None:
    with pytest.raises(MeasurementError):
        GoldenCase(query, expect)


@pytest.mark.parametrize("pairs", [{"a": "a"}, {"": "b"}, {"a": ""}, "not a mapping"])
def test_a_malformed_glossary_is_refused(pairs: object) -> None:
    with pytest.raises(AliasError):
        HandGlossary(pairs)  # type: ignore[arg-type]


def test_expand_query_refuses_a_query_with_no_terms() -> None:
    with pytest.raises(AliasError):
        expand_query(NoAliases(), "!!! ---")


def test_normalise_folds_case_and_lookalikes_but_nothing_stored_changes() -> None:
    assert normalise("Marea") == normalise("marea") == "marea"
    assert normalise("ﬁ") == "fi"


# --- ordering and normalisation, which single-term lowercase cases hide ----
#
# A mutation sweep found all three of these unguarded. Every golden query above
# is one lowercase word, so expansion order cannot vary, result order cannot
# vary, and case folding is never exercised. This is the same class of gap that
# has now appeared in four capabilities of this project: something derived from
# a set reaches output, and the fixture is too simple to show it.

_MULTI = "Marea Tide Faro"


def test_query_expansion_returns_an_exact_sorted_tuple() -> None:
    """The expansion is built from a set, so its order is a per-process accident
    unless it is sorted. Asserted as a literal, not compared with itself."""
    assert expand_query(_hand(), _MULTI) == ("faro", "lighthouse", "marea", "tide")


def test_query_expansion_is_identical_across_processes() -> None:
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        f"sys.path.insert(0,{str(Path(__file__).parent)!r});"
        "from test_measure import _hand, _MULTI;"
        "from nous_os.aliases import expand_query;"
        "print(','.join(expand_query(_hand(), _MULTI)))"
    )
    observed = set()
    for seed in ("0", "1", "2", "3", "4", "5", "6", "7"):
        observed.add(
            subprocess.run(
                [sys.executable, "-c", program], capture_output=True, text=True,
                env=dict(os.environ, PYTHONHASHSEED=seed), check=True,
            ).stdout.strip()
        )
    assert len(observed) == 1, f"expansion order varies across hash seeds: {observed}"


def test_a_query_matching_several_documents_returns_them_in_a_fixed_order() -> None:
    """Result order is accumulated across expansion terms; without a sort it
    follows whichever term happened to be searched first."""
    path = _indexed()
    case = GoldenCase(_MULTI, (DOCS["en-tides"], DOCS["it-maree"], DOCS["it-faro"]))
    result = run_golden(path, (case,), _hand())
    found = result.results[0].found
    assert len(found) >= 3, "the fixture must return several documents to show an order"
    assert list(found) == sorted(found)
    for _ in range(3):
        assert run_golden(path, (case,), _hand()).results[0].found == found


def test_terms_are_matched_regardless_of_case() -> None:
    """Every fixture query is lowercase, so folding was never exercised."""
    glossary = _hand()
    assert glossary.expand("MAREA") == glossary.expand("marea") == ("tide",)
    assert glossary.expand("Faro") == ("lighthouse",)


def test_a_corpus_derivation_folds_case_when_pairing_terms() -> None:
    derived = CorpusDerivedAliases.from_aligned_pairs((("The Tide rises", "La Marea sale"),))
    assert derived.expand("tide") == derived.expand("TIDE")
    assert derived.expand("tide") != ()


# --- the digest must be a function of the run, not a constant --------------
#
# Both determinism tests above compare a digest with another digest of the same
# thing, so a constant satisfies them. Six mutants rode on that: the digest, the
# serialisation, and four payload fields could each be replaced and the suite
# stayed green.


def test_runs_that_differ_produce_different_digests() -> None:
    path = _indexed()
    digests = {
        run_golden(path, G_RETR, NoAliases()).digest,
        run_golden(path, G_ITEN, NoAliases()).digest,
        run_golden(path, G_ITEN, _hand()).digest,
        run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, NoAliases()).digest,
    }
    assert len(digests) == 4, "runs differing in cases, derivation or status share a digest"


def test_the_payload_carries_every_field_a_reader_would_check() -> None:
    payload = run_golden(_indexed(), G_ITEN, _hand()).as_payload()
    assert payload["status"] == "complete"
    assert payload["derivation"] == "hand-glossary"
    assert len(payload["cases"]) == len(G_ITEN)
    first = payload["cases"][0]
    assert first["query"] == G_ITEN[0].query
    assert set(first["expected"]) == set(G_ITEN[0].expect)
    assert first["found"], "the payload records nothing about what was found"
    assert first["outcome"] in {"hit", "miss"}


def test_the_serialised_form_is_not_empty_and_round_trips_to_the_digest() -> None:
    result = run_golden(_indexed(), G_ITEN, _hand())
    raw = result.to_bytes()
    assert len(raw) > 100
    assert digest_bytes(raw) == result.digest


# --- a run that did not happen cannot be read as a pass -------------------


def test_a_not_run_result_reports_none_rather_than_a_vacuous_pass() -> None:
    """`not r.misses`, `r.hits == len(r.results)` and an `all(...)` over an
    empty tuple are all True for a run that never happened. `passed` is the
    reading that cannot be taken without consulting the status."""
    absent = run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, NoAliases())
    assert not absent.misses and absent.hits == len(absent.results)  # the vacuous readings
    assert absent.passed is None
    assert run_golden(_indexed(), G_RETR, NoAliases()).passed is True
    assert run_golden(_indexed(), G_ITEN, NoAliases()).passed is False


@pytest.mark.parametrize(
    "prepare",
    [
        lambda p: p.write_bytes(b""),
        lambda p: p.write_bytes(b"not a database at all" * 40),
        lambda p: None,
    ],
    ids=["zero-byte", "garbage", "absent"],
)
def test_an_unreadable_store_is_a_run_that_did_not_happen(prepare) -> None:
    """SQLite accepts a zero-byte file as a valid empty database, so every query
    against one fails with "no such table" — and a loop that skipped unparseable
    terms skipped all of them and reported a completed run over nothing."""
    path = Path(tempfile.mkdtemp()) / "store.db"
    prepare(path)
    result = run_golden(path, G_ITEN, NoAliases())
    assert result.status is RunStatus.NOT_RUN
    assert result.passed is None
    assert result.reason
    measured = measure_rescue(result, run_golden(_indexed(), G_ITEN, _hand()))
    assert measured.status is RunStatus.NOT_RUN
    assert measured.rate is None


def test_a_bad_query_term_is_skipped_but_a_bad_store_is_not() -> None:
    """The distinction the collapse destroyed."""
    path = _indexed()
    with_bad_term = GoldenCase('tide "', (DOCS["en-tides"],))
    result = run_golden(path, (with_bad_term,), NoAliases())
    assert result.status is RunStatus.COMPLETE, "an unparseable term is not a broken store"


def test_the_candidate_failing_to_run_is_reported_too() -> None:
    baseline = run_golden(_indexed(), G_ITEN, NoAliases())
    absent = run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, _hand())
    measured = measure_rescue(baseline, absent)
    assert measured.status is RunStatus.NOT_RUN
    assert "candidate" in (measured.reason or "")


def test_a_candidate_covering_extra_cases_is_refused() -> None:
    path = _indexed()
    baseline = run_golden(path, G_ITEN, NoAliases())
    with pytest.raises(MeasurementError):
        measure_rescue(baseline, run_golden(path, G_ITEN + (G_RETR[1],), _hand()))


def test_a_case_set_with_a_repeated_case_is_refused() -> None:
    with pytest.raises(MeasurementError):
        run_golden(_indexed(), (G_ITEN[0], G_ITEN[0]), NoAliases())


def test_a_case_expecting_something_that_is_not_an_identifier_is_refused() -> None:
    """A typo in an expectation is otherwise a permanent, silent miss."""
    for bad in ((None,), (123,), ("",), ("   ",)):
        with pytest.raises(MeasurementError):
            GoldenCase("tide", bad)  # type: ignore[arg-type]


# --- the documented criterion, encoded in the instrument ------------------


def test_an_exact_case_refuses_extra_documents() -> None:
    """The published criterion says "and no other". A containment rule would
    score a system returning everything as a perfect run."""
    path = _indexed()
    loose = GoldenCase("tide", (DOCS["en-tides"],))
    strict = GoldenCase("tide", (DOCS["en-tides"],), exact=True)
    assert run_golden(path, (loose,), _hand()).results[0].outcome is Outcome.HIT
    assert run_golden(path, (strict,), _hand()).results[0].outcome is Outcome.MISS


# --- the published golden file is load-bearing ----------------------------


def _parse_golden_tables() -> dict[str, list[tuple[str, tuple[str, ...]]]]:
    """Read the expectations out of the published document."""
    text = (REPO_ROOT / "fixtures" / "synthetic" / "GOLDEN.md").read_text(encoding="utf-8")
    section = None
    tables: dict[str, list[tuple[str, tuple[str, ...]]]] = {"G-RETR": [], "G-ITEN": []}
    for line in text.splitlines():
        if line.startswith("## G-RETR"):
            section = "G-RETR"
        elif line.startswith("## G-ITEN"):
            section = "G-ITEN"
        elif section and line.startswith("| `"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            query = cells[0].strip("` ")
            expect = tuple(name.strip("` ") for name in cells[1].split(","))
            tables[section].append((query, expect))
    return tables


def test_the_executable_cases_are_the_documented_ones() -> None:
    """A golden file with no machine link to the code cannot fail either.

    Every documented row could be inverted, or deleted, with the suite green.
    The published document is what downstream work cites, so it is parsed here
    and compared against the cases that actually run.
    """
    tables = _parse_golden_tables()
    assert tables["G-RETR"] and tables["G-ITEN"], "no rows parsed; the document shape changed"

    documented_retr = {(q, tuple(sorted(DOCS[n] for n in e))) for q, e in tables["G-RETR"]}
    executed_retr = {(c.query, tuple(sorted(c.expect))) for c in G_RETR}
    assert documented_retr == executed_retr

    documented_iten = {(q, tuple(sorted(DOCS[n] for n in e))) for q, e in tables["G-ITEN"]}
    executed_iten = {(c.query, tuple(sorted(c.expect))) for c in G_ITEN}
    assert documented_iten == executed_iten


def test_every_documented_document_name_exists_as_a_fixture() -> None:
    for rows in _parse_golden_tables().values():
        for _, expect in rows:
            for name in expect:
                assert (BILINGUAL / f"{name}.md").is_file(), f"{name} is documented but absent"


def test_a_case_outcome_is_one_of_exactly_two_answers() -> None:
    """A third member was carried here and had no reachable cause.

    Terms are case-folded before they reach the index and the query language
    rejects reserved words only in upper case, so no expansion can produce a
    case where nothing was asked. "Did not run" belongs to the run.
    """
    assert {member.value for member in Outcome} == {"hit", "miss"}
    result = run_golden(_indexed(), G_ITEN, NoAliases())
    assert all(r.outcome in (Outcome.HIT, Outcome.MISS) for r in result.results)


# --- alias-layer contracts the single-alias fixture could not exercise ----


def test_an_expansion_with_several_aliases_is_sorted() -> None:
    """Every fixture value is a one-tuple, so the sort contract reduced to a
    tautology on a singleton."""
    many = HandGlossary({"tide": "marea", "marea": "zephyr", "aqua": "marea"})
    expanded = many.expand("marea")
    assert len(expanded) >= 3
    assert list(expanded) == sorted(expanded)


def test_expansion_order_holds_across_processes_for_several_aliases() -> None:
    package_root = str(Path(nous_os.__file__).resolve().parent.parent)
    program = (
        f"import sys;sys.path.insert(0,{package_root!r});"
        "from nous_os.aliases import HandGlossary;"
        "g=HandGlossary({'tide':'marea','marea':'zephyr','aqua':'marea','marea2':'x'});"
        "print(','.join(g.expand('marea')))"
    )
    seen = set()
    for seed in ("0", "1", "2", "3", "4", "5"):
        seen.add(subprocess.run([sys.executable, "-c", program], capture_output=True,
                                text=True, env=dict(os.environ, PYTHONHASHSEED=seed),
                                check=True).stdout.strip())
    assert len(seen) == 1


@pytest.mark.parametrize(
    "raw,folded",
    [("Ｍａｒｅａ", "marea"), ("①", "1"), ("㎡", "m2"), ("ﬁ", "fi")],
    ids=["fullwidth", "circled", "squared", "ligature"],
)
def test_compatibility_normalisation_is_real_not_just_case_folding(raw: str, folded: str) -> None:
    """`"ﬁ".casefold()` is already `"fi"`, so the old example proved nothing."""
    assert normalise(raw) == folded


def test_the_corpus_derivation_skips_terms_the_two_sides_share() -> None:
    """Both fixture pairs share no terms, so the filter was never exercised."""
    derived = CorpusDerivedAliases.from_aligned_pairs(
        (("Kestrel tide rises", "Kestrel marea sale"),)
    )
    assert derived.expand("kestrel") == (), "a term present on both sides is not a translation"
    assert "marea" in derived.expand("tide")


def test_no_module_level_alias_instance_can_become_a_default() -> None:
    """The old guard was a list of four exact names; anything else got through."""
    import nous_os.aliases as module

    for name in dir(module):
        if name.startswith("_"):
            continue
        value = getattr(module, name)
        assert not isinstance(value, AliasTable) or isinstance(value, type), (
            f"{name} is a ready-made alias table at module level, which a caller "
            "would reach for without choosing"
        )


def test_the_result_cap_is_validated_and_actually_caps() -> None:
    path = _indexed()
    # One term matching several documents. With four documents in total, a
    # per-term cap of one can still reach all four through four terms, so a
    # multi-term query cannot demonstrate a cap at all.
    case = GoldenCase("the", (DOCS["en-tides"],))
    wide = run_golden(path, (case,), NoAliases(), limit=20).results[0].found
    narrow = run_golden(path, (case,), NoAliases(), limit=1).results[0].found
    assert len(wide) > len(narrow), "the cap does not cap"
    for bad in (0, -1, True, "3", None):
        with pytest.raises(Exception):
            run_golden(path, (case,), _hand(), limit=bad)  # type: ignore[arg-type]


def test_the_missing_list_is_sorted() -> None:
    result = run_golden(_indexed(), (GoldenCase("zzz", (DOCS["it-faro"], DOCS["en-tides"])),), NoAliases())
    missing = result.results[0].missing
    assert list(missing) == sorted(missing)
    assert len(missing) == 2


def test_the_payload_of_a_run_that_did_not_happen_says_so() -> None:
    """The status field was only ever asserted on a completed run, so a constant
    `"complete"` satisfied it."""
    payload = run_golden(Path(tempfile.mkdtemp()) / "absent.db", G_ITEN, NoAliases()).as_payload()
    assert payload["status"] == "not_run"
    assert payload["reason"]
    assert payload["cases"] == []


def test_the_shared_term_filter_bites_when_shared_terms_sit_at_different_positions() -> None:
    """The earlier fixture put the shared term first on both sides, so removing
    the filter changed nothing: the crude positional pairing lined it up with
    itself and the identity guard dropped it anyway."""
    derived = CorpusDerivedAliases.from_aligned_pairs(
        (("tide Kestrel rises", "Kestrel marea sale"),)
    )
    assert derived.expand("kestrel") == (), "a term present on both sides is not a translation"
    assert derived.expand("tide") == ("marea",)


def test_the_default_result_cap_is_wide_enough_to_see_more_than_one_document() -> None:
    """Every cap test passed `limit` explicitly, so the default was unexercised
    and could be narrowed to one with the suite green."""
    result = run_golden(_indexed(), (GoldenCase("the", (DOCS["en-tides"],)),), NoAliases())
    assert len(result.results[0].found) > 1, "the default cap hides documents"
