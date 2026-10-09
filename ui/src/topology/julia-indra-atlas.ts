// D087-JULIA BEGIN
/** A progressive, source-only Julia atlas. No chart point is a new graph node. */
import type { Point3, LayoutContainer } from '../review/layout-v2.ts';
import { ABSOLUTE_CONTAINER_ID } from '../review/layout-v2.ts';
import type { GuideCurve, TopologyDimension, TopologyLayout, TopologySnapshot, TopologyWitness } from './contract.ts';
import { juliaLaw } from './julia.ts';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);
const distance3 = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const REFERENCE_WIDTH = 1000;
const RIM_PX = 8;
const GAP_PX = 3;
// D087-JULIA BEGIN: the observed overview needs at least forty real, counted
// closed rims in each dimension at the fitted reference frame.
const OVERVIEW_MIN_CLOSED = 40;
const OVERVIEW_MIN_SHARE = 0.8;
const FOCUS_REFERENCE_RIM_PX = 400;
const CHILD_GAP_PX = 10;
// D087-JULIA END

/** Density reveals more real closed parents without changing any Julia address. */
export function juliaOverviewPearlQuota(density: 'essential' | 'balanced' | 'complete' | 'custom',
  customNodes: number | undefined, available: number): number {
  const target = density === 'essential' ? 43 : density === 'balanced' ? 45
    : density === 'complete' ? available : 43 + Math.floor(Math.max(0, customNodes ?? 0) / 2000);
  return Math.min(available, Math.max(0, target));
}

export type JuliaAtlasCertificate = Readonly<{
  snapshotDigest: string; dimension: TopologyDimension; phase: 'overview' | 'opened';
  eligibleParents: number; closedPearlsSubmitted: number; closedPearlsDrawn: number; openPassing: number;
  openEligible: number; childSeparationMinPx: number; insideGuideMaxPx: number;
  shellOverlapCount: number; focusedParent: string | null; ok: boolean;
  closedPearlsRequired: number; closedPearlShare: number; minimumRimPx: number;
  focusReferenceRimPx: number;
}>;
export type JuliaAtlasLayout = TopologyLayout & Readonly<{
  atlas: JuliaAtlasCertificate;
  /** Real ids that this phase proposes to draw; density may remove members. */
  phaseNodeIds: ReadonlySet<string>;
  hiddenDescendants: ReadonlyMap<string, number>;
}>;
// D087-JULIA BEGIN: the first mounted atlas and the subsequent source
// preflight share the same complete layout in the worker, keyed by its digest.
const overviewCache = new Map<string, JuliaAtlasLayout>();
// D087-JULIA END

/** A pending taxonomy can still expose the previous law layout to status readers. */
export function isJuliaAtlasLayout(layout: TopologyLayout | null | undefined): layout is JuliaAtlasLayout {
  return !!layout && 'atlas' in layout && 'phaseNodeIds' in layout
    && 'hiddenDescendants' in layout;
}

function clipSegment(a: Point3, b: Point3, center: Point3, radius: number): readonly Point3[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ox = a.x - center.x, oy = a.y - center.y;
  const aa = dx * dx + dy * dy;
  if (aa <= 1e-20) return [];
  const bb = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - radius * radius;
  const disc = bb * bb - 4 * aa * cc;
  if (disc <= 0) return [];
  const lo = Math.max(0, (-bb - Math.sqrt(disc)) / (2 * aa));
  const hi = Math.min(1, (-bb + Math.sqrt(disc)) / (2 * aa));
  if (hi <= lo) return [];
  const at = (t: number): Point3 => ({ x: a.x + dx * t, y: a.y + dy * t, z: a.z + (b.z - a.z) * t });
  return [at(lo), at(hi)];
}

/** Reserve the nearest clear screen location to each certified Julia address.
 * The original address remains in the witness; only its glyph is displaced. */
