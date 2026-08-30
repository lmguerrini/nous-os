const PERMILLE = 1000;

/**
 * MotionGrammar is a new axis above the frozen static foundation (Organization -> ScaleTopology ->
 * Morphology -> Projection -> Visual Calibration) and is never collapsed into any of the five: those
 * five answer what a graph is and where it sits, this one answers how it moves. Every function below
 * is a pure function of (policy, phase, element ids) -- no timer, no stored state, no randomness --
 * so the same call always returns byte-identical output. Animation phase is a render input, never
 * governed state, and nothing in this module or `VisualState` persists one.
 */
export type MotionGrammar =
  | "still"
  | "assemble"
  | "pulse"
  | "reconfigure"
  | "condense"
  | "dissolve"
  | "recursive-bloom";

/** This is the resting default: motion is opt-in, and Still leaves every phase's drawing exactly as today's static rendering. */
export const STILL: MotionGrammar = "still";

/** This is staggered per-element construction, complete once every element has entered by its own resting phase. */
export const ASSEMBLE: MotionGrammar = "assemble";

/** This is a small cyclic breathing of scale only, sharing Reconfigure's mechanism at a smaller amplitude: a rhythm, never a change of form. */
export const PULSE: MotionGrammar = "pulse";

/**
 * This is the same cyclic mechanism Pulse uses (`breathingEnvelope`) at a larger amplitude and
 * extended onto a positional offset, because REF-MOTION-001's roughly two-second breathing cycle in
 * the prior art is simultaneously a rhythm and a change of form. Pulse and Reconfigure are
 * implemented here as two amplitudes of one mechanism, not as two independent ones.
 */
export const RECONFIGURE: MotionGrammar = "reconfigure";

/**
 * This is a transient inward convergence: the whole structure draws toward its own centre and back out
 * again, peripheral elements fading and shrinking harder than central ones on the way, and every
 * element fully returns at either end of the phase domain. The pull itself and which elements read as
 * peripheral are both resolved from real, already-drawn geometry -- never from an id -- which is why
 * this axis alone (see `nodeModulation`'s "condense" case) can only declare a uniform, position-blind
 * ceiling on how far that pull and that fade could reach; `#scene/build.ts` is where a real centre and
 * real per-node distance exist to spend that ceiling on.
 */
export const CONDENSE: MotionGrammar = "condense";

/** This is staggered per-element withdrawal, the direct reverse of Assemble's staggered construction and sharing its `staggeredProgress` primitive. */
export const DISSOLVE: MotionGrammar = "dissolve";

/**
 * This is nested, self-similar staggered construction: the same `staggeredProgress` primitive
 * Assemble uses, reapplied within recursively halved phase windows keyed by a generation. REF-MOTION-001
 * found no support for genuine recursion in the prior art it reviewed, only symmetry, and this
 * implementation bears that finding out -- once built, RecursiveBloom's own arithmetic is Assemble's
 * primitive windowed, not a distinct mechanism. It stays a separate, independently reachable member
 * regardless, because the identity-traceability decision this wave answers to requires every candidate
 * state to stay reachable no matter what a later measurement finds; nothing here narrows that
 * reachability on the strength of this finding.
 */
export const RECURSIVE_BLOOM: MotionGrammar = "recursive-bloom";

/** This is the complete closed motion-grammar vocabulary and does not admit an eighth member. */
export const MOTION_GRAMMARS = [STILL, ASSEMBLE, PULSE, RECONFIGURE, CONDENSE, DISSOLVE, RECURSIVE_BLOOM] as const;

/** This is the input keying for one call: every id `motionModulation` may key its output by, and the only ids it may ever key its output by. */
export type MotionElementIds = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

/**
 * This is one node's visual modulation for one phase and does not carry a screen-space position.
 * `convergencePermille` is declared in [0, 1000] and is Condense's own channel alone (every other
 * policy holds it at 0): it names a fraction of this node's own distance from the structure's centre,
 * never a direction or a magnitude in pixels, because this axis is a pure function of (policy, phase,
 * id) with no access to a resolved layout (see this module's own opening docstring). The scene layer
 * (`#scene/build.ts`) is the one place a centre and a real per-node distance exist, so it alone
 * resolves this declared fraction into an actual pull toward its own already-resolved centroid.
 */
export type NodeMotionModulation = {
  readonly id: string;
  readonly opacityPermille: number;
  readonly scalePermille: number;
  readonly offsetXPermille: number;
  readonly offsetYPermille: number;
  readonly convergencePermille: number;
};

