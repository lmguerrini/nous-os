import { expect, test, type Page } from "@playwright/test";

const url = process.env.D071_URL ?? "http://127.0.0.1:8768/";
test.skip(process.env.D071_BROWSER !== "1", "Set D071_BROWSER=1 and serve the review page");

type Witness = {
  volume: { eigenvalues: [number, number, number]; ratios: { second: number; third: number } };
  nodeViewport: Record<string, { x: number; y: number }>;
};

const ready = async (page: Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

const witness = (page: Page) => page.evaluate(() => (window as any).__d067.witness() as Witness);

const setFlat3d = (page: Page) =>
  page.evaluate(() => (window as any).__d067.setAxes({ projection: "3d", organization: "flat", reading: "attested" }));

/** Minor/major extent ratio of a projected 2D point cloud (σ of the smaller PCA axis over the larger). */
function extentRatio(points: readonly { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 3) return 0;
  const cx = points.reduce((sum, p) => sum + p.x, 0) / n;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / n;
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= n;
  yy /= n;
  xy /= n;
  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const major = trace / 2 + disc;
  const minor = Math.max(0, trace / 2 - disc);
  return major < 1e-12 ? 0 : Math.sqrt(minor / major);
}

test("D-071 real overview reaches the volume thresholds and equilibrates", async ({ page }) => {
  await ready(page);
  await setFlat3d(page);
  const initial = await witness(page);
  expect(initial.volume.eigenvalues[0]).toBeGreaterThanOrEqual(initial.volume.eigenvalues[2]);
  expect(initial.volume.ratios.third).toBeGreaterThanOrEqual(0.25);

  await page.locator("#appearance-toggle").click();
  await page.locator("#equilibra-volume").click();
  await expect
    .poll(async () => (await witness(page)).volume.ratios.third, { timeout: 25000 })
    .toBeGreaterThanOrEqual(0.6);
  const appearance = await page.evaluate(() => (window as any).__d067.appearance());
  expect(appearance.expandX).toBeGreaterThanOrEqual(0.3);
  expect(appearance.expandZ).toBeGreaterThanOrEqual(0.3);
});

test("D-071 Front, Side and Top views never collapse into a strip", async ({ page }) => {
  await ready(page);
  await setFlat3d(page);
  await page.evaluate(() => (window as any).__d067.fit());
  for (const preset of ["fronte", "destra", "alto"] as const) {
    await page.evaluate((name) => (window as any).__d067.viewPreset(name), preset);
    await page.waitForTimeout(120);
    const positions = Object.values((await witness(page)).nodeViewport);
    expect(positions.length).toBeGreaterThan(30);
    expect(extentRatio(positions)).toBeGreaterThanOrEqual(0.25);
  }
});

test("D-071 witness positions are identical after reload", async ({ page }) => {
  await ready(page);
  await setFlat3d(page);
  await page.evaluate(() => (window as any).__d067.fit());
  const read = async () =>
    page.evaluate(() => {
      const w = (window as any).__d067.witness();
      return {
        volume: w.volume.eigenvalues,
        positions: Object.entries(w.nodeViewport)
          .map(([id, point]) => [id, Math.round((point as { x: number; y: number }).x * 1e3) / 1e3, Math.round((point as { x: number; y: number }).y * 1e3) / 1e3])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      };
    });
  const before = await read();
  await page.reload();
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
  await setFlat3d(page);
  await page.evaluate(() => (window as any).__d067.fit());
  await expect
    .poll(read, { timeout: 25000 })
    .toEqual(before);
});
