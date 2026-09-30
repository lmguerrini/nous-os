import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { ProjectionRegistry } from '../../src/projection/registry.ts';
import { fractalProjection } from '../../src/projection/fractal.ts';
import { indraRequestForLevelToken, indrasPearlsProjection, IndraProjectionRefusal } from '../../src/projection/indra.ts';
import { createProjectionWorkerClient, ProjectionClientError } from '../../src/projection/worker-client.ts';
import type { ProjectionClientRequest, ProjectionWorkerClient } from '../../src/projection/worker-client.ts';
import { ROOT_LEVEL_ID } from '../../src/indra/levels.ts';
import type { PickResult, ProjectionResult, RenderVisibility, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';

/**
 * D-073 D9: Indra's Pearls as the page's `indra` view. The page requests the root (three levels,
 * at most 200 words) through the typed pipeline and the semantic LOD, opens a lazy pearl by the
 * stub's load token on the mounted host (the camera stays), leaves it for its parent level, routes
 * typed picks to the explanation card of the result, and runs the projection through the client
 * (worker or main-thread fallback). The page module is esbuild-bundled once, as the E8 test does.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d9-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'd9-page-entry.ts', loader: 'ts',
    contents: `export { V2Page, indraDisclosureLine, indraLegacyFlagEnabled, projectionExplainsPick, projectionRefusalOf, isLazyLevel } from ${JSON.stringify(fileURLToPath(pageSource))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

type FakeElement = {
  children: FakeElement[]; style: Record<string, string>; dataset: Record<string, string>;
  attrs: Record<string, string>; textContent: string; hidden: boolean; className: string; id: string;
  disabled: boolean; title: string; onclick: null | (() => void); listeners: Map<string, () => void>;
  append(...items: FakeElement[]): void; replaceChildren(...items: FakeElement[]): void;
  prepend(...items: FakeElement[]): void; remove(): void; addEventListener(type: string, listener: () => void): void;
  setAttribute(name: string, value: string): void; toggleAttribute(name: string, force?: boolean): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};
const fakeElement = (): FakeElement => {
  const el: FakeElement = {
    children: [], style: {}, dataset: {}, attrs: {}, textContent: '', hidden: false, className: '', id: '',
    disabled: false, title: '', onclick: null, listeners: new Map(),
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    prepend(...items) { this.children.unshift(...items); },
    remove() {}, addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attrs[name] = value; },
    toggleAttribute(name, force) { if (force) this.attrs[name] = ''; else delete this.attrs[name]; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
  return el;
};
const elements = new Map<string, FakeElement>();
for (const id of ['render-root', 'status', 'error', 'details', 'counter', 'focus-chip', 'back', 'v2-undo', 'v2-redo', 'v2-cap',
  'expand', 'projection-focus', 'fullscreen-focus'])
  elements.set(id, fakeElement());
Object.assign(globalThis, {
  WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 },
  document: {
    getElementById: (id: string) => elements.get(id) ?? null, createElement: fakeElement,
    createElementNS: fakeElement, createTextNode: (text: string) => ({ text }), body: fakeElement(),
  },
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) },
  HTMLInputElement: class HTMLInputElement {}, HTMLTextAreaElement: class HTMLTextAreaElement {},
  innerWidth: 800, innerHeight: 600,
});
const { V2Page: Page, indraDisclosureLine, indraLegacyFlagEnabled, projectionExplainsPick, projectionRefusalOf, isLazyLevel } =
  (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-d9-fixture', counts: {}, limits: {} };
const AXES = { projection: '2d' as const, morphology: 'stellar' as const, organization: 'natural' as const,
  colour: 'bw' as const, labels: true, reading: 'attested' as const };
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#ffffff', hover: '#ffffff', container: '#ebebeb', text: '#e8e8e8' };

const pad = (value: number): string => String(value).padStart(2, '0');
/** Six invented hierarchy roots of distinct sizes (16, 13, 11, 9, 7, 4 members): the ring packing certifies a genus-3 group. */
const COMMUNITIES = [
  { id: 'a', children: 3, leaves: 4 }, { id: 'b', children: 3, leaves: 3 }, { id: 'c', children: 2, leaves: 4 },
  { id: 'd', children: 2, leaves: 3 }, { id: 'e', children: 2, leaves: 2 }, { id: 'f', children: 1, leaves: 2 },
] as const;

function indraIndex(communities: readonly { id: string; children: number; leaves: number }[] = COMMUNITIES): V2Index {
  const nodes: V2Node[] = [];
  const edges: V2Index['edges'] = [];
  let importanceIndex = 0;
  const add = (id: string, level: 1 | 2 | 3, parent: string | null) => {
    const value = ((importanceIndex++ * 37) % 101 + 1) / 102;
    nodes.push({ id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation',
      parent, parents: parent ? [parent] : [], domains: [], title: `Titolo ${id}`, display_label: `Titolo ${id}`,
      title_full: `Titolo ${id}`, importance: { value, components: {} }, size: 1,
      counts: { children: 0, descendants: 0, canon: 0, passages: 0 } });
  };
  const edge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory' = 'attested') =>
    edges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
  for (const spec of communities) {
    const root = `n:${spec.id}`;
    add(root, 1, null);
    for (let child = 1; child <= spec.children; child++) {
      const childId = `${root}:${pad(child)}`;
      add(childId, 2, root);
      edge(`att:${spec.id}:${pad(child)}`, root, childId);
      for (let leaf = 1; leaf <= spec.leaves; leaf++) {
        add(`${childId}:${pad(leaf)}`, 3, childId);
        edge(`att:${spec.id}:${pad(child)}:${pad(leaf)}`, childId, `${childId}:${pad(leaf)}`);
      }
    }
  }
  const ids = new Set(nodes.map(node => node.id));
  const cross = (id: string, source: string, target: string, klass?: 'attested' | 'exploratory') => {
    if (ids.has(source) && ids.has(target)) edge(id, source, target, klass);
  };
  cross('x:ab:1', 'n:a:01:01', 'n:b:01:01');
  cross('x:ab:2', 'n:a:02:02', 'n:b:02');
  cross('x:ab:3', 'n:a:03', 'n:b:03:03', 'exploratory');
  cross('x:bc:1', 'n:b:01', 'n:c:01:01');
  cross('x:cd:1', 'n:c:02:04', 'n:d:01', 'exploratory');
  cross('x:ae:1', 'n:a', 'n:e');
  cross('x:df:1', 'n:d:02:03', 'n:f:01:02');
  cross('x:ef:1', 'n:e:02:01', 'n:f');
  return { nodes, edges };
}

/** The Fractal fixture of the E8 page test: a 39-member giant community and a 15-member path community (54 nodes). */
const G1_LEAVES = 19, G2_LEAVES = 15, B_LEAVES = 14, NODE_COUNT = 54;

/**
 * Two invented communities, as the assembly's own fixture: a 39-member giant whose real children are
 * two groups (20 and 16 members) and two leaves, and a 15-member path community; 54 nodes in all.
 */
function fractalIndex(): V2Index {
  const nodes: V2Node[] = [];
  let importanceIndex = 0;
  const add = (id: string, level: 1 | 2 | 3, parent: string | null) => {
    const value = ((importanceIndex++ * 29) % NODE_COUNT + 1) / (NODE_COUNT + 1);
    nodes.push({ id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation',
      parent, parents: parent ? [parent] : [], domains: [], title: `Titolo ${id}`, display_label: `Titolo ${id}`,
      title_full: `Titolo ${id}`, importance: { value, components: {} }, size: 1,
      counts: { children: 0, descendants: 0, canon: 0, passages: 0 } });
  };
  add('n:a', 1, null);
  add('n:a:g1', 2, 'n:a');
  for (let i = 1; i <= G1_LEAVES; i++) add(`n:a:g1:c${pad(i)}`, 3, 'n:a:g1');
  add('n:a:g2', 2, 'n:a');
  for (let i = 1; i <= G2_LEAVES; i++) add(`n:a:g2:c${pad(i)}`, 3, 'n:a:g2');
  add('n:a:l1', 2, 'n:a');
  add('n:a:l2', 2, 'n:a');
  add('n:b', 1, null);
  for (let i = 1; i <= B_LEAVES; i++) add(`n:b:p${pad(i)}`, 2, 'n:b');
  const edges: V2Index['edges'] = [];
  let ordinal = 0;
  const addEdge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory') =>
    edges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
  const chain = (ids: readonly string[]) => {
    for (let i = 0; i + 1 < ids.length; i++) addEdge(`att:${pad(++ordinal)}`, ids[i]!, ids[i + 1]!, 'attested');
  };
  chain(['n:a:g1', ...Array.from({ length: G1_LEAVES }, (_, i) => `n:a:g1:c${pad(i + 1)}`)]);
  chain(['n:a:g2', ...Array.from({ length: G2_LEAVES }, (_, i) => `n:a:g2:c${pad(i + 1)}`)]);
  chain(['n:b', ...Array.from({ length: B_LEAVES }, (_, i) => `n:b:p${pad(i + 1)}`)]);
  addEdge(`att:${pad(++ordinal)}`, 'n:a', 'n:a:l1', 'attested');
  addEdge(`att:${pad(++ordinal)}`, 'n:a', 'n:a:l2', 'attested');
  addEdge(`att:${pad(++ordinal)}`, 'n:a:l1', 'n:b', 'attested');
  addEdge('exp:01', 'n:a:g1:c01', 'n:a:g2:c01', 'exploratory');
  return { nodes, edges };
}

async function snapshotFor(index: V2Index): Promise<SemanticGraphSnapshot> {
  return createSemanticSnapshot(await normalizeRawLedger({ manifest: MANIFEST,
    index: { schema: 'nousos.review-graph/2', nodes: index.nodes, edges: index.edges } }));
}

type Trace = { mounts: number; updates: RenderVisibility[]; destroys: number; ratio: number; dimensions: string[];
  pick: ((pick: PickResult | null, shiftKey: boolean) => void) | null; shown: PickResult[] };
type SpyClient = ProjectionWorkerClient & { requests: ProjectionClientRequest[]; gate: (() => Promise<void> | undefined) | null };

/** A client that records every request and answers it with the real main-thread host (the worker fallback). */
function spyClient(): SpyClient {
  const inner = createProjectionWorkerClient({ fallbackProjections: [fractalProjection, indrasPearlsProjection] });
  const client: SpyClient = {
    requests: [], gate: null,
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    async project(request) {
      client.requests.push(request);
      const wait = client.gate?.();
      if (wait) await wait;
      return inner.project(request);
    },
    cancel: slot => inner.cancel(slot),
    dispose: () => inner.dispose(),
  };
  return client;
}

async function typedPage(options: { axes?: Record<string, unknown>; client?: ProjectionWorkerClient; index?: V2Index;
  expand?: boolean; deps?: Record<string, unknown> } = {}) {
  const index = options.index ?? indraIndex();
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], destroys: 0, ratio: 1, dimensions: [], pick: null, shown: [] };
  let pageRef: V2Page | null = null;
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick(handler) { trace.pick = handler; }, onHover() {},
      mount() { trace.mounts++; trace.dimensions.push(dimension); },
      updateVisibleSubset(_styled, visibility) { trace.updates.push(visibility); },
      readCameraState: () => ({ ratio: trace.ratio }),
      destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    // The page's own default panel entry, so that a pick renders the real card into the fake details column.
    panel: { show: (host, pick, result, snap, step) => {
      trace.shown.push(pick);
      (pageRef as unknown as { buildDefaultPipeline(): ProjectionPipelineInput }).buildDefaultPipeline().panel.show(host, pick, result, snap, step);
    } },
  };
  const deps = { projectionPipeline: input, ...(options.client ? { projectionWorker: options.client } : {}), ...options.deps };
  const page: V2Page = new Page(MANIFEST, index, { ...AXES, ...options.axes } as never, APPEARANCE, PALETTE, {}, 'complete', deps);
  pageRef = page;
  if (options.expand !== false) for (const node of index.nodes) if (node.level === 2) page.history.expand(node.id);
  await page.refresh();
  return { page, trace, snapshot, input, index };
}

