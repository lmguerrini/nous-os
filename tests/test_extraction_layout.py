"""Archive members bound to the archive layout, and XML declarations refused by the parser for every encoding."""
from __future__ import annotations

import zipfile
import zlib
from pathlib import Path

import pytest

from nous_os.extraction import ExtractionOutcome, Extractor, extract_file


def _zip(path: Path, entries: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> Path:
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _central_entry(data: bytearray, member_name: str) -> int:
    offset = 0
    encoded = member_name.encode("utf-8")
    while True:
        offset = data.find(b"PK\x01\x02", offset)
        assert offset >= 0, f"no central-directory entry for {member_name!r}"
        name_size = int.from_bytes(data[offset + 28 : offset + 30], "little")
        extra_size = int.from_bytes(data[offset + 30 : offset + 32], "little")
        comment_size = int.from_bytes(data[offset + 32 : offset + 34], "little")
        if data[offset + 46 : offset + 46 + name_size] == encoded:
            return offset
        offset = offset + 46 + name_size + extra_size + comment_size


def _forge(path: Path, member_name: str, *, compress_size: int | None = None, crc: int | None = None, method: int | None = None, flags: int | None = None) -> Path:
    data = bytearray(path.read_bytes())
    offset = _central_entry(data, member_name)
    if compress_size is not None:
        data[offset + 20 : offset + 24] = compress_size.to_bytes(4, "little")
    if crc is not None:
        data[offset + 16 : offset + 20] = crc.to_bytes(4, "little")
    if method is not None:
        data[offset + 10 : offset + 12] = method.to_bytes(2, "little")
    if flags is not None:
        data[offset + 8 : offset + 10] = flags.to_bytes(2, "little")
    path.write_bytes(data)
    return path


# ------------------------------------------------------------

def test_a_utf16_office_part_with_a_doctype_is_refused_before_parsing(tmp_path: Path) -> None:
    part = (
        '<?xml version="1.0"?><!DOCTYPE document [<!ENTITY hidden "must-not-expand">]>'
        '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>&hidden;</w:t></w:r></w:p></w:body></w:document>'
    ).encode("utf-16")  # BOM + UTF-16 little endian
    document = _zip(tmp_path / "utf16.docx", {"[Content_Types].xml": b"<Types/>", "word/document.xml": part})

    record = extract_file(document)

    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, record.text[:80])
    assert "must-not-expand" not in record.text
    assert any("DOCTYPE" in note for note in record.notes)


# ------------------------------------------------------------

def test_a_corrupted_office_part_is_unreadable_not_an_exception(tmp_path: Path) -> None:
    document = _zip(tmp_path / "corrupt.docx", {"[Content_Types].xml": b"<Types/>", "word/document.xml": b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>' + b"words " * 200 + b"</w:t></w:r></w:p></w:body></w:document>"})
    data = bytearray(document.read_bytes())
    with zipfile.ZipFile(document) as archive:
        info = archive.getinfo("word/document.xml")
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    extra_length = int.from_bytes(data[header + 28 : header + 30], "little")
    first = header + 30 + name_length + extra_length
    data[first] = 0x06  # invalid deflate block type
    document.write_bytes(data)

    record = extract_file(document)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("error" in note.lower() and "document.xml" in note for note in record.notes), record.notes


def test_a_corrupted_archive_member_is_unreadable_not_an_exception(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "corrupt.zip", {"note.txt": b"plain words " * 300})
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("note.txt")
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    extra_length = int.from_bytes(data[header + 28 : header + 30], "little")
    data[header + 30 + name_length + extra_length] = 0x06
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "note.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE


# ------------------------------------------------------------

def test_a_member_whose_declared_compressed_size_exceeds_its_stream_is_refused(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "larger.zip", {"a.txt": b"first member " * 100, "b.txt": b"second member " * 100})
    with zipfile.ZipFile(archive_path) as archive:
        real = archive.getinfo("a.txt").compress_size
    _forge(archive_path, "a.txt", compress_size=real + 40)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "a.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE, member.outcome
    assert any("a.txt" in note for note in record.notes)


def test_a_member_whose_local_header_disagrees_with_the_directory_is_refused(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "disagree.zip", {"normal.txt": b"normal words " * 100})
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("normal.txt")
    header = info.header_offset
    data[header + 8 : header + 10] = (8).to_bytes(2, "little")  # local method: deflated, while the directory says the truth
    data[header + 6 : header + 8] = (0x1).to_bytes(2, "little")  # local flag: encrypted
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "normal.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE, member.outcome
    assert any("normal.txt" in note for note in record.notes)


# ------------------------------------------------------------

def test_a_member_with_a_wrong_crc_is_unreadable(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "crc.zip", {"note.txt": b"checked words " * 100})
    _forge(archive_path, "note.txt", crc=0x12345678)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "note.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("CRC" in note.upper() and "note.txt" in note for note in record.notes)


# ------------------------------------------------------------

def test_a_member_whose_local_name_length_is_wrong_is_unreadable_not_an_exception(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "namelen.zip", {"note.txt": b"named words " * 200})
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("note.txt")
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    data[header + 26 : header + 28] = (name_length + 1).to_bytes(2, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "note.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("note.txt" in note for note in record.notes)


def test_a_stored_member_whose_declared_size_runs_into_the_directory_is_refused(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "overrun.zip", {"hello.txt": b"hello"}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive_path.read_bytes())
    offset = _central_entry(data, "hello.txt")
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("hello.txt")
    start = info.header_offset + 30 + len("hello.txt")
    overrun = bytes(data[start : start + 15])  # "hello" + 10 bytes of the central directory
    data[offset + 16 : offset + 20] = (zlib.crc32(overrun) & 0xFFFFFFFF).to_bytes(4, "little")
    data[offset + 20 : offset + 24] = (15).to_bytes(4, "little")
    data[offset + 24 : offset + 28] = (15).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "hello.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE, member.outcome
    assert "PK" not in record.text


def test_declaration_detection_is_linear_in_the_part_size(tmp_path: Path) -> None:
    import time

    def timed(starters: int) -> float:
        part = b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>' + b"<![CDATA[" * starters + b"</w:t></w:r></w:p></w:body></w:document>"
        document = _zip(tmp_path / f"cdata-{starters}.docx", {"[Content_Types].xml": b"<Types/>", "word/document.xml": part})
        started = time.perf_counter()
        extract_file(document)
        return time.perf_counter() - started

    small, large = timed(4_000), timed(40_000)
    assert large < 1.0, f"40,000 unclosed CDATA starters took {large:.2f}s"
    assert large < 25 * max(small, 0.005), f"superlinear: {small:.3f}s → {large:.3f}s"
