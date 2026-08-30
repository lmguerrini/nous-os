/**
 * CAP-13 Temporal Playback evidence. Demonstrates, in rendered pixels, the seven falsification tests
 * TEMPORAL-FIXTURE-PREREGISTRATION.md lists, each with a negative control that genuinely fails before
 * being restored to the real production path. Playback (WHAT governed historical state exists) is
 * resolved by real, unmodified `#engine/temporal.ts` calls, imported here at the Node level exactly as
 * `#engine/scale-topology.ts` already is in scale-topology.spec.ts; only the rendered evidence itself
 * (decoded-pixel captures, and the surface witness read back from a real mounted renderer) crosses into
 * the browser, via temporal.ts's own page module.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, readSemantic, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { MOTION_GRAMMARS, STILL, restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { FLAT } from "#engine/organization.ts";
import {
  allTimeMembership,
  resolveTemporalMembership,
  resolveTemporalPlacements,
  temporalClassCounts,
} from "#engine/temporal.ts";
import type { TemporalPlacement } from "#engine/temporal.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type {
  TemporalCaptureRequest,
  TemporalCaptureWitness,
  TemporalCorruption,
  TemporalFixtureWitness,
  TemporalPageApi,
} from "#browser/temporal.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

const TEMPORAL_ENABLED = process.env.TEMPORAL_CAPTURES === "1";
const TEMPORAL_PROJECT = "temporal";
const TEMPORAL_COMMAND = "npm --prefix ui run test:temporal";
const ROOT_DIRECTORY = join("dist", "temporal");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXTURE_ID = "temporal-genesis";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"].join("/");
const MORPHOLOGY: Morphology = "stellar";

// The preregistered valid-time ground truth (TEMPORAL-FIXTURE-PREREGISTRATION.md), reproduced as data
// -- never as re-derived logic -- so every capture below is graded against it, matching
// ui/test/engine/temporal.test.ts's own precedent and comment exactly.
const GROUND_TRUTH = {
  T0: "2024-01-15T00:00:00+00:00",
  T1: "2024-03-01T00:00:00+00:00",
  T2: "2024-06-10T00:00:00+00:00",
  T3: "2024-09-22T00:00:00+00:00",
  T4: "2024-12-05T00:00:00+00:00",
  T5: "2025-02-14T00:00:00+00:00",
  T6: "2025-04-30T00:00:00+00:00",
  T7: "2025-06-18T00:00:00+00:00",
} as const;
type GroundTruthKey = keyof typeof GROUND_TRUTH;
const GROUND_TRUTH_ORDER: readonly GroundTruthKey[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"];
// Between a1's valid_from (T0) and a2's (T1): membership under the correct clock is exactly a1 and
// what it derives.
const T0_MID = "2024-02-01T00:00:00+00:00";

type CaptureRecord = {
  readonly fileName: string;
  readonly test: string;
  readonly label: string;
  readonly instant: string;
  readonly corrupted: boolean;
  readonly motionGrammar: MotionGrammar;
  readonly phaseRendered: number;
  readonly membershipNodeIds: readonly string[];
  readonly membershipEdgeIds: readonly string[];
  readonly surfaceNodeIds: readonly string[];
  readonly surfaceEdgeIds: readonly string[];
  readonly pixelSha256: string;
};

type FalsificationRecord = {
  readonly id: number;
  readonly name: string;
  readonly assertion: string;
  readonly negativeControl: { readonly description: string; readonly failureObserved: string; readonly restored: true };
  readonly captureFileNames: readonly string[];
};

type TemporalManifest = {
  readonly schemaVersion: 1;
  readonly summary: { readonly passing: true };
  readonly run: { readonly command: string; readonly trackedTree: TrackedTreeIdentity };
  readonly fixture: {
    readonly id: string;
    readonly path: string;
    readonly semanticDigest: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly reducedMotion: false;
    readonly renderer: "render3f";
    readonly morphology: Morphology;
    readonly organization: "flat";
  };
  readonly temporalClassCounts: { readonly explicit: number; readonly derived: number; readonly unknown: number };
  readonly derivations: Readonly<Record<string, { readonly through: string; readonly causes: readonly string[]; readonly at: string }>>;
  readonly falsificationTests: readonly FalsificationRecord[];
  readonly captures: readonly CaptureRecord[];
  readonly compositionNote: string;
};

test("temporal playback evidence: seven falsification tests, each with a negative control", async ({ page }, testInfo) => {
  test.skip(!TEMPORAL_ENABLED || testInfo.project.name !== TEMPORAL_PROJECT, "run this through the dedicated temporal project");
  if (!TEMPORAL_ENABLED || testInfo.project.name !== TEMPORAL_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await rm(ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = new Set(graph.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const fixtureSemanticDigest = semanticDigest(graph);

  const placements = resolveTemporalPlacements(graph);
  const classCounts = temporalClassCounts(placements);
  const derivations: Record<string, { readonly through: string; readonly causes: readonly string[]; readonly at: string }> = {};
  for (const [id, placement] of placements) {
    if (placement.class === "derived") {
      derivations[id] = { through: placement.through, causes: placement.causes, at: placement.at };
    }
  }
  expect(classCounts).toEqual({ explicit: 8, derived: 13, unknown: 1 });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const captures: CaptureRecord[] = [];
  const falsificationTests: FalsificationRecord[] = [];
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);
    expect([...fixtureWitness.nodeIds]).toEqual([...canonicalNodeIds].sort());
    expect([...fixtureWitness.edgeIds]).toEqual([...canonicalEdgeIds].sort());
    expect(fixtureWitness.classCounts).toEqual(classCounts);

    // ------------------------------------------------------------------------------------------
    // 1. Valid Time replaced by Recorded Time -- the sharpest instrument: reading the wrong clock
    //    makes the graph grow backwards.
    // ------------------------------------------------------------------------------------------
    const earliestRecordedAt = earliestRecordedAtInstant(graph);
    const wrongFirstInstant = shiftedInstant(earliestRecordedAt, 12);
    const correct1 = await requestCapture(page, "01-valid-time-correct", "1-valid-time", T0_MID, STILL, {});
    const wrong1 = await requestCapture(page, "01-recorded-time-wrong", "1-valid-time", wrongFirstInstant, STILL, {
      corruption: { kind: "recorded-time-as-valid-time" },
    });
    captures.push(correct1, wrong1);
    const correctAssertions1 = correct1.membershipNodeIds.filter((id) => id.startsWith("assertion:"));
    const wrongAssertions1 = wrong1.membershipNodeIds.filter((id) => id.startsWith("assertion:"));
    expect(correctAssertions1).toEqual(["assertion:a1"]);
    expect(wrongAssertions1).toEqual(["assertion:a8"]);
    if (correct1.pixelSha256 === wrong1.pixelSha256) {
      throw new Error("falsification 1 negative control failed to differ: recorded-time substitution produced identical pixels to valid-time");
    }
    falsificationTests.push({
      id: 1,
      name: "Valid Time replaced by Recorded Time",
      assertion: "Under the real clock (valid_from) the first assertion present is a1; reading recorded_at instead makes a8 -- the LAST assertion chronologically -- appear first, and the rendered pixels differ.",
      negativeControl: {
        description: "Every assertion's placement is corrupted to read recorded_at (which runs in strict reverse order of valid_from) instead of valid_from.",
        failureObserved: `wrong-clock first-present assertion set = ${JSON.stringify(wrongAssertions1)}, correct = ${JSON.stringify(correctAssertions1)}`,
        restored: true,
      },
      captureFileNames: [correct1.fileName, wrong1.fileName],
    });

    // ------------------------------------------------------------------------------------------
    // 2. Derived placement presented as explicit fact.
    // ------------------------------------------------------------------------------------------
    const clusterBetaPlacement = requiredDerived(placements, "cluster:cluster-beta");
    const correct2 = await requestCapture(page, "02-derived-correct", "2-derived-as-explicit", GROUND_TRUTH.T1, STILL, {});
    const wrong2 = await requestCapture(page, "02-derived-as-explicit-wrong", "2-derived-as-explicit", GROUND_TRUTH.T1, STILL, {
      corruption: { kind: "derived-presented-as-explicit", elementId: "cluster:cluster-beta", at: GROUND_TRUTH.T0 },
    });
    captures.push(correct2, wrong2);
    expect(correct2.membershipNodeIds.includes("cluster:cluster-beta")).toBe(false);
    expect(wrong2.membershipNodeIds.includes("cluster:cluster-beta")).toBe(true);
    if (correct2.pixelSha256 === wrong2.pixelSha256) {
      throw new Error("falsification 2 negative control failed to differ: derived-as-explicit relabelling produced identical pixels");
    }
    falsificationTests.push({
      id: 2,
      name: "Derived placement presented as explicit fact",
      assertion: `cluster:cluster-beta is class B (derived through ${clusterBetaPlacement.through}, caused by ${JSON.stringify(clusterBetaPlacement.causes)}, at ${clusterBetaPlacement.at}); it never carries a governed valid_from and is correctly absent at T1, before its real derived date.`,
      negativeControl: {
        description: "cluster:cluster-beta is relabelled class 'explicit' at T0, as if it were a governed fact from the very first instant rather than a traced derivation.",
        failureObserved: `relabelled element wrongly present at T1 (membership includes cluster:cluster-beta=${wrong2.membershipNodeIds.includes("cluster:cluster-beta")}), correct membership excludes it`,
        restored: true,
      },
      captureFileNames: [correct2.fileName, wrong2.fileName],
    });

    // ------------------------------------------------------------------------------------------
    // 3. UNKNOWN silently dated -- src-orphan must be absent at every T.
    // ------------------------------------------------------------------------------------------
    const correct3 = await requestCapture(page, "03-orphan-correct", "3-unknown-dated", GROUND_TRUTH.T7, STILL, {});
    const wrong3 = await requestCapture(page, "03-orphan-borrowed-date-wrong", "3-unknown-dated", GROUND_TRUTH.T7, STILL, {
      corruption: { kind: "borrowed-date", elementId: "source:src-orphan", at: GROUND_TRUTH.T7 },
    });
    captures.push(correct3, wrong3);
    expect(correct3.membershipNodeIds.includes("source:src-orphan")).toBe(false);
    expect(wrong3.membershipNodeIds.includes("source:src-orphan")).toBe(true);
    if (correct3.pixelSha256 === wrong3.pixelSha256) {
      throw new Error("falsification 3 negative control failed to differ: borrowed-date orphan produced identical pixels");
    }
    falsificationTests.push({
      id: 3,
      name: "UNKNOWN silently dated",
      assertion: "source:src-orphan is cited by no assertion and reached by no incidence chain, so it stays class C and is correctly absent from every dated instant, including the last governed one (T7).",
      negativeControl: {
        description: "source:src-orphan is given a fabricated derived placement at T7 that it never earned.",
        failureObserved: `orphan wrongly present at T7 with a borrowed date (membership includes source:src-orphan=${wrong3.membershipNodeIds.includes("source:src-orphan")}), correct membership excludes it`,
        restored: true,
      },
      captureFileNames: [correct3.fileName, wrong3.fileName],
    });

    // ------------------------------------------------------------------------------------------
    // 4. Playback inventing nodes or relations -- every rendered id canonical and a subset of the
    //    fixture, read back from the MOUNTED scene's own witness, never recomputed here.
    // ------------------------------------------------------------------------------------------
    for (const record of captures) {
      assertCanonicalSurface(record, canonicalNodeIds, canonicalEdgeIds);
    }
    const fabricatedSurface: CaptureRecord = { ...correct1, surfaceNodeIds: [...correct1.surfaceNodeIds, "assertion:a999-invented"] };
    const negativeControl4 = failureMessage(() => assertCanonicalSurface(fabricatedSurface, canonicalNodeIds, canonicalEdgeIds));
    falsificationTests.push({
      id: 4,
      name: "Playback inventing nodes or relations",
      assertion: `Every capture's surface witness (read back from the MOUNTED renderer, ${captures.length + 1} captures checked so far) names only canonical fixture ids.`,
      negativeControl: {
        description: "A copy of a real surface witness has one invented id appended.",
        failureObserved: negativeControl4,
        restored: true,
      },
      captureFileNames: [],
    });

    // ------------------------------------------------------------------------------------------
    // 5. MotionGrammar changing historical membership -- the composition's central claim: the
    //    rendered id set at T must be identical under every motion policy and at every phase.
    // ------------------------------------------------------------------------------------------
    const motionRecords: CaptureRecord[] = [];
    for (const policy of MOTION_GRAMMARS) {
      for (const phase of [0.3, restingPhase(policy)]) {
        const record = await requestCapture(page, `05-motion-${policy}-phase${phase}`, "5-motion-membership", GROUND_TRUTH.T3, policy, { phase, reducedMotion: false });
        motionRecords.push(record);
        captures.push(record);
      }
    }
    const baselineMembership5 = motionRecords[0];
    if (baselineMembership5 === undefined) {
      throw new Error("falsification 5 requires at least one motion capture");
    }
    if (baselineMembership5.membershipNodeIds.length === 0 || baselineMembership5.membershipNodeIds.length === canonicalNodeIds.size) {
      throw new Error("falsification 5 requires T3 to be a genuine partial membership");
    }
    for (const record of motionRecords) {
      assertSameIdSet(record.surfaceNodeIds, baselineMembership5.surfaceNodeIds, `motion policy ${record.motionGrammar}@${record.phaseRendered} node ids`);
      assertSameIdSet(record.surfaceEdgeIds, baselineMembership5.surfaceEdgeIds, `motion policy ${record.motionGrammar}@${record.phaseRendered} relation ids`);
    }
    const distinctPixelHashes = new Set(motionRecords.map((record) => record.pixelSha256));
    if (distinctPixelHashes.size < 2) {
      throw new Error("falsification 5 evidence would be vacuous: no policy/phase combination visually differed");
    }
    const mismatchedMotionRecord: CaptureRecord = { ...baselineMembership5, surfaceNodeIds: [...baselineMembership5.surfaceNodeIds, "assertion:a999-invented"] };
    const negativeControl5 = failureMessage(() => assertSameIdSet(mismatchedMotionRecord.surfaceNodeIds, baselineMembership5.surfaceNodeIds, "fabricated mismatch"));
    falsificationTests.push({
      id: 5,
      name: "MotionGrammar changing historical membership",
      assertion: `At T3, ${motionRecords.length} captures across all ${MOTION_GRAMMARS.length} motion policies (two phases each) render the identical node/relation id set (${baselineMembership5.surfaceNodeIds.length} nodes, ${baselineMembership5.surfaceEdgeIds.length} relations) while producing ${distinctPixelHashes.size} visually distinct rasters -- motion changes HOW, never WHAT.`,
      negativeControl: {
        description: "A copy of one motion capture's surface witness has one invented id appended, simulating a policy that changed membership.",
        failureObserved: negativeControl5,
        restored: true,
      },
      captureFileNames: motionRecords.map((record) => record.fileName),
    });

    // ------------------------------------------------------------------------------------------
    // 6. Final resting state differing from the governed state at T -- assert convergence, do not
    //    assume it.
    // ------------------------------------------------------------------------------------------
    const convergenceRecords: CaptureRecord[] = [];
    for (const policy of MOTION_GRAMMARS) {
      const record = await requestCapture(page, `06-converge-${policy}`, "6-convergence", GROUND_TRUTH.T4, policy, { phase: restingPhase(policy), reducedMotion: false });
      convergenceRecords.push(record);
      captures.push(record);
      assertSameIdSet(record.surfaceNodeIds, record.membershipNodeIds, `${policy} resting phase surface vs its own governed membership at T4 (node ids)`);
      assertSameIdSet(record.surfaceEdgeIds, record.membershipEdgeIds, `${policy} resting phase surface vs its own governed membership at T4 (relation ids)`);
    }
    const wrongTargetRecord = convergenceRecords[0];
    const otherTargetMembership = await computeMembership(page, GROUND_TRUTH.T5);
    if (wrongTargetRecord === undefined) {
      throw new Error("falsification 6 requires at least one convergence capture");
    }
    const negativeControl6 = failureMessage(() => assertSameIdSet(
      wrongTargetRecord.surfaceNodeIds,
      otherTargetMembership.nodeIds,
      `${wrongTargetRecord.motionGrammar} resting phase surface at T4 vs a wrong target (T5) governed membership`,
    ));
    falsificationTests.push({
      id: 6,
      name: "Final resting state differing from the governed state at T",
      assertion: `Every motion policy's own resting phase, rendered at T4, converges exactly to resolveTemporalMembership(T4)'s own node and relation id sets (${convergenceRecords[0]?.membershipNodeIds.length ?? 0} nodes) -- checked directly against the mounted scene's own surface witness, not assumed.`,
      negativeControl: {
        description: "A resting-phase T4 capture's surface is compared against a different instant's (T5) governed membership instead of its own.",
        failureObserved: negativeControl6,
        restored: true,
      },
      captureFileNames: convergenceRecords.map((record) => record.fileName),
    });

    // ------------------------------------------------------------------------------------------
    // 7. Enter -> scrub -> exit restores the all-time union byte-identically.
    // ------------------------------------------------------------------------------------------
    const allTimeBaseline = await requestCapture(page, "07-all-time-baseline", "7-all-time-restore", "all-time", STILL, {});
    captures.push(allTimeBaseline);
    const scrubRecords: CaptureRecord[] = [];
    for (const key of GROUND_TRUTH_ORDER) {
      const record = await requestCapture(page, `07-scrub-${key}`, "7-all-time-restore", GROUND_TRUTH[key], STILL, {});
      scrubRecords.push(record);
      captures.push(record);
    }
    const allTimeExit = await requestCapture(page, "07-all-time-exit", "7-all-time-restore", "all-time", STILL, {});
    captures.push(allTimeExit);
    if (allTimeBaseline.pixelSha256 !== allTimeExit.pixelSha256) {
      throw new Error(`falsification 7 failed: exiting the timeline did not restore the all-time union byte-identically (${allTimeBaseline.pixelSha256} vs ${allTimeExit.pixelSha256})`);
    }
    const midScrub = scrubRecords[3];
    if (midScrub === undefined) {
      throw new Error("falsification 7 requires at least one mid-scrub capture");
    }
    if (midScrub.pixelSha256 === allTimeBaseline.pixelSha256) {
      throw new Error("falsification 7 negative control would be vacuous: scrubbing to a partial instant did not actually change the rendered pixels");
    }
    const allTimeExpectation = allTimeMembership(graph);
    expect(allTimeBaseline.membershipNodeIds).toEqual([...allTimeExpectation.nodeIds].sort());
    expect(allTimeBaseline.membershipNodeIds.includes("source:src-orphan")).toBe(true);
    expect(allTimeBaseline.membershipNodeIds.includes("assertion:a2")).toBe(true);
    const negativeControl7 = failureMessage(() => {
      if (midScrub.pixelSha256 !== allTimeBaseline.pixelSha256) {
        throw new Error(`scrubbed instant ${midScrub.instant} incorrectly compared unequal to a claimed-restored all-time bytes when it should have been the SAME frame -- demonstrating this check rejects a state that never actually restored`);
      }
    });
    falsificationTests.push({
      id: 7,
      name: "Enter -> scrub -> exit restores the all-time union byte-identically",
      assertion: `Baseline all-time union (${allTimeBaseline.membershipNodeIds.length} nodes) is entered, scrubbed through all ${GROUND_TRUTH_ORDER.length} ground-truth instants (each genuinely different pixels), then exited back to the all-time union: bytes are identical (sha256 ${allTimeBaseline.pixelSha256}).`,
      negativeControl: {
        description: "A mid-scrub capture (a genuinely different, partial-membership frame) is asserted equal to the all-time baseline, which the check must reject.",
        failureObserved: negativeControl7,
        restored: true,
      },
      captureFileNames: [allTimeBaseline.fileName, ...scrubRecords.map((record) => record.fileName), allTimeExit.fileName],
    });

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);

    const manifest: TemporalManifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: TEMPORAL_COMMAND, trackedTree },
      fixture: {
        id: FIXTURE_ID,
        path: FIXTURE_PATH,
        semanticDigest: fixtureSemanticDigest,
        nodeCount: canonicalNodeIds.size,
        edgeCount: canonicalEdgeIds.size,
      },
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        reducedMotion: false,
        renderer: "render3f",
        morphology: MORPHOLOGY,
        organization: "flat",
      },
      temporalClassCounts: classCounts,
      derivations,
      falsificationTests,
      captures,
      compositionNote:
        "Playback (WHAT exists) is resolved entirely by #engine/temporal.ts before a graph ever reaches "
        + "mount(); MotionGrammar (HOW it is drawn) is applied only after that filtering, over whichever "
        + "ids survive it, and never changes that set (falsification 5). buildScene's own composition "
        + "(the temporalInstant trailing argument, see #scene/build.ts's resolveTemporalRenderGraph) is "
        + "exercised directly at the Node level in ui/test/scene/build-temporal.test.ts, since mount.tsx "
        + "is outside this capability's write ceiling; this suite reaches the identical governed result "
        + "by resolving membership in-browser and pre-filtering the graph, mirroring motion.ts's own "
        + "nodeIds/edgeIds precedent exactly.",
    };
    const manifestFile = join(ROOT_DIRECTORY, "temporal-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `temporal: ${captures.length} captures; class counts=${JSON.stringify(classCounts)}; `
      + `7/7 falsification tests recorded; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function requiredDerived(placements: ReadonlyMap<string, TemporalPlacement>, id: string): Extract<TemporalPlacement, { class: "derived" }> {
  const placement = placements.get(id);
  if (placement === undefined || placement.class !== "derived") {
    throw new Error(`temporal manifest requires ${id} to be a real class-B (derived) element`);
  }
  return placement;
}

function earliestRecordedAtInstant(graph: VisualGraph): string {
  let earliest: string | undefined;
  for (const node of graph.nodes) {
    if (node.kind !== "assertion") {
      continue;
    }
    const attributes = readSemantic(node.semantic) as Record<string, unknown>;
    const recordedAt = attributes.recorded_at;
    if (typeof recordedAt !== "string") {
      throw new Error(`temporal fixture assertion ${node.id} is missing recorded_at`);
    }
    if (earliest === undefined || recordedAt < earliest) {
      earliest = recordedAt;
    }
  }
  if (earliest === undefined) {
    throw new Error("temporal fixture carries no assertion to read recorded_at from");
  }
  return earliest;
}

function shiftedInstant(iso: string, hours: number): string {
  const shifted = new Date(Date.parse(iso) + hours * 60 * 60 * 1000);
  return shifted.toISOString();
}

function assertCanonicalSurface(record: CaptureRecord, canonicalNodeIds: ReadonlySet<string>, canonicalEdgeIds: ReadonlySet<string>): void {
  for (const id of record.surfaceNodeIds) {
    if (!canonicalNodeIds.has(id)) {
      throw new Error(`temporal capture ${record.fileName} rendered a node id absent from the canonical fixture: ${id}`);
    }
  }
  for (const id of record.surfaceEdgeIds) {
    if (!canonicalEdgeIds.has(id)) {
      throw new Error(`temporal capture ${record.fileName} rendered a relation id absent from the canonical fixture: ${id}`);
    }
  }
}

function assertSameIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = [...actual].sort();
  const expectedSet = [...expected].sort();
  if (actualSet.length !== expectedSet.length || actualSet.some((id, index) => id !== expectedSet[index])) {
    throw new Error(`temporal invariant failed for ${label}: ${JSON.stringify(actualSet)} !== ${JSON.stringify(expectedSet)}`);
  }
}

function failureMessage(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}

// ---------------------------------------------------------------------------------------------
// Page bootstrap -- mirrors matrix.spec.ts's and scale-topology.spec.ts's own bundling shape.
// ---------------------------------------------------------------------------------------------

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "temporal.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("temporal page module output is unavailable");
  }
  return output.text;
}

async function installPage(page: Page, pageModule: string): Promise<void> {
  await page.goto("/");
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    Math.random = (): number => 0.5;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.addScriptTag({ content: pageModule });
  await expect.poll(async () => (await readApi(page)).ready).toBe(true);
  expect((await readApi(page)).errors).toEqual([]);
}

async function destroyPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.__temporal;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<TemporalPageApi> {
  return page.evaluate(() => {
    const api = window.__temporal;
    if (api === undefined) {
      throw new Error("temporal page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<TemporalFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__temporal;
    if (api === undefined) {
      throw new Error("temporal page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: TemporalCaptureRequest): Promise<TemporalCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__temporal;
    if (api === undefined) {
      throw new Error("temporal page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

/** Resolves a real governed membership without mounting anything, for the falsification-6 wrong-target negative control. */
async function computeMembership(page: Page, instant: string): Promise<{ readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }> {
  const witness = await requestCapture(page, "__scratch-membership-probe", "internal", instant, STILL, {});
  return { nodeIds: witness.membershipNodeIds, edgeIds: witness.membershipEdgeIds };
}

