// D087-SIZE BEGIN
/** The D-086 dense overview's small leaf output, calibrated at the fitted camera. */
export const FITTED_LEAF_CORE_PX = 1;
export const LEAF_HALO_RATIO = 1.45;
export const LEAF_HALO_INTENSITY_PERMILLE = 80;
export const LEAF_HALO_ALPHA_FACTOR = 0.35;

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
  const cellSize = Math.max(1, ...ordered.map(mark => mark.coreRadiusPx));
  const buckets = new Map<string, CoLocatedMark[]>();
  const representatives = new Map<string, string>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const mark of ordered) {
    const cx = Math.floor(mark.x / cellSize), cy = Math.floor(mark.y / cellSize);
    let winner: CoLocatedMark | undefined;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const candidate of buckets.get(key(cx + dx, cy + dy)) ?? []) {
        if (Math.hypot(mark.x - candidate.x, mark.y - candidate.y) < candidate.coreRadiusPx) {
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
