import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRACTAL_PARAMETERS_VERSION,
  attractingFixedPoint,
  certifyFractalDynamics,
  criticalOrbit,
  defaultRayIterations,
  deriveC,
  deriveDensity,
  deriveFractalPower,
  displayScaleForCount,
  escapeRadiusFor,
  fractalContractParameters,
  potentialForRank,
  potentialRangeForCount,
  seriesTailBound,
} from '../../src/fractal/parameters.ts';

// Recorded fixture: n = 850, m_a = 849, c = -0.04976470588235294.
const RECORD_C = -0.04976470588235294;

test('fractal-parameters derives the recorded density and c from stable graph features', () => {
  const density = deriveDensity(850, 849);
  assert.equal(density, (2 * 849) / (850 * 849));
  assert.ok(Math.abs(density - 0.0023529411764705882) < 1e-16);
  const c = deriveC(density);
  assert.ok(Math.abs(c - RECORD_C) < 1e-16);
  assert.equal(deriveDensity(1, 0), 0);
  assert.equal(deriveC(0), -0.05);
  assert.equal(deriveDensity(4, 6), 1);
  assert.equal(deriveC(1), 0.05);
  const pathDensity = deriveDensity(3, 2);
  assert.ok(Math.abs(deriveC(pathDensity) - 1 / 60) < 1e-16);
});

test('fractal-parameters derives p from the stable community count', () => {
  assert.equal(deriveFractalPower(850), 2);
  assert.equal(deriveFractalPower(2), 2);
  assert.equal(deriveFractalPower(5), 3);
  assert.equal(deriveFractalPower(1), 3);
});

test('fractal-parameters certifies attracting fixed point and bounded critical orbit at the record fixture', () => {
  for (const communityCount of [2, 5]) {
    const certified = certifyFractalDynamics({ communityCount, domainNodeCount: 850, attestedEdgeCount: 849 });
    assert.equal(certified.certified, true);
    if (!certified.certified) continue;
    assert.equal(certified.version, FRACTAL_PARAMETERS_VERSION);
    assert.ok(Math.abs(certified.c - RECORD_C) < 1e-16);
    assert.equal(certified.power, communityCount % 2 === 0 ? 2 : 3);
    assert.ok(certified.multiplier < 1, `multiplier ${certified.multiplier}`);
    assert.ok(certified.fixedPointResidual <= 1e-12);
    assert.equal(certified.fixedPoint.im, 0);
    assert.ok(certified.criticalOrbit.length === 65);
    assert.ok(certified.criticalOrbitSupremum <= certified.escapeRadius);
    assert.ok(certified.criticalOrbitConvergence <= 1e-12);
    assert.ok(certified.escapeRadius > 1);
    // The fixed point is a real fixed point of F_c and attracts the critical orbit.
    const re = certified.fixedPoint.re;
    assert.ok(Math.abs(Math.pow(re, certified.power) + certified.c - re) <= 1e-12);
    assert.ok(Math.abs(certified.criticalOrbitTerminal - re) <= 1e-12);
  }
});

test('fractal-parameters fixed point agrees with an independent orbit iteration', () => {
  for (const c of [RECORD_C, 0.05, -0.05, 0]) {
    for (const power of [2, 3] as const) {
      const fixed = attractingFixedPoint(power, c);
      assert.notEqual(fixed, null);
      if (!fixed) continue;
      let z = 0;
      for (let k = 0; k < 200; k += 1) z = Math.pow(z, power) + c;
      assert.ok(Math.abs(z - fixed.fixedPoint) <= 1e-12, `p=${power} c=${c}: orbit ${z} vs fixed ${fixed.fixedPoint}`);
      const orbit = criticalOrbit(power, c, 64);
      assert.ok(orbit.magnitudes.length === 65);
      assert.ok(!orbit.nonfinite);
    }
  }
});

test('fractal-parameters escape radius satisfies r^p - r >= |c| and orbits above it escape', () => {
  for (const power of [2, 3] as const) {
    const r = escapeRadiusFor(power, 0.05);
    assert.ok(Math.pow(r, power) - r - 0.05 >= -1e-12, `residual ${Math.pow(r, power) - r - 0.05}`);
    assert.ok(Math.pow(r - 1e-9, power) - (r - 1e-9) - 0.05 < 1e-9, 'root uniqueness');
    let z = r + 1e-6;
    let previous = z;
    for (let k = 0; k < 8; k += 1) {
      const next = Math.pow(z, power) - 0.05;
      assert.ok(Math.abs(next) > previous, 'monotone escape');
      previous = Math.abs(next);
      z = next;
    }
  }
  const quadratic = escapeRadiusFor(2, 0.05);
  assert.ok(Math.abs(quadratic - (1 + Math.sqrt(1.2)) / 2) <= 1e-12);
});

