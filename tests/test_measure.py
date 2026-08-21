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
from nous_os.measure import (
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
    GoldenCase("tide", (DOCS["en-tides"],)),
    GoldenCase("marea", (DOCS["it-maree"],)),
    GoldenCase("lighthouse", (DOCS["en-lighthouse"],)),
    GoldenCase("faro", (DOCS["it-faro"],)),
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
    assert len(documents) <= 8, (
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
    """A net figure would hide a derivation trading one document for another."""
    path = _indexed()
    baseline = run_golden(path, G_RETR, NoAliases())
    broken = run_golden(path, tuple(GoldenCase(c.query, c.expect + ("src_" + "Z" * 26,)) for c in G_RETR), NoAliases())
    measured = measure_rescue(baseline, broken)
    assert measured.status is RunStatus.NOT_RUN
    assert "lost" in (measured.reason or "")
    assert measured.rate is None


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
