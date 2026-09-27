import { morphologyLayoutParams } from "#engine/morphology.ts";
import type { MorphologyGeometry, MorphologySegment } from "#engine/morphology-geometry.ts";

export type MorphologyMetrics = {
  readonly edgeStraightness: readonly number[];
  readonly bendCount: readonly number[];
  readonly inflections: readonly number[];
  readonly taperVariance: readonly number[];
  readonly sharedTrunkLengthShare: number;
  readonly branchingPoints: number;
  readonly nodeEccentricities: readonly number[];
  readonly relationCurvatures: readonly string[];
  readonly layout: ReturnType<typeof morphologyLayoutParams>;
};

const span = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const arc = (part: MorphologySegment): number => {
  let total = 0;
  for (let step = 1; step < part.samples.length; step += 1) total += span(part.samples[step - 1]!, part.samples[step]!);
  return total;
};
const variance = (values: readonly number[]): number => {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
};

/** Measures the emitted paths, widths and shared keys rather than a renderer screenshot. */
export function morphologyMetrics(geometry: MorphologyGeometry): MorphologyMetrics {
  const uses = new Map<string, number>();
  for (const edge of geometry.edges) for (const part of edge.segments) if (part.sharedKey) uses.set(part.sharedKey, (uses.get(part.sharedKey) ?? 0) + 1);
  const totalLength = geometry.drawnSegments.reduce((sum, part) => sum + arc(part), 0);
  const sharedLength = geometry.drawnSegments.reduce((sum, part) => sum + (part.sharedKey && (uses.get(part.sharedKey) ?? 0) > 1 ? arc(part) : 0), 0);
  return {
    edgeStraightness: geometry.edges.map((edge) => {
      if (edge.segments.every((part) => part.curvature === 0)) return 1;
      const first = edge.segments[0], last = edge.segments.at(-1);
      if (!first || !last) return 1;
      const chord = span(first.source, last.target);
      const path = edge.segments.reduce((sum, part) => sum + arc(part), 0);
      return path === 0 ? 1 : chord / path;
    }),
    bendCount: geometry.edges.map((edge) => edge.segments.filter((part) => Math.abs(part.curvature) > 1e-10).length),
    inflections: geometry.edges.map((edge) => {
      const signs = edge.segments.map((part) => Math.sign(part.curvature)).filter(Boolean);
      return signs.slice(1).filter((sign, index) => sign !== signs[index]).length;
    }),
    taperVariance: geometry.edges.map((edge) => variance(edge.segments.flatMap((part) => [part.widthStart, part.widthEnd]))),
    sharedTrunkLengthShare: totalLength === 0 ? 0 : sharedLength / totalLength,
    branchingPoints: geometry.branchPoints.length,
    nodeEccentricities: geometry.nodes.map((node) => node.eccentricity),
    relationCurvatures: geometry.edges.map((edge) => edge.segments.map((part) =>
      (arc(part) / Math.max(1e-9, span(part.source, part.target))).toFixed(5)).join(",")),
    layout: morphologyLayoutParams(geometry.morphology),
  };
}
