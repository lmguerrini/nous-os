import type { AppearanceOptions, EdgeCategory, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { MorphologyContainerPath, MorphologyGeometry, MorphologyInput, MorphologyNodeShape, MorphologySegment, SomaOutlineHarmonic } from "#engine/morphology-geometry.ts";
import { SOMA_OUTLINE_MAX_RADIAL, somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { createContainerFrameCache, drawContainers, drawContainerTitles } from "#render-common/container-canvas.ts";
import type { CanvasDisc } from "#render-common/container-canvas.ts";
import { STELLAR_DUST_BUCKET_ALPHAS, cachedStellarDustClusters, drawStarfield, stellarDustAlpha, stellarDustFraction } from "#render-common/starfield.ts";
import type { StellarDustCluster } from "#render-common/starfield.ts";
import {
  EDGE_CATEGORY_SET,
  FLOW_HALO_ALPHA,
  FLOW_HALO_WIDTH_MULTIPLIER,
  FLOW_PULSE_WIDTH_MULTIPLIER,
  FLOW_STATIC_CORE_ALPHA,
  flowTailLengthPx,
  flowHeadAlpha,
  flowHeadPositionPx,
  flowHighlightAlpha,
  flowMotionAllowedNow,
  flowNow,
  selectFlowEdges,
  setFlowAnimatedEdgeCount,
} from "#render-common/flow.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
export const DENSE_SCENE_THRESHOLD = 1200;
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  readonly interaction?: { readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null; readonly labelDiscs?: readonly CanvasDisc[] | null;
    readonly dimFocus?: { readonly members: ReadonlySet<string>; readonly arcs: ReadonlySet<string>; readonly bridges: ReadonlySet<string> } | null;
    /** D-072 M1b: the containers already honour this field (I1). `"moving"` is the reduced frame
     * while the camera rotates, pans or zooms: nodes draw as solid fills (no radial gradients,
     * halos, glints or rim strokes), the Stellar dust, cluster glow and starfield are skipped, and
     * Neural dendrites stroke one simple polyline at their mid width. The flow layer is untouched:
     * its owner (P1) decides what it draws. `"full"` (absence) is the complete, exact drawing. */
    readonly quality?: "full" | "moving";
    /** D-072 V13: `"separate"` makes this pass skip the travelling flow highlights because a small
     * dedicated overlay draws them alone via {@link drawFlowLayer}; `"inline"` (absence) keeps
     * today's behaviour of drawing them in this pass. */
    readonly flowLayer?: "inline" | "separate" } | undefined;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};
export function focusNodeOpacity(members: ReadonlySet<string> | null, id: string): number {
  return !members || members.has(id) ? 1 : 0.15;
}
export function focusArcOpacity(
  focus: { arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null, id: string, base: number,
): number {
  return !focus ? base : focus.arcs.has(id) ? Math.max(0.55, base)
    : focus.bridges.has(id) ? 0.38 : 0.08;
}

/** D-072 R2: one in-place level-of-detail swap for a distinct morphology layer. The input and
 * geometry are the fully rebuilt drawing (the caller builds them with the same derivation a
 * remount uses, and later curvature rebuilds must derive from the new input, not the mounted
 * one), the node entries overwrite only what a subset change can flip (an Indra open-container
 * marker), and the edge entries cover every newly drawn relation — the entries of already-mounted
 * edges never change with the subset, because their presentation derives from the relation record
 * alone. */
export type DistinctSubsetUpdate = {
  readonly input: MorphologyInput;
  readonly geometry: MorphologyGeometry;
  readonly nodeEntries: ReadonlyMap<string, { readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined }>;
  readonly edgeEntries: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
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

/** Up to this soma degree a dendrite root keeps the contract's full soma/mid taper ratio. */
export const NEURAL_TAPER_DEGREE_FULL = 4;
/** The taper ratio never falls below this floor, so the rastremazione stays visible on every
 * dendrite however crowded the soma (audit: hub roots must stay separable, not uniform). */
export const NEURAL_TAPER_RATIO_FLOOR = 1.3;

/**
 * The soma-end/mid width ratio one end of a dendrite draws, from that end's own soma degree: the
 * full base ratio up to {@link NEURAL_TAPER_DEGREE_FULL}, then base/√(degree/4), floored at
 * {@link NEURAL_TAPER_RATIO_FLOOR}. Monotone in the degree, deterministic, pure.
 */
export function neuralSomaTaperRatio(baseRatio: number, degree: number): number {
  if (!(degree > NEURAL_TAPER_DEGREE_FULL)) return baseRatio;
  return Math.min(baseRatio,
    Math.max(NEURAL_TAPER_RATIO_FLOOR, baseRatio / Math.sqrt(degree / NEURAL_TAPER_DEGREE_FULL)));
}

/**
 * The drawn Neural width keyframes (same units as the inputs): the width at each soma end and at
 * mid-edge. The contract's taper gives the soma/mid ratio for the proximal and distal ends, each
 * capped by its own end's soma degree ({@link neuralSomaTaperRatio}), and the segment's larger end
 * width anchors the scale, so the profile keeps the edge's data-driven weight while the
 * rastremazione reads at overview scale and the roots of a hub stay separable (D-071 G11).
 */
export function neuralTaperProfile(widthStart: number, widthEnd: number, taper: readonly [number, number] | readonly number[],
  degreeStart = 1, degreeEnd = 1) {
  const [proximalRatio = 2.4, distalRatio = 2.2] = taper;
  const proximalAtStart = widthStart >= widthEnd;
  const startRatio = neuralSomaTaperRatio(
    proximalAtStart ? Math.max(proximalRatio, distalRatio) : Math.min(proximalRatio, distalRatio), degreeStart);
  const endRatio = neuralSomaTaperRatio(
    proximalAtStart ? Math.min(proximalRatio, distalRatio) : Math.max(proximalRatio, distalRatio), degreeEnd);
  const mid = Math.max(widthStart, widthEnd) / Math.max(startRatio, endRatio);
  return { start: mid * startRatio, mid, end: mid * endRatio };
}

/** A dendrite root loses at most this share of its alpha near a high-degree soma: the widths
 * already separate the roots, this keeps the residual stack of edges from re-merging as glow. */
export const NEURAL_ROOT_ALPHA_FLOOR = 0.8;
/** The on-screen reach of the root alpha fade, in pixels along the edge from each soma. */
export const NEURAL_ROOT_FADE_PX = 10;
/** The alpha factor of a dendrite's first pixels at a soma of the given degree: full up to
 * {@link NEURAL_TAPER_DEGREE_FULL}, then a gentle linear falloff to the floor. Pure. */
export function neuralRootAlphaFactor(degree: number): number {
  if (!(degree > NEURAL_TAPER_DEGREE_FULL)) return 1;
  return Math.max(NEURAL_ROOT_ALPHA_FLOOR, 1 - 0.05 * (degree - NEURAL_TAPER_DEGREE_FULL));
}

/** Exact endpoint key of a drawn segment (world-space coordinates, never remultipplied). */
const neuralEndpointKey = (point: Coordinates): string => `${point.x}|${point.y}|${point.z}`;
const neuralEndpointDegreeCache = new WeakMap<MorphologyGeometry, ReadonlyMap<string, number>>();
const neuralEndpointSomaCache = new WeakMap<MorphologyGeometry, ReadonlyMap<string, MorphologyNodeShape>>();
/** The two soma-side ends of a drawn segment; the samples bracket them when a minimal fixture
 * carries no explicit endpoints. */
const segmentEnds = (part: MorphologySegment): readonly (Coordinates | undefined)[] =>
  [part.source ?? part.samples[0], part.target ?? part.samples[part.samples.length - 1]];

/**
 * The nearest soma of every drawn Neural segment endpoint, world-space and deterministic: each
 * endpoint resolves to its nearest soma centre on a fixed grid (the endpoint sits within one soma
 * radius of its own soma by construction). Memoised per geometry, so the per-frame passes pay a map
 * lookup; identical in 2D and 3D (shared canvas layer). D-072 extends the D-071 degree lookup: the
 * junction pass needs the soma itself, the taper pass only its degree.
 */
export function neuralEndpointSomata(geometry: MorphologyGeometry): ReadonlyMap<string, MorphologyNodeShape> {
  const cached = neuralEndpointSomaCache.get(geometry);
  if (cached) return cached;
  let maxRadius = 0;
  for (const node of geometry.nodes) maxRadius = Math.max(maxRadius, node.radius);
  // A cell of at least four max radii keeps every endpoint's own soma inside its 3×3 neighbourhood
  // (the neural inset is bounded by the soma radius times its ≤1.9 eccentricity).
  const cell = Math.max(NEURAL_HALO_DENSITY_CELL, 4 * maxRadius);
  const grid = new Map<string, MorphologyNodeShape[]>();
  for (const node of geometry.nodes) {
    const key = `${Math.floor(node.position.x / cell)}:${Math.floor(node.position.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(node); else grid.set(key, [node]);
  }
  const somaAt = (point: Coordinates): MorphologyNodeShape | null => {
    const cx = Math.floor(point.x / cell), cy = Math.floor(point.y / cell);
    let best: MorphologyNodeShape | null = null;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1)
      for (const node of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const distance = (node.position.x - point.x) ** 2 + (node.position.y - point.y) ** 2 + (node.position.z - point.z) ** 2;
        if (distance < bestDistance) { bestDistance = distance; best = node; }
      }
    return best;
  };
  const somata = new Map<string, MorphologyNodeShape>();
  for (const part of geometry.drawnSegments)
    for (const point of segmentEnds(part)) {
      if (!point) continue;
      const key = neuralEndpointKey(point);
      if (!somata.has(key)) {
        const soma = somaAt(point);
        if (soma) somata.set(key, soma);
      }
    }
  neuralEndpointSomaCache.set(geometry, somata);
  return somata;
}

/**
 * The soma degree at each end of every drawn Neural segment (D-071 G11): the degree of the nearest
 * soma per endpoint, memoised per geometry, world space, and 1 where no soma is found.
 */
export function neuralEndpointDegrees(geometry: MorphologyGeometry): ReadonlyMap<string, number> {
  const cached = neuralEndpointDegreeCache.get(geometry);
  if (cached) return cached;
  const somata = neuralEndpointSomata(geometry);
  const degrees = new Map<string, number>();
  for (const [key, soma] of somata) degrees.set(key, soma.degree);
  // Endpoints whose grid neighbourhood held no soma at all keep the legacy default of 1.
  for (const part of geometry.drawnSegments)
    for (const point of segmentEnds(part)) {
      if (!point) continue;
      const key = neuralEndpointKey(point);
      if (!degrees.has(key)) degrees.set(key, 1);
    }
  neuralEndpointDegreeCache.set(geometry, degrees);
  return degrees;
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

// ---------------------------------------------------------------- D-072 morphology drawing

/** D-072 V4: a Stellar data node draws a readable, nearly opaque core. The floor binds the core's
 * own paint only — size still follows the importance scale, the halo stays faint. */
export const STELLAR_CORE_MIN_ALPHA = 0.9;
/** D-072 V5: a Neural soma draws clearly visible and nearly opaque, no soft membrane wash. */
export const NEURAL_SOMA_MIN_ALPHA = 0.9;
/** The alpha floor of one morphology's node core/soma body: 0.9 for Stellar and Neural (V4/V5),
 * the historical 0.48 for Mycelium. Pure. */
export function morphologyCoreAlphaFloor(morphology: Morphology): number {
  return morphology === "stellar" ? STELLAR_CORE_MIN_ALPHA : morphology === "neural" ? NEURAL_SOMA_MIN_ALPHA : 0.48;
}

// ---------------------------------------------------------------- D-072 M1b star grammar
//
// A Stellar data node draws as a star of the plexus reference: a small, bright, nearly
// opaque core whose size still follows the importance scale (the contract's 2–12 px window the
// layout sizes into), compressed at draw time into the 2–6 px star window — up to 8 px where the
// node's degree marks it a domain hub. The pick radius is untouched: the pickers size from the
// same pre-mapping basis (`radiusPx`/`node.radius`), so clicking never gets harder.

/** Drawn core radius of a regular star, in CSS px: the importance scale compresses into this window. */
export const STELLAR_STAR_CORE_MIN_PX = 2;
export const STELLAR_STAR_CORE_MAX_PX = 6;
/** The window grows toward this cap as the node's degree marks it a domain hub. */
export const STELLAR_STAR_HUB_MAX_PX = 8;
/** Degree at which the hub window starts growing, and at which it reaches the full 8 px. */
export const STELLAR_STAR_HUB_DEGREE = 8;
export const STELLAR_STAR_HUB_FULL_DEGREE = 14;

/** The star-core window of one degree: 6 px up to {@link STELLAR_STAR_HUB_DEGREE}, then a linear
 * rise to 8 px at {@link STELLAR_STAR_HUB_FULL_DEGREE}. Pure, monotone in the degree. */
export function stellarStarCapRadiusPx(degree: number): number {
  const rise = clamp((degree - STELLAR_STAR_HUB_DEGREE) / (STELLAR_STAR_HUB_FULL_DEGREE - STELLAR_STAR_HUB_DEGREE), 0, 1);
  return STELLAR_STAR_CORE_MAX_PX + (STELLAR_STAR_HUB_MAX_PX - STELLAR_STAR_CORE_MAX_PX) * rise;
}

/**
 * The drawn core radius of one Stellar star: the pre-mapping on-screen radius (the importance
 * basis, clamped to the contract's node window) compressed into the star window of this node's
 * degree, through a square root so the scale stays perceptual. Pure, monotone in the basis, and
 * never above it — the drawn star never outgrows the disc the pickers size from the same basis,
 * so clicking never gets harder.
 */
export function stellarStarCoreRadiusPx(baseRadiusPx: number, degree: number): number {
  const max = MORPHOLOGY_CONTRACT.stellar.node.maxRadiusPx;
  const basis = clamp(baseRadiusPx, STELLAR_STAR_CORE_MIN_PX, max);
  const reach = (basis - STELLAR_STAR_CORE_MIN_PX) / (max - STELLAR_STAR_CORE_MIN_PX);
  const cap = stellarStarCapRadiusPx(degree);
  return Math.min(basis, STELLAR_STAR_CORE_MIN_PX + (cap - STELLAR_STAR_CORE_MIN_PX) * Math.sqrt(reach));
}

/** D-072 M1b arc windows (CSS px): intra-community arcs thin and discreet, inter-community
 * bridges slightly stronger, as the reference reads. The presentation's own width/opacity factors
 * modulate inside the window; the categories and exploratory styling are untouched. */
export const STELLAR_ARC_INTRA_WIDTH_PX: readonly [number, number] = [0.6, 0.9];
export const STELLAR_ARC_BRIDGE_WIDTH_PX: readonly [number, number] = [1.0, 1.3];
/** A geometry without declared communities has no classes: a middle window, no invented semantics. */
export const STELLAR_ARC_UNCLASSIFIED_WIDTH_PX: readonly [number, number] = [0.7, 1.1];
/** Base alpha windows: intra arcs faint, bridges near 0.5. Emphasis (hover/focus) may exceed. */
export const STELLAR_ARC_INTRA_ALPHA: readonly [number, number] = [0.2, 0.35];
export const STELLAR_ARC_BRIDGE_ALPHA: readonly [number, number] = [0.35, 0.55];
export const STELLAR_ARC_UNCLASSIFIED_ALPHA: readonly [number, number] = [0.25, 0.45];

const stellarArcWindow = (arcClass: "intra" | "bridge" | undefined, windows: readonly (readonly [number, number])[]) =>
  arcClass === "intra" ? windows[0]! : arcClass === "bridge" ? windows[1]! : windows[2]!;

/** The drawn width of one Stellar arc: the data width times the live factors, held inside its
 * class window. Pure. */
export function stellarArcWidthPx(arcClass: "intra" | "bridge" | undefined, factor: number): number {
  const [low, high] = stellarArcWindow(arcClass, [STELLAR_ARC_INTRA_WIDTH_PX, STELLAR_ARC_BRIDGE_WIDTH_PX, STELLAR_ARC_UNCLASSIFIED_WIDTH_PX]);
  return clamp(factor, low, high);
}

/** The constant base alpha of one Stellar arc: the data opacity mapped into its class window
 * (emphasis applies on top, outside this function). Pure. */
export function stellarArcAlpha(arcClass: "intra" | "bridge" | undefined, factor: number): number {
  const [low, high] = stellarArcWindow(arcClass, [STELLAR_ARC_INTRA_ALPHA, STELLAR_ARC_BRIDGE_ALPHA, STELLAR_ARC_UNCLASSIFIED_ALPHA]);
  return low + (high - low) * clamp(factor, 0, 1);
}

const stellarArcClassCache = new WeakMap<MorphologyGeometry, ReadonlyMap<string, "intra" | "bridge"> | null>();
/**
 * Community classification of every Stellar relation, from the colonies the caller declared:
 * `"intra"` when both endpoints resolve to the same community, `"bridge"` otherwise (a colony-less
 * node is its own singleton). Null when the geometry carries no communities — then every arc keeps
 * its presentation values untouched. Memoised per geometry, deterministic.
 */
export function stellarArcClasses(geometry: MorphologyGeometry): ReadonlyMap<string, "intra" | "bridge"> | null {
  if (stellarArcClassCache.has(geometry)) return stellarArcClassCache.get(geometry) ?? null;
  let classes: ReadonlyMap<string, "intra" | "bridge"> | null = null;
  const colonies = (geometry as { colonies?: readonly { id: string; members: readonly string[] }[] }).colonies;
  if (colonies?.length) {
    const communityOf = new Map<string, string>();
    for (const colony of [...colonies].sort((a, b) => a.id.localeCompare(b.id)))
      for (const member of colony.members) if (!communityOf.has(member)) communityOf.set(member, colony.id);
    const resolved = new Map<string, "intra" | "bridge">();
    for (const edge of geometry.edges ?? []) {
      const source = communityOf.get(edge.source) ?? `node:${edge.source}`;
      const target = communityOf.get(edge.target) ?? `node:${edge.target}`;
      resolved.set(edge.id, source === target ? "intra" : "bridge");
    }
    classes = resolved;
  }
  stellarArcClassCache.set(geometry, classes);
  return classes;
}

/**
 * The decorative Stellar dust of a whole geometry, drawn beneath every arc and pearl: small
 * satellite stars around each declared community's hub (see starfield.ts for generation, budget
 * and the no-identifier rule). Pure wrapper over the per-geometry memo. Only `fillRect` ops, three
 * per cluster at most (one bucket colour at a time): no per-mote gradients, paths or labels.
 */
export function drawStellarDust(context: CanvasRenderingContext2D, clusters: readonly StellarDustCluster[],
  project: (point: Coordinates) => ProjectedPoint, nodeColour: (hubId: string) => string | undefined,
  width: number, height: number, density = 0.25, brightness = 0.35): void {
  const fraction = stellarDustFraction(density);
  if (fraction === 0 || brightness <= 0) return;
  for (const cluster of clusters) {
    const colour = nodeColour(cluster.hubId) ?? STELLAR_DUST_FALLBACK_COLOUR;
    for (let bucket = 0; bucket < STELLAR_DUST_BUCKET_ALPHAS.length; bucket += 1) {
      context.fillStyle = rgba(colour, stellarDustAlpha(bucket as 0 | 1 | 2, brightness));
      const count = Math.floor(cluster.motes.length * fraction);
      for (let index = 0; index < count; index += 1) {
        const mote = cluster.motes[index]!;
        if (mote.bucket !== bucket) continue;
        const p = project(mote.position);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < -2 || p.x > width + 2 || p.y < -2 || p.y > height + 2) continue;
        context.fillRect?.(p.x - mote.size / 2, p.y - mote.size / 2, mote.size, mote.size);
      }
    }
  }
}
const STELLAR_DUST_FALLBACK_COLOUR = "rgb(226, 230, 238)";

/** D-072 M1b: the peak centre alpha of the per-community cluster glow. ≤ 0.06 by brief; one cached
 * radial sprite per (colour, alpha) serves every community, composed under translate + scale. */
export const STELLAR_CLUSTER_GLOW_ALPHA = 0.05;
/** A community smaller than this on screen reads through its stars and dust alone: no glow disc. */
export const STELLAR_CLUSTER_GLOW_MIN_RADIUS_PX = 12;

/**
 * The optional, subtle cluster mass (D-072 M1b): one very faint large radial glow per community,
 * beneath the dust, so a cluster reads as gathered brightness rather than scattered points. One
 * cached unit gradient per (colour, quantised alpha) — one composed fill per community per frame,
 * deterministic, never data (no identifier leaves the decorative layer).
 */
export function drawStellarClusterGlow(context: CanvasRenderingContext2D, clusters: readonly StellarDustCluster[],
  project: (point: Coordinates) => ProjectedPoint, nodeColour: (hubId: string) => string | undefined,
  width: number, height: number): void {
  const canTransform = canComposeTransform(context);
  for (const cluster of clusters) {
    const centre = project(cluster.center);
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) continue;
    const rim = project({ x: cluster.center.x + cluster.radius, y: cluster.center.y, z: cluster.center.z });
    const radius = Math.hypot(rim.x - centre.x, rim.y - centre.y);
    if (!(radius >= STELLAR_CLUSTER_GLOW_MIN_RADIUS_PX)) continue;
    if (centre.x + radius < 0 || centre.x - radius > width || centre.y + radius < 0 || centre.y - radius > height) continue;
    const colour = nodeColour(cluster.hubId) ?? STELLAR_DUST_FALLBACK_COLOUR;
    const channels = colourChannels(colour);
    const alpha = quantisedAlpha(STELLAR_CLUSTER_GLOW_ALPHA);
    const stops = [
      { offset: 0, colour: rgbaChannels(channels, alpha) },
      { offset: 0.55, colour: rgbaChannels(channels, alpha * 0.35) },
      { offset: 1, colour: rgbaChannels(channels, 0) },
    ];
    const unit = canTransform ? cachedUnitRadial(context, `cluster-glow\u0000${colour}\u0000${alpha}`, 0, 0, 0, 1, stops) : null;
    if (unit) {
      fillUnitGradient(context, unit, centre.x, centre.y, radius);
    } else if (typeof context.createRadialGradient === "function") {
      const gradient = context.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
      for (const stop of stops) gradient.addColorStop(stop.offset, stop.colour);
      context.fillStyle = gradient;
      context.beginPath(); context.arc(centre.x, centre.y, radius, 0, Math.PI * 2); context.fill();
    } else {
      context.fillStyle = rgbaChannels(channels, alpha * 0.5);
      context.beginPath(); context.arc(centre.x, centre.y, radius, 0, Math.PI * 2); context.fill();
    }
  }
}

/** D-072 V5: every Neural edge overlaps the drawn soma outline by about this much, so the dendrite
 * and the soma read as one body with no suspended-egg gap. */
export const NEURAL_EDGE_SOMA_OVERLAP_PX = 0.5;

/** The drawn soma of one node under the live projection: centre, rotation, clamped radius and
 * eccentricity exactly as the node pass paints them. The junction pass consumes the same values, so
 * the edge start meets the soma that is actually on screen. */
export type NeuralSomaFrame = {
  readonly x: number; readonly y: number;
  readonly angle: number;
  readonly radius: number;
  readonly eccentricity: number;
  readonly harmonics: readonly SomaOutlineHarmonic[];
};

/** The screen frame of every soma of a neural geometry under one projection. Per frame, per node:
 * the same clamp, elongation and orientation formulas the node pass draws with. */
export function neuralSomaFrames(geometry: MorphologyGeometry, project: (point: Coordinates) => ProjectedPoint,
  style: MorphologyCanvasStyle, contract: (typeof MORPHOLOGY_CONTRACT)[keyof typeof MORPHOLOGY_CONTRACT],
  appearance: AppearanceOptions): ReadonlyMap<string, NeuralSomaFrame> {
  const frames = new Map<string, NeuralSomaFrame>();
  for (const node of geometry.nodes) {
    const p = project(node.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = style.nodes.get(node.id)?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1), 2, contract.node.maxRadiusPx);
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
    frames.set(node.id, {
      x: p.x, y: p.y, angle, radius,
      eccentricity: somaDrawnElongation(projectedEccentricity, node.outline ?? []),
      harmonics: node.outline ?? [],
    });
  }
  return frames;
}

/**
 * The radius of the drawn soma outline at a screen-space polar angle: the bulged ellipse the node
 * pass paints (eccentricity with its jitter, harmonics with the irregularity scale and boost),
 * inverted exactly — the bulge scales the ellipse without turning its polar angle, so the
 * parameter follows in closed form. Pure.
 */
export function somaOutlineRadiusAtAngle(frame: NeuralSomaFrame, polarAngle: number): number {
  const major = frame.radius * frame.eccentricity, minor = frame.radius;
  const local = polarAngle - frame.angle;
  const parameter = Math.atan2(major * Math.sin(local), minor * Math.cos(local));
  const bulge = 1 + clamp(
    somaOutlineIrregularity(frame.harmonics, parameter) * somaIrregularityScale(frame.radius) * SOMA_IRREGULARITY_BOOST,
    -SOMA_OUTLINE_MAX_RADIAL, SOMA_OUTLINE_MAX_RADIAL);
  return bulge * major * minor / Math.hypot(minor * Math.cos(parameter), major * Math.sin(parameter));
}

/**
 * Where a dendrite meets its soma: the projected end point moved onto the ray it leaves the soma
 * by, at the drawn outline minus {@link NEURAL_EDGE_SOMA_OVERLAP_PX} — the edge starts on the soma
 * surface and overlaps the boundary, never floating outside it. Pure.
 */
export function neuralEdgeEndOnSoma(frame: NeuralSomaFrame, endPoint: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
  const dx = endPoint.x - frame.x, dy = endPoint.y - frame.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 1e-6) return { x: endPoint.x, y: endPoint.y };
  const outline = somaOutlineRadiusAtAngle(frame, Math.atan2(dy, dx));
  const target = Math.max(NEURAL_EDGE_SOMA_OVERLAP_PX, outline - NEURAL_EDGE_SOMA_OVERLAP_PX);
  const scale = target / distance;
  return { x: frame.x + dx * scale, y: frame.y + dy * scale };
}

// ---------------------------------------------------------------- cached unit gradients
//
// D-072: per-frame gradient re-creation is the measured Retina cost. Halo and nucleus gradients
// depend only on (colour, quantised alpha), and their geometry is proportional to the radius, so
// one cached unit-space gradient per key serves every node of that key at any radius, composed
// under translate + scale. Keyed weakly by the context, like the pearl paints below.

export const UNIT_GRADIENT_CACHE_CAP = 1024;
let unitGradientCaches = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient | null>>();
/** Resets the cached unit gradients (tests observe cache behaviour in isolation). */
export function resetUnitGradientCaches(): void {
  unitGradientCaches = new WeakMap();
}
/** One cached unit-space radial gradient for `key`, or null where the context cannot build one.
 * A cached null is a cached answer: the caller then takes its non-gradient fallback. */
function cachedUnitRadial(context: CanvasRenderingContext2D, key: string,
  innerX: number, innerY: number, innerRadius: number, outerRadius: number,
  stops: readonly { readonly offset: number; readonly colour: string }[]): CanvasGradient | null {
  if (typeof context.createRadialGradient !== "function") return null;
  let byKey = unitGradientCaches.get(context);
  if (!byKey) { byKey = new Map(); unitGradientCaches.set(context, byKey); }
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  const gradient = context.createRadialGradient(innerX, innerY, innerRadius, 0, 0, outerRadius);
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.colour);
  if (byKey.size >= UNIT_GRADIENT_CACHE_CAP) byKey.clear();
  byKey.set(key, gradient);
  return gradient;
}
/** Quantise an alpha for the unit-gradient key: 1/256 keeps every cached stop within 1/255. */
const quantisedAlpha = (alpha: number): number => Math.round(clamp(alpha, 0, 1) * 256) / 256;

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
/** Pearl paints per drawing context, keyed weakly BY the context (as `sphereGradientCaches` in
 * container-canvas.ts): a paint's gradients belong to the context that built them, and a destroyed
 * renderer's cache is collectable with its context. An array of maps keyed the other way round
 * would pin dead canvases: a WeakMap holds its value strongly while its key lives, and the array
 * kept the keys (the maps) alive — so module state must hold no strong reference to any context. */
let pearlPaintCaches = new WeakMap<CanvasRenderingContext2D, Map<string, PearlPaint>>();

/** Resets the cached pearl paints and parsed colours (the WeakMap is replaced, so every context —
 * live or dead — starts a fresh cache). Tests use it to observe cache behaviour. */
export function resetPearlCaches(): void {
  pearlPaintCaches = new WeakMap();
  colourChannelsCache.clear();
}
/** Number of cached pearl paints for one drawing context (bounded by the cap) — the bounded-growth
 * witness. Per context because the cache itself is: with no strong reference to any context there
 * is no cross-context total, and none to leak. */
export function pearlPaintCacheSize(context: CanvasRenderingContext2D): number {
  return pearlPaintCaches.get(context)?.size ?? 0;
}
function pearlPaintCacheFor(context: CanvasRenderingContext2D): Map<string, PearlPaint> {
  let byKey = pearlPaintCaches.get(context);
  if (byKey) return byKey;
  const map = new Map<string, PearlPaint>();
  pearlPaintCaches.set(context, map);
  return map;
}

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
 * channels (no regex, no per-pearl string parsing), with the same rounding the exact path uses.
 * `coreOpacityFloor` carries the morphology's core alpha floor (D-072: 0.9 for Stellar pearls and
 * Neural somata, the historical 0.48 elsewhere). */
export function pearlPaintColours(
  color: string,
  scale: number,
  emphasisBrightness: number,
  baseOpacity: number,
  coreOpacityFloor = 0.48,
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
  const opacity = clamp(Math.max(coreOpacityFloor, baseOpacity) * emphasisBrightness * depthAlpha, 0, 1);
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
  coreOpacityFloor = 0.48,
): PearlPaint {
  const radiusBucket = radius >= PEARL_PROPORTIONAL_RADIUS_PX ? "" : `r${Math.round(radius * 4)}`;
  // The glow strength is part of the key: the Neural density-aware halo varies it per soma, and a
  // hit must never serve one soma's dimmed bloom as another's full-strength halo. So is the core
  // opacity floor: a Stellar pearl's 0.9 paint must never serve a Mycelium junction's 0.48 one.
  const key = `${color}\u0000${emphasisKind}\u0000${Math.round(baseOpacity * 1000)}\u0000${Math.round(glow * 1000)}\u0000${Math.round(glowStrength * 128)}\u0000${bucketedDepthScale(scale)}\u0000${radiusBucket}\u0000${Math.round(coreOpacityFloor * 1000)}`;
  const byKey = pearlPaintCacheFor(context);
  const hit = byKey.get(key);
  if (hit) return hit;
  const colours = pearlPaintColours(color, scale, emphasisBrightness, baseOpacity, coreOpacityFloor);
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
 * disc carries the eccentricity. A Stellar star draws its compressed core radius (M1b), so titles
 * approach the small star, not the old big disc. */
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
    const drawn = geometry.morphology === "stellar" ? stellarStarCoreRadiusPx(radius, node.degree) : radius;
    const elongation = geometry.morphology === "neural"
      ? somaDrawnElongation(Math.max(1, node.eccentricity ?? 1), node.outline ?? [])
      : 1;
    discs.push({ x: p.x, y: p.y, radius: drawn * elongation });
  }
  return discs;
}

// ---------------------------------------------------------------- D-072 shared edge pass

/** Everything one drawn segment's paint needs, computed once per frame and shared by the main pass
 * and the separate flow layer: projected (and, for Neural, junction-adjusted) points, arc lengths,
 * the base colour/alpha, and the taper-aware width sampler. */
export type MorphologyEdgePaint = {
  readonly part: MorphologySegment;
  readonly edgeId: string;
  readonly category: EdgeCategory;
  readonly points: readonly ProjectedPoint[];
  readonly cumulative: readonly number[];
  readonly totalPx: number;
  readonly color: string;
  /** Constant base alpha of the line: presentation-derived only, never time-dependent (V13). */
  readonly alpha: number;
  readonly widthAt: (i: number) => number;
};

/** The exploratory relations of a geometry that may animate, prioritised and budget-capped exactly
 * as the inline pass has always done: visible only, selected and focus-adjacent first. Deterministic
 * in the inputs, so the main pass and the separate flow layer always agree. */
export function selectAnimatedFlowEdges(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, bounds: { readonly width: number; readonly height: number }): ReadonlySet<string> {
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
    if (!focusPositions.size || !part.source || !part.target) return false;
    const radius = sceneExtent * 0.22;
    for (const pos of focusPositions.values()) {
      const d1 = Math.hypot(part.source.x - pos.x, part.source.y - pos.y, part.source.z - pos.z);
      const d2 = Math.hypot(part.target.x - pos.x, part.target.y - pos.y, part.target.z - pos.z);
      if (Math.min(d1, d2) <= radius) return true;
    }
    return false;
  };
  const withinViewport = (part: MorphologySegment): boolean => {
    if (!part.source || !part.target) return true;
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
  return animatedEdges;
}

/** Build the shared per-segment paints of one frame. Pure drawing input computation: no canvas
 * state is touched except the (context-provided) root-fade gradient builder left to the caller. */
function buildEdgePaints(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, appearance: AppearanceOptions,
  contract: (typeof MORPHOLOGY_CONTRACT)[keyof typeof MORPHOLOGY_CONTRACT], projection: "2d" | "3d",
  somaFrames: ReadonlyMap<string, NeuralSomaFrame> | null): MorphologyEdgePaint[] {
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  const neuralDegrees = geometry.morphology === "neural" ? neuralEndpointDegrees(geometry) : null;
  const endpointSomata = somaFrames ? neuralEndpointSomata(geometry) : null;
  const stellarArcs = geometry.morphology === "stellar" ? stellarArcClasses(geometry) : null;
  const paints: MorphologyEdgePaint[] = [];
  for (const part of geometry.drawnSegments) {
    const edge = style.edges.get(part.edgeId);
    const presentation = edge?.presentation;
    const category = presentation?.category ?? "attested";
    if (!EDGE_CATEGORY_SET.has(category)) continue; // no semantics -> not drawn
    const opacity = (presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const arcClass = stellarArcs?.get(part.edgeId);
    const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const emphasis = style.interaction?.hoverId === part.edgeId ? contract.hover
      : style.interaction?.focusIds?.has(part.edgeId) ? contract.focus : null;
    const color = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
    const source = simplified && part.samples.length > 8 ? part.samples.filter((_, i) => i % 4 === 0 || i === part.samples.length - 1) : part.samples;
    let points = source.map(project);
    if (points.length < 2) continue;
    // D-072 V5: each dendrite end moves onto the outline of the soma it leaves — the soma the node
    // pass is about to draw under it — overlapping the boundary, so soma and dendrites read as one
    // shape with no suspended-egg gap. Screen space, so 2D and 3D share the exact grammar.
    if (somaFrames && endpointSomata) {
      const [segmentStart, segmentEnd] = segmentEnds(part);
      const startSoma = segmentStart ? endpointSomata.get(neuralEndpointKey(segmentStart)) : undefined;
      const endSoma = segmentEnd ? endpointSomata.get(neuralEndpointKey(segmentEnd)) : undefined;
      const startFrame = startSoma ? somaFrames.get(startSoma.id) : undefined;
      const endFrame = endSoma ? somaFrames.get(endSoma.id) : undefined;
      if (startFrame || endFrame) {
        let first = points[0]!, last = points[points.length - 1]!;
        if (startFrame) {
          const adjusted = neuralEdgeEndOnSoma(startFrame, first);
          first = { x: adjusted.x, y: adjusted.y, scale: first.scale };
        }
        if (endFrame) {
          const adjusted = neuralEdgeEndOnSoma(endFrame, last);
          last = { x: adjusted.x, y: adjusted.y, scale: last.scale };
        }
        points = [first, ...points.slice(1, -1), last];
      }
    }
    // D-071 G11: each soma end's taper ratio is capped by that soma's degree, so the roots of a
    // high-degree hub stay separable instead of overlapping into one luminous mass.
    const [segmentStart, segmentEnd] = segmentEnds(part);
    const startDegree = (segmentStart && neuralDegrees?.get(neuralEndpointKey(segmentStart))) ?? 1;
    const endDegree = (segmentEnd && neuralDegrees?.get(neuralEndpointKey(segmentEnd))) ?? 1;
    // D-071 G9: the Neural profile is anchored on the contract's taper ratios so the rastremazione
    // survives the pixel floors at overview scale; the other morphologies keep their profiles.
    const neuralTaper = geometry.morphology === "neural"
      ? neuralTaperProfile(part.widthStart, part.widthEnd, contract.edge.taper, startDegree, endDegree) : null;
    const widthAt = (i: number) => {
      const t = i / (points.length - 1);
      const smooth = t * t * (3 - 2 * t);
      const variation = geometry.morphology === "mycelium" ? 1 + contract.edge.widthVariation * Math.sin(Math.PI * t) ** 2 * Math.cos(t * Math.PI * 4) : 1;
      // Fractional sample positions (the flow pulse asks for midpoints) read the nearest projected scale.
      const scaleAt = points[Math.min(points.length - 1, Math.max(0, Math.round(i)))]!.scale;
      const factors = scaleAt * widthFactor * appearance.edgeWidth * (emphasis?.radiusMultiplier ?? 1) * variation;
      if (stellarArcs) {
        // D-072 M1b: the reference's arc grammar — intra arcs thin and discreet, bridges slightly
        // stronger; the data's own width modulates inside the class window (2D and 3D the same).
        const profile = part.widthStart + (part.widthEnd - part.widthStart) * smooth;
        return stellarArcWidthPx(arcClass, profile * factors);
      }
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
    // D-072 V13: the base alpha of a line is constant across frames — presentation-derived factors
    // only. D-072 M1b: a Stellar arc's base alpha is its class window (intra faint, bridges near
    // 0.5), the presentation's opacity mapping inside it; emphasis may push above the window.
    const focus = style.interaction?.dimFocus;
    const baseAlpha = clamp(
      (stellarArcs
        ? stellarArcAlpha(arcClass, opacity * appearance.edgeOpacity) * (emphasis?.brightnessMultiplier ?? 1)
        : Math.max(0.14, opacity * appearance.edgeOpacity * (emphasis?.brightnessMultiplier ?? 1))),
      0, 1);
    const alpha = focusArcOpacity(focus ?? null, part.edgeId, baseAlpha);
    const cumulative: number[] = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
    paints.push({ part, edgeId: part.edgeId, category, points, cumulative, totalPx: cumulative[cumulative.length - 1]! || 1, color, alpha, widthAt });
  }
  return paints;
}

/** The exploratory halo ribbon and the constant base ribbon of one paint (D-071 G11 root fade kept:
 * within the first pixels of a high-degree soma the dendrite also loses a little alpha). With
 * `simple` (the `moving` frame of a neural geometry) the base is one stroked polyline at the mid
 * width — no taper keyframes, no root-fade gradient — while the exploratory halo ribbon above it
 * keeps the exploratory line recognisable. */
function drawEdgeBase(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  rootFadeStart: number, rootFadeEnd: number, gradientCapable: boolean, simple = false): void {
  const { points, color, alpha } = paint;
  const chordPx = Math.hypot(points[points.length - 1]!.x - points[0]!.x, points[points.length - 1]!.y - points[0]!.y);
  const rootFadedFill = (edgeAlpha: number): string | CanvasGradient => {
    if (rootFadeStart >= 1 && rootFadeEnd >= 1) return rgba(color, edgeAlpha);
    if (!gradientCapable || chordPx <= 0) return rgba(color, edgeAlpha);
    const gradient = context.createLinearGradient(points[0]!.x, points[0]!.y, points[points.length - 1]!.x, points[points.length - 1]!.y);
    const reach = clamp(NEURAL_ROOT_FADE_PX / chordPx, 1e-4, 0.5);
    gradient.addColorStop(0, rgba(color, clamp(edgeAlpha * rootFadeStart, 0, 1)));
    gradient.addColorStop(reach, rgba(color, edgeAlpha));
    gradient.addColorStop(1 - reach, rgba(color, edgeAlpha));
    gradient.addColorStop(1, rgba(color, clamp(edgeAlpha * rootFadeEnd, 0, 1)));
    return gradient;
  };
  const fillRibbon = (widthAt: (i: number) => number): void => {
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
  // Exploratory relations carry a slightly stronger halo, then the flow, over the same continuous base line.
  if (paint.category === "exploratory") {
    context.fillStyle = rootFadedFill(clamp(paint.alpha * FLOW_HALO_ALPHA, 0, 1));
    fillRibbon((i) => paint.widthAt(i) * FLOW_HALO_WIDTH_MULTIPLIER);
  }
  if (simple) {
    // One polyline stroke at the dendrite's mid width: the moving frame's cheap neural base.
    context.strokeStyle = rgba(color, alpha);
    context.lineWidth = paint.widthAt((points.length - 1) / 2);
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    return;
  }
  context.fillStyle = rootFadedFill(paint.alpha);
  fillRibbon(paint.widthAt);
}

/** Fallback for contexts without image drawing (notably the small recording contexts in tests). */
function drawEdgeTravellingHighlight(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  elapsedMilliseconds: number, speed: number, intensity: number): void {
  const { points, cumulative, totalPx, color, widthAt } = paint;
  const tailPx = flowTailLengthPx(totalPx);
  const cycle = totalPx + tailPx;
  const head = flowHeadPositionPx(elapsedMilliseconds, speed, cycle);
  const trailStart = Math.max(0, head - tailPx);
  const trailEnd = Math.min(totalPx, head);
  if (trailEnd <= trailStart) return;
  const peak = flowHeadAlpha(intensity);
  const stepPx = Math.max(4, tailPx / 12);
  for (let i = 0; i < points.length - 1; i++) {
    const from = Math.max(trailStart, cumulative[i]!);
    const to = Math.min(trailEnd, cumulative[i + 1]!);
    const length = cumulative[i + 1]! - cumulative[i]!;
    if (to <= from || length <= 0) continue;
    const subdivisions = Math.ceil((to - from) / stepPx);
    for (let part = 0; part < subdivisions; part++) {
      const start = from + (to - from) * part / subdivisions;
      const end = from + (to - from) * (part + 1) / subdivisions;
      const alpha = peak * flowHighlightAlpha((start + end) / 2, head, cycle, 1, tailPx);
      if (alpha <= 0.004) continue;
      const a = (start - cumulative[i]!) / length, b = (end - cumulative[i]!) / length;
      const x0 = points[i]!.x, y0 = points[i]!.y;
      const dx = points[i + 1]!.x - x0, dy = points[i + 1]!.y - y0;
      const width = widthAt(i + 0.5) * FLOW_PULSE_WIDTH_MULTIPLIER;
      // A soft, contained glow beneath the bright core. Neither pass inherits the faint base alpha.
      context.strokeStyle = rgba(color, alpha * 0.22);
      context.lineWidth = width * 2.1;
      context.beginPath(); context.moveTo(x0 + dx * a, y0 + dy * a); context.lineTo(x0 + dx * b, y0 + dy * b); context.stroke();
      context.strokeStyle = rgba(color, alpha);
      context.lineWidth = width;
      context.beginPath(); context.moveTo(x0 + dx * a, y0 + dy * a); context.lineTo(x0 + dx * b, y0 + dy * b); context.stroke();
    }
  }
}

/** The browser's flow pass uses two shared paths, irrespective of the number of arcs. The moving
 * head is a small cached radial sprite: its gradient is built on an offscreen canvas once per
 * colour, width bucket and DPR, never on the flow context during a frame. */
const FLOW_SPRITE_CACHE_CAP = 128;
const flowHeadSprites = new Map<string, CanvasImageSource>();
const flowTailSprites = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
function flowHeadSprite(color: string, widthPx: number, dpr: number): CanvasImageSource | null {
  const widthBucket = Math.max(1, Math.min(8, Math.round(widthPx * 2) / 2));
  const density = Math.max(1, Math.min(4, Math.round(dpr * 2) / 2));
  const key = `${color}|${widthBucket}|${density}`;
  const cached = flowHeadSprites.get(key);
  if (cached) return cached;
  const diameter = Math.max(18, Math.ceil(widthBucket * 7));
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(Math.ceil(diameter * density), Math.ceil(diameter * density))
    : typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = Math.ceil(diameter * density);
  canvas.height = Math.ceil(diameter * density);
  const brush = canvas.getContext("2d");
  if (!brush) return null;
  const cx = canvas.width / 2, cy = canvas.height / 2, radius = Math.min(cx, cy);
  const glow = brush.createRadialGradient(cx, cy, 0, cx, cy, radius);
  glow.addColorStop(0, rgba(color, 0.96));
  glow.addColorStop(0.18, rgba(color, 0.84));
  glow.addColorStop(0.42, rgba(color, 0.3));
  glow.addColorStop(1, rgba(color, 0));
  brush.fillStyle = glow;
  brush.fillRect(0, 0, canvas.width, canvas.height);
  if (flowHeadSprites.size >= FLOW_SPRITE_CACHE_CAP) flowHeadSprites.clear();
  flowHeadSprites.set(key, canvas);
  return canvas;
}

function flowTailSprite(color: string, tailPx: number, dpr: number): OffscreenCanvas | HTMLCanvasElement | null {
  const length = Math.max(24, Math.ceil(tailPx / 4) * 4);
  const density = Math.max(1, Math.min(4, Math.round(dpr * 2) / 2));
  const key = `${color}|${length}|${density}`;
  const cached = flowTailSprites.get(key);
  if (cached) return cached;
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(Math.ceil(length * density), Math.ceil(12 * density))
    : typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return null;
  canvas.width = Math.ceil(length * density);
  canvas.height = Math.ceil(12 * density);
  const brush = canvas.getContext("2d");
  if (!brush) return null;
  const tail = brush.createLinearGradient(0, 0, canvas.width, 0);
  tail.addColorStop(0, rgba(color, 0));
  tail.addColorStop(0.18, rgba(color, 0.08));
  tail.addColorStop(0.6, rgba(color, 0.22));
  tail.addColorStop(1, rgba(color, 0.62));
  brush.fillStyle = tail;
  brush.fillRect(0, 2 * density, canvas.width, 8 * density);
  brush.fillRect(0, 4.5 * density, canvas.width, 3 * density);
  if (flowTailSprites.size >= FLOW_SPRITE_CACHE_CAP) flowTailSprites.clear();
  flowTailSprites.set(key, canvas);
  return canvas;
}

type FlowTrail = { readonly paint: MorphologyEdgePaint; readonly head: number; readonly tail: number };
function flowPointAt(trail: FlowTrail, distance: number): { x: number; y: number } {
  const { points, cumulative } = trail.paint;
  for (let i = 0; i < cumulative.length - 1; i++) {
    if (distance > cumulative[i + 1]! && i < cumulative.length - 2) continue;
    const span = cumulative[i + 1]! - cumulative[i]!;
    const t = span > 0 ? clamp((distance - cumulative[i]!) / span, 0, 1) : 0;
    return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * t,
      y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * t };
  }
  return points[points.length - 1]!;
}

/** Append the clipped section of an arc to the current shared path; one move and only the source
 * polyline's actual bends, without the former per-segment subdivisions or per-arc strokes. */
function appendFlowTail(context: CanvasRenderingContext2D, trail: FlowTrail, from: number, to: number): void {
  const { points, cumulative } = trail.paint;
  if (to <= from) return;
  const first = flowPointAt(trail, from);
  context.moveTo(first.x, first.y);
  for (let i = 1; i < cumulative.length - 1; i++)
    if (cumulative[i]! > from && cumulative[i]! < to) context.lineTo(points[i]!.x, points[i]!.y);
  const last = flowPointAt(trail, to);
  context.lineTo(last.x, last.y);
}

function drawTravellingHighlights(context: CanvasRenderingContext2D, paints: readonly MorphologyEdgePaint[],
  now: number, speed: number, intensity: number): void {
  if (!paints.length) return;
  // Recording contexts without drawImage keep the original stroke semantics.
  if (typeof context.drawImage !== "function") {
    for (const paint of paints) drawEdgeTravellingHighlight(context, paint, now, speed, intensity);
    return;
  }
  const trails: FlowTrail[] = [];
  for (const paint of paints) {
    const tail = flowTailLengthPx(paint.totalPx);
    const cycle = paint.totalPx + tail;
    const head = flowHeadPositionPx(now, speed, cycle);
    if (head > 0 && head - tail < paint.totalPx) trails.push({ paint, head, tail });
  }
  if (!trails.length) return;
  const peak = flowHeadAlpha(intensity);
  const previousAlpha = context.globalAlpha;
  const canvas = context.canvas;
  const bounds = canvas.getBoundingClientRect();
  const dpr = bounds.width > 0 ? canvas.width / bounds.width : 1;
  // At small counts the curved polyline reads best. Above 12 arcs, a cached gradient strip
  // follows each tail chord: only one drawImage per tail, keeping the browser operation budget
  // below the full-scene fraction even when all 30 selected arcs are luminous together.
  if (paints.length <= 12) {
    for (let band = 0; band < 2; band++) {
      context.beginPath();
      for (const trail of trails) {
        const end = Math.min(trail.head, trail.paint.totalPx);
        const reach = band === 0 ? trail.tail : trail.tail * 0.48;
        appendFlowTail(context, trail, Math.max(0, trail.head - reach), end);
      }
      context.strokeStyle = band === 0 ? "rgb(178, 199, 235)" : "rgb(218, 230, 250)";
      context.lineWidth = band === 0 ? 6 : 2.8;
      context.globalAlpha = previousAlpha * peak * (band === 0 ? 0.22 : 0.48);
      context.stroke();
    }
  } else for (const trail of trails) {
    const from = Math.max(0, trail.head - trail.tail);
    const to = Math.min(trail.head, trail.paint.totalPx);
    if (to <= from) continue;
    const first = flowPointAt(trail, from), last = flowPointAt(trail, to);
    const dx = last.x - first.x, dy = last.y - first.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 0) continue;
    const sprite = flowTailSprite(trail.paint.color, trail.tail, dpr);
    if (!sprite) continue;
    const sourceWidth = (to - from) / trail.tail * sprite.width;
    const sourceX = (trail.tail - trail.head + from) / trail.tail * sprite.width;
    context.globalAlpha = previousAlpha * peak * Math.min(1, trail.head / 14);
    context.save();
    context.translate(first.x, first.y);
    context.rotate(Math.atan2(dy, dx));
    context.drawImage(sprite, sourceX, 0, sourceWidth, sprite.height, 0, -6, chord, 12);
    context.restore();
  }
  for (const trail of trails) {
    if (trail.head > trail.paint.totalPx) continue;
    const head = flowPointAt(trail, trail.head);
    const width = trail.paint.widthAt((trail.paint.points.length - 1) / 2) * FLOW_PULSE_WIDTH_MULTIPLIER;
    const sprite = flowHeadSprite(trail.paint.color, width, dpr);
    if (!sprite) continue;
    const diameter = Math.max(18, Math.ceil(Math.max(1, Math.min(8, Math.round(width * 2) / 2)) * 7));
    context.globalAlpha = previousAlpha * peak * Math.min(1, trail.head / 14);
    context.drawImage(sprite, head.x - diameter / 2, head.y - diameter / 2, diameter, diameter);
  }
  context.globalAlpha = previousAlpha;
}

/** The reduced-motion (and still-flow) exploratory cue: a static line whose brightness rises
 * toward the target of the relation, so the direction stays readable with no animation (V13). */
function drawEdgeStaticCue(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  intensity: number, gradientCapable: boolean): void {
  const { points, color, alpha, widthAt } = paint;
  const first = points[0]!, last = points[points.length - 1]!;
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  if (gradientCapable && chord > 0) {
    const gradient = context.createLinearGradient(first.x, first.y, last.x, last.y);
    gradient.addColorStop(0, rgba(color, clamp(alpha * FLOW_STATIC_CORE_ALPHA * 0.55 * intensity, 0, 1)));
    gradient.addColorStop(1, rgba(color, clamp(alpha * FLOW_STATIC_CORE_ALPHA * 1.45 * intensity, 0, 1)));
    context.strokeStyle = gradient;
  } else {
    context.strokeStyle = rgba(color, clamp(alpha * FLOW_STATIC_CORE_ALPHA * intensity, 0, 1));
  }
  context.lineWidth = Math.max(0.5, widthAt((points.length - 1) / 2) * 0.7);
  context.beginPath(); context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
}

/** One world-space geometry, with projection and depth scale supplied by the renderer. */
export function drawMorphologyCanvas(context: CanvasRenderingContext2D, geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint, style: MorphologyCanvasStyle,
  appearance: AppearanceOptions = DEFAULT_APPEARANCE, containers: readonly MorphologyContainerPath[] = geometry.containers ?? [],
  projection: "2d" | "3d" = "2d", structureOnly = false): void {
  const canvas = context.canvas;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  // D-072 M1b: the reduced frame while the camera moves — solid node fills, no decorative layers,
  // simple neural dendrites. The flow drawing is untouched: its owner decides what it draws.
  const moving = style.interaction?.quality === "moving";
  context.setTransform(canvas.width / bounds.width, 0, 0, canvas.height / bounds.height, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (geometry.morphology === "stellar" && !moving) drawStarfield(context, bounds.width, bounds.height, appearance.starfieldDensity, appearance.starfieldBrightness);
  const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
  // Indra 3D pearls read as glass spheres: soft spherical shading and a small highlight. Flat 3D and
  // the 2D view keep their flat node discs. A Stellar pearl is a star everywhere (M1b): the same
  // small core in 2D, 3D, Flat and Indra, so no pearl reads as a big transparent disc.
  const indra3d = projection === "3d" && containers.length > 0;
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
    if (!moving || projection === "2d") drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs, undefined, frameCache);
  context.globalAlpha = 1;
    return;
  }
  // D-072 M1b: beneath the dust, each declared community carries a very faint cached radial glow so
  // the cluster reads as a mass; then the satellite dust around each hub. Stellar only; both are
  // skipped by the single-node test view and by the moving frame. Never data: no identifier, no
  // label, no witness, no hit-test surface (see starfield.ts).
  if (geometry.morphology === "stellar" && !testHook()?.onlyNodeId && !moving
    && appearance.starfieldDensity > 0 && appearance.starfieldBrightness > 0) {
    const clusters = cachedStellarDustClusters(geometry);
    drawStellarClusterGlow(context, clusters, project,
      hubId => style.nodes.get(hubId)?.color, bounds.width, bounds.height);
    drawStellarDust(context, clusters, project,
      hubId => style.nodes.get(hubId)?.color, bounds.width, bounds.height,
      appearance.starfieldDensity, appearance.starfieldBrightness);
  }
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  // D-072 V5: the drawn soma frames exist before the dendrites, so the junction pass and the node
  // pass below paint the very same somata (one source of truth per frame).
  const somaFrames = geometry.morphology === "neural" ? neuralSomaFrames(geometry, project, style, contract, appearance) : null;
  if (!testHook()?.hideEdges) {
    const gradientCapable = typeof context.createLinearGradient === "function";
    const paints = buildEdgePaints(geometry, style, project, appearance, contract, projection, somaFrames);
    // D-071 G11: the soma degree at every dendrite end (memoised per geometry, world space).
    const neuralDegrees = geometry.morphology === "neural" ? neuralEndpointDegrees(geometry) : null;
    const animatedEdges = selectAnimatedFlowEdges(geometry, style, project, bounds);
    const animating = flowMotionAllowedNow() && appearance.flowIntensity > 0 && appearance.flowSpeed > 0;
    const intensity = appearance.flowIntensity;
    // D-072 V13: "separate" leaves the travelling highlights to the dedicated overlay layer
    // (drawFlowLayer); the static reduced-motion cue and the constant base stay in this pass.
    const inlineHighlights = (style.interaction?.flowLayer ?? "inline") === "inline";
    const now = flowNow();
    const inlineFlowPaints: MorphologyEdgePaint[] = [];
    for (const paint of paints) {
      const [segmentStart, segmentEnd] = segmentEnds(paint.part);
      const startDegree = (segmentStart && neuralDegrees?.get(neuralEndpointKey(segmentStart))) ?? 1;
      const endDegree = (segmentEnd && neuralDegrees?.get(neuralEndpointKey(segmentEnd))) ?? 1;
      // D-071 G11: within the first pixels of a high-degree soma the dendrite also loses a little
      // alpha (deterministic, projected-length based, so 2D and 3D fade identically).
      const rootFadeStart = neuralDegrees ? neuralRootAlphaFactor(startDegree) : 1;
      const rootFadeEnd = neuralDegrees ? neuralRootAlphaFactor(endDegree) : 1;
      drawEdgeBase(context, paint, rootFadeStart, rootFadeEnd, gradientCapable, moving && geometry.morphology === "neural");
      if (paint.category === "exploratory") {
        // "separate" leaves the travelling highlight to the dedicated overlay: nothing draws here,
        // so the lighter composite (and its restore) is skipped for that edge entirely.
        const animatedHere = animating && animatedEdges.has(paint.edgeId);
        if (!animatedHere || inlineHighlights) {
          const previousComposite = context.globalCompositeOperation;
          context.globalCompositeOperation = "lighter";
          context.lineCap = "round";
          context.lineJoin = "round";
          if (animatedHere) {
            inlineFlowPaints.push(paint);
          } else if (intensity > 0) {
            drawEdgeStaticCue(context, paint, intensity, gradientCapable);
          }
          context.globalCompositeOperation = previousComposite;
        }
      }
    }
    if (inlineFlowPaints.length) {
      const previousComposite = context.globalCompositeOperation;
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      context.lineJoin = "round";
      drawTravellingHighlights(context, inlineFlowPaints, now, appearance.flowSpeed, intensity);
      context.globalCompositeOperation = previousComposite;
    }
  }
  if (!simplified && geometry.morphology === "mycelium" && !testHook()?.hideEdges) {
    context.fillStyle = rgba("rgb(245, 245, 245)", appearance.edgeOpacity * 0.65);
    for (const junction of geometry.branchPoints) {
      const p = project(junction);
      context.beginPath(); context.arc(p.x, p.y, clamp(1.4 * p.scale * appearance.edgeWidth, 0.9, 3), 0, Math.PI * 2); context.fill();
    }
  }
  // The whole Indra paint (shading, rim, glint, glow) comes from the depth-bucketed cache above;
  // Flat and 2D keep the exact per-node computation. The moving frame skips it: solid fills only.
  const canTransform = canComposeTransform(context);
  // D-071 G9: Neural halos dim where many somata overlap, so hub cores stop merging into a single
  // luminous mass that invades the dendrites. Built once per frame, only when halos are drawn.
  const haloDensity = geometry.morphology === "neural" && !simplified && appearance.glow > 0 && !testHook()?.hideEdges && !moving
    ? neuralHaloNeighbourCounts(geometry.nodes) : null;
  // D-072 V4/V5: the Stellar core and the Neural soma draw nearly opaque; Mycelium keeps its floor.
  const coreFloor = morphologyCoreAlphaFloor(geometry.morphology);
  for (const node of (testHook()?.hideNodes ? [] : geometry.nodes)) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const basis = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    // D-072 M1b: a Stellar node draws as a star — the importance basis compressed into the star
    // window of this node's degree, never above the basis (pick radius untouched), 2D and 3D alike.
    const radius = geometry.morphology === "stellar" ? stellarStarCoreRadiusPx(basis, node.degree) : basis;
    // A pearl wholly outside the canvas (with its glow halo) draws nothing a viewer could see.
    const haloExtent = appearance.glow > 0 ? radius * contract.glow.maximumCoreRatio : radius;
    if (p.x + haloExtent < 0 || p.x - haloExtent > bounds.width
      || p.y + haloExtent < 0 || p.y - haloExtent > bounds.height) continue;
    context.globalAlpha = focusNodeOpacity(style.interaction?.dimFocus?.members ?? null, node.id);
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const baseOpacity = visual?.opacity ?? 1;
    // The effective halo strength carries the Neural density falloff; other morphologies keep theirs.
    const glowStrength = haloDensity
      ? contract.glow.strength * neuralHaloAlphaFactor(haloDensity.get(node.id) ?? 1)
      : contract.glow.strength;
    // In Indra 3D every colour of the pearl comes from one cached paint entry (quantised depth);
    // elsewhere the exact per-node factors stay. The moving frame wants no pearl paint at all.
    const paint = indra3d && !moving
      ? pearlPaint(context, color, p.scale, emphasis?.brightnessMultiplier ?? 1,
        style.interaction?.hoverId === node.id ? 1 : style.interaction?.focusIds?.has(node.id) ? 2 : 0,
        baseOpacity, radius, appearance.glow, glowStrength, coreFloor)
      : null;
    const lit = paint ? paint.lit : dim(color, depthBrightness(p.scale, projection));
    const litChannels = paint ? paint.litChannels : colourChannels(lit);
    // Depth reads on the pearls themselves: the back ones are slightly fainter (the radius already
    // carries the depth through the projection's size scale).
    const depthAlpha = projection === "3d" ? clamp(0.85 + 0.15 * Math.min(1, Math.max(0, p.scale)), 0.85, 1) : 1;
    const opacity = paint ? paint.opacity
      : coreFloor > 0.48
        ? clamp(Math.max(coreFloor, baseOpacity * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha), 0, 1)
        : clamp(Math.max(0.48, baseOpacity) * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha, 0, 1);
    if (!simplified && appearance.glow > 0 && !testHook()?.hideEdges && !moving) {
      const halo = radius * contract.glow.maximumCoreRatio;
      if (paint?.glow && canTransform) {
        fillUnitGradient(context, paint.glow, p.x, p.y, halo);
      } else {
        // D-072: the flat-view halo gradient depends only on (lit colour, quantised alpha), so it
        // comes from the per-context unit cache below and composes under translate + scale — no
        // per-node gradient re-creation, at any node count.
        const haloAlpha = quantisedAlpha(glowStrength * opacity * appearance.glow);
        const unit = canTransform
          ? cachedUnitRadial(context, `halo\u0000${lit}\u0000${haloAlpha}`, 0, 0, 0, 1, [
            { offset: 0, colour: rgbaChannels(litChannels, haloAlpha) },
            { offset: 1, colour: rgbaChannels(litChannels, 0) },
          ])
          : null;
        if (unit) {
          fillUnitGradient(context, unit, p.x, p.y, halo);
        } else if (typeof context.createRadialGradient === "function") {
          const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
          gradient.addColorStop(0, rgbaChannels(litChannels, haloAlpha));
          gradient.addColorStop(1, rgbaChannels(litChannels, 0));
          context.fillStyle = gradient;
          context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
        } else {
          context.fillStyle = rgbaChannels(litChannels, haloAlpha * 0.5);
          context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
        }
      }
    }
    context.beginPath();
    if (geometry.morphology === "neural") {
      // An oriented, organic soma: the ellipse radii carry the connection-driven elongation plus the
      // deterministic per-node jitter (id-hashed phases), the low-frequency harmonics break the
      // perfect-oval sameness — boosted, still within the geometry's radial bound — and large somata
      // show the full irregularity while small ones keep a scaled-down amount so it stays visible.
      // D-072 V5: the values come from the shared frame memo when it holds this node, so the soma
      // the dendrites were joined to is exactly the soma drawn here.
      const harmonics = node.outline ?? [];
      const frame = somaFrames?.get(node.id);
      let angle: number, eccentricity: number;
      if (frame) {
        angle = frame.angle;
        eccentricity = frame.eccentricity;
      } else {
        const axis = node.axis ?? { x: 1, y: 0, z: 0 };
        const q = project({ x: node.position.x + axis.x, y: node.position.y + axis.y, z: node.position.z + axis.z });
        angle = Math.atan2(q.y - p.y, q.x - p.x);
        const basis = [
          project({ x: node.position.x + 1, y: node.position.y, z: node.position.z }),
          project({ x: node.position.x, y: node.position.y + 1, z: node.position.z }),
          project({ x: node.position.x, y: node.position.y, z: node.position.z + 1 }),
        ];
        const projectedUnit = Math.max(1e-9, ...basis.map(value => Math.hypot(value.x - p.x, value.y - p.y)));
        const visibleAxis = clamp(Math.hypot(q.x - p.x, q.y - p.y) / projectedUnit, 0, 1);
        const projectedEccentricity = Math.sqrt(1 + ((node.eccentricity ?? 1) ** 2 - 1) * visibleAxis ** 2);
        eccentricity = somaDrawnElongation(projectedEccentricity, harmonics);
      }
      const major = radius * eccentricity, minor = radius;
      const steps = simplified ? 12 : moving ? 16 : 24;
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
      // D-072 V5: the soma body is one nearly opaque, clearly visible shape — no soft membrane
      // wash toward a transparent edge. The brighter nucleus below keeps it organic.
      context.fillStyle = rgbaChannels(litChannels, opacity);
      somaPath();
      context.fill();
      // Brighter small nucleus inside the body, oriented with the soma; its gradient is cached per
      // context in unit space (colour + quantised opacity key) and composed under translate + scale.
      // The moving frame skips it: the soma stays one solid body.
      if (!simplified && !moving) {
        const nucleusAlpha = quantisedAlpha(opacity);
        const nucleus = canTransform
          ? cachedUnitRadial(context, `nucleus\u0000${lit}\u0000${nucleusAlpha}`, -0.12, -0.12, 0, 0.5, [
            { offset: 0, colour: rgbaChannels(brightenChannels(litChannels, 0.6), nucleusAlpha) },
            { offset: 0.7, colour: rgbaChannels(litChannels, nucleusAlpha * 0.5) },
            { offset: 1, colour: rgbaChannels(litChannels, 0) },
          ])
          : null;
        if (nucleus) {
          context.save();
          context.translate(p.x, p.y);
          context.scale(radius, radius);
          context.fillStyle = nucleus;
          context.beginPath();
          for (let i = 0; i < 24; i += 1) {
            const theta = (i / 24) * Math.PI * 2;
            const ex = 0.4 * Math.cos(theta);
            const ey = 0.32 * Math.sin(theta);
            const x = cosA * ex - sinA * ey;
            const y = sinA * ex + cosA * ey;
            if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
          }
          context.closePath?.();
          context.fill();
          context.restore();
        } else if (typeof context.createRadialGradient === "function") {
          const gradient = context.createRadialGradient(p.x - radius * 0.12, p.y - radius * 0.12, 0, p.x, p.y, radius * 0.5);
          gradient.addColorStop(0, rgbaChannels(brightenChannels(litChannels, 0.6), opacity));
          gradient.addColorStop(0.7, rgbaChannels(litChannels, opacity * 0.5));
          gradient.addColorStop(1, rgbaChannels(litChannels, 0));
          context.fillStyle = gradient;
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
      }
      // In Indra 3D a soma also carries a small lit glint so it reads as a pearl, not a flat disc.
      // The moving frame draws no glints.
      if (indra3d && !moving) {
        const glint = pearlHighlight(radius);
        context.fillStyle = paint ? paint.glintFill : rgba(brighten(lit, 0.9), clamp(opacity, 0, 1));
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      }
    } else {
      if (indra3d && !moving && typeof context.createRadialGradient === "function" && paint) {
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
      } else if (indra3d && !moving && typeof context.createRadialGradient === "function") {
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
    context.globalAlpha = 1;
  }
  // Names come last, above every pearl and arc, so no label is ever covered by its own drawing.
  if (!moving || projection === "2d") drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs, undefined, frameCache);
}

// ---------------------------------------------------------------- D-072 separate flow layer

type FlowPaintCache = {
  readonly geometry: MorphologyGeometry;
  readonly project: (point: Coordinates) => ProjectedPoint;
  readonly style: MorphologyCanvasStyle;
  readonly projection: "2d" | "3d";
  readonly boundsWidth: number;
  readonly boundsHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly appearanceKey: string;
  readonly hoverId: string | null | undefined;
  readonly focusIds: ReadonlySet<string> | null | undefined;
  readonly dimFocus: unknown;
  readonly anchors: readonly number[];
  readonly paints: readonly MorphologyEdgePaint[];
  readonly animatedCount: number;
};
const flowPaintCaches = new WeakMap<CanvasRenderingContext2D, FlowPaintCache>();
function flowProjectionAnchors(geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint): readonly number[] {
  const nodes = geometry.nodes;
  const anchors: number[] = [];
  for (const index of [0, Math.floor(nodes.length / 2), nodes.length - 1]) {
    const node = nodes[index];
    if (!node) continue;
    const point = project(node.position);
    anchors.push(point.x, point.y, point.scale);
  }
  return anchors;
}

/**
 * The travelling flow highlights alone (D-072 V13 architecture): a small dedicated canvas can call
 * this every frame while the scene below stays painted, so the exploratory reading stops repainting
 * the whole graph. The caller owns the layer completely — sizing, the transform and the clear before
 * each call; this function only draws the moving heads and tails of the exploratory relations the
 * shared budget selected (same deterministic selection the inline pass would draw, so both layers
 * agree without coordination). Reads the shared flow clock (`setFlowNow`/`setFlowMotionAllowed`,
 * driven today by the product view's animation loop). Nothing else is drawn: no base lines, no halo
 * ribbons, no static cue, no nodes.
 *
 * Signature:
 * `drawFlowLayer(context, geometry, project, style, appearance = DEFAULT_APPEARANCE, projection = "2d")`
 * — `context`/`project`/`style`/`appearance`/`projection` exactly as `drawMorphologyCanvas` takes
 * them, on the overlay's own 2D context; the base scene pass should run with
 * `style.interaction.flowLayer = "separate"` so the highlights are not drawn twice.
 */
export function drawFlowLayer(context: CanvasRenderingContext2D, geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint, style: MorphologyCanvasStyle,
  appearance: AppearanceOptions = DEFAULT_APPEARANCE, projection: "2d" | "3d" = "2d"): void {
  if (!flowMotionAllowedNow() || !(appearance.flowIntensity > 0) || !(appearance.flowSpeed > 0)) return;
  const bounds = context.canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  const anchors = flowProjectionAnchors(geometry, project);
  const appearanceKey = `${appearance.edgeWidth}|${appearance.edgeOpacity}|${appearance.nodeScale}`;
  let cache = flowPaintCaches.get(context);
  if (!cache || cache.geometry !== geometry || cache.project !== project || cache.style !== style
    || cache.projection !== projection || cache.boundsWidth !== bounds.width || cache.boundsHeight !== bounds.height
    || cache.canvasWidth !== context.canvas.width || cache.canvasHeight !== context.canvas.height
    || cache.appearanceKey !== appearanceKey || cache.hoverId !== style.interaction?.hoverId
    || cache.focusIds !== style.interaction?.focusIds || cache.dimFocus !== style.interaction?.dimFocus
    || cache.anchors.length !== anchors.length || cache.anchors.some((value, index) => value !== anchors[index])) {
    const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
    const somaFrames = geometry.morphology === "neural" ? neuralSomaFrames(geometry, project, style, contract, appearance) : null;
    const paints = buildEdgePaints(geometry, style, project, appearance, contract, projection, somaFrames);
    const animatedEdges = selectAnimatedFlowEdges(geometry, style, project, bounds);
    cache = { geometry, project, style, projection, boundsWidth: bounds.width, boundsHeight: bounds.height,
      canvasWidth: context.canvas.width, canvasHeight: context.canvas.height, appearanceKey,
      hoverId: style.interaction?.hoverId, focusIds: style.interaction?.focusIds,
      dimFocus: style.interaction?.dimFocus, anchors,
      paints: paints.filter(paint => paint.category === "exploratory" && animatedEdges.has(paint.edgeId)),
      animatedCount: animatedEdges.size };
    flowPaintCaches.set(context, cache);
  } else setFlowAnimatedEdgeCount(cache.animatedCount);
  if (!cache.paints.length) return;
  const now = flowNow();
  const previousComposite = context.globalCompositeOperation;
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  context.lineJoin = "round";
  drawTravellingHighlights(context, cache.paints, now, appearance.flowSpeed, appearance.flowIntensity);
  context.globalCompositeOperation = previousComposite;
}
