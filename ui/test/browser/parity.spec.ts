import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import { fieldPixel, isLitPixel } from "#browser/filament-continuity.ts";
import type { DecodedPng } from "#browser/filament-continuity.ts";
import { assertLitPixelFloor } from "#browser/lit-floor.ts";
// One owner, in a module that touches no browser API. This constant and this assertion existed in
// BOTH files and only one copy was repaired; the surviving copy rejected legal camera differences
// for two full runs. Importing the PAGE module to share them instead crashed the suite at Node
// level and left the previous run's evidence to be misread as this run's result.
import {
  PROJECTION_DEPENDENT_SCENE_CHANNELS,
  assertGovernedPixelSampleLit,
  assertSceneCameraParity,
} from "#browser/parity-contract.ts";
import type { GovernedPixelSample } from "#browser/parity-contract.ts";
import { legalRenderedCombinations } from "#scene/index.ts";
import type { RenderedStateCarrier } from "#engine/contract.ts";
import type { SurfaceWitness } from "#engine/renderer-handle.ts";
import type {
  CameraLayoutCapabilityWitness,
  DeterminismSemanticWitness,
  FullAppCameraSwitchWitness,
  FullAppInteractionWitness,
  FullAppMountWitness,
  FullAppShutdownWitness,
  FullAppVisualStateRoundTripWitness,
  InteractionWitness,
  MountedParityWitness,
  NodePickWitness,
  ParityBrowserApi,
  ParityRenderer,
  RenderedStatePixelWitness,
  ZeroToleranceWitness,
} from "#browser/parity.ts";

// This spec must stay Node-side: the browser page module is bundled below and is
// loaded only after Playwright has navigated to the served document.
const PARITY_RENDERERS = ["sigma-2d", "r3f-2d", "r3f-3d"] as const satisfies readonly ParityRenderer[];

type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";
type CheckName = "P1 surface parity" | "P2 semantic-channel parity" | "P3 governed-state separation" | "P4 interaction and provenance" | "P5 drawing and picking" | "P6 camera switch" | "P7 determinism" | "P8 non-colour encoding" | "full-app-smoke";
type CheckKey = `${CheckName}/${ParityRenderer}`;
type Rgb = readonly [number, number, number];
type Deficiency = "deuteranopia" | "protanopia" | "tritanopia";

type PairwiseMatrix = {
  readonly labels: readonly string[];
  readonly valuesMicro: readonly (readonly number[])[];
};

type RenderedStateObservation = {
  readonly stateKey: string;
  readonly targetId: string;
  readonly sample: GovernedPixelSample;
  readonly frameLitPixels: number | null;
  readonly frameLitFloorFailure: string | null;
  readonly rgb: Rgb | null;
  readonly monochromeRgb: Rgb | null;
  readonly cvdRgb: Readonly<Record<Deficiency, Rgb>> | null;
};

type LitRenderedStateObservation = Omit<RenderedStateObservation, "rgb" | "monochromeRgb" | "cvdRgb"> & {
  readonly rgb: Rgb;
  readonly monochromeRgb: Rgb;
  readonly cvdRgb: Readonly<Record<Deficiency, Rgb>>;
};

type PixelDifference = {
  readonly id: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly differenceMicro: number;
};

type ControlResult = {
  readonly status: "FAILED_AS_EXPECTED" | "NOT_RUN";
  readonly output: string;
};

type ParityRecord = {
  readonly checkName: CheckName;
  readonly renderer: ParityRenderer;
  readonly status: Status;
  readonly measured: unknown;
  readonly threshold: unknown;
  readonly turnsRed: string;
  readonly commitSha: string;
  readonly control: ControlResult;
};

type ParityEvidence = {
  readonly schemaVersion: 1;
  readonly run: {
    readonly command: string;
    readonly commitSha: string;
    readonly observedAt: string;
    readonly pageModule: {
      readonly path: string;
      readonly sha256: string;
      readonly servedSha256: string | null;
    };
  };
  readonly summary: {
    readonly passing: boolean;
    readonly bound: boolean;
    readonly required: number;
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
    readonly unknown: number;
    readonly rule: string;
  };
  readonly checks: readonly ParityRecord[];
};

class MeasuredCheckFailure extends Error {
  readonly measured: unknown;

  constructor(failure: string, measured: unknown) {
    super(failure);
    this.measured = measured;
  }
}

const COMMAND = "npm --prefix ui exec playwright test --project=parity";
const ARTIFACT_FILE = ["dist", "evidence", "parity.json"].join("/");
const PAGE_MODULE_FILE = ["dist", "evidence", "parity.js"].join("/");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHECK_RENDERERS: readonly { readonly checkName: CheckName; readonly renderer: ParityRenderer }[] = [
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P1 surface parity" as const, renderer })),
  { checkName: "P2 semantic-channel parity", renderer: "r3f-2d" },
  { checkName: "P2 semantic-channel parity", renderer: "r3f-3d" },
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P3 governed-state separation" as const, renderer })),
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P4 interaction and provenance" as const, renderer })),
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P5 drawing and picking" as const, renderer })),
  { checkName: "P6 camera switch", renderer: "r3f-2d" },
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P7 determinism" as const, renderer })),
  ...PARITY_RENDERERS.map((renderer) => ({ checkName: "P8 non-colour encoding" as const, renderer })),
  { checkName: "full-app-smoke", renderer: "r3f-2d" },
  { checkName: "full-app-smoke", renderer: "r3f-3d" },
];
const CVD_MATRICES: Readonly<Record<Deficiency, readonly [Rgb, Rgb, Rgb]>> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};


function assertSurfaceParity(reference: SurfaceWitness, observed: SurfaceWitness, renderer: ParityRenderer): void {
  assertSameIdSet("P1 rendered node ids", reference.nodeIds, observed.nodeIds, renderer);
  assertSameIdSet("P1 rendered relation ids", reference.edgeIds, observed.edgeIds, renderer);
  for (const id of sortedIds(reference.edgeIds)) {
    const expected = reference.incidence[id];
    const actual = observed.incidence[id];
    if (expected === undefined || actual === undefined || expected.source !== actual.source || expected.target !== actual.target) {
      throw new Error(`P1 ${renderer} relation ${id} has incidence ${formatIncidence(actual)} instead of ${formatIncidence(expected)}`);
    }
  }
}

function assertSameIdSet(label: string, left: readonly string[], right: readonly string[], renderer: ParityRenderer): void {
  const expected = sortedIds(left);
  const actual = sortedIds(right);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`${label} differs for ${renderer}: expected [${expected.join(", ")}], observed [${actual.join(", ")}]`);
  }
}

function sortedIds(ids: readonly string[]): readonly string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function formatIncidence(value: { readonly source: string; readonly target: string } | undefined): string {
  return value === undefined ? "missing" : `${value.source}->${value.target}`;
}

function failingControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("control unexpectedly passed");
}

function derivedNonNullRenderedStateDomain(): readonly RenderedStateCarrier[] {
  const domain = legalRenderedCombinations().filter((carrier): carrier is Exclude<RenderedStateCarrier, null> => carrier !== null);
  if (domain.length !== 12) {
    throw new Error(`P3 derived legal non-null governed domain has ${domain.length} members instead of 12`);
  }
  return domain;
}

function renderedStateKey(carrier: RenderedStateCarrier): string {
  return carrier === null ? "null" : carrier.map((member) => `${member.enumType}.${member.member}`).join("+");
}

