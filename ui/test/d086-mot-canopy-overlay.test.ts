// D086-MOT BEGIN
import test from 'node:test';
import assert from 'node:assert/strict';
import { canopyMotionDrawOrder, mountCanopyRailLayer } from '../src/fractal/renderer-adapter.ts';
import type { CanopyLayout } from '../src/fractal/canopy-layout.ts';
import type { CanopyMark } from '../src/fractal/canopy-reveal.ts';
import type { ProductView } from '../src/review/view-contract.ts';

const point = (x: number, y: number) => ({ x, y, z: 0 });
const rail = (address: string) => ({ address, from: point(0, 0), to: point(1, 1),
  from3d: point(0, 0), to3d: point(1, 1), count: 1,
  relationLoad: { structural: 0, attested: 0, exploratory: 0 } });

test('motion order contains only selected ID prefixes, preserving ancestors under its cap', () => {
  const rails = ['root', '0', '00', '000', '01', '1', '10', '11'].map(rail);
  const layout = { rails, positions: new Map([
    ['first', { id: 'first', address: '000', level: 4 }],
    ['second', { id: 'second', address: '11', level: 4 }],
  ]) } as unknown as CanopyLayout;
  assert.deepEqual(canopyMotionDrawOrder(layout, new Set(['first'])).map(row => row.address),
    ['root', '0', '00', '000']);
  assert.deepEqual(canopyMotionDrawOrder(layout, new Set(['first', 'second']), 'second', 4)
    .map(row => row.address), ['root', '0', '1', '11']);
});

