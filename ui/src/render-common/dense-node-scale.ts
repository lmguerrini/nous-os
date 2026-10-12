import { maxOf, minOf } from '#render-common/array-aggregation.ts';
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
  /** Renderer radius multiplier at this projected centre (1 for the normalized fixture). */
  readonly projectionScale?: number;
};

export type DenseNodeScale = {
  readonly id: string;
  readonly localDensity: number;
  readonly scale: number;
  readonly radiusPx: number;
  /** A sub-pixel coincident node is represented by this selectable node's point. */
  readonly representativeId: string;
};

/** Existing threshold for the renderer's dense scene path. */
export const DENSE_SCENE_THRESHOLD = 1200;

/** A complete dense view draws every node in its actual dataset. */
export function isCompleteDenseView(totalNodeCount: number, visibleCount: number): boolean {
  return Number.isSafeInteger(totalNodeCount) && totalNodeCount >= DENSE_SCENE_THRESHOLD
    && visibleCount === totalNodeCount;
}

/** Compatibility name for callers and tests; it now means any complete dense dataset. */
export const isReferenceCompleta = isCompleteDenseView;

// D086-CUSTOM BEGIN: Custom shares the drawing safeguards; the reference maximum keeps its exact policy.
export function usesDenseDrawingPolicy(totalNodeCount: number, visibleCount: number, density: string): boolean {
  return isCompleteDenseView(totalNodeCount, visibleCount) || density === 'custom';
}
// D086-CUSTOM END

// D087-JULIA BEGIN
/** The density the builders branch on for drawing. In the Julia + Indra atlas the pearl phase,
 * not the full dataset, is visible, so the complete-view test cannot recognise the
 * Custom maximum: the page states it, and Custom at its maximum takes Completa's drawing
 * decisions. The page witness and the UI density keep saying «custom». */
export function denseDrawingDensity(density: string, juliaAtlasCustomAtMaximum: boolean): string {
  return juliaAtlasCustomAtMaximum && density === 'custom' ? 'complete' : density;
}
// D087-JULIA END

