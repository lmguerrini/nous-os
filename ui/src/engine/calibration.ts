/** This is the renderer's tunable profile and does not establish semantic meaning. */

export type MorphologyMaterial = {
  readonly nodeSizeMultiplierPermille: number;
  /** This is the shared-scene node-size multiplier and does not alter the legacy renderer's frozen node scale. */
  readonly sharedSceneNodeSizeMultiplierPermille: number;
  readonly filamentWidthMultiplierPermille: number;
  readonly filamentWidthStartPermille: number;
  readonly filamentWidthEndPermille: number;
  readonly sharedSceneFilamentWidthMultiplierPermille: number;
  readonly sharedSceneFilamentWidthStartPermille: number;
  readonly sharedSceneFilamentWidthEndPermille: number;
  readonly filamentWobbleAmplitudePermille: number;
  /** This is the shared-scene medial-offset wobble amplitude and does not alter the legacy renderer's frozen meander. */
  readonly sharedSceneFilamentWobbleAmplitudePermille: number;
  /** This is the shared-scene medial-offset wobble frequency and does not alter the legacy renderer's frozen meander. */
  readonly sharedSceneWobbleFrequencyMilliradians: number;
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
  /** This is the shared-scene halo peak and does not alter the legacy renderer's flat halo intensity. */
  readonly sharedSceneHaloIntensityPermille: number;
  /** This is the shared-scene halo radius multiplier and does not alter the legacy renderer's frozen halo extent. */
  readonly sharedSceneHaloRadiusMultiplierPermille: number;
  /** This is the shared-scene minimum retained fraction of the halo peak at zero rendered prominence, scaled by one thousand, and does not affect the legacy renderer. */
  readonly haloProminenceFloorPermille: number;
  readonly terminalSizeMultiplierPermille: number;
  readonly sharedSceneTerminalSizeMultiplierPermille: number;
  /**
   * This is the shared-scene node core-alpha falloff exponent and does not alter the legacy
   * renderer, which has no core-sharpness concept. A literal hard-edged core (a flat anti-aliased
   * disc) was tried under CAP-13 criterion B17, measured a fourteenfold better core-concentration
   * ratio, and was rejected because it made every node read as a flat grey circle. This governs the
   * SAME continuous smoothstep-based gradient that repair kept — it only changes how quickly that
   * gradient's alpha rises toward the centre, scaled by one thousand (1000 reproduces the exponent a
   * plain gradient core would use). Raising it concentrates the bright centre and steepens the edge
   * without ever producing a flat, binary-coverage disc.
   */
  readonly coreSharpnessPermille: number;
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
  readonly renderedState: {
    /** This is the temporal established material lightness delta and does not change node mass or hue. */
    readonly temporalEstablishedLightnessDeltaPermille: number;
    /** This is the temporal excluded material lightness delta and does not change node mass or hue. */
    readonly temporalExcludedLightnessDeltaPermille: number;
    /** This is the temporal undetermined material lightness delta and does not change node mass or hue. */
    readonly temporalUndeterminedLightnessDeltaPermille: number;
    /** This is the bridge accepted material lightness delta and does not change node mass or hue. */
    readonly bridgeAcceptedLightnessDeltaPermille: number;
    /** This is the bridge rejected material lightness delta and does not change node mass or hue. */
    readonly bridgeRejectedLightnessDeltaPermille: number;
    /** This is the bridge undetermined material lightness delta and does not change node mass or hue. */
    readonly bridgeUndeterminedLightnessDeltaPermille: number;
    /** This is the epistemic explicit material lightness delta and does not change node mass or hue. */
    readonly epistemicExplicitLightnessDeltaPermille: number;
    /** This is the epistemic derived material lightness delta and does not change node mass or hue. */
    readonly epistemicDerivedLightnessDeltaPermille: number;
    /** This is the epistemic speculative material lightness delta and does not change node mass or hue. */
    readonly epistemicSpeculativeLightnessDeltaPermille: number;
  };
  readonly filament: {
    readonly baseWidthPx: number;
    readonly pickTolerancePx: number;
    readonly opacityPermille: number;
    readonly curvatureMagnitudePermille: number;
    readonly minimumWidthFactorPermille: number;
    /** This is the absolute filament body floor in CSS pixels, scaled by one thousand. */
    readonly minimumDeviceWidthPermille: number;
    /** This is the uniform endpoint luminance gain for every relation and does not encode relation meaning. */
    readonly endpointLuminanceGainPermille: number;
    /** This is the uniform mid-span luminance factor for every relation and does not encode relation meaning. */
    readonly midSpanLuminanceFactorPermille: number;
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
    /** This is the aggregate interior fill's peak alpha at the portal's core, scaled by one thousand, and does not change the rim stroke. */
    readonly windowFillOpacityPermille: number;
    /** This is the fraction of the aggregate radius held at the fill's peak before the vignette begins, scaled by one thousand. */
    readonly windowFillCoreRadiusFractionPermille: number;
    /** This is the vignette falloff exponent shaping the fill from its core to the rim, scaled by one thousand, and does not change stroke width. */
    readonly windowFillFalloffPermille: number;
    /** This is the real member-extent radius, in CSS pixels, below which a window's rendered size is left exactly data-derived. */
    readonly memberExtentCompressionThresholdPx: number;
    /** This is the asymptotic bound a window's rendered member-extent radius is compressed toward once its real extent exceeds the threshold; it is approached, never reached, so extent stays monotonic in real membership. */
    readonly memberExtentCompressionCeilingPx: number;
    /** This is the excess-extent, in CSS pixels, past the threshold at which compression reaches half of its remaining headroom to the ceiling; a smaller value compresses large windows harder. */
    readonly memberExtentCompressionSaturationPx: number;
    /** This is the opacity multiplier, scaled by one thousand, applied to a relation whose endpoints span different governed aggregates or touch a satellite outside every window, and does not change which relations are drawn or their identity. */
    readonly crossWindowRelationOpacityFactorPermille: number;
    /** This is the body-width multiplier, scaled by one thousand, applied to the same cross-community relations the opacity factor above dims. */
    readonly crossWindowRelationWidthFactorPermille: number;
    /** This is the label-selection priority subtracted from a cross-community relation's own label so a local relation's label wins the density cap first, and does not remove a governed label from candidacy. */
    readonly crossWindowRelationLabelPriorityPenalty: number;
  };
  readonly camera: {
    readonly orthographic: {
      readonly panSensitivityPermille: number;
      readonly zoomSensitivityPermille: number;
      readonly minimumZoomPermille: number;
      readonly maximumZoomPermille: number;
    };
    readonly perspective: {
      readonly orbitSensitivityPermille: number;
      readonly dollySensitivityPermille: number;
      readonly panSensitivityPermille: number;
      readonly minimumDollyPermille: number;
      readonly maximumDollyPermille: number;
    };
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
  "renderedState.temporalEstablishedLightnessDeltaPermille",
  "renderedState.temporalExcludedLightnessDeltaPermille",
  "renderedState.temporalUndeterminedLightnessDeltaPermille",
  "renderedState.bridgeAcceptedLightnessDeltaPermille",
  "renderedState.bridgeRejectedLightnessDeltaPermille",
  "renderedState.bridgeUndeterminedLightnessDeltaPermille",
  "renderedState.epistemicExplicitLightnessDeltaPermille",
  "renderedState.epistemicDerivedLightnessDeltaPermille",
  "renderedState.epistemicSpeculativeLightnessDeltaPermille",
  "filament.baseWidthPx",
  "filament.pickTolerancePx",
  "filament.opacityPermille",
  "filament.curvatureMagnitudePermille",
  "filament.minimumWidthFactorPermille",
  "filament.minimumDeviceWidthPermille",
  "filament.endpointLuminanceGainPermille",
  "filament.midSpanLuminanceFactorPermille",
  "morphology.stellar.nodeSizeMultiplierPermille",
  "morphology.stellar.sharedSceneNodeSizeMultiplierPermille",
  "morphology.stellar.filamentWidthMultiplierPermille",
  "morphology.stellar.filamentWidthStartPermille",
  "morphology.stellar.filamentWidthEndPermille",
  "morphology.stellar.sharedSceneFilamentWidthMultiplierPermille",
  "morphology.stellar.sharedSceneFilamentWidthStartPermille",
  "morphology.stellar.sharedSceneFilamentWidthEndPermille",
  "morphology.stellar.filamentWobbleAmplitudePermille",
  "morphology.stellar.sharedSceneFilamentWobbleAmplitudePermille",
  "morphology.stellar.sharedSceneWobbleFrequencyMilliradians",
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
  "morphology.stellar.sharedSceneHaloIntensityPermille",
  "morphology.stellar.sharedSceneHaloRadiusMultiplierPermille",
  "morphology.stellar.haloProminenceFloorPermille",
  "morphology.stellar.terminalSizeMultiplierPermille",
  "morphology.stellar.sharedSceneTerminalSizeMultiplierPermille",
  "morphology.stellar.coreSharpnessPermille",
  "morphology.neural.nodeSizeMultiplierPermille",
  "morphology.neural.sharedSceneNodeSizeMultiplierPermille",
  "morphology.neural.filamentWidthMultiplierPermille",
  "morphology.neural.filamentWidthStartPermille",
  "morphology.neural.filamentWidthEndPermille",
  "morphology.neural.sharedSceneFilamentWidthMultiplierPermille",
  "morphology.neural.sharedSceneFilamentWidthStartPermille",
  "morphology.neural.sharedSceneFilamentWidthEndPermille",
  "morphology.neural.filamentWobbleAmplitudePermille",
  "morphology.neural.sharedSceneFilamentWobbleAmplitudePermille",
  "morphology.neural.sharedSceneWobbleFrequencyMilliradians",
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
  "morphology.neural.sharedSceneHaloIntensityPermille",
  "morphology.neural.sharedSceneHaloRadiusMultiplierPermille",
  "morphology.neural.haloProminenceFloorPermille",
  "morphology.neural.terminalSizeMultiplierPermille",
  "morphology.neural.sharedSceneTerminalSizeMultiplierPermille",
  "morphology.neural.coreSharpnessPermille",
  "morphology.mycelium.nodeSizeMultiplierPermille",
  "morphology.mycelium.sharedSceneNodeSizeMultiplierPermille",
  "morphology.mycelium.filamentWidthMultiplierPermille",
  "morphology.mycelium.filamentWidthStartPermille",
  "morphology.mycelium.filamentWidthEndPermille",
  "morphology.mycelium.sharedSceneFilamentWidthMultiplierPermille",
  "morphology.mycelium.sharedSceneFilamentWidthStartPermille",
  "morphology.mycelium.sharedSceneFilamentWidthEndPermille",
  "morphology.mycelium.filamentWobbleAmplitudePermille",
  "morphology.mycelium.sharedSceneFilamentWobbleAmplitudePermille",
  "morphology.mycelium.sharedSceneWobbleFrequencyMilliradians",
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
  "morphology.mycelium.sharedSceneHaloIntensityPermille",
  "morphology.mycelium.sharedSceneHaloRadiusMultiplierPermille",
  "morphology.mycelium.haloProminenceFloorPermille",
  "morphology.mycelium.terminalSizeMultiplierPermille",
  "morphology.mycelium.sharedSceneTerminalSizeMultiplierPermille",
  "morphology.mycelium.coreSharpnessPermille",
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
  "aggregate.windowFillOpacityPermille",
  "aggregate.windowFillCoreRadiusFractionPermille",
  "aggregate.windowFillFalloffPermille",
  "aggregate.memberExtentCompressionThresholdPx",
  "aggregate.memberExtentCompressionCeilingPx",
  "aggregate.memberExtentCompressionSaturationPx",
  "aggregate.crossWindowRelationOpacityFactorPermille",
  "aggregate.crossWindowRelationWidthFactorPermille",
  "aggregate.crossWindowRelationLabelPriorityPenalty",
  "camera.orthographic.panSensitivityPermille",
  "camera.orthographic.zoomSensitivityPermille",
  "camera.orthographic.minimumZoomPermille",
  "camera.orthographic.maximumZoomPermille",
  "camera.perspective.orbitSensitivityPermille",
  "camera.perspective.dollySensitivityPermille",
  "camera.perspective.panSensitivityPermille",
  "camera.perspective.minimumDollyPermille",
  "camera.perspective.maximumDollyPermille",
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
  renderedState: {
    temporalEstablishedLightnessDeltaPermille: -36,
    temporalExcludedLightnessDeltaPermille: -32,
    temporalUndeterminedLightnessDeltaPermille: -28,
    bridgeAcceptedLightnessDeltaPermille: -24,
    bridgeRejectedLightnessDeltaPermille: -20,
    bridgeUndeterminedLightnessDeltaPermille: -16,
    epistemicExplicitLightnessDeltaPermille: -12,
    epistemicDerivedLightnessDeltaPermille: -8,
    epistemicSpeculativeLightnessDeltaPermille: -4,
  },
  filament: { baseWidthPx: 1,
    pickTolerancePx: 2, opacityPermille: 430, curvatureMagnitudePermille: 160, minimumWidthFactorPermille: 120, minimumDeviceWidthPermille: 1500, endpointLuminanceGainPermille: 1200, midSpanLuminanceFactorPermille: 650 },
  morphology: {
    stellar: { nodeSizeMultiplierPermille: 1100, sharedSceneNodeSizeMultiplierPermille: 800, filamentWidthMultiplierPermille: 900, filamentWidthStartPermille: 650, filamentWidthEndPermille: 650, sharedSceneFilamentWidthMultiplierPermille: 1300, sharedSceneFilamentWidthStartPermille: 1000, sharedSceneFilamentWidthEndPermille: 1000, filamentWobbleAmplitudePermille: 15, sharedSceneFilamentWobbleAmplitudePermille: 15, sharedSceneWobbleFrequencyMilliradians: 6283, junctionThickeningPermille: 0, sheathScalePermille: 2700, sheathAlphaPermille: 60, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 17, wobbleFrequencyMilliradians: 6283, opacityPermille: 1000, curvatureMagnitudePermille: 480, haloRadiusMultiplierPermille: 2000, haloIntensityPermille: 440, sharedSceneHaloIntensityPermille: 420, sharedSceneHaloRadiusMultiplierPermille: 950, haloProminenceFloorPermille: 80, terminalSizeMultiplierPermille: 1000, sharedSceneTerminalSizeMultiplierPermille: 700, coreSharpnessPermille: 2400 },
    neural: { nodeSizeMultiplierPermille: 900, sharedSceneNodeSizeMultiplierPermille: 1300, filamentWidthMultiplierPermille: 1050, filamentWidthStartPermille: 1800, filamentWidthEndPermille: 500, sharedSceneFilamentWidthMultiplierPermille: 1800, sharedSceneFilamentWidthStartPermille: 2200, sharedSceneFilamentWidthEndPermille: 900, filamentWobbleAmplitudePermille: 80, sharedSceneFilamentWobbleAmplitudePermille: 30, sharedSceneWobbleFrequencyMilliradians: 7000, junctionThickeningPermille: 800, sheathScalePermille: 2700, sheathAlphaPermille: 130, coreScalePermille: 400, hotMixPermille: 850, hotAlphaPermille: 950, hotCoreMaximumHop: 2, filamentPhaseSeed: 31, wobbleFrequencyMilliradians: 9425, opacityPermille: 900, curvatureMagnitudePermille: 1500, haloRadiusMultiplierPermille: 1000, haloIntensityPermille: 900, sharedSceneHaloIntensityPermille: 300, sharedSceneHaloRadiusMultiplierPermille: 760, haloProminenceFloorPermille: 500, terminalSizeMultiplierPermille: 1000, sharedSceneTerminalSizeMultiplierPermille: 260, coreSharpnessPermille: 1700 },
    mycelium: { nodeSizeMultiplierPermille: 1000, sharedSceneNodeSizeMultiplierPermille: 420, filamentWidthMultiplierPermille: 950, filamentWidthStartPermille: 1250, filamentWidthEndPermille: 1250, sharedSceneFilamentWidthMultiplierPermille: 2200, sharedSceneFilamentWidthStartPermille: 1300, sharedSceneFilamentWidthEndPermille: 1300, filamentWobbleAmplitudePermille: 240, sharedSceneFilamentWobbleAmplitudePermille: 320, sharedSceneWobbleFrequencyMilliradians: 21000, junctionThickeningPermille: 750, sheathScalePermille: 2700, sheathAlphaPermille: 200, coreScalePermille: 400, hotMixPermille: 0, hotAlphaPermille: 0, hotCoreMaximumHop: 0, filamentPhaseSeed: 47, wobbleFrequencyMilliradians: 18850, opacityPermille: 820, curvatureMagnitudePermille: 520, haloRadiusMultiplierPermille: 620, haloIntensityPermille: 170, sharedSceneHaloIntensityPermille: 90, sharedSceneHaloRadiusMultiplierPermille: 420, haloProminenceFloorPermille: 700, terminalSizeMultiplierPermille: 500, sharedSceneTerminalSizeMultiplierPermille: 500, coreSharpnessPermille: 1100 },
  },
  lod: { bandThresholds: [0, 250, 500, 750], hysteresisMarginPermille: 50, crossfadeDurationMs: 220, macroNodeSizeMultiplierPermille: 1250, macroFilamentWidthMultiplierPermille: 500, macroAggregateOutlineWidthMultiplierPermille: 1000, macroAggregateOutlineAlphaPermille: 200, microHopDistanceLightnessStepPermille: 60, minimumAdjacentPixelDeltaPermille: 1 },
  labels: { densityCap: 12, nodeLabelSizePx: 10, nodeLabelOpacityPermille: 520, edgeDensityCap: 3, edgeLabelSizePx: 9, edgeLabelOpacityPermille: 420, edgeLabelFocusOpacityPermille: 700, edgeLabelSelectedOpacityPermille: 920, edgeFocusPriorityBoost: 600, edgeSelectionPriorityBoost: 1000, priorityWeights: { node: 1000, edge: 500, assertion: 900, bridge: 1100 }, collisionPaddingPx: 5 },
  aggregate: {
    disclosureThreshold: 12,
    windowPaddingPx: 14,
    windowStrokeAlphaPermille: 260,
    windowFillOpacityPermille: 220,
    windowFillCoreRadiusFractionPermille: 600,
    windowFillFalloffPermille: 1400,
    memberExtentCompressionThresholdPx: 45,
    memberExtentCompressionCeilingPx: 65,
    memberExtentCompressionSaturationPx: 30,
    crossWindowRelationOpacityFactorPermille: 400,
    crossWindowRelationWidthFactorPermille: 550,
    crossWindowRelationLabelPriorityPenalty: 400,
  },
  camera: {
    orthographic: { panSensitivityPermille: 1000, zoomSensitivityPermille: 1700, minimumZoomPermille: 250, maximumZoomPermille: 4000 },
    perspective: { orbitSensitivityPermille: 1000, dollySensitivityPermille: 1000, panSensitivityPermille: 1000, minimumDollyPermille: 500, maximumDollyPermille: 10000 },
  },
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
  // coreSharpnessPermille is a shader exponent (node-material.ts: `pow(coreProfile, coreSharpness)`).
  // At zero, pow(coreProfile, 0.0) is 1.0 wherever coreProfile is positive, degenerating the governed
  // radial gradient into the flat, hard-edged binary-coverage disc B17 measured and rejected -- a
  // value a safe-integer bound alone does not exclude.
  if (path.endsWith(".coreSharpnessPermille") && value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
