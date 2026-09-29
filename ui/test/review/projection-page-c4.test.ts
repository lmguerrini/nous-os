import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { normalizeRawLedger, createSemanticSnapshot } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import type { AnalyticalDomain, ProjectionResult, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';
import type { GraphManifest } from '../../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { Axes, CreateProductView, ProductView } from '../../src/review/view-contract.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';

/**
 * D-073 C4: page state, cache and camera transition. Covers the three GATE-B audit fixes —
 * the indra-legacy hidden-count max-up (with a legacy-vs-typed position parity oracle), the
 * typed relation detail/active wiring (with the natural cache-key fix), and the Natural
 * branch's continuity anchors (disclosure re-seeds, three styles keep one digest) — plus the
 * six-class density/level mask, the projection witness and the camera plumbing the browser
 * bridge reads. The page module is esbuild-bundled once (the repo's own pattern from
 * `v2-view-recovery.test.ts`); the default pipeline's renderer adapters are browser wiring and
 * stay behind the browser gate.
 */

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/c4-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'c4-page-entry.ts', loader: 'ts',
    contents: `export { V2Page } from ${JSON.stringify(fileURLToPath(pageSource))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

const fakeElement = () => {
  const el = {
    children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    textContent: '', hidden: false, className: '', id: '', disabled: false, title: '', onclick: null as null | (() => void),
    append(...items: unknown[]) { this.children.push(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    remove() {}, addEventListener() {}, setAttribute() {}, toggleAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
  return el;
};
const elements = new Map<string, ReturnType<typeof fakeElement>>();
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
const pageModule = (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');
const { V2Page: Page } = pageModule;

const MANIFEST: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'd073-c4-fixture', counts: {}, limits: {} };
const AXES = { projection: '2d' as const, morphology: 'stellar' as const, organization: 'flat' as const,
  colour: 'bw' as const, labels: true, reading: 'attested' as const };
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: '#050505', aggregate: '#f0f0f0', concept: '#dedede', attested: '#b8b8b8',
  exploratory: '#e4e4e4', selection: '#ffffff', hover: '#ffffff', container: '#ebebeb', text: '#e8e8e8' };

const node = (id: string, level: 1 | 2 | 3 | 4, parent: string | null, title: string): V2Node => ({
  id, level, kind: level === 1 ? 'domain' : level === 2 ? 'project' : level === 3 ? 'conversation' : 'message',
  parent, parents: parent ? [parent] : [], domains: [], title, display_label: title, title_full: title,
  importance: { value: 0.5, components: {} }, size: 0.5,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
/** Two domains; `domain:alfa` expands to a project whose conversations stay collapsed — the
 * divergence fixture for the hidden-count max-up (hidden counts direct children, descendants
 * counts the whole subtree). */
function fixtureIndex(): V2Index {
  const nodes: V2Node[] = [
    node('domain:alfa', 1, null, 'Dominio alfa'), node('domain:beta', 1, null, 'Dominio beta'),
    node('project:alfa:0', 2, 'domain:alfa', 'Progetto alfa-0'), node('project:beta:0', 2, 'domain:beta', 'Progetto beta-0'),
  ];
  for (let i = 0; i < 3; i++) nodes.push(node(`conversation:alfa:${i}`, 3, 'project:alfa:0', `Conversazione alfa ${i}`));
  for (let i = 0; i < 3; i++) nodes.push(node(`conversation:beta:${i}`, 3, 'project:beta:0', `Conversazione beta ${i}`));
  for (let i = 0; i < 3; i++)
    for (let m = 0; m < 4; m++)
      nodes.push(node(`message:alfa:${i}:${m}`, 4, `conversation:alfa:${i}`, `Messaggio ${i}-${m}`));
  const countsFor = (id: string): { children: number; descendants: number } => {
    const children = nodes.filter(n => n.parent === id);
    const descendants = children.reduce((total, child) => total + 1 + countsFor(child.id).descendants, 0);
    return { children: children.length, descendants };
  };
  for (const n of nodes) {
    const { children, descendants } = countsFor(n.id);
    n.counts = { ...n.counts, children, descendants };
  }
  const edges = [
    { id: 'source-edge', source: 'domain:alfa', target: 'domain:beta', class: 'attested' as const,
      type: 'related', directed: true, evidence: [] },
    { id: 'mentions-edge', source: 'conversation:beta:0', target: 'domain:alfa', class: 'attested' as const,
      type: 'mentions', directed: true, evidence: [] },
  ];
  return { nodes, edges };
}

async function snapshotFor(index: V2Index): Promise<SemanticGraphSnapshot> {
  return createSemanticSnapshot(await normalizeRawLedger({ manifest: MANIFEST,
    index: { schema: 'nousos.review-graph/2', nodes: index.nodes.filter(n => n.level !== 5), edges: index.edges } }));
}

/** The B8-style injected pipeline: real snapshot, fake renderers, echo style. */
function fakePipeline(snapshot: SemanticGraphSnapshot, renderer: ProjectionPageRenderer): { input: ProjectionPipelineInput } {
  const input: ProjectionPipelineInput = {
    snapshot: () => snapshot,
    createRenderer: () => ({ ...renderer }),
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: (legacy, source, domain) => styleLegacyEcho(legacy, source, domain),
    panel: { show() {} },
  };
  return { input };
}

function styleLegacyEcho(legacy: { positions: ReadonlyMap<string, { x: number; y: number; z: number }>; algorithmVersion: string; source: string },
  source: SemanticGraphSnapshot, domain: AnalyticalDomain): StyledProjection {
  const positions2 = Object.fromEntries([...legacy.positions].map(([id, point]) => [id, { x: point.x, y: point.y }]));
  const result = {
    determinism: { snapshotDigest: source.digest, domainDigest: domain.domainDigest, algorithmId: 'natural' as const,
      algorithmVersion: legacy.algorithmVersion, parameterHash: 'fixture', numericBackendVersion: legacy.source,
      resultDigest: 'legacy-result' },
    fullLedger: { snapshotDigest: source.digest, canonicalBytesDigest: source.rawLedger.canonicalBytesDigest,
      nodeCount: source.rawLedger.nodes.length, edgeCount: source.rawLedger.edges.length, loadedDetailCount: 0 },
    domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
    positions2, containers: [], visualRelations: [], curves: [], levels: [], fields: [],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: domain.edgeIds.length,
      maxVisibleVisualRelations: 0, maxVisibleCurves: 0, maxVisibleContainers: 0, maxVisibleFields: 0,
      progressiveLevelIds: [] },
    explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' as const },
  } as unknown as ProjectionResult;
  return { projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} };
}

const pageInternals = (page: V2Page) => page as unknown as {
  projectionResult: ProjectionResult | null; projectionInput: ProjectionPipelineInput;
};
const typedPage = async (index: V2Index, axes: Partial<Axes> = {}, renderer?: ProjectionPageRenderer): Promise<{ page: V2Page; snapshot: SemanticGraphSnapshot; input: ProjectionPipelineInput }> => {
  const snapshot = await snapshotFor(index);
  const fake = fakePipeline(snapshot, renderer ?? {
    dimension: '2d', mount() {}, updateVisibleSubset() {}, destroy() {},
    onPick() {}, onHover() {},
  });
  const page = new Page(MANIFEST, index, { ...AXES, ...axes }, APPEARANCE, PALETTE, {}, 'complete',
    { projectionPipeline: fake.input });
  await page.refresh();
  return { page, snapshot, input: fake.input };
};

test('audit 1: the typed indra branch reproduces the legacy hidden-count max-up positions', async () => {
  const index = fixtureIndex();
  const createView: CreateProductView = async () => ({
    destroy() {}, readCamera: () => null, async fit() {}, async resetCamera() {}, async frame() {},
    select() {}, setEmphasis() {}, setInsets() {}, setFlowMotion() {}, async setAxes() {},
    async setVisible() {}, async setAppearance() {}, async setPalette() {}, viewPreset() {},
    camera: () => null, witness: () => ({ axes: {}, visibleRect: { left: 0, top: 0, width: 800, height: 600 },
      nodeViewport: {}, labels: [] }),
  }) as unknown as ProductView;
  const legacyPage = new Page(MANIFEST, index, { ...AXES, organization: 'indra' }, APPEARANCE, PALETTE, {}, 'complete', { createView });
  await legacyPage.refresh();
  const legacyPositions = (legacyPage as unknown as { rawPositions: ReadonlyMap<string, { x: number; y: number; z: number }> }).rawPositions;
  assert.ok(legacyPositions);
  // The fixture really reaches the max-up branch: project:alfa:0 is disclosed, collapsed, and its
  // descendant count exceeds its direct hidden-children count.
  assert.equal((legacyPage as unknown as { visible: () => { hidden: Map<string, number> } }).visible().hidden.get('project:alfa:0'), 3);

  const { page } = await typedPage(index, { organization: 'indra' });
  const typedPositions = pageInternals(page).projectionResult!.positions2!;
  assert.equal(Object.keys(typedPositions).length, legacyPositions.size, 'same disclosed domain');
  for (const [id, point] of legacyPositions) {
    const typed = typedPositions[id];
    assert.ok(typed, `typed indra omitted ${id}`);
    // Byte-for-byte parity with the legacy layout — pearlRadius included the max-up.
    assert.deepEqual({ x: typed.x, y: typed.y }, { x: point.x, y: point.y }, `position drifted for ${id}`);
  }
});

test('audit 2: relation detail and the focus source reach the typed relations; the cache never serves a stale rehash', async () => {
  const index = fixtureIndex();
  const { page } = await typedPage(index);
  const result = () => pageInternals(page).projectionResult!;
  const mentions = () => result().visualRelations.some(relation => relation.underlyingEdgeIds.includes('mentions-edge'));
  assert.equal(mentions(), false, 'essential flat detail drops the non-focus mentions arc');
  const essentialDigest = result().determinism.resultDigest;

  await page.setRelationDetail('all');
  assert.equal(mentions(), true, 'detail=all keeps the mentions arc');

  await page.setRelationDetail('essential');
  assert.equal(mentions(), false, 'back to essential without a selection: dropped again');
  // Selecting the mentions source makes it focus-adjacent; the raw natural result is unchanged
  // (same request), so only the re-keyed typed cache can surface the new typed relations.
  const select = (page as unknown as { typedSelection: unknown; selected: string | null; renderPanel(): void });
  select.typedSelection = { kind: 'node', id: 'conversation:beta:0' };
  select.selected = 'conversation:beta:0';
  await page.setAxes({ morphology: 'neural' });
  assert.equal(mentions(), true, 'the active focus keeps its mentions arc through an identical raw result');
  assert.notEqual(result().determinism.resultDigest, essentialDigest, 'the typed rehash is part of the digest');
});

test('audit 3: continuity anchors re-seed on disclosure and replay byte-identically across three styles', async () => {
  const index = fixtureIndex();
  const { page } = await typedPage(index);
  const witness = () => page.witness() as { projection: { resultDigest: string; continuityAnchored: boolean } };
  assert.equal(witness().projection.continuityAnchored, false, 'the first typed layout is fresh');
  const firstDigest = witness().projection.resultDigest;

  await page.expand('project:alfa:0');
  const anchored = witness().projection;
  assert.equal(anchored.continuityAnchored, true, 'a disclosure change seeds from the previous positions');
  assert.notEqual(anchored.resultDigest, firstDigest, 'the grown domain is a different result');

  for (const morphology of ['neural', 'mycelium'] as const) {
    await page.setAxes({ morphology });
    assert.equal(witness().projection.resultDigest, anchored.resultDigest,
      `morphology ${morphology} keeps the resolved arrangement, anchors and digest`);
  }
});

test('the six-class mask composes the density ratio with the camera level', async () => {
  const index = fixtureIndex();
  const { page } = await typedPage(index);
  const domain = selectAnalyticalDomain(await snapshotFor(index),
    (page as unknown as { visible: () => { nodes: V2Node[] } }).visible().nodes.map(n => n.id));
  // density 'complete' at the initial 'far' level: ceil(N × 1 × 0.4). The projection path
  // reports its mask through disclosure().lod.rendered (this.rendered is the mask node set).
  const expected = Math.ceil(domain.nodeIds.length * 0.4);
  assert.equal((page.disclosure() as unknown as { lod: { rendered: number } }).lod.rendered, expected);
});

test('the projection witness, camera bridge and tick read the mounted typed renderer', async () => {
  const cameraState = { x: 0, y: 0, angle: 0, ratio: 2 };
  const { page } = await typedPage(fixtureIndex(), {}, {
    dimension: '2d', mount() {}, updateVisibleSubset() {}, destroy() {},
    onPick() {}, onHover() {},
    readCameraState: () => cameraState,
  });
  assert.deepEqual(page.cameraState(), cameraState);
  assert.equal(page.camera(), null, 'the 2D adapter exposes no 3D pose');
  const witness = page.witness() as { projection: { enabled: boolean; resultDigest: string | null } };
  assert.equal(witness.projection.enabled, true);
  assert.equal(witness.projection.resultDigest, pageInternals(page).projectionResult!.determinism.resultDigest);
  // A settled camera at the overview ratio neither crosses a band nor schedules anything.
  page.tickZoom();
  assert.equal((page.witness() as { lod: { level: string } }).lod.level, 'far');
});

test('the default pipeline builds its snapshot from the page index and styles without touching the digest', async () => {
  const index = fixtureIndex();
  const page = new Page(MANIFEST, index, AXES, APPEARANCE, PALETTE, {}, 'complete', { useDefaultPipeline: true });
  const input = pageInternals(page).projectionInput;
  const direct = await snapshotFor(index);
  const built = await input.snapshot();
  assert.equal(built.digest, direct.digest);
  assert.strictEqual(await input.snapshot(), built, 'the memo returns the same snapshot object');

  index.nodes.push(node('domain:gamma', 1, null, 'Dominio gamma'));
  const rebuilt = await input.snapshot();
  assert.notEqual(rebuilt.digest, built.digest, 'a changed index rebuilds the snapshot');

  const domain = selectAnalyticalDomain(direct, ['domain:alfa', 'domain:beta']);
  const styled = input.style(resultFor(direct, domain), direct);
  const projected = styled.projection;
  const alfa = styled.nodeStyle['domain:alfa']!;
  assert.equal(alfa.color, '#f0f0f0', 'the aggregate palette colour');
  assert.equal(typeof alfa.size, 'number');
  assert.ok(Number.isFinite(alfa.size as number));
  assert.deepEqual(styled.edgeStyle['source-edge']!.color, '#729ebd');
  assert.ok(styled.visualStyle['visual:natural:source-edge'], 'structural visuals carry a presentation entry');
  assert.strictEqual(styled.projection, projected, 'style never replaces the result');
});

test('the default pipeline maps the legacy indra output into one typed result', async () => {
  const index = fixtureIndex();
  const page = new Page(MANIFEST, index, { ...AXES, organization: 'indra' }, APPEARANCE, PALETTE, {}, 'complete', { useDefaultPipeline: true });
  const input = pageInternals(page).projectionInput;
  const snapshot = await snapshotFor(index);
  const disclosed = (page as unknown as { visible: () => { nodes: V2Node[] } }).visible().nodes.map(n => n.id);
  const domain = selectAnalyticalDomain(snapshot, disclosed);
  const legacy = {
    id: 'indra-legacy' as const, algorithmVersion: 'layout-v2/indra-recursive' as const, source: 'indra-recursive' as const,
    positions: new Map(disclosed.map(id => {
      const n = index.nodes.find(item => item.id === id)!;
      return [id, { x: n.counts.descendants, y: 1, z: 0 }];
    })),
    containers: [{ id: 'project:alfa:0', level: 2, center: { x: 0, y: 0, z: 0 }, radius: 10, open: false }],
    claims: { kind: 'legacy-sphere-circle-packing' as const, mobius: false as const, schottky: false as const },
  };
  const styled = input.styleLegacy(legacy, snapshot, domain, []);
  const result = styled.projection;
  assert.equal(result.positions2!['project:alfa:0']!.x, 15, 'positions map straight through (3 conversations + 12 messages)');
  assert.equal(result.containers[0]!.visualId, 'visual:container:project:alfa:0');
  assert.equal(result.containers[0]!.shape, 'circle');
  assert.equal(result.lod.maxVisibleNodes, domain.nodeIds.length);
  assert.equal(result.coordinateState.kind, 'coordinates');
});

function resultFor(snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain): ProjectionResult {
  return {
    determinism: { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest, algorithmId: 'natural',
      algorithmVersion: 'fixture', parameterHash: 'p', numericBackendVersion: 'fixture', resultDigest: 'r' },
    fullLedger: { snapshotDigest: snapshot.digest, canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
      nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length, loadedDetailCount: 0 },
    domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
    positions2: Object.fromEntries(domain.nodeIds.map((id, i) => [id, { x: i, y: i }])),
    containers: [], visualRelations: [{ visualId: 'visual:natural:source-edge', kind: 'lifted-route', semantic: false,
      source: domain.nodeIds[0]!, target: domain.nodeIds[1] ?? domain.nodeIds[0]!, underlyingEdgeIds: ['source-edge'],
      count: 1, explanationId: 'visual:natural:source-edge' }],
    curves: [], levels: [], fields: [],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: domain.edgeIds.length,
      maxVisibleVisualRelations: 1, maxVisibleCurves: 0, maxVisibleContainers: 0, maxVisibleFields: 0,
      progressiveLevelIds: [] },
    explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' },
  };
}
