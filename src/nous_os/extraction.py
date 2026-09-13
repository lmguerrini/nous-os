"""Read attachment bytes into separately attributed extraction evidence.

This module reads only.  It never executes document content, never extracts an
archive to disk, and never treats a supplied name as evidence of a format.
The two closed vocabularies below keep an empty extraction, an unsupported
format, and a failed parser visibly distinct.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import zipfile
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree

from nous_os.identity import SOURCE_PREFIX, canonical_bytes, digest_bytes, digest_payload, require_id


#: The bounded archive member count.  It includes entries whose data are not
#: read because a preceding entry has exhausted the byte allowance.
MAX_ARCHIVE_MEMBERS = 200
#: The total uncompressed member data this module may read from one archive.
MAX_ARCHIVE_TEXT_BYTES = 20 * 1024 * 1024
#: Version recorded for extraction paths implemented only with the standard library.
EXTRACTION_VERSION = "1"
#: The PDF text tool is found on the caller's PATH, never at a machine path:
#: where it lives is configuration of the host, and the record carries the
#: version the run actually observed.
_PDFTEXT_TOOL = "pdftotext"


def _pdftext_path() -> Path | None:
    found = shutil.which(_PDFTEXT_TOOL)
    return Path(found) if found else None
_HEX64 = re.compile(r"[0-9a-f]{64}")


class ExtractionError(Exception):
    """Raised when an extraction record would not describe its bytes faithfully."""


class Extractor(Enum):
    """The closed set of mechanisms that may produce attachment evidence."""

    PLAIN_TEXT = "plain_text"
    JSON_TEXT = "json_text"
    NOTEBOOK_CELLS = "notebook_cells"
    PDF_TEXT_TOOL = "pdf_text_tool"
    PDF_TEXT_LIBRARY = "pdf_text_library"
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
    ABSENT = "absent"
    TOO_LARGE = "too_large"
    ENCRYPTED = "encrypted"


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
class SharedExtraction:
    """One content-keyed record and every distinct ASSET source that owns its bytes."""

    extraction: Extraction
    asset_source_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self.extraction) is not Extraction:
            raise ExtractionError("extraction must be an exact Extraction")
        if type(self.asset_source_ids) is not tuple:
            raise ExtractionError("asset_source_ids must be a tuple")
        for source_id in self.asset_source_ids:
            if type(source_id) is not str:
                raise ExtractionError("every asset source id must be a string")
            require_id(source_id, SOURCE_PREFIX)
        if tuple(sorted(set(self.asset_source_ids))) != self.asset_source_ids:
            raise ExtractionError("asset_source_ids must be sorted and unique")

    @property
    def asset_digest(self) -> str | None:
        return self.extraction.asset_digest


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


def _content_kind(data: bytes, *, given_name: str | None = None) -> str:
    """Classify only supplied bytes; names are deliberately absent from this decision."""
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8\xff"):
        return "image"
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return "video"
    if data.startswith(b"PK\x03\x04"):
        return "zip"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "binary"
    if not text:
        return "plain"
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        decoded = None
    else:
        if type(decoded) is dict and type(decoded.get("cells")) is list:
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
    text = _normalise_newlines(data.decode("utf-8"))
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
    )


def _notebook_record(data: bytes, *, asset_source_id: str | None, given_name: str | None) -> Extraction:
    try:
        document = json.loads(data.decode("utf-8"))
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


def _pypdf_version() -> str:
    import pypdf

    version = str(pypdf.__version__).strip()
    return version or "unreported"


def _pdf_library_record(data: bytes, *, asset_source_id: str | None, given_name: str | None, notes: tuple[str, ...] = ()) -> Extraction:
    try:
        from pypdf import PdfReader

        version = _pypdf_version()
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return _record(
                data,
                asset_source_id=asset_source_id,
                given_name=given_name,
                extractor=Extractor.PDF_TEXT_LIBRARY,
                extractor_version=version,
                outcome=ExtractionOutcome.ENCRYPTED,
                notes=notes,
            )
        segments = [(f"page:{index}", page.extract_text() or "") for index, page in enumerate(reader.pages, start=1)]
        text, locations = _joined_segments(segments)
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_LIBRARY,
            extractor_version=version,
            outcome=ExtractionOutcome.EMPTY if not text else ExtractionOutcome.EXTRACTED,
            text=text,
            locations=locations,
            notes=notes,
        )
    except Exception as error:
        return _record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            extractor=Extractor.PDF_TEXT_LIBRARY,
            extractor_version=_pypdf_version(),
            outcome=ExtractionOutcome.UNREADABLE,
            notes=notes + (_note(error),),
        )


def _pdftotext_version() -> str | None:
    tool = _pdftext_path()
    if tool is None or not tool.is_file():
        return None
    try:
        completed = subprocess.run(
            [str(tool), "-v"],
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    observed = completed.stderr.decode("utf-8", errors="replace").strip()
    return observed or None


def _pdf_tool_record(
    data: bytes,
    path: Path,
    *,
    asset_source_id: str | None,
    given_name: str | None,
) -> Extraction | None:
    version = _pdftotext_version()
    if version is None:
        return None
    try:
        completed = subprocess.run(
            [str(_pdftext_path()), "-layout", str(path), "-"],
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return _pdf_library_record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            notes=(f"pdftotext: {_note(error)}",),
        )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        note = f"pdftotext exited {completed.returncode}" if not detail else f"pdftotext exited {completed.returncode}: {detail}"
        return _pdf_library_record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            notes=(note,),
        )
    try:
        text = _normalise_newlines(completed.stdout.decode("utf-8"))
    except UnicodeDecodeError as error:
        return _pdf_library_record(
            data,
            asset_source_id=asset_source_id,
            given_name=given_name,
            notes=(f"pdftotext: {_note(error)}",),
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
        outcome=ExtractionOutcome.EMPTY if not text.strip("\n\f") else ExtractionOutcome.EXTRACTED,
        text=text,
        locations=tuple(locations),
    )


def _zip_names(archive: zipfile.ZipFile) -> tuple[str, ...]:
    return tuple(info.filename for info in archive.infolist())


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


def _office_segments(archive: zipfile.ZipFile, kind: str) -> list[tuple[str, str]]:
    names = _zip_names(archive)
    if kind == "word":
        root = ElementTree.fromstring(archive.read("word/document.xml"))
        return [
            (f"paragraph:{index}", _element_text(element))
            for index, element in enumerate(root.iter())
            if element.tag.rsplit("}", 1)[-1] == "p"
        ]
    if kind == "sheet":
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [_element_text(element) for element in shared_root.iter() if element.tag.rsplit("}", 1)[-1] == "si"]
        segments = []
        cell_index = 0
        for name in sorted((item for item in names if item.startswith("xl/worksheets/sheet") and item.endswith(".xml")), key=_part_order):
            sheet_number = _part_order(name)[0]
            root = ElementTree.fromstring(archive.read(name))
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
            root = ElementTree.fromstring(archive.read(name))
            segments.append((f"slide:{_part_order(name)[0]}", _element_text(root)))
        return segments
    segments = []
    for name in sorted((item for item in names if item.startswith("Index/") and item.endswith(".xml")), key=_part_order):
        root = ElementTree.fromstring(archive.read(name))
        segments.append((f"index:{name}", _element_text(root)))
    return segments


def _office_record(data: bytes, archive: zipfile.ZipFile, kind: str, *, asset_source_id: str | None, given_name: str | None) -> Extraction:
    try:
        text, locations = _joined_segments(_office_segments(archive, kind))
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
    except (ElementTree.ParseError, KeyError, ValueError, zipfile.BadZipFile, OSError) as error:
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
            member_data = archive.read(info)
        except (OSError, RuntimeError, zipfile.BadZipFile) as error:
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
            kind = _office_kind(_zip_names(archive))
            if kind is not None:
                return _office_record(
                    data,
                    archive,
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
    pdf_backend: Extractor | None = None,
) -> Extraction:
    kind = _content_kind(data, given_name=given_name)
    if kind == "plain":
        return _text_record(data, asset_source_id=asset_source_id, given_name=given_name, extractor=Extractor.PLAIN_TEXT)
    if kind == "json":
        return _text_record(data, asset_source_id=asset_source_id, given_name=given_name, extractor=Extractor.JSON_TEXT)
    if kind == "notebook":
        return _notebook_record(data, asset_source_id=asset_source_id, given_name=given_name)
    if kind == "pdf":
        return _pdf_library_record(data, asset_source_id=asset_source_id, given_name=given_name)
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

    Bytes have no stable pathname, so PDFs use the recorded library path here.
    ``pdf_backend`` may only select that library path; it exists for a caller
    that needs to state its choice explicitly rather than depending on a tool.
    """
    if type(data) is not bytes:
        raise ExtractionError("data must be bytes")
    if pdf_backend not in (None, Extractor.PDF_TEXT_LIBRARY):
        raise ExtractionError("extract_bytes can only use PDF_TEXT_LIBRARY for PDFs")
    return _extract_from_bytes(
        data,
        asset_source_id=asset_source_id,
        given_name=given_name,
        allow_archive=True,
        pdf_backend=pdf_backend,
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
    kind = _content_kind(data, given_name=recorded_name)
    if kind == "pdf" and pdf_backend is not Extractor.PDF_TEXT_LIBRARY:
        tool_record = _pdf_tool_record(
            data,
            resolved,
            asset_source_id=asset_source_id,
            given_name=recorded_name,
        )
        if tool_record is not None:
            return tool_record
    if pdf_backend not in (None, Extractor.PDF_TEXT_TOOL, Extractor.PDF_TEXT_LIBRARY):
        raise ExtractionError("pdf_backend must be a declared PDF extractor or None")
    return _extract_from_bytes(
        data,
        asset_source_id=asset_source_id,
        given_name=recorded_name,
        allow_archive=True,
        pdf_backend=pdf_backend,
    )


def deduplicate_extractions(records: Iterable[Extraction]) -> tuple[SharedExtraction, ...]:
    """Share one content record per asset digest while retaining every owner id."""
    grouped: dict[str, tuple[Extraction, set[str]]] = {}
    for record in records:
        if type(record) is not Extraction:
            raise ExtractionError("deduplication requires exact Extraction records")
        if record.asset_digest is None:
            continue
        if record.asset_digest not in grouped:
            grouped[record.asset_digest] = (record, set())
        grouped[record.asset_digest][1].update(
            () if record.asset_source_id is None else (record.asset_source_id,)
        )
    return tuple(
        SharedExtraction(
            extraction=replace(record, asset_source_id=None),
            asset_source_ids=tuple(sorted(source_ids)),
        )
        for _digest, (record, source_ids) in sorted(grouped.items())
    )


def extract_assets(assets: Iterable[tuple[Path | str, str | None]]) -> tuple[SharedExtraction, ...]:
    """Read asset paths and return the operation-ready, content-keyed sharing view."""
    return deduplicate_extractions(
        extract_file(path, source_id) for path, source_id in assets
    )
