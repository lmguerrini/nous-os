"""G-INJECT drives the real CLI and stdio routes through a bounded hostile matrix.

The selected attempt axis contains one fixture row for each live corpus family
plus the benign reference.  Every catalogue entry and every subset of the
live ``Tier`` members is covered for both routes.  The remaining corpus rows
are explicit NOT_RUN scope entries: this file makes no claim about them, so
the gate is smaller than the pre-existing direct-call matrix.  Hostile text is
in each startup holder, so it travels the way ``Grant.holder`` actually would;
that value is handed straight to ``dispatch`` on the server arm and never
crosses the JSON-RPC wire, so it is not itself a request-payload claim.
Independently, every catalogue entry that declares a parameter capable of
carrying free text -- a JSON string not otherwise constrained to a closed
vocabulary, an identifier format, or an exact quoted span -- receives the
identical hostile text in its request payload too, so it genuinely travels
the transport: see ``_arguments`` for exactly which parameter each entry
uses and why. ``system.capabilities``, ``system.health``, and every
no-parameter read carry no field at all and cannot carry request-payload
text by construction. ``canon.versions`` and ``provenance.span`` decline on
purpose: ``canon.versions``'s only parameter is a source identifier that must
match a closed format, and ``provenance.span``'s only string-bearing field is
a citation whose quoted span is checked byte-for-byte against a real
snapshot, so substituting hostile text into either would not exercise a text
field -- it would build a different, differently invalid request. This
checks content-independent authority decisions through the actual
transports, not arbitrary typed carrier values. The CLI arm injects a grant
because the empty tier subset has no CLI spelling; the CLI's own startup grant
resolution is covered separately in its transport tests.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, replace
from itertools import combinations
from pathlib import Path
from types import SimpleNamespace

import pytest

import nous_os.capability as capability
import nous_os.cli as cli
import nous_os.core as core
import nous_os.mcp as mcp
from nous_os.capability import Grant, Tier
from nous_os.discovery import Gate

import test_injection as injection
import test_mcp


_BENIGN = "beta"

#: An independently pinned public set. The matrix binds entries live below,
#: while this value makes a dropped production route a failure instead of a
#: smaller denominator that happens to agree with itself.
_EXPECTED_TRANSPORT_NAMES = frozenset({"cli.main", "mcp.dispatch"})

#: An independently pinned public set, the way the transport axis already is:
#: typed here rather than derived from ``core.CATALOGUE``, so a catalogue
#: entry silently dropped from the axis a test run is handed cannot also
#: shrink the one set that is supposed to catch that.
_EXPECTED_OPERATION_NAMES = frozenset(
    {
        "system.capabilities",
        "system.health",
        "knowledge.search",
        "canon.documents",
        "canon.describe",
        "canon.sources",
        "canon.versions",
        "provenance.span",
        "graph.project",
        "time.as_of",
        "time.conflicts",
        "time.supersession",
        "context.compile",
        "candidate.proposals",
        "candidate.rejections",
        "candidate.bridges",
        "candidate.propose",
        "candidate.discover",
        "candidate.adjudicate",
        "reconcile.relations",
        "reconcile.propose",
        "reconcile.verify",
    }
)


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
    world.snapshots.put(
        test_mcp.SECOND_SOURCE_ID,
        world.snapshots.get(test_mcp.SOURCE_ID, world.citation.snapshot_digest).data,
    )
    workspace = core.Workspace(
        data_root=world.data_root,
        snapshot_root=world.root / "snapshots",
        ledger_path=world.ledger.path,
        derived_path=world.derived_path,
        candidate_store_path=world.candidates._path,
        bridge_registry_path=world.bridges._path,
        rejection_memory_path=world.rejections._path,
        relation_store_path=world.root / "relations.jsonl",
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
        "--relation-store-path",
        str(workspace.relation_store_path),
        "--holder=" + holder,
    ]


#: A structurally valid citation with no free text of its own -- source
#: identifier and digest are both format-constrained -- used only to satisfy
#: an assertion or endpoint's required ``citation`` field so the hostile text
#: below can sit in the field this file actually claims to drive.
_HOSTILE_CITATION_PAYLOAD: dict[str, object] = {
    "source_id": test_mcp.SOURCE_ID,
    "snapshot_digest": "0" * 64,
    "start_byte": 0,
    "end_byte": 5,
    "span": "a",
}

#: The one claim key every hostile assertion and ``time.supersession``'s own
#: ``key`` argument share, so a hostile assertion is always the one that key
#: would actually return.
_HOSTILE_CLAIM_KEY = "fixture-key"


def _hostile_assertion_payload(text: str) -> dict[str, object]:
    """One assertion whose free ``text`` field carries the hostile sample."""
    return {
        "key": _HOSTILE_CLAIM_KEY,
        "id": "asr_0000000000000000000000000A",
        "text": text,
        "citation": _HOSTILE_CITATION_PAYLOAD,
        "support": "direct_quote",
        "recorded_at": "2026-01-02T12:00:00+00:00",
        "valid_from": None,
        "valid_to": None,
    }


def _hostile_index_payload(text: str) -> dict[str, object]:
    return {"assertions": [_hostile_assertion_payload(text)]}


def _hostile_chunk_payload(text: str) -> dict[str, object]:
    """One chunk whose free ``text`` field carries the hostile sample."""
    return {
        "id": f"{test_mcp.SOURCE_ID}#0000",
        "source_id": test_mcp.SOURCE_ID,
        "ordinal": 0,
        "heading_path": [],
        "text": text,
        "tokens": 1,
        "references": [],
    }


def _hostile_bridge_card_payload(text: str) -> dict[str, object]:
    """One bridge card whose free ``consequence`` field carries the hostile sample."""
    endpoint = {
        "project": "gate-inject project",
        "citation": _HOSTILE_CITATION_PAYLOAD,
        "quote": "alpha",
    }
    return {
        "card_id": "asr_01ARZ3NDEKTSV4RRFFQ69G5FAC",
        "cluster_id": "gate-inject-cluster",
        "left": endpoint,
        "right": endpoint,
        "epistemic_class": "derived",
        "depth": "deep",
        "non_triviality": "crosses two seeded projects",
        "consequence": text,
        "noise_objection": "the shared word may be coincidental",
        "gates": {
            "outcomes": {gate.value: "pass" for gate in Gate},
            "reasons": {},
            "triviality": None,
        },
        "origin_round": 1,
    }


def _arguments(descriptor: core.OperationDescriptor, world: object, text: str) -> dict[str, object]:
    """Build valid JSON input, adding hostile text to each available text entry.

    ``knowledge.search``, ``candidate.propose``, and ``candidate.adjudicate``
    put the hostile sample directly into an already free-text parameter.
    ``graph.project``, the two temporal reads with an assertion body,
    ``time.supersession``, ``context.compile``, and ``candidate.discover``
    have no bare text parameter of their own; each is instead handed one
    caller-supplied record -- an assertion, a chunk, or a bridge card -- whose
    own free-text field carries the hostile sample, so the transport still
    genuinely carries it in the request payload rather than merely alongside
    the request in ``Grant.holder``.
    """
    arguments = test_mcp._minimal_arguments(descriptor.external_name)
    name = descriptor.external_name
    if name == "provenance.span":
        arguments["citation"] = world.citation.as_payload()
    elif name == "knowledge.search":
        escaped = text.replace('"', '""')
        arguments["query"] = f'alpha OR "{escaped}"'
    elif name == "candidate.propose":
        arguments["content"] = text
    elif name == "candidate.adjudicate":
        arguments["reason"] = text
    elif name == "reconcile.propose":
        relation = arguments["relation"]
        relation["left"]["snapshot_digest"] = world.citation.snapshot_digest
        relation["right"]["snapshot_digest"] = world.citation.snapshot_digest
        relation["notes"] = text
    elif name == "graph.project":
        arguments["state"] = {
            "index": _hostile_index_payload(text),
            "bridges": [],
            "rejections": [],
        }
    elif name in ("time.as_of", "time.conflicts", "time.supersession"):
        arguments["index"] = _hostile_index_payload(text)
    elif name == "context.compile":
        arguments["chunks"] = [_hostile_chunk_payload(text)]
        arguments["ranking"] = [f"{test_mcp.SOURCE_ID}#0000"]
    elif name == "candidate.discover":
        arguments["candidates"] = [_hostile_bridge_card_payload(text)]
    return arguments


def _file_bytes(root: Path) -> tuple[tuple[str, bytes], ...]:
    """Read every file below one fixture root in lexical pathname order."""
    if not root.is_dir():
        return ()
    return tuple(
        (path.relative_to(root).as_posix(), path.read_bytes())
        for path in sorted(path for path in root.rglob("*") if path.is_file())
    )


def _reraise_walk_error(error: OSError) -> None:
    """``os.walk``'s ``onerror`` hook: make a listing failure propagate.

    Left to its default, ``os.walk`` silently omits a directory it cannot
    list from what it yields, with no exception at all -- the same gap that
    would let a canonical file beneath an unreadable subtree go unhashed and
    :func:`_canon_bytes` report canon as unmoved when it could not actually
    be read.
    """
    raise error


def _iter_canonical_files(root: Path) -> tuple[Path, ...]:
    """Every regular file beneath ``root``, sorted, or a raised ``OSError``.

    Fails closed rather than silently enumerating fewer files than ``root``
    actually holds: a directory this process cannot list, or a file it names
    but cannot then stat, raises instead of being skipped.
    """
    try:
        root_info = os.stat(root)
    except (FileNotFoundError, NotADirectoryError):
        return ()
    if not stat.S_ISDIR(root_info.st_mode):
        raise OSError(f"canonical root is not a directory: {root}")
    paths: list[Path] = []
    for dirpath, _dirnames, filenames in os.walk(root, onerror=_reraise_walk_error):
        for filename in filenames:
            candidate = Path(dirpath) / filename
            try:
                info = os.stat(candidate)
            except (FileNotFoundError, NotADirectoryError):
                continue
            if stat.S_ISREG(info.st_mode):
                paths.append(candidate)
    return tuple(sorted(paths))


def _digest_part(digest: "hashlib._Hash", value: bytes) -> None:
    """Append one unambiguously framed byte string to a canonical digest."""
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _ledger_bytes(path: Path) -> bytes:
    """Read the canonical ledger while preserving absence as a distinct result."""
    try:
        info = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return b""
    if not stat.S_ISREG(info.st_mode):
        raise OSError(f"canonical ledger is not a regular file: {path}")
    return path.read_bytes()


def _canon_bytes(world: object) -> bytes:
    """Hash canon precisely: the data root's own files, every snapshot, and the ledger.

    Narrower than :func:`_file_bytes` on purpose, and reused for a different
    comparison: a route can legitimately leave a *store* -- the candidate
    file this catalogue's own PROPOSE-tier writes are supposed to reach --
    different between a reference and a hostile call, since the two bodies
    genuinely differ; canon is not supposed to move at all, from any of the
    operations this catalogue offers, so an equal digest is the property
    worth comparing directly rather than merely "something changed".
    """
    digest = hashlib.sha256()
    for root, label in ((world.data_root.path, b"canon"), (world.root / "snapshots", b"snapshot")):
        for path in _iter_canonical_files(root):
            _digest_part(digest, label)
            _digest_part(digest, path.relative_to(root).as_posix().encode("utf-8"))
            _digest_part(digest, path.read_bytes())
    ledger_payload = _ledger_bytes(world.ledger.path)
    _digest_part(digest, b"ledger")
    _digest_part(digest, b"")
    _digest_part(digest, ledger_payload)
    return digest.digest()


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
        patch.setattr(cli, "_resolve_grant", lambda namespace, environ: grant)
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
    """Bind the production entries live, then check their independently pinned set."""
    transports = (
        _Transport("cli.main", cli.main, _cli_call),
        _Transport("mcp.dispatch", mcp.dispatch, _mcp_call),
    )
    _assert_live_transport_axis(transports)
    return transports


def _assert_live_transport_axis(transports: tuple[_Transport, ...]) -> None:
    """Keep a production transport deletion from shrinking every dependent check."""
    names = tuple(transport.name for transport in transports)
    if len(names) != len(set(names)) or frozenset(names) != _EXPECTED_TRANSPORT_NAMES:
        raise _MatrixFailure(
            f"transport axis={names!r}, expected exactly {_EXPECTED_TRANSPORT_NAMES!r}"
        )


def _assert_live_operation_axis(operations: tuple[core.OperationDescriptor, ...]) -> None:
    """Keep a catalogue entry silently dropped from the operation axis from passing anyway.

    ``_run_matrix`` derives its own ``expected`` count from the ``operations``
    argument it is handed, and the calling test's own counts derive from that
    identical value, so a caller passing ``core.CATALOGUE[:-1]`` shrinks every
    dependent denominator consistently and the arithmetic alone could never
    catch it. Comparing against a set typed here, independent of
    ``core.CATALOGUE``, is what actually can.
    """
    names = tuple(descriptor.external_name for descriptor in operations)
    if len(names) != len(set(names)) or frozenset(names) != _EXPECTED_OPERATION_NAMES:
        raise _MatrixFailure(
            f"operation axis={names!r}, expected exactly {_EXPECTED_OPERATION_NAMES!r}"
        )


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
    execution_context: list[tuple[str, tuple[str, ...], str, str]] | None = None,
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

                    def drive(
                        side: str,
                        arguments: dict[str, object],
                        grant: Grant,
                        workspace: core.Workspace,
                    ) -> _Call:
                        if descriptor.external_name == "reconcile.propose":
                            workspace = replace(
                                workspace,
                                relation_store_path=workspace.relation_store_path.with_name(
                                    f"relations-{realised}-{side}.jsonl"
                                ),
                            )
                        if execution_context is not None:
                            execution_context.append(
                                (
                                    transport.name,
                                    tuple(sorted(tier.value for tier in tiers)),
                                    attempt.identifier,
                                    side,
                                )
                            )
                        try:
                            return transport.driver(
                                transport.entry,
                                descriptor,
                                arguments,
                                grant,
                                workspace,
                                capsys,
                                monkeypatch,
                            )
                        finally:
                            if execution_context is not None:
                                execution_context.pop()

                    reference_before = _file_bytes(reference_world.root.parent)
                    reference_canon_before = _canon_bytes(reference_world)
                    reference = drive(
                        "reference",
                        _arguments(descriptor, reference_world, _BENIGN),
                        Grant(_BENIGN, tiers),
                        reference_workspace,
                    )
                    reference_after = _file_bytes(reference_world.root.parent)
                    reference_canon_after = _canon_bytes(reference_world)
                    sample_before = _file_bytes(sample_world.root.parent)
                    sample_canon_before = _canon_bytes(sample_world)
                    sample = drive(
                        "sample",
                        _arguments(descriptor, sample_world, attempt.text),
                        Grant(attempt.text, tiers),
                        sample_workspace,
                    )
                    sample_after = _file_bytes(sample_world.root.parent)
                    sample_canon_after = _canon_bytes(sample_world)
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
                        # A success on both bodies is not by itself the property
                        # worth holding: a route that returns the ordinary
                        # result and *additionally* writes canon only for the
                        # hostile body would pass that check every time, and
                        # that is the dangerous case -- hostile content gaining
                        # consequential power after legitimate authorization.
                        # Both worlds started from one identical fresh seed, so
                        # comparing their canon digests after the call directly
                        # states the property: canonical state must be equal
                        # between the reference and the hostile call.
                        if _canon_bytes(reference_world) != _canon_bytes(sample_world):
                            unauthorized_effects.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "decision",
                                    "an authorized hostile call left canon different from "
                                    "the authorized reference call",
                                )
                            )
                        # Comparing the two worlds' final canon digests to
                        # each other cannot see a write that lands identically
                        # on both: the same fixed bytes appended to canon on
                        # every call leave the two worlds equal to each other
                        # while canon still moved. Each world must also be
                        # compared to its own state before the call -- the
                        # docstring's own claim, "canon is not supposed to
                        # move at all" -- which is a before/after property,
                        # not a reference/hostile one.
                        if reference_canon_before != reference_canon_after:
                            unauthorized_effects.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "reference",
                                    "an authorized reference call moved canon, which must "
                                    "never move",
                                )
                            )
                        if sample_canon_before != sample_canon_after:
                            unauthorized_effects.append(
                                _not_run(
                                    transport,
                                    descriptor,
                                    tiers,
                                    attempt,
                                    "sample",
                                    "an authorized hostile call moved canon, which must "
                                    "never move",
                                )
                            )
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


def _assert_governed_execution_counts(
    observed: list[tuple[str, str, tuple[str, ...], str, str]],
    transports: tuple[_Transport, ...],
    operations: tuple[core.OperationDescriptor, ...],
    tier_sets: tuple[frozenset[Tier], ...],
    attempts: tuple[_Attempt, ...],
) -> None:
    """Prove every selected registered execution crossed Core's ``execute`` binding.

    Each selected cell runs both reference and hostile values. Core-level reads
    have no registered operation and therefore correctly contribute no call.

    ``observed`` is keyed by ``(transport, operation, tiers, attempt, side)``.
    A coarser key can hide a missing execution in one cell if another cell of
    the same transport and operation is counted twice; retaining every axis
    makes each missing or repeated execution visible on its own.
    """
    expected: Counter[tuple[str, str, tuple[str, ...], str, str]] = Counter()
    for transport in transports:
        for descriptor in operations:
            if descriptor.operation is not None:
                for tiers in tier_sets:
                    tier_names = tuple(sorted(tier.value for tier in tiers))
                    for attempt in attempts:
                        for side in ("reference", "sample"):
                            expected[
                                (
                                    transport.name,
                                    descriptor.operation,
                                    tier_names,
                                    attempt.identifier,
                                    side,
                                )
                            ] += 1
    actual = Counter(observed)
    if actual != expected:
        raise _MatrixFailure(
            f"governed executions through execute={actual!r}, expected={expected!r}"
        )


def _wrap_registered_implementations(
    monkeypatch: pytest.MonkeyPatch, active: dict[str, int]
) -> None:
    """Require registry-reached implementation calls to occur during an active ``execute``.

    ``_assert_governed_execution_counts`` proves only that the number of
    crossings through ``core.execute`` matches expectation per cell -- a
    replacement bypass, the shape N5 and N9 drive. It cannot see a transport
    that calls ``core.invoke`` normally, producing exactly the expected
    counted crossing, and *additionally* calls a registered implementation
    directly through the ``capability._REGISTRY`` chain, discarding the
    result: that extra call never goes through ``execute`` at all, so it adds
    nothing to a count keyed on ``execute`` invocations, and every advertised
    control stays green. Wrapping every registry entry so a call while
    ``active["depth"]`` is not positive raises closes that gap by attributing
    each call reached through the current ``capability._REGISTRY`` chain to an
    active ``execute`` invocation rather than merely counting crossings.
    ``monkeypatch.setitem`` restores every entry automatically at the end of
    the test that installs this. It cannot observe an implementation alias
    saved before wrapping, held in a default or closure, or reached through a
    later local import; closing those routes needs call-level tracing, which
    is outside this test's scope.
    """
    for name, (tier, implementation) in tuple(capability._REGISTRY.items()):

        def _wrapper(
            __implementation: Callable[..., object] = implementation,
            __name: str = name,
            **kwargs: object,
        ) -> object:
            if active["depth"] <= 0:
                raise _MatrixFailure(
                    f"{__name!r} implementation ran outside an active execute() call"
                )
            return __implementation(**kwargs)

        monkeypatch.setitem(capability._REGISTRY, name, (tier, _wrapper))


def test_g_inject_real_transports_cover_the_declared_live_matrix(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No selected hostile body may change a real transport's authority result."""
    live = _live_transports()
    operations = tuple(core.CATALOGUE)
    _assert_live_operation_axis(operations)
    tier_sets = _tier_sets()
    attempts, scope_not_run = _attempts()
    transports = live
    execution_context: list[tuple[str, tuple[str, ...], str, str]] = []
    observed_execute_calls: list[tuple[str, str, tuple[str, ...], str, str]] = []
    original_execute = core.execute
    active_execute = {"depth": 0}

    def count_execute(grant: Grant, operation: str, **kwargs: object) -> object:
        if not execution_context:
            raise _MatrixFailure("execute ran outside a selected matrix cell")
        transport, tiers, attempt, side = execution_context[-1]
        observed_execute_calls.append((transport, operation, tiers, attempt, side))
        active_execute["depth"] += 1
        try:
            return original_execute(grant, operation, **kwargs)
        finally:
            active_execute["depth"] -= 1

    monkeypatch.setattr(core, "execute", count_execute)
    _wrap_registered_implementations(monkeypatch, active_execute)
    result = _run_matrix(
        tmp_path / "matrix",
        capsys,
        monkeypatch,
        transports=transports,
        operations=operations,
        tier_sets=tier_sets,
        attempts=attempts,
        execution_context=execution_context,
    )
    expected = len(transports) * len(operations) * len(tier_sets) * len(attempts)
    _assert_cell_count(result.expected, expected)
    _assert_complete(result, transports)
    _assert_governed_execution_counts(
        observed_execute_calls, transports, operations, tier_sets, attempts
    )
    corpus = injection._load_corpus()
    corpus_families = {entry.family for entry in corpus}
    selected_attempts = tuple(item for item in attempts if item.identifier != "benign_reference")
    selected_ids = {item.identifier for item in selected_attempts}
    by_identifier = {entry.identifier: entry for entry in corpus}
    assert {by_identifier[identifier].family for identifier in selected_ids} == corpus_families
    assert len(selected_ids) == len(corpus_families)
    assert {item.attempt for item in scope_not_run} == {
        entry.identifier for entry in corpus if entry.identifier not in selected_ids
    }
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
    """N7 proves a reduced operation axis is caught by the live gate itself.

    Not merely that the arithmetic helper rejects a mismatch computed by
    hand: ``expected`` and ``realised`` both deriving from one ``operations``
    argument was exactly why the earlier version of this control never drove
    a reduced axis through anything live -- shrinking that argument shrinks
    every denominator consistently and the arithmetic check alone can never
    see it. This drives the actual axis-pinning function
    ``test_g_inject_real_transports_cover_the_declared_live_matrix`` itself
    calls, with one real catalogue entry removed.
    """
    operations = tuple(core.CATALOGUE)
    reduced = operations[:-1]
    with pytest.raises(_MatrixFailure, match="operation axis"):
        _assert_live_operation_axis(reduced)


