/**
 * This composes named visual-calibration presets over the existing CalibrationProfile register and
 * does not add a second calibration system. A preset is a calibration profile, not a semantic mode:
 * it never touches VisualState, EngineGraph, or organization/morphology identity, and every resolved
 * field still passes the same CALIBRATION_PARAMETER_PATHS register as DEFAULT_CALIBRATION.
 */

import type { CalibrationProfile, MorphologyMaterial } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";

/** This is the complete governed preset name set and does not permit an unnamed calibration profile. */
export const PRESET_NAMES = [
  "analytical",
  "balanced",
  "atmospheric",
  "highContrast",
  "portfolio",
  "accessibility",
] as const;

export type PresetName = typeof PRESET_NAMES[number];

/** This scales one integer calibration field by a permille multiplier (1000 is unchanged) and stays a safe integer. */
function scaleBy(base: number, factorPermille: number): number {
  return Math.round((base * factorPermille) / 1000);
}

/** This holds one integer 0-1000 fraction inside its own representable range and does not renormalise it. */
function clampFraction(value: number): number {
  return Math.max(0, Math.min(1000, value));
}

/**
 * This is the named NODE and FILAMENT delta applied identically to all three morphology materials, so
 * a preset shifts overall calibration mood without narrowing which morphology renders or erasing the
 * material differences between Stellar, Neural, and Mycelium.
 */
type MaterialDeltaPermille = {
  readonly coreSharpness: number;
  readonly haloRadius: number;
  readonly haloIntensity: number;
  readonly nodeProminence: number;
  readonly filamentWidth: number;
  readonly organicity: number;
};

/** This is the complete named calibration delta for one preset and resolves against DEFAULT_CALIBRATION alone. */
type PresetSpec = {
  readonly material: MaterialDeltaPermille;
  /** This scales filament.opacityPermille, the single global filament-presence knob shared by every morphology. */
  readonly filamentOpacityFactor: number;
  /** This scales filament.endpointLuminanceGainPermille and filament.midSpanLuminanceFactorPermille together. */
  readonly filamentLuminanceFactor: number;
  readonly fieldLightnessPermille: number;
  readonly minimumNodeContrastPermille: number;
  readonly community: {
    /** This scales aggregate.windowFillOpacityPermille. */
    readonly fillFactor: number;
    /** This scales aggregate.windowStrokeAlphaPermille. */
    readonly boundaryFactor: number;
    readonly crossWindowOpacityFactor: number;
    readonly crossWindowWidthFactor: number;
    /**
     * This scales layout.communityRegionDistributionRadiusPermille and its vertical counterpart, the
     * one layout field the register itself documents as not altering community membership or local
     * geometry, so it is the only honest "organization strength" a visual preset may touch.
     */
    readonly organizationStrengthFactor: number;
  };
  readonly labels: {
    readonly densityFactor: number;
    readonly scaleFactor: number;
    readonly opacityFactor: number;
  };
  readonly motion: {
    readonly afterglowFactor: number;
    /** This scales lod.crossfadeDurationMs, the band-transition pacing that reads as motion, not level of detail selection. */
    readonly crossfadeFactor: number;
    readonly reducedMotion: boolean;
  };
};

const NEUTRAL_MATERIAL_DELTA: MaterialDeltaPermille = {
  coreSharpness: 1000,
  haloRadius: 1000,
  haloIntensity: 1000,
  nodeProminence: 1000,
  filamentWidth: 1000,
  organicity: 1000,
};

/** This is the shipped default resolved as a preset spec and must reproduce DEFAULT_CALIBRATION byte-for-byte. */
const BALANCED_SPEC: PresetSpec = {
  material: NEUTRAL_MATERIAL_DELTA,
  filamentOpacityFactor: 1000,
  filamentLuminanceFactor: 1000,
  fieldLightnessPermille: DEFAULT_CALIBRATION.luminance.fieldLightnessPermille,
  minimumNodeContrastPermille: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille,
  community: {
    fillFactor: 1000,
    boundaryFactor: 1000,
    crossWindowOpacityFactor: 1000,
    crossWindowWidthFactor: 1000,
    organizationStrengthFactor: 1000,
  },
  labels: { densityFactor: 1000, scaleFactor: 1000, opacityFactor: 1000 },
  motion: { afterglowFactor: 1000, crossfadeFactor: 1000, reducedMotion: false },
};

