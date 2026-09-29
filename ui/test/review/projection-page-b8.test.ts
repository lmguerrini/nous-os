import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { normalizeRawLedger, createSemanticSnapshot } from '../../src/projection/normalize.ts';
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { projectionPick, projectionVisibility, typedV2Path } from '../../src/review/v2-core.ts';
import type { ProjectionResult, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import type { V2Index } from '../../src/review/v2-core.ts';
import type { V2Page, ProjectionPipelineInput, ProjectionPageRenderer } from '../../src/review/v2-page.ts';

const node = (id: string, parent: string | null = null) => ({ id, level: parent ? 2 as const : 1 as const,
  kind: parent ? 'project' : 'domain', parent, parents: parent ? [parent] : [], domains: [],
  title: id, title_full: id, importance: { value: 0.5, components: {} }, size: 0.5,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 } });
const nodes = [node('a'), node('b'), node('child', 'a')];
const edges = [{ id: 'source-edge', source: 'a', target: 'b', class: 'attested' as const,
  type: 'related', directed: true, evidence: [] }];
const index: V2Index = { nodes, edges };
const manifest = { schema: 'nousos.review-graph/2' as const, digest: 'synthetic-b8', counts: {}, limits: {} };
const snapshot = await createSemanticSnapshot(await normalizeRawLedger({ manifest,
  index: { schema: 'nousos.review-graph/2', nodes, edges } }));

function resultFor(source: SemanticGraphSnapshot): ProjectionResult {
  const domain = selectAnalyticalDomain(source, ['a', 'b']);
  return { determinism: { snapshotDigest: source.digest, domainDigest: domain.domainDigest,
    algorithmId: 'natural', algorithmVersion: 'fixture', parameterHash: 'p', numericBackendVersion: 'fixture', resultDigest: 'r' },
    fullLedger: { snapshotDigest: source.digest, canonicalBytesDigest: source.rawLedger.canonicalBytesDigest,
      nodeCount: source.rawLedger.nodes.length, edgeCount: source.rawLedger.edges.length, loadedDetailCount: 0 },
    domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
    positions2: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } },
    containers: [{ visualId: 'visual:container', parentVisualId: null, memberCount: 2, shape: 'circle', levelId: 'level' }],
    visualRelations: [{ visualId: 'visual:relation', kind: 'co-membership', semantic: false, source: 'a', target: 'b',
      underlyingEdgeIds: [], count: 1, explanationId: 'visual:relation' }],
    curves: [{ visualId: 'visual:curve', purpose: 'relation-routing', visualRelationId: 'visual:relation' }],
    levels: [{ id: 'level', parentId: null, depth: 0, maxDepth: 0, loaded: true, childLevelIds: [],
      memberCount: 2, memberDigest: 'members', memberNodeIds: ['a', 'b'], inducedEdgeIds: ['source-edge'] }],
    fields: [{ id: 'visual:field', kind: 'scalar', domain: 'node', values: [1, 2], sampleIds: ['a', 'b'], units: 'fixture' }],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: 2, maxVisibleSemanticEdges: 1, maxVisibleVisualRelations: 1,
      maxVisibleCurves: 1, maxVisibleContainers: 1, maxVisibleFields: 1, progressiveLevelIds: ['level'] },
    explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' } };
}

