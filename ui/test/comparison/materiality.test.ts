import assert from "node:assert/strict";
import test from "node:test";
import {
  analysePerformanceArtifact,
  PERFORMANCE_EVIDENCE_COMMAND,
} from "#comparison/analyse.ts";
import type {
  RendererComparisonRecord,
} from "#comparison/analyse.ts";
import { analyseMedianMateriality } from "#comparison/materiality.ts";
import {
  performanceResult,
  SOFTWARE_RASTERISATION_LABEL,
} from "#browser/performance-contract.ts";
import type {
  Distribution,
  Measurement,
  PerformanceMeasurements,
  PerformanceRecord,
  PerformanceResult,
  PerformanceScale,
  RendererName,
} from "#browser/performance-contract.ts";

/** This prevents a renderer contrast identity from being constructed with the projection label and does not execute a false comparison. */
type RendererContrastIdentity = Pick<RendererComparisonRecord, "kind" | "arms">;

const impossibleRendererContrast: RendererContrastIdentity = {
  // @ts-expect-error A secondary contrast's type permits only the renderer label.
  kind: "projection",
  arms: { first: "sigma-2d", second: "r3f-2d" },
};
void impossibleRendererContrast;

/** This builds one complete three-scale input and does not add a fourth scale to the materiality rule. */
function materialityInput(
  first: readonly number[],
  second: readonly number[],
  firstArm: RendererName = "r3f-2d",
  secondArm: RendererName = "r3f-3d",
) {
  const scales: readonly PerformanceScale[] = ["10^2", "10^3", "10^4"];
  return scales.map((scale, index) => ({
    scale,
    first: { arm: firstArm, medianMs: first[index] ?? Number.NaN },
    second: { arm: secondArm, medianMs: second[index] ?? Number.NaN },
  }));
}

test("negative control: comparing two copies of the same arm reports no material difference", () => {
  const decision = analyseMedianMateriality(materialityInput([10, 20, 40], [10, 20, 40], "r3f-2d", "r3f-2d"));
  assert.equal(decision.outcome, "NO_MATERIAL_DIFFERENCE");
});

test("negative control: a two-times gap at one scale only reports no material difference", () => {
  const result = analysePerformanceArtifact(performanceArtifact([10, 10, 10], [20, 10, 10]));
  assert.equal(frameTimeOutcome(result, "projection"), "NO_MATERIAL_DIFFERENCE");
});

test("negative control: a consistent 1.24-times gap reports no material difference", () => {
  const result = analysePerformanceArtifact(performanceArtifact([100, 100, 100], [124, 124, 124]));
  assert.equal(frameTimeOutcome(result, "projection"), "NO_MATERIAL_DIFFERENCE");
});

test("the inclusive 1.25-times boundary reports a material difference", () => {
  const result = analysePerformanceArtifact(performanceArtifact([100, 100, 100], [125, 125, 125]));
  assert.equal(frameTimeOutcome(result, "projection"), "MATERIAL");
});

test("negative control: a direction flip reports scale dependent rather than no material difference", () => {
  const result = analysePerformanceArtifact(performanceArtifact([100, 200, 100], [200, 100, 200]));
  assert.equal(frameTimeOutcome(result, "projection"), "SCALE_DEPENDENT");
});

test("the analyser emits every dimension for both contrasts with re-derivable provenance", () => {
  const analysis = analysePerformanceArtifact(performanceArtifact([100, 100, 100], [125, 125, 125]));
  assert.equal(analysis.comparisons.length, 20);
  assert.equal(analysis.comparisons.filter((record) => record.kind === "projection").length, 10);
  assert.equal(analysis.comparisons.filter((record) => record.kind === "renderer").length, 10);
  const projection = analysis.comparisons.find((record) => record.kind === "projection" && record.dimension === "frameTime");
  assert.ok(projection !== undefined);
  assert.equal(projection.outcome, "MATERIAL");
  assert.equal(projection.provenance.command, PERFORMANCE_EVIDENCE_COMMAND);
  assert.equal(projection.provenance.caveat, SOFTWARE_RASTERISATION_LABEL);
  assert.match(projection.metricDefinition, /\.$/u);
  assert.equal(projection.scales.length, 3);
  const firstScale = projection.scales[0];
  assert.ok(firstScale !== undefined);
  assert.equal(firstScale.first.provenance.configuration.arm, "r3f-2d");
  assert.equal(firstScale.first.provenance.configuration.fixture, "stress-100.json");
  assert.deepEqual(firstScale.first.provenance.configuration.viewport, { width: 960, height: 640 });
  assert.equal(firstScale.first.provenance.configuration.warmupFramesExcluded, 5);
  assert.equal(firstScale.comparisonProvenance?.command, PERFORMANCE_EVIDENCE_COMMAND);
  assert.equal(firstScale.comparisonProvenance?.caveat, SOFTWARE_RASTERISATION_LABEL);
  const memory = analysis.comparisons.find((record) => record.kind === "projection" && record.dimension === "memory");
  assert.ok(memory !== undefined);
  assert.equal(memory.outcome, "NOT_COMPARABLE");
  assert.equal(memory.reason, "not a distribution-shaped measurement; requires its own rule");
});

