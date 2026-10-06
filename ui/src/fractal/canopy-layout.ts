/** Experimental C2 canopy. Binary words are addresses in an IFS, never semantic nodes. */
import type { GraphEdge } from '../review/graph-v2.ts';
import type { Reading } from '../review/view-contract.ts';

export const CANOPY_RATIO = 0.64;
export const CANOPY_TURN = 42 * Math.PI / 180;
// The least integer tilt meeting the existing C3 volume threshold; projected
// displacement from the legacy presentation is reported separately.
export const CANOPY_SPATIAL_TILT = 66 * Math.PI / 180;
// One fixed display similarity fitted to the D-081 Adatta camera's projected
// reference snapshot (weighted by hierarchy level). It does not alter the maps.
export const CANOPY_SPATIAL_DISPLAY_SCALE = 1.1646668795276887;
export const CANOPY_SPATIAL_DISPLAY_ROTATION: CanopyMatrix3 = [
  0.24589704368586743, -0.21760416813696506, -0.9445544293030285,
  0.7260160639336389, 0.6869904530400668, 0.030737474556478673,
  0.6422112727263957, -0.693319943057477, 0.32691304308932034,
];
export const CANOPY_VERSION = 'c4-readable-canopy-v4-stationary-3d';
export type CanopyPoint = Readonly<{ x: number; y: number; z: number }>;
export type CanopyMatrix3 = readonly [number, number, number, number, number, number, number, number, number];
export function canopySpatialDisplayPoint(point: CanopyPoint): CanopyPoint {
  const m = CANOPY_SPATIAL_DISPLAY_ROTATION, scale = CANOPY_SPATIAL_DISPLAY_SCALE;
  return { x: scale * (m[0] * point.x + m[1] * point.y + m[2] * point.z),
    y: scale * (m[3] * point.x + m[4] * point.y + m[5] * point.z),
    z: scale * (m[6] * point.x + m[7] * point.y + m[8] * point.z) };
}
const IDENTITY3: CanopyMatrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Row-major Rz(±42°) Rx(±tilt); the bit is one address symbol, not a hierarchy level. */
export function canopySpatialRotation(bit: '0' | '1'): CanopyMatrix3 {
  const sign = bit === '0' ? -1 : 1;
  const c = Math.cos(CANOPY_TURN), s = sign * Math.sin(CANOPY_TURN);
  const ct = Math.cos(CANOPY_SPATIAL_TILT), st = sign * Math.sin(CANOPY_SPATIAL_TILT);
  return [c, -s * ct, s * st, s, c * ct, -c * st, 0, st, ct];
}
const ROTATIONS = { '0': canopySpatialRotation('0'), '1': canopySpatialRotation('1') } as const;
function multiply3(a: CanopyMatrix3, b: CanopyMatrix3): CanopyMatrix3 {
  const result = Array<number>(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++)
    result[row * 3 + col] = a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[3 + col]!
      + a[row * 3 + 2]! * b[6 + col]!;
  return result as unknown as CanopyMatrix3;
}
export type CanopyInputNode = Readonly<{ id: string; parent: string | null; level: number;
  title?: string; display_label?: string; importance?: { value: number }; counts?: { descendants: number } }>;
export type CanopyPosition = Readonly<{ id: string; parentId: string | null; level: number;
  domainId: string; address: string; point: CanopyPoint; point3d: CanopyPoint;
  label: string; descendantCount: number; relationCount: number; relationLoad: CanopyRailLoad }>;
export type CanopyRail = Readonly<{ address: string; from: CanopyPoint; to: CanopyPoint;
  from3d: CanopyPoint; to3d: CanopyPoint; count: number; relationCount: number;
  relationLoad: CanopyRailLoad; virtual: boolean; width: number }>;
export type CanopyRailLoad = Readonly<{ structural: number; attested: number; exploratory: number }>;
export type RelationBundle = Readonly<{ id: string; source: string; target: string;
  class: GraphEdge['class']; role: 'structural' | GraphEdge['class'];
  type: string; count: number; sourceEdgeIds: readonly string[];
  crossDomain: boolean }>;