/** This is one relation's visual modulation for one phase and does not carry an endpoint. */
export type EdgeMotionModulation = {
  readonly id: string;
  readonly opacityPermille: number;
  readonly revealPermille: number;
};

/** This is the complete result of one call and keys its two lists only by the ids it was given. */
export type MotionModulation = {
  readonly policy: MotionGrammar;
  readonly phase: number;
  readonly nodes: readonly NodeMotionModulation[];
  readonly edges: readonly EdgeMotionModulation[];
};

/** This is the phase at which each policy's own resting state is defined; every one of them is the identity modulation there. */
const RESTING_PHASES: Readonly<Record<MotionGrammar, number>> = {
  still: 0,
  assemble: 1,
  pulse: 0,
  reconfigure: 0,
  condense: 0,
  dissolve: 0,
  "recursive-bloom": 1,
};

/**
 * These two are chosen against a measured readability bound, not against the [0, 1000] declared
 * ceiling those two channels could otherwise reach: at each amplitude's own extreme (an envelope at
 * its own peak magnitude, a max-seed element), Reconfigure's scale channel swings no lower than 0.3x
 * and no higher than 1.7x identity size, and its offset channel displaces a node by at most roughly
 * six tenths of that node's own radius; Pulse, sharing the mechanism at a visibly smaller amplitude,
 * swings no lower than 0.65x and no higher than 1.35x. Measured against six sampled phases of the
 * `discovery-at-question` fixture rendered at 1200x800 (the same method REF-MOTION-001's own finding
 * used): raising these from 60/260 to 350/700 took Pulse's peak changed-pixel fraction from ~0.31% to
 * ~0.81% of the frame and Reconfigure's from ~0.69% to ~1.08%, with the maximum single-channel delta
 * and the mean delta over changed pixels rising alongside rather than merely the area, so the gain is
 * genuinely stronger contrast and not only a wider blur. Amplitudes at or near the declared ceiling
 * were measured and rejected: at 1000 permille (Reconfigure's own contractual maximum) a max-seed
 * element's scale collapses to 0.001x at the envelope's peak -- a node effectively vanishing while its
 * own opacity channel still reports full -- which is exactly the kind of excessive visual effect this
 * capability's own standing finding on softness already found regresses topology readability, so
 * headroom was kept below that ceiling rather than spent.
 */
/**
 * This is exported (unlike every other axis-local amplitude constant below it) because `#scene/build.ts`'s
 * own `resolvePulseGeometry` needs this exact number to recompute Pulse's scale envelope against a
 * per-node, structurally-shifted phase (see that function's own docstring for why phase itself, not
 * amplitude, is what varies by node under the human review disposition's binding rule that even Pulse
 * must breathe structurally rather than blink independently) -- reading it here rather than restating it
 * keeps the one calibrated number in one place.
 */
export const PULSE_AMPLITUDE_PERMILLE = 350;
const RECONFIGURE_AMPLITUDE_PERMILLE = 700;
/**
 * This is Reconfigure's own displacement amplitude, independent of `RECONFIGURE_AMPLITUDE_PERMILLE`
 * above (which still governs Reconfigure's scale swing alone): the two channels used to share one
 * amplitude because the scene layer converted the offset channel's declared [-1000, 1000] permille
 * into pixels by multiplying against the receiving node's own resolved radius (a few px at this
 * scene's own mass range), which kept a shared amplitude's displacement small purely as a side effect
 * of that unrelated per-node quantity, never by design. The scene layer now multiplies against
 * `calibration.layout.idealEdgeLengthPx` instead (see scene/build.ts's own modulateSceneNode), the
 * layout's own governed unit of inter-node spacing, so this amplitude is chosen directly against that
 * reference rather than inherited from the scale channel's own, separately-tuned bound. A max-seed,
 * max-envelope element now moves at most 0.45 of one ideal edge length (54px at the default 120px
 * calibration), well short of a full edge length, so two adjacent nodes moving directly toward each
 * other cannot fully close their own governed spacing; raising this past ~450 was measured and
 * rejected, because the changed-pixel fraction below already saturates near this value (nodes are
 * small relative to the 1200x800 frame, so once a displaced node's own footprint stops overlapping its
 * resting footprint, moving it further adds no further changed frame area, only collision risk).
 * Measured against the phase-frames ablation (`ui/test/browser/motion.spec.ts`, discovery-at-question,
 * stellar/flat/2d): Reconfigure's peak changed-pixel fraction rose from ~1.27% (the prior,
 * radius-coupled offset, effectively inert -- displacement capped at a few px by the receiving node's
 * own radius) to ~2.0%, with every sampled strip's frame-containment invariant
 * (`FRAME_CONTAINMENT_MARGIN_CSS_PX`) still holding.
 */
