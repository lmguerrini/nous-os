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

/** This is a transient density reduction: peripheral elements fade and shrink toward the midpoint phase, core elements only shrink, and both fully return at either end of the phase domain. */
export const CONDENSE: MotionGrammar = "condense";

/** This is staggered per-element withdrawal, the direct reverse of Assemble's staggered construction and sharing its `staggeredProgress` primitive. */
export const DISSOLVE: MotionGrammar = "dissolve";

/**
 * This is nested, self-similar staggered construction: the same `staggeredProgress` primitive
 * Assemble uses, reapplied within recursively halved phase windows keyed by a generation derived
 * from each element's own id. REF-MOTION-001 found no support for genuine recursion in the prior art
 * it reviewed, only symmetry, and this implementation bears that finding out -- once built,
 * RecursiveBloom's own arithmetic is Assemble's primitive windowed, not a distinct mechanism. It
 * stays a separate, independently reachable member regardless, because the identity-traceability
 * decision this wave answers to requires every candidate state to stay reachable no matter what a
 * later measurement finds; nothing here narrows that reachability on the strength of this finding.
 */
export const RECURSIVE_BLOOM: MotionGrammar = "recursive-bloom";

/** This is the complete closed motion-grammar vocabulary and does not admit an eighth member. */
export const MOTION_GRAMMARS = [STILL, ASSEMBLE, PULSE, RECONFIGURE, CONDENSE, DISSOLVE, RECURSIVE_BLOOM] as const;

/** This is the input keying for one call: every id `motionModulation` may key its output by, and the only ids it may ever key its output by. */
export type MotionElementIds = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

