import assert from 'node:assert/strict';
import test from 'node:test';
import { alignNaturalDensity, animateNaturalDensity, composeNaturalDensityCamera, naturalDensityDisplacement,
  placeNaturalDensity, type DensityCamera } from '../src/review/natural-density-transition.ts';

// D086-NAT BEGIN
test('camera composition preserves old view-plane target and 3D dolly over fresh bounds', () => {
  const old = { x: 0.6, y: 0.4, ratio: 1.5, angle: 0,
    bounds: { x: [-10, 10] as const, y: [-5, 5] as const }, targetZ: 8,
    closeSizeAnchor: { x: 2, y: 3, z: 4 } };
  const fresh = { ...old, bounds: { x: [-100, 100] as const, y: [-50, 50] as const } };
  const result = composeNaturalDensityCamera<DensityCamera>(old, fresh,
    { x: 4, y: -2, z: 6, scale: 2, shared: 3 }, '3d');
  assert.ok(result);
  assert.deepEqual(result.bounds, fresh.bounds);
  assert.equal(result.x, 0.495);
  assert.equal(result.y, 0.5);
  assert.equal(result.ratio, 0.075);
  assert.equal(result.targetZ, 1);
  assert.equal(result.closeSizeAnchor, undefined);
});

for (const dimension of ['2d', '3d'] as const) test(`${dimension} uses a positive uniform fit over shared IDs`, () => {
  const canonical = new Map([
    ['a', { x: 0, y: 0, z: 0 }], ['b', { x: 2, y: 0, z: 1 }],
    ['c', { x: 0, y: 2, z: 2 }], ['new', { x: 5, y: 6, z: 3 }],
  ]);
  const prior = new Map([...canonical].filter(([id]) => id !== 'new').map(([id, point]) =>
    [id, { x: 3 * point.x + 7, y: 3 * point.y - 4,
      z: dimension === '3d' ? 3 * point.z + 9 : 0 }] as const));
  const alignment = alignNaturalDensity(prior, canonical, dimension);
  assert.equal(alignment.shared, 3);
  assert.ok(Math.abs(alignment.scale - 3) < 1e-12);
  const placed = placeNaturalDensity(canonical, alignment);
  for (const [id, point] of prior) {
    const actual = placed.get(id)!;
    assert.ok(Math.hypot(actual.x - point.x, actual.y - point.y,
      dimension === '3d' ? actual.z - point.z : 0) < 1e-12);
  }
  assert.equal(placed.size, canonical.size);
  assert.deepEqual(alignNaturalDensity(new Map([...prior].slice(0, 2)), canonical, dimension),
    { scale: 0, x: 0, y: 0, z: 0, shared: 2 });
});

// D086-NAT BEGIN: canonical layouts can have full spread and little covariance.
for (const dimension of ['2d', '3d'] as const) test(`${dimension} composes RMS extent across a nearly orthogonal layout`, () => {
  const target = new Map([['a', { x: -1, y: -1, z: -1 }], ['b', { x: 1, y: -1, z: 1 }],
    ['c', { x: -1, y: 1, z: 1 }], ['d', { x: 1, y: 1, z: -1 }]]);
  const prior = new Map([...target].map(([id, point]) => [id,
    { x: -point.y + point.x * 0.01, y: point.x + point.y * 0.01,
      z: dimension === '3d' ? point.z : 0 }] as const));
  const alignment = alignNaturalDensity(prior, target, dimension);
  assert.ok(alignment.scale > 0.99 && alignment.scale < 1.01, `scale ${alignment.scale}`);
  const camera = { x: 0.5, y: 0.5, ratio: 1,
    bounds: { x: [-10, 10] as const, y: [-10, 10] as const } };
  const composed = composeNaturalDensityCamera(camera, camera, alignment, dimension);
  assert.ok(composed && composed.ratio > 0.99 && composed.ratio < 1.01);
});