type ProjectionRecord = { enabled: boolean; resultDigest: string | null; algorithm: string | null; organization: string;
  cameraKey: string | null; pending: boolean; refusal: { code: string; detail: string } | null; openLevelId: string | null;
  unopenedLevels: string[]; refusedLevels: { levelId: string; code: string; detail: string }[]; domainDigest: string | null;
  requestedLevelRefusals: { levelId: string; code: string; detail: string }[] };
const recordOf = (page: V2Page) => (page.witness() as unknown as { projection: ProjectionRecord }).projection;
const internals = (page: V2Page) => page as unknown as { projectionResult: ProjectionResult | null; indraRequest: unknown;
  lod: string; selected: string | null; typedSelection: PickResult | null;
  indraRequestedLevelRefusals: Map<string, { levelId: string; code: string; detail: string }> };
const resultOf = (page: V2Page) => internals(page).projectionResult;
const statusText = () => elements.get('status')!.textContent;
const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !condition()) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), label);
};
const textOf = (element: FakeElement | { text?: string }): string => {
  const node = element as FakeElement;
  return [node.textContent ?? '', (element as { text?: string }).text ?? '', ...(node.children ?? []).map(textOf)].join(' ');
};
/** The selection cards of the details column: the legend and the overview beside them are not part of a card. */
const cardsText = (element: FakeElement): string =>
  element.className === 'selection-card' ? textOf(element) : element.children.map(cardsText).join(' ');
const lazyOf = (result: ProjectionResult) => result.levels.filter(level => isLazyLevel(result, level));

test('selecting Indra requests the root through the typed pipeline and discloses the construction', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client });
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(client.requests.length, 0, 'Natural never touches the client');
  const natural = recordOf(page);

  await page.setAxes({ organization: 'indra' });
  assert.equal(client.requests.length, 1);
  const request = client.requests[0]!;
  assert.equal(request.projectionId, 'indras-pearls');
  assert.equal(request.slot, 'indras-pearls');
  assert.equal(request.requestedLevelId, undefined, 'the root');
  assert.equal(request.parameters.dimension, '2d');
  assert.equal(request.parameters.maxDepth, 3);
  assert.equal(request.parameters.maxWords, 200);
  assert.equal(request.parameters.tolerance, 0.02);
  assert.equal(request.parameters.generatorPolicy, 'ring-packing-v1');
  assert.equal(request.domain.nodeIds.length, 60, 'the disclosed domain is the request domain');

  const result = resultOf(page)!;
  assert.equal(result.determinism.algorithmId, 'indras-pearls');
  assert.equal(recordOf(page).organization, 'indra');
  assert.equal(recordOf(page).cameraKey, '2d/indra');
  assert.notEqual(recordOf(page).resultDigest, natural.resultDigest);
  // Another view's camera is never reused: the Indra view is a fresh host.
  assert.equal(trace.mounts, 2);
  assert.equal(trace.destroys, 1);

  const status = statusText();
  assert.match(status, /Indra's Pearls/);
  assert.match(status, /gruppo di Schottky di genere 3, margine di separazione 0\.02/);
  assert.match(status, /geometria derivata, non semantica/);
  assert.doesNotMatch(status, /3D/);
  assert.equal(status, indraDisclosureLine(result, '2d'));
  assert.equal(elements.get('render-root')!.attrs['aria-busy'], 'false');
  assert.ok(lazyOf(result).length > 0, 'the depth-two pearls are stubs');
  assert.equal(recordOf(page).openLevelId, null);
});