const RECONFIGURE_OFFSET_AMPLITUDE_PERMILLE = 450;
/**
 * This is Condense's own declared ceiling, spent three ways at the scene layer (`#scene/build.ts`'s own
 * `resolveCondenseGeometry`), and it replaces two former constants this file no longer needs:
 * `CONDENSE_PERIPHERAL_THRESHOLD_PERMILLE`, an id-seeded hash threshold that classified a node as
 * peripheral independent of that node's actual position in the resolved layout, and
 * `CONDENSE_CORE_SHRINK_PERMILLE` (650, migrated unchanged to the scene layer as
 * `CONDENSE_CORE_SHRINK_FLOOR_PERMILLE`), the shrink a core element was given instead of the fade a
 * peripheral one got. A blind evaluator with no access to this code classified the pre-fix Condense as a
 * fade with only "a thin thread" separating it from Dissolve, at low confidence -- correctly, because
 * `nodeModulation`'s condense case never repositioned anything (`offsetXPermille`/`offsetYPermille`
 * stayed zero at every phase) and the fade/shrink split it did declare rested on that same fabricated
 * hash, unrelated to which nodes actually sit toward this structure's own edge.
 *
 * This axis stays pure and position-blind (see this module's own opening docstring), so it cannot itself
 * compute a centre, a real per-node distance, or which nodes are genuinely peripheral -- only the scene
 * layer, already holding every node's resolved anchor, can. What this axis still owns is the one
 * position-blind number every node shares at a given phase: `convergencePermille`, the fraction of its
 * own distance to that centre a node may be pulled at this phase's own envelope, ceilinged here at 200 --
 * a fifth of the distance between a node and the structure's own centre, chosen so the single farthest
 * node on this capability's own phase-frames fixture (discovery-at-question, stellar/indra/3d) moves on
 * the order of 90px at the envelope's own peak without ever needing frame containment margin (an inward
 * pull can only shrink a layout's own extent, never grow it past where the resting frame already fit)
 * and without so crowding the centre that two converged nodes could be mistaken for one; the periphery's
 * own fade already dims exactly the nodes that travel furthest, so the most-displaced nodes are also the
 * least visible by the time they arrive. The same
 * envelope-scaled ceiling doubles as the node-level opacity and scale ceiling every node declares
 * uniformly (as if every node were fully peripheral): the scene layer alone decides, from real distance,
 * how much of that ceiling a given node or relation actually spends.
 *
 * Raised from 200 to 320 under the human review disposition's binding instruction to strengthen
 * Condense's own spatial read rather than its fade: the farthest node on the same phase-frames fixture
 * this constant's own prior value was measured against now moves on the order of 145px at the envelope's
 * own peak (still an inward-only pull, so it can only shrink the resting layout's own extent, never grow
 * past where the resting frame already fit -- the same frame-containment reasoning the prior value relied
 * on holds at any amplitude below the declared 1000-permille ceiling) -- a visibly stronger contraction
 * without approaching the crowding this constant's own prior account warned against.
 */
const CONDENSE_CONVERGENCE_AMPLITUDE_PERMILLE = 320;
/**
 * This is exported so `#scene/build.ts`'s own structural reveal/withdrawal geometry (Assemble, Dissolve,
 * RecursiveBloom) can drive the identical `staggeredProgress` primitive below with a real, governed
 * per-element position in [0, 1] -- BFS hop-distance from a real incidence-degree hub, never an id hash
 * -- in place of the `seedFraction(id)` this axis itself no longer computes for these three policies (see
 * `nodeModulation`'s own cases and CAP-13 finding F79: an id-seeded hash once drove a visible core/
 * periphery gradient that encoded nothing).
 */
export const ASSEMBLE_STAGGER_FRACTION = 0.7;
export const DISSOLVE_STAGGER_FRACTION = 0.7;
export const RECURSIVE_BLOOM_STAGGER_FRACTION = 0.6;
export const RECURSIVE_BLOOM_GENERATIONS = 3;
const RECURSIVE_BLOOM_DECAY = 0.5;

