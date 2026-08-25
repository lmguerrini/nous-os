/** This is the renderer's tunable profile and does not establish semantic meaning. */

export type MorphologyMaterial = {
  readonly nodeSizeMultiplierPermille: number;
  readonly filamentWidthMultiplierPermille: number;
  readonly filamentWidthStartPermille: number;
  readonly filamentWidthEndPermille: number;
  readonly filamentWobbleAmplitudePermille: number;
  readonly junctionThickeningPermille: number;
  readonly sheathScalePermille: number;
  readonly sheathAlphaPermille: number;
  readonly coreScalePermille: number;
  readonly hotMixPermille: number;
  readonly hotAlphaPermille: number;
  readonly hotCoreMaximumHop: number;
  readonly filamentPhaseSeed: number;
  readonly wobbleFrequencyMilliradians: number;
  readonly opacityPermille: number;
  readonly curvatureMagnitudePermille: number;
  readonly haloRadiusMultiplierPermille: number;
  readonly haloIntensityPermille: number;
  readonly terminalSizeMultiplierPermille: number;
};

/** This tunes the aggregate layout region and does not alter aggregate membership. */
export type AggregateLayoutCalibrationProfile = {
  readonly aspectRatioTargetPermille: number;
  readonly aspectRatioTolerancePermille: number;
};

/** This is the aggregate layout register whose values remain independently retunable from material calibration. */
export const DEFAULT_AGGREGATE_LAYOUT_CALIBRATION: AggregateLayoutCalibrationProfile = {
  aspectRatioTargetPermille: 1500,
  aspectRatioTolerancePermille: 300,
};

export type CalibrationProfile = {
  readonly layout: {
    readonly forceStrengthPermille: number;
    readonly idealEdgeLengthPx: number;
    readonly iterations: number;
    readonly gravityPermille: number;
    readonly seed: number;
    readonly cellJitterPermille: number;
    readonly framingMarginPermille: number;
  };
  readonly salience: {
    readonly degreeExponentPermille: number;
    readonly minNodeSizePx: number;
    readonly maxNodeSizePx: number;
  };
  readonly luminance: {
    readonly haloRadiusFactorPermille: number;
    readonly haloFalloffPermille: number;
    readonly haloSampleCount: number;
    readonly coreBeforeHaloMinimumPx: number;
    readonly prominenceLightnessGainPermille: number;
    readonly prominenceChromaFalloffPermille: number;
    readonly haloProbeRadiusFractionPermille: number;
    readonly minimumNodeContrastPermille: number;
    readonly minimumCompositedPixelChannelDelta: number;
  };
  readonly filament: {
    readonly baseWidthPx: number;
    readonly pickTolerancePx: number;
    readonly opacityPermille: number;
    readonly curvatureMagnitudePermille: number;
    readonly minimumWidthFactorPermille: number;
    /** This is the absolute filament body floor in device pixels, scaled by one thousand. */
    readonly minimumDeviceWidthPermille: number;
  };
  readonly morphology: {
    readonly stellar: MorphologyMaterial;
    readonly neural: MorphologyMaterial;
    readonly mycelium: MorphologyMaterial;
  };
  readonly lod: {
    readonly bandThresholds: readonly number[];
    readonly hysteresisMarginPermille: number;
    readonly crossfadeDurationMs: number;
    readonly macroNodeSizeMultiplierPermille: number;
    readonly macroFilamentWidthMultiplierPermille: number;
    readonly macroAggregateOutlineWidthMultiplierPermille: number;
    readonly macroAggregateOutlineAlphaPermille: number;
    readonly microHopDistanceLightnessStepPermille: number;
    readonly minimumAdjacentPixelDeltaPermille: number;
  };
  readonly labels: {
    readonly densityCap: number;
    readonly priorityWeights: {
      readonly node: number;
      readonly edge: number;
      readonly assertion: number;
      readonly bridge: number;
    };
    readonly collisionPaddingPx: number;
  };
  readonly aggregate: {
    readonly disclosureThreshold: number;
    readonly windowPaddingPx: number;
    readonly windowStrokeAlphaPermille: number;
  };
  readonly motion: {
    readonly propagationSpeedPxPerSecond: number;
    readonly afterglowDecayPermille: number;
    readonly minimumReducedMotionPixelDeltaPermille: number;
    readonly reducedMotionSwitch: boolean;
  };
  readonly selection: {
    readonly emphasisMultiplierPermille: number;
    readonly focusDimFactorPermille: number;
    readonly minimumDifferingPixelCount: number;
  };
  readonly budget: {
    readonly maxNodesBeforeLodForcesAggregation: number;
    readonly targetFrameMs: number;
    readonly oracleCrossProductSampleSize: number;
    readonly oracleCrossProductSamplingSeed: number;
    readonly oracleCrossProductPixelWitnessCount: number;
  };
};

