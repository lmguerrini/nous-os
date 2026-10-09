// D087-SIZE10 BEGIN
import { denseNodeScales } from '../render-common/dense-node-scale.ts';
import type { DenseNodeSample } from '../render-common/dense-node-scale.ts';
import { calibratedLeafCorePx } from '../render-common/semantic-node-mark.ts';
import type { Point3 } from './layout-v2.ts';
import type { V2Node } from './v2-core.ts';
import { v2Encoding } from './v2-adapter.ts';

export type FullGraphLeafSource = Readonly<{
  digest: string;
  layoutKey: string;
  nodes: readonly V2Node[];
  anchors: ReadonlyMap<string, Point3>;
  /** Share of the reference frame occupied by nodes when topology guides own the outer fit. */
  fitShare?: number;
}>;

export type FullGraphLeafBase = Readonly<{ given: number; targetPx: number; fullGraphNodes: number }>;

type ScreenTree = Readonly<{ sample: DenseNodeSample; left: ScreenTree | null; right: ScreenTree | null }>;
type WorldTree = Readonly<{ sample: DenseNodeSample; left: WorldTree | null; right: WorldTree | null }>;

function nearestWorldDistances(samples: readonly DenseNodeSample[]): ReadonlyMap<string, number> {
  const axes = ['x', 'y', 'z'] as const;
  const coordinate = (sample: DenseNodeSample, axis: number) => sample[axes[axis]!] ?? 0;
  const build = (points: DenseNodeSample[], axis: number): WorldTree | null => {
    if (!points.length) return null;
    points.sort((a, b) => coordinate(a, axis) - coordinate(b, axis) || a.id.localeCompare(b.id));
    const middle = Math.floor(points.length / 2);
    return { sample: points[middle]!, left: build(points.slice(0, middle), (axis + 1) % 3),
      right: build(points.slice(middle + 1), (axis + 1) % 3) };
  };
  const tree = build([...samples], 0);
  const nearestSquared = (node: WorldTree | null, sample: DenseNodeSample,
    axis: number, best: number): number => {
    if (!node) return best;
    const dx = sample.x - node.sample.x, dy = sample.y - node.sample.y;
    const dz = (sample.z ?? 0) - (node.sample.z ?? 0);
    if (node.sample.id !== sample.id) best = Math.min(best, dx * dx + dy * dy + dz * dz);
    const delta = coordinate(sample, axis) - coordinate(node.sample, axis);
    best = nearestSquared(delta < 0 ? node.left : node.right, sample, (axis + 1) % 3, best);
    if (delta * delta < best) best = nearestSquared(delta < 0 ? node.right : node.left,
      sample, (axis + 1) % 3, best);
    return best;
  };
  const xs = samples.map(sample => sample.x), ys = samples.map(sample => sample.y);
  const span = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  return new Map(samples.map(sample => [sample.id,
    Math.min(span, Math.sqrt(nearestSquared(tree, sample, 0, Number.POSITIVE_INFINITY)))] as const));
}

/** Exact nearest represented centre in the fixed frame. Dense layouts can put
 * thousands of marks in one sixteen-pixel cell, so a balanced tree keeps the
 * calibration linearithmic while retaining every real point. */
