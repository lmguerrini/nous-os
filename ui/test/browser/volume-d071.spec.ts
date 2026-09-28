import { expect, test, type Page } from "@playwright/test";

const url = process.env.D071_URL ?? "http://127.0.0.1:8768/";
test.skip(process.env.D071_BROWSER !== "1", "Set D071_BROWSER=1 and serve the review page");

type Witness = {
  volume: { eigenvalues: [number, number, number]; ratios: { second: number; third: number } };
  nodeViewport: Record<string, { x: number; y: number }>;
  layoutStats?: { bbox: { x: [number, number]; y: [number, number]; z: [number, number] } };
  communities?: { id: string; center: { x: number; y: number; z: number }; radius: number; count: number }[];
};

const ready = async (page: Page) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator("#status")).toContainText("Grafo pronto");
};

const witness = (page: Page) => page.evaluate(() => (window as any).__d067.witness() as Witness);

const setFlat3d = (page: Page) =>
  page.evaluate(() => (window as any).__d067.setAxes({ projection: "3d", organization: "flat", reading: "attested" }));

const setFlat2d = (page: Page) =>
  page.evaluate(() => (window as any).__d067.setAxes({ projection: "2d", organization: "flat", reading: "attested" }));

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
  // The default canonicalisation raises the default anisotropy above the pre-fix target of 0.25.
  expect(initial.volume.ratios.second).toBeGreaterThanOrEqual(0.5);
  expect(initial.volume.ratios.third).toBeGreaterThanOrEqual(0.3);

  await page.locator("#appearance-toggle").click();
  await page.locator("#equilibra-volume").click();
  await expect
    .poll(async () => (await witness(page)).volume.ratios.third, { timeout: 25000 })
    .toBeGreaterThanOrEqual(0.6);
  await expect
    .poll(async () => (await witness(page)).volume.ratios.second, { timeout: 25000 })
    .toBeGreaterThanOrEqual(0.6);
  const appearance = await page.evaluate(() => (window as any).__d067.appearance());
  expect(appearance.expandX).toBeGreaterThanOrEqual(0.3);
  expect(appearance.expandZ).toBeGreaterThanOrEqual(0.3);
});

test("D-071 Stellar overview exposes separated communities", async ({ page }) => {
  await ready(page);
  await setFlat3d(page);
  const scene = await witness(page);
  const communities = scene.communities ?? [];
  expect(communities.length).toBeGreaterThan(1);
  // Every visible node belongs to exactly one community summary.
  expect(communities.reduce((sum, community) => sum + community.count, 0)).toBe(
    Object.keys(scene.nodeViewport).length,
  );
  const meanRadius = communities.reduce((sum, community) => sum + community.radius, 0) / Math.max(1, communities.length);
  for (let a = 0; a < communities.length; a++) for (let b = a + 1; b < communities.length; b++) {
    const left = communities[a]!;
    const right = communities[b]!;
    const distance = Math.hypot(
      left.center.x - right.center.x,
      left.center.y - right.center.y,
      left.center.z - right.center.z,
    );
    expect(distance).toBeGreaterThanOrEqual(left.radius + right.radius + 1.5 * meanRadius - 1e-6);
  }
});

test("D-071 the volume line is hidden in 2D and shown in 3D", async ({ page }) => {
  await ready(page);
  await page.locator("#appearance-toggle").click();
  await setFlat2d(page);
  await expect(page.locator("#volume-stats")).toBeHidden();
  await setFlat3d(page);
  await expect(page.locator("#volume-stats")).toBeVisible();
  await expect(page.locator("#volume-stats")).toContainText("proporzioni 1 :");
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

test("D-071 switching morphology recomputes Flat positions and switching back restores them", async ({ page }) => {
  await ready(page);
  await setFlat2d(page);
  const bbox = async () => (await witness(page)).layoutStats?.bbox;
  await page.evaluate(() => (window as any).__d067.setAxes({ morphology: "stellar" }));
  const stellar = await bbox();
  await page.evaluate(() => (window as any).__d067.setAxes({ morphology: "neural" }));
  const neural = await bbox();
  await page.evaluate(() => (window as any).__d067.setAxes({ morphology: "mycelium" }));
  const mycelium = await bbox();
  await page.evaluate(() => (window as any).__d067.setAxes({ morphology: "stellar" }));
  const stellarAgain = await bbox();
  // Each morphology owns its own Flat layout; switching back to Stellar restores it exactly.
  expect(neural).not.toEqual(stellar);
  expect(mycelium).not.toEqual(stellar);
  expect(stellarAgain).toEqual(stellar);
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
