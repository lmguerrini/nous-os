import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validatePickResult, validateProjectionResult, validateRenderVisibility,
  validateSemanticEdgeCarriers,
} from '../../src/projection/contract.ts';
import type {
  AnalyticalDomain, ProjectionRequest, ProjectionResult, RenderVisibility, SemanticGraphSnapshot,
} from '../../src/projection/contract-types.ts';

const nodeIds = ['n:a', 'n:b', 'n:c'];
const rawEdges = [
  { id: 'e:ab', source: 'n:a', target: 'n:b' },
  { id: 'e:bc', source: 'n:b', target: 'n:c' },
  { id: 'e:ac', source: 'n:a', target: 'n:c' },
];
const snapshot = {
  digest: 'snapshot-1', rawLedger: { canonicalBytesDigest: 'ledger-1', nodes: [{}, {}, {}], edges: [{}, {}, {}], details: [] },
  nodes: nodeIds.map(id => ({ id })), edges: rawEdges,
} as unknown as SemanticGraphSnapshot;
const domain = {
  snapshotDigest: 'snapshot-1', domainDigest: 'domain-1', nodeIds,
  edgeIds: rawEdges.map(edge => edge.id), selectionPolicy: 'fixture', selectionPolicyVersion: 'v1',
  levelPolicy: 'fixture', maxNodes: 3,
} satisfies AnalyticalDomain;
const request = {
  id: 'indras-pearls', snapshotDigest: 'snapshot-1', domain,
  parameters: { dimension: '2d', maxDepth: 1, maxWords: 2, generatorPolicy: 'fixture',
    tolerance: 1e-8, expandZ: 1 },
} satisfies ProjectionRequest<'indras-pearls'>;
const witnesses = {
  levels: {
    root: { memberNodeIds: ['n:a', 'n:b'], memberDigest: 'members-ab' },
    child: { memberNodeIds: ['n:c'], memberDigest: 'members-c' },
  },
  liftedRouteEdgeIds: { 'visual:route': ['e:ab', 'e:bc'] },
};
const context = { snapshot, domain, request, witnesses };
const explanation = (id: string) => ({ elementId: id, elementKind: 'visual-relation' as const,
  summary: 'synthetic fixture', sourceIds: [], parameterIds: [] });

function result(): ProjectionResult {
  return {
    determinism: { snapshotDigest: 'snapshot-1', domainDigest: 'domain-1', algorithmId: 'indras-pearls',
      algorithmVersion: 'test-v1', parameterHash: 'parameters-1', numericBackendVersion: 'test', resultDigest: 'result-1' },
    fullLedger: { snapshotDigest: 'snapshot-1', canonicalBytesDigest: 'ledger-1', nodeCount: 3, edgeCount: 3, loadedDetailCount: 0 },
    domainNodeIds: nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: ['n:a', 'n:b'],
    positions2: { 'n:a': { x: 1, y: 2 }, 'n:b': { x: 3, y: 4 } },
    containers: [{ visualId: 'visual:closed', parentVisualId: null, memberCount: 1, shape: 'circle', levelId: 'child' }],
    visualRelations: [
      { visualId: 'visual:route', kind: 'lifted-route', semantic: false, source: 'n:a', target: 'n:b',
        underlyingEdgeIds: ['e:ab', 'e:bc'], count: 2, explanationId: 'visual:route' },
      { visualId: 'visual:co', kind: 'co-membership', semantic: false, source: 'n:a', target: 'n:b',
        underlyingEdgeIds: [], count: 1, explanationId: 'visual:co' },
      { visualId: 'visual:contain', kind: 'synthetic-containment', semantic: false, source: 'n:a', target: 'n:b',
        underlyingEdgeIds: [], count: 1, explanationId: 'visual:contain' },
    ],
    curves: [], fields: [],
    levels: [
      { id: 'root', parentId: null, depth: 0, maxDepth: 1, loaded: true, childLevelIds: ['child'],
        memberCount: 2, memberDigest: 'members-ab', memberNodeIds: ['n:a', 'n:b'], inducedEdgeIds: ['e:ab'] },
      { id: 'child', parentId: 'root', depth: 1, maxDepth: 1, loaded: false, childLevelIds: [],
        memberCount: 1, memberDigest: 'members-c', loadToken: { snapshotDigest: 'snapshot-1', domainDigest: 'domain-1',
          projectionId: 'indras-pearls', parameterHash: 'parameters-1', levelId: 'child' } },
    ],
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {}, maxVisibleNodes: 2,
      maxVisibleSemanticEdges: 1, maxVisibleVisualRelations: 3, maxVisibleCurves: 0,
      maxVisibleContainers: 1, maxVisibleFields: 0, progressiveLevelIds: ['child'] },
    explanations: Object.fromEntries(['visual:route', 'visual:co', 'visual:contain', 'visual:closed']
      .map(id => [id, explanation(id)])),
    diagnostics: [], coordinateState: { kind: 'coordinates' },
  };
}

