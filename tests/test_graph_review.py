"""Synthetic-only tests for the D-066 read-only review projection."""
from __future__ import annotations

from io import BytesIO
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from nous_os import graph_review
from nous_os.capability import Tier


def synthetic_fixture(tmp_path: Path, monkeypatch):
    package = tmp_path / "synthetic-package"; package.mkdir()
    inventory = tmp_path / "synthetic-inventory.jsonl"
    evidence = {"voice": "founder", "role": "user", "source_id": "src-synthetic-one", "snapshot_digest": "a" * 64,
                "start_byte": 0, "end_byte": 9, "span": "synthetic", "date": "2026-01-01", "container": "conv-synthetic",
                "candidate_id": "candidate-synthetic", "canonical_status": "canonical", "epistemic_label": "CANONICAL", "context": ""}
    other = {**evidence, "source_id": "src-synthetic-two", "snapshot_digest": "b" * 64, "start_byte": 4,
             "end_byte": 15, "candidate_id": "proposal-synthetic", "canonical_status": "non_canonical", "epistemic_label": "PROPOSAL_NOT_APPROVED"}
    def card(identifier, klass, items):
        return {"id": identifier, "title": f"synthetic {identifier}", "linked": ["Quillmap", "Showcase / Dossier"],
                "statement": "synthetic statement", "why_it_matters": "synthetic reason", "epistemic_class": klass,
                "confidence": "synthetic confidence", "evidence": items}
    cards = [card("one", "A", [evidence, other]), card("two", "B", [evidence])]
    (package / "COLLEGAMENTI-D065.jsonl").write_text("".join(json.dumps(row) + "\n" for row in cards))
    inventory.write_text(json.dumps({"conversation": "conv-synthetic", "category": "A", "title": "synthetic conversation",
                                     "project_id": "project-synthetic", "project_name_inferred": "synthetic inferred"}) + "\n")
    candidates = tmp_path / "candidates.jsonl"; candidates.write_text("synthetic generation\n")
    canon = tmp_path / "canon"; canon.mkdir(); (canon / "assertions.jsonl").write_text("synthetic canon generation\n")
    workspace = SimpleNamespace(candidate_store_path=candidates, canon_root_path=canon)
    calls = []
    def invoke(grant, op, ws, args):
        assert ws is workspace
        assert grant.tiers == frozenset({Tier.READ})
        assert op in {"provenance.span", "knowledge.context", "canon.assertions"}
        calls.append((op, args))
        if op == "canon.assertions":
            return {"status": "complete", "assertions": [{"candidate_id": "candidate-synthetic", "assertion_id": "assertion-synthetic",
                    "state": "canonical", "text": "synthetic assertion", "candidate_version": "v1"}]}
        if op == "provenance.span":
            if args["citation"]["source_id"] == "src-synthetic-two": return "wrong synthetic span"
            return "synthetic"
        if args["source_id"] == "src-synthetic-two": raise LookupError("synthetic missing context")
        record = {"source_id": args["source_id"], "role": "user", "created_at": "2026-01-01", "snapshot_digest": "a" * 64,
                  "body": json.dumps({"payload": {"content": {"parts": ["synthetic context"]}}})}
        return {"container": "conv-synthetic", "target": record, "before": [record], "after": []}
    monkeypatch.setattr(graph_review.core, "invoke", invoke)
    return package, inventory, workspace, calls


def test_synthetic_export_determinism_catalogue_and_read_grant(tmp_path, monkeypatch):
    package, inventory, workspace, calls = synthetic_fixture(tmp_path, monkeypatch)
    first = graph_review.export(package=package, inventory=inventory, out=tmp_path / "first.json", workspace=workspace)
    second = graph_review.export(package=package, inventory=inventory, out=tmp_path / "second.json", workspace=workspace)
    assert first["export_digest"] == second["export_digest"]
    assert first["stats"]["node_types"] == {"candidate": 2, "canon": 1, "connection": 2, "conversation": 1,
                                                "domain": 9, "evidence": 2, "record": 2}
    assert set(first["model"]["edges"]) == set(graph_review.EDGE_MODEL)
    assert {edge["type"] for edge in first["edges"]} == set(graph_review.EDGE_MODEL)
    assert next(edge for edge in first["edges"] if edge["type"] == "links" and edge["source"] == "connection:one")["weight"] == 2
    assert first["verification"] == {"citations_total": 3, "citations_verified": 2, "records_with_context": 1, "records_without_context": 1}
    evidence = [node for node in first["nodes"] if node["type"] == "evidence"]
    assert len(evidence) == 2
    assert next(node for node in evidence if node["source_id"] == "src-synthetic-two")["verified"] is False
    assert next(node for node in first["nodes"] if node["id"] == "record:src-synthetic-two")["context_error"] == "LookupError"
    assert next(node for node in first["nodes"] if node["id"] == "connection:one")["epistemic"] == "A"
    assert next(node for node in first["nodes"] if node["id"] == "candidate:proposal-synthetic")["epistemic"] == "proposal"
    assert next(node for node in first["nodes"] if node["id"] == "candidate:candidate-synthetic")["epistemic"] == "canonical"
    assert all(op in {"provenance.span", "knowledge.context", "canon.assertions"} for op, _ in calls)
    assert sum(op == "provenance.span" for op, _ in calls) == 6
    assert sum(op == "knowledge.context" for op, _ in calls) == 4
    assert Path(str(tmp_path / "first.json") + ".sha256").read_text().strip() == first["export_digest"]
    for dimensions in (2, 3):
        points = first["layouts"][f"{dimensions}d"]
        assert all(all(-1 <= value <= 1 for value in point) for point in points.values())
        radii = [sum(value * value for value in points[node["id"]]) ** .5
                 for node in first["nodes"] if node["type"] == "domain"]
        assert max(radii) - min(radii) < .00001
        sizes = first["layouts"]["parameters"]["minimum_distance_by_type"]
        for index, left in enumerate(first["nodes"]):
            for right in first["nodes"][index + 1:]:
                assert math.dist(points[left["id"]], points[right["id"]]) >= sizes[left["type"]] + sizes[right["type"]] - .00001
    assert first["layouts"]["parameters"]["anchors_3d"] == "Fibonacci sphere"


