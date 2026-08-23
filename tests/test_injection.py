"""Injection decisions must be content independent and measurably executed.

A zero count of unauthorized effects can also mean that no attempt ran.  This
suite prevents that failure by deriving every matrix axis from live bindings,
counting every cell, requiring real authorized effects, and reporting an empty
run or one with no real positive effect as ``NOT_RUN`` through the project's
existing measurement status.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import unicodedata
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from enum import Enum
from itertools import combinations
from pathlib import Path
from typing import NoReturn

import pytest

import nous_os.__main__ as command_line
import nous_os.capability as authority
import nous_os.operations as operation_bindings
from nous_os.candidates import CandidateStore, Proposal
from nous_os.capability import Grant, NotAuthorized, Tier, execute
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.config import DataRoot
from nous_os.derived import SearchHit, build
from nous_os.adjudication import (
    HumanDecision,
    PromotionRecord,
    Rejection,
    RejectionMemory,
    Verdict,
)
from nous_os.attribution import AttributedKey, KeyOrigin
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    RoundResult,
    RoundStatus,
)
from nous_os.identity import canonical_bytes
from nous_os.ledger import IngestResult, IngestStatus, Ledger
from nous_os.measure import RunStatus, not_run
from nous_os.provenance import Citation, Locator
from nous_os.projection import (
    ALL_TIME,
    KnowledgeState,
    PolicyId,
    ProjectionIR,
    RELIABILITY,
    SCHEMA_VERSION,
    substrate,
)
from nous_os.snapshots import SnapshotStore
from nous_os.temporal import AsOf, ClaimKey, Conflict, Overlap, TemporalIndex
from nous_os.untrusted import UntrustedText


_CORPUS_PATH = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "synthetic"
    / "injection"
    / "CORPUS.jsonl"
)
_PINNED_CORPUS_COUNT = 28
_PINNED_CORPUS_DIGEST = (
    "bf838242633f661c03ac68f6b8a9ae473f355a13bc5ee08b315329d93abc780c"
)
_REQUIRED_FAMILIES = frozenset(
    {
        "direct_instruction",
        "role_reassignment",
        "control_channel_markup",
        "credential_solicitation",
        "tier_name_injection",
        "operation_name_injection",
        "serialized_grant_injection",
        "encoding_lookalike",
        "italian_instruction",
    }
)
_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_RECORDED_AT = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
_TEMPORAL_KEY = ClaimKey("seeded-claim")
_BENIGN_TEXT = "beta"
_SEEDED_CONTENT = "alpha beta signal in a source document"
_SEEDED_DIGEST = hashlib.sha256(_SEEDED_CONTENT.encode("utf-8")).hexdigest()
_SEEDED_PROPOSAL_CONTENT = "alpha proposal"
_SEEDED_PROPOSAL_HOLDER = "fixture holder"
_DERIVATION = "injection_defence"
_ACCOUNTED_TEST_REGISTRATION_MODULES = frozenset(
    {"test_capability", "tests.test_capability"}
)


@dataclass(frozen=True, slots=True)
class _CorpusEntry:
    """One fixture row whose label supplies its asserted family."""

    identifier: str
    text: str
    label: str

    @property
    def family(self) -> str:
        return self.label.partition(":")[0]

    @property
    def form(self) -> str:
        return self.label.partition(":")[2]


@dataclass(frozen=True, slots=True)
class _Operation:
    """One package operation, taken from the live registry binding."""

    name: str
    tier: Tier
    implementation: Callable[..., object]


@dataclass(frozen=True, slots=True)
class _Transport:
    """One reachable public call path bound to the governed entry function."""

    name: str
    entry: Callable[..., object]


@dataclass(frozen=True, slots=True)
class _World:
    """Small real stores used to distinguish refusal from execution."""

    root: Path
    snapshots: SnapshotStore
    ledger: Ledger
    derived_path: Path
    data_root: DataRoot
    citation: Citation
    candidates: CandidateStore
    temporal: TemporalIndex
    bridges: BridgeRegistry
    rejections: RejectionMemory
    rejection_reads: RejectionMemory
    rejected_card: BridgeCard
    discovery_card: BridgeCard
    attributed_key: AttributedKey
    decision: HumanDecision
    authorizations: Path


@dataclass(frozen=True, slots=True)
class _CanonDigest:
    """A digest together with the byte counts that produced it."""

    value: str
    snapshot_bytes: int
    ledger_bytes: int


class _Outcome(Enum):
    """The three observable boundary result classes."""

    EXECUTED = "authorized_and_executed"
    REFUSED = "refused_by_authority"
    FAILED = "failed_otherwise"


@dataclass(frozen=True, slots=True)
class _Invocation:
    """The boundary decision and the effects visible around one call."""

    outcome: _Outcome
    returned: object | None
    error: Exception | None
    canon_before: _CanonDigest
    canon_after: _CanonDigest
    candidates_before: tuple[Proposal, ...]
    candidates_after: tuple[Proposal, ...]
    authorizations_before: bytes
    authorizations_after: bytes


@dataclass(frozen=True, slots=True)
class _MatrixResult:
    """Counts that make a completed run distinguishable from an empty one."""

    status: RunStatus
    executed: int
    expected: int
    positive_controls: int


class _PathCarrier(os.PathLike[str]):
    """A valid path argument that also carries ingested text as data."""

    __slots__ = ("_path", "injection_text")

    def __init__(self, path: Path, text: str) -> None:
        self._path = path
        self.injection_text = UntrustedText(text)

    def __fspath__(self) -> str:
        return os.fspath(self._path)


class _DataRootCarrier:
    """A root-shaped argument with an explicit untrusted data field."""

    __slots__ = ("_root", "injection_text")

    def __init__(self, root: DataRoot, text: str) -> None:
        self._root = root
        self.injection_text = UntrustedText(text)

    @property
    def path(self) -> Path:
        return self._root.path


class _SnapshotCarrier:
    """A snapshot-store argument carrying text without changing store behavior."""

    __slots__ = ("_store", "injection_text")

    def __init__(self, store: SnapshotStore, text: str) -> None:
        self._store = store
        self.injection_text = UntrustedText(text)

    def get(self, source_id: str, digest: str) -> object:
        return self._store.get(source_id, digest)


class _CandidateCarrier:
    """A candidate-store argument carrying text while delegating real reads."""

    __slots__ = ("_store", "injection_text")

    def __init__(self, store: CandidateStore, text: str) -> None:
        self._store = store
        self.injection_text = UntrustedText(text)

    def proposals(self) -> tuple[Proposal, ...]:
        return self._store.proposals()


class _RejectionMemoryCarrier:
    """A rejection-memory argument carrying text while delegating real reads."""

    __slots__ = ("_memory", "injection_text")

    def __init__(self, memory: RejectionMemory, text: str) -> None:
        self._memory = memory
        self.injection_text = UntrustedText(text)

    def rejections(self) -> tuple[Rejection, ...]:
        return self._memory.rejections()


class _BridgeRegistryCarrier:
    """Attach fixture text to an exact bridge registry without proxying it.

    ``run_round`` deliberately accepts only an exact ``BridgeRegistry``.  The
    carrier therefore marks the real instance, so the same typed argument can
    exercise both the read and discovery operations.
    """

    def __new__(cls, registry: BridgeRegistry, text: str) -> BridgeRegistry:
        del cls
        registry.injection_text = UntrustedText(text)
        return registry


class _TemporalCarrier:
    """A real temporal index that carries text without changing its query."""

    __slots__ = ("_index", "injection_text")

    def __init__(self, index: TemporalIndex, text: str) -> None:
        self._index = index
        self.injection_text = UntrustedText(text)

    def as_of(
        self,
        *,
        valid_at: datetime | None = None,
        recorded_as_of: datetime | None = None,
    ) -> AsOf:
        return self._index.as_of(
            valid_at=valid_at,
            recorded_as_of=recorded_as_of,
        )

    def conflicts(self, key: ClaimKey | None = None) -> tuple[Conflict, ...]:
        return self._index.conflicts(key)

    def supersession(self, key: ClaimKey) -> tuple[Assertion, ...]:
        return self._index.supersession(key)


class _LyingString(str):
    """A string value whose equality answer is deliberately false data."""

    def __eq__(self, other: object) -> bool:
        return True

    __hash__ = str.__hash__


class _ClassClaim:
    """An argument value that reports a class different from its real type."""

    @property
    def __class__(self) -> type[Grant]:
        return Grant


class _HashCollision:
    """An argument value whose hash equals one registered operation name."""

    def __init__(self, name: str) -> None:
        self._hash = hash(name)

    def __hash__(self) -> int:
        return self._hash


def _fail_not_run(reason: str) -> NoReturn:
    """Fail with the shared third-state vocabulary, never as an empty pass."""
    result = not_run(_DERIVATION, reason)
    assert result.status is RunStatus.NOT_RUN
    pytest.fail(f"{result.status.name}: {result.reason}")


def _require_nonempty(values: tuple[object, ...], description: str) -> None:
    """Turn an absent matrix axis into the project's explicit third state."""
    if not values:
        _fail_not_run(f"the derived {description} set was empty")


