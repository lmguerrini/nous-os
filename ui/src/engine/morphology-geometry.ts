import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import type { MorphologyContainerInput, MorphologyContainerPath } from "#engine/container-geometry.ts";
import { morphologyHash } from "#engine/stable-hash.ts";
import { arborizeNeuralTrunk, neuralBranchRoute, type NeuralBranch, type NeuralTrunk, type TrunkMember } from "#engine/neural-trunks.ts";

export { buildContainerGeometry, morphologyHash };
export type { MorphologyContainerInput, MorphologyContainerPath };
export type MorphologyNodeInput = { readonly id: string; readonly position: Coordinates; readonly radius: number };
export type MorphologyEdgeInput = { readonly id: string; readonly source: string; readonly target: string; readonly width: number };
export type MorphologyColonyInput = { readonly id: string; readonly members: readonly string[]; readonly center: Coordinates };
export type MorphologyInput = { readonly nodes: readonly MorphologyNodeInput[]; readonly edges: readonly MorphologyEdgeInput[]; readonly colonies: readonly MorphologyColonyInput[]; readonly containers: readonly MorphologyContainerInput[] };
/** One low-frequency outline harmonic that deforms a soma away from a perfect ellipse. */
export type SomaOutlineHarmonic = { readonly order: number; readonly amplitude: number; readonly phase: number };
export type NeuralBundle = { readonly direction: Coordinates; readonly weight: number; readonly edgeIds: readonly string[] };
export type MorphologyNodeShape = MorphologyNodeInput & {
  readonly degree: number; readonly axis: Coordinates; readonly eccentricity: number;
  readonly outline: readonly SomaOutlineHarmonic[]; readonly bundles?: readonly NeuralBundle[];
  readonly trunks?: readonly NeuralTrunk[];
  readonly arbors?: readonly NeuralBranch[];
  /** Canvas silhouette along the strongest real trunk; the legacy ellipse metric stays stable. */
  readonly spindleRatio?: number | undefined;
  readonly rootRatio?: number;
  readonly haloRadiusRatio?: number; readonly haloAlphaLimit?: number;
};
export type MorphologySegment = {
  readonly id: string; readonly edgeId: string; readonly source: Coordinates; readonly control: Coordinates; readonly target: Coordinates;
  readonly samples: readonly Coordinates[]; readonly widthStart: number; readonly widthEnd: number; readonly widthMid: number; readonly sharedKey: string | null;
  readonly curvature: number; readonly path: "straight" | "soft-curve" | "wave";
  readonly trunkSourceCount?: number; readonly trunkTargetCount?: number;
  readonly trunkSourceWidthFactor?: number | undefined; readonly trunkTargetWidthFactor?: number | undefined;
  readonly sourceBranches?: readonly NeuralBranch[]; readonly targetBranches?: readonly NeuralBranch[];
};
export type MorphologyGeometry = {
  readonly morphology: Morphology; readonly nodes: readonly MorphologyNodeShape[];
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string; readonly segments: readonly MorphologySegment[] }[];
  readonly drawnSegments: readonly MorphologySegment[]; readonly branchPoints: readonly Coordinates[];
  readonly containers: readonly MorphologyContainerPath[];
  /** D-072 F3: the communities the caller declared, carried verbatim so the shared canvas layer can
   * build cluster-aware Stellar presentation (dust, intra-community arcs) without re-deriving them.
   * Purely presentational input: absent or empty means no community-aware modulation. */
  readonly colonies: readonly MorphologyColonyInput[];
};
const add = (a: Coordinates, b: Coordinates): Coordinates => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Coordinates, b: Coordinates): Coordinates => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: Coordinates, k: number): Coordinates => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Coordinates, b: Coordinates) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Coordinates) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Coordinates): Coordinates => mul(a, 1 / (norm(a) || 1));
const mix = (a: Coordinates, b: Coordinates, t: number) => add(mul(a, 1 - t), mul(b, t));
const normal = (a: Coordinates, b: Coordinates): Coordinates => {
  const d = sub(b, a);
  return unit(Math.hypot(d.x, d.y) > 1e-8 ? { x: -d.y, y: d.x, z: 0 } : { x: 1, y: 0, z: 0 });
};
const cubic = (a: Coordinates, b: Coordinates, c: Coordinates, d: Coordinates, t: number): Coordinates =>
  add(add(mul(a, (1 - t) ** 3), mul(b, 3 * t * (1 - t) ** 2)), add(mul(c, 3 * t * t * (1 - t)), mul(d, t ** 3)));

/** Split one sampled whole-edge curve. Adjacent parts share the exact sample at the join,
 * including its tangent, and the width keys agree there. The path remains in the edge's chord
 * corridor even when a colony centre lies far outside that chord. */
function myceliumParts(edge: MorphologyEdgeInput, a: Coordinates, b: Coordinates,
  curvature: number, branched: boolean): MorphologySegment[] {
  const whole = segment(edge.id, edge.id, a, b, edge.width, edge.width, "mycelium", curvature);
  if (!branched || whole.samples.length < 17) return [whole];
  const samples = whole.samples.map(point => ({ ...point }));
  const cuts = samples.length === 41 ? [0, 10, 20, 30, 40] : [0, 4, 8, 12, 16];
  // A sampled polyline otherwise has a tiny corner at each cut even when its analytic wave is C1.
  // Put the shared sample on its neighbours' chord, giving the raster path exactly one tangent.
  for (const cut of cuts.slice(1, -1)) samples[cut] = mix(samples[cut - 1]!, samples[cut + 1]!, 0.5);
  const widths = [0.5, 0.8, 1.15, 0.8, 0.5].map(factor => edge.width * factor);
  return cuts.slice(0, -1).map((start, index) => {
    const piece = samples.slice(start, cuts[index + 1]! + 1);
    return { ...whole, id: `${edge.id}:${index}`, source: piece[0]!, target: piece[piece.length - 1]!,
      control: piece[1]!, samples: piece, widthStart: widths[index]!, widthEnd: widths[index + 1]!,
      widthMid: (widths[index]! + widths[index + 1]!) / 2 };
  });
}

