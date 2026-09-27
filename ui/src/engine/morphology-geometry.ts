import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";

export type MorphologyNodeInput = { readonly id: string; readonly position: Coordinates; readonly radius: number };
export type MorphologyEdgeInput = { readonly id: string; readonly source: string; readonly target: string; readonly width: number };
export type MorphologyColonyInput = { readonly id: string; readonly members: readonly string[]; readonly center: Coordinates };
export type MorphologyNodeShape = MorphologyNodeInput & { readonly degree: number; readonly dendriteAngles: readonly number[] };
export type MorphologySegment = {
  readonly id: string;
  readonly edgeId: string;
  readonly source: Coordinates;
  readonly control: Coordinates;
  readonly target: Coordinates;
  /** Curve samples are resolved once at layout time; a camera redraw only projects them. */
  readonly samples: readonly Coordinates[];
  readonly widthStart: number;
  readonly widthEnd: number;
  readonly sharedKey: string | null;
  readonly curvature: number;
};
export type MorphologyGeometry = {
  readonly morphology: Morphology;
  readonly nodes: readonly MorphologyNodeShape[];
  readonly edges: readonly { readonly id: string; readonly segments: readonly MorphologySegment[] }[];
  readonly drawnSegments: readonly MorphologySegment[];
  readonly branchPoints: readonly Coordinates[];
};

