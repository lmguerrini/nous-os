/** D-073 tranche F, row F6 — heat kernels and local coefficient extraction.
 *
 * The heat semigroup of L = U Lambda U^T is H_s = U exp(-s Lambda) U^T with s >= 0. It is a
 * contraction, ||H_s x||_2 <= ||x||_2, monotone in s, because every eigenvalue of L is
 * nonnegative; within a connected component the component mean (the zero mode) is preserved
 * exactly while every nonzero mode decays like exp(-s lambda). The local atoms
 * psi_(s,v) = U exp(-s Lambda) U^T delta_v are explicitly derived fields, and the diagonal
 * K_s(v,v) = sum_j exp(-s lambda_j) u_j(v)^2 is a local spectral density measure.
 *
 * Pure module; the basis must come from the same Laplacian as the signal's nodes. */

import type { SpectralGraph } from './adjacency.ts';
import type { Eigenbasis } from './signals.ts';

export const HOLOGRAPHIC_HEAT_VERSION = 'holographic-heat-v1';
/** Guard against overflow in exp(-s lambda) accumulations; exp(-x) <= 1 for x >= 0, so this
 * bounds the per-mode factor checks, not the factors themselves. */
export const HEAT_MAX_TIME = 1e9;

function fail(message: string): never {
  throw new Error(`holographic-heat: ${message}`);
}

function requireTime(s: number): void {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
    fail(`heat time must be finite and nonnegative, got ${String(s)}`);
  }
  if (s > HEAT_MAX_TIME) fail(`heat time ${String(s)} exceeds the guard ${String(HEAT_MAX_TIME)}`);
}

function requireValues(x: Float64Array, n: number): void {
  if (x.length !== n) fail(`vector length ${String(x.length)} does not match the basis dimension ${String(n)}`);
  for (const value of x) {
    if (!Number.isFinite(value)) fail('heat diffusion refuses nonfinite signal values');
  }
}

/** exp(-s lambda_j) per retained mode; the zero cluster contributes exactly 1. */
export function heatFactors(basis: Eigenbasis, s: number): Float64Array {
  requireTime(s);
  const factors = new Float64Array(basis.count);
  for (let mode = 0; mode < basis.count; mode += 1) factors[mode] = Math.exp(-s * basis.eigenvalues[mode]!);
  return factors;
}

/** H_s x = U exp(-s Lambda) U^T x. */
export function applyHeat(basis: Eigenbasis, s: number, x: Float64Array): Float64Array {
  requireValues(x, basis.n);
  const factors = heatFactors(basis, s);
  const heated = new Float64Array(basis.n);
  for (let mode = 0; mode < basis.count; mode += 1) {
    const factor = factors[mode]!;
    if (factor === 0) continue;
    let coefficient = 0;
    const base = mode * basis.n;
    for (let index = 0; index < basis.n; index += 1) coefficient += basis.eigenvectors[base + index]! * x[index]!;
    if (coefficient === 0) continue;
    const scaled = factor * coefficient;
    for (let index = 0; index < basis.n; index += 1) {
      heated[index] = heated[index]! + scaled * basis.eigenvectors[base + index]!;
    }
  }
  return heated;
}

/** Local heat atom psi_(s,v) = H_s delta_v: the explicitly derived diffusion field of node v. */
export function heatAtom(basis: Eigenbasis, s: number, nodeIndex: number): Float64Array {
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= basis.n) {
    fail(`node index ${String(nodeIndex)} is outside the ${String(basis.n)}-node basis`);
  }
  const delta = new Float64Array(basis.n);
  delta[nodeIndex] = 1;
  return applyHeat(basis, s, delta);
}

/** Diagonal K_s(v,v) = sum_j exp(-s lambda_j) u_j(v)^2; equals psi_(s,v)(v). */
export function heatDiagonal(basis: Eigenbasis, s: number): Float64Array {
  requireTime(s);
  const factors = heatFactors(basis, s);
  const diagonal = new Float64Array(basis.n);
  for (let mode = 0; mode < basis.count; mode += 1) {
    const factor = factors[mode]!;
    if (factor === 0) continue;
    const base = mode * basis.n;
    for (let index = 0; index < basis.n; index += 1) {
      const entry = basis.eigenvectors[base + index]!;
      diagonal[index] = diagonal[index]! + factor * entry * entry;
    }
  }
  return diagonal;
}

/** Local coefficients <delta_v, H_s x> for the requested nodes: heat-diffused local samples. */
export function localHeatSamples(basis: Eigenbasis, s: number, x: Float64Array, nodeIndices: readonly number[]): Float64Array {
  const heated = applyHeat(basis, s, x);
  const samples = new Float64Array(nodeIndices.length);
  for (const [position, index] of nodeIndices.entries()) {
    if (!Number.isInteger(index) || index < 0 || index >= basis.n) {
      fail(`node index ${String(index)} is outside the ${String(basis.n)}-node basis`);
    }
    samples[position] = heated[index]!;
  }
  return samples;
}

/** | ||H_s x||_2^2 - sum_j exp(-2 s lambda_j) x_hat_j^2 |: the spectral energy identity defect. */
export function heatEnergyIdentityDefect(basis: Eigenbasis, s: number, x: Float64Array): number {
  requireValues(x, basis.n);
  const heated = applyHeat(basis, s, x);
  let heatedEnergy = 0;
  for (const value of heated) heatedEnergy += value * value;
  let spectralEnergy = 0;
  for (let mode = 0; mode < basis.count; mode += 1) {
    let coefficient = 0;
    const base = mode * basis.n;
    for (let index = 0; index < basis.n; index += 1) coefficient += basis.eigenvectors[base + index]! * x[index]!;
    const decayed = Math.exp(-s * basis.eigenvalues[mode]!) * coefficient;
    spectralEnergy += decayed * decayed;
  }
  return Math.abs(heatedEnergy - spectralEnergy);
}

/** Max over components of |sum_{v in C} (H_s x - x)_v|: the preserved zero-mode mass per
 * connected component (L has the component indicators as its exact kernel). */
export function componentMassDefect(graph: SpectralGraph, x: Float64Array, heated: Float64Array): number {
  if (x.length !== graph.size || heated.length !== graph.size) {
    fail(`vectors must span the ${String(graph.size)} domain nodes`);
  }
  let worst = 0;
  for (const component of graph.components) {
    let defect = 0;
    for (const index of component.memberIndices) defect += heated[index]! - x[index]!;
    worst = Math.max(worst, Math.abs(defect));
  }
  return worst;
}

/** ||H_s x||_2 / ||x||_2; <= 1 up to roundoff for s >= 0 (diffusion contraction). */
export function contractionRatio(basis: Eigenbasis, s: number, x: Float64Array): number {
  requireValues(x, basis.n);
  let inputEnergy = 0;
  for (const value of x) inputEnergy += value * value;
  const heated = applyHeat(basis, s, x);
  let outputEnergy = 0;
  for (const value of heated) outputEnergy += value * value;
  return Math.sqrt(outputEnergy / Math.max(inputEnergy, Number.MIN_VALUE));
}

/** True iff every entry of the field is finite. */
export function isFiniteField(x: Float64Array): boolean {
  for (const value of x) if (!Number.isFinite(value)) return false;
  return true;
}