/** This is the exact calibration register and does not permit an unpinned visual parameter. */
export const CALIBRATION_PARAMETER_PATHS = [
  "layout.forceStrengthPermille",
  "layout.idealEdgeLengthPx",
  "layout.iterations",
  "layout.gravityPermille",
  "layout.seed",
  "layout.cellJitterPermille",
  "layout.framingMarginPermille",
  "salience.degreeExponentPermille",
  "salience.minNodeSizePx",
  "salience.maxNodeSizePx",
  "luminance.haloRadiusFactorPermille",
  "luminance.haloFalloffPermille",
  "luminance.haloSampleCount",
  "luminance.coreBeforeHaloMinimumPx",
  "luminance.prominenceLightnessGainPermille",
  "luminance.prominenceChromaFalloffPermille",
  "luminance.haloProbeRadiusFractionPermille",
  "luminance.minimumNodeContrastPermille",
  "luminance.minimumCompositedPixelChannelDelta",
  "filament.baseWidthPx",
  "filament.pickTolerancePx",
  "filament.opacityPermille",
  "filament.curvatureMagnitudePermille",
  "filament.minimumWidthFactorPermille",
  "filament.minimumDeviceWidthPermille",
  "morphology.stellar.nodeSizeMultiplierPermille",
  "morphology.stellar.filamentWidthMultiplierPermille",
  "morphology.stellar.filamentWidthStartPermille",
  "morphology.stellar.filamentWidthEndPermille",
  "morphology.stellar.filamentWobbleAmplitudePermille",
  "morphology.stellar.junctionThickeningPermille",
  "morphology.stellar.sheathScalePermille",
  "morphology.stellar.sheathAlphaPermille",
  "morphology.stellar.coreScalePermille",
  "morphology.stellar.hotMixPermille",
  "morphology.stellar.hotAlphaPermille",
  "morphology.stellar.hotCoreMaximumHop",
  "morphology.stellar.filamentPhaseSeed",
  "morphology.stellar.wobbleFrequencyMilliradians",
  "morphology.stellar.opacityPermille",
  "morphology.stellar.curvatureMagnitudePermille",
  "morphology.stellar.haloRadiusMultiplierPermille",
  "morphology.stellar.haloIntensityPermille",
  "morphology.stellar.terminalSizeMultiplierPermille",
  "morphology.neural.nodeSizeMultiplierPermille",
  "morphology.neural.filamentWidthMultiplierPermille",
  "morphology.neural.filamentWidthStartPermille",
  "morphology.neural.filamentWidthEndPermille",
  "morphology.neural.filamentWobbleAmplitudePermille",
  "morphology.neural.junctionThickeningPermille",
  "morphology.neural.sheathScalePermille",
  "morphology.neural.sheathAlphaPermille",
  "morphology.neural.coreScalePermille",
  "morphology.neural.hotMixPermille",
  "morphology.neural.hotAlphaPermille",
  "morphology.neural.hotCoreMaximumHop",
  "morphology.neural.filamentPhaseSeed",
  "morphology.neural.wobbleFrequencyMilliradians",
  "morphology.neural.opacityPermille",
  "morphology.neural.curvatureMagnitudePermille",
  "morphology.neural.haloRadiusMultiplierPermille",
  "morphology.neural.haloIntensityPermille",
  "morphology.neural.terminalSizeMultiplierPermille",
  "morphology.mycelium.nodeSizeMultiplierPermille",
  "morphology.mycelium.filamentWidthMultiplierPermille",
  "morphology.mycelium.filamentWidthStartPermille",
  "morphology.mycelium.filamentWidthEndPermille",
  "morphology.mycelium.filamentWobbleAmplitudePermille",
  "morphology.mycelium.junctionThickeningPermille",
  "morphology.mycelium.sheathScalePermille",
  "morphology.mycelium.sheathAlphaPermille",
  "morphology.mycelium.coreScalePermille",
  "morphology.mycelium.hotMixPermille",
  "morphology.mycelium.hotAlphaPermille",
  "morphology.mycelium.hotCoreMaximumHop",
  "morphology.mycelium.filamentPhaseSeed",
  "morphology.mycelium.wobbleFrequencyMilliradians",
  "morphology.mycelium.opacityPermille",
  "morphology.mycelium.curvatureMagnitudePermille",
  "morphology.mycelium.haloRadiusMultiplierPermille",
  "morphology.mycelium.haloIntensityPermille",
  "morphology.mycelium.terminalSizeMultiplierPermille",
  "lod.bandThresholds",
  "lod.hysteresisMarginPermille",
  "lod.crossfadeDurationMs",
  "lod.macroNodeSizeMultiplierPermille",
  "lod.macroFilamentWidthMultiplierPermille",
  "lod.macroAggregateOutlineWidthMultiplierPermille",
  "lod.macroAggregateOutlineAlphaPermille",
  "lod.microHopDistanceLightnessStepPermille",
  "lod.minimumAdjacentPixelDeltaPermille",
  "labels.densityCap",
  "labels.priorityWeights.node",
  "labels.priorityWeights.edge",
  "labels.priorityWeights.assertion",
  "labels.priorityWeights.bridge",
  "labels.collisionPaddingPx",
  "aggregate.disclosureThreshold",
  "aggregate.windowPaddingPx",
  "aggregate.windowStrokeAlphaPermille",
  "motion.propagationSpeedPxPerSecond",
  "motion.afterglowDecayPermille",
  "motion.minimumReducedMotionPixelDeltaPermille",
  "motion.reducedMotionSwitch",
  "selection.emphasisMultiplierPermille",
  "selection.focusDimFactorPermille",
  "selection.minimumDifferingPixelCount",
  "budget.maxNodesBeforeLodForcesAggregation",
  "budget.targetFrameMs",
  "budget.oracleCrossProductSampleSize",
  "budget.oracleCrossProductSamplingSeed",
  "budget.oracleCrossProductPixelWitnessCount",
] as const;

