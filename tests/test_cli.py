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
import argparse
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
SECOND_SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"


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
        "--relation-store-path", str(tmp_path / "relations.jsonl"),
    ]


def _seeded_workspace_argv(tmp_path: Path) -> tuple[list[str], str]:
    """Workspace startup arguments with one real ingested, indexed document.

    A built derived store and a declared tier are what
    ``knowledge.search``, ``canon.sources``, ``canon.versions``,
    ``provenance.span``, and every PROPOSE-tier write actually need to
    succeed rather than merely be parsed. Returns the real snapshot digest
    alongside the argv so a citation can name it exactly.
    """
    from datetime import datetime, timezone

    from nous_os.derived import build
    from nous_os.ledger import Ledger, ingest
    from nous_os.snapshots import SnapshotStore
    from nous_os.untrusted import UntrustedText

    data_root = tmp_path / "documents"
    data_root.mkdir()
    content = "alpha signal in a source document"
    (data_root / "doc.md").write_text(content, encoding="utf-8")
    snapshot_root = tmp_path / "snapshots"
    ledger_path = tmp_path / "ledger.jsonl"
    derived_path = tmp_path / "derived.sqlite"
    snapshots = SnapshotStore(snapshot_root)
    ledger = Ledger(ledger_path)
    result = ingest(
        snapshots,
        ledger,
        SOURCE_ID,
        UntrustedText(content),
        datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc),
    )
    assert result.entry is not None
    snapshots.put(SECOND_SOURCE_ID, content.encode("utf-8"))
    build(snapshots, ledger, derived_path)
    argv = [
        "--data-root", str(data_root),
        "--snapshot-root", str(snapshot_root),
        "--ledger-path", str(ledger_path),
        "--derived-path", str(derived_path),
        "--candidate-store-path", str(tmp_path / "candidates.jsonl"),
        "--bridge-registry-path", str(tmp_path / "bridges.jsonl"),
        "--rejection-memory-path", str(tmp_path / "rejections.jsonl"),
        "--relation-store-path", str(tmp_path / "relations.jsonl"),
        "--tier", "read",
        "--tier", "propose",
    ]
    return argv, result.entry.snapshot_digest


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
    derived_citation = json.dumps(
        {
            "asset_source_id": SOURCE_ID,
            "asset_digest": "0" * 64,
            "extractor": "plain_text",
            "extractor_version": "1",
            "record_digest": "0" * 64,
            "start_char": 0,
            "end_char": 1,
            "span": "a",
        }
    )
    empty_index = json.dumps({"assertions": []})
    relation = json.dumps(
        {
            "relation_class": "unknown",
            "left": {"source_id": SOURCE_ID, "snapshot_digest": "0" * 64, "provider": None},
            "right": {"source_id": SECOND_SOURCE_ID, "snapshot_digest": "1" * 64, "provider": None},
            "bases": [], "citations": [], "origin": "operator", "producer": "fixture/1",
            "proposed_at": "2026-01-02T12:00:00+00:00", "scope": None,
            "exclusions": [], "lineage": None, "claims": None,
            "notes": "the relation is not established",
        }
    )
    table = {
        "system.capabilities": [],
        "system.health": [],
        "knowledge.search": ["--query", "alpha"],
        "knowledge.context": ["--source-id", SOURCE_ID],
        "knowledge.semantic": ["--query", "alpha"],
        "canon.documents": [],
        "canon.describe": [],
        "canon.sources": [],
        "canon.versions": ["--source-id", SOURCE_ID],
        "canon.assertions": ["--assertion-id", "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        "provenance.span": ["--citation", citation],
        "provenance.verify_derived": ["--citation", derived_citation],
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
        "reconcile.relations": [],
        "reconcile.propose": ["--relation", relation],
        "reconcile.verify": [],
    }
    if external_name not in table:
        raise AssertionError(f"no minimal argv recorded for {external_name!r}")
    return table[external_name]


def _reachable_argv(external_name: str, digest: str) -> list[str]:
    """A CLI argument tail that actually succeeds against a seeded workspace.

    Unlike :func:`_minimal_argv`, ``digest`` names a snapshot that really
    exists, so a read that touches the derived store or the snapshot store --
    not merely one that stops at the authorization decision -- can succeed.
    """
    citation = json.dumps(
        {
            "source_id": SOURCE_ID,
            "snapshot_digest": digest,
            "start_byte": 0,
            "end_byte": 5,
            "span": "alpha",
        }
    )
    derived_citation = json.dumps(
        {
            "asset_source_id": SOURCE_ID,
            "asset_digest": digest,
            "extractor": "plain_text",
            "extractor_version": "1",
            "record_digest": "0" * 64,
            "start_char": 0,
            "end_char": 1,
            "span": "a",
        }
    )
    empty_index = json.dumps({"assertions": []})
    relation = json.dumps(
        {
            "relation_class": "unknown",
            "left": {"source_id": SOURCE_ID, "snapshot_digest": digest, "provider": None},
            "right": {"source_id": SECOND_SOURCE_ID, "snapshot_digest": digest, "provider": None},
            "bases": [], "citations": [], "origin": "operator", "producer": "fixture/1",
            "proposed_at": "2026-01-02T12:00:00+00:00", "scope": None,
            "exclusions": [], "lineage": None, "claims": None,
            "notes": "the relation is not established",
        }
    )
    table = {
        "system.capabilities": [],
        "system.health": [],
        "knowledge.search": ["--query", "alpha"],
        "knowledge.context": ["--source-id", SOURCE_ID],
        "knowledge.semantic": ["--query", "alpha"],
        "canon.documents": [],
        "canon.describe": [],
        "canon.sources": [],
        "canon.versions": ["--source-id", SOURCE_ID],
        "canon.assertions": ["--assertion-id", "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        "provenance.span": ["--citation", citation],
        "provenance.verify_derived": ["--citation", derived_citation],
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
        "reconcile.relations": [],
        "reconcile.propose": ["--relation", relation],
        "reconcile.verify": [],
    }
    if external_name not in table:
        raise AssertionError(f"no reachable argv recorded for {external_name!r}")
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


def test_catalogue_parameter_colliding_with_a_startup_destination_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    colliding = core.OperationDescriptor(
        "synthetic.data-root",
        None,
        Tier.READ,
        "synthetic collision",
        (core.ParameterSpec("data_root", "string", False, "would replace startup input"),),
    )
    monkeypatch.setattr(core, "CATALOGUE", (*core.CATALOGUE, colliding))
    with pytest.raises(cli.CliError, match="reserved startup destination"):
        cli._build_parser()


def test_catalogue_parameter_colliding_with_import_destination_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = next(
        descriptor for descriptor in core.CATALOGUE if descriptor.external_name == "candidate.propose"
    )
    colliding = core.OperationDescriptor(
        original.external_name,
        original.operation,
        original.tier,
        original.summary,
        (*original.parameters, core.ParameterSpec("from_artifact", "string", False, "collision")),
    )
    monkeypatch.setattr(
        core,
        "CATALOGUE",
        tuple(colliding if descriptor is original else descriptor for descriptor in core.CATALOGUE),
    )
    with pytest.raises(cli.CliError, match="reserved startup destination"):
        cli._build_parser()


def test_catalogue_parameter_colliding_with_help_destination_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    colliding = core.OperationDescriptor(
        "synthetic.help-collision",
        None,
        Tier.READ,
        "synthetic help collision",
        (core.ParameterSpec("help", "string", False, "would replace parser help"),),
    )
    monkeypatch.setattr(core, "CATALOGUE", (*core.CATALOGUE, colliding))
    with pytest.raises(cli.CliError, match="reserved startup destination"):
        cli._build_parser()


def test_argparse_abbreviation_cannot_smuggle_a_subcommand_option_into_the_startup_tier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A6: a descriptor parameter named ``ti`` passes the exact-equality guard.

    ``_assert_parameter_destinations_are_unreserved`` compares ``"ti"`` to the
    reserved destination ``"tier"`` and finds no exact match, so it never
    raises here -- exactly the gap the destination guard alone could not
    close. Typed before the subcommand, ``--ti`` is not yet inside that
    descriptor's own subparser at all; with abbreviation left enabled it
    would resolve, at the top level, to the only startup option it is an
    unambiguous prefix of, ``--tier``, and silently declare an authority
    tier nobody asked for. With abbreviation disabled, ``--ti`` matches
    nothing at the top level and the whole command line is refused instead.
    """
    colliding = core.OperationDescriptor(
        "synthetic.ti-collision",
        None,
        Tier.READ,
        "synthetic prefix collision",
        (core.ParameterSpec("ti", "string", False, "would collide with --tier if abbreviated"),),
    )
    monkeypatch.setattr(core, "CATALOGUE", (*core.CATALOGUE, colliding))
    parser = cli._build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--ti", "propose", "synthetic.ti-collision"])


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


def test_cli_never_writes_a_nonfinite_json_value(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The command output keeps the same strict JSON rule as stdio output."""
    monkeypatch.setattr(cli, "_run", lambda namespace: {"value": float("inf")})
    exit_code = cli.main(_workspace_argv(tmp_path) + ["system.capabilities"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert captured.err.startswith("ValueError:")


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


# --- A8: parsing keeps argparse's own convention, not this module's 0/1 contract


def test_a_bogus_option_exits_with_argparses_own_convention_not_the_zero_or_one_contract(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``parse_args`` runs before ``main``'s own ``try``, and that is documented, not hidden."""
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["--bogus"])
    assert excinfo.value.code == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err


def test_a_deeply_nested_json_argument_is_refused_without_a_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A JSON value nested past the recursion limit must not crash the CLI.

    ``json.loads`` raises ``RecursionError``, not ``json.JSONDecodeError``,
    once nesting is deep enough; :func:`nous_os.cli._json_argument` refuses
    it through the identical ``argparse.ArgumentTypeError`` path an
    ordinarily malformed value takes, so this still exits through argparse's
    own convention rather than an interpreter traceback.
    """
    deeply_nested = "[" * 20000 + "]" * 20000
    argv = _workspace_argv(tmp_path) + ["time.as_of", "--index", deeply_nested]
    with pytest.raises(SystemExit) as excinfo:
        cli.main(argv)
    assert excinfo.value.code == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Traceback" not in captured.err
    assert "nested too deeply" in captured.err


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


def test_resolve_grant_is_insensitive_to_a_subcommand_holder(tmp_path: Path) -> None:
    """The exact repro: a process-level and a subcommand ``--holder`` must not collide.

    Before the two were given distinct namespace destinations, whichever
    ``--holder`` argparse parsed last silently won, and a process-level
    ``--holder`` given with no subcommand ``--holder`` was dropped entirely.
    """
    argv = _workspace_argv(tmp_path) + [
        "--holder", "GRANT",
        "candidate.propose",
        "--source-id", SOURCE_ID,
        "--content", "x",
        "--proposed-at", "2026-01-02T12:00:00+00:00",
        "--holder", "PAYLOAD",
    ]
    namespace = cli._build_parser().parse_args(argv)
    grant = cli._resolve_grant(namespace, environ={})
    assert grant.holder == "GRANT"
    # candidate.propose's own declared parameter is untouched by the grant read.
    assert namespace.holder == "PAYLOAD"


def test_a_process_level_holder_survives_with_no_subcommand_holder(tmp_path: Path) -> None:
    """The other half of the repro: a lone process-level ``--holder`` must not be dropped."""
    argv = _workspace_argv(tmp_path) + ["--holder", "GRANT", "system.capabilities"]
    namespace = cli._build_parser().parse_args(argv)
    grant = cli._resolve_grant(namespace, environ={})
    assert grant.holder == "GRANT"


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


def test_import_mode_is_refused_for_a_descriptor_other_than_candidate_propose() -> None:
    """The import branch validates its target even if a caller supplies a namespace directly."""
    namespace = argparse.Namespace(operation="system.capabilities", from_artifact="input.json")
    with pytest.raises(cli.CliError, match="only valid for candidate.propose"):
        cli._run(namespace)


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


def test_real_cli_import_refuses_a_duplicate_member_before_it_can_hide_a_forbidden_field(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        """{
  "schema": "nous-os.candidate-proposal-artifact",
  "version": 1,
  "proposals": [{
    "source_id": "src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "content": {"grant": "promote"},
    "content": "accepted text",
    "proposed_at": "2026-01-02T12:00:00+00:00",
    "holder": "fixture holder"
  }]
}""",
        encoding="utf-8",
    )
    exit_code = cli.main(
        _workspace_argv(tmp_path)
        + ["--tier", "propose", "candidate.propose", "--from-artifact", str(artifact_path)]
    )
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("MalformedArtifact:")
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


# --- import atomicity: validated before any write, and partial writes reported -


def test_a_malformed_second_payload_leaves_no_proposal_recorded(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Pre-validation catches a malformed payload before any payload is written.

    The exact repro: a document whose second ``proposed_at`` cannot parse
    used to exit 1 with the first proposal already durably written.
    """
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "first proposal",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "fixture holder",
                    },
                    {
                        "source_id": SOURCE_ID,
                        "content": "second proposal",
                        "proposed_at": "not-a-real-instant",
                        "holder": "fixture holder",
                    },
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
    assert captured.err.startswith("ArgumentTypeError:")
    assert not (tmp_path / "candidates.jsonl").exists()


def test_a_write_failure_after_validation_reports_what_already_landed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A domain-level check only the write itself performs still reports partial progress.

    Pre-validation runs the identical binder ``core.invoke`` uses, so it
    cannot reach ``CandidateStore``'s own identifier-format check, which runs
    only while actually constructing a record. When that still fails after
    every payload has passed pre-validation, the already-recorded proposal is
    named on the error path rather than the failure being silent.
    """
    artifact_path = tmp_path / "artifact.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema": "nous-os.candidate-proposal-artifact",
                "version": 1,
                "proposals": [
                    {
                        "source_id": SOURCE_ID,
                        "content": "first proposal",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "fixture holder",
                    },
                    {
                        "source_id": "not-a-well-formed-identifier",
                        "content": "second proposal",
                        "proposed_at": "2026-01-02T12:00:00+00:00",
                        "holder": "fixture holder",
                    },
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
    assert captured.err.startswith("ArtifactImportPartiallyRecorded:")
    assert "first proposal" in captured.err
    recorded = (tmp_path / "candidates.jsonl").read_text(encoding="utf-8")
    assert "first proposal" in recorded


# --- an explicit JSON null is refused, not silently dropped --------------------


def test_an_explicit_json_null_argument_is_refused_not_silently_dropped(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``--question null`` used to be silently dropped; the server refuses the same input."""
    argv = _workspace_argv(tmp_path) + [
        "graph.project",
        "--state",
        json.dumps({"index": {"assertions": []}, "bridges": [], "rejections": []}),
        "--policy", "reliability",
        "--question", "null",
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.err.startswith("ExplicitNullArgument:")


def test_an_omitted_optional_argument_is_still_accepted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The refusal above is meaningful only if a genuinely omitted option still works."""
    argv = _workspace_argv(tmp_path) + [
        "graph.project",
        "--state",
        json.dumps({"index": {"assertions": []}, "bridges": [], "rejections": []}),
        "--policy", "reliability",
    ]
    exit_code = cli.main(argv)
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.err == ""


# --- every semantic decision is reachable with mcp.py never imported -----------


def test_every_catalogue_entry_is_reachable_through_the_cli_without_importing_mcp(
    tmp_path: Path,
) -> None:
    """Run the real entry point end to end, once per entry, in one child process.

    Proves ``nous_os.mcp`` was never loaded to serve any of them -- every
    semantic decision the CLI makes is reachable with that module absent from
    ``sys.modules`` for the whole run, not merely unimported at the top --
    and that each of those 20 calls actually succeeded. A built derived store
    and a declared PROPOSE tier are what several of them need to reach that
    success rather than stop at a refusal along the way.
    """
    workspace_argv, digest = _seeded_workspace_argv(tmp_path)
    calls = [
        (
            descriptor.external_name,
            workspace_argv + [descriptor.external_name] + _reachable_argv(descriptor.external_name, digest),
        )
        for descriptor in core.CATALOGUE
    ]
    script = (
        "import sys, json\n"
        "import nous_os.cli as cli\n"
        "calls = json.load(sys.stdin)\n"
        "for name, argv in calls:\n"
        "    code = cli.main(argv)\n"
        "    assert 'nous_os.mcp' not in sys.modules, 'mcp module was imported'\n"
        "    assert code == 0, (name, code)\n"
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
