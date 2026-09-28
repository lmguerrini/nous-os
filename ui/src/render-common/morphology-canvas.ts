import type { AppearanceOptions, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath, MorphologyGeometry, MorphologySegment, SomaOutlineHarmonic } from "#engine/morphology-geometry.ts";
import { SOMA_OUTLINE_MAX_RADIAL, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { createContainerFrameCache, drawContainers, drawContainerTitles } from "#render-common/container-canvas.ts";
import type { CanvasDisc } from "#render-common/container-canvas.ts";
import { drawStarfield } from "#render-common/starfield.ts";
import {
  EDGE_CATEGORY_SET,
  FLOW_HALO_ALPHA,
  FLOW_HALO_WIDTH_MULTIPLIER,
  FLOW_PULSE_WIDTH_MULTIPLIER,
  FLOW_STATIC_CORE_ALPHA,
  flowMotionAllowedNow,
  flowNow,
  flowPhaseAt,
  flowPulseAlpha,
  selectFlowEdges,
  setFlowAnimatedEdgeCount,
} from "#render-common/flow.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
export const DENSE_SCENE_THRESHOLD = 1200;
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  readonly interaction?: { readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null; readonly labelDiscs?: readonly CanvasDisc[] | null } | undefined;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
/** Parsed channel triples, memoised per colour string: the hot loops meet the same handful of
 * colours every frame, so the regex runs once per colour instead of once per pearl per call. */
const COLOUR_CACHE_CAP = 256;
let colourChannelsCache = new Map<string, readonly [number, number, number]>();
function colourChannels(colour: string): readonly [number, number, number] {
  const hit = colourChannelsCache.get(colour);
  if (hit) return hit;
  const values = colour.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  const channels: readonly [number, number, number] = [values[0] ?? 255, values[1] ?? 255, values[2] ?? 255];
  if (colourChannelsCache.size >= COLOUR_CACHE_CAP) colourChannelsCache.clear();
  colourChannelsCache.set(colour, channels);
  return channels;
}
const rgbaChannels = (channels: readonly [number, number, number], alpha: number): string =>
  `rgba(${Math.round(channels[0])}, ${Math.round(channels[1])}, ${Math.round(channels[2])}, ${clamp(alpha, 0, 1)})`;
const dimChannels = (channels: readonly [number, number, number], factor: number): readonly [number, number, number] =>
  [Math.round(channels[0] * factor), Math.round(channels[1] * factor), Math.round(channels[2] * factor)];
const brightenChannels = (channels: readonly [number, number, number], factor: number): readonly [number, number, number] =>
  [Math.round(channels[0] + (255 - channels[0]) * factor), Math.round(channels[1] + (255 - channels[1]) * factor), Math.round(channels[2] + (255 - channels[2]) * factor)];
const rgba = (color: string, alpha: number): string => rgbaChannels(colourChannels(color), alpha);
/** A discreet depth cue: in 3D, points farther than the reference plane dim at most 25% toward black.
 * `scale` is the renderer's per-point perspective size scale, so this is a single scalar per point and
 * never touches a node's epistemic colour or glyph. */
const depthBrightness = (scale: number, projection: "2d" | "3d") =>
  projection === "3d" ? clamp(0.75 + 0.25 * Math.min(1, Math.max(0, scale)), 0.75, 1) : 1;
const dim = (color: string, factor: number): string => {
  if (factor >= 1) return color;
  const values = colourChannels(color);
  return `rgb(${Math.round(values[0] * factor)}, ${Math.round(values[1] * factor)}, ${Math.round(values[2] * factor)})`;
};
const brighten = (color: string, factor: number): string => {
  const values = colourChannels(color);
  return `rgb(${values.slice(0, 3).map(value => Math.round(value + (255 - value) * factor)).join(", ")})`;
};
const tint = (rgb: readonly [number, number, number]) => `rgb(${rgb.map(value => Math.round(value * 255)).join(", ")})`;
const testHook = () => (globalThis as typeof globalThis & { __d070?: { hideEdges?: boolean; hideNodes?: boolean; onlyNodeId?: string } }).__d070;

/** A discreet pearl highlight: never smaller than a visible pixel-and-a-half (so it reads at overview
 * scale), never larger than a fifth of the pearl, placed on the lit upper-left side. */
export function pearlHighlight(radiusPx: number): { readonly radiusPx: number; readonly dx: number; readonly dy: number } {
  return { radiusPx: Math.max(0.9, radiusPx * 0.18), dx: -radiusPx * 0.32, dy: -radiusPx * 0.36 };
}

// ---------------------------------------------------------------- D-071 G9 Neural refinements

/** The Neural mid-edge width never falls below this on-screen floor, so a tapered dendrite never
 * disappears at overview scale (audit: «spessi al nodo, rastremati a metà arco»). */
export const NEURAL_EDGE_MID_MIN_PX = 0.6;

/**
 * The drawn Neural width keyframes (same units as the inputs): the width at each soma end and at
 * mid-edge. The contract's taper gives the soma/mid ratio for the proximal and distal ends, and the
 * segment's larger end width anchors the scale, so the profile keeps the edge's data-driven weight
 * while the rastremazione reads at overview scale (2.2–2.6× the mid width at each end).
 */
export function neuralTaperProfile(widthStart: number, widthEnd: number, taper: readonly [number, number] | readonly number[]) {
  const [proximalRatio = 2.4, distalRatio = 2.2] = taper;
  const mid = Math.max(widthStart, widthEnd) / Math.max(proximalRatio, distalRatio);
  const proximalAtStart = widthStart >= widthEnd;
  return {
    start: mid * (proximalAtStart ? Math.max(proximalRatio, distalRatio) : Math.min(proximalRatio, distalRatio)),
    mid,
    end: mid * (proximalAtStart ? Math.min(proximalRatio, distalRatio) : Math.max(proximalRatio, distalRatio)),
  };
}

/** Deterministic per-soma elongation factor (±12%), driven by the id-hashed outline harmonics'
 * phases, so the same ellipse template is never merely rotated across somata. */
export const SOMA_ELONGATION_JITTER = 0.12;
export function somaElongationFactor(harmonics: readonly SomaOutlineHarmonic[]): number {
  if (harmonics.length === 0) return 1;
  const weighted = harmonics.reduce((sum, harmonic, index) => sum + harmonic.phase * (index + 1), 0);
  return 1 + SOMA_ELONGATION_JITTER * Math.sin(weighted);
}

/** The drawn elongation of one soma: the connection-driven eccentricity with the deterministic
 * per-node jitter, kept inside the geometry's 1.1–1.9 eccentricity bounds. A round soma (no local
 * connections to orient it) is left exactly round. */
export function somaDrawnElongation(eccentricity: number, harmonics: readonly SomaOutlineHarmonic[]): number {
  if (eccentricity <= 1) return eccentricity;
  return clamp(eccentricity * somaElongationFactor(harmonics), Math.min(1.1, eccentricity), 1.9);
}

/** Small somata keep a scaled-down but stronger irregularity than before (floor 0.55 instead of
 * 0.4) and the drawn radial deviation stays within the geometry's ±SOMA_OUTLINE_MAX_RADIAL bound. */
export const SOMA_IRREGULARITY_BOOST = 1.3;
export const SOMA_IRREGULARITY_MIN_SCALE = 0.55;
export function somaIrregularityScale(radiusPx: number): number {
  return clamp(radiusPx / 11, SOMA_IRREGULARITY_MIN_SCALE, 1);
}

/** World-space cell (≈ twice the largest soma radius) used to count overlapping somata per frame. */
export const NEURAL_HALO_DENSITY_CELL = 24;
/** Lower bound of the density-aware halo alpha: hubs stay present, never a wall of bloom. */
export const NEURAL_HALO_ALPHA_FLOOR = 0.45;
/** Halo alpha factor from the number of somata whose centres share a 3×3 neighbourhood: alone 1,
 * then a slow reciprocal falloff to the floor, so dense cores stop merging into one luminous mass. */
export function neuralHaloAlphaFactor(neighbours: number): number {
  if (!(neighbours > 1)) return 1;
  return Math.max(NEURAL_HALO_ALPHA_FLOOR, 1 / (1 + 0.3 * (neighbours - 1)));
}

/** Per-frame count of nearby soma centres for every node, in world space (projection-independent,
 * so 2D and 3D dim the same hub the same way). O(n) build, O(1) per lookup. */
export function neuralHaloNeighbourCounts(nodes: readonly MorphologyGeometry["nodes"][number][]): ReadonlyMap<string, number> {
  const cell = NEURAL_HALO_DENSITY_CELL;
  const grid = new Map<string, number>();
  const cellOf = (node: MorphologyGeometry["nodes"][number]) =>
    `${Math.floor(node.position.x / cell)}:${Math.floor(node.position.y / cell)}`;
  for (const node of nodes) grid.set(cellOf(node), (grid.get(cellOf(node)) ?? 0) + 1);
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const [rawX, rawY] = cellOf(node).split(":");
    const cx = Number(rawX), cy = Number(rawY);
    let total = 0;
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1)
      total += grid.get(`${cx + dx}:${cy + dy}`) ?? 0;
    counts.set(node.id, total);
  }
  return counts;
}

