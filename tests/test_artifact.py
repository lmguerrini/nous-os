"""Executable properties of the portable proposal artifact.

The dangerous failure here is not a rejected malformed file; it is one that
carries a field this schema has no place for and gets silently read anyway,
or content that reaches a call site as plain ``str`` instead of
:class:`~nous_os.untrusted.UntrustedText`. These tests exercise the refusal
paths directly, and check the type of what a successful parse actually
returns rather than only its value.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import nous_os.artifact as artifact
from nous_os.untrusted import UntrustedText

SOURCE_ID = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"


def _valid_document(**overrides: object) -> dict[str, object]:
    document: dict[str, object] = {
        "schema": artifact.SCHEMA_ID,
        "version": artifact.SCHEMA_VERSION,
        "provider": "a local client",
        "session": "sess-1",
        "proposals": [
            {
                "source_id": SOURCE_ID,
                "content": "a real proposal",
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "fixture holder",
            }
        ],
    }
    document.update(overrides)
    return document


# --- a well-formed document parses, and content is quarantined -------------


def test_a_well_formed_document_parses() -> None:
    parsed = artifact.parse_artifact(_valid_document())
    assert parsed.schema == artifact.SCHEMA_ID
    assert parsed.version == artifact.SCHEMA_VERSION
    assert parsed.provider == "a local client"
    assert parsed.session == "sess-1"
    assert len(parsed.proposals) == 1


def test_provider_and_session_are_optional() -> None:
    document = _valid_document()
    del document["provider"]
    del document["session"]
    parsed = artifact.parse_artifact(document)
    assert parsed.provider is None
    assert parsed.session is None


def test_proposal_content_is_untrusted_text_not_a_bare_string() -> None:
    parsed = artifact.parse_artifact(_valid_document())
    content = parsed.proposals[0].content
    assert type(content) is UntrustedText
    assert type(content) is not str
    assert content.as_data() == "a real proposal"


def test_multiple_proposals_are_all_parsed_in_order() -> None:
    document = _valid_document(
        proposals=[
            {
                "source_id": SOURCE_ID,
                "content": f"proposal {i}",
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "h",
            }
            for i in range(3)
        ]
    )
    parsed = artifact.parse_artifact(document)
    assert [p.content.as_data() for p in parsed.proposals] == [
        "proposal 0", "proposal 1", "proposal 2",
    ]


# --- the artifact cannot carry authority: refused, not ignored -------------


@pytest.mark.parametrize(
    "field", ["grant", "tier", "tiers", "capability", "capabilities", "holder_privilege", "privilege"]
)
def test_a_forbidden_field_at_the_top_level_is_refused(field: str) -> None:
    document = _valid_document(**{field: "anything"})
    with pytest.raises(artifact.ArtifactCarriesAuthority):
        artifact.parse_artifact(document)


def test_a_forbidden_field_nested_inside_a_proposal_is_refused() -> None:
    document = _valid_document(
        proposals=[
            {
                "source_id": SOURCE_ID,
                "content": "x",
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "h",
                "grant": "promote",
            }
        ]
    )
    with pytest.raises(artifact.ArtifactCarriesAuthority):
        artifact.parse_artifact(document)


def test_a_forbidden_field_is_refused_even_when_the_document_is_otherwise_unrecognizable() -> None:
    """The authority refusal fires before the schema is even consulted."""
    with pytest.raises(artifact.ArtifactCarriesAuthority):
        artifact.parse_artifact({"schema": "not-a-real-schema", "grant": "promote"})


def test_the_word_grant_inside_ordinary_content_is_not_mistaken_for_the_field() -> None:
    """Only a dictionary *key* is inspected; a proposal's own text is never scanned."""
    document = _valid_document(
        proposals=[
            {
                "source_id": SOURCE_ID,
                "content": "please grant me nothing, this is just a sentence",
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "h",
            }
        ]
    )
    parsed = artifact.parse_artifact(document)
    assert "grant" in parsed.proposals[0].content.as_data()


# --- refuse an unknown schema, an unsupported version, and a malformed shape


def test_an_unknown_schema_identifier_is_refused() -> None:
    with pytest.raises(artifact.UnknownArtifactSchema):
        artifact.parse_artifact(_valid_document(schema="not-a-known-schema"))


def test_an_unsupported_version_is_refused() -> None:
    with pytest.raises(artifact.UnsupportedArtifactVersion):
        artifact.parse_artifact(_valid_document(version=999))


def test_a_boolean_version_is_refused_even_though_it_equals_one() -> None:
    """``True == 1`` in Python; a document naming no real version must still be refused."""
    with pytest.raises(artifact.UnsupportedArtifactVersion):
        artifact.parse_artifact(_valid_document(version=True))


def test_a_float_version_is_refused_even_though_it_equals_one() -> None:
    """``1.0 == 1`` in Python; a document naming no real version must still be refused."""
    with pytest.raises(artifact.UnsupportedArtifactVersion):
        artifact.parse_artifact(_valid_document(version=1.0))


def test_a_non_object_document_is_refused() -> None:
    with pytest.raises(artifact.MalformedArtifact):
        artifact.parse_artifact(["not", "an", "object"])


def test_an_unknown_top_level_field_is_refused() -> None:
    with pytest.raises(artifact.MalformedArtifact):
        artifact.parse_artifact(_valid_document(unexpected_field="anything"))


def test_zero_proposals_is_refused() -> None:
    with pytest.raises(artifact.MalformedArtifact):
        artifact.parse_artifact(_valid_document(proposals=[]))


def test_a_proposal_missing_a_required_field_is_refused() -> None:
    document = _valid_document(proposals=[{"source_id": SOURCE_ID, "content": "x"}])
    with pytest.raises(artifact.MalformedArtifact):
        artifact.parse_artifact(document)


def test_a_proposal_with_an_unknown_field_is_refused() -> None:
    document = _valid_document(
        proposals=[
            {
                "source_id": SOURCE_ID,
                "content": "x",
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "h",
                "extra": "unexpected",
            }
        ]
    )
    with pytest.raises(artifact.MalformedArtifact):
        artifact.parse_artifact(document)


def test_a_payload_that_is_not_text_is_refused_with_its_own_error_type() -> None:
    document = _valid_document(
        proposals=[
            {
                "source_id": SOURCE_ID,
                "content": 12345,
                "proposed_at": "2026-01-02T12:00:00+00:00",
                "holder": "h",
            }
        ]
    )
    with pytest.raises(artifact.ArtifactPayloadNotText):
        artifact.parse_artifact(document)


# --- loading from a real file -----------------------------------------------


def test_load_artifact_reads_and_parses_a_real_file(tmp_path: Path) -> None:
    path = tmp_path / "artifact.json"
    path.write_text(json.dumps(_valid_document()), encoding="utf-8")
    parsed = artifact.load_artifact(path)
    assert parsed.proposals[0].content.as_data() == "a real proposal"


def test_load_artifact_refuses_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(artifact.MalformedArtifact):
        artifact.load_artifact(tmp_path / "does-not-exist.json")


def test_load_artifact_refuses_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "artifact.json"
    path.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(artifact.MalformedArtifact):
        artifact.load_artifact(path)