test("renderer parity oracle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "parity", "run this through the dedicated parity project");
  const consoleErrors: string[] = [];
  page.on("console", (entry) => {
    if (entry.type() === "error") {
      consoleErrors.push(entry.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });
  const commitSha = await currentCommitSha();
  const records = new Map<CheckKey, ParityRecord>();
  for (const { checkName, renderer } of CHECK_RENDERERS) {
    records.set(checkKey(checkName, renderer), pendingRecord(checkName, renderer, commitSha));
  }
  let pageModuleSha = "unavailable";
  let servedPageModuleSha: string | null = null;
  const writeEvidence = async (): Promise<void> => {
    await mkdir(["dist", "evidence"].join("/"), { recursive: true });
    const checks = [...records.values()].sort((left, right) => checkKey(left.checkName, left.renderer).localeCompare(checkKey(right.checkName, right.renderer)));
    const passed = checks.filter((record) => record.status === "PASS").length;
    const failed = checks.filter((record) => record.status === "FAIL").length;
    const notRun = checks.filter((record) => record.status === "NOT_RUN").length;
    const unknown = checks.filter((record) => record.status === "UNKNOWN").length;
    const bound = /^[0-9a-f]{40,64}$/i.test(commitSha)
      && checks.length === CHECK_RENDERERS.length
      && checks.every((record) => record.commitSha === commitSha);
    const evidence: ParityEvidence = {
      schemaVersion: 1,
      run: {
        command: COMMAND,
        commitSha,
        observedAt: new Date().toISOString(),
        pageModule: { path: PAGE_MODULE_FILE, sha256: pageModuleSha, servedSha256: servedPageModuleSha },
      },
      summary: {
        passing: bound && failed === 0 && notRun === 0 && unknown === 0 && passed === CHECK_RENDERERS.length,
        bound,
        required: CHECK_RENDERERS.length,
        passed,
        failed,
        notRun,
        unknown,
        rule: "The parity run passes only when every required check is commit-bound and PASS; NOT_RUN and UNKNOWN are counted separately and never aggregate into PASS.",
      },
      checks,
    };
    await writeFile(ARTIFACT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };
  const record = async (
    checkName: CheckName,
    renderer: ParityRenderer,
    body: () => Promise<{ readonly measured: unknown; readonly threshold: unknown; readonly turnsRed: string; readonly control: ControlResult }>,
  ): Promise<void> => {
    try {
      const result = await body();
      records.set(checkKey(checkName, renderer), {
        checkName,
        renderer,
        status: "PASS",
        measured: result.measured,
        threshold: result.threshold,
        turnsRed: result.turnsRed,
        commitSha,
        control: result.control,
      });
    } catch (error: unknown) {
      records.set(checkKey(checkName, renderer), {
        checkName,
        renderer,
        status: "FAIL",
        measured: error instanceof MeasuredCheckFailure
          ? { failure: error.message, evidence: error.measured }
          : message(error),
        threshold: "required measurement completed",
        turnsRed: "the renderer operation or assertion throws",
        commitSha,
        control: { status: "NOT_RUN", output: "check stopped before its control could execute" },
      });
    }
    await writeEvidence();
  };
  const notRun = async (
    checkName: CheckName,
    renderer: ParityRenderer,
    reason: string,
    threshold: unknown,
    turnsRed: string,
    control: ControlResult,
    measured: unknown,
  ): Promise<void> => {
    records.set(checkKey(checkName, renderer), {
      checkName,
      renderer,
      status: "NOT_RUN",
      measured,
      threshold,
      turnsRed,
      commitSha,
      control,
    });
    await writeEvidence();
  };

  await writeEvidence();
  await build({
    bundle: true,
    format: "esm",
    target: "es2022",
    entryPoints: [["test", "browser", "parity.ts"].join("/")],
    outfile: PAGE_MODULE_FILE,
  });
  pageModuleSha = createHash("sha256").update(await readFile(PAGE_MODULE_FILE)).digest("hex");
  await page.addInitScript(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.goto("/");
  const servedPageModule = page.waitForResponse((response) => new URL(response.url()).pathname === "/" + ["ui", "dist", "evidence", "parity.js"].join("/"));
  await page.setContent("<script type=\"module\" src=\"ui/dist/evidence/parity.js\"></script>");
  try {
    servedPageModuleSha = createHash("sha256").update(await (await servedPageModule).body()).digest("hex");
  } catch {
    servedPageModuleSha = null;
  }
  await writeEvidence();
  const api = async (): Promise<ParityBrowserApi> => page.evaluate(() => {
    const value = window.__parity;
    if (value === undefined) {
      throw new Error("parity page module is unavailable");
    }
    return value;
  });
  const invoke = async <Value>(method: keyof ParityBrowserApi, ...arguments_: readonly unknown[]): Promise<Value> => page.evaluate(async ({ method: name, arguments_: values }) => {
    const value = window.__parity as unknown as Record<string, (...items: readonly unknown[]) => unknown> | undefined;
    const operation = value?.[name];
    if (operation === undefined) {
      throw new Error(`parity page operation ${name} is unavailable`);
    }
    return await operation(...values) as Value;
  }, { method, arguments_ });
  try {
  await expect.poll(async () => (await api()).ready).toBe(true);
  expect((await api()).errors).toEqual([]);

  const mounted = await invoke<readonly MountedParityWitness[]>("mountAll");
  const sigmaSurface = requiredItem(mounted, 0, "P1 sigma witness").surface;
  const p1Control = failingControlOutput(() => assertSurfaceParity(sigmaSurface, {
    ...sigmaSurface,
    nodeIds: [...sigmaSurface.nodeIds, "p1-control-missing-node"],
  }, "r3f-2d"));
  for (const witness of mounted) {
    await record("P1 surface parity", witness.renderer, async () => {
      if (witness.renderer === "sigma-2d") {
        assertSurfaceSelfConsistency(witness.surface);
      } else {
        assertSurfaceParity(sigmaSurface, witness.surface, witness.renderer);
      }
      return {
        measured: witness.surface,
        threshold: "exact node-id set, exact relation-id set, exact source/target incidence",
        turnsRed: "a live node id, relation id, or source/target incidence differs from Sigma's mounted surface",
        control: { status: "FAILED_AS_EXPECTED", output: p1Control },
      };
    });
  }

  const p2 = await invoke<{ readonly differences: readonly string[]; readonly negativeControlOutput: string }>("readSceneCameraParity");
  for (const renderer of ["r3f-2d", "r3f-3d"] as const) {
    await record("P2 semantic-channel parity", renderer, async () => {
      assertSceneCameraParity(p2.differences);
      return {
        measured: { differingChannels: p2.differences, legalProjectionChannels: PROJECTION_DEPENDENT_SCENE_CHANNELS },
        threshold: "only the non-empty pinned projection-dependent channel list may differ",
        turnsRed: "any resolved scene channel outside the pinned list differs, or camera.kind itself is absent",
        control: { status: "FAILED_AS_EXPECTED", output: p2.negativeControlOutput },
      };
    });
  }

  const p3Observations = new Map<ParityRenderer, readonly LitRenderedStateObservation[]>();
  const domain = derivedNonNullRenderedStateDomain();
  const nonHueThreshold = DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro;
  const cvdThreshold = DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro;
  for (const renderer of PARITY_RENDERERS) {
    let observations: RenderedStateObservation[];
    try {
      observations = [];
      for (let index = 0; index < domain.length; index += 1) {
        const witness = await invoke<RenderedStatePixelWitness>("renderLegalState", renderer, index);
        const image = await captureRenderer(page, renderer);
        let frameLitPixels: number | null = null;
        let frameLitFloorFailure: string | null = null;
        try {
          frameLitPixels = assertLitPixelFloor(image, `P3 ${renderer} ${witness.stateKey} final compositor capture`).litPixels;
        } catch (error: unknown) {
          frameLitFloorFailure = message(error);
        }
        const sample = governedPixelSampleAt(image, witness.point, witness.devicePixelRatio);
        const rgb = sample.sampledRgb === null ? null : normalisedRgb(sample.sampledRgb);
        const monochromeRgb = sample.sampledRgb === null
          ? null
          : rgbAtDevice(transformImage(image, monochrome), sample.pointDevice.x, sample.pointDevice.y);
        const cvdRgb = sample.sampledRgb === null
          ? null
          : Object.fromEntries((Object.keys(CVD_MATRICES) as Deficiency[]).map((deficiency) => [
              deficiency,
              rgbAtDevice(
                transformImage(image, (value) => simulateCvd(value, deficiency)),
                sample.pointDevice.x,
                sample.pointDevice.y,
              ),
            ])) as Readonly<Record<Deficiency, Rgb>>;
        observations.push({
          stateKey: witness.stateKey,
          targetId: witness.targetId,
          sample,
          frameLitPixels,
          frameLitFloorFailure,
          rgb,
          monochromeRgb,
          cvdRgb,
        });
      }
      assertSameStrings(observations.map((observation) => observation.stateKey), domain.map(renderedStateKey), "P3 observed derived domain");
    } catch (error: unknown) {
      const captureFailure = error;
      await record("P3 governed-state separation", renderer, async () => {
        throw captureFailure;
      });
      continue;
    }

    const litObservations: LitRenderedStateObservation[] = [];
    const notRunReasons: string[] = [];
    for (const observation of observations) {
      try {
        litObservations.push(requireLitRenderedStateObservation(observation, renderer));
      } catch (error: unknown) {
        notRunReasons.push(message(error));
      }
    }
    const controlSample = requiredItem(observations, 0, "P3 field-landing control source").sample;
    const fieldLandingControl = failingControlOutput(() => assertGovernedPixelSampleLit({
      ...controlSample,
      sampledRgb: controlSample.fieldRgb,
    }, `P3 ${renderer} deliberate field-landing control`));
    if (notRunReasons.length > 0) {
      const reason = `P3 ${renderer} has unmeasured governed witnesses: ${notRunReasons.join("; ")}`;
      await notRun(
        "P3 governed-state separation",
        renderer,
        reason,
        {
          everyWitness: "sampled pixel is lit under the established predicate and its frame clears the shared lit-pixel floor",
          nonHueMinimumMicro: nonHueThreshold,
          cvdMinimumMicro: cvdThreshold,
        },
        "a governed witness is off-capture or lands on the field, or a measured pair is below either unchanged governed threshold",
        { status: "FAILED_AS_EXPECTED", output: fieldLandingControl },
        { reason, domain: observations.map(p3ObservationEvidence) },
      );
      continue;
    }

    await record("P3 governed-state separation", renderer, async () => {
      const nonHue = pairwiseMatrix(litObservations, (observation) => observation.rgb, grayscaleDistanceMicro);
      const cvd = Object.fromEntries((Object.keys(CVD_MATRICES) as Deficiency[]).map((deficiency) => [
        deficiency,
        pairwiseMatrix(litObservations, (observation) => observation.cvdRgb[deficiency], rgbDistanceMicro),
      ])) as Readonly<Record<Deficiency, PairwiseMatrix>>;
      const measured = { domain: litObservations.map(p3ObservationEvidence), nonHue, cvd };
      try {
        assertMatrixAtLeast(nonHue, nonHueThreshold, "P3 non-hue");
        for (const deficiency of Object.keys(cvd) as Deficiency[]) {
          assertMatrixAtLeast(cvd[deficiency], cvdThreshold, `P3 ${deficiency}`);
        }
      } catch (error: unknown) {
        throw new MeasuredCheckFailure(message(error), measured);
      }
      const thresholdControl = failingControlOutput(() => assertMatrixAtLeast(nonHue, maximumMatrixValue(nonHue) + 1, "P3 unattainable-threshold control"));
      p3Observations.set(renderer, litObservations);
      return {
        measured,
        threshold: {
          everyWitness: "sampled pixel is lit under the established predicate and its frame clears the shared lit-pixel floor",
          nonHueMinimumMicro: nonHueThreshold,
          cvdMinimumMicro: cvdThreshold,
        },
        turnsRed: "a governed witness is off-capture or lands on the field, or a measured pair is below either unchanged governed threshold",
        control: { status: "FAILED_AS_EXPECTED", output: `${fieldLandingControl} | ${thresholdControl}` },
      };
    });
  }

  for (const renderer of PARITY_RENDERERS) {
    await record("P4 interaction and provenance", renderer, async () => {
      const interaction = await invoke<InteractionWitness>("prepareInteraction", renderer);
      const before = await captureRenderer(page, renderer);
      await invoke<void>("select", renderer, interaction.selectedId);
      const selected = await captureRenderer(page, renderer);
      const selectedFootprint = await invoke<InteractionWitness["selectedFootprint"]>("footprint", renderer, interaction.selectedId);
      const selectionDifference = greatestPixelDifference(before, selected, interaction.selectedId, selectedFootprint);
      assertPixelDifference(selectionDifference, "P4 selection");
      const provenance = await invoke<InteractionWitness["provenance"]>("selectedProvenance", renderer);
      assertSelectedProvenance(provenance);
      await invoke<void>("clearSelection", renderer);
      await invoke<void>("focus", renderer, interaction.selectedId);
      const focused = await captureRenderer(page, renderer);
      const focusDifference = greatestPixelDifference(before, focused, interaction.outsideFocusId, interaction.outsideFocusFootprint);
      assertPixelDifference(focusDifference, "P4 focus dimming");
      await invoke<void>("clearFocus", renderer);
      const p4Control = [
        failingControlOutput(() => assertPixelDifference({ ...selectionDifference, differenceMicro: 0 }, "P4 zero-difference control")),
        failingControlOutput(() => assertSelectedProvenance({ value: null, origin: "" })),
      ].join(" | ");
      return {
        measured: { selectionDifference, focusDifference, provenanceOrigin: provenance?.origin ?? null },
        threshold: "per-id final-compositor pixel difference greater than zero; non-empty selected provenance origin",
        turnsRed: "selection does not alter its element pixels, focus does not dim a non-focused element pixel, or selected provenance has no origin",
        control: { status: "FAILED_AS_EXPECTED", output: p4Control },
      };
    });
  }

  const p5Samples = new Map<ParityRenderer, readonly NodePickWitness[]>();
  for (const renderer of PARITY_RENDERERS) {
    await record("P5 drawing and picking", renderer, async () => {
      await invoke<MountedParityWitness>("mountBase", renderer);
      const image = await captureRenderer(page, renderer);
      const litPixels = assertLitPixelFloor(image, `P5 ${renderer} final compositor capture`);
      const samples = await invoke<readonly NodePickWitness[]>("nodePickSamples", renderer, 3);
      if (samples.length === 0) {
        throw new Error(`P5 ${renderer} has no node samples`);
      }
      for (const sample of samples) {
        if (sample.pickedId !== sample.id) {
          throw new Error(`P5 ${renderer} picked ${sample.pickedId ?? "null"} at projected ${sample.id}`);
        }
        const x = Math.round(sample.point.x * (image.width / 1200));
        const y = Math.round(sample.point.y * (image.height / 800));
        const pixel = rgbAtDevice(image, x, y);
        if (!isLitPixel(Math.round(pixel[0] * 255), Math.round(pixel[1] * 255), Math.round(pixel[2] * 255), fieldPixel(image))) {
          throw new Error(`P5 ${renderer} projected ${sample.id} is not lit at its pick point`);
        }
      }
      p5Samples.set(renderer, samples);
      const zeroTolerance = await invoke<ZeroToleranceWitness>("mountZeroToleranceControl", renderer);
      const p5Control = failingControlOutput(() => assertPositivePickTolerance(zeroTolerance.configuredPickTolerancePx));
      return {
        measured: { samples, zeroTolerance, litPixels },
        threshold: "final compositor frame clears the shared lit-pixel floor; renderer pick returns the renderer-projected drawn node id; configured pick tolerance is greater than zero",
        turnsRed: "the final compositor frame is blank, a renderer-projected node is not lit, does not pick itself, or the zero-tolerance control is accepted",
        control: { status: "FAILED_AS_EXPECTED", output: p5Control },
      };
    });
  }
  const sigmaSamples = p5Samples.get("sigma-2d");
  if (sigmaSamples !== undefined) {
    await record("P5 drawing and picking", "r3f-2d", async () => {
      await invoke<MountedParityWitness>("mountBase", "r3f-2d");
      const crossPicked = await Promise.all(sigmaSamples.map(async (sample) => ({ id: sample.id, pickedId: await invoke<string | null>("pickNodeAt", "r3f-2d", sample.point) })));
      for (const sample of crossPicked) {
        if (sample.pickedId !== sample.id) {
          throw new Error(`P5 r3f-2d picked ${sample.pickedId ?? "null"} where sigma-2d picked ${sample.id}`);
        }
      }
      const own = p5Samples.get("r3f-2d") ?? [];
      return {
        measured: { own, crossRendererAtSigmaPositions: crossPicked },
        threshold: "Sigma-2D and r3f-2d return the same id at Sigma's viewport position",
        turnsRed: "r3f-2d returns a different id or null at a Sigma-2D projected pick point",
        control: { status: "FAILED_AS_EXPECTED", output: failingControlOutput(() => assertPositivePickTolerance(0)) },
      };
    });
  }

  const p6Capability = await invoke<CameraLayoutCapabilityWitness>("readCameraLayoutCapability");
  const p6Control = failingControlOutput(() => assertWorldAnchorsEqual([{ id: "control", x: 0, y: 0, z: 0 }], [{ id: "control", x: 1, y: 0, z: 0 }]));
  if (p6Capability.missingMethods.length > 0) {
    await notRun(
      "P6 camera switch",
      "r3f-2d",
      `P6 cannot record live world anchors or layout passes: missing GraphRendererHandle ${p6Capability.missingMethods.join(", ")}`,
      "all live world anchors unchanged; layout pass count unchanged; camera kind round-trips",
      "any live world anchor moves, layout pass count changes, or camera kind fails to round-trip",
      { status: "FAILED_AS_EXPECTED", output: p6Control },
      { reason: `missing ${p6Capability.missingMethods.join(", ")}` },
    );
  } else {
    await record("P6 camera switch", "r3f-2d", async () => {
      await invoke<MountedParityWitness>("mountBase", "r3f-2d");
      const forward = await invoke<FullAppCameraSwitchWitness>("switchFullAppCamera", "r3f-2d", PERSPECTIVE);
      assertFullAppCameraSwitch(forward, PERSPECTIVE, "P6 forward camera switch");
      const reverse = await invoke<FullAppCameraSwitchWitness>("switchFullAppCamera", "r3f-2d", ORTHOGRAPHIC);
      assertFullAppCameraSwitch(reverse, ORTHOGRAPHIC, "P6 reverse camera switch");
      const layoutControl = failingControlOutput(() => assertFullAppCameraSwitch({
        ...forward,
        after: { ...forward.after, layoutPassCount: forward.after.layoutPassCount + 1 },
      }, PERSPECTIVE, "P6 layout control"));
      return {
        measured: { forward, reverse },
        threshold: "both camera directions preserve every live world anchor and the layout-pass count, and report the requested camera kind",
        turnsRed: "either camera direction moves an anchor, changes the layout-pass count, or reports a different camera kind",
        control: { status: "FAILED_AS_EXPECTED", output: `${p6Control} | ${layoutControl}` },
      };
    });
  }

  for (const renderer of PARITY_RENDERERS) {
    const p7Control = failingControlOutput(() => assertBitIdentical("P7 control", "first", "second"));
    if (p6Capability.missingMethods.length > 0) {
      await notRun(
        "P7 determinism",
        renderer,
        `P7 cannot assert the required live semantic/layout layer: missing GraphRendererHandle ${p6Capability.missingMethods.join(", ")}`,
        "two purged runs are bit-identical separately for live semantic/layout and compositor captures",
        "either live semantic/layout bytes or final compositor bytes differ between the two purged runs",
        { status: "FAILED_AS_EXPECTED", output: p7Control },
        { visualLayer: "not evaluated because the required semantic/layout layer is unavailable" },
      );
      continue;
    }
    await record("P7 determinism", renderer, async () => {
      await purgeBrowserCache(page);
      const firstSemantic = await invoke<DeterminismSemanticWitness>("readDeterminismSemanticWitness", renderer);
      const firstImage = await captureRenderer(page, renderer);
      await invoke<void>("destroy");
      await purgeBrowserCache(page);
      const secondSemantic = await invoke<DeterminismSemanticWitness>("readDeterminismSemanticWitness", renderer);
      const secondImage = await captureRenderer(page, renderer);
      const firstSemanticBytes = JSON.stringify(firstSemantic);
      const secondSemanticBytes = JSON.stringify(secondSemantic);
      assertBitIdentical("P7 semantic/layout", firstSemanticBytes, secondSemanticBytes);
      assertBitIdentical("P7 visual", firstImage.hash, secondImage.hash);
      return {
        measured: {
          semanticLayout: hashes(firstSemanticBytes, secondSemanticBytes),
          visual: { firstSha256: firstImage.hash, secondSha256: secondImage.hash, bitIdentical: firstImage.hash === secondImage.hash },
        },
        threshold: "byte-for-byte equality after purging renderer state between runs",
        turnsRed: "the separately compared live semantic/layout witness bytes or composited screenshot bytes differ",
        control: { status: "FAILED_AS_EXPECTED", output: p7Control },
      };
    });
  }

  for (const renderer of PARITY_RENDERERS) {
    const observations = p3Observations.get(renderer);
    if (observations === undefined) {
      await notRun(
        "P8 non-colour encoding",
        renderer,
        "P8 needs the P3 final-compositor captures, which were unavailable",
        "all P3 distinctions survive monochrome and every CVD transform",
        "any transformed pair is below its unchanged P3 threshold",
        { status: "NOT_RUN", output: "P3 observations were unavailable" },
        { reason: "P3 observations unavailable" },
      );
      continue;
    }
    await record("P8 non-colour encoding", renderer, async () => {
      const monochromeMatrix = pairwiseMatrix(observations, (observation) => observation.monochromeRgb, grayscaleDistanceMicro);
      const cvdMatrices = Object.fromEntries((Object.keys(CVD_MATRICES) as Deficiency[]).map((deficiency) => [
        deficiency,
        pairwiseMatrix(observations, (observation) => observation.cvdRgb[deficiency], rgbDistanceMicro),
      ])) as Readonly<Record<Deficiency, PairwiseMatrix>>;
      assertMatrixAtLeast(monochromeMatrix, DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro, "P8 monochrome");
      for (const deficiency of Object.keys(cvdMatrices) as Deficiency[]) {
        assertMatrixAtLeast(cvdMatrices[deficiency], DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro, `P8 ${deficiency}`);
      }
      const hueOnly = hueOnlyControlObservations();
      const p8Control = failingControlOutput(() => assertMatrixAtLeast(
        pairwiseMatrix(hueOnly, (observation) => monochrome(observation.rgb), grayscaleDistanceMicro),
        DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro,
        "P8 hue-only control",
      ));
      return {
        measured: { monochrome: monochromeMatrix, cvd: cvdMatrices },
        threshold: {
          monochromeMinimumMicro: DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro,
          cvdMinimumMicro: DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro,
        },
        turnsRed: "a governed distinction disappears after a monochrome or CVD transform of its captured compositor frame",
        control: { status: "FAILED_AS_EXPECTED", output: p8Control },
      };
    });
  }

  for (const renderer of ["r3f-2d", "r3f-3d"] as const) {
    await record("full-app-smoke", renderer, async () => {
      const launch = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "micro", true);
      assertFullAppMount(launch, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", true, "launch");
      const reliability = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Reliability", "micro", true);
      assertFullAppMount(reliability, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", true, "Reliability policy switch");
      const discovery = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "micro", true);
      assertFullAppMount(discovery, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", true, "Discovery policy switch");
      assertFullAppPolicySwitch(launch, reliability, discovery);

      const alternateCamera = discovery.visualState.cameraKind === ORTHOGRAPHIC ? PERSPECTIVE : ORTHOGRAPHIC;
      const forwardCamera = await invoke<FullAppCameraSwitchWitness>("switchFullAppCamera", renderer, alternateCamera);
      assertFullAppCameraSwitch(forwardCamera, alternateCamera, "forward camera switch");
      const reverseCamera = await invoke<FullAppCameraSwitchWitness>("switchFullAppCamera", renderer, forwardCamera.before.visualState.cameraKind);
      assertFullAppCameraSwitch(reverseCamera, forwardCamera.before.visualState.cameraKind, "return camera switch");

      const interaction = await invoke<FullAppInteractionWitness>("prepareFullAppInteraction", renderer);
      const beforeSelection = await captureRenderer(page, renderer);
      await invoke<void>("select", renderer, interaction.selectedId);
      const selected = await invoke<FullAppMountWitness>("readFullAppState", renderer);
      assertFullAppSelection(selected, interaction.selectedId, "selection");
      const selectedImage = await captureRenderer(page, renderer);
      const selectionDifference = greatestPixelDifference(beforeSelection, selectedImage, interaction.selectedId, interaction.selectedFootprint);
      assertPixelDifference(selectionDifference, "full-app selection");
      const provenance = await invoke<InteractionWitness["provenance"]>("selectedProvenance", renderer);
      assertFullAppProvenance(provenance);
      await invoke<void>("focus", renderer, interaction.selectedId);
      const focused = await invoke<FullAppMountWitness>("readFullAppState", renderer);
      assertFullAppFocus(focused, interaction.selectedId, "focus");
      const focusedImage = await captureRenderer(page, renderer);
      const focusDifference = greatestPixelDifference(selectedImage, focusedImage, interaction.outsideFocusId, interaction.outsideFocusFootprint);
      assertPixelDifference(focusDifference, "full-app focus");
      await invoke<void>("clearFocus", renderer);
      const focusCleared = await invoke<FullAppMountWitness>("readFullAppState", renderer);
      assertFullAppFocus(focusCleared, null, "clear focus");
      await invoke<void>("clearSelection", renderer);
      const selectionCleared = await invoke<FullAppMountWitness>("readFullAppState", renderer);
      assertFullAppSelection(selectionCleared, null, "clear selection");

      const macro = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "macro", true);
      assertFullAppMount(macro, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "macro", true, "macro semantic zoom");
      const meso = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "meso", true);
      assertFullAppMount(meso, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "meso", true, "meso semantic zoom");
      const micro = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "micro", true);
      assertFullAppMount(micro, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", true, "micro semantic zoom");
      const moving = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "micro", false);
      assertFullAppMount(moving, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", false, "reduced-motion disabled");
      const reduced = await invoke<FullAppMountWitness>("mountFullAppState", renderer, "Discovery", "micro", true);
      assertFullAppMount(reduced, renderer === "r3f-2d" ? ORTHOGRAPHIC : PERSPECTIVE, "micro", true, "reduced-motion enabled");

      const originalFrame = await captureRenderer(page, renderer);
      const roundTrip = await invoke<FullAppVisualStateRoundTripWitness>("restoreFullAppVisualState", renderer);
      const restoredFrame = await captureRenderer(page, renderer);
      assertFullAppRoundTrip(roundTrip);
      assertZeroPixelDifference(countDifferingPixels(originalFrame, restoredFrame), "full-app restored VisualState frame");

      const errorsBeforeShutdown = (await api()).errors;
      assertNoFullAppErrors(errorsBeforeShutdown, consoleErrors);
      const shutdown = await invoke<FullAppShutdownWitness>("shutdownFullApp");
      assertFullAppShutdown(shutdown);
      const errorsAfterShutdown = (await api()).errors;
      assertNoFullAppErrors(errorsAfterShutdown, consoleErrors);

      const controls = {
        launch: failingControlOutput(() => assertFullAppMount({ ...launch, surface: { ...launch.surface, nodeIds: [] }, footprints: [] }, launch.visualState.cameraKind, "micro", true, "launch control")),
        policy: failingControlOutput(() => assertFullAppPolicySwitch(launch, launch, discovery)),
        cameraForward: failingControlOutput(() => assertFullAppCameraSwitch({
          ...forwardCamera,
          after: { ...forwardCamera.after, layoutPassCount: forwardCamera.after.layoutPassCount + 1 },
        }, alternateCamera, "camera layout control")),
        cameraReverse: failingControlOutput(() => assertFullAppCameraSwitch({
          ...reverseCamera,
          after: { ...reverseCamera.after, anchors: [] },
        }, reverseCamera.before.visualState.cameraKind, "camera anchor control")),
        selection: failingControlOutput(() => assertFullAppSelection({ ...selected, visualState: { ...selected.visualState, selectedId: null } }, interaction.selectedId, "selection control")),
        selectionPixels: failingControlOutput(() => assertPixelDifference({ ...selectionDifference, differenceMicro: 0 }, "selection pixel control")),
        provenance: failingControlOutput(() => assertFullAppProvenance({ value: null, origin: "" })),
        focus: failingControlOutput(() => assertFullAppFocus({ ...focused, visualState: { ...focused.visualState, focusedId: null } }, interaction.selectedId, "focus control")),
        focusPixels: failingControlOutput(() => assertPixelDifference({ ...focusDifference, differenceMicro: 0 }, "focus pixel control")),
        macro: failingControlOutput(() => assertFullAppMount({ ...macro, visualState: { ...macro.visualState, lodBand: "meso" } }, macro.visualState.cameraKind, "macro", true, "macro control")),
        meso: failingControlOutput(() => assertFullAppMount({ ...meso, visualState: { ...meso.visualState, lodBand: "micro" } }, meso.visualState.cameraKind, "meso", true, "meso control")),
        micro: failingControlOutput(() => assertFullAppMount({ ...micro, visualState: { ...micro.visualState, lodBand: "macro" } }, micro.visualState.cameraKind, "micro", true, "micro control")),
        reducedMotion: failingControlOutput(() => assertFullAppMount({ ...reduced, visualState: { ...reduced.visualState, reducedMotion: false } }, reduced.visualState.cameraKind, "micro", true, "reduced-motion control")),
        roundTrip: failingControlOutput(() => assertFullAppRoundTrip({ ...roundTrip, restoredPickedNodeId: null })),
        restoredFrame: failingControlOutput(() => assertZeroPixelDifference(1, "restored frame control")),
        runtimeErrors: failingControlOutput(() => assertNoFullAppErrors(["runtime control"], [])),
        shutdown: failingControlOutput(() => assertFullAppShutdown({ ...shutdown, canvases: 1 })),
      };
      return {
        measured: {
          launch,
          policySwitch: { reliability, discovery },
          cameraSwitch: { forward: forwardCamera, reverse: reverseCamera },
          selection: { state: selected.visualState.selectedId, selectionDifference },
          focus: { state: focused.visualState.focusedId, focusDifference },
          provenance,
          semanticZoom: { macro: macro.visualState.lodBand, meso: meso.visualState.lodBand, micro: micro.visualState.lodBand },
          reducedMotion: { moving: moving.visualState.reducedMotion, reduced: reduced.visualState.reducedMotion },
          visualStateRoundTrip: roundTrip,
          runtimeErrors: { beforeShutdown: errorsBeforeShutdown, afterShutdown: errorsAfterShutdown, console: consoleErrors },
          shutdown,
          controls,
        },
        threshold: "both R3F camera boots report their live camera kind and graph; policy surfaces change and restore; each camera direction preserves live anchors and layout count; selection and focus change composited pixels; provenance has a value and non-empty origin; macro, meso, micro, and reduced motion are renderer-reported; serialised VisualState restores an identical frame and live pick target; errors, canvases, label overlays, and post-shutdown frames are zero",
        turnsRed: "a mounted state differs from the renderer-reported transition, a policy surface does not switch and restore, either camera direction moves anchors or runs layout, interaction lacks compositor change or provenance, a zoom or motion value is not reported, a restored frame or live pick differs, an error occurs, or shutdown leaves a canvas, label overlay, or fired frame",
        control: { status: "FAILED_AS_EXPECTED", output: formatControlOutputs(controls) },
      };
    });
  }

  } catch (error: unknown) {
    const reason = `parity execution stopped before this check could run: ${message(error)}`;
    for (const [key, pending] of records) {
      if (pending.status === "NOT_RUN" && pending.control.output === "control not started") {
        records.set(key, {
          ...pending,
          measured: { reason },
          threshold: "required measurement was not reached",
          turnsRed: "the page module or a prerequisite operation failed",
          control: { status: "NOT_RUN", output: reason },
        });
      }
    }
  } finally {
    try {
      await invoke<void>("destroy");
    } catch {
      // The failed-page evidence already records the reason; teardown must not erase it.
    }
    await writeEvidence();
  }
  const incomplete = [...records.values()].filter((item) => item.status !== "PASS");
  expect(incomplete, "renderer parity requires every commit-bound check to pass; NOT_RUN is never a pass").toEqual([]);
});

function pendingRecord(checkName: CheckName, renderer: ParityRenderer, commitSha: string): ParityRecord {
  return {
    checkName,
    renderer,
    status: "NOT_RUN",
    measured: { reason: "check not started" },
    threshold: "pending execution",
    turnsRed: "check did not run",
    commitSha,
    control: { status: "NOT_RUN", output: "control not started" },
  };
}

function checkKey(checkName: CheckName, renderer: ParityRenderer): CheckKey {
  return `${checkName}/${renderer}`;
}

function assertSurfaceSelfConsistency(surface: MountedParityWitness["surface"]): void {
  if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
    throw new Error("P1 sigma-2d mounted surface is empty");
  }
  if (new Set(surface.nodeIds).size !== surface.nodeIds.length || new Set(surface.edgeIds).size !== surface.edgeIds.length) {
    throw new Error("P1 sigma-2d mounted surface repeats an id");
  }
  for (const id of surface.edgeIds) {
    const incidence = surface.incidence[id];
    if (incidence === undefined || incidence.source === "" || incidence.target === "") {
      throw new Error(`P1 sigma-2d has no complete live incidence for ${id}`);
    }
  }
}

function assertFullAppMount(
  witness: FullAppMountWitness,
  expectedCameraKind: CameraKind,
  expectedLodBand: FullAppMountWitness["visualState"]["lodBand"],
  expectedReducedMotion: boolean,
  label: string,
): void {
  assertFullAppGraphPresent(witness, label);
  if (witness.visualState.cameraKind !== expectedCameraKind) {
    throw new Error(`${label} renderer reported camera ${witness.visualState.cameraKind} instead of ${expectedCameraKind}`);
  }
  if (witness.visualState.lodBand !== expectedLodBand) {
    throw new Error(`${label} renderer reported LOD ${witness.visualState.lodBand} instead of ${expectedLodBand}`);
  }
  if (witness.visualState.reducedMotion !== expectedReducedMotion) {
    throw new Error(`${label} renderer reported reducedMotion=${witness.visualState.reducedMotion} instead of ${expectedReducedMotion}`);
  }
}

function assertFullAppGraphPresent(witness: FullAppMountWitness, label: string): void {
  if (witness.surface.nodeIds.length === 0 || witness.surface.edgeIds.length === 0 || witness.footprints.length === 0) {
    throw new Error(`${label} mounted renderer did not report a non-empty graph surface and node footprints`);
  }
  const renderedNodeIds = new Set(witness.surface.nodeIds);
  if (witness.footprints.some((footprint) => !renderedNodeIds.has(footprint.id))) {
    throw new Error(`${label} renderer reported a node footprint outside its live surface`);
  }
  // Only a renderer that claims the capability is held to it. A renderer whose graphics resources
  // are owned inside a library it does not control reports none, and asserting an empty set against
  // that absence would fail it for a question it never claimed to answer.
  const retained = witness.retainedResources;
  if (retained !== null && (retained.geometries <= 0 || retained.materials <= 0 || retained.textures <= 0)) {
    throw new Error(`${label} renderer claims to enumerate graphics resources but reported an empty set`);
  }
}

function assertFullAppPolicySwitch(
  discovery: FullAppMountWitness,
  reliability: FullAppMountWitness,
  restoredDiscovery: FullAppMountWitness,
): void {
  if (sameSurface(discovery.surface, reliability.surface)) {
    throw new Error("Reliability policy switch did not change the live mounted surface");
  }
  assertSurfaceParity(discovery.surface, restoredDiscovery.surface, restoredDiscovery.renderer);
}

function assertFullAppCameraSwitch(witness: FullAppCameraSwitchWitness, target: CameraKind, label: string): void {
  if (witness.before.visualState.cameraKind === target) {
    throw new Error(`${label} began on requested camera ${target}`);
  }
  if (witness.after.visualState.cameraKind !== target) {
    throw new Error(`${label} renderer reported camera ${witness.after.visualState.cameraKind} instead of ${target}`);
  }
  if (witness.before.layoutPassCount !== witness.after.layoutPassCount) {
    throw new Error(`${label} changed layout pass count from ${witness.before.layoutPassCount} to ${witness.after.layoutPassCount}`);
  }
  if (JSON.stringify(witness.before.anchors) !== JSON.stringify(witness.after.anchors)) {
    throw new Error(`${label} moved a live mounted world anchor`);
  }
}

function assertFullAppSelection(witness: FullAppMountWitness, expected: string | null, label: string): void {
  if (witness.visualState.selectedId !== expected) {
    throw new Error(`${label} renderer reported selected id ${witness.visualState.selectedId ?? "null"} instead of ${expected ?? "null"}`);
  }
}

function assertFullAppFocus(witness: FullAppMountWitness, expected: string | null, label: string): void {
  if (witness.visualState.focusedId !== expected) {
    throw new Error(`${label} renderer reported focused id ${witness.visualState.focusedId ?? "null"} instead of ${expected ?? "null"}`);
  }
}

function assertFullAppProvenance(value: InteractionWitness["provenance"]): void {
  if (value === null || value.value === null || value.value === undefined || value.origin.trim() === "") {
    throw new Error("full-app selected provenance has no derived value and non-empty origin");
  }
}

function assertFullAppRoundTrip(witness: FullAppVisualStateRoundTripWitness): void {
  if (witness.serializedVisualState.trim() === "") {
    throw new Error("full-app VisualState serialisation is empty");
  }
  assertSurfaceParity(witness.original.surface, witness.restored.surface, witness.renderer);
  if (JSON.stringify(witness.original.visualState) !== JSON.stringify(witness.restored.visualState)) {
    throw new Error("full-app restored VisualState differs from the source mounted state");
  }
  if (witness.originalPickedNodeId !== witness.pickedNodeId || witness.restoredPickedNodeId !== witness.pickedNodeId) {
    throw new Error(`full-app VisualState live picking did not restore ${witness.pickedNodeId}`);
  }
}

function assertZeroPixelDifference(difference: number, label: string): void {
  if (difference !== 0) {
    throw new Error(`${label} has ${difference} differing composited pixels`);
  }
}

function assertNoFullAppErrors(pageErrors: readonly string[], consoleErrors: readonly string[]): void {
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`full-app recorded page errors [${pageErrors.join(", ")}] and console errors [${consoleErrors.join(", ")}]`);
  }
}

