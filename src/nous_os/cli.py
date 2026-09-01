"""The command-line transport. One subcommand per catalogue descriptor, generated.

This module reads exactly one thing about the project's governed operations:
:data:`nous_os.core.CATALOGUE`. Every subcommand, every option, and every
declared parameter comes from walking that tuple, never from a hand-written
list living beside it -- so the surface this module exposes and the surface
:mod:`nous_os.core` publishes cannot drift apart from having been typed twice.

**This module never imports a domain module and never calls
:func:`nous_os.capability.execute`.** Every governed decision is made by
:func:`nous_os.core.invoke`; this module's only job is turning a parsed
command line into the ``(grant, external_name, workspace, arguments)`` tuple
that function requires, and turning its JSON-shaped result back into stdout.

**Authority is declared once, at startup, and nothing in a request can widen
it.** The tier set a process runs with comes from ``--tier`` or the
``NOUS_OS_CLI_TIERS`` environment variable, read before any subcommand is
parsed, and defaults to :attr:`~nous_os.capability.Tier.READ` alone. No
argument value, no subcommand name, and no holder string changes it: the
:class:`~nous_os.capability.Grant` built from it is constructed once, from
process-level input, and handed unchanged to every call ``main`` makes.

This module never imports :mod:`nous_os.mcp`, in either direction.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Final

from nous_os import __version__
from nous_os import core
from nous_os.artifact import load_artifact
from nous_os.capability import Grant, Tier

__all__ = ("main", "CliError", "ConflictingProposalSource")


class CliError(Exception):
    """Base error for a request this transport refuses before or instead of calling Core."""


class ConflictingProposalSource(CliError):
    """Raised when ``--from-artifact`` is combined with an explicit proposal field."""


#: Resolution order for the tier set a process declares, highest first: an
#: explicit ``--tier`` on the command line, then this environment variable,
#: then the fixed default of READ alone. Mirrors
#: :func:`nous_os.core.resolve_workspace`'s own explicit-argument-then-
#: environment-then-refuse order, except the third step here is a default
#: rather than a refusal, because a transport that declares nothing is
#: choosing the narrowest authority rather than failing to configure itself.
TIER_ENV_VAR: Final = "NOUS_OS_CLI_TIERS"

#: Resolution order for the grant holder identity: an explicit ``--holder``,
#: then this environment variable, then a fixed literal.
HOLDER_ENV_VAR: Final = "NOUS_OS_CLI_HOLDER"

_DEFAULT_HOLDER: Final = "cli"

#: The one option ``candidate.propose`` carries that no catalogue descriptor
#: declares: a local file path to import proposals from. It sources
#: arguments for the existing operation; it is not a second operation, and
#: the subcommand name it attaches to is unchanged.
_IMPORT_OPTION_DEST: Final = "from_artifact"


def _option_name(parameter_name: str) -> str:
    return "--" + parameter_name.replace("_", "-")


def _json_argument(raw: str) -> object:
    """Parse one CLI option's raw text as JSON, for an array- or object-shaped parameter."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise argparse.ArgumentTypeError(f"not valid JSON: {error}") from error


def _add_parameter_argument(
    parser: argparse.ArgumentParser, parameter: core.ParameterSpec, *, required: bool
) -> None:
    option = _option_name(parameter.name)
    if parameter.json_type == "boolean":
        parser.add_argument(
            option,
            dest=parameter.name,
            action=argparse.BooleanOptionalAction,
            default=None,
            help=parameter.description,
        )
        return
    if parameter.json_type == "integer":
        value_type = int
    elif parameter.json_type == "number":
        value_type = float
    elif parameter.json_type in ("array", "object"):
        value_type = _json_argument
    else:
        value_type = str
    parser.add_argument(
        option,
        dest=parameter.name,
        type=value_type,
        default=None,
        required=required,
        help=parameter.description,
    )


def _add_workspace_arguments(parser: argparse.ArgumentParser) -> None:
    """Every workspace location :func:`nous_os.core.resolve_workspace` can take.

    Left ``None`` when absent so ``resolve_workspace`` falls through to its
    own environment-variable resolution unchanged; this function adds no
    workspace-location default of its own.
    """
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--snapshot-root", default=None)
    parser.add_argument("--ledger-path", default=None)
    parser.add_argument("--derived-path", default=None)
    parser.add_argument("--candidate-store-path", default=None)
    parser.add_argument("--bridge-registry-path", default=None)
    parser.add_argument("--rejection-memory-path", default=None)


def _add_grant_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--tier",
        action="append",
        choices=sorted(member.value for member in Tier),
        default=None,
        help="declare one authority tier for this process; repeatable; defaults to read only",
    )
    parser.add_argument(
        "--holder", default=None, help="the grant holder identity this process records"
    )


def _build_parser() -> argparse.ArgumentParser:
    """Build the whole command line, generated from :data:`nous_os.core.CATALOGUE`.

    One subparser per descriptor, named with the descriptor's external name
    exactly, holding one option per declared parameter. Nothing here is a
    hand-written operation list: removing an entry from the catalogue removes
    its subcommand, and adding one adds a subcommand with no further edit.
    """
    parser = argparse.ArgumentParser(prog="nous-os", description="NousOS")
    parser.add_argument("--version", action="version", version=__version__)
    _add_workspace_arguments(parser)
    _add_grant_arguments(parser)
    subparsers = parser.add_subparsers(dest="operation")
    for descriptor in core.CATALOGUE:
        sub = subparsers.add_parser(descriptor.external_name, help=descriptor.summary)
        for parameter in descriptor.parameters:
            # candidate.propose's own parameters are never required at the
            # parser level: --from-artifact is an alternative source for them,
            # and Core's own MissingArgument refusal still fires when neither
            # source supplies a required field.
            required = parameter.required and descriptor.external_name != "candidate.propose"
            _add_parameter_argument(sub, parameter, required=required)
        if descriptor.external_name == "candidate.propose":
            sub.add_argument(
                "--from-artifact",
                dest=_IMPORT_OPTION_DEST,
                default=None,
                help=(
                    "import one or more proposals from a portable proposal artifact file, "
                    "instead of the explicit proposal options above"
                ),
            )
    return parser


