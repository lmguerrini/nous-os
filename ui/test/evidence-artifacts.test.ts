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

const ARTIFACTS = [
  { label: "parity evidence", path: ["dist", "evidence", "parity.json"].join("/") },
  { label: "performance evidence", path: ["dist", "evidence", "performance.json"].join("/") },
  { label: "review3d manifest", path: ["dist", "review3d", "manifest.json"].join("/") },
] as const;

test("evidence artifacts are currently certifiable against the tracked tree", async () => {
  const currentTrackedTreeSha256 = await trackedTreeSha256();
  const rejections: string[] = [];
  for (const artifact of ARTIFACTS) {
    try {
      const parsed = await readArtifact(artifact.path, artifact.label);
      assertEvidenceArtifactCurrent(parsed.summary.passing, parsed.run.trackedTree, currentTrackedTreeSha256, artifact.label);
    } catch (error: unknown) {
      rejections.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual(rejections, []);
});

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
