/** D-073 tranche F, row F8 — `holographic-eigenspace.test.ts`: canonical spectral 2D/3D
 * geometry under the projector-probe-v1 tied-eigenspace policy, with byte-identical
 * quantised coordinates/digests on shuffled and repeated runs, or the identical
 * no-coordinate refusal state (cycle, star, complete and disconnected equal components are
 * the required fixtures). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph, type SpectralGraph } from '../../src/holographic/adjacency.ts';
import {
  spectralGeometry,
  type SpectralGeometryCoordinates,
  type SpectralGeometryOutcome,
  type SpectralGeometryRefusal,
} from '../../src/holographic/geometry.ts';
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

test('C5: 2D succeeds on the tied pair and 3D refuses because the next tied pair crosses the axis count', () => {
  const graph = cycleGraph(5);
  const twoD = coordinates(spectralGeometry(graph, options('2d')));
  assert.equal(twoD.clusters[0]!.multiplicity, 2);
  const threeD = refusal(spectralGeometry(graph, options('3d')));
  assert.equal(threeD.code, 'ambiguous-eigenspace');
  assert.match(threeD.message, /cross the requested 3-axis count/);
  assert.deepEqual([...threeD.loadedNodeIds], []);
  assert.ok(!('positions2' in threeD) && !('positions3' in threeD));
  assert.equal(spectralGeometry(graph, options('3d')).resultDigest, threeD.resultDigest);
});

test('stars: K(1,4) refuses 2D (multiplicity 3 crosses 2) and uses the whole tied cluster in 3D; a large star refuses identically twice', () => {
  const star4 = starGraph(4);
  const refused = refusal(spectralGeometry(star4, options('2d')));
  assert.equal(refused.code, 'ambiguous-eigenspace');
  const threeD = coordinates(spectralGeometry(star4, options('3d')));
  assert.equal(threeD.clusters.length, 1);
  assert.equal(threeD.clusters[0]!.multiplicity, 3);
  assert.ok(Math.abs(threeD.clusters[0]!.eigenvalueMin - 1) < 1e-8);
  const star200 = starGraph(200);
  const first = refusal(spectralGeometry(star200, options('3d')));
  assert.equal(first.code, 'ambiguous-eigenspace');
  const second = refusal(spectralGeometry(star200, options('3d')));
  assert.equal(second.code, first.code);
  assert.equal(second.resultDigest, first.resultDigest);
});

test('complete graphs: K5 3D refuses (multiplicity 4 > 3); K4 3D coordinates come from the whole tied cluster and 2D refuses', () => {
  const k5 = refusal(spectralGeometry(completeGraph(5), options('3d')));
  assert.equal(k5.code, 'ambiguous-eigenspace');
  const k4ThreeD = coordinates(spectralGeometry(completeGraph(4), options('3d')));
  assert.equal(k4ThreeD.clusters.length, 1);
  assert.equal(k4ThreeD.clusters[0]!.multiplicity, 3);
  const k4TwoD = refusal(spectralGeometry(completeGraph(4), options('2d')));
  assert.equal(k4TwoD.code, 'ambiguous-eigenspace');
  assert.equal(spectralGeometry(completeGraph(4), options('2d')).resultDigest, k4TwoD.resultDigest);
});

test('disconnected equal components: two P3s give byte-identical 2D coordinates under shuffle; 3D refuses on the second tied pair', () => {
  const graph = combineGraphs([pathGraph(3), pathGraph(3)], ['d', 'e']);
  const first = coordinates(spectralGeometry(graph, options('2d')));
  const permuted = coordinates(spectralGeometry(shuffled(graph), options('2d')));
  assert.equal(permuted.resultDigest, first.resultDigest);
  assert.deepEqual(Array.from(permuted.coordinates), Array.from(first.coordinates));
  const threeD = refusal(spectralGeometry(graph, options('3d')));
  assert.equal(threeD.code, 'ambiguous-eigenspace');
  assert.deepEqual([...threeD.loadedNodeIds], []);
  const repeat = refusal(spectralGeometry(graph, options('3d')));
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

test('a very weak bridge merges into the zero cluster and the next tied cluster crosses the axis count', () => {
  const graph = weakBridgeGraph(1e-12);
  const refused = refusal(spectralGeometry(graph, options('2d')));
  assert.equal(refused.code, 'ambiguous-eigenspace');
  assert.ok(refused.clusterTolerance > 0);
  const repeat = refusal(spectralGeometry(graph, options('2d')));
  assert.equal(repeat.resultDigest, refused.resultDigest);
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
  const refused = refusal(spectralGeometry(starGraph(4), options('2d')));
  assert.equal(refused.explanation.numericalWitness!.code, 'ambiguous-eigenspace');
  assert.ok(String(refused.explanation.numericalWitness!.clusterEigenvalues).length > 0);
});
