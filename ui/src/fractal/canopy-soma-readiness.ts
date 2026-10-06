import type { MorphologyGeometry } from '../engine/morphology-geometry.ts';

// D082-B1f BEGIN: readiness belongs to the geometry actually painted on this host.
type SomaHost = Pick<Element, 'setAttribute' | 'removeAttribute' | 'hasAttribute' | 'dispatchEvent'>;
const mounted = new WeakMap<SomaHost, MorphologyGeometry>();

export function beginCanopySomaFrame(host: SomaHost | null, geometry: MorphologyGeometry,
  moving: boolean): void {
  if (!host) return;
  if (mounted.get(host) !== geometry || moving) {
    const wasReady = host.hasAttribute('data-fractal-somata-ready');
    host.removeAttribute('data-fractal-somata-ready');
    if (wasReady) host.dispatchEvent(new Event('d082:canopy-soma-pending', { bubbles: true }));
  }
  mounted.set(host, geometry);
}

export function presentCanopySomaFrame(host: SomaHost | null, geometry: MorphologyGeometry,
  allOutlinesDrawn: boolean): void {
  if (!host || mounted.get(host) !== geometry || !allOutlinesDrawn) return;
  if (host.hasAttribute('data-fractal-somata-ready')) return;
  host.setAttribute('data-fractal-somata-ready', '');
  host.dispatchEvent(new Event('d082:canopy-soma-ready', { bubbles: true }));
}

/** A fallback disc is loaded geometry, but its final soma outline is not yet drawn. */
type SomaReadiness = { readonly quality: 'movimento' | 'recupero' | 'completa';
  readonly ladder: 0 | 1 | 2 | 3 | 4;
  readonly nodes: { readonly required: number; readonly loaded: number; readonly drawn: number } };
export function capUnpresentedCanopySomata<T extends SomaReadiness>(next: T): T {
  if (next.nodes.required <= 0) return next;
  return { ...next, quality: 'recupero', ladder: Math.min(next.ladder, 3) as SomaReadiness['ladder'],
    nodes: { ...next.nodes, drawn: Math.min(next.nodes.drawn, next.nodes.required - 1) } } as T;
}
// D082-B1f END