function separateJuliaGlyphs(ids: readonly string[], originals: ReadonlyMap<string, Point3>,
  parent: Point3, radius: number): ReadonlyMap<string, Point3> {
  const pixels = FOCUS_REFERENCE_RIM_PX / radius;
  const ordered = [...ids].sort((a, b) => {
    const aa = originals.get(a)!, bb = originals.get(b)!;
    return Math.atan2(aa.y - parent.y, aa.x - parent.x)
      - Math.atan2(bb.y - parent.y, bb.x - parent.x) || compare(a, b);
  });
  const placed = new Map<string, Point3>();
  const used: { x: number; y: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (const id of ordered) {
    const source = originals.get(id)!;
    const x = (source.x - parent.x) * pixels, y = (source.y - parent.y) * pixels;
    let chosen: { x: number; y: number } | null = null;
    for (let index = 0; index < 8192; index++) {
      const distance = index === 0 ? 0 : CHILD_GAP_PX * Math.sqrt(index);
      const angle = index * golden;
      const candidate = { x: x + distance * Math.cos(angle), y: y + distance * Math.sin(angle) };
      if (Math.hypot(candidate.x, candidate.y) > FOCUS_REFERENCE_RIM_PX - 24) continue;
      if (used.every(other => Math.hypot(candidate.x - other.x, candidate.y - other.y) >= CHILD_GAP_PX)) {
        chosen = candidate; break;
      }
    }
    if (!chosen) throw new Error(`julia atlas: no legible glyph location for ${id}`);
    used.push(chosen);
    placed.set(id, { x: parent.x + chosen.x / pixels, y: parent.y + chosen.y / pixels, z: source.z });
  }
  return placed;
}

function segmentTouchesViewport(a: Readonly<{ x: number; y: number }>,
  b: Readonly<{ x: number; y: number }>, viewport: Readonly<{ width: number; height: number }>): boolean {
  let lo = 0, hi = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x], [dx, viewport.width - a.x],
    [-dy, a.y], [dy, viewport.height - a.y]] as const) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

/** The same certified data-space window used by Julia's restricted chart. */
function chartGuidesFromFull(full: TopologyLayout, points: readonly Point3[]): GuideCurve[] {
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1;
  return full.guides.flatMap(guide => guide.points.slice(1).flatMap((b, i) => {
    const a = guide.points[i]!;
    let lo = 0, hi = 1;
    const bounds: readonly [number, number][] = [
      [-(b.x - a.x), a.x - (minX - pad)],
      [b.x - a.x, (maxX + pad) - a.x],
      [-(b.y - a.y), a.y - (minY - pad)],
      [b.y - a.y, (maxY + pad) - a.y],
    ];
    for (const [p, q] of bounds) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return []; continue; }
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    }
    if (lo >= hi) return [];
    const at = (t: number): Point3 => ({ x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    return [{ id: `${guide.id}:chart:${i}`, kind: guide.kind, semantic: false as const,
      points: [at(lo), at(hi)] }];
  }));
}

