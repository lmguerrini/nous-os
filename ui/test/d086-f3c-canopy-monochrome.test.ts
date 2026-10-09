// D086-F3 BEGIN: exercise the real mounted Canopy canvas and live palette getter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCanopyLayout } from '../src/fractal/canopy-layout.ts';
import { mountCanopyRailLayer, type CanopyEvidenceStroke } from '../src/fractal/renderer-adapter.ts';
import { PALETTES, type PaletteValues } from '../src/review/palette.ts';
import type { ProductView } from '../src/review/view-contract.ts';
import { mountTopologyGuides } from '../src/topology/guide-layer.ts';
import type { GuideCurve } from '../src/topology/contract.ts';

type Paint = { action: 'stroke' | 'fill' | 'text'; ink: string };
const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*(\d*\.?\d+)\)$/;
const oldLuma = (channels: readonly number[]) =>
  channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
const ink = (value: string) => {
  const match = rgba.exec(value);
  assert.ok(match, `expected rgba ink: ${value}`);
  return { channels: match.slice(1, 4).map(Number), alpha: Number(match[4]) };
};

function mount() {
  const originals = { document: globalThis.document, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const paints: Paint[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const context = {
    strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: 'butt', globalAlpha: 1,
    setTransform() {}, clearRect() { paints.length = 0; }, save() {}, restore() {},
    beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {},
    closePath() {}, arc() {}, setLineDash() {}, fillRect() {},
    measureText(text: string) { return { width: text.length * 7 }; },
    stroke() { paints.push({ action: 'stroke', ink: this.strokeStyle }); },
    fill() { paints.push({ action: 'fill', ink: this.fillStyle }); },
    fillText() { paints.push({ action: 'text', ink: this.fillStyle }); },
  };
  const canvas = { dataset: {} as Record<string, string>, style: {}, width: 0, height: 0,
    getContext: () => context, remove() {} };
  const element = () => ({ style: {}, dataset: {}, textContent: '', remove() {} });
  const host = { clientWidth: 1000, clientHeight: 800, isConnected: true,
    append() {}, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }; } };
  Object.assign(globalThis, {
    // D086-MOT BEGIN: the mounted layer also watches outside-canvas release.
    document: { createElement: (tag: string) => tag === 'canvas' ? canvas : element(),
      getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    // D086-MOT END
    window: { devicePixelRatio: 1 },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++frameId; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); },
  });
  const nodes = [
    { id: 'a', parent: null, level: 1, title: 'Alpha' },
    { id: 'b', parent: null, level: 1, title: 'Beta' },
    { id: 'c', parent: null, level: 1, title: 'Gamma' },
    { id: 'conversation', parent: 'a', level: 3, title: 'Conversation' },
    { id: 'leaf', parent: 'conversation', level: 4, title: 'Leaf' },
  ];
  const base = computeCanopyLayout(nodes);
  const railLoad = new Map(base.railLoad);
  const exploratoryAddress = base.positions.get('b')!.address;
  railLoad.set(exploratoryAddress, { structural: 0, attested: 0, exploratory: 1 });
  const layout = { ...base, railLoad };
  const view = { projectPoint: (point: { x: number; y: number }) =>
    ({ x: 500 + point.x * 0.4, y: 400 + point.y * 0.4 }) } as unknown as ProductView;
  const evidence: CanopyEvidenceStroke[] = [
    { id: 'structure', source: 'a', target: 'c', class: 'structural', count: 1 },
    { id: 'att', source: 'a', target: 'b', class: 'attested', count: 1 },
    { id: 'exp', source: 'b', target: 'c', class: 'exploratory', count: 1 },
  ];
  let palette: PaletteValues = PALETTES.amber;
  const layer = mountCanopyRailLayer(host as unknown as HTMLElement, layout, view,
    new Set(nodes.map(row => row.id)), 'combined', '2d', 'stellar', 'a', 100,
    { top: 0, right: 0, bottom: 0, left: 0 },
    [{ id: 'leaf', memberCount: 3, memberIds: ['leaf'], aggregate: true }], true,
    undefined, evidence, undefined, undefined, undefined, () => palette);
  const flush = () => { const pending = [...callbacks]; callbacks.clear();
    for (const [, callback] of pending) callback(0); };
  flush();
  return { layer, paints, setPalette(value: PaletteValues) { palette = value; layer.invalidate(); flush(); },
    restore() { layer.destroy(); Object.assign(globalThis, originals); } };
}

