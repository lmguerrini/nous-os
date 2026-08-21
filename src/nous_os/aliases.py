"""The alias layer, deliberately without a default.

A measured fact and an unmeasured proposal sit either side of this module. The
hand-authored glossary is **measured insufficient** on a private corpus that is not
published here, and the corpus-derived replacement that was proposed instead is
**unmeasured**. Promoting an unmeasured design over a measured-bad one is still
an unproven claim, so this ships a layer with two interchangeable derivations
and **selects neither**. Whichever one wins the benchmark becomes the default,
and that decision is not this module's to make.

The consequence for the code is that there is no module-level default, no
"recommended" flag, and no implicit fallback. A caller names a derivation. Code
that forgot to choose does not quietly get the author's favourite.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


class AliasError(Exception):
    """Raised when an alias derivation is asked for something it cannot give."""


def normalise(term: str) -> str:
    """The one form a term is compared in.

    Case-folded and compatibility-normalised, so that a term differing only in
    case or in a lookalike codepoint is the same term. Applied to lookups, never
    to stored content — rewriting what a source said is what provenance forbids.
    """
    if type(term) is not str:
        raise AliasError(f"a term must be a str, not {type(term).__name__}")
    return unicodedata.normalize("NFKC", term).casefold()


@runtime_checkable
class AliasTable(Protocol):
    """Anything that can offer alternative surface forms for a term."""

    @property
    def name(self) -> str:
        """A stable identifier, so a result can say which derivation produced it."""

    def expand(self, term: str) -> tuple[str, ...]:
        """Alternative forms for ``term``, sorted, never including ``term``."""


@dataclass(frozen=True, slots=True)
class NoAliases:
    """The null derivation. The honest baseline any other must beat."""

    @property
    def name(self) -> str:
        return "none"

    def expand(self, term: str) -> tuple[str, ...]:
        normalise(term)
        return ()


class HandGlossary:
    """A fixed, hand-authored table of term pairs.

    Kept because it is the **measured** option, and a benchmark needs something
    with a known result to sit against. Its known result is that it is not
    enough.
    """

    __slots__ = ("_pairs",)

    def __init__(self, pairs: dict[str, str]) -> None:
        if type(pairs) is not dict:
            raise AliasError("a glossary is built from a mapping of term to term")
        table: dict[str, set[str]] = {}
        for left, right in pairs.items():
            a, b = normalise(left), normalise(right)
            if not a or not b or a == b:
                raise AliasError(f"a glossary pair must be two different terms: {left!r}/{right!r}")
            table.setdefault(a, set()).add(b)
            table.setdefault(b, set()).add(a)
        self._pairs = {key: tuple(sorted(value)) for key, value in table.items()}

    @property
    def name(self) -> str:
        return "hand-glossary"

    def expand(self, term: str) -> tuple[str, ...]:
        return self._pairs.get(normalise(term), ())

    def __len__(self) -> int:
        return len(self._pairs)


class CorpusDerivedAliases:
    """Aliases derived from aligned document pairs rather than authored by hand.

    Built by aligning documents a caller declares to be translations of one
    another and pairing terms that occupy the same ordinal position among the
    terms unique to each side. That is a deliberately crude rule, and saying so
    matters: this derivation exists to be **measured against** the hand glossary,
    not to be assumed better than it. A cleverer derivation that has not been
    benchmarked would be exactly the unproven promotion this layer exists to
    prevent.
    """

    __slots__ = ("_pairs",)

    def __init__(self, pairs: dict[str, tuple[str, ...]]) -> None:
        self._pairs = pairs

    @classmethod
    def from_aligned_pairs(
        cls, aligned: tuple[tuple[str, str], ...]
    ) -> "CorpusDerivedAliases":
        table: dict[str, set[str]] = {}
        for left_text, right_text in aligned:
            left_terms = _ordered_unique_terms(left_text)
            right_terms = _ordered_unique_terms(right_text)
            shared = set(left_terms) & set(right_terms)
            left_only = [t for t in left_terms if t not in shared]
            right_only = [t for t in right_terms if t not in shared]
            for a, b in zip(left_only, right_only):
                if a == b:
                    continue
                table.setdefault(a, set()).add(b)
                table.setdefault(b, set()).add(a)
        return cls({key: tuple(sorted(value)) for key, value in table.items()})

    @property
    def name(self) -> str:
        return "corpus-derived"

    def expand(self, term: str) -> tuple[str, ...]:
        return self._pairs.get(normalise(term), ())

    def __len__(self) -> int:
        return len(self._pairs)


def _ordered_unique_terms(text: str) -> tuple[str, ...]:
    """Terms in first-appearance order, deduplicated.

    Order comes from the text. A set would make the derivation depend on hash
    iteration, which is a fact about the process and not about the corpus.
    """
    seen: dict[str, None] = {}
    for match in _WORD.finditer(text):
        seen.setdefault(normalise(match.group(0)), None)
    return tuple(seen)


def expand_query(table: AliasTable, query: str) -> tuple[str, ...]:
    """Every surface form worth searching for, including the original terms.

    Sorted and deduplicated, so two runs of the same query search the same
    thing in the same order.
    """
    if not isinstance(table, AliasTable):
        raise AliasError("expand_query needs an alias derivation")
    terms = _ordered_unique_terms(query)
    if not terms:
        raise AliasError("a query must contain at least one term")
    found = set(terms)
    for term in terms:
        found.update(table.expand(term))
    return tuple(sorted(found))
