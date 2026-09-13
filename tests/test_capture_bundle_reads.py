"""Bundle reads that must refuse rather than trust a path: the manifest, platforms without O_NOFOLLOW, special files, hard links."""
from __future__ import annotations

import os
import shutil
import stat
import threading
from pathlib import Path

import pytest

from nous_os import capture_bundle
from nous_os.capture_bundle import BundleFormatError, BundleRefusal, inventory, normalize
from nous_os.identity import digest_bytes

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "synthetic" / "capture-bundle"
PROVIDER, ACCOUNT, ACCOUNT_BASIS = "bundle-source", "account-1", "native-conversation-account"


def _copy(tmp_path: Path) -> Path:
    target = tmp_path / "bundle"
    shutil.copytree(FIXTURE, target)
    return target


def _normalize(inv):
    return normalize(inv, provider=PROVIDER, account=ACCOUNT, account_basis=ACCOUNT_BASIS)


# --- the manifest is read outside the bounded no-follow reader (TOCTOU + unbounded) -----------------

def test_a_manifest_swapped_for_a_link_between_check_and_read_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """the manifest is opened with O_NOFOLLOW like every other file; a link at open is refused.

    The race is made deterministic: the path IS a link to an outside manifest, while the pre-checks answer as
    they did a moment earlier (regular file). Today `Path.read_bytes()` follows the link and the outside
    manifest is accepted."""
    root = _copy(tmp_path)
    manifest = root / "INPUT_MANIFEST.json"
    outside = tmp_path / "outside-manifest.json"
    outside.write_bytes(manifest.read_bytes())
    manifest.unlink()
    manifest.symlink_to(outside)
    monkeypatch.setattr(Path, "is_symlink", lambda self: False)
    monkeypatch.setattr(Path, "is_file", lambda self: True)

    with pytest.raises(BundleFormatError):
        inventory(root)


def test_a_manifest_over_the_manifest_bound_is_refused_without_being_read_whole(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """a manifest has its own bound (MAX_MANIFEST_BYTES ≤ 1 MiB); over it → refusal, never a whole read."""
    root = _copy(tmp_path)
    manifest = root / "INPUT_MANIFEST.json"
    bound = getattr(capture_bundle, "MAX_MANIFEST_BYTES", 1024 * 1024)
    with open(manifest, "ab") as handle:
        handle.write(b" " * (bound + 1))  # trailing whitespace keeps it valid JSON if it were parsed
    read_sizes: list[int] = []
    real_read = os.read

    def counting_read(fd: int, size: int) -> bytes:
        data = real_read(fd, size)
        read_sizes.append(len(data))
        return data

    monkeypatch.setattr(os, "read", counting_read)
    monkeypatch.setattr(Path, "read_bytes", lambda self: pytest.fail("the manifest was read whole through Path.read_bytes"))

    with pytest.raises(BundleFormatError):
        inventory(root)
    assert sum(read_sizes) <= bound + 1


# --- a platform without O_NOFOLLOW follows links -------------------------------------------------------

def test_without_o_nofollow_no_declared_file_is_read_through_a_link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """without O_NOFOLLOW the adapter refuses to read (explicit error naming the capability); it never follows."""
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    inv = inventory(root)
    outside = tmp_path / "equal-bytes.txt"
    outside.write_bytes(declared.read_bytes())
    declared.unlink()
    declared.symlink_to(outside)
    monkeypatch.delattr(os, "O_NOFOLLOW")

    try:
        normalized = _normalize(inv)
        records = tuple(normalized.records)
    except BundleFormatError as error:
        assert "O_NOFOLLOW" in str(error)
        return
    assert all(record.external_id != "documents/watch.txt" for record in records), "a link was followed without O_NOFOLLOW"
    assert BundleRefusal.SYMLINK_REFUSED in {item.refusal for item in normalized.refusals}


# --- a FIFO swapped in after inventory blocks the open; static non-regular paths are misclassified -----

def test_a_declared_file_swapped_for_a_fifo_is_refused_promptly(tmp_path: Path) -> None:
    """opening never blocks on a special file; the outcome is a counted NOT_A_REGULAR_FILE refusal."""
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    inv = inventory(root)
    declared.unlink()
    os.mkfifo(declared)
    outcome: dict = {}

    def run() -> None:
        try:
            normalized = _normalize(inv)
            outcome["records"] = tuple(normalized.records)
            outcome["refusals"] = [item.refusal for item in normalized.refusals]
        except Exception as error:  # noqa: BLE001 — recorded, asserted below
            outcome["error"] = error

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=3.0)
    assert not worker.is_alive(), "normalize blocked on the FIFO (no O_NONBLOCK at open)"
    assert "error" not in outcome, outcome.get("error")
    assert all(record.external_id != "documents/watch.txt" for record in outcome["records"])
    not_regular = getattr(BundleRefusal, "NOT_A_REGULAR_FILE", None)
    assert not_regular is not None, "no NOT_A_REGULAR_FILE refusal exists"
    assert outcome["refusals"].count(not_regular) == 1


