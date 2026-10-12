import { appendAll } from '#render-common/array-aggregation.ts';
import { ellipsizeTextKeepCount, readableTruncatedText, stripTrailingSeparators } from "./container-canvas.ts";
export type LabelReason = "domain" | "main" | "zoom" | "selected" | "neighbour" | "hover";
export type ViewportRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
type Density = "essential" | "balanced" | "complete";
const normalizeDensity = (value: unknown): Density => value === "essential" || value === "complete" ? value : "balanced";
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
  /** Tier 1: a Flat domain, selection or hover is placed first. When pearls or rims fill
   * every clear slot, its name may sit above a foreign pearl rather than disappear. */
  tier1?: boolean;
  /** Visibility is decided by the view's LOD pass; these flags also guard direct callers. */
  visible?: boolean;
  collapsed?: boolean;
  /** A visible aggregate names the number of children it represents. */
  aggregateCount?: number;
};
export type LabelLeader = { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number } };
export type PlacedLabel = { id: string; text: string; reason: LabelReason; rect: ViewportRect; leader?: LabelLeader };
export type LabelRim = { readonly x: number; readonly y: number; readonly radius: number };

/** A truncation must retain four visible title characters before the ellipsis. */
export const readableLabelText = readableTruncatedText;

/** Candidate policy before screen occlusion, title claims and collision placement. */
export function labelCandidateKind(input: {
  readonly id: string;
  readonly node: { readonly type: string; readonly v2?: { readonly level?: number } };
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly labels: boolean;
  readonly neighbour: boolean;
  readonly overview: boolean;
  readonly close: boolean;
  readonly organization: "natural" | "indra";
  readonly projection: "2d" | "3d";
  readonly focusMembers: ReadonlySet<string> | null;
  readonly moving: boolean;
}): { reason: LabelReason; tier1: boolean } | null {
  let reason: LabelReason | null = null;
  if (input.hovered) reason = "hover";
  else if (input.selected) reason = "selected";
  else if (!input.labels) return null;
  else if (input.neighbour) reason = "neighbour";
  else if (input.node.type === "domain") reason = "domain";
  else if (input.node.type === "connection" || input.node.v2?.level === 2) reason = "main";
  else if (!input.overview && !(input.organization === "indra" && input.projection === "3d")
    && (input.node.type === "canon" || input.node.type === "candidate" || input.node.type === "conversation")) reason = "zoom";
  else if (input.close) reason = "zoom";
  if (!reason) return null;
  const tier1 = reason === "hover" || reason === "selected"
    || (input.organization === "natural" && reason === "domain");
  if (input.focusMembers && !input.focusMembers.has(input.id) && !tier1) return null;
  if (input.moving && !tier1) return null;
  return { reason, tier1 };
}

/** One projected obstacle a label must stay clear of: a pearl or soma disc (centre and radius). */
export type LabelDisc = { readonly x: number; readonly y: number; readonly radius: number; readonly id?: string };

/** Clear space kept between a label rectangle and any pearl or soma disc. */
export const PEARL_LABEL_MARGIN_PX = 3;

/** Hard ceiling on labels drawn in one state: selected, neighbours, hubs and focused communities first. */
export const LABEL_BUDGET = 60;

/** D-072 L1: the label allowance of each density setting. LABEL_BUDGET stays the absolute
 * ceiling and the Completa value; the page passes `labelBudget` through the view input and the
 * view must hand it to `placeLabels` as its budget (falling back to LABEL_BUDGET). */
export const DENSITY_LABEL_BUDGETS: Readonly<Record<Density, number>> = {
  essential: 20,
  balanced: 40,
  complete: 60,
};

export const labelBudgetOf = (density: Density): number => DENSITY_LABEL_BUDGETS[normalizeDensity(density)];

export function formatLabelCounts(labels: number, titles: number, budget: number): string {
  return `${labels} · titoli ${titles} (budget ${budget})`;
}

/** Clearance added to a node's drawn core radius when building its blocking disc: the disc is the
 * real footprint plus a little air, never a multiplier of the long half-axis (a neural soma's
 * elongation is drawn along its axis; the minor radius plus this clearance is the agreed bound). */
export const PEARL_DISC_CLEAR_PX = 2;

