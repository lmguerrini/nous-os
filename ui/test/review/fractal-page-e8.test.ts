import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { ProjectionRegistry } from '../../src/projection/registry.ts';
import { fractalProjection, FractalProjectionRefusal, fractalRefusalProjection } from '../../src/projection/fractal.ts';
import { certifyFractalDynamics } from '../../src/fractal/parameters.ts';
import type { PickResult, ProjectionRequest, ProjectionResult, RenderVisibility, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { CreateProductView, ProductView } from '../../src/review/view-contract.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';

/**
 * D-073 E8: the Fractal view on the organization axis. The page mounts it through the typed
 * pipeline (registered `fractalProjection`, the semantic LOD of C8b), loads the levels a giant
 * community promises by `requestedLevelId`, refuses a stale level or camera, discloses the view and
 * its typed refusals, shows a pending state while the assembly computes, and returns to Natural with
 * its arrangement. The page module is esbuild-bundled once, as the C4 and C8b page tests do.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/e8-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'e8-page-entry.ts', loader: 'ts',
    contents: `export { V2Page, fractalRefusalOf, fractalDisclosureLine, isLazyLevel } from ${JSON.stringify(fileURLToPath(pageSource))};`,
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
const { V2Page: Page, fractalRefusalOf, fractalDisclosureLine, isLazyLevel } =
  (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-e8-fixture', counts: {}, limits: {} };
const AXES = { projection: '2d' as const, morphology: 'stellar' as const, organization: 'natural' as const,
  colour: 'bw' as const, labels: true, reading: 'attested' as const };
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#ffffff', hover: '#ffffff', container: '#ebebeb', text: '#e8e8e8' };

const G1_LEAVES = 19, G2_LEAVES = 15, B_LEAVES = 14, NODE_COUNT = 54;
const pad = (value: number): string => String(value).padStart(2, '0');

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
const GIANT_LEVEL = 'fractal:community:n:a';

async function snapshotFor(index: V2Index): Promise<SemanticGraphSnapshot> {
  return createSemanticSnapshot(await normalizeRawLedger({ manifest: MANIFEST,
    index: { schema: 'nousos.review-graph/2', nodes: index.nodes, edges: index.edges } }));
}

type Trace = { mounts: number; updates: RenderVisibility[]; destroys: number; ratio: number; cameraReads: number;
  dimensions: string[]; pick: ((pick: PickResult | null, shiftKey: boolean) => void) | null };
type SpyOptions = { gate?: () => Promise<void> | undefined; failWith?: () => Error | null;
  /** A level-aware assembly whose giant community is genuinely lazy: its child levels are not in the first result. */
  lazyGiant?: boolean;
  /** With `lazyGiant`, the level request is refused with a typed refusal. */
  refuseLevels?: boolean };
type Spy = { requests: ProjectionRequest<'fractal'>[]; registry: ProjectionRegistry };

/**
 * A registered 'fractal' plugin around the real assembly that records every request it gets. By
 * default it is the real assembly, which returns the giant community as a promise whose child levels
 * are already loaded (complete by design); `lazyGiant` makes the promise genuinely lazy.
 */
function spyRegistry(options: SpyOptions = {}): Spy {
  const requests: ProjectionRequest<'fractal'>[] = [];
  const registry = new ProjectionRegistry();
  registry.register({
    id: 'fractal', version: fractalProjection.version,
    async project(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'fractal'>): Promise<ProjectionResult> {
      requests.push(request);
      const wait = options.gate?.();
      if (wait) await wait;
      const failure = options.failWith?.();
      if (failure) throw failure;
      const { requestedLevelId, ...base } = request;
      // Without a level-aware assembly the real one answers, and it refuses a level request.
      if (requestedLevelId !== undefined && options.lazyGiant !== true) return fractalProjection.project(snapshot, request);
      const result = await fractalProjection.project(snapshot, base);
      if (requestedLevelId === undefined)
        return options.lazyGiant === true ? { ...result, levels: result.levels.filter(item => item.parentId !== GIANT_LEVEL) } : result;
      if (options.refuseLevels === true) throw new FractalProjectionRefusal('invalid-request', 'level not available (invented)');
      // The whole-domain assembly already holds the promised members in its loaded children: the
      // opened level is the same result with that level marked loaded, as a level-aware assembly returns it.
      const level = result.levels.find(item => item.id === requestedLevelId);
      assert.ok(level && !level.loaded);
      const members = result.levels.filter(item => item.parentId === requestedLevelId && item.loaded)
        .flatMap(item => item.loaded ? item.memberNodeIds : []).sort();
      const set = new Set(members);
      const opened = { id: level.id, parentId: level.parentId, depth: level.depth, maxDepth: level.maxDepth, loaded: true as const,
        childLevelIds: level.childLevelIds, memberCount: level.memberCount, memberDigest: level.memberDigest ?? '',
        memberNodeIds: members,
        inducedEdgeIds: snapshot.edges.filter(edge => set.has(edge.source) && set.has(edge.target)).map(edge => edge.id).sort() };
      return { ...result, levels: result.levels.map(item => item.id === requestedLevelId ? opened : item),
        determinism: { ...result.determinism, resultDigest: `${result.determinism.resultDigest}:opened:${requestedLevelId}` } };
    },
  });
  return { requests, registry };
}

