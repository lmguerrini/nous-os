"""Deterministic, read-only D-065 review export and loopback explorer."""
from __future__ import annotations

import argparse
from collections import Counter, OrderedDict
from datetime import datetime, timezone
import hashlib
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import random
import re
import signal
import sys
import threading
from urllib.parse import parse_qsl, urlsplit

from nous_os import core
from nous_os.capability import Grant, Tier
from nous_os.graph_view import _outside_repo

SCHEMA = "nousos-graph-review-1"
DOMAINS = ("Atlasfield", "ATLASvault", "Quillmap", "Orchardline", "NousOS", "FORGE", "Showcase", "Dossier", "QRS")
NODE_MODEL = {
    "domain": "Named review domain; its link_count counts cards tagged with it.",
    "connection": "D-065 connection card; A/B/C/D is a provisional review class.",
    "evidence": "Distinct cited source span (source ID and byte range); duplicates merge.",
    "record": "Cited source record; founder or assistant voice and bounded context.",
    "conversation": "Source container; project name is inferred by inventory v1.",
    "candidate": "Distilled proposal with standing as recorded in D-065.",
    "canon": "Promoted canonical assertion returned by canon.assertions.",
}
EDGE_MODEL = {
    "links": "connection → domain; D-065 review tagging, not founder wording",
    "supported_by": "connection → evidence; D-065 card",
    "quotes": "evidence → record; provenance.span byte range",
    "in_conversation": "record → conversation; knowledge.context",
    "classified_in": "conversation → domain; inventory v1 inferred project (A or B only)",
    "distilled_as": "evidence → candidate; D-065 card",
    "promoted_as": "candidate → canon; canon.assertions",
}
ATTESTED = {"links": "d065-review-tagging", "supported_by": "d065-card", "quotes": "provenance.span",
            "in_conversation": "knowledge.context", "classified_in": "inventory-v1 (project name inferred)",
            "distilled_as": "d065-card", "promoted_as": "canon.assertions"}
NOTICE = {"it": "Proiezione di revisione di dati NousOS verificati: non è canon né un modello finale. La distanza nel layout non è una relazione.",
          "en": "Review projection of verified NousOS data: not canon or a final model. Layout distance is not a relation."}


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_env(path: Path) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*export\s+([A-Z0-9_]+)=(.*)\s*", line)
        if match:
            os.environ[match[1]] = os.path.expandvars(match[2].strip().strip('"').strip("'"))


def jsonl(path: Path) -> list[dict]:
    try:
        with path.open(encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"missing, unreadable, or invalid input {path}: {error}") from error


def error_code(error: Exception) -> str:
    return getattr(error, "code", None) or type(error).__name__


def excerpt(record: dict) -> dict:
    body = record.get("body")
    try:
        value = json.loads(body) if isinstance(body, str) else body
        if isinstance(value, dict):
            payload = value.get("payload", value)
            content = payload.get("content", payload) if isinstance(payload, dict) else payload
            if isinstance(content, dict):
                parts = content.get("parts")
                if isinstance(parts, list):
                    text = " ".join(part if isinstance(part, str) else f"[{part.get('content_type', part.get('type', 'object'))}]" for part in parts)
                else:
                    text = f"[{content.get('content_type', value.get('content_type', 'content'))}]"
            else:
                text = f"[{value.get('content_type', 'content')}]"
        else:
            text = str(value)
    except (ValueError, TypeError):
        text = str(body or "")
    return {"source_id": record.get("source_id"), "role": record.get("role"),
            "created_at": record.get("created_at"), "text": text[:700], "truncated": len(text) > 700}


