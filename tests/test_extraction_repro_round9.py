"""Regression oracles for archive containers with more than one end-of-directory record, and for a directory that does not end at its record."""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path

import pytest

from nous_os.extraction import ExtractionOutcome, _archive_directory_declaration, extract_file
from tests.test_extraction_bounds import _zip


def _two_eocd_archive(tmp_path: Path) -> Path:
    """EOCD#1 (2 entries) whose comment holds a copy of member a's central entry followed by EOCD#2 (1 entry) — the last signature wins in the standard library."""
    archive_path = _zip(tmp_path / "two.zip", {"a.txt": b"alpha words " * 20, "b.txt": b"beta words " * 20})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    cd_size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    cd_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    first_entry_start = cd_offset
    # length of the first central entry
    name_len = int.from_bytes(data[first_entry_start + 28 : first_entry_start + 30], "little")
    extra_len = int.from_bytes(data[first_entry_start + 30 : first_entry_start + 32], "little")
    comment_len = int.from_bytes(data[first_entry_start + 32 : first_entry_start + 34], "little")
    first_len = 46 + name_len + extra_len + comment_len
    first_entry = bytes(data[first_entry_start : first_entry_start + first_len])
    eocd1 = bytes(data[eocd : eocd + 22])
    body = bytes(data[:eocd])
    copy_offset = len(body) + 22
    eocd2 = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, 1, 1, first_len, copy_offset, 0)
    comment = first_entry + eocd2 + b"xx"
    eocd1 = eocd1[:20] + len(comment).to_bytes(2, "little")
    archive_path.write_bytes(body + eocd1 + comment)
    return archive_path


def test_two_end_records_never_yield_a_partial_extraction(tmp_path: Path) -> None:
    record = extract_file(_two_eocd_archive(tmp_path))
    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, [m.path for m in record.members], record.notes)
    note = " ".join(record.notes).lower()
    assert "end of central directory" in note or "central directory" in note, record.notes


def test_a_directory_that_does_not_end_at_its_record_is_named_with_figures(tmp_path: Path) -> None:
    archive_path = _zip(tmp_path / "gap.zip", {"a.txt": b"alpha words " * 20})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    data[eocd:eocd] = b"JUNK"  # four bytes between the directory's declared end and the record
    archive_path.write_bytes(data)
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE
    note = " ".join(record.notes).lower()
    assert any(ch.isdigit() for ch in note) and ("end" in note or "record" in note), record.notes
    assert "bad magic" not in note and "bad offset" not in note, record.notes


def _two_eocd_archive_with_overrunning_second_comment(tmp_path: Path) -> Path:
    """As above, but EOCD#2 also declares its own comment reaching past the file — still refused, not silently accepted."""
    archive_path = _zip(tmp_path / "two-overrun.zip", {"a.txt": b"alpha words " * 20, "b.txt": b"beta words " * 20})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    cd_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    first_entry_start = cd_offset
    name_len = int.from_bytes(data[first_entry_start + 28 : first_entry_start + 30], "little")
    extra_len = int.from_bytes(data[first_entry_start + 30 : first_entry_start + 32], "little")
    comment_len = int.from_bytes(data[first_entry_start + 32 : first_entry_start + 34], "little")
    first_len = 46 + name_len + extra_len + comment_len
    first_entry = bytes(data[first_entry_start : first_entry_start + first_len])
    eocd1 = bytes(data[eocd : eocd + 22])
    body = bytes(data[:eocd])
    copy_offset = len(body) + 22
    # EOCD#2 declares a 50-byte comment of its own that the file does not have.
    eocd2 = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, 1, 1, first_len, copy_offset, 50)
    comment = first_entry + eocd2 + b"xx"
    eocd1 = eocd1[:20] + len(comment).to_bytes(2, "little")
    archive_path.write_bytes(body + eocd1 + comment)
    return archive_path


def test_two_end_records_with_an_overrunning_second_comment_are_still_refused(tmp_path: Path) -> None:
    record = extract_file(_two_eocd_archive_with_overrunning_second_comment(tmp_path))
    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, [m.path for m in record.members], record.notes)
    note = " ".join(record.notes).lower()
    assert "central directory" in note, record.notes


def _fake_central_entry(*, name_length: int = 0, extra_length: int = 0, comment_length: int = 0) -> bytes:
    """A minimal, otherwise-valid 46-byte central-directory entry with no real name/extra/comment bytes."""
    entry = bytearray(46)
    entry[0:4] = b"PK\x01\x02"
    entry[28:30] = name_length.to_bytes(2, "little")
    entry[30:32] = extra_length.to_bytes(2, "little")
    entry[32:34] = comment_length.to_bytes(2, "little")
    return bytes(entry)


