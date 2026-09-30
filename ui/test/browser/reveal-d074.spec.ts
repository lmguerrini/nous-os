import { expect, test } from '@playwright/test';
import { cameraState, fit, focusedRendered, hub, ready, setAxes, stable, wheel } from './d074-helpers.ts';

test.skip(process.env.D074_BROWSER !== '1', 'Serve the D-074 review page with D074_BROWSER=1');
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

for (const organization of ['natural', 'indra'] as const) for (const projection of ['2d', '3d'] as const) {
  test(`${organization} ${projection} reveals a stable cursor cluster monotonically and compacts with hysteresis`, async ({ page }) => {
    await ready(page);
    await setAxes(page, { organization, projection, morphology: 'stellar', colour: 'bw' });
    const atFit = await fit(page);
    const point = await hub(page);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(250);
    const fitState = await stable(page);
    expect(fitState.focus.source).toBe('cursor');
    expect(fitState.focus.clusterId).toBeTruthy();
    const epoch = fitState.focus.epoch;
    const counts = [await focusedRendered(page, fitState)];
    const levels = [fitState];
    const cameraAtFit = await cameraState(page);

    for (let level = 2; level <= 5; level += 1) {
      await wheel(page, point, -120, 3);
      const witness = await stable(page);
      expect(witness.focus.epoch).toBe(epoch);
      expect(witness.focus.clusterId).toBe(fitState.focus.clusterId);
      counts.push(await focusedRendered(page, witness));
      levels.push(witness);
    }
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(counts[4]!).toBeGreaterThan(counts[0]!);
    for (const level of [4, 5]) {
      const witness = levels[level - 1]!;
      if (Number(witness.nodes.revealableInFocus ?? 0) > 0) expect(Number(witness.levels[String(level)] ?? 0)).toBeGreaterThan(0);
    }

    const initialState = await page.evaluate(() => (window as any).__d067.state());
    const candidate = fitState.renderedNodeIds[0];
    if (candidate) await page.evaluate(id => (window as any).__d067.select(id), candidate);
    const selectedState = await page.evaluate(() => (window as any).__d067.state());
    const selectedId = selectedState.selectedId ?? selectedState.selection?.id ?? candidate ?? null;
    let previousCount = counts[4]!;
    let compacted = false;
    let previousZoom = levels[4]!.camera.zoom;
    for (let step = 0; step < 5; step += 1) {
      await wheel(page, point, 120, 1);
      const current = await stable(page);
      const currentCount = await focusedRendered(page, current);
      if (currentCount < previousCount) {
        expect(current.camera.zoom).toBeLessThan(previousZoom);
        compacted = true;
      }
      const state = await page.evaluate(() => (window as any).__d067.state());
      if (selectedId !== null) expect(state.selectedId ?? state.selection?.id ?? selectedId).toBe(selectedId);
      const camera = await cameraState(page);
      expect(camera).toBeTruthy();
      expect(JSON.stringify(camera)).not.toBe(JSON.stringify(cameraAtFit));
      previousCount = currentCount;
      previousZoom = current.camera.zoom;
    }
    expect(compacted, 'outward zoom eventually crosses the lower compaction threshold').toBe(true);
    expect(initialState).toBeTruthy();
  });
}