test("shared layout and scene construction remain not comparable even when a fixture carries distributions", () => {
  const analysis = analysePerformanceArtifact(performanceArtifact([100, 100, 100], [125, 125, 125]));
  for (const dimension of ["layoutCost", "sceneModelBuildCost"] as const) {
    const record = analysis.comparisons.find((candidate) => candidate.kind === "projection" && candidate.dimension === dimension);
    assert.ok(record !== undefined);
    assert.equal(record.outcome, "NOT_COMPARABLE");
    assert.equal(record.reason, "not comparable by construction: this is shared renderer-neutral work, not a projection property");
  }
});

test("the analyser preserves the instrument reason for a recorded-not-run camera dimension", () => {
  const artifact = performanceArtifact([100, 100, 100], [125, 125, 125]);
  const ownReason = "orbit/dolly transition is only defined for r3f-3d";
  const records = artifact.records.map((record): PerformanceRecord => record.renderer === "r3f-2d" && record.scale === "10^2"
    ? {
      ...record,
      measurements: { ...record.measurements, cameraTransitionCost: notRun<Distribution>(ownReason) },
    }
    : record);
  const analysis = analysePerformanceArtifact({ ...artifact, records });
  const camera = analysis.comparisons.find((record) => record.kind === "projection" && record.dimension === "cameraTransitionCost");
  assert.ok(camera !== undefined);
  assert.equal(camera.outcome, "NOT_COMPARABLE");
  assert.match(camera.reason, new RegExp(ownReason, "u"));
  const firstScale = camera.scales[0];
  assert.ok(firstScale !== undefined);
  assert.equal(firstScale.first.reason, ownReason);
});

test("a renderer contrast carries only its renderer label at runtime", () => {
  const analysis = analysePerformanceArtifact(performanceArtifact([100, 100, 100], [125, 125, 125]));
  const secondary = analysis.comparisons.find((record) => record.kind === "renderer");
  assert.ok(secondary !== undefined);
  assert.equal(secondary.kind, "renderer");
  assert.deepEqual(secondary.arms, { first: "sigma-2d", second: "r3f-2d" });
});

function frameTimeOutcome(result: ReturnType<typeof analysePerformanceArtifact>, kind: "projection" | "renderer"): string {
  const record = result.comparisons.find((candidate) => candidate.kind === kind && candidate.dimension === "frameTime");
  assert.ok(record !== undefined, `${kind} frameTime comparison was not emitted`);
  return record.outcome;
}

function performanceArtifact(
  r3f2dFrameMedians: readonly number[],
  r3f3dFrameMedians: readonly number[],
): PerformanceResult {
  const scales: readonly PerformanceScale[] = ["10^2", "10^3", "10^4"];
  const records = (["sigma-2d", "r3f-2d", "r3f-3d"] as const).flatMap((renderer) => scales.map((scale, index) => performanceRecord(
    renderer,
    scale,
    renderer === "r3f-2d"
      ? r3f2dFrameMedians[index] ?? Number.NaN
      : renderer === "r3f-3d"
        ? r3f3dFrameMedians[index] ?? Number.NaN
        : 100,
  )));
  return performanceResult(records, "comparison-test-commit");
}

function performanceRecord(renderer: RendererName, scale: PerformanceScale, frameMedian: number): PerformanceRecord {
  const fixture = scale === "10^2" ? "stress-100.json" : scale === "10^3" ? "stress-1000.json" : "stress-10000.json";
  return {
    renderer,
    scale,
    fixture,
    syntheticFixture: true,
    rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
    elementCounts: { fixtureNodes: 100, fixtureEdges: 200, renderedNodes: 100, renderedEdges: 200 },
    devicePixelRatio: 1,
    viewport: { width: 960, height: 640 },
    observedCommitSha: "comparison-test-commit",
    warmup: { framesExcluded: 5, reason: "test warm-up frames are excluded" },
    measurements: measurements(frameMedian),
  };
}

function measurements(frameMedian: number): PerformanceMeasurements {
  return {
    frameTime: passDistribution(frameMedian),
    initialRenderLatency: passDistribution(10),
    layoutCost: passDistribution(10),
    sceneModelBuildCost: passDistribution(10),
    interactionLatency: passDistribution(10),
    pickingLatency: passDistribution(10),
    memory: pass({
      browserMemory: pass({ usedJsHeapSize: 1, totalJsHeapSize: 2, jsHeapSizeLimit: 3 }),
      retainedResources: pass({ textures: 1, geometries: 1, materials: 1, domOverlayNodes: 1 }),
    }),
    cameraTransitionCost: passDistribution(10),
    cameraSwitchCost: passDistribution(10),
    progressiveDisclosure: pass({
      aggregationForcedAtScale: null,
      aggregationForcedBand: null,
      aggregationCriterion: "test",
      bands: [],
    }),
  };
}

function passDistribution(medianMs: number): Measurement<Distribution> {
  return pass({ samplesMs: [medianMs], medianMs, p95Ms: medianMs });
}

function pass<Value>(value: Value): Measurement<Value> {
  return {
    status: "PASS",
    label: SOFTWARE_RASTERISATION_LABEL,
    warmupFramesExcluded: 5,
    warmupReason: "test warm-up frames are excluded",
    value,
  };
}

function notRun<Value>(reason: string): Measurement<Value> {
  return {
    status: "NOT_RUN",
    label: SOFTWARE_RASTERISATION_LABEL,
    warmupFramesExcluded: 5,
    warmupReason: "test warm-up frames are excluded",
    reason,
  };
}
