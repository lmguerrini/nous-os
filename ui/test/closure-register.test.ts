import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * This resolves every CAP-13 criterion to a machine-readable status and does not accept silence as one.
 *
 * The capability's own criterion B16 requires that every criterion map to a named runnable command and
 * a machine-readable status, and that a green summary cannot hide an undischarged one. That was
 * recorded in a prose register, which a closure auditor correctly reported as unmet: prose has no
 * status a machine can read, so nothing could tell discharged from undischarged.
 *
 * Two criteria genuinely cannot be resolved by a machine, and they say so rather than being quietly
 * omitted. B17 is the clearest case in this capability: a visual metric once improved fourteenfold
 * while the rendered picture regressed to the exact identity the engine exists to replace, and only a
 * person looking at the image caught it. A criterion that declares a human record is discharged by
 * that record EXISTING and being named here — never by being absent.
 */

const CRITERIA_PATH = ["test", "cap13-criteria.json"].join("/");
const ARTIFACT_PATHS = {
  parity: ["dist", "evidence", "parity.json"].join("/"),
  performance: ["dist", "evidence", "performance.json"].join("/"),
  // Two manifests, one per device-pixel ratio. The register named a single top-level manifest that
  // the capture suite has never written, so B4 and B10 could not resolve — and the failure was read
  // as a stale artifact several times before it was read as a defect. Requiring the flag in BOTH is
  // also strictly stronger than the file it was looking for would have been.
  review3d: ["dist/review3d/dpr-1/manifest.json", "dist/review3d/dpr-2/manifest.json"],
} as const;

type Source =
  | { readonly kind: "artifactCheck"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly checkName: string }
  | { readonly kind: "artifactBound"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly note: string }
  | { readonly kind: "unitTest"; readonly file: string; readonly name: string }
  | { readonly kind: "artifactFlag"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly path: readonly string[]; readonly note: string }
  | { readonly kind: "humanRecord"; readonly location: "repository" | "governance"; readonly record: string; readonly why: string; readonly outsideRepository?: string };

type Criterion = { readonly id: string; readonly claim: string; readonly source: Source };

test("every CAP-13 criterion resolves to a machine-readable status", async () => {
  const criteria = await readCriteria();
  assert.equal(criteria.length, 17, "the register must carry all seventeen criteria");

  const unresolved: string[] = [];
  for (const criterion of criteria) {
    const resolution = await resolve(criterion);
    if (resolution !== "RESOLVED") {
      unresolved.push(`${criterion.id}: ${resolution}`);
    }
  }
  assert.deepEqual(unresolved, [], "a criterion that cannot be resolved is undischarged, not silent");
});

test("the closure register refuses a criterion with no resolvable source", async () => {
  const output = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "artifactCheck", artifact: "parity", checkName: "no such check" } });
  });
  assert.match(output, /names no check/);
  console.info(`closure-register missing-check control: ${output}`);
});

test("the closure register refuses a repository record that does not exist", async () => {
  const output = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "humanRecord", location: "repository", record: "docs/NOT-A-REAL-RECORD.md", why: "control" } });
  });
  assert.match(output, /human record .* is absent/);
  console.info(`closure-register missing-record control: ${output}`);
});

test("the closure register refuses an incomplete governance declaration", async () => {
  const output = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "humanRecord", location: "governance", record: "GR-X", why: "control", outsideRepository: "" } });
  });
  assert.match(output, /without naming it, its reason, and why it is not in this repository/);
  console.info(`closure-register incomplete-declaration control: ${output}`);
});

test("the closure register refuses an artifact flag that is not true", async () => {
  const output = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "artifactFlag", artifact: "review3d", path: ["determinism", "notAFlag"], note: "control" } });
  });

  assert.match(output, /is undefined, not true/);
  console.info(`closure-register false-flag control: ${output}`);
});

