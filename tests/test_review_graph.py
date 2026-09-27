"""Synthetic review graph v2 checks; no real corpus content is embedded here."""
import hashlib
import json
from pathlib import Path
import io
import gzip

from nous_os.review_graph import build, encoded, short
from nous_os.graph_review import serve_graph


def fixture(tmp_path: Path):
    stores = tmp_path / "stores"
    (stores / "candidates").mkdir(parents=True)
    (stores / "canon").mkdir()
    (stores / "reconciliation").mkdir()
    record = {"container_external_id": "conv1", "role": "user", "created_at": "2026-01-01"}
    raw = encoded(record)
    digest = hashlib.sha256(raw).hexdigest()
    snapshot = stores / "snapshots" / "src_a" / f"{digest}.snapshot"
    snapshot.parent.mkdir(parents=True)
    snapshot.write_bytes(raw)
    span = "conv1"
    start = raw.index(span.encode())
    citation = {"source_id": "src_a", "snapshot_digest": digest, "start_byte": start,
                "end_byte": start + len(span), "span": span}
    (stores / "ledger.jsonl").write_bytes(encoded({"source_id": "src_a", "snapshot_digest": digest}))
    content = {"kind": "CONCEPT", "statement": "A distinctive Atlasfield statement about the luminous garden and its materials.",
               "citations": [citation], "valid_to": None, "valid_from": "2026-01-01", "origin": "USER_AUTHORED"}
    proposal = {"proposal_id": "asr_one", "content": json.dumps(content), "source_id": "src_a"}
    superseded = {"proposal_id": "asr_old", "content": json.dumps(content | {"statement": "Old distinct statement"}), "source_id": "src_a"}
    (stores / "candidates/proposals.jsonl").write_bytes(encoded(proposal) + encoded(superseded))
    (stores / "canon/assertions.jsonl").write_bytes(encoded({"candidate_id": "asr_one", "assertion_id": "canon_one"}))
    (stores / "reconciliation/relations.jsonl").write_bytes(b"")
    inventory = tmp_path / "inventory.jsonl"
    inventory.write_bytes(encoded({"conversation": "conv1", "title": "Luminous garden", "messages_first": "2026-01-01"}))
    membership = tmp_path / "membership.json"
    membership.write_bytes(encoded({"schema": "nousos.domain-membership/1", "rules": {}, "conversations": {
        "conv1": {"title": "Luminous garden", "domains": ["atlasfield", "meridian"], "primary": "atlasfield", "evidence": "fixture"}}}))
    replaced = tmp_path / "replaced.jsonl"
    replaced.write_bytes(encoded({"old": "asr_old"}))
    cards = tmp_path / "cards.jsonl"
    cards.write_bytes(b"")
    return dict(stores=stores, inventory=inventory, membership=membership, replaced=replaced, cards=cards), citation


def test_build_determinism_and_provenance(tmp_path):
    args, citation = fixture(tmp_path)
    first = build(**args, out=tmp_path / "first")
    second = build(**args, out=tmp_path / "second")
    assert first["digest"] == second["digest"]
    for name in ("manifest.json", "index.json", "details.jsonl", "details-offsets.json"):
        assert (tmp_path / "first" / name).read_bytes() == (tmp_path / "second" / name).read_bytes()
    index = json.loads((tmp_path / "first/index.json").read_text())
    nodes = {n["id"]: n for n in index["nodes"]}
    assert "asr_old" not in nodes
    assert nodes["asr_one"]["status"] == "canon"
    assert nodes["asr_one"]["counts"]["passages"] == 1
    assert nodes["conversation:conv1"]["parents"] == ["domain:atlasfield", "domain:meridian"]
    assert nodes["asr_one"]["title"].startswith("A distinctive Atlasfield statement")
    assert all(.15 <= n["size"] <= 1 for n in nodes.values())
    assert any(e["type"] == "classified_in" for e in index["edges"])