function assertFullAppShutdown(witness: FullAppShutdownWitness): void {
  if (witness.canvases !== 0 || witness.domLabelOverlays !== 0 || witness.framesAfterShutdown !== 0) {
    throw new Error(`full-app shutdown left canvases=${witness.canvases}, labelOverlays=${witness.domLabelOverlays}, frames=${witness.framesAfterShutdown}`);
  }
}

function sameSurface(left: FullAppMountWitness["surface"], right: FullAppMountWitness["surface"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatControlOutputs(controls: Readonly<Record<string, string>>): string {
  return Object.entries(controls).map(([step, output]) => `${step}: ${output}`).join(" | ");
}

async function captureRenderer(page: Page, renderer: ParityRenderer): Promise<DecodedPng> {
  const selector = `#parity-renderer-${renderer}`;
  const box = await page.locator(selector).boundingBox();
  expect(box, `${renderer} renderer container has a layout box`).not.toBeNull();
  if (box === null) {
    throw new Error(`${renderer} renderer container has no layout box`);
  }
  return decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }));
}

function governedPixelSampleAt(
  image: DecodedPng,
  pointCss: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
): GovernedPixelSample {
  const pointDevice = {
    x: Math.round(pointCss.x * devicePixelRatio),
    y: Math.round(pointCss.y * devicePixelRatio),
  };
  const inCapture = pointDevice.x >= 0
    && pointDevice.x < image.width
    && pointDevice.y >= 0
    && pointDevice.y < image.height;
  const offset = ((pointDevice.y * image.width) + pointDevice.x) * 4;
  return {
    pointCss,
    pointDevice,
    capture: { width: image.width, height: image.height },
    fieldRgb: fieldPixel(image),
    sampledRgb: inCapture
      ? [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0]
      : null,
  };
}

