import type { Coordinates } from '../engine/contract.ts';
import type { Morphology } from '../engine/morphology.ts';
import { MORPHOLOGY_CONTRACT } from '../engine/morphology-contract.ts';
import { stellarStarCoreRadiusPx } from '../render-common/morphology-canvas.ts';
import type { ScreenPickDisc } from '../render2d/model.ts';

/** Use the centres of committed morphology marks and the mounted ink radii. */
export function product2dPickDiscs(
  nodes: readonly Readonly<{ id: string; position: Coordinates; radius: number; degree: number }>[],
  visible: ReadonlySet<string>,
  givenRadius: (id: string, fallback: number) => number,
  drawnRadius: ReadonlyMap<string, number>,
  project: (point: Coordinates) => Readonly<{ x: number; y: number }>,
  scale: number,
  morphology: Morphology,
  dense: boolean,
  mountedAnchors: readonly Readonly<{ id: string; position: Coordinates }>[] = [],
): readonly ScreenPickDisc[] {
  const contract = MORPHOLOGY_CONTRACT[morphology];
  const mountedNodes = mountedAnchors.filter(anchor => visible.has(anchor.id)
    && (drawnRadius.get(anchor.id) ?? 0) > 0).map(anchor => ({ ...anchor,
      radius: drawnRadius.get(anchor.id)!, degree: 1 }));
  return [...nodes, ...mountedNodes].flatMap(node => {
    if (!visible.has(node.id)) return [];
    const given = givenRadius(node.id, node.radius);
    if (dense && given === 0) return [];
    const basis = Math.min(contract.node.maxRadiusPx,
      Math.max(dense ? 0.5 : morphology === 'mycelium' ? 1.3 : 2,
        given * scale * contract.node.scale));
    const fallback = morphology === 'stellar' && basis > 1
      ? stellarStarCoreRadiusPx(basis, node.degree) : basis;
    const centre = project(node.position);
    return [{ id: node.id, x: centre.x, y: centre.y,
      radius: drawnRadius.get(node.id) ?? fallback }];
  });
}
