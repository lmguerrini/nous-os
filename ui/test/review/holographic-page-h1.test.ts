import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { fractalProjection } from '../../src/projection/fractal.ts';
import { holographicProjection } from '../../src/projection/holographic.ts';
import { indrasPearlsProjection } from '../../src/projection/indra.ts';
import { buildProjectionExplanationPanel } from '../../src/review/panel-view.ts';
import { createProjectionWorkerClient } from '../../src/projection/worker-client.ts';
import type { ProjectionClientRequest, ProjectionWorkerClient } from '../../src/projection/worker-client.ts';
import type { PickResult, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';
import { syntheticKnowledgeGraph } from '../holographic/projection-fixtures.ts';

/**
 * D-073 H1: Holographic as an experimental view on the organization axis. The page requests the
 * approved parameters through the projection client (worker or main-thread fallback), discloses the
 * spectral coordinates, the absence of a topology claim and the error-model headline, discloses a
 * typed `no-coordinates` refusal with its code while the position-free fields stay explained, routes
 * picks to the explanation card of the result with provenance apart, and offers a compact channel /
 * region / focus control in the details column. The page module is esbuild-bundled once.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/h1-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'h1-page-entry.ts', loader: 'ts',
    contents: `export { V2Page, holographicPageParameters, holographicDisclosureLine, holographicErrorHeadline, holographicChannelsOf, holographicRegionsOf, holographicRegionMembers, projectionExplainsPick } from ${JSON.stringify(fileURLToPath(pageSource))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

type FakeElement = {
  children: FakeElement[]; style: Record<string, string>; dataset: Record<string, string>;
  attrs: Record<string, string>; textContent: string; hidden: boolean; className: string; id: string;
  disabled: boolean; title: string; value: string; onclick: null | (() => void); onchange: null | (() => void);
  listeners: Map<string, () => void>;
  append(...items: FakeElement[]): void; replaceChildren(...items: FakeElement[]): void;
  prepend(...items: FakeElement[]): void; remove(): void; addEventListener(type: string, listener: () => void): void;
  setAttribute(name: string, value: string): void; toggleAttribute(name: string, force?: boolean): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};
const fakeElement = (): FakeElement => {
  const el: FakeElement = {
    children: [], style: {}, dataset: {}, attrs: {}, textContent: '', hidden: false, className: '', id: '',
    disabled: false, title: '', value: '', onclick: null, onchange: null, listeners: new Map(),
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
/** `select` reads the source detail of a node; the review server answers with the detail row, here an empty one. */
(globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({ detail: {} }) });
const { V2Page: Page, holographicPageParameters, holographicDisclosureLine, holographicErrorHeadline, holographicChannelsOf,
  holographicRegionsOf, holographicRegionMembers, projectionExplainsPick } =
  (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-h1-fixture', counts: {}, limits: {} };
const AXES = { projection: '2d' as const, morphology: 'stellar' as const, organization: 'natural' as const,
  colour: 'bw' as const, labels: true, reading: 'attested' as const };
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#ffffff', hover: '#ffffff', container: '#ebebeb', text: '#e8e8e8' };

const node = (id: string, level: 1 | 2 | 3, parent: string | null, community: string | null, importance: number): V2Node => ({
  id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation',
  parent, parents: parent ? [parent] : [], domains: community === null ? [] : [community],
  title: `Titolo ${id}`, display_label: `Titolo ${id}`, title_full: `Titolo ${id}`,
  importance: { value: importance, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const edge = (id: string, source: string, target: string) =>
  ({ id, source, target, class: 'attested' as const, type: 'relates', directed: false, evidence: [] });

/** 36 invented nodes in three source communities: each community's first node is a level-1 root, the rest its level-2
 * children; two hidden level-3 children lie outside the disclosed domain. */
const HIDDEN_CHILD = 'hidden:child:1';
function communityIndex(): V2Index {
  const graph = syntheticKnowledgeGraph(36, 3, 'h1-page');
  const roots = new Map<string, string>();
  const nodes: V2Node[] = [];
  for (const item of graph.nodes) {
    const community = item.community!;
    if (!roots.has(community)) roots.set(community, item.id);
    nodes.push(node(item.id, roots.get(community) === item.id ? 1 : 2, roots.get(community) === item.id ? null : roots.get(community)!,
      community, item.importance));
  }
  nodes.push(node(HIDDEN_CHILD, 3, 'k0003', 'c00', 0.4), node('hidden:child:2', 3, 'k0004', 'c01', 0.5));
  return { nodes, edges: graph.edges.map(item => edge(item.id, item.source, item.target)) };
}
/** A ring of twelve nodes: the doubled first eigenvalue is a tie that 3D refuses and 2D resolves. */
function ringIndex(): V2Index {
  const ids = Array.from({ length: 12 }, (_unused, index) => `r${String(index).padStart(2, '0')}`);
  return {
    nodes: ids.map((id, index) => node(id, 1, null, 'ring', 0.1 + (index % 7) * 0.11)),
    edges: ids.map((id, index) => edge(`ring:${index}`, id, ids[(index + 1) % ids.length]!)),
  };
}

async function snapshotFor(index: V2Index): Promise<SemanticGraphSnapshot> {
  return createSemanticSnapshot(await normalizeRawLedger({ manifest: MANIFEST,
    index: { schema: 'nousos.review-graph/2', nodes: index.nodes, edges: index.edges } }));
}

type Trace = { mounts: number; updates: RenderVisibility[]; styles: StyledProjection[]; destroys: number; ratio: number;
  dimensions: string[]; pick: ((pick: PickResult | null, shiftKey: boolean) => void) | null };
type SpyClient = ProjectionWorkerClient & { requests: ProjectionClientRequest[] };

/** A client that records every request and answers it with the real main-thread host (the worker fallback). */
function spyClient(): SpyClient {
  const inner = createProjectionWorkerClient({ fallbackProjections: [fractalProjection, indrasPearlsProjection, holographicProjection] });
  const client: SpyClient = {
    requests: [],
    get backend() { return inner.backend; }, get isIdle() { return inner.isIdle; },
    async project(request) { client.requests.push(request); return inner.project(request); },
    cancel: slot => inner.cancel(slot),
    dispose: () => inner.dispose(),
  };
  return client;
}

async function typedPage(options: { axes?: Record<string, unknown>; client?: ProjectionWorkerClient; index?: V2Index } = {}) {
  const index = options.index ?? communityIndex();
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], styles: [], destroys: 0, ratio: 1, dimensions: [], pick: null };
  let pageRef: V2Page | null = null;
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick(handler) { trace.pick = handler; }, onHover() {},
      mount(styled) { trace.mounts++; trace.dimensions.push(dimension); trace.styles.push(styled); },
      updateVisibleSubset(styled, visibility) { trace.updates.push(visibility); trace.styles.push(styled); },
      readCameraState: () => ({ ratio: trace.ratio }),
      destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, edgeStyle: {}, visualStyle: {},
      nodeStyle: Object.fromEntries(result.loadedNodeIds.map(id => [id, { color: '#333333', size: 4 }])) }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show: (host, pick, result, snap, step) =>
      (pageRef as unknown as { buildDefaultPipeline(): ProjectionPipelineInput }).buildDefaultPipeline().panel.show(host, pick, result, snap, step) },
  };
  const deps = { projectionPipeline: input, ...(options.client ? { projectionWorker: options.client } : {}) };
  const page: V2Page = new Page(MANIFEST, index, { ...AXES, ...options.axes } as never, APPEARANCE, PALETTE, {}, 'complete', deps);
  pageRef = page;
  await page.refresh();
  return { page, trace, snapshot, input, index };
}

