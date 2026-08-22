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

from nous_os.capability import Tier, register
from nous_os.candidates import CandidateStore, Proposal
from nous_os.config import describe_corpus, list_documents
from nous_os.derived import search, sources, versions
from nous_os.ledger import ingest
from nous_os.provenance import read_span
from nous_os.untrusted import UntrustedText


def proposals(*, store: CandidateStore) -> tuple[Proposal, ...]:
    return store.proposals()


def as_of(*, index, valid_at=None, recorded_as_of=None):
    """Keep temporal history queries behind the registry's single door."""
    return index.as_of(valid_at=valid_at, recorded_as_of=recorded_as_of)


def conflicts(*, index, key=None):
    """Prevent direct temporal disagreement reads from bypassing authority."""
    return index.conflicts(key)


def supersession(*, index, key):
    """Prevent direct temporal history reads from bypassing authority."""
    return index.supersession(key)


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
register("record_proposal", Tier.PROPOSE, record_proposal)
register("ingest_source", Tier.PROMOTE, ingest)
