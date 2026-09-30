import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { waitForCameraRest } from './camera-rest.ts';

test.skip(process.env.D073_BROWSER !== '1', 'Serve the D-073 review page with D073_BROWSER=1');

const baseUrl = process.env.D073_URL ?? 'http://127.0.0.1:8768/';
const pipelineUrl = process.env.D073_PIPELINE_URL ?? `${baseUrl.split('#')[0]}#projection=natural`;
const captureDir = process.env.D073_CAPTURE_DIR;
const morphologies = ['stellar', 'neural', 'mycelium'] as const;
const dimensions = ['2d', '3d'] as const;
const views = [
  { button: 'natural', algorithm: 'natural', camera: 'natural' },
  { button: 'indra', algorithm: 'indras-pearls', camera: 'indra' },
  { button: 'fractal', algorithm: 'fractal', camera: 'fractal' },
  { button: 'holographic', algorithm: 'holographic', camera: 'natural' },
] as const;

const axes = (page: Page, value: Record<string, unknown>) =>
  page.evaluate(next => (window as any).__d067.setAxes(next), value);
const witness = (page: Page) => page.evaluate(() => (window as any).__d067.witness());
const projectionWitness = (page: Page) => page.evaluate(() => {
  const api = window as any;
  const result = api.__d073?.projectionWitness?.() ?? api.__d067?.witness?.().projection;
  if (!result) throw new Error('D-073 projection witness is not exposed');
  return result;
});

async function ready(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(pipelineUrl);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator('#status')).toContainText('Grafo pronto');
  return errors;
}

async function installCanvasDashProbe(page: Page) {
  await page.addInitScript(() => {
    const calls: number[][] = [];
    let frames = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(timestamp => {
      frames += 1;
      callback(timestamp);
    });
    Object.defineProperty(window, '__d073FrameCount', { get: () => frames });
    const prototype = CanvasRenderingContext2D.prototype;
    const original = prototype.setLineDash;
    prototype.setLineDash = function (segments: number[]) {
      if (segments.length && segments.some(value => value > 0)) calls.push([...segments]);
      return original.call(this, segments);
    };
    Object.defineProperty(window, '__d073DashCalls', { get: () => calls });
  });
}

async function saveViewport(page: Page, info: TestInfo, view: string, dimension: string, morphology: string) {
  const filename = `views-matrix-${view}-${dimension}-${morphology}.png`;
  const path = captureDir ? join(captureDir, filename) : info.outputPath(filename);
  await mkdir(dirname(path), { recursive: true });
  await page.locator('#viewport').screenshot({ path });
}

async function waitForProjection(page: Page, view: string) {
  await expect.poll(async () => {
    try { return (await projectionWitness(page)).pending; } catch { return true; }
  }, { timeout: 90_000 }).toBe(false);
  const projection = await projectionWitness(page);
  expect(projection.enabled, `${view} projection pipeline enabled`).toBe(true);
  return projection;
}