def test_g_inject_n8_dropped_transport_is_detected() -> None:
    """The pinned public transport set makes a shorter production axis fail."""
    transports = _live_transports()
    with pytest.raises(_MatrixFailure, match="transport axis"):
        _assert_live_transport_axis(transports[:-1])


def test_g_inject_canon_bytes_fails_closed_on_an_untraversable_directory(
    tmp_path: Path,
) -> None:
    """``_canon_bytes`` must not silently omit a canonical file it could not read.

    Before this fix it walked canon with ``rglob``, which quietly skips a
    directory it cannot list; a hostile write landing beneath such a
    directory would have left the digest reporting canon as unmoved. It must
    fail instead of reporting a tree it could not actually read as unchanged.
    """
    world, _workspace_value = _workspace(tmp_path / "untraversable")
    locked = world.data_root.path / "locked"
    locked.mkdir()
    (locked / "doc.md").write_text("canonical content", encoding="utf-8")
    original_mode = locked.stat().st_mode
    try:
        os.chmod(locked, 0)
        with pytest.raises(OSError):
            _canon_bytes(world)
    finally:
        os.chmod(locked, original_mode)


def _digest_world(root: Path, entries: dict[str, bytes]) -> object:
    data_root = root / "documents"
    data_root.mkdir(parents=True)
    for name, payload in entries.items():
        (data_root / name).write_bytes(payload)
    return SimpleNamespace(
        data_root=SimpleNamespace(path=data_root),
        root=root,
        ledger=SimpleNamespace(path=root / "ledger.jsonl"),
    )


