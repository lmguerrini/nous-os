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
               "dependency": "Dipendenza", "resonance": "Risonanza", "card": "Ponte esplorativo",
               "contradiction": "Contraddizione"}
ROLE = {"user": "Fondatore", "assistant": "Assistente", "human": "Fondatore", "system": "Sistema"}
AGGREGATES = {"domain", "project", "system", "work"}
SOURCES = {"attachment_source", "non_conversation_source"}


def _short(value: object, length: int = 420) -> str:
    text = _display(value)
    return text if len(text) <= length else text[:length - 1].rstrip() + "…"


def _date(value: object) -> str:
    raw = str(value or "")[:10]
    try:
        year, month, day = (int(part) for part in raw.split("-"))
        return f"{day} {('gen feb mar apr mag giu lug ago set ott nov dic'.split())[month - 1]} {year}"
    except (ValueError, IndexError):
        return raw


def _display(value: object) -> str:
    """Decode only a single layer of literal text escapes for display."""
    return re.sub(r'\\(?:n|t|r|"|\\)', lambda m: {r'\n': '\n', r'\t': '\t', r'\r': '\r', r'\"': '"', r'\\': '\\'}[m.group()], str(value or '')).strip()


def _technical_text(value: object) -> bool:
    text = str(value or '').strip()
    return bool(text and (re.fullmatch(r'[0-9a-fA-F]{32,}', text) or
                          re.fullmatch(r'(?:[A-Z0-9]{20,}|(?:asr|src|ent)_[A-Z0-9]{16,})', text)))


def _readable(value: object) -> str:
    return 'Impronta tecnica del file (nessun testo leggibile)' if _technical_text(value) else _display(value)


def _count(n: int, singular: str, plural: str) -> str:
    return f'{n} {singular if n == 1 else plural}'


TECH_LABELS = {'source_id': 'Identificativo della fonte', 'snapshot_digest': 'Impronta dello snapshot',
               'start_byte': 'Posizione nel testo (byte iniziale)', 'end_byte': 'Posizione nel testo (byte finale)',
               'asset_digest': 'Impronta del file', 'asset_id': 'Identificativo del file',
               'conversation': 'Identificativo della conversazione', 'raw_text': 'Testo verificato originale'}


def _message(record: dict) -> str:
    if record.get('kind') != 'message':
        return 'Messaggio non identificato singolarmente: il passaggio è localizzato per posizione nel testo (vedi Dettagli tecnici)'
    role = ROLE.get(str(record.get('role', '')).lower(), '')
    date = _date(record.get('date')) if record.get('date') else ''
    if not role and not date:
        return 'Messaggio non identificato singolarmente: il passaggio è localizzato per posizione nel testo (vedi Dettagli tecnici)'
    author = "dell'Assistente" if role == 'Assistente' else f'del {role}' if role else ''
    return ' '.join(part for part in ('Messaggio', author, f'del {date}' if date else '') if part)


def _readable_context(value: object) -> str:
    text = str(value or "").strip()
    if any(marker in text for marker in ('content_type', 'ntent_type', '"parts"', '"payload"', '{"', '"}')):
        return ""
    return text


