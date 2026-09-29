import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRACTAL_3D_SCALAR_LIFT_LIMITATION,
  FRACTAL_REGION_SAMPLE_POLICY,
  FRACTAL_REGIONS_VERSION,
  angleGrid,
  defaultSectorRegionOptions,
  liftNodeScalar3d,
  potentialGrid,
  sampleExternalRayPoints,
  sampleSectorRegion,
  type SectorRegionOptions,
} from '../../src/fractal/regions.ts';
import { cxAbs, cxArg, cxSub, forwardBotcher } from '../../src/fractal/botcher.ts';
import type { FractalDynamics } from '../../src/fractal/parameters.ts';
import { externalCoordinate, invertExternalPoint } from '../../src/fractal/inverse-rays.ts';
import type { Complex, Vec2 } from '../../src/projection/contract-types.ts';

const RECORD_C = -0.04976470588235294;
const DYNAMICS_2 = { power: 2, c: RECORD_C } as const;
const SMALL_REGION: SectorRegionOptions = { ...defaultSectorRegionOptions(), raySampleCount: 4, arcSampleCount: 5 };

function argumentOf(point: Vec2): number {
  const argument = Math.atan2(point.y, point.x);
  return argument < 0 ? argument + 2 * Math.PI : argument;
}

test('c = 0 region is the exact exponential annular sector', () => {
  const dynamics: FractalDynamics = { power: 2, c: 0 };
  const left = Math.PI / 6;
  const right = Math.PI / 3;
  const [minPotential, maxPotential] = [Math.log(2), Math.log(4)] as const;
  const region = sampleSectorRegion(dynamics, { left, right }, [minPotential, maxPotential], SMALL_REGION);
  assert.equal(region.kind, 'region');
  if (region.kind !== 'region') return;
  assert.equal(region.version, FRACTAL_REGIONS_VERSION);
  assert.equal(region.samplePolicy, FRACTAL_REGION_SAMPLE_POLICY);
  assert.equal(region.pointCount, 2 * SMALL_REGION.arcSampleCount + 2 * SMALL_REGION.raySampleCount - 4);
  assert.equal(region.boundary2.length, region.pointCount);
  assert.equal(region.boundary3.length, region.pointCount);
  assert.ok(region.maxResidual <= 1e-12);
  assert.ok(region.maxLevelAgreement <= 1e-12);
  // CCW orientation of a non-degenerate outer-bounded region.
  assert.ok(region.signedArea2 > 0, `signed area ${region.signedArea2}`);
  // Every sample is exactly exp(G + i theta) for c = 0.
  const outerArc = region.boundary2.slice(0, SMALL_REGION.arcSampleCount);
  const angles = angleGrid(left, right, SMALL_REGION.arcSampleCount);
  outerArc.forEach((point, index) => {
    const expected = externalCoordinate(maxPotential, angles[index]!);
    assert.ok(Math.abs(point.x - expected.re) <= 1e-12 && Math.abs(point.y - expected.im) <= 1e-12);
  });
  // Corners: the traversal starts at (Gmax, left) and hits every corner exactly once.
  const first = outerArc[0]!;
  assert.ok(Math.abs(first.x - Math.exp(maxPotential) * Math.cos(left)) <= 1e-12);
  const last = region.boundary2[region.boundary2.length - 1]!;
  assert.ok(Math.abs(argumentOf(last) - left) <= 1e-12 || Math.abs(argumentOf(last) - (left + 2 * Math.PI)) <= 1e-12);
  // 3D lift: the height is the sampled potential, and the limitation is the labelled one.
  region.boundary3.forEach((point, index) => {
    assert.equal(point.x, region.boundary2[index]!.x);
    assert.equal(point.y, region.boundary2[index]!.y);
  });
  const heights = new Set(region.boundary3.map((point) => point.z));
  for (const potential of potentialGrid(minPotential, maxPotential, SMALL_REGION.raySampleCount)) {
    assert.ok(heights.has(potential));
  }
  assert.equal(region.limitation, FRACTAL_3D_SCALAR_LIFT_LIMITATION);
  assert.ok(region.limitation.includes('not a 3D Julia set'));
});