type ProjectionRecord = { enabled: boolean; resultDigest: string | null; algorithm: string | null; organization: string;
  cameraKey: string | null; pending: boolean; refusal: { code: string; detail: string } | null;
  holographic: { channel: string | null; region: string | null; focus: boolean; channels: string[]; regions: string[];
    coordinatesRefused: boolean; drawnFieldIds: string[] } | null };
const recordOf = (page: V2Page) => (page.witness() as unknown as { projection: ProjectionRecord }).projection;
const internals = (page: V2Page) => page as unknown as { projectionResult: ProjectionResult | null; typedSelection: PickResult | null;
  selected: string | null; holographicRefused: unknown };
const resultOf = (page: V2Page) => internals(page).projectionResult;
const statusText = () => elements.get('status')!.textContent;
const textOf = (element: FakeElement | { text?: string }): string => {
  const item = element as FakeElement;
  return [item.textContent ?? '', (element as { text?: string }).text ?? '', ...(item.children ?? []).map(textOf)].join(' ');
};
const findAll = (root: FakeElement, test: (item: FakeElement) => boolean): FakeElement[] =>
  [root, ...(root.children ?? []).flatMap(child => findAll(child, test))].filter(item => item.id !== undefined && test(item));
const byId = (id: string): FakeElement | null => findAll(elements.get('details')!, item => item.id === id)[0] ?? null;
const byClass = (name: string): FakeElement[] => findAll(elements.get('details')!, item => (item.className ?? '').split(' ').includes(name));
const tableOf = (root: FakeElement): Record<string, string> => {
  const rows = findAll(root, item => item.children.length === 2 && item.children[0]!.textContent !== '' && item.children[1]!.textContent !== '');
  return Object.fromEntries(rows.map(row => [row.children[0]!.textContent, row.children[1]!.textContent]));
};
const change = async (select: FakeElement, value: string) => {
  select.value = value;
  select.onchange!();
  await new Promise(resolve => setTimeout(resolve, 20));
};
const SIGNAL = 'visual:holographic:signal:importance';
const HEAT = 'visual:holographic:heat:1';

