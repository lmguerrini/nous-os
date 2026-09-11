"""An adapter for one export format: a manifest-1.0 assistant data export.

The format, as observed and nothing more: a directory holding one manifest --
``{"version": "1.0", "data_files": [{"category": …, "export_url": …}, …]}`` --
beside the files those categories unpacked to. Six categories were seen:
conversations, design conversations, projects, memories, reflections with
feedback, and account metadata. Their filenames and folder names are **not**
part of the format this module recognises. One export named its conversations
file with a numeric suffix and its feedback category ``reflections``; the next
may do otherwise. So every file is classified by the **shape of what it
parses to**, and a file that fits no shape is reported as unclassified rather
than skipped. Archiver residue (``.DS_Store``, ``._*`` resource forks,
``__MACOSX/``) is set aside as noise only when its bytes parse to nothing;
content under such a name is classified by its shape like any other file.

**The provider is read, not written.** Nothing here names a vendor. The
provider is the host of the manifest's export URLs, and the export's identity
is the identifier those URLs share; both are observed from the input and
carried as data. A caller who knows better may name the provider explicitly,
and the observed host is still recorded beside it.

**What becomes a record.** Every provider object with an identity of its own:
a conversation without its messages, each message, a design conversation and
each of its messages, a project and each of its documents, the memory summary,
each memory file, each reflection, each feedback item. Nested children are
replaced in the parent's payload by their external identifiers, so a title
change touches one record and an appended message touches two.

**What does not.** Account metadata -- the account record and the login
history -- is classified so that it is accounted for, and produces no record:
it holds nothing a person knows, only who they are and where they signed in.
The one thing read from it is the account identifier, which scopes every
identity in the export.

**What the export cannot say is said as such.** Conversation messages carry a
parent reference and a sentinel for "none"; that is represented parentage, and
the sentinel becomes *no parent*. Design messages carry no parent field at all,
and their records say ``UNSUPPORTED_BY_PROVIDER_EXPORT`` rather than "root".
Feedback items were present in the format but empty in every export seen, so
their shape is unverified: an item with a provider identifier is identified by
it, and one without is identified by its content, visibly.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Final, Iterator
from urllib.parse import urlsplit

from nous_os.identity import canonical_bytes, digest_bytes
from nous_os.sources import (
    ExportIdentity,
    IdentityBasis,
    Parentage,
    Role,
    SourceKind,
    SourceRecord,
)

#: The manifest version this adapter was written against. A manifest declaring
#: another is refused as a different format, not adapted by guesswork.
FORMAT_VERSION: Final = "1.0"

#: The provider's "no parent" value on a conversation message, exactly as
#: observed: an identifier-shaped string whose digits are all zero apart from a
#: version digit of 4 and a variant digit of 8. Only that value is normalized
#: to none. Any other parent -- a real identifier, a differently-versioned
#: all-zero one, the value with a stray newline -- is kept verbatim, present in
#: the export or not: a shape wider than the observation once swallowed a valid
#: identifier that merely happened to be mostly zeros.
_NO_PARENT_SENTINEL: Final = re.compile(r"0{8}-0{4}-40{3}-80{3}-0{12}")

#: Filesystem residue an archiving tool adds. A name alone does not make a
#: file noise: a file so named is still parsed, and is noise only when its
#: bytes parse to nothing. Content under a residue name is classified by its
#: shape like any other file.
_NOISE_BASENAMES: Final = frozenset({".DS_Store"})
_NOISE_DIRECTORIES: Final = frozenset({"__MACOSX"})
_NOISE_PREFIX: Final = "._"

_ROLES: Final = {
    "human": Role.USER,
    "user": Role.USER,
    "assistant": Role.ASSISTANT,
    "system": Role.SYSTEM,
    "tool": Role.TOOL,
}


class ExportFormatError(Exception):
    """Raised when a directory cannot be read as one export of this format."""


class FileClass(Enum):
    """What one file in an export root is, decided by its parsed shape."""

    #: The manifest: version, categories, export URLs.
    EXPORT_MANIFEST = "export_manifest"
    #: A list of conversations, each holding its messages.
    CONVERSATIONS = "conversations"
    #: One design conversation with its messages.
    DESIGN_CONVERSATION = "design_conversation"
    #: One project with its documents.
    PROJECT = "project"
    #: The memory summary and the memory files.
    MEMORIES = "memories"
    #: Reflections and feedback, together in one file.
    REFLECTIONS = "reflections"
    #: The account record or the login history. Accounted for, never normalized.
    ACCOUNT_METADATA = "account_metadata"
    #: Residue of the archiving tool, not of the provider: a residue-shaped name
    #: whose bytes parse to nothing. A parseable file is never noise.
    FILESYSTEM_NOISE = "filesystem_noise"
    #: A file that fits no known shape. Reported, never silently dropped.
    UNCLASSIFIED = "unclassified"


class NormalizationRefusal(Enum):
    """Why a provider object could not become a record. Counted, never hidden."""

    #: A file no shape matched.
    UNCLASSIFIED_FILE = "unclassified_file"
    #: A list element or field that should have been an object was not.
    NOT_AN_OBJECT = "not_an_object"
    #: The object carries no identity this adapter can use.
    MISSING_IDENTITY = "missing_identity"


@dataclass(frozen=True, slots=True)
class InventoryEntry:
    """One file under the export root, classified, with its bytes accounted for."""

    path: str
    file_class: FileClass
    byte_length: int
    digest: str


@dataclass(frozen=True, slots=True)
class Inventory:
    """Everything an export root holds, and the identity it establishes.

    ``observed_provider_host`` is what the manifest's URLs said; ``export`` is
    the identity this run uses, which names the caller's provider if one was
    given and the observed host otherwise.
    """

    root: Path
    entries: tuple[InventoryEntry, ...]
    export: ExportIdentity
    observed_provider_host: str
    export_id_basis: IdentityBasis
    account: str

    def paths(self, file_class: FileClass) -> tuple[str, ...]:
        return tuple(entry.path for entry in self.entries if entry.file_class is file_class)


@dataclass(frozen=True, slots=True)
class Unnormalized:
    """One thing in the export that produced no record, and why."""

    locator: str
    refusal: NormalizationRefusal


@dataclass(frozen=True, slots=True)
class Normalization:
    """What an export root normalized to: the records, and everything that did not."""

    inventory: Inventory
    records: tuple[SourceRecord, ...]
    rejected: tuple[Unnormalized, ...]


def _is_noise(relative: Path) -> bool:
    if relative.name in _NOISE_BASENAMES or relative.name.startswith(_NOISE_PREFIX):
        return True
    return any(part in _NOISE_DIRECTORIES for part in relative.parts)


def _all_objects_with(value: object, *keys: str) -> bool:
    return (
        type(value) is list
        and bool(value)
        and all(type(item) is dict and all(key in item for key in keys) for item in value)
    )


def _classify(parsed: object) -> FileClass:
    """The shape rules, in one place, applied in one order."""
    if type(parsed) is dict:
        if "data_files" in parsed and "version" in parsed and _all_objects_with(
            parsed["data_files"], "category", "export_url"
        ):
            return FileClass.EXPORT_MANIFEST
        if "uuid" in parsed and "messages" in parsed and "project" in parsed:
            return FileClass.DESIGN_CONVERSATION
        if "uuid" in parsed and "docs" in parsed and "creator" in parsed:
            return FileClass.PROJECT
        if "conversations_memory" in parsed and "memory_files" in parsed:
            return FileClass.MEMORIES
        if "reflections" in parsed and "feedback" in parsed:
            return FileClass.REFLECTIONS
        if "login_events" in parsed:
            return FileClass.ACCOUNT_METADATA
        return FileClass.UNCLASSIFIED
    if type(parsed) is list and parsed:
        objects = [item for item in parsed if type(item) is dict]
        # One malformed element does not unclassify a whole file: the file's
        # class comes from what it evidently is, and each element is then
        # identified, or refused with its locator, during normalization.
        if any("chat_messages" in item for item in objects) and not any(
            "email_address" in item for item in objects
        ):
            return FileClass.CONVERSATIONS
        if objects and all("email_address" in item or "full_name" in item for item in objects):
            return FileClass.ACCOUNT_METADATA
    return FileClass.UNCLASSIFIED


def _reraise(error: OSError) -> None:
    raise error


def _files(root: Path) -> Iterator[Path]:
    """Every regular file under ``root``, sorted, with listing failures raised."""
    found: list[Path] = []
    for directory, _subdirectories, filenames in os.walk(root, onerror=_reraise):
        for filename in filenames:
            path = Path(directory) / filename
            if path.is_file():
                found.append(path)
    return iter(sorted(found))


def _parse(data: bytes) -> object | None:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _export_identity(
    manifest: dict, manifest_digest: str, provider: str | None
) -> tuple[ExportIdentity, str, IdentityBasis]:
    version = manifest["version"]
    if version != FORMAT_VERSION:
        raise ExportFormatError(
            f"manifest declares version {version!r}; this adapter reads {FORMAT_VERSION!r}"
        )
    created_at = manifest.get("created_at")
    if type(created_at) is not str or not created_at:
        raise ExportFormatError("the manifest carries no created_at")
    hosts: set[str] = set()
    export_ids: set[str] = set()
    for entry in manifest["data_files"]:
        parts = urlsplit(entry["export_url"])
        if parts.hostname:
            hosts.add(parts.hostname)
        segments = [segment for segment in parts.path.split("/") if segment]
        if len(segments) >= 2 and segments[0] == "export":
            export_ids.add(segments[1])
    if len(hosts) != 1:
        raise ExportFormatError(
            f"the manifest's export URLs name {len(hosts)} host(s); one provider was expected"
        )
    host = hosts.pop()
    if len(export_ids) == 1:
        export_id, basis = export_ids.pop(), IdentityBasis.PROVIDER_IDENTIFIER
    else:
        # No shared identifier in the URLs: the manifest's own bytes name the export.
        export_id, basis = manifest_digest, IdentityBasis.CONTENT
    return (
        ExportIdentity(
            provider=provider or host,
            export_id=export_id,
            created_at=created_at,
            format_version=version,
        ),
        host,
        basis,
    )


def _objects(value: object) -> list[dict]:
    """The dict elements of a list, and nothing for anything that is not a list.

    Classification tolerates a malformed element so that one bad row does not
    unclassify a file; every later read of the same file has to tolerate it
    too, or the inventory raises where the normalizer would have refused with
    a locator. Measured: a string element in a conversations list, or an
    integer where a list of messages was expected, once escaped as a raw
    ``AttributeError`` from the inventory step.
    """
    if type(value) is not list:
        return []
    return [item for item in value if type(item) is dict]


def _account_ids(file_class: FileClass, parsed: object) -> set[str]:
    """Every account identifier a classified file asserts, so they can be compared."""
    found: set[str] = set()
    if file_class is FileClass.ACCOUNT_METADATA and type(parsed) is list:
        found.update(item["uuid"] for item in _objects(parsed) if type(item.get("uuid")) is str)
    elif file_class is FileClass.ACCOUNT_METADATA and type(parsed) is dict:
        for event in _objects(parsed.get("login_events")):
            if type(event.get("account_uuid")) is str:
                found.add(event["account_uuid"])
    elif file_class is FileClass.CONVERSATIONS:
        for conversation in _objects(parsed):
            account = conversation.get("account")
            if type(account) is dict and type(account.get("uuid")) is str:
                found.add(account["uuid"])
    elif file_class in (FileClass.MEMORIES, FileClass.REFLECTIONS):
        if type(parsed) is dict and type(parsed.get("account_uuid")) is str:
            found.add(parsed["account_uuid"])
    elif file_class is FileClass.PROJECT:
        creator = parsed.get("creator") if type(parsed) is dict else None
        if type(creator) is dict and type(creator.get("uuid")) is str:
            found.add(creator["uuid"])
    elif file_class is FileClass.DESIGN_CONVERSATION:
        for message in _objects(parsed.get("messages") if type(parsed) is dict else None):
            content = message.get("content")
            if type(content) is dict and type(content.get("authorAccountUuid")) is str:
                found.add(content["authorAccountUuid"])
    return found


def inventory(root: Path, *, provider: str | None = None) -> Inventory:
    """Classify every file under ``root`` and establish the export's identity.

    Refuses a root with no manifest, with two, with a manifest of another
    version, or whose files disagree about which account they belong to.
    Nothing is written.
    """
    root = Path(root)
    if not root.is_dir():
        raise ExportFormatError(f"not a directory: {root}")
    if provider is not None and (type(provider) is not str or not provider):
        raise ExportFormatError("provider must be a non-empty string or None")

    entries: list[InventoryEntry] = []
    manifests: list[tuple[dict, str]] = []
    accounts: set[str] = set()
    for path in _files(root):
        relative = path.relative_to(root)
        data = path.read_bytes()
        digest = digest_bytes(data)
        parsed = _parse(data)
        if parsed is None:
            file_class = FileClass.FILESYSTEM_NOISE if _is_noise(relative) else FileClass.UNCLASSIFIED
        else:
            file_class = _classify(parsed)
            if file_class is FileClass.EXPORT_MANIFEST:
                manifests.append((parsed, digest))
            elif file_class is not FileClass.UNCLASSIFIED:
                accounts |= _account_ids(file_class, parsed)
        entries.append(InventoryEntry(relative.as_posix(), file_class, len(data), digest))

    if len(manifests) != 1:
        raise ExportFormatError(
            f"{len(manifests)} manifest(s) found under {root.name!r}; one export has exactly one"
        )
    export, host, basis = _export_identity(manifests[0][0], manifests[0][1], provider)
    if len(accounts) != 1:
        raise ExportFormatError(
            f"the export's files name {len(accounts)} account(s); one was expected"
        )
    return Inventory(
        root=root,
        entries=tuple(entries),
        export=export,
        observed_provider_host=host,
        export_id_basis=basis,
        account=accounts.pop(),
    )


def _text(value: object) -> str | None:
    return value if type(value) is str and value else None


def _attachment_refs(message: dict) -> tuple[dict, ...]:
    """References only; the provider's full attachment objects stay in the payload."""
    refs: list[dict] = []
    for item in message.get("attachments") or ():
        if type(item) is dict:
            refs.append(
                {
                    "name": _text(item.get("file_name")),
                    "reference": None,
                    "media_type": _text(item.get("file_type")),
                    "byte_length": item.get("file_size") if type(item.get("file_size")) is int else None,
                }
            )
    for item in message.get("files") or ():
        if type(item) is dict:
            refs.append(
                {
                    "name": _text(item.get("file_name")),
                    "reference": _text(item.get("file_uuid")),
                    "media_type": None,
                    "byte_length": None,
                }
            )
    return tuple(refs)


