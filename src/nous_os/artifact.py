"""The portable proposal artifact: a JSON document that carries proposals between machines.

A person working with a client that cannot itself reach this package's stdio
transport still needs a way to hand it proposed material. The artifact is that
path: a plain JSON file, with a declared schema identifier and version, that
the command-line transport reads and turns into one or more calls to the
``candidate.propose`` operation this package already publishes. **It is a way
of sourcing arguments for an operation that already exists, not a new one** —
see :mod:`nous_os.cli`, which is the only module allowed to read it.

Three properties hold the whole design, and each is enforced here rather than
left as a convention a reader has to trust:

**It cannot carry authority.** No grant, tier, or capability field exists in
this schema. If a document names one anyway, it is refused outright, not
silently dropped: a dropped field would let a future reader believe the
schema was checked when it was merely ignored. Authority for what this
artifact's proposals may do comes from the local invocation that imports it —
the grant the command-line transport was started with — never from bytes that
travelled here from somewhere else.

**Its content arrives untrusted.** Every proposal payload's ``content`` is
wrapped as :class:`~nous_os.untrusted.UntrustedText` the moment it is parsed,
before this module hands anything back to its one caller. It is unwrapped
with ``as_data()`` only at the single point that must produce the plain JSON
string :func:`nous_os.core.invoke` requires, exactly as :mod:`nous_os.core`'s
own binder for ``candidate.propose`` does for content read any other way.

**Provider and session identity are provenance, never authority.** Both are
carried as plain strings, read back by the caller for its own audit record,
and never examined by anything in this module that makes an authorization
decision -- because nothing in this module makes one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from nous_os.untrusted import UntrustedText

__all__ = (
    "ArtifactError",
    "UnknownArtifactSchema",
    "UnsupportedArtifactVersion",
    "MalformedArtifact",
    "ArtifactPayloadNotText",
    "ArtifactCarriesAuthority",
    "SCHEMA_ID",
    "SCHEMA_VERSION",
    "ProposalPayload",
    "Artifact",
    "parse_artifact",
    "load_artifact",
)


class ArtifactError(Exception):
    """Base error for a proposal artifact this module refuses to import."""


class UnknownArtifactSchema(ArtifactError):
    """Raised when a document names no schema this module recognizes."""


class UnsupportedArtifactVersion(ArtifactError):
    """Raised when a document names a known schema at a version this module does not support."""


class MalformedArtifact(ArtifactError):
    """Raised when a document does not match the shape its declared schema requires."""


class ArtifactPayloadNotText(ArtifactError):
    """Raised when a proposal payload's content is present but is not a JSON string."""


class ArtifactCarriesAuthority(ArtifactError):
    """Raised when a document names a field this schema declares forbidden.

    A grant, tier, or capability field inside a portable file would let the
    file assert its own authority, exactly the thing :mod:`nous_os.capability`
    reserves for the code that constructs a grant. This is refused rather than
    stripped, so a reader of this module's tests can see the refusal happen
    instead of trusting that a silently dropped field was harmless.
    """


#: The one schema this module understands, and the one version of it.
#: A future incompatible shape gets a new identifier or a new version, never a
#: silent reinterpretation of an old one.
SCHEMA_ID: Final = "nous-os.candidate-proposal-artifact"
SCHEMA_VERSION: Final = 1

#: Field names this schema declares forbidden, anywhere in the document, at
#: any depth. Naming one of these is not a formatting mistake to smooth over;
#: it is a document trying to say something this schema has no field for, and
#: the refusal is deliberate rather than an oversight to fill in later.
_FORBIDDEN_FIELD_NAMES: Final = frozenset(
    {"grant", "tier", "tiers", "capability", "capabilities", "holder_privilege", "privilege"}
)

#: Every top-level field this schema declares. An artifact naming any other
#: top-level field is refused, matching the same strictness
#: :func:`nous_os.core._bind_json_arguments` already applies to operation
#: arguments.
_TOP_LEVEL_FIELDS: Final = frozenset({"schema", "version", "provider", "session", "proposals"})

#: Every field one proposal payload declares -- exactly the parameters
#: ``candidate.propose`` requires, so importing one payload is exactly one
#: call to that operation with nothing added and nothing missing.
_PROPOSAL_FIELDS: Final = frozenset({"source_id", "content", "proposed_at", "holder"})


@dataclass(frozen=True, slots=True)
class ProposalPayload:
    """One proposal read from an artifact, ready to become one ``candidate.propose`` call.

    ``content`` is :class:`~nous_os.untrusted.UntrustedText`, not ``str``: it
    became untrusted the moment this module parsed it, and stays that way
    until the one call site that must unwrap it to satisfy
    :func:`nous_os.core.invoke`'s JSON argument contract.
    """

    source_id: str
    content: UntrustedText
    proposed_at: str
    holder: str


