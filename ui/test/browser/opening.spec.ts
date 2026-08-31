/**
 * CAP-13 Opening Sequence evidence. Demonstrates, in rendered pixels, the one required opening this
 * capability delivers: temporal-genesis's own real valid-time sequence (T0..T7), played with the
 * Assemble MotionGrammar under one recorded seed, landing byte-identically on the accepted static
 * foundation -- plus the Off and reduced-motion paths, which land on that same foundation with nothing
 * played at all. The frame SCRIPT itself (`#engine/opening.ts`'s own `resolveOpeningFrames`) is
 * resolved here, at the Node level, from real, unmodified engine calls, exactly as
 * `#engine/scale-topology.ts` already is in scale-topology.spec.ts; only the rendered evidence itself
 * (decoded-pixel captures, and the surface witness read back from a real mounted renderer) crosses into
 * the browser, via opening.ts's own page module.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  DEFAULT_CONTROL_STATE,
  OPENING_OFF,
  applyControlState,
} from "#engine/control-state.ts";
import type { ControlState, OpeningPolicy } from "#engine/control-state.ts";
import type { Morphology } from "#engine/morphology.ts";
import { ASSEMBLE, STILL } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { OPENING_ARRIVAL_INSTANT, resolveOpeningFrames, resolveOpeningTimeline } from "#engine/opening.ts";
import { FLAT } from "#engine/organization.ts";
import { allTimeMembership, resolveTemporalMembership, resolveTemporalPlacements } from "#engine/temporal.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type {
  OpeningCaptureRequest,
  OpeningCaptureWitness,
  OpeningFixtureWitness,
  OpeningPageApi,
} from "#browser/opening.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

const OPENING_ENABLED = process.env.OPENING_CAPTURES === "1";
const OPENING_PROJECT = "opening";
const OPENING_COMMAND = "npm --prefix ui run test:opening";
const ROOT_DIRECTORY = join("dist", "opening");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXTURE_ID = "temporal-genesis";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"].join("/");
const MORPHOLOGY: Morphology = "stellar";
// Recorded, not rolled: matching motion.spec.ts's own M1_SHUFFLE_SEED precedent -- a fixed literal so
// this exact run is reproducible by anyone reading this file.
const OPENING_SEED = 4177;

type FrameRecord = {
  readonly fileName: string;
  readonly stepIndex: number;
  readonly instant: string;
  readonly requestedPhase: number;
  readonly rest: boolean;
  readonly phaseRendered: number;
  readonly surfaceNodeIds: readonly string[];
  readonly surfaceEdgeIds: readonly string[];
  readonly pixelSha256: string;
};

type OpeningManifest = {
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
  readonly calibration: { readonly source: "DEFAULT_CALIBRATION"; readonly sha256: string };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly renderer: "render3f";
    readonly morphology: Morphology;
    readonly organization: "flat";
  };
  readonly opening: {
    readonly policy: MotionGrammar;
    readonly seed: number;
    /** "real-history": every dated step plays a real valid-time instant this fixture's own governed placements name; never "metaphor" here. */
    readonly narration: "real-history";
    readonly narrationNote: string;
    readonly timeline: readonly { readonly stepIndex: number; readonly instant: string }[];
  };
  readonly foundation: { readonly fileName: string; readonly pixelSha256: string };
  readonly off: { readonly fileName: string; readonly pixelSha256: string; readonly matchesFoundation: true; readonly framesPlayed: number };
  readonly reducedMotion: {
    readonly fileName: string;
    readonly pixelSha256: string;
    readonly matchesFoundation: true;
    readonly configuredPolicy: OpeningPolicy;
    readonly resolvedPolicy: OpeningPolicy;
  };
  readonly arrival: { readonly fileName: string; readonly pixelSha256: string; readonly matchesFoundation: true };
  readonly determinism: { readonly repeatedFrameListIdentical: true };
  readonly frames: readonly FrameRecord[];
};

