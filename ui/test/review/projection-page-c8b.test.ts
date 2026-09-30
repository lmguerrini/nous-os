import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { normalizeRawLedger, createSemanticSnapshot } from '../../src/projection/normalize.ts';
import { DENSITY_BUDGETS } from '../../src/review/lod.ts';
import { renderTypedStructuralLegend, STRUCTURAL_CONTROLS_LIMIT, visibleStructuralContainers } from '../../src/review/legend.ts';
import type { PickResult, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, VisualContainer, VisualRelation } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';

/**
 * D-073 C8b: the typed pipeline follows the legacy semantic LOD (level bands with hysteresis and
 * stillness, the density budgets), feeds `witness().lod`, and lists its structural elements in the
 * pick controls. The page module is esbuild-bundled once, as the C4 page tests do.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/c8b-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'c8b-page-entry.ts', loader: 'ts',
    contents: `export { V2Page } from ${JSON.stringify(fileURLToPath(pageSource))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

type FakeElement = {
  children: FakeElement[]; style: Record<string, string>; dataset: Record<string, string>;
  textContent: string; hidden: boolean; className: string; id: string; disabled: boolean; title: string;
  onclick: null | (() => void); listeners: Map<string, () => void>;
  append(...items: FakeElement[]): void; replaceChildren(...items: FakeElement[]): void;
  prepend(...items: FakeElement[]): void; remove(): void; addEventListener(type: string, listener: () => void): void;
  setAttribute(): void; toggleAttribute(): void; getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};
const fakeElement = (): FakeElement => {
  const el: FakeElement = {
    children: [], style: {}, dataset: {}, textContent: '', hidden: false, className: '', id: '', disabled: false,
    title: '', onclick: null, listeners: new Map(),
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    prepend(...items) { this.children.unshift(...items); },
    remove() {}, addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute() {}, toggleAttribute() {},
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
  window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
  HTMLInputElement: class HTMLInputElement {}, HTMLTextAreaElement: class HTMLTextAreaElement {},
  innerWidth: 800, innerHeight: 600,
});
const { V2Page: Page } = (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-c8b-fixture', counts: {}, limits: {} };
const AXES = { projection: '2d' as const, morphology: 'stellar' as const, organization: 'natural' as const,
  colour: 'bw' as const, labels: true, reading: 'attested' as const };
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#ffffff', hover: '#ffffff', container: '#ebebeb', text: '#e8e8e8' };

const node = (id: string, level: 1 | 2 | 3, parent: string | null, domains: string[] = []): V2Node => ({
  id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : 'conversation',
  parent, parents: parent ? [parent] : [], domains, title: id, display_label: id, title_full: id,
  importance: { value: 0.5, components: {} }, size: 0.5,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
/** Two domains, one project, and `conversations` chained conversations; the project starts collapsed. */
function wideIndex(conversations: number): V2Index {
  const nodes: V2Node[] = [node('domain:a', 1, null), node('domain:b', 1, null), node('project:a:0', 2, 'domain:a')];
  for (let i = 0; i < conversations; i++)
    nodes.push(node(`conversation:${String(i).padStart(4, '0')}`, 3, 'project:a:0', i % 10 === 0 ? ['a', 'b'] : ['a']));
  const project = nodes[2]!;
  project.counts = { ...project.counts, children: conversations, descendants: conversations };
  const edges = [];
  for (let i = 1; i < conversations; i++)
    edges.push({ id: `edge-${i}`, source: `conversation:${String(i - 1).padStart(4, '0')}`,
      target: `conversation:${String(i).padStart(4, '0')}`, class: 'attested' as const,
      type: 'related', directed: true, evidence: [] });
  return { nodes, edges };
}

async function snapshotFor(index: V2Index): Promise<SemanticGraphSnapshot> {
  return createSemanticSnapshot(await normalizeRawLedger({ manifest: MANIFEST,
    index: { schema: 'nousos.review-graph/2', nodes: index.nodes, edges: index.edges } }));
}

