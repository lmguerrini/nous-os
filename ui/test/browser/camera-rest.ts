import type { Page } from '@playwright/test';

/** Wait for two consecutive animation frames with the same camera pose. */
export async function waitForCameraRest(page: Page, timeoutMs = 2500): Promise<void> {
  await page.evaluate(async (timeout) => {
    const camera = () => JSON.stringify((window as any).__d067.camera());
    const start = performance.now();
    let previous = camera();
    let stillFrames = 0;
    await new Promise<void>((resolve, reject) => {
      const sample = () => {
        const current = camera();
        stillFrames = current === previous ? stillFrames + 1 : 0;
        if (stillFrames >= 2) { resolve(); return; }
        if (performance.now() - start > timeout) { reject(new Error(`Camera did not settle within ${timeout} ms`)); return; }
        previous = current;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }, timeoutMs);
}
