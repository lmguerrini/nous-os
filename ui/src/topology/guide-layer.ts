/** Non-semantic law guides, projected with the active classic camera only when it changes. */
import type { GuideCurve, TopologyLayout } from './contract.ts';
import type { ProductView } from '../review/view-contract.ts';
import { LULL_OUTER_RADIUS } from './lull.ts';
// D085-S4 BEGIN: a drawn bundle uses the exact active routed fold.
import type { LullOverviewPairFold } from './lull-overview.ts';
// D085-S4 END

// D085-S4 BEGIN: the Llull semantic zoom is now real
// aggregation. While the camera is in the overview band the page's relation
// routing does not draw the cross-sector strokes one by one — they are folded
// into these pair bundles, which are the visible aggregates — and on approach
// the exact individual relations return when the settled fold releases. The
// overview veil is absent. Bundle ink follows the committed fold so a moving
// camera never fades it before the individual relations return.
type LullWeightedGuide = GuideCurve & Readonly<{ weight: number }>;
// D086-F4 BEGIN: standalone and composed bundle IDs share one source compartment key.
export function lullGuideBundleLetters(id: string): string {
  const prefix = 'lull:bundle:';
  const at = id.indexOf(prefix);
  if (at < 0) throw new Error('Llull bundle guide without a source compartment key');
  return id.slice(at + prefix.length);
}
// D086-F4 END
// The active visual weights are taken only from replaced sources.
export function lullVisibleBundleWeights(pairs: readonly LullOverviewPairFold[]): ReadonlyMap<string, number> {
  return new Map(pairs.filter(pair => pair.relationIds.length)
    .map(pair => [pair.letters, pair.relationIds.length]));
}
const LULL_ZOOM_FADE_BEGIN = 2.15;
const LULL_ZOOM_FADE_END = 2.5;
/** The fitted-wheel scale of the current camera: the projected wheel diameter
 * over the viewport's smaller side (≈ 1 when the wheel exactly fits). 0 when the
 * camera cannot be projected — callers must treat that as "not overview". */
// D086-F4 BEGIN: fold and canvas consume the same fitted root radius.
export function lullGuideRadius(layout: TopologyLayout | null): number {
  if (!layout) return LULL_OUTER_RADIUS;
  for (const witness of layout.witnesses.values()) {
    const r = Number(witness.values.rootRingRadius);
    const s = Number(witness.values.globalScale);
    if (Number.isFinite(r) && r > 0 && Number.isFinite(s) && s > 0) return r * s;
  }
  return LULL_OUTER_RADIUS;
}
function lullOverviewFactor(view: ProductView, width: number, height: number, radius = LULL_OUTER_RADIUS): number {
  const origin = view.projectPoint!({ x: 0, y: 0, z: 0 });
  const east = view.projectPoint!({ x: 1000, y: 0, z: 0 });
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)
    || !Number.isFinite(east.x) || !Number.isFinite(east.y)) return 0;
  const scale = Math.hypot(east.x - origin.x, east.y - origin.y) / 1000;
  if (!(scale > 0)) return 0;
  return scale * 2 * radius / Math.max(1, Math.min(width, height));
}
/** Diagnostic overview share of the projected scale: full while the wheel is seen from up to
 * LULL_ZOOM_FADE_BEGIN times its fitted size, easing to 0 by LULL_ZOOM_FADE_END —
 * the same window in which the settled fold releases. The mounted layer uses
 * its committed active pairs for visibility to avoid hiding edges during a
 * camera gesture. Unprojectable cameras give 0. */
