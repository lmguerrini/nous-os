/**
 * Produce the images `docs/` publishes, from the public synthetic fixtures.
 *
 * This is documentation tooling and deliberately not a test. The evidence
 * suites under `test/browser/` exist to falsify claims about the renderers and
 * their output is bound to a governed record; borrowing one of their captures
 * because a PNG already existed would publish an artefact that was produced to
 * answer a different question. These images are produced on purpose, from
 * named public fixtures, and every one of them records where it came from.
 *
 * Run from `ui/`:
 *
 *     node --experimental-strip-types tools/capture-docs-assets.ts
 *
 * It writes PNGs and `MANIFEST.json` into `docs/assets/`, overwriting what is
 * there. Nothing outside that directory is touched.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";

const PORT = 4_179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUTPUT_DIRECTORY = ["..", "docs", "assets"].join("/");

/** Every fixture named here is public, synthetic and tracked in this repository. */
const PROJECTION_FIXTURE = ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/");
const INDRA_FIXTURE = ["fixtures", "synthetic", "projection", "indra", "indra-community-windows.json"].join("/");

type ProjectionShot = {
  readonly file: string;
  readonly renderer: "sigma-2d" | "r3f-2d" | "r3f-3d";
  readonly view: "macro" | "meso" | "micro" | "selected" | "focused";
  readonly caption: string;
};

type MatrixShot = {
  readonly file: string;
  readonly fixture: string;
  readonly morphology: "stellar" | "neural" | "mycelium";
  readonly organization: "flat" | "indra";
  readonly projection: "2d" | "3d";
  readonly caption: string;
};

const PROJECTION_SHOTS: readonly ProjectionShot[] = [
  {
    file: "projection-2d.png",
    renderer: "sigma-2d",
    view: "macro",
    caption: "The 2D renderer (Sigma, over WebGL) drawing the projection.",
  },
  {
    file: "projection-3d-orthographic.png",
    renderer: "r3f-2d",
    view: "macro",
    caption: "The same projection, orthographic, through the Three.js renderer.",
  },
  {
    file: "projection-3d-perspective.png",
    renderer: "r3f-3d",
    view: "macro",
    caption: "The same projection again, perspective, through the same renderer.",
  },
  {
    file: "projection-3d-focused.png",
    renderer: "r3f-3d",
    view: "focused",
    caption: "One element focused: the camera moves, the knowledge state does not.",
  },
];

const MATRIX_SHOTS: readonly MatrixShot[] = [
  {
    file: "morphology-stellar.png",
    fixture: PROJECTION_FIXTURE,
    morphology: "stellar",
    organization: "flat",
    projection: "3d",
    caption: "Stellar morphology.",
  },
  {
    file: "morphology-neural.png",
    fixture: PROJECTION_FIXTURE,
    morphology: "neural",
    organization: "flat",
    projection: "3d",
    caption: "Neural morphology, same graph.",
  },
  {
    file: "morphology-mycelium.png",
    fixture: PROJECTION_FIXTURE,
    morphology: "mycelium",
    organization: "flat",
    projection: "3d",
    caption: "Mycelium morphology, same graph.",
  },
  {
    file: "organization-flat.png",
    fixture: INDRA_FIXTURE,
    morphology: "stellar",
    organization: "flat",
    projection: "3d",
    caption: "Flat organization over the aggregate-window fixture.",
  },
  {
    file: "organization-indra.png",
    fixture: INDRA_FIXTURE,
    morphology: "stellar",
    organization: "indra",
    projection: "3d",
    caption: "Indra organization over the same fixture: aggregates, not a different graph.",
  },
];

