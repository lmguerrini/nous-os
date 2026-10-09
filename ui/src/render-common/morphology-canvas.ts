import type { AppearanceOptions, EdgeCategory, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { MorphologyContainerPath, MorphologyGeometry, MorphologyInput, MorphologyNodeShape, MorphologySegment, SomaOutlineHarmonic } from "#engine/morphology-geometry.ts";
import { NEURAL_HALO_MAX_ALPHA, NEURAL_HALO_MAX_RADIUS_RATIO, NEURAL_LEAF_BODY_SCALE, NEURAL_MIN_SHAPED_RADIUS_PX, NEURAL_ROOT_ANCHOR_RADII, NEURAL_ROOT_FILLET_LENGTH_RADII, NEURAL_SOMA_OUTLINE_MAX_RADIAL, morphologyHash, neuralEndpointBodyScale, neuralJoinedRootWidthPx, neuralPrincipalTrunks, neuralRootCompactnessScale, neuralRootProfileAtLength, neuralRootRatio, neuralScreenWidthAt, neuralTrunkLobeStrength, neuralVisibleRootLengthPx, somaOutlineIrregularity, somaLobeAreaScale, somaLobeFactor } from "#engine/morphology-geometry.ts";
// D082-A-PERF BEGIN: cache keys follow the geometry producer's version without owning its functions.
import * as neuralGeometryModule from "#engine/morphology-geometry.ts";
// D082-A-PERF END
export { somaLobeAreaScale, somaLobeFactor } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
// D082-A-NODES BEGIN
import { denseEdgeVeilFactor } from "#render-common/dense-node-scale.ts";
// D082-A-NODES END
import { createContainerFrameCache, drawContainers, drawContainerTitles } from "#render-common/container-canvas.ts";
import type { CanvasDisc } from "#render-common/container-canvas.ts";
// D082-B1f BEGIN: Canopy's edge-free Neural layer uses worker-prepared unit outlines.
import { cachedCanopySomaOutlinePacked, canopySomataPrepared, installCanopySomaOutlines } from "../fractal/canopy-soma-cache.ts";
import { prepareCanopySomataOffThread } from "../fractal/canopy-soma-worker.ts";
import { beginCanopySomaFrame, presentCanopySomaFrame } from "../fractal/canopy-soma-readiness.ts";
const canopyWarmups = new WeakMap<MorphologyGeometry, true>();
function warmCanopySomata(geometry: MorphologyGeometry, canvas: HTMLCanvasElement): void {
  if (canopySomataPrepared(geometry) || canopyWarmups.has(geometry)) return;
  canopyWarmups.set(geometry, true);
  const began = performance.now();
  void prepareCanopySomataOffThread(geometry.nodes).then(packed => {
    installCanopySomaOutlines(geometry, packed);
    performance.mark('d082-b1f:canopy-soma-prepared', { detail: {
      durationMs: performance.now() - began, nodes: geometry.nodes.length } });
    if (canvas.isConnected) (canvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw?.();
  }, () => { canopyWarmups.delete(geometry); });
}
// D082-B1f END.
import { STELLAR_DUST_BUCKET_ALPHAS, cachedStellarDustClusters, drawStarfield, stellarDustAlpha, stellarDustFraction } from "#render-common/starfield.ts";
import type { StellarDustCluster } from "#render-common/starfield.ts";
import {
  EDGE_CATEGORY_SET,
  FLOW_HALO_ALPHA,
  FLOW_HALO_WIDTH_MULTIPLIER,
  FLOW_WAVE_MAX_ALPHA,
  // D086-F5 BEGIN
  FLOW_BEAM_WHITE_MIX,
  flowBeamEnvelope,
  flowBeamWidthsPx,
  flowHeadAlpha,
  // D086-F5 END
  // D082-A-PERF BEGIN
  FLOW_ANIMATED_EDGE_BUDGET,
  // D082-A-PERF END
  flowHeadPositionPx,
  flowPulseLengthPx,
  flowWaveAlpha,
  flowMotionAllowedNow,
  flowNow,
  selectFlowEdges,
  setFlowAnimatedEdgeCount,
} from "#render-common/flow.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
/** D-079: retain a specified screen-space spoke width after perspective scaling. */
export function screenSpaceEdgeWidthPx(widthPx: number, minimumScreenWidthPx = 0): number {
  return Math.max(widthPx, minimumScreenWidthPx);
}
export const DENSE_SCENE_THRESHOLD = 1200;
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  // D086-CUSTOM BEGIN
  readonly usesDenseDrawingPolicy?: boolean;
  readonly denseNativeRadiusOnly?: boolean;
  // D086-CUSTOM END
  readonly interaction?: { readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null; readonly labelDiscs?: readonly CanvasDisc[] | null;
    // D086-CUSTOM BEGIN: existing presentation interaction carries policy to both canvas renderers.
    readonly usesDenseDrawingPolicy?: boolean | undefined;
    readonly denseNativeRadiusOnly?: boolean | undefined;
    // D086-CUSTOM END
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
    readonly flowLayer?: "inline" | "separate";
    // D082-A-NCOMPLETA BEGIN
    readonly denseNeuralHaloById?: ReadonlyMap<string, number> | undefined;
    // D082-A-NCOMPLETA END
  } | undefined;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number;
    // D087-SIZE BEGIN
    readonly leafMark?: boolean | undefined;
    // D087-SIZE END
  }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};
// D086-CUSTOM BEGIN: both the direct style and the shared presentation interaction carry the
// same page-owned policy; the latter is the path used by the mounted 2D and 3D canvases.
const denseDrawingPolicy = (style: MorphologyCanvasStyle): boolean =>
  // D087-SIZE BEGIN: the semantic mark policy overrides the density-only veil flag.
  style.usesDenseDrawingPolicy ?? style.interaction?.usesDenseDrawingPolicy ?? false;
  // D087-SIZE END
const denseNativeRadiusOnly = (style: MorphologyCanvasStyle): boolean =>
  style.denseNativeRadiusOnly ?? style.interaction?.denseNativeRadiusOnly ?? false;
// D086-CUSTOM END
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
  // D086-BURST BEGIN: the canvas subset and its certificate share one revision.
  readonly readinessView?: string;
  // D086-BURST END
  // D086-CUSTOM BEGIN
  readonly usesDenseDrawingPolicy?: boolean;
  readonly denseNativeRadiusOnly?: boolean;
  // D086-CUSTOM END
  // D085-S3 BEGIN: renderer-only law hierarchy and relation rank follow in-place density revisions.
  readonly labLevels?: readonly { readonly id: string; readonly level: number }[];
  readonly labRelationRanks?: ReadonlyMap<string, Readonly<{ evidenceCount: number;
    relationClass: 'attested' | 'exploratory' | 'structural' }>>;
  // D085-S3 END
  // D082-A-NODES BEGIN
  readonly nodeEntries: ReadonlyMap<string, { readonly glyph?: NodeGlyph | undefined;
    // D087-SIZE BEGIN
    readonly leafMark?: boolean | undefined;
    // D087-SIZE END
    readonly radiusPx?: number | undefined; readonly haloRadiusPx?: number | undefined;
    readonly haloIntensityPermille?: number | undefined;
    readonly tintSrgb?: readonly [number, number, number] | undefined;
    readonly opacityPermille?: number | undefined }>;
  // D082-A-NODES END
  readonly edgeEntries: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
  // D086-F1 BEGIN: whether the revised subset is a Lab scene whose native discs follow the canvas core.
  readonly nativeNodeSizeLaw?: boolean;
  // D086-F1 END
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

/** Soma-end taper ratio is independent of degree: crowded hubs keep visible roots. */
export function neuralSomaTaperRatio(baseRatio: number, degree: number): number {
  void degree;
  return baseRatio;
}

/** Width at a routed branch: each split retains 76% of its parent's proximal width. */
export function neuralBranchedWidthPx(progress: number, sampleCount: number, depth: number,
  body: number, radius: number, ratio: number): number {
  if (!depth) return body;
  const split = Math.min(depth, Math.max(0, progress / 10));
  const root = neuralJoinedRootWidthPx(body, radius, ratio);
  const dwindled = root * 0.76 ** split;
  const tail = Math.max(0, progress - depth * 10);
  const finish = Math.max(10, (sampleCount - 1) / 2 - depth * 10);
  const fade = Math.min(1, tail / finish);
  return body + (dwindled - body) * (1 - fade * fade * (3 - 2 * fade));
}

/**
 * The drawn Neural width keyframes (same units as the inputs): the width at each soma end and at
 * mid-edge. The contract's taper applies at both ends regardless of degree; the segment's larger
 * end width anchors the data-driven scale.
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

/** Soma roots keep their full alpha at every degree. */
export function neuralRootAlphaFactor(degree: number): number {
  void degree;
  return 1;
}

/** Exact endpoint key of a drawn segment (world-space coordinates, never remultipplied). */
const neuralEndpointKey = (point: Coordinates): string => `${point.x}|${point.y}|${point.z}`;
const neuralEndpointDegreeCache = new WeakMap<MorphologyGeometry, ReadonlyMap<string, number>>();
const neuralEndpointSomaCache = new WeakMap<MorphologyGeometry, ReadonlyMap<string, MorphologyNodeShape>>();
/** The two soma-side ends of a drawn segment; the samples bracket them when a minimal fixture
 * carries no explicit endpoints. */
const segmentEnds = (part: MorphologySegment): readonly (Coordinates | undefined)[] =>
  [part.source ?? part.samples[0], part.target ?? part.samples[part.samples.length - 1]];

/** Resolve roots by their real relation endpoints. A nearby crossing edge cannot inherit a soma. */
export function neuralEndpointSomata(geometry: MorphologyGeometry): ReadonlyMap<string, MorphologyNodeShape> {
  const cached = neuralEndpointSomaCache.get(geometry);
  if (cached) return cached;
  const nodes = new Map(geometry.nodes.map(node => [node.id, node]));
  const somata = new Map<string, MorphologyNodeShape>();
  // Some synthetic draw-cost fixtures omit relation records; they have no provable roots.
  for (const edge of geometry.edges ?? []) {
    const first = edge.segments[0], last = edge.segments[edge.segments.length - 1];
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (first && source) somata.set(neuralEndpointKey(first.source), source);
    if (last && target) somata.set(neuralEndpointKey(last.target), target);
  }
  neuralEndpointSomaCache.set(geometry, somata);
  return somata;
}

/**
 * The soma degree at each real relation end, memoised per geometry, and 1 where no soma is found.
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

/** Deterministic per-soma elongation factor (±4%), driven by the id-hashed outline harmonics'
 * phases, so the same ellipse template is never merely rotated across somata. */
export const SOMA_ELONGATION_JITTER = 0.04;
export function somaElongationFactor(harmonics: readonly SomaOutlineHarmonic[]): number {
  if (harmonics.length === 0) return 1;
  const weighted = harmonics.reduce((sum, harmonic, index) => sum + harmonic.phase * (index + 1), 0);
  return 1 + SOMA_ELONGATION_JITTER * Math.sin(weighted);
}

/** The drawn elongation of one soma: the connection-driven eccentricity with the deterministic
 * per-node jitter, kept inside the compact 1.04–1.32 axis bounds. A round soma (no local
 * connections to orient it) is left exactly round. */
export function somaDrawnElongation(eccentricity: number, harmonics: readonly SomaOutlineHarmonic[]): number {
  if (eccentricity <= 1) return eccentricity;
  return clamp(eccentricity * somaElongationFactor(harmonics), Math.min(1.04, eccentricity), 1.32);
}

/** The edge-driven lobes stay visible at fit; their total radial deviation remains capped. */
export const SOMA_IRREGULARITY_BOOST = 1.6;
export const SOMA_IRREGULARITY_MIN_SCALE = 1;
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
// D084-W2-NEURAL-R6 BEGIN: Neural opacity belongs to its own node presentation;
// only Stellar and Mycelium retain a node floor.
/** The alpha floor of one morphology's node core/soma body. */
export function morphologyCoreAlphaFloor(morphology: Morphology): number {
  return morphology === "stellar" ? STELLAR_CORE_MIN_ALPHA : morphology === "neural" ? 0 : 0.48;
}
/** Match the neural outline's own paint, including depth and node focus opacity. */
export function neuralSomaOutlineAlpha(baseOpacity: number, emphasisBrightness: number,
  scale: number, projection: "2d" | "3d", indra3d = false, focusOpacity = 1): number {
  const depth = projection === "3d" ? indra3d ? bucketedDepthScale(scale) : clamp(scale, 0, 1) : 1;
  const depthAlpha = projection === "3d" ? clamp(0.85 + 0.15 * depth, 0.85, 1) : 1;
  return clamp(baseOpacity * emphasisBrightness * depthAlpha, 0, 1) * focusOpacity;
}
// D084-W2-NEURAL-R6 END

// ---------------------------------------------------------------- D-072 M1b star grammar
//
// A Stellar data node draws as a star of the plexus reference: a small, bright, nearly
// opaque core whose size still follows the importance scale (the contract's 2–10 px window the
// layout sizes into), compressed at draw time into the 2–5 px star window — up to 6.5 px where the
// node's degree marks it a domain hub. The pick radius is untouched: the pickers size from the
// same pre-mapping basis (`radiusPx`/`node.radius`), so clicking never gets harder.

/** Drawn core radius of a regular star, in CSS px: the importance scale compresses into this window. */
export const STELLAR_STAR_CORE_MIN_PX = 2;
export const STELLAR_STAR_CORE_MAX_PX = 5;
/** The window grows toward this cap as the node's degree marks it a domain hub. */
export const STELLAR_STAR_HUB_MAX_PX = 6.5;
/** Degree at which the hub window starts growing, and at which it reaches the full 6.5 px. */
export const STELLAR_STAR_HUB_DEGREE = 8;
export const STELLAR_STAR_HUB_FULL_DEGREE = 14;

/** The star-core window of one degree: 5 px up to {@link STELLAR_STAR_HUB_DEGREE}, then a linear
 * rise to 6.5 px at {@link STELLAR_STAR_HUB_FULL_DEGREE}. Pure, monotone in the degree. */
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

