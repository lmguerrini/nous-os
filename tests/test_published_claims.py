"""Repository-wide checks for CAP-15 retrieval outcome claims."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
#: WHAT THIS CHECK IS, AND WHAT IT IS NOT.
#:
#: It is a TRIPWIRE for two precise things. It is NOT a general detector of false
#: claims in prose, and the record should not read as though it were.
#:
#: Two earlier versions tried to be general, by pairing a retrieval SUBJECT with an
#: ADOPTION verb somewhere in the same sentence. Both failed in both directions. The
#: second version fired on "The lexical baseline beat dense retrieval on the primary
#: metric" — which is TRUE — because a regular expression cannot tell which noun is
#: the subject of the verb. It also missed "The dense arm outperformed the lexical
#: baseline", which is false. **Subject-verb attachment is not a thing patterns do**,
#: and a check that flags true sentences is worse than no check because it gets
#: deleted rather than fixed.
#:
#: So this narrows to what patterns CAN decide exactly:
#:
#:   1. the project's own FROZEN OUTCOME VOCABULARY, which is a closed set of literal
#:      tokens and is the most likely form a false claim would actually take, because
#:      it is the language the record already speaks;
#:   2. a short list of UNAMBIGUOUS literal assertions.
#:
#: RESIDUAL GAP, STATED RATHER THAN PAPERED OVER: a sufficiently indirect paraphrase
#: passes this check. It is a floor, not a proof.

#: Outcome tokens the experiment did NOT reach. Their appearance as an assertion is a
#: false published conclusion, with no ambiguity to weigh.
_FORBIDDEN_OUTCOMES = ("DENSE_QUALIFIED_AND_ADOPTED", "DENSE_QUALIFIED_BUT_NOT_ADOPTED")

#: Outcome tokens the experiment DID reach. A line enumerating the vocabulary names
#: several at once; a line asserting a result names one. Three or more on a line is a
#: list, not a claim.
_TRUE_OUTCOMES = ("DENSE_NOT_QUALIFIED", "HYBRID_NOT_JUSTIFIED", "LEXICAL_BASELINE_RETAINED")

#: Assertions with no reading under which they are true of this capability. Each is a
#: retrieval subject immediately governing an adoption verb, with no room between them
#: for another noun to be the real subject.
_FALSE_CAP15_CLAIM = re.compile(
    r"""(?ix)
    \b(?:dense(?:[-\s]+retrieval)?|the\s+dense\s+arm|embeddings?|
        the\s+semantic\s+index|the\s+vector\s+index)
    \s+
    (?:has\s+|have\s+|had\s+|is\s+|are\s+|was\s+|were\s+|been\s+){0,2}
    (?:qualified|adopted|outperformed|
       (?:is|are|becomes?|became)?\s*(?:now\s+)?the\s+(?:new\s+)?(?:default|primary|canonical))
    \b
    """
)

#: A marker that governs the SUBJECT, making the claim a question or a counterfactual
#: rather than an assertion. It must appear BEFORE the subject, not merely somewhere in
#: the sentence: "the capability asks whether dense qualified" is discussion, while
#: "dense qualified, whether or not the baseline agrees" is an assertion. Deliberately
#: four words, because every word added here is a way to disable the check by accident.
_HYPOTHETICAL_BEFORE_SUBJECT = re.compile(r"(?ix)\b(?:whether|if|unless|asks?|asked)\b")

#: A negation immediately governing the claim. Kept deliberately SMALL: the previous
#: version exempted on "no", "required", "must", "threshold" and "condition", each of
#: which is common enough in this project's prose to disable the check by accident.
_NEGATED = re.compile(r"(?ix)\b(?:not|never|n[o']t|failed\s+to|excluded)\b")


def _sentences(line: str) -> tuple[str, ...]:
    """Split a line into sentence-ish spans.

    Negation is judged per sentence, not per line: a line reading "Dense qualified.
    The lexical baseline is not retained." must not exempt its first sentence using
    the second's "not".
    """
    return tuple(part for part in re.split(r"(?<=[.;])\s+", line) if part.strip())


def _tracked_markdown_files() -> tuple[Path, ...]:
    """Every markdown file the repository would publish.

    Tracked files AND untracked-but-not-ignored ones. Tracked alone leaves a real
    gap: a new `docs/CAP-15-SUMMARY.md` carrying a false conclusion is invisible to
    `git ls-files` until it is added, so the check would pass on the working tree
    that is about to be committed and only fail afterwards. Ignored files stay out
    — they are not published — which is what `--exclude-standard` gives.
    """
    paths: list[Path] = []
    for arguments in (
        ["git", "ls-files", "--", "*.md"],
        ["git", "ls-files", "--others", "--exclude-standard", "--", "*.md"],
    ):
        result = subprocess.run(
            arguments, cwd=REPO_ROOT, check=True, capture_output=True, text=True
        )
        paths.extend(REPO_ROOT / line for line in result.stdout.splitlines())
    return tuple(sorted(set(paths)))


def _false_cap15_claims(paths: tuple[Path, ...]) -> tuple[str, ...]:
    findings: list[str] = []
    for path in paths:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            named_true = sum(1 for token in _TRUE_OUTCOMES if token in line)
            named_false = [token for token in _FORBIDDEN_OUTCOMES if token in line]
            # Three or more outcome tokens on one line is the vocabulary being listed.
            if named_false and (named_true + len(named_false)) < 3:
                findings.append(f"{path}:{number}: {line}")
                continue
            for sentence in _sentences(line):
                match = _FALSE_CAP15_CLAIM.search(sentence)
                if match is None:
                    continue
                if _NEGATED.search(sentence[: match.end()]):
                    continue
                if _HYPOTHETICAL_BEFORE_SUBJECT.search(sentence[: match.start()]):
                    continue
                findings.append(f"{path}:{number}: {line}")
                break
    return tuple(findings)


def test_tracked_markdown_keeps_the_published_cap15_outcome() -> None:
    """Dense retrieval did not qualify or become the adopted retrieval path.

    The report is only one publication surface; a contrary claim elsewhere
    would make the repository's published result internally false.
    """
    assert _false_cap15_claims(_tracked_markdown_files()) == ()


@pytest.mark.parametrize(
    "claim",
    (
        "Dense retrieval qualified under both HF-2 conditions.",
        "Dense retrieval is adopted.",
        "Dense retrieval is now the default retrieval path.",
    ),
)
def test_false_cap15_claims_are_detected_in_a_tracked_looking_file(
    tmp_path: Path, claim: str
) -> None:
    """Each prohibited conclusion must make the check fail when it appears."""
    path = tmp_path / "docs" / "CAP-15-SUMMARY.md"
    path.parent.mkdir()
    path.write_text(claim, encoding="utf-8")

    assert _false_cap15_claims((path,)) == (f"{path}:1: {claim}",)


@pytest.mark.parametrize(
    "statement",
    (
        "Dense retrieval did not qualify; the lexical baseline is retained.",
        "The frozen condition asks whether dense retrieval qualified.",
        "Dense retrieval's materiality gap had to reach +10.0 percentage points; it did not.",
    ),
)
def test_negative_cap15_statements_do_not_trip_the_check(tmp_path: Path, statement: str) -> None:
    """Discussion of the negative result and frozen conditions remains valid."""
    path = tmp_path / "docs" / "CAP-15-RETRIEVAL.md"
    path.parent.mkdir()
    path.write_text(statement, encoding="utf-8")

    assert _false_cap15_claims((path,)) == ()


#: Fabrications a coordinator probe found slipping past the first version of this
#: check. Six of eleven passed it, including the project's own frozen outcome token.
#: They are pinned here so the pattern cannot narrow back to the handful of literal
#: phrasings it started as.
_MUST_BE_CAUGHT = (
    "DENSE_QUALIFIED_AND_ADOPTED",
    "Outcome: DENSE_QUALIFIED_BUT_NOT_ADOPTED.",
    "The semantic index is now the primary retrieval path.",
    "Embeddings are adopted as the default.",
    "Dense retrieval qualified, whether or not the baseline agrees.",
    "Dense retrieval is now the canonical retrieval path.",
    "The dense arm outperformed the lexical baseline.",
    "Dense retrieval has been adopted.",
    "As required, dense retrieval qualified.",
)

#: Paraphrases this check KNOWINGLY does not catch, pinned so the gap is a recorded
#: fact rather than an assumption. Catching them needs subject-verb attachment, which
#: is not something a pattern decides; two earlier versions tried and fired on true
#: sentences instead. The gap is the price of never flagging a true sentence.
_KNOWN_UNCAUGHT = (
    "G-DENSE passed and the embedding backend ships in V1.",
    "Dense retrieval met both HF-2 conditions.",
)

#: Sentences that appear, in substance, in this project's own governance record.
#: A check that fires on these would be deleted rather than fixed, so each one is a
#: test in its own right.
_MUST_NOT_BE_CAUGHT = (
    "The lexical baseline beat dense retrieval on the primary metric.",
    "The best lexical arm beat every dense arm.",
    "Chunk BM25 beats the semantic index on the primary metric.",
    "The lexical baseline is retained and dense retrieval is excluded.",
    "Outcomes: DENSE_QUALIFIED_AND_ADOPTED, DENSE_QUALIFIED_BUT_NOT_ADOPTED, "
    "DENSE_NOT_QUALIFIED, HYBRID_NOT_JUSTIFIED, LEXICAL_BASELINE_RETAINED",
    "Hybrid retrieval reopens only when dense qualifies first.",
    "G-RERANK requires a measured win over the qualified retrieval stack.",
    "If dense had qualified, hybrid would be measured.",
    "Either condition failing means dense stays out.",
    "The capability asks whether dense retrieval qualified.",
    "Condition 1 required dense to beat the lexical baseline by +10.0 percentage points.",
)


@pytest.mark.parametrize("claim", _MUST_BE_CAUGHT)
def test_paraphrased_false_claims_are_detected(tmp_path: Path, claim: str) -> None:
    """A guard that catches only the phrasings someone listed gives false confidence.

    Each of these passed the first version of this check. `F16` — the finding this
    whole surface exists to prevent recurring — was wrong precisely because a claim
    reached prose that nothing read.
    """
    path = tmp_path / "CAP-15-NOTE.md"
    path.write_text(claim, encoding="utf-8")

    assert _false_cap15_claims((path,)) != ()


@pytest.mark.parametrize("statement", _MUST_NOT_BE_CAUGHT)
def test_legitimate_governance_prose_is_not_flagged(tmp_path: Path, statement: str) -> None:
    """A check that fires on true sentences is worse than no check: it gets deleted.

    Every statement here is one this project's own record makes.
    """
    path = tmp_path / "CAP-15-NOTE.md"
    path.write_text(statement, encoding="utf-8")

    assert _false_cap15_claims((path,)) == ()


def test_untracked_markdown_is_scanned_too() -> None:
    """An unadded file is still about to be published.

    Enumerating only tracked files left a real gap, and it was found honestly by
    the worker that built the first version: a fabricated conclusion in a brand-new
    `docs/` document passed the very suite meant to gate its commit, because
    `git ls-files` cannot see a file nobody has added yet.

    This writes a genuinely untracked file into the repository and asserts the
    scanner reaches it, rather than asserting that the command line contains a flag.
    A test that checks its own arguments proves nothing.
    """
    intruder = REPO_ROOT / "docs" / "CAP-15-UNTRACKED-PROBE.md"
    intruder.write_text(
        "Dense retrieval qualified and is now the default retrieval path.\n",
        encoding="utf-8",
    )
    try:
        findings = _false_cap15_claims(_tracked_markdown_files())
        assert any("CAP-15-UNTRACKED-PROBE.md" in finding for finding in findings), (
            "an untracked markdown file carrying a false conclusion was not scanned"
        )
    finally:
        intruder.unlink()

    assert _false_cap15_claims(_tracked_markdown_files()) == ()


@pytest.mark.parametrize("claim", _KNOWN_UNCAUGHT)
def test_known_uncaught_paraphrases_stay_recorded(tmp_path: Path, claim: str) -> None:
    """The gap is pinned, not assumed.

    These are false claims this tripwire does NOT catch. Asserting the miss keeps the
    limitation honest: if a later change starts catching one, this test fails and the
    record gets updated deliberately rather than the coverage claim drifting upward on
    its own. An audit found the previous version's coverage claim true only over the
    cases its author had chosen.
    """
    path = tmp_path / "CAP-15-NOTE.md"
    path.write_text(claim, encoding="utf-8")

    assert _false_cap15_claims((path,)) == ()
