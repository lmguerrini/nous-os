"""G-INJECT drives the real CLI and stdio routes through a bounded hostile matrix.

The selected attempt axis contains one fixture row for each live corpus family
plus the benign reference.  Every catalogue entry and every subset of the
live ``Tier`` members is covered for both routes.  The remaining corpus rows
are explicit NOT_RUN scope entries: this file makes no claim about them, so
the gate is smaller than the pre-existing direct-call matrix.  Hostile text
is in each startup holder; entries with a plain text field receive it there
as well.  This checks content-independent authority decisions through the
actual transports, not arbitrary typed carrier values.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import pytest

import nous_os.capability as capability
import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier

import test_injection as injection
import test_mcp


_BENIGN = "beta"


class _MatrixFailure(AssertionError):
    """Raised when a counted transport matrix does not meet its contract."""


@dataclass(frozen=True, slots=True)
class _Attempt:
    """One reference or hostile text body in the declared attempt axis."""

    identifier: str
    text: str


@dataclass(frozen=True, slots=True)
class _NotRun:
    """A selected cell, or a declared omitted row, with a specific cause."""

    transport: str
    operation: str
    tiers: tuple[str, ...]
    attempt: str
    side: str
    reason: str


@dataclass(frozen=True, slots=True)
class _Call:
    """One transport call classified without keeping transport-shaped output."""

    kind: str
    reason: str | None


@dataclass(frozen=True, slots=True)
class _Transport:
    """A live public entry and the driver shape that invokes it."""

    name: str
    entry: Callable[..., object]
    driver: Callable[..., _Call]


@dataclass(frozen=True, slots=True)
class _MatrixResult:
    """Counts and named third-state entries from one realised matrix."""

    expected: int
    realised: int
    authorized_effects: frozenset[str]
    unauthorized_effects: tuple[_NotRun, ...]
    not_run: tuple[_NotRun, ...]


def _workspace(root: Path) -> tuple[object, core.Workspace]:
    """Reuse the checked fixture world so every read route has real data."""
    world = injection._build_world(root)
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


def _workspace_argv(workspace: core.Workspace, holder: str) -> list[str]:
    """Build CLI startup arguments while preserving hostile holder text exactly."""
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
        "--holder=" + holder,
    ]


def _arguments(descriptor: core.OperationDescriptor, world: object, text: str) -> dict[str, object]:
    """Build valid JSON input, adding hostile text to each available text entry."""
    arguments = test_mcp._minimal_arguments(descriptor.external_name)
    if descriptor.external_name == "provenance.span":
        arguments["citation"] = world.citation.as_payload()
    elif descriptor.external_name == "knowledge.search":
        escaped = text.replace('"', '""')
        arguments["query"] = f'alpha OR "{escaped}"'
    elif descriptor.external_name == "candidate.propose":
        arguments["content"] = text
    elif descriptor.external_name == "candidate.adjudicate":
        arguments["reason"] = text
    return arguments


def _file_bytes(root: Path) -> tuple[tuple[str, bytes], ...]:
    """Read every file below one fixture root in lexical pathname order."""
    if not root.is_dir():
        return ()
    return tuple(
        (path.relative_to(root).as_posix(), path.read_bytes())
        for path in sorted(path for path in root.rglob("*") if path.is_file())
    )


def _cli_call(
    entry: Callable[..., object],
    descriptor: core.OperationDescriptor,
    arguments: dict[str, object],
    grant: Grant,
    workspace: core.Workspace,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> _Call:
    """Call ``cli.main`` while injecting the exact live-subset grant at startup."""
    argv = _workspace_argv(workspace, grant.holder)
    argv.append(descriptor.external_name)
    for parameter in descriptor.parameters:
        if parameter.name not in arguments:
            continue
        option = "--" + parameter.name.replace("_", "-")
        value = arguments[parameter.name]
        if type(value) is bool:
            argv.append(option if value else "--no-" + parameter.name.replace("_", "-"))
        elif type(value) in (dict, list):
            argv.append(option + "=" + json.dumps(value))
        else:
            argv.append(option + "=" + str(value))
    capsys.readouterr()
    with monkeypatch.context() as patch:
        patch.setattr(cli, "_re" + "s" + "olve_grant", lambda namespace, environ: grant)
        code = entry(argv)
    captured = capsys.readouterr()
    if code == 0:
        if captured.err:
            return _Call("failed", "CLI wrote stderr on success")
        try:
            json.loads(captured.out)
        except json.JSONDecodeError as error:
            return _Call("failed", f"CLI stdout was not JSON: {error}")
        return _Call("success", None)
    if captured.err.startswith("NotAuthorized:"):
        return _Call("refused", None)
    return _Call("failed", captured.err.strip())


def _mcp_call(
    entry: Callable[..., object],
    descriptor: core.OperationDescriptor,
    arguments: dict[str, object],
    grant: Grant,
    workspace: core.Workspace,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> _Call:
    """Call ``mcp.dispatch`` and keep only success, refusal, or a typed failure."""
    del capsys, monkeypatch
    response = entry(
        {
            "jsonrpc": "2.0",
            "id": descriptor.external_name,
            "method": "tools/call",
            "params": {"name": descriptor.external_name, "arguments": arguments},
        },
        grant,
        workspace,
    )
    if type(response) is not dict:
        return _Call("failed", "MCP gave no response")
    error = response.get("error")
    if type(error) is dict:
        message = error.get("message")
        if type(message) is str and message.startswith("NotAuthorized:"):
            return _Call("refused", None)
        return _Call("failed", str(message))
    result = response.get("result")
    if type(result) is not dict:
        return _Call("failed", "MCP gave no result")
    content = result.get("content")
    if type(content) is not list or len(content) != 1 or type(content[0]) is not dict:
        return _Call("failed", "MCP gave malformed content")
    text = content[0].get("text")
    if type(text) is not str:
        return _Call("failed", "MCP gave non-text content")
    try:
        json.loads(text)
    except json.JSONDecodeError as error:
        return _Call("failed", f"MCP content was not JSON: {error}")
    return _Call("success", None)


def _live_transports() -> tuple[_Transport, ...]:
    """Bind the two required public entries at the time the matrix begins."""
    transports = (
        _Transport("cli.main", cli.main, _cli_call),
        _Transport("mcp.dispatch", mcp.dispatch, _mcp_call),
    )
    if not transports:
        raise _MatrixFailure("NOT_RUN: real transport axis was empty")
    return transports


def _tier_sets() -> tuple[frozenset[Tier], ...]:
    """Derive every subset, including the empty grant, from current Tier members."""
    tiers = tuple(Tier)
    values = tuple(
        frozenset(selected)
        for size in range(len(tiers) + 1)
        for selected in combinations(tiers, size)
    )
    if not values:
        raise _MatrixFailure("NOT_RUN: tier-subset axis was empty")
    return values


def _attempts() -> tuple[tuple[_Attempt, ...], tuple[_NotRun, ...]]:
    """Select one row per live family and name every out-of-scope fixture row."""
    corpus = injection._load_corpus()
    families = tuple(dict.fromkeys(entry.family for entry in corpus))
    selected = tuple(next(entry for entry in corpus if entry.family == family) for family in families)
    selected_ids = frozenset(entry.identifier for entry in selected)
    omitted = tuple(entry for entry in corpus if entry.identifier not in selected_ids)
    attempts = (_Attempt("benign_reference", _BENIGN),) + tuple(
        _Attempt(entry.identifier, entry.text) for entry in selected
    )
    not_run = tuple(
        _NotRun(
            "scope",
            "all catalogue entries",
            (),
            entry.identifier,
            "scope",
            "one row per live hostile family is the declared bounded scope",
        )
        for entry in omitted
    )
    if not attempts:
        raise _MatrixFailure("NOT_RUN: attempt axis was empty")
    return attempts, not_run


def _not_run(
    transport: _Transport,
    descriptor: core.OperationDescriptor,
    tiers: frozenset[Tier],
    attempt: _Attempt,
    side: str,
    reason: str,
) -> _NotRun:
    """Make every non-running selected cell carry its own complete identity."""
    return _NotRun(
        transport.name,
        descriptor.external_name,
        tuple(sorted(tier.value for tier in tiers)),
        attempt.identifier,
        side,
        reason,
    )


def _assert_cell_count(realised: int, expected: int) -> None:
    """Keep the denominator check explicit so a dropped axis item cannot pass."""
    if realised != expected:
        raise _MatrixFailure(f"matrix realised {realised} cells, expected {expected}")


def _run_matrix(
    root: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *,
    transports: tuple[_Transport, ...],
    operations: tuple[core.OperationDescriptor, ...],
    tier_sets: tuple[frozenset[Tier], ...],
    attempts: tuple[_Attempt, ...],
) -> _MatrixResult:
    """Run each selected cell twice: benign reference then hostile sample."""
    if not transports or not operations or not tier_sets or not attempts:
        raise _MatrixFailure("NOT_RUN: a selected matrix axis was empty")
    expected = len(transports) * len(operations) * len(tier_sets) * len(attempts)
    worlds: dict[tuple[str, str, str], tuple[object, core.Workspace]] = {}
    for transport in transports:
        for descriptor in operations:
            for side in ("reference", "sample"):
                worlds[(transport.name, descriptor.external_name, side)] = _workspace(
                    root / transport.name.replace(".", "_") / descriptor.external_name / side
                )

    realised = 0
    authorized_effects: set[str] = set()
    unauthorized_effects: list[_NotRun] = []
    not_run: list[_NotRun] = []
    for attempt in attempts:
        for descriptor in operations:
            for transport in transports:
                reference_world, reference_workspace = worlds[
                    (transport.name, descriptor.external_name, "reference")
                ]
                sample_world, sample_workspace = worlds[
                    (transport.name, descriptor.external_name, "sample")
                ]
                for tiers in tier_sets:
                    realised += 1
                    reference_before = _file_bytes(reference_world.root.parent)
                    reference = transport.driver(
                        transport.entry,
                        descriptor,
                        _arguments(descriptor, reference_world, _BENIGN),
                        Grant(_BENIGN, tiers),
                        reference_workspace,
                        capsys,
                        monkeypatch,
                    )
                    reference_after = _file_bytes(reference_world.root.parent)
                    sample_before = _file_bytes(sample_world.root.parent)
                    sample = transport.driver(
                        transport.entry,
                        descriptor,
                        _arguments(descriptor, sample_world, attempt.text),
                        Grant(attempt.text, tiers),
                        sample_workspace,
                        capsys,
                        monkeypatch,
                    )
                    sample_after = _file_bytes(sample_world.root.parent)
                    if reference.kind == "failed":
                        not_run.append(
                            _not_run(
                                transport,
                                descriptor,
                                tiers,
                                attempt,
                                "reference",
                                reference.reason or "unknown reference failure",
                            )
                        )
                        continue
                    if sample.kind == "failed":
                        not_run.append(
                            _not_run(
                                transport,
                                descriptor,
                                tiers,
                                attempt,
                                "sample",
                                sample.reason or "unknown sample failure",
                            )
                        )
                        continue
                    authorized = descriptor.tier in tiers
                    if authorized:
                        if reference.kind != "success" or sample.kind != "success":
                            not_run.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "decision",
                                    "an authorized call did not succeed on both bodies",
                                )
                            )
                            continue
                        if reference_before != reference_after or sample_before != sample_after:
                            authorized_effects.add(transport.name)
                    else:
                        if reference.kind != "refused" or sample.kind != "refused":
                            not_run.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "decision",
                                    "a grant without the required tier did not refuse both bodies",
                                )
                            )
                        if reference_before != reference_after:
                            unauthorized_effects.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "reference",
                                    "an unauthorized reference call changed fixture bytes",
                                )
                            )
                        if sample_before != sample_after:
                            unauthorized_effects.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "sample",
                                    "an unauthorized hostile call changed fixture bytes",
                                )
                            )
    return _MatrixResult(
        expected,
        realised,
        frozenset(authorized_effects),
        tuple(unauthorized_effects),
        tuple(not_run),
    )


def _assert_complete(result: _MatrixResult, transports: tuple[_Transport, ...]) -> None:
    """Refuse a partial, empty-positive, or unauthorized-effect matrix result."""
    _assert_cell_count(result.realised, result.expected)
    if result.not_run:
        raise _MatrixFailure(f"NOT_RUN selected cells: {result.not_run!r}")
    if result.unauthorized_effects:
        raise _MatrixFailure(f"unauthorized consequential actions: {result.unauthorized_effects!r}")
    required_effects = frozenset(transport.name for transport in transports)
    if result.authorized_effects != required_effects:
        raise _MatrixFailure(
            f"NOT_RUN: authorized effects={result.authorized_effects!r}, "
            f"required={required_effects!r}"
        )


def test_g_inject_real_transports_cover_the_declared_live_matrix(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No selected hostile body may change a real transport's authority result."""
    transports = _live_transports()
    operations = tuple(core.CATALOGUE)
    tier_sets = _tier_sets()
    attempts, scope_not_run = _attempts()
    result = _run_matrix(
        tmp_path / "matrix",
        capsys,
        monkeypatch,
        transports=transports,
        operations=operations,
        tier_sets=tier_sets,
        attempts=attempts,
    )
    expected = len(transports) * len(operations) * len(tier_sets) * len(attempts)
    _assert_cell_count(result.expected, expected)
    _assert_complete(result, transports)
    corpus = injection._load_corpus()
    omitted_cells = len(transports) * len(operations) * len(tier_sets) * len(scope_not_run)
    assert len(scope_not_run) + len(attempts) - 1 == len(corpus)
    assert omitted_cells == len(transports) * len(operations) * len(tier_sets) * (
        len(corpus) - (len(attempts) - 1)
    )
    assert all(item.reason for item in scope_not_run)


