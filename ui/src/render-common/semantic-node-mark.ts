// D087-SIZE BEGIN
/** The D-086 Natural Neural point law reaches this fitted CSS radius in the 2D witness. */
export const NATURAL_NEURAL_FITTED_LEAF_CORE_PX = 1.8;
export const DENSE_LEAF_MIN_CORE_PX = 0.5;
/** D-086 fit kept real dots whose centres were at least one CSS pixel apart. */
export const DENSE_FIT_POINT_SEPARATION_PX = 1.001;

/** One full-graph D-086 dense-law sample sets the fitted leaf target. Zero-radius members are
 * covered by another real node and must not influence the median. The Natural Neural point
 * floor matches the D-086 fitted witness; other views retain the dense law's own small mark. */
export function calibratedLeafCorePx(radii: readonly number[], morphology: string,
  projection: '2d' | '3d'): number {
  const drawn = radii.filter(radius => radius > 0 && Number.isFinite(radius)).sort((a, b) => a - b);
  const median = drawn[Math.floor(drawn.length / 2)] ?? DENSE_LEAF_MIN_CORE_PX;
  return morphology === 'neural' && projection === '2d'
    ? Math.max(NATURAL_NEURAL_FITTED_LEAF_CORE_PX, median)
    : Math.max(DENSE_LEAF_MIN_CORE_PX, median);
}

/** Structural classification reads the full snapshot hierarchy, never a mounted subset of it:
 * a parent is structural while any child exists in the full graph, even when every density the
 * page can mount dropped that child from its admitted set. */
export function fullHierarchyStructuralIds(
  nodes: readonly { readonly id: string; readonly parent: string | null }[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const node of nodes) if (node.parent !== null) ids.add(node.parent);
  return ids;
}

export type CoLocatedMark = Readonly<{
  id: string;
  x: number;
  y: number;
  coreRadiusPx: number;
  structural: boolean;
}>;

/** A deterministic independent set of real marks in screen space. */
export function coLocatedRepresentatives(marks: readonly CoLocatedMark[]): ReadonlyMap<string, string> {
  const ordered = [...marks].sort((a, b) => Number(b.structural) - Number(a.structural)
    || a.id.localeCompare(b.id));
  // A large structural disc may overlap a leaf without being co-located with its centre.
  // Suppressing that leaf changed Julia's real-dot count by thousands at the fitted view.
  const cellSize = DENSE_FIT_POINT_SEPARATION_PX;
  const buckets = new Map<string, CoLocatedMark[]>();
  const representatives = new Map<string, string>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const mark of ordered) {
    const cx = Math.floor(mark.x / cellSize), cy = Math.floor(mark.y / cellSize);
    let winner: CoLocatedMark | undefined;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const candidate of buckets.get(key(cx + dx, cy + dy)) ?? []) {
        if (Math.hypot(mark.x - candidate.x, mark.y - candidate.y) < cellSize) {
          winner = candidate;
          break;
        }
      }
      if (winner) break;
    }
    representatives.set(mark.id, winner?.id ?? mark.id);
    if (!winner) {
      const bucketKey = key(cx, cy);
      const bucket = buckets.get(bucketKey) ?? [];
      bucket.push(mark);
      buckets.set(bucketKey, bucket);
    }
  }
  return representatives;
}
// D087-SIZE END
