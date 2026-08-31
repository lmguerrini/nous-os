import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ComparisonAnalysis } from "#comparison/analyse.ts";
import type { PerformanceResult } from "#browser/performance-contract.ts";
import { renderDocument } from "./comparison/report-document.ts";
import { redactTimingLiterals, timingLiteralsIn } from "./comparison/timing-literal.ts";

/**
 * `docs/CAP-14-COMPARISON.md` is an artifact consumer, not prose that happens
 * to mention evidence. Each check below reads the report against its producing
 * artifacts and carries a control that proves the check turns red when its
 * claim is violated.
 */

const DOCUMENT_PATH = ["..", "docs", "CAP-14-COMPARISON.md"].join("/");
const COMPARISON_PATH = ["dist", "evidence", "comparison.json"].join("/");
const PERFORMANCE_PATH = ["dist", "evidence", "performance.json"].join("/");

type ComparisonClaim = {
  readonly kind: "projection" | "renderer";
  readonly dimension: string;
  readonly outcome: string;
  readonly reason: string;
  readonly arms: { readonly first: string; readonly second: string };
  readonly scales: readonly ComparisonScaleClaim[];
};

type ComparisonScaleClaim = {
  readonly scale: string;
  readonly first: SourceConfigurationClaim;
  readonly second: SourceConfigurationClaim;
};

type SourceConfigurationClaim = {
  readonly arm: string;
  readonly scale: string;
  readonly fixture: string | null;
};

type PerformanceClaim = {
  readonly rasterisationLabel: string;
  readonly records: readonly PerformanceRecordClaim[];
};

type PerformanceRecordClaim = {
  readonly renderer: string;
  readonly scale: string;
  readonly elementCounts: { readonly fixtureNodes: number | "NOT_RUN"; readonly fixtureEdges: number | "NOT_RUN" };
};

test("the CAP-14 report transcribes no timing figure", async () => {
  assertNoTimingFigures(await readFile(DOCUMENT_PATH, "utf8"));

  // The shared renderer-document rule must also refuse a stale CAP-14 timing in prose.
  assert.throws(
    () => assertNoTimingFigures("Median: 440 ms"),
    /contains a timing figure/,
  );
});

test("the CAP-14 report carries every comparison dimension and its artifact outcome", async () => {
  const [document, comparison] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(COMPARISON_PATH)]);
  assertDimensionOutcomes(document, comparisonClaims(comparison));

  const claim: ComparisonClaim = {
    kind: "projection",
    dimension: "frameTime",
    outcome: "NOT_COMPARABLE",
    reason: "not comparable",
    arms: { first: "r3f-2d", second: "r3f-3d" },
    scales: [],
  };
  assert.throws(
    () => assertDimensionOutcomes(
      "### Projection contrast — r3f-2d vs r3f-3d\n\n#### frameTime\n\nOutcome: `MATERIAL`\n",
      [claim],
    ),
    /matching outcome/,
  );
});

test("the renderer contrast cannot be read as a projection result", async () => {
  const [document, comparison] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(COMPARISON_PATH)]);
  const renderer = comparisonClaims(comparison).find((claim) => claim.kind === "renderer");
  assert.ok(renderer !== undefined, "comparison artifact must retain the renderer contrast");
  assertRendererContrastIsNotProjection(document, renderer);

  assert.throws(
    () => assertRendererContrastIsNotProjection(
      "### Renderer comparison — sigma-2d vs r3f-2d\n\nSame renderer; projection is the only variable. This supports a 2D-vs-3D statement.\n",
      {
        kind: "renderer",
        dimension: "frameTime",
        outcome: "NOT_COMPARABLE",
        reason: "not comparable",
        arms: { first: "sigma-2d", second: "r3f-2d" },
        scales: [],
      },
    ),
    /renderer comparison/,
  );
});