test('fractal-parameters potential range and midrank rule match the G = 0.25 + 1.5 q formula', () => {
  const range = potentialRangeForCount(850);
  assert.ok(Math.abs(range[0] - (0.25 + 1.5 * (0.5 / 850))) <= 1e-15);
  assert.ok(Math.abs(range[1] - (0.25 + 1.5 * (849.5 / 850))) <= 1e-15);
  assert.deepEqual(potentialRangeForCount(1), [1, 1]);
  assert.ok(Math.abs(potentialForRank(0, 850) - (0.25 + 1.5 * ((0 + 1 / 2) / 850))) <= 1e-15);
  assert.ok(Math.abs(potentialForRank(849, 850) - range[1]) <= 1e-15);
  // The potential stays inside the declared range for every rank.
  for (const rank of [0, 1, 211, 424, 849]) {
    const g = potentialForRank(rank, 850);
    assert.ok(g >= range[0] - 1e-15 && g <= range[1] + 1e-15);
  }
});

test('fractal-parameters display scale is 100 sqrt(n / 172)', () => {
  assert.equal(displayScaleForCount(172), 100);
  assert.ok(Math.abs(displayScaleForCount(850) - 100 * Math.sqrt(850 / 172)) <= 1e-12);
  assert.equal(displayScaleForCount(0), 100 * Math.sqrt(1 / 172));
});

test('fractal-parameters default ray iterations clear the declared series tail target', () => {
  assert.equal(defaultRayIterations(2, 0, 0.25), 1);
  const minPotential = potentialRangeForCount(850)[0];
  for (const power of [2, 3] as const) {
    const n = defaultRayIterations(power, RECORD_C, minPotential);
    assert.ok(n >= 4 && n <= 24, `p=${power} N=${n}`);
    assert.ok(seriesTailBound(power, RECORD_C, 0.9 * Math.exp(minPotential), n) <= 1e-12);
    assert.ok(seriesTailBound(power, RECORD_C, 0.9 * Math.exp(minPotential), n - 1) > 1e-12 || n === 1);
  }
});

test('fractal-parameters refuses invalid features deterministically', () => {
  const invalid: readonly unknown[] = [
    { communityCount: 0, domainNodeCount: 850, attestedEdgeCount: 849 },
    { communityCount: 2.5, domainNodeCount: 850, attestedEdgeCount: 849 },
    { communityCount: 2, domainNodeCount: 0, attestedEdgeCount: 0 },
    { communityCount: 2, domainNodeCount: 850, attestedEdgeCount: -1 },
    { communityCount: Number.NaN, domainNodeCount: 850, attestedEdgeCount: 849 },
    { communityCount: 2, domainNodeCount: 850.5, attestedEdgeCount: 849 },
  ];
  for (const features of invalid) {
    const first = certifyFractalDynamics(features as { communityCount: number; domainNodeCount: number; attestedEdgeCount: number });
    const second = certifyFractalDynamics(features as { communityCount: number; domainNodeCount: number; attestedEdgeCount: number });
    assert.equal(first.certified, false);
    assert.deepEqual(first, second);
    if (!first.certified) assert.equal(first.code, 'invalid-features');
  }
});

test('fractal-parameters contract fragment is deterministic and typed', () => {
  const certified = certifyFractalDynamics({ communityCount: 2, domainNodeCount: 850, attestedEdgeCount: 849 });
  assert.equal(certified.certified, true);
  if (!certified.certified) return;
  const first = fractalContractParameters(certified, 850);
  const second = fractalContractParameters(certified, 850);
  assert.deepEqual(first, second);
  assert.equal(first.sectorPolicyVersion, 'sector-locality-v2');
  assert.equal(first.power, 2);
  assert.deepEqual(first.potentialRange, potentialRangeForCount(850));
  assert.equal(first.scale, displayScaleForCount(850));
  assert.equal(first.residualTolerance, 1e-6);
  assert.equal(first.rayIterations, defaultRayIterations(2, RECORD_C, potentialRangeForCount(850)[0]));
});