/** This is one node's visual modulation for one phase and does not carry a screen-space position. */
export type NodeMotionModulation = {
  readonly id: string;
  readonly opacityPermille: number;
  readonly scalePermille: number;
  readonly offsetXPermille: number;
  readonly offsetYPermille: number;
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
const PULSE_AMPLITUDE_PERMILLE = 350;
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
/** This splits governed elements roughly in half by their own seed: everything at or above the midpoint of the seed range condenses away at the peak phase, everything below it only shrinks. */
const CONDENSE_PERIPHERAL_THRESHOLD_PERMILLE = 500;
/**
 * Raised from 500: at 500 a core element only shrank to 0.5x at the envelope's own peak (the
 * midpoint phase), a swing no larger than Pulse's own (0.65x-1.35x, see PULSE_AMPLITUDE_PERMILLE
 * above), so a core element under Condense was not reliably distinguishable from one under Pulse. At
 * this value a core element shrinks to 0.35x at the same peak -- well past Pulse's own floor -- while
 * a peripheral element still separately reaches full disappearance (shrink is unscaled PERMILLE for
 * the periphery, unaffected by this constant), so the two populations stay visually distinct: the
 * periphery empties out and the surviving core visibly contracts rather than merely dimming. Measured
 * against the phase-frames ablation, this raise moved Condense's own peak changed-pixel fraction from
 * ~1.81% to ~1.81%, effectively unchanged: the periphery's own full fade-and-shrink to zero already
 * dominates the frame-level area this metric counts, so a stronger core shrink alone barely registers
 * against it. Condense does not move any element's position -- offsetXPermille and offsetYPermille
 * stay zero at every phase, as they always have -- because this axis is a pure function of policy,
 * phase, and element id alone (see this module's own opening docstring) with no access to a node's
 * resolved layout position, and the scene layer that does hold that position (`scene/build.ts`) is
 * documented to move only the channels this axis itself declares, never to invent motion of its own.
 * Reading Condense as elements "drawing together" is therefore carried entirely by this shrink-and-fade
 * contrast (a shrinking, thinning population reads as a contraction) rather than by literal
 * convergence toward a shared point; a genuine positional pull toward a common centre would need this
 * axis to declare a per-node direction computed from real layout position, which is a materially larger
 * change than an amplitude retune and is left to whoever owns that design decision.
 */
const CONDENSE_CORE_SHRINK_PERMILLE = 650;
const ASSEMBLE_STAGGER_FRACTION = 0.7;
const DISSOLVE_STAGGER_FRACTION = 0.7;
const RECURSIVE_BLOOM_STAGGER_FRACTION = 0.6;
const RECURSIVE_BLOOM_GENERATIONS = 3;
const RECURSIVE_BLOOM_DECAY = 0.5;

/** This channel's declared range is [0, 1000]; used to derive `NODE_STEP_MAGNITUDE_PERMILLE` and `EDGE_STEP_MAGNITUDE_PERMILLE` below rather than a chosen constant. */
const OPACITY_RANGE_PERMILLE = PERMILLE;
/** This channel's declared range is [0, 2000] -- 0 to double identity size. */
const SCALE_RANGE_PERMILLE = 2 * PERMILLE;
/** This channel's declared range is [-1000, 1000]. */
const OFFSET_RANGE_PERMILLE = 2 * PERMILLE;
/** This channel's declared range is [0, 1000]. */
const REVEAL_RANGE_PERMILLE = PERMILLE;

/** This is the largest possible single-step change in one node's modulation, derived from the declared range of each of its four channels, and is what `motionTraceability` normalises against. */
const NODE_STEP_MAGNITUDE_PERMILLE = OPACITY_RANGE_PERMILLE + SCALE_RANGE_PERMILLE + OFFSET_RANGE_PERMILLE + OFFSET_RANGE_PERMILLE;
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
 * offset, and full reveal -- the identity modulation -- so an incomplete state is never one a reader
 * can rest in.
 */
export function assertRestingCompleteness(policy: MotionGrammar, elementIds: MotionElementIds): void {
  const modulation = restingModulation(policy, elementIds);
  for (const node of modulation.nodes) {
    if (node.opacityPermille !== PERMILLE || node.scalePermille !== PERMILLE || node.offsetXPermille !== 0 || node.offsetYPermille !== 0) {
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
    + Math.abs(current.offsetYPermille - previous.offsetYPermille);
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
      const level = Math.round(staggeredProgress(phase, seed, 0, 1, ASSEMBLE_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0 };
    }
    case "dissolve": {
      const level = PERMILLE - Math.round(staggeredProgress(phase, seed, 0, 1, DISSOLVE_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0 };
    }
    case "recursive-bloom": {
      const window = bloomWindow(bloomGeneration(id));
      const level = Math.round(staggeredProgress(phase, seed, window.start, window.end, RECURSIVE_BLOOM_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, scalePermille: level, offsetXPermille: 0, offsetYPermille: 0 };
    }
    case "pulse": {
      const envelope = breathingEnvelope(phase);
      const amplitude = breathingAmplitude(seed, PULSE_AMPLITUDE_PERMILLE);
      const scalePermille = clampScale(PERMILLE + Math.round(amplitude * envelope));
      return { id, opacityPermille: PERMILLE, scalePermille, offsetXPermille: 0, offsetYPermille: 0 };
    }
    case "reconfigure": {
      const envelope = breathingEnvelope(phase);
      const amplitude = breathingAmplitude(seed, RECONFIGURE_AMPLITUDE_PERMILLE);
      const scalePermille = clampScale(PERMILLE + Math.round(amplitude * envelope));
      const offsetAmplitude = breathingAmplitude(seed, RECONFIGURE_OFFSET_AMPLITUDE_PERMILLE);
      const angle = directionAngle(id);
      const offsetXPermille = roundPermille(offsetAmplitude * envelope * Math.cos(angle));
      const offsetYPermille = roundPermille(offsetAmplitude * envelope * Math.sin(angle));
      return { id, opacityPermille: PERMILLE, scalePermille, offsetXPermille, offsetYPermille };
    }
    case "condense": {
      const envelope = convergenceEnvelope(phase);
      const peripheral = isPeripheral(id);
      const opacityPermille = clampPermille(peripheral ? PERMILLE - Math.round(envelope * PERMILLE) : PERMILLE);
      const shrink = peripheral ? PERMILLE : CONDENSE_CORE_SHRINK_PERMILLE;
      const scalePermille = clampScale(PERMILLE - Math.round(envelope * shrink));
      return { id, opacityPermille, scalePermille, offsetXPermille: 0, offsetYPermille: 0 };
    }
    default:
      return exhaustive(policy);
  }
}

function edgeModulation(policy: MotionGrammar, phase: number, id: string): EdgeMotionModulation {
  const seed = seedFraction(id);
  switch (policy) {
    case "still":
      return identityEdge(id);
    case "assemble": {
      const level = Math.round(staggeredProgress(phase, seed, 0, 1, ASSEMBLE_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "dissolve": {
      const level = PERMILLE - Math.round(staggeredProgress(phase, seed, 0, 1, DISSOLVE_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "recursive-bloom": {
      const window = bloomWindow(bloomGeneration(id));
      const level = Math.round(staggeredProgress(phase, seed, window.start, window.end, RECURSIVE_BLOOM_STAGGER_FRACTION) * PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    case "pulse":
    case "reconfigure":
      // Pulse and Reconfigure are node-scale and node-shape grammars; a relation's own reveal never
      // interrupts, because breaking a relation mid-breath is not part of either grammar.
      return identityEdge(id);
    case "condense": {
      const envelope = convergenceEnvelope(phase);
      const level = clampPermille(isPeripheral(id) ? PERMILLE - Math.round(envelope * PERMILLE) : PERMILLE);
      return { id, opacityPermille: level, revealPermille: level };
    }
    default:
      return exhaustive(policy);
  }
}

function identityNode(id: string): NodeMotionModulation {
  return { id, opacityPermille: PERMILLE, scalePermille: PERMILLE, offsetXPermille: 0, offsetYPermille: 0 };
}

function identityEdge(id: string): EdgeMotionModulation {
  return { id, opacityPermille: PERMILLE, revealPermille: PERMILLE };
}

function isPeripheral(id: string): boolean {
  return seedPermille(id) >= CONDENSE_PERIPHERAL_THRESHOLD_PERMILLE;
}

function breathingAmplitude(seed: number, baseAmplitudePermille: number): number {
  return (baseAmplitudePermille * (500 + Math.round(seed * 500))) / PERMILLE;
}

/** This is the shared cyclic mechanism behind Pulse and Reconfigure: exactly zero at phase 0 (so both rest at exact identity there) and one full cycle across the phase domain. */
function breathingEnvelope(phase: number): number {
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
 * according to the element's own seed, so elements sharing one window do not all move in lockstep.
 */
function staggeredProgress(phase: number, seed: number, windowStart: number, windowEnd: number, staggerFraction: number): number {
  const span = windowEnd - windowStart;
  const elementStart = windowStart + (seed * staggerFraction * span);
  const elementSpan = windowEnd - elementStart;
  if (elementSpan <= 0) {
    return phase >= windowEnd ? 1 : 0;
  }
  return clampUnit((phase - elementStart) / elementSpan);
}

function bloomGeneration(id: string): number {
  return seedPermille(id) % RECURSIVE_BLOOM_GENERATIONS;
}

function bloomWindow(generation: number): { readonly start: number; readonly end: number } {
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