def _load_corpus() -> tuple[_CorpusEntry, ...]:
    """Load the pinned fixture line by line and validate its closed shape."""
    raw = _CORPUS_PATH.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == _PINNED_CORPUS_DIGEST
    lines = raw.decode().splitlines()
    assert len(lines) == _PINNED_CORPUS_COUNT
    entries: list[_CorpusEntry] = []
    for number, line in enumerate(lines, start=1):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            pytest.fail(f"corpus line {number} is not JSON: {error}")
        assert type(payload) is dict
        assert set(payload) == {"id", "text", "label"}
        assert all(type(payload[key]) is str and payload[key] for key in payload)
        entries.append(_CorpusEntry(payload["id"], payload["text"], payload["label"]))
    if not entries:
        _fail_not_run("the pinned hostile corpus was empty")
    assert len({entry.identifier for entry in entries}) == len(entries)
    return tuple(entries)


def _registered_operations() -> tuple[_Operation, ...]:
    """Derive project-owned operation identities from live registry entries."""
    found: list[_Operation] = []
    excluded: list[str] = []
    for name, entry in authority._REGISTRY.items():
        tier, implementation = entry
        module = getattr(implementation, "__module__", None)
        if type(module) is str and (
            module == "nous_os" or module.startswith("nous_os.")
        ):
            found.append(_Operation(name, tier, implementation))
        elif module in _ACCOUNTED_TEST_REGISTRATION_MODULES:
            # These permanent registrations are exercised by their defining tests.
            continue
        else:
            excluded.append(name)
    assert not excluded, (
        "registered entries excluded from injection enumeration: "
        f"{sorted(excluded)!r}"
    )
    operations = tuple(sorted(found, key=lambda operation: operation.name))
    _require_nonempty(operations, "registered project operation")
    return operations


def _accepts_transport_call(candidate: object) -> bool:
    """Whether one callable accepts the public boundary's call shape."""
    if not callable(candidate):
        return False
    try:
        inspect.signature(candidate).bind(object(), "probe", probe=object())
    except (TypeError, ValueError):
        return False
    return True


def _derived_transports() -> tuple[_Transport, ...]:
    """Derive unique public callables accepting the boundary call shape."""
    exported = getattr(authority, "__all__", ())
    assert len(exported) == len(set(exported)), (
        "the public export list contains duplicate transport candidates"
    )
    found = tuple(
        _Transport(f"{authority.__name__}.{name}", vars(authority)[name])
        for name in exported
        if name in vars(authority) and _accepts_transport_call(vars(authority)[name])
    )
    _require_nonempty(found, "transport")
    assert len({transport.name for transport in found}) == len(found)
    assert len({id(transport.entry) for transport in found}) == len(found), (
        "the transport derivation repeats one callable through multiple exports"
    )
    return found


def _grant_tier_sets() -> tuple[frozenset[Tier], ...]:
    """Derive every tier combination, including pairs and the full set."""
    tiers = tuple(Tier)
    _require_nonempty(tiers, "tier vocabulary")
    grants = tuple(
        frozenset(selected)
        for size in range(len(tiers) + 1)
        for selected in combinations(tiers, size)
    )
    _require_nonempty(grants, "grant")
    return grants


def _bridge_card(*, card_id: str, cluster_id: str, failed: Gate | None) -> BridgeCard:
    """Build one exact candidate card used to observe registry-layer effects."""
    outcomes = {gate: GateOutcome.PASS for gate in Gate}
    reasons: dict[Gate, str] = {}
    if failed is not None:
        outcomes[failed] = GateOutcome.FAIL
        reasons[failed] = f"{failed.value} failed in the seeded fixture"
    endpoint = Endpoint(
        "seeded project",
        Citation(_SOURCE_ID, _SEEDED_DIGEST, Locator(0, 5), "alpha"),
        "alpha",
    )
    return BridgeCard(
        card_id=card_id,
        cluster_id=cluster_id,
        left=endpoint,
        right=Endpoint(
            "second seeded project",
            Citation(_SOURCE_ID, _SEEDED_DIGEST, Locator(0, 5), "alpha"),
            "alpha",
        ),
        epistemic_class=EpistemicClass.DERIVED,
        depth=Depth.DEEP,
        non_triviality="The fixture crosses two seeded projects.",
        consequence="The fixture changes a reviewable relationship.",
        noise_objection="The shared seeded word may be coincidental.",
        gates=GateVector(outcomes, reasons),
        origin_round=1,
    )


