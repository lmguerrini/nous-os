import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PerformanceResult } from "#browser/performance.ts";

const SOFTWARE_RASTERISATION_LABEL = "software-rasterised — not GPU performance";

const PERFORMANCE_ENABLED = process.env.PERFORMANCE_SUITE === "1";
const OUTPUT_FILE = ["dist", "evidence", "performance.json"].join("/");
const PERFORMANCE_MEASUREMENTS = [
  "frameTime",
  "initialRenderLatency",
  "layoutCost",
  "sceneModelBuildCost",
  "interactionLatency",
  "pickingLatency",
  "memory",
  "cameraTransitionCost",
  "cameraSwitchCost",
  "progressiveDisclosure",
] as const;

declare global {
  interface Window {
    __performance?: {
      readonly run: (observedCommitSha: string) => Promise<PerformanceResult>;
    };
  }
}

/** This runs the opt-in browser performance suite and does not alter renderer or launch configuration. */
test("CAP-13 renderer performance", async ({ page }) => {
  test.skip(!PERFORMANCE_ENABLED, "set PERFORMANCE_SUITE=1 to run the performance suite");
  const observedCommitSha = await readObservedCommitSha();
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: ["test/browser/performance.ts"],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("performance page module did not bundle");
  }
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: output.text });
  const result = await page.evaluate((commitSha) => {
    const api = window.__performance;
    if (api === undefined) {
      throw new Error("performance page module is unavailable");
    }
    return api.run(commitSha);
  }, observedCommitSha);
  assertPerformanceResult(result, observedCommitSha);
  await mkdir(["dist", "evidence"].join("/"), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");
});

function assertPerformanceResult(result: PerformanceResult, observedCommitSha: string): void {
  expect(result.schemaVersion).toBe(1);
  expect(result.rasterisationLabel).toBe(SOFTWARE_RASTERISATION_LABEL);
  expect(result.observedCommitSha).toBe(observedCommitSha);
  expect(result.records).toHaveLength(9);
  for (const record of result.records) {
    expect(record.observedCommitSha).toBe(observedCommitSha);
    expect(record.rasterisationLabel).toBe(SOFTWARE_RASTERISATION_LABEL);
    expect(record.warmup.framesExcluded).toBeGreaterThan(0);
    for (const measurementName of PERFORMANCE_MEASUREMENTS) {
      const measurement = record.measurements[measurementName];
      expect(measurement.label).toBe(SOFTWARE_RASTERISATION_LABEL);
    }
  }
}

async function readObservedCommitSha(): Promise<string> {
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
    throw new Error("performance run cannot determine the observed commit SHA");
  }
  return sha;
}
