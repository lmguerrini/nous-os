// D086-BURST BEGIN
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { V2Page as Page } from '../src/review/v2-page.ts';
import type * as Readiness from '../src/render-common/render-readiness-producer.ts';

const directory = await mkdtemp(join(tmpdir(), 'd086-burst4-'));
const pagePath = fileURLToPath(new URL('../src/review/v2-page.ts', import.meta.url));
const readinessPath = fileURLToPath(new URL('../src/render-common/render-readiness-producer.ts', import.meta.url));
const bundle = await build({ stdin: { contents: `export { V2Page } from ${JSON.stringify(pagePath)};\nexport * from ${JSON.stringify(readinessPath)};`,
  resolveDir: directory, sourcefile: 'burst4-entry.ts' }, bundle: true, platform: 'node', format: 'esm',
  target: 'es2022', write: false });
const output = join(directory, 'page.mjs');
await writeFile(output, bundle.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { FLOAT: 1 },
  WebGLRenderingContext: { TRIANGLES: 1 } });
const module = await import(pathToFileURL(output).href) as typeof Readiness & { V2Page: typeof Page };
await rm(directory, { recursive: true, force: true });

const frame = (view: string, edges: number) => ({
  view, quality: 'completa' as const, ladder: 4 as const,
  nodes: { required: 400, loaded: 400, drawn: 400 },
  mainEdges: { required: edges, loaded: edges, drawn: edges },
  allEdges: { required: edges, loaded: edges, drawn: edges },
  decor: { labels: true, background: true, glow: true, animation: true },
});

for (const topology of ['lull', 'natural'] as const) {
  test(`${topology} 3D no-commit burst restores the resident renderer frame`, async () => {
    const host = {} as Element;
    const axes = { organization: 'natural', projection: '3d', morphology: 'stellar', reading: 'attested' };
    const view = `${topology === 'natural' ? 'natural' : 'lab/lull'}/3d/stellar/balanced/attested`;
    const page = Object.create(module.V2Page.prototype) as Page & Record<string, any>;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const seen: string[] = [];
    Object.assign(page, {
      transitions: { tail: Promise.resolve() as Promise<unknown>, enqueue(task: () => Promise<unknown>) {
        const result = this.tail.then(task); this.tail = result.catch(() => {}); return result;
      } },
      geometryIntent: 0, projectionEpoch: 0, cancelProjectionWork() {},
      topology, topologyIndra: false, committedTaxonomy: { topology, indra: false },
      axes, committedAxes: axes, density: 'balanced', committedDensity: 'balanced',
      densitySwitchPending: false, d081Quality: 'completa',
      d081Metrics: { nodes: { visible: 400 }, edges: { drawn: 3935 } },
      view: {}, viewHost: host, typedActive: () => false,
      d081Emit() { module.reportPreparationReadiness({ ...frame(view, 3935), quality: 'recupero' }, host); },
      async applyDensity(value: string) {
        if (value === 'complete') {
          this.density = value;
          this.d081Quality = 'recupero';
          this.d081Emit();
          entered();
          await gate;
        } else if (value === 'essential') {
          this.density = 'essential';
          this.committedDensity = 'essential';
          const next = view.replace('/balanced/', '/essential/');
          module.presentRenderReadiness(frame(next, 1000), host);
        }
      },
    });
    const detach = module.installRenderReadinessSink(value => seen.push(`${value.view}:${value.origin}:${value.quality}`));
    try {
      module.activateRenderReadinessHost(host);
      module.presentRenderReadiness(frame(view, 3935), host);
      const complete = page.setDensity('complete');
      await started;
      const essential = page.setDensity('essential');
      const balanced = page.setDensity('balanced');
      release();
      assert.deepEqual(await Promise.all([complete, essential, balanced]), ['superseded', 'superseded', undefined]);
      assert.equal((page as Record<string, any>).density, 'balanced');
      assert.equal(seen.at(-1), `${view}:renderer:completa`);
      assert.equal(await page.setDensity('essential'), undefined);
      assert.equal(seen.at(-1), `${view.replace('/balanced/', '/essential/')}:renderer:completa`);
    } finally { detach(); }
  });
}

test('a missing committed certificate requests a presentation from the live view', async () => {
  const axes = { organization: 'natural', projection: '3d', morphology: 'stellar', reading: 'attested' };
  const page = Object.create(module.V2Page.prototype) as Page & Record<string, any>;
  let requested = 0;
  Object.assign(page, { axes, committedAxes: axes, density: 'balanced', committedDensity: 'balanced',
    topology: 'natural', topologyIndra: false, committedTaxonomy: { topology: 'natural', indra: false },
    geometryIntent: 3, view: {}, viewHost: {} as Element, typedActive: () => false,
    transitions: { enqueue: async (task: () => Promise<unknown>) => task() },
    refresh: async () => { requested++; } });
  (page as Record<string, any>).replayRestoredRenderer();
  await Promise.resolve();
  assert.equal(requested, 1);
});
// D086-BURST END
