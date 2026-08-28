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

test("aggregate fill coverage stays clearly subordinate to the rim stroke's own opacity", () => {
  const fillOpacity = DEFAULT_CALIBRATION.aggregate.windowFillOpacityPermille / 1000;
  const strokeOpacity = DEFAULT_CALIBRATION.aggregate.windowStrokeAlphaPermille / 1000;
  assert.ok(
    fillOpacity < strokeOpacity,
    `fill peak alpha ${fillOpacity} is not clearly subtler than the rim stroke alpha ${strokeOpacity}`,
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
