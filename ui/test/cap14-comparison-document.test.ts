import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * `docs/CAP-14-COMPARISON.md` is an artifact consumer, not prose that happens
 * to mention evidence. Each check below reads the report against its producing
 * artifacts and carries a control that proves the check turns red when its
 * claim is violated.
 */

const DOCUMENT_PATH = ["..", "docs", "CAP-14-COMPARISON.md"].join("/");
const COMPARISON_PATH = ["dist", "evidence", "comparison.json"].join("/");
const PERFORMANCE_PATH = ["dist", "evidence", "performance.json"].join("/");

/** Any numeric figure carrying a time unit, matching the established document-consumer rule. */
const TIMING_FIGURE = /\b\d[\d,.]*\s*(?:ms|s|milliseconds?|seconds?)\b/giu;

type ComparisonClaim = {
  readonly kind: "projection" | "renderer";
  readonly dimension: string;
  readonly outcome: string;
  readonly arms: { readonly first: string; readonly second: string };
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

test("the CAP-14 report contains only timing figures derived from its artifacts", async () => {
  const [document, comparison, performance] = await Promise.all([
    readFile(DOCUMENT_PATH, "utf8"),
    readJson(COMPARISON_PATH),
    readJson(PERFORMANCE_PATH),
  ]);
  assertNoHandTranscribedTimingFigures(document, timingFiguresDerivedFrom(comparison, performance));

  // A stale timing in prose must fail even when every other report claim remains intact.
  assert.throws(
    () => assertNoHandTranscribedTimingFigures("Median: 440 ms", new Set()),
    /transcribes a timing figure/,
  );
});

test("the CAP-14 report carries every comparison dimension and its artifact outcome", async () => {
  const [document, comparison] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(COMPARISON_PATH)]);
  assertDimensionOutcomes(document, comparisonClaims(comparison));

  const claim: ComparisonClaim = {
    kind: "projection",
    dimension: "frameTime",
    outcome: "NOT_COMPARABLE",
    arms: { first: "r3f-2d", second: "r3f-3d" },
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
      { kind: "renderer", dimension: "frameTime", outcome: "NOT_COMPARABLE", arms: { first: "sigma-2d", second: "r3f-2d" } },
    ),
    /renderer comparison/,
  );
});

test("every CAP-14 figure carries the artifact caveat", async () => {
  const [document, performance] = await Promise.all([readFile(DOCUMENT_PATH, "utf8"), readJson(PERFORMANCE_PATH)]);
  assertFiguresCarryCaveat(document, performanceClaim(performance).rasterisationLabel);

  assert.throws(
    () => assertFiguresCarryCaveat("###### Evidence figure — r3f-2d\n\n- Median: `8 ms`\n", "software-rasterised — not GPU performance"),
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

function assertNoHandTranscribedTimingFigures(document: string, derivedFigures: ReadonlySet<string>): void {
  const found = [...document.matchAll(TIMING_FIGURE)].map((match) => match[0].trim());
  const transcribed = found.filter((figure) => !derivedFigures.has(figure));
  if (transcribed.length > 0) {
    throw new Error(
      `docs/CAP-14-COMPARISON.md transcribes a timing figure (${transcribed.join(", ")}) that neither artifact derives.`,
    );
  }
}

function timingFiguresDerivedFrom(...artifacts: readonly unknown[]): ReadonlySet<string> {
  const figures = new Set<string>();
  for (const artifact of artifacts) {
    const serialized = JSON.stringify(artifact);
    for (const match of serialized.matchAll(TIMING_FIGURE)) {
      figures.add(match[0].trim());
    }
    collectMedianFigures(artifact, figures);
  }
  return figures;
}

function collectMedianFigures(value: unknown, figures: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMedianFigures(entry, figures));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.medianMs === "number") {
    figures.add(`${String(record.medianMs)} ms`);
  }
  Object.values(record).forEach((entry) => collectMedianFigures(entry, figures));
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

function assertFiguresCarryCaveat(document: string, caveat: string): void {
  const headings = [...document.matchAll(/^###### .+$/gmu)];
  let figureCount = 0;
  for (const [index, figure] of headings.entries()) {
    if (!/^###### (?:Evidence|Comparison) figure — /u.test(figure[0])) {
      continue;
    }
    figureCount += 1;
    const start = figure.index ?? 0;
    const next = headings[index + 1]?.index ?? document.length;
    const block = document.slice(start, next);
    if (!block.includes(`- Caveat: \`${caveat}\``)) {
      throw new Error(`CAP-14 figure ${figure[0]} has no caveat ${caveat}`);
    }
  }
  if (figureCount === 0) {
    throw new Error("CAP-14 report records no figures to consume");
  }
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
    if ((kind !== "projection" && kind !== "renderer") || typeof record.dimension !== "string" || typeof record.outcome !== "string"
      || typeof arms.first !== "string" || typeof arms.second !== "string") {
      throw new Error(`comparison ${index} has no consumer-readable identity`);
    }
    return { kind, dimension: record.dimension, outcome: record.outcome, arms: { first: arms.first, second: arms.second } };
  });
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