for (const morphology of ['stellar', 'mycelium'] as const) test(`${morphology} motion canvas is bounded and restores full ink after Escape without drag hover scans`, () => {
  const originals = { document: globalThis.document, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, PointerEvent: globalThis.PointerEvent,
    Path2D: globalThis.Path2D, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const listeners = new Map<string, (event: Event) => void>();
  const documentListeners = new Map<string, (event: Event) => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let pathCreations = 0;
  const calls: string[] = [];
  const context = new Proxy({ measureText: (value: string) => ({ width: value.length * 6 }) }, {
    get(target, key) { return key in target ? target[key as keyof typeof target]
      : (..._args: unknown[]) => { calls.push(String(key)); }; },
    set(target, key, value) { (target as Record<PropertyKey, unknown>)[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  let backingWrites = 0;
  const canvas = { width: 0, height: 0, style: {}, dataset: {}, getContext: () => context, remove() {} };
  for (const dimension of ['width', 'height'] as const) {
    let value = 0;
    Object.defineProperty(canvas, dimension, { get: () => value,
      set(next: number) { backingWrites++; value = next; } });
  }
  const host = { clientWidth: 1200, clientHeight: 800, isConnected: true,
    append() {}, setAttribute() {}, removeAttribute() {}, hasAttribute() { return true; },
    contains() { return true; }, querySelector() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener); },
    removeEventListener(type: string) { listeners.delete(type); },
    dispatchEvent() { return true; },
  } as unknown as HTMLElement;
  const ids = new Set(Array.from({ length: 1001 }, (_, index) => `node:${index}`));
  const positions = new Map([...ids].map((id, index) => [id, { id, address: '0',
    level: index === 0 ? 1 : 4, label: id, point: point(0.5, 0.5), point3d: point(0.5, 0.5),
    relationLoad: { structural: 0, attested: 0, exploratory: 0 } }]));
  const layout = { positions, rails: [rail('root'), rail('0')], lineageIds: new Set(['node:0']),
    railLoad: new Map([['0', { structural: 0, attested: 0, exploratory: 0 }]]) } as unknown as CanopyLayout;
  const marks = [...ids].map(id => ({ id, aggregate: false })) as unknown as CanopyMark[];
  let projections = 0;
  const view = { projectPoint(p: { x: number; y: number }) { projections++;
    return { x: 300 + p.x * 100, y: 300 + p.y * 100 }; },
    updateVisibleSubset() { return false; } } as unknown as ProductView;
  const flush = () => { const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(performance.now()); };
  let layer: ReturnType<typeof mountCanopyRailLayer> | undefined;
  try {
    globalThis.document = { createElement: (tag: string) => tag === 'canvas' ? canvas
      : { style: {}, dataset: {}, textContent: '', remove() {} },
    getElementById: () => null,
    addEventListener(type: string, listener: (event: Event) => void) { documentListeners.set(type, listener); },
    removeEventListener(type: string) { documentListeners.delete(type); } } as unknown as Document;
    globalThis.window = { devicePixelRatio: 2 } as unknown as Window & typeof globalThis;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    globalThis.PointerEvent = class extends Event { buttons = 1; clientX = 350; clientY = 350; } as unknown as typeof PointerEvent;
    globalThis.Path2D = class { constructor() { pathCreations++; } moveTo() {} lineTo() {} } as unknown as typeof Path2D;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id); }) as typeof cancelAnimationFrame;
    const evidence = Array.from({ length: 301 }, (_, index) => ({ id: `edge:${index}`,
      source: 'node:0', target: 'node:1', class: 'attested' as const, count: 1 }));
    layer = mountCanopyRailLayer(host, layout, view, ids, 'attested', '3d', morphology, null,
      30000, { top: 0, right: 0, bottom: 0, left: 0 }, marks, true, undefined, evidence);
    flush();
    assert.equal(canvas.width, 2400);
    assert.equal(layer.stats().paintedFull, true);
    assert.equal(layer.stats().evidenceDrawn, 301);
    const fullPaths = pathCreations;
    const fullLineCount = calls.filter(value => value === 'lineTo').length;
    const fullStrokeCount = calls.filter(value => value === 'stroke').length;
    listeners.get('d080-fractal-camera-motion')!(new Event('d080-fractal-camera-motion'));
    calls.length = 0;
    flush();
    assert.equal(canvas.width, 1200);
    assert.equal(layer.stats().overlayMotion, true);
    assert.equal(layer.stats().paintedFull, false);
    assert.equal(layer.stats().evidenceDrawn, 300);
    assert.equal(pathCreations, fullPaths + 3, 'motion evidence is batched by class');
    assert.ok(layer.stats().drawn <= 1);
    assert.ok(calls.filter(value => value === 'lineTo').length < fullLineCount,
      'motion junction and rail omit full outlines');
    if (morphology === 'mycelium') assert.ok(calls.filter(value => value === 'stroke').length < fullStrokeCount,
      'motion mycelium uses one rail stroke');
    const count = layer.stats().labels;
    const writesAtMotion = backingWrites;
    listeners.get('d080-fractal-camera-motion')!(new Event('d080-fractal-camera-motion'));
    flush();
    assert.equal(layer.stats().labels, count);
    assert.equal(backingWrites, writesAtMotion, 'camera frames do not resize the backing store');
    const projectedBeforeHover = projections;
    listeners.get('pointermove')!(new PointerEvent('pointermove'));
    assert.equal(projections, projectedBeforeHover);
    listeners.get('keydown')!(Object.assign(new Event('keydown'), { key: 'Escape' }));
    assert.equal(layer.stats().paintedFull, false, 'full status waits for the draw');
    flush();
    assert.equal(canvas.width, 2400);
    assert.equal(layer.stats().overlayMotion, false);
    assert.equal(layer.stats().paintedFull, true);
    assert.ok(calls.includes('arc'));
    listeners.get('d080-fractal-camera-motion')!(new Event('d080-fractal-camera-motion'));
    flush();
    assert.equal(layer.stats().overlayMotion, true);
    documentListeners.get('pointerup')!(new Event('pointerup'));
    assert.equal(layer.stats().paintedFull, false);
    flush();
    assert.equal(layer.stats().paintedFull, true, 'outside release restores full ink');
  } finally {
    layer?.destroy();
    Object.assign(globalThis, originals);
  }
});
// D086-MOT END
