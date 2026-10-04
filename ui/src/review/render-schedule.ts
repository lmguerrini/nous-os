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

/** D-072 FixC (X8): a LOD band crossing observed while the camera still moves is only noted,
 * never applied — the level refresh runs once the camera has been still this long. Pure. */
export const LOD_REFRESH_IDLE_MS = 300;

/** Whether a pending level change may be applied now: never during continuous zoom, only after
 * the camera has been unchanged for `LOD_REFRESH_IDLE_MS` (a camera that never moved is at rest).
 * Pure. */
export function lodRefreshDue(state: {
  readonly nowMs: number;
  readonly pending: boolean;
  readonly lastCameraChangeMs: number | null;
  readonly idleMs?: number;
}): boolean {
  if (!state.pending) return false;
  if (state.lastCameraChangeMs === null) return true;
  return state.nowMs - state.lastCameraChangeMs >= (state.idleMs ?? LOD_REFRESH_IDLE_MS);
}

/** D-072 FixC (X9): the backing-store scale of the canvas layers never changes while the camera
 * moves. The mid-motion swap to a lower ratio cost a resize plus a full repaint ~90 ms into
 * motion — one 110–190 ms frame at every interaction start — so the moving frame now draws at
 * the rest scale (its own reduced drawing is what makes it cheap, not the resolution), and the
 * only scheduled swap left is the one back to the rest cap after `applyResolution` policy
 * changes. Pure. */
export function resolutionSwapAllowed(quality: RenderQuality): boolean {
  return quality === "full";
}

/** D-072 R3 (X9): the apply decision built on `resolutionSwapAllowed`. While the camera moves the
 * plan never applies — the moving frame draws at the rest scale, its own reduced drawing is what
 * makes it cheap, not a lower resolution — so the backing stores keep `scheduledScale`; at rest
 * the swap runs exactly when the rest policy differs from the scheduled scale (a DPR or window
 * policy change). Pure. */
export function resolutionApplyPlan(
  quality: RenderQuality,
  devicePixelRatio: number,
  scheduledScale: number,
): { apply: boolean; scale: number } {
  if (!resolutionSwapAllowed(quality)) return { apply: false, scale: scheduledScale };
  const target = renderPixelScale("full", devicePixelRatio);
  return { apply: target !== scheduledScale, scale: target };
}

/** D-072 R3 (X9): whether the reduced (tier-1 only) label pass has any candidate at all — a
 * hovered node, a selection, or the Flat domains (`flatDomains`: labels on, flat organization,
 * at least one visible domain). When false the whole moving pass is skipped: no anchor
 * projection, no footprint discs, no Indra container title placement, no DOM rebuild. Pure. */
export function movingLabelPassHasCandidates(state: {
  readonly hoverId: string | null;
  readonly selectedId: string | null;
  readonly flatDomains: boolean;
}): boolean {
  return state.hoverId !== null || state.selectedId !== null || state.flatDomains;
}

// D081-P3e BEGIN: bound dense 3D moving-label projection to eligible tier-1 IDs.
export function denseMovingLabelIds(domainIds: readonly string[], visible: ReadonlySet<string>,
  organization: "natural" | "indra", labels: boolean, selected: string | null, hovered: string | null): Set<string> {
  const ids = new Set<string>();
  if (organization === "natural" && labels)
    for (const id of domainIds) if (visible.has(id)) ids.add(id);
  if (selected !== null) ids.add(selected);
  if (hovered !== null) ids.add(hovered);
  return ids;
}
// D081-P3e END

/** D-072 R3 (X9): the reduced label pass never runs more often than this while the camera moves. */
export const MOVING_LABEL_PASS_INTERVAL_MS = 120;

/** D-072 R3 (X9): the schedule of the moving label pass. A camera change never runs the pass
 * synchronously inside the watch tick — `request` answers `"defer"` and the pass runs one
 * animation frame later, coalesced with whatever the intervening frames ask for; `"skip"` covers
 * the throttle interval and an already-pending frame. Pure; the view drives it with frame
 * timestamps and reports each run. */
export class MovingLabelPassSchedule {
  private lastRunMs: number | null = null;
  private pending = false;
  private readonly intervalMs: number;

  constructor(intervalMs: number = MOVING_LABEL_PASS_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  request(nowMs: number): "defer" | "skip" {
    if (this.lastRunMs !== null && nowMs - this.lastRunMs < this.intervalMs) return "skip";
    if (this.pending) return "skip";
    this.pending = true;
    return "defer";
  }

  /** The deferred pass just ran one frame after its request; the interval counts from here. */
  ran(nowMs: number): void {
    this.lastRunMs = nowMs;
    this.pending = false;
  }
}

/** D-072 R3: one scheduling event of the product view, as `__d072.marks()` reports it — `at` is
 * the performance clock, `ms` the event's own duration (0 for instants like quality flips). */
export interface ScheduleMark {
  readonly name: string;
  readonly at: number;
  readonly ms: number;
}

/** D-072 R3: how many scheduling events `__d072.marks()` keeps — the last 400, never per frame. */
export const SCHEDULE_MARKS_CAPACITY = 400;

/** D-072 R3: a fixed-capacity ring of the view's scheduling events (quality flips, resolution
 * applies, label passes, remounts). Deterministic, no growth: the ring reuses its slots, only
 * the small mark objects are allocated, and events are rare by contract — never per frame.
 * Pure. */
export class ScheduleMarks {
  private readonly capacity: number;
  private readonly slots: (ScheduleMark | undefined)[];
  private head = 0;
  private count = 0;

  constructor(capacity: number = SCHEDULE_MARKS_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.slots = new Array<ScheduleMark | undefined>(this.capacity).fill(undefined);
  }

  record(name: string, at: number, ms: number): void {
    this.slots[this.head] = { name, at, ms };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** The last events, oldest first, in a fresh array — the caller can never mutate the ring. */
  list(): ScheduleMark[] {
    const out: ScheduleMark[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let index = 0; index < this.count; index += 1) out.push(this.slots[(start + index) % this.capacity]!);
    return out;
  }
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
