import { expect, test, type Page } from '@playwright/test';
import { waitForCameraRest } from './camera-rest.ts';

test.skip(process.env.D073_BROWSER !== '1', 'Serve the D-073 review page with D073_BROWSER=1');
const url = process.env.D073_URL ?? 'http://127.0.0.1:8768/';
const STORAGE_KEY = 'd073.view';
const LEGACY_VIEW = '{"projection":"2d","morphology":"neural","organization":"flat","colour":"bw","labels":true,"reading":"attested"}';

const ready = async (page: Page, target = url) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(target);
  await page.evaluate(() => (window as any).__d067.ready);
  await expect(page.locator('#status')).toContainText('Grafo pronto');
  return errors;
};

const setAxes = (page: Page, axes: Record<string, unknown>) =>
  page.evaluate(value => (window as any).__d067.setAxes(value), axes);
const pageState = (page: Page) => page.evaluate(() => (window as any).__d067.state());
const storedView = (page: Page) => page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY);
/** The page stores the serialized view through its JSON local-storage writer, so the item is a JSON string of the view. */
const storedAxes = async (page: Page) => JSON.parse(JSON.parse((await storedView(page))!) as string);
const hashView = (page: Page) => page.evaluate(() => decodeURIComponent(new URLSearchParams(location.hash.slice(1)).get('view') ?? ''));

/** Nothing the page states, stores, puts in its URL or hands to a hook may spell the organization `flat`. */
const expectNoLegacySpelling = async (page: Page) => {
  const hooks = await page.evaluate(() => {
    const api = (window as any).__d067;
    return JSON.stringify({ state: api.state(), witness: api.witness() });
  });
  expect(hooks).not.toMatch(/"flat"/);
  expect((await storedView(page)) ?? '').not.toMatch(/flat/);
  expect(await page.evaluate(() => location.href)).not.toMatch(/flat/);
};

test('D-073 Natural is the canonical organization through the hook, the control, the URL and storage', async ({ page }) => {
  const errors = await ready(page);
  await setAxes(page, { projection: '2d', organization: 'natural', morphology: 'stellar', reading: 'attested' });
  await waitForCameraRest(page);
  const natural = await pageState(page);
  expect(natural.axes.organization).toBe('natural');
  expect(natural.view.organization).toBe('natural');
  expect(natural.view.arrangement).toBe('constellation');
  expect(natural.resolvedArrangement).not.toBeNull();
  await expect(page.locator('header [data-axis="organization"] [data-value="natural"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await storedAxes(page)).organization).toBe('natural');
  expect(JSON.parse(await hashView(page)).organization).toBe('natural');
  await expectNoLegacySpelling(page);

  // An explicit arrangement is a request parameter of Natural: a later style switch only restyles it.
  await setAxes(page, { organization: 'natural', arrangement: 'network' });
  await setAxes(page, { morphology: 'mycelium' });
  const explicit = await pageState(page);
  expect(explicit.view).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'mycelium' });
  expect(explicit.resolvedArrangement).toMatchObject({ arrangement: 'network', source: 'explicit' });

  await page.locator('header [data-axis="organization"] [data-value="indra"]').click();
  expect((await pageState(page)).axes.organization).toBe('indra');
  expect((await pageState(page)).view.arrangement).toBeUndefined();
  await page.locator('header [data-axis="organization"] [data-value="natural"]').click();
  expect((await pageState(page)).axes.organization).toBe('natural');
  expect((await pageState(page)).view.organization).toBe('natural');
  await expectNoLegacySpelling(page);
  expect(errors).toEqual([]);
});

