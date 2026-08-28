import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import {
  assertLitPixelFloor,
  MINIMUM_LIT_PIXEL_COUNT,
  SHIPPING_DARK_FIELD_RGB,
} from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";
import type {
  MatrixCaptureRequest,
  MatrixCaptureWitness,
  MatrixFixtureWitness,
  MatrixPageApi,
  MatrixProjection,
} from "#browser/matrix.ts";
import {
  TRACKED_TREE_IDENTITY_ALGORITHM,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import { assertDarkestShippingField, darkestPixel } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

type FixtureDefinition = {
  readonly id: string;
  readonly path: string;
  readonly expectedNodeCount: number;
};

type MatrixCaptureRecord = {
  readonly fixture: string;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: MatrixProjection;
  readonly fileName: string;
  readonly cameraKind: "orthographic" | "perspective";
  readonly lodBand: "micro";
  readonly camera: VisualStateCamera;
  readonly visualState: VisualState;
  readonly semanticDigest: string;
  readonly resolved: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly aggregateCount: number;
    readonly identifierDigest: string;
  };
  readonly sha256: string;
  readonly pixelDimensions: { readonly width: number; readonly height: number };
  readonly fieldRgb: readonly [number, number, number];
  readonly litPixels: number;
};

type MatrixTopologyGroup = {
  readonly organization: Organization;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly identifierDigest: string;
  readonly aggregateCount: number;
  readonly captureFiles: readonly string[];
};

type MatrixDistinctDigestGroup = {
  readonly organization: Organization;
  readonly projection: MatrixProjection;
  readonly digests: Readonly<Record<Morphology, string>>;
};

type MatrixManifest = {
  readonly schemaVersion: 1;
  readonly run: {
    readonly command: string;
    readonly trackedTree: TrackedTreeIdentity;
  };
  readonly fixture: {
    readonly id: string;
    readonly path: string;
    readonly semanticDigest: string;
    readonly declaredNodeCount: number;
    readonly resolvedNodeCount: number;
    readonly resolvedEdgeCount: number;
  };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly lodBand: "micro";
    readonly lodReason: "micro is the governed band that discloses taper and curvature";
    readonly palette: "monochrome";
    readonly temperature: "balanced";
    readonly theme: "dark";
    readonly reducedMotion: true;
    readonly elapsedMilliseconds: number;
    readonly derivedOnceCamera: VisualStateCamera;
  };
  readonly controlledComparison: {
    readonly assertion: "Within each projection, every cell has the fixture-derived camera and identical non-axis VisualState fields; only morphology and organization vary.";
    readonly passed: true;
  };
  readonly topologyInvariant: {
    readonly assertion: "Within each organization, every morphology and projection preserves node count, edge count, and the combined node-and-edge identifier digest.";
    readonly passed: true;
    readonly groups: readonly MatrixTopologyGroup[];
  };
  readonly imageDistinctness: {
    readonly assertion: "Each morphology has a distinct image SHA-256 within every organization/projection group, and all twelve fixture captures are distinct.";
    readonly passed: true;
    readonly groups: readonly MatrixDistinctDigestGroup[];
    readonly allTwelveDistinct: true;
  };
  readonly negativeControls: {
    readonly forcedIdenticalMorphologies: { readonly message: string; readonly restored: true };
    readonly perturbedCamera: { readonly message: string; readonly restored: true };
  };
  readonly captureQuality: {
    readonly requiredFieldRgb: readonly [number, number, number];
    readonly minimumLitPixels: number;
  };
  readonly captures: readonly MatrixCaptureRecord[];
  readonly contactSheets: readonly string[];
};

const MATRIX_ENABLED = process.env.MATRIX_CAPTURES === "1";
const MATRIX_PROJECT = "matrix";
const MATRIX_COMMAND = "npm --prefix ui run test:matrix";
const MATRIX_ROOT_DIRECTORY = join("dist", "matrix");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const ORGANIZATIONS = ["flat", "indra"] as const satisfies readonly Organization[];
const PROJECTIONS = ["2d", "3d"] as const satisfies readonly MatrixProjection[];
const FIXTURES = [
  {
    id: "discovery-at-question",
    path: ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/"),
    expectedNodeCount: 22,
  },
  {
    id: "indra-community-windows",
    path: ["fixtures", "synthetic", "projection", "indra", "indra-community-windows.json"].join("/"),
    expectedNodeCount: 124,
  },
] as const satisfies readonly FixtureDefinition[];