export type CanopyLayout = Readonly<{
  positions: ReadonlyMap<string, CanopyPosition>;
  lineageIds: readonly string[];
  rails: readonly CanopyRail[];
  railLoad: ReadonlyMap<string, CanopyRailLoad>;
  relationBundles: readonly RelationBundle[];
  crossDomain: Readonly<{ attested: number; exploratory: number }>;
  structuralCrossDomain: number;
  bounds: Readonly<{ x: readonly [number, number]; y: readonly [number, number]; z: readonly [number, number] }>;
  digest: string;
}>;

export function canopyBundlesForReading(layout: CanopyLayout, reading: Reading): readonly RelationBundle[] {
  return layout.relationBundles.filter(bundle => bundle.role === 'structural' || reading === 'combined' ||
    (reading === 'attested' ? bundle.role === 'attested' : bundle.role === 'exploratory'));
}

const fitAnchorCache = new WeakMap<CanopyLayout, Partial<Record<'2d' | '3d', readonly string[]>>>();
/** Real extreme IDs make Adatta frame the full canopy in either projection. */
export function canopyFitAnchorIds(layout: CanopyLayout, projection: '2d' | '3d'): readonly string[] {
  const cached = fitAnchorCache.get(layout)?.[projection];
  if (cached) return cached;
  const point = (row: CanopyPosition) => projection === '3d' ? row.point3d : row.point;
  const anchors = new Set<string>();
  for (const axis of projection === '3d' ? ['x', 'y', 'z'] as const : ['x', 'y'] as const) {
    let minimum: CanopyPosition | null = null, maximum: CanopyPosition | null = null;
    for (const row of layout.positions.values()) {
      if (!minimum || point(row)[axis] < point(minimum)[axis] ||
        point(row)[axis] === point(minimum)[axis] && compare(row.id, minimum.id) < 0) minimum = row;
      if (!maximum || point(row)[axis] > point(maximum)[axis] ||
        point(row)[axis] === point(maximum)[axis] && compare(row.id, maximum.id) > 0) maximum = row;
    }
    if (minimum) anchors.add(minimum.id);
    if (maximum) anchors.add(maximum.id);
  }
  if (projection === '3d') for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1])
    for (const dz of [-1, 0, 1]) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      let best: CanopyPosition | null = null, value = -Infinity;
      for (const row of layout.positions.values()) {
        const p = row.point3d, next = dx * p.x + dy * p.y + dz * p.z;
        if (next > value || next === value && best && compare(row.id, best.id) < 0) {
          best = row; value = next;
        }
      }
      if (best) anchors.add(best.id);
    }
  const result = [...anchors];
  fitAnchorCache.set(layout, { ...fitAnchorCache.get(layout), [projection]: result });
  return result;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Complete prefix code: nine roots occupy both halves of one binary canopy. */
