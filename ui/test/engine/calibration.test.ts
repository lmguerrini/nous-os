import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBytes } from "#engine/canonical.ts";
import {
  CALIBRATION_PARAMETER_PATHS,
  DEFAULT_CALIBRATION,
  assertCalibrationProfile,
} from "#engine/calibration.ts";

const EXPECTED_PATHS = [
  "layout.forceStrengthPermille", "layout.idealEdgeLengthPx", "layout.iterations", "layout.gravityPermille", "layout.seed",
  "salience.degreeExponentPermille", "salience.minNodeSizePx", "salience.maxNodeSizePx",
  "luminance.haloRadiusFactorPermille", "luminance.haloFalloffPermille", "luminance.coreBeforeHaloMinimumPx",
  "filament.baseWidthPx", "filament.opacityPermille", "filament.curvatureMagnitudePermille", "filament.medialOffsetAmplitudePx",
  "morphology.stellar.nodeSizeMultiplierPermille", "morphology.stellar.filamentWidthMultiplierPermille", "morphology.stellar.opacityPermille", "morphology.stellar.curvatureMagnitudePermille", "morphology.stellar.medialOffsetAmplitudePermille",
  "morphology.neural.nodeSizeMultiplierPermille", "morphology.neural.filamentWidthMultiplierPermille", "morphology.neural.opacityPermille", "morphology.neural.curvatureMagnitudePermille", "morphology.neural.medialOffsetAmplitudePermille",
  "morphology.mycelium.nodeSizeMultiplierPermille", "morphology.mycelium.filamentWidthMultiplierPermille", "morphology.mycelium.opacityPermille", "morphology.mycelium.curvatureMagnitudePermille", "morphology.mycelium.medialOffsetAmplitudePermille",
  "lod.bandThresholds", "lod.hysteresisMarginPermille", "lod.crossfadeDurationMs",
  "labels.densityCap", "labels.priorityWeights.node", "labels.priorityWeights.edge", "labels.priorityWeights.assertion", "labels.priorityWeights.bridge", "labels.collisionPaddingPx",
  "aggregate.disclosureThreshold", "aggregate.windowPaddingPx", "aggregate.windowStrokeAlphaPermille",
  "motion.propagationSpeedPxPerSecond", "motion.afterglowDecayPermille", "motion.reducedMotionSwitch",
  "selection.emphasisMultiplierPermille", "selection.focusDimFactorPermille",
  "budget.maxNodesBeforeLodForcesAggregation", "budget.targetFrameMs",
] as const;

test("calibration register is an exact pinned set in both directions", () => {
  assert.deepEqual([...CALIBRATION_PARAMETER_PATHS].sort(), [...EXPECTED_PATHS].sort());
  assert.deepEqual([...EXPECTED_PATHS].sort(), [...CALIBRATION_PARAMETER_PATHS].sort());
  assert.equal(CALIBRATION_PARAMETER_PATHS.length, 49);
});

test("calibration validator refuses one unknown path", () => {
  const drifted = structuredClone(DEFAULT_CALIBRATION) as Record<string, unknown>;
  (drifted.layout as Record<string, unknown>).unknownVisualKnob = 1;
  assert.throws(() => assertCalibrationProfile(drifted), /unknown calibration parameter path/);
});

test("calibration validator refuses one missing path", () => {
  const incomplete = structuredClone(DEFAULT_CALIBRATION) as Record<string, unknown>;
  delete (incomplete.layout as Record<string, unknown>).seed;
  assert.throws(() => assertCalibrationProfile(incomplete), /missing calibration parameter path/);
});

test("the default calibration is deterministic and canonical-round-trippable", () => {
  const first = structuredClone(DEFAULT_CALIBRATION);
  const second = structuredClone(DEFAULT_CALIBRATION);
  assert.deepEqual(canonicalBytes(first), canonicalBytes(second));
  assert.doesNotThrow(() => canonicalBytes(first));
  assertCalibrationProfile(first);
});
