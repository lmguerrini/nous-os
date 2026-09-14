"""Archive directory failures named, refusal notes complete, and the layout preflight ahead of the size bound."""
from __future__ import annotations

import zipfile
import zlib
from pathlib import Path

from nous_os.extraction import ExtractionOutcome, Extractor, extract_file


def _zip(path: Path, entries: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> Path:
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _central_entries(data: bytearray) -> list[int]:
    offsets, offset = [], 0
    while True:
        offset = data.find(b"PK\x01\x02", offset)
        if offset < 0:
            return offsets
        offsets.append(offset)
        name_size = int.from_bytes(data[offset + 28 : offset + 30], "little")
        extra_size = int.from_bytes(data[offset + 30 : offset + 32], "little")
        comment_size = int.from_bytes(data[offset + 32 : offset + 34], "little")
        offset = offset + 46 + name_size + extra_size + comment_size


def _local_header(data: bytearray, info: zipfile.ZipInfo) -> tuple[int, int, int]:
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    extra_length = int.from_bytes(data[header + 28 : header + 30], "little")
    return header, name_length, extra_length


# ------------------------------------------------------------

def test_a_central_name_that_is_not_valid_utf8_is_unreadable_not_an_exception(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "badname.zip", {"note.txt": b"named words " * 20}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive_path.read_bytes())
    offset = _central_entries(data)[0]
    data[offset + 8 : offset + 10] = (int.from_bytes(data[offset + 8 : offset + 10], "little") | 0x800).to_bytes(2, "little")
    data[offset + 46] = 0xFF
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("UnicodeDecodeError" in note or "name" in note.lower() for note in record.notes), record.notes


# ------------------------------------------------------------

def test_an_early_ending_stream_names_the_checks_it_could_not_run(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "compound.zip", {"a.txt": b"x" * 1000})
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("a.txt")
    header, name_length, extra_length = _local_header(data, info)
    data_end = header + 30 + name_length + extra_length + info.compress_size
    data[data_end:data_end] = b"JUNK"
    central = _central_entries(data)[0]
    data[central + 16 : central + 20] = (0x12345678).to_bytes(4, "little")  # forged CRC
    data[central + 20 : central + 24] = (info.compress_size + 4).to_bytes(4, "little")
    data[central + 24 : central + 28] = (1001).to_bytes(4, "little")  # forged uncompressed size
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[eocd + 16 : eocd + 20] = (directory_offset + 4).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "a.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    note = next(n for n in record.notes if "a.txt" in n)
    assert str(info.compress_size + 4) in note and "CRC" in note.upper() and "1001" in note, note


# ------------------------------------------------------------

def test_a_shared_local_header_is_named_even_when_a_forged_size_trips_the_bound(tmp_path: Path) -> None:
    """Whole-file accounting changes this former partial/bounded outcome into a whole refusal."""
    import warnings

    archive_path = tmp_path / "shared-large.zip"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("same.txt", b"overlap")
            archive.writestr("same.txt", b"overlap")
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        first = archive.infolist()[0]
    entries = _central_entries(data)
    for offset in entries:
        data[offset + 42 : offset + 46] = first.header_offset.to_bytes(4, "little")
    data[entries[1] + 24 : entries[1] + 28] = (21 * 1024 * 1024).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert not record.text
    assert not any(member.outcome is ExtractionOutcome.EXTRACTED for member in record.members), record.members
    assert any("local header" in note for note in record.notes), record.notes
    assert "not accounted for" in " ".join(record.notes), record.notes


# ------------------------------------------------------------

def test_a_local_method_that_disagrees_with_the_directory_is_refused(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "method.zip", {"normal.txt": b"normal words " * 100}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("normal.txt")
    header, _, _ = _local_header(data, info)
    data[header + 8 : header + 10] = (8).to_bytes(2, "little")  # local says deflated; central says stored
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "normal.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("method" in note for note in record.notes), record.notes


def test_a_local_name_that_disagrees_with_the_directory_is_refused(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "name.zip", {"normal.txt": b"normal words " * 100}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("normal.txt")
    header, name_length, _ = _local_header(data, info)
    data[header + 30] = ord("m")  # "mormal.txt" locally, same length
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "normal.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("name" in note for note in record.notes), record.notes


def test_an_office_part_whose_region_overlaps_another_part_is_refused(tmp_path: Path) -> None:
    document = _zip(
        tmp_path / "overlap.docx",
        {"[Content_Types].xml": b"<Types/>", "word/document.xml": b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>words</w:t></w:r></w:p></w:body></w:document>'},
        compression=zipfile.ZIP_STORED,
    )
    data = bytearray(document.read_bytes())
    with zipfile.ZipFile(document) as archive:
        types = archive.getinfo("[Content_Types].xml")
    central = _central_entries(data)[0]
    data[central + 20 : central + 24] = (types.compress_size + 1).to_bytes(4, "little")  # one byte into the next local header
    data[central + 24 : central + 28] = (types.file_size + 1).to_bytes(4, "little")
    document.write_bytes(data)

    record = extract_file(document)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("overlap" in note.lower() or "exceeds" in note for note in record.notes), record.notes
