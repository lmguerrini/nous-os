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
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '1' });
  host.append(canvas);
  const context = canvas.getContext('2d');
  if (!context) { canvas.remove(); return { destroy() {} }; }
  let frame = 0;
  let settleTimer: number | null = null;
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
    for (const guide of guides) {
      if (guide.points.length < 2) continue;
      context.beginPath();
      let started = false;
      for (const point of guide.points) {
        const projected = view.projectPoint!(point);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) { started = false; continue; }
        if (!started) { context.moveTo(projected.x, projected.y); started = true; }
        else context.lineTo(projected.x, projected.y);
      }
      context.stroke();
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { settleTimer = null; if (!frame) frame = requestAnimationFrame(draw); }, 450);
  };
  const abort = new AbortController();
  for (const event of ['wheel','pointermove','pointerup','touchmove'])
    host.addEventListener(event, schedule, { passive: true, signal: abort.signal });
  // Toolbar camera actions occur outside the host; repaint after their short animation settles.
  window.addEventListener('click', schedule, { passive: true, signal: abort.signal });
  window.addEventListener('keydown', schedule, { passive: true, signal: abort.signal });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(host);
  schedule();
  return { destroy() { abort.abort(); resize?.disconnect(); if (frame) cancelAnimationFrame(frame);
    if (settleTimer !== null) window.clearTimeout(settleTimer); canvas.remove(); } };
}