def _design_attachment_refs(content: object) -> tuple[dict, ...]:
    refs: list[dict] = []
    if type(content) is dict:
        for item in content.get("attachments") or ():
            if type(item) is dict:
                refs.append(
                    {
                        "name": _text(item.get("name")),
                        "reference": _text(item.get("id")),
                        "media_type": _text(item.get("type")),
                        "byte_length": None,
                    }
                )
    return tuple(refs)


class _Normalizer:
    """Turns one inventory into records, keeping count of what it could not."""

    def __init__(self, inv: Inventory) -> None:
        self._inv = inv
        self.records: list[SourceRecord] = []
        self.rejected: list[Unnormalized] = []

    def _record(self, kind: SourceKind, external_id: str, basis: IdentityBasis, **fields) -> None:
        self.records.append(
            SourceRecord(
                provider=self._inv.export.provider,
                account=self._inv.account,
                kind=kind,
                external_id=external_id,
                identity_basis=basis,
                **fields,
            )
        )

    def _reject(self, locator: str, refusal: NormalizationRefusal) -> None:
        self.rejected.append(Unnormalized(locator, refusal))

    def _identified(self, value: object, locator: str) -> dict | None:
        if type(value) is not dict:
            self._reject(locator, NormalizationRefusal.NOT_AN_OBJECT)
            return None
        if not _text(value.get("uuid")):
            self._reject(locator, NormalizationRefusal.MISSING_IDENTITY)
            return None
        return value

    def conversations(self, path: str, parsed: list) -> None:
        for index, conversation in enumerate(parsed):
            locator = f"{path}#/{index}"
            if self._identified(conversation, locator) is None:
                continue
            messages = conversation.get("chat_messages")
            if type(messages) is not list:
                self._reject(f"{locator}/chat_messages", NormalizationRefusal.NOT_AN_OBJECT)
                continue
            children: list[str] = []
            for position, message in enumerate(messages):
                message_locator = f"{locator}/chat_messages/{position}"
                if self._identified(message, message_locator) is None:
                    continue
                children.append(message["uuid"])
                parent = message.get("parent_message_uuid")
                represented = "parent_message_uuid" in message
                if not represented or (type(parent) is str and _NO_PARENT_SENTINEL.fullmatch(parent)):
                    parent = None
                self._record(
                    SourceKind.MESSAGE,
                    message["uuid"],
                    IdentityBasis.PROVIDER_IDENTIFIER,
                    payload={"record": message},
                    locator=message_locator,
                    container_external_id=conversation["uuid"],
                    parent_external_id=_text(parent),
                    parentage=(
                        Parentage.REPRESENTED
                        if represented
                        else Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT
                    ),
                    role=_ROLES.get(message.get("sender"), Role.UNKNOWN),
                    created_at=_text(message.get("created_at")),
                    updated_at=_text(message.get("updated_at")),
                    attachments=_attachment_refs(message),
                )
            self._record(
                SourceKind.CONVERSATION,
                conversation["uuid"],
                IdentityBasis.PROVIDER_IDENTIFIER,
                payload={
                    "record": {key: value for key, value in conversation.items() if key != "chat_messages"},
                    "children": children,
                },
                locator=locator,
                created_at=_text(conversation.get("created_at")),
                updated_at=_text(conversation.get("updated_at")),
            )

    def design_conversation(self, path: str, parsed: dict) -> None:
        locator = f"{path}#"
        if self._identified(parsed, locator) is None:
            return
        messages = parsed.get("messages")
        if type(messages) is not list:
            self._reject(f"{locator}/messages", NormalizationRefusal.NOT_AN_OBJECT)
            return
        children: list[str] = []
        for position, message in enumerate(messages):
            message_locator = f"{locator}/messages/{position}"
            if self._identified(message, message_locator) is None:
                continue
            children.append(message["uuid"])
            self._record(
                SourceKind.DESIGN_MESSAGE,
                message["uuid"],
                IdentityBasis.PROVIDER_IDENTIFIER,
                payload={"record": message},
                locator=message_locator,
                container_external_id=parsed["uuid"],
                parentage=Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT,
                role=_ROLES.get(message.get("role"), Role.UNKNOWN),
                created_at=_text(message.get("created_at")),
                attachments=_design_attachment_refs(message.get("content")),
            )
        self._record(
            SourceKind.DESIGN_CONVERSATION,
            parsed["uuid"],
            IdentityBasis.PROVIDER_IDENTIFIER,
            payload={
                "record": {key: value for key, value in parsed.items() if key != "messages"},
                "children": children,
            },
            locator=locator,
            created_at=_text(parsed.get("created_at")),
            updated_at=_text(parsed.get("updated_at")),
        )

    def project(self, path: str, parsed: dict) -> None:
        locator = f"{path}#"
        if self._identified(parsed, locator) is None:
            return
        docs = parsed.get("docs")
        if type(docs) is not list:
            self._reject(f"{locator}/docs", NormalizationRefusal.NOT_AN_OBJECT)
            return
        children: list[str] = []
        for position, document in enumerate(docs):
            document_locator = f"{locator}/docs/{position}"
            if self._identified(document, document_locator) is None:
                continue
            children.append(document["uuid"])
            self._record(
                SourceKind.PROJECT_DOCUMENT,
                document["uuid"],
                IdentityBasis.PROVIDER_IDENTIFIER,
                payload={"record": document},
                locator=document_locator,
                container_external_id=parsed["uuid"],
                created_at=_text(document.get("created_at")),
            )
        self._record(
            SourceKind.PROJECT,
            parsed["uuid"],
            IdentityBasis.PROVIDER_IDENTIFIER,
            payload={
                "record": {key: value for key, value in parsed.items() if key != "docs"},
                "children": children,
            },
            locator=locator,
            created_at=_text(parsed.get("created_at")),
            updated_at=_text(parsed.get("updated_at")),
        )

    def memories(self, path: str, parsed: dict) -> None:
        summary = parsed.get("conversations_memory")
        if type(summary) is str:
            self._record(
                SourceKind.MEMORY_SUMMARY,
                self._inv.account,
                IdentityBasis.PROVIDER_IDENTIFIER,
                payload={"record": {"conversations_memory": summary}},
                locator=f"{path}#/conversations_memory",
                content_type="text/plain",
            )
        elif summary is not None:
            self._reject(f"{path}#/conversations_memory", NormalizationRefusal.NOT_AN_OBJECT)
        files = parsed.get("memory_files")
        if type(files) is not list:
            self._reject(f"{path}#/memory_files", NormalizationRefusal.NOT_AN_OBJECT)
            return
        for position, item in enumerate(files):
            locator = f"{path}#/memory_files/{position}"
            if type(item) is not dict:
                self._reject(locator, NormalizationRefusal.NOT_AN_OBJECT)
                continue
            if not _text(item.get("path")):
                self._reject(locator, NormalizationRefusal.MISSING_IDENTITY)
                continue
            self._record(
                SourceKind.MEMORY_FILE,
                item["path"],
                IdentityBasis.PROVIDER_PATH,
                payload={"record": item},
                locator=locator,
                updated_at=_text(item.get("updated_at")),
            )

    def reflections(self, path: str, parsed: dict) -> None:
        items = parsed.get("reflections")
        if type(items) is not list:
            self._reject(f"{path}#/reflections", NormalizationRefusal.NOT_AN_OBJECT)
        else:
            for position, item in enumerate(items):
                locator = f"{path}#/reflections/{position}"
                if type(item) is not dict:
                    self._reject(locator, NormalizationRefusal.NOT_AN_OBJECT)
                    continue
                if not _text(item.get("period")):
                    self._reject(locator, NormalizationRefusal.MISSING_IDENTITY)
                    continue
                self._record(
                    SourceKind.REFLECTION,
                    item["period"],
                    IdentityBasis.PROVIDER_LABEL,
                    payload={"record": item},
                    locator=locator,
                    created_at=_text(item.get("created_at")),
                    updated_at=_text(item.get("updated_at")),
                )
        feedback = parsed.get("feedback")
        if type(feedback) is not list:
            self._reject(f"{path}#/feedback", NormalizationRefusal.NOT_AN_OBJECT)
            return
        for position, item in enumerate(feedback):
            locator = f"{path}#/feedback/{position}"
            if type(item) is not dict:
                self._reject(locator, NormalizationRefusal.NOT_AN_OBJECT)
                continue
            # Unverified shape: no export seen so far carried an item. A provider
            # identifier is used when there is one; otherwise the content names it.
            if _text(item.get("uuid")):
                external_id, basis = item["uuid"], IdentityBasis.PROVIDER_IDENTIFIER
            else:
                external_id, basis = digest_bytes(canonical_bytes(item)), IdentityBasis.CONTENT
            self._record(
                SourceKind.FEEDBACK,
                external_id,
                basis,
                payload={"record": item},
                locator=locator,
                created_at=_text(item.get("created_at")),
                updated_at=_text(item.get("updated_at")),
            )