function altered(edit: (copy: any) => void): ProjectionResult {
  const copy = structuredClone(result());
  edit(copy);
  return copy;
}

test('partial dimensional result accepts loaded coordinates and unopened token without positions', () => {
  assert.doesNotThrow(() => validateProjectionResult(result(), context));
  assert.throws(() => validateProjectionResult(altered(r => { r.positions2['n:c'] = { x: 0, y: 0 }; }), context), /coordinate keys/);
  assert.throws(() => validateProjectionResult(altered(r => { delete r.positions2['n:b']; }), context), /coordinate keys/);
  assert.throws(() => validateProjectionResult(altered(r => { r.positions3 = {}; }), context), /dimensional/);
  assert.throws(() => validateProjectionResult(altered(r => { r.positions2['n:a'].x = Infinity; }), context), /finite/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[1].memberNodeIds = ['n:c']; }), context), /unloaded level/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[1].loadToken.domainDigest = 'stale'; }), context), /stale load token/);
  assert.throws(() => validateProjectionResult(altered(r => { r.containers[0].center2 = { x: 0, y: 0 }; }), context), /unloaded container/);
});

test('loaded level verifies independent members, count, digest and exact induced edges', () => {
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[0].memberNodeIds = ['n:a', 'n:c']; }), context), /exact set/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[0].inducedEdgeIds = ['e:ac']; }), context), /exact set/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[0].memberCount = 3; }), context), /count mismatch/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[0].memberDigest = 'wrong'; }), context), /digest mismatch/);
  assert.throws(() => validateProjectionResult(altered(r => { r.levels[1].parentId = 'child'; }), context), /invalid (parent|child)/);
});

test('opening a lazy level adds exactly its declared coordinates and induced edges', () => {
  const opened = altered(r => {
    r.loadedNodeIds = ['n:a', 'n:b', 'n:c'];
    r.positions2['n:c'] = { x: 5, y: 6 };
    r.levels[1] = { id: 'child', parentId: 'root', depth: 1, maxDepth: 1, loaded: true,
      childLevelIds: [], memberCount: 1, memberDigest: 'members-c', memberNodeIds: ['n:c'], inducedEdgeIds: [] };
    r.containers[0].memberNodeIds = ['n:c'];
    r.determinism.resultDigest = 'result-open';
  });
  assert.doesNotThrow(() => validateProjectionResult(opened, context));
  assert.throws(() => validateProjectionResult({ ...opened, positions2: { 'n:a': { x: 1, y: 2 }, 'n:b': { x: 3, y: 4 } } }, context), /coordinate keys/);
  assert.throws(() => validateProjectionResult({ ...opened, levels: [{ ...opened.levels[0]!, inducedEdgeIds: ['e:ab', 'e:ac'] }, opened.levels[1]!] } as ProjectionResult, context), /exact set/);
});

test('3D accepts only finite coordinates in the 3D map', () => {
  const volume = altered(r => {
    delete r.positions2;
    r.positions3 = { 'n:a': { x: 1, y: 2, z: 3 }, 'n:b': { x: 4, y: 5, z: 6 } };
  });
  const volumeContext = { ...context, request: { ...request, parameters: { ...request.parameters, dimension: '3d' as const } } };
  assert.doesNotThrow(() => validateProjectionResult(volume, volumeContext));
  assert.throws(() => validateProjectionResult({ ...volume, positions3: { ...volume.positions3,
    'n:a': { x: 1, y: 2, z: Number.NaN } } }, volumeContext), /finite/);
});

test('Holographic refusal has no coordinates, positioned visuals, or loaded nodes', () => {
  const refused = altered(r => {
    r.determinism.algorithmId = 'holographic'; r.loadedNodeIds = [];
    delete r.positions2; r.levels = []; r.containers = []; r.visualRelations = [];
    r.coordinateState = { kind: 'no-coordinates', code: 'ambiguous-eigenspace', explanationId: 'refusal' };
    r.diagnostics = [{ code: 'ambiguous-eigenspace', value: 'tied eigenvalues', acceptable: false }];
    r.explanations = { refusal: explanation('refusal') };
    r.lod.progressiveLevelIds = []; r.lod.priorityByContainerId = {};
  });
  const holo = { ...context, request: { id: 'holographic' as const, snapshotDigest: 'snapshot-1', domain,
    parameters: { dimension: '2d' as const, modes: 2, restartSize: 4, maxRestarts: 8,
      eigenTolerance: 1e-8, eigenspacePolicyVersion: 'projector-probe-v1' as const,
      heatTimes: [1], ridge: 0, signalId: 'importance' } },
    witnesses: { levels: {}, liftedRouteEdgeIds: {} } };
  assert.doesNotThrow(() => validateProjectionResult(refused, holo));
  assert.throws(() => validateProjectionResult({ ...refused, positions2: {} }, holo), /no-coordinate refusal/);
  assert.throws(() => validateProjectionResult({ ...refused, loadedNodeIds: ['n:a'] }, holo), /no-coordinate refusal/);
  assert.throws(() => validateProjectionResult({ ...refused, diagnostics: [] }, holo), /diagnostic/);
});