export const MIN_SCREEN_RADIUS_PX = 0.5;
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
  options: { readonly zoomProgress?: number; readonly screenDistanceNorm?: ReadonlyMap<string, number>;
    readonly nativeRadiusOnly?: boolean;
    // D087-SIZE10 BEGIN: an exact spatial index can supply fixed full-graph nearest distances.
    readonly closestScreen?: (samples: readonly DenseNodeSample[], representatives: ReadonlyMap<string, string>)
      => ReadonlyMap<string, number>;
    readonly nearestWorld?: (samples: readonly DenseNodeSample[]) => ReadonlyMap<string, number>;
    // D087-SIZE10 END
  } = {},
): ReadonlyMap<string, DenseNodeScale> {
  if (!samples.length) return new Map();
  const xs = samples.map(sample => sample.x), ys = samples.map(sample => sample.y);
  const span = Math.max(1, Math.hypot(maxOf(xs) - minOf(xs), maxOf(ys) - minOf(ys)));
  const cellSize = Math.max(1, span / Math.sqrt(samples.length));
  const cell = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  // D087-SIZE10 BEGIN: only the fixed full-graph calibration supplies this index.
  const indexedNearestWorld = options.nearestWorld?.(samples);
  const buckets = new Map<string, DenseNodeSample[]>();
  for (const sample of samples) if (!indexedNearestWorld) {
    const key = cell(sample.x, sample.y);
    const bucket = buckets.get(key) ?? [];
    bucket.push(sample);
    buckets.set(key, bucket);
  }
  const nearest = new Map<string, number>(indexedNearestWorld);
  for (const sample of samples) if (!indexedNearestWorld) {
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
  // D087-SIZE10 END
  const sortedDistances = [...nearest.values()].sort((a, b) => a - b);
  const reference = sortedDistances[Math.floor(sortedDistances.length * 0.72)] ?? cellSize;
  const screenCellSize = 16;
  // Query far enough to include every centre a large domain or hub disc could cover. A fixed
  // 3x3 neighborhood misses candidates two buckets away when their radii exceed one cell, which
  // is exactly how the large filled pearls survived the first Completa pass.
  const screenSearchCells = Math.max(1, Math.ceil((2 * maxOf(samples.map(sample => sample.baseRadiusPx))) / screenCellSize));
  // A deterministic independent set of one-pixel points. A hidden member remains in the
  // graph/picker and records the point that represents its coincident screen-space set.
  const zoom = clamp(options.zoomProgress ?? 0, 0, 1);
  const pointSeparation = (1 - zoom) * 1.001;
  const representatives = new Map<string, string>();
  const kept = new Map<string, DenseNodeSample[]>();
  const pointCell = Math.max(pointSeparation, 0.001);
  const pointKey = (x: number, y: number) => `${Math.floor(x / pointCell)},${Math.floor(y / pointCell)}`;
  for (const sample of [...samples].sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))) {
    if (sample.screenX === undefined || sample.screenY === undefined || pointSeparation <= 0) {
      representatives.set(sample.id, sample.id); continue;
    }
    const cx = Math.floor(sample.screenX / pointCell), cy = Math.floor(sample.screenY / pointCell);
    let winner: DenseNodeSample | undefined;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const other of kept.get(`${cx + dx},${cy + dy}`) ?? [])
        if (Math.hypot(sample.screenX - other.screenX!, sample.screenY - other.screenY!) < pointSeparation
          && (!winner || other.id.localeCompare(winner.id) < 0)) winner = other;
    representatives.set(sample.id, winner?.id ?? sample.id);
    if (!winner) {
      const key = pointKey(sample.screenX, sample.screenY);
      const bucket = kept.get(key) ?? []; bucket.push(sample); kept.set(key, bucket);
    }
  }
  // D087-SIZE10 BEGIN: the calibration's exact spatial index avoids quadratic
  // scans when thousands of law points occupy one reference-frame cell.
  const indexedClosestScreen = options.closestScreen?.(samples, representatives);
  // D087-SIZE10 END
  const screenBuckets = new Map<string, DenseNodeSample[]>();
  for (const sample of samples) if (!indexedClosestScreen && sample.screenX !== undefined && sample.screenY !== undefined
    && representatives.get(sample.id) === sample.id) {
    const key = `${Math.floor(sample.screenX / screenCellSize)},${Math.floor(sample.screenY / screenCellSize)}`;
    const bucket = screenBuckets.get(key) ?? [];
    bucket.push(sample);
    screenBuckets.set(key, bucket);
  }
  const closestScreen = new Map<string, number>();
  for (const sample of samples) if (!indexedClosestScreen && sample.screenX !== undefined && sample.screenY !== undefined
    && representatives.get(sample.id) === sample.id) {
    const cx = Math.floor(sample.screenX / screenCellSize), cy = Math.floor(sample.screenY / screenCellSize);
    let distance = Number.POSITIVE_INFINITY;
    for (let dx = -screenSearchCells; dx <= screenSearchCells; dx++) for (let dy = -screenSearchCells; dy <= screenSearchCells; dy++)
      for (const other of screenBuckets.get(`${cx + dx},${cy + dy}`) ?? []) if (other.id !== sample.id)
        distance = Math.min(distance, Math.hypot(sample.screenX - other.screenX!, sample.screenY - other.screenY!));
    closestScreen.set(sample.id, distance);
  }
  const importanceMax = maxOf(samples.map(sample => sample.importance), 1);
  const scales = samples.map(sample => {
    const localDensity = clamp(reference / Math.max(0.01, nearest.get(sample.id) ?? reference), 0.25, 4);
    const densityScale = clamp(MAX_SCALE / Math.sqrt(localDensity), MIN_SCALE, MAX_SCALE);
    const distance = clamp(options.screenDistanceNorm?.get(sample.id) ?? 0, 0, 1);
    const peripheralScale = 1 - distance * 0.12;
    const hub = clamp(sample.importance / importanceMax, 0, 1) * MAX_HUB_BONUS;
    // D086-CUSTOM BEGIN: below the maximum, Custom keeps the encoded native size wherever
    // the overlap cap does not bind. Completa's arithmetic remains unchanged.
    const scale = options.nativeRadiusOnly ? 1
      : clamp((densityScale * (1 - zoom) + zoom) * peripheralScale + hub, MIN_SCALE, 1);
    // D086-CUSTOM END
    // D087-SIZE10 BEGIN
    const closestScreenPx = indexedClosestScreen?.get(sample.id)
      ?? closestScreen.get(sample.id) ?? Number.POSITIVE_INFINITY;
    // D087-SIZE10 END
    // At fit, stop the fill short of the nearest represented screen-space centre.
    const overviewCap = Number.isFinite(closestScreenPx) ? Math.max(MIN_SCREEN_RADIUS_PX, closestScreenPx * 0.46)
      : Number.POSITIVE_INFINITY;
    const overlapSafeCap = Number.isFinite(overviewCap)
      ? overviewCap * (1 - zoom) + sample.baseRadiusPx * (sample.projectionScale ?? 1) * zoom : Number.POSITIVE_INFINITY;
    const screenScale = Math.max(0.001, sample.projectionScale ?? 1);
    const radiusPx = representatives.get(sample.id) === sample.id
      ? Math.max(MIN_SCREEN_RADIUS_PX, Math.min(sample.baseRadiusPx * scale * screenScale, overlapSafeCap)) / screenScale : 0;
    return [sample.id, { id: sample.id, localDensity, scale, radiusPx,
      representativeId: representatives.get(sample.id) ?? sample.id }] as const;
  });
  return new Map(scales);
}

