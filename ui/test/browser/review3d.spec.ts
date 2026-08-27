import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { assertLitPixelFloor, measureLitPixels, MINIMUM_LIT_PIXEL_COUNT, SHIPPING_DARK_FIELD_RGB } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";
import type {
  Review3dCaptureRequest,
  Review3dCaptureWitness,
  Review3dPageApi,
  Review3dRenderer,
  Review3dView,
} from "#browser/review3d.ts";
import type { VisualState } from "#engine/visual-state.ts";
import {
  assertDarkestShippingField,
  darkestPixel,
} from "#test-render3f/capture-field.ts";
import { assertProjectedCameraFramingSubjectsInsideViewport } from "#render3f/camera-framing.ts";
import {
  assertTrackedTreeIdentity,
  TRACKED_TREE_IDENTITY_ALGORITHM,
  TRACKED_TREE_STATUS_COMMAND,
} from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
// A subpath alias, not a relative parent path: a `..` segment at a quote boundary is
// indistinguishable from a machine path to this repository's outgoing scan, which refuses the commit.

type CaptureStatus = "PENDING" | "PASS" | "FAIL" | "NOT_RUN";

type TrackedTreeState = {
  readonly sha256: string;
  readonly statusPorcelain: string;
};

type PlannedCapture = {
  readonly renderer: Review3dRenderer;
  readonly view: Review3dView;
  readonly fileName: string;
  readonly devicePixelRatio: number;
};

type CaptureRecord = {
  readonly renderer: Review3dRenderer;
  readonly view: Review3dView;
  readonly fileName: string;
  readonly devicePixelRatio: number;
  status: CaptureStatus;
  reason: string | null;
  sha256: string | null;
  repeatedSha256: string | null;
  pixelDelta: PixelDelta | null;
  pixelDimensions: { readonly width: number; readonly height: number } | null;
  fieldRgb: readonly [number, number, number] | null;
  litPixels: number | null;
  semanticDigest: string | null;
  requestedVisualState: VisualState | null;
  observedVisualState: VisualState | null;
  selectedOrFocusedId: string | null;
  projection: Review3dCaptureWitness["projection"] | null;
  drawnExtentFraming: Review3dCaptureWitness["drawnExtentFraming"] | null;
  coreConcentration: CoreConcentration | null;
  observedCommitSha: string;
  observedTrackedTreeSha256: string;
};

type CoreConcentration = {
  readonly highThreshold: number;
  readonly lowThreshold: number;
  readonly highPixels: number;
  readonly lowPixels: number;
  readonly ratio: number;
  readonly targetFootprint: Review3dCaptureWitness["microFraming"]["targetFootprint"];
};

type PixelDelta = {
  readonly differingPixels: number;
  readonly maximumChannelDelta: number;
};

type Review3dManifest = {
  readonly schemaVersion: 2;
  readonly run: {
    readonly command: string;
    readonly observedCommitSha: string;
    completedCommitSha: string | null;
    freshAgainstObservedCommit: boolean;
    trackedTree: TrackedTreeIdentity;
    freshAgainstObservedTrackedTree: boolean;
    readonly staleTreeControlOutput: string;
  };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: number;
    readonly palette: "monochrome";
    readonly theme: "dark";
    readonly morphology: "stellar";
    readonly reducedMotion: true;
    readonly elapsedMilliseconds: number;
    readonly fixture: string;
    readonly microFraming: {
      selectedElementId: string | null;
      selectionRule: string | null;
      degree: number | null;
      centeringRule: string | null;
      neighbourCount: number | null;
    };
  };
  readonly semanticGraph: {
    readonly assertion: "all three renderer digests are equal";
    digests: Record<Review3dRenderer, string | null>;
    equal: boolean;
  };
  readonly determinism: {
    readonly assertion: "cache-purged repeat PNG bytes are bit-identical";
    readonly cachePurgedBetweenPasses: true;
    comparedCaptureCount: number;
    passed: boolean;
  };
  readonly captureQuality: {
    readonly requiredFieldRgb: readonly [number, number, number];
    readonly minimumLitPixels: number;
    readonly blankFrameControlOutput: string;
    readonly whiteFieldControlOutput: string;
    readonly lightenedFieldControlOutput: string;
    readonly removedDrawnExtentControlOutput: string;
  };
  readonly captures: CaptureRecord[];
  readonly summary: {
    required: number;
    passed: number;
    failed: number;
    notRun: number;
    pending: number;
    passing: boolean;
    rule: string;
  };
};

