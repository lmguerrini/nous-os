import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { toVisualGraph } from "#adapter/projection.ts";
import {
  assertTrackedTreeIdentity,
  TRACKED_TREE_IDENTITY_ALGORITHM,
  TRACKED_TREE_STATUS_COMMAND,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import {
  assertPerformancePlacementDigestAgreement,
  performancePlacement,
} from "#browser/performance-placement.ts";
import type { ResolvedPerformancePlacement } from "#browser/performance-placement.ts";
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

type TrackedTreeState = {
  readonly sha256: string;
  readonly statusPorcelain: string;
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
let observedTrackedTree: TrackedTreeState | undefined;

/** The opt-in run removes its prior artifact before its first independent combination starts. */
test.beforeAll(async () => {
  observedTrackedTree = await currentTrackedTreeState();
  if (PERFORMANCE_ENABLED) {
    await rm(OUTPUT_FILE, { force: true });
  }
});

for (const combination of PERFORMANCE_COMBINATIONS) {
  test(`CAP-13 renderer performance ${combination.renderer} ${combination.scale}`, async ({ page }) => {
    test.skip(!PERFORMANCE_ENABLED, "set PERFORMANCE_SUITE=1 to run the performance suite");
    test.setTimeout(COMBINATION_BUDGET_MS + RECORDING_GRACE_MS);

    const observedCommitSha = await readObservedCommitSha();
    const measuredTree = requiredTrackedTreeState();
    const trackedTreeSha256 = measuredTree.sha256;
    const placement = await placementForCombination(combination);
    let baseRecord: PerformanceRecord;
    try {
      baseRecord = await runCombinationWithinBudget(page, combination, observedCommitSha, placement);
    } catch (error: unknown) {
      baseRecord = notRunPerformanceRecord(
        combination,
        observedCommitSha,
        1,
        `performance attempt for ${combination.renderer} at ${combination.scale} did not start or complete: ${errorMessage(error)}`,
        placement.artifact,
      );
    }
    const record: TreeBoundPerformanceRecord = { ...baseRecord, observedTrackedTreeSha256: trackedTreeSha256 };

    const result = await writeCompletedRecord(record, observedCommitSha, measuredTree);
    assertRecord(record, combination, observedCommitSha, trackedTreeSha256, placement);
    await assertRunVerdict(result, measuredTree);
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
  placement: ResolvedPerformancePlacement,
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
      placement.artifact,
    );
  }
  return notRunPerformanceRecord(
    combination,
    observedCommitSha,
    devicePixelRatio,
    `performance attempt for ${combination.renderer} at ${combination.scale} failed before producing a record: ${outcome.reason}`,
    placement.artifact,
  );
}

async function writeCompletedRecord(
  record: TreeBoundPerformanceRecord,
  observedCommitSha: string,
  measuredTree: TrackedTreeState,
): Promise<TreeBoundPerformanceResult> {
  await mkdir(["dist", "evidence"].join("/"), { recursive: true });
  const previous = await readCurrentResult();
  const records = [...(previous?.records ?? [])]
    .filter((candidate) => combinationKey(candidate) !== combinationKey(record))
    .concat(record)
    .sort((left, right) => combinationIndex(left) - combinationIndex(right));
  assertPerformancePlacementDigestAgreement(records);
  const base = performanceResult(records, observedCommitSha);
  const completedTree = await currentTrackedTreeState();
  const trackedTree: TrackedTreeIdentity = {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256: measuredTree.sha256,
    completedSha256: completedTree.sha256,
    measuredStatusPorcelain: measuredTree.statusPorcelain,
    completedStatusPorcelain: completedTree.statusPorcelain,
    stable: measuredTree.sha256 === completedTree.sha256
      && measuredTree.statusPorcelain === completedTree.statusPorcelain,
  };
  const bound = trackedTree.stable
    && trackedTree.measuredStatusPorcelain === ""
    && trackedTree.completedStatusPorcelain === ""
    && base.records.length === PERFORMANCE_COMBINATIONS.length
    && base.records.every((candidate) => (candidate as TreeBoundPerformanceRecord).observedTrackedTreeSha256 === measuredTree.sha256)
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
        measuredStatusPorcelain: "",
        completedStatusPorcelain: "",
        stable: true,
      }, measuredTree.sha256, "performance stale tracked-tree control", measuredTree.statusPorcelain)),
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
  placement: ResolvedPerformancePlacement,
): void {
  expect(record.renderer).toBe(combination.renderer);
  expect(record.scale).toBe(combination.scale);
  expect(record.fixture).toBe(combination.fixture);
  expect(record.observedCommitSha).toBe(observedCommitSha);
  expect(record.observedTrackedTreeSha256).toBe(observedTreeSha256);
  expect(record.rasterisationLabel).toBe(SOFTWARE_RASTERISATION_LABEL);
  expect(record.placement).toEqual(placement.artifact);
  expect(record.warmup.framesExcluded).toBeGreaterThan(0);
  for (const measurementName of PERFORMANCE_MEASUREMENTS) {
    expect(record.measurements[measurementName].label).toBe(SOFTWARE_RASTERISATION_LABEL);
  }
}

