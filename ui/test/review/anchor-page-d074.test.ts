import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { CreateProductView, ProductView } from '../../src/review/view-contract.ts';

const source = new URL('../../src/review/v2-page.ts', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d074-anchor-page.mjs');
mkdirSync(dirname(output), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(source)), sourcefile: 'd074-anchor-page-entry.ts', loader: 'ts',
    contents: `export { V2Page } from ${JSON.stringify(fileURLToPath(source))};` } });
writeFileSync(output, bundle.outputFiles[0]!.text);

const fakeElement = () => ({
  children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
  textContent: '', hidden: false, className: '', title: '', disabled: false, onclick: null,
  append(...items: unknown[]) { this.children.push(...items); },
  prepend(...items: unknown[]) { this.children.unshift(...items); },
  replaceChildren(...items: unknown[]) { this.children = items; },
  remove() {}, addEventListener() {}, setAttribute() {}, toggleAttribute() {},
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
});
const elements = new Map<string, ReturnType<typeof fakeElement>>();
for (const id of ['render-root', 'status', 'error', 'details', 'counter', 'focus-chip', 'back',
  'v2-undo', 'v2-redo', 'v2-cap', 'expand', 'projection-focus', 'fullscreen-focus'])
  elements.set(id, fakeElement());
Object.assign(globalThis, {
  location: { search: '', hash: '' },
  WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 },
  document: { getElementById: (id: string) => elements.get(id) ?? null,
    createElement: fakeElement, createElementNS: fakeElement, createTextNode: (text: string) => ({ text }), body: fakeElement() },
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, setTimeout },
});
const { V2Page } = await import(pathToFileURL(output).href) as typeof import('../../src/review/v2-page.ts');

const node = (id: string, level: 1 | 2 | 3, parent: string | null): V2Node => ({
  id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation',
  parent, parents: parent ? [parent] : [], domains: [], title: id, display_label: id, title_full: id,
  importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const index: V2Index = { nodes: [
  node('domain:a', 1, null), node('domain:b', 1, null),
  node('project:a:1', 2, 'domain:a'), node('project:a:2', 2, 'domain:a'),
  node('project:b:1', 2, 'domain:b'), node('project:b:2', 2, 'domain:b'),
  ...Array.from({ length: 6 }, (_, i) => node(`conversation:a:${i}`, 3, 'project:a:1')),
], edges: [] };
const manifest: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd074-anchor', counts: {}, limits: {} };
const palette = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#fff', hover: '#fff', container: '#ebebeb', text: '#e8e8e8' };
const appearance = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;

test('an Indra disclosure refresh calls the one-shot camera anchor once at the old pointer pixel', async () => {
  const mounts: { positions: ReadonlyMap<string, { x: number; y: number; z: number }> }[] = [];
  const kept: { id: string; point: { x: number; y: number } }[] = [];
  const createView: CreateProductView = async input => {
    const positions = input.v2Prepared!.indraAnchors;
    mounts.push({ positions });
    const screen = (id: string) => { const p = positions.get(id)!; return { x: id === 'domain:a' ? 400 + (mounts.length > 1 ? 25 : 0) : 100 + p.x,
      y: id === 'domain:a' ? 300 : 100 + p.y, radius: 12 }; };
    return {
      readCamera: () => ({ x: 0.5, y: 0.5, ratio: 1 }), restoreCamera() {},
      keepNodeAt(id: string, point: { x: number; y: number }) { kept.push({ id, point }); return true; },
      witness: () => ({ axes: input.axes, cameraKind: 'orthographic', visibleRect: { left: 0, top: 0, width: 800, height: 600 },
        nodeViewport: Object.fromEntries([...positions.keys()].map(id => [id, screen(id)])),
        positions: Object.fromEntries(positions), selected: null, emphasised: [], windows: [], labels: [],
        depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: 'v2-layout', palette: 'bw' }),
      destroy() {}, async fit() {}, async frame() {}, async resetCamera() {}, select() {}, setEmphasis() {},
      setInsets() {}, setFlowMotion() {}, async setAxes() {}, async setVisible() {}, async setAppearance() {},
      async setPalette() {}, viewPreset() {}, camera: () => null,
    } as unknown as ProductView;
  };
  const page = new V2Page(manifest, index, { projection: '2d', morphology: 'stellar', organization: 'indra',
    colour: 'bw', labels: true, reading: 'attested' }, appearance, palette, {}, 'balanced', { createView });
  await page.refresh();
  const first = mounts[0]!.positions.get('domain:a')!;
  (page as unknown as { cursor: { x: number; y: number } }).cursor = { x: 400, y: 300 };
  page.history.expand('project:a:1');
  await page.refresh();
  assert.equal(mounts.length, 2);
  assert.notDeepEqual(mounts[1]!.positions.get('domain:a'), first, 'the reveal repacks the domain');
  assert.deepEqual(kept, [{ id: 'domain:a', point: { x: 400, y: 300, radius: 12 } }]);
});

for (const moved of [true, false]) {
  test(`a Natural 3D disclosure ${moved ? 'restores' : 'does not compensate an unchanged'} anchor`, async () => {
    const kept: { id: string; point: { x: number; y: number } }[] = [];
    let mount = 0;
    let anchorOffset = 0;
    const createView: CreateProductView = async () => {
      const thisMount = ++mount;
      const screen = (id: string) => ({
        x: (id === 'domain:a' ? 400 + (thisMount > 1 ? anchorOffset : 0) : 100),
        y: id === 'domain:a' ? 300 : 100,
        radius: 12,
      });
      return {
        readCamera: () => ({ x: 0.5, y: 0.5, ratio: 1 }), restoreCamera() {},
        keepNodeAt(id: string, point: { x: number; y: number }) {
          kept.push({ id, point });
          anchorOffset = 0;
          return true;
        },
        witness: () => ({ axes: { projection: '3d', organization: 'natural' }, cameraKind: 'perspective',
          visibleRect: { left: 0, top: 0, width: 800, height: 600 },
          nodeViewport: Object.fromEntries(index.nodes.map(item => [item.id, screen(item.id)])),
          positions: {}, selected: null, emphasised: [], windows: [], labels: [],
          depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: 'v2-layout', palette: 'bw' }),
        destroy() {}, async fit() {}, async frame() {}, async resetCamera() {}, select() {}, setEmphasis() {},
        setInsets() {}, setFlowMotion() {}, async setAxes() {}, async setVisible() {}, async setAppearance() {},
        async setPalette() {}, viewPreset() {}, camera: () => null,
      } as unknown as ProductView;
    };
    const page = new V2Page(manifest, index, { projection: '3d', morphology: 'stellar', organization: 'natural',
      colour: 'bw', labels: true, reading: 'attested' }, appearance, palette, {}, 'balanced', { createView });
    await page.refresh();
    (page as unknown as { cursor: { x: number; y: number } }).cursor = { x: 400, y: 300 };
    page.history.expand('project:a:1');
    anchorOffset = moved ? 24 : 0;
    await page.refresh();
    assert.equal(mount, 2, 'the disclosure mounts the updated Natural 3D view');
    if (moved) {
      assert.deepEqual(kept, [{ id: 'domain:a', point: { x: 400, y: 300, radius: 12 } }]);
      assert.deepEqual({ x: 400 + anchorOffset, y: 300 }, { x: 400, y: 300 }, 'keepNodeAt restores the old screen point');
    } else assert.deepEqual(kept, []);
  });
}