test('the approved parameters follow k = min(24, n - 1) and r = min(n, max(2k + 8, 64))', () => {
  assert.deepEqual(holographicPageParameters(36, '2d'), { dimension: '2d', modes: 24, restartSize: 36, maxRestarts: 8, eigenTolerance: 1e-8,
    eigenspacePolicyVersion: 'projector-probe-v1', heatTimes: [0.5, 2], ridge: 0, signalId: 'importance' });
  assert.deepEqual(holographicPageParameters(850, '3d'), { dimension: '3d', modes: 24, restartSize: 64, maxRestarts: 8, eigenTolerance: 1e-8,
    eigenspacePolicyVersion: 'projector-probe-v1', heatTimes: [0.5, 2], ridge: 0, signalId: 'importance' });
  assert.deepEqual([holographicPageParameters(2, '2d').modes, holographicPageParameters(2, '2d').restartSize], [1, 2]);
  assert.deepEqual([holographicPageParameters(12, '2d').modes, holographicPageParameters(12, '2d').restartSize], [11, 12]);
  assert.deepEqual([holographicPageParameters(100, '2d').modes, holographicPageParameters(100, '2d').restartSize], [24, 64]);
  for (const bad of [1, 0, -3, 2.5, Number.NaN]) assert.throws(() => holographicPageParameters(bad, '2d'), /at least 2 nodes/);
});

test('selecting Holographic requests the approved parameters through the client and discloses the experimental view', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client });
  assert.equal(page.supportsOrganization('holographic'), true, 'the button exists because the projection is registered');
  assert.equal(client.requests.length, 0, 'Natural never touches the client');
  const natural = recordOf(page);

  await page.setAxes({ organization: 'holographic' });
  assert.equal(client.requests.length, 1);
  const request = client.requests[0]!;
  assert.equal(request.projectionId, 'holographic');
  assert.equal(request.slot, 'holographic');
  assert.equal(request.requestedLevelId, undefined);
  assert.deepEqual(request.parameters, { dimension: '2d', modes: 24, restartSize: 36, maxRestarts: 8, eigenTolerance: 1e-8,
    eigenspacePolicyVersion: 'projector-probe-v1', heatTimes: [0.5, 2], ridge: 0, signalId: 'importance' });
  assert.equal(request.domain.nodeIds.length, 36, 'the disclosed domain is the request domain; the hidden children are outside it');

  const result = resultOf(page)!;
  assert.equal(result.determinism.algorithmId, 'holographic');
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.equal(recordOf(page).organization, 'holographic');
  assert.equal(recordOf(page).cameraKey, '2d/holographic');
  assert.notEqual(recordOf(page).resultDigest, natural.resultDigest);
  assert.equal(trace.mounts, 2, 'another view\'s camera is never reused: a fresh host');
  assert.equal(trace.destroys, 1);

  const status = statusText();
  assert.equal(status, holographicDisclosureLine(result, '2d'));
  assert.match(status, /^Vista Holographic · sperimentale · coordinate spettrali/);
  assert.match(status, /nessuna affermazione topologica/);
  assert.match(status, /geometria derivata, non semantica/);
  assert.match(status, /modello d'errore: \d+ regioni su 3 ricostruite \(\d+ rifiutate\) · \d+ battono la baseline global-mean-v1 · errore relativo mediano/);
  assert.ok(status.includes(` · ${holographicErrorHeadline(result)} · `), 'the headline is the one the diagnostics carry');
  assert.doesNotMatch(status, /3D/);
  assert.equal(elements.get('render-root')!.attrs['aria-busy'], 'false');
});