function nearestRepresentedScreens(samples: readonly DenseNodeSample[],
  representatives: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const represented = samples.filter(sample => representatives.get(sample.id) === sample.id);
  const build = (points: DenseNodeSample[], axis: 0 | 1): ScreenTree | null => {
    if (!points.length) return null;
    points.sort((a, b) => axis === 0 ? a.screenX! - b.screenX! || a.id.localeCompare(b.id)
      : a.screenY! - b.screenY! || a.id.localeCompare(b.id));
    const middle = Math.floor(points.length / 2);
    return { sample: points[middle]!, left: build(points.slice(0, middle), axis === 0 ? 1 : 0),
      right: build(points.slice(middle + 1), axis === 0 ? 1 : 0) };
  };
  const tree = build(represented, 0);
  const nearestSquared = (node: ScreenTree | null, sample: DenseNodeSample,
    axis: 0 | 1, best: number): number => {
    if (!node) return best;
    const dx = sample.screenX! - node.sample.screenX!;
    const dy = sample.screenY! - node.sample.screenY!;
    if (node.sample.id !== sample.id) best = Math.min(best, dx * dx + dy * dy);
    const delta = axis === 0 ? dx : dy;
    const first = delta < 0 ? node.left : node.right;
    const second = delta < 0 ? node.right : node.left;
    best = nearestSquared(first, sample, axis === 0 ? 1 : 0, best);
    if (delta * delta < best) best = nearestSquared(second, sample, axis === 0 ? 1 : 0, best);
    return best;
  };
  return new Map(represented.map(sample => [sample.id,
    Math.sqrt(nearestSquared(tree, sample, 0, Number.POSITIVE_INFINITY))] as const));
}

/** A fixed reference projection of the full canonical layout. This is a calibration
 * coordinate system, never a live camera or an alternative rendered arrangement. */
export function calculateFullGraphLeafBase(source: FullGraphLeafSource,
  structuralIds: ReadonlySet<string>, morphology: string, nodeScale: number): FullGraphLeafBase {
  const points = source.nodes.map(node => {
    const point = source.anchors.get(node.id);
    if (!point) throw new Error(`Full graph leaf anchor missing: ${node.id}`);
    return { node, point, x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 };
  });
  const xs = points.map(item => item.x), ys = points.map(item => item.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const screenScale = Math.min(1120 / Math.max(1, maxX - minX), 720 / Math.max(1, maxY - minY))
    * (source.fitShare ?? 1);
  // A single reference size scale is independent of the layout's world-unit range.
  // Layouts such as Julia intentionally use much smaller coordinates than Natural;
  // their screen fit must not multiply the encoded world-space radius.
  const sizeScale = morphology === 'neural' && screenScale < 0.3 ? 0.82 : 0.9;
  const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const distance = new Map(points.map(item => [item.node.id,
    Math.min(1, Math.hypot(item.x - (minX + maxX) / 2,
      item.y - (minY + maxY) / 2) / (span / 2))] as const));
  const samples = points.map(({ node, point, x, y }) => ({
    id: node.id, x: point.x, y: point.y, z: point.z,
    screenX: (x - minX) * screenScale, screenY: (y - minY) * screenScale,
    importance: node.importance.value, baseRadiusPx: v2Encoding(node, nodeScale).radiusPx,
    projectionScale: sizeScale,
  }));
  const dense = denseNodeScales(samples, { zoomProgress: 0, screenDistanceNorm: distance,
    closestScreen: nearestRepresentedScreens, nearestWorld: nearestWorldDistances });
  const leafRadii = points.flatMap(({ node }) => {
    const radius = dense.get(node.id)?.radiusPx ?? 0;
    return !structuralIds.has(node.id) && radius > 0 ? [radius * sizeScale] : [];
  });
  const targetPx = calibratedLeafCorePx(leafRadii, morphology, '3d');
  return { given: targetPx / sizeScale, targetPx, fullGraphNodes: source.nodes.length };
}

const bases = new Map<string, FullGraphLeafBase>();
export function fullGraphLeafBase(source: FullGraphLeafSource,
  structuralIds: ReadonlySet<string>, morphology: string, nodeScale: number): FullGraphLeafBase {
  const key = [source.digest, source.layoutKey, source.fitShare ?? 1, morphology, nodeScale].join('|');
  const hit = bases.get(key);
  if (hit) return hit;
  const base = calculateFullGraphLeafBase(source, structuralIds, morphology, nodeScale);
  bases.set(key, base);
  if (bases.size > 32) bases.delete(bases.keys().next().value!);
  return base;
}
// D087-SIZE10 END
