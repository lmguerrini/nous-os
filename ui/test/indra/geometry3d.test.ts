import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cx } from '../../src/indra/complex.ts';
import { MOBIUS_IDENTITY, mobiusMatrix } from '../../src/indra/mobius.ts';
import { buildSchottkyGroup } from '../../src/indra/schottky.ts';
import {
  FALLBACK_PACKING_VERSION, HALF_SPACE_VERSION, halfSpaceHyperbolicDistance, halfSpaceImage,
  halfSpaceIsometry, halfSpacePoint, halfSpaceRoundTrip, hemisphereOfCircle, onHemisphereSphere,
  packFallbackNestedSpheres, sampleHemisphere,
  type FallbackSphere, type HalfSpacePoint,
} from '../../src/indra/geometry3d.ts';

const R = 0.4;

function knownGroup() {
  const construction = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: R },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  if (construction.kind !== 'schottky') throw new Error('the known-answer group failed to build');
  return construction.group;
}

test('the identity keeps the point and reports denominator one', () => {
  const outcome = halfSpaceImage(MOBIUS_IDENTITY, halfSpacePoint(0.3, 0.1, 1.4));
  assert.equal(outcome.kind, 'image');
  if (outcome.kind !== 'image') return;
  assert.deepEqual(outcome.point, { z: { re: 0.3, im: 0.1 }, t: 1.4 });
  assert.equal(outcome.denominator, 1);
});

test('a determinant-one dilation (z,t) -> (lambda^2 z, lambda^2 t) has a known answer', () => {
  const matrix = mobiusMatrix(cx(2, 0), cx(0, 0), cx(0, 0), cx(0.5, 0));
  const outcome = halfSpaceImage(matrix, halfSpacePoint(0.3, 0.1, 1.4));
  assert.equal(outcome.kind, 'image');
  if (outcome.kind !== 'image') return;
  assert.ok(Math.abs(outcome.point.z.re - 1.2) < 1e-12);
  assert.ok(Math.abs(outcome.point.z.im - 0.4) < 1e-12);
  assert.ok(Math.abs(outcome.point.t - 5.6) < 1e-12);
  assert.ok(Math.abs(outcome.denominator - 0.25) < 1e-12);
});

test('a translation slides z and fixes t', () => {
  const matrix = mobiusMatrix(cx(1, 0), cx(3, 0), cx(0, 0), cx(1, 0));
  const outcome = halfSpaceImage(matrix, halfSpacePoint(-1, 0.5, 2));
  assert.equal(outcome.kind, 'image');
  if (outcome.kind !== 'image') return;
  assert.ok(Math.abs(outcome.point.z.re - 2) < 1e-12);
  assert.ok(Math.abs(outcome.point.z.im - 0.5) < 1e-12);
  assert.ok(Math.abs(outcome.point.t - 2) < 1e-12);
  assert.equal(outcome.denominator, 1);
});

test('z -> -1/z maps the unit hemisphere onto itself', () => {
  const matrix = mobiusMatrix(cx(0, 0), cx(-1, 0), cx(1, 0), cx(0, 0));
  const point = halfSpacePoint(0.6, 0, 0.8);
  const outcome = halfSpaceImage(matrix, point);
  assert.equal(outcome.kind, 'image');
  if (outcome.kind !== 'image') return;
  assert.ok(Math.abs(outcome.point.z.re + 0.6) < 1e-12);
  assert.ok(Math.abs(outcome.point.z.im) < 1e-12);
  assert.ok(Math.abs(outcome.point.t - 0.8) < 1e-12);
  assert.ok(Math.abs(outcome.denominator - 1) < 1e-12);
  assert.ok(onHemisphereSphere(outcome.point, cx(0, 0), 1, 1e-12));
});

test('every generator image keeps t > 0 and inverts exactly on the known group', () => {
  const group = knownGroup();
  const reGrid = [0, 1.3, -1.7, 2.9];
  const imGrid = [0, 0.7, -1.1];
  const tGrid = [0.01, 0.5, 2, 10];
  for (const generator of group.generators) {
    for (const matrix of [generator.matrix, generator.inverse]) {
      for (const re of reGrid) {
        for (const im of imGrid) {
          for (const t of tGrid) {
            const point = halfSpacePoint(re, im, t);
            const image = halfSpaceImage(matrix, point);
            assert.equal(image.kind, 'image', `image failed at (${re},${im},${t})`);
            if (image.kind !== 'image') continue;
            assert.ok(image.point.t > 0, `t' must stay positive, got ${image.point.t}`);
            const roundTrip = halfSpaceRoundTrip(matrix, point);
            assert.equal(roundTrip.kind, 'round-trip');
            if (roundTrip.kind === 'round-trip') {
              assert.ok(roundTrip.zAbsoluteError < 1e-9, `z error ${roundTrip.zAbsoluteError}`);
              assert.ok(roundTrip.tRelativeError < 1e-9, `t error ${roundTrip.tRelativeError}`);
            }
          }
        }
      }
    }
  }
});

