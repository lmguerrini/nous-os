# Golden discovery cases

**Expectations here are derived from the fixture text and the rubric, not from a
run.** Each row says what the published boundary or a correct rubric record must
say, and that was decided by reading the documents and the rubric — not by
running discovery and recording what came back. A golden file regenerated from
the implementation it constrains cannot fail.

The two fixture directories are the two projects in these cases: an endpoint in
`corpus/` and one in `bilingual/` are cross-project. The cards below are small,
invented readings of this public fixture set. Their gate vectors record the
rubric judgement; they do not claim that a deterministic lexical search made it.

## G-PROMOTE — the human boundary

| What must hold | Why |
|---|---|
| no path promotes a candidate to canon without an explicit human decision value | A proposal records an arrival, while the rubric reserves promotion for an explicit human decision. |
| a decision whose verdict is not `promote` does not promote | `reject` and `defer` are recorded decision outcomes, not latent permission. |
| a key whose origin is content-derived or unestablished does not promote | The origin vocabulary makes content and unknown origins useful for proposals but ineligible at the promotion boundary. |
| a refused promotion leaves the authorization record byte-identical | A refusal is not an authorization, so it cannot append a changed authorization record. |
| session notes never yield a value the promotion path accepts | Session memory holds only ordinary note strings; it is physically separate from a human decision. |

## G-NEG — negative-control discrimination

| Cluster | Depth | Gate vector | Verdict | Why, from the rubric |
|---|---|---|---|---|
| office-records-common-tool | moderate | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | `harbour-office.md` and `notes/tides.md` both mention ordinary records; that is commodity tooling, not a mechanism bridge. |
| rotating-watch-routine | moderate | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | `notes/lighthouse.md` and `en-lighthouse.md` both describe a rotating watch; the common routine is generic process overlap. |
| parallel-lighthouse-accounts | obvious | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | The two lighthouse accounts are related by the fixture's paired subject, so the relation is same ecosystem by definition rather than a bridge. |
| named-harbour-office | obvious | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | `notes/lighthouse.md` names the harbour office that `harbour-office.md` titles; reporting that relation restates an explicit cross-reference. |
| tide-word-noise | moderate | G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=FAIL | FAIL | The tide vocabulary is shared, but the stated noise objection — coincidence in shared vocabulary — wins its own gate. |
| office-link-already-stated | moderate | G1=PASS; G2=PASS; G3=FAIL; G4=PASS; G5=PASS; G6=PASS | FAIL | `harbour-office.md` already says that two documents refer to the office; a supplied co-mention outside the endpoints makes the link already stated elsewhere. |
| lexical-lighthouse-words | obvious | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | The lighthouse pair reads as a shared-vocabulary pairing rather than a mechanism bridge. |
| lexical-tide-words | obvious | G1=PASS; G2=PASS; G3=PASS; G4=FAIL; G5=PASS; G6=PASS | FAIL | The tide pair reads as a shared-vocabulary pairing rather than a mechanism bridge. |
| glossary-to-maree | deep | G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS | PASS | `glossary.md` defines *marea sigiziale* as the Italian name for spring tide, while `it-maree.md` uses *sizigie*; the language bridge explains the otherwise separated terms. |
| keepers-to-tide-records | deep | G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS | PASS | The keepers' logbooks are the source of the bay's earliest tide records, connecting the watch history to the tide account. |
| automation-to-faro | deep | G1=PASS; G2=PASS; G3=PASS; G4=PASS; G5=PASS; G6=PASS | PASS | The office records begin when the lighthouse is automated, connecting the record history to the lighthouse's harbour role. |

The four named non-triviality failures are all represented once: commodity
tooling, generic process overlap, same ecosystem by definition, and restated
cross-reference. The two lexical-adjacency rows deliberately remain refusals.

## G-ITER — rounds keep their history

| What must hold | Why |
|---|---|
| a cluster rejected in an earlier round is not re-adjudicated later | Rejection memory is durable so a known failed cluster is skipped rather than proposed again. |
| a memory populated before the first round is honoured in the first round | Consultation is not deferred until a later round; existing rejection memory already has its exclusion effect. |
| accepted results accumulate and never shrink across rounds | The bridge registry is append-only, and accepted cards are its accepted projection. |
| round k+1 surfaces at least one cluster absent from round k | A later round can introduce a new candidate rather than repeating the earlier candidate set. |
| `origin_round` is preserved as written | A card carries the round where it originated; recording does not rewrite that field. |
| rotation puts unmined clusters before mined ones, preserving relative order within each group | Rotation is a stable partition over durable mined history, not a re-ranking of either group. |

## G-DISC — conditional discovery trigger

The promotion condition is: **at least one novel gate-passing bridge and at
least eight schema-valid cards**.

The deterministic half is schema validity. Every documented card in G-NEG is
schema-valid; the pinned count is **11**. The novel-bridge half requires a
model run that this capability does not perform. Its trigger is therefore
**NOT REACHED**, recorded as not reached rather than passed or failed. No blind
discovery result is fabricated here.
