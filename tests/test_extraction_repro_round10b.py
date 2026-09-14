"""Regression oracle for the earlier gating gap: the structural accounting must not be skipped when a member carries a layout error.

A decoy entry with a bad local-header offset inside the disguised one-entry directory must not switch the accounting off and let the
disguise extract its one real member while the hidden directory stays unnamed.
"""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path

from nous_os.extraction import ExtractionOutcome, extract_file


def _disguised_archive_with_a_decoy_member(tmp_path: Path) -> Path:
    """Real directory (a, b) hidden behind EOCD#1's comment; the terminal EOCD#2 names a copied directory of a plus a decoy whose local header offset is beyond the file."""
    archive_path = tmp_path / "decoy.zip"
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
    decoy = bytearray(first_entry)
    decoy[42:46] = (0xFFFFFFF0).to_bytes(4, "little")  # local header offset far beyond the file
    body = bytes(data[:eocd])
    copy_offset = len(body) + 22
    fake_directory = first_entry + bytes(decoy)
    eocd2 = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, 2, 2, len(fake_directory), copy_offset, 0)
    comment = fake_directory + eocd2
    eocd1 = bytes(data[eocd : eocd + 20]) + len(comment).to_bytes(2, "little")
    archive_path.write_bytes(body + eocd1 + comment)
    return archive_path


def test_a_decoy_layout_error_does_not_switch_the_structural_accounting_off(tmp_path: Path) -> None:
    archive_path = _disguised_archive_with_a_decoy_member(tmp_path)
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, [m.path for m in record.members], record.notes)
    assert not record.text, record.text
    note = " ".join(record.notes)
    assert "not accounted for" in note, record.notes
    assert "local header" in note.lower() or "beyond the file" in note.lower(), record.notes  # the decoy's own refusal stays named


def test_an_unlocatable_member_leaves_its_bytes_unaccounted_and_the_archive_is_refused_whole(tmp_path: Path) -> None:
    """A member whose local-header offset is forged: its real bytes are covered by nothing, so the archive is refused whole — named per member AND per gap; no sibling text."""
    archive_path = tmp_path / "forged.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("a.txt", b"alpha words " * 20)
        archive.writestr("b.txt", b"beta words " * 20)
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    cd_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    name_length = int.from_bytes(data[cd_offset + 28 : cd_offset + 30], "little")
    extra_length = int.from_bytes(data[cd_offset + 30 : cd_offset + 32], "little")
    comment_length = int.from_bytes(data[cd_offset + 32 : cd_offset + 34], "little")
    second = cd_offset + 46 + name_length + extra_length + comment_length
    data[second + 42 : second + 46] = (cd_offset + 3).to_bytes(4, "little")  # b's local header "inside the central directory"
    archive_path.write_bytes(data)
    record = extract_file(archive_path)
    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, [m.path for m in record.members], record.notes)
    assert not record.text
    note = " ".join(record.notes)
    assert "inside the central directory" in note, record.notes
    assert "not accounted for" in note, record.notes
