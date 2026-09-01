"""G-PROPOSE proves that proposal arrival does not write canonical bytes.

Arm A uses the stdio call path.  Arm B blocks that public server route, writes
a portable proposal document, and imports it through the CLI's existing
``candidate.propose`` call.  Both arms compare the complete snapshot and
ledger byte view before and after.  This gate covers proposal arrival only; it
does not claim to test a later human promotion decision.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

import nous_os.artifact as artifact
import nous_os.candidates as candidates
import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier
from nous_os.candidates import CandidateStore
from nous_os.config import DataRoot


_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_PROPOSED_AT = "2026-01-02T12:00:00+00:00"
_HOLDER = "proposal gate"
_CONTENT = "candidate material"
_FIXED_PROPOSAL_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"


class _CanonChanged(AssertionError):
    """Raised when a proposal arm changes a byte in the canonical locations."""


@dataclass(frozen=True, slots=True)
class _CanonBytes:
    """The complete canonical byte hash and its two byte counts."""

    value: str
    snapshot_bytes: int
    ledger_bytes: int


def _workspace(root: Path) -> core.Workspace:
    """Make every path explicit so the checked byte locations are known."""
    data_root = root / "documents"
    data_root.mkdir(parents=True)
    return core.Workspace(
        data_root=DataRoot(data_root),
        snapshot_root=root / "snapshots",
        ledger_path=root / "ledger.jsonl",
        derived_path=root / "derived.sqlite",
        candidate_store_path=root / "candidates.jsonl",
        bridge_registry_path=root / "bridges.jsonl",
        rejection_memory_path=root / "rejections.jsonl",
    )


def _canonical_bytes(workspace: core.Workspace) -> _CanonBytes:
    """Hash every snapshot pathname and byte plus the ledger's exact bytes."""
    digest = hashlib.sha256()
    snapshot_bytes = 0
    if workspace.snapshot_root.is_dir():
        paths = tuple(sorted(path for path in workspace.snapshot_root.rglob("*") if path.is_file()))
        for path in paths:
            payload = path.read_bytes()
            snapshot_bytes += len(payload)
            digest.update(path.relative_to(workspace.snapshot_root).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(payload)
            digest.update(b"\0")
    ledger = workspace.ledger_path.read_bytes() if workspace.ledger_path.is_file() else b""
    digest.update(b"ledger\0")
    digest.update(ledger)
    return _CanonBytes(digest.hexdigest(), snapshot_bytes, len(ledger))


def _assert_canon_unchanged(before: _CanonBytes, after: _CanonBytes) -> None:
    """Keep the gate's acceptance in one assertion that a control can break."""
    if before != after:
        raise _CanonChanged(f"canonical bytes changed: before={before!r}, after={after!r}")


def _workspace_argv(workspace: core.Workspace) -> list[str]:
    """Build startup arguments from the same locations the digest reads."""
    return [
        "--data-root",
        str(workspace.data_root.path),
        "--snapshot-root",
        str(workspace.snapshot_root),
        "--ledger-path",
        str(workspace.ledger_path),
        "--derived-path",
        str(workspace.derived_path),
        "--candidate-store-path",
        str(workspace.candidate_store_path),
        "--bridge-registry-path",
        str(workspace.bridge_registry_path),
        "--rejection-memory-path",
        str(workspace.rejection_memory_path),
    ]


def _arguments() -> dict[str, object]:
    """Return the one proposal body both arms must preserve."""
    return {
        "source_id": _SOURCE_ID,
        "content": _CONTENT,
        "proposed_at": _PROPOSED_AT,
        "holder": _HOLDER,
    }


def _expected_payload() -> dict[str, str]:
    """Return the exact candidate record expected under the fixed id control."""
    return {"proposal_id": _FIXED_PROPOSAL_ID, **_arguments()}  # type: ignore[return-value]


def _stored_record(workspace: core.Workspace) -> dict[str, str]:
    """Read back the most recent candidate record rather than trusting a response."""
    records = CandidateStore(workspace.candidate_store_path).proposals()
    assert records
    payload = records[-1].as_payload()
    assert type(payload) is dict
    return payload


def _artifact_document() -> dict[str, object]:
    """Build the portable body used by the client with no server write route."""
    return {
        "schema": artifact.SCHEMA_ID,
        "version": artifact.SCHEMA_VERSION,
        "provider": "restricted client",
        "session": "proposal gate",
        "proposals": [_arguments()],
    }


def test_g_propose_keeps_canon_unchanged_and_records_equivalent_candidates(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two delivery routes must add one equivalent candidate and no canonical byte."""
    monkeypatch.setattr(candidates, "new_assertion_id", lambda: _FIXED_PROPOSAL_ID)
    workspace = _workspace(tmp_path / "world")
    seen_operations: list[str] = []
    original_invoke = core.invoke

    def record_operation(
        grant: Grant,
        external_name: str,
        bound_workspace: core.Workspace,
        arguments: dict[str, object],
    ) -> object:
        seen_operations.append(external_name)
        return original_invoke(grant, external_name, bound_workspace, arguments)

    monkeypatch.setattr(core, "invoke", record_operation)

    before_a = _canonical_bytes(workspace)
    response = mcp.dispatch(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "candidate.propose", "arguments": _arguments()},
        },
        Grant("server proposer", frozenset({Tier.PROPOSE})),
        workspace,
    )
    after_a = _canonical_bytes(workspace)
    _assert_canon_unchanged(before_a, after_a)
    assert type(response) is dict
    result = response.get("result")
    assert type(result) is dict
    content = result.get("content")
    assert type(content) is list and len(content) == 1 and type(content[0]) is dict
    text = content[0].get("text")
    assert type(text) is str
    arm_a = json.loads(text)
    assert arm_a == _expected_payload()
    assert _stored_record(workspace) == _expected_payload()

    document_path = tmp_path / "restricted-proposal.json"
    document_path.write_text(json.dumps(_artifact_document()), encoding="utf-8")

    def server_route_is_unavailable(*args: object, **kwargs: object) -> None:
        del args, kwargs
        pytest.fail("the blocked server write route was reached")

    before_b = _canonical_bytes(workspace)
    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", server_route_is_unavailable)
        capsys.readouterr()
        code = cli.main(
            _workspace_argv(workspace)
            + [
                "--tier",
                Tier.PROPOSE.value,
                "candidate.propose",
                "--from-artifact",
                str(document_path),
            ]
        )
        captured = capsys.readouterr()
    after_b = _canonical_bytes(workspace)
    _assert_canon_unchanged(before_b, after_b)
    assert code == 0
    assert captured.err == ""
    rendered = json.loads(captured.out)
    assert type(rendered) is list and len(rendered) == 1 and type(rendered[0]) is dict
    provenance = rendered[0].get("provenance")
    assert provenance == {"provider": "restricted client", "session": "proposal gate"}
    arm_b = rendered[0].get("result")
    assert arm_b == _expected_payload()
    assert _stored_record(workspace) == _expected_payload()
    assert arm_a == arm_b
    assert seen_operations == ["candidate.propose", "candidate.propose"]


def test_g_propose_digest_detects_a_single_canonical_byte(tmp_path: Path) -> None:
    """A constant or partial digest could not support either proposal-arm claim."""
    workspace = _workspace(tmp_path / "sensitivity")
    before = _canonical_bytes(workspace)
    workspace.ledger_path.parent.mkdir(parents=True, exist_ok=True)
    workspace.ledger_path.write_bytes(b"x")
    after = _canonical_bytes(workspace)
    assert before != after
    assert after.ledger_bytes == 1


def test_g_propose_n4_canonical_write_is_detected(tmp_path: Path) -> None:
    """N4 proves that a proposal reaching canon makes the gate fail."""
    workspace = _workspace(tmp_path / "n4")
    before = _canonical_bytes(workspace)
    workspace.ledger_path.parent.mkdir(parents=True, exist_ok=True)
    workspace.ledger_path.write_bytes(b"x")
    after = _canonical_bytes(workspace)
    with pytest.raises(_CanonChanged, match="canonical bytes changed"):
        _assert_canon_unchanged(before, after)
