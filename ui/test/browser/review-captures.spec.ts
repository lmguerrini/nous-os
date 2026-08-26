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

type ViewportPoint = {
  readonly x: number;
  readonly y: number;
};

type FilamentTraceWitness = {
  readonly edgeId: string;
  readonly curve: {
    readonly source: ViewportPoint;
    readonly control: ViewportPoint;
    readonly target: ViewportPoint;
  };
  readonly widthCssPixels: number;
};

type FilamentCrossSectionMeasurement = {
  readonly edgeCount: number;
  readonly cssPixelWidths: readonly number[];
  readonly minimumCssPixels: number;
  readonly medianCssPixels: number;
  readonly maximumCssPixels: number;
};

type FilamentContinuityMeasurement =
  | {
      readonly available: true;
      readonly tracedFilamentId: string;
      readonly devicePixelRatio: number;
      readonly nonBackgroundChannelMargin: number;
      readonly perpendicularSearchDevicePixels: number;
      readonly sampledStationCount: number;
      readonly backgroundOnlyStationCount: number;
      readonly longestBackgroundOnlyRunStations: number;
    }
  | {
      readonly available: false;
      readonly tracedFilamentId: string;
      readonly reason: string;
    };

// Every value in this measurement path is tagged with the pixel space it was
// produced in, so a CSS-pixel coordinate cannot be handed to a function that
// expects a device-pixel one (and vice versa) without an explicit conversion.
type CssPixels = number & { readonly __pixelSpace: "css" };
type DevicePixels = number & { readonly __pixelSpace: "device" };

type DevicePoint = {
  readonly x: DevicePixels;
  readonly y: DevicePixels;
};

type DeviceCurve = {
  readonly source: DevicePoint;
  readonly control: DevicePoint;
  readonly target: DevicePoint;
};

type D040CompositionMeasurement = {
  readonly communityCount: number;
  readonly communitySizes: readonly number[];
  readonly intraCommunityRelationCount: number;
  readonly bridgeRelationCount: number;
  readonly medianIntraCommunityRelationLengthWorldUnits: number | null;
  readonly medianBridgeRelationLengthWorldUnits: number | null;
  readonly bridgeToIntraMedianLengthRatio: number | null;
  readonly withinCommunityDirectedDensity: number;
  readonly minimumPairwiseAnchorSeparationWorldUnits: number | null;
  readonly unavailableMeasurements: readonly string[];
};

type PageCaptureWitness = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly cameraState: CameraState;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly aggregateWindowCount: number;
  readonly focus: FocusWitness | null;
  readonly filamentTrace: FilamentTraceWitness;
  readonly filamentCrossSection: FilamentCrossSectionMeasurement;
  readonly d040Composition: D040CompositionMeasurement;
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
  readonly filamentContinuity: FilamentContinuityMeasurement;
  readonly filamentCrossSection: FilamentCrossSectionMeasurement;
  readonly d040Composition: D040CompositionMeasurement;
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

