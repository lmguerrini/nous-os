import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type AxisApi = { ready: Promise<void>; setAxes(axes: Record<string, unknown>): Promise<void> };
const morphologies = ["stellar", "neural", "mycelium"] as const;
const projections = ["2d", "3d"] as const;
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
      // Black-and-white captures are mostly empty field, so a mean over every pixel mostly measures the
      // background. The measures below look only where either capture draws something (luminance > 40):
      // the mean difference there, and the Jaccard distance between the two sets of lit pixels. The
      // D-067 baseline gave 17–22 and 0.19–0.25 for its three morphologies in 2D Flat.
      const pairs: { pair: string; meanLit: number; jaccard: number; edgeMapDifference: number }[] = [];
      const luminance = (data: Uint8ClampedArray, offset: number) =>
        (data[offset]! * 0.2126) + (data[offset + 1]! * 0.7152) + (data[offset + 2]! * 0.0722);
      for (let a = 0; a < pixels.length; a++) for (let b = a + 1; b < pixels.length; b++) {
        const left = pixels[a]!, right = pixels[b]!;
        const width = Math.min(left.width, right.width), height = Math.min(left.height, right.height);
        let litUnion = 0, litBoth = 0, litDifference = 0, changedEdges = 0, edgeUnion = 0;
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
          const l = (y * left.width + x) * 4, r = (y * right.width + x) * 4;
          const vl = luminance(left.data, l), vr = luminance(right.data, r);
          if (vl > 40 || vr > 40) { litUnion++; litDifference += Math.abs(vl - vr); }
          if (vl > 40 && vr > 40) litBoth++;
          const edge = (data: Uint8ClampedArray, offset: number, rowWidth: number) => Math.hypot(
            luminance(data, offset + 4) - luminance(data, offset - 4),
            luminance(data, offset + rowWidth * 4) - luminance(data, offset - rowWidth * 4)) > 28;
          const e1 = edge(left.data, l, left.width), e2 = edge(right.data, r, right.width);
          if (e1 || e2) edgeUnion++;
          if (e1 !== e2) changedEdges++;
        }
        pairs.push({ pair: `${a}-${b}`, meanLit: litDifference / Math.max(1, litUnion), jaccard: 1 - litBoth / Math.max(1, litUnion),
          edgeMapDifference: changedEdges / Math.max(1, edgeUnion) });
      }
      return pairs;
    }, shots);
    await testInfo.attach("morphology-metrics", { body: JSON.stringify(differences), contentType: "application/json" });
    await writeFile(testInfo.outputPath("metrics.json"), JSON.stringify(differences, null, 1));
    for (const comparison of differences) {
      expect(comparison.meanLit, `${projection}/${organization} ${comparison.pair} mean difference over lit pixels`).toBeGreaterThanOrEqual(40);
      expect(comparison.jaccard, `${projection}/${organization} ${comparison.pair} lit-pixel Jaccard distance`).toBeGreaterThanOrEqual(0.5);
      expect(comparison.edgeMapDifference, `${projection}/${organization} ${comparison.pair} structural edge map`).toBeGreaterThan(0.08);
    }
  });
}