async function assertDisclosure(page: Page, view: string, dimension: string) {
  const status = (await page.locator('#status').innerText()).toLowerCase();
  if (view === 'natural') {
    expect(status).not.toContain('geometria derivata, non semantica');
    const arrangement = (await projectionWitness(page)).arrangement;
    expect(typeof arrangement).toBe('string');
    const inspector = page.locator('#arrangement-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(String(arrangement));
  } else {
    expect(status).toContain('geometria derivata, non semantica');
  }
  if (view === 'indra') {
    expect(status).toContain("vista indra's pearls");
    expect(status).toMatch(/genere\s+\d+|impaccamento euclideo annidato/);
    expect(status).toMatch(/margine di separazione|nessun gruppo di schottky certificato/);
  } else if (view === 'fractal') {
    expect(status).toContain('vista fractal');
    expect(status).toMatch(/certificati p=[^,]+, c=/);
  } else {
    expect(status).toMatch(view === 'natural' ? /vista natural/ : /vista holographic/);
  }
  if (dimension === '3d' && view === 'indra') expect(status).toContain('3d: semisfera');
  if (dimension === '3d' && view === 'fractal') expect(status).toContain('3d: altezza');
}

async function assertLodBudget(page: Page) {
  const value = await witness(page);
  const lod = value.lod;
  expect(lod?.nodes?.rendered).toBeGreaterThan(0);
  expect(lod.nodes.available).toBeGreaterThan(0);
  expect(lod.nodes.rendered).toBeLessThanOrEqual(lod.nodes.available);
  if (lod?.arcs?.available > 0) expect(lod.arcs.rendered).toBeGreaterThan(0);
  expect(lod.arcs.rendered).toBeLessThanOrEqual(lod.arcs.available);
  const cap = value.disclosure?.cap;
  if (typeof cap === 'number') expect(lod.nodes.rendered).toBeLessThanOrEqual(cap);
  else if (cap && typeof cap.nodes === 'number') expect(lod.nodes.rendered).toBeLessThanOrEqual(cap.nodes);
}

async function assertExplanationCards(page: Page, view: string) {
  const nodeId = await page.evaluate(() => {
    const api = (window as any).__d067;
    const candidates = api.disclosure?.()?.nodes ?? api.witness?.()?.disclosure?.nodes ?? [];
    return candidates[0]?.id ?? null;
  });
  expect(nodeId, 'a disclosed source node is available to pick').toBeTruthy();
  await page.evaluate(id => (window as any).__d067.select(id), nodeId);
  const card = page.locator('#details .selection-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.projection-provenance')).toBeVisible();
  await expect(card).toContainText('Provenienza');

  const derivedPick = page.locator('#structural-pick-controls button[data-pick-kind]').first();
  await expect(derivedPick, `${view} exposes a pick for a derived element`).toBeVisible();
  await derivedPick.click();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Perché');
  await expect(card.locator('.projection-provenance')).toBeVisible();
  await expect(card.locator('.projection-witness, .projection-explanation')).toBeVisible();
}

for (const view of views) {
  for (const dimension of dimensions) {
    for (const morphology of morphologies) {
      test(`D-073 matrix ${view.button} ${dimension} ${morphology}`, async ({ page }, info) => {
        await installCanvasDashProbe(page);
        const errors = await ready(page);
        const button = page.locator(`header [data-axis="organization"] [data-value="${view.button}"]`).first();
        if (view.button === 'holographic' && !(await button.isVisible().catch(() => false))) {
          test.skip(true, 'Holographic control is unregistered/absent from this build.');
        }
        const fixedArrangement = view.button === 'natural' ? { arrangement: 'constellation' } : {};
        await axes(page, { projection: dimension, organization: view.button, morphology, reading: 'attested', ...fixedArrangement });
        const projection = await waitForProjection(page, view.button);
        await waitForCameraRest(page);
        expect(projection.organization).toBe(view.button);
        expect(projection.algorithm).toBe(view.algorithm);
        expect(projection.cameraKey).toBe(`${dimension}/${view.camera}`);
        await assertDisclosure(page, view.button, dimension);
        await assertLodBudget(page);
        await saveViewport(page, info, view.button, dimension, morphology);

        const stableDigest = projection.resultDigest;
        await axes(page, { morphology: morphology === 'stellar' ? 'neural' : 'stellar', ...fixedArrangement });
        const restyled = await waitForProjection(page, view.button);
        expect(restyled.resultDigest, 'morphology restyling preserves coordinates and result digest').toBe(stableDigest);
        await axes(page, { morphology, ...fixedArrangement });
        await waitForProjection(page, view.button);
        await waitForCameraRest(page);

        const idleFrames = await page.evaluate(async () => {
          const before = (window as any).__d073FrameCount ?? 0;
          await new Promise(resolve => setTimeout(resolve, 3000));
          return ((window as any).__d073FrameCount ?? 0) - before;
        });
        expect(idleFrames, `${view.button} ${dimension} idle attested frames`).toBeLessThanOrEqual(1);
        await assertExplanationCards(page, view.button);
        expect(await page.evaluate(() => (window as any).__d073DashCalls)).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  }
}