/** Importance lights the opaque nucleus in both projections; a top hub approaches white. */
export function stellarCoreLuminance(baseRadiusPx: number, degree: number): number {
  const size = clamp((baseRadiusPx - 2) / (MORPHOLOGY_CONTRACT.stellar.node.maxRadiusPx - 2), 0, 1);
  const connectivity = clamp(degree / STELLAR_STAR_HUB_FULL_DEGREE, 0, 1);
  return 0.2 + 0.78 * Math.max(size, connectivity);
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
  width: number, height: number, density = 0.25, brightness = 0.5): void {
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
const STELLAR_DUST_FALLBACK_COLOUR = "rgb(230, 230, 230)";

/** D-072 M1b: the peak centre alpha of the per-community cluster glow. ≤ 0.06 by brief; one cached
 * radial sprite per (colour, alpha) serves every community, composed under translate + scale. */
export const STELLAR_CLUSTER_GLOW_ALPHA = 0.05;
/** A community smaller than this on screen reads through its stars and dust alone: no glow disc. */
export const STELLAR_CLUSTER_GLOW_MIN_RADIUS_PX = 12;

/** A 3D community glow is decorative mass, not an ambient field. Its projected disc fades before
 * it spans the viewport; the 2D glow and ordinary 3D sizes retain their approved paint. */
export function stellarClusterGlowZoomOpacity(radiusPx: number, width: number, height: number): number {
  const shortSide = Math.min(width, height);
  if (!(shortSide > 0) || !Number.isFinite(radiusPx)) return 0;
  const t = clamp((radiusPx / shortSide - 0.58) / 0.17, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

// D084-HAZE BEGIN
/** The D-072 community discs resolved in screen space, with the original extent, colour and
 * quantised peak (including the 3D viewport fade). */
export type StellarClusterGlowDisc = {
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  readonly peakAlpha: number;
  readonly rgb: readonly [number, number, number];
};

export function resolveStellarClusterGlowDiscs(
  clusters: readonly StellarDustCluster[],
  project: (point: Coordinates) => ProjectedPoint,
  nodeColour: (hubId: string) => string | undefined,
  width: number,
  height: number,
  projection: "2d" | "3d" = "2d",
): readonly StellarClusterGlowDisc[] {
  const discs: StellarClusterGlowDisc[] = [];
  for (const cluster of clusters) {
    const centre = project(cluster.center);
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) continue;
    const rim = project({ x: cluster.center.x + cluster.radius, y: cluster.center.y, z: cluster.center.z });
    const radius = Math.hypot(rim.x - centre.x, rim.y - centre.y);
    if (!(radius >= STELLAR_CLUSTER_GLOW_MIN_RADIUS_PX)) continue;
    const zoomOpacity = projection === "3d" ? stellarClusterGlowZoomOpacity(radius, width, height) : 1;
    if (zoomOpacity <= 0) continue;
    if (centre.x + radius < 0 || centre.x - radius > width || centre.y + radius < 0 || centre.y - radius > height) continue;
    discs.push({
      x: centre.x,
      y: centre.y,
      radiusPx: radius,
      peakAlpha: quantisedAlpha(STELLAR_CLUSTER_GLOW_ALPHA * zoomOpacity),
      rgb: colourChannels(nodeColour(cluster.hubId) ?? STELLAR_DUST_FALLBACK_COLOUR),
    });
  }
  return discs;
}

/** Original D-072 radial stops: centre 1, radius 0.55 at 0.35, rim 0. */
export function stellarClusterGlowProfile(peakAlpha: number, radiusFraction: number): number {
  const t = clamp(radiusFraction, 0, 1);
  return peakAlpha * (t <= 0.55 ? 1 - (t / 0.55) * 0.65 : (0.35 * (1 - t)) / 0.45);
}

/** At every pixel p covered by glow discs i with alpha a_i(p) and colour c_i:
 * alpha(p) = max_i a_i(p);
 * colour(p) = Σ a_i(p)·c_i / Σ a_i(p);
 * composited source-over with that alpha. One isolated disc therefore reproduces the D-072 paint
 * exactly, and monochrome overlaps equal the strongest single disc. */
export function stellarClusterGlowFieldAt(
  discs: readonly StellarClusterGlowDisc[], x: number, y: number,
): { readonly alpha: number; readonly rgb: readonly [number, number, number] } {
  let alpha = 0;
  let sum = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let maxRed = 0;
  let maxGreen = 0;
  let maxBlue = 0;
  let firstRgb: readonly [number, number, number] | null = null;
  let monochrome = true;
  for (const disc of discs) {
    if (!(disc.radiusPx > 0)) continue;
    const dx = x - disc.x;
    const dy = y - disc.y;
    if (Math.abs(dx) >= disc.radiusPx || Math.abs(dy) >= disc.radiusPx) continue;
    const t = Math.hypot(dx, dy) / disc.radiusPx;
    if (t >= 1) continue;
    const a = stellarClusterGlowProfile(disc.peakAlpha, t);
    if (a <= 0) continue;
    if (firstRgb === null) firstRgb = disc.rgb;
    else if (disc.rgb[0] !== firstRgb[0] || disc.rgb[1] !== firstRgb[1]
      || disc.rgb[2] !== firstRgb[2]) monochrome = false;
    alpha = Math.max(alpha, a);
    sum += a;
    red += a * disc.rgb[0];
    green += a * disc.rgb[1];
    blue += a * disc.rgb[2];
    maxRed = Math.max(maxRed, disc.rgb[0]);
    maxGreen = Math.max(maxGreen, disc.rgb[1]);
    maxBlue = Math.max(maxBlue, disc.rgb[2]);
  }
  // Clamp floating-point roundoff so the weighted mean cannot exceed any channel's coverage max.
  return { alpha, rgb: sum > 0
    ? monochrome ? firstRgb! : [Math.min(maxRed, red / sum), Math.min(maxGreen, green / sum), Math.min(maxBlue, blue / sum)]
    : [0, 0, 0] };
}

/** Limit the first settled frame to roughly 200,000 disc-cell evaluations. The field is
 * decorative and smooth, so exceptionally dense scenes can use a coarser smoothed grid. */
export const STELLAR_CLUSTER_GLOW_WORK_BUDGET = 200_000;

export type StellarClusterGlowPlan = {
  readonly step: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly plannedEvaluations: number;
};

type GlowCellBox = { left: number; right: number; top: number; bottom: number };

/** First cell centre greater than low, and first cell centre at least high. This uses the same
 * cell-centre expression as raster sampling, including its floating-point boundary behaviour. */
function glowCellRange(low: number, high: number, extent: number, count: number): readonly [number, number] {
  const bound = (value: number, strict: boolean): number => {
    let first = 0;
    let last = count;
    while (first < last) {
      const middle = (first + last) >>> 1;
      const centre = (middle + 0.5) * extent / count;
      if (strict ? centre <= value : centre < value) first = middle + 1;
      else last = middle;
    }
    return first;
  };
  return [bound(low, true), bound(high, false)];
}

function glowCellBox(disc: StellarClusterGlowDisc, width: number, height: number,
  gridWidth: number, gridHeight: number): GlowCellBox {
  const [left, right] = glowCellRange(disc.x - disc.radiusPx, disc.x + disc.radiusPx, width, gridWidth);
  const [top, bottom] = glowCellRange(disc.y - disc.radiusPx, disc.y + disc.radiusPx, height, gridHeight);
  return { left, right, top, bottom };
}

/** Pure plan for the existing ≤120,000-cell grid and its disc-bounding-box work. */
export function planStellarClusterGlowField(
  discs: readonly StellarClusterGlowDisc[], width: number, height: number,
): StellarClusterGlowPlan {
  if (!(width > 0) || !(height > 0)) return { step: 0, gridWidth: 0, gridHeight: 0, plannedEvaluations: 0 };
  let step = Math.max(1, Math.ceil(Math.sqrt(width * height / 120000) * 16) / 16);
  for (;;) {
    const gridWidth = Math.ceil(width / step);
    const gridHeight = Math.ceil(height / step);
    if (gridWidth * gridHeight > 120000) {
      step += 1 / 16;
      continue;
    }
    let plannedEvaluations = 0;
    for (const disc of discs) {
      if (!(disc.radiusPx > 0)) continue;
      const box = glowCellBox(disc, width, height, gridWidth, gridHeight);
      plannedEvaluations += (box.right - box.left) * (box.bottom - box.top);
    }
    if (plannedEvaluations <= STELLAR_CLUSTER_GLOW_WORK_BUDGET) {
      return { step, gridWidth, gridHeight, plannedEvaluations };
    }
    if (gridWidth === 1 && gridHeight === 1) {
      throw new RangeError("Stellar cluster glow work exceeds budget at a one-cell grid");
    }
    // Jump close to the required spacing, then remeasure exact bounding-box counts.
    step = Math.max(step + 1 / 16,
      Math.ceil(step * Math.sqrt(plannedEvaluations / STELLAR_CLUSTER_GLOW_WORK_BUDGET) * 16) / 16);
  }
}

/** Disc-first accumulation. Float64 preserves the reference's ordered sums before RGBA rounding. */
export function sampleStellarClusterGlowField(
  discs: readonly StellarClusterGlowDisc[], width: number, height: number, plan: StellarClusterGlowPlan,
): { readonly data: Uint8ClampedArray; readonly evaluations: number } {
  const { gridWidth, gridHeight } = plan;
  const cells = gridWidth * gridHeight;
  const alpha = new Float64Array(cells);
  const sum = new Float64Array(cells);
  const red = new Float64Array(cells);
  const green = new Float64Array(cells);
  const blue = new Float64Array(cells);
  const maxRed = new Float64Array(cells);
  const maxGreen = new Float64Array(cells);
  const maxBlue = new Float64Array(cells);
  const firstRed = new Float64Array(cells);
  const firstGreen = new Float64Array(cells);
  const firstBlue = new Float64Array(cells);
  const monochrome = new Uint8Array(cells);
  let evaluations = 0;
  for (const disc of discs) {
    const { x: centreX, y: centreY, radiusPx: radius, peakAlpha, rgb } = disc;
    if (!(radius > 0)) continue;
    const box = glowCellBox(disc, width, height, gridWidth, gridHeight);
    for (let row = box.top; row < box.bottom; row += 1) {
      const dy = (row + 0.5) * height / gridHeight - centreY;
      const chordSquared = radius * radius - dy * dy;
      if (chordSquared <= 0) continue;
      const chord = Math.sqrt(chordSquared);
      const [left, right] = glowCellRange(centreX - chord, centreX + chord, width, gridWidth);
      for (let column = Math.max(box.left, left); column < Math.min(box.right, right); column += 1) {
        evaluations += 1;
        const x = (column + 0.5) * width / gridWidth;
        const dx = x - centreX;
        const t = Math.sqrt(dx * dx + dy * dy) / radius;
        if (t >= 1) continue;
        const a = stellarClusterGlowProfile(peakAlpha, t);
        if (a <= 0) continue;
        const index = row * gridWidth + column;
        if (sum[index] === 0) {
          firstRed[index] = rgb[0];
          firstGreen[index] = rgb[1];
          firstBlue[index] = rgb[2];
          monochrome[index] = 1;
        } else if (rgb[0] !== firstRed[index] || rgb[1] !== firstGreen[index]
          || rgb[2] !== firstBlue[index]) monochrome[index] = 0;
        alpha[index] = Math.max(alpha[index]!, a);
        sum[index] = sum[index]! + a;
        red[index] = red[index]! + a * rgb[0];
        green[index] = green[index]! + a * rgb[1];
        blue[index] = blue[index]! + a * rgb[2];
        maxRed[index] = Math.max(maxRed[index]!, rgb[0]);
        maxGreen[index] = Math.max(maxGreen[index]!, rgb[1]);
        maxBlue[index] = Math.max(maxBlue[index]!, rgb[2]);
      }
    }
  }
  const data = new Uint8ClampedArray(cells * 4);
  for (let index = 0; index < cells; index += 1) {
    const offset = index * 4;
    if (sum[index]! > 0) {
      data[offset] = Math.round(monochrome[index] ? firstRed[index]! : Math.min(maxRed[index]!, red[index]! / sum[index]!));
      data[offset + 1] = Math.round(monochrome[index] ? firstGreen[index]! : Math.min(maxGreen[index]!, green[index]! / sum[index]!));
      data[offset + 2] = Math.round(monochrome[index] ? firstBlue[index]! : Math.min(maxBlue[index]!, blue[index]! / sum[index]!));
    }
    data[offset + 3] = Math.round(alpha[index]! * 255);
  }
  return { data, evaluations };
}

/** A single delayed callback asks the owning renderer to present its settled frame. */
export type StellarClusterGlowTiming = {
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
  requestRedraw(): void;
};

type FinishedGlow = {
  key: string;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  discs: readonly StellarClusterGlowDisc[];
  width: number;
  height: number;
  backingWidth: number;
  backingHeight: number;
  dpr: number;
};
type GlowCache = { key: string; since: number; consecutive: number; timer?: unknown; finished?: FinishedGlow };
const stellarClusterGlowLayers = new WeakMap<CanvasRenderingContext2D, GlowCache>();

function stellarClusterGlowCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    return document.createElement("canvas");
  }
  return typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : null;
}

/** Fit current = scale * cached + translation over centres and radii. A 2D camera pan/zoom
 * has zero residual; an orbit or a changed palette is not painted from stale pixels. */
function glowSimilarity(from: readonly StellarClusterGlowDisc[], to: readonly StellarClusterGlowDisc[])
  : { scale: number; x: number; y: number } | null {
  if (from.length !== to.length || from.length === 0) return null;
  let oldX = 0, oldY = 0, newX = 0, newY = 0;
  for (let i = 0; i < from.length; i++) {
    const a = from[i]!, b = to[i]!;
    if (a.peakAlpha !== b.peakAlpha || a.rgb.some((v, channel) => v !== b.rgb[channel])) return null;
    oldX += a.x; oldY += a.y; newX += b.x; newY += b.y;
  }
  oldX /= from.length; oldY /= from.length; newX /= to.length; newY /= to.length;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < from.length; i++) {
    const a = from[i]!, b = to[i]!;
    numerator += (a.x - oldX) * (b.x - newX) + (a.y - oldY) * (b.y - newY) + a.radiusPx * b.radiusPx;
    denominator += (a.x - oldX) ** 2 + (a.y - oldY) ** 2 + a.radiusPx ** 2;
  }
  const scale = numerator / denominator;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const x = newX - scale * oldX, y = newY - scale * oldY;
  let squaredError = 0;
  for (let i = 0; i < from.length; i++) {
    const a = from[i]!, b = to[i]!;
    squaredError += (scale * a.x + x - b.x) ** 2 + (scale * a.y + y - b.y) ** 2
      + (scale * a.radiusPx - b.radiusPx) ** 2;
  }
  return Math.sqrt(squaredError / from.length) <= 1 ? { scale, x, y } : null;
}

