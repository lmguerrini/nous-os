/** D-086 F3: every Llull guide, bundle and legend swatch takes its ink from the active
 * palette, with the approved brightness and opacity. Monochrome has no chroma. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as guideLayer from '../src/topology/guide-layer.ts';
import { PALETTES } from '../src/review/palette.ts';
import type { PaletteValues } from '../src/review/palette.ts';
import { renderFlowLegend } from '../src/review/legend.ts';
import type { GuideCurve } from '../src/topology/contract.ts';
import type { LullOverviewPairFold } from '../src/topology/lull-overview.ts';
import type { ProductView } from '../src/review/view-contract.ts';

type Stroke = { style: string; width: number };
const INK = /^rgba\((\d+),(\d+),(\d+),(\d*\.?\d+)\)$/;
const parse = (style: string) => {
  const match = INK.exec(style);
  assert.ok(match, `a stroke style is a plain rgba ink: ${style}`);
  return { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]), alpha: Number(match[4]) };
};
const spread = (style: string) => { const { red, green, blue } = parse(style);
  return Math.max(red, green, blue) - Math.min(red, green, blue); };

/** The approved Llull ink alphas, one per guide kind (bundle: flat, full overview, heaviest pair). */
const APPROVED_ALPHA: Readonly<Record<string, number>> = {
  'lull-figure-a': 0.5, 'lull-letter': 0.5, 'lull-hub': 0.34, 'lull-hub-spoke': 0.34,
  'lull-band': 0.19, 'lull-sector-ray': 0.19, 'lull-pair-chord': 0.42, 'lull-riser': 0.26,
  'lull-pair-bundle': 0.8,
};
const KINDS = Object.keys(APPROVED_ALPHA);

function mountLayer(activePalette: () => PaletteValues) {
  const originals = { document: globalThis.document, window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver };
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const strokes: Stroke[] = [];
  const context = { setTransform() {}, clearRect() { strokes.length = 0; }, beginPath() {}, moveTo() {}, lineTo() {},
    setLineDash() {}, stroke() { strokes.push({ style: this.strokeStyle, width: this.lineWidth }); },
    strokeStyle: '', lineWidth: 0 };
  const canvas = { dataset: {} as Record<string, string>, style: {}, width: 0, height: 0,
    getContext: () => context, remove() {} };
  const host = { clientWidth: 1000, clientHeight: 1000, append() {}, addEventListener() {} };
  Object.assign(globalThis, {
    document: { createElement: () => canvas, querySelector: () => null },
    window: { devicePixelRatio: 1, setTimeout() { return 0; }, clearTimeout() {}, addEventListener() {} },
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    ResizeObserver: undefined });
  const flush = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(0); };
  const guides: GuideCurve[] = KINDS.map((kind, index) => ({
    id: kind === 'lull-pair-bundle' ? 'lull:bundle:BC' : `lull:guide:${kind}`, kind, semantic: false as const,
    points: [{ x: index, y: 0, z: 0 }, { x: index + 1, y: 1, z: 0 }] }));
  const pairs: readonly LullOverviewPairFold[] = [{ letters: 'BC', roots: ['b', 'c'],
    drawnEdgeIds: ['e1'], relationIds: ['r1', 'r2', 'r3'] }];
  const view = { projectPoint: (point: { x: number; y: number }) => point } as unknown as ProductView;
  const layer = (guideLayer.mountTopologyGuides as (...args: unknown[]) => { destroy(): void; invalidate(): void })(
    host, view, guides, () => pairs, activePalette);
  flush();
  const byKind = () => new Map(KINDS.map((kind, index) => [kind, strokes[index]!]));
  return { layer, flush, strokes, byKind, restore() { layer.destroy(); Object.assign(globalThis, originals); } };
}

test('Monocromatico draws every Llull guide and bundle stroke with R = G = B at the approved alpha', () => {
  const mount = mountLayer(() => PALETTES.bw);
  try {
    assert.equal(mount.strokes.length, KINDS.length, 'one stroke per Llull guide kind');
    for (const [kind, stroke] of mount.byKind()) {
      const ink = parse(stroke.style);
      assert.equal(spread(stroke.style), 0, `${kind}: no chroma in ${stroke.style}`);
      assert.equal(ink.alpha, APPROVED_ALPHA[kind], `${kind}: alpha is the approved one`);
      assert.ok(ink.red <= 214, `${kind}: no brighter than the former ink (${ink.red})`);
    }
  } finally { mount.restore(); }
});

