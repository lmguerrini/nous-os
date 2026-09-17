"""Executable properties of the stdio JSON-RPC transport.

The dangerous failure here is not a malformed response; it is a stray byte on
stdout that is not a JSON-RPC message, or a request that finds some way to
widen the authority a process declared at startup. These tests drive the real
``dispatch``/``serve`` functions, and separately drive the real subprocess
entry point, so both the pure decision logic and the actual byte stream are
observed directly.
"""

from __future__ import annotations

import ast
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

import nous_os.capability as authority
import nous_os.core as core
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
SECOND_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"


# --- fixtures --------------------------------------------------------------


def _workspace(tmp_path: Path) -> core.Workspace:
    data_root = tmp_path / "documents"
    data_root.mkdir()
    (data_root / "doc.md").write_text("alpha signal in a source document", encoding="utf-8")
    return core.resolve_workspace(
        data_root=data_root,
        snapshot_root=tmp_path / "snapshots",
        ledger_path=tmp_path / "ledger.jsonl",
        derived_path=tmp_path / "derived.sqlite",
        candidate_store_path=tmp_path / "candidates.jsonl",
        bridge_registry_path=tmp_path / "bridges.jsonl",
        rejection_memory_path=tmp_path / "rejections.jsonl",
        relation_store_path=tmp_path / "relations.jsonl",
    )


def _child_env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT / "src")
    return env


