// D086-F2 BEGIN: a rejected native subset still permits a truthful overlay motion pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCanopyRailLayer } from '../src/fractal/renderer-adapter.ts';
import type { CanopyLayout } from '../src/fractal/canopy-layout.ts';
import type { CanopyMark } from '../src/fractal/canopy-reveal.ts';
import type { ProductView } from '../src/review/view-contract.ts';

test('a declined dense native subset still uses a truthful structural motion pass', () => {
  const originals = {
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    PointerEvent: globalThis.PointerEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const listeners = new Map<string, (event: Event) => void>();
  const host = {
    append() {}, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener); },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as HTMLElement;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, createElement(tag: string) {
    return { style: {}, dataset: {}, textContent: '', getContext: tag === 'canvas' ? () => ({}) : undefined,
      remove() {} };
  } } as unknown as Document;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.PointerEvent = class extends Event {} as unknown as typeof PointerEvent;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  const ids = new Set(Array.from({ length: 1001 }, (_, index) => `node:${index}`));
  const layout = { lineageIds: new Set<string>(), rails: [],
    positions: new Map([...ids].map(id => [id, { id, level: 4, address: '0' }])) } as unknown as CanopyLayout;
  const marks = [...ids].map(id => ({ id, aggregate: false })) as unknown as CanopyMark[];
  let nativeCalls = 0;
  const view = { projectPoint: () => ({ x: 0, y: 0 }),
    updateVisibleSubset() { nativeCalls++; return false; } } as unknown as ProductView;
  let layer: ReturnType<typeof mountCanopyRailLayer> | undefined;
  try {
    layer = mountCanopyRailLayer(host, layout, view, ids, 'attested', '3d', 'neural',
      null, 30000, { top: 0, right: 0, bottom: 0, left: 0 }, marks);
    assert.equal(layer.stats().overlayMotion, false);
    listeners.get('d080-fractal-camera-motion')!(new Event('d080-fractal-camera-motion'));
    assert.equal(nativeCalls, 1);
    assert.equal(layer.stats().overlayMotion, true);
    assert.equal(layer.stats().motionNodes, null, 'native nodes remain fully drawn');
  } finally {
    layer?.destroy();
    globalThis.document = originals.document;
    globalThis.ResizeObserver = originals.ResizeObserver;
    globalThis.PointerEvent = originals.PointerEvent;
    globalThis.requestAnimationFrame = originals.requestAnimationFrame;
    globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
  }
});
// D086-F2 END