export function lullOverviewFade(view: ProductView, width: number, height: number, radius = LULL_OUTER_RADIUS): number {
  const factor = lullOverviewFactor(view, width, height, radius);
  if (factor <= 0) return 0;
  if (factor <= LULL_ZOOM_FADE_BEGIN) return 1;
  if (factor >= LULL_ZOOM_FADE_END) return 0;
  return (LULL_ZOOM_FADE_END - factor) / (LULL_ZOOM_FADE_END - LULL_ZOOM_FADE_BEGIN);
}
/** Whether the relation routing must fold the cross-sector strokes into the
 * pair bundles for this camera. Hysteresis like the LOD bands (the previous
 * state decides inside the gap) so a camera parked at the threshold cannot
 * oscillate: aggregated while the fitted wheel is at or under 2.2×, individual
 * above 2.4× — inside the fade window, where both inks cross-fade. */
export function lullOverviewAggregated(view: ProductView, width: number, height: number,
  previous: boolean, radius = LULL_OUTER_RADIUS): boolean {
  const factor = lullOverviewFactor(view, width, height, radius);
  if (factor <= 0) return previous;
  if (factor <= 2.2) return true;
  if (factor >= 2.4) return false;
  return previous;
}
// Disabling semantic zoom releases every folded stroke at the
// next refresh; the guide layer then has no active bundle ink at any scale.
export function lullOverviewMode(semanticZoom: boolean, view: ProductView,
  width: number, height: number, previous: boolean, radius = LULL_OUTER_RADIUS): boolean {
  return semanticZoom && lullOverviewAggregated(view, width, height, previous, radius);
}
// D086-F4 END
// D085-S4 END

