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

test('D-071 G1 container LOD draws true-size limbs and at most one flatness-faded equator per sphere', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => { (window as any).__indraContainers = { dashed: 0, draws: 0 }; });
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'indra', reading: 'attested' }));
  // Let the initial framing animation and its single confirm-refit settle.
  await page.waitForTimeout(1500);

  const before = await page.evaluate(() => {
    const w = (window as any).__d067.witness();
    const hook = (window as any).__indraContainers as Record<string, number | undefined>;
    const containers = w.containers as { id: string; level: number; open?: boolean }[];
    return {
      hook,
      domains: containers.filter((c) => c.level === 1).length,
      total: containers.length,
      // Spheres the LOD always draws at the overview: the NousOS shell, the domains, and open pearls.
      expected: containers.filter((c) => c.level <= 1 || c.open !== false).length,
      closed: containers.filter((c) => c.open === false && c.level >= 2).map((c) => c.id),
    };
  });
  expect(before.hook.draws).toBeGreaterThan(0);
  expect(before.hook.dashed).toBe(0);
  // The NousOS shell and every domain sphere draw their limb.
  expect(before.hook.limbs).toBeGreaterThanOrEqual(1 + before.domains);
  // The overview hides the small closed (+N) spheres: the LOD leaves only shells that carry content.
  expect(before.closed.length).toBeGreaterThan(0);
  expect(before.hook.limbs as number).toBeLessThanOrEqual(before.expected);
  expect(before.hook.limbs as number).toBeLessThan(before.total);
  // At most one equator per sphere, and every drawn equator is round enough to mean something.
  expect(before.hook.equators as number).toBeLessThanOrEqual(before.hook.limbs as number);
  expect(before.hook.minEquatorFlatness ?? 1).toBeGreaterThanOrEqual(0.45);

  // Selecting a closed container lifts the LOD: its sphere appears.
  const closedId = before.closed[0]!;
  await page.evaluate((id: string) => (window as any).__d067.select(id), closedId);
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => (window as any).__indraContainers as Record<string, number | undefined>);
  expect(after.limbs as number).toBeGreaterThanOrEqual((before.hook.limbs as number) + 1);
  expect(after.minEquatorFlatness ?? 1).toBeGreaterThanOrEqual(0.45);
  expect(after.equators as number).toBeLessThanOrEqual(after.limbs as number);
});

test('D-071 G3 no label sits under a pearl, and the whole NousOS shell stays in view', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => { (window as any).__indraContainers = { dashed: 0, draws: 0 }; });

  // Every label rectangle clears every pearl/soma disc, in all three 3D morphologies.
  for (const morphology of ['stellar', 'neural', 'mycelium']) {
    await page.evaluate((m: string) => (window as any).__d067.setAxes({ projection: '3d', organization: 'indra', morphology: m, reading: 'attested' }), morphology);
    await page.waitForTimeout(1600);
    const overlaps = await page.evaluate(() => {
      const w = (window as any).__d067.witness();
      const labels = w.labels as { id: string; rect: { left: number; top: number; width: number; height: number } }[];
      const nodes = w.nodeViewport as Record<string, { x: number; y: number; radius?: number }>;
      const bad: string[] = [];
      for (const label of labels) {
        for (const [id, node] of Object.entries(nodes)) {
          const radius = node.radius ?? 0;
          const nearestX = Math.min(Math.max(node.x, label.rect.left), label.rect.left + label.rect.width);
          const nearestY = Math.min(Math.max(node.y, label.rect.top), label.rect.top + label.rect.height);
          if ((node.x - nearestX) ** 2 + (node.y - nearestY) ** 2 < (radius + 1) ** 2)
            bad.push(`${label.id} under ${id}`);
        }
      }
      return { bad, labels: labels.length, radii: Object.values(nodes).filter((n: any) => (n.radius ?? 0) > 0).length };
    });
    expect(overlaps.radii, `${morphology}: the witness must report pearl radii`).toBeGreaterThan(0);
    expect(overlaps.bad, `${morphology}: ${overlaps.bad.join(', ')}`).toEqual([]);
  }

  // The NousOS limb circle lies inside the visible rectangle, after the automatic fit…
  const limbClearances = () => page.evaluate(() => {
    const w = (window as any).__d067.witness();
    const hook = (window as any).__indraContainers as { nousosLimb?: { x: number; y: number; radiusPx: number } };
    if (!hook.nousosLimb) return { missing: true as const };
    const rect = w.visibleRect as { left: number; top: number; width: number; height: number };
    const limb = hook.nousosLimb;
    // The hook is in canvas-local pixels; visibleRect.left/top gives the same origin in page pixels.
    const clearances: { missing: false; left: number; right: number; top: number; bottom: number } = {
      missing: false,
      left: limb.x - limb.radiusPx,
      right: rect.width - (limb.x + limb.radiusPx),
      top: limb.y - limb.radiusPx,
      bottom: rect.height - (limb.y + limb.radiusPx),
    };
    return clearances;
  });
  const afterAutoFit = await limbClearances();
  expect(afterAutoFit.missing).toBe(false);
  if (!afterAutoFit.missing)
    expect(Math.min(afterAutoFit.left, afterAutoFit.right, afterAutoFit.top, afterAutoFit.bottom)).toBeGreaterThanOrEqual(-1);

  // …and after «Adatta» (fit).
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'indra', morphology: 'stellar', reading: 'attested' }));
  await page.waitForTimeout(1600);
  await page.evaluate(() => (window as any).__d067.fit());
  await page.waitForTimeout(1600);
  const afterFit = await limbClearances();
  expect(afterFit.missing).toBe(false);
  if (!afterFit.missing)
    expect(Math.min(afterFit.left, afterFit.right, afterFit.top, afterFit.bottom)).toBeGreaterThanOrEqual(-1);
});
