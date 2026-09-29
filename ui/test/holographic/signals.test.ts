/** D-073 tranche F, row F5 — known-answer and property tests for stable signals and the GFT. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph, type SpectralGraph } from '../../src/holographic/adjacency.ts';
import { denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import { solveSpectrum } from '../../src/holographic/lanczos.ts';
import type { Eigenbasis } from '../../src/holographic/signals.ts';
import {
  bandlimitedResidual,
  eigenbasisFromDense,
  eigenbasisFromLanczos,
  featureSignal,
  fourierCoefficients,
  parsevalDefect,
  reconstructSignal,
  retainedEnergy,
  signalEnergy,
  syntheticSignal,
} from '../../src/holographic/signals.ts';
import { completeGraph, cycleGraph, noiseVector, pathGraph, ringLatticeGraph, starGraph } from './fixtures.ts';

function denseBasis(graph: SpectralGraph): Eigenbasis {
  return eigenbasisFromDense(solveDenseSymmetricEigen(denseLaplacian(graph)));
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

test('the three-node path: the GFT of [1,0,-1] is [0,sqrt(2),0] and reconstructs exactly', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const signal = syntheticSignal(graph.nodeIds, Float64Array.from([1, 0, -1]), 'p3-bandlimited');
  const coefficients = fourierCoefficients(basis, signal);
  assert.ok(Math.abs(coefficients[0]!) < 1e-12, `constant mode coefficient ${coefficients[0]}`);
  assert.ok(Math.abs(coefficients[1]! - Math.SQRT2) < 1e-12, `lambda=1 coefficient ${coefficients[1]}`);
  assert.ok(Math.abs(coefficients[2]!) < 1e-12, `lambda=3 coefficient ${coefficients[2]}`);
  const reconstructed = reconstructSignal(basis, coefficients);
  for (const [index, value] of [1, 0, -1].entries()) {
    assert.ok(Math.abs(reconstructed[index]! - value) < 1e-12);
  }
  const twoMode = reconstructSignal(basis, coefficients, 2);
  for (const [index, value] of [1, 0, -1].entries()) {
    assert.ok(Math.abs(twoMode[index]! - value) < 1e-12, 'the signal is exactly 2-band-limited');
  }
  assert.ok(Math.abs(parsevalDefect(basis, signal, coefficients)) <= 1e-12 * 2);
  assert.ok(bandlimitedResidual(basis, signal, 2) <= 1e-10);
  assert.ok(bandlimitedResidual(basis, signal, 1) > 0.99);
});

test('Parseval holds within solver tolerance on complete dense bases', () => {
  for (const [name, graph] of [
    ['c5', cycleGraph(5)],
    ['star9', starGraph(9)],
    ['k6', completeGraph(6)],
    ['ring40', ringLatticeGraph(40, 'parseval', 2)],
  ] as const) {
    const basis = denseBasis(graph);
    assert.ok(basis.complete, `${name} basis must be complete for Parseval`);
    for (let trial = 0; trial < 3; trial += 1) {
      const x = noiseVector(graph.size, `${name}-${trial}`);
      const signal = syntheticSignal(graph.nodeIds, x, `${name}-x${trial}`);
      const coefficients = fourierCoefficients(basis, signal);
      const defect = parsevalDefect(basis, signal, coefficients);
      assert.ok(
        Math.abs(defect) <= 1e-9 * signalEnergy(x),
        `${name} trial ${trial}: Parseval defect ${defect} vs energy ${signalEnergy(x)}`,
      );
    }
  }
});

test('partial Lanczos bases satisfy the Bessel inequality and monotone retained energy', () => {
  const graph = ringLatticeGraph(50, 'bessel', 2);
  const outcome = solveSpectrum(graph, { seed: 'bessel' });
  assert.ok(outcome.kind === 'converged');
  const basis = eigenbasisFromLanczos(outcome);
  assert.ok(!basis.complete);
  assert.equal(basis.count, outcome.zeroModes + outcome.requestedModes);
  const x = noiseVector(graph.size, 'bessel-x');
  const signal = syntheticSignal(graph.nodeIds, x, 'bessel');
  const coefficients = fourierCoefficients(basis, signal);
  const defect = parsevalDefect(basis, signal, coefficients);
  assert.ok(defect >= -1e-9 * signalEnergy(x), `Bessel gap ${defect} is negative beyond tolerance`);
  let previous = 0;
  for (let modeCount = 0; modeCount <= basis.count; modeCount += 1) {
    const energy = retainedEnergy(coefficients, modeCount);
    assert.ok(energy >= previous - 1e-12, `retained energy dropped at ${modeCount} modes`);
    previous = energy;
  }
  // Projection identity: ||x - U U^T x||^2 equals the Parseval defect of the partial basis.
  const reconstruction = reconstructSignal(basis, coefficients);
  let residualSum = 0;
  for (const [index, value] of x.entries()) {
    const delta = value - reconstruction[index]!;
    residualSum += delta * delta;
  }
  assert.ok(Math.abs(residualSum - defect) <= 1e-9 * signalEnergy(x));
});

test('featureSignal records provenance, digests stably and refuses missing or nonfinite values', () => {
  const graph = pathGraph(4);
  const featuresA: Record<string, number> = { n0000: 0.1, n0001: 0.5, n0002: 0.25, n0003: 0.9 };
  const featuresB: Record<string, number> = { n0003: 0.9, n0002: 0.25, n0001: 0.5, n0000: 0.1 };
  const first = featureSignal(graph.nodeIds, featuresA, { signalId: 'importance', featureKey: 'importance.value' });
  const second = featureSignal(graph.nodeIds, featuresB, { signalId: 'importance', featureKey: 'importance.value' });
  assert.equal(first.provenance.source, 'feature');
  assert.equal(first.provenance.featureKey, 'importance.value');
  assert.equal(first.provenance.nodeCount, 4);
  assert.equal(first.provenance.digest, second.provenance.digest);
  assert.deepEqual(Array.from(first.values), [0.1, 0.5, 0.25, 0.9]);
  assert.throws(() => featureSignal(graph.nodeIds, { n0000: 1, n0001: 1, n0002: 1 }, { signalId: 's', featureKey: 'k' }));
  assert.throws(() => featureSignal(graph.nodeIds, { n0000: Number.NaN, n0001: 1, n0002: 1, n0003: 1 }, { signalId: 's', featureKey: 'k' }));
  assert.throws(() => featureSignal(graph.nodeIds, { n0000: 1e7, n0001: 1, n0002: 1, n0003: 1 }, { signalId: 's', featureKey: 'k' }));
  assert.throws(() => featureSignal(graph.nodeIds, featuresA, { signalId: '', featureKey: 'k' }));
});

test('syntheticSignal validates finiteness and its digest follows the 1e-9 quantisation grid', () => {
  const graph = pathGraph(3);
  const values = Float64Array.from([0.5, -0.25, 0.125]);
  const first = syntheticSignal(graph.nodeIds, values, 'synthetic-a');
  const second = syntheticSignal(graph.nodeIds, Float64Array.from(values), 'synthetic-a');
  assert.equal(first.provenance.source, 'synthetic');
  assert.equal(first.provenance.featureKey, null);
  assert.equal(first.provenance.digest, second.provenance.digest);
  const shifted = syntheticSignal(graph.nodeIds, Float64Array.from([0.5 + 1e-10, -0.25, 0.125]), 'synthetic-a');
  assert.equal(shifted.provenance.digest, first.provenance.digest, 'a sub-grid shift cannot change the digest');
  const crossed = syntheticSignal(graph.nodeIds, Float64Array.from([0.5 + 5e-9, -0.25, 0.125]), 'synthetic-a');
  assert.notEqual(crossed.provenance.digest, first.provenance.digest);
  assert.throws(() => syntheticSignal(graph.nodeIds, Float64Array.from([0.5, Number.POSITIVE_INFINITY, 0.125]), 'synthetic-a'));
  assert.throws(() => syntheticSignal(graph.nodeIds, Float64Array.from([0.5]), 'synthetic-a'));
});

test('the GFT is deterministic under permuted node and edge input', () => {
  const graph = ringLatticeGraph(30, 'permuted', 2);
  const permuted = buildSpectralGraph({ nodeIds: [...graph.nodeIds].reverse(), edges: upperTriangleEdges(graph).reverse() });
  const x = noiseVector(graph.size, 'permuted-x');
  const first = fourierCoefficients(denseBasis(graph), syntheticSignal(graph.nodeIds, x, 'permuted'));
  const second = fourierCoefficients(denseBasis(permuted), syntheticSignal(permuted.nodeIds, x, 'permuted'));
  assert.deepEqual(Array.from(second), Array.from(first));
});
