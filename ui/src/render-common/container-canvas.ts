import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath, ShellCircle } from "#engine/container-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { ProjectedPoint } from "#render-common/morphology-canvas.ts";
import type { Dimension, MathematicalField, PickResult, ProjectionResult, RenderVisibility } from "../projection/contract-types.ts";
import { PALETTES } from "./palette.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const dashHook = () => (globalThis as typeof globalThis & { __indraContainers?: { dashed: number; draws: number; limbs?: number | undefined; equators?: number | undefined; minEquatorFlatness?: number | undefined; nousosLimb?: { x: number; y: number; radiusPx: number } | undefined; quality?: "full" | "moving" | undefined } }).__indraContainers;
const bump = (hook: ReturnType<typeof dashHook>, key: "limbs" | "equators", value: number) => {
  if (hook) hook[key] = (hook[key] ?? 0) + value;
};

/** Records the dash policy as well as applying it to the canvas. */
function setDash(context: CanvasRenderingContext2D, pattern: number[]): void {
  const hook = dashHook();
  if (hook) {
    hook.draws += 1;
    if (pattern.length) hook.dashed += 1;
  }
  context.setLineDash(pattern);
}

/** Below this minor/major axis ratio a projected great circle is an edge-on line and is not drawn.
 * D-071 G3: 0.45 — a near-edge-on ellipse still read as a long thin arc beside the shell limb. */
export const GREAT_CIRCLE_FLATNESS_CUTOFF = 0.45;
/** Flatness at which a great circle reaches its full alpha; the fade is linear between the two. */
export const GREAT_CIRCLE_FLATNESS_FULL = 0.8;

/** Fade factor of a great circle from the flatness of its projected ellipse: 0 (edge-on) to 1 (round). */
export function greatCircleFade(flatness: number): number {
  return clamp((flatness - GREAT_CIRCLE_FLATNESS_CUTOFF) / (GREAT_CIRCLE_FLATNESS_FULL - GREAT_CIRCLE_FLATNESS_CUTOFF), 0, 1);
}

/** Minor/major axis ratio of projected points (square root of the covariance eigenvalue ratio): the
 * flatness of a projected circle, 1 face-on and 0 edge-on, under any affine projection. */