/** Build from one complete Julia law certificate. A focus recomposes only its one chart. */
export function composeJuliaIndraAtlas(snapshot: TopologySnapshot, dimension: TopologyDimension,
  focusedParent: string | null = null, referenceWidth = REFERENCE_WIDTH,
  sourceFull?: TopologyLayout): JuliaAtlasLayout {
  // D087-JULIA BEGIN
  const cacheKey = `${snapshot.digest}|${dimension}|${referenceWidth}|${snapshot.nodes.length}|${snapshot.edges.length}`;
  if (focusedParent === null && !sourceFull) {
    const cached = overviewCache.get(cacheKey);
    if (cached) return cached;
  }
  // D087-JULIA END
  const full = sourceFull ?? juliaLaw.layoutFull(snapshot, dimension);
  if (sourceFull && sourceFull.positions.size !== snapshot.nodes.length)
    throw new Error('julia atlas: incomplete reused global certificate');
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of snapshot.nodes) if (node.parent) {
    const group = children.get(node.parent) ?? [];
    group.push(node.id); children.set(node.parent, group);
  }
  for (const group of children.values()) group.sort(compare);
  const descendants = new Map<string, number>();
  const count = (id: string, visiting = new Set<string>()): number => {
    if (visiting.has(id)) throw new Error('julia atlas: primary hierarchy cycle');
    if (descendants.has(id)) return descendants.get(id)!;
    visiting.add(id);
    const total = (children.get(id) ?? []).reduce((sum, child) => sum + 1 + count(child, visiting), 0);
    visiting.delete(id); descendants.set(id, total);
    return total;
  };
  for (const id of nodes.keys()) count(id);
  const eligible = [...children].filter(([, ids]) => ids.length >= 3).map(([id]) => id)
    .sort((a, b) => nodes.get(a)!.level - nodes.get(b)!.level || compare(a, b));
  const fullExtent = Math.max(1, ...[...full.positions.values()].map(p => Math.hypot(p.x, p.y)),
    ...full.guides.flatMap(g => g.points.map(p => Math.hypot(p.x, p.y))));
  const px = 0.8 * referenceWidth / (2 * fullExtent);
  const rim = RIM_PX / px;
  const gap = GAP_PX / px;
  // D087-JULIA BEGIN: the default oblique 3D camera compresses one screen axis.
  // A wider source-space gap keeps the visible rims disjoint at its fitted pose.
  const admissionGap = (dimension === '3d' ? 7 : GAP_PX) / px;
  // D087-JULIA END
  let admitted: string[] = [];
  // Stable codepoint order makes the choice independent of snapshot iteration order.
  for (const id of eligible) {
    const point = full.positions.get(id)!;
    if (admitted.every(other => distance(point, full.positions.get(other)!) >= 2 * rim + admissionGap)) admitted.push(id);
  }
  // D087-JULIA BEGIN: a closed pearl promises a readable open chart. Exclude
  // candidate rims whose real children fail in the pinned focus reference.
  if (focusedParent === null) admitted = admitted.filter(id => {
    const opened = composeJuliaIndraAtlas(snapshot, dimension, id, referenceWidth, full);
    const shell = opened.containers.find(container => container.id === id)!;
    const focusPx = FOCUS_REFERENCE_RIM_PX / shell.radius;
    return certifyJuliaAtlasDrawing(opened, snapshot, {
      nodeIds: opened.phaseNodeIds, shellIds: new Set([id]), countedShellIds: new Set(),
      guideIds: new Set(opened.guides.map(guide => guide.id)),
      project: point => ({ x: point.x * focusPx, y: point.y * focusPx }),
      shellRadiusPx: container => container.radius * focusPx,
    }).ok;
  });
  // D087-JULIA END
  const containers: LayoutContainer[] = admitted.map(id => ({ id, level: nodes.get(id)!.level,
    center: full.positions.get(id)!, radius: rim, open: false, title: nodes.get(id)!.title }));
  const positions = new Map(full.positions);
  const witnesses = new Map(full.witnesses);
  const phaseNodeIds = new Set(admitted);
  const guides: GuideCurve[] = focusedParent === null ? [...full.guides] : [];
  for (const id of admitted) {
    const witness = full.witnesses.get(id)!;
    witnesses.set(id, { ...witness, values: { ...witness.values,
      atlasPhase: 'closed', hiddenDescendants: descendants.get(id)! },
      text: witness.text + ` Perla chiusa: ${descendants.get(id)!} discendenti primari reali nascosti; il bordo è una guida strutturale, non una relazione.` });
  }
  let openEligible = 0;
  if (focusedParent !== null) {
    const ids = children.get(focusedParent) ?? [];
    if (!nodes.has(focusedParent) || ids.length < 3) throw new Error('julia atlas: focus needs a real eligible parent');
    openEligible = 1;
    const parent = full.positions.get(focusedParent)!;
    const points = ids.map(id => full.positions.get(id)!);
    const mu: Point3 = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length, z: 0 };
    const chartGuides = sourceFull ? chartGuidesFromFull(full, points)
      : juliaLaw.layoutChart!(ids.map(id => nodes.get(id)!), snapshot, dimension).guides;
    const sourceLongest = Math.max(0, ...chartGuides.map(g => distance(g.points[0]!, g.points[1]!)));
    const scale = Math.max(1, 20 / Math.max(1e-12, sourceLongest * px));
    const transform = (p: Point3): Point3 => ({ x: parent.x + scale * (p.x - mu.x),
      y: parent.y + scale * (p.y - mu.y), z: p.z });
    const chartPositions = new Map(ids.map(id => [id, transform(full.positions.get(id)!)]));
    const radius = Math.max(rim, ...[...chartPositions.values()].map(p => distance3(p, parent) + 2 / px),
      ...chartGuides.flatMap(g => g.points.map(p => distance3(transform(p), parent) + 1 / px))) / 0.6;
    const separated = separateJuliaGlyphs(ids, chartPositions, parent, radius);
    containers.length = 0;
    containers.push({ id: focusedParent, level: nodes.get(focusedParent)!.level,
      center: parent, radius, open: true, title: nodes.get(focusedParent)!.title });
    phaseNodeIds.clear(); phaseNodeIds.add(focusedParent);
    const parentWitness = full.witnesses.get(focusedParent)!;
    witnesses.set(focusedParent, { ...parentWitness, values: { ...parentWitness.values,
      atlasPhase: 'opened', hiddenDescendants: descendants.get(focusedParent)! },
      text: parentWitness.text + ' Perla aperta: i figli primari reali sono in una carta Julia locale; i glifi troppo vicini sono separati dalla loro posizione Julia certificata. Il bordo non è una relazione.' });
    for (const id of ids) {
      phaseNodeIds.add(id);
      const original = full.positions.get(id)!;
      const chart = chartPositions.get(id)!;
      const displayed = separated.get(id)!;
      positions.set(id, displayed);
      const witness = full.witnesses.get(id)!;
      witnesses.set(id, { ...witness, values: { ...witness.values,
        atlasPhase: 'child', originalX: original.x, originalY: original.y,
        originalG: Number(witness.values.G),
        chartMuX: mu.x, chartMuY: mu.y, chartScale: scale,
        chartParentX: parent.x, chartParentY: parent.y,
        chartX: chart.x, chartY: chart.y,
        glyphOffsetX: displayed.x - chart.x, glyphOffsetY: displayed.y - chart.y,
        inverse: 'q=mu+(chart-parent)/scale; chart=display-glyphOffset', hiddenDescendants: descendants.get(id)! },
        text: witness.text + ' Carta Julia locale: similitudine positiva ancorata al genitore reale. Il glifo può spostarsi al posto libero più vicino, con offset esplicito nel testimone; guide e offset non sono relazioni.' });
    }
    for (const guide of chartGuides) {
      const transformedGuide = guide.points.map(transform);
      const segment = clipSegment(transformedGuide[0]!, transformedGuide[1]!, parent, radius);
      if (segment.length !== 2) continue;
      guides.push({ ...guide, id: `atlas:${focusedParent}:${guide.id}`, points: segment, semantic: false });
    }
  }
  let overlap = 0;
  for (let i = 0; i < containers.length; i++) for (let j = i + 1; j < containers.length; j++) {
    const a = containers[i]!, b = containers[j]!;
    if (distance(a.center, b.center) < a.radius + b.radius + gap) overlap++;
  }
  const phase = focusedParent === null ? 'overview' : 'opened';
  const certificate: JuliaAtlasCertificate = { snapshotDigest: snapshot.digest, dimension, phase,
    eligibleParents: eligible.length, closedPearlsSubmitted: containers.filter(c => !c.open).length,
    closedPearlsDrawn: 0, openPassing: 0, openEligible, childSeparationMinPx: 0,
    insideGuideMaxPx: 0, shellOverlapCount: overlap, focusedParent, ok: false,
    closedPearlsRequired: Math.min(OVERVIEW_MIN_CLOSED, containers.length),
    closedPearlShare: 0, minimumRimPx: RIM_PX,
    focusReferenceRimPx: FOCUS_REFERENCE_RIM_PX };
  const absoluteRadius = Math.max(fullExtent,
    ...containers.map(c => distance3(c.center, { x: 0, y: 0, z: 0 }) + c.radius)) * 1.05;
  containers.unshift({ id: ABSOLUTE_CONTAINER_ID, level: 0, center: { x: 0, y: 0, z: 0 },
    radius: absoluteRadius, radius2d: absoluteRadius, open: true, title: 'NousOS' });
  const layout: JuliaAtlasLayout = { positions, witnesses, guides, containers, phaseNodeIds,
    hiddenDescendants: descendants, atlas: certificate,
    diagnostics: [{ code: 'julia-atlas.real-node-count', value: positions.size,
      acceptable: positions.size === snapshot.nodes.length },
    { code: 'julia-atlas.real-edge-count', value: snapshot.edges.length, acceptable: true },
    { code: 'julia-atlas.shell-overlap-count', value: overlap, acceptable: overlap === 0 }] };
  // D087-JULIA BEGIN
  if (focusedParent === null && !sourceFull) {
    if (overviewCache.size >= 2) overviewCache.delete(overviewCache.keys().next().value!);
    overviewCache.set(cacheKey, layout);
  }
  // D087-JULIA END
  return layout;
}