def test_g_inject_canon_bytes_distinguishes_record_boundaries(tmp_path: Path) -> None:
    """The byte witness does not permit one record to absorb the next one."""
    first = _digest_world(
        tmp_path / "first", {"a": b"X", "b": b"Y\0canon\0c\0Z"}
    )
    second = _digest_world(
        tmp_path / "second", {"a": b"X\0canon\0b\0Y", "c": b"Z"}
    )
    assert _canon_bytes(first) != _canon_bytes(second)


def test_g_inject_canon_bytes_allows_a_dangling_canonical_symlink(tmp_path: Path) -> None:
    world = _digest_world(tmp_path / "dangling", {})
    (world.data_root.path / "missing.md").symlink_to(world.data_root.path / "gone.md")
    assert _canon_bytes(world)


def test_g_inject_canon_bytes_refuses_an_unreadable_canonical_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = _digest_world(tmp_path / "unreadable-root", {})
    original_stat = os.stat

    def unreadable(path: object, *args: object, **kwargs: object) -> os.stat_result:
        if Path(path) == world.data_root.path:
            raise PermissionError("simulated unreadable canonical root")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", unreadable)
    with pytest.raises(PermissionError, match="simulated unreadable canonical root"):
        _canon_bytes(world)


def test_g_inject_canon_bytes_refuses_an_unreadable_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = _digest_world(tmp_path / "unreadable-ledger", {})
    original_stat = os.stat

    def unreadable(path: object, *args: object, **kwargs: object) -> os.stat_result:
        if Path(path) == world.ledger.path:
            raise PermissionError("simulated unreadable canonical ledger")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", unreadable)
    with pytest.raises(PermissionError, match="simulated unreadable canonical ledger"):
        _canon_bytes(world)