function paintStellarClusterGlowComposed(
  context: CanvasRenderingContext2D, discs: readonly StellarClusterGlowDisc[], width: number, height: number,
  timing?: StellarClusterGlowTiming,
): void {
  const destination = context.canvas;
  if (!(width > 0) || !(height > 0) || !destination || !(destination.width > 0)
    || !(destination.height > 0) || typeof context.drawImage !== "function") return;
  // Quantise geometry to 1/64 CSS px for a stable key; backing dimensions also encode DPR.
  const quantise = (value: number) => Math.round(value * 64);
  const dpr = typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio)
    ? devicePixelRatio : destination.width / width;
  const key = JSON.stringify([width, height, destination.width, destination.height, dpr,
    discs.map(disc => [quantise(disc.x), quantise(disc.y), quantise(disc.radiusPx),
      disc.peakAlpha, ...disc.rgb])]);
  const redraw = (destination as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw;
  const clock: StellarClusterGlowTiming = timing ?? {
    now: () => performance.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    requestRedraw: () => (destination as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw?.(),
  };
  const now = clock.now();
  let cache = stellarClusterGlowLayers.get(context);
  if (!cache) { cache = { key, since: now, consecutive: 1 }; stellarClusterGlowLayers.set(context, cache); }
  else if (cache.key !== key) {
    if (cache.timer !== undefined) clock.cancel(cache.timer);
    cache.key = key; cache.since = now; cache.consecutive = 1; cache.timer = undefined;
  } else cache.consecutive++;
  const due = cache.consecutive >= 2 || now - cache.since >= 120;
  if (cache.finished?.key !== key && due) {
    if (cache.timer !== undefined) { clock.cancel(cache.timer); cache.timer = undefined; }
    const canvas = cache.finished?.canvas ?? stellarClusterGlowCanvas();
    if (!canvas) return; // Decorative glow is omitted when safe composition is unavailable.
    const plan = planStellarClusterGlowField(discs, width, height);
    const { gridWidth, gridHeight } = plan;
    canvas.width = gridWidth;
    canvas.height = gridHeight;
    const layer = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!layer || typeof layer.createImageData !== "function" || typeof layer.putImageData !== "function") return;
    const image = layer.createImageData(gridWidth, gridHeight);
    if (!image || !image.data) return;
    image.data.set(sampleStellarClusterGlowField(discs, width, height, plan).data);
    layer.putImageData(image, 0, 0);
    cache.finished = { key, canvas, discs: [...discs], width, height,
      backingWidth: destination.width, backingHeight: destination.height, dpr };
  }
  if (cache.finished?.key !== key && cache.timer === undefined && (timing || redraw)) {
    cache.timer = clock.schedule(() => {
      cache!.timer = undefined;
      // A removed or destroyed owner cannot present a settled frame.
      if ((destination as HTMLCanvasElement).isConnected === false
        || !(destination as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw) return;
      // A newer key cancels this callback; the renderer owns the actual draw boundary.
      clock.requestRedraw();
    }, Math.max(0, 120 - (now - cache.since)));
  }
  const finished = cache.finished;
  if (!finished) return;
  const transform = finished.key === key ? { scale: 1, x: 0, y: 0 }
    : finished.width === width && finished.height === height
      && finished.backingWidth === destination.width && finished.backingHeight === destination.height
      && finished.dpr === dpr ? glowSimilarity(finished.discs, discs) : null;
  if (!transform) return;
  const priorAlpha = context.globalAlpha;
  const priorComposite = context.globalCompositeOperation;
  const priorSmoothing = context.imageSmoothingEnabled;
  try {
    // The caller's transform already maps CSS px to backing px. Keep it for this CSS-sized draw.
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.imageSmoothingEnabled = true;
    context.drawImage(finished.canvas, transform.x, transform.y,
      finished.width * transform.scale, finished.height * transform.scale);
  } finally {
    context.imageSmoothingEnabled = priorSmoothing;
    context.globalCompositeOperation = priorComposite;
    context.globalAlpha = priorAlpha;
  }
}
// D084-HAZE END

// D084-HAZE BEGIN
/** The optional D-072 cluster mass, composed into one translucent field beneath the dust.
 * It is decorative and carries no identifier, label, witness, or hit-test surface. */
export function drawStellarClusterGlow(context: CanvasRenderingContext2D, clusters: readonly StellarDustCluster[],
  project: (point: Coordinates) => ProjectedPoint, nodeColour: (hubId: string) => string | undefined,
  width: number, height: number, projection: "2d" | "3d" = "2d",
  timing?: StellarClusterGlowTiming): void {
  const discs = resolveStellarClusterGlowDiscs(clusters, project, nodeColour, width, height, projection);
  if (discs.length > 0) paintStellarClusterGlowComposed(context, discs, width, height, timing);
}
// D084-HAZE END

/** D-072 V5: every Neural edge overlaps the drawn soma outline by about this much, so the dendrite
 * and the soma read as one body with no suspended-egg gap. */
export const NEURAL_EDGE_SOMA_OVERLAP_PX = 0.5;

// D081-P1F BEGIN: the visible leaf root stays wide at the outline, then eases to shaft width.
// D084-W2-NEURAL-R2: the soma-relative cap is 0.4 radii, not 0.9 — the ordinary-width
// term binds at the approved close-up radii (the value there is unchanged), while a small
// drawn soma keeps the same root-to-body ratio instead of a tail as thick as its body.
export function neuralLeafRootWidthPx(distanceFromTipPx: number, ordinaryPx: number,
  somaRadiusPx: number): number {
  const root = Math.max(ordinaryPx * 2, Math.min(somaRadiusPx * 0.4, ordinaryPx * 6));
  const t = clamp(distanceFromTipPx / Math.max(somaRadiusPx, 1), 0, 1);
  const ease = t * t * (3 - 2 * t);
  return ordinaryPx + (root - ordinaryPx) * (1 - ease);
}
// D081-P1F END

/** The drawn soma of one node under the live projection: centre, rotation, clamped radius and
 * eccentricity exactly as the node pass paints them. The junction pass consumes the same values, so
 * the edge start meets the soma that is actually on screen. */
export type NeuralSomaFrame = {
  readonly x: number; readonly y: number;
  readonly angle: number;
  readonly radius: number;
  readonly eccentricity: number;
  readonly harmonics: readonly SomaOutlineHarmonic[];
  readonly spindle?: boolean;
  readonly leaf?: boolean;
  readonly lobes?: readonly { readonly angle: number; readonly strength: number }[];
  readonly lobeAreaScale?: number;
};
export const NEURAL_SOMA_MAX_VERTICES = 64;

// D082-A-PERF BEGIN: expensive angular integration and outline harmonics are
// invariant under translation and zoom. Keep only dimensionless shape samples;
// each frame still projects positions and applies its exact current radius.
const neuralShapeSignatures = new WeakMap<MorphologyNodeShape, string>();
const neuralLobeAreas = new Map<string, number>();
const neuralSilhouettes = new Map<string, readonly number[]>();
const neuralShapeStats = { lobeHits: 0, lobeMisses: 0, silhouetteHits: 0, silhouetteMisses: 0 };
export function readNeuralShapeCacheStats(): Readonly<typeof neuralShapeStats> { return { ...neuralShapeStats }; }
// D082-A-PERF BEGIN: enough room for one complete 11,199-node view, with a
// fixed ceiling across successive mode switches. Both maps evict oldest keys.
const NEURAL_SHAPE_CACHE_LIMIT = 12_000;
const NEURAL_SHAPE_CACHE_BYTES = 4 * 1024 * 1024;
let neuralLobeBytes = 0;
let neuralSilhouetteBytes = 0;
function shapeCacheGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value !== undefined) { cache.delete(key); cache.set(key, value); }
  return value;
}
function shapeCacheSet<T>(cache: Map<string, T>, key: string, value: T,
  bytes: number, kind: "lobe" | "silhouette"): void {
  if (bytes > NEURAL_SHAPE_CACHE_BYTES) return;
  let total = kind === "lobe" ? neuralLobeBytes : neuralSilhouetteBytes;
  // D082-A-PERF BEGIN: replacing a key must release its previous accounting.
  const previous = cache.get(key);
  if (previous !== undefined) {
    total -= key.length * 2 + (Array.isArray(previous) ? previous.length * 8 : 8);
    cache.delete(key);
  }
  // D082-A-PERF END
  cache.set(key, value);
  total += bytes;
  while (cache.size > NEURAL_SHAPE_CACHE_LIMIT || total > NEURAL_SHAPE_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    total -= oldest.length * 2 + (Array.isArray(removed) ? removed.length * 8 : 8);
    cache.delete(oldest);
  }
  if (kind === "lobe") neuralLobeBytes = total; else neuralSilhouetteBytes = total;
}
export function neuralShapeCacheOccupancy() {
  return { lobes: neuralLobeAreas.size, silhouettes: neuralSilhouettes.size,
    lobeBytes: neuralLobeBytes, silhouetteBytes: neuralSilhouetteBytes,
    entryLimit: NEURAL_SHAPE_CACHE_LIMIT, byteLimit: NEURAL_SHAPE_CACHE_BYTES };
}
// D082-A-PERF END
function neuralShapeVersion(): string {
  const declared: unknown = Reflect.get(neuralGeometryModule, "NEURAL_GEOMETRY_VERSION");
  return typeof declared === "string" ? declared : "d081";
}
function nodeShapeSignature(node: MorphologyNodeShape): string {
  let signature = neuralShapeSignatures.get(node);
  if (signature === undefined) {
    const source = JSON.stringify([neuralShapeVersion(), node.id, node.position, node.radius,
      node.outline, node.trunks, node.degree, node.spindleRatio, node.eccentricity]);
    // D082-A-PERF BEGIN: keep a compact deterministic fingerprint, not the
    // full serialised node (hundreds of bytes) in every camera-variant key.
    // Four independent 32-bit lanes make accidental aliasing negligible while
    // preserving cross-remount hits for identical immutable geometry.
    const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    for (let index = 0; index < source.length; index++) {
      const code = source.charCodeAt(index);
      for (let lane = 0; lane < lanes.length; lane++)
        lanes[lane] = Math.imul(lanes[lane]! ^ (code + lane * 0x10001), 0x01000193 + lane * 2);
    }
    signature = lanes.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");
    // D082-A-PERF END
    neuralShapeSignatures.set(node, signature);
  }
  return signature;
}
function angularKey(node: MorphologyNodeShape, frame: NeuralSomaFrame): string {
  // D082-A-PERF BEGIN: a camera roll rotates both the soma axis and its lobes.
  // The integration and sampled silhouette depend on their relative angles,
  // while the final path applies the current projection and radius below.
  // Keep perspective variants bounded by the cache's byte ceiling.
  const round = (value: number) => Math.round(value * 1e3) / 1e3;
  const relative = (angle: number) => Math.atan2(Math.sin(angle - frame.angle), Math.cos(angle - frame.angle));
  return JSON.stringify([nodeShapeSignature(node), round(frame.eccentricity),
    round(somaIrregularityScale(frame.radius)),
    frame.lobes?.map(lobe => [round(relative(lobe.angle)), round(lobe.strength)])]);
  // D082-A-PERF END
}
// D082-A-PERF BEGIN: integrate the 3D lobe area once in the node's own basis.
// Perspective changes the screen ellipse and the projected trunk directions;
// this fixed normalizer preserves the lobe's area to first order without 64
// angular samples on every wheel recovery. Translation, zoom and camera pose
// only transform the already-normalized outline in the frame below.
type LocalLobeShape = { readonly axisAngle: number;
  readonly lobeAngles: readonly number[]; readonly lobes: readonly { angle: number; strength: number }[] };
const localLobeShapes = new WeakMap<MorphologyNodeShape, LocalLobeShape>();
function localLobeShape(node: MorphologyNodeShape): LocalLobeShape {
  const hit = localLobeShapes.get(node);
  if (hit) return hit;
  const axis = node.axis ?? { x: 1, y: 0, z: 0 };
  const useYZ = Math.hypot(axis.x, axis.y) < 1e-6;
  const angleOf = (direction: Coordinates) => Math.atan2(useYZ ? direction.z : direction.y,
    useYZ ? direction.y : direction.x);
  const trunks = neuralPrincipalTrunks(node.trunks ?? []);
  const maximum = Math.max(1, ...trunks.map(trunk => trunk.weight));
  const lobes = trunks.map(trunk => ({ angle: angleOf(trunk.direction),
    strength: neuralTrunkLobeStrength(trunk, maximum, node.degree) }));
  const result = { axisAngle: angleOf(axis), lobeAngles: lobes.map(lobe => lobe.angle), lobes };
  localLobeShapes.set(node, result);
  return result;
}
export function neuralLocalLobeAreaScale(node: MorphologyNodeShape): number {
  const { axisAngle: localAngle, lobes } = localLobeShape(node);
  if (!lobes.length) return 1;
  const harmonics = node.outline ?? [];
  const eccentricity = node.spindleRatio
    ? clamp(node.spindleRatio * somaElongationFactor(harmonics), 1.6, 2.2)
    : somaDrawnElongation(node.eccentricity ?? 1, harmonics);
  const localFrame: NeuralSomaFrame = { x: 0, y: 0, angle: localAngle,
    radius: 11, eccentricity, harmonics, spindle: !!node.spindleRatio,
    leaf: node.degree === 1, lobes: [] };
  return somaLobeAreaScale(lobes, angle => somaOutlineRadiusAtAngle(localFrame, angle));
}
function localLobesProjectUnchanged(node: MorphologyNodeShape, frame: NeuralSomaFrame): boolean {
  // An unrotated planar projection has the exact approved 2D outline. Reuse
  // that integration key to preserve 2D/3D pixel parity in this special case.
  const shape = localLobeShape(node);
  const aligned = (a: number, b: number) =>
    Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-12;
  if (!aligned(frame.angle, shape.axisAngle)) return false;
  return shape.lobeAngles.length === (frame.lobes?.length ?? 0)
    && shape.lobeAngles.every((angle, index) => aligned(frame.lobes![index]!.angle, angle));
}
function cachedLobeArea(node: MorphologyNodeShape, frame: NeuralSomaFrame,
  projection: "2d" | "3d"): number {
  const local = projection === "3d" && !localLobesProjectUnchanged(node, frame);
  const key = local ? `local:${nodeShapeSignature(node)}` : angularKey(node, frame);
  const hit = shapeCacheGet(neuralLobeAreas, key);
  if (hit !== undefined) { neuralShapeStats.lobeHits++; return hit; }
  neuralShapeStats.lobeMisses++;
  const value = local ? neuralLocalLobeAreaScale(node)
    : somaLobeAreaScale(frame.lobes ?? [],
      polarAngle => somaOutlineRadiusAtAngle({ ...frame, lobes: [] }, polarAngle));
  shapeCacheSet(neuralLobeAreas, key, value, key.length * 2 + 8, "lobe");
  return value;
}
function cachedSomaSilhouette(node: MorphologyNodeShape, frame: NeuralSomaFrame,
  steps: number): readonly number[] {
  const key = `${angularKey(node, frame)}:${steps}`;
  const hit = shapeCacheGet(neuralSilhouettes, key);
  if (hit) { neuralShapeStats.silhouetteHits++; return hit; }
  neuralShapeStats.silhouetteMisses++;
  const major = frame.radius * frame.eccentricity;
  const minor = frame.radius;
  const irregularityScale = somaIrregularityScale(frame.radius);
  const result = Array.from({ length: steps }, (_, i) => {
    const theta = (i / steps) * Math.PI * 2;
    const bulge = 1 + clamp(
      somaOutlineIrregularity(node.outline ?? [], theta) * irregularityScale * SOMA_IRREGULARITY_BOOST,
      -NEURAL_SOMA_OUTLINE_MAX_RADIAL, NEURAL_SOMA_OUTLINE_MAX_RADIAL);
    const polarAngle = Math.atan2(minor * Math.sin(theta), major * Math.cos(theta)) + frame.angle;
    return bulge * (node.spindleRatio ? somaSpindleFactor(theta) : 1)
      * somaLobeFactor(frame.lobes ?? [], polarAngle, frame.lobeAreaScale);
  });
  shapeCacheSet(neuralSilhouettes, key, result, key.length * 2 + result.length * 8, "silhouette");
  return result;
}
// D082-A-PERF END