def layout(nodes: list[dict], edges: list[dict], dimensions: int) -> dict:
    """Seeded force layout with nine fixed, evenly spaced domain anchors."""
    ids = [node["id"] for node in nodes]
    kinds = {node["id"]: node["type"] for node in nodes}
    domains = sorted((node for node in nodes if node["type"] == "domain"), key=lambda node: node["label"])
    rng = random.Random(6600 + dimensions)
    radius = 0.72
    positions: dict[str, list[float]] = {}
    for index, node in enumerate(domains):
        if dimensions == 2:
            angle = 2 * math.pi * index / len(domains)
            positions[node["id"]] = [radius * math.cos(angle), radius * math.sin(angle)]
        else:
            z = 1 - 2 * (index + 0.5) / len(domains)
            angle = index * math.pi * (3 - math.sqrt(5))
            positions[node["id"]] = [radius * math.sqrt(1 - z * z) * math.cos(angle),
                                      radius * math.sqrt(1 - z * z) * math.sin(angle), radius * z]
    pinned = set(positions)
    neighbours: dict[str, list[str]] = {identifier: [] for identifier in ids}
    links = [(edge["source"], edge["target"]) for edge in edges]
    for left, right in links:
        neighbours[left].append(right)
        neighbours[right].append(left)
    # Seed the remaining nodes near their connected domains, then let the force
    # simulation place all non-domain nodes while the anchors stay fixed.
    for _ in range(5):
        for identifier in ids:
            if identifier in positions:
                continue
            known = [positions[other] for other in neighbours[identifier] if other in positions]
            if known:
                positions[identifier] = [sum(point[axis] for point in known) / len(known) + rng.uniform(-0.07, 0.07)
                                         for axis in range(dimensions)]
    for identifier in ids:
        positions.setdefault(identifier, [rng.uniform(-0.25, 0.25) for _ in range(dimensions)])
    sizes = {"domain": 0.075, "connection": 0.06, "evidence": 0.027, "record": 0.034,
             "conversation": 0.045, "candidate": 0.037, "canon": 0.045}
    iterations = 160
    for step in range(iterations):
        forces = {identifier: [0.0] * dimensions for identifier in ids}
        for i, left in enumerate(ids):
            for right in ids[i + 1:]:
                delta = [positions[left][axis] - positions[right][axis] for axis in range(dimensions)]
                distance = max(0.0001, math.sqrt(sum(x * x for x in delta)))
                minimum = sizes[kinds[left]] + sizes[kinds[right]]
                magnitude = 0.0001 / (distance * distance) + 0.45 * max(0, minimum - distance)
                for axis in range(dimensions):
                    change = delta[axis] / distance * magnitude
                    forces[left][axis] += change
                    forces[right][axis] -= change
        for left, right in links:
            delta = [positions[right][axis] - positions[left][axis] for axis in range(dimensions)]
            distance = max(0.0001, math.sqrt(sum(x * x for x in delta)))
            ideal = 0.24 if kinds[left] == "domain" or kinds[right] == "domain" else 0.15
            magnitude = 0.12 * (distance - ideal)
            for axis in range(dimensions):
                change = delta[axis] / distance * magnitude
                forces[left][axis] += change
                forces[right][axis] -= change
        temperature = 0.035 * (1 - step / iterations) + 0.001
        for identifier in ids:
            if identifier in pinned:
                continue
            norm = math.sqrt(sum(value * value for value in forces[identifier]))
            if norm:
                for axis in range(dimensions):
                    positions[identifier][axis] = max(-0.96, min(0.96, positions[identifier][axis] +
                        forces[identifier][axis] / norm * min(norm, temperature)))
    # Resolve residual collisions after the springs settle. Anchors never move.
    for _ in range(100):
        overlaps = 0
        for i, left in enumerate(ids):
            for right in ids[i + 1:]:
                delta = [positions[left][axis] - positions[right][axis] for axis in range(dimensions)]
                distance = math.sqrt(sum(value * value for value in delta))
                minimum = sizes[kinds[left]] + sizes[kinds[right]] + 0.0001
                if distance >= minimum:
                    continue
                overlaps += 1
                if distance < 1e-9:
                    delta = [rng.uniform(-1, 1) for _ in range(dimensions)]
                    distance = math.sqrt(sum(value * value for value in delta))
                movable = int(left not in pinned) + int(right not in pinned)
                if not movable:
                    continue
                shift = (minimum - distance) / movable
                for axis in range(dimensions):
                    change = delta[axis] / distance * shift
                    if left not in pinned:
                        positions[left][axis] = max(-0.98, min(0.98, positions[left][axis] + change))
                    if right not in pinned:
                        positions[right][axis] = max(-0.98, min(0.98, positions[right][axis] - change))
        if not overlaps:
            break
    # Uniform scaling preserves the anchor circle/sphere and comparable 3D axes.
    extent = max(1.0, *(abs(value) for point in positions.values() for value in point))
    return {identifier: [round(value / extent, 6) for value in positions[identifier]] for identifier in ids}


