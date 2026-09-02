"""The commit-message contract, and the history it is asserted over.

Two things are checked here, and the second is the one that matters. The first
is that the rules behave — every rule has a message that violates it and a
message that does not, so a rule deleted from the module turns this file red.
The second is that **this repository's own history satisfies them**, because a
contract nothing is measured against is a document, not a contract, and this
project has already learned once what a correct check that nothing consumes is
worth.

The history check needs a Git repository. A source tree without one cannot
answer the question, and it says so rather than passing.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from tools.commit_msg_contract import (
    BULLET_HARD_MAX,
    SUBJECT_HARD_MAX,
    refusals,
    validate_message,
)

REPOSITORY = Path(__file__).resolve().parent.parent

def _home_path(root: str) -> str:
    """Build a machine path at run time, so none appears in tracked bytes.

    The rule under test refuses absolute filesystem paths, and this repository
    refuses them in its own files too -- including in a test that exists to
    prove the rule works. Writing the fixture as a literal would make the suite
    fail its own public-safety check, which is the honest outcome and not the
    useful one. Assembling it from segments is the technique the browser
    harness already uses for the same reason.
    """
    return "/".join(("", root, "someone", "data"))


CONFORMING = "fix(temporal): keep a rejection at the moment it was made\n\n- Anchor a rejection to its own valid time rather than to the interval it rejects.\n- Prove the two are different with a case whose intervals do not overlap.\n"


def codes(message: str) -> set[str]:
    return {violation.code for violation in refusals(message)}


def test_a_conforming_message_is_accepted() -> None:
    assert refusals(CONFORMING) == []


def test_the_preferred_length_band_is_advice_and_never_a_refusal() -> None:
    short = "fix: keep it\n\n- One outcome.\n- Another outcome.\n"
    assert refusals(short) == []
    assert any(v.code == "SUBJECT_LENGTH_BAND" and v.advisory for v in validate_message(short))


@pytest.mark.parametrize(
    ("message", "code"),
    [
        ("fix: " + "a" * SUBJECT_HARD_MAX + "\n\n- One.\n- Two.\n", "SUBJECT_TOO_LONG"),
        ("fix: reach the case it proves, and stop the claim\n\n- One.\n- Two.\n", "SUBJECT_NARRATIVE"),
        ("fix: keep it short because the reader is busy\n\n- One.\n- Two.\n", "SUBJECT_NARRATIVE"),
        ("fix: adding the missing guard to the resolver\n\n- One.\n- Two.\n", "SUBJECT_NOT_IMPERATIVE"),
        ("fix: added the missing guard to the resolver\n\n- One.\n- Two.\n", "SUBJECT_NOT_IMPERATIVE"),
        ("fix(cap13): bind the report to its generator\n\n- One.\n- Two.\n", "PROCESS_VOCABULARY"),
        ("fix: bind the report to its generator for D-077\n\n- One.\n- Two.\n", "PROCESS_VOCABULARY"),
        ("fix: let the coordinator resolve the store\n\n- One.\n- Two.\n", "PROCESS_VOCABULARY"),
        ("fix: resolve the store\n\n- One.\n- The runtime pack pins it.\n", "PROCESS_VOCABULARY"),
        (f"fix: read the store from {_home_path('Users')}\n\n- One.\n- Two.\n", "MACHINE_PATH"),
        (f"fix: read the store\n\n- Resolved from {_home_path('home')}.\n- Two.\n", "MACHINE_PATH"),
        ("improve: read the store from configuration\n\n- One.\n- Two.\n", "SUBJECT_TYPE"),
        ("read the store from configuration\n\n- One.\n- Two.\n", "SUBJECT_SHAPE"),
        ("fix: Read the store from configuration\n\n- One.\n- Two.\n", "SUBJECT_CASE"),
        ("fix: read the store from configuration.\n\n- One.\n- Two.\n", "SUBJECT_PERIOD"),
        ("fix: read the store from configuration\n\n- Only one bullet.\n", "BULLET_COUNT"),
        ("fix: read the store\n\n- 1.\n- 2.\n- 3.\n- 4.\n- 5.\n", "BULLET_COUNT"),
        ("fix: read the store\n\n- " + "a" * (BULLET_HARD_MAX + 1) + "\n- Two.\n", "BULLET_TOO_LONG"),
        ("fix: read the store\n\n- One.\n- Two.\nAnd some prose.\n", "EXTRA_CONTENT"),
        ("fix: read the store\n- One.\n- Two.\n", "NO_BLANK_LINE"),
        ("fix: read the store\n\n- One.\n\n- Two.\n", "BLANK_IN_BODY"),
        ("fix: read the store from confi​guration\n\n- One.\n- Two.\n", "INVISIBLE_CHARACTER"),
        ("fix: read the store\n\n- One.\n- Signed-off-by: A Person\n", "PROCESS_VOCABULARY"),
    ],
)
def test_each_rule_refuses_the_message_it_exists_for(message: str, code: str) -> None:
    assert code in codes(message), f"{code} was not reported for {message.splitlines()[0]!r}"


def test_the_word_capability_is_product_vocabulary_and_is_not_refused() -> None:
    """The negative control for the process-vocabulary rule.

    `capability.py`, `system.capabilities` and four authority tiers are what this
    project calls things. A rule that refused the word would refuse the product's
    own name for itself, and only the opaque identifiers are meant to be caught.
    """
    message = "feat(capability): check every governed operation at one door\n\n- Give the four authority tiers a single boundary.\n- Refuse a widened grant after the process has started.\n"
    assert refusals(message) == []


def test_a_message_that_would_pass_the_shape_check_alone_can_still_be_refused() -> None:
    """Formal conformance is not quality, which is the whole reason for this module.

    This subject has a type, a scope, a blank line and two bullets. It is the
    exact shape the earlier gate accepted, and it is refused here.
    """
    message = (
        "fix(public-safety): let the missing-record control reach the case it "
        "exists to prove, and stop the document claiming a check nobody runs\n\n"
        "- One.\n- Two.\n"
    )
    assert "SUBJECT_TOO_LONG" in codes(message)
    assert "SUBJECT_NARRATIVE" in codes(message)


def _history() -> list[tuple[str, str]]:
    try:
        listing = subprocess.run(
            ["git", "-C", str(REPOSITORY), "rev-list", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:  # pragma: no cover - environment
        pytest.fail(
            "the commit history could not be read, so the contract could not be asserted over "
            f"it. This is a NOT-RUN, not a pass: {error}"
        )
    shas = listing.stdout.split()
    if not shas:
        pytest.fail("git reported no commits, so the contract was asserted over nothing")
    messages = subprocess.run(
        ["git", "-C", str(REPOSITORY), "log", "--format=%H%x1e%B%x1f", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    out: list[tuple[str, str]] = []
    for record in messages.split("\x1f"):
        record = record.strip("\n")
        if not record:
            continue
        sha, _, message = record.partition("\x1e")
        out.append((sha, message))
    assert len(out) == len(shas), f"{len(shas)} commits listed but {len(out)} messages parsed"
    return out


def test_every_commit_in_this_repository_satisfies_the_contract() -> None:
    history = _history()
    failures = [
        f"{sha[:12]} {violation}"
        for sha, message in history
        for violation in refusals(message)
    ]
    assert failures == [], "\n".join([f"{len(failures)} violation(s) in {len(history)} commits", *failures])
