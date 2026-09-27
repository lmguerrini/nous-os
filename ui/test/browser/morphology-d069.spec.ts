import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type AxisApi = { ready: Promise<void>; setAxes(axes: Record<string, unknown>): Promise<void> };
const morphologies = ["stellar", "neural", "mycelium"] as const;
const projections = ["2d", "3d-orthographic", "3d-perspective"] as const;
const organizations = ["flat", "indra"] as const;

test.skip(process.env.D069_CAPTURE !== "1", "Set D069_CAPTURE=1 and serve the review page");

for (const projection of projections) for (const organization of organizations) {
  test(`D-069 morphology separation: ${projection} ${organization}`, async ({ page }, testInfo) => {
    const url = process.env.D069_URL ?? "http://127.0.0.1:8767/";
    await page.goto(url);
    await page.waitForFunction(() => Boolean((window as Window & { __d067?: AxisApi }).__d067));
    await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.ready);
    const shots: string[] = [];
    for (const morphology of morphologies) {
      await page.evaluate(
        (axes) => (window as Window & { __d067?: AxisApi }).__d067!.setAxes(axes),
        { projection, organization, morphology, colour: "bw", labels: false },
      );
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
      const screenshot = await page.locator("#viewport").screenshot();
      await writeFile(testInfo.outputPath(`${projection}-${organization}-${morphology}.png`), screenshot);
      shots.push(screenshot.toString("base64"));
    }
    const differences = await page.evaluate(async (encoded) => {
      const pixels = await Promise.all(encoded.map(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
      }));
      const pairs: { pair: string; mean: number; edgeMapDifference: number }[] = [];
      for (let a = 0; a < pixels.length; a++) for (let b = a + 1; b < pixels.length; b++) {
        const left = pixels[a]!, right = pixels[b]!;
        let colourSum = 0, changedEdges = 0, edgeUnion = 0;
        const luminance = (data: Uint8ClampedArray, offset: number) =>
          (data[offset]! * 0.2126) + (data[offset + 1]! * 0.7152) + (data[offset + 2]! * 0.0722);
        for (let y = 1; y < left.height - 1; y++) for (let x = 1; x < left.width - 1; x++) {
          const offset = (y * left.width + x) * 4;
          colourSum += (Math.abs(left.data[offset]! - right.data[offset]!)
            + Math.abs(left.data[offset + 1]! - right.data[offset + 1]!)
            + Math.abs(left.data[offset + 2]! - right.data[offset + 2]!)) / 3;
          const edge = (data: Uint8ClampedArray) => {
            const dx = luminance(data, offset + 4) - luminance(data, offset - 4);
            const dy = luminance(data, offset + left.width * 4) - luminance(data, offset - left.width * 4);
            return Math.hypot(dx, dy) > 28;
          };
          const e1 = edge(left.data), e2 = edge(right.data);
          if (e1 || e2) edgeUnion++;
          if (e1 !== e2) changedEdges++;
        }
        pairs.push({ pair: `${a}-${b}`, mean: colourSum / ((left.width - 2) * (left.height - 2)), edgeMapDifference: changedEdges / Math.max(1, edgeUnion) });
      }
      return pairs;
    }, shots);
    for (const comparison of differences) {
      expect(comparison.mean, `${projection}/${organization} ${comparison.pair} mean pixel difference`).toBeGreaterThanOrEqual(9);
      expect(comparison.edgeMapDifference, `${projection}/${organization} ${comparison.pair} structural edge map`).toBeGreaterThan(0.08);
    }
  });
}