/** This is the default renderer profile and does not choose a semantic interpretation. All fractional values are scaled integers because canonical JSON accepts only integers. */
export const DEFAULT_CALIBRATION: CalibrationProfile = {
  layout: { forceStrengthPermille: 850, idealEdgeLengthPx: 120, iterations: 180, gravityPermille: 90, seed: 17, cellJitterPermille: 340, framingMarginPermille: 150 },
  salience: { degreeExponentPermille: 650, minNodeSizePx: 4, maxNodeSizePx: 28 },
  luminance: { haloRadiusFactorPermille: 1800, haloFalloffPermille: 180, haloSampleCount: 12, coreBeforeHaloMinimumPx: 2, prominenceLightnessGainPermille: 900, prominenceChromaFalloffPermille: 1000, haloProbeRadiusFractionPermille: 700, minimumNodeContrastPermille: 1200, minimumCompositedPixelChannelDelta: 6 },
  filament: { baseWidthPx: 2,
    pickTolerancePx: 2, opacityPermille: 620, curvatureMagnitudePermille: 240, minimumWidthFactorPermille: 120, minimumDeviceWidthPermille: 1000 },
  morphology: {
    stellar: { nodeSizeMultiplierPermille: 1100, filamentWidthMultiplierPermille: 900, filamentWidthStartPermille: 650, filamentWidthEndPermille: 650, filamentWobbleAmplitudePermille: 15, junctionThickeningPermille: 0, sheathScalePermille: 2700, sheathAlphaPermille: 60, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 17, wobbleFrequencyMilliradians: 6283, opacityPermille: 1000, curvatureMagnitudePermille: 700, haloRadiusMultiplierPermille: 2000, haloIntensityPermille: 440, terminalSizeMultiplierPermille: 1000 },
    neural: { nodeSizeMultiplierPermille: 900, filamentWidthMultiplierPermille: 1050, filamentWidthStartPermille: 1800, filamentWidthEndPermille: 500, filamentWobbleAmplitudePermille: 80, junctionThickeningPermille: 800, sheathScalePermille: 2700, sheathAlphaPermille: 130, coreScalePermille: 400, hotMixPermille: 850, hotAlphaPermille: 950, hotCoreMaximumHop: 2, filamentPhaseSeed: 31, wobbleFrequencyMilliradians: 9425, opacityPermille: 900, curvatureMagnitudePermille: 1150, haloRadiusMultiplierPermille: 1000, haloIntensityPermille: 900, terminalSizeMultiplierPermille: 1000 },
    mycelium: { nodeSizeMultiplierPermille: 1000, filamentWidthMultiplierPermille: 950, filamentWidthStartPermille: 1250, filamentWidthEndPermille: 1250, filamentWobbleAmplitudePermille: 240, junctionThickeningPermille: 750, sheathScalePermille: 2700, sheathAlphaPermille: 200, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 47, wobbleFrequencyMilliradians: 18850, opacityPermille: 820, curvatureMagnitudePermille: 1350, haloRadiusMultiplierPermille: 620, haloIntensityPermille: 170, terminalSizeMultiplierPermille: 500 },
  },
  lod: { bandThresholds: [0, 250, 500, 750], hysteresisMarginPermille: 50, crossfadeDurationMs: 220, macroNodeSizeMultiplierPermille: 1250, macroFilamentWidthMultiplierPermille: 500, macroAggregateOutlineWidthMultiplierPermille: 500, macroAggregateOutlineAlphaPermille: 500, microHopDistanceLightnessStepPermille: 80, minimumAdjacentPixelDeltaPermille: 1 },
  labels: { densityCap: 36, priorityWeights: { node: 1000, edge: 500, assertion: 900, bridge: 1100 }, collisionPaddingPx: 5 },
  aggregate: { disclosureThreshold: 12, windowPaddingPx: 14, windowStrokeAlphaPermille: 700 },
  motion: { propagationSpeedPxPerSecond: 240, afterglowDecayPermille: 850, minimumReducedMotionPixelDeltaPermille: 1, reducedMotionSwitch: false },
  selection: { emphasisMultiplierPermille: 1450, focusDimFactorPermille: 320, minimumDifferingPixelCount: 16 },
  budget: { maxNodesBeforeLodForcesAggregation: 2400, targetFrameMs: 16, oracleCrossProductSampleSize: 27, oracleCrossProductSamplingSeed: 1103, oracleCrossProductPixelWitnessCount: 3 },
};

