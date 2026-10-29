#!/usr/bin/env python3
"""Unit tests for the NousOS ChatGPT tunnel gate."""

from __future__ import annotations

import json
import os
import queue
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "nousos_tunnel_gate.py"
MAX_REQUEST_BYTES = 262_144

PRODUCT_NAMES = [
    "knowledge.search", "knowledge.semantic", "knowledge.context", "provenance.span",
    "canon.assertions", "candidate.search", "candidate.propose", "candidate.discover",
    "candidate.adjudicate", "reconcile.propose", "candidate.proposals",
    "canon.sources", "reconcile.relations", "canon.documents", "canon.describe",
    "system.health", "source.get", "source.list", "knowledge.timeline",
    "knowledge.related", "knowledge.entities", "knowledge.summary",
    "provenance.document", "provenance.source", "provenance.verify_derived", "canon.decisions",
    "canon.history", "system.version",
]

FAKE_CHILD = r'''#!{python}
import json, os, sys, time
record = os.environ["FAKE_RECORD"]
pid_file = os.environ["FAKE_PID"]
open(pid_file, "w").write(str(os.getpid()))
names = {names!r}

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    with open(record, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({{
            "method": request.get("method"),
            "name": request.get("params", {{}}).get("name"),
            "arguments": request.get("params", {{}}).get("arguments"),
            "meta": request.get("params", {{}}).get("_meta"),
        }}) + "\n")
    if "id" not in request:
        continue
    request_id = request["id"]
    method = request.get("method")
    if method == "initialize":
        response_id = 900 if request.get("params", {{}}).get("mismatch") else request_id
        emit({{"jsonrpc":"2.0","id":response_id,"result":{{"protocolVersion":"2024-11-05","capabilities":{{"tools":{{"listChanged":False}}}},"instructions":"child private-sentinel-x" if response_id == 900 else "child instructions"}}}})
    elif method == "tools/list":
        emit({{"jsonrpc":"2.0","id":request_id,"result":{{"tools":[
            {{"name":name,"description":"fake","inputSchema":{{"type":"object","properties":{{
                "limit":{{"type":"integer"}},"before":{{"type":"integer"}},"after":{{"type":"integer"}},
                "query":{{"type":"string"}},"include_replaced":{{"type":"boolean"}},
                "ranking":{{"type":"string"}},"role":{{"type":"string"}},"view":{{"type":"string"}},"max_chars":{{"type":"integer"}},"source_id":{{"type":"string"}},
                "relation_class":{{"type":"string"}}
                ,"citation":{{"type":"object"}},"full":{{"type":"boolean"}},"span":{{"type":"string"}},"start_char":{{"type":"integer"}},"end_char":{{"type":"integer"}}
            }}}}}} for name in names
        ]}}}})
    elif method == "tools/call":
        params = request.get("params", {{}})
        arguments = params.get("arguments", {{}})
        if params.get("name") == "provenance.verify_derived":
            mode = arguments.get("citation", {{}}).get("fixture", "ok")
            if mode == "private_rpc_error":
                emit({{"jsonrpc":"2.0","id":request_id,"error":{{"code":-32000,"message":"Secret private-sentinel-x"}},"_meta":"private-sentinel-x","result":{{"private":"private-sentinel-x"}}}})
                continue
            if mode == "rpc_argument_error":
                emit({{"jsonrpc":"2.0","id":request_id,"error":{{"code":-32000,"message":"ArgumentTypeError: private-sentinel-x", "data":"private-sentinel-x"}}}})
            elif mode == "rpc_other_error":
                emit({{"jsonrpc":"2.0","id":request_id,"error":{{"code":-32000,"message":"Secret private-sentinel-x", "data":"private-sentinel-x"}}}})
            else:
                payload = {{"ok": mode == "ok", "extra":"discard", "verdict":"original"}}
                if mode in ("listed_error", "unknown_error", "locator_range", "locator_grapheme"):
                    error_type = {{"listed_error":"SpanMismatch", "unknown_error":"SecretError", "locator_range":"LocatorOutOfRange", "locator_grapheme":"LocatorSplitsGrapheme"}}[mode]
                    payload.update({{"ok":False,"error":error_type,"message":"private private-sentinel-x"}})
                text = json.dumps(payload)
                if mode == "malformed":
                    text = "not json"
                envelope = {{"jsonrpc":"2.0","id":request_id,"result":{{"content":[{{"type":"text","text":text}}]}},"_meta":"private-sentinel-x"}}
                if mode in ("private_success", "private_both"):
                    envelope["result"]["private"] = "private-sentinel-x"
                if mode == "private_both":
                    envelope["error"] = {{"code":-32000,"message":"shadow"}}
                emit(envelope)
            continue
        if arguments.get("noise"):
            sys.stdout.write("not-json private-sentinel-x\n")
            emit({{"jsonrpc":"2.0","method":"notifications/changed","params":{{"path":"private-sentinel-x"}}}})
            sys.stdout.flush()
        if arguments.get("exit"):
            sys.exit(0)
        if arguments.get("oversize"):
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"content":[{{"type":"text","text":"x"*410000}}]}}}})
        elif arguments.get("envcheck"):
            seen = sorted(k for k in ("CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY") if k in os.environ)
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"secret_env_seen":seen,"tiers":os.environ.get("NOUS_OS_STDIO_TIERS")}}}})
        elif arguments.get("listshaped"):
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"tools":[{{"name":name}} for name in names]}}}})
        elif arguments.get("child_error"):
            code, message = arguments["child_error"][:2]
            envelope = {{"jsonrpc":"2.0","id":request_id,"error":{{"code":code,"message":message}}}}
            if arguments["child_error"][2:]:
                envelope["result"] = {{"content":[]}}
            emit(envelope)
        elif arguments.get("bulk"):
            count, size = arguments["bulk"]
            text = json.dumps([{{"t": "x" * size}} for _ in range(count)])
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"content":[{{"type":"text","text":text}}]}}}})
        elif arguments.get("candidate_hit"):
            emit({{"jsonrpc":"2.0","id":request_id,"result":arguments["candidate_hit"]}})
        elif arguments.get("slow"):
            time.sleep(0.5)
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"received":arguments}}}})
        else:
            if arguments.get("delay"):
                time.sleep(0.03)
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"received":arguments}}}})
'''


