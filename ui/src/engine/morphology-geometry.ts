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
export type MorphologyNodeShape = MorphologyNodeInput & { readonly degree: number; readonly axis: Coordinates; readonly eccentricity: number };
export type MorphologySegment = {
  readonly id: string; readonly edgeId: string; readonly source: Coordinates; readonly control: Coordinates; readonly target: Coordinates;
  readonly samples: readonly Coordinates[]; readonly widthStart: number; readonly widthEnd: number; readonly sharedKey: string | null;
  readonly curvature: number; readonly path: "straight" | "soft-curve" | "wave";
};
export type MorphologyGeometry = {
  readonly morphology: Morphology; readonly nodes: readonly MorphologyNodeShape[];
  readonly edges: readonly { readonly id: string; readonly segments: readonly MorphologySegment[] }[];
  readonly drawnSegments: readonly MorphologySegment[]; readonly branchPoints: readonly Coordinates[];
  readonly containers: readonly MorphologyContainerPath[];
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
function somaAxis(node: MorphologyNodeInput, incident: readonly Coordinates[]): { axis: Coordinates; eccentricity: number } {
  const vectors = incident.map(point => unit(sub(point, node.position))).filter(vector => norm(vector) > 0);
  if (!vectors.length) return { axis: { x: 1, y: 0, z: 0 }, eccentricity: 1 };
  const xx = vectors.reduce((v, u) => v + u.x * u.x, 0) / vectors.length;
  const xy = vectors.reduce((v, u) => v + u.x * u.y, 0) / vectors.length;
  const xz = vectors.reduce((v, u) => v + u.x * u.z, 0) / vectors.length;
  const yy = vectors.reduce((v, u) => v + u.y * u.y, 0) / vectors.length;
  const yz = vectors.reduce((v, u) => v + u.y * u.z, 0) / vectors.length;
  const zz = vectors.reduce((v, u) => v + u.z * u.z, 0) / vectors.length;
  let axis: Coordinates = xx >= yy && xx >= zz ? { x: 1, y: 0, z: 0 } : yy >= zz ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  for (let i = 0; i < 14; i++) axis = unit({ x: xx * axis.x + xy * axis.y + xz * axis.z, y: xy * axis.x + yy * axis.y + yz * axis.z, z: xz * axis.x + yz * axis.y + zz * axis.z });
  if (axis.x < 0 || (axis.x === 0 && axis.y < 0) || (axis.x === 0 && axis.y === 0 && axis.z < 0)) axis = mul(axis, -1);
  const lambda = vectors.reduce((v, u) => v + dot(u, axis) ** 2, 0) / vectors.length;
  const squareTrace = xx * xx + yy * yy + zz * zz + 2 * (xy * xy + xz * xz + yz * yz);
  const rest = 1 - lambda;
  const second = (rest + Math.sqrt(Math.max(0, 2 * (squareTrace - lambda * lambda) - rest * rest))) / 2;
  return { axis, eccentricity: Math.min(1.7, Math.max(1, 1 + 0.7 * (lambda - second))) };
}
function somaRadius(node: MorphologyNodeShape, direction: Coordinates): number {
  const alignment = dot(node.axis, direction);
  const major = node.radius * node.eccentricity;
  return 1 / Math.sqrt((alignment / major) ** 2 + (1 - alignment ** 2) / node.radius ** 2);
}
function segment(id: string, edgeId: string, a: Coordinates, b: Coordinates, widthStart: number, widthEnd: number,
  morphology: Morphology, curvature: number, sharedKey: string | null = null, startInset = 0, endInset = 0): MorphologySegment {
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
    const amplitude = (contract.amplitude[0] + (seed % 13) / 12 * (contract.amplitude[1] - contract.amplitude[0])) * curvature * length;
    const periods = contract.periods[0] + ((seed >>> 4) % 11) / 10 * (contract.periods[1] - contract.periods[0]);
    const count = length < 45 ? 16 : 40;
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const envelope = Math.sin(Math.PI * t) ** 2;
      const wave = Math.sin(2 * Math.PI * periods * t + (seed % 7) * 0.13);
      samples.push(add(mix(source, target, t), mul(sideways, sign * amplitude * envelope * wave)));
    }
    control = samples[1]!;
  }
  return { id, edgeId, source, target, control, samples, widthStart, widthEnd, sharedKey,
    curvature: contract.path === "straight" ? 0 : curvature, path: contract.path };
}

