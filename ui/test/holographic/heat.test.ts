/** D-073 tranche F, row F6 — known-answer and property tests for heat kernels and local coefficients. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineGraphs, cycleGraph, noiseVector, pathGraph, ringLatticeGraph } from './fixtures.ts';
import {
  applyHeat,
  componentMassDefect,
  contractionRatio,
  heatAtom,
  heatDiagonal,
  heatEnergyIdentityDefect,
  heatFactors,
  isFiniteField,
  localHeatSamples,
} from '../../src/holographic/heat.ts';
import { denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import { solveSpectrum } from '../../src/holographic/lanczos.ts';
import { eigenbasisFromDense, eigenbasisFromLanczos, syntheticSignal, type Eigenbasis } from '../../src/holographic/signals.ts';
import type { SpectralGraph } from '../../src/holographic/adjacency.ts';

function denseBasis(graph: SpectralGraph): Eigenbasis {
  return eigenbasisFromDense(solveDenseSymmetricEigen(denseLaplacian(graph)));
}

test('the three-node path at s = ln 2 diffuses to the exact known field [29,14,5]/48', () => {
  const graph = pathGraph(3);
  const basis = denseBasis(graph);
  const s = Math.log(2);
  const factors = heatFactors(basis, s);
  for (const [mode, expected] of [1, 0.5, 0.125].entries()) {
    assert.ok(Math.abs(factors[mode]! - expected) < 1e-12, `factor ${mode}: ${factors[mode]}`);
  }
  const delta0 = new Float64Array([1, 0, 0]);
  const field = applyHeat(basis, s, delta0);
  const expected = [29 / 48, 14 / 48, 5 / 48];
  for (const [index, value] of expected.entries()) {
    assert.ok(Math.abs(field[index]! - value) < 1e-12, `entry ${index}: ${field[index]} vs ${value}`);
  }
  const atom = heatAtom(basis, s, 0);
  for (const [index, value] of expected.entries()) {
    assert.ok(Math.abs(atom[index]! - value) < 1e-12, `atom entry ${index}`);
  }
  const diagonal = heatDiagonal(basis, s);
  for (const [index, value] of [29 / 48, 5 / 12, 29 / 48].entries()) {
    assert.ok(Math.abs(diagonal[index]! - value) < 1e-12, `diagonal ${index}: ${diagonal[index]} vs ${value}`);
  }
  assert.ok(Math.abs(atom[0]! - diagonal[0]!) < 1e-15, 'psi_(s,v)(v) equals K_s(v,v)');
});

test('diffusion is a contraction, monotone in s, and preserves component mass', () => {
  const graph = combineGraphs([pathGraph(3), cycleGraph(4)], ['x', 'y']);
  const basis = denseBasis(graph);
  const x = noiseVector(graph.size, 'contraction');
  let previous = Number.POSITIVE_INFINITY;
  for (const s of [0, 0.5, 2, 10]) {
    const ratio = contractionRatio(basis, s, x);
    assert.ok(ratio <= 1 + 1e-12, `s=${String(s)}: contraction ratio ${ratio}`);
    assert.ok(ratio <= previous + 1e-12, `s=${String(s)}: ratio grew from ${previous}`);
    previous = ratio;
    assert.ok(componentMassDefect(graph, x, applyHeat(basis, s, x)) <= 1e-10, `s=${String(s)}: component mass defect`);
  }
});

test('the spectral energy identity holds, the field stays finite and converges to component means', () => {
  const graph = ringLatticeGraph(40, 'identity', 2);
  const basis = denseBasis(graph);
  const x = noiseVector(graph.size, 'identity-x');
  for (const s of [0.01, 1, 100, 1e6]) {
    const field = applyHeat(basis, s, x);
    assert.ok(isFiniteField(field), `s=${String(s)}: nonfinite field`);
    assert.ok(heatEnergyIdentityDefect(basis, s, x) <= 1e-9 * (1 + x.reduce((sum, value) => sum + value * value, 0)), `s=${String(s)}: energy identity`);
  }
  const mean = x.reduce((sum, value) => sum + value, 0) / graph.size;
  const cooled = applyHeat(basis, 1e6, x);
  for (const value of cooled) {
    assert.ok(Math.abs(value - mean) <= 1e-9, `cooled entry ${value} vs component mean ${mean}`);
  }
});

test('heat atoms and local samples agree with direct diffusion', () => {
  const graph = pathGraph(6);
  const basis = denseBasis(graph);
  const s = 0.7;
  const x = noiseVector(graph.size, 'samples');
  const field = applyHeat(basis, s, x);
  const samples = localHeatSamples(basis, s, x, [5, 0, 3]);
  for (const [position, node] of [5, 0, 3].entries()) {
    assert.equal(samples[position], field[node]);
  }
  const delta = new Float64Array(graph.size);
  delta[4] = 1;
  const atom = heatAtom(basis, s, 4);
  const direct = applyHeat(basis, s, delta);
  for (const [index, value] of direct.entries()) {
    assert.ok(Math.abs(atom[index]! - value) <= 1e-15);
  }
});

test('dense and Lanczos bases of the same graph diffuse to the same field', () => {
  const graph = pathGraph(6);
  const dense = denseBasis(graph);
  const outcome = solveSpectrum(graph, { seed: 'backend-agreement' });
  assert.ok(outcome.kind === 'converged');
  const sparse = eigenbasisFromLanczos(outcome);
  assert.ok(sparse.complete, 'the Lanczos basis spans the whole space on this small graph');
  const signal = syntheticSignal(graph.nodeIds, noiseVector(graph.size, 'agreement-x'), 'agreement');
  for (const s of [0.1, 1.5]) {
    const left = applyHeat(dense, s, signal.values);
    const right = applyHeat(sparse, s, signal.values);
    for (const [index, value] of left.entries()) {
      assert.ok(Math.abs(value - right[index]!) <= 1e-9, `s=${String(s)} entry ${index}: ${value} vs ${right[index]}`);
    }
  }
});

test('invalid heat times and nonfinite inputs refuse', () => {
  const basis = denseBasis(pathGraph(3));
  const x = new Float64Array([1, 2, 3]);
  for (const s of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e10]) {
    assert.throws(() => applyHeat(basis, s, x), /holographic-heat/);
  }
  assert.throws(() => applyHeat(basis, 1, new Float64Array([1, Number.NaN, 3])));
  assert.throws(() => heatAtom(basis, 1, 7));
  assert.throws(() => localHeatSamples(basis, 1, x, [-1]));
});
