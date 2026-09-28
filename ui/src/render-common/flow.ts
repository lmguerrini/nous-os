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

/** Soft luminous pulse envelope: brightness at a normalised arc distance from the pulse centre. */
export function flowPulseAlpha(distanceNormalised: number, centre: number, intensity: number): number {
  if (!(intensity > 0)) return 0;
  let delta = Math.abs(distanceNormalised - centre);
  delta = Math.min(delta, 1 - delta);
  const sigma = FLOW_PULSE_SIGMA;
  return Math.min(1, Math.max(0, intensity)) * Math.exp(-(delta * delta) / (2 * sigma * sigma));
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

// Module clock: driven by the product view's animation loop, read by the morphology canvas while it
// draws. Kept here so both the 2D and 3D canvas layers share one time source without adding renderer
// imports, and so the canvas can draw the static fallback when the loop is intentionally stopped.
let flowNowMilliseconds = 0;
let flowMotionAllowed = false;
let flowAnimatedEdges = 0;

export function flowNow(): number {
  return flowNowMilliseconds;
}
export function setFlowNow(milliseconds: number): void {
  flowNowMilliseconds = milliseconds;
}
export function flowMotionAllowedNow(): boolean {
  return flowMotionAllowed;
}
export function setFlowMotionAllowed(allowed: boolean): void {
  flowMotionAllowed = allowed;
}
export function flowAnimatedEdgeCount(): number {
  return flowAnimatedEdges;
}
export function setFlowAnimatedEdgeCount(count: number): void {
  flowAnimatedEdges = count;
}
