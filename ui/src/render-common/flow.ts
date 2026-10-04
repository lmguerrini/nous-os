/** Flow rendering: a deterministic, soft luminous pulse travelling along exploratory connections. */
import type { EdgeCategory } from "#engine/presentation-options.ts";

/** Maximum number of edges animated in one frame; the loop stops when nothing is left to animate. */
export const FLOW_ANIMATED_EDGE_BUDGET = 60;
/** One full traverse at speed 1; higher speed shortens the period proportionally. */
export const FLOW_PERIOD_MS = 2600;
/** Half-width of the pulse envelope, as a share of the path length. */
export const FLOW_PULSE_SIGMA = 0.07;
/** A small screen-space floor keeps thin Stellar arcs legible without widening thick filaments into ribbons. */
export const FLOW_PULSE_WIDTH_MULTIPLIER = 1.3;
export const FLOW_BEAM_CORE_MIN_PX = 1.8;
/** The glow is faint and bounded relative to thick filaments; thin arcs need a CSS-pixel floor. */
export const FLOW_BEAM_GLOW_WIDTH_MULTIPLIER = 2.2;
export const FLOW_BEAM_GLOW_MIN_PX = 4.2;
export const FLOW_BEAM_GLOW_ALPHA = 0.1;
export function flowBeamWidthsPx(edgeWidthPx: number): { readonly core: number; readonly glow: number } {
  return { core: Math.max(FLOW_BEAM_CORE_MIN_PX, edgeWidthPx * FLOW_PULSE_WIDTH_MULTIPLIER),
    glow: Math.max(FLOW_BEAM_GLOW_MIN_PX, edgeWidthPx * FLOW_BEAM_GLOW_WIDTH_MULTIPLIER) };
}
/** How much wider than the base line the exploratory halo reads. */
export const FLOW_HALO_WIDTH_MULTIPLIER = 2.6;
/** Halo opacity as a share of the base line opacity. */
export const FLOW_HALO_ALPHA = 0.16;
/** Steady, slightly brighter core used as the reduced-motion static fallback. */
export const FLOW_STATIC_CORE_ALPHA = 0.45;

export const EDGE_CATEGORIES: readonly EdgeCategory[] = ["attested", "exploratory", "containment"];
export const EDGE_CATEGORY_SET: ReadonlySet<EdgeCategory> = new Set(EDGE_CATEGORIES);

/** Every relation resolves to exactly one drawn category; focus is drawn on top, never a new kind. */
export function classifyEdgeCategory(exploratory: boolean, containment: boolean): EdgeCategory {
  if (containment) return "containment";
  if (exploratory) return "exploratory";
  return "attested";
}

/** Deterministic flow phase in [0, 1) for a given elapsed time and speed; 0 speed is still. */
export function flowPhaseAt(elapsedMilliseconds: number, speed: number): number {
  if (!(speed > 0) || !Number.isFinite(elapsedMilliseconds)) return 0;
  const period = FLOW_PERIOD_MS / speed;
  const phase = (elapsedMilliseconds % period) / period;
  return phase < 0 ? 1 + phase : phase;
}

/** Whether the flow loop should request any animation frame at all. */
export function flowAnimates(state: {
  readonly intensity: number;
  readonly speed: number;
  readonly motionEnabled: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.motionEnabled && !state.reducedMotion && !prefersReducedMotionNow() && state.intensity > 0 && state.speed > 0;
}

let reducedMotionQuery: MediaQueryList | null | undefined;
let reducedMotion = false;
function prefersReducedMotionNow(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    reducedMotion = reducedMotionQuery?.matches ?? false;
    reducedMotionQuery?.addEventListener?.("change", (event) => { reducedMotion = event.matches; });
  }
  return reducedMotion;
}

/** Soft luminous pulse envelope: brightness at a normalised arc distance from the pulse centre.
 * D-071 legacy envelope, kept as the reduced-motion-period reference; the travelling highlight
 * below replaced it for the animated reading. */
export function flowPulseAlpha(distanceNormalised: number, centre: number, intensity: number): number {
  if (!(intensity > 0)) return 0;
  let delta = Math.abs(distanceNormalised - centre);
  delta = Math.min(delta, 1 - delta);
  const sigma = FLOW_PULSE_SIGMA;
  return Math.min(1, Math.max(0, intensity)) * Math.exp(-(delta * delta) / (2 * sigma * sigma));
}

// ---------------------------------------------------------------- travelling flow
// The older head/tail helpers remain exported for historical evidence tests. The live light is a
// single, compact raised-cosine envelope; its entire width modulates the same radial edge profile.