def build(*, cards: list[dict], inventory: list[dict], workspace, context_window: int = 2) -> dict:
    if not 0 <= context_window <= 20:
        raise ValueError("context must be between 0 and 20")
    grant = Grant("graph-review", frozenset({Tier.READ}))
    invoke = lambda op, args: core.invoke(grant, op, workspace, args)
    canon_result = invoke("canon.assertions", {})
    canon_rows = {row["candidate_id"]: row for row in canon_result["assertions"] if row.get("state") == "canonical"}
    inventory_by_id = {row["conversation"]: row for row in inventory}
    nodes: dict[str, dict] = {}
    edges: dict[tuple[str, str, str], dict] = {}
    citations_total = 0
    citations_verified = 0
    record_context: dict[str, dict | None] = {}
    context_errors: dict[str, str] = {}
    for domain in DOMAINS:
        nodes[f"domain:{domain}"] = {"id": f"domain:{domain}", "type": "domain", "label": domain,
                                     "epistemic": "structural", "link_count": 0}

    def edge(kind: str, source: str, target: str, evidence_id: str | None = None, **extra):
        key = (kind, source, target)
        item = edges.setdefault(key, {"id": f"{kind}:{source}->{target}", "type": kind, "source": source,
                                      "target": target, "attested_by": ATTESTED[kind], "weight": 1,
                                      "evidence_ids": []})
        if evidence_id and evidence_id not in item["evidence_ids"]:
            item["evidence_ids"].append(evidence_id)
            item["weight"] = len(item["evidence_ids"])
        item.update(extra)

    for card in sorted(cards, key=lambda x: x["id"]):
        cid = f"connection:{card['id']}"
        nodes[cid] = {"id": cid, "type": "connection", "label": card["title"], "epistemic": card["epistemic_class"],
                      **{key: card.get(key) for key in ("title", "statement", "why_it_matters", "confidence", "confidence_rationale",
                          "overinterpretation_risk", "contradictions_or_evolution", "suggested_action", "class_rationale", "rank")}}
        domains = set()
        for name in card["linked"]:
            domains.update(("Showcase", "Dossier") if name == "Showcase / Dossier" else (name,))
        for domain in sorted(domains):
            if domain not in DOMAINS:
                raise ValueError(f"unknown linked domain: {domain}")
            nodes[f"domain:{domain}"]["link_count"] += 1
            edge("links", cid, f"domain:{domain}")
        for item in card["evidence"]:
            citations_total += 1
            source_id = item["source_id"]
            eid = f"evidence:{source_id}:{item['start_byte']}:{item['end_byte']}"
            rid = f"record:{source_id}"
            citation = {key: item[key] for key in ("source_id", "snapshot_digest", "start_byte", "end_byte", "span")}
            try:
                actual = invoke("provenance.span", {"citation": citation})
                verified = actual == item["span"]
                failure = None if verified else "SPAN_MISMATCH"
            except Exception as error:
                verified = False
                failure = error_code(error)
            citations_verified += int(verified)
            if eid not in nodes:
                nodes[eid] = {"id": eid, "type": "evidence", "label": item["span"][:72], "epistemic": "source",
                              "source_id": source_id, "snapshot_digest": item["snapshot_digest"],
                              "start_byte": item["start_byte"], "end_byte": item["end_byte"], "span": item["span"],
                              "verified": verified, "verification_error": failure, "role": item["role"], "date": item["date"]}
            else:
                nodes[eid]["verified"] = nodes[eid]["verified"] and verified
                if failure:
                    nodes[eid]["verification_error"] = failure
            if source_id not in record_context:
                try:
                    raw_context = invoke("knowledge.context", {"source_id": source_id, "before": context_window, "after": context_window})
                    record_context[source_id] = {key: [excerpt(x) for x in raw_context[key]] if key != "target" else excerpt(raw_context[key])
                                                 for key in ("before", "target", "after")}
                    context_errors[source_id] = ""
                    conversation = raw_context.get("container") or item.get("container")
                    target = raw_context["target"]
                except Exception as error:
                    record_context[source_id] = None
                    context_errors[source_id] = error_code(error)
                    conversation = item.get("container")
                    target = {}
                nodes[rid] = {"id": rid, "type": "record", "label": source_id, "epistemic": "source", "source_id": source_id,
                              "role": target.get("role", item["role"]), "date": target.get("created_at", item["date"]),
                              "snapshot_digest": target.get("snapshot_digest", item["snapshot_digest"]),
                              "conversation_id": conversation, "context": record_context[source_id],
                              "context_error": context_errors[source_id] or None}
                if conversation:
                    vid = f"conversation:{conversation}"
                    inv = inventory_by_id.get(conversation, {})
                    nodes[vid] = {"id": vid, "type": "conversation", "label": inv.get("title") or conversation,
                                  "epistemic": "structural", "conversation_id": conversation,
                                  "category": inv.get("category"), "project_id": inv.get("project_id"),
                                  "project_name_inferred": inv.get("project_name_inferred"), "name_inferred": True}
                    if record_context[source_id] is not None:
                        edge("in_conversation", rid, vid, eid)
                    for domain in (("Atlasfield", "ATLASvault") if inv.get("category") == "A" else ("FORGE",) if inv.get("category") == "B" else ()):
                        edge("classified_in", vid, f"domain:{domain}")
            edge("supported_by", cid, eid, eid)
            edge("quotes", eid, rid, eid, start_byte=item["start_byte"], end_byte=item["end_byte"])
            candidate_id = item.get("candidate_id")
            if candidate_id:
                pid = f"candidate:{candidate_id}"
                canonical = canon_rows.get(candidate_id)
                standing = item.get("canonical_status") or "non_canonical"
                if pid not in nodes:
                    nodes[pid] = {"id": pid, "type": "candidate", "label": candidate_id, "epistemic": "canonical" if canonical else "proposal",
                                  "candidate_id": candidate_id, "standing": standing, "epistemic_label": item.get("epistemic_label"),
                                  "candidate_version": canonical.get("candidate_version") if canonical else item.get("candidate_version")}
                edge("distilled_as", eid, pid, eid)
                if canonical:
                    aid = f"canon:{canonical['assertion_id']}"
                    nodes[aid] = {"id": aid, "type": "canon", "label": canonical["text"][:72], "epistemic": "canonical",
                                  "assertion_id": canonical["assertion_id"], "text": canonical["text"],
                                  "standing": "canonical", "epistemic_label": "CANONICAL",
                                  "candidate_version": canonical.get("candidate_version")}
                    edge("promoted_as", pid, aid)
    # Count distinct cited spans behind structural edges as well as citation edges.
    for (kind, source, target), item in edges.items():
        if kind == "links":
            upstream = [value for (edge_kind, edge_source, _), value in edges.items()
                        if edge_kind == "supported_by" and edge_source == source]
        elif kind == "in_conversation":
            upstream = [value for (edge_kind, _, edge_target), value in edges.items()
                        if edge_kind == "quotes" and edge_target == source]
        elif kind == "classified_in":
            upstream = [value for (edge_kind, _, edge_target), value in edges.items()
                        if edge_kind == "in_conversation" and edge_target == source]
        elif kind == "promoted_as":
            upstream = [value for (edge_kind, _, edge_target), value in edges.items()
                        if edge_kind == "distilled_as" and edge_target == source]
        else:
            continue
        item["evidence_ids"] = sorted({identifier for value in upstream for identifier in value["evidence_ids"]})
        item["weight"] = max(1, len(item["evidence_ids"]))
    node_list = [nodes[key] for key in sorted(nodes)]
    edge_list = [edges[key] for key in sorted(edges)]
    counts = Counter(node["type"] for node in node_list)
    return {"schema": SCHEMA, "review_projection": True, "notice": NOTICE,
            "model": {"nodes": NODE_MODEL, "edges": EDGE_MODEL,
                      "weight": "Number of distinct evidence rows behind an edge; not epistemic strength.",
                      "epistemic": "Connection A/B/C/D is provisional; candidate/canon distinguish proposal and canonical; evidence/record are source; domain/conversation are structural.",
                      "layout": "Position and proximity are visual projections, never relations.",
                      "versions": "Candidate version is retained where present; replaced proposals absent from the D-065 package are not shown."},
            "nodes": node_list, "edges": edge_list,
            "layouts": {"parameters": {"algorithm": "seeded force with pinned domain anchors", "seed_2d": 6602, "seed_3d": 6603,
                                       "iterations": 160, "anchor_order": "domain label ascending", "anchor_radius": 0.72,
                                       "anchors_2d": "even circle", "anchors_3d": "Fibonacci sphere",
                                       "repulsion": 0.0001, "collision_force": 0.45, "spring_force": 0.12,
                                       "spring_length_domain": 0.24, "spring_length_other": 0.15,
                                       "collision_resolution_passes": 100,
                                       "simulation_axis_limit": 0.96, "collision_axis_limit": 0.98,
                                       "minimum_distance_by_type": {"domain": 0.075, "connection": 0.06, "evidence": 0.027,
                                                                    "record": 0.034, "conversation": 0.045, "candidate": 0.037, "canon": 0.045},
                                       "normalization": "uniform scale into [-1,1]"},
                        "2d": layout(node_list, edge_list, 2), "3d": layout(node_list, edge_list, 3)},
            "stats": {"nodes": len(node_list), "edges": len(edge_list), "node_types": dict(sorted(counts.items()))},
            "verification": {"citations_total": citations_total, "citations_verified": citations_verified,
                             "records_with_context": sum(value is not None for value in record_context.values()),
                             "records_without_context": sum(value is None for value in record_context.values())}}