test('mounted Canopy paints every graph ink neutral in bw and tinted in amber, without remounting', () => {
  const scene = mount();
  const roles: Readonly<Record<number, readonly number[]>> = {
    0.11: [220, 226, 236], 0.34: [199, 205, 214], 0.45: [165, 159, 185],
    0.63: [199, 205, 214], 0.67: [199, 205, 214], 0.88: [199, 205, 214],
    0.92: [235, 180, 96], 1: [215, 219, 226],
  };
  try {
    assert.equal(scene.layer.stats().paletteValid, true);
    const amber = scene.paints.filter(row => rgba.test(row.ink));
    assert.ok(amber.length > 0);
    for (const alphaText of Object.keys(roles))
      assert.ok(amber.some(row => ink(row.ink).alpha === Number(alphaText)),
        `amber draws ink at approved alpha ${alphaText}`);
    for (const row of amber) {
      const value = ink(row.ink);
      if (!(value.alpha in roles)) continue;
      assert.ok(value.channels[0]! > value.channels[2]!, `amber tints ${row.action}: ${row.ink}`);
      if (value.alpha !== 0.92) assert.ok(oldLuma(value.channels) <= oldLuma(roles[value.alpha]!) + 1e-9);
    }
    assert.equal(new Set(amber.filter(row => row.action === 'stroke' && ink(row.ink).alpha === 0.34)
      .map(row => row.ink)).size, 2,
    'structural and attested evidence use distinct aggregate and attested tokens');
    scene.setPalette(PALETTES.bw);
    assert.equal(scene.layer.stats().paletteValid, true);
    const neutral = scene.paints.filter(row => rgba.test(row.ink));
    for (const [alphaText, former] of Object.entries(roles)) {
      const alpha = Number(alphaText);
      const rows = neutral.filter(row => ink(row.ink).alpha === alpha);
      assert.ok(rows.length > 0, `the mounted layer draws ink at approved alpha ${alpha}`);
      for (const row of rows) {
        const value = ink(row.ink);
        assert.equal(value.channels[0], value.channels[1], row.ink);
        assert.equal(value.channels[1], value.channels[2], row.ink);
        if (alpha !== 0.92) assert.ok(oldLuma(value.channels) <= oldLuma(former) + 1e-9,
          `${row.ink} exceeds former luma`);
      }
    }
    assert.deepEqual([...new Set(neutral.filter(row => ink(row.ink).alpha === 0.67)
      .map(row => ink(row.ink).channels[0]!))].sort((a, b) => a - b), [162, 204],
    'exploratory rails and aggregate label strokes retain their separate luma levels');
  } finally { scene.restore(); }
});

test('the mounted non-Llull guide kinds follow the active palette at alpha .22', () => {
  const originals = { document: globalThis.document, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const strokes: string[] = [];
  const context = { strokeStyle: '', lineWidth: 0, setTransform() {}, clearRect() { strokes.length = 0; },
    beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {},
    stroke() { strokes.push(this.strokeStyle); } };
  const canvas = { dataset: {} as Record<string, string>, style: {}, width: 0, height: 0,
    getContext: () => context, remove() {} };
  Object.assign(globalThis, {
    document: { createElement: () => canvas, querySelector: () => null },
    window: { devicePixelRatio: 1, setTimeout() { return 0; }, clearTimeout() {}, addEventListener() {} },
    ResizeObserver: undefined,
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  const host = { clientWidth: 1000, clientHeight: 800, append() {}, addEventListener() {},
    removeEventListener() {} };
  const view = { projectPoint: (point: { x: number; y: number }) => point } as unknown as ProductView;
  const kinds = ['julia-grid', 'sierpinski-triangle', 'indra-root-guide'];
  const guides: GuideCurve[] = kinds.map((kind, index) => ({ id: `guide:${kind}`, kind,
    semantic: false, points: [{ x: index, y: 0, z: 0 }, { x: index + 1, y: 1, z: 0 }] }));
  let palette: PaletteValues = PALETTES.amber;
  const layer = mountTopologyGuides(host as unknown as HTMLElement, view, guides,
    undefined, undefined, () => palette);
  const flush = () => { const pending = [...frames]; frames.clear(); for (const [, frame] of pending) frame(0); };
  try {
    flush();
    assert.equal(strokes.length, kinds.length);
    for (const stroke of strokes) {
      const value = ink(stroke);
      assert.equal(value.alpha, 0.22);
      assert.ok(value.channels[0]! > value.channels[2]!, stroke);
      assert.ok(oldLuma(value.channels) <= oldLuma([180, 190, 210]) + 1e-9);
    }
    palette = PALETTES.bw; layer.invalidate(); flush();
    assert.equal(strokes.length, kinds.length);
    for (const stroke of strokes) {
      const value = ink(stroke);
      assert.equal(value.alpha, 0.22);
      assert.deepEqual(value.channels, [189, 189, 189]);
    }
  } finally { layer.destroy(); Object.assign(globalThis, originals); }
});
// D086-F3 END