test('D-073 the flat hook argument is a read alias and is answered as Natural', async ({ page }) => {
  const errors = await ready(page);
  await setAxes(page, { projection: '2d', organization: 'indra' });
  await setAxes(page, { organization: 'flat', morphology: 'stellar', reading: 'attested' });
  await waitForCameraRest(page);
  const state = await pageState(page);
  expect(state.axes.organization).toBe('natural');
  expect(state.view.organization).toBe('natural');
  await expectNoLegacySpelling(page);
  await expect(page.locator('header [data-axis="organization"] [data-value="natural"]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('D-073 a legacy flat URL view loads as Natural with its arrangement resolved once, and is never written back as flat', async ({ page }) => {
  const errors = await ready(page, `${url}#view=${encodeURIComponent(LEGACY_VIEW)}`);
  const loaded = await pageState(page);
  expect(loaded.axes.organization).toBe('natural');
  expect(loaded.axes.morphology).toBe('neural');
  expect(loaded.view).toMatchObject({ organization: 'natural', arrangement: 'network' });
  await setAxes(page, { morphology: 'stellar' });
  const restyled = await pageState(page);
  expect(restyled.axes).toMatchObject({ organization: 'natural', arrangement: 'constellation', morphology: 'stellar' });
  expect(restyled.view).toMatchObject({ organization: 'natural', arrangement: 'constellation', morphology: 'stellar' });
  expect(JSON.parse(await hashView(page)).organization).toBe('natural');
  expect(JSON.parse(await hashView(page)).arrangement).toBe('constellation');
  await expectNoLegacySpelling(page);
  expect(errors).toEqual([]);
});

test('D-073 a legacy flat URL view resolves its arrangement once when the Natural pipeline is on', async ({ page }) => {
  const errors = await ready(page, `${url}#projection=natural&view=${encodeURIComponent(LEGACY_VIEW)}`);
  const loaded = await pageState(page);
  expect(loaded.axes.organization).toBe('natural');
  expect(loaded.axes.morphology).toBe('neural');
  expect(loaded.view).toMatchObject({ organization: 'natural', arrangement: 'network' });
  await setAxes(page, { morphology: 'stellar' });
  const restyled = await pageState(page);
  expect(restyled.axes).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'stellar' });
  expect(restyled.view).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'stellar' });
  expect(JSON.parse(await hashView(page)).organization).toBe('natural');
  expect(JSON.parse(await hashView(page)).arrangement).toBe('network');
  await expectNoLegacySpelling(page);
  expect(errors).toEqual([]);
});

test('D-073 an explicit arrangement in a legacy flat URL view is kept in both Natural modes', async ({ page }) => {
  const legacyViewWithExplicitArrangement = JSON.stringify({ ...JSON.parse(LEGACY_VIEW), arrangement: 'network' });
  for (const target of [
    `${url}#view=${encodeURIComponent(legacyViewWithExplicitArrangement)}`,
    `${url}#projection=natural&view=${encodeURIComponent(legacyViewWithExplicitArrangement)}`,
  ]) {
    const errors = await ready(page, target);
    const loaded = await pageState(page);
    expect(loaded.view).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'neural' });
    await setAxes(page, { morphology: 'stellar' });
    const restyled = await pageState(page);
    expect(restyled.axes).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'stellar' });
    expect(restyled.view).toMatchObject({ organization: 'natural', arrangement: 'network', morphology: 'stellar' });
    expect(JSON.parse(await hashView(page)).arrangement).toBe('network');
    await expectNoLegacySpelling(page);
    expect(errors).toEqual([]);
  }
});

test('D-073 a legacy flat stored view loads as Natural and is rewritten only as natural', async ({ page }) => {
  await page.addInitScript(([key, value]) => {
    if (!window.localStorage.getItem(key!)) window.localStorage.setItem(key!, value!);
  }, [STORAGE_KEY, JSON.stringify(LEGACY_VIEW)]);
  const errors = await ready(page);
  const loaded = await pageState(page);
  expect(loaded.axes.organization).toBe('natural');
  expect(loaded.view).toMatchObject({ organization: 'natural', arrangement: 'network' });
  await setAxes(page, { reading: 'combined' });
  expect(await storedAxes(page)).toMatchObject({ organization: 'natural', arrangement: 'network', reading: 'combined' });
  await expectNoLegacySpelling(page);
  expect(errors).toEqual([]);
});
