"""Read attachment bytes into separately attributed extraction evidence.

This module reads only.  It never executes document content, never extracts an
archive to disk, and never treats a supplied name as evidence of a format.
The two closed vocabularies below keep an empty extraction, an unsupported
format, and a failed parser visibly distinct.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import threading
import zipfile
import zlib
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree
from xml.parsers import expat

from nous_os.identity import SOURCE_PREFIX, canonical_bytes, digest_bytes, file_is_present, require_id


#: The bounded archive member count, checked from the central directory before
#: this module reads a member or parses an office XML part.
MAX_ARCHIVE_MEMBERS = 200
#: The maximum declared uncompressed bytes for every archive and office package.
MAX_ARCHIVE_TEXT_BYTES = 20 * 1024 * 1024
#: The maximum UTF-8 text evidence retained from one direct text source or tool.
MAX_EXTRACTED_TEXT_BYTES = 32 * 1024 * 1024
#: Version recorded for extraction paths implemented only with the standard library.
EXTRACTION_VERSION = "1"
#: The PDF text tool is found on the caller's PATH, never at a machine path:
#: where it lives is configuration of the host, and the record carries the
#: version the run actually observed.
_PDFTEXT_TOOL = "pdftotext"


def _pdftext_path() -> str | None:
    return shutil.which(_PDFTEXT_TOOL)


_HEX64 = re.compile(r"[0-9a-f]{64}")

class ExtractionError(Exception):
    """Raised when an extraction record would not describe its bytes faithfully."""


def extraction_record_digest(payload: dict) -> str:
    """Return the digest of an extraction's content payload.

    The record wrapper used by :class:`ExtractionStore` keeps this digest
    outside the payload it authenticates.  This is deliberately the same
    calculation as :attr:`Extraction.record_digest`, rather than a second
    near-identical serialisation rule.
    """
    if type(payload) is not dict:
        raise ExtractionError("extraction record payload must be a dict")
    return digest_bytes(canonical_bytes(payload))


class Extractor(Enum):
    """The closed set of mechanisms that may produce attachment evidence."""

    PLAIN_TEXT = "plain_text"
    JSON_TEXT = "json_text"
    NOTEBOOK_CELLS = "notebook_cells"
    PDF_TEXT_TOOL = "pdf_text_tool"
    OFFICE_XML = "office_xml"
    ARCHIVE_MEMBERS = "archive_members"
    NONE = "none"


class ExtractionOutcome(Enum):
    """What reading one attachment established, without treating absence as text."""

    EXTRACTED = "extracted"
    EMPTY = "empty"
    UNSUPPORTED_IMAGE = "unsupported_image"
    UNSUPPORTED_VIDEO = "unsupported_video"
    UNSUPPORTED_BINARY = "unsupported_binary"
    UNREADABLE = "unreadable"
    TOOL_UNAVAILABLE = "tool_unavailable"
    ABSENT = "absent"
    TOO_LARGE = "too_large"
    ENCRYPTED = "encrypted"


_ARCHIVE_READ_STEP = 1 << 20


class _ArchiveMemberTooLarge(Exception):
    """Raised when observed member output reaches its available archive budget."""

    def __init__(self, info: zipfile.ZipInfo, observed_size: int, budget: int) -> None:
        self.info = info
        self.observed_size = observed_size
        self.budget = budget


@dataclass(slots=True)
class _MemberCheckLedger:
    """The checks made for one member, grouped by what their result establishes."""

    checks: dict[str, tuple[str, str]] = field(default_factory=dict)

    def completed(self, name: str, figures: str = "") -> None:
        self.checks[name] = ("completed", figures)

    def failed(self, name: str, figures: str) -> None:
        self.checks[name] = ("failed", figures)

    def not_executable(self, name: str, reason: str) -> None:
        self.checks[name] = ("not executable", reason)

    def has_failed_checks(self) -> bool:
        return any(outcome == "failed" for outcome, _ in self.checks.values())

    def refusal_reasons(self) -> tuple[str, ...]:
        groups: list[str] = []
        for outcome in ("completed", "failed", "not executable"):
            checks = tuple(
                f"{name} ({figures})" if figures else name
                for name, (recorded_outcome, figures) in self.checks.items()
                if recorded_outcome == outcome
            )
            if checks:
                groups.append(f"{outcome}: {', '.join(checks)}")
        return tuple(groups)


class _ArchiveMemberUnreadable(zipfile.BadZipFile):
    """Raised with every observed disagreement while reading one member."""

    def __init__(self, info: zipfile.ZipInfo, ledger: _MemberCheckLedger) -> None:
        self.info = info
        self.ledger = ledger
        self.reasons = ledger.refusal_reasons()
        super().__init__("; ".join(self.reasons))


def _reject_doctype(*_arguments: object) -> None:
    raise ValueError("XML contains a DOCTYPE declaration")


def _reject_entity(*_arguments: object) -> None:
    raise ValueError("XML contains an ENTITY declaration")


def _member_error_note(error: _ArchiveMemberUnreadable) -> str:
    return f"member {error.info.filename!r}: {'; '.join(error.reasons)}"


def _member_reasons_note(info: zipfile.ZipInfo, reasons: tuple[str, ...]) -> str:
    return f"member {info.filename!r}: {'; '.join(reasons)}"


def _block_member_checks(
    ledger: _MemberCheckLedger,
    reason: str,
    *,
    info: zipfile.ZipInfo | None = None,
) -> None:
    """Record all content checks that a previous member-layout failure prevented."""
    ledger.not_executable("compressed stream", reason)
    if info is None:
        ledger.not_executable("crc", reason)
        ledger.not_executable("size", reason)
        return
    ledger.not_executable("crc", f"{reason}; recorded {info.CRC:08x}")
    ledger.not_executable("size", f"{reason}; declared {info.file_size}")


_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
_ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
_CENTRAL_DIRECTORY_SIGNATURE = b"PK\x01\x02"
_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = b"PK\x05\x05"
_EOCD_SIZE = 22
_ZIP64_LOCATOR_SIZE = 20
_ZIP64_EOCD_MINIMUM_SIZE = 56
_CENTRAL_DIRECTORY_HEADER_SIZE = 46


@dataclass(frozen=True, slots=True)
class _ArchiveDirectoryDeclaration:
    """The original archive-directory figures, read before ``zipfile`` sees them."""

    central_directory_offset: int
    central_directory_size: int
    entries_this_disk: int
    entries_total: int


def _unsigned(data: bytes, offset: int, width: int) -> int:
    return int.from_bytes(data[offset : offset + width], "little")


def _end_of_central_directory(data: bytes) -> tuple[int, int]:
    """Locate the EOCD whose declared comment reaches the physical end of file."""
    first = max(0, len(data) - (0xFFFF + _EOCD_SIZE))
    malformed_comment: int | None = None
    for offset in range(len(data) - _EOCD_SIZE, first - 1, -1):
        if data[offset : offset + 4] != _EOCD_SIGNATURE:
            continue
        comment_length = _unsigned(data, offset + 20, 2)
        comment_end = offset + _EOCD_SIZE + comment_length
        if comment_end == len(data):
            return offset, comment_length
        if comment_end > len(data) and malformed_comment is None:
            malformed_comment = comment_length
    if malformed_comment is not None:
        raise zipfile.BadZipFile(
            "end of central directory comment length "
            f"{malformed_comment} overruns the file of {len(data)} bytes"
        )
    raise zipfile.BadZipFile("end of central directory record is absent")


def _zip64_directory_declaration(
    data: bytes,
    *,
    eocd_offset: int,
    classic_entries_this_disk: int,
    classic_entries_total: int,
    classic_size: int,
    classic_offset: int,
) -> _ArchiveDirectoryDeclaration | None:
    """Read and cross-check a ZIP64 EOCD record only from the supplied bytes."""
    locator_offset = eocd_offset - _ZIP64_LOCATOR_SIZE
    if locator_offset < 0 or data[locator_offset : locator_offset + 4] != _ZIP64_LOCATOR_SIGNATURE:
        return None
    record_offset = _unsigned(data, locator_offset + 8, 8)
    if record_offset > len(data):
        raise zipfile.BadZipFile(
            "ZIP64 end of central directory offset "
            f"{record_offset} beyond the file of {len(data)} bytes"
        )
    if record_offset + _ZIP64_EOCD_MINIMUM_SIZE > len(data):
        raise zipfile.BadZipFile(
            "ZIP64 end of central directory record at offset "
            f"{record_offset} overruns the file of {len(data)} bytes"
        )
    if data[record_offset : record_offset + 4] != _ZIP64_EOCD_SIGNATURE:
        raise zipfile.BadZipFile(
            f"ZIP64 end of central directory record is absent at declared offset {record_offset}"
        )
    record_size = _unsigned(data, record_offset + 4, 8)
    record_end = record_offset + 12 + record_size
    if record_size < 44 or record_end > len(data):
        raise zipfile.BadZipFile(
            "ZIP64 end of central directory size "
            f"{record_size} at offset {record_offset} overruns the file of {len(data)} bytes"
        )
    if record_end > locator_offset:
        raise zipfile.BadZipFile(
            "ZIP64 end of central directory ends at "
            f"{record_end}; its locator begins at {locator_offset}"
        )
    entries_this_disk = _unsigned(data, record_offset + 24, 8)
    entries_total = _unsigned(data, record_offset + 32, 8)
    central_directory_size = _unsigned(data, record_offset + 40, 8)
    central_directory_offset = _unsigned(data, record_offset + 48, 8)
    for label, classic, zip64, sentinel in (
        ("entries on this disk", classic_entries_this_disk, entries_this_disk, 0xFFFF),
        ("total entries", classic_entries_total, entries_total, 0xFFFF),
        ("central directory size", classic_size, central_directory_size, 0xFFFFFFFF),
        ("central directory offset", classic_offset, central_directory_offset, 0xFFFFFFFF),
    ):
        if classic != sentinel and classic != zip64:
            raise zipfile.BadZipFile(
                f"end of central directory {label} {classic} disagrees with ZIP64 figure {zip64}"
            )
    return _ArchiveDirectoryDeclaration(
        central_directory_offset=central_directory_offset,
        central_directory_size=central_directory_size,
        entries_this_disk=entries_this_disk,
        entries_total=entries_total,
    )


def _central_directory_span(data: bytes, start: int) -> tuple[int, int]:
    """Enumerate raw central records and return their count and physical span."""
    offset = start
    entries = 0
    while data[offset : offset + 4] == _CENTRAL_DIRECTORY_SIGNATURE:
        if offset + _CENTRAL_DIRECTORY_HEADER_SIZE > len(data):
            raise zipfile.BadZipFile(
                "central directory entry at offset "
                f"{offset} overruns the file of {len(data)} bytes"
            )
        name_length = _unsigned(data, offset + 28, 2)
        extra_length = _unsigned(data, offset + 30, 2)
        comment_length = _unsigned(data, offset + 32, 2)
        next_offset = offset + _CENTRAL_DIRECTORY_HEADER_SIZE + name_length + extra_length + comment_length
        if next_offset > len(data):
            raise zipfile.BadZipFile(
                "central directory entry at offset "
                f"{offset} declares an end of {next_offset} beyond the file of {len(data)} bytes"
            )
        entries += 1
        offset = next_offset
    if data[offset : offset + 4] == _CENTRAL_DIRECTORY_DIGITAL_SIGNATURE:
        if offset + 6 > len(data):
            raise zipfile.BadZipFile(
                "central directory digital signature at offset "
                f"{offset} overruns the file of {len(data)} bytes"
            )
        next_offset = offset + 6 + _unsigned(data, offset + 4, 2)
        if next_offset > len(data):
            raise zipfile.BadZipFile(
                "central directory digital signature at offset "
                f"{offset} declares an end of {next_offset} beyond the file of {len(data)} bytes"
            )
        offset = next_offset
    return entries, offset - start


def _archive_directory_declaration(data: bytes) -> _ArchiveDirectoryDeclaration:
    """Validate the archive's original EOCD directory claims before member parsing."""
    eocd_offset, _comment_length = _end_of_central_directory(data)
    classic_entries_this_disk = _unsigned(data, eocd_offset + 8, 2)
    classic_entries_total = _unsigned(data, eocd_offset + 10, 2)
    classic_size = _unsigned(data, eocd_offset + 12, 4)
    classic_offset = _unsigned(data, eocd_offset + 16, 4)
    zip64 = _zip64_directory_declaration(
        data,
        eocd_offset=eocd_offset,
        classic_entries_this_disk=classic_entries_this_disk,
        classic_entries_total=classic_entries_total,
        classic_size=classic_size,
        classic_offset=classic_offset,
    )
    declaration = zip64 or _ArchiveDirectoryDeclaration(
        central_directory_offset=classic_offset,
        central_directory_size=classic_size,
        entries_this_disk=classic_entries_this_disk,
        entries_total=classic_entries_total,
    )
    directory_end = declaration.central_directory_offset + declaration.central_directory_size
    if declaration.central_directory_offset > len(data):
        raise zipfile.BadZipFile(
            "central directory offset "
            f"{declaration.central_directory_offset} beyond the file of {len(data)} bytes"
        )
    if directory_end > len(data):
        raise zipfile.BadZipFile(
            "central directory offset + size "
            f"{directory_end} beyond the file of {len(data)} bytes "
            f"(offset {declaration.central_directory_offset}, size {declaration.central_directory_size})"
        )
    found_entries, found_size = _central_directory_span(data, declaration.central_directory_offset)
    if declaration.central_directory_size != found_size:
        raise zipfile.BadZipFile(
            "end of central directory declares central directory size "
            f"{declaration.central_directory_size}; {found_size} bytes found"
        )
    for label, declared in (
        ("entries on this disk", declaration.entries_this_disk),
        ("total entries", declaration.entries_total),
    ):
        if declared != found_entries:
            zip64_note = " without a ZIP64 end of central directory record" if zip64 is None and declared == 0xFFFF else ""
            raise zipfile.BadZipFile(
                "end of central directory declares "
                f"{declared} {label}; {found_entries} found{zip64_note}"
            )
    if zip64 is None and (
        classic_entries_this_disk == 0xFFFF
        or classic_entries_total == 0xFFFF
        or classic_size == 0xFFFFFFFF
        or classic_offset == 0xFFFFFFFF
    ):
        raise zipfile.BadZipFile("end of central directory requires a ZIP64 end of central directory record")
    return declaration


