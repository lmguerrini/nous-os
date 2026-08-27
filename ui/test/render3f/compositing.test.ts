import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { build } from "esbuild";
import type { CameraKind } from "#engine/camera-kind.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import type { Render3fCompositingPageApi } from "./compositing-page.ts";

type DecodedPng = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

type LitPixelMeasurement = {
  readonly fieldRgb: readonly [number, number, number];
  readonly litPixels: number;
  readonly totalPixels: number;
  readonly maxChannel: number;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LIT_PIXEL_CHANNEL_MARGIN = 12;
const MINIMUM_LIT_PIXELS = 100;

declare global {
  interface Window {
    __render3fCompositing?: Render3fCompositingPageApi;
    __render3fCompositingFixture?: unknown;
  }
}

test("Three composites a lit frame in both camera kinds", async (context) => {
  const fixturePath = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [join("test", "render3f", "compositing-page.ts")],
  });
  const pageModule = requiredItem(bundled.outputFiles, 0, "compositing page bundle").text;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--single-process",
      "--use-angle=swiftshader-webgl",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-gpu-vsync",
      "--force-color-profile=srgb",
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`console: ${message.text()}`);
      }
    });
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
    });
    await page.evaluate((value) => {
      window.__render3fCompositingFixture = value;
    }, fixture);
    await page.addScriptTag({ content: pageModule });
    await page.waitForFunction(() => window.__render3fCompositing !== undefined);
    const pageStatus = await page.evaluate(() => ({
      ready: window.__render3fCompositing?.ready,
      error: window.__render3fCompositing?.error,
    }));
    assert.deepEqual(pageStatus, { ready: true, error: null });
    await settle(page);

    const orthographic = await captureAndMeasure(page, ORTHOGRAPHIC);
    assertLitPixelFloor(orthographic, ORTHOGRAPHIC);
    context.diagnostic(formatMeasurement(ORTHOGRAPHIC, orthographic));

    await page.evaluate((kind) => window.__render3fCompositing?.setCameraKind(kind), PERSPECTIVE);
    await settle(page);
    const perspective = await captureAndMeasure(page, PERSPECTIVE);
    assertLitPixelFloor(perspective, PERSPECTIVE);
    context.diagnostic(formatMeasurement(PERSPECTIVE, perspective));

    assert.deepEqual(browserErrors, []);
    await page.evaluate(() => window.__render3fCompositing?.destroy());
  } finally {
    await browser.close();
  }
});

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextPaint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await nextPaint();
    await nextPaint();
    await nextPaint();
  });
}

async function captureAndMeasure(page: Page, expectedKind: CameraKind): Promise<LitPixelMeasurement> {
  const observedKind = await page.evaluate(() => window.__render3fCompositing?.cameraKind());
  assert.equal(observedKind, expectedKind);
  const canvas = page.locator("canvas[data-render3f-canvas=true]");
  assert.equal(await canvas.count(), 1);
  return measureLitPixels(decodePng(await canvas.screenshot()));
}

function assertLitPixelFloor(measurement: LitPixelMeasurement, kind: CameraKind): void {
  assert.ok(
    measurement.litPixels >= MINIMUM_LIT_PIXELS,
    `${kind} composited frame has ${measurement.litPixels} lit pixels, below floor ${MINIMUM_LIT_PIXELS}; `
      + `field rgb(${measurement.fieldRgb.join(", ")}), max channel ${measurement.maxChannel}, total ${measurement.totalPixels}`,
  );
}

function formatMeasurement(kind: CameraKind, measurement: LitPixelMeasurement): string {
  return `${kind}: field rgb(${measurement.fieldRgb.join(", ")}), max channel ${measurement.maxChannel}, `
    + `lit pixels ${measurement.litPixels} of ${measurement.totalPixels}, required ${MINIMUM_LIT_PIXELS}`;
}

function measureLitPixels(image: DecodedPng): LitPixelMeasurement {
  const fieldRgb = modalRgb(image.data);
  let litPixels = 0;
  let maxChannel = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    maxChannel = Math.max(maxChannel, red, green, blue);
    if (Math.max(
      Math.abs(red - fieldRgb[0]),
      Math.abs(green - fieldRgb[1]),
      Math.abs(blue - fieldRgb[2]),
    ) > LIT_PIXEL_CHANNEL_MARGIN) {
      litPixels += 1;
    }
  }
  return { fieldRgb, litPixels, totalPixels: image.width * image.height, maxChannel };
}

function modalRgb(data: Uint8Array): readonly [number, number, number] {
  const counts = new Map<number, number>();
  let mode = 0;
  let modeCount = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const packed = ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    const count = (counts.get(packed) ?? 0) + 1;
    counts.set(packed, count);
    if (count > modeCount) {
      mode = packed;
      modeCount = count;
    }
  }
  return [(mode >> 16) & 0xff, (mode >> 8) & 0xff, mode & 0xff];
}

function decodePng(source: Uint8Array): DecodedPng {
  const input = Buffer.from(source);
  if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("compositing capture is not a PNG");
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
      throw new Error("compositing PNG has an invalid chunk length");
    }
    if (type === "IHDR") {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      const bitDepth = input[offset + 16];
      const colourType = input[offset + 17];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error("compositing PNG has an unsupported pixel format");
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
    throw new Error("compositing PNG lacks dimensions");
  }
  const scanlines = inflateSync(Buffer.concat(chunks));
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error("compositing PNG has invalid scanline bytes");
  }
  const data = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    const filter = scanlines[start];
    const current = new Uint8Array(rowBytes);
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
    previous.set(current);
  }
  return { width, height, data };
}

function unfilter(value: number, filter: number | undefined, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + above) & 0xff;
  if (filter === 3) return (value + Math.floor((left + above) / 2)) & 0xff;
  if (filter === 4) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    const predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
      ? left
      : aboveDistance <= upperLeftDistance ? above : upperLeft;
    return (value + predictor) & 0xff;
  }
  throw new Error(`compositing PNG has unsupported filter ${filter}`);
}

function requiredItem<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${label} is unavailable`);
  }
  return value;
}
