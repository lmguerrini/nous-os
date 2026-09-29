import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestPayload } from '../../src/engine/digest.ts';
import { cx, cxClose } from '../../src/indra/complex.ts';
import { mobiusApply } from '../../src/indra/mobius.ts';
import {
  buildSchottkyGroup, buildSchottkyGroupFromChildren, orderChildrenByWeight, packPairedDiscsOnRing,
  ringOrientationAngle, type RingPackingChild, type SchottkyPairInput,
} from '../../src/indra/schottky.ts';

const R = 0.4;

function knownAnswerPairs(): SchottkyPairInput[] {
  return [
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: R },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ];
}

function eightChildren(): RingPackingChild[] {
  return [
    { id: 'child-a', weight: 8 },
    { id: 'child-b', weight: 7 },
    { id: 'child-c', weight: 6 },
    { id: 'child-d', weight: 5 },
    { id: 'child-e', weight: 4 },
    { id: 'child-f', weight: 3 },
    { id: 'child-g', weight: 2 },
    { id: 'child-h', weight: 1 },
  ];
}

test('the two-pair unit fixture builds a certified rank-2 Schottky group', () => {
  const construction = buildSchottkyGroup(knownAnswerPairs());
  assert.equal(construction.kind, 'schottky');
  if (construction.kind !== 'schottky') return;
  const { group } = construction;
  assert.equal(group.genus, 2);
  assert.equal(group.generators.length, 2);
  assert.ok(Math.abs(group.minimumSeparation - 1.2) < 1e-12, `minimum separation ${group.minimumSeparation}`);
  for (const generator of group.generators) {
    assert.ok(Math.abs(generator.rawDeterminantMagnitude - 0.16) < 1e-12);
    assert.ok(Math.abs(generator.conditionFrobenius - 515.41) < 1e-9);
    assert.ok(generator.identityDeviation < 1e-12);
    assert.ok(generator.exteriorImageRatio < 1);
    assert.ok(generator.exteriorImageRatio > 0.6);
    assert.ok(generator.inverseRoundTripRelativeError < 1e-9);
    assert.equal(generator.a.radius, R);
    assert.equal(generator.b.radius, R);
  }
  const first = group.generators[0];
  if (first === undefined) throw new Error('missing first generator');
  const image = mobiusApply(first.matrix, cx(-3, 0));
  assert.equal(image.kind, 'finite');
  if (image.kind === 'finite') assert.ok(cxClose(image.value, cx(-1.84, 0), { absolute: 1e-12, relative: 1e-12 }));
});

test('group construction is deterministic under double runs', () => {
  const first = buildSchottkyGroup(knownAnswerPairs());
  const second = buildSchottkyGroup(knownAnswerPairs());
  assert.deepEqual(first, second);
});

test('strict separation refuses overlapping, tangent and cross-pair touching discs', () => {
  const overlap = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: 1.1 },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(overlap.kind, 'refusal');
  if (overlap.kind === 'refusal') {
    assert.equal(overlap.code, 'circle-overlap');
    assert.equal(overlap.witness.first, 'a0');
    assert.equal(overlap.witness.second, 'b0');
  }
  const tangent = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: 1.0 },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(tangent.kind, 'refusal');
  if (tangent.kind === 'refusal') assert.equal(tangent.code, 'circle-overlap');
  const crossPair = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(1.5, 0), radius: R },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(crossPair.kind, 'refusal');
  if (crossPair.kind === 'refusal') assert.equal(crossPair.code, 'circle-overlap');
  const nonfinite = buildSchottkyGroup([
    { aCenter: cx(Number.NaN, 0), bCenter: cx(-2, 0), radius: R },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(nonfinite.kind, 'refusal');
  if (nonfinite.kind === 'refusal') assert.equal(nonfinite.code, 'nonfinite-component');
  const zeroRadius = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: 0 },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(zeroRadius.kind, 'refusal');
  if (zeroRadius.kind === 'refusal') assert.equal(zeroRadius.code, 'nonpositive-radius');
});

test('genus below two, degenerate determinants and condition bounds produce typed refusals', () => {
  const singlePair = buildSchottkyGroup([knownAnswerPairs()[0] as SchottkyPairInput]);
  assert.equal(singlePair.kind, 'refusal');
  if (singlePair.kind === 'refusal') assert.equal(singlePair.code, 'insufficient-genus');
  assert.equal(buildSchottkyGroup([]).kind, 'refusal');
  const tinyRadius = buildSchottkyGroup([
    { aCenter: cx(-4, 0), bCenter: cx(-2, 0), radius: 1e-7 },
    { aCenter: cx(2, 0), bCenter: cx(4, 0), radius: R },
  ]);
  assert.equal(tinyRadius.kind, 'refusal');
  if (tinyRadius.kind === 'refusal') assert.equal(tinyRadius.code, 'degenerate-determinant');
  const illConditioned = buildSchottkyGroup(knownAnswerPairs(), { conditionBound: 100 });
  assert.equal(illConditioned.kind, 'refusal');
  if (illConditioned.kind === 'refusal') assert.equal(illConditioned.code, 'condition-bound-exceeded');
});

test('ring packing orders children by descending weight with codepoint ID ties', () => {
  const ordered = orderChildrenByWeight([
    { id: 'b', weight: 5 },
    { id: 'a', weight: 9 },
    { id: 'd', weight: 5 },
    { id: 'c', weight: 9 },
  ]);
  assert.deepEqual(ordered.map(child => child.id), ['a', 'c', 'b', 'd']);
});

