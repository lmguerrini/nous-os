/** Recursive containment over real primary parents. Natural ON keeps the classic layout-v2 route. */
import { morphologyHash } from '../engine/stable-hash.ts';
import { ABSOLUTE_CONTAINER_ID, LAYOUT_EXTENT, packDiscs, pearlRadius } from '../review/layout-v2.ts';
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';
import type { GuideCurve, TopologyDimension, TopologyLaw, TopologyLayout, TopologyNode, TopologySnapshot, TopologyWitness } from './contract.ts';

export const INDRA_COMPOSE_VERSION = '1';
const cache = new Map<string, TopologyLayout>();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const zero: Point3 = { x: 0, y: 0, z: 0 };
const plus = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const times = (p: Point3, s: number): Point3 => ({ x: p.x * s, y: p.y * s, z: p.z * s });
const length = (p: Point3) => Math.hypot(p.x, p.y, p.z);
const valid = (p: Point3 | undefined, dim: TopologyDimension): p is Point3 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
  (dim === '3d' || Math.abs(p.z) < 1e-9);
type Frame = {
  node: TopologyNode;
  radius: number;
  children: readonly { frame: Frame; offset: Point3 }[];
  witnesses: ReadonlyMap<string, TopologyWitness>;
  guides: readonly GuideCurve[];
  scale: number;
};

function depthOf(id: string): number {
  let n = morphologyHash(id);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

/** The same similarity transforms all sibling coordinates, preserving angles and contractions. */
function locate(
  law: TopologyLaw, frames: readonly Frame[], snapshot: TopologySnapshot, dim: TopologyDimension,
): { offsets: ReadonlyMap<string, Point3>; radius: number; witnesses: ReadonlyMap<string, TopologyWitness>; guides: readonly GuideCurve[]; scale: number } {
  const nodes = frames.map(frame => frame.node);
  const ids = new Set(nodes.map(node => node.id));
  const localSnapshot: TopologySnapshot = {
    digest: snapshot.digest + ':indra:' + nodes.map(node => node.id).join('\0'),
    nodes: nodes.map(node => ({ ...node, parent: null })),
    edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
  };
  const local = law.layoutLocal ? null : law.layoutFull(localSnapshot, dim);
  const points = law.layoutLocal?.(nodes, snapshot, dim) ?? local!.positions;
  if (points.size !== nodes.length) throw new Error('indra-compose: local law must place every real ID exactly once');
  for (const node of nodes)
    if (!valid(points.get(node.id), dim)) throw new Error('indra-compose: invalid local point for ' + node.id);
  const center = times(nodes.reduce((sum, node) => plus(sum, points.get(node.id)!), zero), 1 / nodes.length);
  const gap = Math.max(7, frames.reduce((sum, frame) => sum + frame.radius, 0) / frames.length * 0.08);
  // Classic pearl packing fixes the shell envelope. Local law fixes the directions and ratios.
  const pearls = packDiscs(frames.map(frame => ({ id: frame.node.id, radius: frame.radius })), gap);
  const pearlExtent = Math.max(...frames.map(frame => {
    const p = pearls.get(frame.node.id)!;
    return Math.hypot(p.x, p.y) + p.radius;
  }));
  const centered = nodes.map(node => {
    const p = points.get(node.id)!;
    return { x: p.x - center.x, y: p.y - center.y, z: dim === '3d' ? p.z - center.z : 0 };
  });
  const rawExtent = Math.max(...centered.map(length));
  let scale = rawExtent > 0 ? pearlExtent / rawExtent : 1;
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
    const delta = plus(centered[i]!, times(centered[j]!, -1));
    const d = length(delta);
    if (d < 1e-12) throw new Error('indra-compose: law coincides sibling IDs ' + frames[i]!.node.id + ' and ' + frames[j]!.node.id);
    scale = Math.max(scale, (frames[i]!.radius + frames[j]!.radius + gap) / d);
  }
  if (!Number.isFinite(scale)) throw new Error('indra-compose: non-finite local similarity');
  const offsets = new Map<string, Point3>();
  let radius = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!, point = times(centered[i]!, scale);
    offsets.set(frame.node.id, point);
    radius = Math.max(radius, length(point) + frame.radius + gap);
  }
  const guides = (local?.guides ?? []).map(guide => ({
    ...guide,
    points: guide.points.map(p => times({
      x: p.x - center.x, y: p.y - center.y, z: dim === '3d' ? p.z - center.z : 0,
    }, scale)),
    semantic: false as const,
  }));
  return { offsets, radius: radius / 0.94, witnesses: local?.witnesses ?? new Map(), guides, scale };
}