test('typed worker root refusals resolve setAxes, are disclosed, and are not requested again', async () => {
  for (const [organization, projectionId, refusal, refusalCode] of [
    ['indra', 'indras-pearls', 'indra', 'word-cap-exceeded'],
    ['fractal', 'fractal', 'fractal', 'uncertified-dynamics'],
  ] as const) {
    const inner = spyClient();
    let calls = 0;
    const client: ProjectionWorkerClient = {
      get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
      project(request) {
        calls++;
        const failure = { code: 'projection-refusal', refusal, refusalCode, detail: 'fixture refusal' } as const;
        return Promise.reject(new ProjectionClientError('projection-refusal', 'worker typed refusal', { failure }));
      },
      cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
    };
    const { page } = await typedPage({ client, axes: { organization } });
    assert.match(statusText(), new RegExp(`proiezione rifiutata \\[${refusalCode}\\]: fixture refusal`));
    await page.setAxes({ organization });
    assert.equal(calls, 1, `${organization} reuses the remembered typed refusal`);
  }
});

test('a refused saved Indra level is disclosed beside the displayed root and recorded in the witness', async () => {
  const inner = spyClient();
  let refuseSavedLevel = false;
  const client: ProjectionWorkerClient = {
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    project(request) {
      if (refuseSavedLevel && request.requestedLevelId !== undefined) {
        return Promise.reject(new ProjectionClientError('projection-refusal', 'worker typed refusal', {
          failure: { code: 'projection-refusal', refusal: 'indra', refusalCode: 'level-not-found', detail: 'livello salvato non disponibile' },
        }));
      }
      return inner.project(request);
    },
    cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
  };
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  const initial = resultOf(page)!;
  const requestedLevelId = lazyOf(initial)[0]!.id;
  await page.loadProjectionLevel(requestedLevelId, '2d/indra');
  assert.equal(recordOf(page).openLevelId, requestedLevelId);

  refuseSavedLevel = true;
  await page.refresh();

  const root = resultOf(page)!;
  assert.equal(recordOf(page).openLevelId, null, 'the view displays its own root after the saved level refuses');
  assert.equal(trace.mounts, 1, 'the existing Indra renderer remains mounted for the root result');
  assert.ok(trace.updates.length > 0, 'the root result reaches the renderer');
  assert.ok(statusText().includes(`livello richiesto ${requestedLevelId} rifiutato [level-not-found]`));
  const disclosure = textOf(elements.get('details')!);
  assert.ok(disclosure.includes(`Livello ${requestedLevelId} rifiutato [level-not-found]`));
  assert.match(disclosure, /È mostrato il livello radice/);
  assert.deepEqual(recordOf(page).requestedLevelRefusals,
    [{ levelId: requestedLevelId, code: 'level-not-found', detail: 'livello salvato non disponibile' }]);
  assert.equal(internals(page).indraRequestedLevelRefusals.size, 1, 'the current request owns the only refusal entry');
  assert.equal(root.coordinateState.kind, 'coordinates');

  const rootDigest = root.determinism.resultDigest;
  const requestsBeforeRefresh = inner.requests.length;
  await page.refresh();
  const sameRoot = resultOf(page)!;
  assert.equal(sameRoot.determinism.resultDigest, rootDigest, 'the later request returns the same root result');
  assert.equal(inner.requests.length, requestsBeforeRefresh + 1);
  assert.equal(inner.requests.at(-1)!.requestedLevelId, undefined, 'the later request asks for the root only');
  assert.doesNotMatch(statusText(), /livello richiesto .* rifiutato/);
  assert.doesNotMatch(textOf(elements.get('details')!), /Livello .* rifiutato/);
  assert.deepEqual(recordOf(page).requestedLevelRefusals, [], 'the witness lists no refusal for the new display');
  assert.equal(internals(page).indraRequestedLevelRefusals.size, 0, 'the previous request entry was discarded');
  refuseSavedLevel = false;
  await page.loadProjectionLevel(requestedLevelId, '2d/indra');
  refuseSavedLevel = true;
  await page.refresh();
  assert.ok(internals(page).indraRequestedLevelRefusals.size <= 1, 'the map is bounded by the latest request');
  await page.setAxes({ organization: 'natural' });
  assert.equal(internals(page).indraRequestedLevelRefusals.size, 0, 'leaving Indra clears its request disclosure');
});

test('an in-page Indra navigation clears a saved-level refusal before returning to the same root', async () => {
  const inner = spyClient();
  let refuseSavedLevel = false;
  const client: ProjectionWorkerClient = {
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    project(request) {
      if (refuseSavedLevel && request.requestedLevelId !== undefined) {
        return Promise.reject(new ProjectionClientError('projection-refusal', 'worker typed refusal', {
          failure: { code: 'projection-refusal', refusal: 'indra', refusalCode: 'level-not-found', detail: 'livello salvato non disponibile' },
        }));
      }
      return inner.project(request);
    },
    cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
  };
  const { page } = await typedPage({ client, axes: { organization: 'indra' } });
  const firstLevelId = lazyOf(resultOf(page)!)[0]!.id;
  await page.loadProjectionLevel(firstLevelId, '2d/indra');
  refuseSavedLevel = true;
  await page.refresh();

  const refusedRoot = resultOf(page)!;
  assert.equal(recordOf(page).openLevelId, null);
  assert.deepEqual(recordOf(page).requestedLevelRefusals,
    [{ levelId: firstLevelId, code: 'level-not-found', detail: 'livello salvato non disponibile' }]);
  assert.ok(textOf(elements.get('details')!).includes(`Livello ${firstLevelId} rifiutato [level-not-found]`));

  refuseSavedLevel = false;
  const anotherLevelId = lazyOf(refusedRoot).find(level => level.id !== firstLevelId)?.id;
  assert.ok(anotherLevelId, 'the fixture provides another level to open');
  await page.loadProjectionLevel(anotherLevelId!, '2d/indra');
  assert.equal(recordOf(page).openLevelId, anotherLevelId);
  while (recordOf(page).openLevelId !== null) await page.leaveIndraPearl('2d/indra');

  assert.equal(resultOf(page)!.determinism.resultDigest, refusedRoot.determinism.resultDigest,
    'returning to the root reproduces the same projection digest');
  assert.doesNotMatch(statusText(), /livello richiesto .* rifiutato/);
  assert.doesNotMatch(textOf(elements.get('details')!), /Livello .* rifiutato/);
  assert.deepEqual(recordOf(page).requestedLevelRefusals, [], 'the witness has no refusal for the new display');
  assert.equal(internals(page).indraRequestedLevelRefusals.size, 0);
});

