"""Adapter for a manifest-declared bundle of supplied documents and interface captures.

The manifest is the inventory boundary.  It names every supplied file with the
byte count and digest the bundle claims for it; this module compares those
claims with disk before turning text into records.  A capture is recognised by
its object shape, not by a filename.  Its windows are evidence of rendered
content, so their messages are deliberately a distinct source kind rather than
native message records.

Hard-linked bytes are refused because bytes reachable under another name are
not bundle evidence.
"""

from __future__ import annotations

import errno
import json
import os
import stat
from collections import deque
from collections.abc import Iterator
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
    #: A symbolic link appears anywhere under the supplied bundle root.
    SYMLINK_REFUSED = "symlink_refused"
    #: A declared path opened as something other than a regular file.
    NOT_A_REGULAR_FILE = "not_a_regular_file"
    #: A declared file's bytes are reachable under another name.
    HARD_LINK_REFUSED = "hard_link_refused"
    #: A declared file exceeds the adapter's bounded-read limit.
    TOO_LARGE = "too_large"
    #: A declaration omits the non-empty attribution fields a document needs.
    MALFORMED_DECLARATION = "malformed_declaration"
    #: More than one declaration is shaped as a rendered-interface capture.
    MULTIPLE_CAPTURES = "multiple_captures"
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


MAX_FILE_BYTES: Final = 64 * 1024 * 1024
MAX_MANIFEST_BYTES: Final = 1024 * 1024
MAX_BUNDLE_DEPTH: Final = 64


@dataclass(frozen=True, slots=True)
class BundleInventoryEntry:
    """One manifest-declared or found file, with actual and declared bytes kept apart.

    Keeping both values prevents a manifest mismatch from becoming an
    unlabelled replacement for the supplied document.
    """

    path: str
    file_class: BundleFileClass
    present: bool
    is_symlink: bool
    too_large: bool
    byte_length: int | None
    digest: str | None
    declared_byte_length: int | None
    declared_digest: str | None
    declaration: dict[str, object] | None = None
    not_regular: bool = False
    hard_link: bool = False

    @property
    def byte_count_matches(self) -> bool:
        return self.present and self.byte_length == self.declared_byte_length

    @property
    def digest_matches(self) -> bool:
        return self.present and self.digest == (self.declared_digest or "").lower()


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
            if (
                entry.declaration is not None
                and entry.present
                and not entry.is_symlink
                and not entry.not_regular
                and not entry.hard_link
                and not entry.too_large
                and not entry.digest_matches
            )
        )

    @property
    def byte_count_mismatches(self) -> int:
        return sum(
            1
            for entry in self.entries
            if (
                entry.declaration is not None
                and entry.present
                and not entry.is_symlink
                and not entry.not_regular
                and not entry.hard_link
                and not entry.too_large
                and not entry.byte_count_matches
            )
        )


@dataclass(frozen=True, slots=True)
class BundleUnnormalized:
    """One refused location, with all related locations when one id spans windows."""

    locator: str
    refusal: BundleRefusal
    related_locators: tuple[str, ...] = ()


@dataclass(slots=True)
class _NormalizationState:
    """The accounting collected while a normalization result is materialized."""

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
            "symlinks_refused": 0,
            "not_regular_files": 0,
            "hard_links_refused": 0,
            "too_large": 0,
            "malformed_declarations": 0,
            "multiple_captures": 0,
            "not_text": 0,
            "malformed_captures": 0,
            "messages_without_id": 0,
            "unknown_roles": 0,
        }
    )


@dataclass(frozen=True, slots=True)
class BundleNormalization:
    """Materialized records, refusals, and counters for one supplied bundle."""

    inventory: BundleInventory
    records: tuple[SourceRecord, ...]
    _state: _NormalizationState

    @property
    def refusals(self) -> tuple[BundleUnnormalized, ...]:
        return tuple(self._state.refusals)

    @property
    def rejected(self) -> tuple[BundleUnnormalized, ...]:
        """The refused locations, named like the other adapter results."""
        return self.refusals

    @property
    def counters(self) -> dict[str, int]:
        return dict(self._state.counters)

    def _counter(self, name: str) -> int:
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


