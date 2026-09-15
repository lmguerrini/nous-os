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
stdout.** The one bare ``print`` call in this module is the pre-serving
startup-refusal path, and it writes to stderr. The static guard checks only
that narrow source fact -- bare ``print(`` calls in this module point to
stderr -- rather than every mechanism that could put a byte on stdout. The
claim deliberately excludes ``python3 -m nous_os.mcp --help``: argparse
writes that pre-serving usage text to stdout before a grant or workspace is
resolved. This parser has no ``--version`` option; argparse refuses that
unrecognized option on its usual parsing-error path.

This module never imports :mod:`nous_os.cli`, in either direction.
"""

from __future__ import annotations

import argparse
import json
import math
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


#: ``initialize`` and ``tools/list`` publish the identical catalogue content
#: ``tools/call``'s own ``system.capabilities`` renders, but neither runs a
#: tier check first: they are MCP's own handshake methods, not entries in
#: :data:`nous_os.core.CATALOGUE`, so there is no descriptor tier here to
#: check against the grant. This is not a security defect -- the catalogue is
#: public content, symmetric with what ``--help`` already prints with no
#: authority check of its own -- but a grant lacking READ still gets the
#: catalogue through these two methods while ``system.capabilities`` refuses
#: it, and a reader comparing the two paths should recognise the asymmetry
#: rather than mistake it for an oversight.
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
    return {
        "content": [{"type": "text", "text": json.dumps(result, sort_keys=True, allow_nan=False)}]
    }


_METHODS: Final = {
    "initialize": _handle_initialize,
    "tools/list": _handle_tools_list,
}


# --- one request in, one response out -------------------------------------------


def _refuse_nonstandard_constant(constant: str) -> None:
    """``json.loads``'s ``parse_constant`` hook: refuse ``Infinity``/``-Infinity``/``NaN``.

    These three bare tokens are a non-standard extension ``json.loads``
    accepts by default; a strict JSON-RPC client cannot send them. Refusing
    the whole message here, rather than accepting one of them as a value, is
    what lets :func:`serve`'s own ``allow_nan=False`` encode keep its promise
    that a client-supplied value is never echoed back as one of these tokens.
    """
    raise ValueError(f"{constant} is not a valid strict JSON value")


def _refuse_nonfinite_float(number: str) -> float:
    """Decode one JSON floating-point token only when it has a finite value."""
    value = float(number)
    if not math.isfinite(value):
        raise ValueError(f"{number} is not a finite JSON number")
    return value


def _decode_integer(number: str) -> int:
    """Decode one JSON integer token through an explicit strict-decoding hook."""
    return int(number)


def _encodable_response_id(request_id: object) -> object | None:
    """Return an id safe to echo in strict JSON, or ``null`` when it is not."""
    try:
        json.dumps(request_id, allow_nan=False)
    except (TypeError, ValueError):
        return None
    return request_id


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
    request_id = _encodable_response_id(message.get("id"))
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

    ``json.loads`` accepts the bare tokens ``Infinity``, ``-Infinity``, and
    ``NaN`` as a non-standard extension, and its normal floating-point parser
    also turns an exponent outside its finite range into an infinity. Either
    would otherwise let an echoed request id corrupt a response line. The
    three decoding hooks below refuse both forms before dispatch, and the
    strict encoder plus response-id sanitiser cover a value that reaches this
    far some other way.
    """
    for line in stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            message = json.loads(
                stripped,
                parse_constant=_refuse_nonstandard_constant,
                parse_float=_refuse_nonfinite_float,
                parse_int=_decode_integer,
            )
        except (ValueError, RecursionError) as error:
            response: dict[str, object] | None = _error_response(
                None, _PARSE_ERROR, f"invalid JSON: {error}"
            )
        else:
            response = dispatch(message, grant, workspace)
        if response is not None:
            try:
                encoded = json.dumps(response, sort_keys=True, allow_nan=False)
            except ValueError as error:
                # Belt-and-braces: nothing a client can send should reach this,
                # since ``parse_constant`` above already refuses a non-standard
                # constant on the way in. A domain value that is itself not
                # strict-JSON-representable would otherwise raise unhandled
                # here and end the whole session over one response.
                encoded = json.dumps(
                    _error_response(
                        _encodable_response_id(response.get("id")),
                        _SERVER_ERROR,
                        f"result is not representable as strict JSON: {error}",
                    ),
                    sort_keys=True,
                    allow_nan=False,
                )
            stdout.write(encoded)
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
    parser.add_argument("--relation-store-path", default=None)
    parser.add_argument("--extraction-store-path", default=None)
    parser.add_argument("--semantic-index-path", default=None)
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

    Resolution failures after argument parsing -- an unconfigured workspace
    or an unknown declared tier -- are refused here on stderr with a non-zero
    exit and no traceback. Parsing failures remain argparse's own behavior,
    as in :func:`nous_os.cli.main`.
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
            relation_store_path=namespace.relation_store_path,
            extraction_store_path=namespace.extraction_store_path,
            semantic_index_path=namespace.semantic_index_path,
        )
        grant = _resolve_grant(namespace, os.environ)
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    serve(grant, workspace)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