/** Second ring of anchor offsets, tried when every slot at the anchor's own rim is taken: a label
 * may sit a little further from its anchor instead of being dropped. */
export const LABEL_SECOND_RING_PX = 14;
const RIM_NUDGES: readonly [number, number][] = [
  [6, 0], [-6, 0], [0, 6], [0, -6], [6, 6], [6, -6], [-6, 6], [-6, -6],
];

/** Legacy public caps retained for callers; the shared grid below has a stricter per-shape cap
 * and this insertion cap, so a projected radius cannot create unbounded buckets. */
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
const TRAILING_FUNCTION_WORDS = new Set([
  "e", "ed", "o", "od", "di", "del", "dello", "della", "dei", "degli", "delle", "a", "al", "allo", "alla", "ai", "agli", "alle",
  "da", "dal", "dalla", "in", "nel", "nella", "nei", "con", "su", "sul", "sulla", "per", "tra", "fra", "come", "durante",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "che", "non",
  "and", "or", "of", "for", "to", "the", "a", "an", "with", "on", "in", "at", "by", "from", "as", "into", "via",
]);

/** Remove an incomplete join from the visible end of a title before adding its ellipsis. */
function trimDanglingEllipsisTail(text: string): string {
  const words = text.trimEnd().split(/\s+/);
  while (words.length) {
    const last = words[words.length - 1]!.replace(/[.,;:!?·•|—–-]+$/u, "");
    if (last === "AI") break;
    if (!TRAILING_FUNCTION_WORDS.has(last.toLocaleLowerCase("it"))) break;
    words.pop();
  }
  return words.join(" ").replace(/[\s.,;:!?·•|—–-]+$/u, "");
}

function cleanEllipsis(text: string): string {
  const index = text.lastIndexOf("…");
  if (index < 0) return text;
  const before = trimDanglingEllipsisTail(text.slice(0, index));
  // The viewer's established minimum is four visible characters before an ellipsis.
  return [...before].length >= 4 ? `${before}…${text.slice(index + 1)}` : text;
}

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
  const fit = (text: string, width: number): string => {
    if (input.measure(text) <= width) return text;
    const words = text.trim().split(/\s+/u);
    for (let count = words.length - 1; count > 0; count -= 1) {
      const kept = stripTrailingSeparators(words.slice(0, count).join(" "));
      if (kept && input.measure(`${kept}…`) <= width) return cleanEllipsis(`${kept}…`);
    }
    // Only a lone oversized token may be split inside the token.
    if (words.length === 1) {
      const chars = [...words[0]!];
      for (let count = chars.length - 1; count > 0; count -= 1) {
        const kept = stripTrailingSeparators(chars.slice(0, count).join(""));
        if (kept && input.measure(`${kept}…`) <= width) return cleanEllipsis(`${kept}…`);
      }
    }
    return "…";
  };
  // A prepared short title can omit an interior word. Resolve such aliases from the full title
  // so the same node does not acquire a different truncation when its view path changes.
  if (head && !fullHead.startsWith(head)) {
    const budget = suffix ? input.maxWidth - input.measure(suffix) : input.maxWidth;
    const name = fit(fullHead, budget);
    return cleanEllipsis(`${name}${suffix}`);
  }
  let name = head.trimEnd();
  const cut = fullHead.length > name.length && fullHead.startsWith(name);
  if (cut) {
    const midWord = name.length > 0 && /\S/.test(fullHead[name.length] ?? " ") && /\S$/.test(name);
    if (midWord) name = stripTrailingSeparators(name.replace(/\S+\s*$/, "").trimEnd());
    else name = stripTrailingSeparators(name);
    if (name.length > 0) name = `${name}…`;
    else name = `${head.trimEnd()}…`;
  }
  const text = suffix ? `${name}${suffix}` : name;
  if (input.measure(text) <= input.maxWidth) return cleanEllipsis(text);
  const budget = input.maxWidth - input.measure(suffix);
  if (suffix && budget > input.measure("…")) return cleanEllipsis(`${fit(name, budget)}${suffix}`);
  return cleanEllipsis(fit(name, input.maxWidth));
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

