"""A lexical chunk-retrieval control for the retrieval measurement.

This index keeps lexical retrieval at the same chunk granularity as the dense
arm. Comparing chunk-level dense retrieval with document-level lexical
retrieval would turn a granularity difference into an apparent semantic gain,
which is precisely the defect this control is meant to expose.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import log
from typing import Final

from nous_os.aliases import AliasTable, _WORD, normalise
from nous_os.chunking import Chunk
from nous_os.identity import digest_payload


#: Fixed before the retrieval measurement. Changing either value changes the
#: lexical arm and turns a comparison with an earlier result into a new run.
K1: Final = 1.2
B: Final = 0.75


class LexicalError(Exception):
    """Raised when a lexical index or search request is not well specified."""


@dataclass(frozen=True, slots=True)
class LexicalHit:
    """One chunk result, with the rank made explicit for later measurement."""

    chunk_id: str
    source_id: str
    score: float
    rank: int


@dataclass(frozen=True, slots=True)
class _Document:
    """The part of a chunk that contributes to BM25's lexical calculation."""

    chunk_id: str
    source_id: str
    length: int
    frequencies: tuple[tuple[str, int], ...]


def _terms(text: str) -> tuple[str, ...]:
    """Normalised word terms, excluding one-character terms.

    Normalising before applying the shared pattern makes compatibility forms
    search as their ordinary counterparts. Keeping the pattern in aliases is
    important: two lexical paths that disagree on token boundaries cannot be
    compared as though they were one baseline.
    """
    normalised = normalise(text)
    return tuple(
        term
        for match in _WORD.finditer(normalised)
        if len(term := normalise(match.group(0))) > 1
    )


@dataclass(frozen=True, slots=True, init=False)
class ChunkBM25:
    """Okapi BM25 over chunks, with its measurement parameters fixed.

    The index stores only normalised term counts and a canonical document
    order. That avoids a result changing because a caller happened to assemble
    otherwise-identical chunks in a different order.
    """

    _average_length: float
    _documents: tuple[_Document, ...]
    _document_frequency: tuple[tuple[str, int], ...]
    _k1: float
    _b: float

    def __init__(self, chunks: tuple[Chunk, ...], *, k1: float = K1, b: float = B) -> None:
        """Build the lexical control from a non-empty, unique chunk collection.

        ``k1`` and ``b`` remain in the signature so a call records the intended
        preregistered values, but alternatives are refused. Accepting a nearby
        value would make it easy to relabel a tuned retriever as this control.
        """
        if type(chunks) is not tuple or not chunks:
            raise LexicalError("an index needs a non-empty tuple of chunks")
        if type(k1) is not float or k1 != K1 or type(b) is not float or b != B:
            raise LexicalError("k1 and b are fixed at 1.2 and 0.75 for this measurement")

        seen_ids: set[str] = set()
        documents: list[_Document] = []
        frequencies_by_document: list[dict[str, int]] = []
        for chunk in chunks:
            if type(chunk) is not Chunk:
                raise LexicalError("an index needs exact Chunk records")
            if chunk.id in seen_ids:
                raise LexicalError(f"two chunks share the identifier {chunk.id!r}")
            seen_ids.add(chunk.id)
            frequencies: dict[str, int] = {}
            for term in _terms(chunk.text):
                frequencies[term] = frequencies.get(term, 0) + 1
            frequencies_by_document.append(frequencies)
            documents.append(
                _Document(
                    chunk_id=chunk.id,
                    source_id=chunk.source_id,
                    length=sum(frequencies.values()),
                    frequencies=tuple(sorted(frequencies.items())),
                )
            )

        document_frequency: dict[str, int] = {}
        for frequencies in frequencies_by_document:
            for term in frequencies:
                document_frequency[term] = document_frequency.get(term, 0) + 1

        object.__setattr__(self, "_documents", tuple(documents))
        object.__setattr__(self, "_document_frequency", tuple(sorted(document_frequency.items())))
        object.__setattr__(
            self, "_average_length", sum(document.length for document in documents) / len(documents)
        )
        object.__setattr__(self, "_k1", k1)
        object.__setattr__(self, "_b", b)

    def search(
        self,
        query: str,
        limit: int,
        *,
        aliases: AliasTable | None = None,
        exclude_sources: frozenset[str] = frozenset(),
    ) -> tuple[LexicalHit, ...]:
        """Return at most ``limit`` matching chunks in deterministic rank order.

        Source exclusion happens while candidates are assembled, before the
        rank cut. Removing sources afterwards can return fewer than the caller
        requested even when eligible chunks exist, silently corrupting every
        top-k measurement built from the result.

        A query with no usable terms returns an empty tuple. That is a normal
        result distinct from an invalid request: after shared normalisation it
        says there was nothing lexical to ask the index.
        """
        if type(query) is not str:
            raise LexicalError("a query must be a str")
        if type(limit) is not int or isinstance(limit, bool) or limit < 1:
            raise LexicalError(f"limit must be a positive integer, not {limit!r}")
        if type(exclude_sources) is not frozenset or not all(
            type(source_id) is str for source_id in exclude_sources
        ):
            raise LexicalError("exclude_sources must be a frozenset of source identifiers")
        if aliases is not None and not isinstance(aliases, AliasTable):
            raise LexicalError("aliases must be an AliasTable")

        expanded_terms = set(_terms(query))
        if not expanded_terms:
            return ()
        if aliases is not None:
            for term in sorted(expanded_terms):
                for alternative in aliases.expand(term):
                    expanded_terms.update(_terms(alternative))
        query_terms = tuple(sorted(expanded_terms))

        frequencies = dict(self._document_frequency)
        count = len(self._documents)
        scores: list[tuple[str, str, float]] = []
        for document in self._documents:
            if document.source_id in exclude_sources:
                continue
            term_frequencies = dict(document.frequencies)
            score = 0.0
            for term in query_terms:
                frequency = term_frequencies.get(term, 0)
                if not frequency:
                    continue
                document_frequency = frequencies[term]
                inverse_document_frequency = log(
                    1 + (count - document_frequency + 0.5) / (document_frequency + 0.5)
                )
                denominator = frequency + self._k1 * (
                    1 - self._b + self._b * document.length / self._average_length
                )
                score += inverse_document_frequency * (
                    frequency * (self._k1 + 1) / denominator
                )
            if score:
                scores.append((document.chunk_id, document.source_id, score))

        scores.sort(key=lambda item: (-item[2], item[0]))
        return tuple(
            LexicalHit(chunk_id=chunk_id, source_id=source_id, score=score, rank=rank)
            for rank, (chunk_id, source_id, score) in enumerate(scores[:limit], start=1)
        )

    def state_digest(self) -> str:
        """Digest the canonical lexical structure, not a process-local layout.

        Hashing the normalised counts, document frequencies, and fixed
        parameters detects a changed index while remaining stable across
        processes with different hash seeds.
        """
        return digest_payload(
            {
                "k1": self._k1,
                "b": self._b,
                "average_length": self._average_length,
                "documents": [
                    {
                        "chunk_id": document.chunk_id,
                        "source_id": document.source_id,
                        "length": document.length,
                        "frequencies": list(document.frequencies),
                    }
                    for document in sorted(self._documents, key=lambda document: document.chunk_id)
                ],
                "document_frequency": list(self._document_frequency),
            }
        )