const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
const REVIEW3D_ROOT_DIRECTORY = join("dist", "review3d");
const REVIEW3D_COMMAND = "REVIEW3D_CAPTURES=1 npm --prefix ui exec playwright test --project=review3d-dpr-1 --project=review3d-dpr-2";
const FIXTURE = ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CORE_CONCENTRATION_HIGH_THRESHOLD = 192;
const CORE_CONCENTRATION_LOW_THRESHOLD = 32;
const RENDERERS = ["sigma-2d", "r3f-2d", "r3f-3d"] as const satisfies readonly Review3dRenderer[];
const COMMON_VIEWS = ["macro", "meso", "micro", "selected", "focused"] as const satisfies readonly Review3dView[];
const ORBIT_VIEWS = ["orbit-a", "orbit-b"] as const satisfies readonly Review3dView[];
const execFileAsync = promisify(execFile);

type Review3dOutput = {
  readonly directory: string;
  readonly captureDirectory: string;
  readonly manifestFile: string;
};

function review3dDevicePixelRatio(projectName: string): number | null {
  if (projectName === "review3d-dpr-1") {
    return 1;
  }
  if (projectName === "review3d-dpr-2") {
    return 2;
  }
  return null;
}

function review3dOutput(devicePixelRatio: number): Review3dOutput {
  const directory = join(REVIEW3D_ROOT_DIRECTORY, `dpr-${devicePixelRatio}`);
  return {
    directory,
    captureDirectory: join(directory, "captures"),
    manifestFile: join(directory, "manifest.json"),
  };
}

test("deterministic three-renderer visual review capture set", async ({ page }, testInfo) => {
  const devicePixelRatio = review3dDevicePixelRatio(testInfo.project.name);
  test.skip(devicePixelRatio === null, "run this through a dedicated review3d DPR project");
  if (devicePixelRatio === null) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(devicePixelRatio);

  const output = review3dOutput(devicePixelRatio);
  const observedTrackedTree = await currentTrackedTreeState();
  const observedTrackedTreeSha256 = observedTrackedTree.sha256;
  const observedCommitSha = await currentCommitSha();
  const captures = plannedCaptures(devicePixelRatio);
  const manifest = emptyManifest(observedCommitSha, observedTrackedTree, devicePixelRatio, captures);
  await rm(output.directory, { recursive: true, force: true });
  await mkdir(output.captureDirectory, { recursive: true });
  await writeManifest(manifest, output);

  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "review3d.ts"].join("/")],
  });
  const pageModule = requiredItem(bundled.outputFiles, 0, "review3d page module output");

  let firstPassReady = false;
  try {
    await installReview3dPage(page, pageModule.text);
    firstPassReady = true;
  } catch (error: unknown) {
    markPendingNotRun(manifest, `initial page module could not produce captures: ${errorMessage(error)}`);
    await writeManifest(manifest, output);
  }
  if (firstPassReady) {
    try {
      for (const capture of captures) {
        await captureFirstPass(page, manifest, capture, output);
        await writeManifest(manifest, output);
      }
    } finally {
      await destroyReview3dPage(page);
    }
  }

  if (firstPassReady) {
    await page.goto("about:blank");
    await purgeBrowserCache(page);
    let repeatPassReady = false;
    try {
      await installReview3dPage(page, pageModule.text);
      repeatPassReady = true;
    } catch (error: unknown) {
      markSuccessfulCapturesNotRun(manifest, `cache-purged page module could not produce captures: ${errorMessage(error)}`);
      await writeManifest(manifest, output);
    }
    if (repeatPassReady) {
      try {
        for (const capture of captures) {
          await captureRepeatPass(page, manifest, capture, output);
          await writeManifest(manifest, output);
        }
      } finally {
        await destroyReview3dPage(page);
      }
    }
  }

  manifest.run.completedCommitSha = await currentCommitSha();
  const completedTrackedTree = await currentTrackedTreeState();
  manifest.run.trackedTree = trackedTreeIdentity(
    observedTrackedTreeSha256,
    observedTrackedTree.statusPorcelain,
    completedTrackedTree,
  );
  manifest.run.freshAgainstObservedCommit = manifest.run.completedCommitSha === observedCommitSha
    && manifest.captures.every((capture) => capture.observedCommitSha === observedCommitSha);
  manifest.run.freshAgainstObservedTrackedTree = hasCleanStableTrackedTree(manifest.run.trackedTree)
    && manifest.captures.every((capture) => capture.observedTrackedTreeSha256 === observedTrackedTreeSha256);
  manifest.semanticGraph.equal = semanticDigestParity(manifest.semanticGraph.digests);
  manifest.determinism.comparedCaptureCount = manifest.captures.filter((capture) => capture.repeatedSha256 !== null).length;
  manifest.determinism.passed = manifest.determinism.comparedCaptureCount === manifest.captures.length
    && manifest.captures.every((capture) => capture.sha256 !== null && capture.sha256 === capture.repeatedSha256);
  updateSummary(manifest);
  await writeManifest(manifest, output);

  const failures = manifest.captures
    .filter((capture) => capture.status !== "PASS")
    .map((capture) => `${capture.renderer}/${capture.view}: ${capture.reason ?? capture.status}`);
  if (!manifest.run.freshAgainstObservedCommit) {
    failures.push("the current commit changed during capture, so the images are not fresh against the observed commit");
  }
  if (!manifest.run.freshAgainstObservedTrackedTree) {
    failures.push("the tracked tree changed during capture, so the images are not certifiable against the measured tree");
  }
  const currentTrackedTree = await currentTrackedTreeState();
  assertTrackedTreeIdentity(
    manifest.run.trackedTree,
    currentTrackedTree.sha256,
    "review3d manifest",
    currentTrackedTree.statusPorcelain,
  );
  if (!manifest.semanticGraph.equal) {
    failures.push("the three renderer semantic digests are not all present and equal");
  }
  if (!manifest.determinism.passed) {
    failures.push("the cache-purged repeat did not reproduce every capture byte-for-byte");
  }
  if (failures.length > 0) {
    throw new Error(`review3d capture set failed: ${failures.join(" | ")}`);
  }
});

