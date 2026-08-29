import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
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
const MATRIX_MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const;
const MATRIX_ORGANIZATIONS = ["flat", "indra"] as const;
const MATRIX_PROJECTIONS = ["2d", "3d"] as const;
const MATRIX_DIRECTORY = join("dist", "matrix");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
  {
    label: "matrix manifest (discovery-at-question)",
    path: "dist/matrix/discovery-at-question-manifest.json",
    mustPass: true,
    matrix: true,
    fixtureId: "discovery-at-question",
    fixturePath: "fixtures/synthetic/projection/discovery-at-question.json",
  },
  {
    label: "matrix manifest (indra-community-windows)",
    path: "dist/matrix/indra-community-windows-manifest.json",
    mustPass: true,
    matrix: true,
    fixtureId: "indra-community-windows",
    fixturePath: "fixtures/synthetic/projection/indra/indra-community-windows.json",
  },
  // Bound to the commit it was produced at, not the tracked-tree hash the artifacts above use:
  // PREPARE_EVIDENCE (playwright.config.ts) writes run.commitSha before the DPR projects even
  // start, so this record carries no run.trackedTree at all. A record fifteen commits behind HEAD,
  // already reporting passing:false, shipped in a candidate unnoticed because nothing here read
  // it — see assertBrowserEvidenceCurrent.
  {
    label: "browser evidence run",
    path: ["dist", "evidence", "evidence.json"].join("/"),
    mustPass: true,
    browserEvidence: true,
  },
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
      const raw: unknown = JSON.parse(await readFile(artifact.path, "utf8"));
      if ("browserEvidence" in artifact) {
        await assertBrowserEvidenceCurrent(raw, artifact.label);
        continue;
      }
      if ("matrix" in artifact) {
        await assertMatrixEvidence(raw, artifact.label, artifact.fixtureId, artifact.fixturePath);
      } else if (!artifact.mustPass) {
        assertPerformanceExemption(
          raw,
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

type MatrixFixtureTopology = {
  readonly nodeIds: readonly string[];
  readonly relations: readonly { readonly id: string; readonly source: string; readonly target: string }[];
  readonly identifierDigest: string;
  readonly incidenceDigest: string;
};

/** This independently consumes matrix structure, decoded pixels, coverage, and contact-sheet files. */
async function assertMatrixEvidence(
  raw: unknown,
  label: string,
  fixtureId: string,
  fixturePath: string,
): Promise<void> {
  const manifest = requiredMatrixRecord(raw, label);
  if (manifest["schemaVersion"] !== 2) {
    throw new Error(`${label} uses matrix schema ${String(manifest["schemaVersion"])}, expected 2`);
  }
  const summary = requiredMatrixRecord(manifest["summary"], `${label} summary`);
  if (summary["passing"] !== true) {
    throw new Error(`${label} run-level verdict is not passing`);
  }
  const run = requiredMatrixRecord(manifest["run"], `${label} run`);
  if (run["command"] !== "npm --prefix ui run test:matrix") {
    throw new Error(`${label} records unexpected command ${String(run["command"])}`);
  }
  const fixture = requiredMatrixRecord(manifest["fixture"], `${label} fixture`);
  if (fixture["id"] !== fixtureId || fixture["path"] !== fixturePath) {
    throw new Error(
      `${label} names fixture ${String(fixture["id"])} at ${String(fixture["path"])}, expected ${fixtureId} at ${fixturePath}`,
    );
  }
  const governed = await readMatrixFixtureTopology(fixturePath, label);
  if (
    fixture["declaredNodeCount"] !== governed.nodeIds.length
    || fixture["resolvedNodeCount"] !== governed.nodeIds.length
    || fixture["declaredRelationCount"] !== governed.relations.length
    || fixture["resolvedEdgeCount"] !== governed.relations.length
  ) {
    throw new Error(
      `${label} fixture counts are nodes=${String(fixture["resolvedNodeCount"])}, relations=${String(fixture["resolvedEdgeCount"])}; `
      + `governed fixture requires nodes=${governed.nodeIds.length}, relations=${governed.relations.length}`,
    );
  }
  assertRecordedGovernedTopology(fixture["governedTopology"], governed, label);

  for (const [path, description] of [
    [["controlledComparison", "passed"], "controlled comparison"],
    [["combinationCoverage", "passed"], "combination coverage"],
    [["topologyInvariant", "passed"], "topology invariant"],
    [["strokeInvariant", "passed"], "stroke invariant"],
    [["imageDistinctness", "passed"], "decoded-pixel distinctness"],
    [["imageDistinctness", "allTwelveDistinct"], "all-cell decoded-pixel distinctness"],
    [["contactSheetEvidence", "passed"], "contact-sheet existence"],
    [["frameContainmentInvariant", "passed"], "frame-containment invariant"],
  ] as const) {
    assertMatrixFlag(manifest, path, description, label);
  }

  // aggregateFillInvariant and aggregateRimInvariant are NOT required to carry passed:true on every
  // manifest: a fixture whose own aggregate windows never clear the shared testability floor legitimately
  // measures zero cells and reports passed:false there (see matrix.spec.ts's per-fixture measurement and
  // R2's repair). What IS required is that the flag is present, honest about what it measured, and -- when
  // it reports false -- carries a stated reason rather than an unexplained shortfall. The run-level
  // requirement that the fixtures POOLED TOGETHER carry at least one measured cell is enforced by
  // matrix.spec.ts itself throwing before either manifest is written; nothing here re-derives that across
  // manifests, since each manifest is read independently and neither, alone, proves the other's coverage.
  assertMatrixCoverageInvariant(manifest, "aggregateFillInvariant", label);
  assertMatrixCoverageInvariant(manifest, "aggregateRimInvariant", label);

  const coverage = requiredMatrixRecord(manifest["combinationCoverage"], `${label} combination coverage`);
  if (coverage["combinationsPerProjection"] !== 6 || coverage["totalCaptures"] !== 12) {
    throw new Error(`${label} does not record six combinations in both projections`);
  }
  const captures = requiredMatrixArray(manifest["captures"], `${label} captures`);
  if (captures.length !== 12) {
    throw new Error(`${label} has ${captures.length} captures; expected 12`);
  }
  const expectedKeys = new Set<string>();
  for (const projection of MATRIX_PROJECTIONS) {
    for (const organization of MATRIX_ORGANIZATIONS) {
      for (const morphology of MATRIX_MORPHOLOGIES) {
        expectedKeys.add(`${morphology}:${organization}:${projection}`);
      }
    }
  }
  const seen = new Set<string>();
  const pixelDigests = new Map<string, string>();
  for (const [index, candidate] of captures.entries()) {
    const capture = requiredMatrixRecord(candidate, `${label} capture ${index}`);
    const morphology = requiredMatrixMember(capture["morphology"], MATRIX_MORPHOLOGIES, `${label} capture ${index} morphology`);
    const organization = requiredMatrixMember(capture["organization"], MATRIX_ORGANIZATIONS, `${label} capture ${index} organization`);
    const projection = requiredMatrixMember(capture["projection"], MATRIX_PROJECTIONS, `${label} capture ${index} projection`);
    const key = `${morphology}:${organization}:${projection}`;
    if (!expectedKeys.has(key) || seen.has(key)) {
      throw new Error(`${label} has unexpected or repeated capture ${key}`);
    }
    seen.add(key);
    const expectedFileName = `${fixtureId}-${morphology}-${organization}-${projection}.png`;
    if (capture["fileName"] !== expectedFileName || capture["fixture"] !== fixturePath) {
      throw new Error(`${label} capture ${key} is not bound to ${expectedFileName} and ${fixturePath}`);
    }
    if (capture["semanticDigest"] !== fixture["semanticDigest"]) {
      throw new Error(`${label} capture ${key} has a semantic digest outside its fixture record`);
    }
    const resolved = requiredMatrixRecord(capture["resolved"], `${label} capture ${key} topology`);
    if (
      resolved["nodeCount"] !== governed.nodeIds.length
      || resolved["edgeCount"] !== governed.relations.length
      || resolved["identifierDigest"] !== governed.identifierDigest
      || resolved["incidenceDigest"] !== governed.incidenceDigest
    ) {
      throw new Error(
        `${label} capture ${key} records nodes=${String(resolved["nodeCount"])}, relations=${String(resolved["edgeCount"])} `
        + `or topology digests that differ from the governed fixture (${governed.nodeIds.length}/${governed.relations.length})`,
      );
    }
    const aggregateCount = resolved["aggregateCount"];
    if (typeof aggregateCount !== "number" || (organization === "flat" ? aggregateCount !== 0 : aggregateCount <= 0)) {
      throw new Error(`${label} capture ${key} records invalid aggregate count ${String(aggregateCount)}`);
    }
    const stroke = requiredMatrixRecord(capture["drawnStrokeWitness"], `${label} capture ${key} stroke witness`);
    if (
      stroke["passed"] !== true
      || stroke["governedRelationCount"] !== governed.relations.length
      || stroke["submittedFilamentInstances"] !== governed.relations.length
      || typeof stroke["submissionCount"] !== "number"
      || stroke["submissionCount"] <= 0
    ) {
      throw new Error(
        `${label} capture ${key} submitted ${String(stroke["submittedFilamentInstances"])} filament instances; `
        + `governed fixture requires ${governed.relations.length}`,
      );
    }
    const pixelDigest = requiredSha256(capture["pixelSha256"], `${label} capture ${key} decoded-pixel digest`);
    const recaptureDigest = requiredSha256(
      capture["controlledRecapturePixelSha256"],
      `${label} capture ${key} controlled recapture digest`,
    );
    if (pixelDigest !== recaptureDigest) {
      throw new Error(`${label} capture ${key} decoded pixels differ from its controlled recapture`);
    }
    const pngBytes = await readFile(join(MATRIX_DIRECTORY, expectedFileName));
    const actualDigest = sha256Bytes(decodeMatrixPngPixels(pngBytes, `${label} ${expectedFileName}`).data);
    if (actualDigest !== pixelDigest) {
      throw new Error(`${label} capture ${key} decoded-pixel digest does not bind ${expectedFileName}`);
    }
    pixelDigests.set(key, pixelDigest);
  }
  const missing = [...expectedKeys].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing captures: ${missing.join(", ")}`);
  }
  if (new Set(pixelDigests.values()).size !== 12) {
    throw new Error(`${label} does not contain twelve distinct decoded-pixel rasters`);
  }
  for (const projection of MATRIX_PROJECTIONS) {
    for (const organization of MATRIX_ORGANIZATIONS) {
      const group = MATRIX_MORPHOLOGIES.map((morphology) => pixelDigests.get(`${morphology}:${organization}:${projection}`));
      if (group.some((digest) => digest === undefined) || new Set(group).size !== MATRIX_MORPHOLOGIES.length) {
        throw new Error(`${label} morphology pixels are not distinct for ${organization}/${projection}`);
      }
    }
  }
  await assertMatrixContactSheets(manifest["contactSheets"], fixtureId, label);

  const controls = requiredMatrixRecord(manifest["negativeControls"], `${label} negative controls`);
  const identical = requiredMatrixRecord(controls["forcedIdenticalMorphologies"], `${label} identical-morphology control`);
  const shifted = requiredMatrixRecord(controls["shiftedRaster"], `${label} shifted-raster control`);
  if (
    identical["restored"] !== true
    || typeof identical["message"] !== "string"
    || !identical["message"].includes("decoded-pixel SHA-256 values must be distinct")
    || shifted["restored"] !== true
    || typeof shifted["message"] !== "string"
    || !shifted["message"].includes("controlled-comparison raster invariant failed")
  ) {
    throw new Error(`${label} does not carry both real-content negative-control refusals`);
  }
}

async function readMatrixFixtureTopology(fixturePath: string, label: string): Promise<MatrixFixtureTopology> {
  const fixture = requiredMatrixRecord(
    JSON.parse(await readFile(join("..", fixturePath), "utf8")) as unknown,
    `${label} governed fixture`,
  );
  const nodes = requiredMatrixArray(fixture["nodes"], `${label} governed fixture nodes`)
    .map((candidate, index) => requiredMatrixStringField(candidate, "id", `${label} governed node ${index}`))
    .sort();
  const relations = requiredMatrixArray(fixture["edges"], `${label} governed fixture relations`)
    .map((candidate, index) => ({
      id: requiredMatrixStringField(candidate, "id", `${label} governed relation ${index}`),
      source: requiredMatrixStringField(candidate, "source", `${label} governed relation ${index}`),
      target: requiredMatrixStringField(candidate, "target", `${label} governed relation ${index}`),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(nodes).size !== nodes.length || new Set(relations.map((relation) => relation.id)).size !== relations.length) {
    throw new Error(`${label} governed fixture repeats a structural identifier`);
  }
  const nodeSet = new Set(nodes);
  if (relations.some((relation) => !nodeSet.has(relation.source) || !nodeSet.has(relation.target))) {
    throw new Error(`${label} governed fixture contains incidence outside its node set`);
  }
  return {
    nodeIds: nodes,
    relations,
    identifierDigest: sha256Text(JSON.stringify({ nodes, edges: relations.map((relation) => relation.id) })),
    incidenceDigest: sha256Text(JSON.stringify(relations)),
  };
}

function assertRecordedGovernedTopology(raw: unknown, expected: MatrixFixtureTopology, label: string): void {
  const recorded = requiredMatrixRecord(raw, `${label} governed-topology record`);
  if (
    JSON.stringify(recorded["nodeIds"]) !== JSON.stringify(expected.nodeIds)
    || JSON.stringify(recorded["relations"]) !== JSON.stringify(expected.relations)
    || recorded["identifierDigest"] !== expected.identifierDigest
    || recorded["incidenceDigest"] !== expected.incidenceDigest
  ) {
    throw new Error(`${label} governed-topology record differs from the governed fixture`);
  }
}

async function assertMatrixContactSheets(raw: unknown, fixtureId: string, label: string): Promise<void> {
  const files = requiredMatrixArray(raw, `${label} contact sheets`);
  const expected = MATRIX_PROJECTIONS.map((projection) => `${fixtureId}-${projection}-contact-sheet.png`);
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`${label} contact-sheet list is ${JSON.stringify(files)}, expected ${JSON.stringify(expected)}`);
  }
  for (const fileName of expected) {
    const decoded = decodeMatrixPngPixels(await readFile(join(MATRIX_DIRECTORY, fileName)), `${label} ${fileName}`);
    if (decoded.width <= 0 || decoded.height <= 0 || decoded.data.length === 0) {
      throw new Error(`${label} contact sheet ${fileName} has no decoded pixels`);
    }
  }
}

function assertMatrixFlag(
  root: Record<string, unknown>,
  path: readonly string[],
  description: string,
  label: string,
): void {
  let value: unknown = root;
  for (const segment of path) {
    value = isRecord(value) && !Array.isArray(value) ? value[segment] : undefined;
  }
  if (value !== true) {
    throw new Error(`${label} ${description} flag is ${String(value)}, not true`);
  }
}

/**
 * This requires presence and internal honesty for a coverage-style invariant that may legitimately
 * report passed:false on one manifest while the run as a whole still passes (see aggregateFillInvariant
 * and aggregateRimInvariant). A blanket passed:true requirement here would be wrong for a fixture whose
 * own windows never clear the shared testability floor; what must hold is that measuredCells agrees with
 * passed, and that a false verdict is never left unexplained.
 */
function assertMatrixCoverageInvariant(root: Record<string, unknown>, key: string, label: string): void {
  const invariant = requiredMatrixRecord(root[key], `${label} ${key}`);
  const measuredCells = invariant["measuredCells"];
  if (typeof measuredCells !== "number" || !Number.isInteger(measuredCells) || measuredCells < 0) {
    throw new Error(`${label} ${key} measuredCells is ${String(measuredCells)}, not a non-negative integer`);
  }
  const passed = invariant["passed"];
  if (typeof passed !== "boolean") {
    throw new Error(`${label} ${key} passed is ${String(passed)}, not a boolean`);
  }
  if (passed) {
    if (measuredCells <= 0) {
      throw new Error(`${label} ${key} claims passed:true with measuredCells:${measuredCells}`);
    }
    if (invariant["reason"] !== null) {
      throw new Error(`${label} ${key} claims passed:true but still carries a reason (${String(invariant["reason"])})`);
    }
    return;
  }
  if (measuredCells !== 0) {
    throw new Error(`${label} ${key} claims passed:false but recorded measuredCells:${measuredCells}`);
  }
  const reason = invariant["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(`${label} ${key} reports passed:false with no recorded reason`);
  }
}

function requiredMatrixRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function requiredMatrixArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value;
}

function requiredMatrixStringField(candidate: unknown, field: string, label: string): string {
  const value = requiredMatrixRecord(candidate, label)[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} has no ${field}`);
  }
  return value;
}

