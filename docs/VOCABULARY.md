# NousOS — Vocabulary

Two registers of names, and an honest map between them.

This document exists because a knowledge system is judged partly on whether its own words are
true. It describes the concepts that **exist in the code today**, under the names the code
actually uses, and records which of them have earned a second, epistemic name — and which have
not.

Much of it is checked rather than asserted, and the parts that are not are marked.
`tests/test_vocabulary.py` reads this file and fails the build when it drifts from the code: every
`path:line` reference must resolve, and — wherever the reference sits beside a named identifier,
which is most but not all of them — **must land on a line that contains something the reference is
offered as evidence for**; every reference in the register must land on a *definition* of its
term rather than on a line that merely mentions it; every member list must match the enumeration it
claims to describe, in order; every closed vocabulary in the code must appear here; every term the
epistemic register maps must be referenced from more than one file; the excluded vocabulary below
must be absent from the canonical layer; and the tree's source must be unchanged from the revision
this work began at — the claim that naming changed no structure is a check, not a promise, and it
fails loudly rather than passing quietly if it cannot be run at all.

**What is not checked is named, not hidden.** The prose in the fourth column, the reasoning in every
candidate record, and each judgement about whether a word is accurate are all unverifiable by a
test. The epistemic register marks each of its rows `SEMANTIC` in a column for the purpose; the
technical table's fourth column and the candidate records carry no such marker, and are judgement
throughout rather than in labelled parts. The checker also carries two admissions a
reader can use against it. It lists, in its own source, the vocabulary shapes it knows
it cannot detect, and a test pins that list non-empty so emptying it to look complete fails the
build. **That list is a record of what has been found, not a proof that nothing else exists** — each
review so far has added to it, and the next one should be expected to. And it
records, on every run, which references sit beside no named identifier and are therefore checked
only for existence.

**Neither is given a number here, deliberately.** Both should move — the first upward as more gaps
are admitted, the second downward as citations get more specific — and a number typed into prose
beside a list that changes is the staleness this document exists to catch. An earlier draft of this
very paragraph stated one of them and it went stale within the hour. **The counts that must not drift are
enforced instead of printed.** The number of defects named below is asserted against the table it
counts. So is everything the document publishes about how two governed states combine into one
rendered value — the offsets it quotes, every row of that table, the pair it names as identical, and
the spelled count of collisions — each compared against what the code actually produces, so that
editing a constant in the renderer's calibration turns this document red rather than leaving a
true-looking sentence behind.

## The rule this document applies

An epistemic term is adopted only when **all three** hold:

1. a stable conceptual boundary **already exists in implemented code**;
2. the term is **semantically accurate** for that boundary;
3. adopting the term **changes no structure**.

**If adopting a name would require restructuring, the name is rejected — never the structure.**

Each candidate below records which of the three it failed, as **C1**, **C2** or **C3**. The
criteria are asked in order and the first failure decides; a candidate is not carried past its
failure to look for a rescue.

The rule was fixed before any term was considered. **A reader of this repository cannot verify
that**, and it is said here as a claim rather than as evidence: the ordering is recorded outside this
tree, and this document's own history begins after the fact. What a reader *can* check is the consequence — that no
term below was adopted whose adoption moved a single line of source, and that the diff proving it is
in this repository's history.

## The result, stated first

**Zero new epistemic terms were adopted.**

Two terms are recorded as *already adopted* — `canon`/`canonical` and `EpistemicClass` — and in
both cases adoption is a no-op, because the word arrived **with** the structure rather than being
fitted to it afterwards. Six candidates were rejected and one produced a deliberate no-mapping.

That is a success condition, not a shortfall. A system that had to import a vocabulary in order to
describe itself would be telling you its own names were inadequate. NousOS's names are mostly
plain English, mostly exact, and the exercise that could have replaced them found almost nothing
worth replacing.

---

## The two registers

**Technical register** — the names in the code. A reader can open the file and find them. These
are load-bearing: changing one is a code change with tests behind it.

**Epistemic register** — names for what the system *knows and does not know*, drawn from the
vocabulary of knowledge rather than of software. This register is small on purpose.

The two registers **do not map one-to-one and are not made to**. A technical concept may have no
epistemic name at all; several may compose into one; an epistemic term may sit at a different
level of abstraction entirely. Every row below declares which shape it is, and a declared shape
that disagrees with the row's own contents fails the build.

---

## Technical register

The closed vocabularies. NousOS records typed classes and never a numeric confidence, so these
enumerations *are* the places the product's meaning lives — which is why the check over this table
is total over a **stated** surface: every enumeration in `src/nous_os/`, and every **named,
exported** closed string vocabulary in `ui/src/engine/`, must appear here. The check derives both
sets by walking the source, never from a list anyone maintains, so a concept added to the code and
left out of this table turns the build red.

**The surface is stated because it is not everything.** A closed set of strings written inline as a
field's type — rather than given a name and exported — is not a named vocabulary and is not covered;
the same is true of a few exotic declaration shapes, which the checker enumerates in its own source
so that the gap is findable. Those are limits of the check, and they are recorded here rather than
left for a reader to discover by being wrong.

<!-- vocabulary:technical -->

