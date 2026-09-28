import { expect, test } from '@playwright/test';

const url = process.env.D071_URL ?? process.env.D070_URL ?? 'http://127.0.0.1:8768/';
test.skip(process.env.D071_BROWSER !== '1', 'Set D071_BROWSER=1 and serve the review page');

test('D-071 Indra 3D nests every node inside its domain sphere, with continuous depth and no dashes', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => { (window as any).__indraContainers = { dashed: 0, draws: 0 }; });
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'indra', reading: 'attested' }));

  // Every visible node lies inside its level-1 domain sphere (containers carry world centre + radius).
  const containment = await page.evaluate(() => {
    const w = (window as any).__d067.witness();
    const nodes: { id: string; level: number; parent: string | null }[] = w.disclosure.nodes;
    const positions: Record<string, { x: number; y: number; z: number }> = w.positions;
    const containers: { id: string; level: number; center: { x: number; y: number; z: number }; radius: number }[] = w.containers;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const containerById = new Map(containers.map((c) => [c.id, c]));
    const domainOf = (id: string): string | null => {
      let cursor = byId.get(id);
      while (cursor && cursor.level !== 1 && cursor.parent) cursor = byId.get(cursor.parent);
      return cursor && cursor.level === 1 ? cursor.id : null;
    };
    const outside: string[] = [];
    for (const node of nodes) {
      const position = positions[node.id];
      const domain = domainOf(node.id);
      const container = domain ? containerById.get(domain) : null;
      if (!position || !container) { outside.push(`${node.id}: missing`); continue; }
      const distance = Math.hypot(position.x - container.center.x, position.y - container.center.y, position.z - container.center.z);
      if (distance > container.radius) outside.push(`${node.id}: ${distance.toFixed(1)} > ${container.radius.toFixed(1)}`);
    }
    return { outside, count: nodes.length };
  });
  expect(containment.outside).toEqual([]);
  expect(containment.count).toBeGreaterThan(0);

  // The side view is not a set of parallel planes: no single z value holds more than 20 % of nodes.
  const spread = await page.evaluate(() => {
    const w = (window as any).__d067.witness();
    const positions: Record<string, { z: number }> = w.positions;
    const zs = Object.values(positions).map((p) => p.z);
    const buckets = new Map<number, number>();
    for (const z of zs) {
      const key = Math.round(z * 1000);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return { largest: Math.max(...buckets.values()), count: zs.length };
  });
  expect(spread.largest / spread.count).toBeLessThanOrEqual(0.2);

  // A closed (+N) sphere carries its title.
  const closedTitled = await page.evaluate(() =>
    (window as any).__d067.witness().containers.some((c: any) => typeof c.title === 'string' && /\+(\d+)/.test(c.title)));
  expect(closedTitled).toBe(true);

  // No dashed drawing comes from the container canvas.
  const dash = await page.evaluate(() => (window as any).__indraContainers as { dashed: number; draws: number });
  expect(dash.draws).toBeGreaterThan(0);
  expect(dash.dashed).toBe(0);
});
