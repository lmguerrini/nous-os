/** Performance-artifact comparison analysis; this module does not collect browser measurements or alter the source artifact. */
import {
  PERFORMANCE_FIXTURES,
  PERFORMANCE_MEASUREMENTS,
  SOFTWARE_RASTERISATION_LABEL,
} from "#browser/performance-contract.ts";
import type {
  MeasurementStatus,
  PerformanceRecord,
  PerformanceResult,
  PerformanceScale,
  RendererName,
} from "#browser/performance-contract.ts";
import {
  analyseMedianMateriality,
  type MaterialityOutcome,
  type MedianDifferenceDirection,
  type MedianRatio,
} from "./materiality.ts";

/** This is the command that produces the performance source artifact and does not run the comparison analysis. */
export const PERFORMANCE_EVIDENCE_COMMAND = "npm run test:performance";

/** This names every measurement dimension imported from the performance contract and does not introduce a new measurement. */
export type ComparisonDimension = typeof PERFORMANCE_MEASUREMENTS[number];

/** This names a comparison variable controlled by a contrast and does not make a causal claim beyond that contrast. */
export type ContrastKind = "projection" | "renderer";

/** This is the only projection contrast and does not compare different renderer implementations. */
export type ProjectionContrastArms = {
  readonly first: "r3f-2d";
  readonly second: "r3f-3d";
};

/** This is the only renderer contrast and does not compare 2D with 3D projection. */
export type RendererContrastArms = {
  readonly first: "sigma-2d";
  readonly second: "r3f-2d";
};

/** This records the source configuration of one value and does not claim that missing source fields were measured. */
export type SourceConfiguration = {
  readonly arm: RendererName;
  readonly scale: PerformanceScale;
  readonly fixture: string | null;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly warmupFramesExcluded: number | null;
  readonly warmupReason: string | null;
};

/** This identifies how one source value was produced and does not replace the source performance artifact. */
export type SourceProvenance = {
  readonly command: typeof PERFORMANCE_EVIDENCE_COMMAND;
  readonly configuration: SourceConfiguration;
  readonly metricDefinition: string;
  readonly caveat: typeof SOFTWARE_RASTERISATION_LABEL;
};

/** This identifies how a two-arm comparison number was derived and does not make its inputs anonymous. */
export type ComparisonProvenance = {
  readonly command: typeof PERFORMANCE_EVIDENCE_COMMAND;
  readonly configurations: readonly SourceConfiguration[];
  readonly metricDefinition: string;
  readonly caveat: typeof SOFTWARE_RASTERISATION_LABEL;
};

/** This retains one source measurement's status and median when present and does not invent a value for an unavailable measurement. */
export type SourceMeasurementEvidence = {
  readonly status: MeasurementStatus | "MISSING";
  readonly medianMs: number | null;
  readonly reason: string | null;
  readonly provenance: SourceProvenance;
};

/** This retains both source measurements at one scale and does not compute a ratio unless both medians passed. */
export type ComparisonScaleEvidence = {
  readonly scale: PerformanceScale;
  readonly first: SourceMeasurementEvidence;
  readonly second: SourceMeasurementEvidence;
  readonly ratio: MedianRatio | null;
  readonly direction: MedianDifferenceDirection | null;
  readonly comparisonProvenance: ComparisonProvenance | null;
};

/** This is an outcome made only after availability and the frozen materiality rule and does not turn an unavailable dimension into a result. */
export type ComparisonOutcome = MaterialityOutcome | "NOT_COMPARABLE";

/** This is the common evidence carried by every contrast record and does not omit source configuration or rasterisation caveats. */
export type ComparisonRecordBase = {
  readonly dimension: ComparisonDimension;
  readonly metricDefinition: string;
  readonly outcome: ComparisonOutcome;
  readonly reason: string;
  readonly provenance: ComparisonProvenance;
  readonly scales: readonly ComparisonScaleEvidence[];
};

/** This is one primary, projection-only comparison record and does not label a renderer comparison as projection. */
export type ProjectionComparisonRecord = ComparisonRecordBase & {
  readonly kind: "projection";
  readonly arms: ProjectionContrastArms;
};

/** This is one secondary, renderer-only comparison record and does not label it as a projection result. */
export type RendererComparisonRecord = ComparisonRecordBase & {
  readonly kind: "renderer";
  readonly arms: RendererContrastArms;
};

/** This is one typed comparison record for either frozen contrast and does not permit an unlabelled contrast. */
export type ComparisonRecord = ProjectionComparisonRecord | RendererComparisonRecord;

/** This is the CAP-14 analysis artifact and does not contain a replacement performance measurement run. */
export type ComparisonAnalysis = {
  readonly schemaVersion: 1;
  readonly suite: "CAP-14 renderer comparison analysis";
  readonly source: {
    readonly artifact: "dist/evidence/performance.json";
    readonly command: typeof PERFORMANCE_EVIDENCE_COMMAND;
    readonly observedCommitSha: string;
    readonly caveat: typeof SOFTWARE_RASTERISATION_LABEL;
  };
  readonly comparisons: readonly ComparisonRecord[];
};

