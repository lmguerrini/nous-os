/**
 * CAP-13 calibration evidence matrix. Reads CALIBRATION-EVIDENCE-DESIGN.md's controlled base and
 * twelve-cell selection (never a Cartesian product): one shared base, then node sharpness/bloom,
 * palette and preset each varied one at a time. Chromatic measurement (WCAG contrast,
 * post-dichromacy perceptual separation) is computed directly from `#engine/tokens.ts`'s own pure
 * functions at the Node level, exactly as `#engine/scale-topology.ts` is in scale-topology.spec.ts;
 * only the rendered evidence crosses into the browser.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { assertCalibrationProfile, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import { PRESET_CALIBRATIONS, PRESET_NAMES } from "#engine/presets.ts";
import type { PresetName } from "#engine/presets.ts";
import {
  CATEGORICAL_MINIMUM_PAIRWISE_DELTA_E,
  TOKEN_RAMPS,
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  contrastRatio,
  perceptualColorDifference,
  resolveTokens,
  simulatedContrastRatio,
  simulatedPerceptualColorDifference,
} from "#engine/tokens.ts";
import type { DichromacySimulation, OklchToken, Palette, TokenMap } from "#engine/tokens.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type {
  CalibrationCaptureRequest,
  CalibrationCaptureWitness,
  CalibrationFixtureWitness,
  CalibrationPageApi,
} from "#browser/calibration-evidence.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

const CALIBRATION_EVIDENCE_ENABLED = process.env.CALIBRATION_EVIDENCE_CAPTURES === "1";
const CALIBRATION_EVIDENCE_PROJECT = "calibration-evidence";
const CALIBRATION_EVIDENCE_COMMAND = "npm --prefix ui run test:calibration-evidence";
const ROOT_DIRECTORY = join("dist", "calibration-evidence");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FRAME_CONTAINMENT_MARGIN_CSS_PX = 64;
const FIXTURE_ID = "indra-portal-windows";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "indra", "indra-portal-windows.json"].join("/");
// This is the plain (identity) exponent `#engine/calibration.ts` itself names, in coreSharpnessPermille's
// own field comment, as "the exponent a plain gradient core would use" -- i.e. the pre-sharpening
// baseline every governed morphology material sharpened away from under this capability's B17
// criterion. It is not a rediscovered historical commit; it is the documented identity value the
// shader's own contract names, used here as the "superseded soft profile" this axis compares against.
const PLAIN_GRADIENT_CORE_SHARPNESS_PERMILLE = 1000;
// Arbitrary, fixed and reproducible -- accent-hue has no default anchor, so the suite must declare one.
const ACCENT_HUE_ANCHOR_DEGREES = 220;
const CHROMATIC_TEMPERATURE = "balanced";
const CHROMATIC_THEME = "dark";
const DICHROMACY_SIMULATIONS: readonly DichromacySimulation[] = ["protanopia", "deuteranopia"];

type CellAxis = "control" | "nodeSharpness" | "palette" | "preset";

type CellDefinition = {
  readonly id: string;
  readonly axis: CellAxis;
  readonly axisValue: string;
  readonly palette: Palette;
  readonly hueAnchorDegrees?: number;
  readonly calibration: CalibrationProfile;
  /** This is asserted, not assumed: a cell whose calibration is byte-identical to the control's own must render byte-identical pixels. */
  readonly expectPixelEqualToControl: boolean;
};

type ContrastMeasurement = {
  readonly role: string;
  readonly plainContrastRatio: number;
  readonly protanopiaContrastRatio: number;
  readonly deuteranopiaContrastRatio: number;
  readonly worstCaseContrastRatio: number;
  readonly requiredMinimum: number;
  readonly passed: boolean;
};

type PairwiseSeparationMeasurement = {
  readonly leftRole: string;
  readonly rightRole: string;
  readonly plainDeltaE76: number;
  readonly protanopiaDeltaE76: number;
  readonly deuteranopiaDeltaE76: number;
  readonly worstCaseDeltaE76: number;
  readonly requiredMinimum: number;
  readonly passed: boolean;
};

type ChromaticFloorResult = {
  readonly disabled: false;
  readonly contrast: readonly ContrastMeasurement[];
  readonly pairwiseSeparation: readonly PairwiseSeparationMeasurement[] | null;
} | {
  readonly disabled: true;
  readonly reason: string;
};

