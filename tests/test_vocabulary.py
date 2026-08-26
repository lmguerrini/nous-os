"""Check docs/VOCABULARY.md against its own format contract, not against taste.

The document maps two vocabularies that must never be confused: the technical
one (closed Python enums, closed TypeScript string-literal unions, and other
named surface) and the epistemic one (the product-facing terms a person
reasons in). Sections are delimited by ``<!-- vocabulary:NAME -->`` /
``<!-- /vocabulary:NAME --> `` markers; ``technical``, ``epistemic`` and
``left-technical`` are GitHub Markdown tables, ``candidates`` is a sequence of
labelled bullet blocks, and ``excluded`` is free prose -- the only place the
excluded metaphor vocabulary may appear outside a code span.

``docs/VOCABULARY.md`` does not exist at the time this suite is written; it is
produced by a parallel effort. A missing document is a red build, not a green
one, so every real check below opens by reading the document through
``_document_text``, which raises loudly -- never ``pytest.skip`` -- when the
file is absent. That is the intended state until the document lands.

Each check is implemented as a plain function that takes document text (and,
where needed, the repository root) and returns a list of offence strings, so
that both the real test and its paired control in this module run the exact
same parsing and validation code. The control proves the function can fail by
running it against a small, deliberately broken fixture under
``tests/vocabulary_fixtures/``.
"""

from __future__ import annotations

import ast
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VOCABULARY_PATH = REPO_ROOT / "docs" / "VOCABULARY.md"
FIXTURE_DIR = Path(__file__).resolve().parent / "vocabulary_fixtures"

TECHNICAL_HEADER = ["Term", "Defined at", "Closed members", "What it distinguishes"]
EPISTEMIC_HEADER = ["Epistemic term", "Verdict", "Cardinality", "Technical terms", "Basis"]
LEFT_TECHNICAL_HEADER = ["Term", "Why no epistemic term is accurate enough"]

VERDICTS = frozenset({"ADOPT", "REJECT", "DEFER", "NO-MAPPING"})
CARDINALITIES = frozenset({"1:0", "1:1", "many:1", "level-spanning", "NO-MAPPING"})
BASES = frozenset({"DETERMINISTIC", "SEMANTIC"})

CANDIDATE_LABELS = (
    "Proposed boundary",
    "Evidence the boundary exists",
    "Intended meaning",
    "Why the mapping is accurate or inaccurate",
    "Structural change required",
    "Verdict",
    "Failed at",
    "Consequence for product terminology",
)

#: A failure gate reference, e.g. "Q3". Not otherwise enumerated by the format
#: contract; recognised by shape rather than by a fixed, closed list of gates.
_FAILED_AT_PATTERN = re.compile(r"Q[1-9]\d*")

#: Vocabulary the document excludes everywhere except its own `excluded`
#: section. Real code identifiers among these are still permitted in a
#: backticked span outside that section.
EXCLUDED_VOCABULARY_PATTERNS = {
    "mycelium": re.compile(r"\bmycelium\b", re.IGNORECASE),
    "symbolic lens": re.compile(r"\bsymbolic\s+lens\b", re.IGNORECASE),
    "mathesis": re.compile(r"\bmathesis\b", re.IGNORECASE),
    "huayan": re.compile(r"\bhuayan\b", re.IGNORECASE),
    "indra": re.compile(r"\bindra\b", re.IGNORECASE),
}

FORBIDDEN_RENDERER_FRAGMENTS = ("sigma", "three", "webgl", "r3f", "canvas", "shader", "pixel")

#: Mirrors the public-safety rooted-path rule: a rooted path opened by
#: whitespace, punctuation or the start of a line. A repository-relative path
#: such as ``src/nous_os/canonical.py`` does not match.
_ROOTED_PATH_PATTERN = re.compile(r"""(?:^|[\s(\["'<>=,;])/[\w.\-]+(?:/[\w.\-]+)+""", re.MULTILINE)

_BACKTICK_TERM = re.compile(r"`([^`]+)`")
_EXPORT_TYPE = re.compile(r"^export type (\w+) =", re.MULTILINE)
_STRING_UNION_BODY = re.compile(r'\|?\s*"(?:[^"\\]|\\.)*"\s*(?:\|\s*"(?:[^"\\]|\\.)*"\s*)*')
_CANDIDATE_HEADER = re.compile(r"^###\s*Candidate\s*—\s*`([^`]*)`\s*$", re.MULTILINE)
_BULLET = re.compile(r"^-\s*\*\*([^*:]+):\*\*\s*(.*)$")


