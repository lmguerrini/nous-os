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
import secrets
from typing import Any, Callable, Final

#: Identifier prefixes. Short, readable, and distinct so a misplaced id is
#: obvious at a glance rather than a silent type error.
SOURCE_PREFIX: Final = "src"
ASSERTION_PREFIX: Final = "asr"

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
