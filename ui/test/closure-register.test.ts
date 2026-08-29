import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";

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
  // The extension is one matrix run over two governed fixtures. Every matrix criterion is required
  // in both manifests; resolving against only the smaller fixture would leave the 177-relation case
  // silent, which is exactly where a dropped relation was previously accepted.
  matrix: [
    "dist/matrix/discovery-at-question-manifest.json",
    "dist/matrix/indra-community-windows-manifest.json",
  ],
} as const;

// The governance store lives OUTSIDE this repository and its location is machine-specific, so it
// cannot be assembled from repository-relative segments the way the fixture paths above are. It is
// named through an environment variable with a documented default; the default is computed from
// `homedir()` rather than written as a literal, so no absolute home-directory path is a tracked byte.
const GOVERNANCE_ROOT =
  process.env["NOUS_GOVERNANCE_ROOT"] ??
  join(homedir(), ".local", "share", "governance-store", "projects", "project");

const MATRIX_VALIDATION_TARGETS = [
  {
    manifestPath: "dist/matrix/discovery-at-question-manifest.json",
    fixturePath: "fixtures/synthetic/projection/discovery-at-question.json",
  },
  {
    manifestPath: "dist/matrix/indra-community-windows-manifest.json",
    fixturePath: "fixtures/synthetic/projection/indra/indra-community-windows.json",
  },
] as const;

type Source =
  | { readonly kind: "artifactCheck"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly checkName: string }
  | { readonly kind: "artifactBound"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly note: string }
  | { readonly kind: "unitTest"; readonly file: string; readonly name: string }
  | { readonly kind: "artifactFlag"; readonly artifact: keyof typeof ARTIFACT_PATHS; readonly path: readonly string[]; readonly note: string }
  | { readonly kind: "humanRecord"; readonly location: "repository" | "governance"; readonly record: string; readonly why: string; readonly outsideRepository?: string };

type Criterion = { readonly id: string; readonly claim: string; readonly source: Source };

test("every CAP-13 criterion resolves to a machine-readable status", async () => {
  const criteria = await readCriteria();
  assert.equal(criteria.length, 25, "the register must carry the seventeen base and eight extension criteria");

  const unresolved: string[] = [];
  for (const criterion of criteria) {
    const resolution = await resolve(criterion);
    if (resolution !== "RESOLVED") {
      unresolved.push(`${criterion.id}: ${resolution}`);
    }
  }
  assert.deepEqual(unresolved, [], "a criterion that cannot be resolved is undischarged, not silent");
});

test("matrix manifests independently validate governed topology from fixtures and captures", async () => {
  for (const target of MATRIX_VALIDATION_TARGETS) {
    const fixture = await readIndependentMatrixFixture(target.fixturePath);
    const manifest = await readArtifact(target.manifestPath);
    const captures = requiredArray(manifest["captures"], `${target.manifestPath} captures`);
    assert.equal(captures.length, 12, `${target.manifestPath} must contain all twelve matrix cells`);
    for (const [index, candidate] of captures.entries()) {
      const capture = requiredRecord(candidate, `${target.manifestPath} capture ${index}`);
      const resolved = requiredRecord(capture["resolved"], `${target.manifestPath} capture ${index} resolved topology`);
      assert.equal(resolved["nodeCount"], fixture.nodeIds.length, `${target.manifestPath} capture ${index} node count`);
      assert.equal(resolved["edgeCount"], fixture.relationIds.length, `${target.manifestPath} capture ${index} relation count`);
      assert.equal(resolved["identifierDigest"], fixture.identifierDigest, `${target.manifestPath} capture ${index} identifier digest`);
      assert.equal(resolved["incidenceDigest"], fixture.incidenceDigest, `${target.manifestPath} capture ${index} incidence digest`);
    }
  }
});

test("matrix manifests independently validate one submitted stroke per governed relation identifier", async () => {
  for (const target of MATRIX_VALIDATION_TARGETS) {
    const fixture = await readIndependentMatrixFixture(target.fixturePath);
    const manifest = await readArtifact(target.manifestPath);
    const captures = requiredArray(manifest["captures"], `${target.manifestPath} captures`);
    assert.equal(captures.length, 12, `${target.manifestPath} must contain all twelve matrix cells`);
    for (const [index, candidate] of captures.entries()) {
      const capture = requiredRecord(candidate, `${target.manifestPath} capture ${index}`);
      const label = String(capture["fileName"] ?? `capture ${index}`);
      const stroke = requiredRecord(capture["drawnStrokeWitness"], `${target.manifestPath} ${label} stroke witness`);
      const drawnRelationIds = requiredStringArray(
        stroke["drawnRelationIds"],
        `${target.manifestPath} ${label} drawn relation identifiers`,
      );
      assertIndependentRelationIdentifierMultiset(drawnRelationIds, fixture.relationIds, label);
      const recomputedDigest = relationIdentifierDigest(drawnRelationIds);
      assert.equal(
        stroke["drawnRelationIdentifierDigest"],
        recomputedDigest,
        `${target.manifestPath} ${label} recorded drawn-relation digest`,
      );
      assert.equal(recomputedDigest, fixture.relationIdentifierDigest, `${target.manifestPath} ${label} governed relation digest`);
      const submissionDigests = requiredStringArray(
        stroke["submissionIdentifierDigests"],
        `${target.manifestPath} ${label} submission identifier digests`,
      );
      assert.equal(submissionDigests.length, stroke["submissionCount"], `${target.manifestPath} ${label} submission count`);
      assert.ok(submissionDigests.length > 0, `${target.manifestPath} ${label} must record a filament submission`);
      assert.deepEqual(
        submissionDigests,
        submissionDigests.map(() => fixture.relationIdentifierDigest),
        `${target.manifestPath} ${label} every filament submission must establish the governed identifier digest`,
      );
    }
  }
});