test("every CAP-14 dimension carries the artifact caveat", async () => {
  const [document, comparison, performance] = await Promise.all([
    readFile(DOCUMENT_PATH, "utf8"),
    readJson(COMPARISON_PATH),
    readJson(PERFORMANCE_PATH),
  ]);
  assertDimensionsCarryCaveat(document, comparisonClaims(comparison), performanceClaim(performance).rasterisationLabel);

  assert.throws(
    () => assertDimensionsCarryCaveat(
      "### Projection contrast — r3f-2d vs r3f-3d\n\n#### frameTime\n",
      [{ kind: "projection", dimension: "frameTime", outcome: "NOT_COMPARABLE", reason: "not comparable", arms: { first: "r3f-2d", second: "r3f-3d" }, scales: [] }],
      "software-rasterised — not GPU performance",
    ),
    /has no caveat/,
  );
});

test("the CAP-14 report states fixture counts recorded by performance evidence", async () => {
  const [document, performance] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(PERFORMANCE_PATH)]);
  const counts = fixtureCountsByScale(performanceClaim(performance).records);
  assertDocumentScaleCounts(document, counts);

  const nominal = counts.get("10^2");
  assert.ok(nominal !== undefined, "performance artifact must contain the nominal scale");
  const incorrectNodes = nominal.nodes === "NOT_RUN" ? "NOT_RUN" : nominal.nodes + 1;
  assert.throws(
    () => assertDocumentScaleCounts(
      `Scale \`10^2\` (${String(incorrectNodes)} nodes and ${String(nominal.edges)} edges)`,
      new Map([["10^2", nominal]]),
    ),
    /fixture counts differ/,
  );
});

test("every non-comparable CAP-14 dimension preserves the instrument reason without its timing literal", async () => {
  const [document, comparison] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(COMPARISON_PATH)]);
  assertNotComparableReasons(document, comparisonClaims(comparison));

  assert.throws(
    () => assertNotComparableReasons(
      "### Projection contrast — r3f-2d vs r3f-3d\n\n#### frameTime\n\nOutcome: `NOT_COMPARABLE`\n\nReason (instrument wording): another reason\n",
      [{ kind: "projection", dimension: "frameTime", outcome: "NOT_COMPARABLE", reason: "instrument reason", arms: { first: "r3f-2d", second: "r3f-3d" }, scales: [] }],
    ),
    /instrument reason/,
  );
});

test("every CAP-14 dimension points directly to its outcome and value artifacts", async () => {
  const [document, comparison] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(COMPARISON_PATH)]);
  assertDimensionArtifactPointers(document, comparisonClaims(comparison));

  assert.throws(
    () => assertDimensionArtifactPointers(
      "### Projection contrast — r3f-2d vs r3f-3d\n\n#### frameTime\n\nOutcome: `NOT_COMPARABLE`\n",
      [{
        kind: "projection",
        dimension: "frameTime",
        outcome: "NOT_COMPARABLE",
        reason: "not comparable",
        arms: { first: "r3f-2d", second: "r3f-3d" },
        scales: [{ scale: "10^2", first: { arm: "r3f-2d", scale: "10^2", fixture: "stress-100.json" }, second: { arm: "r3f-3d", scale: "10^2", fixture: "stress-100.json" } }],
      }],
    ),
    /artifact pointer/,
  );
});

test("CAP-14 document rendering is byte-stable for repeated and median-different artifacts", async () => {
  const [comparison, performance] = await Promise.all([readJson(COMPARISON_PATH), readJson(PERFORMANCE_PATH)]);
  const analysis = comparison as ComparisonAnalysis;
  const source = performance as PerformanceResult;
  const first = renderDocument(analysis, source);
  const repeated = renderDocument(analysis, source);
  assertIdenticalBytes(first, repeated, "repeated rendering from the same artifacts");

  const medianDifferent = withDifferentMedians(analysis);
  assert.deepEqual(comparisonClaims(medianDifferent), comparisonClaims(analysis), "the control artifact must retain every outcome and identity");
  assert.notDeepEqual(medianValues(medianDifferent), medianValues(analysis), "the control artifact must change measured medians");
  assertIdenticalBytes(first, renderDocument(medianDifferent, source), "rendering from median-different artifacts with identical outcomes");

  const measurementsDifferent = withDifferentMeasurementValues(source);
  assert.notDeepEqual(measurementsDifferent, source, "the control source artifact must change its measured values");
  assertIdenticalBytes(first, renderDocument(analysis, measurementsDifferent), "rendering from different p95, sample, and memory values");

  assert.throws(
    () => assertIdenticalBytes("Outcome: `MEASURED`\nMedian: 8 ms\n", "Outcome: `MEASURED`\nMedian: 9 ms\n", "a document that transcribes a median"),
    /not byte-stable/,
  );
});

