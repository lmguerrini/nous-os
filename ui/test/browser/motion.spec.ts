/**
 * CAP-13 Phase B motion evidence. Feeds the three preregistered tests (M1 policy discrimination, M2
 * Recursive vs Holographic under motion, M3 the Still control) fixed by MOTION-BLIND-PREREGISTRATION.md
 * before any motion existed; this suite produces artifacts, it does not score them.
 *
 * `#render3f/mount.tsx` now threads a `phase` render input through to every `buildScene` call it
 * makes (bootstrap, `scenesForState`, `applyMaterialState`), via `Render3fOptions.phase` -- a render
 * input read the same way `calibration` already is, never written onto `VisualState`, and forced back
 * to the policy's own resting phase whenever `VisualState.reducedMotion` is set. That closed the gap
 * a prior worker on this suite found and reported: previously every mounted scene rendered at
 * `restingPhase(motionGrammar)` regardless of what was requested, which is exact identity for every
 * shipped policy -- indistinguishable from Still. M1 and M2 below are what that gap had blocked.
 *
 * Each preregistered test is its own Playwright `test()` rather than one combined test: the four
 * together (M3 + traceability, M1, M2, the phase-frames ablation) render on the order of 120 frames
 * through a real WebGL context, and `playwright.config.ts` (outside this suite's write ceiling) fixes
 * one 120s timeout per test for every project including this one. Splitting keeps each rendered
 * evidence product inside that fixed budget instead of trimming any of them to fit a shared one.
 *
 * M3 -- byte identity of Still against the frozen static baseline, plus every other shipped policy's
 * own resting-phase frame against that same Still frame, plus reduced motion overriding a requested
 * phase back to resting -- is checked first: a motion axis that perturbs its own zero state, or that
 * fails to collapse under reduced motion, would invalidate every static result beneath it.
 *
 * M1 and M2 sample STRIP_PHASES (three points spanning the phase domain) rather than SAMPLE_PHASES's
 * full nine points, and use the smaller of the two governed fixtures throughout: the
 * same 120s-per-test budget applies to rendered work, and `buildScene` recomputes layout on every
 * call (its cache never hits across separate `mount()` calls, and every frame here is a fresh mount,
 * per the "driven, not free-running" design this phase input follows).
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  MOTION_GRAMMARS,
  RECONFIGURE,
  STILL,
  motionModulation,
  motionTraceability,
  restingPhase,
} from "#engine/motion-grammar.ts";
import type { EdgeMotionModulation, MotionElementIds, MotionGrammar, NodeMotionModulation } from "#engine/motion-grammar.ts";
import type { Morphology } from "#engine/morphology.ts";
import { INDRA } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { HIERARCHICAL, HOLOGRAPHIC, RECURSIVE, childWorld, enterableKind } from "#engine/scale-topology.ts";
import type { ScaleTopology } from "#engine/scale-topology.ts";
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
// discovery-at-question is the smaller of the two governed fixtures (22 nodes / 27 relations), which
// is why every rendered probe below (traceability needs none; M1, M2, and the ablation render) is
// built from it rather than indra-community-windows.
const TRACEABILITY_FIXTURE = FIXTURES[0];
if (TRACEABILITY_FIXTURE === undefined) {
  throw new Error("motion suite requires at least one governed fixture");
}
// Nine samples spanning one full policy cycle at even eighths, including both endpoints. Used by the
// traceability measurement, the structural modulation record, and the phase-frames ablation, none of
// which render 28+ strips the way M1 does.
const SAMPLE_PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
// Three samples (start, an interior point, end) spanning one full policy cycle, used by every strip
// M1 and M2 render: enough to show a staggered policy's construction/withdrawal and a cyclic
// policy's peak, without multiplying render count past what one 120s-budgeted test can complete
// (M1 alone renders MOTION_GRAMMARS.length x M1_STRIP_REPEATS x STRIP_PHASES.length frames).
// Deliberately not [0, 0.5, 1]: pulse's and reconfigure's shared breathing envelope
// (sin(2*pi*phase)) is exactly zero -- identity -- at every multiple of one half, so a strip
// sampled only at those three points would render Still's own frame three times over for those two
// policies and look like no motion happened at all. 0.4 is not a multiple of one half.
const STRIP_PHASES = [0, 0.4, 1];

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

type DefaultPhaseControlRecord = {
  readonly assertion: "A capture that omits `phase` renders at the policy's own resting phase, byte-identical to Still's own frame at the same configuration -- the identity mount.tsx's default path is required to preserve.";
  readonly fixtureId: string;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly stillFileName: string;
  readonly perPolicy: readonly {
    readonly motionGrammar: MotionGrammar;
    readonly phaseRendered: number;
    readonly decodedPixelSha256: string;
    readonly identicalToStill: true;
  }[];
};

type ReducedMotionOverrideRecord = {
  readonly assertion: "reducedMotion forces a requested non-resting phase back to the policy's own resting phase, and a genuine negative control shows the same request WITHOUT reducedMotion renders something different.";
  readonly motionGrammar: MotionGrammar;
  readonly requestedPhase: number;
  readonly reducedMotionPhaseRendered: number;
  readonly reducedMotionPixelSha256: string;
  readonly reducedMotionOmittedPhasePixelSha256: string;
  readonly reducedMotionCollapsesToOmittedPhase: true;
  readonly motionEnabledPixelSha256: string;
  readonly motionEnabledDiffersFromReducedMotion: true;
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

type M3Manifest = {
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
  readonly defaultPhaseControl: DefaultPhaseControlRecord;
  readonly reducedMotionOverride: ReducedMotionOverrideRecord;
  readonly traceability: {
    readonly assertion: "The measured continuity number motionTraceability reports for each policy, computed directly and not gated on.";
    readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly samplePhases: readonly number[];
    readonly perPolicy: readonly TraceabilityRecord[];
  };
  readonly structuralModulationAblation: {
    readonly assertion: "Structural (channel-value) evidence of what each policy's own modulation does across one sampled cycle, complementing the rendered phase-frames ablation below.";
    readonly fixture: { readonly id: string; readonly path: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly changedAxis: { readonly name: "motionGrammar"; readonly values: readonly MotionGrammar[]; readonly base: "still" };
    readonly heldConstant: Readonly<Record<string, string>>;
    readonly perPolicy: readonly StructuralModulationRecord[];
  };
  readonly negativeControls: {
    readonly pixelMismatch: { readonly message: string; readonly restored: true };
    readonly restingCompletenessViolation: { readonly message: string; readonly restored: true };
  };
};

// ---------------------------------------------------------------------------------------------
// M3: Still control, default-phase control, reduced-motion override, traceability.
// ---------------------------------------------------------------------------------------------

test("CAP-13 W-MOTION M3 Still control, default phase, and reduced motion", async ({ page }, testInfo) => {
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
  let defaultPhaseControl: DefaultPhaseControlRecord | undefined;
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

      let stillFileNameForDefaultControl: string | undefined;
      let stillHashForDefaultControl: string | undefined;
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

            if (fixture.id === TRACEABILITY_FIXTURE.id && morphology === "stellar" && organization === "indra" && projection === "3d") {
              stillFileNameForDefaultControl = fileName;
              stillHashForDefaultControl = candidateDecodedPixelSha256;
            }
          }
        }
      }

      // ---- Default-phase control (design constraint 2): a capture that omits `phase` renders at
      // the policy's own resting phase, byte-identical to Still's own frame at the same
      // configuration, for every shipped policy -- not only Still. ----
      if (fixture.id === TRACEABILITY_FIXTURE.id) {
        if (stillFileNameForDefaultControl === undefined || stillHashForDefaultControl === undefined) {
          throw new Error("motion default-phase control requires the stellar/indra/3d Still capture");
        }
        const perPolicy: DefaultPhaseControlRecord["perPolicy"][number][] = [];
        for (const policy of MOTION_GRAMMARS) {
          if (policy === STILL) {
            continue;
          }
          const request: MotionCaptureRequest = { morphology: "stellar", organization: "indra", projection: "3d", motionGrammar: policy };
          const witness = await invokeCapture(page, request);
          const fileName = `${fixture.id}-default-phase-${policy}.png`;
          const outputFile = join(ROOT_DIRECTORY, fileName);
          await page.locator("#motion-root").screenshot({ path: outputFile });
          const bytes = await readFile(outputFile);
          const image = decodePng(bytes, fileName);
          const decodedPixelSha256 = pixelSha256(image);
          if (witness.phaseRendered !== restingPhase(policy)) {
            throw new Error(`motion default-phase control failed: ${policy} rendered phase ${witness.phaseRendered}, expected its own resting phase ${restingPhase(policy)}`);
          }
          if (decodedPixelSha256 !== stillHashForDefaultControl) {
            throw new Error(`motion default-phase control failed: ${policy}'s own resting-phase frame (no phase requested) is not byte-identical to Still's own frame`);
          }
          perPolicy.push({ motionGrammar: policy, phaseRendered: witness.phaseRendered, decodedPixelSha256, identicalToStill: true });
        }
        defaultPhaseControl = {
          assertion: "A capture that omits `phase` renders at the policy's own resting phase, byte-identical to Still's own frame at the same configuration -- the identity mount.tsx's default path is required to preserve.",
          fixtureId: fixture.id,
          morphology: "stellar",
          organization: "indra",
          projection: "3d",
          stillFileName: stillFileNameForDefaultControl,
          perPolicy,
        };
      }
    }
    if (defaultPhaseControl === undefined) {
      throw new Error("motion default-phase control did not run");
    }

    // ---- Reduced-motion override (design constraint 4): reducedMotion forces the resting phase
    // regardless of a requested phase, and a genuine negative control proves the same request WITHOUT
    // reducedMotion renders something different -- otherwise this would be a vacuous check. ----
    const requestedPhase = 0.25;
    const reducedMotionRequest: MotionCaptureRequest = {
      morphology: "stellar",
      organization: "indra",
      projection: "3d",
      motionGrammar: RECONFIGURE,
      reducedMotion: true,
      phase: requestedPhase,
    };
    const reducedMotionWitness = await invokeCapture(page, reducedMotionRequest);
    const reducedMotionFile = join(ROOT_DIRECTORY, "reduced-motion-forces-resting.png");
    await page.locator("#motion-root").screenshot({ path: reducedMotionFile });
    const reducedMotionHash = pixelSha256(decodePng(await readFile(reducedMotionFile), "reduced-motion-forces-resting.png"));
    if (reducedMotionWitness.phaseRendered !== restingPhase(RECONFIGURE)) {
      throw new Error(`motion reduced-motion override failed: requested phase ${requestedPhase} with reducedMotion rendered phase ${reducedMotionWitness.phaseRendered}, expected resting phase ${restingPhase(RECONFIGURE)}`);
    }

    const reducedMotionOmittedPhaseRequest: MotionCaptureRequest = {
      morphology: "stellar",
      organization: "indra",
      projection: "3d",
      motionGrammar: RECONFIGURE,
      reducedMotion: true,
    };
    const reducedMotionOmittedPhaseWitness = await invokeCapture(page, reducedMotionOmittedPhaseRequest);
    const reducedMotionOmittedPhaseFile = join(ROOT_DIRECTORY, "reduced-motion-omitted-phase.png");
    await page.locator("#motion-root").screenshot({ path: reducedMotionOmittedPhaseFile });
    const reducedMotionOmittedPhaseHash = pixelSha256(decodePng(await readFile(reducedMotionOmittedPhaseFile), "reduced-motion-omitted-phase.png"));
    if (reducedMotionOmittedPhaseWitness.phaseRendered !== restingPhase(RECONFIGURE)) {
      throw new Error("motion reduced-motion override control failed: omitted-phase capture did not render at the resting phase");
    }
    if (reducedMotionHash !== reducedMotionOmittedPhaseHash) {
      throw new Error("motion reduced-motion override failed: a requested phase under reducedMotion did not collapse to the same frame as an omitted phase under reducedMotion");
    }

    const motionEnabledRequest: MotionCaptureRequest = {
      morphology: "stellar",
      organization: "indra",
      projection: "3d",
      motionGrammar: RECONFIGURE,
      reducedMotion: false,
      phase: requestedPhase,
    };
    const motionEnabledWitness = await invokeCapture(page, motionEnabledRequest);
    const motionEnabledFile = join(ROOT_DIRECTORY, "reduced-motion-negative-control-motion-enabled.png");
    await page.locator("#motion-root").screenshot({ path: motionEnabledFile });
    const motionEnabledHash = pixelSha256(decodePng(await readFile(motionEnabledFile), "reduced-motion-negative-control-motion-enabled.png"));
    if (motionEnabledWitness.phaseRendered !== requestedPhase) {
      throw new Error(`motion reduced-motion negative control failed: reducedMotion:false did not render the requested phase ${requestedPhase}`);
    }
    if (motionEnabledHash === reducedMotionHash) {
      throw new Error("motion reduced-motion negative control unexpectedly passed: the same request with reducedMotion:false rendered the same pixels as reducedMotion:true, so the override check above cannot be trusted");
    }

    const reducedMotionOverride: ReducedMotionOverrideRecord = {
      assertion: "reducedMotion forces a requested non-resting phase back to the policy's own resting phase, and a genuine negative control shows the same request WITHOUT reducedMotion renders something different.",
      motionGrammar: RECONFIGURE,
      requestedPhase,
      reducedMotionPhaseRendered: reducedMotionWitness.phaseRendered,
      reducedMotionPixelSha256: reducedMotionHash,
      reducedMotionOmittedPhasePixelSha256: reducedMotionOmittedPhaseHash,
      reducedMotionCollapsesToOmittedPhase: true,
      motionEnabledPixelSha256: motionEnabledHash,
      motionEnabledDiffersFromReducedMotion: true,
    };

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("motion tracked-tree digest changed while its captures were produced");
    }

    const manifest: M3Manifest = {
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
      defaultPhaseControl,
      reducedMotionOverride,
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
        assertion: "Structural (channel-value) evidence of what each policy's own modulation does across one sampled cycle, complementing the rendered phase-frames ablation below.",
        fixture: {
          id: TRACEABILITY_FIXTURE.id,
          path: TRACEABILITY_FIXTURE.path,
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
    };
    const manifestFile = join(ROOT_DIRECTORY, "motion-m3-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `motion M3: ${m3Captures.length} Still captures byte-identical to their matrix baseline; `
      + `${defaultPhaseControl.perPolicy.length} non-Still policies' default (no-phase) frames byte-identical to Still; `
      + `reduced-motion override verified with a genuine negative control; `
      + `traceability=${perPolicyTraceability.map((record) => `${record.policy}:${record.measuredTraceability.toFixed(4)}`).join(", ")}; `
      + `manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// M1: policy discrimination strips.
// ---------------------------------------------------------------------------------------------

// discovery-at-question, organization=indra, scaleTopology=hierarchical, morphology=stellar,
// projection=3d, reducedMotion=false: held identical across every M1 strip, so the motion policy is
// the only thing that varies between them.
const M1_ORGANIZATION: Organization = INDRA;
const M1_SCALE_TOPOLOGY: ScaleTopology = HIERARCHICAL;
const M1_MORPHOLOGY: Morphology = "stellar";
const M1_PROJECTION: "2d" | "3d" = "3d";
const M1_STRIP_REPEATS = 4;
// A recorded seed for the deterministic Fisher-Yates shuffle that assigns each (policy, repeat) pair
// to an anonymous strip slot -- the only part of M1 that is shuffled; frames within a strip stay in
// ascending phase order, because the point of a strip is to watch it move.
const M1_SHUFFLE_SEED = 0x4d31_0813;

type M1FrameRecord = { readonly phase: number; readonly path: string; readonly pixelSha256: string };
type M1StripRecord = {
  readonly stripId: string;
  readonly motionGrammar: MotionGrammar;
  readonly repeat: number;
  readonly framesDiffer: boolean;
  readonly frames: readonly M1FrameRecord[];
};

test("CAP-13 W-MOTION M1 policy discrimination strips", async ({ page }, testInfo) => {
  test.skip(!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT, "run this through the dedicated motion project");
  if (!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  const raw: unknown = JSON.parse(await readFile(join("..", TRACEABILITY_FIXTURE.path), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = graph.nodes.map((node) => node.id).sort();
  const canonicalEdgeIds = graph.edges.map((edge) => edge.id).sort();
  const canonicalSemanticDigest = semanticDigest(graph);

  const outputDirectory = join(ROOT_DIRECTORY, "m1");
  await mkdir(outputDirectory, { recursive: true });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, TRACEABILITY_FIXTURE.path);
    expect(fixtureWitness.semanticDigest).toBe(canonicalSemanticDigest);

    const slots = MOTION_GRAMMARS.flatMap((policy) => (
      Array.from({ length: M1_STRIP_REPEATS }, (_, repeat) => ({ policy, repeat }))
    ));
    const shuffled = deterministicShuffle(slots, M1_SHUFFLE_SEED);

    const stripRecords: M1StripRecord[] = [];
    for (const [index, slot] of shuffled.entries()) {
      const stripId = `strip-${String(index + 1).padStart(2, "0")}`;
      const stripDirectory = join(outputDirectory, stripId);
      await mkdir(stripDirectory, { recursive: true });
      const frames: M1FrameRecord[] = [];
      for (const phase of STRIP_PHASES) {
        const request: MotionCaptureRequest = {
          morphology: M1_MORPHOLOGY,
          organization: M1_ORGANIZATION,
          projection: M1_PROJECTION,
          motionGrammar: slot.policy,
          scaleTopology: M1_SCALE_TOPOLOGY,
          reducedMotion: false,
          phase,
        };
        const fileName = `phase-${phase}.png`;
        const rendered = await renderFrame(page, request, stripDirectory, fileName);
        expect([...rendered.witness.surface.nodeIds].sort()).toEqual(canonicalNodeIds);
        expect([...rendered.witness.surface.edgeIds].sort()).toEqual(canonicalEdgeIds);
        expect(rendered.witness.phaseRendered).toBe(phase);
        frames.push({ phase, path: join("m1", stripId, fileName), pixelSha256: rendered.pixelSha256 });
      }
      const framesDiffer = new Set(frames.map((frame) => frame.pixelSha256)).size > 1;
      if (slot.policy === STILL && framesDiffer) {
        throw new Error(`motion M1 ${stripId} (still, hidden from this message's own filenames) unexpectedly differs across phase; still must be exact identity everywhere`);
      }
      if (slot.policy !== STILL && !framesDiffer) {
        throw new Error(`motion M1 ${stripId} renders identical pixels at every sampled phase; its assigned policy is not animating (see the manifest's slotAssignment for which policy that is)`);
      }
      stripRecords.push({ stripId, motionGrammar: slot.policy, repeat: slot.repeat, framesDiffer, frames });
    }

    const producedFiles = await pngFilesUnder(outputDirectory);
    const expectedFrameCount = shuffled.length * STRIP_PHASES.length;
    if (producedFiles.length !== expectedFrameCount) {
      throw new Error(`motion M1 produced ${producedFiles.length} frames, expected ${expectedFrameCount}`);
    }
    assertNoPolicyTokenInPaths(producedFiles, "motion M1");

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("motion M1 tracked-tree digest changed while its captures were produced");
    }

    const manifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: MOTION_COMMAND, trackedTree },
      assertion: "4 strips per shipped motion policy (plus Still, as the discriminable no-motion class), same governed graph/organization/scaleTopology/morphology/projection/calibration throughout -- only the motion policy varies between strips. Strip order is a deterministic shuffle keyed by the recorded seed below; no filename or path under m1/ names a policy (verified against every MOTION_GRAMMARS member by read-back after every frame was written -- see noPolicyTokenInPaths).",
      governedGraph: {
        fixtureId: TRACEABILITY_FIXTURE.id,
        path: TRACEABILITY_FIXTURE.path,
        semanticDigest: canonicalSemanticDigest,
        nodeIds: canonicalNodeIds,
        edgeIds: canonicalEdgeIds,
      },
      heldConstant: {
        organization: M1_ORGANIZATION,
        scaleTopology: M1_SCALE_TOPOLOGY,
        morphology: M1_MORPHOLOGY,
        projection: M1_PROJECTION,
        calibration: "DEFAULT_CALIBRATION",
        reducedMotion: false,
      },
      changedAxis: { name: "motionGrammar", values: [...MOTION_GRAMMARS] },
      stripPhases: STRIP_PHASES,
      shuffle: { algorithm: "mulberry32 + Fisher-Yates", seed: M1_SHUFFLE_SEED, stripRepeatsPerPolicy: M1_STRIP_REPEATS },
      noPolicyTokenInPaths: true,
      framesGenuinelyDiffer: {
        rule: "every non-Still strip's three sampled frames are not all pixel-identical; Still is excluded by definition and asserted identical instead.",
        passed: true,
      },
      // This is the de-blinding key: which anonymous strip id was actually rendered from which
      // (policy, repeat) pair. It is fine for this JSON manifest to name policies -- the blind
      // property M1 requires is that the PNG paths under m1/ never do, checked above.
      slotAssignment: stripRecords.map((record) => ({ stripId: record.stripId, motionGrammar: record.motionGrammar, repeat: record.repeat })),
      strips: stripRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "motion-m1-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `motion M1: ${stripRecords.length} strips (${MOTION_GRAMMARS.length} policies x ${M1_STRIP_REPEATS} repeats) x ${STRIP_PHASES.length} phases `
      + `= ${producedFiles.length} frames, deterministically shuffled (seed ${M1_SHUFFLE_SEED}), no policy token in any path; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// M2: Recursive versus Holographic under motion.
// ---------------------------------------------------------------------------------------------

const M2_ORGANIZATION: Organization = INDRA;
const M2_MORPHOLOGY: Morphology = "stellar";
const M2_PROJECTION: "2d" | "3d" = "3d";
const M2_MOTION_GRAMMAR: MotionGrammar = MOTION_GRAMMARS[1] ?? STILL; // assemble
// A second, independently recorded seed: M2 shuffles which of the two paired strips (Recursive,
// Holographic) is labelled pair-1 vs pair-2, exactly as M1 shuffles strip-to-policy assignment, but
// keeps its own seed so the two blinds do not share one source of randomness.
const M2_SHUFFLE_SEED = 0x484f_4c4f;

type M2FrameRecord = { readonly phase: number; readonly path: string; readonly pixelSha256: string };
type M2StripRecord = {
  readonly pairId: string;
  readonly scaleTopology: ScaleTopology;
  readonly framesDiffer: boolean;
  readonly frames: readonly M2FrameRecord[];
};

test("CAP-13 W-MOTION M2 recursive versus holographic under motion", async ({ page }, testInfo) => {
  test.skip(!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT, "run this through the dedicated motion project");
  if (!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  const raw: unknown = JSON.parse(await readFile(join("..", TRACEABILITY_FIXTURE.path), "utf8"));
  const canonicalGraph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(canonicalGraph);

  const containmentRootId = strongestContainmentRoot(canonicalGraph);
  const world = childWorld(canonicalGraph, containmentRootId, "containment");
  if (world.nodeIds.length < 2) {
    throw new Error(`motion M2 fixture ${TRACEABILITY_FIXTURE.id} resolved a containment world too small to render (${world.nodeIds.length} nodes)`);
  }
  const projectedNodeIds = [...world.nodeIds].sort();
  const projectedEdgeIds = [...world.edgeIds].sort();

  const outputDirectory = join(ROOT_DIRECTORY, "m2");
  await mkdir(outputDirectory, { recursive: true });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    const fixtureWitness = await prepareFixture(page, TRACEABILITY_FIXTURE.path);
    expect(fixtureWitness.semanticDigest).toBe(semanticDigest(canonicalGraph));

    const topologies = [RECURSIVE, HOLOGRAPHIC] as const;
    const shuffled = deterministicShuffle(topologies, M2_SHUFFLE_SEED);

    const stripRecords: M2StripRecord[] = [];
    for (const [index, scaleTopology] of shuffled.entries()) {
      const pairId = `pair-${index + 1}`;
      const pairDirectory = join(outputDirectory, pairId);
      await mkdir(pairDirectory, { recursive: true });
      const frames: M2FrameRecord[] = [];
      for (const phase of STRIP_PHASES) {
        const request: MotionCaptureRequest = {
          morphology: M2_MORPHOLOGY,
          organization: M2_ORGANIZATION,
          projection: M2_PROJECTION,
          motionGrammar: M2_MOTION_GRAMMAR,
          scaleTopology,
          nodeIds: world.nodeIds,
          edgeIds: world.edgeIds,
          reducedMotion: false,
          phase,
        };
        const fileName = `phase-${phase}.png`;
        const rendered = await renderFrame(page, request, pairDirectory, fileName);
        expect([...rendered.witness.surface.nodeIds].sort()).toEqual(projectedNodeIds);
        expect([...rendered.witness.surface.edgeIds].sort()).toEqual(projectedEdgeIds);
        expect(rendered.witness.phaseRendered).toBe(phase);
        frames.push({ phase, path: join("m2", pairId, fileName), pixelSha256: rendered.pixelSha256 });
      }
      const framesDiffer = new Set(frames.map((frame) => frame.pixelSha256)).size > 1;
      if (!framesDiffer) {
        throw new Error(`motion M2 ${pairId} renders identical pixels at every sampled phase; ${M2_MOTION_GRAMMAR} is not animating`);
      }
      stripRecords.push({ pairId, scaleTopology, framesDiffer, frames });
    }

    const producedFiles = await pngFilesUnder(outputDirectory);
    assertNoPolicyTokenInPaths(producedFiles, "motion M2");
    for (const token of ["recursive", "holographic"]) {
      for (const file of producedFiles) {
        if (file.toLowerCase().includes(token)) {
          throw new Error(`motion M2 leaked its scaleTopology label "${token}" into a path: ${file}`);
        }
      }
    }

    // ---- The primary Phase B research question, answered directly: `visualState.scaleTopology` is
    // read nowhere in `#scene/build.ts` -- it is recorded onto VisualState for navigation/provenance
    // purposes only (see #engine/scale-topology.ts and scale-topology.spec.ts's own governed
    // ablation) and has no rendering effect. Entering the same child world under the same motion
    // policy therefore renders the same pixels regardless of which of Recursive or Holographic was
    // requested; this is proved here, not assumed. ----
    const [pairA, pairB] = stripRecords;
    if (pairA === undefined || pairB === undefined) {
      throw new Error("motion M2 requires both paired strips to compare");
    }
    for (let index = 0; index < STRIP_PHASES.length; index += 1) {
      const frameA = pairA.frames[index];
      const frameB = pairB.frames[index];
      if (frameA === undefined || frameB === undefined) {
        throw new Error("motion M2 paired strips have a mismatched frame count");
      }
      if (frameA.pixelSha256 !== frameB.pixelSha256) {
        throw new Error(
          `motion M2 finding failed: Recursive and Holographic entering the same containment world diverged in rendered pixels at phase ${frameA.phase} `
          + "(scaleTopology is expected to have no rendering effect -- see #scene/build.ts)",
        );
      }
    }

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("motion M2 tracked-tree digest changed while its captures were produced");
    }

    const manifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: MOTION_COMMAND, trackedTree },
      assertion: "Paired strips of the same navigation event (entering the same containment child world), everything held constant except scaleTopology, both animated with the same motion policy. Pair order is a deterministically shuffled, independently seeded assignment; no path under m2/ names either scaleTopology label, verified by read-back.",
      navigationEvent: { containmentRootId, kind: world.kind, worldNodeIds: projectedNodeIds, worldEdgeIds: projectedEdgeIds },
      heldConstant: { organization: M2_ORGANIZATION, morphology: M2_MORPHOLOGY, projection: M2_PROJECTION, motionGrammar: M2_MOTION_GRAMMAR, calibration: "DEFAULT_CALIBRATION", reducedMotion: false },
      changedAxis: { name: "scaleTopology", values: [...topologies] },
      stripPhases: STRIP_PHASES,
      shuffle: { algorithm: "mulberry32 + Fisher-Yates", seed: M2_SHUFFLE_SEED },
      noLabelInPaths: true,
      finding: {
        claim: "Recursive and Holographic render byte-identically for the same navigation event under the same motion policy, because scaleTopology has no rendering effect in #scene/build.ts -- proved per-frame above, not assumed.",
        pixelIdenticalAcrossPairAtEveryPhase: true,
      },
      // De-blinding key: which anonymous pair id renders which scaleTopology. Fine for this JSON
      // manifest to name it; the blind property is the PNG paths, checked above.
      pairAssignment: stripRecords.map((record) => ({ pairId: record.pairId, scaleTopology: record.scaleTopology })),
      pairs: stripRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "motion-m2-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `motion M2: 2 paired strips (${M2_MOTION_GRAMMAR}) x ${STRIP_PHASES.length} phases, shuffled (seed ${M2_SHUFFLE_SEED}); `
      + `finding: Recursive and Holographic render pixel-identically for the same navigation event; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Phase-frames ablation: the resting frame beside several phase frames, for one configuration.
// ---------------------------------------------------------------------------------------------

const ABLATION_MOTION_GRAMMAR: MotionGrammar = RECONFIGURE;
// Excludes SAMPLE_PHASES's exact multiples of one half: reconfigure's breathing envelope is
// legitimately zero (identity) there too, and this ablation is meant to show non-identity frames
// beside the resting one, not to accidentally sample a second identity point and call it motion.
const ABLATION_PHASES = SAMPLE_PHASES.filter((phase) => phase !== 0 && phase !== 0.5 && phase !== 1);

test("CAP-13 W-MOTION phase-frames ablation", async ({ page }, testInfo) => {
  test.skip(!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT, "run this through the dedicated motion project");
  if (!MOTION_ENABLED || testInfo.project.name !== MOTION_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  const raw: unknown = JSON.parse(await readFile(join("..", TRACEABILITY_FIXTURE.path), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = graph.nodes.map((node) => node.id).sort();
  const canonicalEdgeIds = graph.edges.map((edge) => edge.id).sort();

  const outputDirectory = join(ROOT_DIRECTORY, "ablation");
  await mkdir(outputDirectory, { recursive: true });

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  try {
    await prepareFixture(page, TRACEABILITY_FIXTURE.path);

    const restingRequest: MotionCaptureRequest = {
      morphology: M1_MORPHOLOGY,
      organization: M1_ORGANIZATION,
      projection: M1_PROJECTION,
      motionGrammar: ABLATION_MOTION_GRAMMAR,
      scaleTopology: M1_SCALE_TOPOLOGY,
      reducedMotion: false,
      phase: restingPhase(ABLATION_MOTION_GRAMMAR),
    };
    const resting = await renderFrame(page, restingRequest, outputDirectory, `${ABLATION_MOTION_GRAMMAR}-resting.png`);
    expect([...resting.witness.surface.nodeIds].sort()).toEqual(canonicalNodeIds);
    expect([...resting.witness.surface.edgeIds].sort()).toEqual(canonicalEdgeIds);

    const phaseFrames: { readonly phase: number; readonly fileName: string; readonly pixelSha256: string; readonly differsFromResting: true }[] = [];
    for (const phase of ABLATION_PHASES) {
      const request: MotionCaptureRequest = {
        morphology: M1_MORPHOLOGY,
        organization: M1_ORGANIZATION,
        projection: M1_PROJECTION,
        motionGrammar: ABLATION_MOTION_GRAMMAR,
        scaleTopology: M1_SCALE_TOPOLOGY,
        reducedMotion: false,
        phase,
      };
      const fileName = `${ABLATION_MOTION_GRAMMAR}-phase-${phase}.png`;
      const rendered = await renderFrame(page, request, outputDirectory, fileName);
      expect([...rendered.witness.surface.nodeIds].sort()).toEqual(canonicalNodeIds);
      expect([...rendered.witness.surface.edgeIds].sort()).toEqual(canonicalEdgeIds);
      if (rendered.pixelSha256 === resting.pixelSha256) {
        throw new Error(`motion ablation phase ${phase} rendered pixel-identically to the resting frame; the ablation needs a genuinely different frame`);
      }
      phaseFrames.push({ phase, fileName, pixelSha256: rendered.pixelSha256, differsFromResting: true });
    }

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("motion ablation tracked-tree digest changed while its captures were produced");
    }

    const manifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: MOTION_COMMAND, trackedTree },
      assertion: "The resting frame beside several phase frames for one controlled configuration, so a reader can see what one policy actually does. Not blind: filenames name the policy deliberately.",
      motionGrammar: ABLATION_MOTION_GRAMMAR,
      heldConstant: { organization: M1_ORGANIZATION, scaleTopology: M1_SCALE_TOPOLOGY, morphology: M1_MORPHOLOGY, projection: M1_PROJECTION, calibration: "DEFAULT_CALIBRATION", reducedMotion: false },
      resting: { phase: restingPhase(ABLATION_MOTION_GRAMMAR), fileName: resting.fileName, pixelSha256: resting.pixelSha256 },
      phaseFrames,
    };
    const manifestFile = join(ROOT_DIRECTORY, "motion-ablation-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `motion ablation: ${ABLATION_MOTION_GRAMMAR} resting frame + ${phaseFrames.length} phase frames, every phase frame differs from resting; manifest=${manifestFile}\n`,
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

type RenderedFrame = {
  readonly fileName: string;
  readonly filePath: string;
  readonly witness: MotionCaptureWitness;
  readonly pixelSha256: string;
  readonly dimensions: { readonly width: number; readonly height: number };
};

/** This is the shared per-frame capture path M1, M2, and the ablation all reduce to: one mount, one screenshot, one read-back, the invariants every rendered frame in this suite must hold. */
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
    throw new Error(`motion frame ${fileName} has unexpected dimensions ${dimensions.width}x${dimensions.height}`);
  }
  assertMinimalPngChunks(bytes, fileName);
  const image = decodePng(bytes, fileName);
  assertDarkestShippingField(image, `motion ${fileName}`);
  assertLitPixelFloor(image, `motion ${fileName}`);
  assertNodesInsideCapturedFrame(fileName, witness.nodeViewportPositions);
  return { fileName, filePath, witness, pixelSha256: pixelSha256(image), dimensions };
}

