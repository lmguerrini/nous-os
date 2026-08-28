# Three renderers, one semantic state

This records what the implementation **demonstrated**. It does not pick a winner, and where the
evidence cannot support a comparison it says so instead of estimating one.

Three renderers draw the same graph:

- **Sigma 2D** — the existing renderer, a general-purpose graph library over WebGL.
- **Three 2D** — an orthographic camera on a Three.js / React Three Fiber engine.
- **Three 3D** — a perspective camera on the same engine, the same scene, the same state.

**The two Three cameras** consume one shared, renderer-neutral scene model, and neither computes a
visual value of its own; a check over their own source refuses literal colours, literal material
assignments, and imports of the modules that would let them resolve visual policy themselves.

**Sigma does not.** It builds its own render model and resolves its own tokens, morphology, layout and
material — as it always has — and imports exactly one thing from the shared layer: the governed-state
composition, so that the repair to that composition reaches it from one place rather than being copied
into two. Rewiring it further is outside this capability's scope: its output is a closed, audited
artifact of the previous capability whose pixels may not move.

**This is stated here and not only among the limitations, because it changes what every parity claim
below means.** Parity between the two Three cameras is agreement between two presentations of one
shared resolution. Parity with Sigma is agreement between **two independent resolutions** of the same
semantic state. The second is the weaker guarantee and by far the more interesting result.

## What is shared, and what is not

    Projection IR
      -> adapter                 semantic mapping, unchanged
      -> VisualGraph/VisualState the frozen contract, consumed unchanged
      -> scene model             every material, geometry, label and interaction value, resolved ONCE
           |-- Sigma             translates; inherits the governed-state composition
           |-- Three             translates; orthographic and perspective, one scene each

**Shared and measured to be shared.** Layout cost and scene-model build cost were measured
independently per renderer and came out **equal within noise for both stages**. The architecture
claims those stages are common; the numbers say so without being asked to, and they are read from
`ui/dist/evidence/performance.json` rather than transcribed here.

**Legitimately different, and pinned as such.** Only the camera kind and the camera's navigation
values may differ between the two projections. That allowance is enumerated leaf by leaf rather than
admitted by prefix, is asserted non-empty, and any channel that begins to differ without being added
to the list fails the run. An orthographic camera pans and zooms; a perspective camera orbits,
dollies and pans; the two axes genuinely share no vocabulary.

**Declared, and not derived from anything semantic.** Depth in the perspective view is layout only.
No governed state, element kind, interaction or provenance value may reach a `z` coordinate or a
depth-derived channel, and a control over the renderer's source enforces it.

## Semantic parity — measured

Every required check passes with thresholds untouched. The count is recorded in `parity.json` rather than transcribed here, because it rose when a duplicate record was found to be masking one renderer's evidence.

| check | renderers | result |
|---|---|---|
| rendered ids, relation ids, endpoint incidence | all three | equal |
| resolved scene channels across the two cameras | Three 2D, Three 3D | equal outside the pinned camera allowance |
| the twelve legal governed states, separated at the composited pixel | all three | separated |
| selection and focus reaching pixels; provenance carrying a real origin | all three | yes |
| drawing and picking agreeing, and the two 2D renderers picking alike | all three | yes |
| camera switch moving no world anchor and running no layout pass | Three | yes |
| bit-identical captures across two purged runs | all three | yes |
| every governed distinction surviving monochrome and three colour-vision transforms | all three | yes |
| the full application walk through both cameras | Three 2D, Three 3D | yes |

Every measurement reads the **mounted** renderer or the **composited pixel**. None reads the model
that fed it — a comparison between a model and itself proves nothing, and this project has shipped
that defect once already.

The governed-state check takes the **whole derived cross-product** rather than a sample. That matters
more than it sounds: the governed fixture contains exactly three bridge states, and they are exactly
the three that cannot collide with each other. **No fixture-based check could have caught the defect
this criterion exists to catch**, however carefully written.

## Performance — what was measured, and what could not be

**Every figure below is software-rasterised and is not GPU performance.** The measurement runs under
a software rasteriser so that captures stay deterministic; a GPU would produce different numbers and
the two must never be pooled.

**The measured figures are not reproduced here.** Three drafts of this document quoted per-renderer
medians and all three went stale within hours — a small-sample median moves between runs, and a
document that transcribes one is wrong by the next. The numbers live in
`ui/dist/evidence/performance.json`, bound to the tree that produced them, and what follows is only
what the measurements actually support:

- **Frame time does not differentiate the three renderers.** All three sit at the frame interval,
  which means all three are frame-limited rather than compute-limited at this size. **No claim should
  be built on that row**, and none is.
- **The Three engine mounts about twice as fast as Sigma.** Measured once per renderer per run: the
  ratio has held across every run observed, the absolute milliseconds have not, and only the ratio is
  claimed here. The figures themselves are in `performance.json`.