export function denseEdgeAlphaPermille(base: number, sourceDensity: number, targetDensity: number): number {
  const density = Math.max(1, (sourceDensity + targetDensity) / 2);
  const attenuation = clamp(1 / Math.sqrt(density), 0.24, 1);
  return Math.max(80, Math.min(1000, Math.round(base * attenuation)));
}

/** One drawn relation reduced to its screen-space segment: density is measured where edges overlap. */
export type DenseEdgeScreenSegment = Readonly<{
  readonly id: string;
  readonly sourceScreenX: number;
  readonly sourceScreenY: number;
  readonly targetScreenX: number;
  readonly targetScreenY: number;
}>;

/** Screen cell side for the edge-density field: the scale at which overlapping strokes form a mass. */
export const DENSE_EDGE_SCREEN_CELL_PX = 16;
/**
 * Calibrated for the D-082 reference overview: a 16 CSS px cell and a 1 CSS px stroke
 * (at DPR 2 these are 32 and 2 physical px, so the ratio is unchanged). Alpha layers
 * accumulate as optical depth: opacity = 1 - exp(-N * alpha * stroke/cell). With
 * N=T=23 and base alpha .36, T * .36 / 16 = .5175 optical depth, or 40.4% opacity.
 * Above the equivalent threshold for each edge class, alpha is base*T/N. The threshold scales
 * inversely with the input alpha, keeping the target optical depth stable for 0.36–0.90 bases.
 */
export const DENSE_EDGE_SCREEN_TOLERANCE = 23;
/** Deepest per-edge attenuation reachable at the overview. */
export const DENSE_EDGE_SCREEN_MIN_FACTOR = 0.002;
/** Minimum nonzero presentation alpha; the 2D native tier may quantize it to transparent. */
export const DENSE_EDGE_FLOOR_PERMILLE = 1;

/**
 * Local screen-space edge density per segment. Every segment is rasterised into screen cells at
 * half-cell steps (one contribution per distinct cell, so a long edge cannot inflate one cell);
 * the cell then counts how many distinct edges cross it. An edge's density is the 75th percentile
 * of its cells' counts: the corridor or pearl core it mostly lives in, ignoring a single brief
 * crossing of an unrelated dense area. Deterministic; straight-segment approximation of the drawn
 * arcs.
 */