def _build_world(root: Path) -> _World:
    """Create one canonical source, a readable index, and one proposal."""
    canon_root = root / "canon"
    snapshots = SnapshotStore(canon_root / "snapshots")
    ledger = Ledger(canon_root / "ledger.jsonl")
    seeded = operation_bindings.ingest(
        snapshots,
        ledger,
        _SOURCE_ID,
        UntrustedText(_SEEDED_CONTENT),
        _RECORDED_AT,
    )
    assert seeded.entry is not None
    derived_path = build(snapshots, ledger, root / "derived.sqlite")
    documents = root / "documents"
    documents.mkdir()
    (documents / "source.md").write_text(_SEEDED_CONTENT)
    candidates = CandidateStore(root / "candidates.jsonl")
    candidates.record(
        source_id=_SOURCE_ID,
        content=UntrustedText(_SEEDED_PROPOSAL_CONTENT),
        proposed_at=_RECORDED_AT,
        holder=_SEEDED_PROPOSAL_HOLDER,
    )
    citation = Citation(
        _SOURCE_ID,
        seeded.entry.snapshot_digest,
        Locator(0, 5),
        "alpha",
    )
    temporal = TemporalIndex()
    for number in (1, 2):
        temporal.add(
            _TEMPORAL_KEY,
            Assertion(
                id=f"asr_{number:026X}",
                text=f"temporal assertion {number}",
                citation=citation,
                support=SupportClass.DIRECT_QUOTE,
                recorded_at=_RECORDED_AT,
                state=LifecycleState.CANONICAL,
                valid_from=_RECORDED_AT,
            ),
        )
    bridges = BridgeRegistry(root / "bridges.jsonl")
    rejections = RejectionMemory(root / "rejections.jsonl")
    rejection_reads = RejectionMemory(root / "rejection-reads.jsonl")
    rejected_card = _bridge_card(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        cluster_id="seeded-rejected-cluster",
        failed=Gate.G1,
    )
    discovery_card = _bridge_card(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAB",
        cluster_id="seeded-discovery-cluster",
        failed=None,
    )
    bridges.record(rejected_card)
    rejections.record(
        cluster_id=rejected_card.cluster_id,
        failed_gate=Gate.G1.value,
        reason="cross_project failed in the seeded fixture",
        round_number=1,
        rejected_at=_RECORDED_AT,
    )
    rejection_reads.record(
        cluster_id=rejected_card.cluster_id,
        failed_gate=Gate.G1.value,
        reason="cross_project failed in the seeded fixture",
        round_number=1,
        rejected_at=_RECORDED_AT,
    )
    attributed_key = AttributedKey(ClaimKey("seeded-promotion"), KeyOrigin.OPERATOR)
    decision = HumanDecision(
        "seeded adjudicator",
        Verdict.PROMOTE,
        _RECORDED_AT,
        "The seeded fixture received a valid human decision.",
        attributed_key,
    )
    return _World(
        root=canon_root,
        snapshots=snapshots,
        ledger=ledger,
        derived_path=derived_path,
        data_root=DataRoot(documents),
        citation=citation,
        candidates=candidates,
        temporal=temporal,
        bridges=bridges,
        rejections=rejections,
        rejection_reads=rejection_reads,
        rejected_card=rejected_card,
        discovery_card=discovery_card,
        attributed_key=attributed_key,
        decision=decision,
        authorizations=root / "authorizations.jsonl",
    )


def _canon_digest(world: _World) -> _CanonDigest:
    """Hash snapshot paths and bytes plus the exact ledger bytes."""
    digest = hashlib.sha256()
    snapshot_root = world.root / "snapshots"
    snapshot_bytes = 0
    for path in sorted(path for path in snapshot_root.rglob("*") if path.is_file()):
        payload = path.read_bytes()
        snapshot_bytes += len(payload)
        digest.update(path.relative_to(world.root).as_posix().encode())
        digest.update(b"\0")
        digest.update(payload)
        digest.update(b"\0")
    ledger_payload = (
        world.ledger.path.read_bytes() if world.ledger.path.is_file() else b""
    )
    digest.update(b"ledger\0")
    digest.update(ledger_payload)
    return _CanonDigest(digest.hexdigest(), snapshot_bytes, len(ledger_payload))


def _authorization_bytes(world: _World) -> bytes:
    """Read the complete authorization record, including an absent-file zero."""
    return world.authorizations.read_bytes() if world.authorizations.is_file() else b""


def _search_arguments(world: _World, text: str) -> dict[str, object]:
    # Raw corpus punctuation is often full-text query syntax and can be invalid.
    # Quote hostile text as one literal expression and join the seeded control
    # term so every authorized query has an observable, non-empty search effect.
    # The path carrier separately preserves the original fixture text exactly.
    escaped = text.replace('"', '""')
    query = text if text == _BENIGN_TEXT else f'{_BENIGN_TEXT} OR "{escaped}"'
    return {"path": _PathCarrier(world.derived_path, text), "query": query}


def _sources_arguments(world: _World, text: str) -> dict[str, object]:
    # Its only argument is a path; changing it to corpus text changes the store.
    return {"path": _PathCarrier(world.derived_path, text)}


def _versions_arguments(world: _World, text: str) -> dict[str, object]:
    # A path and source identifier cannot carry arbitrary text without
    # changing identity.
    return {
        "path": _PathCarrier(world.derived_path, text),
        "source_id": _SOURCE_ID,
    }


def _span_arguments(world: _World, text: str) -> dict[str, object]:
    # Store identity and citation coordinates cannot vary without changing
    # the read.
    return {
        "store": _SnapshotCarrier(world.snapshots, text),
        "citation": world.citation,
    }


def _documents_arguments(world: _World, text: str) -> dict[str, object]:
    # The root is a path; replacing it with corpus text selects a different
    # corpus.
    return {"root": _DataRootCarrier(world.data_root, text)}


def _proposals_arguments(world: _World, text: str) -> dict[str, object]:
    # Its only argument is the store itself, so text travels in the carrier.
    return {"store": _CandidateCarrier(world.candidates, text)}


def _rejections_arguments(world: _World, text: str) -> dict[str, object]:
    """Its only argument is the store, so text travels in the carrier."""
    return {"memory": _RejectionMemoryCarrier(world.rejection_reads, text)}


def _bridges_arguments(world: _World, text: str) -> dict[str, object]:
    """Its only argument is the registry, so text travels in the carrier."""
    return {"registry": _BridgeRegistryCarrier(world.bridges, text)}


def _discover_arguments(world: _World, text: str) -> dict[str, object]:
    """The exact registry carries text while recording an accepted card."""
    return {
        "round_number": 1,
        "candidates": (world.discovery_card,),
        "registry": _BridgeRegistryCarrier(world.bridges, text),
        "memory": world.rejections,
        "at": _RECORDED_AT,
        "consult_memory": False,
    }


def _adjudicate_arguments(world: _World, text: str) -> dict[str, object]:
    """The durable rejection reason is the typed functional text argument."""
    return {
        "memory": world.rejections,
        "cluster_id": "matrix-adjudication-cluster",
        "failed_gate": Gate.G2.value,
        "reason": text,
        "round_number": 2,
        "rejected_at": _RECORDED_AT,
    }


def _promote_candidate_arguments(world: _World, text: str) -> dict[str, object]:
    """A path carrier preserves text while selecting the real record destination."""
    return {
        "decision": world.decision,
        "candidate": world.candidates.proposals()[0],
        "authorizations": _PathCarrier(world.authorizations, text),
    }


def _as_of_arguments(world: _World, text: str) -> dict[str, object]:
    """Keep hostile text in the carrier while querying established assertions."""
    return {
        "index": _TemporalCarrier(world.temporal, text),
        "recorded_as_of": _RECORDED_AT,
    }


def _conflicts_arguments(world: _World, text: str) -> dict[str, object]:
    """Keep hostile text in the carrier while querying seeded disagreement."""
    return {"index": _TemporalCarrier(world.temporal, text), "key": _TEMPORAL_KEY}


