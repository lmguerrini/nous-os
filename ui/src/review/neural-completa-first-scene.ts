import { maxOf, minOf } from '#render-common/array-aggregation.ts';
import type { Coordinates } from '../engine/contract.ts';
import { denseEdgeScreenDensities, naturalCompletaFitPoints } from '../render-common/dense-node-scale.ts';

/** The density grid counts only the part of a relation inside the fitted viewport. */
export function clipNeuralCompletaScreenSegment(
  source: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  width: number, height: number,
): { source: { x: number; y: number }; target: { x: number; y: number } } | null {
  const dx = target.x - source.x, dy = target.y - source.y;
  let first = 0, last = 1;
  const boundaries: readonly (readonly [number, number])[] = [[-dx, source.x], [dx, width - source.x],
    [-dy, source.y], [dy, height - source.y]];
  for (const [p, q] of boundaries) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) first = Math.max(first, t);
    else last = Math.min(last, t);
    if (first > last) return null;
  }
  return { source: { x: source.x + dx * first, y: source.y + dy * first },
    target: { x: source.x + dx * last, y: source.y + dy * last } };
}

/** Screen-cell inputs for the first Natural 2D Neural Completa scene, before Sigma exists.
 * Use the same robust cloud that the opening camera fits. Outliers keep their positions. */
export function neuralCompletaFirstSceneScreen(
  anchors: ReadonlyMap<string, Coordinates>,
  edges: readonly { readonly id: string; readonly source: string; readonly target: string }[],
  width: number, height: number,
) {
  const fit = naturalCompletaFitPoints([...anchors.values()]);
  const minX = minOf(fit.map(point => point.x));
  const maxX = maxOf(fit.map(point => point.x));
  const minY = minOf(fit.map(point => point.y));
  const maxY = maxOf(fit.map(point => point.y));
  const scale = Math.max(0.001, Math.min(Math.max(1, width) / Math.max(1e-6, maxX - minX),
    Math.max(1, height) / Math.max(1e-6, maxY - minY)));
  const screen = new Map([...anchors].map(([id, point]) =>
    [id, { x: (point.x - minX) * scale, y: (point.y - minY) * scale }] as const));
  const edgeDensities = denseEdgeScreenDensities(edges.flatMap(edge => {
    const source = screen.get(edge.source), target = screen.get(edge.target);
    const clipped = source && target ? clipNeuralCompletaScreenSegment(source, target, width, height) : null;
    return clipped ? [{ id: edge.id, sourceScreenX: clipped.source.x, sourceScreenY: clipped.source.y,
      targetScreenX: clipped.target.x, targetScreenY: clipped.target.y }] : [];
  }));
  return { screen, scale, edgeDensities };
}
