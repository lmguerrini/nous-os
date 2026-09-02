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
import json
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

#: The three criteria the rule section publishes. "Failed at" must cite one of
#: these exactly, or "—" when the verdict is ADOPT — never an unenumerated
#: gate reference.
FAILURE_CRITERIA = frozenset({"C1", "C2", "C3"})

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

FORBIDDEN_RENDERER_FRAGMENTS = (
    "sigma",
    "three",
    "webgl",
    "webgpu",
    "r3f",
    "canvas",
    "shader",
    "pixel",
    "svg",
    "dom",
    "skia",
    "vulkan",
    "opengl",
    "pixijs",
    "raster",
    "viewport",
    "sprite",
    "texture",
    "glsl",
)

#: Spelled numbers the defect-count check understands. Prose, not digits, because
#: the document is written for a reader rather than for a parser.
_NUMBER_WORDS = {
    "Twelve": 12, "Thirteen": 13, "Fourteen": 14, "Fifteen": 15,
    "Sixteen": 16, "Seventeen": 17, "Eighteen": 18,
}

#: Honest limitations of the checks in this module, kept as data rather than
#: left implicit. Each entry names one shape a scanner or denylist below does
#: not detect. Non-empty and every entry non-blank is asserted by a test, so
#: emptying this list to look complete is itself a failure.
_UNTRUTHFUL_ROW = re.compile(r"^\| \d+ \| ")

UNDETECTED_VOCABULARY_SHAPES = (
    "a Python enum whose base is a member-less Enum subclass declared in the same module: "
    "the base-name test resolves imports from the enum module and does not follow a local "
    "subclass",
    "a TypeScript string-literal union with no terminating semicolon",
    "a TypeScript string-literal union one of whose literals contains a semicolon",
    "a second closed vocabulary declared under a name another module already uses: both "
    "scanners key by bare name, so a later declaration silently replaces an earlier one and "
    "neither is then reported as undocumented",
    "a Python enum built with the functional Enum(\"Name\", [...]) call form rather than a class statement",
    "an Enum class nested inside another class body rather than declared at module level",
    "a module-level class declared inside an `if:` or `try:` block rather than directly in the module body",
    "a TypeScript string-literal union assembled by generic type-level computation (mapped types, "
    "template literal types, conditional types) rather than written out as literals",
    "a closed vocabulary re-exported under a second name without redeclaring its members",
    "a TypeScript closed vocabulary declared as `export enum X { ... }` or `export const enum X { ... }` "
    "rather than a string-literal union",
    "a TypeScript closed vocabulary declared as `export const X: readonly T[] = [...]` rather than a "
    "string-literal union or a typeof-keyof shape",
    "a TypeScript closed vocabulary declared as `export const X = [...] as const` with no accompanying "
    "type alias",
    "the renderer-name denylist is a finite fragment list; a renderer technology named outside it "
    "passes unflagged",
    "the excluded-vocabulary denylist is a finite five-literal list; the document's prose excludes a "
    "broader class of interpretive metaphor that a literal outside the five is not checked against",
    "a TypeScript closed vocabulary declared as a bare `export type NAME = typeof X[number];` with no "
    "union at all: the typeof-array-union scanner requires at least two `|`-joined `typeof "
    "X[number]` operands and does not resolve the single-operand form",
)

#: The commit this capability's documentation and checker work began from. The
#: structural-change check diffs against this fixed point rather than a moving
#: branch tip, so that a later commit cannot silently widen what "no structural
#: change" is measured against.
CAPABILITY_BASE_SHA = "7783dbaf64adc16f7aec01c71974a5d751dc545d"

#: The commit this capability's work ENDED at. Pinned for the same reason the
#: base is: the claim being checked is that *this* capability's adoption moved
#: no source, and a claim about one capability must be measured over that
#: capability's own range. Diffing against a moving ``HEAD`` made the check
#: report every later capability's legitimate work as a violation of a claim
#: that was never made about it — a check turning red while nothing is wrong,
#: which costs exactly as much trust as one that cannot turn red at all.
CAPABILITY_HEAD_SHA = "0e4c52633515973c9be50b868b9cce23608facf9"

#: Every closed-vocabulary base the standard ``enum`` module exports. A class
#: deriving from any of these, under an alias or dotted (``enum.StrEnum``), is
#: a closed vocabulary the technical table must document — not only ``Enum``.
_ENUM_BASE_NAMES = frozenset({"Enum", "StrEnum", "IntEnum", "IntFlag", "Flag", "ReprEnum"})

#: Mirrors the public-safety rooted-path rule: a rooted path opened by
#: whitespace, punctuation or the start of a line. A repository-relative path
#: such as ``src/nous_os/canonical.py`` does not match.
#: A home-relative or drive-letter path. The rooted pattern below covers the
#: POSIX shape, which is the real exposure here; these two are the shapes a
#: reviewer showed it did not cover, and a document is refused for either.
_HOME_OR_DRIVE_PATH = re.compile(r"""(?:^|[\s(\["'<>=,;])(?:~[/\\]|[A-Za-z]:[\\/])[\w.\-]""")
_ROOTED_PATH_PATTERN = re.compile(r"""(?:^|[\s(\["'<>=,;])/[\w.\-]+(?:/[\w.\-]+)+""", re.MULTILINE)

_BACKTICK_TERM = re.compile(r"`([^`]+)`")
#: Tolerates arbitrary whitespace around ``=``, including none, so
#: ``export type Tight="a"|"b";`` is recognised alongside the spaced form.
_EXPORT_TYPE = re.compile(r"^export type (\w+)\s*=\s*", re.MULTILINE)
#: One string literal, either quoting style.
_STRING_LITERAL = r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\''
_STRING_LITERAL_RE = re.compile(_STRING_LITERAL)
_STRING_UNION_BODY = re.compile(rf"\|?\s*(?:{_STRING_LITERAL})\s*(?:\|\s*(?:{_STRING_LITERAL})\s*)*")
#: Stripped from a union body before it is parsed, so a comment sitting
#: between two literals does not defeat the parse.
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"//[^\n]*")
#: ``export const OBJ = {...} as const;`` — the object half of the
#: ``typeof OBJ[keyof typeof OBJ]`` closed-vocabulary shape.
_EXPORT_CONST_OBJECT_AS_CONST = re.compile(r"^export const (\w+) = \{.*?\}\s*as const;", re.MULTILINE | re.DOTALL)
#: ``export type NAME = typeof OBJ[keyof typeof OBJ];`` — the type half.
_KEYOF_TYPEOF_ALIAS = re.compile(r"^export type (\w+) = typeof (\w+)\[keyof typeof \2\];", re.MULTILINE)
#: ``export const OBJ = [...] as const;`` — the array half of the
#: ``typeof A[number] | typeof B[number] | ...`` closed-vocabulary shape, the
#: form a type alias takes when it is assembled from more than one closed
#: array rather than from one object's keys (``Palette`` over ``PALETTES``
#: and ``EXPERIMENTAL_PALETTES`` is the shape this exists for).
_EXPORT_CONST_ARRAY_AS_CONST = re.compile(r"^export const (\w+) = \[.*?\]\s*as const;", re.MULTILINE | re.DOTALL)
#: One operand of a ``typeof OBJ[number] | typeof OBJ[number] | ...`` union,
#: matched against a single ``|``-split, stripped part of the union body.
_TYPEOF_ARRAY_INDEX = re.compile(r"^typeof (\w+)\[number\]$")
#: The bracketed element list of an ``export const X = [...] as const;``
#: array declaration, isolated from its ``export const X =`` prefix and
#: ``as const;`` suffix so its elements can be read comma-separated rather
#: than ``|``-separated.
_ARRAY_CONST_ELEMENTS = re.compile(r"=\s*\[(.*)\]\s*as const;", re.DOTALL)
_CANDIDATE_HEADER = re.compile(r"^###\s*Candidate\s*—\s*`([^`]*)`\s*$", re.MULTILINE)
_BULLET = re.compile(r"^-\s*\*\*([^*:]+):\*\*\s*(.*)$")