/** This channel's declared range is [0, 1000]; used to derive `NODE_STEP_MAGNITUDE_PERMILLE` and `EDGE_STEP_MAGNITUDE_PERMILLE` below rather than a chosen constant. */
const OPACITY_RANGE_PERMILLE = PERMILLE;
/** This channel's declared range is [0, 2000] -- 0 to double identity size. */
const SCALE_RANGE_PERMILLE = 2 * PERMILLE;
/** This channel's declared range is [-1000, 1000]. */
const OFFSET_RANGE_PERMILLE = 2 * PERMILLE;
/** This channel's declared range is [0, 1000]. */
const REVEAL_RANGE_PERMILLE = PERMILLE;
/** This channel's declared range is [0, 1000] -- see NodeMotionModulation's own convergencePermille doc. */
const CONVERGENCE_RANGE_PERMILLE = PERMILLE;

/** This is the largest possible single-step change in one node's modulation, derived from the declared range of each of its five channels, and is what `motionTraceability` normalises against. */
const NODE_STEP_MAGNITUDE_PERMILLE = OPACITY_RANGE_PERMILLE + SCALE_RANGE_PERMILLE + OFFSET_RANGE_PERMILLE + OFFSET_RANGE_PERMILLE + CONVERGENCE_RANGE_PERMILLE;
/** This is the largest possible single-step change in one relation's modulation, derived the same way. */
const EDGE_STEP_MAGNITUDE_PERMILLE = OPACITY_RANGE_PERMILLE + REVEAL_RANGE_PERMILLE;

/**
 * This is the one entry point the axis exposes: a pure function of (policy, phase, element ids) that
 * fabricates no id and drops none from its keying, because its two output lists are built by mapping
 * directly over the two input lists. Same inputs, byte-identical output, independent of call order.
 */
export function motionModulation(policy: MotionGrammar, phase: number, elementIds: MotionElementIds): MotionModulation {
  assertMotionGrammarMember(policy);
  assertPhase(phase);
  assertUniqueIds(elementIds.nodeIds, "node");
  assertUniqueIds(elementIds.edgeIds, "edge");
  return {
    policy,
    phase,
    nodes: elementIds.nodeIds.map((id) => nodeModulation(policy, phase, id)),
    edges: elementIds.edgeIds.map((id) => edgeModulation(policy, phase, id)),
  };
}

/** This is one policy's declared resting phase and does not itself compute a modulation. */
export function restingPhase(policy: MotionGrammar): number {
  assertMotionGrammarMember(policy);
  return RESTING_PHASES[policy];
}

/** This is the modulation at a policy's own resting phase, which the resting-completeness decision requires be complete for every governed node and relation. */
export function restingModulation(policy: MotionGrammar, elementIds: MotionElementIds): MotionModulation {
  return motionModulation(policy, restingPhase(policy), elementIds);
}

/**
 * This is the ground truth for one policy's own envelope symmetry: whether `phaseA` and `phaseB` are
 * two distinct phases that policy's shared cyclic or converging envelope evaluates to the identical
 * number at, before that number ever reaches a per-element amplitude, direction, or window -- which
 * are all phase-independent, so an envelope tie is exactly the condition under which every governed
 * node and relation renders byte-identically at both phases. Pulse and Reconfigure share
 * `breathingEnvelope`, one full sine cycle across the phase domain, symmetric about both its own
 * quarter points (0.25 and 0.75) as well as tying at every multiple of one half (0, 0.5, 1, all zero);
 * Condense's single-hump `convergenceEnvelope` is symmetric about its own midpoint (0.5) alone. Still
 * is exact identity at every phase by construction, not by envelope tie, so it is deliberately excluded
 * here rather than reported as universally degenerate; Assemble, Dissolve, and RecursiveBloom reduce to
 * `staggeredProgress`, a monotonic ramp with no repeated value across (0, 1) for a fixed element, so
 * they report no ties either. This is what a sampler should consult instead of discovering a duplicate
 * rendered frame by assertion failure, the way an earlier measurement here did at the half-cycle zero
 * crossings and the way the phase pair (0.125, 0.375) would have at the quarter-point mirror.
 */
