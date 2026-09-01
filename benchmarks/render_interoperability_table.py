"""Render the published-operation table from its single declared source.

Keeping this rendering here gives maintainers one repeatable way to update the
document when the published catalogue changes.
"""

from __future__ import annotations

from pathlib import Path
import sys

if __package__ in (None, ""):
    _REPOSITORY = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(_REPOSITORY / "src"))

from nous_os import core


_HEADER = "| Operation | Tier | Summary | Parameters (`?` = optional) |"
_DIVIDER = "| --- | --- | --- | --- |"


def render_table() -> str:
    """Keep the documentation's published surface tied to the catalogue."""
    rows = (_HEADER, _DIVIDER, *( _render_row(descriptor) for descriptor in core.CATALOGUE))
    return "\n".join(rows)


def _render_row(descriptor: core.OperationDescriptor) -> str:
    parameters = ", ".join(
        parameter.name if parameter.required else f"{parameter.name}?"
        for parameter in descriptor.parameters
    )
    rendered_parameters = parameters or "(none)"
    return (
        f"| `{descriptor.external_name}` | {descriptor.tier.value} | {descriptor.summary} "
        f"| {rendered_parameters} |"
    )


if __name__ == "__main__":
    print(render_table())
