/** Browser-free types and record construction shared by the performance page and its spec. */

export const SOFTWARE_RASTERISATION_LABEL: "software-rasterised — not GPU performance" = "software-rasterised — not GPU performance";
export const WARMUP_FRAMES = 5;
export const PERFORMANCE_VIEWPORT = { width: 960, height: 640 } as const;
export const SYNTHETIC_FIXTURE_DECLARATION = "SYNTHETIC STRESS MATERIAL ONLY: carries no semantic meaning, is never canon, and exists only to measure renderer performance.";

export type RendererName = "sigma-2d" | "r3f-2d" | "r3f-3d";
export type PerformanceScale = "10^2" | "10^3" | "10^4";

export type PerformanceCombination = {
  readonly renderer: RendererName;
  readonly scale: PerformanceScale;
  readonly fixture: string;
};

export const PERFORMANCE_FIXTURES: readonly Pick<PerformanceCombination, "scale" | "fixture">[] = [
  { fixture: "stress-100.json", scale: "10^2" },
  { fixture: "stress-1000.json", scale: "10^3" },
  { fixture: "stress-10000.json", scale: "10^4" },
];

export const PERFORMANCE_COMBINATIONS: readonly PerformanceCombination[] = [
  ...PERFORMANCE_FIXTURES.map((fixture) => ({ renderer: "sigma-2d" as const, ...fixture })),
  ...PERFORMANCE_FIXTURES.map((fixture) => ({ renderer: "r3f-2d" as const, ...fixture })),
  ...PERFORMANCE_FIXTURES.map((fixture) => ({ renderer: "r3f-3d" as const, ...fixture })),
];

export const PERFORMANCE_MEASUREMENTS = [
  "frameTime",
  "initialRenderLatency",
  "layoutCost",
  "sceneModelBuildCost",
  "interactionLatency",
  "pickingLatency",
  "memory",
  "cameraTransitionCost",
  "cameraSwitchCost",
  "progressiveDisclosure",
] as const;

export type MeasurementStatus = "PASS" | "NOT_RUN" | "UNKNOWN";

export type Distribution = {
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly p95Ms: number;
};

export type Measurement<Value> =
  | {
      readonly status: "PASS";
      readonly label: typeof SOFTWARE_RASTERISATION_LABEL;
      readonly warmupFramesExcluded: number;
      readonly warmupReason: string;
      readonly value: Value;
    }
  | {
      readonly status: Exclude<MeasurementStatus, "PASS">;
      readonly label: typeof SOFTWARE_RASTERISATION_LABEL;
      readonly warmupFramesExcluded: number;
      readonly warmupReason: string;
      readonly reason: string;
    };

export type MemoryUsage = {
  readonly usedJsHeapSize: number;
  readonly totalJsHeapSize: number;
  readonly jsHeapSizeLimit: number;
};

export type RetainedResourceWitness = {
  readonly textures: number;
  readonly geometries: number;
  readonly materials: number;
  readonly domOverlayNodes: number;
};

export type MemoryValue = {
  readonly browserMemory: Measurement<MemoryUsage>;
  readonly retainedResources: Measurement<RetainedResourceWitness>;
};

export type ProgressiveBand = {
  readonly band: "macro" | "meso" | "micro";
  readonly aggregationMaterial: readonly string[];
  readonly aggregateCount: Measurement<number>;
  readonly mountToFirstPaint: Measurement<Distribution>;
  readonly renderedElementCounts: Measurement<{ readonly nodes: number; readonly edges: number }>;
};

export type ProgressiveValue = {
  readonly aggregationForcedAtScale: PerformanceScale | null;
  readonly aggregationForcedBand: ProgressiveBand["band"] | null;
  readonly aggregationCriterion: string;
  readonly bands: readonly ProgressiveBand[];
};

export type PerformanceMeasurements = {
  readonly frameTime: Measurement<Distribution>;
  readonly initialRenderLatency: Measurement<Distribution>;
  readonly layoutCost: Measurement<Distribution>;
  readonly sceneModelBuildCost: Measurement<Distribution>;
  readonly interactionLatency: Measurement<Distribution>;
  readonly pickingLatency: Measurement<Distribution>;
  readonly memory: Measurement<MemoryValue>;
  readonly cameraTransitionCost: Measurement<Distribution>;
  readonly cameraSwitchCost: Measurement<Distribution>;
  readonly progressiveDisclosure: Measurement<ProgressiveValue>;
};

export type PerformanceRecord = {
  readonly renderer: RendererName;
  readonly scale: PerformanceScale;
  readonly fixture: string;
  readonly syntheticFixture: true;
  readonly rasterisationLabel: typeof SOFTWARE_RASTERISATION_LABEL;
  readonly elementCounts: {
    readonly fixtureNodes: number | "NOT_RUN";
    readonly fixtureEdges: number | "NOT_RUN";
    readonly renderedNodes: number | "NOT_RUN";
    readonly renderedEdges: number | "NOT_RUN";
  };
  readonly devicePixelRatio: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly observedCommitSha: string;
  readonly warmup: {
    readonly framesExcluded: number;
    readonly reason: string;
  };
  readonly measurements: PerformanceMeasurements;
  readonly error?: string;
};

