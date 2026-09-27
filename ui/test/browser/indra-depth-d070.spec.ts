import { expect, test } from '@playwright/test';

const url = process.env.D070_URL ?? process.env.D069_URL ?? 'http://127.0.0.1:8768/';
test.skip(process.env.D070_BROWSER !== '1', 'Set D070_BROWSER=1 and serve the review page');

test('D-070 absolute Indra, semantic arcs, and selectable pearls', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '2d', organization: 'indra', reading: 'attested' }));
  const scene = await page.evaluate(() => (window as any).__d067.witness());
  const outer = scene.containers.find((item: any) => item.level === 0);
  expect(outer?.title).toBe('NousOS');
  expect(scene.arcs.shown).toBeGreaterThan(0);
  expect(scene.arcs.shown).toBeLessThanOrEqual(160);
  expect(scene.relations.every((edge: any) => edge.type !== 'contains' && edge.type !== 'classified_in')).toBe(true);
  await expect(page.locator('#viewport canvas[data-morphology-canvas]')).toBeVisible();
  await page.evaluate((id) => (window as any).__d067.select(id), outer.id);
  expect((await page.evaluate(() => (window as any).__d067.witness())).emphasised.length).toBe(scene.disclosure.visible);
  await expect(page.locator('#details')).toContainText('Domini');
  const domain = scene.disclosure.nodes.find((item: any) => item.level === 1 && scene.disclosure.nodes.some((child: any) => child.parent === item.id));
  await page.evaluate((id) => (window as any).__d067.select(id), domain.id);
  const selected = await page.evaluate(() => (window as any).__d067.witness());
  expect(selected.emphasised).toContain(domain.id);
  expect(selected.emphasised.length).toBeGreaterThan(1);
  expect(selected.emphasised.length).toBeLessThan(scene.disclosure.visible);
  expect(Object.keys(selected.nodeViewport).length).toBe(scene.disclosure.visible);
});

test('D-070 Flat volume responds to depth and frames from useful views', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'flat', reading: 'attested' }));
  const initial = await page.evaluate(() => (window as any).__d067.witness());
  expect(initial.layoutStats.depthRatio).toBeGreaterThanOrEqual(0.4);
  const slider = page.locator('#appearance-depth3d');
  await slider.evaluate((input: HTMLInputElement) => { input.value = '1.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(async () => (await page.evaluate(() => (window as any).__d067.witness())).layoutStats.depthRatio).toBeGreaterThan(initial.layoutStats.depthRatio * 1.4);
  await page.evaluate(() => (window as any).__d067.fit());
  const fitted = await page.evaluate(() => (window as any).__d067.witness());
  const rect = fitted.visibleRect;
  expect(Object.values(fitted.nodeViewport).every((point: any) => point.x >= rect.left - 1 && point.x <= rect.left + rect.width + 1 && point.y >= rect.top - 1 && point.y <= rect.top + rect.height + 1)).toBe(true);
  for (const preset of ['fronte', 'destra', 'alto'] as const) {
    await page.evaluate(name => (window as any).__d067.viewPreset(name), preset);
    const witness = await page.evaluate(() => (window as any).__d067.witness());
    const positions = Object.values(witness.nodeViewport) as { x: number; y: number }[];
    const collided = positions.filter((point, index) => positions.slice(index + 1).some(other => Math.hypot(point.x - other.x, point.y - other.y) < 5)).length;
    expect(collided / Math.max(1, positions.length)).toBeLessThan(0.65);
  }
});
