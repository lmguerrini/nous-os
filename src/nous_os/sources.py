"""Source memory: provider records, the identity each one keeps, and where it was seen.

A provider export -- the archive an assistant service hands back when asked for
a person's data -- is **evidence that the provider exported something**. It is
not knowledge, it is not canon, and nothing in this module can make it either.
What this module does is narrower and has to be exact: it takes normalized
records from an adapter, gives each one a source identity that survives the
next export, ingests its bytes through the same governed door every other
ingest uses, and writes down which export carried which version.

Three files beside the ledger, all append-only, all canon:

**The identity registry.** One line per provider record ever seen, minted once.
An identity is not a function of content (`identity.py` says why), so the only
way a record can keep its ``src_`` id across two exports is for something to
remember the mapping. This file is that something. A line is written **before**
the record is ingested, so a process that dies in between leaves an identity
with no history -- which :func:`verify_source_memory` names -- rather than a
history under an id the next run cannot find.

**The sighting log.** One line per (source, export, version): *this export
carried these bytes of this source*. Export-scoped facts -- the export
identifier, where in the archive the record sat, when it was observed -- live
here and never in the snapshot, because a snapshot that carried them would be
a new version every time the same content was exported again.

**The ledger and the snapshot store**, unchanged from the capability that built
them. The snapshot of a record is the canonical JSON of its normalized form:
sorted keys, no insignificant whitespace, UTF-8, non-ASCII unescaped. The same
record therefore hashes to the same bytes in any process, and re-ingesting an
unchanged export is the ledger's ``UNCHANGED`` path for every record.

What this module refuses to know: any provider's name, any export format, any
filename. An adapter yields :class:`SourceRecord` values; this module ingests
them. The provider is a string the adapter observed and the caller confirmed,
carried as data. A second provider needs a second adapter and nothing here.

A bounded limitation, stated rather than hidden: a citation into one of these
snapshots quotes JSON-escaped text (``\\n``, ``\\"``). The provenance contract
is exact bytes of a snapshot and a canonical JSON satisfies it; unescaping for
display belongs to a layer that does not exist yet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Iterable

import nous_os.operations  # noqa: F401  -- registers ``ingest_source``, the driver's one door to canon
from nous_os.capability import Grant, NotAuthorized, execute, required_tier
from nous_os.identity import (
    SOURCE_PREFIX,
    Minter,
    canonical_bytes,
    digest_bytes,
    file_is_present,
    new_source_id,
    require_id,
)
from nous_os.ledger import IngestStatus, Ledger
from nous_os.snapshots import SnapshotStore
from nous_os.untrusted import UntrustedText

#: The governed operation every record goes through. Registered at the promote
#: tier by :mod:`nous_os.operations`; this module never imports its
#: implementation.
INGEST_OPERATION = "ingest_source"


class SourceMemoryError(Exception):
    """Raised when source memory would otherwise record something untrue."""


class SourceKind(Enum):
    """What a provider record is. A closed vocabulary of source classes.

    Each member is a class of evidence the provider itself keeps apart, kept
    apart here too. A design conversation is not a conversation; a memory file
    is not a memory summary; a project document is not a project. Nothing here
    ranks them, and none of them is more canonical than another -- none of them
    is canonical at all.
    """

    #: A conversation's own record: title, timestamps, which messages it holds.
    CONVERSATION = "conversation"
    #: One message in a conversation, with its parent where the provider says.
    MESSAGE = "message"
    #: A conversation of the provider's design tooling. Its messages are shaped
    #: differently and carry no parentage, so it is its own class.
    DESIGN_CONVERSATION = "design_conversation"
    #: One message in a design conversation.
    DESIGN_MESSAGE = "design_message"
    #: A provider project or workspace record: name, description, instructions.
    PROJECT = "project"
    #: A document attached to a project.
    PROJECT_DOCUMENT = "project_document"
    #: The provider's own distilled memory of a person, as one text. Evidence
    #: that the provider stored it; never evidence that it is true.
    MEMORY_SUMMARY = "memory_summary"
    #: One of the provider's memory files, identified by the path the provider
    #: gave it.
    MEMORY_FILE = "memory_file"
    #: A provider-written reflection over a period.
    REFLECTION = "reflection"
    #: A feedback record in the provider's own shape, kept opaque.
    FEEDBACK = "feedback"


class IdentityBasis(Enum):
    """Where a record's external identity came from. Recorded, never inferred later.

    A record identified by content is visibly weaker than one the provider
    numbered: edit the content and it is a different record, not a new version.
    Writing the basis down is what lets a reader tell the two apart afterwards.
    """

    #: An identifier the provider minted for this record.
    PROVIDER_IDENTIFIER = "provider_identifier"
    #: A path or name the provider uses as the record's identity.
    PROVIDER_PATH = "provider_path"
    #: A label the provider attaches that was unique in this export and is not
    #: promised to be stable.
    PROVIDER_LABEL = "provider_label"
    #: No provider identity at all: the digest of the record's content stands in.
    CONTENT = "content"


class Parentage(Enum):
    """Whether a record's parent relationship is something the export can say.

    ``REPRESENTED`` with no parent is a root. ``UNSUPPORTED_BY_PROVIDER_EXPORT``
    is a different answer: the export carries no parent field for this class of
    record, and reading its absence as "root" would fabricate a tree.
    """

    REPRESENTED = "represented"
    UNSUPPORTED_BY_PROVIDER_EXPORT = "unsupported_by_provider_export"


class Role(Enum):
    """Who a message is from, in one vocabulary across providers.

    The provider's own spelling is kept verbatim inside the record's payload;
    this is the normalized reading of it, with ``UNKNOWN`` for a spelling this
    system has not seen rather than a guess.
    """

    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"
    UNKNOWN = "unknown"


class RecordOutcome(Enum):
    """What became of one record offered to source memory. A closed vocabulary."""

    #: Ingested as a first version, an unchanged version, or a new version --
    #: the ledger's own word for which is carried beside it.
    ACCEPTED = "accepted"
    #: Two records in one export claimed one identity with different bytes.
    #: Neither is ingested: an order nobody chose is not a history.
    CONFLICTING_DUPLICATE = "conflicting_duplicate"


def _instant(value: datetime, name: str) -> str:
    if type(value) is not datetime:
        raise SourceMemoryError(f"{name} must be a datetime")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise SourceMemoryError(f"{name} must carry a timezone")
    return value.astimezone(timezone.utc).isoformat()


def _optional_text(value: object, name: str) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise SourceMemoryError(f"{name} must be a string or None")
    return value


def _required_text(value: object, name: str) -> str:
    if type(value) is not str or not value:
        raise SourceMemoryError(f"{name} must be a non-empty string")
    return value


def _json_shaped(value: object, name: str) -> None:
    """Refuse a payload that has no single canonical serialisation."""
    try:
        canonical_bytes(value)
    except (TypeError, ValueError) as error:
        raise SourceMemoryError(f"{name} must be JSON-shaped: {error}") from error


@dataclass(frozen=True, slots=True)
class ExportIdentity:
    """Which export a set of records came from.

    ``export_id`` is the provider's own identifier for the export; ``created_at``
    is the provider's timestamp for it, kept verbatim rather than parsed, and
    ``archive_digest`` is the digest of the immutable archive the export was
    read from -- supplied by the caller, because an adapter reads a directory
    and cannot know which archive it was unpacked from.
    """

    provider: str
    export_id: str
    created_at: str
    format_version: str
    archive_digest: str | None = None

    def __post_init__(self) -> None:
        _required_text(self.provider, "provider")
        _required_text(self.export_id, "export_id")
        _required_text(self.created_at, "created_at")
        _required_text(self.format_version, "format_version")
        _optional_text(self.archive_digest, "archive_digest")


@dataclass(frozen=True, slots=True)
class SourceRecord:
    """One provider record, normalized, with its provider payload kept verbatim.

    The neutral fields are this project's vocabulary; ``payload`` is the
    provider's, untouched, beneath them. ``locator`` says where in the export
    the record was read from and is deliberately **not** part of the snapshot
    (see :meth:`snapshot_payload`): the same record may sit under another
    filename in the next export.
    """

    provider: str
    account: str
    kind: SourceKind
    external_id: str
    identity_basis: IdentityBasis
    payload: object
    locator: str
    container_external_id: str | None = None
    parent_external_id: str | None = None
    parentage: Parentage = Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT
    role: Role | None = None
    created_at: str | None = None
    updated_at: str | None = None
    content_type: str = "application/json"
    attachments: tuple[object, ...] = ()

    def __post_init__(self) -> None:
        _required_text(self.provider, "provider")
        _required_text(self.account, "account")
        if type(self.kind) is not SourceKind:
            raise SourceMemoryError("kind must be a SourceKind")
        _required_text(self.external_id, "external_id")
        if type(self.identity_basis) is not IdentityBasis:
            raise SourceMemoryError("identity_basis must be an IdentityBasis")
        _json_shaped(self.payload, "payload")
        _required_text(self.locator, "locator")
        _optional_text(self.container_external_id, "container_external_id")
        _optional_text(self.parent_external_id, "parent_external_id")
        if type(self.parentage) is not Parentage:
            raise SourceMemoryError("parentage must be a Parentage")
        if (
            self.parentage is Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT
            and self.parent_external_id is not None
        ):
            raise SourceMemoryError(
                "a record whose parentage the export cannot represent cannot name a parent"
            )
        if self.role is not None and type(self.role) is not Role:
            raise SourceMemoryError("role must be a Role or None")
        _optional_text(self.created_at, "created_at")
        _optional_text(self.updated_at, "updated_at")
        _required_text(self.content_type, "content_type")
        if type(self.attachments) is not tuple:
            raise SourceMemoryError("attachments must be a tuple")
        _json_shaped(list(self.attachments), "attachments")

    @property
    def identity_key(self) -> tuple[str, str, str, str]:
        """What names this record across exports: provider, account, kind, id."""
        return (self.provider, self.account, self.kind.value, self.external_id)

    def snapshot_payload(self) -> dict[str, object]:
        """The content that is versioned. Nothing export-scoped is in it."""
        return {
            "provider": self.provider,
            "account": self.account,
            "kind": self.kind.value,
            "external_id": self.external_id,
            "identity_basis": self.identity_basis.value,
            "container_external_id": self.container_external_id,
            "parent_external_id": self.parent_external_id,
            "parentage": self.parentage.value,
            "role": None if self.role is None else self.role.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "content_type": self.content_type,
            "attachments": list(self.attachments),
            "payload": self.payload,
        }

    def snapshot_bytes(self) -> bytes:
        """The one byte sequence this record's version is."""
        return canonical_bytes(self.snapshot_payload())