def test_g_inject_n9_execution_outside_execute_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A route returning real values without Core's execution call fails the count guard."""
    descriptor = next(
        item for item in core.CATALOGUE if item.external_name == "candidate.propose"
    )
    execution_context: list[tuple[str, tuple[str, ...], str, str]] = []
    observed_execute_calls: list[tuple[str, str, tuple[str, ...], str, str]] = []
    original_execute = core.execute

    def count_execute(grant: Grant, operation: str, **kwargs: object) -> object:
        if not execution_context:
            raise _MatrixFailure("execute ran outside a selected matrix cell")
        transport, tiers, attempt, side = execution_context[-1]
        observed_execute_calls.append((transport, operation, tiers, attempt, side))
        return original_execute(grant, operation, **kwargs)

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

    monkeypatch.setattr(core, "execute", count_execute)
    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", unchecked)
        transports = tuple(
            transport for transport in _live_transports() if transport.name == "mcp.dispatch"
        )
        tier_sets = (frozenset({Tier.PROPOSE}),)
        attempts = (_Attempt("benign_reference", _BENIGN),)
        _run_matrix(
            tmp_path / "n9",
            capsys,
            monkeypatch,
            transports=transports,
            operations=(descriptor,),
            tier_sets=tier_sets,
            attempts=attempts,
            execution_context=execution_context,
        )
        with pytest.raises(_MatrixFailure, match="governed executions through execute"):
            _assert_governed_execution_counts(
                observed_execute_calls, transports, (descriptor,), tier_sets, attempts
            )