test('a refused Indra root still clears a previously mounted typed renderer', async () => {
  const inner = spyClient();
  const client: ProjectionWorkerClient = {
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    project(request) {
      if (request.projectionId === 'indras-pearls') return Promise.reject(new ProjectionClientError('projection-refusal',
        'worker typed refusal', { failure: { code: 'projection-refusal', refusal: 'indra', refusalCode: 'invalid-request', detail: 'fixture root refusal' } }));
      return inner.project(request);
    },
    cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
  };
  const { page, trace } = await typedPage({ client });
  assert.equal(trace.mounts, 1, 'Natural has a mounted typed renderer before switching');
  await page.setAxes({ organization: 'indra' });
  assert.equal(trace.destroys, 1, 'the old renderer is cleared on root refusal');
  assert.equal((page as unknown as { projectionRenderer: unknown }).projectionRenderer, null);
  assert.match(statusText(), /proiezione rifiutata \[invalid-request\]/);
});

test('generic worker errors still reject setAxes', async () => {
  const inner = spyClient();
  const client: ProjectionWorkerClient = {
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    project() { return Promise.reject(new ProjectionClientError('projection-error', 'worker failed', {
      failure: { code: 'projection-error', message: 'TypeError: fixture failure' },
    })); },
    cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
  };
  const { page } = await typedPage({ client });
  await assert.rejects(page.setAxes({ organization: 'indra' }), error => error instanceof ProjectionClientError
    && error.failure?.code === 'projection-error');
  assert.ok(elements.get('error')!.children.length > 0, 'the generic failure reaches the error panel');
  elements.get('error')!.replaceChildren();
});

test('open and leave hooks resolve a worker refusal and do not request it again', async () => {
  const inner = spyClient();
  let levelCalls = 0;
  const client: ProjectionWorkerClient = {
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    project(request) {
      if (request.requestedLevelId !== undefined && ++levelCalls === 2) {
        const failure = { code: 'projection-refusal', refusal: 'indra', refusalCode: 'word-cap-exceeded', detail: 'fixture word cap' } as const;
        return Promise.reject(new ProjectionClientError('projection-refusal', 'worker typed refusal', { failure }));
      }
      return inner.project(request);
    },
    cancel: slot => inner.cancel(slot), dispose: () => inner.dispose(),
  };
  const { page } = await typedPage({ client, axes: { organization: 'indra' } });
  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  await page.leaveIndraPearl('2d/indra');
  assert.equal(levelCalls, 2);
  assert.match(statusText(), /word-cap-exceeded/);
  await page.leaveIndraPearl('2d/indra');
  assert.equal(levelCalls, 2, 'the remembered leave refusal is not sent to the worker again');
});

test('the 3D disclosure names the hemisphere; the fallback packing is disclosed as such', async () => {
  const client = spyClient();
  const { page } = await typedPage({ client, axes: { projection: '3d' } });
  await page.setAxes({ organization: 'indra' });
  assert.match(statusText(), /3D: semisfera sul disco di ogni pearl/);
  assert.equal(client.requests[0]!.parameters.dimension, '3d');
  // Fewer than four hierarchy children cannot pair discs: the labelled Euclidean packing is used.
  const small = await typedPage({ client: spyClient(), index: indraIndex([{ id: 'a', children: 1, leaves: 2 }]) });
  await small.page.setAxes({ organization: 'indra' });
  const result = resultOf(small.page)!;
  assert.equal(result.diagnostics.find(item => item.code === 'indra:geometry-mode')?.value, 'fallback-packing');
  assert.match(statusText(), /impaccamento euclideo annidato, nessun gruppo di Schottky certificato \[[a-z-]+\]/);
  assert.match(statusText(), /geometria derivata, non semantica/);
  assert.doesNotMatch(statusText(), /gruppo di Schottky di genere/);
});

const ROOT_STUB = 'indra-level-2-0+0+';
const rootParams = (page: V2Page) => (internals(page).indraRequest as { parameters: Record<string, unknown> }).parameters;

test('opening a lazy pearl by its token nests its children on the same host and keeps the camera', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  trace.ratio = 0.5;
  const before = resultOf(page)!;
  const stub = before.levels.find(level => level.id === ROOT_STUB)!;
  assert.ok(isLazyLevel(before, stub), 'a depth-two stub is genuinely lazy');
  const camera = page.cameraState();
  const { mounts, destroys, updates } = { mounts: trace.mounts, destroys: trace.destroys, updates: trace.updates.length };
  const requests = client.requests.length;

  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  assert.equal(client.requests.length, requests + 1);
  const request = client.requests.at(-1)!;
  assert.equal(request.requestedLevelId, ROOT_STUB, 'the token names the level');
  assert.deepEqual(request.parameters, rootParams(page), 'the same parameters as the root request');
  assert.equal(request.domain.domainDigest, recordOf(page).domainDigest, 'the same domain');

  const after = resultOf(page)!;
  assert.notEqual(after.determinism.resultDigest, before.determinism.resultDigest);
  assert.equal(recordOf(page).openLevelId, ROOT_STUB);
  assert.equal(trace.mounts, mounts, 'the level lands on the same host');
  assert.equal(trace.destroys, destroys);
  assert.equal(trace.updates.length, updates + 1);
  assert.equal(trace.updates.at(-1)!.projectionResultDigest, after.determinism.resultDigest);
  assert.deepEqual(page.cameraState(), camera, 'the camera is not reset');
  assert.equal(trace.ratio, 0.5);
  assert.match(statusText(), /^Vista Indra's Pearls · gruppo di Schottky di genere 3/);
  assert.doesNotMatch(statusText(), /non apert/);

  // Children nest in their parent; siblings stay; every domain node is still drawn once.
  const containers = new Map(after.containers.map(container => [container.visualId, container]));
  assert.equal(containers.get('visual:indra:pearl:0+0+')?.parentVisualId, 'visual:indra:pearl:0+');
  assert.ok(after.containers.some(container => container.parentVisualId === 'visual:indra:pearl:0+0+'), 'the opened pearl holds its children');
  for (const sibling of ['0-', '1+', '1-', '2+', '2-'])
    assert.equal(containers.get(`visual:indra:pearl:${sibling}`)?.parentVisualId, null, `the root sibling ${sibling} stays`);
  assert.ok(after.containers.some(container => container.parentVisualId === 'visual:indra:pearl:0+' && container.visualId !== 'visual:indra:pearl:0+0+'),
    'the opened pearl siblings stay inside their parent');
  assert.deepEqual([...after.loadedNodeIds].sort(), [...before.loadedNodeIds].sort());
  assert.equal(Object.keys(after.positions2 ?? {}).length, before.loadedNodeIds.length);
  const opened = after.levels.find(level => level.id === ROOT_STUB)!;
  assert.equal(isLazyLevel(after, opened), false, 'the opened pearl is no longer a stub');
});

