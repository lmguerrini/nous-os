/**
 * Deterministic PCA volume metric and per-axis balancing for a 3D point set.
 *
 * The Flat 3D embedding is judged by how much of the structure occupies all three axes, never by a
 * bounding box that a few outliers can inflate. `volumeStats` trims the 2% farthest points and
 * reports the eigenvalues of the covariance matrix of the visible positions (λ1 ≥ λ2 ≥ λ3) together
 * with the anisotropy ratios λ2/λ1 and λ3/λ1. `canonicalize` rotates the cloud into its PCA frame
 * (X = first principal axis, Y = second, Z = third, fixed signs) and then scales Y and Z toward the
 * default anisotropy targets, so the default view is already volumetric before the user touches the
 * `expandX/Y/Z` sliders. `equilibrate` derives per-axis expansion factors that make the principal
 * extents balanced — exact now that `canonicalize` has aligned the axes with the principal ones —
 * and `applyExpansion` applies them without touching data, relations or identities.
 */
import type { Point3 } from "./layout-v2.ts";

export type VolumeRatios = { readonly second: number; readonly third: number };
export type VolumeStats = {
  readonly eigenvalues: readonly [number, number, number];
  readonly ratios: VolumeRatios;
  readonly count: number;
  readonly trimmed: number;
};
export type Expansion = { readonly expandX: number; readonly expandY: number; readonly expandZ: number };

/** Share of the farthest points removed before the covariance is estimated. */
const TRIM_FRACTION = 0.02;
/** Expansion limits, matching the appearance ranges so the button never leaves them. */
const EXPAND_MIN = 0.3;
const EXPAND_MAX = 2.5;
/** Default anisotropy targets: the default Flat 3D view must reach λ2/λ1 ≥ 0.5 and λ3/λ1 ≥ 0.3. The
 * internal targets carry a margin because the metric trims its 2% farthest points, which shifts the
 * measured ratio slightly; scaling toward 0.6/0.4 keeps the trimmed default comfortably above the
 * 0.5/0.3 requirement. */
export const TARGET_SECOND = 0.6;
export const TARGET_THIRD = 0.4;
const EPSILON = 1e-12;

/** The PCA frame of a point set: axes are unit eigenvectors sorted by descending eigenvalue, right-handed. */
export type PrincipalFrame = {
  readonly centroid: Point3;
  readonly axes: readonly [Point3, Point3, Point3];
  readonly eigenvalues: readonly [number, number, number];
};

function asPoints(positions: ReadonlyMap<string, Point3> | readonly Point3[]): Point3[] {
  if (positions instanceof Map) return [...positions.values()];
  return [...(positions as readonly Point3[])];
}

function asEntries(positions: ReadonlyMap<string, Point3> | readonly Point3[]): readonly [string, Point3][] {
  if (positions instanceof Map) return [...positions.entries()];
  return (positions as readonly Point3[]).map((point, index) => [`p${index}`, point] as const);
}

function centroid(points: readonly Point3[]): Point3 {
  const count = points.length || 1;
  let x = 0, y = 0, z = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
    z += point.z;
  }
  return { x: x / count, y: y / count, z: z / count };
}

/** Drops the TRIM_FRACTION farthest points (by squared distance from the centroid), keeping at least three. */
function trimmed(points: readonly Point3[]): { points: Point3[]; trimmed: number } {
  const total = points.length;
  if (total <= 8)
    return { points: [...points], trimmed: 0 };
  const centre = centroid(points);
  const ranked = points
    .map((point, index) => ({ index, distance: (point.x - centre.x) ** 2 + (point.y - centre.y) ** 2 + (point.z - centre.z) ** 2 }))
    .sort((a, b) => b.distance - a.distance || a.index - b.index);
  const drop = Math.min(total - 3, Math.floor(total * TRIM_FRACTION));
  const keep = new Set(ranked.slice(drop).map(item => item.index));
  return { points: points.filter((_, index) => keep.has(index)), trimmed: drop };
}

/** Sample covariance matrix (3×3) of a centred point set. */
function covariance(points: readonly Point3[]): readonly (readonly number[])[] {
  const centre = centroid(points);
  const count = points.length;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const point of points) {
    const dx = point.x - centre.x, dy = point.y - centre.y, dz = point.z - centre.z;
    xx += dx * dx;
    yy += dy * dy;
    zz += dz * dz;
    xy += dx * dy;
    xz += dx * dz;
    yz += dy * dz;
  }
  const denom = Math.max(1, count - 1);
  return [
    [xx / denom, xy / denom, xz / denom],
    [xy / denom, yy / denom, yz / denom],
    [xz / denom, yz / denom, zz / denom],
  ];
}

