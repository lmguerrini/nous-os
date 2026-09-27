import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type AxisApi = { ready: Promise<void>; setAxes(axes: Record<string, unknown>): Promise<void>; viewPreset(name: string): Promise<void>;
  witness(): { nodeViewport: Record<string, { x: number; y: number }> } };
type CanvasHook = HTMLCanvasElement & { __morphRedraw?: () => void };
const morphologies = ["stellar", "neural", "mycelium"] as const;
test.skip(process.env.D070_CAPTURE !== "1", "Set D070_CAPTURE=1 and serve the review page");

const capture = async (page: import("@playwright/test").Page) => page.evaluate(() => {
  const canvas = document.querySelector<CanvasHook>("#viewport canvas[data-morphology-canvas]")!;
  canvas.__morphRedraw?.();
  const context = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const j = i * 4;
    mask[i] = pixels[j + 3]! > 32 && Math.max(pixels[j]!, pixels[j + 1]!, pixels[j + 2]!) > 30 ? 1 : 0;
  }
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const grid = new Uint8Array(128 * 128);
  if (maxX >= minX) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (mask[y * width + x]) {
    const gx = Math.min(127, Math.floor((x - minX) * 128 / Math.max(1, maxX - minX + 1)));
    const gy = Math.min(127, Math.floor((y - minY) * 128 / Math.max(1, maxY - minY + 1)));
    grid[gy * 128 + gx] = 1;
  }
  return [...grid];
});
const overlap = (a: number[], b: number[]) => {
  let both = 0, union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] || b[i]) union++; if (a[i] && b[i]) both++; }
  return both / Math.max(1, union);
};
const dilate = (mask: number[]) => {
  const out = Array<number>(mask.length).fill(0);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) if (mask[y * 128 + x])
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      if (x + dx >= 0 && x + dx < 128 && y + dy >= 0 && y + dy < 128) out[(y + dy) * 128 + x + dx] = 1;
  return out;
};

for (const morphology of morphologies) test(`D-070 ${morphology}: 2D/3D-front normalized lit-mask IoU >= 0.15`, async ({ page }, testInfo) => {
  await page.goto(process.env.D070_URL ?? "http://127.0.0.1:8767/");
  await page.waitForFunction(() => Boolean((window as Window & { __d067?: AxisApi }).__d067));
  await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.ready);
  const api = (axes: Record<string, unknown>) => (window as Window & { __d067?: AxisApi }).__d067!.setAxes(axes);
  await page.evaluate(api, { projection: "2d", organization: "flat", morphology, colour: "bw", labels: false });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  const flat = await capture(page);
  await page.evaluate(api, { projection: "3d", organization: "flat", morphology, colour: "bw", labels: false });
  await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.viewPreset("fronte"));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const front = await capture(page);
  const iou = overlap(dilate(flat), dilate(front));
  await writeFile(testInfo.outputPath(`${morphology}-projection.json`), JSON.stringify({ iou, threshold: 0.15 }, null, 2));
  console.log(`D-070 ${morphology} 2D/3D-front IoU=${iou.toFixed(3)}`);
  expect(iou).toBeGreaterThanOrEqual(0.15);
});

test("D-070 Stellar/Mycelium 2D lit-mask Jaccard distance >= 0.5", async ({ page }, testInfo) => {
  await page.goto(process.env.D070_URL ?? "http://127.0.0.1:8767/");
  await page.waitForFunction(() => Boolean((window as Window & { __d067?: AxisApi }).__d067));
  await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.ready);
  const set = (morphology: string) => (window as Window & { __d067?: AxisApi }).__d067!.setAxes({ projection: "2d", organization: "flat", morphology, colour: "bw", labels: false });
  await page.evaluate(set, "stellar"); const stellar = await capture(page);
  await page.evaluate(set, "mycelium"); const mycelium = await capture(page);
  const distance = 1 - overlap(stellar, mycelium);
  await writeFile(testInfo.outputPath("separation.json"), JSON.stringify({ distance, threshold: 0.5 }, null, 2));
  console.log(`D-070 Stellar/Mycelium 2D Jaccard=${distance.toFixed(3)}`);
  expect(distance).toBeGreaterThanOrEqual(0.5);
});

test("D-070 Neural hidden-edge hook yields exactly one blob for every isolated soma", async ({ page }, testInfo) => {
  await page.goto(process.env.D070_URL ?? "http://127.0.0.1:8767/");
  await page.waitForFunction(() => Boolean((window as Window & { __d067?: AxisApi }).__d067));
  await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.ready);
  const result = await page.evaluate(async () => {
    const win = window as Window & { __d067?: AxisApi; __d070?: { hideEdges?: boolean; onlyNodeId?: string } };
    win.__d070 = { hideEdges: true };
    await win.__d067!.setAxes({ projection: "2d", organization: "flat", morphology: "neural", colour: "bw", labels: false });
    const canvas = document.querySelector<CanvasHook>("#viewport canvas[data-morphology-canvas]")!;
    const rect = canvas.getBoundingClientRect(), context = canvas.getContext("2d")!;
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const positions = Object.entries(win.__d067!.witness().nodeViewport);
    let checked = 0, failures = 0;
    for (const [id, point] of positions) {
      const x = Math.round((point.x - rect.left) * scaleX), y = Math.round((point.y - rect.top) * scaleY);
      if (x < 16 || y < 16 || x >= canvas.width - 16 || y >= canvas.height - 16) continue;
      win.__d070.onlyNodeId = id; canvas.__morphRedraw?.();
      const size = 33, data = context.getImageData(x - 16, y - 16, size, size).data;
      const mask = new Uint8Array(size * size);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]! > 96 ? 1 : 0;
      let blobs = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) {
        blobs++;
        const stack = [i]; mask[i] = 0;
        while (stack.length) {
          const at = stack.pop()!, px = at % size, py = Math.floor(at / size);
          for (const next of [px > 0 ? at - 1 : -1, px < size - 1 ? at + 1 : -1, py > 0 ? at - size : -1, py < size - 1 ? at + size : -1])
            if (next >= 0 && mask[next]) { mask[next] = 0; stack.push(next); }
        }
      }
      checked++; if (blobs !== 1) failures++;
    }
    win.__d070 = {}; canvas.__morphRedraw?.();
    return { checked, failures };
  });
  await writeFile(testInfo.outputPath("neural-soma.json"), JSON.stringify(result, null, 2));
  console.log(`D-070 Neural isolated soma blobs: ${result.checked} checked, ${result.failures} failures`);
  expect(result.checked).toBeGreaterThan(0);
  expect(result.failures).toBe(0);
});