/** Maximum topology readability: sharp cores, minimal bloom, tight filaments, high label density, quiet chrome. */
const ANALYTICAL_SPEC: PresetSpec = {
  material: { coreSharpness: 1400, haloRadius: 650, haloIntensity: 550, nodeProminence: 950, filamentWidth: 850, organicity: 650 },
  filamentOpacityFactor: 1100,
  filamentLuminanceFactor: 1100,
  fieldLightnessPermille: 40,
  minimumNodeContrastPermille: 1500,
  community: { fillFactor: 700, boundaryFactor: 1150, crossWindowOpacityFactor: 900, crossWindowWidthFactor: 1000, organizationStrengthFactor: 1000 },
  labels: { densityFactor: 1500, scaleFactor: 1000, opacityFactor: 1150 },
  motion: { afterglowFactor: 1000, crossfadeFactor: 1000, reducedMotion: false },
};

/**
 * Depth and mood: more bloom and field presence, softer chrome, lower label density. Core sharpness is
 * softened but not flattened, and filament width is left untouched, so topology stays readable rather
 * than dissolving into bloom.
 */
const ATMOSPHERIC_SPEC: PresetSpec = {
  material: { coreSharpness: 800, haloRadius: 1400, haloIntensity: 1300, nodeProminence: 1050, filamentWidth: 1000, organicity: 1300 },
  filamentOpacityFactor: 950,
  filamentLuminanceFactor: 900,
  fieldLightnessPermille: 90,
  minimumNodeContrastPermille: 1200,
  community: { fillFactor: 1400, boundaryFactor: 850, crossWindowOpacityFactor: 1100, crossWindowWidthFactor: 1000, organizationStrengthFactor: 1200 },
  labels: { densityFactor: 700, scaleFactor: 1000, opacityFactor: 850 },
  motion: { afterglowFactor: 1200, crossfadeFactor: 1300, reducedMotion: false },
};

/** Maximum separation between content and field: near-black field, raised contrast floor, strong boundaries. */
const HIGH_CONTRAST_SPEC: PresetSpec = {
  material: { coreSharpness: 1500, haloRadius: 800, haloIntensity: 1200, nodeProminence: 1100, filamentWidth: 1050, organicity: 1000 },
  filamentOpacityFactor: 1200,
  filamentLuminanceFactor: 1150,
  fieldLightnessPermille: 20,
  minimumNodeContrastPermille: 2200,
  community: { fillFactor: 900, boundaryFactor: 1400, crossWindowOpacityFactor: 1000, crossWindowWidthFactor: 1100, organizationStrengthFactor: 1000 },
  labels: { densityFactor: 1000, scaleFactor: 1100, opacityFactor: 1200 },
  motion: { afterglowFactor: 1000, crossfadeFactor: 1000, reducedMotion: false },
};

/** The presentation look: composed, restrained, visually confident. */
const PORTFOLIO_SPEC: PresetSpec = {
  material: { coreSharpness: 1150, haloRadius: 1100, haloIntensity: 1050, nodeProminence: 1000, filamentWidth: 950, organicity: 950 },
  filamentOpacityFactor: 1000,
  filamentLuminanceFactor: 1000,
  fieldLightnessPermille: 50,
  minimumNodeContrastPermille: 1300,
  community: { fillFactor: 1150, boundaryFactor: 1050, crossWindowOpacityFactor: 950, crossWindowWidthFactor: 950, organizationStrengthFactor: 1100 },
  labels: { densityFactor: 850, scaleFactor: 1050, opacityFactor: 1050 },
  motion: { afterglowFactor: 900, crossfadeFactor: 900, reducedMotion: false },
};

/**
 * Larger nodes and labels, stronger contrast, reduced motion. This is the non-colour half of
 * accessibility calibration; hue and palette selection belong to the colour-vision-deficiency work
 * done elsewhere, so this preset never touches luminance.minimumRenderedCvdSeparationMicro,
 * luminance.minimumRenderedNonHueSeparationMicro, or any palette selection.
 */
