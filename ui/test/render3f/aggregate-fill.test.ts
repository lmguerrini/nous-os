import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import {
  aggregateFillCoverage,
  createAggregateRenderResources,
} from "#render3f/aggregate-material.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { resolvedScene } from "./support.ts";

/** This differs from DEFAULT_CALIBRATION in exactly the three window-fill fields under test. */
const CUSTOM_FILL_CALIBRATION: CalibrationProfile = {
  ...DEFAULT_CALIBRATION,
  aggregate: {
    ...DEFAULT_CALIBRATION.aggregate,
    windowFillOpacityPermille: 420,
    windowFillCoreRadiusFractionPermille: 260,
    windowFillFalloffPermille: 900,
  },
};

test("a non-default calibration's window-fill values reach the scene, the packed buffers, and the geometry attribute the shader reads", () => {
  const defaultScene = resolvedScene();
  const customScene = resolvedScene(CUSTOM_FILL_CALIBRATION);
  assert.ok(defaultScene.aggregates.length > 0, "fixture graph must resolve at least one aggregate window");
  assert.equal(defaultScene.aggregates.length, customScene.aggregates.length);

  for (const aggregate of defaultScene.aggregates) {
    assert.equal(aggregate.windowFillOpacityPermille, DEFAULT_CALIBRATION.aggregate.windowFillOpacityPermille);
    assert.equal(
      aggregate.windowFillCoreRadiusFractionPermille,
      DEFAULT_CALIBRATION.aggregate.windowFillCoreRadiusFractionPermille,
    );
    assert.equal(aggregate.windowFillFalloffPermille, DEFAULT_CALIBRATION.aggregate.windowFillFalloffPermille);
  }
  for (const aggregate of customScene.aggregates) {
    assert.equal(aggregate.windowFillOpacityPermille, CUSTOM_FILL_CALIBRATION.aggregate.windowFillOpacityPermille);
    assert.equal(
      aggregate.windowFillCoreRadiusFractionPermille,
      CUSTOM_FILL_CALIBRATION.aggregate.windowFillCoreRadiusFractionPermille,
    );
    assert.equal(aggregate.windowFillFalloffPermille, CUSTOM_FILL_CALIBRATION.aggregate.windowFillFalloffPermille);
  }

  const defaultBuffers = buildSceneBuffers(defaultScene).aggregates;
  const customBuffers = buildSceneBuffers(customScene).aggregates;
  assert.deepEqual(
    [...defaultBuffers.windowFillOpacityPermille],
    defaultScene.aggregates.map(() => DEFAULT_CALIBRATION.aggregate.windowFillOpacityPermille),
  );
  assert.deepEqual(
    [...customBuffers.windowFillOpacityPermille],
    customScene.aggregates.map(() => CUSTOM_FILL_CALIBRATION.aggregate.windowFillOpacityPermille),
  );
  assert.notDeepEqual(
    [...defaultBuffers.windowFillOpacityPermille],
    [...customBuffers.windowFillOpacityPermille],
  );
  assert.notDeepEqual(
    [...defaultBuffers.windowFillCoreRadiusFractionPermille],
    [...customBuffers.windowFillCoreRadiusFractionPermille],
  );
  assert.notDeepEqual(
    [...defaultBuffers.windowFillFalloffPermille],
    [...customBuffers.windowFillFalloffPermille],
  );

  const defaultResources = createAggregateRenderResources(defaultBuffers);
  const customResources = createAggregateRenderResources(customBuffers);
  try {
    for (const attributeName of [
      "a_windowFillOpacityPermille",
      "a_windowFillCoreRadiusFractionPermille",
      "a_windowFillFalloffPermille",
    ] as const) {
      const defaultAttribute = requiredScalarAttribute(defaultResources.geometry, attributeName);
      const customAttribute = requiredScalarAttribute(customResources.geometry, attributeName);
      assert.notDeepEqual([...defaultAttribute.array], [...customAttribute.array]);
    }
    assert.deepEqual(
      [...requiredScalarAttribute(defaultResources.geometry, "a_windowFillOpacityPermille").array],
      [...defaultBuffers.windowFillOpacityPermille],
    );
    assert.deepEqual(
      [...requiredScalarAttribute(customResources.geometry, "a_windowFillOpacityPermille").array],
      [...customBuffers.windowFillOpacityPermille],
    );
  } finally {
    defaultResources.geometry.dispose();
    defaultResources.material.dispose();
    customResources.geometry.dispose();
    customResources.material.dispose();
  }
});