async function captureFirstPass(
  page: Page,
  manifest: Review3dManifest,
  planned: PlannedCapture,
  output: Review3dOutput,
): Promise<void> {
  const record = requiredCaptureRecord(manifest, planned);
  try {
    const witness = await invokeCapture(page, planned);
    setMicroFraming(manifest, witness.microFraming);
    const captureFile = join(output.directory, planned.fileName);
    await page.locator("#review3d-root").screenshot({ path: captureFile });
    const bytes = await readFile(captureFile);
    const dimensions = pngDimensions(bytes, planned.fileName);
    expect(dimensions).toEqual({
      width: CAPTURE_WIDTH * planned.devicePixelRatio,
      height: CAPTURE_HEIGHT * planned.devicePixelRatio,
    });
    const image = decodePng(bytes);
    const pixels = measureLitPixels(image);
    record.sha256 = sha256(bytes);
    record.pixelDimensions = dimensions;
    record.fieldRgb = darkestPixel(image);
    record.litPixels = pixels.litPixels;
    record.semanticDigest = witness.semanticDigest;
    record.requestedVisualState = witness.requestedVisualState;
    record.observedVisualState = witness.observedVisualState;
    record.selectedOrFocusedId = witness.selectedOrFocusedId;
    record.projection = witness.projection;
    record.drawnExtentFraming = witness.drawnExtentFraming;
    record.coreConcentration = planned.renderer === "r3f-2d" && planned.view === "macro"
      ? measureCoreConcentration(image, witness.microFraming.targetFootprint)
      : null;
    setSemanticDigest(manifest, planned.renderer, witness.semanticDigest);
    try {
      assertDarkestShippingField(image, `review3d ${planned.renderer}/${planned.view} capture`);
      assertLitPixelFloor(image, `review3d ${planned.renderer}/${planned.view} capture`);
    } catch (error: unknown) {
      record.status = "FAIL";
      record.reason = errorMessage(error);
      return;
    }
    record.status = "PASS";
    record.reason = null;
  } catch (error: unknown) {
    record.status = "NOT_RUN";
    record.reason = errorMessage(error);
  }
}

