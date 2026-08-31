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
 * X0-X4 (third pass): an independent audit found the first two passes stopped one lever short of the
 * ones actually authorized. `sharedSceneHaloRadiusMultiplierPermille` is proven inert (see V0-V4 above),
 * `luminance.coreBeforeHaloMinimumPx` and `luminance.haloFalloffPermille` are both effective but SHARED
 * with the frozen render2d renderer, and `sharedSceneHaloIntensityPermille` is effective, SHARED-SCENE
 * ONLY, and clear of the render2d freeze -- but the first pass sampled only one point on it (V4, x0.75).
 * This third pass sweeps that one lever alone, proportionally across all three morphologies, at five
 * points: X0 (x1.00, control, == V0/W0), X1 (x0.75, == V4's own intensity factor, but without V4's
 * radius change), X2 (x0.50), X3 (x0.35), X4 (x0.20). Every other calibration value, including
 * `luminance.coreBeforeHaloMinimumPx`, is left at its shipped value.
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
 * of capture (3)'s own degree-3 cluster and its one degree-1 bridge -- secondary evidence only. Every
 * one of V0-V4/W0-W4/X0-X4 shares this same five-capture set, camera derivation and measurement
 * pipeline, so all three passes sit in one comparable manifest.
 *
 * Measurement (not judgement): per variant, the degree-3 and degree-1 CORE peak red-channel value at
 * capture (3), ASSERTED not to move (a moved core peak would mean the halo change is leaking into the
 * core -- `node-material.ts`'s own fragment shader multiplies the halo term by `(1 - coreAlpha)`, which
 * is exactly zero wherever `coreAlpha` is 1, i.e. at the measured peak, so this is a structural guarantee
 * this suite checks rather than merely hopes for), the halo footprint in an 8-24px annulus around the
 * degree-3 node (lit-pixel count and mean red-channel value against that same capture's own local field,
 * reusing the shipped `isLitPixel`/`fieldPixel` predicate filament-continuity.ts already defines), and
 * confirmation, ASSERTED, that every node's own rendered viewport position is unchanged across variants.
 *
 * A prior "halo visible extent" metric (a radial walk outward from each test node, carried through
 * W0-W4) has been REMOVED here, not fixed: an audit found it reported the *smallest* rendered halo as
 * having the *largest* extent, because it tracked the radius at which the profile settled onto the
 * surrounding scene's own ambient light level rather than the radius at which the node's own halo
 * actually ends. That ambient level is AGGREGATE WINDOW FILL -- Indra's own community window rendering --
 * not, as this suite's own prior comments incorrectly said, neighbouring nodes' and filaments' own light:
 * an ablation over this same capture found 20,685 pixels at exactly red 35 with Indra windows on and 89
 * with them off, i.e. the windows account for roughly 84% of all light above field in that frame. The
 * audit measured the real halo band directly instead, finding it sits at r~11-13px in every variant,
 * which is recorded here as an established fact rather than re-derived by a metric already shown to
 * invert.
 *
 * X0-X4 add three further measurements relative to X0 (its own control): per-capture CHANGED-PIXEL
 * SHARE (all five captures, named individually -- a prior table quoted one number without saying which
 * frame it came from, and a sibling capture broke the stated bound), LABEL DISPLACEMENT (of a capture's
 * own changed pixels, the count lying further than 20px from any node's own rendered centre -- the
 * gap-floor W-variants moved node labels because a label's own placement offset IS `haloRadiusPx`
 * (`scene/build.ts`'s own `placementOffsetPx: haloRadiusPx`), which contaminated their changed-pixel
 * figures with moved text rather than a changed halo; an intensity-only variant changes no radius, so
 * this is ASSERTED at zero here, not merely reported), and frame-level INK ABOVE FIELD alongside TOTAL
 * RED (from capture (3)): total red is the sum of the red channel over every pixel, background included,
 * and is dominated by the field itself; ink above field sums only the excess red channel of pixels this
 * suite already classifies as lit (`isLitPixel`) over that same capture's own field value, i.e. the red
 * channel actually contributed by drawn content. Each X1-X4 variant's own delta from X0 is reported as a
 * fraction of both denominators side by side, labelled which is which, so a change that reads as small
 * against total red (mostly background) is not mistaken for small against the light actually drawn.
 *
 * This suite recommends nothing; a human judges the images.
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
// Third pass (X0-X4): a changed pixel further than this from every node's own rendered centre is read as
// a moved label rather than a changed halo (see this file's own docstring -- a label's own placement
// offset is `haloRadiusPx` itself, so a radius change moves it, while an intensity-only change does not).
const LABEL_DISPLACEMENT_RADIUS_PX = 20;

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

// Third pass (see this file's own docstring): the one lever the audit found authorized, effective, and
// clear of the render2d freeze -- `sharedSceneHaloIntensityPermille` alone, proportionally across all
// three morphologies, with every other value (including `luminance.coreBeforeHaloMinimumPx`) left at its
// shipped value. X1 reuses V4's own intensity factor without V4's radius change, so the two are directly
// comparable.
type IntensityOnlyVariant = {
  readonly id: "X0" | "X1" | "X2" | "X3" | "X4";
  readonly label: string;
  readonly intensityFactorPermille: number;
};

const INTENSITY_ONLY_VARIANTS: readonly IntensityOnlyVariant[] = [
  { id: "X0", label: "control: intensity x1.00 (== V0/W0)", intensityFactorPermille: 1_000 },
  { id: "X1", label: "intensity x0.75 (== V4's own intensity, without V4's radius change)", intensityFactorPermille: 750 },
  { id: "X2", label: "intensity x0.50", intensityFactorPermille: 500 },
  { id: "X3", label: "intensity x0.35", intensityFactorPermille: 350 },
  { id: "X4", label: "intensity x0.20", intensityFactorPermille: 200 },
];
const INTENSITY_ONLY_VARIANT_IDS: ReadonlySet<string> = new Set(INTENSITY_ONLY_VARIANTS.map((variant) => variant.id));

function isIntensityOnlyVariantId(id: HaloVariantId): id is IntensityOnlyVariant["id"] {
  return INTENSITY_ONLY_VARIANT_IDS.has(id);
}

type HaloVariantId = HaloVariant["id"] | CoreGapVariant["id"] | IntensityOnlyVariant["id"];

type ResolvedHaloValues = Readonly<Record<Morphology, {
  readonly sharedSceneHaloRadiusMultiplierPermille: number;
  readonly sharedSceneHaloIntensityPermille: number;
}>>;

type ResolvedCoreGapValues = {
  readonly coreBeforeHaloMinimumPx: number;
  readonly sharedSceneHaloIntensityPermille: Readonly<Record<Morphology, number>>;
};

// Frame-level red-channel accounting (third pass): `totalRedSum` is the sum of the red channel over
// every pixel in the frame, background included, and is dominated by the field itself. `inkAboveFieldSum`
// sums only the excess red channel of pixels this suite already classifies as lit (`isLitPixel`) over
// that same capture's own field value -- the red channel actually contributed by drawn content, not the
// field it sits on. Both are carried so a delta between variants can be reported as a fraction of each,
// labelled which is which, rather than only against the total (which the audit found reads roughly 12x
// smaller than the same delta reads against ink above field, because total red is ~91.6% background in
// this capture).
type FrameInkMeasurement = {
  readonly totalPixelCount: number;
  readonly totalRedSum: number;
  readonly litPixelCount: number;
  readonly inkAboveFieldSum: number;
  readonly inkAboveFieldFraction: number;
};

type MeasurementRecord = {
  readonly degree3NodeId: string;
  readonly degree1NodeId: string;
  readonly degree3CorePeakRed: number;
  readonly degree1CorePeakRed: number;
  readonly haloFootprint: { readonly innerPx: number; readonly outerPx: number; readonly litPixelCount: number; readonly meanRed: number; readonly fieldRgb: readonly [number, number, number] };
  readonly frameInk: FrameInkMeasurement;
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
  // Every capture's own rendered node positions, named by capture -- unlike `nodeViewportPositions`
  // above (capture (3) only, used by the positions-unchanged check), this backs the third pass's own
  // per-capture label-displacement measurement, which needs a node-centre set for every one of the five
  // captures, not just capture (3).
  readonly captureNodeViewportPositions: Readonly<Record<CaptureName, Readonly<Record<string, { readonly x: number; readonly y: number }>>>>;
};

type CaptureName = "discoveryStellar" | "discoveryMycelium" | "staticControlledLevel1" | "motionReconfigurePhase04" | "temporalMyceliumMidInstant";
const CAPTURE_NAMES: readonly CaptureName[] = ["discoveryStellar", "discoveryMycelium", "staticControlledLevel1", "motionReconfigurePhase04", "temporalMyceliumMidInstant"];

// Third pass diagnostics, one per named capture, X1-X4 against X0 (its own control).
type CaptureDiagnostic = {
  readonly captureName: CaptureName;
  readonly fileName: string;
  readonly totalPixelCount: number;
  readonly changedPixelCount: number;
  readonly changedPixelFraction: number;
  readonly labelDisplacedPixelCount: number;
};

type IntensitySeriesRecord = {
  readonly id: IntensityOnlyVariant["id"];
  readonly label: string;
  readonly frameInk: FrameInkMeasurement;
  // null for X0 itself, which is its own control.
  readonly deltaVsControl: {
    readonly totalRedSumDelta: number;
    readonly inkAboveFieldSumDelta: number;
    readonly deltaAsFractionOfControlTotalRed: number;
    readonly deltaAsFractionOfControlInkAboveField: number;
  } | null;
  readonly vsControl: readonly CaptureDiagnostic[] | null;
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

    // All three passes share one comparable loop and one manifest: V0-V4 (radius/intensity, first pass,
    // kept exactly as originally computed), W0-W4 (coreBeforeHaloMinimumPx/intensity, second pass), then
    // X0-X4 (intensity alone, third pass). Resolved calibration profiles are built once, up front, so the
    // loop body below -- captures, measurement, diagnostics -- is identical for every one of the fifteen
    // variants.
    const allVariants: readonly { readonly id: HaloVariantId; readonly label: string; readonly calibration: CalibrationProfile; readonly resolved: ResolvedHaloValues | ResolvedCoreGapValues }[] = [
      ...VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, ...buildCalibrationVariant(variant) })),
      ...CORE_GAP_VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, ...buildCoreGapVariant(variant) })),
      ...INTENSITY_ONLY_VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, ...buildIntensityOnlyVariant(variant) })),
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
      // variants), the halo footprint in the annulus around the degree-3 node, and the frame-level total
      // red / ink above field accounting the third pass adds (see this file's own docstring).
      const staticControlledImage = decodePng(await readFile(join(variantDirectory, staticControlledFrame.fileName)), staticControlledFrame.fileName);
      const staticControlledFieldRgb = fieldRgbOf(staticControlledImage);
      const degree3Position = requiredPosition(staticControlledFrame.witness.nodeViewportPositions, degree3Node.id, staticControlledFrame.fileName);
      const degree1Position = requiredPosition(staticControlledFrame.witness.nodeViewportPositions, degree1Node.id, staticControlledFrame.fileName);
      const degree3CorePeakRed = corePeakRed(staticControlledImage, degree3Position.x, degree3Position.y, CORE_PEAK_HALF_BOX_PX);
      const degree1CorePeakRed = corePeakRed(staticControlledImage, degree1Position.x, degree1Position.y, CORE_PEAK_HALF_BOX_PX);
      const haloFootprint = haloAnnulusFootprint(staticControlledImage, degree3Position.x, degree3Position.y, HALO_ANNULUS_INNER_PX, HALO_ANNULUS_OUTER_PX, staticControlledFieldRgb);
      const frameInk = frameInkMeasurement(staticControlledImage, staticControlledFieldRgb);

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
          frameInk,
        },
        nodeViewportPositions: staticControlledFrame.witness.nodeViewportPositions,
        captureNodeViewportPositions: {
          discoveryStellar: stellarFrame.witness.nodeViewportPositions,
          discoveryMycelium: myceliumFrame.witness.nodeViewportPositions,
          staticControlledLevel1: staticControlledFrame.witness.nodeViewportPositions,
          motionReconfigurePhase04: motionFrame.witness.nodeViewportPositions,
          temporalMyceliumMidInstant: temporalFrame.witness.nodeViewportPositions,
        },
      });
    }

    // Positions-unchanged confirmation: every variant's own capture (3) node viewport positions must be
    // byte-identical to V0's, since only halo calibration changed -- layout, camera and node/core size
    // are untouched by every variant this suite constructs. ASSERTED, not merely reported: the docstring
    // says a core peak "must not move", and a warning that still exits 0 does not enforce that.
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
    expect(positionsUnchanged, `review-halo-calibration: node viewport positions moved across variants ${JSON.stringify(positionMismatches)}`).toBe(true);

    // Core-peak-stability confirmation: a moved peak would mean the halo change is leaking into the
    // core. ASSERTED for the same reason positionsUnchanged is above.
    const corePeakDeltas = variantRecords.map((record) => ({
      variant: record.id,
      degree3DeltaFromV0: record.measurement.degree3CorePeakRed - baseline.measurement.degree3CorePeakRed,
      degree1DeltaFromV0: record.measurement.degree1CorePeakRed - baseline.measurement.degree1CorePeakRed,
    }));
    const corePeaksStable = corePeakDeltas.every((delta) => delta.degree3DeltaFromV0 === 0 && delta.degree1DeltaFromV0 === 0);
    expect(corePeaksStable, `review-halo-calibration: core peak red channel moved across variants ${JSON.stringify(corePeakDeltas.filter((delta) => delta.degree3DeltaFromV0 !== 0 || delta.degree1DeltaFromV0 !== 0))}`).toBe(true);

    // Third pass diagnostics (X0-X4 vs X0, its own control): per-capture changed-pixel share, named by
    // capture, and label displacement -- the count of a capture's own changed pixels lying further than
    // LABEL_DISPLACEMENT_RADIUS_PX from any node's own rendered centre in that same capture. Intensity
    // alone changes no radius, so no label should move; ASSERTED at zero rather than only reported, which
    // is the "confirm it" the brief asked for.
    const intensityRecords = variantRecords.filter((record): record is VariantRecord & { readonly id: IntensityOnlyVariant["id"] } => isIntensityOnlyVariantId(record.id));
    const intensityControl = intensityRecords.find((record) => record.id === "X0");
    if (intensityControl === undefined) {
      throw new Error("review-halo-calibration produced no X0 (intensity-only control) record");
    }
    const intensitySeries: IntensitySeriesRecord[] = [];
    for (const record of intensityRecords) {
      if (record.id === "X0") {
        intensitySeries.push({ id: record.id, label: record.label, frameInk: record.measurement.frameInk, deltaVsControl: null, vsControl: null });
        continue;
      }
      const vsControl: CaptureDiagnostic[] = [];
      for (const captureName of CAPTURE_NAMES) {
        const controlFile = join(ROOT_DIRECTORY, intensityControl.id, intensityControl.captures[captureName].fileName);
        const variantFile = join(ROOT_DIRECTORY, record.id, record.captures[captureName].fileName);
        const controlImage = decodePng(await readFile(controlFile), controlFile);
        const variantImage = decodePng(await readFile(variantFile), variantFile);
        const diagnostic = changedPixelDiagnostics(
          controlImage,
          variantImage,
          controlFile,
          variantFile,
          captureName,
          record.captureNodeViewportPositions[captureName],
          LABEL_DISPLACEMENT_RADIUS_PX,
        );
        expect(
          diagnostic.labelDisplacedPixelCount,
          `review-halo-calibration: ${record.id} capture ${captureName} changed ${diagnostic.labelDisplacedPixelCount} pixels further than `
          + `${LABEL_DISPLACEMENT_RADIUS_PX}px from any node centre -- an intensity-only variant should move no label`,
        ).toBe(0);
        vsControl.push(diagnostic);
      }
      const deltaVsControl = {
        totalRedSumDelta: record.measurement.frameInk.totalRedSum - intensityControl.measurement.frameInk.totalRedSum,
        inkAboveFieldSumDelta: record.measurement.frameInk.inkAboveFieldSum - intensityControl.measurement.frameInk.inkAboveFieldSum,
        deltaAsFractionOfControlTotalRed: Math.abs(record.measurement.frameInk.totalRedSum - intensityControl.measurement.frameInk.totalRedSum) / intensityControl.measurement.frameInk.totalRedSum,
        deltaAsFractionOfControlInkAboveField: Math.abs(record.measurement.frameInk.inkAboveFieldSum - intensityControl.measurement.frameInk.inkAboveFieldSum) / intensityControl.measurement.frameInk.inkAboveFieldSum,
      };
      intensitySeries.push({ id: record.id, label: record.label, frameInk: record.measurement.frameInk, deltaVsControl, vsControl });
    }

    const manifest = {
      schemaVersion: 3,
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
      // A prior "haloVisibleExtent" entry was removed here, not fixed: an audit found the metric behind
      // it reported the smallest rendered halo as having the largest extent, because it tracked where a
      // profile settled onto the surrounding scene's own ambient light level rather than where the
      // node's own halo actually ends. That level is AGGREGATE WINDOW FILL (Indra's own community window
      // rendering), not neighbouring nodes' and filaments' own light as this suite's own prior text said
      // -- an ablation over this same capture found 20,685 pixels at exactly red 35 with Indra windows on
      // and 89 with them off, i.e. the windows account for roughly 84% of all light above field there.
      // The audit measured the real halo band directly instead: r~11-13px in every variant.
      ambientPlateauCorrection: {
        wasIncorrectlyDescribedAs: "neighbouring nodes' and filaments' own light",
        actuallyIs: "aggregate window fill (Indra's own community window rendering)",
        ablation: "20,685 pixels at exactly red 35 with Indra windows on vs. 89 with them off, over the same capture -- windows account for roughly 84% of all light above field there",
        realHaloBandPx: "r~11-13, measured directly, in every variant",
      },
      measurementMethod: {
        corePeak: `max red channel within a ${(CORE_PEAK_HALF_BOX_PX * 2) + 1}x${(CORE_PEAK_HALF_BOX_PX * 2) + 1}px box centred on the node's own rendered viewport position, from static-controlled-recursive-indra-3d-level1; ASSERTED not to move across any variant`,
        haloFootprint: `count and mean red channel of lit pixels (isLitPixel against this same capture's own local field, filament-continuity.ts) in an annulus ${HALO_ANNULUS_INNER_PX}-${HALO_ANNULUS_OUTER_PX}px from the degree-3 node's centre, from static-controlled-recursive-indra-3d-level1`,
        frameInk: "totalRedSum is the sum of the red channel over every pixel of static-controlled-recursive-indra-3d-level1, background included; inkAboveFieldSum sums only the excess red channel (red minus this same capture's own field red) of pixels classified lit (isLitPixel); inkAboveFieldFraction is inkAboveFieldSum/totalRedSum, i.e. the share of total red that is actually drawn content rather than field. For X1-X4, deltaVsControl reports the delta from X0 as a fraction of EACH of X0's own totalRedSum and inkAboveFieldSum, labelled which is which.",
        changedPixelDiagnostics: `for X1-X4 only, per named capture, against that same capture from X0: changedPixelCount/changedPixelFraction is the count and fraction of RGBA pixels that differ at all; labelDisplacedPixelCount is the subset of those changed pixels further than ${LABEL_DISPLACEMENT_RADIUS_PX}px from every node's own rendered centre in that capture (an intensity-only change moves no label, so this is asserted at 0, not only reported)`,
      },
      summary: { positionsUnchanged, corePeaksStable, positionMismatchVariants: positionMismatches, corePeakDeltas },
      variants: variantRecords,
      intensitySeries,
    };
    const manifestFile = join(ROOT_DIRECTORY, "review-halo-calibration-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `review-halo-calibration: ${variantRecords.length} variants; positionsUnchanged=${positionsUnchanged}; `
      + `corePeaksStable=${corePeaksStable}; manifest=${manifestFile}\n`,
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

// Third pass: overrides only `sharedSceneHaloIntensityPermille`, proportionally per morphology, exactly
// as buildCalibrationVariant's own intensity factor does -- but never touches
// `sharedSceneHaloRadiusMultiplierPermille` or `luminance.coreBeforeHaloMinimumPx`, both left at their
// shipped values, so this is the one lever the audit found authorized, effective, and clear of the
// render2d freeze, swept alone.
function buildIntensityOnlyVariant(variant: IntensityOnlyVariant): { readonly calibration: CalibrationProfile; readonly resolved: ResolvedHaloValues } {
  const resolved: Record<string, { sharedSceneHaloRadiusMultiplierPermille: number; sharedSceneHaloIntensityPermille: number }> = {};
  const morphology = { ...DEFAULT_CALIBRATION.morphology };
  for (const id of HALO_MORPHOLOGIES) {
    const base = DEFAULT_CALIBRATION.morphology[id];
    const sharedSceneHaloIntensityPermille = Math.round((base.sharedSceneHaloIntensityPermille * variant.intensityFactorPermille) / 1_000);
    morphology[id] = { ...base, sharedSceneHaloIntensityPermille };
    resolved[id] = { sharedSceneHaloRadiusMultiplierPermille: base.sharedSceneHaloRadiusMultiplierPermille, sharedSceneHaloIntensityPermille };
  }
  const calibration: CalibrationProfile = { ...DEFAULT_CALIBRATION, morphology };
  assertCalibrationProfile(calibration);
  return { calibration, resolved: resolved as ResolvedHaloValues };
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

// Frame-level red-channel accounting (third pass, see this file's own docstring for why this exists
// alongside haloAnnulusFootprint above): totalRedSum sums the red channel over every pixel, background
// included; inkAboveFieldSum sums only the excess red channel of pixels this suite already classifies as
// lit (isLitPixel), i.e. the red channel actually contributed by drawn content rather than the field it
// sits on.
function frameInkMeasurement(image: PixelImage, fieldRgb: readonly [number, number, number]): FrameInkMeasurement {
  const totalPixelCount = image.width * image.height;
  let totalRedSum = 0;
  let litPixelCount = 0;
  let inkAboveFieldSum = 0;
  for (let pixelIndex = 0; pixelIndex < totalPixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    totalRedSum += red;
    if (isLitPixel(red, green, blue, fieldRgb)) {
      litPixelCount += 1;
      inkAboveFieldSum += Math.max(0, red - fieldRgb[0]);
    }
  }
  return {
    totalPixelCount,
    totalRedSum,
    litPixelCount,
    inkAboveFieldSum,
    inkAboveFieldFraction: totalRedSum > 0 ? inkAboveFieldSum / totalRedSum : 0,
  };
}

// Third pass: the fraction of RGBA pixels that differ between an X-series variant and X0 (its own
// control) for one named capture, plus the subset of those changed pixels that lie further than
// `labelDisplacementRadiusPx` from every node's own rendered centre in that capture -- i.e. changed
// pixels that cannot be explained by a node's own halo and instead look like a moved label. Mirrors
// motion.ts's own `changedPixelFraction` (duplicated rather than imported, matching that file's and
// scale-topology.spec.ts's own stated precedent for the identical duplication), extended with the
// per-pixel node-distance check the third pass needs.
function changedPixelDiagnostics(
  a: PixelImage,
  b: PixelImage,
  aName: string,
  bName: string,
  captureName: CaptureName,
  nodeCenters: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  labelDisplacementRadiusPx: number,
): CaptureDiagnostic {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`review-halo-calibration changed-pixel comparison requires equal dimensions: ${aName} is ${a.width}x${a.height}, ${bName} is ${b.width}x${b.height}`);
  }
  const centers = Object.values(nodeCenters);
  if (centers.length === 0) {
    throw new Error(`review-halo-calibration changed-pixel comparison for ${bName} has no node centres to measure label displacement against`);
  }
  const totalPixelCount = a.width * a.height;
  let changedPixelCount = 0;
  let labelDisplacedPixelCount = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const offset = ((y * a.width) + x) * 4;
      if (
        a.data[offset] === b.data[offset]
        && a.data[offset + 1] === b.data[offset + 1]
        && a.data[offset + 2] === b.data[offset + 2]
        && a.data[offset + 3] === b.data[offset + 3]
      ) {
        continue;
      }
      changedPixelCount += 1;
      let nearestDistancePx = Infinity;
      for (const center of centers) {
        const distance = Math.hypot(x - center.x, y - center.y);
        if (distance < nearestDistancePx) {
          nearestDistancePx = distance;
        }
      }
      if (nearestDistancePx > labelDisplacementRadiusPx) {
        labelDisplacedPixelCount += 1;
      }
    }
  }
  return {
    captureName,
    fileName: bName,
    totalPixelCount,
    changedPixelCount,
    changedPixelFraction: changedPixelCount / totalPixelCount,
    labelDisplacedPixelCount,
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