- **Layout cost and scene-model build cost are equal across the three within noise.** That is the
  architecture confirming itself — those stages are shared, and the numbers say so without being
  asked to.
- **Picking is sub-millisecond in all three**, and camera switching costs about one frame.
- **Memory is recorded for all three**; the Sigma renderer's own retained-resource count is `UNKNOWN`
  because its graphics resources are owned inside the library and are not enumerable from outside it.

### The scale wall, and whose it is

**At 1,000 and 10,000 elements, every renderer recorded `NOT_RUN`** against a two-minute
per-combination budget — Sigma included, and Sigma is the mature one.

The cause was then measured **outside the browser entirely**, with no canvas, no renderer and no
DOM, so that the answer could not be attributed to one of the three. That measurement is its own
committed producer and its own artifact — `npm --prefix ui run evidence:layout-scale`, written to
`ui/dist/evidence/layout-scale.json` and bound to the tree that produced it. At the small fixture the
shared layout is trivial. At the larger one it **alone exceeds the per-combination budget the browser
suite gives an entire renderer**, before any renderer has been asked to draw anything.

The figures are in the artifact rather than here, and that is not fastidiousness: three drafts of
this document quoted layout and mount timings, and all three were wrong within hours. A check now
refuses any timing figure written into this file.

**The wall is the renderer-independent force-directed layout.** So the honest answer to *which
renderer scales better* is that this evidence cannot say: a shared component consumes the budget
before any renderer is exercised. That is a more useful result than a number would have been, and it
locates the work — any future scale effort belongs in layout, not in a renderer.

## Where the two engines actually differ, visually

Judged against the governed art direction by inspecting real captures, not scores.

**The Three engine draws points of light; Sigma draws discs.** Sigma renders a node as a flat disc
with a hard edge and a slight halo. The Three engine renders a small bright core with a soft radial
bloom that scales with topology-derived prominence, so a hub blooms and most nodes stay small points.
That is the single largest visible difference and it is the one the frozen art direction asks for.

**Filaments are continuous rather than stippled.** Sigma's long relations visibly break into dashes at
sub-pixel widths. The Three engine draws expanded quads with analytic distance-field anti-aliasing and
a luminance taper along the span, so a long relation reads as a thread of light. A general-purpose
graph library cannot easily reach this; a custom shader can.

**Sigma remains the default 2D surface.** Nothing here promotes the Three engine over it. The
requirement this capability closes asks for renderer *qualification*, and its own promotion condition
requires evidence of failure or material disadvantage in the primary path. **No such evidence was
produced.**

## What each engine costs

**Sigma** is less code and less risk. The library owns the camera, the picking and the resource
lifecycle, and that is why its handle cannot answer two of the questions the shared interface asks —
it has one camera and cannot enumerate resources it does not own. Those are honest absences, recorded
as capabilities it does not declare rather than as fabricated answers.

**The Three engine** is a little over six thousand lines of source and its own tests together. The
figure grows every time its controls are strengthened — it has moved three times while this document
was being written, and a check now refuses the claim when the command below stops reproducing it — so
it is deliberately given as an order of magnitude and reproduced rather than pinned:

    cat ui/src/render3f/* ui/test/render3f/* | wc -l

It owns everything the library used to: shader compilation, buffer construction, picking, disposal, label placement. That is the
price of the visual freedom above, and it is where every defect in this capability was found — a
blank frame, a displaced shader directive, unsupported qualifiers, a coordinate-space error.

## Stated limitations

- **The perspective view is an oblique view of a PLANAR graph.** Every `z` in a resolved scene is zero
  — the layout writes no depth — so the 3D camera shows the same flat arrangement from an angle rather
  than a spatially distributed structure. This is consistent with the governed decision that depth
  carries no epistemic meaning, and nothing in the contract requires a volumetric layout. It is stated
  here because the next capability's controlled comparison would otherwise be described as 2D versus
  3D when it is in fact orthographic-plane versus oblique-plane, and that distinction changes what
  such a comparison can conclude.
- Every performance figure is software-rasterised; the GPU relationship is unknown, not estimated.
- Above 100 elements no renderer comparison exists, because the shared layout consumes the budget.
- The governed fixture is 22 nodes and 27 relations. Larger figures come from synthetic stress
  material that declares itself synthetic in its own bytes and carries no semantic meaning.
- Selection emphasis was not observable at the small node sizes of the stress fixture for either
  Three camera, where Sigma's was. Selection reaching pixels is separately verified on all three
  against the governed fixture.
- Label collision is resolved in screen space by the renderer, using the scene model's priority
  ordering and its calibrated padding. Selection and priority remain semantic and stay in the scene
  model; placement under a perspective projection cannot be, because the scene model is deliberately
  projection-independent.
- One element of the frozen art direction, a diffraction streak on the brightest nodes, is not
  implemented: its eligibility and magnitude are not on the scene contract, and a renderer may not
  invent them.
