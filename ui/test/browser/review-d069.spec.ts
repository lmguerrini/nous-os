import { test, expect } from "@playwright/test";

const url = process.env.D069_URL ?? "http://127.0.0.1:8767/";
const ready = async (page: import("@playwright/test").Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};
const pose = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__d067.camera());
const distance = (p: { position: number[]; target: number[] }) =>
  Math.hypot(...p.position.map((value, index) => value - p.target[index]!));

test("D-069 camera, Focus, controls and persistence over the served export", async ({ page }) => {
  await ready(page);
  await page.locator('[data-axis="projection"] [data-value="3d"]').click();
  const canvas = page.locator("#viewport canvas").first();
  await expect(page.locator("#gizmo")).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const before = await pose(page);
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .85, { steps: 12 });
  await page.mouse.up();
  const rotated = await pose(page);
  expect(rotated.up).not.toEqual(before.up);
  const line = await page.locator("#axis-z").getAttribute("y2");
  expect(line).not.toBeNull();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .6, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const panned = await pose(page);
  expect(panned.target).not.toEqual(rotated.target);
  await canvas.hover();
  await page.mouse.wheel(0, -240);
  expect(distance(await pose(page))).toBeLessThan(distance(panned));
  await page.locator("#view-preset-menu summary").click();
  for (const name of ["fronte", "retro", "sinistra", "destra", "alto", "basso"] as const) {
    await page.locator(`[data-preset="${name}"]`).click();
    const p = await pose(page);
    const direction = p.position.map((value: number, index: number) => value - p.target[index]);
    if (name === "alto") expect(direction[2]).toBeGreaterThan(0);
    if (name === "basso") expect(direction[2]).toBeLessThan(0);
    if (name === "sinistra") expect(direction[1]).toBeLessThan(0);
    if (name === "destra") expect(direction[1]).toBeGreaterThan(0);
  }
  await page.locator('#gizmo button[data-axis-end="z"]').click();
  expect((await pose(page)).position[2]).toBeGreaterThan((await pose(page)).target[2]);
  const node = await page.evaluate(() => {
    const w = (window as any).__d067.witness();
    return Object.entries(w.nodeViewport).find(([, point]: any) => point.x > w.visibleRect.left + 50 && point.x < w.visibleRect.left + w.visibleRect.width - 50
      && point.y > w.visibleRect.top + 50 && point.y < w.visibleRect.top + w.visibleRect.height - 50)?.[0];
  });
  expect(node).toBeTruthy();
  const point = await page.evaluate((id) => (window as any).__d067.witness().nodeViewport[id], node!);
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(async () => page.evaluate(() => (window as any).__d067.state().selected)).toBe(node);
  await expect.poll(async () => {
    const w = await page.evaluate(() => (window as any).__d067.witness());
    const p = w.nodeViewport[node!];
    return Math.hypot(p.x - (w.visibleRect.left + w.visibleRect.width / 2), p.y - (w.visibleRect.top + w.visibleRect.height / 2));
  }).toBeLessThanOrEqual(2);
  await expect(page.locator("#projection-focus")).toBeEnabled();
  await page.locator("#projection-focus").click();
  await expect.poll(async () => page.evaluate(() => (window as any).__d067.focusMode)).toBe(true);
  const focused = await page.evaluate(() => (window as any).__d067.witness());
  for (const id of focused.emphasised) {
    const p = focused.nodeViewport[id];
    if (p) expect(p.x).toBeGreaterThanOrEqual(focused.visibleRect.left - 2);
  }
  await page.locator("#fullscreen").click();
  await expect.poll(async () => page.evaluate(() => (window as any).__d067.fullscreen())).toBe(true);
  await page.locator("#fullscreen-panel").click();
  await expect(page.locator("#details")).toBeVisible();
  await page.locator("#fullscreen-exit").click();
  await expect.poll(async () => page.evaluate(() => (window as any).__d067.fullscreen())).toBe(false);
  const wide = await page.locator("#viewport").boundingBox();
  await page.locator("#panel-toggle").click();
  const changed = await page.locator("#viewport").boundingBox();
  expect(changed!.width).not.toEqual(wide!.width);
  await page.locator("#fit").click();
  await expect(page.locator("#toast")).toContainText("Vista adattata");
  const fitted = await page.evaluate(() => (window as any).__d067.witness());
  for (const p of Object.values(fitted.nodeViewport) as any[]) {
    expect(p.x).toBeGreaterThanOrEqual(fitted.visibleRect.left - 2);
    expect(p.x).toBeLessThanOrEqual(fitted.visibleRect.left + fitted.visibleRect.width + 2);
  }
  await page.locator("#appearance-toggle").click();
  await page.locator("#appearance-nodeScale").fill("1.4");
  await page.locator("#preset-name").fill("Locale D069");
  await page.locator("#preset-save").click();
  await page.locator("#palette").selectOption("warm");
  await page.reload();
  await page.evaluate(() => (window as any).__d067.ready);
  expect(await page.evaluate(() => (window as any).__d067.palette().name)).toBe("warm");
  expect(await page.evaluate(() => (window as any).__d067.appearance().nodeScale)).toBe(1.4);
  await page.locator("#appearance-toggle").click();
  await expect(page.locator("#preset-list option")).toContainText(["Preset salvati", "Locale D069"]);
  await page.locator("#reset").click();
  await expect(page.locator("#toast")).toContainText("Reimpostati camera, focus e aspetto");
  expect(await page.evaluate(() => (window as any).__d067.appearance().nodeScale)).toBe(1);
  await expect(page.locator("body")).not.toContainText(/lente|noetico|Pythagorean|Lullian|Yi Jing|Brunian/i);
});

test("D-069 layout has no horizontal page overflow", async ({ page }) => {
  for (const width of [1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
  }
});
