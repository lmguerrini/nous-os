import { expect, test } from '@playwright/test';
import { fit, ready, setAxes, stable, viewportPixels } from './d074-helpers.ts';

test.skip(process.env.D074_BROWSER !== '1', 'Serve the D-074 review page with D074_BROWSER=1');
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

const rasterHasInk = (data: Buffer, width: number, height: number, x: number, y: number, background: [number, number, number]): boolean => {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return false;
  const at = (py * width + px) * 4;
  return Math.abs(data[at]! - background[0]) + Math.abs(data[at + 1]! - background[1]) + Math.abs(data[at + 2]! - background[2]) > 36;
};

test('ordinary Indra is recursive, draws relations at fit, and uses round pearl glyphs in 2D and 3D', async ({ page }) => {
  await ready(page);
  for (const projection of ['2d', '3d'] as const) {
    await setAxes(page, { organization: 'indra', projection, morphology: 'stellar', colour: 'bw' });
    const witness = await fit(page);
    expect(witness.focus).toBeTruthy();
    expect(witness.renderedNodeIds.length).toBeGreaterThan(0);
    expect(witness.edges.drawn.length, 'relations are present at the initial fitted framing').toBeGreaterThan(0);
    const image = await viewportPixels(page);
    const viewport = await page.locator('#viewport').boundingBox();
    expect(viewport).not.toBeNull();
    const positions = await page.evaluate(() => (window as any).__d067.witness().nodeViewport);
    const background = [image.data[0]!, image.data[1]!, image.data[2]!] as [number, number, number];
    const samples = Object.entries(positions as Record<string, { x: number; y: number; radius?: number }>)
      .filter(([id, p]) => witness.renderedNodeIds.includes(id) && Number.isFinite(p.x) && (p.radius ?? 0) >= 4)
      .sort((a, b) => (b[1].radius ?? 0) - (a[1].radius ?? 0)).slice(0, 12);
    expect(samples.length, 'nodeViewport exposes sampleable rendered glyphs').toBeGreaterThan(0);
    for (const [id, node] of samples) {
      const cx = node.x - viewport!.x;
      const cy = node.y - viewport!.y;
      const radius = Math.max(4, Math.min(node.radius ?? 6, 18));
      const center = rasterHasInk(image.data, image.width, image.height, cx, cy, background);
      const diagonal = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dy]) => rasterHasInk(image.data, image.width, image.height, cx + dx! * radius * 0.82, cy + dy! * radius * 0.82, background));
      const cardinal = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => rasterHasInk(image.data, image.width, image.height, cx + dx! * radius * 0.82, cy + dy! * radius * 0.82, background));
      expect(center, `${projection} node ${id} has a rendered center`).toBe(true);
      expect(diagonal.filter(Boolean).length, `${projection} node ${id} has clear rounded corners`).toBeLessThanOrEqual(2);
      expect(cardinal.filter(Boolean).length, `${projection} node ${id} has a rounded perimeter`).toBeGreaterThanOrEqual(2);
    }
  }
});

test('the Möbius Indra variant is separately gated by experimental=indra-pearls', async ({ page }) => {
  const target = process.env.D074_URL;
  if (!target) throw new Error('D074_URL is required when D074_BROWSER=1');
  const url = new URL(target);
  url.hash = 'experimental=indra-pearls';
  await ready(page, url.href);
  await setAxes(page, { organization: 'indra', projection: '2d', morphology: 'stellar', colour: 'bw' });
  const variant = await page.evaluate(() => ({
    state: (window as any).__d067.state(),
    buttons: [...document.querySelectorAll('[data-axis="organization"] button[data-value]')].map((button: any) => ({ value: button.dataset.value, label: button.textContent })),
    notice: document.querySelector('#notice')?.textContent ?? '',
  }));
  expect(variant.state.axes.organization).toBe('indra');
  expect(JSON.stringify(variant)).toMatch(/indra-pearls|Möbius|Mobius/i);
  expect(variant.buttons.some(button => /indra-pearls|möbius|mobius/i.test(`${button.value} ${button.label}`))).toBe(true);
});

for (const requested of ['fractal', 'holographic'] as const) {
  test(`${requested} without its experimental flag resolves to Natural with a notice`, async ({ page }) => {
    const target = process.env.D074_URL;
    if (!target) throw new Error('D074_URL is required when D074_BROWSER=1');
    const url = new URL(target);
    const view = { projection: '2d', organization: requested, morphology: 'stellar', colour: 'bw', labels: true, reading: 'attested' };
    url.hash = `view=${encodeURIComponent(JSON.stringify(view))}`;
    await ready(page, url.href);
    const result = await page.evaluate(() => ({ state: (window as any).__d067.state(), notice: document.querySelector('#notice')?.textContent ?? '' }));
    expect(result.state.axes.organization).toBe('natural');
    expect(result.notice.trim().length).toBeGreaterThan(0);
  });
}
