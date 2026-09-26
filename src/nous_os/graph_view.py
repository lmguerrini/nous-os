"""Read-only, bounded export of a sampled Source Memory graph.

The projection has no candidate lifecycle or source relation edge vocabulary.
Candidate standing and recorded source relations therefore live in details.json;
the IR itself always comes from the governed graph.project operation.
"""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.parse import urlsplit

from nous_os.capability import Grant, Tier
from nous_os.adjudication import RejectionMemory
from nous_os.core import invoke, resolve_workspace
from nous_os.discovery import BridgeRegistry
from nous_os.reconciliation import RelationStore
from nous_os.review import canon_index


SCHEMA = "nousos-graph-details-1"
MAX_PER_SCOPE = 8
MAX_CANDIDATES = 40
DEFAULT_MAX_CANDIDATES = 12
MAX_ELEMENTS = 800
REPO_ROOT = Path(__file__).resolve().parents[2]


def _json(path: Path, value: object) -> None:
    _outside_repo(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _outside_repo(path: Path) -> None:
    if path.resolve().is_relative_to(REPO_ROOT):
        raise ValueError("output must be outside the repository")


def _governance_path(relative: str, explicit: str | None, variable: str) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get(variable):
        return Path(os.environ[variable]).expanduser()
    for root in (Path.cwd(), *Path.cwd().parents):
        candidate = root / relative
        if candidate.is_file():
            return candidate
    raise ValueError(f"pass --{variable.removeprefix('NOUS_OS_GRAPH_').lower().replace('_', '-')}")


def _lines(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def _db(path: Path) -> sqlite3.Connection:
    # immutable prevents a read from creating WAL sidecars in the source store.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _record_map(connection: sqlite3.Connection) -> dict[str, str]:
    return {source: container for source, container in connection.execute(
        "SELECT source_id, container_external_id FROM record WHERE container_external_id IS NOT NULL"
    )}


def _live_candidates(path: Path, replaced_path: Path):
    replaced = {row["old"] for row in _lines(replaced_path)} if replaced_path.exists() else set()
    rows = []
    for row in _lines(path):
        if row["proposal_id"] not in replaced:
            rows.append((row, json.loads(row["content"])))
    return sorted(rows, key=lambda pair: (pair[0]["proposal_id"], pair[0]["proposed_at"]))


def sample(*, out: Path, inventory: Path, workspace, replaced: Path, per_scope: int = 2) -> dict:
    if not 1 <= per_scope <= MAX_PER_SCOPE:
        raise ValueError(f"per-scope must be between 1 and {MAX_PER_SCOPE}")
    with closing(_db(workspace.derived_path)) as connection:
        source_conversation = _record_map(connection)
    counts = Counter(source_conversation.get(row["source_id"])
                     for row, _ in _live_candidates(workspace.candidate_store_path, replaced))
    choices = {}
    for row in _lines(inventory):
        if row.get("category") in {"A", "B"}:
            choices[(row["category"], row["conversation"])] = row
    selected = []
    capped = {}
    for category in ("A", "B"):
        group = [row for (scope, _), row in choices.items() if scope == category]
        group.sort(key=lambda row: (-counts[row["conversation"]], row["conversation"]))
        selected.extend({"conversation_id": row["conversation"], "category": category,
                         "title": row.get("title")}
                        for row in group[:per_scope])
        capped[category] = max(0, len(group) - per_scope)
    definition = {"schema": "nousos-graph-sample-1", "conversations": selected,
                  "capped": {"conversations": capped}}
    _json(out, definition)
    return definition


def _citation(value: dict | None) -> dict | None:
    if not isinstance(value, dict):
        return None
    keys = ("source_id", "snapshot_digest", "start_byte", "end_byte")
    if not all(key in value for key in keys):
        return None
    return {key: value[key] for key in keys}


def _preview(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _subject(value: str) -> str:
    # The scope is explicitly recorded; hashing only makes it a valid ClaimKey.
    return "scope." + hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def _source_records(connection: sqlite3.Connection, conversations: list[str]) -> dict[str, dict]:
    if not conversations:
        return {}
    slots = ",".join("?" for _ in conversations)
    query = ("SELECT r.source_id,r.snapshot_digest,r.kind,r.provider,r.external_id,"
             "r.container_external_id,r.parent_external_id,r.role,r.created_at,c.body "
             "FROM record r LEFT JOIN content c ON c.source_id=r.source_id "
             "AND c.snapshot_digest=r.snapshot_digest "
             f"WHERE r.container_external_id IN ({slots}) OR "
             f"(r.kind='conversation' AND r.external_id IN ({slots})) "
             "ORDER BY r.source_id,r.snapshot_digest")
    result = {}
    for row in connection.execute(query, conversations + conversations):
        result[row[0]] = dict(zip(("source_id", "snapshot_digest", "kind", "provider",
                                   "external_id", "container_external_id", "parent_external_id",
                                   "role", "created_at", "body"), row))
    return result


def _assertion_entry(identifier: str, text: str, citation: dict, support: str,
                     recorded_at: str, valid_from: str | None, valid_to: str | None,
                     scope: str) -> dict:
    return {"key": _subject(scope), "id": identifier, "text": text,
            "citation": citation, "support": support, "recorded_at": recorded_at,
            "valid_from": valid_from, "valid_to": valid_to}


def export(*, sample_path: Path, out_dir: Path | None, workspace, replaced: Path,
           policy: str = "discovery", max_candidates: int = DEFAULT_MAX_CANDIDATES) -> tuple[dict, dict]:
    if policy not in {"discovery", "reliability"}:
        raise ValueError("policy must be discovery or reliability")
    if not 1 <= max_candidates <= MAX_CANDIDATES:
        raise ValueError(f"max-candidates must be between 1 and {MAX_CANDIDATES}")
    definition = json.loads(sample_path.read_text(encoding="utf-8"))
    selected = definition["conversations"]
    if len([x for x in selected if x["category"] == "A"]) > MAX_PER_SCOPE or len(
            [x for x in selected if x["category"] == "B"]) > MAX_PER_SCOPE:
        raise ValueError("sample exceeds per-scope cap")
    conversations = [row["conversation_id"] for row in selected]
    if len(conversations) != len(set(conversations)):
        raise ValueError("sample repeats a conversation")
    titles = {row["conversation_id"]: row.get("title") for row in selected}
    with closing(_db(workspace.derived_path)) as connection:
        records = _source_records(connection, conversations)
        source_conversation = _record_map(connection)
    chosen_sources = {source for source, record in records.items()
                      if record["container_external_id"] in titles or
                      (record["kind"] == "conversation" and record["external_id"] in titles)}
    candidates = []
    candidate_capped = Counter()
    for row, proposal in _live_candidates(workspace.candidate_store_path, replaced):
        conversation = source_conversation.get(row["source_id"])
        if conversation not in titles or row["source_id"] not in chosen_sources:
            continue
        candidates.append((conversation, row, proposal))
    candidates.sort(key=lambda item: (item[0], item[1]["proposal_id"]))
    retained = []
    for conversation, row, proposal in candidates:
        if sum(1 for item in retained if item[0] == conversation) >= max_candidates:
            candidate_capped[conversation] += 1
        else:
            retained.append((conversation, row, proposal))
    canonical = []
    if workspace.canon_root_path is not None and workspace.canon_root_path.is_dir():
        for version in canon_index(workspace.canon_root_path):
            assertion = version.assertion
            if assertion.citation.source_id in chosen_sources:
                canonical.append(version)
    canonical.sort(key=lambda version: (version.assertion.id, version.content_digest))
    entries = []
    standing = {}
    for version in canonical:
        assertion = version.assertion
        citation = assertion.citation.as_payload()
        scope = next((p.get("scope") for _, r, p in retained
                      if r["proposal_id"] == version.candidate_id), assertion.id)
        entries.append(_assertion_entry(assertion.id, assertion.text, citation,
                        assertion.support.value, assertion.recorded_at.isoformat(),
                        assertion.valid_from.isoformat() if assertion.valid_from else None,
                        assertion.valid_to.isoformat() if assertion.valid_to else None, scope))
        standing[assertion.id] = "canonical"
    for conversation, row, proposal in retained:
        citations = proposal.get("citations") or []
        citation = next((item for item in citations if item.get("source_id") == row["source_id"]), None)
        if not citation or not proposal.get("statement"):
            candidate_capped[conversation] += 1
            continue
        if row["proposal_id"] in standing:
            continue
        entries.append(_assertion_entry(row["proposal_id"], proposal["statement"], citation,
                       proposal.get("support", "unknown"), row["proposed_at"],
                       proposal.get("valid_from"), proposal.get("valid_to"),
                       proposal.get("scope") or row["proposal_id"]))
        standing[row["proposal_id"]] = "candidate"
    entries.sort(key=lambda item: item["id"])
    bridges = []
    if workspace.bridge_registry_path.is_file():
        bridges = [card.as_payload() for card in BridgeRegistry(workspace.bridge_registry_path).cards()
                   if card.left.citation.source_id in chosen_sources
                   and card.right.citation.source_id in chosen_sources]
    bridges.sort(key=lambda card: card["card_id"])
    bridge_clusters = {card["cluster_id"] for card in bridges}
    rejections = []
    if workspace.rejection_memory_path.is_file():
        rejections = [item.as_payload() for item in RejectionMemory(workspace.rejection_memory_path).rejections()
                      if item.cluster_id in bridge_clusters]
    rejections.sort(key=lambda item: (item["cluster_id"], item["round_number"], item["rejected_at"]))
    grant = Grant("graph-view-reader", frozenset({Tier.READ}))

    def project(rows):
        return invoke(grant, "graph.project", workspace,
                      {"state": {"index": {"assertions": rows}, "bridges": bridges, "rejections": rejections},
                       "policy": policy})

    graph = project(entries)
    element_capped = 0
    while len(graph["nodes"]) + len(graph["edges"]) > MAX_ELEMENTS and entries:
        removed = entries.pop()
        standing.pop(removed["id"], None)
        element_capped += 1
        graph = project(entries)
    bridge_capped = 0
    rejection_capped = 0
    while len(graph["nodes"]) + len(graph["edges"]) > MAX_ELEMENTS and rejections:
        rejections.pop()
        rejection_capped += 1
        graph = project(entries)
    while len(graph["nodes"]) + len(graph["edges"]) > MAX_ELEMENTS and bridges:
        removed = bridges.pop()
        rejections = [item for item in rejections if item["cluster_id"] != removed["cluster_id"]]
        bridge_capped += 1
        graph = project(entries)
    nodes = {}
    for node in graph["nodes"]:
        attrs = node["attributes"]
        kind = node["kind"]
        identifier = attrs.get("assertion_id") if kind == "assertion" else None
        citation = _citation(attrs.get("provenance")) if kind == "assertion" else None
        source_id = citation["source_id"] if citation else (attrs.get("source_id") if kind == "source" else None)
        record = records.get(source_id, {})
        conversation_id = source_conversation.get(source_id)
        if record.get("kind") == "conversation":
            conversation_id = record.get("external_id")
        label = attrs.get("text") or attrs.get("key") or attrs.get("source_id") or attrs.get("cluster_id") or kind
        preview = citation and attrs.get("provenance", {}).get("span") or record.get("body") or label
        nodes[node["id"]] = {"kind": kind, "label": _preview(label, 80),
                             "origin": "real",
                             "status": standing.get(identifier, "source" if kind == "source" else "structural"),
                             "source_id": source_id, "conversation_id": conversation_id,
                             "conversation_title": titles.get(conversation_id),
                             "role": record.get("role") if record.get("role") in {"user", "assistant"} else None,
                             "created_at": (attrs.get("recorded_at") if kind == "assertion"
                                            else record.get("created_at")),
                             "citation": citation, "preview": _preview(preview, 280)}
    edges = {}
    for edge in graph["edges"]:
        evidence = _citation(edge["attributes"]) if edge["kind"] == "cites" else None
        edges[edge["id"]] = {"kind": edge["kind"], "origin": "structural",
                             "evidence": [evidence] if evidence else []}
    for node_id, detail in nodes.items():
        if detail["kind"] == "source" and detail["conversation_id"] is not None:
            edges[f"{node_id}->conversation:{detail['conversation_id']}"] = {
                "kind": "belongs_to_conversation", "origin": "structural", "evidence": []}
    if workspace.relation_store_path.is_file():
        for relation in RelationStore(workspace.relation_store_path).relations():
            if relation.left.source_id in chosen_sources and relation.right.source_id in chosen_sources:
                edges[relation.relation_id] = {"kind": relation.relation_class.value,
                                               "origin": "explicit_relation",
                                               "ends": [f"source:{relation.left.source_id}",
                                                        f"source:{relation.right.source_id}"],
                                               "end_labels": [nodes.get(f"source:{source_id}", {}).get("label")
                                                              or _preview(records.get(source_id, {}).get("body") or source_id, 80)
                                                              for source_id in (relation.left.source_id,
                                                                                relation.right.source_id)],
                                               "evidence": [_citation(c.as_payload()) for c in relation.all_citations()]}
    counts = {"nodes": len(graph["nodes"]), "edges": len(graph["edges"]),
              "max_candidates": max_candidates,
              "candidate": sum(value == "candidate" for value in standing.values()),
              "canonical": sum(value == "canonical" for value in standing.values()),
              "explicit_relations": sum(e["origin"] == "explicit_relation" for e in edges.values()),
              "capped": {"conversations": definition.get("capped", {}).get("conversations", {}),
                         "candidates": dict(sorted(candidate_capped.items())),
                         "ir_inputs": element_capped, "bridges": bridge_capped,
                         "rejections": rejection_capped}}
    details = {"schema": SCHEMA, "generated_at": datetime.now(timezone.utc).isoformat(),
               "sample": {"conversations": selected, "counts": counts},
               "nodes": nodes, "edges": edges}
    if out_dir is not None:
        _outside_repo(out_dir)
        _json(out_dir / "graph.json", graph)
        _json(out_dir / "details.json", details)
    return graph, details


def make_handler(graph: dict, details: dict, static_root: Path,
                 alternate: tuple[dict, dict] | None = None):
    def encoded(pair):
        return {"/api/graph.json": json.dumps(pair[0], ensure_ascii=False).encode(),
                "/api/details.json": json.dumps(pair[1], ensure_ascii=False).encode()}
    caches = {"discovery": encoded((graph, details)),
              "reliability": encoded(alternate or (graph, details))}
    health = b'{"status":"ok"}'
    root = static_root.resolve()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            if "?" in self.path:
                self.send_error(400)
                return
            if parsed.scheme or parsed.netloc or parsed.fragment:
                self.send_error(404)
                return
            raw = parsed.path
            if raw == "/api/health":
                body = health
                content_type = "application/json; charset=utf-8"
            elif raw in caches["discovery"]:
                body = caches["discovery"][raw]
                content_type = "application/json; charset=utf-8"
            elif raw not in {"/", "/index.html", "/viewer.js"}:
                self.send_error(404)
                return
            else:
                relative = "index.html" if raw == "/" else raw.lstrip("/")
                target = (root / relative).resolve()
                if not target.is_relative_to(root):
                    self.send_error(403)
                    return
                if not target.is_file():
                    self.send_error(404)
                    return
                body = target.read_bytes()
                content_type = "text/html; charset=utf-8" if relative == "index.html" else "text/javascript; charset=utf-8"
            self._response_bytes = len(body)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_request(self, code="-", size="-"):
            print(f"{self.command} {urlsplit(self.path).path} {code} {getattr(self, '_response_bytes', 0)}",
                  file=sys.stderr)

        def log_message(self, format, *args):
            pass

    return Handler


def serve(*, sample_path: Path, workspace, replaced: Path, port: int = 8765,
          static_root: Path = Path("ui/dist/viewer"), policy: str = "discovery",
          max_candidates: int = DEFAULT_MAX_CANDIDATES) -> None:
    graph, details = export(sample_path=sample_path, out_dir=None, workspace=workspace,
                            replaced=replaced, policy=policy, max_candidates=max_candidates)
    other_policy = "reliability" if policy == "discovery" else "discovery"
    alternate = export(sample_path=sample_path, out_dir=None, workspace=workspace,
                       replaced=replaced, policy=other_policy, max_candidates=max_candidates)
    if policy == "reliability":
        graph, details, alternate = alternate[0], alternate[1], (graph, details)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(graph, details, static_root, alternate))
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sample_parser = sub.add_parser("sample")
    sample_parser.add_argument("--out", required=True, type=Path)
    sample_parser.add_argument("--per-scope", type=int, default=2)
    sample_parser.add_argument("--inventory")
    sample_parser.add_argument("--replaced")
    for name in ("export", "serve"):
        command = sub.add_parser(name)
        command.add_argument("--sample", required=True, type=Path)
        command.add_argument("--replaced")
        command.add_argument("--policy", choices=("discovery", "reliability"), default="discovery")
        command.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
        if name == "export":
            command.add_argument("--out-dir", required=True, type=Path)
        else:
            command.add_argument("--port", type=int, default=8765)
            command.add_argument("--static", type=Path, default=Path("ui/dist/viewer"))
    args = parser.parse_args(argv)
    workspace = resolve_workspace()
    replaced = _governance_path("candidates/REPLACED-IN-REVIEW.jsonl",
                                getattr(args, "replaced", None), "NOUS_OS_GRAPH_REPLACED")
    if args.command == "sample":
        inventory = _governance_path("inventory/INVENTORY-v1.jsonl", args.inventory,
                                     "NOUS_OS_GRAPH_INVENTORY")
        sample(out=args.out, inventory=inventory, workspace=workspace,
               replaced=replaced, per_scope=args.per_scope)
    elif args.command == "export":
        export(sample_path=args.sample, out_dir=args.out_dir, workspace=workspace,
               replaced=replaced, policy=args.policy, max_candidates=args.max_candidates)
    else:
        serve(sample_path=args.sample, workspace=workspace, replaced=replaced,
              port=args.port, static_root=args.static, policy=args.policy,
              max_candidates=args.max_candidates)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
