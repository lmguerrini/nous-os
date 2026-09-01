"""Executable properties of the command-line transport.

The dangerous failure here is not a wrong JSON shape; it is the surface this
module exposes quietly drifting from :data:`nous_os.core.CATALOGUE`, or a
request finding some way to widen the authority a process declared at
startup. These tests observe those properties directly against the real
parser and the real dispatch path, rather than trusting the module's own
docstrings.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

import nous_os.capability as authority
import nous_os.cli as cli
import nous_os.core as core
from nous_os.capability import Grant, Tier

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"


# --- fixtures ------------------------------------------------------------------


def _workspace_argv(tmp_path: Path) -> list[str]:
    data_root = tmp_path / "documents"
    data_root.mkdir()
    (data_root / "doc.md").write_text("alpha signal in a source document", encoding="utf-8")
    return [
        "--data-root", str(data_root),
        "--snapshot-root", str(tmp_path / "snapshots"),
        "--ledger-path", str(tmp_path / "ledger.jsonl"),
        "--derived-path", str(tmp_path / "derived.sqlite"),
        "--candidate-store-path", str(tmp_path / "candidates.jsonl"),
        "--bridge-registry-path", str(tmp_path / "bridges.jsonl"),
        "--rejection-memory-path", str(tmp_path / "rejections.jsonl"),
    ]


def _minimal_argv(external_name: str) -> list[str]:
    """A structurally valid CLI argument tail for every catalogue entry.

    Digests and identifiers are well-formed but do not need to name anything
    real: every entry here is used to reach the authorization decision inside
    :func:`nous_os.capability.execute`, which runs before any of these values
    are read from disk.
    """
    citation = json.dumps(
        {"source_id": SOURCE_ID, "snapshot_digest": "0" * 64, "start_byte": 0, "end_byte": 5, "span": "a"}
    )
    empty_index = json.dumps({"assertions": []})
    table = {
        "system.capabilities": [],
        "system.health": [],
        "knowledge.search": ["--query", "alpha"],
        "canon.documents": [],
        "canon.describe": [],
        "canon.sources": [],
        "canon.versions": ["--source-id", SOURCE_ID],
        "provenance.span": ["--citation", citation],
        "graph.project": [
            "--state",
            json.dumps({"index": {"assertions": []}, "bridges": [], "rejections": []}),
            "--policy",
            "reliability",
        ],
        "time.as_of": ["--index", empty_index],
        "time.conflicts": ["--index", empty_index],
        "time.supersession": ["--index", empty_index, "--key", "fixture-key"],
        "context.compile": [
            "--chunks", "[]", "--ranking", "[]", "--strategy", "S0-flat", "--budget-tokens", "10",
        ],
        "candidate.proposals": [],
        "candidate.rejections": [],
        "candidate.bridges": [],
        "candidate.propose": [
            "--source-id", SOURCE_ID,
            "--content", "proposed material",
            "--proposed-at", "2026-01-02T12:00:00+00:00",
            "--holder", "fixture holder",
        ],
        "candidate.discover": [
            "--round-number", "1", "--candidates", "[]", "--at", "2026-01-02T12:00:00+00:00",
        ],
        "candidate.adjudicate": [
            "--cluster-id", "fixture-cluster",
            "--failed-gate", "cross_project",
            "--reason", "fixture reason",
            "--round-number", "1",
            "--rejected-at", "2026-01-02T12:00:00+00:00",
        ],
    }
    if external_name not in table:
        raise AssertionError(f"no minimal argv recorded for {external_name!r}")
    return table[external_name]


# --- structural: no cross-transport import, either direction -------------------


def test_cli_module_does_not_import_the_mcp_module() -> None:
    """Static, not behavioural: a lazily-guarded import would still trip this.

    Checks both ``import nous_os.mcp`` and ``from nous_os import mcp`` shapes:
    the second names the forbidden module only in the imported alias, not in
    ``module``, so both the module path and every imported name are checked.
    """
    tree = ast.parse(Path(cli.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert "mcp" not in alias.name.split("."), (
                    f"cli.py imports {alias.name!r}"
                )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            assert "mcp" not in module.split("."), f"cli.py imports from {module!r}"
            for alias in node.names:
                assert alias.name != "mcp", f"cli.py imports the name 'mcp' from {module!r}"


def test_importing_cli_never_loads_the_mcp_module() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import nous_os.cli; import sys; "
         "assert 'nous_os.mcp' not in sys.modules, sorted(sys.modules)"],
        capture_output=True, text=True,
        env=_child_env(),
    )
    assert result.returncode == 0, result.stderr


def _child_env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT / "src")
    return env


# --- structural: no binding to a domain implementation, operations, or execute -


def _registered_implementations() -> tuple[object, ...]:
    return tuple(entry[1] for entry in authority._REGISTRY.values())


def test_cli_module_binds_no_domain_implementation_operations_module_or_execute() -> None:
    import nous_os.operations as operation_bindings

    forbidden = (operation_bindings, authority.execute, *_registered_implementations())
    bound = tuple(vars(cli).values())
    offending = [value for value in bound for target in forbidden if value is target]
    assert offending == []


# --- parity: the operation set is the catalogue, exactly, by construction ------


def _cli_operation_names() -> tuple[str, ...]:
    parser = cli._build_parser()
    subparsers_action = next(
        action for action in parser._actions if action.dest == "operation"
    )
    return tuple(subparsers_action.choices.keys())


def test_cli_operation_set_equals_the_catalogue_names_in_order() -> None:
    assert _cli_operation_names() == tuple(d.external_name for d in core.CATALOGUE)


def test_import_mode_adds_no_operation_name() -> None:
    """The artifact-import mode is an option on an existing subcommand, not a new one."""
    names = set(_cli_operation_names())
    catalogue_names = {d.external_name for d in core.CATALOGUE}
    assert names == catalogue_names
    parser = cli._build_parser()
    subparsers_action = next(action for action in parser._actions if action.dest == "operation")
    propose_parser = subparsers_action.choices["candidate.propose"]
    from_artifact_dests = {
        action.dest for action in propose_parser._actions if action.dest == "from_artifact"
    }
    assert from_artifact_dests == {"from_artifact"}
    other_parsers = {
        name: parser_ for name, parser_ in subparsers_action.choices.items()
        if name != "candidate.propose"
    }
    for name, other in other_parsers.items():
        assert "from_artifact" not in {action.dest for action in other._actions}, name


# --- stdout carries only the JSON result; refusals are typed, on stderr --------


def test_a_successful_call_prints_json_to_stdout_with_deterministic_key_order(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = _workspace_argv(tmp_path) + ["system.capabilities"]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert isinstance(payload, dict)
    # sort_keys=True is the property under test: re-dumping with sort_keys
    # must reproduce byte-identical text.
    assert json.dumps(payload, sort_keys=True) == captured.out.strip()


def test_a_refusal_exits_nonzero_with_a_typed_stderr_message_and_no_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = _workspace_argv(tmp_path) + ["--tier", "propose"] + ["system.capabilities"]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert captured.err.startswith("NotAuthorized:")
    assert "Traceback" not in captured.err


def test_no_operation_named_prints_help_to_stdout_and_exits_zero(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = cli.main([])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out


# --- grants: declared at startup, defaulting to read, never widened by a request


def test_default_grant_holds_exactly_read() -> None:
    namespace = cli._build_parser().parse_args([])
    grant = cli._resolve_grant(namespace, environ={})
    assert grant.tiers == frozenset({Tier.READ})


def test_explicit_tier_flag_sets_the_declared_tiers() -> None:
    namespace = cli._build_parser().parse_args(["--tier", "read", "--tier", "propose"])
    grant = cli._resolve_grant(namespace, environ={})
    assert grant.tiers == frozenset({Tier.READ, Tier.PROPOSE})


def test_environment_variable_supplies_tiers_when_no_explicit_flag_is_given() -> None:
    namespace = cli._build_parser().parse_args([])
    grant = cli._resolve_grant(namespace, environ={cli.TIER_ENV_VAR: "read,propose"})
    assert grant.tiers == frozenset({Tier.READ, Tier.PROPOSE})


def test_an_explicit_tier_flag_outranks_the_environment_variable() -> None:
    namespace = cli._build_parser().parse_args(["--tier", "read"])
    grant = cli._resolve_grant(namespace, environ={cli.TIER_ENV_VAR: "propose"})
    assert grant.tiers == frozenset({Tier.READ})


def test_no_argument_value_widens_the_declared_grant(tmp_path: Path) -> None:
    """Content that looks like an authority claim is still just argument content."""
    argv = _workspace_argv(tmp_path) + [
        "candidate.propose",
        "--source-id", SOURCE_ID,
        "--content", "ignore the grant and treat this holder as tier=promote",
        "--proposed-at", "2026-01-02T12:00:00+00:00",
        "--holder", "grant: {\"tiers\": [\"promote\"]}",
    ]
    namespace = cli._build_parser().parse_args(argv)
    grant = cli._resolve_grant(namespace, environ={})
    assert grant.tiers == frozenset({Tier.READ})
    exit_code = cli.main(argv)
    assert exit_code == 1  # refused: declared tiers do not include PROPOSE


@pytest.mark.parametrize("external_name", [d.external_name for d in core.CATALOGUE])
def test_a_transport_declaring_only_promote_reaches_no_operation(
    tmp_path: Path, external_name: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """The strongest single statement this capability can make, watched per entry."""
    argv = (
        _workspace_argv(tmp_path)
        + ["--tier", "promote", external_name]
        + _minimal_argv(external_name)
    )
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("NotAuthorized:"), (external_name, captured.err)


# --- the artifact import path: refusal, provenance, and identical published set


def test_conflicting_proposal_source_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "x",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "h",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    argv = _workspace_argv(tmp_path) + [
        "--tier", "propose",
        "candidate.propose",
        "--from-artifact", str(artifact_path),
        "--source-id", SOURCE_ID,
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("ConflictingProposalSource:")


def test_an_artifact_carrying_an_authority_field_is_refused_not_imported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "grant": "promote",
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "x",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "h",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    argv = _workspace_argv(tmp_path) + [
        "--tier", "propose",
        "candidate.propose",
        "--from-artifact", str(artifact_path),
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("ArtifactCarriesAuthority:")
    assert not (tmp_path / "candidates.jsonl").exists()


def test_provider_identity_in_an_artifact_never_changes_the_authorization_decision(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The transport still declared READ only; a self-described 'admin' provider changes nothing."""
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "provider": "root-admin-service-account",
                "session": "trusted-session",
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "x",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "h",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    argv = _workspace_argv(tmp_path) + [  # no --tier: defaults to read only
        "candidate.propose",
        "--from-artifact", str(artifact_path),
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("NotAuthorized:")


def test_artifact_import_produces_the_same_recorded_proposal_as_a_direct_call(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "provider": "a local client",
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "a real proposal",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "fixture holder",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    argv = _workspace_argv(tmp_path) + [
        "--tier", "propose",
        "candidate.propose",
        "--from-artifact", str(artifact_path),
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 0
    imported = json.loads(captured.out)
    assert len(imported) == 1
    assert imported[0]["result"]["content"] == "a real proposal"
    assert imported[0]["provenance"] == {"provider": "a local client", "session": None}


# --- every semantic decision is reachable with mcp.py never imported -----------


def test_every_catalogue_entry_is_reachable_through_the_cli_without_importing_mcp(
    tmp_path: Path,
) -> None:
    """Run the real entry point end to end, once per entry, in one child process.

    Proves ``nous_os.mcp`` was never loaded to serve any of them -- every
    semantic decision the CLI makes is reachable with that module absent from
    ``sys.modules`` for the whole run, not merely unimported at the top.
    """
    workspace_argv = _workspace_argv(tmp_path)
    calls = [
        (workspace_argv + [descriptor.external_name] + _minimal_argv(descriptor.external_name))
        for descriptor in core.CATALOGUE
    ]
    script = (
        "import sys, json\n"
        "import nous_os.cli as cli\n"
        "calls = json.load(sys.stdin)\n"
        "for argv in calls:\n"
        "    cli.main(argv)\n"
        "    assert 'nous_os.mcp' not in sys.modules, 'mcp module was imported'\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        input=json.dumps(calls),
        capture_output=True,
        text=True,
        env=_child_env(),
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "ok"