def normalize(inv: Inventory) -> Normalization:
    """Every record the inventory's files yield, and every refusal, in file order.

    Reads each classified file again from ``inv.root`` and checks that its
    bytes still hash to what the inventory recorded: an export that changed
    between the two reads is refused rather than normalized from a mixture.
    """
    if type(inv) is not Inventory:
        raise ExportFormatError("normalize takes an Inventory")
    normalizer = _Normalizer(inv)
    for entry in inv.entries:
        if entry.file_class is FileClass.UNCLASSIFIED:
            normalizer._reject(entry.path, NormalizationRefusal.UNCLASSIFIED_FILE)
            continue
        if entry.file_class in (
            FileClass.EXPORT_MANIFEST,
            FileClass.ACCOUNT_METADATA,
            FileClass.FILESYSTEM_NOISE,
        ):
            continue
        data = (inv.root / entry.path).read_bytes()
        if digest_bytes(data) != entry.digest:
            raise ExportFormatError(
                f"{entry.path} changed since it was inventoried; the export is not stable"
            )
        parsed = _parse(data)
        if entry.file_class is FileClass.CONVERSATIONS:
            normalizer.conversations(entry.path, parsed)
        elif entry.file_class is FileClass.DESIGN_CONVERSATION:
            normalizer.design_conversation(entry.path, parsed)
        elif entry.file_class is FileClass.PROJECT:
            normalizer.project(entry.path, parsed)
        elif entry.file_class is FileClass.MEMORIES:
            normalizer.memories(entry.path, parsed)
        elif entry.file_class is FileClass.REFLECTIONS:
            normalizer.reflections(entry.path, parsed)
    return Normalization(
        inventory=inv, records=tuple(normalizer.records), rejected=tuple(normalizer.rejected)
    )
