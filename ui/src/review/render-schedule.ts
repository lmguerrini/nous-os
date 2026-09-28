/** D-072 P1a render scheduling: the pure decision logic behind the product view's frame loops.
 * Everything here is deterministic and DOM-free — the view injects time, the loops call in. */
import type { Coordinates } from "../engine/contract.ts";
import { SCENE_PERMILLE_QUANTUM, SCENE_PERMILLE_SCALE } from "../scene/contract.ts";

/** The two drawing qualities of the morphology pass: the full drawing, and the reduced frame
 * drawn while the camera moves (container-canvas skips equators, gradients and deep titles). */
export type RenderQuality = "full" | "moving";

/** Full quality returns this long after the last camera change. */
export const QUALITY_RESTORE_MS = 200;
/** A camera state unchanged for this long means nothing moves: the watch loop may stop. */
export const CAMERA_STILLNESS_MS = 300;
/** Backing-store scale of the canvas layers at rest: the device ratio, capped. */
export const REST_DEVICE_PIXEL_RATIO_CAP = 1.5;
/** Backing-store scale of the canvas layers while the camera moves. */
export const MOVING_DEVICE_PIXEL_RATIO = 1;

/** The scheduled backing-store scale of the morphology and flow canvels. Pure. */
export function renderPixelScale(quality: RenderQuality, devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || !(devicePixelRatio > 0)) return 1;
  return quality === "moving"
    ? Math.min(devicePixelRatio, MOVING_DEVICE_PIXEL_RATIO)
    : Math.min(devicePixelRatio, REST_DEVICE_PIXEL_RATIO_CAP);
}

/** Whether a flow-layer frame is due lives in `render-common/flow.ts` with the other flow-layer
 * scheduling (`flowLayerFrameDue`, `flowLayerResumeAlpha`, `flowLayerShouldRun`). */

/** The quality state machine. `touch` reports camera movement (the moment quality becomes
 * `"moving"`); `poll` is called on every watch tick and reports the transition back to `"full"`
 * exactly once, `restoreDelayMs` after the last movement. Times are injected; a poll older than
 * the last touch never restores. */
export class QualityGovernor {
  private state: RenderQuality = "full";
  private lastTouchMs: number | null = null;
  private readonly restoreDelayMs: number;

  constructor(restoreDelayMs: number = QUALITY_RESTORE_MS) {
    this.restoreDelayMs = restoreDelayMs;
  }

  get quality(): RenderQuality {
    return this.state;
  }

  /** Camera movement happened at `nowMs`. Returns `"moving"` when this call flips quality to
   * moving, else null (quality was already moving; only the restore deadline moved). */
  touch(nowMs: number): RenderQuality | null {
    this.lastTouchMs = nowMs;
    if (this.state === "moving") return null;
    this.state = "moving";
    return "moving";
  }

  /** Advances the machine to `nowMs`. Returns `"full"` when quality returns to full, else null. */
  poll(nowMs: number): RenderQuality | null {
    if (this.state !== "moving" || this.lastTouchMs === null) return null;
    if (nowMs - this.lastTouchMs < this.restoreDelayMs) return null;
    this.state = "full";
    this.lastTouchMs = null;
    return "full";
  }

  /** Ends a motion the page itself started — a programmatic framing that has just completed. The
   * camera sits at its final state and nothing further will move it, so quality returns to full
   * now rather than after `restoreDelayMs` of stillness: the label pass that closes the framing
   * draws the full set, and secondary labels return with the fit itself instead of a settle
   * later. Returns `"full"` when quality actually flipped, so the caller runs its full-restore
   * path exactly once; already-full is a no-op. */
  endMotion(nowMs: number): RenderQuality | null {
    if (this.state !== "moving") return null;
    this.state = "full";
    this.lastTouchMs = null;
    return "full";
  }
}

/** Whether the camera watch loop still has a reason to run: a pointer is pressed on the canvas,
 * an explicit motion window (wheel, keys, programmatic animation) is open, or the camera state
 * changed within the stillness interval. Pure. */
export function cameraWatchShouldRun(state: {
  readonly nowMs: number;
  readonly lastChangeMs: number | null;
  readonly pressed: boolean;
  readonly motionUntilMs: number;
  readonly stillnessMs?: number;
}): boolean {
  if (state.pressed) return true;
  if (state.nowMs < state.motionUntilMs) return true;
  if (state.lastChangeMs === null) return false;
  return state.nowMs - state.lastChangeMs < (state.stillnessMs ?? CAMERA_STILLNESS_MS);
}

/** The depth-epsilon the 3D rig clamps its size scale with (camera.tsx `sizeScaleAt`), so the
 * scale reproduced here from the review pose matches the rig's exactly, degenerate points
 * included. */
export const SIZE_SCALE_EPSILON = SCENE_PERMILLE_QUANTUM / SCENE_PERMILLE_SCALE;

/** The live screen-size scale at one world point, reproduced from the review camera pose
 * (position and look-at target): the perspective rig's `sizeScaleAt` is the target's view-axis
 * depth over the point's view-axis depth, both floored at the permille quantum. Deterministic,
 * pure; `position`/`target` are the pose arrays `readReviewCameraPose()` reports. */
export function perspectiveSizeScale(
  pose: { readonly position: readonly number[]; readonly target: readonly number[] },
  point: Coordinates,
  epsilon: number = SIZE_SCALE_EPSILON,
): number {
  const [px, py, pz] = pose.position;
  const [tx, ty, tz] = pose.target;
  if (px === undefined || py === undefined || pz === undefined || tx === undefined || ty === undefined || tz === undefined) return 1;
  const dx = tx - px, dy = ty - py, dz = tz - pz;
  const targetDepth = Math.hypot(dx, dy, dz);
  if (!(targetDepth > 0)) return 1;
  const depth = ((point.x - px) * dx + (point.y - py) * dy + (point.z - pz) * dz) / targetDepth;
  return Math.max(targetDepth, epsilon) / Math.max(depth, epsilon);
}

/** How many anchors the label pass may feed to the O(n²) depth-occlusion pass: the nearest by
 * depth first, capped by the label budget's own order of magnitude. Anchors beyond the cap are
 * treated as unoccluded — their labels still pass the full collision placement, so the no-overlap
 * guarantee never depends on this approximation. */
export const OCCLUSION_SAMPLE_CAP_FLOOR = 96;
export function occlusionSampleCap(labelBudget: number): number {
  return Math.max(OCCLUSION_SAMPLE_CAP_FLOOR, labelBudget * 3);
}

/** The anchors the occlusion pass receives: the `cap` nearest by depth (ties by id), so the
 * geometry that actually covers others on screen participates while the pass stays bounded. Pure. */
export function capOcclusionSamples<T extends { readonly id: string; readonly depth: number }>(
  samples: readonly T[],
  cap: number,
): T[] {
  if (samples.length <= cap) return [...samples];
  return [...samples]
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
    .slice(0, cap);
}

/** `rgb(...)` string from a unit-range triple, the shared drawer's `tint` for presentation tints. */
export function rgbFromUnit(rgb: readonly [number, number, number] | readonly number[]): string {
  return `rgb(${rgb.map((value) => Math.round(value * 255)).join(", ")})`;
}