_LINK_ERRNOS: Final = frozenset((errno.ELOOP, errno.EMLINK))
_NOT_REGULAR_OPEN_ERRNOS: Final = frozenset(
    error
    for error in (errno.ENXIO, errno.EOPNOTSUPP, errno.ENODEV, errno.EISDIR)
    if error is not None
)


def _require_no_follow() -> None:
    """Require the kernel facility that makes each lookup race-safe."""
    if not hasattr(os, "O_NOFOLLOW"):
        raise BundleFormatError("O_NOFOLLOW is required to read supplied bundle files")


def _open_refusal(error: OSError, *, declared: bool) -> BundleRefusal | None:
    """Classify an open failure that is an expected bundle observation."""
    if error.errno in _LINK_ERRNOS:
        return BundleRefusal.SYMLINK_REFUSED
    if error.errno in _NOT_REGULAR_OPEN_ERRNOS:
        return BundleRefusal.NOT_A_REGULAR_FILE
    if error.errno == errno.ENOENT or (declared and error.errno == errno.ENOTDIR):
        return BundleRefusal.MISSING_DECLARED_FILE
    return None


def _not_stable(relative: str) -> None:
    """Refuse a name whose observations cannot describe one bundle state."""
    raise BundleFormatError(f"{relative} changed while it was being read; the bundle is not stable")


def _node_signature(status: os.stat_result) -> tuple[int, int, int]:
    """The identity and type which an lstat/open pair must agree on."""
    return status.st_dev, status.st_ino, stat.S_IFMT(status.st_mode)


def _lstat_component(
    component: str, parent: int, relative: str, *, listed: bool
) -> os.stat_result | None:
    """Observe one name, preserving absence before a lookup as an ordinary refusal."""
    try:
        return os.lstat(component, dir_fd=parent)
    except OSError as error:
        if error.errno == errno.ENOENT:
            if listed:
                _not_stable(relative)
            return None
        raise


def _failed_component_refusal(
    error: OSError, status: os.stat_result, *, declared: bool, relative: str
) -> BundleRefusal | None:
    """Classify a failed directory open only when its post-open type agrees."""
    if stat.S_ISLNK(status.st_mode):
        return BundleRefusal.SYMLINK_REFUSED
    if error.errno in _LINK_ERRNOS:
        _not_stable(relative)
    if declared:
        return BundleRefusal.MISSING_DECLARED_FILE
    return _open_refusal(error, declared=False)


def _failed_final_refusal(
    error: OSError, status: os.stat_result, *, declared: bool, relative: str
) -> BundleRefusal | None:
    """Classify a failed final open only when its post-open type agrees."""
    if stat.S_ISLNK(status.st_mode):
        return BundleRefusal.SYMLINK_REFUSED
    if error.errno in _LINK_ERRNOS:
        _not_stable(relative)
    return _open_refusal(error, declared=declared)


def _checked_open(
    component: str,
    flags: int,
    parent: int,
    relative: str,
    *,
    declared: bool,
    listed: bool,
    directory_component: bool,
) -> tuple[int | None, BundleRefusal | None]:
    """Open one no-follow component and reject a changed classification loudly."""
    before = _lstat_component(component, parent, relative, listed=listed)
    if before is None:
        return None, BundleRefusal.MISSING_DECLARED_FILE
    try:
        descriptor = os.open(component, flags, dir_fd=parent)
    except OSError as error:
        after = _lstat_component(component, parent, relative, listed=False)
        if after is None or _node_signature(before) != _node_signature(after):
            _not_stable(relative)
        if directory_component:
            return None, _failed_component_refusal(
                error, after, declared=declared, relative=relative
            )
        return None, _failed_final_refusal(error, after, declared=declared, relative=relative)
    try:
        opened = os.fstat(descriptor)
    except OSError:
        os.close(descriptor)
        raise
    if _node_signature(before) != _node_signature(opened):
        os.close(descriptor)
        _not_stable(relative)
    return descriptor, None


def _read_open_descriptor(
    descriptor: int, *, maximum_bytes: int
) -> tuple[bytes | None, BundleRefusal | None]:
    """Read a just-opened regular descriptor, bounded even when it grows."""
    try:
        status = os.fstat(descriptor)
        if stat.S_ISLNK(status.st_mode):
            return None, BundleRefusal.SYMLINK_REFUSED
        if not stat.S_ISREG(status.st_mode):
            return None, BundleRefusal.NOT_A_REGULAR_FILE
        if status.st_nlink > 1:
            return None, BundleRefusal.HARD_LINK_REFUSED
        if status.st_size > maximum_bytes:
            return None, BundleRefusal.TOO_LARGE
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(descriptor)
    data = b"".join(chunks)
    if len(data) > maximum_bytes:
        return None, BundleRefusal.TOO_LARGE
    return data, None