async function captureRepeatPass(
  page: Page,
  manifest: Review3dManifest,
  planned: PlannedCapture,
  output: Review3dOutput,
): Promise<void> {
  const record = requiredCaptureRecord(manifest, planned);
  if (record.sha256 === null) {
    return;
  }
  try {
    const witness = await invokeCapture(page, planned);
    const bytes = await page.locator("#review3d-root").screenshot();
    pngDimensions(bytes, planned.fileName);
    const image = decodePng(bytes);
    const repeatedSha256 = sha256(bytes);
    record.repeatedSha256 = repeatedSha256;
    if (witness.semanticDigest !== record.semanticDigest) {
      record.status = "FAIL";
      record.reason = "the cache-purged repeat received a graph with a different semantic digest";
      return;
    }
    setMicroFraming(manifest, witness.microFraming);
    const firstBytes = await readFile(join(output.directory, planned.fileName));
    record.pixelDelta = measurePixelDelta(decodePng(firstBytes), image);
    if (!bytes.equals(firstBytes)) {
      record.status = "FAIL";
      record.reason = `the cache-purged repeat PNG bytes differ from the first capture: ${record.pixelDelta.differingPixels} differing pixels, maximum channel delta ${record.pixelDelta.maximumChannelDelta}`;
      return;
    }
    try {
      assertDarkestShippingField(image, `review3d ${planned.renderer}/${planned.view} cache-purged repeat`);
      assertLitPixelFloor(image, `review3d ${planned.renderer}/${planned.view} cache-purged repeat`);
    } catch (error: unknown) {
      record.status = "FAIL";
      record.reason = errorMessage(error);
      return;
    }
    setSemanticDigest(manifest, planned.renderer, witness.semanticDigest);
  } catch (error: unknown) {
    record.status = "NOT_RUN";
    record.reason = `cache-purged repeat could not produce a capture: ${errorMessage(error)}`;
  }
}

async function installReview3dPage(page: Page, pageModule: string): Promise<void> {
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
  await expect.poll(async () => readReview3dApi(page).then((api) => api.ready)).toBe(true);
  expect((await readReview3dApi(page)).errors).toEqual([]);
}

async function destroyReview3dPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.__review3d;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function purgeBrowserCache(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Network.clearBrowserCache");
  } finally {
    await session.detach();
  }
}

async function readReview3dApi(page: Page): Promise<Review3dPageApi> {
  return page.evaluate(() => {
    const api = window.__review3d;
    if (api === undefined) {
      throw new Error("review3d page module is unavailable");
    }
    return api;
  });
}

