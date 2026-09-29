import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareProjection2d, projection2dRevisionAction, projection2dVisibilityKey } from '../../src/render2d/model.ts';
import type { ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';

const snapshot = {
  digest: 'snapshot',
  edges: [{ id: 'edge', source: 'a', target: 'b', attestation: 'attested' }],
} as unknown as SemanticGraphSnapshot;
const result: ProjectionResult = {
  determinism: { snapshotDigest: 'snapshot', domainDigest: 'domain', algorithmId: 'natural',
    algorithmVersion: 'v1', parameterHash: 'params', numericBackendVersion: 'test', resultDigest: 'result' },
  fullLedger: { snapshotDigest: 'snapshot', canonicalBytesDigest: 'ledger', nodeCount: 2, edgeCount: 1, loadedDetailCount: 0 },
  domainNodeIds: ['a', 'b'], domainEdgeIds: ['edge'], loadedNodeIds: ['a', 'b'],
  positions2: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
  containers: [{ visualId: 'visual:container', parentVisualId: null, memberCount: 2, shape: 'circle',
    center2: { x: 5, y: 0 }, radius: 6, levelId: 'root' }],
  visualRelations: [
    { visualId: 'visual:co', kind: 'co-membership', semantic: false, source: 'a', target: 'b',
      underlyingEdgeIds: [], count: 1, explanationId: 'visual:co' },
    { visualId: 'visual:contains', kind: 'synthetic-containment', semantic: false, source: 'a', target: 'b',
      underlyingEdgeIds: [], count: 1, explanationId: 'visual:contains' },
  ],
  curves: [{ visualId: 'visual:curve', purpose: 'relation-routing', points2: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    visualRelationId: 'visual:co' }],
  fields: [{ id: 'visual:field', kind: 'scalar', domain: 'node', values: [1], sampleIds: ['a'], units: 'u' }],
  levels: [{ id: 'root', parentId: null, depth: 0, maxDepth: 0, loaded: true, childLevelIds: [],
    memberCount: 2, memberDigest: 'members', memberNodeIds: ['a', 'b'], inducedEdgeIds: ['edge'] }],
  lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
    priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {}, maxVisibleNodes: 2,
    maxVisibleSemanticEdges: 1, maxVisibleVisualRelations: 2, maxVisibleCurves: 1,
    maxVisibleContainers: 1, maxVisibleFields: 1, progressiveLevelIds: [] },
  explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' },
};
const styled: StyledProjection = { projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} };
const full: RenderVisibility = {
  projectionResultDigest: 'result', revision: 1, density: 1, levelIds: new Set(['root']),
  nodeIds: new Set(['a', 'b']), semanticEdgeIds: new Set(['edge']),
  visualRelationIds: new Set(['visual:co', 'visual:contains']), curveIds: new Set(['visual:curve']),
  containerIds: new Set(['visual:container']), fieldIds: new Set(['visual:field']),
};

test('typed 2D scene retains six independent visibility classes and source edge identity', () => {
  const scene = prepareProjection2d(snapshot, styled, full);
  assert.deepEqual([...scene.semanticEdges.keys()], ['edge']);
  assert.deepEqual([...scene.visualRelations.keys()], ['visual:co', 'visual:contains']);
  assert.equal(scene.visualRelations.get('visual:co')?.underlyingEdgeIds.length, 0);
  assert.equal(scene.visualRelations.get('visual:contains')?.semantic, false);
  assert.equal(scene.curves.size, 1);
  assert.equal(scene.containers.size, 1);
  assert.equal(scene.fields.size, 1);
  const sparse = prepareProjection2d(snapshot, styled, { ...full, revision: 2, density: 0,
    semanticEdgeIds: new Set(), visualRelationIds: new Set(), curveIds: new Set(),
    containerIds: new Set(), fieldIds: new Set() });
  assert.equal(sparse.semanticEdges.size, 0);
  assert.equal(sparse.visualRelations.size, 0);
  assert.equal(sparse.curves.size, 0);
  assert.equal(sparse.containers.size, 0);
  assert.equal(sparse.fields.size, 0);
  assert.equal(sparse.nodes.size, 2);
});

test('typed 2D scene rejects class confusion, hidden endpoints, and missing coordinates', () => {
  assert.throws(() => prepareProjection2d(snapshot, styled, { ...full,
    semanticEdgeIds: new Set(['visual:co']) }), /unknown ID/);
  assert.throws(() => prepareProjection2d(snapshot, styled, { ...full,
    nodeIds: new Set(['a']) }), /hidden endpoint/);
  const missing = { ...result, positions2: { a: { x: 0, y: 0 } } };
  assert.throws(() => prepareProjection2d(snapshot, { ...styled, projection: missing }, full), /no 2D position/);
});

test('visibility key ignores set order and detects equal-revision content changes', () => {
  const reordered = { ...full, nodeIds: new Set(['b', 'a']),
    visualRelationIds: new Set(['visual:contains', 'visual:co']) };
  assert.equal(projection2dVisibilityKey(styled, full), projection2dVisibilityKey(styled, reordered));
  assert.notEqual(projection2dVisibilityKey(styled, full),
    projection2dVisibilityKey(styled, { ...full, fieldIds: new Set() }));
  const key = projection2dVisibilityKey(styled, full);
  assert.equal(projection2dRevisionAction(2, key, 1, 'stale'), 'stale');
  assert.equal(projection2dRevisionAction(2, key, 2, key), 'same');
  assert.throws(() => projection2dRevisionAction(2, key, 2, 'changed'), /equal projection visibility/);
  assert.equal(projection2dRevisionAction(2, key, 3, 'changed'), 'apply');
});
