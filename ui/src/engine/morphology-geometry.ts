import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import type { MorphologyContainerInput, MorphologyContainerPath } from "#engine/container-geometry.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

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
  readonly rootRatio?: number;
  readonly haloRadiusRatio?: number; readonly haloAlphaLimit?: number;
};
export type MorphologySegment = {
  readonly id: string; readonly edgeId: string; readonly source: Coordinates; readonly control: Coordinates; readonly target: Coordinates;
  readonly samples: readonly Coordinates[]; readonly widthStart: number; readonly widthEnd: number; readonly widthMid: number; readonly sharedKey: string | null;
  readonly curvature: number; readonly path: "straight" | "soft-curve" | "wave";
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
/** Cosmetic sprouts only resolve in a true close-up; they are never graph segments. */
export function neuralDetailVisible(projectedScale: number, somaRadiusPx: number, spanPx: number): boolean {
  return projectedScale >= 1.75 && somaRadiusPx >= 5 && spanPx >= somaRadiusPx * 6;
}
export function neuralShoulderFraction(spanPx: number, somaRadiusPx: number, ordinaryPx: number): number {
  const shoulderPx = Math.min(48, Math.max(12, somaRadiusPx * 2.5 + ordinaryPx * 3));
  return Math.min(NEURAL_TAPER_FRACTION, shoulderPx / Math.max(spanPx, 1));
}
export function neuralScreenWidthAt(t: number, ordinaryPx: number, startSomaRadiusPx: number,
  endSomaRadiusPx: number, taper: readonly [number, number] = [NEURAL_ROOT_RATIO, NEURAL_ROOT_RATIO],
  spanPx = 100): number {
  const body = Math.max(0, ordinaryPx);
  const start = neuralRootWidthPx(body, startSomaRadiusPx, taper[0]);
  const end = neuralRootWidthPx(body, endSomaRadiusPx, taper[1]);
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
    const maximum = order === 1 ? 0.075 : order === 2 ? 0.028 : 0.017;
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

/** Build paths once per layout or curvature change. No camera-dependent aesthetic input. */
export function buildMorphologyGeometry(morphology: Morphology, nodes: readonly MorphologyNodeInput[], edges: readonly MorphologyEdgeInput[],
  colonies: readonly MorphologyColonyInput[] = [], curvature = 1, containers: readonly MorphologyContainerInput[] = []): MorphologyGeometry {
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
    const bundles = morphology === "neural" ? neuralAngularBundles(connections.map(item => ({
      id: item.id, direction: sub(item.point, node.position), weight: item.weight,
    }))) : [];
    const covarianceShape = somaAxis(node, connections);
    const axisShape = morphology === "neural" && bundles.length
      ? { ...covarianceShape, axis: bundles[0]!.direction,
        eccentricity: connections.length >= NEURAL_HUB_DEGREE
          ? Math.max(1.24, covarianceShape.eccentricity) : covarianceShape.eccentricity } : covarianceShape;
    return { ...node, degree: connections.length, ...axisShape,
      bundles, rootRatio: neuralRootRatio(connections.length),
      haloRadiusRatio: NEURAL_HALO_MAX_RADIUS_RATIO, haloAlphaLimit: NEURAL_HALO_MAX_ALPHA,
      outline: morphology === "neural" ? incidentSomaHarmonics(axisShape.axis, bundles) : somaOutlineHarmonics(node.id) };
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
      return { id: edge.id, source: edge.source, target: edge.target, segments: [segment(edge.id, edge.id, a.position, b.position,
        edge.width * (proximal ? NEURAL_TAPER.proximal : NEURAL_TAPER.distal),
        edge.width * (proximal ? NEURAL_TAPER.distal : NEURAL_TAPER.proximal),
        morphology, curvature, null, insetA, insetB, edge.width * NEURAL_TAPER.mid)] };
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
  return { morphology, nodes: shaped, edges: routed, drawnSegments, branchPoints, containers: buildContainerGeometry(morphology, containers), colonies };
}