const ACCESSIBILITY_SPEC: PresetSpec = {
  material: { coreSharpness: 1200, haloRadius: 1000, haloIntensity: 1000, nodeProminence: 1400, filamentWidth: 1300, organicity: 800 },
  filamentOpacityFactor: 1200,
  filamentLuminanceFactor: 1100,
  fieldLightnessPermille: 30,
  minimumNodeContrastPermille: 2000,
  community: { fillFactor: 1000, boundaryFactor: 1200, crossWindowOpacityFactor: 1000, crossWindowWidthFactor: 1100, organizationStrengthFactor: 1000 },
  labels: { densityFactor: 900, scaleFactor: 1500, opacityFactor: 1300 },
  motion: { afterglowFactor: 1000, crossfadeFactor: 1000, reducedMotion: true },
};

const PRESET_SPECS: Readonly<Record<PresetName, PresetSpec>> = {
  analytical: ANALYTICAL_SPEC,
  balanced: BALANCED_SPEC,
  atmospheric: ATMOSPHERIC_SPEC,
  highContrast: HIGH_CONTRAST_SPEC,
  portfolio: PORTFOLIO_SPEC,
  accessibility: ACCESSIBILITY_SPEC,
};

/** This applies one material delta to one morphology's material and returns every field explicitly, not a partial patch. */
function applyMaterialDelta(material: MorphologyMaterial, delta: MaterialDeltaPermille): MorphologyMaterial {
  return {
    ...material,
    coreSharpnessPermille: scaleBy(material.coreSharpnessPermille, delta.coreSharpness),
    haloRadiusMultiplierPermille: scaleBy(material.haloRadiusMultiplierPermille, delta.haloRadius),
    sharedSceneHaloRadiusMultiplierPermille: scaleBy(material.sharedSceneHaloRadiusMultiplierPermille, delta.haloRadius),
    haloIntensityPermille: scaleBy(material.haloIntensityPermille, delta.haloIntensity),
    sharedSceneHaloIntensityPermille: scaleBy(material.sharedSceneHaloIntensityPermille, delta.haloIntensity),
    nodeSizeMultiplierPermille: scaleBy(material.nodeSizeMultiplierPermille, delta.nodeProminence),
    sharedSceneNodeSizeMultiplierPermille: scaleBy(material.sharedSceneNodeSizeMultiplierPermille, delta.nodeProminence),
    terminalSizeMultiplierPermille: scaleBy(material.terminalSizeMultiplierPermille, delta.nodeProminence),
    sharedSceneTerminalSizeMultiplierPermille: scaleBy(material.sharedSceneTerminalSizeMultiplierPermille, delta.nodeProminence),
    filamentWidthMultiplierPermille: scaleBy(material.filamentWidthMultiplierPermille, delta.filamentWidth),
    filamentWidthStartPermille: scaleBy(material.filamentWidthStartPermille, delta.filamentWidth),
    filamentWidthEndPermille: scaleBy(material.filamentWidthEndPermille, delta.filamentWidth),
    sharedSceneFilamentWidthMultiplierPermille: scaleBy(material.sharedSceneFilamentWidthMultiplierPermille, delta.filamentWidth),
    sharedSceneFilamentWidthStartPermille: scaleBy(material.sharedSceneFilamentWidthStartPermille, delta.filamentWidth),
    sharedSceneFilamentWidthEndPermille: scaleBy(material.sharedSceneFilamentWidthEndPermille, delta.filamentWidth),
    curvatureMagnitudePermille: scaleBy(material.curvatureMagnitudePermille, delta.organicity),
    filamentWobbleAmplitudePermille: scaleBy(material.filamentWobbleAmplitudePermille, delta.organicity),
    sharedSceneFilamentWobbleAmplitudePermille: scaleBy(material.sharedSceneFilamentWobbleAmplitudePermille, delta.organicity),
  };
}