type ManifestEntry = {
  readonly file: string;
  readonly caption: string;
  readonly fixture: string;
  readonly fixtureSha256: string;
  readonly source: Record<string, string>;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** PNG dimensions from the IHDR chunk, so the manifest states a measured size. */
function pngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49_48_44_52) {
    throw new Error("capture is not a PNG with a leading IHDR chunk");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function serveRepository(): Promise<ChildProcess> {
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", ".."], {
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/`);
      if (response.ok) {
        return server;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error("the static server did not start within thirty seconds");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function bundlePageModule(entry: readonly string[]): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [entry.join("/")],
  });
  const output = bundled.outputFiles?.[0];
  if (output === undefined) {
    throw new Error(`no bundle was produced for ${entry.join("/")}`);
  }
  return output.text;
}

/**
 * Pin the clocks and the pseudo-random source before the page module loads, so
 * a documentation image is the same image on every run. The renderers seed
 * layout from `Math.random`; without this the published figures would drift
 * every time anyone regenerated them, and a reader could not tell a real visual
 * change from noise.
 */
async function preparePage(page: Page, pageModule: string, apiName: string): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    Math.random = (): number => 0.5;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => native(() => callback(0));
  });
  await page.addScriptTag({ content: pageModule });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await page.evaluate((name) => {
      const api = (window as unknown as Record<string, { ready?: boolean; errors?: readonly string[] }>)[name];
      return api === undefined ? null : { ready: api.ready === true, errors: [...(api.errors ?? [])] };
    }, apiName);
    if (state !== null && state.errors.length > 0) {
      throw new Error(`${apiName} reported: ${state.errors.join("; ")}`);
    }
    if (state?.ready === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${apiName} did not become ready within sixty seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function capture(
  page: Page,
  rootSelector: string,
  file: string,
): Promise<{ readonly sha256: string; readonly width: number; readonly height: number }> {
  const bytes = await page.locator(rootSelector).screenshot();
  await writeFile(join(OUTPUT_DIRECTORY, file), bytes);
  return { sha256: sha256(bytes), ...pngDimensions(bytes) };
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const fixtureDigests = new Map<string, string>();
  for (const fixture of [PROJECTION_FIXTURE, INDRA_FIXTURE]) {
    fixtureDigests.set(fixture, sha256(await readFile(join("..", fixture))));
  }

  const server = await serveRepository();
  let browser: Browser | undefined;
  const entries: ManifestEntry[] = [];
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--use-gl=angle", "--disable-gpu-vsync", "--force-color-profile=srgb"],
    });
    const context = await browser.newContext({
      viewport: { width: 1_200, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      locale: "en-US",
      timezoneId: "UTC",
    });

    const projectionPage = await context.newPage();
    await preparePage(projectionPage, await bundlePageModule(["test", "browser", "review3d.ts"]), "__review3d");
    for (const shot of PROJECTION_SHOTS) {
      await projectionPage.evaluate(
        async (request) => {
          const api = (window as unknown as { __review3d: { capture(value: unknown): Promise<unknown> } }).__review3d;
          await api.capture(request);
        },
        { renderer: shot.renderer, view: shot.view },
      );
      const measured = await capture(projectionPage, "#review3d-root", shot.file);
      entries.push({
        file: shot.file,
        caption: shot.caption,
        fixture: PROJECTION_FIXTURE,
        fixtureSha256: fixtureDigests.get(PROJECTION_FIXTURE) ?? "",
        source: { renderer: shot.renderer, view: shot.view },
        ...measured,
      });
      process.stdout.write(`captured ${shot.file}\n`);
    }
    await projectionPage.close();

    const matrixPage = await context.newPage();
    await preparePage(matrixPage, await bundlePageModule(["test", "browser", "matrix.ts"]), "__matrix");
    let preparedFixture: string | null = null;
    for (const shot of MATRIX_SHOTS) {
      if (preparedFixture !== shot.fixture) {
        await matrixPage.evaluate(async (fixture) => {
          const api = (window as unknown as { __matrix: { prepare(value: string): Promise<unknown> } }).__matrix;
          await api.prepare(fixture);
        }, shot.fixture);
        preparedFixture = shot.fixture;
      }
      await matrixPage.evaluate(
        async (request) => {
          const api = (window as unknown as { __matrix: { capture(value: unknown): Promise<unknown> } }).__matrix;
          await api.capture(request);
        },
        { morphology: shot.morphology, organization: shot.organization, projection: shot.projection },
      );
      const measured = await capture(matrixPage, "#matrix-root", shot.file);
      entries.push({
        file: shot.file,
        caption: shot.caption,
        fixture: shot.fixture,
        fixtureSha256: fixtureDigests.get(shot.fixture) ?? "",
        source: {
          morphology: shot.morphology,
          organization: shot.organization,
          projection: shot.projection,
        },
        ...measured,
      });
      process.stdout.write(`captured ${shot.file}\n`);
    }
    await matrixPage.close();
  } finally {
    await browser?.close();
    server.kill();
  }

  await writeFile(
    join(OUTPUT_DIRECTORY, "MANIFEST.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        purpose:
          "Documentation images published by docs/ and README.md. Produced on purpose from the public synthetic fixtures named below, never from a private corpus and never borrowed from the evidence suites.",
        command: "node --experimental-strip-types tools/capture-docs-assets.ts",
        viewport: { width: 1_200, height: 800, deviceScaleFactor: 1, colorScheme: "dark" },
        determinism:
          "Date.now, performance.now and Math.random are pinned before the page module loads, so regenerating produces the same bytes.",
        images: entries,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`wrote ${entries.length} images and MANIFEST.json to docs/assets/\n`);
}

await main();