def _supersession_arguments(world: _World, text: str) -> dict[str, object]:
    """Keep hostile text in the carrier while querying seeded history."""
    return {"index": _TemporalCarrier(world.temporal, text), "key": _TEMPORAL_KEY}


def _project_arguments(world: _World, text: str) -> dict[str, object]:
    """Carry text in a typed bridge endpoint read by the projection substrate."""
    card = world.bridges.cards()[0]
    text_card = replace(card, left=replace(card.left, quote=text))
    return {
        "state": KnowledgeState(world.temporal, bridges=(text_card,)),
        "policy": RELIABILITY,
    }


def _record_arguments(world: _World, text: str) -> dict[str, object]:
    # Content is arbitrary functional text and is written into the proposal.
    return {
        "store": world.candidates,
        "source_id": _SOURCE_ID,
        "content": UntrustedText(text),
        "proposed_at": _RECORDED_AT,
        "holder": "matrix holder",
    }


def _ingest_arguments(world: _World, text: str) -> dict[str, object]:
    # Content is arbitrary functional text and is written into canon.
    revision = world.ledger.path.stat().st_size
    return {
        "store": world.snapshots,
        "ledger": world.ledger,
        "source_id": _SOURCE_ID,
        "content": UntrustedText(f"{text}\nrevision {revision}"),
        "recorded_at": _RECORDED_AT,
    }


_ARGUMENT_BUILDERS: Mapping[
    Callable[..., object], Callable[[_World, str], dict[str, object]]
] = {
    operation_bindings.search: _search_arguments,
    operation_bindings.sources: _sources_arguments,
    operation_bindings.versions: _versions_arguments,
    operation_bindings.read_span: _span_arguments,
    operation_bindings.list_documents: _documents_arguments,
    operation_bindings.describe_corpus: _documents_arguments,
    operation_bindings.proposals: _proposals_arguments,
    operation_bindings.rejections: _rejections_arguments,
    operation_bindings.bridges: _bridges_arguments,
    operation_bindings.discover: _discover_arguments,
    operation_bindings.adjudicate: _adjudicate_arguments,
    operation_bindings.promote_candidate: _promote_candidate_arguments,
    operation_bindings.as_of: _as_of_arguments,
    operation_bindings.conflicts: _conflicts_arguments,
    operation_bindings.supersession: _supersession_arguments,
    operation_bindings.project_knowledge: _project_arguments,
    operation_bindings.record_proposal: _record_arguments,
    operation_bindings.ingest: _ingest_arguments,
}


def _argument_carries_text(
    operation: _Operation,
    value: object,
    text: str,
) -> bool:
    """Whether an argument carries the fixture text as typed data."""
    if type(value) is str:
        return value == text
    if type(value) is UntrustedText:
        data = value.as_data()
        if operation.implementation is operation_bindings.ingest:
            # Ingesting identical bytes is a no-op, so a structured revision
            # suffix is required to make every authorized call produce an effect.
            prefix = f"{text}\nrevision "
            if not data.startswith(prefix):
                return False
            revision = data[len(prefix) :]
            return revision.isascii() and revision.isdecimal()
        return data == text
    if type(value) is KnowledgeState:
        return any(
            endpoint.quote == text
            for card in value.bridges
            for endpoint in (card.left, card.right)
        )
    marker = getattr(value, "injection_text", None)
    return type(marker) is UntrustedText and marker.as_data() == text


def _arguments(operation: _Operation, world: _World, text: str) -> dict[str, object]:
    """Select arguments by implementation identity and guard full coverage."""
    builder = _ARGUMENT_BUILDERS.get(operation.implementation)
    if builder is None:
        pytest.fail(
            f"registered operation {operation.name!r} has no bound argument builder"
        )
    arguments = builder(world, text)
    assert any(
        _argument_carries_text(operation, value, text)
        for value in arguments.values()
    )
    return arguments


def _invoke(
    transport: _Transport,
    grant: Grant,
    operation: _Operation,
    arguments: dict[str, object],
    world: _World,
) -> _Invocation:
    """Call once and classify execution, authority refusal, or another failure."""
    canon_before = _canon_digest(world)
    candidates_before = world.candidates.proposals()
    authorizations_before = _authorization_bytes(world)
    returned: object | None = None
    error: Exception | None = None
    outcome = _Outcome.EXECUTED
    try:
        returned = transport.entry(grant, operation.name, **arguments)
    except NotAuthorized as caught:
        outcome = _Outcome.REFUSED
        error = caught
    except Exception as caught:
        outcome = _Outcome.FAILED
        error = caught
    canon_after = _canon_digest(world)
    candidates_after = world.candidates.proposals()
    authorizations_after = _authorization_bytes(world)
    if outcome is _Outcome.REFUSED:
        assert canon_after == canon_before
        assert candidates_after == candidates_before
        assert authorizations_after == authorizations_before
    return _Invocation(
        outcome,
        returned,
        error,
        canon_before,
        canon_after,
        candidates_before,
        candidates_after,
        authorizations_before,
        authorizations_after,
    )


def _assert_same_boundary_outcome(
    reference: _Invocation,
    sample: _Invocation,
) -> None:
    """Compare the result class and the exact exception class, if any."""
    assert sample.outcome is reference.outcome
    assert type(sample.error) is type(reference.error)


def _assert_same_authorization_decision(
    reference: _Invocation,
    sample: _Invocation,
) -> None:
    """Compare permit or refusal while allowing ordinary operation failures."""
    assert (sample.outcome is _Outcome.REFUSED) is (
        reference.outcome is _Outcome.REFUSED
    )
    if reference.outcome is _Outcome.REFUSED:
        assert type(reference.error) is NotAuthorized
        assert type(sample.error) is NotAuthorized


def _assert_same_observable_outcome(
    reference: _Invocation,
    sample: _Invocation,
) -> None:
    """Compare result, exception, canon, and complete candidate-store state."""
    _assert_same_boundary_outcome(reference, sample)
    assert sample.returned == reference.returned
    assert sample.canon_after == reference.canon_after
    assert sample.candidates_after == reference.candidates_after
    assert sample.authorizations_after == reference.authorizations_after


def _nonempty_items_satisfy(
    values: object,
    condition: Callable[[object], bool],
    *,
    expected_count: int | None = None,
) -> bool:
    """Require an exact, non-empty tuple whose every item meets one condition."""
    if type(values) is not tuple or not values:
        return False
    if expected_count is not None and len(values) != expected_count:
        return False
    return all(condition(value) for value in values)


def _matches_seeded_proposal(value: object) -> bool:
    """Whether one exact proposal is the complete seeded proposal."""
    return (
        type(value) is Proposal
        and value.source_id == _SOURCE_ID
        and value.content == UntrustedText(_SEEDED_PROPOSAL_CONTENT)
        and value.proposed_at == _RECORDED_AT
        and value.holder == _SEEDED_PROPOSAL_HOLDER
    )


def _matches_recorded_proposal(
    value: object,
    invocation: _Invocation,
    text: str,
) -> bool:
    """Whether one exact proposal is the complete append made by this call."""
    return (
        type(value) is Proposal
        and invocation.candidates_after
        == invocation.candidates_before + (value,)
        and value.source_id == _SOURCE_ID
        and value.content == UntrustedText(text)
        and value.proposed_at == _RECORDED_AT
        and value.holder == "matrix holder"
    )


