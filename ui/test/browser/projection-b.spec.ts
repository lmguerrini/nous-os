import { expect, test, type Page } from '@playwright/test';
import { waitForCameraRest } from './camera-rest.ts';

test.skip(process.env.D073_BROWSER !== '1', 'Serve the D-073 review page with D073_BROWSER=1');
const url = process.env.D073_URL ?? 'http://127.0.0.1:8768/';
const pipelineUrl = process.env.D073_PIPELINE_URL ?? url;

type ProjectionWitness = {
  resultDigest: string;
  enabled: boolean;
  [key: string]: unknown;
};

const ready = async (page: Page, target = url) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(target);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator('#status')).toContainText('Grafo pronto');
  return errors;
};

const instrumentFrames = async (page: Page) => page.addInitScript(() => {
  let count = 0;
  const request = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => request(timestamp => {
    count += 1;
    callback(timestamp);
  });
  Object.defineProperty(window, '__d073FrameCount', { get: () => count });
});

const witness = (page: Page) => page.evaluate(() => (window as any).__d067.witness());
const projectionWitness = async (page: Page): Promise<ProjectionWitness> => page.evaluate(() => {
  const api = (window as any).__d067;
  // The page may expose the B8 result through this read-only diagnostic
  // hook. The shipped page does not expose projectionPipeline in main.ts yet.
  const value = api.projectionWitness?.() ?? api.witness().projection;
  if (!value || typeof value.resultDigest !== 'string')
    throw new Error('D-073 browser bridge must expose projectionWitness().resultDigest for B12c');
  return value;
});

const setAxes = (page: Page, axes: Record<string, unknown>) =>
  page.evaluate(value => (window as any).__d067.setAxes(value), axes);

const typedHost = (page: Page) => page.locator('#render-root > .view-host').last();

test('D-073 pipeline off retains the D-072 page smoke behavior in 2D and 3D', async ({ page }) => {
  const errors = await ready(page);
  await setAxes(page, { projection: '2d', organization: 'flat', morphology: 'stellar' });
  await expect(page.locator('#viewport canvas').first()).toBeVisible();
  await expect(page.locator('#structural-pick-controls')).toBeHidden();
  const before = await witness(page);
  await setAxes(page, { projection: '3d' });
  await expect(page.locator('#viewport canvas').first()).toBeVisible();
  expect((await witness(page)).axes.projection).toBe('3d');
  expect(errors).toEqual([]);
  expect(before.lod).toBeTruthy();
});

test('D-073 Natural digest is morphology independent for one arrangement', async ({ page }) => {
  await ready(page, pipelineUrl);
  const digests: string[] = [];
  for (const morphology of ['stellar', 'neural', 'mycelium']) {
    await setAxes(page, { projection: '2d', organization: 'flat', morphology, reading: 'attested' });
    await waitForCameraRest(page);
    const projection = await projectionWitness(page);
    expect(projection.enabled, 'V2PageDeps.projectionPipeline is enabled').toBe(true);
    digests.push(projection.resultDigest);
  }
  expect(new Set(digests).size).toBe(1);
});

test('D-073 structural controls open a visual panel and never an attested relation', async ({ page }) => {
  const errors = await ready(page, pipelineUrl);
  await setAxes(page, { projection: '2d', organization: 'flat', morphology: 'stellar', reading: 'attested' });
  const controls = page.locator('#structural-pick-controls');
  await expect(controls).toBeVisible();
  const pick = controls.locator('button[data-pick-kind="visual-relation"]').first();
  await expect(pick).toBeVisible();
  await pick.click();
  await expect(page.locator('#details')).toContainText(/Co-appartenenza|Contenimento strutturale/);
  await expect(page.locator('#details')).toContainText(/Non semantica/);
  await expect(page.locator('#details')).toContainText(/non attestata/i);
  await expect(page.locator('#details')).not.toContainText(/relazione attestata/i);
  expect(errors).toEqual([]);
});

test('D-073 density and camera-level revisions retain host and camera without remount marks', async ({ page }) => {
  const errors = await ready(page, pipelineUrl);
  await setAxes(page, { projection: '2d', organization: 'flat', morphology: 'stellar', reading: 'attested' });
  await expect.poll(async () => (await projectionWitness(page)).enabled).toBe(true);
  await expect(typedHost(page)).toBeVisible();
  await typedHost(page).evaluate(node => { (node as HTMLElement).dataset.b12cHost = 'original'; });
  await waitForCameraRest(page);
  const camera = await page.evaluate(() => (window as any).__d067.cameraState());
  const initialLevel = (await witness(page)).lod.level;
  await page.evaluate(() => (window as any).__d067.setDensity('complete'));
  await expect.poll(async () => (await witness(page)).lod.density).toBe('complete');
  expect(await typedHost(page).getAttribute('data-b12c-host')).toBe('original');
  expect(await page.evaluate(() => (window as any).__d067.cameraState())).toEqual(camera);

  const box = await page.locator('#viewport').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -960);
  await waitForCameraRest(page);
  await expect.poll(async () => (await witness(page)).lod.level).not.toBe(initialLevel);
  expect(await typedHost(page).getAttribute('data-b12c-host')).toBe('original');
  const marks = await page.evaluate(() => (window as any).__d072?.marks?.());
  if (marks) expect(marks.remounts ?? marks.remount ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test('D-073 typed pipeline renders 2D and 3D and settles without an idle RAF', async ({ page }) => {
  await instrumentFrames(page);
  const errors = await ready(page, pipelineUrl);
  for (const projection of ['2d', '3d'] as const) {
    await setAxes(page, { projection, organization: 'flat', morphology: 'stellar', reading: 'attested' });
    await expect.poll(async () => (await projectionWitness(page)).enabled).toBe(true);
    await expect(page.locator('#viewport canvas').first()).toBeVisible();
    await waitForCameraRest(page);
    const idleFrames = await page.evaluate(async () => {
      const before = (window as any).__d073FrameCount as number;
      await new Promise(resolve => setTimeout(resolve, 5000));
      return (window as any).__d073FrameCount - before;
    });
    expect(idleFrames, `${projection} should have no idle RAF with attested reading`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
