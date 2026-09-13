"""Links named as links wherever they appear in a declared path, every not-a-regular-file errno, and canonical declared paths."""
from __future__ import annotations

import errno
import json
import os
import shutil
from pathlib import Path

import pytest

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


def _declare(root: Path, relative: str, *, data: bytes | None = None) -> None:
    data = (root / relative).read_bytes() if data is None else data
    manifest = root / "INPUT_MANIFEST.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["files"].append({"path": relative, "bytes": len(data), "sha256": digest_bytes(data), "source_kind": "keeper_note", "sensitivity": "synthetic"})
    manifest.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def test_a_declared_leaf_below_a_linked_directory_is_refused_as_a_link(tmp_path: Path) -> None:
    """The leaf's own refusal names the link, not a missing file."""
    root = _copy(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "leaf.txt").write_text("leaf words outside the bundle\n", encoding="utf-8")
    (root / "documents" / "mid").symlink_to(outside)
    _declare(root, "documents/mid/leaf.txt")

    normalized = _normalize(inventory(root))
    tuple(normalized.records)
    refusals = {item.locator: item.refusal for item in normalized.refusals}
    assert refusals.get("documents/mid/leaf.txt") is BundleRefusal.SYMLINK_REFUSED, refusals
    assert BundleRefusal.MISSING_DECLARED_FILE not in refusals.values()


def test_a_directory_replaced_by_a_link_after_inventory_refuses_its_files_as_links(tmp_path: Path) -> None:
    """Normalize-time reads resolve through descriptors too: a linked ancestor swapped in later is a link refusal."""
    root = _copy(tmp_path)
    inv = inventory(root)
    outside = tmp_path / "outside-documents"
    shutil.copytree(root / "documents", outside)
    shutil.rmtree(root / "documents")
    (root / "documents").symlink_to(outside)

    normalized = _normalize(inv)
    records = tuple(normalized.records)
    assert not any(record.external_id.startswith("documents/") for record in records)
    refusals = [item.refusal for item in normalized.refusals if item.locator.startswith("documents/")]
    assert refusals and all(refusal is BundleRefusal.SYMLINK_REFUSED for refusal in refusals), refusals


def test_a_linked_bundle_root_is_refused_by_name(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    link = tmp_path / "bundle-link"
    link.symlink_to(root)

    with pytest.raises(BundleFormatError) as refusal:
        inventory(link)
    assert BundleRefusal.SYMLINK_REFUSED.value in str(refusal.value)


@pytest.mark.parametrize("code", [errno.EOPNOTSUPP, errno.ENODEV, errno.EISDIR])
def test_every_not_a_regular_file_errno_is_classified(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: int) -> None:
    root = _copy(tmp_path)
    inv = inventory(root)
    real_open = os.open

    def failing_open(path, flags, *args, **kwargs):
        if os.fspath(path) == "watch.txt":
            raise OSError(code, os.strerror(code))
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", failing_open)

    normalized = _normalize(inv)
    tuple(normalized.records)
    assert [item.refusal for item in normalized.refusals].count(BundleRefusal.NOT_A_REGULAR_FILE) == 1


def test_a_declared_path_with_a_dot_component_is_refused_as_malformed(tmp_path: Path) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "extra.txt").write_text("extra words\n", encoding="utf-8")
    _declare(root, "documents/./extra.txt", data=(root / "documents" / "extra.txt").read_bytes())

    with pytest.raises(BundleFormatError):
        inventory(root)


def test_a_declared_path_with_an_empty_component_is_refused_as_malformed(
    tmp_path: Path,
) -> None:
    root = _copy(tmp_path)
    (root / "documents" / "extra.txt").write_text("extra words\n", encoding="utf-8")
    _declare(root, "documents//extra.txt", data=(root / "documents" / "extra.txt").read_bytes())

    with pytest.raises(BundleFormatError):
        inventory(root)


@pytest.mark.parametrize("forbidden", ["\x01", "\x1f", "\u2028"])
def test_declared_path_controls_are_refused_before_a_filesystem_lookup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, forbidden: str
) -> None:
    root = _copy(tmp_path)
    manifest = root / "INPUT_MANIFEST.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    value["files"].append(
        {
            "path": f"documents/control{forbidden}name.txt",
            "bytes": 1,
            "sha256": "0" * 64,
            "source_kind": "keeper_note",
            "sensitivity": "synthetic",
        }
    )
    manifest.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    real_lstat = os.lstat

    def no_control_lookup(path, *args, **kwargs):
        if type(path) is str and forbidden in path:
            pytest.fail("a forbidden declared path reached lstat")
        return real_lstat(path, *args, **kwargs)

    monkeypatch.setattr(os, "lstat", no_control_lookup)
    with pytest.raises(BundleFormatError, match="control characters|Unicode line separator"):
        inventory(root)