type CaptureRecord = {
  readonly cellId: string;
  readonly axis: CellAxis;
  readonly axisValue: string;
  readonly fileName: string;
  readonly palette: Palette;
  readonly hueAnchorDegrees: number | null;
  readonly cameraKind: "orthographic";
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly pixelSha256: string;
  readonly pixelDimensions: { readonly width: number; readonly height: number };
  readonly resolvedCalibration: CalibrationProfile;
  readonly cameraBounds: { readonly x: readonly [number, number]; readonly y: readonly [number, number] };
  readonly darkestPixel: readonly [number, number, number];
  readonly chromaticFloor: ChromaticFloorResult | null;
};

type CalibrationManifest = {
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
  readonly controlledBase: {
    readonly morphology: "stellar";
    readonly organization: "indra";
    readonly projection: "2d";
    readonly cameraKind: "orthographic";
    readonly temperature: typeof CHROMATIC_TEMPERATURE;
    readonly theme: typeof CHROMATIC_THEME;
    readonly lodBand: "micro";
    readonly reducedMotion: true;
    readonly devicePixelRatio: 1;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly seed: number;
  };
  readonly cellSelection: {
    readonly assertion: "Twelve cells, one variable at a time from a single shared base -- never a Cartesian product.";
    readonly totalCells: 12;
    readonly axes: {
      readonly nodeSharpness: readonly string[];
      readonly palette: readonly string[];
      readonly preset: readonly string[];
    };
  };
  readonly visualInertInvariant: {
    readonly assertion: "Every calibration cell renders the identical governed node id set and relation id set as the shared base; calibration is a visual layer and must not change graph meaning, topology, membership, provenance or epistemic state.";
    readonly passed: true;
  };
  readonly reproducibilityInvariant: {
    readonly assertion: "Every cell whose calibration is byte-identical to the control's own (sharp core, monochrome palette, balanced preset) renders byte-identical decoded pixels; every cell that declares a different calibration renders measurably different decoded pixels.";
    readonly passed: true;
  };
  readonly frameContainmentInvariant: {
    readonly assertion: "Every cell's resolved node positions fall inside the captured frame, within a fixed pixel margin.";
    readonly marginCssPx: number;
    readonly passed: true;
  };
  readonly captures: readonly CaptureRecord[];
  readonly negativeControl: { readonly message: string; readonly restored: true };
};