def test_g_inject_n13_additional_implementation_call_beside_a_normal_crossing_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N13 proves an extra direct implementation call beside a normal crossing fails the gate.

    Unlike N9's full replacement, this route calls the real ``mcp.dispatch``
    first -- producing exactly the expected counted crossing through
    ``execute`` -- and *additionally* calls a read implementation directly
    through the ``capability._REGISTRY`` chain, discarding the result. Before
    ``_wrap_registered_implementations``, every crossing-count control stayed
    green: the extra call adds nothing to a count keyed on ``execute``
    invocations. Only requiring each registered implementation call to be
    attributable to an active ``execute`` catches it.
    """
    descriptor = next(item for item in core.CATALOGUE if item.external_name == "canon.documents")
    execution_context: list[tuple[str, tuple[str, ...], str, str]] = []
    active_execute = {"depth": 0}
    original_execute = core.execute

    def count_execute(grant: Grant, operation: str, **kwargs: object) -> object:
        if not execution_context:
            raise _MatrixFailure("execute ran outside a selected matrix cell")
        active_execute["depth"] += 1
        try:
            return original_execute(grant, operation, **kwargs)
        finally:
            active_execute["depth"] -= 1

    original_dispatch = mcp.dispatch

    def sneaky(message: object, grant: Grant, workspace: core.Workspace) -> dict[str, object] | None:
        response = original_dispatch(message, grant, workspace)
        if (
            type(message) is dict
            and message.get("method") == "tools/call"
            and type(message.get("params")) is dict
            and message["params"].get("name") == descriptor.external_name
        ):
            operation = descriptor.operation
            assert type(operation) is str
            implementation = capability._REGISTRY[operation][1]
            implementation(root=workspace.data_root)  # discarded; the extra call itself is the point
        return response

    monkeypatch.setattr(core, "execute", count_execute)
    _wrap_registered_implementations(monkeypatch, active_execute)
    with monkeypatch.context() as patch:
        patch.setattr(mcp, "dispatch", sneaky)
        transports = tuple(
            transport for transport in _live_transports() if transport.name == "mcp.dispatch"
        )
        tier_sets = (frozenset({Tier.READ}),)
        attempts = (_Attempt("benign_reference", _BENIGN),)
        with pytest.raises(_MatrixFailure, match="outside an active execute"):
            _run_matrix(
                tmp_path / "n13",
                capsys,
                monkeypatch,
                transports=transports,
                operations=(descriptor,),
                tier_sets=tier_sets,
                attempts=attempts,
                execution_context=execution_context,
            )


def test_g_inject_n10_hostile_only_canonical_write_under_authorization_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N10 proves a hostile-only canonical write under a valid grant fails the gate.

    Before A2, the matrix's authorized branch asked only whether the
    reference and the hostile call both succeeded, and recorded any file
    change at all as an authorized positive effect -- so a route that
    returns the ordinary result and additionally writes canon *only* for
    the hostile body, under a grant that genuinely does hold PROPOSE, would
    have passed every assertion. This monkeypatches ``core.invoke`` to do
    exactly that for one hostile ``candidate.propose`` call, and proves the
    gate now catches it.
    """
    descriptor = next(item for item in core.CATALOGUE if item.external_name == "candidate.propose")
    original_invoke = core.invoke

    def leaking_invoke(
        grant: Grant, external_name: str, workspace: core.Workspace, arguments: dict[str, object]
    ) -> object:
        result = original_invoke(grant, external_name, workspace, arguments)
        if external_name == descriptor.external_name and grant.holder != _BENIGN:
            workspace.ledger_path.parent.mkdir(parents=True, exist_ok=True)
            with open(workspace.ledger_path, "ab") as handle:
                handle.write(b"hostile canonical write\n")
        return result

    monkeypatch.setattr(core, "invoke", leaking_invoke)
    transports = _live_transports()
    tier_sets = (frozenset({Tier.PROPOSE}),)
    corpus = injection._load_corpus()
    attempts = (
        _Attempt("benign_reference", _BENIGN),
        _Attempt(corpus[0].identifier, corpus[0].text),
    )
    result = _run_matrix(
        tmp_path / "n10",
        capsys,
        monkeypatch,
        transports=transports,
        operations=(descriptor,),
        tier_sets=tier_sets,
        attempts=attempts,
    )
    with pytest.raises(_MatrixFailure, match="unauthorized consequential actions"):
        _assert_complete(result, transports)