/** Head travel speed at speed 1, in screen px/s. Every edge shares it: uniform speed, per-edge cycle. */
export const FLOW_HEAD_SPEED_PX_S = 32;
/** Historical compatibility constant; the live pulse has a compact, non-repeating envelope. */
export const FLOW_WAVE_PERIOD_LENGTHS = 2;
/** Peak light relative to the edge's own alpha at the default intensity (0.6). */
export const FLOW_WAVE_MAX_ALPHA = 0.8;
/** Full visible length, approximately 20% of the edge and bounded in screen pixels. */
export function flowPulseLengthPx(edgeLengthPx: number): number {
  return Math.max(40, Math.min(120, edgeLengthPx * 0.2));
}
/** One pulse travels from source to target, drains beyond the end, then restarts. */
export function flowWaveAlpha(atPx: number, edgeLengthPx: number, elapsedMilliseconds: number,
  speed: number, intensity: number): number {
  if (!(edgeLengthPx > 0) || !(speed > 0) || !(intensity > 0)) return 0;
  const pulseLength = flowPulseLengthPx(edgeLengthPx);
  const centre = flowHeadPositionPx(elapsedMilliseconds, speed, edgeLengthPx + pulseLength);
  const distance = Math.abs(atPx - centre);
  if (distance >= pulseLength * 0.5) return 0;
  const envelope = 0.5 + 0.5 * Math.cos(2 * Math.PI * distance / pulseLength);
  const entering = Math.min(1, Math.max(0, centre / (pulseLength * 0.5)));
  const restartFade = entering * entering * (3 - 2 * entering);
  return FLOW_WAVE_MAX_ALPHA * Math.min(1, Math.max(0, intensity / 0.6)) * envelope * restartFade;
}
/** Reach of the bright head, in px along the path from the head backwards. */
export const FLOW_HEAD_PX = 24;
/** A narrow core can be substantially brighter than its base filament without obscuring nodes. */
export const FLOW_HEAD_CORE_ALPHA_RATIO = 0.76;
export const FLOW_HEAD_MAX_ALPHA = 0.68;
/** Historical bound retained for the head-size contract. */
export const FLOW_HEAD_MAX_SIZE_PX = 18;
/** Total reach of the fading tail behind the head, in px (head included). */
export const FLOW_TAIL_PX = 72;
/** A visible trail follows 16% of the projected arc, with a 24 px floor. */
export function flowTailLengthPx(arcLengthPx: number): number {
  return Math.max(48, Math.min(112, arcLengthPx * 0.28));
}
/** Historical beam-length helper retained for older evidence tests. */
export const FLOW_BEAM_LENGTH_FACTOR = 1.7;
export function flowBeamLengthPx(arcLengthPx: number): number {
  return flowTailLengthPx(arcLengthPx) * FLOW_BEAM_LENGTH_FACTOR;
}
/** Historical head opacity helper retained for older evidence tests. */
export function flowHeadAlpha(intensity: number): number {
  return Math.min(FLOW_HEAD_MAX_ALPHA, 0.68 * Math.min(1, Math.max(0, intensity) / 0.6));
}
/** The restart fade-in covers this much head travel, in px. */
export const FLOW_RESTART_FADE_PX = 36;

/** Position of the head along a path whose cycle (projected length + tail) is `cyclePx`, at
 * `elapsedMilliseconds` of flow clock and the live speed control. Pure and monotone in time modulo
 * the cycle; 0 for a still flow. */
export function flowHeadPositionPx(elapsedMilliseconds: number, speed: number, cyclePx: number): number {
  if (!(speed > 0) || !(cyclePx > 0) || !Number.isFinite(elapsedMilliseconds)) return 0;
  const travelled = (elapsedMilliseconds / 1000) * speed * FLOW_HEAD_SPEED_PX_S;
  const head = travelled % cyclePx;
  return head < 0 ? head + cyclePx : head;
}

const smoothstep = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * Highlight alpha at `atPx` along a projected path of cycle `cyclePx` whose head sits at `headPx`:
 * full under the head, smoothly fading to nothing across the tail behind it, zero ahead of the
 * head (the wrapped tail draining past the target counts as behind), and scaled by the restart
 * fade-in while the head has just re-entered the source. Pure.
 */
export function flowHighlightAlpha(atPx: number, headPx: number, cyclePx: number, intensity: number, tailPx = FLOW_TAIL_PX): number {
  if (!(intensity > 0) || !(cyclePx > 0)) return 0;
  let behind = headPx - atPx;
  if (behind < 0) behind += cyclePx;
  if (behind > tailPx) return 0;
  const fade = smoothstep((tailPx - behind) / Math.max(6, tailPx * 0.1))
    * smoothstep(behind / Math.max(5, tailPx * 0.08));
  return Math.min(1, Math.max(0, intensity)) * fade;
}