#: Every backticked ``path:line`` reference anywhere in the document, not
#: only the technical table's own ``Defined at`` column.
_ANY_PATH_LINE_REFERENCE = re.compile(r"`((?:src|ui|tests)/[^`]+?\.(?:py|ts)):(\d+)`")

#: A ``Closed members`` cell entry of the qualified form ``EnumType.member``,
#: used by ``RenderedState`` to cite members of enums it does not itself define.
_QUALIFIED_MEMBER = re.compile(r"^(\w+)\.(\w+)$")

#: The shapes a technical-table term's ``Defined at`` line must take to count
#: as the term's own definition, not merely a line that mentions it. ``{t}``
#: is substituted with the escaped term. Anchored at the start of the
#: declaration rather than merely as a word boundary anywhere on the line —
#: an unanchored ``\bexport const {t}\b`` matched several unrelated lines in
#: the same file (``Organization`` matched three, ``LodBand`` four). Leading
#: whitespace is tolerated only for the ``Final`` form, which may sit as an
#: attribute inside an indented class body; the export/class forms are
#: top-level declarations and require column zero.
_DEFINITION_PATTERN_TEMPLATES = (
    r"^(export )?(type|const|interface|class) {t}\b",
    r"^class {t}[(:]",
    r"^\s*{t}: Final\b",
)


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


def _enum_import_aliases(tree: ast.Module) -> tuple[set[str], set[str]]:
    """Names this module binds to one of the closed-vocabulary bases the standard
    ``enum`` module exports (``Enum``, ``StrEnum``, ``IntEnum``, ``IntFlag``,
    ``Flag``, ``ReprEnum``): direct-import aliases (``from enum import StrEnum as
    SE``) and whole-module aliases (``import enum as e``), resolved from the
    module's own imports rather than assumed to be the literal word "Enum".
    """
    base_aliases: set[str] = set()
    module_aliases: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "enum":
            for alias in node.names:
                if alias.name in _ENUM_BASE_NAMES:
                    base_aliases.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "enum":
                    module_aliases.add(alias.asname or alias.name)
    return base_aliases, module_aliases


def _base_names_enum(base: ast.expr, enum_aliases: set[str], module_aliases: set[str]) -> bool:
    if isinstance(base, ast.Name):
        return base.id in enum_aliases
    if isinstance(base, ast.Attribute):
        return (
            isinstance(base.value, ast.Name)
            and base.value.id in module_aliases
            and base.attr in _ENUM_BASE_NAMES
        )
    return False


def _python_enum_members(repo_root: Path) -> dict[str, list[tuple[str, object]]]:
    """Every module-level ``Enum``-derived class under ``src/nous_os``, recursive,
    mapped to its ordered ``[(member name, member value), ...]``, from the AST.

    A base is judged against the importing module's own aliases rather than by
    testing whether the literal substring ``"Enum"`` appears in the base
    expression, so ``class Tier(_Enum):`` behind ``from enum import Enum as
    _Enum`` is recognised for the right reason instead of by a substring
    coincidence.
    """
    result: dict[str, list[tuple[str, object]]] = {}
    for module in sorted((repo_root / "src" / "nous_os").rglob("*.py")):
        if "__pycache__" in module.parts:
            continue
        tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        enum_aliases, module_aliases = _enum_import_aliases(tree)
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            if not any(_base_names_enum(base, enum_aliases, module_aliases) for base in node.bases):
                continue
            members: list[tuple[str, object]] = []
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                    try:
                        value = ast.literal_eval(stmt.value)
                    except ValueError:
                        value = None
                    members.append((stmt.targets[0].id, value))
            result[node.name] = members
    return result


def _module_level_enum_names(repo_root: Path) -> set[str]:
    """Every module-level Enum-derived class name under src/nous_os, recursive."""
    return set(_python_enum_members(repo_root))


def _string_union_literal_values(body: str) -> list[str] | None:
    """The ordered literal values of a string-literal union body, or ``None`` if
    ``body`` is not one. Accepts either quoting style and one enclosing layer
    of parentheses. Block and line comments are stripped first, so a comment
    sitting between two literals does not defeat the parse.
    """
    stripped = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", body)).strip()
    if stripped.startswith("(") and stripped.endswith(")"):
        candidate = stripped[1:-1].strip()
    else:
        candidate = stripped
    if not _STRING_UNION_BODY.fullmatch(candidate):
        return None
    return [match.group(0)[1:-1] for match in _STRING_LITERAL_RE.finditer(candidate)]


def _ts_string_union_values(repo_root: Path) -> dict[str, list[str]]:
    """Every ``export type NAME = "a" | 'b' | ...;`` in ui/src/engine, recursive,
    mapped to its ordered literal values, from a scan.
    """
    values: dict[str, list[str]] = {}
    for module in sorted((repo_root / "ui" / "src" / "engine").rglob("*.ts")):
        source = module.read_text(encoding="utf-8")
        for match in _EXPORT_TYPE.finditer(source):
            terminator = source.find(";", match.end())
            if terminator == -1:
                continue
            body = source[match.end() : terminator]
            literal_values = _string_union_literal_values(body)
            if literal_values is not None:
                values[match.group(1)] = literal_values
    return values


def _ts_keyof_typeof_names(repo_root: Path) -> set[str]:
    """Every ``export type NAME = typeof OBJ[keyof typeof OBJ];`` in ui/src/engine,
    recursive, whose ``OBJ`` is itself an ``export const OBJ = {...} as const;``
    object — the shape ``VisualStateValidationRule`` takes over
    ``VISUAL_STATE_VALIDATION_RULES``.
    """
    names: set[str] = set()
    for module in sorted((repo_root / "ui" / "src" / "engine").rglob("*.ts")):
        source = module.read_text(encoding="utf-8")
        object_names = {match.group(1) for match in _EXPORT_CONST_OBJECT_AS_CONST.finditer(source)}
        for match in _KEYOF_TYPEOF_ALIAS.finditer(source):
            alias_name, object_name = match.group(1), match.group(2)
            if object_name in object_names:
                names.add(alias_name)
    return names


def _module_level_string_union_names(repo_root: Path) -> set[str]:
    """Every closed TypeScript string vocabulary in ui/src/engine, recursive:
    plain string-literal unions, the ``typeof OBJ[keyof typeof OBJ]`` shape,
    and the ``typeof A[number] | typeof B[number] | ...`` shape.
    """
    return (
        set(_ts_string_union_values(repo_root))
        | _ts_keyof_typeof_names(repo_root)
        | set(_ts_typeof_array_union_values(repo_root))
    )