/** Neural dendrite/axon width factors: thick near each soma, thinnest at the mid-edge. */
export const NEURAL_TAPER = { proximal: 1.7, mid: 0.5, distal: 1.2 } as const;
/** A short screen-space shoulder preserves a compact soma even on very long relations. */
export const NEURAL_TAPER_FRACTION = 0.28;
/** Cache key for the pure Neural silhouette and root profile. */
// D084-W2-NEURAL BEGIN: the soma no longer spindle-elongates and the root continues the
// soma body (half-width = local soma extension at the boundary), so every cached
// silhouette, lobe area and scene buffer keyed on this version is rebuilt once.
export const NEURAL_GEOMETRY_VERSION = "d084-r4-concave-profile-4";
// D084-W2-NEURAL END
/** A short fillet joins the soma to the existing trunk without drawing a white radial arm. */
// D084-W2-NEURAL-R3 BEGIN: one screen-space junction policy for every renderer.
export const NEURAL_ROOT_LENGTH_RADII = 9;
export const NEURAL_ROOT_MAX_LENGTH_RADII = 9;
// D084-W2-NEURAL-R4 BEGIN: a circle of radius 0.35R is externally tangent to
// the unit soma and to the horizontal 0.45R process edge. The circle contact
// is the root anchor; the process begins at the second tangency.
export const NEURAL_ROOT_FILLET_RADII = 0.35;
export const NEURAL_ROOT_MOUTH_RADII = 0.45;
const filletCenterY = NEURAL_ROOT_MOUTH_RADII + NEURAL_ROOT_FILLET_RADII;
const filletCenterX = Math.sqrt((1 + NEURAL_ROOT_FILLET_RADII) ** 2 - filletCenterY ** 2);
export const NEURAL_ROOT_ANCHOR_RADII = filletCenterX / (1 + NEURAL_ROOT_FILLET_RADII);
export const NEURAL_ROOT_FILLET_LENGTH_RADII = filletCenterX - NEURAL_ROOT_ANCHOR_RADII;
export const NEURAL_ROOT_SPAN_FRACTION = 0.5;
export const NEURAL_ROOT_MIN_LENGTH_PX = 24;
export const NEURAL_PROFILE_FILLET_SAMPLES = 24;
export const NEURAL_PROFILE_SAMPLES = 64;
/** Packed (distance/R, half-width/R, soma colour mix, half-width slope), shared by every path. */
export const NEURAL_PROFILE_TABLE = (() => {
  const samples = new Float32Array(NEURAL_PROFILE_SAMPLES * 4);
  const smooth = (u: number) => u * u * (3 - 2 * u);
  for (let i = 0; i < NEURAL_PROFILE_SAMPLES; i++) {
    const fillet = i < NEURAL_PROFILE_FILLET_SAMPLES;
    const s = fillet
      ? NEURAL_ROOT_FILLET_LENGTH_RADII * i / (NEURAL_PROFILE_FILLET_SAMPLES - 1)
      : NEURAL_ROOT_FILLET_LENGTH_RADII + NEURAL_ROOT_LENGTH_RADII
        * (i - NEURAL_PROFILE_FILLET_SAMPLES + 1) / (NEURAL_PROFILE_SAMPLES - NEURAL_PROFILE_FILLET_SAMPLES);
    const x = NEURAL_ROOT_ANCHOR_RADII + s;
    const half = fillet
      ? filletCenterY - Math.sqrt(Math.max(0, NEURAL_ROOT_FILLET_RADII ** 2 - (x - filletCenterX) ** 2))
      : NEURAL_ROOT_MOUTH_RADII;
    const slope = fillet ? -(x - filletCenterX) / (half - filletCenterY) : 0;
    const process = Math.max(0, s - NEURAL_ROOT_FILLET_LENGTH_RADII);
    // D084-W2-NEURAL-R5 BEGIN: keep a readable shaft after the proven fillet.
    // The same column governs width, colour and alpha in all four renderers.
    const mix = fillet || process <= 2.5 ? 1
      : process <= 5 ? 1 - 0.3 * smooth((process - 2.5) / 2.5)
        : 0.7 * (1 - smooth((process - 5) / 4));
    // D084-W2-NEURAL-R5 END
    samples.set([s, half, mix, slope], i * 4);
  }
  return samples;
})();
function neuralProfileMixSlope(i: number): number {
  return i === 0 || i === NEURAL_PROFILE_SAMPLES - 1 ? 0
    : (NEURAL_PROFILE_TABLE[(i + 1) * 4 + 2]! - NEURAL_PROFILE_TABLE[(i - 1) * 4 + 2]!) /
      (NEURAL_PROFILE_TABLE[(i + 1) * 4]! - NEURAL_PROFILE_TABLE[(i - 1) * 4]!);
}
function neuralProfileHermite(a: number, b: number, ma: number, mb: number, t: number, span: number): number {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ma * span
    + (-2 * t3 + 3 * t2) * b + (t3 - t2) * mb * span;
}
export function neuralProfileTableAt(sRadii: number): { halfWidthRadii: number; somaMix: number } {
  const s = Math.max(0, Math.min(NEURAL_ROOT_FILLET_LENGTH_RADII + NEURAL_ROOT_LENGTH_RADII, sRadii));
  if (s >= NEURAL_ROOT_FILLET_LENGTH_RADII + NEURAL_ROOT_LENGTH_RADII - 1e-6)
    return { halfWidthRadii: NEURAL_ROOT_MOUTH_RADII, somaMix: 0 };
  let low = 0, high = NEURAL_PROFILE_SAMPLES - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (s <= NEURAL_PROFILE_TABLE[middle * 4]!) high = middle;
    else low = middle;
  }
  const before = low * 4, offset = high * 4;
  const span = Math.max(1e-9, NEURAL_PROFILE_TABLE[offset]! - NEURAL_PROFILE_TABLE[before]!);
  const t = Math.max(0, Math.min(1, (s - NEURAL_PROFILE_TABLE[before]!) / span));
  return { halfWidthRadii: neuralProfileHermite(NEURAL_PROFILE_TABLE[before + 1]!, NEURAL_PROFILE_TABLE[offset + 1]!,
    NEURAL_PROFILE_TABLE[before + 3]!, NEURAL_PROFILE_TABLE[offset + 3]!, t, span),
    somaMix: Math.max(0, Math.min(1, neuralProfileHermite(NEURAL_PROFILE_TABLE[before + 2]!, NEURAL_PROFILE_TABLE[offset + 2]!,
      neuralProfileMixSlope(low), neuralProfileMixSlope(high), t, span))) };
}
// WebGL1 requires constant uniform-array indexes. Build a balanced lookup tree
// from the same engine table so both GPU languages interpolate identical entries.
function neuralProfileGlslMixSlope(i: number): string {
  return i === 0 || i === NEURAL_PROFILE_SAMPLES - 1 ? "0.0"
    : `(u_neuralProfileTable[${i + 1}].z - u_neuralProfileTable[${i - 1}].z)
      / (u_neuralProfileTable[${i + 1}].x - u_neuralProfileTable[${i - 1}].x)`;
}
function neuralProfileGlslBranch(first: number, last: number): string {
  if (first === last) return `{
    vec4 a = u_neuralProfileTable[${first - 1}];
    vec4 b = u_neuralProfileTable[${first}];
    float span = max(b.x - a.x, 0.000001);
    float t = clamp((s - a.x) / span, 0.0, 1.0);
    return vec2(neuralHermite(a.y, b.y, a.w, b.w, t, span),
      clamp(neuralHermite(a.z, b.z, ${neuralProfileGlslMixSlope(first - 1)},
        ${neuralProfileGlslMixSlope(first)}, t, span), 0.0, 1.0));
  }`;
  const middle = (first + last) >> 1;
  return `if (s <= u_neuralProfileTable[${middle}].x) {
    ${neuralProfileGlslBranch(first, middle)}
  } else {
    ${neuralProfileGlslBranch(middle + 1, last)}
  }`;
}
export const NEURAL_PROFILE_GLSL = `
uniform vec4 u_neuralProfileTable[${NEURAL_PROFILE_SAMPLES}];
float neuralHermite(float a, float b, float ma, float mb, float t, float span) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * a + (t3 - 2.0 * t2 + t) * ma * span
    + (-2.0 * t3 + 3.0 * t2) * b + (t3 - t2) * mb * span;
}
float neuralProcessLength(float radius, float span, float pixelRatio) {
  return min(span, max(${NEURAL_ROOT_MIN_LENGTH_PX}.0 * pixelRatio,
    min(radius * ${NEURAL_ROOT_LENGTH_RADII}.0, span * ${NEURAL_ROOT_SPAN_FRACTION})));
}
float neuralProfileDistance(float distance, float radius, float processLength) {
  float fillet = radius * ${NEURAL_ROOT_FILLET_LENGTH_RADII};
  float process = max(0.0, distance - fillet);
  float twoAndHalf = 2.5 * radius;
  float five = 5.0 * radius;
  if (distance <= fillet) return max(0.0, distance / max(radius, 0.000001));
  if (processLength <= twoAndHalf) return ${NEURAL_ROOT_FILLET_LENGTH_RADII}
    + process / max(processLength, 0.000001) * ${NEURAL_ROOT_LENGTH_RADII}.0;
  if (processLength <= five) return ${NEURAL_ROOT_FILLET_LENGTH_RADII} + (process <= twoAndHalf
    ? process / max(radius, 0.000001)
    : 2.5 + (process - twoAndHalf) / max(processLength - twoAndHalf, 0.000001) * 6.5);
  return ${NEURAL_ROOT_FILLET_LENGTH_RADII} + (process <= five
    ? process / max(radius, 0.000001)
    : 5.0 + (process - five) / max(processLength - five, 0.000001) * 4.0);
}
vec2 neuralProfileSample(float s) {
  ${neuralProfileGlslBranch(1, NEURAL_PROFILE_SAMPLES - 1)}
}`;
// D084-W2-NEURAL-R4 END
/** Degree-one bodies are compact so their single broad root reads as the tail of one cell. */
export const NEURAL_LEAF_BODY_SCALE = 0.84;
// D084-W2-NEURAL-R3: one endpoint policy feeds canvas, native 3D and dense 2D.
export function neuralEndpointBodyScale(degree: number): number {
  return degree === 1 ? NEURAL_LEAF_BODY_SCALE : 1;
}
// The drawn node radius is clamped to 2 px. Even those smallest leaves need a root.
export const NEURAL_MIN_SHAPED_RADIUS_PX = 1.5;
export type NeuralRootSample = { readonly width: number; readonly alpha: number; readonly somaMix: number };
/** The 45% span cap leaves room for the root at the opposite endpoint of short links. */
export function neuralRootLengthPx(somaRadiusPx: number, spanPx: number): number {
  // D084-W2-NEURAL-R5: the process reaches ordinary edge width at the requested
  // screen-space distance, bounded by the actual relation length.
  return Math.min(spanPx, Math.max(NEURAL_ROOT_MIN_LENGTH_PX,
    Math.min(somaRadiusPx * NEURAL_ROOT_LENGTH_RADII, spanPx * NEURAL_ROOT_SPAN_FRACTION)));
}
/** Each drawn relation retains the same root reach at a given screen-space radius. */
export function neuralVisibleRootLengthPx(somaRadiusPx: number, spanPx: number,
  degree: number, shared: boolean, edgeWeight = 1): number {
  // D084-W2-NEURAL-R3: a hub's individual drawn processes use the same local
  // taper as a leaf. The old degree reduction disagreed with both GPU paths.
  return neuralRootLengthPx(somaRadiusPx, spanPx);
}
// D084-W2-NEURAL-R3 BEGIN: keep the old call site for cache compatibility, but remove
// the earlier short-root rule. Its small-soma compression caused the rejected thin tail.
export function neuralRootCompactnessScale(somaRadiusPx: number, ordinaryPx: number): number {
  return 1;
}
// D084-W2-NEURAL-R3 END
/** Radius of curvature of either side of the concave ribbon at its soma mouth. */
export function neuralRootFilletRadiusPx(mouthWidthPx: number, trunkWidthPx: number,
  rootLengthPx: number): number {
  const widthDrop = Math.abs(mouthWidthPx - trunkWidthPx);
  if (widthDrop <= 0) return Infinity;
  const slope = 2 * widthDrop / rootLengthPx;
  return rootLengthPx * rootLengthPx * (1 + slope * slope) ** 1.5 / (2 * widthDrop);
}
/** A bounded response to the edge-width control keeps the mouth proportional to its soma.
 * D084-W2-NEURAL: capped at 1.0 — the root never exceeds the soma's local extension. */
