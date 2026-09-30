import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { ProjectionRegistry } from '../../src/projection/registry.ts';
import { fractalProjection } from '../../src/projection/fractal.ts';
import { holographicProjection } from '../../src/projection/holographic.ts';
import { indrasPearlsProjection } from '../../src/projection/indra.ts';
import { createProjectionWorkerClient } from '../../src/projection/worker-client.ts';
import type { ProjectionClientRequest, ProjectionWorkerClient } from '../../src/projection/worker-client.ts';
import type { PickResult, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection, VisualRelation } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';
import type { ProductView, CreateProductView } from '../../src/review/view-contract.ts';

/**
 * D-073 H1: a selection that does not come from a canvas pick (`select(id)`, which search results, lists and
 * the D-072 flows use) reaches the typed explanation the way a pick does, in every typed view: a node the
 * result draws opens its explanation card with provenance apart and the source card below, the typed renderer
 * emphasises it without a camera refit, and a node outside the analytical domain says so. Also the exact
 * count of available arcs. The page module is esbuild-bundled once.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/h2-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'h2-page-entry.ts', loader: 'ts',
    contents: `export { V2Page, availableVisualRelationCount, projectionExplainsPick } from ${JSON.stringify(fileURLToPath(pageSource))};`,
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
const fetched: string[] = [];
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  fetched.push(url);
  return { ok: true, status: 200, json: async () => ({ detail: {} }) };
};
const { V2Page: Page, availableVisualRelationCount } =
  (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-h2-fixture', counts: {}, limits: {} };
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

type Trace = { mounts: number; updates: RenderVisibility[]; styles: StyledProjection[]; destroys: number; ratio: number;
  pick: ((pick: PickResult | null, shiftKey: boolean) => void) | null };

async function typedPage(options: { axes?: Record<string, unknown>; index?: V2Index; expand?: boolean; experimental?: string } = {}) {
  const index = options.index ?? indraIndex();
  const organization = options.axes?.organization;
  (globalThis as any).location = {
    search: '', hash: options.experimental ? `#experimental=${options.experimental}` : organization === 'indra' ? '#experimental=indra-pearls&indra=pearls' : organization === 'fractal' ? '#experimental=fractal' : '',
  };
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], styles: [], destroys: 0, ratio: 1, pick: null };
  let pageRef: V2Page | null = null;
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick(handler) { trace.pick = handler; }, onHover() {},
      mount(styled) { trace.mounts++; trace.styles.push(styled); },
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
  const client = createProjectionWorkerClient({ fallbackProjections: [fractalProjection, indrasPearlsProjection, holographicProjection] });
  const page: V2Page = new Page(MANIFEST, index, { ...AXES, ...options.axes } as never, APPEARANCE, PALETTE, {}, 'complete',
    { projectionPipeline: input, projectionWorker: client });
  pageRef = page;
  if (options.expand !== false) for (const item of index.nodes) if (item.level === 2) page.history.expand(item.id);
  await page.refresh();
  return { page, trace, snapshot, index };
}

const internals = (page: V2Page) => page as unknown as { projectionResult: ProjectionResult | null; typedSelection: PickResult | null; selected: string | null };
const resultOf = (page: V2Page) => internals(page).projectionResult;
const textOf = (element: FakeElement | { text?: string }): string => {
  const item = element as FakeElement;
  return [item.textContent ?? '', (element as { text?: string }).text ?? '', ...(item.children ?? []).map(textOf)].join(' ');
};
const findAll = (root: FakeElement, test: (item: FakeElement) => boolean): FakeElement[] =>
  [root, ...(root.children ?? []).flatMap(child => findAll(child, test))].filter(item => item.id !== undefined && test(item));

test('only the comma-listed experimental organization projections are exposed by the page registry', async () => {
  const off = await typedPage({ axes: { organization: 'natural' } });
  const offIds = (off.page as unknown as { projectionRegistry: ProjectionRegistry }).projectionRegistry.ids();
  assert.equal(offIds.includes('indras-pearls'), false, 'pearls are not registered without their flag');
  assert.equal(off.page.supportsOrganization('fractal'), false);
  const enabled = await typedPage({ axes: { organization: 'natural' }, experimental: 'indra-pearls,fractal,holographic' });
  const enabledIds = (enabled.page as unknown as { projectionRegistry: ProjectionRegistry }).projectionRegistry.ids();
  assert.equal(enabledIds.includes('indras-pearls'), true);
  assert.equal(enabled.page.supportsOrganization('indra'), true, 'the ordinary organization still has its primary adapter');
  assert.equal(enabled.page.supportsOrganization('fractal'), true);
  assert.equal(enabled.page.supportsOrganization('holographic'), true);
});
const byId = (id: string): FakeElement | null => findAll(elements.get('details')!, item => item.id === id)[0] ?? null;
const byClass = (name: string): FakeElement[] => findAll(elements.get('details')!, item => (item.className ?? '').split(' ').includes(name));
const cards = () => byClass('selection-card');

const HIDDEN_INDRA_LEAF = 'n:a:01:01';
const emphasised = (trace: Trace, id: string) => trace.styles.at(-1)!.nodeStyle[id];
const plain = { color: '#333333', size: 4 };
const selectionCard = (details: FakeElement) => findAll(details, item => item.className === 'selection-card');
const provenanceIds = (card: FakeElement): string[] =>
  findAll(card, item => item.className === 'projection-source-link').map(item => item.textContent);

test('the available arcs are the visual relations with both endpoints available, exactly', () => {
  const relation = (visualId: string, source: string, target: string) =>
    ({ visualId, source, target, kind: 'co-membership', semantic: false, underlyingEdgeIds: [], count: 1, explanationId: visualId }) as unknown as VisualRelation;
  const result = { domainNodeIds: ['a', 'b', 'c'], visualRelations: [relation('r1', 'a', 'b'), relation('r2', 'b', 'c'),
    relation('r3', 'a', 'outside'), relation('r4', 'ghost', 'c'), relation('r5', 'ghost', 'outside')] };
  assert.equal(availableVisualRelationCount(result), 2, 'a relation with an endpoint outside the domain is not available');
  assert.equal(availableVisualRelationCount({ ...result, visualRelations: [] }), 0);
  assert.equal(availableVisualRelationCount({ ...result, domainNodeIds: [] }), 0);
  assert.equal(result.visualRelations.length, 5, 'the old upper bound was the whole list');
});

test('the typed witness counts the arcs of a mounted result exactly and never above the available count', async () => {
  const { page } = await typedPage({ axes: { organization: 'indra' } });
  const result = resultOf(page)!;
  assert.ok(result.visualRelations.length > 0, 'the fixture has lifted routes');
  const lod = page.witness().lod;
  assert.equal(lod.arcs.available, availableVisualRelationCount(result));
  assert.equal(lod.arcs.available, result.visualRelations.filter(relation =>
    result.domainNodeIds.includes(relation.source) && result.domainNodeIds.includes(relation.target)).length);
  assert.ok(lod.arcs.rendered <= lod.arcs.available);
  assert.equal(lod.nodes.available, result.domainNodeIds.length, 'the node count is exact in the same way');
  // Every relation of this fixture lies inside the domain, so a hidden node count changes nothing here; the pure test above pins the exclusion.
  assert.equal(lod.arcs.available, result.visualRelations.length);
});

test("Indra's Pearls: selecting a node the result draws opens the explanation card, provenance apart, the source card below, and emphasises the node", async () => {
  const { page, trace } = await typedPage({ axes: { organization: 'indra' } });
  const result = resultOf(page)!;
  const inside = 'n:a:01:04';
  assert.ok(result.loadedNodeIds.includes(inside) && result.explanations[inside]);
  const camera = page.cameraState();
  const { mounts, destroys, updates } = { mounts: trace.mounts, destroys: trace.destroys, updates: trace.updates.length };

  await page.select(inside);
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: inside }, 'the same typed selection a canvas pick makes');
  const cards = selectionCard(elements.get('details')!);
  assert.equal(cards.length, 2, 'the explanation card and the source card, in that order');
  const [explanation, source] = [cards[0]!, cards[1]!];
  assert.match(textOf(explanation), /Nodo · spiegazione della proiezione/);
  assert.match(textOf(explanation), /Collocato nella perla/);
  const provenance = findAll(explanation, item => (item.className ?? '').split(' ').includes('projection-provenance'));
  assert.equal(provenance.length, 1, 'the provenance is a separate section of the explanation card');
  assert.deepEqual(provenanceIds(provenance[0]!), result.explanations[inside]!.sourceIds.slice());
  assert.equal(findAll(source, item => (item.className ?? '').split(' ').includes('projection-provenance')).length, 0);
  assert.match(textOf(source), new RegExp(`Titolo ${inside}`));
  assert.match(textOf(source), /Relazioni/);
  assert.equal(elements.get('details')!.children.some(child => child.id === 'projection-outside-domain'), false);
  assert.equal(byId('projection-outside-domain'), null);

  assert.deepEqual(emphasised(trace, inside), { color: '#ffffff', size: 6.4 }, 'the selected node is brighter and larger');
  const other = result.loadedNodeIds.find(id => id !== inside)!;
  assert.deepEqual(emphasised(trace, other), plain, 'nothing else changes');
  assert.equal(trace.mounts, mounts, 'the same host');
  assert.equal(trace.destroys, destroys);
  assert.ok(trace.updates.length > updates, 'the mask revision carried the emphasis');
  assert.deepEqual(page.cameraState(), camera, 'no camera refit');
  assert.equal(trace.ratio, 1);
  assert.equal(resultOf(page)!.determinism.resultDigest, result.determinism.resultDigest, 'the emphasis is presentation, not part of the result');

  // Selecting another node replaces both the card and the emphasis; the earlier node is plain again.
  await page.select('n:b:01:01');
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: 'n:b:01:01' });
  assert.match(textOf(selectionCard(elements.get('details')!)[0]!), /Nodo · spiegazione della proiezione/);
  assert.deepEqual(emphasised(trace, inside), plain);
  assert.deepEqual(emphasised(trace, 'n:b:01:01'), { color: '#ffffff', size: 6.4 });
});

test("Indra's Pearls: a node outside the analytical domain says so instead of doing nothing", async () => {
  const { page, trace } = await typedPage({ axes: { organization: 'indra' }, expand: false });
  const result = resultOf(page)!;
  assert.equal(result.loadedNodeIds.includes(HIDDEN_INDRA_LEAF), false, 'not disclosed, so not in the domain');
  assert.equal(result.domainNodeIds.includes(HIDDEN_INDRA_LEAF), false);
  const updates = trace.updates.length;
  await page.select(HIDDEN_INDRA_LEAF);
  assert.equal(internals(page).typedSelection, null);
  const note = byId('projection-outside-domain')!;
  assert.ok(note, 'the panel says why nothing is explained');
  assert.equal(note.attrs.role, 'status');
  assert.match(note.textContent, /fuori dal dominio analitico di questa vista \(\d+ nodi\)/);
  assert.match(note.textContent, /nessuna spiegazione della proiezione/);
  assert.equal(selectionCard(elements.get('details')!).length, 1, 'only the source card of the node is shown');
  assert.match(textOf(selectionCard(elements.get('details')!)[0]!), new RegExp(`Titolo ${HIDDEN_INDRA_LEAF}`));
  assert.equal(byClass('projection-provenance').length, 0);
  for (const style of Object.values(trace.styles.at(-1)!.nodeStyle)) assert.deepEqual(style, plain, 'no node is emphasised');
  assert.ok(trace.updates.length >= updates);
});

test('Fractal: selecting a node the result draws opens its explanation card with provenance apart; an undisclosed node says so', async () => {
  const { page, trace } = await typedPage({ axes: { organization: 'fractal' }, index: fractalIndex(), expand: false });
  const result = resultOf(page)!;
  for (const inside of ['n:a', 'n:b:p03']) {
    assert.ok(result.loadedNodeIds.includes(inside) && result.explanations[inside], inside);
    await page.select(inside);
    assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: inside }, inside);
    const cards = selectionCard(elements.get('details')!);
    assert.equal(cards.length, 2, `${inside}: explanation card, then source card`);
    assert.match(textOf(cards[0]!), /Coordinata esterna di F_c\(z\)=z\^2\+c/);
    const provenance = findAll(cards[0]!, item => (item.className ?? '').split(' ').includes('projection-provenance'));
    assert.equal(provenance.length, 1, `${inside}: provenance in its own section`);
    assert.deepEqual(provenanceIds(provenance[0]!), result.explanations[inside]!.sourceIds.slice());
    assert.match(textOf(cards[1]!), new RegExp(`Titolo ${inside}`));
    assert.deepEqual(emphasised(trace, inside), { color: '#ffffff', size: 6.4 });
  }
  assert.equal(trace.mounts, 1, 'the Fractal host was never remounted by a selection');
  const outside = 'n:a:g1:c05';
  assert.equal(result.domainNodeIds.includes(outside), false);
  await page.select(outside);
  assert.equal(internals(page).typedSelection, null);
  assert.match(byId('projection-outside-domain')!.textContent, /fuori dal dominio analitico di questa vista \(20 nodi\)/);
  assert.equal(byClass('projection-provenance').length, 0);
  assert.equal(selectionCard(elements.get('details')!).length, 1);
});

test('a selection replaces the earlier canvas pick, and selecting the same node again leaves no card behind', async () => {
  const { page, trace } = await typedPage({ axes: { organization: 'indra' } });
  const container = resultOf(page)!.containers[0]!.visualId;
  trace.pick!({ kind: 'container', visualId: container }, false);
  assert.deepEqual(internals(page).typedSelection, { kind: 'container', visualId: container });
  assert.match(textOf(elements.get('details')!), /Contenitore derivato/);

  await page.select('n:c:01:01');
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: 'n:c:01:01' }, 'the pick no longer describes the selection');
  assert.doesNotMatch(textOf(selectionCard(elements.get('details')!)[0]!), /Contenitore derivato/);

  await page.select('n:c:01:01');
  assert.equal(internals(page).selected, null, 'selecting the same node again leaves the focus');
  assert.equal(internals(page).typedSelection, null);
  assert.equal(selectionCard(elements.get('details')!).length, 0, 'no stale explanation card');
  assert.deepEqual(emphasised(trace, 'n:c:01:01'), plain);
});

test('Natural through the typed pipeline: the selected node is emphasised, its source card stays, an outside node says so', async () => {
  const { page, trace } = await typedPage({ expand: false });
  const result = resultOf(page)!;
  assert.equal(result.determinism.algorithmId, 'natural');
  const inside = result.loadedNodeIds[3]!;
  await page.select(inside);
  assert.deepEqual(internals(page).typedSelection, { kind: 'node', id: inside });
  assert.equal(selectionCard(elements.get('details')!).length, 1, 'Natural explains no node: the source card is the card');
  assert.match(textOf(selectionCard(elements.get('details')!)[0]!), new RegExp(`Titolo ${inside}`));
  assert.deepEqual(emphasised(trace, inside), { color: '#ffffff', size: 6.4 });
  assert.equal(byId('projection-outside-domain'), null);

  await page.select(HIDDEN_INDRA_LEAF);
  assert.match(byId('projection-outside-domain')!.textContent, /fuori dal dominio analitico/);
  assert.deepEqual(emphasised(trace, inside), plain, 'the earlier node is no longer emphasised');
});

test('the Natural page without the typed pipeline selects exactly as before: no typed selection, no notice, no emphasis', async () => {
  const index = indraIndex();
  const selected: (string | null)[] = [];
  const createView: CreateProductView = async () => ({
    destroy() {}, readCamera: () => null, async fit() {}, async resetCamera() {}, async frame() {},
    select(id: string | null) { selected.push(id); }, setEmphasis() {}, setInsets() {}, setFlowMotion() {}, async setAxes() {},
    async setVisible() {}, async setAppearance() {}, async setPalette() {}, viewPreset() {},
    camera: () => null, witness: () => ({ axes: {}, visibleRect: { left: 0, top: 0, width: 800, height: 600 },
      nodeViewport: {}, labels: [] }),
  }) as unknown as ProductView;
  const page: V2Page = new Page(MANIFEST, index, AXES as never, APPEARANCE, PALETTE, {}, 'complete', { createView });
  for (const item of index.nodes) if (item.level === 2) page.history.expand(item.id);
  await page.refresh();
  await page.select('n:a:01:04');
  await page.select(HIDDEN_INDRA_LEAF);
  assert.equal(internals(page).typedSelection, null);
  assert.deepEqual([...new Set(selected.filter(id => id !== null))], ['n:a:01:04', HIDDEN_INDRA_LEAF], 'the product view is told, as before');
  assert.equal(byId('projection-outside-domain'), null);
  assert.equal(byClass('projection-provenance').length, 0);
  assert.equal(page.witness().projection, undefined, 'no typed witness without the pipeline');
});

test('a relation with an endpoint outside the domain is not counted as an available arc', async () => {
  (globalThis as any).location = { search: '', hash: '#experimental=indra-pearls&indra=pearls' };
  const index = indraIndex();
  const snapshot = await snapshotFor(index);
  // An assembly that hands the page one relation more than the domain can carry (an endpoint the domain does not hold).
  const registry = new ProjectionRegistry();
  registry.register({ id: 'indras-pearls', version: 'rogue-relation-fixture', async project(snap: SemanticGraphSnapshot, request: never) {
    const real = await indrasPearlsProjection.project(snap, request);
    const rogue = { ...real.visualRelations[0]!, visualId: 'visual:rogue', target: 'ghost-node', explanationId: 'visual:rogue' };
    return { ...real, visualRelations: [...real.visualRelations, rogue] };
  } } as never);
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (_host, dimension): ProjectionPageRenderer => ({
      dimension, onPick() {}, onHover() {}, mount() {}, updateVisibleSubset() {}, readCameraState: () => ({ ratio: 1 }), destroy() {},
    }),
    style: result => ({ projection: result, edgeStyle: {}, visualStyle: {}, nodeStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show() {} },
  };
  const page: V2Page = new Page(MANIFEST, index, { ...AXES, organization: 'indra' } as never, APPEARANCE, PALETTE, {}, 'complete',
    { projectionPipeline: input, projectionRegistry: registry });
  for (const item of index.nodes) if (item.level === 2) page.history.expand(item.id);
  await page.refresh();
  const result = resultOf(page)!;
  assert.ok(result.visualRelations.some(relation => relation.visualId === 'visual:rogue'), 'the result carries the extra relation');
  const arcs = page.witness().lod.arcs;
  assert.equal(arcs.available, result.visualRelations.length - 1, 'exact: the relation with a missing endpoint is not available');
  assert.equal(arcs.available, availableVisualRelationCount(result));
  assert.ok(arcs.rendered <= arcs.available);
});