/** A broad, smooth lobe extends the leading soma pole into its strongest real process. */
export function somaSpindleFactor(theta: number): number {
  return 1 + 0.16 * Math.cos(theta) - 0.045 * Math.cos(2 * theta);
}

/** The screen frame of every soma of a neural geometry under one projection. Per frame, per node:
 * the same clamp, elongation and orientation formulas the node pass draws with. */
export function neuralSomaFrames(geometry: MorphologyGeometry, project: (point: Coordinates) => ProjectedPoint,
  style: MorphologyCanvasStyle, contract: (typeof MORPHOLOGY_CONTRACT)[keyof typeof MORPHOLOGY_CONTRACT],
  appearance: AppearanceOptions, projection: "2d" | "3d" = "2d", moving = false,
  // D082-A-PERF BEGIN: the flow overlay needs only animated endpoints.
  nodeIds?: ReadonlySet<string>): ReadonlyMap<string, NeuralSomaFrame> {
  // D082-A-PERF END
  const frames = new Map<string, NeuralSomaFrame>();
  for (const node of geometry.nodes) {
    // D082-A-PERF BEGIN
    if (nodeIds && !nodeIds.has(node.id)) continue;
    // D082-A-PERF END
    const p = project(node.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = style.nodes.get(node.id)?.radiusPx ?? node.radius * appearance.nodeScale;
    // D082-A-NODES BEGIN
    // D086-CUSTOM BEGIN
    // D087-SIZE BEGIN
    if (projection === "3d" ? given === 0 : denseDrawingPolicy(style) && given === 0) continue;
    // D087-SIZE END
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      projection === "3d" ? (style.nodes.get(node.id)?.leafMark ? 0.5 : 2)
        : denseDrawingPolicy(style) ? 0.5 : 2, contract.node.maxRadiusPx);
    // D086-CUSTOM END
    // D082-A-NODES END
    const axis = node.axis ?? { x: 1, y: 0, z: 0 };
    const q = project({ x: node.position.x + axis.x, y: node.position.y + axis.y, z: node.position.z + axis.z });
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    // D082-A-PERF BEGIN: moving quality needs direction and a stable scale,
    // not three more projected basis points per soma on every camera event.
    const basis = moving ? [] : [
      project({ x: node.position.x + 1, y: node.position.y, z: node.position.z }),
      project({ x: node.position.x, y: node.position.y + 1, z: node.position.z }),
      project({ x: node.position.x, y: node.position.y, z: node.position.z + 1 }),
    ];
    const projectedUnit = moving ? Math.max(1e-9, p.scale)
      : Math.max(1e-9, ...basis.map(value => Math.hypot(value.x - p.x, value.y - p.y)));
    // D082-A-PERF END
    const visibleAxis = clamp(Math.hypot(q.x - p.x, q.y - p.y) / projectedUnit, 0, 1);
    const projectedEccentricity = Math.sqrt(1 + ((node.spindleRatio ?? node.eccentricity ?? 1) ** 2 - 1) * visibleAxis ** 2);
    // A 3D camera can foreshorten a trunk almost to a point. Keep its soma spindle legible in the
    // overlay, while orienting it along that trunk's projected direction. The radius above still
    // uses the node's existing projected screen scale. The 2D projection keeps its approved frame.
    const eccentricity = projection === "3d" && node.spindleRatio
      ? clamp(node.spindleRatio * somaElongationFactor(node.outline ?? []), 1.6, 2.2)
      : node.spindleRatio ? clamp(projectedEccentricity * somaElongationFactor(node.outline ?? []), 1.04, 1.9)
        : somaDrawnElongation(projectedEccentricity, node.outline ?? []);
    // D082-A-PERF BEGIN: the declared motion tier uses a simple soma. Avoid
    // per-trunk projections and angular integration on every wheel/orbit event;
    // at rest the spatially spread principal trunks (A-NEURALf) shape the lobes.
    const strongest = moving ? [] : neuralPrincipalTrunks(node.trunks ?? []);
    const maximum = Math.max(1, ...strongest.map(trunk => trunk.weight));
    const lobes = strongest.flatMap(trunk => {
      const tip = project({ x: node.position.x + trunk.direction.x,
        y: node.position.y + trunk.direction.y, z: node.position.z + trunk.direction.z });
      return Math.hypot(tip.x - p.x, tip.y - p.y) < 1e-6 ? []
        : [{ angle: Math.atan2(tip.y - p.y, tip.x - p.x),
          strength: neuralTrunkLobeStrength(trunk, maximum, node.degree) }];
    });
    const frame: NeuralSomaFrame = {
      x: p.x, y: p.y, angle, radius,
      eccentricity,
      harmonics: node.outline ?? [],
      spindle: !!node.spindleRatio,
      leaf: node.degree === 1,
      lobes,
    };
    // D082-A-PERF BEGIN
    frames.set(node.id, { ...frame, lobeAreaScale: moving ? 1 : cachedLobeArea(node, frame, projection) });
    // D082-A-PERF END
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
    -NEURAL_SOMA_OUTLINE_MAX_RADIAL, NEURAL_SOMA_OUTLINE_MAX_RADIAL);
  const lobes = somaLobeFactor(frame.lobes ?? [], polarAngle, frame.lobeAreaScale);
  return bulge * (frame.spindle ? somaSpindleFactor(parameter) : 1) * lobes
    * neuralEndpointBodyScale(frame.leaf ? 1 : 0)
    * Math.hypot(major * Math.cos(parameter), minor * Math.sin(parameter));
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

/** The paint-only root begins under the soma fill; public edge endpoints keep their old contract. */
export function neuralRootInsideSoma(frame: NeuralSomaFrame,
  endPoint: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
  const boundary = neuralEdgeEndOnSoma(frame, endPoint);
  const dx = boundary.x - frame.x, dy = boundary.y - frame.y;
  const inset = Math.min(0.58, Math.max(0.42, 2 / Math.max(Math.hypot(dx, dy), 1)));
  return { x: frame.x + dx * (1 - inset), y: frame.y + dy * (1 - inset) };
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
 * `coreOpacityFloor` carries the morphology's core alpha floor (Stellar 0.9,
 * Mycelium 0.48, Neural none). */
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
  appearance: AppearanceOptions, projection: "2d" | "3d" = "2d"): CanvasDisc[] {
  const discs: CanvasDisc[] = [];
  for (const node of geometry.nodes) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    // D082-A-NODES BEGIN
    // D086-CUSTOM BEGIN
    // D087-SIZE BEGIN
    if (projection === "3d" ? given === 0 : denseDrawingPolicy(style) && given === 0) continue;
    // D087-SIZE END
    // D082-A-NODES END
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      projection === "3d" ? (visual?.leafMark ? 0.5
        : geometry.morphology === "mycelium" ? 1.3 : 2)
        : denseDrawingPolicy(style) ? 0.5
          : geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    // D086-CUSTOM END
    const drawn = geometry.morphology === "stellar" && radius > 1
      ? stellarStarCoreRadiusPx(radius, node.degree) : radius;
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
  readonly neural?: boolean;
  // D082-A-NCOMPLETA BEGIN
  readonly neuralDenseFactor?: number | undefined;
  // D082-A-NCOMPLETA END
  readonly points: readonly ProjectedPoint[];
  readonly cumulative: readonly number[];
  readonly totalPx: number;
  readonly color: string;
  /** Constant base alpha of the line: presentation-derived only, never time-dependent (V13). */
  readonly alpha: number;
  readonly widthAt: (i: number) => number;
  // D084-W2-NEURAL: detailStartPx/detailEndPx (cosmetic offshoot markers) are removed.
  /** Visible outline distance and final radius; the root profile is evaluated in screen space. */
  // D084-W2-NEURAL-R6 BEGIN: each endpoint carries the alpha of its own drawn outline.
  readonly rootStart?: { readonly outlinePx: number; readonly radiusPx: number; readonly lengthPx: number; readonly ratio: number; readonly degree: number; readonly trunkWidthPx: number; readonly somaColor: string; readonly somaAlpha: number } | undefined;
  readonly rootEnd?: { readonly outlinePx: number; readonly radiusPx: number; readonly lengthPx: number; readonly ratio: number; readonly degree: number; readonly trunkWidthPx: number; readonly somaColor: string; readonly somaAlpha: number } | undefined;
  // D084-W2-NEURAL-R6 END
};

// D082-A-NCOMPLETA BEGIN: the calibrated screen-cell veil narrows Neural ribbons as well
// as reducing alpha. The identity value leaves all A-INT12 close-up geometry unchanged.
export function neuralDenseRibbonWidthFactor(veilFactor: number): number {
  return Math.max(0.22, Math.min(1, Math.sqrt(Math.max(0, veilFactor))));
}
// D082-A-N3D BEGIN: only the 3D Completa overlay calls this after dense scaling.
export function neuralCompleta3dRibbonWidthPx(widthCssPx: number, deviceRatio: number): number {
  return Math.max(widthCssPx, 1.5 / Math.max(1, deviceRatio));
}
// D082-A-N3D END
export function neuralDenseHaloFactor(localDensity: number, zoomProgress: number): number {
  const zoom = Math.max(0, Math.min(1, zoomProgress));
  return (1 - zoom) / Math.sqrt(Math.max(1, localDensity)) + zoom;
}
// D082-A-NCOMPLETA3 BEGIN: the 2D canvas halo is drawn beside the native tier;
// keep the accepted 3D halo and the close inspection identity unchanged.
export function neuralCompletaHaloFactor(localDensity: number, projection: "2d" | "3d",
  zoomProgress: number): number {
  const base = neuralDenseHaloFactor(localDensity, zoomProgress);
  if (projection === "3d") return base;
  const zoom = Math.max(0, Math.min(1, zoomProgress));
  return base * (0.08 * (1 - zoom) + zoom);
}
// D082-A-NCOMPLETA3 END
// D082-A-NCOMPLETA2 BEGIN: retain a soft mid-grey neurite field at fit while
// preserving the original per-edge density ordering and the exact z6 identity.
export function neuralCompletaVeilFactor(measuredFactor: number, projection: "2d" | "3d",
  zoomProgress: number): number {
  const zoom = Math.max(0, Math.min(1, zoomProgress));
  const measured = Math.max(0, Math.min(1, measuredFactor));
  // D082-A-VEIL BEGIN: the fitted field now survives camera-only rebuilds. Raise the
  // Neural mid-tone response from the dark NCOMPLETA3 fit while retaining local order.
  // Both projections still reach the D-081 identity exactly at zoom band six.
  if (projection === "2d") return (0.058 + 0.09 * measured) * (1 - zoom) + measured * zoom;
  return Math.max(measured, 0.4 * (1 - zoom));
  // D082-A-VEIL END
}
export function neuralCompletaPointRadius(radiusPx: number, fitProjectionScale: number,
  zoomProgress: number): number {
  const zoom = Math.max(0, Math.min(1, zoomProgress));
  if (radiusPx <= 0) return 0;
  const scale = Math.max(0.001, fitProjectionScale);
  return Math.max(0.85 / scale, Math.min(radiusPx, 0.9 / scale)) * (1 - zoom)
    + radiusPx * zoom;
}
// D082-A-NCOMPLETA2 END
// D082-A-NCOMPLETA END

// D081-P1G BEGIN: keep projected edge work inside the canvas. Distances remain measured along
// the original edge so a clipped travelling pulse does not restart at the viewport boundary.
export function clipEdgePaint(paint: MorphologyEdgePaint, width: number, height: number): MorphologyEdgePaint[] {
  const lastIndex = paint.points.length - 1;
  // A wide soma root can still touch the canvas while its centreline is outside it.
  // D086-F5 BEGIN: a sample with no finite projection has no width either; the margin is measured
  // from the finite ones, because one NaN would turn every clip bound into NaN and the segment
  // loop below would read a point that does not exist.
  const margin = Math.max(32, ...[0, lastIndex * 0.5, lastIndex].map(index => paint.widthAt(index) * 0.5 + 4)
    .filter(Number.isFinite));
  // D086-F5 END
  const box = [-margin, width + margin, -margin, height + margin] as const;
  const runs: { point: ProjectedPoint; index: number; distance: number }[][] = [];
  let run: { point: ProjectedPoint; index: number; distance: number }[] = [];
  const append = (index: number) => {
    const low = Math.floor(index), fraction = index - low;
    // D086-F5 BEGIN: a sample at a whole index is that sample; a neighbour that never projected
    // must not leak NaN into it through a zero-weight interpolation.
    const next = fraction === 0 ? low : Math.min(low + 1, paint.points.length - 1);
    const a = paint.points[low]!, b = paint.points[next]!;
    const distance = paint.cumulative[low]! + (paint.cumulative[next]! - paint.cumulative[low]!) * fraction;
    // D086-F5 END
    const item = { point: { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction,
      scale: a.scale + (b.scale - a.scale) * fraction }, index, distance };
    if (run.at(-1)?.index !== index) run.push(item);
  };
  for (let i = 0; i < paint.points.length - 1; i++) {
    const a = paint.points[i]!, b = paint.points[i + 1]!;
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    let enter = 0, leave = 1;
    for (const [p, q] of [[-dx, a.x - box[0]], [dx, box[1] - a.x], [-dy, a.y - box[2]], [dy, box[3] - a.y]] as const) {
      if (p === 0) { if (q < 0) { enter = 1; leave = 0; break; } }
      else { const t = q / p; if (p < 0) enter = Math.max(enter, t); else leave = Math.min(leave, t); }
    }
    if (enter > leave) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    if (run.length && Math.abs(run.at(-1)!.index - (i + enter)) > 1e-8) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    append(i + enter); append(i + leave);
    if (leave < 1) { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs.map(items => {
    // The centreline source has a fixed sample budget; keep the same upper bound after clipping.
    const bounded = items.length <= 256 ? items : Array.from({ length: 256 }, (_, j) =>
      items[Math.round(j * (items.length - 1) / 255)]!);
    return { ...paint, points: bounded.map(item => item.point), cumulative: bounded.map(item => item.distance),
      widthAt: (i: number) => {
        const low = Math.min(bounded.length - 1, Math.max(0, Math.floor(i)));
        const next = Math.min(low + 1, bounded.length - 1);
        return paint.widthAt(bounded[low]!.index + (bounded[next]!.index - bounded[low]!.index) * (i - low));
      } };
  });
}
// D081-P1G END

/** A projected C1 centre-line through the existing geometry samples. Work is bounded per
 * original interval, even on long links, and only happens when the base layer repaints. */
export function smoothNeuralCurve(anchors: readonly ProjectedPoint[]): ProjectedPoint[] {
  if (anchors.length < 3) return [...anchors];
  const result: ProjectedPoint[] = [anchors[0]!];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!, b = anchors[i + 1]!;
    const before = anchors[Math.max(0, i - 1)]!, after = anchors[Math.min(anchors.length - 1, i + 2)]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.min(12, Math.max(2, Math.ceil(Math.hypot(dx, dy) / 18)));
    const m0x = i === 0 ? dx : (b.x - before.x) * 0.5;
    const m0y = i === 0 ? dy : (b.y - before.y) * 0.5;
    const m1x = i + 1 === anchors.length - 1 ? dx : (after.x - a.x) * 0.5;
    const m1y = i + 1 === anchors.length - 1 ? dy : (after.y - a.y) * 0.5;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      result.push({ x: h00 * a.x + h10 * m0x + h01 * b.x + h11 * m1x,
        y: h00 * a.y + h10 * m0y + h01 * b.y + h11 * m1y,
        scale: a.scale + (b.scale - a.scale) * t });
    }
  }
  return result;
}

