import { expect, test } from '@playwright/test';
import { fit, hub, ready, setAxes, stable, verifyEdges, wheel, type Witness } from './d074-helpers.ts';

test.skip(process.env.D074_BROWSER !== '1', 'Serve the D-074 review page with D074_BROWSER=1');
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

for (const organization of ['natural', 'indra'] as const) for (const projection of ['2d', '3d'] as const) {
  test(`${organization} ${projection} drawn edges always terminate at rendered nodes or visible aggregates`, async ({ page }) => {
    await ready(page);
    await setAxes(page, { organization, projection, morphology: 'stellar', colour: 'bw' });
    await fit(page);
    const point = await hub(page);
    await page.mouse.move(point.x, point.y);
    const frames: Witness[] = [await stable(page)];
    for (let i = 0; i < 5; i += 1) frames.push(await wheel(page, point, -120, 3));

    for (const [index, witness] of frames.entries()) {
      expect(witness.invariant.ok, `invariant.ok at fit/level ${index}`).toBe(true);
      expect(witness.invariant.violations, `witness violations at fit/level ${index}`).toEqual([]);
      expect(verifyEdges(witness), `independent endpoint recomputation at fit/level ${index}`).toEqual([]);
      const aggregateIds = new Set(witness.aggregates.map(item => String(item.id)));
      for (const aggregate of witness.aggregates) {
        expect(aggregate.memberCount).toBeGreaterThan(0);
        expect(aggregate.explanationId).toBeTruthy();
      }
      for (const edge of witness.edges.drawn) {
        expect(['semantic', 'lifted', 'visual']).toContain((edge as any).channel);
        expect(Number(edge.count ?? 1)).toBeGreaterThan(0);
        for (const endpoint of [edge.from, edge.to]) {
          if (aggregateIds.has(String(endpoint.id))) expect(witness.aggregates.find(item => item.id === endpoint.id)?.memberCount).toBeGreaterThan(0);
        }
      }
    }
  });
}
