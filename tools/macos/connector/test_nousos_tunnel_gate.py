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
    "provenance.document", "provenance.source", "canon.decisions",
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
            "meta": request.get("params", {{}}).get("_meta"),
        }}) + "\n")
    if "id" not in request:
        continue
    request_id = request["id"]
    method = request.get("method")
    if method == "initialize":
        emit({{"jsonrpc":"2.0","id":request_id,"result":{{"protocolVersion":"2024-11-05"}}}})
    elif method == "tools/list":
        emit({{"jsonrpc":"2.0","id":request_id,"result":{{"tools":[
            {{"name":name,"description":"fake","inputSchema":{{"type":"object","properties":{{
                "limit":{{"type":"integer"}},"before":{{"type":"integer"}},"after":{{"type":"integer"}},
                "query":{{"type":"string"}},"include_replaced":{{"type":"boolean"}},
                "ranking":{{"type":"string"}}
            }}}}}} for name in names
        ]}}}})
    elif method == "tools/call":
        params = request.get("params", {{}})
        arguments = params.get("arguments", {{}})
        if arguments.get("exit"):
            sys.exit(0)
        if arguments.get("oversize"):
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"content":[{{"type":"text","text":"x"*410000}}]}}}})
        elif arguments.get("envcheck"):
            seen = sorted(k for k in ("CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY") if k in os.environ)
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"secret_env_seen":seen,"tiers":os.environ.get("NOUS_OS_STDIO_TIERS")}}}})
        elif arguments.get("listshaped"):
            emit({{"jsonrpc":"2.0","id":request_id,"result":{{"tools":[{{"name":name}} for name in names]}}}})
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
                "provenance_span", "canon_assertions", "candidate_search",
            ],
        )
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in tools))
        self.assertEqual(tools[0]["inputSchema"]["properties"]["limit"]["maximum"], 20)
        self.assertEqual(tools[1]["inputSchema"]["properties"]["limit"]["maximum"], 10)
        self.assertEqual(tools[2]["inputSchema"]["properties"]["limit"]["maximum"], 30)
        candidate = tools[5]
        schema = candidate["inputSchema"]
        self.assertEqual(schema["properties"]["limit"]["maximum"], 10)
        self.assertEqual(schema["properties"]["limit"]["default"], 10)
        self.assertEqual(schema["properties"]["query"]["maxLength"], 256)
        self.assertEqual(schema["properties"]["include_replaced"]["enum"], [False])
        self.assertEqual(schema["properties"]["ranking"]["enum"], ["text", "text_relevance"])
        self.assertIn("query", schema["required"])
        self.assertIn("recorded proposal, not a decision", candidate["description"])
        self.assertIn("canonical_status and epistemic_label", candidate["description"])

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
        self.gate.send(self.call(72, "candidate.search", {"query": "q", "ranking": "text"}))
        self.assertEqual(self.gate.response(72)["result"]["received"]["ranking"], "text")
        self.assertEqual([item["name"] for item in self.gate.received()], [
            "candidate.search", "candidate.search", "candidate.search",
        ])
        self.assertNotIn("PRIVATE_SEARCH_QUERY", self.gate.log_text())

    def test_candidate_search_rejects_replaced_invalid_query_and_ranking(self) -> None:
        for request_id, arguments in enumerate((
            {"query": "q", "include_replaced": True},
            {"query": "q", "include_replaced": None},
            {"query": "q" * 257},
            {"query": " "},
            {"query": "q", "ranking": "unknown"},
            {"query": "q", "limit": None},
            {"query": "q", "limit": 0},
        ), start=73):
            self.gate.send(self.call(request_id, "candidate_search", arguments))
            self.assertEqual(self.gate.response(request_id)["error"]["code"], -32602)
        self.assertEqual(self.gate.received(), [])

    def test_other_candidate_tools_remain_unpublished(self) -> None:
        for request_id, name in enumerate((
            "candidate_discover", "candidate.adjudicate", "candidate_proposals",
            "candidate_propose", "candidate.propose",
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
            {"before": 5, "after": 5, "limit": 30},
        )
        self.gate.send({"jsonrpc": "2.0", "id": 8, "method": "ping"})
        self.assertEqual(self.gate.response(8)["result"], {})
        self.gate.send([])
        self.assertEqual(self.gate.response(None)["error"]["code"], -32600)
        self.gate.send('{"jsonrpc":"2.0","id":9,"method":"x","params":{"n":NaN}}')
        self.assertEqual(self.gate.response(None)["error"]["code"], -32700)
        self.gate.send({"jsonrpc": "2.0", "id": 10, "method": "unknown"})
        self.assertEqual(self.gate.response(10)["error"]["code"], -32601)

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
                "provenance_span", "canon_assertions", "candidate_search",
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


if __name__ == "__main__":
    unittest.main()