type DeterminismRunWitness = {
  readonly sequence: 1 | 2;
  readonly runtimeVersions: RuntimeVersions;
  readonly semanticAndLayout: {
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly visualFiles: readonly {
    readonly fileName: string;
    readonly sha256: string;
  }[];
};

type DeterminismWitness = {
  readonly cachePurgedBetweenRuns: true;
  readonly runtime: {
    readonly assertion: "bit-identical";
    readonly first: RuntimeVersions;
    readonly second: RuntimeVersions;
  };
  readonly semanticAndLayout: {
    readonly assertion: "bit-identical";
    readonly comparedFileCount: number;
    readonly firstSha256: string;
    readonly secondSha256: string;
  };
  readonly visual: {
    readonly assertion: "bit-identical";
    readonly comparedFileCount: number;
    readonly firstManifestSha256: string;
    readonly secondManifestSha256: string;
  };
  readonly runs: readonly [DeterminismRunWitness, DeterminismRunWitness];
};

type ReviewSuiteResult = {
  readonly command: string;
  readonly commitSha: string;
  readonly status: "PASS" | "NOT_RUN";
  readonly completedProjects: readonly ReviewProject[];
};

type ReviewCheckResult = {
  readonly id: `${ReviewProject}/determinism`;
  readonly status: "PASS" | "NOT_RUN";
  readonly detail: string;
};

type ReviewMetadata = {
  readonly schemaVersion: 1;
  readonly suiteResult: ReviewSuiteResult;
  readonly checks: readonly ReviewCheckResult[];
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
  readonly determinism: Record<ReviewProject, DeterminismWitness | null>;
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
const CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS = 5;
const CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS = 0.5;
const CONTINUITY_INTERIOR_MARGIN_FRACTION = 0.05;
const CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT = 512;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const LOD_BANDS = ["macro", "meso", "micro"] as const satisfies readonly LodBand[];
const REVIEW_PROJECTS = ["review-dpr-1", "review-dpr-2"] as const satisfies readonly ReviewProject[];
const REVIEW_COMMAND = "npm --prefix ui run test:review";
const FIXTURE_PATHS: Readonly<Record<Policy, readonly string[]>> = {
  Discovery: ["..", "fixtures", "synthetic", "projection", "discovery-all-time.json"],
  Reliability: ["..", "fixtures", "synthetic", "projection", "reliability-all-time.json"],
};

const BROWSER_PAGE_MODULE = `
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { detectCommunities } from "#engine/community.ts";
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
  for (const [id, anchor] of [...handle.model.anchors.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    positions[id] = handle.graphToViewport(anchor);
  }
  return positions;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (right === undefined) {
    throw new Error("review median is unavailable");
  }
  if (sorted.length % 2 === 1) {
    return right;
  }
  const left = sorted[middle - 1];
  if (left === undefined) {
    throw new Error("review median left value is unavailable");
  }
  return (left + right) / 2;
}

function filamentWitness(handle) {
  const filaments = handle.model.graph.edges().sort().map((edgeId) => {
    const geometry = handle.model.filaments.get(edgeId);
    if (geometry === undefined) {
      throw new Error("review filament " + edgeId + " lacks geometry");
    }
    const curve = {
      source: handle.graphToViewport(geometry.source),
      control: handle.graphToViewport(geometry.control),
      target: handle.graphToViewport(geometry.target),
    };
    const widthCssPixels = handle.scaleSize(handle.model.graph.getEdgeAttribute(edgeId, "size"));
    return {
      edgeId,
      curve,
      widthCssPixels,
      verticalSpan: Math.abs(Math.max(curve.source.y, curve.control.y, curve.target.y) - Math.min(curve.source.y, curve.control.y, curve.target.y)),
    };
  }).sort((left, right) => right.verticalSpan - left.verticalSpan || left.edgeId.localeCompare(right.edgeId));
  const trace = filaments[0];
  if (trace === undefined) {
    throw new Error("review filament measurements require a rendered relation");
  }
  const widths = filaments.map((filament) => filament.widthCssPixels).sort((left, right) => left - right);
  const minimumCssPixels = widths[0];
  const maximumCssPixels = widths.at(-1);
  const medianCssPixels = median(widths);
  if (minimumCssPixels === undefined || maximumCssPixels === undefined || medianCssPixels === null) {
    throw new Error("review filament width measurements are unavailable");
  }
  return {
    trace: {
      edgeId: trace.edgeId,
      curve: trace.curve,
      widthCssPixels: trace.widthCssPixels,
    },
    crossSection: {
      edgeCount: widths.length,
      cssPixelWidths: widths,
      minimumCssPixels,
      medianCssPixels,
      maximumCssPixels,
    },
  };
}

function d040Composition(visualGraph, handle) {
  const memberships = detectCommunities({ nodes: visualGraph.nodes, edges: visualGraph.edges });
  const communityKeys = [...new Set(memberships.values())].sort();
  const communitySizes = communityKeys.map((key) => [...memberships.values()].filter((value) => value === key).length).sort((left, right) => left - right);
  const relationLengths = { intra: [], bridge: [] };
  for (const edge of [...visualGraph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const sourceCommunity = memberships.get(edge.source);
    const targetCommunity = memberships.get(edge.target);
    const source = handle.model.anchors.get(edge.source);
    const target = handle.model.anchors.get(edge.target);
    if (sourceCommunity === undefined || targetCommunity === undefined || source === undefined || target === undefined) {
      throw new Error("D-040 composition relation " + edge.id + " lacks membership or anchor");
    }
    const length = Math.hypot(source.x - target.x, source.y - target.y, source.z - target.z);
    relationLengths[sourceCommunity === targetCommunity ? "intra" : "bridge"].push(length);
  }
  const intraMedian = median(relationLengths.intra);
  const bridgeMedian = median(relationLengths.bridge);
  const anchors = [...handle.model.anchors.entries()].sort(([left], [right]) => left.localeCompare(right));
  let minimumPairwiseAnchorSeparation = null;
  for (const [index, [, anchor]] of anchors.entries()) {
    for (const [, other] of anchors.slice(index + 1)) {
      const separation = Math.hypot(anchor.x - other.x, anchor.y - other.y, anchor.z - other.z);
      minimumPairwiseAnchorSeparation = minimumPairwiseAnchorSeparation === null
        ? separation
        : Math.min(minimumPairwiseAnchorSeparation, separation);
    }
  }
  const unavailableMeasurements = [];
  if (intraMedian === null) {
    unavailableMeasurements.push("medianIntraCommunityRelationLengthWorldUnits: no intra-community relations");
  }
  if (bridgeMedian === null) {
    unavailableMeasurements.push("medianBridgeRelationLengthWorldUnits: no bridge relations");
  }
  if (intraMedian === null || bridgeMedian === null || intraMedian === 0) {
    unavailableMeasurements.push("bridgeToIntraMedianLengthRatio: a non-zero intra-community median and a bridge median are required");
  }
  if (minimumPairwiseAnchorSeparation === null) {
    unavailableMeasurements.push("minimumPairwiseAnchorSeparationWorldUnits: fewer than two anchors");
  }
  const possibleIntraRelations = communitySizes.reduce((total, size) => total + (size * (size - 1)), 0);
  return {
    communityCount: communitySizes.length,
    communitySizes,
    intraCommunityRelationCount: relationLengths.intra.length,
    bridgeRelationCount: relationLengths.bridge.length,
    medianIntraCommunityRelationLengthWorldUnits: intraMedian,
    medianBridgeRelationLengthWorldUnits: bridgeMedian,
    bridgeToIntraMedianLengthRatio: intraMedian === null || bridgeMedian === null || intraMedian === 0 ? null : bridgeMedian / intraMedian,
    withinCommunityDirectedDensity: possibleIntraRelations === 0 ? 0 : relationLengths.intra.length / possibleIntraRelations,
    minimumPairwiseAnchorSeparationWorldUnits: minimumPairwiseAnchorSeparation,
    unavailableMeasurements,
  };
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
    const visualGraph = requiredGraph(settings.policy);
    product = mount(container, visualGraph, {
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
    const filament = filamentWitness(live);
    return {
      cssWidth: box.width,
      cssHeight: box.height,
      devicePixelRatio: window.devicePixelRatio,
      cameraState: cloneCamera(live.readCameraState()),
      positions: positionsFor(live),
      aggregateWindowCount: live.model.windows.length,
      focus: focusWitness,
      filamentTrace: filament.trace,
      filamentCrossSection: filament.crossSection,
      d040Composition: d040Composition(visualGraph, live),
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
  const productCommitSha = await currentCommitSha();
  const devicePixelRatio = project === "review-dpr-1" ? 1 : 2;
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(devicePixelRatio);

  if (project === "review-dpr-1") {
    await rm(REVIEW_DIRECTORY, { recursive: true, force: true });
    await mkdir(CAPTURE_DIRECTORY, { recursive: true });
    await mkdir(CONTACT_SHEET_DIRECTORY, { recursive: true });
    await mkdir(join(REVIEW_DIRECTORY, "evidence"), { recursive: true });
  }
  const metadata = project === "review-dpr-1"
    ? emptyMetadata(productCommitSha)
    : await loadMetadata(productCommitSha);

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
  const firstProvenance = {
    productCommitSha,
    runtimeVersions: await installReviewPage(page, output.text, fixtures, browser),
  };
  const firstRecordStart = metadata.records.length;
  try {
    if (project === "review-dpr-1") {
      await captureDprOneSet(page, metadata, fixtures, calibration, firstProvenance, devicePixelRatio);
      await composeOverview(metadata.records);
    } else {
      await captureDprTwoSet(page, metadata, fixtures, calibration, firstProvenance, devicePixelRatio);
    }
  } finally {
    await destroyReviewPage(page);
  }
  const firstRecords = metadata.records.slice(firstRecordStart);
  const firstVisualBytes = await capturedVisualBytes(firstRecords);

  await page.goto("about:blank");
  await purgeBrowserCache(page);

  const secondProvenance = {
    productCommitSha,
    runtimeVersions: await installReviewPage(page, output.text, fixtures, browser),
  };
  const repeatedMetadata = emptyMetadata(productCommitSha);
  try {
    if (project === "review-dpr-1") {
      await captureDprOneSet(page, repeatedMetadata, fixtures, calibration, secondProvenance, devicePixelRatio);
    } else {
      await captureDprTwoSet(page, repeatedMetadata, fixtures, calibration, secondProvenance, devicePixelRatio);
    }
  } finally {
    await destroyReviewPage(page);
  }
  const secondVisualBytes = await capturedVisualBytes(repeatedMetadata.records);
  metadata.determinism[project] = assertCaptureDeterminism(
    firstRecords,
    repeatedMetadata.records,
    firstVisualBytes,
    secondVisualBytes,
    firstProvenance.runtimeVersions,
    secondProvenance.runtimeVersions,
  );

  metadata.records.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const completedProjects = REVIEW_PROJECTS.filter((candidate) => metadata.determinism[candidate] !== null);
  const result = {
    ...metadata,
    suiteResult: {
      command: REVIEW_COMMAND,
      commitSha: productCommitSha,
      status: completedProjects.length === REVIEW_PROJECTS.length ? "PASS" as const : "NOT_RUN" as const,
      completedProjects,
    },
    checks: REVIEW_PROJECTS.map((candidate) => ({
      id: `${candidate}/determinism` as const,
      status: metadata.determinism[candidate] === null ? "NOT_RUN" as const : "PASS" as const,
      detail: metadata.determinism[candidate] === null
        ? `${candidate} has no completed two-run determinism witness`
        : `${candidate} recorded its completed two-run determinism witness`,
    })),
  };
  await writeFile(METADATA_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeManifest(metadata.records.length);
});

async function installReviewPage(
  page: Page,
  pageModule: string,
  fixtures: ReadonlyMap<Policy, Fixture>,
  browser: Browser,
): Promise<RuntimeVersions> {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.addScriptTag({ content: pageModule });
  await page.evaluate(async (payloads) => {
    const api = window.__review;
    if (api === undefined) {
      throw new Error("review page module is unavailable");
    }
    await api.initialize(payloads);
  }, Object.fromEntries([...fixtures.entries()].map(([policy, fixture]) => [policy, fixture.payload])) as Record<Policy, unknown>);
  return runtimeVersions(browser, page);
}

async function destroyReviewPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__review?.destroy();
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

async function capturedVisualBytes(records: readonly CaptureRecord[]): Promise<ReadonlyMap<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  for (const record of [...records].sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    bytes.set(record.fileName, await readFile(join(REVIEW_DIRECTORY, record.fileName)));
  }
  return bytes;
}

function assertCaptureDeterminism(
  firstRecords: readonly CaptureRecord[],
  secondRecords: readonly CaptureRecord[],
  firstVisualBytes: ReadonlyMap<string, Buffer>,
  secondVisualBytes: ReadonlyMap<string, Buffer>,
  firstRuntimeVersions: RuntimeVersions,
  secondRuntimeVersions: RuntimeVersions,
): DeterminismWitness {
  if (firstRecords.length === 0 || secondRecords.length === 0) {
    throw new Error("review determinism requires two non-empty capture runs");
  }
  const firstSemanticAndLayout = semanticAndLayoutBytes(firstRecords);
  const secondSemanticAndLayout = semanticAndLayoutBytes(secondRecords);
  expect(
    secondRuntimeVersions,
    "review capture runtime must be pinned identically across both cache-purged runs",
  ).toEqual(firstRuntimeVersions);
  expect(
    secondSemanticAndLayout.equals(firstSemanticAndLayout),
    "semantic and layout capture bytes must be bit-identical across both cache-purged runs",
  ).toBe(true);

  const firstNames = [...firstVisualBytes.keys()].sort();
  const secondNames = [...secondVisualBytes.keys()].sort();
  expect(
    secondNames,
    "visual comparison must contain the same capture names in both cache-purged runs",
  ).toEqual(firstNames);
  for (const fileName of firstNames) {
    const firstBytes = requiredItem(firstVisualBytes, fileName, "first visual capture bytes");
    const secondBytes = requiredItem(secondVisualBytes, fileName, "second visual capture bytes");
    expect(
      secondBytes.equals(firstBytes),
      `visual capture ${fileName} must be bit-identical across both cache-purged runs`,
    ).toBe(true);
  }
  assertDeterminismFailureControls(firstSemanticAndLayout, firstVisualBytes, firstRuntimeVersions);

  const firstRun = determinismRunWitness(1, firstRecords, firstVisualBytes, firstRuntimeVersions, firstSemanticAndLayout);
  const secondRun = determinismRunWitness(2, secondRecords, secondVisualBytes, secondRuntimeVersions, secondSemanticAndLayout);
  return {
    cachePurgedBetweenRuns: true,
    runtime: {
      assertion: "bit-identical",
      first: firstRuntimeVersions,
      second: secondRuntimeVersions,
    },
    semanticAndLayout: {
      assertion: "bit-identical",
      comparedFileCount: firstNames.length,
      firstSha256: sha256Bytes(firstSemanticAndLayout),
      secondSha256: sha256Bytes(secondSemanticAndLayout),
    },
    visual: {
      assertion: "bit-identical",
      comparedFileCount: firstNames.length,
      firstManifestSha256: visualManifestSha256(firstVisualBytes),
      secondManifestSha256: visualManifestSha256(secondVisualBytes),
    },
    runs: [firstRun, secondRun],
  };
}

function semanticAndLayoutBytes(records: readonly CaptureRecord[]): Buffer {
  const values = [...records]
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((record) => ({
      fileName: record.fileName,
      pixelDimensions: record.pixelDimensions,
      viewport: record.viewport,
      devicePixelRatio: record.devicePixelRatio,
      fixture: record.fixture,
      policy: record.policy,
      morphology: record.morphology,
      organization: record.organization,
      lodBand: record.lodBand,
      theme: record.theme,
      palette: record.palette,
      temperature: record.temperature,
      reducedMotion: record.reducedMotion,
      elapsedMilliseconds: record.elapsedMilliseconds,
      cameraState: record.cameraState,
      viewportPositions: Object.fromEntries(Object.entries(record.viewportPositions).sort(([left], [right]) => left.localeCompare(right))),
      aggregateWindowCount: record.aggregateWindowCount,
      focus: record.focus,
      calibration: record.calibration,
      productCommitSha: record.productCommitSha,
      d040Composition: record.measurements.d040Composition,
    }));
  return Buffer.from(JSON.stringify(values), "utf8");
}

function determinismRunWitness(
  sequence: 1 | 2,
  records: readonly CaptureRecord[],
  visualBytes: ReadonlyMap<string, Buffer>,
  runtimeVersions: RuntimeVersions,
  semanticAndLayout: Buffer,
): DeterminismRunWitness {
  return {
    sequence,
    runtimeVersions,
    semanticAndLayout: {
      sha256: sha256Bytes(semanticAndLayout),
      byteLength: semanticAndLayout.length,
    },
    visualFiles: [...records]
      .sort((left, right) => left.fileName.localeCompare(right.fileName))
      .map((record) => ({
        fileName: record.fileName,
        sha256: sha256Bytes(requiredItem(visualBytes, record.fileName, "visual capture bytes")),
      })),
  };
}

function visualManifestSha256(visualBytes: ReadonlyMap<string, Buffer>): string {
  const entries = [...visualBytes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileName, bytes]) => ({ fileName, sha256: sha256Bytes(bytes) }));
  return sha256Text(JSON.stringify(entries));
}

function assertDeterminismFailureControls(
  semanticAndLayout: Buffer,
  visualBytes: ReadonlyMap<string, Buffer>,
  runtimeVersions: RuntimeVersions,
): void {
  const changedSemanticAndLayout = Buffer.concat([semanticAndLayout, Buffer.from([0])]);
  expect(() => expect(
    changedSemanticAndLayout.equals(semanticAndLayout),
    "isolated semantic and layout control changes one byte",
  ).toBe(true)).toThrow();

  const visualFileName = requiredItem([...visualBytes.keys()].sort(), 0, "visual control capture name");
  const visual = requiredItem(visualBytes, visualFileName, "visual control capture bytes");
  const changedVisual = Buffer.from(visual);
  changedVisual[0] = (changedVisual[0] ?? 0) ^ 1;
  expect(() => expect(
    changedVisual.equals(visual),
    "isolated visual control changes one byte",
  ).toBe(true)).toThrow();

  const changedRuntime = { ...runtimeVersions, browser: `${runtimeVersions.browser} isolated-control` };
  expect(() => expect(
    changedRuntime,
    "isolated runtime control changes only the browser version",
  ).toEqual(runtimeVersions)).toThrow();
}

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
    measurements: measureImage(image, witness),
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

function emptyMetadata(productCommitSha: string): ReviewMetadata {
  return {
    schemaVersion: 1,
    suiteResult: {
      command: REVIEW_COMMAND,
      commitSha: productCommitSha,
      status: "NOT_RUN",
      completedProjects: [],
    },
    checks: [],
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
    determinism: {
      "review-dpr-1": null,
      "review-dpr-2": null,
    },
  };
}

async function loadMetadata(productCommitSha: string): Promise<ReviewMetadata> {
  const parsed = JSON.parse(await readFile(METADATA_FILE, "utf8")) as ReviewMetadata;
  if (
    parsed.schemaVersion !== 1
    || parsed.suiteResult.command !== REVIEW_COMMAND
    || parsed.suiteResult.commitSha !== productCommitSha
    || parsed.suiteResult.status !== "NOT_RUN"
    || parsed.suiteResult.completedProjects.length !== 1
    || parsed.suiteResult.completedProjects[0] !== "review-dpr-1"
    || parsed.records.length === 0
    || parsed.contactSheet === null
    || parsed.determinism["review-dpr-1"] === null
    || parsed.records.some((record) => record.productCommitSha !== productCommitSha)
  ) {
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

function measureImage(image: DecodedPng, witness: PageCaptureWitness): ImageMeasurements {
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
    filamentContinuity: measureFilamentContinuity(image, witness.filamentTrace),
    filamentCrossSection: witness.filamentCrossSection,
    d040Composition: witness.d040Composition,
  };
}

// Walks the traced filament's own centreline in device-pixel space, at
// roughly one sampled station per device pixel of arc length, and at each
// station searches bilinearly across a fixed perpendicular band for any
// non-background colour. A station only counts as background-only when every
// sample across the whole perpendicular band is background. Every planned
// sample point is checked against the decoded image's bounds before any
// pixel is read; if one falls outside the image the whole measurement is
// reported unavailable, with the reason, rather than a number computed from
// a partial or clamped scan.
function measureFilamentContinuity(image: DecodedPng, trace: FilamentTraceWitness): FilamentContinuityMeasurement {
  const devicePixelRatio = image.width / CAPTURE_WIDTH;
  const curve = toDeviceCurve(trace.curve, devicePixelRatio);
  const arcLengthTable = buildArcLengthTable(curve);
  const totalLength = arcLengthTable.cumulativeLengths.at(-1);
  if (totalLength === undefined || totalLength <= 0) {
    return { available: false, tracedFilamentId: trace.edgeId, reason: "filament centreline has no measurable arc length" };
  }
  const interiorMargin = totalLength * CONTINUITY_INTERIOR_MARGIN_FRACTION;
  const interiorLength = totalLength - (2 * interiorMargin);
  if (interiorLength <= 0) {
    return { available: false, tracedFilamentId: trace.edgeId, reason: "filament centreline is too short for an interior sample" };
  }
  const stationCount = Math.max(2, Math.round(interiorLength));
  const stations: DevicePoint[] = [];
  const stationNormals: DevicePoint[] = [];
  for (let index = 0; index <= stationCount; index += 1) {
    const arcLength = devicePixels(interiorMargin + ((interiorLength * index) / stationCount));
    const parameter = parameterAtArcLength(arcLengthTable, arcLength);
    stations.push(deviceQuadraticPoint(curve, parameter));
    stationNormals.push(unitNormal(trace.edgeId, deviceQuadraticTangent(curve, parameter)));
  }
  const perpendicularOffsets: DevicePixels[] = [];
  for (
    let offset = -CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS;
    offset <= CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS + (CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS / 2);
    offset += CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS
  ) {
    perpendicularOffsets.push(devicePixels(offset));
  }
  for (const [stationIndex, station] of stations.entries()) {
    const normal = requiredItem(stationNormals, stationIndex, "filament continuity normal");
    for (const offset of perpendicularOffsets) {
      const sampleX = devicePixels(station.x + (normal.x * offset));
      const sampleY = devicePixels(station.y + (normal.y * offset));
      if (!isOnCanvas(image, sampleX, sampleY)) {
        return {
          available: false,
          tracedFilamentId: trace.edgeId,
          reason: `station ${stationIndex} of ${stations.length} samples off-canvas at device pixel (${sampleX.toFixed(2)}, ${sampleY.toFixed(2)}) against a ${image.width}x${image.height} image`,
        };
      }
    }
  }
  const field = fieldPixel(image);
  let backgroundOnlyStationCount = 0;
  let currentRun = 0;
  let longestRun = 0;
  for (const [stationIndex, station] of stations.entries()) {
    const normal = requiredItem(stationNormals, stationIndex, "filament continuity normal");
    const backgroundOnly = perpendicularOffsets.every((offset) => {
      const sampleX = devicePixels(station.x + (normal.x * offset));
      const sampleY = devicePixels(station.y + (normal.y * offset));
      const [red, green, blue] = bilinearSample(image, sampleX, sampleY);
      return !isLitPixel(red, green, blue, field);
    });
    if (backgroundOnly) {
      backgroundOnlyStationCount += 1;
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return {
    available: true,
    tracedFilamentId: trace.edgeId,
    devicePixelRatio,
    nonBackgroundChannelMargin: LIT_PIXEL_CHANNEL_MARGIN,
    perpendicularSearchDevicePixels: CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS,
    sampledStationCount: stations.length,
    backgroundOnlyStationCount,
    longestBackgroundOnlyRunStations: longestRun,
  };
}

function cssPixels(value: number): CssPixels {
  return value as CssPixels;
}

function devicePixels(value: number): DevicePixels {
  return value as DevicePixels;
}

function cssToDevicePixels(value: CssPixels, devicePixelRatio: number): DevicePixels {
  return devicePixels(value * devicePixelRatio);
}

function toDeviceCurve(curve: FilamentTraceWitness["curve"], devicePixelRatio: number): DeviceCurve {
  const toDevicePoint = (point: ViewportPoint): DevicePoint => ({
    x: cssToDevicePixels(cssPixels(point.x), devicePixelRatio),
    y: cssToDevicePixels(cssPixels(point.y), devicePixelRatio),
  });
  return {
    source: toDevicePoint(curve.source),
    control: toDevicePoint(curve.control),
    target: toDevicePoint(curve.target),
  };
}

function deviceQuadraticPoint(curve: DeviceCurve, parameter: number): DevicePoint {
  const inverse = 1 - parameter;
  const blend = (source: DevicePixels, control: DevicePixels, target: DevicePixels): DevicePixels =>
    devicePixels((inverse * inverse * source) + (2 * inverse * parameter * control) + (parameter * parameter * target));
  return {
    x: blend(curve.source.x, curve.control.x, curve.target.x),
    y: blend(curve.source.y, curve.control.y, curve.target.y),
  };
}

function deviceQuadraticTangent(curve: DeviceCurve, parameter: number): DevicePoint {
  const inverse = 1 - parameter;
  const blend = (source: DevicePixels, control: DevicePixels, target: DevicePixels): DevicePixels =>
    devicePixels((2 * inverse * (control - source)) + (2 * parameter * (target - control)));
  return {
    x: blend(curve.source.x, curve.control.x, curve.target.x),
    y: blend(curve.source.y, curve.control.y, curve.target.y),
  };
}

function unitNormal(edgeId: string, tangent: DevicePoint): DevicePoint {
  const length = Math.hypot(tangent.x, tangent.y);
  if (length === 0) {
    throw new Error(`filament ${edgeId} has a degenerate centreline tangent`);
  }
  return { x: devicePixels(-tangent.y / length), y: devicePixels(tangent.x / length) };
}

type ArcLengthTable = {
  readonly parameters: readonly number[];
  readonly cumulativeLengths: readonly DevicePixels[];
};

function buildArcLengthTable(curve: DeviceCurve): ArcLengthTable {
  const parameters: number[] = [0];
  const cumulativeLengths: DevicePixels[] = [devicePixels(0)];
  let previous = deviceQuadraticPoint(curve, 0);
  let total = 0;
  for (let step = 1; step <= CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT; step += 1) {
    const parameter = step / CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT;
    const point = deviceQuadraticPoint(curve, parameter);
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    parameters.push(parameter);
    cumulativeLengths.push(devicePixels(total));
    previous = point;
  }
  return { parameters, cumulativeLengths };
}

function parameterAtArcLength(table: ArcLengthTable, targetLength: DevicePixels): number {
  const { parameters, cumulativeLengths } = table;
  let upperIndex = 1;
  while (upperIndex < cumulativeLengths.length - 1 && requiredItem(cumulativeLengths, upperIndex, "arc length") < targetLength) {
    upperIndex += 1;
  }
  const lowerLength = requiredItem(cumulativeLengths, upperIndex - 1, "arc length");
  const upperLength = requiredItem(cumulativeLengths, upperIndex, "arc length");
  const lowerParameter = requiredItem(parameters, upperIndex - 1, "arc length parameter");
  const upperParameter = requiredItem(parameters, upperIndex, "arc length parameter");
  const span = upperLength - lowerLength;
  const fraction = span === 0 ? 0 : (targetLength - lowerLength) / span;
  return lowerParameter + ((upperParameter - lowerParameter) * fraction);
}

function isOnCanvas(image: DecodedPng, x: DevicePixels, y: DevicePixels): boolean {
  return x >= 0 && x <= image.width - 1 && y >= 0 && y <= image.height - 1;
}

function bilinearSample(image: DecodedPng, x: DevicePixels, y: DevicePixels): readonly [number, number, number] {
  const lowerX = Math.floor(x);
  const lowerY = Math.floor(y);
  const upperX = Math.min(image.width - 1, lowerX + 1);
  const upperY = Math.min(image.height - 1, lowerY + 1);
  const fractionX = x - lowerX;
  const fractionY = y - lowerY;
  const channel = (index: number): number => {
    const topLeft = pixelChannel(image, lowerX, lowerY, index);
    const topRight = pixelChannel(image, upperX, lowerY, index);
    const bottomLeft = pixelChannel(image, lowerX, upperY, index);
    const bottomRight = pixelChannel(image, upperX, upperY, index);
    const top = topLeft + ((topRight - topLeft) * fractionX);
    const bottom = bottomLeft + ((bottomRight - bottomLeft) * fractionX);
    return top + ((bottom - top) * fractionY);
  };
  return [channel(0), channel(1), channel(2)];
}

function pixelChannel(image: DecodedPng, x: number, y: number, index: number): number {
  const offset = ((y * image.width) + x) * 4;
  return image.data[offset + index] ?? 0;
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