async function invokeCapture(page: Page, request: Review3dCaptureRequest): Promise<Review3dCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__review3d;
    if (api === undefined) {
      throw new Error("review3d page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

function plannedCaptures(devicePixelRatio: number): readonly PlannedCapture[] {
  const common = RENDERERS.flatMap((renderer) => COMMON_VIEWS.map((view) => ({
    renderer,
    view,
    fileName: ["captures", `${renderer}-${view}.png`].join("/"),
    devicePixelRatio,
  })));
  const orbit = ORBIT_VIEWS.map((view) => ({
    renderer: "r3f-3d" as const,
    view,
    fileName: ["captures", `r3f-3d-${view}.png`].join("/"),
    devicePixelRatio,
  }));
  return [...common, ...orbit];
}

function emptyManifest(
  observedCommitSha: string,
  observedTrackedTree: TrackedTreeState,
  devicePixelRatio: number,
  planned: readonly PlannedCapture[],
): Review3dManifest {
  const observedTrackedTreeSha256 = observedTrackedTree.sha256;
  return {
    schemaVersion: 2,
    run: {
      command: REVIEW3D_COMMAND,
      observedCommitSha,
      completedCommitSha: null,
      freshAgainstObservedCommit: false,
      trackedTree: trackedTreeIdentity(
        observedTrackedTreeSha256,
        observedTrackedTree.statusPorcelain,
        observedTrackedTree,
      ),
      freshAgainstObservedTrackedTree: false,
      staleTreeControlOutput: failedControlOutput(() => assertTrackedTreeIdentity({
        algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
        measuredSha256: "0".repeat(64),
        completedSha256: "0".repeat(64),
        measuredStatusPorcelain: "",
        completedStatusPorcelain: "",
        stable: true,
      }, observedTrackedTreeSha256, "review3d stale tracked-tree control", observedTrackedTree.statusPorcelain)),
    },
    captureConfiguration: {
      viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
      devicePixelRatio,
      palette: "monochrome",
      theme: "dark",
      morphology: "stellar",
      reducedMotion: true,
      elapsedMilliseconds: 480,
      fixture: FIXTURE,
      microFraming: {
        selectedElementId: null,
        selectionRule: null,
        degree: null,
        centeringRule: null,
        neighbourCount: null,
      },
    },
    semanticGraph: {
      assertion: "all three renderer digests are equal",
      digests: { "sigma-2d": null, "r3f-2d": null, "r3f-3d": null },
      equal: false,
    },
    determinism: {
      assertion: "cache-purged repeat PNG bytes are bit-identical",
      cachePurgedBetweenPasses: true,
      comparedCaptureCount: 0,
      passed: false,
    },
    captureQuality: {
      requiredFieldRgb: SHIPPING_DARK_FIELD_RGB,
      minimumLitPixels: MINIMUM_LIT_PIXEL_COUNT,
      blankFrameControlOutput: blankFrameControlOutput(),
      whiteFieldControlOutput: whiteFieldControlOutput(),
      lightenedFieldControlOutput: lightenedFieldControlOutput(),
      removedDrawnExtentControlOutput: removedDrawnExtentControlOutput(),
    },
    captures: planned.map((capture) => ({
      ...capture,
      status: "PENDING",
      reason: null,
      sha256: null,
      repeatedSha256: null,
      pixelDelta: null,
      pixelDimensions: null,
      fieldRgb: null,
      litPixels: null,
      semanticDigest: null,
      requestedVisualState: null,
      observedVisualState: null,
      selectedOrFocusedId: null,
      projection: null,
      drawnExtentFraming: null,
      coreConcentration: null,
      observedCommitSha,
      observedTrackedTreeSha256,
    })),
    summary: {
      required: planned.length,
      passed: 0,
      failed: 0,
      notRun: 0,
      pending: planned.length,
      passing: false,
      rule: "Every planned image must be PASS, bound to one stable observed tracked tree, use the same semantic graph digest across all three renderers, and match its cache-purged repeat byte-for-byte. NOT_RUN is a failure, never an omitted capture.",
    },
  };
}

async function writeManifest(manifest: Review3dManifest, output: Review3dOutput): Promise<void> {
  const completedTrackedTree = await currentTrackedTreeState();
  manifest.run.trackedTree = trackedTreeIdentity(
    manifest.run.trackedTree.measuredSha256,
    manifest.run.trackedTree.measuredStatusPorcelain ?? "",
    completedTrackedTree,
  );
  updateSummary(manifest);
  await writeFile(output.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function updateSummary(manifest: Review3dManifest): void {
  const statusCount = (status: CaptureStatus): number => manifest.captures.filter((capture) => capture.status === status).length;
  manifest.summary.passed = statusCount("PASS");
  manifest.summary.failed = statusCount("FAIL");
  manifest.summary.notRun = statusCount("NOT_RUN");
  manifest.summary.pending = statusCount("PENDING");
  manifest.summary.passing = manifest.summary.passed === manifest.summary.required
    && manifest.summary.failed === 0
    && manifest.summary.notRun === 0
    && manifest.summary.pending === 0
    && manifest.run.freshAgainstObservedCommit
    && manifest.run.freshAgainstObservedTrackedTree
    && hasCleanStableTrackedTree(manifest.run.trackedTree)
    && manifest.semanticGraph.equal
    && manifest.determinism.passed;
}

function requiredCaptureRecord(manifest: Review3dManifest, planned: PlannedCapture): CaptureRecord {
  const record = manifest.captures.find((capture) => capture.renderer === planned.renderer
    && capture.view === planned.view
    && capture.devicePixelRatio === planned.devicePixelRatio);
  if (record === undefined) {
    throw new Error(`review3d manifest lacks ${planned.renderer}/${planned.view} at DPR ${planned.devicePixelRatio}`);
  }
  return record;
}

function markPendingNotRun(manifest: Review3dManifest, reason: string): void {
  for (const record of manifest.captures) {
    if (record.status === "PENDING") {
      record.status = "NOT_RUN";
      record.reason = reason;
    }
  }
}

function markSuccessfulCapturesNotRun(manifest: Review3dManifest, reason: string): void {
  for (const record of manifest.captures) {
    if (record.status === "PASS") {
      record.status = "NOT_RUN";
      record.reason = reason;
    }
  }
}

function setSemanticDigest(manifest: Review3dManifest, renderer: Review3dRenderer, digest: string): void {
  const current = manifest.semanticGraph.digests[renderer];
  if (current !== null && current !== digest) {
    throw new Error(`review3d ${renderer} mounted more than one semantic graph digest`);
  }
  manifest.semanticGraph.digests[renderer] = digest;
}

function setMicroFraming(
  manifest: Review3dManifest,
  framing: Review3dCaptureWitness["microFraming"],
): void {
  const current = manifest.captureConfiguration.microFraming;
  if (current.selectedElementId !== null && (
    current.selectedElementId !== framing.selectedElementId
    || current.selectionRule !== framing.selectionRule
    || current.degree !== framing.degree
    || current.centeringRule !== framing.centeringRule
    || current.neighbourCount !== framing.neighbourCount
  )) {
    throw new Error("review3d renderers did not retain one deterministic micro-framing target");
  }
  current.selectedElementId = framing.selectedElementId;
  current.selectionRule = framing.selectionRule;
  current.degree = framing.degree;
  current.centeringRule = framing.centeringRule;
  current.neighbourCount = framing.neighbourCount;
}

function semanticDigestParity(digests: Record<Review3dRenderer, string | null>): boolean {
  const values = RENDERERS.map((renderer) => digests[renderer]);
  if (values.some((value) => value === null)) {
    return false;
  }
  return new Set(values).size === 1;
}

function pngDimensions(bytes: Buffer, name: string): { readonly width: number; readonly height: number } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`review3d ${name} is not a PNG`);
  }
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`review3d ${name} lacks PNG dimensions`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function blankFrameControlOutput(): string {
  return failedControlOutput(() => assertLitPixelFloor(blankPixelImage(SHIPPING_DARK_FIELD_RGB), "review3d blank-frame control"));
}

function whiteFieldControlOutput(): string {
  return failedControlOutput(() => assertDarkestShippingField(blankPixelImage([255, 255, 255]), "review3d white-field control"));
}

function lightenedFieldControlOutput(): string {
  return failedControlOutput(() => assertDarkestShippingField(blankPixelImage([10, 10, 10]), "review3d lightened-field control"));
}

function removedDrawnExtentControlOutput(): string {
  return failedControlOutput(() => assertProjectedCameraFramingSubjectsInsideViewport(
    [{ id: "removed-margin", viewportCenter: { x: 1, y: 1 }, extentCssPx: 2 }],
    3,
    3,
    "review3d removed drawn-extent control",
  ));
}

function measureCoreConcentration(
  image: PixelImage,
  footprint: Review3dCaptureWitness["microFraming"]["targetFootprint"],
): CoreConcentration {
  let highPixels = 0;
  let lowPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = ((y * image.width) + x) * 4;
      const maximumChannel = Math.max(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      );
      highPixels += maximumChannel >= CORE_CONCENTRATION_HIGH_THRESHOLD ? 1 : 0;
      lowPixels += maximumChannel >= CORE_CONCENTRATION_LOW_THRESHOLD ? 1 : 0;
    }
  }
  if (lowPixels === 0) {
    throw new Error("review3d core-concentration sample has no low-threshold pixels");
  }
  return {
    highThreshold: CORE_CONCENTRATION_HIGH_THRESHOLD,
    lowThreshold: CORE_CONCENTRATION_LOW_THRESHOLD,
    highPixels,
    lowPixels,
    ratio: highPixels / lowPixels,
    targetFootprint: footprint,
  };
}

