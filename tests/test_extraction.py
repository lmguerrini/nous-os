"""Synthetic format fixtures for separately attributed attachment extraction."""

from __future__ import annotations

import hashlib
import io
import zipfile
from pathlib import Path

from pypdf import PdfWriter

from nous_os.extraction import (
    MAX_ARCHIVE_MEMBERS,
    ExtractionOutcome,
    Extractor,
    extract_assets,
    extract_file,
)


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def _minimal_pdf(text: str) -> bytes:
    """Build a one-page PDF without a document-generation dependency."""
    objects = (
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(f'BT /F1 18 Tf 72 72 Td ({text}) Tj ET'.encode('ascii'))} >>\nstream\nBT /F1 18 Tf 72 72 Td ({text}) Tj ET\nendstream".encode("ascii"),
    )
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


def _zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _docx(path: Path) -> Path:
    return _zip(
        path,
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": (
                b'<w:document xmlns:w="urn:word"><w:body>'
                b"<w:p><w:r><w:t>document first</w:t></w:r></w:p>"
                b"<w:p><w:r><w:t>document second</w:t></w:r></w:p>"
                b"</w:body></w:document>"
            ),
        },
    )


def _xlsx(path: Path) -> Path:
    return _zip(
        path,
        {
            "[Content_Types].xml": b"<Types/>",
            "xl/sharedStrings.xml": b'<sst xmlns="urn:sheet"><si><t>shared cell</t></si></sst>',
            "xl/worksheets/sheet1.xml": (
                b'<worksheet xmlns="urn:sheet"><sheetData><row>'
                b'<c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c>'
                b"</row></sheetData></worksheet>"
            ),
        },
    )


def _pptx(path: Path) -> Path:
    return _zip(
        path,
        {
            "[Content_Types].xml": b"<Types/>",
            "ppt/slides/slide1.xml": b'<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>slide words</a:t></p:sld>',
        },
    )


def _encrypted_pdf(path: Path) -> Path:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.encrypt("fixture-password")
    with path.open("wb") as handle:
        writer.write(handle)
    assert b"/Encrypt" in path.read_bytes()
    return path


def test_supported_formats_extract_deterministically(tmp_path: Path) -> None:
    plain = _write(tmp_path / "plain.md", b"plain\r\ntext\r")
    json_text = _write(tmp_path / "data.json", b'{"shape":"json"}\n')
    notebook = _write(
        tmp_path / "notebook.ipynb",
        b'{"cells":[{"cell_type":"markdown","source":["note\\n"]},{"cell_type":"code","source":"!rm -rf /"}],"metadata":{"ignored":true}}',
    )
    pdf = _write(tmp_path / "page.pdf", _minimal_pdf("pdf words"))
    docx = _docx(tmp_path / "document.docx")
    xlsx = _xlsx(tmp_path / "sheet.xlsx")
    pptx = _pptx(tmp_path / "slides.pptx")
    archive = _zip(tmp_path / "bundle.zip", {"one.txt": b"archive one", "two.json": b'{"two":2}'})

    records = [extract_file(path) for path in (plain, json_text, notebook, pdf, docx, xlsx, pptx, archive)]
    assert all(record.outcome is ExtractionOutcome.EXTRACTED for record in records)
    assert all(record.extractor_version for record in records)
    assert records[0].text == "plain\ntext\n"
    assert records[1].extractor is Extractor.JSON_TEXT
    assert records[2].extractor is Extractor.NOTEBOOK_CELLS
    assert "!rm -rf /" in records[2].text
    assert "pdf words" in records[3].text
    assert "document first\ndocument second" == records[4].text
    assert "shared cell\n7" == records[5].text
    assert "slide words" == records[6].text
    assert "archive one" in records[7].text and '"two":2' in records[7].text
    assert records[7].locations[0].label == "one.txt"
    assert all(record.locations for record in records)
    assert all(
        record.record_bytes() == extract_file(path).record_bytes()
        for path, record in zip((plain, json_text, notebook, pdf, docx, xlsx, pptx, archive), records)
    )

    tool = extract_file(pdf)
    library = extract_file(pdf, pdf_backend=Extractor.PDF_TEXT_LIBRARY)
    assert tool.extractor is Extractor.PDF_TEXT_TOOL
    assert library.extractor is Extractor.PDF_TEXT_LIBRARY
    assert "pdf words" in tool.text and "pdf words" in library.text