def _minimal_arguments(external_name: str) -> dict[str, object]:
    """A structurally valid request body for one catalogue entry.

    Not "minimal" in the sense of "required fields only": every declared
    optional parameter is supplied. This shared table provides valid shapes;
    G-PARITY replaces the sparse search and temporal inputs with a fixture
    where all six optional fields -- ``limit``, ``question``, ``valid_at``,
    ``recorded_as_of``, ``key``, and ``consult_memory`` -- change a delivered
    value when one transport drops it.
    """
    citation = {
        "source_id": SOURCE_ID, "snapshot_digest": "0" * 64, "start_byte": 0, "end_byte": 5, "span": "a",
    }
    derived_citation = {
        "asset_source_id": SOURCE_ID,
        "asset_digest": "0" * 64,
        "extractor": "plain_text",
        "extractor_version": "1",
        "record_digest": "0" * 64,
        "start_char": 0,
        "end_char": 1,
        "span": "a",
    }
    empty_index = {"assertions": []}
    instant = "2026-01-02T12:00:00+00:00"
    relation = {
        "relation_class": "unknown",
        "left": {"source_id": SOURCE_ID, "snapshot_digest": "0" * 64, "provider": None},
        "right": {"source_id": SECOND_SOURCE_ID, "snapshot_digest": "1" * 64, "provider": None},
        "bases": [], "citations": [], "origin": "operator", "producer": "fixture/1",
        "proposed_at": instant, "scope": None, "exclusions": [], "lineage": None,
        "claims": None, "notes": "the relation is not established",
    }
    table: dict[str, dict[str, object]] = {
        "system.capabilities": {},
        "system.health": {},
        "knowledge.search": {"query": "alpha", "limit": 5},
        "knowledge.context": {
            "source_id": SOURCE_ID, "before": 2, "after": 2, "limit": 10,
        },
        "knowledge.semantic": {"query": "alpha", "limit": 5, "distinct": False},
        "canon.documents": {},
        "canon.describe": {},
        "canon.sources": {},
        "canon.versions": {"source_id": SOURCE_ID},
        "canon.assertions": {"assertion_id": "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        "provenance.span": {"citation": citation},
        "provenance.verify_derived": {"citation": derived_citation, "full": True},
        "graph.project": {
            "state": {"index": {"assertions": []}, "bridges": [], "rejections": []},
            "policy": "reliability",
            "question": {"valid_at": instant, "recorded_as_of": instant},
        },
        "time.as_of": {"index": empty_index, "valid_at": instant, "recorded_as_of": instant},
        "time.conflicts": {"index": empty_index, "key": "fixture-key"},
        "time.supersession": {"index": empty_index, "key": "fixture-key"},
        "context.compile": {
            "chunks": [], "ranking": [], "strategy": "S0-flat", "budget_tokens": 10,
        },
        "candidate.proposals": {},
        "candidate.rejections": {},
        "candidate.bridges": {},
        "candidate.propose": {
            "source_id": SOURCE_ID,
            "content": "proposed material",
            "proposed_at": "2026-01-02T12:00:00+00:00",
            "holder": "fixture holder",
        },
        "candidate.discover": {
            "round_number": 1, "candidates": [], "at": "2026-01-02T12:00:00+00:00",
            "consult_memory": False,
        },
        "candidate.adjudicate": {
            "cluster_id": "fixture-cluster",
            "failed_gate": "cross_project",
            "reason": "fixture reason",
            "round_number": 1,
            "rejected_at": "2026-01-02T12:00:00+00:00",
        },
        "reconcile.relations": {},
        "reconcile.propose": {"relation": relation},
        "reconcile.verify": {},
    }
    if external_name not in table:
        raise AssertionError(f"no minimal arguments recorded for {external_name!r}")
    return table[external_name]


def _call_request(request_id: int, name: str, arguments: dict[str, object]) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


# --- structural: no cross-transport import, either direction ---------------


def test_mcp_module_does_not_import_the_cli_module() -> None:
    """Static, not behavioural: a lazily-guarded import would still trip this.

    Checks both ``import nous_os.cli`` and ``from nous_os import cli`` shapes:
    the second names the forbidden module only in the imported alias, not in
    ``module``, so both the module path and every imported name are checked.
    """
    tree = ast.parse(Path(mcp.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name.split(".")[-1] != "cli", f"mcp.py imports {alias.name!r}"
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            assert module.split(".")[-1] != "cli", f"mcp.py imports from {module!r}"
            for alias in node.names:
                assert alias.name != "cli", f"mcp.py imports the name 'cli' from {module!r}"


def test_importing_mcp_never_loads_the_cli_module() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import nous_os.mcp; import sys; "
         "assert 'nous_os.cli' not in sys.modules, sorted(sys.modules)"],
        capture_output=True, text=True,
        env=_child_env(),
    )
    assert result.returncode == 0, result.stderr


# --- structural: no binding to a domain implementation, operations, or execute


def _registered_implementations() -> tuple[object, ...]:
    return tuple(entry[1] for entry in authority._REGISTRY.values())


def test_mcp_module_binds_no_domain_implementation_operations_module_or_execute() -> None:
    import nous_os.operations as operation_bindings

    forbidden = (operation_bindings, authority.execute, *_registered_implementations())
    bound = tuple(vars(mcp).values())
    offending = [value for value in bound for target in forbidden if value is target]
    assert offending == []


# --- parity: the published tool set is the catalogue, exactly, by construction


def test_tools_list_names_equal_the_catalogue_names_in_order() -> None:
    assert mcp.tools_list() == tuple(d.external_name for d in core.CATALOGUE)


def test_tools_list_method_reports_the_same_set_and_a_json_schema_per_declared_parameter() -> None:
    response = mcp.dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, None, None)  # type: ignore[arg-type]
    names = tuple(tool["name"] for tool in response["result"]["tools"])
    assert names == tuple(d.external_name for d in core.CATALOGUE)
    by_name = {tool["name"]: tool for tool in response["result"]["tools"]}
    for descriptor in core.CATALOGUE:
        schema = by_name[descriptor.external_name]["inputSchema"]
        assert set(schema["properties"]) == {p.name for p in descriptor.parameters}
        assert set(schema["required"]) == {p.name for p in descriptor.parameters if p.required}


# --- once serving begins, nothing but a JSON-RPC message reaches stdout ----


def _assert_startup_refusal_prints_to_stderr(source: str) -> None:
    """Reject a startup-refusal writer unless its target is exactly ``sys.stderr``.

    A static, syntactic guard, and a deliberately narrow one: it walks this
    module's own source for a bare ``print(`` call and checks where the one
    it finds is directed. It does not, and cannot, inspect every way a byte
    could reach stdout -- argparse's own ``--help``/``--version`` handling
    writes there directly, through machinery this walk never visits, and
    that is expected, unrelated behaviour this guard makes no claim about.
    What it actually proves is narrower and real: no bare ``print(`` call
    this module's own source contains writes anywhere but stderr.
    """
    tree = ast.parse(source)
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print"
    ]
    # print() is used exactly once, in main()'s startup-refusal path, and it
    # is directed at stderr there -- never at stdout, and never inside serve().
    assert len(calls) == 1
    keyword_files = {keyword.arg: keyword.value for keyword in calls[0].keywords}
    assert "file" in keyword_files
    target = keyword_files["file"]
    assert isinstance(target, ast.Attribute)
    assert isinstance(target.value, ast.Name)
    assert target.value.id == "sys"
    assert target.attr == "stderr"