test("matrix negative controls demonstrate the evidence can fail and are restored", async () => {
  for (const target of MATRIX_VALIDATION_TARGETS) {
    const manifest = await readArtifact(target.manifestPath);
    const controls = requiredRecord(manifest["negativeControls"], `${target.manifestPath} negative controls`);
    for (const name of ["forcedIdenticalMorphologies", "shiftedRaster"] as const) {
      const control = requiredRecord(controls[name], `${target.manifestPath} ${name} control`);
      assert.equal(control["restored"], true, `${target.manifestPath} ${name} control must be restored`);
      assert.equal(typeof control["message"], "string", `${target.manifestPath} ${name} control must name its refusal`);
    }
  }
  const target = MATRIX_VALIDATION_TARGETS[1];
  const manifest = await readArtifact(target.manifestPath);
  const controls = requiredRecord(manifest["negativeControls"], `${target.manifestPath} negative controls`);
  const relationControl = requiredRecord(
    controls["omittedAndDuplicatedRelation"],
    `${target.manifestPath} omit-one/duplicate-one control`,
  );
  const omitted = requiredString(relationControl["omittedRelationId"], "omitted relation id");
  const duplicated = requiredString(relationControl["duplicatedRelationId"], "duplicated relation id");
  const message = requiredString(relationControl["message"], "omit-one/duplicate-one refusal");
  assert.equal(relationControl["governedRelationCount"], 177);
  assert.equal(relationControl["controlledRelationCount"], 177, "the identity control must preserve cardinality");
  assert.equal(relationControl["restored"], true);
  assert.match(message, new RegExp(`missing=\\[${escapeForPattern(omitted)}\\]`));
  assert.match(message, new RegExp(`duplicated=\\[${escapeForPattern(duplicated)}×2\\]`));
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

test("the closure register refuses a governance record that does not exist", async () => {
  const output = await failingOutput(async () => {
    await resolveOrThrow({
      id: "control",
      claim: "control",
      source: {
        kind: "humanRecord",
        location: "governance",
        record: "GR-X",
        why: "control",
        outsideRepository: "control",
      },
    });
  });
  assert.match(output, /governance record .* is absent or empty at the governance root/);
  console.info(`closure-register missing-governance-record control: ${output}`);
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
    if (source.checkName.trim() === "") {
      // Every string starts with the empty string, so an empty name matched every record and the
      // criterion resolved against whatever happened to be in the artifact.
      throw new Error(`${criterion.id} names an empty check, which matches every record`);
    }
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
    const run = parsed["run"];
    const tree = isRecord(run) ? run["trackedTree"] : undefined;
    if (!isRecord(tree)) {
      throw new Error(`${criterion.id} artifact carries no tracked-tree identity`);
    }
    // Presence was the whole check, so an all-zero, dirty, unstable identity resolved. That is the
    // F26 shape exactly — the artifact looks bound and is not — so the recorded identity is now
    // compared against the tree that exists.
    const current = await currentTrackedTreeState();
    if (tree["measuredSha256"] !== current.sha256 || tree["completedSha256"] !== current.sha256) {
      throw new Error(`${criterion.id} artifact identity ${String(tree["measuredSha256"]).slice(0, 12)} is not the current tree ${current.sha256.slice(0, 12)}`);
    }
    // The CURRENT tree must also be clean. The recorded statuses were compared and the live one was
    // not, so an artifact recording clean statuses resolved against a dirty working tree.
    if (current.statusPorcelain !== "") {
      throw new Error(`${criterion.id} resolves against a dirty working tree, whatever the artifact recorded`);
    }
    if (tree["measuredStatusPorcelain"] !== "" || tree["completedStatusPorcelain"] !== "" || tree["stable"] !== true) {
      throw new Error(`${criterion.id} artifact was measured against a moving or dirty tree`);
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
    // The file must be one the declared unit command actually selects. A criterion was rebound to a
    // test inside a `.spec.ts`, which `test/**/*.test.ts` does not match and which is skipped without
    // its own Playwright project, and the register resolved against it.
    if (!/^test\/.+\.test\.ts$/u.test(source.file)) {
      throw new Error(
        `${criterion.id} names ${source.file}, which the unit command's test/**/*.test.ts selection does not run`,
      );
    }
    const body = await readFile(source.file, "utf8").catch(() => null);
    if (body === null) {
      throw new Error(`${criterion.id} names unit-test file ${source.file}, which does not exist`);
    }
    // A DECLARATION, not a textual occurrence. `includes` matched a name written inside a comment,
    // so a criterion could resolve against a test that had been commented out or never written.
    const declaration = new RegExp(String.raw`^[ \t]*(?:await\s+)?test\(\s*"${escapeForPattern(source.name)}"`, "mu");
    if (!declaration.test(body)) {
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
  // boundary. This repository must not name that path in a tracked byte, so what is verified here has
  // two independent parts: that the DECLARATION is complete — the record, the reason a machine cannot
  // resolve it, and the statement of why it lives elsewhere — and that the named record actually
  // EXISTS at the governance root. A complete declaration naming a file nobody wrote used to resolve
  // here; a criterion may not reach RESOLVED that way any longer.
  if (source.record.trim() === "" || source.why.trim() === "" || (source.outsideRepository ?? "").trim() === "") {
    throw new Error(`${criterion.id} declares a governance record without naming it, its reason, and why it is not in this repository`);
  }
  const present = await readFile(join(GOVERNANCE_ROOT, source.record), "utf8")
    .then((text) => text.trim().length > 0)
    .catch(() => false);
  if (!present) {
    throw new Error(`${criterion.id} governance record ${source.record} is absent or empty at the governance root`);
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

type IndependentMatrixFixture = {
  readonly nodeIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly identifierDigest: string;
  readonly incidenceDigest: string;
  readonly relationIdentifierDigest: string;
};

async function readIndependentMatrixFixture(fixturePath: string): Promise<IndependentMatrixFixture> {
  const fixture = requiredRecord(
    JSON.parse(await readFile(join("..", fixturePath), "utf8")) as unknown,
    `${fixturePath} fixture`,
  );
  const nodeIds = requiredArray(fixture["nodes"], `${fixturePath} nodes`)
    .map((candidate, index) => requiredRecordStringField(candidate, "id", `${fixturePath} node ${index}`))
    .sort();
  const relations = requiredArray(fixture["edges"], `${fixturePath} relations`)
    .map((candidate, index) => ({
      id: requiredRecordStringField(candidate, "id", `${fixturePath} relation ${index}`),
      source: requiredRecordStringField(candidate, "source", `${fixturePath} relation ${index}`),
      target: requiredRecordStringField(candidate, "target", `${fixturePath} relation ${index}`),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const relationIds = relations.map((relation) => relation.id);
  assert.equal(new Set(nodeIds).size, nodeIds.length, `${fixturePath} node identifiers must be unique`);
  assert.equal(new Set(relationIds).size, relationIds.length, `${fixturePath} relation identifiers must be unique`);
  const nodeSet = new Set(nodeIds);
  assert.ok(
    relations.every((relation) => nodeSet.has(relation.source) && nodeSet.has(relation.target)),
    `${fixturePath} relation incidence must stay inside the fixture node set`,
  );
  return {
    nodeIds,
    relationIds,
    identifierDigest: sha256Text(JSON.stringify({ nodes: nodeIds, edges: relationIds })),
    incidenceDigest: sha256Text(JSON.stringify(relations)),
    relationIdentifierDigest: relationIdentifierDigest(relationIds),
  };
}

function assertIndependentRelationIdentifierMultiset(
  observed: readonly string[],
  governed: readonly string[],
  label: string,
): void {
  const observedCounts = identifierMultiplicities(observed);
  const governedCounts = identifierMultiplicities(governed);
  const missing = governed.filter((id) => (observedCounts.get(id) ?? 0) < (governedCounts.get(id) ?? 0));
  const duplicated = [...observedCounts.entries()]
    .filter(([id, count]) => count > (governedCounts.get(id) ?? 0) && governedCounts.has(id))
    .map(([id, count]) => `${id}×${count}`);
  const unexpected = [...observedCounts.keys()].filter((id) => !governedCounts.has(id));
  assert.deepEqual(
    { missing, duplicated, unexpected, observedCount: observed.length },
    { missing: [], duplicated: [], unexpected: [], observedCount: governed.length },
    `${label} drawn relation identifiers must equal the governed multiset`,
  );
}

function identifierMultiplicities(ids: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function relationIdentifierDigest(ids: readonly string[]): string {
  return sha256Text(JSON.stringify([...ids].sort()));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  const values = requiredArray(value, label);
  if (!values.every((candidate) => typeof candidate === "string" && candidate !== "")) {
    throw new Error(`${label} contains a non-string identifier`);
  }
  return values as readonly string[];
}

function requiredRecordStringField(candidate: unknown, field: string, label: string): string {
  return requiredString(requiredRecord(candidate, label)[field], `${label} ${field}`);
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

/** This escapes a criterion's test name for use inside a declaration pattern. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