def _matches_effectful_ingest(value: object, invocation: _Invocation) -> bool:
    """Whether one exact ingest result superseded canon and changed its bytes."""
    return (
        type(value) is IngestResult
        and value.status is IngestStatus.SUPERSEDED
        and invocation.canon_after != invocation.canon_before
    )


def _seeded_rejected_card() -> BridgeCard:
    """Return the one rejected bridge card seeded into every test world."""
    return _bridge_card(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        cluster_id="seeded-rejected-cluster",
        failed=Gate.G1,
    )


def _seeded_discovery_card() -> BridgeCard:
    """Return the one accepted bridge card proposed by every discovery call."""
    return _bridge_card(
        card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAB",
        cluster_id="seeded-discovery-cluster",
        failed=None,
    )


def _matches_seeded_rejection(value: object) -> bool:
    """Whether one exact seeded rejection survives the memory read."""
    return value == Rejection(
        cluster_id="seeded-rejected-cluster",
        failed_gate=Gate.G1.value,
        reason="cross_project failed in the seeded fixture",
        round_number=1,
        rejected_at=_RECORDED_AT,
    )


def _matches_adjudicated_rejection(value: object, text: str) -> bool:
    """Whether one exact new rejection records this call's typed reason."""
    return value == Rejection(
        cluster_id="matrix-adjudication-cluster",
        failed_gate=Gate.G2.value,
        reason=text,
        round_number=2,
        rejected_at=_RECORDED_AT,
    )


def _matches_discovery_result(value: object) -> bool:
    """Whether discovery wrote exactly one accepted candidate-layer card."""
    card = _seeded_discovery_card()
    return value == RoundResult(1, RoundStatus.COMPLETE, (card,), (card,), (), ())


def _matches_effectful_promotion(value: object, invocation: _Invocation) -> bool:
    """Whether one exact authorization record was appended for this candidate."""
    if not invocation.candidates_before:
        return False
    expected = PromotionRecord(
        proposal_id=invocation.candidates_before[0].proposal_id,
        adjudicator="seeded adjudicator",
        decided_at=_RECORDED_AT,
        verdict=Verdict.PROMOTE,
        subject_key="seeded-promotion",
        subject_origin=KeyOrigin.OPERATOR,
    )
    return (
        value == expected
        and invocation.authorizations_after
        == invocation.authorizations_before + canonical_bytes(expected.as_payload()) + b"\n"
    )


def _is_seeded_temporal_assertion(value: object) -> bool:
    """Recognize one assertion from the seeded temporal disagreement."""
    if type(value) is not Assertion:
        return False
    if value.id not in {f"asr_{number:026X}" for number in (1, 2)}:
        return False
    number = int(value.id.removeprefix("asr_"), 16)
    return (
        value.text == f"temporal assertion {number}"
        and value.recorded_at == _RECORDED_AT
        and value.valid_from == _RECORDED_AT
        and value.valid_to is None
        and value.state is LifecycleState.CANONICAL
        and value.support is SupportClass.DIRECT_QUOTE
    )


def _matches_as_of_result(value: object) -> bool:
    """Require two established assertions, never an empty temporal partition."""
    return (
        type(value) is AsOf
        and value.excluded == ()
        and value.undetermined == ()
        and _nonempty_items_satisfy(
            value.established,
            _is_seeded_temporal_assertion,
            expected_count=2,
        )
    )


def _matches_conflict(value: object) -> bool:
    """Require the populated, unresolved conflict instead of any tuple shape."""
    return (
        type(value) is Conflict
        and value.key == _TEMPORAL_KEY
        and value.overlap is Overlap.UNDETERMINED
        and _nonempty_items_satisfy(
            value.members,
            _is_seeded_temporal_assertion,
            expected_count=2,
        )
    )


def _observed_real_effect(
    operation: _Operation,
    invocation: _Invocation,
    text: str = _BENIGN_TEXT,
) -> bool:
    """Recognize a result or state change specific to each real binding."""
    if invocation.error is not None:
        return False
    implementation = operation.implementation
    returned = invocation.returned
    if implementation is operation_bindings.search:
        expected_hit = SearchHit(_SEEDED_DIGEST, _SOURCE_ID, _SEEDED_CONTENT)
        items = returned
        expected_count = 1
        condition = lambda value: (
            type(value) is SearchHit and value == expected_hit
        )
    elif implementation is operation_bindings.sources:
        items = returned
        expected_count = 1
        condition = lambda value: type(value) is str and value == _SOURCE_ID
    elif implementation is operation_bindings.versions:
        items = returned
        expected_count = 1
        condition = lambda value: type(value) is str and value == _SEEDED_DIGEST
    elif implementation is operation_bindings.read_span:
        items = (returned,)
        expected_count = 1
        condition = lambda value: type(value) is str and value == "alpha"
    elif implementation is operation_bindings.list_documents:
        items = returned
        expected_count = 1
        condition = lambda value: type(value) is str and value == "source.md"
    elif implementation is operation_bindings.describe_corpus:
        items = returned
        expected_count = 1
        condition = lambda value: (
            type(value) is tuple
            and len(value) == 2
            and type(value[0]) is str
            and value[0] == "source.md"
            and type(value[1]) is str
            and value[1] == _SEEDED_DIGEST
        )
    elif implementation is operation_bindings.proposals:
        items = returned
        expected_count = 1
        condition = _matches_seeded_proposal
    elif implementation is operation_bindings.rejections:
        items = returned
        expected_count = 1
        condition = _matches_seeded_rejection
    elif implementation is operation_bindings.bridges:
        items = returned
        expected_count = 1
        condition = lambda value: value == _seeded_rejected_card()
    elif implementation is operation_bindings.discover:
        items = (returned,)
        expected_count = 1
        condition = _matches_discovery_result
    elif implementation is operation_bindings.adjudicate:
        items = (returned,)
        expected_count = 1
        condition = lambda value: _matches_adjudicated_rejection(value, text)
    elif implementation is operation_bindings.promote_candidate:
        items = (returned,)
        expected_count = 1
        condition = lambda value: _matches_effectful_promotion(value, invocation)
    elif implementation is operation_bindings.as_of:
        items = (returned,)
        expected_count = 1
        condition = _matches_as_of_result
    elif implementation is operation_bindings.conflicts:
        items = returned
        expected_count = 1
        condition = _matches_conflict
    elif implementation is operation_bindings.supersession:
        items = returned
        expected_count = 2
        condition = _is_seeded_temporal_assertion
    elif implementation is operation_bindings.project_knowledge:
        items = (returned,)
        expected_count = 1
        condition = lambda value: (
            type(value) is ProjectionIR
            and value.schema_version == SCHEMA_VERSION
            and value.policy_id is PolicyId.RELIABILITY
            and value.question == ALL_TIME
            # bool(edges) is deliberately NOT asserted beside this: a valid ProjectionIR
            # has nodes iff it has edges, because every node kind requires an incident
            # edge and every edge requires its endpoints. Asserting both would leave
            # each unpinnable by any single control.
            and bool(value.nodes)
        )
    elif implementation is operation_bindings.record_proposal:
        items = (returned,)
        expected_count = 1
        condition = lambda value: _matches_recorded_proposal(
            value,
            invocation,
            text,
        )
    elif implementation is operation_bindings.ingest:
        items = (returned,)
        expected_count = 1
        condition = lambda value: _matches_effectful_ingest(value, invocation)
    else:
        return False
    return _nonempty_items_satisfy(
        items,
        condition,
        expected_count=expected_count,
    )


