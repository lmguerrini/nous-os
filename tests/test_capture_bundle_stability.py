"""Optional rendered metadata kept as given, a walk that survives any depth, and a bundle that changes under the reader refused loudly."""
from __future__ import annotations

import errno
import json
import os
import shutil
import time
from pathlib import Path

import pytest

from nous_os import capture_bundle
from nous_os.capture_bundle import BundleFormatError, BundleRefusal, inventory, normalize
from nous_os.identity import digest_bytes
from nous_os.sources import SourceKind

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "capture-bundle"
PROVIDER, ACCOUNT, ACCOUNT_BASIS = "bundle-source", "account-1", "native-conversation-account"


def _copy(tmp_path: Path, name: str = "bundle") -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURE, target)
    return target


def _normalize(inv):
    return normalize(inv, provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS)


def _edit_json(path: Path, transform) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    transform(value)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _update_declaration(root: Path, relative: str) -> None:
    data = (root / relative).read_bytes()

    def change(manifest: dict) -> None:
        entry = next(entry for entry in manifest["files"] if entry["path"] == relative)
        entry["bytes"] = len(data)
        entry["sha256"] = digest_bytes(data)

    _edit_json(root / "INPUT_MANIFEST.json", change)


# ------------------------------------------------------------

def test_a_window_whose_button_has_no_label_keeps_its_messages(tmp_path: Path) -> None:
    """Button labels are rendered-interface metadata: optional, recorded as given; the window's messages are the evidence."""
    root = _copy(tmp_path)

    def null_label(capture: dict) -> None:
        capture["branches"][0]["buttons"][0]["label"] = None

    _edit_json(root / "capture" / "interface.json", null_label)
    _update_declaration(root, "capture/interface.json")
    baseline = tuple(normalize(inventory(_copy(tmp_path, "pristine")), provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS).records)

    normalized = _normalize(inventory(root))
    records = tuple(normalized.records)

    assert BundleRefusal.MALFORMED_CAPTURE not in {item.refusal for item in normalized.refusals}
    assert normalized.counters["windows"] == 3
    assert {r.external_id for r in records if r.kind is SourceKind.CAPTURED_MESSAGE} == {r.external_id for r in baseline if r.kind is SourceKind.CAPTURED_MESSAGE}
    window = next(r for r in records if r.kind is SourceKind.CAPTURE_WINDOW and r.external_id.endswith("#0"))
    assert window.payload["buttons"][0]["label"] is None  # recorded as given, not invented


def test_a_button_that_is_not_an_object_is_still_malformed(tmp_path: Path) -> None:
    root = _copy(tmp_path)

    def bad_button(capture: dict) -> None:
        capture["branches"][0]["buttons"].append("not-a-button")

    _edit_json(root / "capture" / "interface.json", bad_button)
    _update_declaration(root, "capture/interface.json")

    normalized = _normalize(inventory(root))
    tuple(normalized.records)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.MALFORMED_CAPTURE) == 1


# ------------------------------------------------------------

def test_a_deeply_nested_undeclared_tree_is_walked_without_recursion_or_descriptor_exhaustion(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    parent = os.open(root / "documents", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for level in range(1100):
            os.mkdir("d", dir_fd=parent)
            child = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent)
            os.close(parent)
            parent = child
    finally:
        os.close(parent)
    probe = os.open(os.devnull, os.O_RDONLY)
    os.close(probe)
    started = time.perf_counter()

    normalized = _normalize(inventory(root))
    tuple(normalized.records)

    assert time.perf_counter() - started < 20.0
    again = os.open(os.devnull, os.O_RDONLY)
    os.close(again)
    assert again == probe  # no descriptor leaked: the next free number is the same
    refusals = [(item.locator, item.refusal) for item in normalized.refusals]
    assert any(refusal is BundleRefusal.NOT_A_REGULAR_FILE and locator.startswith("documents/d/") for locator, refusal in refusals), refusals[:3]


# ------------------------------------------------------------

def test_an_entry_that_changes_while_being_classified_is_an_unstable_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "leaf.txt").write_text("outside words\n", encoding="utf-8")
    (root / "documents" / "race").symlink_to(outside)
    real_open = os.open
    fired = {"done": False}

    def racing_open(path, flags, *args, **kwargs):
        if os.fspath(path) == "race" and not fired["done"] and (flags & os.O_DIRECTORY):
            fired["done"] = True
            try:
                real_open(path, flags, *args, **kwargs)
            except OSError as error:
                (root / "documents" / "race").unlink()
                (root / "documents" / "race").write_text("now a regular file\n", encoding="utf-8")
                raise error
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", racing_open)

    with pytest.raises(BundleFormatError) as refusal:
        normalized = _normalize(inventory(root))
        tuple(normalized.records)
    assert "not stable" in str(refusal.value)


def test_an_entry_that_vanishes_during_the_walk_is_an_unstable_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "gone.txt").write_text("about to vanish\n", encoding="utf-8")
    real_open = os.open

    def vanishing_open(path, flags, *args, **kwargs):
        if os.fspath(path) == "gone.txt" and (root / "documents" / "gone.txt").exists():
            (root / "documents" / "gone.txt").unlink()
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", vanishing_open)

    with pytest.raises(BundleFormatError) as refusal:
        normalized = _normalize(inventory(root))
        tuple(normalized.records)
    assert "not stable" in str(refusal.value)


# ------------------------------------------------------------

def test_a_late_link_is_named_even_for_a_file_that_mismatched_at_inventory(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "watch.txt").write_bytes(b"wrong during inventory")
    inv = inventory(root)
    outside = tmp_path / "outside-documents"
    shutil.copytree(root / "documents", outside)
    shutil.rmtree(root / "documents")
    (root / "documents").symlink_to(outside, target_is_directory=True)

    normalized = _normalize(inv)
    tuple(normalized.records)
    refusals = [item.refusal for item in normalized.refusals if item.locator == "documents/watch.txt"]
    assert BundleRefusal.SYMLINK_REFUSED in refusals, refusals
