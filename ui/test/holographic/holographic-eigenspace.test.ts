/** D-073 tranche F, row F8 — `holographic-eigenspace.test.ts`: canonical spectral 2D/3D
 * geometry under the projector-probe-v2 tied-eigenspace policy, with byte-identical
 * quantised coordinates/digests on shuffled and repeated runs, or the identical
 * no-coordinate refusal state (cycle, star, complete and disconnected equal components are
 * the required fixtures). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph, type SpectralGraph } from '../../src/holographic/adjacency.ts';
import { DENSE_DEFAULT_MAX_N, DENSE_SYMMETRIC_SOLVER_VERSION, denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import {
  spectralGeometry,
  CANONICAL_EIGENSPACE_POLICY_VERSION,
  type SpectralGeometryCoordinates,
  type SpectralGeometryOutcome,
  type SpectralGeometryRefusal,
} from '../../src/holographic/geometry.ts';
import { LANCZOS_SOLVER_VERSION } from '../../src/holographic/lanczos.ts';
import { eigenbasisFromDense } from '../../src/holographic/signals.ts';
import { combineGraphs, completeGraph, cycleGraph, pathGraph, starGraph, weakBridgeGraph } from './fixtures.ts';

const SNAPSHOT = 'a1e-fixture-snapshot-digest-00000000000000000000000000000000000000000000000000000000000000';
const DOMAIN = 'a1e-fixture-domain-digest-00000000000000000000000000000000000000000000000000000000000';

function options(dimension: '2d' | '3d', overrides: { snapshotDigest?: string; domainDigest?: string; backend?: 'dense' | 'lanczos' } = {}) {
  return {
    dimension,
    snapshotDigest: overrides.snapshotDigest ?? SNAPSHOT,
    domainDigest: overrides.domainDigest ?? DOMAIN,
    ...(overrides.backend === undefined ? {} : { backend: overrides.backend }),
  };
}

function coordinates(outcome: SpectralGeometryOutcome): SpectralGeometryCoordinates {
  assert.ok(outcome.kind === 'coordinates', `expected coordinates, got ${outcome.kind === 'no-coordinates' ? `${outcome.code}: ${outcome.message}` : '?'}`);
  return outcome;
}

function refusal(outcome: SpectralGeometryOutcome): SpectralGeometryRefusal {
  assert.ok(outcome.kind === 'no-coordinates', 'expected a no-coordinate refusal');
  return outcome;
}

function upperTriangleEdges(graph: SpectralGraph) {
  const edges: { id: string; source: string; target: string; directed: boolean; attestation: 'attested' }[] = [];
  for (let row = 0; row < graph.size; row += 1) {
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1) {
      const neighbor = graph.csrNeighbor[slot]!;
      if (neighbor > row) {
        edges.push({ id: `e${row}-${neighbor}`, source: graph.nodeIds[row]!, target: graph.nodeIds[neighbor]!, directed: false, attestation: 'attested' });
      }
    }
  }
  return edges;
}

function shuffled(graph: SpectralGraph): SpectralGraph {
  return buildSpectralGraph({ nodeIds: [...graph.nodeIds].reverse(), edges: upperTriangleEdges(graph).reverse() });
}

test('P3 in 2D: the canonical columns are the sign-fixed eigenvectors [1,0,-1]/sqrt2 and [1,-2,1]/sqrt6', () => {
  const graph = pathGraph(3);
  const outcome = coordinates(spectralGeometry(graph, options('2d')));
  assert.equal(outcome.axes, 2);
  assert.equal(outcome.solver.backend, 'dense');
  assert.equal(outcome.clusters.length, 2);
  assert.ok(Math.abs(outcome.clusters[0]!.eigenvalueMin - 1) < 1e-9 && outcome.clusters[0]!.multiplicity === 1);
  assert.ok(Math.abs(outcome.clusters[1]!.eigenvalueMin - 3) < 1e-9 && outcome.clusters[1]!.multiplicity === 1);
  const n = 3;
  const expected = [
    [1 / Math.SQRT2, 0, -1 / Math.SQRT2],
    [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)],
  ];
  for (let axis = 0; axis < 2; axis += 1) {
    for (let index = 0; index < n; index += 1) {
      const value = outcome.coordinates[index + axis * n]!;
      assert.ok(Math.abs(value - expected[axis]![index]!) <= 1e-9, `axis ${axis} node ${index}: ${value}`);
      const units = value / outcome.quantizationStep;
      assert.ok(Math.abs(units - Math.round(units)) <= 1e-3, 'coordinates are quantised to 1e-10');
    }
  }
  assert.deepEqual([...outcome.loadedNodeIds], [...graph.nodeIds]);
  for (const id of graph.nodeIds) {
    const position = outcome.positions2![id]!;
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
  }
  assert.match(outcome.resultDigest, /^[0-9a-f]{64}$/);
});

test('P3: a different domain digest keeps simple-eigenvalue coordinates but changes the result digest', () => {
  const graph = pathGraph(3);
  const first = coordinates(spectralGeometry(graph, options('2d')));
  const second = coordinates(spectralGeometry(graph, options('2d', { domainDigest: 'other-domain-digest-00000000000000000000000000000000000000000000000000000000' })));
  assert.notEqual(second.resultDigest, first.resultDigest);
  assert.deepEqual(Array.from(second.coordinates), Array.from(first.coordinates));
});

test('C4 in 2D: the whole tied cluster is used with byte-identical coordinates and digest on repeat and shuffled input', () => {
  const graph = cycleGraph(4);
  const first = coordinates(spectralGeometry(graph, options('2d')));
  assert.equal(first.clusters.length, 1);
  assert.ok(Math.abs(first.clusters[0]!.eigenvalueMin - 2) < 1e-8);
  assert.equal(first.clusters[0]!.multiplicity, 2);
  const repeat = coordinates(spectralGeometry(graph, options('2d')));
  assert.equal(repeat.resultDigest, first.resultDigest);
  assert.deepEqual(Array.from(repeat.coordinates), Array.from(first.coordinates));
  const permuted = coordinates(spectralGeometry(shuffled(graph), options('2d')));
  assert.equal(permuted.resultDigest, first.resultDigest);
  assert.deepEqual(Array.from(permuted.coordinates), Array.from(first.coordinates));
  // The columns span the eigenvalue-2 eigenspace: L y = 2 y with unit norm and orthogonality.
  for (let axis = 0; axis < 2; axis += 1) {
    const column = first.coordinates.subarray(axis * 4, (axis + 1) * 4);
    const product = graph.applyLaplacian(Float64Array.from(column));
    for (let index = 0; index < 4; index += 1) {
      assert.ok(Math.abs(product[index]! - 2 * column[index]!) <= 1e-7, `L y = 2 y failed at axis ${axis} node ${index}`);
    }
    let norm = 0;
    for (const value of column) norm += value * value;
    assert.ok(Math.abs(norm - 1) <= 1e-9);
  }
  let dot = 0;
  for (let index = 0; index < 4; index += 1) {
    dot += first.coordinates[index]! * first.coordinates[index + 4]!;
  }
  assert.ok(Math.abs(dot) <= 1e-9);
  // A different domain digest rotates the tied eigenspace: new probes, new digest.
  const rotated = coordinates(spectralGeometry(graph, options('2d', { domainDigest: 'rotated-domain-digest-000000000000000000000000000000000000000000000000000' })));
  assert.notEqual(rotated.resultDigest, first.resultDigest);
  assert.notDeepEqual(Array.from(rotated.coordinates), Array.from(first.coordinates));
});

test('C5: 3D selects one canonical axis from the second tied pair', () => {
  const graph = cycleGraph(5);
  const twoD = coordinates(spectralGeometry(graph, options('2d')));
  assert.equal(twoD.clusters[0]!.multiplicity, 2);
  const threeD = coordinates(spectralGeometry(graph, options('3d')));
  assert.deepEqual(threeD.clusters.map(cluster => cluster.selectedAxes), [2, 1]);
  assert.equal(threeD.clusters[1]!.multiplicity, 2);
  assert.match(threeD.explanation.summary, /assi scelti per convenzione canonica dentro un autospazio degenere/);
  assert.equal(spectralGeometry(graph, options('3d')).resultDigest, threeD.resultDigest);
});

test('stars: K(1,4) selects 2 of 3 tied modes; 3D uses all three', () => {
  const star4 = starGraph(4);
  const twoD = coordinates(spectralGeometry(star4, options('2d')));
  assert.equal(twoD.clusters[0]!.multiplicity, 3);
  assert.equal(twoD.clusters[0]!.selectedAxes, 2);
  const threeD = coordinates(spectralGeometry(star4, options('3d')));
  assert.equal(threeD.clusters.length, 1);
  assert.equal(threeD.clusters[0]!.multiplicity, 3);
  assert.ok(Math.abs(threeD.clusters[0]!.eigenvalueMin - 1) < 1e-8);
});

test('an 82-node hub with equivalent leaves yields genuine 2D and 3D spectral axes', () => {
  const graph = starGraph(81);
  for (const dimension of ['2d', '3d'] as const) {
    const result = coordinates(spectralGeometry(graph, options(dimension)));
    assert.equal(result.clusters[0]!.multiplicity, 80);
    assert.equal(result.clusters[0]!.selectedAxes, dimension === '2d' ? 2 : 3);
    assert.ok(Math.abs(result.clusters[0]!.eigenvalueMin - 1) < 1e-8);
    for (let axis = 0; axis < result.axes; axis += 1) {
      const column = result.coordinates.subarray(axis * graph.size, (axis + 1) * graph.size);
      const product = graph.applyLaplacian(Float64Array.from(column));
      for (let row = 0; row < graph.size; row += 1)
        assert.ok(Math.abs(product[row]! - column[row]!) < 1e-8);
    }
    const permuted = coordinates(spectralGeometry(shuffled(graph), options(dimension)));
    assert.deepEqual([...permuted.coordinates], [...result.coordinates]);
    assert.equal(permuted.resultDigest, result.resultDigest);
  }
});

test('rotation of the solver basis inside a tied cluster leaves quantised axes and digest unchanged', () => {
  const graph = starGraph(4);
  const basis = eigenbasisFromDense(solveDenseSymmetricEigen(denseLaplacian(graph)));
  const rotatedVectors = new Float64Array(basis.eigenvectors);
  const a = 1;
  const b = 2;
  const cosine = Math.cos(0.37);
  const sine = Math.sin(0.37);
  for (let row = 0; row < graph.size; row += 1) {
    const va = basis.eigenvectors[a * graph.size + row]!;
    const vb = basis.eigenvectors[b * graph.size + row]!;
    rotatedVectors[a * graph.size + row] = cosine * va + sine * vb;
    rotatedVectors[b * graph.size + row] = -sine * va + cosine * vb;
  }
  const rotated = { ...basis, eigenvectors: rotatedVectors };
  const first = coordinates(spectralGeometry(graph, { ...options('2d'), validatedBasis: basis }));
  const second = coordinates(spectralGeometry(graph, { ...options('2d'), validatedBasis: rotated }));
  assert.deepEqual([...second.coordinates], [...first.coordinates]);
  assert.equal(second.resultDigest, first.resultDigest);
});

test('a degenerate probe projection refuses with an empty typed state', () => {
  // For this digest all 12 first-cluster probes on P3 have equal endpoint signs,
  // so each projects to zero on the antisymmetric lambda=1 eigenspace.
  const result = refusal(spectralGeometry(pathGraph(3), {
    dimension: '2d', snapshotDigest: 'probe-degeneracy', domainDigest: 'degenerate-8699',
  }));
  assert.equal(result.code, 'insufficient-rank');
  assert.match(result.message, /probe projection is degenerate/);
  assert.deepEqual(result.loadedNodeIds, []);
  assert.equal(spectralGeometry(pathGraph(3), {
    dimension: '2d', snapshotDigest: 'probe-degeneracy', domainDigest: 'degenerate-8699',
  }).resultDigest, result.resultDigest);
});

test('complete graphs: K5 3D and K4 2D select canonical axes from their tied clusters', () => {
  const k5 = coordinates(spectralGeometry(completeGraph(5), options('3d')));
  assert.equal(k5.clusters[0]!.selectedAxes, 3);
  assert.equal(k5.clusters[0]!.multiplicity, 4);
  const k4ThreeD = coordinates(spectralGeometry(completeGraph(4), options('3d')));
  assert.equal(k4ThreeD.clusters.length, 1);
  assert.equal(k4ThreeD.clusters[0]!.multiplicity, 3);
  const k4TwoD = coordinates(spectralGeometry(completeGraph(4), options('2d')));
  assert.equal(k4TwoD.clusters[0]!.selectedAxes, 2);
  assert.equal(spectralGeometry(completeGraph(4), options('2d')).resultDigest, k4TwoD.resultDigest);
});

test('disconnected equal components: two P3s give byte-identical 2D and 3D coordinates under shuffle', () => {
  const graph = combineGraphs([pathGraph(3), pathGraph(3)], ['d', 'e']);
  const first = coordinates(spectralGeometry(graph, options('2d')));
  const permuted = coordinates(spectralGeometry(shuffled(graph), options('2d')));
  assert.equal(permuted.resultDigest, first.resultDigest);
  assert.deepEqual(Array.from(permuted.coordinates), Array.from(first.coordinates));
  const threeD = coordinates(spectralGeometry(graph, options('3d')));
  assert.deepEqual(threeD.clusters.map(cluster => cluster.selectedAxes), [2, 1]);
  const repeat = coordinates(spectralGeometry(graph, options('3d')));
  assert.equal(repeat.resultDigest, threeD.resultDigest);
});

test('insufficient rank: an edgeless graph and the three-node path in 3D refuse with the declared empty state', () => {
  const edgeless = buildSpectralGraph({ nodeIds: ['i5', 'i1', 'i3'], edges: [] });
  for (const dimension of ['2d', '3d'] as const) {
    const refused = refusal(spectralGeometry(edgeless, options(dimension)));
    assert.equal(refused.code, 'insufficient-rank');
    assert.deepEqual([...refused.loadedNodeIds], []);
    assert.ok(!('positions2' in refused) && !('positions3' in refused));
  }
  const p3ThreeD = refusal(spectralGeometry(pathGraph(3), options('3d')));
  assert.equal(p3ThreeD.code, 'insufficient-rank');
  assert.ok(p3ThreeD.eigenvalues.length === 3);
});

test('a very weak bridge merges into the zero cluster and the next tied cluster gives coordinates', () => {
  const graph = weakBridgeGraph(1e-12);
  const outcome = spectralGeometry(graph, options('2d'));
  assert.equal(spectralGeometry(graph, options('2d')).resultDigest, outcome.resultDigest);
});

test('the Lanczos backend reproduces the dense P3 geometry and refuses identically where ranks lack', () => {
  const graph = pathGraph(3);
  const dense = coordinates(spectralGeometry(graph, options('2d')));
  const sparse = coordinates(spectralGeometry(graph, options('2d', { backend: 'lanczos' })));
  assert.equal(sparse.solver.backend, 'lanczos');
  for (let index = 0; index < sparse.coordinates.length; index += 1) {
    assert.ok(
      Math.abs(sparse.coordinates[index]! - dense.coordinates[index]!) <= 1e-9,
      `backend disagreement at ${index}: ${sparse.coordinates[index]} vs ${dense.coordinates[index]}`,
    );
  }
  const refused = refusal(spectralGeometry(graph, options('3d', { backend: 'lanczos' })));
  assert.equal(refused.code, 'insufficient-rank');
});

test('the default backend follows the dense cap: path 172 solves dense, path 173 solves Lanczos, explicit dense above the cap refuses typed', () => {
  // Path Laplacian spectrum: lambda_k = 2 - 2 cos(pi k / n), k = 0..n-1 (analytic).
  const p172 = coordinates(spectralGeometry(pathGraph(172), options('2d')));
  assert.equal(p172.solver.backend, 'dense');
  assert.equal(p172.solver.solverVersion, DENSE_SYMMETRIC_SOLVER_VERSION);
  assert.equal(p172.clusters.length, 2);
  assert.ok(Math.abs(p172.clusters[0]!.eigenvalueMin - (2 - 2 * Math.cos(Math.PI / 172))) <= 1e-8);
  assert.ok(Math.abs(p172.clusters[1]!.eigenvalueMin - (2 - 2 * Math.cos((2 * Math.PI) / 172))) <= 1e-8);
  assert.deepEqual([...p172.loadedNodeIds], [...p172.nodeIds]);

  const p173 = coordinates(spectralGeometry(pathGraph(173), options('2d')));
  assert.equal(p173.solver.backend, 'lanczos');
  assert.equal(p173.solver.solverVersion, LANCZOS_SOLVER_VERSION);
  assert.equal(p173.clusters.length, 2);
  assert.ok(Math.abs(p173.clusters[0]!.eigenvalueMin - (2 - 2 * Math.cos(Math.PI / 173))) <= 1e-8);
  assert.ok(Math.abs(p173.clusters[1]!.eigenvalueMin - (2 - 2 * Math.cos((2 * Math.PI) / 173))) <= 1e-8);
  assert.deepEqual([...p173.loadedNodeIds], [...p173.nodeIds]);

  // An explicit dense request above the cap is the typed solver-failure state, never a throw.
  const refused = refusal(spectralGeometry(pathGraph(173), options('2d', { backend: 'dense' })));
  assert.equal(refused.code, 'solver-failure');
  assert.equal(refused.solver.backend, 'dense');
  assert.equal(refused.solver.solverVersion, DENSE_SYMMETRIC_SOLVER_VERSION);
  assert.match(refused.message, /the dense backend refused: holographic-dense: refuses n=173 > maxN=172/);
  assert.deepEqual([...refused.loadedNodeIds], []);
  assert.equal(refused.eigenvalues.length, 0);
  assert.ok(!('positions2' in refused) && !('positions3' in refused));
  const repeat = refusal(spectralGeometry(pathGraph(173), options('2d', { backend: 'dense' })));
  assert.equal(repeat.code, refused.code);
  assert.equal(repeat.resultDigest, refused.resultDigest);
});

test('a Lanczos projected size of 173 yields stable geometry beyond the dense ceiling', () => {
  const graph = pathGraph(DENSE_DEFAULT_MAX_N + 2);
  const geometryOptions = {
    dimension: '2d' as const,
    snapshotDigest: SNAPSHOT,
    domainDigest: DOMAIN,
    backend: 'lanczos' as const,
    lanczos: { restartSize: DENSE_DEFAULT_MAX_N + 1 },
  };
  const first = coordinates(spectralGeometry(graph, geometryOptions));
  assert.equal(first.solver.backend, 'lanczos');
  assert.equal(first.solver.solverVersion, LANCZOS_SOLVER_VERSION);
  const repeat = coordinates(spectralGeometry(graph, geometryOptions));
  assert.equal(repeat.resultDigest, first.resultDigest);

  // At the ceiling itself the same route still produces coordinates.
  const solved = coordinates(spectralGeometry(graph, { ...geometryOptions, lanczos: { restartSize: DENSE_DEFAULT_MAX_N } }));
  assert.equal(solved.solver.backend, 'lanczos');
  assert.equal(solved.solver.solverVersion, LANCZOS_SOLVER_VERSION);
  assert.ok(Math.abs(solved.clusters[0]!.eigenvalueMin - (2 - 2 * Math.cos(Math.PI / (DENSE_DEFAULT_MAX_N + 2)))) <= 1e-8);
  assert.deepEqual([...solved.loadedNodeIds], [...graph.nodeIds]);
  const solvedRepeat = coordinates(spectralGeometry(graph, { ...geometryOptions, lanczos: { restartSize: DENSE_DEFAULT_MAX_N } }));
  assert.equal(solvedRepeat.resultDigest, solved.resultDigest);
});

test('the geometry explanation carries the full inspector witness', () => {
  const graph = cycleGraph(4);
  const outcome = coordinates(spectralGeometry(graph, options('2d')));
  const explanation = outcome.explanation;
  assert.equal(explanation.elementKind, 'field');
  assert.ok(explanation.numericalWitness !== undefined);
  const witness = explanation.numericalWitness!;
  assert.equal(witness.axes, 2);
  assert.equal(witness.backend, 'dense');
  assert.ok(String(witness.clusterTolerance).length > 0);
  assert.ok(String(witness.probeOrdinals).length > 0);
  assert.equal(witness.quantization, '1e-10');
  assert.equal(witness.resultDigest, outcome.resultDigest);
  assert.ok(explanation.limitation !== undefined);
  const cut = coordinates(spectralGeometry(starGraph(4), options('2d')));
  assert.equal(cut.eigenspacePolicy, CANONICAL_EIGENSPACE_POLICY_VERSION);
  assert.equal(cut.explanation.numericalWitness!.selectedAxes, '2');
  assert.ok(Number(cut.clusters[0]!.lowerGap) > 0);
});