function requireLitRenderedStateObservation(
  observation: RenderedStateObservation,
  renderer: ParityRenderer,
): LitRenderedStateObservation {
  assertGovernedPixelSampleLit(observation.sample, `P3 ${renderer} ${observation.stateKey}`);
  if (observation.frameLitFloorFailure !== null) {
    throw new Error(`${observation.stateKey}: ${observation.frameLitFloorFailure}`);
  }
  if (observation.rgb === null || observation.monochromeRgb === null || observation.cvdRgb === null) {
    throw new Error(`P3 ${renderer} ${observation.stateKey} has no in-capture RGB after its lit-pixel assertion`);
  }
  return observation as LitRenderedStateObservation;
}

function p3ObservationEvidence(observation: RenderedStateObservation): unknown {
  return {
    state: observation.stateKey,
    targetId: observation.targetId,
    pointCss: observation.sample.pointCss,
    pointDevice: observation.sample.pointDevice,
    capture: observation.sample.capture,
    fieldRgb: observation.sample.fieldRgb,
    sampledRgb: observation.sample.sampledRgb,
    rgb: observation.rgb,
    frameLitPixels: observation.frameLitPixels,
    frameLitFloorFailure: observation.frameLitFloorFailure,
  };
}

function normalisedRgb(rgb: readonly [number, number, number]): Rgb {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

function transformImage(image: DecodedPng, transform: (rgb: Rgb) => Rgb): DecodedPng {
  const data = Buffer.from(image.data);
  for (let index = 0; index < data.length; index += 4) {
    const rgb = transform([(data[index] ?? 0) / 255, (data[index + 1] ?? 0) / 255, (data[index + 2] ?? 0) / 255]);
    data[index] = Math.round(clamp(rgb[0]) * 255);
    data[index + 1] = Math.round(clamp(rgb[1]) * 255);
    data[index + 2] = Math.round(clamp(rgb[2]) * 255);
  }
  return { ...image, data };
}

function pairwiseMatrix<Observation extends { readonly stateKey: string }>(
  observations: readonly Observation[],
  pick: (observation: Observation) => Rgb,
  distance: (left: Rgb, right: Rgb) => number,
): PairwiseMatrix {
  const values = Array.from({ length: observations.length }, () => Array.from({ length: observations.length }, () => 0));
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const leftObservation = requiredItem(observations, left, "pairwise left observation");
      const rightObservation = requiredItem(observations, right, "pairwise right observation");
      const value = distance(pick(leftObservation), pick(rightObservation));
      const leftRow = requiredItem(values, left, "pairwise left row");
      const rightRow = requiredItem(values, right, "pairwise right row");
      leftRow[right] = value;
      rightRow[left] = value;
    }
  }
  return { labels: observations.map((observation) => observation.stateKey), valuesMicro: values };
}