def _read_bounded(
    path: Path, *, maximum_bytes: int = MAX_FILE_BYTES
) -> tuple[bytes | None, BundleRefusal | None]:
    """Read one path's final component without following a final-component link.

    This compatibility helper has no declared bundle root. Bundle inventory and
    normalization instead use ``_read_bounded_at``, which resolves every
    component relative to an already-opened root descriptor.
    """
    _require_no_follow()
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        refusal = _open_refusal(error, declared=True)
        if refusal is not None:
            return None, refusal
        raise
    return _read_open_descriptor(descriptor, maximum_bytes=maximum_bytes)


def _open_root(root: Path) -> int:
    """Open a bundle root as a real directory, never through a symbolic link."""
    _require_no_follow()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_NOFOLLOW
    try:
        descriptor = os.open(root, flags)
    except OSError as error:
        if error.errno in (errno.ENOTDIR, errno.ELOOP):
            try:
                status = os.lstat(root)
            except OSError:
                status = None
            if status is not None and stat.S_ISLNK(status.st_mode):
                raise BundleFormatError(
                    f"the bundle root {root!s} was refused: {BundleRefusal.SYMLINK_REFUSED.value}"
                ) from None
        if error.errno == errno.EMLINK:
            raise BundleFormatError(
                f"the bundle root {root!s} was refused: {BundleRefusal.SYMLINK_REFUSED.value}"
            ) from None
        if error.errno in (errno.ENOTDIR, errno.ENOENT):
            raise BundleFormatError(f"not a directory: {root}") from None
        raise
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise BundleFormatError(f"not a directory: {root}")
    return descriptor


def _open_at(
    root_descriptor: int,
    relative: str,
    *,
    declared: bool,
    listed: bool = False,
    final_directory: bool = False,
) -> tuple[int | None, BundleRefusal | None]:
    """Open ``relative`` through one-at-a-time no-follow directory components."""
    _require_no_follow()
    parts = PurePosixPath(relative).parts
    if not parts:
        raise BundleFormatError("a supplied bundle file path must name a file")
    if len(parts) > MAX_BUNDLE_DEPTH:
        return None, BundleRefusal.NOT_A_REGULAR_FILE
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_NOFOLLOW
    parent = root_descriptor
    opened_parent = False
    try:
        prefix: list[str] = []
        for component in parts[:-1]:
            prefix.append(component)
            child, refusal = _checked_open(
                component,
                directory_flags,
                parent,
                "/".join(prefix),
                declared=declared,
                listed=listed,
                directory_component=True,
            )
            if child is None:
                return None, refusal
            if opened_parent:
                os.close(parent)
            parent = child
            opened_parent = True
        flags = directory_flags if final_directory else os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
        descriptor, refusal = _checked_open(
            parts[-1],
            flags,
            parent,
            relative,
            declared=declared,
            listed=listed,
            directory_component=False,
        )
        if descriptor is None:
            return None, refusal
    finally:
        if opened_parent:
            os.close(parent)
    return descriptor, None


def _open_directory_at(
    root_descriptor: int, relative: str, *, listed: bool
) -> tuple[int | None, BundleRefusal | None]:
    """Re-resolve one queued directory from the root before listing it."""
    if not relative:
        return os.dup(root_descriptor), None
    return _open_at(
        root_descriptor,
        relative,
        declared=False,
        listed=listed,
        final_directory=True,
    )


def _read_bounded_at(
    root_descriptor: int,
    relative: str,
    *,
    maximum_bytes: int = MAX_FILE_BYTES,
    declared: bool,
    listed: bool = False,
) -> tuple[bytes | None, BundleRefusal | None]:
    """Read ``relative`` through a no-follow descriptor walk below one root."""
    descriptor, refusal = _open_at(
        root_descriptor, relative, declared=declared, listed=listed
    )
    if descriptor is None:
        return None, refusal
    return _read_open_descriptor(descriptor, maximum_bytes=maximum_bytes)