export function neuralMouthScale(edgeWidthPx: number): number {
  return Math.max(0.8, Math.min(1, 0.8 + Math.max(0, edgeWidthPx) / 1.2 * 0.2));
}
/** `distancePx=0` is the visible outline; negative positions are hidden in the soma.
 * `spanPx` is the projected full edge length, not a world-space distance. */
export function neuralRootProfileAt(distancePx: number, somaRadiusPx: number, edgeWidthPx: number,
  edgeAlpha: number, rootRatio = NEURAL_ROOT_RATIO, spanPx = somaRadiusPx * 20,
  trunkWidthPx = edgeWidthPx, somaAlpha = edgeAlpha): NeuralRootSample {
  return neuralRootProfileAtLength(distancePx, somaRadiusPx, edgeWidthPx, edgeAlpha, rootRatio,
    neuralRootLengthPx(somaRadiusPx, spanPx), trunkWidthPx, somaAlpha);
}
/** A convex width falloff gives the neurite a curved, concave side, rather than a wedge.
 * The mouth is hidden inside the soma; its visible silhouette comes from the union with the body.
 * `trunkWidthPx` is the D-081 ribbon at the fillet end, including shared-trunk width. */
// D084-W2-NEURAL BEGIN: the root is a continuation of the soma body, not a ribbon glued to
// its rim. At the visible boundary (`distancePx = 0`) its full width is twice the local soma
// extension — the half-width equals the soma radius — and under the soma it keeps that base,
// so the union silhouette flows from the body into the process with no neck. The width then
// decreases monotonically (concave sides, no local minimum) to the trunk width.
export function neuralRootProfileAtLength(distancePx: number, somaRadiusPx: number, edgeWidthPx: number,
  edgeAlpha: number, rootRatio: number, rootLengthPx: number,
  trunkWidthPx = edgeWidthPx, somaAlpha = edgeAlpha): NeuralRootSample {
  const width = Math.max(0, edgeWidthPx);
  const alpha = Math.max(0, Math.min(1, edgeAlpha));
  if (somaRadiusPx < NEURAL_MIN_SHAPED_RADIUS_PX) return { width, alpha, somaMix: 0 };
  // D084-W2-NEURAL-R4: distance is measured from the circle tangency. Only
  // the process stretch is rescaled by the visible span; the fillet stays 0.35R.
  const filletPx = NEURAL_ROOT_FILLET_LENGTH_RADII * somaRadiusPx;
  const process = Math.max(0, distancePx - filletPx);
  const s = distancePx <= filletPx ? distancePx / somaRadiusPx
    : NEURAL_ROOT_FILLET_LENGTH_RADII + (rootLengthPx <= 2.5 * somaRadiusPx
      ? process / Math.max(rootLengthPx, 1e-6) * NEURAL_ROOT_LENGTH_RADII
      : rootLengthPx <= 5 * somaRadiusPx
        ? process <= 2.5 * somaRadiusPx ? process / somaRadiusPx
          : 2.5 + (process - 2.5 * somaRadiusPx) / Math.max(rootLengthPx - 2.5 * somaRadiusPx, 1e-6) * 6.5
        : process <= 5 * somaRadiusPx ? process / somaRadiusPx
          : 5 + (process - 5 * somaRadiusPx) / Math.max(rootLengthPx - 5 * somaRadiusPx, 1e-6) * 4);
  const profile = neuralProfileTableAt(s);
  const somaMix = profile.somaMix;
  const trunk = Math.max(width, trunkWidthPx);
  const rootWidth = 2 * somaRadiusPx * profile.halfWidthRadii;
  // D084-W2-NEURAL-R6 BEGIN: the table blends from the attached soma's drawn
  // opacity to the independent edge opacity, with no junction floor or ceiling.
  const drawnSomaAlpha = Math.max(0, Math.min(1, somaAlpha));
  return { width: trunk + (rootWidth - trunk) * somaMix,
    alpha: somaMix === 1 ? drawnSomaAlpha : somaMix === 0 ? alpha
      : alpha + (drawnSomaAlpha - alpha) * somaMix, somaMix };
  // D084-W2-NEURAL-R6 END
}
// D084-W2-NEURAL-R3 END
/** Historical test bound; live roots use their ratios across the full width slider. */
export const NEURAL_ROOT_CAP_PX = 32;
/** Both projections preserve these widths at the visible soma boundary. */
export const NEURAL_HALO_MAX_RADIUS_RATIO = 1.1;
export const NEURAL_HALO_MAX_ALPHA = 0.05;
export const NEURAL_ROOT_RATIO = 2.4;
export const NEURAL_HUB_DEGREE = 6;
export function neuralRootRatio(degree: number): number { return degree >= NEURAL_HUB_DEGREE ? 2.6 : 1.8; }
export function neuralRootWidthPx(ordinaryPx: number, somaRadiusPx: number, ratio: number): number {
  return somaRadiusPx > 0 ? Math.max(0, ordinaryPx) * ratio : Math.max(0, ordinaryPx);
}
/** Visible roots borrow width from the local soma, while the cap prevents crowded hubs merging. */
export function neuralJoinedRootWidthPx(ordinaryPx: number, somaRadiusPx: number, ratio: number): number {
  const ordinary = Math.max(0, ordinaryPx);
  if (somaRadiusPx <= 0) return ordinary;
  return Math.max(neuralRootWidthPx(ordinary, somaRadiusPx, ratio),
    Math.min(somaRadiusPx * 1.1, ordinary * 6));
}
// D084-W2-NEURAL: the former cosmetic close-up sprout flag is removed — no decorative
// filament may fake a relation that the graph does not draw.
export function neuralShoulderFraction(spanPx: number, somaRadiusPx: number, ordinaryPx: number): number {
  const shoulderPx = Math.min(48, Math.max(12, somaRadiusPx * 2.5 + ordinaryPx * 3));
  return Math.min(NEURAL_TAPER_FRACTION, shoulderPx / Math.max(spanPx, 1));
}
export function neuralScreenWidthAt(t: number, ordinaryPx: number, startSomaRadiusPx: number,
  endSomaRadiusPx: number, taper: readonly [number, number] = [NEURAL_ROOT_RATIO, NEURAL_ROOT_RATIO],
  spanPx = 100, joinedRoots: boolean | readonly [boolean, boolean] = false): number {
  const body = Math.max(0, ordinaryPx);
  const joined = typeof joinedRoots === "boolean" ? [joinedRoots, joinedRoots] : joinedRoots;
  const start = (joined[0] ? neuralJoinedRootWidthPx : neuralRootWidthPx)(body, startSomaRadiusPx, taper[0]);
  const end = (joined[1] ? neuralJoinedRootWidthPx : neuralRootWidthPx)(body, endSomaRadiusPx, taper[1]);
  const ease = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };
  const position = Math.max(0, Math.min(1, t));
  const startShoulder = neuralShoulderFraction(spanPx, startSomaRadiusPx, body);
  const endShoulder = neuralShoulderFraction(spanPx, endSomaRadiusPx, body);
  if (position < startShoulder) return body + (start - body) * (1 - ease(position / startShoulder));
  if (position > 1 - endShoulder) return body + (end - body) * (1 - ease((1 - position) / endShoulder));
  return body;
}
/** Mycelium wave bound: a visibility floor for tiny links and a hard cap so no arc leaves the field. */
export const MYCELIUM_AMPLITUDE_MIN_PX = 2.5;
export const MYCELIUM_AMPLITUDE_CAP_PX = 48;
/** Bounded radial deviation of a soma outline away from its ellipse (fraction of the local radius).
 * Large somata reach the full bound; small somata are drawn with a scaled-down irregularity so the
 * organic shape stays visible at overview without deforming tiny cells. */