function assertMatrixAtLeast(matrix: PairwiseMatrix, threshold: number, label: string): void {
  for (let row = 0; row < matrix.valuesMicro.length; row += 1) {
    for (let column = row + 1; column < matrix.valuesMicro.length; column += 1) {
      const value = requiredItem(requiredItem(matrix.valuesMicro, row, `${label} row`), column, `${label} column`);
      if (value < threshold) {
        throw new Error(`${label} separation ${requiredItem(matrix.labels, row, `${label} left`)} / ${requiredItem(matrix.labels, column, `${label} right`)} measured ${value} micro below ${threshold} micro`);
      }
    }
  }
}

function maximumMatrixValue(matrix: PairwiseMatrix): number {
  return Math.max(...matrix.valuesMicro.flat());
}

function grayscaleDistanceMicro(left: Rgb, right: Rgb): number {
  return Math.round(Math.abs(relativeLuminance(left) - relativeLuminance(right)) * 1_000_000);
}

function rgbDistanceMicro(left: Rgb, right: Rgb): number {
  return Math.round(Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]) * 1_000_000);
}

function monochrome(rgb: Rgb): Rgb {
  const channel = linearToSrgb(relativeLuminance(rgb));
  return [channel, channel, channel];
}

function simulateCvd(rgb: Rgb, deficiency: Deficiency): Rgb {
  const linear: Rgb = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  const matrix = CVD_MATRICES[deficiency];
  return [
    linearToSrgb(clamp((matrix[0][0] * linear[0]) + (matrix[0][1] * linear[1]) + (matrix[0][2] * linear[2]))),
    linearToSrgb(clamp((matrix[1][0] * linear[0]) + (matrix[1][1] * linear[1]) + (matrix[1][2] * linear[2]))),
    linearToSrgb(clamp((matrix[2][0] * linear[0]) + (matrix[2][1] * linear[1]) + (matrix[2][2] * linear[2]))),
  ];
}