def _archive_member_layout_errors(
    archive: zipfile.ZipFile,
    file_size: int,
    directory_start: int,
) -> tuple[tuple[str, ...], ...]:
    """Validate every central entry's compressed-data region before member reads."""
    infos = tuple(archive.infolist())
    ledgers = [_MemberCheckLedger() for _ in infos]
    if directory_start < 0:
        for ledger in ledgers:
            ledger.failed("central directory start", f"{directory_start} before the file")
            _block_member_checks(ledger, "central directory start is outside the file")
    elif directory_start <= file_size:
        for ledger in ledgers:
            ledger.completed(
                "central directory start",
                f"{directory_start} within file of {file_size} bytes",
            )
    else:
        for ledger in ledgers:
            ledger.failed(
                "central directory start",
                f"{directory_start} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "central directory start is outside the file")

    header_references: dict[int, list[int]] = {}
    for index, info in enumerate(infos):
        header_references.setdefault(info.header_offset, []).append(index)
    for offset, indices in header_references.items():
        if len(indices) > 1:
            for index in indices:
                ledgers[index].failed(
                    "local header uniqueness",
                    f"offset {offset} is referenced by {len(indices)} central entries",
                )
                _block_member_checks(ledgers[index], "local header is shared by central entries")

    header_offsets = sorted(offset for offset in header_references if 0 <= offset <= file_size)
    next_headers = {
        offset: header_offsets[index + 1] if index + 1 < len(header_offsets) else directory_start
        for index, offset in enumerate(header_offsets)
    }
    regions: list[tuple[int, int] | None] = [None] * len(infos)
    raw = archive.fp
    for index, info in enumerate(infos):
        ledger = ledgers[index]
        if info.header_offset < 0:
            ledger.failed("local header offset", f"{info.header_offset} before the file")
            _block_member_checks(ledger, "local header offset is outside the file")
            continue
        if info.header_offset > file_size:
            ledger.failed(
                "local header offset",
                f"{info.header_offset} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "local header offset is outside the file")
            continue
        ledger.completed(
            "local header offset",
            f"{info.header_offset} within file of {file_size} bytes",
        )
        if not 0 <= directory_start <= file_size:
            continue
        try:
            raw.seek(info.header_offset)
            header = raw.read(zipfile.sizeFileHeader)
        except (AttributeError, OverflowError, OSError, ValueError) as error:
            ledger.failed("local header", _note(error))
            _block_member_checks(ledger, "local header could not be read")
            continue
        if len(header) != zipfile.sizeFileHeader or header[:4] != zipfile.stringFileHeader:
            ledger.failed("local header", f"bad local file header at offset {info.header_offset}")
            _block_member_checks(ledger, "local header is invalid")
            continue
        ledger.completed("local header")
        name_length = int.from_bytes(header[26:28], "little")
        extra_length = int.from_bytes(header[28:30], "little")
        data_start = info.header_offset + zipfile.sizeFileHeader + name_length + extra_length
        data_end = data_start + info.compress_size
        if data_start > file_size:
            ledger.failed(
                "data start",
                f"{data_start} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "data start is outside the file")
            continue
        ledger.completed("data start", f"{data_start} within file of {file_size} bytes")
        if data_end > file_size:
            ledger.failed(
                "data end",
                f"{data_end} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "data end is outside the file")
            continue
        ledger.completed("data end", f"{data_end} within file of {file_size} bytes")
        next_header = next_headers[info.header_offset]
        if data_start > next_header or data_end > next_header:
            ledger.failed(
                "archive boundary",
                f"data region {data_start}:{data_end} exceeds archive boundary {next_header}",
            )
            _block_member_checks(ledger, "data region exceeds its archive boundary")
        regions[index] = (data_start, data_end)

    furthest_region: tuple[int, int, int] | None = None
    for start, end, index in sorted(
        (start, end, index)
        for index, region in enumerate(regions)
        if region is not None
        for start, end in (region,)
    ):
        if furthest_region is not None and start < furthest_region[1]:
            other_start, other_end, other_index = furthest_region
            ledgers[index].failed(
                "data region overlap",
                f"{start}:{end} overlaps member {infos[other_index].filename!r}",
            )
            _block_member_checks(ledgers[index], "data region overlaps another member")
            ledgers[other_index].failed(
                "data region overlap",
                f"{other_start}:{other_end} overlaps member {infos[index].filename!r}",
            )
            _block_member_checks(ledgers[other_index], "data region overlaps another member")
        if furthest_region is None or end > furthest_region[1]:
            furthest_region = (start, end, index)
    return tuple(
        ledger.refusal_reasons() if ledger.has_failed_checks() else ()
        for ledger in ledgers
    )



_EXTRACTOR_MEMBERS = tuple(Extractor)
_OUTCOME_MEMBERS = tuple(ExtractionOutcome)


def _is_extractor(value: object) -> bool:
    return any(value is member for member in _EXTRACTOR_MEMBERS)


def _is_outcome(value: object) -> bool:
    return any(value is member for member in _OUTCOME_MEMBERS)


def _digest_or_none(value: str | None, name: str) -> None:
    if value is not None and (type(value) is not str or _HEX64.fullmatch(value) is None):
        raise ExtractionError(f"{name} must be a lowercase sha256 digest or None")


@dataclass(frozen=True, slots=True)
class ExtractionLocation:
    """One half-open character span, labelled in the attachment's own structure."""

    label: str
    start_char: int
    end_char: int

    def __post_init__(self) -> None:
        if type(self.label) is not str or not self.label:
            raise ExtractionError("location label must be a non-empty string")
        for name, value in (("start_char", self.start_char), ("end_char", self.end_char)):
            if type(value) is not int:
                raise ExtractionError(f"location {name} must be an int")
        if self.start_char < 0 or self.end_char < self.start_char:
            raise ExtractionError("location range must be non-negative and ordered")

    def as_payload(self) -> dict[str, str | int]:
        return {
            "label": self.label,
            "start_char": self.start_char,
            "end_char": self.end_char,
        }


@dataclass(frozen=True, slots=True)
class ExtractionMember:
    """One archive member, named verbatim and never interpreted as a filesystem path."""

    path: str
    size: int
    crc: int
    digest: str | None
    outcome: ExtractionOutcome

    def __post_init__(self) -> None:
        if type(self.path) is not str:
            raise ExtractionError("member path must be a string")
        if type(self.size) is not int or self.size < 0:
            raise ExtractionError("member size must be a non-negative int")
        if type(self.crc) is not int or not 0 <= self.crc <= 0xFFFFFFFF:
            raise ExtractionError("member crc must be an unsigned 32-bit int")
        _digest_or_none(self.digest, "member digest")
        if not _is_outcome(self.outcome):
            raise ExtractionError("member outcome must be a declared ExtractionOutcome")

    def as_payload(self) -> dict[str, str | int | None]:
        return {
            "path": self.path,
            "size": self.size,
            "crc": self.crc,
            "digest": self.digest,
            "outcome": self.outcome.value,
        }


@dataclass(frozen=True, slots=True)
class Extraction:
    """Versioned evidence derived from one immutable attachment byte sequence."""

    asset_digest: str | None
    asset_source_id: str | None
    given_name: str | None
    extractor: Extractor
    extractor_version: str
    outcome: ExtractionOutcome
    text: str
    text_digest: str
    locations: tuple[ExtractionLocation, ...]
    members: tuple[ExtractionMember, ...]
    notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _digest_or_none(self.asset_digest, "asset_digest")
        if self.asset_source_id is not None:
            if type(self.asset_source_id) is not str:
                raise ExtractionError("asset_source_id must be a string or None")
            require_id(self.asset_source_id, SOURCE_PREFIX)
        if self.given_name is not None and type(self.given_name) is not str:
            raise ExtractionError("given_name must be a string or None")
        if not _is_extractor(self.extractor):
            raise ExtractionError("extractor must be a declared Extractor")
        if type(self.extractor_version) is not str or not self.extractor_version.strip():
            raise ExtractionError("extractor_version must be a non-blank string")
        if not _is_outcome(self.outcome):
            raise ExtractionError("outcome must be a declared ExtractionOutcome")
        if type(self.text) is not str:
            raise ExtractionError("text must be a string")
        _digest_or_none(self.text_digest, "text_digest")
        if self.text_digest != digest_bytes(self.text.encode("utf-8")):
            raise ExtractionError("text_digest must describe the UTF-8 text exactly")
        if type(self.locations) is not tuple or any(type(item) is not ExtractionLocation for item in self.locations):
            raise ExtractionError("locations must be a tuple of exact ExtractionLocation records")
        for location in self.locations:
            if location.end_char > len(self.text):
                raise ExtractionError("a location falls outside the extracted text")
        if type(self.members) is not tuple or any(type(item) is not ExtractionMember for item in self.members):
            raise ExtractionError("members must be a tuple of exact ExtractionMember records")
        if type(self.notes) is not tuple or any(type(note) is not str for note in self.notes):
            raise ExtractionError("notes must be a tuple of strings")

    def content_payload(self) -> dict[str, object]:
        """The canonical evidence content, excluding its digest of itself."""
        return {
            "asset_digest": self.asset_digest,
            "asset_source_id": self.asset_source_id,
            "given_name": self.given_name,
            "extractor": self.extractor.value,
            "extractor_version": self.extractor_version,
            "outcome": self.outcome.value,
            "text": self.text,
            "text_digest": self.text_digest,
            "locations": [location.as_payload() for location in self.locations],
            "members": [member.as_payload() for member in self.members],
            "notes": list(self.notes),
        }

    @property
    def record_digest(self) -> str:
        """The sha256 of the canonical content payload."""
        return extraction_record_digest(self.content_payload())

    def as_payload(self) -> dict[str, object]:
        """The serialisable record including the digest it has just established."""
        return {**self.content_payload(), "record_digest": self.record_digest}

    def record_bytes(self) -> bytes:
        """The canonical bytes stored for this evidence record."""
        return canonical_bytes(self.as_payload())


@dataclass(frozen=True, slots=True)
class ExtractionOwner:
    """One ASSET owner and its supplied name, kept outside shared content evidence."""

    asset_source_id: str
    given_name: str | None

    def __post_init__(self) -> None:
        if type(self.asset_source_id) is not str:
            raise ExtractionError("owner asset source id must be a string")
        require_id(self.asset_source_id, SOURCE_PREFIX)
        if self.given_name is not None and type(self.given_name) is not str:
            raise ExtractionError("owner given_name must be a string or None")


@dataclass(frozen=True, slots=True)
class SharedExtraction:
    """One name-free content record and every distinct ASSET owner of its bytes."""

    extraction: Extraction
    owners: tuple[ExtractionOwner, ...]

    def __post_init__(self) -> None:
        if type(self.extraction) is not Extraction:
            raise ExtractionError("extraction must be an exact Extraction")
        if self.extraction.asset_source_id is not None or self.extraction.given_name is not None:
            raise ExtractionError("shared extraction must not carry an owner or given_name")
        if type(self.owners) is not tuple or any(type(owner) is not ExtractionOwner for owner in self.owners):
            raise ExtractionError("owners must be a tuple of exact ExtractionOwner records")
        if tuple(sorted(self.owners, key=lambda owner: owner.asset_source_id)) != self.owners:
            raise ExtractionError("owners must be sorted by asset source id")
        if len({owner.asset_source_id for owner in self.owners}) != len(self.owners):
            raise ExtractionError("owners must have unique asset source ids")

    @property
    def asset_digest(self) -> str | None:
        return self.extraction.asset_digest

    @property
    def asset_source_ids(self) -> tuple[str, ...]:
        """The compatibility view of the source identifiers in ``owners``."""
        return tuple(owner.asset_source_id for owner in self.owners)


@dataclass(frozen=True, slots=True)
class StoredExtraction:
    """One checked extraction record as held by :class:`ExtractionStore`."""

    payload: dict[str, object]
    owners: tuple[tuple[str, str | None], ...]
    record_digest: str
    text: str
    extractor_version: str


class ExtractionStore:
    """Content-addressed, read-mostly storage for shared extraction evidence."""

    def __init__(self, root: Path | None) -> None:
        self._root = None if root is None else Path(root)

    @staticmethod
    def _extractor(value: Extractor | str) -> Extractor:
        if _is_extractor(value):
            return value
        if type(value) is not str:
            raise ExtractionError("extractor must be a declared Extractor or its value")
        try:
            return Extractor(value)
        except ValueError as error:
            raise ExtractionError("extractor must be a declared Extractor or its value") from error

    @staticmethod
    def _record_path(root: Path, extractor: Extractor, asset_digest: str) -> Path:
        return root / extractor.value / f"{asset_digest}.json"

    @staticmethod
    def _not_found(extractor: Extractor, asset_digest: str):
        # Provenance owns the observable derived-citation failure vocabulary.
        # Importing lazily prevents extraction evidence from depending on a
        # citation module during its own initialisation.
        from nous_os.provenance import DerivedRecordNotFound

        return DerivedRecordNotFound(
            f"no extraction record for {extractor.value} and asset {asset_digest}"
        )

    @staticmethod
    def _corrupt(detail: str):
        from nous_os.provenance import DerivedRecordCorrupt

        return DerivedRecordCorrupt(detail)

    def get(self, extractor: Extractor | str, asset_digest: str) -> StoredExtraction:
        """Read one shared record, refusing absent and corrupt records separately."""
        selected = self._extractor(extractor)
        if type(asset_digest) is not str or _HEX64.fullmatch(asset_digest) is None:
            raise ExtractionError("asset_digest must be a lowercase sha256 digest")
        if self._root is None:
            raise self._not_found(selected, asset_digest)
        path = self._record_path(self._root, selected, asset_digest)
        if not file_is_present(path):
            raise self._not_found(selected, asset_digest)
        try:
            wrapper = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise self._corrupt(f"extraction record is unreadable: {path.name}") from error
        if type(wrapper) is not dict or set(wrapper) != {"record", "record_digest", "owners"}:
            raise self._corrupt("extraction record has the wrong wrapper shape")
        payload = wrapper["record"]
        record_digest = wrapper["record_digest"]
        owners_payload = wrapper["owners"]
        if type(payload) is not dict:
            raise self._corrupt("extraction record payload is not an object")
        if type(record_digest) is not str or _HEX64.fullmatch(record_digest) is None:
            raise self._corrupt("extraction record digest is not a lowercase sha256 digest")
        if extraction_record_digest(payload) != record_digest:
            raise self._corrupt("extraction record digest does not match its payload")
        if payload.get("asset_digest") != asset_digest:
            raise self._corrupt("extraction record asset digest does not match its address")
        if payload.get("extractor") != selected.value:
            raise self._corrupt("extraction record extractor does not match its address")
        text = payload.get("text")
        extractor_version = payload.get("extractor_version")
        if type(text) is not str or type(extractor_version) is not str or not extractor_version.strip():
            raise self._corrupt("extraction record text or extractor version is malformed")
        if payload.get("text_digest") != digest_bytes(text.encode("utf-8")):
            raise self._corrupt("extraction record text digest does not match its text")
        if type(owners_payload) is not list:
            raise self._corrupt("extraction record owners are not an array")
        owners: list[tuple[str, str | None]] = []
        for owner in owners_payload:
            if type(owner) is not dict or set(owner) != {"asset_source_id", "given_name"}:
                raise self._corrupt("extraction record owner has the wrong shape")
            source_id = owner["asset_source_id"]
            given_name = owner["given_name"]
            if type(source_id) is not str or (given_name is not None and type(given_name) is not str):
                raise self._corrupt("extraction record owner has malformed values")
            try:
                require_id(source_id, SOURCE_PREFIX)
            except Exception as error:
                raise self._corrupt("extraction record owner source id is malformed") from error
            owners.append((source_id, given_name))
        if tuple(sorted(owners, key=lambda owner: owner[0])) != tuple(owners):
            raise self._corrupt("extraction record owners are not sorted")
        if len({owner[0] for owner in owners}) != len(owners):
            raise self._corrupt("extraction record owners are not unique")
        return StoredExtraction(
            payload=payload,
            owners=tuple(owners),
            record_digest=record_digest,
            text=text,
            extractor_version=extractor_version,
        )

    def write(self, shared: SharedExtraction) -> None:
        """Write one shared extraction once; an identical record is a no-op."""
        if type(shared) is not SharedExtraction:
            raise ExtractionError("extraction store requires an exact SharedExtraction")
        extraction = shared.extraction
        if extraction.asset_digest is None:
            raise ExtractionError("a stored shared extraction must name its asset digest")
        if self._root is None:
            raise ExtractionError("an extraction store without a root cannot write")
        path = self._record_path(self._root, extraction.extractor, extraction.asset_digest)
        if file_is_present(path):
            try:
                existing = self.get(extraction.extractor, extraction.asset_digest)
            except Exception as error:
                raise ExtractionError("an existing extraction record is not readable") from error
            if existing.record_digest != extraction.record_digest:
                raise ExtractionError("an extraction record already exists with a different digest")
            owners = list(existing.owners)
            owners_by_source = {source_id: given_name for source_id, given_name in owners}
            for owner in shared.owners:
                existing_given_name = owners_by_source.get(owner.asset_source_id)
                if owner.asset_source_id in owners_by_source:
                    if existing_given_name != owner.given_name:
                        raise ExtractionError("an extraction record owner already exists with a different name")
                    continue
                owners_by_source[owner.asset_source_id] = owner.given_name
                owners.append((owner.asset_source_id, owner.given_name))
            owners.sort(key=lambda owner: owner[0])
            if tuple(owners) == existing.owners:
                return
            wrapper = {
                "record": existing.payload,
                "record_digest": existing.record_digest,
                "owners": [
                    {"asset_source_id": source_id, "given_name": given_name}
                    for source_id, given_name in owners
                ],
            }
        else:
            wrapper = {
                "record": extraction.content_payload(),
                "record_digest": extraction.record_digest,
                "owners": [
                    {"asset_source_id": owner.asset_source_id, "given_name": owner.given_name}
                    for owner in shared.owners
                ],
            }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".partial")
        temporary.write_bytes(canonical_bytes(wrapper) + b"\n")
        temporary.replace(path)


def _normalise_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _stdlib_version() -> str:
    return f"extraction/{EXTRACTION_VERSION}"


def _note(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


def _record(
    data: bytes | None,
    *,
    asset_source_id: str | None,
    given_name: str | None,
    extractor: Extractor,
    extractor_version: str,
    outcome: ExtractionOutcome,
    text: str = "",
    locations: tuple[ExtractionLocation, ...] = (),
    members: tuple[ExtractionMember, ...] = (),
    notes: tuple[str, ...] = (),
) -> Extraction:
    normalised = _normalise_newlines(text)
    return Extraction(
        asset_digest=None if data is None else digest_bytes(data),
        asset_source_id=asset_source_id,
        given_name=given_name,
        extractor=extractor,
        extractor_version=extractor_version,
        outcome=outcome,
        text=normalised,
        text_digest=digest_bytes(normalised.encode("utf-8")),
        locations=locations,
        members=members,
        notes=notes,
    )


def _joined_segments(segments: Iterable[tuple[str, str]]) -> tuple[str, tuple[ExtractionLocation, ...]]:
    """Join labelled structural text while retaining character offsets into the result."""
    parts: list[str] = []
    locations: list[ExtractionLocation] = []
    offset = 0
    for label, unnormalised in segments:
        text = _normalise_newlines(unnormalised)
        if not text:
            continue
        if parts:
            parts.append("\n")
            offset += 1
        start = offset
        parts.append(text)
        offset += len(text)
        locations.append(ExtractionLocation(label, start, offset))
    return "".join(parts), tuple(locations)


def _decode_text(data: bytes) -> tuple[str, str]:
    """Decode the supported BOM forms while removing their non-content marker."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8"), "utf-8-sig"
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le"), "utf-16-le"
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be"), "utf-16-be"
    return data.decode("utf-8"), "utf-8"


def _content_kind(data: bytes, *, given_name: str | None = None) -> str:
    """Classify only supplied bytes; names are deliberately absent from this decision."""
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8\xff"):
        return "image"
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return "video"
    if data.startswith((b"PK\x03\x04", b"PK\x05\x06")):
        return "zip"
    try:
        text, _encoding = _decode_text(data)
    except UnicodeDecodeError:
        return "binary"
    if not text:
        return "plain"
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        decoded = None
    else:
        if type(decoded) is dict:
            if type(decoded.get("cells")) is list or "nbformat" in decoded:
                return "notebook"
        return "json"
    lines = [line for line in text.splitlines() if line.strip()]
    if lines:
        try:
            for line in lines:
                json.loads(line)
        except json.JSONDecodeError:
            pass
        else:
            return "json"
    return "plain"


def _text_record(
    data: bytes,
    *,
    asset_source_id: str | None,
    given_name: str | None,
    extractor: Extractor,
) -> Extraction:
    text, encoding = _decode_text(data)
    text = _normalise_newlines(text)
    if len(text.encode("utf-8")) > MAX_EXTRACTED_TEXT_BYTES:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=extractor,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.TOO_LARGE,
            notes=(f"extracted text exceeds {MAX_EXTRACTED_TEXT_BYTES} bytes",),
        )
    outcome = ExtractionOutcome.EMPTY if not text else ExtractionOutcome.EXTRACTED
    locations = () if not text else (ExtractionLocation("text", 0, len(text)),)
    return _record(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        extractor=extractor,
        extractor_version=_stdlib_version(),
        outcome=outcome,
        text=text,
        locations=locations,
        notes=() if encoding == "utf-8" else (f"encoding:{encoding}",),
    )


def _notebook_record(data: bytes, *, asset_source_id: str | None, given_name: str | None) -> Extraction:
    try:
        text, _encoding = _decode_text(data)
        document = json.loads(text)
        cells = document["cells"]
        if type(cells) is not list:
            raise TypeError("cells is not a list")
        segments: list[tuple[str, str]] = []
        for index, cell in enumerate(cells):
            if type(cell) is not dict:
                raise TypeError(f"cell {index} is not an object")
            cell_type = cell.get("cell_type")
            source = cell.get("source", "")
            if type(cell_type) is not str:
                raise TypeError(f"cell {index} has no string cell_type")
            if type(source) is list and all(type(line) is str for line in source):
                source = "".join(source)
            if type(source) is not str:
                raise TypeError(f"cell {index} source is not text")
            # Outputs are deliberately never read, and source text is never run.
            segments.append((f"cell:{index}:{cell_type}", source))
        text, locations = _joined_segments(segments)
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.NOTEBOOK_CELLS,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.EMPTY if not text else ExtractionOutcome.EXTRACTED,
            text=text,
            locations=locations,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.NOTEBOOK_CELLS,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(_note(error),),
        )


def _pdftotext_version(tool: str) -> str:
    try:
        completed = subprocess.run(
            [tool, "-v"],
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "unreported"
    observed = completed.stdout or completed.stderr
    lines = observed.decode("utf-8", errors="replace").splitlines()
    return lines[0] if lines and lines[0] else "unreported"


def _bounded_pdf_stdout(tool: str, data: bytes) -> tuple[subprocess.CompletedProcess[bytes], bytes, bool]:
    """Run the PDF tool with stdin bytes while retaining no more than the text cap."""
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb")
    writer = os.fdopen(write_fd, "wb")
    chunks: list[bytes] = []
    size = 0
    too_large = False

    def drain_stdout() -> None:
        nonlocal size, too_large
        with reader:
            while chunk := reader.read(64 * 1024):
                size += len(chunk)
                if too_large:
                    continue
                if size > MAX_EXTRACTED_TEXT_BYTES:
                    too_large = True
                    chunks.clear()
                    continue
                chunks.append(chunk)

    drain_thread = threading.Thread(target=drain_stdout)
    drain_thread.start()
    try:
        completed = subprocess.run(
            [tool, "-layout", "-", "-"],
            input=data,
            stdout=writer,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    finally:
        writer.close()
        drain_thread.join()
    if completed.stdout is not None:
        returned_stdout = completed.stdout
        return (
            completed,
            b"" if len(returned_stdout) > MAX_EXTRACTED_TEXT_BYTES else returned_stdout,
            len(returned_stdout) > MAX_EXTRACTED_TEXT_BYTES,
        )
    return completed, b"".join(chunks), too_large


def _pdf_tool_record(
    data: bytes,
    *,
    asset_source_id: str | None,
    given_name: str | None,
) -> Extraction:
    tool = _pdftext_path()
    if tool is None:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_TOOL,
            extractor_version="unavailable",
            outcome=ExtractionOutcome.TOOL_UNAVAILABLE,
            notes=(f"{_PDFTEXT_TOOL} is unavailable on PATH",),
        )
    version = _pdftotext_version(tool)
    try:
        completed, stdout, stdout_too_large = _bounded_pdf_stdout(tool, data)
    except (OSError, subprocess.SubprocessError) as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_TOOL,
            extractor_version=version,
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(f"{_PDFTEXT_TOOL}: {_note(error)}",),
        )
    if stdout_too_large:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_TOOL,
            extractor_version=version,
            outcome=ExtractionOutcome.TOO_LARGE,
            notes=(f"{_PDFTEXT_TOOL} stdout exceeds {MAX_EXTRACTED_TEXT_BYTES} bytes",),
        )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        note = (
            f"{_PDFTEXT_TOOL} exited {completed.returncode}"
            if not detail
            else f"{_PDFTEXT_TOOL} exited {completed.returncode}: {detail}"
        )
        outcome = (
            ExtractionOutcome.ENCRYPTED
            if "password" in detail.lower()
            else ExtractionOutcome.UNREADABLE
        )
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_TOOL,
            extractor_version=version,
            outcome=outcome,
            notes=(note,),
        )
    try:
        text = _normalise_newlines(stdout.decode("utf-8")).rstrip()
    except UnicodeDecodeError as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_TOOL,
            extractor_version=version,
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(f"{_PDFTEXT_TOOL}: {_note(error)}",),
        )
    page_parts = text.split("\f")
    locations: list[ExtractionLocation] = []
    offset = 0
    for index, part in enumerate(page_parts, start=1):
        if part:
            locations.append(ExtractionLocation(f"page:{index}", offset, offset + len(part)))
        offset += len(part)
        if index != len(page_parts):
            offset += 1
    return _record(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        extractor=Extractor.PDF_TEXT_TOOL,
        extractor_version=version,
        outcome=ExtractionOutcome.EMPTY if not text else ExtractionOutcome.EXTRACTED,
        text=text,
        locations=tuple(locations),
    )


def _zip_names(infos: Iterable[zipfile.ZipInfo]) -> tuple[str, ...]:
    return tuple(info.filename for info in infos)


def _archive_exceeds_bounds(infos: tuple[zipfile.ZipInfo, ...]) -> bool:
    """Check all central-directory sizes before reading any archive member."""
    if len(infos) > MAX_ARCHIVE_MEMBERS:
        return True
    total = 0
    for info in infos:
        if info.file_size > MAX_ARCHIVE_TEXT_BYTES:
            return True
        total += info.file_size
        if total > MAX_ARCHIVE_TEXT_BYTES:
            return True
    return False


def _too_large_archive_members(
    infos: tuple[zipfile.ZipInfo, ...],
    layout_errors: tuple[tuple[str, ...], ...],
) -> tuple[ExtractionMember, ...]:
    """Retain bounded central-directory inventory without claiming unread data parsed."""
    return tuple(
        ExtractionMember(
            path=info.filename,
            size=info.file_size,
            crc=info.CRC,
            digest=None,
            outcome=ExtractionOutcome.UNREADABLE if layout_errors[index] else ExtractionOutcome.TOO_LARGE,
        )
        for index, info in enumerate(infos[:MAX_ARCHIVE_MEMBERS])
    )


def _layout_error_notes(
    infos: tuple[zipfile.ZipInfo, ...],
    layout_errors: tuple[tuple[str, ...], ...],
) -> tuple[str, ...]:
    return tuple(
        _member_reasons_note(info, reasons)
        for info, reasons in zip(infos[:MAX_ARCHIVE_MEMBERS], layout_errors)
        if reasons
    )


def _office_kind(names: tuple[str, ...]) -> str | None:
    names_set = set(names)
    if "[Content_Types].xml" in names_set:
        if any(name.startswith("word/") for name in names):
            return "word"
        if any(name.startswith("xl/") for name in names):
            return "sheet"
        if any(name.startswith("ppt/") for name in names):
            return "slides"
    if any(name.startswith("Index/") for name in names):
        return "pages"
    return None


def _part_order(name: str) -> tuple[int, str]:
    match = re.search(r"(\d+)(?:\.xml)?$", name)
    return (int(match.group(1)) if match else -1, name)


def _element_text(element: ElementTree.Element) -> str:
    return "".join(child.text or "" for child in element.iter() if child.tag.rsplit("}", 1)[-1] == "t")


def _office_xml(data: bytes) -> ElementTree.Element:
    """Parse original bytes while refusing declarations before they define text."""
    parser = ElementTree.XMLParser()
    if hasattr(parser, "parser"):
        parser.parser.StartDoctypeDeclHandler = _reject_doctype
        parser.parser.EntityDeclHandler = _reject_entity
        parser.feed(data)
        return parser.close()
    # Some standard-library builds hide the expat instance on XMLParser.
    # Run its equivalent parser with the same declaration callbacks first,
    # then give the untouched bytes to ElementTree's configured parser.
    underlying = expat.ParserCreate()
    underlying.StartDoctypeDeclHandler = _reject_doctype
    underlying.EntityDeclHandler = _reject_entity
    underlying.Parse(data, True)
    return ElementTree.fromstring(data, parser=parser)


def _read_stored_member(raw: object, info: zipfile.ZipInfo, maximum_output: int) -> bytes:
    """Read a stored member without accepting more output than its caller permits."""
    output = bytearray()
    compressed_remaining = info.compress_size
    while compressed_remaining:
        output_remaining = maximum_output - len(output)
        if output_remaining <= 0:
            raise _ArchiveMemberTooLarge(info, len(output), maximum_output)
        chunk = raw.read(min(_ARCHIVE_READ_STEP, compressed_remaining, output_remaining))
        if not chunk:
            raise zipfile.BadZipFile(f"truncated stored member {info.filename!r}")
        output.extend(chunk)
        compressed_remaining -= len(chunk)
    return bytes(output)


def _incomplete_deflated_member_error(info: zipfile.ZipInfo, observed_compressed_size: int) -> zipfile.BadZipFile:
    return zipfile.BadZipFile(
        f"deflated member {info.filename!r}: declared compressed size {info.compress_size}, "
        f"stream ended after {observed_compressed_size} bytes; declared CRC {info.CRC:#010x}, "
        f"declared size {info.file_size}: not checked, stream incomplete"
    )


def _read_deflated_member(raw: object, info: zipfile.ZipInfo, maximum_output: int) -> bytes:
    """Inflate one raw deflate stream in bounded output steps."""
    inflater = zlib.decompressobj(-15)
    output = bytearray()
    compressed_remaining = info.compress_size
    compressed = b""
    while True:
        if not compressed:
            if compressed_remaining == 0:
                if inflater.eof:
                    return bytes(output)
                raise _incomplete_deflated_member_error(info, info.compress_size)
            compressed = raw.read(min(_ARCHIVE_READ_STEP, compressed_remaining))
            if not compressed:
                raise _incomplete_deflated_member_error(
                    info,
                    info.compress_size - compressed_remaining,
                )
            compressed_remaining -= len(compressed)
        output_remaining = maximum_output - len(output)
        if output_remaining <= 0:
            raise _ArchiveMemberTooLarge(info, len(output), maximum_output)
        output.extend(inflater.decompress(compressed, min(_ARCHIVE_READ_STEP, output_remaining)))
        compressed = inflater.unconsumed_tail
        if inflater.eof:
            if inflater.unused_data or compressed or compressed_remaining:
                consumed = info.compress_size - compressed_remaining - len(compressed) - len(inflater.unused_data)
                raise _incomplete_deflated_member_error(info, consumed)
            return bytes(output)
        if len(output) == maximum_output:
            raise _ArchiveMemberTooLarge(info, len(output), maximum_output)


def _read_archive_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    maximum_output: int,
    file_size: int,
    directory_start: int,
) -> bytes:
    """Observe one ZIP member without trusting its declared uncompressed size.

    The member's bytes are located through its local file header, so the reader
    depends on the ZIP format rather than on the standard library's internals.
    """
    ledger = _MemberCheckLedger()
    try:
        if directory_start < 0:
            ledger.failed("central directory start", f"{directory_start} before the file")
            _block_member_checks(ledger, "central directory start is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        if directory_start > file_size:
            ledger.failed(
                "central directory start",
                f"{directory_start} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "central directory start is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed(
            "central directory start",
            f"{directory_start} within file of {file_size} bytes",
        )
        if info.header_offset < 0:
            ledger.failed("local header offset", f"{info.header_offset} before the file")
            _block_member_checks(ledger, "local header offset is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        if info.header_offset > file_size:
            ledger.failed(
                "local header offset",
                f"{info.header_offset} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "local header offset is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed(
            "local header offset",
            f"{info.header_offset} within file of {file_size} bytes",
        )
        raw = archive.fp
        try:
            raw.seek(info.header_offset)
            header = raw.read(zipfile.sizeFileHeader)
        except (AttributeError, OverflowError, OSError, ValueError) as error:
            ledger.failed("local header", _note(error))
            _block_member_checks(ledger, "local header could not be read")
            raise _ArchiveMemberUnreadable(info, ledger) from error
        if len(header) != zipfile.sizeFileHeader or header[:4] != zipfile.stringFileHeader:
            ledger.failed("local header", f"bad local file header at offset {info.header_offset}")
            _block_member_checks(ledger, "local header is invalid")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed("local header")
        local_flags = int.from_bytes(header[6:8], "little")
        local_method = int.from_bytes(header[8:10], "little")
        name_length = int.from_bytes(header[26:28], "little")
        extra_length = int.from_bytes(header[28:30], "little")
        local_compressed_size = int.from_bytes(header[18:22], "little")
        data_start = info.header_offset + zipfile.sizeFileHeader + name_length + extra_length
        data_end = data_start + info.compress_size
        if data_start > file_size:
            ledger.failed(
                "data start",
                f"{data_start} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "data start is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed("data start", f"{data_start} within file of {file_size} bytes")
        if data_end > file_size:
            ledger.failed(
                "data end",
                f"{data_end} beyond the file of {file_size} bytes",
            )
            _block_member_checks(ledger, "data end is outside the file")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed("data end", f"{data_end} within file of {file_size} bytes")
        boundaries = [directory_start]
        boundaries.extend(
            candidate.header_offset
            for candidate in archive.infolist()
            if info.header_offset < candidate.header_offset <= file_size
        )
        next_header = min(boundaries)
        if data_start > next_header or data_end > next_header:
            ledger.failed(
                "archive boundary",
                f"data region {data_start}:{data_end} exceeds archive boundary {next_header}",
            )
            _block_member_checks(ledger, "data region exceeds its archive boundary")
            raise _ArchiveMemberUnreadable(info, ledger)
        ledger.completed("archive boundary", f"data region ends before {next_header}")
        if local_flags != info.flag_bits:
            ledger.failed("local flags", f"{local_flags:#x} differs from central flags {info.flag_bits:#x}")
        else:
            ledger.completed("local flags", f"{local_flags:#x}")
        if local_method != info.compress_type:
            ledger.failed("local method", f"{local_method} differs from central method {info.compress_type}")
        else:
            ledger.completed("local method", str(local_method))
        if info.flag_bits & 0x8:
            ledger.not_executable("compressed size", "local header uses a data descriptor")
        elif local_compressed_size != info.compress_size:
            ledger.failed(
                "compressed size",
                f"declared {info.compress_size}, available {local_compressed_size}",
            )
        else:
            ledger.completed("compressed size", str(local_compressed_size))
        try:
            local_name_bytes = raw.read(name_length)
        except (AttributeError, OverflowError, OSError, ValueError) as error:
            ledger.failed("local name", _note(error))
            _block_member_checks(ledger, "local name could not be read")
            raise _ArchiveMemberUnreadable(info, ledger) from error
        if len(local_name_bytes) != name_length:
            ledger.failed("local name", f"expected {name_length} bytes, observed {len(local_name_bytes)}")
        else:
            name_encoding = "utf-8" if info.flag_bits & 0x800 else "cp437"
            try:
                local_name = local_name_bytes.decode(name_encoding)
            except UnicodeDecodeError as error:
                ledger.failed("local name", f"cannot decode as {name_encoding}: {error}")
            else:
                if local_name != info.orig_filename:
                    ledger.failed(
                        "local name",
                        f"{local_name!r} differs from central name {info.orig_filename!r}",
                    )
                else:
                    ledger.completed("local name", repr(local_name))
        if info.flag_bits & 0x1:
            ledger.not_executable("compressed stream", "encrypted")
            ledger.not_executable("crc", f"encrypted; recorded {info.CRC:08x}")
            ledger.not_executable("size", "encrypted")
            raise _ArchiveMemberUnreadable(info, ledger)
        if ledger.has_failed_checks():
            _block_member_checks(
                ledger,
                "local header disagrees with the central directory",
                info=info,
            )
            raise _ArchiveMemberUnreadable(info, ledger)
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            _block_member_checks(ledger, f"unsupported compression method {info.compress_type}")
            raise _ArchiveMemberUnreadable(info, ledger)
        try:
            raw.seek(data_start)
            if info.compress_type == zipfile.ZIP_STORED:
                member_data = _read_stored_member(raw, info, maximum_output)
            else:
                member_data = _read_deflated_member(raw, info, maximum_output)
        except _ArchiveMemberTooLarge:
            raise
        except (AttributeError, NotImplementedError, OverflowError, OSError, RuntimeError, ValueError, zlib.error, zipfile.BadZipFile) as error:
            ledger.failed("compressed stream", _note(error))
            ledger.not_executable("crc", "compressed stream did not complete")
            ledger.not_executable("size", "compressed stream did not complete")
            raise _ArchiveMemberUnreadable(info, ledger) from error
        ledger.completed("compressed stream", f"observed {len(member_data)} bytes")
        observed_crc = zlib.crc32(member_data) & 0xFFFFFFFF
        if observed_crc != info.CRC:
            ledger.failed("crc", f"declared {info.CRC:#010x}, observed {observed_crc:#010x}")
        else:
            ledger.completed("crc", f"{observed_crc:#010x}")
        if len(member_data) != info.file_size:
            ledger.failed("size", f"declared {info.file_size}, observed {len(member_data)}")
        else:
            ledger.completed("size", str(len(member_data)))
        if ledger.has_failed_checks():
            raise _ArchiveMemberUnreadable(info, ledger)
        return member_data
    except _ArchiveMemberTooLarge:
        raise
    except _ArchiveMemberUnreadable:
        raise
    except (AttributeError, NotImplementedError, OverflowError, OSError, RuntimeError, ValueError, zlib.error, zipfile.BadZipFile) as error:
        ledger.failed("member read", _note(error))
        _block_member_checks(ledger, "member could not be read")
        raise _ArchiveMemberUnreadable(info, ledger) from error


def _office_segments(
    archive: zipfile.ZipFile,
    names: tuple[str, ...],
    kind: str,
    file_size: int,
    directory_start: int,
) -> list[tuple[str, str]]:
    consumed = 0

    def read_part(name: str) -> bytes:
        nonlocal consumed
        member_data = _read_archive_member(
            archive,
            archive.getinfo(name),
            maximum_output=MAX_ARCHIVE_TEXT_BYTES - consumed,
            file_size=file_size,
            directory_start=directory_start,
        )
        consumed += len(member_data)
        return member_data

    if kind == "word":
        root = _office_xml(read_part("word/document.xml"))
        return [
            (f"paragraph:{index}", _element_text(element))
            for index, element in enumerate(root.iter())
            if element.tag.rsplit("}", 1)[-1] == "p"
        ]
    if kind == "sheet":
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            shared_root = _office_xml(read_part("xl/sharedStrings.xml"))
            shared = [_element_text(element) for element in shared_root.iter() if element.tag.rsplit("}", 1)[-1] == "si"]
        segments = []
        cell_index = 0
        for name in sorted((item for item in names if item.startswith("xl/worksheets/sheet") and item.endswith(".xml")), key=_part_order):
            sheet_number = _part_order(name)[0]
            root = _office_xml(read_part(name))
            for cell in (element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "c"):
                cell_type = cell.attrib.get("t")
                if cell_type == "inlineStr":
                    value = _element_text(cell)
                else:
                    value_node = next((item for item in cell.iter() if item.tag.rsplit("}", 1)[-1] == "v"), None)
                    value = "" if value_node is None or value_node.text is None else value_node.text
                    if cell_type == "s" and value:
                        value = shared[int(value)]
                segments.append((f"sheet:{sheet_number}:cell:{cell_index}", value))
                cell_index += 1
        return segments
    if kind == "slides":
        segments = []
        for name in sorted((item for item in names if item.startswith("ppt/slides/slide") and item.endswith(".xml")), key=_part_order):
            root = _office_xml(read_part(name))
            segments.append((f"slide:{_part_order(name)[0]}", _element_text(root)))
        return segments
    segments = []
    for name in sorted((item for item in names if item.startswith("Index/") and item.endswith(".xml")), key=_part_order):
        root = _office_xml(read_part(name))
        segments.append((f"index:{name}", _element_text(root)))
    return segments


def _office_record(
    data: bytes,
    archive: zipfile.ZipFile,
    names: tuple[str, ...],
    kind: str,
    directory_start: int,
    *,
    asset_source_id: str | None,
    given_name: str | None,
) -> Extraction:
    try:
        text, locations = _joined_segments(
            _office_segments(archive, names, kind, len(data), directory_start)
        )
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.OFFICE_XML,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.EMPTY if not text else ExtractionOutcome.EXTRACTED,
            text=text,
            locations=locations,
            notes=(f"office:{kind}",),
        )
    except _ArchiveMemberTooLarge as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.OFFICE_XML,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.TOO_LARGE,
            members=(
                ExtractionMember(
                    path=error.info.filename,
                    size=error.info.file_size,
                    crc=error.info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.TOO_LARGE,
                ),
            ),
            notes=(
                f"office:{kind}",
                f"member {error.info.filename!r}: archive budget {error.budget} reached after {error.observed_size} bytes",
            ),
        )
    except _ArchiveMemberUnreadable as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.OFFICE_XML,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(f"office:{kind}", _member_error_note(error)),
        )
    except (
        ElementTree.ParseError,
        expat.ExpatError,
        IndexError,
        KeyError,
        LookupError,
        ValueError,
        NotImplementedError,
        zlib.error,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        OSError,
        RuntimeError,
    ) as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.OFFICE_XML,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(f"office:{kind}", _note(error)),
        )


def _archive_member_outcome(data: bytes) -> ExtractionOutcome:
    kind = _content_kind(data)
    if kind in {"plain", "json", "notebook"}:
        return _extract_from_bytes(data, asset_source_id=None, given_name=None, allow_archive=False).outcome
    if kind == "image":
        return ExtractionOutcome.UNSUPPORTED_IMAGE
    if kind == "video":
        return ExtractionOutcome.UNSUPPORTED_VIDEO
    return ExtractionOutcome.UNSUPPORTED_BINARY


def _archive_record(
    data: bytes,
    archive: zipfile.ZipFile,
    layout_errors: tuple[tuple[str, ...], ...],
    directory_start: int,
    *,
    asset_source_id: str | None,
    given_name: str | None,
) -> Extraction:
    members: list[ExtractionMember] = []
    text_segments: list[tuple[str, str]] = []
    unreadable_notes: list[str] = []
    consumed = 0
    bounded = False
    for index, info in enumerate(archive.infolist()):
        if index >= MAX_ARCHIVE_MEMBERS:
            bounded = True
            break
        if layout_errors[index]:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.UNREADABLE,
                )
            )
            unreadable_notes.append(_member_reasons_note(info, layout_errors[index]))
            continue
        if info.file_size > MAX_ARCHIVE_TEXT_BYTES - consumed:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.TOO_LARGE,
                )
            )
            bounded = True
            break
        try:
            member_data = _read_archive_member(
                archive,
                info,
                maximum_output=MAX_ARCHIVE_TEXT_BYTES - consumed,
                file_size=len(data),
                directory_start=directory_start,
            )
        except _ArchiveMemberTooLarge as error:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.TOO_LARGE,
                )
            )
            unreadable_notes.append(
                f"member {error.info.filename!r}: archive budget {error.budget} reached after {error.observed_size} bytes"
            )
            bounded = True
            break
        except _ArchiveMemberUnreadable as error:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.UNREADABLE,
                )
            )
            unreadable_notes.append(_member_error_note(error))
            continue
        except (NotImplementedError, OSError, RuntimeError, zlib.error, zipfile.BadZipFile) as error:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.UNREADABLE,
                )
            )
            unreadable_notes.append(f"member {info.filename!r}: {_note(error)}")
            continue
        consumed += len(member_data)
        outcome = _archive_member_outcome(member_data)
        members.append(
            ExtractionMember(
                path=info.filename,
                size=info.file_size,
                crc=info.CRC,
                digest=digest_bytes(member_data),
                outcome=outcome,
            )
        )
        if outcome in {ExtractionOutcome.EXTRACTED, ExtractionOutcome.EMPTY}:
            nested = _extract_from_bytes(member_data, asset_source_id=None, given_name=None, allow_archive=False)
            if nested.text:
                text_segments.append((info.filename, nested.text))
    if bounded:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.ARCHIVE_MEMBERS,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.TOO_LARGE,
            members=tuple(members),
            notes=tuple(unreadable_notes),
        )
    text, locations = _joined_segments(text_segments)
    outcome = ExtractionOutcome.EXTRACTED if text else ExtractionOutcome.EMPTY
    if not text and unreadable_notes:
        outcome = ExtractionOutcome.UNREADABLE
    return _record(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        extractor=Extractor.ARCHIVE_MEMBERS,
        extractor_version=_stdlib_version(),
        outcome=outcome,
        text=text,
        locations=locations,
        members=tuple(members),
        notes=tuple(unreadable_notes),
    )


def _zip_record(data: bytes, *, asset_source_id: str | None, given_name: str | None) -> Extraction:
    try:
        directory = _archive_directory_declaration(data)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = tuple(archive.infolist())
            names = _zip_names(infos)
            kind = _office_kind(names)
            layout_errors = _archive_member_layout_errors(
                archive,
                len(data),
                directory.central_directory_offset,
            )
            if _archive_exceeds_bounds(infos):
                return _record(
                    data,
                    asset_source_id=asset_source_id,
                    given_name=given_name,
                    extractor=Extractor.OFFICE_XML if kind is not None else Extractor.ARCHIVE_MEMBERS,
                    extractor_version=_stdlib_version(),
                    outcome=ExtractionOutcome.TOO_LARGE,
                    members=_too_large_archive_members(infos, layout_errors),
                    notes=((f"office:{kind}",) if kind is not None else ())
                    + ("archive central directory exceeds extraction bounds",)
                    + _layout_error_notes(infos, layout_errors),
                )
            if kind is not None:
                layout_notes = _layout_error_notes(infos, layout_errors)
                if layout_notes:
                    return _record(
                        data,
                        asset_source_id=asset_source_id,
                        given_name=given_name,
                        extractor=Extractor.OFFICE_XML,
                        extractor_version=_stdlib_version(),
                        outcome=ExtractionOutcome.UNREADABLE,
                        members=tuple(
                            ExtractionMember(
                                path=info.filename,
                                size=info.file_size,
                                crc=info.CRC,
                                digest=None,
                                outcome=ExtractionOutcome.UNREADABLE,
                            )
                            for info, reasons in zip(infos, layout_errors)
                            if reasons
                        ),
                        notes=(f"office:{kind}",) + layout_notes,
                    )
                return _office_record(
                    data,
                    archive,
                    names,
                    kind,
                    directory.central_directory_offset,
                    asset_source_id=asset_source_id,
                    given_name=given_name,
                )
            return _archive_record(
                data,
                archive,
                layout_errors,
                directory.central_directory_offset,
                asset_source_id=asset_source_id,
                given_name=given_name,
            )
    except (AttributeError, OverflowError, OSError, RuntimeError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.ARCHIVE_MEMBERS,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(_note(error),),
        )


def _extract_from_bytes(
    data: bytes,
    *,
    asset_source_id: str | None,
    given_name: str | None,
    allow_archive: bool,
) -> Extraction:
    kind = _content_kind(data, given_name=given_name)
    if kind == "plain":
        return _text_record(data, asset_source_id=asset_source_id, given_name=given_name, extractor=Extractor.PLAIN_TEXT)
    if kind == "json":
        return _text_record(data, asset_source_id=asset_source_id, given_name=given_name, extractor=Extractor.JSON_TEXT)
    if kind == "notebook":
        return _notebook_record(data, asset_source_id=asset_source_id, given_name=given_name)
    if kind == "pdf":
        return _pdf_tool_record(data, asset_source_id=asset_source_id, given_name=given_name)
    if kind == "zip" and allow_archive:
        return _zip_record(data, asset_source_id=asset_source_id, given_name=given_name)
    if kind == "image":
        outcome = ExtractionOutcome.UNSUPPORTED_IMAGE
    elif kind == "video":
        outcome = ExtractionOutcome.UNSUPPORTED_VIDEO
    else:
        outcome = ExtractionOutcome.UNSUPPORTED_BINARY
    return _record(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        extractor=Extractor.NONE,
        extractor_version=_stdlib_version(),
        outcome=outcome,
    )


def extract_bytes(
    data: bytes,
    asset_source_id: str | None = None,
    *,
    given_name: str | None = None,
    pdf_backend: Extractor | None = None,
) -> Extraction:
    """Extract evidence from supplied bytes without writing them or trusting a name.

    PDFs are passed as input to the configured tool, so their evidence comes
    from the same bytes this function was given.
    """
    if type(data) is not bytes:
        raise ExtractionError("data must be bytes")
    if pdf_backend not in (None, Extractor.PDF_TEXT_TOOL):
        raise ExtractionError("pdf_backend must be PDF_TEXT_TOOL or None")
    return _extract_from_bytes(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        allow_archive=True,
    )


def extract_file(
    path: Path | str,
    asset_source_id: str | None = None,
    *,
    given_name: str | None = None,
    pdf_backend: Extractor | None = None,
) -> Extraction:
    """Read one path once and return evidence; this function never opens it for writing."""
    resolved = Path(path)
    recorded_name = resolved.name if given_name is None else given_name
    if type(recorded_name) is not str:
        raise ExtractionError("given_name must be a string or None")
    try:
        data = resolved.read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return _record(
            None,
            asset_source_id=asset_source_id,
            given_name=recorded_name,
            extractor=Extractor.NONE,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.ABSENT,
        )
    except OSError as error:
        return _record(
            None,
            asset_source_id=asset_source_id,
            given_name=recorded_name,
            extractor=Extractor.NONE,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(_note(error),),
        )
    if pdf_backend not in (None, Extractor.PDF_TEXT_TOOL):
        raise ExtractionError("pdf_backend must be PDF_TEXT_TOOL or None")
    return _extract_from_bytes(
        data,
        asset_source_id=asset_source_id,
        given_name=recorded_name,
        allow_archive=True,
    )


def deduplicate_extractions(records: Iterable[Extraction]) -> tuple[SharedExtraction, ...]:
    """Share deterministic name-free evidence while retaining each owner's supplied name."""
    grouped: dict[
        tuple[str, Extractor, str],
        tuple[list[Extraction], dict[str, set[str | None]]],
    ] = {}
    for record in records:
        if type(record) is not Extraction:
            raise ExtractionError("deduplication requires exact Extraction records")
        if record.asset_digest is None:
            continue
        key = (record.asset_digest, record.extractor, record.extractor_version)
        if key not in grouped:
            grouped[key] = ([], {})
        grouped[key][0].append(record)
        if record.asset_source_id is not None:
            grouped[key][1].setdefault(record.asset_source_id, set()).add(record.given_name)
    return tuple(
        SharedExtraction(
            extraction=min(
                (replace(record, asset_source_id=None, given_name=None) for record in grouped_records),
                key=lambda record: record.record_bytes(),
            ),
            owners=tuple(
                ExtractionOwner(
                    asset_source_id=source_id,
                    given_name=min(names, key=lambda name: (name is not None, name or "")),
                )
                for source_id, names in sorted(owner_names.items())
            ),
        )
        for _key, (grouped_records, owner_names) in sorted(
            grouped.items(),
            key=lambda item: (item[0][0], item[0][1].value, item[0][2]),
        )
    )


def extract_assets(assets: Iterable[tuple[Path | str, str | None]]) -> tuple[SharedExtraction, ...]:
    """Read asset paths and return the operation-ready, content-keyed sharing view."""
    return deduplicate_extractions(
        extract_file(path, source_id) for path, source_id in assets
    )