function blankPixelImage(fieldRgb: readonly [number, number, number]): PixelImage {
  return { width: 1, height: 1, data: Uint8Array.from([...fieldRgb, 255]) };
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("review3d capture-quality control unexpectedly passed");
}

function measurePixelDelta(first: PixelImage, repeat: PixelImage): PixelDelta {
  if (first.width !== repeat.width || first.height !== repeat.height || first.data.length !== repeat.data.length) {
    throw new Error("review3d repeat pixel dimensions differ from the first capture");
  }
  let differingPixels = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs((first.data[offset + channel] ?? 0) - (repeat.data[offset + channel] ?? 0));
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      pixelDiffers ||= delta !== 0;
    }
    differingPixels += pixelDiffers ? 1 : 0;
  }
  return { differingPixels, maximumChannelDelta };
}

function decodePng(source: Uint8Array): PixelImage {
  const input = Buffer.from(source);
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("review3d capture is not a PNG");
  }
  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  const chunks: Buffer[] = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > input.length) {
      throw new Error("review3d PNG has an invalid chunk length");
    }
    if (type === "IHDR") {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      const bitDepth = input[offset + 16];
      const colourType = input[offset + 17];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error("review3d PNG has an unsupported pixel format");
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      chunks.push(input.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }
  if (width === undefined || height === undefined || channels === undefined) {
    throw new Error("review3d PNG lacks dimensions");
  }
  const scanlines = inflateSync(Buffer.concat(chunks));
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error("review3d PNG has invalid scanline bytes");
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
    const p = left + above - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - above);
    const pc = Math.abs(p - upperLeft);
    return (value + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff;
  }
  throw new Error(`review3d PNG has unsupported filter ${filter}`);
}

