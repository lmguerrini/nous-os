import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const url = process.env.D071_URL ?? "http://127.0.0.1:8768/";
test.skip(process.env.D071_BROWSER !== "1", "Set D071_BROWSER=1 and serve the review page");

type CellMeasure = {
  nodes: number;
  outside: string[];
  labels: number;
  fov: number | null;
  width: number;
  height: number;
  diagonal: number;
};

const CELLS = [
  { name: "3d-flat", organization: "flat" },
  { name: "3d-indra", organization: "indra" },
] as const;

const ready = async (page: Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

/** Two consecutive frames with an unchanged camera pose; bounded like the fit spec. */
const settled = (page: Page) => page.evaluate(() => new Promise<boolean>((resolve) => {
  const api = (window as any).__d067;
  const round = (_key: string, value: unknown) => typeof value === "number" ? Math.round(value * 100) / 100 : value;
  const signature = () => {
    try {
      const pose = api.camera();
      if (pose) return JSON.stringify(["pose", pose.position, pose.target, pose.up, pose.fov], round);
      return "unready";
    } catch {
      return "unready";
    }
  };
  let previous = signature();
  let stable = 0;
  let frames = 0;
  const tick = () => {
    frames += 1;
    const current = signature();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 2 || frames > 300) resolve(stable >= 2);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/** The visible nodes' screen bounding box, the live fov, and any node outside the visible rect. */
const measure = (page: Page) => page.evaluate(() => {
  const api = (window as any).__d067;
  const witness = api.witness();
  const rect = witness.visibleRect as { left: number; top: number; width: number; height: number };
  const nodes = (Object.entries(witness.nodeViewport) as [string, { x: number; y: number }][])
    .filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const outside = nodes.filter(([, point]) =>
    !(point.x >= rect.left - 1 && point.x <= rect.left + rect.width + 1 && point.y >= rect.top - 1 && point.y <= rect.top + rect.height + 1))
    .map(([id]) => id);
  const xs = nodes.map(([, point]) => point.x);
  const ys = nodes.map(([, point]) => point.y);
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const pose = api.camera();
  return {
    nodes: nodes.length,
    outside,
    labels: (witness.labels as unknown[]).length,
    fov: pose ? pose.fov : null,
    width,
    height,
    diagonal: Math.hypot(width, height),
  } satisfies CellMeasure;
});

const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

test("D-071 the 3D wheel is a true dolly: it magnifies at a fixed field of view", async ({ page }, testInfo) => {
  await ready(page);
  const results: Record<string, Record<string, unknown>> = {};
  for (const cell of CELLS) {
    await page.evaluate((organization) => (window as any).__d067.setAxes({
      projection: "3d", organization, reading: "attested", morphology: "stellar",
    }), cell.organization);
    await page.evaluate(() => (window as any).__d067.fit());
    await expect.poll(() => settled(page), { timeout: 20000, message: `${cell.name}: camera never settled after fit` }).toBe(true);

    const start = await measure(page);
    expect(start.nodes, `${cell.name}: visible nodes`).toBeGreaterThan(0);
    expect(start.outside, `${cell.name}: every node framed at the start`).toEqual([]);
    expect(start.fov, `${cell.name}: framed fov within 10°–90°`).toBeGreaterThanOrEqual(10);
    expect(start.fov, `${cell.name}: framed fov within 10°–90°`).toBeLessThanOrEqual(90);

    const canvas = page.locator("#viewport canvas").first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);

    const fovSamples: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.wheel(0, -120);
      await nextFrame(page);
      fovSamples.push(await page.evaluate(() => (window as any).__d067.camera().fov) as number);
    }
    const zoomed = await measure(page);
    const widthRatio = zoomed.width / Math.max(1e-9, start.width);
    const heightRatio = zoomed.height / Math.max(1e-9, start.height);
    const diagonalRatio = zoomed.diagonal / Math.max(1e-9, start.diagonal);
    expect(Math.max(widthRatio, heightRatio),
      `${cell.name}: five wheel-in steps grow the node box at least 1.8× (w×${widthRatio.toFixed(2)} h×${heightRatio.toFixed(2)})`).toBeGreaterThanOrEqual(1.8);
    expect(diagonalRatio, `${cell.name}: five wheel-in steps grow the whole box`).toBeGreaterThanOrEqual(1.5);
    for (const fov of fovSamples) {
      expect(Math.abs(fov - start.fov!), `${cell.name}: fov stays within ±1° during wheel-in`).toBeLessThanOrEqual(1);
    }

    for (let step = 0; step < 10; step += 1) {
      await page.mouse.wheel(0, 120);
      await nextFrame(page);
      fovSamples.push(await page.evaluate(() => (window as any).__d067.camera().fov) as number);
    }
    const widened = await measure(page);
    expect(widened.width, `${cell.name}: ten wheel-out steps shrink the box below the start width`).toBeLessThan(start.width);
    expect(widened.height, `${cell.name}: ten wheel-out steps shrink the box below the start height`).toBeLessThan(start.height);
    for (const fov of fovSamples) {
      expect(Math.abs(fov - start.fov!), `${cell.name}: fov stays within ±1° during wheel-out`).toBeLessThanOrEqual(1);
    }

    await page.evaluate(() => (window as any).__d067.fit());
    await expect.poll(() => settled(page), { timeout: 20000, message: `${cell.name}: camera never settled after the refit` }).toBe(true);
    const refitted = await measure(page);
    expect(refitted.outside, `${cell.name}: fit after the wheel restores a framed view`).toEqual([]);
    expect(refitted.fov, `${cell.name}: refitted fov within 10°–90°`).toBeGreaterThanOrEqual(10);
    expect(refitted.fov, `${cell.name}: refitted fov within 10°–90°`).toBeLessThanOrEqual(90);
    expect(refitted.labels, `${cell.name}: labels return after the refit`).toBeGreaterThan(0);
    expect(refitted.diagonal, `${cell.name}: the refit magnifies back toward the opening size`).toBeGreaterThanOrEqual(0.6 * start.diagonal);

    results[cell.name] = {
      start, zoomed: { ...zoomed, widthRatio, heightRatio, diagonalRatio }, widened, refitted,
      fovSamples: fovSamples.map((fov) => Math.round(fov * 100) / 100),
    };
  }
  await writeFile(testInfo.outputPath("zoom-cells.json"), JSON.stringify(results, null, 2));
  console.log(`D-071 zoom cells: ${Object.entries(results).map(([name, cell]) =>
    `${name} fov=${(cell.start as CellMeasure).fov?.toFixed(1)}° in×${((cell.zoomed as any).diagonalRatio as number).toFixed(2)} out×${(((cell.widened as CellMeasure).diagonal) / Math.max(1e-9, (cell.start as CellMeasure).diagonal)).toFixed(2)}`).join(" | ")}`);
});