def _typeof_array_union_names(body: str) -> list[str] | None:
    """The ordered array names of a ``typeof A[number] | typeof B[number] |
    ...`` union body, or ``None`` if ``body`` is not one. Comments are
    stripped first, the same way ``_string_union_literal_values`` does.

    Requires at least two ``|``-joined operands, deliberately: a bare single
    ``typeof X[number]`` (no union at all, no ``|``) is a different,
    still-undetected shape this scanner does not claim to cover, and treating
    it as this shape would pull an unrelated single-array alias like
    ``PresetName`` into a check this capability was not asked to extend to.
    """
    stripped = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", body)).strip()
    if not stripped or "|" not in stripped:
        return None
    names: list[str] = []
    for part in stripped.split("|"):
        match = _TYPEOF_ARRAY_INDEX.match(part.strip())
        if match is None:
            return None
        names.append(match.group(1))
    return names


def _ts_typeof_array_union_values(repo_root: Path) -> dict[str, list[str]]:
    """Every ``export type NAME = typeof A[number] | typeof B[number] | ...;``
    in ui/src/engine, recursive, whose every ``typeof`` operand is itself an
    ``export const X = [...] as const;`` array — the shape ``Palette`` takes
    over ``PALETTES`` and ``EXPERIMENTAL_PALETTES`` — mapped to the
    concatenation of each operand's own ordered string-literal values, in the
    union's own written order.
    """
    values: dict[str, list[str]] = {}
    for module in sorted((repo_root / "ui" / "src" / "engine").rglob("*.ts")):
        source = module.read_text(encoding="utf-8")
        array_bodies = {match.group(1): match.group(0) for match in _EXPORT_CONST_ARRAY_AS_CONST.finditer(source)}
        for match in _EXPORT_TYPE.finditer(source):
            terminator = source.find(";", match.end())
            if terminator == -1:
                continue
            body = source[match.end():terminator]
            array_names = _typeof_array_union_names(body)
            if array_names is None or not all(name in array_bodies for name in array_names):
                continue
            member_values: list[str] = []
            for name in array_names:
                elements = _ARRAY_CONST_ELEMENTS.search(array_bodies[name])
                if elements is None:
                    member_values.clear()
                    break
                stripped = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", elements.group(1)))
                member_values.extend(literal.group(0)[1:-1] for literal in _STRING_LITERAL_RE.finditer(stripped))
            if member_values:
                values[match.group(1)] = member_values
    return values


def _ts_object_const_property_values(repo_root: Path) -> dict[str, list[str]]:
    """Every ``export type NAME = typeof OBJ[keyof typeof OBJ];`` alias in
    ui/src/engine, recursive, mapped to ``OBJ``'s own ordered property literal
    values — the closed vocabulary a row naming ``NAME`` actually carries.
    """
    values: dict[str, list[str]] = {}
    for module in sorted((repo_root / "ui" / "src" / "engine").rglob("*.ts")):
        source = module.read_text(encoding="utf-8")
        object_bodies = {match.group(1): match.group(0) for match in _EXPORT_CONST_OBJECT_AS_CONST.finditer(source)}
        for match in _KEYOF_TYPEOF_ALIAS.finditer(source):
            alias_name, object_name = match.group(1), match.group(2)
            body = object_bodies.get(object_name)
            if body is None:
                continue
            property_values = [
                literal.group(1) if literal.group(1) is not None else literal.group(2)
                for literal in re.finditer(r':\s*(?:"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\')', body)
            ]
            values[alias_name] = property_values
    return values


# --- one offence-collecting function per check ------------------------------


def _is_definition_line(term: str, line: str) -> bool:
    """Whether ``line`` is the definition of ``term``, not merely a line that
    happens to contain it as a substring — ``Outcome`` pointed at ``class
    GateOutcome(Enum):`` must not pass.
    """
    escaped = re.escape(term)
    return any(re.search(pattern.format(t=escaped), line) for pattern in _DEFINITION_PATTERN_TEMPLATES)


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
        if not _is_definition_line(term, lines[line_number - 1]):
            offences.append(f"{term}: line {line_number} of {path_part!r} does not define {term!r}")
    return offences


#: Identifiers this run's calls to ``all_reference_offences`` could not check
#: for meaning because their scope carried no backticked identifier at all —
#: the weaker, existence-only case, made visible rather than left silent.
#: Cleared and repopulated on every call.
REFERENCES_CHECKED_BY_EXISTENCE_ONLY: list[str] = []

#: Backticked spans that look like an identifier — a bare word or a dotted
#: qualified name such as ``EnumType.member`` — rather than a path (paths
#: always contain ``/`` and never match ``\w``) or a phrase of prose.
_IDENTIFIER_BACKTICK = re.compile(r"`([\w.]+)`")


def _reference_scope_text(text: str, match_start: int) -> str:
    """The table row, bullet, or paragraph containing the reference that starts
    at ``match_start`` — the text a reference's cited line must agree with.

    A table row and a bullet are each exactly one physical line in this
    document, so the line containing the match is the row or the bullet.
    Ordinary prose is grouped with its neighbouring non-blank lines up to the
    nearest blank line, table row, bullet, heading or section marker, so a
    paragraph that does span more than one physical line is still handled.
    """
    lines = text.splitlines(keepends=True)
    offset = 0
    line_index = None
    for index, line in enumerate(lines):
        if offset <= match_start < offset + len(line):
            line_index = index
            break
        offset += len(line)
    if line_index is None:
        return ""
    stripped = lines[line_index].strip()
    if stripped.startswith("|") or stripped.startswith("- "):
        return lines[line_index]
    boundary = ("|", "- ", "<!--", "#")
    start = line_index
    while start > 0:
        candidate = lines[start - 1].strip()
        if not candidate or candidate.startswith(boundary):
            break
        start -= 1
    end = line_index
    while end + 1 < len(lines):
        candidate = lines[end + 1].strip()
        if not candidate or candidate.startswith(boundary):
            break
        end += 1
    return "".join(lines[start : end + 1])


def _scope_identifiers(scope: str) -> set[str]:
    """The backticked identifiers a reference sits beside.

    A qualified name contributes its final segment as well as itself.
    ``Verdict.DEFER`` names the member declared as ``DEFER = "defer"``, and
    the line that declares it carries only the bare member — so requiring the
    qualified spelling to appear verbatim would reject the one line in the
    tree that is unambiguously right. Both spellings are accepted, which
    narrows what a reference may point at rather than widening it: an
    unrelated line still contains neither.
    """
    identifiers: set[str] = set()
    for match in _IDENTIFIER_BACKTICK.finditer(scope):
        identifier = match.group(1)
        identifiers.add(identifier)
        head, separator, member = identifier.rpartition(".")
        if separator and head and member:
            identifiers.add(member)
    return identifiers