test('a stale token, a stale camera and a level that is not a lazy pearl are refused', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  const digest = recordOf(page).resultDigest;
  const requests = client.requests.length;
  await assert.rejects(page.loadProjectionLevel(ROOT_STUB, '2d/natural'), /Stale projection camera/, 'a camera key read from another view');
  await assert.rejects(page.loadProjectionLevel(ROOT_STUB, '3d/indra'), /Stale projection camera/, 'a camera key read from another dimension');
  await assert.rejects(page.loadProjectionLevel('indra-level-1-0+', '2d/indra'), /not unopened/, 'a loaded pearl');
  await assert.rejects(page.loadProjectionLevel(ROOT_LEVEL_ID), /already open/, 'the root, whose children are all loaded');
  await assert.rejects(page.loadProjectionLevel('indra-level-9-nowhere'), /not unopened/);
  assert.equal(client.requests.length, requests, 'a refused level is never requested');

  // A token of the result that another request minted: the assembly refuses it by name.
  const request = internals(page).indraRequest as { parameters: Record<string, unknown> };
  internals(page).indraRequest = { ...request, parameters: { ...request.parameters, tolerance: 1e-5 } };
  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  assert.equal(client.requests.length, requests, 'a stale token is dropped before another projection request');
  internals(page).indraRequest = request;
  // A token whose snapshot is not the page's: refused before any request.
  const result = resultOf(page)!;
  internals(page).projectionResult = { ...result, levels: result.levels.map(level =>
    level.id === ROOT_STUB && !level.loaded ? { ...level, loadToken: { ...level.loadToken, snapshotDigest: 'another-snapshot' } } : level) };
  await assert.rejects(page.loadProjectionLevel(ROOT_STUB, '2d/indra'), /Stale projection level token/);
  internals(page).projectionResult = result;
  assert.equal(client.requests.length, requests, 'neither stale token reached the projection');

  // A load in flight when the view changes lands nowhere.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  client.gate = () => gate;
  const load = page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  const outcome = assert.rejects(load, /Stale projection (camera|level token)/);
  await until(() => client.requests.length === requests + 1, 'the level was requested');
  client.gate = null;
  await page.setAxes({ organization: 'natural' });
  release();
  await outcome;
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.notEqual(recordOf(page).resultDigest, digest);
  assert.equal(trace.destroys, 1, 'only the Indra host was retired, by the switch');
});

test('leaving a pearl returns to its parent level, then the root, without refitting', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  trace.ratio = 0.5;
  const rootDigest = recordOf(page).resultDigest;
  await assert.rejects(page.leaveIndraPearl(), /No pearl is open/);
  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  const camera = page.cameraState();
  const { mounts, destroys } = { mounts: trace.mounts, destroys: trace.destroys };

  await assert.rejects(page.leaveIndraPearl('2d/natural'), /Stale projection camera/);
  await page.leaveIndraPearl('2d/indra');
  const parent = 'indra-level-1-0+';
  assert.equal(recordOf(page).openLevelId, parent, 'the parent level is open now');
  assert.equal(client.requests.at(-1)!.requestedLevelId, parent);
  const direct = await indrasPearlsProjection.project((internals(page) as unknown as { projectionSnapshot: SemanticGraphSnapshot }).projectionSnapshot,
    { ...(internals(page).indraRequest as never as Parameters<typeof indrasPearlsProjection.project>[1]), requestedLevelId: parent });
  assert.equal(recordOf(page).resultDigest, direct.determinism.resultDigest, 'the parent level is the level a direct request opens');
  assert.equal(trace.mounts, mounts);
  assert.equal(trace.destroys, destroys);
  assert.deepEqual(page.cameraState(), camera, 'the camera is not refitted');

  await page.leaveIndraPearl('2d/indra');
  assert.equal(recordOf(page).openLevelId, null);
  assert.equal(recordOf(page).resultDigest, rootDigest, 'the root is the root result again');
  assert.equal(client.requests.at(-1)!.requestedLevelId, undefined);
  assert.equal(trace.mounts, mounts);
  assert.deepEqual(page.cameraState(), camera);
  await assert.rejects(page.leaveIndraPearl(), /No pearl is open/);
  assert.match(statusText(), /^Vista Indra's Pearls/);
});

test('the details column offers the exit only while a pearl is open', async () => {
  const client = spyClient();
  const { page } = await typedPage({ client, axes: { organization: 'indra' } });
  const find = (element: FakeElement): FakeElement | null =>
    element.id === 'indra-leave-pearl' ? element : element.children.map(find).find(Boolean) ?? null;
  assert.equal(find(elements.get('details')!), null);
  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  const button = find(elements.get('details')!);
  assert.ok(button, 'the exit control is in the panel, not in the toolbar');
  button!.onclick!();
  await until(() => recordOf(page).openLevelId === 'indra-level-1-0+', 'the exit returned to the parent level');
  assert.ok(find(elements.get('details')!), 'still open at the parent level');
  find(elements.get('details')!)!.onclick!();
  await until(() => recordOf(page).openLevelId === null, 'the exit returned to the root');
  assert.equal(find(elements.get('details')!), null);
});

test('focus on a node opens the largest lazy pearl of its own pearl on the same host', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  const root = resultOf(page)!;
  assert.equal(client.requests.length, 1, 'the far band with no focus requests no level');
  const focused = 'n:a:01:01';
  const home = root.levels.find(level => level.loaded && level.memberNodeIds.includes(focused))!;
  const mounts = trace.mounts;

  trace.pick!({ kind: 'node', id: focused }, false);
  await until(() => recordOf(page).openLevelId !== null, 'the focus opened a pearl');
  const requested = client.requests.at(-1)!.requestedLevelId!;
  assert.ok(home.childLevelIds.includes(requested), 'a child stub of the pearl that holds the node');
  const stubs = home.childLevelIds.map(id => root.levels.find(level => level.id === id)!);
  assert.equal(stubs.find(stub => stub.id === requested)!.memberCount, Math.max(...stubs.map(stub => stub.memberCount)), 'the largest');
  assert.equal(trace.mounts, mounts, 'no remount');
  assert.equal((page as unknown as { selected: string }).selected, focused);
  assert.ok(trace.updates.at(-1)!.nodeIds.has(focused), 'the focused node is still drawn');
  const after = resultOf(page)!;
  assert.ok(after.levels.some(level => level.loaded && level.memberNodeIds.includes(focused)), 'the node lives in a finer pearl');
});

test('a pearl left under a focus stays closed on refresh until that focus is picked anew', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  trace.pick!({ kind: 'node', id: 'n:a:01:01' }, false);
  await until(() => recordOf(page).openLevelId !== null, 'opened by the focus');
  await page.leaveIndraPearl();
  await page.leaveIndraPearl();
  assert.equal(recordOf(page).openLevelId, null);
  const asked = client.requests.length;
  await page.setDensity('essential');
  await page.setDensity('complete');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(recordOf(page).openLevelId, null, 'a refresh does not reopen the pearl that was left');
  assert.ok(client.requests.slice(asked).every(request => request.requestedLevelId === undefined));
  trace.pick!({ kind: 'node', id: 'n:a:01:01' }, false);
  await until(() => recordOf(page).openLevelId !== null, 'picking the focus anew opens it again');
});

test('the near band opens the focused pearl level after level to the cap; a cap refusal is disclosed once', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  trace.pick!({ kind: 'node', id: 'n:a:01:01' }, false);
  await until(() => recordOf(page).openLevelId !== null, 'opened once by the focus');
  const opened = recordOf(page).openLevelId!;
  assert.match(opened, /^indra-level-2-/);
  assert.deepEqual(recordOf(page).refusedLevels, [], 'a focus alone stops at the level it opened');
  // Zoomed into the near band, the next level follows for the same focus until a cap refuses it.
  internals(page).lod = 'near';
  await page.refresh();
  await until(() => recordOf(page).refusedLevels.length > 0, 'the cap refusal is recorded');
  const refused = recordOf(page).refusedLevels;
  assert.ok(refused.every(item => item.code === 'depth-cap-exceeded' && item.levelId.startsWith('indra-level-3-')),
    'a depth cap refuses every lazy level of that depth alike');
  assert.match(statusText(), new RegExp(`${refused.length} livelli non aperti \\[depth-cap-exceeded\\]`));
  assert.equal(recordOf(page).openLevelId, opened, 'the mounted result stays at the last level that opened');
  const probes = () => client.requests.filter(request => request.requestedLevelId?.startsWith('indra-level-3-')).length;
  assert.equal(probes(), 1, 'the refusal is found by one request, then remembered');
  // A repeated focus or refresh does not ask for the refused levels again.
  trace.pick!({ kind: 'node', id: 'n:a:01:01' }, false);
  await page.refresh();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(probes(), 1);
  assert.equal(recordOf(page).openLevelId, opened);
});