| Term | Defined at | Closed members | What it distinguishes |
|---|---|---|---|
| `LifecycleState` | `src/nous_os/canonical.py:42` | `CANONICAL` · `CANDIDATE` · `REJECTED` | Where a record sits relative to canon. A position, not a transition — nothing here moves a record between them. |
| `SupportClass` | `src/nous_os/canonical.py:56` | `DIRECT_QUOTE` · `PARAPHRASE` · `SUMMARY` · `INFERRED` · `UNKNOWN` | How a cited span supports the claim. Ordered for reading only; nothing may compare two members. |
| `KeyOrigin` | `src/nous_os/attribution.py:33` | `OPERATOR` · `DERIVED` · `CONTENT` · `UNKNOWN` | How an explicit key reached this boundary. Only two origins may approach promotion. |
| `Verdict` | `src/nous_os/adjudication.py:42` | `PROMOTE` · `REJECT` · `DEFER` | What a person decided. Deferral is an outcome, never latent permission. |
| `Tier` | `src/nous_os/capability.py:75` | `READ` · `PROPOSE` · `PROMOTE` · `EXTERNAL_CONSEQUENTIAL_ACTION` | Four kinds of authority, deliberately without rank. A tier is not a level. |
| `IngestStatus` | `src/nous_os/ledger.py:74` | `INGESTED` · `UNCHANGED` · `SUPERSEDED` | What one ingest actually did to the record. |
| `Gate` | `src/nous_os/discovery.py:47` | `G1` · `G2` · `G3` · `G4` · `G5` · `G6` | The six rubric criteria a proposed link is judged against. Every one is recorded, including when unknown. |
| `GateOutcome` | `src/nous_os/discovery.py:58` | `PASS` · `FAIL` · `UNKNOWN` | What one criterion returned. Unknown is not permission to pass. |
| `Depth` | `src/nous_os/discovery.py:66` | `OBVIOUS` · `MODERATE` · `DEEP` | How a link is described, as a label. Not a rank and not a score. |
| `EpistemicClass` | `src/nous_os/discovery.py:79` | `EXPLICIT` · `DERIVED` · `SPECULATIVE` | How a link's statement stands to its endpoints: said outright, inferred, or guessed. |
| `TrivialityArchetype` | `src/nous_os/discovery.py:87` | `COMMODITY_TOOLING` · `GENERIC_PROCESS_OVERLAP` · `SAME_ECOSYSTEM_BY_DEFINITION` · `RESTATED_CROSS_REFERENCE` | The four named ways a link can be true and worthless. |
| `RoundStatus` | `src/nous_os/discovery.py:96` | `COMPLETE` · `NOT_RUN` | Whether a round of judging happened at all. |
| `Outcome` | `src/nous_os/measure.py:35` | `HIT` · `MISS` | What one measured case did. |
| `RunStatus` | `src/nous_os/measure.py:55` | `COMPLETE` · `NOT_RUN` | Whether the measurement ran. A run that did not happen is never a pass. |
| `Overlap` | `src/nous_os/temporal.py:81` | `OVERLAPS` · `DISJOINT` · `UNDETERMINED` | What the available validity bounds establish about two intervals — including that they establish nothing. |
| `QuarantineReason` | `src/nous_os/untrusted.py:42` | `INSTRUCTION_TO_THE_READER` · `ROLE_REASSIGNMENT` · `CONTROL_CHANNEL_MARKUP` · `CREDENTIAL_SOLICITATION` | Why outside content was held apart. A named reason, never a score. |
| `NodeKind` | `src/nous_os/projection.py:43` | `SOURCE` · `SUBJECT` · `CLUSTER` · `ASSERTION` · `CONFLICT` · `BRIDGE` · `REJECTION` | The seven things a graph node can be. It prescribes no presentation. |
| `EdgeKind` | `src/nous_os/projection.py:55` | `ABOUT` · `CITES` · `CONFLICT_MEMBER` · `BRIDGE_SIDE` · `IN_CLUSTER` · `REJECTS` | The six relations. No relation selects a preferred claim. |
| `Side` | `src/nous_os/projection.py:66` | `LEFT` · `RIGHT` | Which end of a link an endpoint sits at. Not an ordering and not a preference. |
| `TemporalDisposition` | `src/nous_os/projection.py:73` | `ESTABLISHED` · `EXCLUDED` · `UNDETERMINED` | Time's three-way answer about a claim, carried through without revision. |
| `BridgeDisposition` | `src/nous_os/projection.py:81` | `ACCEPTED` · `REJECTED` · `UNDETERMINED` | What a complete rubric vector amounts to. Not a scalar assessment. |
| `PolicyId` | `src/nous_os/projection.py:89` | `RELIABILITY` · `DISCOVERY` · `EXPERIMENTAL` | Which omission policy produced a projection. |
| `VisualRole` | `ui/src/engine/contract.ts:51` | `source` · `subject` · `cluster` · `assertion` · `conflict` · `bridge` · `rejection` · `about` · `cites` · `conflict_member` · `bridge_side` · `in_cluster` · `rejects` | What the drawing layer is allowed to know an element is. Deliberately the same vocabulary, restated for the browser. |
| `RenderedState` | `ui/src/engine/contract.ts:76` | `TemporalDisposition.established` · `TemporalDisposition.excluded` · `TemporalDisposition.undetermined` · `BridgeDisposition.accepted` · `BridgeDisposition.rejected` · `BridgeDisposition.undetermined` · `EpistemicClass.explicit` · `EpistemicClass.derived` · `EpistemicClass.speculative` | The nine governed states a drawing may encode persistently. The drawing layer also reads an element's `kind`; everything beyond those two channels is opaque to it. |
| `Morphology` | `ui/src/engine/morphology.ts:8` | `stellar` · `neural` · `mycelium` | A material treatment of a graph that already has all of its meaning. It admits no element and assigns no meaning. It does scale elements by how connected they are, which is an ordering computed from the graph's own shape and never one of standing or belief. |
| `Organization` | `ui/src/engine/organization.ts:7` | `flat` · `indra` | Whether elements are laid out as one field or gathered into one level of groups. |
| `LodBand` | `ui/src/engine/lod.ts:7` | `macro` · `meso` · `micro` | How much detail the current view earns. |
| `Palette` | `ui/src/engine/tokens.ts:9` | `monochrome` · `interstellar` · `perceptual` · `solar` · `custom` | Which colour vocabulary is in force. |
| `Temperature` | `ui/src/engine/tokens.ts:10` | `cold` · `balanced` · `warm` | A colour-temperature axis, independent of palette. |
| `Theme` | `ui/src/engine/tokens.ts:11` | `system` · `dark` · `light` | Which ground the drawing sits on. |
| `Assertion` | `src/nous_os/canonical.py:130` | — | One claim, with its citation and its validity bounds. The unit canon is made of. |
| `Citation` | `src/nous_os/provenance.py:101` | — | Where a claim came from, exactly: a source, a snapshot digest and a byte range. |
| `Locator` | `src/nous_os/provenance.py:71` | — | A byte range in a specific snapshot. Not a page number and not a guess. |
| `Snapshot` | `src/nous_os/snapshots.py:43` | — | The bytes of a source as they were when read, addressed by their own content. |
| `SnapshotStore` | `src/nous_os/snapshots.py:67` | — | Where snapshots live. Nothing overwrites one. |
| `Ledger` | `src/nous_os/ledger.py:161` | — | The append-only record of every ingest. A file, not an index — reading it back is the whole of recovery. |
| `LedgerEntry` | `src/nous_os/ledger.py:97` | — | One ingest, recorded once. |
| `Proposal` | `src/nous_os/candidates.py:49` | — | Something put forward. Its holder has no authority whatsoever. |
| `CandidateStore` | `src/nous_os/candidates.py:91` | — | Append-only proposals with no route to canon. |
| `HumanDecision` | `src/nous_os/adjudication.py:108` | — | A person's act. The only thing that moves a proposal into canon. |
| `PromotionRecord` | `src/nous_os/adjudication.py:147` | — | That act, filed. It records authorization and never writes canonical content. |
| `Rejection` | `src/nous_os/adjudication.py:221` | — | A refusal, kept. Rejecting something is information, so it is not thrown away. |
| `RejectionMemory` | `src/nous_os/adjudication.py:249` | — | Refusals, never compacted and never erased. |
| `AgentMemory` | `src/nous_os/adjudication.py:313` | — | Notes a machine may keep, physically apart, with no promotion-shaped value to offer anything. |
| `Grant` | `src/nous_os/capability.py:163` | — | A holder and an exact set of tiers. |
| `UntrustedText` | `src/nous_os/untrusted.py:120` | — | Content from outside, held at arm's length. |
| `ClaimKey` | `src/nous_os/temporal.py:60` | — | What two claims must share to be about the same thing. |
| `AsOf` | `src/nous_os/temporal.py:90` | — | A question about a moment, asked along two independent time axes. |
| `Conflict` | `src/nous_os/temporal.py:108` | — | A substantive disagreement between claims, reported without making any one authoritative. |
| `TemporalIndex` | `src/nous_os/temporal.py:180` | — | History, answerable, with nothing deleted to make an answer simpler. |
| `BridgeCard` | `src/nous_os/discovery.py:216` | — | A proposed link between two projects, accepted only when its whole rubric vector passes. |
| `GateVector` | `src/nous_os/discovery.py:129` | — | All six criteria at once. Never collapsed into a number. |
| `Endpoint` | `src/nous_os/discovery.py:197` | — | One end of a proposed link, with an exact citation and a short quote. |
| `BridgeRegistry` | `src/nous_os/discovery.py:347` | — | Every card ever judged, never emptied. |
| `Chunk` | `src/nous_os/chunking.py:34` | — | A piece of a document that remembers where it came from. |
| `SearchHit` | `src/nous_os/derived.py:117` | — | One result from the rebuildable index. |
| `CohesionStrategy` | `src/nous_os/compile.py:42` | — | A pluggable way of deciding what belongs together in a pack. |
| `InclusionManifest` | `src/nous_os/compile.py:244` | — | What actually went into a pack, recoverable afterwards. |
| `Pack` | `src/nous_os/compile.py:275` | — | Assembled context, with its manifest attached. |
| `AliasTable` | `src/nous_os/aliases.py:43` | — | Interchangeable ways of naming the same thing across languages. |
| `AttributedKey` | `src/nous_os/attribution.py:56` | — | A key that carries where it came from. |
| `DataRoot` | `src/nous_os/config.py:44` | — | Where the corpus is. Configuration, never a value in the code. |
| `KnowledgeState` | `src/nous_os/projection.py:429` | — | Everything a projection is computed from, gathered in one place. |
| `ProjectionPolicy` | `src/nous_os/projection.py:448` | — | An omission policy. It decides what is left out and cannot change what anything means. |
| `TemporalQuestion` | `src/nous_os/projection.py:417` | — | The moment a projection answers as of. |
| `ProjectionNode` | `src/nous_os/projection.py:381` | — | One node of a renderer-independent graph. |
| `ProjectionEdge` | `src/nous_os/projection.py:397` | — | One relation, binary — a source and a target. There is no relation of three. |
| `ProjectionIR` | `src/nous_os/projection.py:644` | — | The renderer-independent graph itself. Nothing in it knows how it will be drawn. |
| `SCHEMA_VERSION` | `src/nous_os/projection.py:28` | — | Which shape of that graph this is. |
| `Semantic` | `ui/src/engine/contract.ts:11` | — | Meaning, made opaque to the drawing layer. The drawing layer cannot open it. |
| `VisualGraph` | `ui/src/engine/contract.ts:107` | — | The graph as the visual layer receives it, meaning still sealed. |
| `EngineGraph` | `ui/src/engine/contract.ts:143` | — | The much smaller view the drawing layer is actually handed. |
| `EngineAccessTrace` | `ui/src/engine/contract.ts:149` | — | A record of what the drawing layer read, so that reading too much is detectable. |
| `Coordinates` | `ui/src/engine/contract.ts:32` | — | A position. Which space it is in is not carried by the type. |
| `VisualStateValidationRule` | `ui/src/engine/visual-state.ts:68` | `field-register` · `known-element-id` · `closed-vocabulary` · `reduced-motion-boolean` · `finite-camera-number` · `positive-camera-ratio` · `bounds-axis-pair` · `increasing-bounds-axis` | The eight named ways a saved view can be malformed. A refusal carries which rule it broke, so a rejection is diagnosable rather than merely negative. |
| `LayoutAnchors` | `ui/src/engine/layout.ts:7` | — | Where elements sit, in world units, computed against a fixed reference frame. |

