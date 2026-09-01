"""G-PARITY compares every live operation's delivered JSON value.

The existing surface checks catch a missing name but not two named routes that
return different values.  This gate drives all current catalogue entries on
one fixture world.  It has no sampled operation set: a new descriptor either
gets a usable argument builder and a comparison, or becomes a named NOT_RUN
failure.  Three catalogue entries write -- ``candidate.propose``,
``candidate.discover``, and ``candidate.adjudicate`` -- and only the first
mints its own identifier; that identifier is held fixed here to remove
identity minting from a transport-result comparison.

One bounded session below drives the real stdio loop: initialize, the complete
published list, a successful read, a refused request, and a successful
proposal. The full operation-by-operation value comparisons remain in process;
this file makes no broader real-loop coverage claim.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

import nous_os.candidates as candidates
import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier
from nous_os.derived import rebuild
from nous_os.ledger import ingest
from nous_os.untrusted import UntrustedText

import test_injection as injection
import test_mcp


_FIXED_PROPOSAL_ID = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_OPTIONAL_PARAMETER_CASES = (
    ("knowledge.search", "limit"),
    ("graph.project", "question"),
    ("time.as_of", "valid_at"),
    ("time.as_of", "recorded_as_of"),
    ("time.conflicts", "key"),
    ("candidate.discover", "consult_memory"),
)


class _ParityFailure(AssertionError):
    """Raised when a live transport pair cannot make one claimed comparison."""


@dataclass(frozen=True, slots=True)
class _NotRun:
    """One catalogue entry that did not produce a comparison, with its cause."""

    operation: str
    reason: str


@dataclass(frozen=True, slots=True)
class _Call:
    """The unwrapped delivered value from one transport."""

    value: object
    error: str | None


def _workspace_argv(workspace: core.Workspace) -> list[str]:
    """Build the CLI's process-start arguments from the configured workspace."""
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


def _workspace(root: Path) -> tuple[object, core.Workspace]:
    """Reuse the checked injection fixture so every read has real stored data."""
    world = injection._build_world(root)
    for number in range(1, 7):
        ingest(
            world.snapshots,
            world.ledger,
            test_mcp.SOURCE_ID,
            UntrustedText(f"alpha parity search result {number}"),
            injection._RECORDED_AT,
        )
    rebuild(world.snapshots, world.ledger, world.derived_path)
    workspace = core.Workspace(
        data_root=world.data_root,
        snapshot_root=world.root / "snapshots",
        ledger_path=world.ledger.path,
        derived_path=world.derived_path,
        candidate_store_path=world.candidates._path,
        bridge_registry_path=world.bridges._path,
        rejection_memory_path=world.rejections._path,
    )
    return world, workspace


def _assertion_payload(
    identifier: str,
    key: str,
    text: str,
    recorded_at: str,
    valid_from: str,
) -> dict[str, object]:
    return {
        "key": key,
        "id": identifier,
        "text": text,
        "citation": {
            "source_id": test_mcp.SOURCE_ID,
            "snapshot_digest": "0" * 64,
            "start_byte": 0,
            "end_byte": 1,
            "span": "a",
        },
        "support": "direct_quote",
        "recorded_at": recorded_at,
        "valid_from": valid_from,
        "valid_to": "2026-01-04T12:00:00+00:00",
    }


