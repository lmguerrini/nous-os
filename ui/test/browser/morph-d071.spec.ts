import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type AxisApi = {
  ready: Promise<void>;
  setAxes(axes: Record<string, unknown>): Promise<void>;
  witness(): { nodeViewport: Record<string, { x: number; y: number }>; labels: { id: string; rect: { left: number; top: number; width: number; height: number } }[] };
};
type CanvasHook = HTMLCanvasElement & { __morphRedraw?: () => void };
type TestWindow = Window & { __d067?: AxisApi; __d070?: { hideEdges?: boolean; hideNodes?: boolean; onlyNodeId?: string } };

test.skip(process.env.D071_CAPTURE !== "1", "Set D071_CAPTURE=1 and serve the review page");
const url = () => process.env.D071_URL ?? "http://127.0.0.1:8767/";

const setAxes = (page: import("@playwright/test").Page, axes: Record<string, unknown>) =>
  page.evaluate((value) => (window as TestWindow).__d067!.setAxes(value), axes);

const setStarfield = async (page: import("@playwright/test").Page, density: number, brightness: number) => {
  await page.evaluate(([d, b]) => {
    const set = (id: string, value: number) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("appearance-starfieldDensity", d);
    set("appearance-starfieldBrightness", b);
  }, [density, brightness] as const);
  // scheduleAppearance is throttled through a rAF + the view remount; let both settle.
  await page.waitForTimeout(280);
};

const readStars = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<CanvasHook>("#viewport canvas[data-morphology-canvas]")!;
    canvas.__morphRedraw?.();
    const context = canvas.getContext("2d")!;
    const { width, height } = canvas;
    const data = context.getImageData(0, 0, width, height).data;
    let count = 0, sum = 0;
    for (let i = 0; i < width * height; i++) {
      const alpha = data[i * 4 + 3]!;
      if (alpha > 16) { count++; sum += alpha; }
    }
    return { count, mean: count ? sum / count : 0 };
  });

test("D-071 starfield: Stellar-only, absent at density 0, brighter at brightness 1", async ({ page }, testInfo) => {
  await page.goto(url());
  await page.waitForFunction(() => Boolean((window as TestWindow).__d067));
  await page.evaluate(() => (window as TestWindow).__d067!.ready);
  await page.evaluate(() => { (window as TestWindow).__d070 = { hideEdges: true, hideNodes: true }; });
  await setAxes(page, { projection: "2d", organization: "flat", morphology: "stellar", colour: "bw", labels: false });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();

  await setStarfield(page, 0.25, 0.35);
  const baseline = await readStars(page);
  await setStarfield(page, 0, 0.35);
  const none = await readStars(page);
  await setStarfield(page, 0.25, 1);
  const brighter = await readStars(page);
  await setStarfield(page, 1, 0.35);
  const denser = await readStars(page);

  await setAxes(page, { morphology: "neural" });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  const neural = await readStars(page);

  const result = { baseline, none, brighter, denser, neural };
  await writeFile(testInfo.outputPath("starfield.json"), JSON.stringify(result, null, 2));
  console.log(`D-071 starfield baseline=${baseline.count} none=${none.count} brighter=${brighter.count} denser=${denser.count} neural=${neural.count}`);
  expect(baseline.count).toBeGreaterThan(0);
  expect(none.count).toBe(0);
  expect(brighter.count).toBeGreaterThan(0);
  expect(brighter.mean).toBeGreaterThan(baseline.mean * 1.5);
  expect(denser.count).toBeGreaterThan(baseline.count);
  expect(neural.count).toBe(0);
});

test("D-071 starfield never moves labels", async ({ page }, testInfo) => {
  await page.goto(url());
  await page.waitForFunction(() => Boolean((window as TestWindow).__d067));
  await page.evaluate(() => (window as TestWindow).__d067!.ready);
  await setAxes(page, { projection: "2d", organization: "flat", morphology: "stellar", colour: "bw", labels: true });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();

  const labelRects = () => page.evaluate(() =>
    (window as TestWindow).__d067!.witness().labels.map((label) => ({ id: label.id, ...label.rect })));

  await setStarfield(page, 0, 0.35);
  const without = await labelRects();
  await setStarfield(page, 1, 1);
  const withStars = await labelRects();

  await writeFile(testInfo.outputPath("labels.json"), JSON.stringify({ without, withStars }, null, 2));
  expect(withStars).toEqual(without);
});

test("D-071 Neural and Mycelium 2D lit-masks differ from Stellar by >= 0.5 Jaccard", async ({ page }, testInfo) => {
  await page.goto(url());
  await page.waitForFunction(() => Boolean((window as TestWindow).__d067));
  await page.evaluate(() => (window as TestWindow).__d067!.ready);
  // Neutralise the decorative starfield so the comparison isolates morphology.
  await setStarfield(page, 0, 0);

  const capture = () => page.evaluate(() => {
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
    return Array.from(grid);
  });
  const jaccardDistance = (a: number[], b: number[]) => {
    let both = 0, union = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] || b[i]) union++; if (a[i] && b[i]) both++; }
    return 1 - both / Math.max(1, union);
  };

  const masks: Record<string, number[]> = {};
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    await setAxes(page, { projection: "2d", organization: "flat", morphology, colour: "bw", labels: false });
    await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    masks[morphology] = await capture();
  }
  const neuralDistance = jaccardDistance(masks.stellar!, masks.neural!);
  const myceliumDistance = jaccardDistance(masks.stellar!, masks.mycelium!);
  await writeFile(testInfo.outputPath("separation.json"), JSON.stringify({ neuralDistance, myceliumDistance }, null, 2));
  console.log(`D-071 Jaccard distance: Neural-vs-Stellar=${neuralDistance.toFixed(3)} Mycelium-vs-Stellar=${myceliumDistance.toFixed(3)}`);
  expect(neuralDistance).toBeGreaterThanOrEqual(0.5);
  expect(myceliumDistance).toBeGreaterThanOrEqual(0.5);
});
