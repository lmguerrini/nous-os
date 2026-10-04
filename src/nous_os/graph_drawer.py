"""Human-readable, evidence-bound sections for the graph review drawer."""
from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
import json
import re


KIND = {"domain": "Dominio", "project": "Progetto", "system": "Sistema", "work": "Opera",
        "conversation": "Conversazione", "proposal": "Proposta", "attachment_source": "Allegato",
        "non_conversation_source": "Fonte", "passage": "Passaggio"}
EXPLORATORY = {"application": "Applicazione", "continuity": "Continuità", "analogy": "Analogia",
               "dependency": "Dipendenza", "resonance": "Risonanza", "card": "Carta di collegamento",
               "contradiction": "Contraddizione"}
ROLE = {"user": "Fondatore", "assistant": "Assistente", "human": "Fondatore", "system": "Sistema"}
AGGREGATES = {"domain", "project", "system", "work"}
SOURCES = {"attachment_source", "non_conversation_source"}


def _short(value: object, length: int = 420) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= length else text[:length - 1].rstrip() + "…"


def _date(value: object) -> str:
    return str(value or "")[:10]


def _readable_context(value: object) -> str:
    text = str(value or "").strip()
    if any(marker in text for marker in ('content_type', 'ntent_type', '"parts"', '"payload"', '\\"', '{"', '"}')):
        return ""
    return text


def _title(node: dict) -> str:
    return str(node.get("title") or node.get("title_full") or "Senza titolo")


