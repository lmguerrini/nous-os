import type { Coordinates } from '../engine/contract.ts';
import { denseEdgeScreenDensities } from '../render-common/dense-node-scale.ts';

// D082-A-VEIL2 BEGIN: A-INT12's screen-cell projection for Stellar and Mycelium.
// This deliberately uses layout coordinates even when a renderer is mounted.
export function nonNeuralCompletaScreenDensities(
  edges: readonly { readonly id: string; readonly source: string; readonly target: string }[],
  anchors: ReadonlyMap<string, Coordinates>, projection: '2d' | '3d',
  minX: number, minY: number, screenScale: number,
): ReadonlyMap<string, number> {
  const projectForSize = (point: Coordinates) => projection === '3d'
    ? { x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 } : point;
  return denseEdgeScreenDensities(edges.flatMap(edge => {
    const source = anchors.get(edge.source), target = anchors.get(edge.target);
    if (!source || !target) return [];
    const from = projectForSize(source), to = projectForSize(target);
    return [{
      id: edge.id,
      sourceScreenX: (from.x - minX) * screenScale, sourceScreenY: (from.y - minY) * screenScale,
      targetScreenX: (to.x - minX) * screenScale, targetScreenY: (to.y - minY) * screenScale,
    }];
  }));
}
// D082-A-VEIL2 END