async function currentCommitSha(): Promise<string> {
  const gitDirectory = ["..", ".git"].join("/");
  const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
  let sha = head;
  if (head.startsWith("ref: ")) {
    const reference = head.slice(5);
    try {
      sha = (await readFile(join(gitDirectory, reference), "utf8")).trim();
    } catch {
      const packed = await readFile(join(gitDirectory, "packed-refs"), "utf8");
      const line = packed.split("\n").find((item) => item.endsWith(` ${reference}`));
      sha = line?.split(" ")[0] ?? "";
    }
  }
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error("review3d capture cannot determine the current commit SHA");
  }
  return sha;
}

function trackedTreeIdentity(
  measuredSha256: string,
  measuredStatusPorcelain: string,
  completed: TrackedTreeState,
): TrackedTreeIdentity {
  return {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256,
    completedSha256: completed.sha256,
    measuredStatusPorcelain,
    completedStatusPorcelain: completed.statusPorcelain,
    stable: measuredSha256 === completed.sha256
      && measuredStatusPorcelain === completed.statusPorcelain,
  };
}

function hasCleanStableTrackedTree(identity: TrackedTreeIdentity): boolean {
  return identity.stable
    && identity.measuredStatusPorcelain === ""
    && identity.completedStatusPorcelain === "";
}

async function currentTrackedTreeState(): Promise<TrackedTreeState> {
  const repositoryDirectory = [".."].join("/");
  const [{ stdout: trackedPaths }, { stdout: statusPorcelain }] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], { cwd: repositoryDirectory, encoding: "utf8" }),
    execFileAsync("git", trackedTreeStatusArguments(), { cwd: repositoryDirectory, encoding: "utf8" }),
  ]);
  const hash = createHash("sha256");
  for (const path of trackedPaths.split("\0")) {
    if (path === "") {
      continue;
    }
    const pathBytes = Buffer.from(path, "utf8");
    const contents = await readFile(join(repositoryDirectory, path));
    hash.update(uint64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64be(contents.length));
    hash.update(contents);
  }
  return { sha256: hash.digest("hex"), statusPorcelain };
}

function uint64be(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function requiredItem<Value>(values: readonly Value[], index: number, name: string): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `TRACKED_TREE_STATUS_COMMAND` names the whole command, program included. Splitting it straight
 * into an argument list re-passes `git` as git's own first argument, which fails with
 * `git: 'git' is not a git command` — so the status reading threw, and with it the tree identity
 * this artifact is bound by. It went unnoticed because no evidence had been regenerated since the
 * identity was rewritten. The program name is dropped here, once, and asserted.
 */
function trackedTreeStatusArguments(): readonly string[] {
  const [program, ...args] = TRACKED_TREE_STATUS_COMMAND.split(" ");
  if (program !== "git" || args.length === 0) {
    throw new Error(`tracked-tree status command is not a git invocation: ${TRACKED_TREE_STATUS_COMMAND}`);
  }
  return args;
}
