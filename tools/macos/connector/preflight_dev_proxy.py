#!/usr/bin/env python3
"""Loopback-only NousOS tunnel gate preflight."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
GATE = HERE / "nousos_tunnel_gate.py"

EXPECTED_TOOLS = [
    "knowledge_search",
    "knowledge_semantic",
    "knowledge_context",
    "provenance_span",
    "canon_assertions",
    "candidate_search",
    "reconcile_relations",
]


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def decode_response(body: bytes) -> Any:
    if not body.strip():
        return {}
    text = body.decode("utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        raise


def error_fact(response: Any) -> str:
    if not isinstance(response, dict):
        return "non_object"
    error = response.get("error")
    if not isinstance(error, dict):
        return "result"
    code = error.get("code")
    message = error.get("message")
    name = message.split(":", 1)[0] if isinstance(message, str) else "error"
    return f"error_code={code} class={name}"


def tool_payload(response: dict[str, Any]) -> Any:
    content = response.get("result", {}).get("content", [])
    if not isinstance(content, list) or not content:
        raise ValueError("missing tool content")
    first = content[0]
    if not isinstance(first, dict) or not isinstance(first.get("text"), str):
        raise ValueError("missing tool text")
    return json.loads(first["text"])


class McpClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self.session: str | None = None

    def post(
        self,
        request: dict[str, Any],
        protocol_version: str = "2025-06-18",
    ) -> tuple[dict[str, Any], int]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": protocol_version,
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        outgoing = urllib.request.Request(
            self.url,
            data=json.dumps(request, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(outgoing, timeout=35) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session = session
                decoded = decode_response(response.read())
                return decoded if isinstance(decoded, dict) else {}, response.status
        except urllib.error.HTTPError as exc:
            session = exc.headers.get("Mcp-Session-Id")
            if session:
                self.session = session
            decoded = decode_response(exc.read())
            return decoded if isinstance(decoded, dict) else {}, exc.code


def tool_call(
    client: McpClient,
    request_id: int,
    name: str,
    arguments: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    return client.post({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    })


def server_write_refusal() -> tuple[bool, str]:
    requests = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "nousos-preflight", "version": "1"},
            },
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "candidate.propose",
                "arguments": {
                    "source_id": "src_PREFLIGHT",
                    "content": "probe",
                    "proposed_at": "2026-09-25T00:00:00Z",
                    "holder": "preflight",
                },
            },
        },
    ]
    incoming = b"".join(
        json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
        for request in requests
    )
    try:
        with subprocess.Popen(
            [os.environ.get("NOUSOS_GATE_CHILD", "")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ) as server:
            try:
                outgoing, _ = server.communicate(input=incoming, timeout=35)
            except subprocess.TimeoutExpired:
                server.kill()
                server.communicate()
                return False, "timeout"
            return_code = server.returncode
    except (OSError, subprocess.SubprocessError) as exc:
        return False, exc.__class__.__name__

    try:
        responses = [json.loads(line) for line in outgoing.splitlines() if line.strip()]
    except (UnicodeDecodeError, ValueError):
        return False, "invalid_json"

    initialized = responses[0] if len(responses) > 0 and isinstance(responses[0], dict) else {}
    refused = responses[1] if len(responses) > 1 and isinstance(responses[1], dict) else {}
    error = refused.get("error")
    message = error.get("message") if isinstance(error, dict) else None
    ok = (
        return_code == 0
        and len(responses) == 2
        and initialized.get("id") == 1
        and "result" in initialized
        and refused.get("id") == 2
        and isinstance(message, str)
        and "NotAuthorized" in message
    )
    observed = (
        f"exit={return_code} responses={len(responses)} "
        f"initialize={'result' in initialized} {error_fact(refused)}"
    )
    return ok, observed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-semantic", action="store_true")
    parser.add_argument(
        "--tunnel-client",
        default=os.environ.get("NOUSOS_TUNNEL_CLIENT") or shutil.which("tunnel-client"),
    )
    parser.add_argument(
        "--proposals",
        default=os.environ.get("NOUSOS_PROPOSALS"),
    )
    args = parser.parse_args()
    if not args.tunnel_client:
        parser.error("set NOUSOS_TUNNEL_CLIENT or put tunnel-client on PATH")
    if not args.proposals:
        parser.error("set NOUSOS_PROPOSALS to the proposals file")
    child = os.environ.get("NOUSOS_GATE_CHILD")
    if not child:
        parser.error("set NOUSOS_GATE_CHILD to the gate child wrapper executable")

    rows: list[dict[str, Any]] = []
    mandatory_ok = True
    proposal_file = Path(args.proposals)
    digest_before: str | None = None
    proxy: subprocess.Popen[bytes] | None = None

    def record(step: str, ok: bool, observed: str) -> None:
        rows.append({"step": step, "ok": ok, "observed": observed})

    try:
        digest_before = sha256(proposal_file)
        record("proposals_digest_before", True, "sha256_computed")
    except OSError:
        record("proposals_digest_before", False, "unavailable")
        mandatory_ok = False

    try:
        with tempfile.TemporaryDirectory(prefix="nousos-tunnel-preflight-") as temporary:
            root = Path(temporary)
            url_file = root / "proxy.json"
            child_command = shlex.join([sys.executable, str(GATE)])
            proxy = subprocess.Popen(
                [
                    args.tunnel_client, "dev", "proxy",
                    "--mcp-command", child_command,
                    "--print-json",
                    "--url-file", str(url_file),
                    "--duration", "120s",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            connection: dict[str, Any] | None = None
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and proxy.poll() is None:
                try:
                    candidate = json.loads(url_file.read_text(encoding="utf-8"))
                    if isinstance(candidate.get("mcp_url"), str):
                        connection = candidate
                        break
                except (OSError, json.JSONDecodeError):
                    pass
                time.sleep(0.1)

            if connection is None:
                record("proxy_ready", False, "mcp_url_unavailable")
                mandatory_ok = False
            else:
                record("proxy_ready", True, "loopback_mcp_url")
                client = McpClient(connection["mcp_url"])

                response, status = client.post({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "nousos-preflight", "version": "1"},
                    },
                })
                ok = status == 200 and "result" in response
                record("initialize", ok, f"http={status} {error_fact(response)}")
                mandatory_ok &= ok

                response, status = client.post({
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                    "params": {},
                })
                ok = status == 200
                record("notifications_initialized", ok, f"http={status}")
                mandatory_ok &= ok

                response, status = client.post({
                    "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
                })
                tools = response.get("result", {}).get("tools", [])
                names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
                ok = status == 200 and len(names) == 7 and names == EXPECTED_TOOLS
                record("tools_list", ok, f"http={status} tools={len(names)}")
                mandatory_ok &= ok

                response, status = tool_call(
                    client, 13, "candidate_search", {"query": "HOLOiVERSE", "limit": 1}
                )
                candidate_payload = tool_payload(response) if "result" in response else {}
                candidate_hits = (
                    candidate_payload.get("hits")
                    if isinstance(candidate_payload, dict)
                    else None
                )
                candidate_shaped = isinstance(candidate_hits, list) and all(
                    isinstance(hit, dict)
                    and hit.get("replaced") is False
                    and hit.get("canonical_status") in {"canonical", "non_canonical"}
                    and isinstance(hit.get("epistemic_label"), str)
                    and isinstance(hit.get("wording"), str)
                    and (
                        hit.get("canonical_status") != "non_canonical"
                        or hit["wording"].startswith("Recorded candidate proposal:")
                    )
                    for hit in candidate_hits
                )
                ok = (
                    status == 200
                    and isinstance(candidate_payload, dict)
                    and candidate_payload.get("status") == "complete"
                    and candidate_payload.get("ranking") == "text"
                    and candidate_shaped
                    and len(candidate_hits) <= 1
                )
                record(
                    "candidate_search",
                    ok,
                    f"http={status} hits={len(candidate_hits) if isinstance(candidate_hits, list) else 0} "
                    f"{error_fact(response)}",
                )
                mandatory_ok &= ok

                response, status = tool_call(client, 3, "canon_assertions", {})
                assertions_payload = tool_payload(response) if "result" in response else {}
                assertions = (
                    assertions_payload.get("assertions", [])
                    if isinstance(assertions_payload, dict)
                    else []
                )
                canonical = [
                    item for item in assertions
                    if isinstance(item, dict) and item.get("state") == "canonical"
                ]
                ok = (
                    status == 200
                    and isinstance(assertions_payload, dict)
                    and assertions_payload.get("status") == "complete"
                    and len(assertions) == 15
                    and len(canonical) == 15
                )
                record(
                    "canon_assertions",
                    ok,
                    f"http={status} assertions={len(assertions)} canonical={len(canonical)}",
                )
                mandatory_ok &= ok

                response, status = tool_call(
                    client, 4, "knowledge_search", {"query": "HOLOiVERSE", "limit": 50}
                )
                search_payload = tool_payload(response) if "result" in response else []
                hits = search_payload if isinstance(search_payload, list) else []
                source_id = next(
                    (
                        item.get("source_id")
                        for item in hits
                        if isinstance(item, dict) and isinstance(item.get("source_id"), str)
                    ),
                    None,
                )
                ok = status == 200 and len(hits) <= 20 and source_id is not None
                record(
                    "knowledge_search",
                    ok,
                    f"http={status} hits={len(hits)} source_id={source_id is not None}",
                )
                mandatory_ok &= ok

                response, status = tool_call(
                    client, 5, "knowledge.search", {"query": "HOLOiVERSE", "limit": 1}
                )
                dotted_payload = tool_payload(response) if "result" in response else []
                ok = status == 200 and isinstance(dotted_payload, list) and len(dotted_payload) <= 1
                record("dotted_name_accepted", ok, f"http={status} hits={len(dotted_payload) if isinstance(dotted_payload, list) else 0}")
                mandatory_ok &= ok

                context_payload: Any = {}
                if source_id:
                    response, status = tool_call(
                        client,
                        6,
                        "knowledge_context",
                        {"source_id": source_id, "before": 1, "after": 1},
                    )
                    context_payload = tool_payload(response) if "result" in response else {}
                    target = context_payload.get("target") if isinstance(context_payload, dict) else None
                    neighbours: list[Any] = []
                    if isinstance(context_payload, dict):
                        for key in ("before", "after"):
                            values = context_payload.get(key, [])
                            if isinstance(values, list):
                                neighbours.extend(values)
                    records = [target] + neighbours
                    shaped = bool(records) and all(
                        isinstance(item, dict)
                        and isinstance(item.get("source_id"), str)
                        and isinstance(item.get("role"), str)
                        and isinstance(item.get("created_at"), str)
                        for item in records
                    )
                    ok = status == 200 and isinstance(target, dict) and shaped
                    record(
                        "knowledge_context",
                        ok,
                        f"http={status} neighbours={len(neighbours)} target={isinstance(target, dict)}",
                    )
                    mandatory_ok &= ok
                else:
                    record("knowledge_context", False, "skipped_no_source_id")
                    mandatory_ok = False

                citation = None
                if canonical:
                    candidate = canonical[0].get("citation")
                    if isinstance(candidate, dict):
                        citation = candidate
                if citation is None:
                    record("provenance_span", False, "citation_unavailable")
                    mandatory_ok = False
                else:
                    response, status = tool_call(
                        client, 7, "provenance_span", {"citation": citation}
                    )
                    provenance_payload = tool_payload(response) if "result" in response else {}
                    returned_text = (
                        provenance_payload.get("text")
                        if isinstance(provenance_payload, dict)
                        else provenance_payload
                    )
                    expected_text = citation.get("span")
                    ok = status == 200 and returned_text == expected_text
                    record("provenance_span", ok, f"http={status} span_equal={ok}")
                    mandatory_ok &= ok

                response, status = tool_call(client, 8, "candidate_proposals", {})
                error = response.get("error", {})
                ok = isinstance(error, dict) and "NotExposed" in error.get("message", "")
                record("hidden_candidate_proposals", ok, f"http={status} {error_fact(response)}")
                mandatory_ok &= ok

                response, status = tool_call(client, 9, "candidate_propose", {
                    "source_id": "src_PREFLIGHT",
                    "content": "probe",
                    "proposed_at": "2026-09-25T00:00:00Z",
                    "holder": "preflight",
                })
                error = response.get("error", {})
                ok = isinstance(error, dict) and "NotExposed" in error.get("message", "")
                record("hidden_candidate_propose", ok, f"http={status} {error_fact(response)}")
                mandatory_ok &= ok

                response, status = client.post({
                    "jsonrpc": "2.0", "id": 10, "method": "ping", "params": {}
                })
                ok = status == 200 and response.get("result") == {}
                record("ping", ok, f"http={status} {error_fact(response)}")
                mandatory_ok &= ok

                fresh = McpClient(connection["mcp_url"])
                response, status = fresh.post(
                    {
                        "jsonrpc": "2.0",
                        "id": 11,
                        "method": "tools/list",
                        "params": {
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                                "io.modelcontextprotocol/clientCapabilities": {},
                            }
                        },
                    },
                    protocol_version="2026-07-28",
                )
                record("self_contained_probe", True, f"http={status} {error_fact(response)}")

                if args.with_semantic:
                    response, status = tool_call(
                        client, 12, "knowledge_semantic", {"query": "HOLOiVERSE"}
                    )
                    ok = status == 200 and "result" in response
                    record("knowledge_semantic", ok, f"http={status} {error_fact(response)}")
                    mandatory_ok &= ok
                else:
                    record("knowledge_semantic", True, "skipped_without_flag")
    except (OSError, subprocess.SubprocessError, urllib.error.URLError, ValueError) as exc:
        record("preflight_runtime", False, exc.__class__.__name__)
        mandatory_ok = False
    finally:
        if proxy is not None and proxy.poll() is None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait(timeout=5)

    ok, observed = server_write_refusal()
    record("server_write_refusal", ok, observed)
    mandatory_ok &= ok

    try:
        unchanged = digest_before is not None and sha256(proposal_file) == digest_before
        record(
            "proposals_digest_after",
            unchanged,
            "unchanged" if unchanged else "changed_or_unavailable",
        )
        mandatory_ok &= unchanged
    except OSError:
        record("proposals_digest_after", False, "unavailable")
        mandatory_ok = False

    print(json.dumps({"ok": bool(mandatory_ok), "steps": rows}, separators=(",", ":")))
    return 0 if mandatory_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
