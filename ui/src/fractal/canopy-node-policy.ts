import { MIN_SCREEN_RADIUS_PX, type DenseNodeScale } from '../render-common/dense-node-scale.ts';

/** Canopy retains every real vertex as its own visible point. */
export function canopyCompleteNodeScales(scales: ReadonlyMap<string, DenseNodeScale>): Map<string, DenseNodeScale> {
  return new Map([...scales].map(([id, value]) =>
    [id, { ...value, radiusPx: Math.max(MIN_SCREEN_RADIUS_PX, value.radiusPx), representativeId: id }]));
}