test('a genus-4 pearl opens under the page word cap because only the opened pearl is materialised', async () => {
  // Four paired discs (genus 4) have 392 reduced words at depth three, but one opening materialises only 2g-1 = 7 of them
  // (indra-levels-v2). The word cap is exercised at the assembly level (indra-projection.test.ts, levels.test.ts); the page cap
  // of 200 therefore no longer refuses, and the depth cap is covered by the test above.
  const client = spyClient();
  const { page, trace } = await typedPage({ client, index: fractalIndex(), axes: { organization: 'indra' } });
  trace.pick!({ kind: 'node', id: 'n:a:g1:c05' }, false);
  await until(() => recordOf(page).openLevelId !== null, 'the pearl opens');
  assert.ok(recordOf(page).refusedLevels.every(item => item.code !== 'word-cap-exceeded'), 'no word-cap refusal');
  assert.doesNotMatch(statusText(), /\[word-cap-exceeded\]/);
  assert.match(statusText(), /^Vista Indra's Pearls/);
  assert.equal(recordOf(page).refusal, null, 'the mounted result is a real opened level');
});

test('a refresh keeps the open pearl; a changed disclosure returns to the root; leaving the view forgets it', async () => {
  const client = spyClient();
  const { page } = await typedPage({ client, axes: { organization: 'indra' } });
  await page.loadProjectionLevel(ROOT_STUB, '2d/indra');
  await page.setDensity('essential');
  assert.equal(client.requests.at(-1)!.requestedLevelId, ROOT_STUB, 'the open pearl is requested again');
  assert.equal(recordOf(page).openLevelId, ROOT_STUB);

  await page.setAxes({ projection: '3d' });
  assert.equal(client.requests.at(-1)!.parameters.dimension, '3d');
  assert.equal(client.requests.at(-1)!.requestedLevelId, ROOT_STUB, 'the same pearl in the other dimension');
  assert.equal(recordOf(page).cameraKey, '3d/indra');

  await page.collapse('n:f:01');
  assert.equal(client.requests.at(-1)!.requestedLevelId, undefined, 'another domain: the pearl of the old one is not requested');
  assert.equal(recordOf(page).openLevelId, null);

  await page.setAxes({ organization: 'natural' });
  await page.setAxes({ organization: 'indra' });
  assert.equal(recordOf(page).openLevelId, null);
});

test('the projection runs through the client, and a page without a client or registry uses the main-thread fallback', async () => {
  const noClient = await typedPage({});
  const internal = noClient.page as unknown as { workerClient(): ProjectionWorkerClient | null; projectionClient: unknown };
  assert.equal(internal.projectionClient, undefined, 'Natural starts no worker');
  await noClient.page.setAxes({ organization: 'indra' });
  assert.equal(internal.workerClient()!.backend, 'main-thread', 'no Worker in this environment: the same host on the main thread');
  assert.equal(recordOf(noClient.page).algorithm, 'indras-pearls');
  assert.match(statusText(), /Vista Indra's Pearls/);

  const registry = new ProjectionRegistry();
  const seen: string[] = [];
  registry.register({ id: 'indras-pearls', version: indrasPearlsProjection.version, project(snapshot: SemanticGraphSnapshot, request: never) {
    seen.push((request as { id: string }).id);
    return indrasPearlsProjection.project(snapshot, request);
  } });
  const registered = await typedPage({ deps: { projectionRegistry: registry } });
  assert.equal((registered.page as unknown as { workerClient(): unknown }).workerClient(), null, 'a given registry computes directly');
  await registered.page.setAxes({ organization: 'indra' });
  assert.deepEqual(seen, ['indras-pearls']);
});

/** A message port to a real projection host, the way a Worker delivers: every message is structured-cloned. */
function clonedPort(host: (deliver: (event: unknown) => void) => { handleCommand(command: unknown): void }) {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const deliver = (event: unknown) => { const data = structuredClone(event); queueMicrotask(() => { for (const listener of listeners) listener({ data }); }); };
  const instance = host(deliver);
  return {
    postMessage(message: unknown) { const data = structuredClone(message); queueMicrotask(() => instance.handleCommand(data)); },
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) { listeners.add(listener); },
    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void) { listeners.delete(listener); },
  };
}