/** Confirm the actual drawn phase. The caller supplies projected pixels and only ink
 * it observed; submitted shells or guides never count merely because they exist. */
export function certifyJuliaAtlasDrawing(layout: JuliaAtlasLayout, snapshot: TopologySnapshot, drawn: Readonly<{
  nodeIds: ReadonlySet<string>; shellIds: ReadonlySet<string>; countedShellIds: ReadonlySet<string>;
  guideIds: ReadonlySet<string>; project(point: Point3): Readonly<{ x: number; y: number }>;
  shellRadiusPx(shell: LayoutContainer): number;
  viewport?: Readonly<{ width: number; height: number }>;
}>): JuliaAtlasCertificate {
  const shells = layout.containers.filter(c => c.id !== ABSOLUTE_CONTAINER_ID && drawn.shellIds.has(c.id));
  const projected = (p: Point3) => drawn.project(p);
  let overlap = 0;
  for (let i = 0; i < shells.length; i++) for (let j = i + 1; j < shells.length; j++) {
    const a = shells[i]!, b = shells[j]!;
    const pa = projected(a.center), pb = projected(b.center);
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < drawn.shellRadiusPx(a) + drawn.shellRadiusPx(b) + GAP_PX) overlap++;
  }
  const closed = shells.filter(shell => !shell.open && drawn.nodeIds.has(shell.id)
    && drawn.countedShellIds.has(shell.id) && drawn.shellRadiusPx(shell) >= RIM_PX
    && (layout.hiddenDescendants.get(shell.id) ?? 0) > 0).length;
  let childSeparationMinPx = 0, insideGuideMaxPx = 0, openPassing = 0;
  const parent = layout.atlas.focusedParent;
  if (parent !== null) {
    const shell = shells.find(c => c.id === parent && c.open);
    // D087-JULIA BEGIN: distance tests use one pinned fitted focus rim,
    // so wheel zoom cannot change the admission inequalities.
    const focusPixels = shell ? FOCUS_REFERENCE_RIM_PX / Math.max(1e-9, drawn.shellRadiusPx(shell)) : 0;
    // D087-JULIA END
    const ids = snapshot.nodes.filter(n => n.parent === parent && drawn.nodeIds.has(n.id)).map(n => n.id);
    const points = ids.map(id => projected(layout.positions.get(id)!));
    const clearances = points.map((p, i) => Math.min(...points.filter((_, j) => i !== j)
      .map(q => Math.hypot(p.x - q.x, p.y - q.y))));
    childSeparationMinPx = clearances.length >= 3
      ? Math.min(...clearances) * focusPixels : 0;
    if (shell) for (const guide of layout.guides) {
      if (!guide.id.startsWith(`atlas:${parent}:`) || !drawn.guideIds.has(guide.id)) continue;
      const a = projected(guide.points[0]!), b = projected(guide.points[1]!);
      const center = projected(shell.center), radius = drawn.shellRadiusPx(shell);
      if (drawn.viewport && !segmentTouchesViewport(a, b, drawn.viewport)) continue;
      if (Math.hypot(a.x - center.x, a.y - center.y) > radius ||
        Math.hypot(b.x - center.x, b.y - center.y) > radius) continue;
      insideGuideMaxPx = Math.max(insideGuideMaxPx, Math.hypot(a.x - b.x, a.y - b.y) * focusPixels);
    }
    if (shell && drawn.nodeIds.has(parent) && childSeparationMinPx >= 8 && insideGuideMaxPx >= 16)
      openPassing = 1;
  }
  const required = Math.min(OVERVIEW_MIN_CLOSED, layout.atlas.closedPearlsSubmitted);
  const share = layout.atlas.closedPearlsSubmitted ? closed / layout.atlas.closedPearlsSubmitted : 0;
  const ok = overlap === 0 && (layout.atlas.phase === 'overview'
    ? closed >= required && share >= OVERVIEW_MIN_SHARE && layout.atlas.closedPearlsSubmitted > 0
    : openPassing === 1);
  return { ...layout.atlas, closedPearlsDrawn: closed, openPassing,
    closedPearlsRequired: required, closedPearlShare: share, minimumRimPx: RIM_PX,
    focusReferenceRimPx: FOCUS_REFERENCE_RIM_PX,
    childSeparationMinPx, insideGuideMaxPx, shellOverlapCount: overlap, ok };
}

