import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SOFTWARE_RASTERISATION_LABEL } from "#browser/performance-contract.ts";
import { promisify } from "node:util";
import {
  assertEvidenceArtifactCurrent,
  TRACKED_TREE_IDENTITY_ALGORITHM,
  TRACKED_TREE_STATUS_COMMAND,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import {
  PERFORMANCE_COMBINATIONS,
  PERFORMANCE_MEASUREMENTS,
} from "#browser/performance-contract.ts";

const execFileAsync = promisify(execFile);

type ParsedArtifact = {
  readonly summary: { readonly passing: boolean };
  readonly run: { readonly trackedTree: TrackedTreeIdentity };
};

/**
 * Every artifact must be revision-bound. Only some may additionally be required to PASS.
 *
 * The performance artifact reports `passing: false` at this revision and that is the GOVERNED TRUTH,
 * not a defect. Sixty of its measurements are NOT_RUN because a renderer-independent layout consumes
 * the budget before any renderer draws — but that accounts for the two large scales only, and NOT for
 * every unbound reading. A count and a single cause were stated here as though they covered all of
 * them, and an auditor found ten further unbound readings at the completing scale of four distinct
 * kinds, one of which was a renderer painting nothing. Each unbound measurement carries its OWN
 * reason and this comment does not summarise them. The capability's own criterion requires the
 * run-level verdict to be false while anything is unbound. Demanding it pass would force exactly two
 * outcomes, both forbidden — hiding the NOT_RUN states, or lowering the criterion. So it is held to
 * the binding requirement and to the rule that every unbound measurement carries its reason, which
 * is what makes `passing: false` an honest statement rather than an unexamined one. Its exception
 * also requires the complete renderer-by-scale matrix, the exact measurement set, known statuses,
 * and numeric PASS measurements at the completing scale.
 */
const ARTIFACTS = [
  { label: "parity evidence", path: ["dist", "evidence", "parity.json"].join("/"), mustPass: true },
  { label: "performance evidence", path: ["dist", "evidence", "performance.json"].join("/"), mustPass: false },
  // One manifest per device-pixel ratio; there is no top-level file and there never was. Both are
  // required, so a run that produced only one cannot certify. This path was wrong in TWO files and
  // the repair reached one of them first — the fourth time in this capability that a fix landed on
  // some of a duplicated thing's sites and not others.
  { label: "review3d manifest (dpr-1)", path: "dist/review3d/dpr-1/manifest.json", mustPass: true },
  { label: "review3d manifest (dpr-2)", path: "dist/review3d/dpr-2/manifest.json", mustPass: true },
] as const;

test("evidence artifacts are currently certifiable against the tracked tree", async () => {
  const hostileOutput = failedControlOutput(() => assertPerformanceExemption({
    records: [{ measurements: { frameTime: { status: "NOT_RUN", reason: "hostile artifact measured nothing" } } }],
  }, "performance hostile control"));
  assert.match(hostileOutput, /expected 9/);
  console.info(`performance hostile control: ${hostileOutput}`);

  const noSmallScalePassOutput = failedControlOutput(() => assertPerformanceExemption(
    performanceControlArtifact("NOT_RUN"),
    "performance no-small-scale-PASS control",
  ));
  assert.match(noSmallScalePassOutput, /completing scale requires PASS/);
  console.info(`performance no-small-scale-PASS control: ${noSmallScalePassOutput}`);

  const outsideVocabulary = performanceControlArtifact("PASS", "OUTSIDE_VOCABULARY");
  const outsideVocabularyOutput = failedControlOutput(() => assertPerformanceExemption(
    outsideVocabulary,
    "performance status-vocabulary control",
  ));
  assert.match(outsideVocabularyOutput, /outside PASS, NOT_RUN, UNKNOWN/);
  console.info(`performance status-vocabulary control: ${outsideVocabularyOutput}`);

  const currentTrackedTree = await trackedTreeState();
  const rejections: string[] = [];
  for (const artifact of ARTIFACTS) {
    try {
      if (!artifact.mustPass) {
        assertPerformanceExemption(
          JSON.parse(await readFile(artifact.path, "utf8")) as unknown,
          artifact.label,
        );
      }
      const parsed = await readArtifact(artifact.path, artifact.label);
      // A not-required-to-pass artifact is still held to its binding, and additionally to the rule
      // that nothing is unbound WITHOUT a recorded reason — otherwise "does not have to pass" would
      // become "is not checked", which is the shape this whole check exists to remove.
      assertEvidenceArtifactCurrent(
        artifact.mustPass ? parsed.summary.passing : true,
        parsed.run.trackedTree,
        currentTrackedTree.sha256,
        artifact.label,
        currentTrackedTree.statusPorcelain,
      );
    } catch (error: unknown) {
      rejections.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual(rejections, []);
});

const PERFORMANCE_STATUSES = new Set(["PASS", "NOT_RUN", "UNKNOWN"] as const);
const COMPLETING_SCALE = "10^2";
const REQUIRED_NUMERIC_PASSES = [
  "frameTime",
  "initialRenderLatency",
  "layoutCost",
  "sceneModelBuildCost",
  "pickingLatency",
] as const;

/** This permits governed shortfalls only inside the complete, measured performance matrix. */
function assertPerformanceExemption(raw: unknown, label: string): void {
  // The validator began at `records`, so the artifact-ROOT rasterisation label was never read and
  // could be changed to claim hardware acceleration on its own.
  if (isRecord(raw) && "rasterisationLabel" in raw && raw["rasterisationLabel"] !== SOFTWARE_RASTERISATION_LABEL) {
    throw new Error(
      `${label} artifact root is labelled ${String(raw["rasterisationLabel"])}, not ${SOFTWARE_RASTERISATION_LABEL}`,
    );
  }
  assertDerivedRunVerdict(raw, label);
  const records = isRecord(raw) && Array.isArray(raw["records"]) ? raw["records"] : [];
  if (records.length !== PERFORMANCE_COMBINATIONS.length) {
    throw new Error(
      `${label} has ${records.length} renderer-by-scale records; expected ${PERFORMANCE_COMBINATIONS.length}`,
    );
  }
  const expected = new Map(PERFORMANCE_COMBINATIONS.map((combination) => [
    `${combination.renderer}:${combination.scale}`,
    combination,
  ]));
  const seen = new Set<string>();
  let unbound = 0;
  for (const [recordIndex, candidate] of records.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`${label} record ${recordIndex} is not an object`);
    }
    const key = `${String(candidate["renderer"])}:${String(candidate["scale"])}`;
    const combination = expected.get(key);
    if (combination === undefined) {
      throw new Error(`${label} has unexpected renderer-by-scale record ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`${label} repeats renderer-by-scale record ${key}`);
    }
    seen.add(key);
    if (candidate["fixture"] !== combination.fixture) {
      throw new Error(`${label} ${key} names unexpected fixture ${String(candidate["fixture"])}`);
    }
    if (candidate["rasterisationLabel"] !== SOFTWARE_RASTERISATION_LABEL) {
      throw new Error(
        `${label} ${key} is labelled ${String(candidate["rasterisationLabel"])}, not ${SOFTWARE_RASTERISATION_LABEL}. `
        + "Every figure here is software-rasterised; a record that says otherwise is claiming a measurement nobody took.",
      );
    }
    const measurements = candidate["measurements"];
    if (!isRecord(measurements)) {
      throw new Error(`${label} ${key} has no measurement object`);
    }
    const actualNames = Object.keys(measurements);
    const missingNames = PERFORMANCE_MEASUREMENTS.filter((name) => !(name in measurements));
    const extraNames = actualNames.filter((name) => !(PERFORMANCE_MEASUREMENTS as readonly string[]).includes(name));
    if (missingNames.length > 0 || extraNames.length > 0) {
      throw new Error(
        `${label} ${key} measurement names differ; missing [${missingNames.join(", ")}], extra [${extraNames.join(", ")}]`,
      );
    }
    for (const name of PERFORMANCE_MEASUREMENTS) {
      const measurement = measurements[name];
      if (!isRecord(measurement)) {
        throw new Error(`${label} ${key} measurement ${name} is not an object`);
      }
      assertSoftwareRasterisationLabel(measurement, `${label} ${key} measurement ${name}`);
      unbound += assertKnownMeasurementStatuses(measurement, `${label} ${key} measurement ${name}`);
    }
    if (combination.scale === COMPLETING_SCALE) {
      for (const name of REQUIRED_NUMERIC_PASSES) {
        const measurement = measurements[name];
        if (!isRecord(measurement) || measurement["status"] !== "PASS") {
          throw new Error(
            `${label} ${key} measurement ${name} is ${String(isRecord(measurement) ? measurement["status"] : undefined)}; `
            + "completing scale requires PASS",
          );
        }
        if (!("value" in measurement) || !isNumericDistribution(measurement["value"])) {
          throw new Error(`${label} ${key} measurement ${name} PASS contains no finite non-empty distribution`);
        }
      }
    }
  }
  const missingRecords = [...expected.keys()].filter((key) => !seen.has(key));
  if (missingRecords.length > 0) {
    throw new Error(`${label} is missing renderer-by-scale records: ${missingRecords.join(", ")}`);
  }
  if (unbound === 0) {
    throw new Error(`${label} is declared not-required-to-pass but reports nothing unbound, so the exemption is unexamined`);
  }
}

function assertKnownMeasurementStatuses(value: unknown, path: string): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry, index) => count + assertKnownMeasurementStatuses(entry, `${path}[${index}]`), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  let unbound = 0;
  if ("status" in value) {
    const status = value["status"];
    if (typeof status !== "string" || !PERFORMANCE_STATUSES.has(status as "PASS" | "NOT_RUN" | "UNKNOWN")) {
      throw new Error(`${path} status ${String(status)} is outside PASS, NOT_RUN, UNKNOWN`);
    }
    if (status !== "PASS") {
      unbound += 1;
      if (typeof value["reason"] !== "string" || value["reason"].trim() === "") {
        throw new Error(`${path} is ${status} with no recorded reason`);
      }
    } else {
      // A nested PASS previously needed only the KEY `value` to exist. Every band inside
      // progressiveDisclosure, and every reading inside memory, could therefore have carried
      // `"value": null` and the artifact would still have been accepted as a complete measured
      // matrix. Only the five top-level distributions at the completing scale were ever checked for
      // content, and the tampering that matters does not have to happen at the top level.
      if (!("value" in value)) {
        throw new Error(`${path} PASS records no value`);
      }
      const measured = value["value"];
      if (measured === null || measured === undefined) {
        throw new Error(`${path} PASS records a null value, which is not a measurement`);
      }
      if (isRecord(measured) && "samplesMs" in measured && !isNumericDistribution(measured)) {
        throw new Error(`${path} PASS records a distribution with no finite non-empty samples`);
      }
      // No measurement in this artifact is a bare string. A count of ten was replaced with the words
      // "fabricated aggregate count" and passed, because only null was refused.
      if (typeof measured === "string") {
        throw new Error(`${path} PASS records the string ${JSON.stringify(measured)}, which is not a measurement`);
      }
    }
  }
  return Object.entries(value).reduce(
    (count, [name, entry]) => count + (name === "status" ? 0 : assertKnownMeasurementStatuses(entry, `${path}.${name}`)),
    unbound,
  );
}

function isNumericDistribution(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value["samplesMs"])
    && value["samplesMs"].length > 0
    && value["samplesMs"].every((sample) => typeof sample === "number" && Number.isFinite(sample))
    && typeof value["medianMs"] === "number"
    && Number.isFinite(value["medianMs"])
    && typeof value["p95Ms"] === "number"
    && Number.isFinite(value["p95Ms"]);
}

test("evidence artifact consumer rejects a stale recorded tree", async () => {
  const currentTrackedTree = await trackedTreeState();
  const output = failedControlOutput(() => assertEvidenceArtifactCurrent(true, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: "0".repeat(64),
      completedSha256: "0".repeat(64),
      measuredStatusPorcelain: "",
      completedStatusPorcelain: "",
      stable: true,
    }, currentTrackedTree.sha256, "stale identity control", currentTrackedTree.statusPorcelain));
  assert.match(output, /tracked-tree identity is stale/);
  console.info(`stale identity control: ${output}`);

  const controlPath = join([".."].join("/"), "ui", "test", "evidence-artifacts.test.ts");
  const original = await readFile(controlPath);
  const indexedBefore = await indexedTreeSha256();
  const worktreeBefore = await trackedTreeState();
  let identityOutput = "";
  let statusOutput = "";
  let indexedAfter = "";
  let worktreeAfter: Awaited<ReturnType<typeof trackedTreeState>> | undefined;
  await writeFile(controlPath, Buffer.concat([original, Buffer.from("\n/* unstaged identity control */\n")]));
  try {
    indexedAfter = await indexedTreeSha256();
    worktreeAfter = await trackedTreeState();
    assert.equal(indexedAfter, indexedBefore);
    assert.notEqual(worktreeAfter.sha256, worktreeBefore.sha256);
    identityOutput = failedControlOutput(() => assertEvidenceArtifactCurrent(true, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: worktreeBefore.sha256,
      completedSha256: worktreeBefore.sha256,
      measuredStatusPorcelain: "",
      completedStatusPorcelain: "",
      stable: true,
    }, worktreeAfter?.sha256 ?? "", "unstaged byte-identity control", worktreeAfter?.statusPorcelain));
    assert.match(identityOutput, /tracked-tree identity is stale/);
    statusOutput = failedControlOutput(() => assertEvidenceArtifactCurrent(true, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: worktreeAfter?.sha256 ?? "",
      completedSha256: worktreeAfter?.sha256 ?? "",
      measuredStatusPorcelain: "",
      completedStatusPorcelain: "",
      stable: true,
    }, worktreeAfter?.sha256 ?? "", "unstaged status control", worktreeAfter?.statusPorcelain));
    assert.match(statusOutput, /current worktree is dirty/);
  } finally {
    await writeFile(controlPath, original);
  }
  const restored = await trackedTreeState();
  assert.equal(restored.sha256, worktreeBefore.sha256);
  console.info(
    `unstaged tracked-file control: index ${indexedBefore} -> ${indexedAfter} (unchanged); `
    + `worktree bytes ${worktreeBefore.sha256} -> ${worktreeAfter?.sha256 ?? "not computed"} (changed); `
    + `byte refusal: ${identityOutput}; ${TRACKED_TREE_STATUS_COMMAND} refusal: ${statusOutput}`,
  );
});

test("evidence artifact consumer rejects a false run verdict", async () => {
  const currentTrackedTree = await trackedTreeState();
  const output = failedControlOutput(() => assertEvidenceArtifactCurrent(false, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: currentTrackedTree.sha256,
      completedSha256: currentTrackedTree.sha256,
      measuredStatusPorcelain: "",
      completedStatusPorcelain: "",
      stable: true,
    }, currentTrackedTree.sha256, "false verdict control", currentTrackedTree.statusPorcelain));
  assert.match(output, /run-level verdict is not passing/);
  console.info(`false verdict control: ${output}`);
});

async function readArtifact(path: string, label: string): Promise<ParsedArtifact> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.summary) || typeof parsed.summary.passing !== "boolean") {
    throw new Error(`${label} has no boolean run-level verdict`);
  }
  if (!isRecord(parsed.run) || !isRecord(parsed.run.trackedTree)) {
    throw new Error(`${label} has no tracked-tree identity`);
  }
  const tree = parsed.run.trackedTree;
  if (
    tree.algorithm !== TRACKED_TREE_IDENTITY_ALGORITHM
    || typeof tree.measuredSha256 !== "string"
    || typeof tree.completedSha256 !== "string"
    || typeof tree.measuredStatusPorcelain !== "string"
    || typeof tree.completedStatusPorcelain !== "string"
    || typeof tree.stable !== "boolean"
  ) {
    throw new Error(`${label} has an invalid tracked-tree identity`);
  }
  return {
    summary: { passing: parsed.summary.passing },
    run: {
      trackedTree: {
        algorithm: tree.algorithm,
        measuredSha256: tree.measuredSha256,
        completedSha256: tree.completedSha256,
        measuredStatusPorcelain: tree.measuredStatusPorcelain,
        completedStatusPorcelain: tree.completedStatusPorcelain,
        stable: tree.stable,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function trackedTreeState(): Promise<{ readonly sha256: string; readonly statusPorcelain: string }> {
  const repositoryDirectory = [".."].join("/");
  const [{ stdout: trackedPaths }, { stdout: statusPorcelain }] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], { cwd: repositoryDirectory, encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repositoryDirectory, encoding: "utf8" }),
  ]);
  const hash = createHash("sha256");
  for (const path of trackedPaths.split("\0")) {
    if (path === "") {
      continue;
    }
    const pathBytes = Buffer.from(path, "utf8");
    const contents = await readFile(join(repositoryDirectory, path));
    hash.update(uint64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64be(contents.length));
    hash.update(contents);
  }
  return { sha256: hash.digest("hex"), statusPorcelain };
}

async function indexedTreeSha256(): Promise<string> {
  const repositoryDirectory = [".."].join("/");
  const { stdout } = await execFileAsync("git", ["ls-files", "-s"], { cwd: repositoryDirectory, encoding: "utf8" });
  return createHash("sha256").update(stdout).digest("hex");
}

function uint64be(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function performanceControlArtifact(
  completingStatus: "PASS" | "NOT_RUN",
  firstStatusOverride?: string,
): unknown {
  return {
    records: PERFORMANCE_COMBINATIONS.map((combination, combinationIndex) => ({
      ...combination,
      // Controls carry the honest label, so each one fails for the reason it was written to test
      // rather than for a missing label — the shape of defect this whole file exists to refuse.
      rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
      measurements: Object.fromEntries(PERFORMANCE_MEASUREMENTS.map((name, measurementIndex) => {
        const status = combinationIndex === 0 && measurementIndex === 0 && firstStatusOverride !== undefined
          ? firstStatusOverride
          : combination.scale === COMPLETING_SCALE ? completingStatus : "NOT_RUN";
        return [name, status === "PASS"
          ? { status, label: SOFTWARE_RASTERISATION_LABEL, value: { samplesMs: [1], medianMs: 1, p95Ms: 1 } }
          : { status, label: SOFTWARE_RASTERISATION_LABEL, reason: "governed control shortfall" }];
      })),
    })),
  };
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("evidence artifact control unexpectedly passed");
}

test("the performance exemption refuses a nested PASS whose value is not a measurement", () => {
  // The five top-level distributions at the completing scale were checked for content. Nothing else
  // was — so every band inside progressiveDisclosure, and every reading inside memory, could have
  // carried an empty or null value and the artifact would still have read as a complete measured
  // matrix. Tampering does not have to happen where the checking is.
  const withNestedValue = (value: unknown): unknown => ({
    records: PERFORMANCE_COMBINATIONS.map((combination) => ({
      ...combination,
      rasterisationLabel: SOFTWARE_RASTERISATION_LABEL,
      measurements: Object.fromEntries(PERFORMANCE_MEASUREMENTS.map((name) => [
        name,
        combination.scale === COMPLETING_SCALE
          ? {
            status: "PASS",
            label: SOFTWARE_RASTERISATION_LABEL,
            value: { samplesMs: [1], medianMs: 1, p95Ms: 1 },
            bands: [{ mountToFirstPaint: { status: "PASS", label: SOFTWARE_RASTERISATION_LABEL, value } }],
          }
          : { status: "NOT_RUN", label: SOFTWARE_RASTERISATION_LABEL, reason: "governed control shortfall" },
      ])),
    })),
  });

  const nullValue = failedControlOutput(
    () => assertPerformanceExemption(withNestedValue(null), "nested null-value control"),
  );
  assert.match(nullValue, /PASS records a null value/);

  const emptyDistribution = failedControlOutput(
    () => assertPerformanceExemption(
      withNestedValue({ samplesMs: [], medianMs: 0, p95Ms: 0 }),
      "nested empty-distribution control",
    ),
  );
  assert.match(emptyDistribution, /distribution with no finite non-empty samples/);

  // And the untampered nested shape must still be accepted, or the rule is refusing everything.
  assert.doesNotThrow(() => assertPerformanceExemption(
    withNestedValue({ samplesMs: [12], medianMs: 12, p95Ms: 12 }),
    "nested intact control",
  ));
  console.info(`nested measurement tampering controls: ${nullValue} | ${emptyDistribution}`);
});

/**
 * Every label at every depth must be the software literal.
 *
 * The exemption validated statuses and never the labels, so an artifact whose every label said
 * "headed GPU performance" passed unchanged — the one claim in this evidence that must never drift,
 * because software rasterisation and GPU behaviour may not be pooled and the difference is invisible
 * once the label is wrong.
 */
function assertSoftwareRasterisationLabel(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertSoftwareRasterisationLabel(entry, `${path}[${index}]`); });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if ("label" in value && value["label"] !== SOFTWARE_RASTERISATION_LABEL) {
    throw new Error(`${path} is labelled ${String(value["label"])}, not ${SOFTWARE_RASTERISATION_LABEL}`);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (name !== "label") {
      assertSoftwareRasterisationLabel(entry, `${path}.${name}`);
    }
  }
}

test("the performance exemption refuses an artifact relabelled as GPU performance", () => {
  // An auditor changed every label in a copy of the artifact to claim hardware acceleration and the
  // suite stayed green: statuses were validated and labels never were. Software rasterisation and GPU
  // behaviour may not be pooled, and once the label is wrong the difference is invisible.
  const relabel = (artifact: unknown, label: string): unknown => JSON.parse(
    JSON.stringify(artifact).split(SOFTWARE_RASTERISATION_LABEL).join(label),
  ) as unknown;

  const topLevel = failedControlOutput(() => assertPerformanceExemption(
    relabel(performanceControlArtifact("PASS"), "headed GPU performance"),
    "performance relabelled control",
  ));
  assert.match(topLevel, /is labelled headed GPU performance, not software-rasterised/);

  // And the honest artifact must still be accepted, or the rule is refusing everything.
  assert.doesNotThrow(() => assertPerformanceExemption(
    performanceControlArtifact("PASS"),
    "performance honest-label control",
  ));
  console.info(`performance relabelling control: ${topLevel}`);
});

/**
 * The run verdict is RECOMPUTED from the records rather than read from the summary.
 *
 * The consumer substituted `true` for this artifact's verdict, so a summary claiming everything
 * passed sat happily above records that included a renderer painting a blank frame. That is the
 * "summary conceals a blank renderer" class this capability has already been bitten by twice, and a
 * summary is exactly the wrong place to take a verdict from, because it is the one field that can be
 * written without touching a measurement.
 */
function assertDerivedRunVerdict(raw: unknown, label: string): void {
  if (!isRecord(raw) || !isRecord(raw["summary"])) {
    return;
  }
  const records = Array.isArray(raw["records"]) ? raw["records"] : [];
  let unbound = 0;
  for (const record of records) {
    const measurements = isRecord(record) ? record["measurements"] : undefined;
    if (isRecord(measurements)) {
      unbound += countUnboundStatuses(measurements);
    }
  }
  const summary = raw["summary"] as Record<string, unknown>;
  const derived = unbound === 0;
  if (summary["passing"] !== derived) {
    throw new Error(
      `${label} summary claims passing:${String(summary["passing"])} while the records carry ${unbound} `
      + `unbound measurement(s), which derives passing:${String(derived)}`,
    );
  }
  if ("notRun" in summary || "unknown" in summary) {
    const claimed = Number(summary["notRun"] ?? 0) + Number(summary["unknown"] ?? 0);
    if (claimed !== unbound) {
      throw new Error(`${label} summary counts ${claimed} unbound measurement(s); the records carry ${unbound}`);
    }
  }
}

/** This counts unbound statuses at any depth and does not stop at the top level. */
function countUnboundStatuses(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total: number, entry) => total + countUnboundStatuses(entry), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  const own = typeof value["status"] === "string" && value["status"] !== "PASS" ? 1 : 0;
  return Object.entries(value).reduce(
    (total, [name, entry]) => total + (name === "status" ? 0 : countUnboundStatuses(entry)),
    own,
  );
}