def all_reference_offences(text: str, repo_root: Path) -> list[str]:
    """Every backticked ``path:line`` reference anywhere in the document — not
    only the technical table's ``Defined at`` column — resolves to a tracked,
    existing, in-range, non-blank line. This does not require the referenced
    line to define the cited term: references outside the technical table
    point at usages and error classes as often as at definitions.

    Existence is not the whole claim a reference makes, though: a reference
    sits in a table row, a bullet or a paragraph that names what it is
    evidence for, and the cited line is required to actually contain one of
    the backticked identifiers named alongside it in that same scope. A
    reference can drift to an unrelated but otherwise valid line and an
    existence-only check would never notice; this would. When a reference's
    scope carries no backticked identifier at all, there is nothing to check
    it against, and the weaker existence-only check is the whole of it — that
    fallback is recorded in ``REFERENCES_CHECKED_BY_EXISTENCE_ONLY`` rather
    than silently accepted as equivalent to the stronger check.
    """
    REFERENCES_CHECKED_BY_EXISTENCE_ONLY.clear()
    tracked = _tracked_files(repo_root)
    offences = []
    resolved: dict[tuple[str, str], str | None] = {}
    for match in _ANY_PATH_LINE_REFERENCE.finditer(text):
        path_part, line_part = match.group(1), match.group(2)
        key = (path_part, line_part)
        if key not in resolved:
            resolved[key] = _resolve_reference_source_line(path_part, line_part, tracked, repo_root, offences)
        src_line = resolved[key]
        if src_line is None:
            continue
        identifiers = _scope_identifiers(_reference_scope_text(text, match.start()))
        if not identifiers:
            REFERENCES_CHECKED_BY_EXISTENCE_ONLY.append(f"{path_part}:{line_part}")
            continue
        if not any(identifier in src_line for identifier in identifiers):
            offences.append(
                f"{path_part}:{line_part} cites a line containing none of {sorted(identifiers)}: {src_line!r}"
            )
    return offences


def _resolve_reference_source_line(
    path_part: str, line_part: str, tracked: frozenset[str], repo_root: Path, offences: list[str]
) -> str | None:
    """The tracked, existing, in-range, non-blank source line a reference cites,
    or ``None`` after recording exactly the offence that disqualified it.
    """
    if path_part not in tracked:
        offences.append(f"{path_part}:{line_part} is not a git-tracked file")
        return None
    full_path = repo_root / path_part
    if not full_path.is_file():
        offences.append(f"{path_part}:{line_part} does not exist on disk")
        return None
    lines = full_path.read_text(encoding="utf-8", errors="replace").splitlines()
    line_number = int(line_part)
    if not (1 <= line_number <= len(lines)):
        offences.append(f"{path_part}:{line_part} has {len(lines)} lines, cannot resolve line {line_number}")
        return None
    src_line = lines[line_number - 1]
    if not src_line.strip():
        offences.append(f"{path_part}:{line_part} is blank")
        return None
    return src_line


#: The trees a mapped technical term is searched for a reference in, as
#: ``(directory, glob)`` pairs relative to the repository root.
_MAPPED_TERM_SOURCE_TREES = (
    ("src/nous_os", "*.py"),
    ("ui/src", "*.ts"),
    ("tests", "*.py"),
)


def mapped_term_reference_offences(text: str, repo_root: Path) -> list[str]:
    """Every technical term an epistemic row maps to is referenced, by exact
    identifier, from more than one file — the check behind the epistemic
    register's own claim that an adopted term's boundary "is referenced from
    more than one place." A term whose only occurrence is the line the
    technical table cites as its own definition is not referenced from
    anywhere else at all, so that line is excluded from the count.
    """
    defined_at = {row["term"]: row["defined_at"] for row in technical_table(text)}
    mapped_terms: set[str] = set()
    for row in epistemic_table(text):
        mapped_terms.update(row["technical_terms"])
    offences = []
    for term in sorted(mapped_terms):
        pattern = re.compile(rf"\b{re.escape(term)}\b")
        excluded_path, excluded_line = None, None
        defined_cell = defined_at.get(term)
        if defined_cell:
            path_part, sep, line_part = defined_cell.rpartition(":")
            if sep and line_part.isdigit():
                excluded_path, excluded_line = path_part, int(line_part)
        files_referenced: set[str] = set()
        for directory, glob in _MAPPED_TERM_SOURCE_TREES:
            for source_path in sorted((repo_root / directory).rglob(glob)):
                if "__pycache__" in source_path.parts:
                    continue
                relative = str(source_path.relative_to(repo_root))
                source_lines = source_path.read_text(encoding="utf-8", errors="replace").splitlines()
                for line_number, source_line in enumerate(source_lines, start=1):
                    if relative == excluded_path and line_number == excluded_line:
                        continue
                    if pattern.search(source_line):
                        files_referenced.add(relative)
                        break
        if len(files_referenced) < 2:
            offences.append(
                f"{term}: referenced from {len(files_referenced)} file(s) {sorted(files_referenced)}, "
                "fewer than the two required"
            )
    return offences


def undocumented_enum_offences(text: str, repo_root: Path) -> list[str]:
    documented = {row["term"] for row in technical_table(text)}
    missing = sorted(_module_level_enum_names(repo_root) - documented)
    return [f"enum {name!r} is not documented in the technical table" for name in missing]


def undocumented_ts_union_offences(text: str, repo_root: Path) -> list[str]:
    documented = {row["term"] for row in technical_table(text)}
    missing = sorted(_module_level_string_union_names(repo_root) - documented)
    return [f"closed TypeScript vocabulary {name!r} is not documented in the technical table" for name in missing]


def closed_member_offences(text: str, repo_root: Path) -> list[str]:
    """The ``Closed members`` cell of every technical row that has one matches
    the source, as an ordered list — not merely a row that exists.

    A row's cell may be plain names, compared against a Python enum's member
    names, a TypeScript union's literal values, the ordered property values
    of a ``typeof OBJ[keyof typeof OBJ]`` closed vocabulary, or the
    concatenated ordered literal values of a
    ``typeof A[number] | typeof B[number] | ...`` closed vocabulary; or it may
    be qualified names of the form ``EnumType.member`` (``RenderedState``'s
    shape), compared against the named enums' own members instead. A cell that
    resolves to none of these is an offence, not a silent pass.
    """
    enum_members = _python_enum_members(repo_root)
    ts_values = _ts_string_union_values(repo_root)
    ts_object_const_values = _ts_object_const_property_values(repo_root)
    ts_typeof_array_union_values = _ts_typeof_array_union_values(repo_root)
    offences = []
    for row in technical_table(text):
        term, cell = row["term"], row["closed_members"]
        if not cell:
            continue
        qualified = [_QUALIFIED_MEMBER.match(entry) for entry in cell]
        if any(qualified):
            if not all(qualified):
                offences.append(f"{term}: 'Closed members' mixes qualified and unqualified names: {cell!r}")
                continue
            groups: dict[str, list[str]] = {}
            order: list[str] = []
            for match in qualified:
                enum_name, member_value = match.group(1), match.group(2)
                groups.setdefault(enum_name, []).append(member_value)
                if enum_name not in order:
                    order.append(enum_name)
            for enum_name in order:
                members = enum_members.get(enum_name)
                if members is None:
                    offences.append(
                        f"{term}: qualified member cites {enum_name!r}, which is not a Python enum under src/nous_os"
                    )
                    continue
                actual_values = [value for _, value in members]
                if groups[enum_name] != actual_values:
                    offences.append(
                        f"{term}: closed members for {enum_name!r} are {groups[enum_name]!r}, "
                        f"the source declares {actual_values!r}"
                    )
            continue
        if term in enum_members:
            actual_names = [name for name, _ in enum_members[term]]
            if cell != actual_names:
                offences.append(f"{term}: closed members {cell!r} do not match the enum's members {actual_names!r}")
            continue
        if term in ts_values:
            if cell != ts_values[term]:
                offences.append(
                    f"{term}: closed members {cell!r} do not match the TypeScript union's literals {ts_values[term]!r}"
                )
            continue
        if term in ts_object_const_values:
            if cell != ts_object_const_values[term]:
                offences.append(
                    f"{term}: closed members {cell!r} do not match the source's property values "
                    f"{ts_object_const_values[term]!r}"
                )
            continue
        if term in ts_typeof_array_union_values:
            if cell != ts_typeof_array_union_values[term]:
                offences.append(
                    f"{term}: closed members {cell!r} do not match the source's typeof-array-union "
                    f"values {ts_typeof_array_union_values[term]!r}"
                )
            continue
        offences.append(
            f"{term}: 'Closed members' is {cell!r} but {term!r} does not resolve to a Python enum, "
            "a TypeScript string-literal union, or a typeof-keyof closed vocabulary"
        )
    return offences


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
        elif failed_at == "—" or failed_at not in FAILURE_CRITERIA:
            offences.append(
                f"{term}: 'Failed at' {failed_at!r} must be one of {sorted(FAILURE_CRITERIA)} for verdict {verdict!r}"
            )
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


