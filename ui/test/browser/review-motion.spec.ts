/**
 * CAP-13 human-review motion capture. This produces PNG frame sequences dense enough to encode into
 * video for final human motion judgement (easing, continuity, propagation, rhythm, spatial coherence,
 * blinking/flicker, edge/node attachment, negative-space behaviour) -- properties a 3-9 phase strip,
 * such as motion.spec.ts's own M1/M2/ablation, cannot show. It is review media, not a gate: nothing
 * here asserts a score or a closure criterion, and it must never be read as adding one. It renders
 * MotionGrammar at phases motion.spec.ts's own suites never sample, but MotionGrammar itself is
 * unchanged by this suite -- `buildScene` is a pure phase function with no clock, so a denser sample of
 * that same function creates no new semantics, only a denser view of what already exists.
 *
 * Reuses `#browser/motion.ts` as its page module verbatim (bundled the same way motion.spec.ts bundles
 * it) rather than writing a second one: it already exposes exactly the capture surface this suite
 * needs (MotionCaptureRequest/prepare/capture), and it already routes every mount through
 * `#browser/gpu-sync.ts`'s shared GPU completion barrier (`settleRendered`), which this suite depends
 * on for the same reason every other capture suite in this directory does -- a screenshot taken before
 * the GL command stream completes is not a screenshot of the frame that was requested.
 *
 * Two sequences, both on one controlled configuration: fixture discovery-at-question (the smaller of
 * the two governed fixtures), morphology stellar, organization indra, projection 3d, DEFAULT_CALIBRATION
 * (never overridden -- `mount()`'s own `calibration` option is omitted throughout, so `buildScene`
 * resolves its own default), reducedMotion false so a requested phase actually renders.
 *
 * A-motiongrammar: each of the seven MOTION_GRAMMARS policies (including Still, the no-motion control),
 * 48 phases evenly spaced across [0, 1) (i/48 for i in 0..47), in ascending phase order, no navigation
 * -- the full prepared fixture, framed by the one camera `prepare()` derives once and every capture
 * below reuses (motion.ts's own `fixtureCamera` precedent), so the camera never moves across a policy's
 * own frames and comparing frames within a policy is never confounded by reframing. `scaleTopology` is
 * held constant at HIERARCHICAL as metadata only (mirrors motion.spec.ts's own M1: recorded on
 * VisualState, but nothing here navigates, so it has no effect on what is rendered).
 *
 * C-recursive-vs-holographic: one real navigation event (entering the fixture's own strongest
 * containment child world, depth 1, via `enterChildWorld`) walked under both scaleTopology policies,
 * both animated with Reconfigure -- chosen, as motion.spec.ts's own M2 reasons, because it modulates
 * every already-present element uniformly with no staggered-arrival suppression, rather than Assemble's
 * construction window holding newly-arrived elements collapsed near their parent at low phase. Unlike
 * motion.spec.ts's own M2, this is not blind (directories are named plainly, for side-by-side viewing)
 * and uses ONE camera fixed for the entire sequence -- derived once from Holographic's own phase-0
 * capture (the superset topology, so its own anchors bound Recursive's as well) and passed as
 * `sharedCamera` to every one of the 96 frames -- rather than M2's own per-phase camera, because the
 * brief for this suite asks for one shared camera across the whole pair, not a camera that itself
 * tracks each policy's motion.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { MOTION_GRAMMARS, RECONFIGURE, STILL } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import type { Morphology } from "#engine/morphology.ts";
import { INDRA } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import {
  HIERARCHICAL,
  HOLOGRAPHIC,
  RECURSIVE,
  childWorld,
  enterChildWorld,
  enterableKind,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import type { ScaleNavigationPath, ScaleTopology } from "#engine/scale-topology.ts";
import type { VisualStateCamera } from "#engine/visual-state.ts";
import { pngDimensions, sha256, sha256Text } from "#browser/png-codec.ts";
import type { MotionCaptureRequest, MotionCaptureWitness, MotionFixtureWitness, MotionPageApi } from "#browser/motion.ts";

const execFileAsync = promisify(execFile);

const REVIEW_MOTION_ENABLED = process.env.REVIEW_MOTION_CAPTURES === "1";
const REVIEW_MOTION_PROJECT = "review-motion";
const ROOT_DIRECTORY = join("dist", "review-motion");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXTURE = {
  id: "discovery-at-question",
  path: ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/"),
} as const;
const MORPHOLOGY: Morphology = "stellar";
const ORGANIZATION: Organization = INDRA;
const PROJECTION: "2d" | "3d" = "3d";
const FRAME_COUNT = 48;
// Evenly spaced across the half-open interval [0, 1): i/FRAME_COUNT for i in 0..FRAME_COUNT-1. Never
// reaches 1 itself, since a cyclic policy's phase 1 is (by every shipped policy's own construction,
// see motion-grammar.ts) identical to its phase 0 -- sampling both would render one pair of duplicate
// frames for no reason.
const PHASES: readonly number[] = Array.from({ length: FRAME_COUNT }, (_, index) => index / FRAME_COUNT);
const CALIBRATION_DIGEST = sha256Text(JSON.stringify(DEFAULT_CALIBRATION));

type SequenceFrameRecord = {
  readonly phase: number;
  readonly fileName: string;
  readonly rawFileSha256: string;
};

type SequenceManifestEntry = {
  readonly sequenceId: string;
  readonly motionGrammar: MotionGrammar;
  readonly phases: readonly number[];
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly scaleTopology: ScaleTopology;
  readonly projection: "2d" | "3d";
  readonly navigated: boolean;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly frames: readonly SequenceFrameRecord[];
  readonly distinctRawFrameCount: number;
};

type CaptureConfiguration = {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: 1;
  readonly reducedMotion: false;
  readonly renderer: "render3f";
  readonly calibrationDigest: string;
  readonly note: "REVIEW-ONLY capture for human motion judgement; not product timing, not a closure gate.";
};

// ---------------------------------------------------------------------------------------------
// A: each shipped motion policy, densely sampled.
// ---------------------------------------------------------------------------------------------

test("CAP-13 review-motion A-motiongrammar dense per-policy sampling", async ({ page }, testInfo) => {
  test.skip(!REVIEW_MOTION_ENABLED || testInfo.project.name !== REVIEW_MOTION_PROJECT, "run this through the dedicated review-motion project");
  if (!REVIEW_MOTION_ENABLED || testInfo.project.name !== REVIEW_MOTION_PROJECT) {
    return;
  }
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  expect(devicePixelRatio).toBe(1);

  const candidateSha = await gitHeadSha();
  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE.path), "utf8"));
  const canonicalGraph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(canonicalGraph);
  const canonicalSemanticDigest = semanticDigest(canonicalGraph);

  const outputDirectory = join(ROOT_DIRECTORY, "A-motiongrammar");
  await mkdir(outputDirectory, { recursive: true });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE.path);
    expect(fixtureWitness.semanticDigest).toBe(canonicalSemanticDigest);

    const sequences: SequenceManifestEntry[] = [];
    for (const policy of MOTION_GRAMMARS) {
      const policyDirectory = join(outputDirectory, policy);
      await mkdir(policyDirectory, { recursive: true });
      const frames: SequenceFrameRecord[] = [];
      let nodeIds: readonly string[] | undefined;
      let edgeIds: readonly string[] | undefined;
      for (const [index, phase] of PHASES.entries()) {
        const request: MotionCaptureRequest = {
          morphology: MORPHOLOGY,
          organization: ORGANIZATION,
          projection: PROJECTION,
          motionGrammar: policy,
          scaleTopology: HIERARCHICAL,
          reducedMotion: false,
          phase,
        };
        const fileName = `frame-${String(index).padStart(3, "0")}.png`;
        const rendered = await renderFrame(page, request, policyDirectory, fileName);
        expect(rendered.witness.phaseRendered).toBe(phase);
        if (rendered.witness.surface.nodeIds.length === 0 || rendered.witness.surface.edgeIds.length === 0) {
          throw new Error(`review-motion A ${policy} frame ${fileName} mounted an empty visible surface`);
        }
        if (nodeIds === undefined || edgeIds === undefined) {
          nodeIds = [...rendered.witness.surface.nodeIds].sort();
          edgeIds = [...rendered.witness.surface.edgeIds].sort();
        }
        frames.push({ phase, fileName: join("A-motiongrammar", policy, fileName), rawFileSha256: rendered.rawFileSha256 });
      }
      if (nodeIds === undefined || edgeIds === undefined) {
        throw new Error(`review-motion A ${policy} rendered no frames`);
      }
      sequences.push({
        sequenceId: policy,
        motionGrammar: policy,
        phases: PHASES,
        morphology: MORPHOLOGY,
        organization: ORGANIZATION,
        scaleTopology: HIERARCHICAL,
        projection: PROJECTION,
        navigated: false,
        nodeIds,
        edgeIds,
        frames,
        distinctRawFrameCount: new Set(frames.map((frame) => frame.rawFileSha256)).size,
      });
    }

    const stillSequence = sequences.find((sequence) => sequence.motionGrammar === STILL);
    if (stillSequence === undefined) {
      throw new Error("review-motion A did not render the still control");
    }
    process.stdout.write(
      `review-motion A: ${sequences.length} policies x ${FRAME_COUNT} frames; `
      + `still distinct-frame count (expected 1, the control) = ${stillSequence.distinctRawFrameCount}; `
      + sequences.filter((sequence) => sequence.motionGrammar !== STILL).map((sequence) => `${sequence.motionGrammar}=${sequence.distinctRawFrameCount}`).join(", ")
      + "\n",
    );

    const captureConfiguration: CaptureConfiguration = {
      viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      devicePixelRatio: 1,
      reducedMotion: false,
      renderer: "render3f",
      calibrationDigest: CALIBRATION_DIGEST,
      note: "REVIEW-ONLY capture for human motion judgement; not product timing, not a closure gate.",
    };
    const manifest = {
      schemaVersion: 1,
      candidateSha,
      fixture: { id: FIXTURE.id, path: FIXTURE.path, semanticDigest: canonicalSemanticDigest },
      captureConfiguration,
      sequences,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-motion-a-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`review-motion A manifest=${manifestFile}\n`);
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// C: Recursive vs Holographic under motion, one navigation event, one shared camera.
// ---------------------------------------------------------------------------------------------

const C_MOTION_GRAMMAR: MotionGrammar = RECONFIGURE;
const C_TOPOLOGIES = [RECURSIVE, HOLOGRAPHIC] as const satisfies readonly ScaleTopology[];

test("CAP-13 review-motion C-recursive-vs-holographic dense pair under one shared camera", async ({ page }, testInfo) => {
  test.skip(!REVIEW_MOTION_ENABLED || testInfo.project.name !== REVIEW_MOTION_PROJECT, "run this through the dedicated review-motion project");
  if (!REVIEW_MOTION_ENABLED || testInfo.project.name !== REVIEW_MOTION_PROJECT) {
    return;
  }
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  expect(devicePixelRatio).toBe(1);

  const candidateSha = await gitHeadSha();
  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE.path), "utf8"));
  const canonicalGraph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(canonicalGraph);
  const canonicalSemanticDigest = semanticDigest(canonicalGraph);

  const containmentRootId = strongestContainmentRoot(canonicalGraph);
  const recursivePath = enterChildWorld(canonicalGraph, rootNavigationPath(RECURSIVE), containmentRootId);
  const holographicPath = enterChildWorld(canonicalGraph, rootNavigationPath(HOLOGRAPHIC), containmentRootId);
  const pathByTopology: Readonly<Record<"recursive" | "holographic", ScaleNavigationPath>> = {
    recursive: recursivePath,
    holographic: holographicPath,
  };

  const outputDirectory = join(ROOT_DIRECTORY, "C-recursive-vs-holographic");
  await mkdir(outputDirectory, { recursive: true });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE.path);
    expect(fixtureWitness.semanticDigest).toBe(canonicalSemanticDigest);

    // The one shared camera for the whole pair: Holographic's own, refit from its own rendered anchors
    // at phase 0 (motion.ts's own navigationPath refit, see motion.ts's `capture()`), since Holographic
    // is the superset topology and its anchor extent bounds Recursive's own. Read back off the mounted
    // renderer, never recomputed here, and reused unmodified for every one of the 96 frames below.
    const cameraProbeRequest: MotionCaptureRequest = {
      morphology: MORPHOLOGY,
      organization: ORGANIZATION,
      projection: PROJECTION,
      motionGrammar: C_MOTION_GRAMMAR,
      scaleTopology: HOLOGRAPHIC,
      navigationPath: holographicPath,
      reducedMotion: false,
      phase: 0,
    };
    const cameraProbeWitness = await invokeCapture(page, cameraProbeRequest);
    const sharedCamera: VisualStateCamera = cameraProbeWitness.visualState.camera;

    const sequences: SequenceManifestEntry[] = [];
    for (const topology of C_TOPOLOGIES) {
      const topologyDirectory = join(outputDirectory, topology);
      await mkdir(topologyDirectory, { recursive: true });
      const navigationPath = pathByTopology[topology === RECURSIVE ? "recursive" : "holographic"];
      const frames: SequenceFrameRecord[] = [];
      let nodeIds: readonly string[] | undefined;
      let edgeIds: readonly string[] | undefined;
      for (const [index, phase] of PHASES.entries()) {
        const request: MotionCaptureRequest = {
          morphology: MORPHOLOGY,
          organization: ORGANIZATION,
          projection: PROJECTION,
          motionGrammar: C_MOTION_GRAMMAR,
          scaleTopology: topology,
          navigationPath,
          sharedCamera,
          reducedMotion: false,
          phase,
        };
        const fileName = `frame-${String(index).padStart(3, "0")}.png`;
        const rendered = await renderFrame(page, request, topologyDirectory, fileName);
        expect(rendered.witness.phaseRendered).toBe(phase);
        if (rendered.witness.surface.nodeIds.length === 0 || rendered.witness.surface.edgeIds.length === 0) {
          throw new Error(`review-motion C ${topology} frame ${fileName} mounted an empty visible surface`);
        }
        if (nodeIds === undefined || edgeIds === undefined) {
          nodeIds = [...rendered.witness.surface.nodeIds].sort();
          edgeIds = [...rendered.witness.surface.edgeIds].sort();
        }
        frames.push({ phase, fileName: join("C-recursive-vs-holographic", topology, fileName), rawFileSha256: rendered.rawFileSha256 });
      }
      if (nodeIds === undefined || edgeIds === undefined) {
        throw new Error(`review-motion C ${topology} rendered no frames`);
      }
      sequences.push({
        sequenceId: topology,
        motionGrammar: C_MOTION_GRAMMAR,
        phases: PHASES,
        morphology: MORPHOLOGY,
        organization: ORGANIZATION,
        scaleTopology: topology,
        projection: PROJECTION,
        navigated: true,
        nodeIds,
        edgeIds,
        frames,
        distinctRawFrameCount: new Set(frames.map((frame) => frame.rawFileSha256)).size,
      });
    }

    const recursiveSequence = sequences.find((sequence) => sequence.scaleTopology === RECURSIVE);
    const holographicSequence = sequences.find((sequence) => sequence.scaleTopology === HOLOGRAPHIC);
    if (recursiveSequence === undefined || holographicSequence === undefined) {
      throw new Error("review-motion C requires both a recursive and a holographic sequence");
    }
    process.stdout.write(
      `review-motion C: recursive=${recursiveSequence.nodeIds.length}n/${recursiveSequence.edgeIds.length}e `
      + `holographic=${holographicSequence.nodeIds.length}n/${holographicSequence.edgeIds.length}e `
      + `over ${FRAME_COUNT} phases each, one shared camera, motionGrammar=${C_MOTION_GRAMMAR}\n`,
    );

    const captureConfiguration: CaptureConfiguration = {
      viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      devicePixelRatio: 1,
      reducedMotion: false,
      renderer: "render3f",
      calibrationDigest: CALIBRATION_DIGEST,
      note: "REVIEW-ONLY capture for human motion judgement; not product timing, not a closure gate.",
    };
    const manifest = {
      schemaVersion: 1,
      candidateSha,
      fixture: { id: FIXTURE.id, path: FIXTURE.path, semanticDigest: canonicalSemanticDigest },
      containmentRootId,
      sharedCamera: { source: "holographic-phase-0-navigated-anchor-refit", camera: sharedCamera },
      captureConfiguration,
      sequences,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-motion-c-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`review-motion C manifest=${manifestFile}\n`);
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Shared helpers -- duplicated from motion.spec.ts rather than imported (that file exports nothing
// this suite is allowed to import from), for the same reason motion.spec.ts's own helpers are already
// duplicated from scale-topology.spec.ts.
// ---------------------------------------------------------------------------------------------

type RenderedFrame = {
  readonly fileName: string;
  readonly filePath: string;
  readonly witness: MotionCaptureWitness;
  readonly rawFileSha256: string;
  readonly dimensions: { readonly width: number; readonly height: number };
};

async function renderFrame(
  page: Page,
  request: MotionCaptureRequest,
  outputDirectory: string,
  fileName: string,
): Promise<RenderedFrame> {
  const witness = await invokeCapture(page, request);
  const filePath = join(outputDirectory, fileName);
  await page.locator("#motion-root").screenshot({ path: filePath });
  const bytes = await readFile(filePath);
  const dimensions = pngDimensions(bytes, fileName);
  if (dimensions.width !== CAPTURE_WIDTH || dimensions.height !== CAPTURE_HEIGHT) {
    throw new Error(`review-motion frame ${fileName} has unexpected dimensions ${dimensions.width}x${dimensions.height}`);
  }
  return { fileName, filePath, witness, rawFileSha256: sha256(bytes), dimensions };
}

/** This finds the largest containment child world the fixture actually declares, mirroring motion.spec.ts's own `strongestContainmentRoot` (itself mirroring scale-topology.spec.ts's own, for the same reason: no exported source to import it from). */
function strongestContainmentRoot(graph: VisualGraph): string {
  let best: { readonly id: string; readonly size: number } | undefined;
  for (const node of graph.nodes) {
    if (node.kind !== "cluster" && node.kind !== "conflict") {
      continue;
    }
    if (enterableKind(graph, node.id, RECURSIVE) !== "containment") {
      continue;
    }
    const world = childWorld(graph, node.id, "containment");
    if (world.nodeIds.length > 1 && (best === undefined || world.nodeIds.length > best.size)) {
      best = { id: node.id, size: world.nodeIds.length };
    }
  }
  if (best === undefined) {
    throw new Error(`review-motion fixture ${FIXTURE.id} has no populated containment root`);
  }
  return best.id;
}

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "motion.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("review-motion page module output is unavailable");
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
    const api = window.__motion;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<MotionPageApi> {
  return page.evaluate(() => {
    const api = window.__motion;
    if (api === undefined) {
      throw new Error("review-motion page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<MotionFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__motion;
    if (api === undefined) {
      throw new Error("review-motion page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: MotionCaptureRequest): Promise<MotionCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__motion;
    if (api === undefined) {
      throw new Error("review-motion page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function gitHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "..", encoding: "utf8" });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("review-motion suite could not determine the current commit SHA");
  }
  return sha;
}