class GateProcess:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.record = root / "received.ndjson"
        self.pid_file = root / "child.pid"
        self.line_sizes: list[int] = []
        self.line_lock = threading.Lock()
        fake = root / "fake_child.py"
        fake.write_text(
            FAKE_CHILD.format(python=sys.executable, names=PRODUCT_NAMES),
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        environment = os.environ.copy()
        environment.update({
            "NOUSOS_GATE_CHILD": str(fake),
            "NOUSOS_TUNNEL_LOG_DIR": str(root / "logs"),
            "FAKE_RECORD": str(self.record),
            "FAKE_PID": str(self.pid_file),
            "CONTROL_PLANE_API_KEY": "test-runtime-key",
            "OPENAI_API_KEY": "test-runtime-key",
        })
        self.proc = subprocess.Popen(
            [sys.executable, str(GATE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        assert self.proc.stdout is not None
        self.responses: queue.Queue[dict] = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            with self.line_lock:
                self.line_sizes.append(len(line))
            self.responses.put(json.loads(line))

    def send(self, request: object) -> None:
        assert self.proc.stdin is not None
        if isinstance(request, bytes):
            encoded = request
        elif isinstance(request, str):
            encoded = request.encode("utf-8")
        else:
            encoded = json.dumps(request).encode("utf-8")
        self.proc.stdin.write(encoded + b"\n")
        self.proc.stdin.flush()

    def response(self, request_id: object, timeout: float = 2.0) -> dict:
        until = time.monotonic() + timeout
        deferred: list[dict] = []
        while time.monotonic() < until:
            try:
                value = self.responses.get(timeout=max(0.01, until - time.monotonic()))
            except queue.Empty:
                break
            if value.get("id") == request_id:
                for other in deferred:
                    self.responses.put(other)
                return value
            deferred.append(value)
        for other in deferred:
            self.responses.put(other)
        raise AssertionError(f"no response for {request_id!r}")

    def received(self) -> list[dict]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def log_text(self) -> str:
        paths = list((self.root / "logs").glob("gate-*.ndjson"))
        return "".join(path.read_text() for path in paths)

    def close_stdin(self) -> None:
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()

    def close(self) -> None:
        self.close_stdin()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=2)


def _content(payload: object) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


class GateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.gate = GateProcess(self.root)

    def tearDown(self) -> None:
        self.gate.close()
        self.temp.cleanup()

    @staticmethod
    def call(
        request_id: int,
        name: str,
        arguments: object = None,
        meta: object = None,
    ) -> dict:
        params: dict[str, object] = {"name": name}
        if arguments is not None:
            params["arguments"] = arguments
        if meta is not None:
            params["_meta"] = meta
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": params,
        }

    def test_alias_list_and_schema_annotations(self) -> None:
        self.gate.send({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        tools = self.gate.response(1)["result"]["tools"]
        self.assertEqual(
            [tool["name"] for tool in tools],
            [
                "knowledge_search", "knowledge_semantic", "knowledge_context",
                "provenance_span", "provenance_verify_derived", "canon_assertions",
                "candidate_search", "reconcile_relations",
            ],
        )
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in tools))
        self.assertEqual(tools[0]["inputSchema"]["properties"]["limit"]["maximum"], 20)
        self.assertEqual(tools[1]["inputSchema"]["properties"]["limit"]["maximum"], 10)
        self.assertEqual(tools[2]["inputSchema"]["properties"]["limit"]["maximum"], 30)
        self.assertEqual(tools[0]["inputSchema"]["properties"]["limit"]["default"], 10)
        self.assertEqual(tools[1]["inputSchema"]["properties"]["limit"]["default"], 10)
        search_props = tools[0]["inputSchema"]["properties"]
        semantic_props = tools[1]["inputSchema"]["properties"]
        context_props = tools[2]["inputSchema"]["properties"]
        self.assertEqual(search_props["role"]["enum"], ["user", "assistant"])
        self.assertEqual(semantic_props["role"]["enum"], ["user", "assistant"])
        self.assertEqual(context_props["view"]["enum"], ["full", "text"])
        self.assertEqual(context_props["limit"]["default"], 30)
        self.assertIn("at most 30 records (default 30)", context_props["limit"]["description"])
        self.assertEqual(context_props["offset"]["type"], "integer")
        self.assertEqual(context_props["offset"]["minimum"], 0)
        self.assertEqual(context_props["offset"]["default"], 0)
        self.assertIn("Container pages only", context_props["offset"]["description"])
        self.assertEqual(context_props["max_chars"]["minimum"], 200)
        self.assertEqual(context_props["max_chars"]["maximum"], 8000)
        context_description = tools[2]["description"]
        for phrase in ("pages of at most 30 records", "total, has_more and next_offset",
                       "request another page with offset only when needed",
                       "never read a whole conversation automatically",
                       "not missing memory", "search and source_id context"):
            self.assertIn(phrase, context_description)
        candidate = tools[6]
        schema = candidate["inputSchema"]
        self.assertEqual(schema["properties"]["limit"]["maximum"], 10)
        self.assertEqual(schema["properties"]["limit"]["default"], 10)
        self.assertEqual(schema["properties"]["query"]["maxLength"], 256)
        self.assertEqual(schema["properties"]["include_replaced"]["enum"], [False, True])
        self.assertEqual(schema["properties"]["include_replaced"]["default"], False)
        self.assertIn("Optional", schema["properties"]["include_replaced"]["description"])
        self.assertIn("how a proposal or decision evolved", schema["properties"]["include_replaced"]["description"])
        self.assertEqual(
            schema["properties"]["ranking"]["enum"],
            ["text", "text_relevance", "source_semantic"],
        )
        self.assertIn("source_semantic", schema["properties"]["ranking"]["description"])
        self.assertIn("best 100 keyword matches by relevance", schema["properties"]["ranking"]["description"])
        self.assertIn("break equal-score ties", schema["properties"]["ranking"]["description"])
        self.assertNotIn("decisions first", schema["properties"]["ranking"]["description"])
        self.assertIn("query", schema["required"])
        self.assertIn("recorded proposal, not a decision", candidate["description"])
        self.assertIn("epistemic_label and canonical_status", candidate["description"])
        expected = [
            "knowledge.search", "knowledge.semantic", "knowledge.context",
            "provenance.span", "provenance.verify_derived", "canon.assertions",
            "candidate.search", "reconcile.relations",
        ]
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location("nousos_tunnel_gate", GATE)
        assert spec and spec.loader
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual([tool["description"] for tool in tools], [
            module.CHATGPT_TOOL_DESCRIPTIONS[name] for name in expected
        ])
        self.assertTrue(all(tool["description"] != "fake" for tool in tools))
        relation = tools[7]
        self.assertTrue(relation["annotations"]["readOnlyHint"])
        schema = relation["inputSchema"]
        self.assertIn("source_id", schema["required"])
        self.assertEqual(schema["properties"]["source_id"]["pattern"], r"^src_[0-9A-Z]{26}$")
        self.assertEqual(schema["properties"]["relation_class"]["enum"], [
            "same_source", "revision", "restatement", "related",
            "contradiction", "unknown",
        ])
        self.assertIn("not approved decisions and not verified facts", relation["description"])
        self.assertIn("Exploratory interpretations are not included", relation["description"])
        derived = tools[4]
        self.assertIn("derived_citations", derived["description"])
        self.assertIn("preserved attachment extraction only", derived["description"])
        self.assertIn("not that it was verified on the original attachment", derived["description"])
        self.assertEqual(derived["inputSchema"]["required"], ["citation"])
        self.assertNotIn("full", derived["inputSchema"]["properties"])
        self.assertIn("original", tools[0]["description"])
        self.assertIn("not proposals or decisions", tools[0]["description"])
        self.assertIn("not verified facts or approved decisions", candidate["description"])
        self.assertIn("not instead of it", candidate["description"])
        self.assertIn("replaced_excluded > 0", candidate["description"])
        self.assertIn("one or more matching replaced candidates were excluded", candidate["description"])
        for phrase in ("include_replaced true only", "replaced true", "superseded_by (the next version)",
                       "superseded, not current", "available dates",
                       "does not by itself mean the person changed the decision"):
            self.assertIn(phrase, candidate["description"])
        self.assertIn("distinctive keywords or names", candidate["description"])
        self.assertIn("source_semantic is an option for paraphrase", candidate["description"])
        self.assertIn("one or two retrieved sources", relation["description"])
        for tool in tools[:2]:
            self.assertIn("omit role otherwise", tool["description"])
            self.assertNotIn("Use role user", tool["description"])
            self.assertIn("limit unset (10)", tool["description"])
            self.assertIn("at least 5", tool["description"])
            self.assertIn("reformulate with distinctive keywords", tool["description"])
        self.assertIn("normalized excerpts that may be cut", tools[0]["description"])
        self.assertIn("verbatim but possibly partial passages", tools[1]["description"])
        for tool in tools[:2]:
            self.assertIn("Do not quote them as exact", tool["description"])
            self.assertIn("provenance_span with a returned citation", tool["description"])
            self.assertIn("knowledge_context with view full and the hit's source_id", tool["description"])
        self.assertIn("text_truncated", tools[2]["description"])
        self.assertIn("if true, use view full", tools[2]["description"])

    def test_initialize_instructions_preserve_fields_and_match_id(self) -> None:
        self.gate.send({"jsonrpc": "2.0", "id": 101, "method": "initialize", "params": {}})
        result = self.gate.response(101)["result"]
        self.assertEqual(result["protocolVersion"], "2024-11-05")
        self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
        self.assertIn("four kinds", result["instructions"])
        self.assertIn("recorded relations", result["instructions"])
        self.assertLess(len(result["instructions"]), 1500)
        self.assertIn("reformulate and widen", result["instructions"])
        self.assertIn("Keep answers and call counts proportionate", result["instructions"])
        self.assertIn("Never present proposals as verified facts", result["instructions"])
        self.assertIn("When materially conflicting results have dates", result["instructions"])
        self.assertIn("proposed_at (candidate proposal time)", result["instructions"])
        self.assertIn("valid_from (candidate-stated validity start; may be null)", result["instructions"])
        self.assertIn("created_at (source-record timestamp; may be null)", result["instructions"])
        self.assertIn("replaced_excluded > 0", result["instructions"])
        self.assertIn("one or more matching replaced candidates were excluded", result["instructions"])
        self.assertIn("omit role otherwise", result["instructions"])
        self.assertNotIn("Use role user", result["instructions"])
        self.assertLess(len(result["instructions"]), 1500)

        self.gate.send({"jsonrpc": "2.0", "id": 102, "method": "initialize", "params": {"mismatch": True}})
        with self.assertRaises(AssertionError):
            self.gate.response(900, timeout=0.2)
        self.gate.send({"jsonrpc": "2.0", "id": 103, "method": "ping", "params": {}})
        self.assertEqual(self.gate.response(103)["result"], {})
        self.assertNotIn("private-sentinel-x", self.gate.log_text())
        self.assertIn('"decision":"drop_unmatched"', self.gate.log_text())

    def test_candidate_search_alias_defaults_caps_and_dotted_name(self) -> None:
        self.gate.send(self.call(70, "candidate_search", {"query": "PRIVATE_SEARCH_QUERY"}))
        self.assertEqual(self.gate.response(70)["result"]["received"], {
            "query": "PRIVATE_SEARCH_QUERY", "limit": 10, "include_replaced": False,
        })
        self.gate.send(self.call(71, "candidate_search", {
            "query": "q", "limit": 20, "ranking": "text_relevance", "include_replaced": False,
        }))
        self.assertEqual(self.gate.response(71)["result"]["received"], {
            "query": "q", "limit": 10, "ranking": "text_relevance", "include_replaced": False,
        })
        self.gate.send(self.call(72, "candidate_search", {"query": "q", "include_replaced": True}))
        self.assertEqual(self.gate.response(72)["result"]["received"], {
            "query": "q", "limit": 10, "include_replaced": True,
        })
        self.gate.send(self.call(73, "candidate.search", {"query": "q", "ranking": "text"}))
        self.assertEqual(self.gate.response(73)["result"]["received"]["ranking"], "text")
        self.assertEqual([item["name"] for item in self.gate.received()], [
            "candidate.search", "candidate.search", "candidate.search", "candidate.search",
        ])
        self.assertNotIn("PRIVATE_SEARCH_QUERY", self.gate.log_text())

    def test_derived_citation_gate_validation_and_rewrite(self) -> None:
        citation = {"span": "quote", "start_char": 0, "end_char": 5}
        invalid = [
            {"citation": citation, "full": True},
            {"citation": citation, "full": "false"},
            {"citation": citation, "other": 1},
            {"citation": {"span": "x" * 32769}},
            {"citation": {"start_char": 0, "end_char": 32769}},
        ]
        for request_id, arguments in enumerate(invalid, start=130):
            self.gate.send(self.call(request_id, "provenance_verify_derived", arguments))
            response = self.gate.response(request_id)
            self.assertEqual(response["error"]["code"], -32602)
            if arguments.get("full") is True or arguments.get("full") == "false":
                self.assertEqual(response["error"]["message"], "full verification on original attachments is not exposed")
        self.assertEqual(self.gate.received(), [])
        for request_id, span in ((139, "é" * (32768 // 2) + "a"), (138, "é" * (32768 // 2))):
            self.gate.send(self.call(request_id, "provenance_verify_derived", {"citation": {"span": span}}))
            reply = self.gate.response(request_id)
            if request_id == 139:
                self.assertEqual(reply["error"]["code"], -32602)
            else:
                self.assertIn("result", reply)
        self.gate.send(self.call(140, "provenance_verify_derived", {"citation": citation}))
        self.assertEqual(json.loads(self.gate.response(140)["result"]["content"][0]["text"]), {
            "ok": True, "check": "preserved_extraction",
            "matches_preserved_extraction": True, "verified_on_original": False,
        })
        forwarded = self.gate.received()[-1]
        self.assertEqual(forwarded["name"], "provenance.verify_derived")
        self.assertFalse(forwarded["arguments"]["full"])

    def test_derived_citation_results_are_sanitized(self) -> None:
        expected_failure = {
            "ok": False, "check": "preserved_extraction",
            "matches_preserved_extraction": False, "verified_on_original": False,
            "error": "SpanMismatch", "message": "The quoted span does not match the preserved extraction.",
        }
        for request_id, fixture, expected in (
            (150, "listed_error", expected_failure),
            (156, "locator_range", {
                "ok": False, "check": "preserved_extraction", "matches_preserved_extraction": False,
                "verified_on_original": False, "error": "LocatorOutOfRange",
                "message": "The citation locator is outside the preserved extraction.",
            }),
            (157, "locator_grapheme", {
                "ok": False, "check": "preserved_extraction", "matches_preserved_extraction": False,
                "verified_on_original": False, "error": "LocatorSplitsGrapheme",
                "message": "The citation locator splits a character in the preserved extraction.",
            }),
            (151, "unknown_error", {
                "ok": False, "check": "preserved_extraction",
                "matches_preserved_extraction": False, "verified_on_original": False,
                "error": "VerificationFailed", "message": "The citation could not be checked against the preserved extraction.",
            }),
            (152, "malformed", {
                "ok": False, "check": "preserved_extraction",
                "matches_preserved_extraction": False, "verified_on_original": False,
                "error": "VerificationFailed", "message": "The citation could not be checked against the preserved extraction.",
            }),
        ):
            self.gate.send(self.call(request_id, "provenance_verify_derived", {
                "citation": {"span": "x", "fixture": fixture},
            }))
            response = self.gate.response(request_id)
            text = response["result"]["content"][0]["text"]
            self.assertEqual(json.loads(text), expected)
            self.assertNotIn("private-sentinel-x", text)
            self.assertNotIn("private", text)
        for request_id, fixture, expected in (
            (153, "rpc_argument_error", "InvalidDerivedCitation: the citation is not a valid derived citation"),
            (154, "rpc_other_error", "VerificationFailed: the citation could not be checked"),
        ):
            self.gate.send(self.call(request_id, "provenance_verify_derived", {
                "citation": {"fixture": fixture},
            }))
            error = self.gate.response(request_id)["error"]
            self.assertEqual(error["message"], expected)
            self.assertNotIn("private-sentinel-x", error["message"])
            self.assertNotIn("data", error)
            self.assertNotIn("private-sentinel-x", json.dumps(error))

    def test_derived_responses_rebuild_clean_envelopes(self) -> None:
        for request_id, fixture in ((158, "private_success"), (159, "private_rpc_error"), (161, "private_both")):
            self.gate.send(self.call(request_id, "provenance_verify_derived", {
                "citation": {"span": "x", "fixture": fixture},
            }))
            response = self.gate.response(request_id)
            is_error = fixture in ("private_rpc_error", "private_both")
            self.assertEqual(set(response), {"jsonrpc", "id", "error"} if is_error else {"jsonrpc", "id", "result"})
            self.assertEqual(response["id"], request_id)
            self.assertNotIn("private-sentinel-x", json.dumps(response))

    def test_malformed_child_lines_and_notifications_are_dropped(self) -> None:
        self.gate.send(self.call(160, "knowledge_search", {"query": "q", "noise": True}))
        response = self.gate.response(160)
        self.assertEqual(response["result"]["received"]["query"], "q")
        self.assertNotIn("private-sentinel-x", json.dumps(response))
        logs = self.gate.log_text()
        self.assertIn('"decision":"drop_malformed_child"', logs)
        self.assertIn('"decision":"drop_child_notification"', logs)

    def test_unrelated_tool_result_is_unchanged(self) -> None:
        self.gate.send(self.call(155, "knowledge_search", {"query": "q"}))
        self.assertEqual(self.gate.response(155)["result"]["received"], {"query": "q"})

    def test_candidate_search_rejects_replaced_invalid_query_and_ranking(self) -> None:
        for request_id, arguments in enumerate((
            {"query": "q", "include_replaced": None},
            {"query": "q", "include_replaced": "yes"},
            {"query": "q", "include_replaced": 1},
            {"query": "q", "include_replaced": 1.0},
            {"query": "q", "include_replaced": []},
            {"query": "q", "include_replaced": {}},
            {"query": "q" * 257},
            {"query": " "},
            {"query": "q", "ranking": "unknown"},
            {"query": "q", "limit": None},
            {"query": "q", "limit": 0},
        ), start=74):
            self.gate.send(self.call(request_id, "candidate_search", arguments))
            response = self.gate.response(request_id)
            self.assertEqual(response["error"]["code"], -32602)
            if "include_replaced" in arguments:
                self.assertIn("invalid include_replaced", response["error"]["message"])
        self.assertEqual(self.gate.received(), [])

    def test_candidate_search_forwards_replaced_hit_unchanged_when_requested(self) -> None:
        response_payload = {
            "hits": [{
                "candidate_id": "cand_123",
                "replaced": True,
                "superseded_by": "cand_456",
                "proposed_at": "2025-03-04T12:30:00Z",
                "valid_from": "2025-03-01",
            }],
            "replaced_excluded": 0,
        }
        self.gate.send(self.call(130, "candidate_search", {
            "query": "q", "include_replaced": True,
            "candidate_hit": response_payload,
        }))
        self.assertEqual(self.gate.response(130)["result"], response_payload)
        self.assertEqual(len(self.gate.received()), 1)
        self.assertEqual(self.gate.received()[0]["name"], "candidate.search")

    def test_candidate_search_forwards_cursor_unchanged_with_include_replaced(self) -> None:
        cursor = {"opaque": "cursor-7", "position": 7}
        for request_id, include_replaced in ((131, True), (132, False)):
            arguments = {
                "query": "q", "cursor": cursor,
                "include_replaced": include_replaced,
            }
            self.gate.send(self.call(request_id, "candidate_search", arguments))
            received = self.gate.response(request_id)["result"]["received"]
            self.assertEqual(received["cursor"], cursor)
            self.assertIs(received["include_replaced"], include_replaced)
        self.assertEqual(
            [item["name"] for item in self.gate.received()],
            ["candidate.search", "candidate.search"],
        )

    def test_relations_forward_and_refuse_unbounded_arguments(self) -> None:
        source_id = "src_" + "A" * 26
        valid = {"source_id": source_id, "relation_class": "related"}
        self.gate.send(self.call(90, "reconcile_relations", valid))
        self.assertEqual(self.gate.response(90)["result"]["received"], valid)
        invalid = [
            None, [], {}, {"source_id": 3}, {"source_id": "bad"},
            {"source_id": source_id, "relation_class": "bad"},
            {"source_id": source_id, "extra": True},
        ]
        for request_id, arguments in enumerate(invalid, start=91):
            self.gate.send(self.call(request_id, "reconcile_relations", arguments))
            self.assertEqual(self.gate.response(request_id)["error"]["code"], -32602)
        self.assertEqual(
            [item["name"] for item in self.gate.received()], ["reconcile.relations"]
        )

    def test_other_candidate_tools_remain_unpublished(self) -> None:
        for request_id, name in enumerate((
            "candidate_discover", "candidate.adjudicate", "candidate_proposals",
            "candidate_propose", "candidate.propose", "reconcile_propose",
            "reconcile.verify",
        ), start=80):
            self.gate.send(self.call(request_id, name, {}))
            self.assertIn("NotExposed", self.gate.response(request_id)["error"]["message"])
        self.assertEqual(self.gate.received(), [])

    def test_alias_and_dotted_spelling_forward_product_name(self) -> None:
        meta = {"opaque": "preserved"}
        self.gate.send(self.call(2, "knowledge_search", {"query": "SENTINEL_QUERY", "limit": 50}, meta))
        self.assertEqual(self.gate.response(2)["result"]["received"]["limit"], 20)
        self.gate.send(self.call(3, "knowledge.search", {"query": "q"}))
        self.gate.response(3)
        names = [item["name"] for item in self.gate.received()]
        self.assertEqual(names[-2:], ["knowledge.search", "knowledge.search"])
        self.assertEqual(self.gate.received()[-2]["meta"], meta)
        self.assertNotIn("SENTINEL_QUERY", self.gate.log_text())

    def test_explicit_small_search_limits_are_forwarded_unchanged(self) -> None:
        for request_id, name in (
            (201, "knowledge_search"), (202, "knowledge_semantic"), (203, "candidate_search"),
        ):
            self.gate.send(self.call(request_id, name, {"query": "q", "limit": 2}))
            self.assertEqual(self.gate.response(request_id)["result"]["received"]["limit"], 2)
        records = [json.loads(line) for line in self.gate.log_text().splitlines()]
        forwarded = [
            item for item in records
            if item.get("decision") == "forward" and item.get("event") == "request"
        ]
        self.assertEqual([item["tool"] for item in forwarded[-3:]], [
            "knowledge.search", "knowledge.semantic", "candidate.search",
        ])

    def test_unknown_alias_is_never_forwarded(self) -> None:
        self.gate.send(self.call(4, "candidate_proposals", {}))
        response = self.gate.response(4)
        self.assertEqual(response["error"]["code"], -32000)
        self.assertIn("NotExposed", response["error"]["message"])
        self.assertNotIn("candidate_proposals", [item["name"] for item in self.gate.received()])

    def test_candidate_propose_alias_and_dotted_name_are_hidden(self) -> None:
        before = self.gate.received()
        for request_id, name in ((5, "candidate_propose"), (6, "candidate.propose")):
            self.gate.send(self.call(request_id, name, {"content": "probe"}))
            response = self.gate.response(request_id)
            self.assertEqual(response["error"]["code"], -32000)
            self.assertIn("NotExposed", response["error"]["message"])
            self.assertEqual(self.gate.received(), before)

    def test_caps_ping_and_protocol_refusals(self) -> None:
        self.gate.send(self.call(6, "knowledge_semantic", {"query": "q"}))
        self.assertEqual(self.gate.response(6)["result"]["received"]["limit"], 10)
        self.gate.send(self.call(7, "knowledge_context", {"before": 9, "after": 6}))
        self.assertEqual(
            self.gate.response(7)["result"]["received"],
            {"before": 5, "after": 5, "limit": 30, "view": "text"},
        )
        self.gate.send({"jsonrpc": "2.0", "id": 8, "method": "ping"})
        self.assertEqual(self.gate.response(8)["result"], {})
        self.gate.send([])
        self.assertEqual(self.gate.response(None)["error"]["code"], -32600)
        self.gate.send('{"jsonrpc":"2.0","id":9,"method":"x","params":{"n":NaN}}')
        self.assertEqual(self.gate.response(None)["error"]["code"], -32700)
        self.gate.send({"jsonrpc": "2.0", "id": 10, "method": "unknown"})
        self.assertEqual(self.gate.response(10)["error"]["code"], -32601)

    def test_context_options_caps_and_refusals(self) -> None:
        self.gate.send(self.call(110, "knowledge_context", {"before": 2}))
        defaulted = self.gate.response(110)["result"]["received"]
        self.assertEqual(defaulted["view"], "text")
        self.assertTrue(any(
            row.get("decision") == "capped"
            for row in map(json.loads, self.gate.log_text().splitlines())
        ))

        full = {"view": "full", "before": 1}
        self.gate.send(self.call(111, "knowledge_context", full))
        full_received = self.gate.response(111)["result"]["received"]
        self.assertEqual(full_received["view"], "full")
        self.assertEqual(full_received["before"], 1)
        self.assertNotIn("max_chars", full_received)

        self.gate.send(self.call(112, "knowledge_context", {
            "view": "text", "max_chars": 9000,
        }))
        self.assertEqual(
            self.gate.response(112)["result"]["received"]["max_chars"], 8000,
        )
        log_rows = list(map(json.loads, self.gate.log_text().splitlines()))
        self.assertTrue(any(
            row.get("tool") == "knowledge.context"
            and row.get("decision") == "capped"
            and "max_chars" in row.get("arg_keys", [])
            for row in log_rows
        ))

        self.gate.send(self.call(121, "knowledge_context", {"offset": 37, "limit": 40}))
        paged = self.gate.response(121)["result"]["received"]
        self.assertEqual(paged["offset"], 37)
        self.assertEqual(paged["limit"], 30)

        for request_id, offset in enumerate((-1, True, "2", 1.5, None, [], {}), start=122):
            self.gate.send(self.call(request_id, "knowledge_context", {"offset": offset}))
            self.assertEqual(self.gate.response(request_id)["error"]["code"], -32602)

        invalid = [
            ("knowledge_search", {"role": "system"}),
            ("knowledge_context", {"view": "raw"}),
            ("knowledge_context", {"max_chars": "x"}),
            ("knowledge_context", {"max_chars": 100}),
            ("knowledge_context", {"max_chars": True}),
            ("knowledge_context", {"view": "full", "max_chars": 200}),
            ("candidate_search", {"query": "q", "ranking": "bogus"}),
        ]
        first_id = 113
        for request_id, (name, arguments) in enumerate(invalid, start=first_id):
            self.gate.send(self.call(request_id, name, arguments))
            self.assertEqual(self.gate.response(request_id)["error"]["code"], -32602)

        self.gate.send(self.call(120, "candidate_search", {
            "query": "q", "ranking": "source_semantic",
        }))
        self.assertEqual(
            self.gate.response(120)["result"]["received"]["ranking"], "source_semantic",
        )
        self.assertEqual(
            [item["name"] for item in self.gate.received()],
            ["knowledge.context", "knowledge.context", "knowledge.context", "knowledge.context", "candidate.search"],
        )

    def test_notifications_only_and_notification_call_is_dropped(self) -> None:
        self.gate.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        self.gate.send({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "candidate.proposals", "arguments": {}},
        })
        self.gate.send({"jsonrpc": "2.0", "id": 90, "method": "tools/list"})
        self.gate.response(90)
        methods = [item["method"] for item in self.gate.received()]
        self.assertIn("notifications/initialized", methods)
        self.assertEqual(methods.count("tools/call"), 0)
        with self.assertRaises(AssertionError):
            self.gate.response(None, timeout=0.1)

    def test_alias_without_caps_still_forwards_product_name(self) -> None:
        self.gate.send(self.call(20, "canon_assertions", {}))
        self.gate.response(20)
        self.gate.send(self.call(21, "provenance_span", {"citation": {"source_id": "s"}}))
        self.gate.response(21)
        self.gate.send(self.call(22, "knowledge_search", {"query": "q"}))
        self.gate.response(22)
        self.assertEqual(
            [item["name"] for item in self.gate.received()][-3:],
            ["canon.assertions", "provenance.span", "knowledge.search"],
        )

    def test_duplicate_in_flight_id_is_refused_and_not_forwarded(self) -> None:
        self.gate.send(self.call(30, "knowledge_search", {"query": "q", "slow": True}))
        self.gate.send(self.call(30, "canon_assertions", {}))
        first = self.gate.response(30)
        self.assertEqual(first["error"]["code"], -32600)
        self.assertIn("duplicate", first["error"]["message"])
        self.assertIn("received", self.gate.response(30)["result"])
        names = [item["name"] for item in self.gate.received()]
        self.assertNotIn("canon.assertions", names)

    def test_child_never_inherits_the_runtime_key(self) -> None:
        self.gate.send(self.call(50, "knowledge_search", {"query": "q", "envcheck": True}))
        result = self.gate.response(50)["result"]
        self.assertEqual(result["secret_env_seen"], [])
        self.assertEqual(result["tiers"], "read")

    def test_list_shaped_result_is_filtered_even_for_a_tools_call(self) -> None:
        self.gate.send(self.call(40, "knowledge_search", {"query": "q", "listshaped": True}))
        tools = self.gate.response(40)["result"]["tools"]
        self.assertEqual(
            [tool["name"] for tool in tools],
            [
                "knowledge_search", "knowledge_semantic", "knowledge_context",
                "provenance_span", "provenance_verify_derived", "canon_assertions", "candidate_search",
                "reconcile_relations",
            ],
        )

    def test_oversize_and_concurrent_ids(self) -> None:
        self.gate.send(self.call(11, "knowledge_search", {"oversize": True}))
        self.assertIn("ResponseTooLarge", self.gate.response(11)["error"]["message"])
        for request_id in (12, 13, 14):
            self.gate.send(self.call(request_id, "knowledge_search", {"delay": True}))
        self.assertEqual(
            {self.gate.response(request_id)["id"] for request_id in (12, 13, 14)},
            {12, 13, 14},
        )

    def test_child_exit_answers_pending_then_gate_exits_one(self) -> None:
        self.gate.send(self.call(15, "knowledge_search", {"exit": True}))
        response = self.gate.response(15)
        self.assertEqual(response["error"]["code"], -32000)
        self.assertIn("ChildExited", response["error"]["message"])
        self.assertEqual(self.gate.proc.wait(timeout=2), 1)

    def test_sigterm_exits_zero_and_reaps_child(self) -> None:
        until = time.monotonic() + 2
        while not self.gate.pid_file.exists() and time.monotonic() < until:
            time.sleep(0.01)
        child_pid = int(self.gate.pid_file.read_text())
        self.gate.proc.terminate()
        self.assertEqual(self.gate.proc.wait(timeout=2), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)

    def test_orderly_stdin_close_exits_zero_without_child_error(self) -> None:
        self.gate.close_stdin()
        self.assertEqual(self.gate.proc.wait(timeout=2), 0)
        with self.assertRaises(queue.Empty):
            self.gate.responses.get_nowait()

    def test_h1_object_id_is_refused_before_sorted_child_response(self) -> None:
        self.gate.send(
            b'{"jsonrpc":"2.0","id":{"z":1,"a":2},"method":"tools/call",'
            b'"params":{"name":"knowledge_search","arguments":{"oversize":true}}}'
        )
        response = self.gate.response(None)
        self.assertEqual(response["error"]["code"], -32600)
        self.assertEqual(response["error"]["message"], "invalid request id")
        self.assertEqual(self.gate.received(), [])

    def test_h1_long_id_does_not_expand_ping_response(self) -> None:
        self.gate.send(
            b'{"jsonrpc":"2.0","id":"' + b"A" * 400001 + b'","method":"ping"}'
        )
        response = self.gate.response(None)
        self.assertEqual(response["error"]["code"], -32600)
        self.assertEqual(response["error"]["message"], "request too large")
        with self.gate.line_lock:
            self.assertLess(max(self.gate.line_sizes), 1000)

    def test_h2_overlong_line_is_refused_and_not_forwarded(self) -> None:
        self.gate.send(b"{" + b"x" * (MAX_REQUEST_BYTES + 1) + b"}")
        response = self.gate.response(None)
        self.assertEqual(response["error"], {
            "code": -32600,
            "message": "request too large",
        })
        self.assertEqual(self.gate.received(), [])

    def test_h3_withholds_unsafe_method_and_tool_text(self) -> None:
        unsafe = "PRIVATE NOTE/" * 20
        self.gate.send({
            "jsonrpc": "2.0",
            "id": 61,
            "method": unsafe,
        })
        unknown = self.gate.response(61)
        self.assertIn("<name withheld>", unknown["error"]["message"])
        self.assertNotIn(unsafe, unknown["error"]["message"])

        self.gate.send(self.call(62, unsafe, {}))
        hidden = self.gate.response(62)
        self.assertIn("<name withheld>", hidden["error"]["message"])
        self.assertNotIn(unsafe, hidden["error"]["message"])

    def test_h4_log_contains_no_caller_text(self) -> None:
        self.gate.send({"jsonrpc": "2.0", "id": "PRIVATE_NOTE", "method": "ping"})
        self.gate.response("PRIVATE_NOTE")
        self.gate.send({"jsonrpc": "2.0", "id": 63, "method": "PRIVATE_NOTE"})
        self.gate.response(63)
        self.gate.send(self.call(
            64,
            "knowledge_search",
            {"query": "q", "PRIVATE_NOTE": 1},
        ))
        self.gate.response(64)

        log = self.gate.log_text()
        self.assertNotIn("PRIVATE_NOTE", log)
        records = [json.loads(line) for line in log.splitlines()]
        self.assertTrue(all("id" not in item for item in records))
        self.assertTrue(all("id_hash" in item for item in records))
        self.assertTrue(all(item["profile"] == "chatgpt-read-min-v3" for item in records))
        request = next(item for item in records if item["decision"] == "forward")
        self.assertEqual(request["arg_keys"], ["query"])
        self.assertEqual(request["other_arg_keys"], 1)

    def test_h5_lone_surrogate_is_parse_error_and_gate_remains_live(self) -> None:
        self.gate.send(b'{"jsonrpc":"2.0","id":"\\ud800","method":"ping"}')
        response = self.gate.response(None)
        self.assertEqual(response["error"]["code"], -32700)
        self.gate.send({"jsonrpc": "2.0", "id": 65, "method": "ping"})
        self.assertEqual(self.gate.response(65)["result"], {})
        self.assertIsNone(self.gate.proc.poll())

    def test_h6_wide_provenance_span_is_not_forwarded(self) -> None:
        self.gate.send(self.call(
            66,
            "provenance_span",
            {"citation": {"start_byte": 0, "end_byte": 32769}},
        ))
        response = self.gate.response(66)
        self.assertEqual(response["error"], {
            "code": -32000,
            "message": "SpanTooWide: a citation may cover at most 32768 bytes through this connector",
        })
        self.assertNotIn("provenance.span", [item["name"] for item in self.gate.received()])


    def test_gate_limits_reports_reductions_and_continuation(self) -> None:
        hits = [{"source_id": str(index)} for index in range(20)]
        self.gate.send(self.call(1, "knowledge_search", {
            "query": "x", "limit": 50, "candidate_hit": _content(hits)}))
        result = self.gate.response(1)["result"]
        self.assertEqual(json.loads(result["content"][0]["text"]), hits)
        notice = json.loads(result["content"][1]["text"])["gate_limits"]
        self.assertEqual(notice["applied"], {"limit": 20})
        self.assertEqual(notice["reduced"], {"limit": {"requested": 50, "applied": 20}})
        self.assertEqual(notice["maximum"], {"limit": 20})
        self.assertIn("more matches may exist", notice["continuation"])
        self.assertIn("no next page", notice["continuation"])
        self.assertNotIn("higher limit", notice["continuation"])
        self.gate.send(self.call(9, "knowledge_search", {
            "query": "x", "limit": 3, "candidate_hit": _content(hits[:3])}))
        notice = json.loads(self.gate.response(9)["result"]["content"][1]["text"])["gate_limits"]
        self.assertEqual(notice["reduced"], {})
        self.assertIn("A higher limit, up to the maximum", notice["continuation"])

        page = {"hits": [], "next_cursor": "c1"}
        self.gate.send(self.call(2, "candidate_search", {"query": "x", "candidate_hit": _content(page)}))
        result = self.gate.response(2)["result"]
        notice = json.loads(result["content"][1]["text"])["gate_limits"]
        self.assertEqual(notice["applied"], {"limit": 10})
        self.assertEqual(notice["reduced"], {})
        self.assertIn("cursor set to next_cursor", notice["continuation"])

        context = {"records": [], "has_more": True, "next_offset": 30}
        self.gate.send(self.call(3, "knowledge_context", {
            "source_id": "s", "before": 9, "after": 2, "max_chars": 9000,
            "candidate_hit": _content(context)}))
        notice = json.loads(self.gate.response(3)["result"]["content"][1]["text"])["gate_limits"]
        self.assertEqual(notice["reduced"], {
            "before": {"requested": 9, "applied": 5},
            "max_chars": {"requested": 9000, "applied": 8000},
        })
        self.assertIn("before and after are capped", notice["continuation"])
        self.assertIn("use view full", notice["continuation"])

        self.gate.send(self.call(4, "knowledge_context", {
            "container": "c", "limit": 99, "candidate_hit": _content(context)}))
        notice = json.loads(self.gate.response(4)["result"]["content"][1]["text"])["gate_limits"]
        self.assertIn("offset=next_offset only if", notice["continuation"])

    def test_gate_limits_absent_when_nothing_to_report(self) -> None:
        self.gate.send(self.call(1, "knowledge_search", {
            "query": "x", "candidate_hit": _content([{"source_id": "a"}])}))
        self.assertEqual(len(self.gate.response(1)["result"]["content"]), 1)
        self.gate.send(self.call(2, "candidate_search", {
            "query": "x", "candidate_hit": _content({"hits": [], "next_cursor": None})}))
        self.assertEqual(len(self.gate.response(2)["result"]["content"]), 1)
        self.gate.send(self.call(3, "knowledge_semantic", {
            "query": "x", "limit": 3, "candidate_hit": _content({"hits": [{}] * 2})}))
        self.assertEqual(len(self.gate.response(3)["result"]["content"]), 1)
        self.gate.send(self.call(4, "knowledge_search", {
            "query": "x", "limit": 50, "candidate_hit": {"content": [{"type": "text", "text": "not json"}]}}))
        self.assertEqual(len(self.gate.response(4)["result"]["content"]), 1)
        self.gate.send(self.call(5, "knowledge_search", {
            "query": "x", "limit": 50, "candidate_hit": {"isError": True, **_content({"e": 1})}}))
        self.assertEqual(len(self.gate.response(5)["result"]["content"]), 1)
        self.gate.send(self.call(6, "provenance_span", {"citation": {}, "candidate_hit": _content({"ok": 1})}))
        self.assertEqual(len(self.gate.response(6)["result"]["content"]), 1)

    def test_gate_limits_never_exceeds_the_response_bound_or_touches_errors(self) -> None:
        self.gate.send(self.call(1, "knowledge_search", {
            "query": "x", "limit": 20, "bulk": [20, 19_970]}))
        error = self.gate.response(1, timeout=5)["error"]
        self.assertEqual(error["code"], -32000)
        self.assertTrue(error["message"].startswith("ResponseTooLarge: "))
        self.gate.send(self.call(3, "knowledge_search", {
            "query": "x", "limit": 20, "bulk": [20, 19_950]}))
        result = self.gate.response(3, timeout=5)["result"]
        self.assertEqual(len(result["content"]), 2)
        self.gate.send(self.call(2, "knowledge_semantic", {
            "query": "x", "limit": 2, "candidate_hit": _content({"hits": [{}] * 3})}))
        self.assertEqual(len(self.gate.response(2)["result"]["content"]), 1)

    def test_wording_on_pasted_text_unreadable_versions_and_limits(self) -> None:
        self.gate.send({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        tools = {tool["name"]: tool["description"] for tool in self.gate.response(1)["result"]["tools"]}
        for name in ("knowledge_search", "knowledge_semantic"):
            self.assertIn("may contain pasted or quoted text written by others", tools[name])
        self.assertIn("replaced_unreadable is a store-wide count", tools["candidate_search"])
        self.assertIn("does not hide current proposals", tools["candidate_search"])
        for name in ("knowledge_search", "knowledge_semantic", "knowledge_context", "candidate_search"):
            self.assertIn("gate_limits item", tools[name])
        for name in ("provenance_span", "provenance_verify_derived", "canon_assertions", "reconcile_relations"):
            self.assertNotIn("gate_limits", tools[name])

    def test_known_input_errors_become_is_error_results(self) -> None:
        context_messages = [
            "before must be a non-negative integer",
            "after must be a non-negative integer",
            "limit must be a positive integer",
            "context requires exactly one of source_id or container",
            "offset is only valid with container",
            "offset must be a non-negative integer",
            "view must be 'full' or 'text'",
            "max_chars is only valid with view='text'",
            "max_chars must be an integer from 200 to 20000",
        ]
        cases = [
            ("knowledge_search", "QueryError: the query has no searchable words", "QueryError"),
            *[("knowledge_context", "QueryError: " + message, "QueryError") for message in context_messages],
            ("candidate_search", "CandidateSearchError: InvalidQuery", "InvalidQuery"),
            ("candidate_search", "CandidateSearchError: InvalidCursor", "InvalidCursor"),
            ("candidate_search", "CandidateSearchError: QueryTooComplex", "QueryTooComplex"),
        ]
        for index, (tool, message, error_type) in enumerate(cases, start=1):
            self.gate.send(self.call(index, tool, {"query": "x", "child_error": [-32000, message]}))
            response = self.gate.response(index)
            self.assertNotIn("error", response)
            self.assertIs(response["result"]["isError"], True)
            self.assertEqual(len(response["result"]["content"]), 1)
            body = json.loads(response["result"]["content"][0]["text"])
            self.assertEqual(body["error"], error_type)
            self.assertEqual(sorted(body), ["error", "message"])
            self.assertNotIn("/", body["message"])
        self.assertIn('"decision":"input_error"', self.gate.log_text())

    def test_other_errors_keep_their_json_rpc_form(self) -> None:
        cases = [
            ("knowledge_search", -32000, "QueryError: the query could not be run: database is locked"),
            ("knowledge_search", -32000, "StoreUnusable: the store could not be read: disk I/O error"),
            ("candidate_search", -32000, "CandidateSearchError: CandidateStoreUnreadable"),
            ("candidate_search", -32000, "QueryError: the query has no searchable words"),
            ("knowledge_search", -32000, "CandidateSearchError: InvalidQuery"),
            ("knowledge_search", -32602, "QueryError: the query has no searchable words"),
            ("candidate_search", -32000, "CandidateSearchError: InvalidQuery: extra"),
            ("candidate_search", -32000, " CandidateSearchError: InvalidQuery"),
            ("knowledge_semantic", -32000, "QueryError: the query has no searchable words"),
            ("provenance_span", -32000, "QueryError: the query has no searchable words"),
            ("knowledge_search", -32000.0, "QueryError: the query has no searchable words"),
            ("knowledge_search", True, "QueryError: the query has no searchable words"),
            ("knowledge_search", -32000, 123),
            ("knowledge_search", -32000, None),
        ]
        for index, (tool, code, message) in enumerate(cases, start=1):
            self.gate.send(self.call(index, tool, {"query": "x", "citation": {}, "child_error": [code, message]}))
            response = self.gate.response(index)
            self.assertEqual(response["error"], {"code": code, "message": message})
            self.assertNotIn("result", response)
        self.gate.send(self.call(99, "knowledge_search", {
            "query": "x", "child_error": [-32000, "QueryError: the query has no searchable words", "with_result"]}))
        self.assertNotIn("isError", json.dumps(self.gate.response(99)))

    def test_tools_list_digest_is_logged(self) -> None:
        import hashlib
        self.gate.send({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        result = self.gate.response(1)["result"]
        expected = hashlib.sha256(
            json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:16]
        lines = [json.loads(line) for line in self.gate.log_text().splitlines()]
        listed = [line for line in lines if line["method"] == "tools/list" and line["event"] == "response"]
        self.assertEqual([line.get("resp_digest") for line in listed], [expected])
        calls = [line for line in lines if line["method"] != "tools/list"]
        self.assertTrue(all("resp_digest" not in line for line in calls))

if __name__ == "__main__":
    unittest.main()