def test_a_declared_path_that_is_a_directory_is_refused_as_not_regular(tmp_path: Path) -> None:
    """a declared path that is a directory (or FIFO) at inventory is NOT_A_REGULAR_FILE, not 'missing'."""
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    declared.unlink()
    declared.mkdir()

    normalized = _normalize(inventory(root))
    tuple(normalized.records)
    refusals = [item.refusal for item in normalized.refusals]
    not_regular = getattr(BundleRefusal, "NOT_A_REGULAR_FILE", None)
    assert not_regular is not None, "no NOT_A_REGULAR_FILE refusal exists"
    assert refusals.count(not_regular) == 1
    assert BundleRefusal.MISSING_DECLARED_FILE not in refusals


# --- a hard link to an outside file with matching bytes is accepted -----------------------------------

def test_a_declared_hard_link_is_refused_and_counted(tmp_path: Path) -> None:
    """a declared file whose link count is above 1 is refused (HARD_LINK_REFUSED, counted) — bytes shared
    with a path outside the bundle are not bundle evidence."""
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    outside = tmp_path / "outside-copy.txt"
    outside.write_bytes(declared.read_bytes())
    declared.unlink()
    os.link(outside, declared)
    assert declared.stat().st_nlink == 2

    normalized = _normalize(inventory(root))
    records = tuple(normalized.records)
    assert all(record.external_id != "documents/watch.txt" for record in records), "a hard-linked declared file was accepted"
    hard_link = getattr(BundleRefusal, "HARD_LINK_REFUSED", None)
    assert hard_link is not None, "no HARD_LINK_REFUSED refusal exists"
    assert [item.refusal for item in normalized.refusals].count(hard_link) == 1


def test_a_hard_link_created_after_inventory_is_refused_at_read(tmp_path: Path) -> None:
    """the link count is checked on the open descriptor (fstat), not only at inventory."""
    root = _copy(tmp_path)
    declared = root / "documents" / "watch.txt"
    inv = inventory(root)
    os.link(declared, tmp_path / "second-name.txt")
    assert declared.stat().st_nlink == 2

    normalized = _normalize(inv)
    records = tuple(normalized.records)
    assert all(record.external_id != "documents/watch.txt" for record in records)
    hard_link = getattr(BundleRefusal, "HARD_LINK_REFUSED", None)
    assert hard_link is not None
    assert [item.refusal for item in normalized.refusals].count(hard_link) == 1


def test_an_undeclared_special_file_is_refused_and_counted_not_omitted(tmp_path: Path) -> None:
    """An undeclared FIFO under the bundle root is neither a regular file nor invisible: refused and counted."""
    root = _copy(tmp_path)
    os.mkfifo(root / "documents" / "pipe")

    normalized = _normalize(inventory(root))
    tuple(normalized.records)
    refusals = [(item.locator, item.refusal) for item in normalized.refusals]
    assert ("documents/pipe", BundleRefusal.NOT_A_REGULAR_FILE) in refusals, refusals
    assert normalized.counters["not_regular_files"] == 1