test('degenerate shared clouds ask the caller for a fresh fit', () => {
  const camera = { x: 0.5, y: 0.5, ratio: 1,
    bounds: { x: [-10, 10] as const, y: [-10, 10] as const } };
  const target = new Map([['a', { x: 1, y: 1, z: 1 }], ['b', { x: 1, y: 1, z: 1 }],
    ['c', { x: 1, y: 1, z: 1 }]]);
  const prior = new Map([['a', { x: 0, y: 0, z: 0 }], ['b', { x: 2, y: 0, z: 0 }],
    ['c', { x: 0, y: 2, z: 0 }]]);
  const alignment = alignNaturalDensity(prior, target, '2d');
  assert.equal(alignment.scale, 0);
  assert.equal(composeNaturalDensityCamera(camera, camera, alignment, '2d'), null);
});

test('identical canonical shared coordinates keep the composed camera unchanged', () => {
  const points = new Map([['a', { x: -3, y: -2, z: 1 }], ['b', { x: 4, y: -1, z: 2 }],
    ['c', { x: 0, y: 5, z: -3 }]]);
  const alignment = alignNaturalDensity(points, points, '3d');
  assert.deepEqual(alignment, { scale: 1, x: 0, y: 0, z: 0, shared: 3 });
  const camera = { x: 0.57, y: 0.42, ratio: 1.7, targetZ: 3,
    bounds: { x: [-10, 10] as const, y: [-10, 10] as const } };
  assert.deepEqual(composeNaturalDensityCamera(camera, camera, alignment, '3d'), camera);
});

test('3D measures visible spread after the camera orbit, excluding view-depth only spread', () => {
  const target = new Map([-1, 0, 1].map((value, index) =>
    [String(index), { x: value, y: 0, z: value }] as const));
  const prior = new Map([-1, 0, 1].map((value, index) =>
    [String(index), { x: value, y: 0, z: -value }] as const));
  const camera = { angle: 0, orbit: [0, 0, 0, 1] as const };
  assert.equal(alignNaturalDensity(prior, target, '3d', camera).scale, 0);
  const turned = { angle: 0, orbit: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const };
  assert.equal(alignNaturalDensity(prior, target, '3d', turned).scale, 0);
});
// D086-NAT END

test('an opposing cloud never reflects the target', () => {
  const target = new Map([['a', { x: 0, y: 0, z: 0 }], ['b', { x: 1, y: 0, z: 0 }],
    ['c', { x: 0, y: 1, z: 0 }]]);
  const prior = new Map([...target].map(([id, point]) => [id, { x: -point.x, y: -point.y, z: 0 }] as const));
  assert.equal(alignNaturalDensity(prior, target, '2d').scale, 1,
    'an opposing cloud retains its extent instead of collapsing to machine epsilon');
  assert.equal(alignNaturalDensity(prior, target, '3d').scale, 1);
});

test('transition witness measures only persisting marks in screen pixels', () => {
  assert.deepEqual(naturalDensityDisplacement({ a: { x: 0, y: 0 }, b: { x: 1, y: 0 },
    gone: { x: 0, y: 0 } }, { a: { x: 3, y: 4 }, b: { x: 1, y: 10 },
    new: { x: 2, y: 2 } }), { shared: 2, added: 1, removed: 1, medianPx: 7.5, p95Px: 9.75 });
});