/** A line touches a rectangle when it enters it (the attached label's own edge is exempt). */
function lineTouchesRect(line: LabelLeader, rect: ViewportRect, padding = 2): boolean {
  const left = rect.left - padding, right = rect.left + rect.width + padding;
  const top = rect.top - padding, bottom = rect.top + rect.height + padding;
  const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
  let lo = 0, hi = 1;
  for (const [p, q] of ([[-dx, line.from.x - left], [dx, right - line.from.x],
    [-dy, line.from.y - top], [dy, bottom - line.from.y]] as const)) {
    if (p === 0) { if (q < 0) return false; }
    else {
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
      if (lo > hi) return false;
    }
  }
  return true;
}

function linesCross(a: LabelLeader, b: LabelLeader): boolean {
  const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y;
  const bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < 1e-9) return false;
  const cx = b.from.x - a.from.x, cy = b.from.y - a.from.y;
  const t = (cx * by - cy * bx) / cross;
  const u = (cx * ay - cy * ax) / cross;
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

function lineTouchesDisc(line: LabelLeader, disc: LabelDisc): boolean {
  const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
  const t = Math.max(0, Math.min(1, ((disc.x - line.from.x) * dx + (disc.y - line.from.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(line.from.x + t * dx - disc.x, line.from.y + t * dy - disc.y) <= disc.radius + 2;
}

function nearLeader(x: number, y: number, radius: number, rect: ViewportRect): LabelLeader | undefined {
  const to = { x: Math.max(rect.left, Math.min(rect.left + rect.width, x)),
    y: Math.max(rect.top, Math.min(rect.top + rect.height, y)) };
  const dx = to.x - x, dy = to.y - y, distance = Math.hypot(dx, dy);
  if (distance <= radius + 20) return undefined;
  const offset = Math.min(distance - 2, radius + 2);
  return { from: { x: x + dx * offset / distance, y: y + dy * offset / distance }, to };
}

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
 * columns. Kept for callers measuring legacy screenshot evidence. Pure. */
export function discRectOverlapArea(rect: ViewportRect, cx: number, cy: number, radius: number): number {
  if (!(radius > 0) || !Number.isFinite(radius)) return 0;
  const right = rect.left + rect.width, bottom = rect.top + rect.height;
  // D081-P3g BEGIN: a grid cell can touch the disc's X range while its Y range
  // misses entirely. Reject that common case before the 1 px integral.
  if (bottom <= cy - radius || rect.top >= cy + radius) return 0;
  const nearestX = Math.min(Math.max(cx, rect.left), right);
  const nearestY = Math.min(Math.max(cy, rect.top), bottom);
  const dx = cx - nearestX, dy = cy - nearestY;
  if (dx * dx + dy * dy > radius * radius * (1 + 1e-12)) return 0;
  // D081-P3g END
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

/** Counters for the exact geometry predicates, used by the large-scene regression test. */
export type LabelPlacementOperations = {
  rim: number; rimQueries: number;
  discBlock: number; discLeader: number; discArea: number; discAreaQueries: number;
  nearbyVisits?: number; admissibleCalls?: number;
};

/** Broad-phase only: all final predicates still use their original coordinates and order. */
class LabelGeometryGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly global: number[] = [];
  private readonly boxes = new Map<number, readonly [number, number, number, number]>();
  // D081-P3g BEGIN: reuse a per-grid visitation table instead of allocating a
  // Set on every query. Query results still preserve the original index order.
  private readonly seen: number[] = [];
  private querySerial = 0;
  // D081-P3g END
  private inserts = 0;
  private readonly size: number;
  private readonly operations: LabelPlacementOperations | undefined;
  constructor(size = 64, operations?: LabelPlacementOperations) { this.size = size; this.operations = operations; }

  add(index: number, left: number, top: number, right: number, bottom: number): void {
    // D081-P3g: avoid a four-item allocation for every one of 11,199 discs.
    if (!Number.isFinite(left) || !Number.isFinite(top)
      || !Number.isFinite(right) || !Number.isFinite(bottom)) {
      this.global.push(index);
      return;
    }
    this.boxes.set(index, [left, top, right, bottom]);
    const x0 = Math.floor(left / this.size), x1 = Math.floor(right / this.size);
    const y0 = Math.floor(top / this.size), y1 = Math.floor(bottom / this.size);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    // Wide rings and projected discs remain cheap to build and are checked on every query.
    if (count > 64 || this.inserts + count > MAX_DISC_BUCKET_INSERTS) {
      this.global.push(index);
      return;
    }
    this.inserts += count;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x}:${y}`;
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = []; this.cells.set(key, bucket); }
      bucket.push(index);
    }
  }

  /** Index only cells touched by a rim band, not the empty interior of its bounding box. */
  addRim(index: number, x: number, y: number, radius: number, viewport: ViewportRect): void {
    const outer = radius + 3;
    const inner = Math.max(0, radius - 3);
    const left = x - outer, top = y - outer, right = x + outer, bottom = y + outer;
    if (![left, top, right, bottom].every(Number.isFinite)) {
      this.global.push(index);
      return;
    }
    this.boxes.set(index, [left, top, right, bottom]);
    const x0 = Math.max(Math.floor(left / this.size), Math.floor(viewport.left / this.size));
    const x1 = Math.min(Math.floor(right / this.size), Math.floor((viewport.left + viewport.width) / this.size));
    const y0 = Math.max(Math.floor(top / this.size), Math.floor(viewport.top / this.size));
    const y1 = Math.min(Math.floor(bottom / this.size), Math.floor((viewport.top + viewport.height) / this.size));
    for (let cellX = x0; cellX <= x1; cellX++) for (let cellY = y0; cellY <= y1; cellY++) {
      const cellLeft = cellX * this.size, cellRight = cellLeft + this.size;
      const cellTop = cellY * this.size, cellBottom = cellTop + this.size;
      const nearX = Math.min(Math.max(x, cellLeft), cellRight) - x;
      const nearY = Math.min(Math.max(y, cellTop), cellBottom) - y;
      if (nearX * nearX + nearY * nearY > outer * outer * (1 + 1e-12)) continue;
      const farX = Math.max(Math.abs(cellLeft - x), Math.abs(cellRight - x));
      const farY = Math.max(Math.abs(cellTop - y), Math.abs(cellBottom - y));
      if (farX * farX + farY * farY < inner * inner * (1 - 1e-12)) continue;
      const key = `${cellX}:${cellY}`;
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = []; this.cells.set(key, bucket); }
      bucket.push(index);
    }
  }

  nearby(left: number, top: number, right: number, bottom: number): number[] {
    const serial = ++this.querySerial;
    const found: number[] = [];
    const add = (index: number) => {
      if (this.seen[index] === serial) return;
      this.seen[index] = serial;
      const box = this.boxes.get(index);
      if (!box || (box[0] <= right && box[2] >= left && box[1] <= bottom && box[3] >= top))
        found.push(index);
    };
    for (const index of this.global) { if (this.operations) this.operations.nearbyVisits = (this.operations.nearbyVisits ?? 0) + 1; add(index); }
    const x0 = Math.floor(left / this.size), x1 = Math.floor(right / this.size);
    const y0 = Math.floor(top / this.size), y1 = Math.floor(bottom / this.size);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
      for (const index of this.cells.get(`${x}:${y}`) ?? []) {
        if (this.operations) this.operations.nearbyVisits = (this.operations.nearbyVisits ?? 0) + 1;
        add(index);
      }
    return found.sort((a, b) => a - b);
  }

  /** D081-P3g: boolean collision checks can stop at the first hit and need no ordered array. */
  someNearby(left: number, top: number, right: number, bottom: number,
    predicate: (index: number) => boolean): boolean {
    const serial = ++this.querySerial;
    const check = (index: number): boolean => {
      if (this.seen[index] === serial) return false;
      this.seen[index] = serial;
      const box = this.boxes.get(index);
      return (!box || (box[0] <= right && box[2] >= left && box[1] <= bottom && box[3] >= top))
        && predicate(index);
    };
    for (const index of this.global) {
      if (this.operations) this.operations.nearbyVisits = (this.operations.nearbyVisits ?? 0) + 1;
      if (check(index)) return true;
    }
    const x0 = Math.floor(left / this.size), x1 = Math.floor(right / this.size);
    const y0 = Math.floor(top / this.size), y1 = Math.floor(bottom / this.size);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
      for (const index of this.cells.get(`${x}:${y}`) ?? []) {
        if (this.operations) this.operations.nearbyVisits = (this.operations.nearbyVisits ?? 0) + 1;
        if (check(index)) return true;
      }
    return false;
  }
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
  rims: readonly LabelRim[] = [],
  operations?: LabelPlacementOperations,
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const reservedGrid = new LabelGeometryGrid(64, operations);
  const placedRectGrid = new LabelGeometryGrid(64, operations);
  const placedLeaderGrid = new LabelGeometryGrid(64, operations);
  for (let index = 0; index < reserved.length; index++) {
    const rect = reserved[index]!;
    reservedGrid.add(index, rect.left - 3, rect.top - 3,
      rect.left + rect.width + 3, rect.top + rect.height + 3);
  }
  // Pearl and soma discs and container rims share bounded screen-space grids. Large projected
  // shapes use the always-checked list, so no radius can create unbounded bucket work.
  const span = Math.max(bounds.width, bounds.height);
  // D081-P3g: the dense pearl field benefits from smaller cells; each label
  // query sees fewer unrelated discs while final predicate order stays sorted.
  const discGrid = new LabelGeometryGrid(discs.length > 1_200 ? 32 : 64, operations);
  const rimGrid = new LabelGeometryGrid(64, operations);
  const ownDiscRadii = new Map<string, number>();
  for (let index = 0; index < discs.length; index++) {
    const disc = discs[index]!;
    if (!Number.isFinite(disc.x) || !Number.isFinite(disc.y)) continue;
    if (!Number.isFinite(disc.radius) || disc.radius < 0) continue;
    if (disc.id) ownDiscRadii.set(disc.id, Math.max(ownDiscRadii.get(disc.id) ?? 0, disc.radius));
    // A disc at least as large as the viewport: the camera is at or inside the node (the 3D dolly
    // can reach 12.5× magnification). Treating it as an obstacle would blank every label, so it
    // blocks nothing — the node is the environment at that scale, not an obstacle.
    if (disc.radius >= span) continue;
    const reach = disc.radius + PEARL_LABEL_MARGIN_PX;
    // D081-P3g BEGIN: every candidate slot and leader stays inside bounds. A
    // projected obstacle wholly outside those bounds can never enter a query.
    if (disc.x + reach < bounds.left || disc.x - reach > bounds.left + bounds.width
      || disc.y + reach < bounds.top || disc.y - reach > bounds.top + bounds.height) continue;
    // D081-P3g END
    discGrid.add(index, disc.x - reach, disc.y - reach, disc.x + reach, disc.y + reach);
  }
  for (let index = 0; index < rims.length; index++) {
    const rim = rims[index]!;
    if (!(rim.radius > 0) || !Number.isFinite(rim.radius)) continue;
    const reach = rim.radius + 3;
    // D081-P3g BEGIN
    if (rim.x + reach < bounds.left || rim.x - reach > bounds.left + bounds.width
      || rim.y + reach < bounds.top || rim.y - reach > bounds.top + bounds.height) continue;
    // D081-P3g END
    rimGrid.addRim(index, rim.x, rim.y, rim.radius, bounds);
  }
  const nearbyDiscs = (rect: ViewportRect): number[] => discGrid.nearby(
    rect.left, rect.top, rect.left + rect.width, rect.top + rect.height);
  // D081-P3g BEGIN: a fully contained pearl contributes the same exact sampled
  // area to every slot. Cache that integral per projected disc for this pass.
  const fullDiscAreas = new Map<number, number>();
  const discArea = (rect: ViewportRect, index: number): number => {
    const disc = discs[index]!;
    if (rect.left <= disc.x - disc.radius && rect.left + rect.width >= disc.x + disc.radius
      && rect.top <= disc.y - disc.radius && rect.top + rect.height >= disc.y + disc.radius) {
      let area = fullDiscAreas.get(index);
      if (area === undefined) {
        area = discRectOverlapArea(rect, disc.x, disc.y, disc.radius);
        fullDiscAreas.set(index, area);
      }
      return area;
    }
    return discRectOverlapArea(rect, disc.x, disc.y, disc.radius);
  };
  // D081-P3g END
  const discBlocked = (rect: ViewportRect, ownId?: string): boolean => {
    return discGrid.someNearby(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height, index => {
      const disc = discs[index]!;
      if (ownId !== undefined && disc.id === ownId) return false;
      if (operations) operations.discBlock++;
      return rectOverlapsDisc(rect, disc.x, disc.y, disc.radius + PEARL_LABEL_MARGIN_PX - 2);
    });
  };
  // Radial width of rim bands touched by this rectangle. Zero means wholly inside or outside
  // every rim; a crossed rim disqualifies the slot.
  const rimBandWidth = (rect: ViewportRect, index: number): number => {
    const rim = rims[index]!;
    if (operations) operations.rim++;
    const nearestX = Math.min(Math.max(rim.x, rect.left), rect.left + rect.width);
    const nearestY = Math.min(Math.max(rim.y, rect.top), rect.top + rect.height);
    const nearDx = nearestX - rim.x, nearDy = nearestY - rim.y;
    const outer = rim.radius + 3;
    // Conservative squared-distance rejection avoids five hypot calls for rings whose bounding
    // boxes touch the slot but whose actual band cannot. The slack leaves boundary arithmetic to
    // the original predicate below, preserving exact scores and tie-breaks.
    if (nearDx * nearDx + nearDy * nearDy > outer * outer * (1 + 1e-12)) return 0;
    const farDx = Math.max(Math.abs(rect.left - rim.x), Math.abs(rect.left + rect.width - rim.x));
    const farDy = Math.max(Math.abs(rect.top - rim.y), Math.abs(rect.top + rect.height - rim.y));
    const inner = rim.radius - 3;
    if (inner > 0 && farDx * farDx + farDy * farDy < inner * inner * (1 - 1e-12)) return 0;
    const minimum = Math.hypot(nearestX - rim.x, nearestY - rim.y);
    const farthest = Math.hypot(farDx, farDy);
    return Math.max(0, Math.min(farthest, rim.radius + 3) - Math.max(minimum, rim.radius - 3));
  };
  const rimOverlap = (rect: ViewportRect): number => {
    if (operations) operations.rimQueries++;
    if (!rims.length) return 0;
    let overlap = 0;
    for (const index of rimGrid.nearby(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height))
      overlap += rimBandWidth(rect, index);
    return overlap;
  };
  const rimCrosses = (rect: ViewportRect): boolean => {
    if (operations) operations.rimQueries++;
    return rimGrid.someNearby(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height,
      index => rimBandWidth(rect, index) > 0);
  };
  const priority = { hover: 6, selected: 5, neighbour: 4, domain: 3, main: 2, zoom: 1 };
  // D081-P3g BEGIN: a dense pass should sort only anchors that can reach the viewport.
  // For smaller scenes keep the established candidate stream byte-for-byte equivalent.
  const ordered = (candidates.length > 1_200 ? candidates.filter(c =>
    c.visible !== false && c.collapsed !== true
    && c.x >= bounds.left && c.y >= bounds.top
    && c.x <= bounds.left + bounds.width && c.y <= bounds.top + bounds.height) : [...candidates]).sort(
    (a, b) => (b.tier1 === true ? 1 : 0) - (a.tier1 === true ? 1 : 0)
      || priority[b.reason] - priority[a.reason] || b.priority - a.priority || a.id.localeCompare(b.id),
  );
  for (const c of ordered) {
    // The density allowance is for optional tier-2 names; it cannot erase a domain or selection.
    // All tier-1 names are sorted first. Once the budget is filled, no remaining tier-2
    // candidate can affect the result; stop before its costly geometry search.
    if (!c.tier1 && placed.length >= budget) break;
    // D081-P3g END
    if (c.visible === false || c.collapsed === true) continue;
    const text = c.aggregateCount !== undefined && c.aggregateCount > 0 && !COUNT_SUFFIX.test(c.text)
      ? `${c.text} · +${Math.floor(c.aggregateCount)}` : c.text;
    if (!readableLabelText(text)) continue;
    if (c.x < bounds.left || c.y < bounds.top || c.x > bounds.left + bounds.width || c.y > bounds.top + bounds.height)
      continue;
    const size = measure(text, c.full ? 280 : 180, c.reason === "selected" ? 2 : c.full ? 8 : 1);
    if (size.width > bounds.width || size.height > bounds.height) continue;
    const rawRadius = Math.max(Number.isFinite(c.radius) && (c.radius ?? 0) > 0 ? c.radius! : 0,
      ownDiscRadii.get(c.id) ?? 0);
    // An anchor disc that covers the viewport places its label near the anchor point instead of
    // throwing it off-screen: the selection stays named at any zoom.
    const radius = rawRadius >= span ? 0 : rawRadius;
    const attempts = (radius > 0 && c.reason !== "hover"
      ? [...discOffsets(radius), ...discOffsets(radius + LABEL_SECOND_RING_PX)]
      : c.reason === "hover" ? [[12, 12], [-12, 12], [12, -12], [-12, -12], ...positions] : positions)
      .map(([x, y]) => [x, y] as [number, number]);
    // Bounded fallback rings keep an important label near its own node even in a dense cluster.
    // Every displaced slot has an explicit leader; no global "free-space" relocation is used.
    if (c.tier1) for (const extra of [32, 48, 64]) appendAll(attempts, discOffsets(radius + extra));
    const rectAt = (dx: number, dy: number): ViewportRect => ({
      left: c.x + dx + (dx < 0 ? -size.width : 0),
      top: c.y + dy + (dy < 0 ? -size.height : 0),
      width: size.width,
      height: size.height,
    });
    // The viewport, own disc, labels, panel and earlier leaders are hard constraints. Foreign
    // pearls and container rims are preferred clear; tier 1 may cross them as a last resort.
    const admissible = (rect: ViewportRect, allowForeignGeometry: boolean): boolean => {
      if (operations) operations.admissibleCalls = (operations.admissibleCalls ?? 0) + 1;
      if (
        rect.left < bounds.left ||
        rect.top < bounds.top ||
        rect.left + size.width > bounds.left + bounds.width ||
        rect.top + size.height > bounds.top + bounds.height
      )
        return false;
      if (radius > 0 && rectOverlapsDisc(rect, c.x, c.y, radius)) return false;
      if (!allowForeignGeometry && (rimCrosses(rect) || discBlocked(rect, c.tier1 ? c.id : undefined))) return false;
      if (
        placedRectGrid.someNearby(rect.left - 3, rect.top - 3, rect.left + size.width + 3,
          rect.top + size.height + 3, index => {
            const other = placed[index]!;
            return rect.left < other.rect.left + other.rect.width + 3 &&
            rect.left + rect.width + 3 > other.rect.left &&
            rect.top < other.rect.top + other.rect.height + 3 &&
            rect.top + rect.height + 3 > other.rect.top;
          })
        || reservedGrid.someNearby(rect.left, rect.top, rect.left + rect.width, rect.top + rect.height,
          index => { const other = reserved[index]!; return rect.left < other.left + other.width + 3 && rect.left + rect.width + 3 > other.left
            && rect.top < other.top + other.height + 3 && rect.top + rect.height + 3 > other.top; })
      )
        return false;
      if (placedLeaderGrid.someNearby(rect.left - 2, rect.top - 2,
        rect.left + rect.width + 2, rect.top + rect.height + 2,
        index => lineTouchesRect(placed[index]!.leader!, rect))) return false;
      return true;
    };
    const choice: { best: { rect: ViewportRect; leader?: LabelLeader; rim: number; covered: number } | null } = { best: null };
    const consider = (dx: number, dy: number, allowForeignGeometry: boolean): boolean => {
      const rect = rectAt(dx, dy);
      if (!admissible(rect, allowForeignGeometry)) return false;
      const leader = nearLeader(c.x, c.y, radius, rect);
      if (leader) {
        const lineLeft = Math.min(leader.from.x, leader.to.x), lineRight = Math.max(leader.from.x, leader.to.x);
        const lineTop = Math.min(leader.from.y, leader.to.y), lineBottom = Math.max(leader.from.y, leader.to.y);
        if (reservedGrid.nearby(lineLeft - 2, lineTop - 2, lineRight + 2, lineBottom + 2)
          .some(index => lineTouchesRect(leader, reserved[index]!))) return false;
        const nearbyPlaced = new Set([
          ...placedRectGrid.nearby(lineLeft - 2, lineTop - 2, lineRight + 2, lineBottom + 2),
          ...placedLeaderGrid.nearby(lineLeft, lineTop, lineRight, lineBottom),
        ]);
        if ([...nearbyPlaced].some(index => {
          const other = placed[index]!;
          return lineTouchesRect(leader, other.rect)
            || (other.leader !== undefined && linesCross(leader, other.leader));
        })) return false;
        if (!allowForeignGeometry && discGrid.someNearby(
          Math.min(leader.from.x, leader.to.x), Math.min(leader.from.y, leader.to.y),
          Math.max(leader.from.x, leader.to.x), Math.max(leader.from.y, leader.to.y),
          index => {
          const disc = discs[index]!;
          if (disc.id === c.id) return false;
          if (operations) operations.discLeader++;
          return lineTouchesDisc(leader, disc);
        })) return false;
      }
      const rim = allowForeignGeometry ? rimOverlap(rect) : 0;
      // D081-P3g BEGIN: covered area is only a tie-break after rim overlap. Once a
      // clearer slot exists, this slot cannot win and the expensive disc integral is moot.
      if (allowForeignGeometry && choice.best && rim > choice.best.rim) return false;
      // D081-P3g END
      if (allowForeignGeometry && operations) operations.discAreaQueries++;
      let covered = 0;
      if (allowForeignGeometry) for (const index of nearbyDiscs(rect)) {
        const disc = discs[index]!;
        if (disc.id === c.id) continue;
        if (operations) operations.discArea++;
        covered += discArea(rect, index);
        // D081-P3g BEGIN: overlap areas are nonnegative. A slot that already
        // exceeds the best same-rim score cannot recover by visiting more discs.
        if (choice.best && rim === choice.best.rim && covered > choice.best.covered) break;
        // D081-P3g END
      }
      if (!choice.best || rim < choice.best.rim || (rim === choice.best.rim && covered < choice.best.covered))
        choice.best = { rect, ...(leader ? { leader } : {}), rim, covered };
      return !allowForeignGeometry || (rim === 0 && covered === 0);
    };
    let ideal = false;
    for (const [dx, dy] of attempts) if (consider(dx, dy, false)) { ideal = true; break; }
    // Small fixed nudges rescue a label beside a rim without an unbounded search.
    if (!ideal && rims.length) {
      for (const [dx, dy] of attempts) {
        for (const [nx, ny] of RIM_NUDGES) if (consider(dx + nx, dy + ny, false)) { ideal = true; break; }
        if (ideal) break;
      }
    }
    if (!ideal && c.tier1) {
      for (const [dx, dy] of attempts) if (consider(dx, dy, true)) { ideal = true; break; }
      if (!ideal && rims.length) {
        for (const [dx, dy] of attempts) {
          for (const [nx, ny] of RIM_NUDGES) if (consider(dx + nx, dy + ny, true)) { ideal = true; break; }
          if (ideal) break;
        }
      }
      // Earlier names or the side panel can occupy every local slot. Widen the search only then;
      // the first available ring keeps the name as close to its node as the hard constraints allow.
      if (!choice.best) {
        for (let extra = 80; extra <= span + size.width; extra += 24) {
          const distance = radius + extra + 6;
          for (let index = 0; index < 16; index += 1) {
            const angle = index * Math.PI / 8;
            // D081-P3g BEGIN: zero rim and zero covered area is the absolute
            // minimum. Later angles cannot improve this first winning slot.
            if (consider(Math.cos(angle) * distance, Math.sin(angle) * distance, true)) break;
            // D081-P3g END
          }
          if (choice.best) break;
        }
      }
    }
    if (choice.best) {
      const { rect, leader } = choice.best;
      const label: PlacedLabel = { id: c.id, text, reason: c.reason, rect, ...(leader ? { leader } : {}) };
      placed.push(label);
      placedRectGrid.add(placed.length - 1, rect.left - 2, rect.top - 2,
        rect.left + rect.width + 2, rect.top + rect.height + 2);
      if (leader) placedLeaderGrid.add(placed.length - 1,
        Math.min(leader.from.x, leader.to.x), Math.min(leader.from.y, leader.to.y),
        Math.max(leader.from.x, leader.to.x), Math.max(leader.from.y, leader.to.y));
    }
  }
  return placed;
}