# --- reading the document, or failing loudly when it is absent -------------


def _document_text() -> str:
    """Read the real document, or fail the calling test rather than skip it."""
    if not VOCABULARY_PATH.is_file():
        raise AssertionError(
            f"{VOCABULARY_PATH.relative_to(REPO_ROOT)} does not exist. "
            "A missing vocabulary document is a red build, not a green one."
        )
    return VOCABULARY_PATH.read_text(encoding="utf-8")


def _fixture_text(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


# --- section and table extraction -------------------------------------------


def extract_section(text: str, name: str) -> str:
    open_marker = f"<!-- vocabulary:{name} -->"
    close_marker = f"<!-- /vocabulary:{name} -->"
    open_index = text.find(open_marker)
    close_index = text.find(close_marker)
    if open_index == -1 or close_index == -1 or close_index < open_index:
        raise ValueError(f"section {name!r} is not delimited by its markers")
    return text[open_index + len(open_marker) : close_index]


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if not (line.startswith("|") and line.endswith("|")):
        raise ValueError(f"malformed table row: {line!r}")
    return [cell.strip() for cell in line[1:-1].split("|")]


def _validate_separator(line: str) -> None:
    stripped = line.strip()
    if "-" not in stripped or not set(stripped) <= set("-|: "):
        raise ValueError(f"malformed table separator row: {line!r}")


def parse_table(section_text: str, expected_header: list[str]) -> list[list[str]]:
    lines = [line for line in section_text.splitlines() if line.strip().startswith("|")]
    if len(lines) < 2:
        raise ValueError("table is missing its header and separator rows")
    header = _split_row(lines[0])
    if header != expected_header:
        raise ValueError(f"unexpected table header {header!r}, expected {expected_header!r}")
    _validate_separator(lines[1])
    rows = [_split_row(line) for line in lines[2:]]
    for row in rows:
        if len(row) != len(expected_header):
            raise ValueError(f"row has {len(row)} cells, expected {len(expected_header)}: {row!r}")
    return rows


def _single_backticked(cell: str) -> str:
    match = _BACKTICK_TERM.fullmatch(cell.strip())
    if not match:
        raise ValueError(f"expected a single backticked term, got {cell!r}")
    return match.group(1)


def _maybe_backticked(cell: str) -> str:
    """Unwrap a single backticked term when present; otherwise use the raw text."""
    match = _BACKTICK_TERM.fullmatch(cell.strip())
    return match.group(1) if match else cell.strip()


def _dash_separated_terms(cell: str) -> list[str]:
    cell = cell.strip()
    if cell == "—":
        return []
    return [_single_backticked(part) for part in cell.split(" · ")]


def technical_table(text: str) -> list[dict[str, object]]:
    rows = parse_table(extract_section(text, "technical"), TECHNICAL_HEADER)
    result = []
    for term_cell, defined_cell, members_cell, distinguishes_cell in rows:
        result.append(
            {
                "term": _single_backticked(term_cell),
                "defined_at": _single_backticked(defined_cell),
                "closed_members": _dash_separated_terms(members_cell),
                "distinguishes": distinguishes_cell.strip(),
            }
        )
    return result


def epistemic_table(text: str) -> list[dict[str, object]]:
    rows = parse_table(extract_section(text, "epistemic"), EPISTEMIC_HEADER)
    result = []
    for term_cell, verdict_cell, cardinality_cell, technical_cell, basis_cell in rows:
        result.append(
            {
                "term": _maybe_backticked(term_cell),
                "verdict": verdict_cell.strip(),
                "cardinality": cardinality_cell.strip(),
                "technical_terms": _dash_separated_terms(technical_cell),
                "basis": basis_cell.strip(),
            }
        )
    return result


def left_technical_table(text: str) -> list[dict[str, str]]:
    """Rows of primitives left technical, one entry per term.

    A row's term cell may name several terms separated by ``·``. That is not a
    looser rule, it is the accurate one: several primitives can share a single
    reason, and splitting them into one row each would repeat the sentence
    rather than say it once. Coverage is unaffected — the reason is attached to
    every term the cell names, so a term is still either mapped or explicitly
    left technical, and one that is neither is still reported.
    """
    rows = parse_table(extract_section(text, "left-technical"), LEFT_TECHNICAL_HEADER)
    result = []
    for term_cell, reason_cell in rows:
        for term in _dash_separated_terms(term_cell):
            result.append({"term": term, "reason": reason_cell.strip()})
    return result


def candidate_blocks(text: str) -> list[dict[str, object]]:
    section = extract_section(text, "candidates")
    headers = list(_CANDIDATE_HEADER.finditer(section))
    if not headers:
        raise ValueError("no candidate blocks found in the candidates section")
    blocks = []
    for index, header_match in enumerate(headers):
        start = header_match.end()
        end = headers[index + 1].start() if index + 1 < len(headers) else len(section)
        body = section[start:end]
        labels: list[str] = []
        values: dict[str, str] = {}
        for line in body.splitlines():
            stripped = line.strip()
            if not stripped.startswith("- **"):
                continue
            match = _BULLET.match(stripped)
            if not match:
                raise ValueError(f"malformed bullet line in candidate {header_match.group(1)!r}: {line!r}")
            label, value = match.group(1), match.group(2).strip()
            labels.append(label)
            values[label] = value
        blocks.append({"term": header_match.group(1), "labels": labels, "values": values})
    return blocks


def excluded_section_span(text: str) -> tuple[int, int]:
    open_marker = "<!-- vocabulary:excluded -->"
    close_marker = "<!-- /vocabulary:excluded -->"
    start = text.find(open_marker)
    end = text.find(close_marker)
    if start == -1 or end == -1 or end < start:
        raise ValueError("the excluded section is not delimited by its markers")
    return start, end + len(close_marker)


# --- git and source-tree helpers --------------------------------------------


def _tracked_files(repo_root: Path) -> frozenset[str]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return frozenset(name for name in listed.split("\0") if name)


def _module_level_enum_names(repo_root: Path) -> set[str]:
    """Every module-level class in src/nous_os whose bases mention Enum, from the AST."""
    names: set[str] = set()
    for module in sorted((repo_root / "src" / "nous_os").glob("*.py")):
        tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and any("Enum" in ast.unparse(base) for base in node.bases):
                names.add(node.name)
    return names


def _module_level_string_union_names(repo_root: Path) -> set[str]:
    """Every ``export type NAME = "a" | "b" | ...;`` in ui/src/engine, from a scan."""
    names: set[str] = set()
    for module in sorted((repo_root / "ui" / "src" / "engine").glob("*.ts")):
        source = module.read_text(encoding="utf-8")
        for match in _EXPORT_TYPE.finditer(source):
            terminator = source.find(";", match.end())
            if terminator == -1:
                continue
            body = source[match.end() : terminator].strip()
            if _STRING_UNION_BODY.fullmatch(body):
                names.add(match.group(1))
    return names


# --- one offence-collecting function per check ------------------------------


def technical_term_resolution_offences(text: str, repo_root: Path) -> list[str]:
    tracked = _tracked_files(repo_root)
    offences = []
    for row in technical_table(text):
        term, defined_at = row["term"], row["defined_at"]
        if defined_at.startswith("/"):
            offences.append(f"{term}: 'Defined at' {defined_at!r} is not repository-relative")
            continue
        path_part, sep, line_part = defined_at.rpartition(":")
        if not sep or not line_part.isdigit():
            offences.append(f"{term}: 'Defined at' {defined_at!r} is not of the form path:line")
            continue
        if path_part not in tracked:
            offences.append(f"{term}: {path_part!r} is not a git-tracked file")
            continue
        full_path = repo_root / path_part
        if not full_path.is_file():
            offences.append(f"{term}: {path_part!r} does not exist on disk")
            continue
        lines = full_path.read_text(encoding="utf-8", errors="replace").splitlines()
        line_number = int(line_part)
        if not (1 <= line_number <= len(lines)):
            offences.append(f"{term}: {path_part!r} has {len(lines)} lines, cannot resolve line {line_number}")
            continue
        if term not in lines[line_number - 1]:
            offences.append(f"{term}: line {line_number} of {path_part!r} does not contain {term!r}")
    return offences


def undocumented_enum_offences(text: str, repo_root: Path) -> list[str]:
    documented = {row["term"] for row in technical_table(text)}
    missing = sorted(_module_level_enum_names(repo_root) - documented)
    return [f"enum {name!r} is not documented in the technical table" for name in missing]


def undocumented_ts_union_offences(text: str, repo_root: Path) -> list[str]:
    documented = {row["term"] for row in technical_table(text)}
    missing = sorted(_module_level_string_union_names(repo_root) - documented)
    return [f"closed TypeScript vocabulary {name!r} is not documented in the technical table" for name in missing]


def incomplete_candidate_offences(text: str) -> list[str]:
    offences = []
    for block in candidate_blocks(text):
        term = block["term"] or "<empty candidate term>"
        labels, values = block["labels"], block["values"]
        if tuple(labels) != CANDIDATE_LABELS:
            offences.append(f"{term}: labels {labels} do not match the required order {list(CANDIDATE_LABELS)}")
            continue
        for label in CANDIDATE_LABELS:
            if not values.get(label, "").strip():
                offences.append(f"{term}: {label!r} is empty")
        verdict = values["Verdict"].strip()
        if verdict not in VERDICTS:
            offences.append(f"{term}: verdict {verdict!r} is not one of {sorted(VERDICTS)}")
        failed_at = values["Failed at"].strip()
        if verdict == "ADOPT":
            if failed_at != "—":
                offences.append(f"{term}: 'Failed at' must be '—' when the verdict is ADOPT, got {failed_at!r}")
        elif failed_at == "—" or not _FAILED_AT_PATTERN.fullmatch(failed_at):
            offences.append(f"{term}: 'Failed at' {failed_at!r} is not a valid failure marker for verdict {verdict!r}")
    return offences


def malformed_epistemic_row_offences(text: str) -> list[str]:
    offences = []
    for row in epistemic_table(text):
        term = row["term"] or "<empty epistemic term>"
        verdict, cardinality, basis = row["verdict"], row["cardinality"], row["basis"]
        count = len(row["technical_terms"])
        if verdict not in VERDICTS:
            offences.append(f"{term}: verdict {verdict!r} is not one of {sorted(VERDICTS)}")
        if cardinality not in CARDINALITIES:
            offences.append(f"{term}: cardinality {cardinality!r} is not one of {sorted(CARDINALITIES)}")
        if basis not in BASES:
            offences.append(f"{term}: basis {basis!r} is not one of {sorted(BASES)}")
        if cardinality in ("1:0", "NO-MAPPING") and count != 0:
            offences.append(f"{term}: cardinality {cardinality!r} requires '—', found {count} technical term(s)")
        elif cardinality == "1:1" and count != 1:
            offences.append(f"{term}: cardinality 1:1 requires exactly one technical term, found {count}")
        elif cardinality == "many:1" and count < 2:
            offences.append(f"{term}: cardinality many:1 requires two or more technical terms, found {count}")
        elif cardinality == "level-spanning" and count < 1:
            offences.append(f"{term}: cardinality level-spanning requires at least one technical term, found {count}")
    return offences


def candidate_epistemic_mismatch_offences(text: str) -> list[str]:
    candidate_terms = {block["term"] for block in candidate_blocks(text)}
    epistemic_terms = {row["term"] for row in epistemic_table(text)}
    offences = []
    only_candidates = sorted(candidate_terms - epistemic_terms)
    only_epistemic = sorted(epistemic_terms - candidate_terms)
    if only_candidates:
        offences.append(f"candidates absent from the epistemic register: {only_candidates}")
    if only_epistemic:
        offences.append(f"epistemic rows with no matching candidate block: {only_epistemic}")
    return offences


def unmapped_technical_term_offences(text: str) -> list[str]:
    technical_terms = {row["term"] for row in technical_table(text)}
    mapped: set[str] = set()
    for row in epistemic_table(text):
        mapped.update(row["technical_terms"])
    left_out = {row["term"] for row in left_technical_table(text)}
    unmapped = sorted(technical_terms - mapped - left_out)
    return [f"technical term {term!r} is neither mapped from an epistemic row nor listed in left-technical" for term in unmapped]


def excluded_vocabulary_leak_offences(text: str) -> list[str]:
    excluded_start, excluded_end = excluded_section_span(text)
    code_spans = [match.span() for match in re.finditer(r"`[^`\n]*`", text)]
    offences = []
    for word, pattern in EXCLUDED_VOCABULARY_PATTERNS.items():
        for match in pattern.finditer(text):
            position = match.start()
            if excluded_start <= position < excluded_end:
                continue
            if any(span_start <= position < span_end for span_start, span_end in code_spans):
                continue
            offences.append(f"{word!r} appears in prose outside the excluded section at offset {position}")
    return offences


def renderer_named_adopted_term_offences(text: str) -> list[str]:
    offences = []
    for row in epistemic_table(text):
        if row["verdict"] != "ADOPT":
            continue
        lowered = row["term"].lower()
        hits = [fragment for fragment in FORBIDDEN_RENDERER_FRAGMENTS if fragment in lowered]
        if hits:
            offences.append(f"adopted term {row['term']!r} names a renderer: {hits}")
    return offences


def rooted_path_offences(text: str) -> list[str]:
    offences = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = _ROOTED_PATH_PATTERN.search(line)
        if match:
            offences.append(f"line {line_number}: rooted path {match.group(0)!r}")
    return offences


# --- the ten real checks -----------------------------------------------------


def test_every_technical_term_resolves() -> None:
    text = _document_text()
    offences = technical_term_resolution_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_every_python_enum_is_documented() -> None:
    text = _document_text()
    offences = undocumented_enum_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_every_closed_typescript_vocabulary_is_documented() -> None:
    text = _document_text()
    offences = undocumented_ts_union_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_candidate_records_are_complete() -> None:
    text = _document_text()
    offences = incomplete_candidate_offences(text)
    assert not offences, "\n".join(offences)


def test_epistemic_rows_are_well_formed() -> None:
    text = _document_text()
    offences = malformed_epistemic_row_offences(text)
    assert not offences, "\n".join(offences)


def test_every_candidate_appears_in_the_epistemic_register() -> None:
    text = _document_text()
    offences = candidate_epistemic_mismatch_offences(text)
    assert not offences, "\n".join(offences)


def test_no_technical_term_is_silently_unmapped() -> None:
    text = _document_text()
    offences = unmapped_technical_term_offences(text)
    assert not offences, "\n".join(offences)


def test_excluded_vocabulary_is_confined_to_the_excluded_section() -> None:
    text = _document_text()
    offences = excluded_vocabulary_leak_offences(text)
    assert not offences, "\n".join(offences)


def test_adopted_terms_name_no_renderer() -> None:
    text = _document_text()
    offences = renderer_named_adopted_term_offences(text)
    assert not offences, "\n".join(offences)


def test_the_document_carries_no_rooted_path() -> None:
    text = _document_text()
    offences = rooted_path_offences(text)
    assert not offences, "\n".join(offences)


# --- controls: the same functions, run against a fixture built to fail ------


def test_every_technical_term_resolves_detects_a_stale_line_reference() -> None:
    text = _fixture_text("technical_stale_reference.md")
    offences = technical_term_resolution_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_python_enum_is_documented_detects_a_missing_enum() -> None:
    text = _fixture_text("technical_empty.md")
    offences = undocumented_enum_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_closed_typescript_vocabulary_is_documented_detects_a_missing_union() -> None:
    text = _fixture_text("technical_empty.md")
    offences = undocumented_ts_union_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_candidate_records_are_complete_detects_a_missing_label() -> None:
    text = _fixture_text("candidates_missing_label.md")
    offences = incomplete_candidate_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_epistemic_rows_are_well_formed_detects_a_cardinality_mismatch() -> None:
    text = _fixture_text("epistemic_cardinality_mismatch.md")
    offences = malformed_epistemic_row_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_every_candidate_appears_in_the_epistemic_register_detects_a_mismatch() -> None:
    text = _fixture_text("candidates_epistemic_mismatch.md")
    offences = candidate_epistemic_mismatch_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_no_technical_term_is_silently_unmapped_detects_an_orphaned_term() -> None:
    text = _fixture_text("technical_orphan_term.md")
    offences = unmapped_technical_term_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_excluded_vocabulary_is_confined_to_the_excluded_section_detects_a_leak() -> None:
    text = _fixture_text("excluded_leak.md")
    offences = excluded_vocabulary_leak_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_adopted_terms_name_no_renderer_detects_a_renderer_named_adopted_term() -> None:
    text = _fixture_text("epistemic_renderer_named.md")
    offences = renderer_named_adopted_term_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_the_document_carries_no_rooted_path_detects_a_rooted_path() -> None:
    # This control's sample is assembled here rather than stored in a fixture
    # file. A fixture containing a rooted path would be a tracked byte carrying
    # exactly what the repository-wide safety scan refuses, so the file that
    # proves the rule works would break it. Splitting the literal keeps no
    # rooted path in any tracked byte while giving the rule a real match.
    rooted = "/" + "data/example/tree"
    text = (
        "<!-- vocabulary:technical -->\n"
        "| Term | Defined at | Closed members | What it distinguishes |\n"
        "|---|---|---|---|\n"
        f"| `BadPath` | `src/nous_os/canonical.py:42` | \u2014 | A path such as {rooted} must never appear. |\n"
        "<!-- /vocabulary:technical -->\n"
    )
    offences = rooted_path_offences(text)
    assert offences, "the control sample should have produced an offence"
