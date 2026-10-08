/** Non-semantic law guides, projected with the active classic camera only when it changes. */
import type { GuideCurve } from './contract.ts';
import type { ProductView } from '../review/view-contract.ts';
import { LULL_OUTER_RADIUS } from './lull.ts';

// D085-S4 BEGIN: the Llull semantic zoom. The pair bundles and the
// overview veil exist only while the Figure A wheel is seen from a distance:
// as the camera closes in they fade to nothing and the individual real chords
// take over. The fade is a pure function of the projected world scale and the
// viewport, so the same camera always draws the same ink.
type LullWeightedGuide = GuideCurve & Readonly<{ weight: number }>;
const LULL_ZOOM_FADE_BEGIN = 1.5;
const LULL_ZOOM_FADE_END = 2.5;
/** Overview share: 1 while the fitted wheel is at or inside the viewport, easing
 * to 0 by LULL_ZOOM_FADE_END times the fitted size. Unprojectable cameras give 0,
 * which leaves only the ever-present guides — never a wrong veil. Exported for
 * the earlier tests: the release curve itself is part of the disclosed law. */
export function lullOverviewFade(view: ProductView, width: number, height: number): number {
  const origin = view.projectPoint!({ x: 0, y: 0, z: 0 });
  const east = view.projectPoint!({ x: 1000, y: 0, z: 0 });
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)
    || !Number.isFinite(east.x) || !Number.isFinite(east.y)) return 0;
  const scale = Math.hypot(east.x - origin.x, east.y - origin.y) / 1000;
  if (!(scale > 0)) return 0;
  const factor = scale * 2 * LULL_OUTER_RADIUS / Math.max(1, Math.min(width, height));
  if (factor <= LULL_ZOOM_FADE_BEGIN) return 1;
  if (factor >= LULL_ZOOM_FADE_END) return 0;
  return (LULL_ZOOM_FADE_END - factor) / (LULL_ZOOM_FADE_END - LULL_ZOOM_FADE_BEGIN);
}
// D085-S4 END

export function mountTopologyGuides(host: HTMLElement, view: ProductView,
  guides: readonly GuideCurve[]): { destroy(): void } {
  if (!guides.length || !view.projectPoint) return { destroy() {} };
  if (guides.some(guide => guide.semantic !== false || !guide.id))
    throw new Error('Topology guide must be non-semantic');
  // D085-S5 BEGIN: source-ID routes stay in the layout contract but cannot
  // compete for a visible chart budget without drawn-edge eligibility tokens.
  const drawableGuides = guides.filter(guide => guide.kind !== 'indra-real-edge-route');
  // D085-S5 END
  const canvas = document.createElement('canvas');
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
  if (!context) { canvas.remove(); return { destroy() {} }; }
  let frame = 0;
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
    // D085-S4 BEGIN: the overview share of the Llull semantic zoom, the
    // heaviest bundle (which sets the width/opacity scale of all of them) and whether
    // this is the flat view — only it carries the veil, so the lifted view styles its
    // bundles lighter and keeps its four tables readable.
    const lullZoom = guides.some(guide => guide.kind === 'lull-overview-veil' || guide.kind === 'lull-pair-bundle');
    const overview = lullZoom ? lullOverviewFade(view, width, height) : 0;
    const flatView = guides.some(guide => guide.kind === 'lull-overview-veil');
    let bundleMax = 0;
    for (const guide of guides)
      if (guide.kind === 'lull-pair-bundle') bundleMax = Math.max(bundleMax, (guide as LullWeightedGuide).weight);
    // D085-S4 END
    context.strokeStyle = 'rgba(180,190,210,.22)';
    context.lineWidth = 0.75;
    // D085-S5 BEGIN: route hints have no eligibility token at this surface; never
    // paint them. Fine guide volume is capped deterministically during interaction.
    let drawn = 0, suppressed = guides.length - drawableGuides.length;
    // D085-S5 BEGIN
    const density = document.querySelector<HTMLButtonElement>('#density-control button[data-density][aria-pressed="true"]')?.dataset.density ?? 'balanced';
    const budget = interacting ? Math.min(450, drawableGuides.length)
      : Math.min(drawableGuides.length, density === 'complete' ? 12000 : density === 'essential' ? 1500 : 4000);
    // D085-S5 END
    for (const [index, guide] of drawableGuides.entries()) {
      // D085-S5 BEGIN: root Figure A guides always survive density and motion LOD.
      const selected = budget >= drawableGuides.length
        || Math.floor((index + 1) * budget / drawableGuides.length) > Math.floor(index * budget / drawableGuides.length);
      if (!selected && !guide.id.startsWith('indra-root:')) { suppressed++; continue; }
      // D085-S5 END
      // D085-S5 END
      if (guide.points.length < 2) continue;
      // D085-S4 BEGIN: the overview veil — the law emits it first, so this
      // translucent fill lands beneath every other mark of the figure and lightens
      // the record band at a distance. It never removes a mark and is skipped
      // entirely once the zoom has passed the fade.
      if (guide.kind === 'lull-overview-veil') {
        if (overview <= 0) continue;
        context.beginPath();
        let veiled = false;
        for (const point of guide.points) {
          const projected = view.projectPoint!(point);
          if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
          if (!veiled) { context.moveTo(projected.x, projected.y); veiled = true; }
          else context.lineTo(projected.x, projected.y);
        }
        if (veiled) {
          context.fillStyle = `rgba(5,7,11,${(0.55 * overview).toFixed(3)})`;
          context.fill();
        }
        continue;
      }
      // D085-S4 END
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
      // D085-S4 BEGIN (fix 2): the Third Figure's 36 pair compartments are dashed
      // chords. The dash pattern is the primary distinguishability channel against the
      // solid real relations; width and alpha sit between the faint band marks and the
      // rim so the hierarchy stays guides < real relations < roots. The dash is reset
      // after every stroke below, so no other guide inherits it.
      } else if (guide.kind === 'lull-pair-chord') {
        context.strokeStyle = 'rgba(205,215,230,.42)';
        context.lineWidth = 1.25;
        context.setLineDash([7, 6]);
      } else if (guide.kind === 'lull-riser') {
        // D085-S4 BEGIN (fix 5): the lifted view's letter risers — the faintest marks,
        // under the chords, so the four tables stay anchored to Figure A without
        // competing with the relation ink.
        context.strokeStyle = 'rgba(205,215,230,.26)';
        context.lineWidth = 0.8;
        // D085-S4 END
      // D085-S4 BEGIN: a pair bundle — the aggregate of one compartment's
      // real relations. Width and opacity follow the square root of the weight's
      // share of the heaviest bundle, scaled by the overview share: at close zoom
      // the share is 0 and the bundle is fully transparent, leaving only the
      // individual real chords. The stroke is solid and much thicker than any
      // relation line, so the rosette of the overview reads as its own ink.
      } else if (guide.kind === 'lull-pair-bundle') {
        const weight = (guide as LullWeightedGuide).weight;
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
      // D085-S4 BEGIN (fix 2): reset the dash after each guide so only the pair
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
  return { destroy() { abort.abort(); resize?.disconnect(); if (frame) cancelAnimationFrame(frame);
    if (settleTimer !== null) window.clearTimeout(settleTimer); canvas.remove(); } };
}