export function motionPhasesShareEnvelope(policy: MotionGrammar, phaseA: number, phaseB: number): boolean {
  assertMotionGrammarMember(policy);
  assertPhase(phaseA);
  assertPhase(phaseB);
  if (phaseA === phaseB) {
    return false;
  }
  const envelopeA = sharedEnvelopeValue(policy, phaseA);
  const envelopeB = sharedEnvelopeValue(policy, phaseB);
  if (envelopeA === undefined || envelopeB === undefined) {
    return false;
  }
  // Two mathematically equal envelope arguments (e.g. 2*pi*0.125 for one phase and 2*pi*0.375 for its
  // own quarter-point mirror) do not always reach Math.sin as bit-identical floats, so this compares
  // with a tolerance many orders below the smallest difference that could ever change a rendered
  // channel: every formula built on this envelope rounds amplitude*envelope (amplitude at most 1000
  // permille) to the nearest integer permille, so an envelope difference under 0.0005 can never change
  // a rounded output, and ENVELOPE_TIE_EPSILON is far below even that.
  return Math.abs(envelopeA - envelopeB) <= ENVELOPE_TIE_EPSILON;
}

/**
 * This is `motionPhasesShareEnvelope` applied to filter one candidate phase list down to a subset with
 * no two phases tying under this policy's own envelope, first occurrence winning and input order
 * otherwise preserved, so a caller sampling evidence frames can ask for phases up front rather than
 * detect a duplicate after having already rendered one.
 */
export function distinctMotionPhases(policy: MotionGrammar, candidatePhases: readonly number[]): readonly number[] {
  assertMotionGrammarMember(policy);
  const kept: number[] = [];
  for (const phase of candidatePhases) {
    assertPhase(phase);
    if (!kept.some((keptPhase) => motionPhasesShareEnvelope(policy, keptPhase, phase))) {
      kept.push(phase);
    }
  }
  return kept;
}

const ENVELOPE_TIE_EPSILON = 1e-9;

function sharedEnvelopeValue(policy: MotionGrammar, phase: number): number | undefined {
  switch (policy) {
    case "pulse":
    case "reconfigure":
      return breathingEnvelope(phase);
    case "condense":
      return convergenceEnvelope(phase);
    case "still":
    case "assemble":
    case "dissolve":
    case "recursive-bloom":
      return undefined;
    default:
      return exhaustive(policy);
  }
}

/**
 * This is the cross-check for the identity invariant: the modulated id sets must equal the input id
 * sets exactly, in the same order, because both are produced by mapping over the same input arrays
 * and any divergence means an id was fabricated or dropped from the keying.
 */
export function assertMotionModulationKeying(elementIds: MotionElementIds, modulation: MotionModulation): void {
  assertExactIdOrder(elementIds.nodeIds, modulation.nodes.map((node) => node.id), "node");
  assertExactIdOrder(elementIds.edgeIds, modulation.edges.map((edge) => edge.id), "edge");
}

/**
 * This is the resting-completeness invariant, enforced rather than assumed: at a policy's own
 * resting phase every governed node and relation must be drawn at full opacity, full scale, zero
 * offset, zero convergence, and full reveal -- the identity modulation -- so an incomplete state is
 * never one a reader can rest in.
 */
export function assertRestingCompleteness(policy: MotionGrammar, elementIds: MotionElementIds): void {
  const modulation = restingModulation(policy, elementIds);
  for (const node of modulation.nodes) {
    if (node.opacityPermille !== PERMILLE || node.scalePermille !== PERMILLE || node.offsetXPermille !== 0 || node.offsetYPermille !== 0 || node.convergencePermille !== 0) {
      throw new TypeError(`motion grammar "${policy}" resting phase is incomplete for node: ${node.id}`);
    }
  }
  for (const edge of modulation.edges) {
    if (edge.opacityPermille !== PERMILLE || edge.revealPermille !== PERMILLE) {
      throw new TypeError(`motion grammar "${policy}" resting phase is incomplete for relation: ${edge.id}`);
    }
  }
}

/**
 * This is the traceability measure the identity-traceability decision requires be reported and never
 * gated on: how continuously a policy's own elements persist (no hard appear/disappear between
 * consecutive sampled phases) and move (how large each consecutive step is, normalised against the
 * modulation contract's own declared channel ranges). It returns one number in [0, 1] -- 1 is every
 * element present throughout and unchanged between samples, 0 is every step either breaking an
 * element's presence or reaching the largest possible step -- averaged over every element and every
 * consecutive sample pair. It is descriptive only: nothing in this module reads its result to choose
 * or exclude a policy.
 */