export function denseEdgeScreenDensities(
  segments: readonly DenseEdgeScreenSegment[],
  cellSizePx: number = DENSE_EDGE_SCREEN_CELL_PX,
): ReadonlyMap<string, number> {
  if (!segments.length) return new Map();
  const cellSize = Math.max(1, cellSizePx);
  // Numeric cell keys (screen coordinates are non-negative after normalisation) keep the
  // full-Completa pass allocation-light: it runs inside every scene build.
  const cellKey = (x: number, y: number) => Math.floor(x / cellSize) * 4096 + Math.floor(y / cellSize);
  const cellCounts = new Map<number, number>();
  const touchedCells = new Map<string, number[]>();
  for (const segment of segments) {
    const steps = Math.max(1, Math.ceil(Math.hypot(
      segment.targetScreenX - segment.sourceScreenX, segment.targetScreenY - segment.sourceScreenY) / (cellSize / 2)));
    const touched = new Set<number>();
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      touched.add(cellKey(segment.sourceScreenX + (segment.targetScreenX - segment.sourceScreenX) * t,
        segment.sourceScreenY + (segment.targetScreenY - segment.sourceScreenY) * t));
    }
    const cells = [...touched];
    touchedCells.set(segment.id, cells);
    for (const cell of cells) cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1);
  }
  const densities = new Map<string, number>();
  for (const [id, cells] of touchedCells) {
    const counts = cells.map(cell => cellCounts.get(cell) ?? 1).sort((a, b) => a - b);
    densities.set(id, counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.75))] ?? 1);
  }
  return densities;
}

// D082-A-VEIL BEGIN: a screen-density measurement belongs to the drawn edge set at its
// fitted camera. A later pan changes viewport cell boundaries, not the graph's overlap.
export function fittedDenseEdgeScreenDensities(
  edgeIds: readonly string[],
  measure: () => ReadonlyMap<string, number>,
  previous?: { readonly edgeIds: ReadonlySet<string>; readonly densities: ReadonlyMap<string, number> },
): ReadonlyMap<string, number> {
  if (previous && previous.edgeIds.size === edgeIds.length
    && edgeIds.every(id => previous.edgeIds.has(id))) return previous.densities;
  return measure();
}
// D082-A-VEIL END

/**
 * Attenuate one edge alpha proportionally to its local screen-space edge density: full D-081 alpha
 * while the local bundle is within the 23-edge calibration, then a 1/density response so the
 * accumulated veil of a dense bundle stays bounded instead of saturating into a grey mass. The
 * optical-depth derivation and DPR 2 dimensions are documented at the calibration constant above.
 * `zoomProgress` blends the attenuation out towards close inspection, exactly like the node radius policy.
 */
export function denseEdgeScreenAlphaPermille(base: number, screenDensity: number, zoomProgress = 0): number {
  const zoom = clamp(zoomProgress, 0, 1);
  const equivalentTolerance = DENSE_EDGE_SCREEN_TOLERANCE * 360 / Math.max(1, base);
  const factor = clamp(equivalentTolerance / Math.max(1, screenDensity), DENSE_EDGE_SCREEN_MIN_FACTOR, 1);
  const blended = factor * (1 - zoom) + zoom;
  return Math.max(DENSE_EDGE_FLOOR_PERMILLE, Math.round(base * blended));
}

/**
 * Normalize Sigma's wheel ratio to the capture's six-event return range. Sigma applies one
 * 1/1.25 ratio step per wheel event (delta magnitude does not scale it); camera ratio decreases
 * on zoom-in. Thus z3 maps to 0.5 and z6 maps to 1, returning the close-up presentation by z6.
 */
export function denseZoomProgressForCamera(currentRatio: number | undefined, fittedRatio: number | undefined): number {
  if (!(currentRatio && fittedRatio && Number.isFinite(currentRatio) && Number.isFinite(fittedRatio))) return 0;
  const wheelRange = 6 * Math.log(1.25);
  // Tiny epsilon absorbs log/pow roundoff at the exact z3 half-restoration boundary.
  return clamp(Math.log(fittedRatio / currentRatio) / wheelRange + 1e-12, 0, 1);
}

/** Camera translation and orbit do not change this key. Six wheel steps span the full return. */
export function denseZoomBand(currentRatio: number | undefined, fittedRatio: number | undefined): number {
  return Math.min(6, Math.max(0, Math.round(denseZoomProgressForCamera(currentRatio, fittedRatio) * 6)));
}

export function denseZoomNeedsRefresh(currentRatio: number | undefined, fittedRatio: number | undefined,
  renderedBand: number): boolean {
  return denseZoomBand(currentRatio, fittedRatio) !== renderedBand;
}

