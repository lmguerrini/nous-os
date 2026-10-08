import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeometryTransitionQueue } from '../../src/review/geometry-view2.ts';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { cancelPendingTopologyLayouts, computeTopologyLayoutAsync } from '../../src/topology/page-bridge.ts';

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

// D085-S1 BEGIN: regression for a worker that never answers until a new geometry intent cancels it.
test('a newer page request cancels an in-flight transition without waiting for its worker', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false });
  const directory = await mkdtemp(join(tmpdir(), 'd085-cancel-'));
  const source = join(directory, 'page.mjs');
  await writeFile(source, bundled.outputFiles[0]!.text);
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 1 } });
  const { V2Page } = await import(pathToFileURL(source).href);
  await rm(directory, { recursive: true, force: true });
  const page = Object.create(V2Page.prototype) as Record<string, any>;
  page.transitions = createGeometryTransitionQueue();
  page.geometryIntent = 0;
  page.projectionEpoch = 0;
  let cancelled = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  page.cancelProjectionWork = () => { if (++cancelled > 1) release(); };
  page.applyAxes = async (axes: { organization: string }) => {
    if (axes.organization === 'indra') await blocked;
    page.axes = axes;
  };
  const first = page.setAxes({ organization: 'indra' });
  await Promise.resolve();
  const second = page.setAxes({ organization: 'natural' });
  await Promise.all([first, second]);
  assert.equal(page.axes.organization, 'natural');
  assert.equal(cancelled, 2);
});

test('superseded topology worker is terminated and its promise rejects', async () => {
  const oldWorker = globalThis.Worker;
  const oldSource = (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__;
  let created = 0, terminated = 0;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    constructor() { created++; }
    postMessage() {}
    terminate() { terminated++; }
  }
  try {
    (globalThis as Record<string, unknown>).Worker = FakeWorker;
    (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__ = 'fake';
    const pending = computeTopologyLayoutAsync('julia', { digest: 'test', nodes: [], edges: [] }, '2d', true);
    cancelPendingTopologyLayouts();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(created, 1);
    assert.equal(terminated, 1);
  } finally {
    cancelPendingTopologyLayouts();
    (globalThis as Record<string, unknown>).Worker = oldWorker;
    (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__ = oldSource;
  }
});

test('a completed topology worker releases its retained law cache when idle', async () => {
  const oldWorker = globalThis.Worker;
  const oldSource = (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__;
  let terminated = 0;
  class ReplyWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    postMessage(message: { requestId: number }) {
      queueMicrotask(() => this.onmessage?.({ data: { kind: 'topology-layout-result',
        requestId: message.requestId, result: { positions: new Map(), witnesses: new Map(), containers: [], guides: [], diagnostics: [] } } }));
    }
    terminate() { terminated++; }
  }
  try {
    (globalThis as Record<string, unknown>).Worker = ReplyWorker;
    (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__ = 'fake';
    await computeTopologyLayoutAsync('julia', { digest: 'test', nodes: [], edges: [] }, '2d', false);
    assert.equal(terminated, 1);
  } finally {
    cancelPendingTopologyLayouts();
    (globalThis as Record<string, unknown>).Worker = oldWorker;
    (globalThis as Record<string, unknown>).__PROJECTION_WORKER_SOURCE__ = oldSource;
  }
});

test('the page law cache and early toolbar focus read have explicit bounds and guards', async () => {
  const pageSource = await readFile(fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url)), 'utf8');
  const mainSource = await readFile(fileURLToPath(new URL('../../src/review/main.ts', import.meta.url)), 'utf8');
  assert.match(pageSource, /lawCache = new PageResultCache<TopologyLayout>\(2, 24 \* 1024 \* 1024\)/);
  assert.match(pageSource, /mounted\?\.destroy\(\)/);
  assert.match(pageSource, /renderer\?\.destroy\(\)/);
  assert.match(mainSource, /const selectedNode = stack\?\.current/);
});
// D085-S1 END

// D085-S1 BEGIN: reproduce Completa pending, topology selection, then Indra ON.
test('a slow Completa mount releases the page lane for the newest Indra request', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false });
  const directory = await mkdtemp(join(tmpdir(), 'd085-indra-lane-'));
  const source = join(directory, 'page.mjs');
  await writeFile(source, bundled.outputFiles[0]!.text);
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 1 } });
  const { V2Page } = await import(pathToFileURL(source).href);
  await rm(directory, { recursive: true, force: true });
  const page = Object.create(V2Page.prototype) as Record<string, any>;
  page.transitions = createGeometryTransitionQueue();
  page.geometryIntent = 0;
  page.projectionEpoch = 0;
  page.axes = { projection: '2d', organization: 'natural' };
  page.topology = 'natural'; page.topologyIndra = false;
  page.committedTaxonomy = { topology: 'natural', indra: false };
  page.legacyIndra = false; page.taxonomyExplicit = false;
  page.view = {};
  page.cancelProjectionWork = () => {};
  let releaseDensity!: () => void;
  const densityGate = new Promise<void>(resolve => { releaseDensity = resolve; });
  let releaseTopology!: () => void;
  const topologyGate = new Promise<void>(resolve => { releaseTopology = resolve; });
  let cancelledMount = false;
  const entered: string[] = [];
  page.applyDensity = async () => { entered.push('complete'); await densityGate; };
  page.applyAxes = async () => {
    entered.push(`${page.topology}/${page.topologyIndra}`);
    if (!page.topologyIndra) {
      page.cancelActiveMount = () => { cancelledMount = true; releaseTopology(); };
      await topologyGate;
    } else page.committedTaxonomy = { topology: page.topology, indra: page.topologyIndra };
  };
  const density = page.setDensity('complete');
  await Promise.resolve();
  const topology = page.setTaxonomy('sierpinski', false);
  releaseDensity();
  await density;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(entered, ['complete', 'sierpinski/false']);
  const indra = page.setTaxonomy('sierpinski', true);
  try {
    assert.equal(cancelledMount, true, 'the newest click releases the slow mount immediately');
    assert.equal(entered.length, 2);
    assert.equal(page.topologyIndra, false);
    assert.equal(page.projectionEpoch > 0, true);
    await Promise.all([topology, indra]);
    assert.equal(entered.includes('sierpinski/true'), true);
    assert.deepEqual(page.committedTaxonomy, { topology: 'sierpinski', indra: true });
  } finally {
    releaseTopology();
    await Promise.allSettled([topology, indra]);
  }
});