async function typedPage(options: { registry?: ProjectionRegistry; axes?: Record<string, unknown> } = {}) {
  const index = fractalIndex();
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], destroys: 0, ratio: 1, cameraReads: 0, dimensions: [], pick: null };
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick(handler) { trace.pick = handler; }, onHover() {},
      mount() { trace.mounts++; trace.dimensions.push(dimension); },
      updateVisibleSubset(_styled, visibility) { trace.updates.push(visibility); },
      readCameraState: () => { trace.cameraReads++; return { ratio: trace.ratio }; },
      destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show() {} },
  };
  const deps = { projectionPipeline: input, ...(options.registry ? { projectionRegistry: options.registry } : {}) };
  const page: V2Page = new Page(MANIFEST, index, { ...AXES, ...options.axes } as never, APPEARANCE, PALETTE, {}, 'complete', deps);
  // The two level-2 group projects disclose their conversations: all 54 nodes form the domain.
  page.history.expand('n:a:g1');
  page.history.expand('n:a:g2');
  await page.refresh();
  return { page, trace, snapshot, input };
}

type ProjectionRecord = { enabled: boolean; resultDigest: string | null; algorithm: string | null; arrangement: string | null;
  organization: string; cameraKey: string | null; pending: boolean; refusal: { code: string; detail: string } | null;
  unopenedLevels: string[]; refusedLevels: { levelId: string; code: string; detail: string }[]; domainDigest: string | null };
const recordOf = (page: V2Page) => (page.witness() as unknown as { projection: ProjectionRecord }).projection;
const resultOf = (page: V2Page) => (page as unknown as { projectionResult: ProjectionResult | null }).projectionResult;
const statusText = () => elements.get('status')!.textContent;
const until = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), label);
};

test('selecting Fractal projects the disclosed domain through the registered assembly and discloses the view', async () => {
  const { requests, registry } = spyRegistry();
  const { page, trace } = await typedPage({ registry });
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(statusText(), 'Grafo pronto');
  assert.equal(requests.length, 0, 'Natural never touches the Fractal assembly');
  const natural = recordOf(page);

  await page.setAxes({ organization: 'fractal' });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.id, 'fractal');
  assert.equal(request.domain.nodeIds.length, NODE_COUNT, 'the disclosed domain is the request domain');
  assert.equal(request.requestedLevelId, undefined);
  assert.equal(request.parameters.dimension, '2d');
  assert.equal(request.parameters.sectorPolicyVersion, 'sector-locality-v2');
  const result = resultOf(page)!;
  assert.equal(result.determinism.algorithmId, 'fractal');
  assert.equal(result.loadedNodeIds.length, NODE_COUNT);
  assert.equal(recordOf(page).organization, 'fractal');
  assert.equal(recordOf(page).algorithm, 'fractal');
  assert.notEqual(recordOf(page).resultDigest, natural.resultDigest);

  // Another view's camera is never reused: the Fractal view is a fresh host.
  assert.equal(trace.mounts, 2);
  assert.equal(trace.destroys, 1);
  assert.equal(natural.cameraKey, '2d/natural');
  assert.equal(recordOf(page).cameraKey, '2d/fractal');

  const status = statusText();
  assert.match(status, /Fractal/);
  assert.match(status, /geometria derivata, non semantica/);
  assert.match(status, /raggi esterni inversi/);
  assert.match(status, /p=[23], c=-?0\./, 'the certified dynamics are named');
  assert.doesNotMatch(status, /3D/);
  assert.equal(status, fractalDisclosureLine(result, '2d'));
  assert.equal(elements.get('render-root')!.attrs['aria-busy'], 'false');
  assert.equal('data-projection-pending' in elements.get('render-root')!.attrs, false);
});

