"""Read-only, deterministic review graph v2 builder."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import unicodedata

SCHEMA = "nousos.review-graph/2"
DISPLAY_LABEL_RULE = "d072-display-label/4"
DOMAINS = ("atlasfield", "forge", "quillmap", "orchardline", "showcase", "dossier", "qrs", "meridian")
SPECIFICITY = ("orchardline", "quillmap", "qrs", "forge", "dossier", "showcase", "atlasfield", "meridian")
KIND_WEIGHT = {"DECISION": 2.0, "CONCEPT": 1.6, "REQUIREMENT": 1.4, "RELATIONSHIP": 1.4,
               "CHANGE_OVER_TIME": 1.2, "CONTRADICTION": 1.1, "OPEN_QUESTION": 0.8}
NAMES = {"atlasfield": "Atlasfield / ATLASvault", "forge": "FORGE", "quillmap": "Quillmap",
         "orchardline": "Orchardline", "showcase": "Showcase", "dossier": "Dossier", "qrs": "QRS",
         "meridian": "Meridian"}
KINDS = {"CONCEPT", "DECISION", "REQUIREMENT", "OPEN_QUESTION", "CHANGE_OVER_TIME", "RELATIONSHIP", "CONTRADICTION"}
ATTRIBUTION = {
    "atlasfield": r"\batlasfield\b|\batlasvault\b",
    "forge": r"\bnousos\b|\bnous\s*os\b|\bsignal stack\b|\bsource.memory\b",
    "quillmap": r"\bquillmap\b",
    "orchardline": r"\borchardline\b|\borchardlyne\b",
    "showcase": r"\bshowcase\b|\bshowcases\b",
    "dossier": r"\bdossier\b",
    "qrs": r"\bqrs\b|\bquiet render system\b",
    "meridian": r"\bmeridian\b|\btheor|\bprincipl",
}


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def short(text: str, cap: int = 60) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    text = re.sub(r"^(?:assistant|open question|requirement|proposal|concept|decision|the person decides)\s*:\s*", "", text, flags=re.I)
    clause = re.split(r"(?<=[.;:!?])\s+", text, maxsplit=1)[0]
    if clause.endswith(":") and len(text) > len(clause):
        clause = re.split(r"(?<=[.;:!?])\s+", text[len(clause):].strip(), maxsplit=1)[0]
    if len(clause) <= cap:
        return clause or "Untitled"
    cut = clause[:cap + 1].rsplit(" ", 1)[0]
    return (cut or clause[:cap]).rstrip(" ,;:")


def normalize(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))


def canvas_title(value: str) -> str:
    """Remove decorative prefixes while retaining the source title separately."""
    value = str(value or "").strip()
    value = re.sub(r"^[^\w\s]+\s*", "", value, flags=re.UNICODE)
    value = re.sub(r"^(?:(?:done|todo|wip|draft|completed|pending|status)\s*[:|\-]\s*|[✅☑️⬜🟢🟡🔴🚧✨📌]+\s*)+", "", value, flags=re.I)
    return value.strip(" -–—·:| ")


def label_phrase(value: str, cap: int = 40) -> str:
    """Compact source words for display only; never used as a canonical title."""
    value = canvas_title(value).strip(" \"'«»“”‘’…")
    value = re.sub(r"^(?:s[ei]nza titolo\s*[·:–—-]\s*|(?:il\s+)?messaggio del fondatore\s*[:·–—-]?\s*|(?:il\s+)?fondatore\s+(?:(?:ha\s+)?(?:deciso|decide|detto|dice|proposto|propone|chiesto|chiede|suggerito|suggerisce)\s+(?:che\s+)?|[:·–—-]\s*)|(?:the\s+)?founder(?:'s)?\s+(?:(?:has\s+)?(?:decided|decides|said|says|proposed|proposes|asked|asks)\s+(?:that\s+)?|[:·–—-]\s*)|(?:decision|open question|requirement|proposal|concept)\s*:\s*)+", "", value, flags=re.I)
    value = re.split(r"\s+·\s+", value, maxsplit=1)[0]
    value = re.sub(r"\s+(?:[-–—·]\s*)?\d{4}-\d{2}(?:-\d{2})?\s*$", "", value)
    value = re.sub(r"\s+", " ", value).strip(" \"'«»“”‘’….,;:!?–—-")
    words = value.split()
    if len(words) > 7:
        value = " ".join(words[:7])
    else:
        value = " ".join(words)
    if cap <= 0:
        return ""
    if len(value) > cap:
        boundary = value[:cap + 1].rsplit(" ", 1)[0]
        value = boundary if boundary and len(boundary) <= cap else value[:cap - 1] + "…"
    value = re.sub(r"(?:\s+(?:about|and|or|of|for|to|the|a|an|di|del|della|dei|per|e|o|il|la|un|una))+$", "", value, flags=re.I)
    return value.rstrip(" ,;:–—-")


LABEL_STOP_WORDS = frozenset("il lo la i gli le un una uno del dello della dei degli delle nel nello nella the a an of".split())


def formula_title(value: str) -> bool:
    """Titles generated from an excerpt have no independent distilled subject."""
    value = value.strip()
    return (not value or bool(re.match(r"^senza titolo(?:\s*[·:–—-]|$)", value, re.I))
            or bool(re.match(r"^[«\"“].*…[»\"”](?:\s*·|$)", value))
            or bool(re.match(r"^[«\"“][^»\"”]+[»\"”]\s*·", value)))


def shorten_title(value: str, cap: int = 40) -> str:
    """Shorten a distilled title in ordered, reversible presentation steps."""
    value = re.sub(r"\s+", " ", value or "").strip()
    if cap <= 0:
        return ""
    if len(value) <= cap:
        return value
    lead = re.match(r"^(?:messaggio del fondatore\s*:\s*|il fondatore\s+|the founder\s+)", value, re.I)
    if lead:
        value = value[lead.end():].strip()
        if value:
            value = value[0].upper() + value[1:]
        if len(value) <= cap:
            return value
    without_parens = re.sub(r"\s*\([^()]*\)", "", value).strip()
    if len(without_parens.split()) >= 2:
        value = without_parens
    if len(value) <= cap:
        return value
    head = re.split(r"\s+[—–]\s+|:\s+", value, maxsplit=1)[0].strip()
    content_words = [w for w in head.split() if w.casefold().strip(".,;:!?«»") not in LABEL_STOP_WORDS]
    if len(content_words) >= 3:
        value = head
    if len(value) <= cap:
        return value
    words = value.split()
    reduced = " ".join(w for w in words if w.casefold().strip(".,;:!?«»") not in LABEL_STOP_WORDS)
    if len(reduced.split()) >= 2:
        value = reduced
    if len(value) <= cap:
        return value
    # Word boundaries also protect hyphenated code tokens such as CAP-07 and EC-A/B/C/E.
    fit = [w for w in value.split() if w]
    while len(fit) > 2 and len(" ".join(fit)) > cap - 1:
        fit.pop()
    if len(" ".join(fit)) <= cap - 1:
        return " ".join(fit).rstrip(" ,;:") + "…"
    fallback = " ".join(fit[:2]).rstrip(" ,;:") + "…"
    if len(fallback) <= cap:
        return fallback
    # A punctuation-joined token can be longer than the full label cap. Keep
    # the ellipsis inside the cap even when there is no usable word boundary.
    return value[:cap - 1] + "…"


def assign_display_labels(items: list[dict], source: dict[str, str], parents: dict[str, dict]) -> None:
    """Use distilled titles first; resolve sibling labels without exposing IDs."""
    base = {}
    for item in items:
        title = str(item.get("title") or "")
        if item["level"] <= 2:
            label = shorten_title(title) if len(title) > 40 else title
        elif item["level"] == 4:
            label = shorten_title(source.get(item["id"], "")) if formula_title(title) else shorten_title(title)
        elif item["level"] == 3:
            label = shorten_title(canvas_title(title))
        else:
            label = label_phrase(source.get(item["id"], ""))
        base[item["id"]] = label or ("Domanda?" if item.get("subkind") == "OPEN_QUESTION" else "Tema")
        item["display_label"] = base[item["id"]]
    global_proposals: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        if item["level"] == 4:
            global_proposals[base[item["id"]]].append(item)
    for group in global_proposals.values():
        if len(group) < 2:
            continue
        parent_names = [base.get(item.get("parent"), parents.get(item.get("parent"), {}).get("display_label", ""))
                        for item in group]
        if all(parent_names) and len(set(parent_names)) == len(group):
            for item, parent_name in zip(group, parent_names):
                qualifier = shorten_title(parent_name.split(" · ")[0], 18)
                if normalize(qualifier) != normalize(base[item["id"]]):
                    stem = shorten_title(base[item["id"]], 40 - len(qualifier) - 3)
                    candidate = f"{stem} · {qualifier}"
                    if len(candidate) <= 40:
                        item["display_label"] = candidate
    groups: dict[tuple[str | None, str], list[dict]] = defaultdict(list)
    for item in items:
        groups[item.get("parent"), item["display_label"]].append(item)
    for group in groups.values():
        if len(group) < 2:
            continue
        # The parent's name is identical for siblings, so it cannot distinguish them.
        months = {item["id"]: str(item.get("date") or "")[:7] for item in group}
        distinct_months = all(re.fullmatch(r"\d{4}-\d{2}", m) for m in months.values()) and len(set(months.values())) == len(group)
        for order, item in enumerate(sorted(group, key=lambda n: n["id"]), 1):
            suffix = months[item["id"]] if distinct_months else str(order)
            stem = shorten_title(base[item["id"]], 40 - len(suffix) - 3)
            item["display_label"] = f"{stem} · {suffix}"
    by_parent: dict[str | None, list[dict]] = defaultdict(list)
    for item in items:
        by_parent[item.get("parent")].append(item)
    for siblings in by_parent.values():
        used: set[str] = set()
        for item in sorted(siblings, key=lambda n: n["id"]):
            candidate = item["display_label"]
            number = 2
            while candidate in used:
                suffix = f" · {number}"
                candidate = f"{shorten_title(base[item['id']], 40 - len(suffix))}{suffix}"
                number += 1
            item["display_label"] = candidate
            used.add(candidate)


def interim_membership(coverage: Path, inventory: Path, proposals: Path, ledger: Path, stores: Path, out: Path,
                       replaced: Path | None = None) -> dict:
    """Derive the contract membership file from D-068's conversation IDs."""
    coverage_data = json.loads(coverage.read_text())
    inv = {row["conversation"]: row for row in rows(inventory)}
    proposed: dict[str, list[str]] = defaultdict(list)
    source_conv = source_metadata(rows(ledger), stores)
    proposal_rows = rows(proposals)
    excluded = {r["old"] for r in rows(replaced)} if replaced else set()
    excluded.update(json.loads(r["content"]).get("supersedes") for r in proposal_rows)
    for row in proposal_rows:
        content = json.loads(row["content"])
        if row["proposal_id"] in excluded or content.get("valid_to") is not None:
            continue
        for citation in content.get("citations") or []:
            conv = source_conv.get(citation.get("source_id"), {}).get("conversation")
            if conv:
                proposed[conv].append(content.get("statement") or "")
    membership: dict[str, dict] = {}
    for domain in coverage_data["domains"]:
        name = domain["domain"]
        for conv in domain["conversation_ids"]:
            if conv not in inv:
                continue
            title = inv[conv].get("title") or ""
            if name == "Showcase/Dossier":
                haystack = " ".join([title, *proposed[conv]])
                value = "dossier" if re.search(r"\bdossier\b", haystack, re.I) else "showcase"
            else:
                value = {"Atlasfield/ATLASvault": "atlasfield", "FORGE": "forge", "Quillmap": "quillmap",
                         "Orchardline": "orchardline", "QRS": "qrs",
                         "Meridian": "meridian"}[name]
            item = membership.setdefault(conv, {"title": title, "domains": [], "primary": "", "evidence": "D-068 coverage conversation_ids"})
            if value not in item["domains"]:
                item["domains"].append(value)
    for item in membership.values():
        item["domains"].sort(key=DOMAINS.index)
        item["primary"] = item["domains"][0]
    split_counts = Counter("dossier" if "dossier" in item["domains"] else "showcase" for item in membership.values()
                           if "dossier" in item["domains"] or "showcase" in item["domains"])
    result = {"schema": "nousos.domain-membership/1", "generated_by": "review_graph.interim_membership; interim",
              "rules": {"precedence": "atlasfield, forge, quillmap, orchardline, showcase, dossier, qrs, meridian",
                        "showcase_dossier": "Dossier if title or any cited proposal statement contains a Dossier keyword; otherwise Showcase",
                        "evidence": "D-068 per-domain conversation_ids; overlap retained",
                        "showcase_dossier_counts": f"showcase={split_counts['showcase']}, dossier={split_counts['dossier']}"},
              "conversations": dict(sorted(membership.items()))}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(encoded(result))
    return result


