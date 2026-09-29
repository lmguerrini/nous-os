"""Synthetic review graph v2 checks; no real corpus content is embedded here."""
import hashlib
import json
from pathlib import Path
import io
import gzip
import pytest

from nous_os.review_graph import assign_display_labels, build, encoded, label_phrase, short, shorten_title
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
    labels = {n["id"]: n["display_label"] for n in index["nodes"]}
    assert labels == {n["id"]: n["display_label"] for n in json.loads((tmp_path / "second/index.json").read_text())["nodes"]}
    assert first["display_labels"]["rule"] == "d072-display-label/5"
    assert first["display_labels"]["map_sha256"] == hashlib.sha256(encoded(labels)).hexdigest()
    assert all(label and len(label) <= 40 for label in labels.values())
    assert all(not label.casefold().startswith(("messaggio del fondatore", "il fondatore", "senza titolo"))
               for label in labels.values())


def test_title_first_and_formula_fallback():
    nodes = [
        {"id": "short", "level": 4, "parent": "conv", "title": "Pietra calda nel giardino", "subkind": "DECISION"},
        {"id": "long", "level": 4, "parent": "conv", "title": "Materiali luminosi per il giardino nella nuova installazione"},
        {"id": "empty", "level": 4, "parent": "conv", "title": ""},
        {"id": "untitled", "level": 4, "parent": "conv", "title": "Senza titolo"},
        {"id": "excerpt", "level": 4, "parent": "conv", "title": "«Si cerca una pietra…» · giardino"},
        {"id": "quoted", "level": 4, "parent": "conv", "title": "«Si cerca una pietra» · giardino"},
    ]
    source = {n["id"]: f"Raw statement for {n['id']} about a blue harbor" for n in nodes}
    assign_display_labels(nodes, source, {})
    labels = {n["id"]: n["display_label"] for n in nodes}
    assert labels["short"] == "Pietra calda nel giardino"
    assert labels["long"] == shorten_title(nodes[1]["title"])
    assert all("Raw statement" not in labels[key] for key in ("short", "long"))
    assert all(labels[key].startswith("Raw statement") for key in ("empty", "untitled", "excerpt", "quoted"))


@pytest.mark.parametrize(("title", "expected"), [
    ("Giardino luminoso per Atlasfield", "Giardino luminoso per Atlasfield"),
    ("Il fondatore approva filtri modulari per Quillmap", "Approva filtri modulari per Quillmap"),
    ("Messaggio del fondatore: Approva filtri modulari per Quillmap", "Approva filtri modulari per Quillmap"),
    ("The founder approves modular filters for the Quillmap installation", "Approves modular filters for Quillmap…"),
    ("Filtri modulari (versione preliminare) per Quillmap", "Filtri modulari per Quillmap"),
    ("Filtri modulari per Quillmap — versione preliminare", "Filtri modulari per Quillmap"),
    ("Filtri modulari per Quillmap: versione preliminare", "Filtri modulari per Quillmap"),
    ("La forma del giardino nella luce della sera", "forma giardino luce sera"),
    ("CAP-07 e EC-A/B/C/E guidano la revisione dettagliata del giardino luminoso", "CAP-07 e EC-A/B/C/E guidano revisione…"),
])
def test_shortening_steps(title, expected):
    assert shorten_title(title) == expected


@pytest.mark.parametrize("token", [
    "invented-garden-path-with-many-connected-parts",
    "synthetic/archive/path/with/several/segments",
    "imaginary.botanical.archive.with.many.parts",
    "z" * 80,
])
def test_shortening_caps_unbroken_tokens(token):
    shortened = shorten_title(token)
    assert len(shortened) <= 40
    assert shortened.endswith("…")
    assert len(label_phrase(token)) <= 40


def test_shortening_cap_property_for_deterministic_strings():
    pieces = ("invented", "synthetic-garden", "archive/path", "botanical.record", "leaf", "")
    for length in range(1, 101):
        value = "".join(pieces[(length + index * 3) % len(pieces)] for index in range(length))
        assert len(shorten_title(value)) <= 40
        assert len(label_phrase(value)) <= 40
    for value in ("Short invented title", "A compact garden label", "Synthetic archive"):
        assert shorten_title(value) == value
        assert label_phrase(value) == value


