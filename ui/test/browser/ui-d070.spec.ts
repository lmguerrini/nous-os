import { test, expect } from "@playwright/test";
import { decodePng } from "./png-codec.ts";

const url = process.env.D069_URL ?? "http://127.0.0.1:8768/";
const ready = async (page: import("@playwright/test").Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

test("D-070 Custom edits rendered pixels live and persists named presets", async ({ page }) => {
  await ready(page);
  await page.locator("#palette").selectOption("amber");
  await page.locator("#edit-colours").click();
  await expect(page.locator("#custom-editor")).toBeVisible();
  await expect(page.locator("#custom-colours .colour-row")).toHaveCount(9);
  await expect(page.locator("#custom-selected")).toContainText("Ambra");
  const before = decodePng(await page.locator("#render-root").screenshot(), "before Custom");
  await page.locator("#hex-aggregate").fill("#00ff88");
  await expect.poll(() => page.evaluate(() => (window as any).__d067.palette().values.aggregate)).toBe("#00ff88");
  await page.waitForTimeout(200);
  const after = decodePng(await page.locator("#render-root").screenshot(), "after Custom");
  expect([...after.data].some((value, index) => value !== before.data[index])).toBe(true);
  await page.locator("#colour-preset-name").fill("Studio");
  await page.locator("#custom-save").click();
  await expect(page.locator("#custom-storage")).toContainText("localStorage");
  await page.locator("#custom-restore").click();
  await expect.poll(() => page.evaluate(() => (window as any).__d067.palette().values.aggregate)).toBe("#ffd38b");
  await page.reload();
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#custom-editor")).toBeVisible();
  await page.locator("#colour-preset-list").selectOption("Studio");
  await page.locator("#custom-apply").click();
  await expect.poll(() => page.evaluate(() => (window as any).__d067.palette().values.aggregate)).toBe("#00ff88");
});

test("D-070 compact toolbar, fullscreen disclosure and gizmo", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#view-presets")).toBeHidden();
  for (const width of [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll("header button, header select, header summary")].filter(el => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0).every(el => el.getBoundingClientRect().right <= innerWidth))).toBe(true);
  }
  await page.locator('[data-axis="projection"] [data-value="3d"]').click();
  await expect(page.locator("#view-presets")).toBeVisible();
  await expect(page.locator("#gizmo")).toBeVisible();
  const inside = await page.evaluate(() => {
    const viewport = document.getElementById("viewport")!.getBoundingClientRect();
    const gizmo = document.getElementById("gizmo")!.getBoundingClientRect();
    return gizmo.width >= 96 && gizmo.height >= 96 && gizmo.left >= viewport.left + 12 && gizmo.right <= viewport.right - 12 && gizmo.bottom <= viewport.bottom - 12;
  });
  expect(inside).toBe(true);
  for (const axis of ["x", "y", "z"]) await expect(page.locator(`#gizmo button[data-axis-end="${axis}"]`)).toBeVisible();
  await page.locator("#fullscreen").click();
  await expect(page.locator("#fullscreen-bar")).toBeVisible();
  await page.locator("#fullscreen-collapse").click();
  await expect(page.locator("#fullscreen-fit")).toBeHidden();
  await page.keyboard.press("t");
  await expect(page.locator("#fullscreen-fit")).toBeVisible();
  await page.locator("#immersive-toggle").click();
  await expect(page.locator("#fullscreen-fit")).toBeHidden();
  await expect(page.locator("#fullscreen-appearance")).toBeVisible();
  await expect(page.locator('#fullscreen-bar [data-axis="morphology"]')).toBeVisible();
  await expect(page.locator('#fullscreen-bar [data-axis="organization"]')).toBeVisible();
  await expect(page.locator('#fullscreen-bar [data-axis="reading"]')).toBeVisible();
  await page.locator("#fullscreen-exit").click();
});
