/** Pure median-comparison materiality rules; this module does not read artifacts or run a browser. */
import { PERFORMANCE_FIXTURES } from "#browser/performance-contract.ts";
import type { PerformanceScale, RendererName } from "#browser/performance-contract.ts";

/** This is the inclusive median-ratio threshold for a material difference and does not average scales. */
export const MATERIAL_RATIO_THRESHOLD = 1.25;

/** This is the complete performance-scale vocabulary used by the materiality rule and does not add a scale. */
export const MATERIALITY_SCALES = PERFORMANCE_FIXTURES.map(({ scale }) => scale);

/** This names the direction of one scale's median difference and does not assign a performance preference. */
export type MedianDifferenceDirection = "first-higher" | "second-higher" | "equal";

/** This carries one arm's median at one scale and does not assert that the arm differs from its counterpart. */
export type ArmMedian = {
  readonly arm: RendererName;
  readonly medianMs: number;
};

/** This supplies the two medians to compare at one scale and does not carry measurement provenance. */
export type ScaleMedianInput = {
  readonly scale: PerformanceScale;
  readonly first: ArmMedian;
  readonly second: ArmMedian;
};

/** This is a finite median ratio or an explicit zero-denominator result and does not conceal it as JSON null. */
export type MedianRatio = number | "INFINITE";

/** This reports a calculated per-scale ratio and direction and does not decide materiality by itself. */
export type ScaleMedianComparison = ScaleMedianInput & {
  readonly ratio: MedianRatio;
  readonly direction: MedianDifferenceDirection;
};

/** This names the frozen materiality outcomes and does not classify unavailable measurements. */
export type MaterialityOutcome = "MATERIAL" | "NO_MATERIAL_DIFFERENCE" | "SCALE_DEPENDENT";

/** This is the pure materiality decision across all governed scales and does not perform availability checks. */
export type MaterialityDecision = {
  readonly outcome: MaterialityOutcome;
  readonly reason: string;
  readonly scales: readonly ScaleMedianComparison[];
};

/** This applies the frozen median-ratio and direction rule and does not compare incomplete scale sets. */
export function analyseMedianMateriality(inputs: readonly ScaleMedianInput[]): MaterialityDecision {
  assertCompleteScaleSet(inputs);
  const scales = inputs.map(compareScaleMedians);
  const directions = new Set(scales.map(({ direction }) => direction));

  if (directions.has("first-higher") && directions.has("second-higher")) {
    return {
      outcome: "SCALE_DEPENDENT",
      reason: "the direction flips across scales; the result is reported without averaging those differences away",
      scales,
    };
  }

  const direction = scales[0]?.direction;
  const allDirectionsMatch = direction !== undefined && direction !== "equal" && scales.every((scale) => scale.direction === direction);
  const everyRatioIsMaterial = scales.every((scale) => ratioMeetsThreshold(scale.ratio));
  if (allDirectionsMatch && everyRatioIsMaterial) {
    return {
      outcome: "MATERIAL",
      reason: `all three scales have the same direction and every median ratio is at least ${MATERIAL_RATIO_THRESHOLD}`,
      scales,
    };
  }

  return {
    outcome: "NO_MATERIAL_DIFFERENCE",
    reason: `a material result requires the same non-equal direction at all three scales and every median ratio to be at least ${MATERIAL_RATIO_THRESHOLD}`,
    scales,
  };
}

function compareScaleMedians(input: ScaleMedianInput): ScaleMedianComparison {
  assertMedian(input.first.medianMs, input.scale, input.first.arm);
  assertMedian(input.second.medianMs, input.scale, input.second.arm);
  const direction = input.first.medianMs === input.second.medianMs
    ? "equal"
    : input.first.medianMs > input.second.medianMs
      ? "first-higher"
      : "second-higher";
  return {
    ...input,
    direction,
    ratio: medianRatio(input.first.medianMs, input.second.medianMs),
  };
}

function medianRatio(first: number, second: number): MedianRatio {
  const smaller = Math.min(first, second);
  if (smaller === 0) {
    return first === second ? 1 : "INFINITE";
  }
  return Math.max(first, second) / smaller;
}

function ratioMeetsThreshold(ratio: MedianRatio): boolean {
  return ratio === "INFINITE" || ratio >= MATERIAL_RATIO_THRESHOLD;
}

function assertCompleteScaleSet(inputs: readonly ScaleMedianInput[]): void {
  const expected = new Set(MATERIALITY_SCALES);
  const actual = new Set(inputs.map(({ scale }) => scale));
  if (inputs.length !== MATERIALITY_SCALES.length || actual.size !== expected.size || ![...expected].every((scale) => actual.has(scale))) {
    throw new Error("materiality requires exactly one median comparison at each governed performance scale");
  }
}

function assertMedian(value: number, scale: PerformanceScale, arm: RendererName): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`median for ${arm} at ${scale} must be a finite non-negative number`);
  }
}