test('3D requests its own dimension on a fresh camera key and discloses the third spectral coordinate', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client });
  await page.setAxes({ organization: 'holographic' });
  assert.equal(recordOf(page).cameraKey, '2d/holographic');
  await page.setAxes({ projection: '3d' });
  assert.equal(client.requests.at(-1)!.parameters.dimension, '3d');
  assert.equal(recordOf(page).cameraKey, '3d/holographic');
  assert.deepEqual(trace.dimensions.slice(-1), ['3d']);
  const result = resultOf(page)!;
  assert.ok(result.positions3 && !result.positions2, 'exactly the requested dimensional map');
  assert.match(statusText(), /3D: tre coordinate spettrali/);
  // Back to 2D: the 3D camera is not reused.
  await page.setAxes({ projection: '2d' });
  assert.equal(recordOf(page).cameraKey, '2d/holographic');
  assert.ok(resultOf(page)!.positions2);
  assert.doesNotMatch(statusText(), /3D/);
});

test('a page without an injected client runs Holographic through its own client (the worker fallback lists it)', async () => {
  const { page } = await typedPage();
  await page.setAxes({ organization: 'holographic' });
  assert.equal(resultOf(page)!.determinism.algorithmId, 'holographic');
  assert.equal(recordOf(page).pending, false);
  assert.match(statusText(), /^Vista Holographic · sperimentale/);
});

test('a superseded Holographic request never reaches the screen', async () => {
  const client = spyClient();
  const { page } = await typedPage({ client });
  const toHolographic = page.setAxes({ organization: 'holographic' });
  const backToNatural = page.setAxes({ organization: 'natural' });
  await Promise.all([toHolographic, backToNatural]);
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(recordOf(page).pending, false);
  assert.equal(recordOf(page).holographic, null);
});

test('the field channel control draws one channel at a time on the same host, without a new projection', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const channels = holographicChannelsOf(result);
  assert.deepEqual(channels.map(item => item.id), [SIGNAL, 'visual:holographic:heat:0', HEAT]);
  assert.deepEqual(channels.map(item => item.label), ['Segnale misurato · importance', 'Calore diffuso · t=0.5', 'Calore diffuso · t=2']);
  const select = byId('holographic-channel')!;
  assert.ok(select, 'the control is in the details column');
  assert.deepEqual(select.children.map(option => option.value), channels.map(item => item.id));
  assert.equal(select.value, SIGNAL, 'the first channel is drawn by default');
  assert.deepEqual(recordOf(page).holographic!.drawnFieldIds, [SIGNAL]);

  const requests = client.requests.length, mounts = trace.mounts, updates = trace.updates.length;
  await change(select, HEAT);
  assert.equal(client.requests.length, requests, 'a channel is a mask, not a projection');
  assert.equal(trace.mounts, mounts, 'the same host and camera');
  assert.equal(trace.destroys, 0);
  assert.equal(trace.updates.length, updates + 1);
  assert.deepEqual([...trace.updates.at(-1)!.fieldIds], [HEAT]);
  assert.deepEqual(recordOf(page).holographic!.drawnFieldIds, [HEAT]);
  assert.equal(trace.updates.at(-1)!.projectionResultDigest, result.determinism.resultDigest);
  assert.equal(byId('holographic-channel')!.value, HEAT, 'the panel keeps the choice');
  assert.match(statusText(), /^Vista Holographic · sperimentale/);

  // A choice the result no longer offers falls back to the first channel.
  (page as unknown as { holographicChannel: string | null }).holographicChannel = 'visual:holographic:heat:9';
  await page.refresh();
  assert.deepEqual(recordOf(page).holographic!.drawnFieldIds, [SIGNAL]);
});

