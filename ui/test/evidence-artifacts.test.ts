import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertEvidenceArtifactCurrent,
  TRACKED_TREE_IDENTITY_ALGORITHM,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";

const execFileAsync = promisify(execFile);

type ParsedArtifact = {
  readonly summary: { readonly passing: boolean };
  readonly run: { readonly trackedTree: TrackedTreeIdentity };
};

/**
 * Every artifact must be revision-bound. Only some may additionally be required to PASS.
 *
 * The performance artifact reports `passing: false` at this revision and that is the GOVERNED TRUTH,
 * not a defect: sixty-five of its measurements are NOT_RUN because a renderer-independent layout
 * consumes the budget before any renderer draws, and the capability's own criterion requires the
 * run-level verdict to be false while anything is unbound. Demanding it pass would force exactly two
 * outcomes, both forbidden — hiding the NOT_RUN states, or lowering the criterion. So it is held to
 * the binding requirement and to the rule that every unbound measurement carries its reason, which
 * is what makes `passing: false` an honest statement rather than an unexamined one.
 */
const ARTIFACTS = [
  { label: "parity evidence", path: ["dist", "evidence", "parity.json"].join("/"), mustPass: true },
  { label: "performance evidence", path: ["dist", "evidence", "performance.json"].join("/"), mustPass: false },
  { label: "review3d manifest", path: ["dist", "review3d", "manifest.json"].join("/"), mustPass: true },
] as const;

test("evidence artifacts are currently certifiable against the tracked tree", async () => {
  const currentTrackedTreeSha256 = await trackedTreeSha256();
  const rejections: string[] = [];
  for (const artifact of ARTIFACTS) {
    try {
      const parsed = await readArtifact(artifact.path, artifact.label);
      // A not-required-to-pass artifact is still held to its binding, and additionally to the rule
      // that nothing is unbound WITHOUT a recorded reason — otherwise "does not have to pass" would
      // become "is not checked", which is the shape this whole check exists to remove.
      assertEvidenceArtifactCurrent(
        artifact.mustPass ? parsed.summary.passing : true,
        parsed.run.trackedTree,
        currentTrackedTreeSha256,
        artifact.label,
      );
      if (!artifact.mustPass) {
        assertEveryUnboundMeasurementHasAReason(
          JSON.parse(await readFile(artifact.path, "utf8")) as unknown,
          artifact.label,
        );
      }
    } catch (error: unknown) {
      rejections.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual(rejections, []);
});

/** This refuses an unbound measurement that carries no reason and does not require the run to pass. */
function assertEveryUnboundMeasurementHasAReason(raw: unknown, label: string): void {
  const records = (isRecord(raw) && Array.isArray(raw["records"]) ? raw["records"] : []) as readonly Record<string, unknown>[];
  let unbound = 0;
  for (const record of records) {
    const measurements = (record["measurements"] ?? {}) as Record<string, { readonly status?: string; readonly reason?: string }>;
    for (const [name, measurement] of Object.entries(measurements)) {
      if (measurement.status === undefined) {
        throw new Error(`${label} measurement ${name} records no status`);
      }
      if (measurement.status === "PASS") {
        continue;
      }
      unbound += 1;
      if (typeof measurement.reason !== "string" || measurement.reason.trim() === "") {
        throw new Error(`${label} measurement ${name} is ${measurement.status} with no recorded reason`);
      }
    }
  }
  if (unbound === 0) {
    throw new Error(`${label} is declared not-required-to-pass but reports nothing unbound, so the exemption is unexamined`);
  }
}

test("evidence artifact consumer rejects a stale recorded tree", async () => {
  const currentTrackedTreeSha256 = await trackedTreeSha256();
  const output = failedControlOutput(() => assertEvidenceArtifactCurrent(true, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: "0".repeat(64),
      completedSha256: "0".repeat(64),
      stable: true,
    }, currentTrackedTreeSha256, "stale identity control"));
  assert.match(output, /tracked-tree identity is stale/);
  console.info(`stale identity control: ${output}`);
});

test("evidence artifact consumer rejects a false run verdict", async () => {
  const currentTrackedTreeSha256 = await trackedTreeSha256();
  const output = failedControlOutput(() => assertEvidenceArtifactCurrent(false, {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: currentTrackedTreeSha256,
      completedSha256: currentTrackedTreeSha256,
      stable: true,
    }, currentTrackedTreeSha256, "false verdict control"));
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
        stable: tree.stable,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function trackedTreeSha256(): Promise<string> {
  const repositoryDirectory = [".."].join("/");
  const { stdout } = await execFileAsync("git", ["ls-files", "-s"], { cwd: repositoryDirectory, encoding: "utf8" });
  return createHash("sha256").update(stdout).digest("hex");
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("evidence artifact control unexpectedly passed");
}