/** This validates the pinned profile shape and does not validate how a renderer uses it. */
export function assertCalibrationProfile(value: unknown): asserts value is CalibrationProfile {
  const paths = new Map<string, unknown>();
  collectPaths(value, "", paths);
  const expected = new Set<string>(CALIBRATION_PARAMETER_PATHS);
  for (const path of paths.keys()) {
    if (!expected.has(path)) {
      throw new TypeError(`unknown calibration parameter path: ${path}`);
    }
  }
  for (const path of expected) {
    if (!paths.has(path)) {
      throw new TypeError(`missing calibration parameter path: ${path}`);
    }
    assertCanonicalScalar(paths.get(path), path);
  }
}

function collectPaths(value: unknown, prefix: string, paths: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (prefix === "") {
      throw new TypeError("calibration profile must be a plain object");
    }
    paths.set(prefix, value);
    return;
  }
  if (!isPlainObject(value)) {
    if (prefix === "") {
      throw new TypeError("calibration profile must be a plain object");
    }
    paths.set(prefix, value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    collectPaths(child, path, paths);
  }
}

function assertCanonicalScalar(value: unknown, path: string): void {
  if (path === "motion.reducedMotionSwitch") {
    if (typeof value !== "boolean") {
      throw new TypeError(`${path} must be a boolean`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((item) => !isSafeInteger(item))) {
      throw new TypeError(`${path} must be a non-empty integer array`);
    }
    return;
  }
  if (!isSafeInteger(value)) {
    throw new TypeError(`${path} must be a finite safe integer`);
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
