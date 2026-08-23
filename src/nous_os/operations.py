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
from nous_os.config import describe_corpus, list_documents
from nous_os.derived import search, sources, versions
from nous_os.ledger import ingest
from nous_os.provenance import read_span
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
register("record_proposal", Tier.PROPOSE, record_proposal)
register("ingest_source", Tier.PROMOTE, ingest)
register("rejections", Tier.READ, rejections)
register("bridges", Tier.READ, bridges)
register("discover", Tier.PROPOSE, discover)
register("adjudicate", Tier.PROPOSE, adjudicate)
register("promote_candidate", Tier.PROMOTE, promote_candidate)
