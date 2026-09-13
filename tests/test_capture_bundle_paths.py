"""Path resolution that never follows a link anywhere in the chain, and every entry below the root mentioned."""
from __future__ import annotations

import errno
import os
import shutil
from pathlib import Path

import pytest

from nous_os import capture_bundle
from nous_os.capture_bundle import BundleFormatError, BundleRefusal, inventory, normalize
from nous_os.identity import digest_bytes

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "capture-bundle"
PROVIDER, ACCOUNT, ACCOUNT_BASIS = "bundle-source", "account-1", "native-conversation-account"


def _copy(tmp_path: Path, name: str = "bundle") -> Path:
    target = tmp_path / name
    shutil.copytree(FIXTURE, target)
    return target


def _normalize(inv):
    return normalize(inv, provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS)


def _declare(root: Path, relative: str) -> None:
    import json
    data = (root / relative).read_bytes()
    manifest = root / "INPUT_MANIFEST.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["files"].append({"path": relative, "bytes": len(data), "sha256": digest_bytes(data), "source_kind": "keeper_note", "sensitivity": "synthetic"})
    manifest.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def test_a_bundle_root_that_is_a_link_is_refused(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    link = tmp_path / "bundle-link"
    link.symlink_to(root)

    with pytest.raises(BundleFormatError):
        inventory(link)


def test_a_declared_path_below_a_linked_directory_is_never_read(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "borrowed.txt").write_text("borrowed words that live outside the bundle\n", encoding="utf-8")
    (root / "documents" / "jump").symlink_to(outside)
    _declare(root, "documents/jump/borrowed.txt")

    normalized = _normalize(inventory(root))
    records = tuple(normalized.records)

    assert all(record.external_id != "documents/jump/borrowed.txt" for record in records), "bytes were read through a linked ancestor"
    refusals = [(item.locator, item.refusal) for item in normalized.refusals]
    assert any(refusal is BundleRefusal.SYMLINK_REFUSED and locator in {"documents/jump", "documents/jump/borrowed.txt"} for locator, refusal in refusals), refusals


def test_an_undeclared_empty_directory_is_refused_and_counted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "empty-directory").mkdir()

    normalized = _normalize(inventory(root))
    tuple(normalized.records)
    refusals = [(item.locator, item.refusal) for item in normalized.refusals]
    assert ("documents/empty-directory", BundleRefusal.NOT_A_REGULAR_FILE) in refusals, refusals
    assert normalized.counters["not_regular_files"] == 1


def test_an_open_that_fails_because_the_path_is_a_socket_is_a_refusal_not_an_exception(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy(tmp_path)
    inv = inventory(root)
    target = root / "documents" / "watch.txt"
    real_open = os.open

    def socket_like_open(path, flags, *args, **kwargs):
        if os.fspath(path).endswith("watch.txt") or (args and os.fspath(path) == "watch.txt"):
            raise OSError(errno.ENXIO, "No such device or address")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", socket_like_open)

    normalized = _normalize(inv)
    records = tuple(normalized.records)
    assert all(record.external_id != "documents/watch.txt" for record in records)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.NOT_A_REGULAR_FILE) == 1


def test_without_o_nofollow_even_an_ordinary_bundle_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _copy(tmp_path)
    monkeypatch.delattr(os, "O_NOFOLLOW")

    with pytest.raises(BundleFormatError) as refusal:
        inventory(root)
    assert "O_NOFOLLOW" in str(refusal.value)


def test_a_manifest_of_exactly_the_bound_is_accepted(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    manifest = root / "INPUT_MANIFEST.json"
    bound = capture_bundle.MAX_MANIFEST_BYTES
    padding = bound - manifest.stat().st_size
    assert padding > 0
    with open(manifest, "ab") as handle:
        handle.write(b" " * padding)
    assert manifest.stat().st_size == bound

    inv = inventory(root)
    assert inv.manifest_name == "INPUT_MANIFEST.json"
