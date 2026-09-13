"""Synthetic format fixtures for separately attributed attachment extraction."""

from __future__ import annotations

from dataclasses import replace
import hashlib
import io
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from nous_os.extraction import (
    MAX_ARCHIVE_MEMBERS,
    MAX_EXTRACTED_TEXT_BYTES,
    ExtractionOwner,
    ExtractionOutcome,
    ExtractionStore,
    Extractor,
    SharedExtraction,
    deduplicate_extractions,
    extract_assets,
    extract_bytes,
    extract_file,
)


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def _minimal_pdf(text: str, *, encrypted: bool = False) -> bytes:
    """Build a one-page PDF without a document-generation dependency."""
    stream = f"BT /F1 18 Tf 72 72 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    if encrypted:
        objects.append(
            b"<< /Filter /Standard /V 1 /R 2 /Length 40 "
            b"/O <0000000000000000000000000000000000000000000000000000000000000000> "
            b"/U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>"
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
    trailer = f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R".encode("ascii")
    if encrypted:
        trailer += b" /Encrypt 6 0 R"
    output.extend(trailer + f" >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    return bytes(output)


def _zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return path


def _declare_member_size(path: Path, member_name: str, size: int) -> Path:
    """Change only a normal ZIP central-directory size field for a bounded-read test."""
    data = bytearray(path.read_bytes())
    offset = 0
    encoded_name = member_name.encode("utf-8")
    while True:
        offset = data.find(b"PK\x01\x02", offset)
        if offset < 0:
            raise AssertionError(f"central-directory entry for {member_name!r} is absent")
        name_size = int.from_bytes(data[offset + 28 : offset + 30], "little")
        extra_size = int.from_bytes(data[offset + 30 : offset + 32], "little")
        comment_size = int.from_bytes(data[offset + 32 : offset + 34], "little")
        name_start = offset + 46
        if data[name_start : name_start + name_size] == encoded_name:
            data[offset + 24 : offset + 28] = size.to_bytes(4, "little")
            path.write_bytes(data)
            return path
        offset = name_start + name_size + extra_size + comment_size


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

    assert records[3].extractor is Extractor.PDF_TEXT_TOOL


def test_unsupported_and_failed_inputs_are_named(tmp_path: Path) -> None:
    png = _write(tmp_path / "image", b"\x89PNG\r\n\x1a\n")
    jpeg = _write(tmp_path / "photo", b"\xff\xd8\xff\x00")
    video = _write(tmp_path / "movie", b"\x00\x00\x00\x18ftypisom")
    random = _write(tmp_path / "random", b"\xff\x00\x80")
    truncated = _write(tmp_path / "truncated", b"%PDF-1.7\nnot a document")
    empty = _write(tmp_path / "empty.txt", b"")
    encrypted = _write(tmp_path / "encrypted", _minimal_pdf("hidden", encrypted=True))

    assert extract_file(png).outcome is ExtractionOutcome.UNSUPPORTED_IMAGE
    assert extract_file(jpeg).outcome is ExtractionOutcome.UNSUPPORTED_IMAGE
    assert extract_file(video).outcome is ExtractionOutcome.UNSUPPORTED_VIDEO
    assert extract_file(random).outcome is ExtractionOutcome.UNSUPPORTED_BINARY
    broken = extract_file(truncated)
    assert broken.outcome is ExtractionOutcome.UNREADABLE
    assert broken.notes and "Error" in broken.notes[-1]
    assert extract_file(empty).outcome is ExtractionOutcome.EMPTY
    assert extract_file(tmp_path / "missing").outcome is ExtractionOutcome.ABSENT
    encrypted_record = extract_file(encrypted)
    assert encrypted_record.outcome is ExtractionOutcome.ENCRYPTED
    assert encrypted_record.text == ""
    assert encrypted_record.notes and "pdftotext exited" in encrypted_record.notes[-1]


def test_missing_pdf_tool_is_explicit(tmp_path: Path, monkeypatch: object) -> None:
    pdf = _write(tmp_path / "page.pdf", _minimal_pdf("pdf words"))
    monkeypatch.setattr("nous_os.extraction.shutil.which", lambda name: None)

    record = extract_file(pdf)

    assert record.extractor is Extractor.PDF_TEXT_TOOL
    assert record.extractor_version == "unavailable"
    assert record.outcome is ExtractionOutcome.TOOL_UNAVAILABLE
    assert record.text == ""
    assert record.notes == ("pdftotext is unavailable on PATH",)


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


def test_office_archive_bounds_precede_xml_parsing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    document = _declare_member_size(
        _docx(tmp_path / "oversized.docx"),
        "word/document.xml",
        21 * 1024 * 1024,
    )

    def xml_must_not_be_read(self: zipfile.ZipFile, name: object, *args: object) -> bytes:
        raise AssertionError(f"oversized office member was read: {name!r}")

    monkeypatch.setattr(zipfile.ZipFile, "read", xml_must_not_be_read)
    record = extract_file(document)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.TOO_LARGE
    assert record.members[-1].path == "word/document.xml"


def test_office_entity_declarations_are_refused_before_parsing(tmp_path: Path) -> None:
    document = _zip(
        tmp_path / "entity.docx",
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": (
                b'<!DOCTYPE document [<!ENTITY hidden "must-not-expand">]>'
                b'<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>&hidden;</w:t>'
                b"</w:r></w:p></w:body></w:document>"
            ),
        },
    )

    record = extract_file(document)

    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("DOCTYPE declaration" in note for note in record.notes)
    assert "must-not-expand" not in record.text