test('a superseded provisional taxonomy is restored when no replacement page task starts', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false });
  const directory = await mkdtemp(join(tmpdir(), 'd085-taxonomy-restore-'));
  const source = join(directory, 'page.mjs');
  await writeFile(source, bundled.outputFiles[0]!.text);
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 1 } });
  const { V2Page } = await import(pathToFileURL(source).href);
  await rm(directory, { recursive: true, force: true });
  const page = Object.create(V2Page.prototype) as Record<string, any>;
  page.transitions = createGeometryTransitionQueue(); page.geometryIntent = 0; page.projectionEpoch = 0;
  page.axes = { projection: '2d', organization: 'natural' };
  page.topology = 'natural'; page.topologyIndra = false;
  page.committedTaxonomy = { topology: 'natural', indra: false };
  page.legacyIndra = false; page.taxonomyExplicit = false; page.view = {};
  page.cancelProjectionWork = () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.applyAxes = async () => { await gate; };
  const pending = page.setTaxonomy('sierpinski', true);
  await Promise.resolve();
  page.supersedeGeometry();
  release();
  await pending;
  assert.deepEqual({ topology: page.topology, indra: page.topologyIndra }, page.committedTaxonomy);
});
// D085-S1 END

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
  page.geometryIntent = 0;
  page.projectionEpoch = 0;
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
  await Promise.resolve();
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

  // D085-S1 BEGIN: a protected remount that kept 2D must reject a requested 3D switch.
  page.view = { witness: () => ({ axes: { projection: '2d' } }) };
  page.applyAxes = async () => { page.axes = { projection: '3d' }; };
  delete page.setAxes;
  await assert.rejects(page.setAxes({ projection: '3d' }), /non è stata montata/);
  assert.equal(page.axes.projection, '2d');
  // D085-S1 END
});
// D085-S1 END