def test_synthetic_refuses_repo_and_missing_input(tmp_path, monkeypatch):
    package, inventory, workspace, _ = synthetic_fixture(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="outside"):
        graph_review.export(package=package, inventory=inventory, out=Path(__file__).resolve().parents[1] / "unsafe.json", workspace=workspace)
    with pytest.raises(ValueError, match="missing, unreadable"):
        graph_review.export(package=tmp_path / "absent", inventory=inventory, out=tmp_path / "out.json", workspace=workspace)


def test_synthetic_server_routes_and_digest(tmp_path, monkeypatch):
    package, inventory, workspace, _ = synthetic_fixture(tmp_path, monkeypatch)
    output = tmp_path / "synthetic-export.json"
    result = graph_review.export(package=package, inventory=inventory, out=output, workspace=workspace)
    assert graph_review.load_export(output)["export_digest"] == result["export_digest"]
    static = tmp_path / "synthetic-static"; static.mkdir()
    (static / "index.html").write_text("synthetic explorer")
    (static / "review.js").write_text("// synthetic")
    handler = graph_review.make_handler(result, static)
    class Request:
        def makefile(self, mode, _size=None): return BytesIO(b"") if "r" in mode else self.output
        def sendall(self, data): self.output.write(data)
    def response(path):
        request = Request(); request.output = BytesIO()
        server = type("SyntheticServer", (), {"server_name": "localhost", "server_port": 8766})()
        class Routed(handler):
            def handle(self):
                self.raw_requestline = f"GET {path} HTTP/1.1\r\n".encode(); self.parse_request(); self.do_GET()
        Routed(request, ("127.0.0.1", 1000), server)
        return request.output.getvalue()
    for path in ("/", "/index.html", "/review.js", "/api/export.json", "/api/health"):
        assert b"200 OK" in response(path)
    assert result["export_digest"].encode() in response("/api/health")
    for path in ("/?bad=1", "/api/export.json?bad=1"):
        assert b"400 Bad Request" in response(path)
    for path in ("/bad", "/%2e%2e/secret", "//secret"):
        assert b"404 Not Found" in response(path)
    tampered = json.loads(output.read_text()); tampered["notice"]["en"] = "synthetic tamper"
    output.write_text(json.dumps(tampered))
    with pytest.raises(ValueError, match="digest mismatch"):
        graph_review.load_export(output)
    with pytest.raises(ValueError, match="digest mismatch"):
        graph_review.serve(export_path=output, static_root=static, port=0)


def test_lens_sidecar_route_is_optional_and_read_once(tmp_path):
    result = {"export_digest": "synthetic"}
    static = tmp_path / "static"; static.mkdir()
    lens_path = tmp_path / "lenses.json"
    lens_data = {"schema": "nousos-review-lenses-1", "reading_mode": {"id": "synthetic"}}
    lens_path.write_text(json.dumps(lens_data))
    loaded = graph_review.load_lenses(lens_path)
    lens_path.write_text("tampered after load")

    def response(handler, path):
        class Request:
            def makefile(self, mode, _size=None): return BytesIO(b"") if "r" in mode else self.output
            def sendall(self, data): self.output.write(data)
        request = Request(); request.output = BytesIO()
        server = type("SyntheticServer", (), {"server_name": "localhost", "server_port": 8766})()
        class Routed(handler):
            def handle(self):
                self.raw_requestline = f"GET {path} HTTP/1.1\r\n".encode(); self.parse_request(); self.do_GET()
        Routed(request, ("127.0.0.1", 1000), server)
        return request.output.getvalue()

    assert b"404 Not Found" in response(graph_review.make_handler(result, static), "/api/lenses.json")
    assert b"application/json" in response(graph_review.make_handler(result, static), "/api/lenses.json")
    supplied = response(graph_review.make_handler(result, static, loaded), "/api/lenses.json")
    assert b"200 OK" in supplied and b"synthetic" in supplied
    assert b"400 Bad Request" in response(graph_review.make_handler(result, static, loaded), "/api/lenses.json?x=1")
    invalid = tmp_path / "invalid.json"; invalid.write_text('{"schema":"unknown"}')
    with pytest.raises(ValueError, match="schema"):
        graph_review.load_lenses(invalid)