test("opening sequence evidence: real-history growth (assemble), off, and reduced motion, all landing on the accepted static foundation", async ({ page }, testInfo) => {
  test.skip(!OPENING_ENABLED || testInfo.project.name !== OPENING_PROJECT, "run this through the dedicated opening project");
  if (!OPENING_ENABLED || testInfo.project.name !== OPENING_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await rm(ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph: VisualGraph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const fixtureSemanticDigest = semanticDigest(graph);
  const placements = resolveTemporalPlacements(graph);

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);

    // ------------------------------------------------------------------------------------------
    // The accepted static foundation: today's default render of this SAME fixture, with none of
    // this capability's axes engaged -- no temporalInstant, no explicit phase, Still, reduced
    // motion at this page's own shipping default. Every path below is graded against this one
    // capture's own bytes, never against each other.
    // ------------------------------------------------------------------------------------------
    const foundation = await requestCapture(page, "00-foundation", STILL, OPENING_ARRIVAL_INSTANT, {}, -1, true);

    // ------------------------------------------------------------------------------------------
    // Opening: Off. A complete, non-degraded path (#engine/control-state.ts's own
    // OpeningSequenceControl docstring): exactly the resting state, nothing played before it.
    // ------------------------------------------------------------------------------------------
    const offFrames = resolveOpeningFrames(graph, OPENING_OFF, OPENING_SEED);
    expect(offFrames).toEqual([{ stepIndex: 0, instant: OPENING_ARRIVAL_INSTANT, phase: 0, rest: true }]);
    const offCapture = await requestCapture(page, "01-off", STILL, OPENING_ARRIVAL_INSTANT, {}, 0, true);
    if (offCapture.pixelSha256 !== foundation.pixelSha256) {
      throw new Error(`opening off did not land on the accepted static foundation byte-identically (${offCapture.pixelSha256} vs ${foundation.pixelSha256})`);
    }

    // ------------------------------------------------------------------------------------------
    // Reduced motion. A real, non-off configured policy (Assemble) must still resolve to Off and
    // play nothing -- resolved by the real, unmodified applyControlState, never a reimplemented
    // rule.
    // ------------------------------------------------------------------------------------------
    const reducedMotionControl: ControlState = {
      ...DEFAULT_CONTROL_STATE,
      openingSequence: { policy: ASSEMBLE, seed: OPENING_SEED },
      reducedMotion: { userPreference: true, systemOverride: false },
    };
    const effective = applyControlState(reducedMotionControl);
    expect(effective.openingPolicy).toBe(OPENING_OFF);
    expect(effective.reducedMotionActive).toBe(true);
    const reducedMotionFrames = resolveOpeningFrames(graph, effective.openingPolicy, OPENING_SEED);
    expect(reducedMotionFrames).toEqual(offFrames);
    const reducedMotionCapture = await requestCapture(page, "02-reduced-motion", STILL, OPENING_ARRIVAL_INSTANT, { reducedMotion: true }, 0, true);
    if (reducedMotionCapture.pixelSha256 !== foundation.pixelSha256) {
      throw new Error(`reduced motion did not land on the accepted static foundation byte-identically (${reducedMotionCapture.pixelSha256} vs ${foundation.pixelSha256})`);
    }

    // ------------------------------------------------------------------------------------------
    // The real-history opening: temporal-genesis's own T0..T7, then arrival. Assemble, one
    // recorded seed. Every frame's rendered surface is graded against #engine/temporal.ts's own
    // governed membership at that SAME instant -- never fabricated, never interpolated as
    // history, only as pixels.
    // ------------------------------------------------------------------------------------------
    const timeline = resolveOpeningTimeline(graph);
    expect(timeline.length).toBeGreaterThan(0);
    const frames = resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED);
    const frameRecords: FrameRecord[] = [];
    for (const [index, frame] of frames.entries()) {
      const isFinalArrival = index === frames.length - 1;
      const fileNameStem = `03-frame-${String(index).padStart(3, "0")}-step${frame.stepIndex}-${frame.rest ? "rest" : "sweep"}`;
      // Every frame except the very last plays with reduced motion off, so its own requested phase
      // genuinely takes effect (mount.tsx's own rule collapses a reduced-motion phase straight to
      // resting). The final arrival frame renders with reduced motion ON, matching the foundation
      // capture's own VisualState exactly -- its own phase (Assemble's resting phase) already
      // resolves to the same identity modulation either way (see motion-grammar.ts's own resting-
      // completeness contract), so this is never a second, different rendering path, only a stricter
      // proof that nothing besides `#engine/opening.ts`'s own script produced this arrival.
      const record = await requestCapture(
        page,
        fileNameStem,
        ASSEMBLE,
        frame.instant,
        isFinalArrival ? { reducedMotion: true } : { phase: frame.phase, reducedMotion: false },
        frame.stepIndex,
        frame.rest,
      );
      frameRecords.push(record);
      const expectedMembership = frame.instant === OPENING_ARRIVAL_INSTANT
        ? allTimeMembership(graph)
        : resolveTemporalMembership(graph, placements, frame.instant);
      assertSameIdSet(record.surfaceNodeIds, [...expectedMembership.nodeIds], `opening frame ${fileNameStem} node ids`);
      assertSameIdSet(record.surfaceEdgeIds, [...expectedMembership.edgeIds], `opening frame ${fileNameStem} relation ids`);
    }

    // Every frame within one step renders the identical id set: MotionGrammar changes HOW that
    // step's own real, already-governed membership is drawn, never WHICH elements are present --
    // matching temporal.spec.ts's own falsification 5 exactly, one instant at a time.
    const byStep = new Map<number, FrameRecord[]>();
    for (const record of frameRecords) {
      const bucket = byStep.get(record.stepIndex) ?? [];
      bucket.push(record);
      byStep.set(record.stepIndex, bucket);
    }
    for (const [stepIndex, bucket] of byStep) {
      const [firstRecord, ...rest] = bucket;
      if (firstRecord === undefined) {
        continue;
      }
      for (const record of rest) {
        assertSameIdSet(record.surfaceNodeIds, firstRecord.surfaceNodeIds, `opening step ${stepIndex} node ids across phases`);
        assertSameIdSet(record.surfaceEdgeIds, firstRecord.surfaceEdgeIds, `opening step ${stepIndex} relation ids across phases`);
      }
    }

    const arrivalRecord = frameRecords[frameRecords.length - 1];
    if (arrivalRecord === undefined) {
      throw new Error("opening sequence produced no frames");
    }
    expect(arrivalRecord.instant).toBe(OPENING_ARRIVAL_INSTANT);
    expect(arrivalRecord.rest).toBe(true);
    if (arrivalRecord.pixelSha256 !== foundation.pixelSha256) {
      throw new Error(`opening arrival did not land on the accepted static foundation byte-identically (${arrivalRecord.pixelSha256} vs ${foundation.pixelSha256})`);
    }

    // Determinism, at the script level: the exact same (graph, policy, seed) reproduces
    // byte-identical frames -- checked here in addition to the two-run `diff -rq` this suite's own
    // command requires, so a script-level regression is caught even before pixels are compared.
    const repeatFrames = resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED);
    expect(repeatFrames).toEqual(frames);

    const calibrationSha256 = createHash("sha256").update(JSON.stringify(DEFAULT_CALIBRATION)).digest("hex");
    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);

    const manifest: OpeningManifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: OPENING_COMMAND, trackedTree },
      fixture: {
        id: FIXTURE_ID,
        path: FIXTURE_PATH,
        semanticDigest: fixtureSemanticDigest,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
      calibration: { source: "DEFAULT_CALIBRATION", sha256: calibrationSha256 },
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        renderer: "render3f",
        morphology: MORPHOLOGY,
        organization: "flat",
      },
      opening: {
        policy: ASSEMBLE,
        seed: OPENING_SEED,
        narration: "real-history",
        narrationNote:
          "Every dated step plays a real valid-time instant this fixture's own governed placements name "
          + "(#engine/temporal.ts's resolveTemporalPlacements, read by #engine/opening.ts's own "
          + "resolveOpeningTimeline); no intermediate historical state is fabricated -- each frame's own "
          + "rendered surface is checked against that same instant's real governed membership. Only HOW "
          + "each step's own real membership is drawn is interpolated (Assemble's own staggered "
          + "construction), never WHICH elements belong to it. This is real-history narration, not metaphor.",
        timeline: timeline.map((step) => ({ stepIndex: step.stepIndex, instant: step.instant })),
      },
      foundation: { fileName: foundation.fileName, pixelSha256: foundation.pixelSha256 },
      off: { fileName: offCapture.fileName, pixelSha256: offCapture.pixelSha256, matchesFoundation: true, framesPlayed: offFrames.length - 1 },
      reducedMotion: {
        fileName: reducedMotionCapture.fileName,
        pixelSha256: reducedMotionCapture.pixelSha256,
        matchesFoundation: true,
        configuredPolicy: ASSEMBLE,
        resolvedPolicy: effective.openingPolicy,
      },
      arrival: { fileName: arrivalRecord.fileName, pixelSha256: arrivalRecord.pixelSha256, matchesFoundation: true },
      determinism: { repeatedFrameListIdentical: true },
      frames: frameRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "opening-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `opening: ${frameRecords.length} real-history frames (policy=assemble seed=${OPENING_SEED}) + off + reduced-motion, `
      + `arrival byte-identical to the accepted static foundation; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** This is the render3f WebGL canvas alone, never the DOM label overlay `mount.tsx` layers over it -- see `requestCapture`'s own lit-floor call for why this second, narrower capture exists. */
const CANVAS_LOCATOR_SELECTOR = '[data-render3f-canvas="true"]';

function assertSameIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = [...actual].sort();
  const expectedSet = [...expected].sort();
  if (actualSet.length !== expectedSet.length || actualSet.some((id, index) => id !== expectedSet[index])) {
    throw new Error(`opening invariant failed for ${label}: ${JSON.stringify(actualSet)} !== ${JSON.stringify(expectedSet)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Page bootstrap -- mirrors temporal.spec.ts's own bundling and installation shape.
// ---------------------------------------------------------------------------------------------

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "opening.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("opening page module output is unavailable");
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
    const api = window.__opening;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<OpeningPageApi> {
  return page.evaluate(() => {
    const api = window.__opening;
    if (api === undefined) {
      throw new Error("opening page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<OpeningFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__opening;
    if (api === undefined) {
      throw new Error("opening page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: OpeningCaptureRequest): Promise<OpeningCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__opening;
    if (api === undefined) {
      throw new Error("opening page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function requestCapture(
  page: Page,
  fileNameStem: string,
  motionGrammar: MotionGrammar,
  instant: "all-time" | string,
  extra: { readonly phase?: number; readonly reducedMotion?: boolean },
  stepIndex: number,
  rest: boolean,
): Promise<FrameRecord> {
  const request: OpeningCaptureRequest = {
    morphology: MORPHOLOGY,
    organization: FLAT,
    projection: "2d",
    motionGrammar,
    instant,
    ...(extra.phase === undefined ? {} : { phase: extra.phase }),
    ...(extra.reducedMotion === undefined ? {} : { reducedMotion: extra.reducedMotion }),
  };
  const witness = await invokeCapture(page, request);
  const fileName = `${fileNameStem}.png`;
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#opening-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const image = decodePng(bytes, fileName);
  const dimensions = pngDimensions(bytes, fileName);
  expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  assertDarkestShippingField(image, `opening ${fileName}`);
  // Checked against the CANVAS ALONE, never the composited frame this file screenshots above:
  // assertLitPixelFloor's own floor is deliberately low (a couple of anti-aliased label glyphs already
  // clear it), so run against the composited image it cannot tell "the graph was drawn" apart from "only
  // a label was drawn" -- a guard that measures the thing it names must measure the canvas, matching
  // review-opening.spec.ts's own identical fix for the identical reason. render3f draws every node,
  // relation, and halo exclusively to this canvas and every label exclusively to a DOM overlay layered
  // above it (see mount.tsx/labels.tsx), so a lit pixel here cannot be a label's.
  //
  // Checked only at `rest`, never at an intermediate sweep frame: `rest` is the one phase every policy
  // structurally guarantees full visibility at (`assertMotionRestingCompleteness` in #scene/build.ts).
  // A sweep frame carries no such guarantee -- Assemble's own staggered reveal
  // (`resolveStructuralGeometry`) can leave every element's own reveal fraction, hub included, too
  // small to clear even this floor's own low bar this early in a step's own construction, now that a
  // node's own label (`scaledLabelCandidacy`) correctly fades with it rather than staying legible on an
  // otherwise still-forming frame; see review-opening.spec.ts's own `requestCapture` for the identical
  // reasoning applied to that suite's denser sampling of the same real sequence.
  if (witness.surface.nodeIds.length > 0 && rest) {
    const canvasBytes = await page.locator(CANVAS_LOCATOR_SELECTOR).screenshot();
    const canvasImage = decodePng(canvasBytes, `${fileName} canvas`);
    assertLitPixelFloor(canvasImage, `opening ${fileName} canvas`);
  }
  return {
    fileName,
    stepIndex,
    instant,
    requestedPhase: extra.phase ?? witness.phaseRendered,
    rest,
    phaseRendered: witness.phaseRendered,
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
