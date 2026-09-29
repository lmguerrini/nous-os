import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph, type SpectralEdge } from '../../src/holographic/adjacency.ts';
import { cycleGraph, combineGraphs, completeGraph, noiseVector, pathGraph, ringLatticeGraph, starGraph } from './fixtures.ts';

function laplacianColumns(graph: ReturnType<typeof buildSpectralGraph>): Float64Array[] {
  const columns: Float64Array[] = [];
  for (let index = 0; index < graph.size; index += 1) {
    const basis = new Float64Array(graph.size);
    basis[index] = 1;
    columns.push(graph.applyLaplacian(basis));
  }
  return columns;
}

test('the unweighted attested path of three nodes has the exact Laplacian [[1,-1,0],[-1,2,-1],[0,-1,1]]', () => {
  const graph = pathGraph(3);
  const columns = laplacianColumns(graph);
  const expected = [
    [1, -1, 0],
    [-1, 2, -1],
    [0, -1, 1],
  ];
  for (let col = 0; col < 3; col += 1) {
    assert.deepEqual(Array.from(columns[col]!), expected.map((row) => row[col]!));
  }
  assert.deepEqual(Array.from(graph.degrees), [1, 2, 1]);
  assert.equal(graph.componentCount, 1);
});

test('nodes are stored in codepoint order regardless of input order', () => {
  const graph = buildSpectralGraph({
    nodeIds: ['z-node', 'a-node', 'm-node'],
    edges: [{ id: 'e1', source: 'a-node', target: 'm-node', directed: false, attestation: 'attested' }],
  });
  assert.deepEqual(graph.nodeIds, ['a-node', 'm-node', 'z-node']);
  assert.equal(graph.indexOf.get('z-node'), 2);
});

test('row sums of L are zero and A is symmetric on weighted, directed and parallel fixtures', () => {
  const graph = buildSpectralGraph({
    nodeIds: ['a', 'b', 'c', 'd'],
    weightPolicy: 'attested-explicit-v1',
    edges: [
      { id: 'w1', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 0.7 },
      { id: 'w2', source: 'b', target: 'c', directed: true, attestation: 'attested', weight: 2 },
      { id: 'w3', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 1.3 },
      { id: 'w4', source: 'c', target: 'd', directed: false, attestation: 'attested', weight: 0.25 },
    ],
  });
  const ones = new Float64Array(graph.size).fill(1);
  const rowSums = graph.applyLaplacian(ones);
  for (const value of rowSums) assert.ok(Math.abs(value) < 1e-12);
  const x = noiseVector(graph.size, 'sym-a');
  const y = noiseVector(graph.size, 'sym-b');
  const left = dot(x, graph.applyAdjacency(y));
  const right = dot(graph.applyAdjacency(x), y);
  assert.ok(Math.abs(left - right) < 1e-12);
});

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!;
  return sum;
}

test('x^T L x equals the edge sum of A_ij (x_i - x_j)^2 and is nonnegative', () => {
  for (const graph of [pathGraph(7), cycleGraph(12), starGraph(9), completeGraph(8), ringLatticeGraph(30, 'quad', 2)]) {
    for (let trial = 0; trial < 3; trial += 1) {
      const x = noiseVector(graph.size, `quad-${trial}`);
      const viaL = dot(x, graph.applyLaplacian(x));
      const viaEdges = graph.quadraticForm(x);
      assert.ok(Math.abs(viaL - viaEdges) < 1e-9 * Math.max(1, Math.abs(viaEdges)));
      assert.ok(viaEdges >= 0);
    }
  }
});

test('exploratory edges stay in their own channel and never enter L', () => {
  const graph = buildSpectralGraph({
    nodeIds: ['a', 'b', 'c'],
    edges: [
      { id: 'att-1', source: 'a', target: 'b', directed: false, attestation: 'attested' },
      { id: 'exp-1', source: 'b', target: 'c', directed: false, attestation: 'exploratory' },
      { id: 'exp-2', source: 'a', target: 'c', directed: true, attestation: 'exploratory' },
    ],
  });
  assert.equal(graph.attestedEdgeCount, 1);
  assert.equal(graph.exploratoryEdgeCount, 2);
  assert.deepEqual(graph.exploratoryChannel.map((edge) => edge.id), ['exp-2', 'exp-1']);
  assert.deepEqual(Array.from(graph.degrees), [1, 1, 0]);
  assert.equal(graph.componentCount, 2);
  assert.deepEqual(graph.components.map((component) => component.smallestNodeId), ['a', 'c']);
});

