import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { fieldPixel, isLitPixel } from "#browser/filament-continuity.ts";
import type { DecodedPng } from "#browser/filament-continuity.ts";
import {
  PARITY_RENDERERS,
  PROJECTION_DEPENDENT_SCENE_CHANNELS,
  assertSceneCameraParity,
  assertSurfaceParity,
  derivedNonNullRenderedStateDomain,
  failingControlOutput,
  renderedStateKey,
} from "#browser/parity.ts";
import type {
  CameraLayoutCapabilityWitness,
  DeterminismSemanticWitness,
  InteractionWitness,
  MountedParityWitness,
  NodePickWitness,
  ParityBrowserApi,
  ParityRenderer,
  RenderedStatePixelWitness,
  ZeroToleranceWitness,
} from "#browser/parity.ts";

type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";
type CheckName = "P1 surface parity" | "P2 semantic-channel parity" | "P3 governed-state separation" | "P4 interaction and provenance" | "P5 drawing and picking" | "P6 camera switch" | "P7 determinism" | "P8 non-colour encoding";
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

test("renderer parity oracle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "parity", "run this through the dedicated parity project");
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
        measured: message(error),
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

  const p3Observations = new Map<ParityRenderer, readonly RenderedStateObservation[]>();
  const domain = derivedNonNullRenderedStateDomain();
  for (const renderer of PARITY_RENDERERS) {
    await record("P3 governed-state separation", renderer, async () => {
      const observations: RenderedStateObservation[] = [];
      for (let index = 0; index < domain.length; index += 1) {
        const witness = await invoke<RenderedStatePixelWitness>("renderLegalState", renderer, index);
        const image = await captureRenderer(page, renderer);
        const rgb = rgbAt(image, witness.point);
        const monochromeRgb = rgbAt(transformImage(image, monochrome), witness.point);
        const cvdRgb = Object.fromEntries((Object.keys(CVD_MATRICES) as Deficiency[]).map((deficiency) => [
          deficiency,
          rgbAt(transformImage(image, (value) => simulateCvd(value, deficiency)), witness.point),
        ])) as Readonly<Record<Deficiency, Rgb>>;
        observations.push({ stateKey: witness.stateKey, targetId: witness.targetId, rgb, monochromeRgb, cvdRgb });
      }
      assertSameStrings(observations.map((observation) => observation.stateKey), domain.map(renderedStateKey), "P3 observed derived domain");
      const nonHue = pairwiseMatrix(observations, (observation) => observation.rgb, grayscaleDistanceMicro);
      const cvd = Object.fromEntries((Object.keys(CVD_MATRICES) as Deficiency[]).map((deficiency) => [
        deficiency,
        pairwiseMatrix(observations, (observation) => observation.cvdRgb[deficiency], rgbDistanceMicro),
      ])) as Readonly<Record<Deficiency, PairwiseMatrix>>;
      const nonHueThreshold = DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro;
      const cvdThreshold = DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro;
      assertMatrixAtLeast(nonHue, nonHueThreshold, "P3 non-hue");
      for (const deficiency of Object.keys(cvd) as Deficiency[]) {
        assertMatrixAtLeast(cvd[deficiency], cvdThreshold, `P3 ${deficiency}`);
      }
      const p3Control = failingControlOutput(() => assertMatrixAtLeast(nonHue, maximumMatrixValue(nonHue) + 1, "P3 unattainable-threshold control"));
      p3Observations.set(renderer, observations);
      return {
        measured: { domain: observations.map((observation) => ({ state: observation.stateKey, targetId: observation.targetId, rgb: observation.rgb })), nonHue, cvd },
        threshold: { nonHueMinimumMicro: nonHueThreshold, cvdMinimumMicro: cvdThreshold },
        turnsRed: "any pair in the complete derived legal domain is below either unchanged governed threshold",
        control: { status: "FAILED_AS_EXPECTED", output: p3Control },
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
        measured: { samples, zeroTolerance },
        threshold: "renderer pick returns the renderer-projected drawn node id; configured pick tolerance is greater than zero",
        turnsRed: "a renderer-projected node is not lit, does not pick itself, or the zero-tolerance control is accepted",
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
    await notRun(
      "P6 camera switch",
      "r3f-2d",
      "P6 requires a public GraphRendererHandle world-anchor and layout-pass contract before it can make a live observation",
      "all live world anchors unchanged; layout pass count unchanged; camera kind round-trips",
      "any live world anchor moves, layout pass count changes, or camera kind fails to round-trip",
      { status: "FAILED_AS_EXPECTED", output: p6Control },
      { reason: "the required world-anchor/layout methods are not declared on GraphRendererHandle" },
    );
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

async function captureRenderer(page: Page, renderer: ParityRenderer): Promise<DecodedPng> {
  const selector = `#parity-renderer-${renderer}`;
  const box = await page.locator(selector).boundingBox();
  expect(box, `${renderer} renderer container has a layout box`).not.toBeNull();
  if (box === null) {
    throw new Error(`${renderer} renderer container has no layout box`);
  }
  return decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }));
}

function rgbAt(image: DecodedPng, point: { readonly x: number; readonly y: number }): Rgb {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * (image.width / 1200))));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * (image.height / 800))));
  const index = ((y * image.width) + x) * 4;
  return [(image.data[index] ?? 0) / 255, (image.data[index + 1] ?? 0) / 255, (image.data[index + 2] ?? 0) / 255];
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
