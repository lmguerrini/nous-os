/** Drawing-only size policy for a fully disclosed graph. Positions and identities are inputs only. */
export type DenseNodeSample = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly importance: number;
  readonly baseRadiusPx: number;
};

export type DenseNodeScale = {
  readonly id: string;
  readonly localDensity: number;
  readonly scale: number;
  readonly radiusPx: number;
};

/** The reference r4 Completa view is complete only when all 11,199 dataset nodes are drawn. */
export function isReferenceCompleta(nodeCount: number, visibleCount: number): boolean {
  return nodeCount === 11_199 && visibleCount === 11_199;
}

const MIN_SCREEN_DIAMETER_PX = 1;
const MIN_SCALE = 0.32;
const MAX_SCALE = 0.78;
const MAX_HUB_BONUS = 0.16;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Resolve a stable local world-space density from a grid, then map it to a bounded radius.
 * `zoomProgress` is 0 at fit and 1 at close inspection; screenDistanceNorm is 0 at the view
 * centre and 1 at its edge. Importance only grants a small hub bonus after density scaling.
 */
export function denseNodeScales(
  samples: readonly DenseNodeSample[],
  options: { readonly zoomProgress?: number; readonly screenDistanceNorm?: ReadonlyMap<string, number> } = {},
): ReadonlyMap<string, DenseNodeScale> {
  if (!samples.length) return new Map();
  const xs = samples.map(sample => sample.x), ys = samples.map(sample => sample.y);
  const span = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  const cellSize = Math.max(1, span / Math.sqrt(samples.length));
  const cell = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  const buckets = new Map<string, DenseNodeSample[]>();
  for (const sample of samples) {
    const key = cell(sample.x, sample.y);
    const bucket = buckets.get(key) ?? [];
    bucket.push(sample);
    buckets.set(key, bucket);
  }
  const nearest = new Map<string, number>();
  for (const sample of samples) {
    const cx = Math.floor(sample.x / cellSize), cy = Math.floor(sample.y / cellSize);
    let distance = span;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const other of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (other.id === sample.id) continue;
        distance = Math.min(distance, Math.hypot(sample.x - other.x, sample.y - other.y,
          (sample.z ?? 0) - (other.z ?? 0)));
      }
    }
    nearest.set(sample.id, distance);
  }
  const sortedDistances = [...nearest.values()].sort((a, b) => a - b);
  const reference = sortedDistances[Math.floor(sortedDistances.length * 0.72)] ?? cellSize;
  const screenCellSize = 16;
  // Query far enough to include every centre a large domain or hub disc could cover. A fixed
  // 3x3 neighborhood misses candidates two buckets away when their radii exceed one cell, which
  // is exactly how the large filled pearls survived the first Completa pass.
  const screenSearchCells = Math.max(1, Math.ceil((2 * Math.max(...samples.map(sample => sample.baseRadiusPx))) / screenCellSize));
  const screenBuckets = new Map<string, DenseNodeSample[]>();
  for (const sample of samples) if (sample.screenX !== undefined && sample.screenY !== undefined) {
    const key = `${Math.floor(sample.screenX / screenCellSize)},${Math.floor(sample.screenY / screenCellSize)}`;
    const bucket = screenBuckets.get(key) ?? [];
    bucket.push(sample);
    screenBuckets.set(key, bucket);
  }
  const closestScreen = new Map<string, number>();
  for (const sample of samples) if (sample.screenX !== undefined && sample.screenY !== undefined) {
    const cx = Math.floor(sample.screenX / screenCellSize), cy = Math.floor(sample.screenY / screenCellSize);
    let distance = Number.POSITIVE_INFINITY;
    for (let dx = -screenSearchCells; dx <= screenSearchCells; dx++) for (let dy = -screenSearchCells; dy <= screenSearchCells; dy++)
      for (const other of screenBuckets.get(`${cx + dx},${cy + dy}`) ?? []) if (other.id !== sample.id)
        distance = Math.min(distance, Math.hypot(sample.screenX - other.screenX!, sample.screenY - other.screenY!));
    closestScreen.set(sample.id, distance);
  }
  const zoom = clamp(options.zoomProgress ?? 0, 0, 1);
  const importanceMax = Math.max(1, ...samples.map(sample => sample.importance));
  const scales = samples.map(sample => {
    const localDensity = clamp(reference / Math.max(0.01, nearest.get(sample.id) ?? reference), 0.25, 4);
    const densityScale = clamp(MAX_SCALE / Math.sqrt(localDensity), MIN_SCALE, MAX_SCALE);
    const distance = clamp(options.screenDistanceNorm?.get(sample.id) ?? 0, 0, 1);
    const peripheralScale = 1 - distance * 0.12;
    const hub = clamp(sample.importance / importanceMax, 0, 1) * MAX_HUB_BONUS;
    const scale = clamp((densityScale * (1 - zoom) + zoom) * peripheralScale + hub, MIN_SCALE, 1);
    const closestScreenPx = closestScreen.get(sample.id) ?? Number.POSITIVE_INFINITY;
    // At fit, stop the fill short of the nearest screen-space centre. The one-pixel point floor
    // is the explicit bound when the actual projected spacing is itself below one pixel.
    const overviewCap = Number.isFinite(closestScreenPx) ? Math.max(MIN_SCREEN_DIAMETER_PX / 2, closestScreenPx * 0.46)
      : Number.POSITIVE_INFINITY;
    const overlapSafeCap = Number.isFinite(overviewCap)
      ? overviewCap * (1 - zoom) + sample.baseRadiusPx * zoom : Number.POSITIVE_INFINITY;
    const radiusPx = Math.max(MIN_SCREEN_DIAMETER_PX / 2, Math.min(sample.baseRadiusPx * scale, overlapSafeCap));
    return [sample.id, { id: sample.id, localDensity, scale, radiusPx }] as const;
  });
  return new Map(scales);
}

export function denseEdgeAlphaPermille(base: number, sourceDensity: number, targetDensity: number): number {
  const density = Math.max(1, (sourceDensity + targetDensity) / 2);
  const attenuation = clamp(1 / Math.sqrt(density), 0.24, 1);
  return Math.max(80, Math.min(1000, Math.round(base * attenuation)));
}

/** Fraction of centres covered by another node's disc, using the emitted drawing radii. */
export function centreCoverageFraction(
  points: readonly { readonly id: string; readonly x: number; readonly y: number; readonly radius: number }[],
): number {
  if (!points.length) return 0;
  const cellSize = Math.max(1, Math.max(...points.map(point => point.radius)) * 2);
  const buckets = new Map<string, typeof points[number][]>();
  for (const point of points) {
    const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(point);
    buckets.set(key, bucket);
  }
  let covered = 0;
  for (const point of points) {
    const cx = Math.floor(point.x / cellSize), cy = Math.floor(point.y / cellSize);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++)
      for (const other of buckets.get(`${cx + dx},${cy + dy}`) ?? [])
        if (other.id !== point.id && Math.hypot(point.x - other.x, point.y - other.y) < other.radius) { hit = true; break; }
    if (hit) covered++;
  }
  return covered / points.length;
}