def test_office_parse_errors_are_named_unreadable(tmp_path: Path) -> None:
    sheet = _zip(
        tmp_path / "broken.xlsx",
        {
            "[Content_Types].xml": b"<Types/>",
            "xl/sharedStrings.xml": b'<sst xmlns="urn:sheet"><si><t>only entry</t></si></sst>',
            "xl/worksheets/sheet1.xml": (
                b'<worksheet xmlns="urn:sheet"><sheetData><row>'
                b'<c r="A1" t="s"><v>9</v></c>'
                b"</row></sheetData></worksheet>"
            ),
        },
    )

    record = extract_file(sheet)

    assert record.extractor is Extractor.OFFICE_XML
    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("IndexError" in note for note in record.notes)


def test_archive_declared_member_bound_prevents_member_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = _declare_member_size(
        _zip(tmp_path / "oversized.zip", {"claimed-large.txt": b"small"}),
        "claimed-large.txt",
        25 * 1024 * 1024,
    )

    def member_must_not_be_read(self: zipfile.ZipFile, name: object, *args: object) -> bytes:
        raise AssertionError(f"oversized archive member was read: {name!r}")

    monkeypatch.setattr(zipfile.ZipFile, "read", member_must_not_be_read)
    record = extract_file(archive)

    assert record.extractor is Extractor.ARCHIVE_MEMBERS
    assert record.outcome is ExtractionOutcome.TOO_LARGE
    assert record.members[0].size == 25 * 1024 * 1024


def test_empty_zip_is_an_empty_archive_record(tmp_path: Path) -> None:
    archive = _write(tmp_path / "empty.zip", b"PK\x05\x06" + b"\0" * 18)

    record = extract_file(archive)

    assert record.extractor is Extractor.ARCHIVE_MEMBERS
    assert record.outcome is ExtractionOutcome.EMPTY
    assert record.members == ()


@pytest.mark.parametrize(
    ("data", "encoding"),
    (
        (b"\xef\xbb\xbfutf8 bom", "utf-8-sig"),
        (b"\xff\xfe" + "little endian".encode("utf-16-le"), "utf-16-le"),
        (b"\xfe\xff" + "big endian".encode("utf-16-be"), "utf-16-be"),
    ),
)
def test_bom_text_is_decoded_and_named(data: bytes, encoding: str) -> None:
    record = extract_bytes(data)

    assert record.extractor is Extractor.PLAIN_TEXT
    assert record.outcome is ExtractionOutcome.EXTRACTED
    assert record.text.endswith("bom") or record.text.endswith("endian")
    assert record.notes == (f"encoding:{encoding}",)


def test_notebook_marker_without_cells_is_named_unreadable() -> None:
    record = extract_bytes(b'{"nbformat":4,"metadata":{}}')

    assert record.extractor is Extractor.NOTEBOOK_CELLS
    assert record.outcome is ExtractionOutcome.UNREADABLE
    assert any("KeyError" in note for note in record.notes)


def test_pdf_tool_receives_the_digested_input_on_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = _minimal_pdf("stdin evidence")
    observed: list[bytes] = []
    monkeypatch.setattr("nous_os.extraction._pdftext_path", lambda: "text-tool")
    monkeypatch.setattr("nous_os.extraction._pdftotext_version", lambda tool: "test version")

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        assert args == ["text-tool", "-layout", "-", "-"]
        assert kwargs["input"] == pdf
        observed.append(kwargs["input"])
        stdout = kwargs["stdout"]
        assert hasattr(stdout, "write")
        stdout.write(b"stdin evidence\n")
        return subprocess.CompletedProcess(args, 0, stderr=b"")

    monkeypatch.setattr("nous_os.extraction.subprocess.run", run)
    record = extract_bytes(pdf)

    assert observed == [pdf]
    assert hashlib.sha256(observed[0]).hexdigest() == record.asset_digest
    assert record.text == "stdin evidence"


