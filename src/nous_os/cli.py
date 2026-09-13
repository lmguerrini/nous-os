"""The command-line transport. One generated subcommand per current descriptor.

This module reads exactly one thing about the project's governed operations:
:data:`nous_os.core.CATALOGUE`. Every subcommand, every option, and every
declared parameter comes from walking that tuple, never from a hand-written
list living beside it. A future descriptor that collides with a parser
destination is refused during parser construction; otherwise this surface and
the one :mod:`nous_os.core` publishes are generated from the same tuple.

**This module never imports a domain module and never calls
:func:`nous_os.capability.execute`.** Every governed decision is made by
:func:`nous_os.core.invoke`; this module's only job is turning a parsed
command line into the ``(grant, external_name, workspace, arguments)`` tuple
that function requires, and turning its JSON-shaped result back into stdout.

**Authority is declared once, at startup, and nothing in a request can widen
it.** The tier set a process runs with comes from ``--tier`` or the
``NOUS_OS_CLI_TIERS`` environment variable and defaults to
:attr:`~nous_os.capability.Tier.READ` alone. After parsing, the
:class:`~nous_os.capability.Grant` is built once from process-level input and
handed unchanged to the call ``main`` makes; no argument value, subcommand
name, or holder string changes it. The process-level ``--holder`` option and
``candidate.propose``'s declared ``holder`` parameter use distinct namespace
destinations, so an identically-named subcommand option is not read while
building this grant.

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
from nous_os.artifact import ProposalPayload, load_artifact
from nous_os.capability import Grant, Tier

__all__ = (
    "main",
    "CliError",
    "ConflictingProposalSource",
    "ExplicitNullArgument",
    "ArtifactImportPartiallyRecorded",
)


class CliError(Exception):
    """Base error for a request this transport refuses before or instead of calling Core."""


class ConflictingProposalSource(CliError):
    """Raised when ``--from-artifact`` is combined with an explicit proposal field."""


class ExplicitNullArgument(CliError):
    """Raised when a declared parameter is given the literal JSON value ``null``.

    No JSON type this project declares matches ``None``, so a request naming
    ``null`` explicitly is refused by :func:`nous_os.core.invoke` exactly as a
    wrong-typed value would be -- the stdio transport refuses it identically,
    since it never strips a field its caller actually sent. This transport
    used ``None`` as its own sentinel for "the caller supplied nothing", so a
    parsed ``null`` and an omitted option were indistinguishable and the
    first was silently dropped instead of refused; this refuses it instead,
    so both transports refuse the identical request rather than one quietly
    stripping what the other rejects.
    """


class ArtifactImportPartiallyRecorded(CliError):
    """Raised when a write failure during import leaves some payloads recorded.

    Every payload is validated before any of them is written -- see
    :func:`_run_import` -- so this can fire only for a failure that
    pre-validation could not have caught without writing. When it does, every
    proposal already recorded before the failure is named in this message, so
    a partial import is recoverable rather than silent.
    """


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

#: The namespace destination the process-level ``--holder`` option is parsed
#: to. Deliberately not ``"holder"``: ``candidate.propose`` declares its own
#: parameter named ``holder``, and argparse writes every subparser's options
#: into the identical top-level namespace, so two options sharing one dest
#: would let whichever parses last silently decide the grant's holder.
_PROCESS_HOLDER_DEST: Final = "process_holder"

#: The one option ``candidate.propose`` carries that no catalogue descriptor
#: declares: a local file path to import proposals from. It sources
#: arguments for the existing operation; it is not a second operation, and
#: the subcommand name it attaches to is unchanged.
_IMPORT_OPTION_DEST: Final = "from_artifact"
_IMPORT_OPERATION: Final = "candidate.propose"


#: The sentinel a declared parameter's namespace attribute holds when the
#: caller never supplied that option at all. Deliberately not ``None``:
#: ``--question null`` parses, through :func:`_json_argument`, to the Python
#: value ``None`` -- the identical value argparse's own unset default would
#: hold -- so ``None`` cannot serve as both "omitted" and "explicitly null"
#: without conflating them. A private object identity can serve as neither of
#: those two answers by accident.
_UNSET: Final = object()


def _option_name(parameter_name: str) -> str:
    return "--" + parameter_name.replace("_", "-")


def _json_argument(raw: str) -> object:
    """Parse one CLI option's raw text as JSON, for an array- or object-shaped parameter.

    ``json.loads`` recurses once per nesting level, so a value nested deeply
    enough raises ``RecursionError`` rather than ``json.JSONDecodeError``.
    Refusing it the identical way -- through ``argparse.ArgumentTypeError``,
    which ``parse_args`` turns into its own usage message and a clean exit --
    keeps a hostile command-line value from reaching :func:`main`'s own
    ``except Exception`` as an interpreter traceback, matching what
    :func:`nous_os.mcp.serve` refuses the same content-driven way on its
    transport.
    """
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise argparse.ArgumentTypeError(f"not valid JSON: {error}") from error
    except RecursionError as error:
        raise argparse.ArgumentTypeError("JSON value is nested too deeply to parse") from error


def _add_parameter_argument(
    parser: argparse.ArgumentParser, parameter: core.ParameterSpec, *, required: bool
) -> None:
    option = _option_name(parameter.name)
    if parameter.json_type == "boolean":
        parser.add_argument(
            option,
            dest=parameter.name,
            action=argparse.BooleanOptionalAction,
            default=_UNSET,
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
        default=_UNSET,
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
    parser.add_argument("--relation-store-path", default=None)


def _add_grant_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--tier",
        action="append",
        choices=sorted(member.value for member in Tier),
        default=None,
        help="declare one authority tier for this process; repeatable; defaults to read only",
    )
    parser.add_argument(
        "--holder",
        dest=_PROCESS_HOLDER_DEST,
        default=None,
        help="the grant holder identity this process records",
    )


def _parser_destinations(actions: object) -> set[str]:
    """Return parser destinations that a descriptor parameter may not replace."""
    return {
        action.dest
        for action in actions
        if type(action.dest) is str and action.dest != argparse.SUPPRESS
    }


def _assert_parameter_destinations_are_unreserved(
    parser: argparse.ArgumentParser,
    subparser: argparse.ArgumentParser,
    descriptor: core.OperationDescriptor,
) -> None:
    """Refuse a descriptor parameter that would replace an already-parsed value.

    ``argparse`` merges a subparser's attributes into the process namespace.
    Both destination sets are read from the parser actions already built above,
    rather than maintained as a second handwritten catalogue of startup names.
    """
    reserved = _parser_destinations(parser._actions) | _parser_destinations(subparser._actions)
    collisions = sorted(parameter.name for parameter in descriptor.parameters if parameter.name in reserved)
    if collisions:
        raise CliError(
            f"{descriptor.external_name!r} declares reserved startup destination(s): "
            f"{', '.join(collisions)}"
        )


def _build_parser() -> argparse.ArgumentParser:
    """Build the whole command line, generated from :data:`nous_os.core.CATALOGUE`.

    Each descriptor that does not collide with a parser destination gets one
    subparser named with its external name exactly and one option per declared
    parameter. Nothing here is a hand-written operation list: removing an
    entry from the catalogue removes its subcommand, and adding a
    non-colliding entry adds one with no further edit. A descriptor naming a
    reserved destination, including ``help``, is refused instead.

    ``allow_abbrev=False`` on the parent parser and every generated subparser:
    argparse's default long-option abbreviation resolves an unambiguous
    prefix to whichever declared option it is a prefix of, and that
    resolution runs before :func:`_assert_parameter_destinations_are_unreserved`
    ever gets a chance to compare destination names -- a descriptor parameter
    named ``ti``, for instance, is not itself a reserved destination, but
    ``--ti`` typed on the command line would abbreviate to the process-level
    ``--tier`` and be read as that instead. Disabling abbreviation removes the
    resolution the guard cannot see, rather than trying to make the guard
    predict it.
    """
    parser = argparse.ArgumentParser(prog="nous-os", description="NousOS", allow_abbrev=False)
    parser.add_argument("--version", action="version", version=__version__)
    _add_workspace_arguments(parser)
    _add_grant_arguments(parser)
    subparsers = parser.add_subparsers(dest="operation")
    for descriptor in core.CATALOGUE:
        sub = subparsers.add_parser(
            descriptor.external_name, help=descriptor.summary, allow_abbrev=False
        )
        if descriptor.external_name == _IMPORT_OPERATION:
            sub.add_argument(
                "--from-artifact",
                dest=_IMPORT_OPTION_DEST,
                default=None,
                help=(
                    "import one or more proposals from a portable proposal artifact file, "
                    "instead of the explicit proposal options above"
                ),
            )
        _assert_parameter_destinations_are_unreserved(parser, sub, descriptor)
        for parameter in descriptor.parameters:
            # candidate.propose's own parameters are never required at the
            # parser level: --from-artifact is an alternative source for them,
            # and Core's own MissingArgument refusal still fires when neither
            # source supplies a required field.
            required = parameter.required and descriptor.external_name != _IMPORT_OPERATION
            _add_parameter_argument(sub, parameter, required=required)
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
    request is consulted to build it: ``namespace.process_holder`` is the
    process-level ``--holder`` option's own destination, distinct from
    ``candidate.propose``'s declared ``holder`` parameter, so a subcommand's
    value is never read here even when both were spelled identically on the
    command line.
    """
    tiers = _resolve_tiers(namespace.tier, environ)
    holder = _resolve_holder(getattr(namespace, _PROCESS_HOLDER_DEST), environ)
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
        relation_store_path=namespace.relation_store_path,
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
    place, not duplicated in this transport. Unset is :data:`_UNSET`, not
    ``None``: a caller who explicitly named the JSON literal ``null`` for an
    array- or object-shaped parameter gets a value that parses to ``None``,
    and that is a real, refused request, not an omission to silently drop.
    """
    arguments: dict[str, object] = {}
    for parameter in descriptor.parameters:
        value = getattr(namespace, parameter.name, _UNSET)
        if value is _UNSET:
            continue
        if value is None:
            raise ExplicitNullArgument(
                f"{descriptor.external_name} was given an explicit null for "
                f"{parameter.name!r}; NousOS refuses this rather than treating "
                "it as omitted"
            )
        arguments[parameter.name] = value
    return arguments


def _proposal_arguments(payload: ProposalPayload) -> dict[str, object]:
    return {
        "source_id": payload.source_id,
        "content": payload.content.as_data(),
        "proposed_at": payload.proposed_at,
        "holder": payload.holder,
    }


def _run_import(grant: Grant, workspace: core.Workspace, artifact_path: str) -> list[dict[str, object]]:
    """Read a portable proposal artifact and call ``candidate.propose`` once per payload.

    An argument-sourcing mode, not a second operation: every write this makes
    is the identical ``core.invoke(grant, "candidate.propose", ...)`` a caller
    supplying the four fields directly would make. Content is unwrapped with
    ``as_data()`` only here, at the one point that must produce the plain
    string :func:`nous_os.core.invoke` requires.

    Every payload is validated with :func:`nous_os.core.validate_arguments`
    -- the identical shape and domain-type checks a real call performs --
    before any write. A payload malformed in one of those checks (an
    unparsable ``proposed_at``, for instance) therefore cannot leave an
    earlier payload durably recorded while a later one fails. Validation
    cannot reach a check performed only inside the write itself, such as the
    identifier format ``CandidateStore`` enforces when it constructs a record;
    reaching that would require candidate-store dry-run support, which is out
    of scope here. If a write still fails after every payload passed
    validation, this names the proposals already recorded rather than raising
    silently, so a partial import is recoverable.
    """
    artifact = load_artifact(Path(artifact_path))
    proposals = [_proposal_arguments(payload) for payload in artifact.proposals]

    for arguments in proposals:
        core.validate_arguments("candidate.propose", workspace, arguments)

    results: list[dict[str, object]] = []
    landed: list[object] = []
    for arguments in proposals:
        try:
            result = core.invoke(grant, "candidate.propose", workspace, arguments)
        except Exception as error:
            if landed:
                raise ArtifactImportPartiallyRecorded(
                    f"{type(error).__name__}: {error}; already recorded before this "
                    f"failure ({len(landed)} of {len(proposals)}): {landed!r}"
                ) from error
            raise
        results.append(
            {
                "provenance": {"provider": artifact.provider, "session": artifact.session},
                "result": result,
            }
        )
        landed.append(result)
    return results


def _run(namespace: argparse.Namespace) -> object:
    descriptor = _descriptor_for(namespace.operation)
    artifact_path = getattr(namespace, _IMPORT_OPTION_DEST, None)
    if artifact_path is not None and descriptor.external_name != _IMPORT_OPERATION:
        raise CliError("--from-artifact is only valid for candidate.propose")
    workspace = _resolve_workspace(namespace)
    grant = _resolve_grant(namespace, os.environ)

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

    This never prints a raw interpreter traceback. Once
    ``parser.parse_args`` has returned a namespace with a subcommand, every
    path through this function either writes exactly one JSON value to stdout
    and returns 0, or writes a typed, readable message to stderr and returns
    1: the ``except Exception`` below is deliberate and total, and every
    failure reachable from there -- a refused authorization, a malformed
    argument, an unreadable artifact, an unconfigured workspace -- is equally
    a reason to stop cleanly rather than to keep going or to print Python's
    own stack. A parsed namespace without a subcommand is a third case: it
    writes argparse's usage text to stdout and returns 0.

    Parsing itself is deliberately left outside that contract, not folded
    into it: ``parse_args`` runs before the ``try`` below and keeps
    argparse's own convention for a request this transport never gets to
    see as a value -- an unrecognized option, ``--help``, or ``--version``
    -- and raises ``SystemExit`` with argparse's own code: 0 after usage for
    ``--help``, 0 after the version string for ``--version``, and 2 for a
    parsing error. None belongs to the subcommand or no-subcommand cases
    above. That is a deliberate, narrower claim, not the omission
    it once was: replacing argparse's own well-understood parsing-error
    convention was never asked for, and :func:`_json_argument` above already
    keeps a value a ``type=`` callable would otherwise choke on -- JSON
    nested far enough to raise ``RecursionError`` rather than a decode error
    -- inside that same argparse convention instead of letting it surface as
    a traceback here.
    """
    parser = _build_parser()
    namespace = parser.parse_args(argv)
    if namespace.operation is None:
        parser.print_help()
        return 0
    try:
        result = _run(namespace)
        encoded = json.dumps(result, sort_keys=True, allow_nan=False)
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(encoded)
    return 0