export const SOMA_OUTLINE_MAX_RADIAL = 0.12;
// D084-W2-NEURAL-R3: only Neural tightens its body harmonics; Canopy keeps its outline.
export const NEURAL_SOMA_OUTLINE_MAX_RADIAL = 0.06;

// D081-P1E BEGIN: pure lobe profile shared by the canvas and GPU buffer builder.
export type SomaLobe = { readonly angle: number; readonly strength: number };
// D081-P1F BEGIN: a taller, narrower shoulder keeps the prior soma area while exposing its tip.
export const NEURAL_LOBE_ANGULAR_WIDTH = 0.32;
// D084-W2-NEURAL BEGIN: the soma stays a compact, irregular body — never an egg, drop or
// spike. The visible process is the thick root; the lobe only rounds the shoulder where the
// root leaves the body, so every strength stays below the narrow-lobe threshold and each
// shoulder stays broad (somaLobeAngularWidth 0.62).
export function neuralLobeStrength(weight: number, maximum: number): number {
  return 0.04 + 0.04 * Math.sqrt(weight / Math.max(1, maximum));
}
/** Shared paint strength: a bundled root has one broad shoulder rather than several tips. */
export function neuralTrunkLobeStrength(trunk: NeuralTrunk, maximum: number, degree: number): number {
  const dominant = Math.sqrt(trunk.weight / Math.max(1, maximum));
  const base = trunk.edgeIds.length > 1 ? 0.06 + 0.03 * dominant : neuralLobeStrength(trunk.weight, maximum);
  return degree >= NEURAL_HUB_DEGREE ? Math.max(0.04, base - 0.015) : base;
}
// D084-W2-NEURAL END
export function somaLobeAngularWidth(strength: number): number {
  return strength > 0.6 ? NEURAL_LOBE_ANGULAR_WIDTH : 0.62;
}
// D081-P1F END
export function somaLobeAreaScale(lobes: readonly SomaLobe[],
  baseRadiusAtAngle: (angle: number) => number = () => 1): number {
  if (!lobes.length) return 1;
  let before = 0, after = 0;
  for (let i = 0; i < 64; i++) {
    const angle = 2 * Math.PI * i / 64;
    const extension = (old: boolean) => Math.max(0, ...lobes.map(lobe => {
      const delta = Math.atan2(Math.sin(angle - lobe.angle), Math.cos(angle - lobe.angle));
      // D081-P1F: compare area with the P1e shoulder (its packed strength was 0.36 lower).
      const lowDegree = lobe.strength > 0.6;
      const strength = old ? 0.12 + 1.8 * (lobe.strength - (lowDegree ? 0.70 : 0.34)) : lobe.strength;
      return strength * Math.exp(-0.5 * (delta / (old ? 0.34 : somaLobeAngularWidth(lobe.strength))) ** 2);
    }));
    const baseArea = baseRadiusAtAngle(angle) ** 2;
    before += baseArea * (1 + extension(true)) ** 2;
    after += baseArea * (1 + extension(false)) ** 2;
  }
  return Math.sqrt(before / after);
}
export function somaLobeFactor(lobes: readonly SomaLobe[], angle: number,
  areaScale = somaLobeAreaScale(lobes)): number {
  let extension = 0;
  for (const lobe of lobes) {
    const delta = Math.atan2(Math.sin(angle - lobe.angle), Math.cos(angle - lobe.angle));
    const shoulder = Math.exp(-0.5 * (delta / somaLobeAngularWidth(lobe.strength)) ** 2);
    extension = Math.max(extension, lobe.strength * shoulder);
  }
  return (1 + extension) * areaScale;
}
// D081-P1E END

