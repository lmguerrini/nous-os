"""Proposals are recorded apart from canon, because arrival is not truth.

A proposal carries material from outside and records who put it forward, but
that provenance does not make the material a fact. This file is deliberately
an append-only JSON Lines record, like the ledger, so the proposal history can
be read in the order it was written without gaining any authority over canon.

There is no promotion method, no acceptance method, no approval method, and no
status field here. Lifecycle, adjudication, and rejection memory belong to a
later capability; no path from a proposal to canon exists at all at this
stage. That absence prevents a record of untrusted material from becoming a
second, accidental route into the canonical layer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from nous_os.identity import (
    ASSERTION_PREFIX, SOURCE_PREFIX,
    canonical_bytes,
    file_is_present,
    new_assertion_id,
    require_id,
)
from nous_os.provenance import DerivedCitation, ProvenanceError, derived_citation_from_payload
from nous_os.untrusted import UntrustedText


class CandidateError(Exception):
    """Raised when a proposal record cannot truthfully be stored or read."""


def read_derived_citations(
    proposal: "Proposal",
) -> tuple[tuple[DerivedCitation, ...], tuple[DerivedCitation, ...]]:
    """Read optional direct and counter extraction citations as typed evidence.

    Proposal content remains untrusted text.  This reader is intentionally
    narrow: it understands only the two optional derived-citation fields and
    does not make candidate validity or promotion decisions.
    """
    if type(proposal) is not Proposal:
        raise CandidateError("derived citations require an exact Proposal")
    try:
        payload = json.loads(proposal.content.as_data())
    except json.JSONDecodeError as error:
        raise CandidateError("proposal content is not JSON") from error
    if type(payload) is not dict:
        raise CandidateError("proposal content is not an object")

    def read(field: str) -> tuple[DerivedCitation, ...]:
        raw = payload.get(field, [])
        if type(raw) is not list:
            raise CandidateError(f"{field} must be a list")
        try:
            return tuple(derived_citation_from_payload(item) for item in raw)
        except ProvenanceError as error:
            raise CandidateError(f"{field} contains a malformed derived citation") from error

    return read("derived_citations"), read("derived_counter_citations")


def _instant(value: datetime, field: str) -> str:
    """Return one timezone-aware instant in the ledger's normal form."""
    if type(value) is not datetime:
        raise CandidateError(f"{field} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise CandidateError(f"{field} must carry a timezone")
    try:
        return value.astimezone(timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise CandidateError(f"{field} cannot be normalised to UTC") from error


@dataclass(frozen=True, slots=True)
class Proposal:
    """One untrusted proposal, recorded without changing canon."""

    proposal_id: str
    source_id: str
    content: UntrustedText
    proposed_at: datetime
    holder: str

    def __post_init__(self) -> None:
        if type(self.proposal_id) is not str:
            raise CandidateError("proposal_id must be a string")
        if type(self.source_id) is not str:
            raise CandidateError("source_id must be a string")
        try:
            # There is no proposal-specific prefix. An assertion id is the
            # existing identity for a content-bearing record, so it is the
            # closest closed vocabulary rather than a new identifier scheme.
            require_id(self.proposal_id, ASSERTION_PREFIX)
            require_id(self.source_id, SOURCE_PREFIX)
        except Exception as error:
            raise CandidateError(f"proposal identifiers are not valid: {error}") from error
        if type(self.content) is not UntrustedText:
            raise CandidateError(
                "a proposal takes UntrustedText; a bare str would make proposed "
                "content indistinguishable from text this system wrote itself"
            )
        _instant(self.proposed_at, "proposed_at")
        if type(self.holder) is not str or not self.holder.strip():
            raise CandidateError("proposal holder must be a non-blank string")

    def as_payload(self) -> dict[str, str]:
        """The one canonical representation written to the proposal record."""
        return {
            "proposal_id": self.proposal_id,
            "source_id": self.source_id,
            "content": self.content.as_data(),
            "proposed_at": _instant(self.proposed_at, "proposed_at"),
            "holder": self.holder,
        }


class CandidateStore:
    """An append-only file of proposals that has no authority over canon."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def record(
        self,
        *,
        source_id: str,
        content: UntrustedText,
        proposed_at: datetime,
        holder: str,
    ) -> Proposal:
        """Append one proposal and return the exact record that was written."""
        if type(source_id) is not str:
            raise CandidateError("source_id must be a string")
        if type(content) is not UntrustedText:
            raise CandidateError(
                "a proposal takes UntrustedText; a bare str would make proposed "
                "content indistinguishable from text this system wrote itself"
            )
        if type(proposed_at) is not datetime:
            raise CandidateError("proposed_at must be a datetime")
        if type(holder) is not str:
            raise CandidateError("proposal holder must be a string")

        proposal = Proposal(
            # The assertion facility is used because identity has no candidate
            # prefix. It mints a stable record id without deriving it from text.
            proposal_id=new_assertion_id(),
            source_id=source_id,
            content=content,
            proposed_at=proposed_at,
            holder=holder,
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(proposal.as_payload()) + b"\n")
        return proposal

    def proposals(self) -> tuple[Proposal, ...]:
        """Every recorded proposal, in file order."""
        if not file_is_present(self._path):
            return ()
        found = []
        # Records end at the newline this store writes. ``str.splitlines`` would
        # also split on U+2028, U+2029 and a form feed, which a proposal quoting
        # a source may legitimately carry inside its JSON string -- the same reader
        # idiom as the relation store.
        for number, line in enumerate(
            self._path.read_text(encoding="utf-8").split("\n"), start=1
        ):
            if not line:
                continue
            try:
                payload = json.loads(line)
                found.append(
                    Proposal(
                        proposal_id=payload["proposal_id"],
                        source_id=payload["source_id"],
                        content=UntrustedText(payload["content"]),
                        proposed_at=datetime.fromisoformat(payload["proposed_at"]),
                        holder=payload["holder"],
                    )
                )
            except (CandidateError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise CandidateError(
                    f"proposal line {number} is not readable: {error}"
                ) from error
        return tuple(found)