const PROJECTION_ARMS: ProjectionContrastArms = { first: "r3f-2d", second: "r3f-3d" };
const RENDERER_ARMS: RendererContrastArms = { first: "sigma-2d", second: "r3f-2d" };
const NON_DISTRIBUTION_DIMENSIONS = new Set<ComparisonDimension>(["memory", "progressiveDisclosure"]);
const NOT_DISTRIBUTION_REASON = "not a distribution-shaped measurement; requires its own rule";
const SHARED_STAGE_DIMENSIONS = new Set<ComparisonDimension>(["layoutCost", "sceneModelBuildCost"]);
const SHARED_STAGE_REASON = "not comparable by construction: this is shared renderer-neutral work, not a projection property";

/** This reads a parsed performance result into both frozen contrasts and does not read files or launch a browser. */
export function analysePerformanceArtifact(artifact: PerformanceResult): ComparisonAnalysis {
  const projection = analyseContrast(artifact.records, PROJECTION_ARMS).map((record): ProjectionComparisonRecord => ({
    ...record,
    kind: "projection",
    arms: PROJECTION_ARMS,
  }));
  const renderer = analyseContrast(artifact.records, RENDERER_ARMS).map((record): RendererComparisonRecord => ({
    ...record,
    kind: "renderer",
    arms: RENDERER_ARMS,
  }));
  return {
    schemaVersion: 1,
    suite: "CAP-14 renderer comparison analysis",
    source: {
      artifact: "dist/evidence/performance.json",
      command: PERFORMANCE_EVIDENCE_COMMAND,
      observedCommitSha: artifact.observedCommitSha,
      caveat: SOFTWARE_RASTERISATION_LABEL,
    },
    comparisons: [...projection, ...renderer],
  };
}

function analyseContrast(
  records: readonly PerformanceRecord[],
  arms: ProjectionContrastArms | RendererContrastArms,
): readonly ComparisonRecordBase[] {
  return PERFORMANCE_MEASUREMENTS.map((dimension) => analyseDimension(records, arms, dimension));
}

function analyseDimension(
  records: readonly PerformanceRecord[],
  arms: ProjectionContrastArms | RendererContrastArms,
  dimension: ComparisonDimension,
): ComparisonRecordBase {
  const metricDefinition = measurementDefinition(dimension);
  const pairs = PERFORMANCE_FIXTURES.map(({ scale }) => sourcePair(records, arms, scale, dimension, metricDefinition));
  const provenance = comparisonProvenance(
    pairs.flatMap(({ first, second }) => [first.provenance.configuration, second.provenance.configuration]),
    metricDefinition,
  );
  if (SHARED_STAGE_DIMENSIONS.has(dimension)) {
    return {
      dimension,
      metricDefinition,
      outcome: "NOT_COMPARABLE",
      reason: SHARED_STAGE_REASON,
      provenance,
      scales: pairs.map(({ scale, first, second }) => unavailableScaleEvidence(scale, first, second)),
    };
  }
  if (NON_DISTRIBUTION_DIMENSIONS.has(dimension)) {
    return {
      dimension,
      metricDefinition,
      outcome: "NOT_COMPARABLE",
      reason: NOT_DISTRIBUTION_REASON,
      provenance,
      scales: pairs.map(({ scale, first, second }) => unavailableScaleEvidence(scale, first, second)),
    };
  }

  const unavailable = pairs.flatMap(({ scale, first, second }) => unavailableReasons(scale, dimension, first, second));
  if (unavailable.length > 0) {
    return {
      dimension,
      metricDefinition,
      outcome: "NOT_COMPARABLE",
      reason: unavailable.join("; "),
      provenance,
      scales: pairs.map(({ scale, first, second }) => unavailableScaleEvidence(scale, first, second)),
    };
  }

  const materiality = analyseMedianMateriality(pairs.map(({ scale, first, second }) => ({
    scale,
    first: { arm: arms.first, medianMs: first.medianMs as number },
    second: { arm: arms.second, medianMs: second.medianMs as number },
  })));
  return {
    dimension,
    metricDefinition,
    outcome: materiality.outcome,
    reason: materiality.reason,
    provenance,
    scales: materiality.scales.map((comparison) => {
      const pair = pairs.find(({ scale }) => scale === comparison.scale);
      if (pair === undefined) {
        throw new Error(`comparison input omitted ${comparison.scale}`);
      }
      const comparisonSource = comparisonProvenance(
        [pair.first.provenance.configuration, pair.second.provenance.configuration],
        metricDefinition,
      );
      return {
        scale: comparison.scale,
        first: pair.first,
        second: pair.second,
        ratio: comparison.ratio,
        direction: comparison.direction,
        comparisonProvenance: comparisonSource,
      };
    }),
  };
}

function sourcePair(
  records: readonly PerformanceRecord[],
  arms: ProjectionContrastArms | RendererContrastArms,
  scale: PerformanceScale,
  dimension: ComparisonDimension,
  metricDefinition: string,
): { readonly scale: PerformanceScale; readonly first: SourceMeasurementEvidence; readonly second: SourceMeasurementEvidence } {
  return {
    scale,
    first: sourceMeasurement(records, arms.first, scale, dimension, metricDefinition),
    second: sourceMeasurement(records, arms.second, scale, dimension, metricDefinition),
  };
}

