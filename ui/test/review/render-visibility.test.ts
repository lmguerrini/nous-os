import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projection2dRevisionAction, prepareProjection2d } from '../../src/render2d/model.ts';
import { TypedProjectionPicker } from '../../src/render3f/picking.ts';
import { validatePickResult, validateSemanticEdgeCarriers } from '../../src/projection/contract.ts';
import { projectionVisibility } from '../../src/review/v2-core.ts';
import type { PickResult, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';
import type { ProductProjectionInput, ProductProjectionRenderer } from '../../src/review/product-view.ts';

const sourceEdge = { id: 'edge:source', source: 'node:a', target: 'node:b', attestation: 'attested' as const };
const structural = { visualId: 'visual:membership', kind: 'co-membership' as const, semantic: false as const,
  source: 'node:a', target: 'node:b', underlyingEdgeIds: [], count: 1, explanationId: 'explanation:membership' };
const curve = { visualId: 'visual:curve', purpose: 'relation-routing' as const, visualRelationId: structural.visualId,
  points2: [{ x: 0, y: 0 }, { x: 100, y: 0 }], points3: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }] };
const container = { visualId: 'visual:container', parentVisualId: null, memberNodeIds: ['node:a', 'node:b'],
  memberCount: 2, shape: 'sphere' as const, center2: { x: 50, y: 0 }, center3: { x: 50, y: 0, z: 0 }, radius: 20, levelId: 'level:root' };
const field = { id: 'visual:field', kind: 'scalar' as const, domain: 'node' as const, values: [1, 2],
  sampleIds: ['node:a', 'node:b'], units: 'fixture' };

const snapshot = {
  digest: 'snapshot:visibility', rawLedger: { canonicalBytesDigest: 'ledger:visibility' },
  nodes: [{ id: 'node:a' }, { id: 'node:b' }], edges: [sourceEdge],
} as unknown as SemanticGraphSnapshot;

function resultFor(dimension: '2d' | '3d'): ProjectionResult {
  const positions2 = { 'node:a': { x: 0, y: 0 }, 'node:b': { x: 100, y: 0 } };
  const positions3 = { 'node:a': { x: 0, y: 0, z: 0 }, 'node:b': { x: 100, y: 0, z: 0 } };
  return {
    determinism: { snapshotDigest: snapshot.digest, domainDigest: 'domain:visibility', algorithmId: 'natural',
      algorithmVersion: 'fixture', parameterHash: 'parameters', numericBackendVersion: 'fixture', resultDigest: `result:${dimension}` },
    fullLedger: { snapshotDigest: snapshot.digest, canonicalBytesDigest: 'ledger:visibility', nodeCount: 2, edgeCount: 1, loadedDetailCount: 0 },
    domainNodeIds: ['node:a', 'node:b'], domainEdgeIds: [sourceEdge.id], loadedNodeIds: ['node:a', 'node:b'],
    ...(dimension === '2d' ? { positions2 } : { positions3 }),
    containers: [container], visualRelations: [structural], curves: [curve],
    levels: [{ id: 'level:root', parentId: null, depth: 0, maxDepth: 0, loaded: true as const,
      childLevelIds: [], memberCount: 2, memberDigest: 'members', memberNodeIds: ['node:a', 'node:b'], inducedEdgeIds: [sourceEdge.id] }],
    fields: [field],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {}, priorityByCurveId: {},
      priorityByContainerId: {}, priorityByFieldId: {}, maxVisibleNodes: 2, maxVisibleSemanticEdges: 1,
      maxVisibleVisualRelations: 1, maxVisibleCurves: 1, maxVisibleContainers: 1, maxVisibleFields: 1,
      progressiveLevelIds: ['level:root'] },
    explanations: { 'explanation:membership': { elementId: structural.visualId, elementKind: 'visual-relation',
      summary: 'Structural membership', sourceIds: [], parameterIds: [] } }, diagnostics: [], coordinateState: { kind: 'coordinates' },
  } as ProjectionResult;
}

function styled(result: ProjectionResult): StyledProjection {
  return { projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} };
}

function mask(result: ProjectionResult, revision: number, density: number, visibleNodes?: ReadonlySet<string>): RenderVisibility {
  return projectionVisibility(result, snapshot, revision, density, visibleNodes);
}