type Trace = { mounts: number; updates: RenderVisibility[]; destroys: number; ratio: number; panels: PickResult[]; rafs: number };
async function typedPage(index: V2Index, density: 'essential' | 'balanced' | 'complete' = 'complete') {
  const snapshot = await snapshotFor(index);
  const trace: Trace = { mounts: 0, updates: [], destroys: 0, ratio: 1, panels: [], rafs: 0 };
  const camera = { x: 0.5, y: 0.5, angle: 0, get ratio() { return trace.ratio; } };
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: (): ProjectionPageRenderer => ({
      dimension: '2d', onPick() {}, onHover() {},
      mount() { trace.mounts++; },
      updateVisibleSubset(_styled, visibility) { trace.updates.push(visibility); },
      readCameraState: () => camera,
      destroy() { trace.destroys++; },
    }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show(_host, pick) { trace.panels.push(pick); } },
  };
  const page: V2Page = new Page(MANIFEST, index, AXES, APPEARANCE, PALETTE, {}, density, { projectionPipeline: input });
  await page.refresh();
  return { page, trace, snapshot };
}
const lodOf = (page: V2Page) => (page.witness() as unknown as { lod: {
  level: string; density: string;
  nodes: { rendered: number; available: number; pinned: number };
  arcs: { rendered: number; available: number; pinned: number };
  labels: { rendered: number; available: number } } }).lod;
const resultOf = (page: V2Page) => (page as unknown as { projectionResult: ProjectionResult }).projectionResult;
const visibilityOf = (page: V2Page) => (page as unknown as { projectionVisibility: RenderVisibility }).projectionVisibility;

test('the typed witness reports the density budgets and a density change revises in place', async () => {
  const index = wideIndex(300);
  const { page, trace } = await typedPage(index, 'essential');
  await page.expand('project:a:0');
  const essential = lodOf(page);
  assert.equal(essential.density, 'essential');
  assert.equal(essential.nodes.available, 303);
  assert.equal(essential.nodes.rendered, DENSITY_BUDGETS.essential.nodes, 'the essential node budget binds exactly');
  assert.equal(visibilityOf(page).nodeIds.size, essential.nodes.rendered, 'the witness reports the mask that was applied');
  assert.ok(essential.arcs.available > DENSITY_BUDGETS.essential.arcs);
  assert.ok(essential.arcs.rendered <= DENSITY_BUDGETS.essential.arcs + essential.arcs.pinned);
  assert.equal(essential.arcs.rendered, visibilityOf(page).visualRelationIds.size);
  assert.equal(essential.labels.available, 20);
  const before = trace.updates.length;
  const revision = visibilityOf(page).revision;
  const digest = resultOf(page).determinism.resultDigest;

  await page.setDensity('balanced');
  const balanced = lodOf(page);
  assert.equal(balanced.nodes.rendered, 303, 'the balanced budget admits the whole fixture');
  assert.ok(balanced.arcs.rendered > essential.arcs.rendered);
  assert.equal(trace.updates.length, before + 1, 'the density change is one in-place subset revision');
  assert.ok(visibilityOf(page).revision > revision);
  assert.equal(resultOf(page).determinism.resultDigest, digest, 'density never changes the result');
  assert.equal(trace.mounts, 1);
  assert.equal(trace.destroys, 0);
  for (const visibility of trace.updates)
    assert.equal(visibility.projectionResultDigest, digest);
});

