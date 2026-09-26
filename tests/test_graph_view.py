"""Synthetic-only checks for the bounded read-only graph view."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sqlite3

import pytest

from nous_os import graph_view
from nous_os.canonical import Assertion, LifecycleState, SupportClass
from nous_os.core import resolve_workspace
from nous_os.provenance import Citation, Locator
from nous_os.reconciliation import EvidenceBasis, Origin, RelationClass, RelationEnd, RelationProposal


SOURCE = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
OTHER = "src_01ARZ3NDEKTSV4RRFFQ69G5FAA"
UNSELECTED = "src_01ARZ3NDEKTSV4RRFFQ69G5FAB"
PROPOSAL = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAV"
CANON = "asr_01ARZ3NDEKTSV4RRFFQ69G5FAA"
DIGEST = "a" * 64
WHEN = "2026-01-02T12:00:00+00:00"


def _write_lines(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


@pytest.fixture
def stores(tmp_path: Path):
    root = tmp_path / "canon"
    root.mkdir()
    env = {key: str(tmp_path / name) for key, name in {
        "NOUS_OS_DATA_ROOT": "canon", "NOUS_OS_SNAPSHOT_ROOT": "snapshots",
        "NOUS_OS_LEDGER_PATH": "ledger.jsonl", "NOUS_OS_DERIVED_PATH": "derived.sqlite3",
        "NOUS_OS_CANDIDATE_STORE_PATH": "candidates.jsonl",
        "NOUS_OS_BRIDGE_REGISTRY_PATH": "bridges.jsonl",
        "NOUS_OS_REJECTION_MEMORY_PATH": "rejections.jsonl",
        "NOUS_OS_RELATION_STORE_PATH": "relations.jsonl",
        "NOUS_OS_CANON_ROOT_PATH": "canon",
    }.items()}
    workspace = resolve_workspace(environ=env)
    db = sqlite3.connect(workspace.derived_path)
    db.executescript("""
        CREATE TABLE record(snapshot_digest TEXT,source_id TEXT,kind TEXT,provider TEXT,
          external_id TEXT,container_external_id TEXT,parent_external_id TEXT,role TEXT,created_at TEXT);
        CREATE TABLE content(snapshot_digest TEXT,source_id TEXT,body TEXT);
    """)
    records = [
        (SOURCE, "message", "conv-a", "user", "synthetic selected source"),
        (OTHER, "message", "conv-a", "assistant", "synthetic second source"),
        (UNSELECTED, "message", "conv-b", "user", "SECRET-UNSELECTED"),
    ]
    for source, kind, container, role, body in records:
        db.execute("INSERT INTO record VALUES(?,?,?,?,?,?,?,?,?)",
                   (DIGEST, source, kind, "test", source, container, None, role, WHEN))
        db.execute("INSERT INTO content VALUES(?,?,?)", (DIGEST, source, body))
    db.commit()
    db.close()
    citation = {"source_id": SOURCE, "snapshot_digest": DIGEST,
                "start_byte": 0, "end_byte": 9, "span": "synthetic"}
    proposal = {"scope": "synthetic-scope", "statement": "synthetic proposal",
                "citations": [citation], "support": "direct_quote",
                "valid_from": None, "valid_to": None}
    _write_lines(workspace.candidate_store_path, [
        {"content": json.dumps(proposal), "holder": "test", "proposal_id": PROPOSAL,
         "proposed_at": WHEN, "source_id": SOURCE},
    ])
    inventory = tmp_path / "inventory.jsonl"
    _write_lines(inventory, [
        {"category": "B", "conversation": "conv-b", "title": "other"},
        {"category": "A", "conversation": "conv-a", "title": "selected"},
        {"category": "A", "conversation": "conv-c", "title": "empty"},
    ])
    replaced = tmp_path / "replaced.jsonl"
    _write_lines(replaced, [])
    return workspace, inventory, replaced, citation


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_sample_determinism_and_caps(stores, tmp_path: Path):
    workspace, inventory, replaced, _ = stores
    first = tmp_path / "one.json"
    second = tmp_path / "two.json"
    one = graph_view.sample(out=first, inventory=inventory, workspace=workspace,
                            replaced=replaced, per_scope=1)
    graph_view.sample(out=second, inventory=inventory, workspace=workspace,
                      replaced=replaced, per_scope=1)
    assert first.read_bytes() == second.read_bytes()
    assert one["conversations"][0]["conversation_id"] == "conv-a"
    assert one["capped"]["conversations"] == {"A": 1, "B": 0}
    with pytest.raises(ValueError):
        graph_view.sample(out=second, inventory=inventory, workspace=workspace,
                          replaced=replaced, per_scope=9)


def test_details_origins_and_store_bytes(stores, tmp_path: Path, monkeypatch):
    workspace, inventory, replaced, citation = stores
    sample_path = tmp_path / "sample.json"
    graph_view.sample(out=sample_path, inventory=inventory, workspace=workspace,
                      replaced=replaced, per_scope=1)
    sample_data = json.loads(sample_path.read_text())
    sample_data["conversations"] = sample_data["conversations"][:1]
    sample_path.write_text(json.dumps(sample_data))

    assertion = Assertion(CANON, "synthetic canon",
                          Citation(SOURCE, DIGEST, Locator(0, 9), "synthetic"),
                          SupportClass.DIRECT_QUOTE,
                          datetime.fromisoformat(WHEN), LifecycleState.CANONICAL)
    class Version:
        def __init__(self):
            self.assertion = assertion
            self.candidate_id = "unrelated"
            self.content_digest = assertion.content_digest
    monkeypatch.setattr(graph_view, "canon_index", lambda _: (Version(),))
    relation = RelationProposal(
        RelationClass.RELATED, RelationEnd(SOURCE, DIGEST), RelationEnd(OTHER, DIGEST),
        (EvidenceBasis.MODEL_JUDGEMENT,),
        (Citation(SOURCE, DIGEST, Locator(0, 9), "synthetic"),
         Citation(OTHER, DIGEST, Locator(0, 9), "synthetic")),
        Origin.OPERATOR, "test", datetime.fromisoformat(WHEN),
    ).recorded("rel_01ARZ3NDEKTSV4RRFFQ69G5FAV")
    _write_lines(workspace.relation_store_path, [relation.as_payload()])
    protected = [workspace.derived_path, workspace.candidate_store_path,
                 workspace.relation_store_path, inventory, replaced]
    before = {path: _digest(path) for path in protected}
    graph, details = graph_view.export(sample_path=sample_path, out_dir=tmp_path / "out",
                                       workspace=workspace, replaced=replaced)
    assert {path: _digest(path) for path in protected} == before
    assert graph["schema_version"] == "nous-projection-ir/1"
    assert details["schema"] == graph_view.SCHEMA
    assert details["nodes"][f"assertion:{PROPOSAL}"]["status"] == "candidate"
    assert details["nodes"][f"assertion:{PROPOSAL}"]["created_at"] == WHEN
    assert details["nodes"][f"assertion:{CANON}"]["status"] == "canonical"
    assert details["nodes"][f"source:{SOURCE}"]["status"] == "source"
    assert any(edge["origin"] == "structural" for edge in details["edges"].values())
    assert any(edge["origin"] == "explicit_relation" for edge in details["edges"].values())
    explicit = next(edge for edge in details["edges"].values() if edge["origin"] == "explicit_relation")
    assert explicit["ends"] == [f"source:{SOURCE}", f"source:{OTHER}"]
    assert len(explicit["end_labels"]) == 2
    assert details["sample"]["counts"]["max_candidates"] == 12
    assert not any(edge["origin"] == "inferred" for edge in details["edges"].values())
    assert details["nodes"][f"assertion:{PROPOSAL}"]["citation"] == graph_view._citation(citation)
    assert "SECRET-UNSELECTED" not in json.dumps((graph, details))
    assert all(len(node["label"]) <= 80 and len(node["preview"]) <= 280
               for node in details["nodes"].values())


def test_export_candidate_cap_and_replaced_versions(stores, tmp_path: Path, monkeypatch):
    workspace, inventory, replaced, citation = stores
    rows = []
    for number in range(43):
        proposal = {"scope": "synthetic-scope", "statement": f"synthetic proposal {number}",
                    "citations": [citation], "support": "direct_quote",
                    "valid_from": None, "valid_to": None}
        rows.append({"content": json.dumps(proposal), "holder": "test",
                     "proposal_id": f"asr_{number:026d}",
                     "proposed_at": WHEN, "source_id": SOURCE})
    _write_lines(workspace.candidate_store_path, rows)
    _write_lines(replaced, [{"old": rows[0]["proposal_id"], "new": rows[1]["proposal_id"]}])
    sample_path = tmp_path / "sample.json"
    graph_view.sample(out=sample_path, inventory=inventory, workspace=workspace,
                      replaced=replaced, per_scope=1)
    graph, details = graph_view.export(sample_path=sample_path, out_dir=tmp_path / "out",
                                       workspace=workspace, replaced=replaced, max_candidates=40)
    assert details["sample"]["counts"]["candidate"] == 40
    assert sum(details["sample"]["counts"]["capped"]["candidates"].values()) == 2
    assert len(graph["nodes"]) + len(graph["edges"]) <= 800
    assert f"assertion:{rows[0]['proposal_id']}" not in details["nodes"]
    monkeypatch.setattr(graph_view, "MAX_ELEMENTS", 10)
    smaller, limited = graph_view.export(sample_path=sample_path, out_dir=None,
                                         workspace=workspace, replaced=replaced)
    assert len(smaller["nodes"]) + len(smaller["edges"]) <= 10
    assert limited["sample"]["counts"]["capped"]["ir_inputs"] > 0


def test_candidate_limit_default_and_bounds(stores, tmp_path: Path):
    workspace, inventory, replaced, citation = stores
    rows = []
    for number in range(15):
        proposal = {"scope": "synthetic-scope", "statement": f"synthetic proposal {number}",
                    "citations": [citation], "support": "direct_quote"}
        rows.append({"content": json.dumps(proposal), "holder": "test",
                     "proposal_id": f"asr_{number:026d}", "proposed_at": WHEN, "source_id": SOURCE})
    _write_lines(workspace.candidate_store_path, rows)
    sample_path = tmp_path / "sample.json"
    graph_view.sample(out=sample_path, inventory=inventory, workspace=workspace,
                      replaced=replaced, per_scope=1)
    for limit, expected in ((12, 12), (1, 1), (40, 15)):
        _, details = graph_view.export(sample_path=sample_path, out_dir=None,
                                       workspace=workspace, replaced=replaced, max_candidates=limit)
        assert details["sample"]["counts"]["max_candidates"] == limit
        assert details["sample"]["counts"]["candidate"] == expected
        assert sum(details["sample"]["counts"]["capped"]["candidates"].values()) == 15 - expected
    for limit in (0, 41):
        with pytest.raises(ValueError, match="max-candidates must be between 1 and 40"):
            graph_view.export(sample_path=sample_path, out_dir=None,
                              workspace=workspace, replaced=replaced, max_candidates=limit)


@pytest.mark.parametrize("command", ("export", "serve"))
def test_cli_forwards_candidate_limit(command: str, tmp_path: Path, monkeypatch):
    observed = {}
    monkeypatch.setattr(graph_view, "resolve_workspace", lambda: object())
    monkeypatch.setattr(graph_view, "_governance_path", lambda *args: tmp_path / "replaced.jsonl")
    monkeypatch.setattr(graph_view, command, lambda **kwargs: observed.update(kwargs))
    args = [command, "--sample", str(tmp_path / "sample.json"), "--max-candidates", "6"]
    if command == "export":
        args += ["--out-dir", str(tmp_path / "out")]
    assert graph_view.main(args) == 0
    assert observed["max_candidates"] == 6


def test_server_whitelist_traversal_and_loopback(tmp_path: Path, monkeypatch, capsys):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("synthetic viewer")
    (static / "viewer.js").write_text("// synthetic bundle")
    (static / "extra.json").write_text('{"synthetic":true}')
    (static / "directory").mkdir()
    (tmp_path / "private.txt").write_text("SECRET-UNSELECTED")
    (static / "escape.txt").symlink_to(tmp_path / "private.txt")
    handler = graph_view.make_handler({"policy_id": "discovery"}, {"schema": graph_view.SCHEMA},
                                      static, ({"policy_id": "reliability"}, {}))
    class Request:
        def makefile(self, mode, _size=None):
            return BytesIO(b"") if "r" in mode else self.output

        def sendall(self, data):
            self.output.write(data)

    def response(path: str) -> bytes:
        request = Request()
        request.output = BytesIO()
        server = type("FakeServer", (), {"server_name": "localhost", "server_port": 8765})()
        class Routed(handler):
            def handle(self):
                self.raw_requestline = f"GET {path} HTTP/1.1\r\n".encode()
                self.parse_request()
                self.do_GET()
        request.output = BytesIO()
        Routed(request, ("127.0.0.1", 1000), server)
        return request.output.getvalue()

    assert b"200 OK" in response("/api/health")
    assert b'{"status":"ok"}' in response("/api/health")
    assert b"200 OK" in response("/api/graph.json")
    assert b"synthetic viewer" in response("/")
    assert b"synthetic viewer" in response("/index.html")
    assert b"// synthetic bundle" in response("/viewer.js")
    for path in ("/api/nope", "/%2e%2e/private.txt", "/%252e%252e/private.txt",
                 str(tmp_path / "private.txt"), "/escape.txt", "//private.txt",
                 "http://synthetic.invalid/index.html", "/%69ndex.html",
                 "/extra.json", "/directory/"):
        result = response(path)
        assert b"404 Not Found" in result
        assert b"SECRET-UNSELECTED" not in result
    for path in ("/?synthetic=secret", "/viewer.js?synthetic=secret",
                 "/api/health?synthetic=secret", "/api/graph.json?policy=reliability", "/index.html?"):
        assert b"400 Bad Request" in response(path)
    assert b"access-control-allow-origin" not in response("/api/health").split(b"\r\n\r\n", 1)[0].lower()
    capsys.readouterr()
    response("/api/health?synthetic_query=secret_marker")
    log = capsys.readouterr().err
    assert "GET /api/health 400 0" in log
    assert "synthetic_query" not in log
    assert "secret_marker" not in log

    class Stopped(Exception):
        pass

    def bind(address, _handler):
        assert address == ("127.0.0.1", 8765)
        raise Stopped

    monkeypatch.setattr(graph_view, "ThreadingHTTPServer", bind)
    monkeypatch.setattr(graph_view, "export", lambda **kwargs: ({}, {}))
    with pytest.raises(Stopped):
        graph_view.serve(sample_path=tmp_path / "sample.json", workspace=None,
                         replaced=tmp_path / "replaced.jsonl")
