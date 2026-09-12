"""An adapter for one export format: a sharded conversation-mapping export, manifest version 1.

The format, as observed and nothing more: a directory holding one manifest --
``{"version": 1, "manifest_file": …, "export_files": [{"path": …, "size_bytes": …}, …],
"logical_files": {name: {"files": [paths], "sharded": bool, …}, …}}`` -- beside
the files it declares. One logical file is a list of conversations split over
several shard files; each conversation carries a ``mapping`` of nodes, ``{node
id: {"id", "message", "parent", "children"}}``, whose messages hold an author
role, a content object with typed parts, an epoch-seconds creation time and a
metadata object. Beside the conversations sit an index of the provider's file
library, a map from asset file names to the names a person gave them, an
account object, a settings object and a rendered transcript, and every asset
file the indexes point at.

**Classification is by the export's own declarations and shapes, never by a
vendor's name and never by a filename convention.** The manifest declares what
files exist; a declared file whose name the asset map, the asset index or a
message points at is an asset and is not parsed; every other declared file is
classified by the shape of what it parses to; a file on disk the manifest does
not declare, or a declared file missing on disk, is refused and counted. The
provider is named by the caller, because nothing in this format names a host;
the export's identity is the digest of its manifest, visibly a content basis.

**What becomes a record.** One conversation record without its messages (the
ordered node identifiers and each node's parent and children stand in for the
mapping, verbatim), one message record per node that
carries a message, and one asset record per asset file: its provider file
identifier, byte length, digest, detected content type, the name the person
gave it, the mimes the messages declared for it, the provenance the library
index holds for it, and the identifiers of the messages that point at it. The
bytes of an asset are **not** a snapshot: they stay in the immutable archive the
export was read from, and the record's digest is how a later reader finds them.

**What does not.** The account object and the settings object are classified
so that they are accounted for and produce no record; the one thing read from
the account object is its identifier, which scopes every identity here. The
rendered transcript duplicates the conversations and produces no record.

**What the export cannot say is said as such.** A node's parent is a node; the
message record names the parent node's message, or none at the root, as
represented parentage. A node that names a parent the mapping does not hold
keeps that identifier verbatim and is counted. An export that carries only the
current path of each conversation has no node with two children; nothing here
assumes it, and a node with two children yields two records naming one parent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Final, Iterator

from nous_os.identity import digest_bytes
from nous_os.sources import (
    ExportIdentity,
    IdentityBasis,
    Parentage,
    Role,
    SourceKind,
    SourceRecord,
)

#: The manifest version this adapter reads. Any other is refused, never guessed at.
FORMAT_VERSION: Final = 1

_ASSET_SUFFIX: Final = ".dat"
_MANIFEST_KEYS: Final = frozenset({"version", "manifest_file", "export_files", "logical_files"})
_SITE_MANIFEST_KEYS: Final = frozenset({"requested_at", "artifacts", "omissions", "redactions"})


class ExportFormatError(Exception):
    """Raised when a directory cannot be read as one export of this format."""


class MappingFileClass(Enum):
    """What one declared or found file in an export root is."""

    #: The manifest: version, the files it declares, the logical files they compose.
    EXPORT_MANIFEST = "export_manifest"
    #: A companion manifest naming when the export was requested and what was left out.
    SITE_MANIFEST = "site_manifest"
    #: One shard of the conversation list: a JSON array of conversations with mappings.
    CONVERSATION_SHARD = "conversation_shard"
    #: The provider's file-library index: provenance for assets.
    ASSET_INDEX = "asset_index"
    #: The map from asset file names to the names a person gave them.
    ASSET_NAME_MAP = "asset_name_map"
    #: A file the export's own indexes or messages point at. Never parsed.
    ASSET = "asset"
    #: The rendered transcript: a duplicate representation, accounted for, never normalized.
    RENDERED_TRANSCRIPT = "rendered_transcript"
    #: The account object. Accounted for, never normalized; its identifier scopes identities.
    ACCOUNT_METADATA = "account_metadata"
    #: A declared object or list this adapter reads nothing from (settings, empty objects).
    OPAQUE_METADATA = "opaque_metadata"
    #: A file on disk the manifest does not declare. Refused, counted, never read.
    UNDECLARED = "undeclared"
    #: A declared file absent from disk. Refused and counted.
    MISSING = "missing"
    #: A declared file that fits no shape. Refused, never silently dropped.
    UNCLASSIFIED = "unclassified"


class MappingRefusal(Enum):
    """Why a file or a provider object could not become a record. Counted, never hidden."""

    #: A file on disk the manifest does not declare.
    UNDECLARED_FILE = "undeclared_file"
    #: A declared file that is not on disk.
    MISSING_DECLARED_FILE = "missing_declared_file"
    #: A declared file no shape matched.
    UNCLASSIFIED_FILE = "unclassified_file"
    #: A list element or field that should have been an object was not.
    NOT_AN_OBJECT = "not_an_object"
    #: The object carries no identity this adapter can use.
    MISSING_IDENTITY = "missing_identity"
    #: A conversation whose mapping is not an object of node objects.
    MALFORMED_MAPPING = "malformed_mapping"
    #: A message whose author role is a spelling this adapter has never seen.
    UNKNOWN_ROLE = "unknown_role"
    #: A creation time that is not a number.
    MALFORMED_TIME = "malformed_time"


@dataclass(frozen=True, slots=True)
class MappingInventoryEntry:
    """One file under the export root, classified, with its bytes accounted for."""

    path: str
    file_class: MappingFileClass
    byte_length: int
    digest: str


@dataclass(frozen=True, slots=True)
class MappingInventory:
    """Everything an export root holds, and the identity it establishes."""

    root: Path
    entries: tuple[MappingInventoryEntry, ...]
    export: ExportIdentity
    export_id_basis: IdentityBasis
    account: str

    def paths(self, file_class: MappingFileClass) -> tuple[str, ...]:
        return tuple(entry.path for entry in self.entries if entry.file_class is file_class)


@dataclass(frozen=True, slots=True)
class MappingUnnormalized:
    """One thing in the export that produced no record, and why."""

    locator: str
    refusal: MappingRefusal


@dataclass(frozen=True, slots=True)
class MappingNormalization:
    """What an export root normalized to: the records, everything that did not, and the linkage counts.

    ``dangling_asset_references`` counts message references to assets the
    export does not hold; ``dangling_parents`` counts nodes naming a parent the
    mapping does not hold. Both are kept verbatim in the records and counted
    here, never repaired.
    """

    inventory: MappingInventory
    records: tuple[SourceRecord, ...]
    rejected: tuple[MappingUnnormalized, ...]
    dangling_asset_references: int
    dangling_parents: int
    index_entries_without_file: int


def _reraise(error: OSError) -> None:
    raise error


def _files(root: Path) -> Iterator[Path]:
    """Every regular file under ``root``, in a fixed order, without following links."""
    for directory, dirnames, filenames in root.walk(on_error=_reraise, follow_symlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            path = directory / name
            if path.is_symlink():
                continue
            yield path


def _parse(data: bytes) -> object | None:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _looks_like_html(data: bytes) -> bool:
    head = data[:512].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")


def _asset_id(name: str) -> str:
    """The identifier an asset file name carries: the name without the asset suffix."""
    base = name.rsplit("/", 1)[-1]
    return base[: -len(_ASSET_SUFFIX)] if base.endswith(_ASSET_SUFFIX) else base


def _any_object_with(value: object, *keys: str) -> bool:
    """A non-empty list holding at least one object with every one of ``keys``.

    One element is enough to name the list's shape: a shard with one malformed
    element is still a shard, and its malformed elements are refused one by one
    rather than the whole list quietly becoming opaque.
    """
    return type(value) is list and any(
        type(item) is dict and all(key in item for key in keys) for item in value
    )


def _classify_parsed(parsed: object) -> MappingFileClass:
    """What a declared, non-asset file is, by the shape of what it parsed to."""
    if type(parsed) is dict:
        if _MANIFEST_KEYS <= parsed.keys():
            return MappingFileClass.EXPORT_MANIFEST
        if _SITE_MANIFEST_KEYS <= parsed.keys():
            return MappingFileClass.SITE_MANIFEST
        if "id" in parsed and "email" in parsed:
            return MappingFileClass.ACCOUNT_METADATA
        if parsed and all(type(k) is str and type(v) is str for k, v in parsed.items()):
            return MappingFileClass.ASSET_NAME_MAP
        return MappingFileClass.OPAQUE_METADATA
    if type(parsed) is list:
        if _any_object_with(parsed, "mapping"):
            return MappingFileClass.CONVERSATION_SHARD
        if _any_object_with(parsed, "file_id", "mime_type"):
            return MappingFileClass.ASSET_INDEX
        return MappingFileClass.OPAQUE_METADATA
    return MappingFileClass.UNCLASSIFIED


def _manifest_paths(manifest: dict) -> list[str]:
    """Every path the manifest declares, in declaration order, once each."""
    seen: list[str] = []
    for entry in manifest["export_files"]:
        if type(entry) is not dict or type(entry.get("path")) is not str:
            raise ExportFormatError("the manifest's export_files hold an entry without a path")
        if entry["path"] not in seen:
            seen.append(entry["path"])
    return seen


def _instant(value: object) -> str | None:
    """An epoch-seconds number rendered once, as ISO-8601 UTC; None when it is not a number."""
    if type(value) is bool or type(value) not in (int, float):
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="microseconds")


def _role(spelling: object) -> Role:
    try:
        return Role(spelling)
    except ValueError:
        return Role.UNKNOWN


def _references_in(message: dict) -> tuple[dict, ...]:
    """Every asset reference a message makes, as the message made it, in order."""
    refs: list[dict] = []
    content = message.get("content")
    parts = content.get("parts") if type(content) is dict else None
    for part in parts if type(parts) is list else ():
        if type(part) is dict and type(part.get("asset_pointer")) is str:
            scheme, _, identifier = part["asset_pointer"].partition("://")
            refs.append(
                {
                    "asset_id": identifier if identifier else scheme,
                    "scheme": scheme if identifier else None,
                    "part_type": part.get("content_type"),
                }
            )
    metadata = message.get("metadata")
    attachments = metadata.get("attachments") if type(metadata) is dict else None
    for attachment in attachments if type(attachments) is list else ():
        if type(attachment) is dict and type(attachment.get("id")) is str:
            refs.append(
                {
                    "asset_id": attachment["id"],
                    "name": attachment.get("name"),
                    "mime": attachment.get("mime_type"),
                }
            )
    return tuple(refs)


def _detected_type(head: bytes) -> str:
    """A coarse, closed reading of a file's first bytes. Never a claim about meaning."""
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head.startswith(b"%PDF"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04"):
        return "application/zip"
    if head[4:8] == b"ftyp":
        return "video/mp4"
    stripped = head.lstrip()
    if stripped[:1] in (b"{", b"["):
        return "application/json"
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        return "application/octet-stream"
    return "text/plain"


def _peek(path: Path, length: int = 512) -> bytes:
    with path.open("rb") as handle:
        return handle.read(length)


def _pointers_in_shard(parsed: list) -> set[str]:
    """Every asset identifier the messages of a shard point at."""
    ids: set[str] = set()
    for conversation in parsed:
        mapping = conversation.get("mapping") if type(conversation) is dict else None
        for node in mapping.values() if type(mapping) is dict else ():
            message = node.get("message") if type(node) is dict else None
            if type(message) is dict:
                ids.update(ref["asset_id"] for ref in _references_in(message))
    return ids


def inventory(root: Path, *, provider: str) -> MappingInventory:
    """Classify every file under ``root`` and establish the export's identity.

    The manifest is found by shape among the files that parse to an object.
    Every path it declares is looked for on disk; every file on disk is checked
    against the declaration. Assets are recognised by the export's own pointers
    -- the asset name map, the asset index, the messages -- and are hashed,
    never parsed; a parseable file the pointers name is an asset all the same,
    so an uploaded document never becomes a structured file by accident.
    """
    if type(provider) is not str or not provider:
        raise ExportFormatError("this format names no provider; the caller must")
    root = Path(root)
    if not root.is_dir():
        raise ExportFormatError(f"{root} is not a directory")
    on_disk: dict[str, Path] = {str(path.relative_to(root)): path for path in _files(root)}

    manifests: list[tuple[str, dict, bytes]] = []
    for relative, path in on_disk.items():
        if _peek(path, 64).lstrip()[:1] != b"{":
            continue
        data = path.read_bytes()
        parsed = _parse(data)
        if type(parsed) is dict and _MANIFEST_KEYS <= parsed.keys():
            manifests.append((relative, parsed, data))
    if len(manifests) != 1:
        raise ExportFormatError(f"{len(manifests)} manifest(s) found; exactly one is expected")
    manifest_path, manifest, manifest_bytes = manifests[0]
    if manifest["version"] != FORMAT_VERSION:
        raise ExportFormatError(
            f"manifest declares version {manifest['version']!r}; this adapter reads {FORMAT_VERSION!r}"
        )
    declared = _manifest_paths(manifest)
    if manifest_path not in declared:
        declared.insert(0, manifest_path)

    # Tentative classes by shape, and the pointers each structured file carries.
    # Shards are parsed once here and again in normalize(); only their pointer
    # sets are kept, never their bodies.
    tentative: dict[str, MappingFileClass] = {}
    pointers: dict[str, set[str]] = {}
    accounts: dict[str, str] = {}
    site_manifests: dict[str, dict] = {}
    for relative in declared:
        path = on_disk.get(relative)
        if path is None:
            tentative[relative] = MappingFileClass.MISSING
            continue
        head = _peek(path)
        if _looks_like_html(head):
            tentative[relative] = MappingFileClass.RENDERED_TRANSCRIPT
            continue
        if head.lstrip()[:1] not in (b"{", b"["):
            tentative[relative] = MappingFileClass.UNCLASSIFIED
            continue
        parsed = _parse(path.read_bytes())
        if parsed is None:
            tentative[relative] = MappingFileClass.UNCLASSIFIED
            continue
        file_class = _classify_parsed(parsed)
        tentative[relative] = file_class
        if file_class is MappingFileClass.ASSET_NAME_MAP:
            pointers[relative] = {_asset_id(key) for key in parsed}
        elif file_class is MappingFileClass.ASSET_INDEX:
            pointers[relative] = {item["file_id"] for item in parsed if type(item.get("file_id")) is str}
        elif file_class is MappingFileClass.CONVERSATION_SHARD:
            pointers[relative] = _pointers_in_shard(parsed)
        elif file_class is MappingFileClass.ACCOUNT_METADATA:
            if type(parsed.get("id")) is str and parsed["id"]:
                accounts[relative] = parsed["id"]
        elif file_class is MappingFileClass.SITE_MANIFEST:
            site_manifests[relative] = parsed

    # A file the pointers name is an asset whatever it parsed to; pointers are
    # then taken only from files that are not themselves assets.
    asset_ids: set[str] = set().union(*pointers.values()) if pointers else set()
    settled = {relative for relative in declared if _asset_id(relative) in asset_ids}
    asset_ids = set().union(*(ids for relative, ids in pointers.items() if relative not in settled)) if pointers else set()
    asset_ids |= {_asset_id(relative) for relative in settled}

    entries: list[MappingInventoryEntry] = []
    for relative in declared:
        path = on_disk.get(relative)
        if path is None:
            entries.append(MappingInventoryEntry(relative, MappingFileClass.MISSING, 0, ""))
            continue
        data = path.read_bytes()
        file_class = MappingFileClass.ASSET if _asset_id(relative) in asset_ids else tentative[relative]
        entries.append(MappingInventoryEntry(relative, file_class, len(data), digest_bytes(data)))
    declared_set = set(declared)
    for relative, path in on_disk.items():
        if relative not in declared_set:
            entries.append(MappingInventoryEntry(relative, MappingFileClass.UNDECLARED, path.stat().st_size, ""))

    account_ids = {identifier for relative, identifier in accounts.items() if relative not in settled}
    if len(account_ids) != 1:
        raise ExportFormatError(
            f"the export names {len(account_ids)} account identifier(s); exactly one is expected"
        )
    requested = [
        parsed.get("requested_at") for relative, parsed in site_manifests.items() if relative not in settled
    ]
    requested_at = requested[0] if len(requested) == 1 else None
    if type(requested_at) is not str or not requested_at:
        raise ExportFormatError("the export carries no single request time; its identity would be unanchored")
    export = ExportIdentity(
        provider=provider,
        export_id=digest_bytes(manifest_bytes),
        created_at=requested_at,
        format_version=str(FORMAT_VERSION),
    )
    return MappingInventory(
        root=root,
        entries=tuple(entries),
        export=export,
        export_id_basis=IdentityBasis.CONTENT,
        account=account_ids.pop(),
    )


class _Normalizer:
    def __init__(self, inv: MappingInventory) -> None:
        self._inv = inv
        self.records: list[SourceRecord] = []
        self.rejected: list[MappingUnnormalized] = []
        self.dangling_asset_references = 0
        self.dangling_parents = 0
        self.index_entries_without_file = 0
        self._asset_paths: dict[str, str] = {}
        self._asset_names: dict[str, str] = {}
        self._asset_index: dict[str, dict] = {}
        self._asset_mimes: dict[str, list[str]] = {}
        self._asset_referrers: dict[str, list[str]] = {}

    def _reject(self, locator: str, refusal: MappingRefusal) -> None:
        self.rejected.append(MappingUnnormalized(locator, refusal))

    def _record(self, **fields: object) -> None:
        self.records.append(
            SourceRecord(provider=self._inv.export.provider, account=self._inv.account, **fields)
        )

    # -- indexes read before the conversations --------------------------------------------

    def asset_name_map(self, parsed: dict) -> None:
        for key, value in parsed.items():
            self._asset_names[_asset_id(key)] = value

    def asset_index(self, parsed: list) -> None:
        for item in parsed:
            file_id = item.get("file_id")
            if type(file_id) is str and file_id:
                self._asset_index[file_id] = item

    def asset_file(self, path: str) -> None:
        self._asset_paths[_asset_id(path)] = path

    # -- conversations -----------------------------------------------------------------------

    def conversation_shard(self, path: str, parsed: list) -> None:
        for index, conversation in enumerate(parsed):
            locator = f"{path}#/{index}"
            if type(conversation) is not dict:
                self._reject(locator, MappingRefusal.NOT_AN_OBJECT)
                continue
            self._conversation(locator, conversation)

    def _conversation(self, locator: str, conversation: dict) -> None:
        conversation_id = conversation.get("conversation_id") or conversation.get("id")
        if type(conversation_id) is not str or not conversation_id:
            self._reject(locator, MappingRefusal.MISSING_IDENTITY)
            return
        mapping = conversation.get("mapping")
        if type(mapping) is not dict or not all(type(node) is dict for node in mapping.values()):
            self._reject(locator, MappingRefusal.MALFORMED_MAPPING)
            return
        # The conversation's own fields, plus the tree's skeleton verbatim: the node
        # order and each node's parent and children as the export wrote them. The
        # children lists of an export need not agree with its parent pointers; both
        # are kept, and the message records' parentage follows the parent pointers.
        payload = {key: value for key, value in conversation.items() if key != "mapping"}
        payload["node_ids"] = list(mapping.keys())
        payload["nodes"] = {
            node_id: {"parent": node.get("parent"), "children": node.get("children")}
            for node_id, node in mapping.items()
        }
        container = conversation.get("conversation_template_id")
        self._record(
            kind=SourceKind.CONVERSATION,
            external_id=conversation_id,
            identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
            payload=payload,
            locator=locator,
            container_external_id=container if type(container) is str and container else None,
            created_at=_instant(conversation.get("create_time")),
            updated_at=_instant(conversation.get("update_time")),
        )
        for node_id, node in mapping.items():
            self._node(f"{locator}/mapping/{node_id}", conversation_id, mapping, node_id, node)

    def _node(self, locator: str, conversation_id: str, mapping: dict, node_id: str, node: dict) -> None:
        message = node.get("message")
        if message is None:
            return  # a node without a message: the root, or a structural node -- no record
        if type(message) is not dict:
            self._reject(locator, MappingRefusal.NOT_AN_OBJECT)
            return
        message_id = message.get("id")
        if type(message_id) is not str or not message_id:
            self._reject(locator, MappingRefusal.MISSING_IDENTITY)
            return
        author = message.get("author")
        role = _role(author.get("role") if type(author) is dict else None)
        if role is Role.UNKNOWN:
            self._reject(locator, MappingRefusal.UNKNOWN_ROLE)
            return
        created_at = _instant(message.get("create_time"))
        if created_at is None and message.get("create_time") is not None:
            self._reject(locator, MappingRefusal.MALFORMED_TIME)
            return
        parent_id = node.get("parent")
        parent_external_id: str | None = None
        if type(parent_id) is str and parent_id:
            parent_node = mapping.get(parent_id)
            if parent_node is None:
                parent_external_id = parent_id  # verbatim, and counted
                self.dangling_parents += 1
            else:
                parent_message = parent_node.get("message")
                if type(parent_message) is dict and type(parent_message.get("id")) is str:
                    parent_external_id = parent_message["id"]
        references = _references_in(message)
        for ref in references:
            self._asset_referrers.setdefault(ref["asset_id"], []).append(message_id)
            if ref.get("mime"):
                self._asset_mimes.setdefault(ref["asset_id"], []).append(ref["mime"])
        self._record(
            kind=SourceKind.MESSAGE,
            external_id=message_id,
            identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
            payload=message,
            locator=locator,
            container_external_id=conversation_id,
            parent_external_id=parent_external_id,
            parentage=Parentage.REPRESENTED,
            role=role,
            created_at=created_at,
            attachments=references,
        )

    # -- assets, after every conversation has been read ---------------------------------------

    def assets(self) -> None:
        referenced = set(self._asset_referrers) | set(self._asset_index) | set(self._asset_names)
        for asset_id in sorted(referenced):
            path = self._asset_paths.get(asset_id)
            if path is None:
                self.dangling_asset_references += len(self._asset_referrers.get(asset_id, ()))
                if asset_id in self._asset_index:
                    self.index_entries_without_file += 1
                continue
            data = (self._inv.root / path).read_bytes()
            index = self._asset_index.get(asset_id, {})
            provenance = {
                key: index[key]
                for key in (
                    "file_name",
                    "mime_type",
                    "file_size_bytes",
                    "library_artifact_type",
                    "library_file_category",
                    "origination_message_id",
                    "origination_thread_id",
                    "image_gen_generation_id",
                    "created_at",
                    "file_upload_time",
                    "is_project",
                )
                if key in index
            }
            self._record(
                kind=SourceKind.ASSET,
                external_id=asset_id,
                identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
                payload={
                    "file_id": asset_id,
                    "byte_length": len(data),
                    "digest": digest_bytes(data),
                    "detected_type": _detected_type(data[:512]),
                    "given_name": self._asset_names.get(asset_id),
                    "declared_mimes": sorted(set(self._asset_mimes.get(asset_id, ()))),
                    "index": provenance,
                    "referenced_by": sorted(set(self._asset_referrers.get(asset_id, ()))),
                },
                locator=path,
                content_type="application/json",
            )


def normalize(inv: MappingInventory) -> MappingNormalization:
    """Every record the inventory's files yield, and every refusal, in a fixed order.

    Reads each classified file again from ``inv.root`` and checks that its bytes
    still hash to what the inventory recorded. Indexes are read first, then the
    conversation shards in path order, then the assets in identifier order.
    """
    if type(inv) is not MappingInventory:
        raise ExportFormatError("normalize takes an MappingInventory")
    normalizer = _Normalizer(inv)

    def stable_bytes(entry: MappingInventoryEntry) -> bytes:
        data = (inv.root / entry.path).read_bytes()
        if digest_bytes(data) != entry.digest:
            raise ExportFormatError(
                f"{entry.path} changed since it was inventoried; the export is not stable"
            )
        return data

    for entry in inv.entries:
        if entry.file_class is MappingFileClass.UNDECLARED:
            normalizer._reject(entry.path, MappingRefusal.UNDECLARED_FILE)
        elif entry.file_class is MappingFileClass.MISSING:
            normalizer._reject(entry.path, MappingRefusal.MISSING_DECLARED_FILE)
        elif entry.file_class is MappingFileClass.UNCLASSIFIED:
            normalizer._reject(entry.path, MappingRefusal.UNCLASSIFIED_FILE)
        elif entry.file_class is MappingFileClass.ASSET_NAME_MAP:
            normalizer.asset_name_map(_parse(stable_bytes(entry)))
        elif entry.file_class is MappingFileClass.ASSET_INDEX:
            normalizer.asset_index(_parse(stable_bytes(entry)))
        elif entry.file_class is MappingFileClass.ASSET:
            normalizer.asset_file(entry.path)
    for entry in inv.entries:
        if entry.file_class is MappingFileClass.CONVERSATION_SHARD:
            normalizer.conversation_shard(entry.path, _parse(stable_bytes(entry)))
    normalizer.assets()
    return MappingNormalization(
        inventory=inv,
        records=tuple(normalizer.records),
        rejected=tuple(normalizer.rejected),
        dangling_asset_references=normalizer.dangling_asset_references,
        dangling_parents=normalizer.dangling_parents,
        index_entries_without_file=normalizer.index_entries_without_file,
    )