test('the Fractal disclosure names the 3D scalar lift and the axes drop the Natural arrangement', async () => {
  const { registry } = spyRegistry();
  const { page } = await typedPage({ registry, axes: { projection: '3d', arrangement: 'network' } });
  await page.setAxes({ organization: 'fractal' });
  assert.match(statusText(), /3D: altezza = potenziale esterno \(sollevamento scalare\)/);
  const axes = (page.witness() as unknown as { axes: Record<string, unknown> }).axes;
  assert.equal(axes.organization, 'fractal');
  assert.equal('arrangement' in axes, false, 'a Fractal view keeps no Natural arrangement');
});

test('a pending state is on screen while the projection computes and clears when it lands', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { registry, requests } = spyRegistry({ gate: () => gate });
  const { page } = await typedPage({ registry });
  const switching = page.setAxes({ organization: 'fractal' });
  await until(() => requests.length === 1, 'the assembly was asked');
  const root = elements.get('render-root')!;
  assert.equal(root.attrs['aria-busy'], 'true');
  assert.ok('data-projection-pending' in root.attrs);
  assert.match(statusText(), /calcolo della proiezione in corso/);
  assert.equal(recordOf(page).pending, true);
  release();
  await switching;
  assert.equal(root.attrs['aria-busy'], 'false');
  assert.equal('data-projection-pending' in root.attrs, false);
  assert.equal(recordOf(page).pending, false);
  assert.match(statusText(), /Vista Fractal/);
});

test('a refresh superseded before the assembly starts never computes it', async () => {
  const { registry, requests } = spyRegistry();
  const { page } = await typedPage({ registry });
  const toFractal = page.setAxes({ organization: 'fractal' });
  const backToNatural = page.setAxes({ organization: 'natural' });
  await Promise.all([toFractal, backToNatural]);
  assert.equal(requests.length, 0, 'the Fractal request was superseded while queued');
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(recordOf(page).pending, false);
});

test('an out-of-register or unregistered view is refused', async () => {
  const { registry } = spyRegistry();
  const { page } = await typedPage({ registry });
  assert.equal(page.supportsOrganization('fractal'), true);
  assert.equal(page.supportsOrganization('natural'), true);
  await assert.rejects(page.setAxes({ organization: 'holographic' as never }), /closed vocabulary/);
  registry.unregister('fractal');
  assert.equal(page.supportsOrganization('fractal'), false, 'no dead control for a projection that is not registered');
  await assert.rejects(page.setAxes({ organization: 'fractal' }), /View is not registered: fractal/);
  assert.equal(recordOf(page).organization, 'natural');
});

test('a typed refusal of the assembly is shown as a refusal, not a drawing, and Natural restores its arrangement', async () => {
  let refuse = true;
  const { registry, requests } = spyRegistry({
    failWith: () => refuse ? new FractalProjectionRefusal('invalid-request', 'domain size 851 outside 1..850') : null,
  });
  const { page, trace } = await typedPage({ registry, axes: { arrangement: 'network' } });
  const natural = recordOf(page);
  assert.equal(natural.arrangement, 'network');

  await page.setAxes({ organization: 'fractal' });
  assert.equal(requests.length, 1);
  assert.equal(trace.destroys, 1, 'no other view stays on screen under the Fractal label');
  assert.equal(resultOf(page), null);
  assert.deepEqual(recordOf(page).refusal, { code: 'invalid-request', detail: 'domain size 851 outside 1..850' });
  assert.match(statusText(), /proiezione rifiutata \[invalid-request\]: domain size 851 outside 1\.\.850/);
  assert.match(statusText(), /nessuna posizione mostrata/);
  assert.equal(recordOf(page).pending, false);

  refuse = false;
  await page.setAxes({ organization: 'natural' });
  assert.equal(recordOf(page).refusal, null);
  assert.equal(recordOf(page).arrangement, 'network', 'the Natural arrangement returns with Natural');
  assert.equal(recordOf(page).resultDigest, natural.resultDigest, 'the same Natural request yields the same result');
  assert.equal(statusText(), 'Grafo pronto');
  assert.equal(trace.mounts, 2);
});