const bitWord = (index: number, count: number): string => {
  if (count === 1) return '0';
  const depth = Math.ceil(Math.log2(count));
  if (depth === 1) return index.toString(2);
  const shortCount = 2 ** depth - count;
  if (index < shortCount) return index.toString(2).padStart(depth - 1, '0');
  const tail = index - shortCount;
  return (shortCount + Math.floor(tail / 2)).toString(2).padStart(depth - 1, '0') + String(tail % 2);
};
type Frame = { x: number; y: number; angle: number; step: number };
const initial: Frame = { x: 0, y: 0, angle: -Math.PI / 2, step: 485 };
type SpatialFrame = { p: CanopyPoint; step: number; orientation: CanopyMatrix3 };
const initial3d: SpatialFrame = { p: { x: 0, y: 0, z: 0 }, step: initial.step, orientation: IDENTITY3 };
function advance3d(frame: SpatialFrame, bit: '0' | '1'): SpatialFrame {
  const orientation = multiply3(frame.orientation, ROTATIONS[bit]);
  const step = frame.step * CANOPY_RATIO;
  // In the display frame, 485*S_word(0) is the sum of these rotated unit stems.
  // Neither matrix nor scale depends on depth, sibling count or source metadata.
  const stem = canopySpatialDisplayPoint({ x: -step * orientation[1],
    y: -step * orientation[4], z: -step * orientation[7] });
  return { p: { x: frame.p.x + stem.x, y: frame.p.y + stem.y, z: frame.p.z + stem.z },
    step, orientation };
}
function advance(frame: Frame, bit: string): Frame {
  const sign = bit === '0' ? -1 : 1;
  const angle = frame.angle + sign * CANOPY_TURN;
  const step = frame.step * CANOPY_RATIO;
  return { x: frame.x + Math.cos(angle) * step, y: frame.y + Math.sin(angle) * step,
    angle, step };
}
const point = (frame: Frame): CanopyPoint => ({ x: frame.x, y: frame.y, z: 0 });
function digestOf(rows: readonly string[]): string {
  // A stable, inexpensive layout identity; not a cryptographic source digest.
  let hash = 0x811c9dc5;
  for (const row of rows) for (let i = 0; i < row.length; i++) {
    hash ^= row.charCodeAt(i); hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** One virtual root, nine domain descendants, then the real primary-parent tree. */
export function computeCanopyLayout(nodes: readonly CanopyInputNode[], edges: readonly GraphEdge[] = []): CanopyLayout {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('Canopy requires unique node IDs');
  const children = new Map<string | null, CanopyInputNode[]>();
  for (const node of nodes) {
    if (node.parent !== null && !byId.has(node.parent)) throw new Error(`Canopy parent missing: ${node.id}`);
    const list = children.get(node.parent) ?? [];
    list.push(node); children.set(node.parent, list);
  }
  for (const list of children.values()) list.sort((a, b) =>
    (b.importance?.value ?? 0) - (a.importance?.value ?? 0) || compare(a.id, b.id));
  const positions = new Map<string, CanopyPosition>();
  const branch = new Map<string, { from: CanopyPoint; to: CanopyPoint;
    from3d: CanopyPoint; to3d: CanopyPoint; count: number; virtual: boolean }>();
  const walk = (parentId: string | null, prefix: string, frame: Frame,
    spatial: SpatialFrame, domainId: string | null): void => {
    const siblings = children.get(parentId) ?? [];
    siblings.forEach((node, index) => {
      const word = bitWord(index, siblings.length);
      let cursor = frame;
      let cursor3d = spatial;
      let address = prefix;
      for (const bit of word) {
        const next = advance(cursor, bit);
        const next3d = advance3d(cursor3d, bit as '0' | '1');
        address += bit;
        const rail = branch.get(address) ?? { from: point(cursor), to: point(next),
          from3d: cursor3d.p, to3d: next3d.p, count: 0, virtual: parentId === null };
        rail.count++;
        branch.set(address, rail);
        cursor = next;
        cursor3d = next3d;
      }
      if (positions.has(node.id)) throw new Error(`Canopy cycle: ${node.id}`);
      const root = domainId ?? node.id;
      positions.set(node.id, { id: node.id, parentId: node.parent, level: node.level,
        domainId: root, address, point: point(cursor), point3d: cursor3d.p,
        label: node.display_label ?? node.title ?? node.id, descendantCount: node.counts?.descendants ?? 0,
        relationCount: 0, relationLoad: { structural: 0, attested: 0, exploratory: 0 } });
      walk(node.id, address, cursor, cursor3d, root);
    });
  };
  walk(null, '', initial, initial3d, null);
  if (positions.size !== nodes.length) throw new Error('Canopy contains a cycle or unreachable node');
  const prefixOccupancy = new Map<string, number>();
  for (const row of positions.values()) for (let length = 1; length <= row.address.length; length++) {
    const prefix = row.address.slice(0, length);
    prefixOccupancy.set(prefix, (prefixOccupancy.get(prefix) ?? 0) + 1);
  }
  // The shared root has one visible stem. Its routing address is not a graph node
  // or a claim of semantic membership.
  branch.set('root', { from: { x: 0, y: initial.step * 0.11, z: 0 },
    to: point(initial), from3d: { x: 0, y: initial.step * 0.11, z: 0 },
    to3d: initial3d.p, count: nodes.length, virtual: true });
  const lineageIds: string[] = [];
  let lineageParent: string | null = null;
  while (true) {
    const next: CanopyInputNode | undefined = (children.get(lineageParent) ?? []).slice().sort((a, b) =>
      (b.counts?.descendants ?? 0) - (a.counts?.descendants ?? 0) ||
      (b.importance?.value ?? 0) - (a.importance?.value ?? 0) || compare(a.id, b.id))[0];
    if (!next) break;
    lineageIds.push(next.id); lineageParent = next.id;
  }
  // Centre the single canopy as one object, preserving every similarity and shared prefix.
  const raw = [...positions.values()].map(row => row.point);
  const centre = (key: keyof CanopyPoint) =>
    (Math.min(0, ...raw.map(value => value[key])) + Math.max(0, ...raw.map(value => value[key]))) / 2;
  const cx = centre('x'), cy = centre('y'), cz = centre('z');
  const shift = (value: CanopyPoint): CanopyPoint => ({ x: value.x - cx, y: value.y - cy, z: value.z - cz });
  const centre3d = (key: keyof CanopyPoint) => {
    const values = [...positions.values()].map(row => row.point3d[key]);
    return (Math.min(0, ...values) + Math.max(0, ...values)) / 2;
  };
  const c3x = centre3d('x'), c3y = centre3d('y'), c3z = centre3d('z');
  const shift3d = (value: CanopyPoint): CanopyPoint =>
    ({ x: value.x - c3x, y: value.y - c3y, z: value.z - c3z });
  for (const [id, row] of positions)
    positions.set(id, { ...row, point: shift(row.point), point3d: shift3d(row.point3d) });

  const bundleMap = new Map<string, { source: string; target: string; class: GraphEdge['class'];
    role: RelationBundle['role'];
    type: string; ids: string[]; crossDomain: boolean }>();
  let crossStructural = 0, crossAttested = 0, crossExploratory = 0;
  const add = (source: string, target: string, edge: GraphEdge, crossDomain: boolean) => {
    const key = [source, target, edge.class, edge.type].join('\u0000');
    const role = edge.type === 'classified_in' ? 'structural' : edge.class;
    const row = bundleMap.get(key) ?? { source, target, class: edge.class, type: edge.type,
      role, ids: [], crossDomain };
    row.ids.push(edge.id); bundleMap.set(key, row);
  };
  for (const edge of edges) {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    if (!source || !target) throw new Error(`Canopy edge endpoint missing: ${edge.id}`);
    if (source.domainId !== target.domainId) {
      if (edge.type === 'classified_in') crossStructural++;
      else if (edge.class === 'attested') crossAttested++; else crossExploratory++;
      add(source.domainId, target.domainId, edge, true);
      continue;
    }
    const ancestors = new Set<string>();
    let cursor: string | null = source.id;
    while (cursor !== null) { ancestors.add(cursor); cursor = positions.get(cursor)?.parentId ?? null; }
    cursor = target.id;
    while (cursor !== null && !ancestors.has(cursor)) cursor = positions.get(cursor)?.parentId ?? null;
    const lca = cursor;
    if (lca === null) throw new Error(`Canopy LCA missing: ${edge.id}`);
    for (const endpoint of [source.id, target.id]) {
      let child = endpoint;
      while (child !== lca) {
        const parent = positions.get(child)?.parentId;
        if (parent === null || parent === undefined) throw new Error(`Canopy path broken: ${edge.id}`);
        add(parent, child, edge, false);
        child = parent;
      }
    }
  }
  const relationBundles = [...bundleMap].sort(([a], [b]) => compare(a, b)).map(([id, row]): RelationBundle => ({
    id: `bundle:${id}`, source: row.source, target: row.target, class: row.class, role: row.role,
    type: row.type, count: row.ids.length, sourceEdgeIds: row.ids.sort(compare), crossDomain: row.crossDomain,
  }));
  const railLoad = new Map<string, CanopyRailLoad>();
  for (const bundle of relationBundles) {
    if (bundle.crossDomain) continue;
    const sourceAddress = positions.get(bundle.source)?.address ?? '';
    const targetAddress = positions.get(bundle.target)?.address ?? '';
    if (!targetAddress.startsWith(sourceAddress)) throw new Error(`Canopy bundle leaves ancestor rail: ${bundle.id}`);
    for (let length = sourceAddress.length + 1; length <= targetAddress.length; length++) {
      const address = targetAddress.slice(0, length);
      const current = railLoad.get(address) ?? { structural: 0, attested: 0, exploratory: 0 };
      railLoad.set(address, { ...current, [bundle.role]: current[bundle.role] + bundle.count });
    }
  }
  const relationByPosition = new Map<string, CanopyRailLoad>();
  const relationByRail = new Map<string, CanopyRailLoad>();
  const addRelation = (map: Map<string, CanopyRailLoad>, key: string, role: keyof CanopyRailLoad) => {
    const current = map.get(key) ?? { structural: 0, attested: 0, exploratory: 0 };
    map.set(key, { ...current, [role]: current[role] + 1 });
  };
  for (const edge of edges) {
    const role = edge.type === 'classified_in' ? 'structural' : edge.class;
    const semanticAncestors = new Set<string>();
    const prefixes = new Set<string>();
    for (const endpoint of [edge.source, edge.target]) {
      let cursor: string | null = endpoint;
      while (cursor) {
        semanticAncestors.add(cursor);
        cursor = positions.get(cursor)?.parentId ?? null;
      }
      const address = positions.get(endpoint)!.address;
      for (let length = 1; length <= address.length; length++) prefixes.add(address.slice(0, length));
    }
    for (const id of semanticAncestors) addRelation(relationByPosition, id, role);
    for (const address of prefixes) addRelation(relationByRail, address, role);
  }
  const totalLoad = (load: CanopyRailLoad) => load.structural + load.attested + load.exploratory;
  for (const [id, row] of positions) {
    const relationLoad = relationByPosition.get(id) ?? { structural: 0, attested: 0, exploratory: 0 };
    positions.set(id, { ...row, relationLoad, relationCount: totalLoad(relationLoad) });
  }
  const railRows = [...branch].sort(([a], [b]) => compare(a, b)).map(([address, rail]): CanopyRail => {
    const relationLoad = relationByRail.get(address) ?? { structural: 0, attested: 0, exploratory: 0 };
    const relationCount = totalLoad(relationLoad);
    const count = address === 'root' ? nodes.length : prefixOccupancy.get(address) ?? 0;
    return { address, ...rail, count, from: shift(rail.from), to: shift(rail.to),
      from3d: shift3d(rail.from3d), to3d: shift3d(rail.to3d), relationCount, relationLoad,
      // Prefix occupancy is real descendant load; relation load is independently
      // counted from real edges. Log scaling keeps a dense domain distinct without
      // drowning the small domains or changing the IFS similarity ratio.
      width: address === 'root' ? 1.5 : Math.min(8,
        0.7 + Math.log1p(count) * 0.36 + Math.log1p(relationCount) * 0.37),
    };
  });
  const coordinates = [...positions.values()].map(row => row.point);
  const extent = (key: keyof CanopyPoint): readonly [number, number] => [
    Math.min(0, ...coordinates.map(value => value[key])), Math.max(0, ...coordinates.map(value => value[key])) ];
  const digest = digestOf([...positions.values()].sort((a, b) => compare(a.id, b.id))
    .map(row => `${row.id}|${row.parentId}|${row.address}|${row.point.x.toFixed(8)}|${row.point.y.toFixed(8)}|${row.point3d.x.toFixed(8)}|${row.point3d.y.toFixed(8)}|${row.point3d.z.toFixed(8)}`));
  return { positions, lineageIds, rails: railRows, railLoad, relationBundles,
    crossDomain: { attested: crossAttested, exploratory: crossExploratory },
    structuralCrossDomain: crossStructural,
    bounds: { x: extent('x'), y: extent('y'), z: extent('z') }, digest };
}
