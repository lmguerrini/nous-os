/** Flow rendering: a deterministic, soft luminous pulse travelling along exploratory connections. */
import type { EdgeCategory } from "#engine/presentation-options.ts";

/** Maximum number of edges animated in one frame; the loop stops when nothing is left to animate. */
export const FLOW_ANIMATED_EDGE_BUDGET = 60;
/** One full traverse at speed 1; higher speed shortens the period proportionally. */
export const FLOW_PERIOD_MS = 2600;
/** Half-width of the pulse envelope, as a share of the path length. */
export const FLOW_PULSE_SIGMA = 0.07;
/** How much wider than the base line the moving pulse reads. */
export const FLOW_PULSE_WIDTH_MULTIPLIER = 1.7;
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
  return state.motionEnabled && !state.reducedMotion && state.intensity > 0 && state.speed > 0;
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

// ---------------------------------------------------------------- D-072 V13 travelling highlight
//
// The exploratory flow no longer oscillates a symmetric pulse: a luminous head really travels from
// the relation's source to its target at a uniform speed in screen pixels per second, with a short
// bright head and a fading tail behind it, and a smooth fade-in each time it restarts. The cycle of
// one edge is its own projected length plus the tail, so the tail fully drains past the target
// before the head re-enters at the source — nothing ahead of the head, ever.

/** Head travel speed at speed 1, in screen px/s. Every edge shares it: uniform speed, per-edge cycle. */
export const FLOW_HEAD_SPEED_PX_S = 90;
/** Reach of the bright head, in px along the path from the head backwards. */
export const FLOW_HEAD_PX = 9;
/** Total reach of the fading tail behind the head, in px (head included). */
export const FLOW_TAIL_PX = 46;
/** A visible trail follows 16% of the projected arc, with a 24 px floor. */
export function flowTailLengthPx(arcLengthPx: number): number {
  return Math.max(24, arcLengthPx * 0.16);
}
/** Peak opacity on the separate layer at the default intensity. */
export function flowHeadAlpha(intensity: number): number {
  return 0.56 * Math.min(1, Math.max(0, intensity) / 0.6);
}
/** The restart fade-in covers this much head travel, in px. */
export const FLOW_RESTART_FADE_PX = 14;

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
  const fade = behind <= FLOW_HEAD_PX ? 1 : 1 - smoothstep((behind - FLOW_HEAD_PX) / (tailPx - FLOW_HEAD_PX));
  const fadeIn = Math.min(1, Math.max(0, headPx) / FLOW_RESTART_FADE_PX);
  return Math.min(1, Math.max(0, intensity)) * fade * fadeIn;
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
  return flowMotionAllowed;
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