test('a no-coordinates result of the assembly is shown with its explanation', async () => {
  const index = fractalIndex();
  const snapshot = await snapshotFor(index);
  const registry = new ProjectionRegistry();
  registry.register({
    id: 'fractal', version: fractalProjection.version,
    async project(_snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'fractal'>): Promise<ProjectionResult> {
      const dynamics = certifyFractalDynamics({ communityCount: 2, domainNodeCount: request.domain.nodeIds.length, attestedEdgeCount: 10 });
      if (!dynamics.certified) throw new Error('fixture dynamics must certify');
      return fractalRefusalProjection(snapshot, request, { code: 'invalid-sector-partition', detail: 'invented partition failure' }, dynamics);
    },
  });
  const { page, trace } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  assert.equal(resultOf(page), null);
  assert.equal(trace.destroys, 1);
  assert.equal(recordOf(page).refusal?.code, 'invalid-sector-partition');
  assert.match(statusText(), /rifiutata \[invalid-sector-partition\]/);
});

test('focus on a genuinely lazy level opens it by requestedLevelId on the same host', async () => {
  const { registry, requests } = spyRegistry({ lazyGiant: true });
  const { page, trace } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  assert.deepEqual(recordOf(page).unopenedLevels, [GIANT_LEVEL], 'its children are missing from the result');
  const before = recordOf(page).resultDigest;
  const mounts = trace.mounts, updates = trace.updates.length;
  assert.equal(requests.length, 1);

  // Focus: a node inside a child of the unopened level asks for it.
  trace.pick!({ kind: 'node', id: 'n:a:g1:c05' }, false);
  await until(() => recordOf(page).unopenedLevels.length === 0, 'the level was opened');
  const levelRequests = requests.filter(request => request.requestedLevelId !== undefined);
  assert.equal(levelRequests.length, 1);
  assert.equal(levelRequests[0]!.requestedLevelId, GIANT_LEVEL);
  assert.equal(levelRequests[0]!.domain, requests[0]!.domain, 'the same domain and parameters');
  assert.notEqual(recordOf(page).resultDigest, before, 'the result digest changes with the loaded levels');
  assert.equal(trace.mounts, mounts, 'the level lands on the same host');
  assert.equal(trace.destroys, 1, 'only the Natural host was ever destroyed');
  assert.ok(trace.updates.length > updates);
  for (const visibility of trace.updates.slice(updates))
    assert.ok(visibility.projectionResultDigest === before || visibility.projectionResultDigest === recordOf(page).resultDigest);
  assert.equal(trace.updates.at(-1)!.projectionResultDigest, recordOf(page).resultDigest);
  assert.match(statusText(), /Vista Fractal/);
});

test('a focus outside the lazy level and the far band request no level', async () => {
  const { registry, requests } = spyRegistry({ lazyGiant: true });
  const { page, trace } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  trace.pick!({ kind: 'node', id: 'n:b:p03' }, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requests.filter(request => request.requestedLevelId !== undefined).length, 0);
  assert.deepEqual(recordOf(page).unopenedLevels, [GIANT_LEVEL]);
});

test('the near band opens every lazy level, and a real refusal of the request is disclosed once', async () => {
  const { registry, requests } = spyRegistry({ lazyGiant: true, refuseLevels: true });
  const { page, trace } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  const digest = recordOf(page).resultDigest;
  (page as unknown as { lod: string }).lod = 'near';
  await page.refresh();
  await until(() => recordOf(page).refusedLevels.length === 1, 'the level refusal is recorded');
  const refused = recordOf(page).refusedLevels[0]!;
  assert.equal(refused.levelId, GIANT_LEVEL);
  assert.equal(refused.code, 'invalid-request');
  assert.match(refused.detail, /level not available/);
  assert.match(statusText(), /1 livelli non aperti \[invalid-request\]/);
  assert.equal(recordOf(page).resultDigest, digest, 'the mounted result is untouched');
  assert.equal(trace.destroys, 1);

  await page.setDensity('essential');
  trace.pick!({ kind: 'node', id: 'n:a:g1:c04' }, false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requests.filter(request => request.requestedLevelId !== undefined).length, 1,
    'a refused level is not requested again for the same result');
});

