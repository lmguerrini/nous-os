/** Recursive containment over real primary parents. Natural ON keeps the classic layout-v2 route. */
import { morphologyHash } from '../engine/stable-hash.ts';
import { ABSOLUTE_CONTAINER_ID, LAYOUT_EXTENT, packDiscs, pearlRadius } from '../review/layout-v2.ts';
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';
import type { GuideCurve, TopologyDimension, TopologyLaw, TopologyLayout, TopologyNode, TopologySnapshot, TopologyWitness } from './contract.ts';
// D085-S5 BEGIN: the Figure A radius is the exported reference for the composed root ring.
import { LULL_OUTER_RADIUS } from './lull.ts';
import { LULL_LETTERS } from './lull-inquiry.ts';
// D085-S5 END

// D085-S5 BEGIN: chart and root-ring layouts require a fresh cache key.
export const INDRA_COMPOSE_VERSION = '3';
// D085-S5 END
const cache = new Map<string, TopologyLayout>();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const zero: Point3 = { x: 0, y: 0, z: 0 };
const plus = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const times = (p: Point3, s: number): Point3 => ({ x: p.x * s, y: p.y * s, z: p.z * s });
const length = (p: Point3) => Math.hypot(p.x, p.y, p.z);
// D085-S5 BEGIN: Julia atlas segments are clipped to their real parent pearl.
function clipJuliaSegment(points: readonly Point3[], radius: number): readonly Point3[] {
  if (points.length !== 2) return [];
  const a = points[0]!, b = points[1]!;
  const d = plus(b, times(a, -1));
  const aa = d.x * d.x + d.y * d.y + d.z * d.z;
  if (aa <= 1e-18) return [];
  const bb = 2 * (a.x * d.x + a.y * d.y + a.z * d.z);
  const cc = a.x * a.x + a.y * a.y + a.z * a.z - radius * radius;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant <= 0) return [];
  const low = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
  const high = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
  if (high <= low) return [];
  return [plus(a, times(d, low)), plus(a, times(d, high))];
}
// D085-S5 END
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
  // D085-S5 BEGIN
  center: Point3;
  original: ReadonlyMap<string, Point3>;
  oneChild: boolean;
  // D085-S5 END
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
): { offsets: ReadonlyMap<string, Point3>; radius: number; witnesses: ReadonlyMap<string, TopologyWitness>; guides: readonly GuideCurve[]; scale: number;
  center: Point3; original: ReadonlyMap<string, Point3>; oneChild: boolean } {
  const nodes = frames.map(frame => frame.node);
  // D085-S5 BEGIN: Llull's nine-domain rule applies between roots only. Inside a
  // root, classic deterministic packing is a containment convention, not a letter law.
  if (law.id === 'lull') {
    const gap = Math.max(7, frames.reduce((sum, frame) => sum + frame.radius, 0) / frames.length * 0.08);
    const packed = packDiscs(frames.map(frame => ({ id: frame.node.id, radius: frame.radius })), gap);
    const offsets = new Map(frames.map(frame => { const p = packed.get(frame.node.id)!;
      return [frame.node.id, { x: p.x, y: p.y, z: 0 }] as const; }));
    const radius = Math.max(...frames.map(frame => length(offsets.get(frame.node.id)!) + frame.radius + gap)) / 0.94;
    const witnesses = new Map(frames.map(frame => [frame.node.id, { law: 'Llull',
      values: { localPacking: 'Indra' }, text: 'Posizione interna: perla della gerarchia primaria; la legge delle nove lettere vale fra le perle radice.' }] as const));
    return { offsets, radius, witnesses, guides: [], scale: 1, center: zero,
      original: offsets, oneChild: frames.length === 1 };
  }
  // D085-S5 END
  // D082-LAB-FIX2 BEGIN: local laws already use the certified full snapshot.
  // Avoid scanning all 15,800 relations for every recursive container.
  const local = law.layoutChart?.(nodes, snapshot, dim) ?? (law.layoutLocal ? null : (() => {
    const ids = new Set(nodes.map(node => node.id));
    const localSnapshot: TopologySnapshot = {
      digest: snapshot.digest + ':indra:' + nodes.map(node => node.id).join('\0'),
      nodes: nodes.map(node => ({ ...node, parent: null })),
      edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    };
    return law.layoutFull(localSnapshot, dim);
  })());
  // D082-LAB-FIX2 END
  const points = law.layoutLocal?.(nodes, snapshot, dim) ?? local!.positions;
  if (points.size !== nodes.length) throw new Error('indra-compose: local law must place every real ID exactly once');
  for (const node of nodes)
    if (!valid(points.get(node.id), dim)) throw new Error('indra-compose: invalid local point for ' + node.id);
  const center = times(nodes.reduce((sum, node) => plus(sum, points.get(node.id)!), zero), 1 / nodes.length);
  const gap = Math.max(7, frames.reduce((sum, frame) => sum + frame.radius, 0) / frames.length * 0.08);
  // D082-LAB-FIX2 BEGIN: a one-child container still has a real contains edge.
  // Its local centroid is the child, so centring would otherwise collapse that edge.
  if (frames.length === 1) {
    const frame = frames[0]!;
    const source = points.get(frame.node.id)!;
    const magnitude = length(source);
    const angle = depthOf(frame.node.id) * Math.PI;
    const direction = magnitude > 1e-9 ? times(source, 1 / magnitude)
      : { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
    const offset = times(direction, frame.radius + gap);
    return { offsets: new Map([[frame.node.id, offset]]),
      radius: (length(offset) + frame.radius + gap) / 0.94,
      witnesses: local?.witnesses ?? new Map(), guides: [], scale: 1,
      center, original: points, oneChild: true };
  }
  // D082-LAB-FIX2 END
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
  return { offsets, radius: radius / 0.94, witnesses: local?.witnesses ?? new Map(), guides, scale,
    center, original: points, oneChild: false };
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
      // D085-S5 BEGIN
      center: local?.center ?? zero,
      original: local?.original ?? new Map(),
      oneChild: local?.oneChild ?? false,
      // D085-S5 END
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
  let radius2d = discs.reduce((r, d) => Math.max(r, Math.hypot(d.x, d.y) + d.radius), 0) / 0.94;
  let rootOffsets = new Map(discs.map(d => [d.id, {
    x: d.x, y: d.y, z: dimension === '3d' ? depthOf(d.id) * radius2d * 0.62 : 0,
  }]));
  // D085-S5 BEGIN: exact nine-root Figure A law, with the least nonoverlapping radius.
  let lullRingRadius = 0;
  const lullRootIndex = new Map<string, number>();
  if (law.id === 'lull') {
    if (dimension !== '2d' || roots.length !== 9) throw new Error('Llull con Indra richiede nove domini reali in 2D.');
    const ringRoots = [...roots].sort((a, b) => cmp(a.node.id, b.node.id));
    ringRoots.forEach((root, i) => lullRootIndex.set(root.node.id, i));
    for (let i = 0; i < ringRoots.length; i++) for (let j = i + 1; j < ringRoots.length; j++) {
      const step = Math.min(j - i, ringRoots.length - (j - i));
      lullRingRadius = Math.max(lullRingRadius, (ringRoots[i]!.radius + ringRoots[j]!.radius + gap)
        / (2 * Math.sin(Math.PI * step / ringRoots.length)));
    }
    rootOffsets = new Map(ringRoots.map((root, i) => [root.node.id, {
      x: lullRingRadius * Math.cos(-Math.PI / 2 + 2 * Math.PI * i / ringRoots.length),
      y: lullRingRadius * Math.sin(-Math.PI / 2 + 2 * Math.PI * i / ringRoots.length), z: 0 }]));
    radius2d = (lullRingRadius + Math.max(...ringRoots.map(root => root.radius))) / 0.94;
  }
  // D085-S5 END
  // The full law provides the canonical witness when layoutLocal supplies coordinates only.
  const full = law.layoutLocal ? law.layoutFull(snapshot, dimension) : null;
  const positions = new Map<string, Point3>();
  const containers: LayoutContainer[] = [];
  const witnesses = new Map<string, TopologyWitness>();
  const guides: GuideCurve[] = [];
  const place = (frame: Frame, point: Point3, path: readonly string[],
    localWitnesses: ReadonlyMap<string, TopologyWitness>, placementScale: number,
    parentPoint: Point3, chartCenter: Point3, originalPoint: Point3, oneChild: boolean): void => {
    const nextPath = [...path, frame.node.id];
    positions.set(frame.node.id, point);
    if (frame.children.length || frame.node.level === 1)
      containers.push({ id: frame.node.id, level: frame.node.level, center: point, radius: frame.radius, open: !!frame.children.length, title: frame.node.title });
    const fullWitness = full?.witnesses.get(frame.node.id);
    const witness = localWitnesses.get(frame.node.id) ?? fullWitness;
    if (!witness) throw new Error('indra-compose: missing law witness for ' + frame.node.id);
    witnesses.set(frame.node.id, {
      ...witness,
      // D085-S5 BEGIN: Llull's original source relation IDs survive even though
      // its global record-band coordinates do not govern placement inside pearls.
      ...(law.id === 'lull' ? { address: nextPath.join(' / ') } : {}),
      // D085-S5 END
      values: { ...witness.values, containerPath: nextPath.join(' / '), frameScale: placementScale,
        frameX: point.x, frameY: point.y, frameZ: point.z,
        // D085-S5 BEGIN: q = μ + (x - parentFrame) / chartScale, before global fit.
        chartMuX: chartCenter.x, chartMuY: chartCenter.y, chartMuZ: chartCenter.z,
        parentFrameX: parentPoint.x, parentFrameY: parentPoint.y, parentFrameZ: parentPoint.z,
        originalX: originalPoint.x, originalY: originalPoint.y, originalZ: originalPoint.z,
        oneChildConvention: oneChild ? 'shell separation, not a branch' : 'none',
        rootZConvention: dimension === '3d' ? 'id-hash display convention' : 'planar',
        rootPlacement: path.length ? 'inside primary pearl' : law.id === 'lull'
          ? 'nine-domain Figure A ring' : 'Indra root disc packing',
        globalScale: 1,
        ...(law.id === 'lull' ? { rootRingRadius: lullRingRadius,
          figureARadius: LULL_OUTER_RADIUS,
          rootLetter: LULL_LETTERS[lullRootIndex.get(nextPath[0]!) ?? 0]!,
          rootAngle: -Math.PI / 2 + 2 * Math.PI * (lullRootIndex.get(nextPath[0]!) ?? 0) / 9,
          relationIds: fullWitness?.values.relationIds ?? '' } : {}),
        ...(law.id === 'sierpinski' ? { displayedConvergenceBound:
          Number(witness.values.convergenceBound ?? 0) * placementScale } : {}) },
      text: witness.text + ' Contenitore primario: ' + nextPath.join(' / ') + '.'
        + (path.length ? '' : law.id === 'lull'
          ? ' La posizione radice segue il cerchio a nove domini di Figura A.'
          : ' La posizione radice segue l’impacchettamento Indra, non la legge locale.'),
    });
    for (const guide of frame.guides) {
      // D085-S5 BEGIN: the global Julia curve is only a chart inside this pearl.
      const localPoints = law.id === 'julia' ? clipJuliaSegment(guide.points, frame.radius) : guide.points;
      if (localPoints.length < 2) continue;
      guides.push({ ...guide, id: 'indra:' + frame.node.id + ':' + guide.id,
        points: localPoints.map(p => plus(point, p)), semantic: false });
      // D085-S5 END
    }
    for (const child of frame.children) place(child.frame, plus(point, child.offset), nextPath,
      frame.witnesses, frame.scale, point, frame.center,
      frame.original.get(child.frame.node.id) ?? child.offset, frame.oneChild);
  };
  // A root has no local sibling witness unless layoutFull is called for that forest.
  const rootLaw = law.layoutLocal ? null : law.layoutFull({
    digest: snapshot.digest + ':indra:roots',
    nodes: roots.map(root => root.node), edges: [],
  }, dimension);
  for (const root of roots) place(root, rootOffsets.get(root.node.id)!, [], rootLaw?.witnesses ?? new Map(), 1,
    zero, zero, rootOffsets.get(root.node.id)!, false);
  // D085-S5 BEGIN: Figure A is a guide field between the real root pearls.
  if (law.id === 'lull' && lullRingRadius > 0) {
    const figure = law.layoutFull(snapshot, dimension);
    for (const guide of figure.guides.filter(g =>
      g.kind === 'lull-figure-a' || g.kind === 'lull-letter' || g.kind === 'lull-sector-ray'))
      guides.push({ ...guide, id: 'indra-root:' + guide.id,
        points: guide.points.map(p => times(p, lullRingRadius / LULL_OUTER_RADIUS)), semantic: false });
  }
  // D085-S5 END
  // D085-S5 BEGIN: route-shaped hints are omitted until the renderer can pass
  // the exact eligible source-edge IDs. Real relations remain in the edge layer.
  // D085-S5 END
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
        frameZ: (witness.values.frameZ as number) * globalScale,
        // D085-S5 BEGIN: the fitted coordinate still inverts through this scale.
        parentFrameX: (witness.values.parentFrameX as number) * globalScale,
        parentFrameY: (witness.values.parentFrameY as number) * globalScale,
        parentFrameZ: (witness.values.parentFrameZ as number) * globalScale,
        ...(law.id === 'sierpinski' ? { displayedConvergenceBound:
          Number(witness.values.displayedConvergenceBound) * globalScale } : {}),
        globalScale } });
        // D085-S5 END
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
      // D085-S5 BEGIN: shell and guide counts are inspectable with the law result.
      { code: 'pearl-shell-count', value: containers.length - 1, acceptable: true },
      { code: 'topology-guide-count', value: guides.length, acceptable: true },
      { code: 'eligible-real-edge-route-count', value: 0, acceptable: true },
      // D085-S5 END
    ],
  };
  cache.set(key, result);
  return result;
}