test('over a cloning message port the Fractal and Indra views, a level and a refusal behave as on the main thread', async () => {
  const { ProjectionWorkerHost } = await import('../../src/projection/worker-host.ts');
  const port = clonedPort(deliver => new ProjectionWorkerHost({ postEvent: deliver, projections: [fractalProjection, indrasPearlsProjection] }));
  const client = createProjectionWorkerClient({ port });
  assert.equal(client.backend, 'external-port');
  const giant = await typedPage({ client, index: fractalIndex() });
  await giant.page.setAxes({ organization: 'fractal' });
  const fractal = resultOf(giant.page)!;
  assert.equal(fractal.determinism.algorithmId, 'fractal');
  assert.ok(Object.keys(fractal.positions2 ?? {}).length === NODE_COUNT);
  assert.match(statusText(), /Vista Fractal/);

  const { page, trace } = await typedPage({ client, axes: { organization: 'indra' } });
  const root = resultOf(page)!;
  assert.equal(root.determinism.algorithmId, 'indras-pearls');
  assert.match(statusText(), /Indra's Pearls/);
  const stub = lazyOf(root)[0]!;
  const mounts = trace.mounts;
  await page.loadProjectionLevel(stub.id, '2d/indra');
  assert.equal(recordOf(page).openLevelId, stub.id);
  assert.equal(trace.mounts, mounts);
  await page.leaveIndraPearl();
  assert.equal(recordOf(page).openLevelId === stub.id, false);

  // A typed refusal crosses the cloning port as refusal data and appears in the page status.
  const refusing = await typedPage({ client, index: indraIndex() });
  await refusing.page.setAxes({ organization: 'fractal' });
  assert.equal(resultOf(refusing.page), null);
  assert.equal(recordOf(refusing.page).refusal?.code, 'edge-locality-refusal');
  assert.match(statusText(), /Vista Fractal · proiezione rifiutata \[edge-locality-refusal\]/);
  client.dispose();
});

test('a superseded projection is cancelled and its result is dropped', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const slow = { id: 'indras-pearls' as const, version: indrasPearlsProjection.version,
    async project(snapshot: SemanticGraphSnapshot, request: Parameters<typeof indrasPearlsProjection.project>[1]) {
      if (++calls === 1) await gate;
      return indrasPearlsProjection.project(snapshot, request);
    } };
  const client = createProjectionWorkerClient({ fallbackProjections: [slow, fractalProjection] });
  const { page, trace } = await typedPage({ client, axes: { organization: 'natural' } });
  const switching = page.setAxes({ organization: 'indra' });
  await until(() => calls === 1, 'the assembly was asked');
  assert.equal(elements.get('render-root')!.attrs['aria-busy'], 'true');
  assert.match(statusText(), /Indra's Pearls · calcolo della proiezione in corso/);
  assert.equal(recordOf(page).pending, true);

  const density = page.setDensity('essential');
  release();
  await Promise.all([switching, density]);
  assert.equal(calls, 2, 'the newer refresh asked again; the stale one was cancelled');
  assert.equal(recordOf(page).algorithm, 'indras-pearls');
  assert.equal(recordOf(page).pending, false);
  assert.equal(trace.mounts, 2, 'one Indra host, mounted once');
  assert.equal(elements.get('error')!.children.length, 0, 'no failure reached the error panel');
  assert.match(statusText(), /^Vista Indra's Pearls/);
  client.dispose();
});

test('leaving the view while its projection computes cancels the computation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let aborted: boolean | null = null;
  const slow = { id: 'indras-pearls' as const, version: indrasPearlsProjection.version,
    async project(snapshot: SemanticGraphSnapshot, request: Parameters<typeof indrasPearlsProjection.project>[1]) {
      await gate;
      aborted = request.abort?.aborted ?? false;
      return indrasPearlsProjection.project(snapshot, request);
    } };
  const client = createProjectionWorkerClient({ fallbackProjections: [slow, fractalProjection] });
  const { page, trace } = await typedPage({ client });
  const switching = page.setAxes({ organization: 'indra' });
  await until(() => recordOf(page).pending, 'the projection is computing');
  await page.setAxes({ organization: 'natural' });
  release();
  await switching;
  await until(() => aborted !== null, 'the stale computation reached its checkpoint');
  assert.equal(aborted, true, 'the client told the host to stop');
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(recordOf(page).pending, false);
  assert.equal(trace.mounts, 1, 'the stale Indra result was never mounted');
  assert.equal(elements.get('error')!.children.length, 0);
  client.dispose();
});

test('a page without the typed pipeline serves Indra through it, returns to the product view for Natural, and keeps the legacy rollback', async () => {
  const index = indraIndex();
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], destroys: 0, ratio: 1, dimensions: [], pick: null, shown: [] };
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick() {}, onHover() {}, mount() { trace.mounts++; },
      updateVisibleSubset(_styled, visibility) { trace.updates.push(visibility); },
      readCameraState: () => ({ ratio: 1 }), destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show() {} },
  };
  const counts = { mounts: 0, destroys: 0, axes: [] as string[] };
  const createView = async (view: { axes: { organization: string } }) => {
    counts.mounts++; counts.axes.push(view.axes.organization);
    return {
      destroy() { counts.destroys++; }, readCamera: () => ({ ratio: 1 }), restoreCamera() {}, async fit() {}, async resetCamera() {},
      async frame() {}, select() {}, setEmphasis() {}, setInsets() {}, setFlowMotion() {}, async setAxes() {}, async setVisible() {},
      async setAppearance() {}, async setPalette() {}, viewPreset() {}, camera: () => null,
      witness: () => ({ axes: {}, cameraKind: 'orthographic', visibleRect: { left: 0, top: 0, width: 800, height: 600 },
        nodeViewport: {}, positions: {}, selected: null, emphasised: [], windows: [], labels: [],
        depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: 'v2-layout', palette: 'bw' }),
    };
  };
  const make = (extra: Record<string, unknown>) => {
    const page: V2Page = new Page(MANIFEST, indraIndex(), AXES as never, APPEARANCE, PALETTE, {}, 'complete',
      { createView: createView as never, projectionWorker: spyClient(), ...extra });
    for (const node of index.nodes) if (node.level === 2) page.history.expand(node.id);
    return page;
  };

  const page = make({ fractalPipeline: input });
  await page.refresh();
  assert.equal(counts.mounts, 1);
  assert.equal('projection' in (page.witness() as object), false, 'Natural without the flag reports no typed record');
  assert.equal((page as unknown as { projectionClient: unknown }).projectionClient !== undefined, true);
  await page.setAxes({ organization: 'indra' });
  assert.equal(trace.mounts, 1, 'Indra is drawn by the typed renderer');
  assert.equal(counts.destroys, 1, 'the product view it replaces is retired once the typed renderer is up');
  assert.equal(recordOf(page).algorithm, 'indras-pearls');
  assert.match(statusText(), /Vista Indra's Pearls/);
  await page.setAxes({ organization: 'natural' });
  assert.equal(trace.destroys, 1);
  assert.equal(counts.mounts, 2, 'Natural is the product view again');
  assert.equal(statusText(), 'Grafo pronto');
  assert.equal('projection' in (page.witness() as object), false);

  // The explicit rollback: the product view draws the Indra organization, no typed record.
  const legacy = make({ legacyIndra: true });
  await legacy.refresh();
  const mounted = counts.mounts;
  await legacy.setAxes({ organization: 'indra' });
  assert.equal(counts.mounts, mounted + 1);
  assert.equal(counts.axes.at(-1), 'indra');
  assert.equal('projection' in (legacy.witness() as object), false);
  assert.equal(legacy.supportsOrganization('indra'), true);
});

test('the legacy flag is an explicit hash or query parameter and nothing else', () => {
  assert.equal(indraLegacyFlagEnabled('', '#indra=legacy'), true);
  assert.equal(indraLegacyFlagEnabled('?indra=legacy', ''), true);
  assert.equal(indraLegacyFlagEnabled('', '#view=x&indra=legacy&projection=natural'), true);
  assert.equal(indraLegacyFlagEnabled('', ''), false);
  assert.equal(indraLegacyFlagEnabled('', '#indra=pearls'), false);
  assert.equal(indraLegacyFlagEnabled('', '#indra'), false);
  assert.equal(indraLegacyFlagEnabled('', '#projection=natural'), false, 'the projection flag does not roll Indra back');
  assert.equal(indraLegacyFlagEnabled('?indra=Legacy', ''), false);
});

test('projectionRefusalOf recognises the typed refusals, thrown or carried by the worker, and nothing else', async () => {
  assert.deepEqual(projectionRefusalOf(new IndraProjectionRefusal('depth-cap-exceeded', 'depth 4 exceeds the cap')),
    { code: 'depth-cap-exceeded', detail: 'depth 4 exceeds the cap' });
  const carried = (message: string) => Object.assign(new Error('projection worker failure projection-error'),
    { name: 'ProjectionClientError', code: 'projection-error', failure: { code: 'projection-error', message } });
  assert.deepEqual(projectionRefusalOf(carried('indras-pearls-projection: level-not-found: 1-2 is empty')), { code: 'level-not-found', detail: '1-2 is empty' });
  assert.deepEqual(projectionRefusalOf(carried('fractal-projection: invalid-request: multi\nline detail')), { code: 'invalid-request', detail: 'multi\nline detail' });
  assert.equal(projectionRefusalOf(carried('fractal-projection: made-up-refusal: coincidental text')), null,
    'the legacy branch accepts only codes emitted by the named assembly');
  assert.equal(projectionRefusalOf(carried('indras-pearls-projection: made-up-refusal: coincidental text')), null,
    'an arbitrary pattern-shaped worker error remains a genuine error');
  assert.equal(projectionRefusalOf(carried('TypeError: x is undefined')), null);
  assert.equal(projectionRefusalOf(carried('other-projection: invalid-request: x')), null);
  assert.equal(projectionRefusalOf(new Error('indras-pearls-projection: invalid-request: a lookalike')), null, 'a plain error is never a refusal');
  assert.equal(projectionRefusalOf(Object.assign(new Error('x'), { name: 'IndraProjectionRefusal' })), null, 'a refusal without a code is not one');
  assert.equal(projectionRefusalOf(Object.assign(carried('fractal-projection: invalid-request: x'), { failure: { code: 'unknown-projection', message: 'fractal-projection: invalid-request: x' } })), null);
  assert.equal(projectionRefusalOf('invalid-request'), null);
});