const SOMA_OUTLINE_ORDERS = [2, 3, 4] as const;
/** Deterministic per-node low-frequency outline harmonics, so no two somata are identical. */
export function somaOutlineHarmonics(id: string): readonly SomaOutlineHarmonic[] {
  const seed = morphologyHash(id);
  return SOMA_OUTLINE_ORDERS.map((order, index) => {
    const raw = ((seed >>> (index * 8)) & 0xff) / 255;
    return { order, amplitude: 0.012 + raw * 0.022, phase: ((seed >>> (index * 5)) % 6283) / 1000 };
  });
}
/** Stable angular clustering. Each real drawn edge belongs to one bundle; the strongest three
 * drive the outline, while the complete set remains available for endpoint placement. */
export function neuralAngularBundles(incident: readonly { id: string; direction: Coordinates; weight: number }[]): readonly NeuralBundle[] {
  const candidates = incident.filter(item => norm(item.direction) > 1e-9)
    .map(item => ({ ...item, direction: unit(item.direction), weight: Math.max(0, item.weight) }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const groups: { members: typeof candidates; sum: Coordinates; weight: number }[] = [];
  for (const item of candidates) {
    let best = -1, bestAlignment = Math.cos(Math.PI / 6);
    for (let i = 0; i < groups.length; i++) {
      const alignment = dot(item.direction, unit(groups[i]!.sum));
      if (alignment > bestAlignment + 1e-12) { best = i; bestAlignment = alignment; }
    }
    if (best < 0) groups.push({ members: [item], sum: mul(item.direction, item.weight || 1), weight: item.weight });
    else {
      const group = groups[best]!;
      group.members.push(item);
      group.sum = add(group.sum, mul(item.direction, item.weight || 1));
      group.weight += item.weight;
    }
  }
  return groups.map(group => ({ direction: unit(group.sum), weight: group.weight,
    edgeIds: group.members.map(item => item.id).sort() }))
    .sort((a, b) => b.weight - a.weight || a.edgeIds[0]!.localeCompare(b.edgeIds[0]!));
}
/** One root per real angular bundle. The five-root budget is also the previous trunk budget;
 * extra directions attach to their nearest principal root without adding a graph relation. */
export function neuralBroadTrunks(members: readonly TrunkMember[]): readonly NeuralTrunk[] {
  const sorted = members.filter(member => member.length > 1e-6)
    .map(member => ({ ...member, direction: unit(member.direction),
      weight: Math.max(0.01, member.weight) }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const groups: { sum: Coordinates; edgeIds: string[]; weight: number; shortest: number }[] = [];
  for (const member of sorted) {
    let nearest = -1, alignment = -Infinity;
    for (let index = 0; index < groups.length; index++) {
      const score = dot(member.direction, unit(groups[index]!.sum));
      if (score > alignment) { nearest = index; alignment = score; }
    }
    if (alignment <= Math.cos(Math.PI / 6) && groups.length < 5) {
      groups.push({ sum: mul(member.direction, member.weight), edgeIds: [member.id],
        weight: member.weight, shortest: member.length });
    } else {
      const group = groups[nearest]!;
      group.sum = add(group.sum, mul(member.direction, member.weight));
      group.edgeIds.push(member.id);
      group.weight += member.weight;
      group.shortest = Math.min(group.shortest, member.length);
    }
  }
  return groups.map(group => {
    const edgeIds = group.edgeIds.sort();
    return { direction: unit(group.sum), edgeIds, weight: group.weight,
      branchDistance: Math.min(48, Math.max(2, group.shortest * 0.22), group.shortest * 0.4),
      rootWidthFactor: edgeIds.length === 1 ? 1 : Math.min(4, 2.4 + 0.4 * Math.log2(edgeIds.length)) };
  }).sort((a, b) => b.weight - a.weight || a.edgeIds[0]!.localeCompare(b.edgeIds[0]!));
}
/** Select three spatially spread lobes for the fixed GPU slots, then the canvas uses the same set. */
export function neuralPrincipalTrunks(trunks: readonly NeuralTrunk[]): readonly NeuralTrunk[] {
  if (trunks.length <= 3) return trunks;
  const chosen = [trunks[0]!];
  while (chosen.length < 3) {
    const next = trunks.filter(trunk => !chosen.includes(trunk)).sort((a, b) =>
      Math.max(...chosen.map(other => dot(a.direction, other.direction)))
      - Math.max(...chosen.map(other => dot(b.direction, other.direction)))
      || b.weight - a.weight || a.edgeIds[0]!.localeCompare(b.edgeIds[0]!))[0];
    if (!next) break;
    chosen.push(next);
  }
  return chosen;
}
/** Low order, bounded lobes from the actual incident directions, in the soma axis frame.
 * Width weights make a dominant bundle pull the outline toward itself. */
export function incidentSomaHarmonics(axis: Coordinates, incident: readonly { direction: Coordinates; weight: number }[]): readonly SomaOutlineHarmonic[] {
  const axisAngle = Math.atan2(axis.y, axis.x);
  const primary = incident.slice(0, 3);
  const total = primary.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  return [1, 2, 3].map((order): SomaOutlineHarmonic => {
    if (total <= 0) return { order, amplitude: 0, phase: 0 };
    let x = 0, y = 0;
    for (const item of primary) {
      const angle = Math.atan2(item.direction.y, item.direction.x) - axisAngle;
      const weight = Math.max(0, item.weight) / total;
      x += weight * Math.cos(order * angle);
      y += weight * Math.sin(order * angle);
    }
    // The broad primary lobe gives a leaf its teardrop shoulder; the weaker terms describe
    // secondary real bundles without making a dense hub spiky. Their total remains below 0.12.
    const maximum = order === 1 ? 0.088 : order === 2 ? 0.021 : 0.010;
    return { order, amplitude: maximum * Math.hypot(x, y), phase: -Math.atan2(y, x) };
  });
}
/** Radial outline deviation in [−SOMA_OUTLINE_MAX_RADIAL, SOMA_OUTLINE_MAX_RADIAL] at ellipse parameter angle θ. */
export function somaOutlineIrregularity(harmonics: readonly SomaOutlineHarmonic[], theta: number): number {
  let value = 0;
  for (const harmonic of harmonics) value += harmonic.amplitude * Math.cos(harmonic.order * theta + harmonic.phase);
  return value;
}
function somaAxis(node: MorphologyNodeInput, incident: readonly { point: Coordinates; weight: number }[]): { axis: Coordinates; eccentricity: number } {
  const vectors = incident.map(item => ({ vector: unit(sub(item.point, node.position)), weight: Math.max(0, item.weight) }))
    .filter(item => norm(item.vector) > 0);
  if (!vectors.length) return { axis: { x: 1, y: 0, z: 0 }, eccentricity: 1 };
  const weighted = vectors.some(item => item.weight > 0);
  const totalWeight = weighted ? vectors.reduce((sum, item) => sum + item.weight, 0) : vectors.length;
  const moment = (component: (vector: Coordinates) => number) => vectors.reduce((sum, item) =>
    sum + component(item.vector) * (weighted ? item.weight : 1), 0) / totalWeight;
  const xx = moment(u => u.x * u.x);
  const xy = moment(u => u.x * u.y);
  const xz = moment(u => u.x * u.z);
  const yy = moment(u => u.y * u.y);
  const yz = moment(u => u.y * u.z);
  const zz = moment(u => u.z * u.z);
  let axis: Coordinates = xx >= yy && xx >= zz ? { x: 1, y: 0, z: 0 } : yy >= zz ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  for (let i = 0; i < 14; i++) axis = unit({ x: xx * axis.x + xy * axis.y + xz * axis.z, y: xy * axis.x + yy * axis.y + yz * axis.z, z: xz * axis.x + yz * axis.y + zz * axis.z });
  if (axis.x < 0 || (axis.x === 0 && axis.y < 0) || (axis.x === 0 && axis.y === 0 && axis.z < 0)) axis = mul(axis, -1);
  const lambda = moment(u => dot(u, axis) ** 2);
  const squareTrace = xx * xx + yy * yy + zz * zz + 2 * (xy * xy + xz * xz + yz * yz);
  const rest = 1 - lambda;
  const second = (rest + Math.sqrt(Math.max(0, 2 * (squareTrace - lambda * lambda) - rest * rest))) / 2;
  return { axis, eccentricity: Math.min(1.32, Math.max(1.04, 1.04 + 0.28 * (lambda - second))) };
}
function somaRadius(node: MorphologyNodeShape, direction: Coordinates): number {
  const alignment = dot(node.axis, direction);
  const major = node.radius * node.eccentricity;
  return 1 / Math.sqrt((alignment / major) ** 2 + (1 - alignment ** 2) / node.radius ** 2);
}
function segment(id: string, edgeId: string, a: Coordinates, b: Coordinates, widthStart: number, widthEnd: number,
  morphology: Morphology, curvature: number, sharedKey: string | null = null, startInset = 0, endInset = 0,
  widthMid = (widthStart + widthEnd) / 2): MorphologySegment {
  const contract = MORPHOLOGY_CONTRACT[morphology].edge;
  const direction = unit(sub(b, a));
  const source = add(a, mul(direction, startInset));
  const target = add(b, mul(direction, -endInset));
  const length = norm(sub(target, source));
  const seed = morphologyHash(sharedKey ?? id);
  const sign = seed & 1 ? 1 : -1;
  const sideways = normal(source, target);
  const samples: Coordinates[] = [];
  let control = mix(source, target, 0.5);
  if (contract.path === "straight" || length < 1e-5) samples.push(source, target);
  else if (contract.path === "soft-curve") {
    const amplitude = sign * (contract.amplitude[0] + (seed % 9) / 8 * (contract.amplitude[1] - contract.amplitude[0])) * curvature * length;
    const c1 = add(mix(source, target, 0.27), mul(sideways, 0));
    const c2 = add(mix(source, target, 0.73), mul(sideways, amplitude * 2.2));
    control = c1;
    for (let i = 0; i <= 20; i++) samples.push(cubic(source, c1, c2, target, i / 20));
  } else {
    // Waviness is bounded relative to the link length (no gigantic arcs) and by a fixed pixel cap (nothing
    // leaves the field), with a small floor so even the shortest hyphae keep a visible, regular wave.
    const ratio = contract.amplitude[0] + (seed % 13) / 12 * (contract.amplitude[1] - contract.amplitude[0]);
    const planarLength = Math.hypot(target.x - source.x, target.y - source.y);
    const amplitude = Math.min(MYCELIUM_AMPLITUDE_CAP_PX, Math.max(MYCELIUM_AMPLITUDE_MIN_PX, ratio * planarLength)) * curvature;
    const periods = contract.periods[0];
    const count = length < 45 ? 16 : 40;
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const envelope = Math.sin(Math.PI * t) ** 2;
      const wave = Math.sin(2 * Math.PI * periods * t);
      samples.push(add(mix(source, target, t), mul(sideways, sign * amplitude * envelope * wave)));
    }
    control = samples[1]!;
  }
  return { id, edgeId, source, target, control, samples, widthStart, widthEnd, widthMid, sharedKey,
    curvature: contract.path === "straight" ? 0 : curvature, path: contract.path };
}

const neuralGeometryCache = new WeakMap<readonly MorphologyNodeInput[], WeakMap<readonly MorphologyEdgeInput[], Map<number, MorphologyGeometry>>>();
/** Build paths once per drawn subset and curvature. No camera-dependent aesthetic input. */
export function buildMorphologyGeometry(morphology: Morphology, nodes: readonly MorphologyNodeInput[], edges: readonly MorphologyEdgeInput[],
  colonies: readonly MorphologyColonyInput[] = [], curvature = 1, containers: readonly MorphologyContainerInput[] = []): MorphologyGeometry {
  const cached = morphology === "neural" && !colonies.length && !containers.length
    ? neuralGeometryCache.get(nodes)?.get(edges)?.get(curvature) : undefined;
  if (cached) return cached;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incident = new Map(nodes.map(node => [node.id, [] as { id: string; point: Coordinates; weight: number }[]]));
  for (const edge of edges) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (!a || !b) throw new TypeError(`morphology edge ${edge.id} lacks an endpoint`);
    incident.get(a.id)!.push({ id: edge.id, point: b.position, weight: edge.width });
    incident.get(b.id)!.push({ id: edge.id, point: a.position, weight: edge.width });
  }
  const shaped = nodes.map((node): MorphologyNodeShape => {
    const connections = incident.get(node.id)!.sort((a, b) => a.id.localeCompare(b.id));
    const trunks = morphology === "neural" ? neuralBroadTrunks(connections.map(item => ({
      id: item.id, direction: sub(item.point, node.position),
      length: norm(sub(item.point, node.position)), weight: item.weight,
    }))) : [];
    // Small bundles share one broad proximal stem and split once beyond it. Recursive
    // subdivision here created the short comb seen in the reference close-up and cost more.
    const arbors: readonly NeuralBranch[] = morphology === "neural" ? trunks.map(trunk =>
      connections.length < 8
        ? { edgeIds: trunk.edgeIds, direction: trunk.direction, distance: trunk.branchDistance,
          depth: 0, widthFactor: trunk.rootWidthFactor, children: [] }
        : arborizeNeuralTrunk(trunk, connections.map(item => ({ id: item.id,
          direction: sub(item.point, node.position),
          length: norm(sub(item.point, node.position)), weight: item.weight })))) : [];
    const bundles = morphology === "neural" ? neuralAngularBundles(connections.map(item => ({
      id: item.id, direction: sub(item.point, node.position), weight: item.weight,
    }))) : [];
    const covarianceShape = somaAxis(node, connections);
    // D084-W2-NEURAL BEGIN: the neural soma is a compact, irregular body. It never
    // elongates on its own (eccentricity stays 1; the retired spindle and the hub floor
    // made every connected soma a long pointed ellipse). Elongation exists only where a
    // real edge leaves: the moderate lobes and the thick root in the trunk directions.
    // The axis still follows the strongest real trunk so the outline harmonics stay stable.
    const axisShape = morphology === "neural" && trunks.length
      ? { ...covarianceShape, axis: trunks[0]!.direction, eccentricity: 1 } : covarianceShape;
    return { ...node, degree: connections.length, ...axisShape,
      bundles, trunks, arbors,
      spindleRatio: undefined,
      rootRatio: neuralRootRatio(connections.length),
      haloRadiusRatio: NEURAL_HALO_MAX_RADIUS_RATIO, haloAlphaLimit: NEURAL_HALO_MAX_ALPHA,
      outline: morphology === "neural" ? incidentSomaHarmonics(axisShape.axis, trunks) : somaOutlineHarmonics(node.id) };
  });
  const shapes = new Map(shaped.map(node => [node.id, node]));
  const colonyByNode = new Map<string, MorphologyColonyInput>();
  for (const colony of [...colonies].sort((a, b) => a.id.localeCompare(b.id)))
    for (const id of colony.members) if (!colonyByNode.has(id)) colonyByNode.set(id, colony);
  const routed = edges.map(edge => {
    const a = shapes.get(edge.source)!, b = shapes.get(edge.target)!;
    const direction = unit(sub(b.position, a.position));
    const insetA = morphology === "neural" ? Math.min(somaRadius(a, direction), norm(sub(b.position, a.position)) * 0.2) : 0;
    const insetB = morphology === "neural" ? Math.min(somaRadius(b, direction), norm(sub(b.position, a.position)) * 0.2) : 0;
    if (morphology === "stellar") return { id: edge.id, source: edge.source, target: edge.target, segments: [segment(edge.id, edge.id, a.position, b.position, edge.width, edge.width, morphology, 0)] };
    if (morphology === "neural") {
      const proximal = a.degree >= b.degree;
      const startTrunk = a.trunks?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edge.id));
      const endTrunk = b.trunks?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edge.id));
      const original = segment(edge.id, edge.id, a.position, b.position,
        edge.width * (proximal ? NEURAL_TAPER.proximal : NEURAL_TAPER.distal),
        edge.width * (proximal ? NEURAL_TAPER.distal : NEURAL_TAPER.proximal),
        morphology, curvature, null, insetA, insetB, edge.width * NEURAL_TAPER.mid);
      const sourceBranches = startTrunk && startTrunk.edgeIds.length > 1 && a.arbors
        ? neuralBranchRoute(a.arbors.find(root => root.edgeIds.includes(edge.id))!, edge.id) : [];
      const targetBranches = endTrunk && endTrunk.edgeIds.length > 1 && b.arbors
        ? neuralBranchRoute(b.arbors.find(root => root.edgeIds.includes(edge.id))!, edge.id) : [];
      if (!sourceBranches.length && !targetBranches.length)
        return { id: edge.id, source: edge.source, target: edge.target, segments: [original] };
      const anchors: Coordinates[] = [startTrunk && startTrunk.edgeIds.length > 1
        ? add(a.position, mul(startTrunk.direction, somaRadius(a, startTrunk.direction))) : original.source];
      for (const branch of sourceBranches) anchors.push(add(a.position, mul(branch.direction, branch.distance)));
      for (const branch of [...targetBranches].reverse()) anchors.push(add(b.position, mul(branch.direction, branch.distance)));
      anchors.push(endTrunk && endTrunk.edgeIds.length > 1
        ? add(b.position, mul(endTrunk.direction, somaRadius(b, endTrunk.direction))) : original.target);
      const samples: Coordinates[] = [];
      for (let section = 0; section < anchors.length - 1; section++) {
        const p0 = anchors[section]!, p1 = anchors[section + 1]!;
        const span = norm(sub(p1, p0));
        const incoming = section === 0 || section === 1 && sourceBranches.length > 0
          ? unit(sub(anchors[1]!, anchors[0]!)) : unit(sub(p1, anchors[section - 1]!));
        const outgoing = section === 0 || section + 2 >= anchors.length
          ? unit(sub(p1, p0)) : unit(sub(anchors[section + 2]!, p0));
        const c1 = add(p0, mul(incoming, span * 0.34));
        const c2 = add(p1, mul(outgoing, -span * 0.34));
        const terminal = !targetBranches.length && section === anchors.length - 2;
        const sway = terminal ? Math.min(8, span * 0.075) * curvature : 0;
        const phase = (morphologyHash(edge.id) % 6283) / 1000;
        const sideways = normal(p0, p1);
        // One low-degree shared stem and one terminal curve use the same 17-sample
        // budget as the former single edge; dense recursive arbors keep their detail.
        const compactRoot = (startTrunk && a.degree < 8) || (endTrunk && b.degree < 8);
        const steps = compactRoot ? 8 : terminal ? 15 : 10;
        for (let j = section === 0 ? 0 : 1; j <= steps; j++) {
          const t = j / steps;
          const point = cubic(p0, c1, c2, p1, t);
          samples.push(add(point, mul(sideways, sway * Math.sin(Math.PI * t) ** 2
            * Math.sin(2 * Math.PI * t + phase))));
        }
      }
      return { id: edge.id, source: edge.source, target: edge.target, segments: [{ ...original,
        source: samples[0]!, target: samples[samples.length - 1]!, samples,
        trunkSourceCount: startTrunk?.edgeIds.length ?? 1,
        trunkTargetCount: endTrunk?.edgeIds.length ?? 1,
        trunkSourceWidthFactor: startTrunk?.rootWidthFactor,
        trunkTargetWidthFactor: endTrunk?.rootWidthFactor,
        sourceBranches, targetBranches }] };
    }
    const sourceColony = colonyByNode.get(a.id), targetColony = colonyByNode.get(b.id);
    const branched = Boolean(sourceColony && sourceColony.id === targetColony?.id);
    return { id: edge.id, source: edge.source, target: edge.target,
      segments: myceliumParts(edge, a.position, b.position, curvature, branched) };
  });
  const drawnSegments = routed.flatMap(edge => edge.segments);
  // A junction is a real graph node with at least three incident edges; decorative markers never
  // invent off-edge branch points or a colony-centre detour.
  const branchPoints = morphology === "mycelium"
    ? shaped.filter(node => node.degree >= 3).map(node => node.position) : [];
  const result = { morphology, nodes: shaped, edges: routed, drawnSegments, branchPoints, containers: buildContainerGeometry(morphology, containers), colonies };
  if (morphology === "neural" && !colonies.length && !containers.length) {
    let byEdges = neuralGeometryCache.get(nodes);
    if (!byEdges) { byEdges = new WeakMap(); neuralGeometryCache.set(nodes, byEdges); }
    let byCurvature = byEdges.get(edges);
    if (!byCurvature) { byCurvature = new Map(); byEdges.set(edges, byCurvature); }
    byCurvature.set(curvature, result);
  }
  return result;
}