// D085-S5 BEGIN: deterministic reference-frame legibility certificate for Julia charts.
export function assessJuliaIndraLegibility(snapshot: TopologySnapshot, layout: TopologyLayout): Readonly<{
  eligible: number; passing: number; share: number; ok: boolean }> {
  const children = new Map<string, string[]>();
  for (const node of snapshot.nodes) if (node.parent) {
    const list = children.get(node.parent) ?? []; list.push(node.id); children.set(node.parent, list);
  }
  const shells = new Map(layout.containers.map(shell => [shell.id, shell]));
  const extent = Math.max(...layout.containers.map(shell => Math.hypot(shell.center.x, shell.center.y) + shell.radius));
  const pixelsPerUnit = extent ? 0.8 * 1200 / (2 * extent) : 0;
  let eligible = 0, passing = 0;
  for (const [parent, ids] of children) {
    if (ids.length < 3) continue;
    const shell = shells.get(parent);
    if (!shell) continue;
    eligible++;
    const point = ids.map(id => layout.positions.get(id)!).filter(Boolean);
    const separated = point.filter((p, i) => point.every((q, j) => i === j ||
      Math.hypot(p.x - q.x, p.y - q.y) * pixelsPerUnit >= 8)).length >= 3;
    const prefix = 'indra:' + parent + ':';
    const visibleGuide = layout.guides.some(guide => guide.id.startsWith(prefix)
      && guide.points.some((p, i) => i > 0
        && Math.hypot(p.x - guide.points[i - 1]!.x, p.y - guide.points[i - 1]!.y) * pixelsPerUnit >= 16
        && Math.hypot(p.x - shell.center.x, p.y - shell.center.y) <= shell.radius
        && Math.hypot(guide.points[i - 1]!.x - shell.center.x,
          guide.points[i - 1]!.y - shell.center.y) <= shell.radius));
    if (separated && visibleGuide) passing++;
  }
  const share = eligible ? passing / eligible : 0;
  return { eligible, passing, share, ok: passing >= 9 && share >= 0.25 };
}
// D085-S5 END