export function motionTraceability(policy: MotionGrammar, elementIds: MotionElementIds, phases: readonly number[]): number {
  if (phases.length < 2) {
    throw new TypeError("motion grammar traceability requires at least two sampled phases");
  }
  if (elementIds.nodeIds.length === 0 && elementIds.edgeIds.length === 0) {
    throw new TypeError("motion grammar traceability requires at least one governed element");
  }
  const samples = phases.map((phase) => motionModulation(policy, phase, elementIds));
  let total = 0;
  let count = 0;
  for (let index = 0; index < elementIds.nodeIds.length; index += 1) {
    for (let step = 1; step < samples.length; step += 1) {
      const previousNode = requiredSample(samples[step - 1]).nodes[index];
      const currentNode = requiredSample(samples[step]).nodes[index];
      if (previousNode === undefined || currentNode === undefined) {
        throw new TypeError("motion grammar traceability sample is missing a keyed node");
      }
      total += nodeContinuity(previousNode, currentNode);
      count += 1;
    }
  }
  for (let index = 0; index < elementIds.edgeIds.length; index += 1) {
    for (let step = 1; step < samples.length; step += 1) {
      const previousEdge = requiredSample(samples[step - 1]).edges[index];
      const currentEdge = requiredSample(samples[step]).edges[index];
      if (previousEdge === undefined || currentEdge === undefined) {
        throw new TypeError("motion grammar traceability sample is missing a keyed relation");
      }
      total += edgeContinuity(previousEdge, currentEdge);
      count += 1;
    }
  }
  return total / count;
}

function requiredSample(sample: MotionModulation | undefined): MotionModulation {
  if (sample === undefined) {
    throw new TypeError("motion grammar traceability sample is missing");
  }
  return sample;
}

function nodeContinuity(previous: NodeMotionModulation, current: NodeMotionModulation): number {
  if (brokeAppearance(previous.opacityPermille, current.opacityPermille)) {
    return 0;
  }
  const magnitude = Math.abs(current.opacityPermille - previous.opacityPermille)
    + Math.abs(current.scalePermille - previous.scalePermille)
    + Math.abs(current.offsetXPermille - previous.offsetXPermille)
    + Math.abs(current.offsetYPermille - previous.offsetYPermille)
    + Math.abs(current.convergencePermille - previous.convergencePermille);
  return 1 - clampUnit(magnitude / NODE_STEP_MAGNITUDE_PERMILLE);
}

function edgeContinuity(previous: EdgeMotionModulation, current: EdgeMotionModulation): number {
  if (brokeAppearance(previous.opacityPermille, current.opacityPermille)) {
    return 0;
  }
  const magnitude = Math.abs(current.opacityPermille - previous.opacityPermille)
    + Math.abs(current.revealPermille - previous.revealPermille);
  return 1 - clampUnit(magnitude / EDGE_STEP_MAGNITUDE_PERMILLE);
}

function brokeAppearance(previousOpacityPermille: number, currentOpacityPermille: number): boolean {
  return (previousOpacityPermille === 0) !== (currentOpacityPermille === 0);
}

