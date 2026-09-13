"""Archive members read by observed bytes, office parts that fail by name, and declarations detected outside CDATA."""
from __future__ import annotations

import zipfile
import zlib
from pathlib import Path

import pytest

from nous_os.extraction import ExtractionOutcome, Extractor, extract_file

MEMBER_CAP = 1 << 20  # the largest single decompression step the repaired reader may ask for (1 MiB)


def _zip(path: Path, entries: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> Path:
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _forge_central_directory_size(path: Path, member_name: str, size: int) -> Path:
    """Overwrite ONLY the central-directory uncompressed-size field of one member ."""
    data = bytearray(path.read_bytes())
    offset = 0
    encoded = member_name.encode("utf-8")
    while True:
        offset = data.find(b"PK\x01\x02", offset)
        assert offset >= 0, f"no central-directory entry for {member_name!r}"
        name_size = int.from_bytes(data[offset + 28 : offset + 30], "little")
        extra_size = int.from_bytes(data[offset + 30 : offset + 32], "little")
        comment_size = int.from_bytes(data[offset + 32 : offset + 34], "little")
        name_start = offset + 46
        if data[name_start : name_start + name_size] == encoded:
            data[offset + 24 : offset + 28] = size.to_bytes(4, "little")
            path.write_bytes(data)
            return path
        offset = name_start + name_size + extra_size + comment_size


# --- a forged central-directory size bypasses the archive gate; the member is then decompressed unbounded ----

@pytest.mark.parametrize("forged_size", [0, 100])
def test_a_member_whose_declared_size_is_forged_is_refused_with_bounded_decompression(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, forged_size: int) -> None:
    """members are read through a size-capped reader that never trusts the central directory; a member whose
    real size disagrees with its declaration is UNREADABLE (named), and no single decompression step exceeds MEMBER_CAP."""
    payload = b"0" * (8 * 1024 * 1024)  # 8 MiB that deflates to a few KiB
    archive = _forge_central_directory_size(_zip(tmp_path / "forged.zip", {"big.txt": payload}), "big.txt", forged_size)
    steps: list[int] = []
    real_decompressobj = zlib.decompressobj

    class Bounded:
        def __init__(self, *args, **kwargs):
            self._inner = real_decompressobj(*args, **kwargs)

        def decompress(self, data, max_length=0):
            steps.append(max_length)
            return self._inner.decompress(data, max_length)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(zlib, "decompressobj", Bounded)

    record = extract_file(archive)

    assert steps, "the member was never decompressed at all"
    assert max(steps) <= MEMBER_CAP, f"an unbounded decompression step was requested: {max(steps)}"
    assert record.extractor is Extractor.ARCHIVE_MEMBERS or record.outcome is ExtractionOutcome.UNREADABLE
    member = next((m for m in record.members if m.path == "big.txt"), None)
    assert member is not None
    assert member.outcome in {ExtractionOutcome.UNREADABLE, ExtractionOutcome.TOO_LARGE}, member.outcome
    assert any("big.txt" in note for note in record.notes), "the disagreement between declared and real size is not named"


def test_a_member_that_inflates_past_the_archive_bound_is_cut_at_the_bound(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """a member declared small (forged) but inflating beyond MAX_ARCHIVE_TEXT_BYTES stops at the bound, TOO_LARGE."""
    from nous_os import extraction

    payload = b"0" * (4 * 1024 * 1024)
    archive = _forge_central_directory_size(_zip(tmp_path / "forged2.zip", {"big.txt": payload}), "big.txt", 10)
    monkeypatch.setattr(extraction, "MAX_ARCHIVE_TEXT_BYTES", 1024 * 1024)
    produced: list[int] = []
    real_decompressobj = zlib.decompressobj

    class Counting:
        def __init__(self, *args, **kwargs):
            self._inner = real_decompressobj(*args, **kwargs)

        def decompress(self, data, max_length=0):
            out = self._inner.decompress(data, max_length)
            produced.append(len(out))
            return out

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(zlib, "decompressobj", Counting)

    record = extract_file(archive)

    member = next((m for m in record.members if m.path == "big.txt"), None)
    assert member is not None and member.outcome in {ExtractionOutcome.TOO_LARGE, ExtractionOutcome.UNREADABLE}
    assert sum(produced) <= 1024 * 1024 + MEMBER_CAP, f"inflated {sum(produced)} bytes past the bound"


# --- an office XML with an unknown encoding declaration raises LookupError ----------------------------------

def test_an_office_part_with_an_unknown_encoding_is_unreadable_not_an_exception(tmp_path: Path) -> None:
    """every office parse failure is a named UNREADABLE record; no exception escapes extract_file."""
    document = _zip(
        tmp_path / "encoding.docx",
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": (
                b'<?xml version="1.0" encoding="made-up-audit-encoding"?>'
                b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>'
            ),
        },
    )

    record = extract_file(document)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("LookupError" in note for note in record.notes)


# --- the declaration detector refuses safe CDATA / comment text ---------------------------------------------

def test_an_entity_like_string_inside_cdata_is_literal_text(tmp_path: Path) -> None:
    """declarations are detected outside CDATA sections and comments only; literal text is extracted."""
    document = _zip(
        tmp_path / "cdata.docx",
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": (
                b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r>'
                b'<w:t><![CDATA[<!ENTITY hidden "nope">]]></w:t>'
                b"</w:r></w:p><!-- <!DOCTYPE inside a comment> --></w:body></w:document>"
            ),
        },
    )

    record = extract_file(document)

    assert record.outcome is ExtractionOutcome.EXTRACTED, record.notes
    assert '<!ENTITY hidden "nope">' in record.text


def test_a_real_declaration_after_a_cdata_section_is_still_refused(tmp_path: Path) -> None:
    """a DOCTYPE outside CDATA is refused even when a CDATA section precedes it."""
    document = _zip(
        tmp_path / "mixed.docx",
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": (
                b'<!DOCTYPE document [<!ENTITY hidden "must-not-expand">]>'
                b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r>'
                b"<w:t><![CDATA[literal]]></w:t><w:t>&hidden;</w:t>"
                b"</w:r></w:p></w:body></w:document>"
            ),
        },
    )

    record = extract_file(document)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert "must-not-expand" not in record.text


def test_a_member_flagged_encrypted_is_unreadable_by_name(tmp_path: Path) -> None:
    """A member whose central-directory flag claims encryption is never inflated: UNREADABLE with the reason named."""
    archive = _zip(tmp_path / "flagged.zip", {"note.txt": b"plain words " * 50}, compression=zipfile.ZIP_STORED)
    data = bytearray(archive.read_bytes())
    offset = data.find(b"PK\x01\x02")
    assert offset >= 0
    data[offset + 8 : offset + 10] = (int.from_bytes(data[offset + 8 : offset + 10], "little") | 0x1).to_bytes(2, "little")
    archive.write_bytes(data)

    record = extract_file(archive)

    member = next(m for m in record.members if m.path == "note.txt")
    assert member.outcome is ExtractionOutcome.UNREADABLE
    assert any("encrypted" in note and "note.txt" in note for note in record.notes)