/** This walks a PNG's own chunk headers (the same way png-codec.ts's decodePng does) and refuses any chunk type outside IHDR/IDAT/IEND. */
function assertMinimalPngChunks(bytes: Buffer, name: string): void {
  const allowed = new Set(["IHDR", "IDAT", "IEND"]);
  const seen = new Set<string>();
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`${name} ends within a PNG chunk`);
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    seen.add(type);
    if (!allowed.has(type)) {
      throw new Error(`${name} carries a PNG chunk outside IHDR/IDAT/IEND: ${type}`);
    }
    offset += length + 12;
    if (type === "IEND") {
      break;
    }
  }
  if (!seen.has("IHDR") || !seen.has("IDAT") || !seen.has("IEND")) {
    throw new Error(`${name} is missing a required PNG chunk`);
  }
}

/** This lists every PNG path under a directory, relative to that directory, sorted for a stable read order. */
async function pngFilesUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".png")).sort();
}

/** This is the blind-path check, run against every MOTION_GRAMMARS member (not only the ones a given suite happens to use) so a future policy addition cannot silently leak a token this check never learned to look for. */
function assertNoPolicyTokenInPaths(paths: readonly string[], label: string): void {
  if (paths.length === 0) {
    throw new Error(`${label} produced no PNG paths to verify`);
  }
  for (const path of paths) {
    const lower = path.toLowerCase();
    for (const policy of MOTION_GRAMMARS) {
      if (lower.includes(policy)) {
        throw new Error(`${label} leaked a policy token "${policy}" into a path: ${path}`);
      }
    }
  }
}

/** This finds the largest containment child world the fixture actually declares, mirroring scale-topology.spec.ts's own `strongestContainmentRoot` (duplicated rather than imported: that file exports nothing this suite is allowed to import from). */
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
    throw new Error(`motion M2 fixture ${TRACEABILITY_FIXTURE.id} has no populated containment root`);
  }
  return best.id;
}

/** This is a small deterministic PRNG (mulberry32), seeded once and never reseeded mid-shuffle, so the same seed always produces the same order. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** This is a Fisher-Yates shuffle driven by `mulberry32`, so the same `items` and `seed` always produce the same order -- the "deterministically shuffled by a recorded seed" the blind strips require. */
function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swapped = shuffled[swapIndex];
    if (current === undefined || swapped === undefined) {
      throw new Error("motion shuffle index out of range");
    }
    shuffled[index] = swapped;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

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