function sixSizes(value: RenderVisibility): number[] {
  return [value.nodeIds.size, value.semanticEdgeIds.size, value.visualRelationIds.size,
    value.curveIds.size, value.containerIds.size, value.fieldIds.size];
}

test('2D and 3D retain all six visibility classes across level and density revisions', () => {
  for (const dimension of ['2d', '3d'] as const) {
    const result = resultFor(dimension);
    const full = mask(result, 1, 1);
    const sparse = mask(result, 2, 0.5, new Set(['node:a']));
    const expandedResult: ProjectionResult = { ...result,
      determinism: { ...result.determinism, resultDigest: `result:${dimension}:expanded` },
      levels: [...result.levels, { id: 'level:child', parentId: 'level:root', depth: 1, maxDepth: 1, loaded: true,
        childLevelIds: [], memberCount: 1, memberDigest: 'child-members', memberNodeIds: ['node:b'], inducedEdgeIds: [sourceEdge.id] }] };
    const expanded = mask(expandedResult, 3, 1);
    assert.deepEqual(sixSizes(full), [2, 1, 1, 1, 1, 1]);
    assert.deepEqual(sixSizes(sparse), [1, 0, 0, 0, 1, 1]);
    assert.deepEqual([...full.levelIds], ['level:root']);
    assert.deepEqual([...sparse.levelIds], ['level:root']);
    assert.deepEqual([...expanded.levelIds], ['level:root', 'level:child']);
    if (dimension === '2d') {
      const fullScene = prepareProjection2d(snapshot, styled(result), full);
      const sparseScene = prepareProjection2d(snapshot, styled(result), sparse);
      assert.deepEqual([fullScene.nodes.size, fullScene.semanticEdges.size, fullScene.visualRelations.size,
        fullScene.curves.size, fullScene.containers.size, fullScene.fields.size], sixSizes(full));
      assert.deepEqual([sparseScene.nodes.size, sparseScene.semanticEdges.size, sparseScene.visualRelations.size,
        sparseScene.curves.size, sparseScene.containers.size, sparseScene.fields.size], sixSizes(sparse));
      const fullKey = JSON.stringify([full.revision, full.density]);
      const sparseKey = JSON.stringify([sparse.revision, sparse.density]);
      assert.equal(projection2dRevisionAction(full.revision, fullKey, sparse.revision, sparseKey), 'apply');
      assert.equal(projection2dRevisionAction(sparse.revision, sparseKey, full.revision, fullKey), 'stale');
      assert.equal(projection2dRevisionAction(sparse.revision, sparseKey, sparse.revision, sparseKey), 'same');
      assert.throws(() => projection2dRevisionAction(sparse.revision, sparseKey, sparse.revision, fullKey), /equal projection visibility revision changed content/);
      const expandedScene = prepareProjection2d(snapshot, styled(expandedResult), expanded);
      assert.deepEqual([expandedScene.nodes.size, expandedScene.semanticEdges.size, expandedScene.visualRelations.size,
        expandedScene.curves.size, expandedScene.containers.size, expandedScene.fields.size], sixSizes(expanded));
      assert.equal(projection2dRevisionAction(sparse.revision, sparseKey, expanded.revision,
        JSON.stringify([expanded.revision, expanded.density])), 'apply');
    } else {
      const project = (point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.y });
      const fullInput = { styled: styled(result), visibility: full, semanticEdges: [sourceEdge] };
      const picker = new TypedProjectionPicker(fullInput, project);
      assert.equal(picker.geometry.nodes.length, 2);
      assert.equal(picker.geometry.semanticEdges.length, 1);
      assert.equal(picker.geometry.visualRelations.length, 1);
      assert.equal(picker.geometry.curves.length, 1);
      assert.equal(picker.geometry.containers.length, 96, '3D container witness is tessellated into pickable segments');
      assert.equal(picker.geometry.fields.length, 2);
      assert.equal(picker.update({ ...fullInput, visibility: sparse }), true);
      assert.equal(picker.geometry.nodes.length, 1);
      const expandedInput = { styled: styled(expandedResult), visibility: expanded, semanticEdges: [sourceEdge] };
      assert.equal(picker.update(expandedInput), true, 'newly loaded level result is accepted in place');
      assert.equal(picker.geometry.nodes.length, 2);
      assert.equal(picker.update(fullInput), false, 'older 3D visibility revision must be ignored');
      assert.equal(picker.visibility.revision, expanded.revision);
    }
  }
});

