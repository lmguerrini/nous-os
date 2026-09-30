import { expect, test } from '@playwright/test';

const url = process.env.D071_URL ?? process.env.D070_URL ?? 'http://127.0.0.1:8768/';
test.skip(process.env.D071_BROWSER !== '1', 'Set D071_BROWSER=1 and serve the review page');

type LabelWitness = { id: string; reason: string; rect: { left: number; top: number; width: number; height: number } };

/** One Natural view's label audit: every domain named, no overlaps, nothing outside the visible
 * rect, under the panel or over its own node disc. */
const audit = () => {
  const w = (window as any).__d067.witness();
  const labels = w.labels as LabelWitness[];
  const domains = ((w.disclosure?.nodes ?? []) as { id: string; level: number }[]).filter((n) => n.level === 1);
  const visible = w.visibleRect as { left: number; top: number; width: number; height: number };
  const panel = w.panelRect as { left: number; top: number; width: number; height: number } | undefined;
  const nodeViewport = w.nodeViewport as Record<string, { x: number; y: number; radius?: number }>;
  const domainIds = new Set(domains.map((n) => n.id));
  const named = labels.filter((l) => l.reason === 'domain');
  const missing = [...domainIds].filter((id) => !named.some((l) => l.id === id));
  const overlaps: string[] = [];
  for (let a = 0; a < labels.length; a++)
    for (let b = a + 1; b < labels.length; b++) {
      const r1 = labels[a]!.rect, r2 = labels[b]!.rect;
      if (r1.left < r2.left + r2.width && r1.left + r1.width > r2.left
        && r1.top < r2.top + r2.height && r1.top + r1.height > r2.top)
        overlaps.push(`${labels[a]!.id}~${labels[b]!.id}`);
    }
  const outside = labels
    .filter((l) => l.rect.left < visible.left - 0.5 || l.rect.top < visible.top - 0.5
      || l.rect.left + l.rect.width > visible.left + visible.width + 0.5
      || l.rect.top + l.rect.height > visible.top + visible.height + 0.5)
    .map((l) => l.id);
  const underPanel = (panel
    ? labels.filter((l) => l.rect.left < panel.left + panel.width && l.rect.left + l.rect.width > panel.left
      && l.rect.top < panel.top + panel.height && l.rect.top + l.rect.height > panel.top)
    : []).map((l) => l.id);
  const ownDisc = labels
    .filter((l) => {
      const node = nodeViewport[l.id];
      const radius = node?.radius ?? 0;
      if (!node || radius <= 0) return false;
      const nearestX = Math.min(Math.max(node.x, l.rect.left), l.rect.left + l.rect.width);
      const nearestY = Math.min(Math.max(node.y, l.rect.top), l.rect.top + l.rect.height);
      return (node.x - nearestX) ** 2 + (node.y - nearestY) ** 2 < (radius + 1) ** 2;
    })
    .map((l) => l.id);
  return { domains: domainIds.size, domainLabels: named.length, missing, overlaps, outside, underPanel, ownDisc, labels: labels.length };
};

test('D-071 G6 Natural names every domain in 2D and 3D, and no label sits under a pearl, the panel or another label', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);

  for (const projection of ['2d', '3d'] as const) {
    for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
      await page.evaluate(
        ([p, m]) => (window as any).__d067.setAxes({ projection: p, organization: 'natural', morphology: m, reading: 'attested', labels: true }),
        [projection, morphology] as const,
      );
      // Let the camera settle and its 160 ms label debounce run, as the G3 spec does.
      await page.waitForTimeout(1600);
      const result = await page.evaluate(audit);
      const view = `${projection}/${morphology}`;
      expect(result.domains, `${view}: the page must disclose its domains`).toBeGreaterThan(0);
      expect(result.domainLabels, `${view}: expected every domain to carry a label`).toBe(result.domains);
      expect(result.missing, `${view}: domains without a label`).toEqual([]);
      expect(result.overlaps, `${view}: overlapping labels`).toEqual([]);
      expect(result.outside, `${view}: labels outside the visible rect`).toEqual([]);
      expect(result.underPanel, `${view}: labels under the panel`).toEqual([]);
      expect(result.ownDisc, `${view}: labels under their own node`).toEqual([]);
    }
  }
});
