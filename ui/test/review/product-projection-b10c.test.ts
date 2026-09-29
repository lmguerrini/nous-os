import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuralVisualPresentation } from '../../src/engine/presentation-options.ts';
import type { ProductProjectionInput, ProductProjectionRenderer } from '../../src/review/product-view.ts';
import type { Dimension, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';

// The product entry also imports a .tsx browser renderer; bundle it for Node's focused bridge test.
const scratch = await mkdtemp(join(tmpdir(), 'b10c-product-'));
const bundled = join(scratch, 'product.mjs');
await build({ entryPoints: [new URL('../../src/review/product-view.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', outfile: bundled });
Object.assign(globalThis, { WebGLRenderingContext: class {}, WebGL2RenderingContext: class {} });
const { mountProductProjection, prepareProductProjection } = await import(bundled) as {
  mountProductProjection: typeof import('../../src/review/product-view.ts')['mountProductProjection'];
  prepareProductProjection: typeof import('../../src/review/product-view.ts')['prepareProductProjection'];
};
await rm(scratch, { recursive: true, force: true });

const snapshot = {
  digest: 'snapshot', rawLedger: { canonicalBytesDigest: 'ledger' },
  nodes: [{ id: 'n:a' }, { id: 'n:b' }],
  edges: [{ id: 'e:ab', source: 'n:a', target: 'n:b', attestation: 'attested' }],
} as unknown as SemanticGraphSnapshot;

function projection(dimension: Dimension): ProjectionResult {
  return {
    determinism: { snapshotDigest: 'snapshot', domainDigest: 'domain', algorithmId: 'natural',
      algorithmVersion: 'fixture', parameterHash: 'parameters', numericBackendVersion: 'fixture', resultDigest: 'result' },
    fullLedger: { snapshotDigest: 'snapshot', canonicalBytesDigest: 'ledger', nodeCount: 2, edgeCount: 1, loadedDetailCount: 0 },
    domainNodeIds: ['n:a', 'n:b'], domainEdgeIds: ['e:ab'], loadedNodeIds: ['n:a', 'n:b'],
    ...(dimension === '2d' ? { positions2: { 'n:a': { x: 1, y: 2 }, 'n:b': { x: 3, y: 4 } } }
      : { positions3: { 'n:a': { x: 1, y: 2, z: 3 }, 'n:b': { x: 4, y: 5, z: 6 } } }),
    containers: [], curves: [], fields: [], levels: [],
    visualRelations: [
      { visualId: 'visual:relation:co:a:b', kind: 'co-membership', semantic: false,
        source: 'n:a', target: 'n:b', underlyingEdgeIds: [], count: 1, explanationId: 'co' },
      { visualId: 'visual:relation:contains:b', kind: 'synthetic-containment', semantic: false,
        source: 'n:a', target: 'n:b', underlyingEdgeIds: [], count: 1, explanationId: 'contains' },
    ],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: 2, maxVisibleSemanticEdges: 1, maxVisibleVisualRelations: 2,
      maxVisibleCurves: 0, maxVisibleContainers: 0, maxVisibleFields: 0, progressiveLevelIds: [] },
    explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' },
  };
}

function mask(revision = 1): RenderVisibility {
  return { projectionResultDigest: 'result', revision, density: 0.5, levelIds: new Set(),
    nodeIds: new Set(['n:a', 'n:b']), semanticEdgeIds: new Set(['e:ab']),
    visualRelationIds: new Set(['visual:relation:co:a:b', 'visual:relation:contains:b']),
    curveIds: new Set(), containerIds: new Set(), fieldIds: new Set() };
}

function styled(dimension: Dimension): StyledProjection {
  return { projection: projection(dimension), nodeStyle: {}, edgeStyle: {}, visualStyle: {} };
}

test('structural style is distinct from source-edge presentation', () => {
  for (const relation of projection('2d').visualRelations) {
    const style = structuralVisualPresentation(relation);
    assert.equal(style.category, 'structural-visual');
    assert.notEqual(style.category, 'attested');
    assert.notEqual(style.category, 'exploratory');
  }
});

test('2D and 3D hand off the same immutable typed collections and six-class mask', () => {
  for (const dimension of ['2d', '3d'] as const) {
    const source = styled(dimension);
    const visibility = mask();
    const calls: ProductProjectionInput[] = [];
    let picked: import('../../src/projection/contract-types.ts').PickResult | null =
      { kind: 'visual-relation', visualId: 'visual:relation:co:a:b' };
    let destroyed = 0;
    const makeRenderer = (key: Dimension): ProductProjectionRenderer => ({
      dimension: key, mount(input: ProductProjectionInput) { calls.push(input); },
      updateVisibleSubset(input: ProductProjectionInput) { calls.push(input); },
      pickAt() { return picked; },
      destroy() { destroyed++; },
    });
    const factories: Record<Dimension, () => ProductProjectionRenderer> = {
      '2d': () => makeRenderer('2d'), '3d': () => makeRenderer('3d'),
    };
    const host = mountProductProjection(dimension, source, visibility, snapshot, factories);
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0]!.styled, source);
    assert.strictEqual(calls[0]!.visibility, visibility);
    assert.strictEqual(calls[0]!.visualRelations, source.projection.visualRelations);
    assert.deepEqual(calls[0]!.semanticEdges.map(edge => edge.id), ['e:ab']);
    assert.deepEqual([...calls[0]!.structuralPresentation.keys()],
      ['visual:relation:co:a:b', 'visual:relation:contains:b']);
    assert.equal(calls[0]!.semanticEdges.some(edge => edge.id.startsWith('visual:')), false);
    assert.deepEqual(host.pickAt({ x: 4, y: 7 }), picked);
    const nextMask = { ...visibility, revision: 2, density: 1, visualRelationIds: new Set<string>() };
    host.updateVisibleSubset(source, nextMask, snapshot);
    assert.strictEqual(calls[1]!.visibility, nextMask);
    assert.strictEqual(calls[1]!.styled, source);
    assert.equal(host.pickAt({ x: 4, y: 7 }), null);
    picked = { kind: 'semantic-edge', id: 'visual:relation:co:a:b' };
    assert.throws(() => host.pickAt({ x: 4, y: 7 }), /unknown semantic edge pick/);
    host.destroy();
    host.destroy();
    assert.equal(destroyed, 1);
  }
});

test('rejects structural relations crossing the semantic boundary before renderer mount', () => {
  const base = styled('2d');
  const wrong = { ...base, projection: { ...base.projection,
    visualRelations: [{ ...base.projection.visualRelations[0]!, visualId: 'e:ab' }] } };
  assert.throws(() => prepareProductProjection(wrong,
    { ...mask(), visualRelationIds: new Set(['e:ab']) }, snapshot), /invalid visual relation/);
  const fake = { ...base, projection: { ...base.projection,
    visualRelations: [{ ...base.projection.visualRelations[0]!, semantic: true }] } } as unknown as StyledProjection;
  assert.throws(() => prepareProductProjection(fake,
    { ...mask(), visualRelationIds: new Set(['visual:relation:co:a:b']) }, snapshot), /invalid visual relation/);
  assert.throws(() => prepareProductProjection(base, { ...mask(), semanticEdgeIds: new Set(['visual:relation:co:a:b']) }, snapshot), /unknown ID/);
});
