import type { LabelReason, ViewportRect } from "./view-contract.ts";
export type LabelCandidate = {
  id: string;
  text: string;
  reason: LabelReason;
  x: number;
  y: number;
  priority: number;
  full?: boolean;
  /** Screen-space radius of the anchor node's disc; the label is offset outside it, never over it. */
  radius?: number;
};
export type PlacedLabel = { id: string; text: string; reason: LabelReason; rect: ViewportRect };

/** Hard ceiling on labels drawn in one state: selected, neighbours, hubs and focused communities first. */
export const LABEL_BUDGET = 60;

/** A sample of one anchor projected on screen, with its depth along the camera's view axis. */
export type DepthSample = { id: string; x: number; y: number; depth: number };

/**
 * Decide which anchors sit behind nearer geometry. An anchor is occluded when another anchor is
 * nearer (smaller depth) and its screen position overlaps the anchor's, so its label would float on
 * top of a surface it cannot belong to. Pure and feedable with synthetic depth data.
 */
export function occludedAnchors(samples: readonly DepthSample[], tolerancePx = 14, depthEps = 0.01): ReadonlySet<string> {
  const occluded = new Set<string>();
  for (const sample of samples) {
    for (const other of samples) {
      if (other.id === sample.id) continue;
      if (other.depth >= sample.depth - depthEps) continue;
      if (Math.hypot(other.x - sample.x, other.y - sample.y) < tolerancePx) {
        occluded.add(sample.id);
        break;
      }
    }
  }
  return occluded;
}

/**
 * Keep non-full labels distinct: a generic repeated title (e.g. several sources with the same short
 * name) gains a numeric suffix instead of printing the same words dozens of times. Selected and
 * hover labels always carry the complete text, so they are left untouched.
 */
export function disambiguateLabels(candidates: readonly LabelCandidate[]): LabelCandidate[] {
  const seen = new Map<string, number>();
  return candidates.map((candidate) => {
    if (candidate.full) return candidate;
    const count = seen.get(candidate.text) ?? 0;
    seen.set(candidate.text, count + 1);
    return count === 0 ? candidate : { ...candidate, text: `${candidate.text} · ${count + 1}` };
  });
}
const positions = [
  [8, -8],
  [8, 8],
  [-8, -8],
  [-8, 8],
  [0, -12],
  [0, 12],
  [12, 0],
  [-12, 0],
] as const;

/** True when an axis-aligned rect overlaps a node disc of the given radius around (cx, cy). */
function rectOverlapsDisc(
  rect: ViewportRect,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const nearestX = Math.min(Math.max(cx, rect.left), rect.left + rect.width);
  const nearestY = Math.min(Math.max(cy, rect.top), rect.top + rect.height);
  return (cx - nearestX) ** 2 + (cy - nearestY) ** 2 <= (radius + 2) ** 2;
}

/** Offsets that place the label just outside a node disc of the given radius, in eight directions. */
function discOffsets(radius: number): readonly [number, number][] {
  const m = radius + 6;
  const d = m * Math.SQRT1_2;
  return [
    [m, 0], [-m, 0], [0, -m], [0, m],
    [d, -d], [-d, -d], [d, d], [-d, d],
  ];
}
/** Prioritise selected and hovered labels before lower-priority labels compete for screen space. */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  bounds: ViewportRect,
  measure: (text: string, maxWidth: number, maxLines: number) => { width: number; height: number },
  reserved: readonly ViewportRect[] = [],
  budget: number = Number.POSITIVE_INFINITY,
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const cellSize = 64;
  const cells = new Map<string, PlacedLabel[]>();
  const keys = (left: number, top: number, right: number, bottom: number) => {
    const result: string[] = [];
    for (let x = Math.floor(left / cellSize); x <= Math.floor(right / cellSize); x++)
      for (let y = Math.floor(top / cellSize); y <= Math.floor(bottom / cellSize); y++)
        result.push(`${x}:${y}`);
    return result;
  };
  const priority = { hover: 6, selected: 5, neighbour: 4, domain: 3, main: 2, zoom: 1 };
  for (const c of [...candidates].sort(
    (a, b) => priority[b.reason] - priority[a.reason] || b.priority - a.priority || a.id.localeCompare(b.id),
  )) {
    if (placed.length >= budget) break;
    if (c.x < bounds.left || c.y < bounds.top || c.x > bounds.left + bounds.width || c.y > bounds.top + bounds.height)
      continue;
    const size = measure(c.text, c.full ? 280 : 180, c.reason === "selected" ? 2 : c.full ? 8 : 1);
    if (size.width > bounds.width || size.height > bounds.height) continue;
    const radius = Number.isFinite(c.radius) && (c.radius ?? 0) > 0 ? c.radius! : 0;
    const attempts = radius > 0 && c.reason !== "hover"
      ? discOffsets(radius)
      : c.reason === "hover" ? [[12, 12], [-12, 12], [12, -12], [-12, -12], ...positions] : positions;
    for (const [dx, dy] of attempts) {
      const left = c.x + dx + (dx < 0 ? -size.width : 0);
      const top = c.y + dy + (dy < 0 ? -size.height : 0);
      const rect = { left, top, width: size.width, height: size.height };
      if (
        left < bounds.left ||
        top < bounds.top ||
        left + size.width > bounds.left + bounds.width ||
        top + size.height > bounds.top + bounds.height
      )
        continue;
      if (radius > 0 && rectOverlapsDisc(rect, c.x, c.y, radius)) continue;
      const nearby = new Set(keys(left - 3, top - 3, left + size.width + 3, top + size.height + 3)
        .flatMap(key => cells.get(key) ?? []));
      if (
        [...nearby].some(
          (other) =>
            rect.left < other.rect.left + other.rect.width + 3 &&
            rect.left + rect.width + 3 > other.rect.left &&
            rect.top < other.rect.top + other.rect.height + 3 &&
            rect.top + rect.height + 3 > other.rect.top,
        )
        || reserved.some(other => rect.left < other.left + other.width + 3 && rect.left + rect.width + 3 > other.left
          && rect.top < other.top + other.height + 3 && rect.top + rect.height + 3 > other.top)
      )
        continue;
      const label = { id: c.id, text: c.text, reason: c.reason, rect };
      placed.push(label);
      for (const key of keys(left, top, left + size.width, top + size.height)) {
        const bucket = cells.get(key) ?? [];
        bucket.push(label);
        cells.set(key, bucket);
      }
      break;
    }
  }
  return placed;
}