test('typed picks stay in their class and structural picks cannot become ReviewEdges', () => {
  const result = resultFor('3d');
  const picks: PickResult[] = [
    { kind: 'node', id: 'node:a' }, { kind: 'semantic-edge', id: sourceEdge.id },
    { kind: 'visual-relation', visualId: structural.visualId }, { kind: 'curve', visualId: curve.visualId },
    { kind: 'container', visualId: container.visualId }, { kind: 'field', visualId: field.id },
  ];
  for (const pick of picks) validatePickResult(result, pick);
  assert.throws(() => validatePickResult(result, { kind: 'semantic-edge', id: structural.visualId }), /unknown semantic edge pick/);
  const picker = new TypedProjectionPicker({ styled: styled(result), visibility: mask(result, 1, 1), semanticEdges: [sourceEdge] },
    point => ({ x: point.x, y: point.y }));
  assert.deepEqual(picker.pick({ x: 50, y: 0 }), { kind: 'visual-relation', visualId: structural.visualId });
  assert.deepEqual(picker.semanticIncidence, [sourceEdge]);
  assert.equal(picker.semanticIncidence.some(edge => edge.id === structural.visualId), false);
  assert.throws(() => validateSemanticEdgeCarriers([{ ...sourceEdge, id: structural.visualId }], result, snapshot), /non-source semantic edge carrier/);
});

test('product bridge updates one host and camera in place and stays idle without RAF work', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'b12b-product-'));
  const bundled = join(scratch, 'product.mjs');
  await build({ entryPoints: [new URL('../../src/review/product-view.ts', import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', outfile: bundled });
  Object.assign(globalThis, { WebGLRenderingContext: class {}, WebGL2RenderingContext: class {} });
  const { mountProductProjection } = await import(pathToFileURL(bundled).href) as typeof import('../../src/review/product-view.ts');
  await rm(scratch, { recursive: true, force: true });
  const result = resultFor('2d');
  const source = styled(result);
  const full = mask(result, 1, 1);
  const sparse = mask(result, 2, 0.5, new Set(['node:a']));
  const calls: ProductProjectionInput[] = [];
  let camera: object | null = null;
  let mountedCamera: object | null = null;
  let mounts = 0, updates = 0, rafRequests = 0;
  const renderer: ProductProjectionRenderer = {
    dimension: '2d',
    mount(input) { mounts++; calls.push(input); camera = { x: 1, y: 2, ratio: 1 }; mountedCamera = camera; },
    updateVisibleSubset(input) { updates++; calls.push(input); },
    pickAt() { return { kind: 'visual-relation', visualId: structural.visualId }; },
    destroy() {},
  };
  const priorRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => { rafRequests++; return 1; }) as typeof requestAnimationFrame;
  try {
    const host = mountProductProjection('2d', source, full, snapshot, { '2d': () => renderer, '3d': () => { throw new Error('wrong dimension'); } });
    host.updateVisibleSubset(source, sparse, snapshot);
    assert.equal(mounts, 1);
    assert.equal(updates, 1);
    assert.strictEqual(calls[0]!.visibility, full);
    assert.strictEqual(calls[1]!.visibility, sparse);
    assert.strictEqual(camera, mountedCamera, 'mask revision preserves the camera object created on initial mount');
    assert.equal(host.pickAt({ x: 50, y: 0 }), null, 'a now-hidden structural item is not pickable');
    const next = mask(result, 3, 1);
    host.updateVisibleSubset(source, next, snapshot);
    assert.deepEqual(host.pickAt({ x: 50, y: 0 }), { kind: 'visual-relation', visualId: structural.visualId });
    assert.strictEqual(camera, mountedCamera, 'later revisions keep the original camera');
    assert.equal(mounts, 1);
    assert.equal(updates, 2);
    assert.equal(rafRequests, 0, 'visibility updates do not schedule an idle render loop');
    host.destroy();
  } finally {
    globalThis.requestAnimationFrame = priorRaf;
  }
});