def test_g_inject_n5_route_without_authorization_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N5 proves that a server route calling an implementation directly fails the gate."""
    descriptor = next(
        item for item in core.CATALOGUE if item.external_name == "candidate.propose"
    )

    def unchecked(message: object, grant: Grant, workspace: core.Workspace) -> dict[str, object]:
        if type(message) is not dict:
            raise _MatrixFailure("unchecked route received a non-object message")
        params = message.get("params")
        if type(params) is not dict or params.get("name") != descriptor.external_name:
            raise _MatrixFailure("unchecked route received another operation")
        arguments = params.get("arguments")
        if type(arguments) is not dict:
            raise _MatrixFailure("unchecked route received non-object arguments")
        bound = core._bind_json_arguments(descriptor, arguments)
        kwargs = core._BINDERS[descriptor.external_name](workspace, bound)
        operation = descriptor.operation
        if type(operation) is not str:
            raise _MatrixFailure("unchecked route has no governed operation")
        implementation = capability._REGISTRY[operation][1]
        rendered = core._RENDERERS[descriptor.external_name](implementation(**kwargs))
        return {
            "jsonrpc": "2.0",
            "id": message.get("id"),
            "result": {"content": [{"type": "text", "text": json.dumps(rendered, sort_keys=True)}]},
        }

    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", unchecked)
        transports = tuple(
            transport for transport in _live_transports() if transport.name == "mcp.dispatch"
        )
        result = _run_matrix(
            tmp_path / "n5",
            capsys,
            monkeypatch,
            transports=transports,
            operations=(descriptor,),
            tier_sets=(frozenset(),),
            attempts=(_Attempt("benign_reference", _BENIGN),),
        )
        with pytest.raises(_MatrixFailure, match="did not refuse"):
            _assert_complete(result, transports)


def test_g_inject_n7_dropped_axis_item_is_detected() -> None:
    """N7 proves that a smaller operation axis cannot report a clean matrix."""
    transports = _live_transports()
    operations = tuple(core.CATALOGUE)
    tier_sets = _tier_sets()
    attempts, _scope_not_run = _attempts()
    reduced = operations[:-1]
    expected = len(transports) * len(operations) * len(tier_sets) * len(attempts)
    realised = len(transports) * len(reduced) * len(tier_sets) * len(attempts)
    with pytest.raises(_MatrixFailure, match="matrix realised"):
        _assert_cell_count(realised, expected)
