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
#: A THIRD version narrowed the exemptions to four words and the outcome vocabulary to
#: its exact past-tense spellings, and an audit broke it in both directions again: it
#: flagged true counterfactuals ("Had dense retrieval qualified...") that used a
#: hypothetical marker its four-word list did not know, and it missed present-tense
#: claims ("Dense retrieval qualifies...") and the same claims wrapped in ordinary
#: markdown (`**bold**`, `` `code` ``) or wrapped across a line break — this repository
#: publishes prose in both styles constantly. Neither failure was a subject-verb
#: attachment problem; both were mechanical gaps a pattern can close without becoming
#: a general parser.
#:
#: So this narrows to what patterns CAN decide exactly:
#:
#:   1. the project's own FROZEN OUTCOME VOCABULARY, which is a closed set of literal
#:      tokens and is the most likely form a false claim would actually take, because
#:      it is the language the record already speaks;
#:   2. a short list of UNAMBIGUOUS literal assertions — a retrieval subject directly
#:      governing an adoption verb, read after markdown markup and line-wrapping are
#:      normalised away, and including the one coordinated-clause shape ("X ranks
#:      first and is adopted") where the subject still opens the sentence and no
#:      attachment judgment is required.
#:
#: RESIDUAL GAP, STATED RATHER THAN PAPERED OVER: a sufficiently indirect paraphrase
#: passes this check. It is a floor, not a proof. See `_KNOWN_UNCAUGHT` below for the
#: exact kinds this version still misses, pinned as tests rather than asserted in prose.

#: Outcome tokens the experiment did NOT reach. Their appearance as an assertion is a
#: false published conclusion, with no ambiguity to weigh.
_FORBIDDEN_OUTCOMES = ("DENSE_QUALIFIED_AND_ADOPTED", "DENSE_QUALIFIED_BUT_NOT_ADOPTED")

#: Outcome tokens the experiment DID reach. A line enumerating the vocabulary names
#: several at once; a line asserting a result names one. Three or more on a line is a
#: list, not a claim.
_TRUE_OUTCOMES = ("DENSE_NOT_QUALIFIED", "HYBRID_NOT_JUSTIFIED", "LEXICAL_BASELINE_RETAINED")

#: The retrieval subject a false CAP-15 conclusion would be written about.
_SUBJECT = r"""(?:dense(?:[-\s]+retrieval)?|the\s+dense\s+arm|embeddings?|
    the\s+semantic\s+index|the\s+vector\s+index)"""

#: Auxiliaries that may sit between the subject and the verb without changing what is
#: being asserted. `will\s+be\s+` is its own alternative, not built from `will` plus
#: `be`, because a bare `will` in front of a bare verb ("dense retrieval will qualify")
#: is not one of the frozen outcome spellings this check owns.
_AUX = r"(?:has\s+|have\s+|had\s+|is\s+|are\s+|was\s+|were\s+|been\s+|will\s+be\s+){0,2}"

#: An adverb the aux and the verb can carry without breaking adjacency: "is therefore
#: adopted" asserts exactly what "is adopted" does.
_ADVERB = r"(?:then\s+|therefore\s+|also\s+|now\s+)?"

#: The verb, covering the inflections a real sentence uses and not only the frozen
#: past-tense spelling: present tense ("qualifies", "outperforms") is exactly as false
#: a claim as past tense, and a check that only reads one tense reads half the record.
_VERB = r"""(?:qualif(?:ies|ied)|
    outperform(?:s|ed)?|
    adopt(?:s|ed)?|
    (?:is|are|becomes?|became)?\s*(?:now\s+)?the\s+(?:new\s+)?(?:default|primary|canonical))"""

#: Assertions with no reading under which they are true of this capability: a retrieval
#: subject directly governing an adoption verb, with no room between them for another
#: noun to be the real subject. Matched against markdown-stripped, line-joined text —
#: see `_strip_markdown` and `_paragraphs` — so `**bold**` and a wrapped line cannot
#: hide the same claim from the exact regex that would have caught it unwrapped.
_FALSE_CAP15_CLAIM = re.compile(rf"(?ix)\b{_SUBJECT}\s+{_AUX}{_ADVERB}{_VERB}\b")