def test_shortening_removes_orphan_delimiters_and_keeps_balanced_quotes():
    cases = (
        ("Invented words for a synthetic garden archive with many later details ”", "”"),
        ("«Imaginary archive words describe a synthetic garden with extra details", "«"),
        ("Invented garden archive (synthetic botanical detail without a closing mark", "("),
    )
    for value, orphan in cases:
        for shorten in (shorten_title, label_phrase):
            result = shorten(value)
            assert orphan not in result
            assert len(result) <= 40
            assert shorten(value) == result

    balanced = "An “imaginary garden” archive with synthetic botanical details beyond the limit"
    for shorten in (shorten_title, label_phrase):
        result = shorten(balanced)
        assert "“imaginary garden”" in result
        assert len(result) <= 40


def test_names_qualifiers_and_sibling_collisions():
    nodes = [
        {"id": "domain", "level": 1, "parent": None, "title": "Quillmap"},
        {"id": "entity", "level": 2, "parent": "domain", "title": "Quillmap · progetto"},
        {"id": "conv", "level": 3, "parent": "entity", "title": "✅ Done: Giardino luminoso"},
        *({"id": f"proposal:{i}", "level": 4, "parent": "conv", "title": "Pietra calda nel giardino",
           "date": "2026-09-28"} for i in range(3)),
    ]
    assign_display_labels(nodes, {}, {n["id"]: n for n in nodes})
    assert [n["display_label"] for n in nodes[:3]] == ["Quillmap", "Quillmap · progetto", "Giardino luminoso"]
    labels = [n["display_label"] for n in nodes[3:]]
    assert len(set(labels)) == 3
    assert all(label.startswith("Pietra calda nel giardino · ") for label in labels)
    assert all("proposal:" not in label and len(label) <= 40 for label in labels)


def test_long_domain_and_entity_names_are_shortened_only_for_display():
    nodes = [
        {"id": "domain:invented", "level": 1, "parent": None,
         "title": "Invented Astronomical Cartography Observatory"},
        {"id": "entity:invented", "level": 2, "parent": "domain:invented",
         "title": "Imaginary Intercontinental Botanical Archive"},
        {"id": "domain:short", "level": 1, "parent": None, "title": "Short Domain"},
        {"id": "entity:short", "level": 2, "parent": "domain:short", "title": "Short Entity"},
    ]
    original_titles = {node["id"]: node["title"] for node in nodes}
    assign_display_labels(nodes, {}, {node["id"]: node for node in nodes})
    labels = {node["id"]: node["display_label"] for node in nodes}
    assert labels["domain:invented"] == shorten_title(original_titles["domain:invented"])
    assert labels["entity:invented"] == shorten_title(original_titles["entity:invented"])
    assert labels["domain:short"] == original_titles["domain:short"]
    assert labels["entity:short"] == original_titles["entity:short"]
    assert all(len(label) <= 40 for label in labels.values())
    assert {node["id"]: node["title"] for node in nodes} == original_titles


def test_collision_uses_parent_then_month_when_distinguishing():
    nodes = [
        {"id": "north", "level": 3, "parent": "domain", "title": "Giardino nord"},
        {"id": "south", "level": 3, "parent": "domain", "title": "Giardino sud"},
        {"id": "across:north", "level": 4, "parent": "north", "title": "Pietra calda"},
        {"id": "across:south", "level": 4, "parent": "south", "title": "Pietra calda"},
        {"id": "month:aug", "level": 4, "parent": "north", "title": "Luce soffusa", "date": "2026-08-01"},
        {"id": "month:sep", "level": 4, "parent": "north", "title": "Luce soffusa", "date": "2026-09-01"},
    ]
    assign_display_labels(nodes, {}, {n["id"]: n for n in nodes})
    labels = {n["id"]: n["display_label"] for n in nodes}
    assert labels["across:north"] == "Pietra calda · Giardino nord"
    assert labels["across:south"] == "Pietra calda · Giardino sud"
    assert labels["month:aug"] == "Luce soffusa · 2026-08"
    assert labels["month:sep"] == "Luce soffusa · 2026-09"


def test_collision_suffix_shortens_base_to_stay_within_cap():
    base = "Q" + "x" * 38
    nodes = [
        {"id": "near-cap:aug", "level": 4, "parent": "synthetic-parent", "title": base, "date": "2026-08-01"},
        {"id": "near-cap:sep", "level": 4, "parent": "synthetic-parent", "title": base, "date": "2026-09-01"},
    ]
    assign_display_labels(nodes, {}, {})
    labels = [node["display_label"] for node in nodes]
    assert labels[0].endswith(" · 2026-08")
    assert labels[1].endswith(" · 2026-09")
    assert all(len(label) <= 40 for label in labels)
    assert all(len(label.removesuffix(suffix)) == 30 for label, suffix in zip(
        labels, (" · 2026-08", " · 2026-09")))
    assert all(label.removesuffix(suffix).endswith("…") for label, suffix in zip(
        labels, (" · 2026-08", " · 2026-09")))


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


