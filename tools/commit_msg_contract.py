"""The public commit-message contract, as an executable check.

A commit message is public writing. It is the part of this repository a reader
meets first and the part no test ever read, and for the whole of V1 nothing
asked whether it was any good: the messages were checked for shape and for
words that must never be published, and a subject could be a hundred and
thirty-six characters of narrative and still pass every gate. This module is
the missing half. It asks whether a subject says *what changed*, in a line a
person can read.

It is a pure function over a message string. It holds no Git knowledge, so the
same rules apply before a commit exists, to a message read back from a created
object, and retroactively across a history.

It deliberately does **not** check for private vocabulary. That check needs a
term set that must not itself be published, so it lives outside this repository
and runs before a push. A green result here means *well formed and
professionally written*, never *safe to publish*; the two questions are
separate and this module answers only the first.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass

__all__ = [
    "Violation",
    "validate_message",
    "SUBJECT_HARD_MAX",
    "SUBJECT_PREFERRED",
    "BULLET_HARD_MAX",
    "TYPES",
]

#: A subject longer than this is refused. Seventy-two is the width at which
#: `git log --oneline` stops truncating in a standard terminal.
SUBJECT_HARD_MAX = 72

#: The band a subject should land in. Outside it the subject is reported as an
#: advisory, never as a failure: a 40-character subject that says the right
#: thing is better than a padded one, and the range is guidance rather than a
#: rule that could be satisfied by adding words.
SUBJECT_PREFERRED = (45, 65)

#: A bullet longer than this has stopped being a summary.
#:
#: Calibrated against the history it governs rather than chosen. The 746 bullets
#: this contract replaced had a median of 273 characters and a longest of 1056 —
#: an execution transcript wearing a bullet's clothes. The rewritten bodies land
#: at a median of 210.
#:
#: The first value tried was 240, and it was wrong: on the longest bullets it
#: could only be satisfied by dropping articles and finite verbs, which produced
#: telegraphic headline prose — worse writing, passing the check. A limit that
#: can only be met by damaging the sentence is not measuring what it claims to.
#: At 300 the rule still refuses roughly one bullet in six, and every one of the
#: 94 original bullets over 600 characters.
BULLET_HARD_MAX = 300

#: The Conventional Commit types this project uses. A frozen set: an unknown
#: type is a typo or a new convention, and either deserves to be noticed.
TYPES = frozenset(
    {
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
    }
)

_SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[a-z0-9][a-z0-9.-]*)\))?: (?P<rest>.+)$")

#: Identifiers from the process that produced a commit rather than from the
#: product it changed. A reader of this repository has no way to resolve any of
#: them, and a public history that leans on them is written for its author.
#:
#: `capability` itself is **not** here and must never be: it is this project's
#: own product vocabulary — `capability.py`, `system.capabilities`, four
#: authority tiers. Only the opaque *identifiers* are refused.
_PROCESS_VOCABULARY = re.compile(
    r"(?ix)"
    r"\b(?:"
    r"cap-?\d+"                       # CAP-13, cap13
    r"|ec-[a-z]+-\d+"                 # an evolution-candidate id
    r"|rpc-\d+"
    r"|d-\d{3}"                       # a decision id
    r"|runtime[ -]pack"
    r"|closure[ -](?:record|audit)"
    r"|gauntlet"
    r"|hitl"
    r"|coordinator"
    r"|preregistration"
    r"|tranche"
    r"|subagent"
    r"|codex|claude|opus|sonnet|fable|gpt-\d"
    r"|co-authored-by"
    r"|generated with"
    r")\b"
)

#: Git trailers. `git interpret-trailers` accepts a space before the colon and
#: does not need one after it, so both are matched; a leading bullet marker does
#: not hide one either. A trailer is machinery, and a message whose body is two
#: outcomes and a sign-off is a message with one outcome missing.
_TRAILER = re.compile(
    r"(?mi)^[^\S\n]*(?:-[^\S\n]+)?"
    r"(?:signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by"
    r"|helped-by|co-authored-by|change-id|see-also|refs|closes|fixes|resolves)"
    r"[^\S\n]*:"
)

#: A subject that joins two independent statements is telling a story. The
#: comma is the reliable mechanical signal — every narrative subject in this
#: project's first two hundred commits carried one — and the subordinators
#: catch the rest.
_NARRATIVE = (
    (", ", "a comma-joined clause: say one thing"),
    (" because ", "an explanation belongs in the body"),
    (" so that ", "an explanation belongs in the body"),
    (" in order to ", "an explanation belongs in the body"),
    (" and then ", "a sequence belongs in the body"),
    (" which ", "a relative clause: say one thing"),
)

#: Words that would make a subject a report of work rather than a description
#: of a change. `-ing` and `-ed` openings are the two forms that do it, and the
#: allowlist holds the ordinary verbs those endings catch by accident.
_IMPERATIVE_ALLOW = frozenset(
    {"bring", "cling", "fling", "ping", "ring", "sing", "spring", "string", "swing", "wring",
     "bed", "embed", "exceed", "feed", "need", "proceed", "seed", "speed", "succeed"}
)

_PATH_OPEN = r"(?:^|[\s(\[\"'<>=,;])"
_PATH_ROOTED = re.compile(_PATH_OPEN + r"/(?:Users|home|root|etc|var|tmp|opt|private|srv|mnt)/")
_PATH_ANCHORED = re.compile(_PATH_OPEN + r"(?:~[/\\]|[A-Za-z]:[\\/])")

_CONTROL = re.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\r\\x85\\u2028\\u2029]")
_INVISIBLE = re.compile(
    "[\\u00ad\\u034f\\u061c\\u200b-\\u200f\\u202a-\\u202e"
    "\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufeff\\ufff9-\\ufffb]"
)


@dataclass(frozen=True)
class Violation:
    """One reason a message is refused, or one advisory about it."""

    code: str
    detail: str
    #: An advisory is reported and does not fail. Nothing here is advisory
    #: except subject length outside the preferred band.
    advisory: bool = False

    def __str__(self) -> str:  # pragma: no cover - formatting only
        mark = "advice " if self.advisory else "REFUSED"
        return f"{mark} {self.code}: {self.detail}"


def _check_subject(subject: str) -> list[Violation]:
    found: list[Violation] = []

    if len(subject) > SUBJECT_HARD_MAX:
        found.append(
            Violation(
                "SUBJECT_TOO_LONG",
                f"{len(subject)} characters; the hard maximum is {SUBJECT_HARD_MAX}",
            )
        )
    low, high = SUBJECT_PREFERRED
    if len(subject) <= SUBJECT_HARD_MAX and not (low <= len(subject) <= high):
        found.append(
            Violation(
                "SUBJECT_LENGTH_BAND",
                f"{len(subject)} characters; {low}-{high} reads best",
                advisory=True,
            )
        )

    match = _SUBJECT.match(subject)
    if match is None:
        found.append(
            Violation(
                "SUBJECT_SHAPE",
                "expected 'type(scope): description' or 'type: description', "
                "with a lower-case type and a single space after the colon",
            )
        )
        return found

    if match.group("type") not in TYPES:
        found.append(
            Violation("SUBJECT_TYPE", f"unknown type {match.group('type')!r}; "
                                      f"expected one of {', '.join(sorted(TYPES))}")
        )

    rest = match.group("rest")
    if rest.endswith("."):
        found.append(Violation("SUBJECT_PERIOD", "a subject does not end in a full stop"))
    if rest[:1].isupper():
        found.append(Violation("SUBJECT_CASE", "the description begins in lower case"))

    first = re.match(r"[a-z]+", rest)
    if first is not None:
        word = first.group(0)
        if word not in _IMPERATIVE_ALLOW and (word.endswith("ing") or word.endswith("ed")):
            found.append(
                Violation(
                    "SUBJECT_NOT_IMPERATIVE",
                    f"{word!r} reports work; write the imperative, as in 'add', 'refuse', 'bind'",
                )
            )

    for needle, why in _NARRATIVE:
        if needle in rest:
            found.append(Violation("SUBJECT_NARRATIVE", f"{needle.strip()!r}: {why}"))

    return found


def _check_process_vocabulary(text: str, where: str) -> list[Violation]:
    found: list[Violation] = []
    hit = _PROCESS_VOCABULARY.search(text)
    if hit is not None:
        found.append(
            Violation(
                "PROCESS_VOCABULARY",
                f"{hit.group(0)!r} in the {where} names how the work was run, not what changed",
            )
        )
    trailer = _TRAILER.search(text)
    if trailer is not None:
        found.append(
            Violation(
                "PROCESS_VOCABULARY",
                f"a Git trailer ({trailer.group(0).strip()}) in the {where}; the body is outcomes only",
            )
        )
    return found


def _check_paths(text: str, where: str) -> list[Violation]:
    if _PATH_ROOTED.search(text) or _PATH_ANCHORED.search(text):
        return [Violation("MACHINE_PATH", f"a local filesystem path appears in the {where}")]
    return []


def validate_message(message: str) -> list[Violation]:
    """Return every violation in ``message``; an empty list means it conforms.

    Advisories are included in the returned list and are distinguishable by
    :attr:`Violation.advisory`. Callers deciding pass or fail must filter them
    out — :func:`refusals` does it for them — because a check that treats
    advice as failure teaches people to pad subjects to reach a band.
    """
    found: list[Violation] = []

    if _CONTROL.search(message) or _INVISIBLE.search(message):
        found.append(
            Violation("INVISIBLE_CHARACTER", "a control or zero-width character is present")
        )

    lines = message.rstrip("\n").split("\n")
    subject = lines[0] if lines else ""
    if not subject.strip():
        return [Violation("EMPTY", "the message has no subject")]

    found += _check_subject(subject)
    found += _check_process_vocabulary(subject, "subject")
    found += _check_paths(subject, "subject")

    body = lines[1:]
    if not body:
        found.append(Violation("NO_BODY", "a body of two to four bullets is required"))
        return found
    if body[0] != "":
        found.append(Violation("NO_BLANK_LINE", "one blank line must follow the subject"))
        body = body[1:] if body[0].startswith("- ") else body
    else:
        body = body[1:]

    bullets: list[str] = []
    for line in body:
        if line.startswith("- "):
            bullets.append(line[2:])
        elif line.strip() == "":
            found.append(Violation("BLANK_IN_BODY", "no blank lines between or after bullets"))
        else:
            found.append(
                Violation("EXTRA_CONTENT", f"only bullets may follow the subject, found {line!r}")
            )

    if not 2 <= len(bullets) <= 4:
        found.append(
            Violation("BULLET_COUNT", f"two to four bullets are required, found {len(bullets)}")
        )

    for index, bullet in enumerate(bullets, start=1):
        if len(bullet) > BULLET_HARD_MAX:
            found.append(
                Violation(
                    "BULLET_TOO_LONG",
                    f"bullet {index} is {len(bullet)} characters; "
                    f"the hard maximum is {BULLET_HARD_MAX}",
                )
            )
        if not bullet.strip():
            found.append(Violation("BULLET_EMPTY", f"bullet {index} is empty"))

    found += _check_process_vocabulary("\n".join(bullets), "body")
    found += _check_paths("\n".join(bullets), "body")

    return found


def refusals(message: str) -> list[Violation]:
    """The violations that make ``message`` fail, advisories excluded."""
    return [violation for violation in validate_message(message) if not violation.advisory]


def _messages_in_range(repository: str, rev_range: str) -> list[tuple[str, str]]:
    shas = subprocess.run(
        ["git", "-C", repository, "rev-list", rev_range],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    out: list[tuple[str, str]] = []
    for sha in shas:
        message = subprocess.run(
            ["git", "-C", repository, "log", "-1", "--format=%B", sha],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        out.append((sha, message))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check a commit message, or every message in a range, against the "
        "public commit contract. Private-vocabulary checking is deliberately not "
        "part of this tool."
    )
    parser.add_argument("file", nargs="?", help="a message file; stdin if omitted")
    parser.add_argument("--range", help="validate every commit reachable in this range instead")
    parser.add_argument("--repo", default=".", help="repository for --range")
    parser.add_argument(
        "--advice", action="store_true", help="also print advisories, which never fail"
    )
    arguments = parser.parse_args(argv)

    if arguments.range:
        try:
            pairs = _messages_in_range(arguments.repo, arguments.range)
        except subprocess.CalledProcessError as error:
            print(
                f"NOT_RUN: git could not resolve {arguments.range!r} in {arguments.repo!r}. "
                "A shallow clone cannot answer this question, and a check that did not run "
                "is not a check that passed.",
                file=sys.stderr,
            )
            print(error.stderr.strip(), file=sys.stderr)
            return 2
        if not pairs:
            print(f"NOT_RUN: {arguments.range!r} selected no commits", file=sys.stderr)
            return 2
        failed = 0
        for sha, message in pairs:
            found = validate_message(message)
            for violation in found:
                if violation.advisory and not arguments.advice:
                    continue
                print(f"{sha[:12]} {violation}")
                if not violation.advisory:
                    failed += 1
        print(f"checked {len(pairs)} commit message(s), {failed} refusal(s)")
        return 1 if failed else 0

    message = (
        open(arguments.file, encoding="utf-8").read() if arguments.file else sys.stdin.read()
    )
    found = validate_message(message)
    failed = 0
    for violation in found:
        if violation.advisory and not arguments.advice:
            continue
        print(str(violation))
        if not violation.advisory:
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