def export(*, package: Path, inventory: Path, out: Path, workspace, context_window: int = 2) -> dict:
    _outside_repo(out)
    cards_path = package / "COLLEGAMENTI-D065.jsonl"
    cards = jsonl(cards_path)
    inventory_rows = jsonl(inventory)
    if not cards or not inventory_rows:
        raise ValueError("package and inventory must contain readable rows")
    candidate_path = workspace.candidate_store_path
    canon_path = workspace.canon_root_path / "assertions.jsonl"
    result = build(cards=cards, inventory=inventory_rows, workspace=workspace, context_window=context_window)
    result["inputs"] = {"package_sha256": file_digest(cards_path), "inventory_sha256": file_digest(inventory),
                        "candidates_sha256": file_digest(candidate_path), "canon_sha256": file_digest(canon_path)}
    result["export_digest"] = digest(result)
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    # The sidecar holds the content digest (canonical JSON without generated_at and export_digest), not a hash of the
    # file bytes: regenerating the same inputs keeps this digest while the bytes change with generated_at.
    Path(str(out) + ".sha256").write_text(result["export_digest"] + "\n", encoding="ascii")
    return result


def load_export(path: Path) -> dict:
    result = json.loads(path.read_text(encoding="utf-8"))
    if result.get("schema") != SCHEMA or result.get("export_digest") != digest({k: v for k, v in result.items() if k not in {"generated_at", "export_digest"}}):
        raise ValueError("export digest mismatch or invalid schema")
    return result


def load_lenses(path: Path) -> dict:
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict) or result.get("schema") != "nousos-review-lenses-1":
        raise ValueError("invalid review lenses schema")
    return result


def dynamic_edge(kind: str, source: str, target: str, attested_by: str, **extra) -> dict:
    return {"id": f"{kind}:{source}->{target}", "type": kind, "source": source, "target": target,
            "attested_by": attested_by, "origin": "dynamic", "weight": 1, "evidence_ids": [], **extra}