def test_g_inject_n12_content_independent_canonical_write_is_detected(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """N12 proves a canon write identical on both bodies still fails the gate.

    Comparing only the two worlds' post-call canon digests to each other, as
    N10's fix did, cannot see this: writing the same fixed bytes on every
    call -- benign and hostile alike -- leaves the reference and the hostile
    world's canon equal to each other, exactly as an unmoved canon would,
    because both worlds started from one identical seed. Only comparing each
    world's own canon digest before the call to after sees that canon moved
    at all, regardless of which body triggered it.
    """
    descriptor = next(item for item in core.CATALOGUE if item.external_name == "candidate.propose")
    original_invoke = core.invoke

    def leaking_invoke(
        grant: Grant, external_name: str, workspace: core.Workspace, arguments: dict[str, object]
    ) -> object:
        result = original_invoke(grant, external_name, workspace, arguments)
        if external_name == descriptor.external_name:
            workspace.ledger_path.parent.mkdir(parents=True, exist_ok=True)
            with open(workspace.ledger_path, "ab") as handle:
                handle.write(b"content independent canonical write\n")
        return result

    monkeypatch.setattr(core, "invoke", leaking_invoke)
    transports = _live_transports()
    tier_sets = (frozenset({Tier.PROPOSE}),)
    corpus = injection._load_corpus()
    attempts = (
        _Attempt("benign_reference", _BENIGN),
        _Attempt(corpus[0].identifier, corpus[0].text),
    )
    result = _run_matrix(
        tmp_path / "n12",
        capsys,
        monkeypatch,
        transports=transports,
        operations=(descriptor,),
        tier_sets=tier_sets,
        attempts=attempts,
    )
    with pytest.raises(_MatrixFailure, match="unauthorized consequential actions"):
        _assert_complete(result, transports)


def test_g_inject_n11_compensating_miscounts_within_one_route_are_detected() -> None:
    """N11 proves a repeated reference execution cannot mask a missing sample execution.

    Both observations belong to one transport-operation pair and preserve that
    pair's total of two. A counter keyed only by that pair would accept them;
    the full cell key must instead raise because the reference side appears
    twice and the sample side does not appear.
    """
    transports = (_live_transports()[0],)
    descriptor = next(item for item in core.CATALOGUE if item.external_name == "candidate.propose")
    tier_sets = (frozenset({Tier.PROPOSE}),)
    attempts = (_Attempt("benign_reference", _BENIGN),)
    assert descriptor.operation is not None
    tiers = (Tier.PROPOSE.value,)
    observed = [
        (transports[0].name, descriptor.operation, tiers, "benign_reference", "reference"),
        (transports[0].name, descriptor.operation, tiers, "benign_reference", "reference"),
    ]
    with pytest.raises(_MatrixFailure, match="governed executions through execute"):
        _assert_governed_execution_counts(observed, transports, (descriptor,), tier_sets, attempts)