/** Worker source keeps helper declarations under their bundled runtime names. */
export function denseNodeScalesWorkerSource(
  maximum: typeof maxOf = maxOf,
  minimum: typeof minOf = minOf,
  derive: typeof denseNodeScales = denseNodeScales,
): string {
  return `const MIN_SCREEN_RADIUS_PX=${MIN_SCREEN_RADIUS_PX};
const MIN_SCALE=${MIN_SCALE},MAX_SCALE=${MAX_SCALE},MAX_HUB_BONUS=${MAX_HUB_BONUS};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
${maximum.toString()}
${minimum.toString()}
const denseNodeScales=${derive.toString()};
self.onmessage=event=>{try{self.postMessage({result:[...denseNodeScales(event.data.samples,event.data.options)]});}
catch(error){self.postMessage({error:String(error)});}};`;
}

/** The full nearest-neighbour pass runs after quality restoration in a short-lived worker. */
export function denseNodeScalesDeferred(samples: readonly DenseNodeSample[], options: {
  readonly zoomProgress: number; readonly screenDistanceNorm: ReadonlyMap<string, number>;
  readonly nativeRadiusOnly?: boolean;
}): Promise<ReadonlyMap<string, DenseNodeScale>> {
  if (typeof Worker === 'undefined') return Promise.resolve(denseNodeScales(samples, options));
  const source = denseNodeScalesWorkerSource();
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let worker: Worker;
  try { worker = new Worker(url); }
  catch { return Promise.resolve(denseNodeScales(samples, options)); }
  finally { URL.revokeObjectURL(url); }
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ result?: [string, DenseNodeScale][]; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(new Map(event.data.result ?? []));
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ samples, options });
  });
}

/** Completa-only factor shared by the canvas and native GPU edge tiers. */
export function denseEdgeVeilFactor(opacityPermille: number, baseOpacityPermille: number | undefined): number {
  return baseOpacityPermille === undefined || baseOpacityPermille <= 0
    ? 1 : clamp(opacityPermille / baseOpacityPermille, 0, 1);
}

/**
 * The Sigma/native 2D edge material stores alpha in an 8-bit channel. Keep the measured veil's
 * encoded channel visible after that conversion; Canvas/SVG tiers continue to use float alpha.
 * The floor is deliberately applied to the final alpha, after the base palette alpha.
 */
export const DENSE_NATIVE_EDGE_ALPHA_FLOOR = 2 / 255;
export function denseNativeEdgeAlpha(baseAlpha: number, veilFactor: number, preserveEncodedFloor = true): number {
  const alpha = clamp(baseAlpha, 0, 1) * clamp(veilFactor, 0, 1);
  return !preserveEncodedFloor || veilFactor >= 1 ? alpha : Math.max(DENSE_NATIVE_EDGE_ALPHA_FLOOR, alpha);
}

/** Robust Natural Completa fit envelope: central 99% on each axis plus a small framing margin. */
export function naturalCompletaFitPoints(
  points: readonly { readonly x: number; readonly y: number; readonly z?: number }[],
  quantile = 0.005,
  margin = 0.08,
): { readonly x: number; readonly y: number; readonly z: number }[] {
  const finite = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)
    && Number.isFinite(point.z ?? 0));
  if (!finite.length) return [];
  const q = clamp(quantile, 0, 0.49);
  const bounds = (values: number[]) => {
    values.sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * q)]!;
    const high = values[Math.ceil((values.length - 1) * (1 - q))]!;
    const pad = Math.max((high - low) * clamp(margin, 0, 1), 1e-6);
    return [low - pad, high + pad] as const;
  };
  const xs = bounds(finite.map(point => point.x));
  const ys = bounds(finite.map(point => point.y));
  const z = finite.reduce((sum, point) => sum + (point.z ?? 0), 0) / finite.length;
  return [
    { x: xs[0], y: ys[0], z }, { x: xs[1], y: ys[0], z },
    { x: xs[1], y: ys[1], z }, { x: xs[0], y: ys[1], z },
  ];
}

/** Fraction of centres covered by another node's disc, using the emitted drawing radii. */
export function centreCoverageFraction(
  points: readonly { readonly id: string; readonly x: number; readonly y: number; readonly radius: number }[],
): number {
  if (!points.length) return 0;
  const cellSize = Math.max(1, maxOf(points.map(point => point.radius)) * 2);
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