const kindsOf = (result: ProjectionResult) => ({
  node: { kind: 'node' as const, id: result.loadedNodeIds[0]! },
  container: result.containers[0] && { kind: 'container' as const, visualId: result.containers[0].visualId },
  curve: result.curves[0] && { kind: 'curve' as const, visualId: result.curves[0].visualId },
  field: result.fields[0] && { kind: 'field' as const, visualId: result.fields[0].id },
  'visual-relation': result.visualRelations[0] && { kind: 'visual-relation' as const, visualId: result.visualRelations[0].visualId },
});

test('typed picks of a Fractal and an Indra result open the explanation card of their own result, with provenance apart', async () => {
  const seenKinds = new Set<string>();
  const withProvenance = new Set<string>();
  for (const [organization, index] of [['fractal', fractalIndex()], ['indra', indraIndex()]] as const) {
    const { page, trace } = await typedPage({ client: spyClient(), index, axes: { organization } });
    const result = resultOf(page)!;
    assert.equal(result.determinism.algorithmId, organization === 'fractal' ? 'fractal' : 'indras-pearls');
    for (const [kind, pick] of Object.entries(kindsOf(result))) {
      if (!pick) continue;
      seenKinds.add(kind);
      trace.shown.length = 0;
      trace.pick!(pick, false);
      assert.deepEqual(trace.shown[0], pick, `${organization} ${kind}: the panel entry was asked for the pick`);
      const text = cardsText(elements.get('details')!);
      const id = pick.kind === 'node' ? pick.id : pick.visualId;
      const explanation = result.explanations[id]!;
      assert.ok(text.includes(explanation.summary), `${organization} ${kind}: the result's own summary`);
      assert.match(text, kind === 'node' ? /Nodo · spiegazione della proiezione/ : kind === 'container' ? /Contenitore derivato/
        : kind === 'curve' ? /Curva derivata/ : kind === 'field' ? /Campo derivato/ : /Relazione visuale derivata/);
      if (explanation.sourceIds.length) {
        assert.match(text, /Provenienza/, `${organization} ${kind}: provenance is its own section`);
        assert.match(text, /separati dalla geometria visuale/);
        withProvenance.add(kind);
      } else assert.doesNotMatch(text, /Provenienza/, `${organization} ${kind}: no source record, no provenance section`);
      if (kind !== 'node') {
        assert.match(text, /Derivato · non attestato/);
        assert.match(text, /Non semantic[ao] · non attestat[ao]/, `${organization} ${kind}: derived, never attested`);
        assert.doesNotMatch(text, /relazione attestata/i);
      }
      if (kind === 'visual-relation') assert.match(text, /Percorso sollevato/);
      if (kind === 'node') assert.match(text, new RegExp(`Titolo ${id.replace(/[:]/g, ':')}`), 'the source card of the node follows the explanation');
    }
  }
  assert.deepEqual([...seenKinds].sort(), ['container', 'curve', 'field', 'node', 'visual-relation']);
  assert.ok(withProvenance.has('node') && withProvenance.has('container'), 'source ids reach the separate provenance section');
});

test('projectionExplainsPick: only Fractal and Indra results explain picks, and a node only when the result explains it', () => {
  const result = (algorithmId: string, explained: string[]) => ({ determinism: { algorithmId },
    explanations: Object.fromEntries(explained.map(id => [id, {}])) }) as unknown as ProjectionResult;
  assert.equal(projectionExplainsPick(result('indras-pearls', []), { kind: 'container', visualId: 'v' }), true);
  assert.equal(projectionExplainsPick(result('fractal', []), { kind: 'field', visualId: 'v' }), true);
  assert.equal(projectionExplainsPick(result('indras-pearls', ['n']), { kind: 'node', id: 'n' }), true);
  assert.equal(projectionExplainsPick(result('indras-pearls', ['n']), { kind: 'semantic-edge', id: 'e' }), false);
  assert.equal(projectionExplainsPick(result('natural', ['n']), { kind: 'node', id: 'n' }), false);
  assert.equal(projectionExplainsPick(result('natural', []), { kind: 'curve', visualId: 'v' }), false);
});

/** A synthetic 850-node graph: 10 hierarchy roots, 6 projects each, 13 conversations per project. */
function syntheticIndex(): V2Index {
  const nodes: V2Node[] = [];
  const edges: V2Index['edges'] = [];
  let ordinal = 0;
  const add = (id: string, level: 1 | 2 | 3, parent: string | null) => {
    const value = ((ordinal++ * 7919) % 1009 + 1) / 1010;
    nodes.push({ id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation', parent, parents: parent ? [parent] : [],
      domains: [], title: `Titolo ${id}`, display_label: `Titolo ${id}`, title_full: `Titolo ${id}`, importance: { value, components: {} }, size: 1,
      counts: { children: 0, descendants: 0, canon: 0, passages: 0 } });
  };
  for (let root = 1; root <= 10; root++) {
    const rootId = `s:${pad(root)}`;
    add(rootId, 1, null);
    for (let project = 1; project <= 6; project++) {
      const projectId = `${rootId}:${pad(project)}`;
      add(projectId, 2, rootId);
      edges.push({ id: `h:${projectId}`, source: rootId, target: projectId, class: 'attested', type: 'relates', directed: false, evidence: [] });
      for (let leaf = 1; leaf <= 13; leaf++) {
        const leafId = `${projectId}:${pad(leaf)}`;
        add(leafId, 3, projectId);
        edges.push({ id: `h:${leafId}`, source: projectId, target: leafId, class: 'attested', type: 'relates', directed: false, evidence: [] });
        if (leaf > 1) edges.push({ id: `l:${leafId}`, source: `${projectId}:${pad(leaf - 1)}`, target: leafId, class: 'attested', type: 'relates', directed: false, evidence: [] });
      }
    }
  }
  for (let root = 1; root < 10; root++)
    edges.push({ id: `x:${root}`, source: `s:${pad(root)}:01:01`, target: `s:${pad(root + 1)}:01:01`, class: 'attested', type: 'relates', directed: false, evidence: [] });
  return { nodes, edges };
}

test('switching into Fractal and Indra with a synthetic 850-node snapshot stays within the interactive budget', async () => {
  const index = syntheticIndex();
  assert.equal(index.nodes.length, 850);
  const client = spyClient();
  const { page } = await typedPage({ client, index });
  const timings: Record<string, { switchMs: number; computeMs: number }> = {};
  for (const organization of ['indra', 'fractal'] as const) {
    const projectionId = organization === 'indra' ? 'indras-pearls' : 'fractal';
    const requests = client.requests.length;
    const started = performance.now();
    await page.setAxes({ organization });
    const switchMs = performance.now() - started;
    assert.equal(client.requests.length, requests + 1);
    assert.equal(client.requests.at(-1)!.projectionId, projectionId);
    assert.equal(client.requests.at(-1)!.domain.nodeIds.length, 850);
    assert.equal(recordOf(page).refusal, null, `${organization}: a drawing, not a refusal`);
    assert.equal(resultOf(page)!.loadedNodeIds.length, 850);
    // The same request again is answered by the host cache: the projection itself is not repeated.
    const again = performance.now();
    await page.setAxes({ organization: 'natural' });
    await page.setAxes({ organization });
    timings[organization] = { switchMs: Math.round(switchMs), computeMs: Math.round(performance.now() - again) };
    assert.ok(switchMs < 60_000, `${organization} switch took ${Math.round(switchMs)} ms`);
  }
  console.log(`D9 850-node switch (ms): ${JSON.stringify(timings)}`);
});