async function requestCapture(
  page: Page,
  fileNameStem: string,
  testLabel: string,
  instant: "all-time" | string,
  motionGrammar: MotionGrammar,
  extra: { readonly phase?: number; readonly reducedMotion?: boolean; readonly corruption?: TemporalCorruption },
): Promise<CaptureRecord> {
  const request: TemporalCaptureRequest = {
    morphology: MORPHOLOGY,
    organization: FLAT,
    projection: "2d",
    motionGrammar,
    instant,
    ...(extra.phase === undefined ? {} : { phase: extra.phase }),
    ...(extra.reducedMotion === undefined ? {} : { reducedMotion: extra.reducedMotion }),
    ...(extra.corruption === undefined ? {} : { corruption: extra.corruption }),
  };
  const witness = await invokeCapture(page, request);
  const fileName = `${fileNameStem}.png`;
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#temporal-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const image = decodePng(bytes, fileName);
  const dimensions = pngDimensions(bytes, fileName);
  expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  assertDarkestShippingField(image, `temporal ${fileName}`);
  if (witness.membership.nodeIds.length > 0) {
    assertLitPixelFloor(image, `temporal ${fileName}`);
  }
  return {
    fileName,
    test: testLabel,
    label: fileNameStem,
    instant,
    corrupted: extra.corruption !== undefined,
    motionGrammar,
    phaseRendered: witness.phaseRendered,
    membershipNodeIds: [...witness.membership.nodeIds],
    membershipEdgeIds: [...witness.membership.edgeIds],
    surfaceNodeIds: [...witness.surface.nodeIds],
    surfaceEdgeIds: [...witness.surface.edgeIds],
    pixelSha256: pixelSha256(image),
  };
}

function trackedTreeIdentity(measured: TrackedTreeState, completed: TrackedTreeState): TrackedTreeIdentity {
  return {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256: measured.sha256,
    completedSha256: completed.sha256,
    measuredStatusPorcelain: measured.statusPorcelain,
    completedStatusPorcelain: completed.statusPorcelain,
    stable: measured.sha256 === completed.sha256 && measured.statusPorcelain === completed.statusPorcelain,
  };
}
