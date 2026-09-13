"""Register the project's real governed operations in one visible place.

The registry is the authority boundary's one door, so importing an
implementation anywhere else in the package would make a route around that
door easier to create and harder to review. This module therefore imports the
real operations and registers them when it is first imported.

No operation is registered at ``EXTERNAL_CONSEQUENTIAL_ACTION``. That tier
exists in the vocabulary and is governed by exactly the same machinery; the
first operation that genuinely reaches outside this system registers there.
Adding a placeholder would claim an outside effect that does not exist and
would make the tier look exercised when it is not.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from nous_os.capability import Tier, register
from nous_os.candidates import CandidateStore, Proposal
from nous_os.chunking import Chunk
from nous_os.compile import CohesionStrategy, Pack
from nous_os.config import describe_corpus, list_documents
from nous_os.derived import search, sources, versions
from nous_os.ledger import ingest
from nous_os.provenance import quote_lint_derived, read_span, verify_derivation
from nous_os.reconciliation import Relation, RelationClass, RelationProposal, RelationStore, RelationVerification
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText

if TYPE_CHECKING:
    from nous_os.adjudication import HumanDecision, PromotionRecord, Rejection, RejectionMemory
    from nous_os.discovery import BridgeCard, BridgeRegistry, RoundResult
    from nous_os.projection import KnowledgeState, ProjectionIR, ProjectionPolicy, TemporalQuestion


def proposals(*, store: CandidateStore) -> tuple[Proposal, ...]:
    return store.proposals()


def as_of(*, index, valid_at=None, recorded_as_of=None):
    """Keep temporal history queries behind the registry's single door."""
    return index.as_of(valid_at=valid_at, recorded_as_of=recorded_as_of)


def conflicts(*, index, key=None):
    """Register a temporal disagreement read at the governed boundary."""
    return index.conflicts(key)


def supersession(*, index, key):
    """Register a temporal-history read at the governed boundary."""
    return index.supersession(key)


def compile_context(
    *,
    chunks: tuple[Chunk, ...],
    ranking: tuple[str, ...],
    strategy: CohesionStrategy,
    budget_tokens: int,
) -> Pack:
    """Keep context compilation behind the registry's single door.

    Wraps ``compile_pack`` unchanged: it is handed a ranking and performs no
    retrieval of its own, so this registration adds no semantics beyond making
    the already-fixed behaviour reachable through the governed boundary.
    """
    from nous_os.compile import compile_pack

    return compile_pack(chunks, ranking, strategy, budget_tokens)


def project_knowledge(
    *,
    state: KnowledgeState,
    policy: ProjectionPolicy,
    question: TemporalQuestion | None = None,
) -> ProjectionIR:
    """Keep renderer-independent projection behind the registry's single door."""
    from nous_os.projection import ALL_TIME, project

    return project(state, policy, question=ALL_TIME if question is None else question)


def record_proposal(
    *,
    store: CandidateStore,
    source_id: str,
    content: UntrustedText,
    proposed_at: datetime,
    holder: str,
) -> Proposal:
    return store.record(
        source_id=source_id,
        content=content,
        proposed_at=proposed_at,
        holder=holder,
    )


def rejections(*, memory: RejectionMemory) -> tuple[Rejection, ...]:
    """Keep rejection-memory reads behind the registry's single door."""
    return memory.rejections()


def bridges(*, registry: BridgeRegistry) -> tuple[BridgeCard, ...]:
    """Keep bridge-registry reads behind the registry's single door."""
    return registry.cards()


def relations(
    *,
    store: RelationStore,
    source_id: str | None = None,
    relation_class: RelationClass | None = None,
) -> tuple[Relation, ...]:
    """Keep relation-record reads behind the registry's single door."""
    return store.relations(source_id=source_id, relation_class=relation_class)


def propose_relation(
    *, store: RelationStore, snapshots: SnapshotStore, proposal: RelationProposal
) -> Relation:
    """Keep relation-proposal recording at PROPOSE tier, never at READ."""
    return store.record(proposal, snapshots)


def verify_relations(*, store: RelationStore, snapshots: SnapshotStore) -> RelationVerification:
    """Keep non-mutating relation verification behind the registry's read door."""
    return store.verify(snapshots)


def verify_derived(*, extraction_store, snapshot_store: SnapshotStore, ledger, citation, full: bool = False) -> dict[str, object]:
    """Lint one derived citation and report a non-mutating verification result."""
    try:
        quote_lint_derived(extraction_store, snapshot_store, ledger, citation)
        result: dict[str, object] = {"ok": True}
    except Exception as error:
        result = {"ok": False, "error": type(error).__name__, "message": str(error)}
    if full:
        # The Core workspace has no archive-byte location.  The operation can
        # still report that fact through the frozen non-executable verdict;
        # callers that possess archive bytes use verify_derivation directly.
        result["verdict"] = verify_derivation(
            lambda _asset_source_id: None, extraction_store, citation
        ).as_payload()
    return result


def discover(
    *,
    round_number: int,
    candidates,
    registry: BridgeRegistry,
    memory: RejectionMemory,
    at: datetime,
    consult_memory: bool = True,
) -> RoundResult:
    """Keep candidate-layer discovery writes behind the registry's single door."""
    from nous_os.discovery import run_round

    return run_round(
        round_number=round_number,
        candidates=candidates,
        registry=registry,
        memory=memory,
        at=at,
        consult_memory=consult_memory,
    )


def adjudicate(
    *,
    memory: RejectionMemory,
    cluster_id: str,
    failed_gate: str,
    reason: str,
    round_number: int,
    rejected_at: datetime,
) -> Rejection:
    """Keep rejection verdict recording behind the registry's single door."""
    return memory.record(
        cluster_id=cluster_id,
        failed_gate=failed_gate,
        reason=reason,
        round_number=round_number,
        rejected_at=rejected_at,
    )


def promote_candidate(
    *,
    decision: HumanDecision,
    candidate: Proposal,
    authorizations,
) -> PromotionRecord:
    """Keep promotion authorization records behind the registry's single door."""
    from nous_os.adjudication import promote

    return promote(
        decision=decision,
        candidate=candidate,
        authorizations=authorizations,
    )


register("search", Tier.READ, search)
register("sources", Tier.READ, sources)
register("versions", Tier.READ, versions)
register("read_span", Tier.READ, read_span)
register("list_documents", Tier.READ, list_documents)
register("describe_corpus", Tier.READ, describe_corpus)
register("proposals", Tier.READ, proposals)
register("as_of", Tier.READ, as_of)
register("conflicts", Tier.READ, conflicts)
register("supersession", Tier.READ, supersession)
register("project", Tier.READ, project_knowledge)
register("compile_context", Tier.READ, compile_context)
register("record_proposal", Tier.PROPOSE, record_proposal)
register("ingest_source", Tier.PROMOTE, ingest)
register("rejections", Tier.READ, rejections)
register("bridges", Tier.READ, bridges)
register("discover", Tier.PROPOSE, discover)
register("adjudicate", Tier.PROPOSE, adjudicate)
register("promote_candidate", Tier.PROMOTE, promote_candidate)
register("relations", Tier.READ, relations)
register("propose_relation", Tier.PROPOSE, propose_relation)
register("verify_relations", Tier.READ, verify_relations)
register("verify_derived", Tier.READ, verify_derived)
