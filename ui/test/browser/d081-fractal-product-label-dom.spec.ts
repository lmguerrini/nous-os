import { expect, test } from '@playwright/test';
import { FRACTAL_PRODUCT_LABEL_RULE } from '../../src/fractal/renderer-adapter.ts';

test('Fractal alone suppresses product title spans and their leader SVG in the render root', async ({ page }) => {
  await page.setContent(`
    <div id="render-root">
      <div id="fractal-host">
        <div data-review-labels="true"><svg data-review-label-leaders="true"><line x1="0" y1="0" x2="20" y2="20" stroke="white" /></svg><div><span>QRS</span></div></div>
        <div data-render3f-labels="true"><svg data-render3f-label-leaders="true"><line x1="0" y1="0" x2="20" y2="20" stroke="white" /></svg><span>FORGE</span></div>
        <canvas data-fractal-rails="true"></canvas>
      </div>
      <div id="natural-host"><div data-review-labels="true"><svg data-review-label-leaders="true"><line x1="0" y1="0" x2="20" y2="20" stroke="white" /></svg><span>Showcase</span></div></div>
    </div>`);
  await page.addStyleTag({ content: FRACTAL_PRODUCT_LABEL_RULE });
  const product = page.locator('#fractal-host [data-review-labels] span, #fractal-host [data-render3f-labels] span, #fractal-host [data-review-label-leaders], #fractal-host [data-render3f-label-leaders]');
  await expect(product).toHaveCount(4);
  for (const item of await product.all()) await expect(item).toBeVisible();

  await page.locator('#fractal-host').evaluate(host => host.setAttribute('data-fractal-rails-active', ''));
  for (const item of await product.all()) await expect(item).toBeHidden();
  await expect(page.locator('#fractal-host [data-fractal-rails]')).toBeVisible();
  await expect(page.locator('#natural-host [data-review-labels] span')).toBeVisible();
  await expect(page.locator('#natural-host [data-review-label-leaders]')).toBeVisible();

  await page.locator('#fractal-host').evaluate(host => host.removeAttribute('data-fractal-rails-active'));
  for (const item of await product.all()) await expect(item).toBeVisible();
});