test('the typed level follows the lod.ts bands: hysteresis, stillness, one in-place revision per crossing', async () => {
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => clock;
  try {
    const { page, trace } = await typedPage(wideIndex(120), 'complete');
    await page.expand('project:a:0');
    assert.equal(lodOf(page).level, 'far');
    const waitForUpdates = async (count: number) => {
      for (let attempt = 0; attempt < 200 && trace.updates.length < count; attempt++)
        await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(trace.updates.length, count);
    };
    let updates = trace.updates.length;
    const step = (ratio: number, at: number) => { trace.ratio = ratio; clock = at; page.tickZoom(); };

    clock = 2000; page.tickZoom();
    step(1 / 1.5, 2250);
    assert.equal(lodOf(page).level, 'far', 'a magnification inside the far band changes nothing');
    step(1 / 2.5, 2500);
    assert.equal(lodOf(page).level, 'far', 'a crossing observed while the camera still moves is only noted');
    assert.equal(trace.updates.length, updates);
    step(1 / 2.5, 2900);
    await waitForUpdates(++updates);
    assert.equal(lodOf(page).level, 'intermediate');

    step(1 / 1.5, 3300);
    step(1 / 1.5, 3700);
    assert.equal(lodOf(page).level, 'intermediate', 'the hysteresis band absorbs a step back');
    assert.equal(trace.updates.length, updates);
    step(1 / 1.0, 4100);
    step(1 / 1.0, 4500);
    await waitForUpdates(++updates);
    assert.equal(lodOf(page).level, 'far', 'leaving the band below the exit edge lowers the level');

    assert.equal(trace.mounts, 1, 'no remount for a level change');
    assert.equal(trace.destroys, 0);
    const revisions = trace.updates.map(visibility => visibility.revision);
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
    assert.equal(new Set(revisions).size, revisions.length, 'every revision is new');
    assert.equal(trace.ratio, 1, 'the page never wrote the camera');
  } finally { performance.now = realNow; }
});