def test_overlay_merge_and_invalid_citation(tmp_path):
    args, citation = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "titles.jsonl").write_bytes(encoded({"schema": "nousos.title/1", "id": "asr_one", "title_it": "Giardino luminoso"}))
    (overlay / "entities.json").write_bytes(encoded({"schema": "nousos.entities/1", "entities": [
        {"id": "entity:garden", "name": "conv1", "type": "project", "aliases": ["Luminous garden"],
         "domains": ["atlasfield"], "evidence": [citation]}]}))
    valid = {"schema": "nousos.p2a-proposal/1", "id": "ovl_good", "conversation_id": "conv1", "kind": "DECISION",
             "statement": "The garden will use warm stone.", "citations": [citation]}
    invalid = valid | {"id": "ovl_bad", "citations": [citation | {"span": "forged"}]}
    (overlay / "p2a-proposals.jsonl").write_bytes(encoded(valid) + encoded(invalid))
    (overlay / "exploratory.jsonl").write_bytes(encoded({"schema": "nousos.exploratory-connection/1", "a": "asr_one", "b": "ovl_good",
        "inference": "analogy", "explanation_it": "Synthetic link",
        "confidence": "low", "counter_evidence": [], "status": "exploratory/non-canonical"}))
    manifest = build(**args, overlay=overlay, out=tmp_path / "out")
    index = json.loads((tmp_path / "out/index.json").read_text())
    nodes = {n["id"]: n for n in index["nodes"]}
    assert nodes["asr_one"]["title"] == "Giardino luminoso"
    assert nodes["entity:garden"]["level"] == 2
    assert nodes["conversation:conv1"]["parent"] == "entity:garden"
    assert nodes["ovl_good"]["status"] == "overlay"
    assert "ovl_bad" not in nodes
    assert any(e["class"] == "exploratory" and e.get("a_sources") == [citation] and e.get("b_sources") == [citation]
               for e in index["edges"])
    assert manifest["audit"]["dropped"]["citation: span byte mismatch"] == 1


def test_domain_keeps_its_name_and_a_namesake_entity_says_what_it_is(tmp_path):
    args, citation = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "entities.json").write_bytes(encoded({"schema": "nousos.entities/1", "entities": [
        {"id": "ent_forge", "name": "FORGE", "type": "project", "aliases": ["conv1"], "domains": ["atlasfield"],
         "evidence": [citation]}]}))
    build(**args, overlay=overlay, out=tmp_path / "out")
    nodes = {n["id"]: n for n in json.loads((tmp_path / "out/index.json").read_text())["nodes"]}
    assert nodes["domain:forge"]["title"] == "FORGE"
    assert nodes["ent_forge"]["title"] == "FORGE · progetto"


def test_exploratory_overlay_sources_are_used_and_verified(tmp_path):
    args, citation = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    link = {"schema": "nousos.exploratory-connection/1", "id": "p2b-x", "a": "asr_one", "b": "conv1", "inference": "analogy",
            "explanation_it": "Synthetic link", "confidence": "low", "counter_evidence": [], "status": "exploratory/non-canonical",
            "a_sources": [citation], "b_sources": [citation]}
    forged = link | {"id": "p2b-y", "b_sources": [citation | {"span": "forged"}]}
    (overlay / "exploratory.jsonl").write_bytes(encoded(link) + encoded(forged))
    manifest = build(**args, overlay=overlay, out=tmp_path / "out")
    edges = [e for e in json.loads((tmp_path / "out/index.json").read_text())["edges"] if e["class"] == "exploratory"]
    assert [(e["a_sources"], e["b_sources"]) for e in edges] == [([citation], [citation])]
    assert manifest["audit"]["dropped"]["exploratory invalid overlay source"] == 1


def test_require_complete_refuses_a_dataset_without_every_outcome(tmp_path):
    args, _ = fixture(tmp_path)
    import pytest
    with pytest.raises(ValueError, match="pass outcomes incomplete"):
        build(**args, out=tmp_path / "out", require_complete=True)
    assert not (tmp_path / "out" / "manifest.json").exists()


def test_records_of_one_relation_merge_their_evidence(tmp_path):
    args, citation = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    row = {"schema": "nousos.exploratory-connection/1", "id": "p2b-1", "a": "asr_one", "b": "conv1", "inference": "analogy",
           "explanation_it": "First reading", "confidence": "low", "counter_evidence": [], "status": "exploratory/non-canonical",
           "a_sources": [citation], "b_sources": [citation]}
    (overlay / "exploratory.jsonl").write_bytes(encoded(row) + encoded(row | {"id": "p2b-2", "explanation_it": "Second reading"}))
    build(**args, overlay=overlay, out=tmp_path / "out")
    edges = [e for e in json.loads((tmp_path / "out/index.json").read_text())["edges"] if e["class"] == "exploratory"]
    assert len(edges) == 1
    assert [r["explanation"] for r in edges[0]["merged_records"]] == ["Second reading"]


