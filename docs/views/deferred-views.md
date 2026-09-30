# Deferred view contracts — D-073

Morphogenesis, Harmonic and Ars Combinatoria remain deferred. This document and `ui/src/projection/deferred.ts` define future-facing contracts only: no projection IDs, registration, solver, renderer, UI, storage, or browser work is added. The interfaces consume the D-073 immutable `SemanticGraphSnapshot`, digest-addressed `AnalyticalDomain`, provenance records, and typed projection architecture where applicable. They do not alter source records or semantic relationships.

## Morphogenesis — future mathematical projection

### Interface and data mapping

`MorphogenesisParameters` declares `seed`, `fieldResolution`, `timeStep`, `steps`, `superformulaVersion: "gielis-v1"`, and bounded Gielis `m`, `n1`, `n2`, `n3`, `a`, `b`. `validateMorphogenesisParameters` returns either the validated parameters or a typed refusal. Bounds are explicit in `MORPHOGENESIS_BOUNDS`: unsigned 32-bit seed; 8–512 cells per field axis; 1–10,000 steps; `m ∈ [0.25,64]`; exponents `n1,n2,n3 ∈ [0.1,20]`; and axis scales `a,b ∈ [0.1,10]`. For an explicit 2D diffusion step on a unit-square grid, `dx=1/(fieldResolution−1)` and the validator requires `0 < timeStep ≤ dx²/4` (the stated CFL bound).

In a future implementation, each real community's disclosed size, density and weighted degree are normalized by a named, versioned mapping to bounded superformula parameters. The community envelope uses

`r(φ) = ( |cos(mφ/4)/a|^n2 + |sin(mφ/4)/b|^n3 )^(−1/n1)`.

Any future reaction-diffusion field must declare initial/boundary conditions and a stability rule, be stored only as derived mathematical field data, and retain a source-community/member explanation. Seeded deterministic evolution is parameter-driven; wall-clock time is not an input. Fields or contours never create branches or semantic edges. The contract currently does not select a concrete reaction-diffusion equation or 3D surface extension.

### Risks

Near-zero or nonpositive exponents can make the superformula singular or unbounded; zero axis denominators are refused. Overlapping envelopes may imply exclusivity or causal growth that the data does not support. An unstable step can diverge, and a seeded result can still be misleading if seed or mapping is undocumented. A volume surface cannot be inferred from a 2D contour without an explicit extension.

### Required future tests

- Known-answer radii for canonical parameter fixtures; finite positive radius around the angular domain and property checks over all accepted bounds.
- Typed refusals for singular exponents, zero scales/denominators, unsupported versions, nonfinite values, invalid sizes and `timeStep > dx²/4`.
- Stability/replay tests at every declared step; same snapshot/domain/parameters give byte-identical field and result digest.
- Exact source-community membership and ledger conservation; no generated branch or field sample appears as a semantic node/edge.
- 2D contours and any separately specified honest 3D mapping, readability, reduced-motion final state, idle scheduling, and measured 172/850-node budgets.

## Harmonic — silent spatial/mathematical view

### Interface and data mapping

`HarmonicParameters` contains `modes` (1–64), `normalization` (`"l2"` or `"max-abs"`), and a zero-based `selectedMode` less than `modes`. The validator returns typed refusals for invalid modes, normalization, or selected mode. The future view reuses the integrated Holographic weighted graph Laplacian, eigenspace policy, eigenbasis and Lanczos/dense reference solvers. It maps real node participation, modal coefficients/sign and original edge couplings into spatial coordinates or field overlays. Any frequency-like quantities or ratios are silent mathematical labels; a displayed ratio must say whether it is measured from a graph quantity or imposed as a visual quantization. The current contract exposes no audio, MIDI, OSC or sonification field/API.

### Risks

Degenerate eigenspaces and eigenvector sign flips can change apparent orientation. Eigenvalue is not an audible frequency or physical resonance. An imposed integer ratio can be mistaken for evidence in the graph, and edge overlays can obscure mode sign or imply biological resonance.

### Required future tests

- Laplacian symmetry, row sums, nonnegative quadratic form, solver residual and eigenbasis orthogonality against the shared Holographic implementation.
- Deterministic eigenspace/projector behavior for repeated eigenvalues, deterministic sign/presentation, and identical results for shuffled input.
- Correct mode and normalization bounds, provenance on every data-derived quantity, and explicit provenance labels for imposed ratios.
- Unchanged source ledger and semantic edge set; 2D/3D spatial readability, reduced motion, idle behavior, and 172/850-node performance.
- Compile-time contract check that Harmonic exposes no audio, MIDI, OSC, or sonification property.

## Ars Combinatoria — separate ephemeral proposal service

### Interface and data mapping

`CombinationProposalService.generate(request)` accepts an immutable snapshot reference, selected source term IDs, register/operator IDs, explicit constraints and a hard result limit. It returns `Hypothesis[]`, each with source term IDs, an operator trace, immutable provenance references and `epistemic: "hypothesis"`. It is deliberately not a `MathematicalProjection` and its hypotheses are never projection results or semantic edges. A future service computes a bounded Cartesian product of selected registers, applies constraints before materializing proposals, and orders outputs deterministically. Generated records are ephemeral and storeless; persistence or export, if later authorized, is a distinct explicit proposal-file operation and cannot update the source graph or canon.

### Risks

Product cardinality can grow rapidly; operators may lose their source trail; a hypothesis can be mistaken for a candidate, attested fact, or relation; and rendering a proposal as an edge can corrupt epistemic meaning. The right future interaction is a register/combination workspace, not a graph-view mode.

### Required future tests

- Refuse or truncate before materialization at the hard cardinality/result limit; deterministic ordering and operator replay under shuffled inputs.
- Every output carries all source term IDs, exact provenance references, complete operator trace and the hypothesis epistemic tag.
- Constraint compliance; source snapshot/ledger/edge bytes unchanged; no store-write path in the service contract.
- Type-level rejection anywhere `MathematicalProjection`, `ProjectionResult`, semantic edge, canonical or attested records are expected.
- Explicit rejection of automatic promotion; if an export is later authorized, verify it writes only the declared proposal format.

## Current implementation boundary

The module defines only parameter types, pure validators and the Ars proposal interface. The four D-073 views remain the only `ProjectionId` members and registered views. The validators and boundary tests in `ui/test/review/deferred-views.test.ts` exercise contract limits and typed separations; they do not claim to implement any of the three algorithms.