def store_layer_fixture(tmp_path):
    args, citation = fixture(tmp_path)
    stores = args["stores"]
    second = encoded({"container_external_id": "outside-membership", "role": "user", "created_at": "2026-01-02",
                      "message": "synthetic harbor"})
    digest = hashlib.sha256(second).hexdigest()
    path = stores / "snapshots/src_b" / f"{digest}.snapshot"
    path.parent.mkdir(parents=True)
    path.write_bytes(second)
    start = second.index(b"synthetic harbor")
    other_citation = {"source_id": "src_b", "snapshot_digest": digest, "start_byte": start,
                      "end_byte": start + len(b"synthetic harbor"), "span": "synthetic harbor"}
    with (stores / "ledger.jsonl").open("ab") as stream:
        stream.write(encoded({"source_id": "src_b", "snapshot_digest": digest}))
    content = {"kind": "DECISION", "statement": "A synthetic harbor decision.", "scope": "synthetic",
               "citations": [other_citation], "counter_citations": [], "valid_to": None,
               "valid_from": "2026-01-02", "origin": "USER_AUTHORED", "batch": "d069"}
    with (stores / "candidates/proposals.jsonl").open("ab") as stream:
        stream.write(encoded({"proposal_id": "asr_integrated", "content": json.dumps(content),
                              "source_id": "src_b", "proposed_at": "2026-01-02T00:00:00Z"}))
    integration = stores / "integrations/d069"
    integration.mkdir(parents=True)
    (integration / "candidates.jsonl").write_bytes(encoded({"proposal_id": "asr_integrated", "overlay_id": "ovl_synthetic",
        "batch_id": "d069", "dedup_key": "synthetic", "conversation_id": "conv1", "domains": ["atlasfield"]}))
    (integration / "mapping.json").write_bytes(encoded({"batch_id": "d069", "overlay_to_store": {
        "ovl_synthetic": "asr_integrated", "ent_old": "ent_store", "rel_old": "rel_store", "xpl_old": "xpl_store"}}))
    noncanonical = stores / "noncanonical"
    noncanonical.mkdir()
    (noncanonical / "entities.jsonl").write_bytes(encoded({"id": "ent_old", "overlay_id": "ent_old",
        "store_id": "ent_store", "batch_id": "d069", "epistemic_status": "non-canonical/attested",
        "name": "conv1", "type": "project", "aliases": [], "domains": ["atlasfield"], "evidence": [citation]}))
    (noncanonical / "explicit-relations.jsonl").write_bytes(encoded({"id": "rel_old", "overlay_id": "rel_old",
        "store_id": "rel_store", "batch_id": "d069", "epistemic_status": "non-canonical/attested",
        "schema": "nousos.relation-explicit/1", "subject": "ent_store", "object": "ent_store",
        "predicate": "part_of", "rule": "synthetic", "evidence": [{"proposal_id": "asr_one", "citation": citation}]}))
    interpretations = stores / "interpretations"
    interpretations.mkdir()
    (interpretations / "exploratory.jsonl").write_bytes(encoded({"id": "xpl_old", "overlay_id": "xpl_old",
        "store_id": "xpl_store", "batch_id": "d069", "epistemic_status": "exploratory/non-canonical",
        "schema": "nousos.exploratory-connection/1", "a": "asr_integrated", "b": "asr_one",
        "a_sources": [other_citation], "b_sources": [citation], "inference": "analogy",
        "explanation_it": "Synthetic analogy", "confidence": "low", "counter_evidence": ["synthetic limit"],
        "status": "exploratory/non-canonical"}))
    presentation = tmp_path / "presentation"
    presentation.mkdir()
    (presentation / "membership.json").write_bytes(args["membership"].read_bytes())
    (presentation / "titles.jsonl").write_bytes(encoded({"schema": "nousos.title/1", "id": "ovl_synthetic",
        "title_it": "Porto sintetico"}))
    (presentation / "outcomes.jsonl").write_bytes(b"".join(encoded({"schema": "nousos.pass-outcome/1",
        "pass": name, "conversation_id": "conv1", "outcome": "distilled"}) for name in ("p2a", "p2b")))
    args.update(membership=presentation / "membership.json", presentation=presentation, store_layer=True)
    return args, other_citation