test('against the real assembly a complete result is already open: zoom and focus request nothing and refuse nothing', async () => {
  const { registry, requests } = spyRegistry();
  const { page, trace } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  const result = resultOf(page)!;
  const giant = result.levels.find(level => level.id === GIANT_LEVEL)!;
  assert.equal(giant.loaded, false, 'the giant community is a promise level');
  assert.ok(giant.childLevelIds.every(id => result.levels.find(level => level.id === id)?.loaded === true),
    'whose child levels are all loaded in the same result');
  assert.deepEqual(recordOf(page).unopenedLevels, [], 'so it is not reported as unopened');
  const digest = recordOf(page).resultDigest;

  (page as unknown as { lod: string }).lod = 'near';
  await page.refresh();
  trace.pick!({ kind: 'node', id: 'n:a:g2:c03' }, false);
  trace.pick!({ kind: 'node', id: 'n:a:g1:c04' }, false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(requests.filter(request => request.requestedLevelId !== undefined).length, 0, 'no level request');
  assert.equal(requests.length, 1, 'the whole-domain projection ran once and was cached');
  assert.deepEqual(recordOf(page).refusedLevels, []);
  assert.doesNotMatch(statusText(), /non apert|rifiutat/);
  assert.equal(recordOf(page).resultDigest, digest);
  assert.equal(trace.destroys, 1);

  await assert.rejects(page.loadProjectionLevel(GIANT_LEVEL), /Projection level is already open/);
  assert.equal(requests.filter(request => request.requestedLevelId !== undefined).length, 0);
});

test('isLazyLevel: only a promise with missing or unloaded children is lazy', async () => {
  const { registry } = spyRegistry();
  const { page } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  const complete = resultOf(page)!;
  const giant = complete.levels.find(level => level.id === GIANT_LEVEL)!;
  assert.equal(isLazyLevel(complete, giant), false, 'children present and loaded');
  const missing = { levels: complete.levels.filter(level => level.parentId !== GIANT_LEVEL) };
  assert.equal(isLazyLevel(missing, giant), true, 'children missing');
  const unloaded = { levels: complete.levels.map(level => level.parentId === GIANT_LEVEL && level.loaded
    ? { ...giant, id: level.id, parentId: GIANT_LEVEL, childLevelIds: [] } : level) };
  assert.equal(isLazyLevel(unloaded, giant), true, 'a child that is itself unloaded');
  assert.equal(isLazyLevel(complete, { ...giant, childLevelIds: [] }), true, 'a stub without children');
  const loaded = complete.levels.find(level => level.loaded)!;
  assert.equal(isLazyLevel(complete, loaded), false, 'a loaded level is never lazy');
});

test('a level or camera from another view is refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let gated = false;
  const { registry } = spyRegistry({ lazyGiant: true, gate: () => gated ? gate : undefined });
  const { page } = await typedPage({ registry });
  await page.setAxes({ organization: 'fractal' });
  assert.equal(recordOf(page).cameraKey, '2d/fractal');

  await assert.rejects(page.loadProjectionLevel(GIANT_LEVEL, '2d/natural'), /Stale projection camera/,
    'a camera key read from another view');
  await assert.rejects(page.loadProjectionLevel(GIANT_LEVEL, '3d/fractal'), /Stale projection camera/,
    'a camera key read from another dimension');
  await assert.rejects(page.loadProjectionLevel('fractal:community:n:nowhere'), /not unopened/);

  // A load in flight when the view changes lands nowhere.
  gated = true;
  const load = page.loadProjectionLevel(GIANT_LEVEL, '2d/fractal');
  const outcome = assert.rejects(load, /Stale projection (camera|level token)/);
  await page.setAxes({ organization: 'natural' });
  release();
  await outcome;
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(recordOf(page).organization, 'natural');
  await assert.rejects(page.loadProjectionLevel(GIANT_LEVEL), /Projection level loading unavailable|not unopened/,
    'a Natural result has no such level');
});

test('a camera sample of another view drives no level of detail', async () => {
  const { registry } = spyRegistry();
  const { page, trace } = await typedPage({ registry });
  page.tickZoom();
  const reads = trace.cameraReads;
  assert.ok(reads >= 1, 'a current camera is sampled');
  // The axes name another dimension while the mounted camera still belongs to the previous one.
  const internals = page as unknown as { axes: Record<string, unknown> };
  internals.axes = { ...internals.axes, projection: '3d' };
  page.tickZoom();
  assert.equal(trace.cameraReads, reads, 'the stale camera is not read');
});

