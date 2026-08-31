/**
 * CAP-13 F82 residual: human recorded the crisp minimum core as the functional repair, with one
 * aesthetic residual -- "the diffuse halo remains aesthetically too large / soft / dominant" against
 * the target of a small crisp core plus a restrained compact halo. This is a bounded CALIBRATION
 * SWEEP, not a redesign and not a gate: it renders one governed scene repeatedly, varying only
 * already-shipped calibration values (`ui/src/engine/calibration.ts`), so a human can judge candidates
 * at ordinary viewing scale and pick a winner. Nothing here selects that winner, and nothing in
 * `ui/src/**` is touched -- every variant is a `CalibrationProfile` constructed in this harness, the
 * way calibration-evidence.spec.ts already does, and driven through `#browser/review-halo-calibration.ts`
 * (this suite's own page module), which merges -- without changing -- the `calibration` passthrough
 * calibration-evidence.ts already has, the `phase`/`motionGrammar`/`navigationPath`/`sharedCamera`
 * handling motion.ts already has, and the `temporalInstant` passthrough temporal.ts already has. Every
 * mount is routed through `#browser/gpu-sync.ts`'s shared GPU completion barrier (`settleRendered`),
 * matching every other capture suite in this directory.
 *
 * V0-V4 (first pass, kept exactly as originally run): one proportional radius factor applied to all
 * three morphologies' `sharedSceneHaloRadiusMultiplierPermille` -- V0 (x1.00, control), V1 (x0.75), V2
 * (x0.60), V3 (x0.45), V4 (x0.60 radius, x0.75 `sharedSceneHaloIntensityPermille`). That pass was a
 * clean NEGATIVE result, not an inconclusive one, and is read here as established fact rather than
 * re-derived: `ui/src/render3f/node-material.ts`'s own node vertex shader clamps
 * `haloRadius = max(requestedHaloRadius, coreRadius + haloCoreGapPx)`, where `haloCoreGapPx` is
 * `calibration.luminance.coreBeforeHaloMinimumPx` (shipped at 4, `scene/build.ts`). For every node this
 * pass measured, `coreRadius + 4` already exceeded the requested halo radius the multiplier controls,
 * so the multiplier never reached a rendered pixel -- V0 through V3 render byte-identical. Only V4's
 * intensity term moved anything measurable.
 *
 * W0-W4 (second pass): the same five captures, camera derivation and measurement as V0-V4, now sweeping
 * the parameter the first pass's own trace identified as the one that actually reaches the screen --
 * `luminance.coreBeforeHaloMinimumPx` itself, a single scalar (not per-morphology). W0 (4, control,
 * `== V0`), W1 (3), W2 (2), W3 (1), W4 (2, plus `sharedSceneHaloIntensityPermille` x0.75 across all
 * three morphologies, to see whether dimming helps or merely hides). Resolved values are computed here,
 * never hand-typed, and recorded in the manifest alongside V0-V4 so both passes sit in one comparable
 * table.
 *
 * Five captures per variant, same graph/camera/everything except the calibration, at ordinary viewing
 * scale (1200x800, full frame, no magnification): (1) discovery-at-question, stellar, indra, 3d, at
 * rest; (2) the same fixture, mycelium, indra, 3d, at rest; (3) the
 * static-controlled-recursive-indra-3d-level1 configuration scale-topology.spec.ts's own static-
 * controlled comparison already names -- Recursive's own level-1 containment world, captured under
 * Holographic's own refit camera at that level (reproduced here exactly the way that suite builds it:
 * same containment root, same two-step camera derivation, same file name), because that is where a
 * degree-1 node sits at the salience floor beside a degree-3 node and is therefore the legibility test;
 * (4) one motion frame, Reconfigure at phase 0.4, stellar/indra/3d; (5) one Mycelium temporal frame at
 * a mid governed instant of temporal-genesis, Assemble at rest. Plus, per variant, a 6x diagnostic crop
 * of capture (3)'s own degree-3 cluster and its one degree-1 bridge -- secondary evidence only.
 *
 * Measurement (not judgement): per variant, the degree-3 and degree-1 CORE peak red-channel value at
 * capture (3) (must not move -- a moved core peak would mean the halo change is leaking into the core),
 * the halo footprint in an 8-24px annulus around the degree-3 node (lit-pixel count and mean red-channel
 * value against that same capture's own local field, reusing the shipped `isLitPixel`/`fieldPixel`
 * predicate filament-continuity.ts already defines), confirmation that every node's own rendered
 * viewport position is unchanged across variants, and (added for the second pass) the halo's own
 * VISIBLE EXTENT for the degree-3 and degree-1 node alike: the radius, walked outward in the same
 * capture's own pixels, at which the radial red/green/blue profile first falls and stays fallen to that
 * capture's own local field value -- the number that corresponds to "too large" -- OR, where the profile
 * never reaches field because the test position sits inside a dense local cluster whose neighbouring
 * nodes and filaments keep the surroundings measurably above field however far the walk searches
 * (measured directly, both positions: the profile stabilises around a constant ~35-40 red against a
 * field of ~9 well past 80px), the radius at which the profile instead stabilises onto that ambient
 * level; which of the two happened is recorded alongside the number itself. Also recorded: the radius
 * at which the profile first drops under half of that node's own measured core peak (a proxy core-edge
 * boundary), so a shrunk `haloBandWidthPx` between the two flags a candidate where the core risks
 * visually merging into its own halo rather than staying legible against it. This suite recommends
 * nothing; a human judges the images.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { assertCalibrationProfile, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";
import { applyMorphology, SHARED_SCENE_MATERIAL_TARGET, STELLAR } from "#engine/morphology.ts";
import type { Morphology } from "#engine/morphology.ts";
import { ASSEMBLE, RECONFIGURE, restingPhase } from "#engine/motion-grammar.ts";
import { resolveOpeningTimeline } from "#engine/opening.ts";
import type { OpeningTemporalStep } from "#engine/opening.ts";
import { FLAT, INDRA } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import {
  childWorld,
  enterableKind,
  enterChildWorld,
  HOLOGRAPHIC,
  RECURSIVE,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import type { ChildWorld, ScaleNavigationPath } from "#engine/scale-topology.ts";
import { fieldPixel, isLitPixel } from "#browser/filament-continuity.ts";
import { decodePng, encodePng, pngDimensions, sha256 } from "#browser/png-codec.ts";
import type { PixelImage } from "#browser/png-codec.ts";
import type {
  ReviewHaloCaptureRequest,
  ReviewHaloCaptureWitness,
  ReviewHaloFixtureWitness,
  ReviewHaloPageApi,
} from "#browser/review-halo-calibration.ts";

const execFileAsync = promisify(execFile);

const REVIEW_HALO_CALIBRATION_ENABLED = process.env.REVIEW_HALO_CALIBRATION_CAPTURES === "1";
const REVIEW_HALO_CALIBRATION_PROJECT = "review-halo-calibration";
const ROOT_DIRECTORY = join("dist", "review-halo-calibration");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;

const DISCOVERY_FIXTURE = {
  id: "discovery-at-question",
  path: ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/"),
} as const;
const TEMPORAL_FIXTURE = {
  id: "temporal-genesis",
  path: ["fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json"].join("/"),
} as const;

const HALO_MORPHOLOGIES = ["stellar", "mycelium", "neural"] as const satisfies readonly Morphology[];

// The annulus this suite measures the halo footprint in, and the small box a "core peak" is read from.
const HALO_ANNULUS_INNER_PX = 8;
const HALO_ANNULUS_OUTER_PX = 24;
const CORE_PEAK_HALF_BOX_PX = 3;
const DIAGNOSTIC_CROP_HALF_BOX_PX = 50;
const DIAGNOSTIC_CROP_MAGNIFICATION = 6;
// The second pass's own halo-visible-extent walk (see radialHaloExtent below): a bound comfortably
// inside DIAGNOSTIC_CROP_HALF_BOX_PX, the number of consecutive not-lit rings required before the walk
// accepts the halo has fallen to field (guards against a single antialiased ring reading as the edge),
// the trailing window (in rings, counted from the search bound inward) this walk averages to estimate
// the ambient plateau a profile that never reaches field instead settles onto, the tolerance band around
// that estimate a ring must stay inside for the REST of the walk before its own radius counts as where
// the profile "arrived" (a single ring-to-ring delta threshold was tried first and rejected: two
// otherwise near-identical profiles could differ by a couple of red-channel units on exactly one ring
// near the boundary and read as though the halo were several pixels larger, which a sustained-band
// requirement checked against the profile's own settled tail is not sensitive to), and the fraction of a
// node's own measured core peak red below which a ring counts as past the core's own proxy edge.
const HALO_VISIBLE_EXTENT_SEARCH_MAX_PX = 48;
const HALO_VISIBLE_EXTENT_CONFIRMATION_RINGS = 2;
const HALO_PLATEAU_TAIL_WINDOW_RINGS = 8;
const HALO_PLATEAU_TOLERANCE = 5;
const CORE_EDGE_PEAK_FRACTION = 0.5;

type HaloVariant = {
  readonly id: "V0" | "V1" | "V2" | "V3" | "V4";
  readonly label: string;
  readonly radiusFactorPermille: number;
  readonly intensityFactorPermille: number;
};

const VARIANTS: readonly HaloVariant[] = [
  { id: "V0", label: "control: radius x1.00, the current accepted candidate", radiusFactorPermille: 1_000, intensityFactorPermille: 1_000 },
  { id: "V1", label: "radius x0.75", radiusFactorPermille: 750, intensityFactorPermille: 1_000 },
  { id: "V2", label: "radius x0.60", radiusFactorPermille: 600, intensityFactorPermille: 1_000 },
  { id: "V3", label: "radius x0.45", radiusFactorPermille: 450, intensityFactorPermille: 1_000 },
  { id: "V4", label: "radius x0.60, intensity x0.75", radiusFactorPermille: 600, intensityFactorPermille: 750 },
];

// Second pass (see this file's own docstring): the first pass's own trace found that
// `sharedSceneHaloRadiusMultiplierPermille` never reaches a rendered pixel, and that the binding lever
// is the single scalar `luminance.coreBeforeHaloMinimumPx` -- shipped at 4, resolved into every node's
// own `haloCoreGapPx` (scene/build.ts) and clamped against directly in the vertex shader
// (render3f/node-material.ts). W4 additionally halves the same intensity dimming V4 already tried, at
// the smallest radius still short of the floor's own minimum.
type CoreGapVariant = {
  readonly id: "W0" | "W1" | "W2" | "W3" | "W4";
  readonly label: string;
  readonly coreBeforeHaloMinimumPx: number;
  readonly intensityFactorPermille: number;
};

const CORE_GAP_VARIANTS: readonly CoreGapVariant[] = [
  { id: "W0", label: "control: coreBeforeHaloMinimumPx 4 (== V0)", coreBeforeHaloMinimumPx: 4, intensityFactorPermille: 1_000 },
  { id: "W1", label: "coreBeforeHaloMinimumPx 3", coreBeforeHaloMinimumPx: 3, intensityFactorPermille: 1_000 },
  { id: "W2", label: "coreBeforeHaloMinimumPx 2", coreBeforeHaloMinimumPx: 2, intensityFactorPermille: 1_000 },
  { id: "W3", label: "coreBeforeHaloMinimumPx 1", coreBeforeHaloMinimumPx: 1, intensityFactorPermille: 1_000 },
  { id: "W4", label: "coreBeforeHaloMinimumPx 2, intensity x0.75 across all three morphologies", coreBeforeHaloMinimumPx: 2, intensityFactorPermille: 750 },
];

type HaloVariantId = HaloVariant["id"] | CoreGapVariant["id"];

type ResolvedHaloValues = Readonly<Record<Morphology, {
  readonly sharedSceneHaloRadiusMultiplierPermille: number;
  readonly sharedSceneHaloIntensityPermille: number;
}>>;

type ResolvedCoreGapValues = {
  readonly coreBeforeHaloMinimumPx: number;
  readonly sharedSceneHaloIntensityPermille: Readonly<Record<Morphology, number>>;
};

// The proxy pair the second pass's own new measurement is built from: where the radial profile first
// drops under half of that node's own measured core peak (a core-edge proxy, not the geometric core
// radius itself), and where it first falls and stays fallen to the local field value (the halo's own
// visible extent). `haloBandWidthPx` is their difference -- at 0 the two boundaries coincide within this
// proxy's own resolution, which is reported as a merge risk rather than judged.
type RadialHaloExtent = {
  readonly coreEdgeRadiusPx: number;
  readonly visibleExtentRadiusPx: number;
  readonly haloBandWidthPx: number;
  /**
   * `localField`: the profile actually returned to this capture's own corner-sampled background level.
   * `ambientPlateau`: it stopped falling before reaching that level and stabilised above it instead --
   * observed at both test positions in this scene, which sit inside a dense local cluster where
   * neighbouring nodes' and filaments' own light keeps the immediate surroundings above the empty-field
   * value no matter how far the walk searches, so this is reported rather than forced to a false zero.
   */
  readonly convergedTo: "localField" | "ambientPlateau";
};

