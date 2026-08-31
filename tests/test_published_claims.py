"""Repository-wide checks for CAP-15 retrieval outcome claims."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
#: A CAP-15 outcome claim: a retrieval SUBJECT paired with an ADOPTION verb, plus the
#: project's own frozen outcome vocabulary, which is the most likely form a false claim
#: would actually take because it is the vocabulary the record already uses.
#:
#: The first version of this pattern listed five literal phrasings and caught exactly those.
#: A coordinator probe found six of eleven fabricated claims slipping past it, including
#: `DENSE_QUALIFIED_AND_ADOPTED` itself. A guard that catches only the sentences someone
#: thought of gives false confidence, which is worse than no guard where the finding it
#: protects (F16) was wrong precisely because prose went unchecked.
_SUBJECT = r"(?:dense(?:[-\s]+retrieval)?|embeddings?|semantic\s+index|vector\s+index|hybrid\s+retrieval|G-DENSE|G-RERANK)"
_ADOPTION = (
    r"(?:qualif(?:ies|ied|y)|adopt(?:s|ed)|"
    r"pass(?:es|ed)|met\s+both|beat(?:s|en)?|wins?|won|"
    r"ships?|shipped|promoted|"
    r"(?:is|are|becomes?|became)\s+(?:now\s+)?the\s+(?:new\s+)?(?:default|primary|canonical))"
)
_FALSE_CAP15_CLAIM = re.compile(
    rf"(?ix)(?:{_SUBJECT}\b[^.;]{{0,80}}?\b{_ADOPTION}\b"
    rf"|\b{_ADOPTION}\b[^.;]{{0,80}}?\b{_SUBJECT}\b"
    rf"|\bDENSE_QUALIFIED_AND_ADOPTED\b"
    rf"|\bmateriality\s+gap\s+(?:is|was|of|:)\s*\+\s*\d+)"
)

#: Discussion markers. A claim is exempt when one of these appears at or before the
#: END of the matched claim, because the claim is then the object of a question, a
#: condition or a counterfactual rather than an assertion. Position matters: "hybrid
#: reopens only when dense qualifies" is a frozen condition, while "dense qualified,
#: whether or not the baseline agrees" is an assertion wearing a question's clothes —
#: its marker falls after the claim ends. A marker that exempts wherever it appears
#: cannot tell the two apart, and the first version of this rule could not.
_DISCUSSION_BEFORE = re.compile(
    r"(?ix)\b(?:whether|if|unless|only\s+when|reopens?|asks?|asked|would|could|"
    r"requires?|required|must|had\s+to|condition|criterion|threshold)\b"
)

#: A claim is exempt only when the SAME SENTENCE carries a negation or a hypothetical.
#: The first version exempted any line containing the word "whether", which made
#: "Dense retrieval qualified, whether or not the baseline agrees" pass. An exemption
#: that one word can trigger is a bypass, not a rule.
_NEGATED = re.compile(
    r"(?ix)\b(?:not|never|no|neither|nor|without|fails?|failed|"
    r"cannot|can't|does\s+n[o']t|did\s+n[o']t|is\s+n[o']t|was\s+n[o']t|"
    r"would\s+have|had\s+to|must|required?|requires|if\b|unless|"
    r"NOT_QUALIFIED|NOT_JUSTIFIED|NOT_TRIGGERED|RETAINED)\b"
)


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
            for sentence in _sentences(line):
                match = _FALSE_CAP15_CLAIM.search(sentence)
                if match is None:
                    continue
                if _NEGATED.search(sentence[: match.end()]):
                    continue
                discussion = _DISCUSSION_BEFORE.search(sentence[: match.end()])
                if discussion is not None:
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
        "Dense is adopted.",
        "Dense is now the default retrieval path.",
        "Dense beat the baseline.",
        "Dense retrieval's materiality gap was +10.0 percentage points.",
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
    "G-DENSE passed and the embedding backend ships in V1.",
    "The semantic index is now the primary retrieval path.",
    "Dense retrieval met both HF-2 conditions.",
    "Embeddings are adopted as the default.",
    "DENSE_QUALIFIED_AND_ADOPTED",
    "Dense retrieval qualified, whether or not the baseline agrees.",
    "Dense retrieval is now the canonical retrieval path.",
)

#: Sentences that appear, in substance, in this project's own governance record.
#: A check that fires on these would be deleted rather than fixed, so each one is a
#: test in its own right.
_MUST_NOT_BE_CAUGHT = (
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
