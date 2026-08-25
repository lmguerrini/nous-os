import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { CALIBRATION_PARAMETER_PATHS, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { LodBand } from "#engine/lod.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import type { Palette, Temperature, Theme } from "#engine/tokens.ts";

type Policy = "Discovery" | "Reliability";
type CaptureFocus = "base" | "hub-one" | "hub-two";
type ReviewProject = "review-dpr-1" | "review-dpr-2";

type CameraState = {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly ratio: number;
  readonly bounds: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  };
};

type CaptureSettings = {
  readonly policy: Policy;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly lodBand: LodBand;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly reducedMotion: boolean;
  readonly elapsedMilliseconds: number;
};

type FocusWitness = {
  readonly id: string;
  readonly degree: number;
  readonly viewportCenter: {
    readonly x: number;
    readonly y: number;
  };
};

type PageCaptureWitness = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly cameraState: CameraState;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly aggregateWindowCount: number;
  readonly focus: FocusWitness | null;
};

type ReviewApi = {
  initialize(payloads: Readonly<Record<Policy, unknown>>): Promise<void>;
  render(settings: CaptureSettings, focus: CaptureFocus): Promise<PageCaptureWitness>;
  destroy(): void;
};

type Fixture = {
  readonly identity: string;
  readonly payload: unknown;
  readonly sha256: string;
};

type RuntimeVersions = {
  readonly browser: string;
  readonly renderer: string;
  readonly userAgent: string;
};

type PixelMeasurement = {
  readonly rgb: readonly [number, number, number];
  readonly hex: string;
  readonly relativeLuminance: number;
};

type ImageMeasurements = {
  readonly litPixels: {
    readonly count: number;
    readonly fraction: number;
    readonly fieldRgb: readonly [number, number, number];
    readonly channelMargin: number;
  };
  readonly distinctColourCount: number;
  readonly darkestNonBackgroundPixel: PixelMeasurement;
  readonly brightestNonBackgroundPixel: PixelMeasurement;
};

type CaptureRelationships = {
  lodContinuity?: {
    readonly group: string;
    readonly macroToMesoDifferingPixelCount: number;
    readonly macroToMicroDifferingPixelCount: number;
    readonly mesoToMicroDifferingPixelCount: number;
  };
  policyTransition?: {
    readonly pairedFileName: string;
    readonly sharedNodeCount: number;
    readonly maximumSharedNodeViewportDisplacementCssPixels: number;
  };
  reducedMotion?: {
    readonly pairedFileName: string;
    readonly differingPixelCount: number;
  };
};

type CaptureRecord = {
  readonly fileName: string;
  readonly sha256: string;
  readonly pixelDimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly devicePixelRatio: number;
  readonly fixture: {
    readonly identity: string;
    readonly sha256: string;
  };
  readonly policy: Policy;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly lodBand: LodBand;
  readonly theme: Theme;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly reducedMotion: boolean;
  readonly elapsedMilliseconds: number;
  readonly cameraState: CameraState;
  readonly viewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly aggregateWindowCount: number;
  readonly focus: FocusWitness | null;
  readonly calibration: {
    readonly parameterCount: number;
    readonly serializedDefaultCalibrationSha256: string;
  };
  readonly productCommitSha: string;
  readonly runtimeVersions: RuntimeVersions;
  readonly measurements: ImageMeasurements;
  readonly relationships: CaptureRelationships;
};

type ContactSheet = {
  readonly fileName: string;
  readonly rows: readonly Morphology[];
  readonly columns: readonly LodBand[];
  readonly cells: readonly {
    readonly row: number;
    readonly column: number;
    readonly fileName: string;
  }[];
};

type ReviewMetadata = {
  readonly schemaVersion: 1;
  readonly captureConfiguration: {
    readonly viewport: {
      readonly width: number;
      readonly height: number;
    };
    readonly litPixelChannelMargin: number;
    readonly elapsedMilliseconds: number;
    readonly dprProjects: readonly ReviewProject[];
  };
  readonly records: CaptureRecord[];
  readonly comparisons: {
    lodContinuity: {
      readonly group: string;
      readonly files: readonly [string, string, string];
      readonly macroToMesoDifferingPixelCount: number;
      readonly macroToMicroDifferingPixelCount: number;
      readonly mesoToMicroDifferingPixelCount: number;
    } | null;
    policyTransition: {
      readonly files: readonly [string, string];
      readonly sharedNodeCount: number;
      readonly maximumSharedNodeViewportDisplacementCssPixels: number;
    } | null;
    reducedMotion: {
      readonly capturePairEmitted: boolean;
      readonly files: readonly [string, string] | null;
      readonly differingPixelCount: number;
    } | null;
  };
  readonly contactSheet: ContactSheet | null;
};

type DecodedPng = {
  readonly bytes: number;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
};

declare global {
  interface Window {
    __review?: ReviewApi;
  }
}

