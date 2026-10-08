import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeometryTransitionQueue } from '../../src/review/geometry-view2.ts';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D085-S1 BEGIN: a later click must read the axes left by the preceding committed view.
test('rapid topology, dimension and density requests commit in click order', async () => {
  const queue = createGeometryTransitionQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let drawn = 'natural';
  let selected = 'natural';
  let dimension = '2d';
  let density = 'balanced';

  const first = queue.enqueue(async () => {
    events.push('start:julia');
    await firstGate;
    drawn = selected = 'julia';
    events.push('commit:julia');
  });
  const second = queue.enqueue(async () => {
    assert.equal(drawn, 'julia');
    dimension = '3d';
    events.push('commit:3d');
  });
  const third = queue.enqueue(async () => {
    assert.equal(dimension, '3d');
    density = 'complete';
    events.push('commit:complete');
  });
  const fourth = queue.enqueue(async () => {
    assert.equal(density, 'complete');
    drawn = selected = 'sierpinski';
    events.push('commit:sierpinski');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['start:julia']);
  releaseFirst();
  await Promise.all([first, second, third, fourth]);
  assert.deepEqual(events, ['start:julia', 'commit:julia', 'commit:3d', 'commit:complete', 'commit:sierpinski']);
  assert.equal(selected, drawn);
});

test('a refused transition reports its error and does not discard the next click', async () => {
  const queue = createGeometryTransitionQueue();
  const refused = queue.enqueue(async () => { throw new Error('unsupported projection'); });
  const next = queue.enqueue(async () => 'canopy-ifs');
  await assert.rejects(refused, /unsupported projection/);
  assert.equal(await next, 'canopy-ifs');
});

test('page taxonomy setters do not overwrite an in-flight topology', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false });
  const directory = await mkdtemp(join(tmpdir(), 'd085-switch-'));
  const source = join(directory, 'page.mjs');
  await writeFile(source, bundled.outputFiles[0]!.text);
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 1 } });
  const { V2Page, topologySceneSignature } = await import(pathToFileURL(source).href);
  await rm(directory, { recursive: true, force: true });
  assert.notEqual(topologySceneSignature('julia', false), topologySceneSignature('sierpinski', false));
  assert.notEqual(topologySceneSignature('julia', false), topologySceneSignature('julia', true));
  const page = Object.create(V2Page.prototype) as Record<string, any>;
  page.axes = { projection: '2d' };
  page.topology = 'natural';
  page.topologyIndra = false;
  page.legacyIndra = false;
  page.taxonomyExplicit = false;
  page.transitions = createGeometryTransitionQueue();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const apply = async () => {
    started.push(page.topology);
    if (started.length === 1) await gate;
  };
  page.applyAxes = apply;
  page.setAxes = apply;
  const first = page.setTaxonomy('julia', false);
  const second = page.setTaxonomy('sierpinski', false);
  await Promise.resolve();
  assert.deepEqual(started, ['julia']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['julia', 'sierpinski']);
  assert.equal(page.topology, 'sierpinski');

  page.view = {};
  page.committedTaxonomy = { topology: 'sierpinski', indra: false };
  const refused = page.setTaxonomy('julia', false);
  await assert.rejects(refused, /non è stata montata/);
  assert.equal(page.topology, 'sierpinski');
  assert.equal(page.axes.projection, '2d');
  page.applyAxes = async () => { page.committedTaxonomy = { topology: page.topology, indra: page.topologyIndra }; };
  await page.setTaxonomy('julia', false);
  assert.equal(page.topology, 'julia');
});
// D085-S1 END