type MeasurementRecord = {
  readonly degree3NodeId: string;
  readonly degree1NodeId: string;
  readonly degree3CorePeakRed: number;
  readonly degree1CorePeakRed: number;
  readonly haloFootprint: { readonly innerPx: number; readonly outerPx: number; readonly litPixelCount: number; readonly meanRed: number; readonly fieldRgb: readonly [number, number, number] };
  readonly degree3HaloExtent: RadialHaloExtent;
  readonly degree1HaloExtent: RadialHaloExtent;
};

type VariantRecord = {
  readonly id: HaloVariantId;
  readonly label: string;
  readonly resolved: ResolvedHaloValues | ResolvedCoreGapValues;
  readonly captures: {
    readonly discoveryStellar: { readonly fileName: string; readonly rawFileSha256: string };
    readonly discoveryMycelium: { readonly fileName: string; readonly rawFileSha256: string };
    readonly staticControlledLevel1: { readonly fileName: string; readonly rawFileSha256: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
    readonly motionReconfigurePhase04: { readonly fileName: string; readonly rawFileSha256: string; readonly phaseRendered: number };
    readonly temporalMyceliumMidInstant: { readonly fileName: string; readonly rawFileSha256: string; readonly instant: string };
  };
  readonly diagnostics: {
    readonly degree3Cluster6x: string;
    readonly degree1Bridge6x: string;
  };
  readonly measurement: MeasurementRecord;
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

test("CAP-13 F82 residual: halo radius/intensity calibration sweep for human judgement", async ({ page }, testInfo) => {
  test.skip(!REVIEW_HALO_CALIBRATION_ENABLED || testInfo.project.name !== REVIEW_HALO_CALIBRATION_PROJECT, "run this through the dedicated review-halo-calibration project");
  if (!REVIEW_HALO_CALIBRATION_ENABLED || testInfo.project.name !== REVIEW_HALO_CALIBRATION_PROJECT) {
    return;
  }
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  expect(devicePixelRatio).toBe(1);

  const candidateSha = await gitHeadSha();
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const discoveryRaw: unknown = JSON.parse(await readFile(join("..", DISCOVERY_FIXTURE.path), "utf8"));
  const discoveryGraph = toVisualGraph(discoveryRaw);
  assertVisualGraphFieldRegister(discoveryGraph);
  const discoverySemanticDigest = semanticDigest(discoveryGraph);

  const temporalRaw: unknown = JSON.parse(await readFile(join("..", TEMPORAL_FIXTURE.path), "utf8"));
  const temporalGraph = toVisualGraph(temporalRaw);
  assertVisualGraphFieldRegister(temporalGraph);
  const temporalSemanticDigest = semanticDigest(temporalGraph);

  // Level 1 of the same walk scale-topology.spec.ts's own static-controlled comparison builds: one
  // containment step from the fixture's own strongest containment root. Only level 1 is needed here
  // (the brief names exactly `static-controlled-recursive-indra-3d-level1`), so the deeper steps that
  // suite's own RECURSIVE_TARGET_DEPTH walk takes are never built.
  const containmentRootId = strongestContainmentRoot(discoveryGraph);
  const recursiveLevel1Path = enterChildWorld(discoveryGraph, rootNavigationPath(RECURSIVE), containmentRootId);
  const holographicLevel1Path = enterChildWorld(discoveryGraph, rootNavigationPath(HOLOGRAPHIC), containmentRootId);
  const recursiveLevel1World = recursiveLevel1Path.worlds[0];
  const holographicLevel1World = holographicLevel1Path.worlds[0];
  if (recursiveLevel1World === undefined || holographicLevel1World === undefined) {
    throw new Error("review-halo-calibration requires a real level-1 containment world under both Recursive and Holographic");
  }

  // The degree-3/degree-1 pair the legibility test is about: computed once, structurally, from the
  // SAME id set capture (3) actually renders (Recursive's own level-1 world, not the canonical graph),
  // exactly as buildScene resolves it. Degree is a structural fact independent of calibration, so
  // DEFAULT_CALIBRATION is used purely as applyMorphology's required argument, never as the profile a
  // capture is rendered with.
  const level1Subgraph = projectVisualGraph(discoveryGraph, recursiveLevel1World.nodeIds, recursiveLevel1World.edgeIds);
  const level1EngineGraph = createEngineGraphView(level1Subgraph).graph;
  const level1Material = applyMorphology(level1EngineGraph, STELLAR, DEFAULT_CALIBRATION, SHARED_SCENE_MATERIAL_TARGET);
  const sortedLevel1Nodes = [...level1Material.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const degree3Node = sortedLevel1Nodes.find((node) => node.facts.degree.value === 3);
  const degree1Node = sortedLevel1Nodes.find((node) => node.facts.degree.value === 1);
  if (degree3Node === undefined || degree1Node === undefined) {
    throw new Error(
      "review-halo-calibration static-controlled-recursive-indra-3d-level1 does not carry the expected "
      + "degree-3/degree-1 pair the legibility test is about",
    );
  }

  // The Mycelium temporal mid instant: the middle of temporal-genesis's own governed timeline
  // (`resolveOpeningTimeline`, reused rather than re-derived, matching review-temporal-mycelium.spec.ts's
  // own precedent), not an arbitrary date literal.
  const temporalTimeline: readonly OpeningTemporalStep[] = resolveOpeningTimeline(temporalGraph);
  const midStep = temporalTimeline[Math.floor(temporalTimeline.length / 2)];
  if (midStep === undefined) {
    throw new Error("review-halo-calibration requires temporal-genesis to carry a governed timeline");
  }

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const variantRecords: VariantRecord[] = [];
  try {
    const discoveryFixtureWitness = await prepareFixture(page, DISCOVERY_FIXTURE.path);
    expect(discoveryFixtureWitness.semanticDigest).toBe(discoverySemanticDigest);

    // Both passes share one comparable loop and one manifest: V0-V4 (radius/intensity, first pass, kept
    // exactly as originally computed) followed by W0-W4 (coreBeforeHaloMinimumPx/intensity, second
    // pass). Resolved calibration profiles are built once, up front, so the loop body below -- captures,
    // measurement, diagnostics -- is identical for every one of the ten variants.
    const allVariants: readonly { readonly id: HaloVariantId; readonly label: string; readonly calibration: CalibrationProfile; readonly resolved: ResolvedHaloValues | ResolvedCoreGapValues }[] = [
      ...VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, ...buildCalibrationVariant(variant) })),
      ...CORE_GAP_VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, ...buildCoreGapVariant(variant) })),
    ];

    for (const variant of allVariants) {
      const variantDirectory = join(ROOT_DIRECTORY, variant.id);
      await mkdir(variantDirectory, { recursive: true });
      const { calibration, resolved } = variant;

      // (1) discovery-at-question, stellar, indra, 3d, at rest.
      const stellarFrame = await renderFrame(
        page,
        { morphology: "stellar", organization: INDRA, projection: "3d", calibration },
        variantDirectory,
        "discovery-question-stellar-indra-3d.png",
      );

      // (2) the same fixture, mycelium, indra, 3d, at rest.
      const myceliumFrame = await renderFrame(
        page,
        { morphology: "mycelium", organization: INDRA, projection: "3d", calibration },
        variantDirectory,
        "discovery-question-mycelium-indra-3d.png",
      );

      // (3) static-controlled-recursive-indra-3d-level1: Holographic's own level-1 camera (never
      // saved as its own file -- only its camera is used as input, mirroring motion.spec.ts's own
      // C-recursive-vs-holographic camera probe, which is likewise never screenshotted), then Recursive
      // re-rendered under that camera. File name matches scale-topology.spec.ts's own naming exactly.
      const holographicCameraRequest: ReviewHaloCaptureRequest = {
        morphology: "stellar",
        organization: INDRA,
        projection: "3d",
        calibration,
        scaleTopology: HOLOGRAPHIC,
        navigationPath: holographicLevel1Path,
      };
      const holographicCameraWitness = await invokeCapture(page, holographicCameraRequest);
      const staticControlledFrame = await renderFrame(
        page,
        {
          morphology: "stellar",
          organization: INDRA,
          projection: "3d",
          calibration,
          scaleTopology: RECURSIVE,
          navigationPath: recursiveLevel1Path,
          sharedCamera: holographicCameraWitness.visualState.camera,
        },
        variantDirectory,
        "static-controlled-recursive-indra-3d-level1.png",
      );
      const renderedNodeIds = [...staticControlledFrame.witness.surface.nodeIds].sort();
      const renderedEdgeIds = [...staticControlledFrame.witness.surface.edgeIds].sort();
      expect(renderedNodeIds).toEqual([...recursiveLevel1World.nodeIds].sort());
      expect(renderedEdgeIds).toEqual([...recursiveLevel1World.edgeIds].sort());

      // (4) one motion frame: Reconfigure at phase 0.4, stellar/indra/3d.
      const motionFrame = await renderFrame(
        page,
        {
          morphology: "stellar",
          organization: INDRA,
          projection: "3d",
          calibration,
          motionGrammar: RECONFIGURE,
          phase: 0.4,
          reducedMotion: false,
        },
        variantDirectory,
        "motion-reconfigure-phase0.4-stellar-indra-3d.png",
      );
      expect(motionFrame.witness.phaseRendered).toBe(0.4);

      // (5) one Mycelium temporal frame at a mid governed instant, Assemble at rest -- prepared against
      // temporal-genesis, which requires switching the page's own prepared fixture; discovery-at-question
      // is re-prepared afterward so the next variant's captures (1)-(4) mount against it again.
      await prepareFixture(page, TEMPORAL_FIXTURE.path);
      const temporalFrame = await renderFrame(
        page,
        {
          morphology: "mycelium",
          organization: FLAT,
          projection: "2d",
          calibration,
          motionGrammar: ASSEMBLE,
          temporalInstant: midStep.instant,
        },
        variantDirectory,
        "temporal-mycelium-mid-instant.png",
      );
      expect(temporalFrame.witness.phaseRendered).toBe(restingPhase(ASSEMBLE));
      const reprepared = await prepareFixture(page, DISCOVERY_FIXTURE.path);
      expect(reprepared.semanticDigest).toBe(discoverySemanticDigest);

      // Measurement, taken from capture (3): the degree-3/degree-1 core peaks (must not move across
      // variants), the halo footprint in the annulus around the degree-3 node, and (second pass) the
      // degree-3/degree-1 halo visible extent.
      const staticControlledImage = decodePng(await readFile(join(variantDirectory, staticControlledFrame.fileName)), staticControlledFrame.fileName);
      const staticControlledFieldRgb = fieldRgbOf(staticControlledImage);
      const degree3Position = requiredPosition(staticControlledFrame.witness.nodeViewportPositions, degree3Node.id, staticControlledFrame.fileName);
      const degree1Position = requiredPosition(staticControlledFrame.witness.nodeViewportPositions, degree1Node.id, staticControlledFrame.fileName);
      const degree3CorePeakRed = corePeakRed(staticControlledImage, degree3Position.x, degree3Position.y, CORE_PEAK_HALF_BOX_PX);
      const degree1CorePeakRed = corePeakRed(staticControlledImage, degree1Position.x, degree1Position.y, CORE_PEAK_HALF_BOX_PX);
      const haloFootprint = haloAnnulusFootprint(staticControlledImage, degree3Position.x, degree3Position.y, HALO_ANNULUS_INNER_PX, HALO_ANNULUS_OUTER_PX, staticControlledFieldRgb);
      const degree3HaloExtent = radialHaloExtent(staticControlledImage, degree3Position.x, degree3Position.y, degree3CorePeakRed, staticControlledFieldRgb);
      const degree1HaloExtent = radialHaloExtent(staticControlledImage, degree1Position.x, degree1Position.y, degree1CorePeakRed, staticControlledFieldRgb);

      // Diagnostic-only, 6x magnified crops of the degree-3 cluster and the one degree-1 bridge from
      // capture (3). Secondary evidence: never fed into the measurement table above.
      const degree3CropFile = `diagnostic-degree3-cluster-6x-${degree3Node.id}.png`;
      const degree1CropFile = `diagnostic-degree1-bridge-6x-${degree1Node.id}.png`;
      await writeCropDiagnostic(staticControlledImage, degree3Position.x, degree3Position.y, join(variantDirectory, degree3CropFile));
      await writeCropDiagnostic(staticControlledImage, degree1Position.x, degree1Position.y, join(variantDirectory, degree1CropFile));

      variantRecords.push({
        id: variant.id,
        label: variant.label,
        resolved,
        captures: {
          discoveryStellar: { fileName: stellarFrame.fileName, rawFileSha256: stellarFrame.rawFileSha256 },
          discoveryMycelium: { fileName: myceliumFrame.fileName, rawFileSha256: myceliumFrame.rawFileSha256 },
          staticControlledLevel1: {
            fileName: staticControlledFrame.fileName,
            rawFileSha256: staticControlledFrame.rawFileSha256,
            nodeIds: renderedNodeIds,
            edgeIds: renderedEdgeIds,
          },
          motionReconfigurePhase04: { fileName: motionFrame.fileName, rawFileSha256: motionFrame.rawFileSha256, phaseRendered: motionFrame.witness.phaseRendered },
          temporalMyceliumMidInstant: { fileName: temporalFrame.fileName, rawFileSha256: temporalFrame.rawFileSha256, instant: midStep.instant },
        },
        diagnostics: { degree3Cluster6x: degree3CropFile, degree1Bridge6x: degree1CropFile },
        measurement: {
          degree3NodeId: degree3Node.id,
          degree1NodeId: degree1Node.id,
          degree3CorePeakRed,
          degree1CorePeakRed,
          haloFootprint,
          degree3HaloExtent,
          degree1HaloExtent,
        },
        nodeViewportPositions: staticControlledFrame.witness.nodeViewportPositions,
      });
    }

    // Positions-unchanged confirmation: every variant's own capture (3) node viewport positions must be
    // byte-identical to V0's, since only halo calibration changed -- layout, camera and node/core size
    // are untouched by every variant this suite constructs.
    const baseline = variantRecords[0];
    if (baseline === undefined) {
      throw new Error("review-halo-calibration produced no variant records");
    }
    const positionMismatches: string[] = [];
    for (const record of variantRecords) {
      if (JSON.stringify(record.nodeViewportPositions) !== JSON.stringify(baseline.nodeViewportPositions)) {
        positionMismatches.push(record.id);
      }
    }
    const positionsUnchanged = positionMismatches.length === 0;

    // Core-peak-stability confirmation: a moved peak would mean the halo change is leaking into the
    // core, which the brief requires be reported loudly rather than silently accepted.
    const corePeakDeltas = variantRecords.map((record) => ({
      variant: record.id,
      degree3DeltaFromV0: record.measurement.degree3CorePeakRed - baseline.measurement.degree3CorePeakRed,
      degree1DeltaFromV0: record.measurement.degree1CorePeakRed - baseline.measurement.degree1CorePeakRed,
    }));
    const corePeaksStable = corePeakDeltas.every((delta) => delta.degree3DeltaFromV0 === 0 && delta.degree1DeltaFromV0 === 0);
    if (!corePeaksStable) {
      process.stdout.write(
        `review-halo-calibration WARNING: core peak red channel moved across variants -- this would mean the halo `
        + `change is leaking into the core, which must not happen: ${JSON.stringify(corePeakDeltas)}\n`,
      );
    }

    // Core-visible-against-halo confirmation (second pass): a variant where the degree-3 or degree-1
    // node's own proxy core-edge boundary and its own halo visible extent coincide (`haloBandWidthPx`
    // 0) is flagged here, plainly, as a merge risk rather than folded into a pass/fail judgement -- the
    // brief is explicit that a smaller halo footprint is not itself a win if the core stops reading as
    // distinct from it.
    const coreHaloMergeRiskVariants = variantRecords
      .filter((record) => record.measurement.degree3HaloExtent.haloBandWidthPx <= 0 || record.measurement.degree1HaloExtent.haloBandWidthPx <= 0)
      .map((record) => record.id);
    if (coreHaloMergeRiskVariants.length > 0) {
      process.stdout.write(
        `review-halo-calibration WARNING: core-edge proxy and halo visible extent coincide for `
        + `${JSON.stringify(coreHaloMergeRiskVariants)} -- the core may be visually merging into its own halo\n`,
      );
    }

    const manifest = {
      schemaVersion: 2,
      candidateSha,
      label: "HUMAN REVIEW CALIBRATION SWEEP -- for a person to judge directly; no winner is selected here.",
      residual: "the diffuse halo remains aesthetically too large / soft / dominant (F82, functionally repaired, aesthetic residual)",
      target: "small crisp white core + restrained compact halo, not a large diffuse glowing orb",
      fixtures: {
        discoveryAtQuestion: { id: DISCOVERY_FIXTURE.id, path: DISCOVERY_FIXTURE.path, semanticDigest: discoverySemanticDigest },
        temporalGenesis: { id: TEMPORAL_FIXTURE.id, path: TEMPORAL_FIXTURE.path, semanticDigest: temporalSemanticDigest },
      },
      staticControlledLevel1: {
        containmentRootId,
        recursiveWorld: { nodeIds: [...recursiveLevel1World.nodeIds].sort(), edgeIds: [...recursiveLevel1World.edgeIds].sort() },
        degree3NodeId: degree3Node.id,
        degree1NodeId: degree1Node.id,
      },
      temporalMidInstant: { stepIndex: midStep.stepIndex, instant: midStep.instant, timelineLength: temporalTimeline.length },
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        renderer: "render3f",
        note: "REVIEW-ONLY calibration sweep for human aesthetic judgement of the F82 halo residual; not a closure gate.",
      },
      measurementMethod: {
        corePeak: `max red channel within a ${(CORE_PEAK_HALF_BOX_PX * 2) + 1}x${(CORE_PEAK_HALF_BOX_PX * 2) + 1}px box centred on the node's own rendered viewport position, from static-controlled-recursive-indra-3d-level1`,
        haloFootprint: `count and mean red channel of lit pixels (isLitPixel against this same capture's own local field, filament-continuity.ts) in an annulus ${HALO_ANNULUS_INNER_PX}-${HALO_ANNULUS_OUTER_PX}px from the degree-3 node's centre, from static-controlled-recursive-indra-3d-level1`,
        haloVisibleExtent: `for each of the degree-3 and degree-1 node, sampling mean R/G/B over 1px rings at radius 1..${HALO_VISIBLE_EXTENT_SEARCH_MAX_PX}px from static-controlled-recursive-indra-3d-level1; visibleExtentRadiusPx is the first radius at which EITHER ${HALO_VISIBLE_EXTENT_CONFIRMATION_RINGS} consecutive rings' own mean colour stops being lit against this same capture's own local field (convergedTo "localField"), OR the ring mean red channel stays within ${HALO_PLATEAU_TOLERANCE} of the mean red channel over the trailing ${HALO_PLATEAU_TAIL_WINDOW_RINGS} rings (the profile's own settled tail) for every remaining radius out to the bound (convergedTo "ambientPlateau" -- both test positions sit inside a dense local cluster where neighbouring nodes' and filaments' own light keeps the surroundings measurably above field no matter how far the walk searches, so the profile stabilises rather than returning to field); coreEdgeRadiusPx is the first radius at which the ring mean red channel drops under ${CORE_EDGE_PEAK_FRACTION * 100}% of that node's own measured core peak red (a proxy core-edge boundary, not the geometric core radius); haloBandWidthPx is their difference`,
      },
      summary: { positionsUnchanged, corePeaksStable, positionMismatchVariants: positionMismatches, corePeakDeltas, coreHaloMergeRiskVariants },
      variants: variantRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-halo-calibration-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `review-halo-calibration: ${variantRecords.length} variants; positionsUnchanged=${positionsUnchanged}; `
      + `corePeaksStable=${corePeaksStable}; coreHaloMergeRiskVariants=${JSON.stringify(coreHaloMergeRiskVariants)}; `
      + `manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Calibration variant construction.
// ---------------------------------------------------------------------------------------------

function buildCalibrationVariant(variant: HaloVariant): { readonly calibration: CalibrationProfile; readonly resolved: ResolvedHaloValues } {
  const resolved: Record<string, { sharedSceneHaloRadiusMultiplierPermille: number; sharedSceneHaloIntensityPermille: number }> = {};
  const morphology = { ...DEFAULT_CALIBRATION.morphology };
  for (const id of HALO_MORPHOLOGIES) {
    const base = DEFAULT_CALIBRATION.morphology[id];
    const sharedSceneHaloRadiusMultiplierPermille = Math.round((base.sharedSceneHaloRadiusMultiplierPermille * variant.radiusFactorPermille) / 1_000);
    const sharedSceneHaloIntensityPermille = Math.round((base.sharedSceneHaloIntensityPermille * variant.intensityFactorPermille) / 1_000);
    morphology[id] = { ...base, sharedSceneHaloRadiusMultiplierPermille, sharedSceneHaloIntensityPermille };
    resolved[id] = { sharedSceneHaloRadiusMultiplierPermille, sharedSceneHaloIntensityPermille };
  }
  const calibration: CalibrationProfile = { ...DEFAULT_CALIBRATION, morphology };
  assertCalibrationProfile(calibration);
  return { calibration, resolved: resolved as ResolvedHaloValues };
}

// Second pass: overrides the single scalar `luminance.coreBeforeHaloMinimumPx` directly, plus the same
// per-morphology `sharedSceneHaloIntensityPermille` factor buildCalibrationVariant already applies for
// V4, kept for W4's own re-use of the same dimming question at the parameter that actually governs.
function buildCoreGapVariant(variant: CoreGapVariant): { readonly calibration: CalibrationProfile; readonly resolved: ResolvedCoreGapValues } {
  const sharedSceneHaloIntensityPermille: Record<string, number> = {};
  const morphology = { ...DEFAULT_CALIBRATION.morphology };
  for (const id of HALO_MORPHOLOGIES) {
    const base = DEFAULT_CALIBRATION.morphology[id];
    const intensity = Math.round((base.sharedSceneHaloIntensityPermille * variant.intensityFactorPermille) / 1_000);
    morphology[id] = { ...base, sharedSceneHaloIntensityPermille: intensity };
    sharedSceneHaloIntensityPermille[id] = intensity;
  }
  const calibration: CalibrationProfile = {
    ...DEFAULT_CALIBRATION,
    morphology,
    luminance: { ...DEFAULT_CALIBRATION.luminance, coreBeforeHaloMinimumPx: variant.coreBeforeHaloMinimumPx },
  };
  assertCalibrationProfile(calibration);
  return {
    calibration,
    resolved: {
      coreBeforeHaloMinimumPx: variant.coreBeforeHaloMinimumPx,
      sharedSceneHaloIntensityPermille: sharedSceneHaloIntensityPermille as Readonly<Record<Morphology, number>>,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Structural helpers -- duplicated from scale-topology.spec.ts rather than imported (that file exports
// nothing this suite is allowed to import from), matching that file's own stated precedent for the
// identical duplication.
// ---------------------------------------------------------------------------------------------

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
    throw new Error(`review-halo-calibration fixture ${DISCOVERY_FIXTURE.id} has no populated containment root`);
  }
  return best.id;
}

function projectVisualGraph(canonical: VisualGraph, nodeIds: readonly string[], edgeIds: readonly string[]): VisualGraph {
  const canonicalNodeIds = new Set(canonical.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(canonical.edges.map((edge) => edge.id));
  for (const nodeId of nodeIds) {
    if (!canonicalNodeIds.has(nodeId)) {
      throw new TypeError(`review-halo-calibration projection names a node absent from the canonical graph: ${nodeId}`);
    }
  }
  const requestedNodeIds = new Set(nodeIds);
  const nodesById = new Map(canonical.nodes.map((node): [string, VisualNode] => [node.id, node]));
  const edgesById = new Map(canonical.edges.map((edge): [string, VisualEdge] => [edge.id, edge]));
  const projectedEdges: VisualEdge[] = [];
  for (const edgeId of edgeIds) {
    if (!canonicalEdgeIds.has(edgeId)) {
      throw new TypeError(`review-halo-calibration projection names a relation absent from the canonical graph: ${edgeId}`);
    }
    const edge = edgesById.get(edgeId);
    if (edge === undefined) {
      throw new TypeError(`review-halo-calibration projection relation is unavailable: ${edgeId}`);
    }
    if (!requestedNodeIds.has(edge.source) || !requestedNodeIds.has(edge.target)) {
      throw new TypeError(`review-halo-calibration projection relation endpoint is missing from its own requested node set: ${edgeId}`);
    }
    projectedEdges.push(edge);
  }
  const projectedNodes = nodeIds.map((nodeId) => {
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new TypeError(`review-halo-calibration projection node is unavailable: ${nodeId}`);
    }
    return node;
  });
  const projected: VisualGraph = {
    schema_version: canonical.schema_version,
    policy_id: canonical.policy_id,
    question: { valid_at: canonical.question.valid_at, recorded_as_of: canonical.question.recorded_as_of },
    nodes: projectedNodes,
    edges: projectedEdges,
  };
  assertVisualGraphFieldRegister(projected);
  return projected;
}

function requiredPosition(
  positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  nodeId: string,
  label: string,
): { readonly x: number; readonly y: number } {
  const position = positions[nodeId];
  if (position === undefined) {
    throw new Error(`review-halo-calibration capture ${label} did not render a viewport position for ${nodeId}`);
  }
  return position;
}

// ---------------------------------------------------------------------------------------------
// Pixel measurement -- reuses the shipped lit-pixel predicate (filament-continuity.ts) rather than
// defining a second one.
// ---------------------------------------------------------------------------------------------

function corePeakRed(image: PixelImage, centerX: number, centerY: number, halfBoxPx: number): number {
  const cx = Math.round(centerX);
  const cy = Math.round(centerY);
  let peak = 0;
  for (let dy = -halfBoxPx; dy <= halfBoxPx; dy += 1) {
    for (let dx = -halfBoxPx; dx <= halfBoxPx; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
        continue;
      }
      const red = image.data[((y * image.width) + x) * 4] ?? 0;
      if (red > peak) {
        peak = red;
      }
    }
  }
  return peak;
}

function fieldRgbOf(image: PixelImage): readonly [number, number, number] {
  return fieldPixel({ bytes: 0, hash: "", width: image.width, height: image.height, data: image.data });
}

function haloAnnulusFootprint(
  image: PixelImage,
  centerX: number,
  centerY: number,
  innerPx: number,
  outerPx: number,
  fieldRgb: readonly [number, number, number],
): { readonly innerPx: number; readonly outerPx: number; readonly litPixelCount: number; readonly meanRed: number; readonly fieldRgb: readonly [number, number, number] } {
  const cx = Math.round(centerX);
  const cy = Math.round(centerY);
  let litPixelCount = 0;
  let redSum = 0;
  for (let dy = -outerPx; dy <= outerPx; dy += 1) {
    for (let dx = -outerPx; dx <= outerPx; dx += 1) {
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      if (distance < innerPx || distance > outerPx) {
        continue;
      }
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
        continue;
      }
      const offset = ((y * image.width) + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (isLitPixel(red, green, blue, fieldRgb)) {
        litPixelCount += 1;
        redSum += red;
      }
    }
  }
  return { innerPx, outerPx, litPixelCount, meanRed: litPixelCount > 0 ? redSum / litPixelCount : 0, fieldRgb };
}

type RingSample = { readonly meanRed: number; readonly meanGreen: number; readonly meanBlue: number };

function ringSample(image: PixelImage, cx: number, cy: number, radius: number): RingSample | undefined {
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let sampleCount = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.round(Math.sqrt((dx * dx) + (dy * dy))) !== radius) {
        continue;
      }
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
        continue;
      }
      const offset = ((y * image.width) + x) * 4;
      redSum += image.data[offset] ?? 0;
      greenSum += image.data[offset + 1] ?? 0;
      blueSum += image.data[offset + 2] ?? 0;
      sampleCount += 1;
    }
  }
  return sampleCount > 0 ? { meanRed: redSum / sampleCount, meanGreen: greenSum / sampleCount, meanBlue: blueSum / sampleCount } : undefined;
}

// The halo the shader paints is a hard geometric cutoff at its own resolved haloRadius
// (render3f/node-material.ts: alpha is sampled from a finite stop table and never extends past
// v_haloRadiusDevicePx). But static-controlled-recursive-indra-3d-level1's own degree-3/degree-1 test
// pair sits inside a dense local Indra cluster, so a full-circle ring average around either one never
// actually returns to this capture's own corner-sampled background level -- neighbouring nodes' and
// filaments' own light keeps the immediate surroundings measurably above field no matter how far the
// walk searches (measured directly: mean red channel stabilises around 35-40 against a field of 9, from
// roughly 15px outward to past 80px). haloAnnulusFootprint's own 8-24px annulus measures inside that
// same contaminated band already, so this is a property of the position being measured, not a defect in
// this walk. This therefore accepts EITHER of two stopping conditions, and records which one fired: an
// actual return to field (checked first; unlikely at either test position but not ruled out), or the
// first radius from which the profile stays within a tolerance band of its own settled tail average for
// the REST of the walk -- i.e. where the node's own steep falloff has finished giving way to the
// surrounding scene's ambient level, checked against where the profile actually ends up rather than
// against a single ring-to-ring step (which two otherwise near-identical profiles can cross a fixed
// delta threshold on by a couple of red-channel units of dither, reading as though the halo were several
// pixels larger for no real reason). A walk that satisfies neither within the bound is a genuine anomaly
// and fails loudly.
function radialHaloExtent(
  image: PixelImage,
  centerX: number,
  centerY: number,
  corePeakRedValue: number,
  fieldRgb: readonly [number, number, number],
): RadialHaloExtent {
  const cx = Math.round(centerX);
  const cy = Math.round(centerY);
  const rings: (RingSample | undefined)[] = [];
  for (let radius = 1; radius <= HALO_VISIBLE_EXTENT_SEARCH_MAX_PX; radius += 1) {
    rings.push(ringSample(image, cx, cy, radius));
  }
  let coreEdgeRadiusPx = -1;
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    if (ring !== undefined && ring.meanRed < corePeakRedValue * CORE_EDGE_PEAK_FRACTION) {
      coreEdgeRadiusPx = index + 1;
      break;
    }
  }
  let unlitRun = 0;
  let fieldReturnRadiusPx = -1;
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    if (ring === undefined) {
      continue;
    }
    if (isLitPixel(ring.meanRed, ring.meanGreen, ring.meanBlue, fieldRgb)) {
      unlitRun = 0;
      continue;
    }
    unlitRun += 1;
    if (unlitRun === HALO_VISIBLE_EXTENT_CONFIRMATION_RINGS) {
      fieldReturnRadiusPx = (index + 1) - HALO_VISIBLE_EXTENT_CONFIRMATION_RINGS + 1;
      break;
    }
  }
  const tail = rings.slice(-HALO_PLATEAU_TAIL_WINDOW_RINGS).filter((ring): ring is RingSample => ring !== undefined);
  let plateauRadiusPx = -1;
  if (tail.length > 0) {
    const plateauRed = tail.reduce((sum, ring) => sum + ring.meanRed, 0) / tail.length;
    for (let index = 0; index < rings.length && plateauRadiusPx === -1; index += 1) {
      const staysWithinTolerance = rings.slice(index).every((ring) => ring === undefined || Math.abs(ring.meanRed - plateauRed) <= HALO_PLATEAU_TOLERANCE);
      if (staysWithinTolerance) {
        plateauRadiusPx = index + 1;
      }
    }
  }
  let visibleExtentRadiusPx: number;
  let convergedTo: RadialHaloExtent["convergedTo"];
  if (fieldReturnRadiusPx !== -1 && (plateauRadiusPx === -1 || fieldReturnRadiusPx <= plateauRadiusPx)) {
    visibleExtentRadiusPx = fieldReturnRadiusPx;
    convergedTo = "localField";
  } else if (plateauRadiusPx !== -1) {
    visibleExtentRadiusPx = plateauRadiusPx;
    convergedTo = "ambientPlateau";
  } else {
    throw new Error(
      `review-halo-calibration radial halo profile at (${centerX}, ${centerY}) neither returned to field `
      + `nor stabilised within ${HALO_VISIBLE_EXTENT_SEARCH_MAX_PX}px`,
    );
  }
  // Never dropping under half its own peak before the halo itself resolves means this proxy could not
  // find a core-edge boundary distinct from the halo's own outer edge -- reported as coincident
  // (haloBandWidthPx 0) rather than as a sentinel, since it is itself the merge-risk signal the brief
  // asks this suite to surface.
  const resolvedCoreEdgeRadiusPx = coreEdgeRadiusPx === -1 ? visibleExtentRadiusPx : coreEdgeRadiusPx;
  return {
    coreEdgeRadiusPx: resolvedCoreEdgeRadiusPx,
    visibleExtentRadiusPx,
    haloBandWidthPx: visibleExtentRadiusPx - resolvedCoreEdgeRadiusPx,
    convergedTo,
  };
}

async function writeCropDiagnostic(image: PixelImage, centerX: number, centerY: number, outputPath: string): Promise<void> {
  const crop = extractCrop(image, centerX, centerY, DIAGNOSTIC_CROP_HALF_BOX_PX);
  const magnified = magnifyNearestNeighbor(crop, DIAGNOSTIC_CROP_MAGNIFICATION);
  await writeFile(outputPath, encodePng(magnified.width, magnified.height, magnified.data));
}

function extractCrop(image: PixelImage, centerX: number, centerY: number, halfBoxPx: number): PixelImage {
  const size = halfBoxPx * 2;
  const startX = clamp(Math.round(centerX) - halfBoxPx, 0, image.width - size);
  const startY = clamp(Math.round(centerY) - halfBoxPx, 0, image.height - size);
  const data = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const sourceRowStart = (((startY + row) * image.width) + startX) * 4;
    const targetRowStart = row * size * 4;
    image.data.copy(data, targetRowStart, sourceRowStart, sourceRowStart + (size * 4));
  }
  return { width: size, height: size, data };
}

function magnifyNearestNeighbor(image: PixelImage, factor: number): PixelImage {
  const width = image.width * factor;
  const height = image.height * factor;
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = Math.floor(row / factor);
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = Math.floor(column / factor);
      const sourceOffset = ((sourceRow * image.width) + sourceColumn) * 4;
      const targetOffset = ((row * width) + column) * 4;
      image.data.copy(data, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { width, height, data };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

// ---------------------------------------------------------------------------------------------
// Shared page-bundling/capture helpers -- duplicated from review-motion.spec.ts's own equivalents,
// matching that suite's own stated precedent for duplicating rather than importing across capture
// suites in this directory.
// ---------------------------------------------------------------------------------------------

type RenderedFrame = {
  readonly fileName: string;
  readonly filePath: string;
  readonly witness: ReviewHaloCaptureWitness;
  readonly rawFileSha256: string;
};

async function renderFrame(
  page: Page,
  request: ReviewHaloCaptureRequest,
  outputDirectory: string,
  fileName: string,
): Promise<RenderedFrame> {
  const witness = await invokeCapture(page, request);
  const filePath = join(outputDirectory, fileName);
  await page.locator("#review-halo-calibration-root").screenshot({ path: filePath });
  const bytes = await readFile(filePath);
  const dimensions = pngDimensions(bytes, fileName);
  if (dimensions.width !== CAPTURE_WIDTH || dimensions.height !== CAPTURE_HEIGHT) {
    throw new Error(`review-halo-calibration frame ${fileName} has unexpected dimensions ${dimensions.width}x${dimensions.height}`);
  }
  return { fileName, filePath, witness, rawFileSha256: sha256(bytes) };
}

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "review-halo-calibration.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("review-halo-calibration page module output is unavailable");
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
    const api = window.__reviewHaloCalibration;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<ReviewHaloPageApi> {
  return page.evaluate(() => {
    const api = window.__reviewHaloCalibration;
    if (api === undefined) {
      throw new Error("review-halo-calibration page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<ReviewHaloFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__reviewHaloCalibration;
    if (api === undefined) {
      throw new Error("review-halo-calibration page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: ReviewHaloCaptureRequest): Promise<ReviewHaloCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__reviewHaloCalibration;
    if (api === undefined) {
      throw new Error("review-halo-calibration page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function gitHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "..", encoding: "utf8" });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("review-halo-calibration suite could not determine the current commit SHA");
  }
  return sha;
}
