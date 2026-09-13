"""Regression oracles for archive container declarations: entry counts, the central-directory offset, and the failed class of a compound refusal."""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path

from nous_os.extraction import ExtractionOutcome, extract_file
from tests.test_extraction_bounds import _central, _zip


def test_f7a_an_eocd_entry_count_that_disagrees_with_the_directory_is_named(tmp_path: Path) -> None:
    """EOCD says 65,535 entries (no ZIP64 locator); the directory holds one: a named refusal citing both figures, not a silent one-member extraction."""
    archive_path = _zip(tmp_path / "count.zip", {"note.txt": b"checked words " * 50})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    data[eocd + 8 : eocd + 10] = b"\xff\xff"   # entries on this disk
    data[eocd + 10 : eocd + 12] = b"\xff\xff"  # total entries
    archive_path.write_bytes(data)
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.outcome
    note = " ".join(record.notes).lower()
    assert "65535" in note and ("1" in note) and ("entr" in note or "count" in note), record.notes


def test_f7b_a_central_directory_offset_beyond_the_file_is_named_as_declared(tmp_path: Path) -> None:
    """EOCD declares the central directory one byte past EOF: the refusal names the declared directory offset against the file size, not a derived negative local offset."""
    archive_path = _zip(tmp_path / "cd.zip", {"note.txt": b"checked words " * 50})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    file_size = len(data)
    data[eocd + 16 : eocd + 20] = (file_size + 1).to_bytes(4, "little")
    archive_path.write_bytes(data)
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, record.outcome
    note = " ".join(record.notes).lower()
    assert str(file_size + 1) in note and str(file_size) in note and ("central directory" in note or "directory offset" in note), record.notes
    assert "-" not in note.replace("not executable", "").split("offset")[-1][:8] or "declared" in note, record.notes


def test_f7c_the_encrypted_early_forged_crc_note_carries_the_failed_class_with_figures(tmp_path: Path) -> None:
    """An encrypted member that also ends early with a forged CRC: the sizes check ran and FAILED (figures kept); the CRC check is NOT EXECUTABLE (encrypted)."""
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
    data[c + 8 : c + 10] = (int.from_bytes(data[c + 8 : c + 10], "little") | 0x1).to_bytes(2, "little")
    data[header + 6 : header + 8] = (int.from_bytes(data[header + 6 : header + 8], "little") | 0x1).to_bytes(2, "little")
    data[c + 20 : c + 24] = (info.compress_size + 4).to_bytes(4, "little")
    forged_crc = 0x0BADF00D
    data[c + 16 : c + 20] = forged_crc.to_bytes(4, "little")
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[eocd + 16 : eocd + 20] = (directory_offset + 4).to_bytes(4, "little")
    archive_path.write_bytes(data)
    record = extract_file(archive_path)
    member = next(m for m in record.members if m.path == "stream.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    note = next(n for n in record.notes if "stream.txt" in n)
    lowered = note.lower()
    assert "failed" in lowered, note
    assert "not executable" in lowered, note
    assert f"{forged_crc:08x}" in lowered or str(forged_crc) in lowered, note
