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
  { button: 'natural', algorithm: 'natural' },
  { button: 'indra', algorithm: 'indras-pearls' },
  { button: 'fractal', algorithm: 'fractal' },
  { button: 'holographic', algorithm: 'holographic' },
] as const;

const axes = (page: Page, value: Record<string, unknown>) =>
  page.evaluate(next => (window as any).__d067.setAxes(next), value);
const witness = (page: Page) => page.evaluate(() => (window as any).__d067.witness());
const projectionWitness = (page: Page) => page.evaluate(() => {
  const api = window as any;
  const result = api.__d073?.projectionWitness?.() ?? api.__d067?.witness?.().projection;
  return result ?? null;
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
    try {
      const projection = await projectionWitness(page);
      return projection ? projection.pending : view === 'natural' ? false : true;
    } catch { return true; }
  }, { timeout: 90_000 }).toBe(false);
  const projection = await projectionWitness(page);
  if (!projection && view === 'natural') return null;
  if (!projection) throw new Error('D-073 projection witness is not exposed');
  expect(projection.enabled, `${view} projection pipeline enabled`).toBe(true);
  return projection;
}

async function assertDisclosure(page: Page, view: string, dimension: string) {
  const status = (await page.locator('#status').innerText()).toLowerCase();
  if (view === 'natural') {
    expect(status).not.toContain('geometria derivata, non semantica');
    const projection = await projectionWitness(page);
    const inspector = page.locator('#arrangement-inspector');
    await expect(inspector).toBeVisible();
    if (projection) {
      expect(typeof projection.arrangement).toBe('string');
      await expect(inspector).toContainText(String(projection.arrangement));
    } else {
      await expect(inspector).toContainText('constellation');
    }
  } else if (view !== 'holographic') {
    expect(status).toContain('geometria derivata, non semantica');
  }
  if (view === 'indra') {
    expect(status).toContain("vista indra's pearls");
    expect(status).toMatch(/genere\s+\d+|impaccamento euclideo annidato/);
    expect(status).toMatch(/margine di separazione|nessun gruppo di schottky certificato/);
  } else if (view === 'fractal') {
    expect(status).toContain('vista fractal');
    expect(status).toMatch(/certificati p=[^,]+, c=/);
  } else if (view === 'holographic') {
    expect(status).toContain('vista holographic');
  }
  if (dimension === '3d' && view === 'indra') expect(status).toContain('3d: semisfera');
  if (dimension === '3d' && view === 'fractal') expect(status).toContain('3d: altezza');
}

async function assertLodBudget(page: Page, checkCap = true) {
  const value = await witness(page);
  const lod = value.lod;
  expect(lod?.nodes?.rendered).toBeGreaterThan(0);
  expect(lod.nodes.available).toBeGreaterThan(0);
  expect(lod.nodes.rendered).toBeLessThanOrEqual(lod.nodes.available);
  if (lod?.arcs?.available > 0) expect(lod.arcs.rendered).toBeGreaterThan(0);
  expect(lod.arcs.rendered).toBeLessThanOrEqual(lod.arcs.available);
  if (checkCap) {
    const cap = value.disclosure?.cap;
    if (typeof cap === 'number') expect(lod.nodes.rendered).toBeLessThanOrEqual(cap);
    else if (cap && typeof cap.nodes === 'number') expect(lod.nodes.rendered).toBeLessThanOrEqual(cap.nodes);
  }
}