class DrawerData:
    def __init__(self, index: dict, offsets: dict, detail_file: Path, manifest: dict | None = None):
        self.nodes = {node["id"]: node for node in index["nodes"]}
        self.offsets = offsets
        self.detail_file = detail_file
        self.manifest = manifest or {}
        self.children: dict[str, list[str]] = defaultdict(list)
        for node in self.nodes.values():
            if node.get("parent"):
                self.children[node["parent"]].append(node["id"])
        for identifier in offsets:
            if identifier.startswith("passage:"):
                self.children[identifier.rsplit(":", 1)[0].removeprefix("passage:")].append(identifier)
        for ids in self.children.values():
            ids.sort()
        self.edges: dict[str, list[dict]] = defaultdict(list)
        for edge in index["edges"]:
            self.edges[edge["source"]].append(edge)
            self.edges[edge["target"]].append(edge)
        self._details: dict[str, dict | None] = {}

    def detail(self, identifier: str) -> dict | None:
        if identifier not in self._details:
            result = None
            if identifier in self.offsets:
                with self.detail_file.open("rb") as stream:
                    stream.seek(self.offsets[identifier])
                    result = json.loads(stream.readline())
            self._details[identifier] = result
        return self._details[identifier]

    def node(self, identifier: str) -> dict | None:
        return self.nodes.get(identifier) or self.detail(identifier)

    def descendants(self, identifier: str) -> list[str]:
        found: list[str] = []
        pending = list(reversed(self.children.get(identifier, [])))
        while pending:
            child = pending.pop()
            found.append(child)
            pending.extend(reversed(self.children.get(child, [])))
        return found

    def members(self, identifier: str) -> list[str]:
        """A domain includes every declared membership, not only primary-parent nodes."""
        if self.nodes.get(identifier, {}).get("kind") == "domain":
            return sorted(node["id"] for node in self.nodes.values()
                          if identifier in (node.get("parents") or []) and node.get("level", 0) <= 3)
        return list(self.children.get(identifier, []))

    def _item(self, identifier: str, *, with_text: bool = True) -> dict:
        node = self.node(identifier) or {}
        kind = node.get("kind", "")
        detail = self.detail(identifier) or {}
        item = {"id": identifier, "title": _title(node), "kind_label": KIND.get(kind, "Elemento")}
        if with_text:
            if kind == "passage":
                citation = detail.get("citation") or {}
                value = citation.get("span") or ""
                if value:
                    context = " ".join(x for x in (_readable_context(detail.get("context_before")), value,
                                                     _readable_context(detail.get("context_after"))) if x)
                    item["text"] = _short(context or value, 900)
                else:
                    item["text"] = "Il testo del passaggio non è disponibile."
                record = detail.get("record") or {}
                role = record.get("role")
                if role:
                    item["author"] = ROLE.get(str(role).lower(), str(role).capitalize())
                if record.get("date"):
                    item["date"] = _date(record["date"])
                source_id = citation.get("source_id") or record.get("source_id")
                if source_id:
                    sid = "source:" + str(source_id)
                    source = self.nodes.get(sid)
                    if source:
                        item["source"] = {"id": sid, "title": _title(source)}
            elif kind == "proposal":
                statement = detail.get("statement") or ""
                spans = [c.get("span") for c in detail.get("citations", []) if c.get("span")]
                item["text"] = _short(statement or (spans[0] if spans else "Testo della proposta non disponibile."), 900)
                if node.get("origin") == "USER_AUTHORED":
                    item["author"] = "Fondatore"
                if node.get("date"):
                    item["date"] = _date(node["date"])
            elif kind in AGGREGATES:
                evidence = detail.get("evidence") or (detail.get("entity") or {}).get("evidence") or []
                span = next((e.get("span") for e in evidence if e.get("span")), "")
                item["text"] = _short(span or "Nessun passaggio testuale verificato per questo elemento.", 900)
            elif kind in SOURCES:
                spans = detail.get("spans") or []
                span = next((s.get("span") for s in spans if s.get("span")), "")
                file_name = detail.get("file_name")
                owner = detail.get("owner_conversation")
                conversation = self.nodes.get("conversation:" + str(owner)) if owner else None
                prefix = (f"Allegato: {file_name}. " if file_name else "")
                if conversation:
                    prefix += f"Conversazione di origine: {_title(conversation)}. "
                    item["source"] = {"id": conversation["id"], "title": _title(conversation)}
                item["text"] = _short(prefix +
                                      (span if span and not re.fullmatch(r"[a-f0-9]{64}", span) else
                                       "Nessun passaggio testuale verificato per questa fonte."), 900)
            elif kind == "conversation":
                first = next((x for x in self.children.get(identifier, []) if self.nodes.get(x, {}).get("kind") == "proposal"), None)
                proposal = self.detail(first) if first else None
                item["text"] = _short((proposal or {}).get("statement") or "Il testo integrale della conversazione non è disponibile.", 900)
            else:
                item["text"] = "Nessun testo verificato disponibile."
            if node.get("date") and "date" not in item:
                item["date"] = _date(node["date"])
            count = (node.get("counts") or {}).get("children")
            if count is not None:
                item["children_count"] = count
        elif node.get("date"):
            item["date"] = _date(node["date"])
        return item

    def _base(self, identifier: str, section: str, state: str = "ok", message: str | None = None) -> dict:
        result = {"id": identifier, "section": section, "state": state}
        if message:
            result["message"] = message
        return result

    def summary(self, identifier: str) -> dict:
        node = self.node(identifier) or {}
        kind = node.get("kind", "")
        detail = self.detail(identifier) or {}
        counts = node.get("counts") or {}
        sentences: list[str] = []
        facts: list[dict] = []
        if kind in AGGREGATES:
            descendants = [self.nodes[x] for x in self.descendants(identifier) if x in self.nodes]
            by_kind = Counter(x.get("kind") for x in descendants)
            sentences.append(f"Questo {KIND.get(kind, 'elemento').lower()} comprende {len(descendants)} elementi nella sua gerarchia, tra cui {by_kind['conversation']} conversazioni, {by_kind['proposal']} proposte e {by_kind['attachment_source'] + by_kind['non_conversation_source']} fonti.")
            direct = sorted((self.nodes[x] for x in self.members(identifier) if x in self.nodes),
                            key=lambda x: (-float((x.get("importance") or {}).get("value") or 0), x["id"]))
            if direct:
                sentences.append("Fra gli elementi direttamente collegati compaiono " + ", ".join(_title(x) for x in direct[:3]) + ".")
                stop = {"allegato", "fonte", "messaggio", "senza", "titolo", "project", "progetto",
                        "with", "from", "part", "the", "and", "della", "delle", "degli", "dello",
                        "assistant", "readme", "final", "handoff", "using"}
                themes = Counter(word.casefold() for child in direct if child.get("kind") not in SOURCES
                                 for word in set(re.findall(r"[^\W\d_]{4,}", _title(child)))
                                 if word.casefold() not in stop)
                repeated = [(word, count) for word, count in sorted(themes.items(), key=lambda pair: (-pair[1], pair[0])) if count >= 2][:3]
                if repeated:
                    sentences.append("Nei titoli ricorrono " + ", ".join(f"{word} ({count})" for word, count in repeated) + ".")
            else:
                sentences.append("Non risultano elementi figli nella gerarchia disponibile.")
            if counts.get("live_proposals") is not None:
                sentences.append(f"I dati registrano {counts['live_proposals']} proposte attive e {counts.get('passages', 0)} passaggi citati per questo elemento.")
            evidence = detail.get("evidence") or (detail.get("entity") or {}).get("evidence") or []
            span = next((e.get("span") for e in evidence if e.get("span")), None)
            if span:
                sentences.append("Un passaggio attestato riporta: «" + _short(span, 180) + "».")
            links = Counter((edge["type"], "uscente" if edge["source"] == identifier else "entrante") for edge in self.edges.get(identifier, []))
            if links:
                (link_type, direction), count = links.most_common(1)[0]
                label = self._relation_label(link_type, direction)
                sentences.append(f"Il collegamento più frequente è «{label}», presente {count} volte.")
            else:
                sentences.append("Non risultano collegamenti registrati oltre alla gerarchia dei contenuti.")
            facts = [{"label": "Elementi", "value": len(descendants)}, {"label": "Proposte attive", "value": counts.get("live_proposals", by_kind["proposal"])}]
        elif kind == "proposal":
            statement = _short(detail.get("statement"), 230)
            spans = [c.get("span") for c in detail.get("citations", []) if c.get("span")]
            sentences.append(f"La proposta descrive: {statement}" if statement else "Il testo della proposta non è disponibile nei dati verificati.")
            sentences.append(f"È sostenuta da {len(spans)} passaggi citati con testo disponibile.")
            if spans:
                sentences.append("Un passaggio riporta: «" + _short(spans[0], 190) + "»." )
            if node.get("date"):
                sentences.append(f"La data registrata è {_date(node['date'])}.")
            else:
                sentences.append("La data del contenuto non è disponibile.")
            relation_classes = {"esplorativa" if e.get("class") == "exploratory" else "attestata"
                                for e in self.edges.get(identifier, []) if e.get("type") != "classified_in"}
            if relation_classes:
                sentences.append("Sono registrati collegamenti " + " e ".join(sorted(relation_classes)) + " per questa proposta.")
            facts = [{"label": "Passaggi citati", "value": len(spans)}]
        elif kind == "conversation":
            children = [self.nodes[x] for x in self.children.get(identifier, []) if x in self.nodes]
            sentences.append(f"La conversazione contiene {len(children)} proposte verificabili nel grafo e {counts.get('passages', 0)} passaggi citati.")
            if children:
                sentences.append("Tra gli argomenti registrati: " + ", ".join(_title(x) for x in children[:3]) + ".")
            else:
                sentences.append("Non sono disponibili proposte collegate a questa conversazione.")
            inventory = detail.get("inventory") or {}
            if inventory.get("messages"):
                sentences.append(f"L'inventario registra {inventory['messages']} messaggi; il testo integrale non è incluso in questa proiezione.")
            else:
                sentences.append("Il testo integrale della conversazione non è incluso in questa proiezione.")
            if node.get("date"):
                sentences.append(f"La data iniziale registrata è {_date(node['date'])}.")
            facts = [{"label": "Proposte", "value": len(children)}, {"label": "Passaggi", "value": counts.get("passages", 0)}]
        elif kind in SOURCES:
            children = [self.nodes[x] for x in self.children.get(identifier, []) if x in self.nodes]
            name = detail.get("file_name")
            sentences.append(f"La fonte è un allegato denominato {name}." if name else "Questa fonte conserva passaggi citati nel grafo.")
            sentences.append(f"Da questa fonte derivano {len(children)} proposte e {counts.get('passages', 0)} passaggi citati.")
            owner = detail.get("owner_conversation")
            if owner and "conversation:" + owner in self.nodes:
                sentences.append(f"La conversazione di origine è «{_title(self.nodes['conversation:' + owner])}».")
            else:
                sentences.append("La conversazione di origine non è identificabile in questa proiezione.")
            if node.get("date"):
                sentences.append(f"La data registrata è {_date(node['date'])}.")
            sentences.append("Il testo integrale della fonte non è disponibile in questa proiezione; restano consultabili i passaggi citati.")
            facts = [{"label": "Proposte", "value": len(children)}, {"label": "Passaggi", "value": counts.get("passages", 0)}]
        else:
            citation = detail.get("citation") or {}
            text = citation.get("span")
            sentences = [f"Il passaggio citato riporta: «{_short(text, 220)}»." if text else "Il testo del passaggio non è disponibile.",
                         "Questo passaggio documenta una proposta nel grafo."]
            record = detail.get("record") or {}
            sentences.append(f"La data registrata è {_date(record['date'])}." if record.get("date") else "La data del passaggio non è disponibile.")
        insufficient = any(any(phrase in s.lower() for phrase in
                               ("non è disponib", "non sono disponib", "non risultano", "non è incluso", "non è identificabile"))
                           for s in sentences)
        while len(sentences) < 3:
            sentences.append("Ulteriori dettagli non sono disponibili nei dati verificati.")
            insufficient = True
        result = self._base(identifier, "summary", "partial" if insufficient else "ok",
                            "Alcuni dettagli non sono disponibili nei dati verificati." if insufficient else None)
        result.update({"title": _title(node), "kind_label": KIND.get(kind, "Elemento"),
                       "sentences": sentences[:6], "facts": facts, "insufficient": insufficient})
        return result

    def content(self, identifier: str, offset: int, limit: int, query: str) -> dict:
        node = self.node(identifier) or {}
        kind = node.get("kind")
        if kind == "passage":
            ids = [identifier]
        elif kind == "proposal":
            ids = [identifier] + self.children.get(identifier, [])
        elif kind in SOURCES:
            ids = [identifier] + self.descendants(identifier)
        elif kind == "conversation":
            ids = self.descendants(identifier)
        elif kind in AGGREGATES:
            ids = self.members(identifier)
        else:
            ids = list(self.children.get(identifier, []))
        if kind in AGGREGATES:
            ids.sort(key=lambda x: (-float((self.nodes.get(x, {}).get("importance") or {}).get("value") or 0), x))
        if query:
            words = query.casefold().split()
            items = [self._item(x) for x in ids]
            items = [item for item in items if all(w in (item["title"] + " " + item["text"]).casefold() for w in words)]
            total = len(items)
            page = items[offset:offset + limit]
        else:
            total = len(ids)
            page = [self._item(x) for x in ids[offset:offset + limit]]
        state = "ok" if page else "empty"
        message = None if page else ("Non ci sono altri contenuti in questa pagina." if total and offset >= total else
                                     "Nessun contenuto corrisponde alla ricerca." if query else
                                     "Nessun passaggio o figlio verificato è disponibile per questo elemento.")
        result = self._base(identifier, "content", state, message)
        result.update({"total": total, "offset": offset, "limit": limit, "items": page})
        if query:
            result["query"] = query
        return result

    def provenance(self, identifier: str, offset: int, limit: int) -> dict:
        node = self.node(identifier) or {}
        kind = node.get("kind")
        detail = self.detail(identifier) or {}
        chain: list[dict] = []
        technical: list[dict] = []
        if kind in AGGREGATES:
            chain.append({"step": "origine", "label": "Origine", "value": "Raggruppamento di elementi verificati nel grafo"})
            if kind == "domain":
                member_ids = self.members(identifier)
                listed = [self.nodes[x] for x in member_ids if self.nodes[x].get("kind") in SOURCES | {"conversation"}]
            else:
                listed = [self.nodes[x] for x in self.descendants(identifier) if x in self.nodes
                          and self.nodes[x].get("kind") in SOURCES | {"conversation"}]
            descendants = listed
            sources = [x for x in descendants if x.get("kind") in SOURCES]
            conversations = [x for x in descendants if x.get("kind") == "conversation"]
            for evidence in (detail.get("evidence") or [])[:1]:
                if evidence.get("span"):
                    chain.append({"step": "passaggio", "label": "Passaggio attestato", "value": _short(evidence["span"], 300)})
            listed = sorted(conversations + sources, key=lambda x: (_title(x).casefold(), x["id"]))
            aggregate = {"conversations": len(conversations), "sources": len(sources),
                         "attachments": sum(x.get("kind") == "attachment_source" for x in sources),
                         "items": [self._item(x["id"], with_text=False) for x in listed[offset:offset + limit]],
                         "total": len(listed), "offset": offset, "limit": limit}
            chain.append({"step": "acquisizione", "label": "Acquisizione", "value": "Elementi presenti nel dataset di revisione verificato"})
        else:
            aggregate = None
            record = detail.get("record") or {}
            if kind == "proposal":
                chain.append({"step": "origine", "label": "Origine", "value": "Proposta ricavata da passaggi citati"})
                parent = node.get("parent")
                if parent in self.nodes:
                    p = self.nodes[parent]
                    chain.append({"step": "conversazione" if p.get("kind") == "conversation" else "file",
                                  "label": "Conversazione" if p.get("kind") == "conversation" else "Fonte",
                                  "value": _title(p), "id": parent})
                citation = next((x for x in detail.get("citations", []) if x.get("span")), None)
                if citation:
                    sid = "source:" + str(citation.get("source_id", ""))
                    if sid in self.nodes:
                        chain.append({"step": "allegato" if self.nodes[sid].get("kind") == "attachment_source" else "file",
                                      "label": "Allegato" if self.nodes[sid].get("kind") == "attachment_source" else "Fonte",
                                      "value": _title(self.nodes[sid]), "id": sid})
                    passage_id = next((x for x in self.children.get(identifier, []) if x.startswith("passage:")), None)
                    passage = self.detail(passage_id) if passage_id else None
                    passage_record = (passage or {}).get("record") or {}
                    if passage_record.get("kind") == "message":
                        chain.append({"step": "messaggio", "label": "Messaggio", "value": "Messaggio citato nella fonte"})
                    chain.append({"step": "passaggio", "label": "Passaggio citato", "value": _short(citation["span"], 300),
                                  **({"id": passage_id} if passage_id else {})})
                    role = passage_record.get("role")
                    if role:
                        chain.append({"step": "autore", "label": "Autore", "value": ROLE.get(str(role).lower(), str(role).capitalize())})
                    for key in ("source_id", "snapshot_digest", "start_byte", "end_byte"):
                        if citation.get(key) is not None:
                            technical.append({"label": key, "value": str(citation[key])})
                if node.get("origin") == "USER_AUTHORED" and not any(x["step"] == "autore" for x in chain):
                    chain.append({"step": "autore", "label": "Autore", "value": "Fondatore"})
            elif kind == "passage":
                chain.append({"step": "origine", "label": "Origine", "value": "Citazione conservata in una fonte verificata"})
                citation = detail.get("citation") or {}
                sid = "source:" + str(citation.get("source_id", ""))
                if sid in self.nodes:
                    chain.append({"step": "allegato" if self.nodes[sid].get("kind") == "attachment_source" else "file",
                                  "label": "Fonte", "value": _title(self.nodes[sid]), "id": sid})
                if record.get("kind") == "message":
                    chain.append({"step": "messaggio", "label": "Messaggio", "value": "Messaggio citato nella fonte"})
                if citation.get("span"):
                    chain.append({"step": "passaggio", "label": "Passaggio", "value": _short(citation["span"], 300)})
                role = record.get("role")
                if role:
                    chain.append({"step": "autore", "label": "Autore", "value": ROLE.get(str(role).lower(), str(role).capitalize())})
                for key in ("source_id", "snapshot_digest", "start_byte", "end_byte"):
                    if citation.get(key) is not None:
                        technical.append({"label": key, "value": str(citation[key])})
            elif kind == "conversation":
                inventory = detail.get("inventory") or {}
                chain.append({"step": "origine", "label": "Origine", "value": "Conversazione registrata nell'inventario"})
                chain.append({"step": "conversazione", "label": "Conversazione", "value": _title(node), "id": identifier})
                if inventory.get("provider"):
                    chain.append({"step": "acquisizione", "label": "Acquisizione", "value": str(inventory["provider"])})
                for key in ("conversation",):
                    if inventory.get(key):
                        technical.append({"label": key, "value": str(inventory[key])})
            elif kind in SOURCES:
                chain.append({"step": "origine", "label": "Origine", "value": "Allegato acquisito" if kind == "attachment_source" else "Fonte acquisita"})
                owner = detail.get("owner_conversation")
                cid = "conversation:" + str(owner)
                if cid in self.nodes:
                    chain.append({"step": "conversazione", "label": "Conversazione di origine", "value": _title(self.nodes[cid]), "id": cid})
                chain.append({"step": "allegato" if kind == "attachment_source" else "file", "label": "Allegato" if kind == "attachment_source" else "Fonte", "value": detail.get("file_name") or _title(node), "id": identifier})
                spans = detail.get("spans") or []
                span = next((s.get("span") for s in spans if s.get("span") and not re.fullmatch(r"[a-f0-9]{64}", s["span"])), None)
                if span:
                    chain.append({"step": "passaggio", "label": "Passaggio citato", "value": _short(span, 300)})
                if detail.get("provider"):
                    chain.append({"step": "acquisizione", "label": "Acquisizione", "value": str(detail["provider"])})
                for key in ("source_id", "snapshot_digest", "asset_digest", "asset_id"):
                    if detail.get(key):
                        technical.append({"label": key, "value": str(detail[key])})
            date = record.get("date") or node.get("date") or detail.get("source_date")
            if date:
                chain.append({"step": "data", "label": "Data", "value": _date(date)})
            if not any(x["step"] == "acquisizione" for x in chain):
                chain.append({"step": "acquisizione", "label": "Acquisizione", "value": "Snapshot verificato nel dataset di revisione" if any(x["label"] == "snapshot_digest" for x in technical) else "Presente nel dataset di revisione verificato"})
        if self.manifest.get("digest"):
            technical.append({"label": "Digest del dataset", "value": self.manifest["digest"]})
        if not chain:
            chain = [{"step": "origine", "label": "Origine", "value": "Origine non documentata nei dati disponibili"}]
        state = "ok" if len(chain) > 1 else "partial"
        result = self._base(identifier, "provenance", state,
                            "La catena di provenienza è incompleta nei dati disponibili." if state == "partial" else None)
        result.update({"chain": chain, "technical": technical})
        if aggregate is not None:
            result["aggregate"] = aggregate
        return result

    @staticmethod
    def _relation_label(kind: str, direction: str) -> str:
        if kind == "classified_in":
            return "Classificato in" if direction == "uscente" else "Contiene"
        if kind == "mentions":
            return "Menziona" if direction == "uscente" else "Menzionato in"
        if kind == "relates":
            return "Collegato a"
        return EXPLORATORY.get(kind, "Collegato a")

    def relations(self, identifier: str, offset: int, limit: int, group: str) -> dict:
        buckets: dict[tuple[str, str, str], dict[str, dict]] = defaultdict(dict)
        for edge in self.edges.get(identifier, []):
            direction = "uscente" if edge["source"] == identifier else "entrante"
            other = edge["target"] if direction == "uscente" else edge["source"]
            if other not in self.nodes:
                continue
            kind = edge["type"]
            cls = "strutturale" if kind == "classified_in" else ("esplorativa" if edge.get("class") == "exploratory" or kind in EXPLORATORY else "attestata")
            key = (cls, kind, direction)
            buckets[key][other] = self._item(other, with_text=False)
        parent = (self.node(identifier) or {}).get("parent")
        if parent in self.nodes:
            buckets[("strutturale", "parent", "uscente")][parent] = self._item(parent, with_text=False)
        for child in self.children.get(identifier, []):
            if child in self.nodes:
                buckets[("strutturale", "parent", "entrante")][child] = self._item(child, with_text=False)
        groups = []
        matched = False
        for cls, class_label in (("attestata", "Attestate"), ("esplorativa", "Esplorative"),
                                 ("strutturale", "Strutturali · provenienza")):
            types = []
            for (bucket_cls, kind, direction), nodes in sorted(buckets.items()):
                if bucket_cls != cls:
                    continue
                key = f"{kind}:{direction}"
                if group and group != key:
                    continue
                matched = True
                ordered = sorted(nodes.values(), key=lambda x: (x["title"].casefold(), x["id"]))
                start = offset if group else 0
                size = limit if group else min(limit, 10)
                types.append({"key": key, "label": ("Contenuto in" if direction == "uscente" else "Contiene") if kind == "parent" else self._relation_label(kind, direction),
                              "direction": direction, "count": len(ordered), "items": ordered[start:start + size],
                              "has_more": start + size < len(ordered)})
            if types:
                groups.append({"class": cls, "class_label": class_label, "types": types})
        if group and not matched:
            raise ValueError("Gruppo di relazioni non trovato")
        total = sum(len(v) for v in buckets.values())
        result = self._base(identifier, "relations", "ok" if total else "empty",
                            None if total else "Non risultano relazioni per questo elemento.")
        result.update({"groups": groups, "total": total})
        return result

    def section(self, identifier: str, section: str, *, offset: int = 0, limit: int = 25,
                query: str = "", group: str = "") -> dict:
        if identifier not in self.nodes and identifier not in self.offsets:
            raise KeyError(identifier)
        if section == "summary":
            return self.summary(identifier)
        if section == "content":
            return self.content(identifier, offset, limit, query)
        if section == "provenance":
            return self.provenance(identifier, offset, limit)
        if section == "relations":
            return self.relations(identifier, offset, limit, group)
        raise ValueError("Sezione non valida")