function nodeModulation(policy: MotionGrammar, phase: number, id: string): NodeMotionModulation {
  const seed = seedFraction(id);
  switch (policy) {
    case "still":
      return identityNode(id);
    case "assemble": {
      // This axis declares the same, uniform, phase-only value for every id (see this module's own
      // opening docstring: no access to a resolved layout, and per CAP-13 finding F79, never an id
      // hash either): a real per-element construction ORDER -- existing structure resolving first, a
      // relation propagating, a new element resolving -- requires real incidence, which only
      // `#scene/build.ts`'s own `resolveStructuralGeometry` has (BFS hop-distance from a real
      // incidence-degree hub). What this declaration alone still guarantees is resting completeness at
      // phase 1 and genuine incompleteness away from it, both independent of that later resolution.
      const level = Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 };
    }
    case "dissolve": {
      // Mirrors Assemble's own reasoning above, in reverse: uniform and phase-only here, with the real
      // structural withdrawal order (periphery releasing first, the hub persisting longest) resolved
      // only at `#scene/build.ts`.
      const level = PERMILLE - Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 };
    }
    case "recursive-bloom": {
      // Uniform and phase-only for the same reason: the real nested-generation grouping this policy's
      // own "next level emerging from the previous one" reading depends on is resolved from real
      // hop-distance at `#scene/build.ts`, never from an id.
      const level = Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 };
    }
    case "pulse": {
      // Uniform amplitude, no id-seeded spread: the human review disposition's binding rule requires
      // even Pulse to breathe structurally rather than blink independently, which this axis alone
      // cannot do (it has no distance from a real centre to phase-shift by -- see this module's own
      // opening docstring); `#scene/build.ts`'s own `resolvePulseGeometry` recomputes this same
      // envelope per node against a real, centroid-distance-shifted phase instead of trusting this
      // declared, synchronized value directly.
      const envelope = breathingEnvelope(phase);
      const scalePermille = clampScale(PERMILLE + Math.round(PULSE_AMPLITUDE_PERMILLE * envelope));
      return { id, opacityPermille: PERMILLE, scalePermille, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 };
    }
    case "reconfigure": {
      const envelope = breathingEnvelope(phase);
      const amplitude = breathingAmplitude(seed, RECONFIGURE_AMPLITUDE_PERMILLE);
      const scalePermille = clampScale(PERMILLE + Math.round(amplitude * envelope));
      const offsetAmplitude = breathingAmplitude(seed, RECONFIGURE_OFFSET_AMPLITUDE_PERMILLE);
      const angle = directionAngle(id);
      const offsetXPermille = roundPermille(offsetAmplitude * envelope * Math.cos(angle));
      const offsetYPermille = roundPermille(offsetAmplitude * envelope * Math.sin(angle));
      return { id, opacityPermille: PERMILLE, scalePermille, offsetXPermille, offsetYPermille, convergencePermille: 0 };
    }
    case "condense": {
      // Position-blind by construction: every node declares the identical envelope-scaled ceiling
      // here, as if it were the single farthest node from the structure's own centre. Only the scene
      // layer (`#scene/build.ts`'s own resolveCondenseGeometry), which alone holds a real resolved
      // anchor for every node, knows how peripheral any one node actually is and spends this ceiling
      // accordingly -- see CONDENSE_CONVERGENCE_AMPLITUDE_PERMILLE's own docstring for the full account
      // of what replaced the id-hash split this used to carry.
      const envelope = convergenceEnvelope(phase);
      const ceilingPermille = Math.round(envelope * PERMILLE);
      const opacityPermille = clampPermille(PERMILLE - ceilingPermille);
      const scalePermille = clampScale(PERMILLE - ceilingPermille);
      const convergencePermille = clampPermille(Math.round(envelope * CONDENSE_CONVERGENCE_AMPLITUDE_PERMILLE));
      return { id, opacityPermille, scalePermille, offsetXPermille: 0, offsetYPermille: 0, convergencePermille };
    }
    default:
      return exhaustive(policy);
  }
}

