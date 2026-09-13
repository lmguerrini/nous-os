"""Synthetic checks for the typed reconciliation boundary."""

from __future__ import annotations

import ast
import fcntl
import gc
import hashlib
import inspect
import json
import threading
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
    """O1: each class and both provider labels have one stable representation."""
    world = _World(tmp_path)
    for number, relation_class in enumerate(RelationClass):
        proposal = _proposal(world, relation_class)
        relation = proposal.recorded(f"rel_01ARZ3NDEKTSV4RRFFQ69G5FA{number}")
        restored = Relation.from_payload(relation.as_payload())
        assert restored.as_payload() == relation.as_payload()
        assert restored.left.provider == "fixture-source"
        assert restored.right.provider == "fixture-source"
        assert reconciliation.canonical_bytes(restored.as_payload()) == reconciliation.canonical_bytes(
            relation.as_payload()
        )


def test_inadmissible_relations_are_refused_by_class(tmp_path: Path) -> None:
    """O2: class names are enforced at construction, before any store can write."""
    world = _World(tmp_path)
    same = _proposal(world, RelationClass.SAME_SOURCE)
    for basis in (
        EvidenceBasis.PROVIDER_ASSIGNED_ID,
        EvidenceBasis.TEXT_EQUALITY,
        EvidenceBasis.BYTE_EQUALITY,
        EvidenceBasis.MODEL_JUDGEMENT,
    ):
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


def test_contradiction_claim_citations_must_resolve_at_record_and_verify(tmp_path: Path) -> None:
    """O3: claim citations are evidence, not unchecked decorative fields."""
    world = _World(tmp_path)
    contradiction = _proposal(world, RelationClass.CONTRADICTION)
    assert contradiction.claims is not None
    bad_claims = Claims(
        Claim(
            Citation(LEFT_SOURCE, world.left.digest, Locator(0, 1), "x"),
            AT,
            TemporalBasis.STATED_TIME,
        ),
        contradiction.claims.right,
    )
    unresolved = replace(contradiction, claims=bad_claims)
    with pytest.raises(UnresolvableRelationEvidence, match="citation"):
        world.store.record(unresolved, world.snapshots)
    assert not world.store.path.exists()

    relation = unresolved.recorded("rel_01ARZ3NDEKTSV4RRFFQ69G5FAV")
    world.store.path.write_bytes(reconciliation.canonical_bytes(relation.as_payload()) + b"\n")
    before = world.store.path.read_bytes()
    verification = world.store.verify(world.snapshots)
    assert verification.unresolvable == 1
    assert verification.unresolvable_ids == (relation.relation_id,)
    assert world.store.path.read_bytes() == before