def _well_formed_wrong_results(operation: _Operation) -> tuple[object, ...]:
    """Return isolated correctly shaped false results for one operation."""
    implementation = operation.implementation
    if implementation is operation_bindings.search:
        return ((SearchHit(_SEEDED_DIGEST, _SOURCE_ID, "unrelated excerpt"),),)
    if implementation is operation_bindings.sources:
        return (("src_01ARZ3NDEKTSV4RRFFQ69G5FAW",),)
    if implementation is operation_bindings.versions:
        return (("0" * 64,),)
    if implementation is operation_bindings.read_span:
        return ("beta",)
    if implementation is operation_bindings.list_documents:
        return (("other.md",),)
    if implementation is operation_bindings.describe_corpus:
        return ((("other.md", "0" * 64),),)
    if implementation is operation_bindings.rejections:
        return ((
            Rejection(
                cluster_id="other-rejected-cluster",
                failed_gate=Gate.G1.value,
                reason="a plausible but wrong rejection",
                round_number=1,
                rejected_at=_RECORDED_AT,
            ),
        ),)
    if implementation is operation_bindings.bridges:
        return ((
            _bridge_card(
                card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAC",
                cluster_id="other-bridge-cluster",
                failed=Gate.G1,
            ),
        ),)
    if implementation is operation_bindings.discover:
        card = _seeded_discovery_card()
        return (RoundResult(1, RoundStatus.COMPLETE, (card,), (), (card,), ()),)
    if implementation is operation_bindings.adjudicate:
        return (Rejection(
            cluster_id="matrix-adjudication-cluster",
            failed_gate=Gate.G2.value,
            reason="a plausible but wrong rejection",
            round_number=2,
            rejected_at=_RECORDED_AT,
        ),)
    if implementation is operation_bindings.promote_candidate:
        return (PromotionRecord(
            proposal_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAD",
            adjudicator="other adjudicator",
            decided_at=_RECORDED_AT,
            verdict=Verdict.PROMOTE,
            subject_key="other-subject",
            subject_origin=KeyOrigin.OPERATOR,
        ),)
    if implementation in (
        operation_bindings.proposals,
        operation_bindings.record_proposal,
    ):
        proposal = Proposal(
            proposal_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            source_id=_SOURCE_ID,
            content=UntrustedText("unrelated proposal"),
            proposed_at=_RECORDED_AT,
            holder="other holder",
        )
        if implementation is operation_bindings.proposals:
            return ((proposal,),)
        return (proposal,)
    wrong_temporal_assertion = Assertion(
        id=f"asr_{3:026X}",
        text="temporal assertion 3",
        citation=Citation(
            _SOURCE_ID,
            "3" * 64,
            Locator(0, 5),
            "other",
        ),
        support=SupportClass.DIRECT_QUOTE,
        recorded_at=_RECORDED_AT,
        state=LifecycleState.CANONICAL,
        valid_from=_RECORDED_AT,
    )
    if implementation is operation_bindings.as_of:
        return (AsOf((wrong_temporal_assertion,), (), ()),)
    if implementation is operation_bindings.conflicts:
        return ((
            Conflict(
                _TEMPORAL_KEY,
                (wrong_temporal_assertion,),
                Overlap.UNDETERMINED,
            ),
        ),)
    if implementation is operation_bindings.project_knowledge:
        index = TemporalIndex()
        index.add(_TEMPORAL_KEY, wrong_temporal_assertion)
        non_empty = substrate(KnowledgeState(index))
        wrong_policy = ProjectionIR(
            non_empty.schema_version,
            PolicyId.DISCOVERY,
            non_empty.question,
            non_empty.nodes,
            non_empty.edges,
        )
        empty = ProjectionIR(SCHEMA_VERSION, PolicyId.RELIABILITY, ALL_TIME, (), ())
        return (wrong_policy, empty)
    if implementation is operation_bindings.supersession:
        return ((wrong_temporal_assertion,),)
    if implementation is operation_bindings.ingest:
        return (IngestResult(IngestStatus.UNCHANGED, None, None),)
    pytest.fail(f"registered operation {operation.name!r} has no wrong result")


def _invocation_returning(returned: object | None) -> _Invocation:
    """Build an executed call with changed state around one supplied result."""
    canon_before = _CanonDigest("0" * 64, 0, 0)
    canon_after = _CanonDigest("1" * 64, 1, 1)
    candidates_after = (returned,) if type(returned) is Proposal else ()
    return _Invocation(
        _Outcome.EXECUTED,
        returned,
        None,
        canon_before,
        canon_after,
        (),
        candidates_after,
        b"",
        b"authorization effect",
    )


def _required_tier_arguments(
    operation: _Operation,
    working: dict[str, object],
) -> dict[str, object]:
    """Merge hostile keys and values into arguments a real operation accepts."""
    required = operation.tier
    lying = _LyingString(f"{required.value}_claim")
    class_claim = _ClassClaim()
    collision = _HashCollision(operation.name)
    assert lying == object()
    assert type(class_claim) is _ClassClaim and class_claim.__class__ is Grant
    assert hash(collision) == hash(operation.name)
    adversarial: dict[str, object] = {
        required.value: required,
        required.name: required.value,
        f"{required.value}_name": required.name,
        "serialized_grant": json.dumps(
            {"holder": "argument data", "tiers": [required.value]}, sort_keys=True
        ),
        lying: required,
        "class_claim": class_claim,
        "hash_collision": collision,
    }
    return {**working, **adversarial}


def test_the_pinned_corpus_is_complete_and_covers_every_required_family() -> None:
    """A changed or narrowed fixture must fail before any decision is scored."""
    entries = _load_corpus()
    counts = Counter(entry.family for entry in entries)
    assert set(counts) == _REQUIRED_FAMILIES
    assert all(count >= 3 for count in counts.values())
    italian_forms = {
        entry.form for entry in entries if entry.family == "italian_instruction"
    }
    assert {"direct", "role_reassignment"} <= italian_forms
    encoding_texts = (
        entry.text for entry in entries if entry.family == "encoding_lookalike"
    )
    encoding_texts = tuple(encoding_texts)
    assert any("\u200b" in text or "\u2060" in text for text in encoding_texts)
    assert any(unicodedata.normalize("NFKC", text) != text for text in encoding_texts)