#: The one coordinated-clause shape this check can decide without attachment judgment:
#: "Dense retrieval ranks first and is therefore adopted." The subject and the verb are
#: not adjacent, but the subject opens the sentence and the verb is fronted by a
#: literal "and is/are/was/were" — there is no other candidate subject for that clause
#: to attach to, because the sentence never introduced one. Anchored at the sentence
#: start on purpose: once a marker like "If" or "Suppose" precedes the subject, the
#: sentence no longer opens with it and this pattern does not fire, which is why it
#: needs no separate hypothetical exemption of its own.
_FALSE_CAP15_CLAIM_COORDINATED = re.compile(
    rf"""(?ix)
    ^\s*{_SUBJECT}\b.*?
    \band\s+(?:is|are|was|were)\s+(?:\w+\s+){{0,2}}?
    (?:qualif(?:ies|ied)|outperform(?:s|ed)?|adopt(?:s|ed)?)\b
    """
)

#: A marker that governs the SUBJECT, making the claim a question, a counterfactual, or
#: a denial rather than an assertion. It must appear BEFORE the subject, not merely
#: somewhere in the sentence: "the capability asks whether dense qualified" is
#: discussion, while "dense qualified, whether or not the baseline agrees" is an
#: assertion. `only\s+when` (not bare `when`, which is common enough in this project's
#: prose to disable the check on unrelated sentences) and `rejected`, `no\s+arm`,
#: `false\s+that`, `nowhere`, `suppose`, `assume` were added after an audit found true
#: sentences using each of them that the previous four-word list flagged as false.
_HYPOTHETICAL_BEFORE_SUBJECT = re.compile(
    r"""(?ix)
    \b(?:whether|if|unless|asks?|asked|
        suppose|assume|nowhere|rejected|
        no\s+arm|false\s+that|only\s+when)\b
    """
)

#: The subjunctive inversion "Had X qualified..." / "Were X adopted..." is a
#: counterfactual, exactly like "If X had qualified...". `had` and `were` are too
#: common elsewhere in this project's prose to add to `_HYPOTHETICAL_BEFORE_SUBJECT`
#: as ordinary anywhere-before-subject markers — "the record had documented that dense
#: retrieval qualified" would be wrongly exempted. Inversion is only that specific
#: syntax: the marker is the sentence's own first word, immediately before the
#: subject, with nothing else between them.
_INVERTED_CONDITIONAL_PREFIX = re.compile(r"(?i)^(?:had|were)\s+$")

#: "Dense retrieval qualified as a control arm only" redefines what "qualified" means
#: in that sentence — accepted into the experiment as a control, not judged to have
#: met the promotion bar — so the marker naturally follows the verb rather than
#: preceding the subject, and is checked across the whole sentence rather than only
#: before the match.
_SCORED_AS_CONTROL = re.compile(r"(?i)\bas\s+a\s+control\s+arm\b")

#: A negation immediately governing the claim. Kept deliberately SMALL: the previous
#: version exempted on "no", "required", "must", "threshold" and "condition", each of
#: which is common enough in this project's prose to disable the check by accident.
_NEGATED = re.compile(r"(?ix)\b(?:not|never|n[o']t|failed\s+to|excluded)\b")

#: Markdown link syntax keeps its visible text and drops the target; a link never
#: changes what a sentence asserts.
_MARKDOWN_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")

#: Bold, italic and code-span markers. This repository's documents use `**bold**`
#: constantly, and a scanner that reads markdown must not be defeated by markdown.
_MARKDOWN_MARKUP = re.compile(r"[*_`]")


def _strip_markdown(text: str) -> str:
    """Drop the markup this repository's prose actually uses, keep the words.

    Run before claim detection only — never before the outcome-token scan, which
    depends on the literal underscores inside `DENSE_QUALIFIED_AND_ADOPTED` and
    would be blinded by this same stripping.
    """
    return _MARKDOWN_MARKUP.sub("", _MARKDOWN_LINK.sub(r"\1", text))


#: A line that stands alone and must never be merged into surrounding prose: a
#: heading, a table row, a list item, a blockquote, or a fenced code delimiter. Every
#: one of this project's documents is mostly tables and list items; joining those
#: into their neighbours would fabricate sentences nobody wrote.
_BLOCK_BOUNDARY = re.compile(r"^\s*(?:#|\||[-*+]\s|\d+\.\s|>|```)")


