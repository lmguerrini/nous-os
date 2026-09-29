import { expect, test } from "@playwright/test";
import { waitForCameraRest } from "./camera-rest.ts";

test.skip(process.env.D072_BROWSER !== "1", "Serve the review page with D072_BROWSER=1");
const url = process.env.D072_URL ?? "http://127.0.0.1:8768/";

test("D072 selection just after the 3D switch wins framing and keeps its camera target", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: "3d" }));
  const id = await page.evaluate(() => Object.keys((window as any).__d067.witness().nodeViewport)[0]);
  expect(id).toBeTruthy();
  if (!id) throw new Error("No visible node available for the camera-intent check");
  await waitForCameraRest(page);
  const overviewTarget = await page.evaluate(() => (window as any).__d067.camera().target as number[]);
  await page.evaluate(nodeId => (window as any).__d067.select(nodeId), id);
  await waitForCameraRest(page);
  const framed = await page.evaluate(nodeId => {
    const api = (window as any).__d067;
    const witness = api.witness();
    const rect = witness.visibleRect;
    const point = witness.nodeViewport[nodeId];
    return {
      selected: api.state().selected === nodeId,
      target: api.camera().target as number[],
      point,
      rect,
    };
  }, id);
  expect(framed.selected).toBe(true);
  expect(framed.point).toBeTruthy();
  expect(Math.hypot(...framed.target.map((value, index) => value - overviewTarget[index]!))).toBeGreaterThan(1e-4);
  const centerX = framed.rect.left + framed.rect.width / 2;
  const centerY = framed.rect.top + framed.rect.height / 2;
  expect(framed.point.x).toBeGreaterThanOrEqual(framed.rect.left);
  expect(framed.point.x).toBeLessThanOrEqual(framed.rect.left + framed.rect.width);
  expect(framed.point.y).toBeGreaterThanOrEqual(framed.rect.top);
  expect(framed.point.y).toBeLessThanOrEqual(framed.rect.top + framed.rect.height);
  expect(Math.hypot(framed.point.x - centerX, framed.point.y - centerY)).toBeLessThanOrEqual(100);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (window as any).__d067.camera().target);
  expect(after).toEqual(framed.target);
});
