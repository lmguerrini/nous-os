import assert from 'node:assert/strict';
import test from 'node:test';
import { mountTopologyGuides } from '../src/topology/guide-layer.ts';
import type { GuideCurve } from '../src/topology/contract.ts';
import type { ProductView } from '../src/review/view-contract.ts';

// D085-S5 BEGIN: exercise the mounted canvas accounting and rest/motion policy.
test('standalone guides restore fully at rest; composed guides keep budgets and exact accounting', () => {
  const originals = { document: globalThis.document, window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver };
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let nextId = 0;
  const listeners = new Map<string, () => void>();
  // D085-S4 BEGIN: the merged Llull pair guides reset the Canvas dash after each stroke.
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash(_dash: number[]) {},
    strokeStyle: '', lineWidth: 0 };
  // D085-S4 END
  const canvas = () => ({ dataset: {} as Record<string, string>, style: {}, width: 0, height: 0,
    getContext: () => context, remove() {} });
  let mountedCanvas: ReturnType<typeof canvas> | null = null;
  const currentCanvas = (): ReturnType<typeof canvas> => mountedCanvas as ReturnType<typeof canvas>;
  const host = { clientWidth: 1200, clientHeight: 800,
    append(value: ReturnType<typeof canvas>) { mountedCanvas = value; },
    addEventListener(event: string, callback: () => void) { listeners.set(event, callback); } };
  const browserWindow = { devicePixelRatio: 1,
    setTimeout(callback: () => void) { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener() {} };
  Object.assign(globalThis, {
    document: { createElement: canvas, querySelector: () => ({ dataset: { density: 'balanced' } }) },
    window: browserWindow,
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    ResizeObserver: undefined,
  });
  const flushFrame = () => {
    const pending = [...frames]; frames.clear();
    for (const [, callback] of pending) callback(0);
  };
  const settle = () => {
    const pending = [...timers]; timers.clear();
    for (const [, callback] of pending) callback();
    flushFrame();
  };
  const point = { x: 1, y: 2, z: 0 };
  const valid = (id: string): GuideCurve => ({ id, kind: 'canopy-rail', semantic: false,
    points: [point, { ...point, x: 3 }] });
  const view = { projectPoint: (p: typeof point) => p } as unknown as ProductView;
  try {
    const standalone = [...Array.from({ length: 4001 }, (_, i) => valid(`lab:${i}`)),
      { ...valid('lab:short'), points: [point] }];
    let layer = mountTopologyGuides(host as unknown as HTMLElement, view, standalone);
    flushFrame();
    assert.equal(currentCanvas().dataset.guideRequested, '4002');
    assert.equal(currentCanvas().dataset.guideDrawn, '4001');
    assert.equal(currentCanvas().dataset.guideSuppressed, '1');
    listeners.get('wheel')!(); flushFrame();
    assert.equal(currentCanvas().dataset.guideDrawn, '449');
    settle();
    assert.equal(currentCanvas().dataset.guideDrawn, '4001');
    layer.destroy();

    const composed = [...Array.from({ length: 4001 }, (_, i) => valid(`indra:parent:${i}`)),
      { ...valid('indra:parent:short'), points: [point] },
      { ...valid('indra-route:real'), kind: 'indra-real-edge-route' }];
    // D086-F4 BEGIN: the fitted radius passed by the page reaches the canvas.
    layer = mountTopologyGuides(host as unknown as HTMLElement, view, composed, undefined, 137);
    assert.equal(currentCanvas().dataset.lullRootRadius, '137');
    // D086-F4 END
    flushFrame();
    assert.equal(currentCanvas().dataset.guideRequested, '4003');
    assert.equal(currentCanvas().dataset.guideDrawn, '3999');
    assert.equal(currentCanvas().dataset.guideSuppressed, '4');
    assert.equal(Number(currentCanvas().dataset.guideDrawn) + Number(currentCanvas().dataset.guideSuppressed),
      Number(currentCanvas().dataset.guideRequested));
    layer.destroy();
  } finally {
    Object.assign(globalThis, originals);
  }
});
// D085-S5 END
