import { expect, test } from '@playwright/test';
import { fit, ready, setAxes, viewportPixels } from './d074-helpers.ts';

test.skip(process.env.D074_BROWSER !== '1', 'Serve the D-074 review page with D074_BROWSER=1');
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

for (const organization of ['natural', 'indra', 'fractal'] as const)
  for (const projection of ['2d', '3d'] as const)
    for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
      test(`bw chroma stays bounded: ${organization} ${projection} ${morphology}`, async ({ page }) => {
        const target = process.env.D074_URL;
        if (!target) throw new Error('D074_URL is required when D074_BROWSER=1');
        const url = new URL(target);
        if (organization === 'fractal') url.hash = 'experimental=fractal';
        await ready(page, url.href);
        await setAxes(page, { organization, projection, morphology, colour: 'bw', ...(organization === 'fractal' ? { experimental: true } : {}) });
        await fit(page);
        const image = await viewportPixels(page);
        let sampled = 0;
        let chromatic = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          if (image.data[i + 3] === 0) continue;
          sampled += 1;
          const max = Math.max(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
          const min = Math.min(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
          if (max - min > 12) chromatic += 1;
        }
        expect(sampled).toBeGreaterThan(0);
        expect(chromatic / sampled, 'fraction of viewport pixels with chroma > 12').toBeLessThan(0.005);
      });
    }
