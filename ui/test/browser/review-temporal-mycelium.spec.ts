/**
 * CAP-13 human-review temporal capture: Mycelium morphology over temporal-genesis's own governed
 * valid-time history. The prior human-review package (`ui/test/browser/temporal.spec.ts`,
 * `ui/test/browser/opening.spec.ts`) rendered every temporal artifact under `stellar`/`flat`; this is
 * the Mycelium temporal artifact the human review disposition named as a required gap. Review media,
 * like `review-motion.spec.ts`: nothing here adds a closure criterion, but every membership assertion
 * below is real, and a genuine mismatch fails the run.
 *
 * Reuses `#browser/temporal.ts` as its page module verbatim (bundled the same way temporal.spec.ts
 * bundles it), for the same reason review-motion.spec.ts reuses motion.ts unchanged: it already
 * exposes exactly the capture surface this suite needs (prepare/capture, a governed `membership` field
 * resolved in-browser by real, unmodified `#engine/temporal.ts` calls, and a `surface` field read back
 * from the MOUNTED renderer), and it already routes every mount through `#browser/gpu-sync.ts`'s
 * shared GPU completion barrier (`settleRendered`).
 *
 * Growth policy: Assemble. It is the only shipped policy whose own resting phase (`restingPhase` in
 * `#engine/motion-grammar.ts`) is genuine full construction from a genuinely empty phase-0 pose (see
 * `#engine/opening.ts`'s own `SWEEPING_OPENING_POLICIES` docstring for why it and RecursiveBloom alone
 * qualify), and RecursiveBloom is reserved for portal entry under the binding art direction
 * (HUMAN-REVIEW-DISPOSITION.md's policy-intents table). Assemble is therefore the only policy that can
 * show a governed instant's own membership arriving rather than merely sitting there, which is exactly
 * what "growth" requires.
 *
 * Density: the eight governed instants this fixture's own placements name
 * (`#engine/opening.ts`'s `resolveOpeningTimeline`, reused rather than re-derived, and never the
 * hardcoded T0..T7 literals `temporal.spec.ts`/`opening.test.ts` keep for their own falsification
 * assertions) are the historical truth; at each one, twelve evenly spaced Assemble phases from 0
 * (entry) through 1 (rest) are sampled -- no seed, no randomness, a plain deterministic linspace,
 * because unlike `#engine/opening.ts`'s own intermediate-frame sampling (which exists to add visual
 * variety across a whole scripted opening) this suite wants only maximum, evenly paced continuity
 * within one instant's own construction. This is visual interpolation of HOW that instant's own
 * already-governed membership is drawn, never of WHICH elements belong to it: at every one of the 96
 * frames below, the mounted scene's own surface witness is compared directly against the SAME
 * capture's own governed `membership` field (resolved in-browser by temporal.ts, never recomputed here)
 * -- not only at the eight resting frames the human-review disposition asks for, but at every
 * intermediate frame too, matching temporal.spec.ts's own falsification-5 invariant (MotionGrammar
 * changes HOW, never WHAT) one instant at a time.
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
import { ASSEMBLE, restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import type { Morphology } from "#engine/morphology.ts";
import { resolveOpeningTimeline } from "#engine/opening.ts";
import type { OpeningTemporalStep } from "#engine/opening.ts";
import { FLAT } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { resolveTemporalPlacements, temporalClassCounts } from "#engine/temporal.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions, sha256 } from "#browser/png-codec.ts";
import type { TemporalCaptureRequest, TemporalCaptureWitness, TemporalFixtureWitness, TemporalPageApi } from "#browser/temporal.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";

const execFileAsync = promisify(execFile);

const REVIEW_TEMPORAL_ENABLED = process.env.REVIEW_TEMPORAL_CAPTURES === "1";
const REVIEW_TEMPORAL_PROJECT = "review-temporal";
const ROOT_DIRECTORY = join("dist", "review-temporal");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXTURE_ID = "temporal-genesis";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"].join("/");
const MORPHOLOGY: Morphology = "mycelium";
const ORGANIZATION: Organization = FLAT;
const PROJECTION: "2d" | "3d" = "2d";
const MOTION_GRAMMAR: MotionGrammar = ASSEMBLE;
const REST_PHASE = restingPhase(ASSEMBLE);
const FRAMES_PER_INSTANT = 12;
// Evenly spaced across the closed interval [0, 1]: i/(FRAMES_PER_INSTANT-1), so the very last sample
// of every instant lands exactly on Assemble's own resting phase.
const PHASES: readonly number[] = Array.from({ length: FRAMES_PER_INSTANT }, (_, index) => index / (FRAMES_PER_INSTANT - 1));

type FrameRecord = {
  readonly fileName: string;
  readonly stepIndex: number;
  readonly instant: string;
  readonly phase: number;
  readonly rest: boolean;
  readonly phaseRendered: number;
  readonly membershipNodeIds: readonly string[];
  readonly membershipEdgeIds: readonly string[];
  readonly surfaceNodeIds: readonly string[];
  readonly surfaceEdgeIds: readonly string[];
  readonly rawFileSha256: string;
};

type ReviewTemporalManifest = {
  readonly schemaVersion: 1;
  readonly candidateSha: string;
  readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeCount: number; readonly edgeCount: number };
  readonly temporalClassCounts: { readonly explicit: number; readonly derived: number; readonly unknown: number };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly reducedMotion: false;
    readonly renderer: "render3f";
    readonly morphology: Morphology;
    readonly organization: "flat";
    readonly motionGrammar: MotionGrammar;
    readonly note: "REVIEW-ONLY capture for human motion/temporal judgement; the two closure gates this feeds evidence toward remain ui/test/browser/temporal.spec.ts and the human's own look at the video.";
  };
  readonly timeline: readonly { readonly stepIndex: number; readonly instant: string }[];
  readonly membershipInvariant: { readonly checkedFrames: number; readonly everyFrameMatchedGovernedMembership: true };
  readonly frames: readonly FrameRecord[];
};

test("CAP-13 review-temporal Mycelium valid-time growth, densely sampled, membership pinned at every governed instant", async ({ page }, testInfo) => {
  test.skip(!REVIEW_TEMPORAL_ENABLED || testInfo.project.name !== REVIEW_TEMPORAL_PROJECT, "run this through the dedicated review-temporal project");
  if (!REVIEW_TEMPORAL_ENABLED || testInfo.project.name !== REVIEW_TEMPORAL_PROJECT) {
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
  const classCounts = temporalClassCounts(placements);
  expect(classCounts).toEqual({ explicit: 8, derived: 13, unknown: 1 });

  const timeline: readonly OpeningTemporalStep[] = resolveOpeningTimeline(graph);
  expect(timeline.length).toBe(8);

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const frames: FrameRecord[] = [];
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);
    expect(fixtureWitness.classCounts).toEqual(classCounts);

    for (const step of timeline) {
      for (const [sampleIndex, phase] of PHASES.entries()) {
        const rest = phase === REST_PHASE;
        const request: TemporalCaptureRequest = {
          morphology: MORPHOLOGY,
          organization: ORGANIZATION,
          projection: PROJECTION,
          motionGrammar: MOTION_GRAMMAR,
          instant: step.instant,
          phase,
          reducedMotion: false,
        };
        const fileName = `frame-step${step.stepIndex}-${String(sampleIndex).padStart(2, "0")}${rest ? "-rest" : ""}.png`;
        const rendered = await renderFrame(page, request, fileName);
        expect(rendered.witness.phaseRendered).toBe(phase);

        assertCanonicalSurface(rendered.witness, canonicalNodeIds, canonicalEdgeIds, fileName);
        // The non-negotiable rule this suite exists to demonstrate: rendered membership, read back
        // from the MOUNTED scene's own surface witness, equals the SAME capture's own governed
        // `membership` field -- resolved in-browser by real, unmodified temporal.ts logic, never
        // recomputed here -- at every one of the 96 frames, not only the eight resting ones.
        assertSameIdSet(rendered.witness.surface.nodeIds, rendered.witness.membership.nodeIds, `${fileName} node ids (surface vs governed membership)`);
        assertSameIdSet(rendered.witness.surface.edgeIds, rendered.witness.membership.edgeIds, `${fileName} relation ids (surface vs governed membership)`);

        if (rendered.witness.membership.nodeIds.length > 0) {
          assertLitPixelFloor(rendered.image, `review-temporal ${fileName}`);
        }
        assertDarkestShippingField(rendered.image, `review-temporal ${fileName}`);

        frames.push({
          fileName,
          stepIndex: step.stepIndex,
          instant: step.instant,
          phase,
          rest,
          phaseRendered: rendered.witness.phaseRendered,
          membershipNodeIds: rendered.witness.membership.nodeIds,
          membershipEdgeIds: rendered.witness.membership.edgeIds,
          surfaceNodeIds: rendered.witness.surface.nodeIds,
          surfaceEdgeIds: rendered.witness.surface.edgeIds,
          rawFileSha256: rendered.rawFileSha256,
        });
      }
    }

    expect(frames.length).toBe(timeline.length * FRAMES_PER_INSTANT);
    expect(frames.length).toBeGreaterThanOrEqual(90);
    const restFrames = frames.filter((frame) => frame.rest);
    expect(restFrames.length).toBe(timeline.length);
    // Membership must genuinely grow (or at least never invent/lose a governed element across
    // instants that are not actually monotonic) -- checked here as a sanity bound, not re-derived:
    // every resting frame's own membership is exactly what that SAME frame's own governed
    // `membership` field says, which the per-frame loop above already asserted against the surface.
    // This distinct-pixel check guards against a vacuous sequence where every frame rendered
    // identically despite the phase and instant both changing.
    const distinctPixelHashes = new Set(frames.map((frame) => frame.rawFileSha256));
    if (distinctPixelHashes.size < 2) {
      throw new Error("review-temporal Mycelium sequence would be vacuous: no frame visually differed from any other");
    }

    const manifest: ReviewTemporalManifest = {
      schemaVersion: 1,
      candidateSha,
      fixture: { id: FIXTURE_ID, path: FIXTURE_PATH, semanticDigest: fixtureSemanticDigest, nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      temporalClassCounts: classCounts,
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        reducedMotion: false,
        renderer: "render3f",
        morphology: MORPHOLOGY,
        organization: "flat",
        motionGrammar: MOTION_GRAMMAR,
        note: "REVIEW-ONLY capture for human motion/temporal judgement; the two closure gates this feeds evidence toward remain ui/test/browser/temporal.spec.ts and the human's own look at the video.",
      },
      timeline: timeline.map((step) => ({ stepIndex: step.stepIndex, instant: step.instant })),
      membershipInvariant: { checkedFrames: frames.length, everyFrameMatchedGovernedMembership: true },
      frames,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-temporal-mycelium-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `review-temporal: ${frames.length} frames across ${timeline.length} governed instants (mycelium/assemble), `
      + `${distinctPixelHashes.size} distinct rasters, membership matched governed state at every frame; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers -- duplicated from temporal.spec.ts / review-motion.spec.ts rather than imported (neither
// file exports anything this suite is allowed to import from).
// ---------------------------------------------------------------------------------------------

type RenderedFrame = {
  readonly witness: TemporalCaptureWitness;
  readonly image: { readonly width: number; readonly height: number; readonly data: Buffer };
  readonly rawFileSha256: string;
};

async function renderFrame(page: Page, request: TemporalCaptureRequest, fileName: string): Promise<RenderedFrame> {
  const witness = await invokeCapture(page, request);
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#temporal-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const dimensions = pngDimensions(bytes, fileName);
  if (dimensions.width !== CAPTURE_WIDTH || dimensions.height !== CAPTURE_HEIGHT) {
    throw new Error(`review-temporal frame ${fileName} has unexpected dimensions ${dimensions.width}x${dimensions.height}`);
  }
  const image = decodePng(bytes, fileName);
  return { witness, image, rawFileSha256: sha256(bytes) };
}

function assertCanonicalSurface(
  witness: TemporalCaptureWitness,
  canonicalNodeIds: ReadonlySet<string>,
  canonicalEdgeIds: ReadonlySet<string>,
  label: string,
): void {
  for (const id of witness.surface.nodeIds) {
    if (!canonicalNodeIds.has(id)) {
      throw new Error(`review-temporal capture ${label} rendered a node id absent from the canonical fixture: ${id}`);
    }
  }
  for (const id of witness.surface.edgeIds) {
    if (!canonicalEdgeIds.has(id)) {
      throw new Error(`review-temporal capture ${label} rendered a relation id absent from the canonical fixture: ${id}`);
    }
  }
}

function assertSameIdSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = [...actual].sort();
  const expectedSet = [...expected].sort();
  if (actualSet.length !== expectedSet.length || actualSet.some((id, index) => id !== expectedSet[index])) {
    throw new Error(`review-temporal invariant failed for ${label}: ${JSON.stringify(actualSet)} !== ${JSON.stringify(expectedSet)}`);
  }
}

async function gitHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "..", encoding: "utf8" });
  const shaValue = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(shaValue)) {
    throw new Error("review-temporal suite could not determine the current commit SHA");
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
    entryPoints: [["test", "browser", "temporal.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("review-temporal page module output is unavailable");
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
      throw new Error("review-temporal page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<TemporalFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__temporal;
    if (api === undefined) {
      throw new Error("review-temporal page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: TemporalCaptureRequest): Promise<TemporalCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__temporal;
    if (api === undefined) {
      throw new Error("review-temporal page module is unavailable");
    }
    return api.capture(value);
  }, request);
}