def _paragraphs(text: str) -> tuple[tuple[int, str], ...]:
    """Group a file's lines into the spans a reader would parse as one sentence-bearing unit.

    This project wraps prose at roughly 95 columns, so "Dense retrieval\\nqualified
    under both HF-2 conditions." is one claim split by an editor, not two half-claims.
    Consecutive non-blank, non-boundary lines are joined with a single space and
    reported at the line the paragraph started on; blank lines and block-boundary
    lines each end the paragraph and stand alone, so a table or a list is scanned
    exactly as before — one row or item at a time.
    """
    blocks: list[tuple[int, str]] = []
    buffer: list[str] = []
    start = 0
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            if buffer:
                blocks.append((start, " ".join(buffer)))
                buffer = []
            continue
        if _BLOCK_BOUNDARY.match(line):
            if buffer:
                blocks.append((start, " ".join(buffer)))
                buffer = []
            blocks.append((number, line))
            continue
        if not buffer:
            start = number
        buffer.append(line.strip())
    if buffer:
        blocks.append((start, " ".join(buffer)))
    return tuple(blocks)


def _sentences(text: str) -> tuple[str, ...]:
    """Split a paragraph into sentence-ish spans.

    Negation and hypothetical markers are judged per sentence, not per paragraph: a
    paragraph reading "Dense qualified. The lexical baseline is not retained." must
    not exempt its first sentence using the second's "not".
    """
    return tuple(part for part in re.split(r"(?<=[.;])\s+", text) if part.strip())


def _is_exempt(sentence: str, match: re.Match[str]) -> bool:
    prefix = sentence[: match.start()]
    if _NEGATED.search(sentence[: match.end()]):
        return True
    if _HYPOTHETICAL_BEFORE_SUBJECT.search(prefix):
        return True
    if _INVERTED_CONDITIONAL_PREFIX.fullmatch(prefix):
        return True
    if _SCORED_AS_CONTROL.search(sentence):
        return True
    return False


def _sentence_is_a_claim(sentence: str) -> bool:
    for match in (_FALSE_CAP15_CLAIM.search(sentence), _FALSE_CAP15_CLAIM_COORDINATED.match(sentence)):
        if match is not None and not _is_exempt(sentence, match):
            return True
    return False


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
        text = path.read_text(encoding="utf-8")

        # The outcome-token scan reads raw physical lines: the tokens are literal,
        # underscored spellings that markdown-stripping would destroy, and this
        # project never wraps one across a line break.
        for number, line in enumerate(text.splitlines(), start=1):
            named_true = sum(1 for token in _TRUE_OUTCOMES if token in line)
            named_false = [token for token in _FORBIDDEN_OUTCOMES if token in line]
            # Three or more outcome tokens on one line is the vocabulary being listed.
            if named_false and (named_true + len(named_false)) < 3:
                findings.append(f"{path}:{number}: {line}")

        # The claim scan reads markdown-stripped, line-joined paragraphs, so a claim
        # split by word-wrap or hidden behind emphasis markup is still one sentence.
        for start, paragraph in _paragraphs(text):
            stripped = _strip_markdown(paragraph)
            if any(_sentence_is_a_claim(sentence) for sentence in _sentences(stripped)):
                findings.append(f"{path}:{start}: {paragraph}")
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
#:
#: A later audit found nine more: present-tense inflections, markdown emphasis and
#: code spans around the exact same words, a claim split by an ordinary line wrap,
#: `will be adopted`, and one coordinated clause where the subject and verb are not
#: adjacent. All nine are the audit's own adversarial cases, appended rather than
#: replacing what was already pinned.
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
    "Dense retrieval qualifies under both HF-2 conditions.",
    "Dense retrieval outperforms the lexical baseline.",
    "**Dense retrieval** is adopted.",
    "*Dense retrieval* is now the default retrieval path.",
    "`Dense retrieval` qualified under both conditions.",
    "Dense retrieval\nqualified under both HF-2 conditions.",
    "The semantic index is\nnow the primary retrieval path.",
    "Dense retrieval will be adopted as the default retrieval path.",
    "Dense retrieval ranks first and is therefore adopted.",
)