function assertNoTimingFigures(document: string): void {
  const found = timingLiteralsIn(document);
  if (found.length > 0) {
    throw new Error(
      `docs/CAP-14-COMPARISON.md contains a timing figure (${found.join(", ")}). Timings belong in the artifact that produced them.`,
    );
  }
}

function assertDimensionOutcomes(document: string, claims: readonly ComparisonClaim[]): void {
  for (const claim of claims) {
    const contrast = contrastSection(document, claim);
    const dimension = sectionFromHeading(contrast, `#### ${claim.dimension}`, /^#### /mu);
    if (dimension === null || !dimension.includes(`Outcome: \`${claim.outcome}\``)) {
      throw new Error(
        `CAP-14 report is missing ${claim.kind} ${claim.dimension} with matching outcome ${claim.outcome}`,
      );
    }
  }
}

function assertRendererContrastIsNotProjection(document: string, renderer: ComparisonClaim): void {
  const section = contrastSection(document, renderer);
  if (!section.startsWith(`### Renderer comparison — ${renderer.arms.first} vs ${renderer.arms.second}`)) {
    throw new Error("CAP-14 renderer contrast must be labelled a renderer comparison");
  }
  if (!section.includes("Renderer varies while projection is held at 2D.")) {
    throw new Error("CAP-14 renderer comparison must state that projection is held");
  }
  if (!section.includes("This is a renderer comparison, not a projection or 2D-vs-3D result.")) {
    throw new Error("CAP-14 renderer comparison must deny a projection or 2D-vs-3D reading");
  }
  if (section.includes("Same renderer; projection is the only variable.") || section.includes("supports a 2D-vs-3D statement.")) {
    throw new Error("CAP-14 renderer comparison is labelled as a projection or 2D-vs-3D result");
  }
}

function assertDimensionsCarryCaveat(document: string, claims: readonly ComparisonClaim[], caveat: string): void {
  for (const claim of claims) {
    const contrast = contrastSection(document, claim);
    const dimension = sectionFromHeading(contrast, `#### ${claim.dimension}`, /^#### /mu);
    if (dimension === null || !dimension.includes(`- Caveat: \`${caveat}\``)) {
      throw new Error(`CAP-14 dimension ${claim.kind} ${claim.dimension} has no caveat ${caveat}`);
    }
  }
}

function assertNotComparableReasons(document: string, claims: readonly ComparisonClaim[]): void {
  for (const claim of claims.filter((candidate) => candidate.outcome === "NOT_COMPARABLE" || candidate.outcome === "NOT_RUN")) {
    const contrast = contrastSection(document, claim);
    const dimension = sectionFromHeading(contrast, `#### ${claim.dimension}`, /^#### /mu);
    const reason = redactTimingLiterals(claim.reason);
    if (dimension === null || !dimension.includes(`Reason (instrument wording): ${reason}`)) {
      throw new Error(`CAP-14 report omits the instrument reason for ${claim.kind} ${claim.dimension}`);
    }
  }
}

function assertDimensionArtifactPointers(document: string, claims: readonly ComparisonClaim[]): void {
  for (const claim of claims) {
    const contrast = contrastSection(document, claim);
    const dimension = sectionFromHeading(contrast, `#### ${claim.dimension}`, /^#### /mu);
    if (dimension === null) {
      throw new Error(`CAP-14 report has no artifact pointer for ${claim.kind} ${claim.dimension}`);
    }
    const expected = [
      `- Outcome artifact: \`${COMPARISON_PATH}\`; regenerate: \`npm --prefix ui run evidence:comparison\`; key: \`${comparisonKey(claim)}\`.`,
      `- Value artifact: \`${PERFORMANCE_PATH}\`; regenerate: \`npm --prefix ui run test:performance\`; keys:`,
      ...claim.scales.map((scale) => `  - \`${performanceValueKey(scale.first, claim.dimension)}\`; \`${performanceValueKey(scale.second, claim.dimension)}\`.`),
    ];
    if (!expected.every((pointer) => dimension.includes(pointer))) {
      throw new Error(`CAP-14 report has no complete artifact pointer for ${claim.kind} ${claim.dimension}`);
    }
  }
}

function comparisonKey(claim: ComparisonClaim): string {
  return [
    `comparisons[kind=${claim.kind}]`,
    `[arms.first=${claim.arms.first}]`,
    `[arms.second=${claim.arms.second}]`,
    `[dimension=${claim.dimension}]`,
  ].join("");
}

function performanceValueKey(configuration: SourceConfigurationClaim, dimension: string): string {
  return `records[renderer=${configuration.arm}][scale=${configuration.scale}].measurements[${dimension}]`;
}

function assertIdenticalBytes(first: string, second: string, subject: string): void {
  if (first !== second) {
    throw new Error(`CAP-14 report is not byte-stable for ${subject}`);
  }
}

function withDifferentMedians(analysis: ComparisonAnalysis): ComparisonAnalysis {
  return changeMedians(analysis) as ComparisonAnalysis;
}

function changeMedians(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => changeMedians(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "medianMs" && typeof entry === "number" ? entry + 1 : changeMedians(entry),
  ]));
}

function medianValues(value: unknown): readonly number[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => medianValues(entry));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.medianMs === "number" ? [record.medianMs] : []),
    ...Object.values(record).flatMap((entry) => medianValues(entry)),
  ];
}

