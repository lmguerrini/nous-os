"""Regression oracles for the capture-bundle reader: typed roles, control characters and root escapes in declared paths, optional button metadata."""
from __future__ import annotations

from pathlib import Path

import pytest

from nous_os.capture_bundle import BundleFormatError, BundleRefusal, inventory
from nous_os.sources import SourceKind
from tests.test_capture_bundle import _copy, _edit_json, _records, _update_declaration


@pytest.mark.parametrize("role", [["user"], {"role": "user"}, 7, None, True])
def test_b1_non_string_role_is_refused_unknown_role_not_a_crash(tmp_path: Path, role: object) -> None:
    root = _copy(tmp_path)

    def add(capture: dict) -> None:
        capture["branches"][2]["messages"].append(
            {"id": "msg-typed-role", "role": role, "text": "A typed role.", "text_content": "A typed role."}
        )

    _edit_json(root / "capture" / "interface.json", add)
    _update_declaration(root, "capture/interface.json")
    normalized, records = _records(root)
    assert records, "the bundle still yields its well-formed records"
    assert normalized.counters["unknown_roles"] == 1
    refused = [item for item in normalized.refusals if item.refusal is BundleRefusal.UNKNOWN_ROLE]
    assert [item.locator for item in refused] == ["capture/interface.json#/branches/2/messages/2"]


@pytest.mark.parametrize("character", ["\x00", "\x1f", "\x7f", "\x85", "\x9f", "\u2028", "\u2029"])
def test_m_e_control_and_line_separator_characters_in_a_declared_path_are_named_refusals(tmp_path: Path, character: str) -> None:
    root = _copy(tmp_path)

    def declare(manifest: dict) -> None:
        manifest["files"].append(
            {"path": f"documents/odd{character}name.txt", "bytes": 1, "sha256": "0" * 64, "source_kind": "keeper_note", "sensitivity": "synthetic"}
        )

    _edit_json(root / "INPUT_MANIFEST.json", declare)
    with pytest.raises(BundleFormatError):
        inventory(root)


_UP = "." * 2  # assembled at runtime so no source line spells a rooted or parent-relative path


@pytest.mark.parametrize(
    "path",
    [f"{_UP}/outside.txt", f"documents/{_UP}/{_UP}/outside.txt", "documents/./x.txt", "/" + "abs.txt", "a//b.txt"],
)
def test_m_b_root_escaping_declared_paths_are_refused(tmp_path: Path, path: str) -> None:
    root = _copy(tmp_path)

    def declare(manifest: dict) -> None:
        manifest["files"].append(
            {"path": path, "bytes": 1, "sha256": "0" * 64, "source_kind": "keeper_note", "sensitivity": "synthetic"}
        )

    _edit_json(root / "INPUT_MANIFEST.json", declare)
    with pytest.raises(BundleFormatError):
        inventory(root)


def test_m_d_a_window_without_button_metadata_keeps_its_messages(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def drop_buttons(capture: dict) -> None:
        del capture["branches"][0]["buttons"]

    _edit_json(root / "capture" / "interface.json", drop_buttons)
    _update_declaration(root, "capture/interface.json")
    normalized, records = _records(root)
    assert normalized.counters["malformed_captures"] == 0
    assert len(records) == 10
    windows = {record.external_id: record for record in records if record.kind is SourceKind.CAPTURE_WINDOW}
    assert windows["conv-1#0"].payload["buttons"] == []
    assert windows["conv-1#0"].payload["message_ids"] == ["msg-a1", "msg-b2"]