const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const FIXED_ELAPSED_MILLISECONDS = 480;
const REVIEW_DIRECTORY = "dist/review";
const CAPTURE_DIRECTORY = join(REVIEW_DIRECTORY, "captures");
const CONTACT_SHEET_DIRECTORY = join(REVIEW_DIRECTORY, "contact-sheet");
const CONTACT_SHEET_FILE = join(CONTACT_SHEET_DIRECTORY, "overview.png");
const METADATA_FILE = join(REVIEW_DIRECTORY, "evidence", "capture-metadata.json");
const MANIFEST_FILE = join(REVIEW_DIRECTORY, "MANIFEST.json");
const LIT_PIXEL_CHANNEL_MARGIN = 12;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const LOD_BANDS = ["macro", "meso", "micro"] as const satisfies readonly LodBand[];
const REVIEW_PROJECTS = ["review-dpr-1", "review-dpr-2"] as const satisfies readonly ReviewProject[];
const FIXTURE_PATHS: Readonly<Record<Policy, readonly string[]>> = {
  Discovery: ["..", "fixtures", "synthetic", "projection", "discovery-all-time.json"],
  Reliability: ["..", "fixtures", "synthetic", "projection", "reliability-all-time.json"],
};

const BROWSER_PAGE_MODULE = `
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { layoutAnchors, sharedAnchors } from "#engine/layout.ts";
import { mount } from "#render2d/index.ts";

const WIDTH = 1200;
const HEIGHT = 800;

let container;
let shell;
let framing;
let graphs;
let product;

function frameFor(values) {
  const anchors = values.flatMap((graph) => [...layoutAnchors(graph).values()]);
  if (anchors.length === 0) {
    throw new Error("review capture requires anchors");
  }
  const minimumX = Math.min(...anchors.map((anchor) => anchor.x));
  const maximumX = Math.max(...anchors.map((anchor) => anchor.x));
  const minimumY = Math.min(...anchors.map((anchor) => anchor.y));
  const maximumY = Math.max(...anchors.map((anchor) => anchor.y));
  const marginX = ((maximumX - minimumX) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1000;
  const marginY = ((maximumY - minimumY) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1000;
  return {
    x: [minimumX - marginX, maximumX + marginX],
    y: [minimumY - marginY, maximumY + marginY],
  };
}

function baseCamera() {
  if (framing === undefined) {
    throw new Error("review framing is unavailable");
  }
  return { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds: framing };
}

function requiredGraph(policy) {
  const graph = graphs?.get(policy);
  if (graph === undefined) {
    throw new Error("review graph is unavailable");
  }
  return graph;
}

function requiredProduct() {
  if (product === undefined) {
    throw new Error("review renderer has not mounted");
  }
  return product;
}

function nextPaint() {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function cloneCamera(state) {
  return {
    x: state.x,
    y: state.y,
    angle: state.angle,
    ratio: state.ratio,
    bounds: {
      x: [state.bounds.x[0], state.bounds.x[1]],
      y: [state.bounds.y[0], state.bounds.y[1]],
    },
  };
}

function rankedHubs(handle) {
  return handle.model.graph.nodes().map((id) => ({
    id,
    degree: handle.model.graph.inDegree(id) + handle.model.graph.outDegree(id),
  })).filter((candidate) => candidate.degree >= 3).sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id));
}

function focusTarget(handle, focus) {
  const rank = focus === "hub-one" ? 0 : 1;
  const candidate = rankedHubs(handle)[rank];
  if (candidate === undefined) {
    throw new Error("review close-up requires two real hub junctions");
  }
  const anchor = handle.model.anchors.get(candidate.id);
  if (anchor === undefined) {
    throw new Error("review close-up hub lacks an anchor");
  }
  return { candidate, anchor };
}

function focusCamera(handle, focus) {
  const target = focusTarget(handle, focus);
  const start = { ...baseCamera(), ratio: 0.28 };
  handle.restoreCameraState(start);
  const initial = handle.graphToViewport(target.anchor);
  const probe = { ...start, x: start.x + 0.01 };
  handle.restoreCameraState(probe);
  const probedX = handle.graphToViewport(target.anchor);
  const verticalProbe = { ...start, y: start.y + 0.01 };
  handle.restoreCameraState(verticalProbe);
  const probedY = handle.graphToViewport(target.anchor);
  const xShift = probedX.x - initial.x;
  const yShift = probedY.y - initial.y;
  if (xShift === 0 || yShift === 0) {
    throw new Error("review close-up camera cannot be centered");
  }
  const camera = {
    ...start,
    x: start.x + ((WIDTH / 2 - initial.x) * 0.01 / xShift),
    y: start.y + ((HEIGHT / 2 - initial.y) * 0.01 / yShift),
  };
  handle.restoreCameraState(camera);
  const centered = handle.graphToViewport(target.anchor);
  if (Math.abs(centered.x - WIDTH / 2) > 0.5 || Math.abs(centered.y - HEIGHT / 2) > 0.5) {
    throw new Error("review close-up camera did not center the real hub");
  }
  return {
    camera: cloneCamera(handle.readCameraState()),
    focus: {
      id: target.candidate.id,
      degree: target.candidate.degree,
      viewportCenter: centered,
    },
  };
}

function positionsFor(handle) {
  const positions = {};
  for (const [id, anchor] of handle.model.anchors) {
    positions[id] = handle.graphToViewport(anchor);
  }
  return positions;
}

window.__review = {
  async initialize(payloads) {
    graphs = new Map(Object.entries(payloads).map(([policy, payload]) => [policy, toVisualGraph(payload)]));
    // Reliability keeps Discovery's anchors only if this call is made first. It is
    // not a property of the graphs: without it, layoutAnchors computes a fresh grid
    // for the smaller graph and every shared node moves hundreds of pixels. The
    // first version of this generator omitted it and faithfully reported a 539 px
    // displacement for a transition the acceptance oracle measures at under half a
    // pixel -- both numbers correct, one call apart. See CO-17.
    sharedAnchors(requiredGraph("Discovery"), requiredGraph("Reliability"));
    framing = frameFor([...graphs.values()]);
    shell = document.createElement("main");
    shell.id = "review-shell";
    shell.style.cssText = "width:1200px;height:800px;position:relative;overflow:hidden";
    container = document.createElement("div");
    container.id = "review-renderer";
    container.style.cssText = "width:100%;height:100%;position:relative";
    shell.append(container);
    document.body.replaceChildren(shell);
    document.body.style.margin = "0";
    await nextPaint();
  },
  async render(settings, focus) {
    if (container === undefined || framing === undefined || shell === undefined) {
      throw new Error("review capture was not initialized");
    }
    product?.destroy();
    product = mount(container, requiredGraph(settings.policy), {
      morphology: settings.morphology,
      organization: settings.organization,
      palette: settings.palette,
      temperature: settings.temperature,
      theme: settings.theme,
      lodBand: settings.lodBand,
      reducedMotion: settings.reducedMotion,
      elapsedMilliseconds: settings.elapsedMilliseconds,
    }, framing);
    const live = requiredProduct();
    shell.style.background = live.model.fieldColor;
    let focusWitness = null;
    if (focus === "base") {
      live.restoreCameraState(baseCamera());
    } else {
      const result = focusCamera(live, focus);
      focusWitness = result.focus;
    }
    await nextPaint();
    await nextPaint();
    const box = container.getBoundingClientRect();
    return {
      cssWidth: box.width,
      cssHeight: box.height,
      devicePixelRatio: window.devicePixelRatio,
      cameraState: cloneCamera(live.readCameraState()),
      positions: positionsFor(live),
      aggregateWindowCount: live.model.windows.length,
      focus: focusWitness,
    };
  },
  destroy() {
    product?.destroy();
    product = undefined;
  },
};
`;