function withDifferentMeasurementValues(source: PerformanceResult): PerformanceResult {
  return changeMeasurementValues(source, false) as PerformanceResult;
}

function changeMeasurementValues(value: unknown, insideMeasurements: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => changeMeasurementValues(entry, insideMeasurements));
  }
  if (typeof value === "number") {
    return insideMeasurements ? value + 1 : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    changeMeasurementValues(entry, insideMeasurements || key === "measurements"),
  ]));
}

type FixtureCounts = { readonly nodes: number | "NOT_RUN"; readonly edges: number | "NOT_RUN" };

function assertDocumentScaleCounts(document: string, counts: ReadonlyMap<string, FixtureCounts>): void {
  const stated = [...document.matchAll(/`(10\^[234])` \(([^)]*)\)/gu)];
  if (stated.length === 0) {
    throw new Error("CAP-14 report states no scale fixture counts");
  }
  const seen = new Set<string>();
  for (const statement of stated) {
    const scale = statement[1];
    const actual = statement[2];
    if (scale === undefined) {
      throw new Error("CAP-14 report states a scale without its label");
    }
    const expected = counts.get(scale);
    if (expected === undefined || actual !== formatCounts(expected)) {
      throw new Error(`CAP-14 report fixture counts differ at ${String(scale)}: stated ${String(actual)}`);
    }
    seen.add(scale);
  }
  for (const scale of counts.keys()) {
    if (!seen.has(scale)) {
      throw new Error(`CAP-14 report omits fixture counts for ${scale}`);
    }
  }
}

function fixtureCountsByScale(records: readonly PerformanceRecordClaim[]): ReadonlyMap<string, FixtureCounts> {
  const counts = new Map<string, FixtureCounts>();
  for (const record of records) {
    const candidate = { nodes: record.elementCounts.fixtureNodes, edges: record.elementCounts.fixtureEdges };
    const existing = counts.get(record.scale);
    if (existing !== undefined && (existing.nodes !== candidate.nodes || existing.edges !== candidate.edges)) {
      throw new Error(`performance artifact disagrees about fixture counts at ${record.scale}`);
    }
    counts.set(record.scale, candidate);
  }
  return counts;
}

function formatCounts(counts: FixtureCounts): string {
  return counts.nodes === "NOT_RUN" || counts.edges === "NOT_RUN"
    ? `nodes ${String(counts.nodes)} and edges ${String(counts.edges)}`
    : `${String(counts.nodes)} nodes and ${String(counts.edges)} edges`;
}

