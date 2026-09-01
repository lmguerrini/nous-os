"""The stdio JSON-RPC transport. Standard library only, no third-party package.

This module speaks a JSON-RPC 2.0 message set shaped like the Model Context
Protocol's ``initialize`` / ``tools/list`` / ``tools/call`` trio: one
newline-delimited JSON message per line on stdin, one newline-delimited JSON
message per line on stdout. It does not claim full protocol conformance
beyond that shape -- what it claims, and what its tests hold it to, is the
same set of governed-decision properties :mod:`nous_os.cli` holds.

Every tool this publishes, and the JSON Schema each one declares, is built by
walking :data:`nous_os.core.CATALOGUE`, exactly as :mod:`nous_os.cli` builds
its subcommands from the same tuple. **This module never imports a domain
module and never calls :func:`nous_os.capability.execute`.** Every governed
decision is made by :func:`nous_os.core.invoke`; this module's only job is
turning one JSON-RPC request into that call's arguments and turning the
result back into a JSON-RPC response.

**Authority is declared once, at process startup, and nothing arriving over
stdin can widen it.** The tier set comes from ``--tier`` or the
``NOUS_OS_STDIO_TIERS`` environment variable, read before the first message is
read, and defaults to :attr:`~nous_os.capability.Tier.READ` alone. No tool
name, no argument value, no ``initialize`` client identity, and no session
changes it: the :class:`~nous_os.capability.Grant` built at startup is passed
unchanged to every ``tools/call`` this process ever serves.

**Once serving begins, nothing but a JSON-RPC message is ever written to
stdout.** Every other message :func:`serve` has to produce -- there is
exactly one, a start-up refusal -- is written to stderr. A stray ``print``
anywhere in this module's own source would corrupt the one stream a client
reads as protocol; that is what the static guard in this project's tests
checks, and only that: it inspects bare ``print(`` calls in this module's
source, not every way a process can put a byte on stdout. It is deliberately
narrower than "stdout carries only JSON-RPC" as a blanket claim about this
whole module: reaching this module through ``python3 -m nous_os.mcp --help``
or ``--version`` never reaches :func:`serve` at all, and prints argparse's own
usage text to stdout on argparse's own well-understood convention, before a
grant or a workspace has even been resolved. That is standard, expected
behaviour for a command-line tool's own help output, not a leak of protocol
framing, and this module does not attempt to suppress it.

This module never imports :mod:`nous_os.cli`, in either direction.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping
from typing import Final, TextIO

from nous_os import __version__
from nous_os import core
from nous_os.capability import Grant, Tier

__all__ = ("main", "serve")

#: The identifier this server reports for `initialize`. Not a claim of exact
#: conformance to any one protocol revision -- see the module docstring --
#: only a version string a client asking "what protocol shape is this" can
#: read.
_PROTOCOL_VERSION: Final = "2024-11-05"

_PARSE_ERROR: Final = -32700
_INVALID_REQUEST: Final = -32600
_METHOD_NOT_FOUND: Final = -32601
_INVALID_PARAMS: Final = -32602
_SERVER_ERROR: Final = -32000

TIER_ENV_VAR: Final = "NOUS_OS_STDIO_TIERS"
HOLDER_ENV_VAR: Final = "NOUS_OS_STDIO_HOLDER"
_DEFAULT_HOLDER: Final = "stdio"


class _RequestError(Exception):
    """One JSON-RPC error, carrying the code the response must report."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- tool list, generated from the catalogue ----------------------------------


def _parameter_schema(parameter: core.ParameterSpec) -> dict[str, object]:
    return {"type": parameter.json_type, "description": parameter.description}


def _input_schema(descriptor: core.OperationDescriptor) -> dict[str, object]:
    return {
        "type": "object",
        "properties": {
            parameter.name: _parameter_schema(parameter) for parameter in descriptor.parameters
        },
        "required": sorted(
            parameter.name for parameter in descriptor.parameters if parameter.required
        ),
    }


def _tool_descriptor(descriptor: core.OperationDescriptor) -> dict[str, object]:
    return {
        "name": descriptor.external_name,
        "description": descriptor.summary,
        "inputSchema": _input_schema(descriptor),
    }


def tools_list() -> tuple[str, ...]:
    """The tool names this server publishes, in catalogue order. For tests and callers alike."""
    return tuple(descriptor.external_name for descriptor in core.CATALOGUE)


# --- method handlers -----------------------------------------------------------


def _handle_initialize(params: object) -> dict[str, object]:
    return {
        "protocolVersion": _PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "nous-os", "version": __version__},
    }


def _handle_tools_list(params: object) -> dict[str, object]:
    return {"tools": [_tool_descriptor(descriptor) for descriptor in core.CATALOGUE]}


def _handle_tools_call(params: object, grant: Grant, workspace: core.Workspace) -> dict[str, object]:
    if type(params) is not dict:
        raise _RequestError(_INVALID_PARAMS, "params must be an object")
    name = params.get("name")
    if type(name) is not str:
        raise _RequestError(_INVALID_PARAMS, "params.name must be a string")
    arguments = params.get("arguments", {})
    if type(arguments) is not dict:
        raise _RequestError(_INVALID_PARAMS, "params.arguments must be an object")
    try:
        result = core.invoke(grant, name, workspace, arguments)
    except Exception as error:
        raise _RequestError(_SERVER_ERROR, f"{type(error).__name__}: {error}") from error
    return {"content": [{"type": "text", "text": json.dumps(result, sort_keys=True)}]}