def dynamic_hit(hit: dict, query: str) -> dict:
    """Project one product search hit; only an exact assertion makes it canon."""
    canonical = hit.get("canonical_status") == "canonical" and bool(hit.get("assertion_id"))
    cid = hit["candidate_id"]
    node = {"id": f"candidate:{cid}", "type": "candidate", "label": hit["statement"][:72],
            "text": hit["statement"], "epistemic": "canonical" if canonical else "proposal",
            "origin": "dynamic", "origin_query": query, "attested_by": "candidate.search",
            "candidate_id": cid, "candidate_version": hit.get("candidate_version"),
            "standing": hit.get("canonical_status"), "epistemic_label": hit.get("epistemic_label"),
            "kind": hit.get("kind"), "scope": hit.get("scope"), "valid_from": hit.get("valid_from"),
            "replaced": hit.get("replaced"), "superseded_by": hit.get("superseded_by"),
            "rank": hit.get("rank")}
    nodes = [node]
    edges = []
    for citation in hit.get("citations", [])[:40]:
        eid = f"evidence:{citation['source_id']}:{citation['start_byte']}:{citation['end_byte']}"
        nodes.append({"id": eid, "type": "evidence", "label": citation["span"][:72],
                      "epistemic": "source", "origin": "dynamic", "origin_query": query,
                      "attested_by": "candidate.search", **citation})
        edges.append(dynamic_edge("supported_by", node["id"], eid, "candidate.search",
                                  origin_query=query, evidence_ids=[eid]))
    if canonical:
        aid = f"canon:{hit['assertion_id']}"
        nodes.append({"id": aid, "type": "canon", "label": hit["statement"][:72], "text": hit["statement"],
                      "epistemic": "canonical", "standing": "canonical", "origin": "dynamic",
                      "origin_query": query, "attested_by": "candidate.search", "assertion_id": hit["assertion_id"]})
        edges.append(dynamic_edge("promoted_as", node["id"], aid, "candidate.search", origin_query=query))
    return {"nodes": nodes, "edges": edges}


def dynamic_expand_ids(hit: dict) -> set[str]:
    ids = {node["id"] for node in dynamic_hit(hit, "")["nodes"]}
    ids.update(f"record:{citation['source_id']}" for citation in hit.get("citations", []))
    return ids


def curated_hit(node: dict, result: dict) -> dict:
    """Recover only citations already linked to this candidate in the verified export."""
    by_id = {item["id"]: item for item in result["nodes"]}
    evidence = [by_id[edge["source"]] for edge in result["edges"]
                if edge["type"] == "distilled_as" and edge["target"] == node["id"] and edge["source"] in by_id]
    promoted = next((edge for edge in result["edges"]
                     if edge["type"] == "promoted_as" and edge["source"] == node["id"]), None)
    return {"candidate_id": node["candidate_id"], "statement": node.get("text") or node["label"],
            "candidate_version": node.get("candidate_version"),
            "canonical_status": "canonical" if promoted else "non_canonical",
            "assertion_id": promoted["target"].split(":", 1)[1] if promoted else None,
            "epistemic_label": node.get("epistemic_label"), "kind": node.get("kind"), "scope": node.get("scope"),
            "valid_from": node.get("valid_from"), "replaced": False, "superseded_by": None, "rank": None,
            "citations": [{key: item[key] for key in ("source_id", "snapshot_digest", "start_byte", "end_byte", "span")}
                          for item in evidence]}


def dynamic_expand(hit: dict, query: str, invoke, limit: int) -> dict:
    """Recheck selected spans and read only their bounded record context."""
    graph = dynamic_hit(hit, query)
    nodes = graph["nodes"][:1]
    edges = []
    # Every element of one expansion names the step that produced it, beside the query (if any) and its attestation.
    step = f"expand:{nodes[0]['id']}"
    origin = {"origin_query": query or None, "expansion_step": step}
    for citation in hit.get("citations", [])[:limit]:
        eid = f"evidence:{citation['source_id']}:{citation['start_byte']}:{citation['end_byte']}"
        try:
            verified = invoke("provenance.span", {"citation": citation}) == citation["span"]
            failure = None if verified else "SPAN_MISMATCH"
        except Exception as error:
            verified, failure = False, error_code(error)
        nodes.append({"id": eid, "type": "evidence", "label": citation["span"][:72],
                      "epistemic": "source", "origin": "dynamic", **origin,
                      "attested_by": "provenance.span", "verified": verified,
                      "verification_error": failure, **citation})
        edges.append(dynamic_edge("supported_by", nodes[0]["id"], eid, "candidate.search", evidence_ids=[eid], **origin))
        try:
            context = invoke("knowledge.context", {"source_id": citation["source_id"], "before": 2, "after": 2})
            rid = f"record:{citation['source_id']}"
            target = context["target"]
            nodes.append({"id": rid, "type": "record", "label": citation["source_id"],
                          "epistemic": "source", "origin": "dynamic", **origin,
                          "attested_by": "knowledge.context", "source_id": citation["source_id"],
                          "snapshot_digest": target.get("snapshot_digest"), "role": target.get("role"),
                          "date": target.get("created_at"),
                          "context": {key: excerpt(context[key]) if key == "target" else
                                      [excerpt(row) for row in context[key]] for key in ("before", "target", "after")},
                          "conversation_id": context.get("container")})
            edges.append(dynamic_edge("quotes", eid, rid, "provenance.span", evidence_ids=[eid], **origin))
            if context.get("container"):
                vid = f"conversation:{context['container']}"
                nodes.append({"id": vid, "type": "conversation", "label": context["container"],
                              "epistemic": "structural", "origin": "dynamic", **origin,
                              "attested_by": "knowledge.context", "conversation_id": context["container"]})
                edges.append(dynamic_edge("in_conversation", rid, vid, "knowledge.context", evidence_ids=[eid], **origin))
        except Exception as error:
            nodes[-1]["context_error"] = error_code(error)
    canonical = graph["nodes"][-1] if graph["nodes"][-1]["type"] == "canon" else None
    if canonical:
        assertion = invoke("canon.assertions", {"assertion_id": hit["assertion_id"]})
        rows = assertion.get("assertions", [])
        if any(row.get("candidate_id") == hit["candidate_id"] and row.get("state") == "canonical" for row in rows):
            nodes.append({**canonical, "attested_by": "canon.assertions", **origin})
            edges.append(dynamic_edge("promoted_as", nodes[0]["id"], canonical["id"], "canon.assertions", **origin))
    nodes[0] = {**nodes[0], **origin}
    unique = {node["id"]: node for node in nodes}
    return {"nodes": list(unique.values()), "edges": edges,
            "relations": "No product relation operation filters by candidate; relation expansion unavailable."}