/** Stable FNV-1a seed; no frame-time random choice enters geometry. */
export function morphologyHash(id: string): number {
  let value = 2166136261;
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

const midpoint = (a: Coordinates, b: Coordinates): Coordinates => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const mix = (a: Coordinates, b: Coordinates, t: number): Coordinates => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const distance = (a: Coordinates, b: Coordinates): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function bent(a: Coordinates, b: Coordinates, amount: number): Coordinates {
  const middle = midpoint(a, b);
  return { x: middle.x - (b.y - a.y) * amount, y: middle.y + (b.x - a.x) * amount, z: middle.z };
}
function quadratic(source: Coordinates, control: Coordinates, target: Coordinates, t: number): Coordinates {
  const s = 1 - t;
  return {
    x: s * s * source.x + 2 * s * t * control.x + t * t * target.x,
    y: s * s * source.y + 2 * s * t * control.y + t * t * target.y,
    z: s * s * source.z + 2 * s * t * control.z + t * t * target.z,
  };
}
function segment(id: string, edgeId: string, source: Coordinates, target: Coordinates, widthStart: number, widthEnd: number, curvature: number, sharedKey: string | null = null): MorphologySegment {
  const control = bent(source, target, curvature);
  const samples = curvature === 0 ? [source, target] : Array.from({ length: 13 }, (_, index) => quadratic(source, control, target, index / 12));
  return { id, edgeId, source, target, control, samples, widthStart, widthEnd, curvature, sharedKey };
}

/** Build paths once per layout. Shared-key trunks are drawn once at a usage-dependent width. */
export function buildMorphologyGeometry(
  morphology: Morphology,
  nodes: readonly MorphologyNodeInput[],
  edges: readonly MorphologyEdgeInput[],
  colonies: readonly MorphologyColonyInput[] = [],
  curvature = 1,
): MorphologyGeometry {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const shaped = nodes.map((node): MorphologyNodeShape => {
    const count = degree.get(node.id) ?? 0;
    const lobes = morphology === "neural" && count >= 2 ? Math.min(9, 3 + Math.floor(count / 2)) : 0;
    const phase = (morphologyHash(node.id) / 4294967296) * Math.PI * 2;
    return { ...node, degree: count, dendriteAngles: Array.from({ length: lobes }, (_, index) => phase + index * Math.PI * 2 / lobes) };
  });
  const orderedColonies = [...colonies].sort((a, b) => a.id.localeCompare(b.id));
  const hubs = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const hubCount = Math.max(1, Math.min(hubs.length, Math.ceil(Math.sqrt(nodes.length) / 2)));
  const fallbackColonies = hubs.slice(0, hubCount).map((node) => ({ id: `hub:${node.id}`, members: [] as readonly string[], center: node.position }));
  const candidateColonies = orderedColonies.length > 0 ? orderedColonies : fallbackColonies;
  const colonyByNode = new Map<string, MorphologyColonyInput>();
  for (const colony of orderedColonies) for (const id of colony.members) if (!colonyByNode.has(id)) colonyByNode.set(id, colony);
  for (const node of nodes) {
    if (colonyByNode.has(node.id)) continue;
    const nearest = [...candidateColonies].sort((a, b) => distance(a.center, node.position) - distance(b.center, node.position) || a.id.localeCompare(b.id))[0];
    if (nearest) colonyByNode.set(node.id, nearest);
  }
  const routed = edges.map((edge) => {
    const source = byId.get(edge.source)?.position;
    const target = byId.get(edge.target)?.position;
    if (!source || !target) throw new TypeError(`morphology edge ${edge.id} lacks an endpoint`);
    const bendSign = (morphologyHash(edge.id) & 1) === 0 ? 1 : -1;
    if (morphology === "stellar") return { id: edge.id, segments: [segment(edge.id, edge.id, source, target, edge.width, edge.width, 0)] };
    if (morphology === "neural") {
      const proximalAtStart = (degree.get(edge.source) ?? 0) >= (degree.get(edge.target) ?? 0);
      const bend = bendSign * (0.085 + (morphologyHash(edge.id) % 7) * 0.006) * curvature;
      return { id: edge.id, segments: [segment(edge.id, edge.id, source, target, edge.width * (proximalAtStart ? 1.85 : 0.52), edge.width * (proximalAtStart ? 0.52 : 1.85), bend)] };
    }
    const sourceColony = colonyByNode.get(edge.source);
    const targetColony = colonyByNode.get(edge.target);
    if (!sourceColony || sourceColony.id !== targetColony?.id) {
      return { id: edge.id, segments: [segment(edge.id, edge.id, source, target, edge.width * 0.55, edge.width * 0.55, bendSign * 0.035 * curvature)] };
    }
    const core = sourceColony.center;
    const sourceJunction = mix(source, core, 0.24);
    const targetJunction = mix(target, core, 0.24);
    const irregular = (part: string): number => {
      const seed = morphologyHash(`${edge.id}:${part}`);
      return ((seed & 1) === 0 ? 1 : -1) * (0.025 + (seed % 11) * 0.004) * curvature;
    };
    return { id: edge.id, segments: [
      segment(`${edge.id}:source-tip`, edge.id, source, sourceJunction, edge.width * 0.5, edge.width * 0.72, irregular("source")),
      segment(`${edge.id}:source-trunk`, edge.id, sourceJunction, core, edge.width * 0.72, edge.width * 1.2, 0.04 * curvature * ((morphologyHash(edge.source) & 1) ? 1 : -1), `${sourceColony.id}:${edge.source}`),
      segment(`${edge.id}:target-trunk`, edge.id, core, targetJunction, edge.width * 1.2, edge.width * 0.72, 0.04 * curvature * ((morphologyHash(edge.target) & 1) ? -1 : 1), `${sourceColony.id}:${edge.target}`),
      segment(`${edge.id}:target-tip`, edge.id, targetJunction, target, edge.width * 0.72, edge.width * 0.5, irregular("target")),
    ] };
  });
  const usage = new Map<string, number>();
  for (const edge of routed) for (const part of edge.segments) if (part.sharedKey) usage.set(part.sharedKey, (usage.get(part.sharedKey) ?? 0) + 1);
  const drawn: MorphologySegment[] = [];
  const seen = new Set<string>();
  const branchPoints: Coordinates[] = [];
  const branchLocations = new Set<string>();
  const addBranch = (point: Coordinates): void => {
    const key = `${point.x}:${point.y}:${point.z}`;
    if (!branchLocations.has(key)) { branchLocations.add(key); branchPoints.push(point); }
  };
  for (const edge of routed) for (const part of edge.segments) {
    if (part.sharedKey && seen.has(part.sharedKey)) continue;
    if (part.sharedKey) {
      seen.add(part.sharedKey);
      const count = usage.get(part.sharedKey) ?? 1;
      drawn.push({ ...part, widthStart: part.widthStart * (1 + Math.log2(count) * 0.48), widthEnd: part.widthEnd * (1 + Math.log2(count) * 0.48) });
      if (count > 1) { addBranch(part.source); addBranch(part.target); }
    } else drawn.push(part);
  }
  return { morphology, nodes: shaped, edges: routed, drawnSegments: drawn, branchPoints };
}