/** The exploratory relations of a geometry that may animate, prioritised and budget-capped exactly
 * as the inline pass has always done: visible only, selected and focus-adjacent first. Deterministic
 * in the inputs, so the main pass and the separate flow layer always agree. */
export function selectAnimatedFlowEdges(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, bounds: { readonly width: number; readonly height: number },
  visiblePaints?: ReadonlySet<string>,
  // D082-A-PERF BEGIN: flow preparation walks priority prefixes until the
  // first 60 actually clipped paints have been found.
  budget = FLOW_ANIMATED_EDGE_BUDGET): ReadonlySet<string> {
  // D082-A-PERF END
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
    return Math.max(a.x, b.x) >= -margin && Math.min(a.x, b.x) <= bounds.width + margin
      && Math.max(a.y, b.y) >= -margin && Math.min(a.y, b.y) <= bounds.height + margin;
  };
  const candidates = new Map<string, { visible: boolean; priority: number }>();
  for (const part of geometry.drawnSegments) {
    if (style.edges.get(part.edgeId)?.presentation?.category !== "exploratory") continue;
    const selected = hoverId === part.edgeId || (focusIds?.has(part.edgeId) ?? false);
    const priority = selected ? 0 : nearFocus(part) ? 1 : 2;
    const visible = visiblePaints ? visiblePaints.has(part.edgeId) : withinViewport(part);
    const current = candidates.get(part.edgeId);
    if (!current) candidates.set(part.edgeId, { visible, priority });
    else { current.priority = Math.min(current.priority, priority); current.visible ||= visible; }
  }
  const animatedEdges = selectFlowEdges([...candidates].map(([edgeId, value]) =>
    ({ edgeId, visible: value.visible, priority: value.priority })), budget);
  setFlowAnimatedEdgeCount(animatedEdges.size);
  return animatedEdges;
}

/** Build the shared per-segment paints of one frame. Pure drawing input computation: no canvas
 * state is touched. */