/** One candidate edge for the animation budget. Lower priority animates first. */
export type FlowEdgeCandidate = {
  readonly edgeId: string;
  readonly visible: boolean;
  readonly priority: number;
};

/**
 * Choose which edges animate: visible only, selected and focus-adjacent first, capped by the budget.
 * Deterministic: equal priorities break ties by id, so the same frame always animates the same edges.
 */
export function selectFlowEdges(
  candidates: readonly FlowEdgeCandidate[],
  budget = FLOW_ANIMATED_EDGE_BUDGET,
): ReadonlySet<string> {
  const visible = candidates.filter((candidate) => candidate.visible);
  visible.sort((a, b) => a.priority - b.priority || a.edgeId.localeCompare(b.edgeId));
  return new Set(visible.slice(0, budget).map((candidate) => candidate.edgeId));
}

// ---------------------------------------------------------------- D-072 P1a separate-layer scheduling
//
// The separate flow layer (see `drawFlowLayer` in render-common/morphology-canvas) repaints alone at
// a capped cadence and pauses whenever nothing can animate. These are the pure scheduling decisions;
// the product view owns the rAF loop and injects time.

/** Minimum spacing between drawn flow-layer frames: about 30 fps. */
export const FLOW_LAYER_FRAME_MS = 1000 / 30;
/** The overlay fades back in over this long whenever the layer resumes (tab visible again, motion
 * re-allowed, camera settled); the flow clock's phase itself is never reset. */
export const FLOW_RESUME_FADE_MS = 240;

/** Whether a flow-layer frame is due at `nowMs`, given the last drawn frame's timestamp. The first
 * frame and any wall-clock step backwards are due, so the loop can never deadlock. Pure. */
export function flowLayerFrameDue(nowMs: number, lastFrameMs: number, minIntervalMs: number = FLOW_LAYER_FRAME_MS): boolean {
  const elapsed = nowMs - lastFrameMs;
  return !(elapsed >= 0 && elapsed < minIntervalMs);
}

/** Overlay opacity while resuming: 0 → 1 across `fadeMs`, then 1. Pure. */
export function flowLayerResumeAlpha(elapsedMs: number, fadeMs: number = FLOW_RESUME_FADE_MS): number {
  if (!(fadeMs > 0)) return 1;
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.min(1, Math.max(0, elapsedMs / fadeMs));
}

/** Whether the flow layer should keep running: the controls allow motion, the page is visible and
 * the last drawn frame still had an animated edge. Pure. */
export function flowLayerShouldRun(state: {
  readonly allowed: boolean;
  readonly hidden: boolean;
  readonly animatedEdges: number;
}): boolean {
  return state.allowed && !state.hidden && state.animatedEdges > 0;
}

// Module clock: driven by the product view's animation loop, read by the morphology canvas while it
// draws. Kept here so both the 2D and 3D canvas layers share one time source without adding renderer
// imports, and so the canvas can draw the static fallback when the loop is intentionally stopped.
let flowNowMilliseconds = 0;
let flowMotionAllowed = false;
let flowAnimatedEdges = 0;
let flowMotionOwner: object | null = null;
const legacyFlowOwner = {};

export function flowNow(): number {
  return flowNowMilliseconds;
}
export function setFlowNow(milliseconds: number): void {
  flowNowMilliseconds = milliseconds;
}
export function flowMotionAllowedNow(): boolean {
  return flowMotionAllowed && !prefersReducedMotionNow();
}
/** The most recent view claim owns the shared motion flag until it releases it. */
export function claimFlowMotion(owner: object, allowed: boolean): void {
  if (flowMotionOwner !== owner) flowAnimatedEdges = 0;
  flowMotionOwner = owner;
  flowMotionAllowed = allowed;
}
export function releaseFlowMotion(owner: object): void {
  if (flowMotionOwner !== owner) return;
  flowMotionOwner = null;
  flowMotionAllowed = false;
  flowAnimatedEdges = 0;
}
export function ownsFlowMotion(owner: object): boolean {
  return flowMotionOwner === owner;
}
/** Compatibility for direct canvas tests; product views use owner claims. */
export function setFlowMotionAllowed(allowed: boolean): void {
  claimFlowMotion(legacyFlowOwner, allowed);
}
export function flowAnimatedEdgeCount(): number {
  return flowAnimatedEdges;
}
export function setFlowAnimatedEdgeCount(count: number): void {
  flowAnimatedEdges = count;
}