def source_metadata(ledger: list[dict], stores: Path, read_hashes: dict[str, str] | None = None) -> dict[str, dict]:
    result = {}
    for row in ledger:
        path = stores / "snapshots" / row["source_id"] / f"{row['snapshot_digest']}.snapshot"
        try:
            raw = path.read_bytes()
            if read_hashes is not None:
                read_hashes[str(path.relative_to(stores))] = hashlib.sha256(raw).hexdigest()
            obj = json.loads(raw)
        except (OSError, ValueError):
            continue
        result[row["source_id"]] = {"conversation": obj.get("container_external_id"),
                                     "role": obj.get("role"), "date": obj.get("created_at"),
                                     "kind": obj.get("kind")}
    return result


def verify(citation: dict, stores: Path, cache: dict, read_hashes: dict[str, str] | None = None) -> tuple[bool, str]:
    try:
        sid, digest = citation["source_id"], citation["snapshot_digest"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", sid) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            return False, "invalid snapshot identifier"
        key = (sid, digest)
        if key not in cache:
            raw = (stores / "snapshots" / sid / f"{digest}.snapshot").read_bytes()
            if read_hashes is not None:
                read_hashes[f"snapshots/{sid}/{digest}.snapshot"] = hashlib.sha256(raw).hexdigest()
            cache[key] = raw if hashlib.sha256(raw).hexdigest() == digest else None
        raw = cache[key]
        start, end = citation["start_byte"], citation["end_byte"]
        if raw is None:
            return False, "snapshot digest mismatch"
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(raw):
            return False, "invalid byte range"
        if raw[start:end] != citation["span"].encode("utf-8"):
            return False, "span byte mismatch"
        return True, ""
    except (KeyError, TypeError, AttributeError, OSError, UnicodeError):
        return False, "missing snapshot or citation field"


def build(*, stores: Path, inventory: Path, membership: Path, replaced: Path, cards: Path,
          out: Path, overlay: Path | None = None, store_layer: bool = False,
          presentation: Path | None = None, require_complete: bool = False) -> dict:
    if store_layer and (overlay or presentation is None):
        raise ValueError("--store-layer requires --presentation and excludes --overlay")
    if presentation is not None and not store_layer:
        raise ValueError("--presentation requires --store-layer")
    inv = {r["conversation"]: r for r in rows(inventory)}
    overlay = overlay if overlay and overlay.exists() else None
    membership_error = False
    overlay_membership = (presentation or overlay) / "membership.json" if (presentation or overlay) else None
    if overlay_membership and overlay_membership.exists():
        try:
            candidate = json.loads(overlay_membership.read_text())
            if candidate.get("schema") != "nousos.domain-membership/1" or not isinstance(candidate.get("conversations"), dict):
                raise ValueError("invalid schema")
            membership = overlay_membership
            member = candidate
        except (ValueError, TypeError, AttributeError):
            membership_error = True
            member = json.loads(membership.read_text())
    else:
        member = json.loads(membership.read_text())
    if member.get("schema") != "nousos.domain-membership/1":
        raise ValueError("invalid membership schema")
    ledger_path = stores / "ledger.jsonl"
    proposal_path = stores / "candidates/proposals.jsonl"
    canon_path = stores / "canon/assertions.jsonl"
    reconcile_path = stores / "reconciliation/relations.jsonl"
    proposals = rows(proposal_path)
    store_hashes: dict[str, str] = {}
    if store_layer:
        for path in (ledger_path, proposal_path, canon_path, reconcile_path):
            if path.is_file():
                store_hashes[str(path.relative_to(stores))] = sha(path)
    source_meta = source_metadata(rows(ledger_path), stores, store_hashes if store_layer else None)
    canon = {r["candidate_id"]: r for r in rows(canon_path)}
    excluded = {r["old"] for r in rows(replaced)}
    excluded.update(json.loads(r["content"]).get("supersedes") for r in proposals)
    nodes: dict[str, dict] = {}
    details: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    cache: dict = {}
    reasons: Counter = Counter()
    if membership_error:
        reasons["membership.json: invalid overlay; used explicit membership"] += 1
    input_paths = [inventory, membership, replaced, cards, ledger_path, proposal_path, canon_path, reconcile_path]
    layer_paths = {
        "integrated_proposals": stores / "integrations/d069/candidates.jsonl",
        "entities": stores / "noncanonical/entities.jsonl",
        "explicit_relations": stores / "noncanonical/explicit-relations.jsonl",
        "exploratory_connections": stores / "interpretations/exploratory.jsonl",
    } if store_layer else {}
    layer_rows: dict[str, list[dict]] = {}
    mapping: dict[str, str] = {}
    if store_layer:
        mapping_path = stores / "integrations/d069/mapping.json"
        for name, path in {**layer_paths, "mapping": mapping_path}.items():
            if not path.is_file():
                raise ValueError(f"required store layer file missing: {path}")
            store_hashes[str(path.relative_to(stores))] = sha(path)
            input_paths.append(path)
            if name != "mapping":
                layer_rows[name] = rows(path)
        mapping_data = json.loads(mapping_path.read_text())
        if mapping_data.get("batch_id") != "d069" or not isinstance(mapping_data.get("overlay_to_store"), dict):
            raise ValueError("invalid integration mapping")
        mapping = mapping_data["overlay_to_store"]
        for row in layer_rows["integrated_proposals"]:
            if row.get("batch_id") != "d069" or mapping.get(row.get("overlay_id")) != row.get("proposal_id"):
                raise ValueError("integrated proposal sidecar disagrees with mapping")
        for name, status in (("entities", "non-canonical/attested"),
                             ("explicit_relations", "non-canonical/attested"),
                             ("exploratory_connections", "exploratory/non-canonical")):
            if any(row.get("epistemic_status") != status or row.get("batch_id") != "d069"
                   for row in layer_rows[name]):
                raise ValueError(f"{name} contains a row without its non-canonical store mark")
        input_paths.extend([presentation / "membership.json", presentation / "outcomes.jsonl", presentation / "titles.jsonl"])
        for path in input_paths[-3:]:
            if not path.is_file():
                raise ValueError(f"required presentation file missing: {path}")
    integrated = {r.get("proposal_id"): r for r in layer_rows.get("integrated_proposals", [])}
    if set(integrated) & set(canon):
        raise ValueError("integrated proposals must remain non-canonical candidates")
    if membership_error:
        input_paths.append(overlay_membership)
    def overlay_rows(name: str) -> list[dict]:
        root = presentation if name in {"titles.jsonl", "outcomes.jsonl"} and store_layer else overlay
        if not root:
            return []
        path = root / name
        if path.exists():
            input_paths.append(path)
        result = []
        if path.exists():
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                    if not isinstance(item, dict):
                        raise ValueError("not an object")
                    result.append(item)
                except (ValueError, TypeError):
                    reasons[f"{name}: invalid JSON row"] += 1
        return result
    def add_edge(source: str, target: str, kind: str, klass: str = "attested", evidence=None, **extra):
        if source not in nodes or target not in nodes:
            return
        eid = f"{klass}:{kind}:{source}:{target}"
        # Every relation names the record it comes from; a relation derived by a rule (membership, alias mention) names the
        # rule and its endpoints.
        extra.setdefault("record_id", f"rule:{kind}:{source}->{target}")
        if eid in edges:
            # Several records for the same relation are one edge whose evidence is the union, in a stable order; the first
            # record stays primary and the others stay listed (the overlays are written sorted by id, so this is stable).
            known = edges[eid]
            merged = {json.dumps(item, sort_keys=True): item for item in [*known["evidence"], *(evidence or [])]}
            known["evidence"] = [merged[key] for key in sorted(merged)]
            if extra:
                records = [*known.get("merged_records", []), {k: v for k, v in sorted(extra.items())}]
                known["merged_records"] = sorted(records, key=lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False))
            return
        edges[eid] = {"id": eid, "source": source, "target": target, "class": klass, "type": kind,
                      "directed": True, "evidence": evidence or [], **extra}
    def add_node(identifier: str, level: int, kind: str, title: str, parent: str | None,
                 parents=None, domains=None, **extra):
        nodes[identifier] = {"id": identifier, "level": level, "kind": kind, "parent": parent,
                             "parents": parents if parents is not None else ([parent] if parent else []),
                             "domains": domains or [], "title": title, "title_full": title,
                             "importance": {"value": 0, "components": {}}, "size": 0,
                             "counts": {"children": 0, "descendants": 0, "canon": 0, "passages": 0}, **extra}
    for domain in DOMAINS:
        add_node(f"domain:{domain}", 1, "domain", NAMES[domain], None, domains=[domain])
    for conv, item in sorted(member["conversations"].items()):
        domains = [d for d in item.get("domains", []) if d in DOMAINS]
        if not domains:
            continue
        primary = item.get("primary") if item.get("primary") in domains else min(domains, key=DOMAINS.index)
        raw_title = item.get("title") or inv.get(conv, {}).get("title") or ""
        title = short(canvas_title(raw_title)) if canvas_title(raw_title) else ""
        date = (inv.get(conv, {}).get("messages_first") or inv.get(conv, {}).get("export_created_at") or "")[:10]
        add_node(f"conversation:{conv}", 3, "conversation", title, f"domain:{primary}",
                 parents=[f"domain:{d}" for d in domains], domains=domains, date=date, level_skip=True)
        nodes[f"conversation:{conv}"]["title_full"] = raw_title
        details[f"conversation:{conv}"] = {"id": f"conversation:{conv}", "inventory": inv.get(conv, {}), "membership": item}
        for d in domains:
            if d != primary:
                add_edge(f"conversation:{conv}", f"domain:{d}", "classified_in", evidence=["membership.json"])
    entities_path = overlay / "entities.json" if overlay else None
    if store_layer or (entities_path and entities_path.exists()):
        if store_layer:
            entity_rows = [{**row, "id": row.get("store_id")} for row in layer_rows["entities"]]
        else:
            input_paths.append(entities_path)
            try:
                gazetteer = json.loads(entities_path.read_text())
                if gazetteer.get("schema") != "nousos.entities/1":
                    raise ValueError("invalid schema")
            except (ValueError, TypeError, AttributeError):
                gazetteer = {"entities": []}
                reasons["entities.json: invalid overlay"] += 1
            entity_rows = gazetteer.get("entities", [])
        if not isinstance(entity_rows, list):
            entity_rows = []
            reasons["entities.json: invalid entities list"] += 1
        for entity in entity_rows:
            if (not isinstance(entity, dict) or not isinstance(entity.get("evidence"), list)
                    or not isinstance(entity.get("name"), str) or not isinstance(entity.get("aliases", []), list)
                    or any(not isinstance(alias, str) for alias in entity.get("aliases", []))
                    or not isinstance(entity.get("domains", []), list)):
                reasons["entity invalid row"] += 1
                continue
            valid = [c for c in entity.get("evidence", []) if verify(c, stores, cache, store_hashes if store_layer else None)[0]]
            reasons["entity invalid citation"] += len(entity.get("evidence", [])) - len(valid)
            if not valid or not any(normalize(alias) in normalize(c["span"]) for alias in [entity.get("name", ""), *entity.get("aliases", [])] for c in valid if alias):
                reasons["entity invalid citation or name absent"] += 1
                continue
            if not isinstance(entity.get("type"), str) or entity.get("type") not in {"project", "work", "system", "concept"}:
                reasons["entity invalid type"] += 1
                continue
            domains = [d for d in entity.get("domains", []) if d in DOMAINS]
            if not domains:
                reasons["entity missing domain"] += 1
                continue
            kind = entity["type"]
            if kind == "concept":
                # Gazetteer concepts can be targets of attested relations but do not create level 2.
                continue
            eid = entity.get("id")
            if not isinstance(eid, str) or not eid or eid in nodes:
                reasons["entity invalid id"] += 1
                continue
            add_node(eid, 2, kind, short(entity["name"]), f"domain:{domains[0]}",
                     parents=[f"domain:{d}" for d in domains], domains=domains,
                     status="non-canonical/attested" if store_layer else "overlay",
                     epistemic_status="non-canonical/attested" if store_layer else None)
            details[eid] = {"id": eid, "entity": entity, "evidence": valid}
            for d in domains[1:]:
                add_edge(eid, f"domain:{d}", "classified_in", evidence=valid)
        for conv, item in sorted(member["conversations"].items()):
            cid = f"conversation:{conv}"
            if cid not in nodes:
                continue
            title = item.get("title") or ""
            qualified = []
            for entity in [n for n in nodes.values() if n["level"] == 2 and n["domains"][0] == nodes[cid]["domains"][0]]:
                raw = details[entity["id"]]["entity"]
                aliases = [raw["name"], *raw.get("aliases", [])]
                title_match = any(normalize(alias) in normalize(title) for alias in aliases if len(alias) > 2)
                qualified.append((1 if title_match else 0, entity["id"]))
            matched = [pair for pair in qualified if pair[0]]
            if matched:
                chosen = sorted(matched, key=lambda pair: pair[1])[0][1]
                nodes[cid]["parent"] = chosen
                nodes[cid]["parents"] = [chosen, *[p for p in nodes[cid]["parents"] if p != nodes[chosen]["parent"]]]
                nodes[cid]["level_skip"] = False
    titles = {}
    for title_row in overlay_rows("titles.jsonl"):
        value = str(title_row.get("title_it") or "").strip()
        if (title_row.get("schema") != "nousos.title/1" or not 0 < len(value) <= 60 or
                normalize(value) in {"messaggio del fondatore", "proposta", "concetto"} or
                not isinstance(title_row.get("id"), str)):
            reasons["invalid overlay title"] += 1
            continue
        title_id = title_row["id"]
        titles[mapping.get(title_id, title_id)] = value
    for node in nodes.values():
        if node["level"] == 3:
            node["title"] = titles.get(node["id"], titles.get(node["id"].removeprefix("conversation:"), node["title"]))
    def proposal_node(pid: str, content: dict, status: str, row: dict):
        if (not isinstance(pid, str) or not pid or pid in nodes or not isinstance(content, dict)
                or not isinstance(content.get("statement"), str)
                or not isinstance(content.get("citations"), list)):
            reasons["proposal invalid or duplicate id"] += 1
            return
        attribution_text = " ".join(str(content.get(k) or "") for k in ("scope", "statement"))
        attributed = [d for d in DOMAINS if re.search(ATTRIBUTION[d], attribution_text, re.I)]
        citations = []
        for citation in content.get("citations") or []:
            ok, why = verify(citation, stores, cache, store_hashes if store_layer else None)
            if ok:
                citations.append(citation)
            else:
                reasons[f"citation: {why}"] += 1
        if not citations:
            reasons["proposal without verified citation"] += 1
            return
        eligible = []
        for citation in citations:
            conv = source_meta.get(citation["source_id"], {}).get("conversation")
            cid = f"conversation:{conv}"
            if cid in nodes and cid not in eligible:
                eligible.append(cid)
        sidecar = integrated.get(pid) if store_layer else None
        if sidecar:
            placed = f"conversation:{sidecar.get('conversation_id')}"
            if placed not in nodes or not isinstance(sidecar.get("domains"), list) or not sidecar["domains"]:
                reasons["integrated proposal invalid sidecar placement"] += 1
                return
            if not set(sidecar["domains"]).issubset(nodes[placed]["domains"]):
                reasons["integrated proposal sidecar domains outside membership"] += 1
                return
            eligible = [placed]
        if not eligible:
            reasons["proposal citations outside membership"] += 1
            return
        cid = eligible[0]
        domains = ([d for d in DOMAINS if d in sidecar["domains"]] if sidecar else
                   [d for d in DOMAINS if any(d in nodes[c]["domains"] for c in eligible)])
        statement = content.get("statement") or ""
        kind = content.get("kind") or "CONCEPT"
        if kind not in KINDS:
            kind = "CONCEPT"
        title = titles.get(pid) or short(statement)
        add_node(pid, 4, "proposal", title, cid, parents=eligible, domains=domains,
                 domain_mentions=attributed, status=status,
                 epistemic_status="non-canonical/attested" if sidecar else None,
                 subkind=kind, date=content.get("valid_from") or row.get("proposed_at"),
                 origin=content.get("origin"), snippet=statement[:40])
        valid_counter = [c for c in content.get("counter_citations") or [] if verify(c, stores, cache, store_hashes if store_layer else None)[0]]
        reasons["counter citation invalid"] += len(content.get("counter_citations") or []) - len(valid_counter)
        details[pid] = {"id": pid, "statement": statement, "scope": content.get("scope"), "why": content.get("why"),
                        "origin": content.get("origin"), "producer": content.get("producer"),
                        "valid_from": content.get("valid_from"), "proposed_at": row.get("proposed_at"),
                        "support": content.get("support"), "batch": content.get("batch"), "citations": citations,
                        "counter_citations": valid_counter,
                        "canon": canon.get(pid), "overlay_status": status if status == "overlay" else None,
                        "provenance_line": "integrata nella memoria globale · lotto d069" if sidecar else None,
                        "epistemic_status": "non-canonical/attested" if sidecar else None,
                        "integration": sidecar}
        for i, citation in enumerate(citations):
            passage_id = f"passage:{pid}:{i}"
            meta = source_meta.get(citation["source_id"], {})
            excerpt = short(citation["span"], 46)
            passage_title = f"«{excerpt}…» · {nodes[cid]['title']} · {(meta.get('date') or nodes[cid].get('date') or '')[:10]}"
            raw = cache[(citation["source_id"], citation["snapshot_digest"])]
            before = raw[max(0, citation["start_byte"] - 160):citation["start_byte"]].decode("utf-8", "replace")
            after = raw[citation["end_byte"]:citation["end_byte"] + 160].decode("utf-8", "replace")
            details[passage_id] = {"id": passage_id, "level": 5, "kind": "passage", "parent": pid,
                                   "title": passage_title, "citation": citation, "record": meta,
                                   "context_before": before, "context_after": after}
        nodes[pid]["counts"]["passages"] = len(citations)
    for row in sorted(proposals, key=lambda r: r["proposal_id"]):
        content = json.loads(row["content"])
        pid = row["proposal_id"]
        if pid in excluded or content.get("valid_to") is not None:
            continue
        proposal_node(pid, content, "canon" if pid in canon else "proposal", row)
    for row in overlay_rows("p2a-proposals.jsonl"):
        if row.get("schema") == "nousos.p2a-proposal/1" and str(row.get("id", "")).startswith("ovl_"):
            proposal_node(row["id"], row, "overlay", row)
        else:
            reasons["p2a-proposals.jsonl: invalid row"] += 1
    # Conversation placement follows proposal evidence, with COV-A primary as fallback.
    anchored: dict[str, Counter] = defaultdict(Counter)
    for proposal in [n for n in nodes.values() if n["level"] == 4]:
        for cid in proposal["parents"]:
            anchored[cid].update(d for d in proposal["domain_mentions"] if d in nodes[cid]["domains"])
    for conv, item in sorted(member["conversations"].items()):
        cid = f"conversation:{conv}"
        if cid not in nodes:
            continue
        conv_node = nodes[cid]
        scores = anchored[cid]
        if scores:
            peak = max(scores.values())
            primary = next(d for d in SPECIFICITY if d in conv_node["domains"] and scores[d] == peak)
        else:
            primary = item.get("primary") if item.get("primary") in conv_node["domains"] else next(d for d in SPECIFICITY if d in conv_node["domains"])
        conv_node["primary_domain"] = primary
        conv_node["primary_domain_anchors"] = dict(sorted(scores.items()))
        if conv_node["parent"] in nodes and nodes[conv_node["parent"]]["level"] == 2 and primary not in nodes[conv_node["parent"]]["domains"]:
            conv_node["parent"] = f"domain:{primary}"
            conv_node["level_skip"] = True
        if conv_node["parent"].startswith("domain:"):
            conv_node["parent"] = f"domain:{primary}"
        conv_node["parents"] = [f"domain:{primary}", *[f"domain:{d}" for d in conv_node["domains"] if d != primary]]
    # A project/work parent must belong to the conversation's primary domain: a title match against an entity of another
    # domain does not stand.
    for conv_node in [n for n in nodes.values() if n["level"] == 3 and not n.get("level_skip")]:
        holder = nodes.get(conv_node["parent"], {})
        primary = conv_node.get("primary_domain")
        if holder.get("level") == 2 and primary and holder["domains"][0] != primary:
            conv_node["parent"] = f"domain:{primary}"
            conv_node["parents"] = [f"domain:{primary}", *[f"domain:{d}" for d in conv_node["domains"] if d != primary]]
            conv_node["level_skip"] = True
    # For unassigned conversations, use majority of entity alias mentions in
    # their live proposals; an explicit title match above always has priority.
    # The entity must belong to the conversation's primary domain and be named
    # in at least three statements and a tenth of them, so one passing mention
    # never decides the hierarchy.
    for conv_node in [n for n in nodes.values() if n["level"] == 3 and n.get("level_skip")]:
        primary = conv_node.get("primary_domain") or conv_node["domains"][0]
        candidates = [n for n in nodes.values() if n["level"] == 2 and n["domains"][0] == primary]
        statements = [details[n["id"]]["statement"] for n in nodes.values()
                      if n["level"] == 4 and n["parent"] == conv_node["id"]]
        scores = []
        for entity in candidates:
            raw = details[entity["id"]]["entity"]
            aliases = [raw["name"], *raw.get("aliases", [])]
            score = sum(any(re.search(r"(?<!\w)" + re.escape(normalize(a)) + r"(?!\w)", normalize(s))
                            for a in aliases if len(a) > 2) for s in statements)
            if score >= 3 and score >= 0.1 * len(statements):
                scores.append((score, entity["id"]))
        if scores:
            chosen = sorted(scores, key=lambda x: (-x[0], x[1]))[0][1]
            conv_node["parent"] = chosen
            conv_node["parents"] = [chosen, *[p for p in conv_node["parents"] if p != nodes[chosen]["parent"]]]
            conv_node["level_skip"] = False
    # Mentions are deterministic alias matches in verified proposal statements.
    for entity in [n for n in nodes.values() if n["level"] == 2]:
        raw = details[entity["id"]]["entity"]
        aliases = [raw["name"], *raw.get("aliases", [])]
        for proposal in [n for n in nodes.values() if n["level"] == 4]:
            statement = details[proposal["id"]]["statement"]
            if any(re.search(r"(?<!\w)" + re.escape(normalize(a)) + r"(?!\w)", normalize(statement)) for a in aliases if len(a) > 2):
                add_edge(proposal["id"], entity["id"], "mentions", evidence=details[proposal["id"]]["citations"][:1])
    for rel in ([{**row, "id": row.get("store_id")} for row in layer_rows["explicit_relations"]]
                if store_layer else overlay_rows("relations-explicit.jsonl")):
        if rel.get("schema") != "nousos.relation-explicit/1":
            reasons["explicit relation invalid schema"] += 1
            continue
        evidence_rows = rel.get("evidence", [])
        if not isinstance(evidence_rows, list) or any(not isinstance(e, dict) for e in evidence_rows):
            reasons["explicit relation invalid evidence"] += 1
            continue
        ev = [e.get("citation", e) for e in evidence_rows]
        if not ev or not all(verify(c, stores, cache, store_hashes if store_layer else None)[0] for c in ev):
            reasons["explicit relation invalid citation"] += 1
            continue
        predicate = rel.get("predicate")
        if not isinstance(predicate, str) or predicate not in {"part_of", "depends_on", "derives_from", "supersedes", "implements", "contradicts", "precedes"}:
            reasons["explicit relation invalid predicate"] += 1
            continue
        edge_type = predicate if predicate in {"supersedes", "contradicts"} else "relates"
        if (not isinstance(rel.get("subject"), str) or not isinstance(rel.get("object"), str)
                or rel.get("subject") not in nodes or rel.get("object") not in nodes):
            reasons["explicit relation unknown endpoint"] += 1
            continue
        add_edge(rel.get("subject"), rel.get("object"), edge_type, evidence=ev, record_id=rel.get("id"),
                 predicate=predicate, rule=rel.get("rule"),
                 epistemic_status="non-canonical/attested" if store_layer else None,
                 overlay_status=None if store_layer else "attested")
    citation_nodes: dict[tuple, set[str]] = defaultdict(set)
    for pid, info in details.items():
        if "statement" in info:
            for c in info["citations"]:
                citation_nodes[(c["source_id"], c["snapshot_digest"], c["start_byte"], c["end_byte"])].add(pid)
    reconciliation = []
    if reconcile_path.exists():
        with reconcile_path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                try:
                    reconciliation.append(json.loads(line))
                except json.JSONDecodeError:
                    reasons["malformed reconciliation row"] += 1
    for relation in reconciliation:
        if "text_equality" not in relation.get("bases", []):
            continue
        cited = relation.get("citations") or []
        if len(cited) < 2:
            continue
        sides = []
        for c in cited[:2]:
            if not verify(c, stores, cache, store_hashes if store_layer else None)[0]:
                sides = []
                break
            sides.append(citation_nodes.get((c["source_id"], c["snapshot_digest"], c["start_byte"], c["end_byte"]), set()))
        if len(sides) == 2:
            for a in sides[0]:
                for b in sides[1]:
                    if a != b:
                        add_edge(a, b, "same_text", evidence=cited[:2])
    for rel in ([{**row, "id": row.get("store_id")} for row in layer_rows["exploratory_connections"]]
                if store_layer else overlay_rows("exploratory.jsonl")):
        if rel.get("schema") != "nousos.exploratory-connection/1":
            reasons["exploratory invalid schema"] += 1
            continue
        a, b = rel.get("a"), rel.get("b")
        if not isinstance(a, str) or not isinstance(b, str):
            reasons["exploratory invalid endpoint"] += 1
            continue
        if a not in nodes and f"conversation:{a}" in nodes:
            a = f"conversation:{a}"
        if b not in nodes and f"conversation:{b}" in nodes:
            b = f"conversation:{b}"
        if a not in nodes or b not in nodes:
            reasons["exploratory unknown endpoint"] += 1
            continue
        def sources(identifier: str) -> list[dict]:
            if identifier in details and "citations" in details[identifier]:
                return details[identifier]["citations"]
            if nodes[identifier]["level"] == 3:
                found = [c for n in nodes.values() if n["level"] == 4 and identifier in n["parents"]
                         for c in details[n["id"]]["citations"]]
                return found[:8]
            return []
        given_a, given_b = rel.get("a_sources"), rel.get("b_sources")
        if isinstance(given_a, list) and isinstance(given_b, list) and given_a and given_b:
            # The overlay states the sources of both sides; every one must match the snapshot bytes.
            if not all(isinstance(c, dict) and verify(c, stores, cache, store_hashes if store_layer else None)[0] for c in [*given_a, *given_b]):
                reasons["exploratory invalid overlay source"] += 1
                continue
            a_sources, b_sources = given_a, given_b
        else:
            a_sources, b_sources = sources(a), sources(b)
        ev = [*a_sources, *b_sources]
        if not ev:
            reasons["exploratory invalid citation"] += 1
            continue
        inference = rel.get("inference")
        if not isinstance(inference, str) or inference not in {"analogy", "resonance", "dependency", "continuity", "contradiction", "application"}:
            reasons["exploratory invalid inference"] += 1
            continue
        add_edge(a, b, inference, "exploratory", ev, record_id=rel.get("id"),
                 a_sources=a_sources, b_sources=b_sources,
                 explanation=rel.get("explanation_it", ""), inference=rel.get("inference"),
                 confidence=rel.get("confidence"), counter_evidence=rel.get("counter_evidence", []),
                 status="exploratory/non-canonical", epistemic_status="exploratory/non-canonical")
    outcome_rows = overlay_rows("outcomes.jsonl")
    outcome_counts: dict[str, Counter] = defaultdict(Counter)
    outcome_seen: dict[str, set[str]] = defaultdict(set)
    eligible_conversations = set(member["conversations"])
    for outcome in outcome_rows:
        pass_id, conv = outcome.get("pass"), outcome.get("conversation_id")
        result = outcome.get("outcome")
        if (outcome.get("schema") != "nousos.pass-outcome/1" or not isinstance(pass_id, str) or pass_id not in {"p2a", "p2b"}
                or not isinstance(result, str) or result not in {"distilled", "no_result", "blocked", "not_eligible"}
                or not isinstance(conv, str) or conv not in eligible_conversations or conv in outcome_seen[pass_id]):
            reasons["outcomes.jsonl: invalid or duplicate row"] += 1
            continue
        outcome_seen[pass_id].add(conv)
        outcome_counts[pass_id][result] += 1
    outcomes = {p: {"outcomes": dict(sorted(outcome_counts[p].items())), "reported": len(outcome_seen[p]),
                    "eligible": len(eligible_conversations), "missing": len(eligible_conversations - outcome_seen[p]),
                    "complete": outcome_seen[p] == eligible_conversations}
                for p in ("p2a", "p2b")}
    if require_complete and not all(summary["complete"] for summary in outcomes.values()):
        # A dataset that claims the selected domains must have a recorded outcome of both passes for every eligible
        # conversation; nothing is written otherwise.
        raise ValueError("pass outcomes incomplete: " + ", ".join(f"{p} missing {v['missing']}" for p, v in outcomes.items() if not v["complete"]))
    for card in rows(cards):
        linked = set()
        for label in card.get("linked", []):
            t = label.casefold()
            for d in DOMAINS:
                if d in t or (d == "atlasfield" and "atlasvault" in t):
                    linked.add(f"domain:{d}")
        valid = [c for c in card.get("evidence", []) if verify(c, stores, cache, store_hashes if store_layer else None)[0]]
        if card.get("evidence") and not valid:
            reasons["card without verified citation"] += 1
            continue
        for a in sorted(linked):
            for b in sorted(linked):
                if a >= b:
                    continue
                add_edge(a, b, "card", "exploratory", valid[:8], record_id=card.get("id"), explanation=card.get("statement", ""),
                         inference="card", confidence=card.get("confidence", "low"), counter_evidence=[],
                         status="exploratory/non-canonical", card_id=card["id"])
    # Use the strongest cited proposal to name conversations with no source title.
    attested_now = Counter(e["source"] for e in edges.values() if e["class"] == "attested") + Counter(e["target"] for e in edges.values() if e["class"] == "attested")
    exploratory_now = Counter(e["source"] for e in edges.values() if e["class"] == "exploratory") + Counter(e["target"] for e in edges.values() if e["class"] == "exploratory")
    def proposal_components(node: dict) -> dict:
        return {"canon": 3.0 * (node.get("status") == "canon"),
                "kind_weight": KIND_WEIGHT[node["subkind"]],
                "origin": {"USER_AUTHORED": .5, "QUOTED": .2}.get(node.get("origin"), 0),
                "verified_citations": .3 * math.log1p(node["counts"]["passages"]),
                "attested_degree": .5 * math.log1p(attested_now[node["id"]]),
                "exploratory_degree": .3 * math.log1p(exploratory_now[node["id"]])}
    for conv_node in [n for n in nodes.values() if n["level"] == 3 and not n["title"]]:
        candidates = [n for n in nodes.values() if n["level"] == 4 and conv_node["id"] in n["parents"]]
        best = sorted(candidates, key=lambda n: (-sum(proposal_components(n).values()), n["id"]))[0] if candidates else None
        month = (conv_node.get("date") or "")[:7]
        month = f"{month[5:7]}/{month[:4]}" if len(month) == 7 else "data ignota"
        conv_node["title"] = f"Senza titolo · {best['title'] if best else 'Conversazione'} · {month}"
    for item in details.values():
        if item.get("kind") == "passage":
            proposal = nodes[item["parent"]]
            conv_title = nodes[proposal["parent"]]["title"]
            excerpt = short(item["citation"]["span"], 46)
            item["title"] = f"«{excerpt}…» · {conv_title} · {(item['record'].get('date') or '')[:10]}"
    # Stable titles, adding the smallest contextual discriminator needed for uniqueness.
    by_title: dict[str, list[dict]] = defaultdict(list)
    for node in nodes.values():
        by_title[node["title"]].append(node)
    duplicate_global = sum(len(group) for group in by_title.values() if len(group) > 1)
    duplicate_parent = sum(count for group in by_title.values() for count in Counter(n["parent"] for n in group).values() if count > 1)
    # Domains keep their names. Everything else that is ambiguous gets the most readable discriminator that resolves it:
    # an entity its kind; a conversation its month, then its day; a proposal its conversation when the namesakes sit in
    # different conversations, then its date, then its date and time. Only what is still ambiguous gets the end of its id.
    kind_it = {"project": "progetto", "work": "opera", "system": "sistema", "concept": "concetto"}
    months_it = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]

    def date_it(value, precision: str) -> str | None:
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?", str(value or ""))
        if not m:
            return None
        if precision == "month":
            return f"{months_it[int(m.group(2)) - 1]} {m.group(1)}"
        day = f"{int(m.group(3))} {months_it[int(m.group(2)) - 1]} {m.group(1)}"
        return f"{day}, {m.group(4)}:{m.group(5)}" if precision == "time" and m.group(4) else day

    def discriminator(node: dict, step: int, spans_conversations: bool) -> str | None:
        if node["level"] == 2:
            return kind_it.get(node["kind"], node["kind"])
        if node["level"] == 3:
            return date_it(node.get("date"), ("month", "day", "day")[step])
        if node["level"] == 4:
            if step == 0:
                return short(nodes.get(node["parent"], {}).get("title", ""), 24) if spans_conversations else None
            return date_it(node.get("date"), "day" if step == 1 else "time")
        return None

    for group in by_title.values():
        if len(group) < 2:
            continue
        base = {node["id"]: node["title"] for node in group}
        spans = len({node["parent"] for node in group}) > 1
        extras: dict[str, list[str]] = defaultdict(list)
        for step in range(3):
            titles_now = Counter(node["title"] for node in group)
            ambiguous = [node for node in group if titles_now[node["title"]] > 1 and node["level"] != 1]
            if not ambiguous:
                break
            for node in ambiguous:
                extra = discriminator(node, step, spans)
                if extra and extra not in extras[node["id"]]:
                    extras[node["id"]] = [e for e in extras[node["id"]] if not (node["level"] == 4 and step == 2 and e == date_it(node.get("date"), "day"))] + [extra]
                    node["title"] = " · ".join([base[node["id"]], *extras[node["id"]]])
        # identical title and minute: the proposal's kind, and finally a reading-order number, never an id
        kind_word = {"DECISION": "decisione", "CONCEPT": "concetto", "REQUIREMENT": "requisito", "OPEN_QUESTION": "domanda",
                     "CHANGE_OVER_TIME": "evoluzione", "RELATIONSHIP": "relazione", "CONTRADICTION": "contraddizione"}
        titles_now = Counter(node["title"] for node in group)
        for node in group:
            if titles_now[node["title"]] > 1 and node["level"] == 4 and node.get("subkind") in kind_word:
                node["title"] = f"{node['title']} · {kind_word[node['subkind']]}"
        remaining = Counter(node["title"] for node in group)
        numbered: dict[str, int] = defaultdict(int)
        for node in sorted(group, key=lambda n: n["id"]):
            if remaining[node["title"]] > 1 and node["level"] != 1:
                numbered[node["title"]] += 1
                node["title"] = f"{node['title']} · n. {numbered[node['title']]}"
    passage_titles: dict[str, list[dict]] = defaultdict(list)
    for item in details.values():
        if item.get("kind") == "passage":
            passage_titles[item["title"]].append(item)
    duplicate_global += sum(len(group) for group in passage_titles.values() if len(group) > 1)
    duplicate_parent += sum(count for group in passage_titles.values()
                            for count in Counter(item["parent"] for item in group).values() if count > 1)
    for group in passage_titles.values():
        if len(group) > 1:
            for number, item in enumerate(sorted(group, key=lambda i: i["id"]), 1):
                item["title"] = f"{item['title']} · n. {number}"
    children: dict[str, list[str]] = defaultdict(list)
    for node in nodes.values():
        if node["parent"] in nodes:
            children[node["parent"]].append(node["id"])
    for node in sorted(nodes.values(), key=lambda n: -n["level"]):
        descendants = children[node["id"]]
        node["counts"]["children"] = len(descendants) + (node["counts"]["passages"] if node["level"] == 4 else 0)
        node["counts"]["descendants"] = sum(1 + nodes[c]["counts"]["descendants"] for c in descendants) + node["counts"]["passages"]
        node["counts"]["canon"] = int(node.get("status") == "canon") + sum(nodes[c]["counts"]["canon"] for c in descendants)
        node["counts"]["live_proposals"] = int(node["level"] == 4) + sum(nodes[c]["counts"]["live_proposals"] for c in descendants)
        if node["level"] != 4:
            node["counts"]["passages"] = sum(nodes[c]["counts"]["passages"] for c in descendants)
    for node in nodes.values():
        if node["level"] == 4:
            components = proposal_components(node)
        else:
            components = {"live_proposals": math.log1p(node["counts"]["live_proposals"]),
                          "canon_descendants": 2 * math.log1p(node["counts"]["canon"]),
                          "attested_degree": .3 * math.log1p(attested_now[node["id"]])}
        value = sum(components.values())
        node["importance"] = {"value": round(value, 6), "components": components}
    for level in range(1, 5):
        group = sorted(n["importance"]["value"] for n in nodes.values() if n["level"] == level)
        if not group:
            continue
        for node in nodes.values():
            if node["level"] == level:
                from bisect import bisect_left, bisect_right
                value = node["importance"]["value"]
                average_rank = (bisect_left(group, value) + bisect_right(group, value) - 1) / 2
                percentile_rank = average_rank / (len(group) - 1) if len(group) > 1 else .5
                node["size"] = round(.15 + .85 * percentile_rank, 6)
    assign_display_labels(list(nodes.values()), {
        node["id"]: details[node["id"]]["statement"]
        for node in nodes.values() if node["level"] == 4
    }, nodes)
    passages = [item for item in details.values() if item.get("kind") == "passage"]
    passage_labels = [{"id": item["id"], "level": 5, "parent": item["parent"],
                       "date": item.get("record", {}).get("date")} for item in passages]
    assign_display_labels(passage_labels, {
        item["id"]: item["citation"]["span"] for item in passages
    }, nodes)
    for item, labelled in zip(passages, passage_labels):
        item["display_label"] = labelled["display_label"]
    sorted_nodes = sorted(nodes.values(), key=lambda n: (n["level"], n["id"]))
    sorted_edges = sorted(edges.values(), key=lambda e: e["id"])
    store_reconciliation = None
    if store_layer:
        def record_ids(edge: dict) -> set[str]:
            return {value for value in [edge.get("record_id"),
                    *(item.get("record_id") for item in edge.get("merged_records", []))]
                    if isinstance(value, str)}
        present = {
            "integrated_proposals": {pid for pid in integrated if pid in nodes},
            "entities": {n["id"] for n in nodes.values() if n["level"] == 2},
            "explicit_relations": set().union(*(record_ids(e) for e in edges.values()
                if e.get("epistemic_status") == "non-canonical/attested")),
            "exploratory_connections": set().union(*(record_ids(e) for e in edges.values()
                if e.get("epistemic_status") == "exploratory/non-canonical")),
        }
        store_files = dict(sorted(store_hashes.items()))
        # The per-file digests (one per snapshot) live beside the manifest; the manifest stays under the response limit.
        core = {k: v for k, v in store_files.items() if not k.startswith("snapshots/")}
        store_reconciliation = {"layers": {}, "store_files": {"count": len(store_files), "list": "store-files.json",
                                                              "core_sha256": core}}
        for name, key in (("integrated_proposals", "proposal_id"), ("entities", "store_id"),
                          ("explicit_relations", "store_id"), ("exploratory_connections", "store_id")):
            source_ids = [row.get(key) for row in layer_rows[name]]
            source_set = set(source_ids)
            dataset_ids = present[name]
            store_reconciliation["layers"][name] = {
                "store_count": len(source_ids), "dataset_count": len(dataset_ids),
                "missing_from_dataset": sorted(source_set - dataset_ids),
                "missing_from_store": sorted(dataset_ids - source_set),
                "duplicate_store_ids": sorted(pid for pid, count in Counter(source_ids).items() if count > 1),
            }
        if require_complete and any(v["store_count"] != v["dataset_count"] or v["missing_from_dataset"]
                                    or v["missing_from_store"] or v["duplicate_store_ids"]
                                    for v in store_reconciliation["layers"].values()):
            raise ValueError("store reconciliation incomplete")
    index = {"schema": SCHEMA, "nodes": sorted_nodes, "edges": sorted_edges}
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.json").write_bytes(encoded(index))
    offsets = {}
    with (out / "details.jsonl").open("wb") as stream:
        for key in sorted(details):
            offsets[key] = stream.tell()
            stream.write(encoded(details[key]))
    (out / "details-offsets.json").write_bytes(encoded(offsets))
    if store_reconciliation is not None:
        (out / "store-files.json").write_bytes(encoded(store_files))
        store_reconciliation["store_files"]["list_sha256"] = sha(out / "store-files.json")
    counts = {"level": dict(sorted(Counter(str(n["level"]) for n in nodes.values()).items())),
              "kind": dict(sorted(Counter(n["kind"] for n in nodes.values()).items())),
              "status": dict(sorted(Counter(n.get("status", "none") for n in nodes.values()).items())),
              "domain": {d: sum(d in n["domains"] for n in nodes.values()) for d in DOMAINS},
              "primary_domain": dict(sorted(Counter(n["primary_domain"] for n in nodes.values() if n["level"] == 3).items())),
              "passages": sum(n["counts"]["passages"] for n in nodes.values() if n["level"] == 4),
              "edges": dict(sorted(Counter(e["class"] for e in edges.values()).items()))}
    manifest = {"schema": SCHEMA, "generated_at": "1970-01-01T00:00:00Z", "inputs": {str(p): sha(p) for p in sorted(set(input_paths)) if p.exists()},
                "counts": counts, "limits": {"children_max": 100, "search_max": 50, "response_max_bytes": 1048576},
                "rules": {"membership": member.get("rules", {}), "proposal_inclusion": ("Every live proposal with a verified citation in an eligible conversation; integrated d069 proposals use their store sidecar conversation_id and domains; other proposals use the first eligible cited conversation as primary and the remaining eligible cited conversations as parents; keyword anchors are domain_mentions only" if store_layer else "Every live proposal with a verified citation in an eligible conversation; first eligible cited conversation is primary, other eligible cited conversations are parents; domains are their union; keyword anchors are domain_mentions only"),
                          "primary_domain": "Most keyword-anchored live proposals citing the conversation; ties: orchardline, quillmap, qrs, forge, dossier, showcase, atlasfield, meridian; no anchor: COV-A primary",
                          "project_assignment": "Verified gazetteer entity of the conversation's primary domain: title alias match first (lexical ID tie break), else the entity named in the most live proposal statements if it is named in at least 3 and at least 10 %; otherwise level_skip",
                          "importance": "proposal=3*canon+kind weight (DECISION 2.0, CONCEPT 1.6, REQUIREMENT/RELATIONSHIP 1.4, CHANGE_OVER_TIME 1.2, CONTRADICTION 1.1, OPEN_QUESTION 0.8)+origin (USER_AUTHORED 0.5, QUOTED 0.2, else 0)+0.3*log1p(verified citations)+0.5*log1p(attested degree)+0.3*log1p(exploratory degree); aggregates=log1p(descendant live proposals)+2*log1p(canon descendants)+0.3*log1p(attested degree); size=0.15+0.85*average-tie percentile rank within level",
                          "titles": ("presentation title first, re-keyed through integration mapping; " if store_layer else "overlay title first; ") + "first statement clause at word boundary ≤60; canvas title strips leading emoji/status and retains title_full; untitled conversation uses strongest proposal title and month/year; repeated titles: domains unchanged, entities by kind, conversations by month then day, proposals by conversation (when in different conversations), date, time and kind, then a reading-order number; never an id"},
                "display_labels": {"rule": DISPLAY_LABEL_RULE, "map_sha256": hashlib.sha256(encoded({n["id"]: n["display_label"] for n in sorted_nodes})).hexdigest()},
                "outcomes": outcomes,
                "store_reconciliation": store_reconciliation,
                "audit": {"duplicate_titles_global_before": duplicate_global, "duplicate_titles_within_parent_before": duplicate_parent,
                          "dropped": dict(sorted(reasons.items()))},
                "files": {name: sha(out / name) for name in ("index.json", "details.jsonl", "details-offsets.json")}}
    manifest["digest"] = hashlib.sha256(encoded({k: v for k, v in manifest.items() if k != "digest"})).hexdigest()
    (out / "manifest.json").write_bytes(encoded(manifest))
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("build")
    for name in ("stores", "inventory", "membership", "replaced", "cards", "out"):
        p.add_argument(f"--{name}", type=Path, required=True)
    p.add_argument("--overlay", type=Path)
    p.add_argument("--store-layer", action="store_true")
    p.add_argument("--presentation", type=Path)
    p.add_argument("--require-complete", action="store_true",
                   help="refuse to write a dataset unless both passes record an outcome for every eligible conversation")
    m = sub.add_parser("membership")
    for name in ("coverage", "inventory", "proposals", "ledger", "stores", "out"):
        m.add_argument(f"--{name}", type=Path, required=True)
    m.add_argument("--replaced", type=Path)
    args = parser.parse_args(argv)
    call_args = {k: v for k, v in vars(args).items() if k != "command"}
    result = build(**call_args) if args.command == "build" else interim_membership(**call_args)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
