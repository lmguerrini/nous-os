import { expect, test } from "@playwright/test";
import { waitForCameraRest } from "./camera-rest.ts";

test.skip(process.env.D072_BROWSER !== "1", "Serve the review page with D072_BROWSER=1");
const url = process.env.D072_URL ?? "http://127.0.0.1:8768/";

test("D072 selection just after the 3D switch keeps its camera target", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: "3d" }));
  const id = await page.evaluate(() => Object.keys((window as any).__d067.witness().nodeViewport)[0]);
  expect(id).toBeTruthy();
  await page.evaluate(nodeId => (window as any).__d067.select(nodeId), id);
  await waitForCameraRest(page);
  const target = await page.evaluate(() => (window as any).__d067.camera().target);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (window as any).__d067.camera().target);
  expect(after).toEqual(target);
});
