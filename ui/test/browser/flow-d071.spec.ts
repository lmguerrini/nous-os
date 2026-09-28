import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type AxisApi = { ready: Promise<void>; setAxes(axes: Record<string, unknown>): Promise<void> };
type CanvasHook = HTMLCanvasElement & { __morphRedraw?: () => void };
type FlowApi = { flow: { animatedEdges(): number; setMotion(enabled: boolean): void; frameCostMs(): number; now(ms: number): void } };

test.skip(process.env.D071_CAPTURE !== "1", "Set D071_CAPTURE=1 and serve the review page");

const url = () => process.env.D071_URL ?? "http://127.0.0.1:8767/";
const baseAxes = { projection: "2d", organization: "flat", morphology: "stellar", colour: "bw", labels: false };

async function ready(page: Page): Promise<void> {
  await page.goto(url());
  await page.waitForFunction(() => Boolean((window as Window & { __d067?: AxisApi }).__d067));
  await page.evaluate(() => (window as Window & { __d067?: AxisApi }).__d067!.ready);
}
async function setAxes(page: Page, axes: Record<string, unknown>): Promise<void> {
  await page.evaluate((axes) => (window as Window & { __d067?: AxisApi }).__d067!.setAxes(axes), axes);
}
function captureHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<CanvasHook>("#viewport canvas[data-morphology-canvas]")!;
    canvas.__morphRedraw?.();
    const context = canvas.getContext("2d")!;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) { hash ^= data[i]!; hash = Math.imul(hash, 0x01000193); }
    return (hash >>> 0).toString(16);
  });
}
async function animatedEdges(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __d071?: FlowApi }).__d071!.flow.animatedEdges());
}

test("D-071 no dashed segments: zero non-empty setLineDash patterns during a draw", async ({ page }) => {
  await ready(page);
  await setAxes(page, { ...baseAxes, reading: "combined" });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  const count = await page.evaluate(() => {
    const canvas = document.querySelector<CanvasHook>("#viewport canvas[data-morphology-canvas]")!;
    const context = canvas.getContext("2d")!;
    const original = context.setLineDash;
    let nonEmpty = 0;
    context.setLineDash = ((pattern: readonly number[]) => {
      if (Array.isArray(pattern) && pattern.length > 0) nonEmpty++;
      original.call(context, pattern as number[]);
    }) as CanvasRenderingContext2D["setLineDash"];
    canvas.__morphRedraw?.();
    context.setLineDash = original;
    return nonEmpty;
  });
  expect(count).toBe(0);
});

test("D-071 exploratory reading animates while attested reading stays still", async ({ page }) => {
  await ready(page);
  await setAxes(page, { ...baseAxes, reading: "combined" });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  expect(await animatedEdges(page)).toBeGreaterThan(0);
  const exploratoryA = await captureHash(page);
  await page.waitForTimeout(350);
  const exploratoryB = await captureHash(page);
  expect(exploratoryB).not.toBe(exploratoryA);

  await setAxes(page, { ...baseAxes, reading: "attested" });
  const attestedA = await captureHash(page);
  await page.waitForTimeout(350);
  const attestedB = await captureHash(page);
  expect(attestedB).toBe(attestedA);
});

test("D-071 reduced motion emulation gives identical frames", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await setAxes(page, { ...baseAxes, reading: "combined" });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  const first = await captureHash(page);
  await page.waitForTimeout(350);
  const second = await captureHash(page);
  expect(second).toBe(first);
});

test("D-071 the legend shows four entries in the panel and in fullscreen", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#details [data-flow-legend-entry]")).toHaveCount(4);
  await expect(page.locator("#details [data-flow-legend-entry]").first()).toBeVisible();
  await expect(page.locator("#fullscreen-legend [data-flow-legend-entry]")).toHaveCount(4);
});

test("D-071 the Movimento toggle stops motion", async ({ page }) => {
  await ready(page);
  await setAxes(page, { ...baseAxes, reading: "combined" });
  await expect(page.locator("#viewport canvas[data-morphology-canvas]")).toBeVisible();
  const movingA = await captureHash(page);
  await page.waitForTimeout(350);
  const movingB = await captureHash(page);
  expect(movingB).not.toBe(movingA);
  await page.evaluate(() => {
    const toggle = document.querySelector<HTMLInputElement>("#flow-motion")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(120);
  const stillA = await captureHash(page);
  await page.waitForTimeout(350);
  const stillB = await captureHash(page);
  expect(stillB).toBe(stillA);
});