def make_handler(result: dict, static_root: Path, lenses: dict | None = None, workspace=None):
    export_body = json.dumps(result, ensure_ascii=False, sort_keys=True).encode("utf-8")
    lenses_body = json.dumps(lenses, ensure_ascii=False, sort_keys=True).encode("utf-8") if lenses is not None else None
    health = {"status": "ok", "export_digest": result["export_digest"]}
    if workspace is not None:
        health["live"] = True
    health_body = canonical_bytes(health)
    root = static_root.resolve()
    hits: OrderedDict[str, tuple[dict, str]] = OrderedDict()
    expanded_ids: dict[str, str] = {}
    hits_lock = threading.Lock()
    curated = {node["id"]: node for node in result.get("nodes", [])}
    identifier = re.compile(
        r"(?:candidate|canon|record|conversation|connection|domain):[A-Za-z0-9_.-]+"
        r"|evidence:[A-Za-z0-9_.-]+:[0-9]+:[0-9]+"
    )

    def invoke(op: str, args: dict) -> dict:
        return core.invoke(Grant("graph-review-live", frozenset({Tier.READ})), op, workspace, args)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            def fail(code: int, message: str):
                body = canonical_bytes({"error": message})
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                fail(404, "route not found")
                return
            route = parsed.path
            if route in {"/api/search", "/api/expand"}:
                if workspace is None:
                    fail(404, "dynamic mode inactive")
                    return
                try:
                    params = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
                    expected = {"q", "limit"} if route == "/api/search" else {"id", "limit"}
                    if not params or len(params) != len({key for key, _ in params}) or any(k not in expected for k, _ in params):
                        raise ValueError("invalid query parameters")
                    args = dict(params)
                    limit = int(args.get("limit", "10" if route == "/api/search" else "20"))
                    maximum = 20 if route == "/api/search" else 40
                    if not 1 <= limit <= maximum:
                        raise ValueError("limit out of range")
                    if route == "/api/search":
                        query = args.get("q", "")
                        if not query.strip() or len(query) > 200:
                            raise ValueError("invalid query length")
                        search = invoke("candidate.search", {"query": query, "limit": limit})
                        graphs = []
                        for hit in search["hits"]:
                            graphs.append(dynamic_hit(hit, query))
                            with hits_lock:
                                hits[f"candidate:{hit['candidate_id']}"] = (hit, query)
                                hits.move_to_end(f"candidate:{hit['candidate_id']}")
                                while len(hits) > 100:
                                    expired, _ = hits.popitem(last=False)
                                    for key in [key for key, value in expanded_ids.items() if value == expired]:
                                        del expanded_ids[key]
                        payload = {"query": query, "results": graphs, "total_matched": search["total_matched"]}
                    else:
                        node_id = args.get("id", "")
                        if not identifier.fullmatch(node_id) or len(node_id) > 180:
                            raise ValueError("invalid node id")
                        with hits_lock:
                            found = hits.get(node_id) or hits.get(expanded_ids.get(node_id, ""))
                            if found is None:
                                for cached, query in hits.values():
                                    if node_id in {node["id"] for node in dynamic_expand_ids(cached)}:
                                        found = (cached, query)
                                        break
                        if found:
                            payload = dynamic_expand(*found, invoke, limit)
                            with hits_lock:
                                for node in payload["nodes"]:
                                    expanded_ids[node["id"]] = f"candidate:{found[0]['candidate_id']}"
                        elif node_id in curated and curated[node_id]["type"] == "candidate":
                            payload = dynamic_expand(curated_hit(curated[node_id], result), "", invoke, limit)
                        elif node_id in curated:
                            edge_rows = [edge for edge in result["edges"]
                                         if edge["source"] == node_id or edge["target"] == node_id][:limit]
                            ids = {node_id, *(value for edge in edge_rows for value in (edge["source"], edge["target"]))}
                            payload = {"nodes": [{**curated[key], "origin": "dynamic", "attested_by": "review.export"}
                                                 for key in ids if key in curated],
                                       "edges": [{**edge, "origin": "dynamic"} for edge in edge_rows],
                                       "relations": "Existing curated relations only; "
                                                    "no candidate-filtered product relation operation."}
                        else:
                            fail(404, "node not found in this session")
                            return
                    body = canonical_bytes(payload)
                    if len(body) > 262144:
                        fail(413, "response exceeds 256 KiB")
                        return
                    mime = "application/json; charset=utf-8"
                except (ValueError, KeyError, TypeError) as error:
                    fail(400, str(error))
                    return
                except Exception as error:
                    fail(502, error_code(error))
                    return
            elif parsed.query or "?" in self.path:
                fail(400, "query not allowed")
                return
            elif route == "/api/health":
                body, mime = health_body, "application/json; charset=utf-8"
            elif route == "/api/export.json":
                body, mime = export_body, "application/json; charset=utf-8"
            elif route == "/api/lenses.json":
                if lenses_body is None:
                    body = b'{"error":"review lenses not supplied"}'
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body, mime = lenses_body, "application/json; charset=utf-8"
            elif route in {"/", "/index.html", "/review.js"}:
                name = "index.html" if route == "/" else route[1:]
                target = (root / name).resolve()
                if not target.is_relative_to(root) or not target.is_file():
                    fail(404, "static file not found")
                    return
                body = target.read_bytes()
                mime = "text/html; charset=utf-8" if name == "index.html" else "text/javascript; charset=utf-8"
            else:
                fail(404, "route not found")
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass
    return Handler