function contrastSection(document: string, claim: ComparisonClaim): string {
  const label = claim.kind === "projection" ? "Projection contrast" : "Renderer comparison";
  const heading = `### ${label} — ${claim.arms.first} vs ${claim.arms.second}`;
  const section = sectionFromHeading(document, heading, /^### /mu);
  if (section === null) {
    throw new Error(`CAP-14 report has no ${label} for ${claim.arms.first} vs ${claim.arms.second}`);
  }
  return section;
}

function sectionFromHeading(document: string, heading: string, nextHeading: RegExp): string | null {
  const start = document.indexOf(heading);
  if (start < 0) {
    return null;
  }
  const content = document.slice(start);
  const remaining = content.slice(heading.length);
  const next = remaining.search(nextHeading);
  return next < 0 ? content : content.slice(0, heading.length + next);
}

function comparisonClaims(value: unknown): readonly ComparisonClaim[] {
  const comparisons = requiredArray(requiredRecord(value, "comparison artifact").comparisons, "comparison artifact comparisons");
  return comparisons.map((candidate, index) => {
    const record = requiredRecord(candidate, `comparison ${index}`);
    const arms = requiredRecord(record.arms, `comparison ${index} arms`);
    const kind = record.kind;
    const scales = requiredArray(record.scales, `comparison ${index} scales`).map((scaleCandidate, scaleIndex) => {
      const scale = requiredRecord(scaleCandidate, `comparison ${index} scale ${scaleIndex}`);
      const first = requiredRecord(requiredRecord(scale.first, `comparison ${index} scale ${scaleIndex} first`).provenance, `comparison ${index} scale ${scaleIndex} first provenance`);
      const second = requiredRecord(requiredRecord(scale.second, `comparison ${index} scale ${scaleIndex} second`).provenance, `comparison ${index} scale ${scaleIndex} second provenance`);
      const firstConfiguration = requiredRecord(first.configuration, `comparison ${index} scale ${scaleIndex} first configuration`);
      const secondConfiguration = requiredRecord(second.configuration, `comparison ${index} scale ${scaleIndex} second configuration`);
      if (typeof scale.scale !== "string" || !isSourceConfiguration(firstConfiguration) || !isSourceConfiguration(secondConfiguration)) {
        throw new Error(`comparison ${index} scale ${scaleIndex} has no consumer-readable provenance`);
      }
      return { scale: scale.scale, first: firstConfiguration, second: secondConfiguration };
    });
    if ((kind !== "projection" && kind !== "renderer") || typeof record.dimension !== "string" || typeof record.outcome !== "string" || typeof record.reason !== "string"
      || typeof arms.first !== "string" || typeof arms.second !== "string") {
      throw new Error(`comparison ${index} has no consumer-readable identity`);
    }
    return { kind, dimension: record.dimension, outcome: record.outcome, reason: record.reason, arms: { first: arms.first, second: arms.second }, scales };
  });
}

function isSourceConfiguration(value: Record<string, unknown>): value is SourceConfigurationClaim {
  return typeof value.arm === "string" && typeof value.scale === "string" && (typeof value.fixture === "string" || value.fixture === null);
}

function performanceClaim(value: unknown): PerformanceClaim {
  const root = requiredRecord(value, "performance artifact");
  const records = requiredArray(root.records, "performance artifact records").map((candidate, index) => {
    const record = requiredRecord(candidate, `performance record ${index}`);
    const elementCounts = requiredRecord(record.elementCounts, `performance record ${index} counts`);
    if (typeof record.renderer !== "string" || typeof record.scale !== "string"
      || !isCount(elementCounts.fixtureNodes) || !isCount(elementCounts.fixtureEdges)) {
      throw new Error(`performance record ${index} has no consumer-readable fixture counts`);
    }
    return {
      renderer: record.renderer,
      scale: record.scale,
      elementCounts: { fixtureNodes: elementCounts.fixtureNodes, fixtureEdges: elementCounts.fixtureEdges },
    };
  });
  if (typeof root.rasterisationLabel !== "string") {
    throw new Error("performance artifact has no rasterisation caveat");
  }
  return { rasterisationLabel: root.rasterisationLabel, records };
}

function isCount(value: unknown): value is number | "NOT_RUN" {
  return typeof value === "number" || value === "NOT_RUN";
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is absent or unreadable; CAP-14 document checks require its source artifact. ${detail}`);
  }
}