test('ring packing places eight children into four separated generator pairs deterministically', () => {
  const packed = packPairedDiscsOnRing(eightChildren(), { orientationKey: 'parent-root' });
  assert.equal(packed.kind, 'packed');
  if (packed.kind !== 'packed') return;
  assert.equal(packed.generatorPairs, 4);
  assert.equal(packed.pairs.length, 4);
  assert.deepEqual(packed.usedChildIds, ['child-a', 'child-b', 'child-c', 'child-d', 'child-e', 'child-f', 'child-g', 'child-h']);
  assert.deepEqual(packed.discardedChildIds, []);
  assert.equal(packed.pairs[0]?.radius, 0.4);
  assert.equal(packed.pairs[3]?.radius, 0.1);
  assert.ok(packed.expansionFactor > 1);
  assert.ok(packed.ringRadius > 0.4);
  const circles = packed.pairs.flatMap(pair => [
    { center: pair.aCenter, radius: pair.radius },
    { center: pair.bCenter, radius: pair.radius },
  ]);
  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      const first = circles[i] as { center: { re: number; im: number }; radius: number };
      const second = circles[j] as { center: { re: number; im: number }; radius: number };
      const distance = Math.hypot(first.center.re - second.center.re, first.center.im - second.center.im);
      assert.ok(distance - (first.radius + second.radius) > 1e-6, `circles ${i},${j} distance ${distance}`);
    }
  }
  assert.ok(packed.ringRadius > Math.hypot(packed.pairs[0]?.aCenter.re ?? 0, packed.pairs[0]?.aCenter.im ?? 0) - 1e-9);
  const repeat = packPairedDiscsOnRing([...eightChildren()].reverse(), { orientationKey: 'parent-root' });
  assert.deepEqual(repeat, packed);
});

test('ring packing orientation comes from the digest of the parent key', () => {
  const digest = digestPayload(['indra-ring-orientation-v1', 'parent-root']);
  const word = Number.parseInt(digest.slice(0, 8), 16);
  const expected = (2 * Math.PI * word) / 4294967296;
  assert.ok(Math.abs(ringOrientationAngle('parent-root') - expected) < 1e-15);
  const noKey = packPairedDiscsOnRing(eightChildren());
  if (noKey.kind !== 'packed') throw new Error('packing unexpectedly failed');
  assert.equal(noKey.orientationAngle, 0);
  const withRoot = packPairedDiscsOnRing(eightChildren(), { orientationKey: 'parent-root' });
  const withOther = packPairedDiscsOnRing(eightChildren(), { orientationKey: 'parent-other' });
  if (withRoot.kind !== 'packed' || withOther.kind !== 'packed') throw new Error('packing unexpectedly failed');
  assert.notEqual(withRoot.orientationAngle, withOther.orientationAngle);
});

test('ring packing reduces the genus before failing when expansion is capped', () => {
  const reduced = packPairedDiscsOnRing(eightChildren(), { maxExpansionFactor: 1.5, orientationKey: 'parent-root' });
  assert.equal(reduced.kind, 'packed');
  if (reduced.kind === 'packed') {
    assert.equal(reduced.generatorPairs, 2);
    assert.equal(reduced.pairs.length, 2);
    assert.deepEqual(reduced.usedChildIds, ['child-a', 'child-b', 'child-c', 'child-d']);
    assert.deepEqual(reduced.discardedChildIds, ['child-e', 'child-f', 'child-g', 'child-h']);
  }
  const failed = packPairedDiscsOnRing(eightChildren(), { maxExpansionFactor: 1.05, orientationKey: 'parent-root' });
  assert.equal(failed.kind, 'refusal');
  if (failed.kind === 'refusal') assert.equal(failed.code, 'packing-failure');
});

test('ring packing refuses insufficient children and invalid weights', () => {
  const tooFew = packPairedDiscsOnRing([
    { id: 'a', weight: 1 },
    { id: 'b', weight: 2 },
    { id: 'c', weight: 3 },
  ]);
  assert.equal(tooFew.kind, 'refusal');
  if (tooFew.kind === 'refusal') assert.equal(tooFew.code, 'insufficient-children');
  const zeroWeight = packPairedDiscsOnRing([...eightChildren(), { id: 'child-zero', weight: 0 }]);
  assert.equal(zeroWeight.kind, 'refusal');
  if (zeroWeight.kind === 'refusal') assert.equal(zeroWeight.code, 'invalid-child-weight');
  const nanWeight = packPairedDiscsOnRing([...eightChildren(), { id: 'child-nan', weight: Number.NaN }]);
  assert.equal(nanWeight.kind, 'refusal');
  if (nanWeight.kind === 'refusal') assert.equal(nanWeight.code, 'invalid-child-weight');
});

test('child-driven construction certifies a group and carries the fallback diagnostic', () => {
  const construction = buildSchottkyGroupFromChildren(eightChildren(), { orientationKey: 'parent-root' });
  assert.equal(construction.kind, 'schottky');
  if (construction.kind === 'schottky') assert.equal(construction.group.genus, 4);
  const tooFew = buildSchottkyGroupFromChildren([{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }, { id: 'c', weight: 3 }]);
  assert.equal(tooFew.kind, 'refusal');
  if (tooFew.kind === 'refusal') assert.equal(tooFew.code, 'insufficient-children');
  const repeat = buildSchottkyGroupFromChildren([...eightChildren()].reverse(), { orientationKey: 'parent-root' });
  assert.deepEqual(repeat, construction);
});
