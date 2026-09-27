/** Layout of the disclosed hierarchy. All coordinates are shared by front and rotated views. */
import { morphologyLayoutParams } from "#engine/morphology.ts";

export type Point3 = { readonly x: number; readonly y: number; readonly z: number };
export type LayoutNode = {
  readonly id: string;
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly parent: string | null;
  readonly size: number;
  readonly domains: readonly string[];
};
export type LayoutEdge = { readonly id: string; readonly source: string; readonly target: string; readonly class: "attested" | "exploratory" };
export type LayoutInput = {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly organization: "flat" | "indra";
  readonly morphology: "stellar" | "neural" | "mycelium";
  readonly previous?: ReadonlyMap<string, Point3>;
};
export type LayoutContainer = { readonly id: string; readonly level: number; readonly center: Point3; readonly radius: number };
export type LayoutResult = { readonly positions: ReadonlyMap<string, Point3>; readonly containers: readonly LayoutContainer[]; readonly source: "flat-community" | "indra-recursive" | "placeholder" };
export const LAYOUT_EXTENT = 1000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const radiusOf = (node: LayoutNode) => 5 + Math.max(0, Math.min(1, node.size)) * 5;
function hierarchy(nodes: readonly LayoutNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string | null, LayoutNode[]>();
  for (const node of nodes) {
    const parent = node.parent && byId.has(node.parent) ? node.parent : null;
    const list = children.get(parent) ?? [];
    list.push(node); children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => compare(a.id, b.id));
  return { byId, children };
}
/** Square shells exclude the parent's centre and give O(1) deterministic slots. */
function slot(index: number): { x: number; y: number } {
  const ring = Math.ceil((Math.sqrt(index + 2) - 1) / 2);
  const before = (2 * ring - 1) ** 2 - 1;
  const side = 2 * ring;
  const k = index - before;
  if (k < side) return { x: -ring + k, y: -ring };
  if (k < side * 2) return { x: ring, y: -ring + k - side };
  if (k < side * 3) return { x: ring - (k - side * 2), y: ring };
  return { x: -ring, y: ring - (k - side * 3) };
}
/** Hilbert cells keep related members close without nesting their coordinates. */
function hilbert(index: number, side: number): { x: number; y: number } {
  let x = 0, y = 0, t = index;
  for (let scale = 1; scale < side; scale *= 2) {
    const rx = (Math.floor(t / 2) & 1), ry = (t ^ rx) & 1;
    if (ry === 0) {
      if (rx === 1) { x = scale - 1 - x; y = scale - 1 - y; }
      [x, y] = [y, x];
    }
    x += scale * rx; y += scale * ry; t = Math.floor(t / 4);
  }
  return { x: x - (side - 1) / 2, y: y - (side - 1) / 2 };
}
function indra(input: LayoutInput): LayoutResult {
  const { children } = hierarchy(input.nodes);
  const params = morphologyLayoutParams(input.morphology);
  const spacing = params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
  const radii = new Map<string, number>();
  const offsets = new Map<string, Point3>();
  const visiting = new Set<string>();
  const measure = (node: LayoutNode): number => {
    const found = radii.get(node.id); if (found !== undefined) return found;
    if (visiting.has(node.id)) throw new TypeError("hierarchy has a cycle");
    visiting.add(node.id);
    const list = children.get(node.id) ?? [];
    let radius = radiusOf(node) * spacing;
    if (list.length) {
      const maxChild = Math.max(...list.map(measure));
      const step = 2 * maxChild + 12 * spacing;
      list.forEach((child, index) => {
        const grid = slot(index);
        const offset = { x: grid.x * step, y: grid.y * step, z: 0 };
        offsets.set(child.id, offset);
        radius = Math.max(radius, Math.hypot(offset.x, offset.y, Math.abs(child.level - node.level) * 18 * spacing) + (radii.get(child.id) ?? 0) + 4 * spacing);
      });
    }
    visiting.delete(node.id); radii.set(node.id, radius); return radius;
  };
  const roots = children.get(null) ?? [];
  roots.forEach(measure);
  const positions = new Map<string, Point3>();
  const containers: LayoutContainer[] = [];
  const rootStep = 2 * Math.max(0, ...roots.map(node => radii.get(node.id) ?? 0)) + 30 * spacing;
  const place = (node: LayoutNode, x: number, y: number): void => {
    // Small level tiers and sibling phase make rotation informative while the front remains exact.
    const z = (node.level - 3) * 18 * spacing;
    const center = { x, y, z };
    positions.set(node.id, center);
    const list = children.get(node.id) ?? [];
    if (list.length) containers.push({ id: node.id, level: node.level, center, radius: radii.get(node.id) ?? 0 });
    for (const child of list) {
      const offset = offsets.get(child.id)!;
      place(child, x + offset.x, y + offset.y);
    }
  };
  roots.forEach((root, index) => { const p = slot(index); place(root, p.x * rootStep, p.y * rootStep); });
  return { positions, containers, source: "indra-recursive" };
}
/** Disclosure only inserts fresh nodes; existing screen positions remain exact. */
function incrementalFlat(input: LayoutInput, byId: ReadonlyMap<string, LayoutNode>, spacing: number, linkDistance: number): LayoutResult {
  const positions = new Map<string, Point3>();
  const cell = spacing * 2;
  const occupied = new Map<string, string[]>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const occupy = (id: string, point: Point3) => {
    const key = cellKey(point.x, point.y);
    const list = occupied.get(key) ?? []; list.push(id); occupied.set(key, list);
  };
  for (const node of input.nodes) {
    const point = input.previous?.get(node.id);
    if (point) { positions.set(node.id, point); occupy(node.id, point); }
  }
  const fresh = input.nodes.filter(node => !positions.has(node.id)).sort((a, b) => a.level - b.level || b.size - a.size || compare(a.id, b.id));
  const localStep = spacing * (1.6 + 0.1 * linkDistance);
  const nextAttempt = new Map<string, number>();
  for (const node of fresh) {
    const parent = node.parent ? positions.get(node.parent) : undefined;
    const domain = node.domains.map(id => positions.get(id)).find(point => point !== undefined);
    const center = parent ?? domain ?? { x: 0, y: 0, z: 0 };
    let placed: Point3 | undefined;
    const centerKey = node.parent ?? node.domains[0] ?? "root";
    for (let attempt = nextAttempt.get(centerKey) ?? 0; attempt < input.nodes.length + 64; attempt++) {
      const p = attempt === 0 ? { x: 0, y: 0 } : slot(attempt - 1);
      const candidate = { x: center.x + p.x * localStep, y: center.y + p.y * localStep, z: center.z + (parent ? 11 : 0) };
      const col = Math.floor(candidate.x / cell), row = Math.floor(candidate.y / cell);
      let free = true;
      for (let dx = -1; dx <= 1 && free; dx++) for (let dy = -1; dy <= 1 && free; dy++)
        for (const id of occupied.get(`${col + dx}:${row + dy}`) ?? []) {
          const point = positions.get(id)!, other = byId.get(id)!;
          const minimum = spacing * (0.72 + (radiusOf(node) + radiusOf(other)) / 24);
          if ((candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2 < minimum ** 2) { free = false; break; }
        }
      if (free) { placed = candidate; nextAttempt.set(centerKey, attempt + 1); break; }
    }
    const point = placed ?? { x: center.x + (fresh.indexOf(node) + 1) * localStep, y: center.y, z: center.z };
    positions.set(node.id, point); occupy(node.id, point);
  }
  return { positions, containers: [], source: "flat-community" };
}
function flat(input: LayoutInput): LayoutResult {
  const { byId, children } = hierarchy(input.nodes);
  const siblingRank = new Map<string, number>();
  for (const list of children.values()) [...list].sort((a, b) => b.size - a.size || compare(a.id, b.id)).forEach((node, index) => siblingRank.set(node.id, index));
  const params = morphologyLayoutParams(input.morphology);
  const spacing = 21 * params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
  if (input.previous?.size) return incrementalFlat(input, byId, spacing, params.linkDistance);
  const communityOf = new Map<string, string>();
  const findCommunity = (node: LayoutNode): string => {
    const prior = communityOf.get(node.id); if (prior) return prior;
    const seen = new Set<string>(); let cursor = node;
    while (cursor.parent && byId.has(cursor.parent) && !seen.has(cursor.id)) {
      seen.add(cursor.id); cursor = byId.get(cursor.parent)!;
    }
    const key = cursor.level === 1 ? cursor.id : (node.domains.find(id => byId.has(id)) ?? cursor.id);
    communityOf.set(node.id, key); return key;
  };
  const groups = new Map<string, LayoutNode[]>();
  for (const node of input.nodes) { const key = findCommunity(node); const group = groups.get(key) ?? []; group.push(node); groups.set(key, group); }
  const keys = [...groups.keys()].sort(compare);
  // An attested edge pulls its community toward its neighbours in two stable barycentric sweeps.
  const weights = new Map<string, Map<string, number>>();
  for (const edge of input.edges) {
    if (edge.class !== "attested") continue;
    const a = communityOf.get(edge.source), b = communityOf.get(edge.target);
    if (!a || !b || a === b) continue;
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const row = weights.get(from) ?? new Map<string, number>(); row.set(to, (row.get(to) ?? 0) + 1); weights.set(from, row);
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const order = new Map(keys.map((key, index) => [key, index]));
    keys.sort((a, b) => {
      const score = (key: string) => { let sum = 0, total = 0; for (const [other, weight] of weights.get(key) ?? []) { sum += (order.get(other) ?? 0) * weight; total += weight; } return total ? sum / total : (order.get(key) ?? 0); };
      return score(a) - score(b) || compare(a, b);
    });
  }
  const positions = new Map<string, Point3>();
  const reserved = new Map<string, Point3>();
  for (const node of input.nodes) { const point = input.previous?.get(node.id); if (point) { positions.set(node.id, point); reserved.set(node.id, point); } }
  const maxGroup = Math.max(1, ...[...groups.values()].map(group => group.length));
  const communityStep = spacing * (Math.sqrt(maxGroup) * (2.9 - params.colonyGravity * 0.2) + 3);
  const cols = Math.max(1, Math.ceil(Math.sqrt(keys.length)));
  const cell = spacing * 2;
  const occupied = new Map<string, string[]>();
  const keyAt = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const occupy = (id: string, point: Point3) => { const key = keyAt(point.x, point.y); const list = occupied.get(key) ?? []; list.push(id); occupied.set(key, list); };
  for (const [id, point] of positions) occupy(id, point);
  const isFree = (candidate: Point3, node: LayoutNode): boolean => {
    const col = Math.floor(candidate.x / cell), row = Math.floor(candidate.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const id of occupied.get(`${col + dx}:${row + dy}`) ?? []) {
        const point = positions.get(id)!;
        const other = byId.get(id)!;
        const minimum = spacing * (0.72 + (radiusOf(node) + radiusOf(other)) / 24);
        if ((candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2 < minimum ** 2) return false;
      }
    return true;
  };
  keys.forEach((key, communityIndex) => {
    const group = groups.get(key)!;
    const side = 2 ** Math.ceil(Math.log2(Math.max(2, Math.sqrt(group.length))));
    const path = (node: LayoutNode): string => {
      const parts: string[] = []; let cursor: LayoutNode | undefined = node;
      while (cursor) { parts.unshift(String(siblingRank.get(cursor.id) ?? 0).padStart(5, "0")); cursor = cursor.parent ? byId.get(cursor.parent) : undefined; }
      return parts.join("/");
    };
    group.sort((a, b) => compare(path(a), path(b)) || b.size - a.size);
    const col = communityIndex % cols, row = Math.floor(communityIndex / cols);
    const cx = (col - (cols - 1) / 2) * communityStep;
    const cy = (row - (Math.ceil(keys.length / cols) - 1) / 2) * communityStep;
    group.forEach((node, index) => {
      if (reserved.has(node.id)) return;
      const parent = input.previous && node.parent ? positions.get(node.parent) : undefined;
      const center = parent ?? { x: cx, y: cy, z: 0 };
      let placed: Point3 | undefined;
      for (let attempt = parent ? 0 : index; attempt < input.nodes.length + 64; attempt++) {
        const p = parent ? slot(attempt) : attempt < side * side ? hilbert(attempt, side) : slot(attempt - side * side);
        const localStep = spacing * (1.6 + 0.1 * params.linkDistance);
        const candidate = { x: center.x + p.x * localStep, y: center.y + p.y * localStep, z: 0 };
        if (isFree(candidate, node)) { placed = candidate; break; }
      }
      const p = placed ?? { x: cx + index * spacing, y: cy, z: 0 };
      // A bounded community/level field prevents a single hub forming a depth spike.
      const point = { ...p, z: ((communityIndex % 5) - 2) * 17 + (node.level - 3) * 11 };
      positions.set(node.id, point); occupy(node.id, point);
    });
  });
  // At small disclosed scales, shorten attested chords by deterministic within-community swaps.
  // Every swap reuses occupied cells, so the distance guarantee and community partition survive.
  const attested = input.edges.filter(edge => edge.class === "attested" && positions.has(edge.source) && positions.has(edge.target));
  if (!input.previous && input.nodes.length <= 500 && attested.length > 1 && attested.length <= 120) {
    const orient = (a: Point3, b: Point3, c: Point3) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const crossingScore = (): number => {
      let total = 0;
      for (let a = 0; a < attested.length; a++) for (let b = a + 1; b < attested.length; b++) {
        const left = attested[a]!, right = attested[b]!;
        if (left.source === right.source || left.source === right.target || left.target === right.source || left.target === right.target) continue;
        const p = positions.get(left.source)!, q = positions.get(left.target)!;
        const r = positions.get(right.source)!, t = positions.get(right.target)!;
        if (orient(p, q, r) * orient(p, q, t) < 0 && orient(r, t, p) * orient(r, t, q) < 0) total++;
      }
      return total;
    };
    const swap = (a: string, b: string): void => {
      const left = positions.get(a)!, right = positions.get(b)!;
      positions.set(a, { x: right.x, y: right.y, z: left.z });
      positions.set(b, { x: left.x, y: left.y, z: right.z });
    };
    let score = crossingScore();
    for (let pass = 0; pass < 3; pass++) for (const edge of [...attested].sort((a, b) => compare(a.id, b.id))) {
      for (const [moving, target] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
        const community = communityOf.get(moving);
        if (!community || community !== communityOf.get(target)) continue;
        const destination = positions.get(target)!;
        const candidates = (groups.get(community) ?? []).filter(node => node.id !== moving && node.id !== target)
          .sort((a, b) => {
            const pa = positions.get(a.id)!, pb = positions.get(b.id)!;
            return (pa.x - destination.x) ** 2 + (pa.y - destination.y) ** 2
              - (pb.x - destination.x) ** 2 - (pb.y - destination.y) ** 2 || compare(a.id, b.id);
          }).slice(0, 6);
        for (const candidate of candidates) {
          swap(moving, candidate.id);
          const next = crossingScore();
          if (next < score) { score = next; break; }
          swap(moving, candidate.id);
        }
      }
    }
  }
  return { positions, containers: [], source: "flat-community" };
}
export function computeLayout(input: LayoutInput): LayoutResult {
  return input.organization === "indra" ? indra(input) : flat(input);
}