test('the extension is a hyperbolic isometry on sampled point pairs', () => {
  const group = knownGroup();
  const samples: HalfSpacePoint[] = [
    halfSpacePoint(0, 0, 1),
    halfSpacePoint(1.1, -0.4, 0.3),
    halfSpacePoint(-2.2, 1.5, 4),
    halfSpacePoint(3, 3, 0.05),
  ];
  for (const generator of group.generators) {
    for (const matrix of [generator.matrix, generator.inverse]) {
      for (let i = 0; i < samples.length; i += 1) {
        for (let j = i + 1; j < samples.length; j += 1) {
          const outcome = halfSpaceIsometry(matrix, samples[i] as HalfSpacePoint, samples[j] as HalfSpacePoint);
          assert.equal(outcome.kind, 'witness');
          if (outcome.kind !== 'witness') continue;
          assert.ok(outcome.result.absoluteError < 1e-9, `isometry error ${outcome.result.absoluteError}`);
          assert.ok(outcome.result.relativeError < 1e-9, `relative isometry error ${outcome.result.relativeError}`);
        }
      }
    }
  }
  const translation = mobiusMatrix(cx(1, 0), cx(3, 0), cx(0, 0), cx(1, 0));
  const translated = halfSpaceIsometry(translation, halfSpacePoint(0.5, 0.5, 1), halfSpacePoint(-4, 2, 0.2));
  assert.equal(translated.kind, 'witness');
  if (translated.kind === 'witness') assert.ok(translated.result.absoluteError < 1e-12);
});

test('the hyperbolic distance on a vertical geodesic is the log ratio', () => {
  const distance = halfSpaceHyperbolicDistance(halfSpacePoint(0, 0, 1), halfSpacePoint(0, 0, Math.E));
  assert.ok(Math.abs(distance - 1) < 1e-12, `distance ${distance}`);
  assert.equal(halfSpaceHyperbolicDistance(halfSpacePoint(1, 2, 3), halfSpacePoint(1, 2, 3)), 0);
});

test('the generator maps the hemisphere over A exactly onto the hemisphere over B', () => {
  const group = knownGroup();
  const generator = group.generators[0];
  if (generator === undefined) throw new Error('missing generator');
  const sampled = sampleHemisphere(cx(-4, 0), R, 4, 12);
  assert.equal(sampled.kind, 'samples');
  if (sampled.kind !== 'samples') return;
  assert.equal(sampled.points.length, 48);
  for (const sample of sampled.points) {
    const point = { z: { re: sample.x, im: sample.y }, t: sample.z };
    assert.ok(onHemisphereSphere(point, cx(-4, 0), R, 1e-12), 'sample must sit on the A hemisphere');
    assert.ok(point.t > 0);
    const image = halfSpaceImage(generator.matrix, point);
    assert.equal(image.kind, 'image');
    if (image.kind !== 'image') continue;
    assert.ok(onHemisphereSphere(image.point, cx(-2, 0), R, 1e-9), `image must sit on the B hemisphere, got t=${image.point.t}`);
    assert.ok(image.point.t > 0);
  }
});

test('hemisphere sampling is deterministic, strictly positive and refuses bad parameters', () => {
  const first = sampleHemisphere(cx(1, -1), 2, 3, 8);
  const second = sampleHemisphere(cx(1, -1), 2, 3, 8);
  assert.deepEqual(first, second);
  if (first.kind !== 'samples') return;
  for (const point of first.points) assert.ok(point.z > 0);
  const top = first.points[0];
  if (top === undefined) throw new Error('no samples');
  const expectedRadius = 2 * Math.sin(Math.PI / 8);
  assert.ok(Math.abs(top.x - (1 + expectedRadius)) < 1e-12, `first ring starts at angle zero, got x=${top.x}`);
  assert.ok(Math.abs(top.y + 1) < 1e-12, `first ring starts at angle zero, got y=${top.y}`);
  assert.equal(sampleHemisphere(cx(0, 0), 1, 0, 8).kind, 'refusal');
  const badSteps = sampleHemisphere(cx(0, 0), 1, 2, 2);
  assert.equal(badSteps.kind, 'refusal');
  if (badSteps.kind === 'refusal') assert.equal(badSteps.code, 'invalid-sampling');
  const zeroRadius = hemisphereOfCircle(cx(0, 0), 0);
  assert.equal(zeroRadius.kind, 'refusal');
  if (zeroRadius.kind === 'refusal') assert.equal(zeroRadius.code, 'nonpositive-radius');
  const unit = hemisphereOfCircle(cx(1, 1), 1);
  assert.equal(unit.kind, 'hemisphere');
  if (unit.kind === 'hemisphere') {
    assert.deepEqual(unit.geometry.center3, { x: 1, y: 1, z: 0 });
    assert.equal(unit.geometry.radius, 1);
  }
});