test("aggregate fill coverage holds its peak across the core radius, then falls monotonically to zero at the rim", () => {
  const radiusDevicePx = 200;
  const fillOpacity = DEFAULT_CALIBRATION.aggregate.windowFillOpacityPermille / 1000;
  const coreFraction = DEFAULT_CALIBRATION.aggregate.windowFillCoreRadiusFractionPermille / 1000;
  const falloffExponent = DEFAULT_CALIBRATION.aggregate.windowFillFalloffPermille / 1000;
  const coverageAt = (fraction: number): number => aggregateFillCoverage(
    fraction * radiusDevicePx,
    radiusDevicePx,
    fillOpacity,
    coreFraction,
    falloffExponent,
  );

  assert.equal(coverageAt(0), fillOpacity, "the portal centre is not held at the fill's peak");
  assert.equal(coverageAt(coreFraction), fillOpacity, "the plateau does not extend to the declared core fraction");
  assert.equal(coverageAt(1), 0, "the fill has not reached zero exactly at the rim");
  assert.equal(coverageAt(1.4), 0, "distance beyond the resolved radius is not clamped to zero fill");

  const sampleCount = 64;
  let previous = coverageAt(coreFraction);
  for (let index = 1; index <= sampleCount; index += 1) {
    const fraction = coreFraction + ((1 - coreFraction) * (index / sampleCount));
    const current = coverageAt(fraction);
    assert.ok(current <= previous + Number.EPSILON, `fill coverage rose from ${previous} to ${current} moving toward the rim`);
    previous = current;
  }
});

/**
 * The fill must stay strictly below the rim's own opacity, because a fill that reaches or passes it
 * stops reading as an interior and swallows the boundary. That is the whole of what an alpha ratio can
 * honestly assert here.
 *
 * An earlier version of this file demanded the fill stay under three-quarters of the rim, on the
 * reasoning that the rim should keep more visual weight. **The human product direction has since
 * inverted that**: portals must read as "softly filled containers, not UI circles", with rims
 * "thin/subordinate". Under that direction a fill at 85% of a deliberately thin rim is the intent, not
 * a drift, so a ceiling that fails it would be encoding a superseded art direction as a gate.
 *
 * The magnitude of subordination is measured where it is actually visible, in decoded pixels, by the
 * matrix suite: the fill must sit measurably above the field and measurably below the node and filament
 * content drawn inside the portal, and the rim must sit measurably above its immediate background. An
 * audit correctly observed that a bare comparison could not see the fill move from 69% to 85% of the
 * rim. The answer is not a tighter ratio — it is that the ratio was the wrong instrument, and the
 * instrument that can see it already exists and already fires.
 */
function assertFillBelowStroke(fillOpacity: number, strokeOpacity: number): void {
  assert.ok(
    fillOpacity < strokeOpacity,
    `fill peak alpha ${fillOpacity} is not below the rim stroke alpha ${strokeOpacity}, so the rim stops reading as a boundary`,
  );
}

test("aggregate fill opacity stays below the rim stroke's own opacity", () => {
  const fillOpacity = DEFAULT_CALIBRATION.aggregate.windowFillOpacityPermille / 1000;
  const strokeOpacity = DEFAULT_CALIBRATION.aggregate.windowStrokeAlphaPermille / 1000;
  assertFillBelowStroke(fillOpacity, strokeOpacity);

  // Negative controls: a fill that reaches or passes the rim must fail, because that is the point at
  // which the boundary stops being readable. The magnitude short of that is measured in decoded pixels
  // by the matrix suite, not here.
  assert.throws(
    () => assertFillBelowStroke(0.26, 0.26),
    /is not below the rim stroke alpha/,
  );
  assert.throws(
    () => assertFillBelowStroke(0.30, 0.26),
    /is not below the rim stroke alpha/,
  );
});

test("aggregate fill coverage refuses a non-positive resolved radius", () => {
  assert.throws(() => aggregateFillCoverage(10, 0, 0.05, 0.5, 1.8), /positive resolved radius/);
  assert.throws(() => aggregateFillCoverage(10, -5, 0.05, 0.5, 1.8), /positive resolved radius/);
});

function requiredScalarAttribute(
  geometry: THREE.InstancedBufferGeometry,
  name: string,
): THREE.InstancedBufferAttribute {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.InstancedBufferAttribute)) {
    throw new TypeError(`aggregate geometry attribute ${name} is unavailable`);
  }
  return attribute;
}