// ---------------------------------------------------------------- cached pearl paint (Indra 3D)
//
// In Indra 3D every pearl draws the same spherical shading, whose colours depend only on (node
// colour, depth, emphasis, base opacity, glow) and whose gradient geometry is proportional to the
// radius. The depth scale is quantised to 1/128 — every channel of every stop then differs from the
// exact per-pearle value by less than 1/255, below what a viewer can notice — and one cached
// unit-space gradient per key then serves every pearl of that key at any radius, composed under
// translate + scale. The key carries every input the paint depends on, so a palette, appearance or
// emphasis change is a different key, never a stale hit; the cache is capped per context.

/** Depth quantisation steps for the cached pearl paint (1/128 keeps every channel within 1/255). */
export const PEARL_DEPTH_STEPS = 128;
/** Below this radius the shading gradient's inner radius is clamped in absolute pixels, so the unit
 * gradient also depends on a quarter-pixel radius bucket. */
const PEARL_PROPORTIONAL_RADIUS_PX = 0.5 / 0.06;
export const PEARL_PAINT_CACHE_CAP = 2048;
const pearlPaintLists: Map<string, PearlPaint>[] = [];

/** Resets the cached pearl paints and parsed colours. Tests use it to observe cache behaviour. */
export function resetPearlCaches(): void {
  pearlPaintLists.length = 0;
  colourChannelsCache.clear();
}
/** Number of cached pearl paints (bounded by the cap) — the bounded-growth witness. */
export function pearlPaintCacheSize(): number {
  let total = 0;
  for (const map of pearlPaintLists) total += map.size;
  return total;
}
function pearlPaintCacheFor(context: CanvasRenderingContext2D): Map<string, PearlPaint> {
  for (const map of pearlPaintLists) if (map.size && pearlPaintOwner.get(map) === context) return map;
  const map = new Map<string, PearlPaint>();
  pearlPaintOwner.set(map, context);
  pearlPaintLists.push(map);
  if (pearlPaintLists.length > 64) {
    const removed = pearlPaintLists.shift();
    if (removed) pearlPaintOwner.delete(removed);
  }
  return map;
}
const pearlPaintOwner = new WeakMap<Map<string, PearlPaint>, CanvasRenderingContext2D>();