def test_duplicate_titles_gain_discriminators(tmp_path):
    args, citation = fixture(tmp_path)
    path = args["stores"] / "candidates/proposals.jsonl"
    source = json.loads(path.read_text().splitlines()[0])
    duplicate = source | {"proposal_id": "asr_two"}
    path.write_bytes(path.read_bytes() + encoded(duplicate))
    manifest = build(**args, out=tmp_path / "out")
    proposals = [n for n in json.loads((tmp_path / "out/index.json").read_text())["nodes"] if n["level"] == 4]
    assert len({n["title"] for n in proposals}) == 2
    assert manifest["audit"]["duplicate_titles_within_parent_before"] == 2


def test_generic_lead_in_is_removed_from_fallback_title():
    assert short("Open question: which garden material should be selected?") == "which garden material should be selected?"
    assert short("Proposed principle: use warm stone in the garden.") == "use warm stone in the garden."


def test_server_routes_and_bounds(tmp_path, monkeypatch):
    args, _ = fixture(tmp_path)
    build(**args, out=tmp_path / "out")
    holder = {}
    class FakeServer:
        def __init__(self, address, handler):
            assert address[0] == "127.0.0.1"
            holder["handler"] = handler
        def serve_forever(self):
            pass
        def server_close(self):
            pass
    monkeypatch.setattr("nous_os.graph_review.ThreadingHTTPServer", FakeServer)
    serve_graph(graph=tmp_path / "out")
    def query(route, accept_encoding=""):
        handler = holder["handler"].__new__(holder["handler"])
        handler.path = "/api/graph/" + route
        handler.wfile = io.BytesIO()
        handler.headers = {"Accept-Encoding": accept_encoding}
        handler.sent_headers = {}
        handler.send_response = lambda code: setattr(handler, "status", code)
        handler.send_header = lambda key, value: handler.sent_headers.__setitem__(key, value)
        handler.end_headers = lambda: None
        handler.do_GET()
        if accept_encoding == "gzip" and route == "index":
            assert handler.sent_headers["Content-Encoding"] == "gzip"
        body = handler.wfile.getvalue()
        if handler.sent_headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return handler.status, json.loads(body)
    for route in ("manifest", "index", "node?id=asr_one", "children?id=conversation:conv1&limit=1", "search?q=garden"):
        assert query(route)[0] == 200
    assert query("node?id=asr_one")[1]["detail"]["citations"][0]["span"] == "conv1"
    assert query("children?id=asr_one&limit=1")[1]["children"][0]["kind"] == "passage"
    assert any(hit["id"] == "asr_one" for hit in query("search?q=garden")[1]["results"])
    assert query("children?id=asr_one&limit=1000")[0] == 400
    assert query("index", "gzip")[1]["schema"] == "nousos.review-graph/2"


def test_server_health_page_and_passage_search(tmp_path, monkeypatch):
    args, _ = fixture(tmp_path)
    build(**args, out=tmp_path / "out")
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>")
    (static / "review.js").write_text("export {};")
    holder = {}
    class FakeServer:
        def __init__(self, address, handler):
            holder["handler"] = handler
        def serve_forever(self):
            pass
        def server_close(self):
            pass
    monkeypatch.setattr("nous_os.graph_review.ThreadingHTTPServer", FakeServer)
    serve_graph(graph=tmp_path / "out", static_root=static)
    def get(path):
        handler = holder["handler"].__new__(holder["handler"])
        handler.path = path
        handler.wfile = io.BytesIO()
        handler.headers = {}
        handler.send_response = lambda code: setattr(handler, "status", code)
        handler.send_header = lambda key, value: None
        handler.end_headers = lambda: None
        handler.do_GET()
        return handler.status, handler.wfile.getvalue()
    status, body = get("/api/health")
    assert status == 200 and json.loads(body)["mode"] == "graph"
    assert get("/")[0] == 200 and get("/review.js")[0] == 200
    assert get("/elsewhere.js")[0] == 404
    # the span is the only text that says "conv1": search reaches it through the proposal's verified passage
    status, body = get("/api/graph/search?q=conv1")
    assert status == 200
    assert [(hit["id"], hit["match_field"]) for hit in json.loads(body)["results"]] == [("asr_one", "passage")]