test('a coloured palette tints every Llull stroke from its own tokens at the same alpha', () => {
  const mount = mountLayer(() => PALETTES.amber);
  try {
    for (const [kind, stroke] of mount.byKind()) {
      const ink = parse(stroke.style);
      assert.ok(ink.red > ink.green && ink.green > ink.blue, `${kind}: amber ink is warm: ${stroke.style}`);
      assert.equal(ink.alpha, APPROVED_ALPHA[kind], `${kind}: alpha unchanged by the palette`);
    }
  } finally { mount.restore(); }
});

test('a palette change repaints the same layer without a remount, both ways', () => {
  let palette: PaletteValues = PALETTES.bw;
  const mount = mountLayer(() => palette);
  try {
    assert.equal(spread(mount.byKind().get('lull-figure-a')!.style), 0);
    palette = PALETTES['stellar-cold'];
    mount.layer.invalidate(); mount.flush();
    assert.ok(parse(mount.byKind().get('lull-figure-a')!.style).blue
      > parse(mount.byKind().get('lull-figure-a')!.style).red, 'the cold palette tints blue by its own token');
    palette = PALETTES.bw;
    mount.layer.invalidate(); mount.flush();
    for (const [kind, stroke] of mount.byKind()) assert.equal(spread(stroke.style), 0, `${kind}: back to grey`);
  } finally { mount.restore(); }
});

test('lullInk keeps the luma level, clamps, and falls back to grey for a black token', () => {
  const { lullInk } = guideLayer as unknown as { lullInk(palette: PaletteValues, level: number, alpha: string): string };
  assert.equal(lullInk(PALETTES.bw, 214, '.5'), 'rgba(214,214,214,.5)');
  const warm = parse(lullInk(PALETTES.amber, 189, '.19'));
  const luma = 0.2126 * warm.red + 0.7152 * warm.green + 0.0722 * warm.blue;
  assert.ok(Math.abs(luma - 189) < 2, `luma ${luma} stays at the approved level`);
  assert.equal(lullInk({ ...PALETTES.bw, aggregate: '#000000' }, 189, '.19'), 'rgba(189,189,189,.19)');
  assert.throws(() => lullInk({ ...PALETTES.bw, aggregate: 'blue' }, 189, '.19'), TypeError);
});

class LegendElement {
  tagName: string; className = ''; textContent = ''; title = '';
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; children: LegendElement[] = [];
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  append(...nodes: (LegendElement | string)[]): void {
    for (const node of nodes) { if (typeof node === 'string') this.textContent += node; else this.children.push(node); }
  }
  prepend(node: LegendElement): void { this.children.unshift(node); }
  replaceChildren(): void { this.children = []; this.textContent = ''; }
}
const textOf = (node: LegendElement): string => node.textContent + node.children.map(textOf).join('');
const strokesOf = (node: LegendElement): string[] =>
  [...(node.attrs.stroke ? [node.attrs.stroke] : []), ...node.children.flatMap(strokesOf)];
function llullSwatchInks(palette: PaletteValues): string[] {
  const previous = globalThis.document;
  Object.assign(globalThis, { document: {
    createElement: (tag: string) => new LegendElement(tag), createElementNS: (_ns: string, tag: string) => new LegendElement(tag) } });
  try {
    const host = new LegendElement('div');
    renderFlowLegend(host as unknown as HTMLElement, palette, 'natural', 'lull');
    return host.children.filter(entry => /^(Guida Figura A|Fascio d’insieme)/.test(textOf(entry))).flatMap(strokesOf);
  } finally { Object.assign(globalThis, { document: previous }); }
}

test('the Llull legend swatches follow the palette: grey in Monocromatico, tinted otherwise', () => {
  const grey = llullSwatchInks(PALETTES.bw);
  assert.equal(grey.length, 3, 'the guide sample and the two bundle strokes');
  for (const style of grey) assert.equal(spread(style), 0, `grey swatch ${style}`);
  for (const style of llullSwatchInks(PALETTES.amber)) assert.ok(spread(style) > 20, `amber swatch ${style}`);
});
