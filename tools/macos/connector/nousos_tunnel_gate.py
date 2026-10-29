#!/usr/bin/env python3
"""NousOS ChatGPT tunnel exposure gate."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

PROFILE_ID = "chatgpt-read-min-v3"
MAX_RESPONSE_BYTES = 400_000
MAX_REQUEST_BYTES = 262_144
MAX_SPAN_BYTES = 32_768
DEFAULT_LOG_DIR = Path.home() / "Library" / "Logs" / "nousos-tunnel"

READ_TOOLS = (
    "knowledge.search",
    "knowledge.semantic",
    "knowledge.context",
    "provenance.span",
    "provenance.verify_derived",
    "canon.assertions",
    "candidate.search",
    "reconcile.relations",
)
PRODUCT_TO_ALIAS = {name: name.replace(".", "_") for name in READ_TOOLS}
ALIAS_TO_PRODUCT = {alias: product for product, alias in PRODUCT_TO_ALIAS.items()}
PUBLISHED_ALIASES = tuple(PRODUCT_TO_ALIAS[name] for name in READ_TOOLS)

CHATGPT_TOOL_DESCRIPTIONS = {
    "knowledge.search": (
        "Returns original historical conversation and attachment text, not proposals or "
        "decisions. Use for exact words, names, and dates; pair with candidate_search for "
        "questions about decisions or how ideas evolved. Leave limit unset (10) or use at least 5 "
        "for questions about decisions, evolution or connections. If results are insufficient, "
        "reformulate with distinctive keywords and search again rather than concluding nothing "
        "exists. Optionally filter "
        "with role user when asking what the person said, or role assistant for what an assistant "
        "answered; omit role otherwise. A user message was sent by the person but may contain pasted "
        "or quoted text written by others; check context before attributing it as their own view. "
        "Search results may be normalized excerpts that may be cut. "
        "Do not quote them as exact. For exact bytes, call provenance_span with a returned citation, "
        "or knowledge_context with view full and the hit's source_id."
    ),
    "knowledge.semantic": (
        "Returns original historical conversation and attachment text found by meaning, not "
        "proposals or decisions. Use for a meaning-based search or paraphrase; pair with "
        "candidate_search for questions about decisions or how ideas evolved. Leave limit unset "
        "(10) or use at least 5 for questions about decisions, evolution or connections. If "
        "results are insufficient, reformulate with distinctive keywords and search again "
        "rather than concluding nothing exists. Optionally "
        "filter with role user when asking what the person said, or role assistant for what an "
        "assistant answered; omit role otherwise. A user message was sent by the person but may "
        "contain pasted or quoted text written by others; check context before attributing it as "
        "their own view. Semantic results are verbatim but possibly partial "
        "passages. Do not quote them as exact. For exact bytes, call provenance_span with a returned "
        "citation, or knowledge_context with view full and the hit's source_id."
    ),
    "knowledge.context": (
        "Returns surrounding original conversation messages, not proposals or decisions. Use to"
        " read context around a source passage; pair with candidate_search for questions about "
        "decisions or how ideas evolved. Compact text view is the default; use view full for the "
        "exact stored body. Check text_truncated; if true, use view full. Citations always refer "
        "to source bytes. A conversation (container) is returned in pages of at most 30 records "
        "with total, has_more and next_offset; request another page with offset only when needed "
        "for the question, never read a whole conversation automatically. Records beyond page one "
        "are not missing memory: they are already reachable through search and source_id context."
    ),
    "provenance.span": (
        "Returns the exact cited bytes from original source text, not a proposal or decision. "
        "Use to verify a candidate_search citation before describing what the sources say."
    ),
    "provenance.verify_derived": (
        "Checks one derived_citations entry from candidate_search against the preserved "
        "attachment extraction only. A match means the quoted span matches the preserved "
        "extraction, not that it was verified on the original attachment; quote the result as such."
    ),
    "canon.assertions": (
        "Returns approved canonical decisions, not historical source text or unapproved "
        "proposals. Use when asking what is an approved decision; use source search for its "
        "original wording and context."
    ),
    "candidate.search": (
        "Returns cited recorded proposals distilled from sources and approved decisions marked "
        "canonical. Proposals are not verified facts or approved decisions. Use for what was "
        "decided, proposed, preferred, or concluded, how ideas evolved, and how topics or "
        "conversations connect. For long natural questions, prefer distinctive keywords or names "
        "with the default text ranking; source_semantic is an option for paraphrases and "
        "wording that differs from the proposals, and text_relevance for plain keyword ranking "
        "of names and "
        "keywords. Run alongside source search, not instead of it. Quote "
        "epistemic_label and canonical_status; a label such as DECISION_STATED_BY_PERSON means "
        "a person stated it in a conversation, not that it was approved. Before stating "
        "proposal content as what the sources say, check citations with provenance_span or read"
        " around them with knowledge_context. Every non-canonical result is a recorded "
        "proposal, not a decision. Use include_replaced true only for questions about how a proposal or "
        "decision evolved; replaced hits carry replaced true and superseded_by (the next version); "
        "present them as superseded, not current, with their available dates. A replacement means a "
        "proposal version was superseded in review and does not by itself mean the person changed the "
        "decision. If candidate_search reports replaced_excluded > 0, mention that one or "
        "more matching replaced candidates were excluded. replaced_unreadable is a store-wide count "
        "of old replaced versions that failed validation, not a result of this query; it does not "
        "hide current proposals."
    ),
    "reconcile.relations": (
        "Returns recorded relations between two cited source passages for one source_id. "
        "Each relation carries relation_class, origin, bases, producer, notes, proposed_at, "
        "and the cited spans of both ends. These are recorded links whose ends and citations "
        "resolve to the sources, not approved decisions and not verified facts. A related "
        "relation with origin model is a model's reading that two passages bear on each "
        "other. Exploratory interpretations are not included. For questions about connections, "
        "change over time or two conversations, call it on the one or two retrieved sources that "
        "best answer the question, not every hit. Use it to find passages linked "
        "to one found by search, in the same conversation or another; read both ends with "
        "knowledge_context or provenance_span before describing the link; quote "
        "relation_class and origin."
    ),
}

CHATGPT_SERVER_INSTRUCTIONS = (
        "Distinguish four kinds: original sources are historical conversation/attachment "
        "text, not decisions; recorded proposals are distilled statements with citations, "
        "not verified facts or approved decisions; approved decisions are canon_assertions "
        "and candidate_search hits marked canonical; recorded relations link "
    "two cited passages; they are not facts or decisions. For decision or evolution questions, "
        "use source search alongside candidate_search. For connection questions, "
        "use reconcile_relations with a search hit source_id. Verify proposal citations with "
        "provenance_span or read around them with knowledge_context. Say which kind each "
        "statement comes from. Optionally filter with role user when "
    "asking what the person said, or role assistant for what an assistant answered; omit role "
        "otherwise. Prefer keywords; source_semantic suits paraphrases. If results are insufficient, "
        "reformulate and widen; for connection or evolution questions, check relations "
        "of the most relevant retrieved sources. Keep answers and call counts proportionate. "
        "Never present proposals as verified "
    "facts. When materially conflicting results have dates, report the disagreement and order the "
    "available dates, "
    "distinguishing proposed_at (candidate proposal time), valid_from (candidate-stated validity "
    "start; may be null) and created_at (source-record timestamp; may be null). If candidate_search "
    "reports replaced_excluded > 0, mention that one or more matching replaced candidates were excluded."
)


CAPS: dict[str, dict[str, int]] = {
    "knowledge.search": {"limit": 20},
    "knowledge.semantic": {"limit": 10},
    "knowledge.context": {"before": 5, "after": 5, "limit": 30, "max_chars": 8000},
    "candidate.search": {"limit": 10},
}

# Product defaults the gate does not fill itself.
PRODUCT_DEFAULT_LIMITS = {"knowledge.search": 10}
LIMIT_NOTES = {
    "search_full": (
        "This call returned its applied maximum of hits, so more matches may exist. There is no next "
        "page: use more distinctive words or a role filter, or read around a hit with "
        "knowledge_context."
    ),
    "raise_limit": "A higher limit, up to the maximum, returns more hits in one call.",
    "cursor": (
        "More matching proposals exist: call candidate_search again with the same arguments and "
        "cursor set to next_cursor."
    ),
    "window": (
        "before and after are capped here; to read further, call knowledge_context again on the "
        "first or last returned record's source_id, or page the container with offset."
    ),
    "max_chars": (
        "Text per record is capped here; use view full for the exact stored body."
    ),
    "page": (
        "Container pages hold at most 30 records; request offset=next_offset only if the question "
        "needs it."
    ),
}
GATE_LIMITS_NOTE = (
    " A separate gate_limits item, when present, reports limits this connector applied and how to "
    "continue."
)

for _name in CAPS:
    CHATGPT_TOOL_DESCRIPTIONS[_name] += GATE_LIMITS_NOTE

DERIVED_ERROR_MESSAGES = {
    "DerivedRecordNotFound": "The preserved extraction record was not found.",
    "DerivedRecordCorrupt": "The preserved extraction record could not be authenticated.",
    "DerivedVersionMismatch": "The citation does not match the preserved extractor version.",
    "DerivedOwnerMismatch": "The citation does not match an owner of the preserved extraction.",
    "DerivedAssetMismatch": "The citation does not match the preserved asset metadata.",
    "DerivedLedgerUnreadable": "The preserved asset history could not be checked.",
    "SpanMismatch": "The quoted span does not match the preserved extraction.",
    "LocatorOutOfRange": "The citation locator is outside the preserved extraction.",
    "LocatorSplitsGrapheme": "The citation locator splits a character in the preserved extraction.",
}

# Caller-input refusals the product reports as "<Class>: <message>" on a JSON-RPC
# -32000 error. Only these exact (tool, error text) pairs, taken from the product's
# raise sites, become a tool result with isError; every other error keeps its
# existing JSON-RPC form, including "QueryError: the query could not be run: ...",
# which can also report a storage fault.
INPUT_ERRORS: dict[str, dict[str, tuple[str, str]]] = {
    "knowledge.search": {
        "QueryError: the query has no searchable words": (
            "QueryError", "the query has no searchable words; use letters or digits"),
    },
    "knowledge.context": {
        f"QueryError: {message}": ("QueryError", message)
        for message in (
            "before must be a non-negative integer",
            "after must be a non-negative integer",
            "limit must be a positive integer",
            "context requires exactly one of source_id or container",
            "offset is only valid with container",
            "offset must be a non-negative integer",
            "view must be 'full' or 'text'",
            "max_chars is only valid with view='text'",
            "max_chars must be an integer from 200 to 20000",
        )
    },
    "candidate.search": {
        "CandidateSearchError: InvalidQuery": (
            "InvalidQuery",
            "the query has no searchable words or is not valid; use plain words or balanced "
            "double-quoted phrases"),
        "CandidateSearchError: InvalidCursor": (
            "InvalidCursor",
            "the cursor is not valid for this request; repeat the search without cursor"),
        "CandidateSearchError: QueryTooComplex": (
            "QueryTooComplex",
            "the query is too long (over 256 characters) or has more than 16 quoted phrases; "
            "shorten it"),
    },
}

READ_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
}

SAFE_ECHO = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
LOG_METHODS = {
    "initialize",
    "tools/list",
    "tools/call",
    "ping",
    "notifications/initialized",
    "notifications/cancelled",
}
LOG_ARGUMENTS = {
    "query",
    "limit",
    "distinct",
    "source_id",
    "container",
    "before",
    "after",
    "citation",
    "full",
    "assertion_id",
    "content",
    "proposed_at",
    "holder",
    "cursor",
    "include_replaced",
    "ranking",
    "role",
    "view",
    "max_chars",
    "relation_class",
}


def reject_constant(value: str) -> None:
    raise ValueError("non-finite number: " + value)


def finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite float")
    return number


def strict_loads(raw: bytes) -> Any:
    return json.loads(
        raw.decode("utf-8"),
        parse_constant=reject_constant,
        parse_float=finite_float,
    )


def wire(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def id_key(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def valid_id(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return len(value) <= 128
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and abs(value) < 2**53
    )


def safe_echo(value: str) -> str:
    return value if SAFE_ECHO.fullmatch(value) else "<name withheld>"


class MetadataLog:
    def __init__(self) -> None:
        self.directory = Path(os.environ.get("NOUSOS_TUNNEL_LOG_DIR", DEFAULT_LOG_DIR))
        candidate = os.environ.get("NOUSOS_TUNNEL_SESSION", "")
        self.session = candidate if SAFE_ECHO.fullmatch(candidate) else None
        self.lock = threading.Lock()

    def _path(self) -> Path:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        suffix = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
        path = self.directory / f"gate-{suffix}.ndjson"
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        return path

    @staticmethod
    def _id_hash(value: Any) -> str | None:
        if value is None:
            return None
        try:
            canonical = id_key(value).encode("utf-8")
            return hashlib.sha256(canonical).hexdigest()[:12]
        except Exception:
            return None

    @staticmethod
    def _argument_names(value: Any) -> tuple[list[str], int]:
        if not isinstance(value, (list, tuple)):
            return [], 0
        allowed = sorted(
            item for item in value if isinstance(item, str) and item in LOG_ARGUMENTS
        )
        other_count = len(value) - len(allowed)
        return allowed, other_count

    def write(self, **fields: Any) -> None:
        arg_keys, other_arg_keys = self._argument_names(fields.get("arg_keys", []))
        method = fields.get("method")
        tool = fields.get("tool")
        record = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "profile": PROFILE_ID,
            "session": self.session,
            "event": fields.get("event"),
            "id_hash": self._id_hash(fields.get("id")),
            "method": method if isinstance(method, str) and method in LOG_METHODS else "other",
            "tool": tool if isinstance(tool, str) and tool in PRODUCT_TO_ALIAS else None,
            "decision": fields.get("decision"),
            "arg_keys": arg_keys,
            "other_arg_keys": other_arg_keys,
            "arg_bytes": fields.get("arg_bytes", 0),
            "resp_bytes": fields.get("resp_bytes", 0),
            "error_code": fields.get("error_code"),
            "duration_ms": fields.get("duration_ms"),
        }
        digest = fields.get("resp_digest")
        if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{16}", digest):
            record["resp_digest"] = digest
        try:
            line = wire(record) + b"\n"
            with self.lock:
                with self._path().open("ab") as handle:
                    handle.write(line)
        except Exception:
            pass


#: Credentials tunnel-client holds in its environment. The stdio child inherits that
#: environment, so the gate drops them from its own and never passes them on.
SECRET_ENV_VARS = (
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_TOKEN",
    "CLOUDFLARED_TUNNEL_TOKEN",
)


class Gate:
    def __init__(self) -> None:
        for name in SECRET_ENV_VARS:
            os.environ.pop(name, None)
        child_command = os.environ.get("NOUSOS_GATE_CHILD")
        if not child_command:
            raise RuntimeError("Set NOUSOS_GATE_CHILD to the gate child wrapper executable.")
        environment = os.environ.copy()
        environment["NOUS_OS_STDIO_TIERS"] = "read"
        self.child = subprocess.Popen(
            [child_command],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=environment,
        )
        self.out_lock = threading.Lock()
        self.child_in_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending: dict[str, dict[str, Any]] = {}
        self.stopping = threading.Event()
        self.child_failed = threading.Event()
        self.log = MetadataLog()
        self.reader = threading.Thread(target=self._read_child, name="nousos-gate-child")
        self.reader.start()

    def _write_stdout(self, value: dict[str, Any]) -> None:
        try:
            line = wire(value) + b"\n"
            with self.out_lock:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
        except Exception:
            self.stopping.set()

    def _arguments_info(self, arguments: Any) -> tuple[list[str], int]:
        if not isinstance(arguments, dict):
            return [], 0
        try:
            return sorted(arguments), len(wire(arguments))
        except Exception:
            return sorted(arguments), 0

    def _log_response(
        self,
        pending: dict[str, Any] | None,
        decision: str,
        *,
        response_bytes: int = 0,
        error_code: int | None = None,
        response_digest: str | None = None,
    ) -> None:
        self.log.write(
            resp_digest=response_digest,
            event="response",
            id=None if pending is None else pending["id"],
            method=None if pending is None else pending["method"],
            tool=None if pending is None else pending["tool"],
            decision=decision,
            arg_keys=[] if pending is None else pending["arg_keys"],
            arg_bytes=0 if pending is None else pending["arg_bytes"],
            resp_bytes=response_bytes,
            error_code=error_code,
            duration_ms=(
                None
                if pending is None
                else int((time.monotonic() - pending["started"]) * 1000)
            ),
        )

    def _respond(
        self,
        request_id: Any,
        code: int,
        message: str,
        *,
        pending: dict[str, Any] | None = None,
        decision: str,
    ) -> None:
        self._write_stdout(
            {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
        )
        self._log_response(pending, decision, error_code=code)

    def _add_pending(
        self, request_id: Any, method: str, tool: str | None, arguments: Any,
        reduced: dict[str, dict[str, int]] | None = None,
    ) -> bool:
        """Register one in-flight id; False when that id is already in flight."""
        keys, size = self._arguments_info(arguments)
        key = id_key(request_id)
        with self.pending_lock:
            if key in self.pending:
                return False
            self.pending[key] = {
                "id": request_id,
                "method": method,
                "tool": tool,
                "started": time.monotonic(),
                "arg_keys": keys,
                "arg_bytes": size,
                "reduced": reduced or {},
                "applied": {
                    key: arguments[key]
                    for key in CAPS.get(tool or "", {})
                    if isinstance(arguments, dict) and isinstance(arguments.get(key), int)
                    and not isinstance(arguments.get(key), bool)
                },
            }
        return True

    def _take_pending(self, request_id: Any) -> dict[str, Any] | None:
        try:
            key = id_key(request_id)
        except Exception:
            return None
        with self.pending_lock:
            return self.pending.pop(key, None)

    def _fail_pending(self) -> None:
        with self.pending_lock:
            pending = list(self.pending.values())
            self.pending.clear()
        for item in pending:
            self._respond(
                item["id"],
                -32000,
                "ChildExited: the NousOS server stopped",
                pending=item,
                decision="child_exited",
            )

    def _fatal_child_exit(self) -> None:
        if self.stopping.is_set() or self.child_failed.is_set():
            return
        self.child_failed.set()
        self._fail_pending()
        self.log.write(event="response", decision="child_exited")
        os._exit(1)

    def _write_child(self, raw: bytes) -> bool:
        if self.child.stdin is None:
            return False
        try:
            with self.child_in_lock:
                self.child.stdin.write(raw)
                if not raw.endswith(b"\n"):
                    self.child.stdin.write(b"\n")
                self.child.stdin.flush()
            return True
        except Exception:
            self._fatal_child_exit()
            return False

    def _rewrite_list(self, response: dict[str, Any]) -> dict[str, Any]:
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("tools"), list):
            return response

        original = {
            item.get("name"): item
            for item in result["tools"]
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        exposed: list[dict[str, Any]] = []
        for product_name in READ_TOOLS:
            item = original.get(product_name)
            if item is None:
                continue
            tool = dict(item)
            tool["name"] = PRODUCT_TO_ALIAS[product_name]

            schema = tool.get("inputSchema")
            if isinstance(schema, dict):
                schema = dict(schema)
                properties = schema.get("properties")
                if product_name == "provenance.verify_derived":
                    properties = dict(properties) if isinstance(properties, dict) else {}
                    properties.pop("full", None)
                    properties["citation"] = {
                        "type": "object",
                        "description": "One derived_citations entry from candidate_search.",
                    }
                    schema["properties"] = properties
                    schema["required"] = ["citation"]
                    schema["additionalProperties"] = False
                if isinstance(properties, dict):
                    properties = dict(properties)
                    for argument, maximum in CAPS.get(product_name, {}).items():
                        field = properties.get(argument)
                        if isinstance(field, dict):
                            field = dict(field)
                            old = field.get("maximum")
                            field["maximum"] = (
                                min(old, maximum)
                                if isinstance(old, int) and not isinstance(old, bool)
                                else maximum
                            )
                            properties[argument] = field
                    if product_name in {
                        "knowledge.search", "knowledge.semantic", "candidate.search"
                    }:
                        field = dict(properties.get("limit", {}))
                        field["default"] = 10
                        properties["limit"] = field
                    if product_name in {"knowledge.search", "knowledge.semantic"}:
                        field = dict(properties.get("role", {}))
                        field.update({"type": "string", "enum": ["user", "assistant"]})
                        properties["role"] = field
                    if product_name == "knowledge.context":
                        field = dict(properties.get("limit", {}))
                        field.update({
                            "default": 30,
                            "description": "Container pages hold at most 30 records (default 30).",
                        })
                        properties["limit"] = field
                        field = dict(properties.get("offset", {}))
                        field.update({
                            "type": "integer", "minimum": 0, "default": 0,
                            "description": "Container pages only; use next_offset from the previous page.",
                        })
                        properties["offset"] = field
                        field = dict(properties.get("view", {}))
                        field.update({"type": "string", "enum": ["full", "text"]})
                        properties["view"] = field
                        field = dict(properties.get("max_chars", {}))
                        field.update({"type": "integer", "minimum": 200, "maximum": 8000})
                        properties["max_chars"] = field
                    if product_name == "candidate.search":
                        for argument, updates in {
                            "query": {"maxLength": 256},
                            "limit": {"maximum": 10, "default": 10},
                            "include_replaced": {"type": "boolean", "enum": [False, True], "default": False,
                                                 "description": "Optional, for questions about how a proposal or decision evolved; default false."},
                            "ranking": {
                                "enum": ["text", "text_relevance", "source_semantic"],
                                "description": "text (default: the best 100 keyword matches by relevance, then "
                                "candidate id; within them canonical and person-stated decisions "
                                "break equal-score ties), text_relevance (plain keyword relevance), or "
                                "source_semantic (meaning of the cited passages; an option for "
                                "paraphrases or wording that differs from the proposals)",
                            },
                        }.items():
                            field = properties.get(argument)
                            field = dict(field) if isinstance(field, dict) else {}
                            field.update(updates)
                            properties[argument] = field
                    if product_name == "reconcile.relations":
                        field = dict(properties.get("source_id", {}))
                        field.update({
                            "type": "string",
                            "pattern": "^src_[0-9A-Z]{26}$",
                            "maxLength": 30,
                            "description": (
                                "Use a source_id from a search, context or proposal result."
                            ),
                        })
                        properties["source_id"] = field
                        field = dict(properties.get("relation_class", {}))
                        field["enum"] = [
                            "same_source", "revision", "restatement",
                            "related", "contradiction", "unknown",
                        ]
                        properties["relation_class"] = field
                    schema["properties"] = properties
                if product_name == "candidate.search":
                    required = schema.get("required")
                    required = list(required) if isinstance(required, list) else []
                    if "query" not in required:
                        required.append("query")
                    schema["required"] = required
                if product_name == "reconcile.relations":
                    required = schema.get("required")
                    required = list(required) if isinstance(required, list) else []
                    if "source_id" not in required:
                        required.append("source_id")
                    schema["required"] = required
                tool["inputSchema"] = schema

            tool["annotations"] = dict(READ_ANNOTATIONS)
            tool["description"] = CHATGPT_TOOL_DESCRIPTIONS[product_name]
            exposed.append(tool)

        replacement = dict(result)
        replacement["tools"] = exposed
        response = dict(response)
        response["result"] = replacement
        return response

    @staticmethod
    def _rewrite_derived_response(response: dict[str, Any], request_id: Any) -> dict[str, Any]:
        error = response.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            safe_message = (
                "InvalidDerivedCitation: the citation is not a valid derived citation"
                if isinstance(message, str) and message.startswith("ArgumentTypeError")
                else "VerificationFailed: the citation could not be checked"
            )
            code = error.get("code")
            return {"jsonrpc": "2.0", "id": request_id, "error": {
                "code": code if isinstance(code, int) and not isinstance(code, bool) else -32000,
                "message": safe_message,
            }}

        result = response.get("result")
        parsed: Any = None
        if isinstance(result, dict) and isinstance(result.get("content"), list):
            content = result["content"]
            if content and isinstance(content[0], dict) and isinstance(content[0].get("text"), str):
                try:
                    parsed = strict_loads(content[0]["text"].encode("utf-8"))
                except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
                    pass
        if isinstance(parsed, dict) and parsed.get("ok") is True:
            safe = {
                "ok": True,
                "check": "preserved_extraction",
                "matches_preserved_extraction": True,
                "verified_on_original": False,
            }
        elif isinstance(parsed, dict) and parsed.get("ok") is False:
            error_type = parsed.get("error")
            if error_type not in DERIVED_ERROR_MESSAGES:
                error_type = "VerificationFailed"
                message = "The citation could not be checked against the preserved extraction."
            else:
                message = DERIVED_ERROR_MESSAGES[error_type]
            safe = {
                "ok": False,
                "check": "preserved_extraction",
                "matches_preserved_extraction": False,
                "verified_on_original": False,
                "error": error_type,
                "message": message,
            }
        else:
            safe = {
                "ok": False,
                "check": "preserved_extraction",
                "matches_preserved_extraction": False,
                "verified_on_original": False,
                "error": "VerificationFailed",
                "message": "The citation could not be checked against the preserved extraction.",
            }
        return {"jsonrpc": "2.0", "id": request_id,
                "result": {"content": [{"type": "text", "text": wire(safe).decode("utf-8")}]}}

    @staticmethod
    def _input_error_result(
        response: dict[str, Any], pending: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """A known caller-input refusal as an isError tool result; None for anything else."""
        if not pending or pending.get("method") != "tools/call":
            return None
        error = response.get("error")
        if not isinstance(error, dict) or "result" in response:
            return None
        code = error.get("code")
        if type(code) is not int or code != -32000:
            return None
        message = error.get("message")
        known = INPUT_ERRORS.get(pending.get("tool") or "", {})
        if not isinstance(message, str) or message not in known:
            return None
        error_type, text = known[message]
        body = {"error": error_type, "message": text}
        return {"jsonrpc": "2.0", "id": pending["id"], "result": {
            "content": [{"type": "text", "text": wire(body).decode("utf-8")}],
            "isError": True,
        }}

    @staticmethod
    def _annotate_limits(response: dict[str, Any], pending: dict[str, Any]) -> dict[str, Any]:
        """Append one gate_limits item; the product's own content is left untouched."""
        result = response.get("result")
        if "error" in response or not isinstance(result, dict) or result.get("isError"):
            return response
        content = result.get("content")
        if not isinstance(content, list) or not content or not isinstance(content[0], dict):
            return response
        text = content[0].get("text")
        if not isinstance(text, str):
            return response
        try:
            body = strict_loads(text.encode("utf-8"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return response
        tool = pending.get("tool")
        reduced = pending.get("reduced") or {}
        applied = dict(pending.get("applied") or {})
        if tool in PRODUCT_DEFAULT_LIMITS and "limit" not in applied:
            applied["limit"] = PRODUCT_DEFAULT_LIMITS[tool]
        notes: list[str] = []
        if tool in {"knowledge.search", "knowledge.semantic"}:
            hits = body if isinstance(body, list) else (
                body.get("hits") if isinstance(body, dict) else None
            )
            limit = applied.get("limit")
            if isinstance(hits, list) and isinstance(limit, int) and len(hits) == limit:
                notes.append(LIMIT_NOTES["search_full"])
                if limit < CAPS[tool]["limit"]:
                    notes.append(LIMIT_NOTES["raise_limit"])
        elif tool == "candidate.search":
            if isinstance(body, dict) and isinstance(body.get("next_cursor"), str):
                notes.append(LIMIT_NOTES["cursor"])
        elif tool == "knowledge.context":
            if "before" in reduced or "after" in reduced:
                notes.append(LIMIT_NOTES["window"])
            if "max_chars" in reduced:
                notes.append(LIMIT_NOTES["max_chars"])
            if "limit" in reduced and isinstance(body, dict) and body.get("has_more") is True:
                notes.append(LIMIT_NOTES["page"])
        if not notes and not reduced:
            return response
        notice = {"gate_limits": {
            "applied": applied,
            "maximum": CAPS[tool],
            "reduced": reduced,
            "continuation": " ".join(notes) if notes else None,
        }}
        replacement = dict(result)
        replacement["content"] = list(content) + [
            {"type": "text", "text": wire(notice).decode("utf-8")}
        ]
        response = dict(response)
        response["result"] = replacement
        return response

    @staticmethod
    def _rewrite_initialize(response: dict[str, Any]) -> dict[str, Any]:
        result = response.get("result")
        if not isinstance(result, dict):
            return response
        replacement = dict(result)
        replacement["instructions"] = CHATGPT_SERVER_INSTRUCTIONS
        response = dict(response)
        response["result"] = replacement
        return response

    def _read_child(self) -> None:
        assert self.child.stdout is not None
        try:
            for raw in self.child.stdout:
                raw = raw.rstrip(b"\r\n")
                try:
                    response = strict_loads(raw)
                except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
                    self._log_response(None, "drop_malformed_child", response_bytes=len(raw))
                    continue

                if not isinstance(response, dict):
                    self._log_response(None, "drop_malformed_child", response_bytes=len(raw))
                    continue
                if "id" not in response:
                    self._log_response(None, "drop_child_notification", response_bytes=len(raw))
                    continue

                request_id = response["id"]
                pending = self._take_pending(request_id)
                if pending is None:
                    self._log_response(None, "drop_unmatched", response_bytes=len(raw))
                    continue
                if pending and pending["method"] == "tools/call" and len(raw) > MAX_RESPONSE_BYTES:
                    self._respond(
                        request_id,
                        -32000,
                        "ResponseTooLarge: "
                        f"{len(raw)} bytes exceed the tunnel profile limit of 400000; "
                        "narrow the request (smaller limit/before/after)",
                        pending=pending,
                        decision="response_too_large",
                    )
                    continue

                # Filter every tool-list-shaped result, not only the answer to a tracked
                # tools/list id: a mismatched id must never leak the full catalogue.
                if (pending and pending["method"] == "tools/list") or (
                    isinstance(response.get("result"), dict)
                    and isinstance(response["result"].get("tools"), list)
                ):
                    response = self._rewrite_list(response)
                elif pending and pending["method"] == "initialize":
                    response = self._rewrite_initialize(response)

                if (pending and pending["method"] == "tools/call"
                        and pending.get("tool") == "provenance.verify_derived"):
                    response = self._rewrite_derived_response(response, pending["id"])

                if (pending and pending["method"] == "tools/call"
                        and pending.get("tool") in CAPS):
                    annotated = self._annotate_limits(response, pending)
                    if annotated is not response:
                        size = len(wire(annotated))
                        if size > MAX_RESPONSE_BYTES:
                            self._respond(
                                request_id,
                                -32000,
                                "ResponseTooLarge: "
                                f"{size} bytes exceed the tunnel profile limit of 400000; "
                                "narrow the request (smaller limit/before/after)",
                                pending=pending,
                                decision="response_too_large",
                            )
                            continue
                    response = annotated

                converted = self._input_error_result(response, pending)
                if converted is not None:
                    self._write_stdout(converted)
                    self._log_response(
                        pending, "input_error", response_bytes=len(raw),
                        error_code=response["error"].get("code"),
                    )
                    continue

                if isinstance(response.get("error"), dict):
                    code = response["error"].get("code")
                    self._write_stdout(response)
                    self._log_response(
                        pending,
                        "child_error",
                        response_bytes=len(raw),
                        error_code=code if isinstance(code, int) else None,
                    )
                    continue
                self._write_stdout(response)
                digest = None
                if pending and pending["method"] == "tools/list":
                    digest = hashlib.sha256(
                        wire(response.get("result")) if "result" in response else b""
                    ).hexdigest()[:16]
                self._log_response(
                    pending, "forward", response_bytes=len(raw), response_digest=digest
                )
        finally:
            self._fatal_child_exit()

    def _forward(
        self,
        request: dict[str, Any],
        raw: bytes,
        method: str,
        tool: str | None,
        arguments: Any,
        decision: str,
        reduced: dict[str, dict[str, int]] | None = None,
    ) -> None:
        if "id" in request and not self._add_pending(
            request["id"], method, tool, arguments, reduced
        ):
            self._invalid(request["id"], method, -32600, "duplicate request id already in flight")
            return
        keys, size = self._arguments_info(arguments)
        self.log.write(
            event="request",
            id=request.get("id"),
            method=method,
            tool=tool,
            decision=decision,
            arg_keys=keys,
            arg_bytes=size,
        )
        # A tools/call is always re-serialised: its name may have been mapped from the
        # published alias to the product name even when no argument was capped.
        outbound = wire(request) if method == "tools/call" else raw
        self._write_child(outbound)

    def _invalid(
        self,
        request_id: Any,
        method: str | None,
        code: int,
        message: str,
        decision: str = "refuse_invalid",
    ) -> None:
        self.log.write(
            event="request",
            id=request_id,
            method=method,
            decision=decision,
        )
        self._respond(request_id, code, message, decision=decision)

    def handle_line(self, raw: bytes) -> None:
        raw = raw.rstrip(b"\r\n")
        try:
            request = strict_loads(raw)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._invalid(None, None, -32700, "parse error", "parse_error")
            return

        try:
            wire(request)
        except Exception:
            self._invalid(None, None, -32700, "parse error", "parse_error")
            return

        if isinstance(request, list):
            self._invalid(
                None,
                None,
                -32600,
                "batch requests are not supported by the tunnel profile",
                "refuse_batch",
            )
            return
        if not isinstance(request, dict):
            self._invalid(None, None, -32600, "invalid request")
            return

        if "id" in request and not valid_id(request["id"]):
            self._invalid(None, None, -32600, "invalid request id")
            return

        request_id = request.get("id")
        method = request.get("method")
        if not isinstance(method, str):
            self._invalid(request_id, None, -32600, "invalid request")
            return

        if "id" not in request:
            if method.startswith("notifications/"):
                self._forward(request, raw, method, None, None, "forward")
            else:
                self.log.write(
                    event="request",
                    method=method,
                    decision="refuse_invalid",
                )
            return

        if method == "ping":
            self.log.write(event="request", id=request_id, method=method, decision="ping")
            self._write_stdout({"jsonrpc": "2.0", "id": request_id, "result": {}})
            self._log_response(None, "ping")
            return

        if method not in {"initialize", "tools/list", "tools/call"}:
            self._invalid(
                request_id,
                method,
                -32601,
                f"unknown method: '{safe_echo(method)}'",
            )
            return

        tool: str | None = None
        arguments: Any = None
        decision = "forward"
        if method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict):
                self._invalid(request_id, method, -32602, "invalid params")
                return
            requested_name = params.get("name")
            if not isinstance(requested_name, str):
                self._invalid(request_id, method, -32602, "invalid params")
                return
            tool = ALIAS_TO_PRODUCT.get(requested_name, requested_name)
            if tool not in PRODUCT_TO_ALIAS:
                self.log.write(
                    event="request",
                    id=request_id,
                    method=method,
                    tool=None,
                    decision="refuse_not_exposed",
                )
                self._respond(
                    request_id,
                    -32000,
                    f"NotExposed: '{safe_echo(requested_name)}' is not exposed through "
                    f"the NousOS ChatGPT tunnel profile ({PROFILE_ID})",
                    decision="refuse_not_exposed",
                )
                return

            params = dict(params)
            params["name"] = tool
            request = dict(request)
            request["params"] = params
            arguments = params.get("arguments")

            if tool == "provenance.verify_derived":
                if not isinstance(arguments, dict) or set(arguments) - {"citation", "full"}:
                    self._invalid(request_id, method, -32602, "invalid derived citation arguments")
                    return
                if "full" in arguments and arguments["full"] is not False:
                    self._invalid(
                        request_id, method, -32602,
                        "full verification on original attachments is not exposed",
                    )
                    return
                citation = arguments.get("citation")
                if not isinstance(citation, dict):
                    self._invalid(request_id, method, -32602, "citation must be an object")
                    return
                span = citation.get("span")
                start = citation.get("start_char")
                end = citation.get("end_char")
                if ((isinstance(span, str) and len(span.encode("utf-8")) > MAX_SPAN_BYTES)
                        or (isinstance(start, int) and not isinstance(start, bool)
                            and isinstance(end, int) and not isinstance(end, bool)
                            and end - start > MAX_SPAN_BYTES)):
                    self._invalid(request_id, method, -32602, "derived citation exceeds 32768 characters")
                    return
                arguments = {"citation": citation, "full": False}
                params["arguments"] = arguments

            if tool == "candidate.search":
                if arguments is None:
                    arguments = {}
                if not isinstance(arguments, dict):
                    self._invalid(request_id, method, -32602, "invalid candidate search arguments")
                    return
                query = arguments.get("query")
                if not isinstance(query, str) or not query.strip() or len(query) > 256:
                    self._invalid(request_id, method, -32602, "invalid candidate search query")
                    return
                if "include_replaced" in arguments and not isinstance(arguments["include_replaced"], bool):
                    self._invalid(request_id, method, -32602, "invalid include_replaced")
                    return
                if "ranking" in arguments and arguments["ranking"] not in (
                    "text", "text_relevance", "source_semantic"
                ):
                    self._invalid(request_id, method, -32602, "invalid candidate search ranking")
                    return
                limit = arguments.get("limit")
                if "limit" in arguments and (
                    not isinstance(limit, int) or isinstance(limit, bool) or limit < 1
                ):
                    self._invalid(request_id, method, -32602, "invalid candidate search limit")
                    return

            if tool == "reconcile.relations":
                classes = (
                    "same_source", "revision", "restatement", "related",
                    "contradiction", "unknown",
                )
                if not isinstance(arguments, dict):
                    self._invalid(
                        request_id, method, -32602, "invalid relation arguments",
                        "refuse_relations_unbounded",
                    )
                    return
                source_id = arguments.get("source_id")
                if not isinstance(source_id, str) or not re.fullmatch(
                    r"src_[0-9A-Z]{26}", source_id
                ):
                    self._invalid(
                        request_id, method, -32602, "invalid relation source_id",
                        "refuse_relations_unbounded",
                    )
                    return
                if "relation_class" in arguments and arguments["relation_class"] not in classes:
                    self._invalid(
                        request_id, method, -32602, "invalid relation class",
                        "refuse_relations_unbounded",
                    )
                    return
                if set(arguments) - {"source_id", "relation_class"}:
                    self._invalid(
                        request_id, method, -32602, "unsupported relation arguments",
                        "refuse_relations_unbounded",
                    )
                    return

            if tool == "provenance.span" and isinstance(arguments, dict):
                citation = arguments.get("citation")
                if isinstance(citation, dict):
                    start = citation.get("start_byte")
                    end = citation.get("end_byte")
                    if (
                        isinstance(start, int)
                        and not isinstance(start, bool)
                        and isinstance(end, int)
                        and not isinstance(end, bool)
                        and end - start > MAX_SPAN_BYTES
                    ):
                        self.log.write(
                            event="request",
                            id=request_id,
                            method=method,
                            tool=tool,
                            decision="refuse_span_too_wide",
                            arg_keys=sorted(arguments),
                            arg_bytes=self._arguments_info(arguments)[1],
                        )
                        self._respond(
                            request_id,
                            -32000,
                            "SpanTooWide: a citation may cover at most 32768 bytes "
                            "through this connector",
                            decision="refuse_span_too_wide",
                        )
                        return

            if tool in READ_TOOLS:
                if arguments is None:
                    arguments = {}
                    params["arguments"] = arguments
                if isinstance(arguments, dict):
                    arguments = dict(arguments)
                    params["arguments"] = arguments
                    capped: list[str] = []
                    reduced: dict[str, dict[str, int]] = {}
                    if (
                        tool in {"knowledge.search", "knowledge.semantic"}
                        and "role" in arguments
                        and arguments["role"] not in ("user", "assistant")
                    ):
                        self._invalid(request_id, method, -32602, "invalid role")
                        return
                    if tool == "knowledge.context":
                        if "offset" in arguments:
                            value = arguments["offset"]
                            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                                self._invalid(request_id, method, -32602, "invalid offset")
                                return
                        if "view" not in arguments:
                            arguments["view"] = "text"
                            capped.append("view")
                        if arguments["view"] not in ("full", "text"):
                            self._invalid(request_id, method, -32602, "invalid view")
                            return
                        if "max_chars" in arguments:
                            value = arguments["max_chars"]
                            if not isinstance(value, int) or isinstance(value, bool) or value < 200:
                                self._invalid(request_id, method, -32602, "invalid max_chars")
                                return
                            if arguments["view"] == "full":
                                self._invalid(
                                    request_id, method, -32602,
                                    "max_chars requires text view",
                                )
                                return
                    for key, maximum in CAPS.get(tool, {}).items():
                        value = arguments.get(key)
                        if isinstance(value, int) and not isinstance(value, bool) and value > maximum:
                            arguments[key] = maximum
                            capped.append(key)
                            reduced[key] = {"requested": value, "applied": maximum}
                    if tool == "knowledge.semantic" and "limit" not in arguments:
                        arguments["limit"] = 10
                        capped.append("limit")
                    if tool == "knowledge.context" and "limit" not in arguments:
                        arguments["limit"] = 30
                        capped.append("limit")
                    if tool == "candidate.search":
                        if "limit" not in arguments:
                            arguments["limit"] = 10
                            capped.append("limit")
                        if "include_replaced" not in arguments:
                            arguments["include_replaced"] = False
                    if capped:
                        decision = "capped"
                    self._forward(request, raw, method, tool, arguments, decision, reduced)
                    return

        self._forward(request, raw, method, tool, arguments, decision)

    def signal_shutdown(self, signum: int) -> None:
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.log.write(event="request", decision="signal")
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.child.kill()

    def _discard_overlong_line(self) -> None:
        assert sys.stdin.buffer is not None
        while True:
            tail = sys.stdin.buffer.readline(MAX_REQUEST_BYTES)
            if not tail or tail.endswith(b"\n"):
                return

    def run(self) -> int:
        try:
            while not self.stopping.is_set():
                raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
                if not raw:
                    self.stopping.set()
                    break
                if len(raw) > MAX_REQUEST_BYTES:
                    if not raw.endswith(b"\n"):
                        self._discard_overlong_line()
                    self._invalid(None, None, -32600, "request too large")
                    continue
                self.handle_line(raw)
        finally:
            self.stopping.set()
            if self.child.stdin is not None:
                try:
                    self.child.stdin.close()
                except Exception:
                    pass
            if self.child.poll() is None:
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.terminate()
                    try:
                        self.child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.child.kill()
            self.reader.join(timeout=1)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps(
            {
                "profile": PROFILE_ID,
                "tools": list(PUBLISHED_ALIASES),
                "caps": CAPS,
                "max_request_bytes": MAX_REQUEST_BYTES,
                "max_span_bytes": MAX_SPAN_BYTES,
            },
            separators=(",", ":"),
        ))
        return 0

    gate = Gate()

    def on_signal(signum: int, _frame: Any) -> None:
        gate.signal_shutdown(signum)
        raise SystemExit(0)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, on_signal)
    return gate.run()


if __name__ == "__main__":
    raise SystemExit(main())