test('the region control shows the reconstruction witness of the chosen region with provenance apart', async () => {
  const { page } = await typedPage({ axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const regions = holographicRegionsOf(result);
  assert.deepEqual(regions, ['c00', 'c01', 'c02'], 'one witness per source community, in codepoint order');
  const select = byId('holographic-region')!;
  assert.deepEqual(select.children.map(option => option.value), regions);
  assert.equal(select.value, 'c00');

  const card = () => byId('holographic-witness')!;
  assert.ok(card(), 'the witness card is shown for the default region');
  assert.match(textOf(card()), /Region c00 \(community, 12 sampled nodes\)/);
  assert.match(textOf(card()), /Derivato · non attestato/);
  assert.match(textOf(card()), /Sperimentale/);
  assert.match(textOf(card()), /No topology claim is made/);
  const provenance = findAll(card(), item => (item.className ?? '').split(' ').includes('projection-provenance'));
  assert.equal(provenance.length, 1, 'the region provenance is its own section');
  assert.deepEqual(findAll(provenance[0]!, item => item.className === 'projection-source-link').map(item => item.textContent), ['c00']);
  assert.match(textOf(provenance[0]!), /separati dalla geometria visuale/);
  assert.doesNotMatch(textOf(card()), /Sintesi[^]*Relazioni/, 'no source-edge card fragments');

  await change(select, 'c02');
  assert.equal(recordOf(page).holographic!.region, 'c02');
  assert.match(textOf(card()), /Region c02 \(community, 12 sampled nodes\)/);
  assert.doesNotMatch(textOf(card()), /Region c00/);
  assert.equal(byId('holographic-region')!.value, 'c02');
});

test('focus on a region draws only its members, keeps the host, and can be left', async () => {
  const client = spyClient();
  const { page, trace, snapshot } = await typedPage({ client, axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const members = holographicRegionMembers(result, snapshot, 'c01')!;
  assert.equal(members.size, 12);
  assert.ok([...members].every(id => snapshot.nodes.find(item => item.id === id)!.communityIds.includes('c01')));
  assert.equal(holographicRegionMembers(result, snapshot, 'nowhere'), null);
  const button = () => byId('holographic-focus')!;
  assert.equal(button().attrs['aria-pressed'], 'false');
  assert.equal(button().disabled, false);
  assert.equal(trace.updates.length ? trace.updates.at(-1)!.nodeIds.size : 36, 36 - 0, 'all the domain nodes before the focus');

  await change(byId('holographic-region')!, 'c01');
  const requests = client.requests.length, mounts = trace.mounts;
  button().onclick!();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(recordOf(page).holographic!.focus, true);
  assert.deepEqual([...trace.updates.at(-1)!.nodeIds].sort(), [...members].sort(), 'only the region members are drawn');
  for (const id of trace.updates.at(-1)!.semanticEdgeIds) {
    const source = snapshot.edges.find(item => item.id === id)!;
    assert.ok(members.has(source.source) && members.has(source.target), 'a drawn source edge joins two members');
  }
  assert.equal(client.requests.length, requests, 'a focus does not project again');
  assert.equal(trace.mounts, mounts);
  assert.equal(button().attrs['aria-pressed'], 'true');
  assert.equal(resultOf(page)!.determinism.resultDigest, result.determinism.resultDigest, 'the result is untouched');
  assert.equal(page.witness().lod.nodes.available, 36, 'available stays the whole domain');
  assert.equal(page.witness().lod.nodes.rendered, 12);

  button().onclick!();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(recordOf(page).holographic!.focus, false);
  assert.equal(trace.updates.at(-1)!.nodeIds.size, 36, 'leaving the focus draws the whole domain again');
});

test('a typed no-coordinates refusal is disclosed with its code and the position-free fields are still explained', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, index: ringIndex(), axes: { projection: '3d', organization: 'holographic' } });
  assert.equal(client.requests.at(-1)!.parameters.dimension, '3d');
  assert.equal(trace.mounts, 0, 'no drawing under the Holographic label');
  assert.equal(resultOf(page), null);
  const status = statusText();
  assert.match(status, /^Vista Holographic · proiezione rifiutata \[ambiguous-eigenspace\]: /);
  assert.match(status, /nessuna posizione mostrata/);
  assert.match(status, /sperimentale/);
  assert.match(status, /i campi senza posizione restano spiegati/);
  assert.match(status, /modello d'errore: /);
  assert.deepEqual(recordOf(page).refusal!.code, 'ambiguous-eigenspace');
  const held = recordOf(page).holographic!;
  assert.equal(held.coordinatesRefused, true);
  assert.deepEqual(held.drawnFieldIds, []);
  assert.deepEqual(held.channels, [SIGNAL, 'visual:holographic:heat:0', 'visual:holographic:heat:1']);
  assert.deepEqual(held.regions, ['ring']);

  // The refusal is a card of its own: the code, no coordinate claim, apart from any source card.
  const refusal = byId('holographic-refusal')!;
  assert.ok(refusal);
  assert.match(textOf(refusal), /Nessuna coordinata/);
  assert.match(textOf(refusal), /Stato delle coordinate/);
  assert.match(textOf(refusal), /ambiguous-eigenspace · nessuna posizione assegnata/);
  assert.match(textOf(refusal), /No spectral coordinates/);
  // The position-free channel and region witness are explained beside it.
  const channel = byId('holographic-channel-card')!;
  assert.match(textOf(channel), /Measured scalar signal importance/);
  assert.match(textOf(channel), /Derivato · non attestato/);
  assert.doesNotMatch(textOf(channel), /Nessuna coordinata/, 'the channel card explains the channel, not the refusal');
  assert.match(textOf(byId('holographic-witness')!), /Region ring \(community, 12 sampled nodes\)|Region ring \(community, 12 sampled nodes\) refused/);
  // The controls stay, and a channel choice is remembered without any drawing.
  const select = byId('holographic-channel')!;
  await change(select, HEAT);
  assert.match(textOf(byId('holographic-channel-card')!), /Heat-diffused importance at t=2/);
  assert.equal(byId('holographic-focus')!.disabled, true, 'nothing to focus on without positions');
  assert.equal(trace.mounts, 0);

  // 2D of the same graph resolves the tie: the refusal is gone and the view is drawn.
  await page.setAxes({ projection: '2d' });
  assert.equal(resultOf(page)!.determinism.algorithmId, 'holographic');
  assert.equal(recordOf(page).refusal, null);
  assert.equal(recordOf(page).holographic!.coordinatesRefused, false);
  assert.equal(byId('holographic-refusal'), null);
  assert.equal(byId('holographic-channel-card'), null);
  assert.equal(trace.mounts, 1);
});

test('picks of a field open the explanation card; a node keeps its source card and a hidden channel is not pickable', async () => {
  const { page, trace } = await typedPage({ axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const details = elements.get('details')!;
  const cards = () => byClass('selection-card');

  // A pick of a channel that is not the drawn one is ignored.
  trace.pick!({ kind: 'field', visualId: HEAT }, false);
  assert.equal(internals(page).typedSelection, null);
  assert.equal(recordOf(page).holographic!.channel, SIGNAL);

  // A pick of the drawn channel opens its explanation, experimental and non-attested, with no provenance section (no sources).
  trace.pick!({ kind: 'field', visualId: SIGNAL }, false);
  assert.deepEqual(internals(page).typedSelection, { kind: 'field', visualId: SIGNAL });
  const text = textOf(details);
  assert.match(text, /Campo derivato/);
  assert.match(text, /Measured scalar signal importance \(importance\.value\) over the 36 domain nodes/);
  assert.match(text, /Non semantico · non attestato/);
  assert.match(text, /Testimonianza numerica/);
  assert.match(text, /Sperimentale/);
  const table = tableOf(details);
  assert.equal(table.nodeCount, '36');
  assert.equal(table.featureKey, 'importance.value');

  // A node pick: the result explains no node, so the source card opens (as for Natural); no projection explanation card for it.
  const someNode = result.loadedNodeIds[0]!;
  assert.equal(projectionExplainsPick(result, { kind: 'node', id: someNode }), false);
  trace.pick!({ kind: 'node', id: someNode }, false);
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: someNode });
  const last = cards().at(-1)!;
  assert.doesNotMatch(textOf(last), /Spiegazione della proiezione/);
  assert.match(textOf(last), new RegExp(`Titolo ${someNode}`), 'the last card is the source card of the node');
  assert.match(textOf(cards()[0]!), /Region c00/, 'the region witness card stays apart above it');
  assert.equal(projectionExplainsPick(result, { kind: 'field', visualId: SIGNAL }), true);

  // Empty space clears.
  trace.pick!(null, false);
  assert.equal(internals(page).typedSelection, null);
});

test('the explanation panel resolves undrawn analytic elements only when asked, never a hidden pick by accident', async () => {
  const { page } = await typedPage({ axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const visibility = (page as unknown as { projectionVisibility: RenderVisibility }).projectionVisibility;
  const region: PickResult = { kind: 'field', visualId: 'visual:holographic:reconstruction:c00' };
  assert.throws(() => buildProjectionExplanationPanel(region, result, visibility), /Projection pick is not visible/);
  const model = buildProjectionExplanationPanel(region, result, visibility, { undrawn: true });
  assert.equal(model.badge, 'Derivato · non attestato');
  assert.equal(model.projectionExperimental, true);
  assert.equal(model.projectionRefusal, undefined);
  assert.throws(() => buildProjectionExplanationPanel({ kind: 'field', visualId: 'visual:holographic:reconstruction:none' }, result, visibility,
    { undrawn: true }), /Projection explanation is absent/);
  assert.throws(() => buildProjectionExplanationPanel({ kind: 'node', id: result.loadedNodeIds[0]! }, result, visibility, { undrawn: true }),
    /Projection explanation is absent/);
});

test('leaving Holographic retires its controls, and a control of the old panel cannot touch the new view', async () => {
  const client = spyClient();
  const { page, trace } = await typedPage({ client, axes: { organization: 'holographic' } });
  const staleSelect = byId('holographic-channel')!;
  const staleFocus = byId('holographic-focus')!;
  await page.setAxes({ organization: 'natural' });
  assert.equal(recordOf(page).algorithm, 'natural');
  assert.equal(byId('holographic-controls'), null, 'no analytic controls outside the Holographic view');
  assert.equal(byId('holographic-witness'), null);
  assert.equal(recordOf(page).holographic, null);
  const { updates, mounts, requests } = { updates: trace.updates.length, mounts: trace.mounts, requests: client.requests.length };
  await change(staleSelect, HEAT);
  staleFocus.onclick!();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(trace.updates.length, updates, 'the stale control revised no mask on the Natural host');
  assert.equal(trace.mounts, mounts);
  assert.equal(client.requests.length, requests);
  assert.equal(recordOf(page).algorithm, 'natural');
  // Back to Holographic: a new host, the 2D/holographic camera is not the Natural one.
  await page.setAxes({ organization: 'holographic' });
  assert.equal(recordOf(page).cameraKey, '2d/holographic');
  assert.equal(trace.mounts, mounts + 1);
});

test('the projection worker entry serves Holographic under the id the page requests', async () => {
  const { PROJECTION_WORKER_ENTRY_PROJECTIONS } = await import('../../src/projection/worker-entry.ts');
  assert.ok(PROJECTION_WORKER_ENTRY_PROJECTIONS.some(projection => projection.id === 'holographic'));
  assert.equal(holographicProjection.id, 'holographic');
});

test('selecting a node in Holographic emphasises it and keeps the source card; an undisclosed node says so', async () => {
  const { page, trace, snapshot } = await typedPage({ axes: { organization: 'holographic' } });
  const result = resultOf(page)!;
  const inside = 'k0005';
  assert.ok(result.loadedNodeIds.includes(inside));
  assert.equal(result.explanations[inside], undefined, 'the result explains fields and regions, not nodes');
  const { mounts, destroys } = { mounts: trace.mounts, destroys: trace.destroys };
  await page.select(inside);
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: inside });
  const last = byClass('selection-card').at(-1)!;
  assert.match(textOf(last), new RegExp(`Titolo ${inside}`));
  assert.doesNotMatch(textOf(last), /Spiegazione della proiezione/);
  assert.match(textOf(byClass('selection-card')[0]!), /Region c00/, 'the region witness card stays apart above the source card');
  assert.deepEqual(trace.styles.at(-1)!.nodeStyle[inside], { color: '#ffffff', size: 6.4 });
  assert.deepEqual(trace.styles.at(-1)!.nodeStyle['k0006'], { color: '#333333', size: 4 });
  assert.equal(trace.mounts, mounts);
  assert.equal(trace.destroys, destroys);

  assert.equal(result.domainNodeIds.includes(HIDDEN_CHILD), false);
  assert.ok(snapshot.nodes.some(item => item.id === HIDDEN_CHILD));
  await page.select(HIDDEN_CHILD);
  assert.equal(internals(page).typedSelection, null);
  assert.match(byId('projection-outside-domain')!.textContent, /fuori dal dominio analitico di questa vista \(36 nodi\)/);
  assert.deepEqual(trace.styles.at(-1)!.nodeStyle[inside], { color: '#333333', size: 4 });
});