def test_replay_of_mechanical_producers_refuses_every_duplicate(tmp_path: Path) -> None:
    """O4: replaying either producer leaves every already-recorded byte untouched."""
    world = _World(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl")
    ingest(world.snapshots, ledger, LEFT_SOURCE, UntrustedText("first"), AT)
    ingest(world.snapshots, ledger, LEFT_SOURCE, UntrustedText("second"), AT)

    shared = "a text long enough to be mechanically checked across two source versions"
    left = world.snapshots.put(LEFT_SOURCE, json.dumps({"text": shared}).encode("utf-8"))
    right = world.snapshots.put(RIGHT_SOURCE, json.dumps({"text": shared}).encode("utf-8"))
    text_relations = text_equality_relations(
        (
            TextView(LEFT_SOURCE, left.digest, "fixture-a", shared),
            TextView(RIGHT_SOURCE, right.digest, "fixture-b", shared),
        ),
        store=world.snapshots,
        proposed_at=AT,
    ).proposals
    proposals = lineage_relations(ledger) + text_relations
    assert proposals
    for proposal in proposals:
        world.store.record(proposal, world.snapshots)
    before = world.store.path.read_bytes()
    replayed = lineage_relations(ledger) + text_equality_relations(
        (
            TextView(LEFT_SOURCE, left.digest, "fixture-a", shared),
            TextView(RIGHT_SOURCE, right.digest, "fixture-b", shared),
        ),
        store=world.snapshots,
        proposed_at=AT,
    ).proposals
    assert replayed == proposals
    for proposal in replayed:
        with pytest.raises(DuplicateRelation):
            world.store.record(proposal, world.snapshots)
    assert world.store.path.read_bytes() == before


def test_record_locks_duplicate_check_and_append_across_threads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """F1: two simultaneous records of one proposal leave exactly one JSONL line."""
    world = _World(tmp_path)
    proposal = _proposal(world, RelationClass.UNKNOWN)
    rendezvous = threading.Barrier(2)
    identifiers = iter(
        (
            "rel_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "rel_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        )
    )

    def coordinated_relation_id() -> str:
        # Without the store lock, both calls clear duplicate detection and
        # rendezvous here before either append. With it, the first times out,
        # appends, and the second sees the duplicate while holding the lock.
        try:
            rendezvous.wait(timeout=0.2)
        except threading.BrokenBarrierError:
            pass
        return next(identifiers)

    monkeypatch.setattr(reconciliation, "new_relation_id", coordinated_relation_id)
    outcomes: list[object] = []

    def record_once() -> None:
        try:
            outcomes.append(world.store.record(proposal, world.snapshots))
        except DuplicateRelation as error:
            outcomes.append(error)

    threads = (threading.Thread(target=record_once), threading.Thread(target=record_once))
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()
    assert sum(isinstance(outcome, Relation) for outcome in outcomes) == 1
    assert sum(isinstance(outcome, DuplicateRelation) for outcome in outcomes) == 1
    assert len(world.store.path.read_bytes().splitlines()) == 1

    lock_path = Path(str(world.store.path) + ".lock")
    assert lock_path.is_file()
    with lock_path.open("rb") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(handle, fcntl.LOCK_UN)


def test_corrupt_relation_end_is_refused_at_record_and_counted_at_verify(tmp_path: Path) -> None:
    """F2: end resolution verifies bytes rather than trusting a present path."""
    world = _World(tmp_path)
    recorded = world.store.record(_proposal(world, RelationClass.UNKNOWN), world.snapshots)
    before = world.store.path.read_bytes()
    world.snapshots._path(RIGHT_SOURCE, world.right.digest).write_bytes(b"corrupted")

    verification = world.store.verify(world.snapshots)
    assert verification.unresolvable == 1
    assert verification.unresolvable_ids == (recorded.relation_id,)
    with pytest.raises(UnresolvableRelationEvidence, match="end cannot be resolved"):
        world.store.record(_proposal(world, RelationClass.UNKNOWN), world.snapshots)
    assert world.store.path.read_bytes() == before


def test_relation_store_constructor_refuses_non_relation_jsonl_and_reopens_valid_store(
    tmp_path: Path,
) -> None:
    """F3: only an existing, non-empty relation JSONL file can reopen as this store."""
    world = _World(tmp_path)
    snapshot_path = world.snapshots._path(LEFT_SOURCE, world.left.digest)
    with pytest.raises(RelationError, match="relation line 1"):
        RelationStore(snapshot_path)

    empty_path = tmp_path / "empty-relations.jsonl"
    empty_path.touch()
    with pytest.raises(RelationError, match="zero-byte"):
        RelationStore(empty_path)

    recorded = world.store.record(_proposal(world, RelationClass.UNKNOWN), world.snapshots)
    reopened = RelationStore(world.store.path)
    assert reopened.relations() == (recorded,)


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
    tree = ast.parse(source)
    forbidden_modules = {"nous_os.canonical", "nous_os.adjudication"}
    forbidden_from_nous_os = {"canonical", "adjudication"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert all(alias.name not in forbidden_modules for alias in node.names)
        if isinstance(node, ast.ImportFrom):
            assert node.module not in forbidden_modules
            if node.module == "nous_os":
                assert all(alias.name not in forbidden_from_nous_os for alias in node.names)
    for forbidden in ("Ledger.append", "IdentityRegistry.mint"):
        assert forbidden not in source


def test_mechanical_producers_emit_evidence_linked_proposals(tmp_path: Path) -> None:
    """O7: lineage and text equality produce cited, bounded mechanical proposals."""
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
    with pytest.raises(RelationError):
        text_equality_relations(views, store=None, proposed_at=AT)  # type: ignore[arg-type]


def test_text_equality_requires_an_explicit_time_and_fixed_bounds(tmp_path: Path) -> None:
    """F4: the producer is reproducible and its resource bounds are not caller policy."""
    world = _World(tmp_path)
    signature = inspect.signature(text_equality_relations)
    assert signature.parameters["proposed_at"].default is inspect.Parameter.empty
    assert "min_chars" not in signature.parameters
    assert "max_group" not in signature.parameters
    assert reconciliation.MIN_TEXT_CHARS == 40
    assert reconciliation.MAX_GROUP_SOURCES == 12
    with pytest.raises(TypeError, match="proposed_at"):
        text_equality_relations((), store=world.snapshots)  # type: ignore[call-arg]
    with pytest.raises(TypeError, match="min_chars"):
        text_equality_relations((), store=world.snapshots, proposed_at=AT, min_chars=1)  # type: ignore[call-arg]


def test_text_equality_pairs_every_version_across_sources_deterministically(
    tmp_path: Path,
) -> None:
    """F4: equal text joins versions across sources, never versions of one source."""
    world = _World(tmp_path)
    text = "equal text preserved in every source version for this exact test case"
    left_first = world.snapshots.put(
        LEFT_SOURCE, json.dumps({"text": text, "version": 1}).encode("utf-8")
    )
    left_second = world.snapshots.put(
        LEFT_SOURCE, json.dumps({"text": text, "version": 2}).encode("utf-8")
    )
    right = world.snapshots.put(
        RIGHT_SOURCE, json.dumps({"text": text}).encode("utf-8")
    )
    views = (
        TextView(LEFT_SOURCE, left_first.digest, "fixture-a", text),
        TextView(LEFT_SOURCE, left_second.digest, "fixture-a", text),
        TextView(RIGHT_SOURCE, right.digest, "fixture-b", text),
    )
    forward = text_equality_relations(views, store=world.snapshots, proposed_at=AT)
    backward = text_equality_relations(reversed(views), store=world.snapshots, proposed_at=AT)
    assert forward.proposals == backward.proposals
    assert len(forward.proposals) == 2
    assert all(
        proposal.left.source_id != proposal.right.source_id
        for proposal in forward.proposals
    )
    paired_digests = {
        frozenset((proposal.left.snapshot_digest, proposal.right.snapshot_digest))
        for proposal in forward.proposals
    }
    assert paired_digests == {
        frozenset((left_first.digest, right.digest)),
        frozenset((left_second.digest, right.digest)),
    }


def test_text_equality_admits_forty_characters_and_bounds_streamed_groups(
    tmp_path: Path,
) -> None:
    """F4: exactly forty characters are eligible; an oversized stream drops views."""
    world = _World(tmp_path)
    admitted = "x" * reconciliation.MIN_TEXT_CHARS
    skipped = "y" * (reconciliation.MIN_TEXT_CHARS - 1)
    left = world.snapshots.put(LEFT_SOURCE, json.dumps({"text": admitted}).encode("utf-8"))
    right = world.snapshots.put(RIGHT_SOURCE, json.dumps({"text": admitted}).encode("utf-8"))
    result = text_equality_relations(
        (
            TextView(LEFT_SOURCE, left.digest, "fixture-a", admitted),
            TextView(RIGHT_SOURCE, right.digest, "fixture-b", admitted),
            TextView(THIRD_SOURCE, world.third.digest, "fixture-c", skipped),
        ),
        store=world.snapshots,
        proposed_at=AT,
    )
    assert len(result.proposals) == 1
    assert result.short_texts_skipped == 1

    source_ids = tuple(f"{LEFT_SOURCE[:-1]}{suffix}" for suffix in "0123456789ABC")
    streamed_text = "z" * reconciliation.MIN_TEXT_CHARS
    snapshots = tuple(
        world.snapshots.put(source_id, json.dumps({"text": streamed_text}).encode("utf-8"))
        for source_id in source_ids
    )
    seen_view_ids: set[int] = set()
    retained_counts: list[int] = []

    def streamed_views():
        for source_id, snapshot in zip(source_ids, snapshots):
            view = TextView(source_id, snapshot.digest, "fixture-stream", streamed_text)
            seen_view_ids.add(id(view))
            yield view
        for _ in range(100):
            view = TextView(source_ids[-1], snapshots[-1].digest, "fixture-stream", streamed_text)
            seen_view_ids.add(id(view))
            yield view
        gc.collect()
        retained_counts.append(
            sum(id(candidate) in seen_view_ids for candidate in gc.get_objects())
        )

    streamed = text_equality_relations(
        streamed_views(), store=world.snapshots, proposed_at=AT
    )
    assert streamed.oversized_groups == 1
    assert retained_counts and retained_counts[0] <= 13


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


def test_a_cited_span_holding_a_line_separator_does_not_split_the_store(tmp_path: Path) -> None:
    """A JSON string may carry U+2028 or a form feed; only the newline this store writes ends a record.

    A single cited text holding a line separator would otherwise make
    ``str.splitlines`` call the whole store unreadable.
    """
    world = _World(tmp_path)
    text = "before the line separator after it, and a form feed\x0cas well, long enough to cite"
    left = world.snapshots.put(LEFT_SOURCE, json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"))
    right = world.snapshots.put(RIGHT_SOURCE, json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"))
    result = text_equality_relations(
        (TextView(LEFT_SOURCE, left.digest, "fixture-a", text), TextView(RIGHT_SOURCE, right.digest, "fixture-b", text)),
        store=world.snapshots,
        proposed_at=AT,
    )
    assert len(result.proposals) == 1
    world.store.record(result.proposals[0], world.snapshots)
    assert len(world.store.relations()) == 1
    assert RelationStore(world.store.path).relations()[0].citations[0].span == json.dumps(text, ensure_ascii=False)[1:-1]
    assert world.store.verify(world.snapshots).unresolvable == 0