def test_argument_carriage_is_exact_except_for_the_ingest_revision_suffix() -> None:
    """Replacing exact carriage with substring containment admits wrapped text."""
    search_operation = _Operation("search", Tier.READ, operation_bindings.search)
    record_operation = _Operation(
        "record_proposal",
        Tier.PROPOSE,
        operation_bindings.record_proposal,
    )
    ingest_operation = _Operation(
        "ingest_source",
        Tier.PROMOTE,
        operation_bindings.ingest,
    )

    assert _argument_carries_text(search_operation, _BENIGN_TEXT, _BENIGN_TEXT)
    assert not _argument_carries_text(
        search_operation,
        f"prefix {_BENIGN_TEXT}",
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        search_operation,
        f"{_BENIGN_TEXT} suffix",
        _BENIGN_TEXT,
    )
    assert _argument_carries_text(
        record_operation,
        UntrustedText(_BENIGN_TEXT),
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        record_operation,
        UntrustedText(f"prefix {_BENIGN_TEXT}"),
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        record_operation,
        UntrustedText(f"{_BENIGN_TEXT} suffix"),
        _BENIGN_TEXT,
    )
    assert _argument_carries_text(
        ingest_operation,
        UntrustedText(f"{_BENIGN_TEXT}\nrevision 42"),
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        ingest_operation,
        UntrustedText(f"prefix {_BENIGN_TEXT}\nrevision 42"),
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        ingest_operation,
        UntrustedText(f"{_BENIGN_TEXT}\nother 42"),
        _BENIGN_TEXT,
    )
    assert not _argument_carries_text(
        ingest_operation,
        UntrustedText(f"{_BENIGN_TEXT}\nrevision arbitrary"),
        _BENIGN_TEXT,
    )


def test_registered_operation_enumeration_rejects_an_external_implementation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A foreign registry entry cannot silently shrink every injection matrix."""
    monkeypatch.setattr(authority, "_REGISTRY", dict(authority._REGISTRY))
    authority.register("review_unchecked_unlink", Tier.READ, Path.unlink)
    with pytest.raises(AssertionError, match="review_unchecked_unlink"):
        _registered_operations()


def test_registered_operations_have_the_decided_names_and_tiers() -> None:
    """Every matrix operation has the fixed authority tier chosen for it."""
    assert {operation.name: operation.tier for operation in _registered_operations()} == {
        "search": Tier.READ,
        "sources": Tier.READ,
        "versions": Tier.READ,
        "read_span": Tier.READ,
        "list_documents": Tier.READ,
        "describe_corpus": Tier.READ,
        "proposals": Tier.READ,
        "rejections": Tier.READ,
        "bridges": Tier.READ,
        "as_of": Tier.READ,
        "conflicts": Tier.READ,
        "supersession": Tier.READ,
        "project": Tier.READ,
        "record_proposal": Tier.PROPOSE,
        "discover": Tier.PROPOSE,
        "adjudicate": Tier.PROPOSE,
        "ingest_source": Tier.PROMOTE,
        "promote_candidate": Tier.PROMOTE,
    }


def test_discover_exposes_only_its_operational_keyword_arguments() -> None:
    """Discovery's governed surface may not advertise discarded content."""
    parameters = inspect.signature(operation_bindings.discover).parameters
    assert tuple(parameters) == (
        "round_number",
        "candidates",
        "registry",
        "memory",
        "at",
        "consult_memory",
    )
    assert all(
        parameter.kind is inspect.Parameter.KEYWORD_ONLY
        for parameter in parameters.values()
    )


def test_every_registered_operation_rejects_each_degenerate_effect_result() -> None:
    """An empty, absent, or wrong result cannot vacuously prove execution."""
    operations = _registered_operations()
    _require_nonempty(operations, "effect predicate operation")
    probe_text = "hostile effect probe"

    for operation in operations:
        for returned in ((), None, *_well_formed_wrong_results(operation)):
            assert _observed_real_effect(
                operation,
                _invocation_returning(returned),
                probe_text,
            ) is False


def test_transport_derivation_discovers_forwarders_and_rejects_duplicates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A forwarding export is covered once, and duplicate export names fail."""

    def review_forward(
        grant: Grant,
        name: str,
        /,
        **kwargs: object,
    ) -> object:
        return execute(grant, name, **kwargs)

    monkeypatch.setattr(authority, "review_forward", review_forward, raising=False)
    monkeypatch.setattr(authority, "__all__", (*authority.__all__, "review_forward"))
    transports = _derived_transports()
    assert {transport.entry for transport in transports} == {execute, review_forward}

    monkeypatch.setattr(authority, "__all__", (*authority.__all__, "review_forward"))
    with pytest.raises(AssertionError, match="duplicate"):
        _derived_transports()


def test_the_injection_canon_digest_is_stable_and_sensitive_to_every_input(
    tmp_path: Path,
) -> None:
    """An empty, constant, or random digest cannot validate invocation effects."""
    world = _build_world(tmp_path / "digest_sensitivity")
    first = _canon_digest(world)
    unchanged = _canon_digest(world)
    assert first.snapshot_bytes > 0
    assert first.ledger_bytes > 0
    assert unchanged == first

    snapshot_files = tuple(
        sorted(
            path
            for path in (world.root / "snapshots").rglob("*")
            if path.is_file()
        )
    )
    assert snapshot_files
    snapshot_payload = snapshot_files[0].read_bytes()
    assert snapshot_payload
    snapshot_files[0].write_bytes(
        bytes((snapshot_payload[0] ^ 1,)) + snapshot_payload[1:]
    )
    snapshot_changed = _canon_digest(world)
    assert snapshot_changed != first

    ledger_payload = world.ledger.path.read_bytes()
    world.ledger.path.write_bytes(ledger_payload + b" ")
    ledger_changed = _canon_digest(world)
    assert ledger_changed != snapshot_changed


def test_the_command_line_has_no_binding_that_can_reach_a_governed_operation(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The current command path inherits the boundary because it cannot call it."""
    operations = _registered_operations()
    targets = (
        authority,
        operation_bindings,
        execute,
        *(operation.implementation for operation in operations),
    )
    bound = tuple(command_line.main.__globals__.values())
    assert not any(value is target for value in bound for target in targets)
    assert command_line.main([]) == 0
    captured = capsys.readouterr()
    assert captured.out


def test_propose_cannot_reach_promotion_and_promote_changes_authorization_record(
    tmp_path: Path,
) -> None:
    """Every transport refuses PROPOSE before a PROMOTE control appends bytes."""
    operation = next(
        operation
        for operation in _registered_operations()
        if operation.implementation is operation_bindings.promote_candidate
    )
    assert operation.name == "promote_candidate"
    assert operation.tier is Tier.PROMOTE

    for transport in _derived_transports():
        world = _build_world(tmp_path / transport.name.replace(".", "_"))
        before = _authorization_bytes(world)
        refused = _invoke(
            transport,
            Grant("propose holder", frozenset({Tier.PROPOSE})),
            operation,
            _arguments(operation, world, _BENIGN_TEXT),
            world,
        )
        assert refused.outcome is _Outcome.REFUSED
        assert type(refused.error) is NotAuthorized
        assert refused.authorizations_before == before
        assert refused.authorizations_after == before
        assert _authorization_bytes(world) == before

        promoted = _invoke(
            transport,
            Grant("promote holder", frozenset({Tier.PROMOTE})),
            operation,
            _arguments(operation, world, _BENIGN_TEXT),
            world,
        )
        assert promoted.outcome is _Outcome.EXECUTED
        assert _observed_real_effect(operation, promoted)
        assert promoted.authorizations_before == before
        assert promoted.authorizations_after != before
        assert _authorization_bytes(world) == promoted.authorizations_after