test('six visibility classes revise without moving or fabricating a source edge', () => {
  const result = resultFor(snapshot);
  const complete = projectionVisibility(result, snapshot, 1, 1);
  assert.deepEqual([complete.nodeIds.size, complete.semanticEdgeIds.size, complete.visualRelationIds.size,
    complete.curveIds.size, complete.containerIds.size, complete.fieldIds.size], [2, 1, 1, 1, 1, 1]);
  const sparse = projectionVisibility(result, snapshot, 2, 0.5);
  assert.equal(sparse.nodeIds.size, 1);
  assert.equal(sparse.semanticEdgeIds.size, 0);
  assert.equal(sparse.visualRelationIds.size, 0);
  assert.equal(sparse.curveIds.size, 0);
  assert.equal(sparse.containerIds.size, 1);
  assert.equal(sparse.fieldIds.size, 1);
  assert.equal(sparse.projectionResultDigest, complete.projectionResultDigest);
  assert.deepEqual(result.positions2, { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  assert.deepEqual(projectionPick(result, { kind: 'visual-relation', visualId: 'visual:relation' }),
    { kind: 'visual-relation', visualId: 'visual:relation' });
  assert.throws(() => projectionPick(result, { kind: 'semantic-edge', id: 'visual:relation' }), /unknown semantic edge/);
  assert.throws(() => selectAnalyticalDomain(snapshot, Array.from({ length: 851 }, (_, i) => `n${i}`)), /exceeds 850/);
});

test('hierarchy path has a structural step and keeps source edges separate', () => {
  const path = typedV2Path(index, 'child', 'b', new Set(['a', 'b', 'child']));
  assert.deepEqual(path?.steps.map(step => step.kind), ['visual-relation', 'semantic-edge']);
  assert.equal(path?.steps[0]?.kind === 'visual-relation' && path.steps[0].relation.semantic, false);
  assert.deepEqual(path?.steps[0]?.kind === 'visual-relation' && path.steps[0].relation.underlyingEdgeIds, []);
});

const pageSource = new URL('../../src/review/v2-page.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/b8-v2-page.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(pageSource)), sourcefile: 'b8-page-entry.ts', loader: 'ts',
    contents: `export { V2Page, assertPageProjection, assertCurrentLevelToken } from ${JSON.stringify(fileURLToPath(pageSource))};` } });
writeFileSync(bundlePath, bundle.outputFiles[0]!.text);

const fakeElement = () => ({ children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
  textContent: '', hidden: false, className: '', id: '', disabled: false,
  append(...items: unknown[]) { this.children.push(...items); }, replaceChildren(...items: unknown[]) { this.children = items; },
  remove() {}, addEventListener() {}, setAttribute() {}, toggleAttribute() {},
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
const elements = new Map<string, ReturnType<typeof fakeElement>>();
for (const id of ['render-root', 'status', 'error', 'details', 'counter', 'focus-chip', 'back', 'v2-undo', 'v2-redo', 'v2-cap',
  'projection-focus', 'fullscreen-focus'])
  elements.set(id, fakeElement());
Object.assign(globalThis, { WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 },
  document: { getElementById: (id: string) => elements.get(id) ?? null, createElement: fakeElement,
    createElementNS: fakeElement, createTextNode: (text: string) => ({ text }), body: fakeElement() },
  window: { matchMedia: () => ({ matches: false }), addEventListener() {} }, innerWidth: 800, innerHeight: 600 });
const pageModule = (await import(pathToFileURL(bundlePath).href)) as typeof import('../../src/review/v2-page.ts');
const { V2Page: Page, assertPageProjection, assertCurrentLevelToken } = pageModule;

test('typed page uses one host and in-place mask revision on density', async () => {
  let mounts = 0, updates = 0, destroys = 0, rafs = 0;
  const callbacks: { picked?: Parameters<ProjectionPageRenderer['onPick']>[0] } = {};
  const renderer: ProjectionPageRenderer = { dimension: '2d', onPick(handler) { callbacks.picked = handler; }, onHover() {},
    mount() { mounts++; }, updateVisibleSubset() { updates++; }, destroy() { destroys++; } };
  const input: ProjectionPipelineInput = { snapshot: () => snapshot,
    createRenderer: () => renderer,
    style: result => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} }),
    styleLegacy: () => { throw new Error('legacy not used'); },
    panel: { show() {} } };
  const oldRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => { rafs++; return 1; }) as typeof requestAnimationFrame;
  try {
    const page: V2Page = new Page(manifest, index, { projection: '2d', morphology: 'stellar', organization: 'flat',
      colour: 'bw', labels: true, reading: 'attested' }, { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never,
      {} as never, {}, 'complete', { projectionPipeline: input });
    await page.refresh();
    const first = (page as unknown as { projectionResult: ProjectionResult }).projectionResult;
    // The far band's composed mask (complete × 0.4) still shows both endpoints of source-edge, so
    // the semantic-edge pick is visible here; after 'balanced' the ratio keeps one node and the
    // gate would correctly refuse the hidden edge.
    callbacks.picked?.({ kind: 'semantic-edge', id: 'source-edge' }, false);
    assert.equal(page.selectedId, 'source-edge');
    assert.throws(() => callbacks.picked?.({ kind: 'semantic-edge', id: 'visual:relation' }, false), /unknown semantic edge/);
    await page.setDensity('balanced');
    assert.equal(mounts, 1);
    assert.equal(updates, 1);
    assert.equal(destroys, 0);
    assert.equal(rafs, 0);
    assert.equal((page as unknown as { projectionResult: ProjectionResult }).projectionResult.determinism.resultDigest,
      first.determinism.resultDigest);
    await page.setAxes({ morphology: 'neural' });
    assert.equal(mounts, 1);
    assert.equal((page as unknown as { projectionResult: ProjectionResult }).projectionResult.determinism.resultDigest,
      first.determinism.resultDigest, 'style change retains the resolved Natural arrangement');
  } finally { globalThis.requestAnimationFrame = oldRaf; }
});

