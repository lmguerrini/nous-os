import type { LabelReason, ViewportRect } from "./view-contract.ts";
import { ellipsizeText, ellipsizeTextKeepCount } from "../render-common/container-canvas.ts";
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
  /** Tier 1 (the rule): a domain name in Flat, the selected or hovered node. Placed
   * first, and when no slot is clear of every pearl it takes the least-covered slot instead of
   * being dropped — a label over another node's pearl stays legible above it; under its own node,
   * under the panel or over another label it never sits. */
  tier1?: boolean;
};
export type PlacedLabel = { id: string; text: string; reason: LabelReason; rect: ViewportRect };

/** One projected obstacle a label must stay clear of: a pearl or soma disc (centre and radius). A
 * disc carrying the candidate's own id is skipped for that candidate: the label places itself by
 * its anchor radius, so its own (possibly enlarged) disc never rejects it. */
export type LabelDisc = { readonly x: number; readonly y: number; readonly radius: number; readonly id?: string };

/** Clear space kept between a label rectangle and any pearl or soma disc. */
export const PEARL_LABEL_MARGIN_PX = 3;

/** Hard ceiling on labels drawn in one state: selected, neighbours, hubs and focused communities first. */
export const LABEL_BUDGET = 60;

/** Clearance added to a node's drawn core radius when building its blocking disc: the disc is the
 * real footprint plus a little air, never a multiplier of the long half-axis (a neural soma's
 * elongation is drawn along its axis; the minor radius plus this clearance is the agreed bound). */
export const PEARL_DISC_CLEAR_PX = 2;

/** Second ring of anchor offsets, tried when every slot at the anchor's own rim is taken: a label
 * may sit a little further from its anchor instead of being dropped. */
export const LABEL_SECOND_RING_PX = 14;

/** Hard caps on the disc spatial-hash work per placement pass, so no loop can depend on a radius
 * value. A viewport grid holds at most ~2 100 cells on a 4 K canvas; a disc clipped to the
 * viewport never needs more than that plus a pad ring, and one that would is viewport-covering. */
export const MAX_DISC_CELLS = 4_096;
export const MAX_DISC_BUCKET_INSERTS = 120_000;

/** The blocking disc for one projected node footprint: the drawn core radius times the live
 * emphasis multiplier (hover/focus grow the drawn pearl), plus the clearance. Pure. */
export function footprintDisc(
  footprint: { readonly id: string; readonly x: number; readonly y: number; readonly coreRadiusPx: number },
  emphasisFactor = 1,
): LabelDisc {
  return { id: footprint.id, x: footprint.x, y: footprint.y, radius: footprint.coreRadiusPx * emphasisFactor + PEARL_DISC_CLEAR_PX };
}

/** The suffix a container title or label carries when its node holds hidden children (« · +12»). */
const COUNT_SUFFIX = /\s·\s\+\d+$/;

/**
 * One short label's final text. A short title the page cut out of the full title is marked with
 * «…» (backed off to a word boundary when the page cut inside a word); a text wider than
 * `maxWidth` is cut on a word boundary with «…»; a « · +N» count suffix is never the part cut.
 * Pure: the caller supplies the width function.
 */
export function shortLabelWithEllipsis(input: {
  readonly short: string;
  readonly full: string;
  readonly maxWidth: number;
  readonly measure: (text: string) => number;
}): string {
  const suffix = input.short.match(COUNT_SUFFIX)?.[0] ?? "";
  const head = suffix ? input.short.slice(0, input.short.length - suffix.length) : input.short;
  const fullHead = input.full.replace(COUNT_SUFFIX, "");
  let name = head.trimEnd();
  const cut = fullHead.length > name.length && fullHead.startsWith(name);
  if (cut) {
    const midWord = name.length > 0 && /\S/.test(fullHead[name.length] ?? " ") && /\S$/.test(name);
    if (midWord) name = name.replace(/\S+\s*$/, "").trimEnd();
    if (name.length > 0) name = `${name}…`;
    else name = `${head.trimEnd()}…`;
  }
  const text = suffix ? `${name}${suffix}` : name;
  if (input.measure(text) <= input.maxWidth) return text;
  const budget = input.maxWidth - input.measure(suffix);
  if (suffix && budget > input.measure("…")) return `${ellipsizeText(name, budget, input.measure)}${suffix}`;
  return ellipsizeText(input.short, input.maxWidth, input.measure);
}