def _time_filter_index() -> dict[str, object]:
    return {
        "assertions": [
            _assertion_payload(
                "asr_0000000000000000000000000A",
                "fixture-key",
                "established at the fixture instant",
                "2026-01-01T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
            _assertion_payload(
                "asr_0000000000000000000000000B",
                "fixture-key",
                "valid only after the fixture instant",
                "2026-01-01T12:00:00+00:00",
                "2026-01-03T12:00:00+00:00",
            ),
            _assertion_payload(
                "asr_0000000000000000000000000C",
                "fixture-key",
                "recorded only after the fixture instant",
                "2026-01-03T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
        ]
    }


def _conflict_filter_index() -> dict[str, object]:
    return {
        "assertions": [
            _assertion_payload(
                "asr_0000000000000000000000000D",
                "fixture-key",
                "first disputed fixture claim",
                "2026-01-01T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
            _assertion_payload(
                "asr_0000000000000000000000000E",
                "fixture-key",
                "second disputed fixture claim",
                "2026-01-01T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
            _assertion_payload(
                "asr_0000000000000000000000000F",
                "other-key",
                "first disputed other claim",
                "2026-01-01T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
            _assertion_payload(
                "asr_0000000000000000000000000G",
                "other-key",
                "second disputed other claim",
                "2026-01-01T12:00:00+00:00",
                "2026-01-01T12:00:00+00:00",
            ),
        ]
    }


def _child_env() -> dict[str, str]:
    """Give the child process this checkout's source tree without global installation."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_REPO_ROOT / "src")
    return env


def _arguments(descriptor: core.OperationDescriptor, world: object) -> dict[str, object]:
    """Use the already-checked JSON argument shapes, replacing the live citation.

    The rebuilt search fixture has seven matching rows, so its explicit limit
    of five differs from the operation default. The populated temporal inputs
    make ``question``, both time filters, and the conflict key independently
    observable when omitted from one route.

    ``candidate.discover`` additionally replaces the shared fixture's empty
    ``candidates`` with one real card naming the world's own already-rejected
    cluster: with ``consult_memory`` honoured as the shared fixture declares
    it (``False``), this card is evaluated and accepted; with a transport
    that silently coerces ``consult_memory`` back to its own default
    (``True``), the identical card is instead skipped. Nothing about the
    other declared parameters can make those two outcomes render the same
    JSON value, so this is what actually lets G-PARITY see a transport that
    stops forwarding a caller's own ``consult_memory``.
    """
    arguments = test_mcp._minimal_arguments(descriptor.external_name)
    if descriptor.external_name == "provenance.span":
        arguments["citation"] = world.citation.as_payload()
    if descriptor.external_name == "graph.project":
        arguments["state"] = {"index": _time_filter_index(), "bridges": [], "rejections": []}
    if descriptor.external_name == "time.as_of":
        arguments["index"] = _time_filter_index()
    if descriptor.external_name == "time.conflicts":
        arguments["index"] = _conflict_filter_index()
    if descriptor.external_name == "candidate.discover":
        already_rejected_cluster_card = injection._bridge_card(
            card_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAD",
            cluster_id=world.rejected_card.cluster_id,
            failed=None,
        )
        arguments["candidates"] = [already_rejected_cluster_card.as_payload()]
    return arguments


def _cli_value(
    descriptor: core.OperationDescriptor,
    arguments: dict[str, object],
    workspace: core.Workspace,
    capsys: pytest.CaptureFixture[str],
) -> _Call:
    """Run the actual CLI and remove exit-code and stream details from its value."""
    argv = _workspace_argv(workspace)
    for tier in (Tier.READ, Tier.PROPOSE):
        argv.extend(("--tier", tier.value))
    argv.append(descriptor.external_name)
    for parameter in descriptor.parameters:
        if parameter.name not in arguments:
            continue
        value = arguments[parameter.name]
        option = "--" + parameter.name.replace("_", "-")
        if type(value) is bool:
            argv.append(option if value else "--no-" + parameter.name.replace("_", "-"))
        elif type(value) in (dict, list):
            argv.extend((option, json.dumps(value)))
        else:
            argv.extend((option, str(value)))
    capsys.readouterr()
    code = cli.main(argv)
    captured = capsys.readouterr()
    if code == 0:
        if captured.err:
            raise _ParityFailure(f"CLI wrote stderr for {descriptor.external_name!r}")
        return _Call(json.loads(captured.out), None)
    return _Call(None, captured.err.strip())


def _mcp_value(
    descriptor: core.OperationDescriptor,
    arguments: dict[str, object],
    workspace: core.Workspace,
) -> _Call:
    """Run actual dispatch and remove JSON-RPC fields from its delivered value."""
    message = {
        "jsonrpc": "2.0",
        "id": descriptor.external_name,
        "method": "tools/call",
        "params": {"name": descriptor.external_name, "arguments": arguments},
    }
    response = mcp.dispatch(message, Grant("parity", frozenset({Tier.READ, Tier.PROPOSE})), workspace)
    if type(response) is not dict:
        raise _ParityFailure(f"MCP gave no response for {descriptor.external_name!r}")
    if "error" in response:
        error = response["error"]
        if type(error) is not dict or type(error.get("message")) is not str:
            raise _ParityFailure(f"MCP gave a malformed error for {descriptor.external_name!r}")
        return _Call(None, error["message"])
    result = response.get("result")
    if type(result) is not dict:
        raise _ParityFailure(f"MCP gave no result for {descriptor.external_name!r}")
    content = result.get("content")
    if type(content) is not list or len(content) != 1 or type(content[0]) is not dict:
        raise _ParityFailure(f"MCP gave malformed content for {descriptor.external_name!r}")
    text = content[0].get("text")
    if type(text) is not str:
        raise _ParityFailure(f"MCP gave non-text content for {descriptor.external_name!r}")
    return _Call(json.loads(text), None)


def _ordered_json(value: object) -> str:
    """Keep object member order in the equality operand instead of discarding it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _cli_names() -> tuple[str, ...]:
    """Read subcommands from the parser instance that CLI users receive."""
    parser = cli._build_parser()
    action = next(item for item in parser._actions if item.dest == "operation")
    return tuple(action.choices)


def _mcp_names(workspace: core.Workspace) -> tuple[str, ...]:
    """Read published tool names off the real ``tools/list`` route, not the helper.

    ``mcp.tools_list()`` is a convenience export for tests and callers; the
    real JSON-RPC handler for ``tools/list`` enumerates ``core.CATALOGUE``
    directly and never calls it, so a control that only mutates the helper
    cannot break the surface a client actually receives. Driving the real
    ``mcp.dispatch`` route here is what makes N1 below a control over the
    published surface rather than over an unused convenience function.
    """
    message = {"jsonrpc": "2.0", "id": "tools-list", "method": "tools/list", "params": {}}
    response = mcp.dispatch(message, Grant("parity", frozenset({Tier.READ, Tier.PROPOSE})), workspace)
    if type(response) is not dict:
        raise _ParityFailure("MCP gave no response for tools/list")
    result = response.get("result")
    if type(result) is not dict or type(result.get("tools")) is not list:
        raise _ParityFailure("MCP gave a malformed tools/list result")
    return tuple(tool.get("name") for tool in result["tools"])


def _assert_published_tool_names(names: tuple[object, ...]) -> None:
    """Keep the real-loop list assertion sensitive to a missing published operation."""
    expected = tuple(descriptor.external_name for descriptor in core.CATALOGUE)
    if names != expected:
        raise _ParityFailure("real stdio loop published set or order differs from the core catalogue")


def _assert_parity(
    workspace: core.Workspace,
    world: object,
    capsys: pytest.CaptureFixture[str],
) -> int:
    """Compare every descriptor or fail with a denominator and every NOT_RUN cause."""
    expected = tuple(descriptor.external_name for descriptor in core.CATALOGUE)
    cli_names = _cli_names()
    mcp_names = _mcp_names(workspace)
    if cli_names != expected:
        raise _ParityFailure("CLI published set or order differs from the core catalogue")
    if mcp_names != expected:
        raise _ParityFailure("MCP published set or order differs from the core catalogue")

    compared = 0
    not_run: list[_NotRun] = []
    for descriptor in core.CATALOGUE:
        try:
            arguments = _arguments(descriptor, world)
            cli_call = _cli_value(descriptor, arguments, workspace, capsys)
            mcp_call = _mcp_value(descriptor, arguments, workspace)
            if cli_call.error is not None or mcp_call.error is not None:
                raise _ParityFailure(
                    f"{descriptor.external_name!r} returned errors: "
                    f"CLI={cli_call.error!r}, MCP={mcp_call.error!r}"
                )
            if _ordered_json(cli_call.value) != _ordered_json(mcp_call.value):
                raise _ParityFailure(
                    f"result differs for {descriptor.external_name!r}"
                )
            compared += 1
        except _ParityFailure:
            raise
        except Exception as error:
            not_run.append(_NotRun(descriptor.external_name, f"{type(error).__name__}: {error}"))
    if not_run:
        details = "; ".join(f"{item.operation}: {item.reason}" for item in not_run)
        raise _ParityFailure(f"NOT_RUN cells: {details}")
    if compared != len(core.CATALOGUE):
        raise _ParityFailure(f"compared {compared}, expected {len(core.CATALOGUE)}")
    return compared


def test_g_parity_compares_all_live_catalogue_results(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same published names are insufficient unless their delivered values match too."""
    monkeypatch.setattr(candidates, "new_assertion_id", lambda: _FIXED_PROPOSAL_ID)
    world, workspace = _workspace(tmp_path / "world")
    compared = _assert_parity(workspace, world, capsys)
    assert compared == len(core.CATALOGUE)


def test_g_parity_real_stdio_loop_covers_a_declared_session(tmp_path: Path) -> None:
    """The bounded real-loop subset is explicit in this test and its module docstring."""
    world, workspace = _workspace(tmp_path / "stdio")
    proposal = _arguments(
        next(item for item in core.CATALOGUE if item.external_name == "candidate.propose"), world
    )
    requests = (
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "system.capabilities", "arguments": {}},
        },
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "candidate.propose", "arguments": {"unexpected": True}},
        },
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "candidate.propose", "arguments": proposal},
        },
    )
    args = [
        sys.executable,
        "-m",
        "nous_os.mcp",
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
        "--tier",
        Tier.READ.value,
        "--tier",
        Tier.PROPOSE.value,
    ]
    result = subprocess.run(
        args,
        input="\n".join(json.dumps(request) for request in requests) + "\n",
        capture_output=True,
        text=True,
        env=_child_env(),
        timeout=10,
    )
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    assert result.returncode == 0, result.stderr
    assert len(lines) == len(requests)
    assert lines[0]["result"]["serverInfo"]["name"] == "nous-os"
    _assert_published_tool_names(tuple(tool["name"] for tool in lines[1]["result"]["tools"]))
    with pytest.raises(_ParityFailure, match="real stdio loop published"):
        _assert_published_tool_names(
            tuple(tool["name"] for tool in lines[1]["result"]["tools"][1:])
        )
    assert "result" in lines[2]
    assert lines[3]["error"]["message"].startswith("UnknownArgument:")
    delivered = lines[4]["result"]["content"]
    assert type(delivered) is list and len(delivered) == 1
    assert json.loads(delivered[0]["text"])["content"] == proposal["content"]


def test_g_parity_n1_missing_published_operation_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N1 proves that a name-set break on the real ``tools/list`` route makes the gate fail.

    Mutating ``mcp.tools_list()`` would not do this: the real ``tools/list``
    handler never calls it. This mutates ``mcp.dispatch`` itself -- the exact
    call ``_mcp_names`` makes, and the one every real client makes -- so the
    control breaks the surface a client actually receives.
    """
    monkeypatch.setattr(candidates, "new_assertion_id", lambda: _FIXED_PROPOSAL_ID)
    world, workspace = _workspace(tmp_path / "n1")
    original = mcp.dispatch

    def truncated(
        message: object, grant: Grant, bound_workspace: core.Workspace
    ) -> dict[str, object] | None:
        response = original(message, grant, bound_workspace)
        if (
            type(message) is dict
            and message.get("method") == "tools/list"
            and type(response) is dict
            and type(response.get("result")) is dict
            and type(response["result"].get("tools")) is list
        ):
            response = dict(response)
            response["result"] = dict(response["result"])
            response["result"]["tools"] = response["result"]["tools"][1:]
        return response

    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", truncated)
        with pytest.raises(_ParityFailure, match="published"):
            _assert_parity(workspace, world, capsys)


def test_g_parity_n2_different_result_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N2 proves that a value break on one real route makes the gate fail."""
    monkeypatch.setattr(candidates, "new_assertion_id", lambda: _FIXED_PROPOSAL_ID)
    world, workspace = _workspace(tmp_path / "n2")
    original = mcp.dispatch

    def changed(message: object, grant: Grant, bound_workspace: core.Workspace) -> dict[str, object] | None:
        response = original(message, grant, bound_workspace)
        if (
            type(message) is dict
            and message.get("method") == "tools/call"
            and type(message.get("params")) is dict
            and message["params"].get("name") == "system.health"
            and type(response) is dict
            and type(response.get("result")) is dict
        ):
            response = dict(response)
            response["result"] = {"content": [{"type": "text", "text": "{\"changed\":true}"}]}
        return response

    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", changed)
        with pytest.raises(_ParityFailure, match="result differs"):
            _assert_parity(workspace, world, capsys)


@pytest.mark.parametrize(("operation", "parameter"), _OPTIONAL_PARAMETER_CASES)
def test_g_parity_detects_each_claimed_optional_parameter(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    parameter: str,
) -> None:
    """Dropping any claimed optional field on one route must break parity."""
    monkeypatch.setattr(candidates, "new_assertion_id", lambda: _FIXED_PROPOSAL_ID)
    world, workspace = _workspace(tmp_path / operation.replace(".", "-"))
    original = mcp.dispatch

    def drops_one_optional_field(
        message: object, grant: Grant, bound_workspace: core.Workspace
    ) -> dict[str, object] | None:
        if (
            type(message) is dict
            and message.get("method") == "tools/call"
            and type(message.get("params")) is dict
            and message["params"].get("name") == operation
            and type(message["params"].get("arguments")) is dict
        ):
            message = dict(message)
            params = dict(message["params"])
            arguments = dict(params["arguments"])
            arguments.pop(parameter, None)
            params["arguments"] = arguments
            message["params"] = params
        return original(message, grant, bound_workspace)

    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", drops_one_optional_field)
        with pytest.raises(_ParityFailure, match=f"result differs for {operation!r}"):
            _assert_parity(workspace, world, capsys)