<!-- /vocabulary:technical -->

**Deliberately not in this table.** Exception types (they name refusals, and the refusal is the
rule, not the concept); strategy implementations of `CohesionStrategy` and `AliasTable`; internal
helpers; the drawing-layer machinery under `ui/src/render2d/`, which is specific to the renderer that
happens to ship today and is expected to be replaced; and — the largest omission, named here because
it is easy to walk into — **the visual layer's element and material record types**. `VisualGraph` and
`EngineGraph` are listed because the *difference* between them is a boundary; the node, edge,
metadata, material and calibration records that make up that difference are not, because they are
the shape of a payload rather than a distinction the product's meaning rests on. A reader following
the `VisualGraph`/`EngineGraph` argument into the code will meet roughly sixty such types, and this
sentence is here so that meeting them is expected rather than a surprise. The check above covers the
closed vocabularies totally; the record types are covered as judged, and the omissions are named
here rather than left to be noticed.

---

## Epistemic register

<!-- vocabulary:epistemic -->

| Epistemic term | Verdict | Cardinality | Technical terms | Basis |
|---|---|---|---|---|
| `canon` | ADOPT | level-spanning | `LifecycleState` · `Assertion` | SEMANTIC |
| `EpistemicClass` | ADOPT | 1:1 | `EpistemicClass` | SEMANTIC |
| `Noema` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Synesis` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Mneme` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Anamnesis` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Epoche` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Krisis` | REJECT | NO-MAPPING | — | SEMANTIC |
| `Doxa` | NO-MAPPING | NO-MAPPING | — | SEMANTIC |

<!-- /vocabulary:epistemic -->

**Cardinality describes the mapping that exists, not the one a term would have had.** A rejected
term maps to nothing, so its cardinality is `NO-MAPPING`; the shape it *would* have taken is
recorded in its own rationale below, where it is an argument rather than a fact. Writing a live
cardinality beside an empty list would let the register look fuller than it is, which is the exact
direction this document is supposed to resist. The check enforces the agreement: a declared shape
that disagrees with the row's own contents fails the build.

Of the five shapes the format supports, three occur here. `1:1` and `level-spanning` are used
above. `1:0` — a technical concept with no epistemic name — is the most common case in the whole
system, and it is expressed by the *left technical* table below rather than here, because this
table is keyed by epistemic term and a term that does not exist has no row. `many:1`, several
technical concepts composing into one higher epistemic concept, is supported and **does not
occur**: the one multi-term mapping, `canon`, is not a composition. Its **two** technical terms are
not two peers that add up to something — `LifecycleState` is the type that *draws* the authority
line, and `Assertion` is the record that *has a position* relative to it. One is the distinction and
the other is what the distinction applies to. That is a difference in level, not a sum, which is
what `level-spanning` names and why `many:1` would be the wrong label for it.

Every row is marked `SEMANTIC`. That is not modesty: whether a word accurately names a boundary
is a judgement about meaning, and no check settles it. What *is* checked is that the boundary
exists, that it is referenced from more than one file, and that adoption changed no source. The
judgement sits on top of those facts and is offered as a judgement.

---

## Candidate records

<!-- vocabulary:candidates -->

### Candidate — `canon`

- **Proposed boundary:** the authority line itself — `LifecycleState` at `src/nous_os/canonical.py:42`, the type whose whole job is to draw that line, and the `Assertion` at `src/nous_os/canonical.py:130`, the thing that has a position relative to it. **Two terms, not four.** An earlier draft also mapped `Ledger` and `Snapshot`, on the ground that those files *are* the canon. That was an overreach and it contradicted this document's own left-technical row, which calls the same two "the substrate rather than the meaning" — and rightly, because the same snapshot bytes back canonical, candidate and rejected claims indifferently. A storage term neutral about standing does not express a standing. Both stay technical.
- **Evidence the boundary exists:** the line is enforced in four places, three of which share no import with each other. Promotion is a separate act with its own record; the candidate store states it has no authority over canon; the rebuildable index can be deleted without loss; and a record's lifecycle state is deliberately excluded from its content digest, so that a record's standing and what it says can change independently. **Two precisions an earlier draft got wrong.** The promotion module does import the candidate module, so "none of them know about each other" was too strong — what is true is that no shared mechanism coordinates them. And the digest exclusion is not evidence of a *transition*: the type's own docstring says it is a state and not a transition, and that nothing in that module moves a record between states. The exclusion exists so that a change of standing, whenever and however it happens, cannot read as an edit.
- **Intended meaning:** a canon is the body of material a community treats as authoritative, as distinct from material that merely exists. The word carries exactly the right implication — that inclusion is a decision someone made, not a property the material has on its own.
- **Why the mapping is accurate or inaccurate:** accurate, and unusually so. The one thing a reader must understand about this system is that being stored and being authoritative are different, and that only a person crosses the gap. "Canon" says that in one word to anyone who has met the word anywhere else. The alternative reading — canon as a fixed, closed, finished list — is the only inaccuracy, and it is corrected by the neighbouring vocabulary rather than by choosing a different word. **The obvious objection, answered here rather than left for a reader to raise:** this document rejects `Mneme` partly because the stores it would cover do not share one standing, and `LifecycleState` names all three standings while an `Assertion` may hold any of them — so is `canon` doing the same thing? No, and the difference is the whole answer. `Mneme` claimed a *family*: these stores are the same kind of thing. They are not. `canon` claims a *locus*: these two are where the distinction is drawn and where it applies. **A type that names both sides of a distinction is evidence the distinction is drawn there**, not evidence the term is confused.
- **Structural change required:** none. The word is already the module name, the enum member, the exception family and the README's opening line of prose. Adoption is a literal no-op, which is what criterion 3 asks for and almost never gets.
- **Verdict:** ADOPT
- **Failed at:** —
- **Consequence for product terminology:** none. This record ratifies what is already published; it does not introduce a word.

### Candidate — `EpistemicClass`

- **Proposed boundary:** `EpistemicClass` at `src/nous_os/discovery.py:79`, with `EXPLICIT`, `DERIVED` and `SPECULATIVE`, carried into projections at `src/nous_os/projection.py:455` and into the drawing layer at `ui/src/engine/contract.ts:79` as one of the three governed rendered vocabularies.
- **Evidence the boundary exists:** the **type** survives three layers unchanged. It is a member of the rubric a proposed link is judged against; it is one of the four predicates an omission policy admits on; and it is one of only three enumerations in the partition the code calls **persistent** — the states a drawing may encode continuously, of which this is one. The system pins fourteen in two sets it keeps **disjoint** and refuses to let overlap: those three, and eleven reserved for inspection. **Two clarifications, because an earlier draft of this bullet overstated both halves.** The drawing layer is not restricted to three enumerations in total — the field allow-list also lets it read an element's `kind`, which is a governed `NodeKind` or `EdgeKind` member. And the eleven are not "never drawn": `NodeKind` and `EdgeKind` reach the screen as label text. The real distinction the two sets draw is between states a rendering may encode **persistently, in a visual channel** and states surfaced **on inspection**, which is what the code's own names for them say. **What does not survive the third layer is the distinction, and the reason is arithmetic.** A bridge element carries two governed states at once — a disposition and an epistemic class — and the renderer averages their two lightness offsets into one. With the shipping offsets, the **nine** legal combinations land on only **five** distinct values: `accepted`+`derived` and `rejected`+`explicit` produce the identical result, and two further groups collide in the same way — the table in *Known defects in the layers below* names all three. Two elements in different semantic states are then byte-identical on screen, at every zoom, palette and theme. This is recorded in *Known defects in the layers below* rather than asserted loosely, and it is stated here because citing "survives three layers" as evidence for the *boundary* while the distinction collapses at the last one would be exactly the overclaim this document exists to avoid. The boundary is real in the two layers that carry meaning; the third is where it is currently lost.
- **Intended meaning:** an epistemic class says *how a statement is known*, not how strongly it is believed. Explicit means the source said it. Derived means it follows. Speculative means it was proposed and is not established.
- **Why the mapping is accurate or inaccurate:** accurate, and it is the clearest case in the codebase of a name that arrived with its structure. The distinction is genuinely epistemic — three ways of standing to evidence — and it is expressed as three named members rather than a number, which is the same commitment the system makes everywhere else. The one risk is that a reader takes the three members for an ordering. They are not ordered, nothing compares them, and the neighbouring enumerations carry the same warning in their own docstrings.
- **Structural change required:** none. The term is the type's name.
- **Verdict:** ADOPT
- **Failed at:** —
- **Consequence for product terminology:** none, beyond making the term explicit as an epistemic one rather than leaving it to be read as an ordinary type name.

### Candidate — `Noema`

- **Proposed boundary:** proposed for the propositional content of a claim — what `Assertion` at `src/nous_os/canonical.py:130` says, with its identity and its standing deliberately excluded.
- **Evidence the boundary exists:** the boundary is real and load-bearing. Content is separated from identity and from lifecycle standing on purpose, so that minting a new identifier for the same claim does not read as an edit, and so that promoting a record does not read as changing what it says. Two other modules compare content digests to decide identity conflicts.
- **Intended meaning:** in Husserl, the noema is the intentional object *as meant* — the objective correlate of an act of consciousness. Its defining commitment is that it is always the noema *of* an act; the pair is inseparable. Both major readings of the term disagree about much and agree about that.
- **Why the mapping is accurate or inaccurate:** inaccurate on the term's own central commitment. There is no act of knowing anywhere in this system. It records *when* it learned something and deliberately not how or by whom; origin is a closed label precisely because the act cannot be recovered. Content here is a function of bytes alone. Calling it a noema would tell a reader the system stores meanings-as-they-appeared-to-someone, when it stores claims-with-cited-bytes — the exact misreading that citations exist to prevent.
- **Structural change required:** yes. There is no type to carry the name — the content is returned as a plain mapping — so adoption would create immediate pressure to introduce one and route the digest comparisons through it. That is restructuring to fit a name.
- **Verdict:** REJECT
- **Failed at:** C2
- **Consequence for product terminology:** none. The product keeps saying assertion, content, and content digest.

### Candidate — `Synesis`

- **Proposed boundary:** proposed not for a symbol but for a stance the code takes repeatedly — *judge and report; do not command*. Tested against conflict reporting at `src/nous_os/temporal.py:108`, promotion at `src/nous_os/adjudication.py:147`, link acceptance at `src/nous_os/discovery.py:216`, and omission policy at `src/nous_os/projection.py:448`.
- **Evidence the boundary exists:** the stance is real and recurs in the four places named above, each stating it independently in its own words. What does not exist is a boundary object. No type, no protocol, no shared base, no module gathers them. The recurrence is discoverable only by reading four separate docstrings.
- **Intended meaning:** in Aristotle, synesis is the virtue of judging well what another says about practical matters, expressly contrasted with the prescriptive virtue that commands. Separately, and unhelpfully, "synesis" is an established grammatical term for agreement by sense rather than by form — which is the meaning a reader finds first.
- **Why the mapping is accurate or inaccurate:** inaccurate for two independent reasons. First, the four sites are not the same act: conflict reporting *withholds* judgement and refuses to rank, while promotion *records someone else's* judgement and writes no content of its own. One term over both would say they are the same thing. Second, and worse, naming the adjudication layer for a judging faculty would claim the *system* possesses one — when that module exists precisely to establish that it does not, and that the judgement is always a person's.
- **Structural change required:** yes. Making the term resolve to anything requires the four sites to become a family that has no independent engineering reason to exist.
- **Verdict:** REJECT
- **Failed at:** C1
- **Consequence for product terminology:** none. The commitment stays stated where it is enforced, which is also where a reader who needs it will be standing.

### Candidate — `Mneme`

- **Proposed boundary:** proposed for the append-only durable-trace family: `Ledger` at `src/nous_os/ledger.py:161`, `SnapshotStore` at `src/nous_os/snapshots.py:67`, `CandidateStore` at `src/nous_os/candidates.py:91`, `RejectionMemory` at `src/nous_os/adjudication.py:249`, `AgentMemory` at `src/nous_os/adjudication.py:313`, and `BridgeRegistry` at `src/nous_os/discovery.py:347`.
- **Evidence the boundary exists:** the shape is real and is the best-evidenced of the candidates. All six are append-only and each is explicit in its own docstring about what authority it does and does not have. **One earlier claim is withdrawn:** they are not all read back in file order. The snapshot store returns its contents *sorted*, and says why — it records no time, so an order taken from the filesystem would be an accident presented as a fact. That is the same discipline this document argues for everywhere else, and it makes the family less uniform than the draft claimed.
- **Intended meaning:** Greek *mneme*, memory as retention — a state, the persisting trace of something past, classically distinguished from the active search that recovers it. The variant spelling sometimes floated is not a Greek noun at all but a back-formation from an adjectival stem.
- **Why the mapping is accurate or inaccurate:** inaccurate, on the one distinction the system cannot afford to blur. The six stores are **not the same kind of thing**: two hold the files canon is made of, two others explicitly hold material with no route to canon at all, and the rest are records *about* those boundaries. **An earlier draft put the first pair more strongly — that those files simply *are* canon — which is the very claim the `canon` record above disowns as an overreach.** It is withdrawn here too: a store neutral about standing is not a standing. What remains, and is sufficient, is that the six differ in their relation to authority. A single word across all six says they share a standing they do not share, and what has authority versus what does not is the load-bearing distinction in the whole design. Two further objections stand on their own: the code already uses "memory" as a narrower technical name, so elevating a memory-word gives it two scopes at once; and "memory" currently connotes machine memory that shapes future behaviour, which is exactly the connotation one of these classes was built to refuse.
- **Structural change required:** no, and an earlier draft said yes on a bad argument. It reasoned that "for the term to name a family, the family must be one" — a shared protocol or base that does not exist. **That test is not the one this document uses.** `canon` is granted a level-spanning mapping over terms that share no protocol either; inventing `level-spanning` was precisely a way of saying a register may name across levels without a type to hang the name on. Refusing `Mneme` a shape granted to `canon` would be an inconsistency, so the structural objection is withdrawn. **The verdict does not change**, because it never depended on that argument: the accuracy objection above is sufficient on its own, and it is where the rejection actually rests.
- **Verdict:** REJECT
- **Failed at:** C2
- **Consequence for product terminology:** none. Ledger, snapshot store, candidate store, registry and rejection memory each already say what their object is, and none invites a reader to think a store has authority it lacks.

### Candidate — `Anamnesis`

- **Proposed boundary:** proposed for the retrieval stage, kept separate from compilation — search at `src/nous_os/derived.py:117` feeding a pack assembled at `src/nous_os/compile.py:275`.
- **Evidence the boundary exists:** the separation is real and is enforced by the signature rather than by convention: compilation is handed a ranking and has no way to reach a store, so it cannot perform retrieval even by accident.
- **Intended meaning:** two established senses that differ sharply. In Plato, recollection of knowledge the soul possessed before birth, with a full metaphysics attached. In Aristotle, the active search that recovers a retained impression, by contrast with passive retention. A third, liturgical sense is unrelated to both.
- **Why the mapping is accurate or inaccurate:** inaccurate on the first sense and redundant on the second. NousOS retrieves documents the user actually ingested, whose bytes are stored under their own hash; nothing is innate, and the Platonic claim is flatly false of the system. On the Aristotelian sense the mapping is fair — but "retrieval" and "search" are already exact, already universally understood, and already the words the code and the README use. Adopting a term that needs a footnote disambiguating three senses in order to say "search" is a strict loss. It is also worth recording *why* this candidate arose: only as the natural pair to `Mneme`. A term whose support is symmetry with a rejected term has no support.
- **Structural change required:** no. It would sit as a label over a split that already exists, and criterion 3 would pass. Criterion 2 fails, and one failure is enough.
- **Verdict:** REJECT
- **Failed at:** C2
- **Consequence for product terminology:** none. Retrieval, compilation and reasoning remain the three stage names.

### Candidate — `Epoche`

- **Proposed boundary:** **two were tested.** First the third answer — `UNKNOWN` and `UNDETERMINED` across `src/nous_os/canonical.py:73`, `src/nous_os/discovery.py:63`, `src/nous_os/temporal.py:86` and `src/nous_os/projection.py:78`. Then, after an independent reviewer pointed out that the first was the wrong place to look, `Verdict.DEFER` at `src/nous_os/adjudication.py:47` — a person deliberately declining to decide — which is much the better fit and which an earlier draft never considered.
- **Evidence the boundary exists:** it is one of the system's stated principles and it is enforced everywhere, in two spellings across six enumerations — `UNKNOWN` in `KeyOrigin`, `SupportClass` and `GateOutcome` (`src/nous_os/canonical.py:73`), `UNDETERMINED` in `TemporalDisposition`, `BridgeDisposition` and `Overlap` (`src/nous_os/temporal.py:86`) — and the principle is stated plainly: a check that did not run is never recorded as one that passed, and an absent measurement is never reported as zero.
- **Intended meaning:** in the sceptics and later in Husserl, epoche is the deliberate *suspension of judgement* — an act the enquirer performs, setting a question aside.
- **Why the mapping is accurate or inaccurate:** **against the third answer, inaccurate in a way that inverts the meaning.** Epoche is something a knower *does*; the third answer is something the *evidence* fails to do. `UNDETERMINED` does not mean the system chose not to decide — it means the available validity bounds establish nothing. Naming it for an act of withholding would attribute a decision to a system that made none. And the accurate phrasing is already published, in plain English, in the README: unknown is a third answer. **Against `DEFER`, the objection is different and narrower.** Here there genuinely is a knower, the act genuinely is a suspension, and it is deliberate — the enum's own docstring insists deferral is an outcome and never latent permission, which is exactly epoche's character. The boundary is real, stable, and adopting a label for it would move nothing. It fails on accuracy all the same, and **the reason offered in an earlier draft was the wrong one and is withdrawn.** That draft rejected it for carrying two live senses of which only one fits. An independent reviewer pointed out that the same objection applies to `canon` — which is adopted while conceding a second reading that is false of the system — and that this document's own procedure forbids carrying a candidate past a failure to look for a rescue. Applied evenly, an ambiguity test either clears both or fails both, so it cannot be what decides this one. **What decides it is the test that already rejected `Krisis` and `Anamnesis`:** `defer` is an exact, universally understood English word for this act. A Greek term that needs a sentence disambiguating two traditions before it can be used adds a lookup rather than precision, and a name whose accuracy depends on the reader knowing which tradition was meant is not accurate for the audience. Three rows now turn on that one test, consistently. **This is the most contested row in the document and it is recorded as one.** Two independent reviews, on two separate passes, argued that `DEFER` satisfies all three published criteria and that the term should have been adopted or explicitly refused. A third, taking the strongest available case for adopting something, examined this same rejection and concluded that no term should be adopted. The reviewers were right that the boundary was never tested — that is repaired above — and right that the first stated reason was inconsistently applied — that is withdrawn above. **The verdict is unchanged and the reason is now the redundancy test, applied identically to three rows.** A later reader who thinks a Greek term earns its lookup here has the whole case, including the objections, without having to reconstruct it.
- **Structural change required:** no, but the question does not arise once criterion 2 fails.
- **Verdict:** REJECT
- **Failed at:** C2
- **Consequence for product terminology:** none. One observation is carried forward as ordinary technical work rather than as a naming decision: the third answer is spelled two ways, `UNKNOWN` and `UNDETERMINED`, with no stated rule distinguishing them. That is a technical naming defect, recorded below.

### Candidate — `Krisis`

- **Proposed boundary:** proposed for the promotion transition — the moment a proposal becomes canon, at `src/nous_os/adjudication.py:108` and `src/nous_os/adjudication.py:147`.
- **Evidence the boundary exists:** it is the single most deliberately-built boundary in the system: a distinct decision object, a distinct record, and a separation such that the recording path cannot write canonical content.
- **Intended meaning:** Greek *krisis*, from the verb to separate or decide — a decisive moment of separation. Etymologically it is near-exact for what happens here.
- **Why the mapping is accurate or inaccurate:** accurate in etymology and redundant in practice. The transition is already named, three times, by words that carry no ambiguity: promotion, the promotion record, and the promotability test. The modern English "crisis" has drifted far enough from the Greek that the term would mislead more readers than it would inform, and a name whose accuracy depends on the reader knowing the etymology is not accurate for the audience. This candidate came closest to a deferral and is rejected on a stated reason rather than a shrug.
- **Structural change required:** no.
- **Verdict:** REJECT
- **Failed at:** C2
- **Consequence for product terminology:** none.

### Candidate — `Doxa`

- **Proposed boundary:** none found. Proposed as one half of the classical belief/knowledge distinction, and tested against three slots that might have carried it: `SupportClass` at `src/nous_os/canonical.py:56`, `EpistemicClass` at `src/nous_os/discovery.py:79`, and `Depth` at `src/nous_os/discovery.py:66`.
- **Evidence the boundary exists:** it does not. Each of the three slots was read and each turned out to measure something else. Support class says how a span backs a claim. Epistemic class says how a statement stands to its endpoints. Depth says how a link is described. None of them grades how *justified* a belief is, and nothing else does either.
- **Intended meaning:** doxa is opinion or belief, classically contrasted with episteme, knowledge — a distinction that grades a believer's justification.
- **Why the mapping is accurate or inaccurate:** there is nothing to be accurate about, and that is the finding. NousOS implements no justification axis at all. This is the same commitment it makes by refusing numeric confidence: the system records *what kind* of support exists and declines to say how much. Recording no-mapping here is a positive statement about the design, not a gap in this document.
- **Structural change required:** yes, and disqualifyingly — adopting the term would mean building the axis it names.
- **Verdict:** NO-MAPPING
- **Failed at:** C1
- **Consequence for product terminology:** none, except that this row is the one to point at when someone asks why there is no confidence score.

<!-- /vocabulary:candidates -->

---

## Primitives deliberately left technical

Every term below is a real boundary with **no epistemic name of its own**, and that is the intended
end state. The most common reason is the best one: **the existing English is already exact**, and a
specialised term would trade clarity for atmosphere. Nothing appears both here and in the epistemic
mapping above; a term is in one register or the other, and the build refuses a term in both.

<!-- vocabulary:left-technical -->

| Term | Why no epistemic term is accurate enough |
|---|---|
| `SupportClass` | Names how a span backs a claim. Any epistemic term for it would imply a strength ordering the members deliberately do not have. |
| `KeyOrigin` | Names a provenance fact about a key, not a knowledge relation. |
| `Verdict` | Already names a person's decision in the plainest possible word. |
| `Tier` | Four kinds of authority without rank. Every candidate word for authority implies a ladder. |
| `IngestStatus` | An operational fact about a file read, with no epistemic content. |
| `Gate` · `GateOutcome` · `GateVector` | A rubric and its results. The word "rubric" is already the accurate one and is not epistemic. |
| `Depth` | Explicitly a description, not a rank. An epistemic term would reintroduce the ordering the label refuses. |
| `TrivialityArchetype` | Four named ways of being true and worthless. Precisely technical; nothing in the epistemic register is this specific. |
| `RoundStatus` · `RunStatus` · `Outcome` | Facts about whether something executed. Not knowledge claims. |
| `Overlap` · `TemporalDisposition` | Answers about intervals. "Time" is not an epistemic register. |
| `QuarantineReason` | Four named attack shapes. A security vocabulary, correctly kept separate. |
| `VisualStateValidationRule` | Names eight ways a saved view can be malformed. A validation vocabulary, about well-formedness rather than about knowledge. |
| `NodeKind` · `EdgeKind` · `Side` | The graph vocabulary. Node and edge are exact, universal, and carry no meaning they should not. |
| `BridgeDisposition` | What a whole rubric vector amounts to. Naming it epistemically would invite reading it as a confidence. |
| `PolicyId` · `ProjectionPolicy` | An omission policy. See the note below on what its two members are called. |
| `Citation` · `Locator` | Already the standard words, in law, scholarship and software alike. `Assertion` sat here in an earlier draft while also being mapped by `canon`; a term cannot be both, and being mapped is the stronger statement. |
| `Snapshot` · `SnapshotStore` · `Ledger` · `LedgerEntry` | Storage facts. Deliberately mundane, because they are the substrate rather than the meaning. |
| `Proposal` · `CandidateStore` | "Candidate" and "proposal" already say the thing has no standing. |
| `HumanDecision` · `PromotionRecord` | The plainest available words for the most important act in the system. |
| `Rejection` · `RejectionMemory` | Says exactly what it holds. |
| `AgentMemory` | Named narrowly on purpose; a wider word would suggest a wider power. |
| `Grant` | An authority record. Ordinary and exact. |
| `UntrustedText` | A trust boundary, not a knowledge relation. |
| `ClaimKey` · `AsOf` · `TemporalIndex` | Identity and time. Mechanical, and better for it. |
| `Conflict` | Already the right word for a substantive disagreement kept visible. |
| `BridgeCard` · `Endpoint` · `BridgeRegistry` | A proposed link and its record. See the note below on the word "bridge". |
| `Chunk` · `SearchHit` · `CohesionStrategy` | Retrieval mechanics. |
| `InclusionManifest` · `Pack` | What went in, and what was assembled. Both are records, not claims. |
| `AliasTable` · `AttributedKey` · `DataRoot` | Configuration and naming machinery. |
| `KnowledgeState` | The one place a knowledge word is already the technical word; nothing is added by a second. |
| `TemporalQuestion` · `ProjectionNode` · `ProjectionEdge` · `ProjectionIR` · `SCHEMA_VERSION` | The renderer-independent graph. Kept deliberately neutral so that no drawing technology can colonise the domain vocabulary. |
| `VisualRole` · `RenderedState` · `Semantic` · `VisualGraph` · `EngineGraph` · `EngineAccessTrace` · `Coordinates` · `LayoutAnchors` | The visual boundary. These describe what may be *seen*, never what is *known*, and blurring that is the specific risk this whole document exists to avoid. |
| `Morphology` · `Organization` · `LodBand` · `Palette` · `Temperature` · `Theme` | Presentation axes. They admit no element and assign no meaning; giving any of them an epistemic name would be the plainest possible category error. They do order things *visually* — a morphology scales a node by how connected it is — but that ordering is structural, computed from the graph's own shape, and it is never an ordering of standing or of belief. |

<!-- /vocabulary:left-technical -->

---

## The two projection policies, and what they are called

A projection is produced under a policy that decides **what is left out**. There are two:

- **Reliability** — admits sources, subjects, assertions and conflicts, and only claims whose
  validity is established.
- **Discovery** — admits everything: all seven node kinds, all temporal answers including
  undetermined, all rubric dispositions, and all three epistemic classes.

**These are internal identifiers today.** The code says so where it declares them, and no
user-facing surface exists in this repository — there is an adapter, an engine and a renderer, and
no view that shows either word to a person. What follows is therefore a **recommendation for the
label to use if and when such a surface exists**, not a report of a decision already made in code.

The recommendation is to keep both words. Two things are worth saying plainly, because the names
slightly overstate what the code does.

**The difference between them is omission, not interpretation.** The policy type says so itself:
it cannot change what anything means or what time answers. Discovery does not find anything that
Reliability hides — it declines to hide it. The same underlying state produces both, and one is
re-derivable from the other.

**"Reliability" does not mean the omitted material is unreliable.** A speculative link is *typed*
as speculative; an undetermined interval is *typed* as undetermined. Nothing is discarded as
untrustworthy. The narrower view is narrower, not truer.

**Alternatives were considered and lose on the same ground.** A more literal pair — naming the
narrow view for what it admits and the wide one for admitting everything — describes the mechanism
more exactly, and an independent reviewer argued for exactly that. It is rejected because a
user-facing word that differs from the identifier in the code creates two vocabularies for one
concept, and five of the defects recorded below are exactly that shape — a concept named one way
in one place and another way in another;
adding a sixteenth deliberately, to gain precision that two sentences of prose supply for free, is
the wrong trade. **The reviewer's objection stands recorded rather than resolved:** the names do
overstate, keeping them is a judgement, and the argument for changing them is written down here so
that a future reader can weigh it instead of having to rediscover it.

---

## Names that are not truthful today

These are real defects found while assembling the register. **None is repaired here**, and the
honest reason is narrower than the one first written down. It is not that every repair would be
structural — several would not be. Making two version strings check each other adds a test and
renames nothing; centralising one duplicated message is ordinary housekeeping. Others genuinely are
structural: separating the coordinate spaces, or splitting a name that covers two objects, changes
types that other code depends on. Two of the fifteen are not renames at all — they are a vocabulary
that needs a distinction added, and a type whose members are declared but only one of which is
ever tested for.

**The reason that covers all fifteen is that a repair is a code change, and a code change belongs
in a revision reviewed as a code change.** This one is reviewed as a document. Folding renames into
it would mean shipping source edits under a review that examined prose, which is how unrelated
changes ride along unnoticed — and doing it while invoking a rule against restructuring would be
worse than doing it plainly. They are recorded so the next change to touch each area does not have
to rediscover them.

<!-- vocabulary:untruthful -->

| # | The defect | Where |
|---|---|---|
| 1 | `Verdict` names two unrelated things: a person's promotion decision, and whether a measured strategy beat its baseline. Both are importable under the bare name. | `src/nous_os/adjudication.py:42` and `src/nous_os/ablation.py:220` |
| 2 | One refusal rule — *an identifier names one thing* — is implemented three times under three names, two of them carrying the identical message string. | `src/nous_os/ledger.py:64`, `src/nous_os/temporal.py:43`, `src/nous_os/projection.py:35` |
| 3 | `RunStatus` and `RoundStatus` are the same two-member vocabulary with the same wire values under two names. | `src/nous_os/measure.py:55` and `src/nous_os/discovery.py:96` |
| 4 | "Bridge" covers two unrelated objects: a judged candidate link with citations and a rubric, and a bare measurement fixture with neither. | `src/nous_os/discovery.py:216` and `src/nous_os/ablation.py:40` |
| 5 | "Endpoint" has three meanings: a cited end of a proposed link, a document/anchor pair in a measurement, and a graph edge's source or target. Only the first is an importable symbol; the other two are the word used in prose and in an error message, which is part of why the collision is easy to miss. | `src/nous_os/discovery.py:197`, `src/nous_os/ablation.py:40`, `src/nous_os/projection.py:397` |
| 6 | The third answer is spelled two ways with no rule distinguishing them — `UNKNOWN` in three enumerations, `UNDETERMINED` in three others. No module carries both, so nothing forces a reader to notice the split. | `src/nous_os/canonical.py:73` and `src/nous_os/temporal.py:86` |
| 7 | "Derived" covers four things: the rebuildable index, a key origin, an epistemic class, and an alias derivation. | `src/nous_os/derived.py:117`, `src/nous_os/attribution.py:33`, `src/nous_os/discovery.py:79` |
| 8 | `holder` names two different roles: the party that holds authority, and the party that put material forward and has none. | `src/nous_os/capability.py:171` and `src/nous_os/candidates.py:56` |
| 9 | The same version string is declared twice under two names, on two sides of the language boundary, and nothing checks that they agree. | `src/nous_os/projection.py:28` and `ui/src/engine/version.ts:12` |
| 10 | `MorphologyMaterial` is exported twice with disjoint structure — one a tuning record, one a binding of ids and materials — and one function takes the first and returns the second, so both names meet in a single body. | `ui/src/engine/calibration.ts:3` and `ui/src/engine/morphology.ts:76` |
| 11 | `Coordinates` is documented as implying no screen coordinate system and is then used for three distinct spaces, with nothing in the type distinguishing them. | `ui/src/engine/contract.ts:32` |
| 12 | Two Python enumerations, `NodeKind` and `EdgeKind`, become one TypeScript union and are then re-split internally — so the same partition is expressed three times. | `src/nous_os/projection.py:43` and `ui/src/engine/contract.ts:179` |
| 13 | `PolicyId.EXPERIMENTAL` has no constructed policy beside the two the product ships, so a reader meeting the vocabulary cannot tell which members name a shipped view and which name an open category. An earlier version of this row said it "names a policy that does not exist", which is false — a policy carrying it constructs fine, tests build several, and a cross-language guard keys on it to refuse experimental payloads from re-derivation. The defect is the missing distinction, not a missing referent. | `src/nous_os/projection.py:94` |
| 14 | `LifecycleState` declares three states and the package only ever tests for one. `CANONICAL` is named twice, both times to refuse everything else; `CANDIDATE` and `REJECTED` appear in the declaration and in tests and nowhere else, because proposals and rejections are carried by their own types. The vocabulary is right and its usage is one-sided, so a reader inferring three handled cases from three members would be wrong. **This row exists because a reviewer applied row 13's standard to a type this document adopts a name over, and the standard held.** It does not unmake that adoption — what `canon` names is the distinction the type draws, and a type that names both sides to refuse one is still where the line is drawn — but a standard that only bites where it is convenient is not a standard. | `src/nous_os/canonical.py:42` |
| 15 | `RELIABILITY` names an axis its policy does not measure. What it actually admits is claims whose validity bounds are *established* for the moment asked about; a fully-cited, directly-quoted claim with no recorded bounds is excluded as undetermined. That is a different property from reliability, and the name asserts the stronger one. | `src/nous_os/projection.py:488` |

<!-- /vocabulary:untruthful -->

---

## Known defects in the layers below

Two defects were found in the rendering layer while assembling this document. **Neither is repaired
here**, for the reason given in the previous section: a repair is a code change and belongs in a
revision reviewed as one. They are published because two arguments above depend on them, and a
document that points at a record which does not exist is doing the thing this one exists to stop.

**A bridge's two governed states are averaged into one visual value, and nine combinations become
five.** A bridge element carries a disposition and an epistemic class at once. The renderer takes
the arithmetic mean of their two lightness offsets. With the shipping offsets — `-24 / -20 / -16`
for the dispositions and `-12 / -8 / -4` for the epistemic classes — the nine legal combinations
land on five distinct values:

    -18   accepted+explicit
    -16   accepted+derived      rejected+explicit
    -14   accepted+speculative  rejected+derived      undetermined+explicit
    -12   rejected+speculative  undetermined+derived
    -10   undetermined+speculative

Two elements in genuinely different semantic states are then **byte-identical on screen**, at every
zoom level, palette and theme. This is not a rounding artefact and it is not palette-dependent; it
is what taking a mean of two independent axes does.

**The check that should catch it samples three combinations that cannot collide with each other.** A rendering
criterion asserts pairwise separation over the legal state domains and enumerates six: the three
temporal states, plus three bridge combinations. Those three are `accepted+explicit`,
`rejected+derived` and `undetermined+speculative` — precisely the diagonal, whose values are `-18`,
`-14` and `-10`, the three most widely separated of the five. **Every colliding pair is outside the
sample.** The criterion is not wrong about what it measures; it measures a subspace in which the
property holds, and reports it as coverage of every legal domain.

**Why they are published here rather than only fixed later.** The first is cited above as the reason
one adopted term's evidence is qualified. The second is the more general lesson and it is the same
one that produced this document's own checks: a measurement that samples where a property holds is
worse than no measurement, because it is believed.

---

## The register this project does not use

<!-- vocabulary:excluded -->

NousOS is built to a deliberately high visual standard, and there is a standing temptation to
borrow the vocabulary of a separate, more metaphorical visual project. That vocabulary is
excluded here as a matter of design, not taste: importing a metaphor imports its commitments, and
this system's commitments are supposed to come from its own structure.

Specifically excluded as sources of NousOS meaning: mycelium and tree metaphors used as
*ontology*, symbolic lenses, multidimensional symbolic semantics, and any interpretive layer that
assigns meaning to elements from outside. Evidence and mechanism may travel outward from this
project; metaphors do not travel inward.

One name needs care, because the exclusion above and the code below can look like a
contradiction. `Morphology` at `ui/src/engine/morphology.ts:8` has a member spelled `mycelium`.
It is a **material treatment** — how a line tapers, how light falls off, whether an edge reads as
fused or separate. It admits no element and assigns no meaning.

**What is actually true, stated precisely, because two earlier drafts of this paragraph each
claimed more than the code delivers.** A morphology cannot add, drop or rewire an element — it maps
over the graph's own node and edge arrays and copies the incidence across verbatim, so the property
holds **by construction**. A binding check that pins identifiers and incidence also exists and does
refuse a rewiring, but it is called only from tests: **nothing on the production path invokes it**,
so it is a proof of the property rather than a guard on it, and the first correction of this
paragraph misattributed the guarantee to it. What is *not* covered either way: the material record
carries a copy of each edge's `kind`, and nothing compares that copy against the graph. So the
accurate form is that a morphology cannot change an element's **identity or its connections**, and
that this is structural rather than guarded.

**What is NOT enforced, and the earlier draft said it was.** A digest is taken over identifiers,
kinds, endpoints and semantic attributes, and it is identical across every morphology — but it is
computed over the graph *going in*, and a morphology produces a separate material record that no
digest is taken over. The invariance therefore holds for any morphology whatsoever and
distinguishes nothing. It is a true statement that proves less than it appears to.

So the honest form of the argument is narrower than the one first written here. A morphology
cannot change an element's identity or its connections. Whether a morphology preserves how well a
governed state can be *told apart on screen* is a separate property, it is **not** checked, and it
does not hold — see *Known defects in the layers below*, in this document, where the failure is
described with its cause rather than gestured at.

The conclusion survives the correction: the excluded thing is an interpretive layer that assigns
meaning to elements, and none exists here. **It rests on the shape of the code that applies a
morphology** — which cannot add, drop or rewire an element because it maps over the graph's own
arrays — and not on either of the two checks this section has had to correct itself about.

The same reasoning was applied to `Organization` at `ui/src/engine/organization.ts:7`, whose
`indra` member is a layout arrangement — one level of grouping, world-space, with no recursion
and no symbolic content. It was designed and verified as geometry — a claim about how it was built, which a reader of this
repository can no more check than the one about this document's own ordering, and which is flagged
here for the same reason.

The canonical layer contains none of this vocabulary, and **five literal terms of it are checked**
against that layer on every build. The paragraph above excludes a wider class than five literals can
express — a metaphor used as ontology is a shape, not a word — so the check is a floor and not a
proof, and the checker's own limitations list says so.

<!-- /vocabulary:excluded -->

---

## What this document does not claim

It does not claim to be complete over every symbol in the codebase — several hundred boundaries
exist, and a register of all of them would be a worse document, not a better one. The closed
vocabularies are covered totally and that coverage is enforced; the record types are covered as
judged, and the omissions are stated.

It does not claim the mappings are facts. They are judgements, marked as such in every row.

It does not claim the names it declines to change are good. Fifteen of them are recorded above as
not truthful, and they stay that way until someone changes the code — which is the correct order,
because a name that requires restructuring is a name this project does not adopt.