/** Build paths once per layout or curvature change. No camera-dependent aesthetic input. */
export function buildMorphologyGeometry(morphology: Morphology, nodes: readonly MorphologyNodeInput[], edges: readonly MorphologyEdgeInput[],
  colonies: readonly MorphologyColonyInput[] = [], curvature = 1, containers: readonly MorphologyContainerInput[] = []): MorphologyGeometry {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incident = new Map(nodes.map(node => [node.id, [] as Coordinates[]]));
  for (const edge of edges) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (!a || !b) throw new TypeError(`morphology edge ${edge.id} lacks an endpoint`);
    incident.get(a.id)!.push(b.position); incident.get(b.id)!.push(a.position);
  }
  const shaped = nodes.map((node): MorphologyNodeShape => ({ ...node, degree: incident.get(node.id)!.length, ...somaAxis(node, incident.get(node.id)!) }));
  const shapes = new Map(shaped.map(node => [node.id, node]));
  const colonyByNode = new Map<string, MorphologyColonyInput>();
  for (const colony of [...colonies].sort((a, b) => a.id.localeCompare(b.id)))
    for (const id of colony.members) if (!colonyByNode.has(id)) colonyByNode.set(id, colony);
  const routed = edges.map(edge => {
    const a = shapes.get(edge.source)!, b = shapes.get(edge.target)!;
    const direction = unit(sub(b.position, a.position));
    const insetA = morphology === "neural" ? Math.min(somaRadius(a, direction), norm(sub(b.position, a.position)) * 0.2) : 0;
    const insetB = morphology === "neural" ? Math.min(somaRadius(b, direction), norm(sub(b.position, a.position)) * 0.2) : 0;
    if (morphology === "stellar") return { id: edge.id, segments: [segment(edge.id, edge.id, a.position, b.position, edge.width, edge.width, morphology, 0)] };
    if (morphology === "neural") {
      const proximal = a.degree >= b.degree;
      return { id: edge.id, segments: [segment(edge.id, edge.id, a.position, b.position, edge.width * (proximal ? 1.65 : 0.55),
        edge.width * (proximal ? 0.55 : 1.65), morphology, curvature, null, insetA, insetB)] };
    }
    const sourceColony = colonyByNode.get(a.id), targetColony = colonyByNode.get(b.id);
    if (targetColony?.id === a.id && norm(sub(a.position, targetColony.center)) > 1) {
      return { id: edge.id, segments: [
        segment(`${edge.id}:trunk`, edge.id, a.position, targetColony.center, edge.width * 1.1, edge.width * 1.35,
          morphology, curvature, `${targetColony.id}:parent-trunk`),
        segment(`${edge.id}:branch`, edge.id, targetColony.center, b.position, edge.width * 1.35, edge.width * 0.5,
          morphology, curvature),
      ] };
    }
    if (sourceColony?.id === b.id && norm(sub(b.position, sourceColony.center)) > 1) {
      return { id: edge.id, segments: [
        segment(`${edge.id}:branch`, edge.id, a.position, sourceColony.center, edge.width * 0.5, edge.width * 1.35,
          morphology, curvature),
        segment(`${edge.id}:trunk`, edge.id, sourceColony.center, b.position, edge.width * 1.35, edge.width * 1.1,
          morphology, curvature, `${sourceColony.id}:parent-trunk`),
      ] };
    }
    const colony = sourceColony;
    if (!colony || colony.id !== colonyByNode.get(b.id)?.id) {
      return { id: edge.id, segments: [segment(edge.id, edge.id, a.position, b.position, edge.width * 0.8, edge.width * 0.55, morphology, curvature)] };
    }
    const core = colony.center;
    const aj = mix(a.position, core, 0.24), bj = mix(b.position, core, 0.24);
    return { id: edge.id, segments: [
      segment(`${edge.id}:a`, edge.id, a.position, aj, edge.width * 0.5, edge.width * 0.8, morphology, curvature),
      segment(`${edge.id}:at`, edge.id, aj, core, edge.width * 0.8, edge.width * 1.15, morphology, curvature, `${colony.id}:${a.id}`),
      segment(`${edge.id}:bt`, edge.id, core, bj, edge.width * 1.15, edge.width * 0.8, morphology, curvature, `${colony.id}:${b.id}`),
      segment(`${edge.id}:b`, edge.id, bj, b.position, edge.width * 0.8, edge.width * 0.5, morphology, curvature),
    ] };
  });
  const usage = new Map<string, number>();
  for (const edge of routed) for (const part of edge.segments) if (part.sharedKey) usage.set(part.sharedKey, (usage.get(part.sharedKey) ?? 0) + 1);
  const seen = new Set<string>();
  const drawnSegments: MorphologySegment[] = [];
  const branchPoints: Coordinates[] = [];
  const branchSeen = new Set<string>();
  for (const edge of routed) for (const part of edge.segments) {
    if (part.sharedKey && seen.has(part.sharedKey)) continue;
    if (part.sharedKey) {
      seen.add(part.sharedKey);
      const load = 1 + 0.35 * Math.log2(usage.get(part.sharedKey) ?? 1);
      drawnSegments.push({ ...part, widthStart: part.widthStart * load, widthEnd: part.widthEnd * load });
      if (load > 1) for (const point of [part.source, part.target]) {
        const key = `${point.x}:${point.y}:${point.z}`;
        if (!branchSeen.has(key)) { branchSeen.add(key); branchPoints.push(point); }
      }
    } else drawnSegments.push(part);
  }
  return { morphology, nodes: shaped, edges: routed, drawnSegments, branchPoints, containers: buildContainerGeometry(morphology, containers) };
}