function requiredMatrixMember<const Members extends readonly string[]>(
  value: unknown,
  members: Members,
  label: string,
): Members[number] {
  if (typeof value !== "string" || !(members as readonly string[]).includes(value)) {
    throw new Error(`${label} is outside [${members.join(", ")}]`);
  }
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(`${label} is not a SHA-256`);
  }
  return value;
}

function decodeMatrixPngPixels(
  source: Uint8Array,
  label: string,
): { readonly width: number; readonly height: number; readonly data: Buffer } {
  const input = Buffer.from(source);
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG`);
  }
  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  const idat: Buffer[] = [];
  while (offset < input.length) {
    if (offset + 12 > input.length) {
      throw new Error(`${label} ends within a PNG chunk`);
    }
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > input.length) {
      throw new Error(`${label} has an invalid PNG chunk length`);
    }
    if (type === "IHDR") {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      const bitDepth = input[offset + 16];
      const colourType = input[offset + 17];
      const compression = input[offset + 18];
      const filtering = input[offset + 19];
      const interlace = input[offset + 20];
      if (bitDepth !== 8 || compression !== 0 || filtering !== 0 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`${label} has an unsupported PNG format`);
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      idat.push(input.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      if (end !== input.length) {
        throw new Error(`${label} has trailing PNG bytes`);
      }
      break;
    }
    offset = end;
  }
  if (width === undefined || height === undefined || channels === undefined) {
    throw new Error(`${label} lacks PNG dimensions`);
  }
  const scanlines = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error(`${label} has invalid PNG scanline bytes`);
  }
  const data = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    const filter = scanlines[start];
    const current = Buffer.alloc(rowBytes);
    for (let column = 0; column < rowBytes; column += 1) {
      const sample = scanlines[start + 1 + column] ?? 0;
      const left = column >= channels ? (current[column - channels] ?? 0) : 0;
      const above = previous[column] ?? 0;
      const upperLeft = column >= channels ? (previous[column - channels] ?? 0) : 0;
      current[column] = unfilterMatrixPng(sample, filter, left, above, upperLeft);
    }
    for (let column = 0; column < width; column += 1) {
      const sourceIndex = column * channels;
      const targetIndex = ((row * width) + column) * 4;
      data[targetIndex] = current[sourceIndex] ?? 0;
      data[targetIndex + 1] = current[sourceIndex + 1] ?? 0;
      data[targetIndex + 2] = current[sourceIndex + 2] ?? 0;
      data[targetIndex + 3] = channels === 4 ? (current[sourceIndex + 3] ?? 255) : 255;
    }
    current.copy(previous);
  }
  return { width, height, data };
}

function unfilterMatrixPng(
  value: number,
  filter: number | undefined,
  left: number,
  above: number,
  upperLeft: number,
): number {
  if (filter === 0) {
    return value;
  }
  if (filter === 1) {
    return (value + left) & 0xff;
  }
  if (filter === 2) {
    return (value + above) & 0xff;
  }
  if (filter === 3) {
    return (value + Math.floor((left + above) / 2)) & 0xff;
  }
  if (filter === 4) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    const predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
      ? left
      : aboveDistance <= upperLeftDistance ? above : upperLeft;
    return (value + predictor) & 0xff;
  }
  throw new Error(`matrix evidence PNG has unsupported filter ${String(filter)}`);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

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
      if (typeof measured === "string" || typeof measured === "boolean") {
        // Strings were refused and booleans were not, so a count of ten became `false` and passed.
        // Nothing measured here is a word or a flag; a measurement is a number or a structure.
        throw new Error(
          `${path} PASS records ${JSON.stringify(measured)}, which is a ${typeof measured} and not a measurement`,
        );
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

/**
 * dist/evidence/evidence.json is bound to the commit it was produced at, not to the tracked-tree
 * hash the other artifacts above carry, so it cannot go through readArtifact/
 * assertEvidenceArtifactCurrent. A record shipped fifteen commits behind HEAD, already reporting
 * passing:false, went unnoticed at a real closure audit because nothing in this file read this
 * path at all; this both re-derives the run-level verdict and requires it be bound to HEAD.
 */
/**
 * This binds the browser evidence record to HEAD and requires its own checks to have passed, and it
 * deliberately does NOT require the record's run-level verdict.
 *
 * That verdict aggregates the whole capability — it reads `unit-result.json`'s exit code, the pytest
 * artifact and the gauntlet artifact. Requiring it here would be circular: this assertion runs inside
 * `test:unit`, so `test:unit` would have to have already passed for `test:unit` to be able to pass. A
 * first version did require it, and deadlocked exactly that way. The verdict also carries pre-existing
 * `NOT_RUN` and `SUPERSEDED` entries that no browser run can clear.
 *
 * What is asserted instead is everything this artifact can actually speak for: it is bound to the
 * candidate, both projects completed, and every recorded check passed. A stale record, or a red one,
 * still fails — which is the defect this was added to catch.
 */
async function assertBrowserEvidenceCurrent(raw: unknown, label: string): Promise<void> {
  if (!isRecord(raw) || !isRecord(raw["summary"])) {
    throw new Error(`${label} has no run summary`);
  }
  const summary = raw["summary"];
  if (summary["projectsComplete"] !== true) {
    throw new Error(`${label} did not complete both device-pixel-ratio projects`);
  }
  for (const counter of ["failed", "notRun", "unknown"]) {
    if (summary[counter] !== 0) {
      throw new Error(`${label} records ${String(summary[counter])} ${counter} checks; every recorded check must pass`);
    }
  }
  if (typeof summary["passed"] !== "number" || summary["passed"] <= 0) {
    throw new Error(`${label} records no passing checks`);
  }
  // A criterion resolves to FAIL from a red EXTERNAL suite, which `summary.failed` — computed from
  // this run's own checks — cannot see. An audit set `acceptance.failed = 7` and every other mutation
  // was rejected while this one passed. Requiring it is not the circularity this function exists to
  // avoid: it constrains the state of other suites at the time the browser run was produced, not the
  // outcome of the run this assertion executes inside.
  const acceptance = raw["acceptance"];
  if (isRecord(acceptance) && acceptance["failed"] !== 0) {
    throw new Error(`${label} records ${String(acceptance["failed"])} failed acceptance criteria`);
  }
  if (!isRecord(raw["run"]) || typeof raw["run"]["commitSha"] !== "string" || !/^[0-9a-f]{40,64}$/iu.test(raw["run"]["commitSha"])) {
    throw new Error(`${label} has no bound commit SHA`);
  }
  const headSha = await currentHeadCommitSha();
  if (raw["run"]["commitSha"] !== headSha) {
    throw new Error(`${label} is bound to commit ${raw["run"]["commitSha"]}, HEAD is ${headSha}`);
  }
}

async function currentHeadCommitSha(): Promise<string> {
  const repositoryDirectory = [".."].join("/");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory, encoding: "utf8" });
  return stdout.trim();
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
  if ("status" in value && !("label" in value)) {
    // Validated only when present, so deleting a nested label passed. A record carrying a status is
    // a measurement, and a measurement in this artifact without its rasterisation label is a figure
    // whose environment is unstated.
    throw new Error(`${path} carries a status with no rasterisation label`);
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
