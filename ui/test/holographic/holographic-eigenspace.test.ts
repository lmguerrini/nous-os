/** G7: component-local Koren coordinates from the symmetric normalised Laplacian. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph, type SpectralGraph } from '../../src/holographic/adjacency.ts';
import { DENSE_DEFAULT_MAX_N, DENSE_SYMMETRIC_SOLVER_VERSION } from '../../src/holographic/dense.ts';
import { spectralGeometry, solveNormalizedComponentBases, type SpectralGeometryCoordinates } from '../../src/holographic/geometry.ts';
import { LANCZOS_SOLVER_VERSION } from '../../src/holographic/lanczos.ts';
import { combineGraphs, completeGraph, cycleGraph, pathGraph, starGraph } from './fixtures.ts';

const options = (dimension: '2d' | '3d' = '2d') => ({ dimension, snapshotDigest: 'synthetic-snapshot', domainDigest: 'synthetic-domain' });
function coordinates(graph: SpectralGraph, dimension: '2d' | '3d' = '2d'): SpectralGeometryCoordinates {
  const outcome = spectralGeometry(graph, options(dimension));
  assert.equal(outcome.kind, 'coordinates', outcome.kind === 'no-coordinates' ? outcome.message : '');
  return outcome as SpectralGeometryCoordinates;
}

function shuffled(graph: SpectralGraph): SpectralGraph {
  const edges = [];
  for (let row = 0; row < graph.size; row += 1)
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1) {
      const neighbor = graph.csrNeighbor[slot]!;
      if (neighbor > row) edges.push({ id: `e${row}-${neighbor}`, source: graph.nodeIds[row]!, target: graph.nodeIds[neighbor]!,
        directed: false, attestation: 'attested' as const, weight: graph.csrWeight[slot]! });
    }
  return buildSpectralGraph({ nodeIds: [...graph.nodeIds].reverse(), edges: edges.reverse() });
}

test('P3 has generalised eigenvalues 0, 1, 2 and known displayed Koren axes', () => {
  const graph = pathGraph(3);
  const solved = solveNormalizedComponentBases(graph, { k: 2 });
  assert.ok(solved.basis);
  assert.deepEqual([...solved.basis.eigenvalues].map(value => Math.round(value * 1e9) / 1e9), [0, 1, 2]);
  for (let mode = 0; mode < solved.basis.count; mode += 1) {
    const u: Float64Array = solved.basis.eigenvectors.subarray(mode * graph.size, (mode + 1) * graph.size);
    const v: Float64Array = Float64Array.from(u, (value: number, i: number) => value / Math.sqrt(graph.degrees[i]!));
    const Lv = graph.applyLaplacian(v);
    for (let i = 0; i < graph.size; i += 1)
      assert.ok(Math.abs(Lv[i]! - solved.basis.eigenvalues[mode]! * graph.degrees[i]! * v[i]!) < 1e-10);
  }
  const displayed = coordinates(graph);
  assert.deepEqual(displayed.clusters.map(cluster => Math.round(cluster.eigenvalueMin)), [1, 2]);
  assert.ok(Math.abs(displayed.positions2![graph.nodeIds[0]!]!.x - 0.5) < 1e-9);
  assert.ok(Math.abs(displayed.positions2![graph.nodeIds[2]!]!.x + 0.5) < 1e-9);
  assert.ok(Math.abs(displayed.positions2![graph.nodeIds[1]!]!.x) < 1e-12);
  assert.match(displayed.explanation.summary, /L v = lambda D v/);
});

test('tied cycle and star modes use canonical probes under solver-basis rotation', () => {
  for (const graph of [cycleGraph(4), starGraph(4)]) {
    const original = coordinates(graph);
    const basis = solveNormalizedComponentBases(graph, { k: graph.size - 1 }).basis!;
    const rotated = new Float64Array(basis.eigenvectors);
    const a = 1; const b = 2;
    const cosine = Math.cos(0.37); const sine = Math.sin(0.37);
    for (let row = 0; row < graph.size; row += 1) {
      const va = basis.eigenvectors[a * graph.size + row]!;
      const vb = basis.eigenvectors[b * graph.size + row]!;
      rotated[a * graph.size + row] = cosine * va + sine * vb;
      rotated[b * graph.size + row] = -sine * va + cosine * vb;
    }
    const after = spectralGeometry(graph, { ...options(), validatedBasis: { ...basis, eigenvectors: rotated } });
    assert.equal(after.kind, 'coordinates');
    assert.deepEqual([...after.coordinates], [...original.coordinates]);
    assert.equal(after.resultDigest, original.resultDigest);
    assert.deepEqual([...coordinates(shuffled(graph)).coordinates], [...original.coordinates]);
  }
  assert.equal(coordinates(cycleGraph(4)).clusters[0]!.multiplicity, 2);
  assert.equal(coordinates(starGraph(4)).clusters[0]!.multiplicity, 3);
});

test('components are packed by size then ID in unit cells with a half-unit gutter', () => {
  const graph = combineGraphs([pathGraph(3), pathGraph(3)], ['d', 'e']);
  const first = coordinates(graph);
  assert.deepEqual([...first.coordinates], [...coordinates(shuffled(graph)).coordinates]);
  assert.equal(first.resultDigest, coordinates(graph).resultDigest);
  const left = graph.components[0]!.memberIndices.map(i => first.coordinates[i]!);
  const right = graph.components[1]!.memberIndices.map(i => first.coordinates[i]!);
  assert.ok(Math.min(...right) - Math.max(...left) >= 0.5 - 1e-9);
  assert.match(first.explanation.summary, /descending size then smallest ID/);
  assert.equal(first.explanation.numericalWitness!.gap, 0.5);
  const mixed = buildSpectralGraph({ nodeIds: ['z', 'a', 'b', 'c'], edges: [{ id: 'ab', source: 'a', target: 'b', directed: false, attestation: 'attested' }] });
  const packed = coordinates(mixed);
  assert.equal(packed.loadedNodeIds.length, 4, 'singletons receive component-cell coordinates');
  assert.equal(packed.positions2!.c!.x, 1.5);
  assert.equal(packed.positions2!.z!.x, 3);
  const refused = spectralGeometry(mixed, { ...options(), priorSolverFailure: 'synthetic failed solve' });
  assert.equal(refused.kind, 'no-coordinates');
  assert.equal(refused.code, 'solver-failure');
  assert.deepEqual(refused.loadedNodeIds, []);
});

test('typed refusal for insufficient connected rank and explicit dense backend above its ceiling', () => {
  const rank = spectralGeometry(pathGraph(3), options('3d'));
  assert.equal(rank.kind, 'no-coordinates');
  assert.equal(rank.code, 'insufficient-rank');
  assert.deepEqual(rank.loadedNodeIds, []);
  const dense = spectralGeometry(pathGraph(DENSE_DEFAULT_MAX_N + 1), { ...options(), backend: 'dense' });
  assert.equal(dense.kind, 'no-coordinates');
  assert.equal(dense.code, 'solver-failure');
  assert.match(dense.message, /dense backend refused/);
  assert.deepEqual(dense.loadedNodeIds, []);
});

test('a degenerate canonical probe and a mismatched shared basis refuse without positions', () => {
  const graph = pathGraph(3);
  const rare = { dimension: '2d' as const, snapshotDigest: 'probe-degeneracy', domainDigest: 'degenerate-8699' };
  const first = spectralGeometry(graph, rare);
  assert.equal(first.kind, 'no-coordinates');
  assert.equal(first.code, 'insufficient-rank');
  assert.deepEqual(first.loadedNodeIds, []);
  assert.equal(first.resultDigest, spectralGeometry(graph, rare).resultDigest);
  const basis = solveNormalizedComponentBases(graph, { k: 2 }).basis!;
  const invalid = spectralGeometry(graph, { ...options(), validatedBasis: { ...basis, n: 4 } });
  assert.equal(invalid.kind, 'no-coordinates');
  assert.equal(invalid.code, 'solver-failure');
  assert.ok(!('positions2' in invalid));
});

test('the backend cap keeps the normalised solve deterministic on both sides', () => {
  const dense = coordinates(pathGraph(DENSE_DEFAULT_MAX_N));
  const sparseGraph = pathGraph(DENSE_DEFAULT_MAX_N + 1);
  const sparse = coordinates(sparseGraph);
  assert.equal(dense.solver.solverVersion, DENSE_SYMMETRIC_SOLVER_VERSION);
  assert.equal(sparse.solver.solverVersion, LANCZOS_SOLVER_VERSION);
  assert.equal(sparse.resultDigest, coordinates(sparseGraph).resultDigest);
  assert.ok(sparse.solver.relativeResidualMax! < 1e-8);
});

test('the canonical policy gives genuine 3D coordinates on a high-degree hub', () => {
  const graph = starGraph(81);
  const result = coordinates(graph, '3d');
  assert.equal(result.clusters[0]!.multiplicity, 80);
  assert.equal(result.clusters[0]!.selectedAxes, 3);
  assert.deepEqual([...result.coordinates], [...coordinates(shuffled(graph), '3d').coordinates]);
  assert.ok(result.positions3 && Object.values(result.positions3).every(point =>
    point !== undefined && [point.x, point.y, point.z].every(Number.isFinite)));
});

test('a tied complete graph gives a whole isolated nonzero cluster', () => {
  const result = coordinates(completeGraph(5), '3d');
  assert.equal(result.clusters[0]!.multiplicity, 4);
  assert.equal(result.clusters[0]!.selectedAxes, 3);
});
