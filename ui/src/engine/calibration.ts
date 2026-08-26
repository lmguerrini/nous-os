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
    /** This is the pairwise CSS-pixel floor at the governed reference frame and does not guarantee the same separation at every viewport size. */
    readonly minimumPairwiseAnchorSeparationPx: number;
    /** This is the empty CSS-pixel gap kept beyond the largest node diameter and does not size a node. */
    readonly minimumPairwiseAnchorSeparationGapPx: number;
    /** This caps pairwise screen-separation correction passes and does not change force-settling iterations. */
    readonly minimumPairwiseAnchorSeparationIterations: number;
    /** This is the governed reference capture width for pairwise CSS-pixel separation and does not guarantee another viewport width. */
    readonly referenceFrameWidthPx: number;
    /** This is the governed reference capture height for pairwise CSS-pixel separation and does not guarantee another viewport height. */
    readonly referenceFrameHeightPx: number;
    /** This is the lower bridge-to-intra median ratio, scaled by one thousand, and does not select graph communities. */
    readonly minimumBridgeToIntraMedianRatioPermille: number;
    /** This is the upper bridge-to-intra median ratio, scaled by one thousand, and does not shorten a relation itself. */
    readonly maximumBridgeToIntraMedianRatioPermille: number;
    /** This is the smallest occupied fraction of complete anchor bounds, scaled by one thousand, and does not remove intentional inter-community void. */
    readonly minimumCommunityRegionFrameUtilisationPermille: number;
    /** This scales the radial distribution of community regions and does not alter their members or local geometry. */
    readonly communityRegionDistributionRadiusPermille: number;
    /** This scales the vertical radial distribution of community regions and does not choose the layout aspect target. */
    readonly communityRegionDistributionVerticalRadiusPermille: number;
  };
  readonly salience: {
    readonly degreeExponentPermille: number;
    readonly minNodeSizePx: number;
    readonly maxNodeSizePx: number;
  };
  readonly luminance: {
    /** This is the near-black shipping field lightness, resolved after dark theme selection. */
    readonly fieldLightnessPermille: number;
    /** This is the shipping filament lightness, resolved after dark theme selection. */
    readonly filamentLightnessPermille: number;
    /** This is the shipping peak-node lightness, resolved after dark theme selection. */
    readonly nodePeakLightnessPermille: number;
    readonly haloRadiusFactorPermille: number;
    readonly haloFalloffPermille: number;
    readonly haloSampleCount: number;
    readonly coreBeforeHaloMinimumPx: number;
    readonly prominenceLightnessGainPermille: number;
    readonly prominenceChromaFalloffPermille: number;
    readonly haloProbeRadiusFractionPermille: number;
    readonly minimumNodeContrastPermille: number;
    readonly minimumCompositedPixelChannelDelta: number;
    /** This is the hue-independent minimum separation among distinct rendered prominence levels, scaled by one million. */
    readonly minimumRenderedNonHueSeparationMicro: number;
    /** This is the colour-vision-deficiency minimum separation among distinct rendered prominence levels, scaled by one million. */
    readonly minimumRenderedCvdSeparationMicro: number;
  };
  readonly filament: {
    readonly baseWidthPx: number;
    readonly pickTolerancePx: number;
    readonly opacityPermille: number;
    readonly curvatureMagnitudePermille: number;
    readonly minimumWidthFactorPermille: number;
    /** This is the absolute filament body floor in CSS pixels, scaled by one thousand. */
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
    readonly nodeLabelSizePx: number;
    readonly nodeLabelOpacityPermille: number;
    readonly edgeDensityCap: number;
    readonly edgeLabelSizePx: number;
    readonly edgeLabelOpacityPermille: number;
    readonly edgeLabelFocusOpacityPermille: number;
    readonly edgeLabelSelectedOpacityPermille: number;
    readonly edgeFocusPriorityBoost: number;
    readonly edgeSelectionPriorityBoost: number;
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
  "layout.minimumPairwiseAnchorSeparationPx",
  "layout.minimumPairwiseAnchorSeparationGapPx",
  "layout.minimumPairwiseAnchorSeparationIterations",
  "layout.referenceFrameWidthPx",
  "layout.referenceFrameHeightPx",
  "layout.minimumBridgeToIntraMedianRatioPermille",
  "layout.maximumBridgeToIntraMedianRatioPermille",
  "layout.minimumCommunityRegionFrameUtilisationPermille",
  "layout.communityRegionDistributionRadiusPermille",
  "layout.communityRegionDistributionVerticalRadiusPermille",
  "salience.degreeExponentPermille",
  "salience.minNodeSizePx",
  "salience.maxNodeSizePx",
  "luminance.fieldLightnessPermille",
  "luminance.filamentLightnessPermille",
  "luminance.nodePeakLightnessPermille",
  "luminance.haloRadiusFactorPermille",
  "luminance.haloFalloffPermille",
  "luminance.haloSampleCount",
  "luminance.coreBeforeHaloMinimumPx",
  "luminance.prominenceLightnessGainPermille",
  "luminance.prominenceChromaFalloffPermille",
  "luminance.haloProbeRadiusFractionPermille",
  "luminance.minimumNodeContrastPermille",
  "luminance.minimumCompositedPixelChannelDelta",
  "luminance.minimumRenderedNonHueSeparationMicro",
  "luminance.minimumRenderedCvdSeparationMicro",
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
  "labels.nodeLabelSizePx",
  "labels.nodeLabelOpacityPermille",
  "labels.edgeDensityCap",
  "labels.edgeLabelSizePx",
  "labels.edgeLabelOpacityPermille",
  "labels.edgeLabelFocusOpacityPermille",
  "labels.edgeLabelSelectedOpacityPermille",
  "labels.edgeFocusPriorityBoost",
  "labels.edgeSelectionPriorityBoost",
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
  layout: { forceStrengthPermille: 850, idealEdgeLengthPx: 120, iterations: 180, gravityPermille: 90, seed: 17, cellJitterPermille: 340, framingMarginPermille: 150, minimumPairwiseAnchorSeparationPx: 16, minimumPairwiseAnchorSeparationGapPx: 2, minimumPairwiseAnchorSeparationIterations: 180, referenceFrameWidthPx: 1200, referenceFrameHeightPx: 800, minimumBridgeToIntraMedianRatioPermille: 2000, maximumBridgeToIntraMedianRatioPermille: 5000, minimumCommunityRegionFrameUtilisationPermille: 100, communityRegionDistributionRadiusPermille: 600, communityRegionDistributionVerticalRadiusPermille: 1100 },
  salience: { degreeExponentPermille: 650, minNodeSizePx: 2, maxNodeSizePx: 14 },
  luminance: { fieldLightnessPermille: 60, filamentLightnessPermille: 700, nodePeakLightnessPermille: 960, haloRadiusFactorPermille: 1100, haloFalloffPermille: 250, haloSampleCount: 12, coreBeforeHaloMinimumPx: 4, prominenceLightnessGainPermille: 850, prominenceChromaFalloffPermille: 1000, haloProbeRadiusFractionPermille: 700, minimumNodeContrastPermille: 1200, minimumCompositedPixelChannelDelta: 6, minimumRenderedNonHueSeparationMicro: 10, minimumRenderedCvdSeparationMicro: 100 },
  filament: { baseWidthPx: 1,
    pickTolerancePx: 2, opacityPermille: 430, curvatureMagnitudePermille: 0, minimumWidthFactorPermille: 120, minimumDeviceWidthPermille: 1500 },
  morphology: {
    stellar: { nodeSizeMultiplierPermille: 1100, filamentWidthMultiplierPermille: 900, filamentWidthStartPermille: 650, filamentWidthEndPermille: 650, filamentWobbleAmplitudePermille: 15, junctionThickeningPermille: 0, sheathScalePermille: 2700, sheathAlphaPermille: 60, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 17, wobbleFrequencyMilliradians: 6283, opacityPermille: 1000, curvatureMagnitudePermille: 700, haloRadiusMultiplierPermille: 2000, haloIntensityPermille: 440, terminalSizeMultiplierPermille: 1000 },
    neural: { nodeSizeMultiplierPermille: 900, filamentWidthMultiplierPermille: 1050, filamentWidthStartPermille: 1800, filamentWidthEndPermille: 500, filamentWobbleAmplitudePermille: 80, junctionThickeningPermille: 800, sheathScalePermille: 2700, sheathAlphaPermille: 130, coreScalePermille: 400, hotMixPermille: 850, hotAlphaPermille: 950, hotCoreMaximumHop: 2, filamentPhaseSeed: 31, wobbleFrequencyMilliradians: 9425, opacityPermille: 900, curvatureMagnitudePermille: 1150, haloRadiusMultiplierPermille: 1000, haloIntensityPermille: 900, terminalSizeMultiplierPermille: 1000 },
    mycelium: { nodeSizeMultiplierPermille: 1000, filamentWidthMultiplierPermille: 950, filamentWidthStartPermille: 1250, filamentWidthEndPermille: 1250, filamentWobbleAmplitudePermille: 240, junctionThickeningPermille: 750, sheathScalePermille: 2700, sheathAlphaPermille: 200, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 47, wobbleFrequencyMilliradians: 18850, opacityPermille: 820, curvatureMagnitudePermille: 1350, haloRadiusMultiplierPermille: 620, haloIntensityPermille: 170, terminalSizeMultiplierPermille: 500 },
  },
  lod: { bandThresholds: [0, 250, 500, 750], hysteresisMarginPermille: 50, crossfadeDurationMs: 220, macroNodeSizeMultiplierPermille: 1250, macroFilamentWidthMultiplierPermille: 500, macroAggregateOutlineWidthMultiplierPermille: 1000, macroAggregateOutlineAlphaPermille: 200, microHopDistanceLightnessStepPermille: 60, minimumAdjacentPixelDeltaPermille: 1 },
  labels: { densityCap: 12, nodeLabelSizePx: 10, nodeLabelOpacityPermille: 520, edgeDensityCap: 3, edgeLabelSizePx: 9, edgeLabelOpacityPermille: 420, edgeLabelFocusOpacityPermille: 700, edgeLabelSelectedOpacityPermille: 920, edgeFocusPriorityBoost: 600, edgeSelectionPriorityBoost: 1000, priorityWeights: { node: 1000, edge: 500, assertion: 900, bridge: 1100 }, collisionPaddingPx: 5 },
  aggregate: { disclosureThreshold: 12, windowPaddingPx: 14, windowStrokeAlphaPermille: 260 },
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