function greatestPixelDifference(before: DecodedPng, after: DecodedPng, id: string, footprint: InteractionWitness["selectedFootprint"]): PixelDifference {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`P4 ${id} captures have incompatible dimensions`);
  }
  const scale = before.width / 1200;
  const radius = Math.ceil((footprint.haloRadiusPx + 3) * scale);
  const centerX = Math.round(footprint.viewportCenter.x * scale);
  const centerY = Math.round(footprint.viewportCenter.y * scale);
  let greatest: PixelDifference = { id, point: footprint.viewportCenter, differenceMicro: 0 };
  for (let y = Math.max(0, centerY - radius); y <= Math.min(before.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(before.width - 1, centerX + radius); x += 1) {
      const differenceMicro = rgbDistanceMicro(rgbAtDevice(before, x, y), rgbAtDevice(after, x, y));
      if (differenceMicro > greatest.differenceMicro) {
        greatest = { id, point: { x: x / scale, y: y / scale }, differenceMicro };
      }
    }
  }
  return greatest;
}

function countDifferingPixels(before: DecodedPng, after: DecodedPng): number {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error("full-app compositor captures have incompatible dimensions");
  }
  let count = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    if (
      before.data[index] !== after.data[index]
      || before.data[index + 1] !== after.data[index + 1]
      || before.data[index + 2] !== after.data[index + 2]
      || before.data[index + 3] !== after.data[index + 3]
    ) {
      count += 1;
    }
  }
  return count;
}

