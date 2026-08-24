/** This is the renderer's tunable profile and does not establish semantic meaning. */

export type MorphologyMaterial = {
  readonly nodeSizeMultiplierPermille: number;
  readonly filamentWidthMultiplierPermille: number;
  readonly opacityPermille: number;
  readonly curvatureMagnitudePermille: number;
  readonly medialOffsetAmplitudePermille: number;
};

export type CalibrationProfile = {
  readonly layout: {
    readonly forceStrengthPermille: number;
    readonly idealEdgeLengthPx: number;
    readonly iterations: number;
    readonly gravityPermille: number;
    readonly seed: number;
  };
  readonly salience: {
    readonly degreeExponentPermille: number;
    readonly minNodeSizePx: number;
    readonly maxNodeSizePx: number;
  };
  readonly luminance: {
    readonly haloRadiusFactorPermille: number;
    readonly haloFalloffPermille: number;
    readonly coreBeforeHaloMinimumPx: number;
  };
  readonly filament: {
    readonly baseWidthPx: number;
    readonly opacityPermille: number;
    readonly curvatureMagnitudePermille: number;
    readonly medialOffsetAmplitudePx: number;
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
    readonly reducedMotionSwitch: boolean;
  };
  readonly selection: {
    readonly emphasisMultiplierPermille: number;
    readonly focusDimFactorPermille: number;
  };
  readonly budget: {
    readonly maxNodesBeforeLodForcesAggregation: number;
    readonly targetFrameMs: number;
  };
};

/** This is the exact calibration register and does not permit an unpinned visual parameter. */
export const CALIBRATION_PARAMETER_PATHS = [
  "layout.forceStrengthPermille",
  "layout.idealEdgeLengthPx",
  "layout.iterations",
  "layout.gravityPermille",
  "layout.seed",
  "salience.degreeExponentPermille",
  "salience.minNodeSizePx",
  "salience.maxNodeSizePx",
  "luminance.haloRadiusFactorPermille",
  "luminance.haloFalloffPermille",
  "luminance.coreBeforeHaloMinimumPx",
  "filament.baseWidthPx",
  "filament.opacityPermille",
  "filament.curvatureMagnitudePermille",
  "filament.medialOffsetAmplitudePx",
  "morphology.stellar.nodeSizeMultiplierPermille",
  "morphology.stellar.filamentWidthMultiplierPermille",
  "morphology.stellar.opacityPermille",
  "morphology.stellar.curvatureMagnitudePermille",
  "morphology.stellar.medialOffsetAmplitudePermille",
  "morphology.neural.nodeSizeMultiplierPermille",
  "morphology.neural.filamentWidthMultiplierPermille",
  "morphology.neural.opacityPermille",
  "morphology.neural.curvatureMagnitudePermille",
  "morphology.neural.medialOffsetAmplitudePermille",
  "morphology.mycelium.nodeSizeMultiplierPermille",
  "morphology.mycelium.filamentWidthMultiplierPermille",
  "morphology.mycelium.opacityPermille",
  "morphology.mycelium.curvatureMagnitudePermille",
  "morphology.mycelium.medialOffsetAmplitudePermille",
  "lod.bandThresholds",
  "lod.hysteresisMarginPermille",
  "lod.crossfadeDurationMs",
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
  "motion.reducedMotionSwitch",
  "selection.emphasisMultiplierPermille",
  "selection.focusDimFactorPermille",
  "budget.maxNodesBeforeLodForcesAggregation",
  "budget.targetFrameMs",
] as const;

/** This is the default renderer profile and does not choose a semantic interpretation. All fractional values are scaled integers because canonical JSON accepts only integers. */
export const DEFAULT_CALIBRATION: CalibrationProfile = {
  layout: { forceStrengthPermille: 850, idealEdgeLengthPx: 120, iterations: 180, gravityPermille: 90, seed: 17 },
  salience: { degreeExponentPermille: 650, minNodeSizePx: 4, maxNodeSizePx: 28 },
  luminance: { haloRadiusFactorPermille: 1800, haloFalloffPermille: 720, coreBeforeHaloMinimumPx: 2 },
  filament: { baseWidthPx: 2, opacityPermille: 620, curvatureMagnitudePermille: 240, medialOffsetAmplitudePx: 6 },
  morphology: {
    stellar: { nodeSizeMultiplierPermille: 1100, filamentWidthMultiplierPermille: 900, opacityPermille: 1000, curvatureMagnitudePermille: 700, medialOffsetAmplitudePermille: 500 },
    neural: { nodeSizeMultiplierPermille: 900, filamentWidthMultiplierPermille: 1050, opacityPermille: 900, curvatureMagnitudePermille: 1150, medialOffsetAmplitudePermille: 1000 },
    mycelium: { nodeSizeMultiplierPermille: 1000, filamentWidthMultiplierPermille: 950, opacityPermille: 820, curvatureMagnitudePermille: 1350, medialOffsetAmplitudePermille: 1250 },
  },
  lod: { bandThresholds: [0, 250, 500, 750], hysteresisMarginPermille: 50, crossfadeDurationMs: 220 },
  labels: { densityCap: 36, priorityWeights: { node: 1000, edge: 500, assertion: 900, bridge: 1100 }, collisionPaddingPx: 5 },
  aggregate: { disclosureThreshold: 12, windowPaddingPx: 14, windowStrokeAlphaPermille: 700 },
  motion: { propagationSpeedPxPerSecond: 240, afterglowDecayPermille: 180, reducedMotionSwitch: false },
  selection: { emphasisMultiplierPermille: 1450, focusDimFactorPermille: 320 },
  budget: { maxNodesBeforeLodForcesAggregation: 2400, targetFrameMs: 16 },
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