test('the near level keeps the density node budget and every drawn node keeps its coordinate', async () => {
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => clock;
  try {
    const { page, trace } = await typedPage(wideIndex(300), 'essential');
    await page.expand('project:a:0');
    const far = [...visibilityOf(page).nodeIds];
    clock = 2000; page.tickZoom();
    trace.ratio = 1 / 6; clock = 2100; page.tickZoom();
    clock = 2500; page.tickZoom();
    for (let attempt = 0; attempt < 200 && lodOf(page).level === 'far'; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(lodOf(page).level, 'intermediate');
    clock = 2600; page.tickZoom();
    clock = 3000; page.tickZoom();
    for (let attempt = 0; attempt < 200 && lodOf(page).level !== 'near'; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(lodOf(page).level, 'near');
    const near = lodOf(page);
    assert.equal(near.nodes.rendered, DENSITY_BUDGETS.essential.nodes);
    assert.equal(far.length, DENSITY_BUDGETS.essential.nodes);
    const positions = resultOf(page).positions2!;
    assert.ok([...visibilityOf(page).nodeIds].every(id => positions[id] !== undefined), 'every drawn node keeps its coordinate');
  } finally { performance.now = realNow; }
});

const legendRelation = (visualId: string, kind: VisualRelation['kind'], source = 'a', target = 'b'): VisualRelation => ({
  visualId, kind, semantic: false, source, target, underlyingEdgeIds: [], count: 2, explanationId: visualId });
const legendContainer = (visualId: string): VisualContainer => ({
  visualId, parentVisualId: null, memberCount: 5, shape: 'circle', levelId: 'level' }) as VisualContainer;
const legendProjection = (relations: VisualRelation[], containers: VisualContainer[]) =>
  ({ determinism: { resultDigest: 'digest' }, visualRelations: relations, containers }) as unknown as ProjectionResult;
const legendVisibility = (relations: VisualRelation[], containers: VisualContainer[], digest = 'digest') =>
  ({ projectionResultDigest: digest, visualRelationIds: new Set(relations.map(item => item.visualId)),
    containerIds: new Set(containers.map(item => item.visualId)) }) as unknown as RenderVisibility;
const buttons = (host: FakeElement): FakeElement[] => host.children.flatMap(row => row.children.filter(child => child.dataset.pickKind));

test('structural controls list visible relations and containers and open only structural picks', () => {
  const relations = [legendRelation('visual:relation:co:a:b', 'co-membership'), legendRelation('visual:relation:contains:c', 'synthetic-containment'),
    legendRelation('visual:relation:lift:x', 'lifted-route')];
  const containers = [legendContainer('visual:container:one')];
  const host = fakeElement();
  const picks: unknown[] = [];
  renderTypedStructuralLegend(host as unknown as HTMLElement, legendProjection(relations, containers),
    legendVisibility(relations, containers), pick => picks.push(pick));
  assert.equal(host.hidden, false);
  const list = buttons(host);
  assert.deepEqual(list.map(item => item.dataset.pickKind), ['visual-relation', 'visual-relation', 'container'],
    'the lifted route is a source-edge view and never a structural control');
  for (const item of list) item.listeners.get('click')!();
  assert.deepEqual(picks, [
    { kind: 'visual-relation', visualId: 'visual:relation:co:a:b' },
    { kind: 'visual-relation', visualId: 'visual:relation:contains:c' },
    { kind: 'container', visualId: 'visual:container:one' },
  ]);
});

test('a view without a structural element says so instead of staying hidden', () => {
  const host = fakeElement();
  host.hidden = true;
  const relations = [legendRelation('visual:relation:lift:x', 'lifted-route')];
  renderTypedStructuralLegend(host as unknown as HTMLElement, legendProjection(relations, []), legendVisibility(relations, []));
  assert.equal(host.hidden, false);
  assert.equal(buttons(host).length, 0);
  assert.ok(host.children.some(child => child.dataset.structuralEmpty === 'true' && /Nessun elemento strutturale/.test(child.textContent)));
  const stale = [legendRelation('visual:relation:co:a:b', 'co-membership')];
  const staleHost = fakeElement();
  renderTypedStructuralLegend(staleHost as unknown as HTMLElement, legendProjection(stale, []), legendVisibility(stale, [], 'other'));
  assert.equal(buttons(staleHost).length, 0, 'a mask that belongs to another result lists nothing');
  assert.equal(visibleStructuralContainers(legendProjection([], [legendContainer('c')]), legendVisibility([], [], 'other')).length, 0);
});

test('a long structural list is bounded and counts the rest', () => {
  const relations = Array.from({ length: STRUCTURAL_CONTROLS_LIMIT + 5 }, (_, i) =>
    legendRelation(`visual:relation:contains:${i}`, 'synthetic-containment'));
  const host = fakeElement();
  renderTypedStructuralLegend(host as unknown as HTMLElement, legendProjection(relations, []), legendVisibility(relations, []), () => {});
  assert.equal(buttons(host).length, STRUCTURAL_CONTROLS_LIMIT);
  assert.ok(host.children.some(child => /e altri 5 elementi strutturali/.test(child.textContent)));
});

const controlsOf = (): FakeElement | undefined =>
  elements.get('details')!.children.find(child => child.id === 'structural-pick-controls');

test('the typed page fills the structural controls and a pick reaches the visual panel', async () => {
  const { page, trace } = await typedPage(wideIndex(6), 'complete');
  const controls = controlsOf();
  assert.ok(controls, 'the controls exist under the typed pipeline');
  assert.equal(controls.hidden, false);
  const pick = buttons(controls)[0];
  assert.ok(pick, 'the flat view lists a structural relation');
  assert.equal(pick.dataset.pickKind, 'visual-relation');
  pick.listeners.get('click')!();
  assert.equal(trace.panels.length, 1);
  assert.equal(trace.panels[0]!.kind, 'visual-relation');
  const visualId = (trace.panels[0] as { visualId: string }).visualId;
  const relation = resultOf(page).visualRelations.find(item => item.visualId === visualId)!;
  assert.equal(relation.semantic, false);
  assert.notEqual(relation.kind, 'lifted-route');
});

test('a typed view with no structural element renders the explicit empty statement', async () => {
  const index: V2Index = { nodes: [node('domain:solo', 1, null)], edges: [] };
  await typedPage(index, 'complete');
  const controls = controlsOf();
  assert.ok(controls);
  assert.equal(controls.hidden, false);
  assert.equal(buttons(controls).length, 0);
  assert.ok(controls.children.some(child => child.dataset.structuralEmpty === 'true'));
});
