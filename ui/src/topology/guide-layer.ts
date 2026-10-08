/** Non-semantic law guides, projected with the active classic camera only when it changes. */
import type { GuideCurve } from './contract.ts';
import type { ProductView } from '../review/view-contract.ts';

export function mountTopologyGuides(host: HTMLElement, view: ProductView,
  guides: readonly GuideCurve[]): { destroy(): void } {
  if (!guides.length || !view.projectPoint) return { destroy() {} };
  if (guides.some(guide => guide.semantic !== false || !guide.id))
    throw new Error('Topology guide must be non-semantic');
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
    context.strokeStyle = 'rgba(180,190,210,.22)';
    context.lineWidth = 0.75;
    // D085-S5 BEGIN: route hints have no eligibility token at this surface; never
    // paint them. Fine guide volume is capped deterministically during interaction.
    let drawn = 0, suppressed = 0;
    // D085-S5 BEGIN
    const density = document.querySelector<HTMLButtonElement>('#density-control button[data-density][aria-pressed="true"]')?.dataset.density ?? 'balanced';
    const budget = interacting ? Math.min(450, guides.length)
      : Math.min(guides.length, density === 'complete' ? 12000 : density === 'essential' ? 1500 : 4000);
    // D085-S5 END
    for (const [index, guide] of guides.entries()) {
      if (guide.kind === 'indra-real-edge-route') { suppressed++; continue; }
      // D085-S5 BEGIN: root Figure A guides always survive density and motion LOD.
      const selected = budget >= guides.length
        || Math.floor((index + 1) * budget / guides.length) > Math.floor(index * budget / guides.length);
      if (!selected && !guide.id.startsWith('indra-root:')) { suppressed++; continue; }
      // D085-S5 END
      // D085-S5 END
      if (guide.points.length < 2) continue;
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
