/** D-086 F3: the V2 side-panel Llull legend follows the active palette through preset and custom switches. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { CreateProductView, ProductView } from '../../src/review/view-contract.ts';

const source = new URL('../../src/review/v2-page.ts', import.meta.url);
const output = join(dirname(fileURLToPath(source)), '../../dist/evidence/d086-llull-legend-page.mjs');
await mkdir(dirname(output), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(source)), sourcefile: 'd086-llull-legend-entry.ts', loader: 'ts',
    contents: `export { V2Page } from ${JSON.stringify(fileURLToPath(source))};` } });
await writeFile(output, bundle.outputFiles[0]!.text);

const fakeElement = (tag = 'div') => ({
  tagName: tag, attrs: {} as Record<string, string>,
  children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
  textContent: '', hidden: false, className: '', title: '', disabled: false, onclick: null,
  append(...items: unknown[]) { this.children.push(...items); }, prepend(...items: unknown[]) { this.children.unshift(...items); },
  replaceChildren(...items: unknown[]) { this.children = items; }, remove() {}, addEventListener() {},
  setAttribute(name: string, value: string) { this.attrs[name] = value; }, removeAttribute() {}, toggleAttribute() {}, getContext() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
});
const elements = new Map<string, ReturnType<typeof fakeElement>>();
for (const id of ['render-root', 'status', 'error', 'details', 'counter', 'focus-chip', 'back',
  'v2-undo', 'v2-redo', 'v2-cap', 'expand', 'projection-focus', 'fullscreen-focus']) elements.set(id, fakeElement());
Object.assign(globalThis, {
  location: { search: '', hash: '' },
  WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 },
  document: { getElementById: (id: string) => elements.get(id) ?? null, createElement: fakeElement,
    createElementNS: (_ns: string, tag: string) => fakeElement(tag), createTextNode: (text: string) => ({ text }), body: fakeElement() },
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, dispatchEvent() {}, setTimeout },
});
Object.assign(elements.get('details')!, { ownerDocument: globalThis.document });
const { V2Page } = await import(pathToFileURL(output).href) as typeof import('../../src/review/v2-page.ts');

const roots = Array.from({ length: 9 }, (_, index) => `domain:${String.fromCharCode(97 + index)}`);
const nodes: V2Node[] = roots.flatMap((root, index) => [
  { id: root, level: 1, kind: 'domain', parent: null, parents: [], domains: [], title: root,
    display_label: root, title_full: root, importance: { value: 1 - index / 20, components: {} },
    size: 0.5, counts: { children: 2, descendants: 2, canon: 0, passages: 0 } },
  ...Array.from({ length: 2 }, (_, child) => ({ id: `${root}:${child}`, level: 2 as const,
    kind: 'project', parent: root, parents: [root], domains: [], title: `${root}:${child}`,
    display_label: `${root}:${child}`, title_full: `${root}:${child}`,
    importance: { value: 0.5, components: {} }, size: 0.5,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 } })),
]);
const edges: V2Index['edges'] = [];
for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
  const mention = (i + j) % 2 === 0;
  edges.push({ id: `${mention ? 'mention' : 'relation'}:${i}:${j}`, source: roots[i]!, target: roots[j]!,
    class: 'attested', type: mention ? 'mentions' : 'relates', directed: false, evidence: [] });
}
const index: V2Index = { nodes, edges };
const manifest: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd086-llull-legend', counts: {}, limits: {} };
// The stored custom palette: saturated blue, so a panel legend that wrongly uses it is unmistakable.
const custom = { background: '#000000', aggregate: '#3366ff', concept: '#3366ff', attested: '#3366ff',
  exploratory: '#3366ff', selection: '#ffffff', hover: '#ffffff', container: '#3366ff', text: '#ffffff' };
const createView: CreateProductView = async input => ({
  readCamera: () => null, restoreCamera() {}, async fit() {}, updateVisibleSubset: () => true,
  witness: () => ({ axes: input.axes, cameraKind: 'orthographic',
    visibleRect: { left: 0, top: 0, width: 800, height: 600 }, nodeViewport: {}, positions: {},
    selected: null, emphasised: [], windows: [], labels: [], depth: { zMin: 0, zMax: 0, zStd: 0 },
    anchorsSource: 'v2-layout', palette: 'bw' }),
  destroy() {}, async frame() {}, async resetCamera() {}, select() {},
  setEmphasis() {}, setInsets() {}, setFlowMotion() {}, async setAxes() {}, async setVisible() {},
  async setAppearance() {}, async setPalette() {}, viewPreset() {}, camera: () => null,
}) as unknown as ProductView;


type Node = { tagName?: string; attrs?: Record<string, string>; children?: Node[]; textContent?: string };
const text = (node: Node): string => (node.textContent ?? '') + (node.children ?? []).map(text).join('');
const strokes = (node: Node): string[] => [...(node.attrs?.stroke ? [node.attrs.stroke] : []),
  ...(node.children ?? []).flatMap(strokes)];
/** The Llull legend samples currently in the side panel: guide sample and the two bundle strokes. */
const swatches = (): string[] => {
  const found: string[] = [];
  const visit = (node: Node) => {
    if (/^(Guida Figura A|Fascio d’insieme)/.test(text(node)) && node.tagName === 'p') found.push(...strokes(node));
    else for (const child of node.children ?? []) visit(child);
  };
  visit(elements.get('details') as unknown as Node);
  return found;
};
const spread = (style: string) => { const [red, green, blue] = style.match(/\d+/g)!.slice(0, 3).map(Number) as [number, number, number];
  return Math.max(red, green, blue) - Math.min(red, green, blue); };

test('the side-panel Llull legend follows the preset after a remount, not the stored custom palette', async () => {
  const page = new V2Page(manifest, index, { organization: 'natural', projection: '2d', morphology: 'stellar',
    colour: 'bw', labels: true, reading: 'attested' },
  { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never, custom, {}, 'balanced',
  { taxonomy: { topology: 'lull', indra: false }, createView });
  await page.refresh();
  const axes = () => (page as unknown as { axes: Parameters<typeof page.setAxes>[0] }).axes;
  assert.equal(swatches().length, 3, 'the Llull guide and bundle samples are in the panel');
  for (const style of swatches()) assert.equal(spread(style), 0, `Monocromatico panel swatch is grey: ${style}`);
  await page.setAxes({ ...axes(), colour: 'amber' });
  const amber = swatches();
  assert.equal(amber.length, 3);
  for (const style of amber) assert.ok(/^rgba\((\d+),(\d+),(\d+)/.test(style) && spread(style) > 60 && !/^rgba\(\d+,\d+,255/.test(style),
    `amber panel swatch is the amber tint, not the custom blue: ${style}`);
  await page.setAxes({ ...axes(), colour: 'bw' });
  for (const style of swatches()) assert.equal(spread(style), 0, `back to a grey panel swatch: ${style}`);
  await page.setPalette(custom);
  await page.setAxes({ ...axes(), colour: 'custom' });
  for (const style of swatches()) assert.ok(/^rgba\(\d+,\d+,255/.test(style), `the custom blue shows when it is the active palette: ${style}`);
});