test('a superseded animation releases its host even when frames pause', async () => {
  const original = { document: globalThis.document, window: globalThis.window,
    frame: globalThis.requestAnimationFrame };
  let removed = false;
  const canvas = { style: {} as Record<string, string>, width: 0, height: 0,
    getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
      set fillStyle(_value: string) {}, set globalAlpha(_value: number) {} }),
    remove() { removed = true; } };
  const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    append() {} } as unknown as HTMLElement;
  const host = { style: { opacity: '1' } } as unknown as HTMLElement;
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  globalThis.window = { devicePixelRatio: 1 } as Window & typeof globalThis;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  try {
    const controller = new AbortController();
    const motion = animateNaturalDensity(root, host, { a: { x: 0, y: 0 } },
      { a: { x: 10, y: 10 } }, () => true, false, controller.signal);
    controller.abort();
    await motion;
    assert.equal(host.style.opacity, '1');
    assert.equal(removed, true);
  } finally {
    globalThis.document = original.document;
    globalThis.window = original.window;
    globalThis.requestAnimationFrame = original.frame;
  }
});
test('the mounted scene stays hidden until moving glyphs reach the final endpoints', async () => {
  const original = { document: globalThis.document, window: globalThis.window,
    frame: globalThis.requestAnimationFrame };
  let frame: FrameRequestCallback = () => { throw new Error('animation frame was not scheduled'); };
  let removed = false;
  const canvas = { style: {} as Record<string, string>, width: 0, height: 0,
    getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
      set fillStyle(_value: string) {}, set globalAlpha(_value: number) {} }),
    remove() { removed = true; } };
  const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    append() {} } as unknown as HTMLElement;
  const host = { style: { opacity: '1' } } as unknown as HTMLElement;
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  globalThis.window = { devicePixelRatio: 1 } as Window & typeof globalThis;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frame = callback; return 1;
  }) as typeof requestAnimationFrame;
  try {
    const motion = animateNaturalDensity(root, host, { a: { x: 0, y: 0 } },
      { a: { x: 10, y: 10 } }, () => true, false);
    assert.equal(host.style.opacity, '0');
    const begun = performance.now();
    frame(begun + 225);
    assert.equal(host.style.opacity, '0', 'real relations stay hidden while glyphs move');
    frame(begun + 500);
    await motion;
    assert.equal(host.style.opacity, '1');
    assert.equal(removed, true);
  } finally {
    globalThis.document = original.document;
    globalThis.window = original.window;
    globalThis.requestAnimationFrame = original.frame;
  }
});
// D086-NAT BEGIN: delayed, broken and absent frames must all settle visibly.
for (const mode of ['early', 'throwing', 'absent'] as const) test(`${mode} frame settles the density overlay`, async () => {
  const original = { document: globalThis.document, window: globalThis.window,
    frame: globalThis.requestAnimationFrame };
  let frame: FrameRequestCallback = () => { throw new Error('animation frame was not scheduled'); };
  let removed = false;
  let throwDraw = false;
  const context = { setTransform() {}, clearRect() {}, beginPath() {},
    arc() { if (throwDraw) throw new Error('draw failed'); }, fill() {},
    set fillStyle(_value: string) {}, set globalAlpha(_value: number) {} };
  const canvas = { style: {} as Record<string, string>, width: 0, height: 0,
    getContext: () => context, remove() { removed = true; } };
  const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    append() {} } as unknown as HTMLElement;
  const host = { style: { opacity: '1' } } as unknown as HTMLElement;
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  globalThis.window = { devicePixelRatio: 1 } as Window & typeof globalThis;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    if (mode !== 'absent') frame = callback;
    return 1;
  }) as typeof requestAnimationFrame;
  try {
    const after = Object.fromEntries(Array.from({ length: 120 }, (_, index) =>
      [`added-${index}`, { x: index + 1, y: index + 1 }]));
    const motion = animateNaturalDensity(root, host, { shared: { x: 0, y: 0 } },
      { ...after, shared: { x: 1, y: 1 } }, () => true, false);
    if (mode === 'early') {
      frame(performance.now() - 600);
      assert.equal(host.style.opacity, '0');
      frame(performance.now() + 500);
    } else if (mode === 'throwing') {
      throwDraw = true;
      frame(performance.now() + 100);
    }
    await motion;
    assert.equal(host.style.opacity, '1');
    assert.equal(removed, true);
  } finally {
    globalThis.document = original.document;
    globalThis.window = original.window;
    globalThis.requestAnimationFrame = original.frame;
  }
});
// D086-NAT END
// D086-NAT END
