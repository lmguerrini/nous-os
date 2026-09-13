"""Adapter for a manifest-declared bundle of supplied documents and interface captures.

The manifest is the inventory boundary.  It names every supplied file with the
byte count and digest the bundle claims for it; this module compares those
claims with disk before turning text into records.  A capture is recognised by
its object shape, not by a filename.  Its windows are evidence of rendered
content, so their messages are deliberately a distinct source kind rather than
native message records.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Final

from nous_os.identity import canonical_bytes, digest_bytes
from nous_os.sources import IdentityBasis, Parentage, Role, SourceKind, SourceRecord


class BundleFormatError(Exception):
    """Raised when a root cannot be read as a manifest-declared bundle."""


class BundleFileClass(Enum):
    """What one file in a supplied bundle is, decided by manifest and shape."""

    #: The manifest that declares the bundle's files and their expected bytes.
    MANIFEST = "manifest"
    #: A text JSON object shaped as a rendered-interface capture.
    CAPTURE = "capture"
    #: A manifest-declared supplied text document that is not a capture.
    DOCUMENT = "document"
    #: A file outside the declaration, or one whose declaration cannot name a file.
    UNKNOWN = "unknown"


class BundleRefusal(Enum):
    """Why a supplied file or captured object could not become a record."""

    #: A file's actual digest differs from the digest its manifest declares.
    DIGEST_MISMATCH = "digest_mismatch"
    #: A file's actual byte count differs from the count its manifest declares.
    BYTE_COUNT_MISMATCH = "byte_count_mismatch"
    #: A file exists under the bundle root but the manifest does not declare it.
    UNDECLARED_FILE = "undeclared_file"
    #: The manifest declares a file that is not present below the bundle root.
    MISSING_DECLARED_FILE = "missing_declared_file"
    #: A file offered as supplied text is not valid UTF-8.
    NOT_TEXT = "not_text"
    #: A capture-shaped object lacks the fields needed to preserve its evidence.
    MALFORMED_CAPTURE = "malformed_capture"
    #: A captured message has no provider message identifier to retain.
    MESSAGE_WITHOUT_ID = "message_without_id"
    #: One provider message identifier carries different rendered text in two windows.
    INCONSISTENT_OCCURRENCES = "inconsistent_occurrences"
    #: A captured message role is outside the closed normalized role vocabulary.
    UNKNOWN_ROLE = "unknown_role"


_ROLES: Final = {
    "user": Role.USER,
    "assistant": Role.ASSISTANT,
    "system": Role.SYSTEM,
    "tool": Role.TOOL,
}


@dataclass(frozen=True, slots=True)
class BundleInventoryEntry:
    """One manifest-declared or found file, with actual and declared bytes kept apart.

    Keeping both values prevents a manifest mismatch from becoming an
    unlabelled replacement for the supplied document.
    """

    path: str
    file_class: BundleFileClass
    present: bool
    byte_length: int | None
    digest: str | None
    declared_byte_length: int | None
    declared_digest: str | None
    declaration: dict[str, object] | None = None

    @property
    def byte_count_matches(self) -> bool:
        return self.present and self.byte_length == self.declared_byte_length

    @property
    def digest_matches(self) -> bool:
        return self.present and self.digest == self.declared_digest


@dataclass(frozen=True, slots=True)
class BundleInventory:
    """Every file in a bundle root, its manifest digest, and its declared status."""

    root: Path
    manifest_name: str
    manifest_digest: str
    entries: tuple[BundleInventoryEntry, ...]

    def paths(self, file_class: BundleFileClass) -> tuple[str, ...]:
        """The paths assigned one class, in inventory order."""
        return tuple(entry.path for entry in self.entries if entry.file_class is file_class)

    @property
    def undeclared_files(self) -> int:
        return sum(1 for entry in self.entries if not entry.declaration and entry.path != self.manifest_name)

    @property
    def missing_declared_files(self) -> int:
        return sum(1 for entry in self.entries if entry.declaration is not None and not entry.present)

    @property
    def digest_mismatches(self) -> int:
        return sum(
            1
            for entry in self.entries
            if entry.declaration is not None and entry.present and not entry.digest_matches
        )

    @property
    def byte_count_mismatches(self) -> int:
        return sum(
            1
            for entry in self.entries
            if entry.declaration is not None and entry.present and not entry.byte_count_matches
        )


@dataclass(frozen=True, slots=True)
class BundleUnnormalized:
    """One refused location, with all related locations when one id spans windows."""

    locator: str
    refusal: BundleRefusal
    related_locators: tuple[str, ...] = ()


@dataclass(slots=True)
class _NormalizationState:
    """The mutable accounting behind a lazily yielded normalization result."""

    refusals: list[BundleUnnormalized] = field(default_factory=list)
    counters: dict[str, int] = field(
        default_factory=lambda: {
            "documents": 0,
            "windows": 0,
            "captured_messages": 0,
            "occurrences": 0,
            "empty_text_messages": 0,
            "inconsistent_ids": 0,
            "digest_mismatches": 0,
            "byte_count_mismatches": 0,
            "undeclared_files": 0,
            "missing_declared_files": 0,
            "not_text": 0,
            "malformed_captures": 0,
            "messages_without_id": 0,
            "unknown_roles": 0,
        }
    )


class _LazyRecords(Iterable[SourceRecord]):
    """Replay records while delaying body reads until a caller asks for them.

    A replay cache prevents a second inspection from rereading a mutable root
    and silently producing a different normalization.
    """

    def __init__(self, iterator: Iterator[SourceRecord]) -> None:
        self._iterator = iterator
        self._cache: list[SourceRecord] = []
        self._complete = False

    def __iter__(self) -> Iterator[SourceRecord]:
        yield from self._cache
        if self._complete:
            return
        for record in self._iterator:
            self._cache.append(record)
            yield record
        self._complete = True

    def __len__(self) -> int:
        self.exhaust()
        return len(self._cache)

    def exhaust(self) -> tuple[SourceRecord, ...]:
        """Read the remainder once before exposing final refusals or counters."""
        tuple(self)
        return tuple(self._cache)


@dataclass(frozen=True, slots=True)
class BundleNormalization:
    """Lazily yielded records, refusals, and counters for one supplied bundle."""

    inventory: BundleInventory
    records: _LazyRecords
    _state: _NormalizationState

    @property
    def refusals(self) -> tuple[BundleUnnormalized, ...]:
        self.records.exhaust()
        return tuple(self._state.refusals)

    @property
    def rejected(self) -> tuple[BundleUnnormalized, ...]:
        """The refused locations, named like the other adapter results."""
        return self.refusals

    @property
    def counters(self) -> dict[str, int]:
        self.records.exhaust()
        return dict(self._state.counters)

    def _counter(self, name: str) -> int:
        self.records.exhaust()
        return self._state.counters[name]

    @property
    def documents(self) -> int:
        return self._counter("documents")

    @property
    def windows(self) -> int:
        return self._counter("windows")

    @property
    def captured_messages(self) -> int:
        return self._counter("captured_messages")

    @property
    def occurrences(self) -> int:
        return self._counter("occurrences")

    @property
    def empty_text_messages(self) -> int:
        return self._counter("empty_text_messages")

    @property
    def inconsistent_ids(self) -> int:
        return self._counter("inconsistent_ids")


def _reraise(error: OSError) -> None:
    raise error


def _files(root: Path) -> Iterator[Path]:
    """Every regular, non-symlinked file below ``root`` in a fixed order."""
    found: list[Path] = []
    for directory, dirnames, filenames in os.walk(root, onerror=_reraise, followlinks=False):
        dirnames.sort()
        for filename in sorted(filenames):
            candidate = Path(directory) / filename
            if not candidate.is_symlink() and candidate.is_file():
                found.append(candidate)
    return iter(found)


def _parse(data: bytes) -> object | None:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _relative(value: object, name: str) -> str:
    """Accept only a non-empty bundle-relative path, preventing root escape."""
    if type(value) is not str or not value:
        raise BundleFormatError(f"{name} must be a non-empty relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or value.startswith("/"):
        raise BundleFormatError(f"{name} must stay under the bundle root")
    return path.as_posix()


def _declared_file(entry: object, index: int) -> tuple[str, dict[str, object]]:
    """Read one declaration wholly, so an incomplete manifest cannot imply bytes."""
    if type(entry) is not dict:
        raise BundleFormatError(f"files[{index}] must be an object")
    path = _relative(entry.get("path"), f"files[{index}].path")
    byte_count = entry.get("bytes")
    if type(byte_count) is not int or type(byte_count) is bool or byte_count < 0:
        raise BundleFormatError(f"files[{index}].bytes must be a non-negative integer")
    digest = entry.get("sha256")
    if type(digest) is not str or len(digest) != 64:
        raise BundleFormatError(f"files[{index}].sha256 must be a sha256 hex string")
    try:
        int(digest, 16)
    except ValueError as error:
        raise BundleFormatError(f"files[{index}].sha256 must be a sha256 hex string") from error
    return path, dict(entry)


def _capture_candidate(value: object) -> bool:
    """Recognise the three header fields so a missing branches field is refused as capture.

    Treating that near shape as an ordinary document would hide a malformed
    capture behind a valid text-file record.
    """
    return type(value) is dict and {"conversation_id", "captured_at", "url"} <= value.keys()


def _content_type(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in {".md", ".markdown"}:
        return "text/markdown"
    if suffix == ".json":
        return "application/json"
    return "text/plain"


def inventory(root: Path, *, manifest_name: str = "INPUT_MANIFEST.json") -> BundleInventory:
    """Read one manifest and compare every declared file's bytes with disk.

    The manifest is named by the caller because an uploaded document can look
    like JSON too; guessing a manifest by filename or content would admit a
    document as bundle control data.
    """
    root = Path(root)
    if not root.is_dir():
        raise BundleFormatError(f"not a directory: {root}")
    manifest_name = _relative(manifest_name, "manifest_name")
    manifest_path = root / manifest_name
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise BundleFormatError(f"the bundle manifest is not a regular file: {manifest_name}")
    manifest_bytes = manifest_path.read_bytes()
    manifest = _parse(manifest_bytes)
    if type(manifest) is not dict or type(manifest.get("files")) is not list:
        raise BundleFormatError("the bundle manifest must be an object with a files list")

    declarations: dict[str, dict[str, object]] = {}
    for index, value in enumerate(manifest["files"]):
        relative, declaration = _declared_file(value, index)
        if relative == manifest_name:
            raise BundleFormatError("the bundle manifest cannot declare its own changing bytes")
        if relative in declarations:
            raise BundleFormatError(f"the manifest declares {relative!r} more than once")
        declarations[relative] = declaration

    on_disk = {candidate.relative_to(root).as_posix(): candidate for candidate in _files(root)}
    entries: list[BundleInventoryEntry] = [
        BundleInventoryEntry(
            path=manifest_name,
            file_class=BundleFileClass.MANIFEST,
            present=True,
            byte_length=len(manifest_bytes),
            digest=digest_bytes(manifest_bytes),
            declared_byte_length=None,
            declared_digest=None,
        )
    ]
    for relative, declaration in declarations.items():
        path = on_disk.get(relative)
        expected_bytes = declaration["bytes"]
        expected_digest = declaration["sha256"]
        if path is None:
            entries.append(
                BundleInventoryEntry(
                    path=relative,
                    file_class=BundleFileClass.UNKNOWN,
                    present=False,
                    byte_length=None,
                    digest=None,
                    declared_byte_length=expected_bytes,
                    declared_digest=expected_digest,
                    declaration=declaration,
                )
            )
            continue
        data = path.read_bytes()
        parsed = _parse(data)
        entries.append(
            BundleInventoryEntry(
                path=relative,
                file_class=(BundleFileClass.CAPTURE if _capture_candidate(parsed) else BundleFileClass.DOCUMENT),
                present=True,
                byte_length=len(data),
                digest=digest_bytes(data),
                declared_byte_length=expected_bytes,
                declared_digest=expected_digest,
                declaration=declaration,
            )
        )
    for relative, path in on_disk.items():
        if relative == manifest_name or relative in declarations:
            continue
        entries.append(
            BundleInventoryEntry(
                path=relative,
                file_class=BundleFileClass.UNKNOWN,
                present=True,
                byte_length=path.stat().st_size,
                digest=digest_bytes(path.read_bytes()),
                declared_byte_length=None,
                declared_digest=None,
            )
        )
    return BundleInventory(
        root=root,
        manifest_name=manifest_name,
        manifest_digest=digest_bytes(manifest_bytes),
        entries=tuple(entries),
    )


def _stable_bytes(inv: BundleInventory, entry: BundleInventoryEntry) -> bytes:
    """Read an inventory entry again, refusing a root that changed mid-normalization."""
    data = (inv.root / entry.path).read_bytes()
    if len(data) != entry.byte_length or digest_bytes(data) != entry.digest:
        raise BundleFormatError(f"{entry.path} changed since it was inventoried; the bundle is not stable")
    return data


def _json_is_canonical(value: object) -> bool:
    try:
        canonical_bytes(value)
    except (TypeError, ValueError):
        return False
    return True


def _capture_headers(capture: object) -> tuple[str, str, str, list] | None:
    if type(capture) is not dict:
        return None
    conversation_id = capture.get("conversation_id")
    captured_at = capture.get("captured_at")
    url = capture.get("url")
    branches = capture.get("branches")
    if (
        type(conversation_id) is not str
        or not conversation_id
        or type(captured_at) is not str
        or not captured_at
        or type(url) is not str
        or not url
        or type(branches) is not list
    ):
        return None
    return conversation_id, captured_at, url, branches


def _window_parts(value: object) -> tuple[str, str, list, list, str] | None:
    if type(value) is not dict:
        return None
    captured_at = value.get("captured_at")
    url = value.get("url")
    buttons = value.get("buttons")
    messages = value.get("messages")
    text = value.get("text")
    if (
        type(captured_at) is not str
        or not captured_at
        or type(url) is not str
        or not url
        or type(buttons) is not list
        or type(messages) is not list
        or type(text) is not str
        or not _json_is_canonical(buttons)
    ):
        return None
    if not all(
        type(button) is dict
        and type(button.get("label")) is str
        and type(button.get("disabled")) is bool
        for button in buttons
    ):
        return None
    return captured_at, url, buttons, messages, text


def _message_parts(value: object) -> tuple[str, Role, str, str, dict[str, object]] | None:
    if type(value) is not dict:
        return None
    message_id = value.get("id")
    if type(message_id) is not str or not message_id:
        return None
    role = _ROLES.get(value.get("role"))
    if role is None:
        return message_id, Role.UNKNOWN, "", "", {}
    text = value.get("text")
    text_content = value.get("text_content")
    if type(text) is not str or type(text_content) is not str:
        return message_id, role, "", "", {}
    payload: dict[str, object] = {"text": text, "text_content": text_content}
    for optional in ("html", "links"):
        if optional in value:
            payload[optional] = value[optional]
    if not _json_is_canonical(payload):
        return message_id, role, "", "", {}
    return message_id, role, text, text_content, payload


def normalize(
    inv: BundleInventory,
    *,
    provider: str,
    account: str,
    account_basis: str,
    document_provider: str | None = None,
    document_account: str | None = None,
) -> BundleNormalization:
    """Yield supplied-document, window, and deduplicated capture-message records lazily.

    The explicit account and basis prevent a rendered page from inventing an
    account identifier it does not contain.  Documents sort by path, windows
    retain their index, and messages retain their first rendered occurrence.

    A supplied document is attributed to whoever supplied it, which need not
    be the provider whose interface the capture renders: ``document_provider``
    and ``document_account`` name that party, defaulting to the capture's when
    the caller states nothing.  Without the distinction a report pasted by a
    person would be recorded as if the captured provider had exported it.
    """
    if type(inv) is not BundleInventory:
        raise BundleFormatError("normalize takes a BundleInventory")
    if type(provider) is not str or not provider:
        raise BundleFormatError("provider must be a non-empty string")
    if type(account) is not str or not account:
        raise BundleFormatError("account must be a non-empty string")
    if type(account_basis) is not str or not account_basis:
        raise BundleFormatError("account_basis must be a non-empty string")
    if document_provider is None:
        document_provider = provider
    if document_account is None:
        document_account = account
    if type(document_provider) is not str or not document_provider:
        raise BundleFormatError("document_provider must be a non-empty string")
    if type(document_account) is not str or not document_account:
        raise BundleFormatError("document_account must be a non-empty string")

    state = _NormalizationState()

    def reject(locator: str, refusal: BundleRefusal, related: tuple[str, ...] = ()) -> None:
        state.refusals.append(BundleUnnormalized(locator, refusal, related))
        counters = {
            BundleRefusal.DIGEST_MISMATCH: "digest_mismatches",
            BundleRefusal.BYTE_COUNT_MISMATCH: "byte_count_mismatches",
            BundleRefusal.UNDECLARED_FILE: "undeclared_files",
            BundleRefusal.MISSING_DECLARED_FILE: "missing_declared_files",
            BundleRefusal.NOT_TEXT: "not_text",
            BundleRefusal.MALFORMED_CAPTURE: "malformed_captures",
            BundleRefusal.MESSAGE_WITHOUT_ID: "messages_without_id",
            BundleRefusal.UNKNOWN_ROLE: "unknown_roles",
        }
        if refusal in counters:
            state.counters[counters[refusal]] += 1

    def verified(entry: BundleInventoryEntry) -> bytes | None:
        if not entry.present:
            reject(entry.path, BundleRefusal.MISSING_DECLARED_FILE)
            return None
        if not entry.byte_count_matches:
            reject(entry.path, BundleRefusal.BYTE_COUNT_MISMATCH)
        if not entry.digest_matches:
            reject(entry.path, BundleRefusal.DIGEST_MISMATCH)
        if not entry.byte_count_matches or not entry.digest_matches:
            return None
        return _stable_bytes(inv, entry)

    def records() -> Iterator[SourceRecord]:
        documents = sorted(
            (entry for entry in inv.entries if entry.file_class is BundleFileClass.DOCUMENT),
            key=lambda entry: entry.path,
        )
        captures = sorted(
            (entry for entry in inv.entries if entry.file_class is BundleFileClass.CAPTURE),
            key=lambda entry: entry.path,
        )
        for entry in inv.entries:
            if entry.path == inv.manifest_name:
                continue
            if entry.declaration is None:
                reject(entry.path, BundleRefusal.UNDECLARED_FILE)
            elif not entry.present:
                reject(entry.path, BundleRefusal.MISSING_DECLARED_FILE)

        for entry in documents:
            data = verified(entry)
            if data is None:
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                reject(entry.path, BundleRefusal.NOT_TEXT)
                continue
            declaration = entry.declaration or {}
            payload = {
                key: value
                for key, value in declaration.items()
                if key not in {"path", "bytes", "sha256", "text"}
            }
            payload["text"] = text
            payload["sha256"] = declaration["sha256"]
            yield SourceRecord(
                provider=document_provider,
                account=document_account,
                kind=SourceKind.DOCUMENT,
                external_id=entry.path,
                identity_basis=IdentityBasis.PROVIDER_PATH,
                payload=payload,
                locator=entry.path,
                content_type=_content_type(entry.path),
            )
            state.counters["documents"] += 1

        seen: dict[str, dict[str, object]] = {}
        order: list[str] = []
        for entry in captures:
            data = verified(entry)
            if data is None:
                continue
            capture = _parse(data)
            headers = _capture_headers(capture)
            if headers is None:
                reject(entry.path, BundleRefusal.MALFORMED_CAPTURE)
                continue
            conversation_id, _capture_time, _capture_url, branches = headers
            for window_index, window in enumerate(branches):
                window_locator = f"{entry.path}#/branches/{window_index}"
                parts = _window_parts(window)
                if parts is None:
                    reject(window_locator, BundleRefusal.MALFORMED_CAPTURE)
                    continue
                captured_at, url, buttons, messages, window_text = parts
                message_ids = [
                    message["id"]
                    for message in messages
                    if type(message) is dict and type(message.get("id")) is str and message["id"]
                ]
                yield SourceRecord(
                    provider=provider,
                    account=account,
                    kind=SourceKind.CAPTURE_WINDOW,
                    external_id=f"{conversation_id}#{window_index}",
                    identity_basis=IdentityBasis.PROVIDER_LABEL,
                    payload={
                        "url": url,
                        "captured_at": captured_at,
                        "buttons": buttons,
                        "message_ids": message_ids,
                        "text_digest": digest_bytes(window_text.encode("utf-8")),
                        "account_basis": account_basis,
                    },
                    locator=window_locator,
                    container_external_id=conversation_id,
                )
                state.counters["windows"] += 1
                seen_in_window: set[str] = set()
                for position, message in enumerate(messages):
                    message_locator = f"{window_locator}/messages/{position}"
                    if type(message) is not dict:
                        reject(message_locator, BundleRefusal.MALFORMED_CAPTURE)
                        continue
                    raw_id = message.get("id")
                    if type(raw_id) is not str or not raw_id:
                        reject(message_locator, BundleRefusal.MESSAGE_WITHOUT_ID)
                        continue
                    parsed = _message_parts(message)
                    if parsed is None:
                        reject(message_locator, BundleRefusal.MALFORMED_CAPTURE)
                        continue
                    message_id, role, text, _text_content, payload = parsed
                    if role is Role.UNKNOWN:
                        reject(message_locator, BundleRefusal.UNKNOWN_ROLE)
                        continue
                    if not payload:
                        reject(message_locator, BundleRefusal.MALFORMED_CAPTURE)
                        continue
                    occurrence = {
                        "window_index": window_index,
                        "position": position,
                        "captured_at": captured_at,
                    }
                    previous = seen.get(message_id)
                    if previous is None:
                        seen[message_id] = {
                            "conversation_id": conversation_id,
                            "role": role,
                            "text": text,
                            "payload": payload,
                            "locator": message_locator,
                            "occurrences": [occurrence],
                            "window_indices": {window_index},
                            "inconsistent": False,
                        }
                        order.append(message_id)
                        state.counters["occurrences"] += 1
                        seen_in_window.add(message_id)
                        continue
                    if previous["text"] != text:
                        related = tuple([previous["locator"], message_locator])
                        reject(" | ".join(related), BundleRefusal.INCONSISTENT_OCCURRENCES, related)
                        if not previous["inconsistent"]:
                            state.counters["inconsistent_ids"] += 1
                            previous["inconsistent"] = True
                        continue
                    if window_index not in previous["window_indices"]:
                        previous["occurrences"].append(occurrence)
                        previous["window_indices"].add(window_index)
                        state.counters["occurrences"] += 1
                    seen_in_window.add(message_id)

        for message_id in order:
            message = seen[message_id]
            if message["inconsistent"]:
                continue
            payload = dict(message["payload"])
            payload["occurrences"] = message["occurrences"]
            payload["account_basis"] = account_basis
            yield SourceRecord(
                provider=provider,
                account=account,
                kind=SourceKind.CAPTURED_MESSAGE,
                external_id=message_id,
                identity_basis=IdentityBasis.PROVIDER_IDENTIFIER,
                payload=payload,
                locator=message["locator"],
                container_external_id=message["conversation_id"],
                parentage=Parentage.UNSUPPORTED_BY_PROVIDER_EXPORT,
                role=message["role"],
                created_at=None,
            )
            state.counters["captured_messages"] += 1
            if message["text"] == "":
                state.counters["empty_text_messages"] += 1

    return BundleNormalization(inventory=inv, records=_LazyRecords(records()), _state=state)
