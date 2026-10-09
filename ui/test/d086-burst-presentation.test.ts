// D086-BURST BEGIN
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { V2Page as Page } from '../src/review/v2-page.ts';

test('Natural density refresh retires the old hover and presents fresh-mount emphasis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd086-burst-presentation-'));
  try {
    const bundled = await build({ entryPoints: [new URL('../src/review/v2-page.ts', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
    const output = join(directory, 'page.mjs');
    await writeFile(output, bundled.outputFiles[0]!.text);
    Object.assign(globalThis, { WebGL2RenderingContext: { FLOAT: 1 },
      WebGLRenderingContext: { TRIANGLES: 1 } });
    const { V2Page } = await import(pathToFileURL(output).href) as { V2Page: typeof Page };
    type FakePage = Page & Record<string, unknown>;
    const presentations: (ReadonlySet<string> | null)[] = [];
    const page = Object.create(V2Page.prototype) as FakePage;
    Object.assign(page, {
      topology: 'natural', topologyIndra: false, density: 'balanced', relationDetail: 'all',
      axes: { organization: 'natural', projection: '2d', morphology: 'mycelium', colour: 'warm', reading: 'combined' },
      appearance: {}, palette: {}, v2Colours: {}, lastRefreshSettingKey: 'previous-density',
      geometryTransitionActive: false, hovered: 'hub', hoveredEdge: null, selected: null,
      renderedRelations: new Map([['edge', { source: 'hub', target: 'inner' }]]), containers: [],
      view: { setFocusStyle() {}, setEmphasis(ids: ReadonlySet<string> | null) { presentations.push(ids); } },
      sourceIndex: () => ({ nodes: [{ id: 'hub', parent: null }, { id: 'inner', parent: null },
        { id: 'leaf', parent: null }] }),
      visible: () => ({ nodes: [{ id: 'hub', parent: null }, { id: 'inner', parent: null },
        { id: 'leaf', parent: null }] }),
      canopyActive: () => false,
      typedActive: () => false,
      d081Emit: () => { throw new Error('stop after settings boundary'); },
    });
    (page as unknown as { updateEmphasis(): void }).updateEmphasis();
    assert.deepEqual([...presentations.at(-1)!], ['hub', 'inner']);
    assert.throws(() => page.refresh(), /stop after settings boundary/);
    assert.equal((page as unknown as { hovered: string | null }).hovered, null);
    assert.equal((page as unknown as { hoveredEdge: string | null }).hoveredEdge, null);
    (page as unknown as { updateEmphasis(): void }).updateEmphasis();
    const fresh = Object.create(V2Page.prototype) as FakePage;
    Object.assign(fresh, page, { hovered: null, hoveredEdge: null,
      view: { setFocusStyle() {}, setEmphasis(ids: ReadonlySet<string> | null) { presentations.push(ids); } } });
    (fresh as unknown as { updateEmphasis(): void }).updateEmphasis();
    assert.equal(presentations.at(-2), null);
    assert.deepEqual(presentations.at(-2), presentations.at(-1));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
// D086-BURST END