test('record-c region maps truthfully with residual and level agreement witnesses', () => {
  const left = 0.75 * Math.PI;
  const right = 1.25 * Math.PI;
  const [minPotential, maxPotential] = [0.6, 1.8] as const;
  const region = sampleSectorRegion(DYNAMICS_2, { left, right }, [minPotential, maxPotential], {
    ...defaultSectorRegionOptions(),
    raySampleCount: 6,
    arcSampleCount: 9,
  });
  assert.equal(region.kind, 'region');
  if (region.kind !== 'region') return;
  assert.ok(region.maxResidual <= 1e-6, `max residual ${region.maxResidual}`);
  assert.ok(region.maxResidual <= 1e-9, `measured residual ${region.maxResidual}`);
  assert.ok(region.maxLevelAgreement <= 1e-9);
  assert.ok(region.maxStepArgumentDelta < Math.PI / 2);
  assert.ok(region.signedArea2 > 0);
  // Independent forward cross-check of the corners against the branch-continuous evaluation.
  const corners: readonly { potential: number; angle: number }[] = [
    { potential: maxPotential, angle: left },
    { potential: maxPotential, angle: right },
    { potential: minPotential, angle: right },
    { potential: minPotential, angle: left },
  ];
  for (const corner of corners) {
    const solved = invertExternalPoint(DYNAMICS_2, corner.potential, corner.angle);
    assert.equal(solved.kind, 'solution');
    if (solved.kind !== 'solution') continue;
    const forward = forwardBotcher(solved.z, DYNAMICS_2, solved.iterations);
    assert.equal(forward.kind, 'evaluation');
    if (forward.kind !== 'evaluation') continue;
    const target = externalCoordinate(corner.potential, corner.angle);
    assert.ok(cxAbs(cxSub(forward.phi, target)) / cxAbs(target) <= 1e-6);
    assert.equal(forward.branchTrusted, true);
  }
  // The outer arc strictly dominates the inner arc in radius at shared angles.
  const outerRadii = region.boundary2.slice(0, 9).map((point) => Math.hypot(point.x, point.y));
  const innerRadii = region.boundary2.slice(9 + 4, 9 + 4 + 9).map((point) => Math.hypot(point.x, point.y));
  for (let index = 1; index < 8; index += 1) {
    assert.ok(outerRadii[index]! > innerRadii[index]!, 'outer arc dominates inner arc');
  }
  // Determinism: byte-identical double run.
  const again = sampleSectorRegion(DYNAMICS_2, { left, right }, [minPotential, maxPotential], {
    ...defaultSectorRegionOptions(),
    raySampleCount: 6,
    arcSampleCount: 9,
  });
  assert.equal(JSON.stringify(again), JSON.stringify(region));
});

test('a mid-sector ray lies strictly between the mapped arcs', () => {
  const left = 1.0;
  const right = 1.4;
  const midAngle = (left + right) / 2;
  const [minPotential, maxPotential] = [0.5, 1.9] as const;
  const inner = invertExternalPoint(DYNAMICS_2, minPotential, midAngle);
  const middle = invertExternalPoint(DYNAMICS_2, (minPotential + maxPotential) / 2, midAngle);
  const outer = invertExternalPoint(DYNAMICS_2, maxPotential, midAngle);
  for (const solved of [inner, middle, outer]) assert.equal(solved.kind, 'solution');
  if (inner.kind !== 'solution' || middle.kind !== 'solution' || outer.kind !== 'solution') return;
  assert.ok(cxAbs(inner.z) < cxAbs(middle.z) && cxAbs(middle.z) < cxAbs(outer.z));
  assert.ok(cxArg(middle.z) > left - 0.05 && cxArg(middle.z) < right + 0.05);
  const region = sampleSectorRegion(DYNAMICS_2, { left, right }, [minPotential, maxPotential], SMALL_REGION);
  assert.equal(region.kind, 'region');
  if (region.kind !== 'region') return;
  // Radii along the region boundary stay inside the potential annulus.
  for (const point of region.boundary2) {
    const radius = Math.hypot(point.x, point.y);
    assert.ok(radius > 0.9 * Math.exp(minPotential) && radius < 1.1 * Math.exp(maxPotential));
    const argument = argumentOf(point);
    assert.ok(argument > left - 0.05 && argument < right + 0.05);
  }
});

test('sampled external ray helper maps a full potential ladder', () => {
  const potentials = [0.4, 0.8, 1.2, 1.6];
  const ray = sampleExternalRayPoints(DYNAMICS_2, 2.2, potentials, defaultSectorRegionOptions());
  assert.ok(!('kind' in ray) || ray.kind !== 'failure');
  if (!('points' in ray) || !('maxResidual' in ray)) return;
  assert.equal(ray.points.length, 4);
  assert.ok(ray.maxResidual <= 1e-6);
  let previous = 0;
  for (const point of ray.points) {
    const radius = Math.hypot(point.x, point.y);
    assert.ok(radius > previous);
    previous = radius;
  }
  // c = 0 exactness.
  const exact = sampleExternalRayPoints({ power: 2, c: 0 }, Math.PI / 4, potentials, defaultSectorRegionOptions());
  if (!('points' in exact)) return;
  exact.points.forEach((point, index) => {
    const expected = externalCoordinate(potentials[index]!, Math.PI / 4);
    assert.ok(Math.abs(point.x - expected.re) <= 1e-12 && Math.abs(point.y - expected.im) <= 1e-12);
  });
});

