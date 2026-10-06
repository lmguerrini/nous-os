import type { CanopyLayout, CanopyInputNode, CanopyPoint } from './canopy-layout.ts';
import { canopyFitAnchorIds } from './canopy-layout.ts';
import type { Density } from '../review/lod.ts';

export type CanopyBand = 'fit' | 'mid' | 'deep';
/** Half-octave camera steps keep disclosure moving within the coarse product LOD bands. */
export function canopyZoomStep(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(0, Math.floor(Math.log2(Math.max(1, zoom)) * 2)) : 0;
}
export function canopyBandForZoom(zoom: number): CanopyBand {
  return zoom >= 3.7 ? 'deep' : zoom >= 1.9 ? 'mid' : 'fit';
}
export type CanopyMark = Readonly<{ id: string; memberCount: number; memberIds: readonly string[];
  aggregate: boolean }>;

const densityOrderCache = new WeakMap<CanopyLayout, readonly string[]>();

/** One stable lower-density mark sequence; complete always names each real ID. */
export function canopyDensityMarks(layout: CanopyLayout, nodes: readonly CanopyInputNode[],
  density: Density, _band: CanopyBand, focusId: string | null, _pixelsPerUnit: number,
  projection: '2d' | '3d', _projectPoint?: (point: CanopyPoint) => Readonly<{ x: number; y: number }>): CanopyMark[] {
  if (density === 'complete') return nodes.map(node => ({ id: node.id, memberCount: 1,
    memberIds: [node.id], aggregate: false }));
  // D082-B1: semantic selection is independent of camera distance. Ancestor tiers
  // precede important leaves; ties use real IDs. Both sparse sets retain real fit
  // extremities and the explicit focus, so E is a subset of B at every zoom.
  let ordered = densityOrderCache.get(layout);
  if (!ordered) {
    ordered = [...nodes].sort((a, b) => a.level - b.level ||
      (b.importance?.value ?? 0) - (a.importance?.value ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(node => node.id);
    densityOrderCache.set(layout, ordered);
  }
  const budget = density === 'essential' ? 150 : 850;
  const ids = new Set(ordered.slice(0, budget));
  for (const id of canopyFitAnchorIds(layout, projection)) ids.add(id);
  if (focusId && layout.positions.has(focusId)) ids.add(focusId);
  return [...ids].map(id => ({ id, memberCount: 1, memberIds: [id], aggregate: false }));
}

/** A mark is a real representative. Its counted IDs may include nearby siblings at fit;
 * that display grouping makes no parent or relation claim. Each real ID has one owner. */
export function canopyMarks(layout: CanopyLayout, nodes: readonly CanopyInputNode[], band: CanopyBand,
  focusId: string | null = null, pixelsPerUnit = 1, projection: '2d' | '3d' = '2d',
  projectPoint?: (point: CanopyPoint) => Readonly<{ x: number; y: number }>,
  allNodes: readonly CanopyInputNode[] = nodes): readonly CanopyMark[] {
  const byId = new Map(allNodes.map(node => [node.id, node]));
  const local = focusId ? layout.positions.get(focusId)?.domainId : null;
  const candidates = nodes.filter(node => node.id === focusId || node.level <= 3 ||
    (band !== 'fit' && node.level >= 4 &&
      (!local || layout.positions.get(node.id)?.domainId === local || node.id === focusId)));
  const visible = candidates.filter(node => {
    if (node.id === focusId) return true;
    if (band === 'fit' || node.level < 4) return true;
    if (!node.parent) return true;
    const position = projection === '3d' ? layout.positions.get(node.id)?.point3d : layout.positions.get(node.id)?.point;
    const parentPosition = projection === '3d' ? layout.positions.get(node.parent)?.point3d : layout.positions.get(node.parent)?.point;
    if (!position || !parentPosition) return true;
    if (projectPoint) {
      const a = projectPoint(position), b = projectPoint(parentPosition);
      if ([a.x, a.y, b.x, b.y].every(Number.isFinite))
        return Math.hypot(a.x - b.x, a.y - b.y) >= (band === 'deep' ? 0.8 : 2);
    }
    return Math.hypot(position.x - parentPosition.x, position.y - parentPosition.y,
      projection === '3d' ? position.z - parentPosition.z : 0) * pixelsPerUnit >= (band === 'deep' ? 0.8 : 2);
  });
  const clusterOwner = new Map<string, string>();
  {
    const screen = (id: string) => {
      const position = layout.positions.get(id);
      const point = projection === '3d' ? position?.point3d : position?.point;
      if (!point) return { x: Number.NaN, y: Number.NaN };
      if (projectPoint) return projectPoint(point);
      return { x: point.x * pixelsPerUnit, y: point.y * pixelsPerUnit };
    };
    // A single screen-space exclusion works across siblings and hierarchy levels.
    // Every folded node is owned by a real glyph; the grouping asserts no new
    // semantic parentage. The threshold recedes as detail opens.
    const separation = band === 'fit' ? 14 : band === 'mid' ? 9 : 4.5;
    const representatives: { id: string; x: number; y: number }[] = [];
    const grid = new Map<string, number[]>();
    for (const node of [...visible].sort((a, b) =>
      Number(b.id === focusId) - Number(a.id === focusId) || a.level - b.level || a.id.localeCompare(b.id))) {
      const p = screen(node.id);
      const gx = Math.floor(p.x / separation), gy = Math.floor(p.y / separation);
      let earliest = Infinity;
      if (Number.isFinite(gx) && Number.isFinite(gy)) for (let x = gx - 1; x <= gx + 1; x++)
        for (let y = gy - 1; y <= gy + 1; y++)
          for (const index of grid.get(`${x}:${y}`) ?? []) {
            const rep = representatives[index]!;
            if (index < earliest && Math.hypot(rep.x - p.x, rep.y - p.y) < separation) earliest = index;
          }
      if (earliest < Infinity) clusterOwner.set(node.id, representatives[earliest]!.id);
      else {
        const index = representatives.push({ id: node.id, ...p }) - 1;
        if (Number.isFinite(gx) && Number.isFinite(gy)) {
          const key = `${gx}:${gy}`, bucket = grid.get(key) ?? [];
          bucket.push(index); grid.set(key, bucket);
        }
      }
    }
  }
  const exposed = visible.filter(node => !clusterOwner.has(node.id));
  const visibleIds = new Set(exposed.map(node => node.id));
  const assigned = new Map<string, string[]>();
  for (const node of allNodes) {
    let cursor: string | null = node.id;
    while (cursor && !visibleIds.has(cursor) && !clusterOwner.has(cursor))
      cursor = byId.get(cursor)?.parent ?? null;
    const owner = cursor ? clusterOwner.get(cursor) ?? cursor : null;
    if (owner && owner !== node.id) {
      const list = assigned.get(owner) ?? [];
      list.push(node.id); assigned.set(owner, list);
    }
  }
  const marks: CanopyMark[] = [];
  for (const node of exposed) {
    const folded = assigned.get(node.id) ?? [];
    marks.push({ id: node.id, memberCount: folded.length + 1, memberIds: [node.id, ...folded],
      aggregate: folded.length > 0 });
  }
  return marks;
}

/** Search or selection opens a finite primary-parent path to every ID. */
export function canopyReachablePath(nodes: readonly CanopyInputNode[], id: string): readonly string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(id)) return [];
  const path: string[] = [], seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    path.unshift(cursor); seen.add(cursor); cursor = byId.get(cursor)?.parent ?? null;
  }
  return path;
}