#: Paraphrases this check KNOWINGLY does not catch, pinned so the gap is a recorded
#: fact rather than an assumption. Each is a different KIND of miss, not three
#: instances of the same one:
#:
#:   1. a synonym outside the closed verb vocabulary ("met" instead of "qualified" —
#:      catching every synonym for the frozen outcomes needs a thesaurus this check
#:      does not carry, on purpose, because a large one reintroduces the false-hit
#:      risk the closed vocabulary exists to avoid);
#:   2. an indirect paraphrase asserting the same fact in unrelated words ("the
#:      embedding backend ships in V1" — this needs world knowledge, not a pattern);
#:   3. a subject and verb separated by a parenthetical rather than by the one
#:      coordinated-clause shape this check decides ("X, having done Y, was adopted"
#:      — no literal "and" fronts the verb, so `_FALSE_CAP15_CLAIM_COORDINATED` does
#:      not fire, and general attachment across an arbitrary intervening clause is
#:      exactly the judgment a regular expression cannot make).
_KNOWN_UNCAUGHT = (
    "Dense retrieval met both HF-2 conditions.",
    "G-DENSE passed and the embedding backend ships in V1.",
    "Dense retrieval, having beaten the lexical baseline by twelve points, was adopted.",
)

#: Sentences that appear, in substance, in this project's own governance record.
#: A check that fires on these would be deleted rather than fixed, so each one is a
#: test in its own right.
#:
#: The first eight after `Condition 1 required...` are an audit's adversarial cases:
#: true sentences the previous version's four-word exemption list flagged as false,
#: using markers — inversion ("Had"/"Were"), denial ("It is false that"), negative
#: quantification ("Nowhere"/"No arm"), a hypothetical verb ("Suppose"), a redefined
#: verb sense ("as a control arm"), and a reported rejection — that list did not know.
_MUST_NOT_BE_CAUGHT = (
    "The lexical baseline beat dense retrieval on the primary metric.",
    "The best lexical arm beat every dense arm.",
    "Chunk BM25 beats the semantic index on the primary metric.",
    "The lexical baseline is retained and dense retrieval is excluded.",
    "Outcomes: DENSE_QUALIFIED_AND_ADOPTED, DENSE_QUALIFIED_AND_ADOPTED, "
    "DENSE_NOT_QUALIFIED, HYBRID_NOT_JUSTIFIED, LEXICAL_BASELINE_RETAINED",
    "Hybrid retrieval reopens only when dense qualifies first.",
    "G-RERANK requires a measured win over the qualified retrieval stack.",
    "If dense had qualified, hybrid would be measured.",
    "Either condition failing means dense stays out.",
    "The capability asks whether dense retrieval qualified.",
    "Condition 1 required dense to beat the lexical baseline by +10.0 percentage points.",
    "Had dense retrieval qualified, the hybrid gate would have opened.",
    "It is false that dense retrieval qualified.",
    "Nowhere does the record say dense retrieval qualified.",
    "No arm in which dense retrieval qualified was observed.",
    "Were dense retrieval adopted, the store would need rebuilding from canon.",
    "Suppose dense retrieval qualified: condition 2 would still have to hold.",
    "Dense retrieval qualified as a control arm only, and was scored as one.",
    "The auditor rejected the sentence 'dense retrieval qualified' as unsupported.",
)


@pytest.mark.parametrize("claim", _MUST_BE_CAUGHT)
def test_paraphrased_false_claims_are_detected(tmp_path: Path, claim: str) -> None:
    """A guard that catches only the phrasings someone listed gives false confidence.

    Each of these passed an earlier version of this check. `F16` — the finding this
    whole surface exists to prevent recurring — was wrong precisely because a claim
    reached prose that nothing read.
    """
    path = tmp_path / "CAP-15-NOTE.md"
    path.write_text(claim, encoding="utf-8")

    assert _false_cap15_claims((path,)) != ()


@pytest.mark.parametrize("statement", _MUST_NOT_BE_CAUGHT)
def test_legitimate_governance_prose_is_not_flagged(tmp_path: Path, statement: str) -> None:
    """A check that fires on true sentences is worse than no check: it gets deleted.

    Every statement here is one this project's own record makes, or the shape one
    plausibly would.
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
    its own. An audit found an earlier version's coverage claim — "never flagging a
    true sentence" — was false, and true only over the cases its author had chosen.
    """
    path = tmp_path / "CAP-15-NOTE.md"
    path.write_text(claim, encoding="utf-8")

    assert _false_cap15_claims((path,)) == ()
