"""Golden discovery cases transcribed from the public synthetic fixture text."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import get_type_hints

import pytest

from nous_os.adjudication import (
    AgentMemory,
    AdjudicationError,
    HumanDecision,
    RejectionMemory,
    Verdict,
    promote,
)
from nous_os.attribution import AttributedKey, KeyOrigin, is_promotable
from nous_os.candidates import Proposal
from nous_os.discovery import (
    BridgeCard,
    BridgeRegistry,
    Depth,
    Endpoint,
    EpistemicClass,
    Gate,
    GateOutcome,
    GateVector,
    RoundStatus,
    TrivialityArchetype,
    rotation_order,
    run_round,
)
from nous_os.provenance import Citation, Locator
from nous_os.temporal import ClaimKey
from nous_os.untrusted import UntrustedText


REPO_ROOT = Path(__file__).resolve().parent.parent
DISCOVERY_GOLDEN = REPO_ROOT / "fixtures" / "synthetic" / "DISCOVERY.md"
WHEN = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)

# Literal transcriptions of every published table row in DISCOVERY.md.
G_PROMOTE_ROWS = (
    ("no path promotes a candidate to canon without an explicit human decision value", "A proposal records an arrival, while the rubric reserves promotion for an explicit human decision."),
    ("a decision whose verdict is not `promote` does not promote", "`reject` and `defer` are recorded decision outcomes, not latent permission."),
    ("a key whose origin is content-derived or unestablished does not promote", "The origin vocabulary makes content and unknown origins useful for proposals but ineligible at the promotion boundary."),
    ("a refused promotion leaves the authorization record byte-identical", "A refusal is not an authorization, so it cannot append a changed authorization record."),
    ("session notes never yield a value the promotion path accepts", "Session memory holds only ordinary note strings; it is physically separate from a human decision."),
)

G_NEG_ROWS = (
    ("office-records-common-tool", "moderate", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "`harbour-office.md` and `notes/tides.md` both mention ordinary records; that is commodity tooling, not a mechanism bridge."),
    ("rotating-watch-routine", "moderate", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "`notes/lighthouse.md` and `en-lighthouse.md` both describe a rotating watch; the common routine is generic process overlap."),
    ("parallel-lighthouse-accounts", "obvious", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "The two lighthouse accounts are related by the fixture's paired subject, so the relation is same ecosystem by definition rather than a bridge."),
    ("named-harbour-office", "obvious", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "`notes/lighthouse.md` names the harbour office that `harbour-office.md` titles; reporting that relation restates an explicit cross-reference."),
    ("tide-word-noise", "moderate", "G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=FAIL", "FAIL", "The tide vocabulary is shared, but the stated noise objection — coincidence in shared vocabulary — wins its own gate."),
    ("office-link-already-stated", "moderate", "G1=PASS; G2=PASS; G3=FAIL; G4=PASS; G5=PASS; G6=PASS", "FAIL", "`harbour-office.md` already says that two documents refer to the office; a supplied co-mention outside the endpoints makes the link already stated elsewhere."),
    ("lexical-lighthouse-words", "obvious", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "The lighthouse pair reads as a shared-vocabulary pairing rather than a mechanism bridge."),
    ("lexical-tide-words", "obvious", "G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS", "FAIL", "The tide pair reads as a shared-vocabulary pairing rather than a mechanism bridge."),
    ("glossary-to-maree", "deep", "G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS", "PASS", "`glossary.md` defines *marea sigiziale* as the Italian name for spring tide, while `it-maree.md` uses *sizigie*; the language bridge explains the otherwise separated terms."),
    ("keepers-to-tide-records", "deep", "G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS", "PASS", "The keepers' logbooks are the source of the bay's earliest tide records, connecting the watch history to the tide account."),
    ("automation-to-faro", "deep", "G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS", "PASS", "The office records begin when the lighthouse is automated, connecting the record history to the lighthouse's harbour role."),
)

G_ITER_ROWS = (
    ("a cluster rejected in an earlier round is not re-adjudicated later", "Rejection memory is durable so a known failed cluster is skipped rather than proposed again."),
    ("a memory populated before the first round is honoured in the first round", "Consultation is not deferred until a later round; existing rejection memory already has its exclusion effect."),
    ("accepted results accumulate and never shrink across rounds", "The bridge registry is append-only, and accepted cards are its accepted projection."),
    ("round k+1 surfaces at least one cluster absent from round k", "A later round can introduce a new candidate rather than repeating the earlier candidate set."),
    ("`origin_round` is preserved as written", "A card carries the round where it originated; recording does not rewrite that field."),
    ("rotation puts unmined clusters before mined ones, preserving relative order within each group", "Rotation is a stable partition over durable mined history, not a re-ranking of either group."),
)


def _parse_tables(text: str) -> dict[str, list[tuple[str, ...]]]:
    tables = {"G-PROMOTE": [], "G-NEG": [], "G-ITER": []}
    section: str | None = None
    table: str | None = None
    headers = {
        "G-PROMOTE": "| What must hold | Why |",
        "G-NEG": "| Cluster | Depth | Gate vector | Verdict | Why, from the rubric |",
        "G-ITER": "| What must hold | Why |",
    }
    for line in text.splitlines():
        if line.startswith("## G-PROMOTE"):
            section = "G-PROMOTE"
            table = None
        elif line.startswith("## G-NEG"):
            section = "G-NEG"
            table = None
        elif line.startswith("## G-ITER"):
            section = "G-ITER"
            table = None
        elif line.startswith("## "):
            section = None
            table = None
        elif section and line == headers[section]:
            table = section
        elif table and line.startswith("|") and not line.startswith("|---"):
            tables[table].append(tuple(cell.strip() for cell in line.strip("|").split("|")))
    return tables


def _published_tables() -> dict[str, list[tuple[str, ...]]]:
    return _parse_tables(DISCOVERY_GOLDEN.read_text(encoding="utf-8"))


def _gate_vector(label: str, archetype: TrivialityArchetype | None = None) -> GateVector:
    outcomes = {}
    reasons = {}
    for token in label.split("; "):
        gate_name, outcome_name = token.split("=")
        gate = Gate[gate_name]
        outcome = GateOutcome[outcome_name]
        outcomes[gate] = outcome
        if outcome is GateOutcome.FAIL:
            reasons[gate] = f"{gate.value} fails for this documented control"
    return GateVector(outcomes=outcomes, reasons=reasons, triviality=archetype)


_ARCHETYPES = {
    "office-records-common-tool": TrivialityArchetype.COMMODITY_TOOLING,
    "rotating-watch-routine": TrivialityArchetype.GENERIC_PROCESS_OVERLAP,
    "parallel-lighthouse-accounts": TrivialityArchetype.SAME_ECOSYSTEM_BY_DEFINITION,
    "named-harbour-office": TrivialityArchetype.RESTATED_CROSS_REFERENCE,
    "lexical-lighthouse-words": TrivialityArchetype.GENERIC_PROCESS_OVERLAP,
    "lexical-tide-words": TrivialityArchetype.GENERIC_PROCESS_OVERLAP,
}


_ID_SUFFIXES = "ABCDEFGHJKM"


def _endpoint(project: str, quote: str) -> Endpoint:
    source_id = "src_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    return Endpoint(project, Citation(source_id, "a" * 64, Locator(0, len(quote)), quote), quote)


def _card(row: tuple[str, str, str, str, str], number: int, *, origin_round: int = 1) -> BridgeCard:
    cluster, depth, vector, _, _ = row
    return BridgeCard(
        card_id=f"asr_01ARZ3NDEKTSV4RRFFQ69G5F{_ID_SUFFIXES[number]}",
        cluster_id=cluster,
        left=_endpoint("corpus", "harbour office"),
        right=_endpoint("bilingual", "lighthouse"),
        epistemic_class=EpistemicClass.DERIVED,
        depth=Depth(depth),
        non_triviality="The documented mechanism is stated in the fixture reading.",
        consequence="The bridge changes which fixture relationship needs review.",
        noise_objection="Shared vocabulary alone may be coincidental.",
        gates=_gate_vector(vector, _ARCHETYPES.get(cluster)),
        origin_round=origin_round,
    )


def _candidate() -> Proposal:
    return Proposal(
        proposal_id="asr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        source_id="src_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        content=UntrustedText("fixture proposal"),
        proposed_at=WHEN,
        holder="fixture holder",
    )


def _subject(origin: KeyOrigin) -> AttributedKey:
    citation = Citation("src_01ARZ3NDEKTSV4RRFFQ69G5FAV", "b" * 64, Locator(0, 4), "tide")
    return AttributedKey(ClaimKey("fixture-subject"), origin, citation if origin is KeyOrigin.CONTENT else None)


def _decision(verdict: Verdict = Verdict.PROMOTE, origin: KeyOrigin = KeyOrigin.OPERATOR) -> HumanDecision:
    return HumanDecision("fixture reviewer", verdict, WHEN, "The fixture reading was reviewed.", _subject(origin))


def test_published_discovery_tables_are_the_executable_cases() -> None:
    tables = _published_tables()
    assert tables["G-PROMOTE"] and tables["G-NEG"] and tables["G-ITER"], "no rows parsed; the document shape changed"
    assert len(tables["G-PROMOTE"]) == 5
    assert len(tables["G-NEG"]) == 11
    assert len(tables["G-ITER"]) == 6
    assert Counter(tables["G-PROMOTE"]) == Counter(G_PROMOTE_ROWS)
    assert Counter(tables["G-NEG"]) == Counter(G_NEG_ROWS)
    assert Counter(tables["G-ITER"]) == Counter(G_ITER_ROWS)


def test_g_promote_rows_drive_adjudication_and_attribution(tmp_path: Path) -> None:
    candidate = _candidate()
    authorizations = tmp_path / "authorizations.jsonl"
    with pytest.raises(AdjudicationError):
        promote(decision=object(), candidate=candidate, authorizations=authorizations)  # type: ignore[arg-type]
    assert not authorizations.exists()
    record = promote(decision=_decision(), candidate=candidate, authorizations=authorizations)
    assert record.verdict is Verdict.PROMOTE
    assert authorizations.read_bytes()

    refused_verdicts = []
    for verdict in (Verdict.REJECT, Verdict.DEFER):
        before = authorizations.read_bytes()
        with pytest.raises(AdjudicationError):
            promote(decision=_decision(verdict), candidate=candidate, authorizations=authorizations)
        assert authorizations.read_bytes() == before
        refused_verdicts.append(verdict)

    refused_origins = []
    for origin in (KeyOrigin.CONTENT, KeyOrigin.UNKNOWN):
        assert is_promotable(_subject(origin)) is False
        before = authorizations.read_bytes()
        with pytest.raises(AdjudicationError):
            promote(decision=_decision(origin=origin), candidate=candidate, authorizations=authorizations)
        assert authorizations.read_bytes() == before
        refused_origins.append(origin)

    memory = AgentMemory(tmp_path / "session-notes.jsonl")
    memory.remember(session="fixture session", note="review later", at=WHEN)
    note = memory.notes()[0]
    assert len(memory.notes()) == 1
    assert type(note) is tuple and all(type(value) is str for value in note)
    with pytest.raises(AdjudicationError):
        promote(decision=note, candidate=candidate, authorizations=authorizations)  # type: ignore[arg-type]
    drivers = {
        G_PROMOTE_ROWS[0][0]: record.verdict is Verdict.PROMOTE,
        G_PROMOTE_ROWS[1][0]: refused_verdicts == [Verdict.REJECT, Verdict.DEFER],
        G_PROMOTE_ROWS[2][0]: refused_origins == [KeyOrigin.CONTENT, KeyOrigin.UNKNOWN],
        G_PROMOTE_ROWS[3][0]: authorizations.read_bytes() == before,
        G_PROMOTE_ROWS[4][0]: type(note) is tuple and all(type(value) is str for value in note),
    }
    assert tuple(drivers) == tuple(row[0] for row in G_PROMOTE_ROWS)
    assert all(drivers[row[0]] for row in G_PROMOTE_ROWS)


def test_g_neg_discriminates_documented_refusals_from_passes() -> None:
    cards = tuple(_card(row, number) for number, row in enumerate(G_NEG_ROWS))
    assert len(cards) == 11
    refused = tuple(card for card in cards if not card.accepted)
    accepted = tuple(card for card in cards if card.accepted)
    assert refused, "NOT_RUN: G-NEG produced no refusals"
    assert accepted, "NOT_RUN: G-NEG produced no accepted controls"
    assert len(refused) == 8
    assert len(accepted) == 3
    assert tuple(card.cluster_id for card in refused) == tuple(row[0] for row in G_NEG_ROWS if row[3] == "FAIL")
    assert tuple(card.cluster_id for card in accepted) == tuple(row[0] for row in G_NEG_ROWS if row[3] == "PASS")
    for row, card in zip(G_NEG_ROWS, cards, strict=True):
        failed_gates = tuple(gate for gate in Gate if card.gates.outcome(gate) is GateOutcome.FAIL)
        if row[3] == "FAIL":
            assert len(failed_gates) == 1, card.cluster_id
            assert all(card.gates.outcome(gate) is GateOutcome.PASS for gate in Gate if gate not in failed_gates)
        else:
            assert failed_gates == (), card.cluster_id
    assert {card.gates.triviality for card in refused if card.gates.outcome(Gate.G4) is GateOutcome.FAIL} >= set(TrivialityArchetype)
    assert all(card.gates.outcome(Gate.G6) is GateOutcome.FAIL for card in cards if card.cluster_id == "tide-word-noise")
    assert all(card.gates.outcome(Gate.G3) is GateOutcome.FAIL for card in cards if card.cluster_id == "office-link-already-stated")


def test_g_iter_rows_drive_recorded_round_behaviour(tmp_path: Path) -> None:
    rejected = _card(G_NEG_ROWS[0], 0)
    first_pass = _card(G_NEG_ROWS[8], 8, origin_round=1)
    later_pass = _card(G_NEG_ROWS[9], 9, origin_round=2)
    registry = BridgeRegistry(tmp_path / "bridges.jsonl")
    memory = RejectionMemory(tmp_path / "rejections.jsonl")
    first = run_round(round_number=1, candidates=(rejected, first_pass), registry=registry, memory=memory, at=WHEN)
    second = run_round(round_number=2, candidates=(rejected, later_pass), registry=registry, memory=memory, at=WHEN)
    assert first.status is RoundStatus.COMPLETE
    assert second.skipped == (rejected.cluster_id,)
    assert rejected not in second.proposed
    assert first_pass in registry.accepted() and later_pass in registry.accepted()
    assert set(first.accepted) <= set(registry.accepted())
    assert {card.cluster_id for card in second.proposed} - {card.cluster_id for card in first.proposed} == {later_pass.cluster_id}
    assert tuple(card.origin_round for card in registry.accepted()) == (1, 2)

    preseeded = _card(G_NEG_ROWS[1], 1)
    seeded_memory = RejectionMemory(tmp_path / "seeded-rejections.jsonl")
    seeded_memory.record(cluster_id=preseeded.cluster_id, failed_gate=Gate.G4.value, reason="fixture rejection", round_number=1, rejected_at=WHEN)
    seeded = run_round(round_number=1, candidates=(preseeded,), registry=BridgeRegistry(tmp_path / "seeded-bridges.jsonl"), memory=seeded_memory, at=WHEN)
    assert seeded.status is RoundStatus.NOT_RUN and seeded.skipped == (preseeded.cluster_id,)

    unseen_one = _card(G_NEG_ROWS[10], 10)
    unseen_two = _card(G_NEG_ROWS[7], 7)
    rotated = rotation_order(registry, (rejected, unseen_one, first_pass, unseen_two))
    drivers = {
        G_ITER_ROWS[0][0]: second.skipped == (rejected.cluster_id,),
        G_ITER_ROWS[1][0]: seeded.status is RoundStatus.NOT_RUN and seeded.skipped == (preseeded.cluster_id,),
        G_ITER_ROWS[2][0]: first_pass in registry.accepted() and later_pass in registry.accepted(),
        G_ITER_ROWS[3][0]: {card.cluster_id for card in second.proposed} - {card.cluster_id for card in first.proposed}
        == {later_pass.cluster_id},
        G_ITER_ROWS[4][0]: tuple(card.origin_round for card in registry.accepted()) == (1, 2),
        G_ITER_ROWS[5][0]: rotated == (unseen_one, unseen_two, rejected, first_pass),
    }
    assert tuple(drivers) == tuple(row[0] for row in G_ITER_ROWS)
    assert all(drivers[row[0]] for row in G_ITER_ROWS)


def test_g_disc_schema_validity_is_checked_and_trigger_is_not_reached() -> None:
    cards = tuple(_card(row, number) for number, row in enumerate(G_NEG_ROWS))
    assert len(cards) == 11
    assert all(type(card) is BridgeCard for card in cards)
    hints = get_type_hints(BridgeCard)
    assert hints["left"] is Endpoint

    @dataclass
    class PositiveControl:
        endpoint: Endpoint

    assert get_type_hints(PositiveControl)["endpoint"] is Endpoint
    condition = "at least one novel gate-passing bridge and at least eight schema-valid cards"
    text = " ".join(DISCOVERY_GOLDEN.read_text(encoding="utf-8").split())
    assert condition in text
    assert "The novel-bridge half requires a model run that this capability does not perform." in text
    schema_valid = all(type(card) is BridgeCard for card in cards) and len(cards) >= 8
    model_run_performed = False
    trigger_reached = schema_valid and model_run_performed
    assert trigger_reached is False, "G-DISC is NOT REACHED: this capability performs no model run"