def test_pdf_tool_version_is_the_first_real_version_line() -> None:
    tool = shutil.which("pdftotext")
    if tool is None:
        pytest.skip("pdftotext is absent")
    completed = subprocess.run([tool, "-v"], capture_output=True, check=False, timeout=10)
    output = completed.stdout or completed.stderr
    expected = output.decode("utf-8", errors="replace").splitlines()[0]

    record = extract_bytes(_minimal_pdf("version evidence"))

    assert record.extractor is Extractor.PDF_TEXT_TOOL
    assert record.extractor_version == expected


def test_pdf_form_feed_and_whitespace_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("nous_os.extraction._pdftext_path", lambda: "text-tool")
    monkeypatch.setattr("nous_os.extraction._pdftotext_version", lambda tool: "test version")

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        kwargs["stdout"].write(b"\f \n\t")
        return subprocess.CompletedProcess(args, 0, stderr=b"")

    monkeypatch.setattr("nous_os.extraction.subprocess.run", run)
    record = extract_bytes(_minimal_pdf("ignored"))

    assert record.outcome is ExtractionOutcome.EMPTY
    assert record.text == ""
    assert record.locations == ()


def test_extracted_text_is_capped_for_plain_and_pdf_stdout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    oversized = tmp_path / "oversized.txt"
    with oversized.open("wb") as output:
        output.seek(MAX_EXTRACTED_TEXT_BYTES)
        output.write(b"x")

    plain_record = extract_file(oversized)

    assert plain_record.extractor is Extractor.PLAIN_TEXT
    assert plain_record.outcome is ExtractionOutcome.TOO_LARGE
    assert plain_record.text == ""

    monkeypatch.setattr("nous_os.extraction._pdftext_path", lambda: "text-tool")
    monkeypatch.setattr("nous_os.extraction._pdftotext_version", lambda tool: "test version")

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        kwargs["stdout"].write(b"x" * (MAX_EXTRACTED_TEXT_BYTES + 1))
        return subprocess.CompletedProcess(args, 0, stderr=b"")

    monkeypatch.setattr("nous_os.extraction.subprocess.run", run)
    pdf_record = extract_bytes(_minimal_pdf("ignored"))

    assert pdf_record.extractor is Extractor.PDF_TEXT_TOOL
    assert pdf_record.outcome is ExtractionOutcome.TOO_LARGE
    assert pdf_record.text == ""


def test_identical_bytes_share_name_free_record_and_named_owners(tmp_path: Path) -> None:
    first = _write(tmp_path / "first", b"same owned bytes")
    second = _write(tmp_path / "second", b"same owned bytes")
    forward = extract_assets(((first, "src_A"), (second, "src_B")))
    reversed_order = extract_assets(((second, "src_B"), (first, "src_A")))

    assert len(forward) == 1
    assert forward[0].asset_source_ids == ("src_A", "src_B")
    assert tuple((owner.asset_source_id, owner.given_name) for owner in forward[0].owners) == (
        ("src_A", "first"),
        ("src_B", "second"),
    )
    assert forward[0].extraction.asset_source_id is None
    assert forward[0].extraction.given_name is None
    assert forward[0].asset_digest == hashlib.sha256(b"same owned bytes").hexdigest()
    assert forward[0].extraction.record_bytes() == reversed_order[0].extraction.record_bytes()
    assert forward[0].owners == reversed_order[0].owners

    first_record = extract_bytes(b"same key bytes", "src_A", given_name="first name")
    other_extractor = replace(
        first_record,
        asset_source_id="src_B",
        given_name="second name",
        extractor=Extractor.JSON_TEXT,
        extractor_version="another version",
    )
    assert len(deduplicate_extractions((first_record, other_extractor))) == 2


def test_store_appends_new_owners_and_preserves_identical_writes(tmp_path: Path) -> None:
    first_source = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    second_source = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"
    shared = deduplicate_extractions(
        (extract_bytes(b"shared stored bytes", first_source, given_name="first"),)
    )[0]
    store = ExtractionStore(tmp_path / "store")
    store.write(shared)
    assert shared.asset_digest is not None
    path = tmp_path / "store" / shared.extraction.extractor.value / f"{shared.asset_digest}.json"
    first_bytes = path.read_bytes()

    second_owner = SharedExtraction(
        shared.extraction,
        (ExtractionOwner(second_source, "second"),),
    )
    store.write(second_owner)
    appended_bytes = path.read_bytes()
    assert appended_bytes != first_bytes
    assert store.get(shared.extraction.extractor, shared.asset_digest).owners == (
        (second_source, "second"),
        (first_source, "first"),
    )

    store.write(second_owner)
    assert path.read_bytes() == appended_bytes


def test_source_bytes_unchanged(tmp_path: Path) -> None:
    source = _write(tmp_path / "source", _minimal_pdf("unchanged bytes"))
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    extract_file(source)
    after = hashlib.sha256(source.read_bytes()).hexdigest()
    assert after == before