function edgeModulation(policy: MotionGrammar, phase: number, id: string): EdgeMotionModulation {
  switch (policy) {
    case "still":
      return identityEdge(id);
    case "assemble": {
      // Uniform and phase-only, for the same reason as the node case above: a relation's own real
      // reveal order (propagating alongside the nearer of its two endpoints) is resolved only at
      // `#scene/build.ts`, from those endpoints' own real structural rank.
      const level = Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "dissolve": {
      const level = PERMILLE - Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "recursive-bloom": {
      const level = Math.round(phase * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "pulse":
    case "reconfigure":
      // Pulse and Reconfigure are node-scale and node-shape grammars; a relation's own reveal never
      // interrupts, because breaking a relation mid-breath is not part of either grammar.
      return identityEdge(id);
    case "condense":
      // A relation has no position of its own to be peripheral or central about -- only its two real
      // endpoints do, and this axis has no access to either (see this module's own opening docstring).
      // The scene layer alone (`#scene/build.ts`'s own resolveCondenseGeometry) resolves a relation's
      // own fade from its two endpoints' real, already-resolved distance from the structure's centre.
      return identityEdge(id);
    default:
      return exhaustive(policy);
  }
}

function identityNode(id: string): NodeMotionModulation {
  return { id, opacityPermille: PERMILLE, scalePermille: PERMILLE, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 };
}

function identityEdge(id: string): EdgeMotionModulation {
  return { id, opacityPermille: PERMILLE, revealPermille: PERMILLE };
}

function breathingAmplitude(seed: number, baseAmplitudePermille: number): number {
  return (baseAmplitudePermille * (500 + Math.round(seed * 500))) / PERMILLE;
}

/**
 * This is the shared cyclic mechanism behind Pulse and Reconfigure: exactly zero at phase 0 (so both
 * rest at exact identity there) and one full cycle across the phase domain. Exported so
 * `#scene/build.ts`'s own `resolvePulseGeometry` can recompute this identical envelope against a real,
 * per-node phase-shifted argument (never a different formula standing in for it) -- see that function's
 * own docstring for why a phase shift, evaluated through this same envelope, is what turns synchronized
 * breathing into a structural wave without ever breaking exact identity at phase 0 (multiplying phase by
 * any per-node factor still passes 0 through unchanged, so the shift never desyncs the one phase every
 * policy's own resting completeness depends on).
 */
export function breathingEnvelope(phase: number): number {
  return Math.sin(2 * Math.PI * phase);
}

/** This is Condense's single-hump mechanism: exactly zero at phase 0 and phase 1, peaking at the midpoint. */
function convergenceEnvelope(phase: number): number {
  return Math.sin(Math.PI * phase);
}

/**
 * This is the staggered-reveal primitive Assemble, Dissolve, and RecursiveBloom all reduce to: a
 * per-element progress in [0, 1] that is exactly 0 at `windowStart`, reaches 1 at `windowEnd` or
 * later, and is shifted later within that window by up to `staggerFraction` of the window's own span
 * according to `rank`, so elements sharing one window do not all move in lockstep. Exported so
 * `#scene/build.ts`'s own `resolveStructuralGeometry` can drive this identical primitive with a real,
 * governed per-element rank in [0, 1] (BFS hop-distance from a real incidence-degree hub, normalised) in
 * place of the id-hash `seedFraction(id)` this axis itself no longer computes for these three policies
 * (see CAP-13 finding F79 and this module's own `ASSEMBLE_STAGGER_FRACTION` docstring).
 */
export function staggeredProgress(phase: number, rank: number, windowStart: number, windowEnd: number, staggerFraction: number): number {
  const span = windowEnd - windowStart;
  const elementStart = windowStart + (rank * staggerFraction * span);
  const elementSpan = windowEnd - elementStart;
  if (elementSpan <= 0) {
    return phase >= windowEnd ? 1 : 0;
  }
  return clampUnit((phase - elementStart) / elementSpan);
}

/**
 * This is RecursiveBloom's own nested-window boundary for one generation, unchanged in shape from
 * before this pass: each successive generation gets a geometrically shrinking slice of the phase
 * domain's own remaining span, so an outer generation's own window is always nested inside the span its
 * inner generation left unclaimed. Exported so `#scene/build.ts`'s own `resolveStructuralGeometry` can
 * place a real, hop-distance-bucketed generation (never an id hash -- see this module's own
 * `RECURSIVE_BLOOM_GENERATIONS` docstring) into the same nested windows this axis always used.
 */
export function bloomWindow(generation: number): { readonly start: number; readonly end: number } {
  return {
    start: 1 - (RECURSIVE_BLOOM_DECAY ** generation),
    end: 1 - (RECURSIVE_BLOOM_DECAY ** (generation + 1)),
  };
}

function directionAngle(id: string): number {
  return directionSeedFraction(id) * 2 * Math.PI;
}

function seedFraction(id: string): number {
  return seedPermille(id) / PERMILLE;
}

function seedPermille(id: string): number {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed + (id.charCodeAt(index) * (index + 1))) % PERMILLE;
  }
  return seed;
}

function directionSeedFraction(id: string): number {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed + (id.charCodeAt(index) * (id.length - index))) % PERMILLE;
  }
  return seed / PERMILLE;
}

/** This rounds and normalises a negative-zero result (Math.round(-1e-16) === -0) to positive zero, so a channel that should sit at exact identity never fails a strict equality check on its sign bit alone. */
function roundPermille(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampPermille(value: number): number {
  return Math.min(PERMILLE, Math.max(0, value));
}

function clampScale(value: number): number {
  return Math.min(SCALE_RANGE_PERMILLE, Math.max(0, value));
}

function exhaustive(policy: never): never {
  throw new TypeError(`motion grammar is outside its closed vocabulary: ${String(policy)}`);
}

function assertMotionGrammarMember(policy: MotionGrammar): void {
  if (!MOTION_GRAMMARS.includes(policy)) {
    throw new TypeError(`motion grammar is outside its closed vocabulary: ${String(policy)}`);
  }
}

function assertPhase(phase: number): void {
  if (typeof phase !== "number" || !Number.isFinite(phase) || phase < 0 || phase > 1) {
    throw new TypeError("motion grammar phase must be a finite number in [0, 1]");
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new TypeError(`motion grammar ${label} id set contains a duplicate: ${id}`);
    }
    seen.add(id);
  }
}

function assertExactIdOrder(expected: readonly string[], actual: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new TypeError(`motion grammar ${label} modulation ids do not match the input keying exactly`);
  }
}