def _title(node: dict) -> str:
    raw = _display(node.get("title") or node.get("title_full") or "Senza titolo")
    parts = [_date(part.strip()) if re.fullmatch(r'\d{4}-\d{2}-\d{2}', part.strip()) else part.strip()
             for part in raw.split(' · ') if part.strip()]
    return ' · '.join(parts)


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
        if _technical_text(item['title']):
            item['technical'] = [{"label": 'Titolo originale', "value": item['title']}]
            item['title'] = 'Impronta tecnica del file (nessun testo leggibile)'
        if kind == "passage":
            raw_span = (detail.get("citation") or {}).get("span") or ""
            if _technical_text(raw_span):
                item["title"] = "Impronta tecnica del file (nessun testo leggibile)"
                item["technical"] = [{"label": TECH_LABELS["raw_text"], "value": str(raw_span)}]
            elif _display(raw_span) != str(raw_span):
                item["technical"] = [{"label": TECH_LABELS["raw_text"], "value": str(raw_span)}]
            else:
                # Exported passage titles can contain an empty date segment.
                item["title"] = " · ".join(part for part in _title(node).split(" · ") if part.strip())
        if with_text:
            if kind == "passage":
                citation = detail.get("citation") or {}
                value = citation.get("span") or ""
                if value:
                    context = " ".join(x for x in (_readable_context(detail.get("context_before")), value,
                                                     _readable_context(detail.get("context_after"))) if x)
                    item["text"] = _short(_readable(value) if _technical_text(value) else _readable(context or value), 900)
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
                raw = statement or (spans[0] if spans else "Testo della proposta non disponibile.")
                item["text"] = _short(_readable(raw), 900)
                if _technical_text(raw) or _display(raw) != str(raw):
                    item["technical"] = [{"label": TECH_LABELS["raw_text"], "value": str(raw)}]
                if node.get("origin") == "USER_AUTHORED":
                    item["author"] = "Fondatore"
                if node.get("date"):
                    item["date"] = _date(node["date"])
                parent = self.nodes.get(node.get('parent'))
                if parent:
                    item['source'] = {'id': parent['id'], 'title': _title(parent)}
            elif kind in AGGREGATES:
                candidates = [edge["source"] for edge in self.edges.get(identifier, [])
                              if edge.get("type") == "mentions" and edge.get("target") == identifier]
                candidates = sorted(set(candidates), key=lambda x: (
                    -int((self.nodes.get(x) or {}).get("status") == "canon"),
                    -int((self.nodes.get(x) or {}).get("subkind") == "DECISION"),
                    -len(self.edges.get(x, [])), x))
                statement = next((s for x in candidates if (s := (self.detail(x) or {}).get('statement'))
                                  and not s.lstrip().startswith('#') and not s.strip().isupper()), '')
                if statement:
                    item["text"] = _short(_readable(statement), 900)
                else:
                    item["text"] = f"{_count(len(candidates), 'elemento collegato', 'elementi collegati')}"
            elif kind in SOURCES:
                spans = detail.get("spans") or []
                span = next((s.get("span") for s in spans if s.get("span")), "")
                file_name = detail.get("file_name")
                owner = detail.get("owner_conversation")
                conversation = self.nodes.get("conversation:" + str(owner)) if owner else None
                prefix = (f"{'Allegato' if kind == 'attachment_source' else 'Fonte'}: {file_name}. " if file_name else "")
                if conversation:
                    prefix += f"Conversazione di origine: {_title(conversation)}. "
                    item["source"] = {"id": conversation["id"], "title": _title(conversation)}
                item["text"] = _short(prefix +
                                      (_readable(span) if span and not _technical_text(span) else
                                       "Nessun passaggio testuale verificato per questa fonte."), 900)
            elif kind == "conversation":
                first = next((x for x in self.children.get(identifier, []) if self.nodes.get(x, {}).get("kind") == "proposal"), None)
                proposal = self.detail(first) if first else None
                item["text"] = _short(_readable((proposal or {}).get("statement") or "Il testo integrale della conversazione non è disponibile."), 900)
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
            direct_ids = [x for x in self.children.get(identifier, []) if x in self.nodes]
            direct = sorted((self.nodes[x] for x in direct_ids),
                            key=lambda x: (-int((x.get('counts') or {}).get('children') or 0), x['id']))
            classified = len(self.members(identifier)) if kind == 'domain' else len(direct)
            if kind == 'domain':
                relation_types = [t for g in self.relations(identifier, 0, 10, '')['groups'] for t in g['types']]
                direct_classifications = next((t['count'] for t in relation_types
                                               if t['key'] == 'classified_in:entrante'), 0)
                sentences.append(
                    f"Questo dominio ha {_count(len(direct), 'figlio diretto', 'figli diretti')} nella gerarchia; "
                    f"{_count(classified, 'elemento', 'elementi')} indicano questo dominio fra i propri domini e "
                    f"{_count(direct_classifications, 'è classificato direttamente qui', 'sono classificati direttamente qui')}."
                )
            else:
                sentences.append(f"Questo {KIND.get(kind, 'elemento').lower()} comprende {_count(len(descendants), 'elemento', 'elementi')} nella sua gerarchia, tra cui {_count(by_kind['conversation'], 'conversazione', 'conversazioni')}, {_count(by_kind['proposal'], 'proposta', 'proposte')} e {_count(by_kind['attachment_source'] + by_kind['non_conversation_source'], 'fonte', 'fonti')}.")
            if direct:
                projects = [self.nodes[x] for x in self.members(identifier)
                            if (self.nodes.get(x) or {}).get('kind') in {'project', 'system'}]
                projects.sort(key=lambda x: (-int((x.get('counts') or {}).get('children') or 0), x['id']))
                if projects:
                    sentences.append(("Il principale progetto o sistema per numero di figli diretti è " if len(projects) == 1 else "I principali progetti e sistemi per numero di figli diretti sono ") + "; ".join(f"«{_title(x)}» ({(x.get('counts') or {}).get('children', 0)})" for x in projects[:3]) + ".")
                conversations = sorted((x for x in self.members(identifier) if (self.nodes.get(x) or {}).get('kind') == 'conversation'),
                                       key=lambda x: (-int((self.nodes[x].get('counts') or {}).get('live_proposals') or 0), x))
                if conversations:
                    sentences.append(("La conversazione più ampia è " if len(conversations) == 1 else "Le conversazioni più ampie sono ") + "; ".join(f"«{_title(self.nodes[x])}» ({_count(int((self.nodes[x].get('counts') or {}).get('live_proposals') or 0), 'proposta', 'proposte')})" for x in conversations[:2]) + ".")
            else:
                sentences.append("Non risultano elementi figli nella gerarchia disponibile.")
            if kind == 'domain':
                member_nodes = [self.nodes[x] for x in self.members(identifier) if x in self.nodes]
                conv = sum(x.get('kind') == 'conversation' for x in member_nodes)
                attachments = sum(x.get('kind') == 'attachment_source' for x in member_nodes)
                sentences.append(f"Le proposte provengono da {_count(conv, 'conversazione', 'conversazioni')} e {_count(attachments, 'allegato', 'allegati')}.")
            elif counts.get("live_proposals") is not None:
                sentences.append(f"I dati registrano {_count(counts['live_proposals'], 'proposta attiva', 'proposte attive')} e {_count(counts.get('passages', 0), 'passaggio citato', 'passaggi citati')} per questo elemento.")
            evidence = detail.get("evidence") or (detail.get("entity") or {}).get("evidence") or []
            span = next((e.get("span") for e in evidence if e.get("span")), None)
            if span:
                sentences.append("Un passaggio attestato riporta: «" + _short(_readable(span), 180) + "».")
            relation_types = [t for g in self.relations(identifier, 0, 10, '')['groups'] for t in g['types']]
            links = Counter({(t['key'].rsplit(':', 1)[0], t['direction']): t['count'] for t in relation_types})
            if links:
                (link_type, direction), count = links.most_common(1)[0]
                label = next((t['label'] for t in relation_types
                              if t['key'] == f'{link_type}:{direction}'), self._relation_label(link_type, direction))
                sentences.append(f"Il collegamento più frequente è «{label}», presente {'una volta' if count == 1 else str(count) + ' volte'}.")
            else:
                sentences.append("Non risultano collegamenti registrati oltre alla gerarchia dei contenuti.")
            facts = [{"label": "Elementi nella gerarchia", "value": len(descendants)}, {"label": "Proposte attive", "value": counts.get("live_proposals", by_kind["proposal"])}]
        elif kind == "proposal":
            statement = _short(_readable(detail.get("statement")), 230)
            spans = [c.get("span") for c in detail.get("citations", []) if c.get("span")]
            sentences.append(f"La proposta descrive: {statement}" if statement else "Il testo della proposta non è disponibile nei dati verificati.")
            sentences.append(f"È sostenuta da {_count(len(spans), 'passaggio citato', 'passaggi citati')} con testo disponibile.")
            if spans:
                sentences.append("Un passaggio riporta: «" + _short(_readable(spans[0]), 190) + "»." )
            if node.get("date"):
                sentences.append(f"La data registrata è {_date(node['date'])}.")
            else:
                sentences.append("La data del contenuto non è disponibile.")
            relation = self.relations(identifier, 0, 10, '')
            relevant = [t for g in relation['groups'] if g['class'] != 'strutturale' for t in g['types']]
            if relevant:
                attested = [t for g in relation['groups'] if g['class'] == 'attestata' for t in g['types']]
                exploratory = [t for g in relation['groups'] if g['class'] == 'esplorativa' for t in g['types']]
                parts = []
                for types, adjective in ((attested, 'attestato'), (exploratory, 'esplorativo')):
                    if types:
                        number = sum(t['count'] for t in types)
                        direction = ' in entrata' if all(t['direction'] == 'entrante' for t in types) else ' in uscita' if all(t['direction'] == 'uscente' for t in types) else ''
                        examples = ', '.join(f"{t['label']} {t['count']}" for t in types[:4])
                        if len(types) == 1 and types[0]['count'] == 1 and types[0]['items']:
                            linked = types[0]['items'][0]
                            examples = f"{types[0]['label']}: {linked['title']}" if linked['title'].lower().endswith(' · ' + linked['kind_label'].lower()) else f"{types[0]['label']}: {linked['title']} · {linked['kind_label'].lower()}"
                        plural = 'attestati' if adjective == 'attestato' else 'esplorativi'
                        parts.append(f"{_count(number, 'collegamento ' + adjective, 'collegamenti ' + plural)}{direction} ({examples})")
                sentences.append('Ha ' + ' e '.join(parts) + '.')
            facts = [{"label": "Passaggi citati", "value": len(spans)}]
        elif kind == "conversation":
            children = [self.nodes[x] for x in self.children.get(identifier, []) if x in self.nodes]
            sentences.append(f"La conversazione contiene {_count(len(children), 'proposta verificabile', 'proposte verificabili')} nel grafo e {_count(counts.get('passages', 0), 'passaggio citato', 'passaggi citati')}.")
            if children:
                children.sort(key=lambda x: (-int(x.get('status') == 'canon'), -int(x.get('subkind') == 'DECISION'), -len(self.edges.get(x['id'], [])), x['id']))
                sentences.append("Tra gli argomenti registrati: " + "; ".join(f'«{_title(x)}»' for x in children[:3]) + ".")
            else:
                sentences.append("Non sono disponibili proposte collegate a questa conversazione.")
            inventory = detail.get("inventory") or {}
            if inventory.get("messages"):
                sentences.append(f"L'inventario registra {_count(inventory['messages'], 'messaggio', 'messaggi')}; il testo integrale non è incluso in questa proiezione.")
            else:
                sentences.append("Il testo integrale della conversazione non è incluso in questa proiezione.")
            if node.get("date"):
                sentences.append(f"La data iniziale registrata è {_date(node['date'])}.")
            facts = [{"label": "Proposte", "value": len(children)}, {"label": "Passaggi", "value": counts.get("passages", 0)}]
        elif kind in SOURCES:
            children = [self.nodes[x] for x in self.children.get(identifier, []) if x in self.nodes]
            name = detail.get("file_name")
            sentences.append(f"La fonte è {'un allegato' if kind == 'attachment_source' else 'un file'} denominato {name}." if name else "Questa fonte conserva passaggi citati nel grafo.")
            sentences.append(f"Da questa fonte derivano {_count(len(children), 'proposta', 'proposte')} e {_count(counts.get('passages', 0), 'passaggio citato', 'passaggi citati')}.")
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
            sentences = [f"Il passaggio citato riporta: «{_short(_readable(text), 220)}»." if text else "Il testo del passaggio non è disponibile.",
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
        result.update({"title": self._item(identifier, with_text=False)['title'], "kind_label": KIND.get(kind, "Elemento"),
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
            ids = self.descendants(identifier)
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
        if kind in SOURCES:
            count = sum(self.nodes.get(x, {}).get('kind') == 'proposal' for x in self.children.get(identifier, []))
            result['header'] = f"{_count(count, 'proposta deriva', 'proposte derivano')} da questo allegato · testo integrale non disponibile in questa proiezione" if kind == 'attachment_source' else 'Testo integrale non disponibile in questa proiezione'
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
                    chain.append({"step": "passaggio", "label": "Passaggio attestato", "value": _short(_readable(evidence["span"]), 300)})
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
                    chain.append({"step": "messaggio", "label": "Messaggio", "value": _message(passage_record)})
                    chain.append({"step": "passaggio", "label": "Passaggio citato", "value": _short(_readable(citation["span"]), 300),
                                  **({"id": passage_id} if passage_id else {})})
                    role = passage_record.get("role")
                    if role:
                        chain.append({"step": "autore", "label": "Autore", "value": ROLE.get(str(role).lower(), str(role).capitalize())})
                    for key in ("source_id", "snapshot_digest", "start_byte", "end_byte"):
                        if citation.get(key) is not None:
                            technical.append({"label": TECH_LABELS[key], "value": str(citation[key])})
                    if _display(citation['span']) != str(citation['span']) or _technical_text(citation['span']):
                        technical.append({"label": TECH_LABELS['raw_text'], "value": str(citation['span'])})
                if node.get("origin") == "USER_AUTHORED" and not any(x["step"] == "autore" for x in chain):
                    chain.append({"step": "autore", "label": "Autore", "value": "Fondatore"})
            elif kind == "passage":
                chain.append({"step": "origine", "label": "Origine", "value": "Citazione conservata in una fonte verificata"})
                citation = detail.get("citation") or {}
                sid = "source:" + str(citation.get("source_id", ""))
                if sid in self.nodes:
                    chain.append({"step": "allegato" if self.nodes[sid].get("kind") == "attachment_source" else "file",
                                  "label": "Fonte", "value": _title(self.nodes[sid]), "id": sid})
                chain.append({"step": "messaggio", "label": "Messaggio", "value": _message(record)})
                if citation.get("span"):
                    chain.append({"step": "passaggio", "label": "Passaggio", "value": _short(_readable(citation["span"]), 300)})
                role = record.get("role")
                if role:
                    chain.append({"step": "autore", "label": "Autore", "value": ROLE.get(str(role).lower(), str(role).capitalize())})
                for key in ("source_id", "snapshot_digest", "start_byte", "end_byte"):
                    if citation.get(key) is not None:
                        technical.append({"label": TECH_LABELS[key], "value": str(citation[key])})
                if citation.get('span') and (_display(citation['span']) != str(citation['span']) or _technical_text(citation['span'])):
                    technical.append({"label": TECH_LABELS['raw_text'], "value": str(citation['span'])})
            elif kind == "conversation":
                inventory = detail.get("inventory") or {}
                chain.append({"step": "origine", "label": "Origine", "value": "Conversazione registrata nell'inventario"})
                chain.append({"step": "conversazione", "label": "Conversazione", "value": _title(node), "id": identifier})
                if inventory.get("provider"):
                    chain.append({"step": "acquisizione", "label": "Acquisizione", "value": str(inventory["provider"])})
                for key in ("conversation",):
                    if inventory.get(key):
                        technical.append({"label": TECH_LABELS[key], "value": str(inventory[key])})
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
                    chain.append({"step": "passaggio", "label": "Passaggio citato", "value": _short(_readable(span), 300)})
                if detail.get("provider"):
                    chain.append({"step": "acquisizione", "label": "Acquisizione", "value": str(detail["provider"])})
                for key in ("source_id", "snapshot_digest", "asset_digest", "asset_id"):
                    if detail.get(key):
                        technical.append({"label": TECH_LABELS[key], "value": str(detail[key])})
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
            return "Classificato in" if direction == "uscente" else "Classificati qui"
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
            item = self._item(other, with_text=False)
            if kind == 'card' and edge.get('explanation'):
                item['statement'] = _readable(edge['explanation'])
            buckets[key][other] = item
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
                types.append({"key": key, "label": ("Contenuto in" if direction == "uscente" else "Contiene direttamente") if kind == "parent" else self._relation_label(kind, direction),
                              "relation_class": cls.capitalize(),
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