@dataclass(frozen=True, slots=True)
class Identity:
    """One line of the registry: an external identity and the source id it was given."""

    provider: str
    account: str
    kind: SourceKind
    external_id: str
    identity_basis: IdentityBasis
    source_id: str
    minted_at: datetime
    container_external_id: str | None = None

    def __post_init__(self) -> None:
        _required_text(self.provider, "provider")
        _required_text(self.account, "account")
        if type(self.kind) is not SourceKind:
            raise SourceMemoryError("kind must be a SourceKind")
        _required_text(self.external_id, "external_id")
        if type(self.identity_basis) is not IdentityBasis:
            raise SourceMemoryError("identity_basis must be an IdentityBasis")
        require_id(self.source_id, SOURCE_PREFIX)
        _instant(self.minted_at, "minted_at")
        _optional_text(self.container_external_id, "container_external_id")

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.provider, self.account, self.kind.value, self.external_id)

    def as_payload(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "account": self.account,
            "kind": self.kind.value,
            "external_id": self.external_id,
            "identity_basis": self.identity_basis.value,
            "source_id": self.source_id,
            "minted_at": _instant(self.minted_at, "minted_at"),
            "container_external_id": self.container_external_id,
        }


class IdentityRegistry:
    """External identity to source id, written once per identity, never rewritten.

    A registry that could reassign an identity would make every earlier citation
    of the old id silently wrong. So :meth:`resolve` returns what is held, and
    :meth:`mint` refuses a key that is already held rather than replacing it.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def entries(self) -> tuple[Identity, ...]:
        """Every identity, in the order minted. Unreadable is reported, not skipped."""
        if not file_is_present(self._path):
            return ()
        found = []
        for number, line in enumerate(
            self._path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line:
                continue
            try:
                payload = json.loads(line)
                found.append(
                    Identity(
                        provider=payload["provider"],
                        account=payload["account"],
                        kind=SourceKind(payload["kind"]),
                        external_id=payload["external_id"],
                        identity_basis=IdentityBasis(payload["identity_basis"]),
                        source_id=payload["source_id"],
                        minted_at=datetime.fromisoformat(payload["minted_at"]),
                        container_external_id=payload["container_external_id"],
                    )
                )
            except (SourceMemoryError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise SourceMemoryError(
                    f"identity line {number} is not readable: {error}"
                ) from error
        return tuple(found)

    def held(self) -> dict[tuple[str, str, str, str], Identity]:
        """The registry as a mapping, refusing a file that names one key twice."""
        mapping: dict[tuple[str, str, str, str], Identity] = {}
        for entry in self.entries():
            if entry.key in mapping:
                raise SourceMemoryError(
                    f"the identity registry names {entry.key!r} twice; an identity is minted once"
                )
            mapping[entry.key] = entry
        return mapping

    def resolve(self, record: SourceRecord) -> Identity | None:
        return self.held().get(record.identity_key)

    def mint(
        self, record: SourceRecord, minted_at: datetime, minter: Minter | None = None
    ) -> Identity:
        """Give ``record`` a source id it will keep. Refuses an identity already held."""
        if record.identity_key in self.held():
            raise SourceMemoryError(
                f"{record.identity_key!r} already holds an identity; resolve it instead"
            )
        identity = Identity(
            provider=record.provider,
            account=record.account,
            kind=record.kind,
            external_id=record.external_id,
            identity_basis=record.identity_basis,
            source_id=new_source_id(minter),
            minted_at=minted_at,
            container_external_id=record.container_external_id,
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(identity.as_payload()) + b"\n")
        return identity


@dataclass(frozen=True, slots=True)
class Sighting:
    """This export carried these bytes of this source, read from here."""

    source_id: str
    provider: str
    export_id: str
    snapshot_digest: str
    locator: str
    observed_at: datetime

    def __post_init__(self) -> None:
        require_id(self.source_id, SOURCE_PREFIX)
        _required_text(self.provider, "provider")
        _required_text(self.export_id, "export_id")
        _required_text(self.snapshot_digest, "snapshot_digest")
        _required_text(self.locator, "locator")
        _instant(self.observed_at, "observed_at")

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.source_id, self.export_id, self.snapshot_digest)

    def as_payload(self) -> dict[str, object]:
        return {
            "source_id": self.source_id,
            "provider": self.provider,
            "export_id": self.export_id,
            "snapshot_digest": self.snapshot_digest,
            "locator": self.locator,
            "observed_at": _instant(self.observed_at, "observed_at"),
        }


class SightingLog:
    """Append-only record of which export carried which version of which source.

    ``first_seen`` and ``last_seen`` for a source are *derived* from this file,
    never stored on the record: they are facts about exports, and a fact about
    an export written into content would make every re-export a new version.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def entries(self) -> tuple[Sighting, ...]:
        if not file_is_present(self._path):
            return ()
        found = []
        for number, line in enumerate(
            self._path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line:
                continue
            try:
                payload = json.loads(line)
                found.append(
                    Sighting(
                        source_id=payload["source_id"],
                        provider=payload["provider"],
                        export_id=payload["export_id"],
                        snapshot_digest=payload["snapshot_digest"],
                        locator=payload["locator"],
                        observed_at=datetime.fromisoformat(payload["observed_at"]),
                    )
                )
            except (SourceMemoryError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise SourceMemoryError(
                    f"sighting line {number} is not readable: {error}"
                ) from error
        return tuple(found)

    def record(self, sighting: Sighting) -> bool:
        """Append ``sighting`` unless the same (source, export, version) is already held.

        Returns whether a line was written, so a caller can count what an
        export actually added.
        """
        if any(existing.key == sighting.key for existing in self.entries()):
            return False
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("ab") as handle:
            handle.write(canonical_bytes(sighting.as_payload()) + b"\n")
        return True

    def exports_for(self, source_id: str) -> tuple[str, ...]:
        """Every export id that carried ``source_id``, in the order first recorded.

        The first element is where the source was first seen and the last is
        where it was last seen -- derived, exactly as the docstring above says.
        """
        require_id(source_id, SOURCE_PREFIX)
        seen: list[str] = []
        for entry in self.entries():
            if entry.source_id == source_id and entry.export_id not in seen:
                seen.append(entry.export_id)
        return tuple(seen)


@dataclass(frozen=True, slots=True)
class RecordResult:
    """What happened to one record."""

    kind: SourceKind
    external_id: str
    outcome: RecordOutcome
    source_id: str | None
    status: IngestStatus | None
    snapshot_digest: str | None
    identity_minted: bool
    sighting_recorded: bool

    def as_payload(self) -> dict[str, object]:
        return {
            "kind": self.kind.value,
            "external_id": self.external_id,
            "outcome": self.outcome.value,
            "source_id": self.source_id,
            "status": None if self.status is None else self.status.value,
            "snapshot_digest": self.snapshot_digest,
            "identity_minted": self.identity_minted,
            "sighting_recorded": self.sighting_recorded,
        }


@dataclass(frozen=True, slots=True)
class IngestReport:
    """Everything one export did to source memory, countable and reproducible.

    A second run of the same export produces the same report except that
    ``identities_minted`` and ``sightings_recorded`` are zero and every status
    is ``UNCHANGED``. That is the claim the report exists to make checkable.
    """

    export: ExportIdentity
    results: tuple[RecordResult, ...]
    not_sighted: tuple[str, ...] = field(default=())

    def _count(self, predicate) -> int:
        return sum(1 for result in self.results if predicate(result))

    @property
    def records_offered(self) -> int:
        return len(self.results)

    @property
    def ingested(self) -> int:
        return self._count(lambda r: r.status is IngestStatus.INGESTED)

    @property
    def unchanged(self) -> int:
        return self._count(lambda r: r.status is IngestStatus.UNCHANGED)

    @property
    def superseded(self) -> int:
        return self._count(lambda r: r.status is IngestStatus.SUPERSEDED)

    @property
    def rejected(self) -> int:
        return self._count(lambda r: r.outcome is not RecordOutcome.ACCEPTED)

    @property
    def identities_minted(self) -> int:
        return self._count(lambda r: r.identity_minted)

    @property
    def sightings_recorded(self) -> int:
        return self._count(lambda r: r.sighting_recorded)

    def counts_by_kind(self) -> dict[str, dict[str, int]]:
        """Per source class: how many were ingested, unchanged, superseded, rejected."""
        table: dict[str, dict[str, int]] = {}
        for result in self.results:
            row = table.setdefault(
                result.kind.value,
                {"ingested": 0, "unchanged": 0, "superseded": 0, "rejected": 0},
            )
            if result.outcome is not RecordOutcome.ACCEPTED:
                row["rejected"] += 1
            elif result.status is not None:
                row[result.status.value] += 1
        return table

    def as_payload(self) -> dict[str, object]:
        return {
            "export": {
                "provider": self.export.provider,
                "export_id": self.export.export_id,
                "created_at": self.export.created_at,
                "format_version": self.export.format_version,
                "archive_digest": self.export.archive_digest,
            },
            "records_offered": self.records_offered,
            "ingested": self.ingested,
            "unchanged": self.unchanged,
            "superseded": self.superseded,
            "rejected": self.rejected,
            "identities_minted": self.identities_minted,
            "sightings_recorded": self.sightings_recorded,
            "not_sighted": list(self.not_sighted),
            "by_kind": self.counts_by_kind(),
            "results": [result.as_payload() for result in self.results],
        }


def _collapse_duplicates(
    records: Iterable[SourceRecord],
) -> tuple[list[SourceRecord], list[SourceRecord]]:
    """Identical duplicates become one record; conflicting ones are set aside.

    Two records in one export with the same identity and the same bytes are one
    piece of evidence exported twice. Two with different bytes are a question
    the export cannot answer -- which is current? -- and this refuses to answer
    it by picking an order.
    """
    by_key: dict[tuple[str, str, str, str], list[SourceRecord]] = {}
    for record in records:
        if type(record) is not SourceRecord:
            raise SourceMemoryError("an adapter must yield SourceRecord values")
        by_key.setdefault(record.identity_key, []).append(record)

    accepted: list[SourceRecord] = []
    conflicting: list[SourceRecord] = []
    for key in sorted(by_key):
        group = by_key[key]
        digests = {digest_bytes(record.snapshot_bytes()) for record in group}
        if len(digests) == 1:
            accepted.append(group[0])
        else:
            conflicting.append(group[0])
    return accepted, conflicting


def ingest_export(
    *,
    grant: Grant,
    store: SnapshotStore,
    ledger: Ledger,
    registry: IdentityRegistry,
    sightings: SightingLog,
    export: ExportIdentity,
    records: Iterable[SourceRecord],
    recorded_at: datetime,
    minter: Minter | None = None,
) -> IngestReport:
    """Take one export's records into source memory and report exactly what changed.

    Refuses before any write unless ``grant`` holds the tier ``ingest_source``
    is registered at: minting an identity is a write to canon, and it happens
    before the ledger is touched. Every ingest then goes through
    :func:`nous_os.capability.execute`, which checks the same thing again --
    belt and braces, on purpose, at the one boundary that matters.

    Deterministic: records are taken in ``(kind, external_id)`` order, one
    instant is used for the whole run, and no wall clock is read here.
    """
    if type(grant) is not Grant:
        raise NotAuthorized("the grant does not hold the operation's required tier")
    tier = required_tier(INGEST_OPERATION)
    try:
        authorized = grant.holds(tier)
    except Exception:
        authorized = False
    if not authorized:
        raise NotAuthorized("the grant does not hold the operation's required tier")
    if type(export) is not ExportIdentity:
        raise SourceMemoryError("export must be an ExportIdentity")
    _instant(recorded_at, "recorded_at")

    accepted, conflicting = _collapse_duplicates(records)
    for record in accepted + conflicting:
        if record.provider != export.provider:
            raise SourceMemoryError(
                f"record {record.identity_key!r} names provider {record.provider!r}; "
                f"this export is from {export.provider!r}"
            )

    results: list[RecordResult] = []
    sighted: set[tuple[str, str, str, str]] = set()
    for record in accepted:
        identity = registry.resolve(record)
        minted = identity is None
        if identity is None:
            identity = registry.mint(record, recorded_at, minter)
        data = record.snapshot_bytes()
        result = execute(
            grant,
            INGEST_OPERATION,
            store=store,
            ledger=ledger,
            source_id=identity.source_id,
            content=UntrustedText(data.decode("utf-8")),
            recorded_at=recorded_at,
        )
        digest = digest_bytes(data)
        written = sightings.record(
            Sighting(
                source_id=identity.source_id,
                provider=export.provider,
                export_id=export.export_id,
                snapshot_digest=digest,
                locator=record.locator,
                observed_at=recorded_at,
            )
        )
        sighted.add(record.identity_key)
        results.append(
            RecordResult(
                kind=record.kind,
                external_id=record.external_id,
                outcome=RecordOutcome.ACCEPTED,
                source_id=identity.source_id,
                status=result.status,
                snapshot_digest=digest,
                identity_minted=minted,
                sighting_recorded=written,
            )
        )
    for record in conflicting:
        results.append(
            RecordResult(
                kind=record.kind,
                external_id=record.external_id,
                outcome=RecordOutcome.CONFLICTING_DUPLICATE,
                source_id=None,
                status=None,
                snapshot_digest=None,
                identity_minted=False,
                sighting_recorded=False,
            )
        )

    accounts = {record.account for record in accepted + conflicting}
    not_sighted = tuple(
        sorted(
            identity.source_id
            for identity in registry.entries()
            if identity.provider == export.provider
            and identity.account in accounts
            and identity.key not in sighted
        )
    )
    return IngestReport(export=export, results=tuple(results), not_sighted=not_sighted)


def verify_source_memory(
    registry: IdentityRegistry, ledger: Ledger, store: SnapshotStore
) -> tuple[tuple[str, str], ...]:
    """Every way the three canonical files can disagree, named. Empty means none.

    ``IDENTITY_WITHOUT_HISTORY`` -- an identity was minted and its record was
    never ingested (the process stopped in between). ``HISTORY_WITHOUT_IDENTITY``
    -- the ledger holds a source no identity names, so a re-import cannot find
    it. ``SNAPSHOT_MISSING`` -- the ledger names bytes the store does not hold.
    Each is reported with the source id; nothing here repairs anything.
    """
    problems: list[tuple[str, str]] = []
    identities = registry.held()
    known = {identity.source_id for identity in identities.values()}
    if len(known) != len(identities):
        raise SourceMemoryError("two identities share one source id")
    with_history = {entry.source_id for entry in ledger.entries()}
    for source_id in sorted(known - with_history):
        problems.append(("IDENTITY_WITHOUT_HISTORY", source_id))
    for source_id in sorted(with_history - known):
        problems.append(("HISTORY_WITHOUT_IDENTITY", source_id))
    for source_id in sorted(with_history):
        for entry in ledger.chain(source_id):
            if not store.has(source_id, entry.snapshot_digest):
                problems.append(("SNAPSHOT_MISSING", f"{source_id}:{entry.snapshot_digest}"))
    return tuple(problems)