test("governed calibration evidence matrix", async ({ page }, testInfo) => {
  test.skip(!CALIBRATION_EVIDENCE_ENABLED || testInfo.project.name !== CALIBRATION_EVIDENCE_PROJECT, "run this through the dedicated calibration-evidence project");
  if (!CALIBRATION_EVIDENCE_ENABLED || testInfo.project.name !== CALIBRATION_EVIDENCE_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await rm(ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = graph.nodes.map((node) => node.id).sort();
  const canonicalEdgeIds = graph.edges.map((edge) => edge.id).sort();
  const fixtureSemanticDigest = semanticDigest(graph);

  const softCalibration = withPlainGradientCore(DEFAULT_CALIBRATION);
  assertCalibrationProfile(softCalibration);
  for (const name of PRESET_NAMES) {
    assertCalibrationProfile(PRESET_CALIBRATIONS[name]);
  }
  const balancedIsByteIdenticalToDefault = JSON.stringify(PRESET_CALIBRATIONS.balanced) === JSON.stringify(DEFAULT_CALIBRATION);
  if (!balancedIsByteIdenticalToDefault) {
    throw new Error("calibration-evidence control invariant failed: the balanced preset no longer reproduces DEFAULT_CALIBRATION byte-for-byte");
  }

  const cells: readonly CellDefinition[] = [
    { id: "control", axis: "control", axisValue: "sharp-monochrome-balanced", palette: "monochrome", calibration: DEFAULT_CALIBRATION, expectPixelEqualToControl: true },
    { id: "A-sharp", axis: "nodeSharpness", axisValue: "sharp", palette: "monochrome", calibration: DEFAULT_CALIBRATION, expectPixelEqualToControl: true },
    { id: "A-soft", axis: "nodeSharpness", axisValue: "soft", palette: "monochrome", calibration: softCalibration, expectPixelEqualToControl: false },
    { id: "B-monochrome", axis: "palette", axisValue: "monochrome", palette: "monochrome", calibration: DEFAULT_CALIBRATION, expectPixelEqualToControl: true },
    { id: "B-accent-hue", axis: "palette", axisValue: "accent-hue", palette: "accent-hue", hueAnchorDegrees: ACCENT_HUE_ANCHOR_DEGREES, calibration: DEFAULT_CALIBRATION, expectPixelEqualToControl: false },
    { id: "B-categorical", axis: "palette", axisValue: "categorical", palette: "categorical", calibration: DEFAULT_CALIBRATION, expectPixelEqualToControl: false },
    ...PRESET_NAMES.map((name): CellDefinition => ({
      id: `C-${name}`,
      axis: "preset",
      axisValue: name,
      palette: "monochrome",
      calibration: PRESET_CALIBRATIONS[name],
      expectPixelEqualToControl: name === "balanced",
    })),
  ];
  if (cells.length !== 12) {
    throw new Error(`calibration-evidence cell selection produced ${cells.length} cells, not the required twelve`);
  }

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const captures: CaptureRecord[] = [];
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);
    expect([...fixtureWitness.nodeIds]).toEqual(canonicalNodeIds);
    expect([...fixtureWitness.edgeIds]).toEqual(canonicalEdgeIds);

    for (const cell of cells) {
      const chromaticFloor = cell.palette === "accent-hue" || cell.palette === "categorical"
        ? measureChromaticFloor(cell.palette, cell.hueAnchorDegrees)
        : null;
      if (chromaticFloor !== null && chromaticFloor.disabled) {
        // The design is explicit: a chromatic mode that cannot meet its floor disables the mode and
        // does not block the suite. Record the disablement as the result and skip only this cell's
        // render -- every other cell still must produce its evidence.
        process.stdout.write(`calibration-evidence ${cell.id} disabled: ${chromaticFloor.reason}\n`);
        continue;
      }
      const record = await requestCapture(page, cell, canonicalNodeIds, canonicalEdgeIds, chromaticFloor);
      captures.push(record);
    }

    assertVisualInertInvariant(captures, canonicalNodeIds, canonicalEdgeIds);
    const control = requiredCapture(captures, "control");
    assertReproducibilityInvariant(captures, control);

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("calibration-evidence tracked-tree digest changed while its captures were produced");
    }

    // ---- Negative control: prove the visual-inert invariant can actually fail. ----
    const fabricated = captures.map((record) => record.cellId === control.cellId
      ? { ...record, nodeIds: record.nodeIds.slice(1) }
      : record);
    const negativeControlMessage = failedControlOutput(() => assertVisualInertInvariant(fabricated, canonicalNodeIds, canonicalEdgeIds));
    if (!negativeControlMessage.includes("does not match the shared base")) {
      throw new Error(`calibration-evidence negative control produced the wrong failure: ${negativeControlMessage}`);
    }

    const manifest: CalibrationManifest = {
      schemaVersion: 1,
      summary: { passing: true },
      run: { command: CALIBRATION_EVIDENCE_COMMAND, trackedTree },
      fixture: {
        id: FIXTURE_ID,
        path: FIXTURE_PATH,
        semanticDigest: fixtureSemanticDigest,
        nodeCount: canonicalNodeIds.length,
        edgeCount: canonicalEdgeIds.length,
      },
      controlledBase: {
        morphology: "stellar",
        organization: "indra",
        projection: "2d",
        cameraKind: "orthographic",
        temperature: CHROMATIC_TEMPERATURE,
        theme: CHROMATIC_THEME,
        lodBand: "micro",
        reducedMotion: true,
        devicePixelRatio: 1,
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        seed: DEFAULT_CALIBRATION.layout.seed,
      },
      cellSelection: {
        assertion: "Twelve cells, one variable at a time from a single shared base -- never a Cartesian product.",
        totalCells: 12,
        axes: {
          nodeSharpness: ["sharp", "soft"],
          palette: ["monochrome", "accent-hue", "categorical"],
          preset: [...PRESET_NAMES],
        },
      },
      visualInertInvariant: {
        assertion: "Every calibration cell renders the identical governed node id set and relation id set as the shared base; calibration is a visual layer and must not change graph meaning, topology, membership, provenance or epistemic state.",
        passed: true,
      },
      reproducibilityInvariant: {
        assertion: "Every cell whose calibration is byte-identical to the control's own (sharp core, monochrome palette, balanced preset) renders byte-identical decoded pixels; every cell that declares a different calibration renders measurably different decoded pixels.",
        passed: true,
      },
      frameContainmentInvariant: {
        assertion: "Every cell's resolved node positions fall inside the captured frame, within a fixed pixel margin.",
        marginCssPx: FRAME_CONTAINMENT_MARGIN_CSS_PX,
        passed: true,
      },
      captures,
      negativeControl: { message: negativeControlMessage, restored: true },
    };
    const manifestFile = join(ROOT_DIRECTORY, "calibration-evidence-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`calibration-evidence: ${captures.length}/${cells.length} cells captured; manifest=${manifestFile}\n`);
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Calibration construction.
// ---------------------------------------------------------------------------------------------

function withPlainGradientCore(base: CalibrationProfile): CalibrationProfile {
  return {
    ...base,
    morphology: {
      stellar: { ...base.morphology.stellar, coreSharpnessPermille: PLAIN_GRADIENT_CORE_SHARPNESS_PERMILLE },
      neural: { ...base.morphology.neural, coreSharpnessPermille: PLAIN_GRADIENT_CORE_SHARPNESS_PERMILLE },
      mycelium: { ...base.morphology.mycelium, coreSharpnessPermille: PLAIN_GRADIENT_CORE_SHARPNESS_PERMILLE },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Chromatic floor measurement -- pure `#engine/tokens.ts` arithmetic, no mounted renderer required.
// ---------------------------------------------------------------------------------------------

function measureChromaticFloor(palette: "accent-hue" | "categorical", hueAnchorDegrees: number | undefined): ChromaticFloorResult {
  try {
    const tokens = resolveTokens(palette, CHROMATIC_TEMPERATURE, CHROMATIC_THEME, hueAnchorDegrees);
    const background = requiredToken(tokens, "background");
    const contrast: ContrastMeasurement[] = [
      contrastMeasurement(tokens, "text", background, WCAG_AA_TEXT_CONTRAST),
      contrastMeasurement(tokens, "textMuted", background, WCAG_AA_TEXT_CONTRAST),
      contrastMeasurement(tokens, "edge", background, WCAG_AA_NON_TEXT_CONTRAST),
      ...TOKEN_RAMPS.accent.map((role) => contrastMeasurement(tokens, role, background, WCAG_AA_NON_TEXT_CONTRAST)),
    ];
    const failedContrast = contrast.filter((measurement) => !measurement.passed);
    if (failedContrast.length > 0) {
      throw new Error(`${palette} contrast floor unmet for: ${failedContrast.map((measurement) => measurement.role).join(", ")}`);
    }
    const pairwiseSeparation = palette === "categorical" ? pairwiseSeparationMeasurements(tokens) : null;
    if (pairwiseSeparation !== null) {
      const failedSeparation = pairwiseSeparation.filter((measurement) => !measurement.passed);
      if (failedSeparation.length > 0) {
        throw new Error(`categorical pairwise separation floor unmet for: ${failedSeparation.map((measurement) => `${measurement.leftRole}/${measurement.rightRole}`).join(", ")}`);
      }
    }
    return { disabled: false, contrast, pairwiseSeparation };
  } catch (error: unknown) {
    return { disabled: true, reason: errorMessage(error) };
  }
}

function contrastMeasurement(tokens: TokenMap, role: string, background: OklchToken, requiredMinimum: number): ContrastMeasurement {
  const token = requiredToken(tokens, role);
  const plainContrastRatio = contrastRatio(token, background);
  const protanopiaContrastRatio = simulatedContrastRatio(token, background, "protanopia");
  const deuteranopiaContrastRatio = simulatedContrastRatio(token, background, "deuteranopia");
  const worstCaseContrastRatio = Math.min(plainContrastRatio, protanopiaContrastRatio, deuteranopiaContrastRatio);
  return {
    role,
    plainContrastRatio,
    protanopiaContrastRatio,
    deuteranopiaContrastRatio,
    worstCaseContrastRatio,
    requiredMinimum,
    passed: worstCaseContrastRatio >= requiredMinimum,
  };
}

function pairwiseSeparationMeasurements(tokens: TokenMap): readonly PairwiseSeparationMeasurement[] {
  const measurements: PairwiseSeparationMeasurement[] = [];
  for (let left = 0; left < TOKEN_RAMPS.accent.length; left += 1) {
    for (let right = left + 1; right < TOKEN_RAMPS.accent.length; right += 1) {
      const leftRole = TOKEN_RAMPS.accent[left];
      const rightRole = TOKEN_RAMPS.accent[right];
      if (leftRole === undefined || rightRole === undefined) {
        throw new Error("categorical pairwise separation requires two ramp slots");
      }
      const leftToken = requiredToken(tokens, leftRole);
      const rightToken = requiredToken(tokens, rightRole);
      const plainDeltaE76 = perceptualColorDifference(leftToken, rightToken);
      const bySimulation = DICHROMACY_SIMULATIONS.map((simulation) => simulatedPerceptualColorDifference(leftToken, rightToken, simulation));
      const protanopiaDeltaE76 = bySimulation[0];
      const deuteranopiaDeltaE76 = bySimulation[1];
      if (protanopiaDeltaE76 === undefined || deuteranopiaDeltaE76 === undefined) {
        throw new Error("categorical pairwise separation requires both dichromacy simulations");
      }
      const worstCaseDeltaE76 = Math.min(plainDeltaE76, protanopiaDeltaE76, deuteranopiaDeltaE76);
      measurements.push({
        leftRole,
        rightRole,
        plainDeltaE76,
        protanopiaDeltaE76,
        deuteranopiaDeltaE76,
        worstCaseDeltaE76,
        requiredMinimum: CATEGORICAL_MINIMUM_PAIRWISE_DELTA_E,
        passed: worstCaseDeltaE76 >= CATEGORICAL_MINIMUM_PAIRWISE_DELTA_E,
      });
    }
  }
  return measurements;
}

function requiredToken(tokens: TokenMap, role: string): OklchToken {
  const token = tokens[role];
  if (token === undefined) {
    throw new Error(`calibration-evidence chromatic measurement requires token role ${role}`);
  }
  return token;
}

// ---------------------------------------------------------------------------------------------
// Rendered-evidence helpers.
// ---------------------------------------------------------------------------------------------

async function requestCapture(
  page: Page,
  cell: CellDefinition,
  canonicalNodeIds: readonly string[],
  canonicalEdgeIds: readonly string[],
  chromaticFloor: ChromaticFloorResult | null,
): Promise<CaptureRecord> {
  const request: CalibrationCaptureRequest = {
    palette: cell.palette,
    calibration: cell.calibration,
    ...(cell.hueAnchorDegrees === undefined ? {} : { hueAnchorDegrees: cell.hueAnchorDegrees }),
  };
  const witness = await invokeCapture(page, request);
  const fileName = `${cell.id}.png`;
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#calibration-evidence-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const image = decodePng(bytes, fileName);
  const dimensions = pngDimensions(bytes, fileName);
  expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  expect([...witness.surface.nodeIds].sort()).toEqual(canonicalNodeIds);
  expect([...witness.surface.edgeIds].sort()).toEqual(canonicalEdgeIds);
  assertLitPixelFloor(image, `calibration-evidence ${fileName}`);
  // The fixed rgb(9,9,9) shipping field only holds for a monochrome (chroma-free) field at the
  // default field lightness: accent-hue and categorical deliberately carry a faint hue into the same
  // near-black field (see scene/build.ts's calibratedMonochromeToken, which derives the field from a
  // chromatic neutral ramp entry under those two palettes), and every non-balanced preset here moves
  // luminance.fieldLightnessPermille on purpose. Both are real, declared differences, not defects.
  if (cell.palette === "monochrome" && cell.calibration.luminance.fieldLightnessPermille === DEFAULT_CALIBRATION.luminance.fieldLightnessPermille) {
    assertDarkestShippingField(image, `calibration-evidence ${fileName}`);
  }
  assertNodesInsideCapturedFrame(fileName, witness.nodeViewportPositions);
  return {
    cellId: cell.id,
    axis: cell.axis,
    axisValue: cell.axisValue,
    fileName,
    palette: cell.palette,
    hueAnchorDegrees: cell.hueAnchorDegrees ?? null,
    cameraKind: "orthographic",
    nodeIds: [...witness.surface.nodeIds].sort(),
    edgeIds: [...witness.surface.edgeIds].sort(),
    pixelSha256: pixelSha256(image),
    pixelDimensions: dimensions,
    resolvedCalibration: cell.calibration,
    cameraBounds: witness.visualState.camera.bounds,
    darkestPixel: darkestPixelOf(image),
    chromaticFloor,
  };
}

function darkestPixelOf(image: PixelImage): readonly [number, number, number] {
  let darkest: readonly [number, number, number] = [image.data[0] ?? 0, image.data[1] ?? 0, image.data[2] ?? 0];
  let minimumSum = darkest[0] + darkest[1] + darkest[2];
  for (let offset = 4; offset < image.data.length; offset += 4) {
    const candidate: readonly [number, number, number] = [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
    const sum = candidate[0] + candidate[1] + candidate[2];
    if (sum < minimumSum) {
      darkest = candidate;
      minimumSum = sum;
    }
  }
  return darkest;
}

function requiredCapture(records: readonly CaptureRecord[], cellId: string): CaptureRecord {
  const found = records.find((record) => record.cellId === cellId);
  if (found === undefined) {
    throw new Error(`calibration-evidence required capture ${cellId} is missing from the recorded set`);
  }
  return found;
}

function assertVisualInertInvariant(
  records: readonly CaptureRecord[],
  canonicalNodeIds: readonly string[],
  canonicalEdgeIds: readonly string[],
): void {
  for (const record of records) {
    if (JSON.stringify(record.nodeIds) !== JSON.stringify(canonicalNodeIds) || JSON.stringify(record.edgeIds) !== JSON.stringify(canonicalEdgeIds)) {
      throw new Error(`calibration-evidence visual-inert invariant failed for ${record.cellId}: rendered id set does not match the shared base`);
    }
  }
}

function assertReproducibilityInvariant(records: readonly CaptureRecord[], control: CaptureRecord): void {
  for (const record of records) {
    const declaresControlCalibration = JSON.stringify(record.resolvedCalibration) === JSON.stringify(control.resolvedCalibration) && record.palette === control.palette;
    const shouldMatch = record.cellId === control.cellId || declaresControlCalibration;
    if (shouldMatch && record.pixelSha256 !== control.pixelSha256) {
      throw new Error(`calibration-evidence reproducibility invariant failed: ${record.cellId} has the control's own calibration and palette but a different decoded-pixel digest`);
    }
    if (!shouldMatch && record.pixelSha256 === control.pixelSha256) {
      throw new Error(`calibration-evidence reproducibility invariant failed: ${record.cellId} declares a different calibration or palette from the control but rendered identical decoded pixels`);
    }
  }
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
    throw new Error(`calibration-evidence frame-containment invariant failed for ${fileName}: capture resolved no node viewport positions`);
  }
  const outside = positions.filter(([, point]) => (
    point.x < minimumX || point.x > maximumX || point.y < minimumY || point.y > maximumY
  ));
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map(([id, point]) => `${id}@(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`).join(", ");
    throw new Error(
      `calibration-evidence frame-containment invariant failed for ${fileName}: ${outside.length}/${positions.length} `
      + `resolved node positions fall outside the captured frame; e.g. ${sample}`,
    );
  }
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("calibration-evidence negative control unexpectedly passed");
}

// ---------------------------------------------------------------------------------------------
// Page bootstrap -- mirrors matrix.spec.ts's own bundling and installation shape.
// ---------------------------------------------------------------------------------------------

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "calibration-evidence.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("calibration-evidence page module output is unavailable");
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
    const api = window.__calibrationEvidence;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<CalibrationPageApi> {
  return page.evaluate(() => {
    const api = window.__calibrationEvidence;
    if (api === undefined) {
      throw new Error("calibration-evidence page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<CalibrationFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__calibrationEvidence;
    if (api === undefined) {
      throw new Error("calibration-evidence page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: CalibrationCaptureRequest): Promise<CalibrationCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__calibrationEvidence;
    if (api === undefined) {
      throw new Error("calibration-evidence page module is unavailable");
    }
    return api.capture(value);
  }, request);
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