function assertPixelDifference(difference: PixelDifference, label: string): void {
  if (difference.differenceMicro <= 0) {
    throw new Error(`${label} has no final-compositor pixel change for ${difference.id}`);
  }
}

function assertSelectedProvenance(value: InteractionWitness["provenance"]): void {
  if (value === null || value.origin.trim() === "") {
    throw new Error("P4 selected provenance has an empty origin");
  }
}

function assertPositivePickTolerance(value: number): void {
  if (value <= 0) {
    throw new Error(`P5 zero-tolerance control configured ${value}px`);
  }
}

function assertWorldAnchorsEqual(
  before: readonly { readonly id: string; readonly x: number; readonly y: number; readonly z: number }[],
  after: readonly { readonly id: string; readonly x: number; readonly y: number; readonly z: number }[],
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("P6 camera-switch control moved world anchor control");
  }
}

function assertBitIdentical(label: string, left: string, right: string): void {
  if (left !== right) {
    throw new Error(`${label} bytes differ`);
  }
}

function hueOnlyControlObservations(): readonly { readonly stateKey: string; readonly rgb: Rgb }[] {
  const redLinear = 0.25;
  const greenLinear = redLinear * 0.2126 / 0.7152;
  return [
    { stateKey: "hue-only-red", rgb: [linearToSrgb(redLinear), 0, 0] },
    { stateKey: "hue-only-green", rgb: [0, linearToSrgb(greenLinear), 0] },
  ];
}