@dataclass(frozen=True, slots=True)
class Artifact:
    """One parsed, schema-checked portable proposal artifact.

    ``provider`` and ``session`` are provenance metadata only -- carried
    through unexamined, for whatever records this module's caller wants to
    keep. Nothing in this module reads either one to make a decision, because
    this module makes none.
    """

    schema: str
    version: int
    provider: str | None
    session: str | None
    proposals: tuple[ProposalPayload, ...]


def _scan_for_forbidden_fields(value: object) -> str | None:
    """Find the first forbidden field name anywhere under ``value``, or ``None``.

    Recurses through every object and array in the document, not just the top
    level, so a forbidden field nested inside a proposal payload is caught
    exactly as one sitting beside ``schema`` is. String *values* are never
    inspected here -- only dictionary *keys* -- so a proposal whose content
    happens to contain the word "grant" is not itself a false refusal.
    """
    if type(value) is dict:
        for key, nested in value.items():
            if type(key) is str and key in _FORBIDDEN_FIELD_NAMES:
                return key
            found = _scan_for_forbidden_fields(nested)
            if found is not None:
                return found
        return None
    if type(value) is list:
        for item in value:
            found = _scan_for_forbidden_fields(item)
            if found is not None:
                return found
        return None
    return None


def _optional_string(value: object, field: str) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise MalformedArtifact(f"{field} must be a string or absent")
    return value


def _proposal_from_payload(payload: object) -> ProposalPayload:
    if type(payload) is not dict:
        raise MalformedArtifact("each proposal payload must be a JSON object")
    missing = sorted(_PROPOSAL_FIELDS - set(payload))
    if missing:
        raise MalformedArtifact(f"a proposal payload is missing field(s): {missing}")
    unknown = sorted(set(payload) - _PROPOSAL_FIELDS)
    if unknown:
        raise MalformedArtifact(f"a proposal payload names unknown field(s): {unknown}")
    for field in ("source_id", "proposed_at", "holder"):
        if type(payload[field]) is not str:
            raise MalformedArtifact(f"a proposal payload's {field} must be a string")
    content = payload["content"]
    if type(content) is not str:
        raise ArtifactPayloadNotText("a proposal payload's content must be text")
    return ProposalPayload(
        source_id=payload["source_id"],
        content=UntrustedText(content),
        proposed_at=payload["proposed_at"],
        holder=payload["holder"],
    )


def parse_artifact(document: object) -> Artifact:
    """Parse one portable proposal artifact from already-decoded JSON, or refuse it.

    Checks run in this order: a forbidden field anywhere refuses the whole
    document before its schema is even consulted, because a document trying
    to carry authority is refused on that shape alone, regardless of what else
    it claims to be. Then the schema identifier, then the version, then the
    remaining top-level shape, then every payload.
    """
    if type(document) is not dict:
        raise MalformedArtifact("a proposal artifact must be a JSON object")

    forbidden = _scan_for_forbidden_fields(document)
    if forbidden is not None:
        raise ArtifactCarriesAuthority(
            f"a proposal artifact named {forbidden!r}, which this schema declares "
            "forbidden; authority comes from the local invocation, never from a "
            "portable document"
        )

    schema = document.get("schema")
    if schema != SCHEMA_ID:
        raise UnknownArtifactSchema(f"no known schema is named {schema!r}")

    version = document.get("version")
    # Exact type, not bare equality: Python's ``bool`` is a subclass of
    # ``int``, so ``True == 1`` and, once JSON has parsed a number, ``1.0 ==
    # 1`` -- either would let a document that never named the real version
    # parse as though it had. This matches the exact-type strictness
    # ``_matches_json_type`` already applies to every declared parameter.
    if type(version) is not int or isinstance(version, bool) or version != SCHEMA_VERSION:
        raise UnsupportedArtifactVersion(
            f"schema {SCHEMA_ID!r} does not support version {version!r}; "
            f"this module supports version {SCHEMA_VERSION}"
        )

    unknown_top_level = sorted(set(document) - _TOP_LEVEL_FIELDS)
    if unknown_top_level:
        raise MalformedArtifact(f"a proposal artifact names unknown field(s): {unknown_top_level}")

    proposals_payload = document.get("proposals")
    if type(proposals_payload) is not list or not proposals_payload:
        raise MalformedArtifact("a proposal artifact must carry one or more proposal payloads")

    return Artifact(
        schema=schema,
        version=version,
        provider=_optional_string(document.get("provider"), "provider"),
        session=_optional_string(document.get("session"), "session"),
        proposals=tuple(_proposal_from_payload(item) for item in proposals_payload),
    )


def load_artifact(path: Path) -> Artifact:
    """Read one portable proposal artifact from a local file, or refuse it.

    The single permitted local file input this capability offers, and it is
    read only by :mod:`nous_os.cli`. A read failure and a JSON syntax failure
    are both refused as :class:`MalformedArtifact`, matching the schema-shape
    refusals below rather than surfacing as an unrelated exception type.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise MalformedArtifact(f"could not read the artifact file at {path}: {error}") from error
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MalformedArtifact(
            f"the artifact file at {path} is not valid JSON: {error}"
        ) from error
    return parse_artifact(document)