/** Every colour string one pearl of this paint key draws with, plus its cached unit gradients. */
export type PearlPaint = {
  /** Dimmed body colour (`rgb(...)` string) and its parsed channels, shared by every part. */
  readonly lit: string;
  readonly litChannels: readonly [number, number, number];
  readonly opacity: number;
  /** Unit-space shading gradient (inner circle at (−0.35, −0.35), radius `shadeInner`, outer at the
   * limb), or null where the context cannot build one. */
  readonly shade: CanvasGradient | null;
  readonly shadeInner: number;
  readonly shadeStops: readonly { readonly offset: number; readonly colour: string }[];
  /** Unit-space glow halo gradient (0 → 1). */
  readonly glow: CanvasGradient | null;
  readonly glowStops: readonly { readonly offset: number; readonly colour: string }[];
  /** Unit-space glint halo gradient (0 → 1). */
  readonly glintHalo: CanvasGradient | null;
  readonly glintHaloStops: readonly { readonly offset: number; readonly colour: string }[];
  readonly rimStroke: string;
  readonly glintFill: string;
};

/** The quantised depth scale a pearl's paint is built from: `scale` clamped and bucketed, so nearby
 * depths share one paint entry while no channel moves more than 1/255 from its exact value. */
export function bucketedDepthScale(scale: number): number {
  return Math.round(clamp(scale, 0, 1) * PEARL_DEPTH_STEPS) / PEARL_DEPTH_STEPS;
}

/** The paint of one pearl, from its key's quantised depth: pure colour computation over parsed
 * channels (no regex, no per-pearl string parsing), with the same rounding the exact path uses. */
export function pearlPaintColours(
  color: string,
  scale: number,
  emphasisBrightness: number,
  baseOpacity: number,
): {
  readonly lit: string;
  readonly litChannels: readonly [number, number, number];
  readonly opacity: number;
  readonly shadeStops: readonly { readonly offset: number; readonly colour: string }[];
  readonly glowStopsFactory: (strength: number, glow: number) => readonly { readonly offset: number; readonly colour: string }[];
  readonly glintHaloStops: readonly { readonly offset: number; readonly colour: string }[];
  readonly rimStroke: string;
  readonly glintFill: string;
} {
  const depth = bucketedDepthScale(scale);
  const brightness = clamp(0.75 + 0.25 * depth, 0.75, 1);
  const litChannels = brightness >= 1 ? colourChannels(color) : dimChannels(colourChannels(color), brightness);
  const depthAlpha = clamp(0.85 + 0.15 * depth, 0.85, 1);
  const opacity = clamp(Math.max(0.48, baseOpacity) * emphasisBrightness * depthAlpha, 0, 1);
  const lit = `rgb(${litChannels[0]}, ${litChannels[1]}, ${litChannels[2]})`;
  return {
    lit,
    litChannels,
    opacity,
    shadeStops: [
      { offset: 0, colour: rgbaChannels(brightenChannels(litChannels, 0.65), opacity) },
      { offset: 0.55, colour: rgbaChannels(litChannels, opacity) },
      { offset: 0.85, colour: rgbaChannels(dimChannels(litChannels, 0.55), opacity) },
      { offset: 1, colour: rgbaChannels(dimChannels(litChannels, 0.35), opacity * 0.9) },
    ],
    glowStopsFactory: (strength, glow) => [
      { offset: 0, colour: rgbaChannels(litChannels, strength * opacity * glow) },
      { offset: 1, colour: rgbaChannels(litChannels, 0) },
    ],
    glintHaloStops: [
      { offset: 0, colour: rgbaChannels(brightenChannels(litChannels, 0.75), opacity * 0.55) },
      { offset: 1, colour: rgbaChannels(litChannels, 0) },
    ],
    rimStroke: rgbaChannels(dimChannels(litChannels, 0.5), opacity * 0.55),
    glintFill: rgbaChannels(brightenChannels(litChannels, 0.9), clamp(opacity, 0, 1)),
  };
}

/** The cached paint of one pearl: colours quantised to the depth bucket, gradients built once per
 * (context, key) in unit space. `radiusBucket` is "" for pearls whose shading geometry is
 * proportional to the radius, and a quarter-pixel bucket below the clamp radius. */