def _files(root_descriptor: int, implied_directories: set[str]) -> Iterator[str]:
    """Every non-directory entry and undeclared empty directory below a root.

    Each queued directory is re-resolved from the root through no-follow
    components, listed, and closed before the next queue item. A link is
    therefore listed as an entry but never used as a traversal step; ordinary
    non-empty directories are represented by their listed children instead.
    """
    found: list[str] = []
    pending: deque[str] = deque(("",))
    while pending:
        prefix = pending.popleft()
        directory, refusal = _open_directory_at(root_descriptor, prefix, listed=bool(prefix))
        if directory is None:
            _not_stable(prefix)
        try:
            names = sorted(os.listdir(directory))
        finally:
            os.close(directory)
        if not names:
            if prefix and prefix not in implied_directories:
                found.append(prefix)
            continue
        for name in names:
            relative = f"{prefix}/{name}" if prefix else name
            child, refusal = _open_directory_at(root_descriptor, relative, listed=True)
            if child is None:
                found.append(relative)
                continue
            os.close(child)
            pending.append(relative)
    return iter(sorted(found))


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
    if (
        path.is_absolute()
        or value.startswith("/")
        or any(component in {"", ".", ".."} for component in value.split("/"))
    ):
        raise BundleFormatError(f"{name} must stay under the bundle root")
    return value


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


def _has_attribution(declaration: dict[str, object] | None) -> bool:
    """Whether a declaration identifies the supplied material's stated class."""
    return declaration is not None and all(
        type(declaration.get(field)) is str and declaration[field].strip()
        for field in ("source_kind", "sensitivity")
    )


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
    manifest_name = _relative(manifest_name, "manifest_name")
    root_descriptor = _open_root(root)
    try:
        manifest_bytes, manifest_refusal = _read_bounded_at(
            root_descriptor,
            manifest_name,
            maximum_bytes=MAX_MANIFEST_BYTES,
            declared=True,
        )
        if manifest_bytes is None:
            reason = "unreadable" if manifest_refusal is None else manifest_refusal.value
            raise BundleFormatError(f"the bundle manifest {manifest_name!r} was refused: {reason}")
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

        def refused_entry(
            relative: str,
            refusal: BundleRefusal | None,
            *,
            declared_byte_length: int | None,
            declared_digest: str | None,
            declaration: dict[str, object] | None,
        ) -> BundleInventoryEntry:
            return BundleInventoryEntry(
                path=relative,
                file_class=BundleFileClass.UNKNOWN,
                present=refusal is not BundleRefusal.MISSING_DECLARED_FILE,
                is_symlink=refusal is BundleRefusal.SYMLINK_REFUSED,
                too_large=refusal is BundleRefusal.TOO_LARGE,
                byte_length=None,
                digest=None,
                declared_byte_length=declared_byte_length,
                declared_digest=declared_digest,
                declaration=declaration,
                not_regular=refusal is BundleRefusal.NOT_A_REGULAR_FILE,
                hard_link=refusal is BundleRefusal.HARD_LINK_REFUSED,
            )

        entries: list[BundleInventoryEntry] = [
            BundleInventoryEntry(
                path=manifest_name,
                file_class=BundleFileClass.MANIFEST,
                present=True,
                is_symlink=False,
                too_large=False,
                byte_length=len(manifest_bytes),
                digest=digest_bytes(manifest_bytes),
                declared_byte_length=None,
                declared_digest=None,
            )
        ]
        for relative, declaration in declarations.items():
            expected_bytes = declaration["bytes"]
            expected_digest = declaration["sha256"]
            data, refusal = _read_bounded_at(root_descriptor, relative, declared=True)
            if data is None:
                entries.append(
                    refused_entry(
                        relative,
                        refusal,
                        declared_byte_length=expected_bytes,
                        declared_digest=expected_digest,
                        declaration=declaration,
                    )
                )
                continue
            parsed = _parse(data)
            entries.append(
                BundleInventoryEntry(
                    path=relative,
                    file_class=(BundleFileClass.CAPTURE if _capture_candidate(parsed) else BundleFileClass.DOCUMENT),
                    present=True,
                    is_symlink=False,
                    too_large=False,
                    byte_length=len(data),
                    digest=digest_bytes(data),
                    declared_byte_length=expected_bytes,
                    declared_digest=expected_digest,
                    declaration=declaration,
                )
            )

        implied_directories = {
            "/".join(parts[:depth])
            for relative in (*declarations, manifest_name)
            for parts in (PurePosixPath(relative).parts,)
            for depth in range(1, len(parts))
        }
        for relative in _files(root_descriptor, implied_directories):
            if relative == manifest_name or relative in declarations:
                continue
            data, refusal = _read_bounded_at(
                root_descriptor, relative, declared=False, listed=True
            )
            if data is None:
                entries.append(
                    refused_entry(
                        relative,
                        refusal,
                        declared_byte_length=None,
                        declared_digest=None,
                        declaration=None,
                    )
                )
                continue
            entries.append(
                BundleInventoryEntry(
                    path=relative,
                    file_class=BundleFileClass.UNKNOWN,
                    present=True,
                    is_symlink=False,
                    too_large=False,
                    byte_length=len(data),
                    digest=digest_bytes(data),
                    declared_byte_length=None,
                    declared_digest=None,
                )
            )
    finally:
        os.close(root_descriptor)
    return BundleInventory(
        root=root,
        manifest_name=manifest_name,
        manifest_digest=digest_bytes(manifest_bytes),
        entries=tuple(entries),
    )


