import type { MorphologyGeometry, MorphologyNodeShape } from '../engine/morphology-geometry.ts';
import { SOMA_OUTLINE_MAX_RADIAL, somaOutlineIrregularity } from '../engine/morphology-geometry.ts';

type Point = Readonly<{ x: number; y: number }>;
// The geometry object is the layout/morphology version. Its identity changes on a
// genuine scene rebuild, while camera movement keeps the same prepared geometry.
const outlines = new WeakMap<MorphologyGeometry, Map<string, readonly Point[]>>();
// D082-B1f BEGIN: the Canopy worker prepares a compact, zoom-independent outline table.
const packedOutlines = new WeakMap<MorphologyGeometry, Float32Array>();
const packedIndices = new WeakMap<MorphologyGeometry, Map<string, number>>();
export function installCanopySomaOutlines(geometry: MorphologyGeometry, packed: Float32Array): void {
  if (packed.length !== geometry.nodes.length * 48) throw new Error('Canopy soma table length mismatch');
  packedOutlines.set(geometry, packed);
  packedIndices.set(geometry, new Map(geometry.nodes.map((node, index) => [node.id, index])));
}
export function cachedCanopySomaOutlinePacked(geometry: MorphologyGeometry, id: string): Float32Array | undefined {
  const index = packedIndices.get(geometry)?.get(id);
  const packed = packedOutlines.get(geometry);
  return index === undefined || !packed ? undefined : packed.subarray(index * 48, (index + 1) * 48);
}
export function canopySomataPrepared(geometry: MorphologyGeometry): boolean {
  return packedOutlines.has(geometry);
}
// D082-B1f END

export function cachedCanopySomaOutline(geometry: MorphologyGeometry, id: string):
  readonly Point[] | undefined { return outlines.get(geometry)?.get(id); }

/** Unit soma outline for an edge-free Canopy scene; screen position and size stay live. */
function somaPoints(node: MorphologyNodeShape): readonly Point[] {
  const rawEccentricity = node.eccentricity ?? 1;
  const harmonics = node.outline ?? [];
  const weighted = harmonics.reduce((sum, harmonic, index) => sum + harmonic.phase * (index + 1), 0);
  const elongation = harmonics.length ? 1 + 0.04 * Math.sin(weighted) : 1;
  const eccentricity = rawEccentricity <= 1 ? rawEccentricity
    : Math.max(Math.min(1.04, rawEccentricity), Math.min(1.32,
      rawEccentricity * elongation));
  const points: Point[] = [];
  for (let i = 0; i < 24; i++) {
    const theta = i * Math.PI / 12;
    const irregularity = Math.max(-SOMA_OUTLINE_MAX_RADIAL, Math.min(SOMA_OUTLINE_MAX_RADIAL,
      somaOutlineIrregularity(node.outline ?? [], theta) * 1.6));
    const radial = 1 + irregularity;
    points.push({ x: eccentricity * Math.cos(theta) * radial, y: Math.sin(theta) * radial });
  }
  return points;
}

export function canopySomaOutline(geometry: MorphologyGeometry,
  node: MorphologyNodeShape): readonly Point[] {
  let byNode = outlines.get(geometry);
  if (!byNode) { byNode = new Map(); outlines.set(geometry, byNode); }
  const cached = byNode.get(node.id);
  if (cached) return cached;
  const points = somaPoints(node);
  byNode.set(node.id, points);
  return points;
}

// D082-B1f BEGIN: only one transferable buffer crosses the worker boundary.
export function packCanopySomaOutlines(nodes: readonly MorphologyNodeShape[]): Float32Array {
  const result = new Float32Array(nodes.length * 48);
  nodes.forEach((node, index) => somaPoints(node).forEach((point, sample) => {
    result[index * 48 + sample * 2] = point.x;
    result[index * 48 + sample * 2 + 1] = point.y;
  }));
  return result;
}
// D082-B1f END