test("deterministic review capture generator", async ({ page, browser }, testInfo) => {
  const project = requiredReviewProject(testInfo.project.name);
  const devicePixelRatio = project === "review-dpr-1" ? 1 : 2;
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(devicePixelRatio);
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });

  const fixtures = await loadFixtures();
  for (const fixture of fixtures.values()) {
    const graph = toVisualGraph(fixture.payload);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
  }
  const calibration = {
    parameterCount: CALIBRATION_PARAMETER_PATHS.length,
    serializedDefaultCalibrationSha256: sha256Text(JSON.stringify(DEFAULT_CALIBRATION)),
  };
  const provenance = {
    productCommitSha: await currentCommitSha(),
    runtimeVersions: await runtimeVersions(browser, page),
  };

  if (project === "review-dpr-1") {
    await rm(REVIEW_DIRECTORY, { recursive: true, force: true });
    await mkdir(CAPTURE_DIRECTORY, { recursive: true });
    await mkdir(CONTACT_SHEET_DIRECTORY, { recursive: true });
    await mkdir(join(REVIEW_DIRECTORY, "evidence"), { recursive: true });
  }
  const metadata = project === "review-dpr-1"
    ? emptyMetadata()
    : await loadMetadata();

  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    stdin: {
      contents: BROWSER_PAGE_MODULE,
      loader: "ts",
      resolveDir: process.cwd(),
      sourcefile: "review-page-module.ts",
    },
  });
  const output = requiredItem(bundled.outputFiles, 0, "review page module output");
  await page.addScriptTag({ content: output.text });
  await page.evaluate(async (payloads) => {
    const api = window.__review;
    if (api === undefined) {
      throw new Error("review page module is unavailable");
    }
    await api.initialize(payloads);
  }, Object.fromEntries([...fixtures.entries()].map(([policy, fixture]) => [policy, fixture.payload])) as Record<Policy, unknown>);

  try {
    if (project === "review-dpr-1") {
      await captureDprOneSet(page, metadata, fixtures, calibration, provenance, devicePixelRatio);
      await composeOverview(metadata.records);
    } else {
      await captureDprTwoSet(page, metadata, fixtures, calibration, provenance, devicePixelRatio);
    }
  } finally {
    await page.evaluate(() => {
      window.__review?.destroy();
    });
  }

  metadata.records.sort((left, right) => left.fileName.localeCompare(right.fileName));
  await writeFile(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeManifest(metadata.records.length);
});

