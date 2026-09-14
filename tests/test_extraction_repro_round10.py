"""Regression oracle for F-9A: a second end-of-directory record that ends exactly at the end of the file must not yield a partial extraction.

The declared structure must account for every byte of the archive; bytes that no declared region covers are a named refusal.
"""
from __future__ import annotations

import io
import struct
import zipfile
from pathlib import Path

import pytest

from nous_os import extraction
from nous_os.extraction import ExtractionOutcome, Extractor, extract_file


def _central_entries(data: bytearray) -> list[int]:
    eocd = data.rfind(b"PK\x05\x06")
    assert eocd >= 0
    offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    entries = []
    while data[offset : offset + 4] == b"PK\x01\x02":
        entries.append(offset)
        offset += 46 + int.from_bytes(data[offset + 28 : offset + 30], "little")
        offset += int.from_bytes(data[offset + 30 : offset + 32], "little")
        offset += int.from_bytes(data[offset + 32 : offset + 34], "little")
    return entries


def _member_data_end(data: bytes, info: zipfile.ZipInfo) -> int:
    header = info.header_offset
    return (
        header
        + 30
        + int.from_bytes(data[header + 26 : header + 28], "little")
        + int.from_bytes(data[header + 28 : header + 30], "little")
        + info.compress_size
    )


def _insert_between_members(path: Path, size: int = 7) -> tuple[Path, int]:
    data = bytearray(path.read_bytes())
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        first = archive.infolist()[0]
    centrals = _central_entries(data)
    insertion = _member_data_end(data, first)
    data[insertion:insertion] = b"J" * size
    for central in centrals:
        central += size
        header_offset = int.from_bytes(data[central + 42 : central + 46], "little")
        if header_offset >= insertion:
            data[central + 42 : central + 46] = (header_offset + size).to_bytes(4, "little")
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[eocd + 16 : eocd + 20] = (directory_offset + size).to_bytes(4, "little")
    path.write_bytes(data)
    return path, insertion