function pearlPaint(
  context: CanvasRenderingContext2D,
  color: string,
  scale: number,
  emphasisBrightness: number,
  emphasisKind: 0 | 1 | 2,
  baseOpacity: number,
  radius: number,
  glow: number,
  glowStrength: number,
): PearlPaint {
  const radiusBucket = radius >= PEARL_PROPORTIONAL_RADIUS_PX ? "" : `r${Math.round(radius * 4)}`;
  // The glow strength is part of the key: the Neural density-aware halo varies it per soma, and a
  // hit must never serve one soma's dimmed bloom as another's full-strength halo.
  const key = `${color}\u0000${emphasisKind}\u0000${Math.round(baseOpacity * 1000)}\u0000${Math.round(glow * 1000)}\u0000${Math.round(glowStrength * 128)}\u0000${bucketedDepthScale(scale)}\u0000${radiusBucket}`;
  const byKey = pearlPaintCacheFor(context);
  const hit = byKey.get(key);
  if (hit) return hit;
  const colours = pearlPaintColours(color, scale, emphasisBrightness, baseOpacity);
  const shadeInner = Math.max(0.5 / Math.max(radius, 0.5), 0.06);
  const build = (stops: readonly { readonly offset: number; readonly colour: string }[], innerX = 0, innerY = 0, innerRadius = 0): CanvasGradient | null => {
    if (typeof context.createRadialGradient !== "function") return null;
    const gradient = context.createRadialGradient(innerX, innerY, innerRadius, 0, 0, 1);
    for (const stop of stops) gradient.addColorStop(stop.offset, stop.colour);
    return gradient;
  };
  const paint: PearlPaint = {
    lit: colours.lit,
    litChannels: colours.litChannels,
    opacity: colours.opacity,
    shade: build(colours.shadeStops, -0.35, -0.35, shadeInner),
    shadeInner,
    shadeStops: colours.shadeStops,
    glow: build(colours.glowStopsFactory(glowStrength, glow)),
    glowStops: colours.glowStopsFactory(glowStrength, glow),
    glintHalo: build(colours.glintHaloStops),
    glintHaloStops: colours.glintHaloStops,
    rimStroke: colours.rimStroke,
    glintFill: colours.glintFill,
  };
  if (byKey.size >= PEARL_PAINT_CACHE_CAP) byKey.clear();
  byKey.set(key, paint);
  return paint;
}

/** A context that can compose translate + scale around a cached unit gradient. */
function canComposeTransform(context: CanvasRenderingContext2D): boolean {
  return typeof context.translate === "function" && typeof context.scale === "function"
    && typeof context.save === "function" && typeof context.restore === "function";
}

/** Fill a unit circle with a cached unit gradient, translated and scaled into place. */
function fillUnitGradient(
  context: CanvasRenderingContext2D,
  gradient: CanvasGradient,
  x: number,
  y: number,
  radius: number,
): void {
  context.save();
  context.translate(x, y);
  context.scale(radius, radius);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** The pearl and soma discs the node pass below draws, with exactly its radii: container titles avoid
 * them, so a name is never covered by a pearl. A neural soma is elongated along its axis, so its
 * disc carries the eccentricity. */
function pearlDiscsFor(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, contract: (typeof MORPHOLOGY_CONTRACT)[keyof typeof MORPHOLOGY_CONTRACT],
  appearance: AppearanceOptions): CanvasDisc[] {
  const discs: CanvasDisc[] = [];
  for (const node of geometry.nodes) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    const elongation = geometry.morphology === "neural"
      ? somaDrawnElongation(Math.max(1, node.eccentricity ?? 1), node.outline ?? [])
      : 1;
    discs.push({ x: p.x, y: p.y, radius: radius * elongation });
  }
  return discs;
}