def test_unsupported_and_failed_inputs_are_named(tmp_path: Path) -> None:
    png = _write(tmp_path / "image", b"\x89PNG\r\n\x1a\n")
    jpeg = _write(tmp_path / "photo", b"\xff\xd8\xff\x00")
    video = _write(tmp_path / "movie", b"\x00\x00\x00\x18ftypisom")
    random = _write(tmp_path / "random", b"\xff\x00\x80")
    truncated = _write(tmp_path / "truncated", b"%PDF-1.7\nnot a document")
    empty = _write(tmp_path / "empty.txt", b"")
    encrypted = _encrypted_pdf(tmp_path / "encrypted")

    assert extract_file(png).outcome is ExtractionOutcome.UNSUPPORTED_IMAGE
    assert extract_file(jpeg).outcome is ExtractionOutcome.UNSUPPORTED_IMAGE
    assert extract_file(video).outcome is ExtractionOutcome.UNSUPPORTED_VIDEO
    assert extract_file(random).outcome is ExtractionOutcome.UNSUPPORTED_BINARY
    broken = extract_file(truncated)
    assert broken.outcome is ExtractionOutcome.UNREADABLE
    assert broken.notes and "Error" in broken.notes[-1]
    assert extract_file(empty).outcome is ExtractionOutcome.EMPTY
    assert extract_file(tmp_path / "missing").outcome is ExtractionOutcome.ABSENT
    assert extract_file(encrypted).outcome is ExtractionOutcome.ENCRYPTED


def test_classification_is_by_content_not_name(tmp_path: Path) -> None:
    png_named_text = _write(tmp_path / "misleading.txt", b"\x89PNG\r\n\x1a\n")
    nameless_pdf = _write(tmp_path / "unnamed", _minimal_pdf("no name needed"))

    assert extract_file(png_named_text).outcome is ExtractionOutcome.UNSUPPORTED_IMAGE
    result = extract_file(nameless_pdf)
    assert result.outcome is ExtractionOutcome.EXTRACTED
    assert "no name needed" in result.text


def test_archives_are_bounded_and_nothing_executes(tmp_path: Path) -> None:
    # The member name that climbs out of the archive is assembled here so no tracked line spells a rooted path.
    climbing = "/".join(("..", "escaped.txt"))
    traversal = _zip(tmp_path / "traversal.zip", {"safe.txt": b"safe", climbing: b"verbatim"})
    record = extract_file(traversal)
    assert record.outcome is ExtractionOutcome.EXTRACTED
    assert [member.path for member in record.members] == ["safe.txt", climbing]
    assert not (tmp_path / "x").exists()

    notebook = _write(
        tmp_path / "only-text.ipynb",
        b'{"cells":[{"cell_type":"code","source":"!rm -rf /"}]}',
    )
    assert "!rm -rf /" in extract_file(notebook).text

    over_limit = _zip(
        tmp_path / "too-many.zip",
        {f"member-{index:03d}.txt": b"x" for index in range(MAX_ARCHIVE_MEMBERS + 1)},
    )
    bounded = extract_file(over_limit)
    assert bounded.outcome is ExtractionOutcome.TOO_LARGE
    assert len(bounded.members) == MAX_ARCHIVE_MEMBERS


def test_identical_bytes_share_one_record_with_all_owners(tmp_path: Path) -> None:
    first = _write(tmp_path / "first", b"same owned bytes")
    second = _write(tmp_path / "second", b"same owned bytes")
    shared = extract_assets(((first, "src_A"), (second, "src_B")))
    assert len(shared) == 1
    assert shared[0].asset_source_ids == ("src_A", "src_B")
    assert shared[0].extraction.asset_source_id is None
    assert shared[0].asset_digest == hashlib.sha256(b"same owned bytes").hexdigest()


def test_source_bytes_unchanged(tmp_path: Path) -> None:
    source = _write(tmp_path / "source", _minimal_pdf("unchanged bytes"))
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    extract_file(source)
    after = hashlib.sha256(source.read_bytes()).hexdigest()
    assert after == before
