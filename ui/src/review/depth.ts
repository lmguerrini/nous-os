import { maxOf, minOf } from '#render-common/array-aggregation.ts';
import type { Coordinates, VisualGraph } from "../engine/contract.ts";
/** Standard deviation of the normalised depth, as a share of the larger planar extent. */
const DEPTH_DEVIATION_SHARE = 0.1;
/** Depth is bounded softly at this many standard deviations. */
const DEPTH_SOFT_BOUND = 2.5;
/** Deterministic 1D relaxation over unchanged engine x/y anchors. */
export function relaxDepth(
  graph: Pick<VisualGraph, "nodes" | "edges">,
  planar: ReadonlyMap<string, Coordinates>,
  diagnostics?: { candidatePairs: number },
): ReadonlyMap<string, Coordinates> {
  const ids = graph.nodes.map((node) => node.id).sort();
  if (!ids.length) return new Map();
  const points = ids.map((id) => {
    const p = planar.get(id);
    if (!p) throw new TypeError(`missing anchor ${id}`);
    return p;
  });
  const extent = Math.max(
    1e-6,
    maxOf(points.map((p) => p.x)) - minOf(points.map((p) => p.x)),
    maxOf(points.map((p) => p.y)) - minOf(points.map((p) => p.y)),
  );
  const limit = extent * 0.35;
  const r0 = (extent / Math.sqrt(ids.length)) * 0.65;
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = graph.edges
    .map((e) => [index.get(e.source), index.get(e.target)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Linked nodes may sit close together; only unrelated neighbours in the plane are pushed apart in
  // depth, otherwise a hub surrounded by its own members is driven to the depth bound.
  const linked = new Set(links.map(([a, b]) => a * ids.length + b));
  // D081-P3c BEGIN: planar anchors never change during relaxation. Index the large
  // graph once, retaining ascending pair order so force accumulation stays stable.
  const neighbours: number[][] | null = ids.length > 1200 ? (() => {
    const cells = new Map<string, number[]>();
    const cellX = points.map(p => Math.floor(p.x / r0));
    const cellY = points.map(p => Math.floor(p.y / r0));
    for (let i = 0; i < ids.length; i++) {
      const key = `${cellX[i]},${cellY[i]}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(i);
      else cells.set(key, [i]);
    }
    return ids.map((_, a) => {
      const candidates: number[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get(`${cellX[a]! + dx},${cellY[a]! + dy}`);
        if (bucket) for (const b of bucket) if (b > a) candidates.push(b);
      }
      candidates.sort((a, b) => a - b);
      return candidates;
    });
  })() : null;
  // D081-P3c END
  if (diagnostics) diagnostics.candidatePairs = 0;
  let z = ids.map((id, i) => ((hash(id) % 2001) / 1000 - 1) * limit * 0.32 + (i % 2 ? 0.001 : -0.001));
  for (let iteration = 0; iteration < 120; iteration++) {
    const force = z.map((value) => -value * 0.014);
    for (const [a, b] of links) {
      const delta = (z[b]! - z[a]!) * 0.11;
      force[a]! += delta;
      force[b]! -= delta;
    }
    if (neighbours) for (let a = 0; a < ids.length; a++)
      for (const b of neighbours[a]!) {
        if (diagnostics) diagnostics.candidatePairs++;
        const dx = points[a]!.x - points[b]!.x;
        const dy = points[a]!.y - points[b]!.y;
        const xy = Math.hypot(dx, dy);
        if (xy >= r0 || linked.has(a * ids.length + b) || linked.has(b * ids.length + a)) continue;
        const dz = z[a]! - z[b]!;
        const distance = Math.hypot(xy, dz);
        if (distance >= r0) continue;
        const sign = dz === 0 ? (hash(ids[a]! + ids[b]!) % 2 ? 1 : -1) : Math.sign(dz);
        const push = ((r0 - distance) / r0) * limit * 0.032 * sign;
        force[a]! += push;
        force[b]! -= push;
      }
    else for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) {
        if (diagnostics) diagnostics.candidatePairs++;
        const dx = points[a]!.x - points[b]!.x;
        const dy = points[a]!.y - points[b]!.y;
        const xy = Math.hypot(dx, dy);
        if (xy >= r0 || linked.has(a * ids.length + b) || linked.has(b * ids.length + a)) continue;
        const dz = z[a]! - z[b]!;
        const distance = Math.hypot(xy, dz);
        if (distance >= r0) continue;
        const sign = dz === 0 ? (hash(ids[a]! + ids[b]!) % 2 ? 1 : -1) : Math.sign(dz);
        const push = ((r0 - distance) / r0) * limit * 0.032 * sign;
        force[a]! += push;
        force[b]! -= push;
      }
    z = z.map((value, i) => Math.max(-limit, Math.min(limit, value + force[i]!)));
  }
  // Normalise the relaxed depth: centred on its mean, spread to a fixed share of the planar extent,
  // and softly bounded, so a few crowded nodes cannot run to the clamp and read as a separate peak.
  const meanZ = z.reduce((sum, value) => sum + value, 0) / z.length;
  const deviation = Math.sqrt(z.reduce((sum, value) => sum + (value - meanZ) ** 2, 0) / z.length);
  const targetDeviation = extent * DEPTH_DEVIATION_SHARE;
  if (deviation > 0)
    z = z.map(
      (value) => targetDeviation * DEPTH_SOFT_BOUND * Math.tanh((value - meanZ) / deviation / DEPTH_SOFT_BOUND),
    );
  return new Map(ids.map((id, i) => [id, { x: points[i]!.x, y: points[i]!.y, z: z[i]! }]));
}
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
