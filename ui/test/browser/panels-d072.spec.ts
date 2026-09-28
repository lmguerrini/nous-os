import { test, expect } from '@playwright/test';

test.skip(process.env.D072_BROWSER !== '1', 'Serve the review page with D072_BROWSER=1');
const url = process.env.D072_URL ?? 'http://127.0.0.1:8768/';

test('D072 every review surface has close, Escape, toggle and active opener', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.locator('[data-axis="projection"] [data-value="3d"]').click();
  const cases = [
    ['#filter-menu summary', '#filter-menu .menu-content'],
    ['#more-menu summary', '#more-menu .menu-content'],
    ['#view-preset-menu summary', '#view-preset-menu .menu-content'],
    ['#appearance-toggle', '#appearance-panel'],
    ['#advanced-button', '#advanced-controls'],
  ] as const;
  for (const [opener, surface] of cases) {
    if (opener === '#advanced-button') await page.locator('#more-menu summary').click();
    await page.locator(opener).click();
    await expect(page.locator(surface)).toBeVisible();
    await expect(page.locator(opener)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`${surface} .surface-close`)).toBeVisible();
    await page.locator(`${surface} .surface-close`).click();
    await expect(page.locator(surface)).toBeHidden();
    await expect(page.locator(opener)).toHaveAttribute('aria-pressed', 'false');
    await page.locator(opener).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(surface)).toBeHidden();
    await page.locator(opener).click();
    await page.locator(opener).click();
    await expect(page.locator(surface)).toBeHidden();
    if (opener === '#advanced-button') await page.locator('#more-menu summary').click();
  }
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#details')).toBeHidden();
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#details .surface-close')).toBeVisible();
  await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#details .surface-close').click();
  await expect(page.locator('#details')).toBeHidden();
  await page.locator('#panel-toggle').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toBeHidden();
  await page.locator('#panel-toggle').click();
  await page.locator('#edit-colours').click();
  await expect(page.locator('#custom-editor')).toBeVisible();
  await expect(page.locator('#edit-colours')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#edit-colours').click();
  await expect(page.locator('#appearance-panel')).toBeHidden();
  await page.locator('#edit-colours').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#appearance-panel')).toBeHidden();
  await page.locator('#edit-colours').click();
  await page.locator('#appearance-panel .surface-close').click();
  await expect(page.locator('#appearance-panel')).toBeHidden();
  if (await page.locator('#performance-overlay').count()) {
    await page.locator('#performance-toggle').click();
    await expect(page.locator('#performance-overlay .surface-close')).toBeVisible();
    await expect(page.locator('#performance-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#performance-overlay .surface-close').click();
    await expect(page.locator('#performance-overlay')).toBeHidden();
    await page.locator('#performance-toggle').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#performance-overlay')).toBeHidden();
    await page.locator('#performance-toggle').click();
    await page.locator('#performance-toggle').click();
    await expect(page.locator('#performance-overlay')).toBeHidden();
  }
});

test('D072 exploratory selection shows synthesis and three readable excerpts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.locator('[data-axis="reading"] [data-value="exploratory"]').first().click();
  const id = await page.evaluate(async () => {
    const index = await (await fetch('/api/graph/index')).json();
    return index.edges.find((edge: any) => edge.class === 'exploratory' && edge.evidence.length > 3)?.id;
  });
  test.skip(!id, 'Dataset has no exploratory relation with more than three excerpts');
  await page.evaluate((edgeId) => (window as any).__d067.select(edgeId), id);
  await expect(page.locator('#details .selection-card h3', { hasText: 'Sintesi' })).toBeVisible();
  await expect(page.locator('#details .selection-card blockquote:visible')).toHaveCount(3);
  await expect(page.locator('#details .selection-technical')).not.toHaveAttribute('open');
  const rawVisible = await page.locator('#details').evaluate(host => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && parent.getClientRects().length && /^\s*(\[\{|\{\")/.test(node.textContent ?? '')) return true;
    }
    return false;
  });
  expect(rawVisible).toBe(false);
});