def _stable_bytes(
    inv: BundleInventory, entry: BundleInventoryEntry
) -> tuple[bytes | None, BundleRefusal | None]:
    """Read one unchanged declared file without following a newly added link.

    One bounded, link-refusing read; a link swapped in after the inventory is
    refused by the open itself, and growth past the bound is refused by the
    read, whatever a stat said a moment earlier.
    """
    root_descriptor = _open_root(inv.root)
    try:
        data, refusal = _read_bounded_at(root_descriptor, entry.path, declared=True)
    finally:
        os.close(root_descriptor)
    if data is None:
        return None, refusal
    if len(data) != entry.byte_length or digest_bytes(data) != entry.digest:
        raise BundleFormatError(f"{entry.path} changed since it was inventoried; the bundle is not stable")
    return data, None


def _resolved_refusal(inv: BundleInventory, entry: BundleInventoryEntry) -> BundleRefusal | None:
    """Re-resolve a declared path at normalization without reading its bytes."""
    root_descriptor = _open_root(inv.root)
    try:
        descriptor, refusal = _open_at(root_descriptor, entry.path, declared=True)
    finally:
        os.close(root_descriptor)
    if descriptor is None:
        return refusal
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode):
            return BundleRefusal.NOT_A_REGULAR_FILE
        if status.st_nlink > 1:
            return BundleRefusal.HARD_LINK_REFUSED
        if status.st_size > MAX_FILE_BYTES:
            return BundleRefusal.TOO_LARGE
    finally:
        os.close(descriptor)
    return None


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
        and ("label" not in button or type(button["label"]) in (str, type(None)))
        and ("disabled" not in button or type(button["disabled"]) in (bool, type(None)))
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
    """Materialize supplied-document, window, and deduplicated capture-message records.

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
    resolved_refusals: dict[str, BundleRefusal | None] = {}

    def reject(locator: str, refusal: BundleRefusal, related: tuple[str, ...] = ()) -> None:
        state.refusals.append(BundleUnnormalized(locator, refusal, related))
        counters = {
            BundleRefusal.DIGEST_MISMATCH: "digest_mismatches",
            BundleRefusal.BYTE_COUNT_MISMATCH: "byte_count_mismatches",
            BundleRefusal.UNDECLARED_FILE: "undeclared_files",
            BundleRefusal.MISSING_DECLARED_FILE: "missing_declared_files",
            BundleRefusal.SYMLINK_REFUSED: "symlinks_refused",
            BundleRefusal.NOT_A_REGULAR_FILE: "not_regular_files",
            BundleRefusal.HARD_LINK_REFUSED: "hard_links_refused",
            BundleRefusal.TOO_LARGE: "too_large",
            BundleRefusal.MALFORMED_DECLARATION: "malformed_declarations",
            BundleRefusal.MULTIPLE_CAPTURES: "multiple_captures",
            BundleRefusal.NOT_TEXT: "not_text",
            BundleRefusal.MALFORMED_CAPTURE: "malformed_captures",
            BundleRefusal.MESSAGE_WITHOUT_ID: "messages_without_id",
            BundleRefusal.UNKNOWN_ROLE: "unknown_roles",
        }
        if refusal in counters:
            state.counters[counters[refusal]] += 1

    def verified(entry: BundleInventoryEntry) -> bytes | None:
        if entry.is_symlink:
            reject(entry.path, BundleRefusal.SYMLINK_REFUSED)
            return None
        if entry.not_regular:
            reject(entry.path, BundleRefusal.NOT_A_REGULAR_FILE)
            return None
        if entry.hard_link:
            reject(entry.path, BundleRefusal.HARD_LINK_REFUSED)
            return None
        if entry.too_large:
            reject(entry.path, BundleRefusal.TOO_LARGE)
            return None
        if not entry.present:
            reject(entry.path, BundleRefusal.MISSING_DECLARED_FILE)
            return None
        if not _has_attribution(entry.declaration):
            reject(entry.path, BundleRefusal.MALFORMED_DECLARATION)
            return None
        if not entry.byte_count_matches:
            reject(entry.path, BundleRefusal.BYTE_COUNT_MISMATCH)
        if not entry.digest_matches:
            reject(entry.path, BundleRefusal.DIGEST_MISMATCH)
        if resolved_refusals[entry.path] is not None:
            return None
        if not entry.byte_count_matches or not entry.digest_matches:
            return None
        data, refusal = _stable_bytes(inv, entry)
        if refusal is not None:
            reject(entry.path, refusal)
            return None
        return data

    def records() -> Iterator[SourceRecord]:
        resolved_refusals.update(
            {
                entry.path: _resolved_refusal(inv, entry)
                for entry in inv.entries
                if entry.declaration is not None
            }
        )
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
            inventory_refusal: BundleRefusal | None = None
            if entry.is_symlink:
                inventory_refusal = BundleRefusal.SYMLINK_REFUSED
            elif entry.not_regular:
                inventory_refusal = BundleRefusal.NOT_A_REGULAR_FILE
            elif entry.hard_link:
                inventory_refusal = BundleRefusal.HARD_LINK_REFUSED
            elif entry.declaration is None:
                inventory_refusal = BundleRefusal.UNDECLARED_FILE
            elif not entry.present:
                inventory_refusal = BundleRefusal.MISSING_DECLARED_FILE
            elif entry.too_large:
                inventory_refusal = BundleRefusal.TOO_LARGE
            if inventory_refusal is not None:
                reject(entry.path, inventory_refusal)
            resolved_refusal = resolved_refusals.get(entry.path)
            if resolved_refusal is not None and resolved_refusal is not inventory_refusal:
                reject(entry.path, resolved_refusal)

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
        if len(captures) > 1:
            related = tuple(entry.path for entry in captures)
            reject(" | ".join(related), BundleRefusal.MULTIPLE_CAPTURES, related)
            return
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
                    rendering: dict[str, object] = {"window_index": window_index}
                    for field in ("html", "links"):
                        if field in payload:
                            rendering[field] = payload[field]
                    previous = seen.get(message_id)
                    if previous is None:
                        seen[message_id] = {
                            "conversation_id": conversation_id,
                            "role": role,
                            "text": text,
                            "payload": payload,
                            "locator": message_locator,
                            "occurrences": [occurrence],
                            "renderings": [rendering],
                            "inconsistent": False,
                        }
                        order.append(message_id)
                        state.counters["occurrences"] += 1
                        continue
                    if previous["text"] != text:
                        related = tuple([previous["locator"], message_locator])
                        reject(" | ".join(related), BundleRefusal.INCONSISTENT_OCCURRENCES, related)
                        if not previous["inconsistent"]:
                            state.counters["inconsistent_ids"] += 1
                            previous["inconsistent"] = True
                        continue
                    previous["occurrences"].append(occurrence)
                    previous["renderings"].append(rendering)
                    state.counters["occurrences"] += 1

        for message_id in order:
            message = seen[message_id]
            if message["inconsistent"]:
                continue
            payload = dict(message["payload"])
            payload["occurrences"] = message["occurrences"]
            payload["renderings"] = message["renderings"]
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

    return BundleNormalization(inventory=inv, records=tuple(records()), _state=state)