def test_store_layer_placement_titles_marks_and_reconciliation(tmp_path):
    args, other_citation = store_layer_fixture(tmp_path)
    first = build(**args, out=tmp_path / "first", require_complete=True)
    second = build(**args, out=tmp_path / "second", require_complete=True)
    assert first["digest"] == second["digest"]
    assert (tmp_path / "first/manifest.json").read_bytes() == (tmp_path / "second/manifest.json").read_bytes()
    nodes = {n["id"]: n for n in json.loads((tmp_path / "first/index.json").read_text())["nodes"]}
    edges = json.loads((tmp_path / "first/index.json").read_text())["edges"]
    assert nodes["asr_integrated"]["parent"] == "conversation:conv1"
    assert nodes["asr_integrated"]["title"] == "Porto sintetico"
    assert nodes["asr_integrated"]["status"] == "proposal"
    assert nodes["asr_integrated"]["epistemic_status"] == "non-canonical/attested"
    assert nodes["ent_store"]["epistemic_status"] == "non-canonical/attested"
    detail = next(row for row in map(json.loads, (tmp_path / "first/details.jsonl").read_text().splitlines())
                  if row["id"] == "asr_integrated")
    assert detail["provenance_line"] == "integrata nella memoria globale · lotto d069"
    assert detail["citations"] == [other_citation]
    assert any(e["record_id"] == "rel_store" and e["epistemic_status"] == "non-canonical/attested" for e in edges)
    xpl = next(e for e in edges if e.get("record_id") == "xpl_store")
    assert xpl["status"] == "exploratory/non-canonical" and xpl["a_sources"] == [other_citation]
    assert xpl["counter_evidence"] == ["synthetic limit"]
    for layer in first["store_reconciliation"]["layers"].values():
        assert layer["store_count"] == layer["dataset_count"] == 1
        assert not layer["missing_from_dataset"] and not layer["missing_from_store"]
    files = first["store_reconciliation"]["store_files"]
    listed = json.loads((tmp_path / "first" / files["list"]).read_text())
    assert "snapshots/src_b/" + other_citation["snapshot_digest"] + ".snapshot" in listed
    assert files["count"] == len(listed) and not any(key.startswith("snapshots/") for key in files["core_sha256"])
    assert files["list_sha256"] == hashlib.sha256((tmp_path / "first" / files["list"]).read_bytes()).hexdigest()
    assert len((tmp_path / "first" / "manifest.json").read_bytes()) < first["limits"]["response_max_bytes"]


def test_store_layer_reconciliation_refuses_missing_record(tmp_path):
    args, _ = store_layer_fixture(tmp_path)
    path = args["stores"] / "interpretations/exploratory.jsonl"
    row = json.loads(path.read_text())
    row["b"] = "absent_synthetic_endpoint"
    path.write_bytes(encoded(row))
    with pytest.raises(ValueError, match="store reconciliation incomplete"):
        build(**args, out=tmp_path / "refused", require_complete=True)
    assert not (tmp_path / "refused/manifest.json").exists()


def test_store_layer_rejects_forged_exploratory_source(tmp_path):
    args, _ = store_layer_fixture(tmp_path)
    path = args["stores"] / "interpretations/exploratory.jsonl"
    row = json.loads(path.read_text())
    row["b_sources"][0]["span"] = "forged synthetic text"
    path.write_bytes(encoded(row))
    with pytest.raises(ValueError, match="store reconciliation incomplete"):
        build(**args, out=tmp_path / "refused", require_complete=True)


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
    assert edges[0]["record_id"] == "p2b-1"
    assert [(r["record_id"], r["explanation"]) for r in edges[0]["merged_records"]] == [("p2b-2", "Second reading")]


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
    membership = json.loads(args["membership"].read_bytes())
    membership["conversations"]["conv1"]["title"] = "Luminous garden conversations around invented materials and distant constellations"
    args["membership"].write_bytes(encoded(membership))
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
    # The panel heading is short; search must still accept words from its full title.
    assert "constellations" not in next(node["title"] for node in query("index")[1]["nodes"] if node["id"] == "conversation:conv1").lower()
    assert any(hit["id"] == "conversation:conv1" and hit["match_field"] == "title_full"
               for hit in query("search?q=constellations")[1]["results"])
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