test('weights, directed symmetrisation, parallel edges and self-loops follow the declared policy', () => {
  const weighted = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'w', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 3 }],
  });
  assert.deepEqual(Array.from(weighted.degrees), [3, 3]);
  assert.equal(weighted.totalAttestedWeight, 3);
  assert.equal(weighted.spectralNormBound, 6);

  const directed = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'd', source: 'a', target: 'b', directed: true, attestation: 'attested', weight: 2 }],
  });
  assert.deepEqual(Array.from(directed.degrees), [1, 1]);
  assert.deepEqual(Array.from(directed.csrWeight), [1, 1]);

  const parallel = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    edges: [
      { id: 'p1', source: 'a', target: 'b', directed: false, attestation: 'attested' },
      { id: 'p2', source: 'a', target: 'b', directed: false, attestation: 'attested' },
    ],
  });
  assert.equal(parallel.weightPolicy, 'attested-unit-v1');
  assert.deepEqual(Array.from(parallel.degrees), [2, 2]);

  const selfLoop = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [
      { id: 'loop', source: 'a', target: 'a', directed: false, attestation: 'attested', weight: 7 },
      { id: 'ab', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 1 },
    ],
  });
  assert.equal(selfLoop.excludedSelfLoopCount, 1);
  assert.deepEqual(Array.from(selfLoop.degrees), [1, 1]);
});

test('the component ledger orders components by smallest ID and members by index', () => {
  const twoPaths = combineGraphs([pathGraph(3), pathGraph(3)], ['x1', 'x2']);
  assert.equal(twoPaths.componentCount, 2);
  assert.deepEqual(twoPaths.components.map((component) => component.smallestNodeId), ['x1n0000', 'x2n0000']);
  for (const component of twoPaths.components) {
    assert.deepEqual([...component.memberIndices], [...component.memberIndices].sort((a, b) => a - b));
    for (const index of component.memberIndices) assert.equal(twoPaths.componentOf[index], component.index);
  }

  const isolated = buildSpectralGraph({
    nodeIds: ['s3', 's1', 's2'],
    edges: [],
  });
  assert.equal(isolated.componentCount, 3);
  assert.deepEqual(isolated.components.map((component) => component.smallestNodeId), ['s1', 's2', 's3']);
  assert.equal(isolated.spectralNormBound, 0);
});

test('input permutations produce identical canonical structures', () => {
  const nodes = ['q', 'a', 'z', 'm', 'b'];
  const edges: SpectralEdge[] = [
    { id: 'e2', source: 'a', target: 'm', directed: false, attestation: 'attested' },
    { id: 'e1', source: 'a', target: 'b', directed: false, attestation: 'attested' },
    { id: 'e3', source: 'm', target: 'z', directed: false, attestation: 'attested' },
    { id: 'x1', source: 'q', target: 'z', directed: true, attestation: 'exploratory' },
  ];
  const first = buildSpectralGraph({ nodeIds: nodes, edges });
  const second = buildSpectralGraph({ nodeIds: [...nodes].reverse(), edges: [...edges].reverse() });
  assert.deepEqual(first.degrees, second.degrees);
  assert.deepEqual(first.csrNeighbor, second.csrNeighbor);
  assert.deepEqual(first.csrWeight, second.csrWeight);
  assert.deepEqual(first.csrRowStart, second.csrRowStart);
  assert.deepEqual(first.applyLaplacian(noiseVector(5, 'perm')), second.applyLaplacian(noiseVector(5, 'perm')));
  assert.deepEqual(first.exploratoryChannel, second.exploratoryChannel);
});

test('invalid inputs are refused with typed errors', () => {
  const base: SpectralEdge[] = [{ id: 'e', source: 'a', target: 'b', directed: false, attestation: 'attested' }];
  assert.throws(() => buildSpectralGraph({ nodeIds: [], edges: [] }), /at least one node/);
  assert.throws(() => buildSpectralGraph({ nodeIds: ['a', 'a'], edges: [] }), /duplicate node ID/);
  assert.throws(() => buildSpectralGraph({ nodeIds: ['a'], edges: [{ ...base[0]!, target: 'ghost' }] }), /outside the analytical domain/);
  assert.throws(() => buildSpectralGraph({ nodeIds: ['a', 'b'], edges: [...base, { ...base[0]!, id: 'e' }] }), /duplicate edge ID/);
  assert.throws(() => buildSpectralGraph({ nodeIds: ['a', 'b'], edges: [{ ...base[0]!, weight: 0 }] }), /nonfinite or nonpositive weight/);
  assert.throws(() => buildSpectralGraph({ nodeIds: ['a', 'b'], edges: [{ ...base[0]!, attestation: 'canonical' as SpectralEdge['attestation'] }] }), /attestation/);
  assert.throws(
    () => buildSpectralGraph({ nodeIds: ['a', 'b'], weightPolicy: 'attested-unit-v1', edges: [{ ...base[0]!, weight: 2 }] }),
    /explicit edge weights need the attested-explicit-v1/,
  );
});

test('ledger totals count attested weight and edges separately from the exploratory channel', () => {
  const graph = completeGraph(5);
  assert.equal(graph.attestedEdgeCount, 10);
  assert.equal(graph.totalAttestedWeight, 10);
  assert.equal(graph.excludedSelfLoopCount, 0);
});
