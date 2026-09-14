"""One central entry per local header, and every early-ending deflate stream named with its figures."""
from __future__ import annotations

import zipfile
import zlib
from pathlib import Path

from nous_os.extraction import ExtractionOutcome, extract_file


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


def test_central_entries_sharing_one_local_header_are_refused(tmp_path: Path) -> None:
    """Whole-file accounting changes this former partial outcome into a whole refusal when the unverified members leave gaps."""
    import warnings

    archive_path = tmp_path / "overlap.zip"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # duplicate names are legal in the format and the point of this input
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for _ in range(200):
                archive.writestr("same.txt", b"overlap")
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        first = archive.infolist()[0]
    for offset in _central_entries(data):
        data[offset + 42 : offset + 46] = first.header_offset.to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, record.notes
    assert not record.text
    assert not any(member.outcome is ExtractionOutcome.EXTRACTED for member in record.members), record.members
    assert any(
        "same.txt" in note and ("local header" in note or "overlap" in note.lower())
        for note in record.notes
    ), record.notes
    assert "not accounted for" in " ".join(record.notes), record.notes


def test_an_alias_of_a_verified_member_refuses_the_archive_whole(tmp_path: Path) -> None:
    """A second central entry aliasing the first entry's local header: both entries are refused (R98) and, under the earlier
    whole-file accounting, the shared local record is then covered by nothing, so the archive is refused whole — named per member and per gap."""
    archive_path = _zip(tmp_path / "aliased-header.zip", {"a.txt": b"alpha words"}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive_path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    entry = bytearray(data[directory_offset:eocd])
    assert entry[46:51] == b"a.txt"
    entry[46:51] = b"b.txt"
    data[eocd:eocd] = entry
    eocd = data.rfind(b"PK\x05\x06")
    data[eocd + 8 : eocd + 10] = (2).to_bytes(2, "little")
    data[eocd + 10 : eocd + 12] = (2).to_bytes(2, "little")
    data[eocd + 12 : eocd + 16] = (len(entry) * 2).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    assert record.outcome is ExtractionOutcome.UNREADABLE, (record.outcome, record.notes)
    assert not record.text
    assert not any(member.outcome is ExtractionOutcome.EXTRACTED for member in record.members), record.members
    assert any("a.txt" in note and "local header" in note.lower() for note in record.notes), record.notes
    assert any("b.txt" in note and "local header" in note.lower() for note in record.notes), record.notes
    assert "not accounted for" in " ".join(record.notes), record.notes


def test_junk_after_a_deflate_stream_inside_its_declared_region_is_refused_with_figures(tmp_path: Path) -> None:
    """A stream that ends four bytes before its declared compressed size: refused, and the note names both figures."""
    archive_path = _zip(tmp_path / "junk.zip", {"deflate.txt": b"deflated words " * 200})
    data = bytearray(archive_path.read_bytes())
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo("deflate.txt")
    header = info.header_offset
    name_length = int.from_bytes(data[header + 26 : header + 28], "little")
    extra_length = int.from_bytes(data[header + 28 : header + 30], "little")
    data_end = header + 30 + name_length + extra_length + info.compress_size
    data[data_end:data_end] = b"JUNK"  # inside the region once the declared size grows by four
    central = _central_entries(data)[0]
    data[central + 20 : central + 24] = (info.compress_size + 4).to_bytes(4, "little")
    eocd = data.rfind(b"PK\x05\x06")
    directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    data[eocd + 16 : eocd + 20] = (directory_offset + 4).to_bytes(4, "little")
    archive_path.write_bytes(data)

    record = extract_file(archive_path)

    member = next(m for m in record.members if m.path == "deflate.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    note = next((n for n in record.notes if "deflate.txt" in n), "")
    assert str(info.compress_size + 4) in note and str(info.compress_size) in note, note
