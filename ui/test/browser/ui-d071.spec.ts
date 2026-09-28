import { test, expect } from "@playwright/test";

const url = process.env.D069_URL ?? "http://127.0.0.1:8768/";
const ready = async (page: import("@playwright/test").Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};
const pose = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__d067.camera());
const witness = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__d067.witness());

/** Assert the current state keeps every label on canvas, under the budget, and never overlapping. */
async function assertLabels(page: import("@playwright/test").Page) {
  await page.waitForTimeout(250);
  const w = await witness(page);
  const labels = w.labels ?? [];
  expect(labels.length, "label budget").toBeLessThanOrEqual(60);
  const r = w.visibleRect;
  for (const label of labels) {
    const b = label.rect;
    expect(b.left, `label ${label.id} left`).toBeGreaterThanOrEqual(r.left - 2);
    expect(b.top, `label ${label.id} top`).toBeGreaterThanOrEqual(r.top - 2);
    expect(b.left + b.width, `label ${label.id} right`).toBeLessThanOrEqual(r.left + r.width + 2);
    expect(b.top + b.height, `label ${label.id} bottom`).toBeLessThanOrEqual(r.top + r.height + 2);
  }
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!.rect, b = labels[j]!.rect;
      const overlap = a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
      expect(overlap, `labels ${labels[i]!.id} / ${labels[j]!.id} overlap`).toBe(false);
    }
}

test("D-071 panel toggle hides and shows the panel, preserving camera and selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await page.locator('[data-axis="projection"] [data-value="3d"]').click();
  await expect(page.locator("#gizmo")).toBeVisible();
  const id = await page.evaluate(() => {
    const w = (window as any).__d067.witness();
    return Object.keys(w.nodeViewport)[0] as string;
  });
  await page.evaluate((nodeId) => (window as any).__d067.select(nodeId), id);
  await expect.poll(() => page.evaluate(() => (window as any).__d067.state().selected)).toBe(id);
  const beforePose = await pose(page);
  const beforeWidth = (await page.locator("#viewport").boundingBox())!.width;
  await expect(page.locator("#panel-edge-toggle")).toBeVisible();
  await page.locator("#panel-edge-toggle").click();
  await expect(page.locator("main#shell")).toHaveClass(/panel-collapsed/);
  await expect(page.locator("#details")).toBeHidden();
  const afterPose = await pose(page);
  expect(afterPose).not.toBeNull();
  for (const key of ["position", "target", "up"] as const) {
    const a = beforePose![key], b = afterPose![key];
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!), `camera ${key}[${i}]`).toBeLessThanOrEqual(1e-6);
  }
  expect(Math.abs(beforePose!.fov - afterPose!.fov)).toBeLessThanOrEqual(1e-6);
  expect(await page.evaluate(() => (window as any).__d067.state().selected)).toBe(id);
  const afterWidth = (await page.locator("#viewport").boundingBox())!.width;
  expect(afterWidth).toBeGreaterThan(beforeWidth);
  await page.locator("#panel-edge-toggle").click();
  await expect(page.locator("#details")).toBeVisible();
  expect((await pose(page))!.target).toEqual(beforePose!.target);
});

test("D-071 panel state is remembered after reload and the keyboard shortcut works", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await expect(page.locator("#details")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.locator("main#shell")).toHaveClass(/panel-collapsed/);
  await page.reload();
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("main#shell")).toHaveClass(/panel-collapsed/);
  await expect(page.locator("#details")).toBeHidden();
  await page.keyboard.press("p");
  await expect(page.locator("#details")).toBeVisible();
});

test("D-071 colour harmony preview appears and applies", async ({ page }) => {
  await ready(page);
  await page.locator("#palette").selectOption("amber");
  await page.locator("#edit-colours").click();
  await expect(page.locator("#custom-editor")).toBeVisible();
  const before = await page.evaluate(() => (window as any).__d067.palette().values.aggregate);
  await page.locator("#harmony-reference").evaluate((el) => { (el as HTMLInputElement).value = "#ff4040"; });
  await page.locator("#harmony-name").selectOption("triadic");
  await page.locator("#harmony-preview").click();
  await expect(page.locator("#harmony-swatches")).toBeVisible();
  await expect(page.locator("#harmony-swatches .h-swatch")).toHaveCount(9);
  await page.locator("#harmony-apply").click();
  await expect.poll(() => page.evaluate(() => (window as any).__d067.palette().values.aggregate)).not.toBe(before);
  const values = await page.evaluate(() => (window as any).__d067.palette().values);
  const contrast = await page.evaluate(({ text, background }) => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const c = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    };
    const pair = [luminance(text), luminance(background)].sort((x, y) => y - x);
    return (pair[0]! + 0.05) / (pair[1]! + 0.05);
  }, { text: values.text, background: values.background });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator("#contrast-warning")).toContainText("Contrasto sufficiente");
});

test("D-071 labels stay within budget, on canvas and non-overlapping across capture states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  const states = [
    { projection: "2d", morphology: "stellar", organization: "flat" },
    { projection: "2d", morphology: "neural", organization: "flat" },
    { projection: "2d", morphology: "mycelium", organization: "flat" },
    { projection: "3d", morphology: "stellar", organization: "flat" },
    { projection: "3d", morphology: "stellar", organization: "indra" },
    { projection: "3d", morphology: "neural", organization: "indra" },
    { projection: "3d", morphology: "mycelium", organization: "indra" },
  ];
  for (const axes of states) {
    await page.evaluate((next) => (window as any).__d067.setAxes(next), axes);
    await assertLabels(page);
  }
});