/** Eigen-decomposition of a symmetric 3×3 matrix via Jacobi rotations. Deterministic. */
function symmetricEigen(input: readonly (readonly number[])[]): { eigenvalues: [number, number, number]; vectors: readonly [Point3, Point3, Point3] } {
  const a = [
    [input[0]![0]!, input[0]![1]!, input[0]![2]!],
    [input[1]![0]!, input[1]![1]!, input[1]![2]!],
    [input[2]![0]!, input[2]![1]!, input[2]![2]!],
  ];
  const v: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let p = 0, q = 1, off = Math.abs(a[0]![1]!);
    if (Math.abs(a[0]![2]!) > off) { off = Math.abs(a[0]![2]!); p = 0; q = 2; }
    if (Math.abs(a[1]![2]!) > off) { off = Math.abs(a[1]![2]!); p = 1; q = 2; }
    if (off < 1e-14) break;
    const app = a[p]![p]!, aqq = a[q]![q]!, apq = a[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    a[p]![p]! = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q]![q]! = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p]![q]! = 0;
    a[q]![p]! = 0;
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const akp = a[k]![p]!, akq = a[k]![q]!;
      a[k]![p]! = c * akp - s * akq;
      a[p]![k]! = a[k]![p]!;
      a[k]![q]! = s * akp + c * akq;
      a[q]![k]! = a[k]![q]!;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k]![p]!, vkq = v[k]![q]!;
      v[k]![p]! = c * vkp - s * vkq;
      v[k]![q]! = s * vkp + c * vkq;
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[y]![y]! - a[x]![x]!);
  const eigenvalues = order.map(index => a[index]![index]!) as [number, number, number];
  const raw = order.map(index => ({ x: v[0]![index]!, y: v[1]![index]!, z: v[2]![index]! }));
  // Fixed sign convention: each axis points toward its largest-magnitude component being positive.
  const signAxis = (axis: Point3): Point3 => {
    const magnitudes = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)];
    let index = 0;
    if (magnitudes[1]! > magnitudes[index]!) index = 1;
    if (magnitudes[2]! > magnitudes[index]!) index = 2;
    const component = index === 0 ? axis.x : index === 1 ? axis.y : axis.z;
    return component < 0 ? { x: -axis.x, y: -axis.y, z: -axis.z } : axis;
  };
  const axes = raw.map(signAxis) as [Point3, Point3, Point3];
  // Make the frame right-handed so the rotation never mirrors the cloud.
  const cross = (u: Point3, w: Point3): Point3 => ({ x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x });
  const determinant = cross(axes[0], axes[1]).x * axes[2].x + cross(axes[0], axes[1]).y * axes[2].y + cross(axes[0], axes[1]).z * axes[2].z;
  if (determinant < 0) axes[2] = { x: -axes[2].x, y: -axes[2].y, z: -axes[2].z };
  return { eigenvalues, vectors: axes };
}

/** PCA frame of the visible 3D positions (trimmed), used by `volumeStats`, `canonicalize` and tests. */
export function principalFrame(positions: ReadonlyMap<string, Point3> | readonly Point3[]): PrincipalFrame {
  const all = asPoints(positions);
  const { points } = trimmed(all);
  const centre = centroid(points);
  const { eigenvalues, vectors } = symmetricEigen(covariance(points));
  return { centroid: centre, axes: vectors, eigenvalues };
}

/**
 * PCA volume metric of the visible 3D positions. The covariance is estimated after trimming the 2%
 * farthest points, so a handful of stray nodes cannot fake or erase the volume. λ1 ≥ λ2 ≥ λ3 with the
 * ratios λ2/λ1 and λ3/λ1: a flat sheet has λ3/λ1 ≈ 0, a ball ≈ 1.
 */
export function volumeStats(positions: ReadonlyMap<string, Point3> | readonly Point3[]): VolumeStats {
  const all = asPoints(positions);
  const { points, trimmed: trimmedCount } = trimmed(all);
  if (points.length < 2) {
    return { eigenvalues: [1, 1, 1], ratios: { second: 1, third: 1 }, count: all.length, trimmed: trimmedCount };
  }
  const { eigenvalues } = symmetricEigen(covariance(points));
  const first = Math.max(EPSILON, eigenvalues[0]);
  return {
    eigenvalues,
    ratios: { second: eigenvalues[1] / first, third: eigenvalues[2] / first },
    count: all.length,
    trimmed: trimmedCount,
  };
}

/** Scales the three axes of a point set; never changes ids, relations or identities. */
export function applyExpansion(positions: ReadonlyMap<string, Point3>, expansion: Expansion): Map<string, Point3> {
  const next = new Map<string, Point3>();
  for (const [id, point] of positions)
    next.set(id, { x: point.x * expansion.expandX, y: point.y * expansion.expandY, z: point.z * expansion.expandZ });
  return next;
}

