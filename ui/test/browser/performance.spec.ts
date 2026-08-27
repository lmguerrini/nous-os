import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  assertTrackedTreeIdentity,
  TRACKED_TREE_IDENTITY_ALGORITHM,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
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
const execFileAsync = promisify(execFile);

type TreeBoundPerformanceRecord = PerformanceRecord & {
  readonly observedTrackedTreeSha256: string;
};

type TreeBoundPerformanceResult = Omit<PerformanceResult, "records"> & {
  readonly run: {
    readonly trackedTree: TrackedTreeIdentity;
    readonly staleTreeControlOutput: string;
  };
  readonly records: readonly TreeBoundPerformanceRecord[];
};

declare global {
  interface Window {
    __performance?: {
      readonly run: (combination: PerformanceCombination, observedCommitSha: string) => Promise<PerformanceRecord>;
    };
  }
}

let bundledPerformancePage: Promise<string> | undefined;
let observedTrackedTreeSha256: string | undefined;

/** The opt-in run removes its prior artifact before its first independent combination starts. */
test.beforeAll(async () => {
  observedTrackedTreeSha256 = await currentTrackedTreeSha256();
  if (PERFORMANCE_ENABLED) {
    await rm(OUTPUT_FILE, { force: true });
  }
});

for (const combination of PERFORMANCE_COMBINATIONS) {
  test(`CAP-13 renderer performance ${combination.renderer} ${combination.scale}`, async ({ page }) => {
    test.skip(!PERFORMANCE_ENABLED, "set PERFORMANCE_SUITE=1 to run the performance suite");
    test.setTimeout(COMBINATION_BUDGET_MS + RECORDING_GRACE_MS);

    const observedCommitSha = await readObservedCommitSha();
    const trackedTreeSha256 = requiredTrackedTreeSha256();
    let baseRecord: PerformanceRecord;
    try {
      baseRecord = await runCombinationWithinBudget(page, combination, observedCommitSha);
    } catch (error: unknown) {
      baseRecord = notRunPerformanceRecord(
        combination,
        observedCommitSha,
        1,
        `performance attempt for ${combination.renderer} at ${combination.scale} did not start or complete: ${errorMessage(error)}`,
      );
    }
    const record: TreeBoundPerformanceRecord = { ...baseRecord, observedTrackedTreeSha256: trackedTreeSha256 };

    const result = await writeCompletedRecord(record, observedCommitSha, trackedTreeSha256);
    assertRecord(record, combination, observedCommitSha, trackedTreeSha256);
    await assertRunVerdict(result, trackedTreeSha256);
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

async function writeCompletedRecord(
  record: TreeBoundPerformanceRecord,
  observedCommitSha: string,
  measuredTreeSha256: string,
): Promise<TreeBoundPerformanceResult> {
  await mkdir(["dist", "evidence"].join("/"), { recursive: true });
  const previous = await readCurrentResult();
  const records = [...(previous?.records ?? [])]
    .filter((candidate) => combinationKey(candidate) !== combinationKey(record))
    .concat(record)
    .sort((left, right) => combinationIndex(left) - combinationIndex(right));
  const base = performanceResult(records, observedCommitSha);
  const completedTreeSha256 = await currentTrackedTreeSha256();
  const trackedTree: TrackedTreeIdentity = {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256: measuredTreeSha256,
    completedSha256: completedTreeSha256,
    stable: measuredTreeSha256 === completedTreeSha256,
  };
  const bound = trackedTree.stable
    && base.records.length === PERFORMANCE_COMBINATIONS.length
    && base.records.every((candidate) => (candidate as TreeBoundPerformanceRecord).observedTrackedTreeSha256 === measuredTreeSha256)
    && new Set(base.records.map(combinationKey)).size === PERFORMANCE_COMBINATIONS.length;
  const result: TreeBoundPerformanceResult = {
    ...base,
    summary: {
      ...base.summary,
      bound,
      passing: bound && base.summary.notRun === 0 && base.summary.unknown === 0 && base.summary.passed === base.summary.required,
      rule: "The performance run passes only when every recorded measurement criterion is bound to one stable tracked tree and PASS; NOT_RUN and UNKNOWN retain their reasons and make the run verdict false.",
    },
    records: base.records as readonly TreeBoundPerformanceRecord[],
    run: {
      trackedTree,
      staleTreeControlOutput: failedControlOutput(() => assertTrackedTreeIdentity({
        algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
        measuredSha256: "0".repeat(64),
        completedSha256: "0".repeat(64),
        stable: true,
      }, measuredTreeSha256, "performance stale tracked-tree control")),
    },
  };
  await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function readCurrentResult(): Promise<TreeBoundPerformanceResult | null> {
  try {
    return JSON.parse(await readFile(OUTPUT_FILE, "utf8")) as TreeBoundPerformanceResult;
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

function assertRecord(
  record: TreeBoundPerformanceRecord,
  combination: PerformanceCombination,
  observedCommitSha: string,
  observedTreeSha256: string,
): void {
  expect(record.renderer).toBe(combination.renderer);
  expect(record.scale).toBe(combination.scale);
  expect(record.fixture).toBe(combination.fixture);
  expect(record.observedCommitSha).toBe(observedCommitSha);
  expect(record.observedTrackedTreeSha256).toBe(observedTreeSha256);
  expect(record.rasterisationLabel).toBe(SOFTWARE_RASTERISATION_LABEL);
  expect(record.warmup.framesExcluded).toBeGreaterThan(0);
  for (const measurementName of PERFORMANCE_MEASUREMENTS) {
    expect(record.measurements[measurementName].label).toBe(SOFTWARE_RASTERISATION_LABEL);
  }
}

async function assertRunVerdict(result: TreeBoundPerformanceResult, observedTreeSha256: string): Promise<void> {
  const expectedBound = result.records.length === PERFORMANCE_COMBINATIONS.length
    && result.records.every((record) => record.observedCommitSha === result.observedCommitSha)
    && result.records.every((record) => record.observedTrackedTreeSha256 === observedTreeSha256)
    && new Set(result.records.map(combinationKey)).size === PERFORMANCE_COMBINATIONS.length;
  const treeBound = expectedBound && result.run.trackedTree.stable;
  const expectedPassing = treeBound
    && result.summary.notRun === 0
    && result.summary.unknown === 0
    && result.summary.passed === result.summary.required;
  expect(result.summary.bound).toBe(treeBound);
  expect(result.summary.passing).toBe(expectedPassing);
  assertTrackedTreeIdentity(result.run.trackedTree, await currentTrackedTreeSha256(), "performance evidence");
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

function requiredTrackedTreeSha256(): string {
  if (observedTrackedTreeSha256 === undefined) {
    throw new Error("performance run has no observed tracked-tree identity");
  }
  return observedTrackedTreeSha256;
}

async function currentTrackedTreeSha256(): Promise<string> {
  const repositoryDirectory = [".."].join("/");
  const { stdout } = await execFileAsync("git", ["ls-files", "-s"], { cwd: repositoryDirectory, encoding: "utf8" });
  return createHash("sha256").update(stdout).digest("hex");
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("performance tracked-tree control unexpectedly passed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