test('fractalRefusalOf recognises only the assembly refusal', () => {
  assert.deepEqual(fractalRefusalOf(new FractalProjectionRefusal('uncertified-dynamics', 'c is not certified')),
    { code: 'uncertified-dynamics', detail: 'c is not certified' });
  assert.equal(fractalRefusalOf(new Error('fractal-projection: invalid-request: looks similar')), null);
  assert.equal(fractalRefusalOf(Object.assign(new Error('x'), { name: 'FractalProjectionRefusal' })), null, 'a refusal without a code is not one');
  assert.equal(fractalRefusalOf('invalid-request'), null);
});

/** A minimal product view: the Natural pipeline-off path of the page. */
function offPage(fractalInput?: ProjectionPipelineInput, legacyIndra = false) {
  const counts = { mounts: 0, destroys: 0, axes: [] as string[] };
  const createView: CreateProductView = async input => {
    counts.mounts++;
    counts.axes.push(input.axes.organization);
    const camera = { ratio: 1 };
    return {
      destroy() { counts.destroys++; },
      readCamera: () => ({ ...camera }), restoreCamera() {}, async fit() {}, async resetCamera() {}, async frame() {},
      select() {}, setEmphasis() {}, setInsets() {}, setFlowMotion() {},
      async setAxes() {}, async setVisible() {}, async setAppearance() {}, async setPalette() {},
      viewPreset() {}, camera: () => null,
      witness: () => ({ axes: {}, cameraKind: 'orthographic', visibleRect: { left: 0, top: 0, width: 800, height: 600 },
        nodeViewport: {}, positions: {}, selected: null, emphasised: [], windows: [], labels: [],
        depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: 'v2-layout', palette: 'bw' }),
    } as unknown as ProductView;
  };
  const page: V2Page = new Page(MANIFEST, fractalIndex(), AXES, APPEARANCE, PALETTE, {}, 'complete',
    { createView, ...(legacyIndra ? { legacyIndra } : {}), ...(fractalInput ? { fractalPipeline: fractalInput } : {}) });
  page.history.expand('n:a:g1');
  page.history.expand('n:a:g2');
  return { page, counts };
}

test('Natural without the typed pipeline is unchanged: the product view, no projection record', async () => {
  // Indra draws through the product view here only as the explicit legacy rollback (`#indra=legacy`).
  const { page, counts } = offPage(undefined, true);
  await page.refresh();
  assert.equal(counts.mounts, 1);
  assert.deepEqual(counts.axes, ['natural']);
  assert.equal('projection' in (page.witness() as object), false, 'no typed record without the flag');
  await page.setAxes({ organization: 'indra' });
  assert.deepEqual(counts.axes, ['natural', 'indra']);
  assert.equal('projection' in (page.witness() as object), false);
  assert.equal(page.supportsOrganization('fractal'), true);
});

test('a page without the typed pipeline serves Fractal through it and returns to the product view for Natural', async () => {
  const index = fractalIndex();
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], destroys: 0, ratio: 1, cameraReads: 0, dimensions: [], pick: null };
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick() {}, onHover() {},
      mount() { trace.mounts++; }, updateVisibleSubset(_styled, visibility) { trace.updates.push(visibility); },
      readCameraState: () => ({ ratio: 1 }), destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show() {} },
  };
  const { page, counts } = offPage(input);
  await page.refresh();
  assert.equal(counts.mounts, 1);
  assert.equal(counts.destroys, 0);

  await page.setAxes({ organization: 'fractal' });
  assert.equal(trace.mounts, 1, 'Fractal is drawn by the typed renderer');
  assert.equal(counts.destroys, 1, 'the product view it replaces is retired once the typed renderer is up');
  assert.equal(recordOf(page).algorithm, 'fractal');
  assert.equal(recordOf(page).cameraKey, '2d/fractal');
  assert.match(statusText(), /Vista Fractal/);

  await page.setAxes({ organization: 'natural' });
  assert.equal(trace.destroys, 1, 'the typed renderer is retired');
  assert.equal(counts.mounts, 2, 'Natural is drawn by the product view again');
  assert.deepEqual(counts.axes, ['natural', 'natural']);
  assert.equal(resultOf(page), null);
  assert.equal('projection' in (page.witness() as object), false, 'Natural without the flag reports no typed record');
  assert.equal(statusText(), 'Grafo pronto');
});