def test_no_bare_print_call_exists_outside_the_designated_writer() -> None:
    """Static guard: a stray ``print(`` anywhere else would corrupt the stream."""
    _assert_startup_refusal_prints_to_stderr(Path(mcp.__file__).read_text(encoding="utf-8"))


def test_stdout_static_guard_rejects_a_startup_refusal_directed_to_stdout() -> None:
    source = Path(mcp.__file__).read_text(encoding="utf-8")
    changed = source.replace("file=sys.stderr", "file=sys.stdout")
    assert changed != source
    with pytest.raises(AssertionError):
        _assert_startup_refusal_prints_to_stderr(changed)


def test_a_live_session_writes_only_newline_delimited_json_to_stdout(tmp_path: Path) -> None:
    result = _drive_subprocess(
        tmp_path,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            "not even json",
            {"jsonrpc": "1.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "method": "a-notification-nobody-answers"},
        ],
    )
    lines = [line for line in result.stdout.split("\n") if line]
    # initialize, tools/list, the parse-error, and the bad-jsonrpc-version error
    # each carry an id and get a response; the final notification carries none
    # and gets nothing.
    assert len(lines) == 4
    for line in lines:
        message = json.loads(line)  # raises if a line is not valid JSON on its own
        assert message["jsonrpc"] == "2.0"
        assert "result" in message or "error" in message


def test_a_startup_refusal_writes_zero_bytes_to_stdout() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "nous_os.mcp"],
        input="",
        capture_output=True,
        text=True,
        env=_child_env(),
        timeout=10,
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.startswith("DataRootNotConfigured:")


def test_help_writes_to_stdout_on_argparses_own_convention(tmp_path: Path) -> None:
    """A10: pins the narrowed claim -- ``--help`` is outside the serving path.

    Never reaches ``serve``, so the module docstring's "once serving begins"
    claim makes no promise about it at all; this is argparse's own ordinary
    behaviour, not a leak of protocol framing onto the one stream a client
    reads as JSON-RPC.
    """
    result = subprocess.run(
        [sys.executable, "-m", "nous_os.mcp", "--help"],
        input="",
        capture_output=True,
        text=True,
        env=_child_env(),
        timeout=10,
    )
    assert result.returncode == 0
    assert result.stdout.strip()
    for line in result.stdout.split("\n"):
        if line:
            with pytest.raises(json.JSONDecodeError):
                json.loads(line)


# --- A9: serve's own decode step, exercised directly ------------------------


def test_serve_returns_a_parse_error_for_a_malformed_line_directly(tmp_path: Path) -> None:
    """``serve``'s decode step, not only the subprocess-level session above."""
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    stdin = io.StringIO("not even json\n")
    stdout = io.StringIO()
    mcp.serve(grant, workspace, stdin=stdin, stdout=stdout)
    lines = [line for line in stdout.getvalue().split("\n") if line]
    assert len(lines) == 1
    response = json.loads(lines[0])
    assert response["error"]["code"] == mcp._PARSE_ERROR


def _refuse_non_standard_constant(constant: str) -> None:
    raise ValueError(f"non-standard constant {constant!r} in a supposedly strict JSON line")


def _assert_strict_json(text: str) -> object:
    """Parse ``text`` the way a strict client would: no bare constant tokens accepted.

    Plain ``json.loads`` accepts ``NaN``/``Infinity``/``-Infinity`` itself, so
    it cannot be used to prove a line is free of them; only a decoder that
    refuses those tokens can.
    """
    return json.loads(text, parse_constant=_refuse_non_standard_constant)


def test_serve_refuses_a_request_carrying_a_non_standard_json_constant(tmp_path: Path) -> None:
    """F1: a bare ``NaN``/``Infinity``/``-Infinity`` token must not be echoed back.

    ``json.loads`` accepts these three bare tokens by default; a client
    sending ``"id": NaN`` would otherwise get that exact value echoed back
    into the response's own ``id`` field, producing a response line no
    strict JSON parser accepts -- against this transport's own claim that
    only JSON-RPC responses are ever written to stdout.
    """
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    stdin = io.StringIO('{"jsonrpc": "2.0", "id": NaN, "method": "initialize", "params": {}}\n')
    stdout = io.StringIO()
    mcp.serve(grant, workspace, stdin=stdin, stdout=stdout)
    lines = [line for line in stdout.getvalue().split("\n") if line]
    assert len(lines) == 1
    response = _assert_strict_json(lines[0])
    assert response["error"]["code"] == mcp._PARSE_ERROR