def verdict_disagreement_offences(text: str) -> list[str]:
    """A candidate block's own ``Verdict`` bullet agrees with the epistemic
    register's verdict for the same term. Comparing term-name sets alone, as
    ``candidate_epistemic_mismatch_offences`` does, lets a candidate record
    flip to ``ADOPT`` while the table still says ``REJECT`` and stay green.
    """
    epistemic_verdicts = {row["term"]: row["verdict"] for row in epistemic_table(text)}
    offences = []
    for block in candidate_blocks(text):
        term = block["term"]
        table_verdict = epistemic_verdicts.get(term)
        if table_verdict is None:
            continue
        candidate_verdict = block["values"].get("Verdict", "").strip()
        if candidate_verdict != table_verdict:
            offences.append(
                f"{term}: candidate verdict {candidate_verdict!r} disagrees with the epistemic "
                f"register's verdict {table_verdict!r}"
            )
    return offences


def unmapped_technical_term_offences(text: str) -> list[str]:
    technical_terms = {row["term"] for row in technical_table(text)}
    mapped: set[str] = set()
    for row in epistemic_table(text):
        mapped.update(row["technical_terms"])
    left_out = {row["term"] for row in left_technical_table(text)}
    unmapped = sorted(technical_terms - mapped - left_out)
    return [f"technical term {term!r} is neither mapped from an epistemic row nor listed in left-technical" for term in unmapped]


def double_membership_offences(text: str) -> list[str]:
    """A technical term may be mapped from an epistemic row, or left technical,
    but never both — ``technical − mapped − left_out`` alone is an inclusive
    or, and lets a term in both sets pass.
    """
    mapped: set[str] = set()
    for row in epistemic_table(text):
        mapped.update(row["technical_terms"])
    left_out = {row["term"] for row in left_technical_table(text)}
    both = sorted(mapped & left_out)
    return [f"technical term {term!r} is both mapped from an epistemic row and listed in left-technical" for term in both]


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


def canonical_layer_excluded_vocabulary_offences(repo_root: Path) -> list[str]:
    """The excluded vocabulary does not appear anywhere in the source under
    ``src/nous_os``, recursive — the claim the excluded section makes and that
    nothing previously scanned the tree to check.
    """
    offences = []
    for module in sorted((repo_root / "src" / "nous_os").rglob("*.py")):
        if "__pycache__" in module.parts:
            continue
        rel = module.relative_to(repo_root)
        lines = module.read_text(encoding="utf-8", errors="replace").splitlines()
        for line_number, line in enumerate(lines, start=1):
            for word, pattern in EXCLUDED_VOCABULARY_PATTERNS.items():
                if pattern.search(line):
                    offences.append(f"{word!r} appears in {rel}:{line_number}")
    return offences