test('visual relations require complete source contributors and remain outside semantic carriers', () => {
  assert.throws(() => validateProjectionResult(altered(r => { r.visualRelations[0].underlyingEdgeIds = ['e:ab']; }), context), /exact set/);
  assert.throws(() => validateProjectionResult(altered(r => { r.visualRelations[0].underlyingEdgeIds = ['e:ab', 'fake']; }), context), /unknown ID/);
  assert.throws(() => validateProjectionResult(altered(r => { r.visualRelations[1].semantic = true; }), context), /became semantic/);
  assert.throws(() => validateProjectionResult(altered(r => { r.visualRelations[2].visualId = 'e:ab'; }), context), /namespace/);
  assert.doesNotThrow(() => validateSemanticEdgeCarriers([rawEdges[0]!], result(), snapshot));
  for (const id of ['visual:co', 'visual:contain']) {
    assert.throws(() => validateSemanticEdgeCarriers([{ id, source: 'n:a', target: 'n:b' }], result(), snapshot),
      /non-source semantic edge carrier/);
  }
  assert.throws(() => validateSemanticEdgeCarriers([{ id: 'e:ab', source: 'n:b', target: 'n:a' }], result(), snapshot), /non-source/);
});

test('six-class visibility and typed picks do not conflate visual relations with edges', () => {
  const visibility: RenderVisibility = { projectionResultDigest: 'result-1', revision: 1, levelIds: new Set(['root']),
    density: 0.5, nodeIds: new Set(['n:a', 'n:b']), semanticEdgeIds: new Set(['e:ab']),
    visualRelationIds: new Set(['visual:co']), curveIds: new Set(), containerIds: new Set(['visual:closed']), fieldIds: new Set() };
  assert.doesNotThrow(() => validateRenderVisibility(result(), visibility, snapshot));
  assert.doesNotThrow(() => validatePickResult(result(), { kind: 'visual-relation', visualId: 'visual:co' }));
  assert.throws(() => validatePickResult(result(), { kind: 'semantic-edge', id: 'visual:co' }), /unknown semantic edge/);
  assert.throws(() => validateRenderVisibility(result(), { ...visibility, semanticEdgeIds: new Set(['visual:co']) }, snapshot), /unknown ID/);
  assert.throws(() => validateRenderVisibility(result(), { ...visibility, nodeIds: new Set(['n:a']) }, snapshot), /hidden endpoint/);
});

test('all six visibility classes have independent collections and caps', () => {
  const rich = altered(r => {
    r.curves = [{ visualId: 'visual:curve', purpose: 'relation-routing',
      points2: [{ x: 1, y: 2 }, { x: 3, y: 4 }], visualRelationId: 'visual:co' }];
    r.fields = [{ id: 'visual:field', kind: 'scalar', domain: 'node', values: [1], sampleIds: ['n:a'], units: 'u' }];
    r.lod.maxVisibleCurves = 1; r.lod.maxVisibleFields = 1;
  });
  assert.doesNotThrow(() => validateProjectionResult(rich, context));
  const visibility: RenderVisibility = { projectionResultDigest: 'result-1', revision: 3, levelIds: new Set(['root']),
    density: 1, nodeIds: new Set(['n:a', 'n:b']), semanticEdgeIds: new Set(['e:ab']),
    visualRelationIds: new Set(['visual:co']), curveIds: new Set(['visual:curve']),
    containerIds: new Set(['visual:closed']), fieldIds: new Set(['visual:field']) };
  assert.doesNotThrow(() => validateRenderVisibility(rich, visibility, snapshot));
  assert.throws(() => validateRenderVisibility(rich, { ...visibility, visualRelationIds: new Set() }, snapshot), /hidden relation/);
  assert.throws(() => validateRenderVisibility(rich, { ...visibility, fieldIds: new Set(['visual:curve']) }, snapshot), /unknown ID/);
  assert.throws(() => validateRenderVisibility({ ...rich, lod: { ...rich.lod, maxVisibleFields: 0 } }, visibility, snapshot), /cap exceeded/);
});
