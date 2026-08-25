import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBytes } from "#engine/canonical.ts";
import {
  CALIBRATION_PARAMETER_PATHS,
  DEFAULT_CALIBRATION,
  assertCalibrationProfile,
} from "#engine/calibration.ts";

const EXPECTED_PATHS = [
  "layout.forceStrengthPermille", "layout.idealEdgeLengthPx", "layout.iterations", "layout.gravityPermille", "layout.seed", "layout.cellJitterPermille", "layout.framingMarginPermille",
  "salience.degreeExponentPermille", "salience.minNodeSizePx", "salience.maxNodeSizePx",
  "luminance.haloRadiusFactorPermille", "luminance.haloFalloffPermille", "luminance.haloSampleCount", "luminance.coreBeforeHaloMinimumPx", "luminance.prominenceLightnessGainPermille", "luminance.prominenceChromaFalloffPermille", "luminance.haloProbeRadiusFractionPermille", "luminance.minimumNodeContrastPermille",
  "filament.baseWidthPx",
  "filament.pickTolerancePx", "filament.opacityPermille", "filament.curvatureMagnitudePermille", "filament.minimumWidthFactorPermille",
  "morphology.stellar.nodeSizeMultiplierPermille", "morphology.stellar.filamentWidthMultiplierPermille", "morphology.stellar.filamentWidthStartPermille", "morphology.stellar.filamentWidthEndPermille", "morphology.stellar.filamentWobbleAmplitudePermille", "morphology.stellar.junctionThickeningPermille", "morphology.stellar.sheathScalePermille", "morphology.stellar.sheathAlphaPermille", "morphology.stellar.coreScalePermille", "morphology.stellar.hotMixPermille", "morphology.stellar.hotAlphaPermille", "morphology.stellar.hotCoreMaximumHop", "morphology.stellar.filamentPhaseSeed", "morphology.stellar.wobbleFrequencyMilliradians", "morphology.stellar.opacityPermille", "morphology.stellar.curvatureMagnitudePermille", "morphology.stellar.haloRadiusMultiplierPermille", "morphology.stellar.haloIntensityPermille", "morphology.stellar.terminalSizeMultiplierPermille",
  "morphology.neural.nodeSizeMultiplierPermille", "morphology.neural.filamentWidthMultiplierPermille", "morphology.neural.filamentWidthStartPermille", "morphology.neural.filamentWidthEndPermille", "morphology.neural.filamentWobbleAmplitudePermille", "morphology.neural.junctionThickeningPermille", "morphology.neural.sheathScalePermille", "morphology.neural.sheathAlphaPermille", "morphology.neural.coreScalePermille", "morphology.neural.hotMixPermille", "morphology.neural.hotAlphaPermille", "morphology.neural.hotCoreMaximumHop", "morphology.neural.filamentPhaseSeed", "morphology.neural.wobbleFrequencyMilliradians", "morphology.neural.opacityPermille", "morphology.neural.curvatureMagnitudePermille", "morphology.neural.haloRadiusMultiplierPermille", "morphology.neural.haloIntensityPermille", "morphology.neural.terminalSizeMultiplierPermille",
  "morphology.mycelium.nodeSizeMultiplierPermille", "morphology.mycelium.filamentWidthMultiplierPermille", "morphology.mycelium.filamentWidthStartPermille", "morphology.mycelium.filamentWidthEndPermille", "morphology.mycelium.filamentWobbleAmplitudePermille", "morphology.mycelium.junctionThickeningPermille", "morphology.mycelium.sheathScalePermille", "morphology.mycelium.sheathAlphaPermille", "morphology.mycelium.coreScalePermille", "morphology.mycelium.hotMixPermille", "morphology.mycelium.hotAlphaPermille", "morphology.mycelium.hotCoreMaximumHop", "morphology.mycelium.filamentPhaseSeed", "morphology.mycelium.wobbleFrequencyMilliradians", "morphology.mycelium.opacityPermille", "morphology.mycelium.curvatureMagnitudePermille", "morphology.mycelium.haloRadiusMultiplierPermille", "morphology.mycelium.haloIntensityPermille", "morphology.mycelium.terminalSizeMultiplierPermille",
  "lod.bandThresholds", "lod.hysteresisMarginPermille", "lod.crossfadeDurationMs", "lod.macroNodeSizeMultiplierPermille", "lod.macroFilamentWidthMultiplierPermille", "lod.macroAggregateOutlineWidthMultiplierPermille", "lod.macroAggregateOutlineAlphaPermille", "lod.microHopDistanceLightnessStepPermille", "lod.minimumAdjacentPixelDeltaPermille",
  "labels.densityCap", "labels.priorityWeights.node", "labels.priorityWeights.edge", "labels.priorityWeights.assertion", "labels.priorityWeights.bridge", "labels.collisionPaddingPx",
  "aggregate.disclosureThreshold", "aggregate.windowPaddingPx", "aggregate.windowStrokeAlphaPermille",
  "motion.propagationSpeedPxPerSecond", "motion.afterglowDecayPermille", "motion.minimumReducedMotionPixelDeltaPermille", "motion.reducedMotionSwitch",
  "selection.emphasisMultiplierPermille", "selection.focusDimFactorPermille",
  "budget.maxNodesBeforeLodForcesAggregation", "budget.targetFrameMs",
] as const;

test("calibration register is an exact pinned set in both directions", () => {
  assert.deepEqual([...CALIBRATION_PARAMETER_PATHS].sort(), [...EXPECTED_PATHS].sort());
  assert.deepEqual([...EXPECTED_PATHS].sort(), [...CALIBRATION_PARAMETER_PATHS].sort());
  assert.equal(CALIBRATION_PARAMETER_PATHS.length, 106);
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