test('refusals: nonpositive or nonfinite t, nonfinite points and singular matrices', () => {
  const zero = halfSpaceImage(MOBIUS_IDENTITY, halfSpacePoint(1, 0, 0));
  assert.equal(zero.kind, 'refusal');
  if (zero.kind === 'refusal') assert.equal(zero.code, 'nonpositive-t');
  const negative = halfSpaceRoundTrip(MOBIUS_IDENTITY, halfSpacePoint(1, 0, -2));
  assert.equal(negative.kind, 'refusal');
  if (negative.kind === 'refusal') assert.equal(negative.code, 'nonpositive-t');
  const nonfinite = halfSpaceImage(MOBIUS_IDENTITY, halfSpacePoint(Number.NaN, 0, 1));
  assert.equal(nonfinite.kind, 'refusal');
  if (nonfinite.kind === 'refusal') assert.equal(nonfinite.code, 'nonfinite-point');
  const singular = halfSpaceImage(mobiusMatrix(cx(1, 0), cx(0, 0), cx(0, 0), cx(0, 0)), halfSpacePoint(1, 0, 1));
  assert.equal(singular.kind, 'refusal');
  if (singular.kind === 'refusal') assert.equal(singular.code, 'degenerate-matrix');
});

test('the fallback nested spheres stay separated, inside the parent, weight-ordered and deterministic', () => {
  const children = [
    { id: 'child-a', weight: 8 },
    { id: 'child-b', weight: 4 },
    { id: 'child-c', weight: 2 },
  ];
  const packed = packFallbackNestedSpheres(children, { orientationKey: 'parent-root' });
  assert.equal(packed.kind, 'packed');
  if (packed.kind !== 'packed') return;
  assert.equal(packed.version, FALLBACK_PACKING_VERSION);
  assert.deepEqual(packed.orderedChildIds, ['child-a', 'child-b', 'child-c']);
  const first = packed.spheres[0];
  const second = packed.spheres[1];
  const third = packed.spheres[2];
  if (first === undefined || second === undefined || third === undefined) throw new Error('missing spheres');
  assert.ok(first.radius > second.radius);
  assert.ok(second.radius > third.radius);
  for (let i = 0; i < packed.spheres.length; i += 1) {
    const a: FallbackSphere | undefined = packed.spheres[i];
    if (a === undefined) continue;
    const norm = Math.hypot(a.center3.x, a.center3.y, a.center3.z);
    assert.ok(norm + a.radius <= 1, `sphere ${a.childId} escapes the parent (${norm}+${a.radius})`);
    for (let j = i + 1; j < packed.spheres.length; j += 1) {
      const b: FallbackSphere | undefined = packed.spheres[j];
      if (b === undefined) continue;
      const distance = Math.hypot(a.center3.x - b.center3.x, a.center3.y - b.center3.y, a.center3.z - b.center3.z);
      assert.ok(distance - (a.radius + b.radius) > 1e-6, `spheres ${a.childId},${b.childId} touch (${distance})`);
    }
  }
  const repeat = packFallbackNestedSpheres([...children].reverse(), { orientationKey: 'parent-root' });
  assert.deepEqual(repeat, packed);
  const noKey = packFallbackNestedSpheres(children);
  if (noKey.kind !== 'packed') throw new Error('packing without key failed');
  assert.equal(noKey.orientationAngle, 0);
  assert.notEqual(noKey.orientationAngle, packed.orientationAngle);
});

test('the fallback handles one and two children and refuses impossible inputs', () => {
  const single = packFallbackNestedSpheres([{ id: 'only', weight: 3 }]);
  assert.equal(single.kind, 'packed');
  if (single.kind === 'packed') {
    assert.equal(single.ringRadius, 0);
    assert.deepEqual(single.spheres[0]?.center3, { x: 0, y: 0, z: 0 });
  }
  const pair = packFallbackNestedSpheres([{ id: 'x', weight: 1 }, { id: 'y', weight: 1 }]);
  assert.equal(pair.kind, 'packed');
  const zeroWeight = packFallbackNestedSpheres([{ id: 'x', weight: 0 }, { id: 'y', weight: 1 }]);
  assert.equal(zeroWeight.kind, 'refusal');
  if (zeroWeight.kind === 'refusal') assert.equal(zeroWeight.code, 'invalid-child-weight');
  assert.equal(packFallbackNestedSpheres([]).kind, 'refusal');
  const impossible = packFallbackNestedSpheres(
    [{ id: 'x', weight: 1 }, { id: 'y', weight: 1 }],
    { parentRadius: 0.001 },
  );
  assert.equal(impossible.kind, 'refusal');
  if (impossible.kind === 'refusal') assert.equal(impossible.code, 'packing-failure');
  const badParent = packFallbackNestedSpheres([{ id: 'x', weight: 1 }], { parentRadius: -1 });
  assert.equal(badParent.kind, 'refusal');
  if (badParent.kind === 'refusal') assert.equal(badParent.code, 'invalid-parent-radius');
});

test('versions are pinned', () => {
  assert.equal(HALF_SPACE_VERSION, 'indra-half-space-v1');
  assert.equal(FALLBACK_PACKING_VERSION, 'indra-fallback-nested-spheres-v1');
});
