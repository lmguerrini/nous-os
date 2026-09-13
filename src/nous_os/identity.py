"""Identity and content hashing.

Two ideas that are constantly confused, kept apart here on purpose.

**An identity is not a function of content.** A stable id is minted once and then
never changes: not when the text is corrected, not when the document is
reordered, not when the same source is ingested again. If an id were derived
from content, correcting a typo would silently produce a different thing, and
every citation of the old id would be wrong with nothing to report it.

**A content hash is exactly a function of content.** It changes when the bytes
change and at no other time. That is what makes it useful for detecting an edit
and useless for naming a thing.

So: ids answer *which* assertion, hashes answer *whether it changed*. Neither
substitutes for the other.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
from pathlib import Path
from typing import Any, Callable, Final

#: Identifier prefixes. Short, readable, and distinct so a misplaced id is
#: obvious at a glance rather than a silent type error.
SOURCE_PREFIX: Final = "src"
ASSERTION_PREFIX: Final = "asr"
RELATION_PREFIX: Final = "rel"

#: Crockford base32 without I, L, O and U — no character pair a person can
#: confuse when copying an id out of a file by hand.
_ALPHABET: Final = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ID_BODY_LENGTH: Final = 26

#: A minting function returns the body of a new id. Injectable so a test can be
#: deterministic without the production path having a deterministic default —
#: a predictable id in production is a collision waiting to happen.
Minter = Callable[[], str]


class InvalidIdentifier(Exception):
    """Raised when a string is not a well-formed identifier of the expected kind."""


def _random_body(length: int = _ID_BODY_LENGTH) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def new_source_id(minter: Minter | None = None) -> str:
    """Mint a source id. Content-independent by construction."""
    return f"{SOURCE_PREFIX}_{(minter or _random_body)()}"


def new_assertion_id(minter: Minter | None = None) -> str:
    """Mint an assertion id. Content-independent by construction."""
    return f"{ASSERTION_PREFIX}_{(minter or _random_body)()}"


def new_relation_id(minter: Minter | None = None) -> str:
    """Mint a relation id without deriving it from the relation's content."""
    return f"{RELATION_PREFIX}_{(minter or _random_body)()}"


def is_valid_id(value: str, prefix: str) -> bool:
    """Whether ``value`` is a well-formed identifier with ``prefix``."""
    marker = f"{prefix}_"
    if not isinstance(value, str) or not value.startswith(marker):
        return False
    body = value[len(marker) :]
    return bool(body) and all(character in _ALPHABET for character in body)


def require_id(value: str, prefix: str) -> str:
    """Return ``value`` if it is a well-formed identifier, else raise."""
    if not is_valid_id(value, prefix):
        raise InvalidIdentifier(f"not a well-formed {prefix!r} identifier: {value!r}")
    return value


def digest_bytes(data: bytes) -> str:
    """The sha256 of exactly these bytes, as lowercase hex."""
    return hashlib.sha256(data).hexdigest()


def canonical_bytes(payload: Any) -> bytes:
    """Serialise ``payload`` to the one byte sequence that represents it.

    Deterministic: keys sorted, no insignificant whitespace, UTF-8, and no
    escaping of non-ASCII, so the same content always produces the same bytes
    on any machine and in any process. Without a single canonical form,
    "the hash changed" and "the content changed" stop meaning the same thing.
    """
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def digest_payload(payload: Any) -> str:
    """The sha256 of ``payload``'s canonical serialisation."""
    return digest_bytes(canonical_bytes(payload))


def file_is_present(path: Path) -> bool:
    """Whether ``path`` names an existing regular file -- or raise.

    Lives here, in the package's dependency root, rather than beside any one
    reader: every append-only store below already imports this module for its
    identifiers, so adding the one check they all need here creates no new
    edge in the dependency graph.

    ``Path.is_file()`` reports *every* ``OSError`` as a plain ``False`` --
    a permission failure on a containing directory exactly like a file that
    was never written. That conflates "this history is empty" with "this
    history cannot currently be read", and a caller cannot tell them apart
    afterwards. ``FileNotFoundError`` and ``NotADirectoryError`` are the only
    two outcomes treated as genuine absence, because a path below a missing
    ancestor or a non-directory ancestor names nothing; any other failure to
    stat the path -- most often a permission failure -- propagates instead.
    """
    try:
        return stat.S_ISREG(os.stat(path).st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return False


def directory_is_present(path: Path) -> bool:
    """The directory counterpart of :func:`file_is_present`; see its docstring.

    ``os.stat`` succeeding here says only that ``path`` exists and is a
    directory, not that its contents can be listed: a directory can admit
    ``stat`` while refusing ``readdir``. A caller that goes on to list it
    still sees that failure, unwrapped, on its own listing call.
    """
    try:
        return stat.S_ISDIR(os.stat(path).st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return False
