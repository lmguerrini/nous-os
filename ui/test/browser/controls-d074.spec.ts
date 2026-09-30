import { expect, test } from '@playwright/test';
import { cameraState, fit, hub, nodeViewport, pixelDifference, ready, setAxes, stable, viewportPixels } from './d074-helpers.ts';

test.skip(process.env.D074_BROWSER !== '1', 'Serve the D-074 review page with D074_BROWSER=1');
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

const base = process.env.D074_URL;
const target = (experimental?: string) => {
  if (!base) throw new Error('D074_URL is required');
  const url = new URL(base);
  if (experimental) url.hash = `experimental=${experimental}`;
  return url.href;
};

for (const organization of ['natural', 'indra', 'fractal'] as const) {
  test(`${organization} 3D controls rotate, zoom toward the cursor, and pan nodes on screen`, async ({ page }) => {
    await ready(page, target(organization === 'fractal' ? 'fractal' : undefined));
    await setAxes(page, { organization, projection: '3d', morphology: 'stellar', colour: 'bw', ...(organization === 'fractal' ? { experimental: true } : {}) });
    await fit(page);
    const point = await hub(page);

    const beforeRotate = await viewportPixels(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(point.x + 200, point.y + 55, { steps: 12 });
    await page.mouse.up({ button: 'left' });
    await stable(page);
    expect(pixelDifference(beforeRotate, await viewportPixels(page))).toBeGreaterThan(0.001);

    await fit(page);
    const wheelPoint = await hub(page);
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    const beforeWheelCamera = await cameraState(page);
    const beforeWheelNodes = await nodeViewport(page);
    const beforeWheelRaster = await viewportPixels(page);
    await page.mouse.wheel(0, -120);
    await stable(page);
    const afterWheelCamera = await cameraState(page);
    const afterWheelNodes = await nodeViewport(page);
    expect(JSON.stringify(beforeWheelCamera)).not.toBe(JSON.stringify(afterWheelCamera));
    const zoomKeys = ['zoom', 'distance', 'ratio', 'fov'];
    const oldZoom = zoomKeys.map(key => Number(beforeWheelCamera?.[key])).find(Number.isFinite);
    const newZoom = zoomKeys.map(key => Number(afterWheelCamera?.[key])).find(Number.isFinite);
    expect(oldZoom, 'cameraState exposes a zoom-like scalar').toBeDefined();
    expect(newZoom, 'cameraState exposes a zoom-like scalar').toBeDefined();
    const proportionalStep = Math.abs(newZoom! - oldZoom!) / Math.max(Math.abs(oldZoom!), 1e-9);
    expect(proportionalStep, 'first wheel step after fit is proportionate').toBeGreaterThan(0.001);
    expect(proportionalStep).toBeLessThan(0.5);
    if (wheelPoint.id && beforeWheelNodes[wheelPoint.id] && afterWheelNodes[wheelPoint.id]) {
      const a = beforeWheelNodes[wheelPoint.id]!;
      const b = afterWheelNodes[wheelPoint.id]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y), 'the node under the cursor remains its zoom anchor').toBeLessThan(45);
    }
    expect(pixelDifference(beforeWheelRaster, await viewportPixels(page))).toBeGreaterThan(0.0005);

    await fit(page);
    const panPoint = await hub(page);
    const beforePanNodes = await nodeViewport(page);
    const beforePanRaster = await viewportPixels(page);
    await page.mouse.move(panPoint.x, panPoint.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(panPoint.x + 180, panPoint.y + 80, { steps: 12 });
    await page.mouse.up({ button: 'right' });
    await stable(page);
    const afterPanNodes = await nodeViewport(page);
    const common = Object.keys(beforePanNodes).filter(id => afterPanNodes[id]);
    const dx = common.reduce((sum, id) => sum + afterPanNodes[id]!.x - beforePanNodes[id]!.x, 0) / Math.max(common.length, 1);
    const dy = common.reduce((sum, id) => sum + afterPanNodes[id]!.y - beforePanNodes[id]!.y, 0) / Math.max(common.length, 1);
    expect(common.length).toBeGreaterThan(0);
    expect(dx).toBeGreaterThan(3);
    expect(dy).toBeGreaterThan(1);
    expect(pixelDifference(beforePanRaster, await viewportPixels(page))).toBeGreaterThan(0.001);
  });
}