def _insert_before_directory(path: Path, size: int = 7) -> tuple[Path, int]:
    data = bytearray(path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[directory_offset:directory_offset] = b"J" * size
    eocd = data.rfind(b"PK\x05\x06")
    data[eocd + 16 : eocd + 20] = (directory_offset + size).to_bytes(4, "little")
    path.write_bytes(data)
    return path, directory_offset


def _zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _zip64_tail(
    path: Path,
    *,
    junk: bytes = b"",
    sector: bytes = b"",
    sector_is_declared: bool = True,
) -> Path:
    data = bytearray(path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    directory_size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    entries = int.from_bytes(data[eocd + 10 : eocd + 12], "little")
    body = bytes(data[:eocd])
    record_offset = len(body)
    record = b"PK\x06\x06" + struct.pack(
        "<QHHIIQQQQ",
        44 + len(sector) if sector_is_declared else 44,
        45,
        45,
        0,
        0,
        entries,
        entries,
        directory_size,
        directory_offset,
    )
    if junk == b"duplicate-record":
        junk = record
    locator = b"PK\x06\x07" + struct.pack("<IQI", 0, record_offset, 1)
    sentinel_eocd = b"PK\x05\x06" + struct.pack(
        "<HHHHIIH", 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0
    )
    path.write_bytes(body + record + sector + junk + locator + sentinel_eocd)
    return path


def _terminal_second_directory(path: Path) -> Path:
    data = bytearray(path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    directory_size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    entries = int.from_bytes(data[eocd + 10 : eocd + 12], "little")
    copied_directory = bytes(data[directory_offset:eocd])
    body = bytes(data[:eocd])
    copy_offset = len(body) + 22
    terminal = b"PK\x05\x06" + struct.pack(
        "<HHHHIIH", 0, 0, entries, entries, directory_size, copy_offset, 0
    )
    comment = copied_directory + terminal
    original = bytes(data[eocd : eocd + 20]) + len(comment).to_bytes(2, "little")
    path.write_bytes(body + original + comment)
    return path


class _UnseekableBuffer(io.RawIOBase):
    def __init__(self) -> None:
        self._data = bytearray()

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def tell(self) -> int:
        return len(self._data)

    def write(self, data: bytes) -> int:
        self._data.extend(data)
        return len(data)

    def value(self) -> bytes:
        return bytes(self._data)


def _two_eocd_terminal_archive(tmp_path: Path) -> Path:
    """EOCD#1 (2 entries) whose comment holds a copy of member a's central entry followed by EOCD#2 (1 entry) ending exactly at EOF."""
    archive_path = tmp_path / "two-terminal.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("a.txt", b"alpha words " * 20)
        archive.writestr("b.txt", b"beta words " * 20)
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    cd_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    name_length = int.from_bytes(data[cd_offset + 28 : cd_offset + 30], "little")
    extra_length = int.from_bytes(data[cd_offset + 30 : cd_offset + 32], "little")
    comment_length = int.from_bytes(data[cd_offset + 32 : cd_offset + 34], "little")
    first_length = 46 + name_length + extra_length + comment_length
    first_entry = bytes(data[cd_offset : cd_offset + first_length])
    body = bytes(data[:eocd])
    copy_offset = len(body) + 22
    eocd2 = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, 1, 1, first_length, copy_offset, 0)
    comment = first_entry + eocd2
    eocd1 = bytes(data[eocd : eocd + 20]) + len(comment).to_bytes(2, "little")
    archive_path.write_bytes(body + eocd1 + comment)
    return archive_path


def test_a_terminal_second_end_record_never_yields_a_partial_extraction(tmp_path: Path) -> None:
    archive_path = _two_eocd_terminal_archive(tmp_path)
    assert [info.filename for info in zipfile.ZipFile(archive_path).infolist()] == ["a.txt"]  # the standard library sees one member
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, [m.path for m in record.members], record.notes)
    note = " ".join(record.notes)
    assert "not accounted for" in note, record.notes
    assert any(ch.isdigit() for ch in note), record.notes


def test_an_unaccounted_region_note_names_its_offset_and_length(tmp_path: Path) -> None:
    """The real two-entry directory (and EOCD#1) start right after b's data; the note must name that region's offset and length."""
    archive_path = _two_eocd_terminal_archive(tmp_path)
    data = archive_path.read_bytes()
    eocd1 = data.find(b"PK\x05\x06")
    real_directory = int.from_bytes(data[eocd1 + 16 : eocd1 + 20], "little")
    eocd2 = data.rfind(b"PK\x05\x06")
    copy_offset = int.from_bytes(data[eocd2 + 16 : eocd2 + 20], "little")
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    note = " ".join(record.notes)
    assert str(real_directory) in note, (real_directory, record.notes)
    assert str(copy_offset - real_directory) in note, (copy_offset - real_directory, record.notes)


def test_an_ordinary_stored_archive_with_a_nested_stored_archive_is_still_extracted(tmp_path: Path) -> None:
    """A nested archive stored as a member is covered by that member's data region: no false refusal."""
    inner = tmp_path / "inner.zip"
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("inner.txt", b"inner words " * 10)
    outer = tmp_path / "outer.zip"
    with zipfile.ZipFile(outer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("notes.txt", b"outer words " * 10)
        archive.writestr("inner.zip", inner.read_bytes())
    record = extract_file(outer)
    assert record.outcome is ExtractionOutcome.EXTRACTED, (record.outcome, record.notes)
    assert "outer words" in record.text


def test_junk_between_declared_member_regions_is_named_with_its_offset_and_length(tmp_path: Path) -> None:
    archive_path, offset = _insert_between_members(
        _zip(tmp_path / "between-members.zip", {"a.txt": b"alpha words", "b.txt": b"beta words"})
    )

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert f"7 bytes at offset {offset} not accounted for by the declared structure" in " ".join(record.notes)


def test_junk_after_the_last_data_region_is_named_with_its_offset_and_length(tmp_path: Path) -> None:
    archive_path, offset = _insert_before_directory(
        _zip(tmp_path / "before-directory.zip", {"a.txt": b"alpha words", "b.txt": b"beta words"})
    )

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert f"7 bytes at offset {offset} not accounted for by the declared structure" in " ".join(record.notes)


def test_a_well_formed_zip64_tail_is_extracted(tmp_path: Path) -> None:
    archive_path = _zip64_tail(_zip(tmp_path / "zip64.zip", {"a.txt": b"zip64 words"}))

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.EXTRACTED, record.notes
    assert "zip64 words" in record.text


def test_bytes_between_a_zip64_end_record_and_its_locator_are_named(tmp_path: Path) -> None:
    archive_path = _zip64_tail(
        _zip(tmp_path / "zip64-junk.zip", {"a.txt": b"zip64 words"}),
        junk=b"duplicate-record",
    )

    record = extract_file(archive_path)

    record_offset = archive_path.read_bytes().find(b"PK\x06\x06")
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert f"56 bytes at offset {record_offset + 56} not accounted for by the declared structure" in " ".join(record.notes)


@pytest.mark.parametrize("sector_size", (1, 10))
def test_a_zip64_extensible_data_sector_is_parsed_without_changing_accounting(
    tmp_path: Path,
    sector_size: int,
) -> None:
    archive_path = _zip64_tail(
        _zip(
            tmp_path / f"zip64-sector-{sector_size}.zip",
            {"a.txt": b"alpha sector text", "b.txt": b"beta sector text"},
        ),
        sector=b"S" * sector_size,
    )

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.EXTRACTED, record.notes
    assert "alpha sector text" in record.text
    assert "beta sector text" in record.text


def test_bytes_after_a_zip64_extensible_data_sector_are_named(tmp_path: Path) -> None:
    sector = b"S" * 10
    archive_path = _zip64_tail(
        _zip(tmp_path / "zip64-sector-junk.zip", {"a.txt": b"zip64 words"}),
        sector=sector,
        junk=b"J" * 7,
    )

    record = extract_file(archive_path)

    record_offset = archive_path.read_bytes().find(b"PK\x06\x06")
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert (
        f"7 bytes at offset {record_offset + 56 + len(sector)} "
        "not accounted for by the declared structure"
    ) in " ".join(record.notes)


def test_an_undeclared_zip64_extensible_data_sector_is_named_as_a_gap(tmp_path: Path) -> None:
    sector = b"S" * 10
    archive_path = _zip64_tail(
        _zip(tmp_path / "zip64-undeclared-sector.zip", {"a.txt": b"zip64 words"}),
        sector=sector,
        sector_is_declared=False,
    )

    record = extract_file(archive_path)

    record_offset = archive_path.read_bytes().find(b"PK\x06\x06")
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert (
        f"{len(sector)} bytes at offset {record_offset + 56} "
        "not accounted for by the declared structure"
    ) in " ".join(record.notes)


def _descriptor_archive(path: Path) -> tuple[Path, zipfile.ZipInfo, bytes]:
    stream = _UnseekableBuffer()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("descriptor.txt", b"descriptor words")
    data = stream.value()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.infolist()[0]
    path.write_bytes(data)
    return path, info, data


def test_signed_data_descriptor_is_accounted_for(tmp_path: Path) -> None:
    archive_path, info, data = _descriptor_archive(tmp_path / "signed-descriptor.zip")
    descriptor_offset = _member_data_end(data, info)

    record = extract_file(archive_path)

    assert info.flag_bits & 0x8
    assert data[descriptor_offset : descriptor_offset + 4] == b"PK\x07\x08"
    assert record.outcome is ExtractionOutcome.EXTRACTED, record.notes


def test_unsigned_data_descriptor_is_accounted_for(tmp_path: Path) -> None:
    archive_path, info, data = _descriptor_archive(tmp_path / "unsigned-descriptor.zip")
    descriptor_offset = _member_data_end(data, info)
    altered = bytearray(data)
    assert altered[descriptor_offset : descriptor_offset + 4] == b"PK\x07\x08"
    del altered[descriptor_offset : descriptor_offset + 4]
    eocd = altered.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(altered[eocd + 16 : eocd + 20], "little")
    altered[eocd + 16 : eocd + 20] = (directory_offset - 4).to_bytes(4, "little")
    archive_path.write_bytes(altered)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.EXTRACTED, record.notes


def test_descriptor_bytes_with_bit_three_cleared_are_named_as_unaccounted(tmp_path: Path) -> None:
    archive_path, info, data = _descriptor_archive(tmp_path / "descriptor-cleared.zip")
    descriptor_offset = _member_data_end(data, info)
    altered = bytearray(data)
    altered[6:8] = (int.from_bytes(altered[6:8], "little") & ~0x8).to_bytes(2, "little")
    central = _central_entries(altered)[0]
    altered[central + 8 : central + 10] = (
        int.from_bytes(altered[central + 8 : central + 10], "little") & ~0x8
    ).to_bytes(2, "little")
    archive_path.write_bytes(altered)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert f"16 bytes at offset {descriptor_offset} not accounted for by the declared structure" in " ".join(record.notes)


def test_empty_and_digital_signature_archives_keep_their_existing_outcomes(tmp_path: Path) -> None:
    empty = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty, "w"):
        pass
    assert extract_file(empty).outcome is ExtractionOutcome.EMPTY

    signed = _zip(tmp_path / "digital-signature.zip", {"a.txt": b"signed words"})
    data = bytearray(signed.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    signature = b"PK\x05\x05" + struct.pack("<H", 3) + b"sig"
    data[eocd:eocd] = signature
    eocd = data.rfind(b"PK\x05\x06")
    size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    data[eocd + 12 : eocd + 16] = (size + len(signature)).to_bytes(4, "little")
    signed.write_bytes(data)

    record = extract_file(signed)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes


def test_an_office_container_with_a_hidden_second_directory_is_unreadable_without_text(tmp_path: Path) -> None:
    document = _terminal_second_directory(
        _zip(
            tmp_path / "hidden-directory.docx",
            {
                "[Content_Types].xml": b"<Types/>",
                "word/document.xml": b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>hidden office text</w:t></w:r></w:p></w:body></w:document>',
            },
        )
    )

    record = extract_file(document)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert not record.text
    assert "not accounted for" in " ".join(record.notes)


def test_an_unaccounted_region_overrides_a_too_large_directory_outcome(tmp_path: Path, monkeypatch) -> None:
    archive_path, _offset = _insert_before_directory(
        _zip(tmp_path / "too-large-unaccounted.zip", {"a.txt": b"larger than one byte"})
    )
    monkeypatch.setattr(extraction, "MAX_ARCHIVE_TEXT_BYTES", 1)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert "not accounted for" in " ".join(record.notes)