function sourceMeasurement(
  records: readonly PerformanceRecord[],
  arm: RendererName,
  scale: PerformanceScale,
  dimension: ComparisonDimension,
  metricDefinition: string,
): SourceMeasurementEvidence {
  const record = records.find((candidate) => candidate.renderer === arm && candidate.scale === scale);
  const provenance = sourceProvenance(record, arm, scale, metricDefinition);
  if (record === undefined) {
    return { status: "MISSING", medianMs: null, reason: `${arm} at ${scale} is missing from the performance artifact`, provenance };
  }
  const measurement = record.measurements[dimension];
  if (measurement === undefined) {
    return { status: "MISSING", medianMs: null, reason: `${dimension} is missing for ${arm} at ${scale}`, provenance };
  }
  if (measurement.status !== "PASS") {
    return { status: measurement.status, medianMs: null, reason: measurement.reason, provenance };
  }
  const medianMs = distributionMedian(dimension, measurement.value);
  return { status: "PASS", medianMs, reason: null, provenance };
}

function distributionMedian(dimension: ComparisonDimension, value: unknown): number | null {
  if (NON_DISTRIBUTION_DIMENSIONS.has(dimension)) {
    return null;
  }
  const candidate = value as { readonly medianMs?: unknown };
  return typeof candidate.medianMs === "number" ? candidate.medianMs : null;
}

function unavailableReasons(
  scale: PerformanceScale,
  dimension: ComparisonDimension,
  first: SourceMeasurementEvidence,
  second: SourceMeasurementEvidence,
): readonly string[] {
  return [first, second].flatMap((source, index) => {
    if (source.status === "PASS" && source.medianMs !== null) {
      return [];
    }
    const arm = source.provenance.configuration.arm;
    const status = source.status === "PASS" ? "has no medianMs" : `is ${source.status}`;
    const detail = source.reason === null ? "" : `: ${source.reason}`;
    const side = index === 0 ? "first" : "second";
    return [`${dimension} for ${side} arm ${arm} at ${scale} ${status}${detail}`];
  });
}

function unavailableScaleEvidence(
  scale: PerformanceScale,
  first: SourceMeasurementEvidence,
  second: SourceMeasurementEvidence,
): ComparisonScaleEvidence {
  return { scale, first, second, ratio: null, direction: null, comparisonProvenance: null };
}

function sourceProvenance(
  record: PerformanceRecord | undefined,
  arm: RendererName,
  scale: PerformanceScale,
  metricDefinition: string,
): SourceProvenance {
  return {
    command: PERFORMANCE_EVIDENCE_COMMAND,
    configuration: record === undefined
      ? { arm, scale, fixture: null, viewport: null, warmupFramesExcluded: null, warmupReason: null }
      : {
        arm: record.renderer,
        scale: record.scale,
        fixture: record.fixture,
        viewport: record.viewport,
        warmupFramesExcluded: record.warmup.framesExcluded,
        warmupReason: record.warmup.reason,
      },
    metricDefinition,
    caveat: SOFTWARE_RASTERISATION_LABEL,
  };
}

function comparisonProvenance(
  configurations: readonly SourceConfiguration[],
  metricDefinition: string,
): ComparisonProvenance {
  if (configurations.length < 2) {
    throw new Error("comparison provenance requires both arm configurations");
  }
  return {
    command: PERFORMANCE_EVIDENCE_COMMAND,
    configurations,
    metricDefinition,
    caveat: SOFTWARE_RASTERISATION_LABEL,
  };
}

function measurementDefinition(dimension: ComparisonDimension): string {
  switch (dimension) {
    case "frameTime":
      return "This median measures milliseconds between counted animation frames after excluded warm-up frames.";
    case "initialRenderLatency":
      return "This median measures milliseconds from renderer mount start to the first painted frame containing graph content.";
    case "layoutCost":
      return "This shared force-directed layout stage is excluded from the projection contrast.";
    case "sceneModelBuildCost":
      return "This shared renderer-neutral scene construction stage is excluded from the projection contrast.";
    case "interactionLatency":
      return "This median measures milliseconds from selection start to the first frame whose decoded final-compositor pixels differ from the settled unselected baseline.";
    case "pickingLatency":
      return "This median measures milliseconds spent in synchronous node and edge picking calls over fixed fixture positions.";
    case "memory":
      return "This family records browser heap and renderer-owned resource witnesses rather than one distribution-shaped scalar.";
    case "cameraTransitionCost":
      return "This median measures milliseconds from an r3f-3d orbit/dolly proxy restore to its first painted frame.";
    case "cameraSwitchCost":
      return "This median measures milliseconds from switching camera kinds to the first painted frame after the switch.";
    case "progressiveDisclosure":
      return "This family records aggregation bands and their witnesses rather than one distribution-shaped scalar.";
  }
}