export function projectedFlatness(points: readonly { readonly x: number; readonly y: number }[]): number {
  if (points.length < 3) return 0;
  let meanX = 0, meanY = 0;
  for (const point of points) { meanX += point.x; meanY += point.y; }
  meanX /= points.length;
  meanY /= points.length;
  let xx = 0, yy = 0, xy = 0;
  for (const point of points) {
    const dx = point.x - meanX, dy = point.y - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const trace = xx + yy;
  const root = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const major = (trace + root) / 2, minor = (trace - root) / 2;
  return major <= 1e-12 ? 0 : clamp(Math.sqrt(Math.max(0, minor) / major), 0, 1);
}

/** Screen pixels per world unit around `center`, measured on the two axes most parallel to the screen
 * (the third runs toward the camera and projects to almost nothing). This is the true projected limb
 * radius of a sphere: `radius × projectedWorldScale`, in both projections. */
export function projectedWorldScale(
  center: Coordinates,
  radius: number,
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
): number {
  const safeRadius = Math.max(radius, 1e-6);
  const origin = project(center);
  const factors = [
    project({ x: center.x + safeRadius, y: center.y, z: center.z }),
    project({ x: center.x, y: center.y + safeRadius, z: center.z }),
    project({ x: center.x, y: center.y, z: center.z + safeRadius }),
  ].map(point => Math.hypot(point.x - origin.x, point.y - origin.y) / safeRadius).sort((a, b) => a - b);
  // The two largest are the screen-plane axes; their mean is the local px-per-world-unit scale.
  return (factors[1]! + factors[2]!) / 2;
}

/** The one equator that reads best from this camera: the most face-on great circle, faded by the
 * flatness of its projected ellipse. Never more than one circle per sphere; null when every circle
 * is edge-on (flatness below the cutoff) and would read as a meaningless straight line. */
const flatnessScratchX = new Float64Array(64);
const flatnessScratchY = new Float64Array(64);
export function chosenEquator(
  circles: readonly (readonly Coordinates[])[],
  project: (point: Coordinates) => ProjectedPoint,
): { readonly circle: readonly Coordinates[]; readonly fade: number; readonly flatness: number } | null {
  let best: { circle: readonly Coordinates[]; fade: number; flatness: number } | null = null;
  for (const circle of circles) {
    if (circle.length < 3) continue;
    const step = Math.max(1, Math.floor(circle.length / 16));
    let count = 0;
    for (let index = 0; index < circle.length; index += step) {
      const point = project(circle[index]!);
      flatnessScratchX[count] = point.x;
      flatnessScratchY[count] = point.y;
      count += 1;
    }
    const flatness = flatnessOfSamples(flatnessScratchX, flatnessScratchY, count);
    if (greatCircleFade(flatness) <= 0) continue;
    if (!best || flatness > best.flatness) best = { circle, fade: greatCircleFade(flatness), flatness };
  }
  return best;
}

/** `projectedFlatness` over scratch buffers: same covariance, no per-circle allocation. */
function flatnessOfSamples(xs: Float64Array, ys: Float64Array, count: number): number {
  if (count < 3) return 0;
  let meanX = 0, meanY = 0;
  for (let index = 0; index < count; index++) { meanX += xs[index]!; meanY += ys[index]!; }
  meanX /= count;
  meanY /= count;
  let xx = 0, yy = 0, xy = 0;
  for (let index = 0; index < count; index++) {
    const dx = xs[index]! - meanX, dy = ys[index]! - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const trace = xx + yy;
  const root = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const major = (trace + root) / 2, minor = (trace - root) / 2;
  return major <= 1e-12 ? 0 : clamp(Math.sqrt(Math.max(0, minor) / major), 0, 1);
}

/** An inner container sphere draws in 3D only when selected/hovered, open (children visible) or
 * large on screen; the NousOS shell and the domain spheres always draw. */
export const CONTAINER_SPHERE_MIN_PX = 40;
export function containerSphereLOD(level: number, open: boolean, selected: boolean, projectedRadiusPx: number): boolean {
  if (level <= 1) return true;
  return open || selected || projectedRadiusPx >= CONTAINER_SPHERE_MIN_PX;
}

/** Below this projected radius a sphere is a single thin circle: at that size a fill, a rim light
 * and an equator cost far more than they could ever show (D-072 V8 distance simplification). */
export const CONTAINER_SPHERE_TINY_PX = 12;

/** Adaptive sphere resolution (D-072 V8): the number of limb and equator segments follows the
 * projected radius — about 24 below 40 px (indistinguishable from a circle at that size) up to 64
 * for large spheres. */
export const SPHERE_MIN_SEGMENTS = 24;
export const SPHERE_MAX_SEGMENTS = 64;
export const MOVING_SPHERE_SEGMENTS = 16;
export const SPHERE_SEGMENT_TIERS: readonly { readonly minPx: number; readonly segments: number }[] = [
  { minPx: 0, segments: SPHERE_MIN_SEGMENTS },
  { minPx: 40, segments: 32 },
  { minPx: 100, segments: 48 },
  { minPx: 200, segments: SPHERE_MAX_SEGMENTS },
];
/** The segment count a sphere of this projected radius draws with: the highest tier it reaches. */
export function sphereSegmentCount(projectedRadiusPx: number): number {
  let segments = SPHERE_MIN_SEGMENTS;
  for (const tier of SPHERE_SEGMENT_TIERS) if (projectedRadiusPx >= tier.minPx) segments = tier.segments;
  return segments;
}
/** One shared unit-circle table per tier: cos/sin at k/segments of a turn, closing point included.
 * Precomputed once at module load; drawing a circle from it allocates nothing per frame. */
export type CircleTable = { readonly cos: Float64Array; readonly sin: Float64Array };
const CIRCLE_TABLES: ReadonlyMap<number, CircleTable> = new Map([...SPHERE_SEGMENT_TIERS.map(tier => [tier.segments, {
  cos: Float64Array.from({ length: tier.segments + 1 }, (_, index) => Math.cos(index / tier.segments * Math.PI * 2)),
  sin: Float64Array.from({ length: tier.segments + 1 }, (_, index) => Math.sin(index / tier.segments * Math.PI * 2)),
}] as const), [MOVING_SPHERE_SEGMENTS, {
  cos: Float64Array.from({ length: MOVING_SPHERE_SEGMENTS + 1 }, (_, index) => Math.cos(index / MOVING_SPHERE_SEGMENTS * Math.PI * 2)),
  sin: Float64Array.from({ length: MOVING_SPHERE_SEGMENTS + 1 }, (_, index) => Math.sin(index / MOVING_SPHERE_SEGMENTS * Math.PI * 2)),
}] as const]);
export function sphereSegmentsForQuality(projectedRadiusPx: number, quality: "full" | "moving"): number {
  return quality === "moving" ? MOVING_SPHERE_SEGMENTS : sphereSegmentCount(projectedRadiusPx);
}
function circleTable(segments: number): CircleTable {
  return CIRCLE_TABLES.get(segments) ?? CIRCLE_TABLES.get(SPHERE_MAX_SEGMENTS)!;
}

/** Selection state the container layer needs: a focused or hovered pearl shows its sphere. */
export type ContainerInteraction = {
  readonly hoverId?: string | null;
  readonly focusIds?: ReadonlySet<string> | null;
  readonly dimFocus?: { readonly members: ReadonlySet<string> } | null;
  /**
   * The pearl/soma disc set the review's label pass placed its collision with, shared through the
   * presentation interaction object so the canvas title pass and the DOM label pass avoid one and
   * the same discs — and therefore agree on where every title sits. Absent: the canvas layer uses
   * the discs it derives from its own drawing.
   */
  readonly labelDiscs?: readonly CanvasDisc[] | null;
  /**
   * The palette's `container` role, as `#rrggbb` or `rgb(r, g, b)`: the colour the containers draw
   * with (2D rings, 3D limbs, equators, rim light, titles), clamped in lightness against the field
   * by `containerInkRgb`. Absent: the historical field-derived neutral ink.
   */
  readonly containerColor?: string | null;
  /**
   * Drawing quality of the pass (D-072 V8). `"moving"` is the reduced frame drawn while the camera
   * rotates or zooms: limbs only for the spheres that carry the structure (levels ≤ 1, plus open
   * or selected pearls), no rim-light gradients, no equators, and titles only for levels ≤ 1.
   * `"full"` — the default when absent — draws the complete spheres exactly as a still frame.
   */
  readonly quality?: "full" | "moving";
};

/** One projected obstacle a label must stay clear of: a pearl or soma disc. The optional id marks
 * the disc as some anchor's own, which never rejects that anchor's label. */
export type CanvasDisc = { readonly x: number; readonly y: number; readonly radius: number; readonly id?: string };

/** Channel sum above which a field counts as light — the same heuristic the fixed ink always used. */
const FIELD_LIGHT_CHANNEL_SUM = 380;

/** On a light field the container ink may not be lighter than this channel sum (a mid-dark grey):
 * above it the shells stop reading against a pale background. */
export const CONTAINER_INK_LIGHT_FIELD_MAX_SUM = 344;
/** On a dark field the container ink may not be darker than this channel sum (a mid-light grey):
 * below it the shells sink into the night. Every shipped preset's container role sits above it
 * (monochrome `#ebebeb` sums 705), so presets draw unclamped; only a user-chosen too-dark role
 * is lifted toward white until it reads. */
export const CONTAINER_INK_DARK_FIELD_MIN_SUM = 444;

function channelSum(colour: string): number {
  const values = colour.match(/[\d.]+/g)?.map(Number) ?? [];
  return (values[0] ?? 0) + (values[1] ?? 0) + (values[2] ?? 0);
}

function hexChannels(hex: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const digits = match[1]!;
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
}

/**
 * The ink the containers draw with: the palette's `container` role when one is supplied, clamped in
 * lightness against the field so a role too close to the background still reads — a light role on a
 * light field is darkened along the line to black, a dark role on a dark field is lightened along
 * the line to white, so the role's hue survives the clamp and the legend swatch stays truthful.
 * Without a role (pure callers, non-review mounts) the historical fixed ink stays exactly as it
 * was. Pure over its two strings, so the clamp is testable without a canvas.
 */
export function containerInkRgb(containerColor: string | null | undefined, fieldColor: string): string {
  const fieldIsLight = channelSum(fieldColor) > FIELD_LIGHT_CHANNEL_SUM;
  const fallback = fieldIsLight ? "20, 20, 20" : "235, 235, 235";
  const parsed = typeof containerColor === "string"
    ? containerColor.startsWith("#") ? hexChannels(containerColor) : (() => {
      const values = containerColor.match(/[\d.]+/g)?.map(Number) ?? [];
      return values.length >= 3 && values.slice(0, 3).every(value => Number.isFinite(value))
        ? [values[0]!, values[1]!, values[2]!] as const : null;
    })()
    : null;
  if (!parsed) return fallback;
  const sum = parsed[0] + parsed[1] + parsed[2];
  if (fieldIsLight) {
    if (sum <= CONTAINER_INK_LIGHT_FIELD_MAX_SUM) return `${parsed[0]}, ${parsed[1]}, ${parsed[2]}`;
    const scale = CONTAINER_INK_LIGHT_FIELD_MAX_SUM / sum;
    return parsed.map(value => Math.round(value * scale)).join(", ");
  }
  if (sum >= CONTAINER_INK_DARK_FIELD_MIN_SUM) return `${parsed[0]}, ${parsed[1]}, ${parsed[2]}`;
  const mix = (CONTAINER_INK_DARK_FIELD_MIN_SUM - sum) / (765 - sum);
  return parsed.map(value => Math.round(value + (255 - value) * mix)).join(", ");
}

/** Peak alpha of the glass rim light at the shell limb. Discreet: the background stays dark. */
export const CONTAINER_RIM_LIGHT_PEAK = 0.16;

/** The rim light of a container sphere: a thin radial gradient just inside the limb, brighter at
 * the rim and transparent toward the centre (soap-bubble glass). Nothing is added inside
 * `innerRadius × limbRadius`, so the total added alpha at the centre of the sphere is the first
 * stop's alpha — at most 0.04 by construction. */
export function containerRimLight(level: number): {
  readonly innerRatio: number;
  readonly stops: readonly { readonly offset: number; readonly alpha: number }[];
} {
  const peak = level === 0 ? CONTAINER_RIM_LIGHT_PEAK : clamp(CONTAINER_RIM_LIGHT_PEAK - level * 0.02, 0.06, CONTAINER_RIM_LIGHT_PEAK);
  return {
    innerRatio: 0.7,
    stops: [
      { offset: 0, alpha: 0 },
      { offset: 0.62, alpha: peak * 0.25 },
      { offset: 0.9, alpha: peak },
      { offset: 1, alpha: peak * 0.5 },
    ],
  };
}

/** Trailing separators a truncation never leaves before its «…»: the cut must fall on a word, not
 * right after a «·», «-», «—», «–», «|», «,», «;» or «:» («Signal Stack ·…» loses «sistema» for
 * nothing; «Beacon,…» keeps a comma that cuts nothing). */
const TRAILING_SEPARATORS = /[\s\u00B7\u2022\u2219,;:\-—–|]+$/;
export function stripTrailingSeparators(text: string): string {
  return text.replace(TRAILING_SEPARATORS, "");
}

/** Italian and English function words a shortened text must not end on before its «…». */
const ELLIPSIS_FUNCTION_WORDS = new Set([
  "e", "ed", "o", "od", "di", "del", "dello", "della", "dei", "degli", "delle", "a", "al", "allo", "alla", "ai", "agli", "alle",
  "da", "dal", "dalla", "in", "nel", "nella", "nei", "con", "su", "sul", "sulla", "per", "tra", "fra", "come", "durante",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "che", "non",
  "and", "or", "of", "for", "to", "the", "an", "with", "on", "at", "by", "from", "as", "into", "via",
]);
function endsOnFunctionWord(text: string): boolean {
  const last = text.split(/\s+/).pop() ?? "";
  // «AI» is a word here, not the Italian preposition «ai».
  return last !== "AI" && ELLIPSIS_FUNCTION_WORDS.has(last.toLocaleLowerCase("it"));
}

/** A text that does not fit is cut on a word boundary and ends with «…»; the complete text stays in
 * the tooltip. A cut never lands right after a separator. Pure: the caller supplies the width
 * function. */
export function ellipsizeText(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const words = text.split(/\s+/);
  for (let count = words.length - 1; count > 0; count -= 1) {
    const kept = stripTrailingSeparators(words.slice(0, count).join(" "));
    if (!kept) continue;
    // A cut never ends on a function word («… V1 e…», «… Building with…»): fewer words read better.
    if (endsOnFunctionWord(kept)) continue;
    const candidate = `${kept}…`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  const characters = [...text];
  for (let count = characters.length - 1; count > 0; count -= 1) {
    const kept = stripTrailingSeparators(characters.slice(0, count).join(""));
    if (!kept) continue;
    const candidate = `${kept}…`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  return "…";
}

/**
 * `ellipsizeText` for a text carrying a « · +N» count suffix: the count is never the part cut. Only
 * the title part is ellipsized (on a word boundary), and the suffix is re-attached after it —
 * «Clarem Lucentina Signif… · +12», never «Clarem Lucentina Significato · +».
 */
export function ellipsizeTextKeepCount(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const suffix = text.match(/\s·\s\+\d+$/)?.[0];
  if (!suffix) return ellipsizeText(text, maxWidth, measure);
  const budget = maxWidth - measure(suffix);
  if (budget <= measure("…")) return ellipsizeText(text, maxWidth, measure);
  return `${ellipsizeText(text.slice(0, text.length - suffix.length), budget, measure)}${suffix}`;
}

/** Tiny truncations carry no useful name, even when they retain a count suffix. */
export function readableTruncatedText(text: string): boolean {
  const title = text.replace(/\s·\s\+\d+$/, "").trim();
  const before = title.includes("…") ? title.slice(0, title.indexOf("…")) : title;
  return !title.includes("…") || [...before.trim()].length >= 4;
}

function containerSelected(container: MorphologyContainerPath, interaction: ContainerInteraction | undefined): boolean {
  return interaction?.hoverId === container.id || (interaction?.focusIds?.has(container.id) ?? false);
}

/** A title rectangle uses this conservative per-character width when no real font is supplied, so
 * the reserved space and the drawn title always agree (the shared predicate below is the single
 * source of truth for both). */
const TITLE_CHAR_WIDTH = 6.5;
export const TITLE_MAX_WIDTH = 190;
/** A closed pearl carries its title this far above its own centre, clear of the pearl itself. */
const PEARL_TITLE_GAP_PX = 12;

/** The exact font a title of this level is drawn in — the measure must use it, so a title that
 * fits the budget at the real font is never truncated by a per-character estimate. */
export function containerTitleFont(level: number): string {
  return `${level <= 2 ? 600 : 400} 12px Arial`;
}

/** Width measurement of a title at the font its level draws with. Pure callers that have no
 * context fall back to the conservative per-character estimate. */
export type TitleMeasure = (text: string, level: number) => number;

const estimatedMeasure: TitleMeasure = (text) => [...text].length * TITLE_CHAR_WIDTH;

// ---------------------------------------------------------------- per-frame drawing caches
//
// Everything below only ever caches values that are pure functions of their key, so a hit can never
// serve a stale value: the key carries every input the value depends on (ink, level, text, measure
// identity). The maps are size-capped and cleared when the cap is reached, so a long session with a
// rotating camera cannot grow them without bound.

export const DRAWING_CACHE_CAP = 1024;
/** Memoised title layouts, one map per measure function (a measure is deterministic: a fixed font).
 * Keyed weakly: a context-bound measure (stableContextMeasurer) captures its context, so a strong
 * registry of measures would pin every renderer's context and canvas after its death. */
let titleLayoutCaches = new WeakMap<TitleMeasure, Map<string, { readonly text: string; readonly width: number }>>();
let containersOrderCaches = new WeakMap<readonly MorphologyContainerPath[], {
  readonly sorted: readonly MorphologyContainerPath[];
  readonly byId: ReadonlyMap<string, MorphologyContainerPath>;
}>();
/** Unit-space sphere gradients, per drawing context (a gradient belongs to the context that built it):
 * keyed by (kind, ink, level), so a palette change is a different key, never a stale hit. */
const SPHERE_GRADIENT_CACHE_CAP = 64;
let sphereGradientCaches = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();
/** World-space samples of a shell circle resampled at a lower tier's resolution, keyed weakly by the
 * circle itself (it dies with its geometry — G10's weak-key rule). At the top tier the layout's own
 * 65-point circle is already the 64-segment table, so its identity — and the renderer's projection
 * memo keyed on it — is kept; lower tiers are built once per (circle, tier), never per frame. */
const EQUATOR_SAMPLE_CACHE_CAP = 16;
let equatorSampleCaches = new WeakMap<readonly Coordinates[], Map<number, readonly Coordinates[]>>();
function equatorSamples(
  circle: readonly Coordinates[],
  container: MorphologyContainerPath,
  segments: number,
): readonly Coordinates[] {
  if (segments >= SPHERE_MAX_SEGMENTS) return circle;
  const axis = (circle as ShellCircle).axis;
  if (!axis) return circle;
  let bySegments = equatorSampleCaches.get(circle);
  if (!bySegments) {
    bySegments = new Map();
    equatorSampleCaches.set(circle, bySegments);
  }
  const hit = bySegments.get(segments);
  if (hit) return hit;
  const table = circleTable(segments);
  const { center, radius } = container;
  const points: Coordinates[] = Array.from({ length: segments + 1 }, (_, index) => {
    const cos = table.cos[index]!, sin = table.sin[index]!;
    if (axis === "xy") return { x: center.x + cos * radius, y: center.y + sin * radius, z: center.z };
    if (axis === "xz") return { x: center.x + cos * radius, y: center.y, z: center.z + sin * radius };
    return { x: center.x, y: center.y + cos * radius, z: center.z + sin * radius };
  });
  if (bySegments.size >= EQUATOR_SAMPLE_CACHE_CAP) bySegments.clear();
  bySegments.set(segments, points);
  return points;
}

/** A context that can compose translate/scale around a cached unit gradient (real canvas contexts
 * can; minimal test doubles may not, and fall back to the per-sphere construction). */
function canComposeTransform(context: CanvasRenderingContext2D): boolean {
  return typeof context.translate === "function" && typeof context.scale === "function"
    && typeof context.save === "function" && typeof context.restore === "function";
}

/** One stable measurer per context, so the title-layout memo (keyed by measure identity) hits across
 * frames while still measuring with the exact context and font it draws with. */
let contextMeasurers = new WeakMap<CanvasRenderingContext2D, TitleMeasure>();
function stableContextMeasurer(context: CanvasRenderingContext2D): TitleMeasure {
  const hit = contextMeasurers.get(context);
  if (hit) return hit;
  const measure: TitleMeasure = (text, level) => {
    context.font = containerTitleFont(level);
    return context.measureText(text).width;
  };
  contextMeasurers.set(context, measure);
  return measure;
}

/** Resets every drawing cache (title layouts, container order, sphere gradients, context measurers,
 * equator samples). Tests use it to observe cache behaviour. */
export function resetDrawingCaches(): void {
  titleLayoutCaches = new WeakMap();
  containersOrderCaches = new WeakMap();
  sphereGradientCaches = new WeakMap();
  contextMeasurers = new WeakMap();
  equatorSampleCaches = new WeakMap();
}
/** Number of memoised title layouts for one measure (bounded by the cap) — the bounded-growth
 * witness. Per measure because the memo is: the measures are held weakly (a context-bound measure
 * dies with its renderer), so there is no set of them to sum over — and none to leak. */
export function drawingCacheSize(measure: TitleMeasure): number {
  return titleLayoutCaches.get(measure)?.size ?? 0;
}

function memoisedTitleLayout(title: string, measure: TitleMeasure, level: number): { readonly text: string; readonly width: number } {
  let cache = titleLayoutCaches.get(measure);
  if (!cache) {
    cache = new Map();
    titleLayoutCaches.set(measure, cache);
  }
  const key = `${level}\u0000${title}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const text = ellipsizeTextKeepCount(title, TITLE_MAX_WIDTH, value => measure(value, level));
  const layout = { text, width: Math.min(TITLE_MAX_WIDTH, Math.max(1, measure(text, level))) };
  if (cache.size >= DRAWING_CACHE_CAP) cache.clear();
  cache.set(key, layout);
  return layout;
}

/** Containers in draw order (level, then id). The sorted copy is memoised per containers array — the
 * array identity is stable across frames in the renderers — so the per-frame sort allocation is gone. */
function containersInDrawOrder(containers: readonly MorphologyContainerPath[]): {
  readonly sorted: readonly MorphologyContainerPath[];
  readonly byId: ReadonlyMap<string, MorphologyContainerPath>;
} {
  const cached = containersOrderCaches.get(containers);
  if (cached) return cached;
  const sorted = [...containers].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const entry = { sorted, byId: new Map(sorted.map(container => [container.id, container])) };
  containersOrderCaches.set(containers, entry);
  return entry;
}

/** One drawing pass's shared container state: the projected limb radius, computed once per container
 * per pass and read by both the sphere pass and the title pass, keyed by the exact `project` closure
 * they share (a different closure — the label pass — gets a fresh cache, never a stale radius). */
export type ContainerFrameCache = {
  project: ((point: Coordinates) => { readonly x: number; readonly y: number }) | null;
  limbPx: Map<MorphologyContainerPath, number>;
};
export function createContainerFrameCache(): ContainerFrameCache {
  return { project: null, limbPx: new Map() };
}
function cachedLimbRadiusPx(cache: ContainerFrameCache | undefined, container: MorphologyContainerPath,
  project: (point: Coordinates) => { readonly x: number; readonly y: number }): number {
  if (!cache) return projectedWorldScale(container.center, container.radius, project);
  if (cache.project !== project) {
    // A cache is only ever shared within one drawing pass; a different closure means a new pass.
    cache.project = project;
    cache.limbPx.clear();
  }
  let value = cache.limbPx.get(container);
  if (value === undefined) {
    value = projectedWorldScale(container.center, container.radius, project);
    cache.limbPx.set(container, value);
  }
  return value;
}

/** The final drawn text of a container title and the width its rectangle reserves: the one layout
 * both the canvas drawer and the DOM label pass read, so a title's ink and its reserved rectangle
 * are the same thing. A « · +N» count suffix always survives; only the name part is ellipsized.
 * The layout is memoised per (measure, level, title): the measure is deterministic (a fixed font), so
 * a repeated frame pays no `measureText`, and a title's ink and rectangle can never diverge. */
export function containerTitleLayout(title: string, measure: TitleMeasure = estimatedMeasure, level = 1): { readonly text: string; readonly width: number } {
  return memoisedTitleLayout(title, measure, level);
}

/** True when an axis-aligned rect overlaps a disc of the given radius around (cx, cy). */
function rectOverlapsDisc(
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const nearestX = Math.min(Math.max(cx, rect.left), rect.left + rect.width);
  const nearestY = Math.min(Math.max(cy, rect.top), rect.top + rect.height);
  return (cx - nearestX) ** 2 + (cy - nearestY) ** 2 <= (radius + 2) ** 2;
}

/** The first candidate rect that no pearl or soma disc covers, or null when every slot is taken. */
function firstFreeRect(candidates: readonly { readonly left: number; readonly top: number; readonly width: number; readonly height: number }[], discs: readonly CanvasDisc[] | undefined): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null {
  for (const rect of candidates) {
    if (discs?.some(disc => rectOverlapsDisc(rect, disc.x, disc.y, disc.radius))) continue;
    return rect;
  }
  return null;
}

/**
 * The single predicate that decides whether a container draws its own title on the canvas, and where.
 * Returns null when no title is drawn (no title, too narrow, off-screen, or every candidate slot
 * covered by a pearl). Both the canvas drawer and the DOM label pass call this, so a container never
 * carries two names. In 3D a container hidden by the sphere LOD is only its pearl: its title anchors
 * right above the pearl instead of the sphere's rim. When `discs` is supplied the title moves to the
 * first free slot around its anchor and is dropped when a pearl would cover every slot. The outline
 * bounds are scanned in place (no per-frame `flat()`/`map` copies); `cache` reuses the limb radius
 * the sphere pass already computed for this exact `project`.
 */
export function containerTitleRect(
  container: MorphologyContainerPath,
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
  discs?: readonly CanvasDisc[],
  measure: TitleMeasure = estimatedMeasure,
  cache?: ContainerFrameCache,
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null {
  if (!container.title) return null;
  if (!readableTruncatedText(containerTitleLayout(container.title, measure, container.level).text)) return null;
  // In 3D titles return with full quality after motion. The 2D moving rule remains level ≤ 1.
  if (interaction?.quality === "moving" && (projection === "3d" || container.level > 1)) return null;
  if (projection === "3d") {
    const center = project(container.center);
    const limbRadiusPx = Math.max(0.5, container.radius * cachedLimbRadiusPx(cache, container, project));
    if (!containerSphereLOD(container.level, container.open !== false, containerSelected(container, interaction), limbRadiusPx)) {
      // Below LOD the container is its pearl and its «+N» name: the title tries the slots around
      // the pearl, its natural place just above it, each clear of the pearl's own disc.
      const width = containerTitleLayout(container.title, measure, container.level).width;
      const gap = limbRadiusPx + PEARL_TITLE_GAP_PX;
      const candidates = [
        { left: center.x - width / 2, top: center.y - gap - 18, width, height: 18 },
        { left: center.x - width / 2, top: center.y + gap, width, height: 18 },
        { left: center.x + gap, top: center.y - 9, width, height: 18 },
        { left: center.x - gap - width, top: center.y - 9, width, height: 18 },
      ].filter(rect => rect.top >= 14 && rect.top < bounds.height - 20
        && rect.left >= 2 && rect.left + rect.width <= bounds.width - 2);
      return firstFreeRect(candidates, discs);
    }
  }
  // Projected outline bounds: the flat ring in 2D, the sphere silhouette (all great circles) in 3D —
  // scanned point by point, the same min/max the projected copies would give, without the copies.
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, count = 0;
  const rings = projection === "3d" ? container.shell ?? [] : [container.points];
  for (const ring of rings) {
    for (const point of ring) {
      const p = project(point);
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
      count += 1;
    }
  }
  if (!count) return null;
  const wideEnough = right - left >= (container.level <= 2 ? 85 : 160);
  if (!wideEnough) return null;
  const width = containerTitleLayout(container.title, measure, container.level).width;
  const centered = (offsetTop: number) => ({ left: (left + right) / 2 - width / 2, top: offsetTop, width, height: 18 });
  // The rim title stays above the outline; the other slots only serve pearl avoidance, never a
  // rim that simply sits too high on screen (the previous rule).
  const preferred = centered(top - 19);
  if (preferred.top < 14 || preferred.top >= bounds.height - 20
    || preferred.left < 2 || preferred.left + preferred.width > bounds.width - 2) return null;
  return firstFreeRect([preferred, centered(top - 39), centered(bottom + 3)], discs);
}

/** Draws the Indra containers (nested circles in 2D, nested translucent spheres in 3D) beneath the
 * relations. Titles are a separate, later pass (`drawContainerTitles`) so a name is never drawn
 * under a pearl. `cache` shares one limb-radius memo between this pass and the title pass. */
export function drawContainers(
  context: CanvasRenderingContext2D,
  morphology: Morphology,
  containers: readonly MorphologyContainerPath[],
  project: (point: Coordinates) => ProjectedPoint,
  fieldColor: string,
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
  cache?: ContainerFrameCache,
): void {
  const hook = dashHook();
  // Per-draw counters for the browser check: they describe the last frame drawn, not the
  // whole session (the flow animation repaints this layer many times per second).
  if (hook) {
    hook.limbs = 0;
    hook.equators = 0;
    hook.minEquatorFlatness = undefined;
    hook.nousosLimb = undefined;
    hook.quality = interaction?.quality === "moving" ? "moving" : "full";
  }
  // The nested shells are the hierarchy. Their lines stay thin, continuous and translucent, and
  // carry the palette's container role (lightness-clamped against the field) as their ink.
  const ink = containerInkRgb(interaction?.containerColor, fieldColor);
  // Limb stroke styles vary only by (ink, level): one string per level per draw, not per sphere.
  const limbStyles = new Map<number, string>();
  for (const container of containersInDrawOrder(containers).sorted) {
    context.globalAlpha = interaction?.dimFocus && !interaction.dimFocus.members.has(container.id) ? 0.15 : 1;
    if (projection === "3d") {
      drawSphere(context, container, project, ink, interaction, bounds, cache, limbStyles);
    } else {
      const outline = container.points;
      if (!outline.length) continue;
      // The exact circle the geometry built, projected point by point — no per-frame point copies.
      context.strokeStyle = `rgba(${ink}, ${container.level === 0 ? 0.42 : clamp(0.95 - container.level * 0.1, 0.3, 0.8)})`;
      context.lineWidth = 0.85 + Math.max(0, 4 - container.level) * 0.18;
      setDash(context, []);
      context.beginPath();
      const first = project(outline[0]!);
      context.moveTo(first.x, first.y);
      for (let index = 1; index < outline.length; index++) {
        const point = project(outline[index]!);
        context.lineTo(point.x, point.y);
      }
      if (typeof context.fill === 'function') {
        context.fillStyle = `rgba(${ink}, ${container.level === 0 ? 0.012 : 0.014})`;
        context.fill();
      }
      context.stroke();
    }
  }
  context.globalAlpha = 1;
  setDash(context, []);

  /** A radial gradient in unit space (radius 1 around the origin), cached per context and key: the
   * drawing pass composes translate + scale around it, so one gradient serves every sphere of the
   * same (ink, level) at any radius — the geometry under the composed transform is exactly the
   * gradient the per-sphere construction would build, and the stops are a pure function of the key. */
  function unitGradient(
    key: string,
    innerX: number, innerY: number, innerRadius: number,
    build: (gradient: CanvasGradient) => void,
  ): CanvasGradient | null {
    if (typeof context.createRadialGradient !== "function") return null;
    let byKey = sphereGradientCaches.get(context);
    if (!byKey) {
      byKey = new Map();
      sphereGradientCaches.set(context, byKey);
    }
    const hit = byKey.get(key);
    if (hit) return hit;
    const gradient = context.createRadialGradient(innerX, innerY, innerRadius, 0, 0, 1);
    build(gradient);
    if (byKey.size >= SPHERE_GRADIENT_CACHE_CAP) byKey.clear();
    byKey.set(key, gradient);
    return gradient;
  }

  /** The projected limb circle plus a faint glass fill, a rim light just inside the limb, and at most
   * one equator, chosen as the most face-on great circle and faded by its projected flatness; its
   * back half is dimmer than its front half, always continuous, never dashed. Containers below the
   * sphere LOD draw no sphere at all: they are carried by their pearl and their «+N» title.
   * D-072 V8: the limb and equator segment counts follow the projected radius (shared precomputed
   * unit-circle tables); the `moving` quality draws limbs only (no gradients, no equator); a sphere
   * under `CONTAINER_SPHERE_TINY_PX` on screen is a single thin circle. */
  function drawSphere(
    context: CanvasRenderingContext2D,
    container: MorphologyContainerPath,
    project: (point: Coordinates) => ProjectedPoint,
    ink: string,
    interaction: ContainerInteraction | undefined,
    bounds: { readonly width: number; readonly height: number },
    cache: ContainerFrameCache | undefined,
    limbStyles: Map<number, string>,
  ): void {
    const hook = dashHook();
    const center = project(container.center);
    const moving = interaction?.quality === "moving";
    const open = container.open !== false;
    const selected = containerSelected(container, interaction);
    // True projected radius, measured on the projection itself (world radius × px per world unit).
    const limbRadius = Math.max(0.5, container.radius * cachedLimbRadiusPx(cache, container, project));
    if (!containerSphereLOD(container.level, open, selected, limbRadius)) return;
    // The moving pass keeps only the limbs of the spheres that carry the structure: the absolute
    // shell and the domains always, any other pearl only while open or selected.
    if (moving && container.level > 1 && !open && !selected) return;
    // A sphere wholly outside the canvas draws nothing a viewer could see; the NousOS shell keeps its
    // witness (the framing checks read it) even while panned out.
    if (container.level > 0 && (center.x + limbRadius < -2 || center.x - limbRadius > bounds.width + 2
      || center.y + limbRadius < -2 || center.y - limbRadius > bounds.height + 2)) return;
    // Distance simplification: a sphere this small on screen is a single thin circle — its fill, rim
    // light and equator could never read at that size.
    const tiny = limbRadius < CONTAINER_SPHERE_TINY_PX;
    // Adaptive resolution: the segment count follows the projected radius, from the shared tables.
    const segments = sphereSegmentsForQuality(limbRadius, moving ? "moving" : "full");
    const table = circleTable(segments);
    if (!tiny && !moving) {
      // Subtle radial gradient fill: a translucent glass sphere with the light gathered off-centre, and
      // a glass rim light brighter at the limb — both proportional to the limb radius, so one cached
      // unit gradient per (ink, level) serves every sphere, composed under translate + scale.
      if (typeof context.createRadialGradient === "function") {
        const fillAlpha = container.level === 0 ? 0.07 : clamp(0.05 - container.level * 0.004, 0.02, 0.05);
        const rim = containerRimLight(container.level);
        // The unit gradients are only worth building where they can be composed (translate + scale);
        // a minimal context without them falls straight to the per-sphere construction.
        const compose = canComposeTransform(context);
        const fill = compose ? unitGradient(`sphere-fill\u0000${ink}\u0000${container.level}`, -0.32, -0.32, 0.06, gradient => {
          gradient.addColorStop(0, `rgba(${ink}, ${fillAlpha})`);
          gradient.addColorStop(0.62, `rgba(${ink}, ${fillAlpha * 0.5})`);
          gradient.addColorStop(1, `rgba(${ink}, 0)`);
        }) : null;
        // Unit geometry: light gathered off-centre at (−0.32, −0.32), from 0.06 out to the limb at 1;
        // the rim light spans the outer 30 % of the radius, transparent toward the centre.
        const rimGradient = compose ? unitGradient(`sphere-rim\u0000${ink}\u0000${container.level}`, 0, 0, rim.innerRatio, gradient => {
          for (const stop of rim.stops) gradient.addColorStop(stop.offset, `rgba(${ink}, ${stop.alpha})`);
        }) : null;
        if (fill && rimGradient) {
          context.save();
          context.translate(center.x, center.y);
          context.scale(limbRadius, limbRadius);
          context.fillStyle = fill;
          context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
          context.fillStyle = rimGradient;
          context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
          context.restore();
        } else {
          const gradient = context.createRadialGradient(
            center.x - limbRadius * 0.32, center.y - limbRadius * 0.32, limbRadius * 0.06,
            center.x, center.y, limbRadius);
          gradient.addColorStop(0, `rgba(${ink}, ${fillAlpha})`);
          gradient.addColorStop(0.62, `rgba(${ink}, ${fillAlpha * 0.5})`);
          gradient.addColorStop(1, `rgba(${ink}, 0)`);
          context.fillStyle = gradient;
          context.beginPath(); context.arc(center.x, center.y, limbRadius, 0, Math.PI * 2); context.fill();
          // Glass rim light: brighter at the rim, transparent toward the centre, so the shell reads as a
          // volume instead of a flat disc. Nothing is added over the inner 70 % of the radius.
          const rimAbsolute = context.createRadialGradient(
            center.x, center.y, limbRadius * rim.innerRatio, center.x, center.y, limbRadius);
          for (const stop of rim.stops) rimAbsolute.addColorStop(stop.offset, `rgba(${ink}, ${stop.alpha})`);
          context.fillStyle = rimAbsolute;
          context.beginPath(); context.arc(center.x, center.y, limbRadius, 0, Math.PI * 2); context.fill();
        }
      }
    }
    // The projected silhouette: the level-0 NousOS limb stays light and clearly visible. The circle
    // is a polyline from the shared unit-circle table — `segments` of them at this projected radius.
    const limbAlpha = container.level === 0 ? 0.6 : clamp(0.4 - container.level * 0.03, 0.16, 0.4);
    let limbStyle = limbStyles.get(container.level);
    if (limbStyle === undefined) {
      limbStyle = `rgba(${ink}, ${limbAlpha})`;
      limbStyles.set(container.level, limbStyle);
    }
    context.strokeStyle = limbStyle;
    context.lineWidth = tiny ? 0.5 : container.level === 0 ? 1.1 : 0.75;
    setDash(context, []);
    context.beginPath();
    context.moveTo(center.x + table.cos[0]! * limbRadius, center.y + table.sin[0]! * limbRadius);
    for (let index = 1; index <= segments; index++) {
      context.lineTo(center.x + table.cos[index]! * limbRadius, center.y + table.sin[index]! * limbRadius);
    }
    context.stroke();
    bump(hook, "limbs", 1);
    if (container.level === 0 && hook) hook.nousosLimb = { x: center.x, y: center.y, radiusPx: limbRadius };
    if (tiny || moving) return;
    // At most one equator, the most face-on great circle, faded by flatness so an edge-on circle
    // (a long line with no identifiable meaning) is never drawn. It is sampled at the same adaptive
    // segment count as the limb, from the circle's own world parametrization (cached, never rebuilt).
    const equator = chosenEquator(container.shell ?? [], project);
    if (!equator) return;
    const samples = equatorSamples(equator.circle, container, segments);
    // The NousOS equator never reaches outside the canvas: a tall narrow ellipse pressed against the
    // border reads as geometry with no semantics, so it is not drawn at all there.
    if (container.level === 0) {
      for (const sample of samples) {
        const point = project(sample);
        if (point.x < -1 || point.x > bounds.width + 1 || point.y < -1 || point.y > bounds.height + 1) return;
      }
    }
    bump(hook, "equators", 1);
    if (hook) hook.minEquatorFlatness = Math.min(hook.minEquatorFlatness ?? Infinity, equator.flatness);
    const centerScale = Math.max(center.scale, 1e-4);
    const frontAlpha = (container.level === 0 ? 0.34 : clamp(0.3 - container.level * 0.035, 0.12, 0.3)) * equator.fade;
    const backAlpha = clamp(frontAlpha * 0.32, 0.04, 0.12);
    const band = Math.max(centerScale * 0.08, 1e-4);
    // Consecutive segments whose style string is identical are stroked as subpaths of one path:
    // each segment keeps its own butt-capped subpath (the same pixels as a stroke per segment), and
    // the clamped front/back runs collapse from dozens of stroke calls to a couple. The samples are
    // projected one at a time — no per-frame point array.
    let runStyle: string | null = null;
    let a = project(samples[0]!);
    for (let index = 1; index < samples.length; index++) {
      const b = project(samples[index]!);
      const midScale = (a.scale + b.scale) / 2;
      const front = clamp(0.5 + (midScale - centerScale) / band, 0, 1);
      const alpha = backAlpha + (frontAlpha - backAlpha) * front;
      const style = `rgba(${ink}, ${alpha})`;
      if (style !== runStyle) {
        if (runStyle !== null) {
          context.strokeStyle = runStyle;
          context.stroke();
        }
        context.beginPath();
        runStyle = style;
      }
      context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
      a = b;
    }
    if (runStyle !== null) {
      context.strokeStyle = runStyle;
      context.stroke();
    }
  }
}

/** One container title the shared placement decided to draw, at the rectangle both the canvas and
 * the DOM label pass agree on. */
export type ContainerTitlePlacement = {
  readonly id: string;
  readonly level: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The one placement pass for container titles: outer levels claim their rectangle first (level, then
 * id) and a later title that would overlap an earlier one is skipped. Pure over its inputs, so the
 * canvas drawer and the DOM label pass — fed the same discs — reserve and draw exactly the same
 * titles at the same rectangles: one collision set for titles and node labels. `cache` shares the
 * limb-radius memo with the sphere pass of the same drawing pass (same `project`).
 */
export function placeContainerTitles(
  containers: readonly MorphologyContainerPath[],
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
  discs?: readonly CanvasDisc[],
  measure: TitleMeasure = estimatedMeasure,
  cache?: ContainerFrameCache,
): ContainerTitlePlacement[] {
  const placements: ContainerTitlePlacement[] = [];
  const boxes: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const container of containersInDrawOrder(containers).sorted) {
    if (interaction?.dimFocus && !interaction.dimFocus.members.has(container.id) && container.level > 1) continue;
    const rect = containerTitleRect(container, project, bounds, projection, interaction, discs, measure, cache);
    if (!rect) continue;
    const box = { left: rect.left - 3, top: rect.top, right: rect.left + rect.width + 3, bottom: rect.top + rect.height };
    if (boxes.some(other => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) continue;
    boxes.push(box);
    placements.push({ id: container.id, level: container.level, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  return placements;
}

/** Draws the container titles after (therefore above) all nodes and arcs, exactly where the shared
 * placement put them. A title that does not fit ends with «…» and never loses its « · +N» count. */
export function drawContainerTitles(
  context: CanvasRenderingContext2D,
  morphology: Morphology,
  containers: readonly MorphologyContainerPath[],
  project: (point: Coordinates) => ProjectedPoint,
  fieldColor: string,
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
  discs?: readonly CanvasDisc[],
  measure?: TitleMeasure,
  cache?: ContainerFrameCache,
): void {
  const fieldIsLight = channelSum(fieldColor) > FIELD_LIGHT_CHANNEL_SUM;
  // The title ink is the same role-driven ink the shells draw with, so name and rim agree.
  const ink = containerInkRgb(interaction?.containerColor, fieldColor);
  // One disc set with the review's label pass when it shares its discs; the canvas-derived set only
  // stands in when the channel is absent (pure callers, non-review mounts).
  const effectiveDiscs = interaction?.labelDiscs ?? discs;
  // The width is measured with the very font the title is drawn in, so what fits is what stays. The
  // measurer is memoised per context: one stable identity across frames, so the layout memo hits.
  const effectiveMeasure: TitleMeasure = measure ?? stableContextMeasurer(context);
  const { byId } = containersInDrawOrder(containers);
  for (const placement of placeContainerTitles(containers, project, bounds, projection, interaction, effectiveDiscs, effectiveMeasure, cache)) {
    const container = byId.get(placement.id);
    if (!container?.title) continue;
    const text = containerTitleLayout(container.title, effectiveMeasure, container.level).text;
    // The font is set before the halo so the stroke and the fill share one letterform.
    context.font = containerTitleFont(placement.level);
    // A thin dark halo keeps the name legible over any arc that still runs beneath it.
    if (typeof context.strokeText === "function") {
      context.strokeStyle = fieldIsLight ? "rgba(255, 255, 255, 0.55)" : "rgba(10, 10, 10, 0.6)";
      context.lineWidth = 3;
      context.strokeText(text, placement.left, placement.top + 14, TITLE_MAX_WIDTH);
    }
    context.fillStyle = `rgba(${ink}, ${clamp(0.95 - placement.level * 0.1, 0.5, 0.9)})`;
    context.fillText(text, placement.left, placement.top + 14, TITLE_MAX_WIDTH);
  }
}

// ---------------------------------------------------------------------------------------------
// D-073 W4b: projection containers, curves and fields.
//
// One generic drawer for the derived geometry of any `ProjectionResult` (Indra pearls and orbits,
// Fractal regions and equipotentials, Holographic fields), in 2D and 3D, restricted to the current
// `RenderVisibility`. The geometry is built once per visibility revision from the result alone, so
// the morphology style can only change how it is drawn, never where. Derived geometry has its own
// ink family and is always drawn with continuous strokes.
// ---------------------------------------------------------------------------------------------

export type ProjectionVisualsMorphology = "stellar" | "neural" | "mycelium";
export type ProjectionContainerForm = "circle" | "ring" | "sphere" | "hemisphere" | "loop" | "polyline";

/** One visible container in world coordinates. `points` holds interleaved xyz for loops and polylines. */
export type ProjectionContainerShape = {
  readonly id: string;
  readonly form: ProjectionContainerForm;
  /** Parent-chain depth: outer containers paint first. */
  readonly depth: number;
  readonly memberCount: number;
  readonly cx: number; readonly cy: number; readonly cz: number;
  readonly radius: number;
  readonly points: Float64Array;
};
export type ProjectionCurveShape = {
  readonly id: string;
  readonly purpose: string;
  readonly closed: boolean;
  /** Interleaved xyz. */
  readonly points: Float64Array;
};
/** A field as a node channel: one drawn sample per visible carrier, level in [0, 1] within the whole field. */
export type ProjectionFieldShape = {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: "scalar" | "complex";
  readonly units: string;
  readonly count: number;
  readonly positions: Float64Array;
  readonly levels: Float64Array;
  readonly buckets: Uint8Array;
};
export type ProjectionVisualsGeometry = {
  readonly resultDigest: string;
  readonly revision: number;
  readonly dimension: Dimension;
  readonly containers: readonly ProjectionContainerShape[];
  readonly curves: readonly ProjectionCurveShape[];
  readonly fields: readonly ProjectionFieldShape[];
  /** Visible fields whose carriers have no coordinates (domain `sample`): named, never drawn. */
  readonly undrawnFieldIds: readonly string[];
  readonly source: ProjectionResult;
};

/** Legend classes of the derived geometry, kept apart from every semantic edge class. */
export const PROJECTION_VISUAL_LEGEND: readonly Readonly<{ kind: "container" | "curve" | "field"; colour: string; label: string }>[] = [
  { kind: "container", colour: PALETTES.bw.container, label: "Contenitori derivati (non semantici)" },
  { kind: "curve", colour: PALETTES.bw.concept, label: "Curve derivate (non semantiche)" },
  { kind: "field", colour: PALETTES.bw.attested, label: "Campo scalare come canale del nodo" },
];

/** Morphology changes only these drawing numbers; no coordinate depends on them. */
export const PROJECTION_VISUAL_APPEARANCE: Readonly<Record<ProjectionVisualsMorphology, Readonly<{
  containerWidth: number; containerAlpha: number; curveWidth: number; curveAlpha: number;
  haloWidth: number; haloAlpha: number; ringWidth: number; endpointDots: boolean;
}>>> = {
  stellar: { containerWidth: 0.8, containerAlpha: 0.45, curveWidth: 0.8, curveAlpha: 0.4, haloWidth: 0, haloAlpha: 0, ringWidth: 0.8, endpointDots: false },
  neural: { containerWidth: 0.9, containerAlpha: 0.45, curveWidth: 0.8, curveAlpha: 0.4, haloWidth: 0, haloAlpha: 0, ringWidth: 0.9, endpointDots: false },
  mycelium: { containerWidth: 0.7, containerAlpha: 0.4, curveWidth: 0.7, curveAlpha: 0.35, haloWidth: 0, haloAlpha: 0, ringWidth: 0.8, endpointDots: false },
};

const FIELD_BUCKETS = 8;
const FIELD_RING_BASE_PX = 5;
const FIELD_RING_SPAN_PX = 6;
const FIELD_RING_STEP_PX = 3;
const CONTAINER_SUBPIXEL_PX = 0.75;
const PROJECTION_PICK_TOLERANCE_PX = 5;

const codepointOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const finiteAll = (...values: readonly number[]): boolean => values.every(Number.isFinite);

type ResultShapes = {
  readonly dimension: Dimension;
  readonly depthById: ReadonlyMap<string, number>;
  readonly containerById: ReadonlyMap<string, ProjectionContainerShape>;
  readonly curveById: ReadonlyMap<string, ProjectionCurveShape>;
  readonly levelsByField: ReadonlyMap<string, Float64Array>;
  readonly fieldById: ReadonlyMap<string, MathematicalField>;
};
const shapesByResult = new WeakMap<ProjectionResult, ResultShapes>();
const geometryByVisibility = new WeakMap<RenderVisibility, ProjectionVisualsGeometry>();

function packPoints(points: readonly { readonly x: number; readonly y: number; readonly z?: number }[], what: string): Float64Array {
  const packed = new Float64Array(points.length * 3);
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const z = point.z ?? 0;
    if (!finiteAll(point.x, point.y, z)) throw new TypeError(`${what} has a nonfinite point`);
    packed[index * 3] = point.x; packed[index * 3 + 1] = point.y; packed[index * 3 + 2] = z;
  }
  return packed;
}

function centroidOf(points: Float64Array): readonly [number, number, number] {
  const count = points.length / 3;
  let x = 0, y = 0, z = 0;
  for (let index = 0; index < count; index++) { x += points[index * 3]!; y += points[index * 3 + 1]!; z += points[index * 3 + 2]!; }
  return [x / count, y / count, z / count];
}

function buildResultShapes(result: ProjectionResult, dimension: Dimension): ResultShapes {
  const hemispheres = result.determinism.algorithmId === "indras-pearls";
  const parentById = new Map(result.containers.map(container => [container.visualId, container.parentVisualId]));
  if (parentById.size !== result.containers.length) throw new TypeError("duplicate container visual id");
  const depthById = new Map<string, number>();
  const depthOf = (id: string, trail: Set<string>): number => {
    const known = depthById.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) throw new TypeError(`container parent cycle at ${id}`);
    trail.add(id);
    const parent = parentById.get(id);
    const depth = parent === null || parent === undefined || !parentById.has(parent) ? 0 : depthOf(parent, trail) + 1;
    depthById.set(id, depth);
    return depth;
  };
  const containerById = new Map<string, ProjectionContainerShape>();
  for (const container of result.containers) {
    const id = container.visualId;
    const depth = depthOf(id, new Set());
    const base = { id, depth, memberCount: container.memberCount };
    const none = new Float64Array(0);
    if (container.shape === "region" || container.shape === "contour") {
      const boundary = dimension === "2d" ? container.boundary2 : container.boundary3;
      const minimum = container.shape === "region" ? 3 : 2;
      if (!boundary || boundary.length < minimum) throw new TypeError(`${dimension} ${container.shape} lacks a boundary: ${id}`);
      const points = packPoints(boundary, `container ${id}`);
      const [cx, cy, cz] = centroidOf(points);
      containerById.set(id, { ...base, form: container.shape === "region" ? "loop" : "polyline", cx, cy, cz, radius: 0, points });
      continue;
    }
    const radius = container.radius;
    if (radius === undefined || !(radius > 0) || !Number.isFinite(radius)) throw new TypeError(`container lacks a radius: ${id}`);
    if (dimension === "2d") {
      const center = container.center2;
      if (!center || !finiteAll(center.x, center.y)) throw new TypeError(`2D container lacks a centre: ${id}`);
      containerById.set(id, { ...base, form: "circle", cx: center.x, cy: center.y, cz: 0, radius, points: none });
      continue;
    }
    const center = container.center3;
    if (!center || !finiteAll(center.x, center.y, center.z)) throw new TypeError(`3D container lacks a centre: ${id}`);
    const onBoundaryPlane = hemispheres && Math.abs(center.z) <= 1e-9 * Math.max(1, radius);
    const form: ProjectionContainerForm = container.shape === "circle" ? "ring" : onBoundaryPlane ? "hemisphere" : "sphere";
    containerById.set(id, { ...base, form, cx: center.x, cy: center.y, cz: center.z, radius, points: none });
  }
  const curveById = new Map<string, ProjectionCurveShape>();
  for (const curve of result.curves) {
    const points = dimension === "2d" ? curve.points2 : curve.points3;
    if (!points) throw new TypeError(`${dimension} curve has no ${dimension} points: ${curve.visualId}`);
    curveById.set(curve.visualId, {
      id: curve.visualId, purpose: curve.purpose,
      // An equipotential is a level set: the assembly samples its loop without repeating the first point.
      closed: curve.purpose === "field-contour" && points.length > 2, points: packPoints(points, `curve ${curve.visualId}`),
    });
  }
  const levelsByField = new Map<string, Float64Array>();
  const fieldById = new Map<string, MathematicalField>();
  for (const field of result.fields) {
    if (field.values.length !== field.sampleIds.length) throw new TypeError(`field ${field.id} values do not match its samples`);
    const magnitudes = Float64Array.from(field.values as readonly (number | { readonly re: number; readonly im: number })[],
      value => typeof value === "number" ? value : Math.hypot(value.re, value.im));
    let low = Infinity, high = -Infinity;
    for (const value of magnitudes) {
      if (!Number.isFinite(value)) throw new TypeError(`field ${field.id} has a nonfinite value`);
      low = Math.min(low, value); high = Math.max(high, value);
    }
    levelsByField.set(field.id, magnitudes.map(value => high > low ? (value - low) / (high - low) : 0.5));
    fieldById.set(field.id, field);
  }
  return { dimension, depthById, containerById, curveById, levelsByField, fieldById };
}

/**
 * The visible derived geometry of a projection for one visibility revision. Pure over its inputs:
 * the same result and mask always give the same shapes, in codepoint order of their ids, and the
 * shapes of a result are memoised so a new revision only selects among them.
 */
export function buildProjectionVisuals(result: ProjectionResult, visibility: RenderVisibility, dimension: Dimension): ProjectionVisualsGeometry {
  const cached = geometryByVisibility.get(visibility);
  if (cached && cached.source === result && cached.dimension === dimension) return cached;
  if (visibility.projectionResultDigest !== result.determinism.resultDigest) throw new TypeError("visibility result digest mismatch");
  const positions = dimension === "2d" ? result.positions2 : result.positions3;
  if (result.coordinateState.kind === "no-coordinates") {
    if (result.positions2 || result.positions3) throw new TypeError("refused projection has coordinates");
  } else if (!positions || (dimension === "2d" ? !!result.positions3 : !!result.positions2)) {
    throw new TypeError("projection dimension mismatch");
  }
  let shapes = shapesByResult.get(result);
  if (shapes && shapes.dimension !== dimension) throw new TypeError("projection dimension mismatch");
  if (!shapes) { shapes = buildResultShapes(result, dimension); shapesByResult.set(result, shapes); }
  const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort(codepointOrder);
  for (const id of visibility.containerIds) if (!shapes.containerById.has(id)) throw new TypeError(`Unknown container: ${id}`);
  const containers = sorted(visibility.containerIds).map(id => shapes.containerById.get(id)!)
    .sort((a, b) => a.depth - b.depth || codepointOrder(a.id, b.id));
  const curves = sorted(visibility.curveIds).map(id => {
    const curve = shapes.curveById.get(id);
    if (!curve) throw new TypeError(`Unknown curve: ${id}`);
    return curve;
  });
  const fields: ProjectionFieldShape[] = [];
  const undrawnFieldIds: string[] = [];
  for (const id of sorted(visibility.fieldIds)) {
    const field = shapes.fieldById.get(id);
    if (!field) throw new TypeError(`Unknown field: ${id}`);
    if (field.domain === "sample") { undrawnFieldIds.push(id); continue; }
    const levels = shapes.levelsByField.get(id)!;
    const carried: number[] = [];
    const at: number[] = [];
    for (let index = 0; index < field.sampleIds.length; index++) {
      const sampleId = field.sampleIds[index]!;
      if (field.domain === "node") {
        const point = visibility.nodeIds.has(sampleId) ? positions?.[sampleId] : undefined;
        if (!point) continue;
        at.push(point.x, point.y, (point as { readonly z?: number }).z ?? 0);
      } else {
        const region = visibility.containerIds.has(sampleId) ? shapes.containerById.get(sampleId) : undefined;
        if (!region) continue;
        at.push(region.cx, region.cy, region.cz);
      }
      carried.push(levels[index]!);
    }
    const count = carried.length;
    fields.push({
      id, ordinal: fields.length, kind: field.kind, units: field.units, count,
      positions: Float64Array.from(at), levels: Float64Array.from(carried),
      buckets: Uint8Array.from(carried, level => Math.min(FIELD_BUCKETS - 1, Math.floor(level * FIELD_BUCKETS))),
    });
  }
  const geometry: ProjectionVisualsGeometry = {
    resultDigest: result.determinism.resultDigest, revision: visibility.revision, dimension,
    containers, curves, fields, undrawnFieldIds, source: result,
  };
  geometryByVisibility.set(visibility, geometry);
  return geometry;
}

type ProjectionVisualsProject = (point: Coordinates) => { readonly x: number; readonly y: number; readonly scale?: number };
export type ProjectionVisualsDrawOptions = {
  readonly morphology: ProjectionVisualsMorphology;
  readonly quality?: "full" | "moving";
  /** The host size in CSS pixels; containers wholly outside it are not traced. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** The hovered or selected visual id, drawn heavier. */
  readonly emphasisId?: string | null;
  readonly styles?: Readonly<Record<string, Readonly<Record<string, number | string>>>>;
  readonly selectionColor?: string;
};
export type ProjectionVisualsDrawStats = { containers: number; curves: number; fields: number; strokes: number };

const scratch = { x: 0, y: 0, z: 0 };
const project3 = (project: ProjectionVisualsProject, x: number, y: number, z: number) => {
  scratch.x = x; scratch.y = y; scratch.z = z;
  return project(scratch);
};
const visualInk = (options: ProjectionVisualsDrawOptions, id: string, fallback: string): string => {
  const color = options.styles?.[id]?.color;
  return typeof color === "string" ? color : fallback;
};
const fieldRingPx = (level: number, ordinal: number, scale: number): number =>
  (FIELD_RING_BASE_PX + ordinal * FIELD_RING_STEP_PX + level * FIELD_RING_SPAN_PX) * scale;

/** Receives the screen paths of one container: the canvas draws them, the picker measures them. */
interface ContainerPathSink {
  begin(secondary: boolean): void;
  point(x: number, y: number, first: boolean): void;
  circle(x: number, y: number, radius: number): void;
  end(closed: boolean): void;
}

/** Screen radius of a sphere: the mean of the two largest axis scales, allocation free. */
function sphereScreenRadius(project: ProjectionVisualsProject, shape: ProjectionContainerShape): number {
  const origin = project3(project, shape.cx, shape.cy, shape.cz);
  const ox = origin.x, oy = origin.y;
  const safe = Math.max(shape.radius, 1e-6);
  const ax = project3(project, shape.cx + safe, shape.cy, shape.cz);
  const fx = Math.hypot(ax.x - ox, ax.y - oy);
  const ay = project3(project, shape.cx, shape.cy + safe, shape.cz);
  const fy = Math.hypot(ay.x - ox, ay.y - oy);
  const az = project3(project, shape.cx, shape.cy, shape.cz + safe);
  const fz = Math.hypot(az.x - ox, az.y - oy);
  return (fx + fy + fz - Math.min(fx, fy, fz)) / 2;
}

function tracePlane(
  project: ProjectionVisualsProject, sink: ContainerPathSink, shape: ProjectionContainerShape,
  plane: 0 | 1 | 2, table: CircleTable, last: number, secondary: boolean,
): void {
  sink.begin(secondary);
  for (let index = 0; index <= last; index++) {
    const c = table.cos[index]! * shape.radius, s = table.sin[index]! * shape.radius;
    const p = plane === 0 ? project3(project, shape.cx + c, shape.cy + s, shape.cz)
      : plane === 1 ? project3(project, shape.cx + c, shape.cy, shape.cz + s)
        : project3(project, shape.cx, shape.cy + c, shape.cz + s);
    sink.point(p.x, p.y, index === 0);
  }
  sink.end(last === table.cos.length - 1);
}

/**
 * Walks the screen paths of one container. Circles and sphere limbs are exact circles at the
 * projected radius; a hemisphere on the boundary plane is its equator plus two upper meridians;
 * regions and contours follow their sampled boundary. Returns false when nothing is traced
 * (sub-pixel or wholly outside the viewport).
 */
function walkContainer(
  project: ProjectionVisualsProject, shape: ProjectionContainerShape, quality: "full" | "moving",
  viewport: ProjectionVisualsDrawOptions["viewport"], sink: ContainerPathSink,
): boolean {
  if (shape.form === "loop" || shape.form === "polyline") {
    sink.begin(false);
    const count = shape.points.length / 3;
    for (let index = 0; index < count; index++) {
      const p = project3(project, shape.points[index * 3]!, shape.points[index * 3 + 1]!, shape.points[index * 3 + 2]!);
      sink.point(p.x, p.y, index === 0);
    }
    sink.end(shape.form === "loop");
    return true;
  }
  if (shape.form === "circle") {
    const centre = project3(project, shape.cx, shape.cy, shape.cz);
    const x = centre.x, y = centre.y;
    const rim = project3(project, shape.cx + shape.radius, shape.cy, shape.cz);
    const radius = Math.hypot(rim.x - x, rim.y - y);
    if (radius < CONTAINER_SUBPIXEL_PX) return false;
    if (viewport && (x + radius < 0 || y + radius < 0 || x - radius > viewport.width || y - radius > viewport.height)) return false;
    sink.begin(false); sink.circle(x, y, radius); sink.end(false);
    return true;
  }
  const radiusPx = sphereScreenRadius(project, shape);
  if (radiusPx < CONTAINER_SUBPIXEL_PX) return false;
  const centre = project3(project, shape.cx, shape.cy, shape.cz);
  const x = centre.x, y = centre.y;
  if (viewport && (x + radiusPx < 0 || y + radiusPx < 0 || x - radiusPx > viewport.width || y - radiusPx > viewport.height)) return false;
  const tiny = radiusPx < CONTAINER_SPHERE_TINY_PX;
  const table = circleTable(tiny ? MOVING_SPHERE_SEGMENTS : sphereSegmentsForQuality(radiusPx, quality));
  const whole = table.cos.length - 1;
  if (shape.form === "hemisphere") {
    tracePlane(project, sink, shape, 0, table, whole, false);
    if (!tiny && quality === "full") {
      tracePlane(project, sink, shape, 1, table, whole / 2, true);
      tracePlane(project, sink, shape, 2, table, whole / 2, true);
    }
    return true;
  }
  if (shape.form === "ring") { tracePlane(project, sink, shape, 0, table, whole, false); return true; }
  sink.begin(false); sink.circle(x, y, radiusPx); sink.end(false);
  if (!tiny && quality === "full") {
    tracePlane(project, sink, shape, 0, table, whole, true);
    tracePlane(project, sink, shape, 1, table, whole, true);
    tracePlane(project, sink, shape, 2, table, whole, true);
  }
  return true;
}

const fieldScreen = { x: new Float64Array(0), y: new Float64Array(0), scale: new Float64Array(0) };
function fieldScreenBuffers(count: number): typeof fieldScreen {
  if (fieldScreen.x.length < count) {
    const size = Math.max(count, fieldScreen.x.length * 2, 1024);
    fieldScreen.x = new Float64Array(size); fieldScreen.y = new Float64Array(size); fieldScreen.scale = new Float64Array(size);
  }
  return fieldScreen;
}

/**
 * Draws the visible containers, then derived dashed curves, then field channel rings. Allocation free apart from the projector's
 * own return values; nothing is scheduled, so an idle page costs nothing.
 */
export function drawProjectionVisuals(
  context: CanvasRenderingContext2D, geometry: ProjectionVisualsGeometry, project: ProjectionVisualsProject,
  options: ProjectionVisualsDrawOptions, stats?: ProjectionVisualsDrawStats,
): void {
  const appearance = PROJECTION_VISUAL_APPEARANCE[options.morphology];
  const quality = options.quality ?? "full";
  setDash(context, []);
  context.lineJoin = "round";
  context.lineCap = "round";
  const sink = canvasSink;
  sink.context = context; sink.stats = stats;
  for (const shape of geometry.containers) {
    const emphasised = options.emphasisId === shape.id;
    sink.colour = emphasised ? options.selectionColor ?? visualInk(options, shape.id, PALETTES.bw.container)
      : visualInk(options, shape.id, PALETTES.bw.container);
    sink.width = appearance.containerWidth * (emphasised ? 1.6 : 1);
    sink.alpha = Math.min(1, appearance.containerAlpha + (emphasised ? 0.25 : 0));
    if (walkContainer(project, shape, quality, options.viewport, sink) && stats) stats.containers += 1;
  }
  for (const curve of geometry.curves) {
    const count = curve.points.length / 3;
    if (count < 2) continue;
    const emphasised = options.emphasisId === curve.id;
    const colour = emphasised ? options.selectionColor ?? visualInk(options, curve.id, PALETTES.bw.concept)
      : visualInk(options, curve.id, PALETTES.bw.concept);
    setDash(context, curve.purpose === "orbit" ? [2, 5] : [4, 5]);
    context.beginPath();
    for (let index = 0; index < count; index++) {
      const p = project3(project, curve.points[index * 3]!, curve.points[index * 3 + 1]!, curve.points[index * 3 + 2]!);
      if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
    }
    if (curve.closed) context.closePath();
    context.strokeStyle = colour;
    if (appearance.haloWidth > 0 && quality === "full") {
      context.globalAlpha = appearance.haloAlpha;
      context.lineWidth = appearance.haloWidth;
      context.stroke();
      if (stats) stats.strokes += 1;
    }
    context.globalAlpha = Math.min(1, appearance.curveAlpha + (emphasised ? 0.1 : 0));
    context.lineWidth = appearance.curveWidth * (emphasised ? 1.6 : 1);
    context.stroke();
    if (stats) { stats.strokes += 1; stats.curves += 1; }
    if (appearance.endpointDots && !curve.closed && quality === "full") {
      const first = project3(project, curve.points[0]!, curve.points[1]!, curve.points[2]!);
      context.fillStyle = colour;
      context.beginPath();
      context.arc(first.x, first.y, 2, 0, Math.PI * 2);
      context.fill();
    }
    setDash(context, []);
  }
  for (const field of geometry.fields) {
    if (field.count === 0) continue;
    const screen = fieldScreenBuffers(field.count);
    for (let index = 0; index < field.count; index++) {
      const p = project3(project, field.positions[index * 3]!, field.positions[index * 3 + 1]!, field.positions[index * 3 + 2]!);
      screen.x[index] = p.x; screen.y[index] = p.y; screen.scale[index] = p.scale ?? 1;
    }
    context.lineWidth = appearance.ringWidth * (options.emphasisId === field.id ? 1.6 : 1);
    for (let bucket = 0; bucket < FIELD_BUCKETS; bucket++) {
      let any = false;
      for (let index = 0; index < field.count; index++) {
        if (field.buckets[index] !== bucket) continue;
        if (!any) { context.beginPath(); any = true; }
        const x = screen.x[index]!, y = screen.y[index]!;
        const radius = fieldRingPx(field.levels[index]!, field.ordinal, screen.scale[index]!);
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }
      if (!any) continue;
      context.strokeStyle = options.emphasisId === field.id ? options.selectionColor ?? visualInk(options, field.id, PALETTES.bw.attested)
        : visualInk(options, field.id, PALETTES.bw.attested);
      context.globalAlpha = 0.08 + 0.3 * (bucket / (FIELD_BUCKETS - 1));
      context.stroke();
      if (stats) stats.strokes += 1;
    }
    if (stats) stats.fields += field.count;
  }
  context.globalAlpha = 1;
  sink.context = null; sink.stats = undefined;
}

const canvasSink = {
  context: null as CanvasRenderingContext2D | null,
  stats: undefined as ProjectionVisualsDrawStats | undefined,
  colour: "", width: 1, alpha: 1,
  begin(secondary: boolean): void {
    const context = this.context!;
    context.beginPath();
    context.strokeStyle = this.colour;
    context.lineWidth = secondary ? this.width * 0.8 : this.width;
    context.globalAlpha = secondary ? this.alpha * 0.45 : this.alpha;
  },
  point(x: number, y: number, first: boolean): void {
    if (first) this.context!.moveTo(x, y); else this.context!.lineTo(x, y);
  },
  circle(x: number, y: number, radius: number): void {
    this.context!.moveTo(x + radius, y);
    this.context!.arc(x, y, radius, 0, Math.PI * 2);
  },
  end(closed: boolean): void {
    if (closed) this.context!.closePath();
    this.context!.stroke();
    if (this.stats) this.stats.strokes += 1;
  },
};

function segmentDistancePx(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1);
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Measures the screen paths against one pointer position; the nearest path distance wins. */
function pickSink(px: number, py: number) {
  let best = Infinity, startX = 0, startY = 0, lastX = 0, lastY = 0, started = false;
  return {
    get best(): number { return best; },
    begin(): void { started = false; },
    point(x: number, y: number, first: boolean): void {
      if (first || !started) { startX = x; startY = y; started = true; }
      else best = Math.min(best, segmentDistancePx(px, py, lastX, lastY, x, y));
      lastX = x; lastY = y;
    },
    circle(x: number, y: number, radius: number): void { best = Math.min(best, Math.abs(Math.hypot(px - x, py - y) - radius)); },
    end(closed: boolean): void {
      if (closed && started) best = Math.min(best, segmentDistancePx(px, py, lastX, lastY, startX, startY));
    },
  };
}

/**
 * The typed pick of the derived geometry at one screen position: curves first, then field
 * channel rings, then container outlines; within a class the nearest path wins and equal
 * distances fall to the lowest id. Containers are hit on the same paths the drawer traces,
 * so a hit is always on a visible line (circles and regions, sphere limbs and great circles,
 * hemisphere equators and meridians).
 */
export function pickProjectionVisuals(
  geometry: ProjectionVisualsGeometry, project: ProjectionVisualsProject,
  position: Readonly<{ x: number; y: number }>, tolerancePx = PROJECTION_PICK_TOLERANCE_PX,
): PickResult | null {
  let bestCurve: { id: string; distance: number } | null = null;
  for (const curve of geometry.curves) {
    const count = curve.points.length / 3;
    let previous = project3(project, curve.points[0]!, curve.points[1]!, curve.points[2]!);
    let ax = previous.x, ay = previous.y;
    const firstX = ax, firstY = ay;
    let distance = Infinity;
    for (let index = 1; index < count; index++) {
      previous = project3(project, curve.points[index * 3]!, curve.points[index * 3 + 1]!, curve.points[index * 3 + 2]!);
      distance = Math.min(distance, segmentDistancePx(position.x, position.y, ax, ay, previous.x, previous.y));
      ax = previous.x; ay = previous.y;
    }
    if (curve.closed && count > 2) distance = Math.min(distance, segmentDistancePx(position.x, position.y, ax, ay, firstX, firstY));
    if (distance <= tolerancePx && (!bestCurve || distance < bestCurve.distance)) bestCurve = { id: curve.id, distance };
  }
  if (bestCurve) return { kind: "curve", visualId: bestCurve.id };
  let bestField: { id: string; distance: number } | null = null;
  for (const field of geometry.fields) {
    for (let index = 0; index < field.count; index++) {
      const p = project3(project, field.positions[index * 3]!, field.positions[index * 3 + 1]!, field.positions[index * 3 + 2]!);
      const radius = fieldRingPx(field.levels[index]!, field.ordinal, p.scale ?? 1);
      const distance = Math.abs(Math.hypot(position.x - p.x, position.y - p.y) - radius);
      if (distance <= tolerancePx && (!bestField || distance < bestField.distance)) bestField = { id: field.id, distance };
    }
  }
  if (bestField) return { kind: "field", visualId: bestField.id };
  let bestContainer: { id: string; distance: number } | null = null;
  for (const shape of geometry.containers) {
    const sink = pickSink(position.x, position.y);
    if (!walkContainer(project, shape, "full", undefined, sink)) continue;
    if (sink.best <= tolerancePx && (!bestContainer || sink.best < bestContainer.distance)) bestContainer = { id: shape.id, distance: sink.best };
  }
  return bestContainer ? { kind: "container", visualId: bestContainer.id } : null;
}
