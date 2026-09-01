"""Keep the published-operation table from becoming an independent copy."""

from __future__ import annotations

from pathlib import Path

from benchmarks.render_interoperability_table import render_table


_REPOSITORY = Path(__file__).resolve().parent.parent
_DOCUMENT = _REPOSITORY / "docs" / "INTEROPERABILITY.md"
_TABLE_START = "| Operation | Tier | Summary | Parameters (`?` = optional) |"


def _document_table() -> str:
    """Limit comparison to the one table whose source the document identifies."""
    document = _DOCUMENT.read_text(encoding="utf-8")
    start = document.index(_TABLE_START)
    end = document.index("\n\n", start)
    return document[start:end]


def test_published_operation_table_matches_the_catalogue() -> None:
    assert _document_table() == render_table()
