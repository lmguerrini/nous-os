import type { VisualGraph } from "#engine/contract.ts";
import type { OpeningPolicy } from "#engine/control-state.ts";
import { ASSEMBLE, RECURSIVE_BLOOM, restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { resolveTemporalPlacements } from "#engine/temporal.ts";

/**
 * Opening Sequence resolves one further, deterministic axis on top of two already-shipped ones:
 * Temporal Playback (`#engine/temporal.ts`, WHAT governed historical state exists) and MotionGrammar
 * (`#engine/motion-grammar.ts`, HOW a transition is drawn). It answers neither question itself -- it
 * only sequences them: which real valid-time instant a caller should render next, and at which
 * MotionGrammar phase, so a mounted renderer can play "the graph forming from empty to its resting
 * state" as a scripted, reproducible timeline rather than a live simulation. Every function here is a
 * pure function of (graph, policy, seed) -- no timer, no stored state, and the only randomness is a
 * PRNG seeded by the caller's own recorded `seed` -- so the same call always returns byte-identical
 * output, the same purity discipline motion-grammar.ts's own opening docstring states for its axis.
 * `OpeningPolicy` and its seed (`#engine/control-state.ts`'s own `OpeningSequenceControl`) are reused
 * unchanged; this module adds no second representation of "which policy, which seed."
 */

/** This is one real, governed valid-time instant the opening plays before its own required arrival. */
export type OpeningTemporalStep = {
  readonly stepIndex: number;
  readonly instant: string;
};

/**
 * This is the opening's own required arrival instant: the unconditional all-time union, which a
 * caller passes to `buildScene`/`mount()` as an omitted `temporalInstant` (see
 * `resolveTemporalRenderGraph` in `#scene/build.ts`) -- today's accepted static graph, unchanged by
 * anything narrated before it.
 */
export const OPENING_ARRIVAL_INSTANT = "all-time";

/**
 * This resolves every real valid-time instant the governed graph's own placements name --
 * `resolveTemporalPlacements`'s (`#engine/temporal.ts`) own `at`, for every explicit or derived
 * placement, deduplicated and sorted chronologically -- and never a hardcoded or re-derived date. A
 * temporally UNKNOWN element contributes no step (it never earned a placement to contribute), though
 * it is still rendered from the arrival step onward like any other canonical element, because
 * `allTimeMembership` is unconditional. An empty result (no dated placement anywhere in the graph) is
 * a legitimate answer, not an error: the opening then has no dated step to play, only its own required
 * arrival.
 */
export function resolveOpeningTimeline(graph: VisualGraph): readonly OpeningTemporalStep[] {
  const placements = resolveTemporalPlacements(graph);
  const instants = new Set<string>();
  for (const placement of placements.values()) {
    if (placement.class !== "unknown") {
      instants.add(placement.at);
    }
  }
  const sorted = [...instants].sort((left, right) => epochMillis(left) - epochMillis(right));
  return sorted.map((instant, stepIndex) => ({ stepIndex, instant }));
}

/** This is one rendered frame of the opening: which step it belongs to, which instant to render it at, and which MotionGrammar phase to draw that instant's own real membership at. */
export type OpeningFrame = {
  readonly stepIndex: number;
  readonly instant: string;
  readonly phase: number;
  readonly rest: boolean;
};

/**
 * These are the two MotionGrammar policies whose own resting phase (`restingPhase` in
 * `#engine/motion-grammar.ts`) sits at genuine full construction (1, not 0): Assemble and
 * RecursiveBloom are the only members that module's own opening docstring calls "staggered ...
 * construction", so they alone have a phase-0 pose that is genuinely empty for every element -- the
 * pose an opening's own entry frame requires. Every other policy (including Still) never reaches empty
 * at either end of its own [0, 1] domain: Pulse, Reconfigure, and Condense are continuous ambient
 * motions with no empty endpoint at all, and Dissolve's own empty endpoint is a withdrawal (its own
 * docstring: "the direct reverse of Assemble's staggered construction"), not a construction. For any
 * of those, `resolveOpeningFrames` plays the real valid-time timeline as a discrete reveal of
 * already-resting frames, with no swept entry beneath it, rather than mislabel a withdrawal or an
 * ambient motion as a formation it is not.
 */
const OPENING_ENTRY_PHASE = 0;
const SWEEPING_OPENING_POLICIES: ReadonlySet<MotionGrammar> = new Set([ASSEMBLE, RECURSIVE_BLOOM]);

/** This is how many deterministic intermediate phases a sweeping policy samples per step, strictly between its own entry and resting phase, purely for evidence variety -- it changes no step's own final, resting frame. Also this function's own default `frameDensity`, so every existing caller that does not pass one keeps this exact frame list. */
const OPENING_INTERMEDIATE_FRAMES_PER_STEP = 2;

/**
 * This resolves the opening's own complete, ordered, reproducible frame list for one (policy, seed)
 * pair. `policy: "off"` (`OPENING_OFF`) returns exactly one frame, at the arrival instant, already
 * resting -- a complete, non-degraded path, never a smaller opening, matching `applyControlState`'s
 * (`#engine/control-state.ts`) own reduced-motion resolution, which forces this same policy. Any other
 * policy plays `resolveOpeningTimeline`'s own real instants in order, each followed by the arrival
 * step; a sweeping policy (see `SWEEPING_OPENING_POLICIES`) additionally samples `frameDensity`
 * deterministic phases strictly between its own entry and resting phase before each step's own resting
 * frame -- visual interpolation of HOW that step's already-real membership is drawn, never of WHICH
 * elements belong to it, exactly the distinction `#scene/build.ts`'s own `resolveTemporalRenderGraph`
 * docstring draws between the two axes. The sampling itself is a small seeded PRNG (mulberry32, the
 * same algorithm `ui/test/browser/motion.spec.ts` already uses for its own deterministic shuffling), so
 * a caller who records `seed` can reproduce this exact frame list, and a different seed reproduces a
 * different -- but still fully deterministic -- one, never a different arrival. `frameDensity` defaults
 * to `OPENING_INTERMEDIATE_FRAMES_PER_STEP` (2) so every existing caller is unaffected; a caller that
 * needs continuity dense enough to read as development rather than a slideshow (review media, never a
 * closure gate) may pass a larger one -- it only adds more samples of an already-real step's own
 * construction, never a new step, a new instant, or a different resting frame.
 */
export function resolveOpeningFrames(
  graph: VisualGraph,
  policy: OpeningPolicy,
  seed: number,
  frameDensity: number = OPENING_INTERMEDIATE_FRAMES_PER_STEP,
): readonly OpeningFrame[] {
  assertOpeningSeed(seed);
  assertFrameDensity(frameDensity);
  if (policy === "off") {
    return [{ stepIndex: 0, instant: OPENING_ARRIVAL_INSTANT, phase: 0, rest: true }];
  }
  const timeline = resolveOpeningTimeline(graph);
  const steps: readonly OpeningTemporalStep[] = [...timeline, { stepIndex: timeline.length, instant: OPENING_ARRIVAL_INSTANT }];
  const rest = restingPhase(policy);
  const sweeps = SWEEPING_OPENING_POLICIES.has(policy);
  const randomUnit = mulberry32(seed);
  const frames: OpeningFrame[] = [];
  for (const step of steps) {
    if (sweeps) {
      for (let sample = 0; sample < frameDensity; sample += 1) {
        const slot = (sample + randomUnit()) / (frameDensity + 1);
        frames.push({
          stepIndex: step.stepIndex,
          instant: step.instant,
          phase: OPENING_ENTRY_PHASE + (slot * (rest - OPENING_ENTRY_PHASE)),
          rest: false,
        });
      }
    }
    frames.push({ stepIndex: step.stepIndex, instant: step.instant, phase: rest, rest: true });
  }
  return frames;
}

function assertOpeningSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new TypeError("opening sequence seed must be a non-negative safe integer");
  }
}

function assertFrameDensity(frameDensity: number): void {
  if (!Number.isSafeInteger(frameDensity) || frameDensity < 0) {
    throw new TypeError("opening sequence frame density must be a non-negative safe integer");
  }
}

function epochMillis(instant: string): number {
  const epoch = Date.parse(instant);
  if (Number.isNaN(epoch)) {
    throw new TypeError(`opening sequence timeline instant is not parseable: ${instant}`);
  }
  return epoch;
}

/**
 * This is a small deterministic PRNG (mulberry32), seeded once and never reseeded mid-sequence,
 * mirroring `ui/test/browser/motion.spec.ts`'s own precedent exactly: the same seed always produces
 * the same sample order.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