async function assertExplanationCards(page: Page, view: string) {
  const selectedNode = await page.evaluate(() => {
    const api = (window as any).__d067;
    const candidates = api.disclosure?.()?.nodes ?? api.witness?.()?.disclosure?.nodes ?? [];
    const node = candidates[0];
    return node ? { id: node.id, label: node.display_label ?? node.title } : null;
  });
  expect(selectedNode, 'a disclosed source node is available to pick').toBeTruthy();
  await page.evaluate(id => (window as any).__d067.select(id), selectedNode!.id);

  const projection = await projectionWitness(page);
  const sourceCard = view === 'holographic'
    ? page.locator('#details .selection-card').filter({ hasNot: page.locator('.projection-provenance') }).last()
    : page.locator('#details .selection-card').first();
  await expect(sourceCard, `${view} keeps the selected source card`).toBeVisible();
  if (view === 'natural') {
    await expect(sourceCard).toContainText(selectedNode!.label);
    await expect(sourceCard).not.toContainText('relazione attestata');

    const structuralControls = page.locator('#structural-pick-controls');
    const derivedPick = structuralControls.locator('button[data-pick-kind]').first();
    const emptyState = structuralControls.locator('[data-structural-empty]');
    if (await emptyState.isVisible().catch(() => false) || await derivedPick.count() === 0) return;

    await derivedPick.click();
    const derivedCard = page.locator('#details .selection-card').first();
    await expect(derivedCard).toBeVisible();
    await expect(derivedCard).not.toContainText('relazione attestata');
    return;
  }

  if (view === 'holographic') {
    const structuralControls = page.locator('#structural-pick-controls');
    await expect(structuralControls).toBeVisible();
    await expect(structuralControls.locator('button[data-pick-kind="visual-relation"], button[data-pick-kind="container"]')).toHaveCount(0);
    await expect(structuralControls.locator('[data-structural-empty]')).toBeVisible();

    const region = page.locator('#holographic-region');
    await expect(region).toBeVisible();
    const regionOptions = await region.locator('option').count();
    expect(regionOptions, 'Holographic offers at least one witness region').toBeGreaterThan(0);
    await region.selectOption({ index: regionOptions > 1 ? 1 : 0 });
    const witnessCard = page.locator('#holographic-witness .selection-card');
    await expect(witnessCard).toBeVisible();
    await expect(witnessCard.locator('.projection-provenance')).toBeVisible();
    await expect(witnessCard).toContainText('Provenienza');

    const channel = page.locator('#holographic-channel');
    await expect(channel).toBeVisible();
    const channelOptions = await channel.locator('option').count();
    expect(channelOptions, 'Holographic exposes multiple drawable field channels').toBeGreaterThan(1);
    const before = await projectionWitness(page);
    const currentChannel = await channel.inputValue();
    const nextChannel = await channel.locator('option').evaluateAll((options, current) =>
      (options as HTMLOptionElement[]).find(option => option.value !== current)?.value ?? null, currentChannel);
    expect(nextChannel).toBeTruthy();
    await channel.selectOption(nextChannel!);
    await expect.poll(async () => (await projectionWitness(page))?.holographic?.channel).toBe(nextChannel);
    const after = await projectionWitness(page);
    expect(after?.resultDigest, 'changing a Holographic channel does not create a new projection').toBe(before?.resultDigest);
    expect(after?.holographic?.drawnFieldIds).not.toEqual(before?.holographic?.drawnFieldIds);
    return;
  }

  const card = page.locator('#details .selection-card')
    .filter({ has: page.locator('.projection-provenance') })
    .first();
  await expect(card).toBeVisible();
  await expect(card.locator('.projection-provenance')).toBeVisible();
  await expect(card).toContainText('Provenienza');

  const derivedPick = page.locator('#structural-pick-controls button[data-pick-kind]').first();
  await expect(derivedPick, `${view} exposes a pick for a derived element`).toBeVisible();
  const kind = await derivedPick.getAttribute('data-pick-kind');
  await derivedPick.click();
  await expect(card).toBeVisible();
  const titles: Record<string, string> = {
    'visual-relation': 'Relazione visuale derivata',
    container: 'Contenitore derivato',
    curve: 'Curva derivata',
    field: 'Campo derivato',
  };
  expect(titles[kind ?? ''], `${view} pick kind has a derived card title`).toBeTruthy();
  await expect(card.locator('h2')).toHaveText(titles[kind!]!);
  await expect(card.locator('.selection-badge', { hasText: 'Derivato · non attestato' })).toBeVisible();
  await expect(card.locator('h3', { hasText: 'Sintesi' })).toBeVisible();
  await expect(card.locator('h3', { hasText: 'Perché' })).toHaveCount(0);
  await expect(card).not.toContainText('relazione attestata');
  await expect(card.locator('.projection-provenance')).toBeVisible();
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
        let hasCoordinates = false;
        if (!projection) {
          expect(view.button).toBe('natural');
          await assertDisclosure(page, view.button, dimension);
          await assertLodBudget(page, false);
        } else {
          expect(projection.organization).toBe(view.button);
          const refusalCode = projection.refusal && typeof projection.refusal.code === 'string'
            ? projection.refusal.code
            : null;
          hasCoordinates = projection.refusal === null && projection.algorithm === view.algorithm;
          if (hasCoordinates) expect(projection.cameraKey).toBe(`${dimension}/${view.button}`);
          if (view.button === 'holographic' && refusalCode) {
            const code = refusalCode;
            const status = (await page.locator('#status').innerText()).toLowerCase();
            expect(status).toContain(`proiezione rifiutata [${code}]`);
            await assertDisclosure(page, view.button, dimension);
            info.annotations.push({
              type: 'disclosed projection refusal',
              description: `Holographic refusal [${code}] is disclosed; coordinate and coordinate-dependent LOD and pick explanation checks are skipped.`,
            });
          } else {
            expect(refusalCode, `${view.button} has no refusal`).toBeNull();
            expect(projection.algorithm).toBe(view.algorithm);
            expect(hasCoordinates, `${view.button} witness discloses coordinates`).toBe(true);
            await assertDisclosure(page, view.button, dimension);
            await assertLodBudget(page);
          }
        }
        await waitForCameraRest(page);
        await saveViewport(page, info, view.button, dimension, morphology);

        const stableDigest = projection?.resultDigest ?? null;
        await axes(page, { morphology: morphology === 'stellar' ? 'neural' : 'stellar', ...fixedArrangement });
        const restyled = await waitForProjection(page, view.button);
        if (projection) {
          expect(restyled?.resultDigest, 'morphology restyling preserves coordinates and result digest').toBe(stableDigest);
        } else {
          await assertDisclosure(page, view.button, dimension);
          await assertLodBudget(page, false);
        }
        await axes(page, { morphology, ...fixedArrangement });
        await waitForProjection(page, view.button);
        await waitForCameraRest(page);
        await page.waitForTimeout(4000);

        const idleFrames = await page.evaluate(async () => {
          const before = (window as any).__d073FrameCount ?? 0;
          await new Promise(resolve => setTimeout(resolve, 3000));
          return ((window as any).__d073FrameCount ?? 0) - before;
        });
        expect(idleFrames, `${view.button} ${dimension} idle attested frames`).toBeLessThanOrEqual(1);
        if (hasCoordinates || view.button === 'natural') await assertExplanationCards(page, view.button);
        expect(await page.evaluate(() => (window as any).__d073DashCalls)).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  }
}
