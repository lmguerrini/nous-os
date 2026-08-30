/**
 * Shared post-render completion barrier for every harness in this directory that mounts a WebGL
 * renderer -- `#render3f/mount.tsx`'s single tagged canvas, or Sigma's `#render2d/index.ts`
 * boundary, which splits its draw calls across several WebGL-backed canvases instead of one.
 * `requestAnimationFrame` fires before the browser has painted, and a rAF count alone never forces
 * the GL command stream itself to complete -- there was nothing in this directory that did.
 * `readPixels` is specified to block until the framebuffer it reads actually holds the result of
 * every GL command issued before it, and `finish()` gives that same guarantee for the whole command
 * stream rather than one pixel; together they are a real completion signal a counted rAF is not.
 */

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** A plain frame settle for waits that never read back rendered pixels, e.g. after teardown. */
export async function settle(): Promise<void> {
  await nextPaint();
  await nextPaint();
  await nextPaint();
}

/**
 * Blocks on the GL context already bound to `canvas` -- the one `THREE.WebGLRenderer` created,
 * fetched back here rather than created fresh, since a canvas's rendering context is fixed at first
 * creation and `getContext("webgl2")` therefore returns THREE's own context -- until every render
 * command issued against it has actually produced pixels.
 */
function glCompletionBarrier(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (gl === null) {
    throw new Error("gpu completion barrier requires a WebGL context on the rendered canvas");
  }
  const pixel = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.finish();
}

/**
 * Replaces a plain `settle()` wherever a harness is about to read back rendered pixels, whether
 * through a screenshot or through state derived from what the renderer put on screen: two rAFs let
 * the mount's own scheduled frames (fiber configure, resize, material updates) run, the GL barrier
 * blocks until the render calls those frames issued have actually completed, and a final rAF gives
 * the compositor a completed frame to paint from.
 */
export async function settleRendered(container: ParentNode): Promise<void> {
  await nextPaint();
  await nextPaint();
  const canvas = container.querySelector<HTMLCanvasElement>('canvas[data-render3f-canvas="true"]');
  if (canvas === null) {
    throw new Error("gpu completion barrier requires a mounted render3f canvas");
  }
  glCompletionBarrier(canvas);
  await nextPaint();
}

/**
 * Blocks on every canvas within `container` that already has its own WebGL context bound, for a
 * mount (Sigma's `#render2d/index.ts` boundary) that splits its draw calls across more than one
 * canvas -- separate WebGL-backed layers for nodes, edges and hover state -- rather than the single
 * render3f-tagged one `glCompletionBarrier` looks for. A canvas with only a 2D context (Sigma's
 * label and mouse layers) returns null from `getContext("webgl2"/"webgl")` and is skipped rather
 * than blocked on, since it queues no GL command stream to flush.
 */
function glCompletionBarrierEveryCanvas(container: ParentNode): void {
  const canvases = container.querySelectorAll<HTMLCanvasElement>("canvas");
  const pixel = new Uint8Array(4);
  let blocked = 0;
  for (const canvas of canvases) {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl === null) {
      continue;
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.finish();
    blocked += 1;
  }
  if (blocked === 0) {
    throw new Error("gpu completion barrier requires at least one WebGL canvas in the container");
  }
}

/**
 * Same shape as `settleRendered`, for a mount that draws through more than one WebGL-backed canvas
 * (Sigma's node/edge/hover programs) instead of the single render3f-tagged one.
 */
export async function settleRenderedCanvases(container: ParentNode): Promise<void> {
  await nextPaint();
  await nextPaint();
  glCompletionBarrierEveryCanvas(container);
  await nextPaint();
}
