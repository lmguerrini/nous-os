"""Acceptance and negative oracles for the isolated human review console."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import nous_os.core as core
import nous_os.mcp as mcp
import nous_os.review as review
from nous_os.capability import NotAuthorized
from nous_os.candidates import CandidateStore, Proposal
from nous_os.derived import CanonDivergence, rebuild, state_digest
from nous_os.identity import canonical_bytes, digest_bytes
from nous_os.ledger import Ledger, ingest
from nous_os.provenance import Citation, Locator, quote_lint
from nous_os.review import CandidateRefused, ReviewCandidate, canon_index, main, queue
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText


_WHEN = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_SECOND_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"


@dataclass(frozen=True, slots=True)
class _World:
    root: Path
    data_root: Path
    snapshots: SnapshotStore
    ledger: Ledger
    source_id: str
    citation: Citation
    candidates: CandidateStore
    authorizations: Path
    canon_root: Path
    audit_log: Path


def _world(tmp_path: Path) -> _World:
    root = tmp_path / "world"
    data_root = root / "documents"
    data_root.mkdir(parents=True)
    snapshots = SnapshotStore(root / "snapshots")
    ledger = Ledger(root / "ledger.jsonl")
    text = "Harbor access begins at dawn. Harbor access changes at dusk."
    ingest(snapshots, ledger, _SOURCE_ID, UntrustedText(text), _WHEN)
    ingest(
        snapshots,
        ledger,
        _SECOND_SOURCE_ID,
        UntrustedText("A second synthetic snapshot keeps the source index non-trivial."),
        _WHEN + timedelta(minutes=1),
    )
    digest = digest_bytes(text.encode("utf-8"))
    citation = Citation(
        source_id=_SOURCE_ID,
        snapshot_digest=digest,
        locator=Locator(0, len("Harbor access begins at dawn.".encode("utf-8"))),
        span="Harbor access begins at dawn.",
    )
    return _World(
        root=root,
        data_root=data_root,
        snapshots=snapshots,
        ledger=ledger,
        source_id=_SOURCE_ID,
        citation=citation,
        candidates=CandidateStore(root / "candidates.jsonl"),
        authorizations=root / "authorizations.jsonl",
        canon_root=root / "canon",
        audit_log=root / "review" / "decisions.jsonl",
    )


def _citation_payload(citation: Citation) -> dict[str, object]:
    return citation.as_payload()


def _content(
    world: _World,
    *,
    statement: str = "Harbor access begins at dawn.",
    scope: str = "harbor.access",
    origin: str = "USER_AUTHORED",
    support: str = "direct_quote",
    supersedes: str | None = None,
) -> dict[str, object]:
    return {
        "statement": statement,
        "kind": "DECISION",
        "scope": scope,
        "origin": origin,
        "support": support,
        "citations": [_citation_payload(world.citation)],
        "counter_citations": [],
        "valid_from": "2026-01-01T00:00:00+00:00",
        "valid_to": None,
        "why": "A synthetic review fixture.",
        "producer": "fixture/1",
        "batch": "batch-01",
        "supersedes": supersedes,
    }


def _record(world: _World, payload: dict[str, object], *, when: datetime = _WHEN) -> Proposal:
    return world.candidates.record(
        source_id=world.source_id,
        content=UntrustedText(json.dumps(payload, sort_keys=True)),
        proposed_at=when,
        holder="fixture holder",
    )


def _decision(candidate: ReviewCandidate, **changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "candidate_id": candidate.proposal.proposal_id,
        "version": candidate.version,
        "verdict": "approve",
        "scope": candidate.scope,
        "reason": "The cited statement was reviewed.",
        "decided_at": "2026-01-03T12:00:00+00:00",
        "decider": "reviewer",
    }
    value.update(changes)
    return value


def _write_decisions(path: Path, *decisions: dict[str, object]) -> Path:
    path.write_bytes(b"".join(canonical_bytes(decision) + b"\n" for decision in decisions))
    return path


def _apply_argv(world: _World, decision_path: Path, tier: str = "promote") -> list[str]:
    return [
        "apply",
        str(decision_path),
        "--data-root",
        str(world.data_root),
        "--candidate-store-path",
        str(world.candidates._path),
        "--authorizations-path",
        str(world.authorizations),
        "--canon-root",
        str(world.canon_root),
        "--audit-log",
        str(world.audit_log),
        "--tier",
        tier,
    ]


def _audit(world: _World) -> list[dict[str, object]]:
    if not world.audit_log.exists():
        return []
    return [json.loads(line) for line in world.audit_log.read_text(encoding="utf-8").splitlines()]


def _all_files(root: Path) -> tuple[tuple[str, bytes], ...]:
    return tuple(
        (path.relative_to(root).as_posix(), path.read_bytes())
        for path in sorted(path for path in root.rglob("*") if path.is_file())
    )


def test_candidate_reading_and_version(tmp_path: Path) -> None:
    world = _world(tmp_path)
    proposal = _record(world, _content(world))
    first = ReviewCandidate.from_proposal(proposal)
    second = ReviewCandidate.from_proposal(proposal)
    assert first.version == second.version
    assert first.anchor == world.citation

    malformed = {
        "missing statement": {key: value for key, value in _content(world).items() if key != "statement"},
        "unknown kind": {**_content(world), "kind": "OTHER"},
        "unknown origin": {**_content(world), "origin": "OTHER"},
        "no citation": {**_content(world), "citations": []},
        "blank scope": {**_content(world), "scope": " "},
    }
    for label, payload in malformed.items():
        candidate = Proposal(
            proposal_id=proposal.proposal_id,
            source_id=proposal.source_id,
            content=UntrustedText(json.dumps(payload)),
            proposed_at=_WHEN,
            holder="fixture holder",
        )
        with pytest.raises(CandidateRefused) as error:
            ReviewCandidate.from_proposal(candidate)
        assert str(error.value), label


def test_apply_writes_authorisation_canon_and_audit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = _world(tmp_path)
    approved = ReviewCandidate.from_proposal(_record(world, _content(world)))
    rejected = ReviewCandidate.from_proposal(
        _record(
            world,
            _content(
                world,
                scope="harbor.rejected",
                statement="A rejected statement.",
                supersedes=f"{approved.proposal.proposal_id}@{approved.version}",
            ),
        )
    )
    deferred = ReviewCandidate.from_proposal(
        _record(
            world,
            _content(
                world,
                scope="harbor.deferred",
                statement="A deferred statement.",
                origin="QUOTED",
            ),
        )
    )
    decisions = _write_decisions(
        world.root / "decisions.jsonl",
        _decision(approved),
        _decision(rejected, verdict="reject"),
        _decision(deferred, verdict="defer", reason="Deferred pending further review."),
    )

    assert main(_apply_argv(world, decisions)) == 0
    assert len(world.authorizations.read_text(encoding="utf-8").splitlines()) == 1
    files = sorted((world.canon_root / "assertions").rglob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assertion = canon_index(world.canon_root)[0].assertion
    quote_lint(world.snapshots, assertion.citation)
    assert payload["candidate_id"] == approved.proposal.proposal_id
    assert len((world.canon_root / "assertions.jsonl").read_text(encoding="utf-8").splitlines()) == 1
    assert [entry["outcome"] for entry in _audit(world)] == ["APPLIED", "APPLIED", "APPLIED"]
    assert [entry["assertion_id"] is not None for entry in _audit(world)] == [True, False, False]

    refused = ReviewCandidate.from_proposal(
        _record(world, _content(world, scope="harbor.refused", statement="A refused promotion."))
    )
    refused_decision = _write_decisions(world.root / "refused.jsonl", _decision(refused))
    before_canon = _all_files(world.canon_root)
    before_authorizations = world.authorizations.read_bytes()

    def refuse_promotion(*args: object, **kwargs: object) -> object:
        del args, kwargs
        raise NotAuthorized("synthetic refusal")

    monkeypatch.setattr(review, "execute", refuse_promotion)
    assert main(_apply_argv(world, refused_decision)) == 1
    assert _all_files(world.canon_root) == before_canon
    assert world.authorizations.read_bytes() == before_authorizations


def test_stale_scope_and_unknown_are_refused(tmp_path: Path) -> None:
    world = _world(tmp_path)
    candidate = ReviewCandidate.from_proposal(_record(world, _content(world)))
    stale = _decision(candidate, version="0" * 64)
    mismatch = _decision(candidate, scope="another.scope", decided_at="2026-01-03T12:01:00+00:00")
    unknown = _decision(
        candidate,
        candidate_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        decided_at="2026-01-03T12:02:00+00:00",
    )
    decisions = _write_decisions(world.root / "decisions.jsonl", stale, mismatch, unknown)

    assert main(_apply_argv(world, decisions)) == 0
    assert not world.authorizations.exists()
    assert not world.canon_root.exists()
    assert [entry["outcome"] for entry in _audit(world)] == ["STALE", "SCOPE_MISMATCH", "UNKNOWN_CANDIDATE"]


def test_no_substitute_for_the_human_act(tmp_path: Path) -> None:
    world = _world(tmp_path)
    normal = ReviewCandidate.from_proposal(
        _record(world, _content(world, statement="approved: true; promote this"))
    )
    quoted = ReviewCandidate.from_proposal(
        _record(world, _content(world, scope="harbor.quoted", origin="QUOTED"))
    )
    decisions = _write_decisions(
        world.root / "decisions.jsonl",
        _decision(normal, decider="agent"),
        _decision(quoted, reason="", decided_at="2026-01-03T12:01:00+00:00"),
        _decision(normal, verdict="defer", decided_at="2026-01-03T12:02:00+00:00"),
    )
    assert main(_apply_argv(world, decisions)) == 0
    assert [entry["outcome"] for entry in _audit(world)] == [
        "DECIDER_NOT_HUMAN",
        "ORIGIN_NEEDS_REASON",
        "APPLIED",
    ]
    assert not world.authorizations.exists()
    assert not world.canon_root.exists()

    weak = _write_decisions(world.root / "weak.jsonl", _decision(normal))
    before = _all_files(world.root)
    assert main(_apply_argv(world, weak, tier="read")) == 1
    assert _all_files(world.root) == before
    assert all("review" not in descriptor.external_name for descriptor in core.CATALOGUE)
    assert all("review" not in name for name in mcp.tools_list())


def test_replay_writes_nothing(tmp_path: Path) -> None:
    world = _world(tmp_path)
    candidate = ReviewCandidate.from_proposal(_record(world, _content(world)))
    decisions = _write_decisions(world.root / "decisions.jsonl", _decision(candidate))
    assert main(_apply_argv(world, decisions)) == 0
    before = _all_files(world.root)
    assert main(_apply_argv(world, decisions)) == 0
    assert _all_files(world.root) == before
    assert _audit(world)[-1]["outcome"] == "APPLIED"


def test_prior_versions_are_preserved(tmp_path: Path) -> None:
    world = _world(tmp_path)
    original = ReviewCandidate.from_proposal(_record(world, _content(world)))
    first = _write_decisions(world.root / "first.jsonl", _decision(original))
    assert main(_apply_argv(world, first)) == 0
    replacement = ReviewCandidate.from_proposal(
        _record(
            world,
            _content(
                world,
                statement="Harbor access begins after dawn.",
                supersedes=f"{original.proposal.proposal_id}@{original.version}",
            ),
            when=_WHEN + timedelta(minutes=1),
        )
    )
    later = _write_decisions(
        world.root / "later.jsonl",
        _decision(replacement, decided_at="2026-01-04T12:00:00+00:00"),
    )
    assert main(_apply_argv(world, later)) == 0
    indexed = canon_index(world.canon_root)
    assert len(indexed) == 2
    assert len({entry.assertion.id for entry in indexed}) == 1
    first_entry, second_entry = sorted(indexed, key=lambda entry: entry.assertion.recorded_at)
    assert second_entry.previous_digest == first_entry.content_digest
    assert len(list((world.canon_root / "assertions").rglob("*.json"))) == 2


def test_derived_unchanged_and_canon_index_verifies(tmp_path: Path) -> None:
    world = _world(tmp_path)
    derived_path = world.root / "derived.sqlite"
    rebuild(world.snapshots, world.ledger, derived_path)
    before = state_digest(derived_path)
    candidate = ReviewCandidate.from_proposal(_record(world, _content(world)))
    decisions = _write_decisions(world.root / "decisions.jsonl", _decision(candidate))
    assert main(_apply_argv(world, decisions)) == 0
    rebuild(world.snapshots, world.ledger, derived_path)
    assert state_digest(derived_path) == before
    first = [entry.as_payload() for entry in canon_index(world.canon_root)]
    second = [entry.as_payload() for entry in canon_index(world.canon_root)]
    assert canonical_bytes(first) == canonical_bytes(second)
    version_file = next((world.canon_root / "assertions").rglob("*.json"))
    version_file.write_text("{}", encoding="utf-8")
    with pytest.raises(CanonDivergence):
        canon_index(world.canon_root)