export function mountTopologyGuides(host: HTMLElement, view: ProductView,
  guides: readonly GuideCurve[], activeLullPairs?: () => readonly LullOverviewPairFold[],
  lullRadius = LULL_OUTER_RADIUS): { destroy(): void; invalidate(): void } {
  // D085-S4 BEGIN: the page invalidates this live source after every committed fold.
  if (!guides.length || !view.projectPoint) return { destroy() {}, invalidate() {} };
  if (guides.some(guide => guide.semantic !== false || !guide.id))
    throw new Error('Topology guide must be non-semantic');
  // D085-S5 BEGIN: source-ID routes stay in the layout contract but cannot
  // compete for a visible chart budget without drawn-edge eligibility tokens.
  const drawableGuides = guides.filter(guide => guide.kind !== 'indra-real-edge-route');
  // D085-S5 END
  // D086-F4 BEGIN
  const canvas = document.createElement('canvas');
  canvas.dataset.lullRootRadius = String(lullRadius);
  // D086-F4 END
  canvas.dataset.topologyGuides = 'true';
  // D085-S5 BEGIN: the mounted guide surface exposes actual stroke accounting.
  canvas.dataset.guideRequested = String(guides.length);
  canvas.dataset.guideDrawn = '0';
  canvas.dataset.guideSuppressed = '0';
  // D085-S5 END
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '1' });
  host.append(canvas);
  const context = canvas.getContext('2d');
  if (!context) { canvas.remove(); return { destroy() {}, invalidate() {} }; }
  let frame = 0;
  let destroyed = false;
  let settleTimer: number | null = null;
  // D085-S5 BEGIN: sample guides across all pearls during motion, then restore
  // the density's deterministic guide budget after the camera settles.
  let interacting = false;
  // D085-S5 END
  const draw = () => {
    frame = 0;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    // The committed share of the Llull semantic zoom, the
    // heaviest bundle (which sets the width/opacity scale of all of them) and whether
    // this is the flat view — the flat bundles sit at z=0, the lifted ones at their
    // offset-class tables, so the lifted view styles its bundles lighter and keeps
    // its four tables readable.
    const lullZoom = guides.some(guide => guide.kind === 'lull-pair-bundle');
    // The route's committed fold owns bundle visibility. A camera
    // move cannot fade an aggregate before its source strokes are released.
    const activePairs = activeLullPairs?.() ?? [];
    const activeWeights = lullVisibleBundleWeights(activePairs);
    const overview = activeLullPairs ? (activePairs.length ? 1 : 0)
      : lullZoom ? lullOverviewFade(view, width, height, lullRadius) : 0;
    const flatView = guides.some(guide => guide.kind === 'lull-pair-bundle'
      && guide.points.every(point => !point.z));
    let bundleMax = 0;
    for (const guide of guides)
      if (guide.kind === 'lull-pair-bundle') {
        const active = activeWeights.get(lullGuideBundleLetters(guide.id));
        bundleMax = Math.max(bundleMax, activeLullPairs ? active ?? 0
          : (guide as LullWeightedGuide).weight);
      }
    context.strokeStyle = 'rgba(180,190,210,.22)';
    context.lineWidth = 0.75;
    // D085-S5 BEGIN: route hints have no eligibility token at this surface; never
    // paint them. Fine guide volume is capped deterministically during interaction.
    let drawn = 0, suppressed = guides.length - drawableGuides.length;
    // D085-S5 BEGIN: standalone Lab views keep their complete D-084 guide
    // field at rest; only Indra compositions use density sampling then.
    const composed = drawableGuides.some(guide => guide.id.startsWith('indra:') || guide.id.startsWith('indra-root:'))
      || guides.some(guide => guide.kind === 'indra-real-edge-route');
    const density = document.querySelector<HTMLButtonElement>('#density-control button[data-density][aria-pressed="true"]')?.dataset.density ?? 'balanced';
    const budget = interacting ? Math.min(450, drawableGuides.length)
      : composed ? Math.min(drawableGuides.length, density === 'complete' ? 12000 : density === 'essential' ? 1500 : 4000)
        : drawableGuides.length;
    // D085-S5 END
    for (const [index, guide] of drawableGuides.entries()) {
      // D085-S5 BEGIN: root Figure A guides always survive density and motion LOD.
      const selected = budget >= drawableGuides.length
        || Math.floor((index + 1) * budget / drawableGuides.length) > Math.floor(index * budget / drawableGuides.length);
      if (!selected && !guide.id.startsWith('indra-root:')) { suppressed++; continue; }
      // D085-S4 BEGIN: zero active source IDs means no bundle is drawn. The
      // full-snapshot guide remains a geometry/provenance template only.
      if (guide.kind === 'lull-pair-bundle' && activeLullPairs
        && !activeWeights.has(lullGuideBundleLetters(guide.id))) {
        suppressed++; continue;
      }
      // D085-S4 END
      // D085-S5 END
      // D085-S5 END
      // D085-S5 BEGIN: every requested guide must be either drawn or suppressed.
      if (guide.points.length < 2) { suppressed++; continue; }
      // D085-S5 END
      // D084-LLULL BEGIN: distinguish the outer rim and the radial hub without
      // changing the appearance of guides belonging to any other topology.
      if (guide.kind === 'lull-figure-a' || guide.kind === 'lull-letter') {
        context.strokeStyle = 'rgba(205,215,230,.50)';
        context.lineWidth = 1;
      } else if (guide.kind === 'lull-hub' || guide.kind === 'lull-hub-spoke') {
        context.strokeStyle = 'rgba(205,215,230,.34)';
        context.lineWidth = 0.85;
      } else if (guide.kind === 'lull-band' || guide.kind === 'lull-sector-ray') {
        context.strokeStyle = 'rgba(180,190,210,.19)';
        context.lineWidth = 0.65;
      // D085-S4 BEGIN: the Third Figure's 36 pair compartments are dashed
      // chords. The dash pattern is the primary distinguishability channel against the
      // solid real relations; width and alpha sit between the faint band marks and the
      // rim so the hierarchy stays guides < real relations < roots. The dash is reset
      // after every stroke below, so no other guide inherits it.
      } else if (guide.kind === 'lull-pair-chord') {
        context.strokeStyle = 'rgba(205,215,230,.42)';
        context.lineWidth = 1.25;
        context.setLineDash([7, 6]);
      } else if (guide.kind === 'lull-riser') {
        // D085-S4 BEGIN: the lifted view's letter risers — the faintest marks,
        // under the chords, so the four tables stay anchored to Figure A without
        // competing with the relation ink.
        context.strokeStyle = 'rgba(205,215,230,.26)';
        context.lineWidth = 0.8;
        // D085-S4 END
      // D085-S4 BEGIN: a pair bundle — the aggregate that replaces one
      // compartment's individual strokes while the camera is in the overview band.
      // Width and opacity follow the square root of the active folded weight's
      // share of the heaviest bundle. Once the route releases the individuals,
      // the bundle share is zero. The stroke is solid and much thicker
      // than any relation line, so the rosette of the overview reads as its own ink.
      } else if (guide.kind === 'lull-pair-bundle') {
        const weight = activeLullPairs
          ? activeWeights.get(lullGuideBundleLetters(guide.id))!
          : (guide as LullWeightedGuide).weight;
        const share = bundleMax > 0 ? Math.sqrt(weight / bundleMax) : 0;
        // Two aggregate inks, one per view. Flat: a solid core chord, wider and
        // brighter for heavier compartments — the rosette of the overview. Lifted:
        // the same weight as a soft translucent halo along the table chord, in the
        // halo language the exploratory relations already use; a solid core seen
        // from an orbit angle would cross the four heights as one flat star and
        // hide the tables the aggregates belong to.
        if (flatView) {
          context.strokeStyle = `rgba(196,212,236,${((0.38 + 0.42 * share) * overview).toFixed(3)})`;
          context.lineWidth = 1.75 + 5.25 * share;
        } else {
          context.strokeStyle = `rgba(196,212,236,${((0.12 + 0.22 * share) * overview).toFixed(3)})`;
          context.lineWidth = 4 + 10 * share;
        }
      // D085-S4 END
      } else {
        context.strokeStyle = 'rgba(180,190,210,.22)';
        context.lineWidth = 0.75;
      }
      // D084-LLULL END
      context.beginPath();
      let started = false;
      let segments = 0;
      for (const point of guide.points) {
        const projected = view.projectPoint!(point);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) { started = false; continue; }
        if (!started) { context.moveTo(projected.x, projected.y); started = true; }
        else { context.lineTo(projected.x, projected.y); segments++; }
      }
      // D084-LLULL BEGIN: stroke the hub circle and spokes without a fill;
      // guides must leave the real chord ink beneath them visible.
      if (segments) { context.stroke(); drawn++; }
      else suppressed++;
      // D084-LLULL END
      // D085-S4 BEGIN: reset the dash after each guide so only the pair
      // chords are dashed.
      context.setLineDash([]);
      // D085-S4 END
    }
    // D085-S5 BEGIN
    canvas.dataset.guideDrawn = String(drawn);
    canvas.dataset.guideSuppressed = String(suppressed);
    // D085-S5 END
  };
  const schedule = (motion = false) => {
    if (destroyed) return;
    if (motion) interacting = true;
    if (!frame) frame = requestAnimationFrame(draw);
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { settleTimer = null; interacting = false;
      if (!frame) frame = requestAnimationFrame(draw); }, 450);
  };
  const abort = new AbortController();
  // D085-S5 BEGIN: hovering alone is not a camera interaction.
  for (const event of ['wheel','touchmove'])
    host.addEventListener(event, () => schedule(true), { passive: true, signal: abort.signal });
  host.addEventListener('pointermove', event => schedule((event as PointerEvent).buttons !== 0),
    { passive: true, signal: abort.signal });
  host.addEventListener('pointerup', () => schedule(), { passive: true, signal: abort.signal });
  // D085-S5 END
  // Toolbar camera actions occur outside the host; repaint after their short animation settles.
  window.addEventListener('click', () => schedule(), { passive: true, signal: abort.signal });
  window.addEventListener('keydown', () => schedule(), { passive: true, signal: abort.signal });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  resize?.observe(host);
  schedule();
  return { invalidate() { if (!destroyed && !frame) frame = requestAnimationFrame(draw); },
    destroy() { destroyed = true; abort.abort(); resize?.disconnect(); if (frame) cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer); canvas.remove(); } };
  // D085-S4 END
}
