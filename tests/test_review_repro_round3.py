"""Regression oracles for the review console: line separators inside a decider, and a superseding candidate whose content is unchanged."""
from __future__ import annotations

from pathlib import Path

import pytest

from tests.test_review import _apply_argv, _audit, _content, _decision, _record, _world, _write_decisions

from nous_os.review import ReviewCandidate, main


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\x85"])
def test_c1_audit_trail_survives_a_line_separator_in_the_decider(tmp_path: Path, separator: str) -> None:
    """C1: a decider containing U+2028/U+2029/NEL is accepted and written raw; every later apply on the root must still read the trail."""
    world = _world(tmp_path)
    candidate = ReviewCandidate.from_proposal(_record(world, _content(world)))
    decider = f"reviewer{separator}two"
    first = _write_decisions(world.root / "first.jsonl", _decision(candidate, decider=decider))
    assert main(_apply_argv(world, first)) == 0
    entries = _audit(world)
    assert entries and entries[-1]["outcome"] == "APPLIED"
    # the audit trail must be readable again: a replay is logged, not a crash
    assert main(_apply_argv(world, first)) == 0
    assert _audit(world)[-1]["outcome"] == "ALREADY_DECIDED"


def test_c2_identical_superseding_content_is_refused_before_reservation(tmp_path: Path) -> None:
    """C2: a superseding candidate whose assertion content equals the predecessor's (same statement, citation, support, dates)
    must be refused with a named outcome BEFORE RESERVED and before any PROMOTE record — not crash after both were written."""
    world = _world(tmp_path)
    original = ReviewCandidate.from_proposal(_record(world, _content(world)))
    assert main(_apply_argv(world, _write_decisions(world.root / "root.jsonl", _decision(original)))) == 0
    successor = ReviewCandidate.from_proposal(
        _record(world, _content(world, scope="harbor.second", supersedes=f"{original.proposal.proposal_id}@{original.version}"))
    )
    before_audit = len(_audit(world))
    before_auth = world.authorizations.read_bytes()
    rc = main(_apply_argv(world, _write_decisions(world.root / "successor.jsonl", _decision(successor))))
    assert rc == 0, "an identical superseding version is a logged refusal, not a crash"
    entries = _audit(world)[before_audit:]
    assert [entry["outcome"] for entry in entries] == ["SUPERSEDES_UNCHANGED"], entries
    assert world.authorizations.read_bytes() == before_auth, "no PROMOTE record for a refused decision"
    assert len(list((world.canon_root / "assertions").rglob("*.json"))) == 1
    # a later reject of the same candidate is still possible (nothing was reserved)
    rc2 = main(_apply_argv(world, _write_decisions(world.root / "reject.jsonl", _decision(successor, verdict="reject"))))
    assert rc2 == 0
    assert _audit(world)[-1]["outcome"] == "APPLIED"