def _fake_eocd(*, entries_this_disk: int, entries_total: int, cd_size: int, cd_offset: int, comment_length: int = 0) -> bytes:
    return b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, entries_this_disk, entries_total, cd_size, cd_offset, comment_length)


def test_the_comment_overrun_check_is_pinned_with_figures() -> None:
    central = _fake_central_entry()
    eocd = _fake_eocd(entries_this_disk=1, entries_total=1, cd_size=len(central), cd_offset=0, comment_length=20)
    data = central + eocd  # declares 20 bytes of comment that the file does not carry

    with pytest.raises(zipfile.BadZipFile) as excinfo:
        _archive_directory_declaration(data)

    message = str(excinfo.value)
    assert "20" in message and str(len(data)) in message
    assert "comment" in message.lower() and "overrun" in message.lower()


def test_the_cd_size_vs_found_check_is_pinned_with_figures() -> None:
    # A lying name-length field on the first entry makes the physical scan land inside the
    # second entry's own header, short-circuiting the central-directory walk before its declared size.
    entry_one = _fake_central_entry(name_length=3)
    entry_two = _fake_central_entry()
    central = entry_one + entry_two
    eocd = _fake_eocd(entries_this_disk=2, entries_total=2, cd_size=len(central), cd_offset=0)
    data = central + eocd

    with pytest.raises(zipfile.BadZipFile) as excinfo:
        _archive_directory_declaration(data)

    message = str(excinfo.value)
    assert str(len(central)) in message and "49" in message
    assert "central directory size" in message.lower()


def test_the_cd_offset_bound_check_is_pinned_with_figures() -> None:
    central = _fake_central_entry()
    forged_offset = 9999
    eocd = _fake_eocd(entries_this_disk=1, entries_total=1, cd_size=len(central), cd_offset=forged_offset)
    data = central + eocd

    with pytest.raises(zipfile.BadZipFile) as excinfo:
        _archive_directory_declaration(data)

    message = str(excinfo.value)
    assert str(forged_offset) in message and str(len(data)) in message
    assert "central directory offset" in message.lower()


def test_the_zip64_required_check_is_pinned_with_figures() -> None:
    # Exactly 0xFFFF entries, genuinely present, with no ZIP64 record: the sentinel must still be refused.
    entry_count = 0xFFFF
    central = _fake_central_entry() * entry_count
    eocd = _fake_eocd(entries_this_disk=entry_count, entries_total=entry_count, cd_size=len(central), cd_offset=0)
    data = central + eocd

    with pytest.raises(zipfile.BadZipFile) as excinfo:
        _archive_directory_declaration(data)

    message = str(excinfo.value)
    assert "ZIP64" in message and "requires" in message.lower()


def test_the_zip64_record_offset_bound_check_is_pinned_with_figures() -> None:
    central = _fake_central_entry()
    forged_record_offset = 10**9
    locator = b"PK\x06\x07" + struct.pack("<IQI", 0, forged_record_offset, 0)
    eocd = _fake_eocd(entries_this_disk=1, entries_total=1, cd_size=len(central), cd_offset=0)
    data = central + locator + eocd

    with pytest.raises(zipfile.BadZipFile) as excinfo:
        _archive_directory_declaration(data)

    message = str(excinfo.value)
    assert str(forged_record_offset) in message and str(len(data)) in message
    assert "ZIP64" in message and "beyond the file" in message
    assert "overruns" not in message


def test_a_local_header_offset_inside_the_central_directory_is_named_and_gap_refuses_the_archive(tmp_path: Path) -> None:
    """Whole-file accounting changes this former partial extraction into a whole refusal."""
    archive_path = _zip(tmp_path / "insidecd.zip", {"a.txt": b"alpha words " * 20, "b.txt": b"beta words " * 20})
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    cd_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    offsets, offset = [], cd_offset
    while offset < eocd:
        offsets.append(offset)
        name_len = int.from_bytes(data[offset + 28 : offset + 30], "little")
        extra_len = int.from_bytes(data[offset + 30 : offset + 32], "little")
        comment_len = int.from_bytes(data[offset + 32 : offset + 34], "little")
        offset = offset + 46 + name_len + extra_len + comment_len
    second_entry = offsets[1]
    forged_header_offset = cd_offset + 10  # inside the central directory
    data[second_entry + 42 : second_entry + 46] = forged_header_offset.to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert not record.text
    assert not any(member.outcome is ExtractionOutcome.EXTRACTED for member in record.members), record.members
    note = next(n for n in record.notes if "b.txt" in n)
    assert "inside the central directory" in note.lower()
    assert str(forged_header_offset) in note and str(cd_offset) in note, note
    assert "not accounted for" in " ".join(record.notes), record.notes