/** One world-space geometry, with projection and depth scale supplied by the renderer. */
export function drawMorphologyCanvas(context: CanvasRenderingContext2D, geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint, style: MorphologyCanvasStyle,
  appearance: AppearanceOptions = DEFAULT_APPEARANCE, containers: readonly MorphologyContainerPath[] = geometry.containers ?? [],
  projection: "2d" | "3d" = "2d", structureOnly = false): void {
  const canvas = context.canvas;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  context.setTransform(canvas.width / bounds.width, 0, 0, canvas.height / bounds.height, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (geometry.morphology === "stellar") drawStarfield(context, bounds.width, bounds.height, appearance.starfieldDensity, appearance.starfieldBrightness);
  const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
  // The disc set the titles avoid: the review label pass's shared set when present, otherwise the
  // pearls about to be drawn — built lazily so a shared label set skips that whole pass.
  const sharedDiscs = style.interaction?.labelDiscs;
  const pearlDiscs = sharedDiscs ? null : pearlDiscsFor(geometry, style, project, contract, appearance);
  // One projection → limb-radius memo per frame keeps each sphere's outline geometry single-pass.
  const frameCache = createContainerFrameCache();
  drawContainers(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, frameCache);
  // Container titles are placed against the review label pass's disc set when it is shared through
  // the interaction, so a title's reserved rectangle and its ink are the same thing everywhere.
  const titleDiscs: readonly CanvasDisc[] = sharedDiscs ?? pearlDiscs!;
  if (structureOnly) {
  drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs, undefined, frameCache);
  context.globalAlpha = 1;
    return;
  }
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  if (!testHook()?.hideEdges) {
    const hoverId = style.interaction?.hoverId;
    const focusIds = style.interaction?.focusIds;
    const focusPositions = new Map<string, Coordinates>();
    if (focusIds) for (const node of geometry.nodes) if (focusIds.has(node.id)) focusPositions.set(node.id, node.position);
    const sceneExtent = (() => {
      if (!geometry.nodes.length) return 1;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const node of geometry.nodes) {
        minX = Math.min(minX, node.position.x); maxX = Math.max(maxX, node.position.x);
        minY = Math.min(minY, node.position.y); maxY = Math.max(maxY, node.position.y);
        minZ = Math.min(minZ, node.position.z); maxZ = Math.max(maxZ, node.position.z);
      }
      return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    })();
    const nearFocus = (part: MorphologySegment): boolean => {
      if (!focusPositions.size) return false;
      const radius = sceneExtent * 0.22;
      for (const pos of focusPositions.values()) {
        const d1 = Math.hypot(part.source.x - pos.x, part.source.y - pos.y, part.source.z - pos.z);
        const d2 = Math.hypot(part.target.x - pos.x, part.target.y - pos.y, part.target.z - pos.z);
        if (Math.min(d1, d2) <= radius) return true;
      }
      return false;
    };
    const withinViewport = (part: MorphologySegment): boolean => {
      const margin = 12;
      const a = project(part.source), b = project(part.target);
      return (a.x >= -margin && a.x <= bounds.width + margin && a.y >= -margin && a.y <= bounds.height + margin)
        || (b.x >= -margin && b.x <= bounds.width + margin && b.y >= -margin && b.y <= bounds.height + margin);
    };
    const candidates = new Map<string, { visible: boolean; priority: number }>();
    for (const part of geometry.drawnSegments) {
      if (style.edges.get(part.edgeId)?.presentation?.category !== "exploratory") continue;
      const selected = hoverId === part.edgeId || (focusIds?.has(part.edgeId) ?? false);
      const priority = selected ? 0 : nearFocus(part) ? 1 : 2;
      const visible = withinViewport(part);
      const current = candidates.get(part.edgeId);
      if (!current) candidates.set(part.edgeId, { visible, priority });
      else { current.priority = Math.min(current.priority, priority); current.visible ||= visible; }
    }
    const animatedEdges = selectFlowEdges([...candidates].map(([edgeId, value]) =>
      ({ edgeId, visible: value.visible, priority: value.priority })));
    setFlowAnimatedEdgeCount(animatedEdges.size);
    const animating = flowMotionAllowedNow() && appearance.flowIntensity > 0 && appearance.flowSpeed > 0;
    const phase = flowPhaseAt(flowNow(), appearance.flowSpeed);
    const intensity = appearance.flowIntensity;

    const fillRibbon = (points: readonly ProjectedPoint[], widthAt: (i: number) => number): void => {
      const sides = points.map((point, i) => {
        const before = points[Math.max(0, i - 1)]!, after = points[Math.min(points.length - 1, i + 1)]!;
        const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy) || 1;
        const half = widthAt(i) / 2;
        return { left: { x: point.x - dy / length * half, y: point.y + dx / length * half },
          right: { x: point.x + dy / length * half, y: point.y - dx / length * half } };
      });
      context.beginPath(); context.moveTo(sides[0]!.left.x, sides[0]!.left.y);
      for (const side of sides.slice(1)) context.lineTo(side.left.x, side.left.y);
      for (const side of sides.slice().reverse()) context.lineTo(side.right.x, side.right.y);
      context.closePath?.(); context.fill();
    };

    for (const part of geometry.drawnSegments) {
      const edge = style.edges.get(part.edgeId);
      const presentation = edge?.presentation;
      const category = presentation?.category ?? "attested";
      if (!EDGE_CATEGORY_SET.has(category)) continue; // no semantics -> not drawn
      const opacity = (presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
      const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
      const emphasis = hoverId === part.edgeId ? contract.hover
        : focusIds?.has(part.edgeId) ? contract.focus : null;
      const color = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
      const source = simplified && part.samples.length > 8 ? part.samples.filter((_, i) => i % 4 === 0 || i === part.samples.length - 1) : part.samples;
      const points = source.map(project);
      if (points.length < 2) continue;
      // D-071 G9: the Neural profile is anchored on the contract's taper ratios so the rastremazione
      // survives the pixel floors at overview scale; the other morphologies keep their profiles.
      const neuralTaper = geometry.morphology === "neural"
        ? neuralTaperProfile(part.widthStart, part.widthEnd, contract.edge.taper) : null;
      const widthAt = (i: number) => {
        const t = i / (points.length - 1);
        const smooth = t * t * (3 - 2 * t);
        const variation = geometry.morphology === "mycelium" ? 1 + contract.edge.widthVariation * Math.sin(Math.PI * t) ** 2 * Math.cos(t * Math.PI * 4) : 1;
        // Fractional sample positions (the flow pulse asks for midpoints) read the nearest projected scale.
        const scaleAt = points[Math.min(points.length - 1, Math.max(0, Math.round(i)))]!.scale;
        const factors = scaleAt * widthFactor * appearance.edgeWidth * (emphasis?.radiusMultiplier ?? 1) * variation;
        if (neuralTaper) {
          // Quadratic through the three keyframes: the mid width keeps a visible on-screen floor,
          // each soma end keeps the contract ratio above it, and the cap leaves room for the ratio.
          const somaRatio = Math.max(neuralTaper.start, neuralTaper.end) / neuralTaper.mid;
          const mid = clamp(neuralTaper.mid * factors, NEURAL_EDGE_MID_MIN_PX, 16 / somaRatio);
          const start = mid * (neuralTaper.start / neuralTaper.mid);
          const end = mid * (neuralTaper.end / neuralTaper.mid);
          const base = (1 - t) * (1 - t) * start + 2 * t * (1 - t) * (2 * mid - (start + end) / 2) + t * t * end;
          return clamp(base, NEURAL_EDGE_MID_MIN_PX, 16);
        }
        const profile = part.widthStart + (part.widthEnd - part.widthStart) * smooth;
        return clamp(profile * factors, 0.5, 16);
      };
      const alpha = clamp(Math.max(0.14, opacity * appearance.edgeOpacity * (geometry.morphology === "stellar" ? 0.9 : 1)
        * (emphasis?.brightnessMultiplier ?? 1)), 0, 1);
      // Exploratory relations carry a slightly stronger halo, then the flow, over the same continuous base line.
      if (category === "exploratory") {
        context.fillStyle = rgba(color, clamp(alpha * FLOW_HALO_ALPHA, 0, 1));
        fillRibbon(points, (i) => widthAt(i) * FLOW_HALO_WIDTH_MULTIPLIER);
      }
      context.fillStyle = rgba(color, alpha);
      fillRibbon(points, widthAt);
      if (category === "exploratory") {
        const previousComposite = context.globalCompositeOperation;
        context.globalCompositeOperation = "lighter";
        context.lineCap = "round";
        context.lineJoin = "round";
        if (animating && animatedEdges.has(part.edgeId)) {
          const cumulative = [0];
          for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
          const total = cumulative[cumulative.length - 1]! || 1;
          for (let i = 0; i < points.length - 1; i++) {
            const mid = (cumulative[i]! + cumulative[i + 1]!) / 2;
            const pulse = flowPulseAlpha(mid / total, phase, intensity);
            if (pulse <= 0.004) continue;
            context.strokeStyle = rgba(color, clamp(alpha * pulse, 0, 1));
            context.lineWidth = widthAt(i + 0.5) * FLOW_PULSE_WIDTH_MULTIPLIER;
            context.beginPath(); context.moveTo(points[i]!.x, points[i]!.y); context.lineTo(points[i + 1]!.x, points[i + 1]!.y);
            context.stroke();
          }
        } else if (intensity > 0) {
          // Reduced-motion static fallback: a steady, slightly brighter core with no travel.
          context.strokeStyle = rgba(color, clamp(alpha * FLOW_STATIC_CORE_ALPHA * intensity, 0, 1));
          context.lineWidth = Math.max(0.5, widthAt(0) * 0.7);
          context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
          for (const point of points.slice(1)) context.lineTo(point.x, point.y);
          context.stroke();
        }
        context.globalCompositeOperation = previousComposite;
      }
    }
  }
  if (!simplified && geometry.morphology === "mycelium" && !testHook()?.hideEdges) {
    context.fillStyle = rgba("rgb(245, 245, 245)", appearance.edgeOpacity * 0.65);
    for (const junction of geometry.branchPoints) {
      const p = project(junction);
      context.beginPath(); context.arc(p.x, p.y, clamp(1.4 * p.scale * appearance.edgeWidth, 0.9, 3), 0, Math.PI * 2); context.fill();
    }
  }
  // Indra 3D pearls read as glass spheres: soft spherical shading and a small highlight. Flat 3D and
  // the 2D view keep their flat node discs. The whole Indra paint (shading, rim, glint, glow) comes
  // from the depth-bucketed cache above; Flat and 2D keep the exact per-node computation.
  const indra3d = projection === "3d" && containers.length > 0;
  const canTransform = canComposeTransform(context);
  // D-071 G9: Neural halos dim where many somata overlap, so hub cores stop merging into a single
  // luminous mass that invades the dendrites. Built once per frame, only when halos are drawn.
  const haloDensity = geometry.morphology === "neural" && !simplified && appearance.glow > 0 && !testHook()?.hideEdges
    ? neuralHaloNeighbourCounts(geometry.nodes) : null;
  for (const node of (testHook()?.hideNodes ? [] : geometry.nodes)) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    // A pearl wholly outside the canvas (with its glow halo) draws nothing a viewer could see.
    const haloExtent = appearance.glow > 0 ? radius * contract.glow.maximumCoreRatio : radius;
    if (p.x + haloExtent < 0 || p.x - haloExtent > bounds.width
      || p.y + haloExtent < 0 || p.y - haloExtent > bounds.height) continue;
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const baseOpacity = visual?.opacity ?? 1;
    // The effective halo strength carries the Neural density falloff; other morphologies keep theirs.
    const glowStrength = haloDensity
      ? contract.glow.strength * neuralHaloAlphaFactor(haloDensity.get(node.id) ?? 1)
      : contract.glow.strength;
    // In Indra 3D every colour of the pearl comes from one cached paint entry (quantised depth);
    // elsewhere the exact per-node factors stay.
    const paint = indra3d
      ? pearlPaint(context, color, p.scale, emphasis?.brightnessMultiplier ?? 1,
        style.interaction?.hoverId === node.id ? 1 : style.interaction?.focusIds?.has(node.id) ? 2 : 0,
        baseOpacity, radius, appearance.glow, glowStrength)
      : null;
    const lit = paint ? paint.lit : dim(color, depthBrightness(p.scale, projection));
    const litChannels = paint ? paint.litChannels : colourChannels(lit);
    // Depth reads on the pearls themselves: the back ones are slightly fainter (the radius already
    // carries the depth through the projection's size scale).
    const depthAlpha = projection === "3d" ? clamp(0.85 + 0.15 * Math.min(1, Math.max(0, p.scale)), 0.85, 1) : 1;
    const opacity = paint ? paint.opacity
      : clamp(Math.max(0.48, baseOpacity) * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha, 0, 1);
    if (!simplified && appearance.glow > 0 && !testHook()?.hideEdges) {
      const halo = radius * contract.glow.maximumCoreRatio;
      if (paint?.glow && canTransform) {
        fillUnitGradient(context, paint.glow, p.x, p.y, halo);
      } else {
        const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
        gradient.addColorStop(0, rgbaChannels(litChannels, glowStrength * opacity * appearance.glow));
        gradient.addColorStop(1, rgbaChannels(litChannels, 0));
        context.fillStyle = gradient;
        context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
      }
    }
    context.beginPath();
    if (geometry.morphology === "neural") {
      const axis = node.axis ?? { x: 1, y: 0, z: 0 };
      const q = project({ x: node.position.x + axis.x, y: node.position.y + axis.y, z: node.position.z + axis.z });
      const angle = Math.atan2(q.y - p.y, q.x - p.x);
      const basis = [
        project({ x: node.position.x + 1, y: node.position.y, z: node.position.z }),
        project({ x: node.position.x, y: node.position.y + 1, z: node.position.z }),
        project({ x: node.position.x, y: node.position.y, z: node.position.z + 1 }),
      ];
      const projectedUnit = Math.max(1e-9, ...basis.map(value => Math.hypot(value.x - p.x, value.y - p.y)));
      const visibleAxis = clamp(Math.hypot(q.x - p.x, q.y - p.y) / projectedUnit, 0, 1);
      const projectedEccentricity = Math.sqrt(1 + ((node.eccentricity ?? 1) ** 2 - 1) * visibleAxis ** 2);
      // An oriented, organic soma: the ellipse radii carry the connection-driven elongation plus the
      // deterministic per-node jitter (id-hashed phases), the low-frequency harmonics break the
      // perfect-oval sameness — boosted, still within the geometry's radial bound — and large somata
      // show the full irregularity while small ones keep a scaled-down amount so it stays visible.
      const harmonics = node.outline ?? [];
      const eccentricity = somaDrawnElongation(projectedEccentricity, harmonics);
      const major = radius * eccentricity, minor = radius;
      const steps = simplified ? 12 : 24;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const irregularityScale = somaIrregularityScale(radius);
      const somaPath = () => {
        context.beginPath();
        for (let i = 0; i < steps; i += 1) {
          const theta = (i / steps) * Math.PI * 2;
          const bulge = 1 + clamp(
            somaOutlineIrregularity(harmonics, theta) * irregularityScale * SOMA_IRREGULARITY_BOOST,
            -SOMA_OUTLINE_MAX_RADIAL, SOMA_OUTLINE_MAX_RADIAL);
          const ex = major * Math.cos(theta) * bulge;
          const ey = minor * Math.sin(theta) * bulge;
          const x = p.x + cosA * ex - sinA * ey;
          const y = p.y + sinA * ex + cosA * ey;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
      };
      // Softer membrane: a gentle gradient that fades toward the edge of the soma body.
      if (!simplified && typeof context.createRadialGradient === "function") {
        const membrane = context.createRadialGradient(p.x, p.y, radius * 0.12, p.x, p.y, radius * 1.6);
        membrane.addColorStop(0, rgbaChannels(litChannels, opacity));
        membrane.addColorStop(0.5, rgbaChannels(litChannels, opacity * 0.62));
        membrane.addColorStop(1, rgbaChannels(litChannels, opacity * 0.24));
        context.fillStyle = membrane;
      } else context.fillStyle = rgbaChannels(litChannels, opacity);
      somaPath();
      context.fill();
      // Brighter small nucleus inside the softer membrane, oriented with the soma.
      if (!simplified && typeof context.createRadialGradient === "function") {
        const nucleus = context.createRadialGradient(p.x - radius * 0.12, p.y - radius * 0.12, 0, p.x, p.y, radius * 0.5);
        nucleus.addColorStop(0, rgbaChannels(brightenChannels(litChannels, 0.6), opacity));
        nucleus.addColorStop(0.7, rgbaChannels(litChannels, opacity * 0.5));
        nucleus.addColorStop(1, rgbaChannels(litChannels, 0));
        context.fillStyle = nucleus;
        context.beginPath();
        const nx = radius * 0.4, ny = radius * 0.32;
        for (let i = 0; i < 24; i += 1) {
          const theta = (i / 24) * Math.PI * 2;
          const ex = nx * Math.cos(theta);
          const ey = ny * Math.sin(theta);
          const x = p.x + cosA * ex - sinA * ey;
          const y = p.y + sinA * ex + cosA * ey;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
        context.fill();
      }
      // In Indra 3D a soma also carries a small lit glint so it reads as a pearl, not a flat disc.
      if (indra3d) {
        const glint = pearlHighlight(radius);
        context.fillStyle = paint ? paint.glintFill : rgba(brighten(lit, 0.9), clamp(opacity, 0, 1));
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      }
    } else {
      if (indra3d && typeof context.createRadialGradient === "function" && paint) {
        // Soft spherical shading: light gathered off-centre, dimming toward the limb, with a faint
        // rim stroke so the sphere edge stays defined even at overview-scale pearl sizes. The cached
        // unit gradient composes under translate + scale (or the entry's stops rebuild it in place).
        if (paint.shade && canTransform) {
          fillUnitGradient(context, paint.shade, p.x, p.y, radius);
        } else {
          const shade = context.createRadialGradient(
            p.x - radius * 0.35, p.y - radius * 0.35, radius * paint.shadeInner, p.x, p.y, radius);
          for (const stop of paint.shadeStops) shade.addColorStop(stop.offset, stop.colour);
          context.fillStyle = shade;
          context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill();
        }
        context.strokeStyle = paint.rimStroke;
        context.lineWidth = clamp(radius * 0.1, 0.5, 1.2);
        context.beginPath(); context.arc(p.x, p.y, Math.max(0.5, radius - context.lineWidth / 2), 0, Math.PI * 2); context.stroke();
        // A small, bright glint on the lit side, with a soft glow so it survives small radii.
        const glint = pearlHighlight(radius);
        if (radius >= 3) {
          if (paint.glintHalo && canTransform) {
            fillUnitGradient(context, paint.glintHalo, p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4);
          } else {
            const halo = context.createRadialGradient(p.x + glint.dx, p.y + glint.dy, 0, p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4);
            for (const stop of paint.glintHaloStops) halo.addColorStop(stop.offset, stop.colour);
            context.fillStyle = halo;
            context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4, 0, Math.PI * 2); context.fill();
          }
        }
        context.fillStyle = paint.glintFill;
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      } else if (indra3d && typeof context.createRadialGradient === "function") {
        // No cached paint (a context without gradients for the cache): the exact per-pearl path.
        const shade = context.createRadialGradient(
          p.x - radius * 0.35, p.y - radius * 0.35, Math.max(0.5, radius * 0.06), p.x, p.y, radius);
        shade.addColorStop(0, rgba(brighten(lit, 0.65), opacity));
        shade.addColorStop(0.55, rgba(lit, opacity));
        shade.addColorStop(0.85, rgba(dim(lit, 0.55), opacity));
        shade.addColorStop(1, rgba(dim(lit, 0.35), opacity * 0.9));
        context.fillStyle = shade;
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill();
        context.strokeStyle = rgba(dim(lit, 0.5), opacity * 0.55);
        context.lineWidth = clamp(radius * 0.1, 0.5, 1.2);
        context.beginPath(); context.arc(p.x, p.y, Math.max(0.5, radius - context.lineWidth / 2), 0, Math.PI * 2); context.stroke();
        const glint = pearlHighlight(radius);
        if (radius >= 3) {
          const halo = context.createRadialGradient(p.x + glint.dx, p.y + glint.dy, 0, p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4);
          halo.addColorStop(0, rgba(brighten(lit, 0.75), opacity * 0.55));
          halo.addColorStop(1, rgba(lit, 0));
          context.fillStyle = halo;
          context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4, 0, Math.PI * 2); context.fill();
        }
        context.fillStyle = rgba(brighten(lit, 0.9), clamp(opacity, 0, 1));
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      } else {
        context.fillStyle = rgbaChannels(litChannels, opacity);
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    // A neural soma is one closed body. Semantic glyph rings apply only to the other morphologies.
    const glyph = geometry.morphology === "neural" ? "filled" : visual?.glyph ?? "filled";
    if (glyph !== "filled" && !testHook()?.hideEdges) {
      context.strokeStyle = rgbaChannels(litChannels, opacity);
      context.lineWidth = clamp(radius * 0.2, 0.8, 2);
      context.beginPath(); context.arc(p.x, p.y, radius * 0.72, 0, Math.PI * 2); context.stroke();
      if (glyph === "hollow") {
        context.fillStyle = rgba(style.fieldColor, 0.9);
        context.beginPath(); context.arc(p.x, p.y, radius * 0.4, 0, Math.PI * 2); context.fill();
      }
      if (glyph === "double-ring") {
        context.beginPath(); context.arc(p.x, p.y, radius * 0.38, 0, Math.PI * 2); context.stroke();
      }
    }
  }
  // Names come last, above every pearl and arc, so no label is ever covered by its own drawing.
  drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs, undefined, frameCache);
}