/** Re-exported so the DOM label path and its tests share one word-boundary ellipsis. */
export { ellipsizeTextKeepCount };

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

/** The area (px²) of the part of a disc that lies inside an axis-aligned rect, summed over 1 px
 * columns: the deterministic measure a tier-1 label minimizes when every clear slot is taken.
 * Pure. */
export function discRectOverlapArea(rect: ViewportRect, cx: number, cy: number, radius: number): number {
  if (!(radius > 0) || !Number.isFinite(radius)) return 0;
  const right = rect.left + rect.width, bottom = rect.top + rect.height;
  const from = Math.max(rect.left, cx - radius), to = Math.min(right, cx + radius);
  if (to <= from) return 0;
  let area = 0;
  for (let x = from; x < to; x += 1) {
    const column = Math.min(x + 1, to) - x;
    const dx = (x + column / 2) - cx;
    const halfChord = Math.sqrt(Math.max(0, radius * radius - dx * dx));
    if (halfChord <= 0) continue;
    const covered = Math.min(bottom, cy + halfChord) - Math.max(rect.top, cy - halfChord);
    if (covered > 0) area += covered * column;
  }
  return area;
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
  discs: readonly LabelDisc[] = [],
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
  // Pearl and soma discs, bucketed by cell: a label rectangle must avoid every one of them, not only
  // other labels (requirement: «nessuna etichetta coperta dal proprio nodo o da altre perle»).
  // Every range is clipped to the viewport rect (only cells a label can occupy matter) and the work
  // is hard-capped, so a runaway projected radius — near the camera the footprint can be enormous
  // or, behind the camera plane, infinite — can neither hang the pass nor exhaust memory.
  const span = Math.max(bounds.width, bounds.height);
  const discCells = new Map<string, LabelDisc[]>();
  let inserts = 0;
  for (const disc of discs) {
    if (!Number.isFinite(disc.x) || !Number.isFinite(disc.y)) continue;
    if (!Number.isFinite(disc.radius) || disc.radius < 0) continue;
    // A disc at least as large as the viewport: the camera is at or inside the node (the 3D dolly
    // can reach 12.5× magnification). Treating it as an obstacle would blank every label, so it
    // blocks nothing — the node is the environment at that scale, not an obstacle.
    if (disc.radius >= span) continue;
    const reach = disc.radius + PEARL_LABEL_MARGIN_PX + 8;
    const left = Math.max(disc.x - reach, bounds.left - cellSize);
    const right = Math.min(disc.x + reach, bounds.left + bounds.width + cellSize);
    const top = Math.max(disc.y - reach, bounds.top - cellSize);
    const bottom = Math.min(disc.y + reach, bounds.top + bounds.height + cellSize);
    if (right < left || bottom < top) continue;
    const cellsNeeded = (Math.floor(right / cellSize) - Math.floor(left / cellSize) + 1)
      * (Math.floor(bottom / cellSize) - Math.floor(top / cellSize) + 1);
    if (cellsNeeded > MAX_DISC_CELLS) continue;
    inserts += cellsNeeded;
    if (inserts > MAX_DISC_BUCKET_INSERTS) break;
    for (const key of keys(left, top, right, bottom)) {
      const bucket = discCells.get(key) ?? [];
      bucket.push(disc);
      discCells.set(key, bucket);
    }
  }
  const discBlocked = (rect: ViewportRect, ownId?: string): boolean => {
    const seen = new Set<LabelDisc>();
    for (const key of keys(rect.left - 2, rect.top - 2, rect.left + rect.width + 2, rect.top + rect.height + 2)) {
      for (const disc of discCells.get(key) ?? []) {
        if (seen.has(disc)) continue;
        seen.add(disc);
        // A label's own anchor disc never rejects it: the anchor offsets already place it outside
        // the node's true radius, and an enlarged own disc (emphasis, soma elongation) must not
        // box the label in against itself.
        if (ownId !== undefined && disc.id === ownId) continue;
        if (rectOverlapsDisc(rect, disc.x, disc.y, disc.radius + PEARL_LABEL_MARGIN_PX - 2)) return true;
      }
    }
    return false;
  };
  const priority = { hover: 6, selected: 5, neighbour: 4, domain: 3, main: 2, zoom: 1 };
  for (const c of [...candidates].sort(
    (a, b) => (b.tier1 === true ? 1 : 0) - (a.tier1 === true ? 1 : 0)
      || priority[b.reason] - priority[a.reason] || b.priority - a.priority || a.id.localeCompare(b.id),
  )) {
    if (placed.length >= budget) break;
    if (c.x < bounds.left || c.y < bounds.top || c.x > bounds.left + bounds.width || c.y > bounds.top + bounds.height)
      continue;
    const size = measure(c.text, c.full ? 280 : 180, c.reason === "selected" ? 2 : c.full ? 8 : 1);
    if (size.width > bounds.width || size.height > bounds.height) continue;
    const rawRadius = Number.isFinite(c.radius) && (c.radius ?? 0) > 0 ? c.radius! : 0;
    // An anchor disc that covers the viewport places its label near the anchor point instead of
    // throwing it off-screen: the selection stays named at any zoom.
    const radius = rawRadius >= span ? 0 : rawRadius;
    const attempts = radius > 0 && c.reason !== "hover"
      ? [...discOffsets(radius), ...discOffsets(radius + LABEL_SECOND_RING_PX)]
      : c.reason === "hover" ? [[12, 12], [-12, 12], [12, -12], [-12, -12], ...positions] : positions;
    const rectAt = (dx: number, dy: number): ViewportRect => ({
      left: c.x + dx + (dx < 0 ? -size.width : 0),
      top: c.y + dy + (dy < 0 ? -size.height : 0),
      width: size.width,
      height: size.height,
    });
    // The hard constraints no tier may ever bend: inside the visible rect, clear of the anchor's
    // own disc, and over no placed label or reserved rect (the Aspetto panel).
    const admissible = (rect: ViewportRect): boolean => {
      if (
        rect.left < bounds.left ||
        rect.top < bounds.top ||
        rect.left + size.width > bounds.left + bounds.width ||
        rect.top + size.height > bounds.top + bounds.height
      )
        return false;
      if (radius > 0 && rectOverlapsDisc(rect, c.x, c.y, radius)) return false;
      const nearby = new Set(keys(rect.left - 3, rect.top - 3, rect.left + size.width + 3, rect.top + size.height + 3)
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
        return false;
      return true;
    };
    // Tier 1 keeps the narrow rule: never under its own node, never over another label
    // or the panel — but another node's pearl may sit beneath it, so when no slot is fully clear
    // the least-covered admissible slot wins instead of dropping the name.
    if (c.tier1 === true) {
      let fallback: { rect: ViewportRect; covered: number } | null = null;
      for (const [dx, dy] of attempts) {
        const rect = rectAt(dx, dy);
        if (!admissible(rect)) continue;
        if (discs.length === 0 || !discBlocked(rect, c.id)) {
          fallback = { rect, covered: -1 };
          break;
        }
        let covered = 0;
        for (const disc of discs) {
          if (disc.id === c.id) continue;
          // Cheap gate first: the exact column sum runs only on discs the rect truly touches.
          const nearestX = Math.min(Math.max(disc.x, rect.left), rect.left + rect.width);
          const nearestY = Math.min(Math.max(disc.y, rect.top), rect.top + rect.height);
          if ((disc.x - nearestX) ** 2 + (disc.y - nearestY) ** 2 > disc.radius ** 2) continue;
          covered += discRectOverlapArea(rect, disc.x, disc.y, disc.radius);
        }
        if (!fallback || covered < fallback.covered) fallback = { rect, covered };
      }
      if (fallback) {
        const label = { id: c.id, text: c.text, reason: c.reason, rect: fallback.rect };
        placed.push(label);
        for (const key of keys(fallback.rect.left, fallback.rect.top, fallback.rect.left + fallback.rect.width, fallback.rect.top + fallback.rect.height)) {
          const bucket = cells.get(key) ?? [];
          bucket.push(label);
          cells.set(key, bucket);
        }
      }
      continue;
    }
    for (const [dx, dy] of attempts) {
      const rect = rectAt(dx, dy);
      if (!admissible(rect)) continue;
      if (radius > 0 && rectOverlapsDisc(rect, c.x, c.y, radius)) continue;
      if (discs.length > 0 && discBlocked(rect, c.id)) continue;
      const label = { id: c.id, text: c.text, reason: c.reason, rect };
      placed.push(label);
      for (const key of keys(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height)) {
        const bucket = cells.get(key) ?? [];
        bucket.push(label);
        cells.set(key, bucket);
      }
      break;
    }
  }
  return placed;
}