def _resolve_tiers(explicit: list[str] | None, environ: Mapping[str, str]) -> frozenset[Tier]:
    if explicit:
        values = explicit
    else:
        from_env = environ.get(TIER_ENV_VAR)
        values = (
            [piece.strip() for piece in from_env.split(",") if piece.strip()]
            if from_env is not None and from_env.strip()
            else None
        )
    if values is None:
        return frozenset({Tier.READ})
    try:
        return frozenset(Tier(value) for value in values)
    except ValueError as error:
        raise CliError(f"unknown tier declared: {error}") from error


def _resolve_holder(explicit: str | None, environ: Mapping[str, str]) -> str:
    if explicit is not None:
        return explicit
    from_env = environ.get(HOLDER_ENV_VAR)
    return from_env if from_env else _DEFAULT_HOLDER


def _resolve_grant(namespace: argparse.Namespace, environ: Mapping[str, str]) -> Grant:
    """Build the one grant this process runs with. Never called per-request.

    Every field this reads comes from process-startup input -- parsed
    arguments and the environment -- never from a subcommand's declared
    parameters. A request cannot widen this grant because nothing about a
    request is consulted to build it.
    """
    tiers = _resolve_tiers(namespace.tier, environ)
    holder = _resolve_holder(namespace.holder, environ)
    return Grant(holder, tiers)


def _resolve_workspace(namespace: argparse.Namespace) -> core.Workspace:
    return core.resolve_workspace(
        data_root=namespace.data_root,
        snapshot_root=namespace.snapshot_root,
        ledger_path=namespace.ledger_path,
        derived_path=namespace.derived_path,
        candidate_store_path=namespace.candidate_store_path,
        bridge_registry_path=namespace.bridge_registry_path,
        rejection_memory_path=namespace.rejection_memory_path,
    )


def _descriptor_for(external_name: str) -> core.OperationDescriptor:
    for descriptor in core.CATALOGUE:
        if descriptor.external_name == external_name:
            return descriptor
    raise core.UnknownExternalOperation(f"no operation is published under {external_name!r}")


def _collect_arguments(
    descriptor: core.OperationDescriptor, namespace: argparse.Namespace
) -> dict[str, object]:
    """Read every declared parameter's value off the parsed namespace.

    A parameter left unset by the caller is omitted from the result rather
    than defaulted here, so an optional parameter's own default -- if it has
    one -- is applied by Core or the domain type it binds to, in exactly one
    place, not duplicated in this transport.
    """
    arguments: dict[str, object] = {}
    for parameter in descriptor.parameters:
        value = getattr(namespace, parameter.name, None)
        if value is not None:
            arguments[parameter.name] = value
    return arguments


def _run_import(grant: Grant, workspace: core.Workspace, artifact_path: str) -> list[dict[str, object]]:
    """Read a portable proposal artifact and call ``candidate.propose`` once per payload.

    An argument-sourcing mode, not a second operation: every call this makes
    is the identical ``core.invoke(grant, "candidate.propose", ...)`` a caller
    supplying the four fields directly would make. Content is unwrapped with
    ``as_data()`` only here, at the one point that must produce the plain
    string :func:`nous_os.core.invoke` requires.
    """
    artifact = load_artifact(Path(artifact_path))
    results: list[dict[str, object]] = []
    for payload in artifact.proposals:
        arguments = {
            "source_id": payload.source_id,
            "content": payload.content.as_data(),
            "proposed_at": payload.proposed_at,
            "holder": payload.holder,
        }
        result = core.invoke(grant, "candidate.propose", workspace, arguments)
        results.append(
            {
                "provenance": {"provider": artifact.provider, "session": artifact.session},
                "result": result,
            }
        )
    return results


def _run(namespace: argparse.Namespace) -> object:
    descriptor = _descriptor_for(namespace.operation)
    workspace = _resolve_workspace(namespace)
    grant = _resolve_grant(namespace, os.environ)

    artifact_path = getattr(namespace, _IMPORT_OPTION_DEST, None)
    if artifact_path is not None:
        arguments = _collect_arguments(descriptor, namespace)
        if arguments:
            raise ConflictingProposalSource(
                "candidate.propose cannot combine --from-artifact with an explicit "
                "proposal field"
            )
        return _run_import(grant, workspace, artifact_path)

    arguments = _collect_arguments(descriptor, namespace)
    return core.invoke(grant, namespace.operation, workspace, arguments)


def main(argv: list[str] | None = None) -> int:
    """Parse one command line and run it, or refuse without ever printing a traceback.

    Every path through this function either writes exactly one JSON value to
    stdout and returns 0, or writes a typed, readable message to stderr and
    returns 1. The ``except Exception`` below is deliberate and total: this is
    the one place a caller-facing message must replace an interpreter
    traceback, and every failure reachable from here -- a refused
    authorization, a malformed argument, an unreadable artifact, an
    unconfigured workspace -- is equally a reason to stop cleanly rather than
    to keep going or to print Python's own stack.
    """
    parser = _build_parser()
    namespace = parser.parse_args(argv)
    if namespace.operation is None:
        parser.print_help()
        return 0
    try:
        result = _run(namespace)
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0