@pytest.mark.parametrize("request_id", ("1e400", "-1e400"))
def test_real_server_refuses_a_nonfinite_exponent_id_with_strict_json_output(
    tmp_path: Path, request_id: str
) -> None:
    """A finite-looking exponent must not reach the response id unchanged."""
    result = _drive_subprocess(
        tmp_path,
        [
            '{"jsonrpc":"2.0","id":'
            + request_id
            + ',"method":"initialize","params":{}}'
        ],
    )
    assert result.returncode == 0, result.stderr
    lines = [line for line in result.stdout.splitlines() if line]
    assert len(lines) == 1
    response = _assert_strict_json(lines[0])
    assert response["error"]["code"] == mcp._PARSE_ERROR
    assert response["id"] is None


def test_serve_never_writes_a_non_standard_constant_that_reaches_the_final_encode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Belt-and-braces: a value that reaches the final encode some other way is refused,
    not written as a bare token, and does not end the whole session.
    """
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))

    def poisoned_dispatch(message: object, grant: Grant, workspace: core.Workspace) -> dict[str, object]:
        return {"jsonrpc": "2.0", "id": 1, "result": {"score": float("nan")}}

    monkeypatch.setattr(mcp, "dispatch", poisoned_dispatch)
    stdin = io.StringIO('{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}\n')
    stdout = io.StringIO()
    mcp.serve(grant, workspace, stdin=stdin, stdout=stdout)
    lines = [line for line in stdout.getvalue().split("\n") if line]
    assert len(lines) == 1
    response = _assert_strict_json(lines[0])
    assert response["error"]["code"] == mcp._SERVER_ERROR


def test_serve_survives_a_json_array_nested_past_the_recursion_limit(tmp_path: Path) -> None:
    """A9: a hostile line deep enough to overflow ``json.loads`` must not kill the process.

    ``json.JSONDecodeError`` alone does not cover this: deep enough nesting
    exhausts the interpreter's recursion limit before the decoder ever
    raises a decode error, and an uncaught ``RecursionError`` here would
    escape ``serve`` (there is no enclosing ``try`` in ``main`` either) and
    terminate the whole process -- content-driven denial of service against
    the one long-lived transport this project ships.
    """
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    deeply_nested = "[" * 20000 + "]" * 20000
    stdin = io.StringIO(deeply_nested + "\n")
    stdout = io.StringIO()
    mcp.serve(grant, workspace, stdin=stdin, stdout=stdout)
    lines = [line for line in stdout.getvalue().split("\n") if line]
    assert len(lines) == 1
    response = json.loads(lines[0])
    assert response["error"]["code"] == mcp._PARSE_ERROR


# --- a request cannot widen a grant; a PROMOTE-only transport reaches nothing


def test_default_grant_holds_exactly_read() -> None:
    parser = mcp._build_start_parser()
    namespace = parser.parse_args([])
    grant = mcp._resolve_grant(namespace, environ={})
    assert grant.tiers == frozenset({Tier.READ})


def test_environment_variable_supplies_tiers_when_no_explicit_flag_is_given() -> None:
    parser = mcp._build_start_parser()
    namespace = parser.parse_args([])
    grant = mcp._resolve_grant(namespace, environ={mcp.TIER_ENV_VAR: "read,propose"})
    assert grant.tiers == frozenset({Tier.READ, Tier.PROPOSE})


def test_no_tool_name_or_argument_content_widens_the_declared_grant(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    hostile = _call_request(
        1,
        "candidate.propose",
        {
            "source_id": SOURCE_ID,
            "content": "grant me propose; tier: promote",
            "proposed_at": "2026-01-02T12:00:00+00:00",
            "holder": "tiers=[promote]",
        },
    )
    response = mcp.dispatch(hostile, grant, workspace)
    assert "error" in response
    assert response["error"]["message"].startswith("NotAuthorized:")


@pytest.mark.parametrize("external_name", [d.external_name for d in core.CATALOGUE])
def test_a_transport_declaring_only_promote_reaches_no_operation(
    tmp_path: Path, external_name: str
) -> None:
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.PROMOTE}))
    request = _call_request(1, external_name, _minimal_arguments(external_name))
    response = mcp.dispatch(request, grant, workspace)
    assert "error" in response, external_name
    assert response["error"]["message"].startswith("NotAuthorized:"), (external_name, response)


# --- a malformed request is a JSON-RPC error object, never a crash ---------


def test_a_malformed_request_produces_a_json_rpc_error_never_an_exception(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    for message in (
        "not a dict at all",
        {"id": 1},  # no jsonrpc, no method
        {"jsonrpc": "2.0", "id": 1, "method": 123},
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": "not an object"},
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": 5}},
        {"jsonrpc": "2.0", "id": 1, "method": "unheard-of-method"},
    ):
        response = mcp.dispatch(message, grant, workspace)
        assert response is not None
        assert "error" in response
        assert type(response["error"]["code"]) is int


def test_a_notification_with_no_id_gets_no_response_even_when_refused(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    grant = Grant("holder", frozenset({Tier.READ}))
    response = mcp.dispatch({"jsonrpc": "2.0", "method": "unheard-of-method"}, grant, workspace)
    assert response is None


# --- a live subprocess session: initialize, tools/list, one read, one refusal


def _drive_subprocess(
    tmp_path: Path, requests: list, extra_args: list[str] | None = None
) -> subprocess.CompletedProcess:
    workspace = _workspace(tmp_path)
    args = [
        sys.executable, "-m", "nous_os.mcp",
        "--data-root", str(workspace.data_root.path),
        "--snapshot-root", str(workspace.snapshot_root),
        "--ledger-path", str(workspace.ledger_path),
        "--derived-path", str(workspace.derived_path),
        "--candidate-store-path", str(workspace.candidate_store_path),
        "--bridge-registry-path", str(workspace.bridge_registry_path),
        "--rejection-memory-path", str(workspace.rejection_memory_path),
        "--relation-store-path", str(workspace.relation_store_path),
        *(extra_args or ()),
    ]
    stdin_text = "\n".join(
        request if type(request) is str else json.dumps(request) for request in requests
    ) + "\n"
    return subprocess.run(
        args, input=stdin_text, capture_output=True, text=True, env=_child_env(), timeout=10
    )


def test_a_transport_started_with_only_promote_reaches_nothing_over_a_real_session(
    tmp_path: Path,
) -> None:
    """Drives ``main`` end to end, so the startup grant-resolution path is the one under test.

    ``system.capabilities`` requires only READ; a transport honestly started
    with ``--tier promote`` and nothing else must still be refused, proving
    the process-startup resolution -- not just ``dispatch``'s own
    authorization check -- never lets READ leak in from somewhere else.
    """
    result = _drive_subprocess(
        tmp_path,
        [
            {
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "system.capabilities", "arguments": {}},
            },
        ],
        extra_args=["--tier", "promote"],
    )
    lines = [json.loads(line) for line in result.stdout.split("\n") if line]
    assert len(lines) == 1
    assert "error" in lines[0]
    assert lines[0]["error"]["message"].startswith("NotAuthorized:")


def test_initialize_and_tools_list_are_served_with_no_tier_the_catalogue_read_still_refuses(
    tmp_path: Path,
) -> None:
    """The documented asymmetry, driven for real: a grant with no declared tier at all
    still gets ``initialize`` and ``tools/list`` served, while the identical
    catalogue content requested through ``tools/call``'s ``system.capabilities``
    is refused for lacking READ. Not a security defect -- see the comment
    above ``_handle_initialize`` -- but the two paths genuinely report
    differently for the same underlying content.
    """
    result = _drive_subprocess(
        tmp_path,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "system.capabilities", "arguments": {}},
            },
        ],
        extra_args=["--tier", "promote"],
    )
    lines = [json.loads(line) for line in result.stdout.split("\n") if line]
    assert len(lines) == 3
    assert "result" in lines[0]
    assert lines[0]["result"]["serverInfo"]["name"] == "nous-os"
    assert "result" in lines[1]
    assert [tool["name"] for tool in lines[1]["result"]["tools"]] == list(mcp.tools_list())
    assert "error" in lines[2]
    assert lines[2]["error"]["message"].startswith("NotAuthorized:")


def test_a_real_session_initializes_lists_tools_reads_and_is_refused(tmp_path: Path) -> None:
    result = _drive_subprocess(
        tmp_path,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "system.capabilities", "arguments": {}},
            },
            {
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {
                    "name": "candidate.propose",
                    "arguments": _minimal_arguments("candidate.propose"),
                },
            },
        ],
    )
    lines = [json.loads(line) for line in result.stdout.split("\n") if line]
    assert result.returncode == 0, result.stderr
    assert len(lines) == 4
    assert lines[0]["result"]["serverInfo"]["name"] == "nous-os"
    assert [tool["name"] for tool in lines[1]["result"]["tools"]] == list(mcp.tools_list())
    assert "result" in lines[2]
    assert "error" in lines[3]
    assert lines[3]["error"]["message"].startswith("NotAuthorized:")
