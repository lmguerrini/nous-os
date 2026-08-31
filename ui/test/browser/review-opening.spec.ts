/**
 * CAP-13 human-review Opening Sequence capture: the same real-history arc `ui/test/browser/opening.spec.ts`
 * already proves (temporal-genesis's own governed T0..T7, Assemble, one recorded seed, landing
 * byte-identically on the accepted static foundation) but sampled far more densely, because the human
 * review disposition judged the prior execution "still read too much like accelerated snapshots." The
 * fix authorized there is continuity, not a new mechanism: `#engine/opening.ts`'s own
 * `resolveOpeningFrames` gained one optional `frameDensity` parameter (default unchanged, so
 * `opening.spec.ts` and `opening.test.ts` keep their exact prior frame lists), and this suite is the
 * one caller that passes a denser one. Every instant this plays is still a real governed valid-time
 * fact -- `resolveOpeningTimeline`'s own real placements, never a hardcoded or fabricated date -- and
 * no decorative particle is added anywhere in this file.
 *
 * Reuses `#browser/opening.ts` as its page module verbatim (bundled the same way opening.spec.ts
 * bundles it, for the same reason review-motion.spec.ts reuses motion.ts unchanged): it already
 * exposes exactly the capture surface this suite needs, and it already routes every mount through
 * `#browser/gpu-sync.ts`'s shared GPU completion barrier (`settleRendered`).
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { ASSEMBLE, STILL } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { OPENING_ARRIVAL_INSTANT, resolveOpeningFrames, resolveOpeningTimeline } from "#engine/opening.ts";
import { FLAT } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { allTimeMembership, resolveTemporalMembership, resolveTemporalPlacements } from "#engine/temporal.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type { OpeningCaptureRequest, OpeningCaptureWitness, OpeningFixtureWitness, OpeningPageApi } from "#browser/opening.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";

const execFileAsync = promisify(execFile);

const REVIEW_OPENING_ENABLED = process.env.REVIEW_OPENING_CAPTURES === "1";
const REVIEW_OPENING_PROJECT = "review-opening";
const ROOT_DIRECTORY = join("dist", "review-opening");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXTURE_ID = "temporal-genesis";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"].join("/");
const MORPHOLOGY: Morphology = "stellar";
const ORGANIZATION: Organization = FLAT;
// Same recorded seed opening.spec.ts already ships (4177): this is the same real opening, denser, not
// a different one.
const OPENING_SEED = 4177;
// Five times opening.spec.ts's own default (2): (8 governed steps + 1 arrival) x (10 intermediate + 1
// rest) = 99 frames, clearing the ~90-frames-per-sequence review-media floor while sampling only HOW
// each step's own already-real membership is drawn, never inventing a step.
const FRAME_DENSITY = 10;

type FrameRecord = {
  readonly fileName: string;
  readonly stepIndex: number;
  readonly instant: string;
  readonly phase: number;
  readonly rest: boolean;
  readonly phaseRendered: number;
  readonly surfaceNodeIds: readonly string[];
  readonly surfaceEdgeIds: readonly string[];
  readonly pixelSha256: string;
};

type ReviewOpeningManifest = {
  readonly schemaVersion: 1;
  readonly candidateSha: string;
  readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeCount: number; readonly edgeCount: number };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly renderer: "render3f";
    readonly morphology: Morphology;
    readonly organization: "flat";
    readonly note: "REVIEW-ONLY capture for human judgement; the closure gate this feeds evidence toward remains ui/test/browser/opening.spec.ts and the human's own look at the video.";
  };
  readonly opening: {
    readonly policy: MotionGrammar;
    readonly seed: number;
    readonly frameDensity: number;
    readonly narration: "real-history";
    readonly timeline: readonly { readonly stepIndex: number; readonly instant: string }[];
  };
  readonly foundation: { readonly fileName: string; readonly pixelSha256: string };
  readonly arrival: { readonly fileName: string; readonly pixelSha256: string; readonly matchesFoundation: true };
  readonly determinism: { readonly repeatedFrameListIdentical: true };
  readonly frames: readonly FrameRecord[];
};

test("CAP-13 review-opening dense real-history growth (assemble, frameDensity=10), landing byte-identically on the accepted static foundation", async ({ page }, testInfo) => {
  test.skip(!REVIEW_OPENING_ENABLED || testInfo.project.name !== REVIEW_OPENING_PROJECT, "run this through the dedicated review-opening project");
  if (!REVIEW_OPENING_ENABLED || testInfo.project.name !== REVIEW_OPENING_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const candidateSha = await gitHeadSha();
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph: VisualGraph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = new Set(graph.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const fixtureSemanticDigest = semanticDigest(graph);
  const placements = resolveTemporalPlacements(graph);

  // The new parameter validates its input the same way the existing seed parameter already does --
  // exercised here rather than in a Node-level unit test, which this capability's write ceiling does
  // not extend to (ui/test/engine/** stays untouched).
  const invalidDensityFailure = failureMessage(() => resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED, -1));
  if (!/non-negative safe integer/.test(invalidDensityFailure)) {
    throw new Error(`resolveOpeningFrames did not refuse a negative frameDensity as expected: ${invalidDensityFailure}`);
  }
  const fractionalDensityFailure = failureMessage(() => resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED, 1.5));
  if (!/non-negative safe integer/.test(fractionalDensityFailure)) {
    throw new Error(`resolveOpeningFrames did not refuse a fractional frameDensity as expected: ${fractionalDensityFailure}`);
  }

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);

    // The accepted static foundation, captured fresh in this same run -- graded against, never
    // assumed. Still, reduced motion, matching opening.spec.ts's own definition of "foundation"
    // exactly: this suite's own denser Assemble arrival is what must match IT, not the reverse.
    const foundation = await requestCapture(page, "00-foundation", STILL, { instant: OPENING_ARRIVAL_INSTANT, phase: undefined, reducedMotion: true }, -1, true);

    const timeline = resolveOpeningTimeline(graph);
    expect(timeline.length).toBeGreaterThan(0);
    const frames = resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED, FRAME_DENSITY);
    expect(frames.length).toBe((timeline.length + 1) * (FRAME_DENSITY + 1));
    expect(frames.length).toBeGreaterThanOrEqual(90);

    const frameRecords: FrameRecord[] = [];
    for (const [index, frame] of frames.entries()) {
      const isFinalArrival = index === frames.length - 1;
      const fileNameStem = `01-frame-${String(index).padStart(3, "0")}-step${frame.stepIndex}-${frame.rest ? "rest" : "sweep"}`;
      const record = await requestCapture(
        page,
        fileNameStem,
        ASSEMBLE,
        isFinalArrival ? { instant: frame.instant, phase: undefined, reducedMotion: true } : { instant: frame.instant, phase: frame.phase, reducedMotion: false },
        frame.stepIndex,
        frame.rest,
      );
      frameRecords.push(record);
      assertCanonicalSurface(record, canonicalNodeIds, canonicalEdgeIds);
      const expectedMembership = frame.instant === OPENING_ARRIVAL_INSTANT
        ? allTimeMembership(graph)
        : resolveTemporalMembership(graph, placements, frame.instant);
      assertSameIdSet(record.surfaceNodeIds, [...expectedMembership.nodeIds], `review-opening frame ${fileNameStem} node ids`);
      assertSameIdSet(record.surfaceEdgeIds, [...expectedMembership.edgeIds], `review-opening frame ${fileNameStem} relation ids`);
    }

    const arrivalRecord = frameRecords[frameRecords.length - 1];
    if (arrivalRecord === undefined) {
      throw new Error("review-opening produced no frames");
    }
    expect(arrivalRecord.instant).toBe(OPENING_ARRIVAL_INSTANT);
    expect(arrivalRecord.rest).toBe(true);
    if (arrivalRecord.pixelSha256 !== foundation.pixelSha256) {
      throw new Error(`review-opening arrival did not land on the accepted static foundation byte-identically (${arrivalRecord.pixelSha256} vs ${foundation.pixelSha256})`);
    }

    const distinctPixelHashes = new Set(frameRecords.map((record) => record.pixelSha256));
    if (distinctPixelHashes.size < 2) {
      throw new Error("review-opening sequence would be vacuous: no frame visually differed from any other");
    }

    // Script-level determinism, matching opening.spec.ts's own precedent, now over the denser call.
    const repeatFrames = resolveOpeningFrames(graph, ASSEMBLE, OPENING_SEED, FRAME_DENSITY);
    expect(repeatFrames).toEqual(frames);

    const manifest: ReviewOpeningManifest = {
      schemaVersion: 1,
      candidateSha,
      fixture: { id: FIXTURE_ID, path: FIXTURE_PATH, semanticDigest: fixtureSemanticDigest, nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        renderer: "render3f",
        morphology: MORPHOLOGY,
        organization: "flat",
        note: "REVIEW-ONLY capture for human judgement; the closure gate this feeds evidence toward remains ui/test/browser/opening.spec.ts and the human's own look at the video.",
      },
      opening: {
        policy: ASSEMBLE,
        seed: OPENING_SEED,
        frameDensity: FRAME_DENSITY,
        narration: "real-history",
        timeline: timeline.map((step) => ({ stepIndex: step.stepIndex, instant: step.instant })),
      },
      foundation: { fileName: foundation.fileName, pixelSha256: foundation.pixelSha256 },
      arrival: { fileName: arrivalRecord.fileName, pixelSha256: arrivalRecord.pixelSha256, matchesFoundation: true },
      determinism: { repeatedFrameListIdentical: true },
      frames: frameRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-opening-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `review-opening: ${frameRecords.length} real-history frames (policy=assemble seed=${OPENING_SEED} frameDensity=${FRAME_DENSITY}), `
      + `${distinctPixelHashes.size} distinct rasters, arrival byte-identical to the accepted static foundation; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers -- duplicated from opening.spec.ts / review-motion.spec.ts rather than imported.
// ---------------------------------------------------------------------------------------------

function assertCanonicalSurface(record: FrameRecord, canonicalNodeIds: ReadonlySet<string>, canonicalEdgeIds: ReadonlySet<string>): void {
  for (const id of record.surfaceNodeIds) {
    if (!canonicalNodeIds.has(id)) {
      throw new Error(`review-opening capture ${record.fileName} rendered a node id absent from the canonical fixture: ${id}`);
    }
  }
  for (const id of record.surfaceEdgeIds) {
    if (!canonicalEdgeIds.has(id)) {
      throw new Error(`review-opening capture ${record.fileName} rendered a relation id absent from the canonical fixture: ${id}`);
    }
  }
}

function assertSameIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = [...actual].sort();
  const expectedSet = [...expected].sort();
  if (actualSet.length !== expectedSet.length || actualSet.some((id, index) => id !== expectedSet[index])) {
    throw new Error(`review-opening invariant failed for ${label}: ${JSON.stringify(actualSet)} !== ${JSON.stringify(expectedSet)}`);
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

async function gitHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "..", encoding: "utf8" });
  const shaValue = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(shaValue)) {
    throw new Error("review-opening suite could not determine the current commit SHA");
  }
  return shaValue;
}

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
    throw new Error("review-opening page module output is unavailable");
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
      throw new Error("review-opening page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<OpeningFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__opening;
    if (api === undefined) {
      throw new Error("review-opening page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: OpeningCaptureRequest): Promise<OpeningCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__opening;
    if (api === undefined) {
      throw new Error("review-opening page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function requestCapture(
  page: Page,
  fileNameStem: string,
  motionGrammar: MotionGrammar,
  extra: { readonly instant: "all-time" | string; readonly phase: number | undefined; readonly reducedMotion: boolean },
  stepIndex: number,
  rest: boolean,
): Promise<FrameRecord> {
  const request: OpeningCaptureRequest = {
    morphology: MORPHOLOGY,
    organization: ORGANIZATION,
    projection: "2d",
    motionGrammar,
    instant: extra.instant,
    reducedMotion: extra.reducedMotion,
    ...(extra.phase === undefined ? {} : { phase: extra.phase }),
  };
  const witness = await invokeCapture(page, request);
  const fileName = `${fileNameStem}.png`;
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#opening-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const image = decodePng(bytes, fileName);
  const dimensions = pngDimensions(bytes, fileName);
  if (dimensions.width !== CAPTURE_WIDTH || dimensions.height !== CAPTURE_HEIGHT) {
    throw new Error(`review-opening frame ${fileName} has unexpected dimensions ${dimensions.width}x${dimensions.height}`);
  }
  assertDarkestShippingField(image, `review-opening ${fileName}`);
  if (witness.surface.nodeIds.length > 0) {
    assertLitPixelFloor(image, `review-opening ${fileName}`);
  }
  return {
    fileName,
    stepIndex,
    instant: extra.instant,
    phase: extra.phase ?? witness.phaseRendered,
    rest,
    phaseRendered: witness.phaseRendered,
    surfaceNodeIds: [...witness.surface.nodeIds],
    surfaceEdgeIds: [...witness.surface.edgeIds],
    pixelSha256: pixelSha256(image),
  };
}