// D082-A-PERF BEGIN: only projection and style are recomputed when the camera changes.
type EdgePaintStatic = {
  readonly endpointSomata: ReturnType<typeof neuralEndpointSomata> | null;
  readonly neuralDegree: ReadonlyMap<string, number> | null;
  readonly stellarArcs: ReturnType<typeof stellarArcClasses>;
  readonly samples: ReadonlyMap<MorphologySegment, readonly Coordinates[]>;
};
const edgePaintStatics = new WeakMap<MorphologyGeometry, EdgePaintStatic>();
function cachedEdgePaintStatic(geometry: MorphologyGeometry): EdgePaintStatic {
  const hit = edgePaintStatics.get(geometry);
  if (hit) return hit;
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  const samples = new Map<MorphologySegment, readonly Coordinates[]>();
  for (const part of geometry.drawnSegments) samples.set(part,
    simplified && part.samples.length > 8
      ? part.samples.filter((_, i) => i % 4 === 0 || i === part.samples.length - 1)
      : part.samples);
  const result: EdgePaintStatic = {
    endpointSomata: geometry.morphology === "neural" ? neuralEndpointSomata(geometry) : null,
    neuralDegree: geometry.morphology === "neural" ? new Map(geometry.nodes.map(node => [node.id, node.degree])) : null,
    stellarArcs: geometry.morphology === "stellar" ? stellarArcClasses(geometry) : null,
    samples,
  };
  edgePaintStatics.set(geometry, result);
  return result;
}
// D082-A-PERF END
function buildEdgePaints(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, appearance: AppearanceOptions,
  contract: (typeof MORPHOLOGY_CONTRACT)[keyof typeof MORPHOLOGY_CONTRACT], projection: "2d" | "3d",
  somaFrames: ReadonlyMap<string, NeuralSomaFrame> | null,
  bounds: { readonly width: number; readonly height: number },
  // D082-A-PERF BEGIN: retain identical paint construction for the selected
  // flow edges without projecting every unanimated segment.
  edgeIds?: ReadonlySet<string>, indra3d = false): MorphologyEdgePaint[] {
  // D082-A-PERF END
  // D082-A-PERF BEGIN: topology, endpoint lookup and sample reduction are layout data.
  // They survive camera changes and remounts when the prepared geometry is reused.
  const staticPaint = cachedEdgePaintStatic(geometry);
  const endpointSomata = somaFrames ? staticPaint.endpointSomata : null;
  const stellarArcs = geometry.morphology === "stellar" ? staticPaint.stellarArcs : null;
  // D082-A-PERF END
  const paints: MorphologyEdgePaint[] = [];
  for (const part of geometry.drawnSegments) {
    // D082-A-PERF BEGIN
    if (edgeIds && !edgeIds.has(part.edgeId)) continue;
    // D082-A-PERF END
    const edge = style.edges.get(part.edgeId);
    const presentation = edge?.presentation;
    const category = presentation?.category ?? "attested";
    if (!EDGE_CATEGORY_SET.has(category)) continue; // no semantics -> not drawn
    // D082-A-NODES BEGIN
    // Derive the accepted class-window alpha from its original input, then apply the dense veil
    // outside that window. Applying the reduced opacity inside stellarArcAlpha hits its .2/.35
    // floor and erases the veil before any stroke reaches the canvas.
    const opacity = (presentation?.denseVeilBaseOpacityPermille ?? presentation?.opacityPermille
      ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const veilFactor = denseEdgeVeilFactor(presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE,
      presentation?.denseVeilBaseOpacityPermille);
    // D082-A-NODES END
    const arcClass = stellarArcs?.get(part.edgeId);
    const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const emphasis = style.interaction?.hoverId === part.edgeId ? contract.hover
      : style.interaction?.focusIds?.has(part.edgeId) ? contract.focus : null;
    const color = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
    const source = staticPaint.samples.get(part) ?? part.samples;
    let points = source.map(project);
    if (points.length < 2) continue;
    // D-072 V5: each dendrite end moves onto the outline of the soma it leaves — the soma the node
    // pass is about to draw under it — overlapping the boundary, so soma and dendrites read as one
    // shape with no suspended-egg gap. Screen space, so 2D and 3D share the exact grammar.
    let startRadius = 0, endRadius = 0;
    let startSomaColor = "rgb(255, 255, 255)", endSomaColor = "rgb(255, 255, 255)";
    // D084-W2-NEURAL-R6 BEGIN: sample each node's actual outline presentation;
    // the edge's dense veil does not define the opacity of a different owner.
    let startSomaAlpha = 0, endSomaAlpha = 0;
    let startRatio = 2.4, endRatio = 2.4;
    let startDegree = 0, endDegree = 0;
    let startTipDistancePx = 0, endTipDistancePx = 0;
    if (somaFrames && endpointSomata) {
      const [segmentStart, segmentEnd] = segmentEnds(part);
      const startSoma = segmentStart ? endpointSomata.get(neuralEndpointKey(segmentStart)) : undefined;
      const endSoma = segmentEnd ? endpointSomata.get(neuralEndpointKey(segmentEnd)) : undefined;
      const startFrame = startSoma ? somaFrames.get(startSoma.id) : undefined;
      const endFrame = endSoma ? somaFrames.get(endSoma.id) : undefined;
      startRadius = startFrame?.radius ?? 0;
      endRadius = endFrame?.radius ?? 0;
      // D082-A-NEURALe: the root mouth takes the projected soma colour. A white
      // root over a depth-dimmed 3D soma made a bright polygon even with max coverage.
      if (startFrame && startSoma) startSomaColor = dim(style.nodes.get(startSoma.id)?.color ?? "rgb(245, 245, 245)",
        depthBrightness(points[0]!.scale, projection));
      if (endFrame && endSoma) endSomaColor = dim(style.nodes.get(endSoma.id)?.color ?? "rgb(245, 245, 245)",
        depthBrightness(points[points.length - 1]!.scale, projection));
      if (startFrame && startSoma) {
        const nodeEmphasis = style.interaction?.hoverId === startSoma.id ? contract.hover
          : style.interaction?.focusIds?.has(startSoma.id) ? contract.focus : null;
        startSomaAlpha = neuralSomaOutlineAlpha(style.nodes.get(startSoma.id)?.opacity ?? 1,
          nodeEmphasis?.brightnessMultiplier ?? 1, points[0]!.scale,
          projection, indra3d, focusNodeOpacity(style.interaction?.dimFocus?.members ?? null, startSoma.id));
      }
      if (endFrame && endSoma) {
        const nodeEmphasis = style.interaction?.hoverId === endSoma.id ? contract.hover
          : style.interaction?.focusIds?.has(endSoma.id) ? contract.focus : null;
        endSomaAlpha = neuralSomaOutlineAlpha(style.nodes.get(endSoma.id)?.opacity ?? 1,
          nodeEmphasis?.brightnessMultiplier ?? 1, points[points.length - 1]!.scale,
          projection, indra3d, focusNodeOpacity(style.interaction?.dimFocus?.members ?? null, endSoma.id));
      }
      startRatio = neuralRootRatio(startSoma?.degree ?? 1);
      endRatio = neuralRootRatio(endSoma?.degree ?? 1);
      startDegree = startSoma?.degree ?? 0;
      endDegree = endSoma?.degree ?? 0;
      if ((part.trunkSourceCount ?? 1) > 1) startRatio = -(part.trunkSourceWidthFactor ?? startRatio);
      if ((part.trunkTargetCount ?? 1) > 1) endRatio = -(part.trunkTargetWidthFactor ?? endRatio);
      if (startFrame || endFrame) {
        let first = points[0]!, last = points[points.length - 1]!;
        if (startFrame) {
          const adjusted = neuralRootInsideSoma(startFrame, points[1]!);
          first = { x: adjusted.x, y: adjusted.y, scale: first.scale };
          // D084-W2-NEURAL-R3: measure the anchor from the soma centre, matching
          // the 0.7R boundary in both GPU paths even when the outline has a lobe.
          const rootRadius = startFrame.radius * neuralEndpointBodyScale(startSoma?.degree ?? 0);
          startTipDistancePx = NEURAL_ROOT_ANCHOR_RADII * rootRadius
            - Math.hypot(first.x - startFrame.x, first.y - startFrame.y);
        }
        if (endFrame) {
          const adjusted = neuralRootInsideSoma(endFrame, points[points.length - 2]!);
          last = { x: adjusted.x, y: adjusted.y, scale: last.scale };
          const rootRadius = endFrame.radius * neuralEndpointBodyScale(endSoma?.degree ?? 0);
          endTipDistancePx = NEURAL_ROOT_ANCHOR_RADII * rootRadius
            - Math.hypot(last.x - endFrame.x, last.y - endFrame.y);
        }
        points = [first, ...points.slice(1, -1), last];
      }
    }
    // D084-W2-NEURAL-R6 END
    if (geometry.morphology === "neural" && style.interaction?.quality !== "moving") points = smoothNeuralCurve(points);
    const cumulative: number[] = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
    const totalPx = cumulative[cumulative.length - 1]! || 1;
    // D084-W2-NEURAL BEGIN: the root continues the body it leaves. A degree-one body is
    // drawn at NEURAL_LEAF_BODY_SCALE, so its single tail anchors at that same local
    // extension — the process base is exactly as wide as the cell, never wider.
    const startRootRadius = startRadius * neuralEndpointBodyScale(startDegree);
    const endRootRadius = endRadius * neuralEndpointBodyScale(endDegree);
    // D084-W2-NEURAL-R3 BEGIN: start the root inside the shoulder at the chord where
    // the round body is already about 0.7R wide. A full-width root at the pole makes
    // an egg; the chord anchor lets the union keep a smooth, broad process.
    // D084-W2-NEURAL-R3 END
    // D084-W2-NEURAL END
    // The Neural profile retains its full width at both soma ends, including high-degree hubs.
    const neuralTaper = geometry.morphology === "neural";
    const neuralBody = Math.max(0.3, appearance.edgeWidth * widthFactor
      * (emphasis?.radiusMultiplier ?? 1));
    // D084-W2-NEURAL-R3 BEGIN: every drawn radius keeps the same proportional root.
    const startRootLengthPx = neuralVisibleRootLengthPx(startRootRadius, totalPx, startDegree, startRatio < 0, part.widthStart)
      * neuralRootCompactnessScale(startRootRadius, neuralBody);
    const endRootLengthPx = neuralVisibleRootLengthPx(endRootRadius, totalPx, endDegree, endRatio < 0, part.widthEnd)
      * neuralRootCompactnessScale(endRootRadius, neuralBody);
    // D084-W2-NEURAL-R3 END
    // D082-A-NEURAL BEGIN: D-081 owns the grey trunk after the short soma fillet.
    const trunkWidthAt = (t: number) => {
      const index = t * (points.length - 1);
      const shapedStartRadius = startRadius >= NEURAL_MIN_SHAPED_RADIUS_PX ? startRadius : 0;
      const shapedEndRadius = endRadius >= NEURAL_MIN_SHAPED_RADIUS_PX ? endRadius : 0;
      let ordinary = neuralScreenWidthAt(t, neuralBody, shapedStartRadius, shapedEndRadius,
        [Math.abs(startRatio), Math.abs(endRatio)], totalPx, [startRatio >= 0, endRatio >= 0]);
      if (startDegree <= 3 && shapedStartRadius > 0 || endDegree <= 3 && shapedEndRadius > 0)
        ordinary = Math.max(neuralBody,
          startDegree <= 3 ? neuralLeafRootWidthPx(t * totalPx - startTipDistancePx, neuralBody, shapedStartRadius) : neuralBody,
          endDegree <= 3 ? neuralLeafRootWidthPx((1 - t) * totalPx - endTipDistancePx, neuralBody, shapedEndRadius) : neuralBody);
      // D084-W2-NEURAL-R2: 0.4 radii, matching neuralLeafRootWidthPx's soma-relative cap.
      const cap = t < 0.5
        ? startDegree <= 3 && shapedStartRadius > 0
          ? Math.max(shapedStartRadius * 0.4, neuralBody * 2) : Infinity
        : endDegree <= 3 && shapedEndRadius > 0
          ? Math.max(shapedEndRadius * 0.4, neuralBody * 2) : Infinity;
      return Math.min(Math.max(neuralBody, cap), Math.max(ordinary,
        neuralBranchedWidthPx(index, points.length, part.sourceBranches?.length ?? 0,
          neuralBody, shapedStartRadius, Math.abs(startRatio)),
        neuralBranchedWidthPx(points.length - 1 - index, points.length,
          part.targetBranches?.length ?? 0, neuralBody, shapedEndRadius, Math.abs(endRatio))));
    };
    const startTrunkWidth = neuralTaper && startRadius > 0
      ? trunkWidthAt(Math.min(1, (startTipDistancePx + startRootLengthPx + startRootRadius * NEURAL_ROOT_FILLET_LENGTH_RADII) / totalPx)) : 0;
    const endTrunkWidth = neuralTaper && endRadius > 0
      ? trunkWidthAt(Math.max(0, 1 - (endTipDistancePx + endRootLengthPx + endRootRadius * NEURAL_ROOT_FILLET_LENGTH_RADII) / totalPx)) : 0;
    // D082-A-NEURAL END
    const projectedWidthAt = (i: number) => {
      const index = Math.min(points.length - 1, Math.max(0, Math.floor(i)));
      const fraction = Math.min(1, Math.max(0, i - index));
      const t = neuralTaper
        ? (cumulative[index]! + (index + 1 < cumulative.length
          ? (cumulative[index + 1]! - cumulative[index]!) * fraction : 0)) / totalPx
        : i / (points.length - 1);
      const smooth = t * t * (3 - 2 * t);
      const variation = geometry.morphology === "mycelium" ? 1 + contract.edge.widthVariation * Math.sin(Math.PI * t) ** 2 * Math.cos(t * Math.PI * 4) : 1;
      // Fractional sample positions (the flow pulse asks for midpoints) read the nearest projected scale.
      const scaleAt = points[Math.min(points.length - 1, Math.max(0, Math.round(i)))]!.scale;
      const factors = scaleAt * widthFactor * (emphasis?.radiusMultiplier ?? 1) * variation;
      if (stellarArcs) {
        // D-072 M1b: the reference's arc grammar — intra arcs thin and discreet, bridges slightly
        // stronger; the data's own width modulates inside the class window (2D and 3D the same).
        const profile = part.widthStart + (part.widthEnd - part.widthStart) * smooth;
        return clamp(stellarArcWidthPx(arcClass, profile * factors) * appearance.edgeWidth, 0.2, 4.5);
      }
      if (neuralTaper) {
        // The slider sets the ordinary pixel width. Perspective changes the soma frame and
        // centre-line only; it cannot turn the shaft into a zoom-scaled band.
        const body = neuralBody;
        // The fillet begins under the rounded soma and ends at the unmodified D-081 trunk.
        const startDistance = t * totalPx - startTipDistancePx;
        const endDistance = (1 - t) * totalPx - endTipDistancePx;
        if (startRadius > 0 && startDistance < startRootLengthPx + startRootRadius * NEURAL_ROOT_FILLET_LENGTH_RADII)
          return neuralRootProfileAtLength(startDistance, startRootRadius, body, 1, startRatio,
            startRootLengthPx, startTrunkWidth).width;
        if (endRadius > 0 && endDistance < endRootLengthPx + endRootRadius * NEURAL_ROOT_FILLET_LENGTH_RADII)
          return neuralRootProfileAtLength(endDistance, endRootRadius, body, 1, endRatio,
            endRootLengthPx, endTrunkWidth).width;
        return trunkWidthAt(t);
      }
      const profile = part.widthStart + (part.widthEnd - part.widthStart) * smooth;
      return clamp(profile * factors * appearance.edgeWidth, 0.5, 16);
    };
    // D-079: only the Indra 3D structural presentation sets this floor. It is applied after
    // Stellar's class window and perspective scaling, and also reaches the moving Neural stroke.
    // D082-A-PERF BEGIN: a ribbon, its light profile and its clipping pass ask
    // for the same vertex widths many times. Projection invalidates this memo
    // with the paint; within one camera pose each width is evaluated once.
    const projectedWidths = new Map<number, number>();
    const widthAt = (i: number) => {
      const cached = projectedWidths.get(i);
      if (cached !== undefined) return cached;
      // D087-SIZE BEGIN: screen density changes alpha only.
      const width = screenSpaceEdgeWidthPx(projectedWidthAt(i),
        projection === "3d" ? presentation?.minimumScreenWidthPx : 0)
        * (projection === "2d" && neuralTaper && presentation?.neuralDenseFactor !== undefined
          ? neuralDenseRibbonWidthFactor(presentation.neuralDenseFactor) : 1);
      // D087-SIZE END
      // D082-A-N3D BEGIN: keep the projected canvas outline continuous at device resolution.
      // D087-SIZE BEGIN
      const continuousWidth = width;
      // D087-SIZE END
      // D082-A-N3D END
      projectedWidths.set(i, continuousWidth);
      return continuousWidth;
    };
    // D082-A-PERF END
    // D-072 V13: the base alpha of a line is constant across frames — presentation-derived factors
    // only. D-072 M1b: a Stellar arc's base alpha is its class window (intra faint, bridges near
    // 0.5), the presentation's opacity mapping inside it; emphasis may push above the window.
    const focus = style.interaction?.dimFocus;
    const baseAlpha = clamp(
      (stellarArcs
        ? stellarArcAlpha(arcClass, opacity * appearance.edgeOpacity) * (emphasis?.brightnessMultiplier ?? 1)
        : Math.max(0.14, opacity * appearance.edgeOpacity * (emphasis?.brightnessMultiplier ?? 1))),
      0, 1);
    // D082-A-NODES BEGIN
    // Hover/focus remains readable above the resting veil. All other arcs (including their
    // exploratory halos) inherit this same attenuated paint alpha.
    const focusedAlpha = focusArcOpacity(focus ?? null, part.edgeId, baseAlpha);
    const alpha = emphasis || focus?.arcs.has(part.edgeId) ? focusedAlpha : focusedAlpha * veilFactor;
    // D082-A-NODES END
    const paint: MorphologyEdgePaint = { part, edgeId: part.edgeId, category, neural: neuralTaper, points, cumulative, totalPx, color, alpha, widthAt,
      // D082-A-NCOMPLETA BEGIN
      neuralDenseFactor: neuralTaper ? presentation?.neuralDenseFactor : undefined,
      // D082-A-NCOMPLETA END
      rootStart: startRadius >= NEURAL_MIN_SHAPED_RADIUS_PX ? { outlinePx: startTipDistancePx, radiusPx: startRootRadius,
        lengthPx: startRootLengthPx, ratio: startRatio, degree: startDegree,
        trunkWidthPx: startTrunkWidth, somaColor: startSomaColor, somaAlpha: startSomaAlpha } : undefined,
      rootEnd: endRadius >= NEURAL_MIN_SHAPED_RADIUS_PX ? { outlinePx: totalPx - endTipDistancePx, radiusPx: endRootRadius,
        lengthPx: endRootLengthPx, ratio: endRatio, degree: endDegree,
        trunkWidthPx: endTrunkWidth, somaColor: endSomaColor, somaAlpha: endSomaAlpha } : undefined,
      // D084-W2-NEURAL: the cosmetic close-up sprouts (detailStart/detailEnd) are gone —
      // no decorative filament may fake a relation the graph does not draw.
    };
    paints.push(...clipEdgePaint(paint, bounds.width, bounds.height));
  }
  return paints;
}

// D087-SIZE BEGIN: the witness samples the same prepared stroke sampler as the canvas.
export function morphologyEdgeStrokeWidths(geometry: MorphologyGeometry, style: MorphologyCanvasStyle,
  project: (point: Coordinates) => ProjectedPoint, appearance: AppearanceOptions,
  projection: "2d" | "3d", bounds: { readonly width: number; readonly height: number }): ReadonlyMap<string, number> {
  const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
  const somata = geometry.morphology === "neural"
    ? neuralSomaFrames(geometry, project, style, contract, appearance, projection, false) : null;
  const paints = buildEdgePaints(geometry, style, project, appearance, contract, projection,
    somata, bounds, undefined, projection === "3d" && (geometry.containers?.length ?? 0) > 0);
  return new Map(paints.map(paint => [paint.edgeId,
    paint.widthAt((paint.points.length - 1) / 2)] as const));
}
// D087-SIZE END

/** Legacy smooth radial reference retained for non-Neural flow and shader contract tests. */
export function neuralEdgeDensity(radialFraction: number): number {
  const x = clamp(Math.abs(radialFraction), 0, 1);
  const shoulder = 1 - x * x * (3 - 2 * x);
  return shoulder * shoulder;
}

/** Two concentric premultiplied-alpha bands approximate a centre-peaked density: the outer
 * coverage is 0.6a; inside 62% width it is 1-(1-0.6a)(1-0.4a). Both bands share the exact
 * tapered outline, so no segment boundary can create a dash. Below 2 px the subpixel inner band
 * is omitted. The travelling light reuses both proportions on its separate canvas layer. */
export function neuralRibbonProfile(widthPx: number): readonly { width: number; alpha: number }[] {
  return widthPx < 2 ? [{ width: 1, alpha: 1 }]
    : [{ width: 1, alpha: 0.6 }, { width: 0.62, alpha: 0.4 }];
}

/** Fill one whole tapered outline. Each point contributes its own width, including soma roots. */
function fillRibbon(context: CanvasRenderingContext2D, points: readonly ProjectedPoint[],
  widthAt: (i: number) => number): void {
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
}

function neuralProfileWidth(paint: MorphologyEdgePaint): number {
  let width = Infinity;
  for (let i = 0; i < paint.points.length; i++) width = Math.min(width, paint.widthAt(i));
  return width;
}

// D081-P1G BEGIN: a fixed number of colour stops describes the compact light envelope. The
// number of projected vertices and the full edge length never enter this budget.
type EdgeModulation = ((distancePx: number) => number) & { centre?: number; radius?: number };
function pulseVisible(paint: MorphologyEdgePaint, modulation: EdgeModulation): boolean {
  if (modulation.centre === undefined || modulation.radius === undefined) return true;
  return modulation.centre + modulation.radius >= paint.cumulative[0]!
    && modulation.centre - modulation.radius <= paint.cumulative[paint.cumulative.length - 1]!;
}
function flowModulation(paint: MorphologyEdgePaint, now: number, speed: number, intensity: number): EdgeModulation {
  const radius = flowPulseLengthPx(paint.totalPx) * 0.5;
  const centre = flowHeadPositionPx(now, speed, paint.totalPx + radius * 2);
  return Object.assign((distance: number) => flowWaveAlpha(distance, paint.totalPx, now, speed, intensity), { centre, radius });
}
function edgeLightGradient(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  modulation: EdgeModulation, alpha: number, outerRoot = false): CanvasGradient {
  // D084-W7-DENSE BEGIN: the root inherits the attached soma's drawn alpha times
  // this edge's own Completa veil — the shaft stops of this same gradient already
  // carry the factor through paint.alpha. One outside Completa and after the zoom
  // release keeps the R6 soma-to-root continuity exactly.
  const denseRootFactor = paint.neuralDenseFactor ?? 1;
  // D084-W7-DENSE END
  const start = paint.points[0]!, end = paint.points[paint.points.length - 1]!;
  const first = paint.cumulative[0]!, last = paint.cumulative[paint.cumulative.length - 1]!;
  const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
  const distances = [first, last];
  // D084-W2-NEURAL-R5 BEGIN: the soma's own tone and the engine table's fade
  // continue through the process. The nucleus stays inside the drawn soma.
  for (const root of [paint.rootStart, paint.rootEnd]) if (root)
    for (let j = 0; j <= 8; j++) {
      const displacement = (root.lengthPx + root.radiusPx * NEURAL_ROOT_FILLET_LENGTH_RADII) * j / 8;
      distances.push(clamp(root === paint.rootStart ? root.outlinePx + displacement : root.outlinePx - displacement, first, last));
    }
  if (modulation.centre !== undefined && modulation.radius !== undefined) {
    for (let j = -8; j <= 8; j++) distances.push(clamp(modulation.centre + j * modulation.radius / 8, first, last));
  } else if (Math.abs(modulation(first) - modulation(last)) > 1e-6 ||
    Math.abs(modulation(first) - modulation((first + last) * 0.5)) > 1e-6) {
    for (let j = 1; j < 32; j++) distances.push(first + (last - first) * j / 32);
  }
  distances.sort((a, b) => a - b);
  let previous = -Infinity;
  for (const distance of distances) {
    if (distance <= previous + 1e-7) continue;
    previous = distance;
    let ramp = { alpha, somaMix: 0 };
    let somaChannels: readonly [number, number, number] = colourChannels(paint.color);
    if (paint.rootStart && distance < paint.rootStart.outlinePx + paint.rootStart.lengthPx + paint.rootStart.radiusPx * NEURAL_ROOT_FILLET_LENGTH_RADII) {
      somaChannels = colourChannels(paint.rootStart.somaColor);
      ramp = neuralRootProfileAtLength(distance - paint.rootStart.outlinePx, paint.rootStart.radiusPx, 1, alpha,
        paint.rootStart.ratio, paint.rootStart.lengthPx, 1,
        outerRoot ? clamp(paint.rootStart.somaAlpha * denseRootFactor, 0, 1) : 0);
    } else if (paint.rootEnd && distance > paint.rootEnd.outlinePx - paint.rootEnd.lengthPx - paint.rootEnd.radiusPx * NEURAL_ROOT_FILLET_LENGTH_RADII) {
      somaChannels = colourChannels(paint.rootEnd.somaColor);
      ramp = neuralRootProfileAtLength(paint.rootEnd.outlinePx - distance, paint.rootEnd.radiusPx, 1, alpha,
        paint.rootEnd.ratio, paint.rootEnd.lengthPx, 1,
        outerRoot ? clamp(paint.rootEnd.somaAlpha * denseRootFactor, 0, 1) : 0);
    }
    const edgeChannels = colourChannels(paint.color);
    const channels: readonly [number, number, number] = [
      edgeChannels[0] + (somaChannels[0] - edgeChannels[0]) * ramp.somaMix,
      edgeChannels[1] + (somaChannels[1] - edgeChannels[1]) * ramp.somaMix,
      edgeChannels[2] + (somaChannels[2] - edgeChannels[2]) * ramp.somaMix,
    ];
    gradient.addColorStop((distance - first) / Math.max(1e-7, last - first),
      rgbaChannels(channels, clamp(ramp.alpha * modulation(distance), 0, 1)));
    // D084-W2-NEURAL-R5 END
  }
  return gradient;
}
// D081-P1G END

export function drawNeuralProfile(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  modulation?: (distancePx: number) => number): void {
  if (modulation && !pulseVisible(paint, modulation as EdgeModulation)) modulation = undefined;
  // Source-over saturation flattens the centre/shoulder ratio at high base opacity. Bound the
  // inline gain so that ratio stays within ten percent of the resting nested-ribbon profile.
  const profileSafeBoost = Math.max(0, 0.416666 / Math.max(paint.alpha, 0.001) - 0.1);
  const layers = neuralRibbonProfile(neuralProfileWidth(paint));
  for (const [index, layer] of layers.entries()) {
    // D084-W2-NEURAL-R6 BEGIN: the outer layer inherits each endpoint's own alpha.
    const outerRoot = index === 0;
    if (modulation) {
      const gain: EdgeModulation = (distance: number) => 1 + Math.min(profileSafeBoost, modulation(distance));
      const timed = modulation as EdgeModulation;
      if (timed.centre !== undefined && timed.radius !== undefined) {
        gain.centre = timed.centre; gain.radius = timed.radius;
      }
      context.fillStyle = edgeLightGradient(context, paint, gain, paint.alpha * layer.alpha, outerRoot);
    } else context.fillStyle = paint.rootStart || paint.rootEnd
      ? edgeLightGradient(context, paint, (() => 1) as EdgeModulation, paint.alpha * layer.alpha, outerRoot)
      : rgba(paint.color, clamp(paint.alpha * layer.alpha, 0, 1));
    // D084-W2-NEURAL-R6 END
    fillRibbon(context, paint.points, i => paint.widthAt(i) * layer.width);
  }
}

/** The pulse uses the same nested widths and alpha proportions as the resting edge. The chord is
 * only the gradient coordinate; both continuous outlines still follow every projected point. */
export function drawNeuralLight(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  modulation: (distancePx: number) => number): void {
  if (!pulseVisible(paint, modulation as EdgeModulation)) return;
  const layers = neuralRibbonProfile(neuralProfileWidth(paint));
  for (const [index, layer] of layers.entries()) {
    // D084-W2-NEURAL-R6 BEGIN
    context.fillStyle = edgeLightGradient(context, paint, modulation as EdgeModulation,
      paint.alpha * layer.alpha, index === 0);
    // D084-W2-NEURAL-R6 END
    fillRibbon(context, paint.points, i => paint.widthAt(i) * layer.width);
  }
}

/** The same continuous radial profile on Stellar and Mycelium, with a bounded light gradient. */
function drawLegacyFlowProfile(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  modulation?: (distancePx: number) => number): void {
  if (modulation && !pulseVisible(paint, modulation as EdgeModulation)) return;
  const light = modulation ?? (() => 1);
  for (const layer of neuralRibbonProfile(neuralProfileWidth(paint))) {
    context.fillStyle = edgeLightGradient(context, paint, light as EdgeModulation, paint.alpha * layer.alpha);
    fillRibbon(context, paint.points, i => paint.widthAt(i) * layer.width);
  }
}

/** The moving frame strokes one cheap path; full Neural quality uses a continuous profile. */
function drawEdgeBase(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint, simple = false): void {
  const { points, color, alpha } = paint;
  if (paint.neural && !simple && typeof context.createLinearGradient === "function") {
    drawNeuralProfile(context, paint);
    return;
  }
  // Preserve the accepted non-Neural morphology output exactly.
  if (!paint.neural && paint.category === "exploratory") {
    context.fillStyle = rgba(color, clamp(paint.alpha * FLOW_HALO_ALPHA, 0, 1));
    fillRibbon(context, points, (i) => paint.widthAt(i) * FLOW_HALO_WIDTH_MULTIPLIER);
  }
  if (simple) {
    // One curve stroke at the dendrite's mid width: the moving frame's cheap neural base.
    context.strokeStyle = rgba(color, alpha);
    context.lineWidth = paint.widthAt((points.length - 1) / 2);
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    if (typeof context.quadraticCurveTo === "function" && points.length > 2) {
      // The reduced frame keeps one stroke and the original anchor budget, while midpoint
      // quadratics hide the decimated sample corners during camera motion.
      for (let i = 1; i < points.length - 1; i++) {
        const point = points[i]!, next = points[i + 1]!;
        context.quadraticCurveTo(point.x, point.y, (point.x + next.x) * 0.5, (point.y + next.y) * 0.5);
      }
      const last = points[points.length - 1]!;
      context.lineTo(last.x, last.y);
    } else for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    return;
  }
  context.fillStyle = rgba(color, paint.alpha);
  fillRibbon(context, points, paint.widthAt);
}

// D084-W2-NEURAL: the former close-up pass (one cosmetic offshoot per visible endpoint)
// is removed — a decorative filament may not fake a relation the graph does not draw.

// D086-F5 BEGIN: the separate flow layer draws the beam as light of its own: one near-white fill on
// the edge's continuous outline, never narrower than the legibility floor, carrying a single
// gradient along the edge exactly as the profile light does.
function drawBeamLight(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  modulation: EdgeModulation, intensity: number): void {
  if (!pulseVisible(paint, modulation)) return;
  const floorPx = flowBeamWidthsPx(neuralProfileWidth(paint)).core;
  const light = { ...paint, color: rgbaChannels(brightenChannels(colourChannels(paint.color), FLOW_BEAM_WHITE_MIX), 1) };
  const envelope = Object.assign((distance: number) => flowBeamEnvelope(modulation(distance), intensity),
    { centre: modulation.centre!, radius: modulation.radius! });
  context.fillStyle = edgeLightGradient(context, light, envelope, flowHeadAlpha(intensity));
  fillRibbon(context, paint.points, i => Math.max(paint.widthAt(i), floorPx));
}
// D086-F5 END

function drawTravellingHighlights(context: CanvasRenderingContext2D, paints: readonly MorphologyEdgePaint[],
  now: number, speed: number, intensity: number,
  // D086-F5 BEGIN
  beam = false,
  // D086-F5 END
): void {
  for (const paint of paints) {
    // D086-F5 BEGIN
    if (beam && typeof context.createLinearGradient === "function") {
      drawBeamLight(context, paint, flowModulation(paint, now, speed, intensity), intensity);
      continue;
    }
    // D086-F5 END
    if (paint.neural) {
      if (typeof context.createLinearGradient === "function")
        drawNeuralLight(context, paint, flowModulation(paint, now, speed, intensity));
      else {
        for (const layer of neuralRibbonProfile(neuralProfileWidth(paint))) {
          context.fillStyle = rgba(paint.color, clamp(paint.alpha * layer.alpha * FLOW_WAVE_MAX_ALPHA * intensity, 0, 1));
          fillRibbon(context, paint.points, i => paint.widthAt(i) * layer.width);
        }
      }
    } else drawLegacyFlowProfile(context, paint, flowModulation(paint, now, speed, intensity));
  }
}

/** Reduced motion keeps the entire exploratory profile continuously and uniformly lit. */
export function drawEdgeStaticCue(context: CanvasRenderingContext2D, paint: MorphologyEdgePaint,
  intensity: number, gradientCapable: boolean): void {
  const staticAlpha = FLOW_WAVE_MAX_ALPHA * 0.35 * Math.min(1, Math.max(0, intensity / 0.6));
  if (gradientCapable) {
    context.fillStyle = rgba(paint.color, clamp(paint.alpha * staticAlpha, 0, 1));
    fillRibbon(context, paint.points, i => paint.widthAt(i) * 0.62);
    return;
  }
  const { points, color, alpha, widthAt } = paint;
  if (paint.neural) {
    context.fillStyle = rgba(color, clamp(alpha * staticAlpha, 0, 1));
    fillRibbon(context, points, i => widthAt(i) * 0.62);
    return;
  }
  context.strokeStyle = rgba(color, clamp(alpha * staticAlpha, 0, 1));
  context.lineWidth = widthAt((points.length - 1) / 2);
  context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
}

/** One world-space geometry, with projection and depth scale supplied by the renderer. */
// D082-A-PERF BEGIN: a settled label pass may repaint the same camera. Retain
// projected soma/edge paints for that exact view; camera changes only project
// the cached world geometry and angular shapes again.
type ProjectedPaintSnapshot = {
  readonly geometry: MorphologyGeometry;
  readonly nodes: MorphologyCanvasStyle["nodes"];
  readonly edges: MorphologyCanvasStyle["edges"];
  readonly focusIds: ReadonlySet<string> | null | undefined;
  readonly dimFocus: unknown;
  readonly hoverId: string | null | undefined;
  readonly quality: "full" | "moving" | undefined;
  readonly appearanceKey: string;
  readonly projection: "2d" | "3d";
  readonly width: number;
  readonly height: number;
  readonly anchors: readonly number[];
  readonly somata: ReadonlyMap<string, NeuralSomaFrame> | null;
  readonly paints: readonly MorphologyEdgePaint[];
};
const projectedPaintSnapshots = new WeakMap<CanvasRenderingContext2D, ProjectedPaintSnapshot>();
function sameAnchors(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
// D082-A-PERF END
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
  // D082-B1f BEGIN: product labels/edges are owned by the Canopy overlay in both projections.
  const canopyHost = canvas.closest?.('[data-fractal-rails-active]');
  const canopyDenseNeural = geometry.morphology === "neural"
    && geometry.drawnSegments.length === 0
    && !!canopyHost;
  const canopyDrawBegan = canopyDenseNeural ? performance.now() : 0;
  if (canopyDenseNeural) {
    beginCanopySomaFrame(canopyHost, geometry, moving);
    if (!structureOnly) warmCanopySomata(geometry, canvas);
  }
  // D082-B1f END.
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
  // D082-B1c BEGIN: Canopy labels are an overlay and need no per-frame disc pass.
  const pearlDiscs = sharedDiscs ? null : canopyDenseNeural ? [] : pearlDiscsFor(geometry, style, project, contract, appearance, projection);
  // D082-B1c END.
  // One projection → limb-radius memo per frame keeps each sphere's outline geometry single-pass.
  const frameCache = createContainerFrameCache();
  drawContainers(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, frameCache);
  // Container titles are placed against the review label pass's disc set when it is shared through
  // the interaction, so a title's reserved rectangle and its ink are the same thing everywhere.
  const titleDiscs: readonly CanvasDisc[] = sharedDiscs ?? pearlDiscs!;
  if (structureOnly) {
    if (!moving || projection === "2d") drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs, undefined, frameCache);
    // D082-B1f BEGIN: native Sigma/GPU nodes were presented before this canvas pass.
    if (canopyDenseNeural) presentCanopySomaFrame(canopyHost, geometry, !moving);
    // D082-B1f END
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
      hubId => style.nodes.get(hubId)?.color, bounds.width, bounds.height, projection);
    drawStellarDust(context, clusters, project,
      hubId => style.nodes.get(hubId)?.color, bounds.width, bounds.height,
      appearance.starfieldDensity, appearance.starfieldBrightness);
  }
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  // D-072 V5: the drawn soma frames exist before the dendrites, so the junction pass and the node
  // pass below paint the very same somata (one source of truth per frame).
  // D082-A-PERF BEGIN
  const appearanceKey = JSON.stringify([appearance.nodeScale, appearance.edgeWidth, appearance.edgeOpacity,
    appearance.curvature, appearance.glow]);
  const anchors = flowProjectionAnchors(geometry, project);
  const previous = projectedPaintSnapshots.get(context);
  const samePaint = previous?.geometry === geometry && previous.nodes === style.nodes && previous.edges === style.edges
    && previous.focusIds === style.interaction?.focusIds && previous.dimFocus === style.interaction?.dimFocus
    && previous.hoverId === style.interaction?.hoverId && previous.quality === style.interaction?.quality
    && previous.appearanceKey === appearanceKey && previous.projection === projection
    && previous.width === bounds.width && previous.height === bounds.height
    && sameAnchors(previous.anchors, anchors);
  // D082-A-PERF END
  // D082-B1c BEGIN: the edge-free Canopy scene uses cached node silhouettes.
  const somaFrames = samePaint ? previous!.somata
    : geometry.morphology === "neural" && !canopyDenseNeural
      ? neuralSomaFrames(geometry, project, style, contract, appearance, projection, moving) : null;
  // D082-B1c END.
  // D087-SIZE BEGIN: dense native tiers keep filaments and cores on the GPU; this canvas
  // paints their structure, while sparse tiers paint their visible nodes and edges here.
  if (!testHook()?.hideEdges) {
    const gradientCapable = typeof context.createLinearGradient === "function";
    // D082-A-PERF BEGIN
    const paints = samePaint ? previous!.paints
      : buildEdgePaints(geometry, style, project, appearance, contract, projection, somaFrames, bounds,
        undefined, indra3d);
    if (!samePaint) projectedPaintSnapshots.set(context, { geometry, nodes: style.nodes, edges: style.edges,
      focusIds: style.interaction?.focusIds, dimFocus: style.interaction?.dimFocus,
      hoverId: style.interaction?.hoverId, quality: style.interaction?.quality,
      appearanceKey, projection, width: bounds.width, height: bounds.height, anchors, somata: somaFrames, paints });
    // D082-A-PERF END
    const animatedEdges = selectAnimatedFlowEdges(geometry, style, project, bounds,
      new Set(paints.map(paint => paint.edgeId)));
    const animating = flowMotionAllowedNow() && appearance.flowIntensity > 0 && appearance.flowSpeed > 0;
    const intensity = appearance.flowIntensity;
    // D-072 V13: "separate" leaves the travelling highlights to the dedicated overlay layer
    // (drawFlowLayer); the static reduced-motion cue and the constant base stay in this pass.
    const inlineHighlights = (style.interaction?.flowLayer ?? "inline") === "inline";
    const now = flowNow();
    const inlineFlowPaints: MorphologyEdgePaint[] = [];
    for (const paint of paints) {
      const animatedHere = paint.category === "exploratory" && animating && animatedEdges.has(paint.edgeId);
      // Neural's inline and reduced-motion paths apply brightness to the two existing profile
      // fills. The product's separate flow canvas still paints only its two overlay fills.
      const combineNeuralLight = paint.neural && !moving && gradientCapable && (inlineHighlights || !animatedHere)
        && paint.category === "exploratory" && intensity > 0;
      if (combineNeuralLight) {
        const modulation = animatedHere
          ? flowModulation(paint, now, appearance.flowSpeed, intensity)
          : () => FLOW_WAVE_MAX_ALPHA * 0.35 * Math.min(1, Math.max(0, intensity / 0.6));
        drawNeuralProfile(context, paint, modulation);
      } else drawEdgeBase(context, paint, moving && geometry.morphology === "neural");
      if (paint.category === "exploratory") {
        // "separate" leaves the travelling highlight to the dedicated overlay: nothing draws here,
        // so the lighter composite (and its restore) is skipped for that edge entirely.
        if (!animatedHere || inlineHighlights) {
          const previousComposite = context.globalCompositeOperation;
          context.globalCompositeOperation = "lighter";
          context.lineCap = "round";
          context.lineJoin = "round";
          if (combineNeuralLight) {
            // The existing two fills already carry the pulse or uniform cue.
          } else if (animatedHere) {
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
  // D087-SIZE BEGIN: junctions belong to the mycelium edge body, which the native tier keeps.
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
  // D087-SIZE BEGIN: 2D retains the D-086 local halo attenuation.
  const haloDensity = projection === "2d" && geometry.morphology === "neural" && !simplified
    && appearance.glow > 0 && !testHook()?.hideEdges && !moving
    ? neuralHaloNeighbourCounts(geometry.nodes) : null;
  // D087-SIZE END
  // D084-W2-NEURAL-R6: Neural keeps its own node opacity; Stellar and Mycelium retain their floors.
  const coreFloor = morphologyCoreAlphaFloor(geometry.morphology);
  for (const node of (testHook()?.hideNodes ? [] : geometry.nodes)) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    // D087-SIZE BEGIN: a real node keeps its full or small profile across admissions.
    const simplifiedNode = projection === "2d" ? simplified
      : visual?.leafMark === undefined ? simplified : visual.leafMark;
    // D087-SIZE END
    const p = project(node.position);
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    // D082-B1f BEGIN: Canopy Completa honours the overlap-safe radius below 2 px.
    // D082-A-NODES BEGIN: hidden core members have no glyph in the full source scene.
    // D086-CUSTOM BEGIN
    // D087-SIZE BEGIN
    if (projection === "3d" ? given === 0 : !canopyHost && denseDrawingPolicy(style) && given === 0) continue;
    // D087-SIZE END
    // D082-A-NODES END
    const basis = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      // D087-SIZE BEGIN
      projection === "3d" ? (visual?.leafMark ? 0.5 : geometry.morphology === "mycelium" ? 1.3 : 2)
        : canopyHost && geometry.nodes.length >= DENSE_SCENE_THRESHOLD ? 0.5
          : denseDrawingPolicy(style) ? 0.5
            : geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
      // D087-SIZE END
    // D086-CUSTOM END
    // D082-B1f END
    // D-072 M1b: a Stellar node draws as a star — the importance basis compressed into the star
    // window of this node's degree, never above the basis (pick radius untouched), 2D and 3D alike.
    const radius = geometry.morphology === "stellar" && basis > 1
      ? stellarStarCoreRadiusPx(basis, node.degree) : basis;
    // D082-A-NODES BEGIN
    // Below a CSS pixel, a bright point is more legible than a clipped star or soma outline.
    // D082-A-N3D BEGIN: the 3D Neural fit uses a larger point before the soma outline resolves.
    // D086-CUSTOM BEGIN: Custom's capped native radius must not rise to the reference 3D point floor.
    const neuralPointRadius = projection === "3d" && geometry.morphology === "neural" && !denseNativeRadiusOnly(style) ? 0.9 : 0.5;
    if (!canopyHost && denseDrawingPolicy(style) && radius <= (projection === "3d" && geometry.morphology === "neural" && !denseNativeRadiusOnly(style) ? 0.9 : 0.75)) {
    // D082-A-N3D END
      context.globalAlpha = 1;
      context.fillStyle = visual?.color ?? "rgb(245, 245, 245)";
      // D082-A-N3D BEGIN
      context.beginPath(); context.arc(p.x, p.y,
        neuralPointRadius, 0, Math.PI * 2); context.fill();
    // D086-CUSTOM END
      // D082-A-N3D END
      continue;
    }
    // D082-A-NODES END
    // A pearl wholly outside the canvas (with its glow halo) draws nothing a viewer could see.
    const haloRatio = projection === "3d" && visual?.leafMark ? 1
      : geometry.morphology === "neural"
        ? Math.min(contract.glow.maximumCoreRatio, NEURAL_HALO_MAX_RADIUS_RATIO) : contract.glow.maximumCoreRatio;
    const haloExtent = appearance.glow > 0 ? radius * haloRatio : radius;
    if (p.x + haloExtent < 0 || p.x - haloExtent > bounds.width
      || p.y + haloExtent < 0 || p.y - haloExtent > bounds.height) continue;
    context.globalAlpha = focusNodeOpacity(style.interaction?.dimFocus?.members ?? null, node.id);
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const baseOpacity = visual?.opacity ?? 1;
    // The effective halo strength carries the Neural density falloff; other morphologies keep theirs.
    // D087-SIZE BEGIN
    const requestedGlowStrength = haloDensity
      ? contract.glow.strength * neuralHaloAlphaFactor(haloDensity.get(node.id) ?? 1)
      : contract.glow.strength;
    // D087-SIZE END
    const glowStrength = geometry.morphology === "neural"
      ? Math.min(requestedGlowStrength, NEURAL_HALO_MAX_ALPHA / Math.max(1, appearance.glow)) : requestedGlowStrength;
    // D082-A-NCOMPLETA BEGIN: local-density halo factor is 1 outside Completa and at z6.
    const denseGlowStrength = glowStrength * (geometry.morphology === "neural"
      ? style.interaction?.denseNeuralHaloById?.get(node.id) ?? 1 : 1);
    // D082-A-NCOMPLETA END
    // In Indra 3D every colour of the pearl comes from one cached paint entry (quantised depth);
    // elsewhere the exact per-node factors stay. The moving frame wants no pearl paint at all.
    const paint = indra3d && !moving
      ? pearlPaint(context, color, p.scale, emphasis?.brightnessMultiplier ?? 1,
        style.interaction?.hoverId === node.id ? 1 : style.interaction?.focusIds?.has(node.id) ? 2 : 0,
        baseOpacity, radius, appearance.glow, denseGlowStrength, coreFloor)
      : null;
    const lit = paint ? paint.lit : dim(color, depthBrightness(p.scale, projection));
    const litChannels = paint ? paint.litChannels : colourChannels(lit);
    // Depth reads on the pearls themselves: the back ones are slightly fainter (the radius already
    // carries the depth through the projection's size scale).
    const depthAlpha = projection === "3d" ? clamp(0.85 + 0.15 * Math.min(1, Math.max(0, p.scale)), 0.85, 1) : 1;
    // D084-W2-NEURAL-R6 BEGIN: the filled outline uses the same node-owned
    // alpha that the root endpoint sampled before this node pass.
    const opacity = geometry.morphology === "neural"
      ? neuralSomaOutlineAlpha(baseOpacity, emphasis?.brightnessMultiplier ?? 1, p.scale,
        projection, indra3d)
      : paint ? paint.opacity
      : coreFloor > 0.48
        ? clamp(Math.max(coreFloor, baseOpacity * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha), 0, 1)
        : clamp(Math.max(0.48, baseOpacity) * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha, 0, 1);
    // D084-W2-NEURAL-R6 END
    // D087-SIZE BEGIN
    if (!simplifiedNode && !(projection === "3d" && visual?.leafMark)
      && appearance.glow > 0 && !testHook()?.hideEdges && !moving) {
    // D087-SIZE END
      const halo = radius * haloRatio;
      if (paint?.glow && canTransform) {
        fillUnitGradient(context, paint.glow, p.x, p.y, halo);
      } else {
        // D-072: the flat-view halo gradient depends only on (lit colour, quantised alpha), so it
        // comes from the per-context unit cache below and composes under translate + scale — no
        // per-node gradient re-creation, at any node count.
        const haloAlpha = quantisedAlpha(denseGlowStrength * opacity * appearance.glow);
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
    // D082-B1c BEGIN: at rest the cached unit outline preserves the organic body;
    // moving frames use one disc and never evaluate soma harmonics or lobe area.
    if (canopyDenseNeural) {
      context.fillStyle = rgbaChannels(litChannels, opacity);
      context.beginPath();
      const points = moving ? undefined : cachedCanopySomaOutlinePacked(geometry, node.id);
      if (!points) context.arc(p.x, p.y, radius, 0, Math.PI * 2);
      else {
        const axis = node.axis ?? { x: 1, y: 0, z: 0 };
        const q = project({ x: node.position.x + axis.x, y: node.position.y + axis.y,
          z: node.position.z + axis.z });
        const angle = Math.atan2(q.y - p.y, q.x - p.x);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        for (let index = 0; index < points.length; index += 2) {
          const x = p.x + radius * (cos * points[index]! - sin * points[index + 1]!);
          const y = p.y + radius * (sin * points[index]! + cos * points[index + 1]!);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
      }
      context.fill();
      context.globalAlpha = 1;
      continue;
    }
    // D082-B1c END.
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
        const projectedEccentricity = Math.sqrt(1 + ((node.spindleRatio ?? node.eccentricity ?? 1) ** 2 - 1) * visibleAxis ** 2);
        eccentricity = node.spindleRatio ? clamp(projectedEccentricity * somaElongationFactor(harmonics), 1.04, 1.9)
          : somaDrawnElongation(projectedEccentricity, harmonics);
      }
      const major = radius * eccentricity, minor = radius;
      // D082-A-PERF BEGIN: only the declared moving tier simplifies the
      // silhouette; full-quality dense scenes retain their approved outline.
      // D087-SIZE BEGIN
      const steps = moving ? 12 : simplifiedNode ? 24 : NEURAL_SOMA_MAX_VERTICES;
      // D087-SIZE END
      // D082-A-PERF END
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const irregularityScale = somaIrregularityScale(radius);
      // D082-A-PERF BEGIN: reuse dimensionless lobe/outline samples across zoom steps.
      const cachedSilhouette = frame && !moving ? cachedSomaSilhouette(node, frame, steps) : null;
      // D082-A-PERF END
      const somaPath = () => {
        context.beginPath();
        for (let i = 0; i < steps; i += 1) {
          const theta = (i / steps) * Math.PI * 2;
          const bulge = moving ? 1 : cachedSilhouette ? 1 : 1 + clamp(
            somaOutlineIrregularity(harmonics, theta) * irregularityScale * SOMA_IRREGULARITY_BOOST,
            -NEURAL_SOMA_OUTLINE_MAX_RADIAL, NEURAL_SOMA_OUTLINE_MAX_RADIAL);
          const polarAngle = cachedSilhouette ? 0 : Math.atan2(minor * Math.sin(theta), major * Math.cos(theta)) + angle;
          const silhouette = (cachedSilhouette?.[i] ?? (bulge * (node.spindleRatio ? somaSpindleFactor(theta) : 1)
            * somaLobeFactor(frame?.lobes ?? [], polarAngle, frame?.lobeAreaScale)))
            * neuralEndpointBodyScale(node.degree);
          const ex = major * Math.cos(theta) * silhouette;
          const ey = minor * Math.sin(theta) * silhouette;
          const x = p.x + cosA * ex - sinA * ey;
          const y = p.y + sinA * ex + cosA * ey;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
      };
      // D082-A-NEURALe BEGIN: erase the portion of every root hidden by the soma before
      // painting the body. Source-over otherwise adds the root and soma fills and
      // exposes a bright, hard-edged patch at the junction. The same path is reused
      // for subtraction and fill; no extra tessellation or offscreen surface is needed.
      if (!testHook()?.hideEdges) {
        const previousComposite = context.globalCompositeOperation;
        const previousAlpha = context.globalAlpha;
        context.globalCompositeOperation = "destination-out";
        context.globalAlpha = 1;
        context.fillStyle = "rgb(0, 0, 0)";
        somaPath();
        context.fill();
        context.globalCompositeOperation = previousComposite;
        context.globalAlpha = previousAlpha;
      }
      // D082-A-NEURALe END
      // D084-W2-NEURAL-R6 BEGIN: paint the same alpha passed to attached roots.
      context.fillStyle = rgbaChannels(litChannels, opacity);
      // D084-W2-NEURAL-R6 END
      somaPath();
      context.fill();
      // Brighter small nucleus inside the body, oriented with the soma; its gradient is cached per
      // context in unit space (colour + quantised opacity key) and composed under translate + scale.
      // The moving frame skips it: the soma stays one solid body.
      // D087-SIZE BEGIN
      if (!simplifiedNode && !moving) {
      // D087-SIZE END
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
    if (geometry.morphology === "stellar") {
      const nucleus = brightenChannels(colourChannels(color), stellarCoreLuminance(basis, node.degree));
      context.fillStyle = rgbaChannels(nucleus, 1);
      context.beginPath(); context.arc(p.x, p.y, radius * 0.58, 0, Math.PI * 2); context.fill();
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
  // D082-B1c BEGIN: paired with overlay and restore marks for the browser profile.
  // D082-B1f BEGIN: only the settled draw of this exact geometry can release readiness.
  if (canopyDenseNeural) presentCanopySomaFrame(canopyHost, geometry, !moving && canopySomataPrepared(geometry));
  // D082-B1f END
  if (canopyDenseNeural) performance.mark('d082-b1c:canopy-product-draw', { detail: {
    durationMs: performance.now() - canopyDrawBegan, moving, nodes: geometry.nodes.length } });
  // D082-B1c END.
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
 * The travelling flow profile alone: a small dedicated canvas can call
 * this every frame while the scene below stays painted, so the exploratory reading stops repainting
 * the whole graph. The caller owns the layer completely — sizing, the transform and the clear before
 * each call; this function only draws the smooth brightness wave of exploratory relations the
 * shared budget selected (same deterministic selection the inline pass would draw, so both layers
 * agree without coordination). Reads the shared flow clock (`setFlowNow`/`setFlowMotionAllowed`,
 * driven today by the product view's animation loop). Nothing else is drawn: no base lines, no
 * static cue, no nodes. Neural uses the complete nested ribbon per edge; other morphologies
 * retain their established overlay cross-section.
 *
 * Signature:
 * `drawFlowLayer(context, geometry, project, style, appearance = DEFAULT_APPEARANCE, projection = "2d")`
 * — `context`/`project`/`style`/`appearance`/`projection` exactly as `drawMorphologyCanvas` takes
 * them, on the overlay's own 2D context; the base scene pass should run with
 * `style.interaction.flowLayer = "separate"` so the highlights are not drawn twice.
 */
// D085-S6: the native 3D beam's clock sampler lives with the shared clock it reads
// (`nativeBeamElapsedSample` in render-common/flow.ts); the canvas layer keeps drawing
// from `flowNow()` directly, as before.

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
    // D082-A-PERF BEGIN: selection formerly ran after paints for every drawn
    // segment. Rank eligible exploratory edges first, then use the original
    // paint clipping to identify the first 60 actually visible ones.
    const drawable = new Set<string>();
    for (const part of geometry.drawnSegments) if (part.samples.length >= 2
      && style.edges.get(part.edgeId)?.presentation?.category === "exploratory") drawable.add(part.edgeId);
    let budget = Math.min(FLOW_ANIMATED_EDGE_BUDGET, drawable.size);
    let paints: MorphologyEdgePaint[] = [];
    let animatedEdges: ReadonlySet<string> = new Set();
    do {
      const candidates = selectAnimatedFlowEdges(geometry, style, project, bounds, drawable, budget);
      const endpoints = geometry.morphology === "neural" ? new Set<string>() : null;
      if (endpoints) for (const edge of geometry.edges) if (candidates.has(edge.id)) {
        endpoints.add(edge.source); endpoints.add(edge.target);
      }
      const somaFrames = endpoints ? neuralSomaFrames(geometry, project, style, contract, appearance,
        projection, false, endpoints) : null;
      paints = buildEdgePaints(geometry, style, project, appearance, contract, projection,
        somaFrames, bounds, candidates);
      // clipEdgePaint is the authoritative visibility test. A prefix may
      // contain offscreen edges, so expand until 60 visible edges are known.
      const painted = new Set(paints.map(paint => paint.edgeId));
      animatedEdges = selectAnimatedFlowEdges(geometry, style, project, bounds, painted);
      if (painted.size >= FLOW_ANIMATED_EDGE_BUDGET || budget >= drawable.size
        || candidates.size < budget) break;
      budget = Math.min(drawable.size, budget * 2);
    } while (true);
    // D082-A-PERF END
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
  // D086-F5 BEGIN
  drawTravellingHighlights(context, cache.paints, now, appearance.flowSpeed, appearance.flowIntensity, true);
  // D086-F5 END
  context.globalCompositeOperation = previousComposite;
}