function hashes(left: string | Uint8Array, right: string | Uint8Array): { readonly firstSha256: string; readonly secondSha256: string; readonly bitIdentical: boolean } {
  const firstSha256 = createHash("sha256").update(left).digest("hex");
  const secondSha256 = createHash("sha256").update(right).digest("hex");
  return { firstSha256, secondSha256, bitIdentical: firstSha256 === secondSha256 };
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} differs: actual [${actual.join(", ")}], expected [${expected.join(", ")}]`);
  }
}

function rgbAtDevice(image: DecodedPng, x: number, y: number): Rgb {
  const index = ((y * image.width) + x) * 4;
  return [(image.data[index] ?? 0) / 255, (image.data[index + 1] ?? 0) / 255, (image.data[index + 2] ?? 0) / 255];
}

function relativeLuminance(rgb: Rgb): number {
  return (0.2126 * srgbToLinear(rgb[0])) + (0.7152 * srgbToLinear(rgb[1])) + (0.0722 * srgbToLinear(rgb[2]));
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : (1.055 * (value ** (1 / 2.4))) - 0.055;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requiredItem<Value>(items: readonly Value[], index: number, label: string): Value {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`${label} is unavailable at index ${index}`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function currentCommitSha(): Promise<string> {
  const gitDirectory = ["..", ".git"].join("/");
  try {
    const head = (await readFile(`${gitDirectory}/HEAD`, "utf8")).trim();
    if (!head.startsWith("ref: ")) {
      return validCommitSha(head);
    }
    const reference = head.slice(5);
    try {
      return validCommitSha((await readFile(`${gitDirectory}/${reference}`, "utf8")).trim());
    } catch {
      const packed = await readFile(`${gitDirectory}/packed-refs`, "utf8");
      const line = packed.split("\n").find((candidate) => candidate.endsWith(` ${reference}`));
      return validCommitSha(line?.split(" ")[0] ?? "");
    }
  } catch {
    return "unavailable";
  }
}

async function purgeBrowserCache(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Network.clearBrowserCache");
  } finally {
    await session.detach();
  }
}

function validCommitSha(value: string): string {
  return /^[0-9a-f]{40,64}$/i.test(value) ? value : "unavailable";
}

function decodePng(source: Uint8Array): DecodedPng {
  const input = Buffer.from(source);
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("parity capture is not a PNG");
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
      throw new Error("parity PNG has an invalid chunk length");
    }
    if (type === "IHDR") {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      const bitDepth = input[offset + 16];
      const colourType = input[offset + 17];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error("parity PNG has an unsupported pixel format");
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
    throw new Error("parity PNG lacks dimensions");
  }
  const scanlines = inflateSync(Buffer.concat(chunks));
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error("parity PNG has invalid scanline bytes");
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
  return {
    bytes: source.byteLength,
    hash: createHash("sha256").update(source).digest("hex"),
    width,
    height,
    data,
  };
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
  throw new Error(`parity PNG has unsupported filter ${filter}`);
}