/** Rotates the cloud into its PCA frame: X = first principal axis, Y = second, Z = third. Deterministic. */
export function rotateToPrincipalAxes(positions: ReadonlyMap<string, Point3> | readonly Point3[]): Map<string, Point3> {
  const entries = asEntries(positions);
  const points = entries.map(([, point]) => point);
  if (points.length < 2)
    return new Map(entries.map(([id, point]) => [id, { ...point }]));
  const frame = principalFrame(points);
  const result = new Map<string, Point3>();
  for (const [id, point] of entries) {
    const d = { x: point.x - frame.centroid.x, y: point.y - frame.centroid.y, z: point.z - frame.centroid.z };
    result.set(id, {
      x: d.x * frame.axes[0].x + d.y * frame.axes[0].y + d.z * frame.axes[0].z,
      y: d.x * frame.axes[1].x + d.y * frame.axes[1].y + d.z * frame.axes[1].z,
      z: d.x * frame.axes[2].x + d.y * frame.axes[2].y + d.z * frame.axes[2].z,
    });
  }
  return result;
}

/**
 * The default Flat 3D canonicalisation: rotate into the PCA frame, then scale Y and Z up only if the
 * cloud is still elongated, so the default anisotropy meets λ2/λ1 ≥ TARGET_SECOND and λ3/λ1 ≥
 * TARGET_THIRD. X is left untouched (it is the longest principal axis), and the user's `expandX/Y/Z`
 * multiply on top. Deterministic.
 */
export function canonicalize(positions: ReadonlyMap<string, Point3> | readonly Point3[]): Map<string, Point3> {
  const entries = asEntries(positions);
  const points = entries.map(([, point]) => point);
  if (points.length < 2)
    return new Map(entries.map(([id, point]) => [id, { ...point }]));
  const frame = principalFrame(points);
  const first = Math.max(EPSILON, frame.eigenvalues[0]);
  const ratioSecond = frame.eigenvalues[1] / first;
  const ratioThird = frame.eigenvalues[2] / first;
  const scaleY = ratioSecond < TARGET_SECOND ? Math.sqrt(TARGET_SECOND / Math.max(EPSILON, ratioSecond)) : 1;
  const scaleZ = ratioThird < TARGET_THIRD ? Math.sqrt(TARGET_THIRD / Math.max(EPSILON, ratioThird)) : 1;
  const result = new Map<string, Point3>();
  for (const [id, point] of entries) {
    const d = { x: point.x - frame.centroid.x, y: point.y - frame.centroid.y, z: point.z - frame.centroid.z };
    result.set(id, {
      x: d.x * frame.axes[0].x + d.y * frame.axes[0].y + d.z * frame.axes[0].z,
      y: (d.x * frame.axes[1].x + d.y * frame.axes[1].y + d.z * frame.axes[1].z) * scaleY,
      z: (d.x * frame.axes[2].x + d.y * frame.axes[2].y + d.z * frame.axes[2].z) * scaleZ,
    });
  }
  return result;
}

/**
 * Per-axis expansion factors that balance the embedding's principal extents. The covariance diagonal is
 * whitened through a few Jacobi preconditioning iterations (each axis is divided by its own standard
 * deviation), then the factors are normalised so the geometric mean stays 1 — the overall size is
 * preserved and only the aspect ratio changes. Exact when the input is already in its PCA frame
 * (e.g. the output of `canonicalize`), since the covariance is then diagonal. Deterministic.
 */
export function equilibrate(positions: ReadonlyMap<string, Point3> | readonly Point3[]): Expansion {
  const { points } = trimmed(asPoints(positions));
  if (points.length < 3)
    return { expandX: 1, expandY: 1, expandZ: 1 };
  const source = covariance(points);
  const matrix = [
    [source[0]![0]!, source[0]![1]!, source[0]![2]!],
    [source[1]![0]!, source[1]![1]!, source[1]![2]!],
    [source[2]![0]!, source[2]![1]!, source[2]![2]!],
  ];
  let expandX = 1, expandY = 1, expandZ = 1;
  for (let iteration = 0; iteration < 6; iteration++) {
    const sx = 1 / Math.sqrt(Math.max(EPSILON, matrix[0]![0]!));
    const sy = 1 / Math.sqrt(Math.max(EPSILON, matrix[1]![1]!));
    const sz = 1 / Math.sqrt(Math.max(EPSILON, matrix[2]![2]!));
    expandX *= sx;
    expandY *= sy;
    expandZ *= sz;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        matrix[i]![j]! *= [sx, sy, sz][i]! * [sx, sy, sz][j]!;
  }
  const mean = Math.cbrt(Math.max(EPSILON, expandX * expandY * expandZ));
  expandX /= mean;
  expandY /= mean;
  expandZ /= mean;
  const clamp = (value: number) => Math.min(EXPAND_MAX, Math.max(EXPAND_MIN, value));
  return { expandX: clamp(expandX), expandY: clamp(expandY), expandZ: clamp(expandZ) };
}