async function placementForCombination(combination: PerformanceCombination): Promise<ResolvedPerformancePlacement> {
  const fixturePath = ["..", "fixtures", "synthetic", "projection", "stress", combination.fixture].join("/");
  return performancePlacement(toVisualGraph(JSON.parse(await readFile(fixturePath, "utf8")) as unknown), combination.scale);
}

async function assertRunVerdict(result: TreeBoundPerformanceResult, observedTree: TrackedTreeState): Promise<void> {
  const expectedBound = result.records.length === PERFORMANCE_COMBINATIONS.length
    && result.records.every((record) => record.observedCommitSha === result.observedCommitSha)
    && result.records.every((record) => record.observedTrackedTreeSha256 === observedTree.sha256)
    && new Set(result.records.map(combinationKey)).size === PERFORMANCE_COMBINATIONS.length;
  const treeBound = expectedBound
    && result.run.trackedTree.stable
    && result.run.trackedTree.measuredStatusPorcelain === ""
    && result.run.trackedTree.completedStatusPorcelain === "";
  const expectedPassing = treeBound
    && result.summary.notRun === 0
    && result.summary.unknown === 0
    && result.summary.passed === result.summary.required;
  expect(result.summary.bound).toBe(treeBound);
  expect(result.summary.passing).toBe(expectedPassing);
  const currentTree = await currentTrackedTreeState();
  assertTrackedTreeIdentity(result.run.trackedTree, currentTree.sha256, "performance evidence", currentTree.statusPorcelain);
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

function requiredTrackedTreeState(): TrackedTreeState {
  if (observedTrackedTree === undefined) {
    throw new Error("performance run has no observed tracked-tree identity");
  }
  return observedTrackedTree;
}

async function currentTrackedTreeState(): Promise<TrackedTreeState> {
  const repositoryDirectory = [".."].join("/");
  const [{ stdout: trackedPaths }, { stdout: statusPorcelain }] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], { cwd: repositoryDirectory, encoding: "utf8" }),
    execFileAsync("git", trackedTreeStatusArguments(), { cwd: repositoryDirectory, encoding: "utf8" }),
  ]);
  const hash = createHash("sha256");
  for (const path of trackedPaths.split("\0")) {
    if (path === "") {
      continue;
    }
    const pathBytes = Buffer.from(path, "utf8");
    const contents = await readFile(`${repositoryDirectory}/${path}`);
    hash.update(uint64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64be(contents.length));
    hash.update(contents);
  }
  return { sha256: hash.digest("hex"), statusPorcelain };
}

function uint64be(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
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

/**
 * `TRACKED_TREE_STATUS_COMMAND` names the whole command, program included. Splitting it straight
 * into an argument list re-passes `git` as git's own first argument, which fails with
 * `git: 'git' is not a git command` — so the status reading threw, and with it the tree identity
 * this artifact is bound by. It went unnoticed because no evidence had been regenerated since the
 * identity was rewritten. The program name is dropped here, once, and asserted.
 */
function trackedTreeStatusArguments(): readonly string[] {
  const [program, ...args] = TRACKED_TREE_STATUS_COMMAND.split(" ");
  if (program !== "git" || args.length === 0) {
    throw new Error(`tracked-tree status command is not a git invocation: ${TRACKED_TREE_STATUS_COMMAND}`);
  }
  return args;
}