test("governed morphology × organization evidence matrix", async ({ page }, testInfo) => {
  test.skip(!MATRIX_ENABLED || testInfo.project.name !== MATRIX_PROJECT, "run this through the dedicated matrix project");
  if (!MATRIX_ENABLED || testInfo.project.name !== MATRIX_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await rm(MATRIX_ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(MATRIX_ROOT_DIRECTORY, { recursive: true });
  const pageModule = await bundleMatrixPage();
  await installMatrixPage(page, pageModule);
  try {
    for (const fixture of FIXTURES) {
      const fixtureWitness = await prepareFixture(page, fixture.path);
      expect(fixtureWitness.fixture).toBe(fixture.path);
      expect(fixtureWitness.nodeCount).toBe(fixture.expectedNodeCount);
      const captures = await captureFixtureMatrix(page, fixture, fixtureWitness);
      const topologyGroups = assertTopologyInvariant(captures);
      const distinctDigestGroups = assertMorphologyDigestDistinctness(captures);
      assertAllTwelveDigestsDistinct(captures);
      assertOrganizationAggregateCounts(captures);
      const negativeControls = negativeControlsFor(captures);
      // Re-running every positive invariant after the cloned controls proves the actual evidence was
      // restored; controls never mutate a captured record or its persisted PNG.
      assertControlledComparison(captures);
      assertTopologyInvariant(captures);
      assertMorphologyDigestDistinctness(captures);
      assertAllTwelveDigestsDistinct(captures);
      const contactSheets = await writeContactSheets(fixture, captures);
      const completedTrackedTree = await currentTrackedTreeState();
      const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
      if (!trackedTree.stable) {
        throw new Error(`matrix ${fixture.id} tracked-tree digest changed while its captures were produced`);
      }
      const manifest: MatrixManifest = {
        schemaVersion: 1,
        run: { command: MATRIX_COMMAND, trackedTree },
        fixture: {
          id: fixture.id,
          path: fixture.path,
          semanticDigest: fixtureWitness.semanticDigest,
          declaredNodeCount: fixture.expectedNodeCount,
          resolvedNodeCount: fixtureWitness.nodeCount,
          resolvedEdgeCount: fixtureWitness.edgeCount,
        },
        captureConfiguration: {
          viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
          devicePixelRatio: 1,
          lodBand: "micro",
          lodReason: "micro is the governed band that discloses taper and curvature",
          palette: "monochrome",
          temperature: "balanced",
          theme: "dark",
          reducedMotion: true,
          elapsedMilliseconds: 480,
          derivedOnceCamera: fixtureWitness.camera,
        },
        controlledComparison: {
          assertion: "Within each projection, every cell has the fixture-derived camera and identical non-axis VisualState fields; only morphology and organization vary.",
          passed: true,
        },
        topologyInvariant: {
          assertion: "Within each organization, every morphology and projection preserves node count, edge count, and the combined node-and-edge identifier digest.",
          passed: true,
          groups: topologyGroups,
        },
        imageDistinctness: {
          assertion: "Each morphology has a distinct image SHA-256 within every organization/projection group, and all twelve fixture captures are distinct.",
          passed: true,
          groups: distinctDigestGroups,
          allTwelveDistinct: true,
        },
        negativeControls,
        captureQuality: {
          requiredFieldRgb: SHIPPING_DARK_FIELD_RGB,
          minimumLitPixels: MINIMUM_LIT_PIXEL_COUNT,
        },
        captures,
        contactSheets,
      };
      const manifestFile = join(MATRIX_ROOT_DIRECTORY, `${fixture.id}-manifest.json`);
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      process.stdout.write(matrixSummary(fixture, captures, contactSheets, manifestFile));
    }
  } finally {
    await destroyMatrixPage(page);
  }
});

async function bundleMatrixPage(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "matrix.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("matrix page module output is unavailable");
  }
  return output.text;
}

async function installMatrixPage(page: Page, pageModule: string): Promise<void> {
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
  await expect.poll(async () => (await readMatrixApi(page)).ready).toBe(true);
  expect((await readMatrixApi(page)).errors).toEqual([]);
}

async function destroyMatrixPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.__matrix;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readMatrixApi(page: Page): Promise<MatrixPageApi> {
  return page.evaluate(() => {
    const api = window.__matrix;
    if (api === undefined) {
      throw new Error("matrix page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<MatrixFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__matrix;
    if (api === undefined) {
      throw new Error("matrix page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: MatrixCaptureRequest): Promise<MatrixCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__matrix;
    if (api === undefined) {
      throw new Error("matrix page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

async function captureFixtureMatrix(
  page: Page,
  fixture: FixtureDefinition,
  fixtureWitness: MatrixFixtureWitness,
): Promise<readonly MatrixCaptureRecord[]> {
  const records: MatrixCaptureRecord[] = [];
  for (const projection of PROJECTIONS) {
    for (const organization of ORGANIZATIONS) {
      for (const morphology of MORPHOLOGIES) {
        const request: MatrixCaptureRequest = { morphology, organization, projection };
        const witness = await invokeCapture(page, request);
        const fileName = `${fixture.id}-${morphology}-${organization}-${projection}.png`;
        const outputFile = join(MATRIX_ROOT_DIRECTORY, fileName);
        await page.locator("#matrix-root").screenshot({ path: outputFile });
        const bytes = await readFile(outputFile);
        const image = decodePng(bytes, fileName);
        const dimensions = pngDimensions(bytes, fileName);
        expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
        expect(witness.fixture).toBe(fixture.path);
        expect(witness.semanticDigest).toBe(fixtureWitness.semanticDigest);
        if (witness.visualState.lodBand !== "micro") {
          throw new Error(`matrix ${fileName} resolved LOD band ${witness.visualState.lodBand}, not micro`);
        }
        expect(witness.cameraKind).toBe(cameraKindFor(projection));
        assertDarkestShippingField(image, `matrix ${fileName}`);
        const litPixels = assertLitPixelFloor(image, `matrix ${fileName}`).litPixels;
        records.push({
          fixture: witness.fixture,
          morphology,
          organization,
          projection,
          fileName,
          cameraKind: witness.cameraKind,
          lodBand: "micro",
          camera: witness.visualState.camera,
          visualState: witness.visualState,
          semanticDigest: witness.semanticDigest,
          resolved: {
            nodeCount: witness.surface.nodeIds.length,
            edgeCount: witness.surface.edgeIds.length,
            aggregateCount: witness.aggregateCount,
            identifierDigest: identifierDigest(witness.surface.nodeIds, witness.surface.edgeIds),
          },
          sha256: sha256(bytes),
          pixelDimensions: dimensions,
          fieldRgb: darkestPixel(image),
          litPixels,
        });
      }
    }
  }
  if (records.length !== 12) {
    throw new Error(`matrix fixture ${fixture.id} produced ${records.length} captures rather than twelve`);
  }
  assertControlledComparison(records);
  return records;
}

function assertControlledComparison(captures: readonly MatrixCaptureRecord[]): void {
  const baseline = captures[0];
  if (baseline === undefined) {
    throw new Error("matrix controlled-comparison invariant requires at least one capture");
  }
  const expectedState = controlledState(baseline.visualState);
  const expectedCamera = JSON.stringify(baseline.camera);
  for (const capture of captures) {
    if (capture.semanticDigest !== baseline.semanticDigest) {
      throw new Error(`matrix controlled-comparison invariant failed for ${capture.fileName}: semantic graph digest differs`);
    }
    if (JSON.stringify(capture.camera) !== expectedCamera) {
      throw new Error(`matrix controlled-comparison invariant failed for ${capture.fileName}: camera differs from the fixture-derived camera`);
    }
    if (capture.cameraKind !== cameraKindFor(capture.projection)) {
      throw new Error(`matrix controlled-comparison invariant failed for ${capture.fileName}: ${capture.projection} has camera kind ${capture.cameraKind}`);
    }
    if (capture.lodBand !== "micro") {
      throw new Error(`matrix controlled-comparison invariant failed for ${capture.fileName}: LOD band is ${capture.lodBand}, not micro`);
    }
    if (JSON.stringify(controlledState(capture.visualState)) !== JSON.stringify(expectedState)) {
      throw new Error(`matrix controlled-comparison invariant failed for ${capture.fileName}: non-axis VisualState fields differ`);
    }
  }
}

function controlledState(state: VisualState): Omit<VisualState, "morphology" | "organization" | "cameraKind"> {
  return {
    selectedId: state.selectedId,
    focusedId: state.focusedId,
    camera: state.camera,
    palette: state.palette,
    temperature: state.temperature,
    theme: state.theme,
    lodBand: state.lodBand,
    reducedMotion: state.reducedMotion,
  };
}

function assertTopologyInvariant(captures: readonly MatrixCaptureRecord[]): readonly MatrixTopologyGroup[] {
  return ORGANIZATIONS.map((organization) => {
    const group = captures.filter((capture) => capture.organization === organization);
    const baseline = group[0];
    if (baseline === undefined || group.length !== MORPHOLOGIES.length * PROJECTIONS.length) {
      throw new Error(`matrix topology invariant failed for organization=${organization}: expected six captures`);
    }
    for (const capture of group) {
      const expected = baseline.resolved;
      const observed = capture.resolved;
      if (
        observed.nodeCount !== expected.nodeCount
        || observed.edgeCount !== expected.edgeCount
        || observed.identifierDigest !== expected.identifierDigest
      ) {
        throw new Error(
          `matrix topology invariant failed for organization=${organization}: ${capture.fileName} recorded `
          + `nodes=${observed.nodeCount}, edges=${observed.edgeCount}, identifiers=${observed.identifierDigest}; expected `
          + `nodes=${expected.nodeCount}, edges=${expected.edgeCount}, identifiers=${expected.identifierDigest}`,
        );
      }
      if (observed.aggregateCount !== expected.aggregateCount) {
        throw new Error(`matrix topology invariant failed for organization=${organization}: aggregate count differs at ${capture.fileName}`);
      }
    }
    return {
      organization,
      nodeCount: baseline.resolved.nodeCount,
      edgeCount: baseline.resolved.edgeCount,
      identifierDigest: baseline.resolved.identifierDigest,
      aggregateCount: baseline.resolved.aggregateCount,
      captureFiles: group.map((capture) => capture.fileName),
    };
  });
}

function assertOrganizationAggregateCounts(captures: readonly MatrixCaptureRecord[]): void {
  for (const capture of captures) {
    if (capture.organization === "flat" && capture.resolved.aggregateCount !== 0) {
      throw new Error(`matrix flat organization resolved ${capture.resolved.aggregateCount} aggregates at ${capture.fileName}`);
    }
    if (capture.organization === "indra" && capture.resolved.aggregateCount === 0) {
      throw new Error(`matrix Indra organization resolved no aggregates at ${capture.fileName}`);
    }
  }
}

function assertMorphologyDigestDistinctness(captures: readonly MatrixCaptureRecord[]): readonly MatrixDistinctDigestGroup[] {
  const groups: MatrixDistinctDigestGroup[] = [];
  for (const projection of PROJECTIONS) {
    for (const organization of ORGANIZATIONS) {
      const group = captures.filter((capture) => capture.projection === projection && capture.organization === organization);
      if (group.length !== MORPHOLOGIES.length) {
        throw new Error(`matrix distinct-digest invariant failed for organization=${organization}, projection=${projection}: expected three morphologies`);
      }
      const digests = {} as Record<Morphology, string>;
      for (const morphology of MORPHOLOGIES) {
        const capture = group.find((candidate) => candidate.morphology === morphology);
        if (capture === undefined) {
          throw new Error(`matrix distinct-digest invariant failed for organization=${organization}, projection=${projection}: missing ${morphology}`);
        }
        digests[morphology] = capture.sha256;
      }
      if (new Set(Object.values(digests)).size !== MORPHOLOGIES.length) {
        throw new Error(
          `matrix distinct-digest invariant failed for organization=${organization}, projection=${projection}: `
          + `morphology image SHA-256 values must be distinct (${MORPHOLOGIES.map((morphology) => `${morphology}=${digests[morphology]}`).join(", ")})`,
        );
      }
      groups.push({ organization, projection, digests });
    }
  }
  return groups;
}

function assertAllTwelveDigestsDistinct(captures: readonly MatrixCaptureRecord[]): void {
  if (captures.length !== 12 || new Set(captures.map((capture) => capture.sha256)).size !== 12) {
    throw new Error("matrix all-cell distinct-digest invariant failed: all twelve fixture image SHA-256 values must be distinct");
  }
}

function negativeControlsFor(captures: readonly MatrixCaptureRecord[]): MatrixManifest["negativeControls"] {
  const source = requiredCapture(captures, "stellar", "flat", "2d");
  const target = requiredCapture(captures, "mycelium", "flat", "2d");
  const forcedSameDigest = captures.map((capture) => capture.fileName === target.fileName
    ? { ...capture, sha256: source.sha256 }
    : capture);
  const forcedIdenticalMorphologies = failedControlOutput(() => assertMorphologyDigestDistinctness(forcedSameDigest));
  if (!forcedIdenticalMorphologies.includes("matrix distinct-digest invariant failed")) {
    throw new Error(`matrix identical-morphology negative control produced the wrong failure: ${forcedIdenticalMorphologies}`);
  }

  const alteredTarget = requiredCapture(captures, "stellar", "indra", "3d");
  const alteredCamera: VisualStateCamera = { ...alteredTarget.camera, ratio: alteredTarget.camera.ratio + 0.125 };
  const perturbedCamera = captures.map((capture) => capture.fileName === alteredTarget.fileName
    ? { ...capture, camera: alteredCamera, visualState: { ...capture.visualState, camera: alteredCamera } }
    : capture);
  const cameraFailure = failedControlOutput(() => assertControlledComparison(perturbedCamera));
  if (!cameraFailure.includes("matrix controlled-comparison invariant failed")) {
    throw new Error(`matrix camera negative control produced the wrong failure: ${cameraFailure}`);
  }
  process.stdout.write(`matrix negative control identical morphologies: ${forcedIdenticalMorphologies}\n`);
  process.stdout.write(`matrix negative control perturbed camera: ${cameraFailure}\n`);
  return {
    forcedIdenticalMorphologies: { message: forcedIdenticalMorphologies, restored: true },
    perturbedCamera: { message: cameraFailure, restored: true },
  };
}

function requiredCapture(
  captures: readonly MatrixCaptureRecord[],
  morphology: Morphology,
  organization: Organization,
  projection: MatrixProjection,
): MatrixCaptureRecord {
  const capture = captures.find((candidate) => candidate.morphology === morphology
    && candidate.organization === organization
    && candidate.projection === projection);
  if (capture === undefined) {
    throw new Error(`matrix capture ${morphology}/${organization}/${projection} is unavailable`);
  }
  return capture;
}

async function writeContactSheets(
  fixture: FixtureDefinition,
  captures: readonly MatrixCaptureRecord[],
): Promise<readonly string[]> {
  const files: string[] = [];
  for (const projection of PROJECTIONS) {
    const fileName = `${fixture.id}-${projection}-contact-sheet.png`;
    const cells = captures.filter((capture) => capture.projection === projection);
    const image = await matrixContactSheet(cells, `${fixture.id.toUpperCase()} - ${projection.toUpperCase()}`);
    await writeFile(join(MATRIX_ROOT_DIRECTORY, fileName), encodePng(image.width, image.height, image.data));
    files.push(fileName);
  }
  return files;
}

async function matrixContactSheet(
  captures: readonly MatrixCaptureRecord[],
  title: string,
): Promise<{ readonly width: number; readonly height: number; readonly data: Buffer }> {
  const first = captures[0];
  if (first === undefined || captures.length !== MORPHOLOGIES.length * ORGANIZATIONS.length) {
    throw new Error("matrix contact sheet requires its six captured cells");
  }
  const decoded = new Map<string, PixelImage>();
  for (const capture of captures) {
    decoded.set(capture.fileName, decodePng(await readFile(join(MATRIX_ROOT_DIRECTORY, capture.fileName)), capture.fileName));
  }
  const tile = requiredImage(decoded, first.fileName);
  const margin = 16;
  // The header band must clear BOTH the title and the column labels. At 34 the first tile row began
  // at y=50 while the column labels were drawn at y=42 in scale-3 text, so FLAT and INDRA were
  // sliced by the images beneath them in every sheet produced.
  const headerHeight = 88;
  const labelHeight = 28;
  const width = (margin * 3) + (tile.width * ORGANIZATIONS.length);
  const height = (margin * 4) + headerHeight + ((tile.height + labelHeight) * MORPHOLOGIES.length);
  const data = Buffer.alloc(width * height * 4);
  fill(data, [9, 9, 9, 255]);
  drawCenteredText(data, width, 12, title, 3, [210, 228, 255, 255]);
  for (const [column, organization] of ORGANIZATIONS.entries()) {
    const x = margin + (column * (tile.width + margin));
    drawCenteredTextWithin(data, width, x, tile.width, 56, organization.toUpperCase(), 3, [150, 184, 232, 255]);
  }
  for (const [row, morphology] of MORPHOLOGIES.entries()) {
    for (const [column, organization] of ORGANIZATIONS.entries()) {
      const capture = requiredCapture(captures, morphology, organization, projectionFromTitle(title));
      const source = requiredImage(decoded, capture.fileName);
      if (source.width !== tile.width || source.height !== tile.height) {
        throw new Error(`matrix contact sheet image dimensions differ at ${capture.fileName}`);
      }
      const x = margin + (column * (tile.width + margin));
      const y = margin + headerHeight + (row * (tile.height + labelHeight));
      blit(source, data, width, x, y);
      drawCenteredTextWithin(data, width, x, tile.width, y + tile.height + 4, `${morphology.toUpperCase()} / ${organization.toUpperCase()}`, 2, [222, 232, 246, 255]);
    }
  }
  return { width, height, data };
}

function projectionFromTitle(title: string): MatrixProjection {
  return title.endsWith("2D") ? "2d" : "3d";
}

function requiredImage(images: ReadonlyMap<string, PixelImage>, fileName: string): PixelImage {
  const image = images.get(fileName);
  if (image === undefined) {
    throw new Error(`matrix contact sheet has no decoded image for ${fileName}`);
  }
  return image;
}

function fill(data: Buffer, colour: readonly [number, number, number, number]): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = colour[0];
    data[offset + 1] = colour[1];
    data[offset + 2] = colour[2];
    data[offset + 3] = colour[3];
  }
}

function blit(source: PixelImage, target: Buffer, targetWidth: number, targetX: number, targetY: number): void {
  for (let row = 0; row < source.height; row += 1) {
    const sourceStart = row * source.width * 4;
    const targetStart = ((targetY + row) * targetWidth + targetX) * 4;
    Buffer.from(source.data).copy(target, targetStart, sourceStart, sourceStart + (source.width * 4));
  }
}

function drawCenteredText(data: Buffer, width: number, y: number, text: string, scale: number, colour: readonly [number, number, number, number]): void {
  drawCenteredTextWithin(data, width, 0, width, y, text, scale, colour);
}

function drawCenteredTextWithin(
  data: Buffer,
  imageWidth: number,
  areaX: number,
  areaWidth: number,
  y: number,
  text: string,
  scale: number,
  colour: readonly [number, number, number, number],
): void {
  const x = areaX + Math.floor((areaWidth - textWidth(text, scale)) / 2);
  drawText(data, imageWidth, x, y, text, scale, colour);
}

function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : ((text.length * 6) - 1) * scale;
}

function drawText(
  data: Buffer,
  imageWidth: number,
  x: number,
  y: number,
  text: string,
  scale: number,
  colour: readonly [number, number, number, number],
): void {
  let cursor = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (glyph !== undefined) {
      for (let row = 0; row < glyph.length; row += 1) {
        const line = glyph[row] ?? "";
        for (let column = 0; column < line.length; column += 1) {
          if (line[column] === "1") {
            fillRect(data, imageWidth, cursor + (column * scale), y + (row * scale), scale, scale, colour);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

function fillRect(
  data: Buffer,
  imageWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: readonly [number, number, number, number],
): void {
  const imageHeight = data.length / (imageWidth * 4);
  for (let row = Math.max(0, y); row < Math.min(imageHeight, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(imageWidth, x + width); column += 1) {
      const offset = ((row * imageWidth) + column) * 4;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = colour[3];
    }
  }
}

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function pngDimensions(bytes: Buffer, name: string): { readonly width: number; readonly height: number } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`matrix ${name} is not a PNG with dimensions`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodePng(source: Uint8Array, name: string): PixelImage {
  const input = Buffer.from(source);
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`matrix ${name} is not a PNG`);
  }
  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    if (offset + 12 > input.length) {
      throw new Error(`matrix ${name} ends within a PNG chunk`);
    }
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > input.length) {
      throw new Error(`matrix ${name} has an invalid PNG chunk length`);
    }
    if (type === "IHDR") {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      const bitDepth = input[offset + 16];
      const colourType = input[offset + 17];
      const compression = input[offset + 18];
      const filtering = input[offset + 19];
      const interlace = input[offset + 20];
      if (bitDepth !== 8 || compression !== 0 || filtering !== 0 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`matrix ${name} has an unsupported PNG format`);
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      chunks.push(input.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      if (end !== input.length) {
        throw new Error(`matrix ${name} has trailing PNG bytes`);
      }
      break;
    }
    offset = end;
  }
  if (width === undefined || height === undefined || channels === undefined) {
    throw new Error(`matrix ${name} lacks PNG dimensions`);
  }
  const scanlines = inflateSync(Buffer.concat(chunks));
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error(`matrix ${name} has invalid PNG scanline bytes`);
  }
  const data = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    const filter = scanlines[start];
    const current = Buffer.alloc(rowBytes);
    for (let column = 0; column < rowBytes; column += 1) {
      const sample = scanlines[start + 1 + column] ?? 0;
      const left = column >= channels ? (current[column - channels] ?? 0) : 0;
      const above = previous[column] ?? 0;
      const upperLeft = column >= channels ? (previous[column - channels] ?? 0) : 0;
      current[column] = unfilter(sample, filter, left, above, upperLeft);
    }
    for (let column = 0; column < width; column += 1) {
      const sourceIndex = column * channels;
      const targetIndex = ((row * width) + column) * 4;
      data[targetIndex] = current[sourceIndex] ?? 0;
      data[targetIndex + 1] = current[sourceIndex + 1] ?? 0;
      data[targetIndex + 2] = current[sourceIndex + 2] ?? 0;
      data[targetIndex + 3] = channels === 4 ? (current[sourceIndex + 3] ?? 255) : 255;
    }
    current.copy(previous);
  }
  return { width, height, data };
}

function unfilter(value: number, filter: number | undefined, left: number, above: number, upperLeft: number): number {
  if (filter === 0) {
    return value;
  }
  if (filter === 1) {
    return (value + left) & 0xff;
  }
  if (filter === 2) {
    return (value + above) & 0xff;
  }
  if (filter === 3) {
    return (value + Math.floor((left + above) / 2)) & 0xff;
  }
  if (filter === 4) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return (value + (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft)) & 0xff;
  }
  throw new Error(`matrix PNG has unsupported filter ${filter}`);
}

function encodePng(width: number, height: number, data: Buffer): Buffer {
  if (data.length !== width * height * 4) {
    throw new Error("matrix contact sheet has an unexpected pixel length");
  }
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetStart = row * (width * 4 + 1);
    scanlines[targetStart] = 0;
    data.copy(scanlines, targetStart + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function identifierDigest(nodeIds: readonly string[], edgeIds: readonly string[]): string {
  return sha256Text(JSON.stringify({ nodes: [...nodeIds].sort(), edges: [...edgeIds].sort() }));
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value: string): string {
  return sha256(Buffer.from(value, "utf8"));
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("matrix negative control unexpectedly passed");
}

function cameraKindFor(projection: MatrixProjection): "orthographic" | "perspective" {
  return projection === "2d" ? "orthographic" : "perspective";
}

function matrixSummary(
  fixture: FixtureDefinition,
  captures: readonly MatrixCaptureRecord[],
  contactSheets: readonly string[],
  manifestFile: string,
): string {
  const resolved = ORGANIZATIONS.map((organization) => {
    const capture = captures.find((candidate) => candidate.organization === organization);
    if (capture === undefined) {
      throw new Error(`matrix summary lacks ${organization}`);
    }
    return `${organization}: nodes=${capture.resolved.nodeCount}, edges=${capture.resolved.edgeCount}, aggregates=${capture.resolved.aggregateCount}`;
  });
  return `matrix ${fixture.id}: ${captures.length} captures; ${resolved.join("; ")}; all twelve image digests distinct; manifest=${manifestFile}; contact sheets=${contactSheets.map((file) => join(MATRIX_ROOT_DIRECTORY, file)).join(", ")}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