/** Reference projection preflight for admission. This is deliberately named
 * projected: a mounted renderer must replace it with an observed certificate. */
export function preflightJuliaIndraAtlas(snapshot: TopologySnapshot, dimension: TopologyDimension) {
  const overview = composeJuliaIndraAtlas(snapshot, dimension);
  const shell = overview.containers.find(c => c.id !== ABSOLUTE_CONTAINER_ID);
  if (!shell) return { snapshotDigest: snapshot.digest, dimension, phase: 'preflight' as const,
    eligibleParents: overview.atlas.eligibleParents, closedPearlsProjected: 0,
    openPassingProjected: 0, openEligible: 0, shellOverlapCount: 0, ok: false };
  const px = RIM_PX / shell.radius;
  const project = (p: Point3) => ({ x: p.x * px, y: p.y * px });
  const shellRadiusPx = (c: LayoutContainer) => c.radius * px;
  const overviewCertificate = certifyJuliaAtlasDrawing(overview, snapshot, {
    nodeIds: overview.phaseNodeIds, shellIds: overview.phaseNodeIds,
    countedShellIds: overview.phaseNodeIds, guideIds: new Set(), project, shellRadiusPx,
  });
  let openPassingProjected = 0;
  for (const id of overview.phaseNodeIds) {
    const opened = composeJuliaIndraAtlas(snapshot, dimension, id, REFERENCE_WIDTH, overview);
    const certificate = certifyJuliaAtlasDrawing(opened, snapshot, {
      nodeIds: opened.phaseNodeIds, shellIds: new Set([id]), countedShellIds: new Set(),
      guideIds: new Set(opened.guides.filter(g => g.id.startsWith(`atlas:${id}:`)).map(g => g.id)),
      project, shellRadiusPx,
    });
    if (certificate.ok) openPassingProjected++;
  }
  return { snapshotDigest: snapshot.digest, dimension, phase: 'preflight' as const,
    eligibleParents: overview.atlas.eligibleParents,
    closedPearlsProjected: overviewCertificate.closedPearlsDrawn,
    openPassingProjected, openEligible: overview.phaseNodeIds.size,
    shellOverlapCount: overviewCertificate.shellOverlapCount,
    ok: overviewCertificate.ok && openPassingProjected === overview.phaseNodeIds.size };
}
// D087-JULIA END
