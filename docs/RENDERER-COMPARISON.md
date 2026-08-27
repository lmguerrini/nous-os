# Three renderers, one semantic state

This records what the implementation **demonstrated**. It does not pick a winner, and where the
evidence cannot support a comparison it says so instead of estimating one.

Three renderers draw the same graph:

- **Sigma 2D** — the existing renderer, a general-purpose graph library over WebGL.
- **Three 2D** — an orthographic camera on a Three.js / React Three Fiber engine.
- **Three 3D** — a perspective camera on the same engine, the same scene, the same state.

All three consume one shared, renderer-neutral scene model. Neither Three camera computes a visual
value of its own, and a check over their own source refuses literal colours, literal material
assignments, and imports of the four modules that would let them resolve visual policy themselves.

## What is shared, and what is not

    Projection IR
      -> adapter                 semantic mapping, unchanged
      -> VisualGraph/VisualState the frozen contract, consumed unchanged
      -> scene model             every material, geometry, label and interaction value, resolved ONCE
           |-- Sigma             translates; inherits the governed-state composition
           |-- Three             translates; orthographic and perspective, one scene each

**Shared and measured to be shared.** Layout cost and scene-model build cost were measured
independently per renderer and came out equal within noise — 23.3, 23.7 and 23.5 milliseconds for
layout; 32.1, 33.2 and 32.8 for the scene model. The architecture claims those stages are common;
the numbers say so without being asked to.

**Legitimately different, and pinned as such.** Only the camera kind and the camera's navigation
values may differ between the two projections. That allowance is enumerated leaf by leaf rather than
admitted by prefix, is asserted non-empty, and any channel that begins to differ without being added
to the list fails the run. An orthographic camera pans and zooms; a perspective camera orbits,
dollies and pans; the two axes genuinely share no vocabulary.

**Declared, and not derived from anything semantic.** Depth in the perspective view is layout only.
No governed state, element kind, interaction or provenance value may reach a `z` coordinate or a
depth-derived channel, and a control over the renderer's source enforces it.

## Semantic parity — measured

Twenty-three checks, all passing, thresholds untouched.

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

| at 100 elements | Sigma 2D | Three 2D | Three 3D |
|---|---|---|---|
| frame time, median | 8.3 ms | 8.3 ms | 8.3 ms |
| initial render latency | 868.6 ms | 461.7 ms | 422.4 ms |
| layout cost, median | 23.3 ms | 23.7 ms | 23.5 ms |
| scene model build, median | 32.1 ms | 33.2 ms | 32.8 ms |
| picking latency, median | 0.1 ms | 0.2 ms | 0.1 ms |
| camera switch | one camera | 8.3 ms | 8.1 ms |
| camera transition | not applicable | not applicable | 8.3 ms |

**Frame time does not differentiate the three.** All three sit at the frame interval, which means all
three are frame-limited rather than compute-limited at this size. No claim should be built on that
row.

**The Three engine mounts about twice as fast.** Measured once per renderer, so an observation rather
than a distribution.

### The scale wall, and whose it is

**At 1,000 and 10,000 elements, every renderer recorded `NOT_RUN`** against a two-minute
per-combination budget — Sigma included, and Sigma is the mature one.

The cause was then measured **outside the browser entirely**, with no canvas and no renderer:

    40 nodes, 60 edges     shared layout   56 ms
    358 nodes, 642 edges   shared layout   exceeded 100 s

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

**The Three engine** is roughly 3,300 lines including its tests, and it owns everything the library
used to: shader compilation, buffer construction, picking, disposal, label placement. That is the
price of the visual freedom above, and it is where every defect in this capability was found — a
blank frame, a displaced shader directive, unsupported qualifiers, a coordinate-space error.

## Stated limitations

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
