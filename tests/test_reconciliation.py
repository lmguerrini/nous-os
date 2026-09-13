"""Synthetic checks for the typed reconciliation boundary."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
import nous_os.reconciliation as reconciliation
from nous_os.capability import Grant, NotAuthorized, Tier, execute
from nous_os.ledger import Ledger, ingest
from nous_os.provenance import Citation, Locator, quote_lint
from nous_os.reconciliation import (
    Claim,
    Claims,
    DuplicateRelation,
    EvidenceBasis,
    Exclusion,
    Lineage,
    Origin,
    Relation,
    RelationClass,
    RelationEnd,
    RelationError,
    RelationProposal,
    RelationStore,
    TemporalBasis,
    TextView,
    UnresolvableRelationEvidence,
    lineage_relations,
    text_equality_relations,
)
from nous_os.snapshots import SnapshotStore
from nous_os.sources import (
    ExportIdentity,
    IdentityBasis,
    IdentityRegistry,
    SightingLog,
    SourceKind,
    SourceRecord,
    ingest_export,
)
from nous_os.untrusted import UntrustedText


LEFT_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
RIGHT_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"
THIRD_SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAB"
AT = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)


class _World:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.snapshots = SnapshotStore(root / "snapshots")
        self.left = self.snapshots.put(LEFT_SOURCE, b"left evidence")
        self.later = self.snapshots.put(LEFT_SOURCE, b"later evidence")
        self.right = self.snapshots.put(RIGHT_SOURCE, b"right evidence")
        self.third = self.snapshots.put(THIRD_SOURCE, b"third evidence")
        self.store = RelationStore(root / "relations.jsonl")


def _citation(snapshot, text: str | None = None) -> Citation:
    span = snapshot.data.decode("utf-8") if text is None else text
    return Citation(snapshot.source_id, snapshot.digest, Locator(0, len(span.encode("utf-8"))), span)


def _claims(world: _World) -> Claims:
    return Claims(
        Claim(_citation(world.left), AT, TemporalBasis.STATED_TIME),
        Claim(_citation(world.right), AT, TemporalBasis.RECORD_TIME),
    )


def _proposal(world: _World, relation_class: RelationClass) -> RelationProposal:
    left = RelationEnd(LEFT_SOURCE, world.left.digest, "fixture-source")
    right = RelationEnd(RIGHT_SOURCE, world.right.digest, "fixture-source")
    common = {
        "left": left,
        "right": right,
        "origin": Origin.OPERATOR,
        "producer": "fixture/1",
        "proposed_at": AT,
    }
    if relation_class is RelationClass.SAME_SOURCE:
        return RelationProposal(
            relation_class, bases=(EvidenceBasis.PROVIDER_IDENTITY,), citations=(), **common
        )
    if relation_class is RelationClass.REVISION:
        return RelationProposal(
            relation_class,
            left=RelationEnd(LEFT_SOURCE, world.left.digest, "fixture-source"),
            right=RelationEnd(LEFT_SOURCE, world.later.digest, "fixture-source"),
            bases=(EvidenceBasis.LEDGER_LINEAGE,),
            citations=(),
            lineage=Lineage(world.left.digest),
            origin=Origin.MECHANICAL,
            producer="fixture-lineage/1",
            proposed_at=AT,
        )
    if relation_class is RelationClass.RESTATEMENT:
        return RelationProposal(
            relation_class,
            bases=(EvidenceBasis.TEXT_EQUALITY,),
            citations=(_citation(world.left), _citation(world.right)),
            **common,
        )
    if relation_class is RelationClass.RELATED:
        return RelationProposal(
            relation_class,
            bases=(EvidenceBasis.MODEL_JUDGEMENT,),
            citations=(_citation(world.left), _citation(world.right)),
            **common,
        )
    if relation_class is RelationClass.CONTRADICTION:
        return RelationProposal(
            relation_class,
            bases=(EvidenceBasis.COMPARABLE_CLAIMS,),
            citations=(),
            claims=_claims(world),
            scope="fixture scope",
            **common,
        )
    if relation_class is RelationClass.UNKNOWN:
        return RelationProposal(
            relation_class, bases=(), citations=(), notes="the relation is not established", **common
        )
    raise AssertionError(relation_class)


def test_each_class_is_constructible_and_round_trips(tmp_path: Path) -> None:
    """O1: each class has one stable canonical representation."""
    world = _World(tmp_path)
    for number, relation_class in enumerate(RelationClass):
        proposal = _proposal(world, relation_class)
        relation = proposal.recorded(f"rel_01ARZ3NDEKTSV4RRFFQ69G5FA{number}")
        restored = Relation.from_payload(relation.as_payload())
        assert restored.as_payload() == relation.as_payload()
        assert reconciliation.canonical_bytes(restored.as_payload()) == reconciliation.canonical_bytes(
            relation.as_payload()
        )


def test_inadmissible_relations_are_refused_by_class(tmp_path: Path) -> None:
    """O2: class names are enforced at construction, before any store can write."""
    world = _World(tmp_path)
    same = _proposal(world, RelationClass.SAME_SOURCE)
    for basis in (EvidenceBasis.TEXT_EQUALITY, EvidenceBasis.BYTE_EQUALITY, EvidenceBasis.MODEL_JUDGEMENT):
        with pytest.raises(RelationError, match="SAME_SOURCE"):
            replace(same, bases=(basis,))

    revision = _proposal(world, RelationClass.REVISION)
    with pytest.raises(RelationError, match="same source_id"):
        replace(revision, right=RelationEnd(RIGHT_SOURCE, world.right.digest, "fixture-source"))
    with pytest.raises(RelationError, match="different providers"):
        replace(revision, right=RelationEnd(LEFT_SOURCE, world.later.digest, "other-source"))
    with pytest.raises(RelationError, match="requires lineage"):
        replace(revision, lineage=None)
    with pytest.raises(RelationError, match="left earlier digest"):
        replace(revision, lineage=Lineage(world.later.digest))

    restatement = _proposal(world, RelationClass.RESTATEMENT)
    with pytest.raises(RelationError, match="PROVIDER_IDENTITY"):
        replace(restatement, bases=(EvidenceBasis.PROVIDER_IDENTITY, EvidenceBasis.TEXT_EQUALITY))
    with pytest.raises(RelationError, match="citation on each end"):
        replace(restatement, citations=(_citation(world.left),))

    contradiction = _proposal(world, RelationClass.CONTRADICTION)
    for exclusion in Exclusion:
        with pytest.raises(RelationError, match=exclusion.name):
            replace(contradiction, exclusions=(exclusion,))
    with pytest.raises(RelationError, match="requires claims"):
        replace(contradiction, claims=None)
    with pytest.raises(RelationError, match="shared scope"):
        replace(contradiction, scope=None)
    with pytest.raises(RelationError, match="valid_at"):
        Claim(_citation(world.left), datetime(2026, 9, 13, 12, 0), TemporalBasis.STATED_TIME)

    with pytest.raises(RelationError, match="UNKNOWN requires notes"):
        replace(_proposal(world, RelationClass.UNKNOWN), notes=" ")
    for relation_class in RelationClass:
        proposal = _proposal(world, relation_class)
        with pytest.raises(RelationError, match="identical source version"):
            replace(proposal, right=proposal.left)


def test_unresolvable_evidence_is_refused_at_record_time(tmp_path: Path) -> None:
    """O3: an invalid quote or absent end leaves the append-only file untouched."""
    world = _World(tmp_path)
    good = _proposal(world, RelationClass.UNKNOWN)
    missing_digest = "f" * 64
    cases = (
        replace(
            good,
            citations=(Citation(LEFT_SOURCE, missing_digest, Locator(0, 1), "x"),),
        ),
        replace(good, citations=(Citation(LEFT_SOURCE, world.left.digest, Locator(0, 1), "x"),)),
        replace(good, citations=(Citation(LEFT_SOURCE, world.left.digest, Locator(0, 999), "x"),)),
        replace(good, right=RelationEnd(THIRD_SOURCE, missing_digest, "fixture-source")),
    )
    for proposal in cases:
        before = world.store.path.read_bytes() if world.store.path.exists() else b""
        with pytest.raises(UnresolvableRelationEvidence):
            world.store.record(proposal, world.snapshots)
        after = world.store.path.read_bytes() if world.store.path.exists() else b""
        assert after == before


def test_replay_writes_nothing(tmp_path: Path) -> None:
    """O4, partially: duplicate content is refused before another JSON line is appended."""
    world = _World(tmp_path)
    relation = world.store.record(_proposal(world, RelationClass.RELATED), world.snapshots)
    before = world.store.path.read_bytes()
    with pytest.raises(DuplicateRelation):
        world.store.record(_proposal(world, RelationClass.RELATED), world.snapshots)
    assert world.store.path.read_bytes() == before
    assert relation.content_digest == world.store.relations()[0].content_digest


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(path for path in root.rglob("*") if path.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def test_recording_relations_mutates_no_source_store(tmp_path: Path) -> None:
    """O5: relation recording touches only its dedicated noncanonical JSONL store."""
    snapshots = SnapshotStore(tmp_path / "snapshots")
    ledger = Ledger(tmp_path / "ledger.jsonl")
    registry = IdentityRegistry(tmp_path / "identities.jsonl")
    sightings = SightingLog(tmp_path / "sightings.jsonl")
    first = SourceRecord(
        provider="fixture-one", account="account", kind=SourceKind.MESSAGE,
        external_id="message-a", identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload={"text": "first"}, locator="first.json",
    )
    revised = replace(first, payload={"text": "later"}, locator="later.json")
    second = SourceRecord(
        provider="fixture-one", account="account", kind=SourceKind.MESSAGE,
        external_id="message-b", identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload={"text": "shared"}, locator="second.json",
    )
    third = SourceRecord(
        provider="fixture-two", account="account", kind=SourceKind.MESSAGE,
        external_id="message-c", identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
        payload={"text": "shared"}, locator="third.json",
    )
    grant = Grant("fixture", frozenset({Tier.PROMOTE}))
    def take(export_id: str, provider: str, records: tuple[SourceRecord, ...]):
        return ingest_export(
            grant=grant, store=snapshots, ledger=ledger, registry=registry, sightings=sightings,
            export=ExportIdentity(provider, export_id, "2026-09-13T00:00:00+00:00", "1"),
            records=records, recorded_at=AT,
        )
    first_report = take("first", "fixture-one", (first,))
    revised_report = take("later", "fixture-one", (revised, second))
    third_report = take("other", "fixture-two", (third,))
    first_identity = registry.resolve(first)
    second_identity = registry.resolve(second)
    third_identity = registry.resolve(third)
    assert first_identity is not None and second_identity is not None and third_identity is not None
    first_digest = first_report.results[0].snapshot_digest
    revised_digest = revised_report.results[0].snapshot_digest
    second_digest = revised_report.results[1].snapshot_digest
    third_digest = third_report.results[0].snapshot_digest
    assert all(digest is not None for digest in (first_digest, revised_digest, second_digest, third_digest))
    left = RelationEnd(first_identity.source_id, first_digest, "fixture-one")
    revised_end = RelationEnd(first_identity.source_id, revised_digest, "fixture-one")
    second_end = RelationEnd(second_identity.source_id, second_digest, "fixture-one")
    third_end = RelationEnd(third_identity.source_id, third_digest, "fixture-two")
    def brace(end: RelationEnd) -> Citation:
        return Citation(end.source_id, end.snapshot_digest, Locator(0, 1), "{")
    relation_store = RelationStore(tmp_path / "relations.jsonl")
    proposals = (
        RelationProposal(RelationClass.SAME_SOURCE, left, second_end, (EvidenceBasis.PROVIDER_IDENTITY,), (), Origin.OPERATOR, "fixture/1", AT),
        RelationProposal(RelationClass.REVISION, left, revised_end, (EvidenceBasis.LEDGER_LINEAGE,), (), Origin.MECHANICAL, "fixture-lineage/1", AT, lineage=Lineage(first_digest)),
        RelationProposal(RelationClass.RESTATEMENT, second_end, third_end, (EvidenceBasis.TEXT_EQUALITY,), (brace(second_end), brace(third_end)), Origin.OPERATOR, "fixture/1", AT),
        RelationProposal(RelationClass.RELATED, second_end, third_end, (EvidenceBasis.MODEL_JUDGEMENT,), (brace(second_end), brace(third_end)), Origin.OPERATOR, "fixture/1", AT),
        RelationProposal(RelationClass.CONTRADICTION, second_end, third_end, (EvidenceBasis.COMPARABLE_CLAIMS,), (), Origin.OPERATOR, "fixture/1", AT, scope="fixture scope", claims=Claims(Claim(brace(second_end), AT, TemporalBasis.STATED_TIME), Claim(brace(third_end), AT, TemporalBasis.RECORD_TIME))),
        RelationProposal(RelationClass.UNKNOWN, second_end, third_end, (), (), Origin.OPERATOR, "fixture/1", AT, notes="the relation is not established"),
    )
    before = (
        _tree_digest(tmp_path / "snapshots"), ledger.path.read_bytes(), registry.path.read_bytes(),
        sightings.path.read_bytes(), {key: value.source_id for key, value in registry.held().items()},
    )
    for proposal in proposals:
        relation_store.record(proposal, snapshots)
    after = (
        _tree_digest(tmp_path / "snapshots"), ledger.path.read_bytes(), registry.path.read_bytes(),
        sightings.path.read_bytes(), {key: value.source_id for key, value in registry.held().items()},
    )
    assert after == before
    same_source = next(record for record in relation_store.relations() if record.relation_class is RelationClass.SAME_SOURCE)
    assert same_source.left.source_id != same_source.right.source_id


def test_no_authority_moves_through_the_boundary(tmp_path: Path) -> None:
    """O6: READ cannot record, and the implementation has no route to a source writer."""
    world = _World(tmp_path)
    with pytest.raises(NotAuthorized):
        execute(
            Grant("reader", frozenset({Tier.READ})),
            "propose_relation",
            store=world.store,
            snapshots=world.snapshots,
            proposal=_proposal(world, RelationClass.UNKNOWN),
        )
    assert all(descriptor.tier is not Tier.PROMOTE for descriptor in core.CATALOGUE)
    source = Path(reconciliation.__file__).read_text(encoding="utf-8")
    for forbidden in ("nous_os.canonical", "nous_os.adjudication", "Ledger.append", "IdentityRegistry.mint"):
        assert forbidden not in source


def test_mechanical_producers_emit_evidence_linked_proposals(tmp_path: Path) -> None:
    """O7: lineage from the ledger; restatement from equal text, cited from each snapshot; bounded."""
    world = _World(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl")
    ingest(world.snapshots, ledger, LEFT_SOURCE, UntrustedText("first"), AT)
    ingest(world.snapshots, ledger, LEFT_SOURCE, UntrustedText("second"), AT)
    proposals = lineage_relations(ledger)
    assert len(proposals) == 1
    assert proposals[0].relation_class is RelationClass.REVISION
    assert proposals[0].lineage is not None

    shared = "the harbour keeper logs the fog watch at dawn and again at dusk, every day"
    other = "the harbour keeper logs nothing when the lamp is dark and the boats are in"
    left = world.snapshots.put(LEFT_SOURCE, json.dumps({"text": shared}).encode("utf-8"))
    right = world.snapshots.put(RIGHT_SOURCE, json.dumps({"text": shared}).encode("utf-8"))
    third = world.snapshots.put(THIRD_SOURCE, json.dumps({"text": other}).encode("utf-8"))
    views = (
        TextView(LEFT_SOURCE, left.digest, "fixture-a", shared),
        TextView(RIGHT_SOURCE, right.digest, "fixture-b", shared),
        TextView(THIRD_SOURCE, third.digest, "fixture-a", other),
        TextView(LEFT_SOURCE, left.digest, "fixture-a", shared),  # the same version twice is not a pair
        TextView(RIGHT_SOURCE, right.digest, "fixture-b", "ok"),   # below the length bound
    )
    result = text_equality_relations(views, store=world.snapshots, proposed_at=AT)
    assert len(result.proposals) == 1 and result.short_texts_skipped == 1 and result.unlocatable == 0
    restatement = result.proposals[0]
    assert restatement.relation_class is RelationClass.RESTATEMENT
    assert {restatement.left.source_id, restatement.right.source_id} == {LEFT_SOURCE, RIGHT_SOURCE}
    for citation in restatement.citations:
        quote_lint(world.snapshots, citation)
    # a view whose text is not in its own snapshot is counted, never cited
    wrong = (TextView(LEFT_SOURCE, left.digest, "fixture-a", other), TextView(THIRD_SOURCE, third.digest, "fixture-a", other))
    result = text_equality_relations(wrong, store=world.snapshots, proposed_at=AT)
    assert result.proposals == () and result.unlocatable == 1
    # a group beyond the bound is counted, never expanded
    many = tuple(TextView(LEFT_SOURCE, left.digest, "fixture-a", shared) for _ in range(3)) + tuple(
        TextView(RIGHT_SOURCE, right.digest, "fixture-b", shared) for _ in range(3)
    )
    assert text_equality_relations(many, store=world.snapshots, max_group=1, proposed_at=AT).oversized_groups == 1
    with pytest.raises(RelationError):
        text_equality_relations(views, store=None)  # type: ignore[arg-type]


def test_verify_reports_and_never_deletes(tmp_path: Path) -> None:
    """O7: verification reports a missing snapshot while preserving the relation bytes."""
    world = _World(tmp_path)
    world.store.record(_proposal(world, RelationClass.RELATED), world.snapshots)
    before = world.store.path.read_bytes()
    assert world.store.verify(world.snapshots).unresolvable == 0
    path = world.snapshots._path(RIGHT_SOURCE, world.right.digest)
    path.unlink()
    verification = world.store.verify(world.snapshots)
    assert verification.unresolvable == 1
    assert verification.unresolvable_ids == (world.store.relations()[0].relation_id,)
    assert world.store.path.read_bytes() == before


def test_transport_parity_for_reconcile_operations(tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    """O8: the generated CLI and stdio routes share payloads and workspace resolution."""
    world = _World(tmp_path)
    data_root = tmp_path / "documents"
    data_root.mkdir()
    workspace = core.resolve_workspace(
        data_root=data_root,
        snapshot_root=world.root / "snapshots",
        ledger_path=world.root / "ledger.jsonl",
        derived_path=world.root / "derived.sqlite",
        candidate_store_path=world.root / "candidates.jsonl",
        bridge_registry_path=world.root / "bridges.jsonl",
        rejection_memory_path=world.root / "rejections.jsonl",
        relation_store_path=world.store.path,
    )
    proposal = _proposal(world, RelationClass.UNKNOWN).as_payload()
    monkeypatch.setattr(reconciliation, "new_relation_id", lambda: "rel_01ARZ3NDEKTSV4RRFFQ69G5FAV")
    argv = [
        "--data-root", str(workspace.data_root.path),
        "--snapshot-root", str(workspace.snapshot_root),
        "--ledger-path", str(workspace.ledger_path),
        "--derived-path", str(workspace.derived_path),
        "--candidate-store-path", str(workspace.candidate_store_path),
        "--bridge-registry-path", str(workspace.bridge_registry_path),
        "--rejection-memory-path", str(workspace.rejection_memory_path),
        "--relation-store-path", str(workspace.relation_store_path),
        "--tier", "read", "--tier", "propose", "reconcile.propose", "--relation", json.dumps(proposal),
    ]
    assert cli.main(argv) == 0
    cli_value = json.loads(capsys.readouterr().out)
    mcp_workspace = replace(workspace, relation_store_path=world.root / "relations-mcp.jsonl")
    response = mcp.dispatch(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "reconcile.propose", "arguments": {"relation": proposal}}},
        Grant("fixture", frozenset({Tier.READ, Tier.PROPOSE})),
        mcp_workspace,
    )
    mcp_value = json.loads(response["result"]["content"][0]["text"])
    assert mcp_value == cli_value
    resolved = core.resolve_workspace(
        data_root=data_root,
        snapshot_root=world.root / "snapshot-env",
        ledger_path=world.root / "ledger-env.jsonl",
        derived_path=world.root / "derived-env.sqlite",
        candidate_store_path=world.root / "candidates-env.jsonl",
        bridge_registry_path=world.root / "bridges-env.jsonl",
        rejection_memory_path=world.root / "rejections-env.jsonl",
        relation_store_path=None,
        environ={core.RELATION_STORE_PATH_ENV_VAR: str(world.root / "relations-env.jsonl")},
    )
    assert resolved.relation_store_path == (world.root / "relations-env.jsonl").resolve()
    with pytest.raises(core.AliasedWorkspaceLocation):
        core.resolve_workspace(
            data_root=data_root,
            snapshot_root=world.root / "snapshot-alias",
            ledger_path=world.root / "ledger-alias.jsonl",
            derived_path=world.root / "derived-alias.sqlite",
            candidate_store_path=world.root / "aliased.jsonl",
            bridge_registry_path=world.root / "bridges-alias.jsonl",
            rejection_memory_path=world.root / "rejections-alias.jsonl",
            relation_store_path=world.root / "aliased.jsonl",
        )
