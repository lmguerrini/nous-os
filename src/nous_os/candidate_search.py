"""Bounded, read-only retrieval of recorded candidate proposals.

The FTS table is process-local and expendable. It never confers canonical
standing: that comes only from the verified canon reader's exact id/version
join. Source semantic ranking describes cited sources, not candidate vectors.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
import unicodedata
from pathlib import Path

from nous_os.candidates import CandidateError, Proposal
from nous_os.identity import ASSERTION_PREFIX, InvalidIdentifier, canonical_bytes, digest_bytes, require_id
from nous_os.semantic_index import search as semantic_search
from nous_os.untrusted import UntrustedContentError, UntrustedText


class CandidateSearchError(Exception):
    """A stable refusal code; the message never contains private material."""


BUILD_SECONDS = 20.0
SEARCH_SECONDS = 2.0
SEMANTIC_SECONDS = 60.0
MAX_FIELD_BYTES = 1_000_000
# Refuse oversized raw rows before JSON decoding, including replaced versions.
MAX_RECORD_BYTES = 16_000_000
_LABELS = frozenset({
    "DECISION_STATED_BY_PERSON", "PROPOSAL_NOT_APPROVED", "HYPOTHESIS",
    "INTERPRETATION", "HISTORICAL_DESCRIPTION", "IMPLEMENTATION_STATE_AT_DATE",
})
_TAG = re.compile(r"(?:^|[;\n])\s*(epistemic|facet|scope):\s*([^;\n]+)", re.I)
_LOGGER = logging.getLogger(__name__)
_LOCK = threading.RLock()
# A timed-out daemon may still be inside the dense backend. Admit another
# dense call only after that worker actually exits.
_DENSE_LOCK = threading.Lock()
_CACHE: tuple[tuple[int, int, int, int], str, sqlite3.Connection, tuple[ReviewCandidate, ...],
              dict[str, str | None], dict[str, str], frozenset[str]] | None = None


def canon_index(root: Path):
    # Review imports the operation registry, so this import must be deferred.
    from nous_os.review import canon_index as read_canon
    return read_canon(root)


def _refuse(code: str) -> None:
    raise CandidateSearchError(code)


def _normal(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def _tags(notes: str | None, name: str) -> list[str]:
    return [value.strip() for key, value in _TAG.findall(notes or "") if key.lower() == name]


def _query(raw: str) -> tuple[str, str]:
    if type(raw) is not str:
        _refuse("InvalidQuery")
    trimmed = raw.strip()
    if not trimmed:
        _refuse("InvalidQuery")
    if len(trimmed) > 256:
        _refuse("QueryTooComplex")
    query = _normal(trimmed)
    parts: list[str] = []
    term_count = 0
    position = 0
    while position < len(query):
        if query[position].isspace():
            position += 1
            continue
        if query[position] == '"':
            end = query.find('"', position + 1)
            if end < 0:
                _refuse("InvalidQuery")
            part = query[position + 1:end]
            position = end + 1
        else:
            end = position
            while end < len(query) and not query[end].isspace() and query[end] != '"':
                end += 1
            part = query[position:end]
            position = end
        term_count += 1
        if term_count > 16:
            _refuse("QueryTooComplex")
        # unicode61 splits punctuation, including both kinds of apostrophe.
        # Only letters, marks and digits are passed to MATCH, always quoted.
        tokens: list[str] = []
        current = ""
        for char in part:
            if char.isalnum() or unicodedata.category(char).startswith("M"):
                current += char
            elif current:
                tokens.append(current)
                current = ""
        if current:
            tokens.append(current)
        if tokens:
            parts.append('"' + " ".join(tokens).replace('"', '""') + '"')
    if not parts:
        _refuse("InvalidQuery")
    return query, " OR ".join(parts)


def _identity(path: Path) -> tuple[int, int, int, int]:
    try:
        info = path.stat()
    except FileNotFoundError:
        _refuse("CandidateStoreAbsent")
    except OSError:
        _refuse("CandidateStoreUnreadable")
    if not path.is_file():
        _refuse("CandidateStoreUnreadable")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _proposal(payload: object) -> Proposal:
    if type(payload) is not dict:
        _refuse("CandidateStoreUnreadable")
    try:
        from datetime import datetime
        proposal = Proposal(
            proposal_id=payload["proposal_id"], source_id=payload["source_id"],
            content=UntrustedText(payload["content"]),
            proposed_at=datetime.fromisoformat(payload["proposed_at"]),
            holder=payload["holder"],
        )
        return proposal
    except (CandidateError, UntrustedContentError, KeyError, TypeError, ValueError):
        _refuse("CandidateStoreUnreadable")


def _index(path: Path, deadline: float) -> tuple[str, sqlite3.Connection, tuple[ReviewCandidate, ...],
                                                 dict[str, str | None], dict[str, str], frozenset[str]]:
    from nous_os.review import CandidateRefused, ReviewCandidate

    global _CACHE
    identity = _identity(path)
    if _CACHE is not None and _CACHE[0] == identity:
        return _CACHE[1:]
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.execute("CREATE VIRTUAL TABLE candidate USING fts5(statement, spans, scope, tags, tokenize='unicode61')")
    connection.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 1000)
    digest = hashlib.sha256()
    candidates: list[ReviewCandidate] = []
    versions: dict[str, str | None] = {}
    supersedes: dict[str, str] = {}
    unreadable: set[str] = set()
    try:
        with path.open("rb") as stream:
            for line in stream:
                if time.monotonic() > deadline:
                    _refuse("BuildTimeout")
                digest.update(line)
                if len(line) > MAX_RECORD_BYTES:
                    _refuse("CandidateStoreUnreadable")
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except (UnicodeError, json.JSONDecodeError):
                    _refuse("CandidateStoreUnreadable")
                if type(payload) is not dict or type(payload.get("proposal_id")) is not str:
                    _refuse("CandidateStoreUnreadable")
                try:
                    proposal_id = require_id(payload["proposal_id"], ASSERTION_PREFIX)
                except InvalidIdentifier:
                    _refuse("CandidateStoreUnreadable")
                if proposal_id in versions:
                    _refuse("CandidateStoreUnreadable")
                try:
                    proposal = _proposal(payload)
                    candidate = ReviewCandidate.from_proposal(proposal)
                except (CandidateSearchError, CandidateRefused):
                    # Keep a valid identity and recover any content version or
                    # replacement reference from a refused outer or review row.
                    # Only a proven old version may be skipped later.
                    unreadable.add(proposal_id)
                    version = None
                    try:
                        content = json.loads(payload["content"])
                        if type(content) is dict:
                            version = digest_bytes(canonical_bytes(content))
                            if type(content.get("supersedes")) is str:
                                supersedes[proposal_id] = content["supersedes"]
                    except (KeyError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
                        pass
                    versions[proposal_id] = version
                    continue
                except (CandidateError, UntrustedContentError, TypeError, ValueError):
                    _refuse("CandidateStoreUnreadable")
                versions[proposal_id] = candidate.version
                if candidate.supersedes is not None:
                    supersedes[proposal_id] = candidate.supersedes
                spans = " ".join(
                    citation.span for citation in (*candidate.citations, *candidate.derived_citations)
                )
                tags = " ".join(_tags(candidate.notes, "scope"))
                fields = tuple(map(_normal, (candidate.statement, spans, candidate.scope, tags)))
                if any(len(field.encode("utf-8")) > MAX_FIELD_BYTES for field in fields):
                    _refuse("CandidateStoreUnreadable")
                connection.execute("INSERT INTO candidate(rowid, statement, spans, scope, tags) VALUES (?, ?, ?, ?, ?)",
                                   (len(candidates) + 1, *fields))
                candidates.append(candidate)
        if _identity(path) != identity:
            _refuse("CandidateStoreUnreadable")
        connection.commit()
        connection.set_progress_handler(None, 0)
        generation = digest.hexdigest()
        if _CACHE is not None:
            _CACHE[2].close()
        _CACHE = identity, generation, connection, tuple(candidates), versions, supersedes, frozenset(unreadable)
        return _CACHE[1:]
    except sqlite3.DatabaseError:
        connection.close()
        if time.monotonic() > deadline:
            _refuse("BuildTimeout")
        _refuse("CandidateStoreUnreadable")
    except OSError:
        connection.close()
        _refuse("CandidateStoreUnreadable")
    except Exception:
        connection.close()
        raise


def _replacements(path: Path | None, versions: dict[str, str | None],
                  supersedes: dict[str, str], unreadable: frozenset[str],
                  deadline: float) -> tuple[dict[str, str], str]:
    if path is None:
        _refuse("ReplacementManifestUnavailable")
    links: dict[str, str] = {}
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for line in stream:
                if time.monotonic() > deadline:
                    _refuse("SearchTimeout")
                digest.update(line)
                if not line.strip():
                    continue
                row = json.loads(line)
                if type(row) is not dict or type(row.get("old")) is not str or type(row.get("new")) is not str:
                    _refuse("ReplacementManifestInconsistent")
                old, new = row["old"], row["new"]
                if old not in versions or new not in versions or old == new:
                    _refuse("ReplacementManifestInconsistent")
                if old in links and links[old] != new:
                    _refuse("ReplacementManifestInconsistent")
                links[old] = new
    except CandidateSearchError:
        raise
    except (OSError, UnicodeError):
        _refuse("ReplacementManifestUnavailable")
    except (json.JSONDecodeError, TypeError):
        _refuse("ReplacementManifestInconsistent")
    for new, reference in supersedes.items():
        if "@" not in reference:
            if new in unreadable:
                continue
            _refuse("ReplacementManifestInconsistent")
        old, version = reference.rsplit("@", 1)
        if versions.get(old) != version:
            if new in unreadable:
                continue
            _refuse("ReplacementManifestInconsistent")
        if old in links and links[old] != new:
            if new in unreadable:
                continue
            _refuse("ReplacementManifestInconsistent")
        links[old] = new
    return links, digest.hexdigest()


def _label(candidate: ReviewCandidate, canonical: bool) -> tuple[str, str]:
    if canonical:
        return "CANONICAL", "canon"
    epistemic = _tags(candidate.notes, "epistemic")
    if epistemic:
        if len(epistemic) == 1 and epistemic[0] in _LABELS:
            return epistemic[0], "epistemic_tag"
        return "NOT_YET_CLASSIFIED", "epistemic_tag"
    facets = _tags(candidate.notes, "facet")
    if len(facets) == 1:
        facet = facets[0]
        if facet in {"PROPOSAL", "ASSISTANT_SUGGESTION"}:
            return "PROPOSAL_NOT_APPROVED", "facet_map"
        if facet == "APPROVED_DECISION" and candidate.origin == "USER_AUTHORED":
            return "DECISION_STATED_BY_PERSON", "facet_map"
        if facet == "OPERATIONAL_FACT":
            return "IMPLEMENTATION_STATE_AT_DATE", "facet_map"
        if facet == "OPEN_QUESTION":
            return "HYPOTHESIS", "facet_map"
    if candidate.kind == "DECISION" and candidate.origin == "USER_AUTHORED":
        return "DECISION_STATED_BY_PERSON", "kind_origin"
    return "NOT_YET_CLASSIFIED", "none"


def _cursor(value: str | None, generation: str, request: str) -> int:
    if value is None:
        return 0
    if len(value) > 512:
        _refuse("InvalidCursor")
    if re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        _refuse("InvalidCursor")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        data = json.loads(raw)
        if type(data) is not dict or set(data) != {"g", "q", "o"} or type(data["o"]) is not int or data["o"] < 0:
            _refuse("InvalidCursor")
        if type(data["g"]) is not str or type(data["q"]) is not str:
            _refuse("InvalidCursor")
    except (ValueError, UnicodeError, TypeError, KeyError, binascii.Error):
        _refuse("InvalidCursor")
    if data["g"] != generation or data["q"] != request:
        _refuse("StaleCursor")
    return data["o"]


def _next_cursor(generation: str, request: str, offset: int) -> str:
    raw = canonical_bytes({"g": generation, "q": request, "o": offset})
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def search_candidates(*, store_path: Path, replacement_path: Path | None,
                      canon_root: Path | None, semantic_index_path: Path | None,
                      derived_path: Path | None, query: str, limit: int = 10,
                      cursor: str | None = None, include_replaced: bool = False,
                      ranking: str = "text") -> dict[str, object]:
    """Return one complete ranked page, or a stable refusal without partial hits."""
    started = time.monotonic()
    error_code = None
    try:
        if (type(limit) is not int or not 1 <= limit <= 20 or type(include_replaced) is not bool
                or type(ranking) is not str or ranking not in {"text", "text_relevance", "source_semantic"}):
            _refuse("InvalidQuery")
        if cursor is not None and type(cursor) is not str:
            _refuse("InvalidCursor")
        normalized, match = _query(query)
        with _LOCK:
            generation, connection, candidates, versions, supersedes, unreadable = _index(
                Path(store_path), started + BUILD_SECONDS)
            deadline = time.monotonic() + SEARCH_SECONDS
            replacements, replacement_digest = _replacements(
                replacement_path, versions, supersedes, unreadable, deadline)
            if not unreadable <= replacements.keys():
                _refuse("CandidateStoreUnreadable")
            replaced_unreadable = len(unreadable)
            canon: dict[tuple[str, str], str] = {}
            if canon_root is not None and Path(canon_root).is_dir():
                try:
                    for version in canon_index(Path(canon_root)):
                        canon[(version.candidate_id, version.candidate_version)] = version.assertion.id
                except Exception:
                    _refuse("CandidateStoreUnreadable")
            if time.monotonic() > deadline:
                _refuse("SearchTimeout")
            request_fields = {"query": normalized, "ranking": ranking,
                "include_replaced": include_replaced, "replacement": replacement_digest,
                "canon": sorted((key, value) for key, value in canon.items())}
            request = hashlib.sha256(canonical_bytes(request_fields)).hexdigest()
            offset = _cursor(cursor, generation, request)
            connection.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 1000)
            try:
                # FTS5 bm25 weights are positional: statement, cited spans, scope,
                # and bounded note scope tags respectively. Lower is better.
                text_scores = {rowid - 1: score for rowid, score in connection.execute(
                    "SELECT rowid, bm25(candidate, 1.0, 0.8, 0.5, 0.3) FROM candidate WHERE candidate MATCH ?",
                    (match,))}
            except sqlite3.OperationalError:
                if time.monotonic() >= deadline:
                    _refuse("SearchTimeout")
                _refuse("InvalidQuery")
            finally:
                connection.set_progress_handler(None, 0)
            if time.monotonic() > deadline:
                _refuse("SearchTimeout")
            source_ranks: dict[str, int] = {}
            if ranking == "source_semantic":
                semantic_started = time.monotonic()
                semantic_deadline = semantic_started + SEMANTIC_SECONDS
                if not _DENSE_LOCK.acquire(blocking=False):
                    _refuse("SearchTimeout")
                finished = threading.Event()
                outcome: dict[str, object] = {}

                def run_semantic() -> None:
                    try:
                        outcome["value"] = semantic_search(semantic_index_path, normalized, limit=100,
                                                           distinct=True, derived_path=derived_path)
                    except Exception as error:
                        outcome["error"] = error
                    finally:
                        _DENSE_LOCK.release()
                        finished.set()

                try:
                    threading.Thread(target=run_semantic, daemon=True).start()
                except Exception:
                    _DENSE_LOCK.release()
                    _refuse("SemanticUnavailable")
                if not finished.wait(max(0.0, semantic_deadline - time.monotonic())):
                    _refuse("SearchTimeout")
                if time.monotonic() > semantic_deadline:
                    _refuse("SearchTimeout")
                if "error" in outcome:
                    _refuse("SemanticUnavailable")
                semantic = outcome["value"]
                # The dense model may load cold. Its elapsed time does not spend
                # the remaining two-second text and response budget.
                deadline += time.monotonic() - semantic_started
                if semantic.get("status") != "complete":
                    _refuse("SemanticUnavailable")
                source_ranks = {hit["source_id"]: rank for rank, hit in enumerate(semantic["hits"], 1)}
                if time.monotonic() > deadline:
                    _refuse("SearchTimeout")
            text_ranked = []
            semantic_ranked = []
            replaced_excluded = 0
            for index, candidate in enumerate(candidates):
                candidate_id = candidate.proposal.proposal_id
                text_score = text_scores.get(index)
                semantic_rank = None
                if ranking == "source_semantic":
                    cited = ({citation.source_id for citation in candidate.citations}
                             | {citation.asset_source_id for citation in candidate.derived_citations})
                    ranks = [source_ranks[source] for source in cited if source in source_ranks]
                    if ranks:
                        semantic_rank = min(ranks)
                if ((ranking == "source_semantic" and semantic_rank is None)
                        or (ranking != "source_semantic" and text_score is None)):
                    continue
                if candidate_id in replacements and not include_replaced:
                    replaced_excluded += 1
                    continue
                if text_score is not None:
                    text_ranked.append((text_score, candidate_id, candidate.version, index))
                if semantic_rank is not None:
                    semantic_ranked.append((semantic_rank, text_score if text_score is not None else 0.0,
                                            candidate_id, candidate.version, index))
            text_ranked.sort()
            semantic_ranked.sort()
            if ranking == "source_semantic":
                order = [entry[-1] for entry in semantic_ranked]
            elif ranking == "text":
                order = [entry[-1] for entry in text_ranked]
                def standing(index: int) -> int:
                    candidate = candidates[index]
                    if (candidate.proposal.proposal_id, candidate.version) in canon:
                        return 0
                    return 1 if _label(candidate, False)[0] == "DECISION_STATED_BY_PERSON" else 2
                order[:100] = sorted(order[:100], key=lambda index: (
                    standing(index), text_scores[index], candidates[index].proposal.proposal_id,
                    candidates[index].version))
            else:
                order = [entry[-1] for entry in text_ranked]
            hits = []
            for position, index in enumerate(order[offset:offset + limit], offset + 1):
                candidate = candidates[index]
                score = text_scores.get(index, 0.0)
                candidate_id = candidate.proposal.proposal_id
                assertion_id = canon.get((candidate_id, candidate.version))
                canonical = assertion_id is not None
                label, basis = _label(candidate, canonical)
                hit = {
                    "candidate_id": candidate_id, "candidate_version": candidate.version,
                    "wording": ("Promoted canonical assertion: " if canonical else "Recorded candidate proposal: ") + candidate.statement,
                    "statement": candidate.statement, "kind": candidate.kind, "scope": candidate.scope,
                    "origin": candidate.origin, "proposed_at": candidate.proposal.proposed_at.isoformat(),
                    "valid_from": None if candidate.valid_from is None else candidate.valid_from.isoformat(),
                    "source_id": candidate.proposal.source_id,
                    "citations": [citation.as_payload() for citation in candidate.citations],
                    "derived_citations": [citation.as_payload() for citation in candidate.derived_citations],
                    "canonical_status": "canonical" if canonical else "non_canonical",
                    "assertion_id": assertion_id, "is_asserted": canonical,
                    "epistemic_label": label, "label_basis": basis,
                    "replaced": candidate_id in replacements, "superseded_by": replacements.get(candidate_id),
                    "rank": position, "score": score,
                }
                if ranking == "source_semantic":
                    hit["semantic_basis"] = "cited_source_rank"
                hits.append(hit)
            if time.monotonic() > deadline:
                _refuse("SearchTimeout")
            end = offset + len(hits)
            return {"status": "complete", "ranking": ranking,
                    "store_generation": generation,
                    "total_matched": len(order), "replaced_excluded": replaced_excluded,
                    "replaced_unreadable": replaced_unreadable, "hits": hits,
                    "next_cursor": _next_cursor(generation, request, end) if end < len(order) else None}
    except CandidateSearchError as error:
        error_code = str(error)
        raise
    finally:
        _LOGGER.info("candidate.search arguments=%s count=%s duration_s=%.3f error=%s",
                     ("query", "limit", "cursor", "include_replaced", "ranking"),
                     locals().get("end", 0), time.monotonic() - started, error_code)