export type PerformanceResult = {
  readonly schemaVersion: 1;
  readonly suite: "CAP-13 renderer performance";
  readonly rasterisationLabel: typeof SOFTWARE_RASTERISATION_LABEL;
  readonly syntheticFixtureDeclaration: string;
  readonly observedCommitSha: string;
  readonly browser: { readonly devicePixelRatio: number };
  readonly summary: {
    readonly passing: boolean;
    readonly bound: boolean;
    readonly required: number;
    readonly passed: number;
    readonly notRun: number;
    readonly unknown: number;
    readonly rule: string;
  };
  readonly records: readonly PerformanceRecord[];
};

export function notRunPerformanceRecord(
  combination: PerformanceCombination,
  observedCommitSha: string,
  devicePixelRatio: number,
  reason: string,
): PerformanceRecord {
  return {
    ...combination,
    syntheticFixture: true,
    rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
    elementCounts: { fixtureNodes: "NOT_RUN", fixtureEdges: "NOT_RUN", renderedNodes: "NOT_RUN", renderedEdges: "NOT_RUN" },
    devicePixelRatio,
    viewport: PERFORMANCE_VIEWPORT,
    observedCommitSha,
    warmup: { framesExcluded: WARMUP_FRAMES, reason: "No frames were warmed because this renderer-by-scale attempt did not complete." },
    measurements: notRunMeasurements(reason),
    error: reason,
  };
}

export function performanceResult(
  records: readonly PerformanceRecord[],
  observedCommitSha: string,
): PerformanceResult {
  const statuses = records.flatMap(performanceMeasurementStatuses);
  const passed = statuses.filter((status) => status === "PASS").length;
  const notRun = statuses.filter((status) => status === "NOT_RUN").length;
  const unknown = statuses.filter((status) => status === "UNKNOWN").length;
  const expected = new Set(PERFORMANCE_COMBINATIONS.map(combinationKey));
  const actual = new Set(records.map(combinationKey));
  const bound = records.length === PERFORMANCE_COMBINATIONS.length
    && actual.size === PERFORMANCE_COMBINATIONS.length
    && [...expected].every((key) => actual.has(key))
    && records.every((record) => record.observedCommitSha === observedCommitSha);
  return {
    schemaVersion: 1,
    suite: "CAP-13 renderer performance",
    rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
    syntheticFixtureDeclaration: SYNTHETIC_FIXTURE_DECLARATION,
    observedCommitSha,
    browser: { devicePixelRatio: records[0]?.devicePixelRatio ?? 1 },
    summary: {
      passing: bound && notRun === 0 && unknown === 0 && passed === statuses.length,
      bound,
      required: statuses.length,
      passed,
      notRun,
      unknown,
      rule: "The performance run passes only when every recorded measurement criterion is commit-bound and PASS; NOT_RUN and UNKNOWN retain their reasons and make the run verdict false.",
    },
    records,
  };
}

export function combinationKey(combination: Pick<PerformanceCombination, "renderer" | "scale">): string {
  return `${combination.renderer}:${combination.scale}`;
}

function performanceMeasurementStatuses(record: PerformanceRecord): readonly MeasurementStatus[] {
  const measurements = record.measurements;
  const statuses: MeasurementStatus[] = Object.values(measurements).map((measurement) => measurement.status);
  if (measurements.memory.status === "PASS") {
    statuses.push(measurements.memory.value.browserMemory.status, measurements.memory.value.retainedResources.status);
  }
  if (measurements.progressiveDisclosure.status === "PASS") {
    for (const band of measurements.progressiveDisclosure.value.bands) {
      statuses.push(band.aggregateCount.status, band.mountToFirstPaint.status, band.renderedElementCounts.status);
    }
  }
  return statuses;
}

function notRunMeasurements(reason: string): PerformanceMeasurements {
  return {
    frameTime: notRun(reason),
    initialRenderLatency: notRun(reason),
    layoutCost: notRun(reason),
    sceneModelBuildCost: notRun(reason),
    interactionLatency: notRun(reason),
    pickingLatency: notRun(reason),
    memory: notRun(reason),
    cameraTransitionCost: notRun(reason),
    cameraSwitchCost: notRun(reason),
    progressiveDisclosure: notRun(reason),
  };
}

function notRun<Value>(reason: string): Measurement<Value> {
  return {
    status: "NOT_RUN",
    label: SOFTWARE_RASTERISATION_LABEL,
    warmupFramesExcluded: WARMUP_FRAMES,
    warmupReason: "No measurement was taken because the operation did not run.",
    reason,
  };
}
