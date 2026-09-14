"""Every offset and size checked against the file before a seek, and refusal notes that separate completed, failed and not-executable checks."""
from __future__ import annotations

import io
import struct
import zipfile
from pathlib import Path

import pytest

from nous_os.extraction import ExtractionOutcome, _archive_member_layout_errors, extract_file


def _zip(path: Path, entries: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> Path:
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _central(data: bytearray) -> int:
    offset = data.find(b"PK\x01\x02")
    assert offset >= 0
    return offset


def _with_zip64_offset(data: bytearray, offset_value: int) -> bytearray:
    c = _central(data)
    name_len = int.from_bytes(data[c + 28 : c + 30], "little")
    extra = struct.pack("<HHQ", 0x0001, 8, offset_value)
    data[c + 30 : c + 32] = len(extra).to_bytes(2, "little")
    data[c + 42 : c + 46] = b"\xff\xff\xff\xff"
    data[c + 46 + name_len : c + 46 + name_len] = extra
    eocd = data.rfind(b"PK\x05\x06")
    cd_size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    data[eocd + 12 : eocd + 16] = (cd_size + len(extra)).to_bytes(4, "little")
    return data


@pytest.mark.parametrize("offset_value", [2**64 - 1, 2**63, 10**12])
def test_an_absurd_zip64_local_offset_is_unreadable_not_an_exception(tmp_path: Path, offset_value: int) -> None:
    """Whole-file accounting changes the former partial outcome into a whole refusal; offsets are still checked before any seek and nothing raises."""
    archive_path = _zip(tmp_path / "z64.zip", {"a.txt": b"hello words"})
    archive_path.write_bytes(_with_zip64_offset(bytearray(archive_path.read_bytes()), offset_value))

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert not record.text
    assert not any(member.outcome is ExtractionOutcome.EXTRACTED for member in record.members), record.members
    assert any("offset" in note.lower() and "a.txt" in note for note in record.notes), record.notes
    assert "not accounted for" in " ".join(record.notes), record.notes


def test_a_compressed_size_beyond_the_file_is_refused_before_any_read(tmp_path: Path) -> None:
    """Whole-file accounting changes the former member-only refusal into a whole refusal without reading the forged region."""
    archive_path = _zip(tmp_path / "beyond.zip", {"a.txt": b"hello words"})
    data = bytearray(archive_path.read_bytes())
    c = _central(data)
    data[c + 20 : c + 24] = (2**32 - 2).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert not record.text
    assert not any(candidate.outcome is ExtractionOutcome.EXTRACTED for candidate in record.members), record.members
    member = next(m for m in record.members if m.path == "a.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("a.txt" in note and ("size" in note.lower() or "region" in note.lower()) for note in record.notes), record.notes
    assert "not accounted for" in " ".join(record.notes), record.notes


def test_an_encrypted_member_that_also_ends_early_names_the_checks_it_could_not_run(tmp_path: Path) -> None:
    """The note distinguishes checks completed, failed and not executable."""
    archive_path = _zip(tmp_path / "enc.zip", {"stream.txt": b"x" * 1000}, compression=zipfile.ZIP_DEFLATED)
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("stream.txt")
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    extra_length = int.from_bytes(data[header + 28 : header + 30], "little")
    data_end = header + 30 + name_length + extra_length + info.compress_size
    data[data_end:data_end] = b"JUNK"
    c = _central(data)
    data[c + 8 : c + 10] = (int.from_bytes(data[c + 8 : c + 10], "little") | 0x1).to_bytes(2, "little")  # encrypted flag, central
    data[header + 6 : header + 8] = (int.from_bytes(data[header + 6 : header + 8], "little") | 0x1).to_bytes(2, "little")  # and local
    data[c + 20 : c + 24] = (info.compress_size + 4).to_bytes(4, "little")
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[eocd + 16 : eocd + 20] = (directory_offset + 4).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "stream.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    note = next(n for n in record.notes if "stream.txt" in n)
    lowered = note.lower()
    assert "encrypted" in lowered
    assert "not executable" in lowered or "not checked" in lowered, note
    assert "crc" in lowered and "size" in lowered, note


def test_a_refused_member_note_separates_completed_failed_and_not_executable_checks(tmp_path: Path) -> None:
    """A stored member with a wrong CRC and a wrong declared size: sizes/CRC ran and failed; nothing was left unrun."""
    archive_path = _zip(tmp_path / "failed.zip", {"note.txt": b"checked words " * 50})
    data = bytearray(archive_path.read_bytes())
    c = _central(data)
    data[c + 16 : c + 20] = (0x12345678).to_bytes(4, "little")
    data[c + 24 : c + 28] = (5).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    note = next(n for n in record.notes if "note.txt" in n)
    lowered = note.lower()
    assert "failed" in lowered and "crc" in lowered and "size" in lowered, note
    assert "not executable" not in lowered and "not checked" not in lowered, note


def _single_member_layout(data: bytes, *, directory_start: int | None = None) -> tuple[zipfile.ZipInfo, tuple[str, ...]]:
    """Run the file-layout gate directly, before any member reader can mask a bound."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.infolist()[0]
        reasons = _archive_member_layout_errors(
            archive,
            len(data),
            archive.start_dir if directory_start is None else directory_start,
        )
        return info, reasons[0]


def test_file_bound_local_header_offset_is_checked_directly(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "header-bound.zip", {"a.txt": b"checked words"})
    data = archive_path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        archive.infolist()[0].header_offset = len(data) + 1
        reasons = _archive_member_layout_errors(archive, len(data), archive.start_dir)[0]

    note = " ".join(reasons)
    assert "failed: local header offset" in note
    assert str(len(data) + 1) in note and str(len(data)) in note


def test_file_bound_data_start_is_checked_directly(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "start-bound.zip", {"a.txt": b"checked words"})
    data = bytearray(archive_path.read_bytes())
    data[26:28] = (0xFFFF).to_bytes(2, "little")

    _info, reasons = _single_member_layout(bytes(data))

    note = " ".join(reasons)
    assert "failed: data start" in note
    assert "beyond the file" in note


def test_file_bound_data_end_is_checked_directly(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "end-bound.zip", {"a.txt": b"checked words"})
    data = archive_path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.infolist()[0]
        data_start = info.header_offset + zipfile.sizeFileHeader + len(info.filename)
        info.compress_size = len(data) - data_start + 1
        reasons = _archive_member_layout_errors(archive, len(data), archive.start_dir)[0]

    note = " ".join(reasons)
    assert "failed: data end" in note
    assert str(len(data) + 1) in note and str(len(data)) in note


def test_file_bound_central_directory_start_is_checked_directly(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "directory-bound.zip", {"a.txt": b"checked words"})
    data = archive_path.read_bytes()

    _info, reasons = _single_member_layout(data, directory_start=len(data) + 1)

    note = " ".join(reasons)
    assert "failed: central directory start" in note
    assert str(len(data) + 1) in note and str(len(data)) in note