def serve(*, export_path: Path, static_root: Path = Path("ui/dist/review"), port: int = 8766,
          lenses_path: Path | None = None, live: bool = False) -> None:
    result = load_export(export_path)
    lenses = load_lenses(lenses_path) if lenses_path is not None else None
    workspace = core.resolve_workspace() if live else None
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(result, static_root, lenses, workspace))
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        server.serve_forever()
    finally:
        server.server_close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def serve_graph(*, graph: Path, port: int = 8769, static_root: Path | None = None) -> None:
    """Serve a verified v2 dataset and the built page without accessing the underlying stores."""
    from nous_os.review_graph import encoded, normalize

    manifest = json.loads((graph / "manifest.json").read_bytes())
    if manifest.get("schema") != "nousos.review-graph/2":
        raise ValueError("invalid graph schema")
    expected = manifest.get("digest")
    actual = hashlib.sha256(encoded({k: v for k, v in manifest.items() if k != "digest"})).hexdigest()
    if actual != expected:
        raise ValueError("graph manifest digest mismatch")
    for name, checksum in manifest["files"].items():
        if file_digest(graph / name) != checksum:
            raise ValueError(f"graph file digest mismatch: {name}")
    index = json.loads((graph / "index.json").read_bytes())
    nodes = {n["id"]: n for n in index["nodes"]}
    offsets = json.loads((graph / "details-offsets.json").read_bytes())
    detail_file = graph / "details.jsonl"
    children: dict[str, list[str]] = {}
    for node in index["nodes"]:
        children.setdefault(node["parent"], []).append(node["id"])
    for key in offsets:
        if key.startswith("passage:"):
            parent = key.rsplit(":", 1)[0].removeprefix("passage:")
            children.setdefault(parent, []).append(key)
    for value in children.values():
        value.sort()
    statements = {}
    # The verified spans are the only Italian text of a proposal (statements are distilled in English), so search
    # reads them too.
    spans: dict[str, list[str]] = {}
    with detail_file.open("rb") as stream:
        for line in stream:
            item = json.loads(line)
            if "statement" in item:
                statements[item["id"]] = item["statement"]
            if item.get("kind") == "passage" and item.get("parent"):
                spans.setdefault(item["parent"], []).append((item.get("citation") or {}).get("span") or "")
    passage_text = {key: normalize(" ".join(value)) for key, value in spans.items()}
    root = static_root.resolve() if static_root is not None else None
    health = encoded({"status": "ok", "mode": "graph", "dataset_digest": manifest["digest"]})

    def detail(identifier: str) -> dict | None:
        if identifier not in offsets:
            return None
        with detail_file.open("rb") as stream:
            stream.seek(offsets[identifier])
            return json.loads(stream.readline())

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            route = parsed.path
            def send(code: int, payload: dict, max_bytes: int = 1048576):
                body = encoded(payload)
                if len(body) > max_bytes:
                    code, body = 413, encoded({"error": "response too large"})
                compressed = (code == 200 and route == "/api/graph/index" and
                              "gzip" in self.headers.get("Accept-Encoding", "").lower())
                if compressed:
                    body = gzip.compress(body, mtime=0)
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                if route == "/api/graph/index":
                    self.send_header("Vary", "Accept-Encoding")
                if compressed:
                    self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            if not (parsed.scheme or parsed.netloc or parsed.fragment or parsed.query) and route in {
                    "/api/health", "/", "/index.html", "/review.js"}:
                if route == "/api/health":
                    body, mime = health, "application/json; charset=utf-8"
                else:
                    name = "index.html" if route == "/" else route[1:]
                    target = (root / name).resolve() if root is not None else None
                    if target is None or not target.is_relative_to(root) or not target.is_file():
                        send(404, {"error": "static file not found"})
                        return
                    body = target.read_bytes()
                    mime = "text/html; charset=utf-8" if name == "index.html" else "text/javascript; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.scheme or parsed.netloc or parsed.fragment or route not in {
                    "/api/graph/manifest", "/api/graph/index", "/api/graph/node",
                    "/api/graph/children", "/api/graph/search"}:
                send(404, {"error": "route not found"})
                return
            try:
                params = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
                keys = {"/api/graph/manifest": set(), "/api/graph/index": set(),
                        "/api/graph/node": {"id"}, "/api/graph/children": {"id", "offset", "limit"},
                        "/api/graph/search": {"q", "limit"}}[route]
                if len(params) != len(dict(params)) or any(k not in keys for k, _ in params):
                    raise ValueError("invalid query parameters")
                args = dict(params)
                if route == "/api/graph/manifest":
                    send(200, manifest)
                elif route == "/api/graph/index":
                    # This route is intentionally the one large bounded response.
                    send(200, index, 64 * 1024 * 1024)
                elif route in {"/api/graph/node", "/api/graph/children"}:
                    identifier = args.get("id", "")
                    if not identifier or len(identifier) > 180 or not re.fullmatch(r"[A-Za-z0-9_:.-]+", identifier):
                        raise ValueError("invalid node id")
                    if identifier not in nodes and identifier not in offsets:
                        send(404, {"error": "node not found"})
                        return
                    if route == "/api/graph/node":
                        relations = [e for e in index["edges"] if e["source"] == identifier or e["target"] == identifier]
                        send(200, {"node": nodes.get(identifier) or detail(identifier), "detail": detail(identifier),
                                   "relations": relations[:100], "relations_total": len(relations)})
                    else:
                        offset = int(args.get("offset", "0"))
                        limit = int(args.get("limit", "25"))
                        if not 0 <= offset <= 1000000 or not 1 <= limit <= 100:
                            raise ValueError("offset or limit out of range")
                        ids = children.get(identifier, [])
                        send(200, {"id": identifier, "offset": offset, "limit": limit, "total": len(ids),
                                   "children": [nodes.get(i) or detail(i) for i in ids[offset:offset + limit]]})
                else:
                    query = args.get("q", "")
                    limit = int(args.get("limit", "20"))
                    if not query.strip() or len(query) > 200 or not 1 <= limit <= 50:
                        raise ValueError("invalid query or limit")
                    words = normalize(query).split()
                    hits = []
                    for node in index["nodes"]:
                        fields = {"title": node["title"], "snippet": node.get("snippet") or ""}
                        if node["level"] == 4:
                            fields["statement"] = statements.get(node["id"], "")
                        field = next((name for name, value in fields.items() if all(w in normalize(value) for w in words)), None)
                        if field is None and node["level"] == 4 and all(w in passage_text.get(node["id"], "") for w in words):
                            field = "passage"
                        if field:
                            hits.append({"id": node["id"], "level": node["level"], "match_field": field,
                                         "title": node["title"]})
                    send(200, {"query": query, "total": len(hits), "results": hits[:limit]})
            except (ValueError, TypeError):
                send(400, {"error": "invalid query parameters"})

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        server.serve_forever()
    finally:
        server.server_close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    exp = sub.add_parser("export")
    exp.add_argument("--package", required=True, type=Path)
    exp.add_argument("--inventory", required=True, type=Path)
    exp.add_argument("--out", required=True, type=Path)
    exp.add_argument("--context", type=int, default=2)
    srv = sub.add_parser("serve")
    srv.add_argument("--export", type=Path)
    srv.add_argument("--graph", type=Path)
    srv.add_argument("--port", type=int, default=8766)
    srv.add_argument("--static", type=Path, default=Path("ui/dist/review"))
    srv.add_argument("--lenses", type=Path)
    srv.add_argument("--live", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            jsonl(args.package / "COLLEGAMENTI-D065.jsonl")
            jsonl(args.inventory)
            load_env(Path(os.environ.get("NOUS_OS_GRAPH_WORKSPACE_ENV", args.package.parent / "WORKSPACE.env")))
            export(package=args.package, inventory=args.inventory, out=args.out,
                   workspace=core.resolve_workspace(), context_window=args.context)
        else:
            if args.graph:
                serve_graph(graph=args.graph, port=args.port, static_root=args.static)
            elif args.export:
                serve(export_path=args.export, static_root=args.static, port=args.port, lenses_path=args.lenses, live=args.live)
            else:
                raise ValueError("--export or --graph required")
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f"graph-review: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