async function resolve(criterion: Criterion): Promise<string> {
  try {
    await resolveOrThrow(criterion);
    return "RESOLVED";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function resolveOrThrow(criterion: Criterion): Promise<void> {
  const source = criterion.source;
  if (source.kind === "artifactCheck") {
    const parsed = await readArtifact(requiredFirstArtifactPath(source.artifact));
    const checks = Array.isArray(parsed["checks"]) ? parsed["checks"] as readonly Record<string, unknown>[] : [];
    const matching = checks.filter((check) => String(check["checkName"] ?? "").startsWith(source.checkName));
    if (matching.length === 0) {
      throw new Error(`${criterion.id} names no check "${source.checkName}" in the ${source.artifact} artifact`);
    }
    const notPassing = matching.filter((check) => check["status"] !== "PASS");
    if (notPassing.length > 0) {
      throw new Error(`${criterion.id} has ${notPassing.length} non-PASS record(s) for "${source.checkName}"`);
    }
    return;
  }
  if (source.kind === "artifactBound") {
    const parsed = await readArtifact(requiredFirstArtifactPath(source.artifact));
    if (!isRecord(parsed["run"]) || !isRecord((parsed["run"] as Record<string, unknown>)["trackedTree"])) {
      throw new Error(`${criterion.id} artifact carries no tracked-tree identity`);
    }
    return;
  }
  if (source.kind === "unitTest") {
    // Resolving this against the TAP artifact would be circular: the TAP is written by the same
    // `test:unit` run that executes this file, so anything read from it here is the PREVIOUS run's
    // output — the stale-artifact trap this capability has already fallen into twice. What IS
    // verifiable in-run is that the named test exists in the tree at the file the register claims.
    // That it PASSED is guaranteed by a different mechanism: it is in this suite, so if it failed
    // this run is red and no closure verdict is available at all.
    if (source.name.trim() === "" || source.file.trim() === "") {
      throw new Error(`${criterion.id} names no unit test`);
    }
    const body = await readFile(source.file, "utf8").catch(() => null);
    if (body === null) {
      throw new Error(`${criterion.id} names unit-test file ${source.file}, which does not exist`);
    }
    if (!body.includes(`test("${source.name}"`)) {
      throw new Error(`${criterion.id} names unit test "${source.name}", which ${source.file} does not declare`);
    }
    return;
  }
  if (source.kind === "artifactFlag") {
    for (const path of artifactPaths(source.artifact)) {
      const parsed = await readArtifact(path);
      let value: unknown = parsed;
      for (const segment of source.path) {
        value = isRecord(value) ? value[segment] : undefined;
      }
      if (value !== true) {
        throw new Error(`${criterion.id} flag ${source.path.join(".")} in ${path} is ${String(value)}, not true`);
      }
    }
    return;
  }
  if (source.location === "repository") {
    const present = await readFile(["..", source.record].join("/"), "utf8")
      .then((text) => text.trim().length > 0)
      .catch(() => false);
    if (!present) {
      throw new Error(`${criterion.id} human record ${source.record} is absent or empty`);
    }
    return;
  }
  // A governed record kept OUTSIDE this repository, deliberately, under the project's public/private
  // boundary. This repository must not name that path in a tracked byte, so what is verified here is
  // that the DECLARATION is complete — the record, the reason a machine cannot resolve it, and the
  // statement of why it lives elsewhere. The record itself is verified by the governance gate. A
  // criterion may not reach this branch by omitting any of the three.
  if (source.record.trim() === "" || source.why.trim() === "" || (source.outsideRepository ?? "").trim() === "") {
    throw new Error(`${criterion.id} declares a governance record without naming it, its reason, and why it is not in this repository`);
  }
}

async function readCriteria(): Promise<readonly Criterion[]> {
  const parsed: unknown = JSON.parse(await readFile(CRITERIA_PATH, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed["criteria"])) {
    throw new Error("the criteria register is malformed");
  }
  return parsed["criteria"] as readonly Criterion[];
}

/** This returns every file an artifact spans and does not silently read only the first of several. */
function artifactPaths(artifact: keyof typeof ARTIFACT_PATHS): readonly string[] {
  const value = ARTIFACT_PATHS[artifact];
  return typeof value === "string" ? [value] : value;
}

/** This names the single file a one-file artifact spans and refuses a multi-file artifact. */
function requiredFirstArtifactPath(artifact: keyof typeof ARTIFACT_PATHS): string {
  const [only, ...rest] = artifactPaths(artifact);
  if (only === undefined || rest.length > 0) {
    throw new Error(`${artifact} spans ${artifactPaths(artifact).length} files; this source kind reads one`);
  }
  return only;
}

async function readArtifact(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path} is not an object`);
  }
  return parsed;
}

async function failingOutput(operation: () => Promise<void>): Promise<string> {
  try {
    await operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("control did not fail");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the closure register refuses a unit-test source that names nothing real", async () => {
  const missingFile = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "unitTest", file: "test/does-not-exist.test.ts", name: "anything" } });
  });
  assert.match(missingFile, /names unit-test file test\/does-not-exist\.test\.ts, which does not exist/);

  const missingTest = await failingOutput(async () => {
    await resolveOrThrow({ id: "control", claim: "control", source: { kind: "unitTest", file: "test/comparison-document.test.ts", name: "a test nobody wrote" } });
  });
  assert.match(missingTest, /names unit test "a test nobody wrote", which .* does not declare/);
  console.info(`closure-register unit-test source controls: ${missingFile} | ${missingTest}`);
});