test('adjacent giant sub-sector regions stay angularly ordered', () => {
  // Two adjacent sub-sector spans of a guarded giant sector, as G5.1 produces them.
  const sector = { left: 0.2, right: 5.0 };
  const guard = 1e-3;
  const inner = { left: sector.left + guard, right: sector.right - guard };
  const width = inner.right - inner.left;
  const first = { left: inner.left, right: inner.left + (width * 100) / 697 };
  const second = { left: first.right, right: first.right + (width * 90) / 697 };
  const options: SectorRegionOptions = { ...defaultSectorRegionOptions(), raySampleCount: 3, arcSampleCount: 5 };
  const regionOne = sampleSectorRegion(DYNAMICS_2, first, [0.35, 1.75], options);
  const regionTwo = sampleSectorRegion(DYNAMICS_2, second, [0.35, 1.75], options);
  assert.equal(regionOne.kind, 'region');
  assert.equal(regionTwo.kind, 'region');
  if (regionOne.kind !== 'region' || regionTwo.kind !== 'region') return;
  const argumentsOne = regionOne.boundary2.map(argumentOf);
  const argumentsTwo = regionTwo.boundary2.map(argumentOf);
  const tolerance = 0.05;
  assert.ok(Math.max(...argumentsOne) <= Math.min(...argumentsTwo) + tolerance, 'regions do not interleave');
  for (const argument of argumentsOne) assert.ok(argument >= first.left - tolerance && argument <= first.right + tolerance);
  for (const argument of argumentsTwo) assert.ok(argument >= second.left - tolerance && argument <= second.right + tolerance);
});

test('typed region refusals are deterministic', () => {
  const good = { left: 0.5, right: 1.0 };
  const nonExterior = sampleSectorRegion(DYNAMICS_2, good, [0, 1], SMALL_REGION);
  assert.equal(nonExterior.kind, 'failure');
  if (nonExterior.kind === 'failure') assert.equal(nonExterior.code, 'invalid-potential-range');
  const inverted = sampleSectorRegion(DYNAMICS_2, good, [1.2, 0.8], SMALL_REGION);
  assert.equal(inverted.kind, 'failure');
  if (inverted.kind === 'failure') assert.equal(inverted.code, 'invalid-potential-range');
  const empty = sampleSectorRegion(DYNAMICS_2, { left: 1.0, right: 1.0 }, [0.5, 1], SMALL_REGION);
  assert.equal(empty.kind, 'failure');
  if (empty.kind === 'failure') assert.equal(empty.code, 'invalid-interval');
  const tooWide = sampleSectorRegion(DYNAMICS_2, { left: 0, right: 2 * Math.PI + 0.01 }, [0.5, 1], SMALL_REGION);
  assert.equal(tooWide.kind, 'failure');
  if (tooWide.kind === 'failure') assert.equal(tooWide.code, 'invalid-interval');
  const badCounts = sampleSectorRegion(DYNAMICS_2, good, [0.5, 1], { ...SMALL_REGION, raySampleCount: 1 });
  assert.equal(badCounts.kind, 'failure');
  if (badCounts.kind === 'failure') assert.equal(badCounts.code, 'invalid-options');
  const badArcs = sampleSectorRegion(DYNAMICS_2, good, [0.5, 1], { ...SMALL_REGION, arcSampleCount: 1 });
  assert.equal(badArcs.kind, 'failure');
  if (badArcs.kind === 'failure') assert.equal(badArcs.code, 'invalid-options');
  // A solver that cannot refine (zero Newton iterations) fails deterministically with the
  // propagated inverse-ray code instead of substituting a decoration.
  const unsolved = sampleSectorRegion(DYNAMICS_2, good, [0.5, 1.5], { ...SMALL_REGION, maxNewtonIterations: 0 });
  assert.equal(unsolved.kind, 'failure');
  if (unsolved.kind === 'failure') {
    assert.equal(unsolved.code, 'region-sample-failed');
    assert.equal(unsolved.sampleCode, 'max-iterations-exceeded');
    assert.ok(unsolved.sampleAngle !== undefined && unsolved.samplePotential !== undefined);
  }
  const fullCircle = sampleSectorRegion(DYNAMICS_2, { left: 0, right: 2 * Math.PI }, [0.5, 1.5], SMALL_REGION);
  assert.equal(fullCircle.kind, 'region');
});

test('grids and the 3D scalar lift helper', () => {
  const potentials = potentialGrid(0.25, 1.75, 7);
  assert.equal(potentials.length, 7);
  assert.equal(potentials[0], 0.25);
  assert.equal(potentials[6], 1.75);
  for (let index = 1; index < potentials.length; index += 1) assert.ok(potentials[index]! > potentials[index - 1]!);
  assert.deepEqual(potentialGrid(1.5, 1.5, 4), [1.5, 1.5, 1.5, 1.5]);
  const angles = angleGrid(-0.4, 0.9, 6);
  assert.equal(angles[0], -0.4);
  assert.equal(angles[5], 0.9);
  for (let index = 1; index < angles.length; index += 1) assert.ok(angles[index]! > angles[index - 1]!);
  const z: Complex = { re: 1.25, im: -0.5 };
  assert.deepEqual(liftNodeScalar3d(z, 0.875), { x: 1.25, y: -0.5, z: 0.875 });
  assert.ok(FRACTAL_3D_SCALAR_LIFT_LIMITATION.length > 0);
});