_METHODS: Final = {
    "initialize": _handle_initialize,
    "tools/list": _handle_tools_list,
}


# --- one request in, one response out -------------------------------------------


def _error_response(request_id: object, code: int, message: str) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _result_response(request_id: object, result: object) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def dispatch(message: object, grant: Grant, workspace: core.Workspace) -> dict[str, object] | None:
    """Handle one already-decoded JSON-RPC request. ``None`` means: send nothing back.

    A message with no ``id`` is a notification under JSON-RPC 2.0 and gets no
    response, even when it fails -- exactly as a malformed or unrecognized
    request with an ``id`` always gets a JSON-RPC error object, never a raised
    exception and never a partial write.
    """
    if type(message) is not dict:
        return _error_response(None, _INVALID_REQUEST, "a request must be a JSON object")
    is_notification = "id" not in message
    request_id = message.get("id")
    if message.get("jsonrpc") != "2.0":
        return None if is_notification else _error_response(
            request_id, _INVALID_REQUEST, 'jsonrpc must be "2.0"'
        )
    method = message.get("method")
    if type(method) is not str:
        return None if is_notification else _error_response(
            request_id, _INVALID_REQUEST, "method must be a string"
        )
    params = message.get("params", {})
    try:
        if method == "tools/call":
            result = _handle_tools_call(params, grant, workspace)
        elif method in _METHODS:
            result = _METHODS[method](params)
        else:
            raise _RequestError(_METHOD_NOT_FOUND, f"unknown method: {method!r}")
    except _RequestError as error:
        return None if is_notification else _error_response(request_id, error.code, str(error))
    except Exception as error:
        return None if is_notification else _error_response(
            request_id, _SERVER_ERROR, f"{type(error).__name__}: {error}"
        )
    if is_notification:
        return None
    return _result_response(request_id, result)


def serve(
    grant: Grant,
    workspace: core.Workspace,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
) -> None:
    """Read one JSON-RPC message per line from ``stdin`` until it closes.

    ``grant`` and ``workspace`` are fixed for the whole call: every
    ``tools/call`` this loop serves reuses the identical authority and the
    identical resolved locations, because per-request re-resolution is
    exactly the widening path this transport must not offer.

    Decoding one line also catches ``RecursionError``, not only
    ``json.JSONDecodeError``: a JSON array nested deeply enough makes
    ``json.loads`` itself exhaust the interpreter's recursion limit before it
    ever raises a decode error. That happens right here, in this loop, before
    a message ever exists to hand to ``dispatch``, so ``dispatch``'s own
    ``except Exception`` is never in a position to help -- there is nothing
    for it to be called with. Refusing it as the identical kind of parse
    failure a malformed line already is keeps one hostile line from
    terminating the process outright, which would otherwise be content-driven
    denial of service against the one long-lived transport this project
    ships.
    """
    for line in stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            message = json.loads(stripped)
        except (json.JSONDecodeError, RecursionError) as error:
            response: dict[str, object] | None = _error_response(
                None, _PARSE_ERROR, f"invalid JSON: {error}"
            )
        else:
            response = dispatch(message, grant, workspace)
        if response is not None:
            stdout.write(json.dumps(response, sort_keys=True))
            stdout.write("\n")
            stdout.flush()


# --- process startup: where this transport's authority is declared -------------


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
    return frozenset(Tier(value) for value in values)


def _resolve_holder(explicit: str | None, environ: Mapping[str, str]) -> str:
    if explicit is not None:
        return explicit
    from_env = environ.get(HOLDER_ENV_VAR)
    return from_env if from_env else _DEFAULT_HOLDER


def _resolve_grant(namespace: argparse.Namespace, environ: Mapping[str, str]) -> Grant:
    return Grant(_resolve_holder(namespace.holder, environ), _resolve_tiers(namespace.tier, environ))


def _build_start_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nous-os-stdio", description="NousOS stdio JSON-RPC transport"
    )
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--snapshot-root", default=None)
    parser.add_argument("--ledger-path", default=None)
    parser.add_argument("--derived-path", default=None)
    parser.add_argument("--candidate-store-path", default=None)
    parser.add_argument("--bridge-registry-path", default=None)
    parser.add_argument("--rejection-memory-path", default=None)
    parser.add_argument(
        "--tier",
        action="append",
        choices=sorted(member.value for member in Tier),
        default=None,
        help="declare one authority tier for this process; repeatable; defaults to read only",
    )
    parser.add_argument("--holder", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Resolve this process's one grant and workspace, then serve stdin until it closes.

    Everything that can go wrong before the first message is read -- an
    unconfigured workspace, an unknown declared tier -- is refused here, on
    stderr, with a non-zero exit and no traceback, for the identical reason
    :func:`nous_os.cli.main` refuses the same way.
    """
    parser = _build_start_parser()
    namespace = parser.parse_args(argv)
    try:
        workspace = core.resolve_workspace(
            data_root=namespace.data_root,
            snapshot_root=namespace.snapshot_root,
            ledger_path=namespace.ledger_path,
            derived_path=namespace.derived_path,
            candidate_store_path=namespace.candidate_store_path,
            bridge_registry_path=namespace.bridge_registry_path,
            rejection_memory_path=namespace.rejection_memory_path,
        )
        grant = _resolve_grant(namespace, os.environ)
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    serve(grant, workspace)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