test('typed Indra branch receives the explicit legacy packing through the registry', async () => {
  let legacyCalls = 0, mounts = 0;
  const input: ProjectionPipelineInput = { snapshot: () => snapshot,
    createRenderer: () => ({ dimension: '2d', onPick() {}, onHover() {}, mount() { mounts++; },
      updateVisibleSubset() {}, destroy() {} }),
    style: () => { throw new Error('Natural not used'); },
    styleLegacy: (legacy, source, domain) => {
      legacyCalls++;
      assert.equal(legacy.id, 'indra-legacy');
      assert.equal(legacy.claims.mobius, false);
      assert.equal(legacy.claims.schottky, false);
      const result = resultFor(source);
      return { projection: { ...result, domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds,
        loadedNodeIds: domain.nodeIds, determinism: { ...result.determinism, domainDigest: domain.domainDigest,
          algorithmId: 'indras-pearls', algorithmVersion: legacy.algorithmVersion, resultDigest: 'legacy-result' },
        lod: { ...result.lod, maxVisibleNodes: domain.nodeIds.length },
        positions2: Object.fromEntries([...legacy.positions].map(([id, point]) => [id, { x: point.x, y: point.y }])) },
        nodeStyle: {}, edgeStyle: {}, visualStyle: {} };
    }, panel: { show() {} } };
  const page = new Page(manifest, index, { projection: '2d', morphology: 'stellar', organization: 'indra',
    colour: 'bw', labels: true, reading: 'attested' }, { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never,
    {} as never, {}, 'complete', { projectionPipeline: input });
  await page.refresh();
  assert.equal(legacyCalls, 1);
  assert.equal(mounts, 1);
});

test('page rejects missing coordinates, out-of-domain keys and stale level tokens', () => {
  const result = resultFor(snapshot);
  const domain = selectAnalyticalDomain(snapshot, ['a', 'b']);
  assert.doesNotThrow(() => assertPageProjection(result, domain, '2d'));
  assert.throws(() => assertPageProjection({ ...result, positions2: { a: { x: 1, y: 2 } } }, domain, '2d'), /coordinate/);
  assert.throws(() => assertPageProjection({ ...result, positions2: { ...result.positions2, outside: { x: 0, y: 0 } } }, domain, '2d'), /coordinate/);
  const { positions2: _positions2, ...withoutPositions2 } = result;
  assert.throws(() => assertPageProjection({ ...withoutPositions2,
    positions3: { a: { x: 1, y: 2, z: 3 }, b: { x: 3, y: 4, z: Number.NaN } } }, domain, '3d'), /coordinate/);
  const level = { id: 'child', parentId: null, depth: 1, maxDepth: 2, loaded: false as const, childLevelIds: [], memberCount: 1,
    loadToken: { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest, projectionId: 'natural' as const,
      parameterHash: 'p', levelId: 'child' } };
  assert.doesNotThrow(() => assertCurrentLevelToken(level, snapshot, domain, result));
  assert.throws(() => assertCurrentLevelToken({ ...level, loadToken: { ...level.loadToken, domainDigest: 'old' } },
    snapshot, domain, result), /Stale/);
});