export function composeIndra(law: TopologyLaw, snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  if (law.id === 'natural') throw new Error('indra-compose: Natural ON uses the approved classic route');
  const support = law.supports(dimension);
  if (!support.ok) throw new Error(support.reason);
  const key = JSON.stringify([snapshot.digest, law.id, law.version, dimension, INDRA_COMPOSE_VERSION]);
  const hit = cache.get(key);
  if (hit) return hit;

  const byId = new Map<string, TopologyNode>();
  for (const node of snapshot.nodes) {
    if (byId.has(node.id) || node.id === ABSOLUTE_CONTAINER_ID)
      throw new Error('indra-compose: duplicate or reserved real ID ' + node.id);
    byId.set(node.id, node);
  }
  const children = new Map<string | null, TopologyNode[]>();
  for (const node of snapshot.nodes) {
    if (node.parent && !byId.has(node.parent)) throw new Error('indra-compose: missing primary parent for ' + node.id);
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => cmp(a.id, b.id));
  const visiting = new Set<string>(), measured = new Set<string>();
  const measure = (node: TopologyNode): Frame => {
    if (visiting.has(node.id)) throw new Error('indra-compose: primary hierarchy cycle at ' + node.id);
    visiting.add(node.id);
    const descendants = (children.get(node.id) ?? []).map(measure);
    const local = descendants.length ? locate(law, descendants, snapshot, dimension) : null;
    const frame: Frame = {
      node,
      radius: Math.max(pearlRadius(node), local?.radius ?? 0),
      children: descendants.map(child => ({ frame: child, offset: local!.offsets.get(child.node.id)! })),
      witnesses: local?.witnesses ?? new Map(),
      guides: local?.guides ?? [],
      scale: local?.scale ?? 1,
    };
    if (!Number.isFinite(frame.radius)) throw new Error('indra-compose: non-finite shell for ' + node.id);
    visiting.delete(node.id);
    measured.add(node.id);
    return frame;
  };
  const roots = (children.get(null) ?? []).map(measure);
  if (measured.size !== byId.size) throw new Error('indra-compose: primary hierarchy is not a rooted forest');
  const mean = roots.reduce((sum, root) => sum + root.radius, 0) / Math.max(1, roots.length);
  const gap = Math.max(12, mean * 0.1);
  const ordered = [...roots].sort((a, b) => b.radius - a.radius || cmp(a.node.id, b.node.id));
  const largest = ordered[0]?.radius ?? 0;
  const coreCount = ordered.length <= 64 ? ordered.filter(root => root.radius >= largest * 0.55).length : 0;
  const packed = packDiscs(ordered.map(root => ({ id: root.node.id, radius: root.radius })), gap, coreCount);
  const discs = ordered.map(root => ({ id: root.node.id, ...packed.get(root.node.id)! }));
  if (discs.length && !(coreCount >= 3 && coreCount <= 12)) {
    const dx = (Math.min(...discs.map(d => d.x - d.radius)) + Math.max(...discs.map(d => d.x + d.radius))) / 2;
    const dy = (Math.min(...discs.map(d => d.y - d.radius)) + Math.max(...discs.map(d => d.y + d.radius))) / 2;
    for (const d of discs) { d.x -= dx; d.y -= dy; }
  }
  const radius2d = discs.reduce((r, d) => Math.max(r, Math.hypot(d.x, d.y) + d.radius), 0) / 0.94;
  const rootOffsets = new Map(discs.map(d => [d.id, {
    x: d.x, y: d.y, z: dimension === '3d' ? depthOf(d.id) * radius2d * 0.62 : 0,
  }]));
  // The full law provides the canonical witness when layoutLocal supplies coordinates only.
  const full = law.layoutLocal ? law.layoutFull(snapshot, dimension) : null;
  const positions = new Map<string, Point3>();
  const containers: LayoutContainer[] = [];
  const witnesses = new Map<string, TopologyWitness>();
  const guides: GuideCurve[] = [];
  const place = (frame: Frame, point: Point3, path: readonly string[],
    localWitnesses: ReadonlyMap<string, TopologyWitness>, placementScale: number): void => {
    const nextPath = [...path, frame.node.id];
    positions.set(frame.node.id, point);
    if (frame.children.length || frame.node.level === 1)
      containers.push({ id: frame.node.id, level: frame.node.level, center: point, radius: frame.radius, open: !!frame.children.length, title: frame.node.title });
    const witness = localWitnesses.get(frame.node.id) ?? full?.witnesses.get(frame.node.id);
    if (!witness) throw new Error('indra-compose: missing law witness for ' + frame.node.id);
    witnesses.set(frame.node.id, {
      ...witness,
      values: { ...witness.values, containerPath: nextPath.join(' / '), frameScale: placementScale,
        frameX: point.x, frameY: point.y, frameZ: point.z },
      text: witness.text + ' Contenitore primario: ' + nextPath.join(' / ') + '.',
    });
    for (const guide of frame.guides)
      guides.push({ ...guide, id: 'indra:' + frame.node.id + ':' + guide.id,
        points: guide.points.map(p => plus(point, p)), semantic: false });
    for (const child of frame.children) place(child.frame, plus(point, child.offset), nextPath, frame.witnesses, frame.scale);
  };
  // A root has no local sibling witness unless layoutFull is called for that forest.
  const rootLaw = law.layoutLocal ? null : law.layoutFull({
    digest: snapshot.digest + ':indra:roots',
    nodes: roots.map(root => root.node), edges: [],
  }, dimension);
  for (const root of roots) place(root, rootOffsets.get(root.node.id)!, [], rootLaw?.witnesses ?? new Map(), 1);
  // A route refers to its source edge ID and is explicitly non-semantic. The caller still
  // owns the original edge; this curve only follows primary containers through their LCA.
  for (const edge of snapshot.edges) {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    if (!source || !target) throw new Error('indra-compose: edge endpoint is not a real ID: ' + edge.id);
    const ancestry = (id: string) => {
      const chain = [id];
      let parent = byId.get(id)!.parent;
      while (parent) { chain.push(parent); parent = byId.get(parent)!.parent; }
      return chain;
    };
    const a = ancestry(edge.source), b = ancestry(edge.target);
    const bSet = new Set(b);
    const lca = a.find(id => bSet.has(id));
    if (lca === edge.source || lca === edge.target) continue;
    const route = lca
      ? [...a.slice(0, a.indexOf(lca) + 1), ...b.slice(0, b.indexOf(lca)).reverse()]
      : [...a, ABSOLUTE_CONTAINER_ID, ...b.reverse()];
    guides.push({ id: 'indra-route:' + edge.id, kind: 'indra-real-edge-route', semantic: false,
      points: route.map(id => id === ABSOLUTE_CONTAINER_ID ? zero : positions.get(id)!) });
  }
  const extent = containers.reduce((r, shell) => Math.max(r, length(shell.center) + shell.radius),
    [...positions.values()].reduce((r, point) => Math.max(r, length(point)), 0));
  const globalScale = extent > LAYOUT_EXTENT ? LAYOUT_EXTENT / extent : 1;
  if (globalScale !== 1) {
    for (const [id, point] of positions) positions.set(id, times(point, globalScale));
    for (let i = 0; i < containers.length; i++) {
      const shell = containers[i]!;
      containers[i] = { ...shell, center: times(shell.center, globalScale), radius: shell.radius * globalScale };
    }
    for (let i = 0; i < guides.length; i++) {
      const guide = guides[i]!;
      guides[i] = { ...guide, points: guide.points.map(p => times(p, globalScale)) };
    }
    for (const [id, witness] of witnesses) {
      witnesses.set(id, { ...witness, values: { ...witness.values,
        frameScale: (witness.values.frameScale as number) * globalScale,
        frameX: (witness.values.frameX as number) * globalScale,
        frameY: (witness.values.frameY as number) * globalScale,
        frameZ: (witness.values.frameZ as number) * globalScale } });
    }
  }
  containers.unshift({ id: ABSOLUTE_CONTAINER_ID, level: 0, center: zero,
    radius: Math.max(extent * globalScale / 0.94, 1), radius2d: radius2d * globalScale, open: true, title: 'NousOS' });
  const result: TopologyLayout = {
    positions, containers, witnesses, guides,
    diagnostics: [
      { code: 'real-node-count', value: positions.size, acceptable: positions.size === snapshot.nodes.length },
      { code: 'real-edge-count', value: snapshot.edges.length, acceptable: true },
      { code: 'primary-path-count', value: witnesses.size, acceptable: witnesses.size === snapshot.nodes.length },
      { code: 'global-similarity-scale', value: globalScale, acceptable: Number.isFinite(globalScale) && globalScale > 0 },
    ],
  };
  cache.set(key, result);
  return result;
}