async function captureDprOneSet(
  page: Page,
  metadata: ReviewMetadata,
  fixtures: ReadonlyMap<Policy, Fixture>,
  calibration: CaptureRecord["calibration"],
  provenance: Pick<CaptureRecord, "productCommitSha" | "runtimeVersions">,
  devicePixelRatio: number,
): Promise<void> {
  const grid = new Map<string, CaptureRecord>();
  for (const morphology of MORPHOLOGIES) {
    for (const lodBand of LOD_BANDS) {
      const record = await captureRecord(page, {
        fileName: `captures/grid-${morphology}-${lodBand}-dpr-1.png`,
        settings: reviewSettings({ morphology, lodBand }),
        focus: "base",
      }, fixtures, calibration, provenance, devicePixelRatio);
      metadata.records.push(record);
      grid.set(`${morphology}/${lodBand}`, record);
    }
  }
  await attachLodContinuity(metadata, grid);

  const organizationSettings = reviewSettings({ morphology: "neural", lodBand: "micro" });
  const indra = await captureRecord(page, {
    fileName: "captures/organization-indra-dpr-1.png",
    settings: organizationSettings,
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  const flat = await captureRecord(page, {
    fileName: "captures/organization-flat-dpr-1.png",
    settings: { ...organizationSettings, organization: "flat" },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  expect(indra.aggregateWindowCount).toBeGreaterThan(0);
  expect(flat.aggregateWindowCount).toBe(0);
  metadata.records.push(indra, flat);

  const transitionSettings = reviewSettings({ morphology: "mycelium", lodBand: "micro" });
  const discovery = await captureRecord(page, {
    fileName: "captures/policy-discovery-dpr-1.png",
    settings: transitionSettings,
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  const reliability = await captureRecord(page, {
    fileName: "captures/policy-reliability-dpr-1.png",
    settings: { ...transitionSettings, policy: "Reliability" },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  attachPolicyTransition(metadata, discovery, reliability);
  metadata.records.push(discovery, reliability);

  const paletteSettings = reviewSettings({ morphology: "neural", lodBand: "micro" });
  metadata.records.push(await captureRecord(page, {
    fileName: "captures/palette-monochrome-dpr-1.png",
    settings: { ...paletteSettings, palette: "monochrome" },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio));
  metadata.records.push(await captureRecord(page, {
    fileName: "captures/palette-solar-dpr-1.png",
    settings: { ...paletteSettings, palette: "solar" },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio));

  await captureReducedMotion(page, metadata, fixtures, calibration, provenance, devicePixelRatio);
}

async function captureDprTwoSet(
  page: Page,
  metadata: ReviewMetadata,
  fixtures: ReadonlyMap<Policy, Fixture>,
  calibration: CaptureRecord["calibration"],
  provenance: Pick<CaptureRecord, "productCommitSha" | "runtimeVersions">,
  devicePixelRatio: number,
): Promise<void> {
  for (const morphology of MORPHOLOGIES) {
    for (const lodBand of LOD_BANDS) {
      metadata.records.push(await captureRecord(page, {
        fileName: `captures/grid-${morphology}-${lodBand}-dpr-2.png`,
        settings: reviewSettings({ morphology, lodBand }),
        focus: "base",
      }, fixtures, calibration, provenance, devicePixelRatio));
    }
  }
  const closeupSettings = reviewSettings({ morphology: "mycelium", lodBand: "micro" });
  metadata.records.push(await captureRecord(page, {
    fileName: "captures/closeup-hub-one-dpr-2.png",
    settings: closeupSettings,
    focus: "hub-one",
  }, fixtures, calibration, provenance, devicePixelRatio));
  metadata.records.push(await captureRecord(page, {
    fileName: "captures/closeup-hub-two-dpr-2.png",
    settings: closeupSettings,
    focus: "hub-two",
  }, fixtures, calibration, provenance, devicePixelRatio));
}

async function captureReducedMotion(
  page: Page,
  metadata: ReviewMetadata,
  fixtures: ReadonlyMap<Policy, Fixture>,
  calibration: CaptureRecord["calibration"],
  provenance: Pick<CaptureRecord, "productCommitSha" | "runtimeVersions">,
  devicePixelRatio: number,
): Promise<void> {
  const settings = reviewSettings({ morphology: "stellar", lodBand: "micro" });
  const moving = await captureRecord(page, {
    fileName: "captures/reduced-motion-off-dpr-1.png",
    settings: { ...settings, reducedMotion: false },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  const stopped = await captureRecord(page, {
    fileName: "captures/reduced-motion-on-dpr-1.png",
    settings: { ...settings, reducedMotion: true },
    focus: "base",
  }, fixtures, calibration, provenance, devicePixelRatio);
  const delta = differingPixels(await decodePng(join(REVIEW_DIRECTORY, moving.fileName)), await decodePng(join(REVIEW_DIRECTORY, stopped.fileName)));
  if (delta === 0) {
    await rm(join(REVIEW_DIRECTORY, moving.fileName), { force: true });
    await rm(join(REVIEW_DIRECTORY, stopped.fileName), { force: true });
    metadata.comparisons.reducedMotion = {
      capturePairEmitted: false,
      files: null,
      differingPixelCount: delta,
    };
    return;
  }
  moving.relationships.reducedMotion = { pairedFileName: stopped.fileName, differingPixelCount: delta };
  stopped.relationships.reducedMotion = { pairedFileName: moving.fileName, differingPixelCount: delta };
  metadata.records.push(moving, stopped);
  metadata.comparisons.reducedMotion = {
    capturePairEmitted: true,
    files: [moving.fileName, stopped.fileName],
    differingPixelCount: delta,
  };
}

async function captureRecord(
  page: Page,
  request: {
    readonly fileName: string;
    readonly settings: CaptureSettings;
    readonly focus: CaptureFocus;
  },
  fixtures: ReadonlyMap<Policy, Fixture>,
  calibration: CaptureRecord["calibration"],
  provenance: Pick<CaptureRecord, "productCommitSha" | "runtimeVersions">,
  devicePixelRatio: number,
): Promise<CaptureRecord> {
  const witness = await page.evaluate(async ({ settings, focus }) => {
    const api = window.__review;
    if (api === undefined) {
      throw new Error("review page module is unavailable");
    }
    return await api.render(settings, focus);
  }, request);
  expect(witness.cssWidth).toBe(CAPTURE_WIDTH);
  expect(witness.cssHeight).toBe(CAPTURE_HEIGHT);
  expect(witness.devicePixelRatio).toBe(devicePixelRatio);
  const file = join(REVIEW_DIRECTORY, request.fileName);
  await page.locator("#review-shell").screenshot({ path: file });
  const image = await decodePng(file);
  expect(image.width).toBe(CAPTURE_WIDTH * devicePixelRatio);
  expect(image.height).toBe(CAPTURE_HEIGHT * devicePixelRatio);
  const fixture = requiredFixture(fixtures, request.settings.policy);
  return {
    fileName: request.fileName,
    sha256: image.hash,
    pixelDimensions: { width: image.width, height: image.height },
    viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
    devicePixelRatio,
    fixture: { identity: fixture.identity, sha256: fixture.sha256 },
    policy: request.settings.policy,
    morphology: request.settings.morphology,
    organization: request.settings.organization,
    lodBand: request.settings.lodBand,
    theme: request.settings.theme,
    palette: request.settings.palette,
    temperature: request.settings.temperature,
    reducedMotion: request.settings.reducedMotion,
    elapsedMilliseconds: request.settings.elapsedMilliseconds,
    cameraState: witness.cameraState,
    viewportPositions: witness.positions,
    aggregateWindowCount: witness.aggregateWindowCount,
    focus: witness.focus,
    calibration,
    productCommitSha: provenance.productCommitSha,
    runtimeVersions: provenance.runtimeVersions,
    measurements: measureImage(image),
    relationships: {},
  };
}

function reviewSettings(overrides: Partial<CaptureSettings>): CaptureSettings {
  return {
    policy: "Discovery",
    morphology: "stellar",
    organization: "indra",
    lodBand: "micro",
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    reducedMotion: true,
    elapsedMilliseconds: FIXED_ELAPSED_MILLISECONDS,
    ...overrides,
  };
}

async function attachLodContinuity(metadata: ReviewMetadata, grid: ReadonlyMap<string, CaptureRecord>): Promise<void> {
  const files = LOD_BANDS.map((band) => requiredItem(grid, `stellar/${band}`, "stellar LOD capture"));
  const macro = requiredItem(files, 0, "macro capture");
  const meso = requiredItem(files, 1, "meso capture");
  const micro = requiredItem(files, 2, "micro capture");
  const values = {
    group: "stellar-dpr-1",
    macroToMesoDifferingPixelCount: await differingPixelsFromRecords(macro, meso),
    macroToMicroDifferingPixelCount: await differingPixelsFromRecords(macro, micro),
    mesoToMicroDifferingPixelCount: await differingPixelsFromRecords(meso, micro),
  };
  for (const record of files) {
    record.relationships.lodContinuity = values;
  }
  metadata.comparisons.lodContinuity = {
    files: [macro.fileName, meso.fileName, micro.fileName],
    ...values,
  };
}

function attachPolicyTransition(metadata: ReviewMetadata, discovery: CaptureRecord, reliability: CaptureRecord): void {
  const positions = sharedNodeDisplacement(discovery, reliability);
  const values = {
    sharedNodeCount: positions.sharedNodeCount,
    maximumSharedNodeViewportDisplacementCssPixels: positions.maximum,
  };
  discovery.relationships.policyTransition = { pairedFileName: reliability.fileName, ...values };
  reliability.relationships.policyTransition = { pairedFileName: discovery.fileName, ...values };
  metadata.comparisons.policyTransition = {
    files: [discovery.fileName, reliability.fileName],
    ...values,
  };
}

function sharedNodeDisplacement(left: CaptureRecord, right: CaptureRecord): {
  readonly sharedNodeCount: number;
  readonly maximum: number;
} {
  const leftPositions = requirePositions(left);
  const rightPositions = requirePositions(right);
  const shared = Object.keys(leftPositions).filter((id) => rightPositions[id] !== undefined);
  if (shared.length === 0) {
    throw new Error("review policy comparison has no shared nodes");
  }
  const maximum = Math.max(...shared.map((id) => {
    const before = requiredItem(leftPositions, id, "policy source position");
    const after = requiredItem(rightPositions, id, "policy target position");
    return Math.hypot(before.x - after.x, before.y - after.y);
  }));
  return { sharedNodeCount: shared.length, maximum };
}

function requirePositions(record: CaptureRecord): Readonly<Record<string, { readonly x: number; readonly y: number }>> {
  return record.viewportPositions;
}

async function differingPixelsFromRecords(left: CaptureRecord, right: CaptureRecord): Promise<number> {
  return differingPixels(
    await decodePng(join(REVIEW_DIRECTORY, left.fileName)),
    await decodePng(join(REVIEW_DIRECTORY, right.fileName)),
  );
}

async function composeOverview(records: readonly CaptureRecord[]): Promise<void> {
  const cells = MORPHOLOGIES.flatMap((morphology, row) => LOD_BANDS.map((lodBand, column) => {
    const record = records.find((candidate) => candidate.fileName === `captures/grid-${morphology}-${lodBand}-dpr-1.png`);
    if (record === undefined) {
      throw new Error(`review contact sheet lacks ${morphology} ${lodBand}`);
    }
    return { row, column, fileName: record.fileName };
  }));
  const images = await Promise.all(cells.map(async (cell) => ({ ...cell, image: await decodePng(join(REVIEW_DIRECTORY, cell.fileName)) })));
  const first = requiredItem(images, 0, "contact sheet source").image;
  const output = Buffer.alloc(first.width * 3 * first.height * 3 * 4);
  for (const cell of images) {
    if (cell.image.width !== first.width || cell.image.height !== first.height) {
      throw new Error("review contact sheet sources have different dimensions");
    }
    for (let row = 0; row < first.height; row += 1) {
      const sourceStart = row * first.width * 4;
      const targetStart = (((cell.row * first.height) + row) * first.width * 3 * 4) + (cell.column * first.width * 4);
      cell.image.data.copy(output, targetStart, sourceStart, sourceStart + (first.width * 4));
    }
  }
  await writeFile(CONTACT_SHEET_FILE, encodePng(first.width * 3, first.height * 3, output));
}

async function loadFixtures(): Promise<ReadonlyMap<Policy, Fixture>> {
  const fixtures = new Map<Policy, Fixture>();
  for (const policy of ["Discovery", "Reliability"] as const) {
    const path = requiredItem(FIXTURE_PATHS, policy, "fixture path").join("/");
    const text = await readFile(path, "utf8");
    fixtures.set(policy, {
      identity: requiredItem(FIXTURE_PATHS, policy, "fixture identity").at(-1) ?? "",
      payload: JSON.parse(text) as unknown,
      sha256: sha256Text(text),
    });
  }
  return fixtures;
}

function emptyMetadata(): ReviewMetadata {
  return {
    schemaVersion: 1,
    captureConfiguration: {
      viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      litPixelChannelMargin: LIT_PIXEL_CHANNEL_MARGIN,
      elapsedMilliseconds: FIXED_ELAPSED_MILLISECONDS,
      dprProjects: REVIEW_PROJECTS,
    },
    records: [],
    comparisons: {
      lodContinuity: null,
      policyTransition: null,
      reducedMotion: null,
    },
    contactSheet: {
      fileName: "contact-sheet/overview.png",
      rows: MORPHOLOGIES,
      columns: LOD_BANDS,
      cells: MORPHOLOGIES.flatMap((morphology, row) => LOD_BANDS.map((lodBand, column) => ({
        row,
        column,
        fileName: `captures/grid-${morphology}-${lodBand}-dpr-1.png`,
      }))),
    },
  };
}

async function loadMetadata(): Promise<ReviewMetadata> {
  const parsed = JSON.parse(await readFile(METADATA_FILE, "utf8")) as ReviewMetadata;
  if (parsed.schemaVersion !== 1 || parsed.records.length === 0 || parsed.contactSheet === null) {
    throw new Error("review DPR 2 requires the DPR 1 capture package");
  }
  return parsed;
}

async function currentCommitSha(): Promise<string> {
  const gitDirectory = ["..", ".git"].join("/");
  const head = (await readFile(`${gitDirectory}/HEAD`, "utf8")).trim();
  let sha = head;
  if (head.startsWith("ref: ")) {
    const reference = head.slice(5);
    try {
      sha = (await readFile(`${gitDirectory}/${reference}`, "utf8")).trim();
    } catch {
      const packed = await readFile(`${gitDirectory}/packed-refs`, "utf8");
      const line = packed.split("\n").find((item) => item.endsWith(` ${reference}`));
      sha = line?.split(" ")[0] ?? "";
    }
  }
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error("review capture cannot determine the current commit SHA");
  }
  return sha;
}

async function runtimeVersions(browser: Browser, page: Page): Promise<RuntimeVersions> {
  const sigmaPackage = JSON.parse(await readFile(["node_modules", "sigma", "package.json"].join("/"), "utf8")) as { readonly version?: unknown };
  if (typeof sigmaPackage.version !== "string") {
    throw new Error("review capture cannot determine the renderer version");
  }
  return {
    browser: `chromium ${browser.version()}`,
    renderer: `sigma ${sigmaPackage.version}`,
    userAgent: await page.evaluate(() => navigator.userAgent),
  };
}

function measureImage(image: DecodedPng): ImageMeasurements {
  let litPixels = 0;
  let darkest: PixelMeasurement | undefined;
  let brightest: PixelMeasurement | undefined;
  const distinct = new Set<number>();
  const field = fieldPixel(image);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    distinct.add((red * 65_536) + (green * 256) + blue);
    if (!isLitPixel(red, green, blue, field)) {
      continue;
    }
    litPixels += 1;
    const measurement = pixelMeasurement(red, green, blue);
    if (darkest === undefined || measurement.relativeLuminance < darkest.relativeLuminance) {
      darkest = measurement;
    }
    if (brightest === undefined || measurement.relativeLuminance > brightest.relativeLuminance) {
      brightest = measurement;
    }
  }
  if (darkest === undefined || brightest === undefined) {
    throw new Error("review capture contains no non-background pixels");
  }
  return {
    litPixels: {
      count: litPixels,
      fraction: litPixels / (image.width * image.height),
      fieldRgb: field,
      channelMargin: LIT_PIXEL_CHANNEL_MARGIN,
    },
    distinctColourCount: distinct.size,
    darkestNonBackgroundPixel: darkest,
    brightestNonBackgroundPixel: brightest,
  };
}

function fieldPixel(image: DecodedPng): readonly [number, number, number] {
  return [image.data[0] ?? 0, image.data[1] ?? 0, image.data[2] ?? 0];
}

function isLitPixel(
  red: number,
  green: number,
  blue: number,
  field: readonly [number, number, number],
): boolean {
  return Math.max(
    Math.abs(red - field[0]),
    Math.abs(green - field[1]),
    Math.abs(blue - field[2]),
  ) > LIT_PIXEL_CHANNEL_MARGIN;
}

function pixelMeasurement(red: number, green: number, blue: number): PixelMeasurement {
  return {
    rgb: [red, green, blue],
    hex: `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`,
    relativeLuminance: relativeLuminance(red, green, blue),
  };
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * linear(red)) + (0.7152 * linear(green)) + (0.0722 * linear(blue));
}

async function decodePng(path: string): Promise<DecodedPng> {
  const source = await readFile(path);
  if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`review image ${path} is not a PNG`);
  }
  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  const dataChunks: Buffer[] = [];
  while (offset < source.length) {
    if (offset + 12 > source.length) {
      throw new Error(`review PNG ${path} ends within a chunk`);
    }
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > source.length) {
      throw new Error(`review PNG ${path} has an invalid chunk length`);
    }
    if (type === "IHDR") {
      width = source.readUInt32BE(offset + 8);
      height = source.readUInt32BE(offset + 12);
      const bitDepth = source[offset + 16];
      const colourType = source[offset + 17];
      const compression = source[offset + 18];
      const filtering = source[offset + 19];
      const interlace = source[offset + 20];
      if (bitDepth !== 8 || compression !== 0 || filtering !== 0 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`review PNG ${path} has an unsupported format`);
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      dataChunks.push(source.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      if (end !== source.length) {
        throw new Error(`review PNG ${path} has trailing bytes`);
      }
      break;
    }
    offset = end;
  }
  if (width === undefined || height === undefined || channels === undefined) {
    throw new Error(`review PNG ${path} lacks image dimensions`);
  }
  const scanlines = inflateSync(Buffer.concat(dataChunks));
  const rowBytes = width * channels;
  const expectedBytes = (rowBytes + 1) * height;
  if (scanlines.length !== expectedBytes) {
    throw new Error(`review PNG ${path} has an unexpected scanline length`);
  }
  const decoded = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const scanlineStart = row * (rowBytes + 1);
    const filter = scanlines[scanlineStart];
    if (filter === undefined) {
      throw new Error(`review PNG ${path} lacks a scanline filter`);
    }
    const current = Buffer.alloc(rowBytes);
    for (let column = 0; column < rowBytes; column += 1) {
      const sample = scanlines[scanlineStart + 1 + column] ?? 0;
      const left = column >= channels ? (current[column - channels] ?? 0) : 0;
      const above = previous[column] ?? 0;
      const upperLeft = column >= channels ? (previous[column - channels] ?? 0) : 0;
      current[column] = unfilter(sample, filter, left, above, upperLeft);
    }
    for (let pixel = 0; pixel < width; pixel += 1) {
      const sourceOffset = pixel * channels;
      const targetOffset = ((row * width) + pixel) * 4;
      decoded[targetOffset] = current[sourceOffset] ?? 0;
      decoded[targetOffset + 1] = current[sourceOffset + 1] ?? 0;
      decoded[targetOffset + 2] = current[sourceOffset + 2] ?? 0;
      decoded[targetOffset + 3] = channels === 4 ? (current[sourceOffset + 3] ?? 0) : 255;
    }
    current.copy(previous);
  }
  return {
    bytes: source.length,
    hash: sha256Bytes(source),
    width,
    height,
    data: decoded,
  };
}

function unfilter(sample: number, filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) {
    return sample;
  }
  if (filter === 1) {
    return (sample + left) & 0xff;
  }
  if (filter === 2) {
    return (sample + above) & 0xff;
  }
  if (filter === 3) {
    return (sample + Math.floor((left + above) / 2)) & 0xff;
  }
  if (filter === 4) {
    const predictor = paeth(left, above, upperLeft);
    return (sample + predictor) & 0xff;
  }
  throw new Error(`review PNG uses unsupported filter ${filter}`);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
}

function encodePng(width: number, height: number, data: Buffer): Buffer {
  if (data.length !== width * height * 4) {
    throw new Error("review contact sheet has an unexpected pixel length");
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

function differingPixels(left: DecodedPng, right: DecodedPng): number {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("review image comparison requires matching dimensions");
  }
  let different = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if (
      left.data[offset] !== right.data[offset]
      || left.data[offset + 1] !== right.data[offset + 1]
      || left.data[offset + 2] !== right.data[offset + 2]
      || left.data[offset + 3] !== right.data[offset + 3]
    ) {
      different += 1;
    }
  }
  return different;
}

async function writeManifest(captureImageCount: number): Promise<void> {
  const files = (await packageFiles(REVIEW_DIRECTORY)).filter((file) => file !== "MANIFEST.json");
  const entries: Record<string, { readonly sha256: string; readonly bytes: number }> = {};
  let bytes = 0;
  for (const file of files) {
    const path = join(REVIEW_DIRECTORY, file);
    const contents = await readFile(path);
    entries[file] = { sha256: sha256Bytes(contents), bytes: contents.length };
    bytes += contents.length;
  }
  const manifest = {
    schemaVersion: 1,
    files: entries,
    totals: {
      hashedFileCount: files.length,
      captureImageCount,
      hashedBytes: bytes,
    },
  };
  await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function packageFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await packageFiles(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

function requiredReviewProject(value: string): ReviewProject {
  if (!REVIEW_PROJECTS.includes(value as ReviewProject)) {
    throw new Error(`review capture received unexpected project ${value}`);
  }
  return value as ReviewProject;
}

function requiredFixture(fixtures: ReadonlyMap<Policy, Fixture>, policy: Policy): Fixture {
  const fixture = fixtures.get(policy);
  if (fixture === undefined) {
    throw new Error(`review fixture ${policy} is unavailable`);
  }
  return fixture;
}

function requiredItem<Value>(values: ReadonlyMap<string, Value>, key: string, label: string): Value;
function requiredItem<Value>(values: Readonly<Record<string, Value>>, key: string, label: string): Value;
function requiredItem<Value>(values: readonly Value[], index: number, label: string): Value;
function requiredItem<Value>(
  values: ReadonlyMap<string, Value> | Readonly<Record<string, Value>> | readonly Value[],
  key: string | number,
  label: string,
): Value {
  const value = values instanceof Map
    ? values.get(String(key))
    : Array.isArray(values)
      ? values[key as number]
      : (values as Readonly<Record<string, Value>>)[String(key)];
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
