import type { Coordinates } from "../engine/contract.ts";
import type { ReviewExport } from "./model.ts";

function hash(value: string): number {
  let result = 2166136261;
  for (const letter of value) result = Math.imul(result ^ letter.charCodeAt(0), 16777619);
  return result >>> 0;
}

/**
 * Preserve supplied anchors and place each new id from its attested attachment, never from visual proximity.
 *
 * Distances are taken from the supplied layout itself: the engine lays graphs out in world units that can span
 * thousands, so a fixed offset would stack a new node on its parent or crowd unattached results at the origin.
 */
export function placeDynamic(
  anchors: ReadonlyMap<string, Coordinates>,
  data: Pick<ReviewExport, "nodes" | "edges">,
): ReadonlyMap<string, Coordinates> {
  const result = new Map(anchors);
  const original = [...anchors.values()];
  const { centre, extent } = frameOf(original);
  const spacing = Math.min(extent * 0.05, Math.max(extent * 0.012, medianNearestDistance(original)));
  const outerRadius = (id: string) => extent * (0.6 + 0.03 * (hash(id) % 4));
  const pending = data.nodes.filter((node) => !result.has(node.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (let pass = 0; pass < pending.length; pass++) {
    let changed = false;
    for (const node of pending) {
      if (result.has(node.id)) continue;
      const linked = data.edges.filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => edge.source === node.id ? edge.target : edge.source);
      const parent = linked.find((id) => anchors.has(id)) ?? linked.find((id) => result.has(id));
      if (!parent && node.type !== "candidate" && linked.some((id) => pending.some((other) => other.id === id))) continue;
      const angle = (hash(node.id) / 0x100000000) * 2 * Math.PI;
      if (parent) {
        const point = result.get(parent)!;
        const radius = spacing * (1.4 + (hash(`${node.id}:ring`) % 3));
        result.set(node.id, { x: point.x + radius * Math.cos(angle), y: point.y + radius * Math.sin(angle), z: point.z });
      } else {
        const radius = outerRadius(node.id);
        result.set(node.id, { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle), z: 0 });
      }
      changed = true;
    }
    if (!changed) break;
  }
  for (const node of pending) if (!result.has(node.id)) {
    const angle = (hash(node.id) / 0x100000000) * 2 * Math.PI;
    const radius = extent * 0.66;
    result.set(node.id, { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle), z: 0 });
  }
  return result;
}

/** Centre and larger side of the supplied layout's bounding box (1 when empty or degenerate). */
function frameOf(points: readonly Coordinates[]): { centre: Coordinates; extent: number } {
  if (!points.length) return { centre: { x: 0, y: 0, z: 0 }, extent: 1 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: 0 }, extent: Math.max(maxX - minX, maxY - minY) || 1 };
}

/** Median distance from each supplied point to its nearest neighbour in the plane. */
function medianNearestDistance(points: readonly Coordinates[]): number {
  if (points.length < 2) return 0;
  const nearest = points.map((point, index) => Math.min(...points
    .filter((_, other) => other !== index)
    .map((other) => Math.hypot(point.x - other.x, point.y - other.y))));
  const sorted = nearest.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