def test_all_live_proposals_multi_conversation_and_primary_domain(tmp_path):
    args, citation = fixture(tmp_path)
    stores = args["stores"]
    raw = encoded({"container_external_id": "conv2", "role": "assistant", "created_at": "2026-02-02"})
    digest = hashlib.sha256(raw).hexdigest()
    path = stores / "snapshots" / "src_b" / f"{digest}.snapshot"
    path.parent.mkdir(parents=True)
    path.write_bytes(raw)
    start = raw.index(b"conv2")
    citation2 = {"source_id": "src_b", "snapshot_digest": digest, "start_byte": start,
                 "end_byte": start + 5, "span": "conv2"}
    with (stores / "ledger.jsonl").open("ab") as stream:
        stream.write(encoded({"source_id": "src_b", "snapshot_digest": digest}))
    with args["inventory"].open("ab") as stream:
        stream.write(encoded({"conversation": "conv2", "title": "✅ Done: Garden status", "messages_first": "2026-02-02"}))
    args["inventory"].write_bytes(args["inventory"].read_bytes().replace(b'"title":"Luminous garden"', b'"title":""'))
    membership = json.loads(args["membership"].read_text())
    membership["conversations"]["conv1"]["title"] = ""
    membership["conversations"]["conv2"] = {"title": "✅ Done: Garden status", "domains": ["quillmap", "forge"],
                                              "primary": "forge", "evidence": "fixture"}
    args["membership"].write_bytes(encoded(membership))
    content = {"kind": "DECISION", "statement": "Quillmap and FORGE meet in this decision.",
               "citations": [citation2, citation], "valid_to": None, "origin": "QUOTED"}
    unanchored = {"kind": "OPEN_QUESTION", "statement": "What material should we select?",
                  "citations": [citation], "valid_to": None}
    with (stores / "candidates/proposals.jsonl").open("ab") as stream:
        stream.write(encoded({"proposal_id": "asr_cross", "content": json.dumps(content)}))
        stream.write(encoded({"proposal_id": "asr_unanchored", "content": json.dumps(unanchored)}))
    manifest = build(**args, out=tmp_path / "out")
    nodes = {n["id"]: n for n in json.loads((tmp_path / "out/index.json").read_text())["nodes"]}
    assert nodes["asr_unanchored"]["domain_mentions"] == []
    assert nodes["asr_unanchored"]["domains"] == ["atlasfield", "meridian"]
    assert nodes["asr_cross"]["parent"] == "conversation:conv2"
    assert nodes["asr_cross"]["parents"] == ["conversation:conv2", "conversation:conv1"]
    assert set(nodes["asr_cross"]["domains"]) == {"atlasfield", "meridian", "quillmap", "forge"}
    assert nodes["conversation:conv2"]["primary_domain"] == "quillmap"
    assert nodes["conversation:conv2"]["title"] == "Garden status"
    assert nodes["conversation:conv2"]["title_full"].startswith("✅")
    assert nodes["conversation:conv1"]["title"].startswith("Senza titolo · ")
    assert nodes["asr_cross"]["importance"]["components"]["kind_weight"] == 2.0
    assert len({n["size"] for n in nodes.values() if n["level"] == 4}) > 1
    assert manifest["counts"]["level"]["4"] == 3


def test_outcomes_and_unknown_exploratory_logged(tmp_path):
    args, citation = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "outcomes.jsonl").write_bytes(encoded({"schema": "nousos.pass-outcome/1", "pass": "p2a",
        "conversation_id": "conv1", "outcome": "no_result"}))
    (overlay / "exploratory.jsonl").write_bytes(encoded({"schema": "nousos.exploratory-connection/1",
        "a": "asr_one", "b": "unknown", "inference": "analogy"}))
    (overlay / "relations-explicit.jsonl").write_bytes(encoded({"schema": "nousos.relation-explicit/1",
        "subject": [], "object": "asr_one", "predicate": "part_of", "evidence": [citation]}))
    manifest = build(**args, overlay=overlay, out=tmp_path / "out")
    assert manifest["outcomes"]["p2a"]["complete"]
    assert manifest["outcomes"]["p2b"]["missing"] == 1
    assert manifest["audit"]["dropped"]["exploratory unknown endpoint"] == 1
    assert manifest["audit"]["dropped"]["explicit relation unknown endpoint"] == 1


def test_overlay_membership_is_authoritative(tmp_path):
    args, _ = fixture(tmp_path)
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    authoritative = json.loads(args["membership"].read_text())
    authoritative["conversations"]["conv1"]["domains"] = ["forge"]
    authoritative["conversations"]["conv1"]["primary"] = "forge"
    (overlay / "membership.json").write_bytes(encoded(authoritative))
    build(**args, overlay=overlay, out=tmp_path / "out")
    nodes = {n["id"]: n for n in json.loads((tmp_path / "out/index.json").read_text())["nodes"]}
    assert nodes["asr_one"]["domains"] == ["forge"]
    assert nodes["conversation:conv1"]["primary_domain"] == "forge"
