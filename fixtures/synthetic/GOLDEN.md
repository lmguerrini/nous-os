# Golden cases

**Expectations here are derived from the fixture text, not from a run.** Each row says which
documents a correct system must return, and that was decided by reading the documents — not by
running the search and recording what came back. A golden file regenerated from the implementation
it constrains cannot fail.

The fixture set is deliberately bilingual, because vocabulary that differs across languages is one
cause of retrieval misses, and a monolingual fixture set cannot
exercise an alias layer at all.

## G-RETR — exact lexical retrieval, no aliases

Each query appears verbatim in exactly one document, so a correct exact-match system returns that
one and no other.

| Query | Must return | Why, from the text |
|---|---|---|
| `tide` | `en-tides` | the English document says "The tide rises"; the Italian one contains no such word |
| `marea` | `it-maree` | the Italian document says "La marea sale"; the English one contains no such word |
| `lighthouse` | `en-lighthouse` | present in the English document only |
| `faro` | `it-faro` | present in the Italian document only |

## G-ITEN — the cross-language gap

Each query must return **both** language versions of the same subject. With no alias layer these
are misses, by construction: the Italian document does not contain the English term. That is the
gap the alias layer exists to close, and the baseline exists so the closing can be measured rather
than asserted.

| Query | Must return | Baseline outcome, expected |
|---|---|---|
| `tide` | `en-tides`, `it-maree` | MISS — Italian text has no "tide" |
| `lighthouse` | `en-lighthouse`, `it-faro` | MISS — Italian text has no "lighthouse" |

## G-TIME — valid time and recorded time stay separate

For these hand-chosen temporal assertions, `A` is the fixture instant
`2026-03-20T00:00:00+00:00`, representing the lighthouse's automation; `B` is
`2026-01-01T00:00:00+00:00`. The corpus gives the relation to `A`, not a calendar
date: claims about the keepers end at `A`, while claims about the office records
begin at `A`. `R5` is `2026-03-25T00:00:00+00:00`. The assertion ids below are
the fixed fixture set used by the table.

| Assertion id | Validity | Recorded at | Why, from the text |
|---|---|---|---|
| asr_00000000000000000000000101 | `[B, A)` | `B` | "Before automation, three keepers worked a rotating watch." establishes that the keeper claim ends when automation occurs. |
| asr_00000000000000000000000102 | `[, A)` | `B` | "Before automation, three keepers worked a rotating watch." gives an end but no beginning for the keeper claim. |
| asr_00000000000000000000000103 | `[A, )` | `2026-03-21T00:00:00+00:00` | "The harbour office has kept these records since the lighthouse was automated." gives a beginning at automation and no end. |
| asr_00000000000000000000000104 | `[A, )` | `2026-03-30T00:00:00+00:00` | "The harbour office has kept these records since the lighthouse was automated." is the same validity claim learned at a later recorded time. |
| asr_00000000000000000000000105 | `[, )` | `2026-03-22T00:00:00+00:00` | "The keepers' logbooks were transferred to the harbour office and are the source of the bay's earliest tide records." supplies no date on either validity bound. |

The three columns are a complete partition of this five-assertion set. An absent
validity bound stays unknown: it does not become an invented infinite interval.

| Query | Established | Excluded | Undetermined | Why, from the text |
|---|---|---|---|---|
| valid_at=2026-01-01T00:00:00+00:00 | `asr_00000000000000000000000101` | `asr_00000000000000000000000103`, `asr_00000000000000000000000104` | `asr_00000000000000000000000102`, `asr_00000000000000000000000105` | The bounded keeper claim starts at `B`, so `[B, A)` includes its start. The office-record claims do not begin until automation; the claim without a keeper start and the undated transfer claim remain unknown. |
| valid_at=2026-03-19T00:00:00+00:00 | `asr_00000000000000000000000101` | `asr_00000000000000000000000103`, `asr_00000000000000000000000104` | `asr_00000000000000000000000102`, `asr_00000000000000000000000105` | The keeper sentence says before automation, so the bounded keeper claim holds before `A`; the office-record sentence says since automation, so those claims do not. The keeper claim with no start and the undated transfer claim remain unknown. |
| valid_at=2026-03-20T00:00:00+00:00 | — | `asr_00000000000000000000000101`, `asr_00000000000000000000000102` | `asr_00000000000000000000000103`, `asr_00000000000000000000000104`, `asr_00000000000000000000000105` | "Before automation" ends at `A`, so `[B, A)` excludes its end. "Since the lighthouse was automated" supplies a beginning but no end, so it is not enough to establish the whole interval; the transfer sentence still supplies neither bound. |
| recorded_as_of=2026-03-25T00:00:00+00:00 | `asr_00000000000000000000000101`, `asr_00000000000000000000000102`, `asr_00000000000000000000000103`, `asr_00000000000000000000000105` | `asr_00000000000000000000000104` | — | The two office assertions state the same "since the lighthouse was automated" validity, but their recorded times differ: the later one was not yet known at `R5`. |
| valid_at=2026-03-19T00:00:00+00:00; recorded_as_of=2026-03-25T00:00:00+00:00 | `asr_00000000000000000000000101` | `asr_00000000000000000000000103`, `asr_00000000000000000000000104` | `asr_00000000000000000000000102`, `asr_00000000000000000000000105` | Before `A`, the office-record claim is validity-excluded even though the earlier recording is known; that exclusion wins. The unknown-start keeper claim is recorded but remains validity-undetermined, so unknown wins over the other axis establishing it. |

## G-CONTRA — disagreement retains every cited side

These assertions use the same hand-chosen validity instants `A`, `B`, and
`C=2026-04-20T00:00:00+00:00`. The tide note is the documented four-metre side;
the five- and six-metre survey assertions are deliberate counterclaims in this
fixture set, each with its own cited source. The exact positive count is three:
the two negative-control rows below must not add a conflict.

| Claim key | Members | Overlap | Conflict? | Why, from the text |
|---|---|---|---|---|
| tide-mean-2026 | `asr_00000000000000000000000201`, `asr_00000000000000000000000202` | `overlaps` | yes | `notes/tides.md` says "a mean range of four metres, with spring tides reaching five"; the fixture's separately cited survey says a mean range of five metres for the same period. They disagree about one subject over overlapping validity. |
| tide-spring-range | `asr_00000000000000000000000207`, `asr_00000000000000000000000208` | `undetermined` | yes | `notes/tides.md` says "spring tides reaching five"; the separately cited counterclaim says six. One validity start is absent, while both claims can extend beyond `A`, so the text does not decide whether their periods overlap. |
| tide-mean-2027 | `asr_00000000000000000000000209`, `asr_00000000000000000000000210`, `asr_00000000000000000000000211` | `overlaps` | yes | The documented four-metre mean and the two separately cited five- and six-metre survey claims all concern the same period. All three sides must surface as one connected disagreement. |
| keepers-watch | `asr_00000000000000000000000203`, `asr_00000000000000000000000204` | `disjoint` | no | "Before automation, three keepers worked a rotating watch" ends at `A`; "Automated in the spring of its ninetieth year" begins at `A`. Their `[B, A)` and `[A, C)` periods abut but do not overlap. |
| office-records and lighthouse-status | `asr_00000000000000000000000205`, `asr_00000000000000000000000206` | `overlaps` | no | "The harbour office has kept these records since the lighthouse was automated" and "Automated in the spring of its ninetieth year" overlap in time but concern explicitly different claim keys. |