def structural_change_offences(
    repo_root: Path, base_sha: str = CAPABILITY_BASE_SHA, head: str = CAPABILITY_HEAD_SHA
) -> list[str]:
    """Every path under ``src/``, ``ui/src/``, ``ui/test/`` or ``fixtures/`` that
    differs between ``base_sha`` and ``head`` — the check behind the document's
    own claim that "adoption changed nothing." An empty diff is the only
    passing result.

    A check that cannot run and quietly returns no offences is worse than no
    check: it would report a green build for a comparison nobody made. If
    ``base_sha`` is not an ancestor of ``head``, or ``head`` is no longer an
    ancestor of the live ``HEAD``, or git itself is unavailable, that is an
    offence, not a silent pass.

    Both ends are pinned. A pinned pair could otherwise keep answering from a
    branch the repository has abandoned: a history rewrite that orphaned the
    range would leave both objects readable until garbage collection, and the
    diff between them would stay green while describing a tree nobody is on.
    Requiring the pinned head to remain an ancestor of the live ``HEAD`` is what
    makes the green result a statement about this repository rather than about
    two loose objects in it.
    """
    try:
        ancestry = subprocess.run(
            ["git", "merge-base", "--is-ancestor", base_sha, head],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [f"git is unavailable to check structural change: {exc}"]
    if ancestry.returncode != 0:
        return [
            f"{base_sha} is not an ancestor of {head} in {repo_root}; the structural-change diff "
            "cannot be trusted, so it is refused rather than reported empty"
        ]
    try:
        liveness = subprocess.run(
            ["git", "merge-base", "--is-ancestor", head, "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [f"git is unavailable to check structural change: {exc}"]
    if liveness.returncode != 0:
        return [
            f"the pinned range head {head} is not an ancestor of HEAD in {repo_root}; the range no "
            "longer describes this repository's history, so it is refused rather than reported empty"
        ]
    try:
        diff = subprocess.run(
            ["git", "diff", "--name-only", f"{base_sha}..{head}", "--", "src/", "ui/src/", "ui/test/", "fixtures/", "schemas/"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.SubprocessError, subprocess.CalledProcessError) as exc:
        return [f"git is unavailable to check structural change: {exc}"]
    return [f"structural change since {base_sha}: {path}" for path in diff.stdout.splitlines() if path]


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
        match = _ROOTED_PATH_PATTERN.search(line) or _HOME_OR_DRIVE_PATH.search(line)
        if match:
            offences.append(f"line {line_number}: rooted path {match.group(0)!r}")
    return offences


# --- the real checks ---------------------------------------------------------


def test_every_technical_term_resolves() -> None:
    text = _document_text()
    offences = technical_term_resolution_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_every_reference_resolves() -> None:
    text = _document_text()
    offences = all_reference_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_mapped_terms_are_referenced_from_more_than_one_place() -> None:
    text = _document_text()
    offences = mapped_term_reference_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_every_python_enum_is_documented() -> None:
    text = _document_text()
    offences = undocumented_enum_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_every_closed_typescript_vocabulary_is_documented() -> None:
    text = _document_text()
    offences = undocumented_ts_union_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_closed_members_match_the_source() -> None:
    text = _document_text()
    offences = closed_member_offences(text, REPO_ROOT)
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


def test_candidate_verdict_agrees_with_the_epistemic_register() -> None:
    text = _document_text()
    offences = verdict_disagreement_offences(text)
    assert not offences, "\n".join(offences)


def test_no_technical_term_is_silently_unmapped() -> None:
    text = _document_text()
    offences = unmapped_technical_term_offences(text)
    assert not offences, "\n".join(offences)


def test_no_technical_term_is_both_mapped_and_left_technical() -> None:
    text = _document_text()
    offences = double_membership_offences(text)
    assert not offences, "\n".join(offences)


def test_excluded_vocabulary_is_confined_to_the_excluded_section() -> None:
    text = _document_text()
    offences = excluded_vocabulary_leak_offences(text)
    assert not offences, "\n".join(offences)


def test_canonical_layer_excludes_the_metaphor_vocabulary() -> None:
    offences = canonical_layer_excluded_vocabulary_offences(REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_adopted_terms_name_no_renderer() -> None:
    text = _document_text()
    offences = renderer_named_adopted_term_offences(text)
    assert not offences, "\n".join(offences)


def test_the_document_carries_no_rooted_path() -> None:
    text = _document_text()
    offences = rooted_path_offences(text)
    assert not offences, "\n".join(offences)


def test_adoption_changed_no_structure() -> None:
    offences = structural_change_offences(REPO_ROOT)
    assert not offences, "\n".join(offences)


def defect_count_offences(text: str) -> list[str]:
    """The prose count of published defects agrees with the table it counts.

    This count is enforced rather than printed, as are the ones the rendered-state
    channel check binds. The counts that stay unpinned move on purpose — a limitations list should grow — and pinning
    those would punish the honesty they exist to record. This one must not
    move independently of its own table: a row added without the sentence
    changing leaves the document contradicting itself, which is precisely the
    class the table is about.
    """
    rows = 0
    for line in extract_section(text, "untruthful").splitlines():
        if _UNTRUTHFUL_ROW.match(line):
            rows += 1
    offences = []
    if rows == 0:
        offences.append("the untruthful table has no rows, so nothing counts it")
    for spelled, value in _NUMBER_WORDS.items():
        if f"{spelled} of them are recorded above as" in text and value != rows:
            offences.append(f"prose says {spelled} defects, the table has {rows}")
    if not any(f"{word} of them are recorded above as" in text for word in _NUMBER_WORDS):
        offences.append("no prose count of the defect table was found to check against it")
    return offences


_RENDERED_STATE_PROBE = """
import { DEFAULT_CALIBRATION } from "./src/engine/calibration.ts";
import { legalRenderedCombinations, renderedStateChannel } from "./src/scene/rendered-state.ts";

const channels = legalRenderedCombinations()
  .filter((carrier) => carrier !== null)
  .map((carrier) => ({
    carrier: carrier.map(({ enumType, member }) => `${enumType}.${member}`),
    value: renderedStateChannel(carrier, DEFAULT_CALIBRATION)?.lightnessDeltaPermille,
  }));

process.stdout.write(JSON.stringify(channels));
""".strip()

_CURRENT_RENDERED_STATE_OPEN = "<!-- rendered-state:current-channel -->"
_CURRENT_RENDERED_STATE_CLOSE = "<!-- /rendered-state:current-channel -->"
_PUBLISHED_RENDERED_STATE_ROW = re.compile(r"^ +(-?\d+)   ([a-z+]+)$", re.MULTILINE)


def _rendered_state_channel_rows(repo_root: Path) -> list[tuple[int, str]]:
    """Exercise the renderer's derived legal domain and its exported composition.

    This deliberately does not duplicate positional arithmetic in Python. The
    probe bundles `ui/src/scene/rendered-state.ts`, calls
    `legalRenderedCombinations`, and resolves each non-null carrier through
    `renderedStateChannel`. Changing either the renderer's domain or its
    composition therefore changes the rows the document is required to state.
    """
    ui_root = repo_root / "ui"
    esbuild = ui_root / "node_modules" / ".bin" / "esbuild"
    if not esbuild.is_file():
        raise AssertionError("the rendered-state document guard requires ui/node_modules/.bin/esbuild")

    bundled = subprocess.run(
        [
            str(esbuild),
            "--bundle",
            "--platform=node",
            "--format=esm",
            "--target=node24",
            "--sourcefile=vocabulary-rendered-state-probe.ts",
        ],
        cwd=ui_root,
        input=_RENDERED_STATE_PROBE,
        text=True,
        capture_output=True,
        check=False,
    )
    if bundled.returncode != 0:
        raise AssertionError(f"could not bundle the rendered-state probe: {bundled.stderr.strip()}")

    executed = subprocess.run(
        ["node", "--input-type=module"],
        cwd=ui_root,
        input=bundled.stdout,
        text=True,
        capture_output=True,
        check=False,
    )
    if executed.returncode != 0:
        raise AssertionError(f"could not execute the rendered-state probe: {executed.stderr.strip()}")
    try:
        output = json.loads(executed.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"the rendered-state probe did not emit JSON: {executed.stdout!r}") from error
    if not isinstance(output, list):
        raise AssertionError("the rendered-state probe did not emit a carrier list")

    rows: list[tuple[int, str]] = []
    for item in output:
        if not isinstance(item, dict):
            raise AssertionError(f"the rendered-state probe emitted a non-object row: {item!r}")
        carrier, value = item.get("carrier"), item.get("value")
        if not isinstance(carrier, list) or not carrier or not all(isinstance(member, str) for member in carrier):
            raise AssertionError(f"the rendered-state probe emitted an invalid carrier: {carrier!r}")
        if not isinstance(value, int):
            raise AssertionError(f"the rendered-state probe emitted a non-integer channel: {value!r}")
        members = []
        for member in carrier:
            _, separator, short_name = member.partition(".")
            if not separator or not short_name:
                raise AssertionError(f"the rendered-state probe emitted an unqualified member: {member!r}")
            members.append(short_name)
        rows.append((value, "+".join(members)))
    return rows


def _published_rendered_state_rows(text: str) -> list[tuple[int, str]]:
    start = text.find(_CURRENT_RENDERED_STATE_OPEN)
    end = text.find(_CURRENT_RENDERED_STATE_CLOSE)
    if start == -1 or end == -1 or end < start:
        return []
    block = text[start + len(_CURRENT_RENDERED_STATE_OPEN) : end]
    return [(int(value), carrier) for value, carrier in _PUBLISHED_RENDERED_STATE_ROW.findall(block)]


def rendered_state_channel_offences(text: str, repo_root: Path) -> list[str]:
    """The document's current channel table matches the actual renderer output."""
    actual = _rendered_state_channel_rows(repo_root)
    published = _published_rendered_state_rows(text)
    offences: list[str] = []

    if not published:
        offences.append("the current rendered-state table is absent, so renderer output was not compared")
    elif published != actual:
        offences.append(f"the document's current rendered-state table is {published}; the renderer produces {actual}")

    values = [value for value, _ in actual]
    if len(actual) != 12 or len(set(values)) != 12:
        offences.append(f"the renderer produces {len(actual)} governed carriers over {len(set(values))} values, not twelve injective values")
    elif any(current - previous != 4 for previous, current in zip(values, values[1:])):
        offences.append(f"the renderer's values are not one contiguous four-permille band: {values}")

    current_claim = (
        "The **twelve** legal governed\n"
        "combinations resolve to **twelve** distinct values, contiguous with the assertion band"
    )
    if current_claim not in text:
        offences.append("the document no longer states the twelve-value contiguous-band claim")
    if (
        "whole derived\n"
        "domain from the pinned vocabulary"
    ) not in text:
        offences.append("the document no longer states that the criterion derives its whole domain from the pinned vocabulary")
    if (
        "It does not reproduce an arithmetic in the\n"
        "test."
    ) not in text:
        offences.append("the document no longer states that the criterion exercises the renderer instead of copying arithmetic")
    return offences


def test_the_rendered_state_check_detects_a_falsified_table_row() -> None:
    # The same source-bound function the real check calls, against a document
    # whose current table lies about a carrier. The renderer remains the only
    # source of the expected row.
    text = _document_text().replace(
        "    -20   accepted+derived",
        "    -20   accepted+explicit",
        1,
    )
    offences = rendered_state_channel_offences(text, REPO_ROOT)
    assert offences, "the control should have offended"
    print(f"rendered-state rebound control observed: {offences[0]}")


def test_the_rendered_state_check_detects_a_falsified_channel_value() -> None:
    text = _document_text().replace("    -20   accepted+derived", "    -21   accepted+derived", 1)
    assert rendered_state_channel_offences(text, REPO_ROOT), "the control should have offended"


def test_the_rendered_state_check_detects_a_contradicting_spelled_count() -> None:
    text = _document_text().replace(
        "The **twelve** legal governed\ncombinations resolve to **twelve** distinct values, contiguous with the assertion band",
        "The **twelve** legal governed\ncombinations resolve to **eleven** distinct values, contiguous with the assertion band",
        1,
    )
    assert rendered_state_channel_offences(text, REPO_ROOT), "the control should have offended"


def test_the_rooted_path_check_detects_a_home_relative_path() -> None:
    # Assembled from split literals for the same reason the POSIX control is: a
    # tracked byte carrying one of these shapes is exactly what the repository's
    # own safety scan refuses, so the test proving the rule works would break it.
    # The first draft of this control did precisely that and the scan caught it.
    sample = "A path such as " + "~" + "/Desk" + "top/notes must never appear."
    assert rooted_path_offences(sample), "the control should have produced an offence"


def test_the_rooted_path_check_detects_a_drive_letter_path() -> None:
    sample = "A path such as " + "C:" + chr(92) + "Users" + chr(92) + "me must never appear."
    assert rooted_path_offences(sample), "the control should have produced an offence"


def test_the_published_rendered_state_composition_matches_the_renderer() -> None:
    text = _document_text()
    offences = rendered_state_channel_offences(text, REPO_ROOT)
    assert not offences, "\n".join(offences)


def test_the_rendered_state_check_detects_a_count_that_has_drifted() -> None:
    # The same source-bound function, against the real document with one
    # cardinality moved. The table and the prose must agree with the renderer.
    text = _document_text().replace("**twelve** distinct values", "**eleven** distinct values", 1)
    offences = rendered_state_channel_offences(text, REPO_ROOT)
    assert offences, "the control should have produced an offence"


def test_the_defect_count_agrees_with_the_defect_table() -> None:
    text = _document_text()
    offences = defect_count_offences(text)
    assert not offences, "\n".join(offences)


def test_the_defect_count_detects_prose_that_has_drifted_from_its_table() -> None:
    # The same function the real check calls, against the real document with one
    # numeral moved. A row added without the sentence changing produces the same
    # offence, which is the case this exists for.
    text = _document_text().replace(
        "Fifteen of them are recorded above as", "Fourteen of them are recorded above as", 1
    )
    offences = defect_count_offences(text)
    assert offences, "the control should have produced an offence"


def test_undetected_vocabulary_shapes_is_a_populated_honest_list() -> None:
    assert UNDETECTED_VOCABULARY_SHAPES, "an empty list would claim total coverage this module does not have"
    for shape in UNDETECTED_VOCABULARY_SHAPES:
        assert isinstance(shape, str) and shape.strip(), f"blank or non-string limitation entry: {shape!r}"


# --- controls: the same functions, run against a fixture built to fail ------


def test_every_technical_term_resolves_detects_a_stale_line_reference() -> None:
    text = _fixture_text("technical_stale_reference.md")
    offences = technical_term_resolution_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_technical_term_resolves_detects_a_substring_only_definition() -> None:
    # `Outcome` is pointed at `class GateOutcome(Enum):` in the real tree — a
    # genuine line that contains "Outcome" as a substring but does not define
    # it. The old substring test passed this; the definition-anchored one must
    # not.
    text = _fixture_text("technical_substring_definition.md")
    offences = technical_term_resolution_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_reference_resolves_detects_an_unresolvable_reference_outside_the_technical_table() -> None:
    text = _fixture_text("reference_untracked_reference.md")
    offences = all_reference_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_python_enum_is_documented_detects_a_missing_enum() -> None:
    text = _fixture_text("technical_empty.md")
    offences = undocumented_enum_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_closed_typescript_vocabulary_is_documented_detects_a_missing_union() -> None:
    text = _fixture_text("technical_empty.md")
    offences = undocumented_ts_union_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_module_level_string_union_names_detects_widened_shapes() -> None:
    # Points the totality scanner itself at a small synthetic tree exercising
    # every shape the old glob-only, double-quote-only, non-recursive scanner
    # missed: single-quoted unions, parenthesized unions, the
    # `typeof OBJ[keyof typeof OBJ]` shape, and a nested subdirectory.
    names = _module_level_string_union_names(FIXTURE_DIR / "ts_scanner_shapes")
    expected = {"SingleQuotedUnion", "ParenthesizedUnion", "ConfigRule", "NestedUnion"}
    assert expected <= names, f"expected {expected} within {names}"


def test_module_level_enum_names_detects_an_aliased_import_in_a_subdirectory() -> None:
    # Points the enum scanner at a synthetic tree where the Enum class both
    # sits in a subdirectory (recursion) and is declared against an aliased
    # import (`from enum import Enum as _AliasedEnum`), neither of which the
    # old glob-only, substring-matching scanner would have found.
    names = _module_level_enum_names(FIXTURE_DIR / "python_scanner_shapes")
    assert "NestedAliasedKind" in names


def test_closed_members_match_the_source_detects_a_fabricated_member() -> None:
    text = _fixture_text("technical_closed_members_mismatch.md")
    offences = closed_member_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_closed_members_match_the_source_detects_a_qualified_member_mismatch() -> None:
    text = _fixture_text("technical_closed_members_qualified_mismatch.md")
    offences = closed_member_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_closed_members_match_the_source_detects_an_unresolvable_term() -> None:
    text = _fixture_text("technical_closed_members_unresolved.md")
    offences = closed_member_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_candidate_records_are_complete_detects_a_missing_label() -> None:
    text = _fixture_text("candidates_missing_label.md")
    offences = incomplete_candidate_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_candidate_records_are_complete_detects_a_pre_criterion_failure_marker() -> None:
    # "Failed at: Q1" was the old accepted shape. The published criteria are
    # C1/C2/C3, so a gate-style marker must now be rejected even though it is
    # well-formed by the old rule.
    text = _fixture_text("candidates_failed_at_invalid.md")
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


def test_no_technical_term_is_both_mapped_and_left_technical_detects_a_double_membership() -> None:
    text = _fixture_text("technical_double_membership.md")
    offences = double_membership_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_excluded_vocabulary_is_confined_to_the_excluded_section_detects_a_leak() -> None:
    text = _fixture_text("excluded_leak.md")
    offences = excluded_vocabulary_leak_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_canonical_layer_excludes_the_metaphor_vocabulary_detects_a_leak() -> None:
    offences = canonical_layer_excluded_vocabulary_offences(FIXTURE_DIR / "excluded_vocabulary_source_tree")
    assert offences, "the control fixture should have produced an offence"


def test_adopted_terms_name_no_renderer_detects_a_renderer_named_adopted_term() -> None:
    text = _fixture_text("epistemic_renderer_named.md")
    offences = renderer_named_adopted_term_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_adopted_terms_name_no_renderer_detects_a_widened_renderer_fragment() -> None:
    # "canvas" was already denied by the original seven-fragment list. This
    # pins one of the newly added fragments so the widened list is exercised
    # rather than merely declared.
    text = _fixture_text("epistemic_renderer_named_widened.md")
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


def test_mapped_terms_are_referenced_from_more_than_one_place_detects_a_single_reference() -> None:
    text = _fixture_text("epistemic_single_reference_term.md")
    offences = mapped_term_reference_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_candidate_verdict_agrees_with_the_epistemic_register_detects_a_flip() -> None:
    text = _fixture_text("candidates_verdict_disagreement.md")
    offences = verdict_disagreement_offences(text)
    assert offences, "the control fixture should have produced an offence"


def test_every_reference_resolves_detects_a_meaning_mismatch() -> None:
    # A candidate or defect-table reference can drift to an unrelated but
    # otherwise valid line and an existence-only check would never notice.
    # This fixture cites a real, non-blank line that simply does not contain
    # the identifier named alongside the reference.
    text = _fixture_text("reference_meaning_mismatch.md")
    offences = all_reference_offences(text, REPO_ROOT)
    assert offences, "the control fixture should have produced an offence"


def test_every_reference_resolves_records_the_existence_only_fallback() -> None:
    # A reference with no backticked identifier anywhere in its scope has
    # nothing to check its meaning against, so it falls back to the existence
    # check alone — and that fallback must be recorded, not silently treated
    # as equivalent to the stronger check.
    text = _fixture_text("reference_existence_only_fallback.md")
    offences = all_reference_offences(text, REPO_ROOT)
    assert not offences, "the reference is real and should resolve on existence alone"
    assert REFERENCES_CHECKED_BY_EXISTENCE_ONLY == ["src/nous_os/canonical.py:42"]


def _run_git(arguments: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, text=True, check=True).stdout


def _init_scratch_repo(repo: Path) -> None:
    repo.mkdir()
    _run_git(["init", "-q"], repo)
    _run_git(["config", "user.email", "scratch@localhost"], repo)
    _run_git(["config", "user.name", "scratch"], repo)


def test_structural_change_offences_detects_a_real_diff(tmp_path: Path) -> None:
    repo = tmp_path / "diff_repo"
    _init_scratch_repo(repo)
    source = repo / "src"
    source.mkdir()
    (source / "example.py").write_text("value = 1\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "base"], repo)
    base_sha = _run_git(["rev-parse", "HEAD"], repo).strip()
    (source / "example.py").write_text("value = 2\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "structural change"], repo)
    offences = structural_change_offences(repo, base_sha=base_sha, head="HEAD")
    assert offences, "the control repository's real diff should have produced an offence"


def test_structural_change_offences_detects_a_non_ancestor_base(tmp_path: Path) -> None:
    repo = tmp_path / "non_ancestor_repo"
    _init_scratch_repo(repo)
    (repo / "README.md").write_text("root\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "root"], repo)
    base_sha = _run_git(["rev-parse", "HEAD"], repo).strip()
    _run_git(["checkout", "-q", "--orphan", "unrelated"], repo)
    _run_git(["rm", "-rf", "-q", "."], repo)
    (repo / "OTHER.md").write_text("other\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "unrelated root"], repo)
    offences = structural_change_offences(repo, base_sha=base_sha, head="HEAD")
    assert offences, "a base that is not an ancestor of HEAD must be an offence, never a silent pass"


def test_structural_change_offences_refuses_a_pinned_head_off_the_live_history(tmp_path: Path) -> None:
    # The pinned pair must not keep answering from an abandoned branch. Both
    # objects stay readable after a rewrite, and their diff would stay green
    # while describing a tree nobody is on.
    repo = tmp_path / "orphaned_head_repo"
    _init_scratch_repo(repo)
    source = repo / "src"
    source.mkdir()
    (source / "example.py").write_text("value = 1\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "base"], repo)
    base_sha = _run_git(["rev-parse", "HEAD"], repo).strip()
    live_branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], repo).strip()
    _run_git(["checkout", "-q", "-b", "abandoned"], repo)
    (source / "example.py").write_text("value = 2\n", encoding="utf-8")
    _run_git(["add", "."], repo)
    _run_git(["commit", "-q", "-m", "abandoned tip"], repo)
    abandoned_head = _run_git(["rev-parse", "HEAD"], repo).strip()
    _run_git(["checkout", "-q", live_branch], repo)
    offences = structural_change_offences(repo, base_sha=base_sha, head=abandoned_head)
    assert offences, "a pinned head off the live history must be an offence, never a silent pass"
    assert any("not an ancestor of HEAD" in offence for offence in offences)


def test_module_level_enum_names_detects_every_closed_vocabulary_base() -> None:
    # The old base test recognised only the literal word "Enum". Every
    # closed-vocabulary base the standard `enum` module exports — StrEnum,
    # IntEnum, IntFlag, Flag, ReprEnum — plain or dotted, must be recognised.
    names = _module_level_enum_names(FIXTURE_DIR / "python_scanner_shapes")
    expected = {"PlainStrEnum", "PlainIntEnum", "PlainIntFlag", "PlainFlag", "PlainReprEnum", "DottedStrEnum"}
    assert expected <= names, f"expected {expected} within {names}"


def test_module_level_string_union_names_detects_tight_spacing_and_a_comment() -> None:
    # `export type Tight="a"|"b";` has no whitespace around `=`, and a union
    # body containing `/* comment */` between literals used to fail to parse.
    names = _module_level_string_union_names(FIXTURE_DIR / "ts_scanner_shapes")
    expected = {"TightSpacing", "CommentedUnion"}
    assert expected <= names, f"expected {expected} within {names}"
