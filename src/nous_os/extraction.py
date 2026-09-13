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
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree

from nous_os.identity import SOURCE_PREFIX, canonical_bytes, digest_bytes, digest_payload, require_id


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
_XML_DECLARATION = re.compile(br"<!\s*(DOCTYPE|ENTITY)\b", re.IGNORECASE)

class ExtractionError(Exception):
    """Raised when an extraction record would not describe its bytes faithfully."""


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
_CDATA_OR_COMMENT = re.compile(br"<!\[CDATA\[.*?\]\]>|<!--.*?-->", re.DOTALL)


class _ArchiveMemberTooLarge(Exception):
    """Raised when observed member output reaches its available archive budget."""

    def __init__(self, info: zipfile.ZipInfo, observed_size: int, budget: int) -> None:
        self.info = info
        self.observed_size = observed_size
        self.budget = budget


class _ArchiveMemberSizeMismatch(Exception):
    """Raised when observed member output disagrees with its directory size."""

    def __init__(self, info: zipfile.ZipInfo, observed_size: int) -> None:
        self.info = info
        self.observed_size = observed_size



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
        return digest_payload(self.content_payload())

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


def _too_large_archive_members(infos: tuple[zipfile.ZipInfo, ...]) -> tuple[ExtractionMember, ...]:
    """Retain bounded central-directory inventory without claiming unread data parsed."""
    return tuple(
        ExtractionMember(
            path=info.filename,
            size=info.file_size,
            crc=info.CRC,
            digest=None,
            outcome=ExtractionOutcome.TOO_LARGE,
        )
        for info in infos[:MAX_ARCHIVE_MEMBERS]
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
    """Reject declarations that could define text before parsing an XML part."""
    declaration = _XML_DECLARATION.search(_CDATA_OR_COMMENT.sub(b"", data))
    if declaration is not None:
        kind = declaration.group(1).decode("ascii").upper()
        raise ValueError(f"XML contains a {kind} declaration")
    return ElementTree.fromstring(data)


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
                raise zipfile.BadZipFile(f"truncated deflated member {info.filename!r}")
            compressed = raw.read(min(_ARCHIVE_READ_STEP, compressed_remaining))
            if not compressed:
                raise zipfile.BadZipFile(f"truncated deflated member {info.filename!r}")
            compressed_remaining -= len(compressed)
        output_remaining = maximum_output - len(output)
        if output_remaining <= 0:
            raise _ArchiveMemberTooLarge(info, len(output), maximum_output)
        output.extend(inflater.decompress(compressed, min(_ARCHIVE_READ_STEP, output_remaining)))
        compressed = inflater.unconsumed_tail
        if inflater.eof:
            if compressed or compressed_remaining:
                raise zipfile.BadZipFile(f"deflated member {info.filename!r} has trailing data")
            return bytes(output)
        if len(output) == maximum_output:
            raise _ArchiveMemberTooLarge(info, len(output), maximum_output)


def _read_archive_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    maximum_output: int,
) -> bytes:
    """Observe one ZIP member without trusting its declared uncompressed size.

    The member's bytes are located through its local file header, so the reader
    depends on the ZIP format rather than on the standard library's internals.
    """
    if info.flag_bits & 0x1:
        raise zipfile.BadZipFile(f"encrypted member {info.filename!r}")
    raw = archive.fp
    raw.seek(info.header_offset)
    header = raw.read(zipfile.sizeFileHeader)
    if len(header) != zipfile.sizeFileHeader or header[:4] != zipfile.stringFileHeader:
        raise zipfile.BadZipFile(f"bad local file header for member {info.filename!r}")
    name_length = int.from_bytes(header[26:28], "little")
    extra_length = int.from_bytes(header[28:30], "little")
    raw.seek(info.header_offset + zipfile.sizeFileHeader + name_length + extra_length)
    if info.compress_type == zipfile.ZIP_STORED:
        member_data = _read_stored_member(raw, info, maximum_output)
    elif info.compress_type == zipfile.ZIP_DEFLATED:
        member_data = _read_deflated_member(raw, info, maximum_output)
    else:
        raise NotImplementedError(f"unsupported ZIP compression for member {info.filename!r}")
    if zlib.crc32(member_data) & 0xFFFFFFFF != info.CRC:
        raise zipfile.BadZipFile(f"bad CRC for member {info.filename!r}")
    if len(member_data) != info.file_size:
        raise _ArchiveMemberSizeMismatch(info, len(member_data))
    return member_data


def _office_segments(
    archive: zipfile.ZipFile,
    names: tuple[str, ...],
    kind: str,
) -> list[tuple[str, str]]:
    consumed = 0

    def read_part(name: str) -> bytes:
        nonlocal consumed
        member_data = _read_archive_member(
            archive,
            archive.getinfo(name),
            maximum_output=MAX_ARCHIVE_TEXT_BYTES - consumed,
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
    *,
    asset_source_id: str | None,
    given_name: str | None,
) -> Extraction:
    try:
        text, locations = _joined_segments(_office_segments(archive, names, kind))
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
    except _ArchiveMemberSizeMismatch as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.OFFICE_XML,
            extractor_version=_stdlib_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=(
                f"office:{kind}",
                f"member {error.info.filename!r}: observed size {error.observed_size} differs from declared size {error.info.file_size}",
            ),
        )
    except (
        ElementTree.ParseError,
        IndexError,
        KeyError,
        LookupError,
        ValueError,
        NotImplementedError,
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


def _archive_record(data: bytes, archive: zipfile.ZipFile, *, asset_source_id: str | None, given_name: str | None) -> Extraction:
    members: list[ExtractionMember] = []
    text_segments: list[tuple[str, str]] = []
    unreadable_notes: list[str] = []
    consumed = 0
    bounded = False
    for index, info in enumerate(archive.infolist()):
        if index >= MAX_ARCHIVE_MEMBERS:
            bounded = True
            break
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
        except _ArchiveMemberSizeMismatch as error:
            members.append(
                ExtractionMember(
                    path=info.filename,
                    size=info.file_size,
                    crc=info.CRC,
                    digest=None,
                    outcome=ExtractionOutcome.UNREADABLE,
                )
            )
            unreadable_notes.append(
                f"member {error.info.filename!r}: observed size {error.observed_size} differs from declared size {error.info.file_size}"
            )
            continue
        except (NotImplementedError, OSError, RuntimeError, zipfile.BadZipFile) as error:
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
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = tuple(archive.infolist())
            names = _zip_names(infos)
            kind = _office_kind(names)
            if _archive_exceeds_bounds(infos):
                return _record(
                    data,
                    asset_source_id=asset_source_id,
                    given_name=given_name,
                    extractor=Extractor.OFFICE_XML if kind is not None else Extractor.ARCHIVE_MEMBERS,
                    extractor_version=_stdlib_version(),
                    outcome=ExtractionOutcome.TOO_LARGE,
                    members=_too_large_archive_members(infos),
                    notes=((f"office:{kind}",) if kind is not None else ())
                    + ("archive central directory exceeds extraction bounds",),
                )
            if kind is not None:
                return _office_record(
                    data,
                    archive,
                    names,
                    kind,
                    asset_source_id=asset_source_id,
                    given_name=given_name,
                )
            return _archive_record(data, archive, asset_source_id=asset_source_id, given_name=given_name)
    except (OSError, zipfile.BadZipFile) as error:
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
