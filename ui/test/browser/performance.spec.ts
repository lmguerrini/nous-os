import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  PERFORMANCE_COMBINATIONS,
  PERFORMANCE_MEASUREMENTS,
  SOFTWARE_RASTERISATION_LABEL,
  combinationKey,
  notRunPerformanceRecord,
  performanceResult,
  type PerformanceCombination,
  type PerformanceRecord,
  type PerformanceResult,
} from "#browser/performance-contract.ts";

const PERFORMANCE_ENABLED = process.env.PERFORMANCE_SUITE === "1";
const OUTPUT_FILE = ["dist", "evidence", "performance.json"].join("/");
const COMBINATION_BUDGET_MS = 120_000;
const RECORDING_GRACE_MS = 15_000;

declare global {
  interface Window {
    __performance?: {
      readonly run: (combination: PerformanceCombination, observedCommitSha: string) => Promise<PerformanceRecord>;
    };
  }
}

let bundledPerformancePage: Promise<string> | undefined;

/** The opt-in run removes its prior artifact before its first independent combination starts. */
test.beforeAll(async () => {
  if (PERFORMANCE_ENABLED) {
    await rm(OUTPUT_FILE, { force: true });
  }
});

for (const combination of PERFORMANCE_COMBINATIONS) {
  test(`CAP-13 renderer performance ${combination.renderer} ${combination.scale}`, async ({ page }) => {
    test.skip(!PERFORMANCE_ENABLED, "set PERFORMANCE_SUITE=1 to run the performance suite");
    test.setTimeout(COMBINATION_BUDGET_MS + RECORDING_GRACE_MS);

    const observedCommitSha = await readObservedCommitSha();
    let record: PerformanceRecord;
    try {
      record = await runCombinationWithinBudget(page, combination, observedCommitSha);
    } catch (error: unknown) {
      record = notRunPerformanceRecord(
        combination,
        observedCommitSha,
        1,
        `performance attempt for ${combination.renderer} at ${combination.scale} did not start or complete: ${errorMessage(error)}`,
      );
    }

    const result = await writeCompletedRecord(record, observedCommitSha);
    assertRecord(record, combination, observedCommitSha);
    assertRunVerdict(result);
  });
}

async function performancePageSource(): Promise<string> {
  bundledPerformancePage ??= build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: ["test/browser/performance.ts"],
  }).then((bundled) => {
    const output = bundled.outputFiles[0];
    if (output === undefined) {
      throw new Error("performance page module did not bundle");
    }
    return output.text;
  });
  return bundledPerformancePage;
}

async function runCombinationWithinBudget(
  page: Page,
  combination: PerformanceCombination,
  observedCommitSha: string,
): Promise<PerformanceRecord> {
  let devicePixelRatio = 1;
  const attempt = (async () => {
    const source = await performancePageSource();
    await page.goto("/");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: source });
    devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    return page.evaluate(
      ({ runCombination, commitSha }) => {
        const api = window.__performance;
        if (api === undefined) {
          throw new Error("performance page module is unavailable");
        }
        return api.run(runCombination, commitSha);
      },
      { runCombination: combination, commitSha: observedCommitSha },
    );
  })().then(
    (record) => ({ kind: "completed" as const, record }),
    (error: unknown) => ({ kind: "failed" as const, reason: errorMessage(error) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "budget-exceeded" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "budget-exceeded" }), COMBINATION_BUDGET_MS);
  });
  const outcome = await Promise.race([attempt, deadline]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (outcome.kind === "completed") {
    return outcome.record;
  }
  if (outcome.kind === "budget-exceeded") {
    void page.close().catch(() => undefined);
    return notRunPerformanceRecord(
      combination,
      observedCommitSha,
      devicePixelRatio,
      `combination budget ${COMBINATION_BUDGET_MS}ms exceeded while attempting ${combination.renderer} at ${combination.scale}; the incomplete attempt was recorded as NOT_RUN`,
    );
  }
  return notRunPerformanceRecord(
    combination,
    observedCommitSha,
    devicePixelRatio,
    `performance attempt for ${combination.renderer} at ${combination.scale} failed before producing a record: ${outcome.reason}`,
  );
}

async function writeCompletedRecord(record: PerformanceRecord, observedCommitSha: string): Promise<PerformanceResult> {
  await mkdir(["dist", "evidence"].join("/"), { recursive: true });
  const previous = await readCurrentResult();
  const records = [...(previous?.records ?? [])]
    .filter((candidate) => combinationKey(candidate) !== combinationKey(record))
    .concat(record)
    .sort((left, right) => combinationIndex(left) - combinationIndex(right));
  const result = performanceResult(records, observedCommitSha);
  await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function readCurrentResult(): Promise<PerformanceResult | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_FILE, "utf8")) as PerformanceResult;
  } catch {
    return null;
  }
}

function combinationIndex(combination: Pick<PerformanceCombination, "renderer" | "scale">): number {
  const index = PERFORMANCE_COMBINATIONS.findIndex((expected) => combinationKey(expected) === combinationKey(combination));
  if (index === -1) {
    throw new Error(`unexpected renderer-by-scale combination ${combinationKey(combination)}`);
  }
  return index;
}

function assertRecord(record: PerformanceRecord, combination: PerformanceCombination, observedCommitSha: string): void {
  expect(record.renderer).toBe(combination.renderer);
  expect(record.scale).toBe(combination.scale);
  expect(record.fixture).toBe(combination.fixture);
  expect(record.observedCommitSha).toBe(observedCommitSha);
  expect(record.rasterisationLabel).toBe(SOFTWARE_RASTERISATION_LABEL);
  expect(record.warmup.framesExcluded).toBeGreaterThan(0);
  for (const measurementName of PERFORMANCE_MEASUREMENTS) {
    expect(record.measurements[measurementName].label).toBe(SOFTWARE_RASTERISATION_LABEL);
  }
}

function assertRunVerdict(result: PerformanceResult): void {
  const expectedBound = result.records.length === PERFORMANCE_COMBINATIONS.length
    && result.records.every((record) => record.observedCommitSha === result.observedCommitSha)
    && new Set(result.records.map(combinationKey)).size === PERFORMANCE_COMBINATIONS.length;
  const expectedPassing = expectedBound
    && result.summary.notRun === 0
    && result.summary.unknown === 0
    && result.summary.passed === result.summary.required;
  expect(result.summary.bound).toBe(expectedBound);
  expect(result.summary.passing).toBe(expectedPassing);
}

async function readObservedCommitSha(): Promise<string> {
  const gitDirectory = ["..", ".git"].join("/");
  const head = (await readFile(`${gitDirectory}/HEAD`, "utf8")).trim();
  let sha = head;
  if (head.startsWith("ref: ")) {
    const reference = head.slice(5);
    try {
      sha = (await readFile(`${gitDirectory}/${reference}`, "utf8")).trim();
    } catch {
      const packed = await readFile(`${gitDirectory}/packed-refs`, "utf8");
      const line = packed.split("\n").find((item) => item.endsWith(` ${reference}`));
      sha = line?.split(" ")[0] ?? "";
    }
  }
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error("performance run cannot determine the observed commit SHA");
  }
  return sha;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