def test_argument_content_cannot_change_any_authorization_decision(
    tmp_path: Path,
) -> None:
    """Every permit or refusal must equal its benign call for the same grant."""
    hostile = _load_corpus()
    entries = (_CorpusEntry("benign_control", _BENIGN_TEXT, "benign"), *hostile)
    operations = _registered_operations()
    transports = _derived_transports()
    grant_tier_sets = _grant_tier_sets()
    _require_nonempty(entries, "corpus plus control")
    expected = (
        len(entries) * len(operations) * len(transports) * len(grant_tier_sets)
    )
    assert expected == 8352
    if expected == 0:
        _fail_not_run("the derived corpus matrix had zero expected cells")

    reference_worlds = {
        operation.name: _build_world(tmp_path / "reference" / operation.name)
        for operation in operations
    }
    sample_worlds = {
        operation.name: _build_world(tmp_path / "sample" / operation.name)
        for operation in operations
    }
    executed = 0
    positive_controls: set[tuple[str, str, frozenset[Tier]]] = set()

    for entry in entries:
        for operation in operations:
            reference_world = reference_worlds[operation.name]
            sample_world = sample_worlds[operation.name]
            for transport in transports:
                for tier_set in grant_tier_sets:
                    grant = Grant("matrix holder", tier_set)
                    reference = _invoke(
                        transport,
                        grant,
                        operation,
                        _arguments(operation, reference_world, _BENIGN_TEXT),
                        reference_world,
                    )
                    sample = _invoke(
                        transport,
                        grant,
                        operation,
                        _arguments(operation, sample_world, entry.text),
                        sample_world,
                    )
                    executed += 1

                    _assert_same_authorization_decision(reference, sample)
                    holds_required = operation.tier in tier_set
                    if holds_required:
                        assert reference.outcome is _Outcome.EXECUTED
                        assert sample.outcome is _Outcome.EXECUTED
                        assert _observed_real_effect(operation, reference)
                        assert _observed_real_effect(operation, sample, entry.text)
                    else:
                        assert reference.outcome is _Outcome.REFUSED
                        assert sample.outcome is _Outcome.REFUSED
                        assert type(sample.error) is NotAuthorized
                        assert type(reference.error) is NotAuthorized

                    if entry.identifier == "benign_control" and holds_required:
                        positive_controls.add(
                            (transport.name, operation.name, tier_set)
                        )

    if executed == 0:
        _fail_not_run("the corpus matrix executed zero cells")
    assert executed == 8352
    assert expected == 8352
    expected_positive_controls = {
        (transport.name, operation.name, tier_set)
        for transport in transports
        for operation in operations
        for tier_set in grant_tier_sets
        if operation.tier in tier_set
    }
    assert len(expected_positive_controls) == 144
    if positive_controls != expected_positive_controls:
        absent = sorted(
            (transport, operation, sorted(tier.value for tier in tier_set))
            for transport, operation, tier_set in (
                expected_positive_controls - positive_controls
            )
        )
        _fail_not_run(f"real positive controls did not fire for {absent!r}")
    result = _MatrixResult(
        RunStatus.COMPLETE,
        executed,
        expected,
        len(positive_controls),
    )
    assert result.status is RunStatus.COMPLETE
    assert result.executed == 8352
    assert result.expected == 8352
    assert result.positive_controls == 144


def test_the_holder_is_provenance_metadata_and_carries_no_authority(
    tmp_path: Path,
) -> None:
    """An exact tier value in holder metadata equals an ordinary empty grant."""
    operations = _registered_operations()
    tiers = tuple(Tier)
    transports = _derived_transports()
    _require_nonempty(tiers, "tier vocabulary")
    world = _build_world(tmp_path / "holder_metadata")
    executed = 0
    expected = len(transports) * sum(
        1 for tier in tiers for operation in operations if operation.tier is tier
    )
    assert expected == 18
    if expected == 0:
        _fail_not_run("the holder-metadata matrix had zero expected cells")

    for transport in transports:
        for tier in tiers:
            for operation in operations:
                if operation.tier is not tier:
                    continue
                benign = _invoke(
                    transport,
                    Grant("ordinary holder", frozenset()),
                    operation,
                    _arguments(operation, world, _BENIGN_TEXT),
                    world,
                )
                claiming = _invoke(
                    transport,
                    Grant(tier.value, frozenset()),
                    operation,
                    _arguments(operation, world, _BENIGN_TEXT),
                    world,
                )
                executed += 1
                _assert_same_observable_outcome(benign, claiming)
                assert claiming.outcome is _Outcome.REFUSED
                assert benign.outcome is _Outcome.REFUSED
                assert type(claiming.error) is NotAuthorized
                assert type(benign.error) is NotAuthorized

    if executed == 0:
        _fail_not_run("the holder-metadata matrix executed zero cells")
    assert executed == 18
    assert expected == 18


def test_required_tier_argument_content_cannot_change_the_decision_in_either_direction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Required-tier keys and values neither grant authority nor cause refusal."""
    operations = _registered_operations()
    transports = _derived_transports()
    world = _build_world(tmp_path / "required_tier_arguments")
    expected = len(transports) * len(operations) * 2
    assert expected == 36
    if expected == 0:
        _fail_not_run("the required-tier argument matrix had zero expected cells")
    executed = 0

    for transport in transports:
        for operation in operations:
            working = _arguments(operation, world, _BENIGN_TEXT)
            working_names = tuple(working)
            implementation = operation.implementation

            def accepting_adversarial_arguments(**kwargs: object) -> object:
                accepted = {name: kwargs[name] for name in working_names}
                return implementation(**accepted)

            with monkeypatch.context() as registry_patch:
                registry_patch.setitem(
                    authority._REGISTRY,
                    operation.name,
                    (operation.tier, accepting_adversarial_arguments),
                )
                for grant in (
                    Grant("ordinary empty holder", frozenset()),
                    Grant("required tier holder", frozenset({operation.tier})),
                ):
                    benign_arguments = _arguments(operation, world, _BENIGN_TEXT)
                    benign = _invoke(
                        transport,
                        grant,
                        operation,
                        benign_arguments,
                        world,
                    )
                    hostile_arguments = _arguments(operation, world, _BENIGN_TEXT)
                    hostile = _invoke(
                        transport,
                        grant,
                        operation,
                        _required_tier_arguments(operation, hostile_arguments),
                        world,
                    )
                    executed += 1
                    _assert_same_boundary_outcome(benign, hostile)
                    expected_outcome = (
                        _Outcome.EXECUTED
                        if grant.holds(operation.tier)
                        else _Outcome.REFUSED
                    )
                    assert hostile.outcome is expected_outcome
                    assert benign.outcome is expected_outcome
                    if expected_outcome is _Outcome.EXECUTED:
                        assert _observed_real_effect(operation, benign)
                        assert _observed_real_effect(operation, hostile)
                    else:
                        assert type(hostile.error) is NotAuthorized
                        assert type(benign.error) is NotAuthorized

    if executed == 0:
        _fail_not_run("the required-tier argument matrix executed zero cells")
    assert executed == 36
    assert expected == 36