/** This resolves one preset spec against DEFAULT_CALIBRATION into a complete, explicit CalibrationProfile. */
function resolvePresetSpec(spec: PresetSpec): CalibrationProfile {
  const base = DEFAULT_CALIBRATION;
  return {
    layout: {
      ...base.layout,
      communityRegionDistributionRadiusPermille: scaleBy(base.layout.communityRegionDistributionRadiusPermille, spec.community.organizationStrengthFactor),
      communityRegionDistributionVerticalRadiusPermille: scaleBy(base.layout.communityRegionDistributionVerticalRadiusPermille, spec.community.organizationStrengthFactor),
    },
    salience: {
      ...base.salience,
      minNodeSizePx: scaleBy(base.salience.minNodeSizePx, spec.material.nodeProminence),
      maxNodeSizePx: scaleBy(base.salience.maxNodeSizePx, spec.material.nodeProminence),
    },
    luminance: {
      ...base.luminance,
      fieldLightnessPermille: clampFraction(spec.fieldLightnessPermille),
      minimumNodeContrastPermille: spec.minimumNodeContrastPermille,
    },
    renderedState: base.renderedState,
    filament: {
      ...base.filament,
      opacityPermille: clampFraction(scaleBy(base.filament.opacityPermille, spec.filamentOpacityFactor)),
      curvatureMagnitudePermille: scaleBy(base.filament.curvatureMagnitudePermille, spec.material.organicity),
      endpointLuminanceGainPermille: scaleBy(base.filament.endpointLuminanceGainPermille, spec.filamentLuminanceFactor),
      midSpanLuminanceFactorPermille: scaleBy(base.filament.midSpanLuminanceFactorPermille, spec.filamentLuminanceFactor),
    },
    morphology: {
      stellar: applyMaterialDelta(base.morphology.stellar, spec.material),
      neural: applyMaterialDelta(base.morphology.neural, spec.material),
      mycelium: applyMaterialDelta(base.morphology.mycelium, spec.material),
    },
    lod: {
      ...base.lod,
      crossfadeDurationMs: scaleBy(base.lod.crossfadeDurationMs, spec.motion.crossfadeFactor),
    },
    labels: {
      ...base.labels,
      densityCap: scaleBy(base.labels.densityCap, spec.labels.densityFactor),
      nodeLabelSizePx: scaleBy(base.labels.nodeLabelSizePx, spec.labels.scaleFactor),
      nodeLabelOpacityPermille: clampFraction(scaleBy(base.labels.nodeLabelOpacityPermille, spec.labels.opacityFactor)),
      edgeDensityCap: scaleBy(base.labels.edgeDensityCap, spec.labels.densityFactor),
      edgeLabelSizePx: scaleBy(base.labels.edgeLabelSizePx, spec.labels.scaleFactor),
      edgeLabelOpacityPermille: clampFraction(scaleBy(base.labels.edgeLabelOpacityPermille, spec.labels.opacityFactor)),
    },
    aggregate: {
      ...base.aggregate,
      windowStrokeAlphaPermille: clampFraction(scaleBy(base.aggregate.windowStrokeAlphaPermille, spec.community.boundaryFactor)),
      windowFillOpacityPermille: clampFraction(scaleBy(base.aggregate.windowFillOpacityPermille, spec.community.fillFactor)),
      crossWindowRelationOpacityFactorPermille: clampFraction(scaleBy(base.aggregate.crossWindowRelationOpacityFactorPermille, spec.community.crossWindowOpacityFactor)),
      crossWindowRelationWidthFactorPermille: scaleBy(base.aggregate.crossWindowRelationWidthFactorPermille, spec.community.crossWindowWidthFactor),
    },
    camera: base.camera,
    motion: {
      ...base.motion,
      afterglowDecayPermille: clampFraction(scaleBy(base.motion.afterglowDecayPermille, spec.motion.afterglowFactor)),
      reducedMotionSwitch: spec.motion.reducedMotion,
    },
    selection: base.selection,
    budget: base.budget,
  };
}

/** This is the complete resolved preset register: preset name in, byte-identical CalibrationProfile out, computed once. */
export const PRESET_CALIBRATIONS: Readonly<Record<PresetName, CalibrationProfile>> = {
  analytical: resolvePresetSpec(PRESET_SPECS.analytical),
  balanced: resolvePresetSpec(PRESET_SPECS.balanced),
  atmospheric: resolvePresetSpec(PRESET_SPECS.atmospheric),
  highContrast: resolvePresetSpec(PRESET_SPECS.highContrast),
  portfolio: resolvePresetSpec(PRESET_SPECS.portfolio),
  accessibility: resolvePresetSpec(PRESET_SPECS.accessibility),
};

/** This is the pure preset resolver: the same name always returns the same explicit CalibrationProfile. */
export function resolvePreset(name: PresetName): CalibrationProfile {
  return PRESET_CALIBRATIONS[name];
}
