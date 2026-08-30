/**
 * CAP-13 Phase B motion evidence. Feeds the three preregistered tests (M1 policy discrimination, M2
 * Recursive vs Holographic under motion, M3 the Still control) fixed by MOTION-BLIND-PREREGISTRATION.md
 * before any motion existed; this suite produces artifacts, it does not score them.
 *
 * M3 -- byte identity of Still against the frozen static baseline -- is checked first, exactly as the
 * brief requires: a motion axis that perturbs its own zero state would invalidate every static result
 * beneath it.
 *
 * M1 and M2 both require rendered frame strips sampled at several PHASES through one policy cycle.
 * `#render3f/mount.tsx` (the one production DOM entry point every sibling evidence suite in this
 * directory renders through) never threads a `phase` argument into any of its own `buildScene` calls --
 * not at bootstrap, not in `scenesForState`, not in `applyMaterialState` -- so every scene it mounts is
 * always built at `restingPhase(motionGrammar)`, and at a policy's own resting phase every policy's
 * modulation is exact identity (assertRestingCompleteness in #engine/motion-grammar.ts): every policy's
 * resting frame is pixel-identical to Still's. Rendering any OTHER phase through the real renderer
 * requires a change to `ui/src/render3f/mount.tsx` (or an equivalent DOM entry point), which is outside
 * this suite's write ceiling. M1 and M2 are reported RED below, with this exact finding, rather than
 * built from resting-phase-only frames that would not show what any policy actually does, or from a
 * second, unaudited rendering path assembled from mount.tsx's internals that would not be verified
 * against the one renderer every other suite's evidence already trusts.
 *
 * What IS buildable without a source change, and is built here: M3's rendered byte-identity check; the
 * measured `motionTraceability` number per policy (a pure function of policy/phase/element ids, needing
 * no renderer); and a structural (non-pixel) modulation-trajectory record per policy, standing in for
 * the blocked "resting frame beside several phase frames" ablation and labelled as such.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import {
  MOTION_GRAMMARS,
  STILL,
  motionModulation,
  motionTraceability,
  restingPhase,
} from "#engine/motion-grammar.ts";
import type { EdgeMotionModulation, MotionElementIds, MotionGrammar, NodeMotionModulation } from "#engine/motion-grammar.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { assertMotionRestingCompleteness } from "#scene/build.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type { PixelImage } from "#browser/png-codec.ts";
import type {
  MotionCaptureRequest,
  MotionCaptureWitness,
  MotionFixtureWitness,
  MotionPageApi,
} from "#browser/motion.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

const execFileAsync = promisify(execFile);

const MOTION_ENABLED = process.env.MOTION_CAPTURES === "1";
const MOTION_PROJECT = "motion";
const MOTION_COMMAND = "npm --prefix ui run test:motion";
const ROOT_DIRECTORY = join("dist", "motion");
const MATRIX_ROOT_DIRECTORY = join("dist", "matrix");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
// Matches matrix.spec.ts's and scale-topology.spec.ts's own margin and stated reason: generous enough
// to catch a camera that crops an entire scene off frame, not to police a node a few px from the edge.
const FRAME_CONTAINMENT_MARGIN_CSS_PX = 64;
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const ORGANIZATIONS = ["flat", "indra"] as const satisfies readonly Organization[];
const PROJECTIONS = ["2d", "3d"] as const;
const FIXTURES = [
  {
    id: "discovery-at-question",
    path: ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/"),
    matrixManifest: "discovery-at-question-manifest.json",
  },
  {
    id: "indra-community-windows",
    path: ["fixtures", "synthetic", "projection", "indra", "indra-community-windows.json"].join("/"),
    matrixManifest: "indra-community-windows-manifest.json",
  },
] as const;
// discovery-at-question is the smaller of the two governed fixtures (22 nodes / 27 relations); the
// traceability measurement and the structural modulation record below need no rendering at all, so
// this only keeps the recorded trajectory small, not the runtime bounded.
const TRACEABILITY_FIXTURE = FIXTURES[0];
if (TRACEABILITY_FIXTURE === undefined) {
  throw new Error("motion suite requires at least one governed fixture");
}
// Nine samples spanning one full policy cycle at even eighths, including both endpoints.
const SAMPLE_PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

type M3CaptureRecord = {
  readonly fixtureId: string;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly motionGrammar: "still";
  readonly phaseRendered: number;
  readonly fileName: string;
  readonly pixelDimensions: { readonly width: number; readonly height: number };
  readonly candidateDecodedPixelSha256: string;
  readonly baseline: { readonly fileName: string; readonly decodedPixelSha256: string };
  readonly rawFileBytesIdentical: boolean;
  readonly decodedPixelsIdentical: boolean;
  readonly governedIdentity: { readonly nodeIdsMatchCanonical: true; readonly edgeIdsMatchCanonical: true };
};

type TraceabilityRecord = {
  readonly policy: MotionGrammar;
  readonly restingPhase: number;
  readonly samplePhases: readonly number[];
  readonly measuredTraceability: number;
};

type ModulationSampleSummary = {
  readonly phase: number;
  readonly nodes: { readonly opacityPermille: MinMaxMean; readonly scalePermille: MinMaxMean; readonly offsetMagnitudePermille: MinMaxMean };
  readonly edges: { readonly opacityPermille: MinMaxMean; readonly revealPermille: MinMaxMean };
};

type MinMaxMean = { readonly min: number; readonly max: number; readonly mean: number };

type StructuralModulationRecord = {
  readonly policy: MotionGrammar;
  readonly restingPhase: number;
  readonly samples: readonly ModulationSampleSummary[];
};

type MotionManifest = {
  readonly schemaVersion: 1;
  readonly summary: { readonly passing: true };
  readonly run: { readonly command: string; readonly trackedTree: TrackedTreeIdentity };
  readonly candidateSha: string;
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly seed: number;
    readonly reducedMotion: true;
    readonly renderer: "render3f";
    readonly calibration: typeof DEFAULT_CALIBRATION;
  };
  readonly m3StillControl: {
    readonly assertion: "Still, explicitly selected, renders byte-identically to the frozen static baseline in ui/dist/matrix/. Checked first: a motion axis that perturbs its own zero state would invalidate every static result beneath it.";
    readonly fixtures: readonly { readonly fixtureId: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }[];
    readonly frameContainmentInvariant: { readonly marginCssPx: number; readonly passed: true };
    readonly captures: readonly M3CaptureRecord[];
    readonly allByteIdentical: true;
  };
  readonly traceability: {
    readonly assertion: "The measured continuity number motionTraceability reports for each policy, computed directly and not gated on.";
    readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly samplePhases: readonly number[];
    readonly perPolicy: readonly TraceabilityRecord[];
  };
  readonly structuralModulationAblation: {
    readonly assertion: "Structural (channel-value) evidence of what each policy's own modulation does across one sampled cycle, standing in for the pixel ablation M1/M2/the static-vs-motion comparison need, which is blocked -- see `blocked` below.";
    readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly sameGovernedGraph: { readonly fixturePath: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly changedAxis: { readonly name: "motionGrammar"; readonly values: readonly MotionGrammar[]; readonly base: "still" };
    readonly heldConstant: Readonly<Record<string, string>>;
    readonly perPolicy: readonly StructuralModulationRecord[];
  };
  readonly negativeControls: {
    readonly pixelMismatch: { readonly message: string; readonly restored: true };
    readonly restingCompletenessViolation: { readonly message: string; readonly restored: true };
  };
  readonly blocked: {
    readonly m1PolicyDiscrimination: { readonly status: "RED"; readonly reason: string };
    readonly m2RecursiveVersusHolographicUnderMotion: { readonly status: "RED"; readonly reason: string };
    readonly ablationPhaseFrames: { readonly status: "RED"; readonly reason: string };
  };
};

const MOUNT_PHASE_GAP_REASON =
  "#render3f/mount.tsx never threads a phase argument into any of its own buildScene calls (bootstrap, "
  + "scenesForState, applyMaterialState all omit the sixth argument), so every mounted scene is always built "
  + "at restingPhase(motionGrammar), and every policy's resting phase is exact identity modulation "
  + "(assertRestingCompleteness) -- indistinguishable from Still. Rendering a genuine motion frame through the "
  + "one renderer this repository's evidence suites trust requires a change to ui/src/render3f/mount.tsx (or an "
  + "equivalent DOM entry point) that this suite's write ceiling forbids.";

test("CAP-13 W-MOTION motion evidence suite", async ({ page }, testInfo) => {
  test.skip(!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT, "run this through the dedicated motion project");
  if (!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  const candidateSha = await gitHeadSha();
  await rm(ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  // ---- Traceability + structural modulation ablation: pure `#engine/motion-grammar.ts` arithmetic,
  // no renderer required. ----
  const traceabilityRaw: unknown = JSON.parse(await readFile(join("..", TRACEABILITY_FIXTURE.path), "utf8"));
  const traceabilityGraph = toVisualGraph(traceabilityRaw);
  assertVisualGraphFieldRegister(traceabilityGraph);
  const traceabilityNodeIds = traceabilityGraph.nodes.map((node) => node.id).sort();
  const traceabilityEdgeIds = traceabilityGraph.edges.map((edge) => edge.id).sort();
  const traceabilitySemanticDigest = semanticDigest(traceabilityGraph);
  const elementIds: MotionElementIds = { nodeIds: traceabilityNodeIds, edgeIds: traceabilityEdgeIds };

  const perPolicyTraceability: TraceabilityRecord[] = MOTION_GRAMMARS.map((policy) => ({
    policy,
    restingPhase: restingPhase(policy),
    samplePhases: SAMPLE_PHASES,
    measuredTraceability: motionTraceability(policy, elementIds, SAMPLE_PHASES),
  }));

  const perPolicyStructural: StructuralModulationRecord[] = MOTION_GRAMMARS.map((policy) => ({
    policy,
    restingPhase: restingPhase(policy),
    samples: SAMPLE_PHASES.map((phase) => {
      const modulation = motionModulation(policy, phase, elementIds);
      return {
        phase,
        nodes: summarizeNodes(modulation.nodes),
        edges: summarizeEdges(modulation.edges),
      };
    }),
  }));

  // ---- Negative controls: prove the checks this suite depends on can genuinely fail. ----
  const pixelMismatchMessage = failedControlOutput(() => {
    const clean: PixelImage = { width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) };
    const different: PixelImage = { width: 1, height: 1, data: Buffer.from([255, 255, 255, 255]) };
    assertPixelIdentical(Buffer.from([0]), clean, Buffer.from([1]), different, "negative-control-candidate.png", "negative-control-baseline.png");
  });
  if (!pixelMismatchMessage.includes("do not match")) {
    throw new Error(`motion pixel-mismatch negative control produced the wrong failure: ${pixelMismatchMessage}`);
  }
  const restingCompletenessMessage = failedControlOutput(() => {
    assertMotionRestingCompleteness({
      policy: STILL,
      phase: restingPhase(STILL),
      nodes: [{ id: "not-a-real-node", opacityPermille: 500, scalePermille: 1_000, offsetXPermille: 0, offsetYPermille: 0 }],
      edges: [],
    });
  });
  if (!restingCompletenessMessage.includes("leaves node dark, scaled away, or displaced at its own resting phase")) {
    throw new Error(`motion resting-completeness negative control produced the wrong failure: ${restingCompletenessMessage}`);
  }

  // ---- M3: rendered evidence. Checked first among rendered claims, per the brief. ----
  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const m3Captures: M3CaptureRecord[] = [];
  const m3FixtureWitnesses: { readonly fixtureId: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }[] = [];
  try {
    for (const fixture of FIXTURES) {
      const raw: unknown = JSON.parse(await readFile(join("..", fixture.path), "utf8"));
      const canonicalGraph = toVisualGraph(raw);
      assertVisualGraphFieldRegister(canonicalGraph);
      const canonicalNodeIds = canonicalGraph.nodes.map((node) => node.id).sort();
      const canonicalEdgeIds = canonicalGraph.edges.map((edge) => edge.id).sort();
      const canonicalSemanticDigest = semanticDigest(canonicalGraph);

      const fixtureWitness = await prepareFixture(page, fixture.path);
      expect(fixtureWitness.semanticDigest).toBe(canonicalSemanticDigest);
      expect([...fixtureWitness.nodeIds]).toEqual(canonicalNodeIds);
      expect([...fixtureWitness.edgeIds]).toEqual(canonicalEdgeIds);
      m3FixtureWitnesses.push({
        fixtureId: fixture.id,
        path: fixture.path,
        semanticDigest: canonicalSemanticDigest,
        nodeIds: canonicalNodeIds,
        edgeIds: canonicalEdgeIds,
      });

      const matrixManifestPath = join(MATRIX_ROOT_DIRECTORY, fixture.matrixManifest);
      const matrixManifestBytes = await readManifestOrExplain(matrixManifestPath);
      const matrixManifest = JSON.parse(matrixManifestBytes.toString("utf8")) as {
        readonly captures: readonly { readonly morphology: string; readonly organization: string; readonly projection: string; readonly fileName: string; readonly pixelSha256: string }[];
      };
      const baselineByKey = new Map(matrixManifest.captures.map((capture) => [
        `${capture.morphology}-${capture.organization}-${capture.projection}`,
        { fileName: capture.fileName, pixelSha256: capture.pixelSha256 },
      ]));

      for (const projection of PROJECTIONS) {
        for (const organization of ORGANIZATIONS) {
          for (const morphology of MORPHOLOGIES) {
            const key = `${morphology}-${organization}-${projection}`;
            const baseline = baselineByKey.get(key);
            if (baseline === undefined) {
              throw new Error(`motion M3 requires a matrix baseline for ${fixture.id}/${key}; run ${MOTION_COMMAND.replace("motion", "matrix")} first`);
            }
            const request: MotionCaptureRequest = { morphology, organization, projection, motionGrammar: STILL };
            const witness = await invokeCapture(page, request);
            const fileName = `${fixture.id}-${key}-still.png`;
            const outputFile = join(ROOT_DIRECTORY, fileName);
            await page.locator("#motion-root").screenshot({ path: outputFile });
            const candidateBytes = await readFile(outputFile);
            const candidateImage = decodePng(candidateBytes, fileName);
            const dimensions = pngDimensions(candidateBytes, fileName);
            expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
            expect([...witness.surface.nodeIds].sort()).toEqual(canonicalNodeIds);
            expect([...witness.surface.edgeIds].sort()).toEqual(canonicalEdgeIds);
            expect(witness.phaseRendered).toBe(0);
            assertDarkestShippingField(candidateImage, `motion ${fileName}`);
            assertLitPixelFloor(candidateImage, `motion ${fileName}`);
            assertNodesInsideCapturedFrame(fileName, witness.nodeViewportPositions);

            const baselineFile = join(MATRIX_ROOT_DIRECTORY, baseline.fileName);
            const baselineBytes = await readFile(baselineFile);
            const baselineImage = decodePng(baselineBytes, baseline.fileName);
            assertPixelIdentical(candidateBytes, candidateImage, baselineBytes, baselineImage, fileName, baseline.fileName);
            const candidateDecodedPixelSha256 = pixelSha256(candidateImage);
            if (candidateDecodedPixelSha256 !== baseline.pixelSha256) {
              throw new Error(`motion M3 Still control failed: ${fileName} decoded pixel sha256 ${candidateDecodedPixelSha256} does not match matrix baseline ${baseline.pixelSha256}`);
            }

            m3Captures.push({
              fixtureId: fixture.id,
              morphology,
              organization,
              projection,
              motionGrammar: "still",
              phaseRendered: witness.phaseRendered,
              fileName,
              pixelDimensions: dimensions,
              candidateDecodedPixelSha256,
              baseline: { fileName: baseline.fileName, decodedPixelSha256: baseline.pixelSha256 },
              rawFileBytesIdentical: candidateBytes.equals(baselineBytes),
              decodedPixelsIdentical: true,
              governedIdentity: { nodeIdsMatchCanonical: true, edgeIdsMatchCanonical: true },
            });
          }
        }
      }
    }

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("motion tracked-tree digest changed while its captures were produced");
    }

    const manifest: MotionManifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: MOTION_COMMAND, trackedTree },
      candidateSha,
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        seed: DEFAULT_CALIBRATION.layout.seed,
        reducedMotion: true,
        renderer: "render3f",
        calibration: DEFAULT_CALIBRATION,
      },
      m3StillControl: {
        assertion: "Still, explicitly selected, renders byte-identically to the frozen static baseline in ui/dist/matrix/. Checked first: a motion axis that perturbs its own zero state would invalidate every static result beneath it.",
        fixtures: m3FixtureWitnesses,
        frameContainmentInvariant: { marginCssPx: FRAME_CONTAINMENT_MARGIN_CSS_PX, passed: true },
        captures: m3Captures,
        allByteIdentical: true,
      },
      traceability: {
        assertion: "The measured continuity number motionTraceability reports for each policy, computed directly and not gated on.",
        fixture: {
          id: TRACEABILITY_FIXTURE.id,
          path: TRACEABILITY_FIXTURE.path,
          semanticDigest: traceabilitySemanticDigest,
          nodeIds: traceabilityNodeIds,
          edgeIds: traceabilityEdgeIds,
        },
        samplePhases: SAMPLE_PHASES,
        perPolicy: perPolicyTraceability,
      },
      structuralModulationAblation: {
        assertion: "Structural (channel-value) evidence of what each policy's own modulation does across one sampled cycle, standing in for the pixel ablation M1/M2/the static-vs-motion comparison need, which is blocked -- see `blocked` below.",
        fixture: {
          id: TRACEABILITY_FIXTURE.id,
          path: TRACEABILITY_FIXTURE.path,
          semanticDigest: traceabilitySemanticDigest,
          nodeIds: traceabilityNodeIds,
          edgeIds: traceabilityEdgeIds,
        },
        sameGovernedGraph: {
          fixturePath: TRACEABILITY_FIXTURE.path,
          semanticDigest: traceabilitySemanticDigest,
          nodeIds: traceabilityNodeIds,
          edgeIds: traceabilityEdgeIds,
        },
        changedAxis: { name: "motionGrammar", values: [...MOTION_GRAMMARS], base: "still" },
        heldConstant: { graph: TRACEABILITY_FIXTURE.id, calibration: "DEFAULT_CALIBRATION" },
        perPolicy: perPolicyStructural,
      },
      negativeControls: {
        pixelMismatch: { message: pixelMismatchMessage, restored: true },
        restingCompletenessViolation: { message: restingCompletenessMessage, restored: true },
      },
      blocked: {
        m1PolicyDiscrimination: {
          status: "RED",
          reason: `M1 requires 4 rendered frame strips per shipped policy sampled at even intervals through one full policy cycle. ${MOUNT_PHASE_GAP_REASON}`,
        },
        m2RecursiveVersusHolographicUnderMotion: {
          status: "RED",
          reason: `M2 requires paired rendered strips of the same navigation event, animated with a shared motion policy through several phases. ${MOUNT_PHASE_GAP_REASON}`,
        },
        ablationPhaseFrames: {
          status: "RED",
          reason: `The static-vs-motion ablation's "resting frame beside several phase frames" needs the same non-resting-phase rendering. ${MOUNT_PHASE_GAP_REASON} The measured traceability number and the structural modulation record above are delivered in its place.`,
        },
      },
    };
    const manifestFile = join(ROOT_DIRECTORY, "motion-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `motion: ${m3Captures.length} M3 captures, all byte-identical to their matrix baseline; `
      + `traceability=${perPolicyTraceability.map((record) => `${record.policy}:${record.measuredTraceability.toFixed(4)}`).join(", ")}; `
      + `M1/M2/ablation-phase-frames RED (mount.tsx has no phase entry point); manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Structural summaries.
// ---------------------------------------------------------------------------------------------

function summarizeNodes(nodes: readonly NodeMotionModulation[]): ModulationSampleSummary["nodes"] {
  return {
    opacityPermille: minMaxMean(nodes.map((node) => node.opacityPermille)),
    scalePermille: minMaxMean(nodes.map((node) => node.scalePermille)),
    offsetMagnitudePermille: minMaxMean(nodes.map((node) => Math.hypot(node.offsetXPermille, node.offsetYPermille))),
  };
}

function summarizeEdges(edges: readonly EdgeMotionModulation[]): ModulationSampleSummary["edges"] {
  return {
    opacityPermille: minMaxMean(edges.map((edge) => edge.opacityPermille)),
    revealPermille: minMaxMean(edges.map((edge) => edge.revealPermille)),
  };
}

function minMaxMean(values: readonly number[]): MinMaxMean {
  if (values.length === 0) {
    throw new Error("motion structural summary requires at least one value");
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return { min: Math.min(...values), max: Math.max(...values), mean: sum / values.length };
}

// ---------------------------------------------------------------------------------------------
// Rendered-evidence helpers.
// ---------------------------------------------------------------------------------------------

function assertPixelIdentical(
  candidateBytes: Buffer,
  candidateImage: PixelImage,
  baselineBytes: Buffer,
  baselineImage: PixelImage,
  candidateFileName: string,
  baselineFileName: string,
): void {
  if (!candidateBytes.equals(baselineBytes)) {
    throw new Error(`motion M3 Still control failed: ${candidateFileName} raw PNG bytes do not match frozen static baseline ${baselineFileName}`);
  }
  if (pixelSha256(candidateImage) !== pixelSha256(baselineImage)) {
    throw new Error(`motion M3 Still control failed: ${candidateFileName} decoded pixels do not match frozen static baseline ${baselineFileName}`);
  }
}

async function readManifestOrExplain(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new Error(
      `motion M3 requires an already-generated matrix baseline at ${path}; run "npm --prefix ui run test:matrix" first`,
    );
  }
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("motion negative control unexpectedly passed");
}

function assertNodesInsideCapturedFrame(
  fileName: string,
  nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): void {
  const minimumX = -FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const maximumX = CAPTURE_WIDTH + FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const minimumY = -FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const maximumY = CAPTURE_HEIGHT + FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const positions = Object.entries(nodeViewportPositions);
  if (positions.length === 0) {
    throw new Error(`motion frame-containment invariant failed for ${fileName}: capture resolved no node viewport positions`);
  }
  const outside = positions.filter(([, point]) => (
    point.x < minimumX || point.x > maximumX || point.y < minimumY || point.y > maximumY
  ));
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map(([id, point]) => `${id}@(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`).join(", ");
    throw new Error(
      `motion frame-containment invariant failed for ${fileName}: ${outside.length}/${positions.length} `
      + `resolved node positions fall outside the captured frame; e.g. ${sample}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Page bootstrap -- mirrors matrix.spec.ts's and scale-topology.spec.ts's own bundling and installation shape.
// ---------------------------------------------------------------------------------------------

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
    throw new Error("motion page module output is unavailable");
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
      throw new Error("motion page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<MotionFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__motion;
    if (api === undefined) {
      throw new Error("motion page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: MotionCaptureRequest): Promise<MotionCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__motion;
    if (api === undefined) {
      throw new Error("motion page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function gitHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "..", encoding: "utf8" });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("motion suite could not determine the current commit SHA");
  }
  return sha;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
